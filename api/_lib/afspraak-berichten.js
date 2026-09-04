// api/_lib/afspraak-berichten.js
//
// Bericht-definities voor de afspraak-flow: per moment de WhatsApp-template
// (naam + positionele vars) én de e-mail (subject/text/html via de branded
// mailshell). Plus formatting-helpers en de welkom-lijn-resolver.
//
// De 5 momenten en hun WA-templates (LIVE, goedgekeurd bij Meta):
//   bevestiging → afspraak_bevestiging_v1  [voornaam, moment, zoom, self]
//   r24         → afspraak_reminder_24u_v1  [voornaam, moment, zoom, self]
//   r2          → afspraak_reminder_2u_v1   [voornaam, tijd]           (+quick-reply)
//   r30         → afspraak_reminder_30m_v1  [voornaam, tijd, zoom]     (+quick-reply)
//   zoom5       → afspraak_zoom_5min_v1     [voornaam, zoom]
//
// Quick-reply-knoppen ("Ik ben erbij") zitten in de goedgekeurde template zelf
// en hebben geen runtime-parameters — sendTemplate hoeft ze niet mee te geven.

import { supabaseAdmin } from '../supabase.js';
import { renderAfspraakMail, platteTekstAfspraak } from './mail-shell-afspraak.js';

export const MIN = 60 * 1000;
export const UUR = 60 * MIN;

const SELFSERVICE_BASE = (process.env.AFSPRAAK_SELFSERVICE_BASE || 'https://deforexopleiding.nl').replace(/\/+$/, '');

// ── Welkom-lijn (zelfde nummer als de toegang-flow, zodat replies in dezelfde
//    inbox landen). Losse kopie zodat cron-toegang-aanvragen.js ongemoeid blijft.
export async function resolveWelkomPhoneId() {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('phone_number_id')
      .eq('module', 'leadsonderhoud')
      .eq('is_active', true)
      .maybeSingle();
    if (data?.phone_number_id) return String(data.phone_number_id).trim();
  } catch (e) {
    console.warn('[afspraak-berichten] welkom-phone lookup (soft):', e?.message || e);
  }
  return process.env.WELKOM_WHATSAPP_PHONE_NUMBER_ID || null;
}

// ── Formatting ─────────────────────────────────────────────────────────────
export function voornaamVan(leadName) {
  const eerste = String(leadName || '').trim().split(/\s+/)[0];
  return eerste || 'daar';
}
export function fmtMomentNL(scheduledAt) {
  const d = new Date(scheduledAt);
  const dag = new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', weekday: 'long', day: 'numeric', month: 'long',
  }).format(d);
  return `${dag} om ${fmtTijdNL(scheduledAt)}`;
}
export function fmtTijdNL(scheduledAt) {
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(scheduledAt));
}
export function selfServiceUrl(token) {
  return `${SELFSERVICE_BASE}/afspraak/${encodeURIComponent(token)}`;
}

// Context die elke bericht-builder krijgt.
export function bouwContext(appt) {
  return {
    voornaam: voornaamVan(appt.lead_name),
    momentNL: fmtMomentNL(appt.scheduled_at),
    tijdNL:   fmtTijdNL(appt.scheduled_at),
    zoom:     appt.zoom_join_url || '',
    selfUrl:  appt.afspraak_token ? selfServiceUrl(appt.afspraak_token) : SELFSERVICE_BASE,
  };
}

function zoomDetail(zoom) {
  return zoom
    ? `<a href="${zoom}" style="color:#10284A">Deelnemen via Zoom</a>`
    : 'Via Zoom';
}
function bouwMail(args) {
  return {
    subject: args.subject,
    html:    renderAfspraakMail(args),
    text:    platteTekstAfspraak(args),
  };
}

