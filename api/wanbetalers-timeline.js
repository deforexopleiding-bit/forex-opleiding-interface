// GET /api/wanbetalers-timeline?customer_id=<uuid>[&page=1&page_size=50]
// Gemeenschappelijke tijdlijn voor het wanbetalers-dossier + Wanbetalers-tab
// op de klant-detailpagina. Voegt 8 bronnen samen tot één chronologisch
// gesorteerde feed:
//
//   customer_notes         → note              (handmatige notitie, met author)
//   dunning_call_log       → call              (belpoging + outcome)
//   pending_actions        → task_*            (created/executed/rejected/cancelled)
//   payment_arrangements   → arrangement_*     (proposed / accepted / broken / done)
//   dunning_workflow_runs  → run_*             (started/paused/resumed/completed)
//   dunning_log            → send_email/send_wa/wait/step/…
//   whatsapp_messages      → wa_in / wa_out    (uit alle finance-conv van deze klant)
//   audit_log              → audit_customer_*  (CRUD op de klant zelf)
//
// Auth: verifyAdmin (ADMIN_ROLES) — zelfde gate als customer-notes / customer-audit.
//
// Query-params:
//   customer_id  uuid  (required)
//   page         int   (default 1)
//   page_size    int   (default 50, clamp 1..200)
//
// Sortering: `at` DESC (nieuwste eerst).
//
// Response (200):
//   { items: [ TimelineItem, … ],
//     total_estimated: int,      // pre-pagination count over alle bronnen
//     page, page_size }
//
// TimelineItem-shape:
//   { id           : string,                // "<bron>:<row.id>"
//     at           : ISO timestamp,         // event-tijd (DESC-sortering)
//     type         : text,                  // zie type-lijst hierboven
//     source       : text,                  // "customer_notes" / …
//     title        : text,                  // korte NL-label
//     description  : text|null,             // lange tekst / body / note
//     actor        : { id, name } | null,   // wie deed het (indien bekend)
//     dry_run      : bool|undefined,        // true bij is_test / payload.dry_run
//     meta         : object,                // event-specifieke velden
//   }
//
// Performance-note: elke bron cap op 200 rijen (BRON_CAP). Bij een klant met
// >200 dunning-log-events krijgt de UI de nieuwste 200 per bron; totale
// items-lijst is dus max BRON_CAP × 8 = 1600 voor sortering + paginate.
// Verdere pagination-diepte is out-of-scope voor MVP (kan later bron-per-bron
// offsets krijgen); rapporteer `total_estimated` zodat de UI ziet wanneer we
// tegen het plafond aanlopen.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BRON_CAP = 200;

// Menselijke labels voor pending_actions.action_type + arrangement.type.
// Onbekend valt terug op de raw key.
const ACTION_TYPE_LABELS = {
  TL_INVOICE_UPDATE_DUE:  'Factuur — nieuwe vervaldag',
  TL_INVOICE_SPLIT:       'Factuur — splitsen in termijnen',
  TL_SUBSCRIPTION_PAUSE:  'Abonnement — pauzeren',
  TL_SUBSCRIPTION_STOP:   'Abonnement — stopzetten',
  TL_INVOICE_WRITEOFF:    'Factuur — kwijtschelding',
  MANUAL_VERIFY_PAYMENT:  'Betaling verifiëren',
  MANUAL_PROPOSE_ARRANGEMENT: 'Regeling voorstellen',
  MANUAL_ESCALATION:      'Escalatie',
  MANUAL_FOLLOWUP:        'Opvolgen',
};

const ARR_TYPE_LABELS = {
  UITSTEL:           'Uitstel',
  SPLITSING:         'Splitsing',
  TOEZEGGING:        'Betaalafspraak',
  ABONNEMENT_PAUZE:  'Abonnement pauze',
  ABONNEMENT_STOP:   'Abonnement stop',
  KWIJTSCHELDING:    'Kwijtschelding',
};

