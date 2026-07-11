// api/crediteer-ronde-execute.js
// POST { items: [{ customer_id, subscription_id|null }], confirm: true }
//
// Voert de kwartaal-crediteerronde uit voor de meegegeven klanten. Per klant:
//   1) Alle openstaande facturen (status open/partially_paid/overdue, is_test=false,
//      met tl_invoice_id én status != 'concept') → creditInvoiceCore per stuk.
//   2) Als subscription_id meegegeven en het abo hoort bij de klant én heeft
//      teamleader_subscription_id: postponeSubscription(sub, N) waarbij N =
//      aantal succesvol gecrediteerde facturen van deze klant (extend/verlengen).
//   3) Per succesvol gecrediteerde factuur: insert dunning_credited_debt-row.
//
// Guardrails:
//   - Permission: finance.invoice.credit.
//   - confirm === true is verplicht (voorkomt accidental invocations).
//   - Globale dry-run: als isDryRunEnabled() true → NIETS boeken; wel
//     "would do"-summary + audit-log. Zelfde principe als wanbetalers-sandbox.
//   - Per-klant fail-soft: fout bij crediteren van een factuur brengt de rest
//     van de batch niet in gevaar; error wordt vastgelegd in de summary.
//
// Response:
// {
//   dry_run: boolean,
//   summary: {
//     total_customers,
//     credited_invoices,
//     extended_subscriptions,
//     skipped_no_invoices,
//     error_customers
//   },
//   customers: [{
//     customer_id, customer_name, credited:[{invoice_id, tl_credit_note_id}],
//     extended: { subscription_id, months, extended:true|false }|null,
//     errors: [{ scope: 'invoice'|'subscription'|'db', invoice_id?, message }]
//   }]
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';
import { creditInvoiceCore } from './_lib/invoice-credit.js';
import { postponeSubscription } from './_lib/subscription-postpone.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function quarterOf(dateIso) {
  const d = new Date(dateIso || Date.now());
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}
function openAmountEur(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid)  || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
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
  if (!rawItems || rawItems.length === 0) {
    return res.status(400).json({ error: 'items (array) verplicht' });
  }
  if (rawItems.length > 100) {
    return res.status(400).json({ error: 'Te veel klanten in één run (max 100)' });
  }

  // Validate + dedupe.
  const items = [];
  const seen = new Set();
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue;
    const cid = typeof it.customer_id === 'string' && UUID_RE.test(it.customer_id) ? it.customer_id : null;
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const sid = typeof it.subscription_id === 'string' && UUID_RE.test(it.subscription_id) ? it.subscription_id : null;
    items.push({ customer_id: cid, subscription_id: sid });
  }
  if (items.length === 0) return res.status(400).json({ error: 'Geen geldige items' });

  const dryRun = await isDryRunEnabled();
  const runAt   = new Date();
  const runIso  = runAt.toISOString();
  const runDate = runIso.slice(0, 10);
  const runQuarter = quarterOf(runIso);

  const summary = {
    total_customers        : items.length,
    credited_invoices      : 0,
    extended_subscriptions : 0,
    skipped_no_invoices    : 0,
    error_customers        : 0,
    dry_run                : dryRun,
  };
  const customersOut = [];

  for (const it of items) {
    const cid = it.customer_id;
    const wantSubId = it.subscription_id;
    const custEntry = {
      customer_id  : cid,
      customer_name: null,
      credited     : [],
      extended     : null,
      errors       : [],
      dry_run      : dryRun,
    };

    try {
      // A) Klant ophalen (met guard).
      const { data: cust } = await supabaseAdmin.from('customers')
        .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
        .eq('id', cid).maybeSingle();
      if (!cust) {
        custEntry.errors.push({ scope: 'customer', message: 'Klant niet gevonden' });
        summary.error_customers++;
        customersOut.push(custEntry);
        continue;
      }
      if (cust.archived_at || cust.anonymized_at || cust.is_test) {
        custEntry.errors.push({ scope: 'customer', message: 'Klant is gearchiveerd / anoniem / test' });
        summary.error_customers++;
        customersOut.push(custEntry);
        continue;
      }
      custEntry.customer_name = customerDisplayName(cust, '(zonder naam)');

      // B) Facturen ophalen die we mogen crediteren.
      const { data: invs } = await supabaseAdmin.from('invoices')
        .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, status, tl_invoice_id, is_test')
        .eq('customer_id', cid).in('status', OPEN_STATUSES).eq('is_test', false);
      const creditables = (invs || []).filter((iv) => {
        if (!iv.tl_invoice_id) return false;
        if (iv.status === 'concept') return false;
        if (openAmountEur(iv) <= 0) return false;
        return true;
      });
      if (creditables.length === 0) {
        summary.skipped_no_invoices++;
        customersOut.push(custEntry);
        continue;
      }

      // C) Crediteer per factuur — dry-run of live.
      const description = `Crediteerronde ${runQuarter}`;
      const successfullyCredited = [];
      for (const iv of creditables) {
        try {
          if (dryRun) {
            // Alleen "would do" — geen TL-call.
            custEntry.credited.push({
              invoice_id       : iv.id,
              invoice_number   : iv.invoice_number,
              open_amount      : r2(openAmountEur(iv)),
              vat_amount       : r2(Number(iv.vat_amount) || 0),
              tl_credit_note_id: null,
              dry_run          : true,
            });
            successfullyCredited.push({
              invoice_id       : iv.id,
              open_amount      : r2(openAmountEur(iv)),
              vat_amount       : r2(Number(iv.vat_amount) || 0),
              tl_credit_note_id: null,
            });
          } else {
            const result = await creditInvoiceCore(iv.id, { description, userId: user.id });
            custEntry.credited.push({
              invoice_id       : iv.id,
              invoice_number   : iv.invoice_number,
              open_amount      : r2(openAmountEur(iv)),
              vat_amount       : r2(Number(iv.vat_amount) || 0),
              tl_credit_note_id: result.tl_credit_note_id,
              dry_run          : false,
            });
            successfullyCredited.push({
              invoice_id       : iv.id,
              open_amount      : r2(openAmountEur(iv)),
              vat_amount       : r2(Number(iv.vat_amount) || 0),
              tl_credit_note_id: result.tl_credit_note_id,
            });
          }
        } catch (e) {
          custEntry.errors.push({
            scope     : 'invoice',
            invoice_id: iv.id,
            message   : e?.message || String(e),
            code      : e?.code || null,
          });
          // Ga door met volgende factuur — per-item fail-soft.
        }
      }
      summary.credited_invoices += successfullyCredited.length;

      // D) Sub verlengen — alleen als er iets gecrediteerd is (of dry-run).
      const nMonths = successfullyCredited.length;
      let didExtend = false;
      if (wantSubId && nMonths > 0) {
        try {
          // Verifieer dat het sub bij deze klant hoort via deal_id.
          const { data: sub } = await supabaseAdmin.from('subscriptions')
            .select('id, deal_id, description, amount, term_count, start_date, end_date, teamleader_subscription_id, postponed_months, original_start_date, original_end_date')
            .eq('id', wantSubId).maybeSingle();
          if (!sub) throw new Error('Abonnement niet gevonden');
          const { data: deal } = await supabaseAdmin.from('deals')
            .select('id, customer_id').eq('id', sub.deal_id).maybeSingle();
          if (!deal || deal.customer_id !== cid) {
            throw new Error('Abonnement hoort niet bij deze klant');
          }
          if (!sub.teamleader_subscription_id && !dryRun) {
            // Zonder TL-id kunnen we in prod-mode niet extenden. In dry-run
            // laten we het door zodat de UI de would-do state kan tonen.
            throw new Error('Abonnement heeft geen Teamleader-id — kan niet extenden');
          }
          if (dryRun) {
            custEntry.extended = {
              subscription_id: sub.id,
              months         : nMonths,
              extended       : true,
              dry_run        : true,
            };
            didExtend = true;
          } else {
            const { extended } = await postponeSubscription(sub, nMonths, { userId: user.id, req });
            custEntry.extended = {
              subscription_id: sub.id,
              months         : nMonths,
              extended       : !!extended,
              dry_run        : false,
            };
            didExtend = true;
          }
        } catch (e) {
          custEntry.errors.push({
            scope   : 'subscription',
            message : e?.message || String(e),
          });
        }
      }
      if (didExtend) summary.extended_subscriptions++;

      // E) dunning_credited_debt inserts — één rij per succesvol gecrediteerde
      //    factuur. In dry-run: SKIP (nothing persisted).
      if (!dryRun && successfullyCredited.length > 0) {
        try {
          const rows = successfullyCredited.map((sc) => ({
            customer_id       : cid,
            invoice_id        : sc.invoice_id,
            tl_credit_note_id : sc.tl_credit_note_id || null,
            amount_incl       : sc.open_amount,
            vat_amount        : sc.vat_amount,
            credited_on       : runDate,
            quarter           : runQuarter,
            subscription_id   : didExtend && custEntry.extended ? custEntry.extended.subscription_id : null,
            months_extended   : didExtend ? nMonths : 0,
            created_by        : user.id,
          }));
          const { error } = await supabaseAdmin.from('dunning_credited_debt').insert(rows);
          if (error) throw new Error(error.message);
        } catch (e) {
          custEntry.errors.push({ scope: 'db', message: 'dunning_credited_debt insert: ' + (e?.message || String(e)) });
        }
      }

      customersOut.push(custEntry);
    } catch (e) {
      custEntry.errors.push({ scope: 'customer', message: e?.message || String(e) });
      summary.error_customers++;
      customersOut.push(custEntry);
    }
  }

  // Aggregate audit-log entry — één regel per run, fail-soft.
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id     : user.id,
      action      : dryRun ? 'crediteer_ronde.dry_run' : 'crediteer_ronde.executed',
      entity_type : 'crediteer_ronde',
      entity_id   : null,
      after_json  : { summary, quarter: runQuarter, customer_count: items.length },
      reason_text : `Crediteerronde ${runQuarter} — ${items.length} klant(en), ${summary.credited_invoices} facturen ${dryRun ? '(dry-run)' : 'gecrediteerd'}`,
      ip_address  : getClientIp(req),
    });
  } catch (e) { console.error('[crediteer-ronde-execute] audit', e?.message || e); }

  return res.status(200).json({
    dry_run  : dryRun,
    summary,
    customers: customersOut,
  });
}
