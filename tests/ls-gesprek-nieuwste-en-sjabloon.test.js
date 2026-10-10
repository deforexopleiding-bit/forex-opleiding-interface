// tests/ls-gesprek-nieuwste-en-sjabloon.test.js
//
// Follow-ups uit #1761 (2026-10-10):
//   1. De draad haalde de OUDSTE 200 WA-berichten op (order asc + limit 200) →
//      bij >200 berichten ontbraken juist de nieuwste. Nu de nieuwste 200, in
//      leesvolgorde, met wa_ouder_beschikbaar.
//   2. De "Sjabloon"-route zocht het gesprek in een ongesorteerde .limit(500)
//      van de lijn → op een drukke lijn kwam het bericht niet in de draad. Nu
//      vindLeadConv (direct op nummer); geen gesprek → logOutboundWa.
//   3. Die route schreef berichten_log.meta_template (bestaat niet) → de
//      insert faalde stil. Nu extern_id = wamid.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const LIJN = '1273723375834177';
const LEAD = { id: 'f96a1765-0000-4000-8000-000000000001', voornaam: 'Leads', achternaam: 'Test', email: 'leads@example.com', telefoon_e164: '+31655270212', traject: 'minicursus' };
const CONV = { id: '5505a8e3-0000-4000-8000-000000000001', phone_number: '+31655270212', phone_number_id: LIJN, last_inbound_at: null, unread_count: 0, last_message_at: '2026-10-09T12:00:00Z' };
const BERICHTEN_LOG_KOLOMMEN = new Set(['id', 'gebruiker_id', 'lead_id', 'soort', 'kanaal', 'naar', 'agent', 'status', 'fout', 'extern_id', 'verstuurd_op', 'bericht_id', 'gesprek_id', 'traject']);

function nepDb({ metConv = true, aantalBerichten = 237 } = {}) {
  // Drukke lijn: 1100 andere gesprekken, die van de lead staat achteraan.
  const convs = Array.from({ length: 1100 }, (_, i) => ({ id: `c-${i}`, phone_number: '+3161' + String(i).padStart(7, '0'), phone_number_id: LIJN, unread_count: 0, last_message_at: '2026-09-01T00:00:00Z' }));
  if (metConv) convs.push({ ...CONV });
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  const msgs = Array.from({ length: aantalBerichten }, (_, i) => ({
    id: 'm' + (i + 1), conversation_id: CONV.id, direction: i % 2 ? 'out' : 'in',
    body: i === aantalBerichten - 1 ? 'nieuwste' : 'bericht ' + (i + 1),
    created_at: new Date(t0 + i * 60000).toISOString(),
  }));
  const tab = {
    leads: [LEAD], whatsapp_conversations: convs, whatsapp_messages: msgs,
    email_messages: [], berichten_log: [], email_replies: [], onderhoud_sjablonen: [],
    onderhoud_trajecten: [{ slug: 'minicursus' }], app_settings: [],
    whatsapp_module_config: [{ module: 'leadsonderhoud', is_active: true, phone_number_id: LIJN }],
  };
  const calls = []; const inserts = [];
  return {
    tab, calls, inserts,
    from(t) {
      const f = []; let op = 'select'; let patch = null; let lim = null; let sort = null; const st = { t, eq: {}, in: null, limit: null };
      const k = {
        select: () => k,
        eq: (c, v) => { st.eq[c] = v; f.push((r) => String(r[c]) === String(v)); return k; },
        neq: (c, v) => { f.push((r) => r[c] !== v); return k; },
        in: (c, v) => { st.in = [c, v]; f.push((r) => v.includes(r[c])); return k; },
        ilike: (c, v) => { const re = new RegExp('^' + String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); f.push((r) => re.test(String(r[c] || ''))); return k; },
        order: (c, o) => { sort = [c, o?.ascending !== false]; st.order = sort; return k; },
        limit: (n) => { lim = n; st.limit = n; return k; },
        update: (p) => { op = 'update'; patch = p; return k; },
        insert: (rij) => {
          inserts.push({ t, rij });
          if (t === 'berichten_log') {
            const fout = Object.keys(rij).find((c) => !BERICHTEN_LOG_KOLOMMEN.has(c));
            if (fout) return Promise.resolve({ data: null, error: { message: `Could not find the '${fout}' column of 'berichten_log' in the schema cache` } });
          }
          (tab[t] = tab[t] || []).push({ id: 'nieuw-' + inserts.length, ...rij });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: () => k.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })),
        then(ok, nok) {
          calls.push(st);
          let rows = (tab[t] || []).filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') { for (const r of rows) Object.assign(r, patch); return Promise.resolve({ data: null, error: null }).then(ok, nok); }
          if (sort) rows = [...rows].sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : 1) * (sort[1] ? 1 : -1));
          if (lim != null) rows = rows.slice(0, lim);
          return Promise.resolve({ data: rows.map((r) => ({ ...r })), error: null }).then(ok, nok);
        },
      };
      return k;
    },
  };
}

