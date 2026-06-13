// api/admin-assessment-questions-list.js
// GET -> admin-overzicht van ALLE assessment-vragen (inclusief inactive),
// gegroepeerd in client-volgorde op (section, order_index). Levert alle
// config-velden inclusief routing_weights + is_routing zodat de editor-UI
// alles kan tonen.
//
// Permission: admin.joost_config (config-beheer; hergebruikt omdat
// assessment-routing semantisch een AI/scoring-config is, nauwer verwant
// aan Joost-config dan aan b.v. whatsapp_templates).
//
// Response 200: { questions: [{ id, key, section, order_index, type, label,
//                                help_text, required, options, min_words,
//                                is_routing, routing_weights, active,
//                                created_at, updated_at }] }

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
    const { data, error } = await supabaseAdmin
      .from('assessment_questions')
      .select('id, key, section, order_index, type, label, help_text, required, options, min_words, is_routing, routing_weights, active, created_at, updated_at')
      .order('section', { ascending: true })
      .order('order_index', { ascending: true });
    if (error) throw new Error(error.message);
    return res.status(200).json({ questions: data || [] });
  } catch (e) {
    console.error('[admin-assessment-questions-list]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
