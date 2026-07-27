// api/finance-expenses-ai-suggest.js
// POST → classificeer 1 chunk (≤50 counterparty_names) via Anthropic en
// schrijf de suggesties naar transaction_categorizations (source='ai_suggest').
// Permission: finance.expenses.category.edit.
//
// CHUNKED-BY-CLIENT: dit endpoint doet EEN chunk per call. De frontend
// orchestreert de lus (fetch alle ongecategoriseerde → chunk in 25 → post één
// voor één met voortgang-UX). Dit voorkomt de Vercel 60s serverless-timeout
// die #966 nog niet volledig oploste voor ~200 tegenpartijen — geen enkele
// call nadert nu de cap (1 Anthropic-call = 2-5s).
//
// Body:
//   { counterparties: string[]  // verplicht, min 1, max 50
//   }
//
// Response 200:
//   { chunk_size, counterparties_suggested, tx_rows_written,
//     invalid_slug_fallback_count, skipped_already_categorized,
//     tokens_used_estimate, errors: [] }
//
// KERN: 'ai_suggest'-rijen tellen NIET mee in totaal/breakdown.
//       Bevestigen door user (aparte confirm-endpoint) → source='manual'.
//
// Idempotent: skipt namen waarvan alle tx al rule/manual hebben; bestaande
// ai_suggest voor de gegeven counterparties wordt overschreven via UPSERT.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicStructuredOutput, AnthropicClientError } from './_lib/anthropic-client.js';

// Vercel Pro-plan hard timeout cap. Met 1 Anthropic-call per chunk (~2-5s)
// zit elke request ruim onder deze cap, maar we borgen 'em expliciet zodat
// een edge-case (trage API, retry) niet op de 10s Hobby-default valt.
export const config = { maxDuration: 60 };

// Hard cap op chunk-grootte — anti-abuse + latency-guard. Frontend hoort in
// chunks van ~25 te versturen; server accepteert tot 50 als slack.
const MAX_CHUNK_SIZE = 50;
const MAX_TOKENS_PER_CALL = 3000;

const SYSTEM_PROMPT = `Je bent een boekhoud-assistent die zakelijke tegenpartijen (leveranciers, diensten) classificeert in vaste uitgaven-categorieën.

Regels:
- Kies voor elke tegenpartij EXACT één categorie uit de gegeven set.
- Wees conservatief: als je twijfelt, kies 'overig' met lage confidence.
- Confidence 0.90+ = zeer zeker (bekende naam zoals Meta, Google Ads, Adobe).
- Confidence 0.70-0.89 = redelijk zeker (naam is duidelijk maar minder bekend).
- Confidence 0.50-0.69 = beste gok (naam vaag of dubbelzinnig).
- Confidence <0.50 = kies 'overig' i.p.v. te gokken.
- Reden is 1 korte zin (Nederlandse taal, max 100 tekens).`;

function buildBatchPrompt(counterparties, categoryList) {
  const categorieBlok = categoryList.map(c => `- ${c.slug}: ${c.label}`).join('\n');
  const namenBlok = counterparties.map((n, i) => `${i + 1}. "${n}"`).join('\n');
  return `Classificeer elke tegenpartij hieronder in EXACT één categorie uit de gegeven set.

TOEGESTANE CATEGORIEËN (kies ALLEEN uit deze slugs):
${categorieBlok}

TEGENPARTIJEN:
${namenBlok}

Antwoord met exact ${counterparties.length} suggesties, in dezelfde volgorde als de tegenpartijen hierboven.`;
}

