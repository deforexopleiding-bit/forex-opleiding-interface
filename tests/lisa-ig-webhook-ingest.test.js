// tests/lisa-ig-webhook-ingest.test.js
//
// NIEUWE IG-CONTACTEN ZONDER GHL MESSAGE-ID (1 oktober 2026).
//
// Sinds #1523 liet api/lisa-ghl-webhook.js elk bericht zonder messageId vallen
// — vóór de "ensure conversation"-stap, dus nieuwe contacten werden nooit meer
// aangemaakt (0 nieuwe gesprekken van 8 t/m 30 sep). Deze tests leggen vast:
//   1. een nieuw contact zonder messageId → gesprek + bericht (synthetische id);
//   2. hetzelfde bericht met én zonder id → nooit twee rijen, in beide volgordes;
//   3. de poll (echte id) upgradet een synthetische tweeling i.p.v. te dubbelen;
//   4. twee echte, gelijke berichten blijven twee rijen (eigen ids).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// ── Minimale in-memory Supabase ────────────────────────────────────────────
// Alleen wat webhook + ingest-lib gebruiken. lisa_messages.ghl_message_id
// heeft (zoals in productie) een partial UNIQUE-index WHERE NOT NULL.
function nepDb(seed = {}) {
  const tabellen = {
    lisa_settings: [{ id: 1, live_mode_enabled: false, ghl_webhook_total_received: 0, live_messages_received_total: 0 }],
    lisa_conversations: [],
    lisa_messages: [],
    app_settings: [],
    ...seed,
  };
  let seq = 0;
  const nieuwId = (t) => `${t}-${++seq}`;
  const uniekGeschonden = (tbl, rij, eigenId) => tbl === 'lisa_messages' && rij.ghl_message_id != null
    && tabellen.lisa_messages.some((r) => r.id !== eigenId && r.ghl_message_id === rij.ghl_message_id);

  function from(tbl) {
    const st = { filters: [], limit: null, op: 'select', payload: null, wantRows: false, opts: {} };
    const pas = (r) => st.filters.every(([op, k, v]) => {
      const x = r[k];
      if (op === 'eq')   return x === v;
      if (op === 'in')   return v.includes(x);
      if (op === 'gte')  return new Date(x).getTime() >= new Date(v).getTime();
      if (op === 'lte')  return new Date(x).getTime() <= new Date(v).getTime();
      if (op === 'is')   return v === null ? x == null : x === v;
      if (op === 'notnull') return x != null;
      if (op === 'notlike') return !(typeof x === 'string' && x.startsWith(v.replace('%', '')));
      return true;
    });
    const voerUit = () => {
      const rows = tabellen[tbl] || (tabellen[tbl] = []);
      if (st.op === 'insert') {
        const rij = { id: nieuwId(tbl), ...st.payload };
        if (tbl === 'lisa_messages' && !rij.sent_at) rij.sent_at = new Date().toISOString();   // DB-default now()
        if (tbl === 'lisa_conversations') { rij.unread_count ??= 0; rij.is_sandbox ??= false; rij.created_at = new Date(nu()).toISOString(); }
        if (uniekGeschonden(tbl, rij, null)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        rows.push(rij);
        return { data: [rij], error: null };
      }
      if (st.op === 'upsert') {
        const k = st.opts.onConflict || 'id';
        const bestaand = rows.find((r) => r[k] === st.payload[k]);
        if (bestaand) Object.assign(bestaand, st.payload); else rows.push({ ...st.payload });
        return { data: null, error: null };
      }
      const hits = rows.filter(pas);
      if (st.op === 'update') {
        for (const r of hits) {
          if (uniekGeschonden(tbl, { ...r, ...st.payload }, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        hits.forEach((r) => Object.assign(r, st.payload));
        return { data: hits.map((r) => ({ ...r })), error: null };
      }
      const lim = st.limit != null ? hits.slice(0, st.limit) : hits;
      return { data: lim.map((r) => ({ ...r })), error: null };
    };
    const k = {
      select(_c, opts) { st.wantRows = true; st.opts.select = opts; return k; },
      eq(c, v) { st.filters.push(['eq', c, v]); return k; },
      in(c, v) { st.filters.push(['in', c, v]); return k; },
      gte(c, v) { st.filters.push(['gte', c, v]); return k; },
      lte(c, v) { st.filters.push(['lte', c, v]); return k; },
      is(c, v) { st.filters.push(['is', c, v]); return k; },
      not(c, op, v) { st.filters.push(op === 'is' ? ['notnull', c] : ['notlike', c, v]); return k; },
      order() { return k; },
      limit(n) { st.limit = n; return k; },
      insert(p) { st.op = 'insert'; st.payload = p; return k; },
      update(p) { st.op = 'update'; st.payload = p; return k; },
      upsert(p, o) { st.op = 'upsert'; st.payload = p; st.opts = { ...st.opts, ...(o || {}) }; return k; },
      maybeSingle: async () => { const r = voerUit(); return { data: r.data?.[0] || null, error: r.error }; },
      single: async () => { const r = voerUit(); return { data: r.data?.[0] || null, error: r.error }; },
      then: (ok, nok) => Promise.resolve(voerUit()).then(ok, nok),
    };
    return k;
  }
  let klok = Date.parse('2026-10-01T10:00:00Z');
  const nu = () => klok;
  return { from, tabellen, zetKlok: (ms) => { klok = ms; }, nu };
}

// ── Webhook draaien met een nep-database ───────────────────────────────────
async function laadWebhook(db) {
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db } });
  mock.module(url('api/_lib/lisa-ghl-send.js'), {
    namedExports: { computeResponseDelay: () => 0, sendTypingIndicator: async () => {}, matchBookingByEmail: async () => {} },
  });
  mock.module(url('api/lisa-respond.js'), {
    namedExports: { generateLisaResponse: async () => { throw new Error('AI hoort niet te lopen (live_mode uit)'); } },
  });
  mock.module(url('api/_lib/lisa-followup.js'), {
    namedExports: {
      detectStopSignal: () => null, containsAgendaLink: () => false, schedulePostLinkFollowups: async () => {},
      autoQualifyIfTriggered: async () => ({ triggered: false }), pauseFollowupsForDisqualified: async () => ({ ok: true }),
    },
  });
  process.env.LISA_WEBHOOK_SECRET = 'geheim-test';
  const mod = await import(url('api/lisa-ghl-webhook.js') + '?t=' + Math.random());
  return async (customData) => {
    const res = { code: null, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await mod.default({
      method: 'POST', headers: { 'x-lisa-webhook-secret': 'geheim-test' }, query: {},
      body: { customData: { type: 'IG', direction: 'inbound', locationId: 'loc-1', ...customData }, full_name: 'Nieuwe Lead' },
    }, res);
    return res;
  };
}

test('webhook: nieuw contact ZONDER messageId → gesprek + bericht worden aangemaakt', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb();
  const post = await laadWebhook(db);
  const res = await post({ contactId: 'c-nieuw', conversationId: 'gc-1', message: 'Hoi, ik wil meer info' });

  assert.equal(res.code, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.skipped, 'live_mode_off');
  assert.equal(res.body.synthetic_id, true);
  assert.equal(db.tabellen.lisa_conversations.length, 1, 'gesprek aangemaakt');
  assert.equal(db.tabellen.lisa_conversations[0].ghl_contact_id, 'c-nieuw');
  assert.equal(db.tabellen.lisa_messages.length, 1, 'bericht opgeslagen');
  assert.match(db.tabellen.lisa_messages[0].ghl_message_id, /^syn:[0-9a-f]{40}$/);
  // Levenssignaal: last_received_at wordt ook voor id-loze calls bijgewerkt.
  assert.ok(db.tabellen.lisa_settings[0].ghl_webhook_last_received_at);
  assert.equal(db.tabellen.lisa_settings[0].ghl_webhook_last_error, null);
});

test('webhook: eerst ZONDER id, dan MET id → één rij, met de echte id', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb();
  const post = await laadWebhook(db);
  await post({ contactId: 'c-1', message: 'Ik ben zelf PAS actief.' });
  const res2 = await post({ contactId: 'c-1', message: 'Ik ben zelf PAS actief.', messageId: 'ZihKLxoGWvQ86elxKjGc' });

  assert.equal(res2.body.skipped, 'duplicate_delivery');
  assert.equal(res2.body.ingest, 'upgraded');
  assert.equal(db.tabellen.lisa_messages.length, 1);
  assert.equal(db.tabellen.lisa_messages[0].ghl_message_id, 'ZihKLxoGWvQ86elxKjGc');
  assert.equal(db.tabellen.lisa_conversations[0].unread_count, 1, 'unread niet dubbel geteld');
});

