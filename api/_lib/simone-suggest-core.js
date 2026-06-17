// api/_lib/simone-suggest-core.js
//
// Pure core voor Simone (events-agent). Sibling van joost-suggest-core.js —
// zelfde shape ({ status, body }-return + Anthropic tool-use pattern), maar
// events-specifieke context-build i.p.v. finance-specifieke open-facturen.
//
// Persist naar joost_suggestions met module='events' (tabel is module-keyed
// per E1.x design; geen aparte simone_suggestions-tabel nodig).
//
// Config-bron: joost_config WHERE module='events' (sibling-pattern; persona,
// system_prompt_template, knowledge_base, model, temperature per module).
//
// Signature:
//   runSimoneSuggest({
//     supabase,            // SupabaseClient (typisch supabaseAdmin)
//     conversationId,      // uuid (caller heeft al gevalideerd)
//     triggeredByMessageId,// uuid|null (caller heeft al gevalideerd)
//     autoTriggered,       // boolean
//     requestedByUserId,   // uuid|null
//     clientIp,            // string|null (voor audit-log; optioneel)
//   }) → Promise<{ status: number, body: object }>
//
// Status-semantiek (caller mapt naar res.status(...)):
//   200  { suggestion: {...} }                  succes
//   404  { error }                              conversation niet gevonden
//   429  { error, retry_after_seconds, ... }    rate-limit (1 suggestie / 30s)
//   502  { error, details? }                    Anthropic API-fout
//   503  { error, module? }                     Simone niet geconfigureerd / disabled / API-key
//
// Onverwachte fouten (DB, JSON-parse) → throw. Caller catcht en 500-mapt.
//
// Phone→attendee match: zelfde strategie als
// api/inbox-conversation-context.js — strip naar digits, exact-match,
// fallback laatste 9 digits. Over-fetch event_attendees met phone NOT NULL
// (acceptabel < 5k attendees; MVP).
//
// NO-MATCH-case: customerOut=null, matchedAttendees=[], events=[]. Simone
// valt terug op general-purpose events-assistent met de kennis uit
// joost_config.knowledge_base.

import { getModuleContextByPhoneNumberId } from './module-context.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 30 * 1000;
const MAX_TOKENS           = 1024;
const MAX_EVENTS_FOR_CONTEXT = 5;

const DETECTED_INTENTS_EVENTS = [
  'event_info',          // vraag over inhoud / programma / niveau
  'date_location',       // vraag over datum / locatie
  'registration_intent', // wil zich inschrijven of meer info voor aanmelden
  'cancel_or_reschedule',// kan niet komen / wil verzetten
  'logistics',           // parkeren / hotel / kleding / route
  'escalation_needed',   // klacht / juridisch / vereist mens
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

// Strip alles behalve cijfers — identiek aan inbox-conversation-context.js
// zodat phone-format-variaties ('+31...', '31...', '0612...') matchen.
function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/\D/g, '');
}

function attendeeDisplayName(a, fallback = 'de prospect') {
  if (!a) return fallback;
  const n = `${(a.first_name || '').trim()} ${(a.last_name || '').trim()}`.trim();
  return n || fallback;
}

function fmtDateNL(iso) {
  if (!iso) return '?';
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '?';
    return d.toISOString().slice(0, 10); // YYYY-MM-DD; geen locale-magie nodig
  } catch (_e) { return '?'; }
}

