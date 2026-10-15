// tests/iris-template-wensen.test.js
//
// De vier templates die Iris mist, indienen bij 360dialog vanuit het scherm.
//
// ── WAT DEZE TOETSEN ECHT MOETEN BEWAKEN ────────────────────────────────────
// Drie dingen kunnen hier stil misgaan, en alle drie merk je pas als een klant
// iets leest of juist niets krijgt:
//
//   1. Een TYPEFOUT in de tekst. Die wordt door Meta goedgekeurd en daarna
//      verstuurd. Dus houden we de teksten tegen docs/iris/template-wensen.md
//      aan — dat document is wat er is afgesproken.
//   2. Een DUBBELE template, als het indienen niet idempotent is. Dan staan er
//      twee met dezelfde naam en is niet te zeggen welke er weggaat.
//   3. Een template die er WEL is maar NIET werkt: goedgekeurd op de verkeerde
//      lijn, of in een categorie die Iris weigert, of zonder dat onze eigen rij
//      op APPROVED staat. Iris verstuurt namelijk op ónze status.
//
// En één die luidruchtig misgaat maar erger is: een sleutel in een antwoord of
// een logregel.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nepDb } from './vast/nep-db.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const SLEUTEL = 'test-sleutel-nooit-in-een-antwoord';
process.env.D360_API_KEY_KLANTNUMMER = SLEUTEL;
process.env.D360_PHONE_NUMBER_ID_KLANTNUMMER = '1399327383258229';

let db = nepDb({});
const proxy = { from: (t) => db.from(t), rpc: async () => ({ data: null, error: null }) };
mock.module('../api/supabase.js', { namedExports: {
  supabaseAdmin: proxy, supabase: proxy,
  createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }),
} });
let magHet = true;
mock.module('../api/_lib/requirePermission.js', { namedExports: {
  requirePermission: async () => magHet,
  requirePermissionFailOpen: async () => magHet,
} });

const W = await import('../api/_lib/iris/template-wensen.js');
const D = await import('../api/_lib/d360-templates.js');
const EP = await import('../api/iris-templates.js');
const T = await import('../api/_lib/iris/templates.js');

/* ── 1. De teksten, tegen het document ─────────────────────────────────────── */

/** Blokquotes uit het wensendocument, met de regelafbrekingen eruit. */
function blokquotesUitDoc() {
  const doc = lees('docs/iris/template-wensen.md');
  const uit = [];
  let bezig = null;
  for (const regel of doc.split('\n')) {
    if (regel.startsWith('> ')) {
      const stuk = regel.slice(2).trim();
      bezig = bezig === null ? stuk : bezig + ' ' + stuk;
      continue;
    }
    if (bezig !== null) { uit.push(bezig); bezig = null; }
  }
  if (bezig !== null) uit.push(bezig);
  return uit;
}

// Een tekstvergelijking is normaal een slechte toets (les 13). Hier niet: het
// document IS de afspraak, en de hele reden dat deze lijst in code staat is dat
// niemand hem meer hoeft over te typen. Wel genormaliseerd op witruimte — het
// document breekt regels af waar de template dat niet doet.
const normaal = (s) => String(s).replace(/\s+/g, ' ').trim();

test('de vier teksten staan letterlijk zo in docs/iris/template-wensen.md', () => {
  const uitDoc = blokquotesUitDoc().map(normaal);
  assert.equal(W.TEMPLATE_WENSEN.length, 4);
  for (const wens of W.TEMPLATE_WENSEN) {
    assert.ok(
      uitDoc.includes(normaal(wens.body_text)),
      `de tekst van ${wens.name} staat niet (meer) zo in het wensendocument:\n  code: ${normaal(wens.body_text)}`
    );
  }
});

