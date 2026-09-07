// tests/whatsapp-lid-sleutel.test.js
//
// Op 7 september kwam er geen enkel WhatsApp-bericht meer binnen. De brug zag
// alles — 92 gebeurtenissen — en liet er één door. De reden stond overal op
// 'niet_op_leadlijst', en die reden klopte: bepaalNummer gaf het LID terug als
// telefoonnummer, en dat staat natuurlijk niet op de leadlijst.
//
// Twee dingen gingen mis, en ze versterkten elkaar:
//
//  1. getContactById geeft bij een LID het LID terug. Dat werd geteld als
//     opgelost.contact — SUCCES — terwijl er niets vertaald was. Zolang een
//     teller succes zegt bij een fout antwoord, blijf je op de verkeerde plek
//     zoeken.
//
//  2. De lidkaart had 29 koppelingen en miste toch 67 van de 71 opzoekingen.
//     Vermoeden: een binnenkomende jid draagt een apparaat-achtervoegsel
//     (<lid>:<apparaat>@lid), en replace(/\D/g,'') last dat vast aan het LID.
//     Dertien cijfers worden er veertien — precies de vormen lid/14 en lid/15
//     die binnenkwamen, terwijl de kaart de kale LID als sleutel had.
//
// Deze tests leggen allebei vast. Het tweede blijft een vermoeden tot de brug
// op de VPS draait; wat hier bewezen wordt is dat de kaart het ALLEBEI aankan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deelSleutel, sleutelVorm, beoordeelKandidaat, kanTelefoonnummerZijn,
  NUMMER_MAX_CIJFERS,
} from '../services/whatsapp-brug/lib/sleutel.js';
import { maakLidkaart } from '../services/whatsapp-brug/lib/lidkaart.js';
import { maakTellers } from '../services/whatsapp-brug/lib/tellers.js';

// ═══════════════════════════════════════════════════════════════════════════
// HET APPARAAT-ACHTERVOEGSEL
// ═══════════════════════════════════════════════════════════════════════════

test('een apparaat-achtervoegsel wordt niet aan het LID vastgelast', () => {
  const d = deelSleutel('1234567890123:5@lid');
  assert.equal(d.vol, '12345678901235');   // wat de oude code als sleutel nam
  assert.equal(d.basis, '1234567890123');  // het echte LID
  assert.equal(d.apparaat, true);
});

test('zonder achtervoegsel zijn beide vormen gelijk', () => {
  const d = deelSleutel('1234567890123@lid');
  assert.equal(d.vol, '1234567890123');
  assert.equal(d.basis, '1234567890123');
  assert.equal(d.apparaat, false);
});

test('de vorm verraadt het achtervoegsel zonder het LID prijs te geven', () => {
  assert.equal(sleutelVorm('1234567890123:5@lid'), 'lid/13+apparaat');
  assert.equal(sleutelVorm('1234567890123@lid'), 'lid/13');
  assert.equal(sleutelVorm('32470111222@c.us'), 'c.us/11');
  // Nooit cijfers uit het LID zelf.
  assert.doesNotMatch(sleutelVorm('1234567890123:5@lid'), /1234567890123/);
});

