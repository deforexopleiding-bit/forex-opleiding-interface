// tests/gesprekken-leesstand.test.js
//
// Gelezen / ongelezen in de gesprekkenmodule (29 okt 2026).
//
// ── DE METING ───────────────────────────────────────────────────────────────
// Bij openen riep Wanbetalers › Gesprekken per mail
// `/api/email-actions {action:'mark-read'}` aan. Dat endpoint voegt enkel een
// auditregel in `email_actions` in en antwoordt 200 {ok:true};
// `email_messages.is_read` bleef false. In productie: 3.676 auditregels,
// mail 183fcedc… (Kyven Reigina) na zes "mark-read"s nog altijd ongelezen.
// Na herladen kwam dus elke badge terug.
//
// Nu zet /api/inbox-mark-read het hele gesprek in één call op gelezen, in de
// databank, en zet /api/inbox-mark-unread het laatste inkomende bericht terug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  markeerGesprekGelezen, markeerGesprekOngelezen, kiesOngelezenKanaal, mailboxenVoorGesprek,
} from '../api/_lib/gesprek-leesstand.js';

/* ── Een kleine nep-databank die de gebruikte PostgREST-ketens uitvoert ──── */

function nepDb(tabellen) {
  const db = JSON.parse(JSON.stringify(tabellen));
  return {
    db,
    from(tabel) {
      const filters = [];
      let actie = 'select';
      let waarden = null;
      let volgorde = null;
      let max = null;
      let enkel = false;
      const passend = () => (db[tabel] || []).filter((r) => filters.every((f) => f(r)));
      const voerUit = () => {
        let rijen = passend();
        if (actie === 'update') {
          for (const r of rijen) Object.assign(r, waarden);
        }
        if (volgorde) {
          const { kol, asc } = volgorde;
          rijen = rijen.slice().sort((a, b) => (a[kol] < b[kol] ? -1 : a[kol] > b[kol] ? 1 : 0) * (asc ? 1 : -1));
        }
        if (max != null) rijen = rijen.slice(0, max);
        const data = enkel ? (rijen[0] ? { ...rijen[0] } : null) : rijen.map((r) => ({ ...r }));
        return { data, error: null };
      };
      const b = {
        update(v) { actie = 'update'; waarden = v; return b; },
        select() { return b; },
        eq(k, v) { filters.push((r) => r[k] === v); return b; },
        gt(k, v) { filters.push((r) => Number(r[k]) > v); return b; },
        in(k, arr) { filters.push((r) => arr.includes(r[k])); return b; },
        not(k, op, pat) {
          assert.equal(op, 'ilike');
          const re = new RegExp('^' + pat.replace(/[.]/g, '\\.').replace(/%/g, '.*') + '$', 'i');
          filters.push((r) => r[k] != null && !re.test(r[k]));
          return b;
        },
        order(kol, o) { volgorde = { kol, asc: !!o?.ascending }; return b; },
        limit(n) { max = n; return b; },
        maybeSingle() { enkel = true; return Promise.resolve(voerUit()); },
        then(ok, fout) { return Promise.resolve(voerUit()).then(ok, fout); },
      };
      return b;
    },
  };
}

const KLANT = 'c1';
const KLANTNUMMER = '1399327383258229';
const HOOFDNUMMER = '1273723375834177';

