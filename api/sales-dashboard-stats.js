// GET /api/sales-dashboard-stats
// Aggregator-endpoint voor modules/sales-dashboard.html (Fase sales-dashboard).
// Levert alle 9 widget-data in 1 call. Hergebruikt computeMetrics() uit
// api/follow-up-metrics.js voor appointments/voicememos.
//
// Auth: eigen role-check (sales mag óók, niet alleen ADMIN_ROLES). Pattern
// consistent met api/follow-up-dashboard-metrics.js + api/follow-up-kalender.js.
//
// Scoping:
//   - sales rol  → ownerScope = user.id (alleen eigen appointments/follow-ups)
//   - andere     → ownerScope = null (alles, voor admin/manager/super_admin view)
//   - Leads + Events: ALTIJD global (geen lead-ownership op email-niveau,
//     spec-beslissing: Dave is enige sales nu).
//
// Response: { meta, today, week, open_follow_ups, appointments_today_count,
//             appointments_tomorrow_count,
//             open_acties: { total, opvolgingen, outcomes, wacht_reschedule, voicememos },
//             next_appointment }
//
// Open-acties-velden komen gratis uit todayMetrics (computeMetrics levert
// achterstallig_opvolgingen/outcomes/voicememos/totaal + wacht_op_reschedule_count).
// Definitie identiek aan follow-up.html "ACTIE NODIG" card. Total = achterstallig
// (dedup tussen outcome-missing en voicememo-pending) + wacht_op_reschedule
// (geen overlap mogelijk: wacht-status sluit completed/no_show uit).
//
// Errors: 401 (geen token) / 403 (verkeerde rol) / 405 / 500.

import { supabase, supabaseAdmin } from './supabase.js';
import { computeMetrics } from './follow-up-metrics.js';
import { periodRange, nlDayEndExclusive, nlDayStart, nlDateString } from './_lib/nl-period.js';

// 2026-08-24 custom-range support voor 'Calls geboekt'-tegel op dashboard.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function rangeForCustom(fromStr, toStr) {
  if (!ISO_DATE_RE.test(fromStr) || !ISO_DATE_RE.test(toStr)) return null;
  const start = nlDayStart(new Date(fromStr + 'T12:00:00Z'));
  const endExclusive = nlDayEndExclusive(new Date(toStr + 'T12:00:00Z'));
  if (endExclusive <= start) return null;
  return { start, endExclusive };
}

