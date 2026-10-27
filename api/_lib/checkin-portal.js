// api/_lib/checkin-portal.js
//
// DE REGELS VAN "JOUW DFO-CHECK-IN" — de korte persoonlijke check-in voor
// BESTAANDE studenten op www.deforexopleiding.nl/checkin (27 okt 2026).
// Alles hier is PUUR: het endpoint api/checkin-portal.js doet het lezen en
// schrijven (in het LMS-project dfo-lms, via api/_lib/dfo-lms-db.js), de
// CRM-sectie "Studentencheck-in" leest de labels. Getoetst in
// tests/checkin-portal.test.js.
//
// WHITELIST. Wat de website stuurt is een strikte deelverzameling: alleen deze
// sleutels, alleen deze waarden, en alleen wat bij de flow en de opties van de
// campagne hoort. Een onbekende sleutel of waarde → 400, nooit stil opslaan.
//
// De website (dfo-website lib/checkin-portal.ts) kent dezelfde sleutels en
// waarden — wijzig ze samen.

import { BELMOMENTEN, TRAJECT_NAAM } from './onboarding-portal.js';

export { TRAJECT_NAAM };

export const FASE = Object.freeze(['basis', 'demo', 'challenge', 'funded', 'minder_actief']);
export const DOEL_3M = Object.freeze(['strategie', 'routine', 'consistent', 'challenge', 'payout', 'herstart']);
export const PAYOUT = Object.freeze(['nog_niet', 'ja_eerste', 'ja_meerdere']);
export const JA_NEE = Object.freeze(['ja', 'nee']);
export const HELPT = Object.freeze(['mentor', 'live', 'videos', 'recaps', 'journal', 'community', 'kantoor']);
export const KNELPUNT = Object.freeze(['setups', 'emotie', 'risico', 'tijd', 'journal', 'platform', 'volgende_stap', 'niets']);
export const HULP = Object.freeze(['studieplan', 'oefenen', 'feedback', 'discipline', 'lms', 'niets']);
export const ROBOT = Object.freeze(['ja_interesse', 'nee']);
export const MAX_KEUZES = 3;
export const MAX_VERBETER = 2000;

/** De standaardopties van een campagne (hlms_checkin_campagne.opties). */
export const STANDAARD_OPTIES = Object.freeze({ payout_vraag: true, trustpilot_vraag: false, autopilot_stap: true });
export const TRUSTPILOT_URL = 'https://nl.trustpilot.com/evaluate/deforexopleiding.nl';

/** Alle sleutels die de portal kan schrijven. */
export const CHECKIN_SLEUTELS = Object.freeze([
  'fase', 'doel_3m', 'uren_per_week', 'payout', 'payout_delen', 'nps', 'helpt', 'knelpunt',
  'verbeter', 'hulp', 'mentor_score', 'begeleiding_contact', 'robot_interesse', 'robot_belmoment',
]);

/** Leesbare labels — dezelfde woorden als op de website. */
export const LABELS = Object.freeze({
  fase: { basis: 'Basiskennis opbouwen', demo: 'Oefenen op demo', challenge: 'Bezig met een challenge', funded: 'Funded of eigen kapitaal', minder_actief: 'Tijdelijk minder actief' },
  doel_3m: { strategie: 'De strategie volledig snappen', routine: 'Een vaste routine', consistent: 'Consistenter uitvoeren', challenge: 'Een challenge halen', payout: 'Mijn (eerste) payout', herstart: 'Opnieuw opstarten' },
  payout: { nog_niet: 'Nog niet', ja_eerste: 'Ja, mijn eerste', ja_meerdere: 'Ja, al meerdere' },
  payout_delen: { ja: 'Ja, graag', nee: 'Liever niet' },
  helpt: { mentor: '1-op-1 met mijn mentor', live: 'Live sessies', videos: "Video's in het LMS", recaps: 'Trade recaps', journal: 'Journal & planner', community: 'Discord-community', kantoor: 'Sessies op kantoor' },
  knelpunt: { setups: 'Setups herkennen', emotie: 'Discipline & emoties', risico: 'Risicobeheer', tijd: 'Tijd & planning', journal: 'Journal bijhouden', platform: 'Het platform', volgende_stap: 'Geen duidelijke volgende stap', niets: 'Momenteel niets' },
  hulp: { studieplan: 'Een duidelijk studieplan', oefenen: 'Meer oefeningen', feedback: 'Feedback op mijn trades', discipline: 'Hulp met discipline', lms: 'Uitleg over het LMS', niets: 'Voorlopig niets extra' },
  begeleiding_contact: { ja: 'Ja, graag', nee: 'Nee, alles goed' },
  robot_interesse: { ja_interesse: 'Ja, bel mij', nee: 'Nee, nu niet' },
  robot_belmoment: { voormiddag: 'Voormiddag', namiddag: 'Namiddag', avond: 'Avond', weekend: 'Zaterdag' },
});

