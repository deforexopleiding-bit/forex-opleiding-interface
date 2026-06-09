// api/joost-suggest.js
// POST -> genereer een Joost-suggestie voor een WhatsApp-conversatie.
//
// Flow:
//   1) Auth + RBAC (finance.joost.use)
//   2) Rate-limit (per conv: max 1 PROPOSED suggestie per 30 sec)
//   3) Lookup joost_config voor module (via phone_number_id -> whatsapp_module_config,
//      fallback 'finance'). Als is_enabled=false → 503.
//   4) Bouw context_snapshot: customer + open_invoices + active arrangements +
//      recent messages (N = config.context_message_count).
//   5) Render system-prompt: vervang {klant_naam} / {open_facturen_count} /
//      {open_facturen_totaal} / {actieve_afspraak_type} placeholders + append
//      een context-block met de gehele snapshot voor de LLM.
//   6) Bouw Anthropic messages-array (oudste -> nieuwste, role=user voor inbound).
//   7) Call Anthropic /v1/messages met tool_use structured-output (tool name
//      'joost_response'). tool_choice forceert de tool zodat we altijd geldig
//      jsonb krijgen.
//   8) INSERT joost_suggestions (status='PROPOSED') + audit_log (fail-soft).
//   9) Response { suggestion: {...} }.
//
// Permission: finance.joost.use (strict — geen fallback; admin krijgt automatisch
// via super_admin in user_has_permission).
//
// Body:
//   {
//     conversation_id:           uuid (verplicht),
//     triggered_by_message_id:   uuid (optioneel — meestal de laatste inbound)
//   }
//
// Error responses:
//   400  conversation_id ontbreekt / ongeldige uuid
//   401  geen sessie
//   403  geen finance.joost.use rechten
//   404  conversation niet gevonden
//   429  rate-limit (vorige suggestie < 30s oud)
//   500  database-fout (incl. ANTHROPIC_API_KEY niet geconfigureerd → 503)
//   502  Anthropic API-fout (network / 5xx)
//   503  ANTHROPIC_API_KEY niet geconfigureerd OF Joost gedeactiveerd voor module
//
// Response 200:
//   {
//     suggestion: {
//       id, suggested_reply, detected_intent, confidence, reasoning, created_at
//     }
//   }
//
// Pattern-notes:
//   - Anthropic-call gebruikt native fetch (geen @anthropic-ai/sdk), conform
//     bestaand pattern in agent-chat.js. Headers: x-api-key + anthropic-version
//     + content-type. Geen Bearer.
//   - Structured output via tool-use met tool_choice (zie CLAUDE.md recon-context
//     'structured_output_pattern'). De tool heeft geen executor — we lezen
//     block.input direct uit het assistant-response.
//   - Audit-log in audit_log-tabel (nieuwere entity-driven stijl), niet
//     agent_audit_log. Action='joost.suggestion.generated'.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { getModuleContextByPhoneNumberId } from './_lib/module-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 30 * 1000;
const MAX_OPEN_INVOICES = 25;
const MAX_TOKENS = 1024;
const DETECTED_INTENTS = [
  'payment_promise',
  'verify_payment',
  'arrangement_request',
  'general_question',
  'escalation_needed',
  'other',
];

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function fmtEur(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '0,00';
  return x.toFixed(2).replace('.', ',');
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// Anthropic tool-schema voor structured output. Forceert het JSON-formaat van
// Joost's antwoord zodat we geen vrije-tekst hoeven te parsen.
const JOOST_TOOL = {
  name: 'joost_response',
  description:
    'Lever het Joost-antwoord voor deze klant-WhatsApp. Vul alle velden volledig in.',
  input_schema: {
    type: 'object',
    properties: {
      suggested_reply: {
        type: 'string',
        description:
          'De voorgestelde Nederlandse antwoord-tekst die de medewerker kan versturen. Compact, max 3-4 zinnen.',
      },
      detected_intent: {
        type: 'string',
        enum: DETECTED_INTENTS,
        description:
          'Het intent van de laatste klant-message. payment_promise = klant belooft te betalen; verify_payment = klant zegt al betaald te hebben; arrangement_request = klant vraagt om betalingsregeling; general_question = inhoudelijke vraag zonder duidelijke financiele intent; escalation_needed = vereist menselijke / juridische aandacht; other = anders.',
      },
      confidence: {
        type: 'number',
        description:
          'Hoe zeker ben je over je classificatie en je voorgestelde antwoord? 0.0 = niet zeker, 1.0 = zeer zeker.',
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission (strict: finance.joost.use) ----
  if (!(await requirePermission(req, 'finance.joost.use'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
  }

  // ---- Body parsen ----
  const body = req.body || {};
  const convId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convId)) return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });

  const triggeredById = typeof body.triggered_by_message_id === 'string'
    ? body.triggered_by_message_id.trim()
    : null;
  if (triggeredById && !isUuid(triggeredById)) {
    return res.status(400).json({ error: 'triggered_by_message_id moet geldige uuid zijn' });
  }

  try {
    // ========================================================================
    // STAP 1: Rate-limit (per conv: max 1 suggestie per 30 sec, ongeacht status)
    // ========================================================================
    // E1.0 polish: rate-limit op laatste suggestion (incl. USED_AS_IS / USED_EDITED /
    // IGNORED / REJECTED) — voorkomt rapid-fire generaties die LLM-kosten opjagen.
    const { data: recentSugg, error: rateErr } = await supabaseAdmin
      .from('joost_suggestions')
      .select('id, created_at')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (rateErr) {
      console.error('[joost-suggest] rate-limit select error:', rateErr.message);
      // Soft-fail: laat rate-limit niet de hoofdflow blokkeren bij DB-glitch.
    } else if (recentSugg && recentSugg.created_at) {
      const lastMs = new Date(recentSugg.created_at).getTime();
      if (Number.isFinite(lastMs)) {
        const ageSeconds = (Date.now() - lastMs) / 1000;
        const windowSeconds = RATE_LIMIT_WINDOW_MS / 1000;
        if (ageSeconds < windowSeconds) {
          const retryAfter = Math.max(1, Math.ceil(windowSeconds - ageSeconds));
          return res.status(429).json({
            error: 'rate_limit',
            message: 'Wacht 30 seconden voor je een nieuwe suggestie vraagt',
            retry_after_seconds: retryAfter,
            previous_suggestion_id: recentSugg.id,
            previous_created_at: recentSugg.created_at,
          });
        }
      }
    }

    // ========================================================================
    // STAP 2: Conversation ophalen + module bepalen + joost_config laden
    // ========================================================================
    const { data: conv, error: convErr } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, phone_number, phone_number_id, customer_id, last_inbound_at')
      .eq('id', convId)
      .maybeSingle();
    if (convErr) throw new Error('conversation lookup: ' + convErr.message);
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // Module-resolve via whatsapp_module_config (exact phone_number_id match,
    // fallback 'finance'). Default 'finance' als ook fallback null is.
    const moduleCtx = await getModuleContextByPhoneNumberId(supabaseAdmin, conv.phone_number_id);
    const resolvedModule = moduleCtx?.module || 'finance';

    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select(
        'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
        'model, temperature, context_message_count, is_enabled'
      )
      .eq('module', resolvedModule)
      .maybeSingle();
    if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);

    // Geen rij: probeer finance-fallback (kan voorkomen bij brand-new module).
    let config = cfg;
    if (!config && resolvedModule !== 'finance') {
      const { data: fbCfg, error: fbErr } = await supabaseAdmin
        .from('joost_config')
        .select(
          'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
          'model, temperature, context_message_count, is_enabled'
        )
        .eq('module', 'finance')
        .maybeSingle();
      if (fbErr) throw new Error('joost_config fallback lookup: ' + fbErr.message);
      config = fbCfg;
    }
    if (!config) {
      return res.status(503).json({
        error: 'Joost is nog niet geconfigureerd. Maak eerst een joost_config-rij aan voor module=finance.',
      });
    }
    if (config.is_enabled === false) {
      return res.status(503).json({
        error: 'Joost is gedeactiveerd voor deze module',
        module: config.module,
      });
    }

    // ========================================================================
    // STAP 3: Context-build (customer + open_invoices + arrangements + messages)
    // ========================================================================
    const nowMs = Date.now();
    const windowOpen = conv.last_inbound_at
      ? (nowMs - new Date(conv.last_inbound_at).getTime()) <= TWENTY_FOUR_HOURS_MS
      : false;

    // Klant ophalen via direct conv.customer_id (geen phone-fallback hier — die
    // moet bij de webhook-tijd al gezet zijn; als 'ie leeg is heeft Joost geen
    // klant-context en dat moet helder zijn in de prompt).
    let customerOut = null;
    if (conv.customer_id) {
      const { data: cust, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email, phone, created_at')
        .eq('id', conv.customer_id)
        .maybeSingle();
      if (custErr) {
        console.error('[joost-suggest] customer lookup:', custErr.message);
      } else if (cust) {
        customerOut = {
          id:         cust.id,
          name:       customerDisplayName(cust, '') || null,
          email:      cust.email || null,
          phone:      cust.phone || null,
          is_company: !!cust.is_company,
          created_at: cust.created_at || null,
        };
      }
    }

    // Open facturen
    const openInvoices = [];
    let totalOpen = 0;
    if (customerOut) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select(
          'id, invoice_number, amount_total, amount_paid, credited_amount, ' +
          'due_date, issue_date, status'
        )
        .eq('customer_id', customerOut.id)
        .in('status', ['open', 'partially_paid'])
        .order('due_date', { ascending: true, nullsFirst: false })
        .order('issue_date', { ascending: true, nullsFirst: false })
        .limit(MAX_OPEN_INVOICES);
      if (invErr) {
        console.error('[joost-suggest] invoices lookup:', invErr.message);
      } else {
        for (const inv of invRows || []) {
          const total = Number(inv.amount_total) || 0;
          const paid = Number(inv.amount_paid) || 0;
          const credited = Number(inv.credited_amount) || 0;
          const fullyCredited = credited > 0 && total > 0 && credited >= total;
          if (fullyCredited) continue;
          const amountOpen = Math.max(0, total - paid);
          if (amountOpen <= 0) continue;
          let daysOverdue = 0;
          if (inv.due_date) {
            const due = new Date(inv.due_date + 'T00:00:00').getTime();
            if (Number.isFinite(due) && due < nowMs) {
              daysOverdue = Math.floor((nowMs - due) / ONE_DAY_MS);
            }
          }
          openInvoices.push({
            id:             inv.id,
            invoice_number: inv.invoice_number || null,
            amount_open:    Math.round(amountOpen * 100) / 100,
            due_date:       inv.due_date || null,
            days_overdue:   daysOverdue,
            is_overdue:     daysOverdue > 0,
            status:         inv.status,
          });
          totalOpen += amountOpen;
        }
      }
    }
    totalOpen = Math.round(totalOpen * 100) / 100;

    // Actieve arrangements (VOORGESTELD / ACTIEF)
    let activeArrangements = [];
    if (customerOut) {
      const { data: arrRows, error: arrErr } = await supabaseAdmin
        .from('payment_arrangements')
        .select('id, type, status, invoice_ids, details, created_at, updated_at')
        .eq('customer_id', customerOut.id)
        .in('status', ['VOORGESTELD', 'ACTIEF'])
        .order('created_at', { ascending: false });
      if (arrErr) {
        console.error('[joost-suggest] arrangements lookup:', arrErr.message);
      } else {
        activeArrangements = (arrRows || []).map(a => ({
          id:         a.id,
          type:       a.type,
          status:     a.status,
          details:    a.details || {},
          created_at: a.created_at,
        }));
      }
    }

    // Recent messages (N = config.context_message_count)
    const n = Math.max(5, Math.min(50, Number(config.context_message_count) || 10));
    const { data: msgRows, error: msgErr } = await supabaseAdmin
      .from('whatsapp_messages')
      .select('id, direction, body, created_at, template_name')
      .eq('conversation_id', convId)
      .order('created_at', { ascending: false })
      .limit(n);
    if (msgErr) {
      console.error('[joost-suggest] messages lookup:', msgErr.message);
    }
    // Chronologisch (oudste eerst) voor de Anthropic-call.
    const recentMessages = (msgRows || [])
      .slice()
      .reverse()
      .filter(m => typeof m.body === 'string' && m.body.trim().length > 0);

    // Afdeling + bedrijf (uit module-context + env)
    const afdeling = {
      naam:           moduleCtx?.display_label || resolvedModule || 'Finance',
      ondertekenaar:  moduleCtx?.afdeling_ondertekenaar || '',
      telefoon:       moduleCtx?.afdeling_telefoon || '',
      whatsapp:       moduleCtx?.afdeling_whatsapp || '',
      email:          moduleCtx?.afdeling_email || '',
    };
    const bedrijf = {
      naam: process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
      kvk:  process.env.COMPANY_KVK  || '',
      btw:  process.env.COMPANY_BTW  || '',
    };

    // Laatste klant-message (voor template-var)
    const lastInbound = [...recentMessages].reverse().find(m => m.direction === 'in');

    // Volledige context_snapshot (audit + later eval)
    const contextSnapshot = {
      conversation: {
        id:               conv.id,
        phone_number:     conv.phone_number || null,
        last_inbound_at:  conv.last_inbound_at || null,
        window_open:      windowOpen,
        last_inbound_body: lastInbound ? String(lastInbound.body).slice(0, 1000) : null,
      },
      customer: customerOut,
      open_facturen: {
        totaal_open_bedrag: totalOpen,
        aantal:             openInvoices.length,
        items:              openInvoices,
      },
      actieve_afspraken: activeArrangements,
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
    const klantNaam = customerOut?.name || 'de klant';
    const openFacturenCount = openInvoices.length;
    const openFacturenTotaal = `EUR ${fmtEur(totalOpen)}`;
    const actieveAfspraakType = activeArrangements[0]?.type || 'geen-afspraak';

    let systemPrompt = String(config.system_prompt_template || '');
    systemPrompt = systemPrompt
      .replace(/\{klant_naam\}/g,             klantNaam)
      .replace(/\{open_facturen_count\}/g,    String(openFacturenCount))
      .replace(/\{open_facturen_totaal\}/g,   openFacturenTotaal)
      .replace(/\{actieve_afspraak_type\}/g,  actieveAfspraakType);

    // Append context-block met klant-info + facturen + afspraken. We bouwen het
    // als platte tekst zodat het LLM-vriendelijk leesbaar is.
    const ctxLines = [];
    ctxLines.push('---');
    ctxLines.push('CONTEXT (server-side opgehaald):');
    ctxLines.push(`Klant: ${klantNaam}${customerOut?.is_company ? ' (zakelijk)' : ''}`);
    if (customerOut?.email)  ctxLines.push(`E-mail: ${customerOut.email}`);
    if (customerOut?.phone)  ctxLines.push(`Telefoon: ${customerOut.phone}`);
    ctxLines.push('');
    ctxLines.push(`Openstaande facturen: ${openFacturenCount} stuks, totaal ${openFacturenTotaal}`);
    if (openInvoices.length > 0) {
      const top = openInvoices.slice(0, 5);
      for (const inv of top) {
        const num = inv.invoice_number || inv.id;
        const overdue = inv.is_overdue ? ` (${inv.days_overdue} dgn over vervaldatum)` : '';
        ctxLines.push(`  - ${num}: EUR ${fmtEur(inv.amount_open)}, vervalt ${inv.due_date || '?'}${overdue}`);
      }
      if (openInvoices.length > 5) ctxLines.push(`  ... +${openInvoices.length - 5} meer`);
    }
    ctxLines.push('');
    if (activeArrangements.length > 0) {
      ctxLines.push(`Actieve betalingsafspraken: ${activeArrangements.length}`);
      for (const a of activeArrangements.slice(0, 3)) {
        ctxLines.push(`  - ${a.type} (status ${a.status}), aangemaakt ${a.created_at}`);
      }
    } else {
      ctxLines.push('Actieve betalingsafspraken: geen');
    }
    ctxLines.push('');
    ctxLines.push(`Afdeling: ${afdeling.naam}`);
    if (afdeling.ondertekenaar) ctxLines.push(`Ondertekenaar: ${afdeling.ondertekenaar}`);
    ctxLines.push(`Bedrijf: ${bedrijf.naam}`);
    ctxLines.push(`Conversatie-window: ${windowOpen ? 'open (24h)' : 'gesloten'}`);
    // Knowledge-base toevoegen als plain key:value lijst (kort).
    const kb = config.knowledge_base && typeof config.knowledge_base === 'object'
      ? config.knowledge_base : {};
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
    const fullSystemPrompt = `${systemPrompt}\n\n${ctxLines.join('\n')}`;

    // ========================================================================
    // STAP 5: Messages-array voor Anthropic (oudste -> nieuwste)
    // ========================================================================
    const anthropicMessages = [];
    for (const m of recentMessages) {
      const role = m.direction === 'in' ? 'user' : 'assistant';
      const text = String(m.body || '').trim();
      if (!text) continue;
      anthropicMessages.push({ role, content: text });
    }
    // Anthropic vereist dat de conversatie eindigt op een user-message; als de
    // laatste message van ons (outbound) was, voegen we een synthetisch user-
    // signaal toe zodat het model weet dat het nu moet antwoorden. Dit komt
    // zelden voor (Joost wordt typisch na een inbound aangeroepen) maar dekt
    // edge-cases.
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({
        role: 'user',
        content: '[Geen recente klant-berichten beschikbaar — geef een open vraag terug.]',
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
      return res.status(503).json({
        error: 'ANTHROPIC_API_KEY niet geconfigureerd. Vraag aan super_admin.',
      });
    }

    const requestBody = {
      model:       config.model || 'claude-sonnet-4-6',
      max_tokens:  MAX_TOKENS,
      temperature: clamp01(config.temperature ?? 0.3),
      system:      fullSystemPrompt,
      messages:    anthropicMessages,
      tools:       [JOOST_TOOL],
      tool_choice: { type: 'tool', name: 'joost_response' },
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
      console.error('[joost-suggest] Anthropic fetch failed:', e.message);
      return res.status(502).json({ error: 'Anthropic API onbereikbaar: ' + e.message });
    }

    if (claudeResp.status === 429) {
      const txt = await claudeResp.text().catch(() => '');
      console.error('[joost-suggest] Anthropic 429:', txt.slice(0, 500));
      return res.status(429).json({ error: 'Anthropic rate-limit bereikt. Probeer opnieuw over een minuut.' });
    }
    if (!claudeResp.ok) {
      const txt = await claudeResp.text().catch(() => '');
      console.error(`[joost-suggest] Anthropic ${claudeResp.status}:`, txt.slice(0, 500));
      return res.status(502).json({
        error: `Anthropic API-fout (${claudeResp.status})`,
        details: txt.slice(0, 500),
      });
    }

    const claudeData = await claudeResp.json();
    const toolUseBlock = (claudeData.content || []).find(b => b.type === 'tool_use' && b.name === 'joost_response');
    if (!toolUseBlock || !toolUseBlock.input) {
      console.error('[joost-suggest] Geen tool_use block in response:', JSON.stringify(claudeData).slice(0, 500));
      return res.status(502).json({ error: 'Anthropic gaf geen structured response terug' });
    }

    const toolInput = toolUseBlock.input;
    const suggestedReply = typeof toolInput.suggested_reply === 'string' ? toolInput.suggested_reply.trim() : '';
    const detectedIntent = DETECTED_INTENTS.includes(toolInput.detected_intent)
      ? toolInput.detected_intent : 'other';
    const confidence = clamp01(toolInput.confidence);
    const reasoning = typeof toolInput.reasoning === 'string' ? toolInput.reasoning.trim() : '';

    if (!suggestedReply) {
      return res.status(502).json({ error: 'Anthropic gaf een lege suggested_reply terug' });
    }

    // ========================================================================
    // STAP 7: Save suggestion
    // ========================================================================
    const insertRow = {
      conversation_id:          convId,
      triggered_by_message_id:  triggeredById || null,
      module:                   config.module,
      suggested_reply:          suggestedReply,
      detected_intent:          detectedIntent,
      confidence,
      reasoning,
      context_snapshot:         contextSnapshot,
      status:                   'PROPOSED',
      requested_by_user_id:     user.id,
    };

    const { data: sugg, error: insErr } = await supabaseAdmin
      .from('joost_suggestions')
      .insert(insertRow)
      .select('id, conversation_id, suggested_reply, detected_intent, confidence, reasoning, status, created_at')
      .single();
    if (insErr) throw new Error('joost_suggestions insert: ' + insErr.message);

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'joost.suggestion.generated',
        entity_type: 'whatsapp_conversation',
        entity_id:   convId,
        after_json:  {
          suggestion_id:    sugg.id,
          module:           config.module,
          model:            requestBody.model,
          temperature:      requestBody.temperature,
          detected_intent:  detectedIntent,
          confidence,
          messages_in_ctx:  anthropicMessages.length,
        },
        reason_text: lastInbound ? String(lastInbound.body).slice(0, 500) : null,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[joost-suggest audit]', e.message);
    }

    // ========================================================================
    // STAP 8: Response
    // ========================================================================
    return res.status(200).json({
      suggestion: {
        id:              sugg.id,
        suggested_reply: sugg.suggested_reply,
        detected_intent: sugg.detected_intent,
        confidence:      sugg.confidence,
        reasoning:       sugg.reasoning,
        created_at:      sugg.created_at,
      },
    });
  } catch (e) {
    console.error('[joost-suggest]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
