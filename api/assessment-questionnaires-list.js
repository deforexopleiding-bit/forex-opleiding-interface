// api/assessment-questionnaires-list.js
//
// FEATURE C — GET-overzicht van alle assessment-vragenlijsten.
// Geeft id, slug, name, is_active + drempels + counts terug zodat de admin-UI
// de tab "Vragenlijst" kan vullen (selector + Puntensysteem sub-tab).
//
// Permission: admin.joost_config (hergebruikt patroon van
// admin-assessment-questions-list — semantisch een AI/scoring-config).
//
// Response 200: { items: [{ id, slug, name, is_active, gevorderd_threshold,
//                            motivatie_floor, low_mid_threshold, created_at,
//                            updated_at, question_count }] }
// Response 401/403/405/500: zie code.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  try {
    const { data: rows, error } = await supabaseAdmin
      .from('assessment_questionnaires')
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold, created_at, updated_at')
      .order('is_active', { ascending: false })
      .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);

    // Counts per vragenlijst (alle vragen, niet alleen actief — admin wil
    // weten hoeveel vragen er totaal zitten). Eén round-trip per rij is
    // acceptabel op deze schaal (< 10 vragenlijsten verwacht).
    const items = [];
    for (const row of (rows || [])) {
      const { count, error: cntErr } = await supabaseAdmin
        .from('assessment_questions')
        .select('id', { count: 'exact', head: true })
        .eq('questionnaire_id', row.id);
      items.push({
        ...row,
        question_count: cntErr ? null : (count ?? 0),
      });
    }

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[assessment-questionnaires-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
