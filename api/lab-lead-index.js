// api/lab-lead-index.js
//
// GET /api/lab-lead-index → { leads: { <lead_id>: { hook } }, emails: { <email>: { hook } } }
// Welke leads ooit via The Lab binnenkwamen, met de hook van hun eerste
// aanmelding. Voor de badge "The Lab · H03" in Contacten en bij de
// kennismakingsgesprekken. Alleen CRM-data, dus goedkoop. RBAC: leads.view.
// Sinds 26 okt 2026 staan ook trials van andere beloftes (minicursus, …) in
// lab_aanmeldingen; die horen NIET bij de badge "The Lab" (product ≠ the-lab).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { herkomstVanAanmelding } from './_lib/trial-product.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const { data, error } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('*').order('aangemaakt', { ascending: true }).limit(20000);
  if (error) {
    if (error.code === '42P01' || error.code === 'PGRST205') return res.status(200).json({ ok: true, leads: {}, emails: {} });
    console.error('[lab-lead-index]', error.message);
    return res.status(500).json({ error: 'Lab-index ophalen mislukt' });
  }
  const leads = {}; const emails = {};
  for (const r of data || []) {
    if (herkomstVanAanmelding(r).product !== 'the-lab') continue;
    if (r.lead_id && !leads[r.lead_id]) leads[r.lead_id] = { hook: r.hook || null };
    const em = String(r.email || '').toLowerCase();
    if (em && !emails[em]) emails[em] = { hook: r.hook || null };
  }
  return res.status(200).json({ ok: true, leads, emails });
}
