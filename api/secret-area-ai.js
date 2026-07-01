// api/secret-area-ai.js
//
// Fase 3 — "AI meelezen" per tool. Owner-gated. Bouwt één user-message met de
// tool-definitie + gelabelde voorbeelden (ideaal/tegen) + hun screenshots
// (base64-image-blocks à la vision-extract), en vraagt Claude om een concrete,
// testbare detectieregel.
//
// Body:
//   { tool_id: uuid, model?: string, save?: boolean }
//
// Response 200: { rule: string, model: string, images_used: number }
// Response 502:  Anthropic-fout (met code + status); geen crash.
// Response 403:  Owner-gate faalt.
// Response 4xx:  Validatie.
//
// Beveiliging + isolatie:
//   - requireOwner(req) staat ALS EERSTE in de handler.
//   - GEEN eigen fetch naar api.anthropic.com; alles via anthropic-client.js
//     (ANTHROPIC_API_KEY blijft server-side).
//   - Afbeeldingen worden UIT DE 'secret-area' storage bucket gedownload
//     via supabaseAdmin (service-role). Geen client-side keys.
//   - Cap: max 8 afbeeldingen, totaal ~20 MB base64-input. Grote/ontbrekende
//     afbeeldingen worden geskipt; endpoint blijft antwoorden ook zonder
//     afbeeldingen (fail-soft — Claude redeneert dan alleen op tekst).

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';
import { anthropicMessages, AnthropicClientError } from './_lib/anthropic-client.js';

const BUCKET             = 'secret-area';
const UUID_RE            = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IMAGES         = 8;
const MAX_TOTAL_BYTES    = 20 * 1024 * 1024;   // ~20 MB (base64 input cap)
const MAX_SINGLE_BYTES   =  8 * 1024 * 1024;   //  8 MB per bestand
const DEFAULT_MODEL      = 'claude-sonnet-4-6';
const ALLOWED_MODELS     = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MAX_TOKENS = 2500;

function extToMime(path) {
  const p = String(path || '').toLowerCase();
  if (p.endsWith('.png'))  return 'image/png';
  if (p.endsWith('.webp')) return 'image/webp';
  if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

async function downloadAsBase64(path) {
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(path);
    if (error) { console.warn('[sa-ai] download error:', error.message, path); return null; }
    if (!data)   return null;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length === 0)              return null;
    if (buf.length > MAX_SINGLE_BYTES) { console.warn('[sa-ai] skip: too large', path, buf.length); return null; }
    return { base64: buf.toString('base64'), bytes: buf.length, mime: extToMime(path) };
  } catch (e) {
    console.warn('[sa-ai] download exception:', e?.message || e, path);
    return null;
  }
}

