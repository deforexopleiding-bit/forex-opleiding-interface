// api/customer-dossier.js
//
// GET /api/customer-dossier?customer_id=<uuid>[&before=<iso>][&limit=15]
//
// Samengesteld klantdossier — drie blokken (NU / GEBEURD / NOG TE DOEN) voor
// een popup die overal in het CRM te openen is (Gesprekken, Open Acties,
// Te doen, Klanten). Vervangt de behoefte om 4-5 parallelle fetches vanuit
// de UI te doen.
//
// ── RBAC — LEES DIT EERST ──────────────────────────────────────────────────
// Alle data wordt via supabaseAdmin (service-role) opgehaald zodat we niet
// afhankelijk zijn van RLS-configuraties per tabel. De permission-check in
// deze handler is dus DE ENIGE beveiliging — hij MOET bovenaan staan, vóór
// elke query. Drie lagen:
//
//   1. canBase  = finance.dunning.view OR finance.arrangements.view OR
//                 customer.module.access. Zonder → 403.
//   2. canFinance = finance.dunning.view OR finance.arrangements.view. Zonder
//                   → financiële velden worden vervangen door
//                   { granted: false, reason: 'no_permission' } in de response.
//   3. canAdmin = verifyAdmin (ADMIN_ROLES). Zonder → customer_notes/audit
//                 sectie geeft granted:false terug.
//
// Belangrijk: LEEG en GEBLOKKEERD zijn expliciet onderscheidbaar in de
// response. De UI toont "Geen toegang" i.p.v. een leeg blok bij granted=false.
//
// ── Query-params ──────────────────────────────────────────────────────────
//   customer_id  uuid  (required)
//   before       iso   (optional) — timeline-cursor: toon items vóór deze tijd
//   limit        int   (optional, default 15, clamp 1..100) — timeline-limiet
//
// ── Response ──────────────────────────────────────────────────────────────
// Zie api/_lib/customer-dossier-response.js#buildDossierResponse voor de
// exacte shape. Kern: { customer_id, generated_at, blocks: {nu, gebeurd,
// nog_te_doen}, _meta: {permissions} }.

import { supabase, supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildDossierResponse } from './_lib/customer-dossier-response.js';
import { detectSignals } from './_lib/customer-dossier-signals.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRON_CAP = 200;   // per-source cap, voorkomt runaway-query bij extreme klanten

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ── STAP 1: RBAC-gate (BOVENAAN — vóór alle queries) ────────────────────
  // supabaseAdmin hieronder bypasst RLS; deze check is de enige beveiliging.
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // Triple: één van deze drie is genoeg voor dossier-toegang.
  const [canFinDunning, canFinArr, canCustModule] = await Promise.all([
    requirePermission(req, 'finance.dunning.view'),
    requirePermission(req, 'finance.arrangements.view'),
    requirePermission(req, 'customer.module.access'),
  ]);
  const canBase    = !!(canFinDunning || canFinArr || canCustModule);
  const canFinance = !!(canFinDunning || canFinArr);

  if (!canBase) {
    return res.status(403).json({
      error: 'Geen rechten voor klantdossier',
      required: 'finance.dunning.view OR finance.arrangements.view OR customer.module.access',
    });
  }

  // Admin-vlag voor notes/audit. Fail-soft: bij fout → geen admin.
  let canAdmin = false;
  try {
    const admin = await verifyAdmin(req);
    canAdmin = !!admin;
  } catch (_) { canAdmin = false; }

  // ── STAP 2: input-validatie ─────────────────────────────────────────────
  const customerId = String(req.query.customer_id || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Missing customer_id' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Invalid customer_id format' });

  const before = req.query.before ? String(req.query.before) : null;
  const rawLimit = parseInt(req.query.limit, 10);
  const timelineLimit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 15;

  try {
    // ── STAP 3: parallel fetch — één keer alles ──────────────────────────
    // Financiële bronnen worden ALLEEN opgehaald bij canFinance zodat we
    // service-role-data niet in-memory houden voor users die 'r geen recht
    // op hebben.
    const [
      customerRes,
      invoicesRes,
      runsRes,
      arrangementsRes,
      subscriptionsRes,
      conversationsRes,
      whatsappRes,
      pendingActionsRes,
      customerNotesRes,
    ] = await Promise.all([
      fetchCustomer(customerId),
      canFinance ? fetchOpenInvoices(customerId) : Promise.resolve([]),
      fetchRuns(customerId),
      canFinance ? fetchArrangements(customerId) : Promise.resolve([]),
      canFinance ? fetchSubscriptions(customerId) : Promise.resolve([]),
      fetchConversations(customerId),
      fetchWhatsappMessages(customerId),
      canFinance ? fetchPendingActions(customerId) : Promise.resolve([]),
      canAdmin   ? fetchCustomerNotes(customerId) : Promise.resolve([]),
    ]);

    if (!customerRes) {
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }

    // dunning_log is 2-staps: runs → log op run_ids.
    const runIds = runsRes.map((r) => r.id);
    const dunningLog = runIds.length ? await fetchDunningLog(runIds) : [];

    // ── STAP 4: signalen (pure functie, canFinance-only) ─────────────────
    const signals = canFinance
      ? detectSignals({
          arrangements:     arrangementsRes,
          pendingActions:   pendingActionsRes,
          runs:             runsRes,
          invoices:         invoicesRes,
          dunningLog,
          whatsappMessages: whatsappRes,
        })
      : [];

    // ── STAP 5: response bouwen (pure functie) ────────────────────────────
    const response = buildDossierResponse(
      {
        customer:         customerRes,
        invoices:         invoicesRes,
        runs:             runsRes,
        arrangements:     arrangementsRes,
        subscriptions:    subscriptionsRes,
        conversations:    conversationsRes,
        dunningLog,
        pendingActions:   pendingActionsRes,
        whatsappMessages: whatsappRes,
        signals,
        customerNotes:    customerNotesRes,
      },
      { canBase, canFinance, canAdmin },
      { beforeCursor: before, timelineLimit }
    );

    return res.status(200).json(response);
  } catch (err) {
    console.error('[customer-dossier] handler error:', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Interne serverfout' });
  }
}

