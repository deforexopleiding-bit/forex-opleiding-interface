// api/cron-event-belronde.js
//
// Event-belronde dagelijks: maak follow_up_leads (source='event') voor
// alle attendees van events die over EXACT 2 dagen plaatsvinden en die
// nog NIET zijn gebeld (called != true). Elke lead krijgt lead_status
// 'terugbellen' + terugbel_datum die dag om 12:00 (Europe/Amsterdam),
// zodat 'ie automatisch op de Werklijst verschijnt.
//
// Auth: Authorization: Bearer $CRON_SECRET (zelfde patroon als de
// andere crons). Vercel-schedule wordt in vercel.json toegevoegd.
//
// Idempotent: bestaande event-leads (source_ref.attendee_id) worden
// overgeslagen. Een 23505 (unique-index op customer_id+source) valt
// terug op 'skip'. Schrijft alleen naar follow_up_leads.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

// Europe/Amsterdam is UTC+1 in winter, +2 in zomer. We willen om 12:00
// LOKALE tijd de eerste poging. Voor betrouwbaarheid berekenen we via
// Intl om DST correct te handelen: formuleer een string en converteer.
function amsterdamTargetIso(dateYYYYMMDD, hhmm) {
  // "2026-07-06" + "12:00" → een echte JavaScript Date die 12:00 in
  // Amsterdam voorstelt. We probleren de zone-offset te vinden door
  // een probing-datum in beide TZ's om te rekenen.
  const [y, m, d] = dateYYYYMMDD.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  // Neem een UTC-datum met dezelfde componenten en shift daarna naar
  // Amsterdam-offset.
  const utcDate = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  const amsOffsetMinutes = getAmsterdamOffsetMinutes(utcDate);
  return new Date(utcDate.getTime() - amsOffsetMinutes * 60 * 1000).toISOString();
}

function getAmsterdamOffsetMinutes(refDate) {
  // Gebruik Intl om de offset van Europe/Amsterdam op refDate te vinden.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Amsterdam',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(refDate);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    Number(map.hour), Number(map.minute), Number(map.second),
  );
  return Math.round((asUTC - refDate.getTime()) / 60000);
}

function displayName(a) {
  const parts = [a?.first_name, a?.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const joined = parts.join(' ').trim();
  return joined || a?.email || '(onbekend)';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authOk = checkCronAuth(req);
  if (!authOk) return res.status(401).json({ error: 'CRON_SECRET ongeldig' });

  const summary = { events: 0, attendees_seen: 0, leads_created: 0, skipped: 0, errors: [] };

  try {
    // 1) Bepaal target-datum in Amsterdam: 2 dagen vooraf → in NL.
    const now = new Date();
    const amsOffset = getAmsterdamOffsetMinutes(now);
    // 'nu in Amsterdam' als datum-object:
    const amsNow = new Date(now.getTime() + amsOffset * 60 * 1000);
    // +2 dagen (op amsdam-tijd), 00:00 tot 23:59:59:
    const y = amsNow.getUTCFullYear();
    const m = amsNow.getUTCMonth();
    const d = amsNow.getUTCDate() + 2;
    const targetDate = new Date(Date.UTC(y, m, d));
    const yyyy = targetDate.getUTCFullYear();
    const mm   = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
    const dd   = String(targetDate.getUTCDate()).padStart(2, '0');
    const targetDateStr = `${yyyy}-${mm}-${dd}`;

    // Range voor query: dag start..dag eind in UTC met een marge.
    const dayStartIso = amsterdamTargetIso(targetDateStr, '00:00');
    const dayEndIso   = amsterdamTargetIso(targetDateStr, '23:59');
    const noonIso     = amsterdamTargetIso(targetDateStr, '12:00');

    // 2) Events op targetDateStr (status published/draft).
    const { data: events, error: eErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, status')
      .in('status', ['published', 'draft'])
      .gte('starts_at', dayStartIso)
      .lte('starts_at', dayEndIso);
    if (eErr) throw new Error('events fetch: ' + eErr.message);
    summary.events = (events || []).length;
    if (!events?.length) {
      return res.status(200).json({ ok: true, target_date: targetDateStr, ...summary });
    }

    for (const ev of events) {
      const evId = ev.id;
      // 3) Attendees + hun 'called' status.
      const { data: attendees, error: aErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id, event_id, customer_id, first_name, last_name, email, phone, called')
        .eq('event_id', evId);
      if (aErr) { summary.errors.push({ event_id: evId, error: 'attendees: ' + aErr.message }); continue; }
      const attList = (attendees || []).filter((a) => a.called !== true);
      summary.attendees_seen += attList.length;
      if (!attList.length) continue;

      // 4) Bestaande event-leads voor dit event (voor idempotency).
      const { data: existing } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, source_ref, lead_status')
        .eq('source', 'event')
        .filter('source_ref->>event_id', 'eq', evId);
      const existingByAtt = new Set(
        (existing || [])
          .filter((l) => l.lead_status !== 'verlengd' && l.lead_status !== 'verloren')
          .map((l) => l?.source_ref?.attendee_id).filter(Boolean)
      );

      for (const a of attList) {
        if (existingByAtt.has(a.id)) { summary.skipped++; continue; }
        const insertRow = {
          customer_id       : a.customer_id || null,
          source            : 'event',
          lead_name         : displayName(a),
          lead_email        : a.email || null,
          lead_phone        : a.phone || null,
          lead_status       : 'terugbellen',
          terugbel_datum    : noonIso,
          source_ref        : {
            event_id    : evId,
            attendee_id : a.id,
            event_title : ev.title || null,
            event_date  : ev.starts_at || null,
            reason      : 'auto_belronde_2d',
          },
          created_by_user_id: null,
        };
        const { error: iErr } = await supabaseAdmin
          .from('follow_up_leads')
          .insert(insertRow)
          .select('id')
          .maybeSingle();
        if (!iErr) {
          summary.leads_created++;
          continue;
        }
        if (iErr.code === '23505') {
          // Unique-conflict op (customer_id, source) — bestaande lead
          // hergebruiken; niet als nieuwe tellen.
          summary.skipped++;
          continue;
        }
        if (iErr.code === '42P01') {
          return res.status(501).json({ error: 'follow_up_leads ontbreekt', code: 'MIGRATION_REQUIRED' });
        }
        summary.errors.push({ attendee_id: a.id, error: iErr.message });
      }
    }

    return res.status(200).json({ ok: true, target_date: targetDateStr, ...summary });
  } catch (e) {
    console.error('[cron-event-belronde]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout', partial: summary });
  }
}
