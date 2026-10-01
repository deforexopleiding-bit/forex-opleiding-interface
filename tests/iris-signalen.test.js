// tests/iris-signalen.test.js
//
// De mentorsignalen uit het LMS.
//
// De keuze die hier vastgepind wordt: het signaaltype is VRIJE TEKST en geen
// enum. De opdracht noemt drie types die er nog niet zijn (uitstel,
// reageert_niet, halt), en de mentormodule wordt parallel gebouwd. Een
// CHECK-constraint zou betekenen dat de synchronisatie breekt op de dag dat er
// een vierde bijkomt — en dat is een stilvallende synchronisatie waar niemand
// iets van merkt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERUGBLIK_DAGEN,
  VOORSTEL_PER_TYPE,
  LMS_BRON,
  LMS_GESLOTEN_STATUSSEN,
  SIGNAAL_KOLOMMEN,
  bronSleutel,
  voorstelVoor,
  vormSignaal,
  filterNieuw,
  haalSignalen,
  haalContactIds,
  haalMentorNamen,
  haalOpeningsnotities,
} from '../api/_lib/iris/signalen.js';
import { readFileSync } from 'node:fs';

// ── de bron-sleutel ─────────────────────────────────────────────────────────

test('de sleutel draagt het bronsysteem', () => {
  assert.equal(bronSleutel('lms', 'abc'), 'lms:abc');
  assert.equal(bronSleutel('crm', 'abc'), 'crm:abc');
});

test('dezelfde id in twee systemen botst niet', () => {
  assert.notEqual(bronSleutel('lms', 'x'), bronSleutel('crm', 'x'));
});

// ── het voorstel bij een type ───────────────────────────────────────────────

test('elk bekend type heeft een voorstel in mensentaal', () => {
  for (const [type, v] of Object.entries(VOORSTEL_PER_TYPE)) {
    assert.ok(v.voorstel && v.voorstel.length > 5, `${type} heeft geen bruikbaar voorstel`);
    assert.ok(v.toelichting && v.toelichting.length > 15, `${type} heeft geen toelichting`);
  }
});

test('de drie types uit de opdracht staan erin', () => {
  for (const t of ['uitstel', 'reageert_niet', 'halt']) {
    assert.ok(VOORSTEL_PER_TYPE[t], `${t} ontbreekt`);
  }
});

test('een ONBEKEND type krijgt een voorstel, niet niets', () => {
  // Een kaart zonder voorstel is een kaart waar niemand iets mee doet.
  const v = voorstelVoor('iets_wat_het_lms_morgen_toevoegt');
  assert.ok(v.voorstel);
  assert.equal(v.onbekend, true);
  assert.match(v.toelichting, /geen fout/);
});

test('een leeg type breekt niets', () => {
  for (const t of ['', null, undefined]) {
    const v = voorstelVoor(t);
    assert.ok(v.voorstel);
    assert.equal(v.onbekend, true);
  }
});

test('hoofdletters in het type maken niet uit', () => {
  assert.equal(voorstelVoor('UITSTEL').voorstel, VOORSTEL_PER_TYPE.uitstel.voorstel);
});

test('"halt" stelt GEEN handeling voor — dat is een gesprek', () => {
  assert.equal(VOORSTEL_PER_TYPE.halt.actie, null);
  assert.match(VOORSTEL_PER_TYPE.halt.toelichting, /gesprek/);
});

test('uitstel noemt de regel over de einddatum', () => {
  // Of de einddatum meeschuift hangt van de reden af: bij ziekte of vakantie
  // wel, bij betaling of geen contact niet.
  assert.match(VOORSTEL_PER_TYPE.uitstel.toelichting, /ziekte|vakantie/);
});

// ── de vorm ─────────────────────────────────────────────────────────────────

/**
 * De ZEVENTIEN kolommen die hlms_signaal echt heeft.
 *
 * Nagemeten op pg_attribute, 1 oktober 2026. Deze lijst is de waarheid in dit
 * bestand; staat een kolomnaam er niet in, dan bestaat hij niet.
 */
