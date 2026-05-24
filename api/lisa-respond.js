// api/lisa-respond.js
// Lisa AI generator — genereert Lisa's volgende bericht o.b.v. de actieve/laatste config.
//
//   POST /api/lisa-respond
//   body: {
//     conversation_id?: uuid    // null/leeg = nieuwe conversatie
//     user_message?:    string  // bericht van de volger (verplicht tenzij bot_starts)
//     is_sandbox:       boolean // true = test-conversatie (vervuilt live niet)
//     config_version?:  'active' | 'latest'   // default 'active'
//     phase_override?:  string  // handmatige fase i.p.v. auto-detectie
//     bot_starts?:      boolean // alleen voor nieuwe conv: Lisa stuurt eerste bericht
//   }
//
// Auth: verifyAdmin (super_admin/admin/manager) + requirePermissionFailOpen('lisa.sandbox.use').
// Schrijven via supabaseAdmin (service role) ná de checks (RLS op lisa_* = super_admin only).
// Model: zie LISA_MODEL.

import Anthropic from '@anthropic-ai/sdk';
import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

const LISA_MODEL = 'claude-opus-4-7'; // krachtigste model voor beste test-resultaten
// Fasen die lisa_conversations.phase accepteert (zie CHECK in migratie 003).
const VALID_PHASES = ['intro', 'doel', 'situatie', 'band', 'call', 'qualified', 'disqualified'];

