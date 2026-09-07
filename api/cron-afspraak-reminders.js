// api/cron-afspraak-reminders.js
//
// Afspraak-reminders — cron-motor voor de OPSTARTSESSIE/kennismakings-calls.
// Model van cron-toegang-aanvragen.js: auth via CRON_SECRET, live-flag,
// nachtvenster (Amsterdam), claim-per-rij.
//
// Fase A (fundament): guards/kolommen + dry-run.
// Fase B (deze): verstuurt mail + WhatsApp per moment ZODRA
//   AFSPRAAK_REMINDERS_LIVE aan staat. Zolang de vlag uit staat blijft het
//   dry-run (rekent + logt, verstuurt niets, zet geen guards).
//
// ── WAT DE CRON DOET ───────────────────────────────────────────────────────
//   1) Gerichte Zoom-backfill (stille sync): near-term geplande afspraken
//      zonder zoom_join_url matchen op de Zoom start_time-minuut en de link
//      alsnog wegschrijven — zodat de bevestiging snel kan.
//   2) Per moment (bevestiging / 24u / 2u / 30m / 5min) de kandidaten bepalen
//      op scheduled_at + guards, en — indien live — atomair de guard claimen
//      en mail + WhatsApp versturen (WA op de welkom-lijn, zodat replies in
//      dezelfde inbox landen als de toegang-flow).
//
// VERFIJNING: nachtvenster 21:00–08:00 Amsterdam geldt ALLEEN voor bevestiging
// + 24u. De 2u/30m/5-min reminders gaan altijd door (tijdkritisch t.o.v. call).
//
// SCOPE: alle afspraken uit een GHL-agenda-import (ghl_calendar_id NOT NULL).
// De toegang_aanvragen-flow (cron-toegang-aanvragen) blijft ongemoeid.
// 0 incasso-writes.

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { listUpcomingZoomMeetings } from './_lib/zoom-meeting.js';
import { sendTemplate, MetaNotConfiguredError } from './_lib/meta-whatsapp.js';
import { sendEmailViaSmtp } from './_lib/send-email-core.js';
import { logOutboundWa } from './_lib/wa-outbound-log.js';
import { MOMENTEN, bouwContext, resolveWelkomPhoneId, MIN, UUR } from './_lib/afspraak-berichten.js';
import { getCalendarNameMap } from './_lib/ghl-calendars.js';
import { bouwInternMail, waVars, bronVan } from './_lib/afspraak-intern-notify.js';

const NACHT_START_HOUR = 21;
const NACHT_EIND_HOUR  = 8;
const MAIL_FROM = 'welkom@deforexopleiding.nl'; // afspraak-mails naar leads vanaf welkom@ (zelfde lijn als de toegang-gate)

// Interne "nieuwe afspraak ingeboekt"-melding (los van de lead-reminders).
const INTERN_MAIL_TO     = 'leads@deforexopleiding.nl'; // leads@ = env IMAP_PASS; fallback welkom@
const INTERN_WA_TO       = '+31655270212';              // alleen dit nummer
const INTERN_WA_TEMPLATE = 'interne_nieuwe_afspraak_nl';

function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}
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
  return new Date(d).toISOString().slice(0, 16);
}

const APPT_COLS = 'id, lead_name, lead_email, lead_phone, scheduled_at, status, zoom_join_url, zoom_meeting_id, bevestiging_sent_at, reminder_24u_at, reminder_2u_at, reminder_30m_at, zoom_5min_at, bevestigd_at, afspraak_token';

// Near-term geplande afspraken uit een GHL-agenda-import (ghl_calendar_id NOT
// NULL). Verbreed van alleen-opstartsessie naar ALLE afspraak-agenda's; rijen
// van andere flows (Lisa/leadsonderhoud) hebben geen ghl_calendar_id en vallen
// er dus buiten.
async function haalKandidaten(nowMs) {
  const onder = new Date(nowMs - 15 * MIN).toISOString();
  const boven = new Date(nowMs + 25 * UUR).toISOString();
  const { data: appts, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select(APPT_COLS)
    .eq('status', 'scheduled')
    .not('ghl_calendar_id', 'is', null)
    .gt('scheduled_at', onder)
    .lte('scheduled_at', boven)
    .limit(500);
  if (error) throw new Error('kandidaten-query: ' + error.message);
  return appts || [];
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
      .is('zoom_join_url', null);
    if (error) { summary.errors.push({ step: 'zoom-backfill', id: k.id, error: error.message }); continue; }
    k.zoom_meeting_id = match.id;
    k.zoom_join_url = match.join_url;
    summary.zoom_backfill.aangevuld += 1;
  }
}

