// api/_lib/incasso-traject.js
//
// HET INCASSO-OVERZICHT (Maxim, 3 nov 2026) — puur, zonder databank.
// Getoond in het LMS (Administratie › Incasso) via api/lms-incasso.js; het
// CRM is de enige bron.
//
// ÉÉN STATUS. De status van een klant blijft ENKEL die van #1957
// (api/_lib/klant-incassostatus.js: actief / bij_incasso / incasso_regeling /
// afgesloten). Het traject (tabel incasso_trajecten) bewaart alleen wat die
// status niet kent; de FASE is een afleiding:
//
//   te_bepalen        geen traject, wel een spoor van incasso (onboarding op
//                     incasso, signaal incasso-opvolging, incassodossier,
//                     pipelinefase incasso). Maxim kiest per persoon.
//   mag_naar_incasso  traject + status actief. Aanmaningen LOPEN DOOR.
//   doorgezet         status bij_incasso, dossier nog niet verstuurd.
//                     Aanmaningen STAAN STIL (#1958 sluit bij_incasso uit).
//   bij_incasso       status bij_incasso + dossier verstuurd. Check om de 14 d.
//   regeling          status incasso_regeling (maandlijst #1958).
//   afgesloten        traject gesloten (betaald / oninbaar / teruggekomen /
//                     niet naar incasso) of status afgesloten.
//
// AANMANINGEN (nieuwe regel Maxim, 3 nov): bij Mag naar incasso lopen ze door,
// vanaf Doorgezet stoppen ze. Dat volgt vanzelf: doorzetten = status
// bij_incasso, en die sluit #1958 uit van engine, bulk, bureau-cron en de
// no-reply-herinneringen. Dit vervangt de regel van 9 okt ("incasso legt de
// aanmaanmotor niet stil").
//
// COMMISSIE volgt de regels van #1957 op dezelfde status: bij_incasso staat
// stil, regeling/betaald telt weer, oninbaar valt weg.
//
// MINDERJARIGEN gaan nooit naar incasso (server weigert elke fase behalve
// afsluiten). Bron: customers.date_of_birth, of de vlag uit het LMS-dossier.

import { betaaldBedrag } from './factuur-betaald.js';
import { computeDealTotals } from './deal-total.js';

export const FASES = ['te_bepalen', 'mag_naar_incasso', 'doorgezet', 'bij_incasso', 'regeling', 'afgesloten'];

export const FASE_LABEL = {
  te_bepalen: 'Nog te bepalen',
  mag_naar_incasso: 'Mag naar incasso',
  doorgezet: 'Doorgezet',
  bij_incasso: 'Bij incasso',
  regeling: 'Regeling',
  afgesloten: 'Afgesloten',
};

/** De afvinklijst van Doorgezet, in volgorde. dossier_verstuurd = de laatste. */
export const CHECKLIST = ['bureau_gekozen', 'facturen_gekrediteerd', 'restfactuur', 'abonnement_gestopt', 'dossier_verstuurd'];
export const CHECKLIST_LABEL = {
  bureau_gekozen: 'Bureau gekozen',
  facturen_gekrediteerd: 'Open facturen gekrediteerd',
  restfactuur: 'Factuur voor het restbedrag',
  abonnement_gestopt: 'Abonnement gestopt',
  dossier_verstuurd: 'Dossier verstuurd',
};

export const GESLOTEN_ALS = ['betaald', 'oninbaar', 'teruggekomen', 'niet_naar_incasso'];
export const GESLOTEN_LABEL = {
  betaald: 'Betaald',
  oninbaar: 'Oninbaar',
  teruggekomen: 'Teruggekomen',
  niet_naar_incasso: 'Niet naar incasso',
};

export const OPVOLG_DAGEN = 14;

