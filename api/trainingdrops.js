// api/trainingdrops.js
//
// GET → alle wekelijkse training-drops (variant/bron 'training-<dd-mm-jj>',
// dfo-website /training/<dd-mm-jj> en training.deforexopleiding.nl/<dd-mm-jj>)
// met bezoekers, formulier gestart, leads, conversie en leads per kanaal, plus
// per drop de leadlijst. Nieuwste bovenaan. Voor de module Trainingdrops.
//
// Puur LEZEN uit bestaande tabellen: leads + funnel_events + (cadeau, dfo-website
// #132) follow_up_appointments met booking_source 'training-*' en de koppeling
// opstartsessie_submissions.appointment_id → lead_id. Geen schema, geen
// schrijfacties. Aggregatie in api/_lib/trainingdrops-compute.js.
//
// Response 200:
//   { drops:[{ variant, slug, label, datum, links:{live,site,pagina},
//       bezoekers, formulier_gestart, gegevens_ok, lead_ingediend, leads,
//       conversie_pct, formulier_pct, test_leads, test_sessies,
//       cadeau_getoond, cadeau_klik, calls, calls_gepland, calls_gehouden,
//       calls_no_show, calls_geannuleerd, leads_met_call, lead_call_pct,
//       kanalen:[{kanaal,label,bezoekers,leads,cadeau_klik,calls,gepland,gehouden,no_show,geannuleerd,lead_call_pct}],
//       leads_per_kanaal:[{kanaal,label,n}], bezoekers_per_kanaal:[…],
//       lead_lijst:[{id,naam,email,telefoon,status,campagne,huidige_bron,
//         bron_elders,kanaal,kanaal_label,aangemeld_op,lead_aangemaakt,
//         call:{scheduled_at,status,categorie,label}|null,test}] }],
//     totaal:{drops,bezoekers,formulier_gestart,leads,conversie_pct},
//     meta:{ tracking_actief, events_gelezen, afgekapt, kanaal_uitleg, leesfout, calls_fout } }
//
// FAIL-SOFT: bestaat funnel_events niet of faalt het lezen, dan komen de drops
// alleen uit de leads (bezoekers 0, tracking_actief false).
//
// Permission: leads.view (strict) — dezelfde als de leadlijst en funnel-stats.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bouwTrainingdrops, FASE_TYPES, KANAAL_UITLEG } from './_lib/trainingdrops-compute.js';
import { isTrainingBron, TRAINING_BRON_PREFIXEN } from './_lib/training-bron.js';

export const PAGINA = 1000;
export const MAX_EVENTS = 50000;
export const TIJDBUDGET_MS = 20000;
const LEAD_KOLOMMEN = 'id,voornaam,achternaam,email,telefoon,bron,campagne,status,kwalificatie,aangemaakt,laatste_aanmelding';
// meta->>… als losse kolommen: de hele meta (gedrag) is hier niet nodig.
const EVENT_KOLOMMEN = 'id,session_id,variant,event_type,ts,lead_id,src:meta->>src,utm:meta->>utm_source';
const AFSPRAAK_KOLOMMEN = 'id,booking_source,scheduled_at,status,lead_email,is_test,parent_appointment_id,created_at';

function isOntbrekendeTabel(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return /could not find the table|does not exist/i.test(String(err.message || ''));
}

async function leesEvents(db, deadline) {
  const rijen = [];
  let afgekapt = false;
  // Per prefix (training-%, drop-%) apart pagineren op id.
  for (const prefix of TRAINING_BRON_PREFIXEN) {
    let laatsteId = null;
    for (;;) {
      if (Date.now() > deadline) { afgekapt = true; break; }
      let q = db.from('funnel_events').select(EVENT_KOLOMMEN)
        .like('variant', prefix + '%')
        .in('event_type', FASE_TYPES);
      if (laatsteId != null) q = q.gt('id', laatsteId);
      const { data, error } = await q.order('id', { ascending: true }).limit(PAGINA);
      if (error) return { rijen, afgekapt, fout: error };
      const page = data || [];
      rijen.push(...page);
      if (page.length < PAGINA) break;
      laatsteId = page[page.length - 1].id;
      if (rijen.length >= MAX_EVENTS) { afgekapt = true; break; }
    }
    if (afgekapt) break;
  }
  return { rijen: rijen.filter((e) => isTrainingBron(e.variant)), afgekapt, fout: null };
}

