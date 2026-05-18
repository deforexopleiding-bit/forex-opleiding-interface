// api/follow-up-metrics.js
//
// KPI-berekeningen voor follow-up dashboard + admin rapporten.
// Geen default export → geen route.

/**
 * Bereken metrics voor een periode.
 *
 * @param {Object} supabaseAdmin - service-role client (bypass RLS)
 * @param {{ period: 'today'|'week'|'month' }} opts
 * @returns {Promise<Object>}
 */
export async function computeMetrics(supabaseAdmin, opts = {}) {
  const { period = 'today' } = opts;
  const ranges = getRanges();
  const range = ranges[period] || ranges.today;

  const metrics = {
    period,
    range_start: range.start.toISOString(),
    range_end: range.end.toISOString(),
  };

  const { data: appts } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, status, voicememo_status')
    .gte('scheduled_at', range.start.toISOString())
    .lt('scheduled_at', range.end.toISOString());

  metrics.appointments_total = appts?.length || 0;
  metrics.appointments_scheduled = appts?.filter(a => a.status === 'scheduled').length || 0;
  metrics.appointments_completed = appts?.filter(a => a.status === 'completed').length || 0;
  metrics.appointments_no_show = appts?.filter(a => a.status === 'no_show').length || 0;
  metrics.voicememos_sent = appts?.filter(a => a.voicememo_status === 'sent').length || 0;
  metrics.voicememos_relevant = appts?.filter(a => a.voicememo_status !== 'no_whatsapp').length || 0;

  const { data: outcomes } = await supabaseAdmin
    .from('follow_up_outcomes')
    .select('id, outcome, bezwaren')
    .gte('ingevuld_at', range.start.toISOString())
    .lt('ingevuld_at', range.end.toISOString());

  metrics.outcomes_total = outcomes?.length || 0;
  metrics.outcomes_klant = outcomes?.filter(o => o.outcome === 'klant_geworden').length || 0;
  metrics.outcomes_geen_klant = outcomes?.filter(o => o.outcome === 'geen_klant').length || 0;
  metrics.outcomes_no_show = outcomes?.filter(o => o.outcome === 'no_show').length || 0;

  const totalDecisions = metrics.outcomes_klant + metrics.outcomes_geen_klant;
  metrics.conversion_rate = totalDecisions > 0
    ? Math.round((metrics.outcomes_klant / totalDecisions) * 100)
    : null;

  const totalDone = metrics.appointments_completed + metrics.appointments_no_show;
  metrics.no_show_rate = totalDone > 0
    ? Math.round((metrics.appointments_no_show / totalDone) * 100)
    : null;

  const bezwaarCounts = {};
  (outcomes || []).forEach(o => {
    if (Array.isArray(o.bezwaren)) {
      o.bezwaren.forEach(b => {
        bezwaarCounts[b] = (bezwaarCounts[b] || 0) + 1;
      });
    }
  });
  metrics.top_bezwaren = Object.entries(bezwaarCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([naam, count]) => ({ naam, count }));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data: overdue } = await supabaseAdmin
    .from('follow_up_outcomes')
    .select('id')
    .in('opvolging_status', ['gepland', 'verzet'])
    .not('terugkom_datum', 'is', null)
    .lt('terugkom_datum', today.toISOString().slice(0, 10));

  metrics.opvolgingen_overdue = overdue?.length || 0;

  return metrics;
}

function getRanges() {
  const now = new Date();

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - 7);

  const monthStart = new Date(today);
  monthStart.setDate(monthStart.getDate() - 30);

  return {
    today: { start: today, end: tomorrow },
    week:  { start: weekStart, end: tomorrow },
    month: { start: monthStart, end: tomorrow },
  };
}

const BEZWAAR_LABELS = {
  te_duur:           'Te duur',
  partner_overleg:   'Partner overleg',
  timing:            'Verkeerde timing',
  angst_verlies:     'Angst voor verliezen',
  twijfel:           'Twijfel/aarzeling',
  concurrent:        'Concurrent overweging',
  niet_serieus:      'Niet serieus',
  geen_geld:         'Geen geld',
  zelf_proberen:     'Wil zelf proberen',
  geen_tijd:         'Geen tijd',
  anders:            'Anders',
};

export function labelBezwaar(key) {
  return BEZWAAR_LABELS[key] || key;
}