/** Wie mag wat (rol uit het LMS, hlms_rol). */
export const RECHTEN = {
  lezen: ['admin', 'administratie', 'hoofdmentor'],
  voorstel: ['admin', 'administratie', 'hoofdmentor'],
  selecteren: ['admin', 'hoofdmentor'],      // doorzetten · niet naar incasso · fase kiezen (Nog te bepalen)
  opvolgen: ['admin', 'administratie'],      // afvinken · gecheckt · notitie · regeling · afsluiten
  //  Status corrigeren (13 nov 2026): een verkeerde klik terugzetten. Met reden en logboekregel.
  corrigeren: ['admin', 'administratie', 'hoofdmentor'],
};

export const ACTIE_RECHT = {
  voorstel: 'voorstel',
  kies_fase: 'selecteren',
  doorzetten: 'selecteren',
  niet_naar_incasso: 'selecteren',
  vink: 'opvolgen',
  gecheckt: 'opvolgen',
  doorschuiven: 'opvolgen',
  notitie: 'opvolgen',
  regeling: 'opvolgen',
  afsluiten: 'opvolgen',
  corrigeer: 'corrigeren',
};

export function magActie(rollen = [], actie) {
  const recht = ACTIE_RECHT[actie];
  if (!recht) return false;
  return (rollen || []).some((r) => RECHTEN[recht].includes(r));
}

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const dag = (d) => (d ? String(d).slice(0, 10) : null);

/** `YYYY-MM-DD` in Brussel. */
export function vandaagBrussel(nu = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(nu);
  const w = (t) => p.find((x) => x.type === t)?.value || '';
  return `${w('year')}-${w('month')}-${w('day')}`;
}

export function plusDagen(d, n) {
  const [j, m, dd] = String(d).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(j, m - 1, dd + n)).toISOString().slice(0, 10);
}

/** Minderjarig op `vandaag` volgens de geboortedatum (null = onbekend → false). */
export function isMinderjarig(geboortedatum, vandaag) {
  const g = dag(geboortedatum);
  if (!g || !/^\d{4}-\d{2}-\d{2}$/.test(g)) return false;
  const [gj, gm, gd] = g.split('-').map(Number);
  const [vj, vm, vd] = String(vandaag).split('-').map(Number);
  let leeftijd = vj - gj;
  if (vm < gm || (vm === gm && vd < gd)) leeftijd -= 1;
  return leeftijd < 18;
}

/**
 * De fase van een klant. `traject` = rij uit incasso_trajecten (of null),
 * `status` = de #1957-status ('actief' | 'bij_incasso' | 'incasso_regeling' | 'afgesloten').
 */
export function faseVan({ traject = null, status = 'actief' } = {}) {
  if (traject?.gesloten_op) return 'afgesloten';
  if (status === 'afgesloten') return 'afgesloten';
  if (status === 'incasso_regeling') return 'regeling';
  if (status === 'bij_incasso') return traject?.checklist?.dossier_verstuurd ? 'bij_incasso' : 'doorgezet';
  return traject ? 'mag_naar_incasso' : 'te_bepalen';
}

/** Lopen de automatische aanmaningen in deze fase? (spiegel van #1958) */
export function aanmaningenLopen(fase) {
  return fase === 'te_bepalen' || fase === 'mag_naar_incasso';
}

/** Hoeveel van de afvinklijst is af, en mag "dossier verstuurd" al? */
export function checklistStand(checklist = {}) {
  const af = CHECKLIST.filter((i) => !!checklist?.[i]);
  const voorDossier = CHECKLIST.slice(0, -1);
  return {
    af: af.length,
    totaal: CHECKLIST.length,
    dossierMag: voorDossier.every((i) => !!checklist?.[i]),
    open: CHECKLIST.filter((i) => !checklist?.[i]),
  };
}

