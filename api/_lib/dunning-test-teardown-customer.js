// api/_lib/dunning-test-teardown-customer.js
//
// Customer-scoped teardown van run-state voor een is_test-klant. Wordt
// gebruikt door dunning-test-edit-customer.js zodat een factuur-edit
// verse runs kan draaien zonder desync.
//
// GEEN SQL-migratie nodig — pure JS die de FK-volgorde volgt (idem als
// docs/sql-migrations/2026-08-24-dunning-test-cockpit-reset-fn.sql maar
// dan customer-scoped en zonder facturen (die worden apart geupsert).
//
// HARDE GRENDEL (fail-closed, VOOR elke write):
//   - customer.is_test !== true → throw. Nul writes.
//
// FK-volgorde:
//   1. pending_actions (CASCADE)
//   2. dunning_workflow_runs (CASCADE)
//   3. payment_arrangements (RESTRICT)
//   4. payment_promises (RESTRICT)
//   5. dunning_briefs (RESTRICT)
//   6. dunning_pipeline_customers (best-effort)
//   7. deals + subscriptions (RESTRICT — sandbox-seed maakt regeling-deal)
//   8. dunning_trajectories / letters / avg_data_requests (best-effort)
//   9. whatsapp_messages (via conversation_id)
//  10. whatsapp_conversations (customer-koppeling)
//  11. email_messages (customer-koppeling)
//
// invoices worden NIET gewist — die worden apart geupsert door de caller.

export async function teardownRunStateForCustomer(customerId, { supabaseAdmin }) {
  if (!customerId) throw new Error('[teardown] customerId vereist');
  if (!supabaseAdmin) throw new Error('[teardown] supabaseAdmin vereist');

  // ── Grendel: is_test-guard vóór ALLES ────────────────────────────────
  const { data: cust, error: cErr } = await supabaseAdmin
    .from('customers').select('id, is_test').eq('id', customerId).maybeSingle();
  if (cErr) throw new Error('[teardown] customer lookup: ' + cErr.message);
  if (!cust) throw new Error('[teardown] customer niet gevonden');
  if (cust.is_test !== true) {
    throw new Error(`[teardown] SCOPE=TEST TRIPWIRE — customer ${customerId} is NIET is_test (is_test=${JSON.stringify(cust.is_test)}). Teardown afgebroken vóór enige write.`);
  }

  const counts = {
    pending_actions: 0,
    dunning_workflow_runs: 0,
    payment_arrangements: 0,
    payment_promises: 0,
    dunning_briefs: 0,
    dunning_pipeline_customers: 0,
    deals: 0,
    dunning_trajectories: 0,
    letters: 0,
    avg_data_requests: 0,
    whatsapp_messages: 0,
    whatsapp_conversations: 0,
    email_messages: 0,
  };

  // Verzamel de conversation_ids voor whatsapp_messages-scope.
  const { data: convs } = await supabaseAdmin
    .from('whatsapp_conversations').select('id').eq('customer_id', customerId);
  const convIds = (convs || []).map(c => c.id);

  // 1. pending_actions
  {
    const { data, error } = await supabaseAdmin.from('pending_actions')
      .delete().eq('customer_id', customerId).select('id');
    if (error) throw new Error('[teardown] pending_actions: ' + error.message);
    counts.pending_actions = (data || []).length;
  }
  // 2. dunning_workflow_runs
  {
    const { data, error } = await supabaseAdmin.from('dunning_workflow_runs')
      .delete().eq('customer_id', customerId).select('id');
    if (error) throw new Error('[teardown] dunning_workflow_runs: ' + error.message);
    counts.dunning_workflow_runs = (data || []).length;
  }
  // 3. payment_arrangements
  {
    const { data, error } = await supabaseAdmin.from('payment_arrangements')
      .delete().eq('customer_id', customerId).select('id');
    if (error) throw new Error('[teardown] payment_arrangements: ' + error.message);
    counts.payment_arrangements = (data || []).length;
  }
  // 4. payment_promises (best-effort — tabel kan ontbreken in sommige envs)
  try {
    const { data } = await supabaseAdmin.from('payment_promises')
      .delete().eq('customer_id', customerId).select('id');
    counts.payment_promises = (data || []).length;
  } catch { /* tabel bestaat niet */ }
  // 5. dunning_briefs
  {
    const { data, error } = await supabaseAdmin.from('dunning_briefs')
      .delete().eq('customer_id', customerId).select('id');
    if (error) throw new Error('[teardown] dunning_briefs: ' + error.message);
    counts.dunning_briefs = (data || []).length;
  }
  // 6. dunning_pipeline_customers (best-effort)
  try {
    const { data } = await supabaseAdmin.from('dunning_pipeline_customers')
      .delete().eq('customer_id', customerId).select('id');
    counts.dunning_pipeline_customers = (data || []).length;
  } catch { /* niet bestaat */ }
  // 7. deals (RESTRICT — sandbox-seed maakt regeling-deal). Best-effort.
  try {
    const { data } = await supabaseAdmin.from('deals')
      .delete().eq('customer_id', customerId).select('id');
    counts.deals = (data || []).length;
  } catch { /* niet bestaat */ }
  // 8. dunning_trajectories / letters / avg_data_requests (best-effort)
  try {
    const { data } = await supabaseAdmin.from('dunning_trajectories')
      .delete().eq('customer_id', customerId).select('id');
    counts.dunning_trajectories = (data || []).length;
  } catch { /* niet bestaat */ }
  try {
    const { data } = await supabaseAdmin.from('letters')
      .delete().eq('customer_id', customerId).select('id');
    counts.letters = (data || []).length;
  } catch { /* niet bestaat */ }
  try {
    const { data } = await supabaseAdmin.from('avg_data_requests')
      .delete().eq('customer_id', customerId).select('id');
    counts.avg_data_requests = (data || []).length;
  } catch { /* niet bestaat */ }
  // 9. whatsapp_messages via conversation_id
  if (convIds.length > 0) {
    const { data, error } = await supabaseAdmin.from('whatsapp_messages')
      .delete().in('conversation_id', convIds).select('id');
    if (error) throw new Error('[teardown] whatsapp_messages: ' + error.message);
    counts.whatsapp_messages = (data || []).length;
  }
  // 10. whatsapp_conversations
  {
    const { data, error } = await supabaseAdmin.from('whatsapp_conversations')
      .delete().eq('customer_id', customerId).select('id');
    if (error) throw new Error('[teardown] whatsapp_conversations: ' + error.message);
    counts.whatsapp_conversations = (data || []).length;
  }
  // 11. email_messages (customer_id-link — from_address matching blijft dan
  //     alleen echt actief zolang de klant bestaat; we wissen expliciet).
  try {
    const { data } = await supabaseAdmin.from('email_messages')
      .delete().eq('customer_id', customerId).select('id');
    counts.email_messages = (data || []).length;
  } catch (e) {
    // fail-soft: eigenaarloze fake email_messages-rijen kunnen nog steeds
    // via from_address matchen; niet fataal voor de edit-flow.
    console.warn('[teardown] email_messages fail-soft:', e?.message || e);
  }

  return { ok: true, customer_id: customerId, counts };
}
