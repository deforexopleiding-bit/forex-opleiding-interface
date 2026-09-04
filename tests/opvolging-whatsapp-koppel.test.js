// tests/opvolging-whatsapp-koppel.test.js
//
// Het WhatsApp-lampje en het koppelpaneel in de Opvolging-module.
//
// Twee dingen worden hier bewaakt.
//
//  · De statusweergave. Als de status niet op te halen is, moet dat er anders
//    uitzien dan 'niet gekoppeld'. Die twee door elkaar halen stuurt iemand
//    naar de QR terwijl er misschien niets aan de hand is — of erger, het
//    omgekeerde: een groen lampje terwijl de brug eruit ligt en er dagenlang
//    niets meer binnenkomt.
//
//  · Het opruimen van de timers. Een interval dat blijft doorlopen nadat je
//    weggenavigeerd bent, bevraagt de brug om de vijf seconden vanaf elke
//    andere pagina. Dat merk je niet aan het scherm; dat merk je pas aan de
//    logs van de VPS, of helemaal niet.
//
// De view is een klassiek browser-script en niet te importeren. In plaats van
// de logica hier na te bouwen — die kopie zou meteen uit elkaar lopen — draaien
// we het ECHTE bestand in een vm-sandbox met een nagebootste window, en pakken
// de functies die het op window.__opvWaHelpers zet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

/** Het echte viewbestand draaien tegen een minimale nep-browser. */
function laadView() {
  const window = {
    DFO   : { VIEWS: {}, render() {} },
    KV_V2 : { helpers: {} },
    KV    : { authedJson: async () => ({}) },
    addEventListener() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console,
    queueMicrotask: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Math,
    Number,
    String,
    JSON,
  });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  const h = window.__opvWaHelpers;
  assert.ok(h, 'de view hoort __opvWaHelpers te zetten — is die weggehaald?');
  return h;
}

const { beschrijfWaStatus, bepaalWaTimers, toonNummer, geledenTekst } = laadView();

/**
 * De sandbox is een eigen realm, dus een object dat daaruit komt heeft een
 * andere Object.prototype en struikelt over assert.deepEqual. Overzetten naar
 * een gewoon object van hier maakt de vergelijking weer eerlijk.
 */
const timers = (t) => ({ statusMs: t.statusMs, qrMs: t.qrMs });

// ═══════════════════════════════════════════════════════════════════════════
// DE STATUSWEERGAVE
// ═══════════════════════════════════════════════════════════════════════════

test('gekoppeld is groen, met het nummer erbij', () => {
  const s = beschrijfWaStatus({ data: { verbonden: true, nummer: '32470111222' } });
  assert.equal(s.kleur, 'groen');
  assert.equal(s.verbonden, true);
  assert.equal(s.nummer, '+32 470 111 222');
  assert.equal(s.label, '+32 470 111 222');
  assert.match(s.uitleg, /gekoppeld/i);
});

test('gekoppeld zonder bekend nummer blijft groen', () => {
  // De brug kan verbonden zijn terwijl client.info nog niet gevuld is. Dan is
  // grijs tonen onwaar: de koppeling werkt.
  const s = beschrijfWaStatus({ data: { verbonden: true, nummer: null } });
  assert.equal(s.kleur, 'groen');
  assert.equal(s.label, 'gekoppeld');
  assert.equal(s.nummer, null);
});

test('niet gekoppeld is grijs met die tekst', () => {
  const s = beschrijfWaStatus({ data: { verbonden: false } });
  assert.equal(s.kleur, 'grijs');
  assert.equal(s.verbonden, false);
  assert.equal(s.label, 'niet gekoppeld');
});

test('een wachtende QR wordt in de uitleg genoemd', () => {
  const s = beschrijfWaStatus({ data: { verbonden: false, wacht_op_qr: true } });
  assert.equal(s.kleur, 'grijs');
  assert.match(s.uitleg, /QR/);
});

