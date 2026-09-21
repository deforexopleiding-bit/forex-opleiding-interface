// tests/iris-joost-pauze.test.js
//
// De aanmaanmotor zwijgt als Iris een betaalafspraak heeft vastgelegd.
//
// ── WAT HIER BEWEZEN MOET WORDEN ─────────────────────────────────────────────
// Sectie 6 van de opdracht is hier uitdrukkelijk: deze haak komt met tests
// "die aantonen dat Joost bij flag uit of zonder belofte exact hetzelfde doet".
// Dat is de reden dat dit bestand bestaat, en het is de eerste groep tests
// hieronder.
//
// Iris draait NAAST de aanmaanmotor, niet bovenop hem. Zolang de schakelaar
// uit staat mag er geen opvraging gedaan worden, geen logregel geschreven, en
// geen enkele beslissing veranderen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAUZE_CODE,
  PAUZE_EVENT,
  pauzeAan,
  isActieveBelofte,
  haalIrisPauzeStand,
  irisPauzeBlokkade,
  pauzeStandSamenvatting,
} from '../api/_lib/iris/joost-pauze.js';

const VANDAAG = '2026-09-21';

/** Een client die meetelt hoe vaak er iets opgevraagd wordt. */
function tellendeDb(rijen, fout = null) {
  const teller = { opvragingen: 0 };
  const db = {
    from() {
      teller.opvragingen++;
      const b = {
        select: () => b,
        eq: () => b,
        gte: async () => (fout ? { data: null, error: { message: fout } } : { data: rijen, error: null }),
      };
      return b;
    },
  };
  return { db, teller };
}

const BELOFTE = {
  id: 'b1', contact_id: 'c1', customer_id: 'k1',
  bedrag: 450, datum: '2026-09-25', status: 'actief', bron: 'klant',
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. MET DE SCHAKELAAR UIT VERANDERT ER NIETS
// ═══════════════════════════════════════════════════════════════════════════

test('schakelaar uit: er wordt GEEN ENKELE opvraging gedaan', async () => {
  // Dit is scherper dan "de blokkade is null". Zou er wél opgevraagd worden,
  // dan kost elke aanmaanronde een extra rondje naar de databank voor iets
  // wat toch niets doet — en dan is de vlag geen echte vlag.
  const { db, teller } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: {}, vandaagIso: VANDAAG });
  assert.equal(teller.opvragingen, 0, 'met de vlag uit hoort er niets opgevraagd te worden');
  assert.equal(stand.aan, false);
});

test('schakelaar uit: er is nooit een blokkade, ook niet met een lopende belofte', async () => {
  const { db } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'false' }, vandaagIso: VANDAAG });
  assert.equal(irisPauzeBlokkade(stand, 'k1'), null);
});

test('schakelaar uit: alles wat op true lijkt maar het niet is, telt als uit', async () => {
  for (const v of ['1', 'ja', 'yes', 'aan', 'True!', '', undefined]) {
    const { db, teller } = tellendeDb([BELOFTE]);
    const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: v }, vandaagIso: VANDAAG });
    assert.equal(stand.aan, false, `"${v}" hoorde uit te staan`);
    assert.equal(teller.opvragingen, 0);
    assert.equal(irisPauzeBlokkade(stand, 'k1'), null);
  }
});

