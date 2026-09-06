// tests/opvolging-zoomuitkomsten.test.js
//
// Q — twee van de vier knoppen achter 'Afronden' lieten geen spoor na.
//
// 'Klant geworden' toonde alleen een sluitknop en schreef niets. 'Geen
// interesse' vroeg Dave om een reden en gooide die tekst weg bij het sluiten.
// Er komt een rapportagemodule over Daves werk, en die zou nul sales tonen en
// bij elke gewonnen deal 'geen uitkomst geregistreerd' — het rapport zou hem
// beschuldigen van werk dat hij wél gedaan heeft.
//
// ÉÉN ADMINISTRATIE. De knoppen schrijven door naar de bestaande uitkomstmotor.
// Er komt geen derde woordenlijst bij; de twee bestaande (cockpit en
// follow-up-outcomes.js) blijven onaangeraakt — zie het waarschuwingsblok in
// api/follow-up-appointment-outcome.js met het incident van 20 mei.
//
// WAT DEZE TESTS BEWAKEN:
//   1. welk outcome er per knop vertrekt;
//   2. dat GEEN van die drie een nieuwe follow_up_lead veroorzaakt;
//   3. dat een mislukte uitkomst ZICHTBAAR wordt in plaats van stil;
//   4. dat de motor zonder `note` byte voor byte doet wat hij deed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW   = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE  = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');
const MOTOR  = join(ROOT, 'api/follow-up-appointment-outcome.js');

