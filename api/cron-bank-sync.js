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
// Filter: type=4 (verkoopfactuur-betaling) + type=5 (geld ontvangen) — alleen
// inkomende klant-betalingen voor de read-only bankoverzicht. Type 3+6 (uit)
// vallen buiten v1.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { ebFetch } from './_lib/eboekhouden-token.js';
import { upsertBankTransactionFromEb } from './_lib/bank-transaction-upsert.js';

const ABORT_MS = 50_000;
const PAGE_SIZE = 500;                  // limit-cap is 2000; 500 = veilig
const DEFAULT_BANK_LEDGER = 1010;       // env EBH_BANK_LEDGER_ID override
const TYPES_TO_SYNC = [4, 5];           // inkomende klant-betalingen
const EB_THROTTLE_MS = 200;             // best-practice spacing tussen calls

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Polleert /v1/mutation per type met cursor-filter en pagineert tot batch < limit.
 * Returnt verzamelde mutaties (gemerged uit beide types).
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
          date: `[gte]${sinceDate}`,        // bracket-prefix filter syntax (Mantix-confirmed)
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

      for (const m of data) all.push(m);
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
