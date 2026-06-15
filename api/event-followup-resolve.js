// api/event-followup-resolve.js
// POST -> markeer een event-follow-up als afgehandeld.
//
// Permission: events.attendee.edit (operatie op een bestaande deelnemer-rij).
//
// Body (JSON):
//   { followup_id: uuid, note?: string }
//
// Response 200:
//   { ok, followup: { id, status, handled_at, handled_by, note } }
//
// Errors:
//   400  body-validatie
//   401  geen sessie
//   403  geen rechten
//   404  followup niet gevonden
//   409  ALREADY_HANDLED (al status='afgehandeld')
//   500  DB-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'events.attendee.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.attendee.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const followupId = body.followup_id ? String(body.followup_id) : null;
  if (!followupId || !UUID_RE.test(followupId)) {
    return res.status(400).json({ error: 'followup_id (uuid) vereist' });
  }
  const note = body.note != null ? String(body.note).slice(0, 2000) : null;

  try {
    const { data: existing, error: fErr } = await supabaseAdmin
      .from('event_followups')
      .select('id, status')
      .eq('id', followupId)
      .maybeSingle();
    if (fErr) throw new Error('followup-lookup: ' + fErr.message);
    if (!existing) return res.status(404).json({ error: 'Follow-up niet gevonden' });
    if (existing.status === 'afgehandeld') {
      return res.status(409).json({
        code: 'ALREADY_HANDLED',
        error: 'Follow-up is al afgehandeld',
      });
    }

    const nowIso = new Date().toISOString();
    const upd = {
      status     : 'afgehandeld',
      handled_at : nowIso,
      handled_by : user.id,
    };
    if (note != null) upd.note = note;

    const { data: row, error: uErr } = await supabaseAdmin
      .from('event_followups')
      .update(upd)
      .eq('id', followupId)
      .select('id, status, handled_at, handled_by, note')
      .single();
    if (uErr) throw new Error('followup-update: ' + uErr.message);

    return res.status(200).json({ ok: true, followup: row });
  } catch (e) {
    console.error('[event-followup-resolve]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