function buildToolSchema(allowedSlugs) {
  return {
    type: 'object',
    required: ['suggestions'],
    properties: {
      suggestions: {
        type: 'array',
        description: 'Eén entry per tegenpartij, in dezelfde volgorde als de input',
        items: {
          type: 'object',
          required: ['counterparty', 'category_slug', 'confidence', 'reason'],
          properties: {
            counterparty:  { type: 'string' },
            category_slug: { type: 'string', enum: allowedSlugs },
            confidence:    { type: 'number', minimum: 0, maximum: 1 },
            reason:        { type: 'string', maxLength: 120 },
          },
        },
      },
    },
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Top-level try/catch borgt dat ELKE fout (auth/permission/imports/DB/
  // Anthropic/netwerk) JSON teruggeeft, niet Vercel's platte-tekst wrapper.
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    if (!(await requirePermission(req, 'finance.expenses.category.edit'))) {
      return res.status(403).json({ error: 'Geen rechten (finance.expenses.category.edit)' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
    }

    // ── Input-validatie ──
    const { counterparties: inputCps } = req.body || {};
    if (!Array.isArray(inputCps) || inputCps.length === 0) {
      return res.status(400).json({
        error: 'counterparties[] is verplicht (lijst counterparty_names om te classificeren; typisch 25 per call)',
      });
    }
    // Trim + dedupe + drop lege strings.
    const requestedNames = Array.from(new Set(
      inputCps.map(s => String(s || '').trim()).filter(Boolean)
    ));
    if (requestedNames.length === 0) {
      return res.status(400).json({ error: 'counterparties[] bevat geen geldige namen' });
    }
    if (requestedNames.length > MAX_CHUNK_SIZE) {
      return res.status(400).json({
        error: `Chunk te groot (${requestedNames.length} > ${MAX_CHUNK_SIZE}). Splits in kleinere chunks.`,
      });
    }

    // ── Stap 1: fetch categorieën (whitelist) ──
    const { data: allCats, error: catErr } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label')
      .eq('is_active', true);
    if (catErr) throw new Error('categories fetch: ' + catErr.message);
    const catBySlug = new Map((allCats || []).map(c => [c.slug, c]));
    const allowedSlugs = Array.from(catBySlug.keys());
    if (!allowedSlugs.length) return res.status(500).json({ error: 'Geen actieve categorieën in DB' });
    if (!catBySlug.get('overig')) {
      return res.status(500).json({ error: 'Categorie "overig" ontbreekt — nodig als fallback' });
    }

    // ── Stap 2: fetch tx-ids VOOR de gegeven counterparties (in-clause, snel) ──
    const { data: txRows, error: txErr } = await supabaseAdmin
      .from('camt_transactions')
      .select('id, counterparty_name')
      .in('counterparty_name', requestedNames);
    if (txErr) throw new Error('camt_transactions fetch: ' + txErr.message);
    const txs = txRows || [];

    if (txs.length === 0) {
      // Onbekende counterparty-names → niks te doen, wel 200 met info.
      return res.status(200).json({
        chunk_size: requestedNames.length,
        counterparties_suggested: 0,
        tx_rows_written: 0,
        invalid_slug_fallback_count: 0,
        skipped_already_categorized: 0,
        tokens_used_estimate: 0,
        errors: [],
        note: 'Geen tx gevonden voor de opgegeven counterparties.',
      });
    }

    // ── Stap 3: filter tx die al rule/manual-categorisatie hebben ──
    const ids = txs.map(t => t.id);
    const existingBySrc = new Map();  // tx_id → source
    for (let i = 0; i < ids.length; i += 500) {
      const slice = ids.slice(i, i + 500);
      const { data } = await supabaseAdmin
        .from('transaction_categorizations')
        .select('camt_transaction_id, source')
        .in('camt_transaction_id', slice)
        .in('source', ['rule', 'manual']);
      for (const r of (data || [])) existingBySrc.set(r.camt_transaction_id, r.source);
    }

    // Groepeer nog-te-suggesteren tx per counterparty.
    const txsByName = new Map();  // name → tx-ids
    const namesToClassify = new Set();
    let skippedAlreadyCategorized = 0;
    for (const t of txs) {
      const name = String(t.counterparty_name || '').trim();
      if (!name) continue;
      if (existingBySrc.has(t.id)) { skippedAlreadyCategorized++; continue; }
      if (!txsByName.has(name)) txsByName.set(name, []);
      txsByName.get(name).push(t.id);
      namesToClassify.add(name);
    }
    const namesList = Array.from(namesToClassify).sort();

    if (namesList.length === 0) {
      return res.status(200).json({
        chunk_size: requestedNames.length,
        counterparties_suggested: 0,
        tx_rows_written: 0,
        invalid_slug_fallback_count: 0,
        skipped_already_categorized: skippedAlreadyCategorized,
        tokens_used_estimate: 0,
        errors: [],
        note: 'Alle gevraagde counterparties zijn al gecategoriseerd (rule/manual).',
      });
    }

    // ── Stap 4: ÉÉN Anthropic-call voor deze chunk ──
    let invalidSlugFallback = 0;
    const suggestions = new Map();  // name → { slug, confidence, reason }
    const errors = [];
    try {
      const output = await anthropicStructuredOutput({
        system:            SYSTEM_PROMPT,
        messages:          [{ role: 'user', content: buildBatchPrompt(namesList, allCats) }],
        tool_name:         'classify_counterparties',
        tool_input_schema: buildToolSchema(allowedSlugs),
        max_tokens:        MAX_TOKENS_PER_CALL,
        temperature:       0.2,
      });
      const arr = Array.isArray(output?.suggestions) ? output.suggestions : [];
      for (const s of arr) {
        const name = String(s.counterparty || '').trim();
        if (!name || !namesToClassify.has(name)) continue;
        let slug = String(s.category_slug || '').trim();
        if (!catBySlug.has(slug)) { invalidSlugFallback++; slug = 'overig'; }
        const conf = Math.max(0, Math.min(1, Number(s.confidence) || 0));
        const reason = String(s.reason || '').slice(0, 200);
        suggestions.set(name, { slug, confidence: conf, reason });
      }
    } catch (e) {
      const msg = e instanceof AnthropicClientError ? `${e.code}: ${e.message}` : (e?.message || 'onbekend');
      console.error('[ai-suggest] anthropic call fout:', msg);
      errors.push({ message: msg });
      // Return 200 met errors zodat de client-lus 't kan tonen en doorgaan.
    }

    // ── Stap 5: UPSERT suggesties ──
    let txRowsWritten = 0;
    if (suggestions.size) {
      const rowsToUpsert = [];
      for (const [name, sug] of suggestions) {
        const catId = catBySlug.get(sug.slug).id;
        const txIds = txsByName.get(name) || [];
        for (const txId of txIds) {
          rowsToUpsert.push({
            camt_transaction_id: txId,
            category_id:         catId,
            source:              'ai_suggest',
            rule_id:             null,
            set_by_user_id:      null,
            ai_confidence:       sug.confidence,
            ai_reason:           sug.reason,
          });
        }
      }
      // Chunked upsert (Supabase-limits).
      for (let i = 0; i < rowsToUpsert.length; i += 500) {
        const slice = rowsToUpsert.slice(i, i + 500);
        const { error: upErr } = await supabaseAdmin
          .from('transaction_categorizations')
          .upsert(slice, { onConflict: 'camt_transaction_id' });
        if (upErr) {
          console.error('[ai-suggest] upsert chunk fout:', upErr.message);
          errors.push({ chunk: Math.floor(i / 500), message: upErr.message });
          continue;
        }
        txRowsWritten += slice.length;
      }
    }

    // Ruwe token-schatting: ~100 in/counterparty + ~50 out/suggestie + ~500 overhead.
    const tokensEst = 500 + namesList.length * 100 + suggestions.size * 50;

    console.log(`[ai-suggest] chunk_size=${requestedNames.length} classified=${suggestions.size} rows=${txRowsWritten} skipped_existing=${skippedAlreadyCategorized} invalid_slug=${invalidSlugFallback} tokens~${tokensEst}`);

    return res.status(200).json({
      chunk_size:                     requestedNames.length,
      counterparties_suggested:       suggestions.size,
      tx_rows_written:                txRowsWritten,
      invalid_slug_fallback_count:    invalidSlugFallback,
      skipped_already_categorized:    skippedAlreadyCategorized,
      tokens_used_estimate:           tokensEst,
      errors,
    });
  } catch (e) {
    console.error('[finance-expenses-ai-suggest]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
