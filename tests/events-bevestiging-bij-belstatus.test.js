// tests/events-bevestiging-bij-belstatus.test.js
//
// DE BEVESTIGINGSMAIL GAAT OOK UIT BIJ BELSTATUS BEVESTIGD.
//
// Maxim, 15 sep 2026: "Ja, nadat wij bevestigd hebben krijgen ze die mail — de
// automatisatie zoals wanneer de vragenlijst werd ingevuld wordt getriggerd."
//
// De automatisatie "Bevestiging aanmelding" hangt aan trigger
// on_assessment_completed met enroll_mode new_only. Die naam blijft (het is
// opgeslagen data), maar de kandidaat-regel is nu de plek-regel: vragenlijst
// ingevuld OF belstatus bevestigd. Elke tak heeft daarbij zijn eigen nulpunt —
// assessment_linked_at respectievelijk call_status_at.
//
// En de mail zelf opende met "Top — je vragenlijst is binnen", wat voor een
// telefonisch bevestigde deelnemer niet klopt. Die zin leest nu de reden.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const NU         = new Date('2026-09-15T12:00:00.000Z');
const ENABLED_AT = '2026-06-19T08:00:00.000Z';
const EVENT_ID   = 'aaaaaaaa-1111-2222-3333-444444444444';

/**
 * Supabase-dubbelganger die de HELE filterketen per tabel onthoudt, zodat de
 * test kan nakijken WIE de trigger selecteert.
 */
function nepAdmin({ rijen = {} } = {}) {
  const ketens = [];
  const from = (tabel) => {
    const keten = { tabel, select: null, stappen: [] };
    ketens.push(keten);
    const k = {
      select(kolommen) { keten.select = kolommen; return k; },
      eq(c, v)  { keten.stappen.push(['eq', c, v]);  return k; },
      in(c, v)  { keten.stappen.push(['in', c, v]);  return k; },
      is(c, v)  { keten.stappen.push(['is', c, v]);  return k; },
      or(s)     { keten.stappen.push(['or', s]);     return k; },
      not(c, o, v) { keten.stappen.push(['not', c, o, v]); return k; },
      ilike(c, v)  { keten.stappen.push(['ilike', c, v]);  return k; },
      gt(c, v)  { keten.stappen.push(['gt', c, v]);  return k; },
      gte(c, v) { keten.stappen.push(['gte', c, v]); return k; },
      lte(c, v) { keten.stappen.push(['lte', c, v]); return k; },
      limit(n)  { keten.stappen.push(['limit', n]);  return k; },
      order()   { return k; },
      insert(v) { keten.insert = v; return k; },
      update(v) { keten.stappen.push(['update', v]); return k; },
      maybeSingle: async () => ({ data: keten.insert ? { id: 'run-1' } : ((rijen[tabel] || [])[0] || null), error: null }),
      then: (res, rej) => Promise.resolve({ data: rijen[tabel] || [], error: null }).then(res, rej),
    };
    return k;
  };
  return { ketens, from };
}

const admin = nepAdmin({ rijen: {
  event_automations: [{
    id: 'auto-bevestiging', trigger_type: 'on_assessment_completed', trigger_config: {},
    scope_type: 'all', scope_config: {}, enroll_mode: 'new_only',
    enabled_at: ENABLED_AT, steps: [{ type: 'send_email' }],
  }],
} });
mock.module(url('api/supabase.js'), {
  namedExports: { supabaseAdmin: admin, createUserClient: () => admin, checkCronAuth: () => ({ ok: true }) },
});

const engine = await import(url('api/_lib/events-automation-engine.js'));
await engine.enrollDueAttendees({ now: NU });

/** De kandidaat-query op event_attendees (de eerste; daarna komen de runs). */
const keten = admin.ketens.find((k) => k.tabel === 'event_attendees');
const stap  = (naam) => keten.stappen.filter(([o]) => o === naam);

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WIE WORDT ER INGESCHREVEN
// ═══════════════════════════════════════════════════════════════════════════