test('elke {{N}} heeft een voorbeeldwaarde — zonder voorbeeld keurt Meta af', () => {
  for (const wens of W.TEMPLATE_WENSEN) {
    const v = EP.voorbeeldenCompleet(wens);
    assert.ok(v.ok, `${wens.name} mist een voorbeeld voor {{${v.ontbreekt.join('}}, {{')}}}`);
    assert.ok(v.nodig.length >= 1, `${wens.name} heeft geen variabelen — klopt dat?`);
    // Niet "voorbeeld": een nietszeggende sample vertraagt of kost een afkeuring.
    for (const n of v.nodig) assert.notEqual(String(wens.body_examples[n]).toLowerCase(), 'voorbeeld');
  }
});

test('alle vier UTILITY en nl — Iris weigert MARKETING, ook goedgekeurd', () => {
  for (const wens of W.TEMPLATE_WENSEN) {
    assert.equal(wens.category, 'UTILITY', wens.name);
    assert.equal(wens.language, 'nl', wens.name);
  }
  // Dezelfde eis, maar nu gemeten aan de kant die het weigert.
  const alsRij = W.TEMPLATE_WENSEN.map((w) => ({ ...w, status: 'APPROVED' }));
  assert.equal(T.bruikbaar(alsRij).length, 4, 'Iris zou deze vier niet bruikbaar vinden');
  assert.equal(T.bruikbaar(alsRij.map((r) => ({ ...r, category: 'MARKETING' }))).length, 0);
});

test('de namen zijn precies de namen die Iris in VOORKEUR zoekt', () => {
  const gezocht = new Set(Object.values(T.VOORKEUR).flat());
  for (const naam of W.WENS_NAMEN) {
    assert.ok(gezocht.has(naam), `Iris zoekt "${naam}" nergens — dan dient dit niets in dat ze gebruikt`);
  }
});

/* ── 2. De lijn ────────────────────────────────────────────────────────────── */

test('de lijn is het klantnummer, en dat is de lijn waarop Iris stuurt', async () => {
  assert.equal(W.WENS_NUMMER, 'klantnummer');
  const N = await import('../api/_lib/wa-nummers.js');
  const klant = N.nummerOpSleutel('klantnummer');
  const hoofd = N.nummerOpSleutel('hoofdnummer');
  // Niet "het staat zo in de code" maar: de modules van Iris horen hier.
  for (const m of ['finance', 'dunning', 'onboarding']) {
    assert.ok(klant.modules.includes(m), `klantnummer stuurt niet voor ${m}`);
    assert.ok(hoofd.uitgesloten_modules.includes(m), `hoofdnummer sluit ${m} niet uit`);
    assert.equal(N.nummerVoorModule(m).sleutel, 'klantnummer');
  }
});

test('de WABA-sleutel is die van de andere CRM-rijen, anders valt de template uit de lijst', () => {
  assert.equal(W.WENS_BUSINESS_ACCOUNT_ID, '990429800401598');
  const migratie = lees('docs/sql-migrations/2026-10-07-whatsapp-klantnummer-lijn.sql');
  assert.ok(migratie.includes("'990429800401598'"), 'de klantnummer-migratie wijst naar een andere WABA-sleutel');
});

/* ── 3. Het transport ──────────────────────────────────────────────────────── */

test('statusNaarIntern: onbekend wordt SUBMITTED, nooit APPROVED', () => {
  assert.equal(D.statusNaarIntern('approved'), 'APPROVED');
  assert.equal(D.statusNaarIntern('REJECTED'), 'REJECTED');
  assert.equal(D.statusNaarIntern('paused'), 'PAUSED');
  assert.equal(D.statusNaarIntern('pending'), 'SUBMITTED');
  assert.equal(D.statusNaarIntern(''), 'SUBMITTED');
  assert.equal(D.statusNaarIntern('iets_nieuws_van_meta'), 'SUBMITTED',
    'wie niet weet of een template goedgekeurd is, moet hem niet versturen');
});

