// api/joost-suggestions-recent.js
// GET -> haal de meest recente bruikbare Joost-suggestie voor een conversatie op.
//
// Doel (E1.1 UX): zodra een medewerker een conv opent in de Finance Inbox kunnen
// we de "auto-suggested" suggestie die door de webhook is gegenereerd direct
// tonen, zonder dat hij eerst op "Vraag Joost om suggestie" hoeft te klikken.
//
// Statussen die worden teruggegeven (voorrangsvolgorde):
//   1) PROPOSED                       — nog geen outcome, klaar voor mens
//   2) BLOCKED_LOW_CONFIDENCE         — LLM twijfelde; suggested_reply zit er wel
//   3) BLOCKED_INTENT_DISABLED        — intent staat uit; draft is bruikbaar
//   4) BLOCKED_COMMUNICATION_LIMIT    — buiten kantooruren / rate-limit; draft bruikbaar
//   5) BLOCKED_MANDATE_EXCEEDED       — voorstel buiten mandaat; mens controleert
//   6) BLOCKED_AUTONOMY_PAUSED        — autonomy gepauzeerd; mens beslist
//
// PROPOSED heeft altijd voorrang; als die er niet is pakken we de meest recente
// BLOCKED_* (met suggested_reply). Response bevat status + is_blocked_draft +
// blocked_reason_label zodat de UI een waarschuwings-badge kan tonen.
//
// Filter: binnen `max_age_minutes`-venster (default 10 minuten — past bij de
// versheid van een inbox-conversatie zonder eindeloos oude suggesties te tonen)
// EN suggested_reply IS NOT NULL / niet-leeg (edge: BLOCKED_LOW_CONFIDENCE-
// fallback bij no_decision heeft geen tekst; die willen we niet tonen).
//
// Permission per module:
//   finance     → finance.joost.use      (consistent met joost-suggest)
//   events      → events.simone.use      (consistent met simone-suggest)
//   onboarding  → onboarding.mila.use    (consistent met onboarding-suggest)
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
import { checkOnboardingConvAccess } from './_lib/onboardingScope.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_AGE_MIN = 10;
const HARD_MAX_AGE_MIN    = 60;

// Statussen waar de LLM een bruikbare suggested_reply heeft geproduceerd —
// PROPOSED én de 5 BLOCKED_*-drafts die de autonomy-gate blokkeerde. Zie
// header-comment voor rationale.
const OUTCOMEABLE_STATUSES = [
  'PROPOSED',
  'BLOCKED_LOW_CONFIDENCE',
  'BLOCKED_INTENT_DISABLED',
  'BLOCKED_COMMUNICATION_LIMIT',
  'BLOCKED_MANDATE_EXCEEDED',
  'BLOCKED_AUTONOMY_PAUSED',
];

