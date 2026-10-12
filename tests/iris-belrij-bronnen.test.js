// tests/iris-belrij-bronnen.test.js
//
// Taak 6, deel 1 — de belrij krijgt drie bronnen.
//
// ── WAT ER NU IS, GEMETEN ───────────────────────────────────────────────────
// `iris_belrij` krijgt vandaag alléén rijen uit api/iris-actie.js (de
// handmatige actie `belrij_toevoegen`). Er is geen enkele plek die hem vult uit
// de wanbetalers, uit de mentorsignalen of uit verlopen opvolgingen. Dat is
// waarom het scherm "Niemand te bellen" zegt terwijl het dashboard 242
// bel-acties toont: de belrij is leeg omdat niemand hem vult.
//
// Deze toetsen gaan over BEDOELD gedrag, niet over wat er nu op het scherm
// staat: wie uit welke bron op de lijst komt, hoe drie redenen op één rij
// belanden, en wat er NIET gebeurt (geen handmatige rij aanraken, geen tweede
// rij per persoon, geen kandidaat zonder contact).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BRON_PRIORITEIT, DETAIL_MAX, SLEUTEL_PREFIX,
  bronSleutelVan, uitBeltaak, uitSignaal, uitOpvolging, voegSamen, vervallenRedenen,
} from '../api/_lib/iris/belrij-bronnen.js';
import { voorstelVoor, VOORSTEL_PER_TYPE } from '../api/_lib/iris/signalen.js';

const VULLER = readFileSync(new URL('../api/_lib/iris/belrij-vullen.js', import.meta.url), 'utf8');
const CRON   = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');
const MIGR   = readFileSync(new URL('../docs/sql-migrations/2026-10-12-iris-belrij-redenen.sql', import.meta.url), 'utf8');

