// tests/opvolging-leadlijst-zoomcalls.test.js
//
// HET RAPPORT MAT EEN VERZAMELING WAAR DE BRUG NOOIT VAN GEHOORD HAD.
//
// Gemeten op 8 september: acht zoomcalls, en voor geen van die leads een
// opvolgtaak. De leadlijst waarop de brug filtert werd uitsluitend uit
// opvolging_taken gebouwd, dus de brug kende die mensen niet en gooide elk
// bericht weg als 'niet_op_leadlijst' — 20 op message_create, 21 op message.
// Ondertussen beoordeelt sectie 3 juist leads met een ZOOMCALL.
//
// Dat is geen storing: het privacyfilter deed precies wat het moet doen. De
// fout zat in de twee verschillende verzamelingen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  venster, valtInVenster, VENSTER_TERUG_DAGEN, VENSTER_VOORUIT_DAGEN, LEVENDE_STATUSSEN,
  leadlijstDektDag, DEKKING_VANAF,
} from '../api/_lib/opvolging-leadlijst-venster.js';

const NU = Date.parse('2026-09-08T09:00:00Z');
const dagen = (n) => new Date(NU + n * 86400000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// HET VENSTER — de privacygrens mag niet stilletjes opschuiven
// ═══════════════════════════════════════════════════════════════════════════

test('een zoomcall van vandaag zit in het venster', () => {
  assert.equal(valtInVenster(dagen(0), NU), true);
});

test('een zoomcall van morgen zit erin', () => {
  assert.equal(valtInVenster(dagen(1), NU), true);
});

test('een zoomcall van gisteren zit erin — het bericht kan de avond ervoor zijn gegaan', () => {
  assert.equal(valtInVenster(dagen(-0.5), NU), true);
});

test('een afspraak van DRIE MAANDEN geleden zit er NIET in', () => {
  // Dit is de test die de grens vastlegt. Zonder hem schuift het venster ooit
  // stilletijk op en verbreedt de privacygrens zonder dat iemand het merkt.
  assert.equal(valtInVenster(dagen(-90), NU), false);
});

test('een afspraak over een maand zit er ook niet in', () => {
  // Die komt vanzelf in beeld als de dag nadert.
  assert.equal(valtInVenster(dagen(30), NU), false);
});

test('het venster blijft krap — dit is een privacygrens, geen adresboek', () => {
  assert.ok(VENSTER_TERUG_DAGEN <= 2, 'terug: ' + VENSTER_TERUG_DAGEN);
  assert.ok(VENSTER_VOORUIT_DAGEN <= 7, 'vooruit: ' + VENSTER_VOORUIT_DAGEN);
  const { vanIso, totIso } = venster(NU);
  const breedteDagen = (Date.parse(totIso) - Date.parse(vanIso)) / 86400000;
  assert.ok(breedteDagen <= 9, 'het venster is ' + breedteDagen + ' dagen breed');
});

test('een geannuleerde afspraak hoort niet bij de levende statussen', () => {
  assert.ok(!LEVENDE_STATUSSEN.includes('cancelled'));
  assert.ok(LEVENDE_STATUSSEN.includes('scheduled'));
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP HET PAD DAT DE BRUG ECHT LEEST
// ═══════════════════════════════════════════════════════════════════════════

test('de leadlijst haalt óók de zoomcall-nummers op, binnen het venster', () => {
  const bron = readFileSync('api/opvolging-whatsapp-nummers.js', 'utf8');
  assert.match(bron, /from\('follow_up_appointments'\)/,
    'zonder deze bron kent de brug de zoomcall-leads niet');
  assert.match(bron, /\.gte\('scheduled_at', vanIso\)\.lte\('scheduled_at', totIso\)/,
    'en dan wel binnen het krappe venster');
  assert.match(bron, /\.in\('status', LEVENDE_STATUSSEN\)/);
});

test('de vorm van het antwoord verandert niet: alleen cijferreeksen', () => {
  const bron = readFileSync('api/opvolging-whatsapp-nummers.js', 'utf8');
  // Alleen lead_phone wordt opgehaald — geen namen, geen ids.
  assert.match(bron, /\.select\('lead_phone'\)/);
  assert.doesNotMatch(bron, /select\('lead_name/);
  // En hij blijft achter het gedeelde geheim zitten.
  assert.match(bron, /brugGeheimKlopt\(req\)/);
});

test('de nummers worden nog steeds genormaliseerd voor ze de lijst in gaan', () => {
  const bron = readFileSync('api/opvolging-whatsapp-nummers.js', 'utf8');
  assert.match(bron, /normaliseerNummer\(rij\.lead_phone\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN HET RAPPORT VERWIJT NIETS WAT HET NIET GEMETEN HEEFT
// ═══════════════════════════════════════════════════════════════════════════

// Dagen aan weerszijden van de grens, afgeleid uit de constante zelf. Zou de
// test de datum hardcoderen, dan verschuift hij mee met een typefout in de
// productiecode in plaats van hem te betrappen.
const DAG_GEDEKT = DEKKING_VANAF;
const DAG_ONGEDEKT = new Date(Date.parse(DEKKING_VANAF + 'T12:00:00Z') - 86400000)
  .toISOString().slice(0, 10);

test('de dekkingsgrens ligt op DEKKING_VANAF, en lapst dus vanzelf', () => {
  assert.equal(leadlijstDektDag(DAG_GEDEKT), true);
  assert.equal(leadlijstDektDag(DAG_ONGEDEKT), false);
  // Een onbekende dag is niet meetbaar, niet 'wel gedekt'.
  assert.equal(leadlijstDektDag(null), false);
  assert.equal(leadlijstDektDag('gisteren'), false);
});

function draaiVulAandacht(dag, extra = {}) {
  const aandacht = []; const blindeVlekken = [];
  return import('../api/opvolging-rapport.js').then(({ vulAandacht }) => {
    vulAandacht({
      aandacht, blindeVlekken,
      dekking: { openstaand: [], onbehandeld: [], behandeld: [] },
      vensters: {
        rijen: [{ naam: 'Martin Van Pijkeren', dag, taak_id: 't1',
          spraak: { staat: 'niet_gedaan' }, nabel: { staat: 'niet_nodig' } }],
        zonder_taak: [],
        ...extra,
      },
      zoomcalls: [], archief: [],
    });
    return { aandacht, blindeVlekken };
  });
}

test('op een dag VOOR de dekking is het spraakvenster een BLINDE VLEK, geen verwijt', async () => {
  const { aandacht, blindeVlekken } = await draaiVulAandacht(DAG_ONGEDEKT);
  assert.equal(aandacht.filter((a) => a.soort === 'venster_gemist').length, 0,
    'geen verwijt over iets wat niet gemeten kon worden');
  const bv = blindeVlekken.find((b) => b.sectie === 'vensters');
  assert.ok(bv, 'wel een blinde vlek');
  assert.match(bv.waarom, /NIET dat er geen spraakbericht is gestuurd/);
  // En de blinde vlek komt ook als afwijking bovenaan te staan.
  assert.ok(aandacht.some((a) => a.soort === 'blinde_vlek' && a.sectie === 'vensters'));
});

test('op een dag VANAF de dekking blijft het verwijt gewoon staan', async () => {
  const { aandacht, blindeVlekken } = await draaiVulAandacht(DAG_GEDEKT);
  assert.equal(aandacht.filter((a) => a.soort === 'venster_gemist').length, 1);
  assert.equal(blindeVlekken.filter((b) => b.sectie === 'vensters').length, 0);
});

test('een weekrapport over de grens heen zwijgt alleen over de ongedekte dag', async () => {
  // Anders kost één oude dag in het bereik het oordeel over alle andere.
  const { vulAandacht } = await import('../api/opvolging-rapport.js');
  const aandacht = []; const blindeVlekken = [];
  vulAandacht({
    aandacht, blindeVlekken,
    dekking: { openstaand: [], onbehandeld: [], behandeld: [] },
    vensters: {
      rijen: [
        { naam: 'Oud', dag: DAG_ONGEDEKT, spraak: { staat: 'niet_gedaan' }, nabel: { staat: 'niet_nodig' } },
        { naam: 'Nieuw', dag: DAG_GEDEKT, spraak: { staat: 'niet_gedaan' }, nabel: { staat: 'niet_nodig' } },
      ],
      zonder_taak: [],
    },
    zoomcalls: [], archief: [],
  });
  const gemist = aandacht.filter((a) => a.soort === 'venster_gemist');
  assert.equal(gemist.length, 1);
  assert.equal(gemist[0].naam, 'Nieuw');
  assert.equal(blindeVlekken.filter((b) => b.sectie === 'vensters').length, 1);
});

test('acht zoomcalls zonder taak op een ongedekte dag geven ook een blinde vlek', async () => {
  // Dit is de gemeten situatie van 8 september: nul rijen, acht zonder_taak.
  // Zonder deze regel zwijgt sectie 3 en leest dat als 'niets aan de hand'.
  const { vulAandacht } = await import('../api/opvolging-rapport.js');
  const aandacht = []; const blindeVlekken = [];
  vulAandacht({
    aandacht, blindeVlekken,
    dekking: { openstaand: [], onbehandeld: [], behandeld: [] },
    vensters: {
      rijen: [],
      zonder_taak: Array.from({ length: 8 }, (_, i) => ({ naam: 'Lead ' + i, dag: DAG_ONGEDEKT })),
    },
    zoomcalls: [], archief: [],
  });
  assert.ok(blindeVlekken.some((b) => b.sectie === 'vensters'));
});
