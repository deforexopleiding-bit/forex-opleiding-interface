// api/_lib/checkin-inzichten.js
//
// INZICHTEN VAN DE STUDENTENCHECK-IN (Maxim, 29 okt 2026) — wat de antwoorden
// samen zeggen, om de opleiding te verbeteren. PUUR: de rijen komen uit
// rijenVan() (checkin-beheer.js, met .ruw = de antwoorden), het endpoint is
// api/checkin-beheer.js (?inzichten=1) en voor het LMS de machine-route
// api/lms-checkin-inzichten.js. Eén rekenkern voor CRM én LMS.
//
// Alleen VERSTUURDE inzendingen tellen; testinzendingen enkel als je ze
// uitdrukkelijk meeneemt. Onder de 5 inzendingen: "te weinig antwoorden" — de
// cijfers staan er wel, het scherm zegt dat ze nog niets betekenen.

import {
  LABELS, VRAAG, ZEKERHEID_STAPPEN, GEBRUIK_ONDERDELEN, GEBRUIK_NIVEAU, flowVoor,
} from './checkin-portal.js';

export const MIN_BETROUWBAAR = 5;

/** De keuzevragen met een balkengrafiek, in de volgorde van de check-in. */
export const GRAFIEK_VRAGEN = Object.freeze([
  ['fase', 'keuze'], ['doel_3m', 'keuze'], ['trade_stand', 'keuze'], ['trades_vorige_maand', 'keuze'],
  ['journal_gebruik', 'keuze'], ['grootste_knelpunt', 'keuze'], ['live_moment', 'keuze'],
  ['helpt', 'meer'], ['knelpunt', 'meer'], ['hulp', 'keuze'], ['vooruithelpen', 'meer'],
  ['sessie_ritme', 'keuze'], ['feedback_concreet', 'keuze'], ['feedbackpanel', 'keuze'],
  ['payout', 'keuze'], ['begeleiding_contact', 'keuze'],
]);

const pct = (deel, geheel) => (geheel ? Math.round((deel / geheel) * 1000) / 10 : null);
const gem = (l) => (l.length ? Math.round((l.reduce((s, n) => s + n, 0) / l.length) * 10) / 10 : null);

/** Het traject van een rij: '1op1' of 'membership'. */
export function trajectVan(rij) {
  return flowVoor(rij?.product);
}

/**
 * De filter uit de query. Alles optioneel; onbekende waarden vallen weg.
 * @returns {{traject: ''|'1op1'|'membership', mentor: string, fase: string, trade_stand: string, test: boolean}}
 */
export function filterUit(q = {}) {
  const s = (v) => (typeof v === 'string' ? v.trim().slice(0, 64) : '');
  const traject = ['1op1', 'membership'].includes(s(q.traject)) ? s(q.traject) : '';
  const fase = LABELS.fase[s(q.fase)] ? s(q.fase) : '';
  const trade = LABELS.trade_stand[s(q.trade_stand)] ? s(q.trade_stand) : '';
  return { traject, mentor: s(q.mentor), fase, trade_stand: trade, test: s(q.test) === '1' };
}

/** Welke rijen tellen mee (verstuurd, filter, test). PUUR. */
export function filterRijen(rijen, f = {}) {
  return (rijen || []).filter((r) => {
    if (r.status !== 'verstuurd') return false;
    if (r.is_test && !f.test) return false;
    if (f.traject && trajectVan(r) !== f.traject) return false;
    if (f.mentor === 'geen' ? !!r.mentor_id : (f.mentor && String(r.mentor_id) !== f.mentor)) return false;
    const a = r.ruw || {};
    if (f.fase && a.fase !== f.fase) return false;
    if (f.trade_stand && a.trade_stand !== f.trade_stand) return false;
    return true;
  });
}

function balken(rijen, sleutel, soort) {
  const tel = new Map();
  let beantwoord = 0;
  for (const r of rijen) {
    const v = r.ruw?.[sleutel];
    const lijst = soort === 'meer' ? (Array.isArray(v) ? v : []) : (v == null || v === '' ? [] : [v]);
    if (!lijst.length) continue;
    beantwoord += 1;
    for (const x of lijst) tel.set(String(x), (tel.get(String(x)) || 0) + 1);
  }
  const labels = LABELS[sleutel] || {};
  const volgorde = Object.keys(labels);
  return {
    sleutel, vraag: VRAAG[sleutel] || sleutel, soort, beantwoord,
    //  Elke waarde die bestaat, ook met 0 — een lege balk zegt ook iets.
    balken: [...new Set([...volgorde, ...tel.keys()])].map((w) => ({
      waarde: w, label: labels[w] || w, aantal: tel.get(w) || 0, pct: pct(tel.get(w) || 0, beantwoord),
    })),
  };
}

/** Top-N van een vraag (aflopend, zonder nullen). */
function top(grafiek, n = 3) {
  return [...grafiek.balken].filter((b) => b.aantal > 0).sort((a, b) => b.aantal - a.aantal).slice(0, n);
}

/**
 * Alles voor het scherm Inzichten. PUUR.
 * @param {object[]} alleRijen rijenVan(...) van één campagne
 * @param {object} f filterUit(...)
 */
