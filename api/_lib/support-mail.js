// api/_lib/support-mail.js
//
// De drie mails die de supportmodule stuurt, op één plek zodat toon en
// afzender niet per endpoint gaan verschillen.
//
// Alles gaat via de bestaande branded shell (api/_lib/mail-shell.js) en de
// gedeelde SMTP-kern (api/_lib/send-email-core.js). Afzender is standaard
// info@deforexopleiding.nl — dat adres staat op de website als
// contactadres, dus een antwoord dat daarvandaan komt is herkenbaar en een
// reply belandt in een mailbox die we al uitlezen.

import { sendEmailViaSmtp } from './send-email-core.js';
import { renderMailShell, platteTekstMail } from './mail-shell.js';
import { hervatLink } from './support-hervat.js';

const STANDAARD_MAILBOX = 'info@deforexopleiding.nl';

function mailbox(voorkeur) {
  return typeof voorkeur === 'string' && voorkeur.includes('@') ? voorkeur : STANDAARD_MAILBOX;
}

/**
 * De weg terug naar het gesprek zelf, onderaan elke mail.
 *
 * Twee wegen naast elkaar, met opzet. Antwoorden op de mail is de makkelijkste
 * en werkt overal; de link is er voor wie de chat wil met alles wat er al
 * gezegd is erboven. In de link staat alleen het kenmerk — geen token, geen
 * mailadres. Zie _lib/support-hervat.js voor waarom.
 */
function wegTerug(kenmerk) {
  const link = hervatLink(kenmerk);
  if (!link) return '';
  return `<p style="margin:10px 0 0;color:#586374;font-size:12px">Liever de chat? `
       + `<a href="${link}" style="color:#10284A;font-weight:600">Open je gesprek</a>`
       + ` — we sturen je dan een code ter bevestiging.</p>`;
}

function wegTerugTekst(kenmerk) {
  const link = hervatLink(kenmerk);
  return link ? `\n\nLiever de chat? Open je gesprek via ${link} — we sturen je dan een code ter bevestiging.` : '';
}

/**
 * De verificatiecode.
 *
 * Bewust géén link met een token erin: een klikbare link in een mail die om
 * bevestiging vraagt is precies de vorm die phishing nadoet, en de bezoeker
 * heeft de chat toch al open staan. Overtypen van zes cijfers is hier
 * veiliger dan klikken.
 */
export async function stuurVerificatieCode({ naar, code, kenmerk, vanMailbox }) {
  const titel = 'Je code voor de chat';
  const inhoud = `
    <p style="margin:0 0 14px">Je code is:</p>
    <p style="margin:0 0 18px;font-size:30px;letter-spacing:7px;font-weight:700;color:#10284A">${code}</p>
    <p style="margin:0 0 10px">Vul deze in het chatvenster in. De code is 10 minuten geldig.</p>
    <p style="margin:0">Heb je hier niet om gevraagd? Dan hoef je niets te doen — zonder de code gebeurt er niets.</p>`;
  const tekst = `Je code voor de chat is: ${code}\n\nVul deze in het chatvenster in. De code is 10 minuten geldig.\nHeb je hier niet om gevraagd, dan hoef je niets te doen.`;

  return sendEmailViaSmtp({
    fromMailbox: mailbox(vanMailbox),
    to: naar,
    subject: `Je code: ${code}`,
    text: platteTekstMail({ titel, inhoud_tekst: tekst, voetnoot: `Kenmerk ${kenmerk}` }),
    html: renderMailShell({ titel, inhoud_html: inhoud, voetnoot: `Kenmerk ${kenmerk}` }),
  });
}

/**
 * Bevestiging dat de vraag in de wachtrij staat. Alleen sturen als er
 * daadwerkelijk niemand live was — anders krijgt iemand die binnen dertig
 * seconden antwoord kreeg een mail dat we later terugkomen.
 */
export async function stuurWachtrijBevestiging({ naar, naam, kenmerk, vraag, vanMailbox }) {
  const titel = 'We hebben je vraag binnen';
  const inhoud = `
    <p style="margin:0 0 14px">Hoi${naam ? ' ' + naam : ''},</p>
    <p style="margin:0 0 14px">Je vraag staat bij ons in de wachtrij. Je krijgt antwoord op dit mailadres.</p>
    <p style="margin:0 0 6px;color:#586374;font-size:13px">Je vraag:</p>
    <p style="margin:0 0 14px;padding:12px 14px;background:#F2F4F7;border-radius:8px">${String(vraag || '').slice(0, 800).replace(/[<>]/g, '')}</p>
    <p style="margin:0">Kenmerk: <b>${kenmerk}</b> — handig om erbij te houden als je ons belt.</p>
    ${wegTerug(kenmerk)}`;
  const tekst = `Hoi${naam ? ' ' + naam : ''},\n\nJe vraag staat bij ons in de wachtrij. Je krijgt antwoord op dit mailadres.\n\nJe vraag:\n${String(vraag || '').slice(0, 800)}\n\nKenmerk: ${kenmerk}${wegTerugTekst(kenmerk)}`;

  return sendEmailViaSmtp({
    fromMailbox: mailbox(vanMailbox),
    to: naar,
    subject: `We hebben je vraag binnen (${kenmerk})`,
    text: platteTekstMail({ titel, inhoud_tekst: tekst }),
    html: renderMailShell({ titel, inhoud_html: inhoud }),
  });
}

/**
 * Het antwoord van een medewerker, voor als de bezoeker de chat al gesloten
 * heeft. De reply-to is de mailbox zelf, dus een antwoord van de klant komt
 * gewoon in de bestaande e-mailmodule binnen — geen tweede kanaal dat
 * niemand uitleest.
 */
export async function stuurAntwoordMail({ naar, naam, kenmerk, antwoord, medewerker, vanMailbox }) {
  const titel = 'Antwoord op je vraag';
  const inhoud = `
    <p style="margin:0 0 14px">Hoi${naam ? ' ' + naam : ''},</p>
    <p style="margin:0 0 14px;white-space:pre-wrap">${String(antwoord || '').replace(/[<>]/g, '')}</p>
    <p style="margin:0 0 4px">Groet,<br>${medewerker || 'De Forex Opleiding'}</p>
    <p style="margin:18px 0 0;color:#586374;font-size:12px">Je kunt gewoon op deze mail antwoorden — je reactie komt bij ons in hetzelfde gesprek terecht. Kenmerk ${kenmerk}.</p>
    ${wegTerug(kenmerk)}`;
  const tekst = `Hoi${naam ? ' ' + naam : ''},\n\n${antwoord}\n\nGroet,\n${medewerker || 'De Forex Opleiding'}\n\nJe kunt gewoon op deze mail antwoorden — je reactie komt bij ons in hetzelfde gesprek terecht. Kenmerk ${kenmerk}.${wegTerugTekst(kenmerk)}`;

  return sendEmailViaSmtp({
    fromMailbox: mailbox(vanMailbox),
    to: naar,
    subject: `Antwoord op je vraag (${kenmerk})`,
    text: platteTekstMail({ titel, inhoud_tekst: tekst }),
    html: renderMailShell({ titel, inhoud_html: inhoud }),
  });
}
