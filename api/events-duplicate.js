// api/events-duplicate.js
//
// POST → kopieer een bestaand event als nieuw concept.
//
// Permission: events.event.create.
//
// Body (JSON):
//   { source_event_id: uuid }
//
// Overgenomen velden: title (prefix "Kopie van "), niveau, description_md,
// location, capacity, image_url.
// Defaults voor nieuw event: status='draft'; starts_at en ends_at worden
// met +7 dagen verschoven (zelfde tijdstip volgende week) zodat het concept
// een sensible default krijgt — daarna kan de gebruiker de datum aanpassen
// via de Bewerken-modal in events-detail.
//
// Webflow- en GHL-sync velden worden NIET gekopieerd (nieuw event begint als
// niet-gesynced concept). Mentoren, attendees, expenses en ledger blijven
// gekoppeld aan het origineel.
//
// Response 200: { ok, event_id, event } — full event-row na insert.
// 400 validatie | 401/403 auth | 404 bron-event | 500 DB-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function shiftIso(iso, ms) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Date(d.getTime() + ms).toISOString();
}

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

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const srcId = typeof body.source_event_id === 'string' ? body.source_event_id.trim() : '';
  if (!srcId || !UUID_RE.test(srcId)) {
    return res.status(400).json({ error: 'source_event_id (uuid) vereist' });
  }

  try {
    const { data: src, error: srcErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, capacity, niveau, description_md, image_url')
      .eq('id', srcId)
      .maybeSingle();
    if (srcErr) throw new Error('source fetch: ' + srcErr.message);
    if (!src) return res.status(404).json({ error: 'Bron-event niet gevonden' });

    const insertRow = {
      title             : 'Kopie van ' + (src.title || 'event'),
      starts_at         : shiftIso(src.starts_at, WEEK_MS),
      ends_at           : shiftIso(src.ends_at, WEEK_MS),
      location          : src.location || null,
      capacity          : src.capacity,
      niveau            : src.niveau || null,
      description_md    : src.description_md || null,
      image_url         : src.image_url || null,
      status            : 'draft',
      created_by_user_id: user?.id || null,
    };

    const { data: newEv, error: insErr } = await supabaseAdmin
      .from('events')
      .insert(insertRow)
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, image_url,
        created_by_user_id, created_at, updated_at
      `)
      .maybeSingle();
    if (insErr) throw new Error('insert: ' + insErr.message);
    if (!newEv) throw new Error('insert leverde geen rij op');

    return res.status(200).json({ ok: true, event_id: newEv.id, event: newEv });
  } catch (e) {
    console.error('[events-duplicate]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
