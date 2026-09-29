// api/crediteer-ronde-execute.js
// POST {
//   items: [{ customer_id, subscription_id|null, invoice_ids?: uuid[],
//             months_override?: int, credit_without_extension?: boolean }],
//   only_overdue?: boolean,
//   mode?: 'credit_only',
//   run_id?: uuid, batch_index?: int, batch_total?: int,
//   confirm: true
// }
//
// Voert één BATCH (max MAX_ITEMS_PER_CALL klanten) van de crediteerronde uit.
// De UI knipt een run in batches en stuurt per batch hetzelfde run_id mee.
//
// VOLGORDE PER KLANT — het omkeerbare eerst, het onomkeerbare als laatste:
//   1. Valideren: scope (invoice_ids / only_overdue), abonnement (hoort bij
//      klant, active, Teamleader-id, einddatum) en verlengplan (per_month of
//      months_override). Faalt iets → 'geblokkeerd', niets aangeraakt.
//   2. VERLENGEN, Teamleader-bevestigd (postponeSubscription tlFirst). Weigert
//      of faalt TL → 'geblokkeerd', er wordt NIETS gecrediteerd.
//   3. CREDITEREN per factuur (een TL-creditnota is niet terug te draaien).
//   4. AFSTEMMEN als crediteren (deels) faalt:
//        - niets gecrediteerd      → verlenging exact terugzetten
//                                    (restoreSubscription) → 'geblokkeerd'.
//        - deels, basis per_month  → terugzetten en opnieuw verlengen met het
//                                    aantal WEL gecrediteerde facturen
//                                    → 'deels_gecrediteerd'.
//        - deels, basis override   → verlenging laten staan (handmatig gekozen
//                                    maanden, niet proportioneel af te leiden)
//                                    → 'deels_gecrediteerd' + melding.
//        - terugzetten faalt       → 'fout' met exacte handmatige instructie.
//   5. Gecrediteerde schuld vastleggen in dunning_credited_debt.
// "Alleen crediteren" (credit_without_extension=true, bewust gekozen): stap 2
// en 4 vervallen → 'alleen_gecrediteerd'.
//
// MODE 'credit_only': ALLEEN crediteren. Stap 2 en 4 bestaan niet in deze
// modus — postponeSubscription/restoreSubscription worden nooit aangeroepen,
// abonnementen/deals worden niet eens gelezen. Eist per klant expliciete
// invoice_ids (preview == execute) en weigert subscription_id/months_override
// met 400. Eindstatus: gecrediteerd | deels_gecrediteerd | geblokkeerd |
// overgeslagen | fout. Schuldregels krijgen subscription_id=null, 0 maanden.
//
// Eindstatus per klant (customers[].status):
//   verlengd_en_gecrediteerd | alleen_gecrediteerd | deels_gecrediteerd |
//   geblokkeerd (niets veranderd) | overgeslagen (geen facturen in scope) | fout
// Eindstatus per factuur (customers[].invoices[].status):
//   zou_crediteren (dry-run) | gecrediteerd | mislukt | niet_uitgevoerd | geweigerd
//
// Overig: eigen dry-run-vlag app_settings.crediteer_ronde_dry_run (default
// AAN; dunning_dry_run blijft onaangeroerd). Audit per batch:
// 'crediteer_ronde.batch_start' (met de items) vóór het werk en
// 'crediteer_ronde.batch_done[_dry_run]' erna, beide met run_id — een
// batch_start zonder batch_done = onderbroken batch.
//
// Response: { dry_run, run_id, batch_index, batch_total, summary, customers:[...] }

import crypto from 'crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { creditInvoiceCore } from './_lib/invoice-credit.js';
import { postponeSubscription, restoreSubscription } from './_lib/subscription-postpone.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  isCrediteerRondeDryRun, selectCreditable, hasScope, openAmountEur, planExtension,
  todayAmsterdam, OPEN_STATUSES, MAX_ITEMS_PER_CALL, MODE_CREDIT_ONLY,
} from './_lib/crediteer-ronde-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export const STATUSES = ['verlengd_en_gecrediteerd', 'gecrediteerd', 'alleen_gecrediteerd', 'deels_gecrediteerd', 'geblokkeerd', 'overgeslagen', 'fout'];

const INV_COLS = 'id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, status, tl_invoice_id, is_test, due_date';