test('sleutelVan: de taal telt, maar niet de hoofdletters', () => {
  assert.equal(D.sleutelVan('a', 'NL'), D.sleutelVan('a', 'nl'));
  assert.notEqual(D.sleutelVan('a', 'nl'), D.sleutelVan('a', 'en'));
});

test('bestaatAlFout herkent de vormen waarin "bestaat al" terugkomt', () => {
  assert.ok(D.bestaatAlFout({ json: { error: { message: 'Template already exists' } } }));
  assert.ok(D.bestaatAlFout({ json: { meta: { developer_message: 'duplicate template name' } } }));
  assert.ok(D.bestaatAlFout({ tekst: '{"code":2388024}' }));
  assert.ok(!D.bestaatAlFout({ json: { error: { message: 'Invalid parameter' } } }));
});

test('geen sleutel: de fout noemt de env-NAAM en nooit de waarde', async () => {
  const bewaard = process.env.D360_API_KEY_HOOFDNUMMER;
  delete process.env.D360_API_KEY_HOOFDNUMMER;
  try {
    await assert.rejects(() => D.d360('hoofdnummer', '/message_templates'), (e) => {
      assert.equal(e.code, 'GEEN_SLEUTEL');
      assert.match(e.message, /D360_API_KEY_HOOFDNUMMER/);
      assert.ok(!e.message.includes(SLEUTEL));
      return true;
    });
  } finally {
    if (bewaard !== undefined) process.env.D360_API_KEY_HOOFDNUMMER = bewaard;
  }
});

/* ── 4. Het eindpunt ───────────────────────────────────────────────────────── */

const echteFetch = globalThis.fetch;
function nepRes() {
  const r = { code: null, body: null };
  r.setHeader = () => {};
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
/** Antwoorden per aanroep: een lijst van functies, of één functie voor alles. */
function zetFetch(plan) {
  const log = [];
  let i = 0;
  globalThis.fetch = async (u, init) => {
    log.push({ url: String(u), method: init?.method || 'GET', key: init?.headers?.['D360-API-KEY'], body: init?.body ? JSON.parse(init.body) : null });
    const fn = Array.isArray(plan) ? (plan[i++] || plan[plan.length - 1]) : plan;
    return fn({ url: String(u), init });
  };
  return log;
}
const lijstAntwoord = (templates) => () => new Response(JSON.stringify({ waba_templates: templates }), { status: 200 });

test('indienen: dient de vier in, schrijft onze rijen, en noemt de sleutel nergens', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  const log = zetFetch([
    lijstAntwoord([]),
    ({ init }) => new Response(JSON.stringify({ id: 'tpl-' + JSON.parse(init.body).name, status: 'PENDING' }), { status: 200 }),
  ]);
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;

  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.samenvatting.ingediend, 4, JSON.stringify(res.body.items));
  assert.equal(res.body.samenvatting.mislukt, 0);
  assert.equal(res.body.lijn, 'klantnummer');

  // Eén lijstaanroep, dan vier POSTs — met de sleutel in de header.
  assert.equal(log.filter((l) => l.method === 'POST').length, 4);
  assert.equal(log[0].method, 'GET');
  for (const l of log) assert.equal(l.key, SLEUTEL, 'de sleutel hoort in de header');

  // En nergens in wat de gebruiker terugkrijgt.
  assert.ok(!JSON.stringify(res.body).includes(SLEUTEL), 'de sleutel staat in het antwoord');
  assert.ok(!JSON.stringify(db._data.agent_audit_log).includes(SLEUTEL), 'de sleutel staat in het logboek');

  // Onze rijen: tekst, voorbeelden, status, en de WABA-filtersleutel.
  const rijen = db._data.whatsapp_meta_templates;
  assert.equal(rijen.length, 4);
  for (const wens of W.TEMPLATE_WENSEN) {
    const rij = rijen.find((r) => r.name === wens.name);
    assert.ok(rij, wens.name);
    assert.equal(rij.body_text, wens.body_text);
    assert.equal(rij.status, 'SUBMITTED', 'PENDING bij 360dialog is SUBMITTED bij ons');
    assert.equal(rij.business_account_id, W.WENS_BUSINESS_ACCOUNT_ID);
    assert.equal(rij.meta_template_id, 'tpl-' + wens.name);
    assert.ok(rij.submitted_at);
  }

  // De payload naar 360dialog: UTILITY, nl, en een voorbeeld per variabele.
  const een = log.find((l) => l.body?.name === 'betaalafspraak_bevestiging').body;
  assert.equal(een.category, 'UTILITY');
  assert.equal(een.language, 'nl');
  const body = een.components.find((c) => c.type === 'BODY');
  assert.equal(body.text, W.wensOpNaam('betaalafspraak_bevestiging').body_text);
  assert.deepEqual(body.example.body_text[0], ['Jeffrey', '€ 249,00', 'vrijdag 24 oktober']);
});