/** Leads die via een training-sessie of -call gekoppeld zijn maar (inmiddels) een andere bron hebben. */
async function leesExtraLeads(db, waarden, kolom = 'id') {
  const uit = [];
  for (let i = 0; i < waarden.length; i += 200) {
    const { data, error } = await db.from('leads').select(LEAD_KOLOMMEN)
      .in(kolom, waarden.slice(i, i + 200)).is('verwijderd_op', null).limit(1000);
    if (error) { console.error('[trainingdrops] extra leads fout:', error.message); continue; }
    uit.push(...(data || []));
  }
  return uit;
}

/**
 * De cadeau-calls (strategiesessie met Dave) van alle trainingen + de lead-koppeling.
 * Fail-soft: een fout hier laat de rest van de drops staan (meta.calls_fout).
 */
async function leesCalls(db) {
  const data = [];
  for (const prefix of TRAINING_BRON_PREFIXEN) {
    const { data: d, error } = await db.from('follow_up_appointments').select(AFSPRAAK_KOLOMMEN)
      .like('booking_source', prefix + '%').limit(10000);
    if (error) return { afspraken: [], koppelingen: [], fout: error.message || String(error) };
    data.push(...(d || []));
  }
  const afspraken = data.filter((a) => isTrainingBron(a.booking_source));
  const koppelingen = [];
  const ids = afspraken.map((a) => a.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data: k, error: kErr } = await db.from('opstartsessie_submissions').select('appointment_id,lead_id')
      .in('appointment_id', ids.slice(i, i + 200)).limit(1000);
    if (kErr) { console.error('[trainingdrops] koppelingen fout:', kErr.message); continue; }
    koppelingen.push(...(k || []));
  }
  return { afspraken, koppelingen, fout: null };
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

  const deadline = Date.now() + TIJDBUDGET_MS;
  try {
    const db = supabaseAdmin;
    const leesLeads = async () => {
      const data = [];
      for (const prefix of TRAINING_BRON_PREFIXEN) {
        const r = await db.from('leads').select(LEAD_KOLOMMEN)
          .like('bron', prefix + '%').is('verwijderd_op', null)
          .order('aangemaakt', { ascending: false }).limit(10000);
        if (r.error) return { data: null, error: r.error };
        data.push(...(r.data || []));
      }
      return { data, error: null };
    };
    const [leadsRes, ev, cl] = await Promise.all([
      leesLeads(),
      leesEvents(db, deadline).catch((e) => ({ rijen: [], afgekapt: false, fout: { message: e?.message || String(e) } })),
      leesCalls(db).catch((e) => ({ afspraken: [], koppelingen: [], fout: e?.message || String(e) })),
    ]);
    if (cl.fout) console.error('[trainingdrops] calls fout:', cl.fout);
    if (leadsRes.error) throw new Error('leads: ' + leadsRes.error.message);

    let leesfout = null;
    let trackingActief = true;
    if (ev.fout) {
      trackingActief = false;
      if (!isOntbrekendeTabel(ev.fout)) {
        leesfout = ev.fout.message || String(ev.fout);
        console.error('[trainingdrops] funnel_events fout:', leesfout);
      }
    }
    const events = ev.fout ? [] : ev.rijen;

    const leads = (leadsRes.data || []).filter((l) => isTrainingBron(l.bron));
    const bekend = new Set(leads.map((l) => l.id));
    const ontbrekend = [...new Set([...events.map((e) => e.lead_id), ...cl.koppelingen.map((k) => k.lead_id)]
      .filter((id) => id && !bekend.has(id)))];
    if (ontbrekend.length) leads.push(...await leesExtraLeads(db, ontbrekend));
    // Calls zonder koppeling: de lead op e-mailadres (upsert_lead bewaart e-mail in kleine letters).
    const gekoppeld = new Set(cl.koppelingen.map((k) => k.appointment_id));
    const bekendeMails = new Set(leads.map((l) => String(l.email || '').toLowerCase()));
    const mails = [...new Set(cl.afspraken.filter((a) => !gekoppeld.has(a.id) && a.lead_email)
      .map((a) => String(a.lead_email).toLowerCase()).filter((m) => !bekendeMails.has(m)))];
    if (mails.length) leads.push(...await leesExtraLeads(db, mails, 'email'));

    const { drops, totaal } = bouwTrainingdrops({ leads, events, afspraken: cl.afspraken, koppelingen: cl.koppelingen });
    return res.status(200).json({
      drops,
      totaal,
      meta: {
        tracking_actief: trackingActief,
        events_gelezen: events.length,
        afgekapt: !!ev.afgekapt,
        kanaal_uitleg: KANAAL_UITLEG,
        leesfout,
        calls_fout: cl.fout || null,
      },
    });
  } catch (e) {
    console.error('[trainingdrops]', e?.message);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
