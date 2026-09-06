// tests/whatsapp-brug-landcode.test.js
//
// I — zes leads staan met een lokaal genoteerd telefoonnummer in het CRM, en
// dat brak twee dingen tegelijk.
//
// DE GEMETEN AANLEIDING. Van de 33 opvolgtaken: 25 internationaal, 2 leeg, en 6
// lokaal — 0472223752, 0472342612, 0483467656, 0476464399, 0494382885 en
// 06 57340618. Die passeren het leadlijst-filter nog wel (dat heeft een
// staart-ingang op de laatste negen cijfers), maar naarChatId() geeft null
// zodra een nummer met een 0 begint. Gevolg:
//
//   · de lidkaart: getNumberId kreeg geen bruikbaar nummer en faalde — dat is
//     precies waarom 21 van de 28 koppelden en de rest niet;
//   · versturen: wa.stuur() gooide NUMMER_ONGELDIG, dus bij bijna één op de
//     vijf openstaande taken stond de knop er wel maar kon er niets uit.
//
// WAAROM WE NIET RADEN. Vijf van die zes zijn Belgisch en één is Nederlands.
// Een vaste aanname '32' zou dat ene nummer naar een wildvreemde in België
// sturen. Dus: kandidaten opstellen, WhatsApp laten beslissen, en alleen
// accepteren bij PRECIES ÉÉN bevestiging. Twee treffers is gokken, en dat doen
// we niet bij een privacyfilter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  kandidatenVoor, isLokaalGenoteerd, maakLandcodeZoeker, LANDCODES,
} from '../services/whatsapp-brug/lib/landcode.js';
import { naarChatId } from '../services/whatsapp-brug/lib/nummers.js';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA     = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');
const SERVER = join(ROOT, 'services/whatsapp-brug/server.js');

// De zes echte nummers uit productie, met hun werkelijke land.
const ECHT = [
  ['0472223752', '32472223752'],   // Maxim Delombaerde
  ['0472342612', '32472342612'],   // Anais Beijer
  ['0483467656', '32483467656'],   // Lemmy Jacques
  ['0476464399', '32476464399'],   // Serge Mortele
  ['0494382885', '32494382885'],   // James Verhaeghe
  ['06 57340618', '31657340618'],  // Joelle Van Allemeersch — NEDERLANDS
];

/** Een WhatsApp dat alleen deze nummers kent. */
const whatsappKent = (...bekend) => async (kandidaat) => bekend.includes(kandidaat);

// ═══════════════════════════════════════════════════════════════════════════
// DE KANDIDATEN
// ═══════════════════════════════════════════════════════════════════════════

test('een lokaal nummer wordt als zodanig herkend', () => {
  for (const [lokaal] of ECHT) assert.equal(isLokaalGenoteerd(lokaal), true, lokaal);
  for (const intl of ['32470123456', '+32 470 12 34 56', '31612345678']) {
    assert.equal(isLokaalGenoteerd(intl), false, intl);
  }
});

test('de spatie in "06 57340618" maakt niet uit', () => {
  assert.equal(isLokaalGenoteerd('06 57340618'), true);
  assert.deepEqual(kandidatenVoor('06 57340618'), ['32657340618', '31657340618']);
});

test('er worden twee kandidaten opgesteld, Belgisch en Nederlands', () => {
  assert.deepEqual(LANDCODES, ['32', '31']);
  assert.deepEqual(kandidatenVoor('0472223752'), ['32472223752', '31472223752']);
});

test('een nummer dat al internationaal is levert geen kandidaten op', () => {
  assert.deepEqual(kandidatenVoor('32470123456'), []);
  assert.deepEqual(kandidatenVoor(''), []);
  assert.deepEqual(kandidatenVoor(null), []);
});

test('onzin levert geen kandidaten op in plaats van rare', () => {
  assert.deepEqual(kandidatenVoor('012'), [], 'te kort');
  assert.deepEqual(kandidatenVoor('00'), [], 'niets over');
  assert.deepEqual(kandidatenVoor('0047223752'), [], 'nog een nul: geen notatie die we kennen');
});

// ═══════════════════════════════════════════════════════════════════════════
// PRECIES ÉÉN BEVESTIGING, ANDERS NIETS
// ═══════════════════════════════════════════════════════════════════════════

