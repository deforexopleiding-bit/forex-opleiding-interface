// api/_lib/checkin-beheer.js
//
// DE REKENKERN VAN DE CRM-SECTIE "STUDENTENCHECK-IN" — puur, getoetst in
// tests/checkin-beheer.test.js. Het endpoint api/checkin-beheer.js leest de
// tabellen (LMS + CRM) en geeft ze hieraan.
//
//   doelgroep()  wie krijgt een toewijzing bij Run, en wie niet (met reden)
//   rijenVan()   de tabel: één rij per toewijzing, met labels
//   kpi()        de KPI-strip (zonder testtoewijzingen)
//   perMentor()  gemiddelde NPS en mentorscore per mentor (mentor-audit)
//   payouts()    wie payout ja + delen ja koos (resultatenmuur)
//   csv()        de export
//
// DOELGROEP (opdracht 27 okt 2026):
//   hlms_student met auth_id, eind_datum ≥ vandaag, product mentorship of
//   membership. UITGESLOTEN: wie een CRM-onboarding heeft die nog loopt
//   (aangemeld of bezig, en NIET klaar) of in de laatste 30 dagen gestart is —
//   die deed net de nieuwe onboarding —, en de testaccounts. "Klaar" is de
//   gedeelde regel van onboarding-einde.js (28 okt 2026): status afgerond OF
//   met de hand OF door een sessie afgesloten — met de hand afgeronde
//   onboardings stonden nog op aangemeld/bezig en vielen zo ten onrechte uit.
//   OOK UITGESLOTEN (28 okt 2026, Maxim): wie de NIEUWE onboarding in de laatste
//   30 dagen gebruikte (onboardings.portal_gestart_op) — bv. begonnen in de oude
//   wizard in september, nieuwe onboarding volgende week: started_at is oud,
//   maar hij deed net de onboarding. BEWUST NIET completed_at: oude dossiers die
//   nu met de hand afgerond worden (sessies liepen al) krijgen de check-in wél.
//   De onboarding wordt gevonden via hlms_student.crm_onboarding_id én via
//   het e-mailadres van de klant (niet elke student is aan zijn onboarding
//   gekoppeld).

import { onboardingKlaar } from './onboarding-einde.js';
import { LABELS, VRAAG, signaalVoor } from './checkin-portal.js';

/**
 * De testaccounts: Maxims eigen studentlogins. Gemeten 27 okt 2026 in dfo-lms:
 * alleen maxim.delombaerde96@gmail.com heeft een hlms_student-rij (membership);
 * maxim@deforexopleiding.nl is een personeelsaccount (mentor) zonder studentrij.
 * Env CHECKIN_TESTACCOUNTS (komma-lijst) vervangt de lijst.
 */
export const STANDAARD_TESTACCOUNTS = Object.freeze(['maxim@deforexopleiding.nl', 'maxim.delombaerde96@gmail.com']);

export function testaccounts(envWaarde = process.env.CHECKIN_TESTACCOUNTS) {
  const raw = String(envWaarde || '').trim();
  const lijst = raw ? raw.split(',') : STANDAARD_TESTACCOUNTS;
  return lijst.map((e) => String(e).trim().toLowerCase()).filter((e) => /@/.test(e));
}

export const PRODUCTEN = Object.freeze(['mentorship', 'membership']);
export const RECENT_DAGEN = 30;

export const UITSLUIT_REDEN = Object.freeze({
  testaccount: 'Testaccount',
  onboarding_loopt: 'Onboarding loopt nog',
  onboarding_recent: 'Onboarding in de laatste 30 dagen gestart',
  onboarding_portal_recent: 'Nieuwe onboarding in de laatste 30 dagen ingevuld',
});

const lower = (s) => String(s || '').trim().toLowerCase();

/** YYYY-MM-DD van vandaag in Brussel. */
export function vandaag(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
}