test('de kandidaat-regel is de plek-regel, niet meer alleen de vragenlijst', () => {
  // De kale "assessment_response_id IS NOT NULL"-eis is weg...
  assert.ok(!keten.stappen.some(([o, c]) => o === 'not' && c === 'assessment_response_id'),
    'geen harde vragenlijst-eis meer');
  // ...en vervangen door één or() met beide takken.
  const ors = stap('or');
  assert.equal(ors.length, 1, 'precies één or-clausule — twee or=-parameters zijn niet betrouwbaar');
  assert.match(ors[0][1], /assessment_response_id\.not\.is\.null/);
  assert.match(ors[0][1], /call_status\.ilike\.bevestigd/);
});

test('de status-gate en de verstreken-event-guard blijven staan', () => {
  assert.ok(keten.stappen.some(([o, c, v]) => o === 'in' && c === 'status' && v.join() === 'aangemeld,aanwezig'),
    'wachtlijst / geannuleerd / no_show / sale vallen weg');
  assert.ok(keten.stappen.some(([o, c]) => o === 'gt' && c === 'events.starts_at'),
    'een verstreken event krijgt nooit een bevestiging');
});

test('een proefrij krijgt geen echte bevestiging', () => {
  assert.ok(keten.stappen.some(([o, c, v]) => o === 'eq' && c === 'is_test' && v === false));
});

