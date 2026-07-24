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
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRON_CAP = 200;   // per-source cap, voorkomt runaway-query bij extreme klanten

// Uniforme fetcher-return shape: { data, error }. Zorgt dat LEEG en MISLUKT
// nooit meer verward worden zoals bij fetchCustomer.name (jul 2026). De
// response-builder leest error om per blok status:'error' te renderen.
function ok(data)   { return { data, error: null }; }
function fail(msg)  { return { data: null, error: String(msg || 'Onbekende DB-fout') }; }

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
    // Elke fetcher returnt { data, error }. Financiële bronnen worden
    // ALLEEN opgehaald bij canFinance zodat we service-role-data niet
    // in-memory houden voor users die 'r geen recht op hebben.
    const EMPTY = ok([]);
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
      freeTasksRes,
    ] = await Promise.all([
      fetchCustomer(customerId),
      canFinance ? fetchOpenInvoices(customerId) : Promise.resolve(EMPTY),
      fetchRuns(customerId),
      canFinance ? fetchArrangements(customerId) : Promise.resolve(EMPTY),
      canFinance ? fetchSubscriptions(customerId) : Promise.resolve(EMPTY),
      fetchConversations(customerId),
      fetchWhatsappMessages(customerId),
      canFinance ? fetchPendingActions(customerId) : Promise.resolve(EMPTY),
      canAdmin   ? fetchCustomerNotes(customerId) : Promise.resolve(EMPTY),
      // PR D — vrije taken (taken_items) via customer_id. canBase volstaat
      // (operationele data, geen bedragen). Filter status<>'done' zodat
      // alleen open taken meekomen; partial index taken_items_customer_open_idx
      // dekt precies deze query.
      fetchFreeTasks(customerId),
    ]);

    // Customer: query-fout → 500 (geen 404). 404 alleen als de klant ECHT
    // niet bestaat (data null zonder error).
    if (customerRes.error) {
      return res.status(500).json({
        error: 'Klant-query mislukte: ' + customerRes.error,
      });
    }
    if (!customerRes.data) {
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }

    // dunning_log is 2-staps: runs → log op run_ids. Als runs-fetcher zelf
    // faalt, log gaat leeg — maar signals detecteren dan óók niets omdat
    // runs=[] is. Beide fetch-errors landen in de per-blok status.
    const runIds = (runsRes.data || []).map((r) => r.id);
    const dunningLog = runIds.length ? await fetchDunningLog(runIds) : ok([]);

    // ── STAP 4: signalen (pure functie, canFinance-only) ─────────────────
    const signals = canFinance
      ? detectSignals({
          arrangements:     arrangementsRes.data || [],
          pendingActions:   pendingActionsRes.data || [],
          runs:             runsRes.data || [],
          invoices:         invoicesRes.data || [],
          dunningLog:       dunningLog.data || [],
          whatsappMessages: whatsappRes.data || [],
        })
      : [];

    // ── STAP 5: response bouwen (pure functie) ────────────────────────────
    // fetch-errors per bron worden aan de builder doorgegeven zodat elk
    // blok status:'error' + message kan tonen i.p.v. stilte-en-lege-lijst.
    const response = buildDossierResponse(
      {
        customer:         customerRes.data,
        customerDisplayName: customerDisplayName(customerRes.data, 'Klant'),
        invoices:         invoicesRes.data || [],
        runs:             runsRes.data || [],
        arrangements:     arrangementsRes.data || [],
        subscriptions:    subscriptionsRes.data || [],
        conversations:    conversationsRes.data || [],
        dunningLog:       dunningLog.data || [],
        pendingActions:   pendingActionsRes.data || [],
        whatsappMessages: whatsappRes.data || [],
        signals,
        customerNotes:    customerNotesRes.data || [],
        freeTasks:        freeTasksRes.data || [],
        // Fetch-error map: gebruikt door builder om per blok status:'error'
        // te renderen. Sleutel = interne bron-naam.
        fetchErrors: {
          invoices:       invoicesRes.error,
          runs:           runsRes.error,
          arrangements:   arrangementsRes.error,
          subscriptions:  subscriptionsRes.error,
          conversations:  conversationsRes.error,
          whatsapp:       whatsappRes.error,
          pendingActions: pendingActionsRes.error,
          customerNotes:  customerNotesRes.error,
          freeTasks:      freeTasksRes.error,
          dunningLog:     dunningLog.error,
        },
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
// Elke fetcher returnt { data, error }: error=null bij succes (data mag []
// zijn = LEEG), error=string bij DB-fout (data=null = MISLUKT). De builder
// bepaalt per blok hoe die twee cases visueel worden onderscheiden.

// customers (bevestigd schema via migration 012 + 2026-06-04-customers-b2b.sql):
// id, first_name, last_name, is_company, company_name, email, phone,
// address_*, notes, archived_at, anonymized_at, ...
// GEEN kolom 'name' — display-naam wordt samengesteld via customerDisplayName.
async function fetchCustomer(cid) {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, is_company, company_name, email, phone, archived_at, anonymized_at')
    .eq('id', cid)
    .maybeSingle();
  if (error) {
    console.error('[dossier] customer:', error.message);
    return fail(error.message);
  }
  return ok(data || null);
}

async function fetchOpenInvoices(cid) {
  const { data, error } = await supabaseAdmin
    .from('invoices')
    .select('id, invoice_number, status, due_date, amount_total, amount_paid, credited_amount, created_at')
    .eq('customer_id', cid)
    .order('due_date', { ascending: true })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] invoices:', error.message);
    return fail(error.message);
  }
  // Verrijk met amount_open zodat de builder en signaal-detectie 't gebruiken.
  const rows = (data || []).map((iv) => ({
    ...iv,
    amount_open: Math.max(0, (Number(iv.amount_total) || 0) - (Number(iv.amount_paid) || 0) - (Number(iv.credited_amount) || 0)),
  }));
  return ok(rows);
}

