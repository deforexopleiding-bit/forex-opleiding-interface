// tests/opvolging-gezondheid.test.js
//
// De vijf dagelijkse controles. Elke test is opgezet rond de ECHTE regressie
// van deze week die hij gevangen zou hebben — met de werkelijke getallen, niet
// met verzonnen gevallen.
//
// LET OP WAT DEZE TESTS WEL EN NIET ZIJN. Ze controleren dat de BEOORDELING
// klopt. Of de controle daadwerkelijk elke ochtend draait en de juiste data
// leest, bewijst geen enkele unit-test — dat bewijst de mail van morgenochtend.
// Dat onderscheid is precies wat er deze week zes keer misging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controleerInstroom, controleerOptelling, controleerDubbels,
  beoordeelPrintweergave, controleerBrug, bouwMail,
  OK, FOUT, NIET_GEMETEN, SLAPER_MAX_DAGEN,
} from '../api/_lib/opvolging-gezondheid.js';

const VANDAAG = '2026-09-07';
const dagPlus = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ═══════════════════════════════════════════════════════════════════════════
// 1 · INSTROOM
// ═══════════════════════════════════════════════════════════════════════════

test('de slapende kaarten van 5 september waren opgevallen', () => {
  // Bryan, Kris en Achraf: aangemaakt 5 sep, due 19 sep. Veertien dagen.
  const r = controleerInstroom({
    taken: [
      { naam: 'Bryan Van Der Heyden', due: '2026-09-19', aangemaakt_op: '2026-09-05' },
      { naam: 'Kris Sienaert',        due: '2026-09-19', aangemaakt_op: '2026-09-05' },
      { naam: 'Achraf Deflaoui',      due: '2026-09-19', aangemaakt_op: '2026-09-05' },
    ], vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.slapend, 3);
  assert.match(r.getallen.namen.join(' '), /Bryan/);
});

test('een kaart die vandaag is aangemaakt geeft geen vals alarm', () => {
  // Nog geen dag oud: de cron kan er simpelweg nog niet langs zijn geweest.
  const r = controleerInstroom({
    taken: [{ naam: 'Vers', due: dagPlus(VANDAAG, 14), aangemaakt_op: VANDAAG }],
    vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, OK);
});

test('een kaart binnen de grens is in orde', () => {
  const r = controleerInstroom({
    taken: [{ naam: 'Morgen', due: dagPlus(VANDAAG, SLAPER_MAX_DAGEN), aangemaakt_op: '2026-09-01' }],
    vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, OK);
});

test('geen enkele onaangeraakte kaart is NIET GEMETEN, geen "in orde"', () => {
  // De val waar dit hele bouwwerk anders in loopt: niets gevonden als groen
  // boeken betekent dat een kapotte bron zich voordoet als een gezonde.
  const r = controleerInstroom({ taken: [], vandaag: VANDAAG, dagPlus });
  assert.equal(r.staat, NIET_GEMETEN);
  assert.notEqual(r.staat, OK);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · OPTELLING
// ═══════════════════════════════════════════════════════════════════════════

test('de te-kort-teller van vanmiddag was opgevallen', () => {
  // Het live antwoord was {uit: 9, gesproken: 5, te_kort: 1}: 5+1 is geen 9.
  const r = controleerOptelling({ rapport: {
    volume: { bel: { uit: 9, gesproken: 5, te_kort: 1, niet_opgenomen: 0, zonder_duur: 0 } },
    aandacht: [],
  } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.som, 6);
  assert.equal(r.getallen.uit, 9);
  assert.match(r.uitleg, /tellen op tot 6/);
});

test('de gerepareerde verdeling telt wél op', () => {
  const r = controleerOptelling({ rapport: {
    volume: { bel: { uit: 9, gesproken: 5, te_kort: 1, niet_opgenomen: 3, zonder_duur: 0 } },
    aandacht: [{}, {}],
  } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.som, 9);
  assert.equal(r.getallen.bevindingen, 2);
});

test('een rapport zonder volume is NIET GEMETEN', () => {
  assert.equal(controleerOptelling({ rapport: {} }).staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DUBBELS
// ═══════════════════════════════════════════════════════════════════════════

test('de dubbele Yasmine was opgevallen', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'y-oud', persoon: 'e:y@x.nl', dag: '2026-09-07', tijd: '14:00' },
    { appointment_id: 'y-nw',  persoon: 'e:y@x.nl', dag: '2026-09-07', tijd: '14:00' },
  ] } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.dubbel_op_persoon_en_tijd, 1);
});

test('hetzelfde afspraak-id twee keer valt ook op', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'a1', persoon: 'e:a@x.nl', dag: '2026-09-07', tijd: '10:00' },
    { appointment_id: 'a1', persoon: 'e:a@x.nl', dag: '2026-09-07', tijd: '11:00' },
  ] } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.dubbel_op_id, 1);
});

