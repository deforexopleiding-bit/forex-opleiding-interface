// tests/opvolging-whatsapp-qr-verversing.test.js
//
// De QR in het WhatsApp-koppelpaneel moet écht elke 20 seconden verversen.
//
// DE VAL DIE HIER VASTLIGT
// herstelWaTimers() wordt aan het eind van elke statusronde aangeroepen. Met
// het paneel open is dat om de vijf seconden. De eerste versie stopte daarbij
// altijd álle timers en zette ze daarna opnieuw op — dus werd de QR-timer van
// twintig seconden elke vijf seconden vernietigd en opnieuw begonnen, en haalde
// hij zijn deadline nooit.
//
// Er ging niets stuk. De status werd netjes opgehaald, het paneel stond er, de
// logs waren schoon. Alleen ververste de code op het scherm niet, en stond Dave
// een verlopen QR te scannen die WhatsApp weigerde. Precies het soort fout dat
// je alleen vindt door de verzoeken te tellen — vandaar deze test, die dat doet
// met een nepklok tegen het echte viewbestand.
//
// Wat óók vastligt: dat de opruimlogica intact blijft. Sluiten, wegnavigeren en
// gekoppeld-raken moeten de timers nog steeds stilzetten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BRON = readFileSync(VIEW, 'utf8');

/**
 * Het echte viewbestand in een sandbox, met een klok die wij vooruitdraaien.
 *
 * De timers zijn nep zodat we per honderd milliseconde kunnen stappen zonder te
 * wachten; verzoeken worden geteld met het tijdstip erbij, zodat we niet alleen
 * kunnen zien dát er iets gebeurde maar ook wannéér.
 */
