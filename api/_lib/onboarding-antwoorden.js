// api/_lib/onboarding-antwoorden.js
//
// DE ONBOARDING-ANTWOORDEN VOOR HET LMS (28 okt 2026). PUUR.
//
// De nieuwe onboarding (www.deforexopleiding.nl/onboarding, api/onboarding-
// portal.js) vervangt de klassieke wizard. Het LMS toonde tot nu alleen
// "stap X van Y" uit de klassieke wizard en geen enkel antwoord. Hier staat
// wat het LMS ervan te zien krijgt, op één plek:
//
//   · de portalstand: niet_gestart · bezig · afgerond (+ wanneer afgerond);
//   · de stappen van de NIEUWE flow — 1-op-1: locatie, jij, beschikbaar,
//     extra (4); membership: jij, extra (2). Dezelfde schermen en dezelfde
//     "klaar"-regel als de website (dfo-website lib/onboarding-portal.ts,
//     FLOWS + stapKlaar);
//   · de antwoorden: coachingvoorkeur, ervaring, motivatie, uren per week,
//     beschikbaarheid (7 dagen × 4 dagdelen) en de Autopilot-interesse.
//
// ── WAAROM DE STAP UIT DE ANTWOORDEN KOMT EN NIET UIT current_step ────────
// Gemeten op 28 okt 2026: onboardings die in de klassieke wizard begonnen,
// dragen current_step 6 of 9 (pagina's van die wizard). In de nieuwe flow
// betekent hetzelfde getal een ander scherm. De antwoorden zelf delen wél
// dezelfde sleutels (onboarding-portal.js), dus tellen we wat er ingevuld
// is. Zo klopt de voortgang voor beide, zonder te raden welke wizard het was.
//
// ── NIETS VERZINNEN ───────────────────────────────────────────────────────
// Een waarde die er niet is, is `null`. Een oude wizardwaarde die de portal
// niet kent (bv. ervaring 'middelbaar') gaat ongewijzigd mee: het LMS toont
// dan het woord zelf in plaats van een vertaling die niet klopt.

import { resolveFlowType } from './onboarding-wizard-default.js';
import { DAGEN, DAGDELEN, BELMOMENTEN, portalAntwoorden } from './onboarding-portal.js';

/** De vraagschermen van de nieuwe flow (zonder welkom en klaar). */
export const PORTAL_SCHERMEN = Object.freeze({
  '1op1': Object.freeze(['locatie', 'jij', 'beschikbaar', 'extra']),
  membership: Object.freeze(['jij', 'extra']),
});

/** Alle schermen van de nieuwe flow, zoals de website (FLOWS in lib/onboarding-portal.ts). */
export const PORTAL_FLOWS = Object.freeze({
  '1op1': Object.freeze(['welkom', ...PORTAL_SCHERMEN['1op1'], 'klaar']),
  membership: Object.freeze(['welkom', ...PORTAL_SCHERMEN.membership, 'klaar']),
});

// 'oude_wizard' (28 okt 2026): begonnen in de klassieke wizard, nog niets
// bewaard in de nieuwe onboarding. Zie portalVoortgang().
export const PORTAL_STANDEN = Object.freeze(['niet_gestart', 'oude_wizard', 'bezig', 'afgerond']);

