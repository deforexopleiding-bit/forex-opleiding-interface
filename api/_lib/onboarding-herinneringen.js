// api/_lib/onboarding-herinneringen.js
//
// HERINNERINGEN VOOR WIE DE ONBOARDING NOG NIET INVULDE (Maxim, 28 okt 2026).
// De regels zijn PURE functies; de cron (api/cron/onboarding-herinneringen.js)
// leest, beslist hiermee en verstuurt.
//
// ── DE CADANS (met de correctie van Maxim: NOOIT tijdens de bedenktijd) ──
// De bedenktijd (herroepingsrecht, 14 dagen) moet voorbij zijn. "Dag 15" is de
// dag NA het vervallen: bedenktijd.vervalt_op + 1 kalenderdag (Brussel).
// Ontbreekt die datum (geen offertedatum gevonden): aanmelddatum + 15 dagen.
// Zolang de bedenktijd 'lopend' is: nooit een herinnering, wat er ook gebeurt.
//
//   1. herinnering_1   dag 15, enkel als de onboarding nog niet ingevuld is;
//   2. herinnering_2   7 dagen later (dag 22) — en minstens 7 dagen na de 1e;
//   3. bijna_start     startdatum − 2 dagen, ALLEEN als dat na het vervallen
//                      van de bedenktijd valt en niet binnen 3 dagen van een
//                      vorige herinnering (0..3 dagen ertussen = te dicht);
//   4. startdatum + 7 dagen en nog niets → GEEN mail meer, maar het signaal
//      melding_geen_reactie naar de administratie (één keer; ook pas na de
//      bedenktijd). Op het LMS-onboardingbord staat hij dan in Probleem.
//
// Per student hoogstens één mail per dag.
//
// ── NOOIT ────────────────────────────────────────────────────────────────
// klaar (ingevuld, met de hand of automatisch afgerond), geannuleerd of
// gearchiveerd, in incasso, testaccount, de schakelaar "Geen herinneringen"
// aan, een open signaal "wil annuleren", geen e-mailadres. En oude dossiers
// (start > 30 dagen geleden) volgen deze cadans NIET: die krijgen één laatste
// mail, met de hand gestart (besluitOudDossier hieronder).
//
// ── DE OUDE AUTOMATION "Reminder na bedenktijd" ──────────────────────────
// Die stuurt al een mail op aanmelding + 15 dagen (trigger time_after_signup).
// Zolang ze AAN staat, versturen wij herinnering_1 niet (anders twee mails op
// dezelfde dag); heeft ze al gemaild, dan telt die mail als herinnering_1.

import { dagVan, dagPlus, dagenTussen } from './onboarding-auto-afronden.js';

export const SOORTEN = ['herinnering_1', 'herinnering_2', 'bijna_start', 'laatste'];
export const SIGNAAL = 'signaal_geen_reactie';
export const SETTING_KEY = 'onboarding_herinneringen';
export const OUD_NA_DAGEN = 30;
export const OUD_AFRONDEN_NA_DAGEN = 7;
export const TE_DICHT_DAGEN = 3;

export const SOORT_LABEL = {
  herinnering_1: 'Herinnering 1 (dag na de bedenktijd)',
  herinnering_2: 'Herinnering 2 (7 dagen later)',
  bijna_start: 'Bijna van start (startdatum − 2)',
  laatste: 'Laatste herinnering (oud dossier)',
  signaal_geen_reactie: 'Signaal geen reactie naar de administratie',
};

/**
 * De concepten. Maxim keurt elke tekst goed vóór hij kan vertrekken; een
 * wijziging na goedkeuring zet hem terug op concept. De regel
 * {{onboarding.startcode}} = de code groot in een kader, [knop: …] = een knop
 * naar de persoonlijke link (onboarding-mail-opmaak.js).
 *
 * PER TRAJECT (Maxim, 29 okt): een membership heeft geen 1-op-1-mentor. Een
 * regel die begint met [1-op-1] gaat alleen naar 1-op-1, een regel met
 * [membership] alleen naar membership (tekstVoorFlow hieronder); de rest naar
 * iedereen.
 */
