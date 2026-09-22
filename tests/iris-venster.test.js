// tests/iris-venster.test.js
//
// Het servicevenster van 24 uur en de stille uren.
//
// Twee dingen die vaak door elkaar lopen en dat niet moeten: het venster zegt
// WAT er mag (tekst of template), de stille uren zeggen WANNEER. Een gesloten
// venster om drie uur 's middags betekent "gebruik een template". Een open
// venster om drie uur 's nachts betekent "wacht tot acht uur".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VENSTER_MS,
  BIJNA_DICHT_MINUTEN,
  vensterStand,
  duurTekst,
  lokaleTijd,
  naarMinuten,
  stilleUren,
  magVersturen,
} from '../api/_lib/iris/venster.js';

const NU = new Date('2026-09-21T12:00:00Z'); // maandag, 14:00 in Brussel (zomertijd)
const uurGeleden = (n) => new Date(NU.getTime() - n * 3600 * 1000).toISOString();

// ── het venster ─────────────────────────────────────────────────────────────

test('vensterStand: het venster is vierentwintig uur', () => {
  assert.equal(VENSTER_MS, 24 * 3600 * 1000);
});

test('vensterStand: een bericht van een uur geleden laat drieëntwintig uur over', () => {
  const v = vensterStand(uurGeleden(1), NU);
  assert.equal(v.open, true);
  assert.equal(v.resterend_tekst, 'venster open nog 23u00');
  assert.equal(v.bijna_dicht, false);
  assert.equal(v.ooit_contact, true);
});

test('vensterStand: precies op vierentwintig uur is het venster dicht', () => {
  const v = vensterStand(uurGeleden(24), NU);
  assert.equal(v.open, false);
  assert.equal(v.resterend_ms, 0);
  assert.match(v.resterend_tekst, /dicht/);
  assert.equal(v.ooit_contact, true, 'er is wél ooit contact geweest — dat is iets anders dan nooit');
});

test('vensterStand: nooit een bericht gehad is iets anders dan een verlopen venster', () => {
  const nooit = vensterStand(null, NU);
  const verlopen = vensterStand(uurGeleden(48), NU);
  assert.equal(nooit.open, false);
  assert.equal(verlopen.open, false);
  assert.equal(nooit.ooit_contact, false);
  assert.equal(verlopen.ooit_contact, true);
});

test('vensterStand: bijna dicht vanaf twee uur', () => {
  assert.equal(BIJNA_DICHT_MINUTEN, 120);
  assert.equal(vensterStand(uurGeleden(21.9), NU).bijna_dicht, false);
  assert.equal(vensterStand(uurGeleden(22), NU).bijna_dicht, true);
  assert.equal(vensterStand(uurGeleden(23.5), NU).bijna_dicht, true);
});

test('vensterStand: de aftelling is de hele reden dat deze module bestaat', () => {
  // Gat G3 uit de audit: het bestaande scherm toont alleen "verlopen", en dat
  // zie je pas als het te laat is.
  const v = vensterStand(uurGeleden(23.5), NU);
  assert.match(v.resterend_tekst, /nog 30m/);
});

test('vensterStand: een onleesbaar tijdstempel is dicht, niet open', () => {
  for (const v of ['gisteren', '', 'null', {}, NaN]) {
    assert.equal(vensterStand(v, NU).open, false, `${JSON.stringify(v)} hoorde dicht te zijn`);
  }
});

test('vensterStand: een tijdstempel in de toekomst geeft geen negatieve tijd', () => {
  // Gebeurt bij een verlopen klok of een handmatig gezette rij.
  const v = vensterStand(new Date(NU.getTime() + 5 * 3600 * 1000).toISOString(), NU);
  assert.equal(v.open, true);
  assert.ok(v.resterend_ms > 0);
  assert.ok(v.resterend_ms <= VENSTER_MS, 'er mag niet méér dan een vol venster uitkomen');
});

test('vensterStand: een Date werkt net zo goed als een tekst', () => {
  const a = vensterStand(new Date(NU.getTime() - 3600 * 1000), NU);
  const b = vensterStand(uurGeleden(1), NU);
  assert.equal(a.resterend_tekst, b.resterend_tekst);
});

// ── de duur in mensentaal ───────────────────────────────────────────────────

