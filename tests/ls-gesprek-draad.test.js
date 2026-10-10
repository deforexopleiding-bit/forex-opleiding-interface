// tests/ls-gesprek-draad.test.js
//
// Leadsonderhoud › Gesprekken (2026-10-09): ~55% van de draden opende leeg en
// "gelezen" sprong terug. Oorzaak: api/leadsonderhoud-gesprek-berichten.js zocht
// het WA-gesprek van een lead in een ONGESORTEERDE .limit(500) op een lijn met
// >1000 gesprekken; mark_as_read zat binnen `if (conv)` en viel dan ook weg.
//   1. vindLeadConv: eerst de conv die de lijst kent (hint, gecontroleerd), anders
//      direct op nummer — nooit "pak N en zoek erin";
//   2. handler: lead + conversation_id → lead-pad (WA + mail), mark_as_read schrijft;
//      alleen conversation_id → lead-loze tak ongewijzigd (ook mark_as_read);
//   3. niets gevonden → expliciet gelogd;
//   4. view: draad-URL met lead_id + conversation_id (openen én poll), cache-buster.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const LIJN = '1273723375834177';
const LEAD = { id: '675859db-0000-4000-8000-000000000001', voornaam: 'Robby', achternaam: null, email: 'robby@example.com', telefoon_e164: '+32470000077', traject: 'minicursus' };
const CONV = { id: 'b1dbafe0-0000-4000-8000-000000000001', phone_number: '+32470000077', phone_number_id: LIJN, last_inbound_at: null, unread_count: 2, last_message_at: '2026-10-02T15:07:10Z' };

function nepDb() {
  // 1100 gesprekken op de lijn; die van Robby staat "achteraan".
  const convs = Array.from({ length: 1100 }, (_, i) => ({ id: `c-${i}`, phone_number: '+3161' + String(i).padStart(7, '0'), phone_number_id: LIJN, unread_count: 0, last_message_at: '2026-09-01T00:00:00Z' }));
  convs.push({ ...CONV });
  convs.push({ id: 'ander-lijn', phone_number: '+32470000077', phone_number_id: '999', unread_count: 0 });
  const tab = {
    leads: [LEAD],
    whatsapp_conversations: convs,
    whatsapp_messages: [1, 2, 3, 4].map((n) => ({ id: 'm' + n, conversation_id: CONV.id, direction: n % 2 ? 'in' : 'out', body: 'bericht ' + n, created_at: `2026-10-02T15:0${n}:00Z` })),
    email_messages: [{ id: 'e1', from_address: 'Robby <robby@example.com>', subject: 'Re: cursus', snippet: 'hoi', body_text: 'hoi', date_received: '2026-10-01T10:00:00Z', is_read: true, mailbox: 'welkom' }],
    berichten_log: [], email_replies: [], onderhoud_sjablonen: [],
    onderhoud_trajecten: [{ slug: 'minicursus' }],
    app_settings: [], whatsapp_module_config: [{ module: 'leadsonderhoud', is_active: true, phone_number_id: LIJN }],
  };
  const calls = [];
  const updates = [];
  return {
    tab, calls, updates,
    from(t) {
      const f = []; let op = 'select'; let patch = null; let lim = null; let sort = null; const st = { t, eq: {}, in: null, limit: null };
      const k = {
        select: () => k,
        eq: (c, v) => { st.eq[c] = v; f.push((r) => String(r[c]) === String(v)); return k; },
        neq: (c, v) => { f.push((r) => r[c] !== v); return k; },
        in: (c, v) => { st.in = [c, v]; f.push((r) => v.includes(r[c])); return k; },
        ilike: (c, v) => { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); f.push((r) => re.test(String(r[c] || ''))); return k; },
        order: (c, o) => { sort = [c, o?.ascending !== false]; return k; },
        limit: (n) => { lim = n; st.limit = n; return k; },
        update: (p) => { op = 'update'; patch = p; return k; },
        maybeSingle: () => k.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })),
        then(ok, nok) {
          calls.push(st);
          let rows = (tab[t] || []).filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') { for (const r of rows) Object.assign(r, patch); updates.push({ t, patch, ids: rows.map((r) => r.id) }); return Promise.resolve({ data: null, error: null }).then(ok, nok); }
          if (sort) rows = [...rows].sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : 1) * (sort[1] ? 1 : -1));
          if (lim != null) rows = rows.slice(0, lim);
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(ok, nok);
        },
      };
      return k;
    },
  };
}

async function draai(query, db = nepDb()) {
  mock.module(url('api/supabase.js'), {
    namedExports: { supabase: null, supabaseAdmin: db, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }), createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) },
  });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
  const warns = []; const errors = [];
  const ow = console.warn; const oe = console.error;
  console.warn = (...a) => warns.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.error = (...a) => errors.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  let status = 200; let body = null;
  try {
    const mod = await import(url('api/leadsonderhoud-gesprek-berichten.js') + '?t=' + Date.now() + Math.random());
    await mod.default({ method: 'GET', headers: {}, query }, { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } });
    return { status, body, db, warns, errors, mod };
  } finally {
    console.warn = ow; console.error = oe; mock.reset();
  }
}

