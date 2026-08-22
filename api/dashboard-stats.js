import { createUserClient } from './supabase.js';
import { safeError } from './_lib/safe-error.js';
import { periodRange, nlDayStart, nlDayEndExclusive, nlDateString } from './_lib/nl-period.js';

// Laatste `n` NL-kalenderdagen (oudste eerst) als UTC-vensters [start, end).
// Voorheen bucketten de sparkline-/chart-loops op de server-lokale (UTC) dag via
// setHours(0,0,0,0), waardoor de daggrens ~1-2u verschoof t.o.v. Europe/Amsterdam.
// Anker op ~NL-noon van elke doeldag → robuust tegen DST bij het terugtellen.
function nlDayWindowsBack(n, ref) {
  const todayStart = nlDayStart(ref);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const anchor = new Date(todayStart.getTime() - i * 24 * 3600 * 1000 + 12 * 3600 * 1000);
    const start = nlDayStart(anchor);
    out.push({ start, end: nlDayEndExclusive(anchor), label: nlDateString(start) });
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const period = req.query?.period || 'today';

  try {
    const supabase = createUserClient(req);
    const now = new Date();
    // NL-uur voor de begroeting (Goedemorgen/-middag/-avond) — server draait op UTC.
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(now));

    // ── Period boundaries (NL-tijdzone-aware) ────────────────────────────────
    // Voorheen bepaalde setHours/getDay/getFullYear alles in server-lokale (UTC)
    // tijd → tellingen rond middernacht NL een dag verschoven.
    const startOfToday = periodRange('dag', now).start;                 // UTC-instant NL 00:00
    const startOfYest  = nlDayStart(new Date(startOfToday.getTime() - 12 * 3600 * 1000)); // NL gisteren 00:00
    const endOfYest    = new Date(startOfToday.getTime() - 1);          // -1ms: inclusief-eind gisteren

    let periodStart, periodEnd;
    if (period === 'week') {
      periodStart = periodRange('week', now).start;
      periodEnd   = now;
    } else if (period === 'month') {
      periodStart = periodRange('maand', now).start;
      periodEnd   = now;
    } else {
      periodStart = startOfToday;
      periodEnd   = now;
    }

    const periodStartIso = periodStart.toISOString();
    const periodEndIso   = periodEnd.toISOString();

    // Rolling fetch-vensters (geen kalender-bucket): laatste 14/7 dagen. Een paar
    // uur skew is hier irrelevant — de per-dag-bucketing gebeurt in nlDayWindowsBack.
    const fourteenAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
    const sevenAgo    = new Date(now.getTime() -  7 * 24 * 3600 * 1000);
    const monthStart  = periodRange('maand', now).start;               // NL 1e 00:00

    // ── All parallel queries ─────────────────────────────────────────────────
    const [
      emailsRes,
      takenRes,
      meetingsRes,
      approvalRes,
      auditRes,
      decisionsRes,
      approvalHistoryRes,
    ] = await Promise.all([
      supabase
        .from('email_messages')
        .select('id, date_received, category, requires_action, subject, from_address, from_name')
        .gte('date_received', fourteenAgo.toISOString())
        .order('date_received', { ascending: false })
        .limit(2000),

      supabase
        .from('taken_items')
        .select('id, titel, prioriteit, deadline, status')
        .eq('status', 'open')
        .order('prioriteit', { ascending: true })
        .limit(50),

      supabase
        .from('agent_meetings')
        .select('id, title, created_at, meeting_type, participants')
        .gte('created_at', monthStart.toISOString())
        .order('created_at', { ascending: false })
        .limit(50),

      supabase
        .from('agent_approval_queue')
        .select('id, agent_name, action, created_at, status')
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(20),

      supabase
        .from('agent_audit_log')
        .select('id, agent_name, action, status, created_at')
        .gte('created_at', sevenAgo.toISOString())
        .order('created_at', { ascending: false })
        .limit(200),

      supabase
        .from('decisions')
        .select('id, title, decision_date, created_at')
        .order('decision_date', { ascending: false })
        .limit(5),

      supabase
        .from('agent_approval_queue')
        .select('status')
        .in('status', ['approved', 'rejected'])
        .limit(1000),
    ]);

    const emails          = emailsRes.data           || [];
    const taken           = takenRes.data            || [];
    const meetings        = meetingsRes.data         || [];
    const approvals       = approvalRes.data         || [];
    const auditLog        = auditRes.data            || [];
    const decisions       = decisionsRes.data        || [];
    const approvalHistory = approvalHistoryRes.data  || [];

    // ── Helper: day-by-day sparkline over 14 days ────────────────────────────
    function sparkline14(arr, filterFn) {
      return nlDayWindowsBack(14, now).map((w) => {
        const lo = w.start.toISOString();
        const hi = w.end.toISOString();
        return arr.filter(e => e.date_received >= lo && e.date_received < hi && filterFn(e)).length;
      });
    }

    // ── Period emails ────────────────────────────────────────────────────────
    const inPeriod = emails.filter(e => e.date_received >= periodStartIso && e.date_received <= periodEndIso);
    const countCat = (arr, cat) => arr.filter(e => e.category === cat).length;

    const leadsSparkline = sparkline14(emails, e => e.category === 'Nieuwe Lead');
    const sessSparkline  = sparkline14(emails, e => e.category === 'Appointment');
    const gentSparkline  = sparkline14(emails, e =>
      e.category === 'Event Aanmelding' && (e.subject||'').toLowerCase().includes('gent'));

    const gemLeads = Math.round(leadsSparkline.reduce((a,b)=>a+b,0) / 14);

    const leadsToday    = countCat(inPeriod, 'Nieuwe Lead');
    const sessToday     = countCat(inPeriod, 'Appointment');
    const convPct       = leadsToday > 0 ? Math.round((sessToday / leadsToday) * 100) : 0;

    const gentInPeriod  = inPeriod.filter(e =>
      e.category === 'Event Aanmelding' && (e.subject||'').toLowerCase().includes('gent')).length;
    const gentYesterday = emails.filter(e => {
      const d = e.date_received;
      return d >= startOfYest.toISOString() && d <= endOfYest.toISOString()
        && e.category === 'Event Aanmelding' && (e.subject||'').toLowerCase().includes('gent');
    }).length;

    const onbeantwoord = emails.filter(e => e.requires_action === true).length;
    const onbSparkline = Array(14).fill(0); onbSparkline[13] = onbeantwoord;

    // ── Chart data ───────────────────────────────────────────────────────────
    const chartLeadMail = [];
    for (const w of nlDayWindowsBack(14, now)) {
      const lo = w.start.toISOString();
      const hi = w.end.toISOString();
      const day = emails.filter(e => e.date_received >= lo && e.date_received < hi);
      chartLeadMail.push({
        dag:    w.label,
        leads:  day.filter(e => e.category === 'Nieuwe Lead').length,
        totaal: day.length,
      });
    }

    const sevenIso   = sevenAgo.toISOString();
    const catCounts  = {};
    for (const e of emails.filter(e => e.date_received >= sevenIso)) {
      const cat = e.category || 'Onbekend';
      if (cat === 'Onbekend') continue;
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    const chartInboxMix = Object.entries(catCounts)
      .sort((a,b) => b[1]-a[1])
      .map(([category, count]) => ({ category, count }));

    // ── Recente activiteit ───────────────────────────────────────────────────
    const recentActivity = [];
    emails.filter(e => e.category === 'Nieuwe Lead').slice(0,3).forEach(e => recentActivity.push({
      type: 'lead', emoji: '🟢',
      description: `Nieuwe lead — ${e.subject || e.from_name || e.from_address || '?'}`,
      timestamp: e.date_received,
    }));
    emails.filter(e => e.category === 'Appointment').slice(0,2).forEach(e => recentActivity.push({
      type: 'appointment', emoji: '📅',
      description: `Uitlegsessie — ${e.subject || '?'}`,
      timestamp: e.date_received,
    }));
    auditLog.filter(e => e.status === 'success').slice(0,2).forEach(e => recentActivity.push({
      type: 'agent', emoji: '🤖',
      description: `${e.agent_name || 'Agent'} — ${e.action || '?'}`,
      timestamp: e.created_at,
    }));
    if (decisions[0]) recentActivity.push({
      type: 'decision', emoji: '✅',
      description: `Beslissing: ${decisions[0].title || '?'}`,
      timestamp: decisions[0].decision_date || decisions[0].created_at,
    });
    recentActivity.sort((a,b) => new Date(b.timestamp)-new Date(a.timestamp));

    // ── Agent status ─────────────────────────────────────────────────────────
    const agentCounts = { Simon: 0, Leon: 0, Aron: 0 };
    for (const e of auditLog) { if (e.agent_name in agentCounts) agentCounts[e.agent_name]++; }
    const agentStatus = Object.entries(agentCounts).map(([naam, acties_7d]) => ({
      naam, acties_7d, actief: acties_7d > 0,
    }));

    const approved     = approvalHistory.filter(a => a.status === 'approved').length;
    const goedkeurRate = approvalHistory.length > 0
      ? Math.round((approved / approvalHistory.length) * 100)
      : 100;

    // ── Greeting insight ─────────────────────────────────────────────────────
    const tijdGroet = h < 12 ? 'Goedemorgen' : h < 18 ? 'Goedemiddag' : 'Goedenavond';
    let inzicht = 'rustige dag, alles onder controle';
    if (onbeantwoord > 100) {
      inzicht = `vandaag focus op ${onbeantwoord} onbeantwoorde mails`;
    } else if (approvals.length > 0) {
      inzicht = `${approvals.length} approval${approvals.length > 1 ? 's' : ''} wacht${approvals.length === 1 ? '' : 'en'} op jouw goedkeuring`;
    } else if (leadsToday > gemLeads && gemLeads > 0) {
      inzicht = `sterke dag, ${leadsToday} nieuwe leads (gem. ${gemLeads}/dag)`;
    }

    // ── Payload ──────────────────────────────────────────────────────────────
    const payload = {
      generated_at: now.toISOString(),
      period,
      greeting: { tijd_groet: tijdGroet, inzicht },
      kpis_groot: {
        nieuwe_leads:      { value: leadsToday,    sparkline: leadsSparkline, gemiddelde: gemLeads },
        sessies:           { value: sessToday,     sparkline: sessSparkline,  conversie_percent: convPct },
        gent_aanmeldingen: { value: gentInPeriod,  sparkline: gentSparkline,  vs_gisteren: gentYesterday },
        onbeantwoord:      { value: onbeantwoord,  sparkline: onbSparkline,   vs_gisteren: 0 },
      },
      kpis_klein: {
        mails_period:      inPeriod.length,
        open_taken:        taken.length,
        meetings_period:   meetings.filter(m => m.created_at >= periodStartIso).length,
        pending_approvals: approvals.length,
      },
      chart_lead_mail: chartLeadMail,
      chart_inbox_mix: chartInboxMix,
      recente_activiteit: recentActivity.slice(0, 5),
      agent_status:       agentStatus,
      agent_aggregate: {
        goedkeur_rate_percent: goedkeurRate,
        decisions_totaal:      decisions.length,
        meetings_deze_maand:   meetings.length,
      },
      // ── Legacy fields (backwards compat met oude dashboard fetch) ─────────
      tasks: {
        total:  taken.length,
        urgent: taken.filter(t => t.prioriteit === 'Urgent').length,
        high:   taken.filter(t => t.prioriteit === 'Hoog').length,
        items:  taken.slice(0, 8),
      },
      unanswered:      { count: onbeantwoord },
      recent_activity: recentActivity.slice(0, 5),
    };

    return res.status(200).json(payload);

  } catch (err) {
    return safeError(res, 500, err);
  }
}