test('een fout of 503 is grijs met een korte uitleg, niet "niet gekoppeld"', () => {
  // De kern van deze test. Bij een onbereikbare brug wéten we niet of de
  // koppeling leeft; dat als 'niet gekoppeld' tonen is een bewering te veel.
  const s = beschrijfWaStatus({ error: 'De WhatsApp-brug is niet bereikbaar.' });
  assert.equal(s.kleur, 'grijs');
  assert.equal(s.verbonden, false);
  assert.equal(s.label, 'WhatsApp', 'geen stellige tekst als we het niet weten');
  assert.match(s.uitleg, /niet op te halen/i);
  assert.match(s.uitleg, /niet bereikbaar/);
});

test('nog niets opgehaald is grijs en zegt dat het laadt', () => {
  for (const leeg of [{}, { data: null }, undefined]) {
    const s = beschrijfWaStatus(leeg);
    assert.equal(s.kleur, 'grijs');
    assert.equal(s.verbonden, false);
  }
});

test('alleen een echte true telt als verbonden', () => {
  // Een 503-body of een half antwoord mag nooit per ongeluk groen worden.
  for (const raar of ['true', 1, 'ja', {}, null, undefined]) {
    const s = beschrijfWaStatus({ data: { verbonden: raar } });
    assert.equal(s.kleur, 'grijs', JSON.stringify(raar));
  }
});

test('het nummer wordt leesbaar gemaakt en rommel blijft leeg', () => {
  assert.equal(toonNummer('32470111222'), '+32 470 111 222');
  assert.equal(toonNummer('+32 470 111 222'), '+32 470 111 222');
  assert.equal(toonNummer(''), null);
  assert.equal(toonNummer(null), null);
  assert.equal(toonNummer('geen nummer'), null);
});

