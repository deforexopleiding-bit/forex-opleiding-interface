// api/_lib/onboarding-agent-core.js
//
// Pure core voor de Onboarding-agent (Fase A). Sibling van
// simone-suggest-core.js + joost-suggest-core.js — zelfde shape
// ({ status, body }-return + Anthropic tool-use pattern), maar
// onboarding-specifieke context-build i.p.v. events/finance.
//
// Persist naar joost_suggestions met module='onboarding'.
// Config-bron: joost_config WHERE module='onboarding'.
//
// Signature (1-op-1 spiegel van runSimoneSuggest):
//   runOnboardingSuggest({
//     supabase, conversationId, triggeredByMessageId,
//     autoTriggered, requestedByUserId, clientIp,
//   }) → Promise<{ status: number, body: object }>
//
// Status-semantiek:
//   200  { suggestion: {...} }                 succes
//   404  { error }                             conversation niet gevonden
//   422  { error, resolved_module }            conv hoort niet bij onboarding-lijn
//   429  { error, retry_after_seconds, ... }   rate-limit (30s/conv)
//   502  { error, details? }                   Anthropic API-fout
//   503  { error, module? }                    config-/key-issue
//
// Phone→customer match: zelfde strategie als inbox-conversation-context.js
// — strip naar digits, exact-match, fallback last-9.
//
// Handoff: server-side bepaling van needs_human:
//   intent === 'escalation_needed'  OR
//   confidence < (autonomy_config.handoff_threshold ?? 0.55).
// needs_human + would_auto_send worden in context_snapshot gezet zodat de
// inbox-UI én een latere autonomous-send-pipeline ernaar kunnen kijken
// (geen schema-wijziging in Fase A).
//
// Auto-send: in deze Fase A NIET in dit core-bestand uitgevoerd. We
// markeren only would_auto_send in de context-snapshot. Een latere Fase B
// (api/onboarding-send-autonomous of equivalent) leest die vlag en doet
// de feitelijke send via de bestaande meta-whatsapp helpers.

import { getModuleContextByPhoneNumberId } from './module-context.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 30 * 1000;
const MAX_TOKENS           = 1024;

const DEFAULT_HANDOFF_THRESHOLD   = 0.55;
const DEFAULT_AUTO_SEND_THRESHOLD = 0.80;

const DETECTED_INTENTS_ONBOARDING = [
  'wizard_help',         // vraag over de vragenlijst / wizard / waar klikken
  'access_login',        // wachtwoord / inloggen / mail niet ontvangen
  'community_question',  // Discord / WhatsApp / community-vragen
  'content_question',    // vraag over inhoud / modules / waar vind ik X
  'mentor_contact',      // vraag voor / over mentor / wanneer eerste call
  'logistics',           // praktische vraag (betaling / facturen / planning)
  'escalation_needed',   // klacht / juridisch / refund / boos — mens nodig
  'general_question',
  'other',
];

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

function customerDisplayName(c, fallback = 'de student') {
  if (!c) return fallback;
  if (c.is_company && c.company_name) return String(c.company_name).trim() || fallback;
  const fn = String(c.first_name || '').trim();
  const ln = String(c.last_name  || '').trim();
  const full = `${fn} ${ln}`.trim();
  return full || c.email || fallback;
}

function fmtDateNL(iso) {
  if (!iso) return '?';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '?';
    return d.toISOString().slice(0, 10);
  } catch (_e) { return '?'; }
}

// Anthropic tool — forceert JSON-output via structured tool_use.
const ONBOARDING_TOOL = {
  name: 'onboarding_response',
  description:
    'Lever het antwoord voor deze student-WhatsApp in de onboarding-fase. Vul alle velden volledig in.',
  input_schema: {
    type: 'object',
    properties: {
      suggested_reply: {
        type: 'string',
        description:
          'De voorgestelde Nederlandse antwoord-tekst die de medewerker (of de agent autonoom) kan versturen. Compact, max 3-4 zinnen, vriendelijk-professioneel.',
      },
      detected_intent: {
        type: 'string',
        enum: DETECTED_INTENTS_ONBOARDING,
        description:
          'Het intent van de laatste klant-message. wizard_help = vraag over de vragenlijst / wat invullen / waar klikken; access_login = inlog/wachtwoord/mail niet ontvangen; community_question = Discord/WhatsApp/community; content_question = vraag over cursusinhoud/module/materiaal; mentor_contact = wanneer mentor belt of contact opneemt; logistics = betaling/facturen/planning; escalation_needed = klacht/juridisch/refund — mens nodig; general_question / other.',
      },
      confidence: {
        type: 'number',
        description: 'Zekerheid over je classificatie + antwoord. 0.0 = onzeker, 1.0 = zeer zeker.',
      },
      reasoning: {
        type: 'string',
        description: 'Korte uitleg (1-2 zinnen) waarom je dit intent + antwoord hebt gekozen. Voor audit en latere eval.',
      },
    },
    required: ['suggested_reply', 'detected_intent', 'confidence', 'reasoning'],
  },
};

