// api/_lib/checkin-mails.js
//
// "JOUW DFO-CHECK-IN" OOK PER MAIL (Maxim, 28 okt 2026). De pop-up en de balk
// ziet alleen wie inlogt — en 155 van de 320 actieve studenten logden nooit in.
// Daarom krijgt iedereen in een LIVE campagne ook een mail met zijn code en
// een knop naar www.deforexopleiding.nl/checkin, en een herinnering na 5 en 10
// dagen als hij nog niet verstuurde. Daarna: "Check-in genegeerd".
//
// PURE regels; het versturen doet api/cron/checkin-mails.js.
//
// SLOTEN (zelfde principe als de onboarding-herinneringen)
//   · alleen een campagne die LIVE staat — dus pas na de Run die Maxim zelf
//     indrukt; nooit concept, test, gepauzeerd of gesloten;
//   · de hoofdschakelaar app_settings `checkin_mails.aan` (standaard UIT);
//   · exact deze tekst goedgekeurd;
//   · het logboek `checkin_mails` (uniek toewijzing + soort): eerst claimen.
//   Nooit naar een testtoewijzing, nooit na versturen.
//
// "GENEGEERD" hangt NIET aan de mails: niet verstuurd 14 dagen na de Run
// (`campagne.live_op`). Zo kan het LMS (overzicht Betrokkenheid) het zelf
// afleiden, en betekent het hetzelfde met of zonder mails.

import { dagVan, dagPlus } from './onboarding-auto-afronden.js';
import { normaliseerTekstInstellingen } from './onboarding-herinneringen.js';
import { isOpmaakTekst } from './checkin-mail-opmaak.js';

export const SETTING_KEY = 'checkin_mails';
export const SOORTEN = ['uitnodiging', 'herinnering_5', 'herinnering_10'];
export const GENEGEERD_NA_DAGEN = 14;
export const SITE = 'https://www.deforexopleiding.nl/checkin';

export const SOORT_LABEL = {
  uitnodiging: 'Uitnodiging (bij de Run)',
  herinnering_5: 'Herinnering na 5 dagen',
  herinnering_10: 'Herinnering na 10 dagen',
};

//  Sinds 29 okt 2026 in de vaste opmaak van het goedgekeurde ontwerp
//  (api/_lib/checkin-mail-opmaak.js): één regel per onderdeel, `[sleutel] tekst`.
//  Teksten in de oude, platte vorm tellen niet meer (zie normaliseerInstellingen).
const VOET = '[voet] Je krijgt deze mail omdat je student bent bij De Forex Opleiding. Je check-in blijft openstaan tot je hem verstuurt; daarna krijg je hierover geen mails meer.';
const GROET = ['[groet] Bedankt om mee te bouwen,', '[ondertekening] **Maxim** & het team van De Forex Opleiding'];
export const CONCEPT_TEKSTEN = {
  uitnodiging: {
    onderwerp: 'Jouw check-in staat klaar, {{voornaam}}',
    tekst: [
      '[preheader] 4 minuten. Jouw antwoorden bepalen hoe we de opleiding de komende maanden verbeteren.',
      '[kop] Hoe loopt jouw traject,',
      '{{voornaam}}?',
      '[ondertitel] We willen weten wat jou vooruithelpt en waar je op vastloopt. Daar bouwen we de komende maanden op verder.',
      '[aanhef] Hi {{voornaam}},',
      '[tekst] Vanaf vandaag krijg je bij het inloggen in het LMS een korte **check-in**. Geen examen: we vragen hoe je traject tot nu toe verloopt, wat goed werkt en wat beter kan. Elk antwoord leest ons team zelf.',
      '[tegel] 4 min | vooral aantikken, weinig typen',
      '[tegel] Persoonlijk | gekoppeld aan jouw account',
      '[tegel] Impact | jouw input = onze volgende stappen',
      '[code-label] JOUW PERSOONLIJKE CODE',
      '[knop] Start mijn check-in →',
      '[onder-knop] Of log in op het LMS: je check-in staat daar klaar.',
      '[blok-label] OP HET EINDE',
      '[blok-titel] Wat wij zelf al jaren gebruiken',
      '[blok-tekst] Aan het einde van je check-in tonen we hoe ons eigen geld automatisch voor ons werkt. Daar willen we je graag meer over vertellen. Interesse? Vink het aan en we nemen persoonlijk contact met je op.',
      '[noot] **Kleine vraag:** houd je check-in en wat je erin ziet voor jezelf, en bespreek het niet in de Discord. Heb je een vraag of wil je iets weten? Antwoord gewoon op deze mail, dan nemen we persoonlijk contact op.',
      ...GROET,
      VOET,
    ].join('\n'),
  },
  herinnering_5: {
    onderwerp: 'Je check-in staat nog open, {{voornaam}}',
    tekst: [
      '[preheader] Nog 4 minuten: jouw antwoorden helpen ons de opleiding beter te maken.',
      '[kop] Je check-in staat nog open',
      '[ondertitel] Het duurt maar 4 minuten, en jouw antwoorden bepalen mee wat we de komende maanden verbeteren.',
      '[aanhef] Hi {{voornaam}},',
      '[tekst] Je hebt je check-in nog niet verstuurd. Vooral aantikken, weinig typen: in een paar minuten ben je klaar.',
      '[code-label] JOUW PERSOONLIJKE CODE',
      '[knop] Start mijn check-in →',
      '[onder-knop] Of log in op het LMS: je check-in staat daar klaar.',
      ...GROET,
      VOET,
    ].join('\n'),
  },
  herinnering_10: {
    onderwerp: 'Laatste herinnering: je check-in, {{voornaam}}',
    tekst: [
      '[preheader] Laatste herinnering: 4 minuten voor je check-in.',
      '[kop] Laatste herinnering: je check-in',
      '[ondertitel] Ook als alles goed loopt, willen we het graag van jou horen.',
      '[aanhef] Hi {{voornaam}},',
      '[tekst] Dit is de laatste mail over je check-in. Neem er even 4 minuten voor: elk antwoord leest ons team zelf.',
      '[code-label] JOUW PERSOONLIJKE CODE',
      '[knop] Start mijn check-in →',
      '[onder-knop] Of log in op het LMS: je check-in staat daar klaar.',
      ...GROET,
      VOET,
    ].join('\n'),
  },
};

