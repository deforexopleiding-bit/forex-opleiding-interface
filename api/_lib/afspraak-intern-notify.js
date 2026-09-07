// api/_lib/afspraak-intern-notify.js
//
// Content-builders voor de INTERNE "nieuwe afspraak ingeboekt"-melding
// (mail + WhatsApp). Puur — geen send, geen DB. Gebruikt door
// cron-afspraak-reminders.js (de notify-stap).

import { fmtMomentNL } from './afspraak-berichten.js';

// NL datum + tijd (Europe/Amsterdam) — fmtMomentNL bevat al beide, bv.
// "maandag 8 september om 14:00".
export function wanneerNL(scheduledAt) {
  try { return fmtMomentNL(scheduledAt); }
  catch { return String(scheduledAt || ''); }
}

// Bron van een afspraak: booking_source (eigen agendapagina) óf de GHL-agenda-
// naam (calNameMap: Map<calendar_id, name>). Val terug op '—'.
export function bronVan(appt, calNameMap) {
  const bs = String(appt?.booking_source || '').trim();
  if (bs) return bs;
  const cal = appt?.ghl_calendar_id && calNameMap && typeof calNameMap.get === 'function'
    ? (calNameMap.get(appt.ghl_calendar_id) || null) : null;
  return cal || '—';
}

// Interne mail: naam lead, datum/tijd (NL), agenda/bron, telefoon + e-mail.
export function bouwInternMail(appt, bron) {
  const naam    = String(appt?.lead_name || 'Onbekend').trim() || 'Onbekend';
  const wanneer = wanneerNL(appt?.scheduled_at);
  const tel     = appt?.lead_phone || '—';
  const mail    = appt?.lead_email || '—';
  const subject = `Nieuwe afspraak ingeboekt — ${naam}`;
  const text =
    `Er is een nieuwe afspraak ingeboekt.\n\n` +
    `Naam: ${naam}\n` +
    `Wanneer: ${wanneer}\n` +
    `Bron: ${bron}\n` +
    `Telefoon: ${tel}\n` +
    `E-mail: ${mail}\n`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html =
    `<p>Er is een nieuwe afspraak ingeboekt.</p>` +
    `<table cellpadding="4" style="font-size:14px;border-collapse:collapse">` +
    `<tr><td><b>Naam</b></td><td>${esc(naam)}</td></tr>` +
    `<tr><td><b>Wanneer</b></td><td>${esc(wanneer)}</td></tr>` +
    `<tr><td><b>Bron</b></td><td>${esc(bron)}</td></tr>` +
    `<tr><td><b>Telefoon</b></td><td>${esc(tel)}</td></tr>` +
    `<tr><td><b>E-mail</b></td><td>${esc(mail)}</td></tr>` +
    `</table>`;
  return { subject, text, html };
}

// WhatsApp-variabelen [naam, wanneer, bron] — positioneel, matcht de body van
// het template interne_nieuwe_afspraak_nl ({{1}}=naam, {{2}}=wanneer, {{3}}=bron).
export function waVars(appt, bron) {
  return [
    String(appt?.lead_name || 'Onbekend').trim() || 'Onbekend',
    wanneerNL(appt?.scheduled_at),
    String(bron || '—'),
  ].map((v) => String(v ?? ''));
}
