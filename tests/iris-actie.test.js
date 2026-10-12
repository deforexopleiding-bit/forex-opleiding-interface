// tests/iris-actie.test.js
//
// De idempotentiesleutel, en de rechten per staptype.
//
// De sleutel is het enige waterdichte antwoord op dubbelklikken. Een
// uitgeschakelde knop is dat niet: het eerste verzoek kan al onderweg zijn
// wanneer de tweede klik komt. Maar dan moet de sleutel wél uit de INHOUD van
// de stap komen en niet uit een toevalsgetal — anders is elke klik uniek en
// beschermt de constraint nergens tegen. Daar gaat het grootste deel van dit
// bestand over.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { RECHT_PER_TYPE, bouwSleutel } from '../api/iris-actie.js';
import { STAPTYPES } from '../api/_lib/iris/opdracht.js';

const OP = new Date('2026-09-21T12:00:00Z');
const BASIS = { type: 'belofte_vastleggen', contactId: 'c1', opdrachtId: 'o1', parameters: { datum: '2026-09-25', bedrag: 450 }, op: OP };

// ── de sleutel ──────────────────────────────────────────────────────────────

test('dezelfde stap geeft dezelfde sleutel', () => {
  assert.equal(bouwSleutel(BASIS), bouwSleutel({ ...BASIS }));
});

test('twee keer klikken op dezelfde knop geeft dezelfde sleutel — dat is de hele bedoeling', () => {
  const eerste = bouwSleutel(BASIS);
  const tweede = bouwSleutel({ ...BASIS, op: new Date('2026-09-21T12:00:05Z') });
  assert.equal(eerste, tweede, 'vijf seconden later mag geen nieuwe sleutel geven');
});

test('de volgorde van de parameters maakt niet uit', () => {
  // JSON.stringify geeft bij een andere invoegvolgorde een andere tekst. Dat
  // zou betekenen dat dezelfde stap soms wél en soms niet herkend wordt.
  const a = bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-25', bedrag: 450 } });
  const b = bouwSleutel({ ...BASIS, parameters: { bedrag: 450, datum: '2026-09-25' } });
  assert.equal(a, b);
});

test('een andere waarde geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-26', bedrag: 450 } }));
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-25', bedrag: 500 } }));
});

test('een andere persoon geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, contactId: 'c2' }));
});

test('een ander staptype geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, type: 'belrij_toevoegen' }));
});

test('dezelfde stap MORGEN mag wel, en krijgt dus een andere sleutel', () => {
  // Iemand morgen opnieuw op de belrij zetten is een geldige handeling. De
  // dag zit daarom in de sleutel; het tijdstip niet.
  const morgen = new Date('2026-09-22T09:00:00Z');
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, op: morgen }));
});

test('een losse stap zonder opdracht botst niet met eentje mét opdracht', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, opdrachtId: null }));
});

test('zonder contact is er nog steeds een bruikbare sleutel', () => {
  const s = bouwSleutel({ ...BASIS, contactId: null });
  assert.ok(s.includes('geen-contact'));
  assert.ok(s.length > 10);
});

test('geneste parameters worden ook stabiel verwerkt', () => {
  const a = bouwSleutel({ ...BASIS, parameters: { a: { x: 1, y: 2 }, b: [1, 2] } });
  const b = bouwSleutel({ ...BASIS, parameters: { b: [1, 2], a: { y: 2, x: 1 } } });
  assert.equal(a, b);
});

test('de sleutel blijft binnen de kolombreedte', () => {
  const groot = {};
  for (let i = 0; i < 200; i++) groot[`veld_met_een_lange_naam_${i}`] = 'waarde'.repeat(20);
  const s = bouwSleutel({ ...BASIS, parameters: groot });
  assert.ok(s.length <= 400, `sleutel van ${s.length} tekens past niet`);
});

test('lege parameters geven een geldige sleutel', () => {
  assert.ok(bouwSleutel({ ...BASIS, parameters: {} }).length > 10);
  assert.ok(bouwSleutel({ ...BASIS, parameters: null }).length > 10);
});

