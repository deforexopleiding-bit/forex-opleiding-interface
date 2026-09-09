// tests/opvolging-rapport-dagtoewijzing.test.js
//
// HET RAPPORT WORDT HIER ECHT GEBOUWD.
//
// DIT IS DE VAL DIE ONS AL EEN KEER HEEFT GEPAKT. PR #1504 raakte precies dit
// stuk aan, de testsuite stond groen, en het endpoint gaf 500 op elke dag —
// omdat geen enkele test bouwRapport ooit aanriep. Een test die de brontekst
// leest ziet een tijdelijke dode zone niet, een verkeerde kolomnaam niet, en
// een 42703 die de hele query meeneemt al helemaal niet.
//
// Daarom draait alles hieronder de ECHTE bouwRapport() tegen een nagebootste
// databank. De stub bootst 42703 apart na voor `is_test` en voor
// `eerst_gepland_op`, want dat is de fout die het rapport moet OVERLEVEN met
// een blinde vlek in plaats van eraan te bezwijken.
//
// De twee gaten die Maxim op het draaiende endpoint mat:
//   1. het rapport over 8 september telde de drie proefrijen mee (zeven
//      zoomcalls, terwijl het scherm er vier toonde);
//   2. Jeroen Dorrestein (9 sep 15:00 → 18 sep) en Abdel Ben (9 sep 16:30 →
//      21 sep) stonden wél op het scherm van 9 september en niet in het
//      rapport van diezelfde dag.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── DE NAGEBOOTSTE DATABANK ────────────────────────────────────────────────
// Zo klein mogelijk, maar wel de hele keten: elke methode die bouwRapport
// gebruikt, en een awaitable eind. Zou hier iets ontbreken, dan valt de test om
// met een duidelijke fout in plaats van stil iets anders te meten.

// EEN mock voor het hele bestand, met een omzetbare inhoud. node:test staat
// maar één mock per module toe, en een tweede aanroep faalt met 'already
// mocked' — dus zetten we de rijen om in plaats van opnieuw te mocken.
const huidig = { rijen: {}, ontbrekendeKolommen: [] };

// HET TIJDVENSTER WORDT ECHT TOEGEPAST. Zonder dat is de stub een zeef die
// alles doorlaat, en dan bewijst geen enkele test dat de query het venster
// verbreedt naar eerst_gepland_op — een sabotage die de verbreding weghaalde
// gaf hier eerst nul rood. Een harnas dat de vraag niet stelt, beantwoordt hem
// ook niet.
const binnen = (rij, filters, or) => {
  const perKolom = (kolom, van, tot) => {
    const v = rij[kolom];
    if (!v) return false;
    const ms = Date.parse(v);
    return Number.isFinite(ms) && (!van || ms >= Date.parse(van)) && (!tot || ms < Date.parse(tot));
  };
  if (or) {
    // 'and(a.gte.X,a.lt.Y),and(b.gte.X,b.lt.Y)' — waar staat, geldt.
    const takken = [...String(or).matchAll(/and\(([a-z_]+)\.gte\.([^,]+),\1\.lt\.([^)]+)\)/g)];
    if (takken.length) return takken.some(([, kolom, van, tot]) => perKolom(kolom, van, tot));
  }
  return filters.every(({ soort, kolom, waarde }) =>
    soort === 'gte' ? perKolom(kolom, waarde, null) : perKolom(kolom, null, waarde));
};

const db = {
  from(tabel) {
    const staat = { tabel, kolommen: '', filters: [] };
    const uitkomst = async () => {
      // 42703 komt terug voor de HELE query zodra hij een ontbrekende kolom
      // noemt — ook via een or(). Precies zoals Postgres het doet, en precies
      // de fout die het rapport moet OVERLEVEN.
      const genoemd = staat.kolommen + ' ' + (staat.or || '');
      const mist = huidig.ontbrekendeKolommen
        .find((k) => new RegExp('\\b' + k + '\\b').test(genoemd));
      if (mist) return { data: null, error: { code: '42703', message: `column "${mist}" does not exist` } };
      const uit = (huidig.rijen[tabel] || [])
        .filter((r) => binnen(r, staat.filters, staat.or))
        .map((r) => {
          const kopie = { ...r };
          for (const k of huidig.ontbrekendeKolommen) delete kopie[k];
          return kopie;
        });
      return { data: uit, error: null };
    };
    const q = {
      select(k) { staat.kolommen = String(k); return q; },
      gte(kolom, waarde) { staat.filters.push({ soort: 'gte', kolom, waarde }); return q; },
      lt(kolom, waarde) { staat.filters.push({ soort: 'lt', kolom, waarde }); return q; },
      lte() { return q; }, gt() { return q; },
      eq() { return q; }, in() { return q; }, not() { return q; }, limit() { return q; },
      or(v) { staat.or = String(v); return q; },
      order() { return q; },
      then(res, rej) { return uitkomst().then(res, rej); },
    };
    return q;
  },
};

