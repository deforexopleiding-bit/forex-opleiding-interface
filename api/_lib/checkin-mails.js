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

export const SETTING_KEY = 'checkin_mails';
export const SOORTEN = ['uitnodiging', 'herinnering_5', 'herinnering_10'];
export const GENEGEERD_NA_DAGEN = 14;
export const SITE = 'https://www.deforexopleiding.nl/checkin';

export const SOORT_LABEL = {
  uitnodiging: 'Uitnodiging (bij de Run)',
  herinnering_5: 'Herinnering na 5 dagen',
  herinnering_10: 'Herinnering na 10 dagen',
};

export const CONCEPT_TEKSTEN = {
  uitnodiging: {
    onderwerp: 'Hoe loopt jouw traject, {{student.voornaam}}?',
    tekst: [
      'Hi {{student.voornaam}},',
      '',
      'We willen graag weten hoe jouw traject bij De Forex Opleiding loopt: wat goed gaat, wat beter kan, en waar we je nog mee kunnen helpen. Het duurt een paar minuten.',
      '',
      'Je persoonlijke code:',
      '{{checkin.code}}',
      '[knop: Start mijn check-in]',
      '',
      'Bedankt!',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
  herinnering_5: {
    onderwerp: 'Je check-in staat nog klaar',
    tekst: [
      'Hi {{student.voornaam}},',
      '',
      'Je check-in staat nog open. Met jouw antwoorden kunnen we je begeleiding beter afstemmen — het duurt maar een paar minuten.',
      '',
      '{{checkin.code}}',
      '[knop: Naar mijn check-in]',
      '',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
  herinnering_10: {
    onderwerp: 'Laatste herinnering: jouw DFO-check-in',
    tekst: [
      'Hi {{student.voornaam}},',
      '',
      'Dit is de laatste herinnering voor je check-in. Laat ons even weten hoe het gaat — ook als alles goed loopt.',
      '',
      '{{checkin.code}}',
      '[knop: Naar mijn check-in]',
      '',
      'Team De Forex Opleiding',
    ].join('\n'),
  },
};

/** De instellingen (hoofdschakelaar + teksten concept/goedgekeurd). PURE. */
export function normaliseerInstellingen(waarde) {
  return normaliseerTekstInstellingen(waarde, CONCEPT_TEKSTEN);
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