test('indienen is idempotent: wat al bij 360dialog staat, gaat niet opnieuw', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  const log = zetFetch([
    lijstAntwoord([
      { name: 'factuur_vraag', language: 'nl', status: 'APPROVED', id: 'bestaat-1' },
      { name: 'mentor_planning', language: 'nl', status: 'PENDING', id: 'bestaat-2' },
    ]),
    () => new Response(JSON.stringify({ id: 'nieuw', status: 'PENDING' }), { status: 200 }),
  ]);
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;

  assert.equal(res.body.samenvatting.ingediend, 2);
  assert.equal(res.body.samenvatting.overgeslagen, 2);
  const posts = log.filter((l) => l.method === 'POST').map((l) => l.body.name).sort();
  assert.deepEqual(posts, ['betaalafspraak_bevestiging', 'lms_toegang_hulp']);

  // De overgeslagen krijgen wél de stand van 360dialog mee — anders staat er
  // een template die goedgekeurd is terwijl Iris 'm niet mag sturen.
  const fv = db._data.whatsapp_meta_templates.find((r) => r.name === 'factuur_vraag');
  assert.equal(fv.status, 'APPROVED');
  assert.ok(fv.approved_at);
  assert.equal(fv.meta_template_id, 'bestaat-1');
  const mp = db._data.whatsapp_meta_templates.find((r) => r.name === 'mentor_planning');
  assert.equal(mp.status, 'SUBMITTED');
});

test('tweede keer drukken met alles al ingediend: nul POSTs', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  const alles = W.TEMPLATE_WENSEN.map((w) => ({ name: w.name, language: 'nl', status: 'APPROVED', id: 'x' }));
  const log = zetFetch(lijstAntwoord(alles));
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;
  assert.equal(res.body.samenvatting.overgeslagen, 4);
  assert.equal(log.filter((l) => l.method === 'POST').length, 0);
});

test('"bestaat al" van 360dialog is geen fout maar het antwoord dat we wilden', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  zetFetch([
    lijstAntwoord([]),
    () => new Response(JSON.stringify({ error: { message: 'Template already exists' } }), { status: 400 }),
  ]);
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen', namen: ['factuur_vraag'] }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;
  assert.equal(res.body.samenvatting.overgeslagen, 1);
  assert.equal(res.body.samenvatting.mislukt, 0);
});

test('lijst niet op te halen → NIETS ingediend, en dat staat in de uitleg', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  const log = zetFetch(() => new Response('kapot', { status: 500 }));
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;

  assert.equal(res.code, 502);
  assert.equal(log.filter((l) => l.method === 'POST').length, 0, 'er is ingediend zonder te weten wat er al stond');
  assert.match(res.body.uitleg, /NIETS is ingediend|NIETS ingediend/i);
  assert.equal(db._data.whatsapp_meta_templates.length, 0);
});