function mockBasis(db) {
  mock.module(url('api/supabase.js'), {
    namedExports: { supabase: null, supabaseAdmin: db, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }), createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'jeffrey@example.com' } } }) } }) },
  });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
}

async function roep(pad, req, db, extra = () => {}) {
  mockBasis(db);
  extra();
  const fouten = []; const oe = console.error; const ow = console.warn;
  console.error = (...a) => fouten.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.warn = () => {};
  let status = 200; let body = null;
  try {
    const mod = await import(url(pad) + '?t=' + Date.now() + Math.random());
    await mod.default({ headers: {}, query: {}, ...req }, { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } });
    return { status, body, fouten };
  } finally {
    console.error = oe; console.warn = ow; mock.reset();
  }
}

// ── 1. Draad: nieuwste 200 ────────────────────────────────────────────────
test('draad met 237 berichten: de NIEUWSTE 200, oudste eerst, nieuwste onderaan', async () => {
  const db = nepDb();
  const r = await roep('api/leadsonderhoud-gesprek-berichten.js', { method: 'GET', query: { lead_id: LEAD.id, conversation_id: CONV.id } }, db);
  assert.equal(r.status, 200);
  const wa = r.body.items.filter((i) => i.channel === 'whatsapp');
  assert.equal(wa.length, 200);
  assert.equal(wa[wa.length - 1].body, 'nieuwste', 'het laatste bericht staat onderaan');
  assert.equal(wa[0].id, 'wa:m38', 'de oudste 37 vallen weg, niet de nieuwste');
  for (let i = 1; i < wa.length; i++) assert.ok(wa[i - 1].ts <= wa[i].ts, 'chronologisch');
  assert.equal(r.body.conversation.wa_ouder_beschikbaar, true);
  const q = db.calls.find((c) => c.t === 'whatsapp_messages');
  assert.deepEqual(q.order, ['created_at', false]);
  assert.equal(q.limit, 200);
});

test('draad lead-loze rij (alleen conversation_id): ook de nieuwste 200', async () => {
  const r = await roep('api/leadsonderhoud-gesprek-berichten.js', { method: 'GET', query: { conversation_id: CONV.id } }, nepDb());
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 200);
  assert.equal(r.body.items[199].body, 'nieuwste');
  assert.equal(r.body.conversation.wa_ouder_beschikbaar, true);
});

test('draad met weinig berichten: alles, wa_ouder_beschikbaar=false', async () => {
  const r = await roep('api/leadsonderhoud-gesprek-berichten.js', { method: 'GET', query: { lead_id: LEAD.id } }, nepDb({ aantalBerichten: 5 }));
  const wa = r.body.items.filter((i) => i.channel === 'whatsapp');
  assert.deepEqual(wa.map((i) => i.id), ['wa:m1', 'wa:m2', 'wa:m3', 'wa:m4', 'wa:m5']);
  assert.equal(r.body.conversation.wa_ouder_beschikbaar, false);
});

// ── 2 + 3. "Sjabloon"-route ───────────────────────────────────────────────
function mockWa({ outboundLog } = {}) {
  return () => {
    mock.module(url('api/_lib/meta-whatsapp.js'), {
      namedExports: { sendTemplate: async () => ({ wamid: 'wamid.TEST123' }), MetaNotConfiguredError: class extends Error {} },
    });
    mock.module(url('api/_lib/render-template-preview.js'), {
      namedExports: { renderTemplatePreview: async ({ templateVariables }) => ({ source: 'meta_template', body: 'Hey ' + (templateVariables?.['1'] || '') + ', had je mijn berichtje goed ontvangen?' }) },
    });
    mock.module(url('api/_lib/wa-outbound-log.js'), {
      namedExports: { logOutboundWa: outboundLog || (async () => { throw new Error('logOutboundWa hoort hier niet'); }) },
    });
  };
}
const SJABLOON = { lead_id: LEAD.id, template_name: 'followup_1_berichtje_goed_ontvangen', language: 'nl', variables: ['Leads'] };

