// tests/gesprekken-v2-venster-en-status.test.js
//
// De twee rekensommen uit modules/shared/gesprekken-v2.js, nagerekend.
//
// Ze horen bij gat G3 en G9 uit docs/iris/02-gesprekken-audit.md. Allebei gaan
// ze over hetzelfde soort fout: gegevens die er wél zijn maar niet getoond
// worden, waardoor het scherm iets anders beweert dan de databank weet.
//
// Wat hier vooral bewaakt wordt zijn de randen, want dáár zit het verschil
// tussen een geruststellende badge en een leugen:
//
//   · "niet bekend" is niet hetzelfde als "verlopen";
//   · een minuut vóór sluitingstijd staat er niet "0m" (dat leest als dicht);
//   · een mislukt bericht krijgt nooit hetzelfde teken als een afgeleverd;
//   · een status die we niet kennen wordt zichtbaar, niet weggeslikt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Draai het browser-script en pak zijn export. Eén bron, geen tweede kopie. */
function laad() {
  const bron = readFileSync(join(ROOT, 'modules/shared/gesprekken-v2.js'), 'utf8');
  const mod = { exports: {} };
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', bron)(win, mod);
  assert.equal(win.GESPREKKEN_V2, mod.exports, 'window- en module-export lopen uit elkaar');
  return mod.exports;
}

const G = laad();
const NU = Date.parse('2026-09-22T12:00:00Z');
const geleden = (ms) => new Date(NU - ms).toISOString();
const UUR = 3600 * 1000;

/* ── G3 · het venster ─────────────────────────────────────────────────── */

test('zonder last_inbound_at is het venster niet bekend, niet verlopen', () => {
  for (const leeg of [null, undefined, '']) {
    const v = G.vensterStand(leeg, NU);
    assert.equal(v.bekend, false);
    assert.equal(v.tekst, '', 'een gesprek zonder inkomend bericht mag geen "verlopen" tonen');
  }
});

test('een onleesbare datum telt als onbekend, niet als verlopen', () => {
  const v = G.vensterStand('gisteren', NU);
  assert.equal(v.bekend, false);
  assert.equal(v.tekst, '');
});

test('zes uur geleden binnengekomen → nog 18u00 open', () => {
  const v = G.vensterStand(geleden(6 * UUR), NU);
  assert.equal(v.open, true);
  assert.equal(v.tekst, 'nog 18u00');
  assert.equal(v.bijnaDicht, false);
});

test('de minuten krijgen een voorloopnul — "6u02", niet "6u2"', () => {
  const v = G.vensterStand(geleden(17 * UUR + 58 * 60 * 1000), NU);
  assert.equal(v.tekst, 'nog 6u02');
});

test('onder het uur telt het in minuten', () => {
  const v = G.vensterStand(geleden(23 * UUR - 13 * 60 * 1000), NU);
  assert.equal(v.tekst, 'nog 1u13');
  const w = G.vensterStand(geleden(23 * UUR + 13 * 60 * 1000), NU);
  assert.equal(w.tekst, 'nog 47m');
});

test('de laatste minuut heet "<1m" en niet "0m"', () => {
  // "0m" leest als dicht terwijl het nog open is. Het verschil is precies het
  // gat: je denkt dat je een template nodig hebt en dat is niet zo.
  const v = G.vensterStand(geleden(24 * UUR - 30 * 1000), NU);
  assert.equal(v.open, true);
  assert.equal(v.tekst, 'nog <1m');
});

test('precies 24 uur is voorbij — de grens valt naar dicht', () => {
  const v = G.vensterStand(geleden(24 * UUR), NU);
  assert.equal(v.bekend, true);
  assert.equal(v.open, false);
  assert.equal(v.tekst, 'verlopen');
  // En dat komt overeen met wat de server zegt: inbox-thread-unified rekent
  // `(Date.now() - ms) < 24h`, dus exact 24 uur is daar óók niet meer open.
});