test('vijf verschillende calls zijn in orde', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'a', persoon: 'e:1@x', dag: '2026-09-07', tijd: '07:30' },
    { appointment_id: 'b', persoon: 'e:2@x', dag: '2026-09-07', tijd: '14:00' },
    { appointment_id: 'c', persoon: 'e:3@x', dag: '2026-09-07', tijd: '17:00' },
    { appointment_id: 'd', persoon: 'e:4@x', dag: '2026-09-07', tijd: '18:30' },
    { appointment_id: 'e', persoon: 'e:5@x', dag: '2026-09-07', tijd: '18:30' },
  ] } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.regels, 5);
});

test('geen zoomcalls is NIET GEMETEN', () => {
  assert.equal(controleerDubbels({ rapport: { zoomcalls: [] } }).staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · PRINTWEERGAVE
// ═══════════════════════════════════════════════════════════════════════════

test('de crash van vanmiddag was opgevallen', () => {
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: "Cannot access 'nlDatum' before initialization",
    html: '<div class="melding">Rapport wordt opgehaald…</div>', versie: null, verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /nlDatum/);
  assert.match(r.uitleg, /laadtekst/);
});

test('de oudere build die daarna nog werd uitgeleverd was óók opgevallen', () => {
  // Dit is de tweede helft van dezelfde halve dag: de code was gerepareerd, de
  // server leverde de oude pagina.
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: null, html: '<div>een compleet rapport</div>',
    versie: 'rp-1', verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /oudere build/);
});

test('een pagina die tekent is in orde', () => {
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: null, html: 'x'.repeat(4000), versie: 'rp-2', verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, OK);
});

test('onbereikbaar is NIET GEMETEN, geen fout en zeker geen ok', () => {
  const r = beoordeelPrintweergave({ bereikbaar: false, fout: 'HTTP 500' });
  assert.equal(r.staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE BRUG
// ═══════════════════════════════════════════════════════════════════════════

test('de LID-storing van vanochtend was opgevallen', () => {
  // 92 gezien, 1 doorgelaten — maar zelfs 0 doorgelaten hield de brug 'verbonden'.
  const r = controleerBrug({ status: {
    verbonden: true,
    tellers: { gezien: { message: 21, message_create: 38, message_ack: 33 },
               doorgelaten: { message: 0, message_create: 0, message_ack: 0 } },
  } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.gezien, 92);
  assert.match(r.uitleg, /nul door/);
});

test('een brug die eruit ligt is fout', () => {
  assert.equal(controleerBrug({ status: { verbonden: false, tellers: {} } }).staat, FOUT);
});

test('verbonden maar niets gezien is NIET GEMETEN', () => {
  // Zondagochtend: er is niets gebeurd. Dat is geen bewijs dat het werkt.
  const r = controleerBrug({ status: { verbonden: true, tellers: { gezien: {}, doorgelaten: {} } } });
  assert.equal(r.staat, NIET_GEMETEN);
});

test('gezien én doorgelaten is in orde', () => {
  const r = controleerBrug({ status: {
    verbonden: true,
    tellers: { gezien: { message: 10 }, doorgelaten: { message: 7 } },
  } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.doorgelaten, 7);
});

test('geen status is NIET GEMETEN', () => {
  assert.equal(controleerBrug({ status: null, fout: 'timeout' }).staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MAIL
// ═══════════════════════════════════════════════════════════════════════════

test('de mail draagt de getallen, niet alleen een oordeel', () => {
  // Een mail die alleen 'in orde' zegt is niet na te rekenen, en daarmee precies
  // zo'n alibi als de tests die we deze week hebben opgeruimd.
  const m = bouwMail({ dag: VANDAAG, uitkomsten: [
    controleerOptelling({ rapport: { volume: { bel: { uit: 9, gesproken: 5, te_kort: 1, niet_opgenomen: 3, zonder_duur: 0 } }, aandacht: [] } }),
  ] });
  assert.match(m.text, /uit=9/);
  assert.match(m.text, /gesproken=5/);
  assert.match(m.text, /som=9/);
});

test('de onderwerpregel draagt het oordeel', () => {
  const stuk = bouwMail({ dag: VANDAAG, uitkomsten: [{ naam: 'x', staat: FOUT, getallen: {}, uitleg: 'y' }] });
  assert.match(stuk.subject, /1 probleem/);
  const goed = bouwMail({ dag: VANDAAG, uitkomsten: [{ naam: 'x', staat: OK, getallen: {}, uitleg: 'y' }] });
  assert.match(goed.subject, /1\/1 in orde/);
});

test('niet-gemeten staat apart in de onderwerpregel', () => {
  // Anders leest een dag waarop niets gemeten kon worden als een goede dag.
  const m = bouwMail({ dag: VANDAAG, uitkomsten: [
    { naam: 'a', staat: OK, getallen: {}, uitleg: '' },
    { naam: 'b', staat: NIET_GEMETEN, getallen: {}, uitleg: '' },
  ] });
  assert.match(m.subject, /1 niet gemeten/);
  assert.doesNotMatch(m.subject, /2\/2 in orde/);
});
