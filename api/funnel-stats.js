// api/funnel-stats.js
//
// GET → funnel-dashboard per variant (Leadsonderhoud → Funnels).
// Bron: public.funnel_events (first-party tracking dfo-website) + leads +
// opstartsessie_submissions. Read-only; aggregatie in JS
// (api/_lib/funnel-stats-compute.js), géén RPC/SQL.
//
// Query-params:
//   van, tot   YYYY-MM-DD (Amsterdam-kalenderdagen, tot = inclusief).
//              Beide weglaten = laatste 7 dagen t/m vandaag. Eén van beide
//              of een ongeldige datum → 400. Max 366 dagen.
//   variant    optioneel, één van FUNNEL_VARIANTEN (anders 400). Default alle 6.
//
// Response 200:
//   { periode:{van,tot,start,eind_exclusief,tijdzone}, varianten:[...],
//     per_variant:{ [variant]: { variant,label,groep,sessies_totaal,
//       funnel:[{fase,label,sessions,conversie_vorige,conversie_landing}]|null,
//       afhaken_per_vraag:[{quiz_versie,sessies_gestart,voltooid,voltooid_pct,
//         vragen:[{stap_nr,vraag_id,gezien,door,afgehaakt,afhaak_pct,
//           gem_tijd_s,mediaan_tijd_s,tijd_n,afhakers_mediaan_s}]}]|null,
//       gedrag:{beschikbaar,gedrag_events,tijd_per_vraag,formulier_tijd,scroll,
//         validatie_top,laatste_veld,afhaak_fases,afhaak_quiz_stappen,afhakers,
//         rage_hotspots}|null   (api/_lib/funnel-gedrag-compute.js),
//       lead_resultaat:{leads,toegang,geen_toegang,kwalificatie_onbekend,
//         toegang_pct,geboekt,leads_met_afspraak,leads_met_sessie,dekking_pct} } },
//     meta:{ tracking_actief, tabel_bestaat, eerste_event_ts, events_gelezen,
//       events_genegeerd, gedrag_events_gelezen, afgekapt, max_events_per_variant, fase_telling,
//       geboekt_bron, blinde_vlekken:[...] } }
//
// FAIL-SOFT: bestaat funnel_events nog niet (migratie niet gedraaid) of is de
// tabel leeg → 200 met meta.tracking_actief=false + uitleg in blinde_vlekken.
// Lead-resultaten (uit leads + opstartsessie_submissions) blijven gewoon werken.
//
// Permission: leads.view (strict).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { nlDayStart, nlDayEndExclusive, nlDateString } from './_lib/nl-period.js';
import {
  FUNNEL_VARIANTEN, BENODIGDE_EVENT_TYPES,
  aggregeerFunnelStats, bepaalBlindeVlekken,
} from './_lib/funnel-stats-compute.js';
import { GEDRAG_LEES_TYPES } from './_lib/funnel-gedrag-compute.js';