test('geen sleutel voor de lijn → 503 met de env-naam, geen POST', async () => {
  const bewaard = process.env.D360_API_KEY_KLANTNUMMER;
  delete process.env.D360_API_KEY_KLANTNUMMER;
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  const log = zetFetch(lijstAntwoord([]));
  const res = nepRes();
  try {
    await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  } finally {
    globalThis.fetch = echteFetch;
    process.env.D360_API_KEY_KLANTNUMMER = bewaard;
  }
  assert.equal(res.code, 503);
  assert.match(res.body.error, /D360_API_KEY_KLANTNUMMER/);
  assert.equal(log.length, 0);
});

test('een fout op één template houdt de andere drie niet tegen', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  let n = 0;
  zetFetch([
    lijstAntwoord([]),
    ({ init }) => {
      n++;
      if (n === 2) return new Response(JSON.stringify({ error: { message: 'Invalid parameter' } }), { status: 400 });
      return new Response(JSON.stringify({ id: 'tpl', status: 'PENDING' }), { status: 200 });
    },
  ]);
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;
  assert.equal(res.body.samenvatting.ingediend, 3);
  assert.equal(res.body.samenvatting.mislukt, 1);
  const stuk = res.body.items.find((i) => i.actie === 'mislukt');
  assert.match(stuk.reden, /Invalid parameter/);
});

test('status vernieuwen zet de stand in ONZE rij — daar kijkt Iris naar', async () => {
  db = nepDb({
    whatsapp_meta_templates: [
      { id: 'r1', name: 'factuur_vraag', language: 'nl', status: 'SUBMITTED', approved_at: null },
      { id: 'r2', name: 'aanmaning_dag7', language: 'nl', status: 'APPROVED', approved_at: '2026-01-01T00:00:00Z' },
      { id: 'r3', name: 'mentor_planning', language: 'nl', status: 'SUBMITTED', approved_at: null },
      { id: 'r4', name: 'staat_niet_bij_360', language: 'nl', status: 'LOCAL', approved_at: null },
    ],
    agent_audit_log: [],
  });
  zetFetch(lijstAntwoord([
    { name: 'factuur_vraag', language: 'nl', status: 'APPROVED', id: 'a1' },
    { name: 'aanmaning_dag7', language: 'nl', status: 'APPROVED', id: 'a2' },
    { name: 'mentor_planning', language: 'nl', status: 'REJECTED', id: 'a3', rejected_reason: 'ONBEKENDE_TEKST' },
  ]));
  const res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'status_vernieuwen' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;

  assert.equal(res.code, 200, JSON.stringify(res.body));
  const rij = (id) => db._data.whatsapp_meta_templates.find((r) => r.id === id);
  assert.equal(rij('r1').status, 'APPROVED');
  assert.ok(rij('r1').approved_at, 'goedgekeurd zonder datum');
  assert.equal(rij('r2').approved_at, '2026-01-01T00:00:00Z', 'een bestaande goedkeurdatum blijft staan');
  assert.equal(rij('r3').status, 'REJECTED');
  assert.equal(rij('r3').rejection_reason, 'ONBEKENDE_TEKST');
  assert.equal(rij('r4').status, 'LOCAL', 'wat 360dialog niet kent, laten we staan');
  assert.equal(res.body.niet_bij_360, 1);
  assert.deepEqual(res.body.veranderd.map((v) => v.naam).sort(), ['factuur_vraag', 'mentor_planning']);
  assert.ok(!('meta_template_id' in rij('r4')), 'een rij die 360dialog niet kent is niet aangeraakt');
});

