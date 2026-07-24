// api/_lib/customer-dossier-response.js
//
// Pure functies: bouw de uiteindelijke dossier-response uit reeds-opgehaalde
// data + per-blok permission-vlaggen. Geen DB-calls, geen fetch — volledig
// testbaar zonder mocks.
//
// De belangrijkste invariant: LEEG (geen data gevonden) en GEBLOKKEERD
// (geen rechten om te tonen) moeten voor de UI onderscheidbaar zijn.
// Daarom geeft elke blok-key drie mogelijkheden:
//   { granted: false, reason: 'no_permission' }   → afgeschermd
//   { granted: true,  data: { ... } }             → gegevens (kunnen leeg zijn)
// Nooit `data: null` bij granted=true — always een object, ook als er geen
// facturen zijn (dan `data.invoices = []`).
//
// De UI leest `granted` en toont "Geen toegang tot financiële details" i.p.v.
// een leeg blok bij granted=false.

import {
  labelForDunningEvent,
  labelForPendingActionEvent,
  labelForArrangementEvent,
  ARRANGEMENT_TYPE_LABELS,
  ARRANGEMENT_STATUS_LABELS,
  PENDING_ACTION_STATUS_LABELS,
  ACTION_TYPE_LABELS,
} from './dunning-event-labels.js';

/**
 * Bouw pauze-reden in gewone taal uit een run-row.
 * dunning_workflow_runs.paused_by_conversation_id / paused_by_arrangement_id
 * geven al de reden aan; als beide leeg zijn maar status='paused', is het
 * reply-stop of handmatig.
 */
function pauseReasonLabel(run) {
  if (!run || String(run.status || '').toLowerCase() !== 'paused') return null;
  const parts = [];
  if (run.paused_by_conversation_id) parts.push('klant reageerde in gesprek');
  if (run.paused_by_arrangement_id)  parts.push('regeling actief');
  if (parts.length) return parts.join(' + ');
  return 'reactie ontvangen (reply-stop)';
}

/**
 * Bouw invoice-view: bedrag open, dagen te laat.
 * Verwacht `amount_open` (number, in EUR) reeds berekend door de caller.
 */
function invoiceView(iv, nowMs) {
  const dueTs = iv?.due_date ? Date.parse(iv.due_date) : null;
  const daysOverdue = (Number.isFinite(dueTs) && dueTs < nowMs)
    ? Math.floor((nowMs - dueTs) / 86400000)
    : 0;
  return {
    id:             iv.id,
    invoice_number: iv.invoice_number || null,
    status:         iv.status || null,
    due_date:       iv.due_date || null,
    amount_total:   Number(iv.amount_total) || 0,
    amount_paid:    Number(iv.amount_paid)  || 0,
    amount_open:    Number(iv.amount_open)  || 0,
    days_overdue:   daysOverdue,
  };
}

/**
 * Bouw timeline-item uit een dunning_log-row.
 */
function dunningLogToTimelineItem(row) {
  const { title, detail } = labelForDunningEvent(row.event_type, row.payload);
  return {
    id:     'dlog:' + row.id,
    source: 'dunning_log',
    at:     row.created_at,
    title,
    detail: detail || null,
    actor:  row.payload?.user_id ? { user_id: row.payload.user_id } : null,
    raw_type: row.event_type,
  };
}

/**
 * Bouw N tijdlijn-items uit één pending_action (created / approved / rejected / executed).
 * We willen elke STATE-TRANSITION als aparte tijdlijn-regel.
 */
