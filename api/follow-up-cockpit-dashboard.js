// api/follow-up-cockpit-dashboard.js
//
// GET ?period=today|week|month (default today)
//
// Aggregeert uit follow_up_lead_notes waar entry_kind IN ('outcome','system'),
// binnen de gekozen periode, gegroepeerd per medewerker (created_by_user_id).
//
// Metrics per user:
//   gebeld   = alle outcome-notes waar outcome_code in de bel-set zit
//   bereikt  = subset (terugbel, zoom_ingepland, sale, geen_interesse, gesprek_gehad)
//   offerte  = outcome_code = 'offerte' (uit entry_kind='system')
//   zoom     = outcome_code = 'zoom_ingepland'
//   gewonnen = outcome_code = 'sale'
//   conversie= gewonnen / gebeld * 100 (afgerond int)
//
// 42P01/42703 → fail-soft (lege telling).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const GEBELD_CODES = new Set([
  'geen_gehoor', 'voicemail', 'foutief_nummer',
  'terugbel', 'zoom_ingepland',
  'sale', 'geen_interesse',
  'noshow', 'gesprek_gehad',
]);
const BEREIKT_CODES = new Set([
  'terugbel', 'zoom_ingepland',
  'sale', 'geen_interesse', 'gesprek_gehad',
]);

function periodStart(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (period === 'week') {
    // ISO-week: maandag = start van de week (0=zo → we shiften).
    const day = now.getDay();               // 0..6
    const daysSinceMonday = (day + 6) % 7;   // maandag=0 ... zondag=6
    const s = new Date(y, m, d - daysSinceMonday, 0, 0, 0, 0);
    return s.toISOString();
  }
  if (period === 'month') {
    return new Date(y, m, 1, 0, 0, 0, 0).toISOString();
  }
  // today
  return new Date(y, m, d, 0, 0, 0, 0).toISOString();
}

function emptyPayload(period) {
  return {
    period,
    totals: { gebeld: 0, bereikt: 0, offerte: 0, zoom: 0, gewonnen: 0 },
    per_user: [],
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const period = ['today', 'week', 'month'].includes(req.query?.period) ? req.query.period : 'today';
  const sinceIso = periodStart(period);

  try {
    // Probeer met entry_kind + outcome_code. Bij 42703 val terug op oude
    // shape zonder die kolommen — dan is aggregatie niet mogelijk en
    // geven we lege telling terug.
    const runQ = (cols, extra) => {
      let qq = supabaseAdmin.from('follow_up_lead_notes')
        .select(cols)
        .gte('created_at', sinceIso)
        .not('created_by_user_id', 'is', null)
        .limit(10000);
      if (extra) extra(qq);
      return qq;
    };

    const { data, error } = await supabaseAdmin
      .from('follow_up_lead_notes')
      .select('id, created_by_user_id, entry_kind, outcome_code, created_at')
      .gte('created_at', sinceIso)
      .in('entry_kind', ['outcome', 'system'])
      .not('created_by_user_id', 'is', null)
      .limit(10000);
    if (error) {
      if (error.code === '42P01' || error.code === '42703') {
        // Fail-soft: dashboard toont nullen tot migratie draait.
        return res.status(200).json(emptyPayload(period));
      }
      throw new Error(error.message);
    }

    const rows = data || [];
    if (!rows.length) return res.status(200).json(emptyPayload(period));

    // Aggregeer in-memory. Supabase JS heeft geen native GROUP BY.
    const perUser = new Map();
    const totals  = { gebeld: 0, bereikt: 0, offerte: 0, zoom: 0, gewonnen: 0 };
    for (const r of rows) {
      const uid = r.created_by_user_id;
      const code = String(r.outcome_code || '');
      if (!perUser.has(uid)) perUser.set(uid, { user_id: uid, gebeld: 0, bereikt: 0, offerte: 0, zoom: 0, gewonnen: 0 });
      const u = perUser.get(uid);

      if (r.entry_kind === 'outcome') {
        if (GEBELD_CODES.has(code))  { u.gebeld++;   totals.gebeld++; }
        if (BEREIKT_CODES.has(code)) { u.bereikt++;  totals.bereikt++; }
        if (code === 'zoom_ingepland') { u.zoom++;    totals.zoom++; }
        if (code === 'sale')           { u.gewonnen++; totals.gewonnen++; }
      } else if (r.entry_kind === 'system' && code === 'offerte') {
        u.offerte++; totals.offerte++;
      }
    }

    // Namen ophalen.
    const uids = [...perUser.keys()];
    const nameById = {};
    if (uids.length) {
      const { data: profs } = await supabaseAdmin
        .from('profiles').select('id, full_name, email').in('id', uids);
      for (const p of (profs || [])) nameById[p.id] = p.full_name || p.email || p.id;
    }

    const per_user = [...perUser.values()].map((u) => ({
      ...u,
      name     : nameById[u.user_id] || '—',
      conversie: u.gebeld > 0 ? Math.round((u.gewonnen / u.gebeld) * 100) : 0,
    })).sort((a, b) => (b.gebeld - a.gebeld) || a.name.localeCompare(b.name));

    return res.status(200).json({ period, totals, per_user });
  } catch (e) {
    console.error('[follow-up-cockpit-dashboard]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
