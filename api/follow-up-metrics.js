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
  const { period = 'today', ownerScope = null } = opts;
  const ranges = getRanges();
  const range = ranges[period] || ranges.today;

  const metrics = {
    period,
    range_start: range.start.toISOString(),
    range_end: range.end.toISOString(),
  };

  // ── Owner-scope helpers ───────────────────────────────────────────────────
  // apptQ(q): voeg owner_id filter toe aan een appointment query
  const apptQ = (q) => ownerScope ? q.eq('owner_id', ownerScope) : q;

  // ownerApptIds: pre-fetched set van alle appointment IDs voor deze owner,
  // gebruikt om outcome-queries te scopen. Alleen geladen als ownerScope gezet is.
  let ownerApptIds = null;
  if (ownerScope) {
    const { data: ownerAppts } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .eq('owner_id', ownerScope);
    ownerApptIds = (ownerAppts || []).map(a => a.id);
  }

  // outcomeQ(q): filter outcome-query op owner's appointment IDs
  const outcomeQ = (q) => {
    if (!ownerApptIds) return q;
    if (ownerApptIds.length === 0) return q.in('appointment_id', ['00000000-0000-0000-0000-000000000000']);
    return q.in('appointment_id', ownerApptIds);
  };
  // ─────────────────────────────────────────────────────────────────────────

  const { data: appts } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id, status, voicememo_status')
      .gte('scheduled_at', range.start.toISOString())
      .lt('scheduled_at', range.end.toISOString())
  );

  metrics.appointments_total = appts?.length || 0;
  metrics.appointments_scheduled = appts?.filter(a => a.status === 'scheduled').length || 0;
  metrics.appointments_completed = appts?.filter(a => a.status === 'completed').length || 0;
  metrics.appointments_no_show = appts?.filter(a => a.status === 'no_show').length || 0;
  metrics.voicememos_sent = appts?.filter(a => a.voicememo_status === 'sent').length || 0;
  metrics.voicememos_relevant = appts?.filter(a => a.voicememo_status !== 'no_whatsapp').length || 0;

  const { data: outcomes } = await outcomeQ(
    supabaseAdmin
      .from('follow_up_outcomes')
      .select('id, outcome, bezwaren, appointment_id')
      .gte('ingevuld_at', range.start.toISOString())
      .lt('ingevuld_at', range.end.toISOString())
  );

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

  const { data: overdue } = await outcomeQ(
    supabaseAdmin
      .from('follow_up_outcomes')
      .select('id, appointment_id')
      .in('opvolging_status', ['gepland', 'verzet'])
      .not('terugkom_datum', 'is', null)
      .lt('terugkom_datum', today.toISOString().slice(0, 10))
  );

  metrics.opvolgingen_overdue = overdue?.length || 0;
  metrics.achterstallig_opvolgingen = metrics.opvolgingen_overdue;

  // Outcomes achterstallig: completed/no_show van vóór vandaag zonder outcome
  const { data: oldDone } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .lt('scheduled_at', today.toISOString())
      .in('status', ['completed', 'no_show'])
  );

  const oldDoneIds = (oldDone || []).map(a => a.id);
  let achterstalligOutcomes = 0;
  if (oldDoneIds.length > 0) {
    const { data: filledOutcomes } = await supabaseAdmin
      .from('follow_up_outcomes')
      .select('appointment_id')
      .in('appointment_id', oldDoneIds);
    const filledSet = new Set((filledOutcomes || []).map(o => o.appointment_id));
    achterstalligOutcomes = oldDoneIds.filter(id => !filledSet.has(id)).length;
  }
  metrics.achterstallig_outcomes = achterstalligOutcomes;

  // Voicememos achterstallig: alleen voor appointments waar de call
  // daadwerkelijk plaatsvond. Cancelled telt niet mee.
  const { data: oldPending } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .lt('scheduled_at', today.toISOString())
      .eq('voicememo_status', 'pending')
      .in('status', ['completed', 'no_show'])
  );

  metrics.achterstallig_voicememos = (oldPending || []).length;

  metrics.achterstallig_totaal =
    metrics.achterstallig_opvolgingen +
    metrics.achterstallig_outcomes +
    metrics.achterstallig_voicememos;

  // Outcomes ontbrekend vandaag (voor dagrapport email)
  const { data: todayDone } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .gte('scheduled_at', today.toISOString())
      .in('status', ['completed', 'no_show'])
  );

  const todayDoneIds = (todayDone || []).map(a => a.id);
  let missingToday = 0;
  if (todayDoneIds.length > 0) {
    const { data: todayOutcomes } = await supabaseAdmin
      .from('follow_up_outcomes')
      .select('appointment_id')
      .in('appointment_id', todayDoneIds);
    const todayFilledSet = new Set((todayOutcomes || []).map(o => o.appointment_id));
    missingToday = todayDoneIds.filter(id => !todayFilledSet.has(id)).length;
  }
  metrics.outcomes_missing_today = missingToday;

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
