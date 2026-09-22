// tests/gesprekken-verzondenkopie.test.js
//
// De kopie in de map Verzonden, voor de knop waar een mens op drukt.
//
// Het gat: api/send-email.js verstuurt via Strato en schrijft een regel in
// email_replies. Strato zet uitgaande mail nergens in de mailbox zelf neer, dus
// wie in Thunderbird kijkt of op zijn telefoon, ziet zijn eigen antwoord niet —
// en antwoordt een tweede keer omdat niets laat zien dat er al geantwoord is.
//
// Wat hier vastligt is vooral wat er stil kan breken: een kopie die de bijlage
// kwijt is, of een kopie met een eigen Message-ID die als los bericht naast het
// origineel komt te staan. Allebei erger dan geen kopie, want allebei liegen ze
// over wat er verstuurd is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  magKopieMaken,
  kopieOpdracht,
  bouwRauweKopie,
  normaliseerRegeleindes,
  plaatsKopieInVerzonden,
} from '../api/_lib/gesprekken-verzondenkopie.js';

const OPDRACHT = {
  from: '"De Forex Opleiding" <administratie@deforexopleiding.nl>',
  to: 'jan@voorbeeld.be',
  subject: 'Je factuur',
  text: 'Dag Jan,\n\nGroeten',
  replyTo: 'administratie@deforexopleiding.nl',
};

// ── de vlag ─────────────────────────────────────────────────────────────────

test('zonder vlag geen kopie — dit is exact het gedrag van vandaag', () => {
  assert.equal(magKopieMaken({}), false);
  assert.equal(magKopieMaken({ GESPREKKEN_V2: '' }), false);
  assert.equal(magKopieMaken({ GESPREKKEN_V2: 'false' }), false);
  // Half aan bestaat niet. Alleen het hele woord telt.
  assert.equal(magKopieMaken({ GESPREKKEN_V2: '1' }), false);
  assert.equal(magKopieMaken({ GESPREKKEN_V2: 'ja' }), false);
  assert.equal(magKopieMaken({ GESPREKKEN_V2: 'true' }), true);
});

// ── de opdracht voor de kopie ───────────────────────────────────────────────

test('het Message-ID van de verstuurde mail gaat mee naar de kopie', () => {
  // Dit is het ene ding dat stil breekt. Zonder dit krijgt de kopie een nieuw
  // id en staat hij in Thunderbird als tweede, losstaand bericht naast het
  // origineel — precies de verwarring die deze kopie moet wegnemen.
  const o = kopieOpdracht(OPDRACHT, { messageId: '<abc@deforexopleiding.nl>' });
  assert.equal(o.messageId, '<abc@deforexopleiding.nl>');
});

test('de opdracht die verstuurd is, wordt niet aangeraakt', () => {
  const origineel = { ...OPDRACHT };
  kopieOpdracht(OPDRACHT, { messageId: '<x@y.nl>', datum: new Date() });
  assert.deepEqual(OPDRACHT, origineel);
});

test('zonder Message-ID blijft het veld weg in plaats van leeg', () => {
  // Een leeg messageId laat nodemailer er geen maken; dan staat er helemaal
  // geen kopregel in en is het bericht ongeldig.
  const o = kopieOpdracht(OPDRACHT, { messageId: null });
  assert.equal('messageId' in o, false);
});

// ── het bericht opbouwen ────────────────────────────────────────────────────

test('de kopie is hetzelfde bericht: opmaak, kopieontvanger en bijlage blijven', async () => {
  // Een kopie zonder de bijlage is de gevaarlijkste soort: je ziet in
  // Verzonden dat je geantwoord hebt en neemt aan dat het contract meeging.
  const rauw = await bouwRauweKopie(kopieOpdracht({
    ...OPDRACHT,
    cc: 'collega@deforexopleiding.nl',
    html: '<p>Dag Jan</p>',
    attachments: [{ filename: 'factuur.pdf', content: Buffer.from('%PDF-1.4'), contentType: 'application/pdf' }],
  }, { messageId: '<abc@deforexopleiding.nl>' }));

  assert.ok(Buffer.isBuffer(rauw), 'er moeten bytes uitkomen');
  const s = rauw.toString('utf8');
  assert.match(s, /^Message-ID: <abc@deforexopleiding\.nl>/m);
  assert.match(s, /^Cc: collega@deforexopleiding\.nl/m);
  assert.match(s, /^To: jan@voorbeeld\.be/m);
  assert.ok(s.includes('<p>Dag Jan</p>'), 'de opmaak hoort in de kopie');
  assert.match(s, /filename=.?factuur\.pdf/, 'de bijlage hoort in de kopie');
  assert.match(s, /application\/pdf/);
});

test('een onderwerp met accenten blijft leesbaar', async () => {
  const rauw = await bouwRauweKopie(kopieOpdracht({ ...OPDRACHT, subject: 'Vraag over je factuur — héél kort' }));
  const kop = rauw.toString('utf8').split('\r\n').find((r) => r.startsWith('Subject:'));
  assert.ok(kop, 'er hoort een onderwerp-kopregel te staan');
  // Gecodeerd (=?UTF-8?…) of letterlijk mag allebei; rommel niet.
  assert.doesNotMatch(kop, /Ã|â€/, 'verkeerd gecodeerd onderwerp leest als rommel');
});

test('de regels eindigen op CRLF, want dat is wat IMAP wil', async () => {
  const rauw = await bouwRauweKopie(kopieOpdracht(OPDRACHT));
  const s = rauw.toString('utf8');
  assert.ok(s.includes('\r\n'), 'geen enkele CRLF betekent een bericht dat de server weigert');
  assert.doesNotMatch(s, /[^\r]\n/, 'een kale LF hoort er niet in te zitten');
});

