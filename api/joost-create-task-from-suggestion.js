// api/joost-create-task-from-suggestion.js
// POST -> maakt een MANUAL_VERIFY_PAYMENT pending_action aan vanuit een Joost-
// suggestie, en linkt het resultaat terug aan de suggestion (status =
// USED_TASK_CREATED, linked_task_id = nieuwe task-id).
//
// Eén-call combinatie van:
//   1) tasks-create-verify-payment (insert pending_action MANUAL_VERIFY_PAYMENT)
//   2) joost-mark-outcome (status USED_TASK_CREATED + linked_task_id)
//
// Permission: finance.joost.use EN finance.tasks.create (beide vereist).
//   - finance.joost.use   : de gebruiker mag Joost-suggesties opvolgen.
//   - finance.tasks.create: de gebruiker mag verify-payment-taken aanmaken.
// Geen fallback naar finance.arrangements.propose (afwijkend van het standalone
// tasks-create-verify-payment endpoint): de Joost-flow is een power-user-actie,
// permissies moeten expliciet zijn.
//
// Body (JSON):
//   {
//     suggestion_id:        uuid    (verplicht),
//     invoice_id:           uuid    (verplicht — factuur waar klant betaling op claimt),
//     claim_text_override:  string  (optioneel — overschrijft suggestion.suggested_reply
//                                    als claim-tekst voor de pending_action payload;
//                                    min 10 chars als wel meegegeven),
//     claimed_amount:       number  (optioneel — default = openstaand bedrag; > 0)
//   }
//
// Flow:
//   1. Auth + perm-check
//   2. Validatie body
//   3. Lookup joost_suggestions (+ conversation_id + status)
//      - status moet PROPOSED zijn (anders 409)
//      - moet conversation_id hebben (anders 400: orphan suggestion)
//   4. Lookup whatsapp_conversations om customer_id te bepalen
//      - conv.customer_id mag niet NULL zijn (anders 400: klant nog niet gekoppeld)
//   5. Lookup invoice + verifieer dat invoice.customer_id == conv.customer_id
//   6. INSERT pending_action (MANUAL_VERIFY_PAYMENT, source='joost')
//   7. UPDATE joost_suggestions (status=USED_TASK_CREATED, linked_task_id, used_at,
//      used_by_user_id). Bij fout: best-effort rollback van pending_action.
//   8. Audit-log task.created_from_joost (fail-soft)
//
// Response 201:
//   {
//     task_id:        uuid,   // pending_actions.id
//     suggestion_id:  uuid,   // joost_suggestions.id
//     status:         'USED_TASK_CREATED'
//   }
//
// Error responses:
//   400  body/validatie-fout (incl. orphan suggestion, klant niet gekoppeld)
//   401  geen sessie
//   403  geen rechten (finance.joost.use + finance.tasks.create vereist)
//   404  suggestion / invoice niet gevonden
//   409  suggestion niet in PROPOSED state
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s)   { return typeof s === 'string' && UUID_RE.test(s); }
function isPosNum(n) { return typeof n === 'number' && Number.isFinite(n) && n > 0; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission: finance.joost.use EN finance.tasks.create ----
  const hasJoostUse    = await requirePermission(req, 'finance.joost.use');
  if (!hasJoostUse)    return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
  const hasTasksCreate = await requirePermission(req, 'finance.tasks.create');
  if (!hasTasksCreate) return res.status(403).json({ error: 'Geen rechten (finance.tasks.create)' });

  // ---- Body parsen ----
  const body = req.body || {};
  const suggestionId = body.suggestion_id ? String(body.suggestion_id).trim() : '';
  const invoiceId    = body.invoice_id    ? String(body.invoice_id).trim()    : '';
  const claimTextOverride =
    typeof body.claim_text_override === 'string' ? body.claim_text_override.trim() : '';
  const claimedAmount = body.claimed_amount != null ? Number(body.claimed_amount) : null;

  if (!isUuid(suggestionId)) return res.status(400).json({ error: 'suggestion_id (uuid) vereist' });
  if (!isUuid(invoiceId))    return res.status(400).json({ error: 'invoice_id (uuid) vereist' });
  if (claimTextOverride && claimTextOverride.length < 10) {
    return res.status(400).json({ error: 'claim_text_override moet min 10 karakters bevatten' });
  }
  if (claimedAmount != null && !isPosNum(claimedAmount)) {
    return res.status(400).json({ error: 'claimed_amount moet een getal > 0 zijn' });
  }

  try {
    // ========================================================================
    // STAP 1: suggestion ophalen + valideren
    // ========================================================================
    const { data: sugg, error: suggErr } = await supabaseAdmin
      .from('joost_suggestions')
      .select('id, status, conversation_id, suggested_reply, triggered_by_message_id')
      .eq('id', suggestionId)
      .maybeSingle();
    if (suggErr) {
      console.error('[joost-create-task] suggestion-lookup error:', suggErr.message);
      return res.status(500).json({ error: suggErr.message });
    }
    if (!sugg) return res.status(404).json({ error: 'Suggestion niet gevonden' });

    // status moet PROPOSED zijn — voorkomt dubbele consumptie
    if (sugg.status !== 'PROPOSED') {
      return res.status(409).json({
        error: 'Suggestion is niet in PROPOSED state (al geconsumeerd)',
        current_status: sugg.status,
      });
    }

    if (!sugg.conversation_id) {
      return res.status(400).json({ error: 'Suggestion heeft geen conversation_id (orphan)' });
    }

    // ========================================================================
    // STAP 2: conversation + customer ophalen
    // ========================================================================
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id, phone_number')
      .eq('id', sugg.conversation_id)
      .maybeSingle();
    if (convErr) {
      console.error('[joost-create-task] conv-lookup error:', convErr.message);
      return res.status(500).json({ error: convErr.message });
    }
    if (!conv) return res.status(404).json({ error: 'WhatsApp-conversatie niet gevonden' });
    if (!conv.customer_id) {
      return res.status(400).json({
        error: 'Conversatie heeft nog geen gekoppelde klant — koppel eerst klant voor task-aanmaak',
      });
    }
    const customerId = conv.customer_id;

    // ========================================================================
    // STAP 3: invoice ophalen + verifieer klant-koppeling
    // ========================================================================
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, status')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) {
      console.error('[joost-create-task] invoice-lookup error:', invErr.message);
      return res.status(500).json({ error: invErr.message });
    }
    if (!inv) return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (inv.customer_id !== customerId) {
      return res.status(400).json({
        error: `Factuur ${inv.invoice_number || inv.id} hoort niet bij de klant van deze conversatie`,
      });
    }

    // Default claimed_amount = openstaand bedrag (amount_total − amount_paid − credited_amount)
    // als niet meegegeven. Zelfde berekening als elders in de codebase (o.a.
    // dunning-pipeline-detail, inbox-conversation-context).
    let finalClaimedAmount = claimedAmount;
    if (finalClaimedAmount == null) {
      const total = Number(inv.amount_total) || 0;
      const paid  = Number(inv.amount_paid)  || 0;
      const cred  = Number(inv.credited_amount) || 0;
      const open  = Math.round(Math.max(0, total - paid - cred) * 100) / 100;
      if (!isPosNum(open)) {
        return res.status(400).json({
          error: 'claimed_amount vereist (openstaand bedrag niet beschikbaar als default)',
        });
      }
      finalClaimedAmount = open;
    }

    // Claim-tekst: override OF suggestion.suggested_reply als fallback
    const claimText = claimTextOverride || (sugg.suggested_reply || '').trim();
    if (!claimText || claimText.length < 10) {
      return res.status(400).json({
        error: 'claim_text_override vereist (suggestion.suggested_reply te kort als fallback)',
      });
    }

    // ========================================================================
    // STAP 4: INSERT pending_action (MANUAL_VERIFY_PAYMENT, source='joost')
    // ========================================================================
    const claimedAt = new Date().toISOString();
    const klantMessageId = sugg.triggered_by_message_id || null;

    const payload = {
      claimed_amount:   finalClaimedAmount,
      claim_text:       claimText,
      klant_message_id: klantMessageId,
      claimed_at:       claimedAt,
      source:           'joost',
      joost_suggestion_id: suggestionId,
      rationale:        'klant claimt al betaald te hebben - aangemaakt vanuit Joost-suggestie',
    };

    const insertRow = {
      customer_id:         customerId,
      arrangement_id:      null,
      invoice_id:          invoiceId,
      action_type:         'MANUAL_VERIFY_PAYMENT',
      status:              'PENDING',
      proposed_by_user_id: user.id,
      payload,
    };

    const { data: paRow, error: paErr } = await supabaseAdmin
      .from('pending_actions')
      .insert(insertRow)
      .select('id')
      .single();
    if (paErr) {
      console.error('[joost-create-task] pending-action-insert error:', paErr.message);
      return res.status(500).json({ error: 'pending-action-insert: ' + paErr.message });
    }
    const taskId = paRow.id;

    // ========================================================================
    // STAP 5: UPDATE joost_suggestions — status + linked_task_id
    // Bij fout: best-effort rollback van zojuist aangemaakte pending_action.
    // ========================================================================
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabaseAdmin
      .from('joost_suggestions')
      .update({
        status:           'USED_TASK_CREATED',
        linked_task_id:   taskId,
        used_at:          nowIso,
        used_by_user_id:  user.id,
      })
      .eq('id', suggestionId)
      .eq('status', 'PROPOSED'); // race-guard: alleen als nog steeds PROPOSED
    if (updErr) {
      console.error('[joost-create-task] suggestion-update error:', updErr.message);
      // Rollback pending_action (best-effort)
      try {
        await supabaseAdmin.from('pending_actions').delete().eq('id', taskId);
      } catch (rbErr) {
        console.error('[joost-create-task] rollback failed:', rbErr.message);
      }
      return res.status(500).json({ error: 'suggestion-update: ' + updErr.message });
    }

    // ========================================================================
    // STAP 6: audit-log (fail-soft)
    // ========================================================================
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'task.created_from_joost',
        entity_type: 'pending_action',
        entity_id:   taskId,
        after_json:  {
          pending_action_id:   taskId,
          joost_suggestion_id: suggestionId,
          invoice_id:          invoiceId,
          customer_id:         customerId,
          claimed_amount:      finalClaimedAmount,
          klant_message_id:    klantMessageId,
        },
        reason_text: claimText.slice(0, 500),
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[joost-create-task audit]', e.message);
    }

    // ========================================================================
    // STAP 7: response
    // ========================================================================
    return res.status(201).json({
      task_id:       taskId,
      suggestion_id: suggestionId,
      status:        'USED_TASK_CREATED',
    });
  } catch (e) {
    console.error('[joost-create-task-from-suggestion]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