const CALL_OUTCOME_LABELS = {
  no_answer:        'Geen gehoor',
  voicemail:        'Voicemail ingesproken',
  callback:         'Terugbelafspraak',
  payment_promise:  'Toezegging tot betaling',
  payment_plan:     'Betalingsregeling',
  refused:          'Weigert / betwist',
  wrong_number:     'Verkeerd nummer',
  paid_during_call: 'Betaald tijdens gesprek',
};

const AUDIT_ACTION_LABELS = {
  'customer.created':    'Klant aangemaakt',
  'customer.updated':    'Klant bewerkt',
  'customer.archived':   'Klant gearchiveerd',
  'customer.unarchived': 'Klant heractiveerd',
  'customer.anonymized': 'Klant geanonimiseerd',
  'customer.note.created': 'Notitie toegevoegd',
  'customer.note.updated': 'Notitie bewerkt',
  'customer.note.archived': 'Notitie gearchiveerd',
};

// dunning_log.event_type → tijdlijn-label. Fallback: raw key.
const DLOG_LABELS = {
  workflow_started: 'Workflow gestart',
  workflow_stopped: 'Workflow gestopt',
  workflow_completed: 'Workflow afgerond',
  step_started:     'Stap gestart',
  step_completed:   'Stap uitgevoerd',
  email_sent:       'E-mail verzonden',
  whatsapp_sent:    'WhatsApp verzonden',
  wait_started:     'Wachtstap begonnen',
  wait_completed:   'Wachtstap afgerond',
  task_created:     'Taak aangemaakt (workflow)',
  stop:             'Workflow beëindigd',
  resume_dunning:   'Aanmaan-flow hervat',
  paused_by_arrangement: 'Gepauzeerd — regeling actief',
  paused_by_conversation: 'Gepauzeerd — klant reageerde',
  resumed:          'Hervat',
  dry_run_marker:   'Dry-run marker',
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const customerId = String(req.query.customer_id || '').trim();
  if (!customerId) return res.status(400).json({ error: 'Missing customer_id' });
  if (!UUID_RE.test(customerId)) return res.status(400).json({ error: 'Invalid customer_id format' });

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const rawSize = parseInt(req.query.page_size, 10) || 50;
  const pageSize = Math.min(200, Math.max(1, rawSize));

  try {
    // 1) Alle 8 bronnen parallel — elk gecapt op BRON_CAP nieuwste rijen.
    const [
      notesRes,
      callsRes,
      tasksRes,
      arrsRes,
      runsRes,
      dlogRes,
      waRes,
      auditRes,
    ] = await Promise.all([
      fetchNotes(customerId),
      fetchCalls(customerId),
      fetchTasks(customerId),
      fetchArrangements(customerId),
      fetchRuns(customerId),
      fetchDunningLog(customerId),
      fetchWhatsapp(customerId),
      fetchAudit(customerId),
    ]);

    // 2) Actor-namen resolven (batch via profiles.in()).
    const userIds = new Set();
    for (const arr of [notesRes, callsRes, tasksRes, arrsRes, auditRes]) {
      for (const r of arr) {
        const uid = r._actor_user_id;
        if (uid) userIds.add(uid);
      }
    }
    const actorsById = await fetchActors(Array.from(userIds));

    // 3) Merge → items met genormaliseerde shape.
    const items = [
      ...notesRes.map((r) => noteToItem(r, actorsById)),
      ...callsRes.map((r) => callToItem(r, actorsById)),
      ...tasksRes.map((r) => taskToItem(r, actorsById)),
      ...arrsRes.map((r) => arrangementToItem(r, actorsById)),
      ...runsRes.flatMap(runToItems),
      ...dlogRes.map(dlogToItem),
      ...waRes.map(waToItem),
      ...auditRes.map((r) => auditToItem(r, actorsById)),
    ].filter(Boolean);

    // 4) Sorteer DESC op `at`.
    items.sort((a, b) => {
      const ta = a.at ? Date.parse(a.at) : 0;
      const tb = b.at ? Date.parse(b.at) : 0;
      return tb - ta;
    });

    const total = items.length;
    const from = (page - 1) * pageSize;
    const paged = items.slice(from, from + pageSize);

    return res.status(200).json({
      items: paged,
      total_estimated: total,
      page,
      page_size: pageSize,
      total_pages: Math.ceil(total / pageSize) || 1,
    });
  } catch (err) {
    console.error('[wanbetalers-timeline] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Bron-fetchers ────────────────────────────────────────────────────────────

async function fetchNotes(cid) {
  const { data, error } = await supabaseAdmin
    .from('customer_notes')
    .select('id, body, created_at, edited_at, archived_at, created_by_user_id')
    .eq('customer_id', cid)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] notes:', error.message); return []; }
  return (data || []).map((r) => ({ ...r, _actor_user_id: r.created_by_user_id }));
}

async function fetchCalls(cid) {
  const { data, error } = await supabaseAdmin
    .from('dunning_call_log')
    .select('id, outcome, note, sip_line, attempted_at, created_by, created_at')
    .eq('customer_id', cid)
    .order('attempted_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] calls:', error.message); return []; }
  return (data || []).map((r) => ({ ...r, _actor_user_id: r.created_by }));
}

async function fetchTasks(cid) {
  const { data, error } = await supabaseAdmin
    .from('pending_actions')
    .select(`id, action_type, payload, status, proposed_by_user_id, approved_by_user_id,
             created_at, updated_at, approved_at, executed_at, execution_result,
             rejection_reason, arrangement_id, invoice_id, scheduled_for`)
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] tasks:', error.message); return []; }
  return (data || []).map((r) => ({ ...r, _actor_user_id: r.proposed_by_user_id || r.approved_by_user_id }));
}

