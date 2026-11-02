// api/_lib/lms-student-ontkoppelen.js
//
// VERWIJZING NAAR EEN VERWIJDERDE LMS-STUDENT (Maxim, 2 november 2026).
//
// Sinds 29 okt kan het LMS een student verwijderen (account verwijderen). In
// het CRM bleef `onboardings.dfo_lms_student_id` dan naar een student wijzen
// die niet meer bestaat. Gemeten (2 nov):
//   - een open of afgeronde onboarding met zo'n id: de spiegel, de intake, het
//     signaal "geen reactie" en "naar incasso" faalden elke keer met een
//     FK-fout (23503); "Koppeling opnieuw controleren" zei toch "in orde" en
//     het scherm toonde "✓ In LMS";
//   - koppelen aan een nieuwe student weigerde (al gekoppeld);
//   - een geannuleerde onboarding: onschuldig, maar het detailscherm verwees
//     naar een dossier dat niet meer bestaat.
//
// DE REGEL: alleen met BEWIJS dat de student bewust verwijderd is — geen rij
// meer in hlms_student ÉN de auditrij in `hlms_student_verwijderd` — gaat de
// verwijzing eraf (id leeg, provisioned uit, een uitleg in
// dfo_lms_provision_error, en een regel op de tijdlijn). NOOIT op een
// mislukte lezing. De status van de onboarding blijft zoals hij is: opnieuw
// een account aanmaken gebeurt alleen met een klik (de inhaalslag draait
// niet vanzelf), en een geannuleerde onboarding komt daar nooit in.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

/** De tekst in dfo_lms_provision_error. PURE. */
export function ontkoppelTekst(studentId, verwijderdOp) {
  const wanneer = verwijderdOp ? String(verwijderdOp).slice(0, 10) : null;
  return 'LMS-account verwijderd' + (wanneer ? ' op ' + wanneer : '') + ' (student ' + studentId + '): '
    + 'de koppeling is losgemaakt. Opnieuw aanmaken kan met "Student aanmaken in LMS".';
}

/**
 * Welke van deze student-id's bestaan NIET meer in het LMS? Leest alleen.
 * `null` = niet met zekerheid te zeggen (dan niets ontkoppelen). Alleen
 * studenten met een auditrij (bewust verwijderd) komen in het resultaat.
 * @returns {Promise<Map<string, string|null> | null>} id → verwijderd_op (of null)
 */
export async function verdwenenStudenten(ids, { lms = getDfoLmsClient() } = {}) {
  const uniek = [...new Set((ids || []).map(String).filter(Boolean))];
  if (!lms) return null;
  const weg = new Map();
  for (let i = 0; i < uniek.length; i += 150) {
    const blok = uniek.slice(i, i + 150);
    const { data, error } = await lms.from('hlms_student').select('id').in('id', blok);
    if (error) return null;
    const bestaat = new Set((data || []).map((r) => String(r.id)));
    const ontbreekt = blok.filter((id) => !bestaat.has(id));
    if (ontbreekt.length === 0) continue;
    // Alleen MET de auditrij: dan is de student bewust verwijderd (de knop).
    // Ontbreekt hij zonder auditrij, dan blijft de koppeling staan — niets
    // losmaken op grond van iets wat we niet kunnen verklaren.
    const { data: audit, error: aErr } = await lms.from('hlms_student_verwijderd')
      .select('student_id, verwijderd_op').in('student_id', ontbreekt);
    if (aErr) return null;
    for (const r of audit || []) weg.set(String(r.student_id), r.verwijderd_op || null);
  }
  return weg;
}

/**
 * Maak de verwijzing los op elke onboarding die naar deze (verdwenen)
 * student wijst. Voorwaardelijk op het oude id: een intussen gewijzigde
 * koppeling blijft staan. Gooit nooit.
 * @returns {Promise<{ ok: boolean, onboarding_ids: string[], error?: string }>}
 */
export async function ontkoppelVerwijderdeStudent(studentId, { verwijderdOp = null, door = null } = {}) {
  if (!studentId) return { ok: true, onboarding_ids: [] };
  try {
    const { data, error } = await supabaseAdmin.from('onboardings')
      .update({ dfo_lms_student_id: null, dfo_lms_provisioned: false, dfo_lms_provision_error: ontkoppelTekst(studentId, verwijderdOp) })
      .eq('dfo_lms_student_id', studentId)
      .select('id');
    if (error) throw new Error(error.message);
    const obIds = (data || []).map((r) => r.id);
    for (const id of obIds) {
      const { error: nErr } = await supabaseAdmin.from('onboarding_mentor_updates').insert({
        onboarding_id: id, kind: 'note', status: null, created_by: door,
        note: 'LMS-account van deze student is verwijderd: de koppeling met het LMS is losgemaakt.',
      });
      if (nErr) console.warn('[lms-student-ontkoppelen] tijdlijn ' + id + ': ' + nErr.message);
    }
    return { ok: true, onboarding_ids: obIds };
  } catch (e) {
    console.error('[lms-student-ontkoppelen] ' + studentId + ': ' + (e?.message || e));
    return { ok: false, onboarding_ids: [], error: e?.message || String(e) };
  }
}

/**
 * De inhaalslag (nachtelijke spiegel): elke onboarding — ook geannuleerd of
 * gearchiveerd — die naar een verdwenen student wijst, losmaken. Gooit nooit.
 * @returns {Promise<{ gecontroleerd: number, losgemaakt: number, fout: string|null }>}
 */
export async function ruimVerwijderdeKoppelingenOp({ lms = getDfoLmsClient() } = {}) {
  try {
    const { data, error } = await supabaseAdmin.from('onboardings')
      .select('id, dfo_lms_student_id').not('dfo_lms_student_id', 'is', null).limit(5000);
    if (error) throw new Error('onboardings lezen: ' + error.message);
    const ids = (data || []).map((r) => r.dfo_lms_student_id);
    const weg = await verdwenenStudenten(ids, { lms });
    if (!weg) return { gecontroleerd: ids.length, losgemaakt: 0, fout: 'LMS niet te lezen: niets losgemaakt' };
    let losgemaakt = 0;
    for (const [studentId, op] of weg) {
      const uit = await ontkoppelVerwijderdeStudent(studentId, { verwijderdOp: op });
      losgemaakt += uit.onboarding_ids.length;
    }
    return { gecontroleerd: ids.length, losgemaakt, fout: null };
  } catch (e) {
    return { gecontroleerd: 0, losgemaakt: 0, fout: e?.message || String(e) };
  }
}
