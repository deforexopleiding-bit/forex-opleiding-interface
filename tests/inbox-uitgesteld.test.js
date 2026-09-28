// tests/inbox-uitgesteld.test.js
//
// Het uitgestelde versturen, en vooral: het ding dat nooit mag gebeuren.
//
// ── WAAR HET OM DRAAIT ───────────────────────────────────────────────────────
// Het scherm en de cron kunnen tegelijk besluiten dat een geparkeerd bericht nú
// weg mag. Twee cron-runs kunnen elkaar overlappen. Iemand kan op "Toch niet"
// drukken op precies het moment dat de cron het oppakt.
//
// In al die gevallen moet er PRECIES ÉÉN winnen. Bij een klant met een
// betalingsachterstand is een dubbel bericht niet "een berichtje te veel" maar
// een reden om te twijfelen aan alles wat je stuurt.
//
// De claim-UPDATE is de hele verdediging, en die is hier nagespeeld met een
// database die zich gedraagt zoals Postgres dat doet: een UPDATE met
// voorwaarden raakt nul of één rij, en wie als tweede komt krijgt niets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Uit de zuivere laag, niet uit inbox-uitgesteld.js: dat bestand importeert de
// databaselaag en valt dan om op een ontbrekende omgevingsvariabele. Derde keer
// dezelfde les in deze bouw, vandaar de vaste regel: wat zuiver kan zijn, staat
// in een bestand dat niets importeert.
import {
  UITSTEL_MS,
  CLAIM_VERVAL_MINUTEN,
  verstuurMoment,
  naarWachtrij,
  uitWachtrij,
} from '../api/_lib/inbox-wachtrij.js';

// ── het moment ──────────────────────────────────────────────────────────────

test('het venster is dertig seconden, niet ongeveer dertig', () => {
  // "Ongeveer" is precies het probleem met een zuivere cron: die draait per
  // minuut, dus het venster zou tussen 30 en 90 seconden liggen. Dan weet je
  // niet wanneer het dicht is, en blijf je ernaar kijken.
  assert.equal(UITSTEL_MS, 30_000);
  const nu = new Date('2026-09-28T10:00:00.000Z');
  assert.equal(verstuurMoment(nu), '2026-09-28T10:00:30.000Z');
});

test('een kapotte klok levert geen bericht op dat nooit vertrekt', () => {
  // Zou verstuur_na onzin worden, dan valt de rij buiten elke opvraging en
  // blijft hij eeuwig staan — het stilste soort storing dat er is.
  for (const rommel of [null, undefined, 'straks', NaN, {}]) {
    const m = verstuurMoment(rommel);
    assert.ok(!Number.isNaN(Date.parse(m)), `${String(rommel)} gaf een ongeldig moment`);
  }
});

// ── heen en terug ───────────────────────────────────────────────────────────

const TEKST = {
  convId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  mode: 'text', text: 'Dag Jan',
  templateName: '', templateLanguage: 'nl', templateVariables: null, templateComponents: [],
  mediaKind: null, mediaLink: '', mediaCaption: '', mediaFilename: '',
};

test('een tekstbericht komt er na parkeren ongeschonden uit', () => {
  // Als hier iets wegvalt, staat er straks iets anders in de wacht dan wat
  // iemand getypt heeft — en dat merkt hij pas als de klant het heeft.
  const heen = naarWachtrij(TEKST, { doorGebruiker: 'u1' });
  const terug = uitWachtrij({ ...heen, conversation_id: TEKST.convId });
  assert.equal(terug.mode, 'text');
  assert.equal(terug.text, 'Dag Jan');
  assert.equal(terug.convId, TEKST.convId);
});

test('een template met variabelen overleeft de wachtrij', () => {
  const tpl = {
    ...TEKST, mode: 'template', text: '',
    templateName: 'herinnering', templateLanguage: 'nl',
    templateVariables: { 1: 'Jan' },
    templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Jan' }] }],
  };
  const terug = uitWachtrij({ ...naarWachtrij(tpl), conversation_id: tpl.convId });
  assert.equal(terug.templateName, 'herinnering');
  assert.deepEqual(terug.templateVariables, { 1: 'Jan' });
  assert.equal(terug.templateComponents.length, 1);
});

test('een bijlage overleeft de wachtrij', () => {
  const doc = {
    ...TEKST, mode: 'document', text: '',
    mediaKind: 'document', mediaLink: 'https://x.nl/a.pdf',
    mediaCaption: 'de factuur', mediaFilename: 'factuur.pdf',
  };
  const terug = uitWachtrij({ ...naarWachtrij(doc), conversation_id: doc.convId });
  assert.equal(terug.mediaKind, 'document');
  assert.equal(terug.mediaLink, 'https://x.nl/a.pdf');
  assert.equal(terug.mediaFilename, 'factuur.pdf');
});

