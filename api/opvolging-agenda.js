// api/opvolging-agenda.js
//
// Fase 2 DEEL B — de agenda achter "Opnieuw inplannen" in de opvolgmodule.
//
//   GET  /api/opvolging-agenda?van=YYYY-MM-DD&tot=YYYY-MM-DD
//        → { timezone, window, dagen:[{ dag, vrij:[{tijd}], bezet:[{tijd,naam,status}] }],
//            agenda_beschikbaar, melding }
//
//   POST /api/opvolging-agenda
//        { taak_id, start } → boekt en zet de taak op 'ingepland'.
//
// TWEE BRONNEN
//   · Vrij  — Dave's GHL-kalender (calendars/free-slots), dezelfde kalender en
//             dezelfde normalisatie als api/follow-up-ghl-free-slots.js.
//   · Bezet — onze eigen follow_up_appointments, gelezen met de user-client
//             zodat RLS blijft gelden.
// Samenvoegen gebeurt in api/_lib/opvolging-agenda-merge.js (pure functie,
// getest zonder netwerk).
//
// WAAROM DE GHL-CALL HIER OPNIEUW STAAT EN NIET VIA follow-up-ghl-free-slots
// Een HTTP-self-call vanuit een Vercel-functie naar een andere functie van
// dezelfde deployment is in deze repo een gedocumenteerd anti-pattern: dat
// faalde structureel op productie met `TypeError: fetch failed` (Deployment
// Protection / cold-start DNS-race) — zie de kop van api/_lib/joost-suggest-core.js.
// De helpers uit follow-up-ghl-free-slots.js exporteren zou dat bestand moeten
// wijzigen, en dat mag niet. Dus: dezelfde GET naar dezelfde kalender, met de
// tijdzone uit het GHL-antwoord, en verder niets nieuws richting GHL.
//
// BOEKEN GAAT NOOIT RECHTSTREEKS NAAR GHL
// De POST hergebruikt createAppointmentForLead() — hetzelfde pad als de
// cockpit-uitkomst 'zoom_ingepland'. Dat pad maakt de GHL-afspraak én de
// follow_up_appointments-rij, en laat GHL zelf de uitnodiging en de Zoom-link
// naar de lead sturen. Zelf naar GHL schrijven zou precies die twee berichten
// laten verdwijnen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createAppointmentForLead, mapGhlError } from './_lib/create-appointment-from-lead.js';
import { voegAgendaSamen, dagenTussen } from './_lib/opvolging-agenda-merge.js';
import fetch from 'node-fetch';

const GHL_BASE    = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';
const ZONE        = 'Europe/Amsterdam';
const DATUM_RE    = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAGEN   = 45;                 // zes weken vooruit plus wat lucht
const DUUR_MIN    = 30;

// ── Tijdrekenen in Amsterdam ───────────────────────────────────────────────
// Gelijk aan api/follow-up-ghl-free-slots.js: expliciete UTC-constructie plus
// de offset op díe datum, zodat de zomertijdgrens geen uur verschuift.
function zoneMiddernachtMs(datum) {
  const [y, m, d] = datum.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utc))) map[p.type] = p.value;
  const alsUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +map.hour, +map.minute, +map.second);
  return utc - Math.round((alsUtc - utc) / 60000) * 60000;
}

function vandaagInZone() {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(new Date());
}

// Zelfde vormen als GHL ze teruggeeft: plat array óf object keyed op datum.
function normaliseerSlots(raw, timeZone) {
  const perDag = new Map();
  const push = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return;
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const map = {};
    for (const p of dtf.formatToParts(new Date(t))) map[p.type] = p.value;
    const dag = `${map.year}-${map.month}-${map.day}`;
    if (!perDag.has(dag)) perDag.set(dag, new Set());
    perDag.get(dag).add(`${map.hour}:${map.minute}`);
  };
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.slots)) {
    for (const s of raw.slots) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }
  for (const [k, v] of Object.entries(raw)) {
    if (!DATUM_RE.test(k)) continue;
    const arr = Array.isArray(v?.slots) ? v.slots : (Array.isArray(v) ? v : []);
    for (const s of arr) push(typeof s === 'string' ? s : s?.startTime || s?.start || '');
  }
  const uit = [];
  for (const [date, set] of perDag) uit.push({ date, times: [...set].sort() });
  uit.sort((a, b) => a.date.localeCompare(b.date));
  return uit;
}