const ECHTE_KOLOMMEN = Object.freeze([
  'id', 'onderwerp', 'student_id', 'mentor_id', 'soort', 'zwaarte', 'status',
  'bron', 'bewijs', 'eerste_op', 'laatst_gezien_op', 'mentor_deadline',
  'gesloten_op', 'gesloten_reden', 'oorzaak_weg_op', 'afgehandeld_door', 'uitkomst',
]);

/**
 * Kolommen die in de MIGRATIEBESTANDEN van de LMS-repo staan maar niet in de
 * databank. Die migraties zijn niet gedraaid.
 *
 * Deze lijst bestaat omdat de eerste reparatie van deze bug er precies op
 * uitgleed: `aangemaakt_op` komt uit een migratiebestand, las als een echte
 * kolom, en gaf dezelfde 400 als `created_at`.
 */
const NIET_IN_DE_DATABANK = Object.freeze([
  'created_at', 'aangemaakt_op', 'bak', 'wacht_tot', 'wacht_reden',
  'controle_op', 'voorstel_datum', 'in_behandeling_door', 'in_behandeling_sinds',
  'type', 'signaal_type', 'toelichting', 'omschrijving', 'notitie', 'mentor_naam',
  'gevraagde_actie',
]);

// Een rij zoals hlms_signaal hem echt teruggeeft. Gemeten 1 oktober 2026.
const ECHTE_RIJ = Object.freeze({
  id: 's1',
  onderwerp: 'student',
  student_id: 'stud-1',
  mentor_id: 'uid-seppe',
  soort: 'start_niet_op',
  zwaarte: 'rood',
  status: 'nieuw',
  bron: 'handmatig',
  bewijs: { gemeld_door: 'uid-seppe' },
  eerste_op: '2026-09-20T10:00:00Z',
  laatst_gezien_op: '2026-09-20T10:00:00Z',
  mentor_deadline: null,
  gesloten_op: null,
  gesloten_reden: null,
  oorzaak_weg_op: null,
  afgehandeld_door: null,
  uitkomst: null,
});

test('de proefrij gebruikt precies de kolommen die bestaan', () => {
  // Anders test dit bestand tegen een rij die de databank nooit zo teruggeeft,
  // en dan bewijst groen niets.
  assert.deepEqual(Object.keys(ECHTE_RIJ).sort(), [...ECHTE_KOLOMMEN].sort());
});

test('HET TYPE KOMT UIT `soort`, niet uit `type`', () => {
  // `hlms_signaal.type` bestaat niet. Deze module las die kolom, kreeg undefined
  // en zette er 'onbekend' in -- al zou de 400 op created_at haar nooit zo ver
  // hebben laten komen.
  assert.equal(vormSignaal(ECHTE_RIJ).type, 'start_niet_op');
});

test('HET TIJDSTIP KOMT UIT `eerste_op`', () => {
  // Wanneer het signaal ontstond -- precies de vraag die signaal_op stelt.
  assert.equal(vormSignaal(ECHTE_RIJ).signaal_op, '2026-09-20T10:00:00Z');
});

test('`created_at` levert niets op', () => {
  const s = vormSignaal({ id: 's1', type: 'uitstel', created_at: '2026-09-20T10:00:00Z' });
  assert.equal(s.type, 'onbekend', '`type` hoort niet meer gelezen te worden');
  assert.equal(s.signaal_op, null, '`created_at` bestaat niet');
});

test('`aangemaakt_op` LEVERT OOK NIETS OP', () => {
  // Hier ging de eerste reparatie de mist in. `aangemaakt_op` staat wel in de
  // migratiebestanden van de LMS-repo, maar niet in de databank -- die migraties
  // zijn niet gedraaid. Een rij met alleen aangemaakt_op erin hoort dus geen
  // tijdstempel op te leveren.
  const s = vormSignaal({ id: 's1', soort: 'uitstel', aangemaakt_op: '2026-09-20T10:00:00Z' });
  assert.equal(s.signaal_op, null, '`aangemaakt_op` bestaat niet op hlms_signaal');
});

