// api/call-rapport.js
//
// GET → het dagelijkse call-rapport: per closer (en daaronder per setter)
// hoeveel calls er die dag waren, hoeveel er een uitkomst kregen, de verdeling
// over de categorieën en welke calls nog geen uitkomst hebben.
//
//   /api/call-rapport?dag=YYYY-MM-DD      (zonder dag: vandaag in Amsterdam)
//
// 'Elke dag een rapport' is hier een LIVE optelling, geen cron en geen
// opgeslagen momentopname: wie de dag opent ziet de stand van nu. Nieuw
// endpoint, puur lezend; het raakt geen bestaande route aan.
//
// ═══════════════════════════════════════════════════════════════════════════
// WAT HIER NIET OPNIEUW BEDACHT WORDT
// ═══════════════════════════════════════════════════════════════════════════
// - Welke afspraken meetellen en welke dubbel beeld zijn: relevanteAfspraken,
//   callStaat, bouwZoomcalls en groepeerDubbele uit api/opvolging-rapport.js.
//   Ongewijzigd hergebruikt; een tweede definitie van 'een call die telt' zou
//   vroeg of laat een ander getal geven dan het Salesrapport.
// - Wat een uitkomst betekent (Sale / Opvolgen / No show / …):
//   api/_lib/call-uitkomst-categorie.js. Het scherm leest labels en kleuren
//   uit de browser-jas daarvan; hier komen alleen de keys vandaan.
// - Wie een verzette call boekte: api/_lib/setter-keten.js (setterUitKeten).
// - Vanaf welke dag er gerapporteerd wordt: api/_lib/call-rapportage-start.js.
//
// ═══════════════════════════════════════════════════════════════════════════
// ÉÉN BEWUSTE AANVULLING OP relevanteAfspraken
// ═══════════════════════════════════════════════════════════════════════════
// relevanteAfspraken houdt alleen 'gepland' en 'te_beoordelen' over, dus valt
// elke rij met status 'cancelled' weg. Maar de uitkomstmotor ZET 'cancelled'
// bij wilt_niet_meer en niet_geschikt — een gesprek dat wél gevoerd is. Zonder
// aanvulling zou dit rapport precies de calls met 'Geen interesse' en 'Niet
// gekwalificeerd' kwijtraken. Daarom telt een rij met een INHOUDELIJKE uitkomst
// (categorieVoorUitkomst ≠ null) altijd mee — behalve als het een verzette
// voorganger is waarvan de opvolger op dezelfde dag staat: die blijft dubbel
// beeld, net als in het Salesrapport.
//
// Wat daarna nog overblijft (geannuleerd zonder uitkomst, verzet naar een
// andere dag, wacht op een nieuw moment) is geen call van die dag. Het staat
// apart onder `niet_meegeteld`, met rijen, zodat het niet stil verdwijnt.
//
// RECHTEN: calls.rapport.view, strikt (requirePermission, geen terugval). Een
// eigen sleutel en niet opvolging.rapport.view: die staat voor sales op true
// (Dave ziet zijn eigen Salesrapport), terwijl dit rapport ALLE closers en de
// setters naast elkaar zet. Zie docs/sql-migrations/2026-10-01-call-rapport.sql.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { relevanteAfspraken, bouwZoomcalls, groepeerDubbele } from './opvolging-rapport.js';
import {
  CATEGORIE_KEYS, categorieVoorAfspraak, categorieVoorUitkomst,
} from './_lib/call-uitkomst-categorie.js';
import { setterUitKeten, MAX_KETEN_DIEPTE } from './_lib/setter-keten.js';
import { leesCallRapportageStart, STANDAARD_STARTDATUM } from './_lib/call-rapportage-start.js';
import { nlDateString, _internals as nlIntern } from './_lib/nl-period.js';

export const CALL_RAPPORT_PERMISSIE = 'calls.rapport.view';

const ZONE = 'Europe/Amsterdam';
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

const APPT_KOLOMMEN = 'id, lead_name, lead_email, lead_phone, scheduled_at, duration_minutes, status, '
  + 'uitkomst, uitkomst_op, snelle_notitie, owner_id, setter_user_id, booking_source, '
  + 'parent_appointment_id, is_test';

/** Een echte kalenderdag, niet alleen het juiste patroon (2026-02-30 niet). */
export function isGeldigeDag(s) {
  if (typeof s !== 'string' || !DATUM_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** [begin, eind) van een Amsterdamse kalenderdag, als ISO-strings in UTC. */
export function dagGrenzen(dag) {
  const [y, m, d] = dag.split('-').map(Number);
  return {
    vanIso: nlIntern.nlLocalToUtc(y, m, d, 0, 0).toISOString(),
    totIso: nlIntern.nlLocalToUtc(y, m, d + 1, 0, 0).toISOString(),
  };
}

/** De Amsterdamse kalenderdag van een tijdstip, of null. */
function nlDag(ts) {
  const ms = ts == null ? NaN : Date.parse(ts);
  return Number.isFinite(ms) ? nlDateString(new Date(ms)) : null;
}

/** Uur:minuut in Amsterdam. */
function nlTijd(ts) {
  const ms = ts == null ? NaN : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms));
}

