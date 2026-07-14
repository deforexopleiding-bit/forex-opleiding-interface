// api/dunning-call-log-create.js
// POST { customer_id, invoice_id?, sip_line?, outcome, note? } → insert
// een belpoging in dunning_call_log. Wordt aangeroepen na de "Bel nu"-flow
// in het case-paneel (finance.html #caseSheet Bellen-kaart).
//
// Uitkomsten (must match CHECK-constraint in migratie):
//   no_answer / voicemail / callback / payment_promise / payment_plan /
//   refused / wrong_number / paid_during_call
//
// Permissie: finance.dunning.execute (zelfde als de andere dunning-writes).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_OUTCOMES = new Set([
  'no_answer','voicemail','callback','payment_promise','payment_plan',
  'refused','wrong_number','paid_during_call',
]);
const VALID_LINES = new Set(['nl','be']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const invoiceId  = typeof body.invoice_id  === 'string' && UUID_RE.test(body.invoice_id)  ? body.invoice_id  : null;
  const sipLine    = typeof body.sip_line    === 'string' && VALID_LINES.has(body.sip_line) ? body.sip_line    : null;
  const outcome    = typeof body.outcome     === 'string' && VALID_OUTCOMES.has(body.outcome) ? body.outcome    : null;
  const note       = typeof body.note        === 'string' ? body.note.trim().slice(0, 2000) : null;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (!outcome)    return res.status(400).json({ error: `outcome verplicht; verwacht ${Array.from(VALID_OUTCOMES).join('|')}` });

  try {
    const { data, error } = await supabaseAdmin
      .from('dunning_call_log')
      .insert({
        customer_id: customerId,
        invoice_id : invoiceId,
        sip_line   : sipLine,
        outcome,
        note       : note || null,
        created_by : user.id,
      })
      .select('id, customer_id, invoice_id, attempted_at, sip_line, outcome, note, created_by, created_at')
      .single();
    if (error) throw new Error(error.message);
    return res.status(200).json({ ok: true, entry: data });
  } catch (e) {
    console.error('[dunning-call-log-create]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
