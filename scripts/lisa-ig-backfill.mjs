#!/usr/bin/env node
// scripts/lisa-ig-backfill.mjs
//
// EENMALIGE BACKFILL van Instagram-gesprekken die sinds 8 sep 2026 gemist zijn.
//
// Waarom: van 8 sep (#1523) tot de webhook-fix liet api/lisa-ghl-webhook.js
// elk bericht zonder GHL messageId vallen — ook de eerste DM van nieuwe
// contacten. De poll-cron kent alleen BESTAANDE lisa_conversations, dus nieuwe
// leads uit die periode staan nergens. Dit script haalt ze uit GHL.
//
// ════════════════════════════════════════════════════════════════════════
//  DRY-RUN IS DE DEFAULT. Zonder --apply wordt er NIETS geschreven: de
//  database-client is dan read-only gewikkeld (insert/update/upsert/delete
//  gooien). Er gaat NOOIT een bericht naar een klant: dit script roept geen
//  send-, AI- of follow-up-code aan, alleen GHL GET-endpoints.
// ════════════════════════════════════════════════════════════════════════
//
// Werkwijze:
//   1. GHL /conversations/search?locationId=… gesorteerd op last_message_date
//      desc, gepagineerd met startAfterDate, tot vóór --since.
//      LET OP: GHL negeert de lastMessageType-filter (zie poll-cron), dus we
//      filteren zelf. Default: alleen gesprekken waarvan lastMessageType/type
//      Instagram is. Met --scan-all halen we van ÁLLE gesprekken de berichten
//      op en filteren per bericht (vangt een IG-gesprek waarvan het laatste
//      bericht via een ander kanaal ging; kost veel meer API-calls).
//   2. Per gesprek /conversations/{id}/messages (gepagineerd via lastMessageId)
//      tot vóór --since; alleen IG-berichten met bekende richting.
//   3. Per bericht dezelfde dedup-regel als webhook/poll (classifyLisaMessage /
//      ingestLisaMessage in api/_lib/lisa-message-ingest.js): bestaat de id al
//      → present; id-loze tweeling → upgrade; anders insert.
//
// Idempotent: een tweede --apply-run rapporteert alles als 'present'.
// Nieuwe gesprekken krijgen phase='cold' (zoals de poll) — Lisa gaat ze NIET
// alsnog beantwoorden; dit is puur zichtbaarheid.
//
// Gebruik (PowerShell, vanuit de repo-root):
//   node --env-file=<pad-naar-env> scripts/lisa-ig-backfill.mjs               # dry-run
//   node --env-file=<pad-naar-env> scripts/lisa-ig-backfill.mjs --apply       # echt schrijven
//
// Env: GHL_API_KEY, GHL_LOCATION_ID, SUPABASE_URL (of NEXT_PUBLIC_SUPABASE_URL),
//      SUPABASE_SERVICE_ROLE_KEY.
//
// Opties:
//   --apply                schrijf weg (default: dry-run)
//   --since=ISO            ondergrens (default 2026-09-08T00:00:00Z)
//   --scan-all             niet voorfilteren op lastMessageType
//   --max-convs=N          stop na N GHL-gesprekken (default 2000)
//   --report=pad.json      JSON-rapport (default <tmpdir>/lisa-ig-backfill-report.json)

import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInstagram, resolveContent, detectDirection } from '../api/_lib/lisa-message-type.js';
import { classifyLisaMessage, ingestLisaMessage } from '../api/_lib/lisa-message-ingest.js';

const GHL_API_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION  = '2021-04-15';
const THROTTLE_MS  = 200;               // GHL ~100 req/min/locatie → ruim eronder
const CONV_PAGE    = 100;
const MSG_PAGE     = 100;

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v === undefined ? true : v];
}));
const APPLY     = args.apply === true;
const SINCE     = String(args.since || '2026-09-08T00:00:00Z');
const SINCE_MS  = new Date(SINCE).getTime();
const SCAN_ALL  = args['scan-all'] === true;
const MAX_CONVS = Number(args['max-convs']) > 0 ? Number(args['max-convs']) : 2000;
const REPORT    = String(args.report || join(tmpdir(), 'lisa-ig-backfill-report.json'));

function fail(msg) { console.error('[lisa-ig-backfill] ' + msg); process.exit(1); }

if (!Number.isFinite(SINCE_MS)) fail('ongeldige --since');
const SUPA_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GHL_KEY  = process.env.GHL_API_KEY;
const LOC      = process.env.GHL_LOCATION_ID;
const missing = [
  !SUPA_URL && 'SUPABASE_URL', !SUPA_KEY && 'SUPABASE_SERVICE_ROLE_KEY',
  !GHL_KEY && 'GHL_API_KEY', !LOC && 'GHL_LOCATION_ID',
].filter(Boolean);
if (missing.length) fail('env ontbreekt: ' + missing.join(', '));

