// tests/lms-geen-hold-poort.test.js
//
// ÉÉN POORT, EN DAT IS DE STILTE. DE HOLD-POORT IS WEG.
//
// ── WAT HIER BEWAAKT WORDT, EN WAAROM HET EEN EIGEN BESTAND IS ───────────
// #1622 liet de aanmaanmotor zwijgen bij elke rij in `hlms_student_hold`.
// Dat was juist zolang een hold altijd een mens was. Sinds het LMS ook
// AUTOMATISCHE betalingsholds kan zetten (2+ vervallen facturen, `door`
// leeg, `reden_soort='betaling'`) is het dat niet meer: die poort zou
// precies de wanbetalers stilleggen die wél een aanmaning horen te krijgen.
// Beslissing Maxim, 21 september 2026: alleen `hlms_crm_stilte` legt de
// motor stil, en daar staat per rij een mens onder.
//
// Een verwijdering die alleen uit een diff blijkt, komt terug. Zodra iemand
// "de hold-poort" opnieuw invoert omdat het LMS een hold heeft die geen
// stilte werd, staat de fout er weer — en dan zwijgend, want er gaat niets
// kapot: er gaan alleen berichten NIET uit. Vandaar een toets die het
// verschil hard maakt, met een fixture die het geval nabouwt dat de
// aanleiding was.
//
// ── DE MEETSTAND OP 21 SEPTEMBER 2026 ────────────────────────────────────
// Op productie stond op dat moment exact één hold: de testpauze van Maxim
// op student "Maxim test", met `door` gevuld. NUL automatische
// betalingsholds, terwijl er 15 rode factuur_vervallen-kaarten open stonden
// — het LMS roept `hlms_hold_automatisch_aan` vandaag dus nog niet aan.
// `dunning_log` bevat in 8.088 regels geen enkele `skipped_lms_hold`: de
// poort heeft op productie nooit iemand overgeslagen.
//
// Die nul is precies de reden dat deze fixture bestaat. De fout is nog niet
// gebeurd, dus er is geen productiegeval om naar te wijzen; de toets moet
// het geval zelf nabouwen, anders wordt hij pas rood op de dag dat het LMS
// de eerste automatische hold schrijft — en dan staat de inning al stil.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { haalStilteStand, stilteBlokkade } from '../api/_lib/lms-stilte.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const VANDAAG = '2026-09-21';

// ═══════════════════════════════════════════════════════════════════════════
// DE FIXTURE — het geval dat de aanleiding was, nagebouwd
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Een Supabase-achtige nepcliënt over een tabel→rijen-kaart. Houdt bij welke
 * tabellen er bevraagd zijn: dat is in deze toets de halve tegenproef.
 */
function nepClient(tabellen, bevraagd = new Set()) {
  return {
    _bevraagd: bevraagd,
    from(naam) {
      bevraagd.add(naam);
      const q = {
        _rijen: Array.isArray(tabellen[naam]) ? tabellen[naam].slice() : [],
        select() { return q; },
        or()     { return q; },   // de aanroeper zeeft zelf in JS
        gte(k, v) { q._rijen = q._rijen.filter((r) => String(r[k] ?? '') >= String(v)); return q; },
        eq(k, v)  { q._rijen = q._rijen.filter((r) => String(r[k] ?? '') === String(v)); return q; },
        in(k, l)  { const s = new Set(l.map(String));
                    q._rijen = q._rijen.filter((r) => s.has(String(r[k] ?? ''))); return q; },
        ilike(k, p) { q._rijen = q._rijen.filter((r) =>
                        String(r[k] ?? '').toLowerCase() === String(p).toLowerCase()); return q; },
        maybeSingle() { return Promise.resolve({ data: q._rijen[0] || null, error: null }); },
        upsert()      { return Promise.resolve({ data: null, error: null }); },
        then(res, rej) { return Promise.resolve({ data: q._rijen, error: null }).then(res, rej); },
      };
      return q;
    },
  };
}

const STUDENT_AUTO  = 'aaaaaaaa-0000-4000-8000-000000000001'; // automatische pauze
const STUDENT_MENS  = 'bbbbbbbb-0000-4000-8000-000000000002'; // menselijke afspraak
const KLANT_AUTO    = 'k-auto';
const KLANT_MENS    = 'k-mens';

