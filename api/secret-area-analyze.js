// api/secret-area-analyze.js
//
// Chart-analyse — owner-gated. Combineert:
//   POST { action:'analyze', source, tvlink|upload, strategy_id }
//       → resolve/ingest image (via _lib/secretAreaImageIngest — dezelfde
//         SSRF-guards als secret-area-upload), verzamel owner-context
//         (tools + strategie), call Claude-vision via anthropic-client,
//         parse strict-JSON, sla analyse + detecties op, return.
//   POST { action:'confirm', detection_id, status, user_note? }
//       → update detectie (owner-gescoped). Bij 'confirmed' + tool_id →
//         maak een sa_tool_examples-rij zodat de bevestiging het systeem
//         verder traint (kind='ideal', image_path van de analyse).
//   GET  → recente analyses van de owner (met bijhorende detecties).
//
// SSRF-hardening: ALLE image-ingest gaat via _lib/secretAreaImageIngest.
// Regex-allowlist, host-allowlist, manual-redirect, timeout, MIME/size-cap
// leven daar — dit endpoint neemt er GEEN eigen fetch omheen.
//
// Anthropic: uitsluitend via _lib/anthropic-client.js. ANTHROPIC_API_KEY
// blijft server-side. AnthropicClientError → 502 (idem als secret-area-ai.js).
//
// Model: default 'claude-sonnet-4-6' (vision-capable Sonnet).

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';
import { anthropicMessages, AnthropicClientError } from './_lib/anthropic-client.js';
import {
  BUCKET,
  MAX_BYTES,
  UUID_RE,
  ingestBase64,
  ingestTradingViewUrl,
} from './_lib/secretAreaImageIngest.js';

const DEFAULT_MODEL      = 'claude-sonnet-4-6';
const ALLOWED_MODELS     = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MAX_TOKENS = 2200;
const CONFIDENCE_VALUES  = new Set(['hoog', 'midden', 'laag']);
const GRADE_VALUES       = new Set(['A+', 'B', 'C', 'n.v.t.']);

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
    if (error) { console.warn('[sa-analyze] download error:', error.message, path); return null; }
    if (!data) return null;
    const buf = Buffer.from(await data.arrayBuffer());
    if (buf.length === 0)         return null;
    if (buf.length > MAX_BYTES)   return null;
    return { base64: buf.toString('base64'), mime: extToMime(path) };
  } catch (e) {
    console.warn('[sa-analyze] download exception:', e?.message || e, path);
    return null;
  }
}

// Strip evt. ```json ... ``` wrapping en parse defensief.
function safeParseJson(txt) {
  if (typeof txt !== 'string' || !txt.trim()) return null;
  let s = txt.trim();
  // Verwijder ```json ... ``` en ``` ... ``` fences.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // Verwijder eventuele leading text vóór eerste '{'.
  const iStart = s.indexOf('{');
  const iEnd   = s.lastIndexOf('}');
  if (iStart < 0 || iEnd < 0 || iEnd <= iStart) return null;
  try { return JSON.parse(s.slice(iStart, iEnd + 1)); }
  catch (_) { return null; }
}

