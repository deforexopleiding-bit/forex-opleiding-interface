// api/events-sync-retry.js
//
// Manual retry van outbound sync voor een specifiek event.
//
// Wordt aangeroepen vanuit de UI (events-detail "Retry sync"-knop) wanneer
// een eerdere sync-poging is gefaald (event.webflow_sync_status === 'failure'
// of event.ghl_sync_status === 'failure'). Re-triggert de orchestrator;
// elke poging logt een nieuwe rij in event_sync_log met opgehoogde
// retry_count.
//
// Permission: events.publish (zelfde gate als initiele publish).
//
// Method: POST
// Body  : { event_id: <uuid>, target?: 'webflow' | 'ghl' | 'both' }
//   - target default 'both' -> volledige syncEventToOutbound
//   - target 'webflow' -> alleen webflow-target re-sync via orchestrator-flow
//     (we triggeren syncEventToOutbound omdat de orchestrator targets intern
//     scheidt en de niet-getargete kant ook netjes herevalueert; per-target
//     splitsing is geen MVP-vereiste, beide targets zijn idempotent).
//
// Response 200: { event_id, webflow: {...}, ghl: {...} }
// Response 403: { error: 'Geen rechten (events.publish)' }
// Response 400: { error: '<validatie-melding>' }
// Response 500: { error: '<exception>' }

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { syncEventToOutbound } from './_lib/event-sync-orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_TARGETS = ['webflow', 'ghl', 'both'];

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
  if (!(await requirePermission(req, 'events.publish'))) {
    return res.status(403).json({ error: 'Geen rechten (events.publish)' });
  }

  const body = req.body || {};
  const eventId = body.event_id ? String(body.event_id) : null;
  const target  = body.target ? String(body.target).toLowerCase() : 'both';

  if (!eventId || !UUID_RE.test(eventId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist' });
  }
  if (!ALLOWED_TARGETS.includes(target)) {
    return res.status(400).json({ error: `target moet ${ALLOWED_TARGETS.join('|')} zijn` });
  }

  try {
    const result = await syncEventToOutbound(eventId);
    return res.status(200).json({
      event_id: eventId,
      target,
      webflow: result?.webflow || null,
      ghl    : result?.ghl     || null,
    });
  } catch (e) {
    console.error('[events-sync-retry]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'sync exception' });
  }
}
