// tests/whatsapp-systeemtypes.test.js
//
// K — een systeembericht van WhatsApp is geen antwoord van de lead.
//
// HET BEWIJS UIT PRODUCTIE. In opvolging_wa_berichten stond een rij met
// tijdstip 2026-09-05T20:58:55Z, richting 'in', media_type 'e2e_notification'
// en geen tekst. Daarnaast stond poging ed32125d op taak 5a8864a1 met resultaat
// 'antwoord ontvangen'. Er was NIETS geantwoord: WhatsApp had een sleutel
// ververst, en het systeem noteerde dat als contact met de lead.
//
// Dat is de fout die we blijven maken — een gebeurtenis die iets anders
// betekent dan waar hij voor doorgaat — en hij zat in de cijfers waar Dave op
// stuurt: de dekking liep op en een lead die nooit reageerde zag er beantwoord
// uit.
//
// DE TWEE DINGEN DIE DEZE TEST BEWAAKT:
//
//  1. Het filter houdt de systeemtypes tegen. Op alle drie de paden, en ook
//     server-side, want de brug op de VPS loopt altijd achter op een deploy.
//
//  2. HET FILTER HOUDT NIET ALLES TEGEN. Een filter dat er goed uitziet omdat
//     er niets meer binnenkomt is erger dan geen filter. Een gewone chat, een
//     ptt en een onbekend type moeten er nog steeds langs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  isEchtGesprek as brugEchtGesprek, SYSTEEM_TYPES as BRUG_TYPES,
  bouwHistoriekBericht,
} from '../services/whatsapp-brug/lib/gebeurtenis.js';
import {
  isEchtGesprek as apiEchtGesprek, SYSTEEM_TYPES as API_TYPES,
} from '../api/_lib/whatsapp-systeemtypes.js';
import { maakTellers } from '../services/whatsapp-brug/lib/tellers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA   = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');
const HOOK = join(ROOT, 'api/opvolging-whatsapp-webhook.js');

// De vorm zoals hij in productie binnenkwam.
const e2e = {
  id: { _serialized: 'false_32470123456@c.us_ABC' },
  from: '32470123456@c.us', to: '32499999999@c.us', fromMe: false,
  type: 'e2e_notification', body: '', timestamp: 1788641935,
};

// ═══════════════════════════════════════════════════════════════════════════
// DE WEIGERING
// ═══════════════════════════════════════════════════════════════════════════

test('een e2e_notification is geen gesprek', () => {
  assert.equal(brugEchtGesprek('e2e_notification'), false);
  assert.equal(apiEchtGesprek('e2e_notification'), false);
});

test('alle bekende systeemtypes worden geweigerd', () => {
  for (const t of ['e2e_notification', 'notification_template', 'gp2', 'protocol',
                   'ciphertext', 'revoked', 'call_log', 'broadcast_notification', 'unknown']) {
    assert.equal(brugEchtGesprek(t), false, t);
    assert.equal(apiEchtGesprek(t), false, t);
  }
});