/**
 * OPENSTAAND = offertebedrag − alles wat betaald is (Teamleader + GoHighLevel).
 *   offerte: elke GETEKENDE deal die niet gearchiveerd of afgewezen is, incl.
 *            BTW uit de regels (computeDealTotals, zoals de commissie), anders
 *            deals.total_amount.
 *   tl:      betaaldBedrag per factuur (een creditnota telt nooit als betaling),
 *            conceptfacturen (o.a. de bureaufactuur) tellen niet.
 *   ghl:     som van de geslaagde GoHighLevel-betalingen (null = niet gelezen).
 */
export function openstaand({ deals = [], regelsPerDeal = new Map(), facturen = [], ghlBetaald = null } = {}) {
  const getekend = (deals || []).filter(isGetekend);
  let offerte = 0;
  for (const d of getekend) {
    const regels = regelsPerDeal.get(d.id) || [];
    offerte += regels.length ? computeDealTotals(d, regels).incl : Number(d.total_amount) || 0;
  }
  const tl = (facturen || []).filter((f) => !isConcept(f) && !f.is_test).reduce((s, f) => s + betaaldBedrag(f), 0);
  const ghl = ghlBetaald == null ? 0 : Number(ghlBetaald) || 0;
  return {
    offerte: r2(offerte),
    betaald_tl: r2(tl),
    betaald_ghl: ghlBetaald == null ? null : r2(ghl),
    openstaand: getekend.length ? Math.max(0, r2(offerte - tl - ghl)) : null,
    offertes: getekend.length,
  };
}

export function isGetekend(d) {
  if (!d || d.archived_at || d.tl_quotation_declined_at) return false;
  const s = String(d.tl_quotation_status || '').toLowerCase();
  return s === 'accepted' || s === 'signed' || !!d.tl_quotation_accepted_at;
}

function isConcept(f) {
  return String(f?.status || '').toLowerCase() === 'concept' || /^CONCEPT-/.test(String(f?.invoice_number || ''));
}

/** De volgende check: Bij incasso om de 14 dagen vanaf het verzenden. */
export function volgendeCheck(traject, fase) {
  //  Het bord (5 nov): ook Doorgezet heeft een check (doorzetten = +14 dagen).
  if (fase === 'doorgezet') return traject?.volgende_check ? dag(traject.volgende_check) : null;
  if (fase !== 'bij_incasso') return null;
  if (traject?.volgende_check) return dag(traject.volgende_check);
  const op = dag(traject?.checklist?.dossier_verstuurd?.op || traject?.overgedragen_op);
  return op ? plusDagen(op, OPVOLG_DAGEN) : null;
}

/** Eén regel in het logboek (append-only jsonb). */
export function logRegel({ door, tekst, soort = 'notitie', nu = new Date() }) {
  return { op: nu.toISOString(), door: String(door || 'onbekend').slice(0, 200), soort, tekst: String(tekst || '').slice(0, 1000) };
}

/** Cijfers per fase voor de weekmeeting: aantal en openstaand bedrag. */
export function cijfersPerFase(rijen = [], vandaag = vandaagBrussel()) {
  const uit = {};
  for (const f of FASES) uit[f] = { aantal: 0, openstaand: 0, overgedragen: 0 };
  let teLaat = 0;
  for (const r of rijen) {
    const c = uit[r.fase];
    if (!c) continue;
    c.aantal += 1;
    c.openstaand = r2(c.openstaand + (Number(r.geld?.openstaand) || 0));
    c.overgedragen = r2(c.overgedragen + (Number(r.overgedragen_bedrag) || 0));
    if (r.volgende_check && r.volgende_check < vandaag) teLaat += 1;
  }
  return { perFase: uit, checkTeLaat: teLaat };
}

/** Bronnen die iemand in "Nog te bepalen" zetten (één regel per bron). */
export const BRON_LABEL = {
  onboarding: 'Onboarding op incasso',
  signaal: 'Spoor incasso-opvolging',
  dossier: 'Incassodossier',
  pipeline: 'Wanbetalers: fase incasso',
  status: 'Incassostatus',
};