async function fetchArrangements(cid) {
  // payment_arrangements heeft alleen created_at / updated_at / approved_at.
  // Er zijn géén dedicated activated_at / breached_at / completed_at / cancelled_at kolommen.
  // Status-lifecycle (VOORGESTELD → ACTIEF → NAGEKOMEN/VERBROKEN/GEANNULEERD)
  // gebruikt updated_at als event-tijd voor status-changes; approved_at markeert de goedkeuring.
  // NB: kolommen heten hier proposed_by / approved_by (niet _user_id — dat is de pending_actions-tabel).
  const { data, error } = await supabaseAdmin
    .from('payment_arrangements')
    .select(`id, type, status, details, invoice_ids, created_at, updated_at,
             proposed_by, approved_by, approved_at, cancellation_reason`)
    .eq('customer_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] arrs:', error.message); return []; }
  return (data || []).map((r) => ({ ...r, _actor_user_id: r.proposed_by || r.approved_by }));
}

async function fetchRuns(cid) {
  const { data, error } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select(`id, workflow_id, status, started_at, completed_at, completion_reason,
             updated_at, trigger_invoice_count,
             dunning_workflows:workflow_id ( name )`)
    .eq('customer_id', cid)
    .order('started_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] runs:', error.message); return []; }
  return data || [];
}