/** De instellingen (hoofdschakelaar + teksten concept/goedgekeurd). PURE. */
export function normaliseerInstellingen(waarde) {
  //  Een bewaarde tekst in de OUDE, platte vorm (vóór het ontwerp van 29 okt)
  //  telt niet meer: dan geldt het nieuwe concept, en dat is NIET goedgekeurd.
  const v = waarde && typeof waarde === 'object' ? waarde : {};
  const teksten = {};
  for (const [s, t] of Object.entries(v.teksten && typeof v.teksten === 'object' ? v.teksten : {})) {
    if (t && isOpmaakTekst(t.tekst)) teksten[s] = t;
  }
  return normaliseerTekstInstellingen({ ...v, teksten }, CONCEPT_TEKSTEN);
}

/** XXXX-XXXX zoals de balk hem toont. PURE. */
export function codeFmt(code) {
  const c = String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}

export function link(code) {
  return SITE + '?code=' + codeFmt(code);
}

/** Is deze toewijzing "genegeerd"? Niet verstuurd, 14 dagen na de Run. PURE. */
export function genegeerd(toewijzing, campagne, vandaag) {
  if (!toewijzing || toewijzing.is_test || toewijzing.verstuurd_op || toewijzing.status === 'verstuurd') return false;
  const start = dagVan(campagne?.live_op);
  return !!start && vandaag >= dagPlus(start, GENEGEERD_NA_DAGEN);
}

/**
 * Welke mail krijgt deze toewijzing vandaag? PURE.
 * @param {{toewijzing, campagne, vandaag: string, log?: Array<{soort,status,aangemaakt_op}>, email?: string|null}} p
 * @returns {{actie: 'mail', soort: string} | {actie: 'niets', waarom: string}}
 */
export function besluitCheckinMail({ toewijzing: t, campagne: c, vandaag, log = [], email = null }) {
  if (!c || c.status !== 'live') return { actie: 'niets', waarom: 'campagne_niet_live' };
  if (!t || t.is_test) return { actie: 'niets', waarom: 'test' };
  if (t.verstuurd_op || t.status === 'verstuurd') return { actie: 'niets', waarom: 'verstuurd' };
  if (!email) return { actie: 'niets', waarom: 'geen_email' };
  const gehad = (s) => log.some((l) => l.soort === s && l.status !== 'mislukt');
  const dagVanSoort = (s) => dagVan((log.find((l) => l.soort === s && l.status !== 'mislukt') || {}).aangemaakt_op);
  if (!gehad('uitnodiging')) {
    if (genegeerd(t, c, vandaag)) return { actie: 'niets', waarom: 'genegeerd' };
    return { actie: 'mail', soort: 'uitnodiging' };
  }
  const uit = dagVanSoort('uitnodiging');
  if (!gehad('herinnering_5')) {
    return vandaag >= dagPlus(uit, 5) ? { actie: 'mail', soort: 'herinnering_5' } : { actie: 'niets', waarom: 'wacht_5_dagen' };
  }
  if (!gehad('herinnering_10')) {
    return vandaag >= dagPlus(uit, 10) ? { actie: 'mail', soort: 'herinnering_10' } : { actie: 'niets', waarom: 'wacht_10_dagen' };
  }
  return { actie: 'niets', waarom: 'alles_gehad' };
}
