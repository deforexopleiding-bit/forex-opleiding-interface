// api/_lib/onboarding-mail-fallback.js
//
// ONBOARDING zonder WhatsApp-nummer (2026-10-05).
//
// De oude Meta-WABA is geblokkeerd en het nieuwe 360dialog-hoofdnummer is
// voor leads — klanten (onboarding) mogen daar NIET over (zie
// api/_lib/wa-nummers.js). Tot onboarding een eigen nummer heeft, kan de
// onboarding-pipeline (invite + reminders + automations) hetzelfde bericht
// per e-mail sturen vanaf onboarding@deforexopleiding.nl.
//
// AAN/UIT: env ONBOARDING_MAIL_FALLBACK=true. Default UIT, zodat een merge niet
// stilletjes klanten gaat mailen; zonder de vlag geeft de pipeline
// { sent:false, reason:'wa-geen-nummer' } terug (in plaats van een Meta-fout).
//
// Preview-guard: buiten production gaat elke mail naar Jeffrey met [PREVIEW]
// in het onderwerp (zelfde regel als sanne-send-mail.js).

import { kiesVerzendroute, WaGeenNummerError } from './meta-whatsapp.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { renderMailShell, platteTekstMail, escMailHtml } from './mail-shell.js';

export const ONBOARDING_MAILBOX = 'onboarding@deforexopleiding.nl';
const PREVIEW_TO = 'biemoldjeffrey@gmail.com';

export function mailFallbackAan() {
  return String(process.env.ONBOARDING_MAIL_FALLBACK || '').trim().toLowerCase() === 'true';
}

/**
 * Mag onboarding nu via WhatsApp? Alleen als de transport een route geeft die
 * niet geweigerd wordt (= onboarding heeft een eigen nummer in de registry).
 * @returns {Promise<{ wa: true } | { wa: false, reden: string }>}
 */
export async function waRouteOnboarding(phoneNumberId) {
  try {
    await kiesVerzendroute({ phoneNumberId: phoneNumberId || undefined, module: 'onboarding' });
    return { wa: true };
  } catch (e) {
    if (e instanceof WaGeenNummerError) return { wa: false, reden: e.message };
    throw e;
  }
}

/** Template-body met {{1}}, {{2}} … ingevuld (zelfde regel als de whatsapp_messages-preview). */
export function vulTemplateTekst(bodyText, resolved = {}) {
  let t = String(bodyText || '');
  for (const [k, v] of Object.entries(resolved || {})) {
    if (!/^\d+$/.test(k)) continue;
    t = t.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v ?? ''));
  }
  return t;
}

/** WhatsApp-opmaak → eenvoudige HTML: *vet*, _cursief_, links, regeleinden. */
export function waTekstNaarHtml(tekst) {
  return escMailHtml(String(tekst || ''))
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, '$1<i>$2</i>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0A7490">$1</a>')
    .replace(/\n/g, '<br>');
}

/**
 * Stuur het onboarding-bericht als e-mail.
 * @returns {Promise<{ ok: true, messageId: string|null, to: string, preview: boolean } | { ok: false, reason: string }>}
 */
export async function stuurOnboardingMail({ customer, tekst, trajectLabel = null }) {
  const email = String(customer?.email || '').trim();
  if (!email) return { ok: false, reason: 'geen-email' };
  if (!String(tekst || '').trim()) return { ok: false, reason: 'geen-tekst' };
  const isProd = process.env.VERCEL_ENV === 'production';
  const titel = trajectLabel ? `Je start bij De Forex Opleiding — ${trajectLabel}` : 'Je start bij De Forex Opleiding';
  const onderwerp = (isProd ? '' : '[PREVIEW] ') + titel;
  const voetnoot = 'Je ontvangt dit bericht per e-mail omdat we je tijdelijk niet via WhatsApp kunnen bereiken.';
  const res = await sendEmailViaSmtp({
    fromMailbox: ONBOARDING_MAILBOX,
    to: isProd ? email : PREVIEW_TO,
    subject: onderwerp,
    text: platteTekstMail({ titel, inhoud_tekst: tekst, voetnoot }),
    html: renderMailShell({ titel, inhoud_html: waTekstNaarHtml(tekst), voetnoot }),
  });
  if (!res.ok) return { ok: false, reason: res.code || res.reason || 'mail-fout' };
  return { ok: true, messageId: res.messageId || null, to: email, preview: !isProd };
}
