// tests/opvolging-dagbeeld.test.js
//
// EEN DAG MOET ACHTERAF TE RECONSTRUEREN ZIJN — EN DE MODULE ZEGT ALLEEN WAT
// ZE ZELF WEET.
//
// Twee eisen tegelijk, en de tweede is de scherpste:
//
//   1. Een zoomcall die verzet is blijft hard op zijn oorspronkelijke dag
//      staan, in het grijs, met de bestemming erbij. Verdwijnt hij stil, dan
//      klopt het dagbeeld van gisteren morgen niet meer.
//
//   2. De module praat GHL-statussen niet na als waren het haar eigen oordeel.
//      `no_show`, `completed`, `cancelled` en `in_progress` komen van buiten en
//      zeggen niets over wat Dave heeft vastgelegd. Wat overblijft is het
//      AGENDAFEIT: hij stond hier, hij is verzet, en waarheen als we dat weten.
//
// Een uitkomst tonen doet uitsluitend de afrondchip uit
// _lib/opvolging-call-afgerond.js, en die leest alleen `uitkomst` — de kolom
// die enkel door Daves eigen afrondknop wordt geschreven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  oorspronkelijkeDag, oorspronkelijkeTijd, verzetNaar, agendaFeit, nlDatum,
  dagenVoorAfspraak, knoppenVoor,
} from '../api/_lib/opvolging-dagbeeld.js';
import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

const NU = Date.parse('2026-09-08T12:00:00Z');

// ═══════════════════════════════════════════════════════════════════════════
// DE OORSPRONKELIJKE DAG OVERLEEFT EEN VERZETTING IN DEZELFDE RIJ
// ═══════════════════════════════════════════════════════════════════════════

const SANDER = {
  id: 'a-sander', lead_name: 'sander De groot', status: 'scheduled',
  scheduled_at    : '2026-09-15T13:00:00Z',   // waar hij nu staat
  eerst_gepland_op: '2026-09-07T13:00:00Z',   // waar hij stond
};

test('sander De groot blijft op 7 september staan, ook al staat hij nu op de 15e', () => {
  assert.equal(oorspronkelijkeDag(SANDER), '2026-09-07');
  assert.equal(oorspronkelijkeTijd(SANDER), '15:00');
});

test('en we weten waarheen: verzet naar 15 september', () => {
  assert.deepEqual(verzetNaar(SANDER), { dag: '2026-09-15', tijd: '15:00' });
  assert.equal(agendaFeit(SANDER).label, 'verzet naar 15 september om 15:00');
  assert.equal(agendaFeit(SANDER).doorgehaald, true);
});

test('zonder de kolom valt hij terug op scheduled_at — en dan is de dag weg', () => {
  // Geen leugen maar een beperking, en het endpoint meldt hem als zodanig.
  const zonder = { ...SANDER, eerst_gepland_op: null };
  assert.equal(oorspronkelijkeDag(zonder), '2026-09-15');
  assert.equal(verzetNaar(zonder), null);
});

test('een afspraak die nooit verzet is levert geen bestemming op', () => {
  const stil = { id: 'x', scheduled_at: '2026-09-08T09:00:00Z', eerst_gepland_op: '2026-09-08T09:00:00Z' };
  assert.equal(verzetNaar(stil), null);
  assert.equal(agendaFeit(stil).verzet, false);
});

