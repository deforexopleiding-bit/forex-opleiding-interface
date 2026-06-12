// api/cron-events-signups-auto-close.js
//
// F2 Blok 1 - hourly auto-close van events waarvan de signup-deadline
// gepasseerd is.
//
// Deadline-definitie (lock OQ1 / OQ2):
//   now >= midnight(starts_at - 1 day, Europe/Amsterdam)
//
// Praktische vertaling: zodra de NL-kalenderdag van "starts_at - 1 dag"
// is aangebroken (00:00 NL), sluiten de signups. Equivalent: vanaf
// 00:00 NL de dag VOOR het event.
//
// Implementatie: bereken in JS de cutoff "morgen 00:00 NL" (in UTC),
// en filter `starts_at < cutoff`. Alles wat eerder start dan morgen-
// middernacht-NL voldoet aan de deadline-conditie.
//
// Voorbeeld: vandaag is 12 juni 14:00 NL. Cutoff = 13 juni 00:00 NL.
//   - Event op 13 juni 19:00 starts_at < cutoff?  Nee, want starts_at
//     (13 juni 19:00) > 13 juni 00:00 NL.
//   - Maar wacht: deadline = midnight(13 juni - 1 dag) = 12 juni 00:00 NL.
//     Die is gepasseerd. Dus event MOET sluiten.
//   - Conclusie: deze rekensom klopt niet. Herzien:
//
// Juiste vertaling:
//   deadline(event) = midnight(starts_at - 1 day, NL)
//   We willen events waar now >= deadline(event).
//   <=> deadline(event) <= now
//   <=> midnight(starts_at - 1 day, NL) <= now
//   <=> starts_at - 1 day < (volgende_midnight_na_now, NL)
//   <=> starts_at < now_NL_day + 1 day + 1 day = now_NL_day + 2 days @ 00:00 NL
//
// Hmm dat klopt ook niet helemaal als je strict bent met midnight-grenzen.
// Eenvoudigere route: doe de check per-event in JS na een ruime SQL-pre-filter.
//
// Pre-filter SQL: status='published' AND signups_closed=false AND
//   starts_at < now() + interval '3 days'
// (alle events die in de komende 3 dagen starten of al gestart zijn).
//
// In JS: per event reken `deadlineMs = amsterdamMidnightUtcMs(startsAt - 1d)`.
//   Als Date.now() >= deadlineMs -> kandidaat voor auto-close.
//
// Per match:
//   1. UPDATE events SET signups_closed=true, signups_closed_at=now(),
//        signups_closed_reason='auto_time',
//        signups_closed_by_user_id=NULL
//      (lock OQ1: 3-veld model, NULL voor cron-write).
//   2. AWAIT closeSignupsOutbound(event.id)
//      - Webflow: PATCH item naar isDraft=true (staged record blijft)
//      - GHL: recompute upcoming-labels (event valt uit de set)
//   3. Logging in summary; orchestrator zelf schrijft event_sync_log.
//
// Per-event try/catch (lesson learned 3 - nooit early-return op 1 faal-item).
//
// Idempotent: door signups_closed=false WHERE-filter en race-guard op
// UPDATE raken we elk event hooguit 1x.
//
// Auth: Authorization: Bearer $CRON_SECRET (checkCronAuth).
// Methodes: GET (Vercel cron) + POST (handmatige debug-trigger).
// Schedule: 0 * * * * (hourly UTC; DST-immuun door SQL-side
// timestamptz comparisons + JS NL-midnight berekening).

import { checkCronAuth, supabaseAdmin } from './supabase.js';
import { closeSignupsOutbound } from './_lib/event-sync-orchestrator.js';

const BATCH_LIMIT = 50;
const ABORT_MS    = 50_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const startedAt = Date.now();
  const summary = {
    pre_filter_rows: 0,
    processed: 0,
    closed: 0,
    sync_errors: 0,
    db_errors: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    // Pre-filter: alles wat in komende ~3 dagen start (of al gestart is) is
    // potentieel een kandidaat. Cron draait elk uur, dus ruim genoeg.
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: rows, error: selErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status, signups_closed')
      .eq('status', 'published')
      .eq('signups_closed', false)
      .lte('starts_at', future)
      .order('starts_at', { ascending: true })
      .limit(500);
    if (selErr) throw new Error('select events: ' + selErr.message);

    summary.pre_filter_rows = (rows || []).length;

    const candidates = (rows || []).filter((r) => isPastDeadlineAmsterdam(r.starts_at));
    const batch = candidates.slice(0, BATCH_LIMIT);
    summary.processed = batch.length;

    for (const ev of batch) {
      if (Date.now() - startedAt > ABORT_MS) {
        summary.errors.push({ phase: 'time_budget', message: 'aborted before completion' });
        break;
      }

      try {
        // Stap 1: DB-write (signups_closed=true + audit-velden).
        const { data: updated, error: updErr } = await supabaseAdmin
          .from('events')
          .update({
            signups_closed: true,
            signups_closed_at: new Date().toISOString(),
            signups_closed_reason: 'auto_time',
            signups_closed_by_user_id: null,
          })
          .eq('id', ev.id)
          .eq('signups_closed', false) // race-guard tegen parallelle runs
          .select('id')
          .maybeSingle();
        if (updErr) {
          summary.db_errors++;
          summary.errors.push({ event_id: ev.id, phase: 'db_update', error: updErr.message });
          console.error('[cron-events-signups-auto-close] db_update failed', ev.id, updErr.message);
          continue;
        }
        if (!updated) {
          // Race: andere run heeft hem al gesloten. Skip outbound sync.
          continue;
        }

        summary.closed++;

        // Stap 2: outbound sync (Webflow unpublish + GHL recompute) AWAITED.
        try {
          await closeSignupsOutbound(ev.id);
        } catch (syncErr) {
          summary.sync_errors++;
          summary.errors.push({
            event_id: ev.id,
            phase: 'sync',
            error: syncErr?.message || String(syncErr),
          });
          console.error('[cron-events-signups-auto-close] sync failed', ev.id, syncErr?.message);
          // DB-state is al consistent (signups_closed=true). Retry-cron pakt
          // de Webflow/GHL-faal op via event_sync_log (orchestrator logt zelf).
        }
      } catch (e) {
        summary.errors.push({ event_id: ev.id, phase: 'outer', error: e?.message || String(e) });
        console.error('[cron-events-signups-auto-close] outer fail', ev.id, e?.message);
      }
    }

    summary.duration_ms = Date.now() - startedAt;
    console.log('[cron-events-signups-auto-close]', JSON.stringify(summary));
    return res.status(200).json(summary);
  } catch (e) {
    summary.duration_ms = Date.now() - startedAt;
    summary.errors.push({ phase: 'fatal', error: e?.message || String(e) });
    console.error('[cron-events-signups-auto-close] fatal', e);
    return res.status(500).json(summary);
  }
}