function fixture() {
  const bevraagd = new Set();
  const lms = nepClient({
    // Zoals het LMS het straks wegschrijft: `door` leeg, reden betaling.
    // Dit is wat de OUDE poort zou hebben gelezen.
    hlms_student_hold: [{
      student_id: STUDENT_AUTO, van: '2026-09-15', tot: '2026-12-31',
      reden: '2 vervallen facturen', reden_soort: 'betaling',
      door: null, opgeheven_op: null, materiaal_open: true,
    }],
    // En dit is het contract: alleen de menselijke afspraak staat erin.
    hlms_crm_stilte: [{
      student_id: STUDENT_MENS, stil_tot: '2026-10-01', reden: 'afspraak',
      reden_tekst: 'belt maandag terug', door_naam: 'Dave', bron: 'belofte',
    }],
    hlms_student: [
      { id: STUDENT_AUTO, email: 'auto@voorbeeld.nl', bubble_user_id: null,
        product_soort: 'mentorship', auth_id: 'x', eind_datum: '2027-01-01' },
      { id: STUDENT_MENS, email: 'mens@voorbeeld.nl', bubble_user_id: null,
        product_soort: 'mentorship', auth_id: 'y', eind_datum: '2027-01-01' },
    ],
  }, bevraagd);

  const db = nepClient({
    onboardings: [
      { id: 'o1', customer_id: KLANT_AUTO, dfo_lms_student_id: STUDENT_AUTO,
        bubble_user_id: null, is_test: false },
      { id: 'o2', customer_id: KLANT_MENS, dfo_lms_student_id: STUDENT_MENS,
        bubble_user_id: null, is_test: false },
    ],
    customers: [],
    app_settings: [],
  });

  return { lms, db, bevraagd };
}

test('FIXTURE: een klant met alleen een AUTOMATISCHE betalingshold wordt gewoon gemaand', async () => {
  const { lms, db } = fixture();
  const stand = await haalStilteStand({ db, lmsClient: lms, todayIso: VANDAAG });

  assert.equal(stilteBlokkade(stand, KLANT_AUTO), null,
    'de automatische betalingspauze legt de aanmaning stil — dat is precies '
    + 'de fout waarvoor de hold-poort is weggehaald: dan wordt de wanbetaler '
    + 'die 2 facturen open heeft staan juist NIET gemaand');
});

test('TEGENPROEF: een klant met een MENSELIJKE afspraak wordt wél stilgehouden', async () => {
  const { lms, db } = fixture();
  const stand = await haalStilteStand({ db, lmsClient: lms, todayIso: VANDAAG });

  const blok = stilteBlokkade(stand, KLANT_MENS);
  assert.ok(blok, 'de menselijke afspraak blokkeert niet — dan manen we tegen '
    + 'een toezegging van Dave in');
  assert.match(blok.reden, /belt maandag terug/);
  assert.match(blok.reden, /Dave/);
});

test('FIXTURE: de motor bevraagt hlms_student_hold niet meer', async () => {
  const { lms, db, bevraagd } = fixture();
  await haalStilteStand({ db, lmsClient: lms, todayIso: VANDAAG });

  assert.ok(bevraagd.has('hlms_crm_stilte'), 'het contract wordt niet gelezen');
  assert.ok(!bevraagd.has('hlms_student_hold'),
    'de motor leest de hold-tabel nog steeds — dan kan een automatische pauze '
    + 'langs een andere weg alsnog een zwijggebod worden');
});

