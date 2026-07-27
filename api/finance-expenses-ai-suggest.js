// api/finance-expenses-ai-suggest.js
// POST → run AI-categorisatie op alle ongecategoriseerde tegenpartijen.
// Permission: finance.expenses.category.edit.
//
// Wat: fetch alle unieke counterparty_names die geen bestaande categorisatie
// hebben (source='rule' of 'manual'), batch ze in groepen van ~30, roep
// Anthropic aan met een strikte prompt + toegestane slug-set, valideer output,
// insert als source='ai_suggest' via UPSERT (idempotent — herhaald runnen
// overschrijft oude ai_suggest, laat manual/rule met rust).
//
// KERN: 'ai_suggest'-rijen TELLEN NIET MEE in totaal/breakdown.
//       Endpoints filteren source != 'ai_suggest' waar aggregatie plaatsvindt.
//       Bevestigen door user (aparte confirm-endpoint) → source='manual'.
//
// Body: {} (geen input — draait op alle ongecategoriseerde)
// Response:
//   { batches_run, calls, tokens_used_estimate, counterparties_suggested,
//     tx_rows_written, invalid_slug_fallback_count, errors: [] }
//
// Idempotent: bestaande ai_suggest-rijen worden overschreven bij re-run
// (UPSERT op UNIQUE camt_transaction_id). Manual/rule blijft ongemoeid.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicStructuredOutput, AnthropicClientError } from './_lib/anthropic-client.js';

// Vercel Pro-plan hard timeout override: max 60s. Zonder dit knipt Vercel
// de function af bij 10s (Hobby-plan default) OF 60s (Pro default) en
// returnt een platte-tekst "An error occurred with your deployment"
// i.p.v. onze JSON. Explicit=60 borgt Pro-cap.
export const config = { maxDuration: 60 };

// Kleinere batches (was 30): kortere per-call latency (~2-4s ipv 5-10s),
// zodat de parallel-run comfortabel binnen 60s past.
const BATCH_SIZE = 15;
const MAX_TOKENS_PER_CALL = 3000;
// Concurrency-cap: parallel calls tegelijkertijd. Anthropic accepteert
// ruimschoots >10 concurrent, maar we blijven safe onder rate-limits.
const MAX_CONCURRENT_CALLS = 8;

// System prompt beschrijft de taak strak.
const SYSTEM_PROMPT = `Je bent een boekhoud-assistent die zakelijke tegenpartijen (leveranciers, diensten) classificeert in vaste uitgaven-categorieën.

Regels:
- Kies voor elke tegenpartij EXACT één categorie uit de gegeven set.
- Wees conservatief: als je twijfelt, kies 'overig' met lage confidence.
- Confidence 0.90+ = zeer zeker (bekende naam zoals Meta, Google Ads, Adobe).
- Confidence 0.70-0.89 = redelijk zeker (naam is duidelijk maar minder bekend).
- Confidence 0.50-0.69 = beste gok (naam vaag of dubbelzinnig).
- Confidence <0.50 = kies 'overig' i.p.v. te gokken.
- Reden is 1 korte zin (Nederlandse taal, max 100 tekens).`;

/**
 * Bouw de prompt voor 1 batch. Toegestane slugs komen als lijst mee met korte
 * beschrijvingen zodat het model context heeft.
 */
function buildBatchPrompt(counterparties, categoryList) {
  const categorieBlok = categoryList
    .map(c => `- ${c.slug}: ${c.label}`)
    .join('\n');
  const namenBlok = counterparties
    .map((n, i) => `${i + 1}. "${n}"`)
    .join('\n');
  return `Classificeer elke tegenpartij hieronder in EXACT één categorie uit de gegeven set.

TOEGESTANE CATEGORIEËN (kies ALLEEN uit deze slugs):
${categorieBlok}

TEGENPARTIJEN:
${namenBlok}

Antwoord met exact ${counterparties.length} suggesties, in dezelfde volgorde als de tegenpartijen hierboven.`;
}

