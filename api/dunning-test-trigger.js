// POST /api/dunning-test-trigger
//
// Multiplex-endpoint dat de bestaande wanbetalers-sandbox-*.js endpoints
// aanroept met de super_admin Bearer van de cockpit-user. Elke actie
// draait in test-scope (is_test-data alleen) en landt in test_cockpit_audit.
//
// Body: { action: string, params?: object }
//
// Ondersteunde acties (delegeren naar bestaand endpoint):
//   'engine'                → /api/wanbetalers-sandbox-run-engine
//   'conversation-reminders'→ /api/wanbetalers-sandbox-run-conversation-reminders
//   'bulk-send'             → /api/wanbetalers-sandbox-run-bulk
//   'breach-check'          → /api/wanbetalers-sandbox-run-breach-check
//   'fast-forward'          → /api/wanbetalers-sandbox-fast-forward
//   'simulate-inbound'      → /api/wanbetalers-sandbox-simulate-inbound
//   'mark-paid'             → /api/wanbetalers-sandbox-mark-paid
//   'send-test-template'    → /api/wanbetalers-sandbox-send-test-template
//
// Voor promise-maturity + conv-less-resume + eigen event-simulaties (payment/
// promise/complete-task) komt een uitbreiding in blok 2 — die hebben nog geen
// dedicated sandbox-endpoint.

import { supabaseAdmin } from './supabase.js';
import { requireSuperAdmin } from './_lib/wanbetalers-sandbox.js';

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';

const ACTION_ROUTES = {
  'engine':                 '/api/wanbetalers-sandbox-run-engine',
  'conversation-reminders': '/api/wanbetalers-sandbox-run-conversation-reminders',
  'bulk-send':              '/api/wanbetalers-sandbox-run-bulk',
  'breach-check':           '/api/wanbetalers-sandbox-run-breach-check',
  'fast-forward':           '/api/wanbetalers-sandbox-fast-forward',
  'simulate-inbound':       '/api/wanbetalers-sandbox-simulate-inbound',
  'mark-paid':              '/api/wanbetalers-sandbox-mark-paid',
  'send-test-template':     '/api/wanbetalers-sandbox-send-test-template',
};

async function audit({ actor, payload, result, status, error }) {
  try {
    await supabaseAdmin.from('test_cockpit_audit').insert({
      triggered_by: actor?.userId || null,
      admin_email:  actor?.email || null,
      action:       'trigger_' + (payload?.action || 'unknown'),
      scope:        'test',
      target:       payload?.params || {},
      payload:      { action: payload?.action, route: payload?.route },
      result:       result || {},
      status,
      error_message: error || null,
    });
  } catch (e) {
    console.error('[dunning-test-trigger] audit insert failed:', e?.message || e);
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
  const action = String(body.action || '').trim();
  const params = body.params || {};

  if (!action) return res.status(400).json({ error: 'action is verplicht.' });
  const route = ACTION_ROUTES[action];
  if (!route) {
    return res.status(400).json({
      error: `Onbekende action '${action}'. Kies uit: ${Object.keys(ACTION_ROUTES).join(', ')}.`,
    });
  }

  // Forward de super_admin Bearer die de cockpit-user meestuurde. Alle
  // wanbetalers-sandbox-*.js endpoints doen dezelfde requireSuperAdmin-check
  // dus deze token slaagt daar ook.
  const authHeader = req.headers.authorization || '';
  if (!authHeader) {
    return res.status(401).json({ error: 'Bearer-token ontbreekt (kan niet forwarden).' });
  }

  const targetUrl = BASE_URL + route;
  let result;
  try {
    const r = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify(params),
    });
    const raw = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = { raw: raw.slice(0, 500) }; }
    result = { http_status: r.status, response: parsed };
    if (!r.ok) {
      await audit({ actor, payload: { action, route, params }, result, status: 'error', error: `HTTP ${r.status}` });
      return res.status(r.status).json({ ok: false, ...result });
    }
    await audit({ actor, payload: { action, route, params }, result, status: 'ok' });
    return res.status(200).json({ ok: true, action, ...result });
  } catch (e) {
    await audit({ actor, payload: { action, route, params }, status: 'error', error: e?.message || String(e) });
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
