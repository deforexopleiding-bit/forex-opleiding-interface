// api/follow-up-voicememo-round.js
//
// Ochtendronde tegen no-shows: Dave/sales stuurt korte voicememo naar iedere
// Zoom-lead die vandaag een gesprek heeft. Endpoint is dual-purpose.
//
// GET → { leads: [...], counts: { total, sent, open } }
//   Zoom-leads (lead_kind='zoom') met terugbel_datum::date = current_date.
//   Terugbel_datum kolomtype is timestamptz; we filteren via day-range in
//   applicatie-code (from 00:00 to 23:59:59 vandaag) om timezone-issues
//   met snelle inserts te vermijden.
//
// POST { lead_id? | all?: true }
//   Zet voicememo_sent_on = current_date op één lead of alle vandaag-zooms.
//   Logt per lead een note entry_kind='voicememo' outcome_code='voicememo'.
//   Owner-gate: privileged (super_admin/admin/manager) mag alles; sales
//   mag alle vandaag-zooms markeren (dagtaak, geen per-lead-owner check).
//
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

async function insertVoicememoNote(leadId, userId, text) {
  const trimmed = String(text || '').slice(0, 4000);
  const attempt = async (payload) => supabaseAdmin
    .from('follow_up_lead_notes').insert(payload).select('id').maybeSingle();

  const p1 = { lead_id: leadId, note: trimmed, created_by_user_id: userId, entry_kind: 'voicememo', outcome_code: 'voicememo' };
  const p2 = { lead_id: leadId, note: trimmed, created_by_user_id: userId, entry_kind: 'voicememo' };
  const p3 = { lead_id: leadId, note: trimmed, created_by_user_id: userId };
  for (const p of [p1, p2, p3]) {
    const { data, error } = await attempt(p);
    if (!error) return data;
    if (error.code !== '42703') { console.warn('[voicememo] note:', error.message); return null; }
  }
  return null;
}

async function fetchTodayZooms() {
  const { startIso, endIso } = todayRange();
  const COLS = 'id, lead_name, lead_phone, terugbel_datum, voicememo_sent_on, lead_kind';
  const { data, error } = await supabaseAdmin
    .from('follow_up_leads')
    .select(COLS)
    .eq('lead_kind', 'zoom')
    .gte('terugbel_datum', startIso)
    .lte('terugbel_datum', endIso)
    .order('terugbel_datum', { ascending: true });
  if (error) {
    if (error.code === '42P01') { const e = new Error('follow_up_leads ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
    if (error.code === '42703') { const e = new Error('lead_kind of voicememo_sent_on kolom ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
    throw new Error(error.message);
  }
  return data || [];
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
      const leads = await fetchTodayZooms();
      const { dayIso } = todayRange();
      const sent = leads.filter((l) => String(l.voicememo_sent_on || '') === dayIso).length;
      return res.status(200).json({
        leads,
        today  : dayIso,
        counts : { total: leads.length, sent, open: leads.length - sent },
      });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const all    = body.all === true;
      const leadId = typeof body.lead_id === 'string' ? body.lead_id.trim() : '';
      if (!all && !leadId) return res.status(400).json({ error: 'lead_id of all=true vereist' });
      if (leadId && !UUID_RE.test(leadId)) return res.status(400).json({ error: 'lead_id ongeldig' });

      const { dayIso } = todayRange();
      let targetIds = [];
      if (all) {
        const leads = await fetchTodayZooms();
        targetIds = leads.filter((l) => String(l.voicememo_sent_on || '') !== dayIso).map((l) => l.id);
      } else {
        targetIds = [leadId];
      }

      if (!targetIds.length) return res.status(200).json({ ok: true, updated: 0 });

      const patch = { voicememo_sent_on: dayIso, updated_at: new Date().toISOString() };
      // Fallback bij 42703 (kolom voicememo_sent_on ontbreekt) → 501.
      const { data, error } = await supabaseAdmin
        .from('follow_up_leads')
        .update(patch)
        .in('id', targetIds)
        .select('id')
        ;
      if (error) {
        if (error.code === '42P01') return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
        if (error.code === '42703') return res.status(501).json({ error: 'Kolom voicememo_sent_on ontbreekt', code: 'MIGRATION_REQUIRED' });
        throw new Error(error.message);
      }
      const updatedIds = (data || []).map((r) => r.id);
      // Notes per lead loggen (best-effort, geen blokker).
      for (const id of updatedIds) {
        try { await insertVoicememoNote(id, user.id, 'Voicememo verstuurd ter voorbereiding op Zoom-call'); }
        catch (_) { /* fail-soft */ }
      }
      return res.status(200).json({ ok: true, updated: updatedIds.length });
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