test('webhook: eerst MET id, dan ZONDER id (het bewezen #1523-geval) → één rij', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb();
  const post = await laadWebhook(db);
  await post({ contactId: 'c-1', message: 'Ik ben zelf PAS actief.', messageId: 'ZihKLxoGWvQ86elxKjGc' });
  const res2 = await post({ contactId: 'c-1', message: 'Ik ben zelf PAS actief.' });

  assert.equal(res2.body.skipped, 'duplicate_delivery');
  assert.equal(db.tabellen.lisa_messages.length, 1);
  assert.equal(db.tabellen.lisa_messages[0].ghl_message_id, 'ZihKLxoGWvQ86elxKjGc');
});

test('webhook: twee keer ZONDER id (GHL-retry) → één rij', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb();
  const post = await laadWebhook(db);
  await post({ contactId: 'c-1', message: 'Hallo' });
  await post({ contactId: 'c-1', message: 'Hallo' });
  assert.equal(db.tabellen.lisa_messages.length, 1);
});

test('webhook: niet-IG en ontbrekend contact → skip-reden vastgelegd in app_settings', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb();
  const post = await laadWebhook(db);
  const r1 = await post({ contactId: 'c-1', message: 'x', type: 'SMS' });
  assert.equal(r1.body.skipped, 'not_ig_inbound');
  assert.equal(db.tabellen.app_settings.find((r) => r.key === 'lisa_webhook_laatste_skip')?.value.reason, 'not_ig_inbound');
  const r2 = await post({ contactId: undefined, message: 'x' });
  assert.equal(r2.body.skipped, 'missing_contact_id');
  assert.equal(db.tabellen.app_settings.find((r) => r.key === 'lisa_webhook_laatste_skip')?.value.reason, 'missing_contact_id');
  assert.equal(db.tabellen.lisa_conversations.length, 0);
});

