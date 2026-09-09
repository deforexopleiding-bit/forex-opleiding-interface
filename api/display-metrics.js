// api/display-metrics.js
//
// Read-only KPI-endpoint voor tv-dashboard (/display). Token-gated (SHA-256
// van display_tokens.token_hash). Geen CRM-login. Geen mutation. PII =
// voornaam + initiaal server-side getrimd. 10s in-memory cache. Rate-limit
// 30/60s per IP. Alle tijd-velden = ISO-8601 met tijdzone (UTC 'Z').
//
// Bronnen (allemaal server-side, geen self-HTTP):
//   leads   → computeLeadsByTraject (_lib/leads-per-traject-compute)  — total_incl_afwijzer + by_traject_incl_afwijzer, matcht v2-dashboard
//   sales   → computeSignedDealsTotal (_lib/sales-signed-deals-compute) met recent_ids voor bling
//   calls   → follow_up_appointments: geboekt (created_at) + afgeronde Zoom-calls (status='completed')
//   opvolging → opvolging_pogingen (bedrijfsbreed, NL-vandaag, richting='uit')
//               - belpogingen    = soort='call'
//               - gesprekken     = soort='call' + classificeerResultaat='gesproken'
//               - voicememos     = soort='spraakbericht'
//               - whatsapp       = soort='whatsapp'
//               en opvolging_taken: open_taken (status='open' AND due<=vandaag),
//               taken_afgerond (gearchiveerd_at in vandaag)
//   1-op-1  → hlms_sessie (nieuw LMS, aparte dfo-lms-client): status='afgerond'
//               (+ no_show) met start_tijd in NL-vandaag. Vervangt Bubble.
//   rank    → activity_log group by user_id (whitelist, env-override)
//   feed    → UNION (leads/sales/opvolging-call/opvolging-voicememo/events), top-15, DESC
//
// Robuustheid: Promise.allSettled over 14 bronnen + eigen safeAwait() voor
// alle secundaire lookups. Falen van één bron degradeert die tegel, rest
// blijft staan. Leads.total = null (niet 0) bij bron-down zodat het bord
// "—" toont i.p.v. misleidend 0.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import {
  nlDayStart, nlDayEndExclusive, nlDateString,
  nlWeekStart, nlWeekEndExclusive, nlMonthStart, nlMonthEndExclusive,
} from './_lib/nl-period.js';
import { computeLeadsByTraject } from './_lib/leads-per-traject-compute.js';
import { computeSignedDealsTotal } from './_lib/sales-signed-deals-compute.js';
import { computeSalesStreak } from './_lib/sales-streak-compute.js';
import { getConfirmedCount } from './_lib/event-registration.js';
// 1-op-1 calls: nieuwe LMS (dfo-lms, eigen Supabase-project) i.p.v. Bubble.
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';
// Opvolging-module: bedrijfsbrede dag-tellingen uit opvolging_pogingen.
// classificeerResultaat scheidt echte gesprekken van 'niet opgenomen' e.d.
import { classificeerResultaat, GESPROKEN } from './_lib/opvolging-poging-telling.js';

const CACHE_TTL_MS = 10_000;
let _cache = { at: 0, payload: null };

// Actie-whitelist voor de "mutations"-tak (bron D) van de execution-score.
// activity_log logt vooral page-views (.view/.access) — voicememo's/calls/
// outcomes staan er NIET in (die tellen we uit follow_up_* tabellen als
// bronnen A/B/C). Deze whitelist = puur CRM-mutaties. Env-override:
//   DISPLAY_RANKING_ACTIONS="sales.customer.create,sales.deal.create,..."
const RANKING_ACTIONS_DEFAULT = [
  'sales.customer.create', 'sales.deal.create', 'sales.deal.edit',
  'onboarding.create', 'onboarding.assign_mentor',
  'finance.inbox.send', 'email.reply.send',
  'finance.arrangements.approve', 'finance.dunning.execute',
  'finance.incasso.manage', 'finance.invoice.payment.register',
  'agents.approval.act', 'events.team_member.link', 'leads.delete',
];

// Actieve staff-rollen — voorkomt dat een toevallige viewer-actie in de
// ranglijst sluipt. profiles.role wordt gejoined via één batch-fetch.
const STAFF_ROLES = new Set([
  'super_admin', 'admin', 'manager', 'sales', 'mentor', 'marketing', 'administratie',
]);

