// tests/dunning-reply-detection.test.js
//
// Unit-tests voor hasReplyAfterLastSend — de reply-stop-check die runs
// pauzeert als de klant heeft gereageerd (WA of e-mail) NA de laatste
// engine-send. Dual-source: whatsapp_conversations.last_inbound_at én
// email_messages.from_address (case-insensitive customer.email match).
//
// Gebruikt een mini fake-db (`makeMockDb`) die de subset van de Supabase-
// client chain implementeert die de helper aanroept: .from() -> .select()
// -> .eq() / .in() / .not() / .ilike() / .gt() -> .order() -> .limit()
// -> await (returns {data,error}), plus .maybeSingle().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasReplyAfterLastSend } from '../api/_lib/dunning-engine.js';

// ── Mini fake-db builder ────────────────────────────────────────────────
// Alleen de operators die hasReplyAfterLastSend gebruikt.
function makeMockDb(mockData) {
  return {
    from(table) {
      let rows = Array.isArray(mockData[table]) ? mockData[table].slice() : [];
      const chain = {
        select()             { return chain; },
        eq(col, val)         { rows = rows.filter((r) => r[col] === val); return chain; },
        in(col, vals)        { const s = new Set(vals); rows = rows.filter((r) => s.has(r[col])); return chain; },
        not(col, op, val)    { if (op === 'is' && val === null) rows = rows.filter((r) => r[col] != null); return chain; },
        ilike(col, val)      {
          const target = String(val).toLowerCase();
          rows = rows.filter((r) => String(r[col] || '').toLowerCase() === target);
          return chain;
        },
        gt(col, val)         { rows = rows.filter((r) => r[col] > val); return chain; },
        order()               { return chain; },
        limit(n)              { rows = rows.slice(0, n); return chain; },
        maybeSingle()         { return Promise.resolve({ data: rows[0] || null, error: null }); },
        // Awaitable: `.then` maakt de chain een thenable die de builder-result oplevert.
        then(resolve)         { resolve({ data: rows, error: null }); },
      };
      return chain;
    },
  };
}

const RUN_ID    = 'run-123';
const CUST_ID   = 'cust-abc';
const CUST_MAIL = 'karl@voorbeeld.nl';
const T_EARLY   = '2026-08-10T10:00:00.000Z';   // vóór laatste send
const T_SEND    = '2026-08-11T09:00:00.000Z';   // laatste engine-send
const T_LATE    = '2026-08-11T12:00:00.000Z';   // ná laatste send

// ── (a) inbound e-mail NA laatste send → paused ────────────────────────
test('(a) inbound e-mail NA laatste send -> replied:true, channel email', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [
      { from_address: CUST_MAIL, date_received: T_LATE },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, true);
  assert.equal(r.channel, 'email');
});

// ── (b) inbound e-mail VÓÓR laatste send → gaat door ──────────────────
test('(b) inbound e-mail VOOR laatste send -> replied:false', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [
      { from_address: CUST_MAIL, date_received: T_EARLY },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, false);
});

// ── (c) inbound WA NA laatste send → paused (regressie-anker #875) ────
test('(c) inbound WA NA laatste send -> replied:true, channel whatsapp', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'whatsapp_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [
      { customer_id: CUST_ID, last_inbound_at: T_LATE },
    ],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, true);
  assert.equal(r.channel, 'whatsapp');
});

// ── (d) geen inbound (WA noch mail) → gaat door ───────────────────────
test('(d) geen inbound -> replied:false', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [
      { customer_id: CUST_ID, last_inbound_at: T_EARLY },
    ],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, false);
});

// ── (e) run zonder sends → geen pauze-check ──────────────────────────
test('(e) run zonder sends -> replied:false zonder bron-check', async () => {
  const db = makeMockDb({
    dunning_log: [], // geen email_sent/whatsapp_sent
    whatsapp_conversations: [
      // Zelfs met inbound zou 't false moeten zijn (kan niet gereageerd
      // hebben op iets dat we niet verstuurd hebben).
      { customer_id: CUST_ID, last_inbound_at: T_LATE },
    ],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [
      { from_address: CUST_MAIL, date_received: T_LATE },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, false);
});

// ── (f) mail van ONBEKEND adres → geen false-positive ─────────────────
test('(f) mail van onbekend adres -> replied:false (geen false-positive)', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [
      { from_address: 'iemand-anders@random.com', date_received: T_LATE },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, false);
});

// ── Extra: case-insensitive email-match ──────────────────────────────
test('case-insensitive email-match: KARL@Voorbeeld.NL matcht karl@voorbeeld.nl', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [],
    customers: [{ id: CUST_ID, email: 'KARL@Voorbeeld.NL' }],
    email_messages: [
      { from_address: 'karl@voorbeeld.nl', date_received: T_LATE },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, true);
  assert.equal(r.channel, 'email');
});

// ── Extra: WA + mail beide -> channel 'both' ─────────────────────────
test('WA + mail beide reageren -> channel:both', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'email_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [
      { customer_id: CUST_ID, last_inbound_at: T_LATE },
    ],
    customers: [{ id: CUST_ID, email: CUST_MAIL }],
    email_messages: [
      { from_address: CUST_MAIL, date_received: T_LATE },
    ],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, true);
  assert.equal(r.channel, 'both');
});

// ── Extra: klant zonder e-mail → alleen WA-check ─────────────────────
test('klant zonder e-mail -> alleen WA-check, mail overgeslagen', async () => {
  const db = makeMockDb({
    dunning_log: [
      { run_id: RUN_ID, event_type: 'whatsapp_sent', created_at: T_SEND },
    ],
    whatsapp_conversations: [
      { customer_id: CUST_ID, last_inbound_at: T_LATE },
    ],
    customers: [{ id: CUST_ID, email: null }],
    email_messages: [],
  });
  const r = await hasReplyAfterLastSend(CUST_ID, RUN_ID, db);
  assert.equal(r.replied, true);
  assert.equal(r.channel, 'whatsapp');
});
