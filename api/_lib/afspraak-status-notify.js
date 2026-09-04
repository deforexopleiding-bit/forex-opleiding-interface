// api/_lib/afspraak-status-notify.js
//
// Bevestiging bij ANNULEREN en VERZETTEN van een afspraak: WhatsApp-template
// (afspraak_annulering_v1 / afspraak_verzet_v1) op de welkom-lijn + mail via de
// branded shell. Wordt EXPLICIET aangeroepen door de mutatie-endpoints ná een
// succesvolle annulering/verzetting.
//
// Idempotent via guard-kolommen (atomair claimen):
//   annulering_sent_at — annuleer-bevestiging verstuurd
//   verzet_sent_at     — verzet-bevestiging verstuurd (de verzet-endpoints
//                        zetten 'm op NULL bij een nieuwe verzetting, zodat een
//                        volgende verzet opnieuw bevestigt).
//
// Alles achter AFSPRAAK_REMINDERS_LIVE — inert tot go-live (dan: geen claim,
// geen send, return {dry:true}). Volledig fail-soft: mag een endpoint nooit
// breken.

import { supabaseAdmin } from '../supabase.js';
import { sendTemplate, MetaNotConfiguredError } from './meta-whatsapp.js';
import { sendEmailViaSmtp } from './send-email-core.js';
import { logOutboundWa } from './wa-outbound-log.js';
import { resolveWelkomPhoneId, bouwContext } from './afspraak-berichten.js';
import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';

const MAIL_FROM = 'onboarding@deforexopleiding.nl';
const PLAN_URL = process.env.AFSPRAAK_ANNULERING_PLAN_URL || 'https://deforexopleiding.nl/agenda/kantoor';
const APPT_COLS = 'id, lead_name, lead_email, lead_phone, scheduled_at, zoom_join_url, afspraak_token, ghl_calendar_id, annulering_reden';

function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}

async function claim(id, kolom) {
  try {
    const { data } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ [kolom]: new Date().toISOString() })
      .eq('id', id).is(kolom, null).select('id').maybeSingle();
    return !!(data && data.id);
  } catch (e) { console.warn('[afspraak-status-notify] claim', kolom, '(soft):', e?.message || e); return false; }
}
async function unclaim(id, kolom) {
  try { await supabaseAdmin.from('follow_up_appointments').update({ [kolom]: null }).eq('id', id); } catch (_) { /* soft */ }
}
async function haalAppt(id) {
  const { data } = await supabaseAdmin.from('follow_up_appointments').select(APPT_COLS).eq('id', id).maybeSingle();
  return data || null;
}

// Mail-builders (zelfde branded shell als de 5 reminder-mails).
function annuleringMail(c, reden) {
  const args = {
    subject: 'Je afspraak is geannuleerd',
    titel: 'Je afspraak is geannuleerd',
    inleiding: `Hoi ${c.voornaam}, je kennismakingsgesprek met De Forex Opleiding van ${c.momentNL} is geannuleerd.`,
    cta: { label: 'Plan een nieuw moment', url: PLAN_URL },
    voetnoot: 'Wil je alsnog kennismaken? Plan gerust een nieuw moment. Tot snel!',
  };
  return { subject: args.subject, html: renderAfspraakMail(args), text: platteTekstAfspraak(args) };
}
function verzetMail(c) {
  const args = {
    subject: 'Je afspraak is verzet',
    titel: 'Je afspraak is verzet ✅',
    inleiding: `Hoi ${c.voornaam}, gelukt — je kennismakingsgesprek met De Forex Opleiding is verzet naar een nieuw moment.`,
    details: [
      { label: 'Nieuw moment', waarde: c.momentNL },
      { label: 'Waar', waarde: c.zoom ? `<a href="${c.zoom}" style="color:#10284A">Deelnemen via Zoom</a>` : 'Via Zoom' },
    ],
    cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
    voetnoot: 'Je krijgt vóór de afspraak nog een herinnering. Tot dan!',
  };
  return { subject: args.subject, html: renderAfspraakMail(args), text: platteTekstAfspraak(args) };
}