test('een geparkeerd bericht staat op gepland en nog van niemand', () => {
  const rij = naarWachtrij(TEKST, { doorGebruiker: 'u1' });
  assert.equal(rij.status, 'gepland');
  assert.equal(rij.aangemaakt_door, 'u1');
  assert.equal(rij.claimed_at, undefined, 'een verse rij hoort niet geclaimd te zijn');
});

// ── de claim: precies één wint ──────────────────────────────────────────────
//
// Een nagespeelde tabel die zich gedraagt als Postgres: een UPDATE met
// voorwaarden raakt de rij alleen als die voorwaarden nog kloppen, en de tweede
// die komt krijgt nul rijen terug.

function maakTabel(beginrij) {
  const rij = { ...beginrij };
  return {
    rij,
    /** Spiegelt: update ... where id=? and status='gepland' and claimed_at is null */
    claim(door) {
      if (rij.status !== 'gepland' || rij.claimed_at !== null) return null;
      rij.claimed_at = `door:${door}`;
      return { ...rij };
    },
    /** Spiegelt annuleer(): dezelfde voorwaarden. */
    annuleer() {
      if (rij.status !== 'gepland' || rij.claimed_at !== null) return null;
      rij.status = 'geannuleerd';
      return { ...rij };
    },
  };
}

const VERS = { id: 'x', status: 'gepland', claimed_at: null };

test('scherm en cron tegelijk: er vertrekt er precies één', () => {
  const t = maakTabel(VERS);
  const scherm = t.claim('scherm');
  const cron = t.claim('cron');
  const gelukt = [scherm, cron].filter(Boolean);
  assert.equal(gelukt.length, 1, 'twee claims betekent twee berichten bij de klant');
  assert.equal(scherm !== null, true, 'wie als eerste komt, wint');
  assert.equal(cron, null, 'wie als tweede komt, hoort niets te krijgen');
});

test('twee cron-runs tegelijk: er vertrekt er precies één', () => {
  // Een run die uitloopt terwijl de volgende al begint, is op Vercel geen
  // bedenksel maar de normale gang van zaken bij een trage Meta.
  const t = maakTabel(VERS);
  const a = t.claim('cron-a');
  const b = t.claim('cron-b');
  assert.equal([a, b].filter(Boolean).length, 1);
});

test('annuleren ná de claim lukt niet — en dat is met opzet', () => {
  // Op dat moment is het bericht ONDERWEG. Een knop die zegt dat hij het
  // tegenhield terwijl de klant het al heeft, is erger dan een knop die zegt
  // dat het te laat is.
  const t = maakTabel(VERS);
  assert.ok(t.claim('cron'), 'de claim hoort te slagen');
  assert.equal(t.annuleer(), null, 'annuleren hoort te falen zodra hij onderweg is');
  assert.equal(t.rij.status, 'gepland', 'en de status hoort niet stiekem te veranderen');
});

test('annuleren vóór de claim lukt, en dan kan niemand het meer versturen', () => {
  const t = maakTabel(VERS);
  assert.ok(t.annuleer(), 'annuleren hoort te slagen zolang hij stilstaat');
  assert.equal(t.claim('cron'), null, 'een geannuleerd bericht hoort niet alsnog te vertrekken');
});

test('een al verstuurd bericht wordt niet nog eens opgepakt', () => {
  const t = maakTabel({ id: 'x', status: 'verstuurd', claimed_at: 'door:eerder' });
  assert.equal(t.claim('cron'), null);
  assert.equal(t.annuleer(), null);
});

// ── de bedrading ────────────────────────────────────────────────────────────

const LIB = readFileSync(new URL('../api/_lib/inbox-uitgesteld.js', import.meta.url), 'utf8');
const CRON = readFileSync(new URL('../api/cron-inbox-uitgesteld.js', import.meta.url), 'utf8');
const ACTIE = readFileSync(new URL('../api/inbox-uitgesteld.js', import.meta.url), 'utf8');
const PARKEER = readFileSync(new URL('../api/inbox-parkeer.js', import.meta.url), 'utf8');
const VERCEL = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('de claim heeft in de code écht alle drie de voorwaarden', () => {
  // Valt er één weg, dan is de hele verdediging weg en merk je dat pas als een
  // klant twee keer hetzelfde krijgt.
  const i = LIB.indexOf('export async function claim');
  const body = LIB.slice(i, i + 700);
  assert.match(body, /\.eq\('id', id\)/);
  assert.match(body, /\.eq\('status', OPEN_STATUS\)/);
  assert.match(body, /\.is\('claimed_at', null\)/);
});

