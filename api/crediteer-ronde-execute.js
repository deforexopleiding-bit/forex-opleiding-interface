// api/crediteer-ronde-execute.js
// POST {
//   items: [{ customer_id, subscription_id|null, invoice_ids?: uuid[],
//             months_override?: int, credit_without_extension?: boolean }],
//   only_overdue?: boolean,
//   run_id?: uuid, batch_index?: int, batch_total?: int,
//   confirm: true
// }
//
// Voert één BATCH (max MAX_ITEMS_PER_CALL klanten) van de crediteerronde uit.
// De UI knipt een run in batches en stuurt per batch hetzelfde run_id mee.
//
// Veiligheidsregels (2026-09-29, na pre-flight):
//   1. SCOPE VERPLICHT — per klant invoice_ids en/of body.only_overdue=true.
//      "Alle open facturen van de klant" bestaat niet meer. Selectie via de
//      gedeelde selectCreditable(), identiek aan de preview.
//   2. ABONNEMENT EERST CONTROLEREN, DAN PAS CREDITEREN — hoort bij de klant,
//      status active, Teamleader-id, en een geldig verlengplan. Faalt één
//      daarvan → deze klant wordt NIET gecrediteerd (geen losse credits
//      zonder heraanplakken). Zonder subscription_id alleen met expliciet
//      credit_without_extension=true.
//   3. MAANDEN OP BILLING_CYCLE — per_month: 1 maand per gecrediteerde
//      factuur. Andere/onbekende cyclus: alleen met months_override (1-36).
//   4. EXTENDED ALLEEN NA TL-BEVESTIGING — postponeSubscription(tlFirst):
//      Teamleader eerst, DB pas na 2xx. Geen stille "gelukt".
//   5. EIGEN DRY-RUN — app_settings.crediteer_ronde_dry_run (default AAN).
//      De systeembrede dunning_dry_run blijft onaangeroerd.
//   6. AUDIT PER BATCH — 'crediteer_ronde.batch_start' vóór het werk en
//      'crediteer_ronde.batch_done' erna, met run_id + batch-positie, zodat
//      een onderbroken run traceerbaar is.
//
// Hervatten: al gecrediteerde facturen hebben open_amount 0 en vallen bij een
// herhaalde aanroep vanzelf uit de selectie. LET OP: faalde de verlenging na
// een geslaagde credit, dan levert een herhaling 0 maanden op — de klant staat
// dan in de batch_done-audit met scope 'subscription' en moet handmatig
// verlengd worden.
//
// Response: { dry_run, run_id, batch_index, batch_total, summary, customers:[...] }

