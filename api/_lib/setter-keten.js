// api/_lib/setter-keten.js
//
// WIE HEEFT DEZE CALL GEBOEKT — OOK NA VERZETTEN.
//
// `follow_up_appointments.setter_user_id` (BP2) en `booking_source` worden
// gezet bij het boeken (api/_lib/create-appointment-from-lead.js). Wordt de
// afspraak daarna verzet, dan maakt api/_lib/verzet-afspraak.js (en de
// vervolg-call in api/follow-up-outcomes.js) een NIEUWE rij met
// parent_appointment_id = de oude. Tot 1 oktober 2026 nam die nieuwe rij de
// setter en de bron niet mee. Gevolg, gemeten: Romy boekte Manjit Kaur, de
// call werd verzet, en de opvolger — de call die echt plaatsvindt en waar de
// uitkomst op komt — hing aan niemand. Haar rapport zou die call missen.
//
// Drie stukken, allemaal hier zodat er één regel is:
//   erfSetterVelden()   — wat een opvolger van zijn voorganger overneemt.
//   setterUitKeten()    — de setter van een oude rij zonder backfill, door de
//                         keten omhoog te lopen (pure functie op een Map).
//   haalSetterViaKeten()— hetzelfde, maar leest de keten uit de databank.
//   planSetterBackfill()— de pure kern van scripts/backfill-setter-keten.mjs.
//
// LET OP BIJ TELLEN. Een verzette afspraak bestaat daarna als TWEE rijen met
// dezelfde setter (de oude op 'verplaatst', de nieuwe). Wie BOEKINGEN telt,
// telt alleen rijen zonder parent_appointment_id — zie
// api/setter-dashboard-metrics.js en api/booking-sources-list.js. Wie
// UITKOMSTEN telt, telt juist de opvolger (daar staat de uitkomst op).

/** Hoe diep we een keten maximaal volgen. Echte ketens zijn 1-3 lang. */
export const MAX_KETEN_DIEPTE = 20;

/**
 * De velden die een opvolger van zijn voorganger erft.
 *
 * Alleen gevulde waarden: een leeg veld meesturen voegt niets toe en zou bij
 * een oud schema een kolom noemen die er misschien niet is.
 */
export function erfSetterVelden(voorganger) {
  const uit = {};
  if (!voorganger || typeof voorganger !== 'object') return uit;
  if (voorganger.setter_user_id) uit.setter_user_id = voorganger.setter_user_id;
  if (voorganger.booking_source) uit.booking_source = voorganger.booking_source;
  return uit;
}

/**
 * Loop de keten omhoog tot een rij met setter_user_id.
 *
 * @param {object} afspraak         rij met id, parent_appointment_id, setter_user_id
 * @param {Map<string,object>} perId alle bekende rijen op id
 * @returns {?{setter_user_id:string, booking_source:?string,
 *            bron_appointment_id:string, diepte:number, keten:string[]}}
 *   diepte 0 = de rij zelf draagt de setter. null = nergens in de keten.
 *   Cycli en ontbrekende schakels stoppen de zoektocht (null), nooit een loop.
 */
export function setterUitKeten(afspraak, perId, { maxDiepte = MAX_KETEN_DIEPTE } = {}) {
  if (!afspraak) return null;
  const gezien = new Set();
  const keten = [];
  let huidig = afspraak;
  for (let diepte = 0; huidig && diepte <= maxDiepte; diepte += 1) {
    const id = String(huidig.id);
    if (gezien.has(id)) return null;          // cyclus
    gezien.add(id);
    keten.push(id);
    if (huidig.setter_user_id) {
      return {
        setter_user_id     : huidig.setter_user_id,
        booking_source     : huidig.booking_source || null,
        bron_appointment_id: id,
        diepte,
        keten,
      };
    }
    const ouderId = huidig.parent_appointment_id;
    if (!ouderId) return null;
    huidig = perId && typeof perId.get === 'function' ? perId.get(String(ouderId)) : null;
  }
  return null;
}

/**
 * Zelfde vraag, maar de keten wordt uit de databank gelezen. Voor weergave van
 * oude rijen die (nog) niet gebackfilld zijn. Fail-soft: een leesfout geeft
 * null, nooit een exception — een ontbrekende setter-naam mag een scherm niet
 * omgooien.
 */
export async function haalSetterViaKeten(supabaseAdmin, afspraakId, { maxDiepte = MAX_KETEN_DIEPTE } = {}) {
  if (!supabaseAdmin || !afspraakId) return null;
  const perId = new Map();
  let volgende = String(afspraakId);
  for (let i = 0; volgende && i <= maxDiepte; i += 1) {
    if (perId.has(volgende)) break;
    try {
      const { data, error } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('id, parent_appointment_id, setter_user_id, booking_source')
        .eq('id', volgende)
        .maybeSingle();
      if (error || !data) break;
      perId.set(String(data.id), data);
      if (data.setter_user_id) break;
      volgende = data.parent_appointment_id ? String(data.parent_appointment_id) : null;
    } catch (e) {
      console.warn('[setter-keten] lezen faalde (soft):', e?.message || e);
      break;
    }
  }
  const start = perId.get(String(afspraakId));
  return start ? setterUitKeten(start, perId, { maxDiepte }) : null;
}

/**
 * Welke rijen zou de backfill bijwerken, en waarmee?
 *
 * Alleen rijen die ZELF geen setter_user_id hebben en een voorganger (via
 * parent_appointment_id, op willekeurige diepte) mét setter. booking_source
 * wordt alleen gevuld als de rij er zelf geen heeft — een bestaande bron
 * overschrijven we nooit.
 *
 * @param {object[]} rijen alle relevante rijen (de kandidaten én hun voorgangers)
 * @returns {object[]} één plan-regel per bij te werken rij, gesorteerd op scheduled_at
 */
export function planSetterBackfill(rijen, { maxDiepte = MAX_KETEN_DIEPTE } = {}) {
  const lijst = Array.isArray(rijen) ? rijen : [];
  const perId = new Map(lijst.map((r) => [String(r.id), r]));
  const plan = [];
  for (const r of lijst) {
    if (r.setter_user_id) continue;
    if (!r.parent_appointment_id) continue;
    const ouder = perId.get(String(r.parent_appointment_id));
    if (!ouder) continue;
    const hit = setterUitKeten(ouder, perId, { maxDiepte });
    if (!hit) continue;
    const zet = { setter_user_id: hit.setter_user_id };
    if (!r.booking_source && hit.booking_source) zet.booking_source = hit.booking_source;
    plan.push({
      id                 : String(r.id),
      lead_name          : r.lead_name || null,
      scheduled_at       : r.scheduled_at || null,
      status             : r.status || null,
      is_test            : r.is_test === true,
      bron_appointment_id: hit.bron_appointment_id,
      // Van de rij zelf omhoog tot en met de bron.
      keten              : [String(r.id)].concat(hit.keten),
      zet,
    });
  }
  plan.sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')));
  return plan;
}
