// api/cron-finance-sync.js
// Cron-endpoint: spiegelt TL → DB voor facturen + creditnota's op basis van
// `updated_since`. Idempotent. Continue sync (hourly via vercel.json).
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth uit ./supabase.js,
// zelfde patroon als /api/sync-emails).
//
// Per resource:
//   1. Lees sync_state.<resource>.last_updated_since.
//   2. Poll TL met filter.updated_since over de 3 departments (sequentieel) +
//      paginatie size 100 totdat de pagina < 100 returnt of het tijdsbudget op is.
//   3. Per record: upsert via shared helpers (_lib/invoice-upsert.js of
//      _lib/creditnote-upsert.js). Errors loggen + tellen, niet aborten.
//   4. Bereken nieuwe cursor = max(record.updated_at) OF NOW() bij 0 records.
//      Bij voortijdige timeout: cursor = max(updated_at) van wat WEL verwerkt is
//      (next run pakt de rest op).
//   5. Schrijf sync_state-row terug met run-statistieken.
//
// Per creditnota wordt het lokale invoice_id verzameld; aan het eind van de
// creditnotes-fase wordt invoices.credited_amount opnieuw berekend voor die
// facturen (recomputeCreditedAmount).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';
import { upsertCreditNoteFromTl, recomputeCreditedAmount } from './_lib/creditnote-upsert.js';
import { upsertContactFromTl } from './_lib/contact-upsert.js';
import { upsertCompanyFromTl } from './_lib/company-upsert.js';

// company_entities seed (Online/Fysiek/Retentie). Consistent met
// finance-tl-invoice-sync.js en finance-creditnote-sync.js.
const DEPARTMENTS = [
  '09d67371-6947-03f6-bd5e-410dd8636344', // Online
  '0da396bf-1074-0425-ac5c-fa1141b41cb1', // Fysiek
  '9adca043-0ebc-09da-a45e-f21798841cb2', // Retentie
];

// 60s Vercel-limit. Stop nieuwe records oppakken zodra we 50s onderweg zijn.
// Eerstvolgende cron-run pakt de rest op (cursor blijft op max(verwerkte updated_at)).
const ABORT_MS = 50_000;
const PAGE_SIZE = 100;
const TL_THROTTLE_MS = 200;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wrapper rond tlFetch met de bekende 200ms throttle + 429 exp-backoff.
async function tlCall(path, body, attempt = 0) {
  await sleep(TL_THROTTLE_MS);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

// Pakt het ISO-datetime uit een TL record. Fallback op invoice_date / credit_note_date.
function recordUpdatedAt(rec) {
  return rec?.updated_at || rec?.invoice_date || rec?.credit_note_date || null;
}

// Vergelijkbare timestamps. Beide ISO-strings → string-compare werkt voor ISO 8601.
function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Synchroniseer één resource (invoices of creditnotes). Polls TL list-endpoint
 * met `updated_since` over alle 3 departments en delegeert per record naar de
 * shared upsert-helper. Verzamelt geraakte invoice_id's voor recompute (alleen
 * relevant voor creditnotes).
 *
 * @param {object} cfg
 * @param {string} cfg.resource         'invoices' | 'creditnotes' | 'contacts' | 'companies'
 * @param {string} cfg.listEndpoint     '/invoices.list' | '/creditNotes.list' | '/contacts.list' | '/companies.list'
 * @param {string} cfg.updatedSinceIso  cursor
 * @param {number} cfg.startedAt        Date.now() bij start van de hele run
 * @param {(id: string) => Promise<any>} cfg.upsertOne
 * @param {string[]|null} [cfg.departments]  Optioneel: list van dept-uuids om over te
 *                                            looppen (invoices/creditnotes). null/ontbreekt:
 *                                            geen department-loop, één plat call met alleen
 *                                            filter.updated_since (contacts/companies — CRM-
 *                                            endpoints kennen geen department_id filter).
 * @returns {Promise<{processed: number, errors: number, next_cursor: string, sampled_max_updated: string|null, affected_invoice_ids: Set<string>, aborted: boolean, sampled_actions: Record<string, number>}>}
 */
