// api/events-update.js
// PATCH -> partial update van een event.
//
// Permission: events.event.edit.
//
// Query: ?id=<uuid>  (verplicht)
//
// Body (JSON, partial):
//   {
//     title?, starts_at?, ends_at?, location?, capacity?,
//     niveau?, description_md?, status?
//   }
//
// Status-overgangen die hier toegestaan zijn:
//   - draft  <-> published    (toggle terug naar draft mag, handig bij correcties)
//   - draft|published -> cancelled
//   - cancelled -> archived (handmatig opruimen)
//   Voor archive-via-soft-delete: gebruik events-delete.js (action='archived').
//
// Response 200: { event: { ...row } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { syncEventToOutbound, unpublishEventOutbound } from './_lib/event-sync-orchestrator.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_STATUS = ['draft', 'published', 'cancelled', 'archived'];

function isIsoDate(s) {
  if (typeof s !== 'string' || s.length < 8) return false;
  const d = new Date(s);
  return Number.isFinite(d.getTime());
}

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
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  const id = req.query?.id ? String(req.query.id) : null;
  if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });

  const body = req.body || {};
  const patch = {};

  if (body.title !== undefined) {
    const t = typeof body.title === 'string' ? body.title.trim() : '';
    if (!t) return res.status(400).json({ error: 'title mag niet leeg zijn' });
    if (t.length > 255) return res.status(400).json({ error: 'title te lang (max 255)' });
    patch.title = t;
  }
  if (body.starts_at !== undefined) {
    if (!isIsoDate(body.starts_at)) return res.status(400).json({ error: 'starts_at moet ISO 8601 datetime zijn' });
    patch.starts_at = String(body.starts_at);
  }
  if (body.ends_at !== undefined) {
    if (body.ends_at === null) patch.ends_at = null;
    else {
      if (!isIsoDate(body.ends_at)) return res.status(400).json({ error: 'ends_at moet ISO 8601 datetime zijn' });
      patch.ends_at = String(body.ends_at);
    }
  }
  if (body.location !== undefined) {
    patch.location = body.location === null ? null : String(body.location).trim() || null;
  }
  if (body.capacity !== undefined) {
    const c = Number(body.capacity);
    if (!Number.isInteger(c) || c <= 0) {
      return res.status(400).json({ error: 'capacity moet een positief geheel getal zijn' });
    }
    patch.capacity = c;
  }
  if (body.niveau !== undefined) {
    if (body.niveau === null || body.niveau === '') patch.niveau = null;
    else patch.niveau = String(body.niveau).trim().toLowerCase();
  }
  if (body.description_md !== undefined) {
    patch.description_md = body.description_md === null ? null : String(body.description_md);
  }
  if (body.status !== undefined) {
    const st = String(body.status).toLowerCase();
    if (!ALLOWED_STATUS.includes(st)) {
      return res.status(400).json({ error: `status moet ${ALLOWED_STATUS.join('|')} zijn` });
    }
    patch.status = st;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  try {
    // Cross-field check: als zowel starts_at als ends_at in patch zitten, of als
    // alleen 1 wordt geupdated, valideer tegen huidige row.
    if (patch.starts_at !== undefined || patch.ends_at !== undefined) {
      const { data: cur, error: curErr } = await supabaseAdmin
        .from('events')
        .select('starts_at, ends_at')
        .eq('id', id)
        .maybeSingle();
      if (curErr) throw new Error('current-fetch: ' + curErr.message);
      if (!cur) return res.status(404).json({ error: 'Event niet gevonden' });
      const newStarts = patch.starts_at !== undefined ? patch.starts_at : cur.starts_at;
      const newEnds   = patch.ends_at   !== undefined ? patch.ends_at   : cur.ends_at;
      if (newEnds && new Date(newEnds) <= new Date(newStarts)) {
        return res.status(400).json({ error: 'ends_at moet na starts_at liggen' });
      }
    }

    // Niveau-validatie als ge-update naar niet-null waarde.
    if (patch.niveau) {
      const { data: niveauRow, error: niveauErr } = await supabaseAdmin
        .from('event_niveau_options')
        .select('slug, is_active')
        .eq('slug', patch.niveau)
        .maybeSingle();
      if (niveauErr) {
        console.error('[events-update niveau-lookup]', niveauErr.message);
        return res.status(500).json({ error: 'niveau-validatie faalde' });
      }
      if (!niveauRow || !niveauRow.is_active) {
        return res.status(400).json({ error: `niveau '${patch.niveau}' bestaat niet of is inactief` });
      }
    }

    const { data: ev, error } = await supabaseAdmin
      .from('events')
      .update(patch)
      .eq('id', id)
      .select(`
        id, title, starts_at, ends_at, location, capacity, status, niveau,
        description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
        ghl_sync_status, ghl_last_synced_at,
        created_by_user_id, created_at, updated_at
      `)
      .maybeSingle();
    if (error) throw new Error('events-update: ' + error.message);
    if (!ev)   return res.status(404).json({ error: 'Event niet gevonden' });

    // F2: outbound sync. Twee paden afhankelijk van resultierende status:
    //   - published        -> syncEventToOutbound (create/update item + GHL options)
    //   - cancelled        -> unpublishEventOutbound (Webflow draft + GHL options refresh)
    //   - draft / archived -> geen sync (caller wil expliciet uit live-pool).
    // Beide calls AWAITED; orchestrator isoleert webflow vs ghl intern.
    let sync = null;
    try {
      if (ev.status === 'published') {
        sync = await syncEventToOutbound(ev.id);
      } else if (ev.status === 'cancelled') {
        sync = await unpublishEventOutbound(ev.id);
      }
    } catch (syncErr) {
      console.error('[events-update sync]', syncErr?.message || syncErr);
      sync = { error: syncErr?.message || 'sync exception' };
    }

    // Refetch om bijgewerkte sync-metadata terug te geven.
    let evAfter = ev;
    if (sync) {
      try {
        const { data: refetched } = await supabaseAdmin
          .from('events')
          .select(`
            id, title, starts_at, ends_at, location, capacity, status, niveau,
            description_md, webflow_item_id, webflow_sync_status, webflow_last_synced_at,
            ghl_sync_status, ghl_last_synced_at,
            created_by_user_id, created_at, updated_at
          `)
          .eq('id', ev.id)
          .maybeSingle();
        if (refetched) evAfter = refetched;
      } catch {}
    }

    return res.status(200).json({ event: evAfter, sync });
  } catch (e) {
    console.error('[events-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
