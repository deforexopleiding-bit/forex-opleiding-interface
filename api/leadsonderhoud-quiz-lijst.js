// api/leadsonderhoud-quiz-lijst.js
// GET -> de vragenlijsten (werk-versie) + hun live (gepubliceerde) status.
// Alleen lezen. Gate: leads.view.
//
// Response: { items: [{ id, slug, naam, drempel, is_active,
//             vragen_totaal, vragen_actief, live_versie, live_op }] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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

  try {
    const { data: quizzes, error } = await supabaseAdmin
      .from('website_quizzes').select('id, slug, naam, drempel, is_active').order('slug');
    if (error) throw error;

    // Vraagtellingen (werk-versie).
    const { data: vragen } = await supabaseAdmin
      .from('website_quiz_questions').select('quiz_id, active').limit(10000);
    const tel = {};
    for (const v of vragen || []) {
      if (!tel[v.quiz_id]) tel[v.quiz_id] = { t: 0, a: 0 };
      tel[v.quiz_id].t++; if (v.active) tel[v.quiz_id].a++;
    }

    // Live (gepubliceerde) versie per slug. Fail-soft: als de publicatie-tabel
    // (nog) niet in de PostgREST-cache zit, tonen we gewoon geen live-info.
    const liveBySlug = new Map();
    const { data: pubs } = await supabaseAdmin
      .from('website_quiz_publicaties')
      .select('slug, versie, gepubliceerd_op').eq('is_actueel', true);
    for (const p of pubs || []) liveBySlug.set(p.slug, p);

    const items = (quizzes || []).map((q) => ({
      id: q.id, slug: q.slug, naam: q.naam, drempel: q.drempel, is_active: q.is_active,
      vragen_totaal: tel[q.id]?.t || 0,
      vragen_actief: tel[q.id]?.a || 0,
      live_versie: liveBySlug.get(q.slug)?.versie ?? null,
      live_op: liveBySlug.get(q.slug)?.gepubliceerd_op ?? null,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    console.error('leadsonderhoud-quiz-lijst mislukt:', e.message);
    return res.status(500).json({ error: 'Vragenlijsten laden mislukt' });
  }
}