// Anthropic tool-schema — forceert JSON-output. Identiek pattern als
// JOOST_TOOL in joost-suggest-core.js maar met events-intent enum.
const SIMONE_TOOL = {
  name: 'simone_response',
  description:
    'Lever het Simone-antwoord voor deze prospect-/deelnemer-WhatsApp. Vul alle velden volledig in.',
  input_schema: {
    type: 'object',
    properties: {
      suggested_reply: {
        type: 'string',
        description:
          'De voorgestelde Nederlandse antwoord-tekst die de medewerker kan versturen. Compact, max 3-4 zinnen, vriendelijk-professioneel.',
      },
      detected_intent: {
        type: 'string',
        enum: DETECTED_INTENTS_EVENTS,
        description:
          'Het intent van de laatste klant-message. event_info = vraag over programma/niveau/inhoud; date_location = vraag over datum/locatie; registration_intent = wil zich inschrijven; cancel_or_reschedule = kan niet komen / wil verzetten; logistics = praktische vraag (parkeren / route / kleding / hotel); escalation_needed = klacht of juridisch; general_question = algemene vraag zonder duidelijk events-intent; other = anders.',
      },
      confidence: {
        type: 'number',
        description:
          'Zekerheid over je classificatie + antwoord. 0.0 = onzeker, 1.0 = zeer zeker.',
      },
      reasoning: {
        type: 'string',
        description:
          'Korte uitleg (1-2 zinnen) waarom je dit intent + antwoord hebt gekozen. Voor audit en latere eval.',
      },
    },
    required: ['suggested_reply', 'detected_intent', 'confidence', 'reasoning'],
  },
};