// ── de rechten ──────────────────────────────────────────────────────────────

test('elk staptype heeft een recht — er valt er geen door de mazen', () => {
  for (const t of STAPTYPES) {
    assert.ok(RECHT_PER_TYPE[t], `${t} heeft geen recht en zou dus een 403 geven bij iedereen`);
  }
});

test('elk recht begint met iris.', () => {
  for (const [type, recht] of Object.entries(RECHT_PER_TYPE)) {
    assert.match(recht, /^iris\./, `${type} verwijst naar een recht buiten Iris: ${recht}`);
  }
});

test('versturen vereist het zwaardere recht', () => {
  assert.equal(RECHT_PER_TYPE.wa_versturen, 'iris.versturen');
  assert.equal(RECHT_PER_TYPE.mail_versturen, 'iris.versturen');
});

test('LMS-stappen vereisen het LMS-recht — die raken wat een klant kan', () => {
  assert.equal(RECHT_PER_TYPE.lms_toegang_verlengen, 'iris.lms.acties');
  assert.equal(RECHT_PER_TYPE.lms_uitnodiging, 'iris.lms.acties');
  assert.equal(RECHT_PER_TYPE.lms_on_hold, 'iris.lms.acties');
});

test('de belrij heeft zijn eigen recht', () => {
  assert.equal(RECHT_PER_TYPE.belrij_toevoegen, 'iris.belrij');
});

test('een notitie-achtige stap vereist geen verzendrecht', () => {
  // Iemand op de belrij zetten of een taak maken is geen bericht naar buiten.
  assert.notEqual(RECHT_PER_TYPE.taak_aanmaken, 'iris.versturen');
  assert.notEqual(RECHT_PER_TYPE.factuur_nakijken, 'iris.versturen');
});

test('er staan geen rechten voor stappen die niet bestaan', () => {
  for (const type of Object.keys(RECHT_PER_TYPE)) {
    assert.ok(STAPTYPES.includes(type), `${type} staat bij de rechten maar is geen staptype`);
  }
});

// ── het plan uitvoeren (H1) ─────────────────────────────────────────────────
//
// ── WAT ER MIS WAS ──────────────────────────────────────────────────────────
// Een opdracht met een geldig plan was ONUITVOERBAAR. Drie gaten tegelijk:
// iris-opdracht sloeg het plan op en maakte nooit een iris_acties-rij; het
// scherm had geen Uitvoeren-knop en riep /api/iris-actie nergens aan; en
// volgendeToestand() gaf altijd wacht_op_ok terug. Je kreeg dus een plan te
// zien, status "Wacht op jouw akkoord", en er was niets om op te drukken.
//
// Deze toetsen falen op de code van vóór die fix: `plan_uitvoeren` bestond
// niet en `__irisOpdrachtUitvoeren` ook niet.

const ACTIE_SRC = readFileSync(new URL('../api/iris-actie.js', import.meta.url), 'utf8');
const SCHERM_SRC = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX_SRC = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

/** De tekst van één functie, tot aan de volgende functie op hetzelfde niveau. */
function lijf(src, naam, eind) {
  const i = src.indexOf(naam);
  assert.ok(i > 0, naam + ' hoort te bestaan');
  const j = eind ? src.indexOf(eind, i) : -1;
  return src.slice(i, j > i ? j : undefined);
}

test('er is een actie die het hele plan uitvoert', () => {
  assert.match(ACTIE_SRC, /actie === 'plan_uitvoeren'/);
  assert.match(ACTIE_SRC, /async function planUitvoeren\(req, res, user\)/);
});