async function loadConfig(which) {
  let q = supabaseAdmin.from('lisa_config').select('*');
  if (which === 'active') q = q.eq('is_active', true);
  const { data } = await q.order('version', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

function asArray(v) { return Array.isArray(v) ? v : []; }

function buildSystemPrompt(config, currentPhase) {
  const phaseKey = 'phase_' + currentPhase;
  const phaseData = (config && config[phaseKey]) || {};
  const dos = asArray(config.dos).filter(Boolean);
  const donts = asArray(config.donts).filter(Boolean);
  const examples = asArray(phaseData.examples).filter(Boolean);

  const lines = [];
  lines.push(`Je bent ${config.persona_name || 'Lisa'}${config.persona_age ? ', ' + config.persona_age + ' jaar oud' : ''}.`);
  if (config.persona_background) lines.push(`Achtergrond: ${config.persona_background}`);
  lines.push('');
  if (config.persona_tone) lines.push(`Toon: ${config.persona_tone}`);
  if (config.persona_writing_style) lines.push(`Schrijfstijl: ${config.persona_writing_style}`);
  lines.push(`Emoji-gebruik: ${config.emoji_usage || 'spaarzaam'}`);

  if (dos.length) lines.push('\n==== DO\'S ====\n' + dos.map((d) => '• ' + d).join('\n'));
  if (donts.length) lines.push('\n==== DON\'TS ====\n' + donts.map((d) => '✗ ' + d).join('\n'));

  lines.push(`\n==== HUIDIGE FASE: ${currentPhase.toUpperCase()} ====`);
  if (phaseData.system) lines.push(phaseData.system);
  if (phaseData.transition) lines.push(`\nOvergangscriteria → volgende fase: ${phaseData.transition}`);
  if (examples.length) lines.push('\n==== VOORBEELDEN ====\n' + examples.map((e) => '- ' + e).join('\n'));

  const kb = [];
  if (config.kb_products) kb.push(`Producten: ${config.kb_products}`);
  if (config.kb_usps) kb.push(`USP's: ${config.kb_usps}`);
  if (config.kb_pricing) kb.push(`Prijzen: ${config.kb_pricing}`);
  if (kb.length) lines.push('\n==== KENNIS ====\n' + kb.join('\n'));

  lines.push('\n==== GUARDRAILS (NOOIT OVERTREDEN) ====');
  lines.push(config.guardrails_text || 'Geen rendementen/garanties/druktactieken. Geen specifieke prijzen tenzij expliciet gevraagd.');

  lines.push(`
==== INSTRUCTIES ====
1. Antwoord UITSLUITEND met geldige JSON met exact 2 keys:
   {"response": "je bericht hier", "detected_phase": "intro|doel|situatie|band|call|qualified|disqualified"}
2. detected_phase = in welke fase het gesprek zit ná dit antwoord.
3. Geen markdown in "response" — alleen platte tekst zoals in een Instagram-DM.
4. Hou berichten kort: meestal 1-3 zinnen, maximaal 5.
5. Stel maximaal 1 vraag per bericht.`);

  return lines.join('\n').trim();
}

function parseLisaJson(text, fallbackPhase) {
  let response = (text || '').trim();
  let phase = fallbackPhase;
  try {
    let t = (text || '').trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const obj = JSON.parse(t.slice(s, e + 1));
      if (obj.response != null) response = String(obj.response).trim();
      if (obj.detected_phase) phase = String(obj.detected_phase).trim().toLowerCase();
    }
  } catch (_) { /* fallback: hele tekst als response, fase = fallback */ }
  if (!VALID_PHASES.includes(phase)) phase = fallbackPhase;
  return { response, phase };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  if (!(await requirePermissionFailOpen(req, 'lisa.sandbox.use'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.sandbox.use' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd in Vercel → Settings → Environment Variables.' });
  }

  const body = req.body || {};
  const { user_message, phase_override } = body;
  const isSandbox = body.is_sandbox !== false; // default true (sandbox-tool)
  const botStarts = !!body.bot_starts;
  const which = body.config_version === 'latest' ? 'latest' : 'active';

  if (!botStarts && (!user_message || !String(user_message).trim())) {
    return res.status(400).json({ error: 'user_message ontbreekt (of zet bot_starts=true).' });
  }

  // ── Config laden ────────────────────────────────────────────────────────────
  const config = await loadConfig(which);
  if (!config) return res.status(400).json({ error: 'Geen Lisa-config gevonden. Maak eerst een config aan in de Config-tab.' });

  // ── Conversatie ophalen of aanmaken ───────────────────────────────────────────
  let conversation = null;
  if (body.conversation_id) {
    const { data } = await supabaseAdmin.from('lisa_conversations').select('*').eq('id', body.conversation_id).maybeSingle();
    if (!data) return res.status(404).json({ error: 'Conversatie niet gevonden.' });
    conversation = data;
  } else {
    const { data, error } = await supabaseAdmin.from('lisa_conversations')
      .insert({ is_sandbox: isSandbox, phase: 'intro', config_version_used: config.id })
      .select('*').single();
    if (error) return res.status(500).json({ error: error.message });
    conversation = data;
  }

  // ── Huidige fase bepalen ──────────────────────────────────────────────────────
  const currentPhase = (phase_override && VALID_PHASES.includes(phase_override))
    ? phase_override
    : (conversation.phase || 'intro');

  // ── Geschiedenis ophalen ──────────────────────────────────────────────────────
  const { data: history } = await supabaseAdmin.from('lisa_messages')
    .select('direction, content, sent_at').eq('conversation_id', conversation.id)
    .order('sent_at', { ascending: true });

  const apiMessages = asArray(history).map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.content,
  }));

  // ── Nieuw inkomend bericht ────────────────────────────────────────────────────
  if (botStarts && apiMessages.length === 0) {
    // Lisa opent: synthetische user-turn (wordt NIET opgeslagen) zodat de API een user-bericht heeft.
    apiMessages.push({ role: 'user', content: '[Het gesprek begint — de volger heeft je zojuist gevolgd of gereageerd. Stuur een natuurlijk openingsbericht passend bij de intro-fase.]' });
  } else if (user_message && String(user_message).trim()) {
    const text = String(user_message).trim();
    const { error: inErr } = await supabaseAdmin.from('lisa_messages')
      .insert({ conversation_id: conversation.id, direction: 'in', content: text, ai_generated: false });
    if (inErr) return res.status(500).json({ error: inErr.message });
    apiMessages.push({ role: 'user', content: text });
  }

  if (apiMessages.length === 0 || apiMessages[apiMessages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Geen geldig inkomend bericht om op te reageren.' });
  }

  // ── Claude aanroepen ──────────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt(config, currentPhase);
  const t0 = Date.now();
  let aiText = '';
  let tokensUsed = 0;
  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: LISA_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: apiMessages,
    });
    aiText = resp.content?.[0]?.text?.trim() || '';
    tokensUsed = (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);
  } catch (err) {
    console.error('[lisa-respond] Anthropic API error:', err?.message || err);
    return res.status(502).json({
      error: `AI-generatie mislukt: ${err?.message || 'onbekende fout'}`,
      conversation_id: conversation.id,
      model: LISA_MODEL,
    });
  }
  const genMs = Date.now() - t0;

  const { response: lisaResponse, phase: detectedPhase } = parseLisaJson(aiText, currentPhase);

  // ── Lisa-antwoord opslaan ─────────────────────────────────────────────────────
  const { data: outMsg, error: outErr } = await supabaseAdmin.from('lisa_messages')
    .insert({
      conversation_id: conversation.id,
      direction: 'out',
      content: lisaResponse,
      ai_generated: true,
      config_version_id: config.id,
      model_used: LISA_MODEL,
      tokens_used: tokensUsed,
      generation_time_ms: genMs,
      detected_phase: detectedPhase,
    })
    .select('id').single();
  if (outErr) return res.status(500).json({ error: outErr.message });

  // ── Conversatie-fase bijwerken indien gewijzigd ────────────────────────────────
  if (detectedPhase && detectedPhase !== conversation.phase) {
    const patch = { phase: detectedPhase };
    if (detectedPhase === 'qualified') patch.qualified = true;
    await supabaseAdmin.from('lisa_conversations').update(patch).eq('id', conversation.id);
  }

  return res.status(200).json({
    conversation_id: conversation.id,
    message_id: outMsg.id,
    lisa_response: lisaResponse,
    detected_phase: detectedPhase,
    config_version_used: config.version,
    tokens_used: tokensUsed,
    generation_time_ms: genMs,
  });
}