test('sjabloon op een drukke lijn (1100 gesprekken): landt in het gesprek van de lead + berichten_log', async () => {
  const db = nepDb();
  const r = await roep('api/leadsonderhoud-gesprek-template.js', { method: 'POST', body: SJABLOON }, db, mockWa());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, wamid: 'wamid.TEST123', in_draad: true });
  const msg = db.inserts.find((i) => i.t === 'whatsapp_messages');
  assert.equal(msg.rij.conversation_id, CONV.id, 'het gesprek van de lead, niet "niet gevonden"');
  assert.equal(msg.rij.body, 'Hey Leads, had je mijn berichtje goed ontvangen?');
  assert.equal(msg.rij.meta_wamid, 'wamid.TEST123');
  assert.ok(!db.calls.some((c) => c.t === 'whatsapp_conversations' && c.limit === 500), 'geen ongesorteerde 500-opzoeking');
  const log = db.tab.berichten_log;
  assert.equal(log.length, 1, 'berichten_log-regel staat er echt');
  assert.equal(log[0].extern_id, 'wamid.TEST123');
  assert.equal(log[0].soort, 'handmatig-template');
  assert.ok(!('meta_template' in log[0]));
  assert.deepEqual(r.fouten, []);
  // en de draad toont het nu als nieuwste bericht
  const d = await roep('api/leadsonderhoud-gesprek-berichten.js', { method: 'GET', query: { lead_id: LEAD.id } }, db);
  const wa = d.body.items.filter((i) => i.channel === 'whatsapp');
  assert.equal(wa[wa.length - 1].body, 'Hey Leads, had je mijn berichtje goed ontvangen?');
});

test('sjabloon zonder bestaand gesprek: logOutboundWa maakt het aan', async () => {
  const db = nepDb({ metConv: false });
  const aanroepen = [];
  const r = await roep('api/leadsonderhoud-gesprek-template.js', { method: 'POST', body: SJABLOON }, db, mockWa({
    outboundLog: async (_sb, a) => { aanroepen.push(a); return { ok: true, conv_id: 'nieuw', message_id: 'm-nieuw' }; },
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.in_draad, true);
  assert.equal(aanroepen.length, 1);
  assert.equal(aanroepen[0].toPhone, LEAD.telefoon_e164);
  assert.equal(aanroepen[0].phoneNumberId, LIJN);
  assert.equal(aanroepen[0].wamid, 'wamid.TEST123');
  assert.equal(aanroepen[0].templateName, SJABLOON.template_name);
  assert.equal(db.tab.berichten_log.length, 1);
});

test('draad-log mislukt → in_draad=false en een echte foutregel (niet stil)', async () => {
  const db = nepDb({ metConv: false });
  const r = await roep('api/leadsonderhoud-gesprek-template.js', { method: 'POST', body: SJABLOON }, db, mockWa({
    outboundLog: async () => ({ ok: false, error: 'conv insert faalde' }),
  }));
  assert.equal(r.status, 200);
  assert.equal(r.body.in_draad, false);
  assert.ok(r.fouten.some((f) => f.includes('logOutboundWa zonder bericht')));
});

test('code: geen .limit(500)-opzoeking en geen meta_template meer; UI meldt in_draad=false; cache-buster', () => {
  const code = lees('api/leadsonderhoud-gesprek-template.js').split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\.limit\(500\)/);
  assert.doesNotMatch(code, /meta_template\s*:/);
  const v = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(v, /_tplRes && _tplRes\.in_draad === false/);
  const versie = lees('modules/klanten-v2/index.html').match(/views\/leadsonderhoud-v2\.js\?v=(\d+)"/);
  assert.ok(versie && Number(versie[1]) >= 69, 'cache-buster minstens v69');
});