test('de rest van de vorm blijft wat iris_signalen verwacht', () => {
  const s = vormSignaal(ECHTE_RIJ);
  assert.equal(s.bron_id, 'lms:s1');
  assert.equal(s.bron_systeem, 'dfo_lms');
  assert.equal(s.gevraagde_actie, voorstelVoor('start_niet_op').voorstel);
});

test('naam, notitie en contact komen van BUITEN de rij', () => {
  // hlms_signaal heeft geen mentor_naam en geen toelichting; die staan in
  // hlms_personeel en hlms_signaal_gebeurtenis. En contact_id moest erbij,
  // anders staat de kaart in de databank en nergens op het scherm.
  const s = vormSignaal(ECHTE_RIJ, {
    mentorNaam: 'Seppe',
    toelichting: 'drie keer gebeld, geen antwoord',
    contactId: 'contact-1',
  });
  assert.equal(s.mentor_naam, 'Seppe');
  assert.equal(s.toelichting, 'drie keer gebeld, geen antwoord');
  assert.equal(s.contact_id, 'contact-1');
});

test('zonder die drie is het null en niet undefined', () => {
  // undefined laat PostgREST de kolom weg; null zet hem uitdrukkelijk leeg. Dat
  // verschil zie je pas terug als iemand vraagt waarom een veld "er niet is".
  const s = vormSignaal(ECHTE_RIJ);
  assert.equal(s.mentor_naam, null);
  assert.equal(s.toelichting, null);
  assert.equal(s.contact_id, null);
});

test('een rij zonder soort wordt "onbekend", niet null', () => {
  assert.equal(vormSignaal({ id: 's1' }).type, 'onbekend');
});

test('ZONDER TIJDSTEMPEL BLIJFT HET LEEG, geen "nu"', () => {
  // Er stond een terugval op new Date(). `aangemaakt_op` is NOT NULL in het LMS,
  // dus die terugval kon alleen aanslaan als we de VERKEERDE kolom lazen -- en
  // dan toonde een kaart van drie weken oud zich als verse melding.
  assert.equal(vormSignaal({ id: 's1', soort: 'x' }).signaal_op, null);
});

// ── het verzamelverschil ────────────────────────────────────────────────────

test('wat al bekend is, blijft weg', () => {
  const nieuw = filterNieuw([{ id: 'a' }, { id: 'b' }], new Set(['lms:a']), 'dfo_lms');
  assert.deepEqual(nieuw.map((r) => r.id), ['b']);
});

test('rijen zonder id worden overgeslagen', () => {
  assert.equal(filterNieuw([{ id: 'a' }, {}, null], new Set(), 'dfo_lms').length, 1);
});

test('niets bekend betekent alles nieuw', () => {
  assert.equal(filterNieuw([{ id: 'a' }, { id: 'b' }], null, 'dfo_lms').length, 2);
});

// ── ophalen ─────────────────────────────────────────────────────────────────

test('zonder LMS-koppeling is dat een gemelde reden, geen crash', async () => {
  const r = await haalSignalen({ crmDb: {}, lmsClient: null });
  assert.equal(r.nieuw, 0);
  assert.match(r.fout, /niet geconfigureerd/);
});

test('zonder CRM-client gebeurt er ook niets', async () => {
  const r = await haalSignalen({ crmDb: null, lmsClient: {} });
  assert.equal(r.nieuw, 0);
  assert.ok(r.fout);
});

/**
 * Een nep-client die opschrijft wat er gevraagd werd.
 *
 * Niet alleen "gaf het een fout" maar ook WELKE kolommen en welke filters er
 * langs kwamen. Dat is het hele punt van deze reparatie: de vorige code vroeg om
 * een kolom die niet bestond, en geen enkele test merkte dat.
 */
