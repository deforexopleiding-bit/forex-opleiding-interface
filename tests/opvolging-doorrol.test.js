// tests/opvolging-doorrol.test.js
//
// Fase 3a — de twee besluiten die 's nachts en ieder uur automatisch genomen
// worden, zonder dat er iemand meekijkt.
//
// Waarom dit bewaakt wordt: allebei zijn het plekken waar werk stil kan
// verdwijnen, en stil is hier het probleem. Een taak die niet doorrolt staat
// morgen op geen enkele lijst. Een lead die na 48 uur niet terugkomt is iemand
// die de agenda kreeg, er niets mee deed, en waar nooit meer iemand achteraan
// gaat. In beide gevallen is er geen foutmelding — je merkt het pas als je het
// al kwijt bent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bepaalDoorrol, beslisWachtInplanning, hoortBijLead, WACHT_UREN,
} from '../api/_lib/opvolging-doorrol.js';

// ═══════════════════════════════════════════════════════════════════════════
// DOORROLLEN — 23:59
// ═══════════════════════════════════════════════════════════════════════════

const MORGEN = '2026-09-05';
const taak = (over) => ({ id: 't1', status: 'open', due: '2026-09-04', later: false, ...over });
const rol = (taken) => bepaalDoorrol({ taken, morgen: MORGEN });

test('wat vandaag bleef liggen staat morgen terug', () => {
  const uit = rol([taak()]);
  assert.equal(uit.length, 1);
  assert.deepEqual(uit[0], { id: 't1', patch: { due: MORGEN, later: false } });
});

test('de tweede ronde wordt losgelaten, anders blijft hij daar eeuwig staan', () => {
  // Dit is het punt van deze cron. Zonder de reset begint een taak die ooit op
  // 'later vandaag' is gezet elke ochtend onderaan, en dat leest als
  // afgehandeld terwijl er nooit meer iemand naar kijkt.
  const uit = rol([taak({ later: true })]);
  assert.equal(uit[0].patch.later, false);
});

test('een taak die al veel langer ligt rolt ook door', () => {
  const uit = rol([taak({ due: '2026-06-01' })]);
  assert.equal(uit[0].patch.due, MORGEN);
});

test('wat de gebruiker zelf vooruit zette blijft staan', () => {
  // Een taak die bewust op volgende week is gezet mag deze cron nooit naar
  // morgen trekken — dan zou doorschuiven zinloos worden.
  assert.deepEqual(rol([taak({ due: MORGEN })]), []);
  assert.deepEqual(rol([taak({ due: '2026-09-20' })]), []);
});

test('alleen open taken rollen door', () => {
  for (const status of ['ingepland', 'wacht_inplanning', 'gearchiveerd', '', null]) {
    assert.deepEqual(rol([taak({ status })]), [], String(status));
  }
});

test('rommel wordt overgeslagen in plaats van doorgegeven', () => {
  const uit = rol([null, {}, taak({ id: null }), taak({ due: 'gisteren' }), taak({ due: null }), taak({ id: 'goed' })]);
  assert.deepEqual(uit.map((x) => x.id), ['goed']);
});

test('zonder geldige morgen-datum gebeurt er niets', () => {
  // Liever niets doen dan elke taak op een onzin-datum zetten: dat laatste
  // haalt de hele lijst in één nacht onderuit.
  for (const m of [null, '', 'morgen', '2026-9-5']) {
    assert.deepEqual(bepaalDoorrol({ taken: [taak()], morgen: m }), [], String(m));
  }
});

test('een lege of ontbrekende lijst levert een lege lijst', () => {
  assert.deepEqual(bepaalDoorrol({ taken: [], morgen: MORGEN }), []);
  assert.deepEqual(bepaalDoorrol({ taken: null, morgen: MORGEN }), []);
});

