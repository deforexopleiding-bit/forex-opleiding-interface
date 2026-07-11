// api/wanbetalers-sandbox-simulate-credit-round.js
//
// POST → simuleer de crediteerronde end-to-end op de is_test-persoon.
// Geen TL-calls, geen aanraking van finance-invoice-credit of
// crediteer-ronde-execute. Puur DB-mutaties op is_test-rijen, zodat
// Jeffrey de PR-3 zichtbaarheid ("gecrediteerd"-badge, credit-sectie,
// PDF-blok) kan testen zonder productie-risico.
//
// Guardrails:
//   - Super_admin only.
//   - Werkt UITSLUITEND op de sandbox-test-persoon (customers.is_test=true
//     via getSandboxCustomer). Bij ontbreken → 404.
//   - Alle geraakte facturen moeten is_test=true zijn — dubbele guard.
//   - Nooit een TL-call. Geen creditInvoiceCore, geen postponeSubscription.
//   - Marker in de creditnote-id ('sim:credit:' + invoice.id) zodat je in
//     de DB kunt herkennen dat dit een simulatie was.
//
// Flow per klant (test-persoon):
//   1) Open+is_test-facturen ophalen (status open/partially_paid/overdue,
//      met openbedrag > 0).
//   2) Per factuur: credited_amount = amount_total − amount_paid → open→0.
//   3) Test-sub (customer_id=test-klant, description='TEST-abonnement')
//      lokaal verlengen: end_date += N mnd, term_count += N,
//      postponed_months += N (N = aantal succesvol gecrediteerde facturen).
//   4) Insert dunning_credited_debt-rijen per gecrediteerde factuur.
//
// Response: {
//   customer_id, credited: [{ invoice_id, invoice_number, open_amount,
//     vat_amount, tl_credit_note_id: 'sim:credit:...'}],
//   months_extended, subscription_id, debt_rows_inserted, summary
// }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin, getSandboxCustomer, isSandboxCustomer } from './_lib/wanbetalers-sandbox.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
function quarterOf(dateIso) {
  const d = new Date(dateIso || Date.now());
  const q = Math.floor(d.getMonth() / 3) + 1;
  return `${d.getFullYear()}-Q${q}`;
}
function addMonthsStr(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return null;
  d.setMonth(d.getMonth() + Number(n));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    // 1) Test-persoon ophalen. Fail als er geen is_test-klant is.
    const customer = await getSandboxCustomer();
    if (!customer || !isSandboxCustomer(customer)) {
      return res.status(404).json({ error: 'Geen sandbox-test-persoon gevonden — draai eerst de seed.' });
    }
    const cid = customer.id;

    // 2) Open + is_test-facturen ophalen. Extra defensieve check op
    //    is_test op factuur-niveau — mocht er een edge case zijn waarbij
    //    een niet-test-factuur toch aan een test-klant hangt, dan crediteren
    //    we die absoluut niet.
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, status, tl_invoice_id, is_test')
      .eq('customer_id', cid)
      .in('status', OPEN_STATUSES);
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);
    const creditable = (invRows || []).filter((iv) => {
      if (iv.is_test !== true) return false; // extra guard: nooit non-test aanraken
      return openAmountEur(iv) > 0;
    });

    if (creditable.length === 0) {
      return res.status(200).json({
        ok               : true,
        simulated        : true,
        customer_id      : cid,
        credited         : [],
        months_extended  : 0,
        subscription_id  : null,
        debt_rows_inserted: 0,
        message          : 'Geen te crediteren test-facturen (test-persoon heeft geen open bedragen).',
      });
    }

    // 3) Lokaal crediteren — per factuur credited_amount ophogen.
    const runAt   = new Date();
    const runIso  = runAt.toISOString();
    const runDate = runIso.slice(0, 10);
    const runQuarter = quarterOf(runIso);
    const credited = [];
    for (const iv of creditable) {
      const openEur = openAmountEur(iv);
      const currentCred = Number(iv.credited_amount) || 0;
      const paid        = Number(iv.amount_paid)     || 0;
      const total       = Number(iv.amount_total)    || 0;
      // credited_amount = amount_total - amount_paid → open=0. Ook eerdere
      // gedeeltelijke credits worden meegenomen (max met huidige waarde).
      const newCred = r2(Math.max(currentCred, total - paid));
      const simCreditId = 'sim:credit:' + iv.id;
      try {
        const { error: upErr } = await supabaseAdmin.from('invoices')
          .update({ credited_amount: newCred, updated_at: new Date().toISOString() })
          .eq('id', iv.id)
          .eq('is_test', true); // extra runtime-guard: alleen is_test-rijen updaten
        if (upErr) throw new Error(upErr.message);
        credited.push({
          invoice_id       : iv.id,
          invoice_number   : iv.invoice_number,
          open_amount      : r2(openEur),
          vat_amount       : r2(Number(iv.vat_amount) || 0),
          tl_credit_note_id: simCreditId,
        });
      } catch (e) {
        console.warn('[sandbox-simulate-credit-round] factuur update soft-fail:', e?.message || e);
      }
    }

    // 4) Test-sub lokaal verlengen. Zoek op description (unieke identifier
    //    binnen deze sandbox), NIET op is_test — die kolom bestaat mogelijk
    //    niet. Zonder test-sub → skip verlenging (return N=0).
    let subscriptionId = null;
    let monthsExtended = 0;
    if (credited.length > 0) {
      const { data: sub } = await supabaseAdmin.from('subscriptions')
        .select('id, customer_id, description, term_count, end_date, postponed_months, teamleader_subscription_id')
        .eq('customer_id', cid).eq('description', 'TEST-abonnement').maybeSingle();
      if (sub) {
        // Defensief: nooit iets doen als er per ongeluk een TL-id aanhangt.
        if (sub.teamleader_subscription_id) {
          console.warn('[sandbox-simulate-credit-round] test-sub heeft teamleader_subscription_id — verlenging overgeslagen.');
        } else {
          const N = credited.length;
          const newEnd    = sub.end_date ? addMonthsStr(sub.end_date, N) : null;
          const newCount  = (Number(sub.term_count) || 0) + N;
          const newPostp  = (Number(sub.postponed_months) || 0) + N;
          const { error: subErr } = await supabaseAdmin.from('subscriptions').update({
            end_date        : newEnd,
            term_count      : newCount,
            postponed_months: newPostp,
          }).eq('id', sub.id);
          if (subErr) {
            console.warn('[sandbox-simulate-credit-round] sub update soft-fail:', subErr.message);
          } else {
            subscriptionId = sub.id;
            monthsExtended = N;
          }
        }
      }
    }

    // 5) dunning_credited_debt-rijen inserten. Fail-soft — als de tabel
    //    ontbreekt (migratie 039 nog niet gedraaid) valt dit weg zonder
    //    de test-crediteringen te blokkeren.
    let debtRowsInserted = 0;
    if (credited.length > 0) {
      try {
        const rows = credited.map((c) => ({
          customer_id       : cid,
          invoice_id        : c.invoice_id,
          tl_credit_note_id : c.tl_credit_note_id,
          amount_incl       : c.open_amount,
          vat_amount        : c.vat_amount,
          credited_on       : runDate,
          quarter           : runQuarter,
          subscription_id   : subscriptionId,
          months_extended   : monthsExtended,
          created_by        : admin.user.id,
        }));
        const { data: ins, error: insErr } = await supabaseAdmin
          .from('dunning_credited_debt').insert(rows).select('id');
        if (insErr) throw new Error(insErr.message);
        debtRowsInserted = (ins || []).length;
      } catch (e) {
        console.warn('[sandbox-simulate-credit-round] debt insert soft-fail:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok                 : true,
      simulated          : true,
      customer_id        : cid,
      credited,
      months_extended    : monthsExtended,
      subscription_id    : subscriptionId,
      debt_rows_inserted : debtRowsInserted,
      quarter            : runQuarter,
      summary: {
        invoices_credited : credited.length,
        months_extended   : monthsExtended,
        debt_rows_inserted: debtRowsInserted,
      },
    });
  } catch (e) {
    console.error('[sandbox-simulate-credit-round]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
