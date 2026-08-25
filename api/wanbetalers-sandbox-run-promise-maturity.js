// POST /api/wanbetalers-sandbox-run-promise-maturity
//
// Thin wrapper voor de cockpit: roept runPromiseMaturity({scope:'test'})
// aan. Na PR #1361 heeft die handler:
//   - enabled-flag bypass bij scope='test' (productie kan disabled blijven)
//   - pre-fetch is_test=true filter (customers!inner join)
//   - post-fetch is_test-check (r141-142)
//   - fatale tripwire bij een lek (throw vóór enige write)
//
// Super_admin-only. Geen writes vanuit deze wrapper zelf.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { runPromiseMaturity } from './_lib/promise-maturity.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    const summary = await runPromiseMaturity({ scope: 'test' });
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error('[sandbox-run-promise-maturity]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
