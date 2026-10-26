// api/display-funnel.js
//
// GET → funnelstatistieken voor het Live Kantoorbord (/display), gegroepeerd
// per funnelfamilie (Mini-cursus, 7-daagse, Webinar, The Lab, Strategie-scan,
// Events). Per familie: bezoeken → opt-ins → geboekte calls.
//
// TOKEN-GATED (?key=…, zelfde display_tokens als /api/display-metrics). GEEN
// CRM-login: het bord hangt publiek op kantoor. Read-only, geen mutatie.
//
// Query:
//   key       display-token (verplicht)
//   periode   'vandaag' | '7d' | '30d'  (default 'vandaag'), Amsterdam-kalender.
//
// Response 200:
//   { periode:{van,tot,start,eind_exclusief,tijdzone}, periode_label,
//     funnels:[{ key, label, color, visits, optins, optin_pct, calls, book_pct }],
//     totals:{ visits, optins, optin_pct, calls, book_pct },
//     tracking_actief }
//
// Definities (zelfde bronnen als /api/funnel-stats, maar gegroepeerd):
//   visits  = landing-sessies uit funnel_events (first-party tracking);
//   optins  = echte leads van de funnel in de periode (leads-tabel / voor de
//             events-funnels de ingevulde vragenlijsten) — betrouwbaar, los van
//             of het lead_ingediend-trackingevent vuurde;
//   calls   = geboekte calls (opstartsessie_submissions / eigen agendabron /
//             event_attendees), zie funnel-stats-compute.
// Omdat visits uit tracking komen en adblockers landing-events kunnen missen,
// kan opt-in% zelden boven 100% uitkomen — een signaal over de tracking, geen
// rekenfout (zie funnel-stats-compute.js). De balk kapt visueel op 100%.
//
// De zware reads (per-variant keyset-paging, fail-soft) zijn bewust gemodelleerd
// op api/funnel-stats.js; hier zonder gedrag/dekking (die heeft het bord niet
// nodig) en met een korte server-cache per periode.

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { nlDayStart, nlDayEndExclusive, nlDateString } from './_lib/nl-period.js';
import {
  FUNNEL_VARIANTEN, BENODIGDE_EVENT_TYPES, BOEK_BRON_PER_VARIANT, EVENT_VARIANTEN,
  aggregeerFunnelStats, variantInfo, pct,
} from './_lib/funnel-stats-compute.js';
// Canonieke aanmeldingen-telling — dezelfde bron als de KPI "Nieuwe leads" en
// "Nieuwe leads per bron" (incl. webinar-aanmeldingen en heraanmeldingen). Zie
// api/display-metrics.js, dat deze functie ook gebruikt.
import { computeAanmeldingenPerFunnel } from './_lib/aanmeldingen-per-funnel.js';

const PAGINA = 1000;
const MAX_EVENTS_PER_VARIANT = 25000;
const TIJDBUDGET_MS = 18000;   // ruim binnen de 30s Vercel-limiet
const EVENT_KOLOMMEN = 'id,session_id,variant,event_type,stap_nr,vraag_id,quiz_versie,ts,lead_id';

// Gegroepeerde funnelfamilies op het bord. `groep` komt uit funnel-stats-compute
// (variantInfo); we vatten alle varianten met dezelfde groep samen onder één rij.
// Volgorde = volgorde op het bord. Kleuren matchen display.html (BRON_KLEUR-stijl).
const GROEPEN = [
  { key: 'mini',          label: 'Mini-cursus',    color: 'var(--blue)',   groepen: ['kmc'] },
  { key: '7-daagse',      label: '7-daagse',       color: 'var(--gold)',   groepen: ['7-daagse'] },
  { key: 'webinar',       label: 'Webinar',        color: 'var(--orange)', groepen: ['webinar'] },
  { key: 'the-lab',       label: 'The Lab',        color: 'var(--purple)', groepen: ['the-lab'] },
  { key: 'strategiescan', label: 'Strategie-scan', color: 'var(--green)',  groepen: ['strategiescan'] },
  { key: 'events',        label: 'Events',         color: 'var(--teal)',   groepen: ['events'] },
];

const PERIODE_LABEL = { vandaag: 'vandaag', '7d': 'laatste 7 dagen', '30d': 'laatste 30 dagen' };

