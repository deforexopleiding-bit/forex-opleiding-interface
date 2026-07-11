// api/wanbetalers-sandbox-set-dry-run.js
// POST { enabled: boolean } → toggle dry-run killswitch. Super_admin only.
import { requireSuperAdmin, setDryRun } from './_lib/wanbetalers-sandbox.js';
import { invalidateDryRunCache } from './_lib/dunning-dry-run.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) vereist' });
  try {
    const value = await setDryRun(body.enabled);
    invalidateDryRunCache();
    return res.status(200).json({ ok: true, dry_run: value });
  } catch (e) {
    console.error('[sandbox-set-dry-run]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
