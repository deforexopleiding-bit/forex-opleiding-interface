// api/secret-area-review.js
//
// POST — strategie-brede AI-review: smelt strategie + tools + condities +
// checklist tot ÉÉN setup-herkenning (recognition_spec). Owner-gated.
// Alle owner-scoped data wordt via supabaseAdmin gelezen (service-role).
//
// Body:  { strategy_id, model?, save? }
// Response 200: { spec, model, saved }
// Response 502: AnthropicClientError.
// Response 403: owner-gate faalt.
//
// Beveiliging:
//   - requireOwner(req) staat ALS EERSTE.
//   - Anthropic-call loopt via api/_lib/anthropic-client.js — geen eigen
//     fetch naar api.anthropic.com; ANTHROPIC_API_KEY blijft server-side.

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';
import { anthropicMessages, AnthropicClientError } from './_lib/anthropic-client.js';

const UUID_RE            = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL      = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 3000;
const ALLOWED_MODELS     = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
]);

function buildPrompt(strategy, tools, conditions, checklist, setupModels) {
  const lines = [];
  lines.push('Rol: je bent een quant-review-analyst voor discretionaire prijs-actie-strategieën.');
  lines.push('');
  lines.push('DATA — STRATEGIE');
  lines.push('- Naam: ' + (strategy.name || '(zonder naam)'));
  if (strategy.entry_signal) lines.push('- Entry-signaal: '   + strategy.entry_signal);
  if (strategy.sl_signal)    lines.push('- Stop-loss regel: ' + strategy.sl_signal);
  if (strategy.tp_signal)    lines.push('- Take-profit regel: ' + strategy.tp_signal);
  if (strategy.risk_pct != null) lines.push('- Risk %: ' + strategy.risk_pct);
  if (Array.isArray(strategy.sessions) && strategy.sessions.length) {
    lines.push('- Sessies: ' + strategy.sessions.join(', '));
  }
  if (Array.isArray(strategy.steps) && strategy.steps.length) {
    lines.push('- Stappen (Opbouw):');
    strategy.steps.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + (s.description || '')));
  }
  lines.push('');

  lines.push('DATA — TOOLS (definities + detectie-regels)');
  if (!Array.isArray(tools) || tools.length === 0) {
    lines.push('- (geen tools bekend in de workspace)');
  } else {
    tools.forEach((t) => {
      lines.push('- ' + (t.name || '(zonder naam)'));
      if (t.description)    lines.push('  Beschrijving: ' + t.description);
      if (t.detection_rule) lines.push('  Regel: ' + t.detection_rule);
    });
  }
  lines.push('');

  lines.push('DATA — MARKTCONDITIES');
  if (!Array.isArray(conditions) || conditions.length === 0) {
    lines.push('- (geen condities)');
  } else {
    const prefix = { filter: 'NOOIT als', voorwaarde: 'ALLEEN als', uitzondering: 'TENZIJ' };
    conditions.forEach((c) => {
      const scope = c.scope === 'global' ? '[GLOBAAL]' : '[STRATEGIE]';
      lines.push('- ' + scope + ' ' + (prefix[c.ctype] || c.ctype.toUpperCase()) + ': ' + (c.label || ''));
    });
  }
  lines.push('');

  lines.push('DATA — CHECKLIST (must-haves per setup)');
  if (!Array.isArray(checklist) || checklist.length === 0) {
    lines.push('- (geen checklist)');
  } else {
    checklist.forEach((c, i) => lines.push('  ' + (i + 1) + '. ' + (c.label || '')));
  }
  lines.push('');

  // Setup-modellen (eisen-laag). Per model: naam, min_confluence, vereist +
  // confluentie-eisen. Deze eisen zijn autoritatief: de recognition_spec MOET
  // ze per model expliciet uitspellen.
  if (Array.isArray(setupModels) && setupModels.length) {
    lines.push('DATA — SETUP-MODELLEN (eisen-laag; MOET expliciet in de recognition_spec verwerkt)');
    setupModels.forEach((m) => {
      lines.push('- MODEL "' + (m.name || '(zonder naam)') + '"  (min_confluence = ' + Number(m.min_confluence || 0) + ')');
      const req  = (m.requirements || []).filter((r) => r.kind === 'vereist');
      const conf = (m.requirements || []).filter((r) => r.kind === 'confluentie');
      if (req.length) {
        lines.push('  Vereist (moeten ALLEMAAL aanwezig zijn voor deze setup):');
        req.forEach((r) => lines.push('  · ' + (r.label || '')));
      }
      if (conf.length) {
        lines.push('  Confluentie (wegen mee tot min_confluence; weight tussen haakjes):');
        conf.forEach((r) => lines.push('  · ' + (r.label || '') + ' (weight ' + Number(r.weight || 0) + ')'));
      }
    });
    lines.push('');
  }

  lines.push('OPDRACHT');
  lines.push('Smelt bovenstaande tot ÉÉN setup-herkenning. Antwoord in het Nederlands, strikt zo:');
  lines.push('');
  if (Array.isArray(setupModels) && setupModels.length) {
    lines.push('1. Overzicht: welke sub-modellen kent deze strategie? Per model 1 zin die de kern beschrijft.');
    lines.push('2. Per model een blok met:');
    lines.push('   a. Vereiste condities (uitgeschreven — verwijs naar tool-namen waar nuttig, geef concrete drempels/candle-condities).');
    lines.push('   b. Confluentie-punten met hun weight en de min_confluence-drempel.');
    lines.push('   c. Beslisregel expliciet: "Geldig = alle X vereisten aanwezig ÉN som(confluentie-weights die aanwezig zijn) >= " + de min_confluence.');
    lines.push('3. Context-filters die meewegen (marktcondities; wanneer sla je een setup helemaal over?).');
    lines.push('4. Wat nog scherper moet (open vragen, ontbrekende definities, aanbevolen extra voorbeelden).');
  } else {
    lines.push('1. Setup in het kort (2–4 zinnen, concreet).');
    lines.push('2. Herkenning-condities samengevoegd (geordende bullet-lijst met concrete drempels/candle-condities; verwijs waar nuttig naar de tool-namen).');
    lines.push('3. Context-filters die meewegen (op basis van marktcondities; wanneer sla je over?).');
    lines.push('4. Wat nog scherper moet (open vragen, ontbrekende definities, aanbevolen extra voorbeelden).');
  }
  lines.push('');
  lines.push('Wees operationeel, geen theorie zonder toepassing. Verwerk expliciet elke conditie + elke checklist-item, en (als er setup-modellen zijn) elke vereist/confluentie-eis per model.');
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

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const strategyId = typeof body.strategy_id === 'string' ? body.strategy_id.trim() : '';
  if (!UUID_RE.test(strategyId)) return res.status(400).json({ error: 'strategy_id (uuid) vereist' });
  const wantSave = body.save === true;

  const modelReq = typeof body.model === 'string' ? body.model.trim() : '';
  const model = modelReq && ALLOWED_MODELS.has(modelReq) ? modelReq : DEFAULT_MODEL;

  try {
    const [
      { data: strat },
      { data: steps },
      { data: checklist },
      { data: tools },
      { data: cond },
      { data: setupModelsRaw },
    ] = await Promise.all([
      supabaseAdmin.from('sa_strategies')
        .select('*').eq('id', strategyId).eq('owner_id', ctx.userId).maybeSingle(),
      supabaseAdmin.from('sa_strategy_steps')
        .select('*').eq('strategy_id', strategyId).eq('owner_id', ctx.userId)
        .order('position', { ascending: true }),
      supabaseAdmin.from('sa_checklist_items')
        .select('*').eq('strategy_id', strategyId).eq('owner_id', ctx.userId)
        .order('position', { ascending: true }),
      // Alle tools van de owner (er is nog geen strategy-tool-koppel-tabel;
      // toevoegen kan later. Voor nu = "gebruikte tools" impliciet = alle
      // owner-tools met hun definitie + eventuele detection_rule).
      supabaseAdmin.from('sa_tools')
        .select('*').eq('owner_id', ctx.userId),
      // Condities: globaal + specifiek voor deze strategie.
      supabaseAdmin.from('sa_conditions')
        .select('*').eq('owner_id', ctx.userId).eq('active', true)
        .or('scope.eq.global,strategy_id.eq.' + strategyId),
      // Setup-modellen voor deze strategie (autoritatief voor de recognition_spec).
      supabaseAdmin.from('sa_setup_models')
        .select('id, name, min_confluence, position, active')
        .eq('owner_id', ctx.userId).eq('strategy_id', strategyId).eq('active', true)
        .order('position', { ascending: true }),
    ]);
    if (!strat) return res.status(404).json({ error: 'Strategie niet gevonden' });

    // Requirements-per-model ophalen voor de geladen setup-models.
    const setupModelIds = (setupModelsRaw || []).map((m) => m.id);
    let setupReqs = [];
    if (setupModelIds.length) {
      const { data: reqs } = await supabaseAdmin.from('sa_setup_requirements')
        .select('id, model_id, label, kind, weight, tool_id, position, active')
        .eq('owner_id', ctx.userId).in('model_id', setupModelIds)
        .order('position', { ascending: true });
      setupReqs = (reqs || []).filter((r) => r.active !== false);
    }
    const setupModels = (setupModelsRaw || []).map((m) => ({
      ...m,
      requirements: setupReqs.filter((r) => r.model_id === m.id),
    }));

    const promptText = buildPrompt(
      { ...strat, steps: steps || [] },
      tools || [],
      cond  || [],
      checklist || [],
      setupModels,
    );

    let apiResp;
    try {
      apiResp = await anthropicMessages({
        model,
        max_tokens: DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: [{ type: 'text', text: promptText }] }],
      });
    } catch (e) {
      if (e instanceof AnthropicClientError) {
        console.error('[sa-review] AnthropicClientError:', e.code, e.status, e.message);
        return res.status(502).json({
          error:  e.message || 'AI-call mislukt',
          code:   e.code   || 'ANTHROPIC_ERROR',
          status: e.status || null,
        });
      }
      throw e;
    }
    const spec = Array.isArray(apiResp?.content)
      ? apiResp.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
      : '';
    if (!spec) return res.status(502).json({ error: 'AI gaf geen tekst-antwoord', code: 'ANTHROPIC_EMPTY' });

    if (wantSave) {
      const { error: updErr } = await supabaseAdmin.from('sa_strategies')
        .update({ recognition_spec: spec })
        .eq('id', strategyId).eq('owner_id', ctx.userId);
      if (updErr) {
        console.warn('[sa-review] save recognition_spec:', updErr.message);
        return res.status(200).json({ spec, model, saved: false, save_error: updErr.message });
      }
    }
    return res.status(200).json({ spec, model, saved: !!wantSave });
  } catch (e) {
    console.error('[sa-review]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
