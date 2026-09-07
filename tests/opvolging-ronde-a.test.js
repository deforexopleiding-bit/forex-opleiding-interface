// tests/opvolging-ronde-a.test.js
//
// RONDE A HEEFT NOOIT BESTAAN.
//
// De afspraak kent twee instroommomenten: bellen binnen 24 uur na de
// aanmelding (ronde A), en opnieuw vier dagen voor het event (ronde B). In de
// praktijk kreeg élke aanmeldkaart meteen due = eventdatum min vier, ook als de
// aanmelding weken eerder binnenkwam. De kaart werd dus geboren in slaaptoestand
// en Dave zag hem pas vlak voor het event.
//
// Gemeten op 7 september in opvolging_taken (bron=event, aangemaakt vanaf 4 sep):
//   · Event 23 sep — drie kaarten aangemaakt op 5 sep met due 19 sep: veertien
//     dagen slapen.
//   · Event 26 sep — vier kaarten aangemaakt op 5 en 6 sep met due 22 sep:
//     zeventien dagen.
//   · Event 9 sep — zeven kaarten met due 6 of 7 sep. Dat ziet er goed uit maar
//     is toeval: bij een event op 9 september ligt event min vier al bijna in
//     het verleden, dus valt de due vanzelf op vandaag of morgen.
//
// Er was geen enkele kaart waarvan de due binnen 24 uur na aanmaak lag omdat de
// aanmelding vers was.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  bepaalTaakActie, dueVoorRondeA, dueVoorRondeB, dagPlus, dagenTussen,
  WAKKER_DAGEN_VOOR_EVENT,
} from '../api/_lib/opvolging-aanmelding.js';

const VANDAAG = '2026-09-07';
const NU = Date.parse('2026-09-07T09:00:00Z');

const attendee = (extra = {}) => ({
  id: 'a1', status: 'aangemeld', registered_at: '2026-09-07T08:00:00Z', ...extra,
});
const event = (starts) => ({ id: 'e1', title: 'Masterclass Gent', location: 'Gent', starts_at: starts });

// ═══════════════════════════════════════════════════════════════════════════
// DE FOUT ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('een aanmelding voor een event over drie weken krijgt een due binnen 24 uur', () => {
  // Dit is het geval van Bryan, Kris en Achraf: aangemeld op 5 september voor
  // een event op 23 september, en dan veertien dagen niets.
  const b = bepaalTaakActie({ attendee: attendee(), event: event('2026-09-28T19:00:00Z'), nu: NU });
  assert.equal(b.actie, 'aanmaken');
  assert.equal(dagenTussen(VANDAAG, b.due), 1, 'de dag na de aanmelding, niet event min vier');
  assert.notEqual(b.due, dagPlus('2026-09-28', -WAKKER_DAGEN_VOOR_EVENT));
});

test('de kaart wordt niet meer in slaaptoestand geboren', () => {
  // Vier events op verschillende afstanden; geen enkele mag verder dan een dag
  // vooruit gezet worden bij het aanmaken.
  for (const start of ['2026-09-09T19:00:00Z', '2026-09-16T19:00:00Z',
                       '2026-09-23T19:00:00Z', '2026-10-20T19:00:00Z']) {
    const b = bepaalTaakActie({ attendee: attendee(), event: event(start), nu: NU });
    assert.equal(b.actie, 'aanmaken');
    assert.ok(dagenTussen(VANDAAG, b.due) <= 1,
      'event ' + start + ' gaf due ' + b.due + ' — dat is slapen, geen ronde A');
  }
});

test('een aanmelding die gisteren binnenkwam staat vandaag op de lijst', () => {
  // De due hangt aan het moment van AANMELDEN, niet aan het moment waarop de
  // cron toevallig draait. Anders schuift een kaart mee met de cron.
  const b = bepaalTaakActie({
    attendee: attendee({ registered_at: '2026-09-06T14:00:00Z' }),
    event: event('2026-09-28T19:00:00Z'), nu: NU,
  });
  assert.equal(b.due, VANDAAG, 'aangemeld op 6 september → due 7 september');
});

