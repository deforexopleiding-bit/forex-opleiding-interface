// api/events-reopen-signups.js
// POST -> handmatig inschrijvingen voor een gesloten event heropenen.
//
// Permission: events.event.edit.
//
// Query: ?id=<uuid>  (verplicht)
//
// Pre-flight guard (deadline):
//   Reopen is alleen mogelijk zolang we NIET voorbij middernacht (00:00)
//   Europe/Amsterdam zijn op de dag VOOR het event. Concreet:
//   - Event start op 2026-06-20 10:00 Europe/Amsterdam
//   - Reopen-deadline = 2026-06-19 00:00 Europe/Amsterdam
//   - Na die deadline -> 409 REOPEN_TOO_LATE
//
//   Rationale: zo blijft er minimaal een hele kalenderdag tussen reopen en
//   start, zodat mensen die zich opnieuw kunnen aanmelden niet 's nachts
//   onverwacht een event-toegang krijgen.
//
// Updates events row:
//   signups_closed            = false
//   signups_closed_at         = NULL
//   signups_closed_reason     = NULL
//   signups_closed_by_user_id = NULL
//
// (audit-trail van WIE de reopen heeft uitgevoerd komt in audit_log, niet op
//  de event-row zelf; de close-velden worden bewust genuld zodat een latere
//  close opnieuw met verse audit-data start)
//
// Daarna AWAITED reopenSignupsOutbound(eventId):
//   - Webflow: PATCH /items/{id}/live met isDraft=false (republish)
//   - GHL: recompute upcoming-labels (event komt terug in de set)
//
// Response 200: { event: { ...row }, sync: { webflow, ghl } }
// Response 409 (REOPEN_TOO_LATE): { error, code, deadline_iso, now_iso }
// Response 409 (NOT_CLOSED): { error, code }
// Response 409 (EVENT_ARCHIVED): { error, code }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { reopenSignupsOutbound } from './_lib/event-sync-orchestrator.js';
import { computeReopenDeadlineUtc } from './_lib/reopen-deadline.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  try {
    const { data: cur, error: curErr } = await supabaseAdmin
      .from('events')
      .select('id, status, signups_closed, starts_at')
      .eq('id', id)
      .maybeSingle();
    if (curErr) throw new Error('current-fetch: ' + curErr.message);
    if (!cur)   return res.status(404).json({ error: 'Event niet gevonden' });

    if (cur.status === 'archived') {
      return res.status(409).json({
        error: 'Gearchiveerd event kan niet meer heropend worden',
        code: 'EVENT_ARCHIVED',
      });
    }
    if (cur.signups_closed !== true) {
      return res.status(409).json({
        error: 'Inschrijvingen zijn al open voor dit event',
        code: 'NOT_CLOSED',
      });
    }

    // Deadline-guard: na middernacht Amsterdam op dag voor event -> 409.
    const deadlineUtc = computeReopenDeadlineUtc(cur.starts_at);
    if (!deadlineUtc) {
      return res.status(400).json({ error: 'Event heeft geen geldige starts_at' });
    }
    const now = new Date();
    if (now >= deadlineUtc) {
      return res.status(409).json({
        error: 'Reopen-deadline (middernacht Europe/Amsterdam op dag voor event) is verstreken',
        code: 'REOPEN_TOO_LATE',
        deadline_iso: deadlineUtc.toISOString(),
        now_iso     : now.toISOString(),
      });
    }

    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .update({
        signups_closed           : false,
        signups_closed_at        : null,
        signups_closed_reason    : null,
        signups_closed_by_user_id: null,
      })
      .eq('id', id)
      .select(EVENT_SELECT)
      .maybeSingle();
    if (error) throw new Error('events-reopen-signups: ' + error.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    // AWAITED outbound sync. Webflow republish primair via PATCH /live, fallback
    // via POST /publish. GHL recompute via filter signups_closed=false.
    let sync = null;
    try {
      sync = await reopenSignupsOutbound(ev.id);
    } catch (syncErr) {
      console.error('[events-reopen-signups sync]', syncErr?.message || syncErr);
      sync = { error: syncErr?.message || 'sync exception' };
    }

    // Refetch om bijgewerkte sync-statussen mee te geven.
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
    console.error('[events-reopen-signups]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