async function fetchRuns(cid) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, workflow_id, status, next_action_at, paused_by_conversation_id, paused_by_arrangement_id, started_at, completed_at, completion_reason, updated_at, current_step_id')
    .eq('customer_id', cid)
    .order('updated_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] runs:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

async function fetchArrangements(cid) {
  const { data, error } = await supabaseAdmin
    .from('payment_arrangements')
    // approved_by / approved_at bestaan NIET op payment_arrangements — de
    // "wie heeft goedgekeurd"-state hoort op pending_actions (bewuste
    // ontwerp-keuze, zie inline comments in api/arrangements-detail.js:39-41
    // en api/arrangements-list.js:100-104). Live-schema heeft in plaats
    // daarvan proposed_at + accepted_at voor lifecycle-tijden. Zelfde
    // kolom-set als api/arrangements-detail.js:44-49.
    .select('id, type, status, details, invoice_ids, created_at, updated_at, proposed_by, proposed_at, accepted_at, cancellation_reason')
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] arrangements:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

// subscriptions HEEFT GEEN customer_id-kolom — koppeling loopt via deals.
// Zelfde 2-staps pattern als api/sales-customer-subscriptions.js.
// Kolommen bevestigd via 2026-05-30-finance-fase-1-fundament.sql r54-65.
async function fetchSubscriptions(cid) {
  const { data: deals, error: dealsErr } = await supabaseAdmin
    .from('deals')
    .select('id')
    .eq('customer_id', cid)
    .is('archived_at', null);
  if (dealsErr) {
    console.error('[dossier] subscriptions deals-step:', dealsErr.message);
    return fail(dealsErr.message);
  }
  const dealIds = (deals || []).map((d) => d.id);
  if (dealIds.length === 0) return ok([]);

  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('id, deal_id, status, start_date, amount, term_count, description, teamleader_subscription_id')
    .in('deal_id', dealIds)
    .order('start_date', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] subscriptions:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

// whatsapp_conversations kolommen bevestigd via
// 2026-06-07-whatsapp-inbox-foundation.sql. GEEN kolom 'module' — die is
// een afgeleide via phone_number_id → whatsapp_module_config.module. Voor
// de dossier-modal is de conversation-status voldoende; module wordt hier
// niet getoond (kan later als de UI 't nodig heeft).
async function fetchConversations(cid) {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, status, phone_number, last_message_at, updated_at')
    .eq('customer_id', cid)
    .order('last_message_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] conversations:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

async function fetchWhatsappMessages(cid) {
  const { data: convs, error: cErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id')
    .eq('customer_id', cid);
  if (cErr) {
    console.error('[dossier] wa-convs (msg-step):', cErr.message);
    return fail(cErr.message);
  }
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return ok([]);
  const { data, error } = await supabaseAdmin
    .from('whatsapp_messages')
    .select('id, conversation_id, direction, body, template_name, sent_at, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] wa-messages:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

async function fetchPendingActions(cid) {
  const { data, error } = await supabaseAdmin
    .from('pending_actions')
    .select('id, action_type, payload, status, proposed_by_user_id, approved_by_user_id, created_at, updated_at, approved_at, executed_at, execution_result, rejection_reason, arrangement_id, invoice_id, scheduled_for')
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] pending_actions:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

async function fetchDunningLog(runIds) {
  const { data, error } = await supabaseAdmin
    .from('dunning_log')
    .select('id, run_id, step_id, event_type, payload, message_id, created_at')
    .in('run_id', runIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] dunning_log:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

async function fetchCustomerNotes(cid) {
  const { data, error } = await supabaseAdmin
    .from('customer_notes')
    .select('id, body, created_at, edited_at, created_by_user_id')
    .eq('customer_id', cid)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) {
    console.error('[dossier] customer_notes:', error.message);
    return fail(error.message);
  }
  return ok(data || []);
}

// PR D — open vrije taken (taken_items.customer_id). Alleen niet-afgeronde
// taken (status <> 'done') — de partial index taken_items_customer_open_idx
// dekt precies deze query. Fail-soft bij 42P01/42703 zodat het endpoint niet
// crasht als de migratie nog niet is gedraaid (dan is de "kolom bestaat niet"
// een tolereerbare toestand tot ops de SQL heeft gedraaid).
async function fetchFreeTasks(cid) {
  const { data, error } = await supabaseAdmin
    .from('taken_items')
    .select('id, titel, omschrijving, prioriteit, categorie, status, deadline, assigned_to_id, aangemaakt')
    .eq('customer_id', cid)
    .neq('status', 'done')
    .order('deadline', { ascending: true, nullsFirst: false })
    .limit(BRON_CAP);
  if (error) {
    if (error.code === '42P01' || error.code === '42703') return ok([]);
    console.error('[dossier] free_tasks:', error.message);
    return fail(error.message);
  }
  // Assignee-namen batch-lookup (identiek patroon aan api/taken.js).
  const rows = data || [];
  const assigneeIds = Array.from(new Set(rows.map((r) => r.assigned_to_id).filter(Boolean)));
  let nameMap = {};
  if (assigneeIds.length) {
    const { data: profiles } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email')
      .in('id', assigneeIds);
    for (const p of profiles || []) nameMap[p.id] = p.full_name || p.email || null;
  }
  return ok(rows.map((r) => ({
    ...r,
    assigned_to_name: r.assigned_to_id ? (nameMap[r.assigned_to_id] || null) : null,
  })));
}