// ----------------------------------------------------------------------------
// Deadline-check helpers (DST-safe via Intl + iteratieve offset-resolve)
// ----------------------------------------------------------------------------

/**
 * Deadline-check: is now >= midnight(starts_at - 1 day, Europe/Amsterdam)?
 *
 * Stappen:
 *   1. Bepaal de NL-kalenderdag (yyyy-mm-dd) van starts_at.
 *   2. Trek 1 dag af (NL-tijd, DST-veilig via 12:00 UTC pivot).
 *   3. Bouw absolute UTC-ms voor 00:00 NL van die dag.
 *   4. Vergelijk met Date.now().
 */
function isPastDeadlineAmsterdam(startsAtIso) {
  if (!startsAtIso) return false;
  const start = new Date(startsAtIso);
  if (Number.isNaN(start.getTime())) return false;

  const startNl = nlDateParts(start);
  if (!startNl) return false;

  // Dag voor het event (NL-tijd). 12:00 UTC pivot is DST-veilig: 1 etmaal
  // eraf landt altijd in de gewenste vorige NL-kalenderdag.
  const noonUtc = new Date(Date.UTC(startNl.y, startNl.m - 1, startNl.d, 12, 0, 0));
  const dayBefore = new Date(noonUtc.getTime() - 24 * 60 * 60 * 1000);
  const beforeNl = nlDateParts(dayBefore);
  if (!beforeNl) return false;

  const deadlineMs = amsterdamMidnightUtcMs(beforeNl.y, beforeNl.m, beforeNl.d);
  if (deadlineMs === null) return false;

  return Date.now() >= deadlineMs;
}

/** Geef { y, m, d } voor `date` IN Europe/Amsterdam. */
function nlDateParts(date) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date);
    const y = parseInt(parts.find((p) => p.type === 'year')?.value, 10);
    const m = parseInt(parts.find((p) => p.type === 'month')?.value, 10);
    const d = parseInt(parts.find((p) => p.type === 'day')?.value, 10);
    if (!y || !m || !d) return null;
    return { y, m, d };
  } catch {
    return null;
  }
}

/**
 * Bouw UTC-ms voor 00:00 Europe/Amsterdam op gegeven NL-kalenderdatum.
 *
 * Strategie:
 *   1. Eerste schatting via huidige offset (CET=+60 / CEST=+120).
 *   2. Verifieer of de schatting in NL-tijd inderdaad 00:00 op (y, m, d) toont.
 *   3. DST-correctie: probeer +/-1u, +/-2u indien nodig (DST-overgangsdag).
 */
function amsterdamMidnightUtcMs(year, month, day) {
  try {
    const guess1 = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
    const offset1 = amsterdamOffsetMinutes(guess1);
    const ms1 = guess1.getTime() - offset1 * 60_000;

    if (verifyNlMidnight(ms1, year, month, day)) return ms1;

    for (const deltaHours of [-1, 1, -2, 2]) {
      const ms2 = ms1 + deltaHours * 3600_000;
      if (verifyNlMidnight(ms2, year, month, day)) return ms2;
    }
    return ms1; // hooguit 1u afwijking op DST-overgangsdag
  } catch {
    return null;
  }
}

function verifyNlMidnight(utcMs, year, month, day) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcMs));
  const y = parseInt(parts.find((p) => p.type === 'year')?.value, 10);
  const m = parseInt(parts.find((p) => p.type === 'month')?.value, 10);
  const d = parseInt(parts.find((p) => p.type === 'day')?.value, 10);
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
  const mn = parseInt(parts.find((p) => p.type === 'minute')?.value, 10);
  return y === year && m === month && d === day && h === 0 && mn === 0;
}

/**
 * Geef offset (minuten) van Europe/Amsterdam tov UTC op gegeven tijdstip.
 * Resultaat: 60 (CET) of 120 (CEST).
 */
function amsterdamOffsetMinutes(date) {
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);
  const tzName = tzParts.find((p) => p.type === 'timeZoneName')?.value || '';
  const m = tzName.match(/[+-]\d{1,2}(?::?\d{2})?/);
  if (!m) return 60; // veilige fallback CET
  const raw = m[0];
  const sign = raw.startsWith('-') ? -1 : 1;
  const body = raw.slice(1);
  let hours = 0, mins = 0;
  if (body.includes(':')) {
    const [h, mm] = body.split(':');
    hours = parseInt(h, 10);
    mins = parseInt(mm, 10);
  } else {
    hours = parseInt(body, 10);
  }
  return sign * (hours * 60 + (mins || 0));
}
