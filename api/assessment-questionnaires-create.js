// api/assessment-questionnaires-create.js
//
// FEATURE C — POST: nieuwe assessment-vragenlijst aanmaken.
// Body: { slug: string, name: string }
//
// Permission: admin.joost_config.
//
// Slug:  /^[a-z0-9_-]{1,64}$/ — globaal uniek (UNIQUE-constraint op DB).
// Name:  1..200 chars na trim.
// Drempels: niet door client gezet — defaults via DB (7 / 5 / 4). Update via
//           assessment-questionnaires-update als business 't wil afwijken.
// is_active: NIET door deze endpoint gezet — gebruik -activate (exclusief
//            in transactie) zodat de "exact 1 actief"-invariant veilig blijft.
//
// Response 201: { item }
// Response 400: validatie-fout (zie code).
// Response 409: slug bestaat al.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { isValidSlug } from './_lib/assessment-questionnaires.js';

const MAX_NAME = 200;

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
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!isValidSlug(slug)) {
    return res.status(400).json({ error: 'slug ongeldig (lowercase a-z0-9_- en max 64 chars)' });
  }
  if (!name || name.length > MAX_NAME) {
    return res.status(400).json({ error: `name vereist; max ${MAX_NAME} chars` });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_questionnaires')
      .insert({
        slug,
        name,
        // is_active blijft default false → -activate doet de switch.
      })
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold, created_at, updated_at')
      .maybeSingle();
    if (error) {
      if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
        return res.status(409).json({ error: `slug '${slug}' bestaat al`, code: 'SLUG_EXISTS' });
      }
      throw new Error(error.message);
    }
    if (!data) throw new Error('insert returnde geen rij');
    return res.status(201).json({ item: data });
  } catch (e) {
    console.error('[assessment-questionnaires-create]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