// ── Atomic claim/unclaim op een guard-kolom (race-veilig bij overlappende runs).
async function claimRow(id, kolom) {
  try {
    const { data } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ [kolom]: new Date().toISOString() })
      .eq('id', id)
      .is(kolom, null)
      .select('id')
      .maybeSingle();
    return !!(data && data.id);
  } catch (e) {
    console.warn(`[cron-afspraak-reminders] claim ${kolom} (soft):`, e?.message || e);
    return false;
  }
}
async function unclaimRow(id, kolom) {
  try {
    await supabaseAdmin.from('follow_up_appointments').update({ [kolom]: null }).eq('id', id);
  } catch (e) {
    console.warn(`[cron-afspraak-reminders] unclaim ${kolom} (soft):`, e?.message || e);
  }
}

// Verstuur mail + WhatsApp voor één afspraak/moment. Returnt per-kanaal-uitkomst.
async function verstuur(appt, moment, welkomPhoneId) {
  const ctx = bouwContext(appt);
  const uitkomst = { wa: null, mail: null };

  // ── WhatsApp (welkom-lijn) ──
  if (!welkomPhoneId) {
    uitkomst.wa = { ok: false, skipped: 'welkom-phone-ontbreekt' };
  } else if (!appt.lead_phone) {
    uitkomst.wa = { ok: false, skipped: 'geen-telefoon' };
  } else {
    const variables = moment.waVars(appt, ctx).map((v) => String(v ?? ''));
    try {
      const { wamid } = await sendTemplate({
        to: appt.lead_phone,
        templateName: moment.waTemplate,
        languageCode: 'nl',
        variables,
        phoneNumberId: welkomPhoneId,
      });
      const varsMap = {};
      variables.forEach((v, i) => { varsMap[String(i + 1)] = v; });
      await logOutboundWa(supabaseAdmin, {
        toPhone: appt.lead_phone,
        phoneNumberId: welkomPhoneId,
        body: `WhatsApp-template '${moment.waTemplate}' — ${variables.join(' · ')}`,
        wamid,
        templateName: moment.waTemplate,
        templateVariables: varsMap,
        source: 'afspraak-reminders-cron',
      });
      uitkomst.wa = { ok: true, wamid, template: moment.waTemplate };
    } catch (e) {
      if (e instanceof MetaNotConfiguredError) uitkomst.wa = { ok: false, skipped: 'meta-niet-geconfigureerd' };
      else uitkomst.wa = { ok: false, error: e?.message || String(e), http_status: e?.httpStatus ?? null };
    }
  }

  // ── E-mail (onboarding@) ──
  if (!appt.lead_email) {
    uitkomst.mail = { ok: false, skipped: 'geen-email' };
  } else {
    try {
      const { subject, text, html } = moment.mail(appt, ctx);
      const r = await sendEmailViaSmtp({ fromMailbox: MAIL_FROM, to: appt.lead_email, subject, text, html });
      uitkomst.mail = r?.ok ? { ok: true, messageId: r.messageId || null } : { ok: false, error: r?.reason || 'onbekend', code: r?.code };
    } catch (e) {
      uitkomst.mail = { ok: false, error: e?.message || String(e) };
    }
  }
  return uitkomst;
}

