// tests/iris-verzonden-map.test.js
//
// De kopie in de map Verzonden.
//
// Het gat dat dit dicht: onze uitgaande mail gaat via Strato's SMTP en belandt
// nergens in de mailbox zelf. Wie in Thunderbird kijkt of op zijn telefoon,
// ziet zijn eigen antwoord niet — en dan antwoordt iemand een tweede keer
// omdat hij denkt dat het eerste nooit weg is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VERZONDEN_NAMEN,
  kiesVerzondenMap,
  bouwRfc822,
  codeerKop,
  zetInVerzonden,
} from '../api/_lib/iris/verzonden-map.js';

// ── de map kiezen ───────────────────────────────────────────────────────────

test('de bijzondere aanduiding van de server wint altijd', () => {
  // \\Sent komt van de server zelf en hangt niet af van een taalinstelling.
  const map = kiesVerzondenMap([
    { path: 'Verzonden' },
    { path: 'Een Rare Naam', specialUse: '\\Sent' },
    { path: 'Sent' },
  ]);
  assert.equal(map, 'Een Rare Naam');
});

test('zonder aanduiding wordt op naam gezocht, in volgorde', () => {
  assert.equal(kiesVerzondenMap([{ path: 'INBOX' }, { path: 'Sent' }]), 'Sent');
  assert.equal(kiesVerzondenMap([{ path: 'INBOX' }, { path: 'Verzonden' }]), 'Verzonden');
  assert.equal(kiesVerzondenMap([{ path: 'INBOX' }, { path: 'Gesendet' }]), 'Gesendet');
});

test('hoofdletters in de mapnaam maken niet uit', () => {
  assert.equal(kiesVerzondenMap([{ path: 'SENT' }]), 'SENT');
  assert.equal(kiesVerzondenMap([{ path: 'verzonden' }]), 'verzonden');
});

test('een map onder een voorvoegsel wordt ook gevonden', () => {
  // Sommige servers hangen alles onder INBOX. of onder een ander voorvoegsel.
  assert.equal(kiesVerzondenMap([{ path: 'INBOX.Sent' }]), 'INBOX.Sent');
  assert.equal(kiesVerzondenMap([{ path: 'Mail/Sent' }]), 'Mail/Sent');
});

test('geen verzonden-map geeft null, geen gok op de eerste de beste', () => {
  // Een kopie in de verkeerde map is erger dan geen kopie: dan staat je
  // antwoord ineens tussen de inkomende post.
  assert.equal(kiesVerzondenMap([{ path: 'INBOX' }, { path: 'Prullenbak' }]), null);
  assert.equal(kiesVerzondenMap([]), null);
  assert.equal(kiesVerzondenMap(null), null);
});

test('de lijst met namen dekt Nederlands, Engels en Duits', () => {
  const laag = VERZONDEN_NAMEN.map((n) => n.toLowerCase());
  assert.ok(laag.some((n) => n.includes('sent')));
  assert.ok(laag.some((n) => n.includes('verzonden')));
  assert.ok(laag.some((n) => n.includes('gesendet')));
});

// ── de koptekst coderen ─────────────────────────────────────────────────────

test('een onderwerp zonder accenten blijft zoals het is', () => {
  assert.equal(codeerKop('Vraag over je factuur'), 'Vraag over je factuur');
});

test('een onderwerp met accenten wordt gecodeerd', () => {
  // Zonder dit staat er rommel in de map. De mail werkt dan nog; leesbaar is
  // hij niet, en precies dat ondermijnt het vertrouwen dat deze kopie moet geven.
  const r = codeerKop('Vraag over je factuur — bedrag');
  assert.match(r, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(r.slice(10, -2), 'base64').toString('utf8'), 'Vraag over je factuur — bedrag');
});

test('een leeg onderwerp geeft een lege tekst', () => {
  assert.equal(codeerKop(''), '');
  assert.equal(codeerKop(null), '');
});

// ── het bericht bouwen ──────────────────────────────────────────────────────