test('zonder registratiemoment valt hij terug op vandaag plus een', () => {
  const b = bepaalTaakActie({
    attendee: attendee({ registered_at: null }),
    event: event('2026-09-28T19:00:00Z'), nu: NU,
  });
  assert.equal(b.due, dagPlus(VANDAAG, 1));
});

// ═══════════════════════════════════════════════════════════════════════════
// RONDE B BLIJFT BESTAAN
// ═══════════════════════════════════════════════════════════════════════════

test('ronde B rekent nog steeds event min vier', () => {
  assert.equal(dueVoorRondeB({ eventDag: '2026-09-28', vandaag: VANDAAG }), '2026-09-24');
  assert.equal(dagenTussen(dueVoorRondeB({ eventDag: '2026-09-28', vandaag: VANDAAG }), '2026-09-28'),
    WAKKER_DAGEN_VOOR_EVENT);
});

test('ligt event min vier al in het verleden, dan is ronde B vandaag', () => {
  assert.equal(dueVoorRondeB({ eventDag: '2026-09-09', vandaag: VANDAAG }), VANDAAG);
});

test('een slapende kaart wordt door de cron gewekt voor ronde B', () => {
  // Nadat Dave in ronde A 'bevestigd' koos staat de kaart op event min vier.
  // Staat hij per ongeluk verder weg, dan haalt de cron hem naar voren.
  const b = bepaalTaakActie({
    attendee: attendee(), event: event('2026-09-09T19:00:00Z'),
    taak: { id: 't1', status: 'open', due: '2026-09-30' }, nu: NU,
  });
  assert.equal(b.actie, 'wakker_maken');
  assert.equal(b.due, VANDAAG);
});

test('een kaart die al op ronde A staat wordt niet vooruitgeschoven', () => {
  // Dit is de val: zou de cron 'wakker_maken' vergelijken met ronde B, dan zou
  // een kaart die net op morgen staat naar event min vier geduwd worden — en
  // dan is ronde A alsnog weg.
  const b = bepaalTaakActie({
    attendee: attendee(), event: event('2026-09-28T19:00:00Z'),
    taak: { id: 't1', status: 'open', due: dagPlus(VANDAAG, 1) }, nu: NU,
  });
  assert.equal(b.actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEEDE PLEK WAAR EEN KAART ONTSTAAT
// ═══════════════════════════════════════════════════════════════════════════

test('events-complete-core maakt kaarten NA het event en gebruikt ronde A niet', () => {
  // Punt B in de eventmodule maakt kaarten voor no-shows en afwezigen. Dat is
  // een andere flow — het event is dan al geweest — en die hoort niet mee te
  // veranderen. Als dit ooit wél dezelfde due-regel gaat gebruiken, moet dat
  // een bewuste keuze zijn en geen ongemerkt neveneffect.
  const bron = readFileSync(new URL('../api/_lib/events-complete-core.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bron, /dueVoorRondeA|dueVoorAanmelding/,
    'de post-event-flow hoort zijn eigen belmoment te houden');
  assert.match(bron, /AFWEZIG_BELMOMENT_DAGEN/);
});

test('een kaart die al op ronde B geparkeerd staat wordt niet naar voren gerukt', () => {
  // DIT GEVAL ONDERSCHEIDT DE TWEE RONDES, en mijn eerste versie deed dat niet:
  // die parkeerde de kaart op morgen, en dan geven ronde A en ronde B hetzelfde
  // antwoord. Zou wakker_maken tegen ronde A vergelijken, dan wordt een kaart
  // die Dave na ronde A netjes op event min vier heeft gezet elke dag opnieuw
  // naar morgen getrokken — en dan bestaat ronde B niet meer.
  const eventDag = '2026-09-28';
  const geparkeerd = dueVoorRondeB({ eventDag, vandaag: VANDAAG });   // 2026-09-24
  assert.notEqual(geparkeerd, dagPlus(VANDAAG, 1), 'de twee rondes moeten hier verschillen');
  const b = bepaalTaakActie({
    attendee: attendee(), event: event(eventDag + 'T19:00:00Z'),
    taak: { id: 't1', status: 'open', due: geparkeerd }, nu: NU,
  });
  assert.equal(b.actie, 'niets', 'de kaart hoort op ronde B te blijven staan');
});
