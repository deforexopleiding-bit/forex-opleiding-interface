// tests/iris-opdracht.test.js
//
// "Iris, regel dit."
//
// Twee dingen worden hier vastgepind. Ten eerste dat een stap met een type
// dat wij niet kennen, wordt WEGGEGOOID en niet doorgelaten: een stap die
// nergens heen gaat, ziet er in het scherm uit als iets wat zal gebeuren — en
// dat gebeurt dan niet. Ten tweede dat een opdracht die meerdere mensen raakt
// altijd om bevestiging vraagt. Een verkeerd bericht naar één persoon is een
// excuus waard; hetzelfde bericht naar veertig mensen is een incident.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BULK_VANAF,
  BULK_MAX,
  TOESTANDEN,
  STAPTYPES,
  SYSTEEM_TEKST,
  GEREEDSCHAP_SCHEMA,
  keurPlan,
  volgendeToestand,
  magDirectUitvoeren,
  doseerPlan,
  maakPlan,
  verloopRegel,
} from '../api/_lib/iris/opdracht.js';

const PLAN = {
  titel: 'Kevin uitstel geven',
  begrepen: 'Kevin laten weten dat hij tot vrijdag de tijd heeft.',
  stappen: [
    { type: 'wa_versturen', omschrijving: 'Stuur Kevin een bericht over vrijdag', wie: 'Kevin Peeters', parameters: { datum: '2026-09-25' } },
  ],
  raakt_groep: false,
};

// ── het plan nakijken ───────────────────────────────────────────────────────

test('een net plan komt er ongeschonden door', () => {
  const r = keurPlan(PLAN);
  assert.equal(r.ok, true);
  assert.equal(r.plan.titel, 'Kevin uitstel geven');
  assert.equal(r.plan.stappen.length, 1);
  assert.equal(r.plan.stappen[0].type, 'wa_versturen');
});

test('een stap met een verzonnen type wordt WEGGEGOOID, niet doorgelaten', () => {
  const r = keurPlan({
    ...PLAN,
    stappen: [
      { type: 'wa_versturen', omschrijving: 'bericht' },
      { type: 'klant_blokkeren', omschrijving: 'blokkeer hem' },
      { type: 'factuur_kwijtschelden', omschrijving: 'scheld kwijt' },
    ],
  });
  assert.equal(r.plan.stappen.length, 1);
  assert.deepEqual(r.plan.geweigerde_stappen, ['klant_blokkeren', 'factuur_kwijtschelden']);
});

test('geweigerde stappen worden GEMELD, niet stil geslikt', () => {
  // Als het model iets voorstelt wat niet kan, hoort dat zichtbaar te zijn.
  // Stil weggooien betekent dat Maxim denkt dat het plan compleet is.
  const r = keurPlan({ ...PLAN, stappen: [{ type: 'verzonnen', omschrijving: 'x' }] });
  assert.equal(r.plan.stappen.length, 0);
  assert.equal(r.plan.geweigerde_stappen.length, 1);
});

test('blokkeren en toegang intrekken bestaan niet als staptype', () => {
  assert.ok(!STAPTYPES.includes('klant_blokkeren'));
  assert.ok(!STAPTYPES.includes('lms_toegang_intrekken'));
  assert.ok(!STAPTYPES.includes('factuur_op_betaald'));
});

test('zonder "begrepen" is er geen plan', () => {
  assert.equal(keurPlan({ ...PLAN, begrepen: '   ' }).ok, false);
  assert.equal(keurPlan({}).ok, false);
  assert.equal(keurPlan(null).ok, false);
});

test('zonder titel wordt de eerste zin van "begrepen" de titel', () => {
  const r = keurPlan({ ...PLAN, titel: '' });
  assert.ok(r.plan.titel.length > 0);
  assert.ok(PLAN.begrepen.startsWith(r.plan.titel.slice(0, 20)));
});

test('een stap zonder omschrijving valt terug op zijn type', () => {
  const r = keurPlan({ ...PLAN, stappen: [{ type: 'mail_versturen' }] });
  assert.equal(r.plan.stappen[0].omschrijving, 'mail_versturen');
});

test('parameters die geen object zijn, worden een leeg object', () => {
  const r = keurPlan({ ...PLAN, stappen: [{ type: 'wa_versturen', omschrijving: 'x', parameters: 'onzin' }] });
  assert.deepEqual(r.plan.stappen[0].parameters, {});
});

// ── de vraag ────────────────────────────────────────────────────────────────

test('één vraag met opties komt door', () => {
  const r = keurPlan({ ...PLAN, vraag: 'Welke Kevin bedoel je?', opties: ['Kevin Peeters', 'Kevin De Smet'] });
  assert.equal(r.plan.vraag, 'Welke Kevin bedoel je?');
  assert.equal(r.plan.opties.length, 2);
});

test('opties zonder vraag zijn een menu zonder titel — die vervallen', () => {
  const r = keurPlan({ ...PLAN, vraag: '', opties: ['a', 'b'] });
  assert.equal(r.plan.vraag, null);
  assert.deepEqual(r.plan.opties, []);
});

test('meer dan vier opties worden afgekapt — anders wordt het een formulier', () => {
  const r = keurPlan({ ...PLAN, vraag: 'Wie?', opties: ['a', 'b', 'c', 'd', 'e', 'f'] });
  assert.equal(r.plan.opties.length, 4);
});

test('het schema vraagt uitdrukkelijk om ÉÉN vraag', () => {
  assert.match(GEREEDSCHAP_SCHEMA.properties.vraag.description, /ÉÉN vraag/);
});

