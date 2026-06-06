// api/cron-bank-sync.js
// Hourly cron (schedule '15 * * * *' — 15 min na hele uur zodat TL-cron op
// :00 eerst klaar is). Polleert e-Boekhouden /v1/mutation gefilterd op
// bank-grootboek (env EBH_BANK_LEDGER_ID, default 1010 = ING).
//
// v1 — pure spiegel. Geen match-engine, geen TL-cascade. Volgt bestaande
// cron-finance-sync.js pattern: 50s tijdsbudget, sync_state cursor-resumability,
// console.log summary voor Vercel-logs-monitoring.
//
// Auth: Bearer CRON_SECRET (checkCronAuth uit ./supabase.js).
// Filter: type 3 (inkoopfactuur-betaling), 4 (verkoopfactuur-betaling),
// 5 (geld ontvangen), 6 (geld uitgegeven) — alle geld-bewegingen voor het
// volledige bankoverzicht (in + uit).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { ebFetch } from './_lib/eboekhouden-token.js';
import { upsertBankTransactionFromEb } from './_lib/bank-transaction-upsert.js';

const ABORT_MS = 50_000;
const PAGE_SIZE = 500;                  // limit-cap is 2000; 500 = veilig
const DEFAULT_BANK_LEDGER = 1010;       // env EBH_BANK_LEDGER_ID override
const TYPES_TO_SYNC = [3, 4, 5, 6];     // alle geld-bewegingen (in + uit)
const EB_THROTTLE_MS = 200;             // best-practice spacing tussen calls

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Polleert /v1/mutation per type en pagineert tot batch < limit. Geen date-filter
 * op de query — e-Boekhouden's mutation-endpoint accepteert `date` niet als
 * filter-veld (HTTP 400 "Invalid argument(s) for filter", propertyName=date,
 * empirisch bevestigd in productie cron-fire 19:48 UTC 6 juni 2026). Mantix's
 * `'date' => Filter::gte(...)` werkt alleen op /v1/invoice, niet op /v1/mutation.
 *
 * Strategie: haal ALLE type 4+5 mutaties op binnen het tijdsbudget en filter
 * client-side op cursor. Voor DFO-volume (paar honderd mutaties per resource)
 * binnen 50s budget haalbaar. Bij grote back-fill kan abort_by_timeout = true;
 * cursor schuift dan vooruit naar max(verwerkt) zodat volgende run vervolgt.
 *
 * Toekomstige verfijning na bevestiging echte mutation-shape: ofwel server-side
 * filter via correcte veld-naam (mutationDate? bookingDate?) ofwel paginatie
 * gesorteerd op datum descending zodat we vroeg kunnen stoppen.
 */
