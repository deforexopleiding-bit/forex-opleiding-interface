// api/events-delete.js
// POST -> soft-delete (archive) van een event + Webflow CMS-cleanup.
//
// Permission: events.event.delete.
//
// Query: ?id=<uuid>  (verplicht)
//
// Pattern: GEEN DB-hard-delete. We zetten status='archived' zodat
// event_attendees + audit-log behouden blijven (event_attendees.event_id
// is ON DELETE RESTRICT). Aan de Webflow-kant doen we WEL een hard-delete
// (CMS-item permanent weg).
//
// Idempotentie: dit endpoint mag onbeperkt opnieuw aangeroepen worden.
//   - already archived + webflow_item_id IS NULL -> 200 { noop: true, code: 'already_deleted' }
//   - already archived + webflow_item_id NOT NULL -> ga door met Webflow-cleanup (retry-pad)
//   - niet archived -> archive + Webflow-cleanup
//
// Link-verbreking semantiek: webflow_item_id wordt PAS op NULL gezet nadat
// de Webflow-cleanup bevestigd success of 404 (al weg) returnt. Bij
// retryable failure (429/5xx/network) blijft de link staan zodat een
// herdraai/cron de opruiming herpakt.
//
// Response 200: {
//   event: {...row},
//   archived: bool,
//   webflow_cleanup: 'done' | 'deferred' | 'none',
//   retryable?: bool,
//   sync: <orchestrator-result>
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { hardDeleteEventOutbound } from './_lib/event-sync-orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_SELECT = `
  id, title, starts_at, ends_at, location, capacity, status, niveau,
  description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
  ghl_sync_status, ghl_last_synced_at,
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
  if (!(await requirePermission(req, 'events.event.delete'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.delete)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('events')
      .select('id, status, webflow_item_id')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw new Error('current-fetch: ' + curErr.message);
    if (!cur)   return res.status(404).json({ error: 'Event niet gevonden' });

    // Idempotent already-archived pad.
    if (cur.status === 'archived' && !cur.webflow_item_id) {
      // Volledig opgeruimd in een eerdere call - niets meer te doen.
      const { data: rowNow } = await supabaseAdmin
        .from('events')
        .select(EVENT_SELECT)
        .eq('id', id)
        .maybeSingle();
      return res.status(200).json({
        event          : rowNow || null,
        archived       : true,
        noop           : true,
        code           : 'already_deleted',
        webflow_cleanup: 'none',
      });
    }

    // Archive-stap: alleen UPDATE als status nog niet 'archived'. Bij
    // already-archived + lingering item slaan we de UPDATE over en gaan
    // direct naar de Webflow-cleanup (retry-pad).
    let ev;
    if (cur.status !== 'archived') {
      const { data: row, error } = await supabaseAdmin
        .from('events')
        .update({ status: 'archived' })
        .eq('id', id)
        .select(EVENT_SELECT)
        .maybeSingle();
      if (error) throw new Error('events-delete (archive): ' + error.message);
      if (!row)  return res.status(404).json({ error: 'Event niet gevonden' });
      ev = row;
    } else {
      // already archived + webflow_item_id NOT NULL: fetch volledige rij.
      const { data: row } = await supabaseAdmin
        .from('events')
        .select(EVENT_SELECT)
        .eq('id', id)
        .maybeSingle();
      ev = row;
    }

    // Webflow + GHL cleanup. hardDeleteEventOutbound returnt:
    //   { eventId, webflow: { ok, cleanup_status, retryable?, ... }, ghl: {...} }
    // Bij cleanup_status='done' is webflow_item_id al genuld door de
    // orchestrator. Bij 'deferred' blijft de link staan voor herdraai.
    let sync = null;
    try {
      sync = await hardDeleteEventOutbound(ev.id);
    } catch (syncErr) {
      console.error('[events-delete sync]', syncErr?.message || syncErr);
      sync = { error: syncErr?.message || 'sync exception' };
    }

    // Map orchestrator-output naar de publieke webflow_cleanup-shape.
    let webflowCleanup = 'none';
    let retryable      = undefined;
    if (sync && sync.webflow) {
      const wf = sync.webflow;
      if (wf.cleanup_status === 'done') {
        webflowCleanup = 'done';
      } else if (wf.cleanup_status === 'deferred') {
        webflowCleanup = 'deferred';
        retryable      = wf.retryable === true;
      } else if (wf.cleanup_status === 'none') {
        webflowCleanup = 'none';
      } else if (wf.status === 'failure' || wf.ok === false) {
        // Defensieve fallback: oudere orchestrator-paden zonder
        // cleanup_status discriminator behandelen als deferred.
        webflowCleanup = 'deferred';
        retryable      = wf.retryable === true || wf.error_code === 'RATE_LIMIT' || wf.error_code === 'WEBFLOW_DOWN';
      }
    }

    // Refetch om de meest actuele rij terug te geven (orchestrator heeft
    // webflow_item_id / webflow_sync_status mogelijk gewijzigd).
    let evAfter = ev;
    try {
      const { data: refetched } = await supabaseAdmin
        .from('events')
        .select(EVENT_SELECT)
        .eq('id', ev.id)
        .maybeSingle();
      if (refetched) evAfter = refetched;
    } catch {}

    const response = {
      event          : evAfter,
      archived       : evAfter.status === 'archived',
      webflow_cleanup: webflowCleanup,
      sync,
    };
    if (retryable !== undefined) response.retryable = retryable;
    if (webflowCleanup === 'deferred') {
      response.message = 'Webflow-cleanup uitgesteld; herdraai dit endpoint om het opnieuw te proberen.';
    }
    return res.status(200).json(response);
  } catch (e) {
    console.error('[events-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
