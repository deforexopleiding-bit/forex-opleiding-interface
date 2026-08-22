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
import { periodRange, nlDateString } from './_lib/nl-period.js';

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
    // NL-tijdzone-aware grenzen (Europe/Amsterdam → UTC-instants). Voorheen
    // bucketten `today`/`weekStart` op de server-lokale (UTC) kalenderdag, zodat
    // een lead van net na middernacht NL een dag te vroeg/laat viel. Half-open
    // [start, eind) op UTC houdt de index op `aangemaakt` bruikbaar.
    const dag  = periodRange('dag', now);
    const week = periodRange('week', now);
    const today = nlDateString(now);               // 'YYYY-MM-DD' NL (label)
    const weekStart = week.label;                   // maandag NL (label)

    const [vRes, nRes, wRes] = await Promise.all([
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .is('verwijderd_op', null)
        .gte('aangemaakt', dag.start.toISOString())
        .lt('aangemaakt', dag.endExclusive.toISOString()),
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .is('verwijderd_op', null)
        .eq('status', 'nieuw'),
      supabaseAdmin.from('leads_overzicht')
        .select('id', { count: 'exact', head: true })
        .is('verwijderd_op', null)
        .eq('tag', 'gekwalificeerd')
        .gte('aangemaakt', week.start.toISOString()),
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
