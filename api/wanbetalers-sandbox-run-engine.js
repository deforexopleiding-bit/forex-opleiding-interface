// api/wanbetalers-sandbox-run-engine.js
// POST → draait de bestaande dunning-engine, maar gescoped op is_test=true
// (customers + invoices). Assertie: elke aangeraakte klant moet is_test=true
// zijn; anders abort direct. Respecteert dry-run (via de bestaande guard in
// executeEmailStep). Super_admin only.

import { runEngine } from './_lib/dunning-engine.js';
import { requireSuperAdmin, getSandboxCustomer } from './_lib/wanbetalers-sandbox.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  try {
    const customer = await getSandboxCustomer();
    if (!customer) return res.status(400).json({ error: 'Geen test-persoon gevonden — seed eerst.' });
    const dry = await isDryRunEnabled();
    const result = await runEngine({ mode: 'sandbox', scope: 'test' });
    return res.status(200).json({ ok: true, dry_run: dry, engine_result: result });
  } catch (e) {
    console.error('[sandbox-run-engine]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