export const PAGINA = 1000;
export const MAX_EVENTS_PER_VARIANT = 25000;
export const TIJDBUDGET_MS = 20000;   // ruim binnen de 30s Vercel-limiet
const MAX_DAGEN = 366;
const EVENT_KOLOMMEN = 'id,session_id,variant,event_type,stap_nr,vraag_id,quiz_versie,ts,lead_id';
// Gedragsevents: aparte query mét meta (de funnel-query blijft licht). Eigen plafond.
const GEDRAG_KOLOMMEN = 'id,session_id,variant,event_type,stap_nr,vraag_id,quiz_versie,ts,meta';
export const MAX_GEDRAG_EVENTS_PER_VARIANT = 25000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isGeldigeDatum(s) {
  const m = ISO_DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Amsterdam-periode uit van/tot. Retourneert { fout } of { van, tot, start, eindExclusief }. */
export function periodeUitQuery(q = {}, nu = new Date()) {
  let van = String(q.van || '').trim();
  let tot = String(q.tot || '').trim();
  if (!van && !tot) {
    tot = nlDateString(nu);
    van = nlDateString(new Date(nlDayStart(nu).getTime() - 6 * 24 * 3600 * 1000 + 12 * 3600 * 1000));
  }
  if (!isGeldigeDatum(van) || !isGeldigeDatum(tot)) return { fout: 'van en tot moeten geldige datums zijn (YYYY-MM-DD)' };
  if (van > tot) return { fout: 'van moet vóór of gelijk aan tot liggen' };
  const start = nlDayStart(new Date(van + 'T12:00:00Z'));
  const eindExclusief = nlDayEndExclusive(new Date(tot + 'T12:00:00Z'));
  const dagen = (Date.parse(tot + 'T00:00:00Z') - Date.parse(van + 'T00:00:00Z')) / 86400000 + 1;
  if (dagen > MAX_DAGEN) return { fout: `periode mag maximaal ${MAX_DAGEN} dagen zijn` };
  return { van, tot, start, eindExclusief };
}

export function isOntbrekendeTabel(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return /could not find the table|does not exist/i.test(String(err.message || ''));
}

async function leesEventsVoorVariant(db, variant, startIso, eindIso, deadline, {
  types = BENODIGDE_EVENT_TYPES, kolommen = EVENT_KOLOMMEN, max = MAX_EVENTS_PER_VARIANT,
} = {}) {
  const rijen = [];
  let laatsteId = null;
  let afgekapt = false;
  for (;;) {
    if (Date.now() > deadline) { afgekapt = true; break; }
    let q = db.from('funnel_events').select(kolommen)
      .eq('variant', variant)
      .in('event_type', types)
      .gte('ts', startIso).lt('ts', eindIso);
    if (laatsteId != null) q = q.gt('id', laatsteId);
    const { data, error } = await q.order('id', { ascending: true }).limit(PAGINA);
    if (error) return { rijen, afgekapt, fout: error.message || String(error) };
    const page = data || [];
    rijen.push(...page);
    if (page.length < PAGINA) break;
    laatsteId = page[page.length - 1].id;
    if (rijen.length >= max) { afgekapt = true; break; }
  }
  return { rijen, afgekapt, fout: null };
}

async function leesGekoppeldeLeadIds(db, leadIds) {
  const out = new Set();
  const CHUNK = 100;
  for (let i = 0; i < leadIds.length; i += CHUNK) {
    const chunk = leadIds.slice(i, i + CHUNK);
    try {
      const { data, error } = await db.from('funnel_events').select('lead_id').in('lead_id', chunk).limit(5000);
      if (error) { console.error('[funnel-stats] dekking chunk fout:', error.message); continue; }
      for (const r of data || []) if (r && r.lead_id) out.add(r.lead_id);
    } catch (e) {
      console.error('[funnel-stats] dekking chunk exception:', e?.message);
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const q = req.query || {};
  const periode = periodeUitQuery(q);
  if (periode.fout) return res.status(400).json({ error: periode.fout });
  const variantRaw = String(q.variant || '').trim();
  if (variantRaw && !FUNNEL_VARIANTEN.includes(variantRaw)) {
    return res.status(400).json({ error: 'Onbekende variant', toegestaan: FUNNEL_VARIANTEN });
  }
  const varianten = variantRaw ? [variantRaw] : [...FUNNEL_VARIANTEN];
  const startIso = periode.start.toISOString();
  const eindIso = periode.eindExclusief.toISOString();
  const deadline = Date.now() + TIJDBUDGET_MS;

  try {
    const db = supabaseAdmin;

    // 1) Bestaat de tracking-tabel + eerste event; leads; boekingen — parallel.
    const [probe, leadsRes, boekRes] = await Promise.all([
      Promise.resolve(db.from('funnel_events').select('ts').order('ts', { ascending: true }).limit(1))
        .catch((e) => ({ data: null, error: { message: e?.message || String(e) } })),
      db.from('leads').select('id,bron,kwalificatie,email,aangemaakt,afspraak_op')
        .is('verwijderd_op', null).in('bron', varianten)
        .gte('aangemaakt', startIso).lt('aangemaakt', eindIso).limit(20000),
      // Boekingen: opstartsessie_submissions = 1 rij per funnel-boeking met
      // appointment_id + lead_id. follow_up_appointments heeft verzet-kopieën
      // (parent_appointment_id) en niet-funnel bronnen → minder betrouwbaar.
      db.from('opstartsessie_submissions').select('booking_source,appointment_id,lead_id,created_at')
        .in('booking_source', varianten)
        .gte('created_at', startIso).lt('created_at', eindIso).limit(20000),
    ]);
    if (leadsRes.error) throw new Error('leads: ' + leadsRes.error.message);
    if (boekRes.error) throw new Error('opstartsessie_submissions: ' + boekRes.error.message);

    let tabelBestaat = true;
    let leesfout = null;
    if (probe.error) {
      if (isOntbrekendeTabel(probe.error)) tabelBestaat = false;
      else { leesfout = probe.error.message || String(probe.error); console.error('[funnel-stats] probe fout:', leesfout); }
    }
    const eersteEventTs = tabelBestaat && !leesfout ? (probe.data?.[0]?.ts || null) : null;
    const trackingActief = tabelBestaat && !leesfout && !!eersteEventTs;

    // 2) Events (per variant parallel, keyset-paging) + dekking leads↔sessies.
    let events = [];
    let gedragEvents = [];
    let afgekapt = false;
    let gekoppeld = new Set();
    if (trackingActief) {
      const leadIds = (leadsRes.data || []).map((l) => l.id).filter(Boolean);
      const gedragOpts = { types: GEDRAG_LEES_TYPES, kolommen: GEDRAG_KOLOMMEN, max: MAX_GEDRAG_EVENTS_PER_VARIANT };
      const [perVariant, gedragPerVariant, gek] = await Promise.all([
        Promise.all(varianten.map((v) => leesEventsVoorVariant(db, v, startIso, eindIso, deadline))),
        Promise.all(varianten.map((v) => leesEventsVoorVariant(db, v, startIso, eindIso, deadline, gedragOpts))),
        leesGekoppeldeLeadIds(db, leadIds),
      ]);
      gekoppeld = gek;
      // Gedrag is aanvullend: een leesfout hier maakt de funnel niet stuk.
      for (const r of gedragPerVariant) {
        gedragEvents = gedragEvents.concat(r.rijen);
        if (r.afgekapt) afgekapt = true;
        if (r.fout) console.error('[funnel-stats] gedrag-events fout:', r.fout);
      }
      for (const r of perVariant) {
        events = events.concat(r.rijen);
        if (r.afgekapt) afgekapt = true;
        if (r.fout && !leesfout) { leesfout = r.fout; console.error('[funnel-stats] events fout:', r.fout); }
      }
    }

    const agg = aggregeerFunnelStats({
      events, gedragEvents, leads: leadsRes.data || [], boekingen: boekRes.data || [],
      gekoppeldeLeadIds: gekoppeld, varianten,
      start: periode.start, eindExclusief: periode.eindExclusief, trackingActief,
    });

    return res.status(200).json({
      periode: { van: periode.van, tot: periode.tot, start: startIso, eind_exclusief: eindIso, tijdzone: 'Europe/Amsterdam' },
      varianten,
      per_variant: agg.per_variant,
      meta: {
        tracking_actief: trackingActief,
        tabel_bestaat: tabelBestaat,
        eerste_event_ts: eersteEventTs,
        events_gelezen: events.length,
        events_genegeerd: agg.events_genegeerd,
        gedrag_events_gelezen: gedragEvents.length,
        afgekapt,
        max_events_per_variant: MAX_EVENTS_PER_VARIANT,
        fase_telling: 'bereik — een sessie telt voor een fase als dat event in de periode voorkomt, ongeacht eerdere fases',
        geboekt_bron: 'opstartsessie_submissions (booking_source = variant, met appointment_id, created_at in periode)',
        blinde_vlekken: bepaalBlindeVlekken({
          tabelBestaat, eersteEventTs, start: periode.start, afgekapt,
          maxEvents: MAX_EVENTS_PER_VARIANT, leesfout,
        }),
      },
    });
  } catch (e) {
    console.error('[funnel-stats]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