/** Commentaar weghalen voordat je op code matcht — anders matcht een toets op zijn eigen uitleg. */
const codeVan = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((r) => !/^\s*\/\//.test(r))
  .join('\n');

const C_VULLER = codeVan(VULLER);
const C_CRON   = codeVan(CRON);

// ── bron a: bel-taken van de wanbetalers ────────────────────────────────────

test('een bel-taak zonder contact levert GEEN kandidaat', () => {
  // Een belrij-rij zonder contact is een rij waar niemand een nummer bij vindt.
  assert.equal(uitBeltaak({ id: 't1', payload: { kind: 'call' } }, { contactId: null }), null);
  assert.equal(uitBeltaak({ id: 't1' }, {}), null);
});

test('een bel-taak wordt een kandidaat met bron wanbetaler en een bron-link', () => {
  const k = uitBeltaak(
    { id: 'aaa', customer_id: 'k1', payload: { kind: 'call', title: 'Bel klant' }, scheduled_for: '2026-10-10T09:00:00Z' },
    { contactId: 'c1' }
  );
  assert.equal(k.contact_id, 'c1');
  assert.equal(k.bron, 'wanbetaler');
  assert.equal(k.bron_sleutel, 'pending_action:aaa');
  assert.equal(k.detail, 'Bel klant');
  assert.match(k.bron_link, /open-acties\.html#taak-aaa/);
  assert.equal(k.prioriteit, BRON_PRIORITEIT.wanbetaler);
});

test('de lezer filtert op MANUAL_FOLLOWUP én kind=call, en leest ALLEEN', () => {
  // Eén lezer die zowel handmatige bel-taken als de aanmaanmotor dekt: die zet
  // payload.kind='call' zelf al bij "Bel klant".
  assert.match(C_VULLER, /\.eq\('action_type',\s*'MANUAL_FOLLOWUP'\)/);
  assert.match(C_VULLER, /\.filter\('payload->>kind',\s*'eq',\s*'call'\)/);
  assert.match(C_VULLER, /\.in\('status',\s*\['PENDING',\s*'APPROVED'\]\)/);
  // en er wordt nergens naar pending_actions geschreven.
  const naarPending = C_VULLER.match(/from\('pending_actions'\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/);
  assert.equal(naarPending, null, 'de vuller schrijft naar pending_actions — dat mag niet');
});

// ── bron b: mentorsignalen ──────────────────────────────────────────────────

test('start_niet_op stuurt naar de belrij in plaats van "laat een mens kijken"', () => {
  const v = voorstelVoor('start_niet_op');
  assert.equal(v.actie, 'belrij_toevoegen');
  assert.ok(!v.onbekend, 'start_niet_op valt nog op de neutrale val');
});

test('de vier andere gevraagde types houden hun bestaande voorstel', () => {
  // uitstel / halt / factuur gaan NIET naar de belrij: uitstel is een
  // LMS-handeling, en bij halt of een factuur hoort een mens te kijken.
  assert.equal(VOORSTEL_PER_TYPE.reageert_niet.actie, 'belrij_toevoegen');
  assert.equal(VOORSTEL_PER_TYPE.uitstel.actie, 'lms_on_hold');
  assert.equal(VOORSTEL_PER_TYPE.halt.actie, null);
  assert.equal(VOORSTEL_PER_TYPE.factuur.actie, null);
});

test('een signaal wordt een kandidaat met het mentorsignaal als bron', () => {
  const k = uitSignaal({
    id: 's9', contact_id: 'c2', type: 'reageert_niet',
    mentor_naam: 'Dave', toelichting: 'Drie weken niets gehoord', signaal_op: '2026-10-09T08:00:00Z',
  });
  assert.equal(k.bron, 'mentorsignaal');
  assert.equal(k.bron_sleutel, 'signaal:s9');
  assert.equal(k.detail, 'Drie weken niets gehoord');
});

test('de signaal-lezer bepaalt het type via voorstelVoor, niet via een eigen lijst', () => {
  // Twee lijsten met types lopen uit elkaar zodra het LMS er een bij krijgt.
  assert.match(C_VULLER, /voorstelVoor\(/);
  assert.ok(
    !/\.in\('type',/.test(C_VULLER),
    'de lezer filtert op type in de query — dat is een tweede lijst naast VOORSTEL_PER_TYPE'
  );
});

// ── bron c: verlopen opvolgingen ────────────────────────────────────────────

test('een verlopen opvolging komt binnen als geen_reactie, met de herkomst in de sleutel', () => {
  // Geen zesde waarde in de CHECK van iris_belrij.bron: een opvolging verloopt
  // juist omdát er geen reactie kwam. De sleutel houdt de herkomst vast.
  const k = uitOpvolging({ id: 'o3', contact_id: 'c3', gesprek_id: 'g3', omschrijving: 'Wacht op betaalbewijs', tot: '2026-10-11T00:00:00Z' });
  assert.equal(k.bron, 'geen_reactie');
  assert.equal(k.bron_sleutel, 'opvolging:o3');
  assert.match(k.bron_link, /#iris\/gesprek\/g3/);
});

test('een opvolging zonder contact valt eruit in plaats van te gokken', () => {
  assert.equal(uitOpvolging({ id: 'o4', gesprek_id: 'g4' }, {}), null);
  // mét een contact uit het gesprek wél:
  assert.ok(uitOpvolging({ id: 'o4', gesprek_id: 'g4' }, { contactId: 'c4' }));
});

// ── samenvoegen: één rij per persoon ────────────────────────────────────────

test('drie redenen voor dezelfde persoon worden één rij', () => {
  const uit = voegSamen([
    uitOpvolging({ id: 'o1', contact_id: 'c1', omschrijving: 'Wacht op bewijs', tot: '2026-10-01T00:00:00Z' }),
    uitBeltaak({ id: 't1', customer_id: 'k1', payload: { title: 'Bel klant' } }, { contactId: 'c1' }),
    uitSignaal({ id: 's1', contact_id: 'c1', type: 'reageert_niet' }),
  ]);
  assert.equal(uit.length, 1);
  assert.equal(uit[0].contact_id, 'c1');
  assert.equal(uit[0].redenen.length, 3);
});

test('de rij erft de hoogste prioriteit en de bron van de zwaarste reden', () => {
  const uit = voegSamen([
    uitSignaal({ id: 's1', contact_id: 'c1', type: 'reageert_niet' }),
    uitBeltaak({ id: 't1', customer_id: 'k1', payload: {} }, { contactId: 'c1' }),
  ]);
  assert.equal(uit[0].prioriteit, BRON_PRIORITEIT.wanbetaler);
  assert.equal(uit[0].bron, 'wanbetaler');
  assert.equal(uit[0].redenen[0].bron, 'wanbetaler', 'de zwaarste reden hoort vooraan');
});

test('hetzelfde bron-item twee keer aangeboden levert één reden', () => {
  // Twee ronden die hetzelfde item zien, mogen geen twee regels maken.
  const k = uitBeltaak({ id: 't1', customer_id: 'k1', payload: {} }, { contactId: 'c1' });
  const uit = voegSamen([k, { ...k }]);
  assert.equal(uit[0].redenen.length, 1);
});

test('de uitkomst is stabiel gesorteerd, niet in de volgorde van de databank', () => {
  const a = uitBeltaak({ id: 't1', customer_id: 'k1', payload: {} }, { contactId: 'cb' });
  const b = uitSignaal({ id: 's1', contact_id: 'ca', type: 'reageert_niet' });
  assert.deepEqual(voegSamen([a, b]).map((r) => r.contact_id), voegSamen([b, a]).map((r) => r.contact_id));
});

test('een kandidaat zonder sleutel of zonder contact komt er niet in', () => {
  assert.deepEqual(voegSamen([null, {}, { contact_id: 'c1' }, { bron_sleutel: 'x:1' }]), []);
  assert.equal(bronSleutelVan('signaal', null), null);
  assert.equal(bronSleutelVan('', '1'), null);
});

// ── wat er weer af gaat ─────────────────────────────────────────────────────

test('een reden die de bronnen niet meer aanleveren wordt afgevinkt, niet verwijderd', () => {
  const weg = vervallenRedenen(
    [{ id: 'r1', bron_sleutel: 'signaal:s1' }, { id: 'r2', bron_sleutel: 'opvolging:o1' }],
    ['signaal:s1']
  );
  assert.deepEqual(weg, ['r2']);
  assert.match(C_VULLER, /from\('iris_belrij_redenen'\)[\s\S]{0,120}?\.update\(\{\s*verwerkt_op/);
  const verwijder = C_VULLER.match(/from\('iris_belrij_redenen'\)[\s\S]{0,200}?\.delete\(/);
  assert.equal(verwijder, null, 'redenen worden verwijderd in plaats van afgevinkt');
});

test('de vuller verwijdert nergens iets', () => {
  assert.ok(!/\.delete\(/.test(C_VULLER), 'er staat een .delete() in de vuller');
});

// ── wat er niet mag gebeuren ────────────────────────────────────────────────

test('er wordt geen tweede open rij per persoon gemaakt: eerst zoeken, dan schrijven', () => {
  // Een partiële unieke index kan in PostgREST geen ON CONFLICT-arbiter zijn,
  // dus het moet met de hand: SELECT de open rij, dan UPDATE of INSERT.
  assert.match(C_VULLER, /from\('iris_belrij'\)[\s\S]{0,300}?\.in\('status',\s*OPEN_STATUS\)/);
  assert.match(C_VULLER, /maybeSingle\(\)/);
  const metArbiter = C_VULLER.match(/from\('iris_belrij'\)\s*\n?\s*\.upsert\(/);
  assert.equal(metArbiter, null, 'iris_belrij wordt geupsert — dat kan niet met een partiële index');
});

test('een prioriteit die een mens hoger zette, schuift niet omlaag', () => {
  assert.match(C_VULLER, /Math\.max\(Number\(bestaand\.prioriteit\)/);
});

test('de redenen gaan er wél met een arbiter in — die index is volledig', () => {
  assert.match(C_VULLER, /onConflict:\s*'belrij_id,bron_sleutel'/);
  assert.match(MIGR, /create unique index if not exists idx_iris_belrij_redenen_bron[\s\S]{0,120}?\(belrij_id,\s*bron_sleutel\)/);
});

test('één fout contact blokkeert de rest van de ronde niet', () => {
  assert.match(C_VULLER, /for \(const rij of rijen\)[\s\S]{0,400}?try \{/);
  assert.match(C_VULLER, /console\.error\(.\[iris\/belrij-vullen\]/);
});

test('detail wordt afgekapt, zodat er geen berichttekst in een kaart lekt', () => {
  const lang = 'x'.repeat(DETAIL_MAX + 50);
  const k = uitSignaal({ id: 's1', contact_id: 'c1', type: 'reageert_niet', toelichting: lang });
  assert.equal(k.detail.length, DETAIL_MAX);
});

// ── de ronde en de migratie ─────────────────────────────────────────────────

test('de cron-ronde roept de vuller aan, fail-soft en binnen de tijd', () => {
  assert.match(C_CRON, /import \{ vulBelrij \} from '\.\/_lib\/iris\/belrij-vullen\.js'/);
  assert.match(C_CRON, /if \(opTijd\(\)\) \{[\s\S]{0,200}?await vulBelrij\(supabaseAdmin, \{ opTijd \}\)/);
  assert.match(C_CRON, /await vulBelrij[\s\S]{0,400}?catch \(e\) \{[\s\S]{0,120}?meldFout\('belrij vullen', e\)/);
});

test('de ronde stuurt niets: er zit geen verzendpad in de vuller', () => {
  for (const verboden of ['verstuurConcept', 'metaPostMessage', 'iris_concepten', 'sendMail']) {
    assert.ok(!C_VULLER.includes(verboden), `de vuller raakt ${verboden} aan — versturen is deel 3`);
  }
});

test('de migratie is additief: geen drop van een tabel of kolom, geen update op bestaande rijen', () => {
  const sql = MIGR.split('\n').filter((r) => !/^\s*--/.test(r)).join('\n').toLowerCase();
  assert.ok(!/\balter table public\.iris_belrij\b/.test(sql), 'de migratie verbouwt iris_belrij');
  assert.ok(!/\bdrop (table|column|constraint)\b/.test(sql), 'er staat een drop in de uitvoerbare SQL');
  assert.ok(!/^\s*update\s+public\./m.test(sql), 'er staat een UPDATE op bestaande rijen in');
  assert.match(MIGR, /enable row level security/i);
  assert.match(MIGR, /create policy iris_belrij_redenen_staff/i);
});

test('de migratie heeft een controle vóór en ná', () => {
  assert.match(MIGR, /CONTROLE VOOR/);
  assert.match(MIGR, /CONTROLE NA/);
  assert.match(MIGR, /personen_dubbel/);
});
