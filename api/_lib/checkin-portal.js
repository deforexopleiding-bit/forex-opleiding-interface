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

import { BELMOMENTEN, TRAJECT_NAAM, valideerContact } from './onboarding-portal.js';

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

// ── UITBREIDING 29 okt 2026 (Maxim keurde goed): meetbare input ─────────────
// Blok 1 · waar sta je
export const TRADE_STAND = Object.freeze(['niet_gestart', 'demo', 'eigen_live', 'challenge_bezig', 'funded']);
export const TRADES_VORIGE_MAAND = Object.freeze(['0', '1_5', '6_15', '15_plus']);
export const JOURNAL_GEBRUIK = Object.freeze(['altijd', 'soms', 'nooit']);
// Blok 2 · de methode: zekerheid 1–5 per trechterstap
export const ZEKERHEID_STAPPEN = Object.freeze(['h4_impuls', 'fib_71', 'bevestiging_15m', 'risk', 'discipline']);
export const GROOTSTE_KNELPUNT = Object.freeze(['strategie', 'geduld_discipline', 'emoties_na_verlies', 'tijd', 'risk_management', 'propfirm_regels', 'weet_niet_waar_beginnen']);
// Blok 3 · wat gebruik je van ons ('een_op_een' alleen in de 1-op-1-flow)
export const GEBRUIK_ONDERDELEN = Object.freeze(['live_sessies', 'sunday_markups', 'opgenomen_trainingen', 'trade_recaps', 'lessen_pdfs', 'discord', 'journal_lms', 'the_lab', 'een_op_een']);
export const GEBRUIK_NIVEAU = Object.freeze(['vaak', 'soms', 'nooit']);
export const WAAROM_NIET = Object.freeze(['wist_niet', 'tijdstip_past_niet', 'te_moeilijk', 'niet_nuttig']);
export const LIVE_MOMENT = Object.freeze(['weekavond', 'zaterdag', 'zondagochtend', 'maakt_niet_uit']);
// Blok 4 · ervaring & begeleiding
export const SESSIE_RITME = Object.freeze(['te_weinig', 'goed', 'te_veel']);
export const FEEDBACK_CONCREET = Object.freeze(['ja', 'soms', 'nee']);
export const VOORUITHELPEN = Object.freeze(['feedback_eigen_trades', 'live_meetraden', 'oefeningen_backtesten', 'propfirm_begeleiding', 'psychologie_routine', 'studiebuddy', 'kortere_videos', 'stappenplan_beginners']);
export const MAX_VOORUITHELPEN = 2;
export const MAX_EEN_DING = 500;

/** De onderdelen van het gebruik-raster voor deze flow. */
export function gebruikOnderdelen(flow) {
  return flow === '1op1' ? GEBRUIK_ONDERDELEN : GEBRUIK_ONDERDELEN.filter((o) => o !== 'een_op_een');
}

/** De standaardopties van een campagne (hlms_checkin_campagne.opties). */
export const STANDAARD_OPTIES = Object.freeze({ payout_vraag: true, trustpilot_vraag: false, autopilot_stap: true });
export const TRUSTPILOT_URL = 'https://nl.trustpilot.com/evaluate/deforexopleiding.nl';

/** Alle sleutels die de portal kan schrijven. */
export const CHECKIN_SLEUTELS = Object.freeze([
  'fase', 'doel_3m', 'uren_per_week', 'payout', 'payout_delen', 'nps', 'helpt', 'knelpunt',
  'verbeter', 'hulp', 'mentor_score', 'begeleiding_contact', 'robot_interesse', 'robot_belmoment',
  'robot_contact_tel', 'robot_contact_email',
  // Uitbreiding 29 okt 2026
  'trade_stand', 'trades_vorige_maand', 'journal_gebruik', 'zekerheid', 'grootste_knelpunt',
  'gebruik', 'gebruik_waarom_niet', 'live_moment', 'sessie_ritme', 'feedback_concreet',
  'vooruithelpen', 'een_ding_veranderen', 'feedbackpanel',
]);