// Match telefoonnummer aan event_attendees. Over-fetch met phone NOT NULL
// en code-side normalizatie + exact-eerst, fallback last-9.
async function matchAttendeesByPhone(supabase, phoneNumber) {
  const target = normalizePhone(phoneNumber);
  if (!target) return [];

  const { data: rows, error } = await supabase
    .from('event_attendees')
    .select(
      'id, event_id, first_name, last_name, email, phone, status, ' +
      'follow_up_flagged, follow_up_reason, ' +
      'registered_at, attended_at, no_show_marked_at, sale_at, ' +
      'created_at, updated_at'
    )
    .not('phone', 'is', null);
  if (error) {
    console.error('[simone-suggest-core] event_attendees fetch fail:', error.message);
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

export async function runSimoneSuggest({
  supabase,
  conversationId,
  triggeredByMessageId,
  autoTriggered,
  requestedByUserId,
  clientIp,
}) {
  // ========================================================================
  // STAP 1: Rate-limit (per conv: max 1 suggestie per 30 sec)
  // ========================================================================
  const { data: recentSugg, error: rateErr } = await supabase
    .from('joost_suggestions')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateErr) {
    console.error('[simone-suggest-core] rate-limit select error:', rateErr.message);
    // Soft-fail.
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
  // STAP 2: Conversation + module-resolve + Simone-config
  // ========================================================================
  const { data: conv, error: convErr } = await supabase
    .from('whatsapp_conversations')
    .select('id, phone_number, phone_number_id, customer_id, last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error('conversation lookup: ' + convErr.message);
  if (!conv) return { status: 404, body: { error: 'Conversation niet gevonden' } };

  // Simone is hard-coded gebonden aan module='events'. We resolven moduleCtx
  // alleen voor afdeling-vars in de prompt; de config-lookup is altijd events.
  //
  // Fase 2 stap 2c hardening: expliciete guard — Simone opereert ALLEEN op
  // events-conversations. Reactieve webhook-pad gaat al door isEventsLijn-gate;
  // manual-knop op events.html werkt alleen op events-conv; finance-conv die
  // per ongeluk doorgegeven wordt → expliciete afwijzing.
  const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
  if (moduleCtx?.module !== 'events') {
    return {
      status: 422,
      body: {
        error: 'conversation_module_mismatch',
        message: 'Simone is alleen beschikbaar voor events-conversations.',
        resolved_module: moduleCtx?.module || null,
      },
    };
  }

  const { data: cfg, error: cfgErr } = await supabase
    .from('joost_config')
    .select(
      // autonomy_config + feature_flags meegelezen zodat een latere
      // autonomous-send-call (api/simone-send-autonomous) en de UI dezelfde
      // bron raadplegen. Suggest-gedrag zelf is ongewijzigd — deze kolommen
      // worden hier niet gebruikt voor de prompt-build.
      'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
      'model, temperature, context_message_count, is_enabled, ' +
      'autonomy_config, feature_flags'
    )
    .eq('module', 'events')
    .maybeSingle();
  if (cfgErr) throw new Error('joost_config (events) lookup: ' + cfgErr.message);
  if (!cfg) {
    return {
      status: 503,
      body: {
        error:
          'Simone is nog niet geconfigureerd. Maak eerst een joost_config-rij aan voor module=events.',
      },
    };
  }
  if (cfg.is_enabled === false) {
    return {
      status: 503,
      body: { error: 'Simone is gedeactiveerd voor module events', module: 'events' },
    };
  }

  // ========================================================================
  // STAP 3: EVENTS-CONTEXT BUILD (phone → attendees → events)
  // ========================================================================
  const nowMs = Date.now();
  const windowOpen = conv.last_inbound_at
    ? (nowMs - new Date(conv.last_inbound_at).getTime()) <= TWENTY_FOUR_HOURS_MS
    : false;

  // Phone-match — events-leads zijn vaak prospects zonder customers-rij,
  // dus we matchen rechtstreeks op event_attendees.phone (geen
  // customer_id-tussenlaag).
  const matchedAttendees = await matchAttendeesByPhone(supabase, conv.phone_number);
  const matchedEventIds  = [...new Set(matchedAttendees.map(a => a.event_id).filter(Boolean))];

  // Events ophalen voor de matched attendee event_ids. Sorteer op starts_at
  // (recente eerst); top-N voor de prompt-context.
  let eventsForCtx = [];
  if (matchedEventIds.length > 0) {
    const { data: evRows, error: evErr } = await supabase
      .from('events')
      .select(
        'id, title, starts_at, ends_at, location, capacity, status, niveau, ' +
        'description_md, signups_closed, ' +
        'event_niveau_options:niveau ( slug, label )'
      )
      .in('id', matchedEventIds)
      .order('starts_at', { ascending: false })
      .limit(MAX_EVENTS_FOR_CONTEXT);
    if (evErr) {
      console.error('[simone-suggest-core] events lookup:', evErr.message);
    } else {
      eventsForCtx = evRows || [];
    }
  }

  // Combineer attendee-status per event (1 attendee-rij per event-id).
  const attendeeByEvent = new Map();
  for (const a of matchedAttendees) {
    if (a.event_id && !attendeeByEvent.has(a.event_id)) attendeeByEvent.set(a.event_id, a);
  }

  const prospectName = attendeeDisplayName(matchedAttendees[0], 'de prospect');

  // Eerstvolgende event (starts_at >= nu)
  let nextEvent = null;
  for (const e of eventsForCtx) {
    if (!e.starts_at) continue;
    const t = new Date(e.starts_at).getTime();
    if (Number.isFinite(t) && t >= nowMs) {
      if (!nextEvent || t < new Date(nextEvent.starts_at).getTime()) nextEvent = e;
    }
  }

  // Recent messages (N = config.context_message_count, default 10)
  const n = Math.max(5, Math.min(50, Number(cfg.context_message_count) || 10));
  const { data: msgRows, error: msgErr } = await supabase
    .from('whatsapp_messages')
    .select('id, direction, body, created_at, template_name')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(n);
  if (msgErr) {
    console.error('[simone-suggest-core] messages lookup:', msgErr.message);
  }
  const recentMessages = (msgRows || [])
    .slice()
    .reverse()
    .filter(m => typeof m.body === 'string' && m.body.trim().length > 0);

  // Afdeling-context (uit module-context — events-rij in whatsapp_module_config)
  const afdeling = {
    naam:           moduleCtx?.display_label || 'Events',
    ondertekenaar:  moduleCtx?.afdeling_ondertekenaar || '',
    telefoon:       moduleCtx?.afdeling_telefoon || '',
    whatsapp:       moduleCtx?.afdeling_whatsapp || '',
    email:          moduleCtx?.afdeling_email || '',
  };
  const bedrijf = {
    naam: process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
  };

  const lastInbound = [...recentMessages].reverse().find(m => m.direction === 'in');

  const contextSnapshot = {
    conversation: {
      id:                 conv.id,
      phone_number:       conv.phone_number || null,
      last_inbound_at:    conv.last_inbound_at || null,
      window_open:        windowOpen,
      last_inbound_body:  lastInbound ? String(lastInbound.body).slice(0, 1000) : null,
    },
    prospect: {
      name:                 prospectName,
      matched_attendee_id:  matchedAttendees[0]?.id || null,
      matched_count:        matchedAttendees.length,
      email:                matchedAttendees[0]?.email || null,
    },
    events: eventsForCtx.map(e => ({
      id:             e.id,
      title:          e.title,
      starts_at:      e.starts_at,
      ends_at:        e.ends_at,
      location:       e.location,
      niveau_label:   e.event_niveau_options?.label || null,
      status:         e.status,
      signups_closed: !!e.signups_closed,
      attendee_status: attendeeByEvent.get(e.id)?.status || null,
      attendee_follow_up_flagged: !!attendeeByEvent.get(e.id)?.follow_up_flagged,
    })),
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
  const eventsCount      = eventsForCtx.length;
  const nextEventTitle   = nextEvent
    ? `${nextEvent.title} (${fmtDateNL(nextEvent.starts_at)})`
    : (matchedAttendees.length === 0 ? 'n.v.t. — geen koppeling gevonden' : 'geen toekomstig event');
  const attendeeStatus   = matchedAttendees[0]?.status || 'onbekend';

  let systemPrompt = String(cfg.system_prompt_template || '');
  systemPrompt = systemPrompt
    .replace(/\{prospect_naam\}/g,     prospectName)
    .replace(/\{events_count\}/g,      String(eventsCount))
    .replace(/\{next_event_title\}/g,  nextEventTitle)
    .replace(/\{attendee_status\}/g,   attendeeStatus);

  // Context-block — leesbaar voor het LLM. Bij no-match expliciet melden zodat
  // Simone niet hallucineert.
  const ctxLines = [];
  ctxLines.push('---');
  ctxLines.push('CONTEXT (server-side opgehaald):');
  if (matchedAttendees.length === 0) {
    ctxLines.push('Prospect: ' + prospectName + ' (GEEN attendee-match op telefoonnummer).');
    ctxLines.push('Antwoord als algemene events-assistent; doe geen aannames over inschrijving.');
  } else {
    ctxLines.push('Prospect: ' + prospectName);
    if (matchedAttendees[0]?.email) ctxLines.push('E-mail: ' + matchedAttendees[0].email);
    ctxLines.push('Aantal events (recent/komend): ' + eventsCount);
    ctxLines.push('Eerstvolgende event: ' + nextEventTitle);
  }
  ctxLines.push('');
  if (eventsForCtx.length > 0) {
    ctxLines.push('Events waar deze persoon mee verbonden is:');
    for (const e of eventsForCtx) {
      const niveau = e.event_niveau_options?.label ? ` (niveau ${e.event_niveau_options.label})` : '';
      const aStatus = attendeeByEvent.get(e.id)?.status || 'onbekend';
      const closedNote = e.signups_closed ? ', inschrijvingen GESLOTEN' : '';
      ctxLines.push(
        `  - ${e.title}${niveau}, ${fmtDateNL(e.starts_at)} ` +
        `@ ${e.location || '?'}, status=${e.status || '?'}${closedNote}, ` +
        `deelnemer-status=${aStatus}`
      );
    }
    ctxLines.push('');
  }
  ctxLines.push(`Afdeling: ${afdeling.naam}`);
  if (afdeling.ondertekenaar) ctxLines.push(`Ondertekenaar: ${afdeling.ondertekenaar}`);
  ctxLines.push(`Bedrijf: ${bedrijf.naam}`);
  ctxLines.push(`Conversatie-window: ${windowOpen ? 'open (24h)' : 'gesloten'}`);

  // Knowledge-base toevoegen (vrije jsonb in joost_config)
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
  ctxLines.push('- Doe geen harde toezeggingen over plaatsen / kortingen / bedragen.');
  ctxLines.push('- Bij klacht / juridisch: verwijs naar een medewerker (escalation_needed).');
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
    tools:       [SIMONE_TOOL],
    tool_choice: { type: 'tool', name: 'simone_response' },
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
    console.error('[simone-suggest-core] Anthropic fetch failed:', e.message);
    return { status: 502, body: { error: 'Anthropic API onbereikbaar: ' + e.message } };
  }

  if (claudeResp.status === 429) {
    const txt = await claudeResp.text().catch(() => '');
    console.error('[simone-suggest-core] Anthropic 429:', txt.slice(0, 500));
    return {
      status: 429,
      body: { error: 'Anthropic rate-limit bereikt. Probeer opnieuw over een minuut.' },
    };
  }
  if (!claudeResp.ok) {
    const txt = await claudeResp.text().catch(() => '');
    console.error(`[simone-suggest-core] Anthropic ${claudeResp.status}:`, txt.slice(0, 500));
    return {
      status: 502,
      body: { error: `Anthropic API-fout (${claudeResp.status})`, details: txt.slice(0, 500) },
    };
  }

  const claudeData = await claudeResp.json();
  const toolUseBlock = (claudeData.content || []).find(
    b => b.type === 'tool_use' && b.name === 'simone_response'
  );
  if (!toolUseBlock || !toolUseBlock.input) {
    console.error('[simone-suggest-core] Geen tool_use block in response:', JSON.stringify(claudeData).slice(0, 500));
    return { status: 502, body: { error: 'Anthropic gaf geen structured response terug' } };
  }

  const toolInput      = toolUseBlock.input;
  const suggestedReply = typeof toolInput.suggested_reply === 'string' ? toolInput.suggested_reply.trim() : '';
  const detectedIntent = DETECTED_INTENTS_EVENTS.includes(toolInput.detected_intent)
    ? toolInput.detected_intent : 'other';
  const confidence     = clamp01(toolInput.confidence);
  const reasoning      = typeof toolInput.reasoning === 'string' ? toolInput.reasoning.trim() : '';

  if (!suggestedReply) {
    return { status: 502, body: { error: 'Anthropic gaf een lege suggested_reply terug' } };
  }

  // ========================================================================
  // STAP 7: Save suggestion — module='events' op joost_suggestions
  // ========================================================================
  const insertRow = {
    conversation_id:          conversationId,
    triggered_by_message_id:  triggeredByMessageId || null,
    module:                   'events',
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
      action:      autoTriggered ? 'simone.suggestion.auto_generated' : 'simone.suggestion.generated',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  {
        suggestion_id:        sugg.id,
        module:               'events',
        model:                requestBody.model,
        temperature:          requestBody.temperature,
        detected_intent:      detectedIntent,
        confidence,
        messages_in_ctx:      anthropicMessages.length,
        attendee_match_count: matchedAttendees.length,
        events_in_ctx:        eventsForCtx.length,
        auto_triggered:       autoTriggered === true,
        triggered_by:         autoTriggered ? 'inbox_webhook' : 'user_click',
      },
      reason_text: lastInbound ? String(lastInbound.body).slice(0, 500) : null,
      ip_address:  clientIp || null,
    });
  } catch (e) {
    console.error('[simone-suggest-core audit]', e.message);
  }

  // ========================================================================
  // STAP 8: Response
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
        created_at:      sugg.created_at,
      },
    },
  };
}