/**
 * @param {object} p
 * @param {object[]} p.studenten   hlms_student-rijen (id, auth_id, email, voornaam, achternaam, product_soort, eind_datum, mentor_id, crm_onboarding_id)
 * @param {object[]} p.onboardings CRM onboardings (id, status, started_at, created_at, is_test, email)
 * @param {string[]} p.testEmails
 * @param {Date} [p.nu]
 * @returns {{ ontvangers: object[], uitgesloten: {student: object, reden: string}[] }}
 */
export function doelgroep({ studenten, onboardings, testEmails = testaccounts(), nu = new Date() }) {
  const dag = vandaag(nu);
  const grens = nu.getTime() - RECENT_DAGEN * 86400000;
  const tests = new Set((testEmails || []).map(lower));
  const perId = new Map();
  const perEmail = new Map();
  for (const o of onboardings || []) {
    if (o.is_test === true) continue;
    perId.set(String(o.id), o);
    const e = lower(o.email);
    if (e) (perEmail.get(e) || perEmail.set(e, []).get(e)).push(o);
  }
  const ontvangers = [];
  const uitgesloten = [];
  for (const s of studenten || []) {
    if (!s.auth_id) continue;
    if (!s.eind_datum || String(s.eind_datum).slice(0, 10) < dag) continue;
    if (!PRODUCTEN.includes(s.product_soort)) continue;
    if (tests.has(lower(s.email))) { uitgesloten.push({ student: s, reden: 'testaccount' }); continue; }
    const obs = [];
    if (s.crm_onboarding_id && perId.has(String(s.crm_onboarding_id))) obs.push(perId.get(String(s.crm_onboarding_id)));
    for (const o of perEmail.get(lower(s.email)) || []) if (!obs.includes(o)) obs.push(o);
    if (obs.some((o) => (o.status === 'aangemeld' || o.status === 'bezig') && !onboardingKlaar(o))) {
      uitgesloten.push({ student: s, reden: 'onboarding_loopt' }); continue;
    }
    const recent = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) && t >= grens; };
    if (obs.some((o) => recent(o.started_at) || recent(o.created_at))) {
      uitgesloten.push({ student: s, reden: 'onboarding_recent' }); continue;
    }
    if (obs.some((o) => recent(o.portal_gestart_op))) {
      uitgesloten.push({ student: s, reden: 'onboarding_portal_recent' }); continue;
    }
    ontvangers.push(s);
  }
  return { ontvangers, uitgesloten };
}

/** Tellingen voor het bevestigingsvenster van Run. */
export function doelgroepSamenvatting({ ontvangers, uitgesloten }, mentorNamen = new Map()) {
  const perProduct = { mentorship: 0, membership: 0 };
  const perMentor = new Map();
  for (const s of ontvangers) {
    perProduct[s.product_soort] = (perProduct[s.product_soort] || 0) + 1;
    const naam = s.mentor_id ? (mentorNamen.get(String(s.mentor_id)) || 'Onbekende mentor') : 'Geen mentor';
    perMentor.set(naam, (perMentor.get(naam) || 0) + 1);
  }
  const redenen = {};
  for (const u of uitgesloten) redenen[u.reden] = (redenen[u.reden] || 0) + 1;
  return {
    totaal: ontvangers.length,
    per_product: perProduct,
    per_mentor: [...perMentor.entries()].map(([naam, aantal]) => ({ naam, aantal })).sort((a, b) => b.aantal - a.aantal || a.naam.localeCompare(b.naam, 'nl')),
    uitgesloten: uitgesloten.map((u) => ({
      naam: [u.student.voornaam, u.student.achternaam].filter(Boolean).join(' ') || u.student.email,
      email: u.student.email,
      product: u.student.product_soort,
      reden: u.reden,
      reden_label: UITSLUIT_REDEN[u.reden] || u.reden,
    })),
    uitgesloten_per_reden: redenen,
  };
}

