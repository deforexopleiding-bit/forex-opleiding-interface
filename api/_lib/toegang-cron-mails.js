// api/_lib/toegang-cron-mails.js
//
// Pure render-functies voor de e-mails van de toegang-gate cron
// (cron-toegang-aanvragen.js): de welkom/bevestigings-mail (na aanmelding) en
// de dag-6 "morgen je laatste dag"-mail van de gratis 7-daagse.
//
// 2026-09-17 restyle: doorgevoerd via de gedeelde mail-shell (mail-shell.js),
// zodat deze mails dezelfde branded look krijgen als de Zoom-call-bevestigings-
// mails. COPY is 1-op-1 behouden — alleen de wrapper (navy header + gele CTA +
// logo-footer) wordt nu toegevoegd. Elke functie retourneert nog steeds
// { subject, text, html } — API-compat met cron + email-overzicht-preview.

import { renderMailShell, platteTekstMail } from './mail-shell.js';

// Statische call-link (voorlopig). Per-bron dynamisch = latere optie.
export const CALL_LINK = 'https://deforexopleiding.nl/agenda';

// Gemeenschappelijke voetnoot voor alle gate-mails. Rustig; niet-doorlink-agressief.
const STANDAARD_VOETNOOT = 'Vragen? Antwoord direct op deze mail — Team De Forex Opleiding.';

// Bevestiging A — mét geboekte kennismakingscall ({callMoment} = NL-datumstring).
export const mailBevestigingA = (voornaam, callMoment) => {
  const naam = voornaam || 'daar';
  const moment = callMoment || 'het geplande moment';
  const subject = 'Nog één stapje — check je WhatsApp ✅';
  const inhoud_html =
    `<p style="margin:0 0 12px">Hoi ${naam},</p>` +
    `<p style="margin:0 0 12px">Je aanvraag is binnen, en je kennismakingsgesprek staat genoteerd voor <b>${moment}</b>.</p>` +
    `<p style="margin:0 0 12px">We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.</p>` +
    `<p style="margin:0">Tot snel!</p>`;
  const text =
    `Hoi ${naam},\n\n` +
    `Je aanvraag is binnen, en je kennismakingsgesprek staat genoteerd voor ${moment}. ` +
    `We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op ` +
    `(een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.\n\n` +
    `Tot snel! Team De Forex Opleiding`;
  return {
    subject,
    text,
    html: renderMailShell({ titel: subject, inhoud_html, voetnoot: STANDAARD_VOETNOOT }),
  };
};

// Bevestiging B — zónder geboekte call (met agenda-CTA-knop).
export const mailBevestigingB = (voornaam) => {
  const naam = voornaam || 'daar';
  const subject = 'Nog één stapje — check je WhatsApp ✅';
  const inhoud_html =
    `<p style="margin:0 0 12px">Hoi ${naam},</p>` +
    `<p style="margin:0 0 12px">Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke inloggegevens in je mailbox.</p>` +
    `<p style="margin:0">Heb je nog geen kennismakingsgesprek ingepland? Doe dat hieronder, dan halen we samen het meeste uit je start.</p>`;
  const text =
    `Hoi ${naam},\n\n` +
    `Je aanvraag is binnen! We hebben je zojuist een berichtje via WhatsApp gestuurd — ` +
    `reageer daar even op (een "ja" volstaat), dan ontvang je meteen je persoonlijke ` +
    `inloggegevens in je mailbox.\n\n` +
    `Heb je nog geen kennismakingsgesprek ingepland? Doe dat hier even, dan halen we samen ` +
    `het meeste uit je start: ${CALL_LINK}\n\n` +
    `Tot zo! Team De Forex Opleiding`;
  return {
    subject,
    text,
    html: renderMailShell({
      titel: subject, inhoud_html,
      cta: { label: 'Plan je kennismakingsgesprek →', url: CALL_LINK },
      voetnoot: STANDAARD_VOETNOOT,
    }),
  };
};

// Dag-6 A — mét geboekte call.
export const mailDag6A = (voornaam) => {
  const naam = voornaam || 'daar';
  const subject = 'Morgen je laatste dag — hoe was het?';
  const inhoud_html =
    `<p style="margin:0 0 12px">Hoi ${naam},</p>` +
    `<p style="margin:0 0 12px">Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
    `<p style="margin:0">Groet,<br>Team De Forex Opleiding</p>`;
  const text =
    `Hoi ${naam},\n\n` +
    `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
    `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
    `Groet, Team De Forex Opleiding`;
  return {
    subject,
    text,
    html: renderMailShell({ titel: subject, inhoud_html, voetnoot: STANDAARD_VOETNOOT }),
  };
};

// Dag-6 B — zónder geboekte call (met agenda-CTA-knop).
export const mailDag6B = (voornaam) => {
  const naam = voornaam || 'daar';
  const subject = 'Morgen je laatste dag — hoe was het?';
  const inhoud_html =
    `<p style="margin:0 0 12px">Hoi ${naam},</p>` +
    `<p style="margin:0 0 12px">Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ervaren hebt — reageer gerust even, ik hoor het graag!</p>` +
    `<p style="margin:0">En wil je er echt mee verder? Plan hieronder een gratis kennismakingsgesprek in, dan kijken we samen wat bij je past.</p>`;
  const text =
    `Hoi ${naam},\n\n` +
    `Morgen is alweer je laatste dag van de gratis 7-daagse. Ik ben benieuwd hoe je het ` +
    `ervaren hebt — reageer gerust even, ik hoor het graag!\n\n` +
    `En wil je er echt mee verder? Plan hier een gratis kennismakingsgesprek in, dan kijken we ` +
    `samen wat bij je past: ${CALL_LINK}\n\n` +
    `Groet, Team De Forex Opleiding`;
  return {
    subject,
    text,
    html: renderMailShell({
      titel: subject, inhoud_html,
      cta: { label: 'Plan je kennismakingsgesprek →', url: CALL_LINK },
      voetnoot: STANDAARD_VOETNOOT,
    }),
  };
};

// Explicit re-export voor tests / preview-generators. platteTekstMail is
// alternatief voor de per-mail text; nu nog niet gebruikt (elke functie levert
// zelf al z'n eigen text-versie), maar consistent met de shell-API.
export { platteTekstMail };