test('een tweecijferig apparaat verklaart lid/15 net zo goed als lid/14', () => {
  // De meting van 7 september: lid/14 kwam 34 keer voor, lid/15 33 keer. Eén
  // basis-LID met een een- of tweecijferig apparaat levert precies die twee op.
  assert.equal(deelSleutel('1234567890123:5@lid').vol.length, 14);
  assert.equal(deelSleutel('1234567890123:12@lid').vol.length, 15);
  assert.equal(deelSleutel('1234567890123:5@lid').basis.length, 13);
  assert.equal(deelSleutel('1234567890123:12@lid').basis.length, 13);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART VINDT DE LEAD NU WEL — EN ZEGT LANGS WELKE INGANG
// ═══════════════════════════════════════════════════════════════════════════

async function kaartMet(paren) {
  const kaart = maakLidkaart();
  const nummers = paren.map(([n]) => n);
  const map = new Map(paren);
  await kaart.bouw(nummers, async (n) => map.get(n) || null);
  return kaart;
}

test('een jid met achtervoegsel vindt de lead die zonder achtervoegsel is opgeslagen', async () => {
  // Dit is de storing van 7 september, nagespeeld.
  const kaart = await kaartMet([['32470111222', '1234567890123@lid']]);
  const uit = kaart.zoekNummer('1234567890123:5@lid');
  assert.equal(uit.nummer, '32470111222');
  assert.equal(uit.via, 'basis', 'de kale sleutel hoort de redding te zijn');
});

test('de oude weg blijft de oude weg — zonder achtervoegsel raakt hij op vol', async () => {
  const kaart = await kaartMet([['32470111222', '1234567890123@lid']]);
  const uit = kaart.zoekNummer('1234567890123@lid');
  assert.equal(uit.nummer, '32470111222');
  assert.equal(uit.via, 'vol', 'zonder achtervoegsel verandert er niets aan het gedrag');
});

test('ook andersom: opgeslagen mét achtervoegsel, binnenkomend zonder', async () => {
  const kaart = await kaartMet([['32470111222', '1234567890123:5@lid']]);
  const uit = kaart.zoekNummer('1234567890123@lid');
  assert.equal(uit.nummer, '32470111222');
});

test('een LID dat we niet kennen blijft onbekend', async () => {
  const kaart = await kaartMet([['32470111222', '1234567890123@lid']]);
  const uit = kaart.zoekNummer('9999999999999:7@lid');
  assert.equal(uit.nummer, null);
  assert.equal(uit.via, null);
  // De vorm komt wél terug, want die is de meting.
  assert.equal(uit.vorm, 'lid/13+apparaat');
});

test('de kaart houdt meer ingangen dan koppelingen als er achtervoegsels zijn', async () => {
  const kaart = await kaartMet([['32470111222', '1234567890123:5@lid']]);
  const st = kaart.status();
  assert.equal(st.koppelingen, 1);
  assert.equal(st.ingangen, 2, 'beide vormen horen naar dezelfde lead te wijzen');
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN FOUT ANTWOORD TELT NIET MEER ALS SUCCES
// ═══════════════════════════════════════════════════════════════════════════

test('het LID terugkrijgen op de vraag wie dat LID is, is geen oplossing', () => {
  // Exact het geval uit opgelost_vorm: contact/14 en contact/15.
  const o = beoordeelKandidaat('12345678901235', '1234567890123:5@lid');
  assert.equal(o.ok, false);
  assert.equal(o.reden, 'zelfde_als_vraag');
});

test('ook het kale LID terugkrijgen telt niet als oplossing', () => {
  const o = beoordeelKandidaat('1234567890123', '1234567890123:5@lid');
  assert.equal(o.ok, false);
  assert.equal(o.reden, 'zelfde_als_vraag');
});

test('een echt telefoonnummer is wél een oplossing', () => {
  const o = beoordeelKandidaat('32470111222', '1234567890123:5@lid');
  assert.equal(o.ok, true);
  assert.equal(o.nummer, '32470111222');
});

test('een ANDER lang getal wordt ook geweigerd, niet alleen hetzelfde', () => {
  // Het vangnet: geeft WhatsApp een lang getal terug dat toevallig niet gelijk
  // is aan de vraag, dan is het nog steeds geen telefoonnummer.
  const o = beoordeelKandidaat('99999999999999', '1234567890123:5@lid');
  assert.equal(o.ok, false);
  assert.equal(o.reden, 'geen_nummervorm');
});

test('de grens laat Belgische en Nederlandse nummers door', () => {
  assert.equal(kanTelefoonnummerZijn('32470111222'), true);   // 11, met landcode
  assert.equal(kanTelefoonnummerZijn('31612345678'), true);   // 11, met landcode
  assert.equal(kanTelefoonnummerZijn('0470111222'), true);    // 10, lokaal
  assert.equal(kanTelefoonnummerZijn('470111222'), true);     //  9, kaal
  assert.equal(kanTelefoonnummerZijn('1234567890123'), true); // 13 = de grens
  assert.equal(kanTelefoonnummerZijn('12345678901234'), false);
  assert.equal(NUMMER_MAX_CIJFERS, 13);
});

test('leeg blijft leeg', () => {
  assert.equal(beoordeelKandidaat(null, '1234@lid').ok, false);
  assert.equal(beoordeelKandidaat('', '1234@lid').reden, 'leeg');
  assert.equal(kanTelefoonnummerZijn(''), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLERS DRAGEN GEEN ENKEL GEGEVEN
// ═══════════════════════════════════════════════════════════════════════════

test('de nieuwe tellers dragen alleen vormen en aantallen', () => {
  const t = maakTellers();
  t.sleutelOpslag(sleutelVorm('1234567890123@lid'));
  t.sleutelZoek(sleutelVorm('1234567890123:5@lid'), false);
  t.sleutelZoek(sleutelVorm('1234567890123:5@lid'), true);
  t.onbruikbaar('zelfde_als_vraag');
  const st = t.status();

  assert.deepEqual(st.sleutel_opslag, { 'lid/13': 1 });
  assert.deepEqual(st.sleutel_zoek, { 'lid/13+apparaat': 2 });
  assert.deepEqual(st.sleutel_raak, { 'lid/13+apparaat': 1 });
  assert.deepEqual(st.onbruikbaar_reden, { zelfde_als_vraag: 1 });

  // Geen enkel cijfer uit het LID mag in de hele momentopname staan.
  const blob = JSON.stringify(st);
  assert.doesNotMatch(blob, /1234567890123/);
  assert.doesNotMatch(blob, /32470111222/);
});

test('lidkaart_basis is een eigen uitkomst, apart van lidkaart', () => {
  // Dat onderscheid IS de meting: blijft lidkaart_basis op nul, dan was het
  // vermoeden over het apparaat-achtervoegsel onjuist en is er niets stilletjes
  // 'gerepareerd'.
  const t = maakTellers();
  t.oplossing('lidkaart_basis', '32470111222');
  t.oplossing('lidkaart', '32470111222');
  const st = t.status();
  assert.equal(st.opgelost.lidkaart_basis, 1);
  assert.equal(st.opgelost.lidkaart, 1);
});

test('onbruikbaar is een eigen uitkomst en telt niet als contact-succes', () => {
  const t = maakTellers();
  t.oplossing('onbruikbaar');
  const st = t.status();
  assert.equal(st.opgelost.onbruikbaar, 1);
  assert.equal(st.opgelost.contact, 0, 'een fout antwoord mag nooit als contact-succes tellen');
});