test('elk van de zes echte nummers wordt correct opgelost', async () => {
  for (const [lokaal, verwacht] of ECHT) {
    const z = maakLandcodeZoeker({ bevestig: whatsappKent(verwacht) });
    const r = await z.zoek(lokaal);
    assert.equal(r.status, 'gevonden', lokaal);
    assert.equal(r.nummer, verwacht, lokaal);
  }
});

test('het Nederlandse nummer wordt NIET Belgisch gemaakt', () => {
  // Dit is de reden dat we niet raden. Een vaste 32 zou 06 57340618 naar een
  // wildvreemde in België sturen.
  const [lokaal, verwacht] = ECHT[5];
  assert.equal(kandidatenVoor(lokaal)[1], verwacht, 'de Nederlandse kandidaat hoort erbij te zitten');
});

test('twee treffers levert niets op — dat is gokken', async () => {
  const z = maakLandcodeZoeker({ bevestig: whatsappKent('32472223752', '31472223752') });
  const r = await z.zoek('0472223752');
  assert.equal(r.status, 'meerdere');
  assert.equal(r.nummer, null);
  assert.equal(r.treffers, 2);
});

test('nul treffers levert ook niets op', async () => {
  const z = maakLandcodeZoeker({ bevestig: whatsappKent() });
  const r = await z.zoek('0472223752');
  assert.equal(r.status, 'geen');
  assert.equal(r.nummer, null);
});

test('een kandidaat die gooit telt niet mee en houdt de andere niet op', async () => {
  const z = maakLandcodeZoeker({
    bevestig: async (k) => { if (k.startsWith('32')) throw new Error('stuk'); return k === '31472223752'; },
  });
  const r = await z.zoek('0472223752');
  assert.equal(r.status, 'gevonden');
  assert.equal(r.nummer, '31472223752');
});

