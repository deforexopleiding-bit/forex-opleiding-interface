// api/admin-recon-persons.js
//
// TIJDELIJK diagnose-endpoint — read-only vergelijking GHL vs DB voor
// een gefocuste lijst personen. 0 writes, 0 mutaties. Verwijderen zodra
// de collateral-analyse klaar is (samen met admin-recon-appointments).
//
// GET /api/admin-recon-persons
//   → HTML-shell die na login-JWT-check /api/admin-recon-persons?data=1
//     aanroept en de vergelijking per persoon toont.
// GET /api/admin-recon-persons?data=1[&names=Naam Een,Naam Twee]
//   → JSON. Zonder ?names= vallen we terug op de hardcoded DEFAULTS.
//
// Auth: verifyAdmin (super_admin / admin).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { listCalendars } from './_lib/ghl-calendars.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';

// Wide window om iedere plausibele afspraak te dekken.
const START_ISO = '2026-06-01T00:00:00.000Z';
const END_ISO   = '2027-01-01T00:00:00.000Z';

const DEFAULT_NAMES = [
  'Corne Heeren',
  'Martin Van Pijkeren',
  'Redouane Jerroudi',
  'Gauthier Dhooge',
];

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameMatches(candidate, query) {
  const c = normalize(candidate);
  const q = normalize(query);
  if (!c || !q) return false;
  if (c === q || c.includes(q) || q.includes(c)) return true;
  // Alle woorden van query moeten in candidate voorkomen (voor Van/Van der etc)
  const qWords = q.split(' ').filter(Boolean);
  if (qWords.length >= 2 && qWords.every(w => c.includes(w))) return true;
  return false;
}

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
      return { ok: false, status: r.status, body: (await r.text().catch(() => '')).slice(0, 300), events: [] };
    }
    const j = await r.json();
    const evs = j.events || j.data || [];
    return { ok: true, status: 200, events: evs.map(e => ({
      id: e.id,
      calendarId: e.calendarId || calId,
      startTime: e.startTime || e.start_time || e.start || null,
      endTime:   e.endTime   || e.end_time   || e.end   || null,
      title:     e.title     || e.name       || null,
      appointmentStatus: e.appointmentStatus || null,
      contactId:   e.contactId || null,
      contactName: e.contactName || e.contact?.name || null,
      email:       e.email || e.contact?.email || null,
      phone:       e.phone || e.contact?.phone || null,
    })) };
  } catch (e) {
    return { ok: false, status: 0, body: String(e?.message || e), events: [] };
  }
}