test('binnen twee uur van sluiten heet het bijna dicht', () => {
  assert.equal(G.vensterStand(geleden(22 * UUR + 1), NU).bijnaDicht, true);
  assert.equal(G.vensterStand(geleden(22 * UUR - 60 * 1000), NU).bijnaDicht, false);
  assert.equal(G.vensterStand(geleden(25 * UUR), NU).bijnaDicht, false, 'verlopen is niet "bijna dicht"');
});

test('een Date en een tekstdatum geven hetzelfde antwoord', () => {
  const d = new Date(NU - 5 * UUR);
  assert.deepEqual(G.vensterStand(d, NU), G.vensterStand(d.toISOString(), NU));
});

/* ── G9 · de verzendstatus ────────────────────────────────────────────── */

test('mislukt krijgt nooit hetzelfde teken als afgeleverd', () => {
  const mislukt = G.verzendStand('failed', 'Recipient not on WhatsApp');
  const goed = G.verzendStand('delivered');
  assert.notEqual(mislukt.teken, goed.teken);
  assert.equal(mislukt.kleur, 'rood');
  assert.match(mislukt.label, /Recipient not on WhatsApp/, 'de reden hoort erbij te staan');
});

test('mislukt zonder reden blijft leesbaar', () => {
  const v = G.verzendStand('failed', null);
  assert.equal(v.label, 'Niet verstuurd');
});

test('de vier gewone standen', () => {
  assert.equal(G.verzendStand('sent').teken, '✓');
  assert.equal(G.verzendStand('delivered').teken, '✓✓');
  assert.equal(G.verzendStand('read').teken, '✓✓');
  assert.equal(G.verzendStand('read').kleur, 'blue', 'gelezen moet van afgeleverd te onderscheiden zijn');
  assert.equal(G.verzendStand('pending').code, 'pending');
});

test('hoofdletters en spaties uit de databank storen niet', () => {
  assert.equal(G.verzendStand(' Delivered ').code, 'delivered');
});

test('geen status → geen teken (oude rijen liegen niet)', () => {
  assert.equal(G.verzendStand(null), null);
  assert.equal(G.verzendStand(''), null);
});

test('een onbekende status wordt zichtbaar, niet weggeslikt', () => {
  // Meta kan morgen een status bijverzinnen. Die mag er niet uitzien als
  // afgeleverd; hij moet opvallen zodat iemand 'em komt toevoegen.
  const v = G.verzendStand('teleported');
  assert.equal(v.code, 'onbekend');
  assert.match(v.label, /teleported/);
  assert.notEqual(v.teken, '✓✓');
});

/* ── Wie krijgt er een teken onder zich ───────────────────────────────── */

test('alleen uitgaande WhatsApp krijgt een verzendstatus', () => {
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'outbound' }), true);
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'out' }), true);
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'inbound' }), false);
  assert.equal(G.toontVerzendStand({ channel: 'email', direction: 'outbound' }), false, 'mail heeft geen Meta-status');
  assert.equal(G.toontVerzendStand(null), false);
});

/* ── G5-deels · de twee standen die nu al kunnen ──────────────────────── */

// De lijst zoals het scherm 'em kent: `alle` is alles wat het endpoint gaf,
// `zichtbaar` is wat de wanbetalerslijst normaal toont (klant met open
// facturen). Een gesprek zonder klant staat wel in `alle` en niet in
// `zichtbaar` — precies de reden dat zulke gesprekken ongezien blijven liggen.
const ALLE = [
  { id: 'a', customer_id: 'k1', last_inbound_at: geleden(1 * UUR) },   // ruim open
  { id: 'b', customer_id: 'k2', last_inbound_at: geleden(23 * UUR) },  // nog 1u → bijna dicht
  { id: 'c', customer_id: 'k3', last_inbound_at: geleden(30 * UUR) },  // verlopen
  { id: 'd', customer_id: 'k4', last_inbound_at: null },               // nooit iets binnen
  { id: 'e', customer_id: null, last_inbound_at: geleden(2 * UUR) },   // geen klant
  { id: 'f', customer_id: null, last_inbound_at: geleden(23.5 * UUR) },// geen klant, bijna dicht
];
const ZICHTBAAR = ALLE.filter((c) => c.customer_id);

