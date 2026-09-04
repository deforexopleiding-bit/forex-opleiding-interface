// api/cron-afspraak-reminders.js
//
// Afspraak-reminders — Fase A (DRY-RUN). In-house call-bevestiging + reminders
// voor de OPSTARTSESSIE/kennismakings-calls. Model van cron-toegang-aanvragen.js:
// auth via CRON_SECRET, live-flag, nachtvenster (Amsterdam), claim-per-rij.
//
// ── WAT DEZE FASE WEL DOET ─────────────────────────────────────────────────
//   1) Gerichte Zoom-backfill (bovenaan): near-term geplande afspraken zonder
//      zoom_join_url matchen op Zoom-meeting (start_time-minuut) en de link
//      alsnog wegschrijven — zodat de bevestiging snel kan (zodra zoom binnen).
//   2) Per moment (bevestiging / 24u / 2u / 30m / 5min) de KANDIDATEN berekenen
//      op basis van follow_up_appointments.scheduled_at + de guard-kolommen, en
//      LOGGEN wat er verstuurd ZOU worden.
//
// ── WAT DEZE FASE NIET DOET ────────────────────────────────────────────────
//   - GEEN berichten (mail/WA) versturen.
//   - GEEN guard-kolommen claimen/zetten (dat zou de echte send in Fase B
//     onderdrukken). De guard-claim + send komt in Fase B, achter de live-flag.
//   De Zoom-backfill is een stille sync (net als follow-up-ghl-appointment-poll)
//   en schrijft wél — die stuurt niemand een bericht.
//
// SCOPE: alleen afspraken die via public.opstartsessie_submissions.appointment_id
//        gekoppeld zijn (de kennismakings-calls). Overige follow_up_appointments
//        (coaching, Lisa, follow-up-module) blijven buiten beschouwing.
//
// VERFIJNING (vastgelegd): het nachtvenster 21:00–08:00 Amsterdam geldt ALLEEN
// voor bevestiging + 24u. De 2u/30m/5-min reminders gaan altijd door (ook 's
// nachts) — die zijn tijdkritisch t.o.v. het call-moment.
//
// Live-flag: AFSPRAAK_REMINDERS_LIVE (Fase B). In Fase A verstuurt de cron
// sowieso niets, ongeacht de vlag — hij rapporteert alleen.
//
// 0 incasso-writes.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { listUpcomingZoomMeetings } from './_lib/zoom-meeting.js';

const NACHT_START_HOUR = 21;
const NACHT_EIND_HOUR  = 8;

// Tijd-vensters per moment (tijd-tot-call), in ms. Onder- en bovengrens zodat
// een last-minute boeking niet in één run alle stadia tegelijk afvuurt.
const MIN = 60 * 1000;
const UUR = 60 * MIN;
const VENSTERS = {
  reminder_24u_at: { onder: 2 * UUR,  boven: 24 * UUR, nacht_gevoelig: true  },
  reminder_2u_at:  { onder: 30 * MIN, boven: 2 * UUR,  nacht_gevoelig: false },
  reminder_30m_at: { onder: 5 * MIN,  boven: 30 * MIN, nacht_gevoelig: false, alleen_onbevestigd: true },
  zoom_5min_at:    { onder: 0,        boven: 5 * MIN,  nacht_gevoelig: false },
};

function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}

// Amsterdam-uur (respecteert DST) — identiek aan cron-toegang-aanvragen.js.
function amsUur(ms) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam', hourCycle: 'h23', hour: '2-digit',
  });
  return Number(dtf.format(new Date(ms)));
}
function isNacht(nowMs) {
  const u = amsUur(nowMs);
  return u >= NACHT_START_HOUR || u < NACHT_EIND_HOUR;
}

function isoMinuut(d) {
  return new Date(d).toISOString().slice(0, 16); // 'YYYY-MM-DDTHH:MM'
}

// Compacte beschrijving van een kandidatenset voor de dry-run-log.
function beschrijf(rows) {
  return {
    aantal: rows.length,
    voorbeeld: rows.slice(0, 5).map((r) => ({
      id: r.id,
      naam: r.lead_name || null,
      gepland: r.scheduled_at,
      zoom: r.zoom_join_url ? 'ok' : 'ontbreekt',
    })),
  };
}