async function verstuur(appt, { template, waVars, mail }) {
  const uit = { wa: null, mail: null };

  const welkomPhoneId = await resolveWelkomPhoneId();
  if (!welkomPhoneId) uit.wa = { ok: false, skipped: 'welkom-phone-ontbreekt' };
  else if (!appt.lead_phone) uit.wa = { ok: false, skipped: 'geen-telefoon' };
  else {
    const variables = waVars.map((v) => String(v ?? ''));
    try {
      const { wamid } = await sendTemplate({ to: appt.lead_phone, templateName: template, languageCode: 'nl', variables, phoneNumberId: welkomPhoneId });
      const varsMap = {}; variables.forEach((v, i) => { varsMap[String(i + 1)] = v; });
      await logOutboundWa(supabaseAdmin, {
        toPhone: appt.lead_phone, phoneNumberId: welkomPhoneId,
        body: `WhatsApp-template '${template}' — ${variables.join(' · ')}`,
        wamid, templateName: template, templateVariables: varsMap, source: 'afspraak-status-notify',
      });
      uit.wa = { ok: true, wamid };
    } catch (e) {
      uit.wa = e instanceof MetaNotConfiguredError ? { ok: false, skipped: 'meta-niet-geconfigureerd' } : { ok: false, error: e?.message || String(e), http_status: e?.httpStatus ?? null };
    }
  }

  if (!appt.lead_email) uit.mail = { ok: false, skipped: 'geen-email' };
  else {
    try {
      const r = await sendEmailViaSmtp({ fromMailbox: MAIL_FROM, to: appt.lead_email, subject: mail.subject, text: mail.text, html: mail.html });
      uit.mail = r?.ok ? { ok: true, messageId: r.messageId || null } : { ok: false, error: r?.reason || 'onbekend', code: r?.code };
    } catch (e) { uit.mail = { ok: false, error: e?.message || String(e) }; }
  }
  return uit;
}

/** Bevestiging bij annuleren. appointmentId = uuid. reden = optioneel (voor logging). */
export async function stuurAnnuleringBericht(appointmentId, { reden } = {}) {
  try {
    if (!aanUit(process.env.AFSPRAAK_REMINDERS_LIVE)) return { dry: true };
    const appt = await haalAppt(appointmentId);
    if (!appt) return { skipped: 'niet-gevonden' };
    if (!appt.ghl_calendar_id) return { skipped: 'geen-agenda-scope' }; // alleen kennismakings-agenda's
    if (!(await claim(appointmentId, 'annulering_sent_at'))) return { skipped: 'al-verstuurd' };
    const c = bouwContext(appt);
    const r = await verstuur(appt, { template: 'afspraak_annulering_v1', waVars: [c.voornaam, c.momentNL, PLAN_URL], mail: annuleringMail(c, reden) });
    if (!(r.wa?.ok || r.mail?.ok)) await unclaim(appointmentId, 'annulering_sent_at');
    return r;
  } catch (e) { console.warn('[afspraak-status-notify] annulering (soft):', e?.message || e); return { error: e?.message || String(e) }; }
}

/** Bevestiging bij verzetten. appointmentId = uuid van de (nieuwe) afspraak-rij.
 *  De verzet-endpoints zetten verzet_sent_at=NULL in hun update, zodat deze claim slaagt. */
export async function stuurVerzetBericht(appointmentId) {
  try {
    if (!aanUit(process.env.AFSPRAAK_REMINDERS_LIVE)) return { dry: true };
    const appt = await haalAppt(appointmentId);
    if (!appt) return { skipped: 'niet-gevonden' };
    if (!appt.ghl_calendar_id) return { skipped: 'geen-agenda-scope' }; // alleen kennismakings-agenda's
    if (!(await claim(appointmentId, 'verzet_sent_at'))) return { skipped: 'al-verstuurd' };
    const c = bouwContext(appt);
    const r = await verstuur(appt, { template: 'afspraak_verzet_v1', waVars: [c.voornaam, c.momentNL, c.zoom], mail: verzetMail(c) });
    if (!(r.wa?.ok || r.mail?.ok)) await unclaim(appointmentId, 'verzet_sent_at');
    return r;
  } catch (e) { console.warn('[afspraak-status-notify] verzet (soft):', e?.message || e); return { error: e?.message || String(e) }; }
}
