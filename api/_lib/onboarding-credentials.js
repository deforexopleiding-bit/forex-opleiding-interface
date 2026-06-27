// api/_lib/onboarding-credentials.js
//
// Helper voor het versturen van Bubble-inloggegevens via e-mail naar een
// net-aangemaakte onboarding-student. Fail-soft: gooit NOOIT door naar de
// caller.
//
// EMAIL — sendCredentialsEmail({onboarding, customer, tempPassword, loginUrl})
//   * Gebruikt sendEventMail + wrapEmailHtml uit api/mailer.js (zelfde
//     mail-laag als events-invite).
//   * Persoonlijke welkomstmail met inloglink + e-mailadres + tijdelijk
//     wachtwoord + instructie 'log in en stel direct je eigen wachtwoord in'.
//   * Geen DB-write — caller bepaalt of/wat ie persist (typisch
//     credentials_email_sent_at = now bij sent=true).
//
// TIJDELIJK WACHTWOORD wordt NOOIT in de DB gepersist — alleen meegegeven
// aan de buitenwereld via mail en daarna verloren. credentials_email_sent_at
// houdt alleen het tijdstip bij (zichtbaarheid).
//
// HISTORIE: er bestond ook een sendCredentialsWhatsApp + endpoint
// onboarding-credentials-resend voor een WhatsApp-credentials-flow. Verwijderd
// nadat Meta de wachtwoord-via-WA templates niet meer goedkeurt (UTILITY-
// category-policy). DB-kolom credentials_wa_sent_at blijft bestaan (historische
// data); read-pad in onboarding-detail.js laat 'm passeren.

import { sendOnboardingMail, wrapEmailHtml } from '../mailer.js';

// Onboarding-welkomstmail vertrekt vanaf onboarding@deforexopleiding.nl via
// het eigen SMTP-transport in mailer.sendOnboardingMail (auth-user = From,
// dus SPF/DKIM blijft kloppen). Bij ontbrekende ONBOARDING_MAIL_PASS valt
// die helper veilig terug op het info@-transport.

function defaultLoginUrl() {
  return (process.env.BUBBLE_LOGIN_URL && process.env.BUBBLE_LOGIN_URL.trim())
    || 'https://dashboard.deforexopleiding.nl';
}

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────
// EMAIL
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stuur een persoonlijke welkomstmail met inloggegevens.
 *
 * @param {object} opts
 * @param {object} opts.onboarding   - onboarding-row (minimaal { id })
 * @param {object} opts.customer     - customer-row (first_name, email, ...)
 * @param {string} opts.tempPassword - tijdelijk wachtwoord uit Bubble-workflow
 * @param {string} [opts.loginUrl]   - default uit env BUBBLE_LOGIN_URL
 * @returns {Promise<{sent:boolean, reason?:string, message_id?:string}>}
 */
export async function sendCredentialsEmail({ onboarding, customer, tempPassword, loginUrl }) {
  try {
    if (!customer || !customer.email) return { sent: false, reason: 'geen-email' };
    if (!tempPassword) return { sent: false, reason: 'geen-temp-password' };

    const url = (typeof loginUrl === 'string' && loginUrl.trim()) ? loginUrl.trim() : defaultLoginUrl();
    const naam = (customer.first_name || '').trim() || 'jij';
    const subject = 'Je inloggegevens voor De Forex Opleiding';

    const bodyHtml = `
      <p style="margin:0 0 14px;font-size:15px;color:#111827">Hoi ${escHtml(naam)},</p>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.55">
        Welkom! Hieronder vind je de inloggegevens voor je persoonlijke leeromgeving op het Forex-opleidingsplatform.
      </p>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;margin:18px 0">
        <tr><td style="padding:14px 18px">
          <div style="font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;font-weight:700">Inloglink</div>
          <div style="font-size:14px;margin-top:4px"><a href="${escHtml(url)}" style="color:#093d54;text-decoration:underline;word-break:break-all">${escHtml(url)}</a></div>
          <div style="font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;font-weight:700;margin-top:14px">Gebruikersnaam</div>
          <div style="font-size:14px;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#111827">${escHtml(customer.email)}</div>
          <div style="font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase;font-weight:700;margin-top:14px">Tijdelijk wachtwoord</div>
          <div style="font-size:14px;margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#111827;background:#fff;border:1px dashed #d1d5db;border-radius:6px;padding:7px 10px;display:inline-block">${escHtml(tempPassword)}</div>
        </td></tr>
      </table>
      <p style="margin:0 0 14px;font-size:14px;color:#374151;line-height:1.55">
        <strong>Belangrijk:</strong> log direct in en stel je eigen wachtwoord in via je profiel-instellingen. Het tijdelijke wachtwoord blijft beperkt geldig.
      </p>
      <p style="margin:24px 0 0;font-size:13px;color:#6b7280">
        Heb je problemen met inloggen? Antwoord op deze e-mail of stuur een WhatsApp naar de onboarding-lijn.
      </p>
      <p style="margin:18px 0 0;font-size:13px;color:#6b7280">— De Forex Opleiding</p>
    `;
    const html = wrapEmailHtml(subject, bodyHtml);

    // sendOnboardingMail = eigen onboarding@-transport (auth = onboarding@).
    // Fallback naar info@ als ONBOARDING_MAIL_PASS ontbreekt — geen
    // welkomstmail mag stilvallen op een ontbrekende env-var.
    const result = await sendOnboardingMail({
      to:      customer.email,
      subject,
      html,
      text:    `Hoi ${naam}, je inloggegevens voor De Forex Opleiding:\n\nInloglink: ${url}\nGebruikersnaam: ${customer.email}\nTijdelijk wachtwoord: ${tempPassword}\n\nLog direct in en stel je eigen wachtwoord in.\n— De Forex Opleiding`,
    });
    if (!result || result.success !== true) {
      return { sent: false, reason: 'mail-fail', message_id: null };
    }
    return { sent: true, message_id: result.messageId || null };
  } catch (e) {
    console.error('[onboarding-credentials] email fail:', e?.message || e);
    return { sent: false, reason: 'email-exception', error: e?.message || String(e) };
  }
}