/** Sleutels die alleen in de 1-op-1-flow bestaan. */
export const ALLEEN_1OP1 = Object.freeze(['mentor_score', 'sessie_ritme', 'feedback_concreet']);

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
  trade_stand: { niet_gestart: 'Nog niet gestart met traden', demo: 'Demo', eigen_live: 'Live met eigen geld', challenge_bezig: 'Bezig met een challenge', funded: 'Funded' },
  trades_vorige_maand: { 0: '0', '1_5': '1–5', '6_15': '6–15', '15_plus': '15+' },
  journal_gebruik: { altijd: 'Altijd', soms: 'Soms', nooit: 'Nooit' },
  zekerheid: { h4_impuls: 'H4-context & geldige impuls', fib_71: 'Fibonacci & de 71%-zone', bevestiging_15m: '15M-bevestiging (sweep, BOS, volume)', risk: 'Stop, target & positiegrootte (1%, 1:3)', discipline: 'Discipline: wachten, geen trades rond nieuws of na 21u' },
  grootste_knelpunt: { strategie: 'De strategie zelf', geduld_discipline: 'Geduld & discipline', emoties_na_verlies: 'Emoties na een verlies', tijd: 'Tijd', risk_management: 'Risk management', propfirm_regels: 'De regels van de propfirm', weet_niet_waar_beginnen: 'Ik weet niet waar te beginnen' },
  gebruik: { live_sessies: 'Live sessies (do 19u / zo 10u)', sunday_markups: 'Sunday mark-ups', opgenomen_trainingen: 'Opgenomen trainingen', trade_recaps: 'Trade recaps', lessen_pdfs: "Lessen & pdf's", discord: 'Discord', journal_lms: 'Journal in het LMS', the_lab: 'The Lab', een_op_een: '1-op-1 sessies' },
  gebruik_niveau: { vaak: 'Vaak', soms: 'Soms', nooit: 'Nooit' },
  gebruik_waarom_niet: { wist_niet: 'Wist niet dat het bestond', tijdstip_past_niet: 'Tijdstip past niet', te_moeilijk: 'Te moeilijk', niet_nuttig: 'Niet nuttig voor mij' },
  live_moment: { weekavond: 'Een weekavond', zaterdag: 'Zaterdag', zondagochtend: 'Zondagochtend', maakt_niet_uit: 'Maakt niet uit' },
  sessie_ritme: { te_weinig: 'Te weinig', goed: 'Goed', te_veel: 'Te veel' },
  feedback_concreet: { ja: 'Ja', soms: 'Soms', nee: 'Nee' },
  vooruithelpen: { feedback_eigen_trades: 'Feedback op mijn eigen trades', live_meetraden: 'Live meetraden', oefeningen_backtesten: 'Oefeningen & backtesten', propfirm_begeleiding: 'Begeleiding bij de propfirm', psychologie_routine: 'Psychologie & routine', studiebuddy: 'Een studiebuddy', kortere_videos: "Kortere video's", stappenplan_beginners: 'Een stappenplan voor beginners' },
  feedbackpanel: { ja: 'Ja, graag', nee: 'Liever niet' },
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
  robot_contact_tel: 'Ander nummer (Autopilot)',
  robot_contact_email: 'Ander e-mailadres (Autopilot)',
  trade_stand: 'Waar sta je met traden?',
  trades_vorige_maand: 'Trades vorige maand',
  journal_gebruik: 'Journal bijhouden',
  zekerheid: 'Zekerheid per stap (1-5)',
  grootste_knelpunt: 'Grootste knelpunt',
  gebruik: 'Gebruik per onderdeel',
  gebruik_waarom_niet: 'Waarom niet',
  live_moment: 'Beste moment voor live',
  sessie_ritme: 'Ritme van de sessies',
  feedback_concreet: 'Feedback concreet genoeg',
  vooruithelpen: 'Zou vooruithelpen',
  een_ding_veranderen: 'Eén ding veranderen',
  feedbackpanel: 'Feedbackpanel',
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

/** Een object met enkel toegelaten sleutels en geldige waarden, in vaste volgorde. */
function objectVan(waarde, sleutels, geldig) {
  if (!waarde || typeof waarde !== 'object' || Array.isArray(waarde)) return { ok: false };
  for (const [k, v] of Object.entries(waarde)) {
    if (!sleutels.includes(k) || !geldig(v)) return { ok: false };
  }
  const uit = {};
  for (const k of sleutels) if (waarde[k] !== undefined) uit[k] = waarde[k];
  return { ok: true, waarde: uit };
}

