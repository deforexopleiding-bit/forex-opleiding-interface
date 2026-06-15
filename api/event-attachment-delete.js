// api/event-attachment-delete.js
// POST -> verwijder een e-mail-bijlage uit de bibliotheek.
//
// Permission: events.event.create (zelfde key als toevoegen — beheer-rol).
//
// Body (JSON): { id: uuid }
//
// Flow:
//   1. Haal rij op (id).
//   2. Als storage_path gezet is → supabaseAdmin.storage.from('event-images')
//      .remove([storage_path]). Faal-soft: errors worden gelogd, maar de
//      DB-rij verdwijnt sowieso.
//   3. Verwijder de rij uit event_mail_attachments.
//
// Response 200: { ok: true, id }
// Errors: 400 / 401 / 403 / 404 / 500

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET  = 'event-images';

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
  if (!(await requirePermission(req, 'events.event.create'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.create)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id = body.id ? String(body.id) : null;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id (uuid) vereist' });
  }

  try {
    const { data: row, error: selErr } = await supabaseAdmin
      .from('event_mail_attachments')
      .select('id, storage_path')
      .eq('id', id)
      .maybeSingle();
    if (selErr) throw new Error('attachment-lookup: ' + selErr.message);
    if (!row) return res.status(404).json({ error: 'Bijlage niet gevonden' });

    // Storage-cleanup (fail-soft) als het een upload was.
    if (row.storage_path) {
      try {
        const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove([row.storage_path]);
        if (rmErr) console.error('[event-attachment-delete storage]', rmErr.message);
      } catch (e) {
        console.error('[event-attachment-delete storage-exception]', e?.message || e);
      }
    }

    const { error: delErr } = await supabaseAdmin
      .from('event_mail_attachments')
      .delete()
      .eq('id', id);
    if (delErr) throw new Error('attachment-delete: ' + delErr.message);

    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error('[event-attachment-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