// Customers-fetch + phone-match. Sibling van simone's
// matchAttendeesByPhone — over-fetch met phone NOT NULL is acceptabel
// (< 5k customers; MVP). Exact-match eerst, fallback last-9.
async function matchCustomersByPhone(supabase, phoneNumber) {
  const target = normalizePhone(phoneNumber);
  if (!target) return [];
  const { data: rows, error } = await supabase
    .from('customers')
    .select('id, is_company, company_name, first_name, last_name, email, phone, created_at')
    .not('phone', 'is', null);
  if (error) {
    console.error('[onboarding-agent-core] customers fetch fail:', error.message);
    return [];
  }
  const normalized = (rows || [])
    .map(r => ({ ...r, _digits: normalizePhone(r.phone) }))
    .filter(r => r._digits);

  const exact = normalized.filter(r => r._digits === target);
  if (exact.length > 0) return exact;
  if (target.length >= 9) {
    const tail = target.slice(-9);
    return normalized.filter(r => r._digits.slice(-9) === tail);
  }
  return [];
}

// Onboardings + traject ophalen voor een set customer-ids. Hoofd-doel
// is om de huidige status, wizard-voortgang, traject-type en provisioning-
// status mee te geven aan de LLM. Sorteer nieuwste eerst zodat de
// EERSTE rij de actuele onboarding is (de oudere rijen zijn gearchiveerd
// of historie).
async function fetchOnboardingsByCustomers(supabase, customerIds) {
  if (!customerIds || customerIds.length === 0) return [];
  const { data, error } = await supabase
    .from('onboardings')
    .select(
      'id, customer_id, status, current_step, token, ' +
      'started_at, completed_at, archived_at, created_at, ' +
      'bubble_provisioned, ' +
      'traject:onboarding_trajecten(label, type, duur_maanden, calls)'
    )
    .in('customer_id', customerIds)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('[onboarding-agent-core] onboardings fetch fail:', error.message);
    return [];
  }
  return data || [];
}