async function fetchMutations({ ledgerId, sinceIso, startedAt }) {
  const all = [];
  const errors = [];
  let aborted = false;
  const sinceDate = String(sinceIso).slice(0, 10);  // YYYY-MM-DD

  outer:
  for (const type of TYPES_TO_SYNC) {
    let offset = 0;
    while (true) {
      if (Date.now() - startedAt > ABORT_MS) { aborted = true; break outer; }
      await sleep(EB_THROTTLE_MS);

      const r = await ebFetch('GET', '/mutation', {
        query: {
          ledgerId,
          type,
          // Geen date-filter — drop wegens propertyName="date" validation error.
          // Client-side filtering op cursor gebeurt na de fetch.
          limit: PAGE_SIZE,
          offset,
        },
      });
      const text = await r.text().catch(() => '');
      if (!r.ok) {
        console.error(`[cron-bank-sync] /mutation HTTP ${r.status} type=${type} offset=${offset}`, text.slice(0, 300));
        errors.push({ type, offset, http: r.status, snippet: text.slice(0, 200) });
        break;  // volgende type proberen
      }
      let data = [];
      try {
        const parsed = JSON.parse(text);
        // Response-shape vermoedelijk { data: [...], total: N } o.i.d.
        // — defensief beide pads ondersteunen.
        data = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : (Array.isArray(parsed?.items) ? parsed.items : []));
      } catch (e) {
        console.error(`[cron-bank-sync] json-parse fout type=${type} offset=${offset}`, e.message);
        errors.push({ type, offset, parse_err: e.message });
        break;
      }

      // DEBUG (Fase 3 v1.1 — tijdelijk): log één sample mutation per cron-run
      // zodat we counterparty veld-namen + datum-veld kunnen bevestigen uit
      // echte response-shape. Weg te halen in volgende fix-PR zodra bevestigd.
      if (all.length === 0 && data.length > 0) {
        console.log('[debug] sample mutation keys:', JSON.stringify(Object.keys(data[0])));
        console.log('[debug] sample mutation:', JSON.stringify(data[0], null, 2).substring(0, 1000));
      }

      // Client-side cursor-filter: hou alleen mutaties met date >= sinceDate.
      // String-vergelijk werkt correct op YYYY-MM-DD ISO-format.
      for (const m of data) {
        const md = String(m.date || '').slice(0, 10);
        if (md && md >= sinceDate) all.push(m);
      }
      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return { mutations: all, errors, aborted };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const ledgerId = Number(process.env.EBH_BANK_LEDGER_ID) || DEFAULT_BANK_LEDGER;
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();

  // 1. sync_state cursor ophalen.
  let cursorIso = null;
  try {
    const { data, error } = await supabaseAdmin
      .from('sync_state').select('last_updated_since').eq('resource', 'bank_transactions').maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return res.status(500).json({
        error: 'sync_state.bank_transactions ontbreekt — draai migratie 2026-06-06-bank-transactions.sql',
      });
    }
    cursorIso = data.last_updated_since;
  } catch (e) {
    console.error('[cron-bank-sync] sync_state SELECT', e.message);
    return res.status(500).json({ error: 'Kon sync_state niet lezen: ' + e.message });
  }

  // 2. Mutaties fetchen.
  let processed = 0, errors = 0;
  let sampledMaxDate = null;
  const sampledActions = { inserted: 0, updated: 0 };
  let fetchAborted = false;

  try {
    const { mutations, errors: fetchErrors, aborted } = await fetchMutations({
      ledgerId, sinceIso: cursorIso, startedAt,
    });
    fetchAborted = aborted;
    errors += fetchErrors.length;

    // 3. Per mutatie upserten.
    for (const m of mutations) {
      if (Date.now() - startedAt > ABORT_MS) { fetchAborted = true; break; }
      processed++;
      try {
        const out = await upsertBankTransactionFromEb(m);
        if (out?.action) sampledActions[out.action] = (sampledActions[out.action] || 0) + 1;
        const d = String(m.date || '').slice(0, 10);
        if (d && (!sampledMaxDate || d > sampledMaxDate)) sampledMaxDate = d;
      } catch (e) {
        errors++;
        if (errors <= 5) console.error('[cron-bank-sync] upsert id=' + m?.id, e.message);
      }
    }
  } catch (e) {
    console.error('[cron-bank-sync] fetch/upsert fase', e.message);
    errors++;
  }

  // 4. Nieuwe cursor: max date over verwerkte batch, of bestaande als 0 records.
  //    Bij abort vlak na een nieuwe mutatie schuift cursor alleen vooruit als
  //    we records zagen — voorkomt "overslaan" bij timeout.
  const nextCursor = sampledMaxDate
    ? `${sampledMaxDate}T00:00:00+00:00`
    : cursorIso;

  // 5. sync_state terugschrijven.
  const durationMs = Date.now() - startedAt;
  try {
    const { error } = await supabaseAdmin.from('sync_state').update({
      last_updated_since:   nextCursor,
      last_run_at:          startedIso,
      last_run_processed:   processed,
      last_run_errors:      errors,
      last_run_duration_ms: durationMs,
    }).eq('resource', 'bank_transactions');
    if (error) console.error('[cron-bank-sync] sync_state UPDATE', error.message);
  } catch (e) {
    console.error('[cron-bank-sync] sync_state UPDATE catch', e.message);
  }

  const summary = {
    started_at:          startedIso,
    ledger_id:           ledgerId,
    processed,
    errors,
    duration_ms:         durationMs,
    last_updated_since:  nextCursor,
    aborted_by_timeout:  fetchAborted,
    actions:             sampledActions,
  };
  console.log(`[cron-bank-sync] klaar in ${durationMs}ms |`, JSON.stringify(summary));
  return res.status(200).json({ success: true, ...summary });
}
