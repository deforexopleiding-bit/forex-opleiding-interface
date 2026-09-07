// api/booking-sources-delete.js
//
// POST { id }  (of { slug } als fallback)
//
// Verwijdert één bron-rij uit public.booking_sources. Alleen de CONFIG-rij
// (link + vragenlijst-instelling + setter-koppeling) verdwijnt.
//
// BELANGRIJK — historische boekingen blijven bestaan: follow_up_appointments.
// booking_source (en leads) bewaren de slug als losse TEXT-waarde, niet als
// foreign key naar booking_sources. Een verwijderde bron valt dus in de
// Bronnen-tab terug op een "(onbekend) <slug>"-rij zolang er nog calls op staan
// — de boekingen/attributie zelf gaan NIET verloren.
//
// Response:
//   200 { ok:true }
//   400 { error }        — validatie (id/slug ontbreekt of ongeldig)
//   401/403 { error }    — auth/rechten
//   404 { error }        — bron niet gevonden
//
// Auth: leads.update (identiek aan booking-sources-upsert). Write via
// supabaseAdmin (service-role); RBAC-gate hier is de bewaking.

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
  const id   = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : null;
  const slug = String(body.slug || '').trim().toLowerCase();

  // Delete op id (primair) of slug (fallback). Minstens één geldig.
  let q = supabaseAdmin.from('booking_sources').delete();
  if (id) {
    if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id ongeldig (verwacht UUID)' });
    q = q.eq('id', id);
  } else if (slug) {
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug ongeldig' });
    q = q.eq('slug', slug);
  } else {
    return res.status(400).json({ error: 'id of slug vereist' });
  }

  try {
    const { data, error } = await q.select('id');
    if (error) throw error;
    if (!data || data.length === 0) return res.status(404).json({ error: 'Bron niet gevonden' });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[booking-sources-delete]', e?.message || e);
    return res.status(500).json({ error: 'Verwijderen mislukt' });
  }
}
