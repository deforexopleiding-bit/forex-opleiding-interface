// tests/whatsapp-brug-tellers.test.js
//
// Meten zonder te kijken.
//
// Aanleiding: een bericht dat vanaf Daves telefoon naar een lead ging is stil
// gedropt tussen raakAan() en webhook.duw(). De brug zag om 17:38:57 iets, maar
// webhook.verstuurd bleef 0 en er stond geen enkele waarschuwing in journalctl.
// Dat gat maakt het privacyfilter per definitie: wat we niet mogen loggen,
// kunnen we ook niet terugvinden.
//
// De uitweg is niet dat filter opgeven maar tellen. Deze tests bewaken twee
// dingen tegelijk:
//
//   1. dat de tellers de juiste vraag beantwoorden — kwam het event binnen, en
//      zo ja, op welke regel viel het af;
//   2. dat er nooit een nummer, een tekst of een bericht-id in terechtkomt.
//      Dat tweede is het punt: zodra dat wél zou mogen, is het filter een
//      formaliteit geworden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { maakTellers, EVENT_TYPES, REDENEN } from '../services/whatsapp-brug/lib/tellers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');

/** Cross-realm speelt hier niet, maar plat vergelijken leest prettiger. */
const plat = (o) => JSON.parse(JSON.stringify(o));

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLERS ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('een verse teller staat overal op nul, niet op null', () => {
  // Nul betekent 'geteld en er was niets'. Dat is hier de waarheid: de brug is
  // net gestart. Een ontbrekend veld zou als 'niet gemeten' moeten lezen, en
  // dat onderscheid maakt het CRM-paneel aan de andere kant.
  const t = maakTellers().status();
  for (const type of EVENT_TYPES) {
    assert.equal(t.gezien[type], 0);
    assert.equal(t.doorgelaten[type], 0);
    for (const r of REDENEN) assert.equal(t.genegeerd[type][r], 0);
  }
  assert.deepEqual(plat(t.ack_codes), {});
  assert.equal(t.laatste_genegeerd, null);
});

test('gezien telt alles, ook wat straks afvalt', () => {
  const t = maakTellers();
  t.zag('message_create'); t.zag('message_create'); t.zag('message');
  t.negeer('message_create', 'niet_op_leadlijst');
  const s = t.status();
  assert.equal(s.gezien.message_create, 2, 'allebei gezien');
  assert.equal(s.genegeerd.message_create.niet_op_leadlijst, 1);
  assert.equal(s.gezien.message, 1);
});

test('het verschil tussen gezien en doorgelaten is precies wat afviel', () => {
  // Dat is de hele diagnose in één regel: gezien 3, door 1, genegeerd 2 — en
  // waarom die twee afvielen staat ernaast.
  const t = maakTellers();
  for (let i = 0; i < 3; i++) t.zag('message_create');
  t.liet('message_create');
  t.negeer('message_create', 'niet_van_ons');
  t.negeer('message_create', 'groep');
  const s = t.status();
  const genegeerd = Object.values(s.genegeerd.message_create).reduce((a, b) => a + b, 0);
  assert.equal(s.gezien.message_create - s.doorgelaten.message_create, genegeerd);
});

test('ack-codes worden als getal geteld', () => {
  const t = maakTellers();
  t.ack(0); t.ack(0); t.ack(1); t.ack(3);
  assert.deepEqual(plat(t.status().ack_codes), { 0: 2, 1: 1, 3: 1 });
});

test('alleen nullen bij de acks is zelf een antwoord', () => {
  // Zien we uitsluitend 0 en -1, dan heeft WhatsApp nog niets bevestigd en
  // hoeft niemand een bericht te openen om dat vast te stellen.
  const t = maakTellers();
  t.ack(-1); t.ack(0);
  assert.deepEqual(Object.keys(plat(t.status().ack_codes)).sort(), ['-1', '0']);
});

test('de laatste genegeerde draagt type, reden en tijd — verder niets', () => {
  const t = maakTellers({ nu: () => '2026-09-06T17:38:57.000Z' });
  t.negeer('message_create', 'niet_op_leadlijst');
  const l = t.status().laatste_genegeerd;
  assert.deepEqual(plat(l), {
    type: 'message_create', reden: 'niet_op_leadlijst', tijd: '2026-09-06T17:38:57.000Z',
  });
});

test('onbekende types en redenen worden genegeerd in plaats van aangemaakt', () => {
  // Anders groeit deze structuur met wat een aanroeper toevallig doorgeeft, en
  // dan is er een dag waarop daar een nummer in staat.
  const t = maakTellers();
  t.zag('iets_anders');
  t.negeer('message', 'omdat het nummer 32470111222 is');
  t.negeer('verzonnen_type', 'groep');
  const s = t.status();
  assert.equal('iets_anders' in s.gezien, false);
  assert.equal('verzonnen_type' in s.genegeerd, false);
  for (const r of Object.keys(s.genegeerd.message)) assert.ok(REDENEN.includes(r));
});