test('opt-out (automation_enabled=false) blijft gerespecteerd', () => {
  assert.ok(keten.stappen.some(([o, c, v]) => o === 'eq' && c === 'automation_enabled' && v === true));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · NEW_ONLY — elke tak zijn eigen nulpunt
// ═══════════════════════════════════════════════════════════════════════════

test('new_only toetst assessment_linked_at én call_status_at, elk in eigen tak', () => {
  // Vroeger: één gte op assessment_linked_at. Wie via de bel binnenkomt heeft
  // die kolom nooit gevuld en zou er dus altijd doorheen vallen of er altijd
  // buiten — beide fout. Nu draagt elke tak zijn eigen tijdstempel.
  const [[, filter]] = stap('or');
  assert.match(filter, new RegExp(`and\\(assessment_response_id\\.not\\.is\\.null,assessment_linked_at\\.gte\\.${ENABLED_AT.replace(/[.+]/g, '\\$&')}\\)`));
  assert.match(filter, new RegExp(`and\\(call_status\\.ilike\\.bevestigd,call_status_at\\.gte\\.${ENABLED_AT.replace(/[.+]/g, '\\$&')}\\)`));

  // De losse gte van vroeger is weg — die zou naast de or() een tweede,
  // striktere eis zijn en de bevestigd-tak alsnog leegvegen.
  assert.ok(!keten.stappen.some(([o, c]) => o === 'gte' && c === 'assessment_linked_at'),
    'geen losse assessment_linked_at-gte meer naast de or()');
});

test('de ondergrens van de bevestigd-tak zit in één benoemde constante', () => {
  // null = volg enabled_at, net als de vragenlijst-tak. Eén regel om de
  // inhaalbeurt voor de zeven bestaande rijen uit te zetten als Maxim dat wil.
  assert.equal(engine.BEVESTIGD_TRIGGER_VANAF, null);
});

test('de tijdstempels in het filter staan in Z-vorm, zonder plus', () => {
  // Binnen een or()-string is er geen parameter-encoding. Een waarde als
  // '2026-06-19T08:00:00+00:00' zou daar over de '+' kunnen struikelen.
  const [[, filter]] = stap('or');
  assert.doesNotMatch(filter, /\+/);
  assert.match(filter, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · GEEN DUBBELE MAIL
// ═══════════════════════════════════════════════════════════════════════════

test('één run per deelnemer per automatisatie, in welke volgorde dan ook', async () => {
  // De bevestiging mag maar één keer. Iemand die eerst bevestigd wordt en
  // later de vragenlijst invult (of omgekeerd) valt in beide gevallen binnen
  // dezelfde kandidaat-regel — de idempotency zit in enrollDueAttendees, dat
  // bestaande event_automation_runs opzoekt en die attendee_ids overslaat.
  const bron = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../api/_lib/events-automation-engine.js', import.meta.url), 'utf8'));
  const i = bron.indexOf('export async function enrollDueAttendees');
  const blok = bron.slice(i, i + 2000);

  assert.match(blok, /from\('event_automation_runs'\)\s*\.select\('attendee_id'\)\s*\.eq\('automation_id', auto\.id\)/);
  assert.match(blok, /candidates\.filter\(\(c\) => !existing\.has\(c\.id\)\)/);
  // En als twee cron-ticks elkaar toch inhalen, vangt de unique-constraint het.
  assert.match(blok, /insErr\.code !== '23505'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b · WIE KRIJGT ER ÉÉN, EN WIE GEEN
// ═══════════════════════════════════════════════════════════════════════════
//
// De kandidaat-query is één or() plus drie losse filters. Hier leggen we de
// bedoelde uitkomst per geval vast door diezelfde regel na te bouwen — zodat
// een wijziging aan de query hier opvalt, ook als de SQL-vorm verandert.

const VERSTREKEN = '2026-09-01T17:00:00.000Z';  // event al geweest
const KOMEND     = '2026-09-19T17:00:00.000Z';

/** De kandidaat-regel zoals de query hem stelt, in leesbare vorm. */
function isKandidaat(r) {
  if (!['aangemeld', 'aanwezig'].includes(r.status)) return false;   // status-gate
  if (r.is_test === true) return false;                              // proefrij
  if (r.automation_enabled === false) return false;                  // opt-out
  if (new Date(r.event_starts_at) <= NU) return false;               // guard (b)
  const vanaf = new Date(engine.BEVESTIGD_TRIGGER_VANAF || ENABLED_AT);
  const viaLijst = r.assessment_response_id != null
    && r.assessment_linked_at != null && new Date(r.assessment_linked_at) >= new Date(ENABLED_AT);
  const viaBel = String(r.call_status ?? '').trim().toLowerCase() === 'bevestigd'
    && r.call_status_at != null && new Date(r.call_status_at) >= vanaf;
  return viaLijst || viaBel;
}

const rij = (extra) => ({
  status: 'aangemeld', is_test: false, automation_enabled: true,
  event_starts_at: KOMEND, assessment_response_id: null, assessment_linked_at: null,
  call_status: null, call_status_at: null, ...extra,
});

const NA_ENABLED = '2026-09-14T10:00:00.000Z';

test('bevestigd zonder vragenlijst -> wél een bevestiging', () => {
  assert.equal(isKandidaat(rij({ call_status: 'bevestigd', call_status_at: NA_ENABLED })), true);
});

test('vragenlijst ingevuld -> ongewijzigd wél een bevestiging', () => {
  assert.equal(isKandidaat(rij({ assessment_response_id: 'r-1', assessment_linked_at: NA_ENABLED })), true);
});

test('bevestigd en daarna toch de vragenlijst -> nog steeds één kandidaat', () => {
  // Hij voldoet aan beide takken, maar enrollDueAttendees dedupliceert op
  // (automation_id, attendee_id), dus het blijft één run en één mail.
  assert.equal(isKandidaat(rij({
    call_status: 'bevestigd', call_status_at: NA_ENABLED,
    assessment_response_id: 'r-1', assessment_linked_at: NA_ENABLED,
  })), true);
});

test('wachtlijst + bevestigd -> geen bevestiging', () => {
  assert.equal(isKandidaat(rij({ status: 'wachtlijst', call_status: 'bevestigd', call_status_at: NA_ENABLED })), false);
  assert.equal(isKandidaat(rij({ status: 'geannuleerd', call_status: 'bevestigd', call_status_at: NA_ENABLED })), false);
});

test('verstreken event -> geen bevestiging', () => {
  assert.equal(isKandidaat(rij({
    call_status: 'bevestigd', call_status_at: NA_ENABLED, event_starts_at: VERSTREKEN,
  })), false);
});

test('is_test -> geen bevestiging', () => {
  assert.equal(isKandidaat(rij({ is_test: true, call_status: 'bevestigd', call_status_at: NA_ENABLED })), false);
});

test('bevestigd zonder call_status_at -> geen bevestiging', () => {
  // Geen nulpunt is geen "sinds wanneer". Een met de hand gezette rij zonder
  // tijdstempel mag niet stil op de enabled_at-vergelijking meeliften.
  assert.equal(isKandidaat(rij({ call_status: 'bevestigd', call_status_at: null })), false);
});

test('een andere belstatus -> geen bevestiging', () => {
  for (const cs of ['geen_gehoor', 'komt_niet', 'voicemail', 'terugbellen', null]) {
    assert.equal(isKandidaat(rij({ call_status: cs, call_status_at: NA_ENABLED })), false, String(cs));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE TEKST VAN DE MAIL
// ═══════════════════════════════════════════════════════════════════════════

const { bevestigingMail } = await import(url('api/_lib/event-website-teksten.js'));
const { plekReden, PLEK_REDEN_BEVESTIGD, PLEK_REDEN_VRAGENLIJST } = await import(url('api/_lib/plek-bezet.js'));

const mailVoor = (attendee) => bevestigingMail({
  voornaam: 'Pres', titel: 'Masterclass Gent', datum: 'zaterdag 19 september',
  starttijd: '17:00', locatie: 'Gent', reden: plekReden(attendee),
}).text;

test('de openingszin volgt de reden dat de plek vaststaat', () => {
  const viaLijst = mailVoor({ status: 'aangemeld', is_test: false, assessment_response_id: 'resp-1' });
  assert.match(viaLijst, /Top — je vragenlijst is binnen en daarmee staat je plek/);

  const viaBel = mailVoor({ status: 'aangemeld', is_test: false, assessment_response_id: null, call_status: 'bevestigd' });
  assert.match(viaBel, /Top — je hebt je deelname bevestigd en daarmee staat je plek/);
  assert.doesNotMatch(viaBel, /je vragenlijst is binnen/);
});

test('zonder reden blijft de mail exact zoals hij was', () => {
  // Elke bestaande caller die geen reden meegeeft, houdt de oude tekst.
  const zonder = bevestigingMail({ voornaam: 'Pres', titel: 'X', datum: 'D', starttijd: 'T', locatie: 'L' }).text;
  assert.match(zonder, /Top — je vragenlijst is binnen en daarmee staat je plek/);
});

test('plekReden kent maar drie antwoorden', () => {
  const basis = (extra) => ({ status: 'aangemeld', is_test: false, assessment_response_id: null, call_status: null, ...extra });
  assert.equal(plekReden(basis({ assessment_response_id: 'r' })),   PLEK_REDEN_VRAGENLIJST);
  assert.equal(plekReden(basis({ call_status: ' Bevestigd ' })),    PLEK_REDEN_BEVESTIGD);
  assert.equal(plekReden(basis()),                                  PLEK_REDEN_VRAGENLIJST);
  // Wachtlijst + bevestigd is geen plek, dus ook geen bevestiging-reden.
  assert.equal(plekReden(basis({ status: 'wachtlijst', call_status: 'bevestigd' })), PLEK_REDEN_VRAGENLIJST);
  // is_test evenmin.
  assert.equal(plekReden(basis({ is_test: true, call_status: 'bevestigd' })), PLEK_REDEN_VRAGENLIJST);
});
