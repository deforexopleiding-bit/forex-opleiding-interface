// api/onboarding-cancel.js
//
// POST — Annulering-orchestrator voor een student. Twee modi:
//
//   PREVIEW : { onboarding_id, preview:true }
//     Voert GEEN TL/LMS/DB-mutaties uit. Verzamelt en returnt:
//       customer_name, invoices[], subscriptions[], subscription_value (€),
//       offertes[], lms_student_id, already_cancelled.
//
//   EXECUTE : { onboarding_id, reason, confirm:true }
//     Draait de cascade. Volgorde:
//       a) facturen crediteren (per non-paid + non-concept + niet-volledig-gecredite factuur)
//       b) abonnement(en) deactiveren (TL subscriptions.deactivate + lokaal status='cancelled')
//       c) offerte/deal annuleren (TL quotations.delete + deals.lose best-effort + lokaal archived_at)
//       d) (vervallen 9 okt 2026 — Bubble gaat dicht; zie stap i)
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
import { gatherContext, voerAnnuleringUit, annuleringVoorbeeld, sluitOnboardingVanGeannuleerdeStudent } from './_lib/onboarding-annuleren.js';
import { accountNaAnnulering, verwijderLmsAccount } from './_lib/lms-account-verwijderen.js';

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
  // ACCOUNT VERWIJDEREN VAN EEN AL GEANNULEERDE STUDENT (2 nov 2026):
  // { onboarding_id, actie: 'account_verwijderen', reason } — alleen als de
  // onboarding (of de student op een ander niveau) al geannuleerd is.
  if (body.actie === 'account_verwijderen') {
    const reden = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reden.length < 5) return res.status(400).json({ error: 'Geef een reden (minstens 5 tekens).', code: 'reden_verplicht' });
    try {
      const v = await annuleringVoorbeeld(onboardingId);
      if (!v) return res.status(404).json({ error: 'Onboarding niet gevonden.' });
      if (!v.already_cancelled) {
        return res.status(409).json({ error: 'Deze student is nog niet geannuleerd: annuleer eerst (met "Account ook verwijderen").', code: 'niet_geannuleerd' });
      }
      if (!v.lms_student_id) return res.status(422).json({ error: 'Geen LMS-account gekoppeld: er is niets te verwijderen.', code: 'geen_lms_student' });
      // Staat deze onboarding zelf nog open (de student werd via het dossier
      // geannuleerd), dan gaat ze eerst mee dicht.
      const dicht = await sluitOnboardingVanGeannuleerdeStudent(onboardingId, user.id);
      if (!dicht.ok) return res.status(422).json({ error: 'De onboarding kon niet mee dicht: ' + (dicht.error || dicht.code) + '. Er is niets verwijderd.', code: 'onboarding_niet_dicht' });
      const uit = await verwijderLmsAccount({ studentId: v.lms_student_id, reden: 'Geannuleerd: ' + reden, door: String(user.email || user.id) + ' via het CRM' });
      return res.status(uit.ok ? 200 : 422).json({ ok: uit.ok, account_verwijderen: uit, ...(uit.ok ? {} : { error: uit.message }) });
    } catch (e) {
      console.error('[onboarding-cancel] account verwijderen', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
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
        lms_student_id:      ctx.ob.dfo_lms_student_id || null,
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
    // ACCOUNT OOK VERWIJDEREN (2 nov 2026): dezelfde regel als het dossier en
    // Hoofdmentor › Onboarding — standaard aan in het venster, pas NA een
    // geslaagde annulering, nooit bij incasso. Ook als de student al
    // geannuleerd was (dan gebeurde er verder niets opnieuw).
    if (body.account_verwijderen === true) {
      const studentId = uit?.steps?.lms_student_id || uit?.eerdere?.steps?.lms_student_id || ctx.ob.dfo_lms_student_id || null;
      uit.account_verwijderen = await accountNaAnnulering({
        annuleringGeslaagd: status >= 200 && status < 300 && uit?.ok === true,
        incasso: false,
        studentId,
        reden: String(body.reason || ''),
        door: String(user.email || user.id) + ' via het CRM',
      });
    }
    return res.status(status).json(uit);
  } catch (e) {
    console.error('[onboarding-cancel]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