test('de redenen zijn een vaste lijst zonder vrije tekst', () => {
  assert.deepEqual([...REDENEN].sort(),
    ['geen_ack_soort', 'groep', 'niet_op_leadlijst', 'niet_van_ons', 'onbruikbaar']);
});

test('rommel in ack() maakt geen sleutel aan', () => {
  const t = maakTellers();
  t.ack('geen getal'); t.ack(null); t.ack(undefined); t.ack(NaN);
  assert.deepEqual(plat(t.status().ack_codes), {});
});

test('de status is een kopie, geen venster op de binnenkant', () => {
  const t = maakTellers();
  const s = t.status();
  s.gezien.message = 999;
  assert.equal(t.status().gezien.message, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN ENKEL GEGEVEN LEKT MEE
// ═══════════════════════════════════════════════════════════════════════════

test('de status bevat uitsluitend getallen en woorden uit de vaste lijsten', () => {
  const t = maakTellers();
  t.zag('message'); t.liet('message'); t.negeer('message_ack', 'geen_ack_soort'); t.ack(2);
  const s = t.status();

  const loop = (waarde, pad) => {
    if (waarde === null) return;
    if (typeof waarde === 'number') return;
    if (typeof waarde === 'string') {
      assert.ok(EVENT_TYPES.includes(waarde) || REDENEN.includes(waarde) || /^\d{4}-\d{2}-\d{2}T/.test(waarde),
        'onverwachte tekst op ' + pad + ': ' + waarde);
      return;
    }
    assert.equal(typeof waarde, 'object', pad);
    for (const [k, v] of Object.entries(waarde)) loop(v, pad + '.' + k);
  };
  loop(s, 'status');
});

test('de brug logt bij een genegeerde gebeurtenis alleen type en reden', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('function negeer(');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const blok = bron.slice(i, i + 500);
  assert.match(blok, /console\.debug\('\[brug\] genegeerd:', type, reden\)/);
  assert.doesNotMatch(blok, /msg|nummer|tekst|jid|bericht_id/,
    'de logregel hoort niets van het bericht te dragen');
});

test('de debug-regel staat standaard uit', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('function negeer(');
  assert.match(bron.slice(i, i + 500), /BRUG_DEBUG === '1'/,
    'op een drukke dag is dit ruis; standaard uit');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE HANDLERS TELLEN, EN HET FILTER BLIJFT VOOROP
// ═══════════════════════════════════════════════════════════════════════════

test('elke handler telt wat hij ziet', () => {
  const bron = readFileSync(WA, 'utf8');
  for (const type of EVENT_TYPES) {
    const i = bron.indexOf("client.on('" + type + "'");
    assert.ok(i > 0, 'handler ' + type + ' hoort te bestaan');
    assert.match(bron.slice(i, i + 300), new RegExp("tellers\\.zag\\('" + type + "'\\)"),
      type + ' hoort te tellen wat binnenkomt');
  }
});

test('elke afvalregel heeft een eigen reden', () => {
  const bron = readFileSync(WA, 'utf8');
  const blok = (type) => {
    const i = bron.indexOf("client.on('" + type + "'");
    return bron.slice(i, i + 2000);
  };
  assert.match(blok('message_create'), /negeer\('message_create', 'niet_van_ons'\)/);
  assert.match(blok('message_create'), /negeer\('message_create', 'niet_op_leadlijst'\)/);
  assert.match(blok('message_create'), /negeer\('message_create', 'groep'\)/);
  assert.match(blok('message_create'), /negeer\('message_create', 'onbruikbaar'\)/);
  assert.match(blok('message_ack'), /negeer\('message_ack', 'geen_ack_soort'\)/);
  assert.match(blok('message'), /negeer\('message', 'niet_op_leadlijst'\)/);
});

test('de fromMe-check staat vóór het filter, en het filter vóór elk gebruik', () => {
  // Die volgorde is bewust. message_create vuurt óók voor binnengekomen
  // berichten, en daar is `to` óns eigen nummer; zonder de fromMe-check eerst
  // zouden die allemaal als 'niet_op_leadlijst' geteld worden en het beeld
  // vertroebelen precies waar we naar kijken. De check leest één boolean van de
  // envelop — geen nummer, geen tekst — en er wordt niets van bewaard.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf("client.on('message_create'");
  const blok = bron.slice(i, i + 2000);
  const fromMe = blok.indexOf('msg?.fromMe !== true');
  const filter = blok.indexOf('leadlijst.mag(');
  const bouw   = blok.indexOf('bouwUitgaandeGebeurtenis(');
  assert.ok(fromMe > 0 && filter > 0 && bouw > 0);
  assert.ok(fromMe < filter, 'eerst de boolean, dan het filter');
  assert.ok(filter < bouw, 'en het filter nog altijd vóór er iets gebouwd wordt');
});

test('de tellers komen mee in /status', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  assert.match(bron, /gebeurtenissen\s*:\s*wa\.tellers\(\)/);
});