test('overzicht (GET) schrijft niets en zegt per template of Iris hem kan sturen', async () => {
  db = nepDb({
    whatsapp_meta_templates: [{ id: 'r1', name: 'factuur_vraag', language: 'nl', status: 'APPROVED', submitted_at: 'x', approved_at: 'y' }],
    agent_audit_log: [],
  });
  const log = zetFetch(lijstAntwoord([{ name: 'factuur_vraag', language: 'nl', status: 'APPROVED', id: 'a1' }]));
  const res = nepRes();
  await EP.default({ method: 'GET', body: {}, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;

  assert.equal(res.code, 200);
  assert.equal(res.body.items.length, 4);
  const fv = res.body.items.find((i) => i.naam === 'factuur_vraag');
  assert.equal(fv.iris_kan_sturen, true);
  assert.equal(fv.staat_bij_360, true);
  const mp = res.body.items.find((i) => i.naam === 'mentor_planning');
  assert.equal(mp.iris_kan_sturen, false);
  assert.equal(mp.staat_bij_360, false);
  assert.deepEqual(res.body.te_doen.sort(), ['betaalafspraak_bevestiging', 'lms_toegang_hulp', 'mentor_planning']);
  assert.equal(log.filter((l) => l.method !== 'GET').length, 0, 'GET mag niets veranderen');
  assert.equal(db._data.whatsapp_meta_templates.length, 1, 'GET heeft rijen aangemaakt');
  assert.equal(db._data.agent_audit_log.length, 0, 'GET schrijft in het logboek');
});

test('360dialog onbereikbaar bij het overzicht: het scherm werkt, met een melding', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  zetFetch(() => new Response('weg', { status: 503 }));
  const res = nepRes();
  await EP.default({ method: 'GET', body: {}, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;
  assert.equal(res.code, 200, 'het overzicht hoort niet om te vallen op een onbereikbare partij');
  assert.ok(res.body.fout_360);
  assert.equal(res.body.items.length, 4);
  for (const i of res.body.items) assert.equal(i.staat_bij_360, null, 'onbekend is niet hetzelfde als nee');
});

test('zonder recht geen 360dialog-aanroep, en een onbekende lijn wordt geweigerd', async () => {
  db = nepDb({ whatsapp_meta_templates: [], agent_audit_log: [] });
  magHet = false;
  let log = zetFetch(lijstAntwoord([]));
  let res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen' }, headers: {}, query: {} }, res);
  magHet = true;
  assert.equal(res.code, 403);
  assert.equal(log.length, 0);

  log = zetFetch(lijstAntwoord([]));
  res = nepRes();
  await EP.default({ method: 'POST', body: { actie: 'indienen', lijn: 'van-de-buren' }, headers: {}, query: {} }, res);
  globalThis.fetch = echteFetch;
  assert.equal(res.code, 400);
  assert.equal(log.length, 0);
});

/* ── 5. Het scherm ─────────────────────────────────────────────────────────── */

const IRIS = lees('modules/iris/iris.js');

test('het scherm heeft de twee knoppen en hangt ze aan dit eindpunt', () => {
  assert.match(IRIS, /\$\{templateWensenBlok\(\)\}/, 'het blok staat niet in de Instellingen-tab');
  assert.match(IRIS, /__irisTemplatesIndienen/);
  assert.match(IRIS, /__irisTemplatesStatus/);
  assert.match(IRIS, /'\/api\/iris-templates'/);
  assert.match(IRIS, /actie: 'indienen'|'indienen'/);
  // De knop mag niet suggereren dat indienen hetzelfde is als goedgekeurd.
  assert.match(IRIS, /Indienen is geen goedkeuren/);
});

test('?v2tab=instellingen opent de Instellingen, een tikfout opent de Post', () => {
  assert.match(IRIS, /function beginTab\(\)/);
  assert.match(IRIS, /tab: beginTab\(\)/);
  assert.match(IRIS, /v2tab/);
});

test('het scherm heeft een nieuw nummer', () => {
  const m = lees('modules/klanten-v2/index.html').match(/\.\.\/iris\/iris\.js\?v=(\d+)/);
  assert.ok(m, 'iris.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 28, `?v=${m[1]} is lager dan de 28 van deze PR`);
});
