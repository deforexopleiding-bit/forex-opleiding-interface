// GET /api/dunning-test-context?customer_id=...
//
// Aggregatie-endpoint voor de cockpit iter 4 (ladder + tijdlijn + berichten
// + takenlijst). Retourneert alle data die de UI voor de actieve is_test-
// customer nodig heeft in één call. Super_admin-only.
//
// Weigert 400 als customer.is_test !== true — mag nooit productie-data
// aggregeren.
//
// Response:
// {
//   customer:          { id, first_name, last_name, email, phone, is_test, created_at } | null,
//   invoices:          [{ id, invoice_number, amount_total, amount_paid, status, due_date, test_metadata }, ...],
//   active_run:        { id, status, step_index, current_step_id, next_action_at, paused_by_*, needs_attention } | null,
//   timeline:          [{ source, ts, ... }, ...]    // audit + dunning_log + wa_messages merged (nieuwste eerst)
//   conversations:     [{ id, phone_number, last_inbound_at, last_message_at, is_test, message_count }, ...],
//   messages:          [{ id, conversation_id, direction, body, created_at, wamid }, ...],  // laatste 50 van actieve conv
//   pending_actions:   [{ id, action_type, status, created_at, due_at, meta }, ...],
// }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

async function safeSelect(promise) {
  try { const r = await promise; return r.data || []; }
  catch (e) { console.warn('[dunning-test-context] safeSelect:', e?.message || e); return []; }
}

function normTs(row, ...keys) {
  for (const k of keys) if (row?.[k]) return row[k];
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const customerId = req.query?.customer_id;
  if (!customerId) return res.status(400).json({ error: 'customer_id is verplicht.' });

  // ── Customer + is_test-guard ────────────────────────────────────────────
  const { data: customer, error: cErr } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, email, phone, is_test, created_at')
    .eq('id', customerId)
    .maybeSingle();
  if (cErr) return res.status(500).json({ error: 'customer lookup: ' + cErr.message });
  if (!customer)         return res.status(404).json({ error: 'Customer niet gevonden.' });
  if (!customer.is_test) return res.status(400).json({ error: 'Customer is geen is_test-klant.' });

  // ── Parallel fetches ────────────────────────────────────────────────────
  const [
    invoices, activeRun, auditRows, logRows, convs, tasks,
  ] = await Promise.all([
    safeSelect(supabaseAdmin.from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, status, due_date, is_test, test_metadata')
      .eq('customer_id', customerId).eq('is_test', true)
      .order('due_date', { ascending: false })),
    supabaseAdmin.from('dunning_workflow_runs')
      .select('id, status, step_index, current_step_id, next_action_at, paused_by_conversation_id, paused_by_arrangement_id, needs_attention, updated_at, created_at')
      .eq('customer_id', customerId)
      .order('updated_at', { ascending: false })
      .limit(1).maybeSingle().then(r => r.data || null).catch(() => null),
    safeSelect(supabaseAdmin.from('test_cockpit_audit')
      .select('id, action, status, admin_email, target, error_message, created_at')
      .contains('target', { customer_id: customerId })
      .order('created_at', { ascending: false }).limit(30)),
    // dunning_log ophalen via run-id (na resolve van active_run).
    Promise.resolve([]),
    safeSelect(supabaseAdmin.from('whatsapp_conversations')
      .select('id, phone_number, last_inbound_at, last_message_at, is_test, message_count')
      .eq('customer_id', customerId)
      .order('last_message_at', { ascending: false })),
    safeSelect(supabaseAdmin.from('pending_actions')
      .select('id, action_type, status, created_at, due_at, meta')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false }).limit(30)),
  ]);

  // dunning_log na active_run bekend.
  let logs = [];
  if (activeRun?.id) {
    logs = await safeSelect(supabaseAdmin.from('dunning_log')
      .select('id, event, payload, created_at')
      .eq('run_id', activeRun.id)
      .order('created_at', { ascending: false }).limit(30));
  }

  // wa_messages: laatste 50 van laatst-actieve conv.
  let messages = [];
  const activeConvId = convs?.[0]?.id || null;
  if (activeConvId) {
    messages = await safeSelect(supabaseAdmin.from('whatsapp_messages')
      .select('id, conversation_id, direction, body, created_at, meta_wamid')
      .eq('conversation_id', activeConvId)
      .order('created_at', { ascending: false }).limit(50));
  }

  // ── Timeline merge ──────────────────────────────────────────────────────
  const timeline = [];
  for (const a of auditRows) {
    timeline.push({ source: 'audit', ts: normTs(a, 'created_at'), id: a.id, action: a.action, status: a.status, admin_email: a.admin_email, error: a.error_message });
  }
  for (const l of logs) {
    timeline.push({ source: 'dunning_log', ts: normTs(l, 'created_at'), id: l.id, event: l.event, payload: l.payload });
  }
  for (const m of messages) {
    timeline.push({ source: 'wa_message', ts: normTs(m, 'created_at'), id: m.id, direction: m.direction, body: (m.body || '').slice(0, 140) });
  }
  timeline.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));

  return res.status(200).json({
    ok: true,
    customer,
    invoices,
    active_run: activeRun,
    timeline: timeline.slice(0, 80),
    conversations: convs,
    messages,
    pending_actions: tasks,
  });
}
