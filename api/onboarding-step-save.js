// api/onboarding-step-save.js
//
// PUBLIEK POST. Sla een tussentijdse step + answer-patch op.
// Input:
//   ?t=<token (uuid)>
//   Body: { answers (object: key→value patch), current_step (int) }
//
// Geen createUserClient — token = auth.
// Onbekend/ongeldig token → 404 met generieke shape (geen enumeratie-leak).
//
// Gedrag:
//   - status='afgerond'   → 409 (al afgerond, geen edits meer).
//   - status='gearchiveerd' → 409 (gesloten).
//   - answers worden SHALLOW gemerged per key in onboardings.answers.
//   - current_step wordt overschreven (integer, >=0).
//   - status='aangemeld' → bumpt naar 'bezig' + started_at=now() bij eerste save.
//   - updated_at altijd bumpen.
//
// Response 200: { ok:true, current_step }.

import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const token = req.query?.t ? String(req.query.t).trim() : null;
  if (!token || !UUID_RE.test(token)) {
    return res.status(400).json({ error: 'Link niet geldig.' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });

  const patch = (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers))
    ? body.answers
    : null;
  if (!patch) return res.status(400).json({ error: 'answers moet een object zijn.' });

  const stepRaw = body.current_step;
  const stepNum = Number(stepRaw);
  if (!Number.isFinite(stepNum) || !Number.isInteger(stepNum) || stepNum < 0) {
    return res.status(400).json({ error: 'current_step moet een niet-negatief geheel getal zijn.' });
  }

  // Security H3 — soft rate-limit per IP tegen spam. Ruimere cap dan de andere
  // twee: klanten kunnen legitiem elke paar seconden een auto-save doen tijdens
  // het invullen (30/min = 1 per 2s). Fail-open bij DB-fout.
  const rl = await checkRateLimit({ req, bucket: 'onboarding-step-save', maxHits: 30, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Te veel verzoeken, probeer later opnieuw.' });

  try {
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, started_at, answers')
      .eq('token', token)
      .maybeSingle();
    if (obErr) {
      console.error('[onboarding-step-save] lookup:', obErr.message);
      return res.status(500).json({ error: 'Kon link niet ophalen.' });
    }
    if (!ob) return res.status(404).json({ error: 'Link niet geldig.' });

    if (ob.status === 'afgerond') {
      return res.status(409).json({ error: 'Onboarding is al afgerond.' });
    }
    if (ob.status === 'gearchiveerd') {
      return res.status(409).json({ error: 'Onboarding is gesloten.' });
    }

    const prev = (ob.answers && typeof ob.answers === 'object') ? ob.answers : {};
    const merged = { ...prev, ...patch };

    const nowIso = new Date().toISOString();
    const updates = {
      answers      : merged,
      current_step : stepNum,
      updated_at   : nowIso,
    };
    if (ob.status === 'aangemeld') {
      updates.status     = 'bezig';
      updates.started_at = ob.started_at || nowIso;
    }

    const { error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update(updates)
      .eq('id', ob.id);
    if (updErr) {
      console.error('[onboarding-step-save] update:', updErr.message);
      return res.status(500).json({ error: 'Opslaan mislukt.' });
    }

    return res.status(200).json({ ok: true, current_step: stepNum });
  } catch (e) {
    console.error('[onboarding-step-save] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt.' });
  }
}