async function fetchDunningLog(cid) {
  // dunning_log heeft geen customer_id → join via run_id → dunning_workflow_runs.
  // 2-staps: eerst runs voor deze klant, dan log-events op die run-ids.
  const { data: runs, error: rErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id')
    .eq('customer_id', cid);
  if (rErr) { console.warn('[timeline] dlog-runs:', rErr.message); return []; }
  const runIds = (runs || []).map((r) => r.id);
  if (runIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('dunning_log')
    .select('id, run_id, step_id, event_type, payload, message_id, created_at')
    .in('run_id', runIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] dlog:', error.message); return []; }
  return data || [];
}

async function fetchWhatsapp(cid) {
  // whatsapp_messages heeft geen customer_id → join via conversation_id →
  // whatsapp_conversations.customer_id. We laten módule=finance impliciet
  // (elke conv van deze klant is relevant — ook events / onboarding —
  // want dit is een klant-brede tijdlijn).
  const { data: convs, error: cErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id')
    .eq('customer_id', cid);
  if (cErr) { console.warn('[timeline] wa-convs:', cErr.message); return []; }
  const convIds = (convs || []).map((c) => c.id);
  if (convIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from('whatsapp_messages')
    .select('id, conversation_id, direction, body, template_name, media_type, status, created_at')
    .in('conversation_id', convIds)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] wa:', error.message); return []; }
  return data || [];
}

async function fetchAudit(cid) {
  const { data, error } = await supabaseAdmin
    .from('audit_log')
    .select('id, user_id, action, reason_text, created_at')
    .eq('entity_type', 'customer')
    .eq('entity_id', cid)
    .order('created_at', { ascending: false })
    .limit(BRON_CAP);
  if (error) { console.warn('[timeline] audit:', error.message); return []; }
  return (data || []).map((r) => ({ ...r, _actor_user_id: r.user_id }));
}

async function fetchActors(userIds) {
  const out = {};
  if (!userIds || !userIds.length) return out;
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles').select('id, full_name, email').in('id', userIds);
    if (error) throw error;
    for (const p of (data || [])) out[p.id] = { id: p.id, name: p.full_name || p.email || null };
  } catch (e) {
    console.warn('[timeline] actors:', e.message);
  }
  return out;
}

// ── Item-shapers ─────────────────────────────────────────────────────────────

function noteToItem(r, actorsById) {
  return {
    id:          'note:' + r.id,
    at:          r.edited_at || r.created_at,
    type:        'note',
    source:      'customer_notes',
    title:       r.edited_at ? 'Notitie (bewerkt)' : 'Notitie',
    description: r.body || null,
    actor:       actorsById[r._actor_user_id] || null,
    meta:        { note_id: r.id, edited: !!r.edited_at },
  };
}

function callToItem(r, actorsById) {
  const outLabel = CALL_OUTCOME_LABELS[r.outcome] || r.outcome;
  return {
    id:          'call:' + r.id,
    at:          r.attempted_at || r.created_at,
    type:        'call',
    source:      'dunning_call_log',
    title:       'Belpoging — ' + outLabel,
    description: r.note || null,
    actor:       actorsById[r._actor_user_id] || null,
    meta:        { outcome: r.outcome, sip_line: r.sip_line || null },
  };
}

function taskToItem(r, actorsById) {
  const actionLbl = ACTION_TYPE_LABELS[r.action_type] || r.action_type;
  // We tonen 1 timeline-entry per taak; de status is de leidende event.
  // Latere refinement kan dit splitsen in `created` + `executed` per status-change.
  const statusLbl = statusLabelForTask(r.status);
  const at = r.executed_at || r.approved_at || r.updated_at || r.created_at;
  const kind = (r.payload && r.payload.kind) ? r.payload.kind : null;
  const title = 'Taak — ' + actionLbl + ' — ' + statusLbl;
  const desc  = (r.payload && r.payload.title) || (r.payload && r.payload.description) || null;
  const isDry = !!(r.payload && r.payload.dry_run === true);
  return {
    id:          'task:' + r.id,
    at,
    type:        'task_' + String(r.status || '').toLowerCase(),
    source:      'pending_actions',
    title,
    description: desc,
    actor:       actorsById[r._actor_user_id] || null,
    dry_run:     isDry || undefined,
    meta: {
      action_type: r.action_type,
      status:      r.status,
      kind,
      arrangement_id: r.arrangement_id || null,
      invoice_id:  r.invoice_id || null,
      scheduled_for: r.scheduled_for || null,
      rejection_reason: r.rejection_reason || null,
    },
  };
}

function statusLabelForTask(s) {
  const st = String(s || '').toUpperCase();
  return ({
    PENDING:   'in behandeling',
    APPROVED:  'goedgekeurd',
    REJECTED:  'afgewezen',
    EXECUTED:  'uitgevoerd',
    FAILED:    'mislukt',
    CANCELLED: 'geannuleerd',
  })[st] || (s || 'onbekend');
}

function arrangementToItem(r, actorsById) {
  const typeLbl = ARR_TYPE_LABELS[r.type] || r.type;
  const stLbl   = arrangementStatusLabel(r.status);
  // Geen dedicated activated_at/breached_at/completed_at/cancelled_at kolommen —
  // voor terminal states nemen we updated_at (status-change moment), anders approved_at, anders created_at.
  const at = r.updated_at || r.approved_at || r.created_at;
  return {
    id:          'arr:' + r.id,
    at,
    type:        'arrangement_' + String(r.status || '').toLowerCase(),
    source:      'payment_arrangements',
    title:       'Regeling — ' + typeLbl + ' — ' + stLbl,
    description: r.cancellation_reason || null,
    actor:       actorsById[r._actor_user_id] || null,
    meta: {
      arrangement_id: r.id,
      arr_type: r.type,
      arr_status: r.status,
      invoice_ids: r.invoice_ids || null,
      details: r.details || null,
    },
  };
}

function arrangementStatusLabel(s) {
  return ({
    VOORGESTELD:  'voorgesteld',
    ACTIEF:       'actief',
    NAGEKOMEN:    'nagekomen',
    VERBROKEN:    'verbroken',
    GEANNULEERD:  'geannuleerd',
  })[String(s || '').toUpperCase()] || (s || 'onbekend');
}

// Een run genereert 1..2 events: started + (paused|completed|cancelled).
// Pause-events zonder timestamp worden overgeslagen om ruis te voorkomen.
function runToItems(r) {
  const out = [];
  const wfName = r.dunning_workflows?.name || 'Aanmaan-flow';
  if (r.started_at) {
    out.push({
      id:          'run:' + r.id + ':started',
      at:          r.started_at,
      type:        'run_started',
      source:      'dunning_workflow_runs',
      title:       'Workflow gestart — ' + wfName,
      description: r.trigger_invoice_count ? (r.trigger_invoice_count + ' factu(u)r(en) betrokken') : null,
      actor:       null,
      meta:        { run_id: r.id, workflow_name: wfName, invoice_count: r.trigger_invoice_count || null },
    });
  }
  if (r.completed_at) {
    out.push({
      id:          'run:' + r.id + ':completed',
      at:          r.completed_at,
      type:        'run_completed',
      source:      'dunning_workflow_runs',
      title:       'Workflow afgerond — ' + wfName,
      description: r.completion_reason || null,
      actor:       null,
      meta:        { run_id: r.id, workflow_name: wfName, completion_reason: r.completion_reason || null },
    });
  }
  return out;
}

function dlogToItem(r) {
  const et = String(r.event_type || '').toLowerCase();
  const title = DLOG_LABELS[et] || et;
  const p = r.payload || {};
  const desc = p.summary || p.template_name || p.subject || p.message || p.reason || null;
  const isDry = !!(p.dry_run === true);
  return {
    id:          'dlog:' + r.id,
    at:          r.created_at,
    type:        'dunning_' + et,
    source:      'dunning_log',
    title,
    description: desc ? String(desc).slice(0, 400) : null,
    actor:       null,
    dry_run:     isDry || undefined,
    meta:        { run_id: r.run_id || null, step_id: r.step_id || null, event_type: r.event_type, message_id: r.message_id || null, payload: p },
  };
}

function waToItem(r) {
  const dir = String(r.direction || '').toLowerCase();
  const inbound = (dir === 'inbound' || dir === 'in');
  const body = r.body || (r.template_name ? '[template] ' + r.template_name : (r.media_type ? '[' + r.media_type + ']' : null));
  return {
    id:          'wa:' + r.id,
    at:          r.created_at,
    type:        inbound ? 'wa_in' : 'wa_out',
    source:      'whatsapp_messages',
    title:       inbound ? 'WhatsApp — klant' : 'WhatsApp — ons',
    description: body ? String(body).slice(0, 400) : null,
    actor:       null,
    meta:        { conversation_id: r.conversation_id, template_name: r.template_name || null, status: r.status || null, media_type: r.media_type || null },
  };
}

function auditToItem(r, actorsById) {
  const key = String(r.action || '');
  const lbl = AUDIT_ACTION_LABELS[key] || key;
  return {
    id:          'audit:' + r.id,
    at:          r.created_at,
    type:        'audit_' + key.replace(/\W+/g, '_'),
    source:      'audit_log',
    title:       lbl,
    description: r.reason_text || null,
    actor:       actorsById[r._actor_user_id] || null,
    meta:        { action: r.action },
  };
}
