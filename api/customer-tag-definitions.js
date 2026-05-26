// GET /api/customer-tag-definitions
// Levert de tag-catalogus voor filter-dropdowns (klant-overzicht) en
// tag-toekenning-UI (komt 2A.4). Geen pagination, geen filter — max ~50 tags.
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate). Granulaire customer.view-check
// volgt zodra role_permissions repo-wide wordt geactiveerd.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('customer_tag_definitions')
      .select('slug, label, color, description, is_system, display_order')
      .order('display_order', { ascending: true })
      .order('label', { ascending: true });

    if (error) {
      console.error('[customer-tag-definitions] db error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ tags: data || [] });
  } catch (err) {
    console.error('[customer-tag-definitions] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}
