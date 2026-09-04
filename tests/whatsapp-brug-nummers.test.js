// tests/whatsapp-brug-nummers.test.js
//
// Fase 3b — het nummer-normaliseren en het privacyfilter van de WhatsApp-brug.
//
// Waarom dit zwaarder weegt dan de meeste tests hier: het filter bepaalt welke
// gesprekken de brug mogen verlaten. Dave belt en appt met zijn eigen telefoon,
// dus door dezelfde lijn lopen ook zijn privécontacten. Laat het filter er één
// door, dan staat er een privégesprek in het CRM en is dat niet meer terug te
// nemen. Laat het er één te weinig door, dan mist de opvolging een antwoord —
// vervelend, maar terug te draaien.
//
// Die asymmetrie stuurt elke keuze hieronder: bij twijfel niet doorlaten.
//
// De tweede helft bewaakt dat de twee kopieën van deze logica niet uit elkaar
// lopen. De brug moet zelfstandig naar een VPS te kopiëren zijn, dus staat het
// bestand er twee keer; zonder deze vergelijking zou een fix aan de ene kant
// maanden ongemerkt kunnen ontbreken aan de andere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseerNummer, nummerStaart, bouwToegestaan, isToegestaan, naarChatId,
} from '../api/_lib/whatsapp-brug-nummers.js';
import * as brug from '../services/whatsapp-brug/lib/nummers.js';

// ═══════════════════════════════════════════════════════════════════════════
// NORMALISEREN
// ═══════════════════════════════════════════════════════════════════════════

test('alle notaties van hetzelfde nummer komen op één reeks uit', () => {
  const zelfde = ['+32470111222', '0032470111222', '+32 470 11 12 22', '(0032) 470-111-222'];
  assert.deepEqual(new Set(zelfde.map(normaliseerNummer)), new Set(['32470111222']));
});

test('het @-achtervoegsel van WhatsApp gaat eraf', () => {
  // whatsapp-web.js levert '32470111222@c.us'. Zonder de suffix eerst weg te
  // knippen sleep je bij een groeps-id cijfers uit het id mee het nummer in.
  assert.equal(normaliseerNummer('32470111222@c.us'), '32470111222');
  assert.equal(normaliseerNummer('32470111222@s.whatsapp.net'), '32470111222');
  assert.equal(normaliseerNummer('120363012345678901@g.us'), '120363012345678901');
});

test('een enkele voorloop-nul blijft staan, een dubbele niet', () => {
  // 00 is de internationale kiescode en betekent hetzelfde als de +. Eén nul is
  // de nationale prefix; die weglaten zou een ander nummer opleveren.
  assert.equal(normaliseerNummer('0032470111222'), '32470111222');
  assert.equal(normaliseerNummer('0470111222'), '0470111222');
});

test('leeg of onleesbaar levert null, geen lege string', () => {
  for (const raar of [null, undefined, '', '   ', 'geen nummer', '@c.us', '+++']) {
    assert.equal(normaliseerNummer(raar), null, JSON.stringify(raar));
  }
});

