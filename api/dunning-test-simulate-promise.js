// POST /api/dunning-test-simulate-promise
//
// Insert een MANUAL_CONFIRM_PROMISE-taak op EXACT de shape die
// promise-maturity.js leest, zodat een cockpit-trigger van
// promise-maturity 'em daarna echt kan laten rijpen.
//
// Body: { customer_id: uuid, days_ago?: number, conversation_id?: uuid|null }
//   - days_ago default 4 → promised_date_hint = vandaag − 4 dagen
//     (in het verleden zodat maturity direct rijpt bij grace_days=1).
//   - Negatieve days_ago = toekomst → simuleert een NOG-NIET-RIJPE belofte
//     (voor de "wacht"-tak van de handler).
//
// Super_admin-only. Weigert non-is_test-klant (400).
// Geen outbound send.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

function ymdShiftDays(baseDate, deltaDays) {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

async function audit({ actor, target, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'simulate_promise',
      scope:        'test',
      target: target || {},
      payload: payload || {},
      result:  result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-simulate-promise] audit fail:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;
  const actor = { userId: admin.user.id, email: admin.profile.email };

  const body = req.body || {};
  const customerId = body.customer_id;
  const daysAgo    = Number.isFinite(Number(body.days_ago)) ? Number(body.days_ago) : 4;
  const convId     = body.conversation_id || null;

  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // is_test-guard.
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers')
    .select('id, is_test, first_name, last_name')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!cust) return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!cust.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant. Weigering.' });

  // Bouw payload EXACT in de shape die promise-maturity.js leest:
  //   payload.promised_date_hint (r118)  ← YYYY-MM-DD; in verleden = rijpt.
  //   payload.conversation_id (r137)      ← optioneel.
  //   payload.history[] (r171)             ← voor repeat-detectie.
  // + minimum bag die productie-code ook zet (title/description/assignee_role).
  const nowIso   = new Date().toISOString();
  const hint     = ymdShiftDays(new Date(), -Math.abs(daysAgo));
  const isFuture = daysAgo < 0;
  const payload = {
    title:              'Testbelofte (cockpit)',
    description:        `Simulate-promise via test-cockpit — ${isFuture ? 'nog in de toekomst (wacht-tak)' : 'in het verleden (direct rijp)'}`,
    assignee_role:      'manager',
    kind:               'promise',
    source:             'cockpit',                // ← NIET 'joost' (voorkomt idempotency-collision met productie-joost-flow)
    conversation_id:    convId,
    promised_date_raw:  `over ${Math.abs(daysAgo)} dagen`,
    promised_date_hint: hint,
    klantcitaat:        'Simulate — geen echte klant-reactie',
    created_via:        'cockpit',
    history: [{
      at: nowIso, source: 'cockpit',
      raw: `over ${Math.abs(daysAgo)} dagen`, hint,
      klantcitaat: 'Simulate — geen echte klant-reactie',
    }],
  };

  const insertRow = {
    customer_id:         customerId,
    arrangement_id:      null,
    invoice_id:          null,
    action_type:         'MANUAL_CONFIRM_PROMISE',
    status:              'PENDING',
    proposed_by_user_id: null,
    payload,
  };

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from('pending_actions')
    .insert(insertRow)
    .select('id, created_at')
    .maybeSingle();

  if (insErr) {
    await audit({ actor, target: { customer_id: customerId }, payload: { days_ago: daysAgo }, status: 'error', error: insErr.message });
    return res.status(500).json({ error: insErr.message });
  }

  await audit({
    actor,
    target: { customer_id: customerId, task_id: inserted?.id },
    payload: { days_ago: daysAgo, hint, conversation_id: convId },
    result: { task_id: inserted?.id },
    status: 'ok',
  });

  return res.status(201).json({
    ok: true,
    task_id: inserted?.id,
    promised_date_hint: hint,
    days_ago: daysAgo,
    will_ripen_immediately: !isFuture,
    message: `Testbelofte aangemaakt. ${isFuture ? 'Nog niet rijp (hint in toekomst) — promise-maturity zal skippen.' : 'Direct rijp — promise-maturity trigger nu om te rijpen.'}`,
  });
}
