// api/_lib/joost-suggest-core.js
//
// Pure core voor Joost-suggestion generatie. Geen HTTP-laag, geen res.json().
// Callable in-process vanuit:
//   - api/joost-suggest.js          → thin HTTP-handler (handmatige "Vraag Joost"-knop)
//   - api/inbox-webhook.js          → reactieve auto-suggest na inbound (per-module gated)
//
// Achtergrond (Fase 2 stap 1):
//   De oude flow gebruikte een HTTP-self-call vanuit de webhook naar
//   `${VERCEL_URL}/api/joost-suggest` met X-Internal-Token. Op prod faalde dat
//   structureel met `TypeError: fetch failed` (undici, geen HTTP-response).
//   Meest waarschijnlijke oorzaak: Vercel Deployment Protection of cold-start
//   DNS-race op de deployment-URL. Self-HTTP-calls op Vercel Node-runtime zijn
//   een gedocumenteerd anti-pattern; in-process call is robuust onafhankelijk
//   van VERCEL_URL/INTERNAL_API_TOKEN/SSO-protection.
//
// Signature:
//   runJoostSuggest({
//     supabase,            // SupabaseClient (typisch supabaseAdmin)
//     conversationId,      // uuid (caller heeft al gevalideerd)
//     triggeredByMessageId,// uuid|null (caller heeft al gevalideerd)
//     autoTriggered,       // boolean — true vanuit webhook, false vanuit user-click
//     requestedByUserId,   // uuid|null — user die de actie initieerde
//     clientIp,            // string|null (voor audit-log; optioneel)
//   }) → Promise<{ status: number, body: object }>
//
// Status-semantiek (caller doet alleen mapping naar res.status(...)):
//   200  { suggestion: {...} }                  succes
//   404  { error }                              conversation niet gevonden
//   429  { error, retry_after_seconds, ... }    rate-limit (1 suggestie / 30s)
//   502  { error, details? }                    Anthropic API-fout
//   503  { error, module? }                     Joost niet geconfigureerd / disabled / API-key ontbreekt
//
// Onverwachte fouten (DB-fouten, JSON-parse-fouten) → throw. Caller (HTTP-handler
// of webhook) catcht en mapt naar 500-log; vergroot diagnose-info i.p.v. silent.

import { customerDisplayName } from './customer-name.js';
import { getModuleContextByPhoneNumberId } from './module-context.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const ONE_DAY_MS           = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 30 * 1000;
const MAX_OPEN_INVOICES    = 25;
const MAX_TOKENS           = 1024;

const DETECTED_INTENTS = [
  'payment_promise',
  'verify_payment',
  'arrangement_request',
  'general_question',
  'escalation_needed',
  'other',
];

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
// Joost's antwoord zodat we geen vrije-tekst hoeven te parsen. Identiek aan
// origineel JOOST_TOOL in api/joost-suggest.js.
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

