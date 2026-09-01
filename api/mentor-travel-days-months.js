// api/mentor-travel-days-months.js
//
// READ-ONLY lijst-endpoint voor de maand-dropdown in "Rijdagen doorgeven".
// Geeft in ÉÉN call de huidige NL-maand + 6 maanden terug terug, elk met
// { period_month, status, editable, days } voor de ingelogde mentor.
//
// Strikte self-scope (mentor_user_id = auth.uid(), geen param, geen admin-pad),
// permission mentor.module.access. Muteert NIETS (geen writes, geen incasso).
//
// editable = status ∉ {goedgekeurd, uitbetaald} (zelfde regel als
// mentor-travel-days-self). De backend blijft authoritative: de dropdown gebruikt
// dit alleen om goedgekeurde maanden te grijzen; de POST valideert opnieuw.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const RANGE_BACK_MONTHS = 6;

// Huidige NL-maand (Europe/Amsterdam) als { y, m } (m = 1..12).
function nlYearMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date());
  return {
    y: Number(p.find((x) => x.type === 'year').value),
    m: Number(p.find((x) => x.type === 'month').value),
  };
}

// Maandstart-string 'YYYY-MM-01' voor een 0-based maand-index (mag over-/onderlopen).
function monthStartStr(y, monthIdx0) {
  const yy = y + Math.floor(monthIdx0 / 12);
  const mm = ((monthIdx0 % 12) + 12) % 12; // 0..11
  return `${yy}-${String(mm + 1).padStart(2, '0')}-01`;
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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }
  const uid = user.id;

  // Nieuwste eerst: huidige maand → 6 terug.
  const { y, m } = nlYearMonth();
  const months = [];
  for (let i = 0; i <= RANGE_BACK_MONTHS; i++) months.push(monthStartStr(y, (m - 1) - i));

  try {
    const [
      { data: cfg, error: cfgErr },
      { data: payouts, error: payErr },
      { data: tds, error: tdErr },
    ] = await Promise.all([
      supabaseAdmin
        .from('mentor_payout_config')
        .select('travel_enabled, travel_day_rate_incl')
        .eq('mentor_user_id', uid)
        .maybeSingle(),
      supabaseAdmin
        .from('mentor_payouts')
        .select('period_month, status')
        .eq('mentor_user_id', uid)
        .in('period_month', months),
      supabaseAdmin
        .from('mentor_travel_days')
        .select('period_month, days')
        .eq('mentor_user_id', uid)
        .in('period_month', months),
    ]);
    if (cfgErr) throw new Error('config lookup: ' + cfgErr.message);
    if (payErr) throw new Error('payouts lookup: ' + payErr.message);
    if (tdErr)  throw new Error('travel-days lookup: ' + tdErr.message);

    const statusByMonth = new Map((payouts || []).map((r) => [String(r.period_month).slice(0, 10), r.status]));
    const daysByMonth   = new Map((tds || []).map((r) => [String(r.period_month).slice(0, 10), Number(r.days) || 0]));

    const list = months.map((mn) => {
      const status  = statusByMonth.get(mn) || null;
      const isFinal = status === 'goedgekeurd' || status === 'uitbetaald';
      return { period_month: mn, status, editable: !isFinal, days: daysByMonth.get(mn) || 0 };
    });

    return res.status(200).json({
      ok            : true,
      travel_enabled: !!cfg?.travel_enabled,
      day_rate_incl : Number(cfg?.travel_day_rate_incl) || 0,
      months        : list, // nieuwste eerst
    });
  } catch (e) {
    console.error('[mentor-travel-days-months]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
