// api/leadsonderhoud-quiz-publiceren.js
// POST { slug } -> serialiseer de huidige WERK-versie naar een nieuwe
// gepubliceerde snapshot (website_quiz_publicaties) en maak die actueel (live).
// Gate: leads.view. De service role bypasst RLS.
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

  const slug = String((req.body || {}).slug || '');
  if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug ontbreekt of ongeldig' });

  try {
    const { data: quiz, error: qErr } = await supabaseAdmin
      .from('website_quizzes').select('id, naam, drempel').eq('slug', slug).maybeSingle();
    if (qErr) throw qErr;
    if (!quiz) return res.status(404).json({ error: 'Vragenlijst niet gevonden' });

    // Alleen actieve vragen komen live; serialiseren in dezelfde vorm die de
    // website leest ([{ id, order_index, label, options }]).
    const { data: vragen, error: vErr } = await supabaseAdmin
      .from('website_quiz_questions')
      .select('id, order_index, label, options')
      .eq('quiz_id', quiz.id).eq('active', true)
      .order('order_index', { ascending: true });
    if (vErr) throw vErr;
    const inhoud = (vragen || []).map((v) => ({
      id: v.id, order_index: v.order_index, label: v.label, options: v.options,
    }));

    // Volgend versienummer voor deze slug.
    const { data: laatste, error: lErr } = await supabaseAdmin
      .from('website_quiz_publicaties').select('versie')
      .eq('slug', slug).order('versie', { ascending: false }).limit(1).maybeSingle();
    if (lErr) throw lErr;
    const versie = (laatste?.versie || 0) + 1;

    // Eerst de huidige live-versie uit-zetten (partial unique index: max één
    // is_actueel per slug), dan de nieuwe als actueel invoegen.
    const { error: unsetErr } = await supabaseAdmin
      .from('website_quiz_publicaties').update({ is_actueel: false })
      .eq('slug', slug).eq('is_actueel', true);
    if (unsetErr) throw unsetErr;

    const { error: insErr } = await supabaseAdmin
      .from('website_quiz_publicaties').insert({
        slug, versie, naam: quiz.naam, drempel: quiz.drempel,
        inhoud, is_actueel: true, gepubliceerd_door: user.id,
      });
    if (insErr) throw insErr;

    return res.status(200).json({ ok: true, versie });
  } catch (e) {
    console.error('leadsonderhoud-quiz-publiceren mislukt:', e.message);
    return res.status(500).json({ error: 'Publiceren mislukt', detail: e.message });
  }
}
