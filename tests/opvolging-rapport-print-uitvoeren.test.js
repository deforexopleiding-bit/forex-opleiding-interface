// tests/opvolging-rapport-print-uitvoeren.test.js
//
// DIT BESTAND DRAAIT DE PRINTWEERGAVE ÉCHT, VAN BOVEN NAAR BENEDEN.
//
// De pagina crashte in productie op `ReferenceError: Cannot access 'nlDatum'
// before initialization` — een const-pijlfunctie die in bouw() gebruikt werd
// terwijl hij verderop in het bestand stond. De pagina bleef eeuwig op 'Rapport
// wordt opgehaald' staan, zonder melding en zonder printdialoog.
//
// EN ER STONDEN ACHTTIEN GROENE TESTS OP. Die lazen allemaal de BRONTEKST: is
// er een @page-regel, staat requireAuth vóór de fetch, wordt d.drempels
// gebruikt. Stuk voor stuk zinnige vragen, en geen enkele ervan voert ook maar
// één regel uit. Een pagina die bij het openen meteen crasht is niet subtiel —
// maar je ziet het niet als je alleen naar de letters kijkt.
//
// Dit is de vijfde vorm van 'de test raakte iets aan wat lijkt op het onderwerp'
// die deze week bovenkwam. De vorige vier staan in docs/opvolging-module.md.
//
// Daarom: het echte script uit het echte bestand, in een vm met een nagebootste
// browser. Wat hier draait is precies wat Chrome draait.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGINA = readFileSync(join(ROOT, 'modules/klanten-v2/rapport-print.html'), 'utf8');

/** Het script uit de pagina, zoals de browser het uitvoert. */
function scriptUit(html) {
  // Het laatste <script>-blok zonder src is het paginascript.
  const blokken = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blokken.length >= 1, 'de pagina hoort een inline script te hebben');
  return blokken[blokken.length - 1][1];
}

/** Een minimale nagebootste browser waarin het script kan draaien. */
function maakBrowser({ antwoord, status = 200 } = {}) {
  const el = { innerHTML: '' };
  const gebeurd = { geprint: 0, fouten: [] };

  const window = {
    AuthShared: {
      requireAuth: async () => ({ id: 'u1', role: 'manager' }),
      getAccessToken: async () => 'test-token',
    },
    print() { gebeurd.geprint += 1; },
    location: { search: '?van=2026-09-07&tot=2026-09-07' },
  };
  window.window = window;
  window._authSharedReady = Promise.resolve();

  const ctx = createContext({
    window,
    document: { getElementById: (id) => (id === 'blad' ? el : null) },
    location: window.location,
    URLSearchParams,
    fetch: async () => ({ ok: status < 400, status, text: async () => JSON.stringify(antwoord) }),
    // requestAnimationFrame draait hier meteen door: we willen weten óf er
    // geprint wordt, niet wanneer.
    requestAnimationFrame: (fn) => { fn(); return 1; },
    console: { error: (...a) => gebeurd.fouten.push(a.join(' ')), warn() {}, log() {}, debug() {} },
    Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object, Promise, RegExp, Error,
    encodeURIComponent, isNaN, parseInt, parseFloat,
  });
  return { ctx, el, gebeurd, window };
}

/** Een antwoord dat elk veld draagt dat de pagina leest. */
const ANTWOORD = {
  periode: { van: '2026-09-07', tot: '2026-09-07', dagen: 1, vandaag: '2026-09-07',
             bevat_verleden: false, bevat_vandaag: true },
  drempels: { spraak_voor_uur: 9, nabel_van_uur: 12, nabel_tot_uur: 13,
              archief_min_dagen: 3, archief_min_wa: 1, gesprek_min_sec: 10 },
  aandacht: [
    { soort: 'niet_behandeld', ernst: 'nalatigheid', label: 'NIET BEHANDELD',
      naam: 'Jan Jansen', tekst: 'Jan kreeg vandaag nog niets.', uitleg: null },
    { soort: 'blinde_vlek', ernst: 'blinde_vlek', label: 'BLINDE VLEK',
      naam: null, tekst: 'De dag van vandaag loopt nog.', uitleg: 'Stand van dit moment.' },
  ],
  blinde_vlekken: [],
  dekking: {
    openstaand_bekend: true,
    openstaand: [{ taak_id: 't1', naam: 'Jan Jansen', bel: 2, wa: 1, behandeld: true },
                 { taak_id: 't2', naam: 'Piet', bel: 0, wa: 0, behandeld: false }],
    onbehandeld: [{ taak_id: 't2', naam: 'Piet', bel: 0, wa: 0, behandeld: false }],
    behandeld: [{ taak_id: 't1', naam: 'Jan Jansen', bel: 2, wa: 1, bel_dagen: 2,
                  laatste: '2026-09-07T08:30:00Z' }],
  },
  vensters: {
    spraak: { totaal: 3, op_tijd: 2, te_laat: 1, niet_gedaan: 0, niet_nodig: 0 },
    nabel : { totaal: 3, op_tijd: 1, te_laat: 0, niet_gedaan: 2, niet_nodig: 1 },
    rijen: [], zonder_taak: [{ appointment_id: 'a9', naam: 'Los', dag: '2026-09-07', tijd: '14:00' }],
  },
  zoomcalls: [
    { appointment_id: 'a1', naam: 'Shudino Andrade', dag: '2026-09-07', tijd: '17:00',
      staat: 'gepland', status_ruw: 'scheduled', uitkomst: null, uitkomst_op: null,
      vastgelegd: false, reden_leeg: 'Deze call moet nog plaatsvinden.',
      annulering_reden: null, notitie: null, persoon: 'e:s@x.nl' },
    { appointment_id: 'a2', naam: 'jb aanbied', dag: '2026-09-07', tijd: '07:30',
      staat: 'geannuleerd', status_ruw: 'cancelled', uitkomst: null, uitkomst_op: null,
      vastgelegd: false, reden_leeg: 'Deze afspraak is geannuleerd.',
      annulering_reden: 'geen interesse meer', notitie: null, persoon: 'e:jb@x.nl' },
  ],
  archief: [{ taak_id: 't9', naam: 'Weg', gearchiveerd_at: '2026-09-07T10:00:00Z',
              dag: '2026-09-07', archief_reden: 'geen reactie', reden_code: null,
              bel_totaal: 1, bel_dagen: 1, wa_totaal: 0, duur_bekend: true,
              moeite_over: 'levensloop', moeite: { staat: 'te_weinig', reden: null } }],
  volume: {
    bel: { uit: 9, seconden: 133, niet_opgenomen: 3, zonder_duur: 0, gesproken: 5, te_kort: 1 },
    wa: { uit: 4, in: 2 }, spraak: { uit: 1, in: 0 }, rijen: [],
  },
};

