// api/sanne-suggest.js
// POST -> genereer een Sanne-suggestie voor een inbound e-mail.
//
// FASE 2.0 — foundation, shadow-mode:
//   * Sanne detecteert intent, genereert concept-body, evaluateert autonomy-mode.
//   * Schrijft alles naar sanne_suggestions met status PROPOSED.
//   * DOET NIETS naar buiten — geen email_drafts write, geen send.
//   * Feature-flags (sanne_reactive_suggest / auto_draft_save / autonomous_send)
//     zijn allemaal default UIT; engine loopt in shadow zodat Jeffrey via de
//     autonomy_decision-log kan meekijken zonder risico.
//
// Auth-paden (spiegelt Joost-suggest):
//   (a) X-Internal-Token == process.env.INTERNAL_API_TOKEN
//       → system-pad (aangeroepen door sync-emails hook).
//         requested_by_user_id=NULL + auto_triggered=true.
//   (b) Bearer-JWT + email.module.access permission
//       → handmatige "Vraag Sanne"-knop (Fase 2.1+, nog geen UI).
//
// Body (verplicht óf email_id, óf mailbox + imap_uid):
//   { email_id?: uuid, mailbox?: string, imap_uid?: number, auto_triggered?: bool }
//
// Response 200: { suggestion: {...}, skipped: false }
//   OR 200:     { skipped: true, skip_reason: '...', skip_detail: {...} }
//
// Errors:
//   400  invalid body
//   401  no auth
//   403  no permission (user-call)
//   404  email niet gevonden
//   503  Sanne is_enabled=false OF ANTHROPIC_API_KEY ontbreekt
//   502  Anthropic-fout
//   500  onverwachte fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicStructuredOutput, AnthropicClientError } from './_lib/anthropic-client.js';
import { evaluateSanneAutonomy } from './_lib/sanne-autonomy-evaluate.js';
import { sanneSendMail } from './_lib/sanne-send-mail.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// ── Skip-filter constanten ─────────────────────────────────────────────────
const NO_REPLY_RX = /^(no-?reply|donotreply|noreply|mailer-daemon|postmaster|bounce|notification|automated?|do-not-reply)@/i;
const DEFAULT_SKIP_DOMAINS = [
  'mollie.com','teamleader.eu','stripe.com','github.com','vercel.com','supabase.io',
  'meta.com','facebook.com','google.com','sendgrid.net','mailgun.org','amazonses.com',
];
const SKIP_CATEGORIES = new Set(['newsletter','notification','receipt','system','bounce','spam','marketing']);
const INTERNAL_DOMAIN = 'deforexopleiding.nl';
const MIN_BODY_CHARS = 20;
const ANTI_LOOP_WINDOW_SEC = 60;

// ── Skip-log helper ───────────────────────────────────────────────────────
async function logSkip(supabase, { email_id, mailbox, from_address, skip_reason, skip_detail }) {
  try {
    await supabase.from('sanne_skip_log').insert({
      email_id, mailbox, from_address,
      skip_reason, skip_detail: skip_detail || {},
    });
  } catch (e) {
    console.warn('[sanne-suggest] skip-log insert fail:', e?.message);
  }
}