test('de datum staat er in gewone taal, en het jaar alleen als het afwijkt', () => {
  assert.equal(nlDatum('2026-09-15', NU), '15 september');
  assert.equal(nlDatum('2027-01-04', NU), '4 januari 2027');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE GRENS: GEEN LABEL UIT EEN STATUS
// ═══════════════════════════════════════════════════════════════════════════

const opDag = (status) => ({
  id: 's-' + status, lead_name: 'Iemand', status,
  scheduled_at: '2026-09-08T09:00:00Z', eerst_gepland_op: '2026-09-08T09:00:00Z',
});

test('no_show, completed, cancelled en in_progress leveren GEEN label op', () => {
  // Dit is Maxims grens, letterlijk. Een regel met 'niet gekomen' erop
  // suggereert een uitkomst die niemand hier heeft opgeschreven — die status is
  // van buiten gezet en kan door iedereen gezet zijn.
  for (const status of ['no_show', 'noshow', 'completed', 'cancelled', 'canceled', 'in_progress', 'scheduled', 'verwijderd']) {
    const f = agendaFeit(opDag(status));
    assert.equal(f.label, null, status + ' krijgt een label: ' + f.label);
    assert.equal(f.doorgehaald, false, status + ' wordt doorgehaald');
    assert.equal(f.verzet, false, status + ' telt als verzet');
  }
});

test('een onbekende status levert ook geen label op', () => {
  // De oude versie meldde 'status onbekend (…)'. Ook dat is een uitspraak over
  // een waarde die van buiten komt, en dus weg.
  assert.equal(agendaFeit(opDag('iets_nieuws')).label, null);
});

test('alleen een verzetting spreekt nog, en dan als agendafeit', () => {
  // Twee bronnen: onze eigen kolom (mét bestemming), en de twee statussen die
  // letterlijk zeggen dat deze afspraak hier niet meer doorgaat (zonder).
  assert.equal(agendaFeit(SANDER).label, 'verzet naar 15 september om 15:00');
  assert.equal(agendaFeit(opDag('verplaatst')).label, 'verzet');
  assert.equal(agendaFeit(opDag('wacht_op_reschedule')).label, 'verzet');
});

test('op de NIEUWE dag is de verzetting geen bijzonderheid meer', () => {
  const f = agendaFeit(SANDER, { negeerVerplaatsing: true });
  assert.equal(f.label, null);
  assert.equal(f.doorgehaald, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// TWEE DAGEN VOOR ÉÉN AFSPRAAK
// ═══════════════════════════════════════════════════════════════════════════

test('een verplaatste afspraak staat op BEIDE dagen', () => {
  // Op de 15e vindt hij écht plaats. Zou hij alleen op de 7e staan, dan
  // verdween hij van de dag waarop hij gebeurt — hetzelfde gat, andersom.
  const dagen = dagenVoorAfspraak(SANDER);
  assert.deepEqual(dagen.map((d) => d.dag), ['2026-09-07', '2026-09-15']);
  assert.equal(dagen[0].feit.label, 'verzet naar 15 september om 15:00');
  assert.equal(dagen[1].feit.label, null);
  assert.equal(dagen[1].verzet_van, '2026-09-07');
});

test('een rij die nergens meer doorgaat krijgt geen tweede dag', () => {
  // Plaatsing, geen label: een geannuleerde rij ergens NIET tekenen doet geen
  // uitspraak; er 'geannuleerd' bij zetten wel.
  const dood = { ...SANDER, status: 'cancelled' };
  assert.deepEqual(dagenVoorAfspraak(dood).map((d) => d.dag), ['2026-09-07']);
});

test('een afspraak die niet verplaatst is levert precies een dag op', () => {
  assert.equal(dagenVoorAfspraak(opDag('scheduled')).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// GRIJS IS NIET ONAANRAAKBAAR
// ═══════════════════════════════════════════════════════════════════════════

test('een no-show blijft afrondbaar — dat is de hele reden dat hij er staat', () => {
  // Mehran en Sebastian kregen op 9 september no_show en waren uit beeld
  // voordat iemand er iets mee kon. Ze zijn niet vergeten door nalatigheid;
  // het scherm toonde ze niet meer.
  const k = knoppenVoor({ ...opDag('no_show'), lead_phone: '+316' }, NU);
  assert.equal(k.afronden, true);
  assert.equal(k.bellen, true);
});

test('ook een geannuleerde afspraak houdt zijn knoppen', () => {
  // Die status is niet ons oordeel. Hem gebruiken om Dave een handeling te
  // ontnemen is dezelfde fout als hem als label tonen — alleen stiller, want
  // een knop die er niet is valt niemand op.
  const k = knoppenVoor({ ...opDag('cancelled'), lead_phone: '+316' }, NU);
  assert.equal(k.afronden, true);
  assert.equal(k.bellen, true);
});

test('op de OUDE dag van een verzette afspraak hoort geen afrondknop', () => {
  // Het enige geval. De uitkomst hoort bij de nieuwe datum, anders legt Dave
  // een uitkomst vast op een call die gewoon verzet is.
  const k = knoppenVoor({ ...SANDER, lead_phone: '+316' }, NU);
  assert.equal(k.afronden, false);
  assert.equal(k.bellen, false);
  assert.equal(k.zoom, false);
});

test('op de NIEUWE dag van diezelfde afspraak wel', () => {
  const k = knoppenVoor({ ...SANDER, lead_phone: '+316' }, NU, { opNieuweDag: true });
  assert.equal(k.afronden, true);
  assert.equal(k.bellen, true);
});

test('de Zoom-link verdwijnt zodra de call geweest is — dat is de klok', () => {
  const straks = { ...opDag('scheduled'), scheduled_at: '2026-09-08T15:00:00Z', zoom_join_url: 'https://z' };
  const net    = { ...opDag('scheduled'), scheduled_at: '2026-09-08T09:00:00Z', zoom_join_url: 'https://z' };
  assert.equal(knoppenVoor(straks, NU).zoom, true);
  assert.equal(knoppenVoor(net, NU).zoom, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// DRIE LIJSTEN, MET OPZET
// ═══════════════════════════════════════════════════════════════════════════

const DAG = '2026-09-07';
const AFSPRAKEN = [
  SANDER,
  { id: 'a2', lead_name: 'Blijft staan', status: 'scheduled', scheduled_at: DAG + 'T07:00:00Z', eerst_gepland_op: DAG + 'T07:00:00Z' },
  { id: 'a3', lead_name: 'Afgezegd',     status: 'cancelled', scheduled_at: DAG + 'T08:00:00Z', eerst_gepland_op: DAG + 'T08:00:00Z' },
  { id: 'a4', lead_name: 'Niet gekomen', status: 'no_show',   scheduled_at: DAG + 'T09:00:00Z', eerst_gepland_op: DAG + 'T09:00:00Z' },
];

test('het dagbeeld toont ALLES wat voor die dag stond', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  assert.deepEqual(dag.gepland.map((g) => g.naam),
    ['Blijft staan', 'Afgezegd', 'Niet gekomen', 'sander De groot']);
});

test('en alleen de verzette regel draagt een label', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  const metLabel = dag.gepland.filter((g) => g.label);
  assert.deepEqual(metLabel.map((g) => g.naam), ['sander De groot']);
  assert.equal(metLabel[0].label, 'verzet naar 15 september om 15:00');
  // En de andere drie worden dus ook niet doorgehaald.
  assert.deepEqual(dag.gepland.filter((g) => g.doorgehaald).map((g) => g.naam), ['sander De groot']);
});

test('maar BEZET blijft smal — anders blokkeert een afzegging voorgoed een slot', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  assert.deepEqual(dag.bezet.map((b) => b.naam), ['Blijft staan']);
});

test('een geannuleerd moment blijft vrij boekbaar', () => {
  const [dag] = voegAgendaSamen({
    slots: [{ date: DAG, times: ['10:00'] }],
    afspraken: [{ id: 'x', lead_name: 'Afgezegd', status: 'cancelled',
      scheduled_at: DAG + 'T08:00:00Z', eerst_gepland_op: DAG + 'T08:00:00Z' }],
    van: DAG, tot: DAG, nuMs: NU,
  });
  assert.deepEqual(dag.vrij.map((v) => v.tijd), ['10:00']);
  assert.equal(dag.gepland.length, 1, 'hij staat wél in het dagbeeld');
});

test('een verzette afspraak blokkeert zijn NIEUWE moment, niet zijn oude', () => {
  const [zeven] = voegAgendaSamen({ slots: [], afspraken: [SANDER], van: DAG, tot: DAG, nuMs: NU });
  assert.equal(zeven.bezet.length, 0);
  assert.equal(zeven.gepland.length, 1);

  const [vijftien] = voegAgendaSamen({ slots: [], afspraken: [SANDER], van: '2026-09-15', tot: '2026-09-15', nuMs: NU });
  assert.deepEqual(vijftien.bezet.map((b) => b.tijd), ['15:00']);
});

test('de agenda stuurt de knoppen mee, per regel', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: AFSPRAKEN, van: DAG, tot: DAG, nuMs: NU });
  const sander = dag.gepland.find((g) => g.naam === 'sander De groot');
  const nietGekomen = dag.gepland.find((g) => g.naam === 'Niet gekomen');
  assert.equal(sander.knoppen.afronden, false);
  assert.equal(nietGekomen.knoppen.afronden, true);
});

test('de afrondchip reist mee in het dagbeeld', () => {
  // Het dagbeeld vervangt bezet+afgerond in het callsblok, dus zonder dit veld
  // verdwijnt de winst van de vorige stap zodra deze erin gaat.
  const [dag] = voegAgendaSamen({
    slots: [],
    afspraken: [{ ...AFSPRAKEN[3], uitkomst: 'sale', uitkomst_op: '2026-09-07T10:00:00Z' }],
    van: DAG, tot: DAG, nuMs: NU,
  });
  assert.equal(dag.gepland[0].afrond.toon, 'uitkomst');
  assert.equal(dag.gepland[0].afrond.vastgelegd.label, 'klant geworden');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE PROEFRIJEN VAN 8 SEPTEMBER
// ═══════════════════════════════════════════════════════════════════════════

const ACHT = '2026-09-08';
const MET_PROEF = [
  { id: 'p1', lead_name: 'jeffrey-test', status: 'scheduled', is_test: true,
    scheduled_at: ACHT + 'T08:30:00Z', eerst_gepland_op: ACHT + 'T08:30:00Z' },
  { id: 'p2', lead_name: 'jef testo', status: 'scheduled', is_test: true,
    scheduled_at: ACHT + 'T12:00:00Z', eerst_gepland_op: ACHT + 'T12:00:00Z' },
  { id: 'e1', lead_name: 'Martin', status: 'completed', is_test: false,
    scheduled_at: ACHT + 'T08:00:00Z', eerst_gepland_op: ACHT + 'T08:00:00Z' },
];

test('proefrijen staan nergens in het dagbeeld', () => {
  const [dag] = voegAgendaSamen({ slots: [], afspraken: MET_PROEF, van: ACHT, tot: ACHT, nuMs: NU });
  assert.deepEqual(dag.gepland.map((g) => g.naam), ['Martin']);
});

test('en ze houden ook geen moment bezet', () => {
  const [dag] = voegAgendaSamen({
    slots: [{ date: ACHT, times: ['10:30', '14:00'] }],
    afspraken: MET_PROEF, van: ACHT, tot: ACHT, nuMs: NU,
  });
  assert.deepEqual(dag.vrij.map((v) => v.tijd), ['10:30', '14:00']);
});

test('zonder de kolom filtert er niets weg — het beeld is dan als voorheen', () => {
  // Draait de migratie nog niet, dan is is_test overal undefined. Dan hoort het
  // dagbeeld gewoon te werken, mét de proefrijen erin, en meldt het endpoint
  // dát ze er tussen staan.
  const zonder = MET_PROEF.map(({ is_test, ...rest }) => rest);
  const [dag] = voegAgendaSamen({ slots: [], afspraken: zonder, van: ACHT, tot: ACHT, nuMs: NU });
  assert.equal(dag.gepland.length, 3);
});

test('er wordt NIET op een naampatroon gefilterd', () => {
  // De eerste echte klant die Testerink heet moet gewoon in Daves dag staan.
  // Een naampatroon is een gok die zich voordoet als een regel.
  const [dag] = voegAgendaSamen({
    slots: [],
    afspraken: [{ id: 'k', lead_name: 'Tessa Testerink', status: 'scheduled', is_test: false,
      scheduled_at: ACHT + 'T08:00:00Z', eerst_gepland_op: ACHT + 'T08:00:00Z' }],
    van: ACHT, tot: ACHT, nuMs: NU,
  });
  assert.deepEqual(dag.gepland.map((g) => g.naam), ['Tessa Testerink']);
});