// ── De 5 momenten ──────────────────────────────────────────────────────────
// match(appt, nowMs) bepaalt (los van de nacht-guard) of dit moment nú van
// toepassing is. De cron voegt de nacht-onderdrukking toe voor nachtGevoelig.
export const MOMENTEN = [
  {
    key: 'bevestiging',
    kolom: 'bevestiging_sent_at',
    nachtGevoelig: true,
    vereistZoom: true,               // pas versturen zodra de Zoom-link binnen is
    match: (a, nowMs) => !a.bevestiging_sent_at && !!a.zoom_join_url && new Date(a.scheduled_at).getTime() > nowMs,
    waTemplate: 'afspraak_bevestiging_v1',
    waVars: (a, c) => [c.voornaam, c.momentNL, c.zoom, c.selfUrl],
    mail: (a, c) => bouwMail({
      subject: 'Je kennismakingsgesprek staat gepland',
      titel: 'Je kennismakingsgesprek staat gepland ✅',
      inleiding: `Hoi ${c.voornaam}, gelukt! Je kennismakingsgesprek met De Forex Opleiding staat gepland. In ongeveer 20 minuten kijken we samen naar jouw situatie en je doelen, en maken we een persoonlijk plan. Geen verplichtingen.`,
      details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
      voetnoot: `Kan het onverhoopt niet doorgaan? Je kunt je afspraak <a href="${c.selfUrl}" style="color:#10284A">verzetten of annuleren</a>.`,
    }),
  },
  {
    key: 'r24',
    kolom: 'reminder_24u_at',
    nachtGevoelig: true,
    venster: { onder: 2 * UUR, boven: 24 * UUR },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_24u_at && t > 2 * UUR && t <= 24 * UUR; },
    waTemplate: 'afspraak_reminder_24u_v1',
    waVars: (a, c) => [c.voornaam, c.momentNL, c.zoom, c.selfUrl],
    mail: (a, c) => bouwMail({
      subject: 'Herinnering: morgen je kennismakingsgesprek',
      titel: 'Tot morgen! 🙌',
      inleiding: `Hoi ${c.voornaam}, nog even een vriendelijke herinnering: morgen staat je kennismakingsgesprek met De Forex Opleiding gepland. Zorg dat je er een paar minuten van tevoren klaar voor zit.`,
      details: [{ label: 'Wanneer', waarde: c.momentNL }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
      voetnoot: `Komt het net niet uit? Je kunt je afspraak nog <a href="${c.selfUrl}" style="color:#10284A">verzetten naar een ander moment</a>.`,
    }),
  },
  {
    key: 'r2',
    kolom: 'reminder_2u_at',
    nachtGevoelig: false,
    venster: { onder: 30 * MIN, boven: 2 * UUR },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_2u_at && t > 30 * MIN && t <= 2 * UUR; },
    waTemplate: 'afspraak_reminder_2u_v1',
    waVars: (a, c) => [c.voornaam, c.tijdNL],
    mail: (a, c) => bouwMail({
      subject: 'Over 2 uur: je kennismakingsgesprek',
      titel: 'Over 2 uur is het zover 🎯',
      inleiding: `Hoi ${c.voornaam}, over 2 uur (om ${c.tijdNL}) start je kennismakingsgesprek met De Forex Opleiding. We hebben speciaal tijd voor jou vrijgemaakt.`,
      details: [{ label: 'Wanneer', waarde: `Vandaag om ${c.tijdNL}` }, { label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
    }),
  },
  {
    key: 'r30',
    kolom: 'reminder_30m_at',
    nachtGevoelig: false,
    alleenOnbevestigd: true,          // 30m alleen als lead nog niet bevestigd heeft
    venster: { onder: 5 * MIN, boven: 30 * MIN },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.reminder_30m_at && !a.bevestigd_at && t > 5 * MIN && t <= 30 * MIN; },
    waTemplate: 'afspraak_reminder_30m_v1',
    waVars: (a, c) => [c.voornaam, c.tijdNL, c.zoom],
    mail: (a, c) => bouwMail({
      subject: 'Over 30 minuten begint je kennismakingsgesprek',
      titel: 'Over 30 minuten begint je gesprek',
      inleiding: `Hoi ${c.voornaam}, over 30 minuten (${c.tijdNL}) begint je kennismakingsgesprek en we houden je plek graag vrij. Laat je ons even weten of het je lukt?`,
      details: [{ label: 'Waar', waarde: zoomDetail(c.zoom) }],
      cta: c.zoom ? { label: 'Deelnemen via Zoom', url: c.zoom } : null,
    }),
  },
  {
    key: 'zoom5',
    kolom: 'zoom_5min_at',
    nachtGevoelig: false,
    venster: { onder: 0, boven: 5 * MIN },
    match: (a, nowMs) => { const t = new Date(a.scheduled_at).getTime() - nowMs; return !a.zoom_5min_at && t > 0 && t <= 5 * MIN; },
    waTemplate: 'afspraak_zoom_5min_v1',
    waVars: (a, c) => [c.voornaam, c.zoom],
    mail: (a, c) => bouwMail({
      subject: 'We beginnen zo — join je kennismakingsgesprek',
      titel: 'We beginnen zo! ⏱️',
      inleiding: `Hoi ${c.voornaam}, over ongeveer 5 minuten start je kennismakingsgesprek. Klik hieronder om direct te joinen.`,
      cta: c.zoom ? { label: 'Nu deelnemen', url: c.zoom } : null,
      voetnoot: 'Lukt het inloggen niet meteen? Stuur ons even een berichtje, dan helpen we je er zo doorheen.',
    }),
  },
];