// Korte server-cache per periode (het bord pollt 7d/30d alleen bij een klik,
// maar meerdere schermen kunnen tegelijk vragen). TTL kort genoeg om "live" te
// blijven, lang genoeg om de zware 30d-reads niet elke keer te doen.
const CACHE_TTL_MS = { vandaag: 20_000, '7d': 120_000, '30d': 300_000 };
const _cache = new Map(); // periode → { at, payload }

// ── Token-check tegen display_tokens (identiek aan display-metrics) ─────────
async function verifyToken(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || plaintext.length < 16) return false;
  const hash = crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');
  const { data } = await supabaseAdmin
    .from('display_tokens').select('id')
    .eq('token_hash', hash).is('revoked_at', null).maybeSingle();
  if (!data) return false;
  supabaseAdmin.from('display_tokens')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id).then(() => {}, () => {});
  return true;
}

function isOntbrekendeTabel(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return /could not find the table|does not exist/i.test(String(err.message || ''));
}

/** Amsterdam-periode uit de periode-knop. */
function periodeUit(periode, nu = new Date()) {
  const eind = nlDayEndExclusive(nu);
  const tot = nlDateString(nu);
  let dagenTerug = 0;
  if (periode === '7d') dagenTerug = 6;
  else if (periode === '30d') dagenTerug = 29;
  const start = nlDayStart(new Date(nlDayStart(nu).getTime() - dagenTerug * 24 * 3600 * 1000 + 12 * 3600 * 1000));
  const van = nlDateString(start);
  return { van, tot, start, eindExclusief: eind };
}

async function leesEventsVoorVariant(db, variant, startIso, eindIso, deadline) {
  const rijen = [];
  let laatsteId = null;
  let afgekapt = false;
  for (;;) {
    if (Date.now() > deadline) { afgekapt = true; break; }
    let q = db.from('funnel_events').select(EVENT_KOLOMMEN)
      .eq('variant', variant).in('event_type', BENODIGDE_EVENT_TYPES)
      .gte('ts', startIso).lt('ts', eindIso);
    if (laatsteId != null) q = q.gt('id', laatsteId);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGINA);
    if (error) return { rijen, afgekapt, fout: error.message || String(error) };
    const page = data || [];
    rijen.push(...page);
    if (page.length < PAGINA) break;
    laatsteId = page[page.length - 1].id;
    if (rijen.length >= MAX_EVENTS_PER_VARIANT) { afgekapt = true; break; }
  }
  return { rijen, afgekapt, fout: null };
}

/** Afspraken voor funnels met een eigen agendabron (The Lab / Strategie-scan). */
async function leesEigenBronAfspraken(db, leads, varianten) {
  const bronnen = [...new Set(varianten.map((v) => BOEK_BRON_PER_VARIANT[v]).filter(Boolean))];
  if (!bronnen.length) return [];
  const mails = [...new Set((leads || [])
    .filter((l) => l && BOEK_BRON_PER_VARIANT[l.bron] && l.email)
    .map((l) => String(l.email).toLowerCase()))];
  const uit = [];
  for (let i = 0; i < mails.length; i += 300) {
    try {
      const { data, error } = await db.from('follow_up_appointments')
        .select('booking_source,lead_email,status,is_test')
        .in('booking_source', bronnen).in('lead_email', mails.slice(i, i + 300)).limit(5000);
      if (error) { console.warn('[display-funnel] eigen-bron-afspraken (soft):', error.message); continue; }
      for (const a of data || []) if (!a.is_test && a.status !== 'cancelled' && a.status !== 'verwijderd') uit.push(a);
    } catch (e) {
      console.warn('[display-funnel] eigen-bron-afspraken exception (soft):', e?.message || e);
    }
  }
  return uit;
}

/** Events-funnels: vragenlijsten (bron) + aanmeldingen (source). Fail-soft. */
async function leesEventFunnelRijen(db, varianten, startIso, eindIso) {
  const ev = varianten.filter((v) => EVENT_VARIANTEN.includes(v));
  if (!ev.length) return { inzendingen: [], aanmeldingen: [] };
  const lees = async (label, q) => {
    try {
      const { data, error } = await q;
      if (error) {
        if (!['42703', 'PGRST204'].includes(error.code)) console.warn('[display-funnel] ' + label + ' (soft):', error.message);
        return [];
      }
      return data || [];
    } catch (e) {
      console.warn('[display-funnel] ' + label + ' exception (soft):', e?.message || e);
      return [];
    }
  };
  const [inzendingen, aanmeldingen] = await Promise.all([
    lees('event-inzendingen', db.from('event_kwalificatie_submissions').select('bron,resultaat,email,created_at')
      .in('bron', ev).gte('created_at', startIso).lt('created_at', eindIso).limit(20000)),
    lees('event-aanmeldingen', db.from('event_attendees').select('source,email,created_at,is_test')
      .in('source', ev).gte('created_at', startIso).lt('created_at', eindIso).limit(20000)),
  ]);
  return { inzendingen, aanmeldingen };
}

