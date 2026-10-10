// api/_lib/mail-shell-lead.js
//
// Huisstijl-shell voor handmatige 1-op-1 mails aan leads ("Stuur bericht").
// Zelfde look als de afspraak-mails (mail-shell-afspraak.js): navy kop, witte
// kaart, logo in de voet — maar met VRIJE inhoud uit de editor. De inhoud moet
// al opgeschoond zijn (lead-bericht.js → schoonHtml). Inline-CSS + tabellen,
// mailclient-proof. De vaste groet staat onder de inhoud.

const NAVY = '#10284A';
const LOGO_URL = process.env.MAIL_LOGO_URL || 'https://crm.deforexopleiding.nl/dfo-logo-email.png';
const LOGO_W = 150;
const LOGO_H = 85;

// Mailclients negeren <style>: elementen uit de editor krijgen inline opmaak.
const OPMAAK = {
  p: 'margin:0 0 12px;color:#2b3a4a;font-size:15px;line-height:1.6',
  div: 'color:#2b3a4a;font-size:15px;line-height:1.6',
  h2: `margin:18px 0 8px;color:${NAVY};font-size:18px;line-height:1.3`,
  h3: `margin:16px 0 6px;color:${NAVY};font-size:16px;line-height:1.3`,
  ul: 'margin:0 0 12px;padding-left:22px;color:#2b3a4a;font-size:15px;line-height:1.6',
  ol: 'margin:0 0 12px;padding-left:22px;color:#2b3a4a;font-size:15px;line-height:1.6',
  li: 'margin:0 0 4px',
  blockquote: 'margin:0 0 12px;padding:8px 14px;border-left:3px solid #FFC21A;color:#4a5868;font-size:15px;line-height:1.6',
};

function metOpmaak(html) {
  return String(html || '').replace(/<(p|div|h2|h3|ul|ol|li|blockquote)>/g, (m, t) => `<${t} style="${OPMAAK[t]}">`);
}

const escAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Afmeldregel onder een massamail (alleen bij massa). PURE. */
export function afmeldVoet(voorkeurenUrl) {
  if (!voorkeurenUrl) return '';
  return `<tr><td style="padding:0 30px 22px;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#8a96a3">
          Je ontvangt deze mail omdat je je bij De Forex Opleiding hebt aangemeld.<br>
          Liever minder of geen mails? <a href="${escAttr(voorkeurenUrl)}" style="color:#5b6b7c;text-decoration:underline">Voorkeuren aanpassen of afmelden</a>.
        </td></tr>`;
}

/** Platte-tekstversie van de afmeldregel. PURE. */
export function afmeldTekst(voorkeurenUrl) {
  return voorkeurenUrl ? `\n\n—\nLiever minder of geen mails? Voorkeuren aanpassen of afmelden: ${voorkeurenUrl}` : '';
}

/** Volledige HTML-mail rond (opgeschoonde) editor-inhoud. voorkeurenUrl alleen bij massa. */
export function renderLeadMail({ bodyHtml = '', voorkeurenUrl = null } = {}) {
  return `<!-- lead-mailshell -->
<div style="margin:0;padding:0;background:#eef1f5">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f5;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 4px rgba(16,40,74,.08)">
        <tr><td style="background:${NAVY};padding:22px 30px">
          <div style="color:#ffffff;font-size:17px;font-weight:700;letter-spacing:.2px;font-family:Arial,Helvetica,sans-serif">De Forex Opleiding</div>
        </td></tr>
        <tr><td style="padding:28px 30px 22px;font-family:Arial,Helvetica,sans-serif;color:#2b3a4a;font-size:15px;line-height:1.6">
          ${metOpmaak(bodyHtml)}
          <p style="margin:18px 0 0;color:#2b3a4a;font-size:15px;line-height:1.6">Met vriendelijke groet,<br><br>Team - De Forex Opleiding</p>
        </td></tr>
        <tr><td style="padding:20px 30px 26px;border-top:1px solid #edf0f4;text-align:center">
          <img src="${LOGO_URL}" alt="De Forex Opleiding" width="${LOGO_W}" height="${LOGO_H}" style="width:${LOGO_W}px;max-width:60%;height:auto;opacity:.9;display:inline-block;border:0" />
        </td></tr>
        ${afmeldVoet(voorkeurenUrl)}
      </table>
    </td></tr>
  </table>
</div>`;
}

const ENTITEITEN = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Platte-tekstversie (verplicht voor sendEmailViaSmtp, en de draad-bubbel). */
export function htmlNaarTekst(html) {
  let s = String(html || '');
  s = s.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, tekst) => {
    const t = tekst.replace(/<[^>]+>/g, '').trim();
    return t && t !== href ? `${t} (${href})` : href;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|h2|h3|ul|ol|blockquote)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITEITEN[m] || m);
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
