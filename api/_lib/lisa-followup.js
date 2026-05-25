// api/_lib/lisa-followup.js
// Follow-up logica voor Lisa: stop-detectie, sequence-validatie, scheduling.
// Gebruikt door lisa-config.js (validatie), lisa-ghl-webhook.js (stop + schedule) en de cron (F7.3).

import { supabaseAdmin } from '../supabase.js';
import Anthropic from '@anthropic-ai/sdk';

const FOLLOWUP_MODEL = 'claude-sonnet-4-6'; // sneller/goedkoper dan Opus voor follow-ups

// Hardcoded NL stop-keywords (baseline; altijd actief naast configureerbare uitbreiding).
const HARDCODED_STOP_KEYWORDS = [
  'stop', 'geen interesse', 'niet meer', 'ophouden', 'kapt ermee',
  'laat me met rust', 'mag je verwijderen', 'niet geinteresseerd', 'niet geïnteresseerd',
  'spam', 'leave me alone', 'unsubscribe',
];

const VALID_PHASES = ['intro', 'doel', 'situatie', 'band', 'call', 'qualified', 'disqualified'];

/**
 * Detecteer een stop-signaal in een bericht (hardcoded + configureerbaar, langste match eerst).
 * @returns {{keyword:string, matched_part:string}|null}
 */
export function detectStopSignal(message, configStopKeywords = []) {
  if (!message) return null;
  const text = String(message).toLowerCase().trim();
  const all = [
    ...HARDCODED_STOP_KEYWORDS,
    ...(Array.isArray(configStopKeywords) ? configStopKeywords.map((k) => String(k).toLowerCase()) : []),
  ].filter(Boolean);
  all.sort((a, b) => b.length - a.length);
  for (const kw of all) {
    const i = text.indexOf(kw);
    if (i !== -1) return { keyword: kw, matched_part: text.substring(i, i + kw.length) };
  }
  return null;
}

/**
 * Valideer + normaliseer een follow-up sequence. Max 5 stappen, delay 1-720u, template verplicht.
 * @returns {{valid:Array, errors:Array}}
 */
export function validateFollowupSequence(sequence) {
  if (!Array.isArray(sequence)) return { valid: [], errors: ['sequence is geen array'] };
  const valid = [];
  const errors = [];

  sequence.forEach((step, idx) => {
    const n = idx + 1;
    if (!step || typeof step !== 'object') { errors.push(`Stap ${n}: geen object`); return; }
    const delay = parseInt(step.delay_hours, 10);
    if (isNaN(delay) || delay < 1 || delay > 720) { errors.push(`Stap ${n}: delay_hours moet 1-720 zijn`); return; }
    if (!step.template || typeof step.template !== 'string' || !step.template.trim()) { errors.push(`Stap ${n}: template ontbreekt`); return; }

    const conditions = {};
    if (step.conditions && typeof step.conditions === 'object') {
      if (Array.isArray(step.conditions.phase_in)) conditions.phase_in = step.conditions.phase_in.filter((p) => VALID_PHASES.includes(p));
      if (Array.isArray(step.conditions.phase_not_in)) conditions.phase_not_in = step.conditions.phase_not_in.filter((p) => VALID_PHASES.includes(p));
    }

    valid.push({
      step: valid.length + 1,
      delay_hours: delay,
      template: step.template.trim(),
      conditions: Object.keys(conditions).length ? conditions : null,
      use_ai: step.use_ai === true || step.template.trim().length >= 200,
    });
  });

  if (valid.length > 5) return { valid: valid.slice(0, 5), errors: [...errors, 'Max 5 stappen, overige verwijderd'] };
  return { valid, errors };
}

/** scheduled_for = nu + delay_hours. */
export function computeScheduledFor(delayHours) {
  return new Date(Date.now() + delayHours * 3600 * 1000).toISOString();
}

/** Evalueer fase-condities tegen de huidige conversatie-state. */
export function evaluateConditions(conditions, conversation) {
  if (!conditions) return true;
  const phase = conversation?.phase || 'intro';
  if (Array.isArray(conditions.phase_in) && conditions.phase_in.length && !conditions.phase_in.includes(phase)) return false;
  if (Array.isArray(conditions.phase_not_in) && conditions.phase_not_in.includes(phase)) return false;
  return true;
}

/**
 * Plan de volgende follow-up (fail-safe — gooit nooit). currentStep is 0-based (0 = sequence[0]).
 * @returns {Promise<{scheduled:boolean, reason?:string, followup_id?:string, scheduled_for?:string, error?:string}>}
 */
