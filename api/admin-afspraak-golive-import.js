// api/admin-afspraak-golive-import.js
//
// EENMALIG, afgeschermd import-endpoint (geen cron). Zet bestaande AANKOMENDE
// GHL-afspraken van ALLE actieve agenda's in follow_up_appointments vóór go-live
// (de reguliere poll doet dit daarna doorlopend). Idempotent op
// ghl_appointment_id; vult ghl_calendar_id.
//
// Params:
//   ?days=<n>     venster now → now+n dagen (default 30, max 120)
//   dry_run       DEFAULT true → per agenda (naam) het aantal + de lijst
//                 aankomende afspraken, zodat je vóór go-live kunt reviewen of
//                 er geen niet-kennismakings-afspraken tussen zitten.
//   dry_run:false (alleen via POST) → daadwerkelijk importeren.
//
// RBAC: admin.meta_templates.manage OF super_admin.
// Wijzigt geen statussen van bestaande rijen (de poll blijft daar eigenaar van);
// vult alleen ghl_calendar_id bij als die nog leeg is. Berichten/mails/templates
// ongewijzigd. 0 incasso-writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { fetchGhlContact } from './_lib/ghl-contact.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const CAL_VERSION = '2021-07-28';
const EVENTS_VERSION = '2021-04-15';

