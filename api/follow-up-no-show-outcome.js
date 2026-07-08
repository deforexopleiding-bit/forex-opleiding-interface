// api/follow-up-no-show-outcome.js
//
// POST — Registreer de opvolg-uitkomst voor een no-show attendee.
//
// Body:
//   { attendee_id: uuid,
//     outcome:     'ander_event' | 'geen_interesse' | 'niet_bereikt' | 'terugbellen',
//     note?:       string (optioneel — voor toekomstige audit-log-integratie) }
//
// Effect: zet event_attendees.no_show_followup_status + _at.
//   'ander_event'     → verdwijnt uit no-show-lijst (bereikt, verplaatst)
//   'geen_interesse'  → verdwijnt uit no-show-lijst (bereikt, klant afscheid)
//   'niet_bereikt'    → blijft zichtbaar met markering
//   'terugbellen'     → blijft zichtbaar met markering
//
// Fail-soft 42703 → 501 { code: 'MIGRATION_REQUIRED' } zodat de UI netjes
// een migratie-notice kan tonen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(['ander_event', 'geen_interesse', 'niet_bereikt', 'terugbellen']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'events.event.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const attendeeId = typeof body.attendee_id === 'string' ? body.attendee_id.trim() : '';
  const outcome    = String(body.outcome || '').trim();

  if (!attendeeId || !UUID_RE.test(attendeeId)) {
    return res.status(400).json({ error: 'attendee_id (uuid) vereist' });
  }
  if (!OUTCOMES.has(outcome)) {
    return res.status(400).json({ error: `outcome ongeldig; verwacht: ${[...OUTCOMES].join(' | ')}` });
  }

  try {
    // Verifieer bestaan + no-show-status (voorkomt writes op willekeurige attendees).
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, status, event_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) {
      if (attErr.code === '42P01') return res.status(501).json({ error: 'event_attendees ontbreekt', code: 'MIGRATION_REQUIRED' });
      throw new Error('attendee fetch: ' + attErr.message);
    }
    if (!attendee) return res.status(404).json({ error: 'Attendee niet gevonden' });
    if (attendee.status !== 'no_show') {
      return res.status(400).json({ error: 'Attendee heeft geen no-show-status' });
    }

    const { error: upErr } = await supabaseAdmin
      .from('event_attendees')
      .update({
        no_show_followup_status: outcome,
        no_show_followup_at    : new Date().toISOString(),
      })
      .eq('id', attendeeId);

    if (upErr) {
      if (upErr.code === '42703' || upErr.code === 'PGRST204') {
        // Kolommen ontbreken (migratie nog niet gedraaid / schema-cache stale).
        return res.status(501).json({
          error: 'no_show_followup_status kolom ontbreekt — draai migratie 024',
          code : 'MIGRATION_REQUIRED',
        });
      }
      throw new Error('attendee update: ' + upErr.message);
    }

    return res.status(200).json({
      ok         : true,
      attendee_id: attendeeId,
      outcome,
      updated_at : new Date().toISOString(),
    });
  } catch (e) {
    console.error('[follow-up-no-show-outcome]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