test('lead + conversation_id: 4 WA-berichten + mail, mark_as_read zet unread_count op 0', async () => {
  const r = await draai({ lead_id: LEAD.id, conversation_id: CONV.id, mark_as_read: 'true' });
  assert.equal(r.status, 200);
  const wa = r.body.items.filter((i) => i.channel === 'whatsapp');
  assert.equal(wa.length, 4);
  assert.equal(r.body.items.filter((i) => i.channel === 'mail').length, 1, 'mail blijft in de draad');
  assert.equal(r.body.conversation.has_wa, true);
  assert.deepEqual(r.db.updates.filter((u) => u.t === 'whatsapp_conversations'), [{ t: 'whatsapp_conversations', patch: { unread_count: 0 }, ids: [CONV.id] }]);
  assert.ok(!r.db.calls.some((c) => c.t === 'whatsapp_conversations' && c.limit === 500), 'geen "pak 500 en zoek"');
});

test('alleen lead_id (geen conversation_id bekend): direct op nummer → nog steeds gevonden', async () => {
  const r = await draai({ lead_id: LEAD.id, mark_as_read: 'true' });
  assert.equal(r.body.items.filter((i) => i.channel === 'whatsapp').length, 4);
  const q = r.db.calls.find((c) => c.t === 'whatsapp_conversations' && c.in);
  assert.deepEqual(q.in, ['phone_number', ['+32470000077', '32470000077', '0032470000077']]);
  assert.equal(q.eq.phone_number_id, LIJN);
  assert.equal(q.limit, 1);
  assert.equal(r.db.tab.whatsapp_conversations.find((c) => c.id === CONV.id).unread_count, 0);
});

test('hint die niet klopt (andere lijn) → gelogd en terugval op nummer', async () => {
  const r = await draai({ lead_id: LEAD.id, conversation_id: '00000000-0000-4000-8000-0000000000aa' });
  assert.equal(r.body.items.filter((i) => i.channel === 'whatsapp').length, 4);
  assert.ok(r.warns.some((w) => w.includes('conv-hint past niet bij lead/lijn')));
});

test('niets gevonden → expliciet gelogd (geen stille lege draad)', async () => {
  const db = nepDb();
  db.tab.whatsapp_conversations = db.tab.whatsapp_conversations.filter((c) => c.id !== CONV.id);
  const r = await draai({ lead_id: LEAD.id }, db);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.filter((i) => i.channel === 'whatsapp').length, 0);
  assert.ok(r.warns.some((w) => w.includes('geen WA-gesprek gevonden voor lead')));
});

test('lead-loze rij (alleen conversation_id): ongewijzigd + mark_as_read', async () => {
  const r = await draai({ conversation_id: CONV.id, mark_as_read: 'true' });
  assert.equal(r.status, 200);
  assert.equal(r.body.conversation.lead_id, null);
  assert.equal(r.body.items.length, 4);
  assert.ok(r.body.items.every((i) => i.channel === 'whatsapp'));
  assert.equal(r.db.tab.whatsapp_conversations.find((c) => c.id === CONV.id).unread_count, 0);
  const anders = await draai({ conversation_id: CONV.id.replace('b1dbafe0', 'ffffffff') });
  assert.equal(anders.status, 404);
});

test('nummerVarianten: E.164 met en zonder +, en 00-prefix', async () => {
  const { mod } = await draai({ lead_id: 'x' });
  assert.deepEqual(mod.nummerVarianten('+31 6 12345678'), ['+31612345678', '31612345678', '0031612345678']);
  assert.deepEqual(mod.nummerVarianten(''), []);
});

test('view: draad-URL met lead_id + conversation_id (openen én poll), cache-buster', () => {
  const v = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(v, /function _lsInbThreadUrl\(rowKey, extra\) \{/);
  assert.match(v, /if \(k\.startsWith\('conv:'\)\) return basis \+ 'conversation_id=' \+ encodeURIComponent\(k\.slice\(5\)\) \+ \(extra \|\| ''\);/);
  assert.match(v, /return basis \+ 'lead_id=' \+ encodeURIComponent\(k\) \+ conv \+ \(extra \|\| ''\);/);
  assert.match(v, /const _threadUrl = _lsInbThreadUrl\(leadId, markParam\);/);
  assert.match(v, /const _pollUrl = _lsInbThreadUrl\(_lsInb\.thread\.leadId\);/);
  assert.equal((v.match(/leadsonderhoud-gesprek-berichten\?/g) || []).length, 1, 'één plek bouwt de URL');
  const versie = lees('modules/klanten-v2/index.html').match(/views\/leadsonderhoud-v2\.js\?v=(\d+)"/);
  assert.ok(versie && Number(versie[1]) >= 67, 'cache-buster minstens v67');
  const code = lees('api/leadsonderhoud-gesprek-berichten.js').split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\.limit\(500\)/, 'geen ongesorteerde 500-opzoeking meer');
});
