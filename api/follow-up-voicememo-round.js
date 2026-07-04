// api/follow-up-voicememo-round.js
//
// Cockpit-ochtendronde tegen no-shows. Bron is follow_up_appointments
// (de GHL-gesynchroniseerde Zoom-calls van vandaag), NIET follow_up_leads
// — de leads-tabel bevat geen actuele Zoom-calls.
//
// GET → { leads: [...], counts: { total, sent, open }, today }
//   Appointments met status='gepland' EN scheduled_at::datum = current_date
//   EN zoom_meeting_id IS NOT NULL (dus alleen Zoom-calls). counts.sent =
//   voicememo_status='sent', counts.open = rest.
//
// POST { appointment_id? | all?: true }
//   Zet voicememo_status='sent' (+ voicememo_sent_at, voicememo_sent_by) op
//   1 appointment (of alle vandaag-zooms die nog niet sent zijn). Zelfde
//   waarde-conventie als api/follow-up-appointments.js (enum:
//   pending | sent | skipped | no_whatsapp).
//
// Owner-gate: privileged (super_admin/admin/manager) mag alles; sales mag
// alle vandaag-Zoom-calls markeren (dagtaak, geen per-appointment owner).
// 42P01/42703 → 501 MIGRATION_REQUIRED.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function todayRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const dayIso = `${y}-${m}-${d}`;
  return {
    dayIso,
    startIso: new Date(`${dayIso}T00:00:00`).toISOString(),
    endIso:   new Date(`${dayIso}T23:59:59.999`).toISOString(),
  };
}

async function fetchTodayZoomAppointments() {
  const { startIso, endIso } = todayRange();
  // Status accepteert BEIDE varianten (Engelse 'scheduled' + Nederlandse
  // 'gepland') zodat we niet op nomenclatuur-verschillen missen. De
  // zoom-herkenning verzachten we in JS: sommige calls hebben alleen
  // zoom_join_url, andere alleen zoom_meeting_id. Selecteer beide en
  // filter client-side (a.zoom_meeting_id || a.zoom_join_url).
  const COLS_RICH = 'id, lead_name, lead_phone, scheduled_at, voicememo_status, zoom_meeting_id, zoom_join_url, status';
  const COLS_MID  = 'id, lead_name, lead_phone, scheduled_at, voicememo_status, zoom_meeting_id, status';
  const COLS_MIN  = 'id, lead_name, lead_phone, scheduled_at, voicememo_status, status';

  const runQuery = (cols) => supabaseAdmin
    .from('follow_up_appointments')
    .select(cols)
    .in('status', ['scheduled', 'gepland'])
    .gte('scheduled_at', startIso)
    .lte('scheduled_at', endIso)
    .order('scheduled_at', { ascending: true });

  let rows = null;
  let hadZoomCols = true;
  {
    const { data, error } = await runQuery(COLS_RICH);
    if (!error) { rows = data || []; }
    else if (error.code === '42703') {
      // Probeer zonder zoom_join_url.
      const { data: d2, error: e2 } = await runQuery(COLS_MID);
      if (!e2) { rows = d2 || []; }
      else if (e2.code === '42703') {
        // Zowel zoom_meeting_id als zoom_join_url ontbreken → val terug
        // op alleen status+datum. Zonder Zoom-hint kunnen we niet meer
        // filteren; behandel alles binnen de dag als kandidaat.
        const { data: d3, error: e3 } = await runQuery(COLS_MIN);
        if (e3) {
          if (e3.code === '42P01') { const e = new Error('follow_up_appointments ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
          throw new Error(e3.message);
        }
        rows = d3 || [];
        hadZoomCols = false;
      } else {
        if (e2.code === '42P01') { const e = new Error('follow_up_appointments ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
        throw new Error(e2.message);
      }
    } else {
      if (error.code === '42P01') { const e = new Error('follow_up_appointments ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
      throw new Error(error.message);
    }
  }

  // Zoom-herkenning: minimaal 1 van de twee velden gevuld. Als de
  // zoom-kolommen niet bestaan, laat alles door (schema-fallback).
  if (!hadZoomCols) return rows;
  return rows.filter((a) => !!(a.zoom_meeting_id || a.zoom_join_url));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  try {
    if (req.method === 'GET') {
      const appts = await fetchTodayZoomAppointments();
      const { dayIso } = todayRange();
      const sent = appts.filter((a) => String(a.voicememo_status || '') === 'sent').length;
      // Frontend leest 'leads' (historisch veld-naam) — inhoud is
      // appointments-shape met .id (= appointment_id) + terugbel_datum
      // alias voor de UI zodat de bestaande render blijft werken.
      const leads = appts.map((a) => ({
        id                : a.id,
        lead_name         : a.lead_name,
        lead_phone        : a.lead_phone,
        terugbel_datum    : a.scheduled_at,  // alias — UI gebruikt _fmtHM(terugbel_datum)
        voicememo_status  : a.voicememo_status || 'pending',
        voicememo_sent_on : a.voicememo_status === 'sent' ? dayIso : null,
      }));
      return res.status(200).json({
        leads,
        today  : dayIso,
        counts : { total: appts.length, sent, open: appts.length - sent },
      });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const all           = body.all === true;
      // Accepteer beide vormen: appointment_id (nieuw) en lead_id (legacy
      // frontend die nog niet is bijgewerkt) — beide worden hier als
      // appointment-uuid geïnterpreteerd.
      const targetIdRaw = typeof body.appointment_id === 'string'
        ? body.appointment_id
        : (typeof body.lead_id === 'string' ? body.lead_id : '');
      const targetId    = targetIdRaw.trim();
      if (!all && !targetId) return res.status(400).json({ error: 'appointment_id of all=true vereist' });
      if (targetId && !UUID_RE.test(targetId)) return res.status(400).json({ error: 'appointment_id ongeldig' });

      let ids = [];
      if (all) {
        const appts = await fetchTodayZoomAppointments();
        ids = appts.filter((a) => String(a.voicememo_status || '') !== 'sent').map((a) => a.id);
      } else {
        ids = [targetId];
      }
      if (!ids.length) return res.status(200).json({ ok: true, updated: 0 });

      const nowIso = new Date().toISOString();
      const patch = {
        voicememo_status : 'sent',
        voicememo_sent_at: nowIso,
        voicememo_sent_by: user.id,
        updated_at       : nowIso,
      };
      const { data, error } = await supabaseAdmin
        .from('follow_up_appointments')
        .update(patch)
        .in('id', ids)
        .select('id');
      if (error) {
        if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_appointments ontbreekt', code: 'MIGRATION_REQUIRED' });
        if (error.code === '42703') {
          // Val terug op alleen voicememo_status (oudere schema's).
          const { data: d2, error: e2 } = await supabaseAdmin
            .from('follow_up_appointments')
            .update({ voicememo_status: 'sent' })
            .in('id', ids)
            .select('id');
          if (e2) throw new Error(e2.message);
          return res.status(200).json({ ok: true, updated: (d2 || []).length });
        }
        throw new Error(error.message);
      }
      return res.status(200).json({ ok: true, updated: (data || []).length });
    }

    return res.status(405).json({ error: 'GET/POST only' });
  } catch (e) {
    if (e?.code === 'MIGRATION_REQUIRED') {
      return res.status(501).json({ error: e.message, code: 'MIGRATION_REQUIRED' });
    }
    console.error('[follow-up-voicememo-round]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
