// api/_lib/geannuleerde-studenten.js
//
// WIE IS GEANNULEERD EN HEEFT NOG EEN LMS-STUDENT? (Maxim, 2 november 2026)
//
// De bron voor "Alle geannuleerden verwijderen" in Studentenbeheer (LMS) en
// voor de inhaalslag van hlms_student_annulering. Eén regel, hier:
//   - elk record in onboarding_cancellations, niet van een testonboarding;
//   - de LMS-student: steps.lms_student_id, anders steps.lms_toegang.student_id,
//     anders onboardings.dfo_lms_student_id; anders (historisch) het Bubble-id
//     van de onboarding (het LMS zoekt dat zelf op);
//   - per student één rij (een student met twee records = één rij);
//   - twee waarschuwingen, zodat niemand zomaar wordt aangevinkt:
//       actief_abonnement — de klant heeft nog een abonnement dat niet
//         'cancelled' is (via deals);
//       nieuwere_onboarding — er is NA de (laatste) annulering een nieuwe,
//         niet-geannuleerde onboarding voor dezelfde student of klant
//         (opnieuw gestart).
// Leest alleen.

import { supabaseAdmin } from '../supabase.js';

const DICHT = new Set(['geannuleerd', 'gearchiveerd']);

/** De LMS-student van één record. PURE. */
export function studentVanRecord(rec, ob) {
  const s = rec?.steps || {};
  return {
    student_id: s.lms_student_id || s.lms_toegang?.student_id || ob?.dfo_lms_student_id || null,
    bubble_user_id: ob?.bubble_user_id || null,
  };
}

/**
 * Groepeer de annuleringen per student. PURE.
 * @param {{ records: object[], onboardings: object[], actieveKlanten: Set<string> }} p
 */
export function groepeerGeannuleerden({ records, onboardings, actieveKlanten }) {
  const obPerId = new Map((onboardings || []).map((o) => [String(o.id), o]));
  const perSleutel = new Map();
  let zonderStudent = 0;
  for (const rec of records || []) {
    const ob = rec.onboarding_id ? obPerId.get(String(rec.onboarding_id)) : null;
    if (ob?.is_test === true) continue;
    const st = studentVanRecord(rec, ob);
    const sleutel = st.student_id ? 'id:' + st.student_id : st.bubble_user_id ? 'bubble:' + st.bubble_user_id : null;
    if (!sleutel) { zonderStudent++; continue; }
    const rij = perSleutel.get(sleutel) || {
      student_id: st.student_id, bubble_user_id: st.bubble_user_id, customer_ids: [], namen: [],
      annuleringen: [], incasso: false,
    };
    if (rec.customer_id && !rij.customer_ids.includes(String(rec.customer_id))) rij.customer_ids.push(String(rec.customer_id));
    if (rec.customer_name && !rij.namen.includes(rec.customer_name)) rij.namen.push(rec.customer_name);
    rij.annuleringen.push({ id: rec.id, op: rec.created_at, niveau: rec.steps?.niveau || 'onboarding' });
    if (rec.steps?.opties?.incasso === true) rij.incasso = true;
    perSleutel.set(sleutel, rij);
  }
  const rijen = [];
  for (const rij of perSleutel.values()) {
    rij.annuleringen.sort((a, b) => String(a.op).localeCompare(String(b.op)));
    const laatste = rij.annuleringen[rij.annuleringen.length - 1]?.op || null;
    const nieuwere = (onboardings || []).filter((o) => o.is_test !== true && !DICHT.has(String(o.status || '').toLowerCase()) && !o.archived_at
      && String(o.created_at || '') > String(laatste || '')
      && ((rij.student_id && String(o.dfo_lms_student_id || '') === String(rij.student_id))
        || (rij.bubble_user_id && String(o.bubble_user_id || '') === String(rij.bubble_user_id))
        || rij.customer_ids.includes(String(o.customer_id || ''))));
    rijen.push({
      ...rij,
      eerste_annulering_op: rij.annuleringen[0]?.op || null,
      laatste_annulering_op: laatste,
      actief_abonnement: rij.customer_ids.some((c) => actieveKlanten.has(c)),
      nieuwere_onboarding: nieuwere.length > 0,
      nieuwere_onboarding_ids: nieuwere.map((o) => o.id),
    });
  }
  rijen.sort((a, b) => String(a.laatste_annulering_op).localeCompare(String(b.laatste_annulering_op)));
  return { rijen, zonder_student: zonderStudent };
}

async function alles(bouw, wat) {
  const uit = [];
  for (let van = 0; van < 20000; van += 1000) {
    const { data, error } = await bouw().range(van, van + 999);
    if (error) throw new Error(wat + ': ' + error.message);
    uit.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return uit;
}

/** Leest alleen. */
export async function leesGeannuleerdeStudenten() {
  const records = await alles(() => supabaseAdmin.from('onboarding_cancellations')
    .select('id, created_at, onboarding_id, customer_id, customer_name, steps').order('created_at', { ascending: true }), 'annuleringen');
  const onboardings = await alles(() => supabaseAdmin.from('onboardings')
    .select('id, customer_id, dfo_lms_student_id, bubble_user_id, status, archived_at, created_at, is_test').order('id'), 'onboardings');
  const klanten = [...new Set(records.map((r) => r.customer_id).filter(Boolean).map(String))];
  const actieveKlanten = new Set();
  for (let i = 0; i < klanten.length; i += 100) {
    const blok = klanten.slice(i, i + 100);
    const { data: deals, error } = await supabaseAdmin.from('deals').select('id, customer_id').in('customer_id', blok);
    if (error) throw new Error('deals: ' + error.message);
    const perDeal = new Map((deals || []).map((d) => [String(d.id), String(d.customer_id)]));
    const ids = [...perDeal.keys()];
    for (let j = 0; j < ids.length; j += 100) {
      const { data: subs, error: sErr } = await supabaseAdmin.from('subscriptions')
        .select('deal_id, status').in('deal_id', ids.slice(j, j + 100)).neq('status', 'cancelled');
      if (sErr) throw new Error('abonnementen: ' + sErr.message);
      for (const s of subs || []) { const c = perDeal.get(String(s.deal_id)); if (c) actieveKlanten.add(c); }
    }
  }
  return groepeerGeannuleerden({ records, onboardings, actieveKlanten });
}
