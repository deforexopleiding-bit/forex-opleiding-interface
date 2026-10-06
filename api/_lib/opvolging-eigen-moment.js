// api/_lib/opvolging-eigen-moment.js
//
// EEN ZOOMCALL HANDMATIG INPLANNEN, BUITEN DE VRIJE MOMENTEN VAN GHL.
//
// ── HET PROBLEEM (gemeten op productie, 6 okt 2026) ─────────────────────
// Het inplanvenster toont alleen wat GHL als vrij teruggeeft, en de kalender
// heeft een boekvenster van ca. 20 dagen. Vanaf 27/10 stond er in elke kolom
// een stil '—' en kon Dave niets kiezen. Dat venster blijft zoals het is (de
// publieke boekingspagina toont hetzelfde); een handmatig moment is de
// bewuste uitzondering.
//
// ── WAT HIER STAAT ──────────────────────────────────────────────────────
// Pure functies, zonder netwerk of databank, zodat ze los te testen zijn:
//
//   leesEigenMoment(dag, tijd, nuMs) — 'YYYY-MM-DD' + 'HH:mm' in Brussel →
//       { iso } of { fout }. De browser rekent NIET zelf om: zie de kop van
//       zoneMomentNaarIso — tijdzonerekenwerk in de browser is precies waar
//       een klik op 10:00 een afspraak om 11:00 wordt.
//   zoekBotsingen({ momentMs, afspraken, persoon, negeerId }) — welke
//       geplande afspraken liggen binnen 30 minuten van dit moment? Alleen een
//       WAARSCHUWING: Dave kan doorgaan.

import { zoneMomentNaarIso, delenInZone } from './opvolging-agenda-merge.js';
import { zelfdeLead } from './opvolging-annulering.js';

/** De tijdzone van het handmatige moment. Zelfde offsets als Amsterdam. */
export const EIGEN_ZONE = 'Europe/Brussels';
/** Het uurveld gaat per kwartier. */
export const EIGEN_STAP_MIN = 15;
/** Binnen hoeveel minuten een andere afspraak als botsing telt (strikt). */
export const BOTSING_MARGE_MIN = 30;
/**
 * Hoe ver vooruit een handmatig moment mag. Geen bedrijfsregel maar een
 * vangnet tegen een tikfout in het jaartal (2062 in plaats van 2026): zo'n
 * afspraak zou niemand ooit terugvinden.
 */
export const EIGEN_MAX_DAGEN = 365;

/** Statussen die een moment echt bezet houden. Tweeling van BEZET_STATUSSEN in de merge. */
const BEZET = new Set(['scheduled', 'in_progress']);

/**
 * Leest het handmatige moment en zegt wat er niet aan klopt.
 *
 * @returns {{ iso:string, dag:string, tijd:string } | { fout:string }}
 */
export function leesEigenMoment(dag, tijd, nuMs = Date.now()) {
  const d = String(dag || '').trim();
  const t = String(tijd || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { fout: 'Kies een dag.' };
  if (!/^\d{2}:\d{2}$/.test(t)) return { fout: 'Kies een uur.' };
  const min = Number(t.slice(3));
  if (min % EIGEN_STAP_MIN !== 0) return { fout: 'Kies een uur per kwartier (:00, :15, :30 of :45).' };

  const iso = zoneMomentNaarIso(d, t, EIGEN_ZONE);
  if (!iso) return { fout: 'Dat is geen bestaande dag of tijd.' };
  // Een dag als 2026-02-31 komt wél door het patroon. Terugrekenen en
  // vergelijken vangt dat, en ook het uur dat bij de zomertijd niet bestaat.
  const terug = delenInZone(Date.parse(iso), EIGEN_ZONE);
  if (terug.dag !== d || terug.tijd !== t) return { fout: 'Dat is geen bestaande dag of tijd.' };

  const ms = Date.parse(iso);
  if (ms <= nuMs) return { fout: 'Dat moment ligt in het verleden.' };
  if (ms > nuMs + EIGEN_MAX_DAGEN * 86400000) {
    return { fout: 'Dat moment ligt meer dan een jaar vooruit. Klopt het jaartal?' };
  }
  return { iso, dag: d, tijd: t };
}

/** Zelfde persoon? GHL-contact of telefoon (zelfdeLead), of hetzelfde e-mailadres. */
function isPersoon(persoon, afspraak) {
  if (!persoon) return false;
  if (zelfdeLead(persoon, afspraak)) return true;
  const a = String(persoon.lead_email || '').trim().toLowerCase();
  const b = String(afspraak.lead_email || '').trim().toLowerCase();
  return !!a && a === b;
}

/**
 * Welke afspraken liggen te dicht bij dit moment?
 *
 * Elke rij in follow_up_appointments is een call van Dave, dus elke geplande
 * afspraak binnen de marge is een botsing 'voor Dave'. `zelfde_persoon` zegt
 * daarnaast of het om dezelfde lead gaat — dan is het vaak een dubbele boeking
 * in plaats van een vol uur.
 *
 * STRIKT BINNEN 30 MINUTEN. Een call van 10:00 en een nieuwe om 10:30 raken
 * elkaar (een call duurt 30 minuten) maar overlappen niet; die als botsing
 * melden zou bij elke aansluitende call een waarschuwing geven, en een
 * waarschuwing die altijd verschijnt leest niemand meer.
 *
 * @param {object}   o
 * @param {number}   o.momentMs   het gekozen moment
 * @param {object[]} o.afspraken  rijen uit follow_up_appointments
 * @param {?object}  o.persoon    { lead_phone, lead_email, lead_ghl_contact_id }
 * @param {?string}  o.negeerId   de afspraak die verzet wordt — die botst niet met zichzelf
 * @returns {{ appointment_id:string, naam:string, dag:string, tijd:string, minuten:number, zelfde_persoon:boolean }[]}
 */
export function zoekBotsingen({ momentMs, afspraken, persoon = null, negeerId = null, margeMin = BOTSING_MARGE_MIN }) {
  if (!Number.isFinite(momentMs)) return [];
  const marge = margeMin * 60000;
  const uit = [];
  for (const a of Array.isArray(afspraken) ? afspraken : []) {
    if (!a || !a.scheduled_at) continue;
    if (negeerId && String(a.id) === String(negeerId)) continue;
    // Proefrijen horen niet in Daves dagbeeld, dus ook niet in deze controle.
    if (a.is_test === true) continue;
    if (!BEZET.has(String(a.status || 'scheduled').toLowerCase())) continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms)) continue;
    const delta = ms - momentMs;
    if (Math.abs(delta) >= marge) continue;
    const plek = delenInZone(ms, EIGEN_ZONE);
    uit.push({
      appointment_id: a.id || null,
      naam          : (a.lead_name && String(a.lead_name).trim()) || 'Onbekend',
      dag           : plek.dag,
      tijd          : plek.tijd,
      minuten       : Math.round(delta / 60000),
      zelfde_persoon: isPersoon(persoon, a),
    });
  }
  uit.sort((x, y) => Math.abs(x.minuten) - Math.abs(y.minuten));
  return uit;
}