import crypto from 'crypto';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { creditInvoiceCore } from './_lib/invoice-credit.js';
import { postponeSubscription } from './_lib/subscription-postpone.js';
import { getClientIp } from './_lib/audit-customer.js';
import {
  isCrediteerRondeDryRun, selectCreditable, hasScope, openAmountEur, planExtension,
  todayAmsterdam, OPEN_STATUSES, MAX_ITEMS_PER_CALL,
} from './_lib/crediteer-ronde-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

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

  // Validate + dedupe.
  const items = [];
  const seen = new Set();
  for (const it of rawItems) {
    const cid = typeof it?.customer_id === 'string' && UUID_RE.test(it.customer_id) ? it.customer_id : null;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const invoiceIds = Array.isArray(it.invoice_ids) ? it.invoice_ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)) : [];
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

  await audit(req, user.id, 'crediteer_ronde.batch_start', {
    run_id: runId, batch_index: batchIndex, batch_total: batchTotal, dry_run: dryRun, only_overdue: onlyOverdue,
    items: items.map((i) => ({ customer_id: i.customer_id, subscription_id: i.subscription_id, invoice_ids: i.invoice_ids, months_override: i.months_override, credit_without_extension: i.credit_without_extension })),
    reason_text: `Crediteerronde ${runQuarter} — batch ${batchIndex}/${batchTotal} gestart (${items.length} klant(en))${dryRun ? ' [dry-run]' : ''}`,
  });

  const summary = {
    total_customers       : items.length,
    credited_invoices     : 0,
    credited_incl         : 0,
    extended_subscriptions: 0,
    extended_months       : 0,
    skipped_no_invoices   : 0,
    blocked_customers     : 0,   // niet gecrediteerd door een pre-check
    error_customers       : 0,
    dry_run               : dryRun,
  };
  const customersOut = [];

  for (const it of items) {
    const cid = it.customer_id;
    const entry = { customer_id: cid, customer_name: null, credited: [], rejected: [], extended: null, errors: [], dry_run: dryRun };
    const block = (scope, message, code = null) => {
      entry.errors.push({ scope, message, code });
      summary.blocked_customers++;
      customersOut.push(entry);
    };
    try {
      // A) Klant.
      const { data: cust } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
        .eq('id', cid).maybeSingle();
      if (!cust) { block('customer', 'Klant niet gevonden'); continue; }
      if (cust.archived_at || cust.anonymized_at || cust.is_test) { block('customer', 'Klant is gearchiveerd / anoniem / test'); continue; }
      entry.customer_name = customerDisplayName(cust, '(zonder naam)');

      // B) Scope-selectie (identiek aan de preview).
      const { data: invs, error: invErr } = await supabaseAdmin.from('invoices')
        .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, status, tl_invoice_id, is_test, due_date')
        .eq('customer_id', cid).in('status', OPEN_STATUSES);
      if (invErr) throw new Error('invoices lookup: ' + invErr.message);
      const { creditable, rejected } = selectCreditable(invs, { invoiceIds: it.invoice_ids, onlyOverdue, today });
      entry.rejected = rejected;
      if (creditable.length === 0) { summary.skipped_no_invoices++; customersOut.push(entry); continue; }

      // C) Abonnement + verlengplan controleren VÓÓR er iets gecrediteerd wordt.
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

      // D) Crediteren per factuur.
      const description = `Crediteerronde ${runQuarter}`;
      const ok = [];
      for (const iv of creditable) {
        const row = { invoice_id: iv.id, invoice_number: iv.invoice_number, open_amount: openAmountEur(iv), vat_amount: r2(Number(iv.vat_amount) || 0) };
        try {
          if (dryRun) {
            ok.push({ ...row, tl_credit_note_id: null });
          } else {
            const result = await creditInvoiceCore(iv.id, { description, userId: user.id });
            ok.push({ ...row, tl_credit_note_id: result.tl_credit_note_id });
          }
        } catch (e) {
          entry.errors.push({ scope: 'invoice', invoice_id: iv.id, invoice_number: iv.invoice_number, message: e?.message || String(e), code: e?.code || null });
        }
      }
      entry.credited = ok.map((o) => ({ ...o, dry_run: dryRun }));
      summary.credited_invoices += ok.length;
      summary.credited_incl = r2(summary.credited_incl + ok.reduce((s, o) => s + o.open_amount, 0));

      // E) Verlengen — alleen als er iets gecrediteerd is. extended=true
      //    uitsluitend na bevestiging door Teamleader (tlFirst).
      let extendedOk = false;
      let months = 0;
      if (sub && ok.length > 0) {
        months = plan.basis === 'per_month' ? ok.length : plan.months;
        if (dryRun) {
          entry.extended = { subscription_id: sub.id, months, basis: plan.basis, extended: false, would_extend: true, dry_run: true };
        } else {
          try {
            const r = await postponeSubscription(sub, months, { userId: user.id, req, tlFirst: true });
            extendedOk = r?.tl?.pushed === true;
            entry.extended = { subscription_id: sub.id, months, basis: plan.basis, extended: extendedOk, dry_run: false };
            if (!extendedOk) entry.errors.push({ scope: 'subscription', message: 'Teamleader bevestigde de verlenging niet', code: 'TL_NOT_CONFIRMED' });
          } catch (e) {
            entry.extended = { subscription_id: sub.id, months, basis: plan.basis, extended: false, dry_run: false };
            entry.errors.push({ scope: 'subscription', message: `Gecrediteerd maar NIET verlengd: ${e?.message || e}. Handmatig verlengen met +${months} mnd.`, code: e?.code || 'EXTEND_FAILED' });
          }
        }
        if (extendedOk || dryRun) { summary.extended_subscriptions++; summary.extended_months += months; }
      }

      // F) Gecrediteerde schuld vastleggen (alleen live).
      if (!dryRun && ok.length > 0) {
        const rows = ok.map((o) => ({
          customer_id      : cid,
          invoice_id       : o.invoice_id,
          tl_credit_note_id: o.tl_credit_note_id || null,
          amount_incl      : o.open_amount,
          vat_amount       : o.vat_amount,
          credited_on      : runDate,
          quarter          : runQuarter,
          subscription_id  : extendedOk ? sub.id : null,
          months_extended  : extendedOk ? months : 0,
          created_by       : user.id,
        }));
        const { error } = await supabaseAdmin.from('dunning_credited_debt').insert(rows);
        if (error) entry.errors.push({ scope: 'db', message: 'dunning_credited_debt insert: ' + error.message });
      }

      if (entry.errors.length) summary.error_customers++;
      customersOut.push(entry);
    } catch (e) {
      entry.errors.push({ scope: 'customer', message: e?.message || String(e) });
      summary.error_customers++;
      customersOut.push(entry);
    }
  }

  await audit(req, user.id, dryRun ? 'crediteer_ronde.batch_done_dry_run' : 'crediteer_ronde.batch_done', {
    run_id: runId, batch_index: batchIndex, batch_total: batchTotal, quarter: runQuarter, summary,
    customers: customersOut.map((c) => ({
      customer_id: c.customer_id, credited: c.credited.map((x) => x.invoice_id),
      extended: c.extended, errors: c.errors,
    })),
    reason_text: `Crediteerronde ${runQuarter} — batch ${batchIndex}/${batchTotal}: ${summary.credited_invoices} facturen ${dryRun ? '(dry-run)' : 'gecrediteerd'}, ${summary.extended_subscriptions} abo's verlengd, ${summary.blocked_customers} geblokkeerd, ${summary.error_customers} met fouten`,
  });

  return res.status(200).json({ dry_run: dryRun, run_id: runId, batch_index: batchIndex, batch_total: batchTotal, summary, customers: customersOut });
}