// ── Skip-filter: 7 checks, eerste hit wint ─────────────────────────────────
function evaluateSkipRules({ email, config, autonomy }) {
  const skipDomains = new Set([
    ...DEFAULT_SKIP_DOMAINS,
    ...(Array.isArray(autonomy.skip_domains) ? autonomy.skip_domains : []),
  ].map((d) => String(d).toLowerCase().trim()).filter(Boolean));

  const from = String(email.from_address || '').toLowerCase().trim();
  const fromDomain = from.split('@')[1] || '';
  const bodyText = String(email.body_text || '').trim();
  const cat = String(email.category || '').toLowerCase();

  // 1. Categorie-filter
  if (SKIP_CATEGORIES.has(cat)) return { skip: true, reason: 'category', detail: { category: email.category } };

  // 2. No-reply-afzenders
  if (NO_REPLY_RX.test(from)) return { skip: true, reason: 'no_reply_sender', detail: { from } };

  // 3. Transactionele domeinen (defaults + user-config)
  if (fromDomain && skipDomains.has(fromDomain)) {
    return { skip: true, reason: 'transactional_domain', detail: { domain: fromDomain } };
  }

  // 4. Interne mail
  if (fromDomain === INTERNAL_DOMAIN) {
    return { skip: true, reason: 'internal_sender', detail: { from } };
  }

  // 5. Body te kort (auto-responders, tikfouten)
  if (bodyText.length < MIN_BODY_CHARS) {
    return { skip: true, reason: 'body_too_short', detail: { length: bodyText.length, min: MIN_BODY_CHARS } };
  }

  // 6. Mailbox niet in scope (autonomy_config.mailbox_scope)
  const mailboxScope = Array.isArray(autonomy.mailbox_scope) ? autonomy.mailbox_scope : [];
  if (!mailboxScope.includes(email.mailbox)) {
    return { skip: true, reason: 'mailbox_not_in_scope', detail: { mailbox: email.mailbox, scope: mailboxScope } };
  }

  return { skip: false };
}

// ── Anti-loop check: geen andere sanne_suggestion voor dit email_id ────────
async function alreadySuggested(supabase, emailId) {
  const { data } = await supabase
    .from('sanne_suggestions')
    .select('id').eq('email_id', emailId).limit(1);
  return Array.isArray(data) && data.length > 0;
}

// ── Anti-loop op afzender: outbound email_replies binnen 60s ───────────────
async function recentOutboundToSender(supabase, fromAddress) {
  if (!fromAddress) return false;
  const cutoff = new Date(Date.now() - ANTI_LOOP_WINDOW_SEC * 1000).toISOString();
  const { data } = await supabase
    .from('email_replies')
    .select('id').eq('to_address', fromAddress).gte('sent_at', cutoff).limit(1);
  return Array.isArray(data) && data.length > 0;
}

// ── Config lezen: joost_config module='email' ──────────────────────────────
async function loadSanneConfig(supabase) {
  const { data, error } = await supabase
    .from('joost_config').select('*').eq('module', 'email').maybeSingle();
  if (error) throw new Error('config-load: ' + error.message);
  return data || null;
}

// ── Customer lookup (op from_address) ──────────────────────────────────────
async function lookupCustomer(supabase, fromAddress) {
  if (!fromAddress) return null;
  const { data } = await supabase
    .from('customers')
    .select('id, name, email, phone, status')
    .ilike('email', fromAddress).limit(2);
  if (!Array.isArray(data) || data.length !== 1) return null; // ambiguïteit -> geen match
  return data[0];
}

// ── Sends-today teller (mandate rate-limit) ────────────────────────────────
async function sendsTodayForMailbox(supabase, mailbox) {
  const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
  const { data } = await supabase
    .from('sanne_suggestions')
    .select('id', { count: 'exact', head: true })
    .eq('mailbox', mailbox).eq('status', 'SENT_AUTONOMOUSLY')
    .gte('created_at', startOfDay.toISOString());
  return Number((data && data.length) || 0);
}

// ── LLM: intent + draft in één structured-output call ──────────────────────
const SANNE_TOOL_NAME = 'sanne_email_reply';
const SANNE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    detected_intent: {
      type: 'string',
      enum: [
        'question_general', 'question_pricing', 'question_availability',
        'booking_request', 'onboarding_question',
        'complaint_mild', 'complaint_severe',
        'refund_request', 'payment_dispute', 'legal',
        'escalation', 'partnership', 'thank_you', 'other',
      ],
      description: 'Beste-passende intent voor deze e-mail',
    },
    confidence: {
      type: 'number', minimum: 0, maximum: 1,
      description: 'Hoe zeker ben je dat je een correct antwoord kunt geven, 0.0-1.0',
    },
    reasoning: {
      type: 'string', maxLength: 400,
      description: 'Korte redenering: waarom deze intent, waarom deze confidence',
    },
    draft_subject: {
      type: 'string', minLength: 1, maxLength: 200,
      description: 'Onderwerp van het antwoord (typisch "Re: <origineel>")',
    },
    draft_body_text: {
      type: 'string', minLength: 10, maxLength: 3000,
      description: 'Body als plaintext, Nederlands, 3-6 zinnen tenzij vraag echt uitleg vereist',
    },
    handoff_needed: {
      type: 'boolean',
      description: 'true als je vindt dat een mens moet antwoorden (klacht, juridisch, complexe casus)',
    },
    handoff_reason: {
      type: 'string', maxLength: 200,
      description: 'Als handoff_needed=true: korte reden voor de mens',
    },
  },
  required: ['detected_intent', 'confidence', 'draft_subject', 'draft_body_text', 'handoff_needed'],
};

