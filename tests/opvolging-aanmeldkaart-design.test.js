// tests/opvolging-aanmeldkaart-design.test.js
//
// Wat een aanmeldkaart onder een groepskop wél en niet toont.
//
// Aanleiding: tien echte kaarten op productie (Forex Masterclass Gent, 9 sep).
// Wat daar stond:
//
//  · De groepskop las letterlijk 'Forex Masterclass Gent &middot; Belgie -
//    Deinsesteenweg 108'. Het scheidingsteken stond bínnen esc(), dus de
//    entity werd als tekst getoond in plaats van als teken.
//  · Het volledige postadres stond vetgedrukt naast de eventnaam en duwde die
//    weg.
//  · Elke kaart droeg een badge met precies dezelfde eventnaam, hetzelfde adres
//    en hetzelfde uur als de kop er tien pixels boven.
//  · Per kaart stonden zes etiketten, waaronder twee keer 'geen spraakbericht'
//    (één rood, één grijs) bij iemand die zich diezelfde ochtend had aangemeld
//    en waar dus nog niets fout was.
//
// Alles hieronder legt vast dat die vier weg blijven. De kaart houdt over wat
// Dave nodig heeft: naam, telefoon en de voortgang van vandaag — en verder
// alleen wat een afwijking is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set,
  });
  runInContext(readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8'),
    ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvAanmeldHelpers, 'de view hoort __opvAanmeldHelpers te zetten');
  return window.__opvAanmeldHelpers;
}

const { taakKaart, evGroepKop } = laadView();

const ADRES = 'Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)';

const groep = (over) => ({
  titel: 'Forex Masterclass Gent',
  plaats: ADRES,
  dag: '2026-09-09',
  start: '2026-09-09T16:00:00Z',
  taken: [{ id: 'a' }, { id: 'b' }],
  ...over,
});

