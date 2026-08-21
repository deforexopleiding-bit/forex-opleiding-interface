// api/leads-per-traject-count.js
// GET → aggregate leads-tellingen per traject-waarde uit leads_overzicht.
// Gebruikt door dashboard-v2 "Leads per traject"-tegels.
//
// Query-params:
//   period   optioneel — 'today' | 'week' | 'month' | 'all' (default 'all')
//            week = maandag als weekstart (NL-conventie)
//
// Response:
//   {
//     total: N,                             // som over alle trajecten (incl leeg)
//     by_traject: { '<traject>': N, ... },  // per exacte traject-waarde
//     traject_labels: ['<traject>', ...],   // gesorteerd (nl-locale)
//     period: 'all'|'today'|'week'|'month',
//     since: 'YYYY-MM-DD'|null,
//   }
//
// Permission: leads.view.
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay();
  const diff = day === 0 ? -6 : (1 - day);
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
}
function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function sinceForPeriod(p) {
  const now = new Date();
  if (p === 'today') return isoDate(now);
  if (p === 'week')  return isoDate(mondayOfWeek(now));
  if (p === 'month') return isoDate(startOfMonth(now));
  return null; // 'all'
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
    const since = sinceForPeriod(period);

    // Leads-overzicht is de canonical view — leads-trajecten en leads-list
    // gebruiken dezelfde bron.
    let qy = supabaseAdmin
      .from('leads_overzicht')
      .select('traject')
      .is('verwijderd_op', null)
      .limit(50000);
    if (since) qy = qy.gte('aangemaakt', since + 'T00:00:00');

    const { data, error } = await qy;
    if (error) throw new Error('leads_overzicht: ' + error.message);

    const by = Object.create(null);
    let total = 0;
    for (const row of (data || [])) {
      total += 1;
      const t = (row && row.traject != null) ? String(row.traject) : '';
      if (!t) continue;
      by[t] = (by[t] || 0) + 1;
    }
    const trajectLabels = Object.keys(by).sort((a, b) => a.localeCompare(b, 'nl'));

    // ALL-time traject-labels: welke labels bestaan überhaupt in de DB,
    // ongeacht periode. Voedt het dashboard zodat een tegel met period-count
    // 0 nog steeds getoond wordt (Event-aanmeldingen op Dag = 0 maar bestaat).
    // Alleen labels die HELEMAAL niet in de DB voorkomen worden verborgen.
    let allLabels = trajectLabels;
    if (since) {
      const { data: allData, error: allErr } = await supabaseAdmin
        .from('leads_overzicht')
        .select('traject')
        .is('verwijderd_op', null)
        .not('traject', 'is', null)
        .limit(50000);
      if (allErr) throw new Error('leads_overzicht(all): ' + allErr.message);
      allLabels = [...new Set((allData || []).map(r => String(r.traject)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'nl'));
    }

    return res.status(200).json({
      total,
      by_traject: by,
      traject_labels: trajectLabels,
      all_traject_labels: allLabels,
      period,
      since,
    });
  } catch (e) {
    console.error('[leads-per-traject-count]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