function tekst(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

/** De beschikbaarheid, geschoond: alleen gekende dagen en dagdelen, vaste volgorde. */
export function schoneBeschikbaarheid(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const uit = {};
  let iets = false;
  for (const dag of DAGEN) {
    const delen = Array.isArray(v[dag]) ? v[dag] : [];
    const set = new Set(delen.filter((d) => typeof d === 'string'));
    const geordend = DAGDELEN.filter((d) => set.has(d));
    uit[dag] = geordend;
    if (geordend.length) iets = true;
  }
  return iets ? uit : null;
}

function aantalMomenten(b) {
  return b ? Object.values(b).reduce((n, d) => n + d.length, 0) : 0;
}

/** Zelfde regel als stapKlaar() op de website. */
export function schermKlaar(scherm, a) {
  if (scherm === 'locatie') return !!tekst(a.coaching_locatie_voorkeur);
  if (scherm === 'jij') return !!tekst(a.ervaring_trading) && !!tekst(a.motivatie_primair);
  if (scherm === 'beschikbaar') return aantalMomenten(schoneBeschikbaarheid(a.beschikbaarheid)) > 0;
  if (scherm === 'extra') return !!tekst(a.robot_interesse);
  return false;
}

/** Is de wizard (oud of nieuw) afgerond? Zelfde betekenis als onboardings.status 'afgerond'. */
export function wizardAfgerond(ob) {
  return String(ob?.status || '').trim().toLowerCase() === 'afgerond' || !!ob?.completed_at;
}

// ── DE PORTALSTAND (28 okt 2026) ─────────────────────────────────────────
//
// Eén afleiding voor de CRM-lijst, het detail, het LMS-bord en de LMS-spiegel.
// Het kenmerk is `portal_gestart_op` (eerste save in de nieuwe onboarding,
// migratie 2026-10-28-onboarding-portal-gestart.sql) — NIET de sleutels in
// answers, want die deelt de nieuwe onboarding met de klassieke wizard.
//
//   afgerond     status 'afgerond' (of completed_at), welke wizard ook;
//   bezig        portal_gestart_op gezet → stap x van y op de NIEUWE flow;
//   oude_wizard  nooit in de portal bewaard, maar wel begonnen in de
//                klassieke wizard (status 'bezig' of current_step > 0);
//   niet_gestart nergens begonnen.
// Is de kolom niet gelezen (sleutel ontbreekt: migratie niet gedraaid), dan
// is oud/nieuw niet te scheiden en geldt de afleiding van vóór 28 okt.

function oudeWizardBegonnen(ob) {
  return String(ob?.status || '').trim().toLowerCase() === 'bezig' || Number(ob?.current_step) > 0;
}

/**
 * @param {object} ob  rij uit `onboardings` (+ portal_gestart_op/portal_geopend_op als gelezen)
 * @param {'1op1'|'membership'|null} flow
 * @returns {{stand: string, stap: number|null, totaal: number|null, geopend: boolean|null,
 *            gestart_op: string|null, kolom_gelezen: boolean, label: string}}
 */
export function portalVoortgang(ob, flow) {
  const a = (ob?.answers && typeof ob.answers === 'object') ? ob.answers : {};
  const afgerond = wizardAfgerond(ob);
  const kolomGelezen = ob?.portal_gestart_op !== undefined;
  const gestart = !!ob?.portal_gestart_op;
  const schermen = flow ? PORTAL_SCHERMEN[flow] : null;
  const totaal = schermen ? schermen.length : null;
  const stap = schermen ? (afgerond ? totaal : schermen.filter((s) => schermKlaar(s, a)).length) : null;

  let stand;
  if (afgerond) stand = 'afgerond';
  else if (gestart) stand = 'bezig';
  else if (!kolomGelezen) {
    const iets = ['coaching_locatie_voorkeur', 'ervaring_trading', 'motivatie_primair', 'robot_interesse']
      .some((k) => tekst(a[k])) || a.commitment_uren_per_week != null || schoneBeschikbaarheid(a.beschikbaarheid) !== null
      || Number(ob?.current_step) > 0;
    stand = iets ? 'bezig' : 'niet_gestart';
  } else stand = oudeWizardBegonnen(ob) ? 'oude_wizard' : 'niet_gestart';

  const geopend = kolomGelezen ? !!ob?.portal_geopend_op : null;
  const v = { stand, stap, totaal, geopend, gestart_op: ob?.portal_gestart_op || null, kolom_gelezen: kolomGelezen };
  return { ...v, label: voortgangLabel(v) };
}

/** De voortgang in woorden — dezelfde tekst in de CRM-lijst, het detail en het LMS. PURE. */
export function voortgangLabel({ stand, stap, totaal, geopend }) {
  if (stand === 'afgerond') return 'Afgerond';
  if (stand === 'bezig') return totaal ? `Nieuwe onboarding · ${stap ?? 0}/${totaal}` : 'Nieuwe onboarding · bezig';
  if (stand === 'oude_wizard') {
    return geopend
      ? 'Oude wizard (onvolledig) — nieuwe link geopend, nog niets ingevuld'
      : 'Oude wizard (onvolledig) — nieuwe link nog niet geopend';
  }
  return geopend ? 'Nog niet gestart — link geopend' : 'Nog niet gestart';
}

/**
 * Op welk scherm van de NIEUWE flow opent de portal? (28 okt 2026)
 *
 * current_step van wie nooit in de portal bewaarde is een pagina van de
 * klassieke wizard (tot 10) en betekent hier niets: die klant start bij de
 * eerste onbeantwoorde vraag van de nieuwe flow (alles beantwoord → de laatste
 * vraag, waar hij afrondt). Wie al in de portal bewaarde, hervat op zijn
 * scherm — afgeklemd op de laatste vraag en nooit voorbij een onbeantwoorde.
 * Nog nergens begonnen → het welkomscherm. Kolom niet gelezen (migratie niet
 * gedraaid) → afklemmen + eerste onbeantwoorde, nooit een onbestaand scherm.
 *
 * @returns {number} index in PORTAL_FLOWS[flow] (0 = welkom, nooit 'klaar')
 */
export function hervatStap(ob, flow) {
  const schermen = PORTAL_FLOWS[flow] || PORTAL_FLOWS['1op1'];
  const laatste = schermen.length - 2;
  const a = portalAntwoorden(ob?.answers);
  const eersteOpen = (tot) => {
    for (let i = 1; i < tot; i++) if (!schermKlaar(schermen[i], a)) return i;
    return null;
  };
  const kolomGelezen = ob?.portal_gestart_op !== undefined;
  if (kolomGelezen && !ob.portal_gestart_op) {
    if (!oudeWizardBegonnen(ob)) return 0;
    return eersteOpen(laatste + 1) ?? laatste;
  }
  const n = Number(ob?.current_step);
  const doel = Number.isInteger(n) ? Math.max(0, Math.min(n, laatste)) : 0;
  return eersteOpen(doel) ?? doel;
}

/**
 * Alles wat het LMS van de onboarding-antwoorden te zien krijgt.
 *
 * @param {object} ob  rij uit `onboardings` (status, completed_at, answers, current_step)
 * @param {string|null|undefined} trajectType  `onboarding_trajecten.type`; `undefined` = niet gelezen
 */
export function antwoordenVoorLms(ob, trajectType) {
  const a = (ob?.answers && typeof ob.answers === 'object') ? ob.answers : {};
  const flow = trajectType === undefined ? null : resolveFlowType(trajectType);
  const afgerond = wizardAfgerond(ob);

  const beschikbaarheid = schoneBeschikbaarheid(a.beschikbaarheid);
  //  null/'' is "niet ingevuld", geen 0.
  const uren = (a.commitment_uren_per_week == null || a.commitment_uren_per_week === '')
    ? NaN : Number(a.commitment_uren_per_week);
  const robot = tekst(a.robot_interesse);
  const belmoment = Array.isArray(a.robot_belmoment)
    ? BELMOMENTEN.filter((m) => a.robot_belmoment.includes(m))
    : [];

  const v = portalVoortgang(ob, flow);

  return {
    flow_type: flow,
    portal_stand: v.stand,
    portal_afgerond_op: afgerond ? (ob?.completed_at || null) : null,
    // Voor het LMS-bord (niet in de spiegel): de tekst en of de nieuwe link al open ging.
    portal_label: v.label,
    portal_geopend: v.geopend,
    wizard_stap: v.stap,
    wizard_stappen_totaal: v.totaal,
    coaching_locatie_voorkeur: tekst(a.coaching_locatie_voorkeur),
    ervaring_trading: tekst(a.ervaring_trading),
    motivatie_primair: tekst(a.motivatie_primair),
    commitment_uren_per_week: Number.isInteger(uren) && uren > 0 ? uren : null,
    beschikbaarheid,
    // Alleen voor hoofdmentor/admin — staat in het LMS in een aparte tabel
    // (hlms_crm_onboarding_automation) waar een mentor niet bij kan.
    automation_interesse: robot === 'ja_interesse' ? 'ja' : (robot === 'nee' ? 'nee' : null),
    automation_belmoment: robot === 'ja_interesse' ? belmoment : [],
  };
}