mock.module('../api/supabase.js', {
  namedExports: {
    supabase: db, supabaseAdmin: db,
    createUserClient: () => db,
    verifyAdmin: async () => ({ ok: true }),
    checkCronAuth: () => ({ ok: true }),
  },
});

const { bouwRapport } = await import('../api/opvolging-rapport.js');

// ── DE ECHTE RIJEN VAN 8 EN 9 SEPTEMBER ────────────────────────────────────

const app = (id, naam, iso, extra = {}) => ({
  id, lead_name: naam, lead_phone: null, lead_email: null,
  scheduled_at: iso, eerst_gepland_op: iso, duration_minutes: 30,
  status: 'scheduled', parent_appointment_id: null, annulering_reden: null,
  snelle_notitie: null, uitkomst: null, uitkomst_op: null, is_test: false,
  ...extra,
});

// 8 september: vier echte afspraken en de drie proefrijen.
const ACHT = [
  app('m', 'Martin Van Pijkeren',    '2026-09-08T08:00:00Z', { status: 'completed', uitkomst: 'sale' }),
  app('y', 'yeivi medinw',           '2026-09-08T13:00:00Z'),
  app('me', 'Mehran Jahani',         '2026-09-08T16:00:00Z', { status: 'no_show' }),
  app('s', 'Sebastian Kolodziejski', '2026-09-08T18:30:00Z', { status: 'no_show' }),
  app('t1', 'jeffrey-test test-jeffrey', '2026-09-08T08:30:00Z', { is_test: true }),
  app('t2', 'jef testo',                 '2026-09-08T12:00:00Z', { is_test: true }),
  app('t3', 'jef testo',                 '2026-09-08T18:30:00Z', { is_test: true }),
];

// 9 september: twee afspraken die in DEZELFDE rij zijn verzet. scheduled_at
// staat op de nieuwe dag, eerst_gepland_op houdt de 9e vast.
const JEROEN = app('j', 'Jeroen Dorrestein', '2026-09-18T13:00:00Z',
  { eerst_gepland_op: '2026-09-09T13:00:00Z' });
const ABDEL = app('ab', 'Abdel Ben', '2026-09-21T17:00:00Z',
  { eerst_gepland_op: '2026-09-09T14:30:00Z' });

/** bouwRapport() draaien met een nagebootste databank. */
async function rapportVan(dag, afspraken, ontbrekendeKolommen = []) {
  huidig.rijen = { follow_up_appointments: afspraken, opvolging_pogingen: [], opvolging_taken: [] };
  huidig.ontbrekendeKolommen = ontbrekendeKolommen;
  const vanMs = Date.parse(dag + 'T00:00:00Z');
  return bouwRapport({
    supabase: db, van: dag, tot: dag, dagen: [dag], vandaag: dag,
    vanIso: new Date(vanMs - 2 * 3600 * 1000).toISOString(),
    totIso: new Date(vanMs + 22 * 3600 * 1000).toISOString(),
  });
}

const namen = (r) => r.zoomcalls.map((c) => c.naam);

// ═══════════════════════════════════════════════════════════════════════════
// GAT 1 · PROEFRIJEN TELDEN MEE
// ═══════════════════════════════════════════════════════════════════════════

test('het rapport over 8 september telt vier zoomcalls, niet zeven', async () => {
  const r = await rapportVan('2026-09-08', ACHT);
  assert.deepEqual(namen(r).sort(),
    ['Martin Van Pijkeren', 'Mehran Jahani', 'Sebastian Kolodziejski', 'yeivi medinw']);
});

