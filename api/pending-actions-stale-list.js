// GET /api/pending-actions-stale-list
//
// Read-only aggregatie: handmatige pending_actions die "te lang open"
// staan. Geen writes, geen status-wijziging. Voedt het widget in de
// Acties-tab van wanbetalers-v2.
//
// Whitelist bewust op DATA gebaseerd (SELECT action_type, count(*) FROM
// pending_actions GROUP BY 1). MANUAL_PROPOSE_ARRANGEMENT staat NIET in
// de whitelist — 0 rijen in productie. TL_*/workflow-getriggerd is
// bewust uitgesloten (die zijn geen mens-taken).
//
// Status-filter is NIET status='PENDING' alleen (te smal — we missen dan
// APPROVED-rijen die vastzitten en runs blokkeren, zoals de 20 MANUAL_
// CONFIRM_PROMISE die eerder werden gevonden). We filteren op de
// NIET-terminale set (PENDING/APPROVED/FAILED); REJECTED/EXECUTED/
// CANCELLED zijn klaar en horen niet in het stale-overzicht.
//
// Leeftijd: (now - created_at). NIET updated_at — die reset elke touch
// (snooze, payload-refresh, arrangement-hooks). Snooze-exclusie via
// scheduled_for; verlopen-exclusie via expires_at.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const MANUAL_ACTION_TYPES = [
  'MANUAL_ESCALATION',
  'MANUAL_VERIFY_PAYMENT',
  'MANUAL_FOLLOWUP',
  'MANUAL_CONFIRM_PROMISE',
];

// Niet-terminale statussen. Terminaal (uitgesloten) = REJECTED, EXECUTED,
// CANCELLED. FAILED telt als open omdat pending-actions-mark-not-executed
// hem daarop zet en pending-actions-restore hem er weer uit kan halen.
const NON_TERMINAL_STATUSES = ['PENDING', 'APPROVED', 'FAILED'];

const DEFAULT_THRESHOLD_DAYS = 3;

async function loadThresholdDays() {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'stale_manual_actions_threshold_days')
      .maybeSingle();
    const raw = data?.value?.days;
    const n = Number(raw);
    return (Number.isFinite(n) && n >= 0) ? n : DEFAULT_THRESHOLD_DAYS;
  } catch {
    return DEFAULT_THRESHOLD_DAYS;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Authn + authz zoals andere wanbetalers-endpoints.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  const allowed = await requirePermission(req, 'wanbetalers.tab.acties');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const thresholdDays = await loadThresholdDays();
  const cutoffIso = new Date(Date.now() - thresholdDays * 86400_000).toISOString();
  const nowIso    = new Date().toISOString();

  // Read-only SELECT met JOIN customers+invoices voor UI-context.
  const { data, error } = await supabaseAdmin
    .from('pending_actions')
    .select(`
      id, action_type, status, created_at, arrangement_id, invoice_id, customer_id,
      customer:customers(id, first_name, last_name, company_name, is_company),
      invoice:invoices(id, invoice_number, amount_total, amount_paid)
    `)
    .in('status', NON_TERMINAL_STATUSES)
    .in('action_type', MANUAL_ACTION_TYPES)
    .lt('created_at', cutoffIso)
    .or(`scheduled_for.is.null,scheduled_for.lte.${nowIso}`)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[pending-actions-stale-list] select error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  const rows = (data || []).map((r) => {
    const c = r.customer || {};
    const inv = r.invoice || null;
    const name = c.is_company
      ? (c.company_name || '—')
      : ([c.first_name, c.last_name].filter(Boolean).join(' ') || '—');
    const ageMs = Date.now() - new Date(r.created_at).getTime();
    return {
      id:             r.id,
      action_type:    r.action_type,
      status:         r.status,
      created_at:     r.created_at,
      age_days:       Math.floor(ageMs / 86400_000),
      customer:       { id: c.id || null, name },
      invoice: inv ? {
        id:          inv.id,
        number:      inv.invoice_number,
        amount_open: Number(inv.amount_total || 0) - Number(inv.amount_paid || 0),
      } : null,
      arrangement_id: r.arrangement_id || null,
    };
  });

  const countsByType = {};
  const countsByStatus = {};
  for (const t of MANUAL_ACTION_TYPES) countsByType[t] = 0;
  for (const s of NON_TERMINAL_STATUSES) countsByStatus[s] = 0;
  for (const r of rows) {
    countsByType[r.action_type]   = (countsByType[r.action_type]   || 0) + 1;
    countsByStatus[r.status]      = (countsByStatus[r.status]      || 0) + 1;
  }

  return res.status(200).json({
    threshold_days:   thresholdDays,
    total:            rows.length,
    counts_by_type:   countsByType,
    counts_by_status: countsByStatus,
    rows,
  });
}