// ── Ingest-lib direct: het poll-pad ────────────────────────────────────────
test('poll: echte id upgradet een synthetische tweeling (incl. sent_at = dateAdded)', async () => {
  const { ingestLisaMessage } = await import(url('api/_lib/lisa-message-ingest.js'));
  const db = nepDb();
  const ontvangst = Date.parse('2026-10-01T10:06:00Z');              // webhook ~6 min na dateAdded
  const a = await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: 'Wat kost het?', messageType: 'text', sentAt: new Date(ontvangst).toISOString() });
  assert.equal(a.status, 'inserted');
  assert.ok(a.synthetic);

  const dateAdded = '2026-10-01T10:00:00.000Z';
  const b = await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: 'Wat kost het?', messageType: 'text', ghlMessageId: 'ghl-123', sentAt: dateAdded });
  assert.equal(b.status, 'upgraded');
  assert.equal(db.tabellen.lisa_messages.length, 1);
  assert.equal(db.tabellen.lisa_messages[0].ghl_message_id, 'ghl-123');
  assert.equal(db.tabellen.lisa_messages[0].sent_at, dateAdded);

  // Tweede poll-run: idempotent.
  const c = await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: 'Wat kost het?', messageType: 'text', ghlMessageId: 'ghl-123', sentAt: dateAdded });
  assert.equal(c.status, 'duplicate');
  assert.equal(db.tabellen.lisa_messages.length, 1);
});

test('poll: twee echte gelijke berichten ("ok", "ok") blijven twee rijen', async () => {
  const { ingestLisaMessage } = await import(url('api/_lib/lisa-message-ingest.js'));
  const db = nepDb();
  const m = { conversationId: 'conv-1', direction: 'in', content: 'ok', messageType: 'text' };
  assert.equal((await ingestLisaMessage(db, { ...m, ghlMessageId: 'g-1', sentAt: '2026-10-01T10:00:00Z' })).status, 'inserted');
  assert.equal((await ingestLisaMessage(db, { ...m, ghlMessageId: 'g-2', sentAt: '2026-10-01T10:00:30Z' })).status, 'inserted');
  assert.equal(db.tabellen.lisa_messages.length, 2);
});

test('ingest: een echte rij wordt nooit "geüpgraded" (alleen syn:/NULL, geen is_system)', async () => {
  const { ingestLisaMessage } = await import(url('api/_lib/lisa-message-ingest.js'));
  const db = nepDb({ lisa_messages: [
    { id: 'm-sys', conversation_id: 'conv-1', direction: 'in', content: 'ok', sent_at: '2026-10-01T10:00:00Z', ghl_message_id: null, is_system: true },
  ] });
  const r = await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: 'ok', messageType: 'text', ghlMessageId: 'g-9', sentAt: '2026-10-01T10:00:05Z' });
  assert.equal(r.status, 'inserted');
  assert.equal(db.tabellen.lisa_messages.length, 2);
});

test('ingest: media-placeholders tellen onderling als tweeling', async () => {
  const { ingestLisaMessage } = await import(url('api/_lib/lisa-message-ingest.js'));
  const db = nepDb();
  await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: '📎 Media-bericht', messageType: 'unknown', sentAt: '2026-10-01T10:01:00Z' });
  const r = await ingestLisaMessage(db, { conversationId: 'conv-1', direction: 'in', content: '📷 Foto', messageType: 'photo', ghlMessageId: 'g-foto', sentAt: '2026-10-01T10:00:50Z' });
  assert.equal(r.status, 'upgraded');
  assert.equal(db.tabellen.lisa_messages.length, 1);
});

test('syntheticMessageId is stabiel binnen een bucket en verschilt per inhoud', async () => {
  const { syntheticMessageId } = await import(url('api/_lib/lisa-message-ingest.js'));
  const base = { conversationId: 'c', direction: 'in', content: 'Hoi', atMs: Date.parse('2026-10-01T10:00:10Z') };
  assert.equal(syntheticMessageId(base), syntheticMessageId({ ...base, content: '  Hoi ', atMs: base.atMs + 20_000 }));
  assert.notEqual(syntheticMessageId(base), syntheticMessageId({ ...base, content: 'Hoi!' }));
});
