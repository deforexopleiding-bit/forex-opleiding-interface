// api/finance-expenses-categories.js
// GET → lijst van 12 seed-categorieën (expense_categories).
// Permission: finance.expenses.view.
//
// Response:
//   { categories: [{ id, slug, label, color, is_active, is_internal }] }
//
// is_internal=true → categorie voor interne overboekingen (bv. ING→PayPal).
// Default UIT gefilterd in de uitgaven-analyse.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.expenses.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.expenses.view)' });
  }

  const { data, error } = await supabaseAdmin
    .from('expense_categories')
    .select('id, slug, label, color, is_active, is_internal, is_credit')
    .eq('is_active', true)
    .order('label', { ascending: true });

  if (error) {
    console.error('[finance-expenses-categories]', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ categories: data || [] });
}