test('een onbekende stand valt terug op "geen"', () => {
  for (const ruw of [null, undefined, '', 'onzin', 'NIET_GEKOPPELD ']) {
    const uit = G.leesFocus(ruw);
    assert.ok(G.FOCUS_MODI.includes(uit));
  }
  assert.equal(G.leesFocus('onzin'), 'geen');
  assert.equal(G.leesFocus(' NIET_GEKOPPELD '), 'niet_gekoppeld', 'hoofdletters horen te werken');
});

test('"geen" geeft letterlijk de lijst terug die er al was', () => {
  const uit = G.focusFilter(ALLE, ZICHTBAAR, 'geen', NU);
  assert.equal(uit, ZICHTBAAR, 'niet dezelfde array — dan is er onderweg iets gekopieerd of gesorteerd');
});

test('"venster bijna dicht" versmalt de zichtbare lijst', () => {
  const uit = G.focusFilter(ALLE, ZICHTBAAR, 'venster_bijna_dicht', NU);
  assert.deepEqual(uit.map((c) => c.id), ['b']);
  // 'a' heeft nog 23 uur, 'c' is verlopen, 'd' heeft geen venster, en 'f'
  // staat niet in de zichtbare lijst — die hoort hier dus ook niet op te duiken.
});

test('"niet gekoppeld" kijkt juist buiten de zichtbare lijst', () => {
  // Dit is het punt van deze stand. Zou hij binnen ZICHTBAAR zoeken, dan was
  // het antwoord altijd leeg (geen klant = geen open facturen = niet zichtbaar)
  // en zag het eruit alsof er niets aan de hand was.
  const uit = G.focusFilter(ALLE, ZICHTBAAR, 'niet_gekoppeld', NU);
  assert.deepEqual(uit.map((c) => c.id), ['e', 'f']);
});

test('de tellers komen uit dezelfde functie als de lijst', () => {
  const tel = G.focusTelling(ALLE, ZICHTBAAR, NU);
  assert.equal(tel.venster_bijna_dicht, G.focusFilter(ALLE, ZICHTBAAR, 'venster_bijna_dicht', NU).length);
  assert.equal(tel.niet_gekoppeld, G.focusFilter(ALLE, ZICHTBAAR, 'niet_gekoppeld', NU).length);
  assert.equal(tel.venster_bijna_dicht, 1);
  assert.equal(tel.niet_gekoppeld, 2);
  // Elke stand hoort een teller te hebben, afgeleid uit FOCUS_MODI in plaats
  // van hier uitgeschreven. Een vast lijstje zou bij het volgende filter
  // omvallen op de VORM en niet op een fout, en dan pas je de test aan zonder
  // te kijken of de teller ook echt klopt.
  for (const modus of G.FOCUS_MODI) {
    if (modus === 'geen') continue;
    assert.equal(typeof tel[modus], 'number', `teller voor ${modus} ontbreekt`);
    assert.equal(tel[modus], G.focusFilter(ALLE, ZICHTBAAR, modus, NU).length, modus);
  }
});

test('rommel als invoer levert een lege lijst op, geen uitzondering', () => {
  for (const rommel of [null, undefined, 42, 'lijst', {}]) {
    assert.deepEqual(G.focusFilter(rommel, rommel, 'niet_gekoppeld', NU), []);
    assert.deepEqual(G.focusFilter(rommel, rommel, 'venster_bijna_dicht', NU), []);
  }
});

/* ── G8 · hoe vaak de lijst opnieuw opgehaald wordt ───────────────────── */

test('zonder realtime blijft het zes seconden — precies zoals nu', () => {
  // De terugval moet het oude gedrag zijn, anders is "de vlag uit verandert
  // niets" niet waar voor de poll.
  assert.equal(G.pollInterval({}), 6000);
  assert.equal(G.pollInterval({ verbonden: false }), 6000);
  assert.equal(G.pollInterval({ verbonden: false, bewezen: true }), 6000,
    'bewezen zonder verbinding is een oude vlag, geen reden om te vertragen');
});

