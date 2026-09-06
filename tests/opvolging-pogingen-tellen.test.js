// tests/opvolging-pogingen-tellen.test.js
//
// P — de pogingenteller loog. Op de kaart van één lead stond '12 van de 2, met
// 11 keer WhatsApp', terwijl er die middag ZES dingen gebeurd waren:
//
//   · één tekstbericht verstuurd
//   · één spraakbericht verstuurd
//   · twee tekstantwoorden terug
//   · één spraakbericht terug
//   · één keer gebeld zonder gehoor
//
// Wat er in opvolging_pogingen stond, in volgorde — twaalf rijen:
//
//   11.29.56 whatsapp verstuurd      ┐ hetzelfde bericht, twee rijen: het
//   11.29.57 whatsapp verstuurd      ┘ bericht-id ontbrak, dus geen ontdubbeling
//   11.29.58 whatsapp afgeleverd     ┐
//   11.30.17 spraakbericht verstuurd │
//   11.30.19 whatsapp afgeleverd     │ statussen van een bericht dat al
//   11.30.41 whatsapp gelezen        │ verstuurd was — geen pogingen
//   11.30.41 whatsapp gelezen        │
//   11.30.41 whatsapp gelezen        ┘
//   11.30.47 antwoord ontvangen      ┐ moeite van de LEAD, niet van Dave
//   11.30.53 antwoord ontvangen      │
//   11.31.00 spraakbericht ontvangen ┘
//   11.32.55 call niet opgenomen       — dit is wél een poging
//
// DRIE OORZAKEN, en deze tests dekken ze alle drie af.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { telPogingen, isMoeite, isContact, isUitgaand }
  from '../api/_lib/opvolging-poging-telling.js';
import { berichtIdVan, berichtIdVorm, PADEN }
  from '../services/whatsapp-brug/lib/berichtid.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAG = '2026-09-06';
const isoDag = (d) => new Date(d).toISOString().slice(0, 10);
const op = (tijd) => DAG + 'T' + tijd + '+02:00';

// ═══════════════════════════════════════════════════════════════════════════
// DE ECHTE MIDDAG, ZOALS HIJ HOORT TE ZIJN
// ═══════════════════════════════════════════════════════════════════════════
//
// Dezelfde middag, maar zoals de rijen er ná deze PR uitzien: het versturen is
// één rij, de statussen maken er geen, en de antwoorden dragen richting 'in'.

const MIDDAG = [
  { soort: 'whatsapp',      resultaat: 'verstuurd',            richting: 'uit', tijdstip: op('11:29:56') },
  { soort: 'spraakbericht', resultaat: 'spraakbericht verstuurd', richting: 'uit', tijdstip: op('11:30:17') },
  { soort: 'whatsapp',      resultaat: 'antwoord ontvangen',   richting: 'in',  tijdstip: op('11:30:47') },
  { soort: 'whatsapp',      resultaat: 'antwoord ontvangen',   richting: 'in',  tijdstip: op('11:30:53') },
  { soort: 'spraakbericht', resultaat: 'spraakbericht ontvangen', richting: 'in', tijdstip: op('11:31:00') },
  { soort: 'call',          resultaat: 'niet opgenomen',       richting: 'uit', tijdstip: op('11:32:55') },
];

test('de echte middag levert 3 pogingen op, niet 12', () => {
  const t = telPogingen(MIDDAG, DAG, isoDag);
  assert.equal(t.pogingen_totaal, 3, 'twee verstuurde berichten en één belpoging');
});

test('en 2 keer WhatsApp, niet 11', () => {
  const t = telPogingen(MIDDAG, DAG, isoDag);
  assert.equal(t.wa_totaal, 2, 'één tekst en één spraakbericht, allebei verstuurd');
  assert.equal(t.wa_vandaag, 2);
});

test('de belpoging telt gewoon mee', () => {
  const t = telPogingen(MIDDAG, DAG, isoDag);
  assert.equal(t.bel_totaal, 1);
  assert.equal(t.bel_vandaag, 1);
  assert.equal(t.bel_dagen, 1);
});

