// api/agent-sandbox-chat.js
//
// POST → dry-run chat met een agent op basis van diens live config, ZONDER
// enige productie-side-effect: geen writes naar joost_suggestions,
// whatsapp_messages, lisa_messages, agent_audit_log of andere logs. Geen
// echte berichten verstuurd naar klanten. Pure LLM-call.
//
// Body:
//   { module: 'finance'|'events'|'onboarding'|'lisa'|'leadsonderhoud'|'manager',
//     message: string,
//     history?: [{ role:'user'|'assistant', content:string }],
//     customer_context?: { name?, open_amount?, open_invoice_count?, ... } }
//
// Response:
//   { ok:true, reply:string, model:string, sandbox:true }
//
// Beveiliging: verplicht ANTHROPIC_API_KEY; permission admin.joost_config
// (mirror van rest van agent-hub); nooit bericht-write naar buiten.
//
// Implementatie: bouwt system prompt uit joost_config.system_prompt_template
// + persona_tone + knowledge_base (voor trio) of uit lisa_config
// (persona/kb_faq) voor Lisa, met basale template-vars {{company_name}} /
// {{customer_name}} / {{open_amount}} / {{open_invoice_count}} vervangen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicMessages, AnthropicClientError } from './_lib/anthropic-client.js';

const MODULE_TO_AGENT = {
  finance:         'Joost',
  events:          'Simone',
  onboarding:      'Mila',
  lisa:            'Lisa',
  leadsonderhoud:  'Aisha',        // Fase 4
  manager:         'AI Manager',   // Fase 4
};
const ALLOWED_MODULES = new Set(Object.keys(MODULE_TO_AGENT));
const MAX_MESSAGE_CHARS  = 2000;
const MAX_HISTORY_ITEMS  = 12;

function fillTemplate(str, vars) {
  if (!str || typeof str !== 'string') return '';
  return str.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
    const v = vars[k]; return v == null ? '' : String(v);
  });
}

function buildTrioSystemPrompt(cfg, customerCtx) {
  const vars = {
    company_name:        process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
    customer_name:       customerCtx?.name || 'de klant',
    open_amount:         customerCtx?.open_amount != null ? String(customerCtx.open_amount) : '0',
    open_invoice_count:  customerCtx?.open_invoice_count != null ? String(customerCtx.open_invoice_count) : '0',
  };
  const base = cfg?.system_prompt_template || '';
  const filled = fillTemplate(base, vars);
  const tone = cfg?.persona_tone ? `\n\nToon: ${cfg.persona_tone}` : '';
  const kb = cfg?.knowledge_base;
  let kbBlock = '';
  if (kb && typeof kb === 'object' && !Array.isArray(kb)) {
    const kbLines = [];
    for (const [k, v] of Object.entries(kb)) {
      if (['dos','donts','stop_keywords'].includes(k)) continue;
      kbLines.push('- ' + k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : String(v)));
    }
    if (kbLines.length) kbBlock = '\n\nKennis:\n' + kbLines.join('\n');
    if (Array.isArray(kb.dos) && kb.dos.length)          kbBlock += '\n\nAltijd:\n' + kb.dos.map((s) => '- ' + s).join('\n');
    if (Array.isArray(kb.donts) && kb.donts.length)      kbBlock += '\n\nNooit:\n' + kb.donts.map((s) => '- ' + s).join('\n');
    if (Array.isArray(kb.stop_keywords) && kb.stop_keywords.length) {
      kbBlock += '\n\nStop en zet door naar mens bij: ' + kb.stop_keywords.join(', ');
    }
  }
  const sandboxNote = '\n\n[SANDBOX-MODUS — dit is een testgesprek, geen echte klant.]';
  return filled + tone + kbBlock + sandboxNote;
}

