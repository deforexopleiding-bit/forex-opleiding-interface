// tests/opvolging-gezondheid-opwarm.test.js
//
// CONTROLE 7 — HEEFT ELKE GEBOEKTE ZOOMCALL ZIJN OPWARMKAART?
//
// ── DE LES VAN 7 SEPTEMBER, EN WAAROM DEZE CONTROLE ER IS ────────────────
// Toen veranderden we de meetregel en namen we de meter die erop toeziet niet
// mee, waardoor de bewaking zelf ging liegen. Op 14 september is er een nieuwe
// meetregel bijgekomen: elke geboekte zoomcall hoort de dag ná het boeken in
// Daves lijst te staan. Controle 1 kijkt uitsluitend naar
// `bron='event' AND reden='aanmelding'` en ziet een opwarmkaart dus niet —
// zonder deze controle zou precies dezelfde stilte ontstaan.
//
// Drie dingen die stuk kunnen, en alle drie zijn ze stil. De tweede is de
// ergste: een open opwarmkaart VERHINDERT de nabelkaart van 12:00, want
// heeftAlKaart() in cron-opvolging-zoom-nabel matcht óók op telefoonnummer.
// Dan valt een bestaande, werkende functie weg zonder één foutmelding.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  controleerOpwarmronde, controleerDagritme, controleerOptelling, bouwMail,
  OPWARM_REDEN, GRATIE_UREN, OK, FOUT, NIET_GEMETEN,
} from '../api/_lib/opvolging-gezondheid.js';
import { telVolume } from '../api/opvolging-rapport.js';
import { REDEN, MAX_ACHTERSTAND_PER_DAG } from '../api/_lib/opvolging-zoom-opwarm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRON = join(ROOT, 'api/cron-opvolging-gezondheid.js');
const OPWARM_CRON = join(ROOT, 'api/cron-opvolging-zoom-opwarm.js');

const VANDAAG = '2026-09-14';
const QUOTA = MAX_ACHTERSTAND_PER_DAG;

const call = (o = {}) => ({
  id: 'ap-1', telefoon: '+32470111222', calldag: '2026-09-25',
  geboekt_uren_geleden: 48, ...o,
});

const opwarmkaart = (o = {}) => ({
  id: 'tk-1', status: 'open', due: '2026-09-15', reden: OPWARM_REDEN,
  telefoon: '+32470111222', appointment_id: 'ap-1', calldag: '2026-09-25',
  achterstand: false, gemaakt_op: VANDAAG, ...o,
});

const meet = (o) => controleerOpwarmronde({
  vandaag: VANDAAG, dagquota: QUOTA, achterstandVandaag: 0, leesfout: null, ...o,
});

// ═══════════════════════════════════════════════════════════════════════════
// DEEL 1 · HEEFT ELKE CALL ZIJN KAART?
// ═══════════════════════════════════════════════════════════════════════════

test('alles gedekt is in orde, met de getallen erbij', () => {
  const u = meet({ afspraken: [call()], kaarten: [opwarmkaart()] });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.calls, 1);
  assert.equal(u.getallen.gedekt, 1);
  assert.equal(u.getallen.wachtrij, 0);
  assert.equal(u.getallen.open_kaarten, 1);
});

test('een call zonder kaart is FOUT zodra de dripfeed vandaag nog ruimte had', () => {
  // Dan draait de cron niet, of slaat hij rijen over. Dat is het gat waarvoor
  // deze hele ronde bestaat.
  const u = meet({ afspraken: [call()], kaarten: [], achterstandVandaag: 0 });
  assert.equal(u.staat, FOUT);
  assert.match(u.uitleg, /geen kaart/);
  assert.match(u.uitleg, /ruimte/);
  assert.equal(u.getallen.wachtrij, 1);
  assert.equal(u.getallen.ruimte, QUOTA);
});

test('dezelfde call is GEEN fout als de dagquota op is — dat is de wachtrij', () => {
  // De achterstand van 36 boekingen komt met opzet gespreid binnen. Een
  // bewaker die daar elke ochtend op afgaat is binnen een week een bewaker
  // waar niemand meer op reageert.
  const u = meet({ afspraken: [call()], kaarten: [], achterstandVandaag: QUOTA });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.wachtrij, 1);
  assert.equal(u.getallen.ruimte, 0);
  assert.match(u.uitleg, /wachten nog op de dripfeed/);
});

