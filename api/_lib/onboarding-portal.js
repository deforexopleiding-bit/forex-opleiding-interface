// api/_lib/onboarding-portal.js
//
// De regels van de nieuwe onboarding-portal (www.deforexopleiding.nl/onboarding).
// Alles hier is PUUR — het endpoint api/onboarding-portal.js doet het lezen en
// schrijven. Getoetst in tests/onboarding-portal.test.js.
//
// DE SLEUTELS ZIJN BEWUST DIE VAN DE KLASSIEKE WIZARD. Het detailscherm, de
// LMS-spiegel, de mentorweergave en alles wat onboardings.answers leest, blijft
// zo werken zonder één regel aan te passen. Wat de portal schrijft is een
// strikte deelverzameling: alleen deze sleutels, alleen deze waarden. Een
// onbekende sleutel of een waarde buiten de lijst → 400, nooit stil opslaan.

export const DAGEN = Object.freeze(['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo']);
export const DAGDELEN = Object.freeze(['ochtend', 'middag', 'namiddag', 'avond']);
export const BELMOMENTEN = Object.freeze(['voormiddag', 'namiddag', 'avond', 'weekend']);

const KEUZES = Object.freeze({
  coaching_locatie_voorkeur: ['bootcamp_dan_online', 'zoveel_mogelijk_kantoor', 'enkel_online'],
  ervaring_trading: ['geen', 'beginner', 'gemiddeld', 'gevorderd'],
  motivatie_primair: ['extra_inkomen', 'fulltime_trader', 'vermogen_groeien', 'leren_voor_jezelf', 'anders'],
  robot_interesse: ['ja_interesse', 'nee'],
});

export const PORTAL_SLEUTELS = Object.freeze([
  'coaching_locatie_voorkeur', 'ervaring_trading', 'motivatie_primair',
  'commitment_uren_per_week', 'beschikbaarheid', 'robot_interesse', 'robot_belmoment',
]);

/** Verplicht bij "Afronden", per flow. */
export const VERPLICHT = Object.freeze({
  '1op1': ['coaching_locatie_voorkeur', 'ervaring_trading', 'motivatie_primair',
    'commitment_uren_per_week', 'beschikbaarheid', 'robot_interesse'],
  membership: ['ervaring_trading', 'motivatie_primair', 'commitment_uren_per_week', 'robot_interesse'],
});

/** Leesbare naam van het traject, zoals de klant hem kent. */
export const TRAJECT_NAAM = Object.freeze({
  '1op1': '1-op-1 Mentorship',
  membership: 'Membership Program',
});

/** Statussen waarin de klant de portal niet meer in mag. */
export const AFGESLOTEN = Object.freeze(['gearchiveerd', 'geannuleerd']);
export function isAfgesloten(status) { return AFGESLOTEN.includes(String(status || '')); }

export const TEKST = Object.freeze({
  onbekend: 'Die code kennen we niet. Kijk hem even na in je mail.',
  afgesloten: 'Deze onboarding is afgesloten. Neem contact op met administratie@deforexopleiding.nl',
  teVeel: 'Even te veel pogingen, probeer over een minuutje opnieuw.',
});

function subset(waarde, toegestaan) {
  if (!Array.isArray(waarde)) return null;
  const set = new Set();
  for (const v of waarde) {
    if (typeof v !== 'string' || !toegestaan.includes(v)) return null;
    set.add(v);
  }
  // Vaste volgorde: zo is de opgeslagen vorm stabiel, wat de klant ook aantikt.
  return toegestaan.filter((v) => set.has(v));
}

function valideerWaarde(sleutel, waarde) {
  if (KEUZES[sleutel]) {
    return (typeof waarde === 'string' && KEUZES[sleutel].includes(waarde)) ? { ok: true, waarde } : { ok: false };
  }
  if (sleutel === 'commitment_uren_per_week') {
    return (Number.isInteger(waarde) && waarde >= 1 && waarde <= 10) ? { ok: true, waarde } : { ok: false };
  }
  if (sleutel === 'robot_belmoment') {
    const s = subset(waarde, BELMOMENTEN);
    return s ? { ok: true, waarde: s } : { ok: false };
  }
  if (sleutel === 'beschikbaarheid') {
    if (!waarde || typeof waarde !== 'object' || Array.isArray(waarde)) return { ok: false };
    const uit = {};
    for (const [dag, delen] of Object.entries(waarde)) {
      if (!DAGEN.includes(dag)) return { ok: false };
      const s = subset(delen, DAGDELEN);
      if (!s) return { ok: false };
      uit[dag] = s;
    }
    return { ok: true, waarde: uit };
  }
  return { ok: false };
}

/**
 * Een patch van de website → { ok, schoon, fouten }.
 * fouten = lijst sleutels die niet mogen of niet kloppen.
 */
