// POST /api/dunning-test-ai-plan
//
// Cockpit AI-tekstinvoer: neemt een vrij-tekst prompt van de super_admin
// en stuurt naar Anthropic (Claude Sonnet 5) via het tool-use pattern met
// forced tool_choice, zodat Claude ALTIJD via de tool antwoordt (geen
// prose-fallback, geen JSON.parse-hacks). Retourneert een gestructureerd
// cockpit-plan dat de client daarna via custom-confirm laat uitvoeren.
//
// Body: { prompt: string, current_state?: object }
// Response (ok):    { ok: true, plan: { reasoning, steps: [...] } }
// Response (fail):  { error: string }
//
// Beveiliging (fail-closed op alle lagen):
//   - Super_admin-only server-side (requireSuperAdmin).
//   - API-key server-side (process.env.ANTHROPIC_API_KEY), NOOIT naar client.
//   - Tool-schema forceert action ∈ ALLOWED_ACTIONS (JSON-schema enum).
//   - Post-response validatePlan() gooit ongeldige plans weg vóór ze de
//     UI bereiken — geen half-geldig plan wordt teruggegeven.
//   - Audit-insert op elke aanroep (alleen prompt_length, geen prompt-
//     content, geen antwoord-content — privacy-safe).
//
// De client voert het plan uit door dezelfde cockpit-endpoints aan te
// roepen als de blok-bouwer (customer-create / invoice-create / reset /
// verify-grendel / dunning-test-trigger). NOOIT een directe send.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';
import { anthropicMessages, DEFAULT_MODEL } from './_lib/anthropic-client.js';

// ── Whitelist van toegestane cockpit-acties ──────────────────────────────
// Moet 1-op-1 gelijk blijven aan de client-side action-routes (blok-bouwer
// _cockpitEndpointFor). Nieuwe actie? Beide plekken updaten.
const ALLOWED_ACTIONS = [
  'customer-create',
  'invoice-create',
  'reset',
  'verify-grendel',
  'engine',
  'conversation-reminders',
  'bulk-send',
  'breach-check',
  'fast-forward',
  'simulate-inbound',
  'mark-paid',
  'send-test-template',
  // Real-wiring: elk van deze routeert nu naar een echte, is_test-gescopete
  // backend (zie _cockpitEndpointFor + ACTION_ROUTES in trigger.js).
  // simulate-silence blijft de enige noop-audit action.
  'promise-maturity',
  'conv-less-resume',
  'wik-brief',
  'simulate-promise',
  'simulate-silence',
  'create-task',
  'complete-task',
  'resume-run',
];
const ALLOWED_ACTIONS_SET = new Set(ALLOWED_ACTIONS);

// ── Plan-validatie (hard throw op mismatch — geen half-geldig plan) ──────
function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return 'plan ontbreekt of is geen object';
  if (typeof plan.reasoning !== 'string' || !plan.reasoning.trim()) {
    return 'plan.reasoning ontbreekt of is leeg';
  }
  if (!Array.isArray(plan.steps)) return 'plan.steps moet een array zijn';
  if (plan.steps.length === 0) return 'plan.steps mag niet leeg zijn';
  if (plan.steps.length > 12)  return 'plan.steps mag max 12 entries hebben';
  for (const [i, s] of plan.steps.entries()) {
    if (!s || typeof s !== 'object')          return `steps[${i}] is geen object`;
    if (typeof s.action !== 'string')          return `steps[${i}].action ontbreekt`;
    if (!ALLOWED_ACTIONS_SET.has(s.action)) {
      return `steps[${i}].action '${s.action}' niet in whitelist (${ALLOWED_ACTIONS.join(', ')})`;
    }
    if (s.params !== undefined && (typeof s.params !== 'object' || s.params === null || Array.isArray(s.params))) {
      return `steps[${i}].params moet een object zijn`;
    }
    if (typeof s.explain !== 'string' || !s.explain.trim()) {
      return `steps[${i}].explain ontbreekt of is leeg`;
    }
  }
  return null;
}

// ── Tool-definitie voor Anthropic (forced tool_choice) ────────────────────
const CLAUDE_TOOL = {
  name: 'emit_cockpit_plan',
  description: 'Retourneer een uitvoerbaar plan voor de dunning test cockpit. Elke stap moet exact één toegestane cockpit-actie zijn. Retourneer ALLEEN via deze tool — geen prose.',
  input_schema: {
    type: 'object',
    properties: {
      reasoning: {
        type: 'string',
        description: '1-2 zinnen: waarom deze stappen deze intentie oplossen. In het Nederlands.',
      },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 12,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ALLOWED_ACTIONS },
            params: {
              type: 'object',
              description: 'Payload voor de cockpit-endpoint. Voor invoice-create-stappen die de laatst-aangemaakte klant willen hergebruiken: gebruik { __use_last_customer: true, invoices: [...] }.',
            },
            explain: {
              type: 'string',
              description: 'Korte NL-toelichting voor de super_admin (verschijnt in de custom-confirm-dialoog).',
            },
          },
          required: ['action', 'explain'],
        },
      },
    },
    required: ['reasoning', 'steps'],
  },
};