test('de staart is de lokale variant, en alleen bij genoeg cijfers', () => {
  assert.equal(nummerStaart('+32470111222'), '470111222');
  assert.equal(nummerStaart('0470111222'), '470111222');
  assert.equal(nummerStaart('12345'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET PRIVACYFILTER
// ═══════════════════════════════════════════════════════════════════════════

const LEADS = ['+32470111222', '0031612345678'];
const lijst = () => bouwToegestaan(LEADS);

test('een bekend nummer mag erdoor, in welke notatie het ook binnenkomt', () => {
  const t = lijst();
  for (const n of ['32470111222@c.us', '+32 470 111 222', '0032470111222']) {
    assert.equal(isToegestaan(n, t), true, n);
  }
});

test('een lokaal genoteerd leadnummer wordt herkend als WhatsApp met landcode komt', () => {
  // Het CRM heeft nummers ook als '0470111222'; WhatsApp komt altijd met
  // landcode. Zonder deze ingang zou het filter elk zulk nummer wegsturen en
  // deed de hele brug stil niets.
  const t = bouwToegestaan(['0470111222']);
  assert.equal(isToegestaan('32470111222@c.us', t), true);
});

test('een onbekend nummer komt er niet door', () => {
  const t = lijst();
  for (const n of ['32499999999@c.us', '+31655555555', '4915112345678']) {
    assert.equal(isToegestaan(n, t), false, n);
  }
});

test('een lege lijst laat NIETS door', () => {
  // Dit is het belangrijkste geval. Als het ophalen van de leadlijst faalt is
  // de lijst leeg, en dan is 'even alles doorlaten' precies de fout die je
  // nooit wilt maken. Liever een uur niets dan één privégesprek.
  for (const leeg of [bouwToegestaan([]), bouwToegestaan(null), null, undefined, {}]) {
    assert.equal(isToegestaan('+32470111222', leeg), false);
  }
});

test('groepsgesprekken vallen er altijd buiten', () => {
  // In een groep zitten per definitie mensen die niet op de lijst staan.
  const t = bouwToegestaan(['120363012345678901']);
  assert.equal(isToegestaan('120363012345678901@g.us', t), false);
});

test('een dubbelzinnige staart laat niets door', () => {
  // Twee leads met dezelfde laatste negen cijfers: dan is 'kies er een' een
  // gok, en bij een privacyfilter gok je de verkeerde kant op.
  const t = bouwToegestaan(['32470111222', '31470111222']);
  assert.equal(isToegestaan('32470111222', t), true, 'de volle reeks blijft exact matchen');
  assert.equal(isToegestaan('49470111222@c.us', t), false, 'via de staart mag het niet');
});

test('rommel in de leadlijst wordt overgeslagen, niet doorgelaten', () => {
  const t = bouwToegestaan([null, '', '   ', 'onzin', '+32470111222']);
  assert.equal(t.aantal, 1);
  assert.equal(isToegestaan('+32470111222', t), true);
  assert.equal(isToegestaan('', t), false);
  assert.equal(isToegestaan(null, t), false);
});

test('een te kort nummer haalt de staart-ingang niet', () => {
  const t = bouwToegestaan(['1234']);
  assert.equal(isToegestaan('1234', t), true, 'exact mag wel');
  assert.equal(isToegestaan('99991234', t), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// VERSTUREN
// ═══════════════════════════════════════════════════════════════════════════

test('een chat-id ontstaat alleen bij een nummer met landcode', () => {
  assert.equal(naarChatId('+32470111222'), '32470111222@c.us');
  assert.equal(naarChatId('0032470111222'), '32470111222@c.us');
  // Zonder landcode valt niet te raden welk land bedoeld is — dan liever niets
  // versturen dan een vreemde ergens ter wereld aanschrijven.
  assert.equal(naarChatId('0470111222'), null);
  assert.equal(naarChatId('12345'), null);
  assert.equal(naarChatId(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEE KOPIEËN MOGEN NIET UIT ELKAAR LOPEN
// ═══════════════════════════════════════════════════════════════════════════

test('brug en CRM normaliseren exact hetzelfde', () => {
  const proeven = [
    '+32470111222', '0032470111222', '0470111222', '32470111222@c.us',
    '120363012345678901@g.us', '+31 6 12345678', 'onzin', '', null, undefined, '  +32 470 11 12 22  ',
  ];
  for (const p of proeven) {
    assert.equal(brug.normaliseerNummer(p), normaliseerNummer(p), `normaliseer ${JSON.stringify(p)}`);
    assert.equal(brug.nummerStaart(p), nummerStaart(p), `staart ${JSON.stringify(p)}`);
    assert.equal(brug.naarChatId(p), naarChatId(p), `chatId ${JSON.stringify(p)}`);
  }
});

test('brug en CRM filteren exact hetzelfde', () => {
  const lijsten = [[], ['+32470111222'], ['0470111222'], ['32470111222', '31470111222']];
  const proeven = ['+32470111222', '32470111222@c.us', '0470111222', '49470111222', '120363012345678901@g.us', '', null];
  for (const l of lijsten) {
    const a = bouwToegestaan(l);
    const b = brug.bouwToegestaan(l);
    assert.equal(b.aantal, a.aantal, `aantal voor ${JSON.stringify(l)}`);
    for (const p of proeven) {
      assert.equal(
        brug.isToegestaan(p, b), isToegestaan(p, a),
        `filter ${JSON.stringify(p)} tegen ${JSON.stringify(l)}`,
      );
    }
  }
});
