// api/joost-suggestions-recent.js
// GET -> haal de meest recente PROPOSED Joost-suggestie voor een conversatie op.
//
// Doel (E1.1 UX): zodra een medewerker een conv opent in de Finance Inbox kunnen
// we de "auto-suggested" suggestie die door de webhook is gegenereerd direct
// tonen, zonder dat hij eerst op "Vraag Joost om suggestie" hoeft te klikken.
//
// Filter: alleen suggesties met status='PROPOSED' (anders is er al een outcome
// geregistreerd en willen we die niet opnieuw aanbieden) EN binnen het
// `max_age_minutes`-venster (default 10 minuten — past bij de versheid van een
// inbox-conversatie zonder eindeloos oude suggesties te tonen).
//
// Permission: finance.joost.use (consistent met joost-suggest endpoint).
//
// Query params:
//   conversation_id   uuid    (verplicht)
//   max_age_minutes   integer (optioneel, default 10, max 60)
//
// Response 200:
//   { suggestion: { id, conversation_id, suggested_reply, detected_intent,
//                   confidence, reasoning, auto_triggered, created_at } | null }
//
// Error responses:
//   400  conversation_id ontbreekt / ongeldige uuid
//   401  geen sessie
//   403  geen rechten
//   405  method not allowed
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_AGE_MIN = 10;
const HARD_MAX_AGE_MIN    = 60;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission ----
  if (!(await requirePermission(req, 'finance.joost.use'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.joost.use)' });
  }

  // ---- Query params ----
  const convId = typeof req.query.conversation_id === 'string'
    ? req.query.conversation_id.trim()
    : '';
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convId)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  let maxAgeMin = DEFAULT_MAX_AGE_MIN;
  if (req.query.max_age_minutes != null) {
    const parsed = parseInt(String(req.query.max_age_minutes), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxAgeMin = Math.min(parsed, HARD_MAX_AGE_MIN);
    }
  }

  try {
    const cutoffIso = new Date(Date.now() - maxAgeMin * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('joost_suggestions')
      .select(`
        id, conversation_id, suggested_reply, detected_intent, confidence,
        reasoning, auto_triggered, created_at
      `)
      .eq('conversation_id', convId)
      .eq('status', 'PROPOSED')
      .gte('created_at', cutoffIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw new Error('joost-suggestions-lookup: ' + error.message);

    const row = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!row) return res.status(200).json({ suggestion: null });

    return res.status(200).json({
      suggestion: {
        id:              row.id,
        conversation_id: row.conversation_id,
        suggested_reply: row.suggested_reply,
        detected_intent: row.detected_intent,
        confidence:      row.confidence,
        reasoning:       row.reasoning,
        auto_triggered:  !!row.auto_triggered,
        created_at:      row.created_at,
      },
    });
  } catch (e) {
    console.error('[joost-suggestions-recent]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
