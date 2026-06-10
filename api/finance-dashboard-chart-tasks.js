// api/finance-dashboard-chart-tasks.js
//
// Open Acties per type (chart C6 in roadmap). Telt rijen in pending_actions
// waar status IN ('PENDING','APPROVED') gegroepeerd per action_type.
//
// Concept: dit is de "wat staat er nu eigenlijk in mijn open-acties-bakje"
// breakdown — meest urgent ter beoordeling. action_type prefix:
//   - TL_*            -> arrangement-stappen (uitstel/split/etc)
//   - MANUAL_*        -> handmatige taken (verify-payment, escalation, follow-up)
//
// Naast count per action_type returnen we ook category-aggregaten zodat de
// frontend kan kiezen tussen ruwe types of pre-groep weergave (zelfde
// categorisatie als tasks-list.js).
//
// Response:
//   {
//     items: [
//       { actionType, label, count, category }, ...
//     ],
//     byCategory: { arrangement, verify_payment, escalation, manual_propose, manual_followup, other },
//     totalCount,
//     fromCache,
//   }
//
// RBAC: finance.module.access.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SWR_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();
const OPEN_STATUSES = ['PENDING', 'APPROVED'];

const ACTION_LABELS = {
  TL_INVOICE_UPDATE_DUE:       'Uitstel factuur',
  TL_INVOICE_SPLIT:            'Splitsing factuur',
  TL_SUBSCRIPTION_PAUSE:       'Abonnement pauze',
  TL_SUBSCRIPTION_STOP:        'Abonnement stop',
  TL_INVOICE_WRITEOFF:         'Kwijtschelding',
  MANUAL_VERIFY_PAYMENT:       'Verify betaling',
  MANUAL_ESCALATION:           'Escalatie',
  MANUAL_PROPOSE_ARRANGEMENT:  'Voorstel arrangement',
  MANUAL_FOLLOWUP:             'Follow-up',
};

function labelFor(actionType) {
  if (ACTION_LABELS[actionType]) return ACTION_LABELS[actionType];
  // Fallback: humanize unknown action_types.
  return String(actionType || '?')
    .replace(/^(TL|MANUAL)_/, '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

function categoryFor(actionType) {
  if (typeof actionType !== 'string') return 'other';
  if (actionType.startsWith('TL_'))                    return 'arrangement';
  if (actionType === 'MANUAL_VERIFY_PAYMENT')          return 'verify_payment';
  if (actionType === 'MANUAL_ESCALATION')              return 'escalation';
  if (actionType === 'MANUAL_PROPOSE_ARRANGEMENT')     return 'manual_propose';
  if (actionType === 'MANUAL_FOLLOWUP')                return 'manual_followup';
  return 'other';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.module.access)' });
  }

  const force = String(req.query?.force || '').toLowerCase() === 'true';
  if (!force) {
    const hit = _cache.get('default');
    if (hit && (Date.now() - hit.t) < SWR_TTL_MS) {
      return res.status(200).json({ ...hit.body, fromCache: true });
    }
  }

  try {
    // Selecteer minimal velden, agg client-side. Veronderstelde max-rows
    // pending+approved op dit moment <2k → in 1 call passend.
    const { data, error } = await supabaseAdmin
      .from('pending_actions')
      .select('id, action_type, status')
      .in('status', OPEN_STATUSES)
      .limit(5000);
    if (error) throw new Error('tasks-chart: ' + error.message);

    const countMap = new Map();
    const byCategory = {
      arrangement:     0,
      verify_payment:  0,
      escalation:      0,
      manual_propose:  0,
      manual_followup: 0,
      other:           0,
    };
    for (const r of (data || [])) {
      const at = r.action_type || 'UNKNOWN';
      countMap.set(at, (countMap.get(at) || 0) + 1);
      const cat = categoryFor(at);
      byCategory[cat] = (byCategory[cat] || 0) + 1;
    }

    const items = Array.from(countMap.entries())
      .map(([actionType, count]) => ({
        actionType,
        label:    labelFor(actionType),
        count,
        category: categoryFor(actionType),
      }))
      .sort((a, b) => b.count - a.count);

    const totalCount = items.reduce((s, it) => s + it.count, 0);

    const body = { items, byCategory, totalCount, fromCache: false };
    _cache.set('default', { t: Date.now(), body });
    return res.status(200).json(body);
  } catch (e) {
    console.error('[finance-dashboard-chart-tasks]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
