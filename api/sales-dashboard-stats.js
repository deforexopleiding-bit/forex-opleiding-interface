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
//             overdue: { total, opvolgingen, outcomes, voicememos },
//             next_appointment }
//
// Achterstallig-velden komen gratis uit todayMetrics (computeMetrics levert
// achterstallig_opvolgingen/outcomes/voicememos/totaal). Definitie identiek
// aan follow-up.html topbar — dedup tussen outcome-missing en voicememo-pending.
//
// Errors: 401 (geen token) / 403 (verkeerde rol) / 405 / 500.

import { supabase, supabaseAdmin } from './supabase.js';
import { computeMetrics } from './follow-up-metrics.js';

const ALLOWED_ROLES = ['super_admin', 'admin', 'manager', 'sales'];
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

  // Sales rol → eigen scope; andere rollen → globaal
  const ownerScope = profile.role === 'sales' ? user.id : null;

  try {
    // Parallel fetch alle widget-data (7 queries, geen volgorde-afhankelijkheid).
    // Achterstallig-counts komen uit todayMetrics (computeMetrics) — geen
    // aparte query meer nodig, definitie blijft synchroon met follow-up.html.
    const [
      todayMetrics,
      weekMetrics,
      tomorrowApptCount,
      openFollowUpsCount,
      nextAppt,
      leadsCounts,
      eventsCounts,
    ] = await Promise.all([
      computeMetrics(supabaseAdmin, { period: 'today', ownerScope }),
      computeMetrics(supabaseAdmin, { period: 'week',  ownerScope }),
      fetchTomorrowAppointmentsCount(ownerScope),
      fetchOpenFollowUpsCount(ownerScope),
      fetchNextAppointment(ownerScope),
      fetchLeadsCounts(),    // global, geen ownerScope
      fetchEventsCounts(),   // global
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
      },
      week: {
        leads:        leadsCounts.week,
        events:       eventsCounts.week,
        appointments: weekMetrics.appointments_total,
      },
      open_follow_ups:             openFollowUpsCount,
      appointments_today_count:    todayMetrics.appointments_total,
      appointments_tomorrow_count: tomorrowApptCount,
      overdue: {
        total:       todayMetrics.achterstallig_totaal       || 0,
        opvolgingen: todayMetrics.achterstallig_opvolgingen  || 0,
        outcomes:    todayMetrics.achterstallig_outcomes     || 0,
        voicememos:  todayMetrics.achterstallig_voicememos   || 0,
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
 * Telt afspraken voor MORGEN (calendar-day, exclude cancelled/verplaatst/verwijderd).
 * computeMetrics() ondersteunt geen 'tomorrow' period, dus eigen query.
 */
async function fetchTomorrowAppointmentsCount(ownerScope) {
  const tomorrowStart = new Date();
  tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const dayAfter = new Date(tomorrowStart);
  dayAfter.setDate(dayAfter.getDate() + 1);

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
  const todayIso = new Date().toISOString().slice(0, 10);

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
  const now        = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

  // Week = maandag deze week tot vandaag-eind (NL-conventie).
  const weekStart = new Date(todayStart);
  const dayOfWeek = weekStart.getDay();           // 0=zo, 1=ma, ..., 6=za
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setDate(weekStart.getDate() - daysFromMonday);

  return {
    today: { start: todayStart, end: todayEnd },
    week:  { start: weekStart,  end: todayEnd },
  };
}
