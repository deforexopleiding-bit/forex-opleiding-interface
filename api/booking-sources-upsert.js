// api/booking-sources-upsert.js
//
// POST { id?, slug, label, actief }
//
// Toevoegen (id ontbreekt) of bewerken (id aanwezig) van een bron in
// public.booking_sources. Slug is UNIQUE en case-locked lowercase +
// alfanumeriek/hyphen (max 64 chars). Label is vrije tekst (1-120).
//
// Response:
//   200 { ok:true, item:{ id,slug,label,actief } }
//   400 { error }        — validatie
//   403 { error }        — geen rechten
//   409 { error }        — slug bestaat al (bij create) / conflict
//
// Auth: leads.update (spiegelt Vragenlijst-tab publiceer-rechten). Write
// gaat via supabaseAdmin (service-role); RBAC-gate hier is de bewaking.
// Deactiveren = zet actief=false; hard delete niet ondersteund
// (behoud van historische link → altijd telbaar in Bronnen-tab).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const id    = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
  const slug  = String(body.slug  || '').trim().toLowerCase();
  const label = String(body.label || '').trim();
  const actief = body.actief === false ? false : true;
  // BP2 Deel A: owner_user_id koppelt setter aan slug. Body kan de key
  // weglaten (backward-compat) of expliciet 'null'/'' sturen om te ontkoppelen.
  const ownerRaw = body.owner_user_id;
  let ownerUserId = null; // default: geen setter
  let ownerProvided = false;
  if (ownerRaw !== undefined) {
    ownerProvided = true;
    if (ownerRaw === null || ownerRaw === '') {
      ownerUserId = null;
    } else if (typeof ownerRaw === 'string' && UUID_RE.test(ownerRaw.trim())) {
      ownerUserId = ownerRaw.trim();
    } else {
      return res.status(400).json({ error: 'owner_user_id ongeldig (verwacht UUID, null of leeg)' });
    }
  }

  if (id !== null && !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id ongeldig (verwacht UUID)' });
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'slug moet lowercase alfanumeriek + hyphen zijn (max 64 tekens)' });
  }
  if (label.length < 1 || label.length > 120) {
    return res.status(400).json({ error: 'label vereist (1-120 tekens)' });
  }

  // Bouw patch alleen met velden die de caller expliciet meestuurt zodat
  // een UI die alleen owner_user_id wil bijwerken de rest niet aanraakt.
  const buildPatch = () => {
    const p = { slug, label, actief };
    if (ownerProvided) p.owner_user_id = ownerUserId;
    return p;
  };

  try {
    if (id) {
      // UPDATE — id primair. Slug mag wisselen (met UNIQUE-check).
      const { data, error } = await supabaseAdmin
        .from('booking_sources')
        .update(buildPatch())
        .eq('id', id)
        .select('id, slug, label, actief, owner_user_id')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: `Slug '${slug}' bestaat al` });
        // 42703 fail-soft: owner_user_id-kolom bestaat nog niet (pre-BP2-migratie).
        if (error.code === '42703' && String(error.message || '').toLowerCase().includes('owner_user_id')) {
          const { data: d2, error: e2 } = await supabaseAdmin
            .from('booking_sources')
            .update({ slug, label, actief })
            .eq('id', id)
            .select('id, slug, label, actief')
            .maybeSingle();
          if (e2) throw e2;
          if (!d2) return res.status(404).json({ error: 'Bron niet gevonden' });
          return res.status(200).json({ ok: true, item: d2 });
        }
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Bron niet gevonden' });
      return res.status(200).json({ ok: true, item: data });
    }

    // INSERT — slug UNIQUE-check.
    const { data, error } = await supabaseAdmin
      .from('booking_sources')
      .insert(buildPatch())
      .select('id, slug, label, actief, owner_user_id')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `Slug '${slug}' bestaat al` });
      // 42703 fail-soft: pre-BP2 schema zonder owner_user_id.
      if (error.code === '42703' && String(error.message || '').toLowerCase().includes('owner_user_id')) {
        const { data: d2, error: e2 } = await supabaseAdmin
          .from('booking_sources')
          .insert({ slug, label, actief })
          .select('id, slug, label, actief')
          .maybeSingle();
        if (e2) throw e2;
        return res.status(200).json({ ok: true, item: d2 });
      }
      throw error;
    }
    return res.status(200).json({ ok: true, item: data });
  } catch (e) {
    console.error('[booking-sources-upsert]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