export const CONCEPT_TEKSTEN = {
  herinnering_1: {
    onderwerp: 'Je startcode ligt klaar, {{klant.voornaam}}',
    tekst: [
      'Hi {{klant.voornaam}},',
      '',
      '[1-op-1] Je onboarding bij De Forex Opleiding staat nog voor je klaar. Het duurt ongeveer drie minuten, en zo kan je mentor je eerste sessie meteen goed voorbereiden.',
      '[membership] Je onboarding bij De Forex Opleiding staat nog voor je klaar. Het duurt ongeveer drie minuten, en zo kunnen we je start goed voorbereiden.',
      '',
      'Je persoonlijke startcode:',
      '{{onboarding.startcode}}',
      '[knop: Vul je onboarding in]',
      '',
      'Lukt het niet, of heb je een vraag? Antwoord gerust op deze mail.',
      '',
      'Groet,',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
  herinnering_2: {
    onderwerp: 'Nog even je onboarding invullen?',
    tekst: [
      'Hi {{klant.voornaam}},',
      '',
      '[1-op-1] We zagen dat je onboarding nog openstaat. Met je antwoorden kan je mentor je traject op jou afstemmen: je ervaring, je doel en wanneer je tijd hebt.',
      '[membership] We zagen dat je onboarding nog openstaat. Met je antwoorden stemmen we je traject op jou af: je ervaring, je doel en wanneer je tijd hebt.',
      '',
      '{{onboarding.startcode}}',
      '[knop: Verder met je onboarding]',
      '',
      'Groet,',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
  bijna_start: {
    onderwerp: 'Bijna van start — vul nog even je onboarding in',
    tekst: [
      'Hi {{klant.voornaam}},',
      '',
      '[1-op-1] Over twee dagen begint je traject. Vul vóór de start nog even je onboarding in, dan kan je mentor meteen met je aan de slag.',
      '[membership] Over twee dagen begint je traject. Vul vóór de start nog even je onboarding in, zodat we je start goed kunnen voorbereiden.',
      '',
      '{{onboarding.startcode}}',
      '[knop: Vul je onboarding in]',
      '',
      'Tot binnenkort,',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
  laatste: {
    onderwerp: 'Laatste herinnering: je onboarding',
    tekst: [
      'Hi {{klant.voornaam}},',
      '',
      '[1-op-1] Je traject loopt al een tijdje, maar je onboarding staat nog open. Dit is de laatste keer dat we je eraan herinneren: vul hem gerust nog in, dan weet je mentor wat jij nodig hebt.',
      '[membership] Je traject loopt al een tijdje, maar je onboarding staat nog open. Dit is de laatste keer dat we je eraan herinneren: vul hem gerust nog in, dan weten we wat jij nodig hebt.',
      '',
      '{{onboarding.startcode}}',
      '[knop: Vul je onboarding in]',
      '',
      'Groet,',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
};

export const FLOW_MARKERS = { '1op1': '[1-op-1]', membership: '[membership]' };

/**
 * De tekst voor één traject: regels met [1-op-1] of [membership] vooraan
 * blijven alleen voor dat traject staan (zonder het label), de andere regels
 * blijven altijd. Onbekend traject = 1-op-1 (zoals resolveFlowType). PURE.
 * @param {string} tekst
 * @param {'1op1'|'membership'|string|null} flow
 */
export function tekstVoorFlow(tekst, flow) {
  const eigen = flow === 'membership' ? 'membership' : '1op1';
  const uit = [];
  for (const regel of String(tekst ?? '').split('\n')) {
    const m = /^\s*\[(1-op-1|membership)\]\s?/i.exec(regel);
    if (!m) { uit.push(regel); continue; }
    const voor = m[1].toLowerCase() === 'membership' ? 'membership' : '1op1';
    if (voor === eigen) uit.push(regel.slice(m[0].length));
  }
  return uit.join('\n');
}

/** Staan er regels per traject in deze tekst? PURE. */
export function heeftFlowRegels(tekst) {
  return /^\s*\[(1-op-1|membership)\]/im.test(String(tekst ?? ''));
}

/**
 * Instellingen met teksten die eerst goedgekeurd moeten worden — gedeeld met de
 * check-in-mails (checkin-mails.js). Een tekst is goedgekeurd zolang hij EXACT
 * gelijk is aan wat goedgekeurd werd; anders weer concept. PURE.
 * @param {object|null} waarde de ruwe app_settings-waarde
 * @param {Record<string,{onderwerp:string,tekst:string}>} concepten de standaardteksten per soort
 */
export function normaliseerTekstInstellingen(waarde, concepten) {
  const v = waarde && typeof waarde === 'object' ? waarde : {};
  const teksten = {};
  for (const [s, c] of Object.entries(concepten)) {
    const t = v.teksten && typeof v.teksten === 'object' ? v.teksten[s] : null;
    const onderwerp = t && typeof t.onderwerp === 'string' && t.onderwerp.trim() ? t.onderwerp : c.onderwerp;
    const tekst = t && typeof t.tekst === 'string' && t.tekst.trim() ? t.tekst : c.tekst;
    const ok = !!(t && t.goedgekeurd_op && t.goedgekeurd_onderwerp === onderwerp && t.goedgekeurd_tekst === tekst);
    teksten[s] = {
      onderwerp, tekst,
      goedgekeurd: ok,
      goedgekeurd_op: ok ? t.goedgekeurd_op : null,
      goedgekeurd_door: ok ? (t.goedgekeurd_door || null) : null,
      gewijzigd_op: t?.gewijzigd_op || null,
      gewijzigd_door: t?.gewijzigd_door || null,
    };
  }
  return { aan: v.aan === true, aan_op: v.aan_op || null, aan_door: v.aan_door || null, teksten };
}

/** De instellingen van de onboarding-herinneringen, met de concepten als standaard. PURE. */
export function normaliseerInstellingen(waarde) {
  return normaliseerTekstInstellingen(waarde, CONCEPT_TEKSTEN);
}

/**
 * De ruwe waarde na "Goedkeuren": de huidige tekst wordt de goedgekeurde. PURE.
 * @returns {object} nieuwe ruwe waarde
 */
export function keurGoed(ruw, soort, huidig, door, nuIso = new Date().toISOString()) {
  const teksten = { ...((ruw && ruw.teksten) || {}) };
  teksten[soort] = {
    ...(teksten[soort] || {}), onderwerp: huidig.onderwerp, tekst: huidig.tekst,
    goedgekeurd_onderwerp: huidig.onderwerp, goedgekeurd_tekst: huidig.tekst,
    goedgekeurd_op: nuIso, goedgekeurd_door: door,
  };
  return { ...(ruw || {}), teksten };
}

/** De ruwe waarde na een bewerking: de goedkeuring vervalt vanzelf (andere tekst). PURE. */
export function bewerkTekst(ruw, soort, { onderwerp, tekst }, door, nuIso = new Date().toISOString()) {
  const teksten = { ...((ruw && ruw.teksten) || {}) };
  teksten[soort] = { ...(teksten[soort] || {}), onderwerp, tekst, gewijzigd_op: nuIso, gewijzigd_door: door };
  return { ...(ruw || {}), teksten };
}

/** Is deze onboarding klaar (ingevuld of afgesloten)? Zelfde regel als onboardingKlaar. PURE. */
export function isKlaar(r) {
  return String(r?.status || '').toLowerCase() === 'afgerond' || !!r?.afgesloten || !!r?.handmatig_afgerond_op;
}

/** Een oud dossier: start meer dan 30 dagen geleden en niet klaar. PURE. */
export function isOudDossier(r, vandaag) {
  const start = dagVan(r?.start_date);
  return !!start && !isKlaar(r) && dagenTussen(start, vandaag) > OUD_NA_DAGEN;
}

/**
 * De eerste dag waarop er iets mag: de dag na het vervallen van de
 * bedenktijd, anders aanmelding + 15. null = we weten het niet (geen
 * aanmelddatum) → dan nooit. PURE.
 */
export function eersteDag(r) {
  const vervalt = dagVan(r?.bedenktijd?.vervalt_op);
  if (vervalt) return dagPlus(vervalt, 1);
  const aangemeld = dagVan(r?.created_at);
  return aangemeld ? dagPlus(aangemeld, 15) : null;
}

/** Waarom deze student NOOIT iets krijgt (of null). PURE. */
export function uitsluiting(r, ctx = {}) {
  const status = String(r?.status || '').toLowerCase();
  if (r?.is_test) return 'test';
  if (r?.archived_at || status === 'gearchiveerd') return 'gearchiveerd';
  if (status === 'geannuleerd') return 'geannuleerd';
  if (isKlaar(r)) return 'klaar';
  if (r?.in_incasso) return 'incasso';
  if (r?.geen_herinneringen_op) return 'geen_herinneringen';
  if (ctx.wilAnnuleren) return 'wil_annuleren';
  if (r?.bedenktijd?.status === 'lopend') return 'bedenktijd_loopt';
  return null;
}

function laatsteMailDag(log) {
  const dagen = (log || []).filter((l) => SOORTEN.includes(l.soort) && l.status !== 'mislukt').map((l) => dagVan(l.aangemaakt_op)).filter(Boolean);
  return dagen.length ? dagen.sort().at(-1) : null;
}

function gehad(log, soort) {
  return (log || []).some((l) => l.soort === soort && l.status !== 'mislukt');
}

function dagVanSoort(log, soort) {
  const l = (log || []).find((x) => x.soort === soort && x.status !== 'mislukt');
  return l ? dagVan(l.aangemaakt_op) : null;
}

/**
 * Wat er vandaag moet gebeuren voor deze student. PURE.
 *
 * @param {object} r een rij uit bouwOverzichtRijen (+ geen_herinneringen_op)
 * @param {{vandaag: string, log?: Array<{soort,status,aangemaakt_op}>,
 *          wilAnnuleren?: boolean, oudeAutomationAan?: boolean}} ctx
 * @returns {{actie: 'mail', soort: string} | {actie: 'signaal'} | {actie: 'niets', waarom: string}}
 */
export function besluitHerinnering(r, ctx) {
  const { vandaag } = ctx;
  const log = ctx.log || [];
  const weg = uitsluiting(r, ctx);
  if (weg) return { actie: 'niets', waarom: weg };
  if (isOudDossier(r, vandaag)) return { actie: 'niets', waarom: 'oud_dossier' };
  const eerste = eersteDag(r);
  if (!eerste) return { actie: 'niets', waarom: 'geen_aanmelddatum' };
  if (vandaag < eerste) return { actie: 'niets', waarom: 'voor_dag_15' };

  const start = dagVan(r.start_date);
  //  4. Startdatum + 7 en nog niets: geen mail meer, één signaal.
  if (start && vandaag >= dagPlus(start, 7)) {
    return gehad(log, SIGNAAL) ? { actie: 'niets', waarom: 'signaal_al_gezet' } : { actie: 'signaal' };
  }
  const laatste = laatsteMailDag(log);
  if (laatste === vandaag) return { actie: 'niets', waarom: 'vandaag_al_gemaild' };

  //  3. Bijna van start: start − 2 t/m de startdag, na de bedenktijd, niet te dicht.
  if (start && !gehad(log, 'bijna_start')) {
    const bijna = dagPlus(start, -2);
    if (vandaag >= bijna && vandaag <= start && bijna >= eerste) {
      if (laatste && dagenTussen(laatste, vandaag) <= TE_DICHT_DAGEN) return { actie: 'niets', waarom: 'te_dicht_bij_vorige' };
      return { actie: 'mail', soort: 'bijna_start' };
    }
  }

  //  1. Dag 15.
  if (!gehad(log, 'herinnering_1')) {
    if (ctx.oudeAutomationAan) return { actie: 'niets', waarom: 'oude_automation_stuurt_dag_15' };
    return { actie: 'mail', soort: 'herinnering_1' };
  }
  //  2. Dag 22, en minstens 7 dagen na de eerste.
  if (!gehad(log, 'herinnering_2')) {
    const h1 = dagVanSoort(log, 'herinnering_1') || eerste;
    const vanaf = [dagPlus(eerste, 7), dagPlus(h1, 7)].sort().at(-1);
    if (vandaag >= vanaf) return { actie: 'mail', soort: 'herinnering_2' };
    return { actie: 'niets', waarom: 'wacht_op_dag_22' };
  }
  return { actie: 'niets', waarom: 'alles_gehad' };
}

/**
 * Het oude dossier: krijgt het de laatste mail (met de hand, via de knop),
 * of moet het nu dicht? PURE.
 * @returns {{actie: 'laatste_mail'} | {actie: 'afronden'} | {actie: 'niets', waarom: string}}
 */
export function besluitOudDossier(r, ctx) {
  const { vandaag } = ctx;
  const log = ctx.log || [];
  const weg = uitsluiting(r, ctx);
  if (weg) return { actie: 'niets', waarom: weg };
  if (!isOudDossier(r, vandaag)) return { actie: 'niets', waarom: 'geen_oud_dossier' };
  const laatste = dagVanSoort(log, 'laatste');
  if (!laatste) return { actie: 'laatste_mail' };
  if (dagenTussen(laatste, vandaag) >= OUD_AFRONDEN_NA_DAGEN) return { actie: 'afronden' };
  return { actie: 'niets', waarom: 'wacht_7_dagen' };
}
