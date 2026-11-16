// api/_lib/trustpilot-overzicht.js
//
// TRUSTPILOT "KERST 2026" — het overzicht in het CRM (Maxim, 16 nov 2026).
// PUUR: de rijen komen uit het LMS (dfo-lms `hlms_trustpilot_campagne`,
// `hlms_trustpilot_status`, `hlms_student`), het endpoint is
// api/trustpilot-reviews.js.
//
// Het LMS toont een pop-up (wegklikbaar) en een banner; wie bevestigt dat zijn
// review online staat, geeft de naam waaronder die op Trustpilot staat. Per 10
// bevestigde reviews verloot Maxim een 25k funded account — de loting doet hij
// ZELF, buiten het platform. Hier: wie bevestigde, onder welke naam, en een
// export van die namen.
//
// REGELS
//   · Doelgroep = student met login, eind_datum ≥ vandaag (Brussel), product
//     mentorship of membership, geen personeel (rol admin/hoofdmentor/mentor),
//     geen testaccount. Dezelfde regel als hlms_trustpilot_doelgroep() in het LMS.
//   · Een student met een statusrij staat er altijd in (ook als zijn toegang
//     intussen verliep: een geplaatste review blijft geplaatst).
//   · Testaccounts (rij is_test, of e-mail in campagne.test_emails) tellen
//     NERGENS mee; ze staan enkel in de tabel als je ze uitdrukkelijk toont.

export const CAMPAGNE_SLUG = 'trustpilot-kerst-2026';
export const STATUSSEN = Object.freeze(['nog_niet_gezien', 'later', 'niet_meer_tonen', 'geplaatst']);
export const STATUS_LABEL = Object.freeze({
  nog_niet_gezien: 'Nog niet gezien',
  later: 'Later',
  niet_meer_tonen: 'Niet meer tonen',
  geplaatst: 'Geplaatst',
});
export const PRODUCTEN = Object.freeze(['mentorship', 'membership']);
export const PERSONEEL_ROLLEN = Object.freeze(['admin', 'hoofdmentor', 'mentor']);

const laag = (s) => String(s || '').trim().toLowerCase();

/** Vandaag in Brussel, YYYY-MM-DD. */
export function vandaagBrussel(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nu);
}

/** Wie heeft nu een personeelsrol (auth_id's)? */
export function personeelAuthIds(rollen, nu = new Date()) {
  const ids = new Set();
  for (const r of rollen || []) {
    if (!PERSONEEL_ROLLEN.includes(r.rol)) continue;
    if (r.geldig_tot && new Date(r.geldig_tot).getTime() <= nu.getTime()) continue;
    if (r.auth_id) ids.add(String(r.auth_id));
  }
  return ids;
}

/** Hoort deze student bij de doelgroep (zonder de testregel)? */
export function inDoelgroep(s, { vandaag, personeel }) {
  return !!(s && s.auth_id && s.eind_datum && String(s.eind_datum) >= vandaag
    && PRODUCTEN.includes(s.product_soort) && !personeel.has(String(s.auth_id)));
}

/**
 * Eén rij per student: de doelgroep + iedereen met een statusrij. PUUR.
 * @param {{studenten: object[], statussen: object[], mentorNamen?: Map, testEmails?: string[], personeel?: Set, vandaag: string}} p
 */
