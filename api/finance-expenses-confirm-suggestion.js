// api/finance-expenses-confirm-suggestion.js
// POST → bevestig een AI-suggestie voor 1 counterparty (of bulk boven een
// confidence-drempel). Permission: finance.expenses.category.edit.
//
// Drie modes:
//   1) Single: { counterparty: 'Meta Platforms, Inc.' }
//        Bevestig de bestaande ai_suggest-rijen van die counterparty →
//        source='manual' + maak (indien niet bestaand) een expense_
//        counterparty_rule zodat toekomstige imports automatisch getagd
//        worden.
//   2) Bulk-by-threshold: { min_confidence: 0.85 }
//        Bevestig ALLE ai_suggest-rijen waarvan de counterparty een
//        gemiddelde confidence >= threshold heeft.
//   3) Bulk-by-selection: { counterparties: ['Meta ...', 'Zoom ...', ...] }
//        Bevestig exact deze counterparties, ongeacht confidence. Voor
//        checkbox-selectie in de UI: user kiest bewust welke.
//
// Response:
//   { confirmed_counterparties: [...],
//     tx_rows_updated: N,
//     rules_created: N,
//     errors: [] }
//
// Idempotent: UPDATE source='manual' op reeds-manual rijen is no-op via
// WHERE source='ai_suggest'. Rule-creation via NOT EXISTS-guard.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.expenses.category.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.expenses.category.edit)' });
  }

  const { counterparty, min_confidence, counterparties } = req.body || {};
  const isSingle = typeof counterparty === 'string' && counterparty.trim().length > 0;
  const isBulkByThreshold = typeof min_confidence === 'number' && min_confidence >= 0 && min_confidence <= 1;
  const isBulkBySelection = Array.isArray(counterparties) && counterparties.length > 0;

  if (!isSingle && !isBulkByThreshold && !isBulkBySelection) {
    return res.status(400).json({ error: 'Geef counterparty (string), min_confidence (0..1) OF counterparties (string[]) mee' });
  }

  try {
    // Stap 1: bepaal welke counterparties bevestigd worden.
    let targetCounterparties = [];

    if (isSingle) {
      targetCounterparties = [counterparty.trim()];
    } else if (isBulkBySelection) {
      // Expliciete lijst — user heeft in de UI checkboxes aangevinkt. Trim +
      // dedupe + drop lege. Geen threshold-check: user heeft bewust gekozen.
      targetCounterparties = Array.from(new Set(
        counterparties.map(s => String(s || '').trim()).filter(Boolean)
      ));
      if (targetCounterparties.length > 500) {
        return res.status(400).json({ error: 'Selectie te groot (>500). Splits in kleinere batches.' });
      }
    } else {
      // Bulk: fetch alle ai_suggest-rijen + join op counterparty_name.
      // Groepeer per name, bereken gemiddelde confidence, filter >= threshold.
      const { data: aiRows, error: fetchErr } = await supabaseAdmin
        .from('transaction_categorizations')
        .select('camt_transaction_id, category_id, ai_confidence, camt_transactions!inner(counterparty_name)')
        .eq('source', 'ai_suggest');
      if (fetchErr) throw new Error('ai_suggest fetch: ' + fetchErr.message);

      const groupByCp = new Map();
      for (const r of (aiRows || [])) {
        const name = String(r.camt_transactions?.counterparty_name || '').trim();
        if (!name) continue;
        if (!groupByCp.has(name)) groupByCp.set(name, { sum: 0, cnt: 0, catIds: new Set() });
        const g = groupByCp.get(name);
        g.sum += Number(r.ai_confidence) || 0;
        g.cnt += 1;
        g.catIds.add(r.category_id);
      }
      for (const [name, g] of groupByCp) {
        // Vereiste: consensus = 1 categorie én avg confidence >= threshold.
        if (g.catIds.size !== 1) continue;
        if ((g.sum / g.cnt) < min_confidence) continue;
        targetCounterparties.push(name);
      }
    }

    if (!targetCounterparties.length) {
      return res.status(200).json({
        confirmed_counterparties: [],
        tx_rows_updated: 0,
        rules_created: 0,
        errors: [],
        note: 'Geen counterparties matchen de criteria — niks te bevestigen.',
      });
    }

    // Stap 2: per counterparty — fetch de category_id van de ai_suggest,
    // UPDATE naar manual, en maak een rule aan.
    let totalTxUpdated = 0;
    let totalRulesCreated = 0;
    const errors = [];
    const confirmedNames = [];

    for (const name of targetCounterparties) {
      try {
        // Fetch alle ai_suggest-rijen van deze counterparty via tx-join.
        const { data: txIdsData, error: txErr } = await supabaseAdmin
          .from('camt_transactions')
          .select('id')
          .eq('counterparty_name', name);
        if (txErr) throw new Error('tx fetch: ' + txErr.message);
        const txIds = (txIdsData || []).map(t => t.id);
        if (!txIds.length) continue;

        const { data: aiCats, error: aiErr } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('id, category_id, camt_transaction_id')
          .in('camt_transaction_id', txIds)
          .eq('source', 'ai_suggest');
        if (aiErr) throw new Error('ai_suggest fetch: ' + aiErr.message);
        if (!aiCats || !aiCats.length) continue;

        // Consensus: alle ai_suggest-rijen voor deze counterparty horen
        // dezelfde categorie te hebben (de suggestie is per counterparty).
        // Als er om welke reden dan ook een mix is, skip (zeldzaam).
        const catIdSet = new Set(aiCats.map(c => c.category_id));
        if (catIdSet.size !== 1) {
          errors.push({ counterparty: name, message: 'Inconsistente ai_suggest-categorieën (skip)' });
          continue;
        }
        const chosenCatId = aiCats[0].category_id;

        // UPDATE source='manual' + set_by_user_id + set_at.
        const idsToUpdate = aiCats.map(c => c.id);
        const { error: updErr } = await supabaseAdmin
          .from('transaction_categorizations')
          .update({
            source:         'manual',
            set_by_user_id: user.id,
            set_at:         new Date().toISOString(),
          })
          .in('id', idsToUpdate);
        if (updErr) throw new Error('update: ' + updErr.message);
        totalTxUpdated += idsToUpdate.length;

        // Maak counterparty-rule aan (indien nog niet bestaand) zodat
        // toekomstige imports automatisch getagd worden.
        const { data: existingRule } = await supabaseAdmin
          .from('expense_counterparty_rules')
          .select('id')
          .eq('match_counterparty', name)
          .maybeSingle();
        if (!existingRule) {
          const { error: ruleErr } = await supabaseAdmin
            .from('expense_counterparty_rules')
            .insert({
              match_counterparty: name,
              category_id:        chosenCatId,
              created_by_user_id: user.id,
            });
          if (ruleErr) {
            console.warn('[confirm-suggestion] rule insert fout:', ruleErr.message);
          } else {
            totalRulesCreated++;
          }
        }

        confirmedNames.push(name);
      } catch (e) {
        console.error(`[confirm-suggestion] fout voor "${name}":`, e.message);
        errors.push({ counterparty: name, message: e.message });
      }
    }

    console.log(`[confirm-suggestion] confirmed=${confirmedNames.length} tx_updated=${totalTxUpdated} rules_created=${totalRulesCreated}`);

    return res.status(200).json({
      confirmed_counterparties: confirmedNames,
      tx_rows_updated:          totalTxUpdated,
      rules_created:            totalRulesCreated,
      errors,
    });
  } catch (e) {
    console.error('[finance-expenses-confirm-suggestion]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
