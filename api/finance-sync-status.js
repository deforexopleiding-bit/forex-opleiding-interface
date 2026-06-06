// api/finance-sync-status.js
// GET → sync_state-rijen voor de Finance-UI banner. Permission: finance.invoice.view
// (read-only metadata, geen TL-calls).
//
// Response:
//   { invoices: { last_updated_since, last_run_at, last_run_processed,
//                 last_run_errors, last_run_duration_ms, updated_at },
//     creditnotes: { ...zelfde shape... } }
//
// Bij ontbrekende sync_state-rijen: returnt { invoices: null, creditnotes: null }
// (UI valt dan terug op "—"; geen 500 zodat de Facturen-tab altijd opent).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('sync_state')
      .select('resource, last_updated_since, last_run_at, last_run_processed, last_run_errors, last_run_duration_ms, updated_at')
      .in('resource', ['invoices', 'creditnotes']);
    if (error) throw new Error(error.message);

    const out = { invoices: null, creditnotes: null };
    for (const row of (data || [])) {
      if (row.resource === 'invoices') out.invoices = row;
      if (row.resource === 'creditnotes') out.creditnotes = row;
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error('[finance-sync-status]', e.message);
    // Graceful degradation: UI verwacht 200 met null-shape.
    return res.status(200).json({ invoices: null, creditnotes: null, error: e.message });
  }
}
