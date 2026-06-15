// api/events-niveau-default-image-save.js
// POST -> zet of wist de niveau-standaardfoto (event_niveau_options.default_image_url).
// Fallback die de assessment-picker toont als een event geen eigen foto heeft.
// RBAC: sessie-JWT + events.event.edit.
// Body: { slug: string, default_image_url: string|null }
// Response 200 { ok, slug, default_image_url } | 400/401/403/404/500

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'events.event.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (events.event.edit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });
  const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
  if (!slug) return res.status(400).json({ error: 'slug vereist' });

  let url = null;
  if (body.default_image_url != null && String(body.default_image_url).trim() !== '') {
    url = String(body.default_image_url).trim();
    if (!/^https?:\/\//i.test(url) || url.length > 1000) {
      return res.status(400).json({ error: 'default_image_url moet een geldige http(s)-URL zijn (max 1000 tekens)' });
    }
  }

  const { data: niv, error: nivErr } = await supabaseAdmin
    .from('event_niveau_options').select('slug').eq('slug', slug).maybeSingle();
  if (nivErr) { console.error('[events-niveau-default-image-save] lookup', nivErr.message); return res.status(500).json({ error: 'lookup faalde' }); }
  if (!niv) return res.status(404).json({ error: `niveau '${slug}' bestaat niet` });

  const { error: updErr } = await supabaseAdmin
    .from('event_niveau_options').update({ default_image_url: url }).eq('slug', slug);
  if (updErr) { console.error('[events-niveau-default-image-save] update', updErr.message); return res.status(500).json({ error: 'opslaan faalde' }); }

  return res.status(200).json({ ok: true, slug, default_image_url: url });
}
