// api/tasks-create-escalation.js
// POST -> nieuwe MANUAL_ESCALATION pending_action aanmaken vanuit de Finance Inbox
// wanneer een conversatie moet worden geescaleerd (klant boos, bedreiging, juridisch,
// niet-oplosbaar via standaard-flow, etc).
//
// F3 — Escalation-tasks zijn een standalone task-type, gescheiden van TL-arrangements
// en MANUAL_VERIFY_PAYMENT:
//   - action_type = 'MANUAL_ESCALATION' (geen TL_-prefix; nooit door D2-executor opgepakt)
//   - arrangement_id = NULL (klant-brede escalatie, niet aan een betalingsregeling)
//   - invoice_id = NULL (escalation hangt aan klant/conversation, niet aan factuur)
//   - status = 'PENDING' (escalation IS de taak; blijft open totdat een admin hem
//     handmatig op EXECUTED zet via mark-executed met outcome resolved|handed_over,
//     of progress logt met outcome=ongoing — die laatste laat de taak in PENDING).
//
// Permission: finance.tasks.create (met fallback finance.joost.use, want de meest
// voorkomende trigger is een Joost-suggestie met detected_intent='escalation_needed'
// vanuit de inbox UI).
//
// Body (JSON):
//   {
//     conversation_id:         uuid    (verplicht — koppeling naar whatsapp_conversations),
//     reason:                  string  (verplicht, min 10 chars — escalation-text),
//     triggered_by_message_id: uuid    (optioneel — inbox-bericht dat aanleiding gaf),
//     joost_suggestion_id:     uuid    (optioneel — als escalation via Joost-card),
//     severity:                'low' | 'medium' | 'high' (default 'medium'),
//     context_summary:         string  (optioneel — korte samenvatting voor de admin
//                                       die de taak straks in Open Acties oppakt)
//   }
//
// Customer-resolutie: conversation.customer_id wordt opgezocht en is VERPLICHT
// gevuld (zonder gekoppelde klant kunnen we geen escalation-task aanmaken — eerst
// de conversation handmatig aan een klant koppelen via inbox-link-conversation).
//
// Joost-link (optioneel): als joost_suggestion_id is meegegeven, wordt na succesvolle
// task-INSERT de joost_suggestion bijgewerkt:
//   - status            -> 'USED_TASK_CREATED'
//   - linked_task_id    -> nieuwe pending_action.id
//   - used_at           -> nu
//   - used_by_user_id   -> user.id
// Dit is fail-soft: een mislukte joost-update blokkeert de task niet.
//
// Response 201: { item: { ...pending_action } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Permission: finance.tasks.create OF finance.joost.use (fallback voor inbox-flow
  // waar de escalation-knop vanuit een Joost-card wordt getriggerd).
  const hasTasksCreate = await requirePermission(req, 'finance.tasks.create');
  const hasJoostUse    = hasTasksCreate ? true : await requirePermission(req, 'finance.joost.use');
  if (!hasTasksCreate && !hasJoostUse) {
    return res.status(403).json({ error: 'Geen rechten (finance.tasks.create of finance.joost.use)' });
  }

  // ---- Body parsen ----
  const body = req.body || {};
  const conversationId       = body.conversation_id ? String(body.conversation_id) : null;
  const reason               = typeof body.reason === 'string' ? body.reason.trim() : '';
  const triggeredByMessageId = body.triggered_by_message_id ? String(body.triggered_by_message_id) : null;
  const joostSuggestionId    = body.joost_suggestion_id ? String(body.joost_suggestion_id) : null;
  const severityRaw          = typeof body.severity === 'string' ? body.severity.trim().toLowerCase() : '';
  const severity             = VALID_SEVERITIES.has(severityRaw) ? severityRaw : 'medium';
  const contextSummary       = typeof body.context_summary === 'string'
    ? body.context_summary.trim().slice(0, 2000) // hard cap voor jsonb-payload
    : '';

  // ---- Validatie ----
  if (!isUuid(conversationId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  }
  if (!reason || reason.length < 10) {
    return res.status(400).json({ error: 'reason vereist (min 10 karakters)' });
  }
  if (triggeredByMessageId && !isUuid(triggeredByMessageId)) {
    return res.status(400).json({ error: 'triggered_by_message_id moet geldige uuid zijn' });
  }
  if (joostSuggestionId && !isUuid(joostSuggestionId)) {
    return res.status(400).json({ error: 'joost_suggestion_id moet geldige uuid zijn' });
  }
  if (severityRaw && !VALID_SEVERITIES.has(severityRaw)) {
    return res.status(400).json({ error: 'severity moet één van [low, medium, high] zijn' });
  }

  try {
    // ---- Conversation lookup -> customer_id ----
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) throw new Error('conversation-lookup: ' + convErr.message);
    if (!conv)   return res.status(404).json({ error: 'Conversatie niet gevonden' });
    if (!conv.customer_id) {
      return res.status(400).json({
        error: 'Conversatie is niet gekoppeld aan een klant — koppel eerst via inbox-link-conversation',
      });
    }

    // ---- INSERT pending_action ----
    // Source: 'joost' als de escalation via een Joost-suggestie is getriggerd,
    // anders 'manual' (admin klikte zelf op escaleer-knop zonder Joost-card).
    const source = joostSuggestionId ? 'joost' : 'manual';
    const escalatedAt = new Date().toISOString();
    const payload = {
      reason,
      conversation_id:          conversationId,
      triggered_by_message_id:  triggeredByMessageId,
      joost_suggestion_id:      joostSuggestionId,
      severity,
      context_summary:          contextSummary || null,
      source,
      escalated_at:             escalatedAt,
      rationale:                'escalatie aangevraagd vanuit Finance Inbox - handmatige opvolging nodig',
    };

    const insertRow = {
      customer_id:         conv.customer_id,
      arrangement_id:      null,
      invoice_id:          null,
      action_type:         'MANUAL_ESCALATION',
      status:              'PENDING',
      proposed_by_user_id: user?.id || null,
      payload,
    };

    const { data: paRow, error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow)
      .select(`
        id, customer_id, arrangement_id, invoice_id, action_type, status, payload,
        proposed_by_user_id, approved_by_user_id, approved_at, executed_at,
        execution_result, rejection_reason, scheduled_for, expires_at,
        created_at, updated_at
      `)
      .single();
    if (paErr) throw new Error('pending-action-insert: ' + paErr.message);

    // ---- Joost-suggestion cross-link (fail-soft) ----
    // Als de escalation via een Joost-card werd getriggerd: markeer de suggestie
    // als USED_TASK_CREATED en koppel linked_task_id terug naar deze nieuwe row.
    // Idempotent: alleen update als status nog PROPOSED is (anders is er al een
    // outcome geregistreerd en willen we die niet overschrijven).
    let joostLinked = false;
    if (joostSuggestionId) {
      try {
        const { data: joostUpd, error: joostErr } = await supabaseAdmin
          .from('joost_suggestions')
          .update({
            status:          'USED_TASK_CREATED',
            linked_task_id:  paRow.id,
            used_at:         escalatedAt,
            used_by_user_id: user?.id || null,
          })
          .eq('id', joostSuggestionId)
          .eq('status', 'PROPOSED')   // optimistic concurrency: alleen vanuit PROPOSED
          .select('id');
        if (joostErr) {
          console.error('[tasks-create-escalation joost-link]', joostErr.message);
        } else {
          joostLinked = !!(joostUpd && joostUpd.length > 0);
        }
      } catch (e) {
        console.error('[tasks-create-escalation joost-link]', e.message);
      }
    }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user?.id || null,
        action:      'task.escalation_created',
        entity_type: 'pending_action',
        entity_id:   paRow.id,
        after_json:  {
          pending_action_id:       paRow.id,
          customer_id:             conv.customer_id,
          conversation_id:         conversationId,
          triggered_by_message_id: triggeredByMessageId,
          joost_suggestion_id:     joostSuggestionId,
          joost_linked:            joostLinked,
          severity,
          source,
        },
        reason_text: reason,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[tasks-create-escalation audit]', e.message);
    }

    // ---- Response: shape consistent met tasks-list (aliased kolommen) ----
    const item = {
      id:               paRow.id,
      customer_id:      paRow.customer_id,
      arrangement_id:   paRow.arrangement_id,
      invoice_id:       paRow.invoice_id,
      action_type:      paRow.action_type,
      status:           paRow.status,
      payload:          paRow.payload || {},
      proposed_by:      paRow.proposed_by_user_id,
      approved_by:      paRow.approved_by_user_id,
      approved_at:      paRow.approved_at,
      executed_at:      paRow.executed_at,
      execution_result: paRow.execution_result,
      reject_reason:    paRow.rejection_reason,
      scheduled_for:    paRow.scheduled_for,
      expires_at:       paRow.expires_at,
      created_at:       paRow.created_at,
      updated_at:       paRow.updated_at,
    };

    return res.status(201).json({
      item,
      task_id:      paRow.id,
      joost_linked: joostLinked,
    });
  } catch (e) {
    console.error('[tasks-create-escalation]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
