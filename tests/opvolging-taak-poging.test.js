// tests/opvolging-taak-poging.test.js
//
// Krijgt een verse taak meteen een belpoging mee?
//
// Waarom dit bewaakt wordt: de dekking op het dashboard telt belpogingen per
// dag, en Afgerond hangt daar het oordeel 'te weinig moeite' aan. Eén rij te
// veel maakt van iemand die nooit gebeld is een lead die er al 1 van 2 heeft —
// en dan meet het dashboard niet meer wat het beweert te meten.
//
// Het onderscheid is het gesprek zelf, niet de afspraak. Bij 'wil nog beslissen'
// is er echt gepraat. Bij een no-show is er níet gebeld: er kwam alleen niemand
// opdagen bij de Zoom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bepaalStartPoging } from '../api/_lib/opvolging-taak-poging.js';

const TAAK = 'taak-1';

test('wil nog beslissen levert een poging op — dat gesprek is gevoerd', () => {
  const p = bepaalStartPoging({ taakId: TAAK, reden: 'wil_nog_beslissen', resultaat: 'gesproken, wil nog beslissen' });
  assert.ok(p, 'na een echt gesprek hoort een poging vastgelegd te worden');
  assert.equal(p.taak_id, TAAK);
  assert.equal(p.soort, 'call');
  assert.equal(p.resultaat, 'gesproken, wil nog beslissen');
  // Handmatig: een mens rondde deze call af. Het bliksem-icoon in de historiek
  // is voor wat de telefooncentrale zelf meet.
  assert.equal(p.automatisch, false);
});

test('een no-show levert GEEN poging op', () => {
  // De kern van deze test. Er is niet gebeld — er kwam alleen niemand opdagen.
  // Zou dit meetellen, dan staat de verse kaart vandaag op 1 van 2 terwijl Dave
  // die persoon nog nooit aan de lijn heeft gehad.
  assert.equal(bepaalStartPoging({ taakId: TAAK, reden: 'no_show_call', resultaat: 'niet komen opdagen' }), null);
});

test('de regel geldt ook als een oude client toch iets meestuurt', () => {
  // Daarom staat hij server-side en niet alleen in het scherm: een tabblad dat
  // al open stond voor deze wijziging mag de telling niet alsnog vervuilen.
  for (const r of ['niet komen opdagen', 'gebeld', 'x']) {
    assert.equal(bepaalStartPoging({ taakId: TAAK, reden: 'no_show_call', resultaat: r }), null, r);
  }
});

test('geen enkele andere reden krijgt een startpoging', () => {
  for (const reden of ['no_show_event', 'afgemeld', 'niet_ingepland', '', null, undefined, 'verzonnen']) {
    assert.equal(bepaalStartPoging({ taakId: TAAK, reden, resultaat: 'gesproken' }), null, String(reden));
  }
});

test('zonder resultaat komt er niets, ook niet bij wil nog beslissen', () => {
  // Geen tekst betekent: de caller wil niets vastleggen. Een lege poging in de
  // historiek is erger dan geen — die telt wel mee maar zegt niets.
  for (const r of [null, undefined, '', '   ']) {
    assert.equal(bepaalStartPoging({ taakId: TAAK, reden: 'wil_nog_beslissen', resultaat: r }), null, JSON.stringify(r));
  }
});

test('zonder taak komt er geen rij', () => {
  assert.equal(bepaalStartPoging({ taakId: null, reden: 'wil_nog_beslissen', resultaat: 'gesproken' }), null);
});

test('een lang resultaat wordt afgekapt, niet geweigerd', () => {
  const p = bepaalStartPoging({ taakId: TAAK, reden: 'wil_nog_beslissen', resultaat: 'x'.repeat(500) });
  assert.equal(p.resultaat.length, 200);
});