const BLOCKED_REASON_LABELS = {
  BLOCKED_LOW_CONFIDENCE:      'Joost twijfelde (lage confidence)',
  BLOCKED_INTENT_DISABLED:     'Intent staat uit — controleer voor je stuurt',
  BLOCKED_COMMUNICATION_LIMIT: 'Buiten kantooruren of rate-limit — bewust bevestigen',
  BLOCKED_MANDATE_EXCEEDED:    'Voorstel buiten mandaat — controleer bedrag/termijnen',
  BLOCKED_AUTONOMY_PAUSED:     'Autonomy gepauzeerd — mens beslist',
};

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

  // ---- Module-param ----
  // Default 'finance' zodat bestaande finance-callers byte-identiek blijven
  // (zelfde precedent als inbox-conversations-list / joost-config-get).
  const moduleKey = typeof req.query.module === 'string'
    ? req.query.module.trim().toLowerCase()
    : 'finance';
  if (moduleKey !== 'finance' && moduleKey !== 'events' && moduleKey !== 'onboarding') {
    return res.status(400).json({ error: 'module moet finance, events of onboarding zijn' });
  }

  // ---- Permission (per module) ----
  const PERM_BY_MODULE = {
    finance:    'finance.joost.use',
    events:     'events.simone.use',
    onboarding: 'onboarding.mila.use',
  };
  const permKey = PERM_BY_MODULE[moduleKey];
  if (!(await requirePermission(req, permKey))) {
    return res.status(403).json({ error: 'Geen rechten (' + permKey + ')' });
  }

  // ---- Query params ----
  const convId = typeof req.query.conversation_id === 'string'
    ? req.query.conversation_id.trim()
    : '';
  if (!convId) return res.status(400).json({ error: 'conversation_id vereist' });
  if (!isUuid(convId)) {
    return res.status(400).json({ error: 'conversation_id moet geldige uuid zijn' });
  }

  // ---- Fase 2b: mentor-scoping op onboarding-tak ----
  // Conv-fetch alleen voor ACL. Skipt voor seesAll + voor finance/events-convs.
  try {
    const { data: convAcl } = await supabaseAdmin
      .from('whatsapp_conversations')
      .select('phone_number_id, customer_id')
      .eq('id', convId)
      .maybeSingle();
    if (convAcl) {
      const acl = await checkOnboardingConvAccess(req, {
        phoneNumberId: convAcl.phone_number_id,
        customerId:    convAcl.customer_id,
      });
      if (!acl.ok) return res.status(acl.status).json({ error: acl.error });
    }
  } catch (e) {
    console.error('[joost-suggestions-recent] ACL lookup:', e?.message || e);
    return res.status(500).json({ error: 'Toegangscontrole faalde' });
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

    // Voor module=events en module=onboarding filteren we strikt op die
    // exact-match module zodat we geen finance-suggestion teruggeven aan de
    // Simone-/Mila-UI. Voor module=finance (default) skippen we de eq-filter
    // zodat byte-identiek pre-stap-2c gedrag behouden blijft (legacy rijen
    // zonder module-discriminator matchen gewoon mee — backwards-compat met
    // de pre-E1.x history).
    // Fetch alle OUTCOMEABLE-statussen binnen het venster; client-side kiezen
    // we met voorrang PROPOSED. Limit 10 = ruim: normaal is er 1 PROPOSED per
    // conv; blocked drafts stacken zelden. suggested_reply NOT NULL filtert
    // de defensieve BLOCKED_LOW_CONFIDENCE-fallback (no_decision zonder tekst).
    let q = supabaseAdmin
      .from('joost_suggestions')
      .select(`
        id, conversation_id, status, suggested_reply, detected_intent, confidence,
        reasoning, auto_triggered, created_at, module
      `)
      .eq('conversation_id', convId)
      .in('status', OUTCOMEABLE_STATUSES)
      .not('suggested_reply', 'is', null)
      .gte('created_at', cutoffIso)
      .order('created_at', { ascending: false })
      .limit(10);
    if (moduleKey === 'events')     q = q.eq('module', 'events');
    if (moduleKey === 'onboarding') q = q.eq('module', 'onboarding');
    const { data, error } = await q;

    if (error) throw new Error('joost-suggestions-lookup: ' + error.message);

    const rows = (Array.isArray(data) ? data : []).filter(
      (r) => r.suggested_reply && String(r.suggested_reply).trim() !== '',
    );
    if (!rows.length) return res.status(200).json({ suggestion: null });

    // PROPOSED heeft voorrang; anders de recentste bruikbare BLOCKED_*.
    const row = rows.find((r) => r.status === 'PROPOSED') || rows[0];
    const isBlockedDraft = row.status !== 'PROPOSED';

    return res.status(200).json({
      suggestion: {
        id:                  row.id,
        conversation_id:     row.conversation_id,
        status:              row.status,
        suggested_reply:     row.suggested_reply,
        detected_intent:     row.detected_intent,
        confidence:          row.confidence,
        reasoning:           row.reasoning,
        auto_triggered:      !!row.auto_triggered,
        created_at:          row.created_at,
        is_blocked_draft:    isBlockedDraft,
        blocked_reason_label: isBlockedDraft ? (BLOCKED_REASON_LABELS[row.status] || row.status) : null,
      },
    });
  } catch (e) {
    console.error('[joost-suggestions-recent]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