// ── Bron-fetchers ──────────────────────────────────────────────────────────
// Alle via supabaseAdmin (service-role) — RBAC-check is BOVENAAN gedaan.
// Elk fetch is fail-soft: bij DB-error returnt lege array (behalve customer,
// die is null bij niet-gevonden → 404).

async function fetchCustomer(cid) {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, name, email, phone, company_name')
    .eq('id', cid)
    .maybeSingle();
  if (error) { console.warn('[dossier] customer:', error.message); return null; }
  return data || null;
}

async function fetchOpenInvoices(cid) {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('id, invoice_number, status, due_date, amount_total, amount_paid, credited_amount, created_at')
    .eq('customer_id', cid)
    .order('due_date', { ascending: true })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] invoices:', error.message); return []; }
  // Verrijk met amount_open zodat de builder en signaal-detectie 't gebruiken.
  return (data || []).map((iv) => ({
    ...iv,
    amount_open: Math.max(0, (Number(iv.amount_total) || 0) - (Number(iv.amount_paid) || 0) - (Number(iv.credited_amount) || 0)),
  }));
}

async function fetchRuns(cid) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, workflow_id, status, next_action_at, paused_by_conversation_id, paused_by_arrangement_id, started_at, completed_at, completion_reason, updated_at, current_step_id')
    .eq('customer_id', cid)
    .order('updated_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] runs:', error.message); return []; }
  return data || [];
}

async function fetchArrangements(cid) {
  const { data, error } = await supabaseAdmin
    .from('payment_arrangements')
    .select('id, type, status, details, invoice_ids, created_at, updated_at, proposed_by, approved_by, approved_at, cancellation_reason')
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] arrangements:', error.message); return []; }
  return data || [];
}

async function fetchSubscriptions(cid) {
  // Kolomselectie defensief — sommige installaties hebben andere velden dan
  // andere. We pakken de basisset die de UI nodig heeft.
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('id, status, start_date, amount, term_count, billing_cycle')
    .eq('customer_id', cid)
    .order('start_date', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    if (error.code === '42P01' || error.code === '42703') return [];
    console.warn('[dossier] subscriptions:', error.message);
    return [];
  }
  return data || [];
}

async function fetchConversations(cid) {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, status, phone_number, module, last_message_at, updated_at')
    .eq('customer_id', cid)
    .order('last_message_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] conversations:', error.message); return []; }
  return data || [];
}

async function fetchWhatsappMessages(cid) {
  // via conversation-lookup (2-staps zoals in de bestaande modal).
  const { data: convs, error: cErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id')
    .eq('customer_id', cid);
  if (cErr) { console.warn('[dossier] wa-convs:', cErr.message); return []; }
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('whatsapp_messages')
    .select('id, conversation_id, direction, body, template_name, sent_at, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] wa-messages:', error.message); return []; }
  return data || [];
}

async function fetchPendingActions(cid) {
  const { data, error } = await supabaseAdmin
    .from('pending_actions')
    .select('id, action_type, payload, status, proposed_by_user_id, approved_by_user_id, created_at, updated_at, approved_at, executed_at, execution_result, rejection_reason, arrangement_id, invoice_id, scheduled_for')
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] pending_actions:', error.message); return []; }
  return data || [];
}

async function fetchDunningLog(runIds) {
  const { data, error } = await supabaseAdmin
    .from('dunning_log')
    .select('id, run_id, step_id, event_type, payload, message_id, created_at')
    .in('run_id', runIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] dunning_log:', error.message); return []; }
  return data || [];
}

async function fetchCustomerNotes(cid) {
  const { data, error } = await supabaseAdmin
    .from('customer_notes')
    .select('id, body, created_at, edited_at, created_by_user_id')
    .eq('customer_id', cid)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[dossier] customer_notes:', error.message); return []; }
  return data || [];
}
