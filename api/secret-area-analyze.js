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
const DEFAULT_MAX_TOKENS = 2500;
const CONFIDENCE_VALUES  = new Set(['hoog', 'midden', 'laag']);
const GRADE_VALUES       = new Set(['A+', 'B', 'C', 'n.v.t.']);
const TF_VALUES          = new Set(['4H', '15M']);

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

// Multi-timeframe prompt: expliciete labels per beeld, zodat de vision-model
// weet welk beeld welke TF is. haveH4/haveM15 sturen missing-instructies bij
// als er maar één timeframe is aangeleverd.
function buildAnalysisPrompt({ strategy, tools, haveH4, haveM15, setupModels }) {
  const lines = [];
  lines.push('Rol: je bent een strikte prijs-actie-lezer die alleen dingen benoemt die je concreet in de aangeleverde beelden kunt aanwijzen.');
  lines.push('');
  lines.push('BEELDEN');
  if (haveH4 && haveM15) {
    lines.push('- Beeld 1 = 4H context/bias (higher-timeframe richting, structuur, key levels).');
    lines.push('- Beeld 2 = 15M uitvoering (entry-timeframe voor de daadwerkelijke setup).');
    lines.push('Beoordeel de setup IN SAMENHANG: H4 bevestigt de richting/bias, 15M levert de entry (timing + trigger).');
  } else if (haveH4) {
    lines.push('- Beeld 1 = 4H context/bias.');
    lines.push('- 15M-uitvoering is NIET aangeleverd. Redeneer over H4-bias en noem in "missing" dat 15M-timing/trigger ontbreekt om entry-kwaliteit te oordelen.');
  } else if (haveM15) {
    lines.push('- Beeld 1 = 15M uitvoering.');
    lines.push('- 4H-context is NIET aangeleverd. Redeneer over 15M-entry en noem in "missing" dat H4-bias ontbreekt om de richting te bevestigen.');
  } else {
    lines.push('- (geen beelden beschikbaar; redeneer alleen op tekstuele context, best-effort)');
  }
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
  // Setup-modellen (eisen-laag). Per model: naam, min_confluence en de eisen
  // gesplitst in Vereist en Confluentie (met weight). AI moet zelf het best
  // passende model kiezen en per eis expliciet met=true/false invullen.
  if (Array.isArray(setupModels) && setupModels.length) {
    lines.push('SETUP-MODELLEN — kies het best passende model en toets per eis of die aanwezig is:');
    setupModels.forEach((m) => {
      lines.push('- MODEL "' + (m.name || '(zonder naam)') + '"  (min_confluence = ' + Number(m.min_confluence || 0) + ')');
      const req  = (m.requirements || []).filter((r) => r.kind === 'vereist');
      const conf = (m.requirements || []).filter((r) => r.kind === 'confluentie');
      if (req.length) {
        lines.push('  Vereist (moeten ALLEMAAL aanwezig zijn):');
        req.forEach((r) => lines.push('  · [' + r.id + '] ' + (r.label || '')));
      }
      if (conf.length) {
        lines.push('  Confluentie (wegen mee tot min_confluence; weight tussen haakjes):');
        conf.forEach((r) => lines.push('  · [' + r.id + '] ' + (r.label || '') + ' (weight ' + Number(r.weight || 0) + ')'));
      }
    });
    lines.push('');
  }
  lines.push('OPDRACHT');
  lines.push('Beantwoord in het Nederlands. Geef per detectie het bijhorende timeframe-label mee.');
  if (Array.isArray(setupModels) && setupModels.length) {
    lines.push('Kies expliciet EEN model (chosen_model = de exacte modelnaam uit bovenstaande lijst) en toets ELKE eis van dat model tegen wat je in de beelden/context ziet. Voor iedere eis: met=true als 1-op-1 aanwezig, anders false, plus een korte note (1 zin, Nederlands) waarom.');
  }
  lines.push('');
  lines.push('Geef ALLEEN geldige JSON terug — geen inleiding, geen markdown-fences, geen commentaar. Schema:');
  lines.push('{');
  lines.push('  "detections": [');
  lines.push('    { "tool_name": string,          // exact-of-benaderend een van bovenstaande tools; anders eigen naam');
  lines.push('      "matches_tool_id": string|null,// UUID van een van de owner-tools als je een match ziet, anders null');
  lines.push('      "timeframe": "4H"|"15M"|null, // in welk beeld je dit ziet; null als het niet duidelijk aan één TF hangt');
  lines.push('      "reason": string,              // 1-2 zinnen, Nederlands, benoem waar in het beeld');
  lines.push('      "confidence": "hoog"|"midden"|"laag" }');
  lines.push('  ],');
  lines.push('  "setup": {');
  lines.push('    "chosen_model": string,         // naam van het gekozen model uit SETUP-MODELLEN; "" als er geen definitie is');
  lines.push('    "requirements": [');
  lines.push('       { "id": string,               // exact het eis-id (uuid) uit SETUP-MODELLEN als daar match');
  lines.push('         "label": string,            // fallback bij afwezig id');
  lines.push('         "kind": "vereist"|"confluentie",');
  lines.push('         "met": boolean,             // aanwezig in de beelden/context?');
  lines.push('         "note": string }            // 1 zin waarom wel/niet');
  lines.push('    ],');
  lines.push('    "ai_valid": boolean,             // JOUW eigen oordeel (los van de rule-check)');
  lines.push('    "ai_grade": "A+"|"B"|"C"|"n.v.t.", // JOUW eigen grade');
  lines.push('    "valid": boolean,                // legacy — is dit een geldige setup binnen de strategie (in samenhang)?');
  lines.push('    "model": string,                 // legacy — welk sub-model/naam (bv. "FMES 15m long"); anders "n.v.t."');
  lines.push('    "grade": "A+"|"B"|"C"|"n.v.t.", // legacy — grade op basis van hoeveel checklist-elementen kloppen');
  lines.push('    "reason": string,                // 1-3 zinnen waarom (Nederlands, benoem H4-bias én 15M-uitvoering waar van toepassing)');
  lines.push('    "missing": string[]              // wat mist er om A+ te halen (incl. ontbrekende timeframe)');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push('Belangrijk: benoem alleen wat je concreet ziet of afleidt. Geen algemene disclaimers.');
  lines.push('Als geen enkele tool te herkennen valt: geef "detections": [] terug.');
  return lines.join('\n');
}

