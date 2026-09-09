// api/admin-recon-appointments.js
//
// TIJDELIJK diagnose-endpoint — read-only reconciliatie van GHL calendar
// events (2026-09) vs `follow_up_appointments`. Bedoeld voor éénmalige
// inspectie na de ghost-flip-affaire (PR #1535). VERWIJDEREN zodra het
// rapport gelezen is.
//
// GET /api/admin-recon-appointments
//   → HTML-shell die na login-JWT-check /api/admin-recon-appointments?data=1
//     aanroept en het rapport rendert.
// GET /api/admin-recon-appointments?data=1
//   → JSON met kalenders + categorieën A/B/C/D.
//
// Auth: verifyAdmin (super_admin / admin sessie). Geen CRON_SECRET, geen
// publiek pad.
//
// 0 writes. 0 mutaties. 0 incasso-zone-aanraking.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { listCalendars } from './_lib/ghl-calendars.js';

const GHL_BASE  = 'https://services.leadconnectorhq.com';
const START_ISO = '2026-09-01T00:00:00.000Z';
const END_ISO   = '2026-10-01T00:00:00.000Z';

function pollIterates(cal) { return cal.isActive !== false; }

async function fetchEventsForCalendar(calId) {
  const url = new URL(`${GHL_BASE}/calendars/events`);
  url.searchParams.set('locationId', process.env.GHL_LOCATION_ID);
  url.searchParams.set('calendarId', calId);
  url.searchParams.set('startTime',  String(new Date(START_ISO).getTime()));
  url.searchParams.set('endTime',    String(new Date(END_ISO).getTime()));
  try {
    const r = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY}`,
        Version: '2021-04-15',
        Accept: 'application/json',
      },
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => '')).slice(0, 300);
      return { ok: false, status: r.status, body, events: [] };
    }
    const j = await r.json();
    const evs = j.events || j.data || [];
    return {
      ok: true,
      status: 200,
      events: evs.map(e => ({
        id: e.id,
        calendarId: e.calendarId || calId,
        startTime: e.startTime || e.start_time || e.start || null,
        endTime:   e.endTime   || e.end_time   || e.end   || null,
        title:     e.title     || e.name       || null,
        appointmentStatus: e.appointmentStatus || null,
        contactId: e.contactId || null,
        contactName: e.contactName || e.contact?.name || null,
        email:     e.email || e.contact?.email || null,
        phone:     e.phone || e.contact?.phone || null,
      })),
    };
  } catch (e) {
    return { ok: false, status: 0, body: String(e?.message || e), events: [] };
  }
}

async function buildReport() {
  // Stap 1+2: alle kalenders + welke poll itereert
  const cals = await listCalendars();
  const perCal = new Map();
  const allEvents = [];
  for (const c of cals) {
    const res = await fetchEventsForCalendar(c.id);
    perCal.set(c.id, res);
    if (res.ok) allEvents.push(...res.events);
  }

  // Stap 3: DB rijen sep 2026
  const { data: dbRows, error: dbErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, ghl_calendar_id, ghl_appointment_id, updated_at')
    .gte('scheduled_at', START_ISO)
    .lt('scheduled_at', END_ISO)
    .order('scheduled_at');
  if (dbErr) throw new Error(`DB fetch: ${dbErr.message}`);

  const dbByGhlId = new Map((dbRows || []).filter(r => r.ghl_appointment_id).map(r => [r.ghl_appointment_id, r]));
  const ghlEventById = new Map(allEvents.map(e => [e.id, e]));

  // Stap 4: diff-categorieën
  const catA = [];
  for (const ev of allEvents) {
    if ((ev.appointmentStatus || '').toLowerCase() === 'cancelled') continue;
    if (!dbByGhlId.has(ev.id)) {
      const cal = cals.find(c => c.id === ev.calendarId);
      catA.push({
        ghl_id: ev.id,
        name: ev.contactName || ev.title || null,
        email: ev.email || null,
        phone: ev.phone || null,
        ghl_start: ev.startTime,
        ghl_status: ev.appointmentStatus,
        calendar_id: ev.calendarId,
        calendar_name: cal?.name || null,
        calendar_active: cal?.isActive ?? null,
        polled: cal ? pollIterates(cal) : null,
      });
    }
  }

  const HIDDEN = new Set(['cancelled', 'no_show', 'verwijderd', 'wacht_op_reschedule']);
  const catB = (dbRows || [])
    .filter(r => HIDDEN.has(r.status))
    .map(r => ({
      db_id: r.id,
      name: r.lead_name,
      db_start: r.scheduled_at,
      db_status: r.status,
      ghl_id: r.ghl_appointment_id,
      calendar_id: r.ghl_calendar_id,
      still_in_ghl: r.ghl_appointment_id ? ghlEventById.has(r.ghl_appointment_id) : null,
      ghl_status_now: r.ghl_appointment_id ? (ghlEventById.get(r.ghl_appointment_id)?.appointmentStatus ?? null) : null,
    }));

  const catC = [];
  for (const ev of allEvents) {
    const dbRow = dbByGhlId.get(ev.id);
    if (!dbRow || !ev.startTime) continue;
    const ghlMs = new Date(ev.startTime).getTime();
    const dbMs  = new Date(dbRow.scheduled_at).getTime();
    if (Math.abs(ghlMs - dbMs) > 60_000) {
      catC.push({
        ghl_id: ev.id,
        name: dbRow.lead_name || ev.contactName,
        ghl_start: ev.startTime,
        db_start:  dbRow.scheduled_at,
        db_status: dbRow.status,
        diff_min: Math.round((ghlMs - dbMs) / 60000),
        calendar_id: ev.calendarId,
      });
    }
  }

  const catD = [];
  for (const c of cals) {
    if (pollIterates(c)) continue;
    const e = perCal.get(c.id);
    if (e?.ok && e.events.length > 0) {
      catD.push({
        calendar_id: c.id,
        calendar_name: c.name,
        isActive: c.isActive,
        ghl_events_sep: e.events.length,
      });
    }
  }

  // ── Herstel-SQL: verborgen in CRM maar actief in GHL ─────────────────────
  // Spiegelt de mapGhlStatus() uit follow-up-ghl-appointment-poll.js:
  //   confirmed / booked / scheduled → 'scheduled'
  //   showed                         → 'completed'
  // Alleen rijen die momenteel in een verborgen status staan
  // (cancelled / no_show / wacht_op_reschedule) én waarvan het GHL-event
  // nog in ACTIEVE staat te zien is, komen in aanmerking. 'verwijderd'
  // valt bewust buiten scope — dat is een expliciete UI-actie.
  //
  // Gate rondom deze berekening: mag NOOIT de rest van het rapport
  // sabelen. Alle guard-clauses zijn defensief (null/empty/onbekende
  // status → skip); een onverwachte exception belandt in herstelError
  // en de shell blijft renderen.
  let herstelCandidates = [];
  let sqlPreview = '';
  let sqlRestore = '';
  let herstelError = null;
  try {
    const HIDDEN_RESTORABLE = new Set(['cancelled', 'no_show', 'wacht_op_reschedule']);
    const GHL_TO_TARGET = { confirmed: 'scheduled', booked: 'scheduled', scheduled: 'scheduled', showed: 'completed' };
    for (const b of (catB || [])) {
      if (!b || !b.db_status) continue;
      if (!HIDDEN_RESTORABLE.has(b.db_status)) continue;
      if (!b.still_in_ghl) continue;
      const ghlId = b.ghl_id ? String(b.ghl_id).trim() : '';
      if (!ghlId) continue;                              // geen GHL-koppeling → skip
      const ghlStatus = String(b.ghl_status_now || '').toLowerCase().trim();
      if (!ghlStatus) continue;                          // lege status → skip
      const target = GHL_TO_TARGET[ghlStatus];
      if (!target) continue;                             // onbekende GHL-status → skip
      if (target === b.db_status) continue;              // niks te wijzigen
      herstelCandidates.push({
        db_id: b.db_id,
        lead_name: b.name,
        scheduled_at: b.db_start,
        current_status: b.db_status,
        target_status: target,
        ghl_appointment_id: ghlId,
        ghl_status_now: ghlStatus,
      });
    }

    // SQL-safe string escape: single-quote doubling. GHL-ids zijn in de
    // praktijk alfanumeriek maar we escapen defensief zodat een rare id
    // nooit uit een string kan breken.
    const sq = (s) => `'${String(s).replace(/'/g, "''")}'`;

    if (herstelCandidates.length === 0) {
      sqlPreview = '-- 0 kandidaten — niks te herstellen op basis van huidige GHL-status.\n';
      sqlRestore = '-- 0 kandidaten — geen UPDATE nodig.\n';
    } else {
      sqlPreview =
`-- BLOK 1 — PREVIEW (SELECT, verandert niks).
-- Toont exact welke DB-rijen naar welke doelstatus zouden gaan.
SELECT
  a.id,
  a.lead_name,
  a.scheduled_at,
  a.status AS huidige_status,
  v.doelstatus,
  a.ghl_appointment_id
FROM public.follow_up_appointments AS a
JOIN (VALUES
${herstelCandidates.map(r => `  (${sq(r.ghl_appointment_id)}::text, ${sq(r.target_status)}::text)`).join(',\n')}
) AS v(ghl_appointment_id, doelstatus)
  ON a.ghl_appointment_id = v.ghl_appointment_id
WHERE a.status IN ('cancelled','no_show','wacht_op_reschedule')
ORDER BY a.scheduled_at;
`;

      sqlRestore =
`-- BLOK 2 — RESTORE (UPDATE, pas draaien NA akkoord op preview).
-- Zelfde CASE-doelstatus per ghl_appointment_id. WHERE ook op status
-- IN (verborgen) zodat een rij die inmiddels alweer 'scheduled' staat
-- niet opnieuw geraakt wordt (idempotent, race-veilig).
BEGIN;

UPDATE public.follow_up_appointments AS a
   SET status     = v.doelstatus,
       updated_at = now()
  FROM (VALUES
${herstelCandidates.map(r => `    (${sq(r.ghl_appointment_id)}::text, ${sq(r.target_status)}::text)`).join(',\n')}
  ) AS v(ghl_appointment_id, doelstatus)
 WHERE a.ghl_appointment_id = v.ghl_appointment_id
   AND a.status IN ('cancelled','no_show','wacht_op_reschedule')
RETURNING a.id, a.lead_name, a.scheduled_at, a.status;

-- Verifieer aantal RETURNED matches met het preview-aantal.
-- Klopt: COMMIT;   Wijkt af: ROLLBACK;
-- COMMIT;
-- ROLLBACK;
`;
    }
  } catch (e) {
    // Faalt de herstel-SQL-berekening? Nooit het hele rapport crashen.
    // Log server-side + zet de error in de response zodat de UI 't toont.
    console.error('[admin-recon-appointments] herstel-SQL berekening faalde:', e?.stack || e);
    herstelError = e?.message || String(e);
    herstelCandidates = [];
    sqlPreview = `-- Kon herstel-SQL niet berekenen: ${herstelError}\n`;
    sqlRestore = `-- Kon herstel-SQL niet berekenen: ${herstelError}\n`;
  }

  // Status-verdeling DB
  const statusCount = {};
  for (const r of (dbRows || [])) statusCount[r.status] = (statusCount[r.status] || 0) + 1;

  return {
    window: { start: START_ISO, end: END_ISO },
    generated_at: new Date().toISOString(),
    calendars: {
      total: cals.length,
      polled: cals.filter(pollIterates).length,
      not_polled: cals.filter(c => !pollIterates(c)).length,
      list: cals.map(c => ({
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        polled: pollIterates(c),
        fetch_status: perCal.get(c.id)?.status ?? null,
        events_sep_2026: perCal.get(c.id)?.ok ? perCal.get(c.id).events.length : 0,
        fetch_error: perCal.get(c.id)?.ok ? null : (perCal.get(c.id)?.body || null),
      })),
    },
    totals: {
      ghl_events_sep: allEvents.length,
      db_rows_sep:    (dbRows || []).length,
      cat_a_ghl_not_in_db:    catA.length,
      cat_b_db_hidden_status: catB.length,
      cat_c_scheduled_at_diff: catC.length,
      cat_d_not_polled_with_events: catD.length,
    },
    db_status_breakdown: statusCount,
    cat_a: catA,
    cat_b: catB,
    cat_c: catC,
    cat_d: catD,
    herstel: {
      count: herstelCandidates.length,
      candidates: herstelCandidates,
      sql_preview: sqlPreview,
      sql_restore: sqlRestore,
      error: herstelError,
    },
  };
}