export async function runJoostSuggest({
  supabase,
  conversationId,
  triggeredByMessageId,
  autoTriggered,
  requestedByUserId,
  clientIp,
  // Sandbox-bypass: alleen actief wanneer expliciet true én de conv-klant
  // is_test=true. Voor echte klanten of afwezige param → exact het bestaande
  // 503-gedrag bij is_enabled=false. Zie #691/#692.
  allowDisabledForTest = false,
}) {
  // ========================================================================
  // STAP 1: Rate-limit (per conv: max 1 suggestie per 30 sec, ongeacht status)
  // ========================================================================
  const { data: recentSugg, error: rateErr } = await supabase
    .from('joost_suggestions')
    .select('id, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rateErr) {
    console.error('[joost-suggest-core] rate-limit select error:', rateErr.message);
    // Soft-fail: laat rate-limit niet de hoofdflow blokkeren bij DB-glitch.
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
  // STAP 2: Conversation ophalen + module bepalen + joost_config laden
  // ========================================================================
  const { data: conv, error: convErr } = await supabase
    .from('whatsapp_conversations')
    .select('id, phone_number, phone_number_id, customer_id, last_inbound_at')
    .eq('id', conversationId)
    .maybeSingle();
  if (convErr) throw new Error('conversation lookup: ' + convErr.message);
  if (!conv) return { status: 404, body: { error: 'Conversation niet gevonden' } };

  // Module-resolve via whatsapp_module_config (exact phone_number_id match).
  // Fase 2 stap 2c hardening: Joost opereert ALLEEN op finance — geen stille
  // default-naar-finance bij een onbekende of cross-module conv. Reactieve
  // webhook-pad gaat al door isFinanceLijn-gate (inbox-webhook); manual-knop
  // op finance.html werkt alleen op finance-conv; events-conv die per
  // ongeluk doorgegeven wordt → expliciete afwijzing.
  const moduleCtx = await getModuleContextByPhoneNumberId(supabase, conv.phone_number_id);
  if (moduleCtx?.module !== 'finance') {
    return {
      status: 422,
      body: {
        error: 'conversation_module_mismatch',
        message: 'Joost is alleen beschikbaar voor finance-conversations.',
        resolved_module: moduleCtx?.module || null,
      },
    };
  }
  const resolvedModule = 'finance';

  const { data: cfg, error: cfgErr } = await supabase
    .from('joost_config')
    .select(
      'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
      'model, temperature, context_message_count, is_enabled, autonomy_config'
    )
    .eq('module', resolvedModule)
    .maybeSingle();
  if (cfgErr) throw new Error('joost_config lookup: ' + cfgErr.message);

  // Geen rij: probeer finance-fallback (kan voorkomen bij brand-new module).
  let config = cfg;
  if (!config && resolvedModule !== 'finance') {
    const { data: fbCfg, error: fbErr } = await supabase
      .from('joost_config')
      .select(
        'module, persona_name, persona_tone, system_prompt_template, knowledge_base, ' +
        'model, temperature, context_message_count, is_enabled, autonomy_config'
      )
      .eq('module', 'finance')
      .maybeSingle();
    if (fbErr) throw new Error('joost_config fallback lookup: ' + fbErr.message);
    config = fbCfg;
  }
  if (!config) {
    return {
      status: 503,
      body: {
        error: 'Joost is nog niet geconfigureerd. Maak eerst een joost_config-rij aan voor module=finance.',
      },
    };
  }
  if (config.is_enabled === false) {
    // Sandbox-bypass: alleen doorgaan als (a) caller vraagt erom expliciet
    // én (b) de conv-klant is_test=true. Productie: exact het bestaande 503.
    let bypass = false;
    if (allowDisabledForTest && conv?.customer_id) {
      const { data: c } = await supabase
        .from('customers').select('is_test').eq('id', conv.customer_id).maybeSingle();
      bypass = !!(c && c.is_test === true);
    }
    if (!bypass) {
      return {
        status: 503,
        body: { error: 'Joost is gedeactiveerd voor deze module', module: config.module },
      };
    }
    console.log('[joost-suggest-core] test-bypass actief (is_enabled=false + is_test-klant) conv=' + conversationId);
  }

  // ========================================================================
  // STAP 3: Context-build (customer + open_invoices + arrangements + messages)
  // ========================================================================
  const nowMs = Date.now();
  const windowOpen = conv.last_inbound_at
    ? (nowMs - new Date(conv.last_inbound_at).getTime()) <= TWENTY_FOUR_HOURS_MS
    : false;

  let customerOut = null;
  // #788 — maandbedrag van de klant (laagste actieve abo) als dynamische
  // ondergrens per termijn. Wordt aan de LLM-prompt meegegeven in de
  // mandate-alinea zodat Joost geen splitsing voorstelt onder z'n eigen
  // maand-ritme, en aan de context zodat toekomstige callers 'em kunnen
  // hergebruiken. Fail-soft: helper returnt { hasSubscription:false,
  // monthlyAmount:null } bij DB-glitch — Joost escaleert dan.
  let customerMonthlyPayment = { hasSubscription: false, monthlyAmount: null, subscriptions: [] };
  if (conv.customer_id) {
    const { data: cust, error: custErr } = await supabase
      .from('customers')
      .select('id, is_company, company_name, first_name, last_name, email, phone, created_at')
      .eq('id', conv.customer_id)
      .maybeSingle();
    if (custErr) {
      console.error('[joost-suggest-core] customer lookup:', custErr.message);
    } else if (cust) {
      customerOut = {
        id:         cust.id,
        name:       customerDisplayName(cust, '') || null,
        email:      cust.email || null,
        phone:      cust.phone || null,
        is_company: !!cust.is_company,
        created_at: cust.created_at || null,
      };
      // Maandbedrag ophalen — na customer bevestiging, vóór de open-invoices
      // lookup zodat de mandate-alinea 'em straks kan gebruiken.
      //
      // #790 — deze catch is FAIL-CLOSED via de default state. Als de
      // dynamic-import of helper-call throwt, blijft customerMonthlyPayment
      // op { hasSubscription:false, monthlyAmount:null }. Dat wordt door de
      // mandate-alinea hieronder (r506+) vertaald naar "deze klant heeft
      // geen actief abonnement — SPLITSING NIET toegestaan, verwijs naar
      // medewerker", en de range-remark (r521+) voegt toe "SPLITSING
      // onmogelijk, escaleer". Joost krijgt dus GEEN ondergrens en biedt
      // geen regeling — de veilige uitkomst. Fout wordt met console.error
      // gelogd zodat je 'em terugvindt.
      //
      // LET OP: verander de default state van customerMonthlyPayment NIET
      // zonder deze fail-closed-garantie te heroverwegen.
      try {
        const { getCustomerMonthlyPayment } = await import('./customer-monthly-payment.js');
        customerMonthlyPayment = await getCustomerMonthlyPayment(supabase, cust.id);
      } catch (e) {
        console.error('[joost-suggest-core] monthly-payment lookup failed → fail-closed (Joost escaleert):', e?.message || e, e?.stack);
      }
    }
  }

  // Open facturen
  const openInvoices = [];
  let totalOpen = 0;
  if (customerOut) {
    const { data: invRows, error: invErr } = await supabase
      .from('invoices')
      .select(
        'id, invoice_number, amount_total, amount_paid, credited_amount, ' +
        'due_date, issue_date, status'
      )
      .eq('customer_id', customerOut.id)
      .in('status', ['open', 'partially_paid'])
      .order('due_date',   { ascending: true, nullsFirst: false })
      .order('issue_date', { ascending: true, nullsFirst: false })
      .limit(MAX_OPEN_INVOICES);
    if (invErr) {
      console.error('[joost-suggest-core] invoices lookup:', invErr.message);
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
    const { data: arrRows, error: arrErr } = await supabase
      .from('payment_arrangements')
      .select('id, type, status, invoice_ids, details, created_at, updated_at')
      .eq('customer_id', customerOut.id)
      .in('status', ['VOORGESTELD', 'ACTIEF'])
      .order('created_at', { ascending: false });
    if (arrErr) {
      console.error('[joost-suggest-core] arrangements lookup:', arrErr.message);
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
  const { data: msgRows, error: msgErr } = await supabase
    .from('whatsapp_messages')
    .select('id, direction, body, created_at, template_name')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(n);
  if (msgErr) {
    console.error('[joost-suggest-core] messages lookup:', msgErr.message);
  }
  const recentMessages = (msgRows || [])
    .slice()
    .reverse()
    .filter(m => typeof m.body === 'string' && m.body.trim().length > 0);

  // E2.4: conversation-state
  let convState = null;
  {
    const { data: stateRow, error: stateErr } = await supabase
      .from('joost_conversation_state')
      .select(
        'topics_discussed, last_proposal_made, messages_sent_today, ' +
        'messages_sent_today_date, messages_sent_total, last_message_sent_at, ' +
        'no_reply_streak_count, autonomy_paused_reason, autonomy_paused_until'
      )
      .eq('conversation_id', conversationId)
      .maybeSingle();
    if (stateErr) {
      console.error('[joost-suggest-core] conversation_state lookup:', stateErr.message);
    } else if (stateRow) {
      convState = stateRow;
    }
  }

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
      id:                 conv.id,
      phone_number:       conv.phone_number || null,
      last_inbound_at:    conv.last_inbound_at || null,
      window_open:        windowOpen,
      last_inbound_body:  lastInbound ? String(lastInbound.body).slice(0, 1000) : null,
    },
    customer: customerOut,
    // #788 — maandbedrag voor audit-doeleinden zodat je later kunt zien
    // waarop Joost z'n regeling-grens baseerde.
    monthly_payment: customerMonthlyPayment,
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
  const klantNaam            = customerOut?.name || 'de klant';
  const openFacturenCount    = openInvoices.length;
  const openFacturenTotaal   = `EUR ${fmtEur(totalOpen)}`;
  const actieveAfspraakType  = activeArrangements[0]?.type || 'geen-afspraak';

  let systemPrompt = String(config.system_prompt_template || '');
  systemPrompt = systemPrompt
    .replace(/\{klant_naam\}/g,             klantNaam)
    .replace(/\{open_facturen_count\}/g,    String(openFacturenCount))
    .replace(/\{open_facturen_totaal\}/g,   openFacturenTotaal)
    .replace(/\{actieve_afspraak_type\}/g,  actieveAfspraakType);

  const ctxLines = [];
  ctxLines.push('---');
  ctxLines.push('CONTEXT (server-side opgehaald):');
  ctxLines.push(`Klant: ${klantNaam}${customerOut?.is_company ? ' (zakelijk)' : ''}`);
  if (customerOut?.email)  ctxLines.push(`E-mail: ${customerOut.email}`);
  if (customerOut?.phone)  ctxLines.push(`Telefoon: ${customerOut.phone}`);
  ctxLines.push('');
  // #788 — abo-info toegevoegd aan klantregel zodat Joost 'em zeker meeneemt.
  if (customerMonthlyPayment.hasSubscription) {
    const cntStr = customerMonthlyPayment.subscriptions.length > 1
      ? ` (${customerMonthlyPayment.subscriptions.length} actief; laagste)`
      : '';
    ctxLines.push(`Maandbedrag klant: EUR ${fmtEur(customerMonthlyPayment.monthlyAmount)}${cntStr}`);
  } else {
    ctxLines.push('Maandbedrag klant: onbekend (geen actief abonnement).');
  }
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

  // ------------------------------------------------------------------------
  // E2.4: Mandate alinea
  // ------------------------------------------------------------------------
  const autonomyCfg = (config.autonomy_config && typeof config.autonomy_config === 'object')
    ? config.autonomy_config : {};
  const mandate = (autonomyCfg.arrangement_mandate && typeof autonomyCfg.arrangement_mandate === 'object')
    ? autonomyCfg.arrangement_mandate : {};
  const uitstelM   = mandate.uitstel   && typeof mandate.uitstel   === 'object' ? mandate.uitstel   : {};
  const splitsingM = mandate.splitsing && typeof mandate.splitsing === 'object' ? mandate.splitsing : {};

  const uitstelEnabled   = uitstelM.enabled   !== false;
  const splitsingEnabled = splitsingM.enabled !== false;

  const allowedTypes = [];
  if (uitstelEnabled)   allowedTypes.push('UITSTEL');
  if (splitsingEnabled) allowedTypes.push('SPLITSING');

  const maxUitstelDagen = Number.isFinite(Number(uitstelM.max_dagen_total))
    ? Number(uitstelM.max_dagen_total) : null;
  const maxTermijnen = Number.isFinite(Number(splitsingM.max_termijnen_total))
    ? Number(splitsingM.max_termijnen_total) : null;
  const minEersteTermijnPct = Number.isFinite(Number(splitsingM.min_eerste_termijn_pct))
    ? Number(splitsingM.min_eerste_termijn_pct) : null;

  // #788 — DYNAMISCHE ondergrens per termijn = maandbedrag van deze klant
  // (laagste actieve abo, uit customerMonthlyPayment hierboven). Vervangt de
  // vaste config-grens uit #787 die per definitie fout was voor
  // membership-klanten. Geen abo → SPLITSING onmogelijk, Joost escaleert.
  const minTermijnBedrag = (customerMonthlyPayment && customerMonthlyPayment.hasSubscription && customerMonthlyPayment.monthlyAmount > 0)
    ? Number(customerMonthlyPayment.monthlyAmount) : null;
  // Maximaal haalbare termijnen bij dit maandbedrag (integer).
  // < 2 → SPLITSING onmogelijk (SPLITSING vereist ≥2 parts).
  const maxHaalbaarTermijnen = (minTermijnBedrag && minTermijnBedrag > 0 && totalOpen > 0)
    ? Math.floor(totalOpen / minTermijnBedrag) : null;

  let minBedragPerTermijn = null;
  if (minEersteTermijnPct !== null && totalOpen > 0) {
    minBedragPerTermijn = Math.round(totalOpen * minEersteTermijnPct * 100) / 100;
  }

  const mandateLines = [];
  mandateLines.push('MANDAAT (autonomy_config.arrangement_mandate):');
  if (allowedTypes.length > 0) {
    mandateLines.push(`Toegestane arrangement-types: ${allowedTypes.join(', ')}`);
  } else {
    mandateLines.push('Toegestane arrangement-types: GEEN -- je mag zelf geen arrangement voorstellen.');
  }
  if (uitstelEnabled) {
    mandateLines.push(
      `UITSTEL: max ${maxUitstelDagen != null ? maxUitstelDagen : '?'} dagen totaal uitstel.`
    );
  }
  if (splitsingEnabled) {
    const pctStr = minEersteTermijnPct != null
      ? `${Math.round(minEersteTermijnPct * 100)}%` : '?';
    const minBedragStr = minBedragPerTermijn != null
      ? `EUR ${fmtEur(minBedragPerTermijn)}` : 'n.v.t.';
    // Effectief maximum aantal termijnen = min(mandaat-cap, floor(totaal /
    // min_termijn_bedrag)). Als min_termijn_bedrag is gezet, cap het model.
    let effMaxTermijnen = maxTermijnen;
    if (maxHaalbaarTermijnen != null) {
      effMaxTermijnen = (effMaxTermijnen != null)
        ? Math.min(effMaxTermijnen, maxHaalbaarTermijnen)
        : maxHaalbaarTermijnen;
    }
    const termijnenStr = effMaxTermijnen != null ? String(effMaxTermijnen) : '?';
    // #788 — HARDE ondergrens = maandbedrag klant. Geen abo → SPLITSING
    // verboden (Joost moet escaleren, geen voorstel doen).
    let hardMinStr = '';
    if (customerMonthlyPayment.hasSubscription && minTermijnBedrag != null) {
      hardMinStr = ` HARDE ONDERGRENS per termijn: EUR ${fmtEur(minTermijnBedrag)} (het maandbedrag van deze klant — z'n eigen betaal-ritme). Termijnen die daaronder liggen zijn VERBODEN.`;
    } else {
      hardMinStr = ` LET OP: deze klant heeft geen actief abonnement — SPLITSING is voor deze klant NIET toegestaan. Bied GEEN regeling, verwijs naar een medewerker.`;
    }
    mandateLines.push(
      `SPLITSING: max ${termijnenStr} termijnen. ` +
      `Min eerste termijn: ${pctStr} van openstaand bedrag (richtlijn min EUR per termijn: ${minBedragStr}).${hardMinStr}`
    );
  }

  const rangeRemarks = [];
  if (totalOpen <= 0) {
    rangeRemarks.push('Klant heeft geen openstaand bedrag -- zelf voorstellen verboden, verwijs naar mens.');
  } else {
    if (splitsingEnabled && minBedragPerTermijn != null && totalOpen < minBedragPerTermijn) {
      rangeRemarks.push(
        `Openstaand bedrag (EUR ${fmtEur(totalOpen)}) ligt onder de minimum-termijn ` +
        `(EUR ${fmtEur(minBedragPerTermijn)}) -- zelf SPLITSING voorstellen verboden.`
      );
    }
    // #788 dynamische ondergrens: 2 scenario's waarin SPLITSING VERBODEN is:
    //   (a) klant heeft geen actief abonnement — geen betaal-ritme om op te
    //       baseren. Joost escaleert.
    //   (b) openstaand bedrag laat geen 2 termijnen ≥ maandbedrag toe.
    //       Bijv. klant EUR 300/maand + EUR 250 open → floor(250/300)=0<2.
    if (splitsingEnabled && !customerMonthlyPayment.hasSubscription) {
      rangeRemarks.push(
        'SPLITSING onmogelijk: deze klant heeft geen actief abonnement -- ' +
        'bied GEEN regeling. Verwijs naar een medewerker (escaleer).'
      );
    } else if (splitsingEnabled && minTermijnBedrag != null && minTermijnBedrag > 0) {
      if (maxHaalbaarTermijnen == null || maxHaalbaarTermijnen < 2) {
        rangeRemarks.push(
          `SPLITSING onmogelijk: openstaand bedrag (EUR ${fmtEur(totalOpen)}) laat geen 2 termijnen ` +
          `van minimaal EUR ${fmtEur(minTermijnBedrag)} (het maandbedrag van deze klant) toe -- ` +
          `bied GEEN regeling, escaleer naar mens.`
        );
      }
    }
    if (uitstelEnabled && maxUitstelDagen != null && maxUitstelDagen <= 0) {
      rangeRemarks.push('UITSTEL is gedeactiveerd door max_dagen_total=0 -- zelf voorstellen verboden.');
    }
  }
  if (rangeRemarks.length > 0) {
    mandateLines.push('Range-waarschuwingen:');
    for (const r of rangeRemarks) mandateLines.push(`  - ${r}`);
  }

  // ------------------------------------------------------------------------
  // Conversation State alinea
  // ------------------------------------------------------------------------
  const stateLines = [];
  stateLines.push('GESPREKS-STATE (joost_conversation_state):');
  if (convState) {
    const topics = Array.isArray(convState.topics_discussed) ? convState.topics_discussed : [];
    if (topics.length > 0) {
      const topicSummaries = topics.slice(0, 10).map(t => {
        if (typeof t === 'string') return t;
        if (t && typeof t === 'object') {
          if (t.topic)  return String(t.topic);
          if (t.intent) return String(t.intent);
          if (t.label)  return String(t.label);
          return JSON.stringify(t).slice(0, 80);
        }
        return String(t);
      });
      stateLines.push(`Eerdere onderwerpen: ${topicSummaries.join(', ')}`);
    } else {
      stateLines.push('Eerdere onderwerpen: nog geen.');
    }

    const lp = convState.last_proposal_made;
    if (lp && typeof lp === 'object') {
      const lpType   = lp.type || lp.arrangement_type || 'onbekend';
      const lpDate   = lp.proposed_at || lp.created_at || null;
      const lpDetail = lp.details || lp.summary || null;
      let lpLine = `Laatste arrangement-voorstel: ${lpType}`;
      if (lpDate) lpLine += ` (op ${lpDate})`;
      if (lpDetail) {
        const detStr = typeof lpDetail === 'string' ? lpDetail : JSON.stringify(lpDetail).slice(0, 200);
        lpLine += ` -- details: ${detStr}`;
      }
      stateLines.push(lpLine);
      stateLines.push('  -> Doe NIET hetzelfde voorstel opnieuw; verwijs ernaar of bied iets anders.');
    } else {
      stateLines.push('Laatste arrangement-voorstel: nog geen.');
    }

    const sentToday = Number(convState.messages_sent_today) || 0;
    const sentDate  = convState.messages_sent_today_date || null;
    stateLines.push(`Berichten vandaag aan deze klant: ${sentToday}${sentDate ? ` (datum: ${sentDate})` : ''}`);

    if (convState.autonomy_paused_reason) {
      stateLines.push(`Autonomy gepauzeerd: ${convState.autonomy_paused_reason}`);
    }
  } else {
    stateLines.push('Nog geen state-rij voor deze conversatie -- eerste interactie.');
  }

  ctxLines.push('');
  ctxLines.push(...mandateLines);
  ctxLines.push('');
  ctxLines.push(...stateLines);
  ctxLines.push('---');
  ctxLines.push('BELANGRIJK: Stel NOOIT een arrangement voor buiten het bovenstaande mandaat.');
  ctxLines.push('Bij twijfel: stel geen arrangement voor maar verwijs naar een medewerker.');
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
    return {
      status: 503,
      body: { error: 'ANTHROPIC_API_KEY niet geconfigureerd. Vraag aan super_admin.' },
    };
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
    console.error('[joost-suggest-core] Anthropic fetch failed:', e.message);
    return { status: 502, body: { error: 'Anthropic API onbereikbaar: ' + e.message } };
  }

  if (claudeResp.status === 429) {
    const txt = await claudeResp.text().catch(() => '');
    console.error('[joost-suggest-core] Anthropic 429:', txt.slice(0, 500));
    return {
      status: 429,
      body: { error: 'Anthropic rate-limit bereikt. Probeer opnieuw over een minuut.' },
    };
  }
  if (!claudeResp.ok) {
    const txt = await claudeResp.text().catch(() => '');
    console.error(`[joost-suggest-core] Anthropic ${claudeResp.status}:`, txt.slice(0, 500));
    return {
      status: 502,
      body: { error: `Anthropic API-fout (${claudeResp.status})`, details: txt.slice(0, 500) },
    };
  }

  const claudeData = await claudeResp.json();
  const toolUseBlock = (claudeData.content || []).find(b => b.type === 'tool_use' && b.name === 'joost_response');
  if (!toolUseBlock || !toolUseBlock.input) {
    console.error('[joost-suggest-core] Geen tool_use block in response:', JSON.stringify(claudeData).slice(0, 500));
    return { status: 502, body: { error: 'Anthropic gaf geen structured response terug' } };
  }

  const toolInput      = toolUseBlock.input;
  const suggestedReply = typeof toolInput.suggested_reply === 'string' ? toolInput.suggested_reply.trim() : '';
  const detectedIntent = DETECTED_INTENTS.includes(toolInput.detected_intent)
    ? toolInput.detected_intent : 'other';
  const confidence     = clamp01(toolInput.confidence);
  const reasoning      = typeof toolInput.reasoning === 'string' ? toolInput.reasoning.trim() : '';

  if (!suggestedReply) {
    return { status: 502, body: { error: 'Anthropic gaf een lege suggested_reply terug' } };
  }

  // ========================================================================
  // STAP 7: Save suggestion
  // ========================================================================
  const insertRow = {
    conversation_id:          conversationId,
    triggered_by_message_id:  triggeredByMessageId || null,
    module:                   config.module,
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

  // ---- Audit-log (fail-soft) ----
  try {
    await supabase.from('audit_log').insert({
      user_id:     requestedByUserId || null,
      action:      autoTriggered ? 'joost.suggestion.auto_generated' : 'joost.suggestion.generated',
      entity_type: 'whatsapp_conversation',
      entity_id:   conversationId,
      after_json:  {
        suggestion_id:    sugg.id,
        module:           config.module,
        model:            requestBody.model,
        temperature:      requestBody.temperature,
        detected_intent:  detectedIntent,
        confidence,
        messages_in_ctx:  anthropicMessages.length,
        auto_triggered:   autoTriggered === true,
        triggered_by:     autoTriggered ? 'inbox_webhook' : 'user_click',
      },
      reason_text: lastInbound ? String(lastInbound.body).slice(0, 500) : null,
      ip_address:  clientIp || null,
    });
  } catch (e) {
    console.error('[joost-suggest-core audit]', e.message);
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