// Haalt de vrije slots op. Gooit niet: bij elke storing komt er
// { slots: [], melding } terug zodat de UI iets leesbaars kan tonen in plaats
// van een leeg scherm.
async function haalVrijeSlots(van, tot) {
  const calendarId = process.env.GHL_CALENDAR_ID;
  const token      = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!calendarId || !token) {
    console.warn('[opvolging-agenda] GHL env ontbreekt', { calendarId: !!calendarId, token: !!token });
    return { slots: [], timezone: ZONE, melding: 'De agenda is niet gekoppeld op de server. Kies hieronder zelf een dag.' };
  }
  const url = new URL(`${GHL_BASE}/calendars/${encodeURIComponent(calendarId)}/free-slots`);
  url.searchParams.set('startDate', String(zoneMiddernachtMs(van)));
  url.searchParams.set('endDate',   String(zoneMiddernachtMs(tot) + 24 * 3600 * 1000 - 1));
  url.searchParams.set('timezone',  ZONE);
  try {
    const res = await fetch(url.toString(), {
      method : 'GET',
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[opvolging-agenda] GHL free-slots', res.status, (body || '').slice(0, 200));
      return { slots: [], timezone: ZONE, melding: 'De agenda is even niet bereikbaar. Kies hieronder zelf een dag.' };
    }
    const raw = await res.json();
    // De tijdzone komt uit het antwoord; alleen als GHL 'm niet meestuurt
    // vallen we terug op de zone die we hebben gevraagd.
    const timezone = (typeof raw?.timezone === 'string' && raw.timezone.trim()) ? raw.timezone.trim() : ZONE;
    return { slots: normaliseerSlots(raw, timezone), timezone, melding: null };
  } catch (e) {
    console.warn('[opvolging-agenda] GHL fetch faalde:', e?.message || e);
    return { slots: [], timezone: ZONE, melding: 'De agenda is even niet bereikbaar. Kies hieronder zelf een dag.' };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  if (req.method === 'GET')  return await lees(req, res, supabase);
  if (req.method === 'POST') return await boek(req, res);
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'GET of POST' });
}

// ── GET: vrij + bezet per dag ──────────────────────────────────────────────
async function lees(req, res, supabase) {
  const q = req.query || {};
  const vandaag = vandaagInZone();
  const van = DATUM_RE.test(String(q.van || '')) ? String(q.van) : vandaag;
  let tot = DATUM_RE.test(String(q.tot || '')) ? String(q.tot) : null;
  if (!tot) tot = isoPlusDagen(van, 6);

  // Venster begrenzen: een spoof-caller mag geen half jaar aan GHL-verkeer
  // afdwingen, en de UI vraagt nooit meer dan een week tegelijk.
  const reeks = dagenTussen(van, tot);
  if (reeks.length === 0) return res.status(400).json({ error: 'van/tot ongeldig (verwacht YYYY-MM-DD, tot >= van)' });
  if (reeks.length > MAX_DAGEN) tot = reeks[MAX_DAGEN - 1];

  const { slots, timezone, melding } = await haalVrijeSlots(van, tot);

  // Bezet uit onze eigen tabel. Fail-soft: zonder deze lijst tonen we de vrije
  // slots nog steeds — dat is beter dan een leeg scherm, en het risico
  // (een slot dat GHL zelf al kent) is klein.
  let afspraken = [];
  let bezetMelding = null;
  try {
    const vanMs = zoneMiddernachtMs(van);
    const totMs = zoneMiddernachtMs(tot) + 24 * 3600 * 1000;
    const { data, error } = await supabase
      .from('follow_up_appointments')
      .select('id, lead_name, scheduled_at, status')
      .gte('scheduled_at', new Date(vanMs).toISOString())
      .lt('scheduled_at', new Date(totMs).toISOString())
      .order('scheduled_at', { ascending: true });
    if (error) throw error;
    afspraken = data || [];
  } catch (e) {
    console.warn('[opvolging-agenda] afspraken lezen faalde:', e?.message || e);
    bezetMelding = 'De geboekte afspraken konden niet geladen worden; vrije momenten kloppen mogelijk niet helemaal.';
  }

  const dagen = voegAgendaSamen({ slots, afspraken, van, tot, timeZone: timezone });
  const vrijTotaal = dagen.reduce((n, d) => n + d.vrij.length, 0);

  return res.status(200).json({
    timezone,
    window: { van, tot },
    dagen,
    agenda_beschikbaar: !melding,
    melding: melding || bezetMelding || (vrijTotaal === 0 ? 'Geen vrije momenten in deze week.' : null),
  });
}

