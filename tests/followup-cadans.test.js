// tests/followup-cadans.test.js
//
// Unit tests voor api/_lib/followup-cadans.js. Pure data + drie functies.
//
// Waarom deze test bestaat: het aantal belpogingen is een besluit, geen
// implementatiedetail. Gratis leads uit een event krijgen er drie en gaan
// daarna dicht; betalende klanten krijgen er vier en blijven open. Zodra
// iemand dat getal ergens anders overschrijft, of de terugval voor een
// onbekende herkomst per ongeluk verandert, hoort dit rood te worden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CADANS, CADANS_STANDAARD, BIJ_MAX, cadansVoor, urenTotVolgendePoging,
} from '../api/_lib/followup-cadans.js';

test('event: vijf pogingen, daarna sluit de rij bewust', () => {
  const c = cadansVoor('event');
  assert.equal(c.maxPogingen, 5);
  assert.equal(c.bijMax, BIJ_MAX.AFSLUITEN);
});

test('retention: vier pogingen, rij blijft open — het huidige gedrag', () => {
  const c = cadansVoor('retention');
  assert.equal(c.maxPogingen, 4);
  assert.equal(c.bijMax, BIJ_MAX.MARKEREN);
});

test('onbekende herkomst valt terug op de standaard, en die is het oude gedrag', () => {
  for (const h of ['manual', 'ghl', '', null, undefined, '   ', 'EVENT']) {
    const c = cadansVoor(h);
    assert.equal(c, CADANS_STANDAARD, `herkomst ${JSON.stringify(h)} hoort standaard te zijn`);
  }
  assert.equal(CADANS_STANDAARD.maxPogingen, 4);
  assert.equal(CADANS_STANDAARD.bijMax, BIJ_MAX.MARKEREN);
});

test('de tussenpozen zijn +2u, +1d, +3d en lopen daarna door op de laatste', () => {
  assert.equal(urenTotVolgendePoging('event', 1), 2);
  assert.equal(urenTotVolgendePoging('event', 2), 24);
  assert.equal(urenTotVolgendePoging('event', 3), 72);
  // Voorbij de lijst: laatste waarde, geen undefined en geen crash.
  assert.equal(urenTotVolgendePoging('retention', 4), 72);
  assert.equal(urenTotVolgendePoging('retention', 99), 72);
  // Onzin-invoer klemt naar de eerste waarde in plaats van te ontploffen.
  assert.equal(urenTotVolgendePoging('event', 0), 2);
  assert.equal(urenTotVolgendePoging('event', null), 2);
});

test('de tabel is bevroren — niemand past het besluit per ongeluk aan tijdens runtime', () => {
  assert.throws(() => { CADANS.event.maxPogingen = 9; }, TypeError);
  assert.throws(() => { CADANS.nieuw = { maxPogingen: 1 }; }, TypeError);
  assert.equal(CADANS.event.maxPogingen, 5);
});

test('de WhatsApp-taak valt op poging 2, met nog een belpoging te gaan', () => {
  const c = cadansVoor('event');
  assert.equal(c.taakBijPoging, 2);
  // De taak moet vóór de laatste poging vallen, anders is hij zinloos.
  assert.ok(c.taakBijPoging < c.maxPogingen);
});

test('retention maakt géén automatische taak aan — ongewijzigd gedrag', () => {
  assert.equal(cadansVoor('retention').taakBijPoging, null);
  assert.equal(CADANS_STANDAARD.taakBijPoging, null);
  assert.equal(cadansVoor('manual').taakBijPoging, null);
});

test('de WhatsApp-taak valt ruim vóór het einde, niet vlak ervoor', () => {
  const c = cadansVoor('event');
  // Poging 2 van 5: er blijven drie belpogingen over. Dat is met opzet — de
  // taak is de ontsnapping die maakt dat je niet vijf keer hoeft te bellen.
  assert.equal(c.taakBijPoging, 2);
  assert.ok(c.maxPogingen - c.taakBijPoging >= 2);
});