test('alleen taken die echt veranderen komen terug', () => {
  // Geen zinloze updates, en geen updated_at die verschuift zonder reden.
  const uit = rol([taak({ id: 'a' }), taak({ id: 'b', due: MORGEN }), taak({ id: 'c', due: '2026-09-01' })]);
  assert.deepEqual(uit.map((x) => x.id).sort(), ['a', 'c']);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE 48-UURBESLISSING
// ═══════════════════════════════════════════════════════════════════════════

const NU = Date.parse('2026-09-04T12:00:00Z');
const urenGeleden = (u) => new Date(NU - u * 3600 * 1000).toISOString();

const wachter = (over) => ({
  id: 'w1', naam: 'Karel Jansen', email: 'karel@example.com', telefoon: '+32470111222',
  status: 'wacht_inplanning', agenda_doorgestuurd_at: urenGeleden(10), ...over,
});
const afspraak = (over) => ({
  id: 'ap1', lead_name: 'Karel Jansen', lead_email: 'karel@example.com', lead_phone: '+32470111222',
  scheduled_at: '2026-09-08T10:00:00Z', created_at: urenGeleden(2), ...over,
});
const beslis = (taak, afspraken) => beslisWachtInplanning({ taak, afspraken, nu: NU });

test('wie zelf boekt gaat op ingepland, met de gevonden afspraak erbij', () => {
  const b = beslis(wachter(), [afspraak()]);
  assert.equal(b.actie, 'ingepland');
  assert.equal(b.afspraak.id, 'ap1');
});

test('binnen de termijn zonder afspraak blijft het wachten', () => {
  assert.equal(beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(10) }), []).actie, 'wacht');
  assert.equal(beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(WACHT_UREN - 1) }), []).actie, 'wacht');
});

test('na 48 uur zonder afspraak komt hij terug in de lijst', () => {
  assert.equal(beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(WACHT_UREN) }), []).actie, 'terug');
  assert.equal(beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(100) }), []).actie, 'terug');
});

test('een afspraak van vóór het doorsturen telt niet als bewijs', () => {
  // Anders valt de taak meteen weg op grond van een afspraak die er al stond,
  // en heeft de lead in werkelijkheid nog niets gekozen.
  const b = beslis(
    wachter({ agenda_doorgestuurd_at: urenGeleden(60) }),
    [afspraak({ created_at: urenGeleden(90) })],
  );
  assert.equal(b.actie, 'terug');
});

test('een afspraak van iemand anders telt niet mee', () => {
  const b = beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(60) }), [afspraak({
    lead_name: 'Iemand Anders', lead_email: 'anders@example.com', lead_phone: '+31612345678',
  })]);
  assert.equal(b.actie, 'terug');
});

test('bij meerdere treffers wint de eerst geboekte', () => {
  const b = beslis(wachter(), [
    afspraak({ id: 'laat',  created_at: urenGeleden(1) }),
    afspraak({ id: 'vroeg', created_at: urenGeleden(5) }),
  ]);
  assert.equal(b.afspraak.id, 'vroeg');
});

test('zonder doorstuurmoment wordt er niets besloten', () => {
  // Geen klok om af te lopen. Terugzetten zou hier willekeurig zijn, en een
  // oude afspraak als bewijs gebruiken helemaal.
  for (const leeg of [null, '', 'onzin']) {
    assert.equal(beslis(wachter({ agenda_doorgestuurd_at: leeg }), [afspraak()]).actie, 'wacht', String(leeg));
  }
});

test('een afspraak zonder created_at telt niet mee', () => {
  const b = beslis(wachter({ agenda_doorgestuurd_at: urenGeleden(60) }), [afspraak({ created_at: null })]);
  assert.equal(b.actie, 'terug');
});

// ── Waarop we een lead herkennen ───────────────────────────────────────────

test('telefoon herkent ook door een andere notatie heen', () => {
  const t = { telefoon: '+32470111222' };
  for (const n of ['0032470111222', '+32 470 11 12 22', '0470111222']) {
    assert.equal(hoortBijLead(t, { lead_phone: n }), true, n);
  }
});

test('e-mail is hoofdletter-ongevoelig', () => {
  assert.equal(hoortBijLead({ email: 'Karel@Example.com' }, { lead_email: 'karel@example.com ' }), true);
});

test('naam matcht exact, niet op een deel', () => {
  assert.equal(hoortBijLead({ naam: 'Karel Jansen' }, { lead_name: '  karel   jansen ' }), true);
  // 'Karel' laten matchen op 'Karel Jansen' zou een afspraak van de verkeerde
  // persoon als bewijs gebruiken en deze lead ten onrechte uit de lijst halen.
  assert.equal(hoortBijLead({ naam: 'Karel' }, { lead_name: 'Karel Jansen' }), false);
  assert.equal(hoortBijLead({ naam: 'Karel Jansen' }, { lead_name: 'Karel Janssens' }), false);
});

test('lege velden matchen nooit met elkaar', () => {
  assert.equal(hoortBijLead({ naam: '', email: '', telefoon: '' }, { lead_name: '', lead_email: '', lead_phone: '' }), false);
  assert.equal(hoortBijLead({ naam: 'Karel Jansen' }, { lead_name: null }), false);
  assert.equal(hoortBijLead(null, afspraak()), false);
  assert.equal(hoortBijLead(wachter(), null), false);
});