function nepClient(antwoordPerTabel) {
  const gelogd = [];
  return {
    gelogd,
    from(tabel) {
      const vraag = { tabel, select: null, filters: [], order: null, limiet: null };
      gelogd.push(vraag);
      const antwoord = antwoordPerTabel[tabel] || { data: [], error: null };
      const b = {
        select: (k) => { vraag.select = k; return b; },
        eq: (k, v) => { vraag.filters.push(['eq', k, v]); return b; },
        gte: (k, v) => { vraag.filters.push(['gte', k, v]); return b; },
        not: (k, op, v) => { vraag.filters.push(['not', k, op, v]); return b; },
        in: (k, v) => { vraag.filters.push(['in', k, v]); return b; },
        contains: (k, v) => { vraag.filters.push(['contains', k, v]); return b; },
        insert: (rij) => { vraag.filters.push(['insert', rij]); return Promise.resolve(antwoord); },
        order: (k, o) => { vraag.order = [k, o]; return b; },
        limit: (n) => { vraag.limiet = n; return Promise.resolve(antwoord); },
        then: (f, g) => Promise.resolve(antwoord).then(f, g),
      };
      return b;
    },
  };
}

test('een LMS dat niet bereikbaar is, legt de post NIET stil', async () => {
  const lms = nepClient({ hlms_signaal: { data: null, error: { message: 'weg' } } });
  const r = await haalSignalen({ crmDb: nepClient({}), lmsClient: lms });
  assert.equal(r.nieuw, 0);
  assert.match(r.fout, /weg/);
  // Geen uitzondering: de aanroeper loopt door.
});

test('geen signalen is geen fout', async () => {
  const lms = nepClient({ hlms_signaal: { data: [], error: null } });
  const r = await haalSignalen({ crmDb: nepClient({}), lmsClient: lms });
  assert.equal(r.opgehaald, 0);
  assert.equal(r.fout, null);
});

// ── de opvraging zelf: de kolomnamen en de twee filters ─────────────────────

async function vraagOp(rijen = []) {
  const lms = nepClient({ hlms_signaal: { data: rijen, error: null } });
  const crm = nepClient({});
  await haalSignalen({ crmDb: crm, lmsClient: lms, nu: new Date('2026-10-01T09:00:00Z') });
  return { lms, crm, vraag: lms.gelogd.find((v) => v.tabel === 'hlms_signaal') };
}

test('DE OPVRAGING NOEMT GEEN ENKELE KOLOM DIE NIET BESTAAT', async () => {
  // Dit is de bug, twee keer. Eerst `created_at` (verzonnen), daarna
  // `aangemaakt_op` (uit een migratiebestand dat niet gedraaid is). Allebei
  // leverden ze elke vijf minuten een 400 in de LMS-logs.
  const { vraag } = await vraagOp();
  const alles = JSON.stringify(vraag);
  for (const k of NIET_IN_DE_DATABANK) {
    assert.ok(!alles.includes(k), `${k} bestaat niet op hlms_signaal en hoort niet in de opvraging`);
  }
});

test('er wordt gefilterd EN gesorteerd op `eerste_op`', async () => {
  const { vraag } = await vraagOp();
  assert.ok(vraag.filters.some((f) => f[0] === 'gte' && f[1] === 'eerste_op'), 'het filter');
  assert.equal(vraag.order[0], 'eerste_op', 'de sortering');
  assert.equal(vraag.order[1].ascending, false, 'nieuwste eerst');
});

test('de kolomlijst is EXACT de zeventien kolommen die bestaan', async () => {
  // Geen select('*'): dan merk je een kolom die verdwijnt pas als er iets anders
  // stukgaat. En geen kolom erbij die alleen in een migratiebestand staat -- dat
  // is precies hoe `aangemaakt_op` erin kwam.
  const { vraag } = await vraagOp();
  assert.equal(vraag.select, SIGNAAL_KOLOMMEN);
  assert.ok(!vraag.select.includes('*'));
  const gevraagd = vraag.select.split(',').map((x) => x.trim()).filter(Boolean);
  assert.deepEqual([...gevraagd].sort(), [...ECHTE_KOLOMMEN].sort(),
    'de kolomlijst hoort gelijk te zijn aan wat pg_attribute teruggaf');
});