const ALLOWED_ROLES = ['super_admin', 'admin', 'manager', 'sales', 'mentor'];
const INACTIVE_STATUSES = ['cancelled', 'verplaatst', 'verwijderd'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  // ── Auth + role-check (eigen flow, niet verifyAdmin) ─────────────────────
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Bearer token vereist' });
  }
  const token = authHeader.slice(7);

  const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
  if (profileErr || !profile) {
    return res.status(403).json({ error: 'Profile niet gevonden' });
  }
  if (!profile.is_active || !ALLOWED_ROLES.includes(profile.role)) {
    return res.status(403).json({ error: 'Toegang geweigerd', role: profile.role });
  }

  // Sales én mentor → eigen scope; admin/manager/super_admin → globaal.
  // Mentor kan Sales-Dashboard krijgen via RBAC maar mag alleen eigen cijfers zien.
  const ownerScope = (profile.role === 'sales' || profile.role === 'mentor') ? user.id : null;
  // v=... custom-range voor Calls geboekt: ?from=YYYY-MM-DD&to=YYYY-MM-DD.
  const customRange = rangeForCustom(String(req.query?.from || '').trim(), String(req.query?.to || '').trim());

  try {
    // Parallel fetch alle widget-data (7 queries, geen volgorde-afhankelijkheid).
    // overdueMode='broad': sales-dashboard sync met /api/follow-up-appointments
    // ?period=open_acties (status IN scheduled/in_progress/completed/no_show,
    // cutoff = now-30min). Email-rapporten + follow-up topbar blijven 'strict'.
    const [
      todayMetrics,
      weekMetrics,
      monthMetrics,
      tomorrowApptCount,
      openFollowUpsCount,
      nextAppt,
      leadsCounts,
      eventsCounts,
      bookedCounts,
    ] = await Promise.all([
      computeMetrics(supabaseAdmin, { period: 'today', ownerScope, overdueMode: 'broad' }),
      computeMetrics(supabaseAdmin, { period: 'week',  ownerScope, overdueMode: 'broad' }),
      computeMetrics(supabaseAdmin, { period: 'month', ownerScope, overdueMode: 'broad' }),
      fetchTomorrowAppointmentsCount(ownerScope),
      fetchOpenFollowUpsCount(ownerScope),
      fetchNextAppointment(ownerScope),
      fetchLeadsCounts(),    // global, geen ownerScope
      fetchEventsCounts(),   // global
      fetchBookedInPeriodCounts(ownerScope, customRange),
    ]);

    return res.status(200).json({
      meta: {
        scope:         ownerScope ? 'own' : 'global',
        sales_user_id: ownerScope,
        role:          profile.role,
        generated_at:  new Date().toISOString(),
      },
      today: {
        leads:        leadsCounts.today,
        events:       eventsCounts.today,
        appointments: todayMetrics.appointments_total,
        booked:       bookedCounts.today, // NIEUW GEBOEKT (created_at) — voedt v2-dashboard 'Calls geboekt'.
      },
      week: {
        leads:        leadsCounts.week,
        events:       eventsCounts.week,
        appointments: weekMetrics.appointments_total,
        booked:       bookedCounts.week,
      },
      month: {
        // Rolling 30 dagen (follow-up-metrics 'month' = today-30d..tomorrow).
        appointments: monthMetrics.appointments_total,
        booked:       bookedCounts.month,
      },
      year: {
        booked:       bookedCounts.year,
      },
      // Custom-range 'Calls geboekt'-teller — alleen aanwezig als from/to gegeven.
      ...(customRange && typeof bookedCounts.custom === 'number' ? { custom: { booked: bookedCounts.custom } } : {}),
      open_follow_ups:             openFollowUpsCount,
      appointments_today_count:    todayMetrics.appointments_total,
      appointments_tomorrow_count: tomorrowApptCount,
      open_acties: {
        total:            (todayMetrics.achterstallig_totaal      || 0)
                        + (todayMetrics.wacht_op_reschedule_count || 0),
        opvolgingen:      todayMetrics.achterstallig_opvolgingen  || 0,
        outcomes:         todayMetrics.achterstallig_outcomes     || 0,
        wacht_reschedule: todayMetrics.wacht_op_reschedule_count  || 0,
        voicememos:       todayMetrics.achterstallig_voicememos   || 0,
      },
      next_appointment: nextAppt,   // null als geen
    });
  } catch (err) {
    console.error('[sales-dashboard-stats] error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Eigen queries (computeMetrics dekt today/week appts + voicememos) ────────

/**
 * Telt appointments waarvan de BOEKING is aangemaakt in de periode
 * (created_at binnen [start, end)). Voor dashboard-metric "Calls geboekt"
 * — wat Jeffrey vraagt is "nieuw geboekt in periode", NIET "gepland in
 * periode" (die zit al in .appointments via scheduled_at).
 * Sluit cancelled/verplaatst/verwijderd uit.
 *
 * Week = maandag t/m zondag (NL). Maand = 1e t/m 1e volgende. Year = 1 jan.
 */
async function fetchBookedInPeriodCounts(ownerScope, customRange) {
  const now = new Date();
  // NL-tijdzone-aware grenzen (Europe/Amsterdam → UTC-instants). Voorheen
  // bepaalden setHours/getDay/getFullYear alles in server-lokale (UTC) tijd →
  // afspraken rond middernacht NL vielen in de verkeerde dag/week/maand/jaar.
  const rDag   = periodRange('dag', now);
  const rWeek  = periodRange('week', now);
  const rMaand = periodRange('maand', now);
  const rJaar  = periodRange('jaar', now);
  const startOfToday     = rDag.start;
  const startOfTomorrow  = rDag.endExclusive;
  const startOfWeek      = rWeek.start;
  const startOfNextWeek  = rWeek.endExclusive;
  const startOfMonth     = rMaand.start;
  const startOfNextMonth = rMaand.endExclusive;
  const startOfYear      = rJaar.start;
  const startOfNextYear  = rJaar.endExclusive;

  async function count(startD, endD) {
    let q = supabaseAdmin.from('follow_up_appointments')
      .select('id, status', { count: 'exact', head: false })
      .gte('created_at', startD.toISOString())
      .lt('created_at', endD.toISOString())
      .limit(10000);
    if (ownerScope) q = q.eq('owner_id', ownerScope);
    const { data, error } = await q;
    if (error) throw new Error('booked-count: ' + error.message);
    return (data || []).filter(a => !INACTIVE_STATUSES.includes(a.status)).length;
  }
  const promises = [
    count(startOfToday, startOfTomorrow),
    count(startOfWeek,  startOfNextWeek),
    count(startOfMonth, startOfNextMonth),
    count(startOfYear,  startOfNextYear),
  ];
  // v=... custom-range support: als from/to gegeven, ook die window tellen.
  if (customRange) promises.push(count(customRange.start, customRange.endExclusive));
  const results = await Promise.all(promises);
  const [today, week, month, year, custom] = results;
  const out = { today, week, month, year };
  if (customRange) out.custom = custom;
  return out;
}

/**
 * Telt afspraken voor MORGEN (calendar-day, exclude cancelled/verplaatst/verwijderd).
 * computeMetrics() ondersteunt geen 'tomorrow' period, dus eigen query.
 */
async function fetchTomorrowAppointmentsCount(ownerScope) {
  // NL-morgen [00:00, overmorgen 00:00). nlDayEndExclusive(now) = NL-morgen 00:00
  // (UTC-instant); nog een dag verder = NL-overmorgen 00:00. Voorheen bepaalde
  // setHours dit in server-lokale (UTC) tijd → afspraken rond middernacht NL
  // vielen in de verkeerde kalenderdag.
  const tomorrowStart = nlDayEndExclusive(new Date());
  const dayAfter      = nlDayEndExclusive(tomorrowStart);

  // Geen .not('status', 'in', ...) want PostgREST-array-not.in vereist
  // andere syntax. Easier: fetch + filter client-side (kleine N).
  let q = supabaseAdmin.from('follow_up_appointments')
    .select('id, status')
    .gte('scheduled_at', tomorrowStart.toISOString())
    .lt('scheduled_at', dayAfter.toISOString());
  if (ownerScope) q = q.eq('owner_id', ownerScope);
  const { data, error } = await q;
  if (error) throw new Error('tomorrow appts: ' + error.message);
  return (data || []).filter((a) => !INACTIVE_STATUSES.includes(a.status)).length;
}

/**
 * Telt open follow-ups: outcomes met opvolging_status 'gepland'/'verzet'
 * EN terugkom_datum >= today (excl. overdue — die zit in widget 8).
 */
async function fetchOpenFollowUpsCount(ownerScope) {
  // NL-vandaag als kalenderdatum (terugkom_datum is een DATE-kolom). Voorheen
  // gaf toISOString() de UTC-datum → rond middernacht NL een dag verschoven.
  const todayIso = nlDateString(new Date());

  const apptIds = await fetchOwnerApptIds(ownerScope);
  if (apptIds && apptIds.length === 0) return 0;

  let q = supabaseAdmin.from('follow_up_outcomes')
    .select('id', { count: 'exact', head: true })
    .in('opvolging_status', ['gepland', 'verzet'])
    .not('terugkom_datum', 'is', null)
    .gte('terugkom_datum', todayIso);
  if (apptIds) q = q.in('appointment_id', apptIds);
  const { count, error } = await q;
  if (error) throw new Error('open follow-ups: ' + error.message);
  return count || 0;
}

/**
 * Volgende afspraak: eerste 'scheduled' appointment met scheduled_at >= now.
 * Returns null bij geen geplande afspraken.
 */
async function fetchNextAppointment(ownerScope) {
  const nowIso = new Date().toISOString();

  let q = supabaseAdmin.from('follow_up_appointments')
    .select('id, lead_name, scheduled_at, status')
    .gte('scheduled_at', nowIso)
    .eq('status', 'scheduled')
    .order('scheduled_at', { ascending: true })
    .limit(1);
  if (ownerScope) q = q.eq('owner_id', ownerScope);
  const { data, error } = await q;
  if (error) throw new Error('next appt: ' + error.message);

  if (!data || data.length === 0) return null;
  const a = data[0];
  return {
    appointment_id: a.id,
    lead_name:      a.lead_name || 'Onbekend',
    scheduled_at:   a.scheduled_at,
  };
}

/** Leads today/week count uit email_messages (global, geen ownerScope). */
async function fetchLeadsCounts() {
  const r = getTodayWeekRanges();
  const todayCount = await countEmailCategory('Nieuwe Lead', r.today.start, r.today.end);
  const weekCount  = await countEmailCategory('Nieuwe Lead', r.week.start,  r.week.end);
  return { today: todayCount, week: weekCount };
}

/** Event-aanmeldingen today/week count uit email_messages (global). */
async function fetchEventsCounts() {
  const r = getTodayWeekRanges();
  const todayCount = await countEmailCategory('Event Aanmelding', r.today.start, r.today.end);
  const weekCount  = await countEmailCategory('Event Aanmelding', r.week.start,  r.week.end);
  return { today: todayCount, week: weekCount };
}

async function countEmailCategory(category, start, end) {
  const { count, error } = await supabaseAdmin
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('category', category)
    .gte('date_received', start.toISOString())
    .lt('date_received',  end.toISOString());
  if (error) throw new Error(`emails ${category}: ${error.message}`);
  return count || 0;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Pre-fetch owner's appointment IDs voor outcome-scoping.
 * Returnt null bij globale scope (geen filter).
 */
async function fetchOwnerApptIds(ownerScope) {
  if (!ownerScope) return null;
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments').select('id').eq('owner_id', ownerScope);
  if (error) throw new Error('owner appt ids: ' + error.message);
  return (data || []).map((a) => a.id);
}

/**
 * Today (kalenderdag) + Week (maandag deze week → einde vandaag) date-ranges.
 * NL-conventie: week begint op maandag.
 * - Today: [todayStart, tomorrowStart).
 * - Week:  [maandag-00:00, vandaag-24:00). Op maandag = today-range; op
 *   zondag = ma 00:00 tot ma 00:00 volgende week (7 dagen).
 */
function getTodayWeekRanges() {
  const now = new Date();
  // NL-tijdzone-aware (Europe/Amsterdam → UTC-instants). Voorheen bepaalde
  // setHours/getDay de grenzen in server-lokale tijd (= UTC op Vercel), zodat
  // een lead/mail van net na middernacht NL een dag te vroeg werd geteld.
  const dag  = periodRange('dag', now);
  const week = periodRange('week', now);
  return {
    // Today = NL-vandaag [00:00, morgen 00:00).
    today: { start: dag.start,  end: dag.endExclusive },
    // Week = NL-maandag deze week tot NL-eind-vandaag (zoals voorheen: t/m nu,
    // niet de volledige ISO-week).
    week:  { start: week.start, end: dag.endExclusive },
  };
}
