// api/events-close-signups.js
// POST -> handmatig inschrijvingen voor een event sluiten.
//
// Permission: events.event.edit.
//
// Query: ?id=<uuid>  (verplicht)
//
// Body (JSON, optioneel):
//   { reason?: 'manual' }  (default 'manual')
//
// Updates events row:
//   signups_closed         = true
//   signups_closed_at      = now()
//   signups_closed_reason  = 'manual'
//   signups_closed_by_user_id = <user.id>
//
// Daarna AWAITED closeSignupsOutbound(eventId):
//   - Webflow: PATCH item naar isDraft=true (staged record blijft)
//   - GHL: recompute upcoming-labels (event valt uit de set)
//
// Response 200: { event: { ...row }, sync: { webflow, ghl } }
//
// Status-checks:
//   - 404 bij onbekend id
//   - 409 als event al signups_closed=true is (idempotent guard)
//   - 409 als status='archived' (gearchiveerde events kun je niet meer sluiten)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { closeSignupsOutbound } from './_lib/event-sync-orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_REASONS = ['manual', 'auto_full', 'auto_deadline'];

const EVENT_SELECT = `
  id, title, starts_at, ends_at, location, capacity, status, niveau,
  description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
  ghl_sync_status, ghl_last_synced_at,
  signups_closed, signups_closed_at, signups_closed_reason, signups_closed_by_user_id,
  created_by_user_id, created_at, updated_at
`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  // Body is optioneel - default reason='manual'.
  let reason = 'manual';
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (body && typeof body.reason === 'string' && body.reason.trim().length > 0) {
      reason = body.reason.trim().toLowerCase();
    }
  } catch {}
  if (!ALLOWED_REASONS.includes(reason)) {
    return res.status(400).json({
      error: `Ongeldige reason: ${reason}; verwacht ${ALLOWED_REASONS.join('|')}`,
    });
  }

  try {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('events')
      .select('id, status, signups_closed')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw new Error('current-fetch: ' + curErr.message);
    if (!cur)   return res.status(404).json({ error: 'Event niet gevonden' });

    if (cur.status === 'archived') {
      return res.status(409).json({
        error: 'Gearchiveerd event kan niet meer gesloten worden',
        code: 'EVENT_ARCHIVED',
      });
    }
    if (cur.signups_closed === true) {
      return res.status(409).json({
        error: 'Inschrijvingen zijn al gesloten voor dit event',
        code: 'ALREADY_CLOSED',
      });
    }

    const nowIso = new Date().toISOString();
    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .update({
        signups_closed           : true,
        signups_closed_at        : nowIso,
        signups_closed_reason    : reason,
        signups_closed_by_user_id: user.id,
      })
      .eq('id', id)
      .select(EVENT_SELECT)
      .maybeSingle();
    if (error) throw new Error('events-close-signups: ' + error.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    // AWAITED outbound sync. Targets zijn binnen de orchestrator geisoleerd in
    // eigen try/catch, dus 1 faal-target neemt de andere niet mee en de DB-flip
    // blijft staan ongeacht sync-uitkomst.
    let sync = null;
    try {
      sync = await closeSignupsOutbound(ev.id);
    } catch (syncErr) {
      console.error('[events-close-signups sync]', syncErr?.message || syncErr);
      sync = { error: syncErr?.message || 'sync exception' };
    }

    // Refetch event om bijgewerkte sync-statussen mee te geven.
    let evAfter = ev;
    try {
      const { data: refetched } = await supabaseAdmin
        .from('events')
        .select(EVENT_SELECT)
        .eq('id', ev.id)
        .maybeSingle();
      if (refetched) evAfter = refetched;
    } catch {}

    return res.status(200).json({ event: evAfter, sync });
  } catch (e) {
    console.error('[events-close-signups]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