// Ingest één timeframe-block via de gedeelde helper. Retourneert
// { image_path, source_url, source, error?, status? } zonder eigen fetch.
async function ingestOneTimeframe({ block, ownerId, refId, tfLabel }) {
  if (!block || typeof block !== 'object') return null;
  const source = typeof block.source === 'string' ? block.source.trim() : '';
  if (!['link', 'upload'].includes(source)) {
    return { error: `${tfLabel}: source moet 'link' of 'upload' zijn`, status: 400 };
  }
  if (source === 'link') {
    const tvUrl = typeof block.tvlink === 'string' ? block.tvlink.trim() : '';
    if (!tvUrl) return { error: `${tfLabel}: tvlink vereist bij source=link`, status: 400 };
    // Guards (regex, host-allowlist, manual redirect, timeout, MIME, size) leven
    // in _lib/secretAreaImageIngest. Geen fetch hier.
    const r = await ingestTradingViewUrl({
      ownerId, kind: 'analysis', refId, tvUrl,
      filenameHint: `chart-${tfLabel.toLowerCase()}`,
    });
    if (!r.image_path) {
      return {
        error:   `${tfLabel}: kon TradingView-snapshot niet ophalen`,
        warning: r.warning || 'onbekend',
        source_url: r.source_url || tvUrl,
        status:  422,
      };
    }
    return { image_path: r.image_path, source_url: r.source_url || tvUrl, source };
  }
  // Upload
  const contentType = typeof block.content_type === 'string' ? block.content_type : '';
  const dataB64     = typeof block.data_base64 === 'string' ? block.data_base64 : '';
  const filenameHint = typeof block.filename === 'string' ? block.filename : `chart-${tfLabel.toLowerCase()}`;
  if (!dataB64) return { error: `${tfLabel}: data_base64 vereist bij source=upload`, status: 400 };
  const r = await ingestBase64({
    ownerId, kind: 'analysis', refId,
    contentType, dataBase64: dataB64, filenameHint,
  });
  if (!r.ok) return { error: `${tfLabel}: ${r.error}`, status: r.status || 500 };
  return { image_path: r.image_path, source_url: null, source };
}

