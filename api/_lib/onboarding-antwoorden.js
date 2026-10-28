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
import { DAGEN, DAGDELEN, BELMOMENTEN } from './onboarding-portal.js';

/** De vraagschermen van de nieuwe flow (zonder welkom en klaar). */
export const PORTAL_SCHERMEN = Object.freeze({
  '1op1': Object.freeze(['locatie', 'jij', 'beschikbaar', 'extra']),
  membership: Object.freeze(['jij', 'extra']),
});

export const PORTAL_STANDEN = Object.freeze(['niet_gestart', 'bezig', 'afgerond']);

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

  const iets = ['coaching_locatie_voorkeur', 'ervaring_trading', 'motivatie_primair', 'robot_interesse']
    .some((k) => tekst(a[k])) || Number.isFinite(uren) || beschikbaarheid !== null
    || Number(ob?.current_step) > 0;

  const schermen = flow ? PORTAL_SCHERMEN[flow] : null;
  const totaal = schermen ? schermen.length : null;
  const stap = schermen ? (afgerond ? totaal : schermen.filter((s) => schermKlaar(s, a)).length) : null;

  return {
    flow_type: flow,
    portal_stand: afgerond ? 'afgerond' : (iets ? 'bezig' : 'niet_gestart'),
    portal_afgerond_op: afgerond ? (ob?.completed_at || null) : null,
    wizard_stap: stap,
    wizard_stappen_totaal: totaal,
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