test('de niet-bestaande en de echte kolommen overlappen niet', () => {
  // Zou een naam in allebei de lijsten staan, dan zegt dit bestand twee dingen
  // tegelijk en is geen enkele test erop nog betrouwbaar.
  for (const k of NIET_IN_DE_DATABANK) {
    assert.ok(!ECHTE_KOLOMMEN.includes(k), `${k} staat in beide lijsten`);
  }
});

test('DE VLOED: alleen `bron = handmatig` komt mee', async () => {
  // De tabel had ~450 rijen, bijna alles bron = lms_regel (59 open
  // geen_volgende_sessie, 12 open factuur_vervallen). Zonder dit filter stonden
  // er in één keer ruim honderd kaarten in de Post.
  const { vraag } = await vraagOp();
  assert.deepEqual(vraag.filters.find((f) => f[0] === 'eq' && f[1] === 'bron'), ['eq', 'bron', 'handmatig']);
  assert.equal(LMS_BRON, 'handmatig');
});

test('crm_cron komt ook niet mee -- dat zou een kringetje zijn', async () => {
  // Wij schrijven het, wij lezen het. Het filter is `eq handmatig` en niet
  // `not.eq lms_regel`, en dat verschil is precies deze test.
  const { vraag } = await vraagOp();
  const bron = vraag.filters.find((f) => f[1] === 'bron');
  assert.equal(bron[0], 'eq', 'een eq laat crm_cron er automatisch buiten');
});

test('alleen wat nog OPEN staat', async () => {
  const { vraag } = await vraagOp();
  const f = vraag.filters.find((x) => x[0] === 'not' && x[1] === 'status');
  assert.ok(f, 'er hoort een statusfilter te zijn');
  assert.equal(f[2], 'in');
  for (const dicht of LMS_GESLOTEN_STATUSSEN) {
    assert.ok(f[3].includes(dicht), `${dicht} hoort eruit gefilterd te worden`);
  }
});

test('de open statussen van het LMS worden NIET overgeschreven', async () => {
  // hlms_signaal_open_statussen() is in het LMS één functie, zodat de telling en
  // het sluiten daar niet uit elkaar kunnen lopen. Die lijst hier kopiëren zou
  // precies die drift terugbrengen: zet het LMS er een nieuwe OPEN status bij,
  // dan valt die stil weg en komt de kaart nooit aan.
  for (const open of ['nieuw', 'opgepakt', 'wacht_op_mentor', 'on_hold', 'wacht']) {
    assert.ok(!LMS_GESLOTEN_STATUSSEN.includes(open), `${open} staat open en hoort niet in de gesloten lijst`);
  }
  assert.deepEqual([...LMS_GESLOTEN_STATUSSEN], ['afgehandeld', 'auto_gesloten']);
});

test('de drie extra opzoekingen gebeuren per GROEP, niet per rij', async () => {
  // Twee rijen, en toch één opvraging per tabel. Per rij zou bij honderd kaarten
  // driehonderd opvragingen geven binnen het tijdbudget van de cron.
  const rijen = [
    { ...ECHTE_RIJ, id: 's1', mentor_id: 'm1', student_id: 'st1' },
    { ...ECHTE_RIJ, id: 's2', mentor_id: 'm2', student_id: 'st2' },
  ];
  const lms = nepClient({ hlms_signaal: { data: rijen, error: null } });
  const crm = nepClient({});
  await haalSignalen({ crmDb: crm, lmsClient: lms });
  for (const tabel of ['hlms_personeel', 'hlms_signaal_gebeurtenis']) {
    const n = lms.gelogd.filter((v) => v.tabel === tabel).length;
    assert.equal(n, 1, `${tabel} hoort één keer opgevraagd te worden, niet ${n}`);
  }
});

test('de notitie komt uit de tijdlijn met soort geopend', async () => {
  const lms = nepClient({ hlms_signaal: { data: [ECHTE_RIJ], error: null } });
  await haalSignalen({ crmDb: nepClient({}), lmsClient: lms });
  const v = lms.gelogd.find((x) => x.tabel === 'hlms_signaal_gebeurtenis');
  assert.ok(v, 'de tijdlijn hoort gelezen te worden -- hlms_signaal heeft geen toelichting');
  assert.ok(v.filters.some((f) => f[0] === 'eq' && f[1] === 'soort' && f[2] === 'geopend'));
});