// Open facturen van de klant + expliciet gevraagde ids in ELKE status, zodat
// een al betaalde/gecrediteerde factuur de juiste afwijsreden krijgt.
async function loadInvoices(cid, invoiceIds) {
  const { data, error } = await supabaseAdmin.from('invoices').select(INV_COLS).eq('customer_id', cid).in('status', OPEN_STATUSES);
  if (error) throw new Error('invoices lookup: ' + error.message);
  const list = [...(data || [])];
  const have = new Set(list.map((r) => r.id));
  const missing = (invoiceIds || []).filter((id) => !have.has(id));
  if (missing.length) {
    const { data: extra, error: e2 } = await supabaseAdmin.from('invoices').select(INV_COLS).in('id', missing);
    if (e2) throw new Error('invoices lookup (ids): ' + e2.message);
    for (const r of extra || []) if (r.customer_id === cid) list.push(r);
  }
  return list;
}

// Eindstatus per factuur.
function invoiceStatuses({ creditable, rejected, okIds, errors, dryRun }) {
  const errById = new Map((errors || []).filter((e) => e.scope === 'invoice').map((e) => [e.invoice_id, e.message]));
  return [
    ...creditable.map((iv) => ({
      invoice_id: iv.id, invoice_number: iv.invoice_number || null, open_amount: openAmountEur(iv),
      status: dryRun ? 'zou_crediteren' : okIds.has(iv.id) ? 'gecrediteerd' : errById.has(iv.id) ? 'mislukt' : 'niet_uitgevoerd',
      reden: errById.get(iv.id) || null,
    })),
    ...rejected.map((r) => ({ invoice_id: r.invoice_id, invoice_number: r.invoice_number || null, open_amount: null, status: 'geweigerd', reden: r.reden })),
  ];
}

function quarterOf(dateIso) {
  const d = new Date(dateIso || Date.now());
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
}