function buildTextPrompt(tool, examples) {
  const lines = [];
  lines.push('Rol: je bent een trading-analyst die kijkt met de ogen van een strikte prijs-actie-lezer.');
  lines.push('');
  lines.push('TOOL-DEFINITIE');
  lines.push('- Naam: ' + (tool.name || '(zonder naam)'));
  if (tool.description) lines.push('- Beschrijving: ' + tool.description);
  lines.push('');
  lines.push('VOORBEELDEN (in dezelfde volgorde als de afbeeldingen hieronder)');
  examples.forEach((ex, i) => {
    const label = ex.kind === 'ideal' ? 'IDEAAL' : 'TEGENVOORBEELD';
    const bits = [];
    if (ex.timeframe)  bits.push('TF ' + ex.timeframe);
    if (ex.instrument) bits.push('Instrument ' + ex.instrument);
    lines.push(`#${i + 1} · ${label}${bits.length ? ' (' + bits.join(', ') + ')' : ''}`);
    if (ex.note) lines.push('  Notitie: ' + ex.note);
  });
  lines.push('');
  lines.push('OPDRACHT');
  lines.push('Stel een CONCRETE, TESTBARE detectieregel voor deze tool voor.');
  lines.push('Antwoord in het Nederlands en structureer strikt zo:');
  lines.push('');
  lines.push('1. Regel in mensentaal (1–3 zinnen).');
  lines.push('2. Expliciete condities / pseudocode (bullet-lijst; met concrete');
  lines.push('   drempels, buffers, tijd/candle-condities waar mogelijk).');
  lines.push('3. Wat onderscheidt "ideaal" van "tegenvoorbeeld" volgens de beelden?');
  lines.push('   Geef minstens 2 concrete visuele/structurele signalen.');
  lines.push('4. Open vragen / ambiguïteiten waar de dataset onvoldoende signaal geeft.');
  lines.push('');
  lines.push('Wees expliciet + operationeel. Geen algemene disclaimers, geen theorie zonder toepassing.');
  return lines.join('\n');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const body    = (req.body && typeof req.body === 'object') ? req.body : {};
  const toolId  = typeof body.tool_id === 'string' ? body.tool_id.trim() : '';
  if (!UUID_RE.test(toolId)) return res.status(400).json({ error: 'tool_id (uuid) vereist' });
  const wantSave = body.save === true;

  const modelReq = typeof body.model === 'string' ? body.model.trim() : '';
  const model = modelReq && ALLOWED_MODELS.has(modelReq) ? modelReq : DEFAULT_MODEL;

  try {
    // 1) Tool + examples (owner-scoped).
    const [{ data: tool }, { data: examples }] = await Promise.all([
      supabaseAdmin.from('sa_tools')
        .select('*').eq('id', toolId).eq('owner_id', ctx.userId).maybeSingle(),
      supabaseAdmin.from('sa_tool_examples')
        .select('id, kind, timeframe, instrument, note, image_path')
        .eq('tool_id', toolId).eq('owner_id', ctx.userId)
        .order('created_at', { ascending: false })
        .limit(MAX_IMAGES),
    ]);
    if (!tool) return res.status(404).json({ error: 'Tool niet gevonden' });
    const exs = Array.isArray(examples) ? examples : [];

    // 2) Afbeeldingen downloaden (max cap). Fail-soft per file.
    const imageBlocks = [];
    const usedExamples = [];
    let totalBytes = 0;
    for (const ex of exs) {
      if (!ex.image_path) { usedExamples.push(ex); continue; } // geen afbeelding — tekst-only
      const img = await downloadAsBase64(ex.image_path);
      if (!img) { usedExamples.push(ex); continue; }
      if (totalBytes + img.bytes > MAX_TOTAL_BYTES) {
        console.warn('[sa-ai] cap: total bytes reached, skipping remaining images');
        usedExamples.push(ex);
        break;
      }
      totalBytes += img.bytes;
      imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } });
      usedExamples.push(ex);
    }

    // 3) Tekst-prompt bouwen (na image-selectie zodat volgorde matcht).
    const textPrompt = buildTextPrompt(tool, usedExamples.slice(0, imageBlocks.length + usedExamples.length));

    // 4) Content-array — tekst eerst, dan images in volgorde. Voor examples
    // zonder image gebruikt Claude alleen de tekst-annotatie.
    const content = [{ type: 'text', text: textPrompt }, ...imageBlocks];

    // 5) Anthropic-call via de gedeelde client (geen eigen fetch, geen key hier).
    let apiResp;
    try {
      apiResp = await anthropicMessages({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content }],
      });
    } catch (e) {
      if (e instanceof AnthropicClientError) {
        console.error('[sa-ai] AnthropicClientError:', e.code, e.status, e.message);
        return res.status(502).json({
          error:  e.message || 'AI-call mislukt',
          code:   e.code   || 'ANTHROPIC_ERROR',
          status: e.status || null,
        });
      }
      throw e;
    }
    const rule = Array.isArray(apiResp?.content)
      ? apiResp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
      : '';
    if (!rule) {
      return res.status(502).json({ error: 'AI gaf geen tekst-antwoord', code: 'ANTHROPIC_EMPTY' });
    }

    // 6) Optioneel opslaan als detection_rule op de tool.
    if (wantSave) {
      const { error: updErr } = await supabaseAdmin.from('sa_tools')
        .update({ detection_rule: rule })
        .eq('id', toolId).eq('owner_id', ctx.userId);
      if (updErr) {
        // Save-fout mag het antwoord niet weggooien — we retourneren de regel
        // wél en melden de save-fout apart zodat de UI 'm kan tonen.
        console.warn('[sa-ai] save detection_rule:', updErr.message);
        return res.status(200).json({
          rule, model,
          images_used: imageBlocks.length,
          saved: false,
          save_error: updErr.message,
        });
      }
    }

    return res.status(200).json({
      rule,
      model,
      images_used: imageBlocks.length,
      saved: !!wantSave,
    });
  } catch (e) {
    console.error('[sa-ai]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
