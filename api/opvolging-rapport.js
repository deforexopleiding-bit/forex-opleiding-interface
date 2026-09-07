// api/opvolging-rapport.js
//
// GET → het dagrapport van de module Opvolging (item R).
//
//   /api/opvolging-rapport?van=YYYY-MM-DD&tot=YYYY-MM-DD
//
// Nieuw endpoint. Puur additief: het raakt geen bestaande route aan en leest
// uit opvolging_taken, opvolging_pogingen en follow_up_appointments.
//
// ═══════════════════════════════════════════════════════════════════════════
// HET UITGANGSPUNT: DIT RAPPORT GAAT OVER EEN PERSOON
// ═══════════════════════════════════════════════════════════════════════════
// Elk getal hier wordt een gesprek tussen Maxim en Dave. Een cijfer dat niet
// klopt kost niet alleen zichzelf maar de geloofwaardigheid van het hele
// rapport. Daaruit volgen vier regels die dit bestand overal aanhoudt:
//
//   1. GEEN GETAL DAT NIET UIT EEN TIJDSTEMPEL VOLGT. Geen rapportcijfers,
//      geen procentscores op iemands werk, geen opgetelde geschatte werktijd.
//      Wel echte gespreksseconden uit duur_sec, want die zijn gemeten.
//
//   2. REKEN UIT GEBEURTENISSEN, NIET UIT DE HUIDIGE STAND. Een rapport over
//      dinsdag moet in oktober nog steeds dinsdag tonen. Waar we alleen de
//      huidige stand hebben en geen moment, staat dat er bij — zie
//      `blinde_vlekken`.
//
//   3. ELK GETAL DRAAGT ZIJN RIJEN. Dit endpoint geeft rijen terug en telt die
//      zelf; het scherm klapt ze uit onder het getal. Ziet Maxim vier van de
//      zes, dan moet hij kunnen zien welke twee. Zonder dat is het rapport een
//      mening.
//
//   4. STILTE IS GEEN GOEDKEURING. Een sectie met een blinde vlek meldt dat in
//      `aandacht`. Een lege aandachtlijst mag alleen leeg zijn als er echt
//      niets is — anders leest 'geen afwijkingen' als 'alles in orde' terwijl
//      er niet gekeken kon worden.
//
// ═══════════════════════════════════════════════════════════════════════════
// WAT ER NIET GETELD WORDT, EN WAAROM DAT ELDERS STAAT
// ═══════════════════════════════════════════════════════════════════════════
// Wat als moeite van Dave telt en wat als echt contact telt komt uit
// api/_lib/opvolging-poging-telling.js (isMoeite / isContact). Die twee vragen
// worden hier NIET opnieuw beantwoord. Op 6 september stonden er drie
// definities van 'echt contact' naast elkaar en draaide de slechtste; dit is
// de reden dat er nog maar één is. Zelfde voor de twee vensters en de
// archiveerdrempel: api/_lib/opvolging-vensters.js.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { isMoeite, isContact, WA_SOORTEN } from './_lib/opvolging-poging-telling.js';
import {
  beoordeelDag, telVensters, beoordeelMoeite, dagVan,
  SPRAAK_DEADLINE_UUR, NABEL_VAN_UUR, NABEL_TOT_UUR,
  ARCHIEF_MIN_DAGEN, ARCHIEF_MIN_WA,
} from './_lib/opvolging-vensters.js';

const ZONE     = 'Europe/Amsterdam';
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAGEN = 62;   // twee maanden; ruim genoeg voor 'vorige week' en een eigen reeks
// Zoveel leads-met-telefoonnummer halen we op om de zoomcalls aan te koppelen.
// Ruim boven de omvang van de takenpot; wordt hij ooit groter, dan meldt het
// rapport dat als blinde vlek in plaats van stil koppelingen te missen.
const TAKEN_LIMIET = 5000;

// ── Tijdrekenen in Amsterdam ───────────────────────────────────────────────
// Zelfde constructie als api/opvolging-agenda.js: expliciete UTC plus de
// offset op díe datum, zodat de zomertijdgrens geen uur verschuift.
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

function vandaagNL() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function dagenTussen(van, tot) {
  const uit = [];
  let ms = zoneMiddernachtMs(van);
  const eind = zoneMiddernachtMs(tot);
  if (!Number.isFinite(ms) || !Number.isFinite(eind) || eind < ms) return uit;
  for (let i = 0; i <= MAX_DAGEN && ms <= eind; i++) {
    uit.push(dagVan(ms + 12 * 3600 * 1000));
    ms += 24 * 3600 * 1000;
  }
  return uit;
}

/** Alleen cijfers. Zie CLAUDE.md lesson 18 over telefoonnummers. */
const telCijfers = (s) => String(s == null ? '' : s).replace(/\D/g, '');