function veronique() {
  // Naar de echte stand van Veronique Beheyt: drie gesprekken, 57 ongelezen
  // mails in administratie@, één mail in welkom@.
  const mails = [];
  for (let i = 0; i < 57; i++) {
    mails.push({ id: 'm' + i, customer_id: KLANT, mailbox: 'administratie', is_read: false,
      from_address: 'v@klant.be', date_received: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T08:00:00Z` });
  }
  mails.push({ id: 'w1', customer_id: KLANT, mailbox: 'welkom', is_read: false, from_address: 'v@klant.be', date_received: '2026-10-20T08:00:00Z' });
  mails.push({ id: 'x1', customer_id: 'ander', mailbox: 'administratie', is_read: false, from_address: 'a@b.nl', date_received: '2026-10-20T08:00:00Z' });
  return nepDb({
    whatsapp_conversations: [
      { id: 'open',   customer_id: KLANT, phone_number_id: KLANTNUMMER, unread_count: 2 },
      { id: 'dubbel', customer_id: KLANT, phone_number_id: KLANTNUMMER, unread_count: 3 },
      { id: 'leads',  customer_id: KLANT, phone_number_id: HOOFDNUMMER, unread_count: 5 },
      { id: 'vreemd', customer_id: 'ander', phone_number_id: KLANTNUMMER, unread_count: 4 },
    ],
    email_messages: mails,
  });
}

/* ── 1. gelezen: één call, alles van dit gesprek, in de databank ──────────── */

test('openen zet WA van de klant op dit nummer én alle ongelezen mail in de module-mailbox op gelezen', async () => {
  const sb = veronique();
  const conv = sb.db.whatsapp_conversations[0];
  const r = await markeerGesprekGelezen(sb, { conv, mailboxLabel: 'administratie' });

  assert.deepEqual(r.wa_gemarkeerd.sort(), ['dubbel', 'open']);
  assert.equal(r.mails_gemarkeerd, 57);
  const wa = Object.fromEntries(sb.db.whatsapp_conversations.map((c) => [c.id, c.unread_count]));
  assert.deepEqual(wa, { open: 0, dubbel: 0, leads: 5, vreemd: 4 },
    'gesprekken op een ander nummer (andere module) of van een andere klant blijven staan');
  const ongelezen = sb.db.email_messages.filter((m) => !m.is_read).map((m) => m.id).sort();
  assert.deepEqual(ongelezen, ['w1', 'x1'], 'andere mailbox en andere klant blijven ongelezen');
});

test('zonder module enkel WA (oude aanroepers veranderen niet van gedrag)', async () => {
  const sb = veronique();
  const r = await markeerGesprekGelezen(sb, { conv: sb.db.whatsapp_conversations[0], mailboxLabel: null });
  assert.equal(r.mails_gemarkeerd, 0);
  assert.equal(sb.db.email_messages.filter((m) => !m.is_read).length, 59);
});

test('gesprek zonder klant: enkel dat ene gesprek', async () => {
  const sb = nepDb({ whatsapp_conversations: [{ id: 'g', customer_id: null, phone_number_id: KLANTNUMMER, unread_count: 1 }], email_messages: [] });
  const r = await markeerGesprekGelezen(sb, { conv: sb.db.whatsapp_conversations[0], mailboxLabel: 'administratie' });
  assert.deepEqual(r, { wa_gemarkeerd: ['g'], mails_gemarkeerd: 0 });
});

test('een databankfout wordt een fout, geen stille ok', async () => {
  const kapot = { from: () => { const b = { update: () => b, select: () => b, eq: () => b, gt: () => b,
    then: (ok) => Promise.resolve({ data: null, error: { message: 'RLS' } }).then(ok) }; return b; } };
  await assert.rejects(markeerGesprekGelezen(kapot, { conv: { id: 'x' }, mailboxLabel: 'administratie' }), /RLS/);
});

/* ── 1b. zonder module: de mailbox volgt uit het nummer (29 okt, productie) ── */
//
// Nameting op productie: POST /api/inbox-mark-read {conversation_id} zonder
// module gaf mails_gemarkeerd=0, en de browser draaide nog v=69 uit de cache,
// die ook geen module meestuurt. "Gelezen" mag niet afhangen van wat de client
// meestuurt.

function config() {
  return [
    { module: 'finance',    phone_number_id: KLANTNUMMER, is_active: true },
    { module: 'onboarding', phone_number_id: KLANTNUMMER, is_active: true },
    { module: 'events',     phone_number_id: HOOFDNUMMER, is_active: true },
    { module: 'oud',        phone_number_id: KLANTNUMMER, is_active: false },
  ];
}

test('mailboxenVoorGesprek: met module die ene mailbox, zonder module die van het nummer', async () => {
  const sb = nepDb({ whatsapp_module_config: config() });
  const conv = { id: 'g', phone_number_id: KLANTNUMMER };
  assert.deepEqual(await mailboxenVoorGesprek(sb, { conv, module: 'finance' }), ['administratie']);
  assert.deepEqual((await mailboxenVoorGesprek(sb, { conv, module: '' })).sort(), ['administratie', 'onboarding']);
  assert.deepEqual(await mailboxenVoorGesprek(sb, { conv: { id: 'h', phone_number_id: HOOFDNUMMER } }), ['events']);
  assert.deepEqual(await mailboxenVoorGesprek(sb, { conv: { id: 'x', phone_number_id: null } }), []);
});

test('Kyven zonder module: de mail in administratie@ gaat op gelezen', async () => {
  const sb = nepDb({
    whatsapp_module_config: config(),
    whatsapp_conversations: [{ id: '9a116fbe', customer_id: 'kyven', phone_number_id: KLANTNUMMER, unread_count: 0 }],
    email_messages: [
      { id: '183fcedc', customer_id: 'kyven', mailbox: 'administratie', is_read: false, from_address: 'KReigina@hotmail.com' },
      { id: 'oud',      customer_id: 'kyven', mailbox: 'administratie', is_read: true,  from_address: 'KReigina@hotmail.com' },
    ],
  });
  const conv = sb.db.whatsapp_conversations[0];
  const mbs = await mailboxenVoorGesprek(sb, { conv, module: '' });
  const r = await markeerGesprekGelezen(sb, { conv, mailboxLabel: mbs });
  assert.equal(r.mails_gemarkeerd, 1);
  assert.equal(sb.db.email_messages[0].is_read, true);
});

/* ── 2. ongelezen: het laatste inkomende bericht, WA of mail ──────────────── */

test('kiesOngelezenKanaal: het laatst binnengekomen kanaal', () => {
  assert.equal(kiesOngelezenKanaal({ laatsteWaInboundAt: '2026-10-28T10:00:00Z', laatsteMailAt: '2026-10-29T10:00:00Z' }), 'email');
  assert.equal(kiesOngelezenKanaal({ laatsteWaInboundAt: '2026-10-29T10:00:00Z', laatsteMailAt: '2026-10-28T10:00:00Z' }), 'wa');
  assert.equal(kiesOngelezenKanaal({ laatsteWaInboundAt: null, laatsteMailAt: '2026-10-28T10:00:00Z' }), 'email');
  assert.equal(kiesOngelezenKanaal({ laatsteWaInboundAt: null, laatsteMailAt: null }), 'wa');
});

test('ongelezen met recentste mail: die mail terug op is_read=false, WA blijft 0', async () => {
  const sb = nepDb({
    whatsapp_conversations: [{ id: 'g', customer_id: KLANT, unread_count: 0, last_inbound_at: '2026-10-01T08:00:00Z' }],
    email_messages: [
      { id: 'oud',   customer_id: KLANT, mailbox: 'administratie', is_read: true, from_address: 'k@x.be', date_received: '2026-10-10T08:00:00Z' },
      { id: 'nieuw', customer_id: KLANT, mailbox: 'administratie', is_read: true, from_address: 'k@x.be', date_received: '2026-10-20T08:00:00Z' },
      { id: 'eigen', customer_id: KLANT, mailbox: 'administratie', is_read: true, from_address: 'administratie@deforexopleiding.nl', date_received: '2026-10-25T08:00:00Z' },
    ],
  });
  const r = await markeerGesprekOngelezen(sb, { conv: sb.db.whatsapp_conversations[0], mailboxLabel: 'administratie' });
  assert.deepEqual(r, { kanaal: 'email', email_id: 'nieuw', unread_count: 0 });
  const m = Object.fromEntries(sb.db.email_messages.map((x) => [x.id, x.is_read]));
  assert.deepEqual(m, { oud: true, nieuw: false, eigen: true }, 'onze eigen mail telt niet als inkomend');
});

test('ongelezen met recentste WA: unread_count naar 1, mail onaangeroerd', async () => {
  const sb = nepDb({
    whatsapp_conversations: [{ id: 'g', customer_id: KLANT, unread_count: 0, last_inbound_at: '2026-10-29T08:00:00Z' }],
    email_messages: [{ id: 'm', customer_id: KLANT, mailbox: 'administratie', is_read: true, from_address: 'k@x.be', date_received: '2026-10-20T08:00:00Z' }],
  });
  const r = await markeerGesprekOngelezen(sb, { conv: sb.db.whatsapp_conversations[0], mailboxLabel: 'administratie' });
  assert.deepEqual(r, { kanaal: 'wa', email_id: null, unread_count: 1 });
  assert.equal(sb.db.whatsapp_conversations[0].unread_count, 1);
  assert.equal(sb.db.email_messages[0].is_read, true);
});

test('ongelezen bij een hogere WA-teller overschrijft die niet (dubbele klik)', async () => {
  const sb = nepDb({ whatsapp_conversations: [{ id: 'g', customer_id: null, unread_count: 4, last_inbound_at: null }], email_messages: [] });
  const r = await markeerGesprekOngelezen(sb, { conv: sb.db.whatsapp_conversations[0], mailboxLabel: null });
  assert.equal(r.unread_count, 4);
  assert.equal(sb.db.whatsapp_conversations[0].unread_count, 4);
});

/* ── 3. de bedrading ──────────────────────────────────────────────────────── */

const code = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

test('de endpoints gebruiken de gedeelde leesstand en de module-mailbox', () => {
  const lees = code('api/inbox-mark-read.js');
  const onl  = code('api/inbox-mark-unread.js');
  assert.ok(lees.includes('markeerGesprekGelezen(supabaseAdmin'));
  assert.ok(onl.includes('markeerGesprekOngelezen(supabaseAdmin'));
  for (const s of [lees, onl]) {
    assert.ok(s.includes("mailboxLabel(moduleRaw)"));
    assert.ok(s.includes('mailboxenVoorGesprek(supabaseAdmin, { conv, module: moduleRaw })'),
      'de mailbox komt server-side, ook zonder module in de body');
  }
  assert.ok(onl.includes('last_inbound_at'), 'mark-unread heeft het laatste WA-moment nodig');
});

test('Wanbetalers › Gesprekken: één call bij openen, geen email-actions meer', () => {
  const s = code('modules/klanten-v2/views/wanbetalers-v2.js');
  assert.ok(!s.includes("'/api/email-actions'"), 'email-actions schrijft geen is_read');
  assert.ok(s.includes("apiPost('/api/inbox-mark-read', { conversation_id: id, module: 'finance' })"));
  assert.ok(s.includes("apiPost('/api/inbox-mark-unread', { conversation_id: id, module: 'finance' })"));
  // De leesstand overleeft een lijst-fetch die vóór de schrijfactie vertrok.
  assert.ok(/st\.items = asArr\(j\?\.items\); st\.fetched = true;\s*_wbxPasLeesStandToe\(st\.items\);/.test(s));
  // Automatisch openen (eerste gesprek na laden) is geen klik.
  assert.ok(s.includes("__wbxInboxSelect(String(first.id), { markeer: false })"));
});

test('Inbox en Onboarding-inbox geven de module mee en tonen mail-ongelezen ook', () => {
  const ib = code('modules/klanten-v2/views/inbox-v2.js');
  assert.ok(ib.includes("{ wb: 'finance', ev: 'events', ob: 'onboarding' }"));
  assert.ok(ib.includes('c.total_unread ?? c.unread_count'));
  const ob = code('modules/klanten-v2/views/onboarding-v2.js');
  assert.ok(ob.includes("{ conversation_id: convId, module: 'onboarding' }"));
  assert.ok(ob.includes('row.total_unread ?? row.unread_count'));
});

test('email-actions mark-read zet ook echt is_read (oudere, gecachte clients)', () => {
  const s = code('api/email-actions.js');
  assert.ok(s.includes("action === 'mark-read' && UUID_RE.test(String(email_id))"));
  assert.ok(/\.from\('email_messages'\)\s*\.update\(\{ is_read: true \}\)\s*\.eq\('id', email_id\)/.test(s));
  assert.ok(s.includes('requireCrmStaff(req)'), 'service role pas na de rolpoort');
});

test('de CRM-pagina zelf wordt niet gecachet (anders laadt de browser oude ?v=)', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  for (const pad of ['/modules/klanten-v2/', '/modules/klanten-v2']) {
    const regel = v.headers.find((h) => h.source === pad);
    assert.ok(regel, 'geen header-regel voor ' + pad);
    assert.match(regel.headers.find((h) => h.key === 'Cache-Control').value, /no-store/);
  }
});