export async function runOnboardingSuggest({
  supabase,
  conversationId,
  triggeredByMessageId,
  autoTriggered,
  requestedByUserId,
  clientIp,
}) {
  // ========================================================================
  // STAP 1: Rate-limit (max 1 suggestie per 30 sec per conv)
  // ========================================================================
  const { data: recentSugg, error: rateErr } = await supabase
    .from('joost_suggestions')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateErr) {
    console.error('[onboarding-agent-core] rate-limit select error:', rateErr.message);
  } else if (recentSugg && recentSugg.created_at) {
    const lastMs = new Date(recentSugg.created_at).getTime();
    if (Number.isFinite(lastMs)) {
      const ageSeconds = (Date.now() - lastMs) / 1000;
      const windowSeconds = RATE_LIMIT_WINDOW_MS / 1000;
      if (ageSeconds < windowSeconds) {
        const retryAfter = Math.max(1, Math.ceil(windowSeconds - ageSeconds));
        return {
          status: 429,
          body: {
            error: 'rate_limit',
            message: 'Wacht 30 seconden voor je een nieuwe suggestie vraagt',
            retry_after_seconds: retryAfter,
            previous_suggestion_id: recentSugg.id,
            previous_created_at:    recentSugg.created_at,
          },
        };
      }
    }
  }

  // ========================================================================
  // STAP 2: Conversation + module-resolve + config
  // ========================================================================
  const { data: conv, error: convErr } = await supabase
    .from('whatsapp_conversations')
    .select('id, phone_number, phone_number_id, customer_id, last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error('conversation lookup: ' + convErr.message);
  if (!conv) return { status: 404, body: { error: 'Conversation niet gevonden' } };

  // Onboarding-agent opereert ALLEEN op onboarding-conversations (gespiegeld
  // aan Simone's events-only guard). Voorkomt dat een finance/events-conv
  // hier per ongeluk binnenkomt door een misgerouteerde caller.
  const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
  if (moduleCtx?.module !== 'onboarding') {
    return {
      status: 422,
      body: {
        error: 'conversation_module_mismatch',
        message: 'Onboarding-agent is alleen beschikbaar voor onboarding-conversations.',
        resolved_module: moduleCtx?.module || null,
      },
    };
  }

  const { data: cfg, error: cfgErr } = await supabase
    .from('joost_config')
    .select(
      'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
      'model, temperature, context_message_count, is_enabled, ' +
      'autonomy_config, feature_flags'
    )
    .eq('module', 'onboarding')
    .maybeSingle();
  if (cfgErr) throw new Error('joost_config (onboarding) lookup: ' + cfgErr.message);
  if (!cfg) {
    return {
      status: 503,
      body: {
        error: 'Onboarding-agent is nog niet geconfigureerd. Maak eerst een joost_config-rij aan voor module=onboarding.',
      },
    };
  }
  if (cfg.is_enabled === false) {
    return {
      status: 503,
      body: { error: 'Onboarding-agent is gedeactiveerd voor module onboarding', module: 'onboarding' },
    };
  }

  // ========================================================================
  // STAP 3: ONBOARDING-CONTEXT BUILD (phone → customers → onboardings)
  // ========================================================================
  const nowMs = Date.now();
  const windowOpen = conv.last_inbound_at
    ? (nowMs - new Date(conv.last_inbound_at).getTime()) <= TWENTY_FOUR_HOURS_MS
    : false;

  // Phone-match: customers.phone (NIET event_attendees). conv.customer_id
  // wint indien al gezet — voorkomt onnodige over-fetch.
  let matchedCustomers = [];
  if (conv.customer_id) {
    const { data: cust, error: cErr } = await supabase
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone, created_at')
      .eq('id', conv.customer_id)
      .maybeSingle();
    if (cErr) console.error('[onboarding-agent-core] direct customer lookup:', cErr.message);
    else if (cust) matchedCustomers = [cust];
  } else {
    matchedCustomers = await matchCustomersByPhone(supabase, conv.phone_number);
  }

  const customerIds = matchedCustomers.map(c => c.id);
  const onboardings = await fetchOnboardingsByCustomers(supabase, customerIds);

  const studentName = customerDisplayName(matchedCustomers[0], 'de student');

  // De PRIMARY onboarding = nieuwste, niet-gearchiveerd. Fallback: nieuwste
  // van alles (zelfs gearchiveerd) zodat er nog steeds context is.
  const primary = onboardings.find(o => o.status !== 'gearchiveerd') || onboardings[0] || null;

  // Recent messages (N = config.context_message_count, default 10)
  const n = Math.max(5, Math.min(50, Number(cfg.context_message_count) || 10));
  const { data: msgRows, error: msgErr } = await supabase
    .from('whatsapp_messages')
    .select('id, direction, body, created_at, template_name')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(n);
  if (msgErr) console.error('[onboarding-agent-core] messages lookup:', msgErr.message);
  const recentMessages = (msgRows || [])
    .slice()
    .reverse()
    .filter(m => typeof m.body === 'string' && m.body.trim().length > 0);

  const afdeling = {
    naam:           moduleCtx?.display_label || 'Onboarding',
    ondertekenaar:  moduleCtx?.afdeling_ondertekenaar || '',
    telefoon:       moduleCtx?.afdeling_telefoon || '',
    whatsapp:       moduleCtx?.afdeling_whatsapp || '',
    email:          moduleCtx?.afdeling_email || '',
  };
  const bedrijf = { naam: process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.' };

  const lastInbound = [...recentMessages].reverse().find(m => m.direction === 'in');

  const contextSnapshot = {
    conversation: {
      id:                conv.id,
      phone_number:      conv.phone_number || null,
      last_inbound_at:   conv.last_inbound_at || null,
      window_open:       windowOpen,
      last_inbound_body: lastInbound ? String(lastInbound.body).slice(0, 1000) : null,
    },
    student: {
      name:               studentName,
      matched_customer_id: matchedCustomers[0]?.id || null,
      matched_count:       matchedCustomers.length,
      email:               matchedCustomers[0]?.email || null,
    },
    onboarding: primary ? {
      id:                 primary.id,
      status:             primary.status,
      current_step:       primary.current_step,
      started_at:         primary.started_at,
      completed_at:       primary.completed_at,
      archived_at:        primary.archived_at,
      created_at:         primary.created_at,
      bubble_provisioned: primary.bubble_provisioned === true,
      traject_label:      primary.traject?.label  || null,
      traject_type:       primary.traject?.type   || null,
      traject_duur:       primary.traject?.duur_maanden || null,
      traject_calls:      primary.traject?.calls  || null,
    } : null,
    other_onboardings_count: Math.max(0, onboardings.length - (primary ? 1 : 0)),
    afdeling,
    bedrijf,
    recent_messages: recentMessages.map(m => ({
      direction:  m.direction,
      body:       m.body,
      created_at: m.created_at,
    })),
    generated_at: new Date().toISOString(),
  };

  // ========================================================================
  // STAP 4: System-prompt renderen
  // ========================================================================
  let systemPrompt = String(cfg.system_prompt_template || '');
  systemPrompt = systemPrompt
    .replace(/\{student_naam\}/g,        studentName)
    .replace(/\{onboarding_status\}/g,   primary?.status         || 'onbekend')
    .replace(/\{traject_label\}/g,       primary?.traject?.label || 'onbekend')
    .replace(/\{traject_type\}/g,        primary?.traject?.type  || 'onbekend')
    .replace(/\{wizard_stap\}/g,         (primary?.current_step != null) ? String(primary.current_step) : 'onbekend');

  const ctxLines = [];
  ctxLines.push('---');
  ctxLines.push('CONTEXT (server-side opgehaald):');
  if (matchedCustomers.length === 0) {
    ctxLines.push('Student: ' + studentName + ' (GEEN customer-match op telefoonnummer).');
    ctxLines.push('Antwoord als algemene onboarding-assistent; doe geen aannames over status of traject.');
  } else {
    ctxLines.push('Student: ' + studentName);
    if (matchedCustomers[0]?.email) ctxLines.push('E-mail: ' + matchedCustomers[0].email);
    if (matchedCustomers.length > 1) {
      ctxLines.push(`LET OP: ${matchedCustomers.length} mogelijke customer-matches op dit nummer — neem de meest waarschijnlijke.`);
    }
  }
  ctxLines.push('');
  if (primary) {
    ctxLines.push('Actuele onboarding:');
    ctxLines.push(`  - Traject: ${primary.traject?.label || '?'} (type=${primary.traject?.type || '?'}, ${primary.traject?.duur_maanden || '?'} mnd, ${primary.traject?.calls || '?'} calls)`);
    ctxLines.push(`  - Status: ${primary.status} (current_step=${primary.current_step || '-'})`);
    ctxLines.push(`  - Aangemeld: ${fmtDateNL(primary.created_at)}`);
    if (primary.started_at)   ctxLines.push(`  - Gestart: ${fmtDateNL(primary.started_at)}`);
    if (primary.completed_at) ctxLines.push(`  - Afgerond: ${fmtDateNL(primary.completed_at)}`);
    if (primary.archived_at)  ctxLines.push(`  - Gearchiveerd: ${fmtDateNL(primary.archived_at)}`);
    ctxLines.push(`  - Bubble-account aangemaakt: ${primary.bubble_provisioned ? 'ja' : 'nee'}`);
    if (contextSnapshot.other_onboardings_count > 0) {
      ctxLines.push(`  - Aantal andere/historische onboardings: ${contextSnapshot.other_onboardings_count}`);
    }
  } else if (matchedCustomers.length > 0) {
    ctxLines.push('Student is gekoppeld aan een customer maar heeft GEEN actieve onboarding.');
  }
  ctxLines.push('');
  ctxLines.push(`Afdeling: ${afdeling.naam}`);
  if (afdeling.ondertekenaar) ctxLines.push(`Ondertekenaar: ${afdeling.ondertekenaar}`);
  ctxLines.push(`Bedrijf: ${bedrijf.naam}`);
  ctxLines.push(`Conversatie-window: ${windowOpen ? 'open (24h)' : 'gesloten'}`);

  // Knowledge-base (vrije jsonb in joost_config)
  const kb = cfg.knowledge_base && typeof cfg.knowledge_base === 'object' ? cfg.knowledge_base : {};
  const kbKeys = Object.keys(kb);
  if (kbKeys.length > 0) {
    ctxLines.push('');
    ctxLines.push('Module-kennis:');
    for (const k of kbKeys) {
      const v = kb[k];
      if (v == null) continue;
      const vs = typeof v === 'string' ? v : JSON.stringify(v);
      ctxLines.push(`  - ${k}: ${vs}`);
    }
  }
  ctxLines.push('---');
  ctxLines.push('BELANGRIJK:');
  ctxLines.push('- Doe geen harde toezeggingen over levertijden, terugbetalingen of contractwijzigingen.');
  ctxLines.push('- Bij klacht / juridisch / refund: verwijs naar een medewerker (escalation_needed).');
  ctxLines.push('- Bij twijfel of als de context onvoldoende is: stel een verduidelijkende vraag.');
  ctxLines.push('---');

  const fullSystemPrompt = `${systemPrompt}\n\n${ctxLines.join('\n')}`;

  // ========================================================================
  // STAP 5: Messages-array voor Anthropic (oudste → nieuwste)
  // ========================================================================
  const anthropicMessages = [];
  for (const m of recentMessages) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const text = String(m.body || '').trim();
    if (!text) continue;
    anthropicMessages.push({ role, content: text });
  }
  if (anthropicMessages.length === 0) {
    anthropicMessages.push({
      role: 'user',
      content: '[Geen recente berichten beschikbaar — geef een open vraag terug.]',
    });
  } else if (anthropicMessages[anthropicMessages.length - 1].role === 'assistant') {
    anthropicMessages.push({
      role: 'user',
      content: '[De medewerker vraagt om een vervolg-suggestie.]',
    });
  }

  // ========================================================================
  // STAP 6: Anthropic call (structured output via tool_use + tool_choice)
  // ========================================================================
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: 503,
      body: { error: 'ANTHROPIC_API_KEY niet geconfigureerd. Vraag aan super_admin.' },
    };
  }

  const requestBody = {
    model:       cfg.model || 'claude-sonnet-4-6',
    max_tokens:  MAX_TOKENS,
    temperature: clamp01(cfg.temperature ?? 0.3),
    system:      fullSystemPrompt,
    messages:    anthropicMessages,
    tools:       [ONBOARDING_TOOL],
    tool_choice: { type: 'tool', name: 'onboarding_response' },
  };

  let claudeResp;
  try {
    claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (e) {
    console.error('[onboarding-agent-core] Anthropic fetch failed:', e.message);
    return { status: 502, body: { error: 'Anthropic API onbereikbaar: ' + e.message } };
  }

  if (claudeResp.status === 429) {
    const txt = await claudeResp.text().catch(() => '');
    console.error('[onboarding-agent-core] Anthropic 429:', txt.slice(0, 500));
    return {
      status: 429,
      body: { error: 'Anthropic rate-limit bereikt. Probeer opnieuw over een minuut.' },
    };
  }
  if (!claudeResp.ok) {
    const txt = await claudeResp.text().catch(() => '');
    console.error(`[onboarding-agent-core] Anthropic ${claudeResp.status}:`, txt.slice(0, 500));
    return {
      status: 502,
      body: { error: `Anthropic API-fout (${claudeResp.status})`, details: txt.slice(0, 500) },
    };
  }

  const claudeData = await claudeResp.json();
  const toolUseBlock = (claudeData.content || []).find(
    b => b.type === 'tool_use' && b.name === 'onboarding_response'
  );
  if (!toolUseBlock || !toolUseBlock.input) {
    console.error('[onboarding-agent-core] Geen tool_use block in response:', JSON.stringify(claudeData).slice(0, 500));
    return { status: 502, body: { error: 'Anthropic gaf geen structured response terug' } };
  }

  const toolInput      = toolUseBlock.input;
  const suggestedReply = typeof toolInput.suggested_reply === 'string' ? toolInput.suggested_reply.trim() : '';
  const detectedIntent = DETECTED_INTENTS_ONBOARDING.includes(toolInput.detected_intent)
    ? toolInput.detected_intent : 'other';
  const confidence     = clamp01(toolInput.confidence);
  const reasoning      = typeof toolInput.reasoning === 'string' ? toolInput.reasoning.trim() : '';

  if (!suggestedReply) {
    return { status: 502, body: { error: 'Anthropic gaf een lege suggested_reply terug' } };
  }

  // ========================================================================
  // STAP 7: Server-side handoff + auto-send bepaling
  // ========================================================================
  // autonomy_config / feature_flags zijn jsonb met defaults. We respecteren
  // ze defensief: ontbrekend / niet-numeriek → terug naar default.
  const autonomy = (cfg.autonomy_config && typeof cfg.autonomy_config === 'object') ? cfg.autonomy_config : {};
  const flags    = (cfg.feature_flags    && typeof cfg.feature_flags    === 'object') ? cfg.feature_flags    : {};

  let handoffThreshold = Number(autonomy.handoff_threshold);
  if (!Number.isFinite(handoffThreshold)) handoffThreshold = DEFAULT_HANDOFF_THRESHOLD;
  handoffThreshold = clamp01(handoffThreshold);

  let autoSendThreshold = Number(autonomy.auto_send_threshold);
  if (!Number.isFinite(autoSendThreshold)) autoSendThreshold = DEFAULT_AUTO_SEND_THRESHOLD;
  autoSendThreshold = clamp01(autoSendThreshold);

  const autoSendEnabled = flags.auto_send_enabled === true;

  // Handoff-bepaling: escalation_needed wint altijd; daaronder valt
  // confidence onder de drempel ook in 'human needed'.
  const needsHuman = (detectedIntent === 'escalation_needed')
    || (confidence < handoffThreshold);

  // Auto-send-bepaling. In Fase A wordt deze ALLEEN gerapporteerd; geen
  // feitelijke send vanuit dit core-bestand. Latere autonomous chain
  // (Fase B) leest deze flag uit de context_snapshot.
  const wouldAutoSend = !!autoSendEnabled
    && !needsHuman
    && (confidence >= autoSendThreshold)
    && (detectedIntent !== 'escalation_needed');

  // Verrijk context_snapshot zodat zowel de inbox-UI als een latere
  // autonomous send-pipeline dezelfde bron raadpleegt (geen schema-wijziging).
  contextSnapshot.handoff = {
    needs_human:        needsHuman,
    handoff_threshold:  handoffThreshold,
    auto_send_enabled:  autoSendEnabled,
    auto_send_threshold: autoSendThreshold,
    would_auto_send:    wouldAutoSend,
    decision_reason:    detectedIntent === 'escalation_needed'
      ? 'intent=escalation_needed'
      : (confidence < handoffThreshold
          ? `confidence ${confidence.toFixed(2)} < handoff_threshold ${handoffThreshold.toFixed(2)}`
          : (wouldAutoSend ? 'auto_send eligible' : 'suggest_only')),
  };

  // ========================================================================
  // STAP 8: Save suggestion — module='onboarding'
  // ========================================================================
  const insertRow = {
    conversation_id:          conversationId,
    triggered_by_message_id:  triggeredByMessageId || null,
    module:                   'onboarding',
    suggested_reply:          suggestedReply,
    detected_intent:          detectedIntent,
    confidence,
    reasoning,
    context_snapshot:         contextSnapshot,
    status:                   'PROPOSED',
    requested_by_user_id:     requestedByUserId || null,
    auto_triggered:           autoTriggered === true,
  };

  const { data: sugg, error: insErr } = await supabase
    .from('joost_suggestions')
    .insert(insertRow)
    .select('id, conversation_id, suggested_reply, detected_intent, confidence, reasoning, status, created_at')
    .single();
  if (insErr) throw new Error('joost_suggestions insert: ' + insErr.message);

  // Audit-log (fail-soft).
  try {
    await supabase.from('audit_log').insert({
      user_id:     requestedByUserId || null,
      action:      autoTriggered ? 'onboarding.suggestion.auto_generated' : 'onboarding.suggestion.generated',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  {
        suggestion_id:        sugg.id,
        module:               'onboarding',
        model:                requestBody.model,
        temperature:          requestBody.temperature,
        detected_intent:      detectedIntent,
        confidence,
        needs_human:          needsHuman,
        would_auto_send:      wouldAutoSend,
        messages_in_ctx:      anthropicMessages.length,
        customer_match_count: matchedCustomers.length,
        primary_onboarding_id: primary?.id || null,
        auto_triggered:       autoTriggered === true,
        triggered_by:         autoTriggered ? 'inbox_webhook' : 'user_click',
      },
      reason_text: lastInbound ? String(lastInbound.body).slice(0, 500) : null,
      ip_address:  clientIp || null,
    });
  } catch (e) {
    console.error('[onboarding-agent-core audit]', e.message);
  }

  // ========================================================================
  // STAP 9: Response
  // ========================================================================
  return {
    status: 200,
    body: {
      suggestion: {
        id:              sugg.id,
        suggested_reply: sugg.suggested_reply,
        detected_intent: sugg.detected_intent,
        confidence:      sugg.confidence,
        reasoning:       sugg.reasoning,
        needs_human:     needsHuman,
        would_auto_send: wouldAutoSend,
        created_at:      sugg.created_at,
      },
    },
  };
}