function buildAnalysisPrompt({ strategy, tools, hasImage }) {
  const lines = [];
  lines.push('Rol: je bent een strikte prijs-actie-lezer die alleen dingen benoemt die je concreet in het beeld kunt aanwijzen.');
  lines.push('');
  lines.push('CONTEXT — de tools van de gebruiker (owner-scoped):');
  if (!tools.length) {
    lines.push('- (nog geen tools gedefinieerd)');
  } else {
    tools.forEach((t) => {
      const bits = [];
      if (t.description)    bits.push('Beschrijving: ' + t.description);
      if (t.detection_rule) bits.push('Detectieregel: ' + t.detection_rule);
      lines.push(`- ${t.name}${bits.length ? ' — ' + bits.join(' | ') : ''}`);
    });
  }
  lines.push('');
  if (strategy) {
    lines.push('CONTEXT — de gekozen strategie:');
    lines.push('- Naam: ' + (strategy.name || '(zonder naam)'));
    if (strategy.entry_signal) lines.push('- Entry: ' + strategy.entry_signal);
    if (strategy.sl_signal)    lines.push('- SL: '    + strategy.sl_signal);
    if (strategy.tp_signal)    lines.push('- TP: '    + strategy.tp_signal);
    if (Array.isArray(strategy.steps) && strategy.steps.length) {
      lines.push('- Stappen:');
      strategy.steps.forEach((sp, i) => lines.push(`  ${i + 1}. ${sp.description || ''}`.trim()));
    }
    if (Array.isArray(strategy.conditions) && strategy.conditions.length) {
      lines.push('- Marktcondities:');
      strategy.conditions.forEach((c) => {
        const pref = c.ctype === 'filter' ? 'NOOIT als' : c.ctype === 'voorwaarde' ? 'ALLEEN als' : 'TENZIJ';
        lines.push(`  · ${pref}: ${c.label || ''}`);
      });
    }
    if (strategy.recognition_spec) {
      lines.push('- Setup-herkenning (spec):');
      strategy.recognition_spec.split('\n').forEach((ln) => lines.push('  ' + ln));
    }
  }
  lines.push('');
  lines.push('OPDRACHT');
  lines.push(hasImage
    ? 'Bekijk het chart-beeld en beantwoord in het Nederlands.'
    : 'Er is geen afbeelding beschikbaar; redeneer op basis van de context alleen (best-effort).');
  lines.push('');
  lines.push('Geef ALLEEN geldige JSON terug — geen inleiding, geen markdown-fences, geen commentaar. Schema:');
  lines.push('{');
  lines.push('  "detections": [');
  lines.push('    { "tool_name": string,          // exact-of-benaderend een van bovenstaande tools; anders eigen naam');
  lines.push('      "matches_tool_id": string|null,// UUID van een van de owner-tools als je een match ziet, anders null');
  lines.push('      "reason": string,              // 1-2 zinnen, Nederlands, benoem waar in het beeld');
  lines.push('      "confidence": "hoog"|"midden"|"laag" }');
  lines.push('  ],');
  lines.push('  "setup": {');
  lines.push('    "valid": boolean,                // is dit een geldige setup binnen de strategie?');
  lines.push('    "model": string,                 // welk sub-model/naam (bv. "FMES 15m long"); anders "n.v.t."');
  lines.push('    "grade": "A+"|"B"|"C"|"n.v.t.", // grade op basis van hoeveel checklist-elementen kloppen');
  lines.push('    "reason": string,                // 1-3 zinnen waarom (Nederlands)');
  lines.push('    "missing": string[]              // wat mist er om A+ te halen (mag [] zijn)');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('Belangrijk: benoem alleen wat je concreet ziet of afleidt. Geen algemene disclaimers.');
  lines.push('Als geen enkele tool te herkennen valt: geef "detections": [] terug.');
  return lines.join('\n');
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleAnalyze(req, res, ctx) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const source     = typeof body.source === 'string' ? body.source.trim() : '';
  const strategyId = typeof body.strategy_id === 'string' && body.strategy_id.trim()
    ? body.strategy_id.trim() : null;
  const modelReq   = typeof body.model === 'string' ? body.model.trim() : '';
  const model      = modelReq && ALLOWED_MODELS.has(modelReq) ? modelReq : DEFAULT_MODEL;

  if (!['link', 'upload'].includes(source)) {
    return res.status(400).json({ error: "source moet 'link' of 'upload' zijn" });
  }
  if (strategyId && !UUID_RE.test(strategyId)) {
    return res.status(400).json({ error: 'strategy_id ongeldig' });
  }

  // Analyse-ref — een tijdelijk uuid als "refId" voor het storage-pad, zodat we
  // het beeld kunnen uploaden vóór we de analyses-rij hebben.
  const refId = crypto.randomUUID();

  // ── 1) Beeld ingesten via de gedeelde helper (SSRF-guards intact) ──────
  let image_path = null;
  let source_url = null;
  if (source === 'link') {
    const tvUrl = typeof body.tvlink === 'string' ? body.tvlink.trim() : '';
    if (!tvUrl) return res.status(400).json({ error: 'tvlink vereist bij source=link' });
    const r = await ingestTradingViewUrl({
      ownerId: ctx.userId, kind: 'analysis', refId, tvUrl, filenameHint: 'chart',
    });
    image_path = r.image_path || null;
    source_url = r.source_url || tvUrl;
    if (!image_path) {
      // TV kon de afbeelding niet resolven — we willen NIET met een lege
      // vision-call verder; retourneer nette 422 zodat UI om upload vraagt.
      return res.status(422).json({
        error:   'Kon TradingView-snapshot niet ophalen',
        warning: r.warning || 'onbekend',
        source_url,
      });
    }
  } else {
    // Upload-mode: verwacht { filename, content_type, data_base64 }
    const contentType = typeof body.content_type === 'string' ? body.content_type : '';
    const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';
    const filenameHint = typeof body.filename === 'string' ? body.filename : 'chart';
    if (!dataB64) return res.status(400).json({ error: 'data_base64 vereist bij source=upload' });
    const r = await ingestBase64({
      ownerId: ctx.userId, kind: 'analysis', refId,
      contentType, dataBase64: dataB64, filenameHint,
    });
    if (!r.ok) return res.status(r.status || 500).json({ error: r.error });
    image_path = r.image_path;
  }

  // ── 2) Context ophalen (owner-scoped) ──────────────────────────────────
  const [{ data: toolsRaw }, { data: strategyRaw }] = await Promise.all([
    supabaseAdmin.from('sa_tools')
      .select('id, name, description, detection_rule')
      .eq('owner_id', ctx.userId)
      .order('name', { ascending: true }),
    strategyId
      ? supabaseAdmin.from('sa_strategies')
          .select('id, name, entry_signal, sl_signal, tp_signal, risk_pct, recognition_spec')
          .eq('id', strategyId).eq('owner_id', ctx.userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const tools = Array.isArray(toolsRaw) ? toolsRaw : [];

  // Extra: strategie-steps + condities (indien strategie meegegeven).
  let strategy = strategyRaw || null;
  if (strategy) {
    const [{ data: steps }, { data: conditions }] = await Promise.all([
      supabaseAdmin.from('sa_strategy_steps')
        .select('position, description').eq('strategy_id', strategy.id).eq('owner_id', ctx.userId)
        .order('position', { ascending: true }),
      supabaseAdmin.from('sa_conditions')
        .select('scope, ctype, label, active')
        .eq('owner_id', ctx.userId)
        .or(`scope.eq.global,strategy_id.eq.${strategy.id}`),
    ]);
    strategy = {
      ...strategy,
      steps:      Array.isArray(steps) ? steps : [],
      conditions: Array.isArray(conditions) ? conditions.filter((c) => c.active !== false) : [],
    };
  }

  // ── 3) Beeld downloaden voor vision-call ───────────────────────────────
  const img = await downloadAsBase64(image_path);
  const imageBlocks = img
    ? [{ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.base64 } }]
    : [];
  const promptText = buildAnalysisPrompt({ strategy, tools, hasImage: !!img });
  const content = [{ type: 'text', text: promptText }, ...imageBlocks];

  // ── 4) Anthropic-call (zelfde pattern als secret-area-ai.js) ───────────
  let apiResp;
  try {
    apiResp = await anthropicMessages({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof AnthropicClientError) {
      console.error('[sa-analyze] AnthropicClientError:', e.code, e.status, e.message);
      return res.status(502).json({
        error:  e.message || 'AI-call mislukt',
        code:   e.code   || 'ANTHROPIC_ERROR',
        status: e.status || null,
      });
    }
    throw e;
  }
  const raw = Array.isArray(apiResp?.content)
    ? apiResp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
    : '';
  const parsed = safeParseJson(raw);
  if (!parsed || !parsed.setup || !Array.isArray(parsed.detections)) {
    console.warn('[sa-analyze] parse-fail, raw first 500 chars:', String(raw).slice(0, 500));
    return res.status(502).json({ error: 'AI-antwoord kon niet als JSON gelezen worden', code: 'ANTHROPIC_PARSE_FAIL' });
  }

  // Normaliseer setup/detections.
  const setup = parsed.setup || {};
  const setupPayload = {
    valid:   !!setup.valid,
    model:   typeof setup.model  === 'string' ? setup.model.trim()  : 'n.v.t.',
    grade:   GRADE_VALUES.has(setup.grade) ? setup.grade : 'n.v.t.',
    reason:  typeof setup.reason === 'string' ? setup.reason.trim() : '',
    missing: Array.isArray(setup.missing) ? setup.missing.filter((x) => typeof x === 'string') : [],
  };
  const aiSummary = setupPayload.reason || '';

  const detectionsIn = parsed.detections.map((d) => ({
    tool_name:  typeof d.tool_name === 'string' ? d.tool_name.trim() : '',
    tool_id:    (typeof d.matches_tool_id === 'string' && UUID_RE.test(d.matches_tool_id))
                  ? d.matches_tool_id : null,
    reason:     typeof d.reason === 'string' ? d.reason.trim() : '',
    confidence: CONFIDENCE_VALUES.has(d.confidence) ? d.confidence : 'midden',
  })).filter((d) => d.tool_name || d.reason);

  // Verifieer dat matches_tool_id echt van deze owner is — anders NULL.
  const validToolIds = new Set(tools.map((t) => t.id));
  detectionsIn.forEach((d) => {
    if (d.tool_id && !validToolIds.has(d.tool_id)) d.tool_id = null;
  });

  // ── 5) Opslaan ─────────────────────────────────────────────────────────
  const { data: analysisRow, error: aErr } = await supabaseAdmin.from('sa_chart_analyses')
    .insert({
      owner_id:      ctx.userId,
      image_path,
      source_url,
      source,
      strategy_id:   strategy ? strategy.id : null,
      setup_verdict: setupPayload,
      grade:         setupPayload.grade,
      ai_summary:    aiSummary,
    })
    .select('id, owner_id, image_path, source_url, source, strategy_id, setup_verdict, grade, ai_summary, created_at')
    .maybeSingle();
  if (aErr || !analysisRow) {
    console.error('[sa-analyze] insert analysis:', aErr?.message);
    return res.status(500).json({ error: 'Kon analyse niet opslaan', detail: aErr?.message });
  }

  // Detecties bulk-insert (owner-gescoped).
  let detections = [];
  if (detectionsIn.length) {
    const rows = detectionsIn.map((d) => ({
      owner_id:    ctx.userId,
      analysis_id: analysisRow.id,
      tool_id:     d.tool_id,
      tool_name:   d.tool_name,
      ai_reason:   d.reason,
      confidence:  d.confidence,
      status:      'pending',
    }));
    const { data: dRows, error: dErr } = await supabaseAdmin.from('sa_analysis_detections')
      .insert(rows)
      .select('id, analysis_id, tool_id, tool_name, ai_reason, confidence, status, user_note, created_at');
    if (dErr) {
      console.warn('[sa-analyze] insert detections:', dErr.message);
    } else {
      detections = Array.isArray(dRows) ? dRows : [];
    }
  }

  return res.status(200).json({
    ok: true,
    analysis:  analysisRow,
    detections,
    setup:     setupPayload,
    model,
  });
}

async function handleConfirm(req, res, ctx) {
  const body        = (req.body && typeof req.body === 'object') ? req.body : {};
  const detectionId = typeof body.detection_id === 'string' ? body.detection_id.trim() : '';
  const status      = typeof body.status === 'string' ? body.status.trim() : '';
  const userNote    = typeof body.user_note === 'string' ? body.user_note.trim().slice(0, 2000) : '';

  if (!UUID_RE.test(detectionId)) return res.status(400).json({ error: 'detection_id (uuid) vereist' });
  if (!['confirmed', 'rejected'].includes(status)) {
    return res.status(400).json({ error: "status moet 'confirmed' of 'rejected' zijn" });
  }

  // Owner-gescoped fetch — anders 404.
  const { data: detection, error: fErr } = await supabaseAdmin.from('sa_analysis_detections')
    .select('id, owner_id, analysis_id, tool_id, tool_name, ai_reason, confidence, status')
    .eq('id', detectionId).eq('owner_id', ctx.userId).maybeSingle();
  if (fErr) {
    console.error('[sa-analyze/confirm] fetch:', fErr.message);
    return res.status(500).json({ error: 'Fout bij ophalen detectie' });
  }
  if (!detection) return res.status(404).json({ error: 'Detectie niet gevonden' });

  const { data: updated, error: uErr } = await supabaseAdmin.from('sa_analysis_detections')
    .update({ status, user_note: userNote || null })
    .eq('id', detectionId).eq('owner_id', ctx.userId)
    .select('id, analysis_id, tool_id, tool_name, ai_reason, confidence, status, user_note')
    .maybeSingle();
  if (uErr) {
    console.error('[sa-analyze/confirm] update:', uErr.message);
    return res.status(500).json({ error: 'Kon detectie niet bijwerken' });
  }

  // Bij bevestiging + tool-match: sluit de loop terug naar tool-training.
  let example_created = null;
  if (status === 'confirmed' && detection.tool_id) {
    const { data: analysis } = await supabaseAdmin.from('sa_chart_analyses')
      .select('image_path').eq('id', detection.analysis_id).eq('owner_id', ctx.userId).maybeSingle();
    if (analysis?.image_path) {
      const insertPayload = {
        owner_id:   ctx.userId,
        tool_id:    detection.tool_id,
        kind:       'ideal',
        image_path: analysis.image_path,
        note:       userNote || detection.ai_reason || '',
      };
      const { data: exRow, error: exErr } = await supabaseAdmin.from('sa_tool_examples')
        .insert(insertPayload)
        .select('id')
        .maybeSingle();
      if (exErr) {
        console.warn('[sa-analyze/confirm] example insert:', exErr.message);
      } else {
        example_created = exRow?.id || null;
      }
    }
  }

  return res.status(200).json({ ok: true, detection: updated, example_created });
}

async function handleList(req, res, ctx) {
  // Recente analyses van de owner met detecties. Cap 20.
  const { data: analyses, error: aErr } = await supabaseAdmin.from('sa_chart_analyses')
    .select('id, image_path, source_url, source, strategy_id, setup_verdict, grade, ai_summary, created_at')
    .eq('owner_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (aErr) {
    console.error('[sa-analyze/list] analyses:', aErr.message);
    return res.status(500).json({ error: 'Kon analyses niet ophalen' });
  }
  const ids = (analyses || []).map((a) => a.id);
  let detections = [];
  if (ids.length) {
    const { data: dRows, error: dErr } = await supabaseAdmin.from('sa_analysis_detections')
      .select('id, analysis_id, tool_id, tool_name, ai_reason, confidence, status, user_note, created_at')
      .eq('owner_id', ctx.userId)
      .in('analysis_id', ids);
    if (dErr) {
      console.warn('[sa-analyze/list] detections:', dErr.message);
    } else {
      detections = Array.isArray(dRows) ? dRows : [];
    }
  }
  return res.status(200).json({ analyses: analyses || [], detections });
}

// ── Router ────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  try {
    if (req.method === 'GET')  return await handleList(req, res, ctx);
    if (req.method === 'POST') {
      const action = (req.body && typeof req.body.action === 'string')
        ? req.body.action.trim() : '';
      if (action === 'analyze') return await handleAnalyze(req, res, ctx);
      if (action === 'confirm') return await handleConfirm(req, res, ctx);
      return res.status(400).json({ error: "action moet 'analyze' of 'confirm' zijn" });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-analyze]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
