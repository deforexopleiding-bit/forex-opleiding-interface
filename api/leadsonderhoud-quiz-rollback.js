// api/leadsonderhoud-quiz-rollback.js
// POST { slug, versie } -> maak een eerder gepubliceerde versie weer actueel
// (live). De snapshots blijven bewaard; dit verplaatst alleen de is_actueel-vlag.
// De werk-versie blijft ongemoeid. Gate: leads.view. Service role bypasst RLS.
//
// Response: 200 { ok:true, versie }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const body = req.body || {};
  const slug = String(body.slug || '');
  const versie = Number(body.versie);
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug ontbreekt of ongeldig' });
  if (!Number.isInteger(versie) || versie < 1) return res.status(400).json({ error: 'versie ontbreekt of ongeldig' });

  try {
    // Bestaat de doelversie?
    const { data: doel, error: dErr } = await supabaseAdmin
      .from('website_quiz_publicaties').select('id, is_actueel')
      .eq('slug', slug).eq('versie', versie).maybeSingle();
    if (dErr) throw dErr;
    if (!doel) return res.status(404).json({ error: 'Die versie bestaat niet' });
    if (doel.is_actueel) return res.status(200).json({ ok: true, versie }); // al live

    // Huidige live uit, doelversie aan (unieke index: max één actueel per slug).
    const { error: unsetErr } = await supabaseAdmin
      .from('website_quiz_publicaties').update({ is_actueel: false })
      .eq('slug', slug).eq('is_actueel', true);
    if (unsetErr) throw unsetErr;

    const { error: setErr } = await supabaseAdmin
      .from('website_quiz_publicaties').update({ is_actueel: true })
      .eq('slug', slug).eq('versie', versie);
    if (setErr) throw setErr;

    return res.status(200).json({ ok: true, versie });
  } catch (e) {
    console.error('leadsonderhoud-quiz-rollback mislukt:', e.message);
    return res.status(500).json({ error: 'Rollback mislukt', detail: e.message });
  }
}