/** Het uur:minuut van een tijdstip in Amsterdam. */
function tijdVan(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  });
  return dtf.format(new Date(ms));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // EIGEN SLEUTEL, GEEN STILLE TERUGVAL. Ontbreekt opvolging.rapport.view in
  // role_permissions, dan is dit een 403 en geen 200 met minder gegevens. Zou
  // dit terugvallen op opvolging.module.access, dan zou een beheerder die het
  // rapport uitzet niets zien gebeuren — en dat is precies het soort stille
  // terugval waar deze module drie keer op is vastgelopen. Deel 2 van
  // docs/sql-migrations/2026-09-06-opvolging-rapport.sql zet de rijen.
  const allowed = await requirePermission(req, 'opvolging.rapport.view');
  if (!allowed) {
    return res.status(403).json({
      error: 'Geen rechten (opvolging.rapport.view)',
      hint : 'Staat de sleutel al in role_permissions? Zie docs/sql-migrations/2026-09-06-opvolging-rapport.sql deel 2.',
    });
  }

  const q = req.query || {};
  const vandaag = vandaagNL();
  const van = DATUM_RE.test(String(q.van || '')) ? String(q.van) : vandaag;
  const tot = DATUM_RE.test(String(q.tot || '')) ? String(q.tot) : van;

  const dagen = dagenTussen(van, tot);
  if (dagen.length === 0) return res.status(400).json({ error: 'van/tot ongeldig (verwacht YYYY-MM-DD, tot >= van)' });
  if (dagen.length > MAX_DAGEN) return res.status(400).json({ error: `Periode te lang (max ${MAX_DAGEN} dagen)` });

  const vanMs = zoneMiddernachtMs(van);
  const totMs = zoneMiddernachtMs(dagen[dagen.length - 1]) + 24 * 3600 * 1000;
  const vanIso = new Date(vanMs).toISOString();
  const totIso = new Date(totMs).toISOString();

  try {
    const rapport = await bouwRapport({
      supabase, van, tot: dagen[dagen.length - 1], dagen, vandaag, vanIso, totIso,
    });
    return res.status(200).json(rapport);
  } catch (e) {
    console.error('[opvolging-rapport]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HET REKENWERK
// ═══════════════════════════════════════════════════════════════════════════

async function bouwRapport({ supabase, van, tot, dagen, vandaag, vanIso, totIso }) {
  const blindeVlekken = [];
  const aandacht = [];

  // ── De pogingen in de periode ────────────────────────────────────────────
  // Dit is de enige bron die per definitie een gebeurtenis is: elke rij heeft
  // een tijdstip en wordt nooit overschreven.
  const { data: pogRuw, error: e1 } = await supabaseAdmin
    .from('opvolging_pogingen')
    .select('id, taak_id, soort, tijdstip, resultaat, richting, duur_sec, automatisch')
    .gte('tijdstip', vanIso).lt('tijdstip', totIso)
    .order('tijdstip', { ascending: true });
  if (e1) throw e1;
  const pogingen = pogRuw || [];

  // ── De kaarten die in de periode dicht gingen ────────────────────────────
  // gearchiveerd_at is een echt moment en wordt op alle archiveerpaden gezet.
  const { data: archRuw, error: e2 } = await supabaseAdmin
    .from('opvolging_taken')
    .select('id, naam, telefoon, reden, reden_code, archief_reden, gearchiveerd_at, created_at')
    .eq('status', 'gearchiveerd')
    .gte('gearchiveerd_at', vanIso).lt('gearchiveerd_at', totIso)
    .order('gearchiveerd_at', { ascending: true });
  if (e2) throw e2;
  const gearchiveerd = archRuw || [];

  // ── De zoomcalls van de periode ──────────────────────────────────────────
  // scheduled_at is het moment waarop de call stond. Dat verandert niet met
  // terugwerkende kracht, in tegenstelling tot `status`.
  const { data: apptRuw, error: e3 } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_phone, lead_email, scheduled_at, duration_minutes, status, snelle_notitie, uitkomst, uitkomst_op')
    .gte('scheduled_at', vanIso).lt('scheduled_at', totIso)
    .order('scheduled_at', { ascending: true });

  // Draait de migratie nog niet, dan bestaan uitkomst/uitkomst_op niet en
  // faalt de hele select. Eén keer opnieuw zonder die twee kolommen, en de
  // sectie meldt het als blinde vlek in plaats van als storing.
  let afspraken = [];
  let uitkomstKolommen = true;
  if (e3) {
    uitkomstKolommen = false;
    const { data: fallback, error: e3b } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, lead_name, lead_phone, lead_email, scheduled_at, duration_minutes, status, snelle_notitie')
      .gte('scheduled_at', vanIso).lt('scheduled_at', totIso)
      .order('scheduled_at', { ascending: true });
    if (e3b) throw e3b;
    afspraken = fallback || [];
    blindeVlekken.push({
      sectie: 'zoomcalls',
      wat   : 'De uitkomst van een zoomcall is voor deze periode nergens vastgelegd.',
      waarom: 'De kolommen uitkomst en uitkomst_op bestaan nog niet. Draai docs/sql-migrations/2026-09-06-opvolging-rapport.sql; vanaf dat moment wordt elke nieuwe uitkomst wel bewaard.',
    });
  } else {
    afspraken = apptRuw || [];
  }

  // ── De taken achter die pogingen en calls ────────────────────────────────
  const taakIds = new Set(pogingen.map((p) => p.taak_id).filter(Boolean));
  for (const a of gearchiveerd) taakIds.add(a.id);

  const { data: taakRuw, error: e4 } = taakIds.size
    ? await supabaseAdmin
        .from('opvolging_taken')
        .select('id, naam, telefoon, reden, reden_code, status, due, archief_reden, gearchiveerd_at')
        .in('id', [...taakIds])
    : { data: [], error: null };
  if (e4) throw e4;
  const taakVan = new Map((taakRuw || []).map((t) => [t.id, t]));

  // ── De taken achter de ZOOMCALLS, en waarom dat een tweede query is ──────
  // De set hierboven bevat alleen taken die in de periode een poging kregen of
  // dicht gingen. Een lead met een zoomcall die GEEN enkele poging kreeg zit er
  // dus niet in — en laat dat nou net de lead zijn die het rapport moet
  // aanwijzen. Zonder deze query zou zo iemand als 'call zonder taak' in de
  // niet-te-beoordelen hoek belanden, en dan telt zijn gemiste spraakbericht
  // nergens mee. Precies de stille onderrapportage waar dit rapport niet in mag
  // trappen: het cijfer dat ontbreekt is het cijfer dat ertoe doet.
  //
  // Koppelen gaat op telefoonnummer, en dat staat niet genormaliseerd in de
  // databank (met of zonder landcode, met of zonder spaties). Een WHERE op een
  // van die vormen mist de rest, dus halen we de nummers op en matchen we in JS
  // — zelfde regel als elders: strippen tot cijfers, exact, dan de laatste
  // negen, en alleen bij precies één treffer.
  let telefoonTaken = [];
  let telefoonAfgekapt = false;
  if (afspraken.length) {
    const { data, error: e4b } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, naam, telefoon')
      .not('telefoon', 'is', null)
      .limit(TAKEN_LIMIET);
    if (e4b) throw e4b;
    telefoonTaken = data || [];
    // Zit de lijst precies op de limiet, dan is hij waarschijnlijk afgekapt en
    // kunnen er koppelingen ontbreken. Dat melden we, in plaats van een
    // onvolledig vensteroordeel als volledig te presenteren.
    telefoonAfgekapt = telefoonTaken.length >= TAKEN_LIMIET;
    if (telefoonAfgekapt) {
      blindeVlekken.push({
        sectie: 'vensters',
        wat   : `De koppeling tussen zoomcalls en leads is mogelijk onvolledig.`,
        waarom: `Er zijn meer dan ${TAKEN_LIMIET} leads met een telefoonnummer; die lijst is afgekapt. Calls waarvan de lead buiten die lijst viel staan hieronder als niet-te-beoordelen.`,
      });
    }
  }
  // De twee sets samenvoegen op id, zodat een lead die in allebei zit één keer
  // meedoet en de rijkste versie wint.
  const alleTaken = [...taakVan.values()];
  for (const t of telefoonTaken) if (!taakVan.has(t.id)) alleTaken.push(t);

  // ── De volledige historiek van de gearchiveerde kaarten ──────────────────
  // De moeite naast een gearchiveerde lead telt over de HELE levensloop van
  // die kaart, niet over de periode: de vraag is of er genoeg gedaan was
  // vóórdat hij dicht ging. Een aparte query, want de periode-pogingen dekken
  // dat niet.
  let histPerTaak = new Map();
  if (gearchiveerd.length) {
    const { data: histRuw, error: e5 } = await supabaseAdmin
      .from('opvolging_pogingen')
      .select('taak_id, soort, tijdstip, resultaat, richting')
      .in('taak_id', gearchiveerd.map((a) => a.id));
    if (e5) throw e5;
    for (const p of histRuw || []) {
      if (!histPerTaak.has(p.taak_id)) histPerTaak.set(p.taak_id, []);
      histPerTaak.get(p.taak_id).push(p);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 6 · VOLUME
  // ═══════════════════════════════════════════════════════════════════════
  const volume = telVolume(pogingen, taakVan);
  if (volume.bel.zonder_duur > 0) {
    blindeVlekken.push({
      sectie: 'volume',
      wat   : `Van ${volume.bel.zonder_duur} van de ${volume.bel.uit} belpogingen is geen gespreksduur vastgelegd.`,
      waarom: 'duur_sec wordt alleen gevuld door calls die via de softphone-koppeling binnenkwamen. Een handmatig geregistreerde poging stuurt geen duur mee. De seconden hieronder gaan dus over een deel van de calls; er wordt geen gemiddelde over de rest geschat.',
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 2 · DEKKING
  // ═══════════════════════════════════════════════════════════════════════
  const dekking = await bouwDekking({ pogingen, taakVan, dagen, vandaag, blindeVlekken });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 3 · DE TWEE VENSTERS
  // ═══════════════════════════════════════════════════════════════════════
  const vensters = bouwVensters({ afspraken, taken: alleTaken, pogingen, dagen });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 4 · DE ZOOMCALLS ZELF
  // ═══════════════════════════════════════════════════════════════════════
  const zoomcalls = bouwZoomcalls({ afspraken, uitkomstKolommen, nuMs: Date.now() });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 5 · UIT DE LIJST GEHAALD
  // ═══════════════════════════════════════════════════════════════════════
  const archief = bouwArchief({ gearchiveerd, histPerTaak });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 1 · WAT VRAAGT AANDACHT
  // ═══════════════════════════════════════════════════════════════════════
  // Als laatste gebouwd, uit de vijf secties hierboven. Bewust afgeleid: een
  // afwijking die hier staat moet elders in het rapport terug te vinden zijn,
  // anders is het een mening zonder rijen eronder.
  // DE DAG IS NOG NIET AF. Bevat de periode vandaag, dan wordt hier een
  // onvoltooide dag beoordeeld. Dat mag, maar het moet erbij staan — anders
  // leest een half rapport als een heel rapport, en dat is bij een rapport over
  // een persoon het verschil tussen een gesprek en een verwijt.
  if (dagen.includes(vandaag)) {
    blindeVlekken.push({
      sectie: 'periode',
      wat   : 'De dag van vandaag loopt nog.',
      waarom: 'Wat hier staat is de stand van dit moment, niet het eindresultaat. Calls die nog moeten plaatsvinden staan als gepland en worden niet beoordeeld.',
    });
  }

  vulAandacht({ aandacht, blindeVlekken, dekking, vensters, zoomcalls, archief });

  return {
    periode: {
      van, tot, dagen: dagen.length, vandaag,
      bevat_verleden: dagen.some((d) => d < vandaag),
      bevat_vandaag : dagen.includes(vandaag),
    },
    drempels: {
      spraak_voor_uur: SPRAAK_DEADLINE_UUR,
      nabel_van_uur  : NABEL_VAN_UUR,
      nabel_tot_uur  : NABEL_TOT_UUR,
      archief_min_dagen: ARCHIEF_MIN_DAGEN,
      archief_min_wa   : ARCHIEF_MIN_WA,
    },
    aandacht,
    blinde_vlekken: blindeVlekken,
    dekking,
    vensters,
    zoomcalls,
    archief,
    volume,
  };
}

// De vijf pure bouwers hieronder zijn geëxporteerd zodat de tests ze op echte
// invoer kunnen draaien in plaats van op de brontekst te grepen. Een test die
// alleen naar de code kijkt bewaakt hoe het er staat, niet wat het doet — en
// dat is vandaag drie keer misgegaan. Ze raken niets: geen databank, geen
// netwerk, alleen invoer naar uitvoer.

// ── Sectie 6 ───────────────────────────────────────────────────────────────
export function telVolume(pogingen, taakVan) {
  const bel   = { uit: 0, seconden: 0, zonder_duur: 0, gesproken: 0 };
  const wa    = { uit: 0, in: 0 };
  const spraak = { uit: 0, in: 0 };
  const rijen = [];

  for (const p of pogingen) {
    const uitgaand = isMoeite(p);
    if (p.soort === 'call') {
      // Een call is per definitie moeite van Dave; inkomende calls kennen we
      // niet als soort en zouden hier dus niet horen te staan.
      if (!uitgaand) continue;
      bel.uit += 1;
      if (Number.isFinite(p.duur_sec) && p.duur_sec !== null) bel.seconden += Number(p.duur_sec);
      else bel.zonder_duur += 1;
      if (isContact(p)) bel.gesproken += 1;
    } else if (p.soort === 'whatsapp') {
      if (uitgaand) wa.uit += 1; else wa.in += 1;
    } else if (p.soort === 'spraakbericht') {
      if (uitgaand) spraak.uit += 1; else spraak.in += 1;
    } else {
      continue;   // agenda_doorgestuurd / ingepland zijn geen volume
    }
    const t = taakVan.get(p.taak_id);
    rijen.push({
      taak_id : p.taak_id,
      naam    : t ? t.naam : null,
      soort   : p.soort,
      richting: isMoeite(p) ? 'uit' : 'in',
      dag     : dagVan(p.tijdstip),
      tijd    : tijdVan(p.tijdstip),
      duur_sec: Number.isFinite(p.duur_sec) ? p.duur_sec : null,
    });
  }

  return { bel, wa, spraak, rijen };
}

// ── Sectie 2 ───────────────────────────────────────────────────────────────
async function bouwDekking({ pogingen, taakVan, dagen, vandaag, blindeVlekken }) {
  // Wat WEL exact is: wie er in de periode moeite kreeg. Elke rij heeft een
  // tijdstip en is nooit overschreven.
  const perTaak = new Map();
  for (const p of pogingen) {
    if (!isMoeite(p) || !p.taak_id) continue;
    if (!perTaak.has(p.taak_id)) perTaak.set(p.taak_id, { bel: 0, wa: 0, dagen: new Set(), laatste: null });
    const r = perTaak.get(p.taak_id);
    if (p.soort === 'call') { r.bel += 1; r.dagen.add(dagVan(p.tijdstip)); }
    else if (WA_SOORTEN.has(p.soort)) r.wa += 1;
    r.laatste = p.tijdstip;
  }

  const behandeld = [...perTaak.entries()].map(([id, r]) => {
    const t = taakVan.get(id);
    return {
      taak_id: id,
      naam   : t ? t.naam : null,
      bel    : r.bel,
      wa     : r.wa,
      bel_dagen: r.dagen.size,
      laatste: r.laatste,
    };
  }).sort((a, b) => (a.bel + a.wa) - (b.bel + b.wa));

  // Wat NIET exact is: wie er behandeld had MOETEN worden op een dag in het
  // verleden.
  //
  // `opvolging_taken.due` wordt door cron-opvolging-doorrol ter plekke
  // overschreven — een kaart die bleef liggen draagt vandaag de datum van
  // vandaag, niet die van dinsdag. `agenda_doorgestuurd_at` wordt bij een
  // tweede ronde overschreven, en `wacht_verplaatsing` heeft helemaal geen
  // eigen tijdstempel. De lijst van een dag in het verleden is dus niet
  // bewaard, en er valt hem ook niet betrouwbaar uit af te leiden.
  //
  // api/opvolging-weekbalk.js weigert dit getal al om dezelfde reden. Een
  // reconstructie uit created_at plus de drie timestamps klopt in de meeste
  // gevallen — en dat is precies het soort getal dat één keer per maand een
  // verkeerd gesprek oplevert.
  const alleenVandaag = dagen.length === 1 && dagen[0] === vandaag;
  let openstaand = null;

  if (alleenVandaag) {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, naam, reden, due, later')
      .eq('status', 'open').lte('due', vandaag);
    if (error) throw error;
    openstaand = (data || []).map((t) => {
      const r = perTaak.get(t.id);
      return {
        taak_id : t.id,
        naam    : t.naam,
        reden   : t.reden,
        bel     : r ? r.bel : 0,
        wa      : r ? r.wa : 0,
        behandeld: !!r,
      };
    }).sort((a, b) => (a.bel + a.wa) - (b.bel + b.wa));
  } else {
    blindeVlekken.push({
      sectie: 'dekking',
      wat   : 'Hoeveel leads er op een dag in het verleden actie nodig hadden, is niet te zeggen.',
      waarom: 'De werklijst van een voorbije dag is niet bewaard: due wordt door de doorrol-cron overschreven, en twee van de statusovergangen hebben geen eigen tijdstempel. Wat hieronder staat is wie er wél moeite kreeg — dat volgt wel uit tijdstempels.',
    });
  }

  return {
    behandeld,
    openstaand,                       // null = niet te bepalen voor deze periode
    openstaand_bekend: openstaand !== null,
    onbehandeld: openstaand ? openstaand.filter((r) => !r.behandeld) : null,
  };
}

// ── Sectie 3 ───────────────────────────────────────────────────────────────
export function bouwVensters({ afspraken, taken, pogingen, dagen }) {
  // Wie in de vensters hoort zijn de leads met een zoomcall op die dag — niet
  // iedereen op de lijst. Een masterclass-aanmelding hoort geen
  // ochtendspraakbericht te krijgen en hoeft tussen 12 en 13 niet nagebeld.
  const pogPerTaak = new Map();
  for (const p of pogingen) {
    if (!p.taak_id) continue;
    if (!pogPerTaak.has(p.taak_id)) pogPerTaak.set(p.taak_id, []);
    pogPerTaak.get(p.taak_id).push(p);
  }

  // Nummer → taak. Eerst exact op het volle cijferreeks, dan op de laatste 9
  // voor de lokaal geschreven variant. Alleen bij precies één treffer: twee
  // klanten met dezelfde staart is een niet-gekoppelde call, geen 'kies de
  // eerste'. Zie CLAUDE.md lesson 18.
  const exact = new Map();
  const staart = new Map();
  for (const t of taken) {
    const d = telCijfers(t.telefoon);
    if (!d) continue;
    if (!exact.has(d)) exact.set(d, []);
    exact.get(d).push(t);
    if (d.length >= 9) {
      const s = d.slice(-9);
      if (!staart.has(s)) staart.set(s, []);
      staart.get(s).push(t);
    }
  }
  const zoekTaak = (tel) => {
    const d = telCijfers(tel);
    if (!d) return null;
    const e = exact.get(d);
    if (e && e.length === 1) return e[0];
    if (d.length >= 9) {
      const s = staart.get(d.slice(-9));
      if (s && s.length === 1) return s[0];
    }
    return null;
  };

  const rijen = [];
  const zonderTaak = [];
  const perDag = new Map();

  for (const a of afspraken) {
    const dag = dagVan(a.scheduled_at);
    if (!dagen.includes(dag)) continue;
    const t = zoekTaak(a.lead_phone);
    if (!t) {
      // Niet te beoordelen: er is geen pogingen-historiek voor. Als 'geen
      // spraakbericht' meetellen zou een oordeel zijn over iets wat we niet
      // gemeten hebben.
      zonderTaak.push({ appointment_id: a.id, naam: a.lead_name, dag, tijd: tijdVan(a.scheduled_at) });
      continue;
    }
    const sleutel = dag + '|' + t.id;
    if (perDag.has(sleutel)) continue;   // twee calls voor dezelfde persoon = één taak
    perDag.set(sleutel, true);

    const taakMetHist = { ...t, pogingen: pogPerTaak.get(t.id) || [] };
    const oordeel = beoordeelDag(taakMetHist, dag);
    rijen.push({
      taak_id: t.id, appointment_id: a.id, naam: t.naam || a.lead_name,
      dag, call_tijd: tijdVan(a.scheduled_at),
      spraak: oordeel.spraak, nabel: oordeel.nabel,
    });
  }

  // Tellingen per dag optellen: telVensters rekent per dag, en een lead met
  // een call op twee dagen hoort twee keer beoordeeld te worden.
  const totaal = { spraak: leegTel(), nabel: leegTel() };
  for (const dag of dagen) {
    const takenVanDag = rijen.filter((r) => r.dag === dag)
      .map((r) => ({ id: r.taak_id, pogingen: pogPerTaak.get(r.taak_id) || [] }));
    const t = telVensters(takenVanDag, dag);
    for (const k of ['totaal', 'op_tijd', 'te_laat', 'niet_gedaan', 'niet_nodig']) {
      totaal.spraak[k] += t.spraak[k];
      totaal.nabel[k]  += t.nabel[k];
    }
  }

  return { spraak: totaal.spraak, nabel: totaal.nabel, rijen, zonder_taak: zonderTaak };
}

const leegTel = () => ({ totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0 });

// ── Sectie 4 ───────────────────────────────────────────────────────────────
// Hoeveel speling een call krijgt nadat hij is afgelopen, voordat het rapport
// er iets van vindt. Een call van 20:30 mag om 20:35 niet al rood staan: hij is
// dan nog bezig, en daarna moet er ook nog even tijd zijn om iets vast te
// leggen. Duur plus dit getal.
const UITKOMST_SPELING_MIN = 15;
const STANDAARD_DUUR_MIN   = 30;

/**
 * Mag deze call al beoordeeld worden?
 *
 * Zonder deze vraag beoordeelde het rapport élke afspraak in de periode, ook
 * die van vanavond half negen. Dan staat er om acht uur 's ochtends al een
 * lijst met verwijten over werk dat nog niet gedaan hoefde te zijn — en dat is
 * precies het soort onterecht cijfer waar dit rapport zijn geloofwaardigheid
 * mee verspeelt.
 */
export function callStaat(a, nuMs) {
  // Een verzette afspraak is geen gemiste uitkomst. follow-up-verplaats-call
  // zet de oude rij op 'verplaatst' en maakt een nieuwe; die oude rij hoort
  // helemaal niet beoordeeld te worden.
  if (String(a.status || '') === 'verplaatst') return 'verplaatst';
  const start = Date.parse(a.scheduled_at);
  if (!Number.isFinite(start)) return 'te_beoordelen';
  const duur = Number.isFinite(a.duration_minutes) && a.duration_minutes > 0
    ? a.duration_minutes : STANDAARD_DUUR_MIN;
  const klaar = start + (duur + UITKOMST_SPELING_MIN) * 60000;
  return nuMs < klaar ? 'gepland' : 'te_beoordelen';
}

/**
 * Wie is dit, voor het samenvoegen van dubbele afspraken?
 *
 * E-mail eerst, dan het nummer op cijfers, dan de naam. Een naam alleen is
 * zwak, maar twee rijen met dezelfde naam op dezelfde dag zijn precies wat we
 * willen samenvoegen — en als het toevallig twee verschillende mensen zijn,
 * dan is 'er staan twee afspraken' nog steeds de juiste melding.
 */
function persoonSleutel(a) {
  const mail = String(a.lead_email || '').trim().toLowerCase();
  if (mail) return 'e:' + mail;
  const tel = telCijfers(a.lead_phone);
  if (tel) return 't:' + (tel.length >= 9 ? tel.slice(-9) : tel);
  return 'n:' + String(a.lead_name || '').trim().toLowerCase();
}

// ── Sectie 4 ───────────────────────────────────────────────────────────────
export function bouwZoomcalls({ afspraken, uitkomstKolommen, nuMs = Date.now() }) {
  return afspraken.map((a) => {
    // GEEN TERUGVAL OP status. 'completed' dekt zowel sale als gesprek_gehad,
    // en 'cancelled' zowel wilt_niet_meer als niet_geschikt. Uit de status
    // raden welke van de twee het was, is dezelfde verleiding als de
    // notitietekst uitparseren — en net zo fout. Staat er geen uitkomst, dan
    // is het eerlijke antwoord dat er geen uitkomst vastgelegd is.
    const heeft = uitkomstKolommen && !!a.uitkomst;
    const staat = callStaat(a, nuMs);
    return {
      appointment_id: a.id,
      naam    : a.lead_name,
      dag     : dagVan(a.scheduled_at),
      tijd    : tijdVan(a.scheduled_at),
      staat,                       // gepland | verplaatst | te_beoordelen
      persoon : persoonSleutel(a),
      uitkomst: heeft ? a.uitkomst : null,
      uitkomst_op: heeft ? a.uitkomst_op : null,
      vastgelegd : heeft,
      // Waarom er niets staat. Het verschil tussen 'Dave vulde niets in' en
      // 'het systeem legde het niet vast' is precies wat we op 6 september
      // gerepareerd hebben, en dat verschil hoort zichtbaar te blijven.
      // 'gepland' is een derde geval: er is nog niets te melden.
      reden_leeg: heeft ? null
        : (staat === 'gepland' ? 'Deze call moet nog plaatsvinden.'
          : staat === 'verplaatst' ? 'Deze afspraak is verzet; de nieuwe staat er apart bij.'
          : uitkomstKolommen
            ? 'Er is voor deze call geen uitkomst vastgelegd.'
            : 'Uitkomsten worden voor deze periode nog niet bewaard.'),
      notitie : a.snelle_notitie || null,
    };
  });
}

/**
 * Dezelfde persoon, meerdere afspraken op dezelfde dag.
 *
 * Twee identieke verwijten naast elkaar is geen bevinding maar een telfout —
 * Yasmine Aouada stond op 7 september twee keer in de aandachtlijst met exact
 * dezelfde tekst. Eén regel dus, en de dubbeling is dan zelf het aandachtspunt.
 *
 * Verzette rijen tellen niet mee: die zijn verklaard. Blijven er daarna twee
 * over, dan is het een echte dubbele boeking.
 */
export function groepeerDubbele(zoomcalls) {
  const per = new Map();
  for (const c of zoomcalls) {
    const k = c.dag + '|' + c.persoon;
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(c);
  }
  const dubbel = [];
  for (const [, rijen] of per) {
    const levend = rijen.filter((r) => r.staat !== 'verplaatst');
    if (levend.length >= 2) {
      dubbel.push({
        naam : levend[0].naam,
        dag  : levend[0].dag,
        tijden: levend.map((r) => r.tijd).filter(Boolean),
        appointment_ids: levend.map((r) => r.appointment_id),
        verzet_ernaast : rijen.length - levend.length,
      });
    }
  }
  return dubbel;
}

// ── Sectie 5 ───────────────────────────────────────────────────────────────
export function bouwArchief({ gearchiveerd, histPerTaak }) {
  return gearchiveerd.map((t) => {
    const hist = histPerTaak.get(t.id) || [];
    const moeiteRijen = hist.filter(isMoeite);
    const bel = moeiteRijen.filter((p) => p.soort === 'call');
    const wa  = moeiteRijen.filter((p) => WA_SOORTEN.has(p.soort));
    const belDagen = new Set(bel.map((p) => dagVan(p.tijdstip))).size;
    return {
      taak_id: t.id,
      naam   : t.naam,
      gearchiveerd_at: t.gearchiveerd_at,
      dag    : dagVan(t.gearchiveerd_at),
      archief_reden: t.archief_reden,
      reden_code   : t.reden_code || null,
      bel_totaal: bel.length,
      bel_dagen : belDagen,
      wa_totaal : wa.length,
      // Over de HELE levensloop van de kaart, niet over de periode: de vraag
      // is of er genoeg gedaan was vóórdat hij dicht ging.
      moeite_over: 'levensloop',
      moeite: beoordeelMoeite({ bel_dagen: belDagen, wa_totaal: wa.length, reden_code: t.reden_code }),
    };
  });
}

// ── Sectie 1 ───────────────────────────────────────────────────────────────
export function vulAandacht({ aandacht, blindeVlekken, dekking, vensters, zoomcalls, archief }) {
  // EEN BLINDE VLEK IS EEN AFWIJKING. Zonder deze lus zou een sectie die niets
  // kon meten hierboven stil blijven, en dan leest 'geen afwijkingen' als
  // 'alles in orde'. Dat is de duurste fout die dit rapport kan maken.
  for (const bv of blindeVlekken) {
    aandacht.push({ soort: 'blinde_vlek', sectie: bv.sectie, tekst: bv.wat, uitleg: bv.waarom, naam: null });
  }

  for (const r of (dekking.onbehandeld || [])) {
    aandacht.push({
      soort: 'niet_behandeld', sectie: 'dekking', naam: r.naam,
      tekst: `${r.naam || 'Naamloos'} kreeg vandaag nog geen belpoging en geen WhatsApp.`,
      uitleg: null, taak_id: r.taak_id,
    });
  }

  for (const r of vensters.rijen) {
    if (r.spraak.staat === 'niet_gedaan') {
      aandacht.push({ soort: 'venster', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} had een zoomcall op ${r.dag} maar kreeg geen spraakbericht.`, uitleg: null, taak_id: r.taak_id });
    } else if (r.spraak.staat === 'te_laat') {
      aandacht.push({ soort: 'venster', sectie: 'vensters', naam: r.naam,
        tekst: `Het spraakbericht voor ${r.naam || 'Naamloos'} ging om ${r.spraak.tijd}, na de afspraak van ${String(SPRAAK_DEADLINE_UUR).padStart(2, '0')}:00.`, uitleg: null, taak_id: r.taak_id });
    }
    if (r.nabel.staat === 'niet_gedaan') {
      aandacht.push({ soort: 'venster', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} kreeg een spraakbericht, antwoordde niet, en is niet nagebeld.`, uitleg: null, taak_id: r.taak_id });
    } else if (r.nabel.staat === 'te_laat') {
      aandacht.push({ soort: 'venster', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} is om ${r.nabel.tijd} nagebeld, buiten het venster van ${NABEL_VAN_UUR}:00 tot ${NABEL_TOT_UUR}:00.`, uitleg: null, taak_id: r.taak_id });
    }
  }

  if (vensters.zonder_taak.length) {
    aandacht.push({
      soort: 'blinde_vlek', sectie: 'vensters', naam: null,
      tekst: `${vensters.zonder_taak.length} ingeplande call${vensters.zonder_taak.length === 1 ? '' : 's'} staan niet in de takenlijst.`,
      uitleg: 'Daar is geen pogingen-historiek voor, dus over de twee vensters valt voor hen niets te zeggen. Ze tellen hierboven niet mee — als "geen spraakbericht" zou dat een oordeel zijn over iets wat we niet gemeten hebben.',
    });
  }

  // Dubbele afspraken eerst, en de personen daaruit onthouden: anders staan er
  // voor Yasmine twee identieke 'geen uitkomst'-regels naast de melding dat er
  // twee afspraken zijn. Dat is drie regels voor één gegeven.
  const dubbeleGroepen = groepeerDubbele(zoomcalls);
  const alGemeld = new Set();
  for (const d of dubbeleGroepen) {
    aandacht.push({
      soort: 'dubbele_afspraak', sectie: 'zoomcalls', naam: d.naam,
      tekst: `Er staan ${d.tijden.length} afspraken voor ${d.naam || 'dezelfde persoon'} op ${d.dag}` +
        (d.tijden.length ? ` (${d.tijden.join(' en ')})` : '') + '.',
      uitleg: d.verzet_ernaast
        ? 'Er staat daarnaast nog een verzette rij; die telt hier niet mee.'
        : 'Geen van beide is als verzet gemarkeerd, dus dit lijkt een dubbele boeking.',
      appointment_ids: d.appointment_ids,
    });
    for (const id of d.appointment_ids) alGemeld.add(id);
  }

  for (const c of zoomcalls) {
    // Een call die nog moet plaatsvinden is geen gemiste uitkomst, en een
    // verzette rij evenmin. Zonder deze regel staat er om acht uur 's ochtends
    // al een verwijt over de call van vanavond half negen.
    // Alleen een EXPLICIETE 'gepland' of 'verplaatst' onderdrukt de melding.
    // Andersom — alleen 'te_beoordelen' toelaten — zou een call met een
    // ontbrekende staat stilletjes laten wegvallen, en dat is precies de
    // stille vorm die dit rapport nergens mag hebben. Onbekend hoort beoordeeld
    // te worden, niet verstopt.
    if (c.staat === 'gepland' || c.staat === 'verplaatst') continue;
    if (alGemeld.has(c.appointment_id)) continue;
    if (!c.vastgelegd) {
      aandacht.push({
        soort: 'geen_uitkomst', sectie: 'zoomcalls', naam: c.naam,
        // De formulering is met opzet passief: het kan aan Dave liggen én aan
        // het systeem, en dat verschil weten we hier niet.
        tekst: `Voor de call met ${c.naam || 'onbekend'} op ${c.dag} is geen uitkomst vastgelegd.`,
        uitleg: c.reden_leeg, appointment_id: c.appointment_id,
      });
    }
  }

  for (const a of archief) {
    if (a.moeite.staat === 'te_weinig') {
      aandacht.push({
        soort: 'te_weinig_moeite', sectie: 'archief', naam: a.naam,
        tekst: `${a.naam || 'Naamloos'} ging uit de lijst na ${a.bel_totaal}× bellen op ${a.bel_dagen} dag${a.bel_dagen === 1 ? '' : 'en'} en ${a.wa_totaal}× WhatsApp.`,
        uitleg: `De afspraak is ${ARCHIEF_MIN_DAGEN} belpogingen op ${ARCHIEF_MIN_DAGEN} verschillende dagen plus ${ARCHIEF_MIN_WA} WhatsApp.`,
        taak_id: a.taak_id,
      });
    }
  }
}
