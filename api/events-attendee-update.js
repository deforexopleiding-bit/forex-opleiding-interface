// api/events-attendee-update.js
// PATCH -> partial update van een deelnemer.
//
// Permission: events.attendee.edit.
//
// Query: ?id=<uuid>  (verplicht — attendee-id)
//
// Body (JSON, partial): { first_name?, last_name?, email?, phone?, customer_id?,
//                         follow_up_flagged?, follow_up_reason? }
//
// NB: status-wijziging gaat via events-attendee-status-change.js (aparte endpoint
//     met capacity-check + auto-tagging + timestamp-stempels).
//
// Audit-log: per veld dat verandert een entry met action='updated.<field>'.
// Email-uniciteit: 409 EMAIL_EXISTS bij duplicate.
//
// Response 200: { attendee: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EDITABLE_FIELDS = ['first_name', 'last_name', 'email', 'phone', 'customer_id', 'follow_up_flagged', 'follow_up_reason', 'called', 'notes'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  const body = req.body || {};
  const patch = {};

  for (const f of EDITABLE_FIELDS) {
    if (body[f] === undefined) continue;
    const v = body[f];
    switch (f) {
      case 'first_name':
      case 'last_name':
      case 'phone':
        patch[f] = v === null || v === '' ? null : String(v).trim();
        break;
      case 'email':
        if (v === null || v === '') patch.email = null;
        else {
          const e = String(v).trim();
          if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'email ongeldig' });
          patch.email = e;
        }
        break;
      case 'customer_id':
        if (v === null || v === '') patch.customer_id = null;
        else {
          if (!UUID_RE.test(String(v))) return res.status(400).json({ error: 'customer_id moet uuid zijn' });
          patch.customer_id = String(v);
        }
        break;
      case 'follow_up_flagged':
        patch.follow_up_flagged = !!v;
        break;
      case 'follow_up_reason':
        patch.follow_up_reason = v === null || v === '' ? null : String(v).trim();
        break;
      case 'called':
        patch.called_at = v ? new Date().toISOString() : null;
        break;
      case 'notes':
        // FEATURE B — vrije-tekst notitie. Lege string → null zodat een
        // gewiste notitie ook echt weg is (in plaats van een lege string).
        patch.notes = v === null ? null : (String(v).trim() || null);
        break;
      default:
        // shouldn't reach
        break;
    }
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  try {
    // Customer-id check: bestaande klant
    if (patch.customer_id) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id')
        .eq('id', patch.customer_id)
        .maybeSingle();
      if (custErr) throw new Error('customer-lookup: ' + custErr.message);
      if (!cust)   return res.status(400).json({ error: 'customer_id verwijst niet naar bestaande klant' });
    }

    // Before-state ophalen voor audit-log diff
    const { data: before, error: beforeErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, customer_id, follow_up_flagged, follow_up_reason')
      .eq('id', id)
      .maybeSingle();
    if (beforeErr) throw new Error('before-fetch: ' + beforeErr.message);
    if (!before)   return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    const { data: row, error } = await supabaseAdmin
      .from('event_attendees')
      .update(patch)
      .eq('id', id)
      .select(`
        id, event_id, first_name, last_name, email, phone, status,
        customer_id, deal_id, subscription_id,
        ghl_contact_id, ghl_form_submission_id, assessment_response_id,
        switched_from_event_id, switched_at,
        registered_at, attended_at, no_show_marked_at, sale_at,
        follow_up_flagged, follow_up_reason, called_at,
        created_at, updated_at
      `)
      .maybeSingle();
    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({
          code:  'EMAIL_EXISTS',
          error: 'Deze email is al aangemeld voor dit event',
        });
      }
      throw new Error('attendee-update: ' + error.message);
    }
    if (!row) return res.status(404).json({ error: 'Deelnemer niet gevonden' });

    // Audit-log per veld dat veranderde (fail-soft)
    try {
      const auditRows = [];
      for (const k of Object.keys(patch)) {
        if (before[k] === patch[k]) continue;
        auditRows.push({
          attendee_id:  id,
          action:       `updated.${k}`,
          before_state: { [k]: before[k] },
          after_state:  { [k]: patch[k] },
          by_user_id:   user?.id || null,
        });
      }
      if (auditRows.length > 0) {
        const { error: auErr } = await supabaseAdmin.from('event_attendee_audit_log').insert(auditRows);
        if (auErr) console.error('[events-attendee-update audit-insert]', auErr.message);
      }
    } catch (e) {
      console.error('[events-attendee-update audit]', e.message);
    }

    return res.status(200).json({ attendee: row });
  } catch (e) {
    console.error('[events-attendee-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