test('geen enkele proefrij haalt het rapport', async () => {
  const r = await rapportVan('2026-09-08', ACHT);
  assert.equal(namen(r).filter((n) => /test/i.test(n)).length, 0);
});

test('er wordt op de kolom gefilterd, niet op de naam', async () => {
  // De eerste echte klant die Testerink heet hoort gewoon in het rapport.
  const r = await rapportVan('2026-09-08',
    [app('k', 'Tessa Testerink', '2026-09-08T08:00:00Z')]);
  assert.deepEqual(namen(r), ['Tessa Testerink']);
});

// ═══════════════════════════════════════════════════════════════════════════
// GAT 2 · EEN VERZETTE AFSPRAAK VERDWEEN VAN ZIJN DAG
// ═══════════════════════════════════════════════════════════════════════════

test('Jeroen en Abdel staan in het rapport van 9 september', async () => {
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL]);
  assert.deepEqual(namen(r).sort(), ['Abdel Ben', 'Jeroen Dorrestein']);
});

test('en ze staan er op de dag en het tijdstip waarop ze STONDEN', async () => {
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL]);
  const j = r.zoomcalls.find((c) => c.naam === 'Jeroen Dorrestein');
  const a = r.zoomcalls.find((c) => c.naam === 'Abdel Ben');
  assert.equal(j.dag, '2026-09-09');
  assert.equal(j.tijd, '15:00');
  assert.equal(a.dag, '2026-09-09');
  assert.equal(a.tijd, '16:30');
});

test('met de bestemming erbij, uit onze eigen kolom', async () => {
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL]);
  const j = r.zoomcalls.find((c) => c.naam === 'Jeroen Dorrestein');
  assert.deepEqual(j.verzet_naar, { dag: '2026-09-18', tijd: '15:00' });
  assert.equal(j.verzet_label, 'verzet naar 18 september om 15:00');
  assert.equal(r.zoomcalls.find((c) => c.naam === 'Abdel Ben').verzet_label,
    'verzet naar 21 september om 19:00');
});

test('een verzette call krijgt geen verwijt over een ontbrekende uitkomst', async () => {
  // Zijn status blijft 'scheduled' bij een verzetting in dezelfde rij; zonder
  // het agendafeit zou hij als 'te beoordelen' langskomen en dus als 'zonder
  // uitkomst' tellen. Dat is een verwijt over een call die die dag niet was.
  const r = await rapportVan('2026-09-09', [JEROEN]);
  const j = r.zoomcalls[0];
  assert.equal(j.staat, 'verplaatst');
  assert.match(j.reden_leeg, /verzet naar 18 september/);
});

test('op zijn NIEUWE dag telt hij gewoon mee als afspraak', async () => {
  // Anders is één gat gedicht en het volgende geslagen: het rapport over
  // 18 september zou een call missen die daar echt heeft plaatsgevonden.
  const r = await rapportVan('2026-09-18', [JEROEN]);
  assert.deepEqual(namen(r), ['Jeroen Dorrestein']);
  assert.equal(r.zoomcalls[0].dag, '2026-09-18');
  assert.notEqual(r.zoomcalls[0].staat, 'verplaatst');
  assert.equal(r.zoomcalls[0].verzet_label, null);
});