// Bucket-matchers matchen exact v2-dashboard-v2.js:730-735 (substring-lower).
const BUCKET_MATCHERS = [
  { key: 'challenge', match: ['7-daagse', '7 daagse', '7daagse'] },
  { key: 'event',     match: ['event'] },
  { key: 'webinar',   match: ['webinar'] },
  { key: 'mini',      match: ['mini'] },
];

// ── PII-trim helper ──────────────────────────────────────────────────────
function trimName(name) {
  if (!name || typeof name !== 'string') return '—';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last  = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}.`;
}

// ── Token-check tegen display_tokens ──────────────────────────────────────
async function verifyToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 16) return false;
  const hash = crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
  const { data } = await supabaseAdmin
    .from('display_tokens').select('id')
    .eq('token_hash', hash).is('revoked_at', null).maybeSingle();
  if (!data) return false;
  // Alleen last_used_at bijwerken. Fire-and-forget zodat token-verificatie
  // niet stil vast blijft zitten op een langzame update.
  supabaseAdmin.from('display_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id).then(() => {}, () => {});
  return true;
}

// ── safeAwait — fallback bij falen zodat één transient fout niet het bord zwart maakt ──
async function safeAwait(promise, fallback, label) {
  try { return await promise; }
  catch (e) { console.warn('[display-metrics] secondary ' + label + ' failed:', e?.message); return fallback; }
}

// ── 1-op-1 calls vandaag uit het nieuwe LMS (hlms_sessie) ──────────────────
// Vervangt de oude Bubble-telling. Leest via de aparte dfo-lms-client
// (env DFO_LMS_SUPABASE_URL/DFO_LMS_SUPABASE_SERVICE_ROLE_KEY). Ontbreekt die
// config, dan count=null → het bord toont "—" i.p.v. misleidend 0.
// Bedrijfsbreed: alle mentoren, geen owner-scope. start_tijd in NL-vandaag.
async function getOneOnOneToday({ dayStartIso, dayEndIso }) {
  const lms = getDfoLmsClient();
  if (!lms) return { count: null, no_show: null, source: 'lms-unconfigured', as_of: new Date().toISOString() };
  try {
    const [done, noShow] = await Promise.all([
      lms.from('hlms_sessie').select('id', { count: 'exact', head: true })
        .eq('status', 'afgerond').gte('start_tijd', dayStartIso).lt('start_tijd', dayEndIso),
      lms.from('hlms_sessie').select('id', { count: 'exact', head: true })
        .eq('status', 'no_show').gte('start_tijd', dayStartIso).lt('start_tijd', dayEndIso),
    ]);
    if (done.error) throw new Error(done.error.message);
    return {
      count:   typeof done.count === 'number' ? done.count : null,
      no_show: (noShow && !noShow.error && typeof noShow.count === 'number') ? noShow.count : null,
      source:  'dfo-lms',
      as_of:   new Date().toISOString(),
    };
  } catch (e) {
    console.warn('[display-metrics] LMS 1-op-1 count failed:', e?.message);
    return { count: null, no_show: null, source: 'lms-error', as_of: new Date().toISOString() };
  }
}

// ── Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = String(req.query?.key || '').trim();
  const ok = await verifyToken(key);
  if (!ok) return res.status(401).json({ error: 'Invalid or missing token' });

  const rl = await checkRateLimit({ req, bucket: 'display-metrics', maxHits: 30, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  const now = Date.now();
  if (_cache.payload && (now - _cache.at) < CACHE_TTL_MS) {
    return res.status(200).json(_cache.payload);
  }

  try {
    const dayStart = nlDayStart();
    const dayEnd   = nlDayEndExclusive();
    const dayStartIso = dayStart.toISOString();
    const dayEndIso   = dayEnd.toISOString();
    // [Fix 1 · 2026-08-26] Was `.slice(0,10)` op UTC-instant → gaf gister-datum
    // (dayStart NL 00:00 = 22:00 UTC → sinceStr='2026-08-25' i.p.v. '2026-08-26'
    // in zomertijd). Sales van vandaag vielen buiten range → count=0.
    // nlDateString() geeft NL-tz-aware YYYY-MM-DD.
    const sinceStr = nlDateString(dayStart);
    const untilStr = nlDateString(dayEnd);
    // Week (ma..ma+7) en maand (1e..volgende 1e), NL-tz.
    const weekStart  = nlWeekStart(dayStart);
    const weekEnd    = nlWeekEndExclusive(dayStart);
    const monthStart = nlMonthStart(dayStart);
    const monthEnd   = nlMonthEndExclusive(dayStart);

    const rankingActions = process.env.DISPLAY_RANKING_ACTIONS
      ? process.env.DISPLAY_RANKING_ACTIONS.split(',').map(s => s.trim()).filter(Boolean)
      : RANKING_ACTIONS_DEFAULT;

    // Primaire bronnen — allSettled. Falen → placeholder.
    const results = await Promise.allSettled([
      /* 0 */ computeLeadsByTraject({ supabaseAdmin, range: { start: dayStart, endExclusive: dayEnd }, skipAllLabels: true }),
      /* 1 */ computeSignedDealsTotal({ supabaseAdmin, since: sinceStr, until: untilStr, includeRecentIds: true }),
      /* 2 */ supabaseAdmin.from('follow_up_appointments').select('id', { count: 'exact', head: true })
                .gte('scheduled_at', dayStartIso).lt('scheduled_at', dayEndIso)
                .not('zoom_meeting_id', 'is', null).eq('status', 'completed'),
      /* 3 */ // 2026-08-26: limit 5→10 nu ranglijst weg is (up-list-tegel groter).
              supabaseAdmin.from('follow_up_appointments')
                .select('id, scheduled_at, lead_name, zoom_meeting_id')
                .gte('scheduled_at', new Date().toISOString()).eq('status', 'scheduled')
                .order('scheduled_at', { ascending: true }).limit(10),
      /* 4 */ supabaseAdmin.from('activity_log').select('user_id')
                .in('action', rankingActions)
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      // v3 (2026-08-26): feed-bronnen op HELE NL-vandaag i.p.v. 2h-window,
      // zodat de feed altijd gevuld is en aflopend blijft stromen.
      // Elk .limit(20) → samen max 100 kandidaten → top-15 in payload.
      /* 5 */ supabaseAdmin.from('email_messages').select('id, from_name, date_received')
                .eq('category', 'Nieuwe Lead').gte('date_received', dayStartIso).lt('date_received', dayEndIso)
                .order('date_received', { ascending: false }).limit(20),
      /* 6 */ // Feed sales: LEEG. We deriveren uit salesCompute.recent_ids
              // (clean-set die ook sales.count/total voedt). Index blijft
              // bezet zodat pick(7-13) niet schuift.
              Promise.resolve({ data: [] }),
      /* 7 */ // 2026-08-26 v3: feed "Call afgerond" verplaatst van
              // follow_up_appointments.updated_at → follow_up_outcomes
              // (bron 9). Reden: appointments.updated_at werd 's nachts
              // geflipt door batch/RLS-touches → afgeronde calls
              // resurfaceden om 01:45 met verkeerde tijd. Bron 9 heeft
              // de ECHTE afrond-timestamp (immutable created_at op
              // outcomes-insert). Index leeg gelaten zodat pick(8-16)
              // niet schuift.
              Promise.resolve({ data: [] }),
      /* 8 */ // 2026-09-09: feed-voicememo's komen nu uit de Opvolging-module
              //   (bron #24: opvolging_pogingen soort='spraakbericht'), niet meer
              //   uit follow_up_appointments. Index leeg gelaten zodat pick(9-22)
              //   niet schuift.
              Promise.resolve({ data: [] }),
      /* 9 */ // 2026-09-09: feed "Call" komt nu uit de Opvolging-module
              //   (bron #23: opvolging_pogingen soort='call', gesproken), niet
              //   meer uit follow_up_outcomes. Index leeg gelaten.
              Promise.resolve({ data: [] }),
      /*10 */ supabaseAdmin.from('event_signup_inbox').select('id, first_name, event_date_label, created_at')
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso)
                .order('created_at', { ascending: false }).limit(20),
      /*11 */ // 2026-09-09: de "Vandaag"-box is herbedraad van het oude,
              //   Dave-gescopte follow_up_*-systeem naar de bedrijfsbrede
              //   Opvolging-module (bronnen #23-#27). Index leeg gelaten zodat
              //   pick(12-22) niet schuift.
              Promise.resolve(null),
      /*12 */ Promise.resolve({ data: [] }),
      /*13 */ getOneOnOneToday({ dayStartIso, dayEndIso }),
      // ─── execution-score bronnen (APPENDED, geen index-shift van 5-13) ───
      /*14 */ // A: afgeronde calls per owner (NL-vandaag)
              supabaseAdmin.from('follow_up_appointments').select('owner_id')
                .eq('status', 'completed')
                .gte('scheduled_at', dayStartIso).lt('scheduled_at', dayEndIso),
      /*15 */ // B: verstuurde voicememo's per owner (NL-vandaag).
              // [Fix 4 · 2026-08-26] Was updated_at → overtelde batch/RLS-updates
              // die eergister voicememo-rijen aanraakten (2026-08-26: Dave 16 vs
              // realiteit 6). voicememo_sent_at wordt alleen door POST-verzend-
              // flow gezet → echte "vandaag verstuurd" count.
              supabaseAdmin.from('follow_up_appointments').select('owner_id')
                .eq('voicememo_status', 'sent')
                .gte('voicememo_sent_at', dayStartIso).lt('voicememo_sent_at', dayEndIso),
      /*16 */ // C: outcomes per owner via PostgREST inner-join op appointment.owner_id
              supabaseAdmin.from('follow_up_outcomes')
                .select('id, appointment_id, created_at, follow_up_appointments!inner(owner_id)')
                .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      // ─── Display v2 bronnen (APPENDED, geen index-shift van 5-16) ───
      /*17 */ // app_settings: display_week_target + display_month_target (int € of null)
              supabaseAdmin.from('app_settings').select('key, value')
                .in('key', ['display_week_target', 'display_month_target']),
      /*18 */ // Sales week [ma..volgende ma) NL
              computeSignedDealsTotal({
                supabaseAdmin,
                since: nlDateString(weekStart),
                until: nlDateString(weekEnd),
                includeRecentIds: false,
              }),
      /*19 */ // Sales maand [1e..volgende 1e) NL
              computeSignedDealsTotal({
                supabaseAdmin,
                since: nlDateString(monthStart),
                until: nlDateString(monthEnd),
                includeRecentIds: false,
              }),
      /*20 */ // Upcoming events (top 2 published, starts_at >= now)
              supabaseAdmin.from('events')
                .select('id, title, starts_at, location, capacity')
                .eq('status', 'published')
                .gte('starts_at', new Date().toISOString())
                .order('starts_at', { ascending: true }).limit(2),
      /*21 */ // Streak (helper doet 2 queries intern)
              computeSalesStreak({ supabaseAdmin, todayDayStart: dayStart }),
      /*22 */ // Event-bellijst: attendees waarvoor vandaag een bel-uitkomst is
              // geregistreerd (follow-up-lead-outcome.js schrijft call_status +
              // call_status_at bij elke outcome-write, regel 856-867).
              // Geen filter op event.status — draft-events krijgen geen attendees
              // + geen "niet gebeld"-enum, dus elke non-null call_status = echte
              // belactie. Historische data (event later gecancelled) telt terecht mee.
              supabaseAdmin.from('event_attendees').select('id', { count: 'exact', head: true })
                .not('call_status', 'is', null)
                .gte('call_status_at', dayStartIso).lt('call_status_at', dayEndIso),
      // ─── Opvolging-module bronnen (APPENDED, geen index-shift van 5-22) ───
      // Bedrijfsbreed, NL-vandaag, richting='uit' (= moeite van het team, geen
      // binnenkomende antwoorden). Zie api/_lib/opvolging-poging-telling.js.
      /*23 */ // Belpogingen (soort=call) — rijen incl. resultaat + taak-naam
              //   zodat we hieruit ZOWEL de teller (belpogingen + gesprekken via
              //   classificeerResultaat) ALS de live-feed ("Call: <naam>") maken.
              supabaseAdmin.from('opvolging_pogingen')
                .select('id, tijdstip, resultaat, opvolging_taken(naam)')
                .eq('soort', 'call').eq('richting', 'uit')
                .gte('tijdstip', dayStartIso).lt('tijdstip', dayEndIso)
                .order('tijdstip', { ascending: false }).limit(200),
      /*24 */ // Voicememo's verstuurd (soort=spraakbericht) — rijen incl.
              //   taak-naam voor teller + feed ("Voicememo: <naam>").
              supabaseAdmin.from('opvolging_pogingen')
                .select('id, tijdstip, opvolging_taken(naam)')
                .eq('soort', 'spraakbericht').eq('richting', 'uit')
                .gte('tijdstip', dayStartIso).lt('tijdstip', dayEndIso)
                .order('tijdstip', { ascending: false }).limit(100),
      /*25 */ // WhatsApp verstuurd (soort=whatsapp) — alleen teller.
              supabaseAdmin.from('opvolging_pogingen').select('id', { count: 'exact', head: true })
                .eq('soort', 'whatsapp').eq('richting', 'uit')
                .gte('tijdstip', dayStartIso).lt('tijdstip', dayEndIso),
      /*26 */ // Open taken (nog te bellen): status=open EN due <= vandaag (NL).
              //   due is een date-kolom → vergelijk op de NL-datumstring.
              supabaseAdmin.from('opvolging_taken').select('id', { count: 'exact', head: true })
                .eq('status', 'open').lte('due', sinceStr),
      /*27 */ // Taken afgerond vandaag: gearchiveerd_at in NL-vandaag.
              supabaseAdmin.from('opvolging_taken').select('id', { count: 'exact', head: true })
                .gte('gearchiveerd_at', dayStartIso).lt('gearchiveerd_at', dayEndIso),
    ]);

    const pick = (i, fallback) => {
      if (results[i].status === 'fulfilled') return results[i].value;
      console.warn('[display-metrics] source #' + i + ' failed:', results[i].reason?.message);
      return fallback;
    };

    const leadsCompute       = pick(0,  { total_incl_afwijzer: null, by_traject_incl_afwijzer: {}, excluded: {} });
    const salesCompute       = pick(1,  { total_incl_vat: null, count: null, recent_ids: [] });
    const callsTodayRes      = pick(2,  { count: null });
    const callsNextRes       = pick(3,  { data: [] });
    const rankingRes         = pick(4,  { data: [] });
    const feedLeadsRes       = pick(5,  { data: [] });
    const feedSalesRes       = pick(6,  { data: [] });
    const feedCallsCompleted = pick(7,  { data: [] });
    const feedVoicememoRes   = pick(8,  { data: [] });  // (leeg — feed komt uit #24)
    const feedOutcomesRes    = pick(9,  { data: [] });  // (leeg — feed komt uit #23)
    const feedEventsRes      = pick(10, { data: [] });
    const oneOnOne           = pick(13, { count: null, no_show: null, as_of: new Date().toISOString(), source: 'lms-error' });
    // Execution-score bronnen A/B/C (appended):
    const rankCallsRes       = pick(14, { data: [] });
    const rankVoicememoRes   = pick(15, { data: [] });
    const rankOutcomesRes    = pick(16, { data: [] });
    // Display v2 bronnen:
    const settingsRes        = pick(17, { data: [] });
    const weekSales          = pick(18, { total_incl_vat: null });
    const monthSales         = pick(19, { total_incl_vat: null });
    const eventsRes          = pick(20, { data: [] });
    const streakVal          = pick(21, 0);
    const eventCallsRes      = pick(22, { count: 0 });
    // Opvolging-module (bedrijfsbreed, NL-vandaag):
    const opvCallsRes        = pick(23, { data: [] });
    const opvVoicememoRes    = pick(24, { data: [] });
    const opvWhatsappRes     = pick(25, { count: 0 });
    const opvOpenTakenRes    = pick(26, { count: 0 });
    const opvTakenAfgerondRes = pick(27, { count: 0 });

    // ── Opvolging-tellingen ───────────────────────────────────────────────
    // Belpogingen = alle uitgaande call-pogingen vandaag. Gesprekken = de
    // subset waar het resultaat als 'gesproken' classificeert (rest = niet
    // opgenomen / via ander / onbekend → telt niet als gesprek).
    const opvCallRows = opvCallsRes.data || [];
    const opvBelpogingen = opvCallRows.length;
    const opvGesprekken  = opvCallRows.filter((r) => classificeerResultaat(r.resultaat) === GESPROKEN).length;
    const opvVoicememoRows = opvVoicememoRes.data || [];
    const opvVoicememos  = opvVoicememoRows.length;
    const opvWhatsapp    = opvWhatsappRes.count || 0;
    const opvOpenTaken   = opvOpenTakenRes.count || 0;
    const opvTakenAfgerond = opvTakenAfgerondRes.count || 0;
    // Naam uit de embedded taak (object of array, afhankelijk van PostgREST-vorm).
    const taakNaam = (row) => {
      const t = row.opvolging_taken;
      const naam = Array.isArray(t) ? t[0]?.naam : t?.naam;
      return naam || '';
    };

    // ── Secundaire queries — safeAwait ────────────────────────────────────
    const callsBookedRes = await safeAwait(
      supabaseAdmin.from('follow_up_appointments').select('id', { count: 'exact', head: true })
        .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
      { count: null },
      'callsBookedCount'
    );
    const callsBookedCount = callsBookedRes.count;

    // ── Leads-buckets — v2-conventie: total_incl_afwijzer + substring-match ─
    const buckets = { challenge: 0, mini: 0, event: 0, webinar: 0 };
    const unmatched = [];
    for (const label of Object.keys(leadsCompute.by_traject_incl_afwijzer || {})) {
      const l = String(label).toLowerCase();
      const cnt = leadsCompute.by_traject_incl_afwijzer[label] || 0;
      let matched = false;
      for (const b of BUCKET_MATCHERS) {
        if (b.match.some(m => l.includes(m))) { buckets[b.key] += cnt; matched = true; break; }
      }
      if (!matched && cnt > 0) unmatched.push({ label, count: cnt });
    }
    if (unmatched.length) console.log('[display-metrics] leads-buckets unmatched today:', unmatched);

    // ── Sales — geen dubbel-trim; label komt PII-safe uit compute-helper ──
    const salesRecent = salesCompute.recent_ids || [];

    // ── Calls next ────────────────────────────────────────────────────────
    const callsNext = (callsNextRes.data || []).map(a => ({
      id: a.id,
      scheduled_at: new Date(a.scheduled_at).toISOString(),
      lead_label: trimName(a.lead_name || ''),
      type: a.zoom_meeting_id ? 'Zoom' : 'Bel',
    }));

    // ── Staff execution-score (A + B + C + D per user) ────────────────────
    // A: afgeronde calls (owner_id), B: voicememo's (owner_id),
    // C: outcomes (via appointment.owner_id join), D: activity_log CRM-mutaties.
    // A/B/C zijn owner_id-attributie, D is user_id — beide keys zijn een
    // profile-uuid dus we mergen in één map. Voicememo/call/outcome staan
    // NIET in activity_log → geen dubbeltelling.
    const rankAgg = new Map(); // uid → { calls, voicememos, outcomes, mutations }
    const bump = (uid, key) => {
      if (!uid) return;
      let row = rankAgg.get(uid);
      if (!row) { row = { calls: 0, voicememos: 0, outcomes: 0, mutations: 0 }; rankAgg.set(uid, row); }
      row[key] += 1;
    };
    for (const r of (rankCallsRes.data     || [])) bump(r.owner_id, 'calls');
    for (const r of (rankVoicememoRes.data || [])) bump(r.owner_id, 'voicememos');
    for (const r of (rankOutcomesRes.data  || [])) {
      // PostgREST-join levert het gerelateerde record als object of array — beide vormen zien we.
      const fa = r.follow_up_appointments;
      const ownerId = Array.isArray(fa) ? fa[0]?.owner_id : fa?.owner_id;
      bump(ownerId, 'outcomes');
    }
    for (const r of (rankingRes.data || [])) bump(r.user_id, 'mutations');

    // Batch: profiles voor alle uids (naam + rol-filter tegelijk).
    const uids = [...rankAgg.keys()];
    let profMap = new Map(); // uid → { full_name, role, is_active }
    if (uids.length) {
      const profsRes = await safeAwait(
        supabaseAdmin.from('profiles').select('id, full_name, role, is_active').in('id', uids),
        { data: [] },
        'rankProfiles'
      );
      profMap = new Map((profsRes.data || []).map(p => [p.id, p]));
    }

    const staffRanking = [...rankAgg.entries()]
      .filter(([uid]) => {
        // Alleen actieve CRM-staff — voorkomt viewer/student in de lijst.
        const p = profMap.get(uid);
        if (!p || p.is_active === false) return false;
        return STAFF_ROLES.has(p.role);
      })
      .map(([uid, br]) => {
        const count = br.calls + br.voicememos + br.outcomes + br.mutations;
        // Voornaam voluit — interne collega's, geen klant-PII-trim.
        const full = (profMap.get(uid)?.full_name || 'Onbekend').trim();
        const firstName = full.split(/\s+/)[0] || 'Onbekend';
        return { user_label: firstName, count, breakdown: br };
      })
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // ── Display v2: targets + momentum + events ──────────────────────────
    const settingsMap = {};
    for (const r of (settingsRes.data || [])) settingsMap[r.key] = r.value;
    const wTarget = (settingsMap.display_week_target  != null) ? (Number(settingsMap.display_week_target)  || null) : null;
    const mTarget = (settingsMap.display_month_target != null) ? (Number(settingsMap.display_month_target) || null) : null;
    const nowMs2 = Date.now();
    const weekFrac  = Math.min(1, Math.max(0, (nowMs2 - weekStart.getTime())  / (weekEnd.getTime()  - weekStart.getTime())));
    const monthFrac = Math.min(1, Math.max(0, (nowMs2 - monthStart.getTime()) / (monthEnd.getTime() - monthStart.getTime())));
    // Pace-pill: "op schema" als pct >= verstreken-fractie − 5pp (tolerantie
    // voorkomt "achter" om 09:30 maandag). null pct → pace ook null.
    const pace = (pct, frac) => (pct == null) ? null : (pct >= frac - 0.05 ? 'ok' : 'behind');
    const wAmt = weekSales.total_incl_vat  ?? 0;
    const mAmt = monthSales.total_incl_vat ?? 0;
    const wPct = wTarget ? wAmt / wTarget : null;
    const mPct = mTarget ? mAmt / mTarget : null;

    // Momentum uit salesCompute.recent_ids (0 extra queries)
    const salesTodayList = salesCompute.recent_ids || [];
    const biggestToday = salesTodayList.length
      ? Math.max(...salesTodayList.map(s => Number(s.amount_incl || 0)))
      : null;
    const lastAcc = salesTodayList.reduce((mx, s) => (s.accepted_at && s.accepted_at > mx) ? s.accepted_at : mx, '');
    const lastSaleMin = lastAcc ? Math.round((Date.now() - new Date(lastAcc).getTime()) / 60000) : null;
    const avgDealToday = (salesCompute.count && salesCompute.count >= 2 && salesCompute.total_incl_vat)
      ? Math.round(salesCompute.total_incl_vat / salesCompute.count) : null;

    // Events top 2 + attendee-count via getConfirmedCount + safeAwait per event
    // (één count-fout degradeert alleen die tegel, niet het hele bord).
    const evRaw = (eventsRes.data || []).slice(0, 2);
    const evCounts = await Promise.all(evRaw.map((e, i) =>
      safeAwait(getConfirmedCount(e.id), 0, 'eventCount#' + i)
    ));
    const eventsOut = evRaw.map((e, i) => ({
      id: e.id, title: e.title, starts_at: e.starts_at,
      location: e.location || '', capacity: e.capacity || null,
      attendee_count: evCounts[i],
    }));

    // ── Feed sales derive uit salesCompute.recent_ids ─────────────────────
    // Fix 1 (2026-08-26): oude losse deals-query miste test-deal- +
    // declined/archived-filters → feed toonde soms sale die sales.count NIET
    // telde ("Sale: Andrea M." bij sales.count=0). Nu gebruiken we dezelfde
    // clean-set als sales.count/total.
    // 2026-08-26 v2: 2h-window verwijderd — recent_ids is al today-only, en
    // overige feed-bronnen tonen ook de hele NL-dag. Zonder deze filter
    // blijft een sale van bv. 21:00 later op de avond bovenaan de feed
    // zichtbaar. De algemene feed-sort + cap 15 doet de rest.
    // Klant-labels zijn PII-veilig getrimd door compute-helper.
    const feedSalesClean = (salesCompute.recent_ids || [])
      .filter(s => s.accepted_at);

    // ── Feed 6-way ────────────────────────────────────────────────────────
    const feed = [];
    for (const e of (feedLeadsRes.data || [])) feed.push({
      ts: new Date(e.date_received).toISOString(), type: 'lead',
      text: `Nieuwe lead: ${trimName(e.from_name || '')}`,
    });
    for (const s of feedSalesClean) feed.push({
      ts: s.accepted_at, type: 'sale',
      text: `Sale: ${s.customer_label}`,
    });
    // 2026-09-09: feed-voicememo's + calls komen nu uit de Opvolging-module
    // (bronnen #24/#23). Voicememo = elke uitgaande spraakbericht-poging;
    // "Call" = een uitgaande call-poging waar écht gesproken is (classificatie
    // 'gesproken') — niet-opgenomen belletjes vullen de feed niet.
    for (const v of opvVoicememoRows) feed.push({
      ts: new Date(v.tijdstip).toISOString(), type: 'voicememo',
      text: `Voicememo: ${trimName(taakNaam(v))}`,
    });
    for (const c of opvCallRows) {
      if (classificeerResultaat(c.resultaat) !== GESPROKEN) continue;
      feed.push({
        ts: new Date(c.tijdstip).toISOString(), type: 'call',
        text: `Call: ${trimName(taakNaam(c))}`,
      });
    }
    for (const s of (feedEventsRes.data || [])) feed.push({
      ts: new Date(s.created_at).toISOString(), type: 'event',
      text: `Event-signup: ${trimName(s.first_name || '')}${s.event_date_label ? ' → ' + s.event_date_label : ''}`,
    });
    feed.sort((a, b) => (a.ts < b.ts ? 1 : -1));

    // ── Optionele diagnose-scan (achter env-flag, alleen tijdens tuning) ─
    if (process.env.DISPLAY_DEBUG_ACTIONS === '1') {
      const diagRes = await safeAwait(
        supabaseAdmin.from('activity_log').select('action')
          .gte('created_at', dayStartIso).lt('created_at', dayEndIso),
        { data: [] },
        'diagnoseActionsScan'
      );
      const actionCounts = {};
      for (const r of (diagRes.data || [])) actionCounts[r.action] = (actionCounts[r.action] || 0) + 1;
      const outsideWhitelist = Object.entries(actionCounts)
        .filter(([a]) => !rankingActions.includes(a))
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (outsideWhitelist.length) console.log('[display-metrics] top actions outside whitelist:', outsideWhitelist);
    }

    // ── Payload assembly ─────────────────────────────────────────────────
    // leads.total = null bij bron-down (bord toont "—" i.p.v. misleidend 0).
    // [Fix 2 · 2026-08-26] Hero "Nieuwe leads" = alleen echte lead-bronnen
    // (challenge/mini/event/webinar). Calls-bucket blijft als aparte 5e tegel
    // in .leads.buckets[], telt NIET mee in het hero-totaal. Matcht v2-hero.
    const leadsTotal = (leadsCompute.total_incl_afwijzer === null || leadsCompute.total_incl_afwijzer === undefined)
      ? null
      : leadsCompute.total_incl_afwijzer;

    const payload = {
      generated_at: new Date().toISOString(),
      leads: {
        total: leadsTotal,
        buckets: [
          { key: 'challenge', label: '7-daagse',      count: buckets.challenge },
          { key: 'mini',      label: 'Mini-cursus',   count: buckets.mini      },
          { key: 'event',     label: 'Events',        count: buckets.event     },
          { key: 'webinar',   label: 'Webinar',       count: buckets.webinar   },
          { key: 'calls',     label: 'Nieuwe calls',  count: callsBookedCount ?? null },
        ],
      },
      sales: {
        count: salesCompute.count,
        total_incl_vat: salesCompute.total_incl_vat,
        recent_ids: salesRecent,
      },
      calls: {
        count_today:  callsTodayRes.count,     // afgeronde Zoom-calls vandaag (foot v-calls-sub)
        booked_today: callsBookedCount,        // GEBOEKTE calls vandaag (created_at) → hero v-calls
        next:         callsNext,
      },
      // Opvolging-module (bedrijfsbreed, NL-vandaag). Vervangt de oude,
      // Dave-gescopte `dave`-tak die op follow_up_* draaide.
      opvolging: {
        belpogingen:    opvBelpogingen,
        gesprekken:     opvGesprekken,
        voicememos:     opvVoicememos,
        whatsapp:       opvWhatsapp,
        open_taken:     opvOpenTaken,
        taken_afgerond: opvTakenAfgerond,
      },
      one_on_one: {
        count_today: oneOnOne.count,
        no_show:     oneOnOne.no_show,
        source:      oneOnOne.source,
        as_of:       oneOnOne.as_of,
      },
      staff_ranking: staffRanking,
      targets: {
        week:  { amount: wAmt, target: wTarget, pct: wPct, pace: pace(wPct, weekFrac) },
        month: { amount: mAmt, target: mTarget, pct: mPct, pace: pace(mPct, monthFrac) },
      },
      momentum: {
        biggest_today:  biggestToday,
        last_sale_min:  lastSaleMin,
        avg_deal_today: avgDealToday,
        streak:         streakVal,
      },
      events: eventsOut,
      event_calls_today: eventCallsRes.count || 0,
      feed: feed.slice(0, 15),
    };

    _cache = { at: now, payload };
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[display-metrics]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