/** De regel zoals hij bij Run wordt vastgelegd (hlms_checkin_campagne.doelgroep_regel). */
export function doelgroepRegel(samenvatting, nu = new Date()) {
  return {
    regel: 'hlms_student met auth_id, eind_datum >= vandaag, product mentorship of membership',
    uitgesloten: 'CRM-onboarding loopt nog (aangemeld/bezig, niet klaar), in de laatste 30 dagen gestart (created_at/started_at) of de nieuwe onboarding in de laatste 30 dagen ingevuld (portal_gestart_op); testaccounts',
    peildatum: vandaag(nu),
    ontvangers: samenvatting.totaal,
    per_product: samenvatting.per_product,
    uitgesloten_per_reden: samenvatting.uitgesloten_per_reden,
  };
}

// ── Tabel ───────────────────────────────────────────────────────────────────

export function npsBand(n) {
  if (!Number.isInteger(n)) return null;
  return n <= 6 ? 'criticaster' : n <= 8 ? 'passief' : 'promotor';
}

function lbl(sleutel, waarde) {
  const m = LABELS[sleutel] || {};
  if (Array.isArray(waarde)) return waarde.map((v) => m[v] || v);
  return waarde == null ? null : (m[waarde] || waarde);
}

/** Alle antwoorden leesbaar (voor het detailvenster en de CSV). */
export function antwoordenLeesbaar(a) {
  const x = a || {};
  const rijen = [];
  const voeg = (k, v) => { if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length) && v !== '') rijen.push({ sleutel: k, vraag: VRAAG[k] || k, antwoord: v }); };
  voeg('fase', lbl('fase', x.fase));
  voeg('doel_3m', lbl('doel_3m', x.doel_3m));
  voeg('uren_per_week', Number.isInteger(x.uren_per_week) ? (x.uren_per_week === 10 ? '10+' : String(x.uren_per_week)) : null);
  voeg('payout', lbl('payout', x.payout));
  voeg('payout_delen', lbl('payout_delen', x.payout_delen));
  voeg('nps', Number.isInteger(x.nps) ? `${x.nps} / 10` : null);
  voeg('helpt', lbl('helpt', x.helpt));
  voeg('knelpunt', lbl('knelpunt', x.knelpunt));
  voeg('hulp', lbl('hulp', x.hulp));
  voeg('mentor_score', Number.isInteger(x.mentor_score) ? `${x.mentor_score} / 5` : null);
  voeg('begeleiding_contact', lbl('begeleiding_contact', x.begeleiding_contact));
  voeg('robot_interesse', lbl('robot_interesse', x.robot_interesse));
  voeg('robot_belmoment', lbl('robot_belmoment', x.robot_belmoment));
  voeg('robot_contact_tel', x.robot_contact_tel || null);
  voeg('robot_contact_email', x.robot_contact_email || null);
  voeg('verbeter', x.verbeter || null);
  return rijen;
}

/**
 * Eén rij per toewijzing.
 * @param {object} p
 * @param {object[]} p.toewijzingen  met .student (id, voornaam, achternaam, email, product_soort, mentor_id)
 * @param {Map<string,string>} p.mentorNamen  hlms_personeel.id → naam
 * @param {Map<string,object>} p.signalen    hlms_signaal.id → {id, status, zwaarte}
 * @param {Map<string,object>} p.kaarten     toewijzing_id → {id, status}
 */