test('en over een periode die BEIDE dagen dekt telt hij precies een keer', async () => {
  huidig.rijen = { follow_up_appointments: [JEROEN], opvolging_pogingen: [], opvolging_taken: [] };
  huidig.ontbrekendeKolommen = [];
  const dagen = [];
  for (let d = 9; d <= 21; d += 1) dagen.push('2026-09-' + String(d).padStart(2, '0'));
  const r = await bouwRapport({
    supabase: db, van: dagen[0], tot: dagen[dagen.length - 1], dagen, vandaag: '2026-09-09',
    vanIso: '2026-09-08T22:00:00Z', totIso: '2026-09-21T22:00:00Z',
  });
  assert.equal(r.zoomcalls.length, 1, 'dubbel tellen maakt elk cijfer eronder verdacht');
  assert.equal(r.zoomcalls[0].dag, '2026-09-09', 'hij hoort op de dag waarop hij stond');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VAL VAN #1504 · EEN ONTBREKENDE KOLOM MAG HET RAPPORT NIET SLOPEN
// ═══════════════════════════════════════════════════════════════════════════

test('zonder is_test werkt het rapport, met een blinde vlek', async () => {
  const r = await rapportVan('2026-09-08', ACHT, ['is_test']);
  assert.equal(r.zoomcalls.length, 7, 'zonder de kolom is een proefrij niet te herkennen');
  const vlek = r.blinde_vlekken.find((b) => /is_test/.test(b.waarom || ''));
  assert.ok(vlek, 'het rapport hoort te MELDEN dat proefrijen meetellen');
  assert.match(vlek.wat, /[Pp]roefafspraken/);
});

test('zonder eerst_gepland_op werkt het rapport, met een blinde vlek', async () => {
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL], ['eerst_gepland_op']);
  // De rijen zijn dan niet te vinden voor 9 september — dat is de beperking,
  // en die hoort er te STAAN in plaats van stil te blijven.
  const vlek = r.blinde_vlekken.find((b) => /eerst_gepland_op/.test(b.waarom || ''));
  assert.ok(vlek, 'het rapport hoort te melden dat verzette afspraken ontbreken');
});

test('zonder uitkomst werkt het rapport, met een blinde vlek', async () => {
  const r = await rapportVan('2026-09-08', ACHT, ['uitkomst', 'uitkomst_op']);
  assert.equal(r.zoomcalls.length, 4);
  assert.ok(r.blinde_vlekken.find((b) => /uitkomst/.test(b.waarom || '')));
});

test('het ontbreken van EEN kolom zet de andere niet uit', async () => {
  // 42703 zegt niet WELKE kolom ontbreekt. Zou de terugval op de foutcode
  // alleen gaan, dan verdwijnen de verzette afspraken zodra `uitkomst`
  // ontbreekt — om een reden die er niets mee te maken heeft.
  const r = await rapportVan('2026-09-09', [JEROEN], ['uitkomst', 'uitkomst_op']);
  assert.deepEqual(namen(r), ['Jeroen Dorrestein'], 'de verzette afspraak hoort er nog te zijn');
  assert.equal(r.zoomcalls[0].dag, '2026-09-09');
});

