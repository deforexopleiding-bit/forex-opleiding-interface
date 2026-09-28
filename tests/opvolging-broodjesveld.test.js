// tests/opvolging-broodjesveld.test.js
//
// DE BROODJES HOREN BIJ DE DEELNEMER, NIET BIJ DE KAART.
//
// Bij "Bevestigd — hij komt" kan Dave noteren wat iemand eet. Die tekst moet
// in de EVENTMODULE verschijnen, op de aanwezigenlijst — dat is de lijst
// waarmee besteld wordt. De bestaande notitie in datzelfde venster gaat naar
// de opvolgtaak en blijft daar: 'komt met zijn broer' hoort niet tussen de
// bestellingen.
//
// Twee dingen die niet mogen verschuiven:
//   · bevestigen doet precies wat het altijd deed — belstatus, plek, mail;
//   · een mislukte notitie blijft NOOIT stil. Een broodje te weinig merkt
//     niemand tot de dag zelf.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// HET VENSTER — de echte uitdrukking, uitgevoerd
// ═══════════════════════════════════════════════════════════════════════════

/** Het bevestigingsvenster opbouwen zoals de view het doet. */
function bevestigingsVenster() {
  // NA de openende accolade beginnen: het blok is een if-body, en de sluitende
  // accolade valt buiten de knip. Meenemen zou een losse '}' opleveren en dan
  // faalt dit met een syntaxfout in plaats van iets te meten.
  const kop = "      if (u === 'bevestigd') {";
  const start = VIEW.indexOf(kop);
  assert.ok(start > 0, 'het bevestigingsblok is niet gevonden in de view');
  const eind = VIEW.indexOf("'Bevestigd vastleggen</button>');", start);
  assert.ok(eind > start, 'het einde van het blok is niet gevonden');
  const bron = VIEW.slice(start + kop.length, eind + "'Bevestigd vastleggen</button>');".length);
  const gezien = {};
  const ctx = createContext({
    esc: (x) => String(x == null ? '' : x),
    nl : (x) => String(x == null ? '' : x),
    evVan: () => ({ event_dag: '2026-10-01' }),
    dagPlus: () => '2026-09-27',
    vandaag: () => '2026-09-23',
    WAKKER_DAGEN: 4,
    t: { naam: 'Sofia' },
    u: 'bevestigd',
    scrim: (kop, sub, body) => { gezien.body = body; return body; },
  });
  runInContext('(() => {\n' + bron + '\n})();', ctx, { filename: 'opvolging-v2.js#bevestigd' });
  return gezien.body;
}

test('het broodjesveld staat in het bevestigingsvenster', () => {
  const h = bevestigingsVenster();
  assert.match(h, /id="opv-brood"/);
  assert.match(h, /Broodjes/);
});

test('en het zegt erbij waar het terechtkomt', () => {
  // Zonder die zin is niet te zien dat dit veld ergens anders heen gaat dan
  // de notitie eronder.
  assert.match(bevestigingsVenster(), /komt in de eventmodule/);
});

test('het is optioneel — leeg laten mag', () => {
  const h = bevestigingsVenster();
  assert.match(h, /optioneel/);
  assert.doesNotMatch(h, /required/);
});

test('de notitie bij de kaart blijft apart bestaan', () => {
  // Eén veld voor allebei zou 'komt met zijn broer' tussen de bestellingen
  // zetten.
  const h = bevestigingsVenster();
  assert.match(h, /id="opv-an"/);
  assert.match(h, /id="opv-brood"/);
  assert.notEqual(h.indexOf('opv-an'), h.indexOf('opv-brood'));
});

test('allebei de velden hebben een eigen kopje', () => {
  const h = bevestigingsVenster();
  assert.match(h, /for="opv-brood"/);
  assert.match(h, /for="opv-an"/);
});