test('duurTekst: onder een uur alleen minuten, geen 0u43', () => {
  // '0u43' leest als iets anders dan drieënveertig minuten, en juist in het
  // laatste uur wil je precies weten waar je aan toe bent.
  assert.equal(duurTekst(43 * 60000), '43m');
  assert.equal(duurTekst(60000), '1m');
  assert.equal(duurTekst(0), '0m');
});

test('duurTekst: boven een uur met twee cijfers voor de minuten', () => {
  assert.equal(duurTekst(6 * 3600000 + 12 * 60000), '6u12');
  assert.equal(duurTekst(6 * 3600000 + 2 * 60000), '6u02');
  assert.equal(duurTekst(23 * 3600000), '23u00');
});

test('duurTekst: negatief wordt nul, geen minteken', () => {
  assert.equal(duurTekst(-5000), '0m');
});

// ── lokale tijd ─────────────────────────────────────────────────────────────

test('lokaleTijd: zomertijd in Brussel is twee uur voor op UTC', () => {
  const t = lokaleTijd(new Date('2026-07-15T12:00:00Z'), 'Europe/Brussels');
  assert.equal(t.uur, 14);
});

test('lokaleTijd: wintertijd in Brussel is één uur voor op UTC', () => {
  const t = lokaleTijd(new Date('2026-01-15T12:00:00Z'), 'Europe/Brussels');
  assert.equal(t.uur, 13);
});

test('lokaleTijd: zondag is dag nul', () => {
  const t = lokaleTijd(new Date('2026-09-20T12:00:00Z'), 'Europe/Brussels'); // een zondag
  assert.equal(t.dag, 0);
});

test('lokaleTijd: een onzinnige tijdzone geeft null, geen crash', () => {
  assert.equal(lokaleTijd(NU, 'Mars/Olympus'), null);
});

// ── uren omrekenen ──────────────────────────────────────────────────────────

test('naarMinuten: uu:mm', () => {
  assert.equal(naarMinuten('00:00'), 0);
  assert.equal(naarMinuten('08:00'), 480);
  assert.equal(naarMinuten('21:30'), 1290);
  assert.equal(naarMinuten('23:59'), 1439);
});

test('naarMinuten: wat geen tijd is, is null', () => {
  for (const v of ['9:00', '24:00', '21:60', '2100', '', null]) {
    assert.equal(naarMinuten(v), null, `"${v}" hoorde null te geven`);
  }
});

// ── stille uren ─────────────────────────────────────────────────────────────

const STIL = { van: '21:00', tot: '08:00', zondag_stil: true, tijdzone: 'Europe/Brussels' };

test('stilleUren: midden op de dag is het niet stil', () => {
  const r = stilleUren(STIL, new Date('2026-09-21T12:00:00Z')); // maandag 14:00 Brussel
  assert.equal(r.stil, false);
  assert.equal(r.reden, null);
});

test('stilleUren: het venster loopt over middernacht heen — de val van deze functie', () => {
  // Met een EN in plaats van een OF is er nóóit een stil uur. Vandaar drie
  // momenten: voor middernacht, na middernacht, en vlak voor het einde.
  for (const t of ['2026-09-21T20:00:00Z',   // maandag 22:00 Brussel
                   '2026-09-22T00:30:00Z',   // dinsdag 02:30 Brussel
                   '2026-09-22T05:30:00Z']) { // dinsdag 07:30 Brussel
    assert.equal(stilleUren(STIL, new Date(t)).stil, true, `${t} hoorde stil te zijn`);
  }
});

test('stilleUren: precies om acht uur is het weer luid', () => {
  const r = stilleUren(STIL, new Date('2026-09-22T06:00:00Z')); // dinsdag 08:00 Brussel
  assert.equal(r.stil, false);
});

test('stilleUren: precies om negen uur s avonds begint de stilte', () => {
  const r = stilleUren(STIL, new Date('2026-09-21T19:00:00Z')); // maandag 21:00 Brussel
  assert.equal(r.stil, true);
});

test('stilleUren: zondag is de hele dag stil', () => {
  const r = stilleUren(STIL, new Date('2026-09-20T12:00:00Z'));
  assert.equal(r.stil, true);
  assert.equal(r.reden, 'zondag');
});

test('stilleUren: zondag kan uitgezet worden', () => {
  const r = stilleUren({ ...STIL, zondag_stil: false }, new Date('2026-09-20T12:00:00Z'));
  assert.equal(r.stil, false);
});