/** landing-sessies van één variant uit zijn funnel-blok (fase 'landing'). */
function landingSessies(perVariantRij) {
  const f = perVariantRij && perVariantRij.funnel;
  if (!Array.isArray(f)) return 0;
  const l = f.find((x) => x.fase === 'landing');
  return l ? (l.sessions || 0) : 0;
}

/**
 * Canonieke opt-ins per bord-funnel uit de aanmeldingen-tegels
 * (computeAanmeldingenPerFunnel.tegels). Zo tellen opt-ins ALLE echte
 * aanmeldingen mee — webinar-aanmeldingen (tegels.webinar) en heraanmeldingen —
 * net als de KPI "Nieuwe leads". The Lab en Strategie-scan zitten canoniek in
 * 'overig.delen'; de rest van Overig (training/opstartsessie/overige leads)
 * komt als 'overig'. Som van alle waarden hier = tegels-totaal = de KPI.
 * Retourneert null als de tegels ontbreken (dan valt de endpoint terug op de
 * tracking-telling).
 */
export function canoniekeOptins(tegels) {
  if (!tegels) return null;
  const n = (t) => (t && Number.isFinite(t.totaal) ? t.totaal : 0);
  const deel = (tegels.overig && tegels.overig.delen) || {};
  const lab = deel['the-lab'] || 0;
  const scan = deel.strategiescan || 0;
  const overigRest = Math.max(0, n(tegels.overig) - lab - scan);
  return {
    mini:          n(tegels.mini),
    '7-daagse':    n(tegels['7-daagse']),
    webinar:       n(tegels.webinar),
    events:        n(tegels.event),
    'the-lab':     lab,
    strategiescan: scan,
    overig:        overigRest,
  };
}