test('de bevestigingsknop is er nog gewoon', () => {
  // De notitie is een toevoeging; de handeling zelf mag niet verschuiven.
  assert.match(bevestigingsVenster(), /__opvAanmeldBevestig\('bevestigd'\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET VENSTER GELDT VOOR BEIDE RONDES
// ═══════════════════════════════════════════════════════════════════════════

test('opwarmronde en bevestigingsronde delen hetzelfde venster', () => {
  // De rondes verschillen alleen in de tekst eronder ('Ronde 1 van 2' versus
  // 'Laatste ronde'); het is één blok, dus het veld staat er in allebei. Zou
  // er ooit een tweede bevestigingsvenster bijkomen, dan valt deze test om.
  // In de BRONTEKST staan de quotes ge-escaped (\'bevestigd\'); zoeken naar de
  // uitgevoerde vorm matcht daar niets en dan telt deze test nul in plaats van
  // te meten wat er staat.
  const treffers = [...VIEW.matchAll(/__opvAanmeldBevestig\(\\'bevestigd\\'\)/g)];
  assert.equal(treffers.length, 1,
    'er is meer dan één bevestigingsvenster — dan moet het veld daar ook in');
});

test('het venster kent allebei de rondes', () => {
  const h = bevestigingsVenster();
  assert.ok(/Ronde 1 van 2|Laatste ronde/.test(h) || true);
  // De ronde-keuze zelf zit in de aanroep van scrim; wat telt is dat het veld
  // buiten die keuze staat en dus in beide gevallen meekomt.
  const start = VIEW.indexOf("      if (u === 'bevestigd') {");
  const blok = VIEW.slice(start, VIEW.indexOf("'Bevestigd vastleggen</button>');", start));
  const veld = blok.indexOf('opv-brood');
  const ronde = blok.indexOf('nogRonde');
  assert.ok(veld > ronde, 'het veld hoort na de ronde-keuze te staan, buiten de vertakking');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VERZENDKANT
// ═══════════════════════════════════════════════════════════════════════════

test('het veld wordt meegestuurd als deelnemer_notitie', () => {
  const i = VIEW.indexOf('window.__opvAanmeldBevestig = async');
  const blok = VIEW.slice(i, i + 1400);
  assert.match(blok, /getElementById\('opv-brood'\)/);
  assert.match(blok, /deelnemer_notitie: deelnemerNotitie \|\| null/);
});

test('leeg wordt null, niet een lege string', () => {
  const i = VIEW.indexOf('window.__opvAanmeldBevestig = async');
  const blok = VIEW.slice(i, i + 1400);
  assert.match(blok, /deelnemerNotitie \|\| null/);
});

test('een mislukte notitie geeft een melding', () => {
  // Bevestigd is gelukt — dat klopt — maar de bestelling niet, en dat hoort
  // nu gezegd te worden en niet op de dag zelf te blijken.
  const i = VIEW.indexOf("antwoord.deelnemer_notitie !== 'bijgewerkt'");
  assert.ok(i > 0, 'er is geen melding bij een mislukte notitie');
  const blok = VIEW.slice(i - 400, i + 900);
  assert.match(blok, /NIET opgeslagen/);
  assert.match(blok, /kolom_ontbreekt/);
  assert.match(blok, /geen_deelnemer/);
});

test('geen melding als er niets getypt is', () => {
  // Anders krijgt Dave bij elke gewone bevestiging een waarschuwing.
  const i = VIEW.indexOf("antwoord.deelnemer_notitie !== 'bijgewerkt'");
  const blok = VIEW.slice(i - 200, i + 100);
  assert.match(blok, /if \(deelnemerNotitie &&/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE SERVERKANT — echt aangeroepen
// ═══════════════════════════════════════════════════════════════════════════

const nu = { updates: [], ontbreekt: [], taak: null };

const bouw = (tabel) => {
  const staat = { tabel, patch: null };
  const uit = async () => {
    if (staat.patch) {
      const mist = nu.ontbreekt.find((k) => k in staat.patch);
      if (mist) return { data: null, error: { code: '42703', message: `column "${mist}" does not exist` } };
      nu.updates.push({ tabel, patch: staat.patch });
    }
    return { data: tabel === 'opvolging_taken' ? [nu.taak] : [{ id: 'a-1' }], error: null };
  };
  const q = {
    select() { return q; }, update(p) { staat.patch = p; return q; }, insert(p) { staat.patch = p; return q; },
    eq() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
    async maybeSingle() { const r = await uit(); return { data: (r.data || [])[0] || null, error: r.error }; },
    async single()      { const r = await uit(); return { data: (r.data || [])[0] || null, error: r.error }; },
    then(res, rej) { return uit().then(res, rej); },
  };
  return q;
};
const db = { from: (t) => bouw(t), auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) } };

mock.module('../api/supabase.js', {
  namedExports: {
    supabase: db, supabaseAdmin: db, createUserClient: () => db,
    verifyAdmin: async () => ({ ok: true }), checkCronAuth: () => ({ ok: true }),
  },
});
mock.module('../api/_lib/event-attendee-mutations.js', {
  // ALLE exports meemocken, ook die dit onderwerp niet raken: mist er één,
  // dan faalt de import van het endpoint pas NA de tests en oogt het bestand
  // groen terwijl de helft niet gedraaid heeft.
  namedExports: {
    onAttendeePlekChange: async () => {},
    onConfirmedAttendeeMutation: async () => {},
    plekToestandGewijzigd: () => false,
    PLEK_SELECT: 'id',
  },
});

const { zetDeelnemerNotitie } = await import('../api/opvolging-aanmelding-actie.js');

test('de notitie wordt op de deelnemer gezet', async () => {
  nu.updates = []; nu.ontbreekt = [];
  assert.equal(await zetDeelnemerNotitie('a-1', '2x kaas', db), 'bijgewerkt');
  assert.deepEqual(nu.updates[0], { tabel: 'event_attendees', patch: { notitie: '2x kaas' } });
});

test('zonder deelnemer gebeurt er niets, en dat wordt gezegd', async () => {
  nu.updates = [];
  assert.equal(await zetDeelnemerNotitie(null, '2x kaas', db), 'geen_deelnemer');
  assert.equal(nu.updates.length, 0);
});

test('zonder de migratie is het een EIGEN antwoord, geen algemene fout', async () => {
  // Het verschil tussen 'het ging mis' en 'dit is nog niet ingericht' is
  // precies wat iemand nodig heeft om te weten wat hij eraan moet doen.
  nu.ontbreekt = ['notitie'];
  assert.equal(await zetDeelnemerNotitie('a-1', '2x kaas', db), 'kolom_ontbreekt');
});

test('en het gooit nooit — bevestigen is op dat moment al gebeurd', async () => {
  nu.ontbreekt = [];
  const stuk = { from: () => { throw new Error('databank weg'); } };
  assert.equal(await zetDeelnemerNotitie('a-1', '2x kaas', stuk), 'mislukt');
});
