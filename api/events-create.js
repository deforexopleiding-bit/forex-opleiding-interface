// api/events-create.js
// POST -> nieuw event aanmaken (draft of published).
//
// Permission: events.event.create.
//
// Body (JSON):
//   {
//     title:           string  (verplicht, 1..255 chars)
//     starts_at:       ISO     (verplicht)
//     ends_at:         ISO     (optioneel; moet > starts_at zijn)
//     location:        string  (optioneel)
//     capacity:        int     (verplicht, > 0)
//     niveau:          slug    (optioneel — basis|gevorderd uit event_niveau_options)
//     description_md:  string  (optioneel — markdown body)
//     status:          string  (optioneel, default 'draft'; alleen 'draft' of 'published')
//   }
//
// Response 201: { event: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED_STATUS_ON_CREATE = ['draft', 'published'];

function isIsoDate(s) {
  if (typeof s !== 'string' || s.length < 8) return false;
  const d = new Date(s);
  return Number.isFinite(d.getTime());
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

  const body = req.body || {};
  const title       = typeof body.title === 'string' ? body.title.trim() : '';
  const startsAt    = body.starts_at ? String(body.starts_at) : null;
  const endsAt      = body.ends_at ? String(body.ends_at) : null;
  const location    = body.location != null ? String(body.location).trim() : null;
  const capacity    = body.capacity != null ? Number(body.capacity) : null;
  const niveau      = body.niveau != null ? String(body.niveau).trim().toLowerCase() : null;
  const descriptionMd = body.description_md != null ? String(body.description_md) : null;
  const status      = body.status ? String(body.status).toLowerCase() : 'draft';

  // ---- Validatie ----
  if (!title) return res.status(400).json({ error: 'title vereist' });
  if (title.length > 255) return res.status(400).json({ error: 'title te lang (max 255)' });
  if (!isIsoDate(startsAt)) return res.status(400).json({ error: 'starts_at moet ISO 8601 datetime zijn' });
  if (endsAt && !isIsoDate(endsAt)) return res.status(400).json({ error: 'ends_at moet ISO 8601 datetime zijn' });
  if (endsAt && new Date(endsAt) <= new Date(startsAt)) {
    return res.status(400).json({ error: 'ends_at moet na starts_at liggen' });
  }
  if (!Number.isInteger(capacity) || capacity <= 0) {
    return res.status(400).json({ error: 'capacity moet een positief geheel getal zijn' });
  }
  if (!ALLOWED_STATUS_ON_CREATE.includes(status)) {
    return res.status(400).json({ error: `status moet ${ALLOWED_STATUS_ON_CREATE.join('|')} zijn bij create` });
  }

  // Niveau-validatie: moet bestaande actieve slug zijn (als opgegeven).
  if (niveau) {
    const { data: niveauRow, error: niveauErr } = await supabaseAdmin
      .from('event_niveau_options')
      .select('slug, is_active')
      .eq('slug', niveau)
      .maybeSingle();
    if (niveauErr) {
      console.error('[events-create niveau-lookup]', niveauErr.message);
      return res.status(500).json({ error: 'niveau-validatie faalde' });
    }
    if (!niveauRow || !niveauRow.is_active) {
      return res.status(400).json({ error: `niveau '${niveau}' bestaat niet of is inactief` });
    }
  }

  try {
    const insertRow = {
      title,
      starts_at:         startsAt,
      ends_at:           endsAt,
      location:          location || null,
      capacity,
      status,
      niveau:            niveau || null,
      description_md:    descriptionMd,
      created_by_user_id: user?.id || null,
    };

    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .insert(insertRow)
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status, ghl_last_synced_at,
        created_by_user_id, created_at, updated_at
      `)
      .single();
    if (error) throw new Error('events-create insert: ' + error.message);

    return res.status(201).json({ event: ev });
  } catch (e) {
    console.error('[events-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