export const VRAAG = Object.freeze({
  fase: 'Waar sta je vandaag?',
  doel_3m: 'Doel komende 3 maanden',
  uren_per_week: 'Uur per week',
  payout: 'Al een payout?',
  payout_delen: 'Resultaat delen (zonder naam)',
  nps: 'Aanbevelen (0-10)',
  helpt: 'Helpt het meest',
  knelpunt: 'Loopt tegenaan',
  verbeter: 'Wat kunnen we beter doen',
  hulp: 'Wat helpt nu vooruit',
  mentor_score: 'Tevreden over mentor (1-5)',
  begeleiding_contact: 'Contact over traject',
  robot_interesse: 'Autopilot',
  robot_belmoment: 'Belmoment Autopilot',
});

/** product_soort (hlms_student) → flow. Alles behalve mentorship = membership. */
export function flowVoor(productSoort) {
  return productSoort === 'mentorship' ? '1op1' : 'membership';
}

/** De opties van een toewijzing: wat bij het starten vastgelegd is, anders die van de campagne. */
export function optiesVan(toewijzing, campagne) {
  const bron = (toewijzing?.opties && typeof toewijzing.opties === 'object') ? toewijzing.opties
    : (campagne?.opties && typeof campagne.opties === 'object') ? campagne.opties : {};
  return {
    payout_vraag: bron.payout_vraag !== false,
    trustpilot_vraag: bron.trustpilot_vraag === true,
    autopilot_stap: bron.autopilot_stap !== false,
  };
}

function subset(waarde, toegestaan, max = Infinity) {
  if (!Array.isArray(waarde)) return null;
  const set = new Set();
  for (const v of waarde) {
    if (typeof v !== 'string' || !toegestaan.includes(v)) return null;
    set.add(v);
  }
  if (set.size > max) return null;
  // Vaste volgorde: de opgeslagen vorm is stabiel, wat de student ook aantikt.
  return toegestaan.filter((v) => set.has(v));
}

function geheel(v, min, max) {
  return Number.isInteger(v) && v >= min && v <= max;
}

/** Mag deze sleutel in deze flow/opties? */
function sleutelMag(sleutel, flow, opties) {
  if (sleutel === 'mentor_score') return flow === '1op1';
  if (sleutel === 'payout' || sleutel === 'payout_delen') return opties.payout_vraag;
  if (sleutel === 'robot_interesse' || sleutel === 'robot_belmoment') return opties.autopilot_stap;
  return CHECKIN_SLEUTELS.includes(sleutel);
}

function valideerWaarde(sleutel, waarde, flow) {
  switch (sleutel) {
    case 'fase': return FASE.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'doel_3m': return DOEL_3M.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'payout': return PAYOUT.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'payout_delen':
    case 'begeleiding_contact': return JA_NEE.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'hulp': return HULP.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'robot_interesse': return ROBOT.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'uren_per_week': return geheel(waarde, 0, 10) ? { ok: true, waarde } : { ok: false };
    case 'nps': return geheel(waarde, 0, 10) ? { ok: true, waarde } : { ok: false };
    case 'mentor_score': return geheel(waarde, 1, 5) ? { ok: true, waarde } : { ok: false };
    case 'helpt': {
      // '1-op-1 met mijn mentor' bestaat alleen in de mentorship-flow.
      const lijst = flow === '1op1' ? HELPT : HELPT.filter((v) => v !== 'mentor');
      const s = subset(waarde, lijst, MAX_KEUZES);
      return s ? { ok: true, waarde: s } : { ok: false };
    }
    case 'knelpunt': {
      const s = subset(waarde, KNELPUNT, MAX_KEUZES);
      // 'Momenteel niets' sluit de rest uit.
      if (!s || (s.includes('niets') && s.length > 1)) return { ok: false };
      return { ok: true, waarde: s };
    }
    case 'robot_belmoment': {
      const s = subset(waarde, BELMOMENTEN);
      return s ? { ok: true, waarde: s } : { ok: false };
    }
    case 'verbeter': {
      if (typeof waarde !== 'string') return { ok: false };
      const t = waarde.replace(/\u0000/g, '').trim();
      return t.length <= MAX_VERBETER ? { ok: true, waarde: t } : { ok: false };
    }
    default: return { ok: false };
  }
}

