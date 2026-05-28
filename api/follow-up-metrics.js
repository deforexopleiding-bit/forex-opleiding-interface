// api/follow-up-metrics.js
//
// KPI-berekeningen voor follow-up dashboard + admin rapporten.
// Geen default export → geen route.

/**
 * Bereken metrics voor een periode.
 *
 * @param {Object} supabaseAdmin - service-role client (bypass RLS)
 * @param {Object} opts
 * @param {'today'|'week'|'month'} [opts.period='today']
 * @param {string|null} [opts.ownerScope=null] - user.id om appointments
 *        + outcomes te scopen op één owner (sales-rol). null = globaal.
 * @param {'strict'|'broad'} [opts.overdueMode='strict'] - definitie van
 *        achterstallig_outcomes / achterstallig_voicememos:
 *        - 'strict' (default): scheduled_at < today AND status IN
 *          ('completed','no_show'). Boekhoudkundige definitie — gebruikt
 *          door email-rapporten (daily/weekly) en follow-up topbar.
 *        - 'broad': scheduled_at < now()-30min AND status IN ('scheduled',
 *          'in_progress','completed','no_show'). Pragmatische definitie —
 *          synchroon met /api/follow-up-appointments?period=open_acties
 *          en de "Open acties" tab in follow-up.html. Gebruikt door
 *          sales-dashboard om past-due scheduled appts mee te tellen.
 *        achterstallig_opvolgingen verandert NIET — die heeft eigen
 *        parent-active filter en is mode-onafhankelijk.
 *        achterstallig_totaal wordt gededupliceerd over de bredere sets.
 * @returns {Promise<Object>}
 */
export async function computeMetrics(supabaseAdmin, opts = {}) {
  const { period = 'today', ownerScope = null, overdueMode = 'strict' } = opts;
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
      .select('id, status, voicememo_status, parent_appointment_id, ghl_appointment_id')
      .gte('scheduled_at', range.start.toISOString())
      .lt('scheduled_at', range.end.toISOString())
  );

  // Exclude cancelled/verplaatst/verwijderd from totals — die tellen niet mee
  // als echte afspraken. Consistent met today-tab lijst-filter in follow-up-appointments.js
  const activeAppts = (appts || []).filter(a => !['cancelled', 'verplaatst', 'verwijderd'].includes(a.status));

  metrics.appointments_total = activeAppts.length;
  metrics.appointments_scheduled = activeAppts.filter(a => a.status === 'scheduled').length;
  metrics.appointments_completed = activeAppts.filter(a => a.status === 'completed').length;
  metrics.appointments_no_show = activeAppts.filter(a => a.status === 'no_show').length;
  metrics.voicememos_sent = activeAppts.filter(a => a.voicememo_status === 'sent').length;
  metrics.voicememos_relevant = activeAppts.filter(a => a.voicememo_status !== 'no_whatsapp').length;

  // Call-type split: first_calls / agenda_followups / intern_followups
  metrics.first_calls       = activeAppts.filter(a => !a.parent_appointment_id).length;
  metrics.agenda_followups  = activeAppts.filter(a =>  a.parent_appointment_id &&  a.ghl_appointment_id).length;
  metrics.intern_followups  = activeAppts.filter(a =>  a.parent_appointment_id && !a.ghl_appointment_id).length;

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

  // Sluit cancelled/verplaatst/verwijderd uit — alleen actieve appointments tellen mee.
  const overdueApptIds = (overdue || []).map(o => o.appointment_id);
  let activeOverdueCount = overdueApptIds.length;
  if (overdueApptIds.length > 0) {
    const { data: activeAppts } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .in('id', overdueApptIds)
      .in('status', ['scheduled', 'in_progress', 'completed', 'no_show']);
    activeOverdueCount = (activeAppts || []).length;
  }
  metrics.opvolgingen_overdue = activeOverdueCount;
  metrics.achterstallig_opvolgingen = activeOverdueCount;

  // Outcomes achterstallig: appointments vóór de cutoff zonder outcome.
  // overdueMode bepaalt cutoff + status-filter — zie JSDoc op computeMetrics.
  // 'strict': scheduled_at < today (00:00) AND completed/no_show.
  // 'broad' : scheduled_at < now()-30min AND scheduled/in_progress/completed/no_show.
  const overdueCutoff = overdueMode === 'broad'
    ? new Date(Date.now() - 30 * 60 * 1000).toISOString()
    : today.toISOString();
  const overdueStatuses = overdueMode === 'broad'
    ? ['scheduled', 'in_progress', 'completed', 'no_show']
    : ['completed', 'no_show'];

  const { data: oldDone } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .lt('scheduled_at', overdueCutoff)
      .in('status', overdueStatuses)
  );

  const oldDoneIds = (oldDone || []).map(a => a.id);
  let noOutcomeIds = new Set();
  if (oldDoneIds.length > 0) {
    const { data: filledOutcomes } = await supabaseAdmin
      .from('follow_up_outcomes')
      .select('appointment_id')
      .in('appointment_id', oldDoneIds);
    const filledSet = new Set((filledOutcomes || []).map(o => o.appointment_id));
    noOutcomeIds = new Set(oldDoneIds.filter(id => !filledSet.has(id)));
  }
  metrics.achterstallig_outcomes = noOutcomeIds.size;

  // Voicememos achterstallig: zelfde cutoff + status-filter als outcomes
  // (mode-afhankelijk). In 'broad' tellen ook past-due scheduled appts mee
  // waar de voicememo nog niet verstuurd is.
  const { data: oldPending } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id')
      .lt('scheduled_at', overdueCutoff)
      .eq('voicememo_status', 'pending')
      .in('status', overdueStatuses)
  );

  const pendingMemoIds = new Set((oldPending || []).map(a => a.id));
  metrics.achterstallig_voicememos = pendingMemoIds.size;

  // Dedup: één appointment kan zowel outcome als voicememo missen → tel als één taak
  const achterstalligApptIds = new Set([...noOutcomeIds, ...pendingMemoIds]);
  metrics.achterstallig_totaal =
    metrics.achterstallig_opvolgingen + achterstalligApptIds.size;

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

  // Wacht op reschedule: aantal appointments in afwachting van nieuwe datum
  const { count: waitCount } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'wacht_op_reschedule')
  );
  metrics.wacht_op_reschedule_count = waitCount || 0;

  // Afspraken nog te gaan vandaag: scheduled, vandaag, minder dan 30 min na starttijd voorbij
  const remTodayStart = new Date();
  remTodayStart.setHours(0, 0, 0, 0);
  const remTodayEnd = new Date(remTodayStart);
  remTodayEnd.setDate(remTodayEnd.getDate() + 1);
  const remCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { count: remainingCount } = await apptQ(
    supabaseAdmin
      .from('follow_up_appointments')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'scheduled')
      .gte('scheduled_at', remTodayStart.toISOString())
      .lt('scheduled_at', remTodayEnd.toISOString())
      .gt('scheduled_at', remCutoff)
  );
  metrics.appointments_remaining_today = remainingCount || 0;

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