test('een internationaal nummer gaat ongewijzigd door zonder te vragen', async () => {
  let gevraagd = 0;
  const z = maakLandcodeZoeker({ bevestig: async () => { gevraagd += 1; return true; } });
  const r = await z.zoek('+32 470 12 34 56');
  assert.equal(r.status, 'niet_lokaal');
  assert.equal(r.nummer, '32470123456');
  assert.equal(gevraagd, 0, 'daar valt niets te kiezen, dus niets te vragen');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE CACHE
// ═══════════════════════════════════════════════════════════════════════════

test('hetzelfde nummer wordt maar één keer aan WhatsApp gevraagd', async () => {
  // Een gesprek waarin Dave vijf berichten stuurt hoort niet vijf keer te
  // vragen of dat nummer bestaat.
  let gevraagd = 0;
  const z = maakLandcodeZoeker({
    bevestig: async (k) => { gevraagd += 1; return k === '32472223752'; },
  });
  for (let i = 0; i < 5; i += 1) await z.zoek('0472223752');
  assert.equal(gevraagd, 2, 'twee kandidaten, één keer');
  assert.equal(z.aantalOnthouden(), 1);
});

test('ook een mislukte uitkomst wordt onthouden', async () => {
  let gevraagd = 0;
  const z = maakLandcodeZoeker({ bevestig: async () => { gevraagd += 1; return false; } });
  await z.zoek('0472223752');
  await z.zoek('0472223752');
  assert.equal(gevraagd, 2, 'niet nog een keer proberen wat net niets opleverde');
});

test('verschillende notaties van hetzelfde nummer delen één antwoord', async () => {
  let gevraagd = 0;
  const z = maakLandcodeZoeker({ bevestig: async (k) => { gevraagd += 1; return k === '31657340618'; } });
  await z.zoek('06 57340618');
  await z.zoek('0657340618');
  await z.zoek('06-57340618');
  assert.equal(gevraagd, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE METING
// ═══════════════════════════════════════════════════════════════════════════

test('per uitkomst wordt geteld, zonder het nummer', async () => {
  const gezien = [];
  const z = maakLandcodeZoeker({
    bevestig: whatsappKent('32472223752'),
    onMeting: (status, kandidaten, treffers) => gezien.push([status, kandidaten, treffers]),
  });
  await z.zoek('0472223752');
  assert.deepEqual(gezien, [['gevonden', 2, 1]]);
  const plat = JSON.stringify(gezien);
  assert.ok(!plat.includes('472223752'), 'de meting draagt geen nummer');
});

test('de tellers komen mee in /status', () => {
  const b = readFileSync(WA, 'utf8');
  assert.match(b, /landcode\s*:\s*\{ \.\.\.landcodeTellers, onthouden: landcode\.aantalOnthouden\(\) \}/);
  for (const k of ['gevonden', 'geen', 'meerdere', 'niet_lokaal']) {
    assert.match(b, new RegExp('landcodeTellers = \\{[^}]*' + k), k);
  }
});

test('het logregeltje draagt geen nummer', () => {
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf("console.log('[brug] landcode:'");
  assert.ok(i > 0);
  const regel = b.slice(i, b.indexOf('\n', i));
  assert.ok(!/kandidaat|nummer\b/.test(regel.replace('kandidaten', '')), regel);
});

// ═══════════════════════════════════════════════════════════════════════════
// ÉÉN FUNCTIE, TWEE PLEKKEN
// ═══════════════════════════════════════════════════════════════════════════

test('de lidkaart gebruikt hem', () => {
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf('async function koppelingenUitApi');
  const blok = b.slice(i, i + 1400);
  assert.match(blok, /await internationaal\(nummer\)/);
  assert.ok(blok.indexOf('internationaal(nummer)') < blok.indexOf('lidViaNumberId('),
    'eerst het nummer bruikbaar maken, dan pas vragen');
});

test('de kaart wordt met het ORIGINELE nummer gevuld', () => {
  // Het CRM kent het nummer zoals het in de leadlijst staat. Zou de kaart onder
  // het internationale nummer gaan zitten, dan vindt chatIdVoor() hem niet meer.
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf('async function koppelingenUitApi');
  const blok = b.slice(i, i + 1400);
  assert.match(blok, /paren\.push\(\[nummer, viaA\]\)/);
  assert.match(blok, /paren\.push\(\[nummer, viaB\]\)/);
});

test('versturen gebruikt dezelfde functie', () => {
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf('async stuur(nummer, tekst)');
  const blok = b.slice(i, i + 1800);
  assert.match(blok, /await internationaal\(nummer\)/);
  assert.ok(blok.indexOf('leadlijst.mag(nummer)') < blok.indexOf('internationaal(nummer)'),
    'het privacyfilter blijft de eerste regel');
});

test('er is maar één zoeker, dus één cache', () => {
  const b = readFileSync(WA, 'utf8');
  assert.equal((b.match(/maakLandcodeZoeker\(/g) || []).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MELDING ZEGT WAT ER AAN DE HAND IS
// ═══════════════════════════════════════════════════════════════════════════

test('een lokaal nummer dat niets oplevert krijgt een eigen code', () => {
  // 'Ongeldig nummer' laat Dave denken dat de brug stuk is, terwijl hij het
  // nummer moet aanvullen.
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf('async stuur(nummer, tekst)');
  const blok = b.slice(i, i + 2400);
  assert.match(blok, /LANDCODE_ONBEKEND/);
  assert.match(blok, /isLokaalGenoteerd\(nummer\)/);
  assert.match(blok, /WhatsApp herkent geen van de landcodes/);
});

test('de brug-route vertaalt die code naar een leesbare zin', () => {
  const s = readFileSync(SERVER, 'utf8');
  const i = s.indexOf("e?.code === 'LANDCODE_ONBEKEND'");
  assert.ok(i > 0, 'de route hoort die code te kennen');
  const blok = s.slice(i, i + 600);
  assert.match(blok, /status\(400\)/);
  assert.match(blok, /Vul het nummer aan/);
});

test('het CRM geeft een 400 van de brug door als 400, niet als 502', () => {
  // Anders leest een oordeel over het verzoek als een storing.
  const c = readFileSync(join(ROOT, 'api/_lib/whatsapp-brug-client.js'), 'utf8');
  assert.match(c, /e\?\.code === 'BRUG_FOUT' && e\.status === 400/);
  assert.match(c, /code: e\.data\?\.code \|\| 'BRUG_FOUT'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN naarChatId BLIJFT WAT HIJ WAS
// ═══════════════════════════════════════════════════════════════════════════

test('naarChatId weigert een lokaal nummer nog steeds', () => {
  // Dat is de juiste regel: die functie mag niet raden. De oplossing zit
  // ervóór, niet erin.
  for (const [lokaal] of ECHT) assert.equal(naarChatId(lokaal), null, lokaal);
  assert.equal(naarChatId('32472223752'), '32472223752@c.us');
});