function pendingActionToTimelineItems(pa) {
  const items = [];
  const type = pa.action_type;
  items.push({
    id:     'pa-create:' + pa.id,
    source: 'pending_actions',
    at:     pa.created_at,
    ...labelForPendingActionEvent(type, 'created'),
    detail: null,
    actor:  pa.proposed_by_user_id ? { user_id: pa.proposed_by_user_id } : null,
    raw_type: `pa_${type}_created`,
  });
  if (pa.approved_at) {
    items.push({
      id:     'pa-appr:' + pa.id,
      source: 'pending_actions',
      at:     pa.approved_at,
      ...labelForPendingActionEvent(type, 'approved'),
      detail: null,
      actor:  pa.approved_by_user_id ? { user_id: pa.approved_by_user_id } : null,
      raw_type: `pa_${type}_approved`,
    });
  }
  const status = String(pa.status || '').toUpperCase();
  if (status === 'REJECTED') {
    items.push({
      id:     'pa-rej:' + pa.id,
      source: 'pending_actions',
      at:     pa.updated_at || pa.created_at,
      ...labelForPendingActionEvent(type, 'rejected'),
      detail: pa.rejection_reason || null,
      actor:  pa.approved_by_user_id ? { user_id: pa.approved_by_user_id } : null,
      raw_type: `pa_${type}_rejected`,
    });
  } else if (status === 'EXECUTED' && pa.executed_at) {
    items.push({
      id:     'pa-exec:' + pa.id,
      source: 'pending_actions',
      at:     pa.executed_at,
      ...labelForPendingActionEvent(type, 'executed'),
      detail: null,
      actor:  null,
      raw_type: `pa_${type}_executed`,
    });
  } else if (status === 'FAILED' && pa.executed_at) {
    items.push({
      id:     'pa-fail:' + pa.id,
      source: 'pending_actions',
      at:     pa.executed_at,
      ...labelForPendingActionEvent(type, 'failed'),
      detail: pa.execution_result?.failure_reason || pa.execution_result?.error || null,
      actor:  null,
      raw_type: `pa_${type}_failed`,
    });
  } else if (status === 'CANCELLED') {
    items.push({
      id:     'pa-cancel:' + pa.id,
      source: 'pending_actions',
      at:     pa.updated_at || pa.created_at,
      ...labelForPendingActionEvent(type, 'cancelled'),
      detail: null,
      actor:  null,
      raw_type: `pa_${type}_cancelled`,
    });
  }
  return items;
}

/**
 * Bouw N tijdlijn-items uit één arrangement (voorgesteld / actief / einde).
 */
function arrangementToTimelineItems(arr) {
  const items = [];
  const type = arr.type;
  items.push({
    id:     'arr-create:' + arr.id,
    source: 'payment_arrangements',
    at:     arr.created_at,
    ...labelForArrangementEvent(type, 'VOORGESTELD'),
    detail: null,
    actor:  arr.proposed_by ? { user_id: arr.proposed_by } : null,
    raw_type: `arr_${type}_voorgesteld`,
  });
  if (arr.approved_at && String(arr.status || '').toUpperCase() !== 'VOORGESTELD') {
    items.push({
      id:     'arr-appr:' + arr.id,
      source: 'payment_arrangements',
      at:     arr.approved_at,
      ...labelForArrangementEvent(type, 'ACTIEF'),
      detail: null,
      actor:  arr.approved_by ? { user_id: arr.approved_by } : null,
      raw_type: `arr_${type}_actief`,
    });
  }
  const status = String(arr.status || '').toUpperCase();
  const isTerminal = status === 'NAGEKOMEN' || status === 'VERBROKEN' || status === 'GEANNULEERD';
  if (isTerminal && arr.updated_at) {
    items.push({
      id:     'arr-end:' + arr.id,
      source: 'payment_arrangements',
      at:     arr.updated_at,
      ...labelForArrangementEvent(type, status),
      detail: arr.cancellation_reason || null,
      actor:  null,
      raw_type: `arr_${type}_${status.toLowerCase()}`,
    });
  }
  return items;
}

/**
 * WhatsApp-message → tijdlijn-item.
 */
function whatsappToTimelineItem(msg) {
  const dir = String(msg.direction || '').toLowerCase();
  const isOut = dir === 'out' || dir === 'outbound';
  const title = isOut ? 'WhatsApp uit' : 'WhatsApp in';
  const body = msg.template_name
    ? `[template] ${msg.template_name}`
    : (msg.body || '').slice(0, 120);
  return {
    id:     'wa:' + msg.id,
    source: 'whatsapp_messages',
    at:     msg.sent_at || msg.created_at,
    title,
    detail: body || null,
    actor:  null,
    raw_type: isOut ? 'wa_out' : 'wa_in',
  };
}

/**
 * Bouw de complete blok-2 timeline: merge alle bronnen, sorteer DESC op `at`,
 * paginate met before-cursor + limit.
 */
export function buildTimeline({ dunningLog, pendingActions, arrangements, whatsappMessages }, opts) {
  const before = opts?.before ? Date.parse(opts.before) : null;
  const limit  = Math.min(100, Math.max(1, Number(opts?.limit) || 15));

  const items = [
    ...(Array.isArray(dunningLog) ? dunningLog : []).map(dunningLogToTimelineItem),
    ...(Array.isArray(pendingActions) ? pendingActions : []).flatMap(pendingActionToTimelineItems),
    ...(Array.isArray(arrangements) ? arrangements : []).flatMap(arrangementToTimelineItems),
    ...(Array.isArray(whatsappMessages) ? whatsappMessages : []).map(whatsappToTimelineItem),
  ].filter((it) => it && it.at);

  items.sort((a, b) => {
    const ta = Date.parse(a.at) || 0;
    const tb = Date.parse(b.at) || 0;
    return tb - ta;
  });

  const filtered = before
    ? items.filter((it) => (Date.parse(it.at) || 0) < before)
    : items;

  const page = filtered.slice(0, limit);
  const hasMore = filtered.length > limit;
  const nextCursor = hasMore ? page[page.length - 1]?.at : null;

  return {
    items:       page,
    has_more:    hasMore,
    next_cursor: nextCursor,
    total_available: items.length,
  };
}