function isoPlusDagen(datum, n) {
  const ms = Date.parse(`${datum}T12:00:00Z`) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// ── POST: boeken via het bestaande zoom_ingepland-pad ──────────────────────
async function boek(req, res) {
  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  const start = b.start ? new Date(b.start) : null;
  if (!start || isNaN(start.getTime())) return res.status(400).json({ error: 'start (ISO) ontbreekt of is ongeldig' });

  let taak;
  try {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken').select('*').eq('id', b.taak_id).maybeSingle();
    if (error) throw error;
    taak = data;
  } catch (e) {
    console.error('[opvolging-agenda] taak lezen:', e?.message || e);
    return res.status(500).json({ error: 'Taak kon niet gelezen worden' });
  }
  if (!taak) return res.status(404).json({ error: 'Taak niet gevonden' });

  const lead = await zoekLeadVoorTaak(taak);

  let afspraak;
  try {
    afspraak = await createAppointmentForLead({
      lead,
      scheduledAt    : start.toISOString(),
      durationMinutes: DUUR_MIN,
    });
  } catch (e) {
    // Dezelfde vertaling als de cockpit-uitkomst gebruikt, zodat de melding
    // in beide schermen hetzelfde leest.
    if (e?.code === 'NO_GHL_CONTACT') {
      return res.status(422).json({
        error: 'Geen e-mail of telefoon bekend — er is niets om het GHL-contact op te vinden. Vul de gegevens aan.',
        code : 'NO_GHL_CONTACT',
      });
    }
    if (e?.code === 'GHL_CONFIG_MISSING') {
      return res.status(500).json({ error: 'GHL is niet gekoppeld op de server (GHL_CALENDAR_ID / GHL_LOCATION_ID).' });
    }
    if (e?.code === 'GHL_API') {
      console.error('[opvolging-agenda] GHL:', e.ghlStatus, e.ghlBody);
      return res.status(422).json({ error: mapGhlError(e.ghlStatus, e.ghlBody), ghl_status: e.ghlStatus });
    }
    if (e?.code === 'DB_INSERT') {
      console.error('[opvolging-agenda] DB insert:', e?.message, 'ghl:', e?.ghl_appointment_id);
      return res.status(500).json({
        error             : 'De afspraak staat wel in GHL maar niet bij ons — controleer de kalender voor je opnieuw boekt.',
        ghl_appointment_id: e?.ghl_appointment_id || null,
      });
    }
    console.error('[opvolging-agenda] onbekend:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Inplannen mislukt' });
  }

  // Pas nu de taak bijwerken. Faalt dit, dan staat de afspraak er wel — dat
  // melden we expliciet in plaats van stil door te gaan, want anders blijft de
  // taak open en boekt iemand 'm een tweede keer.
  const afspraakRef = {
    bron               : 'opvolging-agenda',
    appointment_id     : afspraak.appointment_id,
    ghl_appointment_id : afspraak.ghl_appointment_id,
    zoom_join_url      : afspraak.zoom_join_url,
    scheduled_at       : afspraak.scheduled_at,
  };
  try {
    const { error } = await supabaseAdmin.from('opvolging_taken').update({
      status              : 'ingepland',
      afspraak_ref        : afspraakRef,
      afspraak_gevonden_at: new Date().toISOString(),
      updated_at          : new Date().toISOString(),
    }).eq('id', taak.id);
    if (error) throw error;
  } catch (e) {
    console.error('[opvolging-agenda] taak bijwerken:', e?.message || e);
    return res.status(500).json({
      error   : 'De afspraak is geboekt, maar de taak kon niet bijgewerkt worden. Zet de taak handmatig op ingepland.',
      afspraak: afspraakRef,
    });
  }

  // De poging is de historiek, niet de actie zelf — fail-soft.
  try {
    const { error } = await supabaseAdmin.from('opvolging_pogingen').insert({
      taak_id    : taak.id,
      soort      : 'ingepland',
      automatisch: true,
      resultaat  : 'afspraak geboekt',
    });
    if (error) throw error;
  } catch (e) {
    console.warn('[opvolging-agenda] poging schrijven (soft):', e?.message || e);
  }

  return res.status(200).json({ success: true, afspraak: afspraakRef });
}

/**
 * createAppointmentForLead() verwacht een follow_up_leads-achtig object.
 *
 * Voor een taak die uit een event komt bestaat die rij echt — Punt A in
 * events-complete-core.js maakt 'm, met dezelfde attendee_id in source_ref.
 * Die is te verkiezen: hij draagt customer_id en source_ref.ghl_contact_id,
 * en dat is de nette weg naar het bestaande GHL-contact.
 *
 * Bestaat hij niet (handmatige taak, of een taak uit een call), dan bouwen we
 * een lead-vormig object uit de taak zelf. resolveGhlContactId valt dan terug
 * op contacts/upsert met e-mail of telefoon — hetzelfde gedrag als elke andere
 * caller van dit pad.
 */
async function zoekLeadVoorTaak(taak) {
  const attendeeId = taak?.bron_ref?.attendee_id || null;
  if (attendeeId) {
    try {
      const { data } = await supabaseAdmin
        .from('follow_up_leads')
        .select('id, customer_id, lead_name, lead_email, lead_phone, owner_id, source_ref')
        .eq('source', 'event')
        .filter('source_ref->>attendee_id', 'eq', attendeeId)
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data[0]) return data[0];
    } catch (e) {
      console.warn('[opvolging-agenda] lead-lookup (soft):', e?.message || e);
    }
  }
  return {
    id        : taak.id,
    customer_id: null,
    lead_name : taak.naam || null,
    lead_email: taak.email || null,
    lead_phone: taak.telefoon || null,
    owner_id  : taak.eigenaar_id || null,
    source_ref: taak.bron_ref || {},
  };
}