async function audit(req, userId, action, payload) {
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id    : userId,
      action,
      entity_type: 'crediteer_ronde',
      entity_id  : null,
      after_json : payload,
      reason_text: payload.reason_text || null,
      ip_address : getClientIp(req),
    });
  } catch (e) { console.error('[crediteer-ronde-execute] audit', action, e?.message || e); }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.credit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.credit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (body.confirm !== true) {
    return res.status(400).json({ error: 'confirm=true vereist voor deze irreversible actie' });
  }
  const rawItems = Array.isArray(body.items) ? body.items : null;
  if (!rawItems || rawItems.length === 0) return res.status(400).json({ error: 'items (array) verplicht' });
  if (rawItems.length > MAX_ITEMS_PER_CALL) {
    return res.status(400).json({ error: `Te veel klanten in één aanroep (max ${MAX_ITEMS_PER_CALL}) — knip de run in batches` });
  }
  const onlyOverdue = body.only_overdue === true;
  const creditOnly = body.mode === MODE_CREDIT_ONLY;
  if (body.mode != null && !creditOnly) return res.status(400).json({ error: `Onbekende mode '${body.mode}'` });

  const items = [];
  const seen = new Set();
  for (const it of rawItems) {
    const cid = typeof it?.customer_id === 'string' && UUID_RE.test(it.customer_id) ? it.customer_id : null;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const invoiceIds = Array.isArray(it.invoice_ids) ? it.invoice_ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)) : [];
    if (creditOnly) {
      // credit_only: alleen een expliciete factuurlijst telt als scope, en
      // abonnement-/maandvelden zijn een tegenstrijdige intentie → weigeren.
      if (invoiceIds.length === 0) {
        return res.status(400).json({ error: `credit_only: invoice_ids verplicht voor klant ${cid} (only_overdue alleen is niet genoeg).` });
      }
      if (it.subscription_id || it.months_override != null) {
        return res.status(400).json({ error: `credit_only: subscription_id / months_override niet toegestaan (klant ${cid}) — deze modus verlengt nooit.` });
      }
    }
    if (!hasScope({ invoiceIds, onlyOverdue })) {
      return res.status(400).json({ error: `Scope verplicht voor klant ${cid}: geef invoice_ids mee of zet only_overdue=true. "Alle open facturen" wordt niet meer gecrediteerd.` });
    }
    items.push({
      customer_id             : cid,
      subscription_id         : typeof it.subscription_id === 'string' && UUID_RE.test(it.subscription_id) ? it.subscription_id : null,
      invoice_ids             : invoiceIds.length ? invoiceIds : null,
      months_override         : it.months_override == null || it.months_override === '' ? null : it.months_override,
      credit_without_extension: it.credit_without_extension === true,
    });
  }
  if (items.length === 0) return res.status(400).json({ error: 'Geen geldige items' });

  const dryRun     = await isCrediteerRondeDryRun();
  const runId      = typeof body.run_id === 'string' && UUID_RE.test(body.run_id) ? body.run_id : crypto.randomUUID();
  const batchIndex = Number.isInteger(body.batch_index) ? body.batch_index : 1;
  const batchTotal = Number.isInteger(body.batch_total) ? body.batch_total : 1;
  const runIso     = new Date().toISOString();
  const runDate    = runIso.slice(0, 10);
  const runQuarter = quarterOf(runIso);
  const today      = todayAmsterdam();
  const description = `Crediteerronde ${runQuarter}`;

  await audit(req, user.id, 'crediteer_ronde.batch_start', {
    run_id: runId, batch_index: batchIndex, batch_total: batchTotal, dry_run: dryRun, only_overdue: onlyOverdue,
    mode: creditOnly ? MODE_CREDIT_ONLY : 'extend_and_credit',
    items: items.map((i) => ({ customer_id: i.customer_id, subscription_id: i.subscription_id, invoice_ids: i.invoice_ids, months_override: i.months_override, credit_without_extension: i.credit_without_extension })),
    reason_text: `Crediteerronde ${runQuarter} — batch ${batchIndex}/${batchTotal} gestart (${items.length} klant(en))${dryRun ? ' [dry-run]' : ''}`,
  });

  const summary = {
    total_customers       : items.length,
    credited_invoices     : 0,
    credited_incl         : 0,
    extended_subscriptions: 0,
    extended_months       : 0,
    status_counts         : Object.fromEntries(STATUSES.map((s) => [s, 0])),
    dry_run               : dryRun,
    mode                  : creditOnly ? MODE_CREDIT_ONLY : 'extend_and_credit',
  };
  const customersOut = [];

  for (const it of items) {
    const cid = it.customer_id;
    const entry = {
      customer_id: cid, customer_name: null, status: null, dry_run: dryRun,
      credited: [], rejected: [], invoices: [], extended: null, reverted: null, errors: [],
    };
    const finish = (status) => {
      entry.status = status;
      summary.status_counts[status]++;
      customersOut.push(entry);
    };
    const block = (scope, message, code = null) => { entry.errors.push({ scope, message, code }); finish('geblokkeerd'); };

    try {
      // ── 1) VALIDEREN ────────────────────────────────────────────────────
      const { data: cust } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
        .eq('id', cid).maybeSingle();
      if (!cust) { block('customer', 'Klant niet gevonden'); continue; }
      if (cust.archived_at || cust.anonymized_at || cust.is_test) { block('customer', 'Klant is gearchiveerd / anoniem / test'); continue; }
      entry.customer_name = customerDisplayName(cust, '(zonder naam)');

      const invs = await loadInvoices(cid, it.invoice_ids);
      const { creditable, rejected } = selectCreditable(invs, { invoiceIds: it.invoice_ids, onlyOverdue, today });
      entry.rejected = rejected;
      entry.invoices = invoiceStatuses({ creditable, rejected, okIds: new Set(), errors: [], dryRun: false });
      if (creditable.length === 0) {
        entry.invoices = invoiceStatuses({ creditable, rejected, okIds: new Set(), errors: [], dryRun });
        finish('overgeslagen'); continue;
      }

      // ── CREDIT_ONLY: alleen crediteren. Raakt GEEN abonnementen aan —
      //    postponeSubscription/restoreSubscription worden hier nooit bereikt.
      if (creditOnly) {
        const ok = [];
        if (dryRun) {
          for (const iv of creditable) ok.push({ invoice_id: iv.id, invoice_number: iv.invoice_number, open_amount: openAmountEur(iv), vat_amount: r2(Number(iv.vat_amount) || 0), tl_credit_note_id: null });
        } else {
          for (const iv of creditable) {
            try {
              const result = await creditInvoiceCore(iv.id, { description, userId: user.id });
              ok.push({ invoice_id: iv.id, invoice_number: iv.invoice_number, open_amount: openAmountEur(iv), vat_amount: r2(Number(iv.vat_amount) || 0), tl_credit_note_id: result.tl_credit_note_id });
            } catch (e) {
              entry.errors.push({ scope: 'invoice', invoice_id: iv.id, invoice_number: iv.invoice_number, message: e?.message || String(e), code: e?.code || null });
            }
          }
        }
        entry.credited = ok.map((o) => ({ ...o, dry_run: dryRun }));
        entry.invoices = invoiceStatuses({ creditable, rejected, okIds: new Set(ok.map((o) => o.invoice_id)), errors: entry.errors, dryRun });
        summary.credited_invoices += ok.length;
        summary.credited_incl = r2(summary.credited_incl + ok.reduce((s, o) => s + o.open_amount, 0));
        let status = ok.length === creditable.length ? 'gecrediteerd' : ok.length === 0 ? 'geblokkeerd' : 'deels_gecrediteerd';
        if (!dryRun && ok.length > 0) {
          const { error } = await supabaseAdmin.from('dunning_credited_debt').insert(ok.map((o) => ({
            customer_id: cid, invoice_id: o.invoice_id, tl_credit_note_id: o.tl_credit_note_id || null,
            amount_incl: o.open_amount, vat_amount: o.vat_amount, credited_on: runDate, quarter: runQuarter,
            subscription_id: null, months_extended: 0, created_by: user.id,
          })));
          if (error) { entry.errors.push({ scope: 'db', message: 'dunning_credited_debt insert: ' + error.message }); status = 'fout'; }
        }
        finish(status);
        continue;
      }

      let sub = null;
      let plan = null;
      if (it.subscription_id) {
        const { data: s } = await supabaseAdmin.from('subscriptions')
          .select('id, deal_id, description, amount, term_count, start_date, end_date, teamleader_subscription_id, postponed_months, original_start_date, original_end_date, status, billing_cycle')
          .eq('id', it.subscription_id).maybeSingle();
        if (!s) { block('subscription', 'Abonnement niet gevonden'); continue; }
        const { data: deal } = await supabaseAdmin.from('deals').select('id, customer_id').eq('id', s.deal_id).maybeSingle();
        if (!deal || deal.customer_id !== cid) { block('subscription', 'Abonnement hoort niet bij deze klant'); continue; }
        if (String(s.status || '').toLowerCase() !== 'active') { block('subscription', `Abonnement is niet actief (status ${s.status})`); continue; }
        if (!s.teamleader_subscription_id) { block('subscription', 'Abonnement heeft geen Teamleader-id — kan niet verlengen'); continue; }
        if (!s.end_date) { block('subscription', 'Abonnement heeft geen einddatum — verlengen kan niet eenduidig'); continue; }
        plan = planExtension(s, creditable.length, it.months_override);
        if (plan.error === 'CYCLE_UNSUPPORTED') {
          block('subscription', `billing_cycle '${plan.cycle ?? 'onbekend'}' — geen automatische maandentelling. Geef months_override (1-36) mee.`, 'CYCLE_UNSUPPORTED');
          continue;
        }
        if (plan.error) { block('subscription', 'months_override moet een geheel getal 1-36 zijn', plan.error); continue; }
        sub = s;
      } else if (!it.credit_without_extension) {
        block('subscription', 'Geen abonnement gekozen. Kies een abonnement of zet credit_without_extension=true (dan wordt het bedrag nergens heraangeplakt).', 'NO_SUBSCRIPTION');
        continue;
      }

      // ── DRY-RUN: rapporteer wat er zou gebeuren, raak niets aan ──────────
      if (dryRun) {
        entry.credited = creditable.map((iv) => ({ invoice_id: iv.id, invoice_number: iv.invoice_number, open_amount: openAmountEur(iv), vat_amount: r2(Number(iv.vat_amount) || 0), tl_credit_note_id: null, dry_run: true }));
        summary.credited_invoices += entry.credited.length;
        summary.credited_incl = r2(summary.credited_incl + entry.credited.reduce((s, o) => s + o.open_amount, 0));
        entry.invoices = invoiceStatuses({ creditable, rejected, okIds: new Set(), errors: [], dryRun: true });
        if (sub) {
          entry.extended = { subscription_id: sub.id, months: plan.months, basis: plan.basis, extended: false, would_extend: true, dry_run: true };
          summary.extended_subscriptions++; summary.extended_months += plan.months;
          finish('verlengd_en_gecrediteerd');
        } else finish('alleen_gecrediteerd');
        continue;
      }

      // ── 2) VERLENGEN (Teamleader-bevestigd) — vóór het crediteren ────────
      let ext = null;      // { snapshot, subAfter, months }
      if (sub) {
        try {
          const r = await postponeSubscription(sub, plan.months, { userId: user.id, req, tlFirst: true });
          if (r?.tl?.pushed !== true) throw Object.assign(new Error('Teamleader bevestigde de verlenging niet'), { code: 'TL_NOT_CONFIRMED' });
          ext = { snapshot: r.snapshot, subAfter: { ...sub, ...(r.subscription || {}) }, months: plan.months };
          entry.extended = { subscription_id: sub.id, months: plan.months, basis: plan.basis, extended: true, dry_run: false };
        } catch (e) {
          entry.extended = { subscription_id: sub.id, months: plan.months, basis: plan.basis, extended: false, dry_run: false };
          if (e?.code === 'DB_AFTER_TL') {
            // TL is al verlengd, onze DB niet — niet crediteren, handmatig herstellen.
            entry.errors.push({ scope: 'subscription', code: 'DB_AFTER_TL', message: `${e.message}. NIETS gecrediteerd. Zet in Teamleader ends_on terug naar ${sub.end_date}.` });
            finish('fout');
          } else {
            block('subscription', `Verlenging niet bevestigd door Teamleader — NIETS gecrediteerd. ${e?.message || e}`, e?.code || 'TL_NOT_CONFIRMED');
          }
          continue;
        }
      }

      // ── 3) CREDITEREN ─────────────────────────────────────────────────────
      const ok = [];
      for (const iv of creditable) {
        try {
          const result = await creditInvoiceCore(iv.id, { description, userId: user.id });
          ok.push({ invoice_id: iv.id, invoice_number: iv.invoice_number, open_amount: openAmountEur(iv), vat_amount: r2(Number(iv.vat_amount) || 0), tl_credit_note_id: result.tl_credit_note_id });
        } catch (e) {
          entry.errors.push({ scope: 'invoice', invoice_id: iv.id, invoice_number: iv.invoice_number, message: e?.message || String(e), code: e?.code || null });
        }
      }
      entry.credited = ok.map((o) => ({ ...o, dry_run: false }));
      entry.invoices = invoiceStatuses({ creditable, rejected, okIds: new Set(ok.map((o) => o.invoice_id)), errors: entry.errors, dryRun: false });
      summary.credited_invoices += ok.length;
      summary.credited_incl = r2(summary.credited_incl + ok.reduce((s, o) => s + o.open_amount, 0));
      const allCredited = ok.length === creditable.length;

      // ── 4) AFSTEMMEN verlenging ↔ credits ─────────────────────────────────
      let finalMonths = ext ? ext.months : 0;
      let extensionStands = !!ext;
      let status = ext ? 'verlengd_en_gecrediteerd' : 'alleen_gecrediteerd';
      if (!allCredited) status = ok.length === 0 ? 'geblokkeerd' : 'deels_gecrediteerd';

      if (ext && !allCredited) {
        const needRestore = ok.length === 0 || plan.basis === 'per_month';
        if (needRestore) {
          try {
            await restoreSubscription(ext.subAfter, ext.snapshot, { userId: user.id, req, reason: `Crediteerronde ${runQuarter}: ${ok.length}/${creditable.length} gecrediteerd — verlenging teruggezet` });
            entry.reverted = { restored_to: ext.snapshot.end_date, ok: true };
            extensionStands = false; finalMonths = 0;
          } catch (e) {
            entry.reverted = { restored_to: ext.snapshot.end_date, ok: false };
            entry.errors.push({ scope: 'subscription', code: 'REVERT_FAILED', message: `Verlenging (+${ext.months} mnd) kon NIET worden teruggezet: ${e?.message || e}. Handmatig: zet ends_on in Teamleader en end_date in de DB terug naar ${ext.snapshot.end_date} (term_count ${ext.snapshot.term_count}).` });
            status = 'fout';
          }
          // per_month + deels gecrediteerd → opnieuw verlengen met het juiste aantal.
          if (entry.reverted?.ok && ok.length > 0) {
            try {
              const { data: fresh } = await supabaseAdmin.from('subscriptions')
                .select('id, deal_id, description, amount, term_count, start_date, end_date, teamleader_subscription_id, postponed_months, original_start_date, original_end_date, status, billing_cycle')
                .eq('id', sub.id).maybeSingle();
              const r = await postponeSubscription(fresh || sub, ok.length, { userId: user.id, req, tlFirst: true });
              if (r?.tl?.pushed !== true) throw new Error('Teamleader bevestigde de her-verlenging niet');
              extensionStands = true; finalMonths = ok.length;
              entry.extended = { ...entry.extended, months: ok.length, extended: true, adjusted_from: ext.months };
            } catch (e) {
              entry.extended = { ...entry.extended, extended: false };
              entry.errors.push({ scope: 'subscription', code: 'REEXTEND_FAILED', message: `${ok.length} factuur/facturen gecrediteerd maar de her-verlenging (+${ok.length} mnd) mislukte: ${e?.message || e}. Handmatig verlengen met +${ok.length} mnd.` });
              status = 'fout';
            }
          } else if (entry.reverted?.ok) {
            entry.extended = { ...entry.extended, extended: false };
          }
        } else {
          // override-basis, deels gecrediteerd: maanden waren bewust gekozen voor
          // de hele set en zijn niet proportioneel af te leiden → laten staan.
          entry.errors.push({ scope: 'subscription', code: 'OVERRIDE_PARTIAL', message: `Verlenging +${ext.months} mnd (handmatig gekozen) blijft staan terwijl ${creditable.length - ok.length} factuur/facturen NIET gecrediteerd zijn. Controleer het aantal maanden.` });
        }
      }
      if (extensionStands) { summary.extended_subscriptions++; summary.extended_months += finalMonths; }

      // ── 5) SCHULD VASTLEGGEN ──────────────────────────────────────────────
      if (ok.length > 0) {
        const rows = ok.map((o) => ({
          customer_id      : cid,
          invoice_id       : o.invoice_id,
          tl_credit_note_id: o.tl_credit_note_id || null,
          amount_incl      : o.open_amount,
          vat_amount       : o.vat_amount,
          credited_on      : runDate,
          quarter          : runQuarter,
          subscription_id  : extensionStands ? sub.id : null,
          months_extended  : extensionStands ? finalMonths : 0,
          created_by       : user.id,
        }));
        const { error } = await supabaseAdmin.from('dunning_credited_debt').insert(rows);
        if (error) { entry.errors.push({ scope: 'db', message: 'dunning_credited_debt insert: ' + error.message }); if (status !== 'fout') status = 'fout'; }
      }
      finish(status);
    } catch (e) {
      entry.errors.push({ scope: 'customer', message: e?.message || String(e) });
      finish(entry.credited.length || entry.extended?.extended ? 'fout' : 'geblokkeerd');
    }
  }

  const sc = summary.status_counts;
  await audit(req, user.id, dryRun ? 'crediteer_ronde.batch_done_dry_run' : 'crediteer_ronde.batch_done', {
    run_id: runId, batch_index: batchIndex, batch_total: batchTotal, quarter: runQuarter, summary,
    mode: creditOnly ? MODE_CREDIT_ONLY : 'extend_and_credit',
    customers: customersOut.map((c) => ({
      customer_id: c.customer_id, status: c.status, credited: c.credited.map((x) => x.invoice_id),
      invoices: c.invoices.map((x) => ({ invoice_id: x.invoice_id, status: x.status, reden: x.reden })),
      extended: c.extended, reverted: c.reverted, errors: c.errors,
    })),
    reason_text: `Crediteerronde ${runQuarter} — batch ${batchIndex}/${batchTotal}${dryRun ? ' (dry-run)' : ''}${creditOnly ? ' [alleen crediteren]' : ''}: ${sc.gecrediteerd} gecrediteerd, ${sc.verlengd_en_gecrediteerd} verlengd+gecrediteerd, ${sc.alleen_gecrediteerd} alleen gecrediteerd, ${sc.deels_gecrediteerd} deels, ${sc.geblokkeerd} geblokkeerd, ${sc.overgeslagen} overgeslagen, ${sc.fout} fout`,
  });

  return res.status(200).json({ dry_run: dryRun, mode: creditOnly ? MODE_CREDIT_ONLY : 'extend_and_credit', run_id: runId, batch_index: batchIndex, batch_total: batchTotal, summary, customers: customersOut });
}
