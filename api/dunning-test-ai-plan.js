// POST /api/dunning-test-ai-plan
//
// Cockpit AI-tekstinvoer: neemt een vrij-tekst prompt van de super_admin,
// stuurt naar Anthropic (Claude Sonnet) via tool-use pattern, retourneert
// een gestructureerd cockpit-plan (array van stappen). UI toont het plan
// en vraagt bevestiging vóór executie.
//
// STUB-iteratie (BLOK 2 · iter 1): retourneert een vaste demo-response
// zodat de UI-koppeling gebouwd kan worden zonder API-token te verbranden.
// Iter 3 vervangt de stub door de echte Anthropic Messages API-call met
// forced tool_choice (zie docs/dunning-test-cockpit-blok2-scope.md).
//
// Body: { prompt: string, current_state?: object }
// Response: {
//   ok: true,
//   plan: {
//     reasoning: string,
//     steps: [{ action, params, explain }, ...]
//   }
// }

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

// Ondersteunde acties — moet aansluiten op ACTION_ROUTES uit
// dunning-test-trigger.js + de directe cockpit-endpoints
// (customer-create, invoice-create, reset, verify-grendel).
const ALLOWED_ACTIONS = new Set([
  'customer-create', 'invoice-create', 'reset', 'verify-grendel',
  'engine', 'conversation-reminders', 'bulk-send', 'breach-check',
  'fast-forward', 'simulate-inbound', 'mark-paid', 'send-test-template',
]);

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return 'plan ontbreekt';
  if (!Array.isArray(plan.steps)) return 'plan.steps moet array zijn';
  for (const [i, s] of plan.steps.entries()) {
    if (!ALLOWED_ACTIONS.has(s.action)) {
      return `steps[${i}].action '${s.action}' niet toegestaan`;
    }
  }
  return null;
}

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'ai_plan_request',
      scope:        'test',
      target:       {},
      payload:      { prompt_length: (payload?.prompt || '').length },
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

  // ── STUB (iter 1): vaste demo-plan zodat UI-koppeling ontwikkeld kan
  // worden zonder Anthropic-tokens te verbranden. Iter 3 vervangt dit
  // door een echte Claude-call met tool-use pattern.
  const plan = {
    reasoning: `[STUB] Demo-plan voor prompt "${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}". Iter 3: Claude Sonnet 4.6 forceert dit schema via tool_choice.`,
    steps: [
      {
        action:  'customer-create',
        params:  { full_name: 'Demo Klant', email: null, phone: null },
        explain: 'Nieuwe is_test-klant aanmaken (STUB).',
      },
      {
        action:  'verify-grendel',
        params:  {},
        explain: 'Bewijs dat de fail-closed grendel werkt (6/6 pass verwacht).',
      },
    ],
  };

  const err = validatePlan(plan);
  if (err) {
    await audit({ actor, payload: { prompt }, status: 'error', error: err });
    return res.status(500).json({ error: 'plan-validatie: ' + err });
  }

  await audit({ actor, payload: { prompt }, result: { step_count: plan.steps.length, stub: true }, status: 'ok' });

  return res.status(200).json({ ok: true, stub: true, plan });
}