test('pauzeAan: alleen de letterlijke tekst true', () => {
  assert.equal(pauzeAan({ IRIS_PAUZEERT_JOOST: 'true' }), true);
  assert.equal(pauzeAan({ IRIS_PAUZEERT_JOOST: ' TRUE ' }), true);
  assert.equal(pauzeAan({}), false);
  assert.equal(pauzeAan(undefined), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. MET DE SCHAKELAAR AAN, MAAR ZONDER BELOFTE, VERANDERT ER OOK NIETS
// ═══════════════════════════════════════════════════════════════════════════

test('schakelaar aan, geen beloftes: geen blokkade voor wie dan ook', async () => {
  const { db } = tellendeDb([]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.equal(stand.aan, true);
  assert.equal(stand.beloftes.size, 0);
  assert.equal(irisPauzeBlokkade(stand, 'k1'), null);
  assert.equal(irisPauzeBlokkade(stand, 'k2'), null);
});

test('schakelaar aan: een klant ZONDER belofte wordt niet geblokkeerd', async () => {
  const { db } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.ok(irisPauzeBlokkade(stand, 'k1'), 'k1 heeft wel een belofte');
  assert.equal(irisPauzeBlokkade(stand, 'k2'), null, 'k2 heeft er geen en hoort door te lopen');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. WANNEER HIJ WEL BLOKKEERT
// ═══════════════════════════════════════════════════════════════════════════

test('een lopende belofte blokkeert, met een leesbare reden', async () => {
  const { db } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  const blok = irisPauzeBlokkade(stand, 'k1');
  assert.equal(blok.code, PAUZE_CODE);
  assert.equal(blok.event, PAUZE_EVENT);
  assert.match(blok.reden, /450\.00/);
  assert.match(blok.reden, /2026-09-25/);
  assert.equal(blok.tot, '2026-09-25');
});

test('een belofte zonder bedrag blokkeert ook, zonder een bedrag te verzinnen', async () => {
  const { db } = tellendeDb([{ ...BELOFTE, bedrag: null }]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  const blok = irisPauzeBlokkade(stand, 'k1');
  assert.ok(blok);
  assert.equal(blok.bedrag, null);
  assert.doesNotMatch(blok.reden, /€/, 'geen bedrag noemen als we er geen hebben');
});

test('de beloofde dag zelf telt nog mee', () => {
  // Wie zegt "ik betaal vrijdag" hoort op vrijdag geen aanmaning te krijgen
  // omdat het al middag is. De dag is dan nog niet voorbij.
  assert.equal(isActieveBelofte({ status: 'actief', datum: '2026-09-21' }, '2026-09-21'), true);
});

test('de dag ná de belofte telt niet meer mee', () => {
  assert.equal(isActieveBelofte({ status: 'actief', datum: '2026-09-20' }, '2026-09-21'), false);
});

test('alleen een ACTIEVE belofte blokkeert', () => {
  for (const status of ['nagekomen', 'gebroken', 'geannuleerd', '', null]) {
    assert.equal(isActieveBelofte({ status, datum: '2026-09-25' }, VANDAAG), false, `status "${status}" hoorde niet te blokkeren`);
  }
});

test('een belofte zonder datum blokkeert niet', () => {
  assert.equal(isActieveBelofte({ status: 'actief', datum: null }, VANDAAG), false);
  assert.equal(isActieveBelofte({ status: 'actief' }, VANDAAG), false);
});

test('rommel in plaats van een rij blokkeert niet', () => {
  for (const v of [null, undefined, 'actief', 42]) {
    assert.equal(isActieveBelofte(v, VANDAAG), false);
  }
});

test('een belofte zonder klant kan niets pauzeren en valt weg', async () => {
  const { db } = tellendeDb([{ ...BELOFTE, customer_id: null }]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.equal(stand.beloftes.size, 0);
});

test('bij twee beloftes voor één klant wint de VERSTE datum', async () => {
  // Wie twee keer uitstel kreeg, heeft tot de verste datum de tijd. De eerste
  // laten winnen zou betekenen dat de tweede afspraak niets waard is.
  const { db } = tellendeDb([
    { ...BELOFTE, id: 'b1', datum: '2026-09-23' },
    { ...BELOFTE, id: 'b2', datum: '2026-09-30' },
  ]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  const blok = irisPauzeBlokkade(stand, 'k1');
  assert.equal(blok.tot, '2026-09-30');
  assert.equal(blok.belofte_id, 'b2');
});

test('zonder klant-id is er geen blokkade — die vraag is niet te beantwoorden', async () => {
  const { db } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.equal(irisPauzeBlokkade(stand, null), null);
  assert.equal(irisPauzeBlokkade(stand, ''), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. FAIL-OPEN, EN WAAROM DAT HIER ANDERS LIGT
// ═══════════════════════════════════════════════════════════════════════════

test('een leesfout laat de motor DOORLOPEN, niet stilvallen', async () => {
  // Anders dan lms-stilte.js, die fail-closed valt. De redenering staat in
  // api/_lib/iris/joost-pauze.js: fail-closed zou betekenen dat een fout in
  // een gloednieuwe tabel de hele bestaande aanmaanmotor stillegt, en dat is
  // precies de koppeling die de opdracht verbiedt.
  const { db } = tellendeDb(null, 'tabel bestaat nog niet');
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.equal(stand.aan, true);
  assert.ok(stand.fout);
  assert.equal(stand.beloftes.size, 0);
  assert.equal(irisPauzeBlokkade(stand, 'k1'), null, 'de motor hoort gewoon door te lopen');
});

test('de migratie is dus NIET blokkerend voor de aanmaanmotor', async () => {
  // Concreet geval: de vlag staat aan maar iris_beloftes bestaat nog niet.
  // De motor doet dan precies wat hij gisteren deed.
  const { db } = tellendeDb(null, 'relation "iris_beloftes" does not exist');
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  assert.equal(irisPauzeBlokkade(stand, 'k1'), null);
});

test('zonder databank-client blokkeert er ook niets', async () => {
  const stand = await haalIrisPauzeStand({ db: null, env: { IRIS_PAUZEERT_JOOST: 'true' } });
  assert.equal(irisPauzeBlokkade(stand, 'k1'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. DE REGEL IN HET LOGBOEK
// ═══════════════════════════════════════════════════════════════════════════

test('de samenvatting zegt of de poort überhaupt aan staat', () => {
  assert.match(pauzeStandSamenvatting({ aan: false }), /uitgeschakeld/);
  assert.match(pauzeStandSamenvatting({ aan: false }), /IRIS_PAUZEERT_JOOST/);
});

test('de samenvatting onderscheidt "geen beloftes" van "niet gelezen"', () => {
  const leeg = pauzeStandSamenvatting({ aan: true, beloftes: new Map() });
  const stuk = pauzeStandSamenvatting({ aan: true, beloftes: new Map(), fout: 'weg' });
  assert.match(leeg, /0 lopende/);
  assert.match(stuk, /niet gelezen/);
  assert.match(stuk, /loopt door/);
  assert.notEqual(leeg, stuk);
});

test('de samenvatting telt in enkelvoud en meervoud', () => {
  const een = new Map([['k1', BELOFTE]]);
  const twee = new Map([['k1', BELOFTE], ['k2', BELOFTE]]);
  assert.match(pauzeStandSamenvatting({ aan: true, beloftes: een }), /1 lopende afspraak\b/);
  assert.match(pauzeStandSamenvatting({ aan: true, beloftes: twee }), /2 lopende afspraken/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. DE POORT ZIET ERUIT ALS ZIJN TWEE BUREN
// ═══════════════════════════════════════════════════════════════════════════

test('de vorm is gelijk aan die van lms-stilte: code, event, reden', async () => {
  // Een poort die er anders uitziet dan de twee ernaast, is een poort die bij
  // de volgende wijziging vergeten wordt.
  const { db } = tellendeDb([BELOFTE]);
  const stand = await haalIrisPauzeStand({ db, env: { IRIS_PAUZEERT_JOOST: 'true' }, vandaagIso: VANDAAG });
  const blok = irisPauzeBlokkade(stand, 'k1');
  for (const veld of ['code', 'event', 'reden']) {
    assert.ok(blok[veld], `${veld} ontbreekt — lms-stilte levert die wel`);
  }
  assert.match(PAUZE_EVENT, /^skipped_/, 'het event volgt dezelfde naamgeving als skipped_lms_stilte');
});
