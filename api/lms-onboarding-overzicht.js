// api/lms-onboarding-overzicht.js
//
// Machine-route voor het LMS (dfo-lms): HET ONBOARDINGOVERZICHT, LIVE.
// Server-naar-server, GEEN CORS — het geheim mag nooit in een browser.
//
//   GET  → { ok, code:'ok', message, data: { rows, mentoren, intake_bron_status, gelezen_op } }
//
// Auth: header `x-dfo-secret` = DFO_LMS_PUSH_SECRET of DFO_LMS_AGENDA_SECRET
// (dezelfde regel als api/lms-onboarding-sessie.js). Geen van beide → 503.
//
// ── WAAROM LIVE EN GEEN KOPIE ────────────────────────────────────────────
// Hoofdmentor > Onboarding in het LMS moet EXACT tonen wat het CRM-overzicht
// toont, en een wijziging aan de ene kant moet binnen een minuut aan de
// andere kant staan. Een kopietabel loopt altijd een stap achter (de spiegel
// draait per schrijfactie + om 07:20, en drie schrijfpaden slaan hem over).
// Deze route gebruikt dezelfde bouwer als het CRM-scherm
// (api/_lib/onboarding-overzicht-rijen.js) en dezelfde startstatus-afleiding
// (api/_lib/onboarding-intake-items.js) — dus dezelfde rijen, op het moment
// van vragen. Het CRM blijft de enige bron van waarheid.
//
// ALLEEN LEZEN. Schrijven gaat via api/lms-onboarding-sessie.js.

import { machineToegang } from './lms-onboarding-sessie.js';
import { bouwOverzichtRijen } from './_lib/onboarding-overzicht-rijen.js';
import { intakeItemsVoor } from './_lib/onboarding-intake-items.js';
import { mentorenMetLmsId } from './_lib/lms-mentor-brug.js';

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const toegang = machineToegang(req.headers['x-dfo-secret']);
  if (toegang === 'niet_geconfigureerd') {
    return antwoord(res, 503, false, 'niet_geconfigureerd', 'De onboardingbrug is niet geconfigureerd.');
  }
  if (toegang !== 'ok') {
    return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang tot de onboardingbrug.');
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET is toegestaan.');
  }

  try {
    const [rows, mentoren] = await Promise.all([
      bouwOverzichtRijen({ scope: 'active' }),
      mentorenMetLmsId(),
    ]);

    // DE STARTSTATUS UIT DE SESSIES — dezelfde aanvulling die het CRM-scherm
    // lazy doet. Kon de bron niet gelezen worden, dan blijft de afgeleide uit
    // de databank staan en zegt `intake_bron_status` dat.
    const intake = await intakeItemsVoor(rows.map((r) => ({
      id: r.id,
      mentor_user_id: r.mentor_user_id,
      bubble_user_id: r.bubble_user_id,
      dfo_lms_student_id: r.dfo_lms_student_id,
      mentor_intake_status: r.mentor_intake_status,
    })));
    const perId = new Map(intake.items.map((i) => [i.onboarding_id, i]));
    const lmsIdVan = new Map(mentoren.map((m) => [m.user_id, m.lms_id]));

    const verrijkt = rows.map((r) => {
      const i = perId.get(r.id) || null;
      return {
        ...r,
        intake_status: i?.intake_status ?? r.intake_status,
        planned_call_at: i?.planned_call_at ?? null,
        last_completed_at: i?.last_completed_at ?? null,
        last_noshow_at: i?.last_noshow_at ?? null,
        // De mentor zoals het LMS hem kent; `null` = geen mentor of niet te vertalen.
        mentor_lms_id: r.mentor_user_id ? (lmsIdVan.get(r.mentor_user_id) ?? null) : null,
        // Het betaal-token hoort niet in het LMS.
        token: undefined,
      };
    });

    return antwoord(res, 200, true, 'ok', 'Het onboardingoverzicht, live uit het CRM.', {
      rows: verrijkt,
      mentoren,
      intake_bron_status: intake.bron_status,
      gelezen_op: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[lms-onboarding-overzicht]', e?.message || e);
    return antwoord(res, 500, false, 'fout', 'Het overzicht kon in het CRM niet opgebouwd worden.');
  }
}
