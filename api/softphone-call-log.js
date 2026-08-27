// api/softphone-call-log.js
// POST → log een uitgaand softphone-gesprek. Append-only.
//
// Permission: elke ingelogde CRM-user (via createUserClient auth-gate).
// Werknemer logt eigen calls; RLS regelt read-access (super_admin ziet alles,
// overige rollen alleen eigen rijen).
//
// Body:
//   { to_number: string (E.164), from_number?: string, line: 'nl'|'be',
//     started_at: ISO, ended_at?: ISO | null, outcome_hint?: enum,
//     customer_id?: uuid, lead_id?: uuid, meta?: object }
//
// duration_sec wordt SERVER-side berekend (client stuurt 'em niet mee).
// Fail-soft: retourneert 200 met `id` bij succes; 4xx bij validatie.
// De bel-flow mag hier NOOIT op wachten — fire-and-forget (klx-softphone
// hook doet dit al met fetch keepalive:false — geen await in de call-flow).
//
// Rate-limit: 10 POST/min/user als guard tegen storm/misbruik.
//
// Herstel-context (2026-08-27): dit bestand verdween in een rebase over 3
// parallelle commits tijdens #snapshot-B. 1:1 hersteld uit de #call-log-A-
// versie (client-hook in klx-softphone.js verwacht deze exacte body-shape).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const LINES = new Set(['nl','be']);
const OUTCOMES = new Set(['answered','no_answer','busy','failed','local_cancel']);
const MAX_META_BYTES = 2000;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const rl = await checkRateLimit({ req, bucket: 'softphone-call-log', maxHits: 10, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const body = req.body || {};
  const to_number = String(body.to_number || '').trim();
  if (!E164_RE.test(to_number)) return res.status(400).json({ error: 'to_number moet E.164 zijn (+31...)' });
  const line = String(body.line || '').trim().toLowerCase();
  if (!LINES.has(line)) return res.status(400).json({ error: "line moet 'nl' of 'be' zijn" });
  const started_at = body.started_at ? new Date(body.started_at) : null;
  if (!started_at || isNaN(started_at.getTime())) return res.status(400).json({ error: 'started_at (ISO) vereist' });
  const ended_at = body.ended_at ? new Date(body.ended_at) : null;
  if (body.ended_at && (!ended_at || isNaN(ended_at.getTime()))) return res.status(400).json({ error: 'ended_at ongeldig' });
  const from_number = body.from_number ? String(body.from_number).trim() : null;
  if (from_number && !E164_RE.test(from_number)) return res.status(400).json({ error: 'from_number ongeldig' });
  const outcome_hint = body.outcome_hint ? String(body.outcome_hint).trim() : null;
  if (outcome_hint && !OUTCOMES.has(outcome_hint)) return res.status(400).json({ error: 'outcome_hint ongeldig' });
  const customer_id = body.customer_id ? String(body.customer_id).trim() : null;
  if (customer_id && !UUID_RE.test(customer_id)) return res.status(400).json({ error: 'customer_id ongeldig' });
  const lead_id = body.lead_id ? String(body.lead_id).trim() : null;
  if (lead_id && !UUID_RE.test(lead_id)) return res.status(400).json({ error: 'lead_id ongeldig' });
  let meta = null;
  if (body.meta && typeof body.meta === 'object') {
    const s = JSON.stringify(body.meta);
    if (s.length > MAX_META_BYTES) return res.status(400).json({ error: `meta > ${MAX_META_BYTES} bytes` });
    meta = body.meta;
  }

  const duration_sec = (ended_at && started_at)
    ? Math.max(0, Math.round((ended_at.getTime() - started_at.getTime()) / 1000))
    : null;

  try {
    const { data, error } = await supabaseAdmin.from('call_log').insert({
      user_id: user.id, customer_id, lead_id,
      to_number, from_number, line,
      started_at: started_at.toISOString(),
      ended_at: ended_at ? ended_at.toISOString() : null,
      duration_sec, outcome_hint, source: 'klx_softphone',
      meta,
    }).select('id').single();
    if (error) throw new Error('call_log insert: ' + error.message);
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[softphone-call-log]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