/**
 * Een patch van de website → { ok, schoon, fouten }.
 * fouten = lijst sleutels die niet mogen of niet kloppen.
 */
export function valideerPatch(patch, { flow = '1op1', opties = STANDAARD_OPTIES } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, schoon: {}, fouten: ['antwoorden'] };
  }
  const o = { ...STANDAARD_OPTIES, ...opties };
  const schoon = {};
  const fouten = [];
  for (const [sleutel, waarde] of Object.entries(patch)) {
    if (!CHECKIN_SLEUTELS.includes(sleutel) || !sleutelMag(sleutel, flow, o)) { fouten.push(sleutel); continue; }
    const r = valideerWaarde(sleutel, waarde, flow);
    if (r.ok) schoon[sleutel] = r.waarde; else fouten.push(sleutel);
  }
  return { ok: fouten.length === 0, schoon, fouten };
}

/** Alleen geldige, toegelaten sleutels uit opgeslagen antwoorden (naar de browser en naar versturen). */
export function schoneAntwoorden(antwoorden, { flow = '1op1', opties = STANDAARD_OPTIES } = {}) {
  const a = (antwoorden && typeof antwoorden === 'object' && !Array.isArray(antwoorden)) ? antwoorden : {};
  const o = { ...STANDAARD_OPTIES, ...opties };
  const uit = {};
  for (const k of CHECKIN_SLEUTELS) {
    if (a[k] === undefined || a[k] === null) continue;
    if (!sleutelMag(k, flow, o)) continue;
    const r = valideerWaarde(k, a[k], flow);
    if (r.ok) uit[k] = r.waarde;
  }
  // Payout delen heeft alleen zin bij een payout.
  if (uit.payout === 'nog_niet' || !uit.payout) delete uit.payout_delen;
  // Belmoment alleen bij "ja, bel mij".
  if (uit.robot_interesse !== 'ja_interesse') delete uit.robot_belmoment;
  return uit;
}

/** Verplicht bij versturen, per flow en opties. */
export function verplicht(flow, opties = STANDAARD_OPTIES) {
  const o = { ...STANDAARD_OPTIES, ...opties };
  const lijst = ['fase', 'doel_3m', 'nps', 'knelpunt', 'hulp', 'begeleiding_contact'];
  if (flow === '1op1') lijst.push('mentor_score');
  if (o.autopilot_stap) lijst.push('robot_interesse');
  return lijst;
}

/** Welke verplichte sleutels ontbreken nog? */
export function ontbrekend(flow, opties, antwoorden) {
  const a = schoneAntwoorden(antwoorden, { flow, opties });
  return verplicht(flow, opties).filter((k) => {
    const v = a[k];
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || v === '';
  });
}

// ── Het begeleidingssignaal naar de hoofdmentor ─────────────────────────────
const RANG = { geel: 1, oranje: 2, rood: 3 };

/**
 * Moet er een begeleidingssignaal komen, en hoe zwaar? PUUR.
 *   · begeleiding_contact = ja            → oranje
 *   · nps ≤ 6                             → geel (rood bij ≤ 3)
 *   · mentor_score ≤ 2                    → oranje
 *   · knelpunt bevat 'volgende_stap'      → geel
 * Eén signaal per toewijzing: de hoogste zwaarte wint.
 *
 * Staat bewust LOS van de automation-interesse: een begeleidingssignaal mag
 * nooit verdwijnen door de commerciële opvolging, en omgekeerd.
 *
 * @returns {null | {zwaarte: 'geel'|'oranje'|'rood', redenen: string[]}}
 */
