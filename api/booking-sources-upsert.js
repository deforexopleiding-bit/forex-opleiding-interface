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

  if (id !== null && !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id ongeldig (verwacht UUID)' });
  }
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ error: 'slug moet lowercase alfanumeriek + hyphen zijn (max 64 tekens)' });
  }
  if (label.length < 1 || label.length > 120) {
    return res.status(400).json({ error: 'label vereist (1-120 tekens)' });
  }

  try {
    if (id) {
      // UPDATE — id primair. Slug mag wisselen (met UNIQUE-check).
      const { data, error } = await supabaseAdmin
        .from('booking_sources')
        .update({ slug, label, actief })
        .eq('id', id)
        .select('id, slug, label, actief')
        .maybeSingle();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: `Slug '${slug}' bestaat al` });
        throw error;
      }
      if (!data) return res.status(404).json({ error: 'Bron niet gevonden' });
      return res.status(200).json({ ok: true, item: data });
    }

    // INSERT — slug UNIQUE-check.
    const { data, error } = await supabaseAdmin
      .from('booking_sources')
      .insert({ slug, label, actief })
      .select('id, slug, label, actief')
      .maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: `Slug '${slug}' bestaat al` });
      throw error;
    }
    return res.status(200).json({ ok: true, item: data });
  } catch (e) {
    console.error('[booking-sources-upsert]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