test('een verbonden kanaal geeft een matige versnelling, een bewezen kanaal de volle', () => {
  assert.equal(G.pollInterval({ verbonden: true }), 20000);
  assert.equal(G.pollInterval({ verbonden: true, bewezen: true }), 45000);
});

test('een verborgen tabblad pollt helemaal niet', () => {
  assert.equal(G.pollInterval({ verborgen: true }), null);
  assert.equal(G.pollInterval({ verborgen: true, verbonden: true, bewezen: true }), null);
});

test('alleen een echte true telt — undefined is geen belofte', () => {
  // Deze standen komen uit losse velden op een state-object. Een veld dat er
  // (nog) niet is mag niet als "ja" gelezen worden: dan zou een half
  // geïnitialiseerde staat de poll vertragen zonder dat er een kanaal is.
  assert.equal(G.pollInterval({ verbonden: 'ja' }), 6000);
  assert.equal(G.pollInterval({ verbonden: 1 }), 6000);
  assert.equal(G.pollInterval({ verborgen: 'nee', verbonden: true }), 20000);
  assert.equal(G.pollInterval(null), 6000);
  assert.equal(G.pollInterval(undefined), 6000);
});

test('magOphalen wacht de gekozen tijd af', () => {
  const bewezen = { verbonden: true, bewezen: true };
  assert.equal(G.magOphalen(bewezen, 44999), false);
  assert.equal(G.magOphalen(bewezen, 45000), true, 'precies op de grens mag het');
  assert.equal(G.magOphalen({}, 5999), false);
  assert.equal(G.magOphalen({}, 6000), true);
});

test('een verborgen tabblad haalt nooit op, hoe lang het ook geleden is', () => {
  assert.equal(G.magOphalen({ verborgen: true }, 10 * 60 * 1000), false);
});

test('een onbekende "sinds" haalt op in plaats van te blijven wachten', () => {
  // Bij een verse staat is lastRefresh 0 en is de aftreksom onzin. Dan is één
  // keer te veel ophalen goedkoper dan een lijst die nooit vult.
  for (const rommel of [NaN, null, undefined, 'lang']) {
    assert.equal(G.magOphalen({ verbonden: true, bewezen: true }, rommel), true);
  }
});

test('de gekozen tijden zijn de tijden waar de winst op gerekend is', () => {
  // 90 KB per opvraging (het endpoint rekent dat zelf voor bij 115 gesprekken):
  //   6 s → 600 opvragingen per uur → ≈ 54 MB
  //  20 s → 180                     → ≈ 16 MB
  //  45 s →  80                     → ≈  7 MB
  // Verandert een van deze getallen, dan klopt die som in de documentatie niet
  // meer — en dan hoort iemand dat te merken.
  assert.deepEqual(G.POLL_MS, { geen_kanaal: 6000, onbewezen: 20000, bewezen: 45000 });
});

/* ── G2 · het ongedaan-venster ────────────────────────────────────────── */

test('de teller staat op dertig seconden', () => {
  // Lang genoeg om je te bedenken, kort genoeg om niet in de weg te lopen.
  // Verandert dit getal, dan klopt de tekst in de balk niet meer.
  assert.equal(G.UITSTEL_MS, 30000);
});

test('de balk loopt leeg, niet vol', () => {
  // Vol bij de start, leeg als het weggaat. Andersom leest als "hij is bijna
  // klaar met laden", en dat is het tegenovergestelde van wat er gebeurt.
  const nu = 1_000_000;
  assert.equal(G.uitstelRest(nu + 30000, nu).deel, 1);
  assert.equal(G.uitstelRest(nu + 15000, nu).deel, 0.5);
  assert.equal(G.uitstelRest(nu + 1, nu).deel > 0, true);
});

