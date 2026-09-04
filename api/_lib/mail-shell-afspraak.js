// api/_lib/mail-shell-afspraak.js
//
// Branded HTML-mailshell voor de afspraak-flow (bevestiging + reminders).
// Navy #10284A header · witte contentkaart · geel #FFC21A CTA-knop · logo in
// de footer. Volledig inline-CSS + table-layout (mailclient-proof). Géén
// generieke email-handtekening — deze shell heeft z'n eigen footer.
//
// renderAfspraakMail({ titel, inleiding, details:[{label,waarde}], cta:{label,url}, voetnoot })
//   → volledige HTML-string (één <table>-kaart binnen een navy achtergrond).
// platteTekstAfspraak({ titel, inleiding, details, cta, voetnoot })
//   → platte-tekst-fallback (sendEmailViaSmtp vereist `text`).

const NAVY = '#10284A';
const GEEL = '#FFC21A';
const LOGO_URL = process.env.MAIL_LOGO_URL
  || 'https://forex-opleiding-interface.vercel.app/dfo-logo-email.png';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

export function renderAfspraakMail({ titel, inleiding = '', details = [], cta = null, voetnoot = '' } = {}) {
  const detailRows = (details || []).map((d) => `
    <tr>
      <td style="padding:5px 0;color:#5b6b7d;font-size:13px;white-space:nowrap;vertical-align:top">${esc(d.label)}</td>
      <td style="padding:5px 0 5px 14px;color:${NAVY};font-size:13px;font-weight:600;vertical-align:top">${d.waarde /* mag opgemaakte HTML zijn (bv. link) */}</td>
    </tr>`).join('');

  const detailBlok = detailRows
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:14px 0;border-collapse:collapse">${detailRows}</table>`
    : '';

  const ctaBlok = cta && cta.url
    ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:20px 0 4px">
         <a href="${esc(cta.url)}" style="display:inline-block;background:${GEEL};color:${NAVY};text-decoration:none;font-weight:700;font-size:15px;line-height:1;padding:13px 28px;border-radius:8px">${esc(cta.label)}</a>
       </td></tr></table>`
    : '';

  const inleidingBlok = inleiding
    ? `<p style="margin:0 0 4px;color:#2b3a4a;font-size:15px;line-height:1.6">${inleiding}</p>`
    : '';

  const voetnootBlok = voetnoot
    ? `<p style="margin:16px 0 0;color:#7a8798;font-size:12.5px;line-height:1.55">${voetnoot}</p>`
    : '';

  return `<!-- afspraak-mailshell -->
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
          <h1 style="margin:0 0 12px;color:${NAVY};font-size:20px;line-height:1.3">${esc(titel)}</h1>
          ${inleidingBlok}
          ${detailBlok}
          ${ctaBlok}
          ${voetnootBlok}
        </td></tr>
        <!-- footer -->
        <tr><td style="padding:20px 30px 26px;border-top:1px solid #edf0f4;text-align:center">
          <img src="${esc(LOGO_URL)}" alt="De Forex Opleiding" width="150" style="width:150px;max-width:60%;height:auto;opacity:.9">
        </td></tr>
      </table>
    </td></tr>
  </table>
</div>`;
}

export function platteTekstAfspraak({ titel, inleiding = '', details = [], cta = null, voetnoot = '' } = {}) {
  const regels = [];
  if (titel) regels.push(titel, '');
  if (inleiding) regels.push(stripHtml(inleiding), '');
  for (const d of (details || [])) regels.push(`${d.label}: ${stripHtml(String(d.waarde))}`);
  if (details && details.length) regels.push('');
  if (cta && cta.url) regels.push(`${cta.label}: ${cta.url}`, '');
  if (voetnoot) regels.push(stripHtml(voetnoot));
  regels.push('', '— De Forex Opleiding');
  return regels.join('\n');
}

function stripHtml(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}
