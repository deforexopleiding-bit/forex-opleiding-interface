// api/leadsonderhoud-quiz-versies.js
// GET ?slug=<slug> -> de gepubliceerde versies van een vragenlijst (voor de
// versiegeschiedenis + rollback). Alleen lezen. Gate: leads.view.
//
// Response: { items:[{ versie, op, actueel, vragen }] }  (nieuwste eerst)

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
    const { data, error } = await supabaseAdmin
      .from('website_quiz_publicaties')
      .select('versie, gepubliceerd_op, is_actueel, inhoud')
      .eq('slug', slug)
      .order('versie', { ascending: false });
    if (error) throw error;

    const items = (data || []).map((p) => ({
      versie: p.versie,
      op: p.gepubliceerd_op,
      actueel: !!p.is_actueel,
      vragen: Array.isArray(p.inhoud) ? p.inhoud.length : 0,
    }));
    return res.status(200).json({ items });
  } catch (e) {
    console.error('leadsonderhoud-quiz-versies mislukt:', e.message);
    return res.status(500).json({ error: 'Versies laden mislukt', detail: e.message });
  }
}