const legeTelling = () => Object.fromEntries(CATEGORIE_KEYS.map((k) => [k, 0]));

// ═══════════════════════════════════════════════════════════════════════════
// HET REKENWERK — puur, geen databank
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Het call-rapport van één dag.
 *
 * @param {object}   p
 * @param {string}   p.dag         YYYY-MM-DD (Amsterdam)
 * @param {string}   p.vandaag     YYYY-MM-DD (Amsterdam)
 * @param {string}   p.startdatum  eerste dag die meetelt
 * @param {object[]} p.afspraken   rijen van follow_up_appointments op die dag
 * @param {Set<string>} p.opvolgerVan ids waarvoor ergens een opvolger bestaat
 *                                 (parent_appointment_id = id), ook buiten de dag
 * @param {object[]} p.ketenRijen  voorgangers buiten de dag (id,
 *                                 parent_appointment_id, setter_user_id) om de
 *                                 setter van oude, niet-gebackfillde rijen te vinden
 * @param {Map<string,string>} p.namen profiel-id → weergavenaam
 * @param {number}   p.nuMs
 * @param {object[]} p.blindeVlekken wat er niet gelezen kon worden (doorgegeven)
 */
export function bouwCallRapport({
  dag, vandaag, startdatum = STANDAARD_STARTDATUM,
  afspraken = [], opvolgerVan = new Set(), ketenRijen = [],
  namen = new Map(), nuMs = Date.now(), blindeVlekken = [],
}) {
  const kop = {
    dag, vandaag, startdatum,
    dag_loopt_nog: dag === vandaag,
    in_toekomst  : dag > vandaag,
  };

  // VÓÓR DE STARTDATUM GEEN GETALLEN. Een oude call zonder uitkomst is geen
  // achterstand; een nul of een rood getal zou dat wel suggereren.
  if (dag < startdatum) {
    return {
      ...kop,
      voor_startdatum: true,
      melding: 'Deze dag valt vóór de startdatum van de call-rapportage (' + startdatum + '). '
        + 'Calls van vóór die dag tellen niet mee; een ontbrekende uitkomst daar is geen achterstand.',
      totaal: null, closers: [], setters: [], dubbele_afspraken: [],
      blinde_vlekken: [],
    };
  }

  const alle = (afspraken || []).filter(Boolean);
  // Testrijen tellen nergens mee. Rijen vóór de startdatum ook niet — de query
  // vraagt al één dag op, dit is de verdediging voor wie dat ooit verruimt.
  const testUitgesloten = alle.filter((a) => a.is_test === true).length;
  const echte = alle.filter((a) => a.is_test !== true && (nlDag(a.scheduled_at) || '') >= startdatum);

  // ── Welke rijen tellen ───────────────────────────────────────────────────
  const opvolgerHier = new Set(echte.map((a) => a.parent_appointment_id).filter(Boolean).map(String));
  const dubbelBeeld = (a) => String(a.status || '') === 'verplaatst' && opvolgerHier.has(String(a.id));
  const basis = new Set(relevanteAfspraken(echte, nuMs).map((a) => String(a.id)));
  const telt = (a) => basis.has(String(a.id))
    || (categorieVoorUitkomst(a.uitkomst) !== null && !dubbelBeeld(a));

  const relevant = echte.filter(telt);
  // Verzette voorgangers met hun opvolger op dezelfde dag zijn dubbel beeld en
  // horen nergens; de rest van wat niet telt staat apart, met naam.
  const nietMeegeteld = echte.filter((a) => !telt(a) && !dubbelBeeld(a));

  // ── Per rij: categorie, closer, setter ───────────────────────────────────
  const heeftOpvolger = new Set([...(opvolgerVan || [])].map(String));
  for (const id of opvolgerHier) heeftOpvolger.add(id);

  const perId = new Map();
  for (const r of ketenRijen || []) if (r && r.id != null) perId.set(String(r.id), r);
  for (const a of alle) perId.set(String(a.id), a);

  const naamVan = (id) => (id ? (namen.get(String(id)) || null) : null);

  const maakRij = (a) => {
    const keten = setterUitKeten(a, perId);
    const setterId = keten ? keten.setter_user_id : null;
    return {
      appointment_id: a.id,
      naam          : a.lead_name || null,
      tijd          : nlTijd(a.scheduled_at),
      scheduled_at  : a.scheduled_at || null,
      status        : String(a.status || 'scheduled'),
      uitkomst      : a.uitkomst || null,
      uitkomst_op   : a.uitkomst_op || null,
      categorie     : categorieVoorAfspraak(a, { nuMs, heeftOpvolger: heeftOpvolger.has(String(a.id)) }),
      vastgelegd    : categorieVoorUitkomst(a.uitkomst) !== null,
      owner_id      : a.owner_id || null,
      closer_naam   : naamVan(a.owner_id),
      setter_user_id: setterId,
      setter_naam   : naamVan(setterId),
      // De setter staat niet op de rij zelf maar op een voorganger (verzet
      // vóór 1 oktober, nog niet gebackfilld).
      setter_via_keten: !!keten && keten.diepte > 0,
      snelle_notitie: a.snelle_notitie || null,
      // Heet hier voorganger_id, met opzet niet zoals de kolom: dit is een
      // rapportregel, geen afspraakrij. tests/setter-keten.test.js zoekt naar
      // plekken die een opvolger MAKEN, en daar hoort dit bestand niet bij.
      voorganger_id : a.parent_appointment_id || null,
    };
  };

  const rijen = relevant.map(maakRij);
  const nietRijen = nietMeegeteld.map(maakRij);

  // ── Optellen ─────────────────────────────────────────────────────────────
  const telOp = (lijst) => {
    const per = legeTelling();
    let vastgelegd = 0;
    for (const r of lijst) {
      per[r.categorie] = (per[r.categorie] || 0) + 1;
      if (r.vastgelegd) vastgelegd += 1;
    }
    return {
      calls: lijst.length,
      vastgelegd,
      nog_niet_vastgelegd: per.nog_niet_vastgelegd,
      gepland: per.gepland,
      per_categorie: per,
    };
  };

  const groepeer = (lijst, sleutel) => {
    const m = new Map();
    for (const r of lijst) {
      const k = sleutel(r) || '';
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const sorteer = (a, b) => (b.calls - a.calls)
    || String(a.naam || '').localeCompare(String(b.naam || ''), 'nl');

  const perCloser = groepeer(rijen, (r) => r.owner_id);
  const nietPerCloser = groepeer(nietRijen, (r) => r.owner_id);
  const closerIds = new Set([...perCloser.keys(), ...nietPerCloser.keys()]);
  const closers = [...closerIds].map((k) => {
    const eigen = perCloser.get(k) || [];
    const niet = nietPerCloser.get(k) || [];
    const t = telOp(eigen);
    return {
      owner_id: k || null,
      naam    : k ? (naamVan(k) || 'Onbekende gebruiker') : 'Geen closer toegewezen',
      ...t,
      // Elk getal draagt zijn rijen (zie de kop van api/opvolging-rapport.js).
      open : eigen.filter((r) => r.categorie === 'nog_niet_vastgelegd'),
      rijen: eigen,
      niet_meegeteld: { aantal: niet.length, per_categorie: telOp(niet).per_categorie, rijen: niet },
    };
  }).sort(sorteer);

  const perSetter = groepeer(rijen, (r) => r.setter_user_id);
  const setters = [...perSetter.entries()].map(([k, lijst]) => ({
    setter_user_id: k || null,
    naam    : k ? (naamVan(k) || 'Onbekende gebruiker') : 'Geen setter bekend',
    ...telOp(lijst),
    via_keten: lijst.filter((r) => r.setter_via_keten).length,
  })).sort(sorteer);

  // Dubbele boekingen (dezelfde persoon twee keer op die dag, geen van beide
  // verzet). Ze tellen allebei mee; de melding zegt dat het er twee zijn.
  const dubbele = groepeerDubbele(bouwZoomcalls({ afspraken: relevant, uitkomstKolommen: true, nuMs }));

  return {
    ...kop,
    voor_startdatum: false,
    melding: null,
    totaal: {
      ...telOp(rijen),
      niet_meegeteld  : nietRijen.length,
      test_uitgesloten: testUitgesloten,
    },
    closers,
    setters,
    dubbele_afspraken: dubbele,
    blinde_vlekken: blindeVlekken || [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// LEZEN
// ═══════════════════════════════════════════════════════════════════════════

/** Alles wat bouwCallRapport voor één dag nodig heeft. Alleen SELECTs. */
export async function leesDag(db, dag) {
  const { vanIso, totIso } = dagGrenzen(dag);
  const blindeVlekken = [];

  const { data: apptRuw, error: e1 } = await db
    .from('follow_up_appointments')
    .select(APPT_KOLOMMEN)
    .gte('scheduled_at', vanIso).lt('scheduled_at', totIso)
    .order('scheduled_at', { ascending: true });
  if (e1) throw e1;
  const afspraken = apptRuw || [];
  const ids = afspraken.map((a) => String(a.id));

  // ── Opvolgers, ook buiten de dag ─────────────────────────────────────────
  // Een call die naar volgende week verzet is, heet 'Nieuw moment ingepland' —
  // dat staat in categorieVoorAfspraak, maar die moet dan wel weten dát er een
  // opvolger is.
  const opvolgerVan = new Set();
  if (ids.length) {
    const { data, error } = await db
      .from('follow_up_appointments')
      .select('id, parent_appointment_id')
      .in('parent_appointment_id', ids);
    if (error) {
      blindeVlekken.push({
        wat   : 'Of een call naar een andere dag verzet is, kon niet gelezen worden.',
        waarom: error.message,
      });
    } else {
      for (const r of data || []) if (r.parent_appointment_id) opvolgerVan.add(String(r.parent_appointment_id));
    }
  }

  // ── De setterketen, per ronde één query ──────────────────────────────────
  // Voor rijen zonder setter_user_id die een voorganger hebben. Batchgewijs in
  // plaats van haalSetterViaKeten per rij: dezelfde regel (setterUitKeten),
  // zonder een query per call.
  const bekend = new Set(ids);
  const ketenRijen = [];
  let teZoeken = [...new Set(afspraken
    .filter((a) => !a.setter_user_id && a.parent_appointment_id && !bekend.has(String(a.parent_appointment_id)))
    .map((a) => String(a.parent_appointment_id)))];
  for (let ronde = 0; teZoeken.length && ronde < MAX_KETEN_DIEPTE; ronde += 1) {
    const { data, error } = await db
      .from('follow_up_appointments')
      .select('id, parent_appointment_id, setter_user_id, booking_source')
      .in('id', teZoeken);
    if (error) {
      blindeVlekken.push({
        wat   : 'Bij verzette calls kon de setter van de oorspronkelijke boeking niet gelezen worden.',
        waarom: error.message,
      });
      break;
    }
    const volgende = [];
    for (const r of data || []) {
      const id = String(r.id);
      if (bekend.has(id)) continue;
      bekend.add(id);
      ketenRijen.push(r);
      if (!r.setter_user_id && r.parent_appointment_id && !bekend.has(String(r.parent_appointment_id))) {
        volgende.push(String(r.parent_appointment_id));
      }
    }
    teZoeken = [...new Set(volgende)];
  }

  // ── Namen ────────────────────────────────────────────────────────────────
  const perId = new Map([...ketenRijen, ...afspraken].map((r) => [String(r.id), r]));
  const profielIds = new Set();
  for (const a of afspraken) {
    if (a.owner_id) profielIds.add(String(a.owner_id));
    const k = setterUitKeten(a, perId);
    if (k && k.setter_user_id) profielIds.add(String(k.setter_user_id));
  }
  const namen = new Map();
  if (profielIds.size) {
    const { data, error } = await db
      .from('profiles')
      .select('id, full_name, email')
      .in('id', [...profielIds]);
    if (error) {
      blindeVlekken.push({ wat: 'De namen van closers en setters konden niet gelezen worden.', waarom: error.message });
    } else {
      for (const p of data || []) namen.set(String(p.id), p.full_name || p.email || null);
    }
  }

  return { afspraken, opvolgerVan, ketenRijen, namen, blindeVlekken };
}

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Strikt, geen terugval op opvolging.rapport.view: zie de kop.
  const allowed = await requirePermission(req, CALL_RAPPORT_PERMISSIE);
  if (!allowed) {
    return res.status(403).json({
      error: 'Geen rechten (' + CALL_RAPPORT_PERMISSIE + ')',
      hint : 'Super_admin heeft hem altijd; andere rollen via docs/sql-migrations/2026-10-01-call-rapport.sql.',
    });
  }

  const q = req.query || {};
  const vandaag = nlDateString(new Date());
  const dagRuw = q.dag == null ? '' : String(q.dag);
  if (dagRuw && !isGeldigeDag(dagRuw)) {
    return res.status(400).json({ error: 'dag ongeldig (verwacht YYYY-MM-DD)' });
  }
  const dag = dagRuw || vandaag;

  try {
    const startdatum = await leesCallRapportageStart(supabaseAdmin);
    // Vóór de startdatum valt er niets te lezen: geen query, alleen de melding.
    if (dag < startdatum) {
      return res.status(200).json(bouwCallRapport({ dag, vandaag, startdatum }));
    }
    const gelezen = await leesDag(supabaseAdmin, dag);
    return res.status(200).json(bouwCallRapport({
      dag, vandaag, startdatum, nuMs: Date.now(), ...gelezen,
    }));
  } catch (e) {
    console.error('[call-rapport]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
