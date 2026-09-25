// api/cron-reminder-alarm.js
//
// Reminder-ALARM (Fase 1) — bewaakt de afspraak-reminderflow
// (api/cron-afspraak-reminders.js) en MAILT bij problemen. PUUR lezen + mailen +
// een eigen state-log; muteert NOOIT guard-/claim-kolommen op afspraken en kan
// de reminder-flow dus niet breken (aparte functie, eigen try/catch).
//
// Watchdog — detecteert twee dingen (real-time, hoogstens 1×/uur):
//   (b) DUE-MAAR-ONVERSTUURD— afspraken (scheduled + ghl_calendar_id NOT NULL)
//                             waarvan een moment al > 6 min in zijn venster staat
//                             maar de guard nog NULL is. Oorzaak-onafhankelijk
//                             vangnet (dekt timeout- én partial-drop-gevallen).
//   (c) CRON STAAT STIL     — laatste 'reminder-cron-heartbeat' in
//                             follow_up_events_log ouder dan 10 min.
//
// Tak (a) — mislukte sends per poging — is verhuisd naar de dagelijkse
// samenvatting (api/cron-reminder-alarm-digest.js). Per-poging-alarmen
// veroorzaakten 95 mails/dag bij één onbezorgbaar adres (2026-09-24).
//
// Anti-spam: state in follow_up_events_log (event_type='reminder-alarm', payload
// { last_alert_at }). Doorlopende toestanden hoogstens eens per uur.
//
// Mail via sendEmailViaSmtp (welkom@, werkende creds) naar
// process.env.ALARM_EMAIL || 'jeffreybiemold@gmail.com'.
//
// SCOPE: raakt de oude GHL/Webflow-flow NIET. 0 writes op afspraken.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';

const ALARM_EMAIL         = process.env.ALARM_EMAIL || 'jeffreybiemold@gmail.com';
const ALARM_FROM          = 'welkom@deforexopleiding.nl';   // mailbox met werkende SMTP-creds
const COOLDOWN_MS         = 60 * 60 * 1000;                 // doorlopende toestanden: hoogstens 1×/uur
const HEARTBEAT_STALE_MS  = 10 * 60 * 1000;                 // cron > 10 min stil = alarm
const H = 3600000, M = 60000;

// Eén due-maar-onverstuurd-query (leest alleen; limit 50 + sample).
async function dueQuery(build) {
  try {
    let q = supabaseAdmin.from('follow_up_appointments')
      .select('id, lead_name, scheduled_at')
      .eq('status', 'scheduled')
      .not('ghl_calendar_id', 'is', null)
      .order('scheduled_at', { ascending: true })
      .limit(50);
    q = build(q);
    const { data, error } = await q;
    if (error) return { count: 0, capped: false, sample: [], error: error.message };
    const rows = data || [];
    return {
      count: rows.length,
      capped: rows.length >= 50,
      sample: rows.slice(0, 5).map((r) => ({ id: r.id, naam: r.lead_name, wanneer: r.scheduled_at })),
    };
  } catch (e) {
    return { count: 0, capped: false, sample: [], error: e?.message || String(e) };
  }
}