// ── HTML shell — laadt shared-auth, fetcht ?data=1 met Bearer, rendert ─────
function htmlShell() {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reconciliatie GHL vs CRM — sep 2026</title>
<script src="/modules/shared/supabase-client.js"></script>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 32px; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color: #1a2333; background: #f7f9fb; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 8px; }
  .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .warn { color: #b45309; }
  .kpi { display: inline-block; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 18px; margin: 0 12px 12px 0; min-width: 140px; }
  .kpi .label { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .kpi .val { font-size: 22px; font-weight: 700; color: #093d54; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; font-size: 12.5px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; color: #374151; }
  tr:last-child td { border-bottom: none; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
  .banner { padding: 10px 14px; background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; color: #92400e; margin-bottom: 16px; }
  .empty { color: #9ca3af; font-style: italic; padding: 12px; }
  .flag-yes { color: #059669; font-weight: 600; }
  .flag-no  { color: #b91c1c; font-weight: 600; }
  .err { padding: 16px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; color: #7f1d1d; }
  .loading { padding: 40px; text-align: center; color: #6b7280; }
  .sql-box { position: relative; background: #0f172a; color: #e2e8f0; border-radius: 8px; padding: 14px 16px 14px 16px; font: 12px/1.5 "SF Mono","Menlo","Consolas",monospace; white-space: pre; overflow-x: auto; margin: 8px 0 20px; }
  .sql-box .copy { position: absolute; top: 8px; right: 8px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; border-radius: 4px; padding: 4px 10px; font: 11px/1.2 -apple-system,sans-serif; cursor: pointer; }
  .sql-box .copy:hover { background: #334155; color: #f1f5f9; }
  .hint { color: #6b7280; font-size: 12px; margin: 4px 0 10px; }
</style>
</head>
<body>
  <div class="banner">
    <strong>Tijdelijk diagnose-endpoint.</strong> Read-only, geen writes.
    Verwijder dit endpoint zodra het rapport gelezen is.
  </div>
  <h1>Reconciliatie GHL vs CRM — september 2026</h1>
  <div class="sub" id="sub">Gegevens worden opgehaald…</div>
  <div id="content"><div class="loading">Even wachten — GHL + DB worden geraadpleegd (kan 10–30s duren).</div></div>

<script>
(async () => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); if (isNaN(d)) return esc(iso); return d.toISOString().slice(0,16).replace('T',' '); };
  const shortId = (id) => id ? '…' + String(id).slice(-8) : '—';

  await window._authSharedReady;
  if (!window.AuthShared) { document.getElementById('content').innerHTML = '<div class="err">Niet ingelogd (auth-shared ontbreekt).</div>'; return; }
  const token = await window.AuthShared.getAccessToken();
  if (!token) { document.getElementById('content').innerHTML = '<div class="err">Geen sessie — log eerst in.</div>'; return; }

  let data;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 60_000);
  try {
    const res = await fetch('/api/admin-recon-appointments?data=1', {
      headers: { Authorization: 'Bearer ' + token },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      document.getElementById('content').innerHTML =
        '<div class="err"><strong>HTTP ' + res.status + '</strong> — ' + esc(res.statusText || '') + '<br><br>' +
        '<pre style="white-space:pre-wrap;margin:0;font-size:12px;">' + esc(txt.slice(0, 500)) + '</pre></div>';
      return;
    }
    data = await res.json();
  } catch (e) {
    clearTimeout(timer);
    const msg = e?.name === 'AbortError'
      ? 'Fetch afgebroken na 60s — endpoint heeft niet binnen de timeout gereageerd. Check Vercel logs voor stacktrace.'
      : 'Fetch mislukt: ' + (e?.message || String(e));
    document.getElementById('content').innerHTML = '<div class="err">' + esc(msg) + '</div>';
    return;
  }

  document.getElementById('sub').textContent =
    'Window: ' + data.window.start + ' → ' + data.window.end + ' · gegenereerd ' + data.generated_at;

  const t = data.totals;
  const kpis =
    '<div class="kpi"><div class="label">GHL events</div><div class="val">' + t.ghl_events_sep + '</div></div>' +
    '<div class="kpi"><div class="label">DB rijen</div><div class="val">' + t.db_rows_sep + '</div></div>' +
    '<div class="kpi"><div class="label">A: GHL, niet in DB</div><div class="val warn">' + t.cat_a_ghl_not_in_db + '</div></div>' +
    '<div class="kpi"><div class="label">B: DB verborgen status</div><div class="val warn">' + t.cat_b_db_hidden_status + '</div></div>' +
    '<div class="kpi"><div class="label">C: datum verschilt</div><div class="val warn">' + t.cat_c_scheduled_at_diff + '</div></div>' +
    '<div class="kpi"><div class="label">D: kalender niet gepolld</div><div class="val warn">' + t.cat_d_not_polled_with_events + '</div></div>';

  const dbStatusRow = Object.entries(data.db_status_breakdown || {})
    .map(([k, v]) => '<code>' + esc(k) + '</code>: ' + v).join(' · ') || '—';

  // Kalender-tabel
  const calRows = data.calendars.list.map(c =>
    '<tr>' +
      '<td>' + esc(c.name || '—') + '</td>' +
      '<td><code>' + esc(c.id) + '</code></td>' +
      '<td>' + (c.isActive === false ? '<span class="flag-no">false</span>' : '<span class="flag-yes">' + (c.isActive === true ? 'true' : String(c.isActive)) + '</span>') + '</td>' +
      '<td>' + (c.polled ? '<span class="flag-yes">ja</span>' : '<span class="flag-no">NEE</span>') + '</td>' +
      '<td>' + (c.fetch_status ?? '—') + '</td>' +
      '<td>' + c.events_sep_2026 + '</td>' +
      '<td>' + esc(c.fetch_error || '') + '</td>' +
    '</tr>'
  ).join('');

  // Cat-A: eerste 20
  const capped = (arr, n) => arr.slice(0, n);
  const catA_rows = capped(data.cat_a, 20).map(r =>
    '<tr>' +
      '<td>' + esc(r.name || '—') + '</td>' +
      '<td>' + fmt(r.ghl_start) + '</td>' +
      '<td>' + esc(r.calendar_name || '—') + ' <code>' + shortId(r.calendar_id) + '</code></td>' +
      '<td>' + (r.polled ? 'ja' : '<span class="flag-no">NEE</span>') + '</td>' +
      '<td>' + esc(r.ghl_status || '—') + '</td>' +
      '<td>' + esc(r.email || '—') + '</td>' +
      '<td><code>' + shortId(r.ghl_id) + '</code></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="7" class="empty">geen</td></tr>';

  const catB_rows = capped(data.cat_b, 20).map(r =>
    '<tr>' +
      '<td>' + esc(r.name || '—') + '</td>' +
      '<td>' + fmt(r.db_start) + '</td>' +
      '<td><code>' + esc(r.db_status) + '</code></td>' +
      '<td>' + (r.still_in_ghl === true ? '<span class="flag-yes">ja</span>' : r.still_in_ghl === false ? '<span class="flag-no">nee</span>' : '—') + '</td>' +
      '<td>' + esc(r.ghl_status_now || '—') + '</td>' +
      '<td><code>' + shortId(r.calendar_id) + '</code></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="6" class="empty">geen</td></tr>';

  const catC_rows = capped(data.cat_c, 20).map(r =>
    '<tr>' +
      '<td>' + esc(r.name || '—') + '</td>' +
      '<td>' + fmt(r.ghl_start) + '</td>' +
      '<td>' + fmt(r.db_start) + '</td>' +
      '<td>' + r.diff_min + '</td>' +
      '<td><code>' + esc(r.db_status) + '</code></td>' +
      '<td><code>' + shortId(r.calendar_id) + '</code></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="6" class="empty">geen</td></tr>';

  const catD_rows = capped(data.cat_d, 20).map(r =>
    '<tr>' +
      '<td>' + esc(r.calendar_name || '—') + '</td>' +
      '<td><code>' + esc(r.calendar_id) + '</code></td>' +
      '<td>' + (r.isActive === false ? '<span class="flag-no">false</span>' : String(r.isActive)) + '</td>' +
      '<td>' + r.ghl_events_sep + '</td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="4" class="empty">geen</td></tr>';

  const html =
    '<div>' + kpis + '</div>' +
    '<h2>DB-status-verdeling (sep 2026)</h2>' +
    '<div>' + dbStatusRow + '</div>' +
    '<h2>Kalender-inventaris (totaal ' + data.calendars.total + ', gepolld ' + data.calendars.polled + ', niet ' + data.calendars.not_polled + ')</h2>' +
    '<table><thead><tr><th>naam</th><th>id</th><th>isActive</th><th>gepolld</th><th>HTTP</th><th>events</th><th>fout</th></tr></thead><tbody>' + calRows + '</tbody></table>' +
    '<h2>A — In GHL (niet cancelled), NIET in DB · ' + t.cat_a_ghl_not_in_db + ' totaal, eerste 20 hieronder</h2>' +
    '<table><thead><tr><th>naam</th><th>GHL start</th><th>kalender</th><th>gepolld</th><th>GHL status</th><th>email</th><th>ghl_id</th></tr></thead><tbody>' + catA_rows + '</tbody></table>' +
    '<h2>B — In DB met verborgen status · ' + t.cat_b_db_hidden_status + ' totaal, eerste 20</h2>' +
    '<table><thead><tr><th>naam</th><th>DB start</th><th>DB status</th><th>nog in GHL?</th><th>GHL status nu</th><th>kalender</th></tr></thead><tbody>' + catB_rows + '</tbody></table>' +
    '<h2>C — In beide, scheduled_at verschilt >1 min · ' + t.cat_c_scheduled_at_diff + ' totaal, eerste 20</h2>' +
    '<table><thead><tr><th>naam</th><th>GHL start</th><th>DB start</th><th>Δ min</th><th>DB status</th><th>kalender</th></tr></thead><tbody>' + catC_rows + '</tbody></table>' +
    '<h2>D — Kalenders met events maar NIET gepolld · ' + t.cat_d_not_polled_with_events + ' totaal, eerste 20</h2>' +
    '<table><thead><tr><th>naam</th><th>id</th><th>isActive</th><th>events sep</th></tr></thead><tbody>' + catD_rows + '</tbody></table>';

  // ── Herstel-SQL sectie ────────────────────────────────────────────────
  const herstel = data.herstel || { count: 0, candidates: [], sql_preview: '', sql_restore: '' };
  const herstelRows = capped(herstel.candidates || [], 20).map(r =>
    '<tr>' +
      '<td>' + esc(r.lead_name || '—') + '</td>' +
      '<td>' + fmt(r.scheduled_at) + '</td>' +
      '<td><code>' + esc(r.current_status) + '</code></td>' +
      '<td>→ <code>' + esc(r.target_status) + '</code></td>' +
      '<td><code>' + esc(r.ghl_status_now) + '</code></td>' +
      '<td><code>' + shortId(r.ghl_appointment_id) + '</code></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="6" class="empty">geen</td></tr>';

  const herstelErrorHtml = herstel.error
    ? '<div class="err" style="margin:8px 0 16px;"><strong>Herstel-SQL-berekening faalde:</strong> ' + esc(herstel.error) + ' — rest van het rapport hierboven is wel volledig.</div>'
    : '';
  const herstelHtml =
    '<h2>Herstel-SQL — verborgen in CRM maar actief in GHL · ' + herstel.count + ' kandidaten</h2>' +
    herstelErrorHtml +
    '<div class="hint">Regels die momenteel in <code>cancelled</code> / <code>no_show</code> / <code>wacht_op_reschedule</code> staan, terwijl het GHL-event nog een actieve status heeft (<code>confirmed</code> / <code>booked</code> / <code>scheduled</code> / <code>showed</code>). Doelstatus is bepaald via dezelfde <code>mapGhlStatus()</code> die de poll gebruikt.</div>' +
    '<table><thead><tr><th>naam</th><th>DB start</th><th>huidige status</th><th>doelstatus</th><th>GHL status nu</th><th>ghl_id</th></tr></thead><tbody>' + herstelRows + '</tbody></table>' +
    '<h2>BLOK 1 — PREVIEW (SELECT)</h2>' +
    '<div class="hint">Read-only. Draai dit in de Supabase SQL-editor om exact te zien welke rijen naar welke doelstatus zouden gaan.</div>' +
    '<div class="sql-box"><button class="copy" data-target="sql-preview">Kopieer</button><span id="sql-preview">' + esc(herstel.sql_preview || '') + '</span></div>' +
    '<h2>BLOK 2 — RESTORE (UPDATE, pas draaien NA akkoord op preview)</h2>' +
    '<div class="hint">Zit in <code>BEGIN;</code> — <code>COMMIT;</code> pas als het RETURNING-aantal klopt met preview, anders <code>ROLLBACK;</code>. Zelfde WHERE-guard (status in verborgen set) maakt \'t idempotent.</div>' +
    '<div class="sql-box"><button class="copy" data-target="sql-restore">Kopieer</button><span id="sql-restore">' + esc(herstel.sql_restore || '') + '</span></div>';

  document.getElementById('content').innerHTML = html + herstelHtml;

  // Kopieer-knop delegatie
  document.querySelectorAll('.sql-box .copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tgt = document.getElementById(btn.getAttribute('data-target'));
      if (!tgt) return;
      try {
        await navigator.clipboard.writeText(tgt.textContent);
        const orig = btn.textContent; btn.textContent = 'Gekopieerd ✓';
        setTimeout(() => { btn.textContent = orig; }, 1400);
      } catch (e) {
        btn.textContent = 'Kopieer mislukt';
      }
    });
  });
})();
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const wantsData = String(req.query?.data || '') === '1';

  // HTML-shell — geen auth-check hier: de shell zelf laadt shared-auth
  // en fetcht daarna /?data=1 mét Bearer. Zonder Bearer valt de data-call
  // om op 403; de shell rendert dan een foutmelding.
  if (!wantsData) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(htmlShell());
  }

  // Data-pad: admin-only.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  if (!process.env.GHL_LOCATION_ID || (!process.env.GHL_API_KEY && !process.env.GHL_PIT_TOKEN)) {
    return res.status(500).json({ error: 'GHL env vars ontbreken (GHL_LOCATION_ID + GHL_API_KEY of GHL_PIT_TOKEN).' });
  }

  try {
    const report = await buildReport();
    return res.status(200).json(report);
  } catch (e) {
    // Log FULL stacktrace zodat Vercel-logs de root-cause tonen. De
    // frontend krijgt alleen de message + naam terug (geen stack, geen
    // interne paden — die zijn intern eigendom van de server-logs).
    console.error('[admin-recon-appointments] buildReport crash — stack:\n', e?.stack || String(e));
    console.error('[admin-recon-appointments] error name:', e?.name, 'message:', e?.message);
    return res.status(500).json({
      error: e?.message || String(e),
      name:  e?.name  || 'Error',
    });
  }
}