export function rijenVan({ toewijzingen, mentorNamen = new Map(), signalen = new Map(), kaarten = new Map() }) {
  return (toewijzingen || []).map((t) => {
    const s = t.student || {};
    const a = (t.antwoorden && typeof t.antwoorden === 'object') ? t.antwoorden : {};
    const verstuurd = t.status === 'verstuurd';
    const sig = t.signaal_id ? signalen.get(String(t.signaal_id)) || { id: t.signaal_id } : null;
    const kaart = kaarten.get(String(t.id)) || null;
    // Wat een signaal zou geven, ook als het (nog) niet verstuurd is — voor de leesbaarheid.
    const verwacht = verstuurd ? signaalVoor(a) : null;
    return {
      id: t.id,
      student_id: t.student_id,
      naam: [s.voornaam, s.achternaam].filter(Boolean).join(' ') || s.email || '—',
      email: s.email || null,
      product: s.product_soort || null,
      mentor_id: s.mentor_id || null,
      mentor: s.mentor_id ? (mentorNamen.get(String(s.mentor_id)) || 'Onbekende mentor') : null,
      code: t.code,
      is_test: t.is_test === true,
      status: t.status,
      popup_gezien_op: t.popup_gezien_op || null,
      gestart_op: t.gestart_op || null,
      laatst_opgeslagen_op: t.laatst_opgeslagen_op || null,
      verstuurd_op: t.verstuurd_op || null,
      huidige_stap: t.huidige_stap ?? 0,
      inhoud_versie: t.inhoud_versie ?? null,
      nps: Number.isInteger(a.nps) ? a.nps : null,
      nps_band: npsBand(a.nps),
      mentor_score: Number.isInteger(a.mentor_score) ? a.mentor_score : null,
      fase: a.fase || null,
      fase_label: lbl('fase', a.fase),
      contact: a.begeleiding_contact || null,
      automation: a.robot_interesse || null,
      payout: a.payout || null,
      payout_delen: a.payout_delen || null,
      verbeter: a.verbeter || null,
      antwoorden: antwoordenLeesbaar(a),
      signaal: sig ? { id: sig.id, status: sig.status || null, zwaarte: sig.zwaarte || null } : null,
      signaal_redenen: verwacht ? verwacht.redenen : [],
      kaart: kaart ? { id: kaart.id, status: kaart.status || null } : null,
    };
  });
}

const pct = (deel, geheel) => (geheel ? Math.round((deel / geheel) * 1000) / 10 : null);

/** De KPI-strip. Testtoewijzingen tellen niet mee (tenzij je ze zelf filtert). */
export function kpi(rijen) {
  const r = (rijen || []).filter((x) => !x.is_test);
  const verstuurd = r.filter((x) => x.status === 'verstuurd');
  const nps = verstuurd.map((x) => x.nps).filter((n) => Number.isInteger(n));
  const promotors = nps.filter((n) => n >= 9).length;
  const criticasters = nps.filter((n) => n <= 6).length;
  return {
    toegewezen: r.length,
    popup_gezien: r.filter((x) => x.popup_gezien_op).length,
    gestart: r.filter((x) => x.gestart_op || x.status !== 'niet_gestart').length,
    verstuurd: verstuurd.length,
    verstuurd_pct: pct(verstuurd.length, r.length),
    nps_score: nps.length ? Math.round(((promotors - criticasters) / nps.length) * 100) : null,
    nps_gemiddeld: nps.length ? Math.round((nps.reduce((s, n) => s + n, 0) / nps.length) * 10) / 10 : null,
    nps_aantal: nps.length,
    begeleidingssignalen: r.filter((x) => x.signaal).length,
    automation_interesse: r.filter((x) => x.automation === 'ja_interesse').length,
  };
}

/** Gemiddelde NPS en mentorscore per mentor (alleen verstuurd, zonder test). */
export function perMentor(rijen) {
  const m = new Map();
  for (const x of rijen || []) {
    if (x.is_test) continue;
    const sleutel = x.mentor_id || '—';
    const e = m.get(sleutel) || { mentor_id: x.mentor_id, mentor: x.mentor || 'Geen mentor', toegewezen: 0, verstuurd: 0, nps: [], score: [] };
    e.toegewezen += 1;
    if (x.status === 'verstuurd') {
      e.verstuurd += 1;
      if (Number.isInteger(x.nps)) e.nps.push(x.nps);
      if (Number.isInteger(x.mentor_score)) e.score.push(x.mentor_score);
    }
    m.set(sleutel, e);
  }
  const gem = (l) => (l.length ? Math.round((l.reduce((s, n) => s + n, 0) / l.length) * 10) / 10 : null);
  return [...m.values()].map((e) => ({
    mentor_id: e.mentor_id, mentor: e.mentor, toegewezen: e.toegewezen, verstuurd: e.verstuurd,
    nps_gemiddeld: gem(e.nps), mentor_score_gemiddeld: gem(e.score), antwoorden_nps: e.nps.length,
  })).sort((a, b) => (b.verstuurd - a.verstuurd) || String(a.mentor).localeCompare(String(b.mentor), 'nl'));
}