async function safeAanmeldingen(db, start, eindExclusief) {
  try {
    return await computeAanmeldingenPerFunnel({ supabaseAdmin: db, range: { start, endExclusive: eindExclusief } });
  } catch (e) {
    console.error('[display-funnel] aanmeldingen-per-funnel mislukt (soft):', e?.message || e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const key = String(req.query?.key || '').trim();
  if (!(await verifyToken(key))) return res.status(401).json({ error: 'Invalid or missing token' });

  const rl = await checkRateLimit({ req, bucket: 'display-funnel', maxHits: 30, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  let periode = String(req.query?.periode || 'vandaag').trim();
  if (!['vandaag', '7d', '30d'].includes(periode)) periode = 'vandaag';

  const nu = Date.now();
  const c = _cache.get(periode);
  if (c && (nu - c.at) < CACHE_TTL_MS[periode]) return res.status(200).json(c.payload);

  try {
    const db = supabaseAdmin;
    const { van, tot, start, eindExclusief } = periodeUit(periode);
    const startIso = start.toISOString();
    const eindIso = eindExclusief.toISOString();
    const deadline = Date.now() + TIJDBUDGET_MS;
    const varianten = [...FUNNEL_VARIANTEN];

    // 1) Tracking-probe + leads + boekingen (parallel).
    const [probe, leadsRes, boekRes] = await Promise.all([
      Promise.resolve(db.from('funnel_events').select('ts').order('ts', { ascending: true }).limit(1))
        .catch((e) => ({ data: null, error: { message: e?.message || String(e) } })),
      db.from('leads').select('id,bron,kwalificatie,email,aangemaakt,afspraak_op')
        .is('verwijderd_op', null).in('bron', varianten)
        .gte('aangemaakt', startIso).lt('aangemaakt', eindIso).limit(20000),
      db.from('opstartsessie_submissions').select('booking_source,appointment_id,lead_id,created_at')
        .in('booking_source', varianten)
        .gte('created_at', startIso).lt('created_at', eindIso).limit(20000),
    ]);
    if (leadsRes.error) throw new Error('leads: ' + leadsRes.error.message);
    if (boekRes.error) throw new Error('opstartsessie_submissions: ' + boekRes.error.message);

    let tabelBestaat = true;
    if (probe.error && isOntbrekendeTabel(probe.error)) tabelBestaat = false;
    const eersteEventTs = tabelBestaat && !probe.error ? (probe.data?.[0]?.ts || null) : null;
    const trackingActief = tabelBestaat && !probe.error && !!eersteEventTs;

    // 2) Funnel-events per variant (keyset-paging). Geen gedrag/dekking: het bord
    //    toont alleen landing-sessies, en opt-ins/calls komen uit lead_resultaat.
    let events = [];
    if (trackingActief) {
      const perVariant = await Promise.all(varianten.map((v) => leesEventsVoorVariant(db, v, startIso, eindIso, deadline)));
      for (const r of perVariant) { events = events.concat(r.rijen); if (r.fout) console.error('[display-funnel] events fout:', r.fout); }
    }

    const afspraken = await leesEigenBronAfspraken(db, leadsRes.data || [], varianten);
    const { inzendingen: eventInzendingen, aanmeldingen: eventAanmeldingen } =
      await leesEventFunnelRijen(db, varianten, startIso, eindIso);

    const agg = aggregeerFunnelStats({
      events, gedragEvents: [], leads: leadsRes.data || [], boekingen: boekRes.data || [], afspraken,
      eventInzendingen, eventAanmeldingen, gekoppeldeLeadIds: [], varianten,
      start, eindExclusief, trackingActief,
    });

    // 3) Canonieke opt-ins (zelfde bron als de KPI) voor deze periode. Bezoeken
    //    blijven uit de tracking; alleen de opt-ins komen hieruit, zodat de som
    //    van de funnel-opt-ins exact de KPI "Nieuwe leads" is.
    const aanm = await safeAanmeldingen(db, start, eindExclusief);
    const canon = canoniekeOptins(aanm && aanm.tegels);   // null → terugval op tracking

    // 4) Groepeer per familie. visits = landing-sessies (tracking),
    //    calls = geboekte calls (funnelmeting), optins = canonieke aanmeldingen
    //    (met terugval op de tracking-telling als de canonieke bron wegvalt).
    const perVariant = agg.per_variant || {};
    const funnels = GROEPEN.map((g) => {
      let visits = 0, optinsTracked = 0, calls = 0;
      for (const variant of varianten) {
        const info = variantInfo(variant);
        if (!info || !g.groepen.includes(info.groep)) continue;
        const r = perVariant[variant];
        if (!r) continue;
        visits += landingSessies(r);
        const lr = r.lead_resultaat || {};
        optinsTracked += lr.leads || 0;
        calls += lr.geboekt || 0;
      }
      const optins = (canon && canon[g.key] != null) ? canon[g.key] : optinsTracked;
      return {
        key: g.key, label: g.label, color: g.color,
        visits, optins, calls,
        optin_pct: pct(optins, visits),
        book_pct: pct(calls, optins),
      };
    });

    // Overig-rij: de resterende canonieke leads (training/opstartsessie/overige
    // bronnen, incl. niet-getrackte) die niet in een funnel-rij vallen, zodat de
    // som van de opt-ins de KPI dekt. Geen tracking-bezoeken. Alleen tonen als er
    // iets in zit (anders blijft de som gelijk en de tabel schoon).
    if (canon && canon.overig > 0) {
      funnels.push({
        key: 'overig', label: 'Overig', color: 'var(--mut)',
        visits: 0, optins: canon.overig, calls: 0,
        optin_pct: null, book_pct: null,
      });
    }

    const tVisits = funnels.reduce((a, f) => a + f.visits, 0);
    const tOptins = funnels.reduce((a, f) => a + f.optins, 0);
    const tCalls = funnels.reduce((a, f) => a + f.calls, 0);

    const payload = {
      periode: { van, tot, start: startIso, eind_exclusief: eindIso, tijdzone: 'Europe/Amsterdam' },
      periode_label: PERIODE_LABEL[periode],
      funnels,
      totals: {
        visits: tVisits, optins: tOptins, calls: tCalls,
        optin_pct: pct(tOptins, tVisits),
        book_pct: pct(tCalls, tOptins),
      },
      tracking_actief: trackingActief,
    };

    _cache.set(periode, { at: nu, payload });
    return res.status(200).json(payload);
  } catch (e) {
    console.error('[display-funnel]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
