import { supabase, supabaseAdmin } from './supabase.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function toUuidOrNull(id) {
  if (!id) return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)) ? String(id) : null;
}

function getBaseUrl() {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'http://localhost:3000';
}

async function logAuditEntry({ agent_name = 'system', action, payload = {}, result = {}, status, error_message = null, approval_id = null, triggered_by = 'system' }) {
  const { error } = await supabase.from('agent_audit_log').insert({
    agent_name, action, payload, result, status,
    error_message: error_message || null,
    approval_id:   approval_id  || null,
    triggered_by:  triggered_by || 'system',
    created_at:    new Date().toISOString(),
  });
  if (error) console.error('[audit-log] insert fout:', error.message);
}

// Resolve assignee naam → { name, type, id }
async function resolveAssigneeLocal(name) {
  if (!name) return null;
  const AGENT_NAMES = ['Simon', 'Leon', 'Aron'];
  if (AGENT_NAMES.includes(name)) return { name, type: 'agent', id: name };
  const { data } = await supabase
    .from('team_members').select('id, name, type').ilike('name', `%${name}%`).eq('is_active', true).limit(1);
  if (data?.length > 0) return { name: data[0].name, type: data[0].type, id: String(data[0].id) };
  return { name, type: 'employee', id: name };
}

// ── Centrale dispatcher ────────────────────────────────────────────────────

export async function executeAgentTool(toolName, toolPayload, approvedBy, approvalId = null) {
  console.log(`[tool-executor] ${toolName} | approvedBy=${approvedBy}`);
  await logAuditEntry({ action: toolName, payload: toolPayload, status: 'executing', approval_id: approvalId, triggered_by: approvedBy });

  try {
    let result;
    switch (toolName) {
      // ── C1: Algemene tools ───────────────────────────────────────────────
      case 'add_decision_to_log':      result = await executeAddDecision(toolPayload); break;
      case 'create_meeting_followup':  result = await executeCreateMeetingFollowup(toolPayload); break;

      // ── C2: Simon tools ──────────────────────────────────────────────────
      case 'send_email_reply':         result = await executeSendEmailReply(toolPayload); break;
      case 'schedule_email_followup':  result = await executeScheduleEmailFollowup(toolPayload); break;

      // ── C3: Aron tools ───────────────────────────────────────────────────
      case 'identify_payment_concerns': result = await executeIdentifyPaymentConcerns(toolPayload); break;
      case 'draft_payment_reminder':    result = await executeDraftPaymentReminder(toolPayload); break;
      case 'mark_invoice_followup':     result = await executeMarkInvoiceFollowup(toolPayload); break;

      // ── C3: Leon tools ───────────────────────────────────────────────────
      case 'create_task_for_contract': result = await executeCreateTaskForContract(toolPayload); break;
      case 'update_task_status':       result = await executeUpdateTaskStatus(toolPayload); break;

      // ── C3: bulk_categorize_review handelt per-item via approval payload ─
      case 'apply_category_correction': result = await executeApplyCategoryCorrection(toolPayload); break;

      default:
        throw new Error(`Onbekende tool: "${toolName}"`);
    }

    await logAuditEntry({ action: toolName, payload: toolPayload, result, status: 'success', approval_id: approvalId, triggered_by: approvedBy });
    console.log(`[tool-executor] ${toolName} succes`);
    return result;

  } catch (err) {
    await logAuditEntry({ action: toolName, payload: toolPayload, status: 'error', error_message: err.message, approval_id: approvalId, triggered_by: approvedBy });
    console.error(`[tool-executor] ${toolName} fout:`, err.message);
    throw err;
  }
}

// ── C1 tools ──────────────────────────────────────────────────────────────

async function executeAddDecision({ titel, beschrijving, onderbouwing, betrokken_agents, meeting_id } = {}) {
  if (!titel) throw new Error('titel is verplicht voor add_decision_to_log');
  const { data, error } = await supabase.from('decisions').insert({
    title:         titel,
    description:   [beschrijving, onderbouwing].filter(Boolean).join(' | ') || null,
    decided_by:    Array.isArray(betrokken_agents) ? betrokken_agents.join(', ') : (betrokken_agents || 'Agent'),
    decision_date: new Date().toISOString().split('T')[0],
    status:        'active',
    meeting_id:    toUuidOrNull(meeting_id),
    tags:          null,
  }).select('id').single();
  if (error) throw new Error(`decisions insert fout: ${error.message}`);
  return { ok: true, decision_id: data.id, titel };
}

async function executeCreateMeetingFollowup({ topic, deelnemende_agents, voorgestelde_datum, agenda_notities } = {}) {
  if (!topic) throw new Error('topic is verplicht voor create_meeting_followup');
  const { data, error } = await supabase.from('agent_meetings').insert({
    title:        topic,
    agenda:       agenda_notities || topic,
    participants: Array.isArray(deelnemende_agents) ? deelnemende_agents : [],
    status:       'draft',
    created_by:   'agent',
    meeting_type: 'followup',
    transcript:   [],
    created_at:   new Date().toISOString(),
  }).select('id').single();
  if (error) throw new Error(`agent_meetings insert fout: ${error.message}`);
  return { ok: true, meeting_id: data.id, topic, voorgestelde_datum: voorgestelde_datum || null };
}