export function bouwRijen({ studenten, statussen, mentorNamen = new Map(), testEmails = [], personeel = new Set(), vandaag }) {
  const test = new Set((testEmails || []).map(laag));
  const perStudent = new Map((statussen || []).map((t) => [String(t.student_id), t]));
  const rijen = [];
  for (const s of studenten || []) {
    const t = perStudent.get(String(s.id)) || null;
    const doelgroep = inDoelgroep(s, { vandaag, personeel });
    if (!doelgroep && !t) continue;
    const isTest = !!(t?.is_test) || test.has(laag(s.email));
    rijen.push({
      student_id: s.id,
      naam: [s.voornaam, s.achternaam].filter(Boolean).join(' ') || s.email || '—',
      email: s.email || null,
      traject: s.product_soort === 'mentorship' ? '1-op-1' : s.product_soort === 'membership' ? 'Membership' : (s.product_soort || '—'),
      mentor: s.mentor_id ? (mentorNamen.get(String(s.mentor_id)) || 'Onbekende mentor') : null,
      status: t?.status || 'nog_niet_gezien',
      trustpilot_naam: t?.trustpilot_naam || null,
      bevestigd_op: t?.bevestigd_op || null,
      keer_getoond: t?.keer_getoond || 0,
      eerst_getoond_op: t?.eerst_getoond_op || null,
      laatst_getoond_op: t?.laatst_getoond_op || null,
      keer_later: t?.keer_later || 0,
      laatst_later_op: t?.laatst_later_op || null,
      review_link_geklikt_op: t?.review_link_geklikt_op || null,
      niet_meer_tonen_op: t?.niet_meer_tonen_op || null,
      is_test: isTest,
      in_doelgroep: doelgroep && !isTest,
      heeft_rij: !!t,
    });
  }
  return rijen.sort((a, b) => String(b.bevestigd_op || '').localeCompare(String(a.bevestigd_op || '')) || a.naam.localeCompare(b.naam, 'nl'));
}

/** De tegels — zonder testaccounts. PUUR. */
export function tegels(rijen, perAantal = 10) {
  const echt = (rijen || []).filter((r) => !r.is_test);
  const tel = (st) => echt.filter((r) => r.status === st).length;
  const per = Number.isInteger(perAantal) && perAantal > 0 ? perAantal : 10;
  const geplaatst = tel('geplaatst');
  return {
    doelgroep: echt.filter((r) => r.in_doelgroep).length,
    nog_niet_gezien: tel('nog_niet_gezien'),
    later: tel('later'),
    niet_meer_tonen: tel('niet_meer_tonen'),
    geplaatst,
    link_geklikt: echt.filter((r) => r.review_link_geklikt_op).length,
    per_aantal: per,
    te_verloten: Math.floor(geplaatst / per),
    nog_tot_volgende: per - (geplaatst % per),
  };
}

/** "Volledige naam (Trustpilot-naam)" per geplaatste review, geen testaccounts. PUUR. */
export function lotingNamen(rijen) {
  return (rijen || [])
    .filter((r) => !r.is_test && r.status === 'geplaatst')
    .sort((a, b) => String(a.bevestigd_op || '').localeCompare(String(b.bevestigd_op || '')))
    .map((r) => `${r.naam} (${r.trustpilot_naam || '—'})`);
}

const CSV_KOLOMMEN = Object.freeze([
  ['naam', 'Naam'], ['email', 'E-mail'], ['traject', 'Traject'], ['mentor', 'Mentor'],
  ['status', 'Status'], ['trustpilot_naam', 'Trustpilot-naam'], ['bevestigd_op', 'Bevestigd op'],
  ['keer_getoond', 'Keer getoond'], ['eerst_getoond_op', 'Eerst getoond'], ['laatst_getoond_op', 'Laatst getoond'],
  ['keer_later', 'Keer later'], ['laatst_later_op', 'Laatst later'], ['review_link_geklikt_op', 'Reviewlink geklikt'],
  ['niet_meer_tonen_op', 'Niet meer tonen op'], ['in_doelgroep', 'In doelgroep'], ['is_test', 'Testaccount'],
]);

function csvVeld(v) {
  if (v == null) return '';
  let s = typeof v === 'boolean' ? (v ? 'ja' : 'nee') : String(v);
  //  Geen formules in Excel (=, +, -, @ vooraan).
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** CSV van alles (; als scheiding, BOM voor Excel). PUUR. */
export function csv(rijen) {
  const regels = [CSV_KOLOMMEN.map(([, l]) => l).join(';')];
  for (const r of rijen || []) {
    regels.push(CSV_KOLOMMEN.map(([k]) => csvVeld(k === 'status' ? (STATUS_LABEL[r.status] || r.status) : r[k])).join(';'));
  }
  return '﻿' + regels.join('\r\n') + '\r\n';
}
