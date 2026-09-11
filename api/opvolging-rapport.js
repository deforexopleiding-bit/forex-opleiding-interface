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
import { bouwTijdlijn } from './_lib/opvolging-tijdlijn.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  isMoeite, isContact, isGesprek, gesprekDuur, classificeerResultaat, WA_SOORTEN,
  GESPROKEN, NIET_OPGENOMEN, VIA_ANDER,
} from './_lib/opvolging-poging-telling.js';
import { bouwWerkritme, WERKUUR_VAN, WERKUUR_TOT, GAT_DREMPEL_MIN, BEZETTING_DREMPEL } from './_lib/opvolging-werkritme.js';
import { verdeelVandaagGedaan } from './_lib/opvolging-vandaag-gedaan.js';
import { leadlijstDektDag, DEKKING_VANAF } from './_lib/opvolging-leadlijst-venster.js';
import { haalWaRegels, waPogingenVoorNummer, haalWaRegelsVanaf, volledigeHistorie,
         losseRegelsVoor, regelAlsPoging } from './_lib/opvolging-call-wa.js';

// Hoe ver terug sectie 5 naar losse WhatsApp-berichten kijkt. Een kaart die nu
// dichtgaat is hooguit enkele weken oud (de nachtelijke doorrol schuift door),
// dus zestig dagen dekt de levensloop ruim en houdt de lezing begrensd.
const ARCHIEF_WA_TERUG_DAGEN = 60;
import {
  beoordeelDag, beoordeelMoeite, dagVan,
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

/**
 * Geëxporteerd zodat de dagelijkse gezondheidscontrole exact HETZELFDE
 * rekenwerk kan draaien als het endpoint.
 *
 * Zou die controle het rapport via HTTP opvragen, dan loopt hij tegen het
 * gedocumenteerde anti-pattern van een self-call binnen dezelfde Vercel-
 * deployment (zie de kop van api/_lib/joost-suggest-core.js). Deze weg is
 * bovendien strenger: de controle rekent met dezelfde functie, niet met een
 * nabootsing ervan.
 */
export async function bouwRapport({ supabase, van, tot, dagen, vandaag, vanIso, totIso }) {
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
    .select('id, lead_name, lead_phone, lead_email, scheduled_at, duration_minutes, status, parent_appointment_id, annulering_reden, snelle_notitie, uitkomst, uitkomst_op')
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
      .select('id, lead_name, lead_phone, lead_email, scheduled_at, duration_minutes, status, parent_appointment_id, annulering_reden, snelle_notitie')
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
  let archiefWaRegels = [];
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

    // ── EN DE BERICHTEN DIE NOOIT EEN POGING WERDEN ──────────────────────
    // Sectie 5 velt een oordeel over één persoon ('te weinig moeite'), en dat
    // oordeel stond op een halve meting: een spraakbericht dat vóór het
    // ontstaan van de kaart uitging heeft geen rij in opvolging_pogingen.
    //
    // `moeite_over: 'levensloop'` belooft de hele levensloop, dus het venster
    // van de PERIODE volstaat hier niet — een kaart die vandaag dichtgaat kan
    // vorige week zijn begonnen. Vandaar een eigen lezing, begrensd op
    // ARCHIEF_WA_TERUG_DAGEN.
    const vanafMs = Math.min(
      Date.parse(vanIso) || Date.now(),
      Date.now() - ARCHIEF_WA_TERUG_DAGEN * 86400000,
    );
    const lezing = await haalWaRegelsVanaf(supabaseAdmin, new Date(vanafMs).toISOString());
    if (lezing.fout || lezing.afgekapt) {
      blindeVlekken.push({
        sectie: 'archief',
        wat   : lezing.fout
          ? 'De WhatsApp-berichten konden niet gelezen worden.'
          : 'Er zijn meer WhatsApp-berichten dan in één lezing passen.',
        waarom: 'Berichten die vóór het ontstaan van een kaart zijn verstuurd tellen hieronder dan niet mee, '
              + 'en het oordeel over de geleverde moeite kan daardoor te streng zijn.',
      });
    }
    archiefWaRegels = lezing.regels;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 6 · VOLUME
  // ═══════════════════════════════════════════════════════════════════════
  // DE DOORGESCHOVEN KAARTEN. Bryan en Peter kregen op 7 september om 18:12 en
  // 18:35 een beslissing en bleven open met een due vooruit — precies goed,
  // maar ze stonden nergens. Ze zitten niet per se in taakVan (die hangt aan
  // pogingen), dus ze worden apart opgehaald; een kaart die je mist is exact
  // de bug die dit blok moet oplossen.
  let bevestigdTaken = [];
  {
    const { data, error } = await supabaseAdmin
      .from('opvolging_taken')
      .select('id, naam, status, due, bevestigd_op, bevestigd_notitie, archief_reden, gearchiveerd_at')
      .gte('bevestigd_op', vanIso).lt('bevestigd_op', totIso);
    if (error) {
      blindeVlekken.push({
        sectie: 'afgehandeld',
        wat   : 'De doorgeschoven kaarten konden niet gelezen worden.',
        waarom: error.message,
      });
    } else {
      bevestigdTaken = data || [];
    }
  }

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
  // DEZELFDE GEFILTERDE SET als de zoomcall-lijst. Zonder dit telt de blinde
  // vlek 'calls die niet in de takenlijst staan' ook de geannuleerde en de
  // verzette mee, en dan staat er een groter getal onder een kortere lijst.
  const vensterAfspraken = relevanteAfspraken(afspraken, Date.now());

  // DE WHATSAPP-BERICHTEN ERBIJ. Een zoomlead heeft meestal geen opvolgtaak, en
  // dus geen pogingen-historiek; zijn spraakbericht staat wél in
  // opvolging_wa_berichten (aan een NUMMER, niet aan een kaart). Zonder deze
  // regels meet sectie 3 structureel nul voor precies die groep.
  //
  // Een leesfout is een BLINDE VLEK, geen nul: bouwVensters krijgt dan null
  // mee en behandelt elke call zonder taak als 'zonder_taak', net als voorheen.
  const waLezing = await haalWaRegels(supabaseAdmin, vanIso, totIso);
  if (waLezing.fout) {
    blindeVlekken.push({
      sectie: 'vensters',
      wat   : 'De WhatsApp-berichten konden niet gelezen worden.',
      waarom: 'Het spraakbericht per zoomcall wordt daaruit afgelezen voor leads zonder opvolgtaak. Zonder die rijen is er voor die leads niets gemeten; ze staan hieronder als niet-beoordeelbaar en niet als gemist.',
    });
  }
  const vensters = bouwVensters({
    afspraken: vensterAfspraken, taken: alleTaken, pogingen, dagen,
    waRegels : waLezing.fout ? null : waLezing.regels,
  });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 4 · DE ZOOMCALLS ZELF
  // ═══════════════════════════════════════════════════════════════════════
  // De belpogingen van die dag horen BIJ de call: zie belpogingenVoorCalls.
  const belBijCall = belpogingenVoorCalls({ afspraken, taken: alleTaken, pogingen });
  const zoomcalls = bouwZoomcalls({ afspraken, uitkomstKolommen, nuMs: Date.now(), belBijCall });

  // ═══════════════════════════════════════════════════════════════════════
  // SECTIE 5 · UIT DE LIJST GEHAALD
  // ═══════════════════════════════════════════════════════════════════════
  const archief = bouwArchief({ gearchiveerd, histPerTaak, waRegels: archiefWaRegels });

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

  // ── Werkritme ────────────────────────────────────────────────────────────
  // Per dag, want een balk per uur over een hele week zou de klontering juist
  // uitsmeren — en dat is precies wat dit blok moet laten zien.
  const werkritme = dagen.map((d) => bouwWerkritme({
    pogingen: pogingen.filter((p) => dagVan(p.tijdstip) === d), dag: d,
  }));

  // ── De tijdlijn per dag ──────────────────────────────────────────────────
  // Statische SVG uit hetzelfde endpoint, zodat scherm en print exact dezelfde
  // grafiek krijgen. Zou de browser hem na het laden tekenen, dan is de
  // printweergave leeg of half — en dat valt pas op als iemand een PDF opslaat.
  const tijdlijn = dagen.map((d) => bouwTijdlijn({
    pogingen : pogingen.filter((p) => dagVan(p.tijdstip) === d),
    afspraken: afspraken.filter((a) => dagVan(a.scheduled_at) === d),
    dag      : d,
    // Het gat komt van bouwWerkritme, niet uit een tweede berekening: anders
    // toont het kader een andere stilte dan de zin eronder.
    gat          : (werkritme.find((r) => r.dag === d) || {}).langste_gat || null,
    gatDrempelMin: GAT_DREMPEL_MIN,
  }));


  // ── Afgehandeld ──────────────────────────────────────────────────────────
  // Dezelfde berekening als het scherm Vandaag gedaan. Één helper, geen tweede
  // telling: anders zegt het scherm zeven en de PDF acht, en weet niemand welke
  // van de twee liegt.
  const takenVoorGedaan = [...new Map(
    [...alleTaken, ...gearchiveerd, ...bevestigdTaken].map((t) => [t.id, t]),
  ).values()];
  const afgehandeld = dagen.map((d) => verdeelVandaagGedaan({
    taken: takenVoorGedaan, pogingen, dag: d, dagVan,

  }));

  vulAandacht({ aandacht, blindeVlekken, dekking, vensters, zoomcalls, archief });

  // De werkritme-bevindingen horen in de aandachtlijst: het zijn rekensommen
  // met een zichtbare drempel, precies zoals de andere bevindingen.
  for (const r of werkritme) {
    for (const b of r.bevindingen) {
      aandacht.push({
        soort: b.soort, sectie: 'werkritme', naam: null, dag: r.dag,
        tekst: b.tekst, uitleg: null, getallen: b.getallen,
      });
    }
  }
  // Ernst en label erbij, ná het vullen: zo hoeft geen enkele push-plek eraan
  // te denken en kan er ook geen bevinding zonder ernst ontstaan.
  const aandachtMetErnst = aandacht.map(metErnst);

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
      // Zichtbaar, niet verstopt: een grens die niemand kan zien is een grens
      // waar niemand het over kan hebben.
      // DE GRENS VAN TIEN SECONDEN IS VERVALLEN. Hij stond op `duur_sec`, en
      // dat is de tijd tussen kiezen en ophangen — inclusief overgaan. Bij
      // 'niet opgenomen' staan duren tot 43 seconden, bij 'gesproken' vanaf 4;
      // een grens daarop scheidt niets. Sinds 8 september beslist het veld
      // `resultaat` of er contact was, en zegt de duur alleen hoe lang, en
      // alleen waar er gesproken is.
      gesprek_bron: 'resultaat',
      gesprek_min_sec: null,
      // WAT ALS WERKUUR TELT BEPAALT DE HELE BEOORDELING van het werkritme, en
      // dat mag geen verborgen aanname zijn. 09:00 tot 21:00, twaalf uren: de
      // module eist zelf een spraakbericht vóór 09:00 en de zoomcalls lopen
      // tot half negen 's avonds.
      werkuur_van: WERKUUR_VAN,
      werkuur_tot: WERKUUR_TOT,
      // Een stilte binnen werkuren is pas een bevinding vanaf twee uur, en een
      // dag heet geklonterd onder 60% bezetting van de werkuren.
      gat_drempel_min: GAT_DREMPEL_MIN,
      bezetting_drempel: BEZETTING_DREMPEL,
    },
    aandacht: aandachtMetErnst,
    blinde_vlekken: blindeVlekken,
    dekking,
    vensters,
    zoomcalls,
    archief,
    volume,
    // De verdeling over de dag, en wat er afgehandeld is. Per dag, zodat een
    // weekrapport de klontering niet uitsmeert.
    //
    // `tijdlijn` en `werkritme` horen bij elkaar: de eerste is het beeld, de
    // tweede zijn de twee rekensommen eronder. Het scherm toont ze als ÉÉN
    // blok — twee blokken over de verdeling van de dag onder elkaar is niet
    // twee keer beter maar een rommelig rapport.
    tijdlijn,
    werkritme,
    afgehandeld,
  };
}