test('annuleren heeft dezelfde voorwaarden als de claim', () => {
  const i = LIB.indexOf('export async function annuleer');
  const body = LIB.slice(i, i + 800);
  assert.match(body, /\.eq\('status', OPEN_STATUS\)/);
  assert.match(body, /\.is\('claimed_at', null\)/);
});

test('hangende claims worden NIET blind vrijgegeven', () => {
  // De voor de hand liggende oplossing — claim wissen, iemand anders pakt 'm
  // op — stuurt het bericht twee keer als Meta het al geaccepteerd had.
  const i = LIB.indexOf('export async function ruimHangendeClaimsOp');
  const body = LIB.slice(i, i + 2500);
  assert.match(body, /from\('whatsapp_messages'\)/, 'er hoort eerst gekeken te worden of er al iets uitging');
  assert.match(body, /\.gte\('sent_at', rij\.claimed_at\)/);
  assert.match(body, /vermoedelijk_verstuurd/);
});

test('de cron draait elke minuut en staat in vercel.json', () => {
  const rij = (VERCEL.crons || []).find((c) => c.path === '/api/cron-inbox-uitgesteld');
  assert.ok(rij, 'zonder regel in vercel.json draait de cron nooit');
  assert.equal(rij.schedule, '* * * * *');
});

test('de cron blijft achter de vlag en achter het cron-geheim', () => {
  assert.match(CRON, /checkCronAuth\(req\)/);
  assert.match(CRON, /if \(!gesprekkenV2Aan\(\)\)/);
});

test('de cron laat één mislukt bericht de rest van de ronde niet blokkeren', () => {
  // De les uit CLAUDE.md: try/catch per item, nooit een early return op één
  // faal-item.
  // Precies de lus afbakenen, niet een blok van zoveel tekens: anders meet je
  // de code eronder mee en betrapt de controle de verkeerde `return`.
  const i = CRON.indexOf('for (const { id } of klaar)');
  const eind = CRON.indexOf("console.log('[cron-inbox-uitgesteld] klaar:", i);
  assert.ok(i > 0 && eind > i, 'de lus hoort vindbaar te zijn');
  const lus = CRON.slice(i, eind);
  assert.match(lus, /try \{/);
  assert.match(lus, /catch \(e\)/);
  assert.match(lus, /continue;/, 'overslaan hoort met continue, niet met return');
  assert.doesNotMatch(lus, /\breturn\b/,
    'een return in de lus laat de rest van de ronde liggen zonder dat iemand het merkt');
});

test('een mislukking komt met reden in de logs én op de rij', () => {
  // Een teller zonder tekst maakt zoeken in de Vercel-logs onmogelijk.
  assert.match(CRON, /console\.warn\('\[cron-inbox-uitgesteld\] niet verstuurd:'/);
  assert.match(CRON, /markeerMislukt\(id, reden\)/);
});

test('parkeren controleert het 24-uursvenster NIET', () => {
  // Dat gebeurt bij het versturen. Een venster dat nu open is, kan over dertig
  // seconden dicht zijn — en dán is het moment om dat te weten.
  assert.doesNotMatch(PARKEER, /last_inbound_at/);
  assert.doesNotMatch(PARKEER, /24h_window_expired/);
});

test('parkeren keurt de opdracht wél, met dezelfde keuring als versturen', () => {
  // Iets parkeren dat straks toch geweigerd wordt, levert een bericht op dat
  // eeuwig in de wacht staat.
  assert.match(PARKEER, /leesVerzendOpdracht\(req\.body\)/);
  assert.match(PARKEER, /metaKlaar\(\)/);
});

test('alle drie de endpoints staan achter de vlag', () => {
  for (const [naam, src] of [['parkeer', PARKEER], ['actie', ACTIE], ['cron', CRON]]) {
    assert.match(src, /gesprekkenV2Aan\(\)/, `${naam} hoort achter de vlag te staan`);
  }
});

test('te laat annuleren geeft 409 en geen stille ok', () => {
  assert.match(ACTIE, /status\(409\)/);
  assert.match(ACTIE, /te_laat/);
  assert.match(ACTIE, /al_opgepakt/);
});

test('de claim vervalt pas ruim na de Vercel-tijdslimiet', () => {
  // Een functie mag hooguit 60 s draaien. Zou de vervaltijd korter zijn, dan
  // geven we claims vrij van processen die nog gewoon bezig zijn.
  assert.ok(CLAIM_VERVAL_MINUTEN * 60 > 60, 'de vervaltijd hoort ruim boven de 60 s te liggen');
});