test('zolang er iets over is, staat er minstens 1 seconde', () => {
  // "0 seconden" met een knop die nog werkt is een tegenstrijdigheid; naar
  // boven afronden houdt de tekst en de knop met elkaar eens.
  const nu = 1_000_000;
  assert.equal(G.uitstelRest(nu + 1, nu).seconden, 1);
  assert.equal(G.uitstelRest(nu + 999, nu).seconden, 1);
  assert.equal(G.uitstelRest(nu + 1001, nu).seconden, 2);
});

test('op nul is het voorbij', () => {
  const nu = 1_000_000;
  assert.equal(G.uitstelRest(nu, nu).loopt, false);
  assert.equal(G.uitstelRest(nu - 1, nu).loopt, false);
  assert.equal(G.magNogTerug(nu - 1, nu), false);
  assert.equal(G.magNogTerug(nu + 1, nu), true);
});

test('rommel telt als voorbij, niet als eeuwig', () => {
  // Een kapotte tijd mag geen bericht laten hangen dat nooit vertrekt én
  // nooit teruggehaald kan worden.
  for (const r of [null, undefined, NaN, 'straks', {}]) {
    assert.equal(G.uitstelRest(r, 1000).loopt, false);
    assert.equal(G.magNogTerug(r, 1000), false);
  }
});

// ── de bladzijdegrens van de draad (G8) ─────────────────────────────────────
//
// De draad haalt de nieuwste 200 op; zit er meer, dan vraagt het scherm door
// met ?voor=<grens>. Die grens is KLEINER-OF-GELIJK, dus het grensbericht komt
// zelf mee terug — en alles dat op dezelfde seconde staat ook. Hier gooien we
// die er weer uit.

const maakItem = (id, channel = 'whatsapp') => ({ id: String(id), channel, at: 'x' });

test('het grensbericht komt er niet twee keer in', () => {
  // Zonder dit groeit de draad met een duplicaat bij elke klik op "toon
  // oudere berichten".
  const bestaand = [maakItem(10), maakItem(11)];
  const binnen = [maakItem(8), maakItem(9), maakItem(10)];
  const r = G.nieuweDraadItems(bestaand, binnen);
  assert.equal(r.nieuw.length, 2);
  assert.deepEqual(r.nieuw.map((i) => i.id), ['8', '9']);
  assert.equal(r.vooruitgang, true);
});

test('een bladzijde zonder iets nieuws meldt dat, zodat het scherm stopt', () => {
  // Als de hele bladzijde op dezelfde tijdstempel staat, kom je met
  // doorvragen niet verder. Zonder dit signaal haalt het scherm eindeloos
  // dezelfde bladzijde op.
  const bestaand = [maakItem(1), maakItem(2)];
  const r = G.nieuweDraadItems(bestaand, bestaand);
  assert.equal(r.nieuw.length, 0);
  assert.equal(r.vooruitgang, false);
});

test('hetzelfde id op een ander kanaal is een ANDER bericht', () => {
  // WhatsApp en mail komen uit verschillende tabellen; hun id's zeggen niets
  // over elkaar. Alleen op id ontdubbelen zou een mail laten verdwijnen omdat
  // er toevallig een WhatsApp-bericht met datzelfde id bestaat.
  const r = G.nieuweDraadItems([maakItem(1, 'whatsapp')], [maakItem(1, 'email')]);
  assert.equal(r.nieuw.length, 1);
});

test('een bericht zonder id wordt nooit weggegooid', () => {
  // Liever één keer dubbel in beeld dan een bericht dat je niet te zien krijgt.
  const r = G.nieuweDraadItems([maakItem(1)], [{ channel: 'whatsapp', at: 'x' }]);
  assert.equal(r.nieuw.length, 1);
  assert.equal(G.draadSleutel({ channel: 'whatsapp' }), null);
  assert.equal(G.draadSleutel(null), null);
});

test('ontdubbelen valt niet om over lege invoer', () => {
  assert.deepEqual(G.nieuweDraadItems(null, null).nieuw, []);
  assert.equal(G.nieuweDraadItems(null, [maakItem(1)]).nieuw.length, 1);
});
