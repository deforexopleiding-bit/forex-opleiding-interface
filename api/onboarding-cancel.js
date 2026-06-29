// api/onboarding-cancel.js
//
// POST — Annulering-orchestrator voor een student. Twee modi:
//
//   PREVIEW : { onboarding_id, preview:true }
//     Voert GEEN TL/Bubble/DB-mutaties uit. Verzamelt en returnt:
//       customer_name, invoices[], subscriptions[], subscription_value (€),
//       offertes[], bubble_user_id, already_cancelled.
//
//   EXECUTE : { onboarding_id, reason, confirm:true }
//     Draait de cascade. Volgorde:
//       a) facturen crediteren (per non-paid + non-concept + niet-volledig-gecredite factuur)
//       b) abonnement(en) deactiveren (TL subscriptions.deactivate + lokaal status='cancelled')
//       c) offerte/deal annuleren (TL quotations.delete + deals.lose best-effort + lokaal archived_at)
//       d) Bubble: membership_end_date_date = gisteren + login_student_boolean = false
//       e) onboardings.status = 'geannuleerd'
//       f) insert onboarding_cancellations (snapshot subscription_value + steps jsonb)
//       g) mentor_notification (kind:'cancelled') — fail-soft
//     Elke stap zit in try/catch; één falende stap stopt de cascade NIET. Alle
//     resultaten landen in `steps` zodat de UI kan tonen wat wel/niet lukte.
//
// Permission: getOnboardingScope.seesAll (manager/super_admin/admin). Mentor → 403.
//
// IDEMPOTENT — KRITIEK: is de onboarding al 'geannuleerd' → return
// { already_cancelled:true } ZONDER opnieuw TL/Bubble/DB te raken. Voorkomt
// dubbele credits, dubbele Bubble-patches en spook-cancellation-records.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { bubblePatch } from './_lib/bubble.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tlCall(path, body, attempt = 0) {
  await sleep(150);
  const r = await tlFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 429 && attempt < 3) {
    await sleep(2000 * Math.pow(2, attempt));
    return tlCall(path, body, attempt + 1);
  }
  return r;
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length > 0) {
    return lines.reduce((sum, li) =>
      sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

function yesterdayIsoUtc() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Welke facturen crediteren we?
//   - status NIET 'concept'  (creditten kan niet, finance-invoice-credit weigert 409)
//   - status NIET 'paid'     (al volledig betaald — crediteren = onnodige boekhoud-actie)
//   - credited_amount < amount_total (niet al volledig gecrediteerd; voorkomt dubbele credits ook
//     wanneer de orchestrator twee keer ongelukkig aangeroepen wordt op een rij die net door een
//     andere admin handmatig is gecrediteerd)
function shouldCreditInvoice(inv) {
  const status = String(inv?.status || '').toLowerCase();
  if (!status) return false;
  if (status === 'concept' || status === 'paid') return false;
  const total    = Number(inv?.amount_total)    || 0;
  const credited = Number(inv?.credited_amount) || 0;
  if (total <= 0) return false;
  if (credited + 0.01 >= total) return false; // 1ct tolerantie (consistent met arrangements-propose)
  return true;
}

async function gatherContext(onboardingId) {
  // 1) onboarding zelf
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('onboardings')
    .select('id, customer_id, customer_name, mentor_user_id, bubble_user_id, status')
    .eq('id', onboardingId)
    .maybeSingle();
  if (obErr) throw new Error('onboarding fetch: ' + obErr.message);
  if (!ob) return { ob: null };
  const customerId = ob.customer_id || null;

  // 2) facturen — alle van deze klant, te crediteren = subset.
  let invoices = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('invoices')
      .select('id, tl_invoice_id, invoice_number, amount_total, credited_amount, status')
      .eq('customer_id', customerId)
      .limit(500);
    if (error) throw new Error('invoices fetch: ' + error.message);
    invoices = (data || []).filter(shouldCreditInvoice);
  }

  // 3) abonnementen — actief (status != 'cancelled').
  let subscriptions = [];
  if (customerId) {
    // Subscriptions koppelen via deal → customer. Variant op sales-subscriptions-list.
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id')
      .eq('customer_id', customerId)
      .limit(200);
    const dealIds = (deals || []).map((d) => d.id);
    if (dealIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, amount, vat_percentage, term_count, status, teamleader_subscription_id, line_items')
        .in('deal_id', dealIds)
        .neq('status', 'cancelled')
        .limit(200);
      if (subErr) throw new Error('subscriptions fetch: ' + subErr.message);
      subscriptions = subs || [];
    }
  }

  // 4) offertes/deals — niet al-gearchiveerde.
  let deals = [];
  if (customerId) {
    const { data, error } = await supabaseAdmin
      .from('deals')
      .select('id, tl_deal_id, tl_quotation_id, tl_quotation_reference, archived_at')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .limit(200);
    if (error) throw new Error('deals fetch: ' + error.message);
    deals = data || [];
  }

  const subscription_value = r2(
    subscriptions.reduce((sum, s) => sum + inclPerTerm(s), 0),
  );

  return { ob, invoices, subscriptions, deals, subscription_value };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Manager/super_admin (seesAll) — mentor/view_own krijgt 403. Een annulering
  // is onomkeerbaar; ALLEEN admin-rolhouders mogen 'm starten.
  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (manager/super_admin/admin vereist).' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) {
    return res.status(400).json({ error: 'onboarding_id (uuid) is verplicht.' });
  }
  const isPreview = body.preview === true;
  const isExecute = body.confirm === true;
  if (!isPreview && !isExecute) {
    return res.status(400).json({ error: 'Geef preview:true of confirm:true mee.' });
  }
  if (isPreview && isExecute) {
    return res.status(400).json({ error: 'preview en confirm zijn wederzijds exclusief.' });
  }

  try {
    const ctx = await gatherContext(onboardingId);
    if (!ctx.ob) return res.status(404).json({ error: 'Onboarding niet gevonden.' });

    const alreadyCancelled = String(ctx.ob.status || '').toLowerCase() === 'geannuleerd';

    // ── PREVIEW ────────────────────────────────────────────────────────────
    if (isPreview) {
      return res.status(200).json({
        preview:             true,
        already_cancelled:   alreadyCancelled,
        customer_name:       ctx.ob.customer_name || null,
        bubble_user_id:      ctx.ob.bubble_user_id || null,
        invoices: ctx.invoices.map((i) => ({
          id:             i.id,
          tl_invoice_id:  i.tl_invoice_id,
          invoice_number: i.invoice_number,
          amount_total:   r2(i.amount_total),
          credited_amount: r2(i.credited_amount || 0),
          status:         i.status,
          will_credit:    true,
        })),
        subscriptions: ctx.subscriptions.map((s) => ({
          id:                          s.id,
          teamleader_subscription_id:  s.teamleader_subscription_id,
          description:                 s.description,
          amount_incl:                 r2(inclPerTerm(s)),
          status:                      s.status,
        })),
        subscription_value: ctx.subscription_value,
        offertes: ctx.deals.map((d) => ({
          id:                     d.id,
          tl_deal_id:             d.tl_deal_id,
          tl_quotation_id:        d.tl_quotation_id,
          tl_quotation_reference: d.tl_quotation_reference,
        })),
      });
    }

    // ── EXECUTE ────────────────────────────────────────────────────────────
    // KRITIEKE GUARD: al gecanceld → niets doen. Voorkomt dubbele credits /
    // Bubble-patches / cancellation-records bij retries of dubbel-klikken.
    if (alreadyCancelled) {
      return res.status(200).json({
        ok:                true,
        already_cancelled: true,
      });
    }

    const reasonRaw = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (!reasonRaw) return res.status(400).json({ error: 'reason is verplicht bij execute.' });
    const reason = reasonRaw.slice(0, 2000);

    const steps = {
      invoices_credit:        { ok: false, results: [] },
      subscriptions_deactivate: { ok: false, results: [] },
      offertes_cancel:        { ok: false, results: [] },
      bubble_membership_end:  { ok: false },
      onboarding_status:      { ok: false },
      cancellation_record:    { ok: false },
      notify_mentor:          { ok: false },
    };

    // a) Facturen crediteren — per factuur try/catch, falende factuur stopt
    //    de loop NIET (anderen worden alsnog gecrediteerd).
    {
      const out = [];
      let allOk = true;
      for (const inv of ctx.invoices) {
        const rec = { invoice_id: inv.id, invoice_number: inv.invoice_number, tl_invoice_id: inv.tl_invoice_id || null };
        try {
          if (!inv.tl_invoice_id) { rec.ok = false; rec.error = 'geen TL-id'; allOk = false; out.push(rec); continue; }
          const r = await tlCall('/invoices.credit', { id: inv.tl_invoice_id, description: 'Onboarding annulering' });
          if (!r.ok) {
            const txt = await r.text().catch(() => '');
            rec.ok = false;
            rec.error = `TL HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
            allOk = false;
          } else {
            let creditId = null;
            try { creditId = (await r.json())?.data?.id || null; } catch {}
            rec.ok = true;
            rec.tl_credit_note_id = creditId;
          }
        } catch (e) {
          rec.ok = false;
          rec.error = e?.message || String(e);
          allOk = false;
        }
        out.push(rec);
      }
      steps.invoices_credit = { ok: allOk, results: out };
    }

    // b) Abonnement(en) deactiveren — TL + lokaal status='cancelled'.
    {
      const out = [];
      let allOk = true;
      for (const sub of ctx.subscriptions) {
        const rec = { subscription_id: sub.id, teamleader_subscription_id: sub.teamleader_subscription_id || null };
        try {
          if (sub.teamleader_subscription_id) {
            const r = await tlCall('/subscriptions.deactivate', { id: sub.teamleader_subscription_id });
            if (!r.ok) {
              const txt = await r.text().catch(() => '');
              rec.tl_ok = false;
              rec.tl_error = `HTTP ${r.status}: ${(txt || '').slice(0, 200)}`;
              // Geen TL-deactivatie maar wel doorgaan met lokaal stopzetten
              // (consistent met sales-subscription-delete force-pad).
            } else {
              rec.tl_ok = true;
            }
          } else {
            rec.tl_skipped = true;
          }
          const { error: upErr } = await supabaseAdmin
            .from('subscriptions')
            .update({ status: 'cancelled' })
            .eq('id', sub.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
          if (rec.tl_ok === false) allOk = false;
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.subscriptions_deactivate = { ok: allOk, results: out };
    }

    // c) Offertes/deals annuleren — TL best-effort + lokaal archived_at.
    {
      const out = [];
      let allOk = true;
      const tlTok = await getActiveToken().catch(() => null);
      for (const deal of ctx.deals) {
        const rec = { deal_id: deal.id, tl_deal_id: deal.tl_deal_id || null, tl_quotation_id: deal.tl_quotation_id || null };
        try {
          if (tlTok && deal.tl_quotation_id) {
            try {
              const r = await tlCall('/quotations.delete', { id: deal.tl_quotation_id });
              rec.tl_quotation_ok = r.ok;
              if (!r.ok) rec.tl_quotation_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_quotation_ok = false; rec.tl_quotation_error = e?.message || String(e); }
          }
          if (tlTok && deal.tl_deal_id) {
            try {
              const r = await tlCall('/deals.lose', { id: deal.tl_deal_id });
              rec.tl_deal_ok = r.ok;
              if (!r.ok) rec.tl_deal_error = `HTTP ${r.status}`;
            } catch (e) { rec.tl_deal_ok = false; rec.tl_deal_error = e?.message || String(e); }
          }
          const nowIso = new Date().toISOString();
          const { error: upErr } = await supabaseAdmin
            .from('deals')
            .update({ archived_at: nowIso, tl_quotation_declined_at: nowIso })
            .eq('id', deal.id);
          if (upErr) { rec.local_ok = false; rec.local_error = upErr.message; allOk = false; }
          else       { rec.local_ok = true;  rec.ok = true; }
        } catch (e) {
          rec.ok = false; rec.error = e?.message || String(e); allOk = false;
        }
        out.push(rec);
      }
      steps.offertes_cancel = { ok: allOk, results: out };
    }

    // d) Bubble: einddatum gisteren + login uit. Fail-soft.
    if (ctx.ob.bubble_user_id) {
      try {
        const endIso = yesterdayIsoUtc();
        await bubblePatch('user', ctx.ob.bubble_user_id, {
          membership_end_date_date: endIso,
          login_student_boolean:    false,
        });
        steps.bubble_membership_end = { ok: true, end_date: endIso };
      } catch (e) {
        steps.bubble_membership_end = { ok: false, error: e?.message || String(e) };
      }
    } else {
      steps.bubble_membership_end = { ok: true, skipped: true, reason: 'geen-bubble-user-id' };
    }

    // e) onboardings.status='geannuleerd'.
    try {
      const { error: upErr } = await supabaseAdmin
        .from('onboardings')
        .update({ status: 'geannuleerd' })
        .eq('id', onboardingId);
      if (upErr) throw new Error(upErr.message);
      steps.onboarding_status = { ok: true };
    } catch (e) {
      steps.onboarding_status = { ok: false, error: e?.message || String(e) };
    }

    // f) Cancellation-record met snapshot. KRITIEK voor audit + omzet-impact.
    let cancellationId = null;
    try {
      const { data: rec, error: insErr } = await supabaseAdmin
        .from('onboarding_cancellations')
        .insert({
          onboarding_id:      onboardingId,
          customer_id:        ctx.ob.customer_id || null,
          customer_name:      ctx.ob.customer_name || null,
          cancelled_by:       user.id,
          reason,
          subscription_value: ctx.subscription_value,
          steps,
        })
        .select('id')
        .single();
      if (insErr) throw new Error(insErr.message);
      cancellationId = rec?.id || null;
      steps.cancellation_record = { ok: true, id: cancellationId };
    } catch (e) {
      steps.cancellation_record = { ok: false, error: e?.message || String(e) };
    }

    // g) Mentor-melding (fail-soft).
    if (ctx.ob.mentor_user_id) {
      try {
        await supabaseAdmin
          .from('mentor_notifications')
          .insert({
            mentor_user_id: ctx.ob.mentor_user_id,
            onboarding_id:  onboardingId,
            kind:           'cancelled',
            title:          'Student geannuleerd',
            body:           (ctx.ob.customer_name || 'De student') + ' is geannuleerd. Reden: ' + reason,
            created_by:     user.id,
          });
        steps.notify_mentor = { ok: true };
      } catch (e) {
        steps.notify_mentor = { ok: false, error: e?.message || String(e) };
      }
    } else {
      steps.notify_mentor = { ok: true, skipped: true, reason: 'geen-mentor' };
    }

    return res.status(200).json({
      ok:              true,
      cancellation_id: cancellationId,
      subscription_value: ctx.subscription_value,
      steps,
    });
  } catch (e) {
    console.error('[onboarding-cancel]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