test('laatst gezien leest als gewone taal', () => {
  const nu = Date.now();
  assert.equal(geledenTekst(null), 'nog niets gezien');
  assert.equal(geledenTekst(new Date(nu - 30 * 1000).toISOString()), 'zojuist');
  assert.equal(geledenTekst(new Date(nu - 5 * 60000).toISOString()), '5 min geleden');
  assert.equal(geledenTekst(new Date(nu - 3 * 3600000).toISOString()), '3 uur geleden');
  assert.equal(geledenTekst(new Date(nu - 26 * 3600000).toISOString()), '1 dag geleden');
  assert.equal(geledenTekst(new Date(nu - 72 * 3600000).toISOString()), '3 dagen geleden');
  // Een tijdstip uit de toekomst (klok scheef op de VPS) mag geen negatieve
  // onzin opleveren.
  assert.equal(geledenTekst(new Date(nu + 60000).toISOString()), 'zojuist');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET OPRUIMEN VAN DE TIMERS
// ═══════════════════════════════════════════════════════════════════════════

test('weggenavigeerd betekent alles uit', () => {
  // Dit is het geval dat stil fout gaat. De shell kent geen afscheidshaak, dus
  // zonder deze uitgang blijft er om de vijf seconden een verzoek naar de brug
  // vanaf elke andere pagina in het CRM.
  for (const paneelOpen of [true, false]) {
    for (const verbonden of [true, false]) {
      const t = bepaalWaTimers({ gemount: false, paneelOpen, verbonden });
      assert.deepEqual(timers(t), { statusMs: null, qrMs: null },
        `gemount:false paneel:${paneelOpen} verbonden:${verbonden}`);
    }
  }
});

test('paneel dicht: alleen het rustige lampje, geen QR', () => {
  for (const verbonden of [true, false]) {
    const t = bepaalWaTimers({ gemount: true, paneelOpen: false, verbonden });
    assert.equal(t.statusMs, 60000, 'één keer per minuut');
    assert.equal(t.qrMs, null, 'geen QR ophalen als er geen paneel open staat');
  }
});

test('paneel open en niet gekoppeld: status elke 5 s, QR elke 20 s', () => {
  const t = bepaalWaTimers({ gemount: true, paneelOpen: true, verbonden: false });
  assert.deepEqual(timers(t), { statusMs: 5000, qrMs: 20000 });
});

test('zodra er gekoppeld is stopt het pollen helemaal', () => {
  // Er valt niets meer te zien, en doorgaan zou de brug elke vijf seconden
  // blijven bevragen voor een antwoord dat niet meer verandert.
  const t = bepaalWaTimers({ gemount: true, paneelOpen: true, verbonden: true });
  assert.deepEqual(timers(t), { statusMs: null, qrMs: null });
});

test('zonder argumenten wordt er niets gestart', () => {
  assert.deepEqual(timers(bepaalWaTimers()), { statusMs: null, qrMs: null });
  assert.deepEqual(timers(bepaalWaTimers({})), { statusMs: null, qrMs: null });
});

test('de QR draait nooit zonder dat de status ook draait', () => {
  // Anders ververst het scherm de code wel maar merkt het niet dat er
  // intussen gekoppeld is, en blijft de QR eeuwig staan.
  for (const gemount of [true, false]) {
    for (const paneelOpen of [true, false]) {
      for (const verbonden of [true, false]) {
        const t = bepaalWaTimers({ gemount, paneelOpen, verbonden });
        if (t.qrMs) assert.ok(t.statusMs, `qr zonder status bij ${gemount}/${paneelOpen}/${verbonden}`);
      }
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING IN HET SCHERM
// ═══════════════════════════════════════════════════════════════════════════

test('het lampje is het levensteken waar de timers op afgaan', () => {
  // waGemount() zoekt id="opv-wa-lamp". Verdwijnt dat id uit de knop, dan
  // stoppen de timers nooit meer — en dat is precies niet te zien aan het
  // scherm. Daarom hier vastgelegd.
  const src = readFileSync(VIEW, 'utf8');
  assert.match(src, /id="opv-wa-lamp"/, 'de knop hoort dit id te dragen');
  assert.match(src, /getElementById\('opv-wa-lamp'\)/, 'waGemount hoort er op te zoeken');
});

test('elke timer wordt opgeruimd bij sluiten, wisselen en unload', () => {
  const src = readFileSync(VIEW, 'utf8');
  assert.match(src, /window\.__opvWaSluit[\s\S]{0,400}herstelWaTimers\(\)/, 'sluiten hoort de timers bij te stellen');
  assert.match(src, /beforeunload['"], stopWaTimers/, 'bij het sluiten van het tabblad hoort alles uit');
  // herstelWaTimers ruimt altijd eerst op voor het opnieuw start: twee
  // intervallen op dezelfde taak is dubbel verkeer dat niemand terugziet.
  assert.match(src, /stopWaTimers\(\);\s*\n\s*if \(wens\.statusMs\)/);
});

test('de koppelinstructie staat er voluit', () => {
  const src = readFileSync(VIEW, 'utf8');
  for (const stap of ['WhatsApp', 'Instellingen', 'Gekoppelde apparaten', 'Apparaat koppelen']) {
    assert.ok(src.includes(stap), 'stap ontbreekt: ' + stap);
  }
  assert.match(src, /class="waqr" width="320" height="320"/, 'de QR hoort 320 bij 320 te zijn');
});

test('er wordt alleen gelezen, en alleen bij het bestaande endpoint', () => {
  const src = readFileSync(VIEW, 'utf8');
  assert.match(src, /opvolging-whatsapp-status\?wat=status/);
  assert.match(src, /opvolging-whatsapp-status\?wat=qr/);
  // Geen POST naar de brug vanuit dit scherm: koppelen is kijken, niet sturen.
  assert.ok(!/opvolging-whatsapp-send/.test(src), 'dit scherm hoort niets te versturen');
});
