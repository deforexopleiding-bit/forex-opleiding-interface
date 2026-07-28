// api/leads-stats.js
// GET → 3 tellers voor de bovenkant van leads.html:
//   vandaag           — leads binnengekomen vandaag (aangemaakt::date = today)
//   nieuw             — status='nieuw' (nog niet opgevolgd)
//   week_gekwalificeerd — tag='gekwalificeerd' EN aangemaakt >= start-week
//                         (maandag als week-start, NL-conventie)
// Permission: leads.view.
//
// Response: { vandaag: N, nieuw: N, week_gekwalificeerd: N, today: 'YYYY-MM-DD', week_start: 'YYYY-MM-DD' }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mondayOfWeek(d) {
  const day = d.getDay();                          // 0=zon, 1=maa, ..., 6=zat
  const diff = day === 0 ? -6 : (1 - day);         // schuif naar maandag
  const m = new Date(d);
  m.setDate(d.getDate() + diff);
  m.setHours(0, 0, 0, 0);
  return m;
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
    const now = new Date();
    const today = isoDate(now);
    const weekStart = isoDate(mondayOfWeek(now));

    const [vRes, nRes, wRes] = await Promise.all([
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .gte('aangemaakt', today + 'T00:00:00')
        .lte('aangemaakt', today + 'T23:59:59.999'),
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'nieuw'),
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .eq('tag', 'gekwalificeerd')
        .gte('aangemaakt', weekStart + 'T00:00:00'),
    ]);
    if (vRes.error) throw new Error('vandaag: ' + vRes.error.message);
    if (nRes.error) throw new Error('nieuw: '   + nRes.error.message);
    if (wRes.error) throw new Error('week: '    + wRes.error.message);

    return res.status(200).json({
      vandaag:              vRes.count || 0,
      nieuw:                nRes.count || 0,
      week_gekwalificeerd:  wRes.count || 0,
      today, week_start: weekStart,
    });
  } catch (e) {
    console.error('[leads-stats]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
