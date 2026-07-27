// api/finance-expenses-set-counterparty-category.js
// POST → maak/wijzig counterparty→category rule + pas toe op alle bestaande
// tx van die tegenpartij. Toekomstige imports (via PayPal-upload) passen 'em
// ook automatisch toe (rule-based auto-categorize uit PR 1a).
// Permission: finance.expenses.category.edit.
//
// Body:
//   { counterparty: string,  // exacte match (getrimd)
//     category_id: uuid | null }  // null → verwijder rule + rule-based cats
//
// Response:
//   { rule_id, action: 'created'|'updated'|'deleted',
//     applied_to_transactions: number,
//     preserved_manual_overrides: number }
//
// Belangrijk: 'manual' overrides op individuele tx worden NIET overschreven.
// Dat is de bewuste hiërarchie — een user die 1 tx expliciet een andere
// categorie gaf, wil dat niet kwijtraken bij een counterparty-brede rule.

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

  const { counterparty, category_id } = req.body || {};
  const cpName = typeof counterparty === 'string' ? counterparty.trim() : '';
  if (!cpName) return res.status(400).json({ error: 'counterparty vereist' });
  if (category_id !== null && (typeof category_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(category_id))) {
    return res.status(400).json({ error: 'category_id moet UUID zijn of null' });
  }

  try {
    // Valideer category bestaat (als niet null).
    if (category_id) {
      const { data: cat, error: catErr } = await supabaseAdmin
        .from('expense_categories').select('id').eq('id', category_id).maybeSingle();
      if (catErr) throw new Error('category check: ' + catErr.message);
      if (!cat) return res.status(400).json({ error: 'Onbekende category_id' });
    }

    // Fetch bestaande rule voor deze counterparty.
    const { data: existingRule } = await supabaseAdmin
      .from('expense_counterparty_rules')
      .select('id, category_id')
      .eq('match_counterparty', cpName)
      .maybeSingle();

    let ruleId = existingRule ? existingRule.id : null;
    let action;

    if (category_id === null) {
      // ── Verwijder pad ──
      // Rule weghalen + alle 'rule'-source-cats van deze tegenpartij (die naar
      // deze rule verwijzen) verwijderen. Manual overrides blijven staan.
      let deletedCats = 0;
      let preservedManual = 0;
      if (existingRule) {
        // Fetch alle tx van deze counterparty die op deze rule staan.
        const { data: catRows } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('id, camt_transaction_id, source, rule_id')
          .eq('rule_id', existingRule.id);
        const ruleCatIds = (catRows || []).filter(c => c.source === 'rule').map(c => c.id);
        preservedManual = (catRows || []).filter(c => c.source === 'manual').length;
        if (ruleCatIds.length) {
          const { error: delCatErr } = await supabaseAdmin
            .from('transaction_categorizations').delete().in('id', ruleCatIds);
          if (delCatErr) throw new Error('cat delete: ' + delCatErr.message);
          deletedCats = ruleCatIds.length;
        }
        const { error: delRuleErr } = await supabaseAdmin
          .from('expense_counterparty_rules').delete().eq('id', existingRule.id);
        if (delRuleErr) throw new Error('rule delete: ' + delRuleErr.message);
        action = 'deleted';
      } else {
        action = 'deleted';  // niks te doen, maar consistent response
      }
      return res.status(200).json({
        rule_id: null,
        action,
        applied_to_transactions: 0,
        removed_rule_cats: deletedCats,
        preserved_manual_overrides: preservedManual,
      });
    }

    // ── Create/Update pad ──
    if (existingRule) {
      const { error: updErr } = await supabaseAdmin
        .from('expense_counterparty_rules')
        .update({ category_id, updated_at: new Date().toISOString() })
        .eq('id', existingRule.id);
      if (updErr) throw new Error('rule update: ' + updErr.message);
      action = 'updated';
    } else {
      const { data: newRule, error: insErr } = await supabaseAdmin
        .from('expense_counterparty_rules')
        .insert({
          match_counterparty: cpName,
          category_id,
          created_by_user_id: user.id,
        })
        .select('id')
        .single();
      if (insErr) throw new Error('rule insert: ' + insErr.message);
      ruleId = newRule.id;
      action = 'created';
    }

    // Pas rule toe op alle bestaande tx van deze counterparty (exact match).
    const { data: matchingTxs, error: txErr } = await supabaseAdmin
      .from('camt_transactions')
      .select('id')
      .eq('counterparty_name', cpName);
    if (txErr) throw new Error('tx fetch: ' + txErr.message);
    const txIds = (matchingTxs || []).map(t => t.id);

    let applied = 0;
    let preservedManual = 0;
    if (txIds.length) {
      // Fetch bestaande categorisaties om manual overrides te sparen.
      const existingCats = [];
      for (let i = 0; i < txIds.length; i += 500) {
        const slice = txIds.slice(i, i + 500);
        const { data } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('camt_transaction_id, source')
          .in('camt_transaction_id', slice);
        existingCats.push(...(data || []));
      }
      const manualSet = new Set(
        existingCats.filter(c => c.source === 'manual').map(c => c.camt_transaction_id)
      );
      preservedManual = manualSet.size;

      // Bouw upsert-rows voor niet-manual-tx.
      const catRows = txIds
        .filter(id => !manualSet.has(id))
        .map(id => ({
          camt_transaction_id: id,
          category_id,
          source: 'rule',
          rule_id: ruleId,
          set_by_user_id: user.id,
        }));

      // Chunked upsert (UNIQUE op camt_transaction_id → conflict update).
      for (let i = 0; i < catRows.length; i += 500) {
        const slice = catRows.slice(i, i + 500);
        const { error: upsErr } = await supabaseAdmin
          .from('transaction_categorizations')
          .upsert(slice, { onConflict: 'camt_transaction_id' });
        if (upsErr) throw new Error('cat upsert: ' + upsErr.message);
        applied += slice.length;
      }
    }

    return res.status(200).json({
      rule_id: ruleId,
      action,
      applied_to_transactions: applied,
      preserved_manual_overrides: preservedManual,
    });
  } catch (e) {
    console.error('[finance-expenses-set-counterparty-category]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
