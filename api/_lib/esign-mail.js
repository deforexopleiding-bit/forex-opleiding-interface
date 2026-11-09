// api/_lib/esign-mail.js
//
// E-handtekening — de twee mails, in de DFO-huisstijl van api/_lib/mail-shell.js
// (navy kop, gele knop, logo). Versturen gebeurt in esign-server.js via
// sendMail() uit api/mailer.js (info@, Strato). Puur: alleen tekst bouwen.

import { renderMailShell, platteTekstMail, escMailHtml as esc } from './mail-shell.js';

const ZONE = 'Europe/Brussels';
function dagNl(iso) {
  return new Intl.DateTimeFormat('nl-NL', { timeZone: ZONE, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
}
function voornaam(naam) { return String(naam || '').trim().split(/\s+/)[0] || ''; }

/**
 * Uitnodiging om te tekenen. `link` bevat het token (in de #-hash).
 * @returns {{ subject, html, text }}
 */
export function uitnodigingMail({ envelope, ontvanger, link, afzender, verlooptOp, opnieuw = false }) {
  const titel = 'Document om te ondertekenen';
  const vn = voornaam(ontvanger.naam);
  const van = afzender ? `${afzender} vraagt` : 'We vragen';
  const regels = [
    `Hoi ${vn},`,
    `${van} je om het document "${envelope.titel}" elektronisch te ondertekenen.`,
    envelope.bericht ? `Bericht: ${envelope.bericht}` : null,
    `De link is persoonlijk: stuur deze mail niet door. Hij werkt tot ${dagNl(verlooptOp)}.`,
    opnieuw ? 'Dit is een nieuwe link; een eerdere link werkt niet meer.' : null,
  ].filter(Boolean);
  const html = renderMailShell({
    titel,
    inhoud_html: regels.map((r, i) => i === 2 && envelope.bericht
      ? `<p style="margin:0 0 14px;padding:10px 14px;background:#F4F6FA;border-radius:8px">${esc(envelope.bericht)}</p>`
      : `<p style="margin:0 0 14px">${esc(r)}</p>`).join(''),
    cta: { label: 'Document bekijken en ondertekenen', url: link },
    voetnoot: 'Je ontvangt deze mail omdat je als ondertekenaar bent toegevoegd in het CRM van De Forex Opleiding. Verwachtte je dit niet? Teken dan niet en laat het ons weten.',
  });
  const text = platteTekstMail({
    titel,
    inhoud_tekst: regels.join('\n\n'),
    cta: { label: 'Document bekijken en ondertekenen', url: link },
  });
  return { subject: `Ondertekenen: ${envelope.titel}`, html, text };
}

/**
 * Afronding: het getekende exemplaar zit als bijlage bij de mail.
 * @returns {{ subject, html, text }}
 */
export function voltooidMail({ envelope, naam, sha256, bestandsnaam }) {
  const titel = 'Document ondertekend';
  const regels = [
    `Hoi ${voornaam(naam)},`,
    `Iedereen heeft "${envelope.titel}" ondertekend. Het getekende exemplaar zit als bijlage bij deze mail (${bestandsnaam}), met achteraan het certificaat van ondertekening.`,
    `Controle: de SHA-256 van het getekende bestand is ${sha256}.`,
  ];
  const html = renderMailShell({
    titel,
    inhoud_html: regels.map((r, i) => (i === 2
      ? `<p style="margin:0 0 14px;font-size:12px;color:#5B6576;word-break:break-all">Controle: de SHA-256 van het getekende bestand is <code>${esc(sha256)}</code>.</p>`
      : `<p style="margin:0 0 14px">${esc(r)}</p>`)).join(''),
    voetnoot: 'Bewaar deze mail en de bijlage. Het origineel staat ook veilig opgeslagen in het CRM.',
  });
  const text = platteTekstMail({ titel, inhoud_tekst: regels.join('\n\n') });
  return { subject: `Ondertekend: ${envelope.titel}`, html, text };
}

/** Bestandsnaam voor het getekende exemplaar. */
export function getekendBestandsnaam(titel) {
  const basis = String(titel || 'document').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'document';
  return `${basis}-getekend.pdf`;
}