export async function scheduleNextFollowup({ conversationId, currentStep, config, conversation }) {
  try {
    if (!config?.followup_enabled) return { scheduled: false, reason: 'followup_disabled' };
    const sequence = Array.isArray(config.followup_sequence) ? config.followup_sequence : [];
    if (!sequence.length) return { scheduled: false, reason: 'no_sequence' };
    if (conversation?.followup_paused) return { scheduled: false, reason: 'paused' };
    if (conversation?.qualified || conversation?.call_booked) return { scheduled: false, reason: 'qualified_or_booked' };
    if (conversation?.stop_detected_at) return { scheduled: false, reason: 'stop_detected' };

    const idx = currentStep;
    if (idx >= sequence.length) return { scheduled: false, reason: 'sequence_completed' };
    const step = sequence[idx];
    if (!evaluateConditions(step.conditions, conversation)) return { scheduled: false, reason: 'conditions_not_met' };

    const scheduledFor = computeScheduledFor(step.delay_hours);
    const { data, error } = await supabaseAdmin.from('lisa_followups').insert({
      conversation_id: conversationId,
      followup_step: step.step,
      scheduled_for: scheduledFor,
      status: 'scheduled',
      is_regular_followup: true,
      is_delayed_response: false,
      template_at_schedule: step.template,
      conditions_snapshot: step.conditions,
      used_ai: step.use_ai,
    }).select('id').single();
    if (error) { console.error('[lisa-followup] schedule error:', error.message); return { scheduled: false, error: error.message }; }
    return { scheduled: true, followup_id: data.id, scheduled_for: scheduledFor };
  } catch (err) {
    console.error('[lisa-followup] scheduleNextFollowup exception:', err?.message || err);
    return { scheduled: false, error: err?.message || 'onbekende fout' };
  }
}

/**
 * Genereer een AI-follow-up o.b.v. een template als guidance (Sonnet). Fail-safe.
 * @returns {Promise<{ok:boolean, response?:string, tokens_used?:number, error?:string}>}
 */
