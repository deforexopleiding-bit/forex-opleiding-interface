// api/_lib/onboarding-auto-afronden.js
//
// AUTOMATISCH AFRONDEN ZONDER SESSIE (Maxim, 28 oktober 2026).
//
// De eerste afgeronde sessie sluit een onboarding al af
// (onboarding-afsluiten-na-sessie.js). Een membership heeft geen 1-op-1
// sessies, dus die bleef open staan tot iemand hem met de hand afrondde. De
// regel van Maxim:
//
//   · membership: dicht zodra de startdatum bereikt is (kalenderdag in
//     Brussel) ÉN de klant de onboarding zelf invulde;
//   · 1-op-1: dicht na de eerste sessie — dat doet de bestaande cron al, hier
//     verandert niets.
//
// Een tweede reden komt erbij met de herinneringen (oude dossiers): zie
// besluitOudDossier() in onboarding-herinneringen.js. Beide schrijven via
// dezelfde patch hieronder, met hun eigen reden.
//
// WAT ER WORDT VASTGELEGD: status 'afgerond', auto_afgerond_op en — als de
// kolom er is — auto_afgerond_reden. `completed_at` blijft het wizardmoment
// als dat er is; anders krijgt het hetzelfde moment als auto_afgerond_op, zodat
// wizardDoorKlantVoltooid() weet dat de klant het NIET zelf invulde (dan mag hij
// de portal nog openen, net als na met de hand afronden).

import { wizardDoorKlantVoltooid } from './onboarding-einde.js';
import { resolveFlowType } from './onboarding-wizard-default.js';
import { inIncasso } from './onboarding-incasso-stand.js';

/** De redenen in onboardings.auto_afgerond_reden. */
export const REDEN_SESSIE = 'sessie';
export const REDEN_MEMBERSHIP = 'membership_start';
export const REDEN_OUD_DOSSIER = 'oud_dossier';

/** Hoe een reden heet in een lijst of tijdlijn. */
export const REDEN_LABEL = {
  [REDEN_SESSIE]: 'Afgerond door de eerste sessie',
  [REDEN_MEMBERSHIP]: 'Membership: startdatum bereikt, onboarding ingevuld',
  [REDEN_OUD_DOSSIER]: 'Oud dossier zonder onboarding (laatste herinnering zonder antwoord)',
};

/** De kalenderdag in Brussel (YYYY-MM-DD). PURE. */
export function dagBrussel(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels' }).format(nu);
}

/** Een kalenderdag (YYYY-MM-DD) van een tijdstip, in Brussel; null bij onzin. PURE. */
export function dagVan(iso) {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return String(iso);
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : dagBrussel(d);
}

/** Een kalenderdag plus n dagen. PURE. */
export function dagPlus(dag, n) {
  const d = new Date(dag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Dagen van a naar b (b − a), beide YYYY-MM-DD. PURE. */
export function dagenTussen(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86_400_000);
}

const DICHT = new Set(['geannuleerd', 'gearchiveerd']);

/**
 * Moet deze membership-onboarding vandaag dicht? PURE.
 * @param {object} ob onboardings-rij (+ handmatig/auto-kolommen)
 * @param {string|null} trajectType onboarding_trajecten.type
 * @param {string} vandaag YYYY-MM-DD in Brussel
 * @returns {{dicht: boolean, waarom: string}}
 */
export function besluitMembershipAfronden(ob, trajectType, vandaag) {
  if (!ob?.id) return { dicht: false, waarom: 'geen_onboarding' };
  if (ob.is_test) return { dicht: false, waarom: 'test' };
  if (ob.archived_at || DICHT.has(String(ob.status || '').toLowerCase())) return { dicht: false, waarom: 'niet_aanraken' };
  if (inIncasso(ob)) return { dicht: false, waarom: 'incasso' };
  if (resolveFlowType(trajectType) !== 'membership') return { dicht: false, waarom: 'geen_membership' };
  if (ob.auto_afgerond_op || ob.handmatig_afgerond_op) return { dicht: false, waarom: 'al_afgerond' };
  if (!wizardDoorKlantVoltooid(ob)) return { dicht: false, waarom: 'niet_ingevuld' };
  const start = dagVan(ob.start_date);
  if (!start) return { dicht: false, waarom: 'geen_startdatum' };
  if (start > vandaag) return { dicht: false, waarom: 'start_nog_niet' };
  return { dicht: true, waarom: REDEN_MEMBERSHIP };
}

/**
 * De patch die een onboarding automatisch sluit, zonder sessie. PURE.
 * `metReden` = de kolom auto_afgerond_reden bestaat (migratie
 * 2026-10-28-onboarding-opvolgflow.sql); anders laten we hem weg zodat de
 * update niet faalt op een onbekende kolom.
 */
export function autoAfrondPatch(ob, reden, nowIso, { metReden = true } = {}) {
  const patch = {
    status: 'afgerond',
    completed_at: ob?.completed_at || nowIso,
    auto_afgerond_op: nowIso,
    updated_at: nowIso,
  };
  if (metReden) patch.auto_afgerond_reden = reden;
  return patch;
}

/** Bestaat onboardings.auto_afgerond_reden al? Eén probe per run; faalzacht = nee. */
export async function heeftRedenKolom(db) {
  const { error } = await db.from('onboardings').select('auto_afgerond_reden').limit(1);
  if (!error) return true;
  if (error.code === '42703' || /auto_afgerond_reden/.test(error.message || '')) return false;
  console.warn('[onboarding-auto-afronden] probe reden-kolom:', error.message);
  return false;
}

/**
 * Sluit af, alleen als hij nog niet automatisch of met de hand dicht is (de
 * wacht staat in de query: twee lopen tegelijk sluiten samen één keer).
 * @returns {Promise<boolean>} true = deze aanroep sloot af
 */
export async function sluitAutomatischAf(db, ob, reden, { nowIso = new Date().toISOString(), metReden = true } = {}) {
  const { data, error } = await db
    .from('onboardings')
    .update(autoAfrondPatch(ob, reden, nowIso, { metReden }))
    .eq('id', ob.id)
    .is('auto_afgerond_op', null)
    .is('handmatig_afgerond_op', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('automatisch afronden: ' + error.message);
  return !!data?.id;
}
