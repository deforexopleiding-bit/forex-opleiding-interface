// api/_lib/toegang-cron-mails.js
//
// Pure render-functies voor de e-mails van de toegang-gate cron
// (cron-toegang-aanvragen.js): de welkom/bevestigings-mail (na aanmelding) en
// de dag-6 "morgen je laatste dag"-mail van de gratis 7-daagse.
//
// Geëxtraheerd uit cron-toegang-aanvragen.js zodat:
//   1) de cron ze importeert (gedrag ongewijzigd), en
//   2) de E-mails-tab (api/email-overzicht.js) er een ECHTE HTML-preview van
//      kan renderen met voorbeelddata — puur, geen send/DB/env.
//
// Elke functie geeft { subject, text, html } terug (identiek aan voorheen).

// Statische call-link (voorlopig). Per-bron dynamisch = latere optie.
export const CALL_LINK = 'https://deforexopleiding.nl/agenda';

// Bevestiging A — mét geboekte kennismakingscall ({callMoment} = NL-datumstring).
export const mailBevestigingA = (voornaam, callMoment) => {
  const naam = voornaam || 'daar';
  const moment = callMoment || 'het geplande moment';
  return {
    subject: 'Nog één stapje — check je WhatsApp ✅',
    text:
      `Hoi ${naam},\n\n` +
      `Je aanvraag is binnen, en je opstartsessie staat genoteerd voor ${moment}. ` +
      `We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op ` +
      `(een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.\n\n` +
      `Tot snel! Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Je aanvraag is binnen, en je opstartsessie staat genoteerd voor <b>${moment}</b>. ` +
      `We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op ` +
      `(een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.</p>` +
      `<p>Tot snel!<br>Team De Forex Opleiding</p>`,
  };
};

// Bevestiging B — zónder geboekte call (met agenda-call-to-action).
export const mailBevestigingB = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Nog één stapje — check je WhatsApp ✅',
    text:
      `Hoi ${naam},\n\n` +
      `Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — ` +
      `reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke ` +
      `inloggegevens in je mailbox.\n\n` +
      `Heb je nog geen kennismakingscall ingepland? Doe dat hier even, dan halen we samen ` +
      `het meeste uit je start: ${CALL_LINK}\n\n` +
      `Tot zo! Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — ` +
      `reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke ` +
      `inloggegevens in je mailbox.</p>` +
      `<p>Heb je nog geen kennismakingscall ingepland? Doe dat <a href="${CALL_LINK}">hier</a> ` +
      `even, dan halen we samen het meeste uit je start.</p>` +
      `<p>Tot zo!<br>Team De Forex Opleiding</p>`,
  };
};

// Dag-6 A — mét geboekte call.
export const mailDag6A = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Morgen je laatste dag — hoe was het?',
    text:
      `Hoi ${naam},\n\n` +
      `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
      `Groet, Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
      `<p>Groet,<br>Team De Forex Opleiding</p>`,
  };
};

// Dag-6 B — zónder geboekte call (met agenda-call-to-action).
export const mailDag6B = (voornaam) => {
  const naam = voornaam || 'daar';
  return {
    subject: 'Morgen je laatste dag — hoe was het?',
    text:
      `Hoi ${naam},\n\n` +
      `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
      `En wil je er echt mee verder? Plan hier een gratis opstartsessie in, dan kijken we ` +
      `samen wat bij je past: ${CALL_LINK}\n\n` +
      `Groet, Team De Forex Opleiding`,
    html:
      `<p>Hoi ${naam},</p>` +
      `<p>Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
      `ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
      `<p>En wil je er echt mee verder? Plan <a href="${CALL_LINK}">hier</a> een gratis ` +
      `opstartsessie in, dan kijken we samen wat bij je past.</p>` +
      `<p>Groet,<br>Team De Forex Opleiding</p>`,
  };
};