// ── de toestand ─────────────────────────────────────────────────────────────

test('er zijn zeven toestanden en geen losse afgesloten-toestand', () => {
  // Een aparte "gesloten"-toestand zou een sluiproute zijn om iets weg te
  // klikken terwijl er nog iets onverstuurd klaarstaat.
  assert.deepEqual([...TOESTANDEN], [
    'gevraagd', 'uitzoeken', 'wacht_op_ok', 'uitgevoerd',
    'wacht_op_antwoord', 'geregeld', 'afgebroken',
  ]);
  assert.ok(!TOESTANDEN.includes('gesloten'));
});

test('elk plan wacht op een ok — ook een plan zonder vragen', () => {
  assert.equal(volgendeToestand(keurPlan(PLAN).plan), 'wacht_op_ok');
  assert.equal(volgendeToestand(keurPlan({ ...PLAN, vraag: 'Wie?' }).plan), 'wacht_op_ok');
});

test('geen plan betekent afgebroken', () => {
  assert.equal(volgendeToestand(null), 'afgebroken');
});

// ── direct uitvoeren ────────────────────────────────────────────────────────

test('een opdracht voor één persoon zonder vragen mag door', () => {
  const r = magDirectUitvoeren(keurPlan(PLAN).plan);
  assert.equal(r.mag, true);
});

test('een opdracht met een openstaande vraag mag niet door', () => {
  const r = magDirectUitvoeren(keurPlan({ ...PLAN, vraag: 'Welke Kevin?' }).plan);
  assert.equal(r.mag, false);
  assert.match(r.reden, /vraag/);
});

test('een opdracht die een GROEP raakt, vraagt altijd bevestiging', () => {
  // Ook met autonomie aan. Dit is de belangrijkste test van dit bestand.
  const r = magDirectUitvoeren(keurPlan({ ...PLAN, raakt_groep: true }).plan);
  assert.equal(r.mag, false);
  assert.match(r.reden, /meerdere mensen/);
});

test('een plan zonder stappen valt ook niet zomaar door', () => {
  const r = magDirectUitvoeren(keurPlan({ ...PLAN, stappen: [] }).plan);
  assert.equal(r.mag, false);
  assert.match(r.reden, /geen stappen/);
});

test('geen plan is geen toestemming', () => {
  assert.equal(magDirectUitvoeren(null).mag, false);
  assert.equal(magDirectUitvoeren(undefined).mag, false);
});

// ── de dosering ─────────────────────────────────────────────────────────────

test('doseerPlan rekent tussenruimte en duur uit', () => {
  const d = doseerPlan(60, { max_per_minuut: 6 });
  assert.equal(d.per_minuut, 6);
  assert.equal(d.tussen_ms, 10000);
  assert.equal(d.duur_minuten, 10);
  assert.equal(d.te_groot, false);
});

test('doseerPlan markeert een lijst die te groot is', () => {
  assert.equal(doseerPlan(BULK_MAX + 1, {}).te_groot, true);
  assert.equal(doseerPlan(BULK_MAX, {}).te_groot, false);
});

test('doseerPlan valt terug op een veilige snelheid bij onzin', () => {
  for (const v of [{}, { max_per_minuut: 0 }, { max_per_minuut: -5 }, { max_per_minuut: 'snel' }]) {
    const d = doseerPlan(10, v);
    assert.ok(d.per_minuut >= 1);
    assert.ok(d.tussen_ms > 0);
  }
});

test('bulk begint bij twee — één persoon is geen bulk', () => {
  assert.equal(BULK_VANAF, 2);
});

// ── het verloop ─────────────────────────────────────────────────────────────

test('een verloopregel zegt wanneer, wie en wat', () => {
  const r = verloopRegel('plan gemaakt', { wie: 'u1', op: new Date('2026-09-21T12:00:00Z') });
  assert.equal(r.op, '2026-09-21T12:00:00.000Z');
  assert.equal(r.wie, 'u1');
  assert.equal(r.wat, 'plan gemaakt');
});

test('wie is null als Iris het zelf deed', () => {
  assert.equal(verloopRegel('plan gemaakt').wie, null);
});

test('een verloopregel kan details dragen, maar hoeft niet', () => {
  assert.equal(verloopRegel('x').details, undefined);
  assert.deepEqual(verloopRegel('x', { details: { n: 3 } }).details, { n: 3 });
});

// ── de instructie ───────────────────────────────────────────────────────────

test('de instructie noemt elk beschikbaar staptype', () => {
  for (const t of STAPTYPES) {
    assert.ok(SYSTEEM_TEKST.includes(t), `${t} ontbreekt in de uitleg aan het model`);
  }
});

test('de instructie zegt uitdrukkelijk wat er NIET kan', () => {
  assert.match(SYSTEEM_TEKST, /blokkeren/);
  assert.match(SYSTEEM_TEKST, /toegang intrekken/);
  assert.match(SYSTEEM_TEKST, /Dat doet een mens/);
});

test('de instructie legt uit waarom het één vraag is en geen formulier', () => {
  assert.match(SYSTEEM_TEKST, /formulier/);
});

// ── zonder model ────────────────────────────────────────────────────────────

test('een lege opdracht kost geen aanroep', async () => {
  const r = await maakPlan({ vraag: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.fout, 'lege opdracht');
});

test('zonder sleutel mislukt het plan netjes', async () => {
  const bewaard = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await maakPlan({ vraag: 'stuur Kevin een bericht' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.fout, 'string');
  } finally {
    if (bewaard !== undefined) process.env.ANTHROPIC_API_KEY = bewaard;
  }
});