test('de drie antwoorden staan er nog wél, maar apart', () => {
  // Ze moeten geregistreerd blijven: het is echt contact en het telt mee voor
  // de archiveerregel. Alleen niet als moeite van Dave.
  const t = telPogingen(MIDDAG, DAG, isoDag);
  assert.equal(t.inkomend, 3);
  assert.equal(t.pogingen.length, 6, 'alle zes de rijen blijven bewaard');
});

test('een antwoord van de lead geldt als contact', () => {
  const antwoord = MIDDAG.find((p) => p.richting === 'in');
  assert.equal(isContact(antwoord), true, 'de lead heeft echt gereageerd');
  assert.equal(isMoeite(antwoord), false, 'maar het is geen moeite van Dave');
});

test('een call zonder gehoor is moeite maar geen contact', () => {
  const call = MIDDAG.find((p) => p.soort === 'call');
  assert.equal(isMoeite(call), true);
  assert.equal(isContact(call), false, 'er is niemand aan de lijn geweest');
});

test('een gesproken call is allebei', () => {
  const p = { soort: 'call', resultaat: 'gesproken, wil nog beslissen', richting: 'uit', tijdstip: op('12:00:00') };
  assert.equal(isMoeite(p), true);
  assert.equal(isContact(p), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE RICHTING KOMT UIT DE KOLOM
// ═══════════════════════════════════════════════════════════════════════════

test('een rij zonder richting telt als uitgaand', () => {
  // De historische aanname. De opruim-query zet de inkomende rijen die er nog
  // staan eenmalig op 'in'.
  assert.equal(isUitgaand({ soort: 'call' }), true);
  assert.equal(isUitgaand({ soort: 'whatsapp', richting: 'uit' }), true);
  assert.equal(isUitgaand({ soort: 'whatsapp', richting: 'in' }), false);
});

test('de richting wordt NERGENS uit de tekst van resultaat afgeleid', () => {
  // Dat is een parser op een zin die iemand ooit anders formuleert. Een rij die
  // 'ontvangen' in zijn tekst heeft maar richting 'uit' draagt, telt als moeite.
  const raar = { soort: 'whatsapp', resultaat: 'antwoord ontvangen', richting: 'uit', tijdstip: op('11:00:00') };
  assert.equal(isMoeite(raar), true, 'de kolom wint, niet het woord');
  const code = readFileSync(join(ROOT, 'api/_lib/opvolging-poging-telling.js'), 'utf8')
    .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.ok(!/ontvangen|verstuurd/.test(code), 'geen woorden uit resultaat in de telling');
});

test('de twee vensters lezen de richting ook uit de kolom', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  // Vanaf de uitgaand-helper: die staat vóór de twee functies en draagt de regel.
  const i = view.indexOf('const uitgaand = (p) =>');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const blok = view.slice(i, view.indexOf('function beoordeelSpraak', i));
  assert.ok(!/\/verstuurd\/i|\/ontvangen\/i/.test(blok), 'geen regex meer op resultaat');
  assert.match(blok, /p\.richting !== 'in'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AFGELEVERD EN GELEZEN MAKEN NOOIT EEN RIJ
// ═══════════════════════════════════════════════════════════════════════════

const HOOK = () => readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');

test('afgeleverd en gelezen staan als statussoorten apart', () => {
  const b = HOOK();
  assert.match(b, /const STATUS_SOORTEN = new Set\(\['afgeleverd', 'gelezen'\]\)/);
});

test("'verzonden' hoort daar NIET bij — dat is het moment zelf", () => {
  const b = HOOK();
  const i = b.indexOf('const STATUS_SOORTEN');
  assert.ok(!b.slice(i, i + 120).includes("'verzonden'"));
});

test('een status wordt afgehandeld vóór er een rij geschreven wordt', () => {
  const b = HOOK();
  const status = b.indexOf('if (STATUS_SOORTEN.has(soort))');
  const insert = b.indexOf(".from('opvolging_pogingen')\n        .insert(rij)");
  assert.ok(status > 0, 'de statustak hoort te bestaan');
  assert.ok(insert < 0 || status < insert, 'en vóór de insert te staan');
});

test('de statushelper maakt nooit een rij aan', () => {
  const b = HOOK();
  const i = b.indexOf('async function werkStatusBij');
  const blok = b.slice(i, b.indexOf('\n}', i));
  assert.ok(!/\.insert\(/.test(blok), 'werkStatusBij hoort alleen bij te werken');
  assert.match(blok, /\.update\(/);
});

test('vindt hij de poging niet, dan doet hij niets', () => {
  // Liever geen status dan een verzonnen poging.
  const b = HOOK();
  const i = b.indexOf('async function werkStatusBij');
  const blok = b.slice(i, b.indexOf('\n}', i));
  assert.match(blok, /if \(!sleutel\) return false/);
  assert.match(blok, /if \(!data \|\| !data\[0\]\) return false/);
});

test('drie leesbevestigingen op dezelfde seconde leveren nul rijen op', () => {
  // Dit is de reeks uit productie: 11.30.41 drie keer 'gelezen'. Drie rijen
  // werden het. Nu maakt geen enkele een rij — hooguit werken ze dezelfde rij
  // bij, en dat is een update, geen poging.
  const b = HOOK();
  const i = b.indexOf('if (STATUS_SOORTEN.has(soort))');
  const blok = b.slice(i, i + 900);
  assert.match(blok, /werkStatusBij\(/);
  assert.match(blok, /return res\.status\(200\)/, 'en het antwoord blijft een 200');
  assert.ok(!/\.insert\(/.test(blok));
});

test('het antwoord zegt waaróm er niets bijgewerkt is', () => {
  // Anders is 'niets gedaan' opnieuw een stilte.
  const b = HOOK();
  const i = b.indexOf('if (STATUS_SOORTEN.has(soort))');
  const blok = b.slice(i, i + 900);
  assert.match(blok, /geen_bericht_id/);
  assert.match(blok, /geen_bijbehorende_poging/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN ONTBREKEND BERICHT-ID MAG NIET STIL TOT DUBBELE RIJEN LEIDEN
// ═══════════════════════════════════════════════════════════════════════════
//
// Dit is de fout die het geheel veroorzaakte: bericht_id stond overal op NULL,
// dus de ontdubbeling had nog nooit gewerkt, en message_create en de ack maakten
// allebei hun eigen rij. Vandaar 'verstuurd' om 11.29.56 én om 11.29.57.

test('zonder bericht-id is er geen sleutel, en dat is zichtbaar', () => {
  const b = HOOK();
  assert.match(b, /const sleutel = berichtId \? berichtId \+ '#' \+ idemSoort\(soort\) : null/);
});

test('een status zonder sleutel maakt geen rij, maar meldt het wel', () => {
  const b = HOOK();
  const i = b.indexOf('if (STATUS_SOORTEN.has(soort))');
  assert.match(b.slice(i, i + 900), /sleutel \? 'geen_bijbehorende_poging' : 'geen_bericht_id'/);
});

test('het bericht-id wordt gezocht langs meerdere paden', () => {
  assert.ok(PADEN.length >= 4, 'er horen meerdere paden geprobeerd te worden');
  assert.deepEqual(PADEN.map((p) => p[0]),
    ['id._serialized', 'id.triple', 'id.string', 'data.id._serialized', 'data.id.triple']);
});

test('_serialized wint als hij er is', () => {
  const msg = { id: { _serialized: 'true_32470123456@c.us_ABC123', id: 'ABC123', remote: '32470123456@c.us', fromMe: true } };
  const uit = berichtIdVan(msg);
  assert.equal(uit.pad, 'id._serialized');
  assert.equal(uit.id, 'true_32470123456@c.us_ABC123');
});

test('zonder _serialized wordt de sleutel uit de eigen velden opgebouwd', () => {
  // Dat is geen vervangende sleutel uit tijdstip plus nummer: id.id ÍS het
  // bericht-id dat WhatsApp heeft toegekend. We zetten hem alleen terug in het
  // formaat dat de bibliotheek er zelf van maakt.
  const msg = { id: { id: 'ABC123', remote: '32470123456@c.us', fromMe: true } };
  const uit = berichtIdVan(msg);
  assert.equal(uit.pad, 'id.triple');
  assert.equal(uit.id, 'true_32470123456@c.us_ABC123');
});

test('een remote als Wid-object werkt ook', () => {
  const msg = { id: { id: 'ABC', remote: { _serialized: '32470123456@c.us' }, fromMe: false } };
  assert.equal(berichtIdVan(msg).id, 'false_32470123456@c.us_ABC');
});

test('de ruwe laag is de laatste terugval', () => {
  const msg = { _data: { id: { id: 'XYZ', remote: '32470123456@c.us', fromMe: true } } };
  assert.equal(berichtIdVan(msg).pad, 'data.id.triple');
});

test('geen enkel pad levert iets: dan null, en géén bijna-sleutel', () => {
  // Een sleutel verzinnen uit tijdstip plus nummer zou later stil verkeerd
  // ontdubbelen, en dat is erger dan niet ontdubbelen.
  for (const msg of [{}, { id: {} }, { id: { id: 'ABC' } }, { id: { remote: 'x@c.us' } }, null]) {
    const uit = berichtIdVan(msg);
    assert.equal(uit.id, null, JSON.stringify(msg));
    assert.equal(uit.pad, 'geen');
  }
});

test('de meting draagt alleen het pad en de lengte, nooit de waarde', () => {
  const uit = berichtIdVan({ id: { id: 'ABC123', remote: '32470123456@c.us', fromMe: true } });
  const vorm = berichtIdVorm(uit);
  assert.equal(vorm, 'id.triple/' + uit.id.length);
  assert.ok(!vorm.includes('32470123456'), 'in een bericht-id zit het nummer van de tegenpartij');
  assert.ok(!vorm.includes('ABC123'));
});

test('geen id levert een eigen vorm op, geen lege sleutel', () => {
  assert.equal(berichtIdVorm({ id: null, pad: 'geen' }), 'geen/0');
});

test('de vormen komen mee in /status', () => {
  const b = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js'), 'utf8');
  assert.match(b, /bericht_id_vormen : \{ \.\.\.berichtIdVormen \}/);
});

test('het pad gaat NIET mee de draad op', () => {
  // Een bestaande test bewaakt precies welke velden een gebeurtenis draagt.
  // Wat er niet in hoeft, hoort er niet in.
  const g = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/gebeurtenis.js'), 'utf8');
  assert.ok(!/bericht_id_pad/.test(g));
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLING STAAT OP ÉÉN PLEK
// ═══════════════════════════════════════════════════════════════════════════

test('opvolging-taken telt niet meer zelf', () => {
  // De filterregel stond er twee keer, met dezelfde woorden. Twee kopieën is
  // hoe 'wat telt mee' op twee manieren kan gaan betekenen.
  const b = readFileSync(join(ROOT, 'api/opvolging-taken.js'), 'utf8');
  assert.ok(!/p\.soort === 'whatsapp' \|\| p\.soort === 'spraakbericht'/.test(b));
  assert.equal((b.match(/telPogingen\(/g) || []).length, 2);
});

test('elke schrijfplek zet de richting', () => {
  // Een insert zonder richting zou op de default 'uit' landen, en dan telt een
  // binnenkomend bericht alsnog als moeite.
  for (const p of ['api/opvolging-poging.js', 'api/_lib/opvolging-taak-poging.js',
                   'api/_lib/opvolging-call-link.js', 'api/opvolging-agenda.js',
                   'api/opvolging-whatsapp-webhook.js']) {
    assert.match(readFileSync(join(ROOT, p), 'utf8'), /richting/, p);
  }
});

test('de migratie bestaat en is idempotent', () => {
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-06-opvolging-pogingen-richting.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS richting text NOT NULL DEFAULT 'uit'/);
  assert.match(sql, /CHECK \(richting IN \('uit', 'in'\)\)/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS/, 'anders faalt een tweede ronde');
});
