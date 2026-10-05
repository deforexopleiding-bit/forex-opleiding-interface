// api/_lib/onboarding-intake-items.js
//
// DE STARTSTATUS PER ONBOARDING, uit de sessies in het LMS — één afleiding
// voor twee lezers:
//   - api/onboarding-intake-status.js (het CRM-scherm, lazy na de lijst);
//   - api/lms-onboarding-overzicht.js (het LMS-overzicht van de hoofdmentor).
//
// Verhuisd uit onboarding-intake-status.js (5 oktober 2026), zonder
// gedragswijziging.

import { haalSessieOverzichtPerStudent, BRON_GELEZEN } from './dfo-lms-sessies.js';
import { deriveIntakeStatus } from './intake-status.js';

/**
 * @param {Array<{id, mentor_user_id, bubble_user_id, dfo_lms_student_id, mentor_intake_status}>} visible
 * @returns {Promise<{ bron_status: string, fout: string|null, items: object[] }>}
 */
export async function intakeItemsVoor(visible) {
  // 2) Sessie-overzicht per student, RECHTSTREEKS uit het LMS.
  //
  // De vorige versie haalde de sessies per MENTOR uit Bubble en zocht de
  // student daarin op. Dat had twee problemen: de mentoren werken sinds
  // augustus 2026 in het LMS (dus Bubble is leeg), en een student van een
  // mentor zonder Bubble-koppeling viel sowieso buiten beeld.
  //
  // We kijken nu per STUDENT, via onboardings.bubble_user_id →
  // hlms_student.bubble_user_id. Die brug is gemeten aanwezig: 299 van de
  // 304 studentrijen dragen 'm, en die waarden zijn uniek.
  const bubbleIds = visible.map((r) => r.bubble_user_id).filter(Boolean);
  // De tweede brug: het LMS-student-id, voor wie geen Bubble-id heeft.
  const lmsIds = visible.filter((r) => !r.bubble_user_id).map((r) => r.dfo_lms_student_id).filter(Boolean);
  const bron = await haalSessieOverzichtPerStudent({ bubbleUserIds: bubbleIds, lmsStudentIds: lmsIds });

  const bronGelezen = bron.bron_status === BRON_GELEZEN;
  if (!bronGelezen) {
    console.warn('[onboarding-intake-status] sessies niet gelezen ('
      + bron.bron_status + '): ' + (bron.fout || 'reden onbekend'));
  }

  // 3) Per zichtbare onboarding → afleiden.
  const items = visible.map((r) => {
    const bu = r.bubble_user_id ? String(r.bubble_user_id) : null;
    const lid = r.dfo_lms_student_id ? String(r.dfo_lms_student_id) : null;
    const v  = !bronGelezen ? null
      : bu ? (bron.perStudent.get(bu) || null)
      : lid ? (bron.perLmsStudent?.get(lid) || null)
      : null;
    const plannedIso = v?.next   || null;
    const doneIso    = v?.done   || null;
    const noshowIso  = v?.noshow || null;

    // KON DE BRON NIET GELEZEN WORDEN, dan leiden we NIETS af.
    // Zouden we dat wel doen, dan komt elke student op 'nog_te_benaderen'
    // (rang 4) en dus BOVENAAN de probleemlijst — ook iemand die dertien
    // sessies achter de rug heeft. Dat is niet leeg maar onwaar, en het
    // zet iemand tot een verkeerde handeling aan: bellen wie al lang bezig
    // is. Liever geen status dan een verzonnen status; de aanroeper houdt
    // dan gewoon zijn vorige waarde.
    const intake = bronGelezen
      ? deriveIntakeStatus({
          hasCompletedSession:  !!doneIso,
          hasMentor:            !!r.mentor_user_id,
          mentor_intake_status: r.mentor_intake_status || null,
          hasNoshow:            !!noshowIso,
          hasFutureCall:        !!plannedIso,
        })
      : null;

    return {
      onboarding_id:     r.id,
      intake_status:     intake,
      planned_call_at:   plannedIso,
      last_completed_at: doneIso,
      last_noshow_at:    noshowIso,
    };
  });

  return { bron_status: bron.bron_status, fout: bronGelezen ? null : (bron.fout || 'reden onbekend'), items };
}