/** De sleutels van de Autopilot-stap — alleen als de campagne hem aanzet. */
export const AUTOPILOT_SLEUTELS = Object.freeze(['robot_interesse', 'robot_belmoment', 'robot_contact_tel', 'robot_contact_email']);

/** Mag deze sleutel in deze flow/opties? */
function sleutelMag(sleutel, flow, opties) {
  if (ALLEEN_1OP1.includes(sleutel)) return flow === '1op1';
  if (sleutel === 'payout' || sleutel === 'payout_delen') return opties.payout_vraag;
  if (AUTOPILOT_SLEUTELS.includes(sleutel)) return opties.autopilot_stap;
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
    case 'robot_contact_tel':
    case 'robot_contact_email': return valideerContact(sleutel, waarde);
    case 'robot_belmoment': {
      const s = subset(waarde, BELMOMENTEN);
      return s ? { ok: true, waarde: s } : { ok: false };
    }
    case 'verbeter': {
      if (typeof waarde !== 'string') return { ok: false };
      const t = waarde.replace(/\u0000/g, '').trim();
      return t.length <= MAX_VERBETER ? { ok: true, waarde: t } : { ok: false };
    }
    case 'een_ding_veranderen': {
      if (typeof waarde !== 'string') return { ok: false };
      const t = waarde.replace(/\u0000/g, '').trim();
      return t.length <= MAX_EEN_DING ? { ok: true, waarde: t } : { ok: false };
    }
    case 'trade_stand': return TRADE_STAND.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'trades_vorige_maand': return TRADES_VORIGE_MAAND.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'journal_gebruik': return JOURNAL_GEBRUIK.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'grootste_knelpunt': return GROOTSTE_KNELPUNT.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'live_moment': return LIVE_MOMENT.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'sessie_ritme': return SESSIE_RITME.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'feedback_concreet': return FEEDBACK_CONCREET.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'feedbackpanel': return JA_NEE.includes(waarde) ? { ok: true, waarde } : { ok: false };
    case 'vooruithelpen': {
      const s = subset(waarde, VOORUITHELPEN, MAX_VOORUITHELPEN);
      return s ? { ok: true, waarde: s } : { ok: false };
    }
    // De objecten: elk deel apart gecontroleerd, in een vaste volgorde. Een
    // deelobject mag tijdens het invullen (bewaren); volledig is pas bij versturen nodig.
    case 'zekerheid': return objectVan(waarde, ZEKERHEID_STAPPEN, (v) => geheel(v, 1, 5));
    case 'gebruik': return objectVan(waarde, gebruikOnderdelen(flow), (v) => GEBRUIK_NIVEAU.includes(v));
    case 'gebruik_waarom_niet': return objectVan(waarde, gebruikOnderdelen(flow), (v) => WAAROM_NIET.includes(v));
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
  // Belmoment en een ander nummer/e-mail alleen bij "ja"; leeg = niet opgegeven.
  if (uit.robot_interesse !== 'ja_interesse') {
    delete uit.robot_belmoment; delete uit.robot_contact_tel; delete uit.robot_contact_email;
  }
  if (uit.robot_contact_tel === '') delete uit.robot_contact_tel;
  if (uit.robot_contact_email === '') delete uit.robot_contact_email;
  // "Waarom niet" alleen voor wat op "nooit" staat.
  if (uit.gebruik_waarom_niet) {
    const w = {};
    for (const [k, v] of Object.entries(uit.gebruik_waarom_niet)) if (uit.gebruik?.[k] === 'nooit') w[k] = v;
    if (Object.keys(w).length) uit.gebruik_waarom_niet = w; else delete uit.gebruik_waarom_niet;
  }
  if (uit.een_ding_veranderen === '') delete uit.een_ding_veranderen;
  return uit;
}