test('het scherm heeft een Uitvoeren-knop die daarheen wijst', () => {
  // Dit was het gat: de server kon het al, het scherm wees er niet naar.
  assert.match(SCHERM_SRC, /window\.__irisOpdrachtUitvoeren = async \(id, meeGesprek\) =>/);
  assert.match(SCHERM_SRC, /'\/api\/iris-actie'/);
  assert.match(SCHERM_SRC, /onclick="__irisOpdrachtUitvoeren\('\$\{esc\(o\.id\)\}'\)"/);
  // En de knop staat er alleen als hij ook iets kan.
  assert.match(SCHERM_SRC, /const magUitvoeren = !klaar && !o\.vraag_aan_maxim && planStappen\.length > 0;/);
  // Het scherm hoort een nieuw nummer te hebben, anders laadt de browser de
  // oude kopie en is de knop er voor niemand.
  assert.match(INDEX_SRC, /\.\.\/iris\/iris\.js\?v=20/);
});

test('er wordt NOOIT een naam naar een contact gezocht', () => {
  // Een plan noemt mensen bij naam, niet bij sleutel. De eerste treffer pakken
  // is precies hoe een opvolging op de verkeerde persoon komt te lopen. Het
  // doel komt van de aanroeper, of het komt niet.
  const body = lijf(ACTIE_SRC, 'async function planUitvoeren', '// ── Wat elke stap doet');
  assert.doesNotMatch(body, /iris_contacten/, 'planUitvoeren mag geen contact opzoeken');
  assert.doesNotMatch(body, /\.ilike\(|\.textSearch\(|naam/i);
  assert.match(body, /error: 'doel_onbekend'/, 'weet hij het niet, dan is het een vraag');
});

test('de doel-lijst klopt met wat voerUit echt nodig heeft', () => {
  // Niet verzonnen maar afgelezen: voerUit gooit zelf op een ontbrekend
  // contact. Zou DOEL_NODIG korter zijn dan die lijst, dan valt een plan
  // halverwege om; zou hij langer zijn, dan vraagt Iris om een gesprek dat
  // de stap niet nodig heeft.
  const voer = lijf(ACTIE_SRC, 'async function voerUit(actie, user)');
  for (const type of ['belofte_vastleggen', 'belrij_toevoegen']) {
    assert.match(voer, new RegExp(`${type}[\\s\\S]{0,400}!actie\\.contact_id`), type + ' gooit op geen contact');
  }
  const lijst = lijf(ACTIE_SRC, 'const DOEL_NODIG = Object.freeze(', ');');
  for (const type of ['belofte_vastleggen', 'belrij_toevoegen', 'opvolging_instellen']) {
    assert.ok(lijst.includes(`'${type}'`), type + ' hoort in DOEL_NODIG');
  }
  // Deze twee hebben géén doel nodig: ze maken een taak aan in het bestaande
  // takenbakje en hangen niet aan één persoon.
  for (const type of ['taak_aanmaken', 'factuur_nakijken']) {
    assert.ok(!lijst.includes(`'${type}'`), type + ' hoeft geen doel');
  }
});

test('eerst alle poorten, dan pas de eerste stap', () => {
  // Een plan dat halverwege op een rechtenfout stukloopt, laat de klant met
  // een halve afspraak zitten. Dus: type, rechten en doel voor ALLE stappen
  // nagekeken voordat er één rij wordt klaargezet.
  const body = lijf(ACTIE_SRC, 'async function planUitvoeren', '// ── Wat elke stap doet');
  const iType  = body.indexOf("error: 'onbekende_stap'");
  const iRecht = body.indexOf('RECHT_PER_TYPE[String(stap.type)]');
  const iDoel  = body.indexOf("error: 'doel_onbekend'");
  const iZet   = body.indexOf('await zetKlaar(');
  for (const [naam, i] of [['type', iType], ['rechten', iRecht], ['doel', iDoel], ['klaarzetten', iZet]]) {
    assert.ok(i > 0, naam + ' hoort vindbaar te zijn');
  }
  assert.ok(iType < iZet, 'de typecontrole hoort vóór het klaarzetten');
  assert.ok(iRecht < iZet, 'de rechtencontrole hoort vóór het klaarzetten');
  assert.ok(iDoel < iZet, 'de doelcontrole hoort vóór het klaarzetten');
});

test('één mislukte stap sleept de rest niet mee', () => {
  // De les uit CLAUDE.md over lussen: try/catch per item, nooit een early
  // return op één faal-item.
  const body = lijf(ACTIE_SRC, 'const uitkomsten = [];', '// ── De opdracht bijwerken');
  assert.match(body, /try \{/);
  assert.match(body, /catch \(e\)/);
  assert.match(body, /continue;/);
  assert.doesNotMatch(body, /\breturn\b/, 'een return in de lus laat de rest van het plan liggen');
  // En doeStap gooit niet: een stap die misgaat is een uitkomst.
  assert.match(ACTIE_SRC, /async function doeStap\(geclaimd, user\)/);
  assert.match(ACTIE_SRC, /return \{ ok: false, fout: tekst \};/);
});

test('een opdracht met een mislukte stap blijft in de werkbak staan', () => {
  // Hem op uitgevoerd zetten terwijl er nog werk is, laat hem er afgerond
  // uitzien — en dan kijkt niemand er meer naar.
  assert.match(ACTIE_SRC, /const nieuweStatus = mislukt\.length\s*\n?\s*\? 'wacht_op_ok'/);
  assert.match(ACTIE_SRC, /opdracht\.na_uitvoeren === 'wacht' \? 'wacht_op_antwoord' : 'uitgevoerd'/);
});

test('een afgesloten opdracht voert niets meer uit, en een open vraag ook niet', () => {
  assert.match(ACTIE_SRC, /const OPDRACHT_KLAAR = Object\.freeze\(\['geregeld', 'afgebroken'\]\)/);
  assert.match(ACTIE_SRC, /error: 'Deze opdracht is afgesloten'/);
  assert.match(ACTIE_SRC, /error: 'vraag_open'/);
  assert.match(ACTIE_SRC, /error: 'geen_stappen'/);
});

test('stappen die niet via een opdracht kunnen, worden vooraf geweigerd', () => {
  // NIET_VIA_OPDRACHT zijn de vijf die bij uitvoering een throw doen. Die
  // horen hier niet halverwege om te vallen maar vooraf geweigerd te worden.
  assert.match(ACTIE_SRC, /NIET_VIA_OPDRACHT\.includes\(type\)/);
  assert.match(ACTIE_SRC, /error: 'stap_niet_via_opdracht'/);
});

test('GAT 4: het scherm zet het detail nooit uit een POST-antwoord', () => {
  // Het POST-antwoord van 'maak' is { opdracht, plan, mag_direct, reden } en
  // mist plan_regels, verloop_regels en na_uitvoeren_zin. Werd dat als detail
  // gezet, dan stond er "Nog geen stappen — Iris wacht op een antwoord" onder
  // een plan dat wél stappen had: plan_regels leeg, begrepen niet, dus het
  // blok verscheen met de verkeerde boodschap. Precies wat er in productie
  // gebeurde.
  //
  // Enige toegestane bron voor st.detail: het GET-detail (rechtstreeks of via
  // herlaadDetail).
  // Eerst de commentaren eruit. Deze toets zoekt naar CODE die st.detail zet;
  // zonder dat strippen betrapt hij de uitleg hierboven, die het foute patroon
  // letterlijk citeert — een toets die op proza meet, meet niets.
  const zonderUitleg = SCHERM_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const zetters = [...zonderUitleg.matchAll(/(?:st|S\.opdrachten)\.detail = ([^\n;]+)/g)].map((m) => m[1].trim());
  assert.ok(zetters.length >= 3, 'de zetters horen vindbaar te zijn, anders meet dit niets');
  for (const z of zetters) {
    assert.ok(
      z === 'null' || z.includes("haal('/api/iris-opdracht?actie=een"),
      'st.detail mag alleen uit het GET-detail of op null: ' + z,
    );
  }
  assert.match(SCHERM_SRC, /herlaadDetail\(st\.open\);/, 'na maken hoort het detail opgehaald te worden');
});
