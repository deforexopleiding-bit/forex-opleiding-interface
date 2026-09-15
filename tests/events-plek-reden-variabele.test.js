// tests/events-plek-reden-variabele.test.js
//
// "TOP — JE VRAGENLIJST IS BINNEN" NAAR IEMAND DIE NOOIT EEN VRAGENLIJST INVULDE.
//
// De bevestigingsmail van de automatisatie "Bevestiging aanmelding" opent met:
//   "Top — je vragenlijst is binnen en daarmee staat je plek voor de
//    {{event.titel}} op {{event.datum}} nu definitief vast!"
//
// Maxim (15 sep 2026): wie wij telefonisch bevestigen, krijgt diezelfde mail.
// Voor hem klopt die eerste zin niet. {{attendee.plek_reden}} vult de reden in
// waarom de plek vaststaat, zodat één template beide gevallen dekt:
//   "Top — {{attendee.plek_reden}} en daarmee staat je plek ... nu definitief vast!"
//
// De WhatsApp-template bevestiging_aanmelding is al neutraal ("... is
// bevestigd") en heeft dit niet nodig.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveVariableValue, getVariableByKey, resolveVariables, AVAILABLE_VARIABLES,
} from '../api/_lib/template-variables.js';
import { isPlekBezet, heeftVragenlijst } from '../api/_lib/plek-bezet.js';

const AR  = '11111111-2222-3333-4444-555555555555';
const red = (attendee) => resolveVariableValue('attendee.plek_reden', { attendee });

const basis = (extra) => ({
  id: 'att-1', event_id: 'ev-1', status: 'aangemeld',
  assessment_response_id: null, is_test: false, call_status: null, ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE UITKOMSTEN
// ═══════════════════════════════════════════════════════════════════════════

test('vragenlijst ingevuld -> "je vragenlijst is binnen"', () => {
  assert.equal(red(basis({ assessment_response_id: AR })), 'je vragenlijst is binnen');
  // Ook als hij daarnaast bevestigd is: de vragenlijst is de eerste reden.
  assert.equal(red(basis({ assessment_response_id: AR, call_status: 'bevestigd' })), 'je vragenlijst is binnen');
});

test('plek via belstatus bevestigd -> "je hebt je deelname bevestigd"', () => {
  assert.equal(red(basis({ call_status: 'bevestigd' })), 'je hebt je deelname bevestigd');
  assert.equal(red(basis({ status: 'aanwezig', call_status: 'bevestigd' })), 'je hebt je deelname bevestigd');
  // Vrije text-kolom: hoofdletters en spaties mogen het antwoord niet kantelen.
  assert.equal(red(basis({ call_status: ' Bevestigd ' })), 'je hebt je deelname bevestigd');
});

test('geen van beide -> de fallback is het huidige gedrag', () => {
  // Deze variabele hoort alleen in berichten die pas gaan zodra de plek
  // vaststaat, dus dit geval zou niet mogen voorkomen. Gebeurt het tóch, dan
  // is de bestaande zin het minst verrassende antwoord — en zeker geen gat
  // midden in een zin.
  for (const cs of [null, '', 'geen_gehoor', 'komt_niet', 'voicemail']) {
    assert.equal(red(basis({ call_status: cs })), 'je vragenlijst is binnen', String(cs));
  }
  // Ook wie bevestigd is maar op de wachtlijst staat (geen plek) valt hier.
  assert.equal(red(basis({ status: 'wachtlijst', call_status: 'bevestigd' })), 'je vragenlijst is binnen');
});

test('zonder attendee-context blijft het leeg, zoals elke andere attendee.*-key', () => {
  assert.equal(resolveVariableValue('attendee.plek_reden', {}), '');
  assert.equal(resolveVariableValue('attendee.plek_reden', { attendee: null }), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE REGISTRATIE — anders is de key onzichtbaar in de editor en valt hij
// buiten buildPositionalMapping bij een Meta-template.
// ═══════════════════════════════════════════════════════════════════════════

test('de variabele staat in AVAILABLE_VARIABLES met de juiste context-eis', () => {
  const v = getVariableByKey('attendee.plek_reden');
  assert.ok(v, 'key is geregistreerd');
  assert.equal(v.category, 'attendee');
  assert.equal(v.requires_context, 'attendee');
  assert.ok(v.label && v.example);
  assert.equal(AVAILABLE_VARIABLES.filter((x) => x.key === 'attendee.plek_reden').length, 1);
});

test('de zin uit de mail rendert voor beide gevallen', () => {
  const zin = 'Top — {{attendee.plek_reden}} en daarmee staat je plek nu definitief vast!';

  const metLijst = resolveVariables(zin, null, { attendee: basis({ assessment_response_id: AR }) });
  assert.equal(metLijst.text, 'Top — je vragenlijst is binnen en daarmee staat je plek nu definitief vast!');
  assert.deepEqual(metLijst.warnings, [], 'de key is bekend, dus geen waarschuwing');

  const viaBel = resolveVariables(zin, null, { attendee: basis({ call_status: 'bevestigd' }) });
  assert.equal(viaBel.text, 'Top — je hebt je deelname bevestigd en daarmee staat je plek nu definitief vast!');

  // Ook positioneel (zoals een Meta-template hem na buildPositionalMapping ziet).
  const positioneel = resolveVariables('Top — {{1}} en daarmee staat je plek nu definitief vast!',
    { 1: 'attendee.plek_reden' }, { attendee: basis({ call_status: 'bevestigd' }) });
  assert.equal(positioneel.text, 'Top — je hebt je deelname bevestigd en daarmee staat je plek nu definitief vast!');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE PURE MODULE — waarom de regel daar staat en niet in event-registration
// ═══════════════════════════════════════════════════════════════════════════

test('plek-bezet.js is importeerbaar zonder databank-omgeving', async () => {
  // template-variables.js bouwt met opzet geen Supabase-client op module-niveau.
  // Zou de regel uit event-registration.js komen, dan sleepte elke lezer
  // supabaseAdmin + webflow-client mee (en webflow-client importeert
  // event-registration terug). Vandaar een pure module zonder imports.
  const bron = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../api/_lib/plek-bezet.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(bron, /^\s*import\s/m, 'plek-bezet.js heeft geen enkele import');
});

test('heeftVragenlijst en isPlekBezet zijn twee verschillende vragen', () => {
  // De eerste is letterlijk "de vragenlijst is ingevuld" (de kolom Vragenlijst,
  // de teller vragenlijst_ingevuld, de tekst van deze mail); de tweede is de
  // capaciteitsregel. Ze mogen niet naar elkaar toe kruipen.
  const bevestigd = basis({ call_status: 'bevestigd' });
  assert.equal(heeftVragenlijst(bevestigd), false);
  assert.equal(isPlekBezet(bevestigd), true);

  const metLijst = basis({ assessment_response_id: AR });
  assert.equal(heeftVragenlijst(metLijst), true);
  assert.equal(isPlekBezet(metLijst), true);
});

test('event-registration blijft alles her-exporteren', async () => {
  // Bestaande imports (een stuk of tien bestanden) halen de regel nog altijd
  // uit event-registration.js. Die her-export mag niet stilletjes wegvallen.
  const m = await import('../api/_lib/event-registration.js');
  for (const naam of ['isPlekBezet', 'heeftVragenlijst', 'applyPlekBezetFilter',
                      'normalizeCallStatus', 'CONFIRMED_STATUSES',
                      'PLEK_BEZET_CALL_STATUS', 'PLEK_BEZET_OR_FILTER']) {
    assert.ok(naam in m, naam + ' hoort her-geëxporteerd te zijn');
  }
});