test('alle drie tegelijk weg: het rapport valt nog steeds niet om', async () => {
  const r = await rapportVan('2026-09-08', ACHT, ['uitkomst', 'uitkomst_op', 'eerst_gepland_op', 'is_test']);
  assert.ok(Array.isArray(r.zoomcalls));
  assert.ok(r.blinde_vlekken.length >= 3, 'elke ontbrekende kolom hoort een eigen melding te geven');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GRENS · GEEN OORDEEL UIT EEN STATUS
// ═══════════════════════════════════════════════════════════════════════════

test('de bestemming komt uit eerst_gepland_op, niet uit een status', async () => {
  // Een rij die op 'wacht_op_reschedule' staat maar niet daadwerkelijk is
  // verzet, krijgt geen verzonnen bestemming.
  const r = await rapportVan('2026-09-09',
    [app('w', 'Zonder bestemming', '2026-09-09T13:00:00Z', { status: 'wacht_op_reschedule' })]);
  assert.equal(r.zoomcalls[0].verzet_naar, null);
  assert.equal(r.zoomcalls[0].verzet_label, null);
});

test('een uitkomst komt alleen uit `uitkomst`, nooit uit `status`', async () => {
  const r = await rapportVan('2026-09-08', ACHT);
  const mehran = r.zoomcalls.find((c) => c.naam === 'Mehran Jahani');
  assert.equal(mehran.uitkomst, null, 'no_show is een status, geen vastgelegde uitkomst');
  assert.equal(mehran.vastgelegd, false);
  const martin = r.zoomcalls.find((c) => c.naam === 'Martin Van Pijkeren');
  assert.equal(martin.uitkomst, 'sale');
  assert.equal(martin.vastgelegd, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GEZONDHEIDSCONTROLE REKENT MET DEZELFDE bouwRapport()
// ═══════════════════════════════════════════════════════════════════════════
// controleerOptelling en controleerDubbels krijgen het rapport dat hierboven
// gebouwd wordt. Verschuift een telling, dan verschuift hun oordeel mee — en
// een bewaker die afgaat terwijl er niets aan de hand is, is binnen een week
// een bewaker waar niemand meer op reageert.

test('controleerOptelling blijft kloppen op het nieuwe rapport', async () => {
  const { controleerOptelling, OK } = await import('../api/_lib/opvolging-gezondheid.js');
  const r = await rapportVan('2026-09-08', ACHT);
  const u = controleerOptelling({ rapport: r });
  assert.equal(u.staat, OK, u.uitleg);
});

test('en ook wanneer er verzette afspraken in de dag zitten', async () => {
  const { controleerOptelling, OK } = await import('../api/_lib/opvolging-gezondheid.js');
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL]);
  assert.equal(controleerOptelling({ rapport: r }).staat, OK);
});

test('controleerDubbels ziet een verzette call niet aan voor een dubbele', async () => {
  // Beide rijen van dezelfde persoon op dezelfde dag zou een dubbele zijn.
  // Een verzette afspraak is er één, op één dag — dat mag geen vals alarm geven.
  const { controleerDubbels, OK } = await import('../api/_lib/opvolging-gezondheid.js');
  const r = await rapportVan('2026-09-09', [JEROEN, ABDEL]);
  assert.equal(controleerDubbels({ rapport: r }).staat, OK);
});

test('de bel-emmers staan los van de zoomcalls, dus dit filter raakt ze niet', async () => {
  // controleerOptelling telt `volume.bel`, en dat komt uit opvolging_pogingen.
  // Proefafspraken en dagtoewijzing zitten in follow_up_appointments en raken
  // die emmers niet. Deze test legt dat vast, zodat het opvalt als dat verandert.
  const zonder = await rapportVan('2026-09-08', ACHT);
  const met    = await rapportVan('2026-09-08', ACHT, ['is_test']);
  assert.deepEqual(zonder.volume.bel, met.volume.bel);
  assert.notEqual(zonder.zoomcalls.length, met.zoomcalls.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SCHERM EN DE PRINT, UITGEVOERD
// ═══════════════════════════════════════════════════════════════════════════
// De server kan de bestemming perfect meesturen terwijl geen enkel scherm hem
// toont. Deze twee knippen de ECHTE uitdrukking en voeren hem uit.

const { readFileSync } = await import('node:fs');
const { createContext, runInContext } = await import('node:vm');

const voerUit = (bron, ctx, naam) =>
  runInContext('const uit = ' + bron + ';\nuit;',
    createContext({ esc: (x) => String(x == null ? '' : x), ...ctx }), { filename: naam });

test('het scherm toont de bestemming bij een verzette call', () => {
  const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  const start = VIEW.indexOf("(c.staat === 'verplaatst'\n");
  assert.ok(start > 0, 'de verzet-uitdrukking is niet gevonden in de view');
  const eind = VIEW.indexOf("' : '') +", start);
  assert.ok(eind > start, 'het einde van de uitdrukking is niet gevonden');
  const bron = VIEW.slice(start, eind + "' : '')".length);

  const met = voerUit(bron, { c: { staat: 'verplaatst', verzet_label: 'verzet naar 18 september om 15:00' } }, 'view');
  assert.match(met, /verzet naar 18 september om 15:00/);

  // Zonder bestemming blijft het bij 'verzet' — dan weten we het niet.
  assert.match(voerUit(bron, { c: { staat: 'verplaatst', verzet_label: null } }, 'view'), />verzet</);
  // En een gewone call krijgt niets.
  assert.equal(voerUit(bron, { c: { staat: 'te_beoordelen' } }, 'view'), '');
});

test('de print toont dezelfde bestemming', () => {
  const PRINT = readFileSync('modules/klanten-v2/rapport-print.html', 'utf8');
  const start = PRINT.indexOf("c.staat === 'verplaatst' ?");
  assert.ok(start > 0, 'de verzet-uitdrukking is niet gevonden in de print');
  const eind = PRINT.indexOf('\n', start);
  const bron = PRINT.slice(start + "c.staat === 'verplaatst' ? ".length, eind).trim();
  assert.equal(voerUit(bron, { c: { verzet_label: 'verzet naar 21 september om 19:00' } }, 'print'),
    'verzet naar 21 september om 19:00');
  assert.equal(voerUit(bron, { c: { verzet_label: null } }, 'print'), 'verzet');
});
