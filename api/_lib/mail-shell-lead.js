// api/_lib/mail-shell-lead.js
//
// Huisstijl-shell voor mails aan leads ("Stuur bericht", massabericht).
// Sinds de mailbouwer (2026-10-11) staat de shell in modules/shared/
// mail-huisstijl.js — één bron voor de verzending (hier) én het live voorbeeld
// in de browser. Dit bestand houdt de bestaande import-paden en zet het logo
// uit de env (MAIL_LOGO_URL).

import {
  renderLeadMail as renderShell, afmeldVoet, afmeldTekst, htmlNaarTekst, STANDAARD_LOGO_URL,
} from '../../modules/shared/mail-huisstijl.js';

const LOGO_URL = process.env.MAIL_LOGO_URL || STANDAARD_LOGO_URL;

export { afmeldVoet, afmeldTekst, htmlNaarTekst };

/** Volledige HTML-mail rond de inhoud. voorkeurenUrl alleen bij massa. */
export function renderLeadMail({ bodyHtml = '', voorkeurenUrl = null } = {}) {
  return renderShell({ bodyHtml, voorkeurenUrl, logoUrl: LOGO_URL });
}