const kaart = (over) => ({
  id: 'tk-1', naam: 'Jan Peeters', telefoon: '+32470123456',
  reden: 'aanmelding', due: '2026-09-05',
  badge_label: 'Forex Masterclass Gent Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent) · 9 sep 18:00',
  bel_totaal: 0, bel_dagen: 0, wa_totaal: 0, bel_vandaag: 0, wa_vandaag: 0,
  ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GROEPSKOP
// ═══════════════════════════════════════════════════════════════════════════

test('het scheidingsteken staat buiten esc() en wordt dus getekend', () => {
  const h = evGroepKop(groep());
  assert.doesNotMatch(h, /&amp;middot;/,
    "de entity hoort niet als tekst op het scherm te staan");
});

test('alleen de eventnaam staat vet, het adres eronder', () => {
  const h = evGroepKop(groep());
  assert.match(h, /<b>Forex Masterclass Gent<\/b>/, 'de naam is het vette element');
  assert.doesNotMatch(h, /<b>[^<]*Deinsesteenweg/, 'het adres hoort niet in de vette titel');
  assert.match(h, /class="evadr"/, 'het adres staat er wel, klein en grijs eronder');
  assert.ok(h.includes('Deinsesteenweg 108'), 'en het is niet zomaar verdwenen');
});

test('de kop zegt welk event, wanneer, over hoeveel dagen en hoeveel mensen', () => {
  const h = evGroepKop(groep());
  assert.match(h, /Forex Masterclass Gent/, 'welk event');
  assert.match(h, /sep/, 'wanneer');
  assert.match(h, /over \d+ dagen|vandaag|morgen|geweest/, 'over hoeveel dagen');
  assert.match(h, /2 aanmeldingen/, 'hoeveel mensen');
});

test('een groep zonder adres levert geen lege regel op', () => {
  const h = evGroepKop(groep({ plaats: null }));
  assert.doesNotMatch(h, /class="evadr"/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART IN DE GROEP
// ═══════════════════════════════════════════════════════════════════════════

test('de badge met eventnaam en adres verdwijnt zolang de kaart in een groep staat', () => {
  // De kop tien pixels erboven zegt dit al. Drie keer hetzelfde lezen maakt de
  // lijst niet informatiever, alleen langer.
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  assert.doesNotMatch(h, /Deinsesteenweg/);
  assert.doesNotMatch(h, /Forex Masterclass/);
});

test('los van een groep houdt de kaart zijn badge', () => {
  // Buiten een groep is er geen kop die het event noemt, dus daar draagt de
  // badge wél informatie.
  const h = taakKaart(kaart(), '2026-09-05');
  assert.match(h, /Forex Masterclass/);
});

test('naam, telefoon en de voortgang van vandaag staan er altijd', () => {
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  assert.match(h, /Jan Peeters/);
  assert.match(h, /\+32470123456/);
  assert.match(h, /vandaag/);
  assert.match(h, /0\/2/, 'de voortgang als teller, niet als verwijt');
});

test('niets negatiefs zolang er nog niets misgegaan is', () => {
  // Iemand die zich vanmorgen aanmeldde heeft nog niets fout gedaan. 'nog niet
  // gebeld', 'geen WhatsApp' en 'geen spraakbericht' zeggen alle drie hetzelfde
  // als de nul in de teller, maar klinken als een verwijt.
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  for (const woord of ['nog niet gebeld', 'geen WhatsApp', 'geen spraakbericht', 'niet nagebeld']) {
    assert.ok(!h.includes(woord), 'de kaart hoort "' + woord + '" niet te tonen');
  }
});

test('geen dubbele melding meer over het spraakbericht', () => {
  // Er stonden er twee: een rode uit de spraak-beoordeling en een grijze als
  // reden waarom nabellen niet nodig was.
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  const treffers = h.split('spraakbericht').length - 1;
  assert.equal(treffers, 0);
});

test('het reden-etiket verdwijnt in de groep en blijft daarbuiten', () => {
  // Het blok heet al Aanmeldingen; 'aanmelding' op elke kaart voegt niets toe.
  assert.doesNotMatch(taakKaart(kaart(), '2026-09-05', { inGroep: true }), /class="tag [^"]*">aanmelding/);
  assert.match(taakKaart(kaart(), '2026-09-05'), /aanmelding/);
});

test('minder etiketten naast elkaar dan voorheen', () => {
  // Zes stuks was de klacht. Op een kaart zonder afwijkingen hoort er nul te
  // staan; de naam is dan het duidelijkste element.
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  const tags = h.split('class="tag').length - 1;
  assert.equal(tags, 0, 'een kaart zonder afwijking draagt geen etiketten');
});

// ═══════════════════════════════════════════════════════════════════════════
// AFWIJKINGEN TONEN ZICH WÉL
// ═══════════════════════════════════════════════════════════════════════════

test('een kaart die bleef liggen krijgt rood', () => {
  const h = taakKaart(kaart({ due: '2026-09-02' }), '2026-09-05', { inGroep: true });
  assert.match(h, /t-red/);
  assert.match(h, /bleef liggen/);
});

test('twee keer uitstellen zonder poging blijft zichtbaar', () => {
  const h = taakKaart(kaart({ uitgesteld_zonder_poging: 3 }), '2026-09-05', { inGroep: true });
  assert.match(h, /t-amber/);
  assert.match(h, /uitgesteld zonder poging/);
});

test('wat er wél gedaan is, staat er zonder etiket bij', () => {
  const h = taakKaart(kaart({ bel_totaal: 3, bel_dagen: 2, wa_totaal: 1, bel_vandaag: 1 }),
    '2026-09-05', { inGroep: true });
  assert.match(h, /3&times; gebeld op 2 dagen/);
  assert.match(h, /1&times; WhatsApp/);
  assert.match(h, /1\/2/);
});

test('de drie knoppen blijven staan', () => {
  const h = taakKaart(kaart(), '2026-09-05', { inGroep: true });
  assert.match(h, /__opvBel\('tk-1'\)/);
  assert.match(h, /__opvWa\('tk-1'\)/);
  assert.match(h, /__opvWatNu\('tk-1'\)/);
});