function fmtDue(label, d) {
  if (!d || (!d.count && !d.error)) return null;
  if (d.error) return `${label}: query-fout — ${d.error}`;
  const s = d.sample.map((x) => `    - ${x.naam || '?'} @ ${x.wanneer}`).join('\n');
  return `${label}: ${d.count}${d.capped ? '+' : ''} afspraak(en)\n${s}`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const nowMs  = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const out = { checked_at: nowIso, mailed: false, issues: {} };

  try {
    // ── State laden (anti-spam) ──────────────────────────────────────────
    let lastAlertAt = null;   // laatste keer dat we ECHT mailden
    try {
      const { data: st } = await supabaseAdmin
        .from('follow_up_events_log')
        .select('payload, received_at')
        .eq('event_type', 'reminder-alarm')
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      lastAlertAt = st?.payload?.last_alert_at || null;
    } catch (e) {
      out.issues.state_read_error = e?.message || String(e);
    }

    // ── (c) CRON STAAT STIL: laatste heartbeat-leeftijd ──────────────────
    let cronStale = false;
    let heartbeatAgeMin = null;
    try {
      const { data: hb } = await supabaseAdmin
        .from('follow_up_events_log')
        .select('received_at')
        .eq('event_type', 'reminder-cron-heartbeat')
        .order('received_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (hb?.received_at) {
        const ageMs = nowMs - Date.parse(hb.received_at);
        heartbeatAgeMin = Math.round(ageMs / 60000);
        cronStale = ageMs > HEARTBEAT_STALE_MS;
      }
      // Geen heartbeat-rij → nog nooit gedraaid (bv. vlak na deploy). Bewust
      // GEEN alarm: we willen geen false-positive vóór de reminder-cron één
      // keer heeft gedraaid. Zodra er heartbeats zijn, werkt staleness-detectie.
    } catch (e) {
      out.issues.heartbeat_error = e?.message || String(e);
    }
    out.issues.cron_stale = cronStale;
    out.issues.heartbeat_age_min = heartbeatAgeMin;

    // ── (b) DUE-MAAR-ONVERSTUURD (venster > 6 min open) ──────────────────
    const G = 6 * M; // grace, geen false-alarm op wat de 3-min-cron net nog niet zag
    const iso = (ms) => new Date(ms).toISOString();
    const due = {
      // 24u-reminder: (2u, 24u] → venster > 6 min open
      r24: await dueQuery((q) => q.is('reminder_24u_at', null)
        .gt('scheduled_at', iso(nowMs + 2 * H)).lte('scheduled_at', iso(nowMs + 24 * H - G))),
      // 2u-reminder: (30m, 2u]
      r2: await dueQuery((q) => q.is('reminder_2u_at', null)
        .gt('scheduled_at', iso(nowMs + 30 * M)).lte('scheduled_at', iso(nowMs + 2 * H - G))),
      // 30m-reminder: (5m, 30m], alleen als nog niet bevestigd
      r30: await dueQuery((q) => q.is('reminder_30m_at', null).is('bevestigd_at', null)
        .gt('scheduled_at', iso(nowMs + 5 * M)).lte('scheduled_at', iso(nowMs + 30 * M - G))),
      // zoom5 "we beginnen zo": venster is maar 5 min (kleiner dan de grace), dus
      // flaggen als de call net is begonnen (≤ nu, binnen 15 min) en 'm nooit ging.
      zoom5: await dueQuery((q) => q.is('zoom_5min_at', null)
        .gt('scheduled_at', iso(nowMs - 15 * M)).lte('scheduled_at', iso(nowMs))),
      // bevestiging: zoom-link binnen maar > 10 min niet bevestigd (call in de toekomst).
      // Afspraken met al gelogde pogingen of een give-up-marker zijn geen STILLE
      // drop meer — die staan in de faillog en komen in de dagelijkse digest.
      bevestiging: await dueQuery((q) => q.is('bevestiging_sent_at', null).not('zoom_join_url', 'is', null)
        .is('bevestiging_gaveup_at', null).eq('bevestiging_mail_attempts', 0).eq('bevestiging_wa_attempts', 0)
        .gt('scheduled_at', iso(nowMs)).lte('created_at', iso(nowMs - 10 * M))),
    };
    const dueTotal = Object.values(due).reduce((s, d) => s + (d.count || 0), 0);
    out.issues.due_unsent = Object.fromEntries(Object.entries(due).map(([k, v]) => [k, v.count]));
    out.issues.due_total = dueTotal;

    // ── Beslissen of we mailen ───────────────────────────────────────────
    // Alleen doorlopende toestanden (b/c), hoogstens 1×/uur. Mislukte sends
    // per poging gaan naar de dagelijkse digest, niet hierheen.
    const ongoing = dueTotal > 0 || cronStale;
    const cooldownOk = !lastAlertAt || (nowMs - Date.parse(lastAlertAt)) >= COOLDOWN_MS;
    const shouldMail = ongoing && cooldownOk;
    out.shouldMail = shouldMail;

    if (shouldMail) {
      const regels = [];
      regels.push(`Reminder-alarm — ${nowIso}`);
      regels.push('');
      if (dueTotal > 0) {
        regels.push(`(b) Due-maar-onverstuurd: ${dueTotal} afspraak(en) waarvan een reminder al had moeten vuren`);
        [['Bevestiging', due.bevestiging], ['24u-reminder', due.r24], ['2u-reminder', due.r2], ['30m-reminder', due.r30], ['Zoom-5min', due.zoom5]]
          .map(([label, d]) => fmtDue(label, d)).filter(Boolean).forEach((s) => regels.push('  ' + s.replace(/\n/g, '\n  ')));
        regels.push('');
      }
      if (cronStale) {
        regels.push(`(c) Reminder-cron staat mogelijk stil: laatste heartbeat ${heartbeatAgeMin} min geleden (drempel 10 min).`);
        regels.push('');
      }
      regels.push('— Automatisch alarm van cron-reminder-alarm (watchdog). Mislukte sends per afspraak staan in de dagelijkse samenvatting van 08:00.');
      const text = regels.join('\n');
      const n = dueTotal + (cronStale ? 1 : 0);
      const subject = `⚠️ Reminder-alarm: ${n} probleem${n === 1 ? '' : 'en'} in de afspraak-reminders`;

      let mailRes = { ok: false, reason: 'niet verstuurd' };
      try {
        mailRes = await sendEmailViaSmtp({ fromMailbox: ALARM_FROM, to: ALARM_EMAIL, subject, text });
      } catch (e) {
        mailRes = { ok: false, reason: e?.message || String(e) };
      }
      out.mailed = !!mailRes.ok;
      out.mail_error = mailRes.ok ? null : (mailRes.reason || 'onbekend');

      // State alleen bijwerken als de mail ECHT de deur uit ging: dan start de
      // cooldown. Faalt de mail, dan laten we de state staan → volgende run
      // probeert opnieuw.
      if (mailRes.ok) {
        try {
          await supabaseAdmin.from('follow_up_events_log').insert({
            source: 'cron', event_type: 'reminder-alarm', processed: true,
            payload: { at: nowIso, last_alert_at: nowIso,
              gemeld: { due_total: dueTotal, cron_stale: cronStale } },
          });
        } catch (e) { out.issues.state_write_error = e?.message || String(e); }
      }
    }
  } catch (e) {
    // Alarm mag NOOIT de boel breken — vang alles af en rapporteer 200.
    out.fatal = e?.message || String(e);
  }

  return res.status(200).json(out);
}
