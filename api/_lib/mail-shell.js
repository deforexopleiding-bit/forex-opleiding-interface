// api/_lib/mail-shell.js
//
// Herbruikbare branded HTML-mailshell — generalisatie van mail-shell-afspraak.js.
// Navy #10284A header · witte contentkaart · geel #FFC21A CTA-knop · logo in de
// footer. Volledig inline-CSS + table-layout (mailclient-proof: Outlook eet
// geen CSS-classes / geen modern box-model).
//
// Design-referentie: de bestaande Zoom-call-bevestigingsmail
// (renderAfspraakMail). Deze module is de VLAKKE variant — geen details-tabel
// tussen intro en CTA, alleen kop → intro-alinea's → gele CTA → korte voetnoot.
// Voor mails die wél een label:waarde-tabel willen (afspraken, factuur-details)
// blijft renderAfspraakMail in mail-shell-afspraak.js beschikbaar.
//
// renderMailShell({ titel, inhoud_html, cta:{label,url}, voetnoot }) → HTML-string
// platteTekstMail({ titel, inhoud_tekst, cta:{label,url}, voetnoot })   → plain-text
//
// LOGO — 2026-09-17 gewijzigd naar de canonieke crm.deforexopleiding.nl-URL
// (was forex-opleiding-interface.vercel.app dat een 307-redirect deed; sommige
// mail-clients volgen die niet en tonen dan geen logo). Bevestigd 200 OK · 23 KB
// · 360×204 px op de canonieke URL — daarom width=150 height=85 hardcoded
// (aspect ratio 360:204 ≈ 1.765 → 150 / 1.765 = 85, exact behouden).

const NAVY = '#10284A';
const GEEL = '#FFC21A';
const LOGO_URL = process.env.MAIL_LOGO_URL
  || 'https://crm.deforexopleiding.nl/dfo-logo-email.png';
const LOGO_W = 150;
const LOGO_H = 85; // native 360x204 → 150 × 85 (aspect ratio behouden)

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

/**
 * Vlakke shell: kop → intro-html → gele CTA (optioneel) → voetnoot (optioneel).
 * Geen details-tabel. Bedoeld voor toelating, welkom, reset-password en soort-
 * gelijke transactionele mails.
 *
 * @param {object} opts
 * @param {string} opts.titel       Kop-tekst, ge-escaped (plain string).
 * @param {string} opts.inhoud_html Body-HTML (mag <p>, <b>, <a>, <ul>, <li>
 *                                   bevatten). Wordt letterlijk overgenomen.
 * @param {{label:string,url:string}|null} [opts.cta]
 *                                   Als aanwezig: gele knop onder de body.
 * @param {string} [opts.voetnoot]  Rustige voetnoot-HTML boven de logo-footer.
 * @returns {string} volledige HTML-string (Outlook-vriendelijk).
 */
function renderMailShell({ titel, inhoud_html = '', cta = null, voetnoot = '' } = {}) {
  const ctaBlok = cta && cta.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:22px 0 6px">
         <a href="${esc(cta.url)}" style="display:inline-block;background:${GEEL};color:${NAVY};text-decoration:none;font-weight:700;font-size:15px;line-height:1;padding:13px 28px;border-radius:8px">${esc(cta.label)}</a>
       </td></tr></table>`
    : '';

  const voetnootBlok = voetnoot
    ? `<p style="margin:22px 0 0;color:#7a8798;font-size:12.5px;line-height:1.6">${voetnoot}</p>`
    : '';

  return `<!-- mail-shell -->
<div style="margin:0;padding:0;background:#eef1f5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(16,40,74,.08)">
        <!-- header -->
        <tr><td style="background:${NAVY};padding:22px 30px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.2px;font-family:Arial,Helvetica,sans-serif">De Forex Opleiding</div>
        </td></tr>
        <!-- content -->
        <tr><td style="padding:28px 30px 26px;font-family:Arial,Helvetica,sans-serif">
          <h1 style="margin:0 0 14px;color:${NAVY};font-size:20px;line-height:1.3">${esc(titel)}</h1>
          <div style="color:#2b3a4a;font-size:15px;line-height:1.6">${inhoud_html}</div>
          ${ctaBlok}
          ${voetnootBlok}
        </td></tr>
        <!-- footer met logo -->
        <tr><td style="padding:20px 30px 26px;border-top:1px solid #edf0f4;text-align:center">
          <img src="${esc(LOGO_URL)}" alt="De Forex Opleiding" width="${LOGO_W}" height="${LOGO_H}" style="width:${LOGO_W}px;max-width:60%;height:auto;opacity:.9;display:inline-block;border:0" />
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

/**
 * Platte-tekst-versie van renderMailShell. sendMail vereist altijd een
 * text-fallback (Gmail/Outlook show plain text als HTML blocked).
 *
 * @param {object} opts
 * @param {string} opts.titel
 * @param {string} opts.inhoud_tekst  Plain text (met \n line-breaks).
 * @param {{label,url}|null} [opts.cta]
 * @param {string} [opts.voetnoot]    Plain text.
 */
function platteTekstMail({ titel, inhoud_tekst = '', cta = null, voetnoot = '' } = {}) {
  const regels = [];
  if (titel) regels.push(titel, '');
  if (inhoud_tekst) regels.push(stripHtml(inhoud_tekst), '');
  if (cta && cta.url) regels.push(`${cta.label}: ${cta.url}`, '');
  if (voetnoot) regels.push(stripHtml(voetnoot), '');
  regels.push('— De Forex Opleiding');
  return regels.join('\n');
}

function stripHtml(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .trim();
}

export { renderMailShell, platteTekstMail, esc as escMailHtml, stripHtml };