/** Draai de pagina en wacht tot de async IIFE klaar is. */
async function draai(opties) {
  const b = maakBrowser(opties);
  runInContext(scriptUit(PAGINA), b.ctx, { filename: 'rapport-print.html' });
  // De IIFE is async; twee macrotask-ticks zijn ruim genoeg voor de twee awaits.
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  return b;
}

// ═══════════════════════════════════════════════════════════════════════════
// DE CRASH ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('de pagina draait van boven naar beneden zonder ReferenceError', async () => {
  // Dit is de test die er had moeten zijn. Met de oude vololgorde faalt hij op
  // exact de fout uit productie.
  const b = await draai({ antwoord: ANTWOORD });
  const fouten = b.gebeurd.fouten.join(' ');
  assert.doesNotMatch(fouten, /ReferenceError/, 'de pagina crasht: ' + fouten);
  assert.doesNotMatch(fouten, /before initialization/);
});

test('de pagina blijft niet op "wordt opgehaald" staan', async () => {
  // Het zichtbare symptoom. Blijft deze zin staan, dan is er iets misgegaan
  // ná het ophalen en heeft de gebruiker daar niets over te horen gekregen.
  const b = await draai({ antwoord: ANTWOORD });
  assert.doesNotMatch(b.el.innerHTML, /Rapport wordt opgehaald/);
  assert.ok(b.el.innerHTML.length > 2000, 'er hoort een heel rapport te staan');
});

test('het rapport draagt de gegevens uit het antwoord', async () => {
  const b = await draai({ antwoord: ANTWOORD });
  const h = b.el.innerHTML;
  assert.match(h, /Dagrapport/);
  assert.match(h, /7 september 2026/, 'nlDatum hoort te werken — die was de crash');
  assert.match(h, /Jan Jansen/);
  assert.match(h, /NIET BEHANDELD/);
  assert.match(h, /2:13/, 'gesprekstijd als m:ss uit 133 seconden');
  assert.match(h, /10 seconden/, 'de meetregel met de drempel uit het endpoint');
});

test('er wordt geprint als het rapport staat', async () => {
  const b = await draai({ antwoord: ANTWOORD });
  assert.equal(b.gebeurd.geprint, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN UITZONDERING WORDT GETOOND, NIET GESLIKT
// ═══════════════════════════════════════════════════════════════════════════

test('een fout tijdens het opmaken levert een zichtbare melding op', async () => {
  // Antwoord zonder `periode`: bouw() struikelt daarop. De gebruiker hoort dat
  // te zien in plaats van naar een laadtekst te blijven kijken.
  const b = await draai({ antwoord: { drempels: {}, volume: {} } });
  assert.match(b.el.innerHTML, /kon niet opgemaakt worden/i);
  assert.doesNotMatch(b.el.innerHTML, /Rapport wordt opgehaald/);
});

test('bij een fout wordt er NIET geprint', async () => {
  // Een lege printdialoog boven een mislukt rapport is erger dan geen dialoog:
  // dan bewaar je een leeg papier als PDF.
  const b = await draai({ antwoord: { drempels: {}, volume: {} } });
  assert.equal(b.gebeurd.geprint, 0);
});

test('de melding draagt de tekst van de fout', async () => {
  // Zonder de echte tekst is er geen tweede weg om te achterhalen wat er
  // misging — dit scherm heeft geen logboek.
  const b = await draai({ antwoord: { drempels: {}, volume: {} } });
  assert.match(b.el.innerHTML, /(undefined|null|Cannot read)/i);
});

test('een 403 wordt gemeld en niet als leeg rapport afgedrukt', async () => {
  const b = await draai({ antwoord: { error: 'Geen rechten (opvolging.rapport.view)' }, status: 403 });
  assert.match(b.el.innerHTML, /Geen rechten/);
  assert.equal(b.gebeurd.geprint, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VOLGORDE DIE DE CRASH VEROORZAAKTE
// ═══════════════════════════════════════════════════════════════════════════

test('alles wat bouw() gebruikt staat boven de plek waar bouw() wordt aangeroepen', () => {
  // Een function declaration wordt gehesen, een const-pijlfunctie niet. Deze
  // controle vangt de fout ook als iemand later iets terugverplaatst.
  const script = scriptUit(PAGINA);
  const aanroep = script.indexOf('toon(bouw(data))');
  assert.ok(aanroep > 0);
  for (const naam of ['nlDatum', 'mmss', 'BOL_VOOR']) {
    const declaratie = script.indexOf('const ' + naam);
    assert.ok(declaratie > 0, naam + ' hoort te bestaan');
    assert.ok(declaratie < aanroep,
      'const ' + naam + ' staat ná de aanroep van bouw() — dat is de temporal dead zone');
  }
});