export function valideerPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, schoon: {}, fouten: ['answers'] };
  }
  const schoon = {};
  const fouten = [];
  for (const [sleutel, waarde] of Object.entries(patch)) {
    if (!PORTAL_SLEUTELS.includes(sleutel)) { fouten.push(sleutel); continue; }
    const r = valideerWaarde(sleutel, waarde);
    if (r.ok) schoon[sleutel] = r.waarde; else fouten.push(sleutel);
  }
  return { ok: fouten.length === 0, schoon, fouten };
}

/** Alleen de portal-sleutels uit onboardings.answers (die gaan naar de browser). */
export function portalAntwoorden(answers) {
  const a = (answers && typeof answers === 'object') ? answers : {};
  const uit = {};
  for (const k of PORTAL_SLEUTELS) {
    if (a[k] === undefined || a[k] === null) continue;
    // Oude wizard-waarden die de portal niet kent (bv. robot_interesse
    // 'laterbespreken', ervaring 'middelbaar') gaan niet mee: de klant kiest
    // dan opnieuw. Zo kan de portal nooit een waarde tonen die hij niet kan
    // terugschrijven.
    const r = valideerWaarde(k, a[k]);
    if (r.ok) uit[k] = r.waarde;
  }
  return uit;
}

function heeftWaarde(sleutel, v) {
  if (sleutel === 'beschikbaarheid') {
    return !!v && typeof v === 'object' && Object.values(v).some((d) => Array.isArray(d) && d.length > 0);
  }
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== '';
}

/** Welke verplichte sleutels ontbreken nog voor "Afronden"? */
export function ontbrekend(flow, answers) {
  const lijst = VERPLICHT[flow] || VERPLICHT['1op1'];
  const a = portalAntwoorden(answers);
  return lijst.filter((k) => !heeftWaarde(k, a[k]));
}

/** {voornaam, initialen} uit een volledige naam, of null. */
export function mentorKort(volledigeNaam) {
  const delen = String(volledigeNaam || '').trim().split(/\s+/).filter(Boolean);
  if (!delen.length) return null;
  const voornaam = delen[0];
  const initialen = (delen[0][0] + (delen.length > 1 ? delen[delen.length - 1][0] : '')).toUpperCase();
  return { voornaam, initialen };
}

/**
 * Wat er op de automation-kolommen moet komen na deze patch, of null als de
 * patch er niets aan verandert.
 *
 *   automation_interesse     'ja' | 'nee'
 *   automation_interesse_op  moment van de laatste WIJZIGING van ja/nee
 *   automation_belmoment     de gekozen belmomenten (alleen bij ja; bij nee leeg)
 */
export function automationVelden(vorige, samengevoegd, schoon, nu = new Date()) {
  const raakt = ('robot_interesse' in schoon) || ('robot_belmoment' in schoon);
  if (!raakt) return null;
  const nieuw = samengevoegd.robot_interesse;
  if (nieuw !== 'ja_interesse' && nieuw !== 'nee') return null;
  const interesse = nieuw === 'ja_interesse' ? 'ja' : 'nee';
  const velden = {
    automation_interesse: interesse,
    automation_belmoment: interesse === 'ja'
      ? (Array.isArray(samengevoegd.robot_belmoment) ? samengevoegd.robot_belmoment : [])
      : [],
  };
  if ((vorige || {}).robot_interesse !== nieuw) velden.automation_interesse_op = nu.toISOString();
  return velden;
}

// ── CORS ───────────────────────────────────────────────────────────────────
// Er gaat een sessie (het onboarding-token) over deze lijn: NOOIT '*', alleen
// reflecteren bij een exacte treffer. Al het andere krijgt geen
// Access-Control-Allow-Origin en de browser blokkeert zelf.

export const STANDAARD_ORIGINS = Object.freeze([
  'https://www.deforexopleiding.nl',
  'https://deforexopleiding.nl',
]);

// Vercel-previews van het website-project — zelfde strenge vorm als
// api/_lib/support-cors.js: projectnaam vooraan, ONZE team-slug achteraan.
const PREVIEW_ORIGIN =
  /^https:\/\/dfo-website-[a-z0-9-]+-de-forex-opleiding-bv-s-projects\.vercel\.app$/;

/** De toegestane origins: env ONBOARDING_PORTAL_ORIGINS (komma-lijst) of de standaard. */
export function portalOrigins(envWaarde = process.env.ONBOARDING_PORTAL_ORIGINS) {
  const raw = String(envWaarde || '').trim();
  if (!raw) return [...STANDAARD_ORIGINS];
  return raw.split(',').map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s));
}

/** Het origin om terug te geven, of null (= geen CORS-header). */
export function resolvePortalOrigin(origin, envWaarde = process.env.ONBOARDING_PORTAL_ORIGINS) {
  if (typeof origin !== 'string' || !origin) return null;
  if (portalOrigins(envWaarde).includes(origin)) return origin;
  if (PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}
