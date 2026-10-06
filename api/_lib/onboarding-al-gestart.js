// api/_lib/onboarding-al-gestart.js
//
// "WAARSCHIJNLIJK AL GESTART" — het bewijs per onboarding (Maxim, 6 okt 2026).
//
// Aanleiding: BV Ky en Rahim Gusani (mentor Seppe) stonden nog "in onboarding"
// terwijl hun traject al liep. De automatische afsluiting kijkt alleen naar
// afgeronde sessies in het LMS ná het watermerk; calls in Bubble of van vóór
// het watermerk sluiten niets.
//
// Dit bestand verzint niets en sluit niets: het zet per open onboarding het
// BEWIJS uit het LMS ernaast, zodat de hoofdmentor zelf kan afronden:
//   - het aantal afgeronde coachingsessies in het LMS (eerste + laatste);
//   - `hlms_student.calls_startsaldo`: calls van vóór het LMS (Bubble);
//   - `hlms_student.calls_gedaan`.
// Geen automatische massa-afsluiting.
//
// FAALZACHT: lukt het lezen niet, dan `null` (onbekend) — nooit "geen bewijs".

import { getDfoLmsClient } from './dfo-lms-db.js';

const IN_CHUNK = 200;

/** Is er bewijs dat dit traject al loopt? PURE. */
export function heeftBewijs(b) {
  if (!b) return false;
  return (b.afgeronde_sessies || 0) > 0 || (b.calls_startsaldo || 0) > 0;
}

/**
 * @param {string[]} studentIds  LMS-student-ids (`onboardings.dfo_lms_student_id`)
 * @param {object} [lmsClient]
 * @returns {Promise<Map<string, {afgeronde_sessies: number, eerste_op: string|null, eerste_titel: string|null, laatste_op: string|null, calls_startsaldo: number, calls_gedaan: number}>|null>}
 */
export async function alGestartBewijs(studentIds, lmsClient = null) {
  const ids = [...new Set((studentIds || []).filter(Boolean).map(String))];
  const uit = new Map();
  if (!ids.length) return uit;
  const lms = lmsClient || getDfoLmsClient();
  if (!lms) return null;
  try {
    for (const id of ids) {
      uit.set(id, { afgeronde_sessies: 0, eerste_op: null, eerste_titel: null, laatste_op: null, calls_startsaldo: 0, calls_gedaan: 0 });
    }
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const deel = ids.slice(i, i + IN_CHUNK);
      const { data: sessies, error } = await lms.from('hlms_sessie')
        .select('student_id, start_tijd, titel')
        .in('student_id', deel)
        .eq('status', 'afgerond')
        .order('start_tijd', { ascending: true });
      if (error) throw new Error('hlms_sessie: ' + error.message);
      for (const s of sessies || []) {
        const b = uit.get(String(s.student_id));
        if (!b) continue;
        b.afgeronde_sessies += 1;
        if (!b.eerste_op) { b.eerste_op = s.start_tijd; b.eerste_titel = s.titel || null; }
        b.laatste_op = s.start_tijd;
      }
      const { data: studenten, error: stErr } = await lms.from('hlms_student')
        .select('id, calls_startsaldo, calls_gedaan')
        .in('id', deel);
      if (stErr) throw new Error('hlms_student: ' + stErr.message);
      for (const st of studenten || []) {
        const b = uit.get(String(st.id));
        if (!b) continue;
        b.calls_startsaldo = Number(st.calls_startsaldo) || 0;
        b.calls_gedaan = Number(st.calls_gedaan) || 0;
      }
    }
    return uit;
  } catch (e) {
    console.error('[onboarding-al-gestart] ' + (e?.message || e));
    return null;
  }
}