/** De view, met een post() die vastlegt wat er vertrekt. */
function laadView() {
  const verzoeken = [];
  const meldingen = [];
  let faal = null;
  const window = {
    DFO: { VIEWS: {}, S: { tab: 'Vandaag' }, render() {} }, KV_V2: { helpers: {} },
    KV: {
      authedJson: async (url, opties) => {
        verzoeken.push({ url, body: opties && opties.body ? JSON.parse(opties.body) : null });
        if (faal && faal(url)) { const e = new Error(faal(url)); throw e; }
        return { success: true };
      },
    },
    alert: (t) => { meldingen.push(String(t)); },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, querySelector: () => null,
                head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    alert: window.alert,
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set, Map, Error, Promise,
  });
  runInContext(readFileSync(BADGE, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  return { window, verzoeken, meldingen,
           H: window.__opvUitkomstHelpers,
           zetFaal: (fn) => { faal = fn; } };
}

const call = (over) => ({ naam: 'Jan Peeters', telefoon: '+32470123456',
  appointment_id: '11111111-2222-4333-8444-555555555555',
  start: '2026-09-06T10:00:00Z', ...over });

const uitkomstVerzoek = (v) => v.find((r) => r.url.includes('follow-up-appointment-outcome'));

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WELK OUTCOME VERTREKT ER PER KNOP
// ═══════════════════════════════════════════════════════════════════════════

test('klant geworden wordt sale', async () => {
  const w = laadView();
  const r = await w.H.schrijfCallUitkomst('klant_geworden', call(), '');
  assert.equal(r.ok, true);
  assert.equal(uitkomstVerzoek(w.verzoeken).body.outcome, 'sale');
});

test('geen interesse wordt wilt_niet_meer, met Daves reden erbij', async () => {
  const w = laadView();
  const r = await w.H.schrijfCallUitkomst('geen_interesse', call(), 'vindt het te duur');
  assert.equal(r.ok, true);
  const b = uitkomstVerzoek(w.verzoeken).body;
  assert.equal(b.outcome, 'wilt_niet_meer');
  assert.equal(b.note, 'vindt het te duur');
});

test('wil nog beslissen wordt gesprek_gehad', async () => {
  const w = laadView();
  const r = await w.H.schrijfCallUitkomst('wil_nog_beslissen', call(), 'twijfelt over de tijd');
  assert.equal(r.ok, true);
  assert.equal(uitkomstVerzoek(w.verzoeken).body.outcome, 'gesprek_gehad');
});

test('no-show schrijft NIETS door, en dat is met opzet', async () => {
  // Het outcome no_show maakt een nieuwe follow_up_lead met terugbel over twee
  // uur, en Opvolging zet die persoon vandaag al terug in de lijst. Diezelfde
  // dubbeling die we bij 'wil nog beslissen' vermijden.
  const w = laadView();
  const r = await w.H.schrijfCallUitkomst('no_show', call(), '');
  assert.equal(r, null);
  assert.equal(uitkomstVerzoek(w.verzoeken), undefined, 'er hoort niets te vertrekken');
});

test('de mapping bevat precies drie knoppen', () => {
  const w = laadView();
  assert.deepEqual(Object.keys(w.H.CALL_UITKOMST).sort(),
    ['geen_interesse', 'klant_geworden', 'wil_nog_beslissen']);
  assert.equal(w.H.outcomeVoorUitkomst('no_show'), null);
  assert.equal(w.H.outcomeVoorUitkomst('iets_anders'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · GEEN VAN DE DRIE MAAKT EEN NIEUWE follow_up_lead
// ═══════════════════════════════════════════════════════════════════════════

test('de drie gekozen outcomes roepen createFollowupLead niet aan', () => {
  // Dit is de reden dat het gesprek_gehad is en geen terugbel of later_opnieuw:
  // die maken een lead in het oude systeem, terwijl Opvolging voor diezelfde
  // persoon al een kaart maakt. Dan staat dezelfde lead in twee modules op Dave
  // te wachten.
  const b = readFileSync(MOTOR, 'utf8');
  const w = laadView();
  for (const outcome of Object.values(w.H.CALL_UITKOMST)) {
    const i = b.indexOf("outcome === '" + outcome + "'");
    assert.ok(i > 0, 'de motor hoort ' + outcome + ' te kennen');
    // Tot de volgende tak: daarbinnen mag geen lead-aanmaak staan.
    const eind = b.indexOf('} else if (outcome ===', i + 10);
    const tak = b.slice(i, eind > 0 ? eind : i + 600);
    assert.ok(!/createFollowupLead/.test(tak), outcome + ' maakt een follow_up_lead aan');
  }
});

test('de drie outcomes die dat WEL doen staan er niet in', () => {
  // Een test die alleen bewijst dat onze drie het niet doen kan slagen doordat
  // niemand het doet. Deze legt vast dat het verschil echt bestaat.
  const b = readFileSync(MOTOR, 'utf8');
  for (const outcome of ['no_show', 'later_opnieuw', 'terugbel']) {
    const i = b.indexOf("outcome === '" + outcome + "'");
    const eind = b.indexOf('} else if (outcome ===', i + 10);
    const tak = b.slice(i, eind > 0 ? eind : i + 900);
    assert.match(tak, /createFollowupLead/, outcome + ' hoort er juist wél een te maken');
  }
  const w = laadView();
  for (const gevaarlijk of ['no_show', 'later_opnieuw', 'terugbel']) {
    assert.ok(!Object.values(w.H.CALL_UITKOMST).includes(gevaarlijk),
      gevaarlijk + ' hoort niet in de mapping te staan');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · EEN MISLUKTE UITKOMST WORDT ZICHTBAAR, NIET STIL
// ═══════════════════════════════════════════════════════════════════════════

test('zonder appointment_id vertrekt er niets, en het is geen stilte', async () => {
  const w = laadView();
  const r = await w.H.schrijfCallUitkomst('klant_geworden', call({ appointment_id: null }), '');
  assert.equal(r.ok, false);
  assert.equal(r.reden, 'geen_afspraak');
  assert.match(r.uitleg, /geen afspraak-id/);
  assert.equal(uitkomstVerzoek(w.verzoeken), undefined);
});

test('een onbereikbare motor levert een zichtbare melding op', async () => {
  const w = laadView();
  w.zetFaal((url) => url.includes('follow-up-appointment-outcome') ? 'De brug antwoordde met 503.' : null);
  const r = await w.H.schrijfCallUitkomst('klant_geworden', call(), '');
  assert.equal(r.ok, false);
  assert.equal(r.reden, 'motor');
  assert.match(r.uitleg, /503/);
});

test('meldUitkomst zegt het hardop bij een mislukking', () => {
  const w = laadView();
  w.H.meldUitkomst({ ok: false, reden: 'motor', uitleg: 'kapot' }, { bewaardHier: true, notitie: 'te duur' });
  assert.equal(w.meldingen.length, 1);
  assert.match(w.meldingen[0], /NIET/);
  assert.match(w.meldingen[0], /kapot/);
  assert.match(w.meldingen[0], /wél bewaard in Opvolging/);
});

test('en waarschuwt extra als de tekst ook hier niet bewaard is', () => {
  const w = laadView();
  w.H.meldUitkomst({ ok: false, reden: 'motor', uitleg: 'kapot' }, { bewaardHier: false, notitie: 'te duur' });
  assert.match(w.meldingen[0], /ook hier is het niet bewaard/);
});

test('bij succes zwijgt hij', () => {
  const w = laadView();
  w.H.meldUitkomst({ ok: true }, { bewaardHier: true, notitie: 'x' });
  w.H.meldUitkomst(null, {});
  assert.equal(w.meldingen.length, 0, 'geen ruis als alles goed ging');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE MOTOR ZONDER `note` DOET WAT HIJ DEED
// ═══════════════════════════════════════════════════════════════════════════
//
// Elke bestaande aanroeper valt in dat pad. Byte voor byte hetzelfde: zelfde
// status, zelfde vaste zin, zelfde GHL-sync.

/** metExtraNote uit de motor, uit de bron gedraaid. */
function laadMetExtraNote() {
  const b = readFileSync(MOTOR, 'utf8');
  const i = b.indexOf('function metExtraNote(');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const eind = b.indexOf('\n}', i) + 2;
  const ctx = createContext({});
  runInContext(b.slice(i, eind) + '\nglobalThis.__f = metExtraNote;', ctx);
  return ctx.__f;
}

test('zonder note is de zin ongewijzigd', () => {
  const f = laadMetExtraNote();
  const vast = 'Geen interesse — call was al gevoerd, GHL/Zoom NIET geannuleerd';
  for (const leeg of [undefined, null, '', '   ', 0, false, {}]) {
    assert.equal(f(vast, leeg), vast, String(leeg));
  }
});

test('met note komt hij erachter, niet ervoor', () => {
  // De cockpit herkent 'Geen interesse' aan het BEGIN van die regel. Die zin
  // vervangen zou dat stilletjes breken.
  const f = laadMetExtraNote();
  const vast = 'Geen interesse — call was al gevoerd, GHL/Zoom NIET geannuleerd';
  const uit = f(vast, 'vindt het te duur');
  assert.ok(uit.startsWith(vast), 'de vaste zin blijft vooraan staan');
  assert.match(uit, /vindt het te duur$/);
});

test('een lange note wordt begrensd', () => {
  const f = laadMetExtraNote();
  const uit = f('vast', 'x'.repeat(2000));
  assert.ok(uit.length < 600);
});

test('note raakt de status en de GHL-sync niet aan', () => {
  // De parameter komt op precies één plek binnen: bij het schrijven van de
  // notitie. Nergens anders.
  const b = readFileSync(MOTOR, 'utf8');
  const code = b.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.equal((code.match(/body\.note/g) || []).length, 1);
  assert.match(code, /appendApptNote\(appointmentId, metExtraNote\(noteText, body\.note\)\)/);
});

test('de twee woordenlijsten zijn niet aangeraakt', () => {
  // De hele reden dat we aanhaken en niet consolideren. Zie het incident van
  // 20 mei in het waarschuwingsblok.
  const b = readFileSync(MOTOR, 'utf8');
  const i = b.indexOf('const OUTCOMES = new Set([');
  const blok = b.slice(i, b.indexOf(']);', i));
  assert.deepEqual(
    (blok.match(/'[a-z_]+'/g) || []).map((x) => x.replace(/'/g, '')).sort(),
    ['annuleren', 'gesprek_gehad', 'later_opnieuw', 'niet_geschikt', 'no_show',
     'sale', 'terugbel', 'verzetten', 'wilt_niet_meer'].sort());
  assert.match(b, /NIET consolideren zonder aparte/, 'de waarschuwing hoort te blijven staan');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DAVES REDEN BLIJFT AAN ONZE KANT, EN KRIJGT GEEN VERWIJT
// ═══════════════════════════════════════════════════════════════════════════

test('geen interesse bewaart de reden in een direct gearchiveerde kaart', () => {
  const b = readFileSync(VIEW, 'utf8');
  const i = b.indexOf("if (uitkomst === 'geen_interesse')");
  const blok = b.slice(i, i + 1600);
  assert.match(blok, /direct_archiveren: true/);
  assert.match(blok, /archief_reden\s*:\s*notitie/);
  assert.match(blok, /reden_code : 'zoom_geen_interesse'/);
});

test('en dat gebeurt ook als de motor faalt', () => {
  // De volgorde is het bewijs: eerst de uitkomst proberen, dan hoe dan ook
  // bewaren. Zou het bewaren áchter een geslaagde motor-call staan, dan gaat
  // Daves tekst alsnog verloren op precies het moment dat het misgaat.
  const b = readFileSync(VIEW, 'utf8');
  const i = b.indexOf("if (uitkomst === 'geen_interesse')");
  const blok = b.slice(i, i + 1600);
  const uitkomst = blok.indexOf('schrijfCallUitkomst(');
  const bewaren = blok.indexOf("post('/api/opvolging-taak-create'");
  assert.ok(uitkomst > 0 && bewaren > uitkomst, 'eerst proberen, dan bewaren');
  assert.ok(!/if \(res\.ok\)[\s\S]{0,80}post\('\/api\/opvolging-taak-create'/.test(blok),
    'het bewaren hangt niet aan het slagen van de motor');
});

test('het endpoint eist een reden bij direct archiveren', () => {
  // Een dichte kaart zonder reden is precies de lege huls waar we vanaf willen.
  const b = readFileSync(join(ROOT, 'api/opvolging-taak-create.js'), 'utf8');
  assert.match(b, /archief_reden is verplicht bij direct_archiveren/);
});

test('zo een kaart krijgt geen rood "te weinig" in het dashboard', () => {
  // Een gearchiveerde kaart met nul pogingen kreeg daar 'te weinig'. Voor
  // iemand die tijdens de call zelf nee zei is dat een verwijt voor iets waar
  // niets aan te doen viel — precies de onterechte beschuldiging die deze hele
  // wijziging moet voorkomen.
  const b = readFileSync(VIEW, 'utf8');
  assert.match(b, /const nvt = a\.reden_code === 'zoom_geen_interesse'/);
  assert.match(b, /n\.v\.t\./);
  const dag = readFileSync(join(ROOT, 'api/opvolging-dag.js'), 'utf8');
  assert.match(dag, /reden_code: t\.reden_code \|\| null/, 'het veld moet ook meekomen');
});

test('een gewone gearchiveerde kaart houdt het oordeel', () => {
  // Een uitzondering die alles vrijstelt is geen uitzondering.
  const b = readFileSync(VIEW, 'utf8');
  const i = b.indexOf("const nvt = a.reden_code === 'zoom_geen_interesse'");
  const blok = b.slice(i, i + 500);
  assert.match(blok, /te weinig/, 'het oordeel blijft bestaan voor de rest');
  assert.match(blok, /ARCHIEF_MIN_DAGEN/);
});