// De vijf pure bouwers hieronder zijn geëxporteerd zodat de tests ze op echte
// invoer kunnen draaien in plaats van op de brontekst te grepen. Een test die
// alleen naar de code kijkt bewaakt hoe het er staat, niet wat het doet — en
// dat is vandaag drie keer misgegaan. Ze raken niets: geen databank, geen
// netwerk, alleen invoer naar uitvoer.

// ── Sectie 6 ───────────────────────────────────────────────────────────────
export function telVolume(pogingen, taakVan) {
  // VIER EMMERS DIE ELKAAR UITSLUITEN, EN DIE SAMEN `uit` ZIJN.
  //
  //   gesproken + niet_opgenomen + onbekend_resultaat === uit
  //
  // 8 SEPTEMBER — DE EMMERS ZIJN OMGEZET. Ze hingen aan een grens van tien
  // seconden op `duur_sec`, en dat getal is de tijd tussen KIEZEN en OPHANGEN,
  // dus inclusief overgaan. De meting: bij 'niet opgenomen' staan duren tot 43
  // seconden, bij 'gesproken' vanaf 4. Een grens daarop noemt 43 seconden
  // overgaan een gesprek en 4 seconden gesprek een niet-gesprek.
  //
  // 'te_kort' bestaat daarom niet meer als categorie: hij beweerde iets over de
  // kwaliteit van een gesprek op basis van een getal dat er niet over ging. Wat
  // ervoor in de plaats komt is `onbekend_resultaat` — calls waarvan het
  // resultaat-veld niets bruikbaars zegt. Die horen in de blinde vlekken, niet
  // in een oordeel.
  //
  // `zonder_duur` telt binnen de gesproken calls: er is gesproken, maar de
  // lengte is niet vastgelegd. Dat is geen aparte uitkomst maar een ontbrekend
  // getal, en het rapport zegt dan 'lengte niet geregistreerd' in plaats van 0.
  const bel = { uit: 0, seconden: 0, gesproken: 0, niet_opgenomen: 0,
                onbekend_resultaat: 0, zonder_duur: 0, via_ander: 0 };
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
      const soort = classificeerResultaat(p.resultaat);
      const duur = gesprekDuur(p);

      // Precies één emmer per call. Het RESULTAAT beslist, niet de duur.
      if (soort === GESPROKEN) {
        bel.gesproken += 1;
        // Seconden tellen alleen mee waar er echt gesproken is; anders telden
        // we overgaantijd op bij gesprekstijd.
        if (duur.sec === null) bel.zonder_duur += 1;
        else bel.seconden += duur.sec;
      } else if (soort === NIET_OPGENOMEN) {
        bel.niet_opgenomen += 1;
      } else if (soort === VIA_ANDER) {
        // Afgehandeld via iemand anders: wel werk, geen eigen gesprek.
        bel.via_ander += 1;
      } else {
        bel.onbekend_resultaat += 1;
      }
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
      waarom: 'De werklijst van een voorbije dag is niet bewaard: due wordt door de doorrol-cron overschreven, en twee van de statusovergangen hebben geen eigen tijdstempel. Wat hieronder staat is welke leads minstens één poging kregen — dat volgt wel uit tijdstempels.',
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
/**
 * NUMMER → TAAK. Eén huis, want twee kopieën lopen uiteen.
 *
 * Eerst exact op de volle cijferreeks, dan op de laatste 9 voor de lokaal
 * geschreven variant. Alleen bij precies één treffer: twee klanten met dezelfde
 * staart is een niet-gekoppelde call, geen 'kies de eerste'. Zie CLAUDE.md
 * lesson 18.
 *
 * Stond eerst binnen bouwVensters. De belpogingen bij een zoomcall hebben exact
 * dezelfde koppeling nodig, en een tweede versie ervan zou vroeg of laat een
 * ander antwoord geven op dezelfde vraag.
 */
export function maakTaakZoeker(taken) {
  const exact = new Map();
  const staart = new Map();
  for (const t of taken || []) {
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
  return (tel) => {
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
}

/**
 * ALLE BELPOGINGEN VAN DIE DAG BIJ DIE ZOOMCALL.
 *
 * Shudino Andrade stond op 7 september als no-show, en de collega die hem nog
 * gebeld had moest op zijn woord geloofd worden. Terwijl het gewoon in onze
 * data stond: een uitgaande call van 41 seconden om 17:23. Dat is precies het
 * bewijsmateriaal waar deze module voor bedoeld is, en het was nergens te zien.
 *
 * NIET ALLEEN HET NABELVENSTER. bouwVensters kijkt naar 12-13 uur, want dat is
 * de afspraak over wannéér er nagebeld hoort te worden. Deze functie beantwoordt
 * een andere vraag — is er die dag contact gezocht? — en daar telt een gesprek
 * om kwart over vijf net zo hard. Twee vragen, twee antwoorden; ze door elkaar
 * halen was de reden dat dit bewijs onzichtbaar bleef.
 *
 * GEEN GEKOPPELDE TAAK IS NIET NUL. Een call zonder taak-koppeling heeft geen
 * belhistoriek die we kunnen lezen; dat als '0×' tonen zou een verwijt zijn
 * over iets wat we niet gemeten hebben. Dan is `gekoppeld:false` het eerlijke
 * antwoord — dezelfde regel als bij de blinde vlekken.
 */
/**
 * 'Die dag 2x gebeld, waarvan 1 gesprek van 41 s.' Eén formulering, drie schermen.
 *
 * Seconden komen alleen van calls waar het resultaat 'gesproken' zegt. Is er
 * gesproken maar staat de lengte er niet, dan zeggen we dat — een nul zou
 * lezen als een gesprek van nul seconden.
 */
export function belZin(aantal, gesproken, seconden) {
  if (!aantal) return 'Die dag niet gebeld.';
  const keer = aantal + '\u00d7 gebeld';
  if (!gesproken) return 'Die dag ' + keer + ', niemand nam op.';
  const kop = 'Die dag ' + keer + ', waarvan ' +
    (gesproken === 1 ? '1 gesprek' : gesproken + ' gesprekken');
  if (!seconden) return kop + '; de lengte is niet geregistreerd.';
  const duur = seconden >= 90 ? Math.round(seconden / 60) + ' min' : seconden + ' s';
  return kop + ' van samen ' + duur + '.';
}

export function belpogingenVoorCalls({ afspraken, taken, pogingen }) {
  const zoekTaak = maakTaakZoeker(taken);
  const perTaakDag = new Map();
  for (const p of pogingen || []) {
    if (!p || !p.taak_id) continue;
    if (String(p.soort || '') !== 'call') continue;
    // Uitgaand: wat Dave zelf gedaan heeft. Een inkomend telefoontje is ander
    // bewijs en hoort niet in deze telling.
    if (p.richting && String(p.richting) !== 'uit') continue;
    const dag = dagVan(p.tijdstip);
    if (!dag) continue;
    const sleutel = p.taak_id + '|' + dag;
    if (!perTaakDag.has(sleutel)) perTaakDag.set(sleutel, []);
    perTaakDag.get(sleutel).push(p);
  }

  const uit = new Map();
  for (const a of afspraken || []) {
    const dag = dagVan(a.scheduled_at);
    const t = zoekTaak(a.lead_phone);
    if (!t) { uit.set(String(a.id), { gekoppeld: false, aantal: 0, gesproken: 0, seconden: 0, pogingen: [] }); continue; }
    const rij = (perTaakDag.get(t.id + '|' + dag) || [])
      .slice()
      .sort((x, y) => String(x.tijdstip).localeCompare(String(y.tijdstip)));
    let gesproken = 0;
    let seconden = 0;
    const lijst = rij.map((p) => {
      // HET RESULTAAT BESLIST, DE DUUR ZEGT ALLEEN HOE LANG. Een duur bij een
      // niet-opgenomen call is overgaantijd en hoort niet getoond te worden.
      const k = classificeerResultaat(p.resultaat);
      const duur = gesprekDuur(p);
      if (k === GESPROKEN) { gesproken += 1; if (duur.sec !== null) seconden += duur.sec; }
      return {
        tijd: tijdVan(p.tijdstip),
        // Alleen gevuld waar er gesproken is; null betekent hier 'lengte niet
        // geregistreerd', niet 'nul seconden'.
        duur_sec: duur.toon ? duur.sec : null,
        soort: k === GESPROKEN ? 'gesprek'
             : k === NIET_OPGENOMEN ? 'niet_opgenomen'
             : k === VIA_ANDER ? 'via_ander' : 'onbekend_resultaat',
        resultaat: p.resultaat || null,
        automatisch: p.automatisch === true,
      };
    });
    uit.set(String(a.id), {
      gekoppeld: true, taak_id: t.id,
      aantal: lijst.length, gesproken, seconden, pogingen: lijst,
      // DE ZIN HOORT HIER, NIET DRIE KEER IN DE VIEWS. Het dagscherm, het
      // rapportscherm en de printweergave tonen alle drie hetzelfde; drie
      // kopieën van dezelfde formulering lopen vroeg of laat uiteen. Zelfde
      // reden als reden_leeg hierboven.
      samenvatting: belZin(lijst.length, gesproken, seconden),
    });
  }
  return uit;
}

/**
 * @param {?Array} waRegels de gespreksregels uit opvolging_wa_berichten, of
 *   NULL als ze niet gelezen konden worden. Null en [] zijn NIET hetzelfde:
 *   een lege lijst betekent 'er ging die dagen niets', null betekent 'we weten
 *   het niet' — en dan blijft een call zonder taak gewoon onbeoordeelbaar.
 */
export function bouwVensters({ afspraken, taken, pogingen, dagen, waRegels = null }) {
  // Wie in de vensters hoort zijn de leads met een zoomcall op die dag — niet
  // iedereen op de lijst. Een masterclass-aanmelding hoort geen
  // ochtendspraakbericht te krijgen en hoeft tussen 12 en 13 niet nagebeld.
  const pogPerTaak = new Map();
  for (const p of pogingen) {
    if (!p.taak_id) continue;
    if (!pogPerTaak.has(p.taak_id)) pogPerTaak.set(p.taak_id, []);
    pogPerTaak.get(p.taak_id).push(p);
  }

  const zoekTaak = maakTaakZoeker(taken);

  const rijen = [];
  const zonderTaak = [];
  const perDag = new Map();

  for (const a of afspraken) {
    const dag = dagVan(a.scheduled_at);
    if (!dagen.includes(dag)) continue;
    const t = zoekTaak(a.lead_phone);

    // ── DE WHATSAPP-BERICHTEN VAN DIE LEAD ───────────────────────────────
    // Alleen op een dag die de leadlijst dekt. Daarvoor gooide de webhook een
    // bericht van een nummer zonder kaart weg, dus is een lege lijst daar geen
    // meting maar een gat — en dan blijft het oude gedrag staan.
    const waPog = (waRegels && leadlijstDektDag(dag))
      ? waPogingenVoorNummer(waRegels, a.lead_phone) : null;

    if (!t && !waPog) {
      // Niet te beoordelen: er is geen pogingen-historiek voor. Als 'geen
      // spraakbericht' meetellen zou een oordeel zijn over iets wat we niet
      // gemeten hebben.
      zonderTaak.push({ appointment_id: a.id, naam: a.lead_name, dag, tijd: tijdVan(a.scheduled_at) });
      continue;
    }

    // Zonder kaart is het nummer de identiteit: twee calls voor hetzelfde
    // nummer op één dag blijven één rij, net als twee calls voor één taak.
    //
    // De laatste negen cijfers, niet de volle reeks — het CRM noteert nummers
    // ook lokaal terwijl de agenda ze met landcode draagt, en dat is dezelfde
    // persoon. Zelfde identiteitsregel als maakTaakZoeker hierboven hanteert
    // voor een lead mét kaart; een andere zou dezelfde lead met kaart één rij
    // geven en zonder kaart twee.
    const sleutel = dag + '|' + (t ? t.id : 'nr:' + nummerSleutel(a.lead_phone));
    if (perDag.has(sleutel)) continue;
    perDag.set(sleutel, true);

    const pog = (t ? (pogPerTaak.get(t.id) || []) : []).concat(waPog || []);
    const oordeel = beoordeelDag({ pogingen: pog }, dag);

    // ZONDER KAART IS NABELLEN NIET GEMETEN, niet 'niet gedaan'. Een belpoging
    // hangt aan een taak; die er niet is betekent dat we het niet kunnen zien.
    // Het spraakbericht is hier wél gemeten — dat komt uit de gespreksregels.
    const nabel = (!t && oordeel.nabel.staat === 'niet_gedaan')
      ? { staat: 'niet_gemeten', reden: 'geen opvolgtaak, dus belpogingen niet zichtbaar', tijd: null }
      : oordeel.nabel;

    rijen.push({
      // Null en niet een verzonnen id: wie deze rij terugleest moet kunnen zien
      // dat er geen kaart achter zit.
      taak_id: t ? t.id : null,
      appointment_id: a.id, naam: (t && t.naam) || a.lead_name,
      dag, call_tijd: tijdVan(a.scheduled_at),
      spraak: oordeel.spraak, nabel,
    });
  }

  // ── DE TELLING KOMT UIT DE RIJEN ZELF ──────────────────────────────────
  // Stond eerder als een tweede telVensters-ronde over gereconstrueerde taken.
  // Dat kon niet meer: de rijen zonder kaart dragen hun pogingen niet in
  // pogPerTaak, en hun nabel-oordeel is hier al bijgesteld naar 'niet_gemeten'.
  // Twee keer hetzelfde uitrekenen langs twee wegen is precies hoe scherm en
  // rapport uit elkaar lopen — dus tellen we wat er in de lijst staat.
  const totaal = { spraak: leegTel(), nabel: leegTel() };
  for (const r of rijen) {
    totaal.spraak.totaal += 1;
    totaal.spraak[r.spraak.staat] += 1;
    if (r.nabel.staat === 'niet_gemeten') { totaal.nabel.niet_gemeten += 1; continue; }
    if (r.nabel.staat === 'niet_nodig')   { totaal.nabel.niet_nodig += 1; continue; }
    totaal.nabel.totaal += 1;
    totaal.nabel[r.nabel.staat] += 1;
  }

  return {
    spraak: totaal.spraak, nabel: totaal.nabel, rijen, zonder_taak: zonderTaak,
    // Apart en met naam, zodat een scherm het niet per ongeluk als 'gemist'
    // optelt. Zie de kop hierboven.
    nabel_niet_gemeten: totaal.nabel.niet_gemeten,
  };
}

const leegTel = () => ({ totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0, niet_gemeten: 0 });

/** De identiteit van een telefoonnummer zonder kaart. Zie de sleutel hierboven. */
function nummerSleutel(tel) {
  const d = telCijfers(tel).replace(/^00/, '');
  return d.length >= 9 ? d.slice(-9) : (d || 'onbekend');
}

// ── Sectie 4 ───────────────────────────────────────────────────────────────
// Hoeveel speling een call krijgt nadat hij is afgelopen, voordat het rapport
// er iets van vindt. Een call van 20:30 mag om 20:35 niet al rood staan: hij is
// dan nog bezig, en daarna moet er ook nog even tijd zijn om iets vast te
// leggen. Duur plus dit getal.
// Hoelang een call minstens moet duren om een GESPREK te heten.
//
// WAAROM DIT GETAL ER STAAT, EN WAAROM HET ZICHTBAAR IS.
// Het rapport meldde op 7 september 'gesproken: 6' over negen calls die 26, 24,
// 4, 29, 1, 1, 22, 24 en 2 seconden duurden. Drie van die zes duurden één, één
// en twee seconden. Zo meet het rapport iets anders dan het zegt, en wel in
// Daves voordeel — precies wat een rapport over een persoon niet mag doen.
//
// De grens staat op tien seconden, en dat is een KEUZE op één dag gegevens, niet
// op een verdeling. In die ene dag ligt er een gat tussen 4 en 22 seconden: de
// korte calls zijn 1, 1, 2 en 4, de rest 22 en langer. Tien valt midden in dat
// gat en scheidt de twee groepen zonder een van beide te raken.
//
// WAT HIER NOG ONTBREEKT: de verdeling over meerdere weken. Die is van hieruit
// niet op te vragen. De query staat in de PR-beschrijving; blijkt daaruit een
// andere natuurlijke grens, dan is dit één regel. Daarom staat het getal ook in
// `drempels` in het antwoord: een grens die niemand kan zien is een grens waar
// niemand het over kan hebben.
export const GESPREK_MIN_SEC = 10;

// De statussen waarbij de call daadwerkelijk plaatsvond of had moeten
// plaatsvinden. Alleen díe kun je op een uitkomst afrekenen.
const BEOORDEELBARE_STATUSSEN = new Set(['scheduled', 'in_progress', 'completed', 'no_show']);
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
  // EEN TOELATINGSLIJST, GEEN WEIGERLIJST — en dat is hier andersom dan bij de
  // WhatsApp-systeemtypes, met reden.
  //
  // follow_up_appointments.status draagt méér waarden dan de CHECK-constraint
  // noemt: `wacht_op_reschedule` (de GHL-poll) en `verwijderd`
  // (follow-up-verwijder) worden ook geschreven. Een lijst met 'alles behalve
  // deze paar' laat elke toekomstige waarde stilzwijgend beoordelen, en dan
  // krijgt Dave een verwijt over een call die nooit had moeten plaatsvinden.
  // Bij de systeemtypes was stil verlies de grotere schade; hier is een vals
  // verwijt dat, want dit rapport gaat over een persoon.
  //
  // Wat er niet in staat verdwijnt daarom ook niet: onbekende statussen komen
  // terug als 'onbeoordeelbaar' en worden als blinde vlek gemeld.
  const status = String(a.status || 'scheduled');   // NOT NULL met default 'scheduled'
  if (status === 'cancelled')  return 'geannuleerd';
  if (status === 'verplaatst') return 'verplaatst';
  if (!BEOORDEELBARE_STATUSSEN.has(status)) return 'onbeoordeelbaar';

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

/**
 * DE AFSPRAKEN DIE ECHT MEETELLEN — ÉÉN PLEK, VOOR ALLES WAT ERUIT VOLGT.
 *
 * De zoomcall-lijst werd gefilterd, maar de tellingen die eruit volgen niet.
 * Gevolg op 7 september: de lijst toonde terecht 5 rijen (3 gepland, 2
 * geannuleerd, Yasmine nog maar één keer), en de blinde vlek eronder zei nog
 * steeds "6 ingeplande calls staan niet in de takenlijst" — het oude,
 * ongefilterde getal. Dat is de omgekeerde versie van de fout van de week
 * ervoor, toen de bevinding ontdubbeld werd maar de lijst bleef staan.
 *
 * Daarom nu één functie die de set bepaalt, en iedereen die er iets uit afleidt
 * gebruikt diezelfde set. Een geannuleerde call heeft geen spraakbericht nodig
 * en kan dus geen venster missen; een verzette voorganger evenmin.
 */
export function relevanteAfspraken(afspraken, nuMs) {
  const heeftOpvolgerHier = new Set(
    (afspraken || []).map((a) => a.parent_appointment_id).filter(Boolean).map(String),
  );
  return (afspraken || []).filter((a) => {
    if (String(a.status || '') === 'verplaatst' && heeftOpvolgerHier.has(String(a.id))) return false;
    const staat = callStaat(a, nuMs);
    return staat === 'gepland' || staat === 'te_beoordelen';
  });
}

// ── Sectie 4 ───────────────────────────────────────────────────────────────
export function bouwZoomcalls({ afspraken, uitkomstKolommen, nuMs = Date.now(), belBijCall = null }) {
  // DE LIJST ZELF MOET KLOPPEN, NIET ALLEEN DE BEVINDING.
  //
  // Op 7 september stonden er zes rijen voor drie calls: een verplaatste
  // Yasmine naast haar opvolger, en twee geannuleerde alsof ze doorgingen. Bij
  // de vorige ronde is alleen de dubbele BEVINDING ontdubbeld — de lijst bleef
  // zes tonen. Een lijst die niet klopt maakt elke telling eronder verdacht.
  //
  // follow-up-verplaats-call zet de oude rij op 'verplaatst' en maakt een
  // nieuwe met parent_appointment_id = het oude id. Zit die opvolger in
  // dezelfde periode, dan is de voorganger dubbel beeld en valt hij weg. Zit
  // hij er NIET in (verplaatst naar volgende week), dan blijft de voorganger
  // staan — anders verdwijnt stil dat er iets verzet is.
  const heeftOpvolgerHier = new Set(
    afspraken.map((a) => a.parent_appointment_id).filter(Boolean).map(String),
  );

  return afspraken.filter((a) => {
    if (String(a.status || '') !== 'verplaatst') return true;
    return !heeftOpvolgerHier.has(String(a.id));
  }).map((a) => {
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
      // gepland | verplaatst | geannuleerd | onbeoordeelbaar | te_beoordelen
      staat,
      // De ruwe status erbij, zodat een onbekende waarde te herkennen is
      // zonder in de databank te hoeven kijken.
      status_ruw: String(a.status || 'scheduled'),
      // Een annulering is informatie voor Maxim, alleen geen verwijt aan Dave.
      annulering_reden: a.annulering_reden || null,
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
          : staat === 'verplaatst' ? 'Deze afspraak is verzet; de opvolger valt buiten deze periode.'
          : staat === 'geannuleerd' ? 'Deze afspraak is geannuleerd; een uitkomst hoort hier niet.'
          : staat === 'onbeoordeelbaar' ? 'De status van deze afspraak (' + String(a.status || '') + ') zegt niet of de call heeft plaatsgevonden.'
          : uitkomstKolommen
            // ZEG WELKE CALL. Deze zin staat vlak onder een regel over
            // belpogingen, en werd daardoor gelezen als 'er is niet gebeld' —
            // terwijl Shudino gewoon een gesprek van 41 seconden had. Hij gaat
            // over de ZOOMCALL, en dat hoort er te staan.
            ? 'Er is voor deze zoomcall geen uitkomst vastgelegd.'
            : 'Uitkomsten van zoomcalls worden voor deze periode nog niet bewaard.'),
      notitie : a.snelle_notitie || null,
      // HET BEWIJSMATERIAAL BIJ DE CALL. Zonder dit moest Maxim geloven op zijn
      // woord dat er nog gebeld was voor een no-show. Null = niet meegegeven
      // (oudere aanroeper), en dat is iets anders dan 'niet gebeld'.
      belpogingen: belBijCall ? (belBijCall.get(String(a.id)) || null) : null,
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
export function bouwArchief({ gearchiveerd, histPerTaak, waRegels = null }) {
  return gearchiveerd.map((t) => {
    // volledigeHistorie() voegt de gespreksregels van dit nummer toe die nog
    // geen taak_id dragen — die hebben per definitie geen poging, dus dubbel
    // tellen kan niet. Zonder waRegels blijft dit exact de oude berekening.
    const hist = volledigeHistorie(histPerTaak.get(t.id) || [], waRegels, t);
    const moeiteRijen = hist.filter(isMoeite);
    const bel = moeiteRijen.filter((p) => p.soort === 'call');
    const wa  = moeiteRijen.filter((p) => WA_SOORTEN.has(p.soort));
    const belDagen = new Set(bel.map((p) => dagVan(p.tijdstip))).size;
    // Is er van ÉÉN call een duur bekend? Zo niet, dan valt er over de kwaliteit
    // van die belpogingen niets te zeggen en hoort er geen oordeel te vallen.
    const duurBekend = bel.some((p) => p.duur_sec !== null && p.duur_sec !== undefined
      && Number.isFinite(Number(p.duur_sec)));
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
      duur_bekend: duurBekend,
      moeite: beoordeelMoeite({
        bel_dagen: belDagen, wa_totaal: wa.length, reden_code: t.reden_code,
        // Geen calls gedaan? Dan is er ook geen duur die ontbreekt; dan gaat het
        // oordeel gewoon over de moeite. Alleen wél gebeld maar nergens een duur
        // is het onbekende geval.
        duur_bekend: bel.length === 0 ? true : duurBekend,
      }),
    };
  });
}

/**
 * HOE ZWAAR WEEGT EEN BEVINDING, EN HOE HEET HIJ.
 *
 * De printweergave kleurt en labelt de bevindingen, en dat mag geen tweede
 * beoordeling worden: dan staat er over een maand iets anders in de PDF dan op
 * het scherm en weet niemand welke van de twee liegt. Daarom hier, naast de
 * plek waar de bevindingen ontstaan.
 *
 * Drie graden, en het onderscheid is met opzet:
 * SCHRIJF OVER HET WERK, NIET OVER DE PERSOON. Dit rapport heet Salesrapport
 * en draagt geen naam van een verkoper meer. Dat is niet alleen de titel: de
 * bevindingen nemen de LEAD als onderwerp ('deze lead kreeg geen poging'),
 * nooit de verkoper ('hij liet deze lead liggen'). Het woord 'nalatigheid' was
 * daar de laatste uitzondering op — dat is een oordeel over een mens, niet een
 * meting aan een lijst.
 *
 *   blijft_liggen — er is werk blijven liggen dat gedaan had moeten worden.
 *   twijfelgeval — er is iets aan de hand, maar het kan net zo goed aan het
 *                  systeem liggen als aan de uitvoering. 'Geen uitkomst
 *                  vastgelegd' is
 *                  daar het schoolvoorbeeld van: dat verschil hebben we op 6
 *                  september juist gerepareerd en het hoort zichtbaar te
 *                  blijven, ook in de kleur.
 *   blinde_vlek  — we hebben niet kunnen kijken. Geen verwijt, wel iets om te
 *                  weten; stilte zou hier als goedkeuring lezen.
 */
const BEVINDING_SOORTEN = {
  // 'TE WEINIG MOEITE' is vervangen door 'TE WEINIG POGINGEN'. Moeite is een
  // eigenschap van een mens; pogingen zijn rijen met een tijdstempel. Alleen
  // het tweede is gemeten.
  niet_behandeld  : { ernst: 'blijft_liggen', label: 'NIET BEHANDELD' },
  te_weinig_moeite: { ernst: 'blijft_liggen', label: 'TE WEINIG POGINGEN' },
  venster_gemist  : { ernst: 'blijft_liggen', label: 'VENSTER GEMIST' },
  venster_te_laat : { ernst: 'twijfelgeval', label: 'TE LAAT' },
  geen_uitkomst   : { ernst: 'twijfelgeval', label: 'GEEN UITKOMST' },
  dubbele_afspraak: { ernst: 'twijfelgeval', label: 'DUBBELE AFSPRAAK' },
  blinde_vlek     : { ernst: 'blinde_vlek',  label: 'BLINDE VLEK' },
};

/** Ernst en label erbij, op één plek voor scherm en print. */
function metErnst(bevinding) {
  const k = BEVINDING_SOORTEN[bevinding.soort]
    // Een onbekende soort krijgt het voorzichtigste oordeel in plaats van het
    // zwaarste: een nieuwe bevinding hoort niet per ongeluk als nalatigheid te
    // beginnen.
    || { ernst: 'twijfelgeval', label: String(bevinding.soort || 'BEVINDING').replace(/_/g, ' ').toUpperCase() };
  return { ...bevinding, ernst: k.ernst, label: k.label };
}

// ── Sectie 1 ───────────────────────────────────────────────────────────────
export function vulAandacht({ aandacht, blindeVlekken, dekking, vensters, zoomcalls, archief }) {
  // ── DE BRUG MOET DEZELFDE MENSEN KENNEN ALS DIT BLOK BEOORDEELT ──────────
  // Dit blok staat bewust VÓÓR de lus hieronder: die zet blinde vlekken om in
  // afwijkingen, en wat er ná die lus bij komt zou alleen in het overzicht
  // onderaan belanden en nooit bovenaan opvallen.
  //
  // Op 8 september bleek dat de leadlijst waarop de brug filtert uitsluitend
  // uit opvolging_taken werd gebouwd, terwijl dit blok leads met een ZOOMCALL
  // beoordeelt. Acht zoomcalls, nul taken: elk spraakbericht naar die mensen
  // werd door de brug weggegooid als 'niet_op_leadlijst' (20 op message_create,
  // 21 op message), en dit blok meldde vervolgens 'geen spraakbericht' over
  // iemand die haar werk wél gedaan had.
  //
  // Voor een dag vóór DEKKING_VANAF is dit dus GEEN bevinding maar een blinde
  // vlek. Het verschil tussen 'niet gedaan' en 'niet gemeten' is de hele reden
  // dat dit rapport bestaat.
  //
  // PER DAG, niet per rapport: een weekrapport dat over de deploy heen loopt
  // hoort de gedekte dagen gewoon te beoordelen en alleen over de dagen ervoor
  // te zwijgen.
  const ongedekteDagen = [
    ...(vensters.rijen || []).map((r) => r.dag),
    ...(vensters.zonder_taak || []).map((r) => r.dag),
  ].filter((d) => !leadlijstDektDag(d));
  if (ongedekteDagen.length) {
    const uniek = [...new Set(ongedekteDagen)].sort();
    blindeVlekken.push({
      sectie: 'vensters',
      wat   : 'Of er een spraakbericht is gestuurd, is voor ' +
              (uniek.length === 1 ? uniek[0] : uniek[0] + ' t/m ' + uniek[uniek.length - 1]) +
              ' niet te meten.',
      waarom: 'De WhatsApp-brug filtert op een leadlijst die tot ' + DEKKING_VANAF +
              ' alleen uit opvolgtaken werd gebouwd. Leads met alleen een zoomcall stonden ' +
              'daar niet in, dus werden hun berichten weggegooid voordat ze geregistreerd ' +
              'konden worden. Dat betekent NIET dat er geen spraakbericht is gestuurd.',
    });
  }

  // EEN BLINDE VLEK IS EEN AFWIJKING. Zonder deze lus zou een sectie die niets
  // kon meten hierboven stil blijven, en dan leest 'geen afwijkingen' als
  // 'alles in orde'. Dat is de duurste fout die dit rapport kan maken.
  for (const bv of blindeVlekken) {
    // 'periode' hoort HIER niet, en dat is de enige uitzondering.
    //
    // 'De dag van vandaag loopt nog' is een eigenschap van de gekozen periode,
    // geen bevinding over Dave. Hij staat al als gele balk bovenaan het rapport
    // — twee keer dezelfde mededeling binnen twee centimeter van elkaar, en de
    // tweede leest bovendien als een verwijt terwijl er niets aan de hand is.
    //
    // Hij blijft wél in `blinde_vlekken` staan: daar hoort het overzicht van wat
    // dit rapport niet weet compleet te zijn. Alleen de aandachtlijst, die over
    // een persoon gaat, slaat hem over.
    if (bv.sectie === 'periode') continue;
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
    // Geen verwijt over een dag waarop de brug de berichten niet eens kon zien.
    if (!leadlijstDektDag(r.dag)) continue;
    if (r.spraak.staat === 'niet_gedaan') {
      aandacht.push({ soort: 'venster_gemist', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} had een zoomcall op ${r.dag} maar kreeg geen spraakbericht.`, uitleg: null, taak_id: r.taak_id });
    } else if (r.spraak.staat === 'te_laat') {
      aandacht.push({ soort: 'venster_te_laat', sectie: 'vensters', naam: r.naam,
        tekst: `Het spraakbericht voor ${r.naam || 'Naamloos'} ging om ${r.spraak.tijd}, na de afspraak van ${String(SPRAAK_DEADLINE_UUR).padStart(2, '0')}:00.`, uitleg: null, taak_id: r.taak_id });
    }
    if (r.nabel.staat === 'niet_gedaan') {
      aandacht.push({ soort: 'venster_gemist', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} kreeg een spraakbericht, antwoordde niet, en is niet nagebeld.`, uitleg: null, taak_id: r.taak_id });
    } else if (r.nabel.staat === 'te_laat') {
      aandacht.push({ soort: 'venster_te_laat', sectie: 'vensters', naam: r.naam,
        tekst: `${r.naam || 'Naamloos'} is om ${r.nabel.tijd} nagebeld, buiten het venster van ${NABEL_VAN_UUR}:00 tot ${NABEL_TOT_UUR}:00.`, uitleg: null, taak_id: r.taak_id });
    }
  }

  // Een status die we niet kennen mag niet beoordeeld worden, maar ook niet
  // verzwegen. follow_up_appointments.status draagt meer waarden dan de
  // CHECK-constraint noemt; komt er een nieuwe bij, dan hoort dat op te vallen
  // in plaats van stil werk te laten verdwijnen.
  const onbeoordeelbaar = zoomcalls.filter((c) => c.staat === 'onbeoordeelbaar');
  if (onbeoordeelbaar.length) {
    const statussen = [...new Set(onbeoordeelbaar.map((c) => c.status_ruw))].join(', ');
    aandacht.push({
      soort: 'blinde_vlek', sectie: 'zoomcalls', naam: null,
      tekst: `${onbeoordeelbaar.length} afspraak${onbeoordeelbaar.length === 1 ? '' : 'en'} heeft een status waarvan niet vaststaat of de call heeft plaatsgevonden.`,
      uitleg: `Status: ${statussen}. Die worden niet beoordeeld — een oordeel zou een gok zijn — maar ze staan wel in de lijst hieronder.`,
    });
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
    // Alleen wat écht te beoordelen is krijgt een oordeel. Een ontbrekende
    // staat telt als te_beoordelen: dan valt een call nooit stilletjes weg, en
    // dat is de stille vorm die dit rapport nergens mag hebben.
    //
    // De andere vier verdwijnen niet uit beeld — geannuleerd en verplaatst
    // staan in de zoomcall-lijst, gepland valt onder 'de dag loopt nog', en
    // onbeoordeelbaar krijgt hieronder zijn eigen blinde vlek.
    if (c.staat && c.staat !== 'te_beoordelen') continue;
    if (alGemeld.has(c.appointment_id)) continue;
    if (!c.vastgelegd) {
      aandacht.push({
        soort: 'geen_uitkomst', sectie: 'zoomcalls', naam: c.naam,
        // De formulering is met opzet passief: het kan aan Dave liggen én aan
        // het systeem, en dat verschil weten we hier niet.
        tekst: `Voor de zoomcall met ${c.naam || 'onbekend'} op ${c.dag} is geen uitkomst vastgelegd.`,
        uitleg: c.reden_leeg, appointment_id: c.appointment_id,
      });
    }
  }

  // Gearchiveerd zonder dat er ooit een gespreksduur gemeten is. Geen verwijt —
  // we weten het niet — maar ook niet verzwijgen, want dan leest stilte als
  // goedkeuring.
  const zonderDuur = archief.filter((a) => a.moeite && a.moeite.staat === 'onbekend');
  if (zonderDuur.length) {
    aandacht.push({
      soort: 'blinde_vlek', sectie: 'archief', naam: null,
      tekst: `Bij ${zonderDuur.length} uit de lijst gehaalde lead${zonderDuur.length === 1 ? '' : 's'} is van geen enkele call de duur vastgelegd.`,
      uitleg: 'Of er genoeg moeite gedaan is valt daarover niet te zeggen. duur_sec wordt alleen gevuld door calls die via de softphone-koppeling binnenkwamen; deze zijn handmatig geregistreerd.',
    });
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
