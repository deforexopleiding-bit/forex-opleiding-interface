// tests/opvolging-spraak-zoomleads.test.js
//
// HET SPRAAKBERICHT NAAR EEN ZOOMLEAD WERD NERGENS GEMETEN.
//
// Gemeten op 10 september in productie. De brug deed zijn werk: 118 op
// webhook.verstuurd, 36 doorgelaten op message_create. Maar
// api/opvolging-whatsapp-webhook.js deed `if (!taak) return gekoppeld:false` en
// gooide het bericht weg. Zoomleads hebben meestal geen opvolgtaak — ze boeken
// zelf een call en komen nooit in de werklijst — dus gaf
// /api/opvolging-whatsapp-gesprek?nummer= nul regels voor Rani (31641440096),
// Nadia (32494113391), Nive (32484533550) en Claudia (31624270002).
//
// Het scherm zei daarom '7 ingeplande calls, maar geen ervan staat in de
// takenlijst'. Dat is een nul die eruitziet als een meting.
//
// ── DE TWEE HELFTEN, EN WAAROM ZE NIET HETZELFDE ZIJN ────────────────────
// Een SPRAAKBERICHT hangt aan een NUMMER: dat staat in opvolging_wa_berichten
// en heeft geen kaart nodig. Een BELPOGING hangt aan een TAAK: die staat in
// opvolging_pogingen en bestaat zonder kaart niet. Voor een zoomlead zonder
// kaart is het spraakbericht dus wél te meten en het nabellen niet — en
// 'niet gebeld' zou daar geraden zijn.
//
// Deze test legt beide helften vast, plus de dekkingsgrens: op een dag vóór
// DEKKING_VANAF gooide de webhook nog weg, en dan blijft het een blinde vlek.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SPRAAK_TYPES, regelAlsPoging, regelsVoorNummer, waPogingenVoorNummer, haalWaRegels,
} from '../api/_lib/opvolging-call-wa.js';
import { beoordeelSpraak, beoordeelNabel, telVensters } from '../api/_lib/opvolging-vensters.js';
import { bouwVensters } from '../api/opvolging-rapport.js';
import { DEKKING_VANAF, leadlijstDektDag } from '../api/_lib/opvolging-leadlijst-venster.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Een dag waarop de webhook de berichten bewaart, en de dag ervoor.
const DAG = DEKKING_VANAF;
const DAG_ONGEDEKT = new Date(Date.parse(DEKKING_VANAF + 'T12:00:00Z') - 86400000)
  .toISOString().slice(0, 10);

/** Amsterdamse tijd op DAG als ISO. September = zomertijd, dus UTC+2. */
const op = (hh, mm = 0, dag = DAG) =>
  new Date(Date.parse(`${dag}T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`)).toISOString();

