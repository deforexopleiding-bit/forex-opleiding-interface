// api/_lib/onboarding-credentials.js
//
// Twee herbruikbare helpers voor het versturen van Bubble-inloggegevens
// (e-mail + WhatsApp) naar een net-aangemaakte onboarding-student. Beide
// fail-soft: gooien NOOIT door naar de caller.
//
// EMAIL — sendCredentialsEmail({onboarding, customer, tempPassword, loginUrl})
//   * Gebruikt sendEventMail + wrapEmailHtml uit api/mailer.js (zelfde
//     mail-laag als events-invite).
//   * Persoonlijke welkomstmail met inloglink + e-mailadres + tijdelijk
//     wachtwoord + instructie 'log in en stel direct je eigen wachtwoord in'.
//   * Geen DB-write — caller bepaalt of/wat ie persist (typisch
//     credentials_email_sent_at = now bij sent=true).
//
// WHATSAPP — sendCredentialsWhatsApp({onboarding, customer, tempPassword,
//                                     sentByUserId, source})
//   * Gebruikt sendOnboardingTemplateGeneric (geen nieuwe Meta-client).
//   * Template-naam + language uit
//     joost_config.knowledge_base.credentials.{template_name, language, enabled}.
//   * Lege template_name → {sent:false, reason:'geen-template-config'}.
//   * enabled=false (default true) → {sent:false, reason:'credentials-uit-gezet'}.
//   * extraOnboardingCtx levert temp_password + login_url aan
//     {{onboarding.temp_password}} / {{onboarding.login_url}} placeholders.
//
// TIJDELIJK WACHTWOORD wordt NOOIT in de DB gepersist — alleen meegegeven
// aan de buitenwereld via mail/WA en daarna verloren. credentials_email_sent_at
// + credentials_wa_sent_at houden alleen het tijdstip bij (zichtbaarheid).

import { supabaseAdmin } from '../supabase.js';
import { sendEventMail, wrapEmailHtml } from '../mailer.js';
import { sendOnboardingTemplateGeneric } from './onboarding-template-send.js';

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

    const result = await sendEventMail({
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

// ─────────────────────────────────────────────────────────────────────────
// WHATSAPP
// ─────────────────────────────────────────────────────────────────────────

/**
 * Stuur de inloggegevens via WhatsApp (template).
 *
 * @param {object} opts
 * @param {string} opts.onboardingId   - uuid van de onboarding (verplicht voor send-pipeline)
 * @param {string} opts.tempPassword   - tijdelijk wachtwoord uit Bubble-workflow
 * @param {string|null} [opts.sentByUserId]
 * @param {string} [opts.source='manual']
 * @returns {Promise<{sent:boolean, reason?:string, error?:string, ...}>}
 */
export async function sendCredentialsWhatsApp({
  onboardingId,
  tempPassword,
  sentByUserId = null,
  source = 'manual',
} = {}) {
  if (!onboardingId) return { sent: false, reason: 'no-onboarding-id' };
  if (!tempPassword) return { sent: false, reason: 'geen-temp-password' };

  // Config lezen (template_name + language + enabled).
  let templateName = '';
  let languageCode = 'nl';
  try {
    const { data: jcfg, error: jErr } = await supabaseAdmin
      .from('joost_config')
      .select('knowledge_base')
      .eq('module', 'onboarding')
      .maybeSingle();
    if (jErr) return { sent: false, reason: 'db-error', error: 'joost_config: ' + jErr.message };
    const kb = (jcfg?.knowledge_base && typeof jcfg.knowledge_base === 'object') ? jcfg.knowledge_base : {};
    const cfg = (kb.credentials && typeof kb.credentials === 'object') ? kb.credentials : {};
    templateName = typeof cfg.template_name === 'string' ? cfg.template_name.trim() : '';
    languageCode = typeof cfg.language === 'string' && cfg.language.trim()
      ? cfg.language.trim().toLowerCase() : 'nl';
    const credentialsEnabled = cfg.enabled !== false;
    if (!credentialsEnabled) return { sent: false, reason: 'credentials-uit-gezet' };
    if (!templateName) return { sent: false, reason: 'geen-template-config' };
  } catch (e) {
    console.error('[onboarding-credentials] cfg fail:', e?.message || e);
    return { sent: false, reason: 'cfg-exception', error: e?.message || String(e) };
  }

  const loginUrl = defaultLoginUrl();

  return await sendOnboardingTemplateGeneric({
    onboardingId,
    templateName,
    languageCode,
    source,
    sentByUserId,
    auditAction: 'onboarding.credentials.sent',
    extraOnboardingCtx: {
      temp_password: tempPassword,
      login_url:     loginUrl,
    },
  });
}