test('een mislukte opzoeking blokkeert de kaart NIET', async () => {
  // Alle drie de extra opvragingen zijn fail-zacht: ze maken een kaart beter
  // leesbaar en vindbaar, en geen van drieën mag de reden zijn dat hij wegblijft.
  const lms = nepClient({
    hlms_signaal: { data: [ECHTE_RIJ], error: null },
    hlms_personeel: { data: null, error: { message: 'stuk' } },
    hlms_signaal_gebeurtenis: { data: null, error: { message: 'stuk' } },
    hlms_student: { data: null, error: { message: 'stuk' } },
  });
  const r = await haalSignalen({ crmDb: nepClient({}), lmsClient: lms });
  assert.equal(r.fout, null, 'een mislukte bijzoeking is geen fout van de ronde');
  assert.equal(r.nieuw, 1, 'de kaart komt er gewoon');
});

// ── de terugblik ────────────────────────────────────────────────────────────

test('we kijken een maand terug — lang genoeg voor een traag signaal', () => {
  assert.equal(TERUGBLIK_DAGEN, 30);
});

// ── de koppeling naar een dossier ───────────────────────────────────────────

test('EEN SIGNAAL ZONDER contact_id IS NERGENS ZICHTBAAR', async () => {
  // Dit was de tweede helft van de bug. `iris_signalen` wordt op precies één
  // plek gelezen -- de dossierkaart -- en die filtert op contact_id. Alleen de
  // kolomnamen repareren had betekend dat de kaart aankomt en onzichtbaar blijft.
  const lms = nepClient({
    hlms_signaal: { data: [ECHTE_RIJ], error: null },
    hlms_student: { data: [{ id: 'stud-1', email: 'els@example.com' }], error: null },
  });
  const crm = nepClient({
    iris_contacten: { data: [{ id: 'contact-1' }], error: null },
    iris_signalen: { data: null, error: null },
  });
  const r = await haalSignalen({ crmDb: crm, lmsClient: lms });
  assert.equal(r.nieuw, 1);
  const insert = crm.gelogd.find((v) => v.tabel === 'iris_signalen' && v.filters.some((f) => f[0] === 'insert'));
  const rij = insert.filters.find((f) => f[0] === 'insert')[1];
  assert.equal(rij.contact_id, 'contact-1', 'zonder dit staat de kaart in de databank en op geen enkel scherm');
});

test('bij twee treffers blijft het contact leeg', async () => {
  // Ambiguïteit is geen "kies de eerste". Een kaart aan de verkeerde persoon
  // hangen is erger dan een kaart zonder dossier.
  const lms = nepClient({ hlms_student: { data: [{ id: 'st1', email: 'x@y.nl' }], error: null } });
  const crm = nepClient({ iris_contacten: { data: [{ id: 'c1' }, { id: 'c2' }], error: null } });
  const kaart = await haalContactIds(lms, crm, ['st1']);
  assert.equal(kaart.size, 0);
});

test('bij geen treffer ook', async () => {
  const lms = nepClient({ hlms_student: { data: [{ id: 'st1', email: 'x@y.nl' }], error: null } });
  const crm = nepClient({ iris_contacten: { data: [], error: null } });
  assert.equal((await haalContactIds(lms, crm, ['st1'])).size, 0);
});

test('er wordt NOOIT een contact aangemaakt', async () => {
  // Een student die ons nooit geschreven heeft, hoort geen gespreksdossier te
  // krijgen omdat zijn mentor iets meldde.
  const lms = nepClient({ hlms_student: { data: [{ id: 'st1', email: 'x@y.nl' }], error: null } });
  const crm = nepClient({ iris_contacten: { data: [], error: null } });
  await haalContactIds(lms, crm, ['st1']);
  for (const v of crm.gelogd) {
    assert.ok(!v.filters.some((f) => f[0] === 'insert'), 'haalContactIds hoort alleen te lezen');
  }
});