// ── C2 tools ──────────────────────────────────────────────────────────────

async function executeSendEmailReply({ email_id, to, subject, body, from_mailbox } = {}) {
  if (!body) throw new Error('body is verplicht voor send_email_reply');

  // Haal originele email op voor context (from_address, mailbox, subject, body_text)
  let emailCtx = null;
  if (email_id) {
    const { data } = await supabase.from('email_messages')
      .select('from_address, from_name, subject, mailbox, body_text, snippet')
      .eq('id', Number(email_id)).maybeSingle();
    emailCtx = data;
  }

  const recipientTo  = to           || emailCtx?.from_address || null;
  const fromMailbox  = from_mailbox  || emailCtx?.mailbox      || 'info@deforexopleiding.nl';
  const replySubject = subject       || (emailCtx?.subject ? `Re: ${emailCtx.subject}` : 'Antwoord');

  if (!recipientTo) throw new Error('Ontvanger (to) kan niet worden bepaald — geef to mee of een geldig email_id');

  // Voeg een geciteerd fragment toe als context (eerste 500 tekens van origineel body)
  const bodyCtx = emailCtx?.body_text?.slice(0, 500) || emailCtx?.snippet?.slice(0, 300) || null;
  const finalBody = bodyCtx
    ? `${body}\n\n---\n${bodyCtx.split('\n').slice(0, 5).map(l => '> ' + l).join('\n')}`
    : body;

  const r = await fetch(`${getBaseUrl()}/api/send-email`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      from_mailbox: fromMailbox,
      to:           recipientTo,
      subject:      replySubject,
      text:         finalBody,
      email_id:     email_id ? String(email_id) : undefined,
    }),
  });
  const result = await r.json();
  if (!r.ok || result.error) throw new Error(result.error || `send-email HTTP ${r.status}`);
  return { ok: true, sent_at: new Date().toISOString(), to: recipientTo, subject: replySubject };
}

async function executeScheduleEmailFollowup({ email_id, delay_hours = 24, reminder_text } = {}) {
  const deadline = new Date(Date.now() + (Number(delay_hours) || 24) * 3600000)
    .toISOString().split('T')[0];
  const taskId = crypto.randomUUID();
  const { error } = await supabaseAdmin.from('taken_items').insert({
    id:               taskId,
    titel:            reminder_text || `Follow-up email #${email_id}`,
    prioriteit:       'Normaal',
    status:           'todo',
    assigned_to_id:   null,
    source_meeting_id: null,
    categorie:        'Mail follow-up',
    deadline,
    aangemaakt:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  });
  if (error) throw new Error(`taken_items insert fout: ${error.message}`);
  return { ok: true, task_id: taskId, deadline, email_id };
}

// ── C3 Aron tools ─────────────────────────────────────────────────────────

// Read-only — geen approval nodig, wordt direct aangeroepen via agent-tools.execute()
export async function executeIdentifyPaymentConcerns({ since_days = 14, include_replied = false } = {}) {
  const since = new Date(Date.now() - Number(since_days) * 86400000).toISOString();
  const { data: emails, error } = await supabase.from('email_messages')
    .select('id, from_address, from_name, subject, date_received, category_confidence')
    .eq('category', 'Factuurvraag')
    .gte('date_received', since)
    .order('date_received', { ascending: false });
  if (error) throw new Error(`email_messages query fout: ${error.message}`);

  const { data: replied } = await supabase.from('email_replies').select('email_id');
  const repliedIds = new Set((replied || []).map(r => String(r.email_id)));

  const results = (emails || [])
    .filter(e => include_replied || !repliedIds.has(String(e.id)))
    .map(e => ({
      email_id:     e.id,
      sender:       e.from_address,
      name:         e.from_name,
      subject:      e.subject,
      received_at:  e.date_received,
      urgency_score: e.category_confidence,
    }));

  // Audit als read-actie
  await logAuditEntry({ agent_name: 'Aron', action: 'identify_payment_concerns',
    payload: { since_days, include_replied }, result: { count: results.length }, status: 'success', triggered_by: 'agent' });

  return { emails: results, count: results.length, disclaimer: 'Gebaseerd op email-categorisering, NIET op Mollie-factuurdata.' };
}

