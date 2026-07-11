// api/incasso-refusal-flag.js
// POST { customer_id, flagged: boolean } → schrijft dunning_log-marker:
//   flagged=true  → 'payment_refusal_flagged'
//   flagged=false → 'payment_refusal_cleared'
// Read door de auto-evaluatie (laatste marker per klant). Permission:
// finance.incasso.manage.
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  const flagged = body.flagged === true;
  const eventType = flagged ? 'payment_refusal_flagged' : 'payment_refusal_cleared';
  try {
    const { error } = await supabaseAdmin.from('dunning_log').insert({
      run_id     : null,
      step_id    : null,
      event_type : eventType,
      payload    : { customer_id: customerId, by_user_id: user.id },
    });
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, customer_id: customerId, marker: eventType });
  } catch (e) {
    console.error('[incasso-refusal-flag]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