test('TEGENPROEF: een menselijke hold bereikt ons nog steeds, via het contract', async () => {
  // Het LMS projecteert een hold die een MENS zette naar een stilterij met
  // bron='hold'. Dat is de weg die overblijft, en hij moet dicht blijven —
  // anders is met de poort ook de bescherming verdwenen.
  const bevraagd = new Set();
  const lms = nepClient({
    hlms_crm_stilte: [{
      student_id: STUDENT_AUTO, stil_tot: '2026-10-05', reden: 'betaling',
      reden_tekst: 'regeling afgesproken', door_naam: 'de hoofdmentor', bron: 'hold',
    }],
    hlms_student: [{ id: STUDENT_AUTO, email: 'auto@voorbeeld.nl', bubble_user_id: null,
      product_soort: 'mentorship', auth_id: 'x', eind_datum: '2027-01-01' }],
  }, bevraagd);
  const db = nepClient({
    onboardings: [{ id: 'o1', customer_id: KLANT_AUTO, dfo_lms_student_id: STUDENT_AUTO,
      bubble_user_id: null, is_test: false }],
    customers: [], app_settings: [],
  });

  const stand = await haalStilteStand({ db, lmsClient: lms, todayIso: VANDAAG });
  const blok = stilteBlokkade(stand, KLANT_AUTO);
  assert.ok(blok, 'een menselijke hold die het LMS als stilte doorgeeft blokkeert niet');
  assert.match(blok.reden, /hoofdmentor/);
  assert.equal(blok.bron, 'hold');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET CONTRACT — de poort is overal weg, en komt niet terug
// ═══════════════════════════════════════════════════════════════════════════

test('CONTRACT: api/_lib/lms-hold.js bestaat niet meer', () => {
  assert.equal(existsSync(join(ROOT, 'api/_lib/lms-hold.js')), false,
    'de hold-poort staat er weer');
});

/** Elk .js-bestand onder api/, recursief. */
function apiBestanden(map = 'api') {
  const uit = [];
  for (const item of readdirSync(join(ROOT, map), { withFileTypes: true })) {
    if (item.name === 'node_modules') continue;
    const pad = map + '/' + item.name;
    if (item.isDirectory()) uit.push(...apiBestanden(pad));
    else if (item.name.endsWith('.js')) uit.push(pad);
  }
  return uit;
}

test('CONTRACT: geen enkel bestand onder api/ roept de hold-poort nog aan', () => {
  const verboden = /haalHoldStand\s*\(|holdBlokkade\s*\(|holdStandSamenvatting\s*\(|from\s*\(\s*['"]hlms_student_hold['"]|lms-hold\.js/;
  const schuldig = [];
  for (const pad of apiBestanden()) {
    // De eigen uitleg in lms-koppelnet.js mag de oude naam noemen — dat is
    // de reden dat dat bestand bestaat. Alleen code telt hier.
    const bron = lees(pad).split('\n')
      .filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
      .join('\n');
    if (verboden.test(bron)) schuldig.push(pad);
  }
  assert.deepEqual(schuldig, [],
    'de hold-poort is teruggekomen in: ' + schuldig.join(', '));
});

test('CONTRACT: de automatische verzendpaden vragen de STILTE-poort, alle drie', () => {
  // Alle paden waarlangs een klant automatisch een bericht kan krijgen. De
  // bulk-flow hoort hier sinds 21 september bij: daar stond de hold-poort en
  // die is VERVANGEN, niet weggehaald — een bulk-ronde van gisteren is geen
  // vrijbrief om vandaag tegen een afspraak in te manen.
  for (const kort of ['api/_lib/dunning-engine.js',
                      'api/cron-dunning-conversation-reminders.js',
                      'api/cron-dunning-bulk-send.js']) {
    const bron = lees(kort);
    assert.match(bron, /haalStilteStand\(/, kort + ' haalt de stilte-stand niet op');
    assert.match(bron, /stilteBlokkade\(/,  kort + ' toetst de stilte-poort niet');
  }
});

test('CONTRACT: het gedeelde vangnet leeft in lms-koppelnet.js, niet in twee kopieën', () => {
  const net = lees('api/_lib/lms-koppelnet.js');
  assert.match(net, /export async function bouwVangnet\(/);
  assert.match(net, /export const GEKOPPELD_SETTING_KEY/);

  for (const kort of ['api/_lib/lms-stilte.js', 'api/_lib/factuurstand-sync.js']) {
    assert.match(lees(kort), /from '\.\/lms-koppelnet\.js'/,
      kort + ' haalt het vangnet niet uit de gedeelde plek');
  }
  // En niemand bouwt er stiekem een tweede.
  const kopieen = apiBestanden()
    .filter((p) => p !== 'api/_lib/lms-koppelnet.js')
    .filter((p) => /function bouwVangnet\s*\(/.test(lees(p)));
  assert.deepEqual(kopieen, [], 'tweede vangnet in: ' + kopieen.join(', '));
});

test('CONTRACT: het hold-event is uit de UI-woordenlijst en de pipeline-bakken', () => {
  // Op productie bestaat geen enkele dunning_log-regel met dit event (0 van
  // 8.088 op 21 september), dus er is geen geschiedenis die onleesbaar wordt
  // door het weg te halen. Was die er wel geweest, dan had het label moeten
  // blijven staan.
  for (const kort of ['api/_lib/dunning-event-labels.js',
                      'api/_lib/pipeline-overview-helpers.js',
                      'modules/finance.html']) {
    assert.doesNotMatch(lees(kort), /lms_hold/,
      kort + ' noemt het hold-event nog');
  }
});