// ── INTERNE MELDING: kandidaten = ECHTE nieuwe boekingen die nog niet gemeld
// zijn. GEEN 25u-venster (melden bij binnenkomst). Filter:
//   status='scheduled' + ghl_calendar_id NOT NULL + parent_appointment_id NULL
//   (sluit reschedule-kinderen uit) + intern_notify_sent_at NULL (nog niet
//   gemeld — historische rijen zijn via de backfill op now() gezet).
async function haalInternKandidaten() {
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, booking_source, ghl_calendar_id')
    .eq('status', 'scheduled')
    .not('ghl_calendar_id', 'is', null)
    .is('parent_appointment_id', null)
    .is('intern_notify_sent_at', null)
    .order('scheduled_at', { ascending: true })
    .limit(200);
  if (error) throw new Error('intern-kandidaten-query: ' + error.message);
  return data || [];
}

// Verstuur de interne melding voor één afspraak: mail (leads@, fallback welkom@)
// + WhatsApp (vast nummer, welkom-lijn, template). Beide fail-soft; mail staat
// LOS van WA-approval.
async function verstuurIntern(appt, bron, welkomPhoneId) {
  const uit = { mail: null, wa: null };

  // ── Mail ──
  const { subject, text, html } = bouwInternMail(appt, bron);
  try {
    let r = await sendEmailViaSmtp({ fromMailbox: INTERN_MAIL_TO, to: INTERN_MAIL_TO, subject, text, html });
    // leads@ niet geconfigureerd (IMAP_PASS ontbreekt) → val terug op welkom@.
    if (!r?.ok && r?.code === 'SMTP_NOT_CONFIGURED') {
      r = await sendEmailViaSmtp({ fromMailbox: MAIL_FROM, to: INTERN_MAIL_TO, subject, text, html });
    }
    uit.mail = r?.ok ? { ok: true, messageId: r.messageId || null } : { ok: false, error: r?.reason || 'onbekend', code: r?.code };
  } catch (e) {
    uit.mail = { ok: false, error: e?.message || String(e) };
  }

  // ── WhatsApp (fail-soft; ook als het template nog niet APPROVED is) ──
  if (!welkomPhoneId) {
    uit.wa = { ok: false, skipped: 'welkom-phone-ontbreekt' };
  } else {
    try {
      const variables = waVars(appt, bron);
      const { wamid } = await sendTemplate({
        to: INTERN_WA_TO,
        templateName: INTERN_WA_TEMPLATE,
        languageCode: 'nl',
        variables,
        phoneNumberId: welkomPhoneId,
      });
      const varsMap = {};
      variables.forEach((v, i) => { varsMap[String(i + 1)] = v; });
      await logOutboundWa(supabaseAdmin, {
        toPhone: INTERN_WA_TO,
        phoneNumberId: welkomPhoneId,
        body: `WhatsApp-template '${INTERN_WA_TEMPLATE}' — ${variables.join(' · ')}`,
        wamid,
        templateName: INTERN_WA_TEMPLATE,
        templateVariables: varsMap,
        source: 'afspraak-intern-notify',
      });
      uit.wa = { ok: true, wamid };
    } catch (e) {
      if (e instanceof MetaNotConfiguredError) uit.wa = { ok: false, skipped: 'meta-niet-geconfigureerd' };
      else uit.wa = { ok: false, error: e?.message || String(e) };
    }
  }
  return uit;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const live  = aanUit(process.env.AFSPRAAK_REMINDERS_LIVE);
  const now   = new Date();
  const nowMs = now.getTime();
  const nachtNu = isNacht(nowMs);

  const summary = {
    live, verzendt: live, nacht: nachtNu,
    momenten: {}, zoom_backfill: null, errors: [],
  };

  try {
    const kandidaten = await haalKandidaten(nowMs);
    summary.kandidaten_totaal = kandidaten.length;

    // 1) Zoom-backfill (stille sync, ook in dry-run).
    await backfillZoom(kandidaten, summary);

    // 2) Welkom-lijn éénmaal resolven (alleen relevant als we versturen).
    const welkomPhoneId = live ? await resolveWelkomPhoneId() : null;
    if (live) summary.welkom_phone = welkomPhoneId ? 'ok' : 'ontbreekt';

    // 3) Per moment: kandidaten bepalen + (indien live) claimen en versturen.
    for (const moment of MOMENTEN) {
      const onderdrukNacht = moment.nachtGevoelig && nachtNu;
      const rows = kandidaten.filter((k) => moment.match(k, nowMs));
      const vak = { kandidaten: rows.length, onderdrukt: onderdrukNacht ? 'nachtvenster' : null, verstuurd: 0, resultaten: [] };

      if (!onderdrukNacht) {
        for (const appt of rows) {
          if (!live) {
            // Dry-run: alleen tonen wat verstuurd ZOU worden. Geen claim/send.
            vak.resultaten.push({ id: appt.id, naam: appt.lead_name, dry: true });
            continue;
          }
          // Live: atomair claimen vóór de sends (race-veilig).
          const gotClaim = await claimRow(appt.id, moment.kolom);
          if (!gotClaim) continue;
          const r = await verstuur(appt, moment, welkomPhoneId);
          const ietsGelukt = r.wa?.ok || r.mail?.ok;
          if (!ietsGelukt) {
            // Beide kanalen faalden → guard terugdraaien zodat een volgende run
            // 'em opnieuw probeert (transiente fout mag geen bericht kosten).
            await unclaimRow(appt.id, moment.kolom);
          } else {
            vak.verstuurd += 1;
          }
          vak.resultaten.push({ id: appt.id, wa: r.wa, mail: r.mail, teruggedraaid: !ietsGelukt });
        }
      }
      summary.momenten[moment.key] = vak;
    }

    // 4) INTERNE MELDING bij nieuwe boekingen — eigen query (geen 25u-venster),
    //    GEEN nachtvenster (interne alert voor de eigenaar), eigen live-flag.
    //    Atomaire claim per rij op intern_notify_sent_at → precies één melding.
    const internLive = aanUit(process.env.AFSPRAAK_INTERN_NOTIFY_LIVE);
    const internVak = { live: internLive, kandidaten: 0, gemeld: 0, resultaten: [] };
    try {
      const nieuw = await haalInternKandidaten();
      internVak.kandidaten = nieuw.length;
      if (internLive && nieuw.length) {
        let calNameMap = new Map();
        try { calNameMap = await getCalendarNameMap(); } catch (_) { /* fail-soft → '—' */ }
        // Welkom-lijn: hergebruik de al-geresolvede id, of resolve nu (reminder
        // kan dry-run zijn terwijl de interne melding wél live is).
        const waPhoneId = welkomPhoneId || await resolveWelkomPhoneId();
        for (const appt of nieuw) {
          const gotClaim = await claimRow(appt.id, 'intern_notify_sent_at');
          if (!gotClaim) continue; // andere run pakte 'm al
          const bron = bronVan(appt, calNameMap);
          const r = await verstuurIntern(appt, bron, waPhoneId);
          // Mail staat los van WA-approval: als mail OF WA lukt, blijft de claim
          // staan (geen dubbele melding). Alleen als BEIDE falen → terugdraaien.
          const ietsGelukt = r.mail?.ok || r.wa?.ok;
          if (!ietsGelukt) await unclaimRow(appt.id, 'intern_notify_sent_at');
          else internVak.gemeld += 1;
          internVak.resultaten.push({ id: appt.id, mail: r.mail, wa: r.wa, teruggedraaid: !ietsGelukt });
        }
      }
    } catch (e) {
      internVak.error = e?.message || String(e);
      summary.errors.push({ step: 'intern-notify', error: internVak.error });
    }
    summary.intern_notify = internVak;
  } catch (e) {
    summary.errors.push({ step: 'run', error: e?.message || String(e) });
  }

  const heeftActie =
    (summary.kandidaten_totaal || 0) > 0 ||
    (summary.zoom_backfill?.aangevuld || 0) > 0 ||
    (summary.errors?.length || 0) > 0;
  if (heeftActie) {
    try {
      await supabaseAdmin.from('follow_up_events_log').insert({
        source: 'cron',
        event_type: 'afspraak-reminders-cron-run',
        payload: summary,
        processed: true,
      });
    } catch (persistErr) {
      console.warn('[cron-afspraak-reminders] summary-persist (soft):', persistErr?.message || persistErr);
    }
  }

  return res.status(200).json(summary);
}