test('het e-mailadres wordt kleingeschreven opgezocht', async () => {
  // iris_contacten.emails bevat kleine letters; een student met Els@Example.com
  // in het LMS zou anders nooit matchen.
  const lms = nepClient({ hlms_student: { data: [{ id: 'st1', email: 'Els@Example.COM' }], error: null } });
  const crm = nepClient({ iris_contacten: { data: [{ id: 'c1' }], error: null } });
  await haalContactIds(lms, crm, ['st1']);
  const v = crm.gelogd.find((x) => x.tabel === 'iris_contacten');
  assert.deepEqual(v.filters.find((f) => f[0] === 'contains'), ['contains', 'emails', ['els@example.com']]);
});

test('een student zonder e-mailadres wordt overgeslagen', async () => {
  const lms = nepClient({ hlms_student: { data: [{ id: 'st1', email: null }], error: null } });
  const crm = nepClient({ iris_contacten: { data: [{ id: 'c1' }], error: null } });
  assert.equal((await haalContactIds(lms, crm, ['st1'])).size, 0);
  assert.equal(crm.gelogd.length, 0, 'er hoort niet eens gezocht te worden');
});

test('lege invoer vraagt niets op', async () => {
  const lms = nepClient({});
  assert.equal((await haalMentorNamen(lms, [])).size, 0);
  assert.equal((await haalOpeningsnotities(lms, [null, undefined])).size, 0);
  assert.equal((await haalContactIds(lms, nepClient({}), [])).size, 0);
  assert.equal(lms.gelogd.length, 0);
});

test('de oudste geopend-regel wint', async () => {
  // De tijdlijn is alleen-toevoegen, dus de eerste regel is wat de melder zelf
  // schreef. Een latere aanvulling van iemand anders hoort niet op de kaart.
  const lms = nepClient({
    hlms_signaal_gebeurtenis: {
      data: [
        { signaal_id: 's1', soort: 'geopend', tekst: 'eerst dit', op: '2026-09-20T10:00:00Z' },
        { signaal_id: 's1', soort: 'geopend', tekst: 'later dat', op: '2026-09-21T10:00:00Z' },
      ],
      error: null,
    },
  });
  const kaart = await haalOpeningsnotities(lms, ['s1']);
  assert.equal(kaart.get('s1'), 'eerst dit');
});

// ── het contract ────────────────────────────────────────────────────────────

test('het contractdocument noemt de echte kolommen en niet de verzonnen', () => {
  // Het document was een VOORSTEL met gehoopte veldnamen erin. Dat is precies
  // hoe `created_at` in de code belandde.
  const doc = readFileSync(new URL('../docs/iris/lms-signaalcontract.md', import.meta.url), 'utf8');
  for (const echt of ['eerste_op', 'soort', 'bron', 'handmatig', 'hlms_signaal_gebeurtenis', 'hlms_personeel']) {
    assert.ok(doc.includes(echt), `${echt} hoort in het contract te staan`);
  }
  // De volledige kolomlijst hoort erin te staan, zodat de volgende lezer niet
  // alsnog in de migratiebestanden gaat kijken.
  for (const k of ECHTE_KOLOMMEN) {
    assert.ok(doc.includes('`' + k + '`'), `${k} ontbreekt in de kolomlijst van het contract`);
  }
  // En de oude namen mogen alleen nog als FOUT genoemd worden, niet in de tabel
  // van kolommen die Iris gebruikt.
  for (const k of ['created_at', 'aangemaakt_op']) {
    assert.ok(!new RegExp('\\| `' + k + '` \\|').test(doc), `${k} hoort niet in de kolomtabel`);
  }
  assert.ok(/pg_attribute/.test(doc), 'het contract hoort te zeggen waarop gemeten is');
  assert.ok(/repo is geen schema|repo is dus geen schema/i.test(doc),
    'de les waarop de tweede poging uitgleed hoort erin te staan');
});
