// tests/support-widget-weg-terug.test.js
//
// DE WIDGET GOOIT ALLEEN WEG WAT ECHT WEG IS.
//
// widget/support.js draait in de browser, zonder build en zonder exports. We
// laden het hier in een node:vm-context met een kleine nep-DOM: net genoeg
// om te zien welk scherm er staat, wat er in localStorage zit en welke
// calls er naar de API gaan. Wat vastligt:
//
//   * Alleen een 401 met SESSIE_ONGELDIG ruimt een sessie op. Een 503, een
//     netwerkfout of een kale 401 laten 'm staan, bij het laden én bij het
//     pollen. Een sessie leeft dertig dagen; die verdwijnt niet door een
//     hikje.
//   * Na een geslaagde code staat de bezoeker in de chat, ook als de eerste
//     poll mislukt. Geen codescherm zonder kenmerk waar niets meer werkt.
//   * De uitweg uit het codescherm haalt het gesprek terug dat al in deze
//     browser stond, in plaats van het te wissen.
//   * Wijst de link naar het gesprek dat hier al open staat, dan gaat er geen
//     code en geen rotatie uit.
//   * Het kenmerk is uit de adresbalk voordat de eerste call de deur uit gaat.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { laad, wacht } from './support-widget-harness.js';
const KENMERK = 'SUP-Z3HB8F';

const CONFIG = { status: 200, body: { aan: true, titel: 'Hulp nodig?' } };
const GESPREK = { kenmerk: KENMERK, status: 'wacht_op_ons', geverifieerd: false };
const THREAD = {
  status: 200,
  body: { gesprek: GESPREK, berichten: [{ id: 'b1', afzender: 'medewerker', tekst: 'Hallo Paulien', created_at: '2026-09-23T10:00:00Z' }], live: false },
};
const BEWAARD = { token: 'bewaard-token-'.padEnd(43, 'b'), tijd: Date.now() };
const ONGELDIG = { status: 401, body: { error: 'Onbekende sessie', code: 'SESSIE_ONGELDIG' } };

describe('herstel na laden', () => {
  for (const [naam, antwoord] of [
    ['503', { status: 503, body: { error: 'Even niet bereikbaar' } }],
    ['netwerkfout', 'netwerk'],
    ['kale 401 zonder code', { status: 401, body: { error: 'Unauthorized' } }],
  ]) {
    test(`${naam}: sessie blijft, en de volgende poll haalt de thread op`, async () => {
      const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': [antwoord, THREAD] } });
      await wacht();
      assert.deepEqual(w.opslag(), BEWAARD, 'bewaarde sessie is weggegooid');

      await w.pollRonde();
      const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
      assert.match(laatste.pad, /volledig=1/, 'eerste poll na een storing moet de hele thread halen');
      assert.equal(laatste.token, BEWAARD.token);
      await w.klik('knop');
      assert.match(w.html(), /Hallo Paulien/);
    });
  }

  test('401 met SESSIE_ONGELDIG: sessie weg', async () => {
    const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': ONGELDIG } });
    await wacht();
    assert.equal(w.opslag(), null);
    assert.equal(w.pollLoopt(), false);
  });
});

describe('pollen in een lopend gesprek', () => {
  test('een kale 401 of 503 tijdens het pollen laat de sessie staan', async () => {
    const w = laad({
      opslag: BEWAARD,
      routes: { 'support-widget-config': CONFIG, 'support-poll': [THREAD, { status: 401, body: {} }, { status: 503, body: {} }] },
    });
    await wacht();
    await w.pollRonde();
    await w.pollRonde();
    assert.deepEqual(w.opslag(), BEWAARD);
    assert.equal(w.pollLoopt(), true);
  });

  test('SESSIE_ONGELDIG tijdens het pollen: opruimen met uitleg', async () => {
    const w = laad({ opslag: BEWAARD, routes: { 'support-widget-config': CONFIG, 'support-poll': [THREAD, ONGELDIG] } });
    await wacht();
    // Openen haalt meteen de stand op (geen vijf seconden wachten op de
    // volgende ronde) — en die eerste poll ziet het ongeldige token al.
    await w.klik('knop');
    assert.equal(w.opslag(), null);
    assert.match(w.html(), /ergens anders geopend/);
    assert.equal(w.pollLoopt(), false);
  });
});

describe('terugkomen via de link in een mail', () => {
  test('het kenmerk is uit de adresbalk vóór de eerste call', async () => {
    const w = laad({ search: '?dfo-support=' + KENMERK + '&utm_source=mail', routes: { 'support-widget-config': CONFIG } });
    await wacht();
    assert.equal(w.log.volgorde[0], 'replaceState');
    assert.equal(w.loc.search, '?utm_source=mail');
  });

  test('link naar het gesprek dat hier al open staat: geen code, geen rotatie', async () => {
    const w = laad({
      opslag: BEWAARD,
      search: '?dfo-support=' + KENMERK,
      routes: { 'support-widget-config': CONFIG, 'support-poll': THREAD },
    });
    await wacht();
    assert.ok(!w.log.calls.some((c) => c.naam.startsWith('support-hervat')), 'er ging toch een hervat-call uit');
    assert.ok(w.inChat(), 'staat niet in de chat');
    assert.match(w.html(), /Hallo Paulien/);
    assert.deepEqual(w.opslag(), BEWAARD);
  });

  test('link naar een ander gesprek: codescherm, en de uitweg brengt het bewaarde gesprek terug', async () => {
    const ANDER = { ...THREAD, body: { ...THREAD.body, gesprek: { ...GESPREK, kenmerk: 'SUP-AAAAAA' } } };
    const w = laad({
      opslag: BEWAARD,
      search: '?dfo-support=' + KENMERK,
      routes: { 'support-widget-config': CONFIG, 'support-poll': ANDER },
    });
    await wacht();
    assert.match(w.html(), /Stuur me de code/);
    assert.equal(w.pollLoopt(), false, 'het andere gesprek mag niet op de achtergrond door-pollen');

    await w.klik('hervat-terug');
    assert.deepEqual(w.opslag(), BEWAARD, 'de uitweg gooide het bewaarde gesprek weg');
    assert.ok(w.inChat(), 'staat niet in de chat');
  });

  test('geslaagde code met mislukte eerste poll: toch in de chat, nieuw token bewaard', async () => {
    const NIEUW = 'nieuw-token-'.padEnd(43, 'n');
    const w = laad({
      search: '?dfo-support=' + KENMERK,
      routes: {
        'support-widget-config': CONFIG,
        'support-hervat-start': { status: 200, body: { ok: true } },
        'support-hervat-check': { status: 200, body: { ok: true, token: NIEUW, gesprek: GESPREK } },
        'support-poll': [{ status: 503, body: {} }, THREAD],
      },
    });
    await wacht();
    await w.klik('hervat-code');
    w.invoer('f-hervat', '123456');
    await w.klik('hervat-open');

    assert.equal(w.opslag().token, NIEUW);
    assert.ok(w.inChat(), 'staat niet in de chat');
    assert.doesNotMatch(w.html(), /Stuur me de code/);

    await w.pollRonde();
    const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
    assert.match(laatste.pad, /volledig=1/);
    assert.equal(laatste.token, NIEUW);
    assert.match(w.html(), /Hallo Paulien/);
  });
});