export function signaalVoor(antwoorden) {
  const a = antwoorden || {};
  const treffers = [];
  if (a.begeleiding_contact === 'ja') treffers.push(['oranje', 'Vraagt contact over zijn traject']);
  if (Number.isInteger(a.nps) && a.nps <= 6) {
    treffers.push([a.nps <= 3 ? 'rood' : 'geel', `Lage aanbeveling (${a.nps}/10)`]);
  }
  if (Number.isInteger(a.mentor_score) && a.mentor_score <= 2) {
    treffers.push(['oranje', `Lage mentorscore (${a.mentor_score}/5)`]);
  }
  if (Array.isArray(a.knelpunt) && a.knelpunt.includes('volgende_stap')) {
    treffers.push(['geel', 'Ziet geen duidelijke volgende stap']);
  }
  if (!treffers.length) return null;
  const zwaarte = treffers.reduce((m, [z]) => (RANG[z] > RANG[m] ? z : m), 'geel');
  return { zwaarte, redenen: treffers.map(([, r]) => r) };
}

function label(sleutel, waarde) {
  const m = LABELS[sleutel];
  if (Array.isArray(waarde)) return waarde.map((v) => (m && m[v]) || v);
  return (m && m[waarde]) || waarde;
}

/**
 * Het bewijs op het signaal: de relevante antwoorden, LEESBAAR (het
 * hoofdmentorbord toont het als JSON). Een mentor leest dit signaal niet (RLS).
 */
export function signaalBewijs({ antwoorden, redenen, campagneSlug, toewijzingId, isTest }) {
  const a = antwoorden || {};
  const b = {
    'Check-in': campagneSlug || null,
    Waarom: redenen || [],
    [VRAAG.nps]: a.nps ?? null,
  };
  if (a.mentor_score != null) b[VRAAG.mentor_score] = a.mentor_score;
  b[VRAAG.begeleiding_contact] = a.begeleiding_contact ? label('begeleiding_contact', a.begeleiding_contact) : null;
  if (a.fase) b[VRAAG.fase] = label('fase', a.fase);
  if (a.knelpunt?.length) b[VRAAG.knelpunt] = label('knelpunt', a.knelpunt);
  if (a.hulp) b[VRAAG.hulp] = label('hulp', a.hulp);
  if (a.verbeter) b[VRAAG.verbeter] = a.verbeter;
  b.toewijzing_id = toewijzingId || null;
  if (isTest) b.test = true;
  return b;
}

// ── Traject ─────────────────────────────────────────────────────────────────

/** Maand X van Y, uit start_datum en traject_maanden. PUUR. null als onbekend. */
export function maandVan(startDatum, trajectMaanden, nu = new Date()) {
  const y = Number(trajectMaanden);
  if (!startDatum || !/^\d{4}-\d{2}-\d{2}/.test(String(startDatum)) || !Number.isInteger(y) || y < 1) return null;
  const [jj, mm, dd] = String(startDatum).slice(0, 10).split('-').map(Number);
  const n = new Date(nu);
  let maanden = (n.getUTCFullYear() - jj) * 12 + (n.getUTCMonth() + 1 - mm);
  if (n.getUTCDate() < dd) maanden -= 1;
  const x = Math.min(Math.max(maanden + 1, 1), y);
  return { maand: x, maanden: y };
}

/** {voornaam, initialen} uit een volledige naam, of null. */
export function persoonKort(volledigeNaam) {
  const delen = String(volledigeNaam || '').trim().split(/\s+/).filter(Boolean);
  if (!delen.length) return null;
  const voornaam = delen[0];
  const initialen = (delen[0][0] + (delen.length > 1 ? delen[delen.length - 1][0] : '')).toUpperCase();
  return { voornaam, initialen };
}

/** Is de toewijzing open voor de student? Zelfde regel als hlms_checkin_zichtbaar(). */
export function isZichtbaar(campagneStatus, isTest) {
  return campagneStatus === 'live' || (campagneStatus === 'test' && isTest === true);
}

export const TEKST = Object.freeze({
  onbekend: 'Die code kennen we niet. Kijk hem na in de balk bovenaan je leerplatform.',
  dicht: 'De check-in is even gesloten. Probeer het later opnieuw.',
  teVeel: 'Even te veel pogingen, probeer over een minuutje opnieuw.',
});