const SYSTEM_PROMPT = `Je bent de plan-genererende AI voor de Dunning Test Cockpit van De Forex Opleiding.
Doel: vertaal de vrije-tekst intentie van een super_admin naar een uitvoerbaar plan van
maximaal 12 cockpit-stappen. Retourneer ALLEEN via de tool 'emit_cockpit_plan'.

Toegestane acties (whitelist):
${ALLOWED_ACTIONS.map(a => '  - ' + a).join('\n')}

Regels:
- Elke stap MOET één van bovenstaande acties zijn — nooit iets anders.
- Voor scenario's die eerst een test-klant nodig hebben: start met 'customer-create'
  (met een korte NL-naam in params.full_name).
- Voor 'invoice-create' bij dezelfde klant: gebruik { __use_last_customer: true,
  invoices: [{ amount, days_late, scenario_tag }] }.
- Voor 'simulate-inbound' / 'mark-paid': gebruik { __use_last_customer: true }.
- Motor-triggers ('engine', 'conversation-reminders', 'bulk-send', 'breach-check',
  'fast-forward'): meestal geen params nodig.
- 'reset' met { dry_run: true } is een tellings-preview; { dry_run: false } wist echt.
- Gebruik nooit 'reset' met dry_run:false zonder expliciete instructie van de user.
- Geef een korte NL-explain per stap zodat de super_admin ziet wat er zou gebeuren.
- Alles is is_test-gescoped en de grendel routeert verzending naar de sandbox-
  ontvanger — je hoeft je geen zorgen te maken over echte klant-verzending.`;

async function audit({ actor, payload, result, status, error }) {
  try {
    // Privacy-safe projection: NOOIT de volledige prompt of Claude's
    // reasoning in audit-payload. Alleen length + model + action-lijst.
    const safePayload = {
      prompt_length: typeof payload?.prompt_length === 'number' ? payload.prompt_length : null,
      model:         payload?.model || null,
    };
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'ai_plan_request',
      scope:        'test',
      target:       {},
      payload:      safePayload,
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-ai-plan] audit insert failed:', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await requireSuperAdmin(req, res);
  if (!admin) return;

  const actor = { userId: admin.user.id, email: admin.profile.email };
  const body = req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'prompt is verplicht.' });
  if (prompt.length > 2000) return res.status(400).json({ error: 'prompt te lang (max 2000 chars).' });

  // Optionele current_state als context (max 2KB — voorkomt token-blowup).
  const currentState = (body.current_state && typeof body.current_state === 'object')
    ? JSON.stringify(body.current_state).slice(0, 2000)
    : null;

  const userContent = [
    currentState ? `Huidige cockpit-state (JSON, ter context):\n${currentState}\n` : '',
    `Intentie van de super_admin:\n${prompt}`,
  ].filter(Boolean).join('\n');

  // Model uit centrale constante _lib/anthropic-client.js — geen hardcoded
  // string zodat een model-bump op één plek plaatsvindt.
  const MODEL = DEFAULT_MODEL;
  const promptLen = prompt.length;

  let claudeResp;
  try {
    claudeResp = await anthropicMessages({
      model:       MODEL,
      max_tokens:  2048,
      temperature: 0.2,
      system:      SYSTEM_PROMPT,
      messages:    [{ role: 'user', content: userContent }],
      tools:       [CLAUDE_TOOL],
      // Forceer Claude om via de tool te antwoorden — geen prose-fallback.
      tool_choice: { type: 'tool', name: 'emit_cockpit_plan' },
    });
  } catch (e) {
    // AnthropicClientError met ANTHROPIC_KEY_MISSING → 500 (config).
    const isConfig = e?.code === 'ANTHROPIC_KEY_MISSING';
    await audit({ actor, payload: { prompt_length: promptLen, model: MODEL }, status: 'error', error: e?.message || String(e) });
    return res.status(isConfig ? 500 : 502).json({ error: (isConfig ? 'AI-integratie niet geconfigureerd: ' : 'Anthropic-call faalde: ') + (e?.message || String(e)) });
  }

  // Extract tool_use blok. Bij forced tool_choice hoort Claude via deze tool
  // te antwoorden; zo niet → weigeren.
  const toolUseBlock = (claudeResp?.content || []).find(b => b?.type === 'tool_use' && b?.name === 'emit_cockpit_plan');
  if (!toolUseBlock || !toolUseBlock.input) {
    await audit({ actor, payload: { prompt_length: promptLen, model: MODEL }, result: { stop_reason: claudeResp?.stop_reason }, status: 'error', error: 'geen tool_use blok in Claude-response' });
    return res.status(502).json({ error: 'Claude retourneerde geen tool-use antwoord (forced tool_choice werd genegeerd).' });
  }

  const plan = toolUseBlock.input;
  const err = validatePlan(plan);
  if (err) {
    await audit({ actor, payload: { prompt_length: promptLen, model: MODEL }, result: { step_count: plan?.steps?.length ?? 0 }, status: 'error', error: 'plan-validatie: ' + err });
    return res.status(422).json({ error: 'Plan geweigerd: ' + err });
  }

  await audit({
    actor,
    payload: { prompt_length: promptLen, model: MODEL },
    result:  { step_count: plan.steps.length, actions: plan.steps.map(s => s.action) },
    status:  'ok',
  });

  return res.status(200).json({ ok: true, plan, model: MODEL });
}
