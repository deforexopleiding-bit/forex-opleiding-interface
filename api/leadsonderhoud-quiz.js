// api/leadsonderhoud-quiz.js
// GET ?slug=<slug> -> de WERK-versie van één vragenlijst, om te bewerken.
// Alleen lezen. Gate: leads.view.
//
// Response: { quiz:{ id, slug, naam, drempel, is_active },
//             vragen:[{ id, order_index, label, options, active }],
//             live:{ versie, op } | null }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SLUG_RE = /^[a-z0-9-]{1,64}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const slug = String(req.query.slug || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug ontbreekt of ongeldig' });

  try {
    const { data: quiz, error: qErr } = await supabaseAdmin
      .from('website_quizzes').select('id, slug, naam, drempel, is_active')
      .eq('slug', slug).maybeSingle();
    if (qErr) throw qErr;
    if (!quiz) return res.status(404).json({ error: 'Vragenlijst niet gevonden' });

    const { data: vragen, error: vErr } = await supabaseAdmin
      .from('website_quiz_questions')
      .select('id, order_index, label, options, active')
      .eq('quiz_id', quiz.id)
      .order('order_index', { ascending: true });
    if (vErr) throw vErr;

    // Live-info fail-soft (publicatie-tabel mogelijk nog niet in de cache).
    let live = null;
    const { data: pub } = await supabaseAdmin
      .from('website_quiz_publicaties')
      .select('versie, gepubliceerd_op').eq('slug', slug).eq('is_actueel', true).maybeSingle();
    if (pub) live = { versie: pub.versie, op: pub.gepubliceerd_op };

    return res.status(200).json({ quiz, vragen: vragen || [], live });
  } catch (e) {
    console.error('leadsonderhoud-quiz mislukt:', e.message);
    return res.status(500).json({ error: 'Vragenlijst laden mislukt' });
  }
}