// ── Handlers ──────────────────────────────────────────────────────────────

async function handleAnalyze(req, res, ctx) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const strategyId = typeof body.strategy_id === 'string' && body.strategy_id.trim()
    ? body.strategy_id.trim() : null;
  const modelReq   = typeof body.model === 'string' ? body.model.trim() : '';
  const model      = modelReq && ALLOWED_MODELS.has(modelReq) ? modelReq : DEFAULT_MODEL;

  if (strategyId && !UUID_RE.test(strategyId)) {
    return res.status(400).json({ error: 'strategy_id ongeldig' });
  }

  // ── 1) Server-side "minstens één"-validatie op de twee TF-blokken ─────
  // De UI moet minstens één van h4/m15 aanleveren (met source+link/upload);
  // hier is dit het gate voor kwaadwillige/lege calls.
  const h4Block  = (body.h4  && typeof body.h4  === 'object') ? body.h4  : null;
  const m15Block = (body.m15 && typeof body.m15 === 'object') ? body.m15 : null;
  const hasH4Intent  = !!(h4Block  && typeof h4Block.source  === 'string' && h4Block.source.trim());
  const hasM15Intent = !!(m15Block && typeof m15Block.source === 'string' && m15Block.source.trim());
  if (!hasH4Intent && !hasM15Intent) {
    return res.status(400).json({
      error: 'Vul minstens één timeframe in (4H of 15M) — geef h4 en/of m15 met source+bron.',
    });
  }

  // Analyse-ref — één tijdelijk uuid voor beide TF-storage-paden.
  const refId = crypto.randomUUID();

  // ── 2) Ingest per aangeleverde TF via de gedeelde helper ──────────────
  // SSRF-guards (regex-allowlist, host-allowlist, manual-redirect, timeout,
  // MIME/size) leven in _lib/secretAreaImageIngest — dit endpoint doet
  // GEEN eigen fetch en verzwakt de guards niet.
  let ingestH4  = null;
  let ingestM15 = null;
  if (hasH4Intent) {
    ingestH4 = await ingestOneTimeframe({ block: h4Block, ownerId: ctx.userId, refId, tfLabel: '4H' });
    if (ingestH4?.error) {
      return res.status(ingestH4.status || 400).json({
        error:      ingestH4.error,
        warning:    ingestH4.warning,
        source_url: ingestH4.source_url,
        timeframe:  '4H',
      });
    }
  }
  if (hasM15Intent) {
    ingestM15 = await ingestOneTimeframe({ block: m15Block, ownerId: ctx.userId, refId, tfLabel: '15M' });
    if (ingestM15?.error) {
      return res.status(ingestM15.status || 400).json({
        error:      ingestM15.error,
        warning:    ingestM15.warning,
        source_url: ingestM15.source_url,
        timeframe:  '15M',
      });
    }
  }
  const haveH4  = !!(ingestH4  && ingestH4.image_path);
  const haveM15 = !!(ingestM15 && ingestM15.image_path);
  if (!haveH4 && !haveM15) {
    // Beide ingesten zijn stil gefaald (bv. TV-resolve gaf null zonder error).
    return res.status(422).json({ error: 'Beide timeframes konden niet worden opgehaald.' });
  }

  // ── 3) Context ophalen (owner-scoped) ──────────────────────────────────
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

  let strategy = strategyRaw || null;
  let setupModels = [];   // owner-gescoped: [ { id, name, min_confluence, requirements:[{id,label,kind,weight,tool_id}] } ]
  if (strategy) {
    const [
      { data: steps },
      { data: conditions },
      { data: setupModelsRaw },
    ] = await Promise.all([
      supabaseAdmin.from('sa_strategy_steps')
        .select('position, description').eq('strategy_id', strategy.id).eq('owner_id', ctx.userId)
        .order('position', { ascending: true }),
      supabaseAdmin.from('sa_conditions')
        .select('scope, ctype, label, active')
        .eq('owner_id', ctx.userId)
        .or(`scope.eq.global,strategy_id.eq.${strategy.id}`),
      supabaseAdmin.from('sa_setup_models')
        .select('id, name, min_confluence, position, active')
        .eq('owner_id', ctx.userId).eq('strategy_id', strategy.id).eq('active', true)
        .order('position', { ascending: true }),
    ]);
    strategy = {
      ...strategy,
      steps:      Array.isArray(steps) ? steps : [],
      conditions: Array.isArray(conditions) ? conditions.filter((c) => c.active !== false) : [],
    };
    // Bijhorende requirements ophalen voor de geladen models.
    const modelIds = (setupModelsRaw || []).map((m) => m.id);
    let allReqs = [];
    if (modelIds.length) {
      const { data: reqs } = await supabaseAdmin.from('sa_setup_requirements')
        .select('id, model_id, label, kind, weight, tool_id, position, active')
        .eq('owner_id', ctx.userId).in('model_id', modelIds)
        .order('position', { ascending: true });
      allReqs = (reqs || []).filter((r) => r.active !== false);
    }
    setupModels = (setupModelsRaw || []).map((m) => ({
      ...m,
      requirements: allReqs.filter((r) => r.model_id === m.id),
    }));
  }

  // ── 4) Beelden downloaden voor vision-call ────────────────────────────
  const [imgH4, imgM15] = await Promise.all([
    haveH4  ? downloadAsBase64(ingestH4.image_path)  : Promise.resolve(null),
    haveM15 ? downloadAsBase64(ingestM15.image_path) : Promise.resolve(null),
  ]);

  // Content-array: tekst-prompt eerst, dan per TF een tekst-label + image-block
  // zodat Claude weet welk beeld welk timeframe is.
  const content = [{ type: 'text', text: buildAnalysisPrompt({
    strategy, tools, haveH4: !!imgH4, haveM15: !!imgM15, setupModels,
  }) }];
  if (imgH4) {
    content.push({ type: 'text', text: '--- Beeld 1: 4H context/bias ---' });
    content.push({ type: 'image', source: { type: 'base64', media_type: imgH4.mime, data: imgH4.base64 } });
  }
  if (imgM15) {
    content.push({ type: 'text', text: (imgH4 ? '--- Beeld 2: 15M uitvoering ---' : '--- Beeld 1: 15M uitvoering ---') });
    content.push({ type: 'image', source: { type: 'base64', media_type: imgM15.mime, data: imgM15.base64 } });
  }

  // ── 5) Anthropic-call ─────────────────────────────────────────────────
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

  // Kies het model waartegen we regel-checken. Voorkeur: AI's chosen_model
  // gematcht op naam (case-insensitive) tegen setupModels; anders eerste model.
  const chosenNameRaw = typeof setup.chosen_model === 'string' ? setup.chosen_model.trim() : '';
  const chosenModel = (setupModels || []).find(
    (m) => chosenNameRaw && String(m.name || '').toLowerCase() === chosenNameRaw.toLowerCase()
  ) || (setupModels && setupModels[0]) || null;

  // Normaliseer AI's per-eis-checks. Match op eis-id als de AI die teruggeeft,
  // anders op label (case-insensitive substring).
  const aiRequirements = Array.isArray(setup.requirements) ? setup.requirements : [];
  const requirementResults = chosenModel
    ? (chosenModel.requirements || []).map((r) => {
        const hit = aiRequirements.find((x) => {
          if (typeof x?.id === 'string' && UUID_RE.test(x.id) && x.id === r.id) return true;
          if (typeof x?.label === 'string' && r.label &&
              String(x.label).toLowerCase().trim() === String(r.label).toLowerCase().trim()) return true;
          return false;
        });
        return {
          id:     r.id,
          label:  r.label,
          kind:   r.kind,
          weight: Number(r.weight || 0),
          met:    !!hit?.met,
          note:   typeof hit?.note === 'string' ? hit.note.trim() : '',
        };
      })
    : [];

  // ── SERVER-SIDE REGEL-BEREKENING ──────────────────────────────────────
  // Formule (simpel + uitlegbaar):
  //   rule_required_ok = alle 'vereist'-eisen met=true
  //   rule_conf_score  = som van weight over 'confluentie'-eisen met met=true
  //   rule_valid       = rule_required_ok && rule_conf_score >= min_confluence
  //   rule_grade:
  //     - !rule_required_ok                                → 'C'
  //     - required_ok && conf_score >= 1.5 * min_confluence → 'A+'
  //     - required_ok && conf_score >= min_confluence      → 'B'
  //     - anders                                            → 'C'  (net onder drempel)
  //   Als er geen model is → rule_grade = 'n.v.t.'
  const reqOnly  = requirementResults.filter((r) => r.kind === 'vereist');
  const confOnly = requirementResults.filter((r) => r.kind === 'confluentie');
  const ruleRequiredOk = reqOnly.length > 0 && reqOnly.every((r) => r.met === true);
  const ruleConfScore  = confOnly.reduce((s, r) => (r.met ? s + Number(r.weight || 0) : s), 0);
  const minConf        = chosenModel ? Number(chosenModel.min_confluence || 0) : 0;
  let ruleGrade = 'n.v.t.';
  let ruleValid = false;
  if (chosenModel) {
    if (!ruleRequiredOk)                                        ruleGrade = 'C';
    else if (ruleConfScore >= 1.5 * minConf && ruleConfScore > 0) ruleGrade = 'A+';
    else if (ruleConfScore >= minConf)                          ruleGrade = 'B';
    else                                                        ruleGrade = 'C';
    ruleValid = ruleRequiredOk && ruleConfScore >= minConf;
  }

  const setupPayload = {
    // Legacy velden (AI-oordeel) blijven staan voor backward-compat readers.
    valid:   !!setup.valid,
    model:   typeof setup.model  === 'string' ? setup.model.trim()  : 'n.v.t.',
    grade:   GRADE_VALUES.has(setup.grade) ? setup.grade : 'n.v.t.',
    reason:  typeof setup.reason === 'string' ? setup.reason.trim() : '',
    missing: Array.isArray(setup.missing) ? setup.missing.filter((x) => typeof x === 'string') : [],
    // AI-oordeel (los).
    ai_valid: typeof setup.ai_valid === 'boolean' ? setup.ai_valid : !!setup.valid,
    ai_grade: GRADE_VALUES.has(setup.ai_grade) ? setup.ai_grade : (GRADE_VALUES.has(setup.grade) ? setup.grade : 'n.v.t.'),
    // Nieuwe regel-uitkomst (server-side berekend).
    chosen_model:     chosenModel ? chosenModel.name : (chosenNameRaw || null),
    chosen_model_id:  chosenModel ? chosenModel.id   : null,
    min_confluence:   minConf,
    requirements:     requirementResults,   // per-eis met/note
    rule_required_ok: ruleRequiredOk,
    rule_conf_score:  Math.round(ruleConfScore * 100) / 100,
    rule_valid:       ruleValid,
    rule_grade:       ruleGrade,
  };
  const aiSummary = setupPayload.reason || '';

  const detectionsIn = parsed.detections.map((d) => ({
    tool_name:  typeof d.tool_name === 'string' ? d.tool_name.trim() : '',
    tool_id:    (typeof d.matches_tool_id === 'string' && UUID_RE.test(d.matches_tool_id))
                  ? d.matches_tool_id : null,
    timeframe:  TF_VALUES.has(d.timeframe) ? d.timeframe : null,
    reason:     typeof d.reason === 'string' ? d.reason.trim() : '',
    confidence: CONFIDENCE_VALUES.has(d.confidence) ? d.confidence : 'midden',
  })).filter((d) => d.tool_name || d.reason);

  const validToolIds = new Set(tools.map((t) => t.id));
  detectionsIn.forEach((d) => {
    if (d.tool_id && !validToolIds.has(d.tool_id)) d.tool_id = null;
  });

  // ── 6) Opslaan ─────────────────────────────────────────────────────────
  // Nieuwe multi-TF-kolommen worden altijd geschreven. Legacy image_path /
  // source_url worden ook gevuld (best-effort naar wat er beschikbaar is)
  // zodat oude readers backward-compatible blijven werken. `source` reflecteert
  // welke bron voor het eerste beschikbare beeld gebruikt is.
  const primaryImage  = ingestH4?.image_path || ingestM15?.image_path || null;
  const primarySource = ingestH4?.source     || ingestM15?.source     || 'upload';
  const primarySrcUrl = ingestH4?.source_url || ingestM15?.source_url || null;

  const { data: analysisRow, error: aErr } = await supabaseAdmin.from('sa_chart_analyses')
    .insert({
      owner_id:        ctx.userId,
      image_path:      primaryImage,       // legacy — best-effort
      source_url:      primarySrcUrl,      // legacy — best-effort
      source:          primarySource,
      image_path_h4:   ingestH4?.image_path  || null,
      image_path_m15:  ingestM15?.image_path || null,
      source_url_h4:   ingestH4?.source_url  || null,
      source_url_m15:  ingestM15?.source_url || null,
      strategy_id:     strategy ? strategy.id : null,
      setup_verdict:   setupPayload,
      // De canonical grade op de tabelrij is de REGEL-uitkomst (server-side
      // berekend). Fallback op AI-grade als er geen model is voor deze
      // strategie (chosen_model=null). Behoudt backward-compat readers.
      grade:           setupPayload.rule_grade !== 'n.v.t.'
                         ? setupPayload.rule_grade
                         : setupPayload.ai_grade,
      ai_summary:      aiSummary,
    })
    .select('id, owner_id, image_path, source_url, source, image_path_h4, image_path_m15, source_url_h4, source_url_m15, strategy_id, setup_verdict, grade, ai_summary, created_at')
    .maybeSingle();
  if (aErr || !analysisRow) {
    console.error('[sa-analyze] insert analysis:', aErr?.message);
    return res.status(500).json({ error: 'Kon analyse niet opslaan', detail: aErr?.message });
  }

  let detections = [];
  if (detectionsIn.length) {
    const rows = detectionsIn.map((d) => ({
      owner_id:    ctx.userId,
      analysis_id: analysisRow.id,
      tool_id:     d.tool_id,
      tool_name:   d.tool_name,
      timeframe:   d.timeframe,
      ai_reason:   d.reason,
      confidence:  d.confidence,
      status:      'pending',
    }));
    const { data: dRows, error: dErr } = await supabaseAdmin.from('sa_analysis_detections')
      .insert(rows)
      .select('id, analysis_id, tool_id, tool_name, timeframe, ai_reason, confidence, status, user_note, created_at');
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
  // Voor multi-TF: kies het beeld dat bij het timeframe van de detectie
  // hoort. Fallback: legacy image_path (backward-compat) of de andere TF.
  let example_created = null;
  if (status === 'confirmed' && detection.tool_id) {
    const { data: analysis } = await supabaseAdmin.from('sa_chart_analyses')
      .select('image_path, image_path_h4, image_path_m15')
      .eq('id', detection.analysis_id).eq('owner_id', ctx.userId).maybeSingle();
    let chosenPath = null;
    if (analysis) {
      if (detection.timeframe === '4H')  chosenPath = analysis.image_path_h4  || analysis.image_path || analysis.image_path_m15 || null;
      else if (detection.timeframe === '15M') chosenPath = analysis.image_path_m15 || analysis.image_path || analysis.image_path_h4 || null;
      else                                    chosenPath = analysis.image_path || analysis.image_path_h4 || analysis.image_path_m15 || null;
    }
    if (chosenPath) {
      const insertPayload = {
        owner_id:   ctx.userId,
        tool_id:    detection.tool_id,
        kind:       'ideal',
        image_path: chosenPath,
        timeframe:  detection.timeframe || null,
        note:       userNote || detection.ai_reason || '',
      };
      // `timeframe` op sa_tool_examples is optioneel — als de kolom niet bestaat,
      // valt de insert terug op de andere velden. We laten Supabase de rest doen.
      const { data: exRow, error: exErr } = await supabaseAdmin.from('sa_tool_examples')
        .insert(insertPayload)
        .select('id')
        .maybeSingle();
      if (exErr) {
        // Fallback zonder timeframe (voor omgevingen waar die kolom nog niet bestaat).
        if (/timeframe|column/i.test(exErr.message || '')) {
          delete insertPayload.timeframe;
          const { data: exRow2, error: exErr2 } = await supabaseAdmin.from('sa_tool_examples')
            .insert(insertPayload).select('id').maybeSingle();
          if (exErr2) console.warn('[sa-analyze/confirm] example insert (retry):', exErr2.message);
          else example_created = exRow2?.id || null;
        } else {
          console.warn('[sa-analyze/confirm] example insert:', exErr.message);
        }
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
    .select('id, image_path, image_path_h4, image_path_m15, source_url, source_url_h4, source_url_m15, source, strategy_id, setup_verdict, grade, ai_summary, created_at')
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
      .select('id, analysis_id, tool_id, tool_name, timeframe, ai_reason, confidence, status, user_note, created_at')
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