test('stilleUren: in de winter schuift de grens mee', () => {
  // 20:00 UTC is 21:00 in de winter (stil) en 22:00 in de zomer (ook stil).
  // 19:00 UTC is 20:00 in de winter (luid) en 21:00 in de zomer (stil).
  assert.equal(stilleUren(STIL, new Date('2026-01-19T19:00:00Z')).stil, false, 'winter: 20:00 is nog luid');
  assert.equal(stilleUren(STIL, new Date('2026-07-20T19:00:00Z')).stil, true, 'zomer: 21:00 is stil');
});

test('stilleUren: onleesbare instellingen leiden tot zwijgen, niet tot praten', () => {
  for (const inst of [null, undefined, {}, { van: 'avond', tot: '08:00' }, { van: '21:00' }]) {
    const r = stilleUren(inst, new Date('2026-09-21T12:00:00Z'));
    assert.equal(r.stil, true, `${JSON.stringify(inst)} hoorde stil te zijn`);
    assert.ok(r.reden, 'er hoort een reden te staan');
  }
});

test('stilleUren: van gelijk aan tot is een typefout, en die valt stil', () => {
  const r = stilleUren({ ...STIL, van: '21:00', tot: '21:00' }, new Date('2026-09-21T12:00:00Z'));
  assert.equal(r.stil, true);
  assert.match(r.reden, /vergissing/);
});

test('stilleUren: een onzinnige tijdzone valt ook stil', () => {
  const r = stilleUren({ ...STIL, tijdzone: 'Mars/Olympus' }, NU);
  assert.equal(r.stil, true);
});

// ── de samengestelde vraag ──────────────────────────────────────────────────

test('magVersturen: open venster overdag geeft vrije tekst', () => {
  const r = magVersturen({ laatsteInbound: uurGeleden(2), stilleUrenInstelling: STIL, nu: NU });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst');
});

test('magVersturen: gesloten venster overdag geeft een template', () => {
  const r = magVersturen({ laatsteInbound: uurGeleden(30), stilleUrenInstelling: STIL, nu: NU });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'template');
  assert.match(r.reden, /template/);
});

test('magVersturen: nog nooit contact gehad zegt dat er ook met zoveel woorden bij', () => {
  const r = magVersturen({ laatsteInbound: null, stilleUrenInstelling: STIL, nu: NU });
  assert.equal(r.vorm, 'template');
  assert.match(r.reden, /nog nooit/);
});

test('magVersturen: automatisch in de stille uren mag niet, ook niet met een open venster', () => {
  const nacht = new Date('2026-09-22T00:30:00Z');
  const r = magVersturen({
    laatsteInbound: new Date(nacht.getTime() - 3600 * 1000).toISOString(),
    stilleUrenInstelling: STIL,
    automatisch: true,
    nu: nacht,
  });
  assert.equal(r.mag, false);
  assert.equal(r.vorm, null);
  assert.match(r.reden, /stille uren/);
  assert.equal(r.venster.open, true, 'het venster stond wel degelijk open — dat is een andere vraag');
});

test('magVersturen: een mens mag s nachts wél op Verstuur drukken', () => {
  // De afspraak gaat over automatische berichten. Een mens die om half elf
  // bewust op Verstuur drukt, weet wat hij doet.
  const nacht = new Date('2026-09-22T00:30:00Z');
  const r = magVersturen({
    laatsteInbound: new Date(nacht.getTime() - 3600 * 1000).toISOString(),
    stilleUrenInstelling: STIL,
    automatisch: false,
    nu: nacht,
  });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst');
});

test('magVersturen: de twee vragen blijven altijd apart afleesbaar', () => {
  const nacht = new Date('2026-09-22T00:30:00Z');
  const r = magVersturen({ laatsteInbound: uurGeleden(48), stilleUrenInstelling: STIL, nu: nacht });
  // Allebei blokkerend, om verschillende redenen, en allebei na te kijken.
  assert.equal(r.venster.open, false);
  assert.equal(r.stil.stil, true);
});

test('magVersturen: zonder enige opgaaf zwijgt hij', () => {
  const r = magVersturen();
  assert.equal(r.mag, false, 'geen instellingen betekent stille uren onleesbaar, dus zwijgen');
});