/**
 * Complete dossier-response builder.
 *
 * @param {object} input
 * @param {object} input.customer
 * @param {Array}  input.invoices        (met amount_open pre-berekend)
 * @param {Array}  input.runs
 * @param {Array}  input.arrangements
 * @param {Array}  input.subscriptions
 * @param {Array}  input.conversations   (whatsapp_conversations)
 * @param {Array}  input.dunningLog      (voor timeline)
 * @param {Array}  input.pendingActions  (voor timeline + open-lijst)
 * @param {Array}  input.whatsappMessages
 * @param {Array}  input.signals         reeds-gedetecteerd via detectSignals()
 * @param {Array}  input.customerNotes   optioneel, alleen bij canAdmin
 * @param {object} perms
 * @param {boolean} perms.canBase        toegang tot het dossier (RBAC-triple)
 * @param {boolean} perms.canFinance     financiële details (bedragen/facturen/regelingen)
 * @param {boolean} perms.canAdmin       verifyAdmin — voor notes/audit
 * @param {object} [opts]
 * @param {string} [opts.beforeCursor]   timeline paginering
 * @param {number} [opts.timelineLimit]
 * @param {number} [opts.nowMs]          testbaar
 * @returns {object} JSON-shape voor /api/customer-dossier
 */
export function buildDossierResponse(input, perms, opts) {
  const nowMs = Number.isFinite(opts?.nowMs) ? opts.nowMs : Date.now();
  const canBase    = perms?.canBase === true;
  const canFinance = perms?.canFinance === true;
  const canAdmin   = perms?.canAdmin === true;

  // canBase moet true zijn om überhaupt hier te komen; endpoint hoort 403
  // te sturen. Voor de builder: als canBase=false, return minimal locked shape.
  if (!canBase) {
    return {
      customer_id: input?.customer?.id || null,
      blocks: {
        nu:         { granted: false, reason: 'no_permission' },
        gebeurd:    { granted: false, reason: 'no_permission' },
        nog_te_doen:{ granted: false, reason: 'no_permission' },
      },
    };
  }

  const customer = input?.customer || null;

  // ── BLOK 1 — NU ─────────────────────────────────────────────────────────
  // Klant-basis is always toegankelijk bij canBase (naam/email/phone/bedrijf).
  // Financiële velden alleen bij canFinance.
  const activeRun = (input?.runs || []).find((r) => String(r.status || '').toLowerCase() === 'active');
  const pausedRun = (input?.runs || []).find((r) => String(r.status || '').toLowerCase() === 'paused');
  const liveArrangement = (input?.arrangements || []).find((a) => {
    const s = String(a.status || '').toUpperCase();
    return s === 'ACTIEF' || s === 'VOORGESTELD';
  }) || null;
  const activeSub = (input?.subscriptions || []).find((s) => String(s.status || '').toLowerCase() === 'active') || null;
  const latestConv = (input?.conversations || [])[0] || null;

  const openInvoices = (input?.invoices || []).filter((iv) => Number(iv.amount_open) > 0);
  const openTotal = openInvoices.reduce((sum, iv) => sum + (Number(iv.amount_open) || 0), 0);

  const nuBlock = {
    granted: true,
    data: {
      customer: customer ? {
        id:      customer.id,
        name:    customer.name || null,
        email:   customer.email || null,
        phone:   customer.phone || null,
        company: customer.company_name || null,
      } : null,
      // Dunning-run stand:
      dunning: activeRun
        ? { state: 'active',  next_action_at: activeRun.next_action_at || null, run_id: activeRun.id }
        : pausedRun
          ? {
              state: 'paused',
              reason: pauseReasonLabel(pausedRun),
              paused_at: pausedRun.updated_at || null,
              run_id: pausedRun.id,
            }
          : { state: 'none' },
      // Gesprek-status:
      conversation: latestConv
        ? { state: latestConv.status || 'unknown', conversation_id: latestConv.id }
        : { state: 'none' },
    },
  };

  // Financiële velden apart onder canFinance:
  if (canFinance) {
    nuBlock.data.financial = {
      granted: true,
      open_invoice_count: openInvoices.length,
      open_total_amount:  Math.round(openTotal * 100) / 100,
      live_arrangement: liveArrangement
        ? {
            id:       liveArrangement.id,
            type:     liveArrangement.type,
            type_label: ARRANGEMENT_TYPE_LABELS[liveArrangement.type] || liveArrangement.type,
            status:   liveArrangement.status,
            status_label: ARRANGEMENT_STATUS_LABELS[liveArrangement.status] || liveArrangement.status,
          }
        : null,
      subscription: activeSub
        ? {
            id:         activeSub.id,
            amount:     Number(activeSub.amount) || 0,
            start_date: activeSub.start_date || null,
            status:     activeSub.status,
            term_count: activeSub.term_count != null ? Number(activeSub.term_count) : null,
          }
        : null,
    };
  } else {
    nuBlock.data.financial = { granted: false, reason: 'no_permission' };
  }

  // ── BLOK 2 — GEBEURD (timeline) ─────────────────────────────────────────
  // Timeline is beschikbaar zodra canBase; wél filteren op wat de user
  // financieel mag zien. Non-finance krijgt WhatsApp + dunning_log-mechaniek
  // (skipped/paused-events) en workflow-lifecycle, maar geen arrangement/
  // pending_actions state-changes (die onthullen bedragen impliciet via
  // action_type-labels als "Kwijtschelding").
  const timeline = buildTimeline({
    dunningLog:       input?.dunningLog || [],
    pendingActions:   canFinance ? (input?.pendingActions || []) : [],
    arrangements:     canFinance ? (input?.arrangements || [])   : [],
    whatsappMessages: input?.whatsappMessages || [],
  }, { before: opts?.beforeCursor, limit: opts?.timelineLimit });

  const gebeurdBlock = {
    granted: true,
    data: {
      timeline: timeline.items,
      pagination: {
        has_more:    timeline.has_more,
        next_cursor: timeline.next_cursor,
        total_available: timeline.total_available,
      },
      // Notes + audit alleen bij admin — zichtbare afscherming voor non-admin.
      notes: canAdmin
        ? { granted: true, items: input?.customerNotes || [] }
        : { granted: false, reason: 'admin_only' },
    },
  };

  // ── BLOK 3 — NOG TE DOEN ────────────────────────────────────────────────
  const openPendingActions = (input?.pendingActions || []).filter((pa) => {
    const s = String(pa.status || '').toUpperCase();
    return s === 'PENDING' || s === 'APPROVED';
  });

  const nogTeDoenBlock = {
    granted: true,
    data: {
      open_actions: canFinance
        ? {
            granted: true,
            items: openPendingActions.map((pa) => ({
              id:            pa.id,
              action_type:   pa.action_type,
              action_label:  ACTION_TYPE_LABELS[pa.action_type] || pa.action_type,
              status:        pa.status,
              status_label:  PENDING_ACTION_STATUS_LABELS[pa.status] || pa.status,
              created_at:    pa.created_at,
              proposed_by_user_id: pa.proposed_by_user_id || null,
              days_open:     pa.created_at
                ? Math.floor((nowMs - Date.parse(pa.created_at)) / 86400000)
                : null,
            })),
          }
        : { granted: false, reason: 'no_permission' },
      open_invoices: canFinance
        ? {
            granted: true,
            items: openInvoices.map((iv) => invoiceView(iv, nowMs)),
          }
        : { granted: false, reason: 'no_permission' },
      // Signalen: alleen bij canFinance (de meeste condities gaan over
      // financiële state; zonder canFinance ontstaat een leeg / onbetrouwbaar
      // beeld). Non-finance krijgt granted:false zichtbaar.
      signals: canFinance
        ? { granted: true, items: input?.signals || [] }
        : { granted: false, reason: 'no_permission' },
      // TAKEN — expliciet uitleg: taken_items heeft (nog) geen customer_id
      // (zie PR D roadmap). We geven een placeholder-blok terug zodat de UI
      // het onderscheid kan maken tussen "leeg" en "nog niet ondersteund".
      free_tasks: {
        granted: false,
        reason:  'not_supported_yet',
        note:    'taken_items.customer_id ontbreekt — volgt in PR D',
      },
    },
  };

  return {
    customer_id: customer?.id || null,
    generated_at: new Date(nowMs).toISOString(),
    blocks: {
      nu:         nuBlock,
      gebeurd:    gebeurdBlock,
      nog_te_doen: nogTeDoenBlock,
    },
    _meta: {
      permissions: {
        base:    canBase,
        finance: canFinance,
        admin:   canAdmin,
      },
    },
  };
}