async function buildReport(names) {
  const cals = await listCalendars();
  const calById = new Map(cals.map(c => [c.id, c]));

  // Fetch alle events over alle kalenders (actief + inactief)
  const allEvents = [];
  let fetchErrors = 0;
  for (const c of cals) {
    const res = await fetchEventsForCalendar(c.id);
    if (!res.ok) { fetchErrors++; continue; }
    for (const e of res.events) allEvents.push(e);
  }

  // Per persoon filteren op GHL-events (name match op title of contactName)
  // en DB-rijen (name match op lead_name via ilike).
  const perPerson = [];
  for (const name of names) {
    const q = String(name || '').trim();
    if (!q) continue;

    // GHL-events voor deze naam
    const ghlHits = allEvents.filter(ev =>
      nameMatches(ev.contactName || '', q) ||
      nameMatches(ev.title || '', q)
    ).sort((a, b) => String(a.startTime || '').localeCompare(String(b.startTime || '')));

    // DB-rijen voor deze naam (ilike, %name%)
    const parts = q.split(/\s+/).filter(Boolean);
    // Combineer met AND: elke woord moet voorkomen. Zonder OR-alternatieven
    // omdat we anders alle "van"-rijen zouden krijgen.
    let dbQuery = supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, ghl_calendar_id, ghl_appointment_id, updated_at')
      .order('scheduled_at', { ascending: true });
    for (const p of parts) {
      dbQuery = dbQuery.ilike('lead_name', `%${p}%`);
    }
    const { data: dbRows, error: dbErr } = await dbQuery;
    if (dbErr) {
      perPerson.push({ name: q, error: dbErr.message });
      continue;
    }

    // Match GHL-events tegen DB-rijen op ghl_appointment_id om per-event
    // te tonen: "wel in DB (status X)" vs "niet in DB".
    const dbByGhlId = new Map((dbRows || []).filter(r => r.ghl_appointment_id).map(r => [r.ghl_appointment_id, r]));
    const ghlWithDb = ghlHits.map(ev => {
      const dbRow = dbByGhlId.get(ev.id);
      const cal = calById.get(ev.calendarId);
      return {
        ghl_id: ev.id,
        calendar_id: ev.calendarId,
        calendar_name: cal?.name || null,
        calendar_isActive: cal?.isActive ?? null,
        contactName: ev.contactName,
        title: ev.title,
        email: ev.email,
        phone: ev.phone,
        startTime: ev.startTime,
        appointmentStatus: ev.appointmentStatus,
        in_db: !!dbRow,
        db_row: dbRow ? {
          id: dbRow.id,
          status: dbRow.status,
          scheduled_at: dbRow.scheduled_at,
          updated_at: dbRow.updated_at,
        } : null,
      };
    });

    // DB-rijen zonder matching GHL-event (bv. ghl_appointment_id=null of
    // event valt buiten window)
    const ghlIds = new Set(ghlHits.map(e => e.id));
    const dbOrphans = (dbRows || []).filter(r => !r.ghl_appointment_id || !ghlIds.has(r.ghl_appointment_id))
      .map(r => ({
        id: r.id,
        lead_name: r.lead_name,
        status: r.status,
        scheduled_at: r.scheduled_at,
        updated_at: r.updated_at,
        ghl_appointment_id: r.ghl_appointment_id,
        ghl_calendar_id: r.ghl_calendar_id,
      }));

    perPerson.push({
      name: q,
      totals: {
        ghl_events: ghlHits.length,
        db_rows:    (dbRows || []).length,
        in_both:    ghlWithDb.filter(g => g.in_db).length,
        ghl_only:   ghlWithDb.filter(g => !g.in_db).length,
        db_only:    dbOrphans.length,
      },
      ghl_events: ghlWithDb,
      db_only:    dbOrphans,
    });
  }

  return {
    window: { start: START_ISO, end: END_ISO },
    generated_at: new Date().toISOString(),
    calendars: { total: cals.length, fetch_errors: fetchErrors },
    persons: perPerson,
  };
}

