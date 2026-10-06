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
//       h) lopende onboarding-automaties stoppen (sinds 6 okt 2026)
//       i) LMS-toegang dicht: hlms_student.eind_datum op gisteren (sinds 6 okt 2026)
//     De uitvoering staat in api/_lib/onboarding-annuleren.js, gedeeld met de
//     knop in het LMS (api/lms-onboarding-annuleren.js).
//     Elke stap zit in try/catch; één falende stap stopt de cascade NIET. Alle
//     resultaten landen in `steps` zodat de UI kan tonen wat wel/niet lukte.
//
// Permission: getOnboardingScope.seesAll (manager/super_admin/admin). Mentor → 403.
//
// IDEMPOTENT — KRITIEK: is de onboarding al 'geannuleerd' → return
// { already_cancelled:true } ZONDER opnieuw TL/Bubble/DB te raken. Voorkomt
// dubbele credits, dubbele Bubble-patches en spook-cancellation-records.

import { createUserClient } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';
import { gatherContext, voerAnnuleringUit } from './_lib/onboarding-annuleren.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length > 0) {
    return lines.reduce((sum, li) =>
      sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100), 0);
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
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
          tl_quotation_reference: d.quote_reference,
        })),
      });
    }

    // ── EXECUTE ────────────────────────────────────────────────────────────
    // De cascade staat sinds 6 oktober 2026 in api/_lib/onboarding-annuleren.js,
    // gedeeld met de knop in het LMS. Zelfde stappen, plus: lopende
    // automaties stoppen en de LMS-toegang dicht (Maxim).
    const { status, body: uit } = await voerAnnuleringUit({
      onboardingId,
      reden: body.reason,
      doorUserId: user.id,
      doorLabel: String(user.email || user.id),
      via: 'crm',
    });
    return res.status(status).json(uit);
  } catch (e) {
    console.error('[onboarding-cancel]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