function buildLisaSystemPrompt(cfg) {
  const parts = [];
  parts.push(`Je bent ${cfg?.persona_name || 'Lisa'}, Instagram-DM voor De Forex Opleiding.`);
  if (cfg?.persona_age) parts.push(`Leeftijd: ${cfg.persona_age}.`);
  if (cfg?.persona_background) parts.push(`Achtergrond: ${cfg.persona_background}`);
  if (cfg?.persona_tone) parts.push(`Toon: ${cfg.persona_tone}`);
  if (cfg?.persona_writing_style) parts.push(`Schrijfstijl: ${cfg.persona_writing_style}`);
  if (cfg?.emoji_usage) parts.push(`Emoji-gebruik: ${cfg.emoji_usage}.`);
  const dos = Array.isArray(cfg?.dos) ? cfg.dos : [];
  const donts = Array.isArray(cfg?.donts) ? cfg.donts : [];
  if (dos.length)   parts.push('Altijd:\n' + dos.map((s) => '- ' + s).join('\n'));
  if (donts.length) parts.push('Nooit:\n' + donts.map((s) => '- ' + s).join('\n'));
  const faq = Array.isArray(cfg?.kb_faq) ? cfg.kb_faq.slice(0, 20) : [];
  if (faq.length) {
    parts.push('Veelgestelde vragen:\n' + faq.map((q) => '- ' + (q.vraag || '') + ': ' + (q.antwoord || '')).join('\n'));
  }
  const prods = Array.isArray(cfg?.kb_products) ? cfg.kb_products.slice(0, 10) : [];
  if (prods.length) {
    parts.push('Aanbod:\n' + prods.map((p) => '- ' + (p.naam || '') + ' — ' + (p.beschrijving || '') + (p.prijs ? ' (' + p.prijs + ')' : '')).join('\n'));
  }
  parts.push('[SANDBOX-MODUS — dit is een testgesprek, geen echte lead.]');
  return parts.join('\n\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd', code: 'ANTHROPIC_KEY_MISSING' });
  }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = req.body || {};
  const moduleKey = (body.module || '').toString().toLowerCase().trim();
  const message   = (body.message || '').toString().trim();
  const history   = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_ITEMS) : [];
  const custCtx   = (body.customer_context && typeof body.customer_context === 'object') ? body.customer_context : {};

  if (!ALLOWED_MODULES.has(moduleKey)) {
    return res.status(400).json({ error: 'module ongeldig' });
  }
  if (!message || message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: 'message vereist (max ' + MAX_MESSAGE_CHARS + ' chars)' });
  }

  try {
    // Config ophalen
    let systemPrompt = '', model = 'claude-sonnet-4-6', temperature = 0.3;
    if (moduleKey === 'lisa') {
      const { data: lisa, error } = await supabaseAdmin
        .from('lisa_config')
        .select('persona_name, persona_age, persona_background, persona_tone, persona_writing_style, emoji_usage, dos, donts, kb_faq, kb_products')
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!lisa) return res.status(500).json({ error: 'Geen actieve Lisa-config' });
      systemPrompt = buildLisaSystemPrompt(lisa);
      model = 'claude-sonnet-4-6';
    } else {
      const { data: cfg, error } = await supabaseAdmin
        .from('joost_config')
        .select('persona_name, persona_tone, system_prompt_template, knowledge_base, model, temperature')
        .eq('module', moduleKey)
        .maybeSingle();
      if (error) throw error;
      if (!cfg) return res.status(500).json({ error: 'Geen config voor module ' + moduleKey });
      systemPrompt = buildTrioSystemPrompt(cfg, custCtx);
      model = cfg.model || model;
      temperature = cfg.temperature != null ? Number(cfg.temperature) : temperature;
    }

    // Messages array (Anthropic verwacht role user/assistant afwisselend)
    const messages = [];
    for (const h of history) {
      if (!h || typeof h.content !== 'string') continue;
      const role = h.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: h.content.slice(0, MAX_MESSAGE_CHARS) });
    }
    messages.push({ role: 'user', content: message });

    // LLM call
    const result = await anthropicMessages({
      model,
      max_tokens: 512,
      temperature,
      system: systemPrompt,
      messages,
    });

    // Antwoord uit response
    let reply = '';
    const content = result?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') reply += block.text;
      }
    }
    if (!reply) reply = '(geen antwoord ontvangen)';

    return res.status(200).json({
      ok: true,
      sandbox: true,
      reply,
      model,
      module: moduleKey,
      persisted: false,
    });
  } catch (e) {
    if (e instanceof AnthropicClientError) {
      console.warn('[sandbox-chat] anthropic:', e.code, e.message);
      const status = e.code === 'ANTHROPIC_KEY_MISSING' ? 503
                   : e.code === 'ANTHROPIC_RATE_LIMIT'  ? 429 : 502;
      return res.status(status).json({ error: e.message, code: e.code });
    }
    console.error('[sandbox-chat]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