function renderPersonaSystem(config, email, customer) {
  const tpl = config.system_prompt_template || '';
  return tpl
    .replace(/\{\{company_name\}\}/g,  'De Forex Opleiding NL B.V.')
    .replace(/\{\{from_name\}\}/g,     email.from_name || '')
    .replace(/\{\{from_address\}\}/g,  email.from_address || '')
    .replace(/\{\{received_at\}\}/g,   email.date_received || '')
    .replace(/\{\{subject\}\}/g,       email.subject || '')
    .replace(/\{\{customer_name\}\}/g, customer?.name || '(onbekend)')
    .replace(/\{\{customer_status\}\}/g, customer?.status || '(geen klant-koppeling)');
}

function buildUserMessage(email, customer) {
  const bodySnippet = String(email.body_text || '').slice(0, 4000);
  const parts = [
    'Nieuwe e-mail binnen:',
    '',
    '=== HEADERS ===',
    'Van: ' + (email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address),
    'Aan: ' + email.mailbox + '@deforexopleiding.nl',
    'Onderwerp: ' + email.subject,
    'Datum: ' + email.date_received,
    'Categorie (auto): ' + (email.category || '—'),
    '',
    customer
      ? `=== KLANT-CONTEXT ===\nGekoppeld aan klant: ${customer.name || customer.email} (id=${customer.id})\nStatus: ${customer.status || '—'}`
      : '=== KLANT-CONTEXT ===\nGeen klant-koppeling.',
    '',
    '=== INHOUD ===',
    bodySnippet,
    '',
    'Genereer nu een concept-antwoord in Nederlands, tutoyeer, warm-professioneel. Als je twijfelt: zet handoff_needed=true.',
  ];
  return parts.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth
  const internalTokenHeader = req.headers['x-internal-token'] || req.headers['X-Internal-Token'] || null;
  const expectedInternalToken = process.env.INTERNAL_API_TOKEN || null;
  const isInternalCall = !!(
    internalTokenHeader && expectedInternalToken &&
    typeof internalTokenHeader === 'string' &&
    internalTokenHeader === expectedInternalToken
  );

  let user = null;
  if (!isInternalCall) {
    const userClient = createUserClient(req);
    const { data: { user: u }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !u) return res.status(401).json({ error: 'Niet geauthenticeerd' });
    user = u;
    if (!(await requirePermission(req, 'email.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
    }
  }

  // Body-parse
  const body = req.body || {};
  const emailIdParam = typeof body.email_id === 'string' ? body.email_id.trim() : null;
  const mailboxParam = typeof body.mailbox === 'string' ? body.mailbox.trim() : null;
  const imapUidParam = body.imap_uid != null ? Number(body.imap_uid) : null;
  const autoTriggered = body.auto_triggered === true || isInternalCall;

  if (!emailIdParam && !(mailboxParam && Number.isFinite(imapUidParam))) {
    return res.status(400).json({ error: 'email_id OF (mailbox + imap_uid) verplicht' });
  }
  if (emailIdParam && !isUuid(emailIdParam)) {
    return res.status(400).json({ error: 'email_id moet uuid zijn' });
  }

  try {
    // Config laden
    const config = await loadSanneConfig(supabaseAdmin);
    if (!config) {
      return res.status(503).json({ error: 'Sanne-config ontbreekt — draai migratie 2026-08-15-sanne-fase-2-0-foundation.sql' });
    }
    if (config.is_enabled === false) {
      return res.status(503).json({ error: 'Sanne is uitgeschakeld (is_enabled=false)' });
    }

    // Email ophalen
    const emailQ = supabaseAdmin.from('email_messages')
      .select('id, mailbox, imap_uid, from_address, from_name, subject, date_received, snippet, body_text, category, customer_id')
      .limit(1);
    const { data: emailRows, error: emailErr } = emailIdParam
      ? await emailQ.eq('id', emailIdParam)
      : await emailQ.eq('mailbox', mailboxParam).eq('imap_uid', imapUidParam);
    if (emailErr) throw new Error('email-load: ' + emailErr.message);
    if (!emailRows || emailRows.length === 0) return res.status(404).json({ error: 'E-mail niet gevonden' });
    const email = emailRows[0];

    // Anti-loop: dubbele suggest voor dit email_id?
    if (await alreadySuggested(supabaseAdmin, email.id)) {
      return res.status(200).json({ skipped: true, skip_reason: 'already_suggested', skip_detail: { email_id: email.id } });
    }

    // Anti-loop: recente outbound naar afzender?
    if (await recentOutboundToSender(supabaseAdmin, email.from_address)) {
      await logSkip(supabaseAdmin, { email_id: email.id, mailbox: email.mailbox, from_address: email.from_address,
        skip_reason: 'anti_loop_outbound', skip_detail: { window_sec: ANTI_LOOP_WINDOW_SEC } });
      return res.status(200).json({ skipped: true, skip_reason: 'anti_loop_outbound' });
    }

    // Skip-filter (7 checks)
    const autonomy = config.autonomy_config || {};
    const skipResult = evaluateSkipRules({ email, config, autonomy });
    if (skipResult.skip) {
      await logSkip(supabaseAdmin, { email_id: email.id, mailbox: email.mailbox, from_address: email.from_address,
        skip_reason: skipResult.reason, skip_detail: skipResult.detail });
      return res.status(200).json({ skipped: true, skip_reason: skipResult.reason, skip_detail: skipResult.detail });
    }

    // Customer lookup (fail-soft: bij fout -> null)
    let customer = null;
    if (email.customer_id) {
      const { data } = await supabaseAdmin.from('customers')
        .select('id, name, email, phone, status').eq('id', email.customer_id).maybeSingle();
      customer = data || null;
    }
    if (!customer) {
      try { customer = await lookupCustomer(supabaseAdmin, email.from_address); }
      catch (e) { console.warn('[sanne-suggest] customer lookup:', e?.message); }
    }

    // LLM-call
    const systemPrompt = renderPersonaSystem(config, email, customer);
    const userMsg = buildUserMessage(email, customer);
    let llmOut;
    try {
      llmOut = await anthropicStructuredOutput({
        system:            systemPrompt,
        messages:          [{ role: 'user', content: userMsg }],
        tool_name:         SANNE_TOOL_NAME,
        tool_input_schema: SANNE_TOOL_SCHEMA,
        model:             config.model || 'claude-sonnet-4-6',
        temperature:       typeof config.temperature === 'number' ? config.temperature : 0.3,
        max_tokens:        2048,
      });
    } catch (llmErr) {
      // Log FAILED_LLM row zodat we in de dashboard zien dat Sanne het probeerde maar faalde.
      try {
        await supabaseAdmin.from('sanne_suggestions').insert({
          email_id:            email.id,
          mailbox:             email.mailbox,
          status:              'FAILED_LLM',
          autonomy_decision:   { llm_error: llmErr?.message || String(llmErr), code: llmErr?.code || null },
          auto_triggered:      autoTriggered,
          requested_by_user_id: user ? user.id : null,
        });
      } catch (_) {}
      if (llmErr instanceof AnthropicClientError && llmErr.code === 'ANTHROPIC_KEY_MISSING') {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
      }
      return res.status(502).json({ error: 'Anthropic-fout: ' + (llmErr?.message || 'onbekend') });
    }

    // Suggestion bouwen
    const suggestion = {
      detected_intent: String(llmOut.detected_intent || 'other'),
      confidence:      Number(llmOut.confidence || 0),
      draft_subject:   String(llmOut.draft_subject || (email.subject ? 'Re: ' + email.subject : 'Re: (geen onderwerp)')),
      draft_body_text: String(llmOut.draft_body_text || ''),
      draft_body_html: `<p>${String(llmOut.draft_body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n\n+/g,'</p><p>').replace(/\n/g,'<br>')}</p>`,
      handoff_needed:  !!llmOut.handoff_needed,
      handoff_reason:  llmOut.handoff_reason || null,
      reasoning:       llmOut.reasoning || null,
    };

    // Autonomy-decision berekenen (shadow: allowed=false in Fase 2.0)
    const sendsToday = await sendsTodayForMailbox(supabaseAdmin, email.mailbox);
    const decision = evaluateSanneAutonomy({
      config, suggestion, email, customer, sendsToday, now: new Date(),
    });

    // Status: PROPOSED (default in shadow). Fase 2.1+ zal bij decision.allowed
    // andere statussen zetten (DRAFT_SAVED / SENT_AUTONOMOUSLY).
    let status = 'PROPOSED';
    if (suggestion.handoff_needed) {
      status = 'BLOCKED_INTENT';   // handoff-signaal van LLM
    } else if (decision.block_reason) {
      status = 'BLOCKED_' + decision.block_reason;
      if (!/^BLOCKED_/.test(status)) status = 'BLOCKED_OTHER';
    }

    // Save
    const { data: inserted, error: insertErr } = await supabaseAdmin.from('sanne_suggestions').insert({
      email_id:            email.id,
      mailbox:             email.mailbox,
      detected_intent:     suggestion.detected_intent,
      confidence:          suggestion.confidence,
      draft_subject:       suggestion.draft_subject,
      draft_body_html:     suggestion.draft_body_html,
      draft_body_text:     suggestion.draft_body_text,
      status,
      autonomy_decision:   {
        ...decision,
        llm_reasoning:  suggestion.reasoning,
        handoff:        { needed: suggestion.handoff_needed, reason: suggestion.handoff_reason },
        model_used:     config.model || 'claude-sonnet-4-6',
      },
      auto_triggered:      autoTriggered,
      kb_articles_used:    [],  // Fase 2.0 heeft nog geen kb-tool actief
      tools_used:          [],  // idem
      requested_by_user_id: user ? user.id : null,
    }).select('id, status, detected_intent, confidence, created_at').maybeSingle();

    if (insertErr) throw new Error('suggestion-insert: ' + insertErr.message);

    // ═══════════════════════════════════════════════════════════════════
    // FASE 2.2 / 2.3 / 2.4 — post-insert autonomy actions
    // Alles gedreven door decision.mode + defense-in-depth 2e config-read.
    // Feature-flags default UIT → deze branches worden alleen bereikt als
    // Jeffrey expliciet armt in AI Agents → Sanne.
    // ═══════════════════════════════════════════════════════════════════
    const postActions = await performPostSuggestActions({
      supabase:      supabaseAdmin,
      suggestionId:  inserted?.id,
      email,
      customer,
      suggestion,
      decision,
      user,
      autoTriggered,
    });

    return res.status(200).json({
      skipped: false,
      suggestion: {
        id: inserted?.id,
        status: postActions.finalStatus || inserted?.status || status,
        detected_intent: suggestion.detected_intent,
        confidence: suggestion.confidence,
        draft_subject: suggestion.draft_subject,
        draft_body_text: suggestion.draft_body_text,
        autonomy_decision: decision,
        created_at: inserted?.created_at,
      },
      actions: postActions,
    });
  } catch (e) {
    console.error('[sanne-suggest]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Post-suggest autonomy actions — Fase 2.2 / 2.3 / 2.4
// ═════════════════════════════════════════════════════════════════════════
async function performPostSuggestActions(ctx) {
  const { supabase, suggestionId, email, customer, suggestion, decision, user, autoTriggered } = ctx;
  const actions = { finalStatus: null, draft_id: null, reply_id: null, escalation_id: null, notes: [] };
  if (!suggestionId) { actions.notes.push('no_suggestion_id'); return actions; }

  // ── FASE 2.4 — Escalatie (loopt óók bij shadow) ─────────────────────────
  // Als handoff_needed van LLM, of intent in blocked_intents → maak
  // MANUAL_FOLLOWUP pending_action zodat een mens 'em oppakt.
  const intent = String(suggestion.detected_intent || '').toLowerCase();
  const blockedIntents = (decision?.block_reason === 'INTENT') ||
                         (Array.isArray(decision?.block_detail?.blocked_list)
                          && decision.block_detail.blocked_list.map(String).map((s) => s.toLowerCase()).includes(intent));
  const shouldEscalate = !!suggestion.handoff_needed || blockedIntents;
  if (shouldEscalate) {
    try {
      const { data: pa, error: paErr } = await supabase.from('pending_actions').insert({
        action_type: 'MANUAL_FOLLOWUP',
        customer_id: customer?.id || null,
        payload: {
          source:                'sanne',
          reason:                suggestion.handoff_reason || (blockedIntents ? `intent "${intent}" is geblokkeerd` : 'handoff door LLM'),
          intent:                suggestion.detected_intent,
          confidence:            suggestion.confidence,
          email_id:              email.id,
          mailbox:               email.mailbox,
          imap_uid:              email.imap_uid,
          from_address:          email.from_address,
          subject:               email.subject,
          sanne_suggestion_id:   suggestionId,
          draft_preview:         String(suggestion.draft_body_text || '').slice(0, 500),
        },
        status: 'pending',
      }).select('id').maybeSingle();
      if (paErr) actions.notes.push('escalation_insert_fail: ' + paErr.message);
      else {
        actions.escalation_id = pa?.id || null;
        actions.notes.push('escalation_created');
      }
    } catch (e) {
      actions.notes.push('escalation_threw: ' + (e?.message || 'onbekend'));
    }
  }

  // ── FASE 2.3 — Autonomous send (DEFENSE IN DEPTH: 2e config-read + eval) ─
  if (decision.mode === 'autonomous_send' && decision.allowed) {
    // Herlees VERSE config + herbereken sends-today VLAK vóór send.
    // Voorkomt dat een flag-flip / mailbox-disarm tussen initial suggest en
    // send-moment gemist wordt. Ook: mocht caller state gemuteerd hebben
    // in-memory (getest via unit-mock), verse read is ground truth.
    const { data: freshConfig } = await supabase.from('joost_config')
      .select('*').eq('module', 'email').maybeSingle();
    if (!freshConfig || freshConfig.is_enabled === false) {
      await supabase.from('sanne_suggestions').update({
        status: 'BLOCKED_MODE',
        autonomy_decision: { ...decision, defense_in_depth_block: 'config_disabled' },
      }).eq('id', suggestionId);
      actions.finalStatus = 'BLOCKED_MODE'; actions.notes.push('defense_in_depth: config disabled');
      return actions;
    }
    const freshFlags = freshConfig.feature_flags || {};
    if (freshFlags.sanne_autonomous_send !== true) {
      await supabase.from('sanne_suggestions').update({
        status: 'BLOCKED_MODE',
        autonomy_decision: { ...decision, defense_in_depth_block: 'flag_off_at_send' },
      }).eq('id', suggestionId);
      actions.finalStatus = 'BLOCKED_MODE'; actions.notes.push('defense_in_depth: flag off');
      return actions;
    }
    const freshAuto = freshConfig.autonomy_config || {};
    const armedList = Array.isArray(freshAuto.autonomous_mailboxes) ? freshAuto.autonomous_mailboxes : [];
    if (!armedList.includes(email.mailbox)) {
      await supabase.from('sanne_suggestions').update({
        status: 'BLOCKED_MODE',
        autonomy_decision: { ...decision, defense_in_depth_block: 'mailbox_not_armed_at_send', armed: armedList },
      }).eq('id', suggestionId);
      actions.finalStatus = 'BLOCKED_MODE'; actions.notes.push('defense_in_depth: mailbox not armed');
      return actions;
    }
    // Verse rate-limit + verse evaluate.
    const freshSendsToday = await sendsTodayForMailbox(supabase, email.mailbox);
    const freshDecision = evaluateSanneAutonomy({
      config: freshConfig, suggestion, email, customer,
      sendsToday: freshSendsToday, now: new Date(),
    });
    if (!(freshDecision.mode === 'autonomous_send' && freshDecision.allowed)) {
      const blockStatus = freshDecision.block_reason ? ('BLOCKED_' + freshDecision.block_reason) : 'BLOCKED_MODE';
      await supabase.from('sanne_suggestions').update({
        status: blockStatus,
        autonomy_decision: { ...decision, defense_in_depth_recheck: freshDecision },
      }).eq('id', suggestionId);
      actions.finalStatus = blockStatus;
      actions.notes.push('defense_in_depth: recheck downgraded to ' + freshDecision.mode);
      return actions;
    }

    // Alle gates groen — SEND.
    try {
      const sendResult = await sanneSendMail(supabase, {
        mailbox:       email.mailbox,
        to:            email.from_address,
        subject:       suggestion.draft_subject,
        text:          suggestion.draft_body_text,
        html:          suggestion.draft_body_html,
        sourceEmailId: email.id,
        inReplyToMsgId: email.message_id || null,
      });
      await supabase.from('sanne_suggestions').update({
        status: 'SENT_AUTONOMOUSLY',
        linked_reply_id: sendResult.reply_id,
        autonomy_decision: { ...decision, send_result: {
          messageId: sendResult.messageId, guarded: sendResult.guarded,
          guard_target: sendResult.guard_target, env: sendResult.env,
        } },
      }).eq('id', suggestionId);
      actions.finalStatus = 'SENT_AUTONOMOUSLY';
      actions.reply_id = sendResult.reply_id;
      actions.notes.push('sent: ' + sendResult.messageId + (sendResult.guarded ? ' (guarded)' : ''));
      return actions;
    } catch (sendErr) {
      console.error('[sanne-suggest] autonomous send threw:', sendErr?.message);
      await supabase.from('sanne_suggestions').update({
        status: 'FAILED_INTERNAL',
        autonomy_decision: { ...decision, send_error: sendErr?.message || String(sendErr) },
      }).eq('id', suggestionId);
      actions.finalStatus = 'FAILED_INTERNAL';
      actions.notes.push('send_threw: ' + (sendErr?.message || 'onbekend'));
      return actions;
    }
  }

  // ── FASE 2.2 — Auto-draft save ─────────────────────────────────────────
  if (decision.mode === 'auto_draft_save' && decision.allowed) {
    try {
      const { data: draft, error: draftErr } = await supabase.from('email_drafts').insert({
        user_id:              user ? user.id : null,
        from_mailbox:         email.mailbox + '@deforexopleiding.nl',
        to_address:           email.from_address,
        subject:              suggestion.draft_subject,
        body_html:            suggestion.draft_body_html,
        in_reply_to_email_id: email.id,
        source:               'sanne',
      }).select('id').maybeSingle();
      if (draftErr) {
        actions.notes.push('draft_insert_fail: ' + draftErr.message);
        // Draft-save is optioneel — laat suggestion op PROPOSED staan.
        return actions;
      }
      await supabase.from('sanne_suggestions').update({
        status: 'DRAFT_SAVED',
        linked_draft_id: draft?.id || null,
      }).eq('id', suggestionId);
      actions.finalStatus = 'DRAFT_SAVED';
      actions.draft_id = draft?.id || null;
      actions.notes.push('draft_saved: ' + draft?.id);
      return actions;
    } catch (e) {
      actions.notes.push('draft_threw: ' + (e?.message || 'onbekend'));
      return actions;
    }
  }

  // ── Fase 2.1 (reactive_suggest) — geen extra actie hier; UI leest ─────
  // sanne_suggestions in de reader. Status blijft PROPOSED zolang de user
  // niks doet; outcome-endpoint zet USED/EDITED/DISMISSED bij klik.

  return actions;
}