export function inzichten(alleRijen, f = {}) {
  const basis = (alleRijen || []).filter((r) => !r.is_test || f.test);
  const rijen = filterRijen(alleRijen, f);
  const n = rijen.length;

  //  KPI's — respons binnen dezelfde filter (zonder fase/trade_stand: die kennen we pas na het invullen).
  const doelgroep = basis.filter((r) => (!f.traject || trajectVan(r) === f.traject)
    && (f.mentor === 'geen' ? !r.mentor_id : (!f.mentor || String(r.mentor_id) === f.mentor)));
  const nps = rijen.map((r) => r.ruw?.nps).filter(Number.isInteger);
  const panel = rijen.filter((r) => r.ruw?.feedbackpanel);
  const kpi = {
    ingevuld: n,
    toegewezen: doelgroep.length,
    respons_pct: pct(rijen.length, doelgroep.length),
    nps_gemiddeld: gem(nps),
    nps_score: nps.length ? Math.round(((nps.filter((x) => x >= 9).length - nps.filter((x) => x <= 6).length) / nps.length) * 100) : null,
    feedbackpanel_ja_pct: pct(panel.filter((r) => r.ruw.feedbackpanel === 'ja').length, panel.length),
    mentor_score_gemiddeld: gem(rijen.map((r) => r.ruw?.mentor_score).filter(Number.isInteger)),
  };

  //  Zekerheid per trechterstap: gemiddelde + verdeling 1..5; de zwakste uitgelicht.
  const zekerheid = ZEKERHEID_STAPPEN.map((s) => {
    const w = rijen.map((r) => r.ruw?.zekerheid?.[s]).filter(Number.isInteger);
    return {
      stap: s, label: LABELS.zekerheid[s], aantal: w.length, gemiddelde: gem(w),
      verdeling: [1, 2, 3, 4, 5].map((k) => ({ score: k, aantal: w.filter((x) => x === k).length })),
      laag_pct: pct(w.filter((x) => x <= 2).length, w.length),
    };
  });
  const gescoord = zekerheid.filter((z) => z.gemiddelde != null);
  const zwakste = gescoord.length ? gescoord.reduce((m, z) => (z.gemiddelde < m.gemiddelde ? z : m)).stap : null;

  //  Gebruik per onderdeel (gestapeld vaak/soms/nooit) + top "waarom niet".
  const gebruik = GEBRUIK_ONDERDELEN.map((o) => {
    const w = rijen.map((r) => r.ruw?.gebruik?.[o]).filter((x) => GEBRUIK_NIVEAU.includes(x));
    const waarom = new Map();
    for (const r of rijen) {
      const x = r.ruw?.gebruik?.[o] === 'nooit' ? r.ruw?.gebruik_waarom_niet?.[o] : null;
      if (x) waarom.set(x, (waarom.get(x) || 0) + 1);
    }
    return {
      onderdeel: o, label: LABELS.gebruik[o], totaal: w.length,
      ...Object.fromEntries(GEBRUIK_NIVEAU.map((nv) => [nv, w.filter((x) => x === nv).length])),
      waarom_niet: [...waarom.entries()].sort((a, b) => b[1] - a[1])
        .map(([waarde, aantal]) => ({ waarde, label: LABELS.gebruik_waarom_niet[waarde] || waarde, aantal })),
    };
  }).filter((g) => g.totaal > 0 || g.onderdeel !== 'een_op_een');

  const vragen = GRAFIEK_VRAGEN.map(([k, soort]) => balken(rijen, k, soort));
  const per = Object.fromEntries(vragen.map((v) => [v.sleutel, v]));

  //  De open antwoorden, met wie (alleen voor hoofdmentor/admin — zie de endpoints).
  const open = rijen
    .filter((r) => r.ruw?.een_ding_veranderen || r.ruw?.verbeter)
    .map((r) => ({
      id: r.id, naam: r.naam, traject: trajectVan(r), mentor: r.mentor, verstuurd_op: r.verstuurd_op,
      fase: r.ruw?.fase || null, trade_stand: r.ruw?.trade_stand || null,
      tekst: r.ruw?.een_ding_veranderen || r.ruw?.verbeter, oud: !r.ruw?.een_ding_veranderen,
    }))
    .sort((a, b) => String(b.verstuurd_op || '').localeCompare(String(a.verstuurd_op || '')));

  //  De keuzes voor de filters (uit de hele campagne, niet uit de filter zelf).
  const mentoren = new Map();
  for (const r of basis) if (r.mentor_id) mentoren.set(String(r.mentor_id), r.mentor || 'Onbekende mentor');

  return {
    genoeg: n >= MIN_BETROUWBAAR,
    min: MIN_BETROUWBAAR,
    filter: f,
    kpi,
    zekerheid,
    zwakste,
    gebruik,
    vragen,
    top: {
      knelpunten: top(per.grootste_knelpunt),
      vooruithelpen: top(per.vooruithelpen),
      live_moment: top(per.live_moment, 4),
    },
    open,
    keuzes: {
      trajecten: [['1op1', '1-op-1'], ['membership', 'Membership']],
      mentoren: [...mentoren.entries()].sort((a, b) => a[1].localeCompare(b[1], 'nl')),
      fases: Object.entries(LABELS.fase),
      trade_standen: Object.entries(LABELS.trade_stand),
    },
  };
}