const BASIS = {
  van: 'administratie@deforexopleiding.nl',
  naar: 'jan@example.com',
  onderwerp: 'Je factuur',
  tekst: 'Dag Jan,\n\nEr staat nog iets open.\n\nMet vriendelijke groet',
  messageId: '<abc@deforexopleiding.nl>',
  datum: new Date('2026-09-21T12:00:00Z'),
};

test('het bericht draagt de verplichte kopregels', () => {
  const r = bouwRfc822(BASIS);
  assert.match(r, /^From: administratie@deforexopleiding\.nl/m);
  assert.match(r, /^To: jan@example\.com/m);
  assert.match(r, /^Subject: Je factuur/m);
  assert.match(r, /^Date: /m);
  assert.match(r, /^Message-ID: <abc@deforexopleiding\.nl>/m);
});

test('de inhoud gaat als base64 mee, zodat accenten heel blijven', () => {
  const r = bouwRfc822({ ...BASIS, tekst: 'Beste Sofie, héél graag zelfs — tot dan.' });
  assert.match(r, /Content-Transfer-Encoding: base64/);
  const body = r.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Beste Sofie, héél graag zelfs — tot dan.');
});

test('meerdere ontvangers worden met een komma gescheiden', () => {
  const r = bouwRfc822({ ...BASIS, naar: ['a@x.nl', 'b@y.nl'] });
  assert.match(r, /^To: a@x\.nl, b@y\.nl/m);
});

test('een antwoord draagt In-Reply-To én References', () => {
  // Zonder die twee begint elk antwoord een nieuw gesprek in de mailbox van
  // de klant, en dan staat de geschiedenis wél bij ons en niet bij hem.
  const r = bouwRfc822({ ...BASIS, inReplyTo: '<eerder@example.com>' });
  assert.match(r, /^In-Reply-To: <eerder@example\.com>/m);
  assert.match(r, /^References: <eerder@example\.com>/m);
});

test('zonder antwoord-verwijzing staan die kopregels er niet', () => {
  const r = bouwRfc822(BASIS);
  assert.doesNotMatch(r, /In-Reply-To/);
});

test('de kopregels en de inhoud worden gescheiden door een lege regel', () => {
  const r = bouwRfc822(BASIS);
  assert.ok(r.includes('\r\n\r\n'), 'zonder lege regel is het geen geldig bericht');
});

test('lange inhoud wordt afgebroken op regels van 76 tekens', () => {
  const r = bouwRfc822({ ...BASIS, tekst: 'a'.repeat(1000) });
  const body = r.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  for (const regel of body.split('\r\n')) {
    assert.ok(regel.length <= 76, `regel van ${regel.length} tekens is te lang voor SMTP`);
  }
});

// ── neerzetten zonder omgeving ──────────────────────────────────────────────

test('een onbekende mailbox wordt geweigerd, met naam', async () => {
  const r = await zetInVerzonden({ mailbox: 'verzonnen@elders.nl', naar: 'a@b.nl', onderwerp: 'x', tekst: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.reden, /onbekende mailbox/);
});

test('een ontbrekende omgevingsvariabele wordt bij NAAM gemeld, nooit bij waarde', async () => {
  const bewaard = { host: process.env.IMAP_HOST, pas: process.env.IMAP_PASS_ADMINISTRATIE };
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_PASS_ADMINISTRATIE;
  try {
    const r = await zetInVerzonden({ mailbox: 'administratie@deforexopleiding.nl', naar: 'a@b.nl', onderwerp: 'x', tekst: 'y' });
    assert.equal(r.ok, false);
    assert.match(r.reden, /IMAP_HOST|IMAP_PASS_ADMINISTRATIE/);
  } finally {
    if (bewaard.host !== undefined) process.env.IMAP_HOST = bewaard.host;
    if (bewaard.pas !== undefined) process.env.IMAP_PASS_ADMINISTRATIE = bewaard.pas;
  }
});

test('het neerzetten gooit nooit — de mail is op dat moment al weg', async () => {
  // Deze functie draait ná de verzending. Een fout hier verandert niets aan
  // wat de klant gekregen heeft, dus hij mag nooit iets omvergooien.
  const r = await zetInVerzonden({});
  assert.equal(typeof r.ok, 'boolean');
  assert.equal(r.ok, false);
});