// Near-term geplande afspraken die aan een opstartsessie-submission hangen.
async function haalKandidaten(nowMs) {
  const onder = new Date(nowMs - 15 * MIN).toISOString();  // 15m verleden buffer
  const boven = new Date(nowMs + 25 * UUR).toISOString();  // net voorbij 24u
  const { data: appts, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, zoom_join_url, zoom_meeting_id, bevestiging_sent_at, reminder_24u_at, reminder_2u_at, reminder_30m_at, zoom_5min_at, bevestigd_at, afspraak_token')
    .eq('status', 'scheduled')
    .gt('scheduled_at', onder)
    .lte('scheduled_at', boven)
    .limit(500);
  if (error) throw new Error('kandidaten-query: ' + error.message);
  const rows = appts || [];
  if (rows.length === 0) return [];

  // Scope: alleen afspraken met een gekoppelde opstartsessie-submission.
  const ids = rows.map((r) => r.id);
  const { data: subs, error: subErr } = await supabaseAdmin
    .from('opstartsessie_submissions')
    .select('appointment_id')
    .in('appointment_id', ids);
  if (subErr) throw new Error('submissions-scope-query: ' + subErr.message);
  const gekoppeld = new Set((subs || []).map((s) => s.appointment_id));
  return rows.filter((r) => gekoppeld.has(r.id));
}

// Gerichte Zoom-backfill: vul zoom_join_url voor near-term rijen die 'm missen.
// Stille sync (geen bericht) — draait ook in dry-run. Idempotent.
async function backfillZoom(kandidaten, summary) {
  const missend = kandidaten.filter((k) => !k.zoom_join_url);
  summary.zoom_backfill = { kandidaten_zonder_link: missend.length, aangevuld: 0 };
  if (missend.length === 0) return;

  const zoomUserId = process.env.ZOOM_USER_ID || null;
  if (!zoomUserId) { summary.zoom_backfill.skip = 'ZOOM_USER_ID ontbreekt'; return; }

  let meetings = [];
  try {
    meetings = await listUpcomingZoomMeetings(zoomUserId);
  } catch (e) {
    summary.zoom_backfill.skip = 'zoom-list fout: ' + (e?.message || e);
    return;
  }

  const perMinuut = new Map();
  for (const m of meetings) {
    const key = isoMinuut(m.start_time);
    const entry = { id: String(m.id), join_url: m.join_url || null };
    if (perMinuut.has(key)) perMinuut.get(key).push(entry);
    else perMinuut.set(key, [entry]);
  }

  for (const k of missend) {
    const kandidatenOpMinuut = perMinuut.get(isoMinuut(k.scheduled_at)) || [];
    const match = kandidatenOpMinuut.find((c) => c.join_url) || null;
    if (!match) continue;
    const { error } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ zoom_meeting_id: match.id, zoom_join_url: match.join_url })
      .eq('id', k.id)
      .is('zoom_join_url', null);           // atomair: alleen als nog leeg
    if (error) {
      summary.errors.push({ step: 'zoom-backfill', id: k.id, error: error.message });
      continue;
    }
    // In-memory bijwerken zodat de bevestiging-check 'm meteen meepakt.
    k.zoom_meeting_id = match.id;
    k.zoom_join_url = match.join_url;
    summary.zoom_backfill.aangevuld += 1;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Auth — identiek patroon aan cron-toegang-aanvragen.js: checkCronAuth geeft
  // een object {ok, status?, body?} terug (geen boolean).
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const live  = aanUit(process.env.AFSPRAAK_REMINDERS_LIVE);
  const now   = new Date();
  const nowMs = now.getTime();
  const nachtNu = isNacht(nowMs);

  const summary = {
    fase: 'A-dry-run',
    live,                       // Fase A verstuurt sowieso niets
    verzendt: false,            // expliciet: geen sends in deze fase
    nacht: nachtNu,
    momenten: {},
    zoom_backfill: null,
    errors: [],
  };

  try {
    const kandidaten = await haalKandidaten(nowMs);
    summary.kandidaten_totaal = kandidaten.length;

    // 1) Zoom-backfill (stille sync, ook in dry-run).
    await backfillZoom(kandidaten, summary);

    const tijdTot = (r) => new Date(r.scheduled_at).getTime() - nowMs;

    // 2a) BEVESTIGING — zodra zoom_join_url gevuld is (niet bij boeken).
    //     Nacht-gevoelig (samen met 24u). Geen tijd-venster; alleen "in de
    //     toekomst" + zoom aanwezig + nog niet verstuurd.
    let bevestiging = kandidaten.filter(
      (k) => !k.bevestiging_sent_at && k.zoom_join_url && tijdTot(k) > 0
    );
    if (nachtNu) {
      summary.momenten.bevestiging = { onderdrukt: 'nachtvenster', ...beschrijf(bevestiging) };
    } else {
      summary.momenten.bevestiging = beschrijf(bevestiging);
    }

    // 2b) REMINDERS 24u / 2u / 30m / 5min — tijd-vensters + guard-kolom.
    for (const [kolom, cfg] of Object.entries(VENSTERS)) {
      const onderdrukNacht = cfg.nacht_gevoelig && nachtNu;
      let rows = kandidaten.filter((k) => {
        if (k[kolom]) return false;                       // guard: al verstuurd
        if (cfg.alleen_onbevestigd && k.bevestigd_at) return false; // 30m: alleen als niet bevestigd
        const t = tijdTot(k);
        return t > cfg.onder && t <= cfg.boven;
      });
      summary.momenten[kolom] = onderdrukNacht
        ? { onderdrukt: 'nachtvenster', ...beschrijf(rows) }
        : beschrijf(rows);
    }

    // ── FASE B (later): hier komt per moment de atomic claimRow(id, kolom) +
    //    send (mail-shell + sendTemplate op de welkom-lijn), achter `live`.
    //    In Fase A bewust weggelaten: geen claim, geen send.
  } catch (e) {
    summary.errors.push({ step: 'run', error: e?.message || String(e) });
  }

  // Run-samenvatting persistent loggen als er iets te melden is.
  const heeftActie =
    (summary.kandidaten_totaal || 0) > 0 ||
    (summary.zoom_backfill?.aangevuld || 0) > 0 ||
    (summary.errors?.length || 0) > 0;
  if (heeftActie) {
    try {
      await supabaseAdmin.from('follow_up_events_log').insert({
        source:     'cron',
        event_type: 'afspraak-reminders-cron-run',
        payload:    summary,
        processed:  true,
      });
    } catch (persistErr) {
      console.warn('[cron-afspraak-reminders] summary-persist (soft):', persistErr?.message || persistErr);
    }
  }

  return res.status(200).json(summary);
}