// ── DB-client: read-only in dry-run ────────────────────────────────────────
const rawDb = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } });
const WRITES = new Set(['insert', 'update', 'upsert', 'delete']);
const db = APPLY ? rawDb : new Proxy(rawDb, {
  get(t, p) {
    if (p === 'from') {
      return (tbl) => new Proxy(t.from(tbl), {
        get(q, k) {
          if (WRITES.has(k)) return () => { throw new Error(`DRY-RUN: ${String(k)} op ${tbl} geblokkeerd`); };
          const v = q[k]; return typeof v === 'function' ? v.bind(q) : v;
        },
      });
    }
    if (p === 'rpc') return () => { throw new Error('DRY-RUN: rpc geblokkeerd'); };
    const v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ghl(url) {
  for (let poging = 0; poging < 4; poging++) {
    await sleep(THROTTLE_MS);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${GHL_KEY}`, Version: GHL_VERSION, Accept: 'application/json' },
    });
    if (res.status === 429) { await sleep(2000 * (poging + 1)); continue; }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`GHL HTTP ${res.status} ${url.replace(LOC, '<loc>')}: ${t.slice(0, 200)}`);
    }
    return res.json();
  }
  throw new Error('GHL 429 na 4 pogingen');
}

const msOf = (v) => {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  const n = Number(v); if (Number.isFinite(n) && String(v).trim() !== '') return n;
  return new Date(v).getTime();
};

// ── 1. Gesprekken uit GHL ─────────────────────────────────────────────────
async function* ghlConversations() {
  let startAfter = null, total = 0;
  while (total < MAX_CONVS) {
    const u = new URL(`${GHL_API_BASE}/conversations/search`);
    u.searchParams.set('locationId', LOC);
    u.searchParams.set('limit', String(CONV_PAGE));
    u.searchParams.set('sortBy', 'last_message_date');
    u.searchParams.set('sort', 'desc');
    if (startAfter != null) u.searchParams.set('startAfterDate', String(startAfter));
    const data = await ghl(u.toString());
    const list = data.conversations || data.data || [];
    if (!list.length) return;
    for (const c of list) {
      total++;
      const last = msOf(c.lastMessageDate ?? c.dateUpdated);
      if (Number.isFinite(last) && last < SINCE_MS) return;    // gesorteerd desc → klaar
      yield c;
      if (total >= MAX_CONVS) return;
    }
    const tail = list[list.length - 1];
    const next = Array.isArray(tail.sort) && tail.sort.length ? tail.sort[0] : msOf(tail.lastMessageDate ?? tail.dateUpdated);
    if (next == null || next === startAfter || list.length < CONV_PAGE) return;
    startAfter = next;
  }
}

// ── 2. Berichten per gesprek ──────────────────────────────────────────────
async function ghlMessages(convId) {
  const out = [];
  let lastId = null;
  for (let page = 0; page < 50; page++) {
    const u = new URL(`${GHL_API_BASE}/conversations/${convId}/messages`);
    u.searchParams.set('limit', String(MSG_PAGE));
    if (lastId) u.searchParams.set('lastMessageId', lastId);
    const data = await ghl(u.toString());
    const box = data.messages && !Array.isArray(data.messages) ? data.messages : data;
    const msgs = box.messages || data.data || [];
    let older = false;
    for (const m of msgs) {
      const t = msOf(m.dateAdded || m.dateCreated || m.createdAt);
      if (Number.isFinite(t) && t < SINCE_MS) { older = true; continue; }
      out.push(m);
    }
    if (older || !box.nextPage || !box.lastMessageId || box.lastMessageId === lastId) break;
    lastId = box.lastMessageId;
  }
  return out;
}

// ── 3. Plan + (optioneel) uitvoeren ───────────────────────────────────────
const report = {
  mode: APPLY ? 'apply' : 'dry-run', since: SINCE, scan_all: SCAN_ALL, started_at: new Date().toISOString(),
  ghl_conversations_seen: 0, ghl_conversations_ig: 0,
  conversations_existing: 0, conversations_to_create: 0, conversations_created: 0,
  messages_ig_seen: 0, skipped_no_direction: 0, skipped_no_id: 0,
  present: 0, twin_present: 0,
  to_insert: { in: 0, out: 0 }, to_upgrade: { in: 0, out: 0 },
  inserted: { in: 0, out: 0 }, upgraded: { in: 0, out: 0 }, duplicate_on_apply: 0,
  errors: [], conversations: [],
};

const convCache = new Map();
async function findConv(contactId) {
  if (convCache.has(contactId)) return convCache.get(contactId);
  const { data, error } = await db.from('lisa_conversations').select('id, unread_count')
    .eq('ghl_contact_id', contactId).eq('is_sandbox', false).maybeSingle();
  if (error) throw new Error('conv select: ' + error.message);
  convCache.set(contactId, data || null);
  return data || null;
}

for await (const convo of ghlConversations()) {
  report.ghl_conversations_seen++;
  const contactId = convo.contactId;
  if (!contactId || !convo.id) continue;
  if (!SCAN_ALL && !isInstagram(convo)) continue;

  let msgs;
  try { msgs = await ghlMessages(convo.id); }
  catch (e) { report.errors.push({ ghl_conversation_id: convo.id, fase: 'messages', fout: e.message }); continue; }

  const ig = [];
  for (const m of msgs) {
    if (!isInstagram(m)) continue;
    report.messages_ig_seen++;
    const direction = detectDirection(m);
    if (!direction) { report.skipped_no_direction++; continue; }
    const id = m.id || m.messageId;
    if (!id) { report.skipped_no_id++; continue; }
    ig.push({ m, direction, id });
  }
  if (!ig.length) continue;
  report.ghl_conversations_ig++;

  const entry = {
    ghl_contact_id: contactId, ghl_conversation_id: convo.id,
    name: convo.fullName || convo.contactName || null,
    lisa_conversation_id: null, status: null,
    plan: { present: 0, twin_present: 0, insert: 0, upgrade: 0 },
  };
  let conv;
  try { conv = await findConv(contactId); }
  catch (e) { report.errors.push({ ghl_contact_id: contactId, fase: 'conv', fout: e.message }); continue; }

  if (conv) { report.conversations_existing++; entry.status = 'existing'; entry.lisa_conversation_id = conv.id; }
  else { report.conversations_to_create++; entry.status = 'to_create'; }

  // Oudste eerst, zodat een upgrade de juiste (vroegste) tweeling pakt.
  ig.sort((a, b) => msOf(a.m.dateAdded) - msOf(b.m.dateAdded));

  if (APPLY && !conv) {
    const firstAt = ig[0].m.dateAdded ? new Date(msOf(ig[0].m.dateAdded)).toISOString() : new Date().toISOString();
    const { data: created, error } = await db.from('lisa_conversations').insert({
      ghl_contact_id: contactId, ghl_conversation_id: convo.id,
      ghl_location_id: convo.locationId || LOC, contact_name: entry.name,
      source: 'instagram', is_sandbox: false, phase: 'cold', first_message_at: firstAt,
    }).select('id, unread_count').single();
    if (error) {
      // 23505 = parallel aangemaakt (webhook) → opnieuw lezen.
      convCache.delete(contactId);
      conv = await findConv(contactId).catch(() => null);
      if (!conv) { report.errors.push({ ghl_contact_id: contactId, fase: 'conv_insert', fout: error.message }); continue; }
    } else {
      conv = created; convCache.set(contactId, conv); report.conversations_created++;
    }
    entry.lisa_conversation_id = conv.id;
  }

  let newInbound = 0;
  for (const { m, direction, id } of ig) {
    const { message_type, content, attachment_url } = resolveContent(m);
    const sentAt = m.dateAdded ? new Date(msOf(m.dateAdded)).toISOString() : null;
    const msg = {
      conversationId: conv?.id, direction, content, messageType: message_type,
      attachmentUrl: attachment_url, ghlMessageId: id, sentAt,
    };

    if (!APPLY) {
      const k = conv ? await classifyLisaMessage(db, msg) : 'insert';
      if (k === 'error') { report.errors.push({ ghl_message_id: id, fase: 'classify' }); continue; }
      entry.plan[k]++;
      if (k === 'present') report.present++;
      else if (k === 'twin_present') report.twin_present++;
      else if (k === 'insert') report.to_insert[direction]++;
      else if (k === 'upgrade') report.to_upgrade[direction]++;
      continue;
    }

    const r = await ingestLisaMessage(db, msg);
    if (r.status === 'inserted') { report.inserted[direction]++; entry.plan.insert++; if (direction === 'in') newInbound++; }
    else if (r.status === 'upgraded') { report.upgraded[direction]++; entry.plan.upgrade++; }
    else if (r.status === 'duplicate') { report.duplicate_on_apply++; entry.plan.present++; }
    else report.errors.push({ ghl_message_id: id, fase: 'ingest', fout: r.error?.message });
  }

  if (APPLY && newInbound > 0 && conv) {
    const { error } = await db.from('lisa_conversations')
      .update({ unread_count: (conv.unread_count || 0) + newInbound }).eq('id', conv.id);
    if (error) report.errors.push({ lisa_conversation_id: conv.id, fase: 'unread', fout: error.message });
  }
  report.conversations.push(entry);
}

report.finished_at = new Date().toISOString();
writeFileSync(REPORT, JSON.stringify(report, null, 2));
const { conversations: _c, errors, ...summary } = report;
console.log(JSON.stringify({ ...summary, errors: errors.length }, null, 2));
console.log(`[lisa-ig-backfill] rapport: ${REPORT}${APPLY ? '' : '  (DRY-RUN — er is niets geschreven)'}`);
