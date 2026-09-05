// api/automations-overview.js
//
// BP3 v35 (2026-09-04) — READ-ONLY aggregate voor het flow-kaartjes-overzicht
// op #automatiseringen/Overzicht. Één GET-call retourneert per flow:
//   { key, naam, categorie, status:{label, tone}, count, count_label,
//     drilldown, kanalen, granulariteit, laatste_run }
//
// Puur SELECT / count:'exact', head:true — geen writes. Wijzigt geen state,
// raakt geen crons, geen aan/uit-schakelaars aan. Best-effort per flow: als
// een query faalt zet 'count:null' met 'error' zodat de UI netjes een
// "nog niet gekoppeld"-staat kan tonen i.p.v. te crashen.
//
// RBAC: hergebruikt de module-gate 'automatiseringen.module.view'
// (fallback: super_admin). Zelfde patroon als /api/automations-status.
// Incasso-zone: niet aangeraakt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

async function safeCount(table, applyFn) {
  try {
    let q = supabaseAdmin.from(table).select('id', { count: 'exact', head: true });
    if (typeof applyFn === 'function') q = applyFn(q);
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    return { count: Number(count) || 0, error: null };
  } catch (e) {
    return { count: null, error: e?.message || String(e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'automatiseringen.module.view');
  if (!allowed) {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    allowed = !!prof && prof.is_active && prof.role === 'super_admin';
  }
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (automatiseringen.module.view)' });

  // ── Counts in parallel ─────────────────────────────────────────────────
  const [
    opvolging,
    eventRuns,
    onboardingRuns,
    lisaFollowups,
    bulkRecipients,
    toegang7daagse,
    toegangMini,
    belronde,
    onderhoud,
  ] = await Promise.all([
    safeCount('opvolging_taken',           (q) => q.in('status', ['open', 'wacht_inplanning', 'ingepland'])),
    safeCount('event_automation_runs',     (q) => q.eq('status', 'active')),
    safeCount('onboarding_automation_runs',(q) => q.eq('status', 'active')),
    safeCount('lisa_followups',            (q) => q.eq('status', 'scheduled')),
    safeCount('leadsonderhoud_bulk_recipients', (q) => q.in('status', ['pending', 'sending'])),
    safeCount('toegang_aanvragen',         (q) => q.eq('soort', '7-daagse').eq('status', 'wachtend')),
    safeCount('toegang_aanvragen',         (q) => q.eq('soort', 'minicursus').eq('status', 'wachtend')),
    safeCount('follow_up_leads',           (q) => q.eq('lead_status', 'terugbellen')),
    safeCount('onderhoud_wachtrij',        null),
  ]);

  const st = (label, tone) => ({ label, tone });

  const flows = [
    {
      key: 'opvolging',
      naam: 'Opvolging (Dave-lijst)',
      categorie: 'Sales · afronding',
      status: st('actief', 'emerald'),
      count: opvolging.count,
      count_label: 'open + wacht + ingepland',
      count_error: opvolging.error,
      kanalen: ['call', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'Opvolging',
      laatste_run: null,
    },
    {
      key: 'events_automations',
      naam: 'Event-automatiseringen',
      categorie: 'Events',
      status: st('per rij aan/uit', 'blue'),
      count: eventRuns.count,
      count_label: 'actieve runs',
      count_error: eventRuns.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'Events',
      laatste_run: null,
    },
    {
      key: 'onboarding_automations',
      naam: 'Onboarding-automatiseringen',
      categorie: 'Onboarding',
      status: st('per rij aan/uit', 'blue'),
      count: onboardingRuns.count,
      count_label: 'actieve runs',
      count_error: onboardingRuns.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'Onboarding',
      laatste_run: null,
    },
    {
      key: 'lisa_sequences',
      naam: 'Lisa (Instagram DM)',
      categorie: 'Lisa · IG',
      status: st('live-mode-gestuurd', 'blue'),
      count: lisaFollowups.count,
      count_label: 'ingeplande follow-ups',
      count_error: lisaFollowups.error,
      kanalen: ['instagram'],
      granulariteit: 'stap-voor-stap',
      // BP3 v41 (2026-09-04) — Lisa krijgt eigen subtab (spine + drawer).
      drilldown: 'Lisa',
      laatste_run: null,
    },
    {
      key: 'leadsonderhoud_bulk',
      naam: 'Leadsonderhoud · Bulk',
      categorie: 'Leadsonderhoud',
      status: st('handmatig goedkeuren', 'amber'),
      count: bulkRecipients.count,
      count_label: 'openstaande ontvangers',
      count_error: bulkRecipients.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      // BP3 v41 (2026-09-04) — Bulk krijgt eigen subtab (jobs + status-tegels).
      drilldown: 'Bulk',
      laatste_run: null,
    },
    {
      key: 'toegang_7daagse',
      naam: '7-daagse challenge',
      categorie: 'Toegang',
      status: st('actief', 'emerald'),
      count: toegang7daagse.count,
      count_label: 'wachtend op reactie',
      count_error: toegang7daagse.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      // BP3 v38 (2026-09-04) — deep-link naar Toegang-subtab met soort-param.
      drilldown: 'Toegang?soort=7-daagse',
      laatste_run: null,
    },
    {
      key: 'toegang_minicursus',
      naam: 'Mini-cursus',
      categorie: 'Toegang',
      status: st('actief', 'emerald'),
      count: toegangMini.count,
      count_label: 'wachtend op reactie',
      count_error: toegangMini.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'Toegang?soort=minicursus',
      laatste_run: null,
    },
    {
      key: 'event_belronde',
      naam: 'Event-belronde (T-2)',
      categorie: 'Events',
      status: st('cron 07:00', 'blue'),
      count: belronde.count,
      count_label: 'op bellijst',
      count_error: belronde.error,
      kanalen: ['call'],
      granulariteit: 'alleen totaal',
      // BP3 v41 — geen aparte subtab; opent compacte drilldown-drawer.
      drilldown: 'drawer:belronde',
      laatste_run: null,
    },
    {
      key: 'leadsonderhoud_drip',
      naam: 'Leadsonderhoud · Drip',
      categorie: 'Leadsonderhoud',
      status: st('one-way (geen reply-branch)', 'amber'),
      count: onderhoud.count,
      count_label: 'in wachtrij',
      count_error: onderhoud.error,
      kanalen: ['mail', 'whatsapp'],
      granulariteit: 'alleen totaal',
      // BP3 v41 — geen aparte subtab; opent compacte drilldown-drawer.
      drilldown: 'drawer:drip',
      laatste_run: null,
    },
    {
      key: 'call_bevestiging',
      naam: 'Call-bevestiging',
      categorie: 'Sales · afspraken',
      // BP3 v43 (2026-09-04) — bron bevestigd: follow_up_appointments +
      // reminder-kolommen (cron-afspraak-reminders). Live-flag afhankelijk
      // van AFSPRAAK_REMINDERS_LIVE; counts mogen 0 zijn als uit.
      status: st('gated (AFSPRAAK_REMINDERS_LIVE)', 'blue'),
      count: null, count_label: 'zie drilldown',
      count_error: null,
      kanalen: ['whatsapp'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'drawer:call',
      laatste_run: null,
    },
    {
      key: 'no_show_14d',
      naam: 'No-show / 14d-vervolg',
      categorie: 'Sales · afspraken',
      // BP3 v43 — bron bevestigd: student_signals (no_show) + onboardings
      // (first_call_reminder_task_at) 14d-window.
      status: st('cron 06:00 + 07:00', 'blue'),
      count: null, count_label: 'zie drilldown',
      count_error: null,
      kanalen: ['mentor'],
      granulariteit: 'stap-voor-stap',
      drilldown: 'drawer:noshow',
      laatste_run: null,
    },
  ];

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    flows,
  });
}