function htmlShell(namesParam) {
  const paramSuffix = namesParam ? `&names=${encodeURIComponent(namesParam)}` : '';
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recon per persoon — GHL vs CRM</title>
<script src="/modules/shared/supabase-client.js"></script>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 32px; font: 14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color: #1a2333; background: #f7f9fb; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 24px 0 6px; color: #093d54; }
  h3 { font-size: 13px; margin: 12px 0 4px; color: #4a5568; text-transform: uppercase; letter-spacing: .5px; }
  .sub { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
  .banner { padding: 10px 14px; background: #fef3c7; border: 1px solid #fbbf24; border-radius: 6px; color: #92400e; margin-bottom: 16px; }
  .err { padding: 16px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; color: #7f1d1d; white-space: pre-wrap; }
  .loading { padding: 40px; text-align: center; color: #6b7280; }
  .kpi-row { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 12px; }
  .kpi { background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px 14px; font-size: 12px; }
  .kpi b { display: block; font-size: 18px; color: #093d54; }
  .kpi.warn b { color: #b45309; }
  table { border-collapse: collapse; width: 100%; background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; font-size: 12.5px; margin-bottom: 12px; }
  th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; color: #374151; }
  tr:last-child td { border-bottom: none; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 11.5px; }
  .empty { color: #9ca3af; font-style: italic; padding: 12px; }
  .flag-yes { color: #059669; font-weight: 600; }
  .flag-no  { color: #b91c1c; font-weight: 600; }
</style>
</head>
<body>
  <div class="banner">
    <strong>TIJDELIJK diagnose-endpoint.</strong> Read-only, geen writes.
    Verwijder samen met /api/admin-recon-appointments zodra de collateral-analyse klaar is.
  </div>
  <h1>Recon per persoon — GHL vs CRM</h1>
  <div class="sub" id="sub">Gegevens worden opgehaald…</div>
  <div id="content"><div class="loading">Even wachten — GHL + DB worden geraadpleegd (kan 15–45s duren).</div></div>

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
    const res = await fetch('/api/admin-recon-persons?data=1${paramSuffix}', {
      headers: { Authorization: 'Bearer ' + token },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const txt = await res.text().catch(()=>'');
      document.getElementById('content').innerHTML = '<div class="err">HTTP ' + res.status + '\\n\\n' + esc(txt.slice(0, 500)) + '</div>';
      return;
    }
    data = await res.json();
  } catch (e) {
    clearTimeout(timer);
    document.getElementById('content').innerHTML = '<div class="err">Fetch mislukt: ' + esc(e?.message || String(e)) + '</div>';
    return;
  }

  document.getElementById('sub').textContent =
    'Window: ' + data.window.start + ' → ' + data.window.end +
    ' · kalenders: ' + data.calendars.total + (data.calendars.fetch_errors ? ' (' + data.calendars.fetch_errors + ' fetch errors)' : '') +
    ' · gegenereerd ' + data.generated_at;

  const chunks = [];
  for (const p of (data.persons || [])) {
    chunks.push('<h2>' + esc(p.name) + '</h2>');
    if (p.error) {
      chunks.push('<div class="err">' + esc(p.error) + '</div>');
      continue;
    }
    chunks.push(
      '<div class="kpi-row">' +
      '<div class="kpi">GHL events <b>' + p.totals.ghl_events + '</b></div>' +
      '<div class="kpi">DB rijen <b>' + p.totals.db_rows + '</b></div>' +
      '<div class="kpi">Beide <b>' + p.totals.in_both + '</b></div>' +
      '<div class="kpi warn">Alleen GHL <b>' + p.totals.ghl_only + '</b></div>' +
      '<div class="kpi warn">Alleen DB <b>' + p.totals.db_only + '</b></div>' +
      '</div>'
    );

    chunks.push('<h3>GHL-events</h3>');
    if ((p.ghl_events || []).length === 0) {
      chunks.push('<div class="empty">geen</div>');
    } else {
      const rows = p.ghl_events.map(g =>
        '<tr>' +
          '<td>' + fmt(g.startTime) + '</td>' +
          '<td>' + esc(g.contactName || g.title || '') + '</td>' +
          '<td>' + esc(g.appointmentStatus || '—') + '</td>' +
          '<td>' + esc(g.calendar_name || '—') + ' <code>' + shortId(g.calendar_id) + '</code></td>' +
          '<td><code>' + shortId(g.ghl_id) + '</code></td>' +
          '<td>' + (g.in_db ? '<span class="flag-yes">ja</span>' : '<span class="flag-no">NEE</span>') + '</td>' +
          '<td>' + (g.in_db ? '<code>' + esc(g.db_row.status) + '</code>' : '—') + '</td>' +
          '<td>' + (g.in_db ? fmt(g.db_row.scheduled_at) : '—') + '</td>' +
        '</tr>'
      ).join('');
      chunks.push('<table><thead><tr><th>GHL start</th><th>naam</th><th>GHL status</th><th>kalender</th><th>ghl_id</th><th>in DB?</th><th>DB status</th><th>DB start</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }

    chunks.push('<h3>DB-rijen zonder matchend GHL-event (in dit window)</h3>');
    if ((p.db_only || []).length === 0) {
      chunks.push('<div class="empty">geen</div>');
    } else {
      const rows = p.db_only.map(r =>
        '<tr>' +
          '<td>' + fmt(r.scheduled_at) + '</td>' +
          '<td>' + esc(r.lead_name || '') + '</td>' +
          '<td><code>' + esc(r.status) + '</code></td>' +
          '<td><code>' + shortId(r.ghl_calendar_id) + '</code></td>' +
          '<td><code>' + shortId(r.ghl_appointment_id) + '</code></td>' +
          '<td>' + fmt(r.updated_at) + '</td>' +
        '</tr>'
      ).join('');
      chunks.push('<table><thead><tr><th>DB start</th><th>naam</th><th>status</th><th>kalender</th><th>ghl_id</th><th>updated_at</th></tr></thead><tbody>' + rows + '</tbody></table>');
    }
  }

  document.getElementById('content').innerHTML = chunks.join('');
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
  const namesParam = String(req.query?.names || '').trim();

  if (!wantsData) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(htmlShell(namesParam));
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  if (!process.env.GHL_LOCATION_ID || (!process.env.GHL_API_KEY && !process.env.GHL_PIT_TOKEN)) {
    return res.status(500).json({ error: 'GHL env vars ontbreken (GHL_LOCATION_ID + GHL_API_KEY of GHL_PIT_TOKEN).' });
  }

  const names = namesParam
    ? namesParam.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_NAMES;

  try {
    const report = await buildReport(names);
    return res.status(200).json(report);
  } catch (e) {
    console.error('[admin-recon-persons] buildReport crash — stack:\n', e?.stack || String(e));
    return res.status(500).json({ error: e?.message || String(e), name: e?.name || 'Error' });
  }
}