export async function generateFollowupResponse({ conversation, template, followupStep }) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'no_api_key' };

    const { data: config } = await supabaseAdmin.from('lisa_config').select('*')
      .eq('is_active', true).order('version', { ascending: false }).limit(1).maybeSingle();
    if (!config) return { ok: false, error: 'no_active_config' };

    const { data: recent } = await supabaseAdmin.from('lisa_messages')
      .select('direction, content, sent_at').eq('conversation_id', conversation.id)
      .order('sent_at', { ascending: false }).limit(6);
    const history = (recent || []).reverse()
      .map((m) => `${m.direction === 'in' ? 'Volger' : 'Lisa'}: ${m.content}`).join('\n');

    const systemPrompt = `Je bent ${config.persona_name || 'Lisa'}${config.persona_age ? ', ' + config.persona_age + ' jaar oud' : ''}.
${config.persona_tone || 'Casual en vriendelijk'}

Je stuurt een FOLLOW-UP bericht naar een volger die niet meer heeft geantwoord.

Template als richtlijn (volg de intentie, maak persoonlijk):
"${template}"

Recent gesprek:
${history || '(geen eerdere berichten)'}

Huidige fase: ${conversation.phase || 'intro'}
Follow-up nummer: ${followupStep}

Schrijf een natuurlijk follow-up bericht dat de intentie van de template volgt, persoonlijk klinkt,
niet pushy/zeurig is, kort blijft (1-2 zinnen) en geen marketingtaal gebruikt.
Antwoord ALLEEN met het bericht zelf (geen "Lisa:" prefix, geen JSON).`;

    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: FOLLOWUP_MODEL, max_tokens: 200, system: systemPrompt,
      messages: [{ role: 'user', content: 'Genereer de follow-up.' }],
    });
    const text = resp.content?.[0]?.text?.trim() || '';
    if (!text) return { ok: false, error: 'empty_response' };
    return { ok: true, response: text, tokens_used: (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0) };
  } catch (err) {
    console.error('[lisa-followup] generateFollowupResponse error:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}

// ── Post-link follow-ups (F13) ────────────────────────────────────────────────
// Detecteer de agenda-link in een (uitgaand) bericht.
export function containsAgendaLink(text) {
  if (!text) return false;
  return /dfocrm\.nl\/agenda/i.test(text) || /agenda-lisa/i.test(text) || /agenda\.deforexopleiding\.nl/i.test(text);
}

// Plan 3 post-link checks (4u/24u/3d, configureerbaar) na het sturen van de agenda-link.
export async function schedulePostLinkFollowups(conversationId, settings) {
  const now = Date.now();
  const h = (v, d) => (Number.isFinite(v) ? v : d);
  const steps = [
    [1, h(settings?.post_link_step1_hours, 4)],
    [2, h(settings?.post_link_step2_hours, 24)],
    [3, h(settings?.post_link_step3_hours, 72)],
  ];
  const rows = steps.map(([step, hours]) => ({
    conversation_id: conversationId, followup_step: 0, post_link_step: step,
    scheduled_for: new Date(now + hours * 3600 * 1000).toISOString(), status: 'scheduled',
    is_post_link_followup: true, is_response_delay: false, is_delayed_response: false, is_regular_followup: false,
    template_used: 'post_link_check_' + step,
  }));
  const { error } = await supabaseAdmin.from('lisa_followups').insert(rows);
  if (error) console.error('[post-link] schedule error:', error.message);
  return !error;
}

// Genereer een korte, oplopend-warmere post-link check (Sonnet). Fail-safe.
export async function generatePostLinkMessage(step, conv, config) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'no_api_key' };
    const naam = conv.contact_name || conv.first_name || 'de volger';
    const persona = `Je bent ${config?.persona_name || 'Lisa'}${config?.persona_age ? ', ' + config.persona_age + ' jaar oud' : ''}. Toon: ${config?.persona_tone || 'vriendelijk en professioneel'}.`;
    const guidance = {
      1: 'STAP 1 (vriendelijke check): kort bericht (max 20 woorden) dat checkt of het lukte om een tijd te kiezen. Niet pushy.',
      2: 'STAP 2 (warmer, ruimte gevend): kort bericht (max 25 woorden), drukvrij, bied hulp aan bij vragen.',
      3: 'STAP 3 (afsluitend, geen druk): kort bericht (max 25 woorden), open uitnodiging om later terug te komen.',
    }[step] || 'Kort, vriendelijk, drukvrij check-bericht (max 25 woorden).';
    const prompt = `${persona}

CONTEXT: je stuurde eerder de agenda-link naar ${naam}, maar die heeft sindsdien niet gereageerd. Dit is post-link follow-up stap ${step} van 3.

${guidance}

Schrijf ALLEEN het bericht zelf — platte tekst zoals een Instagram-DM, geen begroeting, geen handtekening, geen JSON.`;
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({ model: FOLLOWUP_MODEL, max_tokens: 150, messages: [{ role: 'user', content: prompt }] });
    const text = resp.content?.[0]?.text?.trim() || '';
    return text ? { ok: true, response: text } : { ok: false, error: 'empty_response' };
  } catch (err) {
    console.error('[post-link] gen error:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}

// ── Auto-qualify (F14) ────────────────────────────────────────────────────────
// Markeer een conversatie automatisch als qualified bij een trigger:
//   - Lisa stuurt de agenda-link, of
//   - de AI detecteert phase = 'call'.
// Idempotent (skip als al qualified) en respecteert handmatige disqualify.
// Raakt call_booked NIET aan (dat doet alleen de appointment-webhook).
export async function autoQualifyIfTriggered({ conv, aiResponseText, detectedPhase }) {
  if (conv.qualified) return { triggered: false, reason: 'already_qualified' };
  if (conv.phase === 'disqualified') return { triggered: false, reason: 'disqualified' };

  const triggers = [];
  if (containsAgendaLink(aiResponseText)) triggers.push('agenda_link_sent');
  if (detectedPhase === 'call') triggers.push('phase_call_reached');
  if (!triggers.length) return { triggered: false, reason: 'no_trigger' };

  const now = new Date().toISOString();
  await supabaseAdmin.from('lisa_conversations').update({ qualified: true, qualified_at: now }).eq('id', conv.id);

  const labels = { agenda_link_sent: 'agenda-link verstuurd', phase_call_reached: 'Call-fase bereikt' };
  const reasonText = triggers.map((t) => labels[t]).join(' + ');
  await supabaseAdmin.from('lisa_messages').insert({
    conversation_id: conv.id, direction: 'out', content: `✨ AI markeerde als qualified (${reasonText})`,
    ai_generated: false, is_system: true, sent_at: now,
  });
  return { triggered: true, reasons: triggers };
}