/** Verplicht bij versturen, per flow en opties. */
export function verplicht(flow, opties = STANDAARD_OPTIES) {
  const o = { ...STANDAARD_OPTIES, ...opties };
  const lijst = ['fase', 'doel_3m', 'trade_stand', 'trades_vorige_maand', 'journal_gebruik',
    'zekerheid', 'grootste_knelpunt', 'gebruik', 'gebruik_waarom_niet', 'live_moment',
    'nps', 'knelpunt', 'hulp', 'vooruithelpen', 'feedbackpanel', 'begeleiding_contact'];
  if (flow === '1op1') lijst.push('mentor_score', 'sessie_ritme', 'feedback_concreet');
  if (o.autopilot_stap) lijst.push('robot_interesse');
  return lijst;
}

/** Welke verplichte sleutels ontbreken nog? De objecten moeten VOLLEDIG zijn. */
export function ontbrekend(flow, opties, antwoorden) {
  const a = schoneAntwoorden(antwoorden, { flow, opties });
  return verplicht(flow, opties).filter((k) => {
    const v = a[k];
    if (k === 'zekerheid') return ZEKERHEID_STAPPEN.some((s) => !Number.isInteger(v?.[s]));
    if (k === 'gebruik') return gebruikOnderdelen(flow).some((o) => !v?.[o]);
    // Per onderdeel op "nooit" één reden; niets op "nooit" = niets te vragen.
    if (k === 'gebruik_waarom_niet') {
      return gebruikOnderdelen(flow).some((o) => a.gebruik?.[o] === 'nooit' && !v?.[o]);
    }
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || v === '';
  });
}

// ── Het begeleidingssignaal naar de hoofdmentor ─────────────────────────────
const RANG = { geel: 1, oranje: 2, rood: 3 };

/** De trechterstappen met zekerheid ≤ 2, in vaste volgorde. PUUR. */
export function zwakkeStappen(zekerheid) {
  const z = zekerheid && typeof zekerheid === 'object' ? zekerheid : {};
  return ZEKERHEID_STAPPEN.filter((s) => Number.isInteger(z[s]) && z[s] <= 2);
}

/**
 * Moet er een begeleidingssignaal komen, en hoe zwaar? PUUR.
 *   · begeleiding_contact = ja            → oranje
 *   · nps ≤ 6                             → geel (rood bij ≤ 3)
 *   · mentor_score ≤ 2                    → oranje
 *   · knelpunt bevat 'volgende_stap'      → geel
 *   · grootste_knelpunt weet_niet_waar_beginnen → geel
 *   · zekerheid ≤ 2 op ≥ 3 trechterstappen → geel
 *   · sessie_ritme te_weinig / feedback_concreet nee (1-op-1) → oranje
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
  // Uitbreiding 29 okt 2026 — dezelfde kaart, extra redenen.
  if (a.grootste_knelpunt === 'weet_niet_waar_beginnen') treffers.push(['geel', 'Weet niet waar te beginnen']);
  const zwak = zwakkeStappen(a.zekerheid);
  if (zwak.length >= 3) {
    treffers.push(['geel', `Weinig zekerheid over de methode (≤ 2 op ${zwak.length} stappen: ${zwak.map((s) => LABELS.zekerheid[s]).join(', ')})`]);
  }
  if (a.sessie_ritme === 'te_weinig') treffers.push(['oranje', 'Vindt het sessieritme te laag']);
  if (a.feedback_concreet === 'nee') treffers.push(['oranje', 'Vindt de feedback niet concreet']);
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
  if (a.trade_stand) b[VRAAG.trade_stand] = label('trade_stand', a.trade_stand);
  if (a.grootste_knelpunt) b[VRAAG.grootste_knelpunt] = label('grootste_knelpunt', a.grootste_knelpunt);
  const zwak = zwakkeStappen(a.zekerheid);
  if (zwak.length) b['Weinig zekerheid (≤ 2)'] = zwak.map((s) => `${LABELS.zekerheid[s]}: ${a.zekerheid[s]}`);
  if (a.sessie_ritme) b[VRAAG.sessie_ritme] = label('sessie_ritme', a.sessie_ritme);
  if (a.feedback_concreet) b[VRAAG.feedback_concreet] = label('feedback_concreet', a.feedback_concreet);
  if (a.vooruithelpen?.length) b[VRAAG.vooruithelpen] = label('vooruithelpen', a.vooruithelpen);
  if (a.verbeter) b[VRAAG.verbeter] = a.verbeter;
  if (a.een_ding_veranderen) b[VRAAG.een_ding_veranderen] = a.een_ding_veranderen;
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