/**
 * JSONSchema voor de tool-output. Anthropic dwingt het model dit shape af.
 */
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
            counterparty:  { type: 'string', description: 'Exacte counterparty-naam uit input' },
            category_slug: { type: 'string', enum: allowedSlugs, description: 'Slug uit de toegestane set' },
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

  // Top-level try/catch borgt dat ELKE fout (auth, permission, imports,
  // Anthropic-crash, DB, timeout-adjacent, netwerk) JSON teruggeeft.
  // Zonder deze wrap knalt een uncaught throw naar Vercel's default
  // platte-tekst "An error occurred with your deployment", en de frontend
  // crasht dan op JSON.parse.
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

    // Stap 1: fetch alle categorieën (voor de toegestane slug-set).
    const { data: allCats, error: catErr } = await supabaseAdmin
      .from('expense_categories')
      .select('id, slug, label')
      .eq('is_active', true);
    if (catErr) throw new Error('categories fetch: ' + catErr.message);
    const catBySlug = new Map((allCats || []).map(c => [c.slug, c]));
    const allowedSlugs = Array.from(catBySlug.keys());
    if (!allowedSlugs.length) {
      return res.status(500).json({ error: 'Geen actieve categorieën in DB' });
    }
    const overigCat = catBySlug.get('overig');
    if (!overigCat) {
      return res.status(500).json({ error: 'Categorie "overig" ontbreekt — nodig als fallback' });
    }

    // Stap 2: fetch alle unieke ongecategoriseerde counterparty_names.
    // "Ongecategoriseerd" = geen enkele tx heeft een rule/manual-categorisatie.
    // ai_suggest telt hier NIET als gecategoriseerd, zodat re-run bestaande
    // suggesties overschrijft.
    const CHUNK = 1000;
    const allTxs = [];
    let offset = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { data, error } = await supabaseAdmin
        .from('camt_transactions')
        .select('id, counterparty_name')
        .not('counterparty_name', 'is', null)
        .range(offset, offset + CHUNK - 1);
      if (error) throw new Error('camt_transactions fetch: ' + error.message);
      if (!data || !data.length) break;
      allTxs.push(...data);
      if (data.length < CHUNK) break;
      offset += CHUNK;
    }

    // Fetch bestaande categorisaties (source rule/manual — die skippen we).
    const existingCatByTx = new Map();
    if (allTxs.length) {
      const ids = allTxs.map(t => t.id);
      for (let i = 0; i < ids.length; i += 500) {
        const slice = ids.slice(i, i + 500);
        const { data } = await supabaseAdmin
          .from('transaction_categorizations')
          .select('camt_transaction_id, source')
          .in('camt_transaction_id', slice)
          .in('source', ['rule', 'manual']);
        for (const r of (data || [])) existingCatByTx.set(r.camt_transaction_id, r.source);
      }
    }

    // Groepeer per counterparty_name: welke names hebben minstens 1 tx zonder
    // rule/manual? Die krijgen suggestie. Names waarvan ALLE tx al getagd zijn,
    // worden geskipt (efficiënt: dan is er niks toe te voegen).
    const namesToSuggest = new Set();
    const txsByName = new Map();  // name → [tx-ids die geen rule/manual hebben]
    for (const t of allTxs) {
      const name = String(t.counterparty_name || '').trim();
      if (!name) continue;
      if (existingCatByTx.has(t.id)) continue;  // al gecategoriseerd
      namesToSuggest.add(name);
      if (!txsByName.has(name)) txsByName.set(name, []);
      txsByName.get(name).push(t.id);
    }
    const uniqueNames = Array.from(namesToSuggest).sort();

    if (uniqueNames.length === 0) {
      return res.status(200).json({
        batches_run: 0,
        calls: 0,
        tokens_used_estimate: 0,
        counterparties_suggested: 0,
        tx_rows_written: 0,
        invalid_slug_fallback_count: 0,
        errors: [],
        note: 'Geen ongecategoriseerde tegenpartijen gevonden — niks te doen.',
      });
    }

    // Stap 3: batches maken.
    const batches = [];
    for (let i = 0; i < uniqueNames.length; i += BATCH_SIZE) {
      batches.push(uniqueNames.slice(i, i + BATCH_SIZE));
    }

    // Stap 4: batches parallel afvuren via Promise.allSettled met concurrency-cap.
    // Sequentieel × 7 calls × ~3-10s = 21-70s → overschrijdt Vercel-timeout.
    // Parallel met cap = ~3-10s wall-clock, comfortabel binnen 60s.
    const allSuggestions = new Map();  // counterparty_name → { category_slug, confidence, reason }
    const errors = [];
    let invalidSlugFallback = 0;

    async function runBatch(batch, batchIdx) {
      try {
        const output = await anthropicStructuredOutput({
          system:            SYSTEM_PROMPT,
          messages:          [{ role: 'user', content: buildBatchPrompt(batch, allCats) }],
          tool_name:         'classify_counterparties',
          tool_input_schema: buildToolSchema(allowedSlugs),
          max_tokens:        MAX_TOKENS_PER_CALL,
          temperature:       0.2,
        });
        return { ok: true, output, batchIdx };
      } catch (e) {
        const msg = e instanceof AnthropicClientError ? `${e.code}: ${e.message}` : (e?.message || 'onbekend');
        console.error(`[ai-suggest] batch ${batchIdx + 1}/${batches.length} fout:`, msg);
        return { ok: false, error: msg, batchIdx };
      }
    }

    // Concurrency-cap: max N calls tegelijk. Simpele windowed dispatch.
    for (let start = 0; start < batches.length; start += MAX_CONCURRENT_CALLS) {
      const slice = batches.slice(start, start + MAX_CONCURRENT_CALLS);
      const promises = slice.map((batch, i) => runBatch(batch, start + i));
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status !== 'fulfilled') {
          errors.push({ batch: '?', message: 'Promise rejected: ' + (r.reason?.message || 'onbekend') });
          continue;
        }
        const { ok, output, error, batchIdx } = r.value;
        if (!ok) { errors.push({ batch: batchIdx + 1, message: error }); continue; }
        const suggestions = Array.isArray(output?.suggestions) ? output.suggestions : [];
        for (const s of suggestions) {
          const name = String(s.counterparty || '').trim();
          if (!name || !namesToSuggest.has(name)) continue;
          let slug = String(s.category_slug || '').trim();
          if (!catBySlug.has(slug)) {
            invalidSlugFallback++;
            slug = 'overig';
          }
          const conf = Math.max(0, Math.min(1, Number(s.confidence) || 0));
          const reason = String(s.reason || '').slice(0, 200);
          allSuggestions.set(name, { slug, confidence: conf, reason });
        }
      }
    }

    // Stap 5: schrijf suggesties naar transaction_categorizations.
    // 1 tx per counterparty krijgt de suggestie? Nee — per counterparty krijgen
    // ALLE tx zonder rule/manual een 'ai_suggest'-rij, zodat de counterparty-
    // consensus in de UI die suggestie ziet.
    let txRowsWritten = 0;
    if (allSuggestions.size) {
      const rowsToUpsert = [];
      for (const [name, sug] of allSuggestions) {
        const catId = catBySlug.get(sug.slug).id;
        const txIds = txsByName.get(name) || [];
        for (const txId of txIds) {
          rowsToUpsert.push({
            camt_transaction_id: txId,
            category_id:         catId,
            source:              'ai_suggest',
            rule_id:             null,
            set_by_user_id:      null,        // system
            ai_confidence:       sug.confidence,
            ai_reason:           sug.reason,
          });
        }
      }
      // UPSERT chunked.
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

    // Stap 6: tokens-schatting (ruwe indicatie voor kosten-bewustzijn).
    // ~100 tokens per counterparty input + ~50 tokens per suggestie output +
    // ~500 tokens overhead per call. Bij Sonnet 4.6 ~$3/1M input, $15/1M output.
    const inputTokensEst  = batches.length * 500 + uniqueNames.length * 100;
    const outputTokensEst = allSuggestions.size * 50;
    const tokensEst = inputTokensEst + outputTokensEst;

    console.log(`[ai-suggest] batches=${batches.length} calls=${batches.length} counterparties=${allSuggestions.size} rows=${txRowsWritten} invalid_slug=${invalidSlugFallback} tokens~${tokensEst}`);

    return res.status(200).json({
      batches_run: batches.length,
      calls: batches.length,
      tokens_used_estimate: tokensEst,
      counterparties_suggested: allSuggestions.size,
      tx_rows_written: txRowsWritten,
      invalid_slug_fallback_count: invalidSlugFallback,
      unique_names_total: uniqueNames.length,
      errors,
    });
  } catch (e) {
    console.error('[finance-expenses-ai-suggest]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