/** Wie wil zijn payout (zonder naam) laten delen? */
export function payouts(rijen) {
  return (rijen || [])
    .filter((x) => !x.is_test && x.status === 'verstuurd' && (x.payout === 'ja_eerste' || x.payout === 'ja_meerdere') && x.payout_delen === 'ja')
    .map((x) => ({ id: x.id, naam: x.naam, email: x.email, product: x.product, mentor: x.mentor, payout: x.payout, payout_label: lbl('payout', x.payout), verstuurd_op: x.verstuurd_op }));
}

// ── CSV ─────────────────────────────────────────────────────────────────────
const CSV_KOLOMMEN = [
  ['naam', 'Naam'], ['email', 'E-mail'], ['product', 'Product'], ['mentor', 'Mentor'], ['status', 'Status'],
  ['verstuurd_op', 'Verstuurd op'],
];

function csvVeld(v) {
  const s = Array.isArray(v) ? v.join(' | ') : (v == null ? '' : String(v));
  // Formules in Excel neutraliseren (= + - @ vooraan).
  const veilig = /^[=+\-@]/.test(s) ? "'" + s : s;
  return /[";\n\r]/.test(veilig) ? '"' + veilig.replace(/"/g, '""') + '"' : veilig;
}

/** De export: één regel per toewijzing, met alle antwoorden leesbaar. Puntkomma (Excel NL/BE). */
export function csv(rijen) {
  const vragen = ['fase', 'doel_3m', 'uren_per_week', 'payout', 'payout_delen', 'nps', 'helpt', 'knelpunt', 'hulp', 'mentor_score', 'begeleiding_contact', 'robot_interesse', 'robot_belmoment', 'robot_contact_tel', 'robot_contact_email', 'verbeter'];
  const kop = [...CSV_KOLOMMEN.map(([, l]) => l), ...vragen.map((k) => VRAAG[k] || k), 'Begeleidingssignaal', 'Automation-kaart'];
  const regels = [kop.map(csvVeld).join(';')];
  for (const x of rijen || []) {
    const per = new Map(x.antwoorden.map((a) => [a.sleutel, a.antwoord]));
    regels.push([
      ...CSV_KOLOMMEN.map(([k]) => x[k]),
      ...vragen.map((k) => per.get(k) ?? ''),
      x.signaal ? (x.signaal.zwaarte || 'ja') : '',
      x.kaart ? (x.kaart.status || 'ja') : '',
    ].map(csvVeld).join(';'));
  }
  return '﻿' + regels.join('\r\n') + '\r\n';
}

/** Campagne-opties schoonmaken (alleen de drie bekende booleans). */
export function schoneOpties(o) {
  const x = (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  const uit = {};
  for (const k of ['payout_vraag', 'trustpilot_vraag', 'autopilot_stap']) {
    if (typeof x[k] === 'boolean') uit[k] = x[k];
  }
  return uit;
}

/** Mag Run? Grijs zolang er geen geslaagde testinzending in deze campagne is. */
export function runStand(campagne, toewijzingen) {
  const testOk = (toewijzingen || []).some((t) => t.is_test === true && !!t.verstuurd_op);
  if (!campagne) return { mag: false, reden: 'Geen campagne.' };
  if (campagne.status === 'live' || campagne.status === 'gepauzeerd') return { mag: false, reden: 'Al geactiveerd.', test_ok: testOk };
  if (campagne.status === 'gesloten') return { mag: false, reden: 'De campagne is gesloten.', test_ok: testOk };
  if (campagne.status !== 'test') return { mag: false, reden: 'Maak eerst testtoewijzingen aan en verstuur een testinzending.', test_ok: testOk };
  if (!testOk) return { mag: false, reden: 'Nog geen geslaagde testinzending in deze campagne.', test_ok: false };
  return { mag: true, reden: null, test_ok: true };
}