const regel = (over) => ({
  nummer: '31641440096', richting: 'uit', media_type: 'ptt', tijdstip: op(8, 12), ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN GESPREKSREGEL WORDT EEN POGING
// ═══════════════════════════════════════════════════════════════════════════

test('een ptt-bericht wordt een spraakbericht-poging', () => {
  const p = regelAlsPoging(regel());
  assert.equal(p.soort, 'spraakbericht');
  assert.equal(p.richting, 'uit');
  assert.equal(p.tijdstip, op(8, 12));
  assert.equal(p.bron, 'wa_bericht', 'herkenbaar als niet-uit-opvolging_pogingen');
});

test('audio en voice tellen ook als spraakbericht, chat niet', () => {
  for (const t of ['ptt', 'audio', 'voice', 'PTT']) {
    assert.equal(regelAlsPoging(regel({ media_type: t })).soort, 'spraakbericht', t);
  }
  assert.equal(regelAlsPoging(regel({ media_type: 'chat' })).soort, 'whatsapp');
  assert.equal(regelAlsPoging(regel({ media_type: null })).soort, 'whatsapp');
  assert.deepEqual([...SPRAAK_TYPES].sort(), ['audio', 'ptt', 'voice']);
});

test('inkomend blijft inkomend, al de rest is uitgaand', () => {
  assert.equal(regelAlsPoging(regel({ richting: 'in' })).richting, 'in');
  assert.equal(regelAlsPoging(regel({ richting: 'uit' })).richting, 'uit');
  assert.equal(regelAlsPoging(regel({ richting: null })).richting, 'uit');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET NUMMER — lokaal genoteerd of met landcode
// ═══════════════════════════════════════════════════════════════════════════

test('een lokaal genoteerd nummer vindt de regels met landcode', () => {
  const regels = [regel({ nummer: '31641440096' })];
  assert.equal(regelsVoorNummer(regels, '0641440096').length, 1, 'lokaal → landcode');
  assert.equal(regelsVoorNummer(regels, '+31 641 440 096').length, 1, 'met opmaak');
  assert.equal(regelsVoorNummer(regels, '0031641440096').length, 1, '00-prefix');
});

test('een ander nummer levert niets op', () => {
  const regels = [regel({ nummer: '31641440096' })];
  assert.equal(regelsVoorNummer(regels, '32494113391').length, 0);
  assert.equal(regelsVoorNummer(regels, null).length, 0);
  assert.equal(regelsVoorNummer(null, '31641440096').length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WEBHOOK — bewaren zonder taak, maar geen poging
// ═══════════════════════════════════════════════════════════════════════════

test('de webhook-tak zonder taak bewaart de gespreksregel en schrijft GEEN poging', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  const i = bron.indexOf('if (!taak) {');
  assert.ok(i > 0, 'de tak zonder taak hoort te bestaan');
  const blok = bron.slice(i, i + 500);

  assert.match(blok, /bewaarGesprekRegel\(\{/, 'de gespreksregel gaat door');
  assert.match(blok, /taakId: null/, 'met taak_id NULL — de kolom is nullable');
  assert.match(blok, /gekoppeld: false, bewaard/, 'het antwoord blijft gekoppeld:false');
  assert.doesNotMatch(blok, /opvolging_pogingen/,
    'GEEN poging: die hoort bij een kaart, en zonder kaart valt er niets in te tellen');
});

test('de kop zegt niet meer dat onbekende nummers stil genegeerd worden', () => {
  // Wat hier binnenkomt heeft het leadlijstfilter van de brug al gepasseerd.
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  assert.doesNotMatch(bron, /ONBEKENDE NUMMERS WORDEN STIL GENEGEERD/);
  assert.match(bron, /leadlijstfilter van de brug al gepasseerd/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET OORDEEL — met de bestaande beoordeelSpraak/beoordeelNabel
// ═══════════════════════════════════════════════════════════════════════════

test('een zoomlead zonder taak met een ptt om 08:12 staat op OP TIJD', () => {
  // Dit is het geval van Rani. Geen kaart, dus geen poging — maar wel een
  // gespreksregel, en die maakt het meetbaar.
  const pog = waPogingenVoorNummer([regel({ tijdstip: op(8, 12) })], '0641440096');
  assert.equal(beoordeelSpraak(pog, DAG).staat, 'op_tijd');
  assert.equal(beoordeelSpraak(pog, DAG).tijd, '08:12');
});

test('een ptt om 09:30 is te laat', () => {
  const pog = waPogingenVoorNummer([regel({ tijdstip: op(9, 30) })], '0641440096');
  assert.equal(beoordeelSpraak(pog, DAG).staat, 'te_laat');
});

test('zonder berichten is het spraakbericht niet gedaan', () => {
  assert.equal(beoordeelSpraak(waPogingenVoorNummer([], '0641440096'), DAG).staat, 'niet_gedaan');
});

// ═══════════════════════════════════════════════════════════════════════════
// NABELLEN ZONDER KAART IS NIET GEMETEN
// ═══════════════════════════════════════════════════════════════════════════

test('spraak zonder antwoord en zonder kaart → nabel niet_gemeten, niet_gedaan blijft 0', () => {
  // DE KERN VAN DEZE HELE PR. Een belpoging hangt aan een taak; zonder kaart
  // zou 'niet gebeld' geraden zijn. Het spraakbericht telt wél gewoon mee.
  const pog = waPogingenVoorNummer([regel({ tijdstip: op(8, 12) })], '0641440096');
  const t = telVensters([{ id: 'nr:31641440096', zonderKaart: true, pogingen: pog }], DAG);

  assert.equal(t.spraak.op_tijd, 1, 'het spraakbericht is wél gemeten');
  assert.equal(t.nabel.niet_gemeten, 1);
  assert.equal(t.nabel.niet_gedaan, 0, 'geen verwijt over iets wat we niet konden zien');
  assert.equal(t.nabel.totaal, 0, 'en het telt niet mee in de dekking');
});

test('mét kaart en een call om 12:20 → nabel op tijd, en het spraakbericht van vóór de kaart telt gewoon', () => {
  // De pogingen van de kaart en de gespreksregels gaan op één hoop: het is
  // dezelfde lead, en welke bron een bericht heeft is voor het oordeel niet
  // relevant.
  const waPog = waPogingenVoorNummer([regel({ tijdstip: op(8, 12) })], '0641440096');
  const kaartPog = [{ soort: 'call', richting: 'uit', tijdstip: op(12, 20) }];
  const t = telVensters([{ id: 't1', zonderKaart: false, pogingen: kaartPog.concat(waPog) }], DAG);

  assert.equal(t.spraak.op_tijd, 1);
  assert.equal(t.nabel.op_tijd, 1);
  assert.equal(t.nabel.niet_gemeten, 0);
});

test('wie antwoordde hoeft niet nagebeld — ook zonder kaart', () => {
  const pog = waPogingenVoorNummer([
    regel({ tijdstip: op(8, 12) }),
    regel({ tijdstip: op(9, 5), richting: 'in', media_type: 'chat' }),
  ], '0641440096');
  const n = beoordeelNabel(pog, DAG);
  assert.equal(n.staat, 'niet_nodig');
  assert.equal(n.reden, 'heeft geantwoord');

  const t = telVensters([{ id: 'nr:x', zonderKaart: true, pogingen: pog }], DAG);
  assert.equal(t.nabel.niet_nodig, 1);
  assert.equal(t.nabel.niet_gemeten, 0, 'antwoord is een meting, geen gat');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DEKKINGSGRENS — vóór DEKKING_VANAF gooide de webhook nog weg
// ═══════════════════════════════════════════════════════════════════════════

test('op een dag vóór de dekking blijft een call zonder taak een blinde vlek', () => {
  assert.equal(leadlijstDektDag(DAG_ONGEDEKT), false);
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Rani', lead_phone: '31641440096', scheduled_at: op(15, 0, DAG_ONGEDEKT) }],
    taken: [], pogingen: [], dagen: [DAG_ONGEDEKT],
    waRegels: [regel({ tijdstip: op(8, 12, DAG_ONGEDEKT) })],
  });
  assert.equal(v.rijen.length, 0);
  assert.equal(v.zonder_taak.length, 1, 'zonder_taak, precies zoals voorheen');
});

test('waRegels null (leesfout) laat een call zonder taak ook onbeoordeeld', () => {
  // Null en [] zijn niet hetzelfde: leeg betekent 'er ging niets', null
  // betekent 'we weten het niet'.
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Rani', lead_phone: '31641440096', scheduled_at: op(15) }],
    taken: [], pogingen: [], dagen: [DAG], waRegels: null,
  });
  assert.equal(v.rijen.length, 0);
  assert.equal(v.zonder_taak.length, 1);
});

test('DEKKING_VANAF is opgeschoven naar 11 september, met de reden erbij', () => {
  // De brug liet de zoomcall-leads vanaf de 9e door, maar de webhook gooide ze
  // daarna alsnog weg. 11 september is de eerste ochtend ná deze fix.
  assert.equal(DEKKING_VANAF, '2026-09-11');
  const bron = readFileSync(join(ROOT, 'api/_lib/opvolging-leadlijst-venster.js'), 'utf8');
  assert.match(bron, /11 SEPTEMBER, NIET 9/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET RAPPORT — de rijen dragen taak_id null, de tellingen kloppen met de lijst
// ═══════════════════════════════════════════════════════════════════════════

test('een zoomlead zonder taak krijgt een rij met taak_id null en een gemeten spraakoordeel', () => {
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Rani', lead_phone: '31641440096', scheduled_at: op(15) }],
    taken: [], pogingen: [], dagen: [DAG],
    waRegels: [regel({ tijdstip: op(8, 12) })],
  });
  assert.equal(v.zonder_taak.length, 0, 'hij is nu wél te beoordelen');
  assert.equal(v.rijen.length, 1);

  const [r] = v.rijen;
  assert.equal(r.taak_id, null, 'geen verzonnen id — de rij zegt dat er geen kaart is');
  assert.equal(r.naam, 'Rani');
  assert.equal(r.spraak.staat, 'op_tijd');
  assert.equal(r.nabel.staat, 'niet_gemeten');
  assert.equal(r.nabel.reden, 'geen opvolgtaak, dus belpogingen niet zichtbaar');
});

test('de tellingen zijn precies de rij-oordelen — geen tweede berekening ernaast', () => {
  const v = bouwVensters({
    afspraken: [
      { id: 'a1', lead_name: 'Rani',  lead_phone: '31641440096', scheduled_at: op(15) },
      { id: 'a2', lead_name: 'Nadia', lead_phone: '32494113391', scheduled_at: op(16) },
      { id: 'a3', lead_name: 'Nive',  lead_phone: '32484533550', scheduled_at: op(17) },
    ],
    taken: [], pogingen: [], dagen: [DAG],
    waRegels: [
      regel({ nummer: '31641440096', tijdstip: op(8, 12) }),   // op tijd
      regel({ nummer: '32494113391', tijdstip: op(9, 40) }),   // te laat
      // Nive kreeg niets.
    ],
  });

  assert.equal(v.rijen.length, 3);
  assert.equal(v.spraak.totaal, 3);
  assert.equal(v.spraak.op_tijd, 1);
  assert.equal(v.spraak.te_laat, 1);
  assert.equal(v.spraak.niet_gedaan, 1);

  // Nive kreeg geen spraakbericht → nabellen was niet nodig. De andere twee
  // hebben geen kaart → niet gemeten.
  assert.equal(v.nabel.niet_gemeten, 2);
  assert.equal(v.nabel_niet_gemeten, 2, 'ook los benoemd in het antwoord');
  assert.equal(v.nabel.niet_nodig, 1);
  assert.equal(v.nabel.totaal, 0);

  // De optelling MOET de lijst zijn, anders lopen scherm en rapport uiteen.
  const uitLijst = { op_tijd: 0, te_laat: 0, niet_gedaan: 0 };
  for (const r of v.rijen) uitLijst[r.spraak.staat] += 1;
  assert.deepEqual(uitLijst, { op_tijd: 1, te_laat: 1, niet_gedaan: 1 });
});

test('twee calls voor hetzelfde nummer op één dag leveren één rij op', () => {
  const v = bouwVensters({
    afspraken: [
      { id: 'a1', lead_name: 'Rani', lead_phone: '31641440096', scheduled_at: op(10) },
      { id: 'a2', lead_name: 'Rani', lead_phone: '0641440096',  scheduled_at: op(15) },
    ],
    taken: [], pogingen: [], dagen: [DAG],
    waRegels: [regel({ tijdstip: op(8, 12) })],
  });
  assert.equal(v.rijen.length, 1, 'lokaal en met landcode is dezelfde persoon');
  assert.equal(v.spraak.totaal, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// haalWaRegels — geen tekst, en een fout is een fout
// ═══════════════════════════════════════════════════════════════════════════

test('haalWaRegels leest geen tekst mee', async () => {
  let gevraagd = null;
  const db = {
    from() {
      return {
        select(k) { gevraagd = k; return this; },
        gte() { return this; },
        lt() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: [regel()], error: null }); },
      };
    },
  };
  const { regels, fout } = await haalWaRegels(db, DAG + 'T00:00:00.000Z', DAG + 'T23:59:59.000Z');
  assert.equal(fout, null);
  assert.equal(regels.length, 1);
  assert.doesNotMatch(gevraagd, /tekst/, 'de inhoud van een gesprek hoort niet in een telling');
  assert.match(gevraagd, /nummer/);
  assert.match(gevraagd, /media_type/);
});

test('een leesfout komt als fout terug, niet als lege lijst', async () => {
  const db = {
    from() {
      return {
        select() { return this; }, gte() { return this; }, lt() { return this; },
        order() { return this; },
        limit() { return Promise.resolve({ data: null, error: { message: 'relatie bestaat niet' } }); },
      };
    },
  };
  const { regels, fout } = await haalWaRegels(db, DAG + 'T00:00:00.000Z', DAG + 'T23:59:59.000Z');
  assert.deepEqual(regels, []);
  assert.match(String(fout), /relatie bestaat niet/,
    'een lege lijst zou als "er ging geen spraakbericht" lezen');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING — server hangt wa aan de call, view rekent per call
// ═══════════════════════════════════════════════════════════════════════════

test('de agenda hangt de WhatsApp-pogingen aan elke geplande call', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  assert.match(bron, /const waMelding = await hangWhatsAppAanCalls\(dagen, van, tot\)/);
  assert.match(bron, /wa_melding\s*:\s*waMelding/);
  // supabaseAdmin, niet de user-client: een RLS-nul zou als 'geen
  // spraakbericht' lezen.
  const i = bron.indexOf('async function hangWhatsAppAanCalls');
  const blok = bron.slice(i, i + 2000);
  assert.match(blok, /haalWaRegels\(supabaseAdmin,/);
  assert.match(blok, /leadlijstDektDag/, 'alleen dagen die de leadlijst dekt');
  assert.match(blok, /call\.wa = null/, 'null als er niets gemeten is');
});

test('de view beoordeelt per CALL en filtert wat niet doorgaat', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(bron, /function vensterTaakVoorCall\(c\)/);
  assert.match(bron, /if \(!Array\.isArray\(c && c\.wa\)\) return taak;/,
    'niet gemeten → terugval op het oude gedrag');
  assert.match(bron, /zonderKaart: !taak/);
  assert.match(bron, /const calls = \(_calls\.data \|\| \[\]\)\.filter\(callGaatDoor\)/);
  assert.match(bron, /function spraakRegel\(c, dag\)/);
  assert.match(bron, /Nog geen spraakbericht/);
  assert.match(bron, /heeft geantwoord/);
});

test('de spraakregel gebruikt inZone en niet iso() — UTC schuift een dag', () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = bron.indexOf('function spraakRegel(c, dag)');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1200);
  // beoordeelSpraak/beoordeelNabel rekenen zelf via inZone; de regel mag er
  // geen eigen dagvergelijking naast zetten.
  assert.doesNotMatch(blok, /iso\(/, 'geen UTC-dagvergelijking in deze functie');
  assert.match(blok, /beoordeelSpraak\(pog, dag\)/);
  assert.match(blok, /beoordeelNabel\(pog, dag\)/);
});

test("het lege venster-blok zegt 'wordt nog niet gemeten', niet 'staat niet in de takenlijst'", () => {
  const bron = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = bron.indexOf('// geen_taken:');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /nogNietGemeten\(wat,/);
  assert.doesNotMatch(blok, /maar geen ervan staat in de takenlijst/);
});