test('hoofdletters maken niet uit', () => {
  assert.equal(brugEchtGesprek('E2E_Notification'), false);
  assert.equal(apiEchtGesprek('CIPHERTEXT'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN NIET MEER DAN DAT — DIT IS DE BELANGRIJKSTE HELFT
// ═══════════════════════════════════════════════════════════════════════════

test('een gewone chat komt er nog steeds langs', () => {
  assert.equal(brugEchtGesprek('chat'), true);
  assert.equal(apiEchtGesprek('chat'), true);
});

test('een spraakbericht komt er nog steeds langs', () => {
  // ptt is het type waar het hele spraakvenster op hangt. Zou die wegvallen,
  // dan meet de module vanaf morgen nul spraakberichten en ziet dat eruit als
  // 'Dave doet het niet meer'.
  for (const t of ['ptt', 'audio', 'voice']) {
    assert.equal(brugEchtGesprek(t), true, t);
    assert.equal(apiEchtGesprek(t), true, t);
  }
});

test('media komen er nog steeds langs', () => {
  for (const t of ['image', 'video', 'document', 'sticker', 'location', 'vcard']) {
    assert.equal(brugEchtGesprek(t), true, t);
  }
});

test('een ONBEKEND type komt erdoor, met opzet', () => {
  // Weigerlijst, geen toelatingslijst. Een type dat WhatsApp volgend jaar
  // toevoegt moet zichtbaar worden in plaats van stil te verdwijnen: stil
  // laten vallen van iets echts is erger dan een systeemmelding te veel.
  assert.equal(brugEchtGesprek('iets_wat_nog_niet_bestaat'), true);
  assert.equal(apiEchtGesprek('iets_wat_nog_niet_bestaat'), true);
});

test('een ontbrekend type komt er ook door', () => {
  // whatsapp-web.js levert `type` niet altijd. Een bericht wegdoen omdat een
  // veld ontbrak is precies het stille verlies dat we niet willen.
  for (const t of [null, undefined, '']) {
    assert.equal(brugEchtGesprek(t), true, String(t));
    assert.equal(apiEchtGesprek(t), true, String(t));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEELING BLIJFT GELIJK
// ═══════════════════════════════════════════════════════════════════════════

test('brug en endpoint kennen exact dezelfde lijst', () => {
  assert.deepEqual([...BRUG_TYPES].sort(), [...API_TYPES].sort());
});

test('en oordelen exact hetzelfde', () => {
  const proef = ['chat', 'ptt', 'audio', 'image', 'e2e_notification', 'gp2', 'protocol',
                 'ciphertext', 'revoked', 'call_log', 'unknown', 'nieuw_type', '', null, undefined];
  for (const t of proef) {
    assert.equal(brugEchtGesprek(t), apiEchtGesprek(t), String(t));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// OP ALLE DRIE DE PADEN, EN NA HET PRIVACYFILTER
// ═══════════════════════════════════════════════════════════════════════════

test('de weigering staat op alle drie de handlers', () => {
  const b = readFileSync(WA, 'utf8');
  for (const ev of ['message', 'message_create', 'message_ack']) {
    assert.match(b, new RegExp("isSysteemBericht\\('" + ev + "'"), ev);
  }
});

test('de weigering staat NA leadlijst.mag, op elk pad', () => {
  // De privacyvolgorde verschuift niet. Het filter blijft de eerste regel; dit
  // is de tweede.
  const b = readFileSync(WA, 'utf8');
  for (const ev of ['message', 'message_create', 'message_ack']) {
    const i = b.indexOf("client.on('" + ev + "'");
    assert.ok(i > 0, ev);
    const blok = b.slice(i, i + 2600);
    const filter = blok.indexOf('leadlijst.mag(');
    const systeem = blok.indexOf("isSysteemBericht('" + ev + "'");
    assert.ok(filter > 0 && systeem > 0, ev + ': allebei horen erin te staan');
    assert.ok(filter < systeem, ev + ': het privacyfilter blijft de eerste regel');
  }
});

test('een ack op een systeemtype telt ook niet mee', () => {
  const b = readFileSync(WA, 'utf8');
  const i = b.indexOf("client.on('message_ack'");
  const blok = b.slice(i, i + 2000);
  assert.ok(blok.indexOf("isSysteemBericht('message_ack'") < blok.indexOf('bouwAckGebeurtenis(msg, ack)'),
    'weigeren vóór er een gebeurtenis van gemaakt wordt');
});

test('een systeemtype belandt ook niet in de historiek', () => {
  // Het raakt de poging-telling niet aan, maar zou wel als lege bubbel in het
  // gesprek verschijnen — iets in de draad wat niemand gezegd heeft.
  assert.equal(bouwHistoriekBericht(e2e), null);
  const echt = bouwHistoriekBericht({ ...e2e, type: 'chat', body: 'Hoi' });
  assert.ok(echt && echt.tekst === 'Hoi', 'een echt bericht blijft gewoon');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT WEIGERT HET NOG EEN KEER
// ═══════════════════════════════════════════════════════════════════════════

test('het endpoint controleert het opnieuw, los van de brug-versie', () => {
  // De brug draait op een VPS en loopt altijd achter op een deploy. De
  // juistheid van de cijfers mag niet afhangen van wanneer daar voor het laatst
  // een pull is gedaan.
  const b = readFileSync(HOOK, 'utf8');
  assert.match(b, /import \{ isEchtGesprek \} from '\.\/_lib\/whatsapp-systeemtypes\.js'/);
  assert.match(b, /if \(!isEchtGesprek\(b\.media_type\)\)/);
});

test('het endpoint antwoordt 200, niet 400', () => {
  // De brug heeft niets fout gedaan: hij gaf door wat WhatsApp hem gaf.
  const b = readFileSync(HOOK, 'utf8');
  const i = b.indexOf('if (!isEchtGesprek(b.media_type))');
  const blok = b.slice(i, i + 400);
  assert.match(blok, /res\.status\(200\)/);
  assert.match(blok, /gekoppeld: false/);
  assert.match(blok, /reden: 'systeemtype'/, 'met de reden erbij, anders is het een stilte');
  assert.ok(!/status\(4\d\d\)/.test(blok));
});

test('de weigering staat vóór er een poging of gespreksregel geschreven wordt', () => {
  const b = readFileSync(HOOK, 'utf8');
  const systeem = b.indexOf('if (!isEchtGesprek(b.media_type))');
  assert.ok(systeem > 0);
  assert.ok(systeem < b.indexOf('bewaarGesprekRegel('), 'vóór de gespreksregel');
  assert.ok(systeem < b.indexOf('zoekTaak(nummer)'), 'en vóór er überhaupt een taak bij gezocht wordt');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE METING: WELK TYPE IS GEWEIGERD, EN HOE VAAK
// ═══════════════════════════════════════════════════════════════════════════

test('de tellers houden per systeemtype bij hoe vaak hij langskwam', () => {
  // Zonder dit zegt de teller alleen DAT er iets geweigerd is. Dan is niet te
  // zien of de weigerlijst aangevuld moet worden, en dat is precies de vraag
  // die een weigerlijst openhoudt.
  const t = maakTellers();
  t.systeemtype('e2e_notification');
  t.systeemtype('e2e_notification');
  t.systeemtype('gp2');
  assert.deepEqual(t.status().systeem_types, { e2e_notification: 2, gp2: 1 });
});

test("'systeemtype' is een geldige reden en telt per event-type", () => {
  const t = maakTellers();
  t.negeer('message', 'systeemtype', '32470123456@c.us');
  assert.equal(t.status().genegeerd.message.systeemtype, 1);
});

test('de teller draagt ALLEEN het type, nooit een nummer of tekst', () => {
  const t = maakTellers();
  t.systeemtype('e2e_notification');
  t.negeer('message', 'systeemtype', '32470123456@c.us');
  const s = JSON.stringify(t.status());
  assert.ok(!s.includes('32470123456'), 'geen nummer');
  assert.ok(!/[A-Za-z]{2,}\s[A-Za-z]{2,}\s[A-Za-z]{2,}/.test(s), 'geen zinnen');
});

test('een verzonnen type kan de tellers niet volschrijven', () => {
  const t = maakTellers();
  t.systeemtype('x'.repeat(200));
  t.systeemtype('met spaties en <html>');
  t.systeemtype('32470123456');
  const k = Object.keys(t.status().systeem_types);
  assert.ok(!k.some((x) => x.length > 40), 'niets langer dan 40');
  assert.ok(!k.includes('met spaties en <html>'));
  assert.deepEqual(k, ['32470123456'].filter((x) => /^[a-z0-9_]+$/.test(x)),
    'alleen wat op een protocolwoord lijkt');
});

test('een ontbrekend type krijgt een eigen bak, geen lege sleutel', () => {
  const t = maakTellers();
  t.systeemtype(null);
  t.systeemtype('');
  assert.deepEqual(t.status().systeem_types, { geen_type: 2 });
});