test('kale regeleindes worden rechtgetrokken, de inhoud blijft heel', () => {
  // Dit is het geval dat in de praktijk voorkomt: de tekst komt uit een
  // webformulier en heeft dus kale LF's. Bij het versturen trekt de SMTP-laag
  // dat alsnog recht; bij een APPEND doet niemand dat, en dan oogt de kopie in
  // je mailprogramma als één lange regel — of wordt hij geweigerd.
  const r = normaliseerRegeleindes(Buffer.from('een\ntwee\r\ndrie\rvier', 'utf8'));
  assert.equal(r.toString('utf8'), 'een\r\ntwee\r\ndrie\r\nvier');
  // Geen verdubbeling bij herhaald toepassen.
  assert.equal(normaliseerRegeleindes(r).toString('utf8'), r.toString('utf8'));
});

test('de tekst van het bericht komt ongeschonden in de kopie', async () => {
  const rauw = await bouwRauweKopie(kopieOpdracht({ ...OPDRACHT, text: 'Dag Jan,\n\nEr staat nog iets open.\n\nGroeten' }));
  const s = rauw.toString('utf8');
  assert.ok(s.includes('Er staat nog iets open.'), 'de inhoud hoort er gewoon in te staan');
  assert.ok(s.includes('Dag Jan,\r\n\r\nEr staat'), 'de lege regel tussen alinea\u2019s hoort te blijven');
});

test('een blinde kopieontvanger blijft in ONZE kopie staan', async () => {
  // De echte verzending haalt die kopregel eruit, anders zien de ontvangers
  // wie er meelas. Deze bytes gaan alleen naar onze eigen map Verzonden, en
  // daar wil je later juist kunnen terugzien wie je meegestuurd hebt.
  const rauw = await bouwRauweKopie(kopieOpdracht({ ...OPDRACHT, bcc: 'boekhouder@elders.nl' }));
  assert.match(rauw.toString('utf8'), /^Bcc: boekhouder@elders\.nl/m);
});

test('een antwoord draagt In-Reply-To mee, zodat het bij de draad blijft', async () => {
  const rauw = await bouwRauweKopie(kopieOpdracht({
    ...OPDRACHT, inReplyTo: '<eerder@voorbeeld.be>', references: '<eerder@voorbeeld.be>',
  }));
  assert.match(rauw.toString('utf8'), /^In-Reply-To: <eerder@voorbeeld\.be>/m);
});

// ── nooit iets omvergooien ──────────────────────────────────────────────────

test('een onbekende mailbox levert geen kopie en geen uitzondering', async () => {
  const r = await plaatsKopieInVerzonden({ mailbox: 'verzonnen@elders.nl', verzendOpdracht: OPDRACHT });
  assert.equal(r.ok, false);
  assert.match(r.reden, /onbekende mailbox/);
});

test('een ontbrekende omgevingsvariabele wordt bij NAAM gemeld, nooit bij waarde', async () => {
  const bewaard = { host: process.env.IMAP_HOST, pas: process.env.IMAP_PASS_ADMINISTRATIE };
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_PASS_ADMINISTRATIE;
  try {
    const r = await plaatsKopieInVerzonden({
      mailbox: 'administratie@deforexopleiding.nl', verzendOpdracht: OPDRACHT,
    });
    assert.equal(r.ok, false);
    assert.match(r.reden, /IMAP_HOST|IMAP_PASS_ADMINISTRATIE/);
  } finally {
    if (bewaard.host !== undefined) process.env.IMAP_HOST = bewaard.host;
    if (bewaard.pas !== undefined) process.env.IMAP_PASS_ADMINISTRATIE = bewaard.pas;
  }
});

test('onzin erin gooit niets om — de mail is op dat moment al weg', async () => {
  // Deze functie draait ná de verzending. Wat er ook misgaat, het verandert
  // niets aan wat de ontvanger gekregen heeft, dus hij mag nooit gooien.
  for (const arg of [{}, { mailbox: null, verzendOpdracht: null }, { mailbox: 'info@deforexopleiding.nl' }]) {
    const r = await plaatsKopieInVerzonden(arg);
    assert.equal(typeof r?.ok, 'boolean');
    assert.equal(r.ok, false);
  }
});

// ── de bedrading in send-email.js ───────────────────────────────────────────

const BRON = readFileSync(new URL('../api/send-email.js', import.meta.url), 'utf8');

test('de kopie zit achter de vlag', () => {
  assert.match(BRON, /if \(magKopieMaken\(process\.env\)\)/);
});

test('de kopie wordt pas gemaakt NA een geslaagde verzending', () => {
  // Een kopie in Verzonden van een mail die nooit weg is, is een leugen die
  // erger is dan het gat dat we dichten.
  const verstuur = BRON.indexOf('await transporter.sendMail(mailOpts)');
  const kopie = BRON.indexOf('plaatsKopieInVerzonden({');
  assert.ok(verstuur > 0 && kopie > 0, 'beide aanroepen horen er te staan');
  assert.ok(kopie > verstuur, 'de kopie staat vóór de verzending');
});

test('er wordt niet op de kopie gewacht', () => {
  // Een IMAP-verbinding kost seconden. De gebruiker hoort daar niet op te
  // staan wachten voor iets dat aan zijn verzending niets meer verandert.
  assert.doesNotMatch(BRON, /await\s+plaatsKopieInVerzonden/);
  assert.match(BRON, /waitUntil\(kopie\)/);
});

test('een mislukte kopie wordt gemeld in de logs', () => {
  // Zonder dit is een ontbrekende IMAP_HOST een stilte: de kopie komt er
  // nooit, en het lijkt alsof de vlag niets doet.
  assert.match(BRON, /geen kopie in Verzonden/);
});
