// tests/gesprekken-ongelezen-uit-databank.test.js
//
// De gesprekkenlijst laadde in ~20 seconden. Dit was waarom.
//
// ── DE METING ───────────────────────────────────────────────────────────────
// `inbox-conversations-list` deed zes verrijkingen. Vijf daarvan zijn
// databankvragen; de zesde was een LIVE IMAP-verbinding naar Strato:
//
//     client.connect()                       // TLS-handshake
//     client.getMailboxLock('INBOX')
//     client.fetch({ since: 2026-01-01 },    // envelope+flags van ELK bericht
//                  { envelope: true, flags: true, uid: true })
//
// met `socketTimeout: 9000` en een cache van 60 s in een module-scope Map.
// Die cache leeft PER VERCEL-INSTANTIE, en de module pollt elke zes seconden —
// dus op een koude instantie betaalde de gebruiker de hele mailscan opnieuw.
//
// ── WAAROM HET ZONDER KAN ───────────────────────────────────────────────────
// `sync-emails` draait elke vijf minuten, leest alleen INBOX, en schrijft per
// bericht `is_read` (de \Seen-flag), `customer_id` en `mailbox`. Dezelfde vraag
// — hoeveel ongelezen berichten van deze klant staan er in de mailbox van deze
// module — is dus een indexeerbare query.
//
// ── WAT ERVOOR INGELEVERD WORDT, EXPLICIET ──────────────────────────────────
// Markeer je een mail als gelezen in WEBMAIL, dan ging de badge voorheen
// binnen een minuut uit en nu binnen vijf. Markeren vanuit de module zelf is
// wél meteen goed: inbox-email-mark-read zet `is_read` nu ook in de databank.
// Daar staat hieronder een toets op, want zonder dat stukje is de wissel een
// verslechtering van de knop die mensen wél gebruiken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MODULE_MAILBOX, MAILBOX_MODULES, mailboxVoorModule, mailboxLabel,
} from '../api/_lib/module-mailbox.js';

const LIJST = readFileSync(new URL('../api/inbox-conversations-list.js', import.meta.url), 'utf8');
const MARK  = readFileSync(new URL('../api/inbox-email-mark-read.js', import.meta.url), 'utf8');
const HELP  = readFileSync(new URL('../api/_lib/email-unread-per-customer.js', import.meta.url), 'utf8');
const SYNC  = readFileSync(new URL('../api/sync-emails.js', import.meta.url), 'utf8');

const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

const C_LIJST = code(LIJST);
const C_MARK  = code(MARK);

/* ── 1. geen IMAP meer in het gebruikersverzoek ───────────────────────────── */

test('de lijst opent geen IMAP-verbinding meer', () => {
  for (const verboden of ['getEmailUnreadByCustomerEmail', 'email-unread-per-customer', 'ImapFlow', 'imapFlow']) {
    assert.ok(!C_LIJST.includes(verboden), `de lijst raakt ${verboden} nog aan`);
  }
});

test('de ongelezen-teller komt uit email_messages, met de drie filters die hem kloppend maken', () => {
  // Ankeren op CODE, niet op een commentaarkop: C_LIJST heeft het commentaar
  // er al af, dus 'Brief-status-verrijking' bestaat daar niet meer. Precies de
  // val uit les 13, nu in mijn eigen toets.
  const blok = C_LIJST.slice(C_LIJST.indexOf('emailUnreadByCustomer'), C_LIJST.indexOf("from('dunning_briefs')"));
  assert.match(blok, /from\('email_messages'\)/);
  assert.match(blok, /\.eq\('mailbox', mbLabel\)/, 'zonder mailbox-filter telt hij andere postbussen mee');
  assert.match(blok, /\.eq\('is_read', false\)/, 'zonder is_read-filter telt hij alles mee');
  assert.match(blok, /\.in\('customer_id', blok\)/, 'in blokken, zoals de rest van het endpoint');
});

test('de teller hangt aan customer_id, niet aan een e-mailadres', () => {
  // Dat is de sleutel die de rij toch al heeft, en een klant met twee adressen
  // telt zo in één keer goed.
  assert.match(C_LIJST, /const emailUnread = row\.customer_id \? \(emailUnreadByCustomer\.get\(row\.customer_id\) \|\| 0\) : 0;/);
  assert.ok(!C_LIJST.includes('emailUnreadByEmail'), 'de oude per-adres-map staat er nog');
});

test('een module zonder mailbox levert een waarschuwing, geen stille nul', () => {
  assert.match(C_LIJST, /heeft geen mailbox/);
  assert.match(C_LIJST, /email_unread_warning: emailUnreadWarning/);
});