function bouwSandbox({ verbonden = false } = {}) {
  let nu = 0;
  let volgendeId = 1;
  const intervallen = new Map();          // id -> { ms, fn, volgende }
  const verzoeken = [];
  let gekoppeld = verbonden;

  const setIntervalNep = (fn, ms) => {
    const id = volgendeId++;
    intervallen.set(id, { ms, fn, volgende: nu + ms });
    return id;
  };
  const clearIntervalNep = (id) => { intervallen.delete(id); };

  const window = {
    DFO  : { VIEWS: {}, render() {} },
    KV_V2: { helpers: {} },
    KV   : {
      authedJson: async (url) => {
        verzoeken.push({ t: nu, url });
        if (url.includes('wat=qr')) return { qr: 'data:image/png;base64,QR@' + nu };
        return { verbonden: gekoppeld, nummer: gekoppeld ? '32470111222' : null, wacht_op_qr: !gekoppeld };
      },
    },
    addEventListener() {},
    setInterval: setIntervalNep,
    clearInterval: clearIntervalNep,
  };
  window.window = window;

  let lampAanwezig = true;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Promise,
    document: {
      getElementById: (id) => (id === 'opv-wa-lamp' && lampAanwezig ? { id } : null),
      head: { appendChild() {} },
      createElement: () => ({ style: {} }),
    },
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    setInterval: setIntervalNep,
    clearInterval: clearIntervalNep,
    setTimeout, setImmediate,
  });
  runInContext(BRON, ctx, { filename: 'opvolging-v2.js' });

  /** Draai de klok vooruit en laat alle beloftes tussendoor afwikkelen. */
  async function tik(ms) {
    const eind = nu + ms;
    while (nu < eind) {
      nu += 100;
      for (const [, t] of [...intervallen]) {
        if (nu >= t.volgende) { t.volgende = nu + t.ms; t.fn(); }
      }
      await new Promise((r) => setImmediate(r));
    }
  }
  const rust = () => new Promise((r) => setImmediate(r));

  return {
    window, tik, rust, verzoeken,
    nu: () => nu,
    intervallen,
    /** De lopende timers, herkenbaar aan hun cadans. */
    timerOpCadans: (ms) => [...intervallen.entries()].find(([, t]) => t.ms === ms) || null,
    zetVerbonden: (v) => { gekoppeld = v; },
    verwijderLamp: () => { lampAanwezig = false; },
    van: (deel) => verzoeken.filter((v) => v.url.includes(deel)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DE BUG ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('de QR ververst elke 20 seconden terwijl de status elke 5 seconden loopt', async () => {
  const s = bouwSandbox();
  s.window.__opvWaOpen();
  await s.rust();
  await s.tik(30000);

  const status = s.van('wat=status');
  const qr     = s.van('wat=qr');

  // De status deed het altijd al; die is hier de referentie.
  assert.equal(status.length, 7, 'status hoort 7x te lopen in 30 s (t=0 plus elke 5 s)');

  // Dit is de meting die de bug blootlegde: hiervoor bleef het bij die ene
  // ophaal van bij het openen, en bleef er dus een verlopen code op het scherm.
  assert.ok(qr.length >= 2,
    `de QR hoort minstens 2x opgehaald te worden in 30 s, gemeten: ${qr.length}x ` +
    `op t = ${qr.map((v) => v.t / 1000).join(', ')}s`);
  assert.deepEqual(qr.map((v) => v.t), [0, 20000], 'eerst bij openen, daarna op de 20e seconde');
});

test('herhaald herstellen met dezelfde cadans laat de lopende QR-timer met rust', async () => {
  // De kern. Elke statusronde roept herstelWaTimers() aan; als die de QR-timer
  // vervangt in plaats van hem te laten lopen, schuift de deadline telkens 20
  // seconden vooruit en gaat hij nooit af.
  const s = bouwSandbox();
  s.window.__opvWaOpen();
  await s.rust();

  const [idBijStart, timerBijStart] = s.timerOpCadans(20000);
  assert.ok(idBijStart, 'er hoort een QR-timer van 20 s te lopen');
  const deadlineBijStart = timerBijStart.volgende;
  assert.equal(deadlineBijStart, 20000);

  // 15 seconden verder: drie statusrondes, dus drie keer herstelWaTimers().
  await s.tik(15000);
  assert.equal(s.van('wat=status').length, 4, 'drie statusrondes plus die bij openen');

  const [idNa, timerNa] = s.timerOpCadans(20000) || [];
  assert.equal(idNa, idBijStart, 'het moet dezelfde timer zijn, niet een verse');
  assert.equal(timerNa.volgende, deadlineBijStart,
    'de deadline mag niet opgeschoven zijn — anders haalt hij de 20 s nooit');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE OPRUIMLOGICA MOET INTACT BLIJVEN
// ═══════════════════════════════════════════════════════════════════════════

test('sluiten stopt de QR en zet de status terug op de rustige cadans', async () => {
  const s = bouwSandbox();
  s.window.__opvWaOpen();
  await s.rust();
  assert.ok(s.timerOpCadans(20000), 'QR loopt met het paneel open');
  assert.ok(s.timerOpCadans(5000), 'status loopt snel met het paneel open');

  s.window.__opvWaSluit();
  await s.rust();
  assert.equal(s.timerOpCadans(20000), null, 'de QR-timer hoort gestopt te zijn');
  assert.equal(s.timerOpCadans(5000), null, 'de snelle status-timer hoort weg te zijn');
  assert.ok(s.timerOpCadans(60000), 'het lampje blijft op de rustige cadans doorlopen');

  const qrVoor = s.van('wat=qr').length;
  await s.tik(60000);
  assert.equal(s.van('wat=qr').length, qrVoor, 'na sluiten hoort er geen QR meer opgehaald te worden');
});

test('zodra de brug gekoppeld is stopt het pollen helemaal', async () => {
  const s = bouwSandbox();
  s.window.__opvWaOpen();
  await s.rust();
  assert.ok(s.timerOpCadans(20000));

  // De brug meldt bij de volgende ronde dat er gekoppeld is.
  s.zetVerbonden(true);
  await s.tik(5000);

  assert.equal(s.timerOpCadans(20000), null, 'geen QR meer nodig');
  assert.equal(s.timerOpCadans(5000), null, 'geen snelle status meer nodig');
  assert.equal(s.intervallen.size, 0, 'er hoort helemaal niets meer te lopen');

  const totaal = s.verzoeken.length;
  await s.tik(120000);
  assert.equal(s.verzoeken.length, totaal, 'er mag daarna geen enkel verzoek meer uitgaan');
});

test('wegnavigeren stopt alles, ook midden in een ronde', async () => {
  const s = bouwSandbox();
  s.window.__opvWaOpen();
  await s.rust();
  assert.ok(s.intervallen.size > 0);

  // Het lampje verdwijnt uit de DOM: de gebruiker is naar een ander scherm.
  s.verwijderLamp();
  await s.tik(6000);

  assert.equal(s.intervallen.size, 0, 'zonder lampje horen alle timers zichzelf te stoppen');
  const totaal = s.verzoeken.length;
  await s.tik(120000);
  assert.equal(s.verzoeken.length, totaal, 'en er gaat niets meer uit');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BESLISSING ERACHTER
// ═══════════════════════════════════════════════════════════════════════════

test('bepaalTimerActie raakt alleen aan wat verandert', () => {
  const s = bouwSandbox();
  const { bepaalTimerActie } = s.window.__opvWaHelpers;

  // 'behouden' is het geval waar het om draait: dezelfde cadans betekent met
  // rust laten, niet vervangen.
  assert.equal(bepaalTimerActie(20000, 20000), 'behouden');
  assert.equal(bepaalTimerActie(5000, 5000), 'behouden');

  assert.equal(bepaalTimerActie(null, 20000), 'starten');
  assert.equal(bepaalTimerActie(20000, null), 'stoppen');
  assert.equal(bepaalTimerActie(5000, 60000), 'herstarten', 'andere cadans hoort wél vervangen te worden');
  assert.equal(bepaalTimerActie(null, null), 'niets');
});
