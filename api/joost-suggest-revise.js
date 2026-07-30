// api/joost-suggest-revise.js
// POST → herschrijf een bestaande Joost-suggestie op basis van een instructie
// van de medewerker in natuurlijke taal ("iets vriendelijker", "maak er 3
// termijnen van", "korter"). Geeft de aangepaste tekst terug — verstuurt
// NIETS automatisch.
//
// Design:
// - Puur read + Anthropic-call. Geen DB-insert (voorkomt vervuiling van
//   joost_suggestions met tijdelijke herwerkingen). Zodra de gebruiker op
//   Verstuur klikt logt de bestaande flow het als USED_EDITED.
// - Hergebruikt joost_config (persona / systeem-prompt / model) van de
//   finance-module zodat toon consistent blijft met de originele suggestie.
// - Meerdere revisies mogelijk: caller stuurt telkens de nieuwste
//   previous_reply mee.
//
// Request:
//   POST { conversation_id: uuid, previous_reply: string, instruction: string }
// Response 200:
//   { suggested_reply: string, reasoning: string }
//
// Permission: finance.joost.use (identiek aan joost-suggest).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { anthropicStructuredOutput } from './_lib/anthropic-client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REVISE_TOOL = {
  name: 'revised_reply',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['suggested_reply', 'reasoning'],
    properties: {
      suggested_reply: {
        type: 'string',
        description: 'De herschreven reply voor de klant — Nederlands, respecteert persona en instructie.',
        minLength: 1,
        maxLength: 3000,
      },
      reasoning: {
        type: 'string',
        description: 'Korte uitleg (1-2 zinnen) waarom je zo herschreven hebt op basis van de instructie.',
        maxLength: 800,
      },
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.joost.use'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const convId       = body.conversation_id ? String(body.conversation_id).trim() : '';
  const previousReply = body.previous_reply != null ? String(body.previous_reply) : '';
  const instruction   = body.instruction ? String(body.instruction).trim() : '';

  if (!convId || !UUID_RE.test(convId)) {
    return res.status(400).json({ error: 'conversation_id (uuid) vereist' });
  }
  if (!previousReply.trim()) {
    return res.status(400).json({ error: 'previous_reply mag niet leeg zijn' });
  }
  if (!instruction) {
    return res.status(400).json({ error: 'instruction ontbreekt' });
  }
  if (instruction.length > 500) {
    return res.status(400).json({ error: 'instruction max 500 tekens' });
  }
  if (previousReply.length > 3000) {
    return res.status(400).json({ error: 'previous_reply max 3000 tekens' });
  }

  try {
    // Conv bestaat + is finance-module (via joost_config-lookup).
    const { data: conv } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('id, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (!conv) return res.status(404).json({ error: 'Conversation niet gevonden' });

    // Joost-config voor persona + model (finance-module).
    // ⚠ Kolomnamen MOETEN identiek zijn aan wat joost-suggest-core.js gebruikt
    // (r280-287): 'model', NIET 'model_name'; 'temperature' zit erbij. Anders
    // gooit Postgres een 42703 en maybeSingle() returnt null → valse "cfg
    // ontbreekt"-response terwijl de rij bestaat. Selecteer defensief alle
    // velden die de bestaande core ook selecteert.
    const { data: cfg, error: cfgErr } = await supabaseAdmin
      .from('joost_config')
      .select('module, persona_name, persona_tone, system_prompt_template, model, temperature, is_enabled')
      .eq('module', 'finance')
      .maybeSingle();
    if (cfgErr) {
      console.error('[joost-suggest-revise] joost_config lookup', cfgErr.message);
      return res.status(500).json({ error: 'joost_config lookup: ' + cfgErr.message });
    }
    if (!cfg) {
      return res.status(503).json({ error: 'Joost is nog niet geconfigureerd. Maak eerst een joost_config-rij aan voor module=finance.' });
    }
    if (cfg.is_enabled === false) {
      return res.status(503).json({ error: 'Joost is uitgeschakeld voor finance-module' });
    }

    // Bouw een korte, expliciete revise-prompt. Bewust puur op de reply +
    // instructie — we hoeven geen volledige klant-context opnieuw op te
    // halen (die zat al in de originele suggestie).
    const personaName = cfg.persona_name || 'Joost';
    const personaTone = cfg.persona_tone || 'zakelijk, vriendelijk, kort';
    const systemPrompt = [
      `Je bent ${personaName}, financieel medewerker bij De Forex Opleiding.`,
      `Toon: ${personaTone}.`,
      `Je taak: herschrijf je eerdere voorgestelde reply op basis van een instructie van de medewerker.`,
      `Behoud de kern-boodschap en de zakelijke correctheid. Blijf in het Nederlands.`,
      `Antwoord NIET met een groet als 'Beste' tenzij de instructie daarom vraagt — dit is een chat-bericht, geen brief.`,
      `Geef ook een korte reasoning (1-2 zinnen) over hoe je de instructie hebt toegepast.`,
    ].join('\n');

    const userMessage = [
      `EERDER VOORGESTELDE REPLY:`,
      previousReply,
      ``,
      `INSTRUCTIE VAN MEDEWERKER:`,
      instruction,
      ``,
      `Herschrijf de reply op basis van de instructie. Behoud toon en persona.`,
    ].join('\n');

    const model = cfg.model || 'claude-sonnet-5';
    // Temperatuur licht warmer dan default suggest (bewust: revisies mogen wat
    // creatiever binnen de instructie); fallback op cfg.temperature als gezet.
    const temperature = Number.isFinite(Number(cfg.temperature))
      ? Math.max(0.2, Number(cfg.temperature))
      : 0.4;
    const result = await anthropicStructuredOutput({
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
      tool_name: REVISE_TOOL.name,
      tool_input_schema: REVISE_TOOL.input_schema,
      model,
      temperature,
      max_tokens: 1200,
    });

    const revised = String(result?.suggested_reply || '').trim();
    const reasoning = String(result?.reasoning || '').trim();
    if (!revised) {
      return res.status(502).json({ error: 'Joost gaf een lege reply terug' });
    }

    return res.status(200).json({
      suggested_reply: revised,
      reasoning,
    });
  } catch (e) {
    // Anthropic-fouten hebben een `code`-veld via AnthropicClientError.
    const msg = e?.message || 'Onbekende fout';
    const code = e?.code || null;
    console.error('[joost-suggest-revise]', code || '', msg);
    // 429/5xx-mapping consistent met joost-suggest.
    if (code === 'ANTHROPIC_RATE_LIMIT') return res.status(429).json({ error: msg, code });
    if (code === 'ANTHROPIC_NETWORK' || code === 'ANTHROPIC_SERVER_ERROR') return res.status(502).json({ error: msg, code });
    return res.status(500).json({ error: msg, code });
  }
}