function ghlToken() { return process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY || null; }
function isFalse(v) { return v === false || v === 'false' || v === 0 || v === '0' || v === 'nee'; }
function fmtAms(iso) {
  try {
    return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch { return String(iso); }
}
function isFutureScheduled(ev, nowMs) {
  const st = String(ev.appointmentStatus || '').toLowerCase();
  if (['cancelled', 'canceled', 'invalid', 'noshow', 'no_show', 'showed'].includes(st)) return false;
  const t = new Date(ev.startTime).getTime();
  return Number.isFinite(t) && t > nowMs;
}

async function listActiveCalendars(token, loc) {
  try {
    const r = await fetch(`${GHL_BASE}/calendars/?locationId=${encodeURIComponent(loc)}`, {
      headers: { Authorization: `Bearer ${token}`, Version: CAL_VERSION, Accept: 'application/json' },
    });
    if (!r.ok) return [];
    const j = await r.json().catch(() => ({}));
    return (j.calendars || j.data || [])
      .map((c) => ({ id: c.id, name: c.name || null, isActive: (c.isActive !== undefined ? c.isActive : c.is_active) ?? null }))
      .filter((c) => c.id && c.isActive !== false);
  } catch { return []; }
}

async function fetchEvents(token, loc, calId, startMs, endMs) {
  const url = new URL(`${GHL_BASE}/calendars/events`);
  url.searchParams.set('locationId', loc);
  url.searchParams.set('calendarId', calId);
  url.searchParams.set('startTime', String(startMs));
  url.searchParams.set('endTime', String(endMs));
  const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}`, Version: EVENTS_VERSION, Accept: 'application/json' } });
  if (!r.ok) return { ok: false, status: r.status, events: [] };
  const j = await r.json().catch(() => ({}));
  return { ok: true, events: j.events || j.data || [] };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // RBAC
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });
  let toegang = await requirePermission(req, 'admin.meta_templates.manage');
  if (!toegang) {
    const { data: prof } = await supabaseAdmin.from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    toegang = !!prof && prof.is_active && prof.role === 'super_admin';
  }
  if (!toegang) return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage of super_admin)' });

  const token = ghlToken();
  const loc = process.env.GHL_LOCATION_ID;
  if (!token || !loc) return res.status(503).json({ error: 'GHL-token/GHL_LOCATION_ID ontbreekt' });

  const q = req.query || {};
  const body = req.body || {};
  const days = Math.min(Math.max(parseInt(String(body.days ?? q.days ?? '30'), 10) || 30, 1), 120);
  const dryRaw = (body.dry_run !== undefined) ? body.dry_run : (q.dry_run !== undefined ? q.dry_run : true);
  const dryRun = !isFalse(dryRaw);
  if (!dryRun && req.method !== 'POST') return res.status(405).json({ error: 'Echte import (dry_run:false) vereist POST' });

  const nowMs = Date.now();
  const endMs = nowMs + days * 24 * 60 * 60 * 1000;

  const calendars = await listActiveCalendars(token, loc);
  if (calendars.length === 0) return res.status(200).json({ ok: true, dry_run: dryRun, days, calendars: [], note: 'Geen actieve calendars gevonden (of calendars-list faalde).' });

  const perAgenda = [];
  let totaalAfspraken = 0;

  // ── DRY-RUN: per agenda tellen + tonen ──
  if (dryRun) {
    for (const cal of calendars) {
      const { ok, status, events } = await fetchEvents(token, loc, cal.id, nowMs, endMs);
      const relevant = (events || []).filter((e) => isFutureScheduled(e, nowMs));
      totaalAfspraken += relevant.length;
      perAgenda.push({
        calendar_id: cal.id,
        naam: cal.name,
        aantal: relevant.length,
        events_error: ok ? null : ('GHL ' + status),
        afspraken: relevant.slice(0, 100).map((e) => ({
          scheduled_at: e.startTime,
          gepland_amsterdam: fmtAms(e.startTime),
          lead_name: e.title || e.contactName || 'Onbekend',
        })),
      });
    }
    return res.status(200).json({ ok: true, dry_run: true, days, totaal_agenda: calendars.length, totaal_afspraken: totaalAfspraken, per_agenda: perAgenda });
  }

  // ── ECHTE IMPORT ──
  const summary = { geimporteerd: 0, bestond_al: 0, calendar_id_gevuld: 0, overgeslagen: 0, fouten: 0 };
  for (const cal of calendars) {
    const { ok, events } = await fetchEvents(token, loc, cal.id, nowMs, endMs);
    if (!ok) { summary.fouten += 1; continue; }
    for (const ev of (events || [])) {
      if (!isFutureScheduled(ev, nowMs) || !ev.id) { summary.overgeslagen += 1; continue; }
      try {
        const { data: existing } = await supabaseAdmin
          .from('follow_up_appointments')
          .select('id, ghl_calendar_id')
          .eq('ghl_appointment_id', ev.id)
          .maybeSingle();

        if (existing?.id) {
          if (!existing.ghl_calendar_id) {
            const { error } = await supabaseAdmin.from('follow_up_appointments').update({ ghl_calendar_id: cal.id }).eq('id', existing.id);
            if (error) summary.fouten += 1; else summary.calendar_id_gevuld += 1;
          } else {
            summary.bestond_al += 1;
          }
          continue;
        }

        // Nieuw: contactgegevens verrijken (fail-soft) voor realistische reminders.
        let leadEmail = ev.email || null;
        let leadPhone = ev.phone || null;
        if ((!leadEmail || !leadPhone) && ev.contactId) {
          const c = await fetchGhlContact(ev.contactId);
          if (c) { if (!leadEmail) leadEmail = c.email || null; if (!leadPhone) leadPhone = c.phone || null; }
        }

        const row = {
          ghl_appointment_id: ev.id,
          lead_name: ev.title || ev.contactName || 'Onbekend',
          lead_email: leadEmail,
          lead_phone: leadPhone,
          lead_ghl_contact_id: ev.contactId || null,
          scheduled_at: ev.startTime,
          duration_minutes: ev.durationMinutes || 30,
          status: 'scheduled',
          owner_id: process.env.DAVE_PROFILE_ID || null,
          ghl_calendar_id: cal.id,
          updated_at: new Date().toISOString(),
        };
        const { error } = await supabaseAdmin.from('follow_up_appointments').insert(row);
        if (error) summary.fouten += 1; else summary.geimporteerd += 1;
      } catch (e) {
        summary.fouten += 1;
        console.warn('[admin-afspraak-golive-import] event-fout', ev?.id, e?.message || e);
      }
    }
  }

  try {
    await supabaseAdmin.from('follow_up_events_log').insert({
      source: 'admin', event_type: 'afspraak-golive-import',
      payload: { days, totaal_agenda: calendars.length, ...summary, door: user.id }, processed: true,
    });
  } catch (_) { /* niet blokkerend */ }

  return res.status(200).json({ ok: true, dry_run: false, days, totaal_agenda: calendars.length, ...summary });
}
