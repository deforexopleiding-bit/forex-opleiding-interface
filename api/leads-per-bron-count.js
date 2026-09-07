// api/leads-per-bron-count.js
// GET → aggregate leads-tellingen per `bron`-waarde (funnel-/acquisitie-herkomst).
// Gebruikt door de Leadsonderhoud → Funnels-tab. 1-op-1 gespiegeld op
// api/leads-per-traject-count.js (traject → bron).
//
// Canonieke definitie (identiek aan per-traject):
//   verwijderd_op IS NULL AND afwijzer IS NOT TRUE
//   AND email NOT ILIKE '%test%' AND email NOT ILIKE '%deforexopleiding%'
//
// Query-params:
//   period  'today' | 'week' | 'month' | 'all' (default 'all'); week = NL-maandag.
//   from/to YYYY-MM-DD (overrulet period), NL-tz-aware.
//
// Response: { total, by_bron, bron_labels, excluded, period, since }
// Permission: leads.view. Read-only.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { periodRange, nlDayStart, nlDayEndExclusive } from './_lib/nl-period.js';
import { computeLeadsByBron } from './_lib/leads-per-bron-compute.js';

function rangeForPeriod(p) {
  if (p === 'today') return periodRange('dag');
  if (p === 'week')  return periodRange('week');
  if (p === 'month') return periodRange('maand');
  return null; // 'all'
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function rangeForCustom(fromStr, toStr) {
  if (!ISO_DATE_RE.test(fromStr) || !ISO_DATE_RE.test(toStr)) return null;
  const start = nlDayStart(new Date(fromStr + 'T12:00:00Z'));
  const endExclusive = nlDayEndExclusive(new Date(toStr + 'T12:00:00Z'));
  if (endExclusive <= start) return null;
  return { start, endExclusive, label: fromStr };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const q = req.query || {};
    const periodRaw = String(q.period || 'all').toLowerCase();
    const period = ['today', 'week', 'month', 'all'].includes(periodRaw) ? periodRaw : 'all';
    const rawFrom = String(q.from || '').trim();
    const rawTo   = String(q.to   || '').trim();
    const customRange = rangeForCustom(rawFrom, rawTo);
    const range = customRange || rangeForPeriod(period);
    const since = range ? range.label : null;

    const out = await computeLeadsByBron({ supabaseAdmin, range });
    out.period = period;
    out.since  = since;
    return res.status(200).json(out);
  } catch (e) {
    console.error('[leads-per-bron-count]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
