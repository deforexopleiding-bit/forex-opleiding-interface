// tests/whatsapp-brug-gebeurtenissen.test.js
//
// Welke webhook-gebeurtenis levert een WhatsApp-bericht op?
//
// Dit is het pad waarlangs een spraakbericht van Dave meetbaar werd. Twee
// dingen moeten hier kloppen en allebei falen stil:
//
//  · De richting. whatsapp-web.js doet in Client.js `if (msg.id.fromMe) return;`
//    vlak voor het 'message'-event, dus eigen berichten komen daar nooit langs.
//    Alleen message_create ziet ze. Wie dat filter verkeerd zet, meet ofwel
//    niets ofwel de berichten van de lead alsof Dave ze stuurde.
//
//  · Het tijdstip. Een uitgaand bericht draagt msg.timestamp, het moment van
//    versturen. De ack kent dat niet en stempelt het moment van de bevestiging,
//    dat uren later kan zijn. Voor een deadline van 09:00 is dat het verschil
//    tussen op tijd en te laat.
//
// De privacybeslissing zit hier niet in — die staat in whatsapp.js, vóór deze
// functies aangeroepen worden. Wat hier wél getest wordt is dat een groep er
// ook langs deze kant niet doorheen glipt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwUitgaandeGebeurtenis, bouwAckGebeurtenis, isGroep, isSpraak, ACK_SOORT,
} from '../services/whatsapp-brug/lib/gebeurtenis.js';

const NU = Date.parse('2026-09-05T12:00:00Z');
const VERSTUURD = Math.floor(Date.parse('2026-09-05T06:30:00Z') / 1000);

const uit = (over) => ({
  fromMe: true, to: '32470111222@c.us', type: 'chat',
  timestamp: VERSTUURD, id: { _serialized: 'true_32470111222@c.us_ABC' }, ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// UITGAAND — wat Dave zelf stuurt
// ═══════════════════════════════════════════════════════════════════════════

test('een eigen bericht levert een uitgaande gebeurtenis op', () => {
  const g = bouwUitgaandeGebeurtenis(uit(), NU);
  assert.equal(g.soort, 'uitgaand');
  assert.equal(g.jid, '32470111222@c.us');
  assert.equal(g.bericht_id, 'true_32470111222@c.us_ABC');
});

test('een ingesproken bericht is herkenbaar aan media_type', () => {
  // ptt = push to talk, het type dat WhatsApp aan een spraakbericht geeft.
  assert.equal(bouwUitgaandeGebeurtenis(uit({ type: 'ptt' }), NU).media_type, 'ptt');
  assert.equal(isSpraak('ptt'), true);
  assert.equal(isSpraak('audio'), true);
  assert.equal(isSpraak('chat'), false, 'een tekstje is geen spraakbericht');
  assert.equal(isSpraak(null), false);
});

test('het tijdstip is het moment van versturen, niet van verwerken', () => {
  // 06:30Z, terwijl de webhook om 12:00Z draait. Zou hier het verwerkmoment
  // staan, dan haalt elk spraakbericht de deadline van 09:00 niet meer.
  const g = bouwUitgaandeGebeurtenis(uit({ type: 'ptt' }), NU);
  assert.equal(g.tijdstip, '2026-09-05T06:30:00.000Z');
});

test('zonder bruikbare timestamp valt het terug op nu, niet op 1970', () => {
  for (const raar of [null, undefined, 0, -1, 'gisteren']) {
    const g = bouwUitgaandeGebeurtenis(uit({ timestamp: raar }), NU);
    assert.equal(g.tijdstip, '2026-09-05T12:00:00.000Z', String(raar));
  }
});

test('er gaat GEEN berichttekst mee', () => {
  // Voor deze meting hoeven we alleen te weten dát er iets uitging en of het
  // ingesproken was. De tekst van wat Dave naar een lead stuurt is gevoeliger
  // dan nodig en verlaat de telefoon niet.
  const g = bouwUitgaandeGebeurtenis(uit({ body: 'Hoi Karel, alles goed verlopen?' }), NU);
  assert.equal('tekst' in g, false);
  assert.equal('body' in g, false);
  assert.deepEqual(Object.keys(g).sort(), ['bericht_id', 'jid', 'media_type', 'soort', 'tijdstip']);
});

test('een inkomend bericht levert hier niets op', () => {
  // Dat loopt via het 'message'-event. Zou het hier ook doorkomen, dan telde
  // een antwoord van de lead als iets dat Dave verstuurde.
  for (const nietVanOns of [false, undefined, null, 0, 'true']) {
    assert.equal(bouwUitgaandeGebeurtenis(uit({ fromMe: nietVanOns }), NU), null, String(nietVanOns));
  }
});

test('een groep komt er niet doorheen', () => {
  // Daar zitten per definitie mensen in die niet op de leadlijst staan.
  assert.equal(bouwUitgaandeGebeurtenis(uit({ to: '120363012345678901@g.us' }), NU), null);
  assert.equal(isGroep('120363012345678901@g.us'), true);
  assert.equal(isGroep('32470111222@c.us'), false);
});

test('zonder ontvanger gebeurt er niets', () => {
  for (const leeg of [null, undefined, '']) {
    assert.equal(bouwUitgaandeGebeurtenis(uit({ to: leeg }), NU), null);
  }
  assert.equal(bouwUitgaandeGebeurtenis(null, NU), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// ACK — de statusveranderingen
// ═══════════════════════════════════════════════════════════════════════════

test('de ack-codes worden vertaald, en alleen de zinvolle', () => {
  assert.deepEqual(ACK_SOORT, { 1: 'verzonden', 2: 'afgeleverd', 3: 'gelezen', 4: 'gelezen' });
  // -1 is een fout en 0 is 'nog bezig'; daar valt in de opvolging niets mee.
  for (const geen of [-1, 0, 5, null, undefined]) {
    assert.equal(bouwAckGebeurtenis(uit(), geen, NU), null, String(geen));
  }
});

test('een ack draagt nu wél het media_type mee', () => {
  // Dat was de tweede reden dat een verstuurd spraakbericht onzichtbaar bleef:
  // het Message-object bij een ack heeft .type, maar de brug stuurde het niet.
  const g = bouwAckGebeurtenis(uit({ type: 'ptt' }), 2, NU);
  assert.equal(g.soort, 'afgeleverd');
  assert.equal(g.media_type, 'ptt');
});

test('een ack stempelt het moment van de bevestiging', () => {
  // Bewust anders dan bij uitgaand: de ack weet niet wanneer het bericht
  // verstuurd is. Daarom wint 'uitgaand' in de webhook bij dezelfde sleutel.
  const g = bouwAckGebeurtenis(uit({ type: 'ptt' }), 3, NU);
  assert.equal(g.tijdstip, '2026-09-05T12:00:00.000Z');
  assert.notEqual(g.tijdstip, bouwUitgaandeGebeurtenis(uit({ type: 'ptt' }), NU).tijdstip);
});

test('een ack op een groep komt er ook niet doorheen', () => {
  assert.equal(bouwAckGebeurtenis(uit({ to: '120363012345678901@g.us' }), 2, NU), null);
});

test('een ack zonder tegenpartij levert niets op', () => {
  assert.equal(bouwAckGebeurtenis({ id: { _serialized: 'x' } }, 2, NU), null);
  assert.equal(bouwAckGebeurtenis(null, 2, NU), null);
});