test('een mislukt blok telt niet stil als nul', () => {
  const blok = C_LIJST.slice(C_LIJST.indexOf('const unreadBlokken'), C_LIJST.indexOf("from('dunning_briefs')"));
  assert.match(blok, /if \(r\.error\)/);
  assert.match(blok, /emailUnreadWarning = 'email-unread blok mislukt/);
});

/* ── 2. de klik blijft meteen werken ─────────────────────────────────────── */

test('mark-read zet is_read OOK in de databank', () => {
  // Zonder dit duurt het tot de volgende sync (vijf minuten) voor je eigen
  // klik zichtbaar wordt, en dan is het een knop waarvan je denkt dat hij
  // niet werkt.
  assert.match(C_MARK, /from\('email_messages'\)[\s\S]{0,200}?\.update\(\{ is_read: true \}\)/);
});

test('die update is scherp begrensd: deze klant, deze mailbox, alleen ongelezen', () => {
  const blok = C_MARK.slice(C_MARK.indexOf("\.update({ is_read: true })"));
  assert.match(blok, /\.eq\('customer_id', customerId\)/);
  assert.match(blok, /\.eq\('mailbox', acct\.mailboxLabel\)/);
  assert.match(blok, /\.eq\('is_read', false\)/, 'zonder deze filter raakt de update ook al-gelezen rijen');
});

test('een mislukte DB-update laat de IMAP-markering staan', () => {
  // De \Seen-flag is gezet; dat terugdraaien omdat de spiegel hikte, zou een
  // fout geven voor iets dat gelukt is.
  assert.match(C_MARK, /is_read in databank niet gezet/);
  assert.match(C_MARK, /console\.warn\('\[inbox-email-mark-read\] is_read/);
});

test('IMAP blijft de bron van waarheid — de STORE staat er nog', () => {
  assert.match(C_MARK, /addFlags|messageFlagsAdd|\\\\Seen/);
});

/* ── 3. één mailboxkaart, en de val die hij wegneemt ─────────────────────── */

test('finance heet in email_messages administratie — niet finance, niet het hele adres', () => {
  // Dit is de val. Een filter met de verkeerde van de twee namen geeft geen
  // fout maar nul rijen, en nul ongelezen mail ziet eruit als goed nieuws.
  assert.equal(mailboxLabel('finance'), 'administratie');
  assert.equal(mailboxVoorModule('finance').user, 'administratie@deforexopleiding.nl');
  assert.notEqual(mailboxLabel('finance'), 'finance');
  assert.notEqual(mailboxLabel('finance'), 'administratie@deforexopleiding.nl');
});

test('de drie modules hebben allemaal een label en een adres', () => {
  assert.deepEqual([...MAILBOX_MODULES].sort(), ['events', 'finance', 'onboarding']);
  for (const m of MAILBOX_MODULES) {
    assert.ok(MODULE_MAILBOX[m].label, `${m} heeft geen label`);
    assert.match(MODULE_MAILBOX[m].user, /@deforexopleiding\.nl$/);
    assert.match(MODULE_MAILBOX[m].passEnv, /^IMAP_PASS_/);
  }
});

test('een onbekende module geeft null, geen gok', () => {
  for (const ruw of ['sales', '', null, undefined, 'FINANCE ', 42, {}]) {
    const uit = mailboxVoorModule(ruw);
    if (String(ruw || '').trim().toLowerCase() === 'finance') continue;
    assert.equal(uit, null, `${JSON.stringify(ruw)} gaf een mailbox`);
  }
  // en met rommel eromheen wél, want dat is een tikfout en geen andere module
  assert.equal(mailboxLabel('  FINANCE  '), 'administratie');
});

test('de labels kloppen met wat sync-emails wegschrijft', () => {
  // sync-emails is wat `email_messages.mailbox` vult. Lopen die twee uit
  // elkaar, dan telt de lijst in een postbus die niet bestaat.
  for (const m of MAILBOX_MODULES) {
    const label = MODULE_MAILBOX[m].label;
    const user = MODULE_MAILBOX[m].user;
    assert.match(SYNC, new RegExp(`mailbox: '${label}',\\s*user: '${user.replace(/[.@]/g, '\\$&')}'`),
      `sync-emails kent de combinatie ${label} / ${user} niet`);
  }
});

test('de kaart staat op ÉÉN plek — de twee oude kopieën zijn weg', () => {
  // inbox-email-mark-read had een eigen kopie met "Bij uitbreiding update
  // BEIDE files" erboven. Met een derde gebruiker is dat een opdracht die
  // iemand een keer half uitvoert.
  assert.match(C_MARK, /from '\.\/_lib\/module-mailbox\.js'/);
  assert.ok(!/user: 'administratie@deforexopleiding\.nl'/.test(C_MARK),
    'mark-read heeft nog een eigen adressenlijst');
  assert.match(HELP, /MODULE_ACCOUNTS = MODULE_MAILBOX/);
  assert.ok(!/passEnv: 'IMAP_PASS_ADMINISTRATIE'/.test(code(HELP)),
    'de IMAP-helper heeft nog een eigen adressenlijst');
});

test('het recht per module blijft waar het hoort', () => {
  // De mailbox is gedeeld; welk recht een endpoint vraagt is van dat endpoint.
  assert.match(C_MARK, /MODULE_PERM = Object\.freeze\(\{/);
  assert.match(C_MARK, /finance:\s*'finance\.inbox\.view'/);
  assert.ok(!/permKey/.test(code(readFileSync(new URL('../api/_lib/module-mailbox.js', import.meta.url), 'utf8'))),
    'de gedeelde kaart weet nu van rechten — dat hoort er niet in');
});
