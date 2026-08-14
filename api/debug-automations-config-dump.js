// api/debug-automations-config-dump.js
//
// TIJDELIJK diagnose-endpoint voor v2 Automatiseringen berichten-body onderzoek.
// Dumpt keys + veld-lengtes (GEEN inhoud) van step.config voor alle send_email
// en send_whatsapp steps in event_automations + onboarding_automations.
//
// GEBRUIK (browser-console, ingelogd als super_admin):
//   const t = (await window.KV.getAccessToken?.()) || '';
//   const r = await fetch('/api/debug-automations-config-dump', {
//     headers: { Authorization: `Bearer ${t}` }
//   });
//   console.log(JSON.stringify(await r.json(), null, 2));
//
// Response:
//   { events: [{ id, name, step_index, type, keys: [{k, kind, len}] }, ...],
//     onboarding: [ ... ] }
//   waarbij kind = 'string'|'number'|'boolean'|'object'|'array'|'null'
//   en len = string-length (voor string), array-length (voor array), Object.keys().length (voor object)
//
// Permission: super_admin (hard-gate). GEEN body-inhoud in response — alleen shape.

import { createUserClient, supabaseAdmin } from './supabase.js';

const asArr = (x) => Array.isArray(x) ? x : [];

function describeValue(v) {
  if (v === null || v === undefined) return { kind: 'null', len: 0 };
  if (typeof v === 'string')  return { kind: 'string',  len: v.length };
  if (typeof v === 'number')  return { kind: 'number',  len: 0 };
  if (typeof v === 'boolean') return { kind: 'boolean', len: 0 };
  if (Array.isArray(v))       return { kind: 'array',   len: v.length };
  if (typeof v === 'object')  return { kind: 'object',  len: Object.keys(v).length };
  return { kind: typeof v, len: 0 };
}

function dumpStep(config) {
  const cfg = (config && typeof config === 'object') ? config : {};
  return Object.keys(cfg).map((k) => ({ k, ...describeValue(cfg[k]) }));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const { data: prof } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (!prof || prof.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin only' });
  }

  try {
    const [ev, ob] = await Promise.all([
      supabaseAdmin.from('event_automations').select('id, name, steps'),
      supabaseAdmin.from('onboarding_automations').select('id, name, steps'),
    ]);
    if (ev.error) throw ev.error;
    if (ob.error) throw ob.error;

    const dumpTable = (rows) => {
      const out = [];
      for (const a of asArr(rows)) {
        const steps = asArr(a.steps);
        steps.forEach((step, idx) => {
          if (!step || typeof step !== 'object') return;
          if (step.type !== 'send_email' && step.type !== 'send_whatsapp') return;
          out.push({
            automation_id: a.id,
            automation_name: a.name || '(geen naam)',
            step_index: idx,
            type: step.type,
            keys: dumpStep(step.config),
          });
        });
      }
      return out;
    };

    return res.status(200).json({
      events:     dumpTable(ev.data || []),
      onboarding: dumpTable(ob.data || []),
      note: 'Alleen keys + kind + len. GEEN body-inhoud.',
    });
  } catch (e) {
    console.error('[debug-automations-config-dump]', e.message);
    return res.status(500).json({ error: e.message || 'Interne fout' });
  }
}
