// api/events-attendee-delete.js
// POST -> hard-delete van een deelnemer + audit-log entry kort vóór delete.
//
// Permission: events.attendee.delete.
//
// Query: ?id=<uuid>  (verplicht — attendee-id)
//
// Hard-delete is hier veilig omdat alle FK-relaties naar deze rij ON DELETE
// CASCADE staan (event_attendee_audit_log + event_attendee_tags). Het
// audit-log entry vóór delete bevat de volledige before_state zodat we
// historische context behouden, ook al worden de losse audit-rijen
// gecascadeerd.
//
// LET OP: doordat event_attendee_audit_log ON DELETE CASCADE op attendee_id
// staat, wordt onze pre-delete entry óók verwijderd door de cascade. Voor
// volledige bewaring: we schrijven het audit-entry NAAST een entry in
// audit_log (centrale tabel) zodat de delete-historie altijd blijft staan.
//
// Response 200: { deleted: true, id }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!(await requirePermission(req, 'events.attendee.delete'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.delete)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  try {
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('event_attendees')
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        registered_at
      `)
      .eq('id', id)
      .maybeSingle();
    if (beforeErr) throw new Error('before-fetch: ' + beforeErr.message);
    if (!before)   return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // Audit-entry in centrale audit_log (overleeft cascade-delete van
    // event_attendee_audit_log).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user?.id || null,
        action:      'event_attendee.deleted',
        entity_type: 'event_attendee',
        entity_id:   id,
        before_json: before,
        after_json:  null,
        reason_text: null,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[events-attendee-delete audit-central]', e.message);
    }

    // Best-effort entry in event_attendee_audit_log (wordt door cascade gewist,
    // maar bewust om een trace te hebben mocht de cascade ooit veranderen).
    try {
      await supabaseAdmin.from('event_attendee_audit_log').insert({
        attendee_id:  id,
        action:       'deleted',
        before_state: before,
        after_state:  null,
        by_user_id:   user?.id || null,
      });
    } catch (e) {
      console.error('[events-attendee-delete audit-local]', e.message);
    }

    const { error: delErr } = await supabaseAdmin
      .from('event_attendees')
      .delete()
      .eq('id', id);
    if (delErr) throw new Error('delete: ' + delErr.message);

    return res.status(200).json({ deleted: true, id });
  } catch (e) {
    console.error('[events-attendee-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
