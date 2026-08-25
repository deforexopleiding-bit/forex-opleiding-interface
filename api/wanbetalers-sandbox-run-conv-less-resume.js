// POST /api/wanbetalers-sandbox-run-conv-less-resume
//
// Thin wrapper voor de cockpit: roept runConvLessResume({scope:'test'}) aan.
// Na PR #1361 heeft die handler:
//   - enabled-flag bypass bij scope='test'
//   - pre-fetch customers!inner(is_test=true) (r113-114)
//   - fatale tripwire bij een lek (throw vóór enige write)
//
// Super_admin-only. Geen writes vanuit deze wrapper zelf.

import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { runConvLessResume } from './_lib/conv-less-resume.js';

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
    const summary = await runConvLessResume({ scope: 'test' });
    return res.status(200).json({ ok: true, summary });
  } catch (e) {
    console.error('[sandbox-run-conv-less-resume]', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
}