test('een boeking van vijf minuten geleden is geen gat', () => {
  // De cron draait elk kwartier, deze controle om 05:00 UTC. Een call die net
  // geboekt is heeft terecht nog geen kaart.
  const u = meet({
    afspraken: [call({ geboekt_uren_geleden: 0.1 })], kaarten: [], achterstandVandaag: 0,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.te_vers, 1);
  assert.equal(u.getallen.wachtrij, 0);
  assert.ok(GRATIE_UREN >= 1, 'de gratieperiode dekt minstens vier cron-rondes');
});

test('een lead die al om een andere reden op de lijst staat telt als gedekt', () => {
  // Hij is dan niet onzichtbaar, en dat is waar deze controle over gaat. Een
  // tweede kaart zou juist de dubbeling zijn die de crons vermijden.
  const u = meet({
    afspraken: [call()],
    kaarten: [{ id: 'tk-x', status: 'open', reden: 'zoom_geannuleerd',
      telefoon: '0470111222', appointment_id: 'ap-anders', calldag: null, due: VANDAAG }],
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.lead_al_in_lijst, 1, 'match op de laatste negen cijfers');
});

test('een gearchiveerde opwarmkaart dekt de call — bevestigd is afgehandeld', () => {
  const u = meet({
    afspraken: [call()],
    kaarten: [opwarmkaart({ status: 'gearchiveerd' })],
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.gedekt, 1);
  assert.equal(u.getallen.open_kaarten, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DEEL 2 · DE KAART DIE DE NABELRONDE BLOKKEERT
// ═══════════════════════════════════════════════════════════════════════════

test('BLOKKEREND · een open opwarmkaart waarvan de calldag geweest is, is FOUT', () => {
  // heeftAlKaart() in cron-opvolging-zoom-nabel matcht op telefoonnummer. Zo'n
  // kaart laat de nabelkaart van 12:00 verdwijnen zonder één foutmelding.
  const u = meet({
    afspraken: [],
    kaarten: [opwarmkaart({ calldag: '2026-09-13', due: '2026-09-12' })],
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.na_calldag, 1);
  assert.match(u.uitleg, /nabelkaart van 12:00/);
  assert.match(u.uitleg, /telefoonnummer/);
});

test('en dat geldt ook op de calldag zelf, niet pas de dag erna', () => {
  const u = meet({ afspraken: [], kaarten: [opwarmkaart({ calldag: VANDAAG })] });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.na_calldag, 1);
});

test('een kaart die pas wakker wordt ná zijn eigen call is FOUT', () => {
  // Dezelfde vorm als de verdwenen ronde A: de kaart bestaat, en hij komt te
  // laat boven.
  const u = meet({
    afspraken: [call()],
    kaarten: [opwarmkaart({ due: '2026-09-30', calldag: '2026-09-25' })],
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.slapend, 1);
  assert.match(u.uitleg, /wakker ná hun eigen call/);
});

test('een gearchiveerde kaart met een voorbije calldag is geen fout', () => {
  // Die is juist netjes gesloten door de cron.
  const u = meet({
    afspraken: [],
    kaarten: [opwarmkaart({ status: 'gearchiveerd', calldag: '2026-09-10' })],
  });
  assert.equal(u.staat, NIET_GEMETEN, 'er is dan niets te controleren');
  assert.equal(u.getallen.open_kaarten, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE UITKOMSTEN, EN NIET_GEMETEN BLIJFT SMAL
// ═══════════════════════════════════════════════════════════════════════════

test('een leesfout is een FOUT, geen blinde vlek', () => {
  // Een antwoord dat we KREGEN en dat niet deugt. Zie de kop van
  // opvolging-gezondheid.js: 'niet gemeten' is alleen voor een ontbrekende
  // koppeling of een lege meting.
  const u = meet({ afspraken: [], kaarten: [], leesfout: 'relatie bestaat niet' });
  assert.equal(u.staat, FOUT);
  assert.match(u.uitleg, /relatie bestaat niet/);
});

test('een verminkt antwoord is ook een FOUT', () => {
  const u = meet({ afspraken: null, kaarten: [] });
  assert.equal(u.staat, FOUT);
  assert.match(u.uitleg, /verminkt antwoord/);
});

test('geen calls en geen open kaarten is NIET GEMETEN, nooit stil ok', () => {
  const u = meet({ afspraken: [], kaarten: [] });
  assert.equal(u.staat, NIET_GEMETEN);
  assert.match(u.uitleg, /iets anders dan goed/);
});

test('de mail telt niet_gemeten even zwaar als fout', () => {
  const mail = bouwMail({
    uitkomsten: [meet({ afspraken: [], kaarten: [] })], dag: VANDAAG,
  });
  assert.match(mail.subject, /niet gemeten/);
  assert.match(mail.text, /\[NIET GEMETEN\] opwarmronde/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING — een controle die niet aangeroepen wordt bewaakt niets
// ═══════════════════════════════════════════════════════════════════════════

test('de gezondheidscron roept controle 7 aan', () => {
  const src = readFileSync(CRON, 'utf8');
  assert.match(src, /controleerOpwarmronde/);
  assert.match(src, /uitkomsten\.push\(await meetOpwarmronde\(vandaag\)\)/);
});

test('de controle meet met hetzelfde filter als de cron die de kaarten maakt', () => {
  // Wijkt dat af, dan meet de bewaking iets anders dan er gebeurt — en dan
  // gaat ze zelf liegen. Dat is letterlijk de les van 7 september.
  const bewaking = readFileSync(CRON, 'utf8');
  const cron     = readFileSync(OPWARM_CRON, 'utf8');
  for (const regel of [
    /\.eq\('status', 'scheduled'\)/,
    /\.not\('lead_phone', 'is', null\)/,
  ]) {
    assert.match(bewaking, regel, 'de bewaking hanteert ' + regel);
    assert.match(cron, regel, 'de cron hanteert ' + regel);
  }
  assert.match(bewaking, /is_test !== true/);
  assert.match(cron, /is_test !== true/);
  // En een call van vandaag hoort bij de nabelronde, niet bij de opwarmronde.
  // De cron laat die beslissing over aan slaOver() in zijn lib; de bewaking
  // filtert hem er zelf uit. Twee wegen, dezelfde grens.
  assert.match(bewaking, /a\.calldag > vandaag/);
  assert.match(readFileSync(join(ROOT, 'api/_lib/opvolging-zoom-opwarm.js'), 'utf8'),
    /m\.dag <= vandaag\) return 'calldag_is_hier'/);
});

test('de bewaking en de cron noemen dezelfde reden en dezelfde dagquota', () => {
  assert.equal(OPWARM_REDEN, REDEN);
  const src = readFileSync(CRON, 'utf8');
  assert.match(src, /MAX_ACHTERSTAND_PER_DAG/,
    'de quota komt uit de cron-lib, niet uit een tweede getal hier');
});

test('de achterstand-teller kijkt naar het merkteken, niet naar alle kaarten', () => {
  // Verse boekingen tellen niet in de dagquota. Zouden ze dat wel doen, dan
  // meldt de bewaking op een drukke dag een gat dat er niet is.
  const src = readFileSync(CRON, 'utf8');
  assert.match(src, /k\.reden === OPWARM_REDEN && k\.achterstand && k\.gemaakt_op === vandaag/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE AUDIT VAN 14 SEPTEMBER — controle 6 boekte een storing als blinde vlek
// ═══════════════════════════════════════════════════════════════════════════

test('controle 6 boekt een leesfout nu als FOUT, net als controle 1', () => {
  // Gevonden bij het nalopen van alle bestaande controles. Controle 6 is op
  // 10 september gebouwd — ná de opruiming van 7 september — en nam de oude,
  // te zachte vorm alsnog over. De cron duwt bij controle 1 in dezelfde
  // situatie wél FOUT in de lijst.
  const u = controleerDagritme({ taken: [], vandaag: VANDAAG, leesfout: 'timeout' });
  assert.equal(u.staat, FOUT);
  assert.notEqual(u.staat, NIET_GEMETEN);
});

test('controle 2 telt nog steeds dezelfde vier emmers als het rapport vult', () => {
  // GEVONDEN BIJ DEZELFDE AUDIT, en dit is de vorm van 7 september in het klein:
  // de kop van telVolume() in api/opvolging-rapport.js zegt 'VIER EMMERS' en
  // somt er drie op — `via_ander` ontbreekt in die regel. De CODE eronder vult
  // hem wel, als eigen tak in dezelfde if/else-keten, en controleerOptelling
  // telt hem mee. Meter en werkelijkheid kloppen dus; alleen die ene
  // commentaarregel loopt achter.
  //
  // Die regel laten staan is niet gevaarlijk, hem 'repareren' naar de som
  // zonder via_ander wél: dan meldt de bewaking elke dag met een via-ander-call
  // een fout die er niet is — precies de mail van 7 september die afging
  // terwijl de cijfers klopten. Vandaar deze test op het ECHTE gedrag, zodat
  // zo'n reparatie rood wordt in plaats van stil.
  const pogingen = [
    { soort: 'call', resultaat: 'gesproken: bevestigd', duur_sec: 120 },
    { soort: 'call', resultaat: 'niet opgenomen' },
    { soort: 'call', resultaat: 'via ander' },
    { soort: 'call', resultaat: 'iets wat we niet kennen' },
  ];
  const volume = telVolume(pogingen, new Map());
  assert.equal(volume.bel.uit, 4);
  assert.equal(volume.bel.via_ander, 1, 'via_ander is een eigen emmer');

  const u = controleerOptelling({ rapport: { volume, aandacht: [] } });
  assert.equal(u.staat, OK, u.uitleg);
  assert.equal(u.getallen.som, volume.bel.uit);
});

test('een lege takenlijst blijft bij controle 6 gewoon ok', () => {
  // Geen overcorrectie: daar IS de lijst de meting, en dat er niets
  // achterloopt is een uitkomst en geen leegte.
  const u = controleerDagritme({ taken: [{ due: VANDAAG }], vandaag: VANDAAG, leesfout: null });
  assert.equal(u.staat, OK);
});