async function syncResource(cfg) {
  const { resource, listEndpoint, updatedSinceIso, startedAt, upsertOne } = cfg;
  // Bewust géén default-value op DEPARTMENTS: callers die deze loop niet willen,
  // moeten expliciet null/undefined passen. Voorkomt onbedoelde dept-filtering
  // op CRM-endpoints die er een 400 op geven.
  const departments = Array.isArray(cfg.departments) ? cfg.departments : null;
  const affected_invoice_ids = new Set();
  const sampled_actions = {};  // { inserted: n, updated: n, skipped: n } — voor diag
  let processed = 0, errors = 0;
  let sampled_max_updated = null;
  let aborted = false;

  // departments=null → één virtueel pseudo-dept (null) zodat de buitenste loop
  // exact één keer draait zonder department_id in het filter.
  const deptLoop = departments && departments.length ? departments : [null];

  outer:
  for (const dept of deptLoop) {
    let page = 1;
    while (true) {
      if (Date.now() - startedAt > ABORT_MS) { aborted = true; break outer; }

      // Filter: updated_since altijd; department_id alleen als dept een echte uuid is.
      const filter = { updated_since: updatedSinceIso };
      if (dept) filter.department_id = dept;

      const r = await tlCall(listEndpoint, {
        filter,
        page: { size: PAGE_SIZE, number: page },
        sort: [{ field: 'updated_at', order: 'asc' }],   // oudste eerst → cursor monotoon
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.error(`[cron-finance-sync] ${resource} ${listEndpoint} HTTP ${r.status} dept=${dept ?? 'flat'} page=${page}`, txt.slice(0, 300));
        errors++;
        // Niet de hele run aborten — volgende dept / iteratie proberen.
        break;
      }

      let batch = [];
      try { batch = (await r.json()).data || []; }
      catch (e) {
        console.error(`[cron-finance-sync] ${resource} json-parse fout dept=${dept ?? 'flat'} page=${page}`, e.message);
        errors++;
        break;
      }

      for (const lite of batch) {
        if (Date.now() - startedAt > ABORT_MS) { aborted = true; break outer; }
        processed++;
        try {
          const out = await upsertOne(lite.id);
          // Voor creditnotes: invoice_id verzamelen voor recompute.
          if (resource === 'creditnotes' && out?.invoice_id) affected_invoice_ids.add(out.invoice_id);
          // Action tellen (inserted/updated/skipped) voor diag op contacts/companies.
          if (out?.action) sampled_actions[out.action] = (sampled_actions[out.action] || 0) + 1;
          const ts = recordUpdatedAt(lite);
          if (ts) sampled_max_updated = maxIso(sampled_max_updated, ts);
        } catch (e) {
          errors++;
          if (errors <= 5) console.error(`[cron-finance-sync] ${resource} upsert id=${lite.id}`, e.message);
        }
      }

      // Klaar met deze dept als pagina niet vol was.
      if (batch.length < PAGE_SIZE) break;
      page++;
    }
  }

  // Nieuwe cursor: kleine veiligheidsmarge — gebruik max(gezien) en val terug op
  // bestaande cursor als we niets verwerkten. Bij volledig lege run pushen we de
  // cursor NIET naar NOW(), want bij abort vlak na een nieuwe TL-create zou dat
  // records overslaan. Veilig: alleen vooruit als we echt records zagen.
  const next_cursor = sampled_max_updated || updatedSinceIso;

  return { processed, errors, next_cursor, sampled_max_updated, affected_invoice_ids, aborted, sampled_actions };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Auth: CRON_SECRET. Zelfde checkCronAuth als /api/sync-emails.
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const tok = await getActiveToken();
  if (!tok) return res.status(400).json({ error: 'Geen actief Teamleader-token' });

  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();

  // 1. sync_state ophalen voor alle 4 resources.
  let stateRows = [];
  try {
    const { data, error } = await supabaseAdmin
      .from('sync_state').select('*').in('resource', ['invoices', 'creditnotes', 'contacts', 'companies']);
    if (error) throw new Error(error.message);
    stateRows = data || [];
  } catch (e) {
    console.error('[cron-finance-sync] sync_state SELECT', e.message);
    return res.status(500).json({ error: 'Kon sync_state niet lezen: ' + e.message });
  }
  const byResource = Object.fromEntries(stateRows.map(r => [r.resource, r]));
  if (!byResource.invoices || !byResource.creditnotes) {
    return res.status(500).json({
      error: 'sync_state-rij ontbreekt — draai de migratie 2026-06-06-finance-sync-state.sql.',
      found: Object.keys(byResource),
    });
  }
  // contacts/companies-rijen zijn optioneel: bij ontbreken slaan we die resources
  // gewoon over (Fase 4 migratie moet nog gedraaid; cron blijft werken op finance-data).

  const summary = {
    started_at: startedIso,
    invoices: null, creditnotes: null,
    contacts: null, companies: null,
  };

  // 2. Invoices syncen (per-department).
  try {
    const invStart = Date.now();
    const invRes = await syncResource({
      resource: 'invoices',
      listEndpoint: '/invoices.list',
      updatedSinceIso: byResource.invoices.last_updated_since,
      startedAt,
      departments: DEPARTMENTS,
      upsertOne: (id) => upsertInvoiceFromTl(id),
    });
    const invDuration = Date.now() - invStart;

    // sync_state.invoices terugschrijven.
    const { error: upErr } = await supabaseAdmin.from('sync_state').update({
      last_updated_since:   invRes.next_cursor,
      last_run_at:          startedIso,
      last_run_processed:   invRes.processed,
      last_run_errors:      invRes.errors,
      last_run_duration_ms: invDuration,
    }).eq('resource', 'invoices');
    if (upErr) console.error('[cron-finance-sync] sync_state invoices UPDATE', upErr.message);

    summary.invoices = {
      processed:             invRes.processed,
      errors:                invRes.errors,
      duration_ms:           invDuration,
      last_updated_since:    invRes.next_cursor,
      aborted_by_timeout:    invRes.aborted,
    };
  } catch (e) {
    console.error('[cron-finance-sync] invoices fase', e.message);
    summary.invoices = { error: e.message };
  }

  // 3. Creditnotes syncen (per-department).
  try {
    const cnStart = Date.now();
    const cnRes = await syncResource({
      resource: 'creditnotes',
      listEndpoint: '/creditNotes.list',
      updatedSinceIso: byResource.creditnotes.last_updated_since,
      startedAt,
      departments: DEPARTMENTS,
      upsertOne: (id) => upsertCreditNoteFromTl(id),
    });
    // Recompute credited_amount voor de geraakte facturen.
    let recompute = { updated: 0, errors: 0 };
    if (cnRes.affected_invoice_ids.size) {
      recompute = await recomputeCreditedAmount(cnRes.affected_invoice_ids);
    }
    const cnDuration = Date.now() - cnStart;

    const { error: upErr } = await supabaseAdmin.from('sync_state').update({
      last_updated_since:   cnRes.next_cursor,
      last_run_at:          startedIso,
      last_run_processed:   cnRes.processed,
      last_run_errors:      cnRes.errors + recompute.errors,
      last_run_duration_ms: cnDuration,
    }).eq('resource', 'creditnotes');
    if (upErr) console.error('[cron-finance-sync] sync_state creditnotes UPDATE', upErr.message);

    summary.creditnotes = {
      processed:             cnRes.processed,
      errors:                cnRes.errors,
      duration_ms:           cnDuration,
      last_updated_since:    cnRes.next_cursor,
      affected_invoices:     cnRes.affected_invoice_ids.size,
      recomputed:            recompute.updated,
      recompute_errors:      recompute.errors,
      aborted_by_timeout:    cnRes.aborted,
    };
  } catch (e) {
    console.error('[cron-finance-sync] creditnotes fase', e.message);
    summary.creditnotes = { error: e.message };
  }

  // 4. Contacts syncen (flat, geen department-loop). Slaat de fase over als
  //    sync_state.contacts-rij ontbreekt (Fase 4 migratie nog niet gedraaid).
  if (byResource.contacts) {
    try {
      const ctStart = Date.now();
      const ctRes = await syncResource({
        resource: 'contacts',
        listEndpoint: '/contacts.list',
        updatedSinceIso: byResource.contacts.last_updated_since,
        startedAt,
        departments: null,
        upsertOne: (id) => upsertContactFromTl(id),
      });
      const ctDuration = Date.now() - ctStart;
      const { error: upErr } = await supabaseAdmin.from('sync_state').update({
        last_updated_since:   ctRes.next_cursor,
        last_run_at:          startedIso,
        last_run_processed:   ctRes.processed,
        last_run_errors:      ctRes.errors,
        last_run_duration_ms: ctDuration,
      }).eq('resource', 'contacts');
      if (upErr) console.error('[cron-finance-sync] sync_state contacts UPDATE', upErr.message);
      summary.contacts = {
        processed: ctRes.processed, errors: ctRes.errors, duration_ms: ctDuration,
        last_updated_since: ctRes.next_cursor, aborted_by_timeout: ctRes.aborted,
        actions: ctRes.sampled_actions,
      };
    } catch (e) {
      console.error('[cron-finance-sync] contacts fase', e.message);
      summary.contacts = { error: e.message };
    }
  } else {
    summary.contacts = { skipped: 'sync_state.contacts ontbreekt — draai migratie 2026-06-07-finance-sync-state-contacts-companies.sql' };
  }

  // 5. Companies syncen (flat). Idem skip-rule.
  if (byResource.companies) {
    try {
      const coStart = Date.now();
      const coRes = await syncResource({
        resource: 'companies',
        listEndpoint: '/companies.list',
        updatedSinceIso: byResource.companies.last_updated_since,
        startedAt,
        departments: null,
        upsertOne: (id) => upsertCompanyFromTl(id),
      });
      const coDuration = Date.now() - coStart;
      const { error: upErr } = await supabaseAdmin.from('sync_state').update({
        last_updated_since:   coRes.next_cursor,
        last_run_at:          startedIso,
        last_run_processed:   coRes.processed,
        last_run_errors:      coRes.errors,
        last_run_duration_ms: coDuration,
      }).eq('resource', 'companies');
      if (upErr) console.error('[cron-finance-sync] sync_state companies UPDATE', upErr.message);
      summary.companies = {
        processed: coRes.processed, errors: coRes.errors, duration_ms: coDuration,
        last_updated_since: coRes.next_cursor, aborted_by_timeout: coRes.aborted,
        actions: coRes.sampled_actions,
      };
    } catch (e) {
      console.error('[cron-finance-sync] companies fase', e.message);
      summary.companies = { error: e.message };
    }
  } else {
    summary.companies = { skipped: 'sync_state.companies ontbreekt — draai migratie 2026-06-07-finance-sync-state-contacts-companies.sql' };
  }

  const totalMs = Date.now() - startedAt;
  console.log(`[cron-finance-sync] klaar in ${totalMs}ms |`, JSON.stringify(summary));

  return res.status(200).json({ success: true, total_duration_ms: totalMs, ...summary });
}