async function executeDraftPaymentReminder({ email_ids = [], tone = 'friendly', custom_note } = {}) {
  if (!email_ids.length) throw new Error('email_ids mag niet leeg zijn');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY niet geconfigureerd');

  const concepts = [];
  for (const email_id of email_ids.slice(0, 10)) {
    const { data: email } = await supabase.from('email_messages')
      .select('from_address, from_name, subject, date_received, snippet, body_text').eq('id', Number(email_id)).maybeSingle();
    if (!email) { console.warn(`[draft_payment_reminder] email ${email_id} niet gevonden`); continue; }

    const toneLabel = tone === 'friendly' ? 'vriendelijke' : tone === 'firm' ? 'zakelijke' : 'dringende';
    const bodyContext = email.body_text?.slice(0, 200) || email.snippet?.slice(0, 200) || 'geen';
    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 400,
        system: 'Je schrijft zakelijke emails in het Nederlands namens De Forex Opleiding. Wees beknopt en professioneel.',
        messages: [{ role: 'user', content:
          `Schrijf een ${toneLabel} betalingsherinnering voor de volgende factuurvraag:\n` +
          `Van: ${email.from_name || email.from_address}\n` +
          `Onderwerp: ${email.subject}\n` +
          `Ontvangen: ${email.date_received?.split('T')[0]}\n` +
          `Context: ${bodyContext}\n` +
          (custom_note ? `Extra instructie: ${custom_note}\n` : '') +
          `\nMax 3 alinea's. Begin met de aanhef.`,
        }],
      }),
    });
    const cData = await claudeResp.json();
    const concept_text = cData.content?.[0]?.text || '(generatie mislukt)';
    concepts.push({ email_id, sender: email.from_address, name: email.from_name, subject: email.subject, concept_text, tone });
  }

  if (!concepts.length) throw new Error('Geen concepten gegenereerd — emails niet gevonden');
  return { concepts, count: concepts.length, disclaimer: 'Gebaseerd op email-categorisering, NIET op werkelijke openstaande facturen.' };
}

async function executeMarkInvoiceFollowup({ email_id, followup_date, notes } = {}) {
  if (!email_id) throw new Error('email_id is verplicht voor mark_invoice_followup');
  const taskId = crypto.randomUUID();
  const { error } = await supabaseAdmin.from('taken_items').insert({
    id:               taskId,
    titel:            `Factuur follow-up #${email_id}${notes ? ': ' + notes.slice(0, 100) : ''}`,
    prioriteit:       'Hoog',
    status:           'todo',
    assigned_to_id:   null,
    source_meeting_id: null,
    categorie:        'Factuur follow-up',
    deadline:         followup_date || null,
    aangemaakt:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
  });
  if (error) throw new Error(`taken_items insert fout: ${error.message}`);
  return { ok: true, task_id: taskId, email_id, followup_date };
}

// ── C3 Leon tools ─────────────────────────────────────────────────────────

async function executeCreateTaskForContract({ contract_subject, related_email_id, task_title, deadline, assignee_name, notes } = {}) {
  if (!task_title) throw new Error('task_title is verplicht voor create_task_for_contract');
  const assignee = assignee_name ? await resolveAssigneeLocal(assignee_name) : null;
  const taskId   = crypto.randomUUID();
  const now      = new Date().toISOString();

  const { error: taskErr } = await supabaseAdmin.from('taken_items').insert({
    id:                taskId,
    titel:             task_title,
    omschrijving:      notes || contract_subject || null,
    prioriteit:        'Normaal',
    status:            'todo',
    assigned_to_id:    toUuidOrNull(assignee?.id),
    source_meeting_id: null,
    categorie:         'Contract',
    deadline:          deadline || null,
    aangemaakt:        now,
    updated_at:        now,
  });
  if (taskErr) throw new Error(`taken_items insert fout: ${taskErr.message}`);

  if (assignee && assignee.type !== 'agent') {
    const { error: asgErr } = await supabaseAdmin.from('taken_assignees').insert({
      task_id:       taskId,
      assignee_type: assignee.type,
      assignee_id:   String(assignee.id),
      assignee_name: assignee.name,
    });
    if (asgErr) console.error('[create_task_for_contract] taken_assignees fout:', asgErr.message);
  }

  return { ok: true, task_id: taskId, task_title, assignee: assignee?.name || null };
}

async function executeUpdateTaskStatus({ task_id, new_status, notes } = {}) {
  if (!task_id || !new_status) throw new Error('task_id en new_status zijn verplicht voor update_task_status');
  const { error } = await supabaseAdmin.from('taken_items')
    .update({ status: new_status, updated_at: new Date().toISOString() })
    .eq('id', task_id);
  if (error) throw new Error(`taken_items update fout: ${error.message}`);
  return { ok: true, task_id, new_status, notes: notes || null };
}

// Uitvoering van één bulk-categorisatie item (na approval)
async function executeApplyCategoryCorrection({ email_id, suggested_cat, reason } = {}) {
  if (!email_id || !suggested_cat) throw new Error('email_id en suggested_cat zijn verplicht');
  const { error } = await supabase.from('email_messages')
    .update({ category: suggested_cat }).eq('id', Number(email_id));
  if (error) throw new Error(`email_messages update fout: ${error.message}`);
  return { ok: true, email_id, new_category: suggested_cat, reason: reason || null };
}
