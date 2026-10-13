// tests/toegang-gate-besluit.test.js
//
// Toegang-gate (2026-10-11): alleen een antwoord dat ECHT bij het
// toegangsbericht hoort, rondt de aanvraag af (provisioning + "je
// inloggegevens zijn verstuurd"). Aanleiding: 10/10 ~22:57 gaf een tik op
// "Ja, vertel me meer" onder massa_heropenen toegang aan een testlead.
//   1. puur: gateBesluit (context → toegangsbericht / ander bericht; zonder
//      context: venster + geen later template);
//   2. beoordeelToegangGate tegen een nep-DB (incl. fail-closed);
//   3. de ECHTE webhook-verwerking (verwerkWhatsAppWebhookBody): massa-"Ja"
//      → geen claim, geen provisioning; antwoord op het toegangsbericht →
//      toegang zoals voorheen;
//   4. bedrading: beide webhooks (Meta/360 + GHL) gebruiken het besluit.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const NU = new Date('2026-10-10T20:57:52Z');
const AANVRAAG = {
  id: 'aanvraag-1', voornaam: 'Jeffrey', email: 'jeffrey@example.com', telefoon: '+31655270212', soort: 'minicursus',
  status: 'wachtend', telefoon_last9: '655270212', provisioned_at: null,
  created_at: '2026-10-08T14:22:02Z', bevestiging_sent_at: '2026-10-08T14:24:00Z',
  reminder_2u_at: '2026-10-08T16:25:00Z', reminder_24u_at: '2026-10-09T14:25:00Z', reminder_48u_at: '2026-10-10T14:25:00Z',
};

// ── Nep-database ───────────────────────────────────────────────────────────
function nepDb(tab, { faal = null } = {}) {
  const db = { tab, inserts: [] };
  db.from = (t) => {
    const f = []; let op = 'select'; let patch = null; let rijenIn = null; let lim = null; let sort = null; let terug = false; let enkel = null;
    const k = {
      select: () => { if (op !== 'select') terug = true; return k; },
      eq: (c, v) => { f.push((r) => String(r[c]) === String(v)); return k; },
      neq: (c, v) => { f.push((r) => r[c] !== v); return k; },
      in: (c, v) => { f.push((r) => v.map(String).includes(String(r[c]))); return k; },
      is: (c, v) => { f.push((r) => (v === null ? r[c] == null : r[c] === v)); return k; },
      not: (c, o, v) => { f.push((r) => (o === 'is' && v === null ? r[c] != null : true)); return k; },
      gt: (c, v) => { f.push((r) => r[c] != null && String(r[c]) > String(v)); return k; },
      gte: (c, v) => { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return k; },
      lt: (c, v) => { f.push((r) => r[c] != null && String(r[c]) < String(v)); return k; },
      ilike: () => k, or: () => k, contains: () => k,
      order: (c, o) => { sort = [c, o?.ascending !== false]; return k; },
      limit: (n) => { lim = n; return k; },
      update: (p) => { op = 'update'; patch = p; return k; },
      upsert: (r) => { op = 'insert'; rijenIn = Array.isArray(r) ? r : [r]; return k; },
      insert: (r) => { op = 'insert'; rijenIn = Array.isArray(r) ? r : [r]; return k; },
      delete: () => { op = 'delete'; return k; },
      maybeSingle: () => { enkel = 'maybe'; return k; },
      single: () => { enkel = 'single'; return k; },
      then(ok, nok) {
        if (faal && faal === t) return Promise.resolve({ data: null, error: { message: 'kapot' } }).then(ok, nok);
        const rijen = tab[t] || (tab[t] = []);
        let res;
        if (op === 'insert') {
          const nieuw = rijenIn.map((r, i) => ({ id: `${t}-${rijen.length + i + 1}`, ...r }));
          rijen.push(...nieuw); db.inserts.push(...nieuw.map((rij) => ({ t, rij })));
          res = { data: enkel ? nieuw[0] : nieuw, error: null };
        } else {
          let sel = rijen.filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') { for (const r of sel) Object.assign(r, patch); res = { data: terug ? (enkel ? (sel[0] ? { ...sel[0] } : null) : sel.map((r) => ({ ...r }))) : null, error: null }; }
          else if (op === 'delete') { tab[t] = rijen.filter((r) => !sel.includes(r)); res = { data: sel, error: null }; }
          else {
            if (sort) sel = [...sel].sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : String(a[sort[0]]) > String(b[sort[0]]) ? 1 : 0) * (sort[1] ? 1 : -1));
            if (lim != null) sel = sel.slice(0, lim);
            res = { data: enkel ? (sel[0] ? { ...sel[0] } : null) : sel.map((r) => ({ ...r })), error: null };
          }
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  };
  db.rpc = async () => ({ data: null, error: null });
  return db;
}

const CONV = '5505a8e3-0000-4000-8000-000000000001';
const berichten = () => [
  { id: 'm1', conversation_id: CONV, direction: 'out', template_name: 'bevestig_toegang_b', meta_wamid: 'wamid.GATE', created_at: '2026-10-08T14:24:00Z' },
  { id: 'm2', conversation_id: CONV, direction: 'out', template_name: 'reminder_toegang_48u_v3', meta_wamid: 'wamid.REM48', created_at: '2026-10-10T14:25:00Z' },
  { id: 'm3', conversation_id: CONV, direction: 'out', template_name: 'massa_heropenen', meta_wamid: 'wamid.MASSA', created_at: '2026-10-10T20:37:13Z' },
];

// ── Mocks voor de echte webhook (stap 3) ───────────────────────────────────
const geroepen = { provisioning: [], waLog: [] };
let actieveDb = nepDb({});
const proxyDb = { from: (t) => actieveDb.from(t), rpc: (...a) => actieveDb.rpc(...a) };
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: proxyDb, supabase: proxyDb, createUserClient: () => proxyDb, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/toegang-provisioning-caller.js'), { namedExports: { belProvisioning: async (a) => { geroepen.provisioning.push(a); return { ok: true, status: 200, body: {} }; } } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async (_sb, a) => { geroepen.waLog.push(a); return { ok: true }; } } });
mock.module(url('api/_lib/wa-gesprek-lijn.js'), { namedExports: {
  vindOfHechtGesprek: async () => ({ conv: { id: CONV, phone_number: '+31655270212', phone_number_id: '1273723375834177', status: 'open', customer_id: null }, lijnId: '1273723375834177' }),
} });

const G = await import(url('api/_lib/toegang-gate-besluit.js'));

// ── 1. Puur ────────────────────────────────────────────────────────────────

test('gateBesluit: met context telt alleen een antwoord óp een toegangsbericht', () => {
  const nuMs = NU.getTime();
  assert.deepEqual(G.gateBesluit({ aanvraag: AANVRAAG, heeftContext: true, contextGevonden: true, contextTemplate: 'massa_heropenen', nuMs }), { ok: false, reden: 'antwoord_op_ander_bericht' });
  assert.deepEqual(G.gateBesluit({ aanvraag: AANVRAAG, heeftContext: true, contextGevonden: true, contextTemplate: 'bevestig_toegang_b', nuMs }), { ok: true, reden: 'antwoord_op_toegangsbericht' });
  assert.equal(G.gateBesluit({ aanvraag: AANVRAAG, heeftContext: true, contextGevonden: true, contextTemplate: 'reminder_toegang_48u_v3', nuMs: Date.parse('2026-12-01T00:00:00Z') }).ok, true, 'expliciet antwoord op het toegangsbericht: ook na het venster');
  assert.equal(G.gateBesluit({ aanvraag: AANVRAAG, heeftContext: true, contextGevonden: true, contextTemplate: null, nuMs }).ok, false, 'antwoord op vrije tekst/ander bericht');
});

test('gateBesluit: zonder context → venster na het laatste toegangsbericht en geen later template', () => {
  assert.equal(G.laatsteGateMoment(AANVRAAG), Date.parse('2026-10-10T14:25:00Z'));
  const binnen = Date.parse('2026-10-10T15:00:00Z');
  assert.deepEqual(G.gateBesluit({ aanvraag: AANVRAAG, nuMs: binnen }), { ok: true, reden: 'binnen_venster' });
  assert.deepEqual(G.gateBesluit({ aanvraag: AANVRAAG, latereTemplate: 'massa_heropenen', nuMs: binnen }), { ok: false, reden: 'antwoord_hoort_bij_later_bericht' });
  assert.deepEqual(G.gateBesluit({ aanvraag: AANVRAAG, nuMs: Date.parse('2026-10-13T15:00:00Z') }), { ok: false, reden: 'buiten_venster' });
  assert.equal(G.gateBesluit({ aanvraag: { created_at: '2026-10-10T14:00:00Z' }, nuMs: binnen }).ok, true, 'vlak na de aanvraag, nog vóór de bevestiging');
  assert.equal(G.gateBesluit({ aanvraag: {}, nuMs: binnen }).reden, 'geen_gate_moment');
  assert.equal(G.gateBesluit({ aanvraag: AANVRAAG, heeftContext: true, contextGevonden: false, nuMs: binnen }).reden, 'context_onbekend_binnen_venster');
  assert.equal(G.GATE_VENSTER_UUR, 72);
});

// ── 2. Met DB ──────────────────────────────────────────────────────────────

test('beoordeelToegangGate: leest context + latere berichten; fail-closed', async () => {
  const db = nepDb({ whatsapp_messages: berichten() });
  const ja = (await G.beoordeelToegangGate(db, { aanvraag: AANVRAAG, contextWamid: 'wamid.GATE', convId: CONV, nu: NU }));
  assert.equal(ja.ok, true); assert.equal(ja.context_template, 'bevestig_toegang_b');
  const massa = await G.beoordeelToegangGate(db, { aanvraag: AANVRAAG, contextWamid: 'wamid.MASSA', convId: CONV, nu: NU });
  assert.deepEqual([massa.ok, massa.reden, massa.context_template], [false, 'antwoord_op_ander_bericht', 'massa_heropenen']);
  const getypt = await G.beoordeelToegangGate(db, { aanvraag: AANVRAAG, contextWamid: null, convId: CONV, nu: NU });
  assert.deepEqual([getypt.ok, getypt.reden, getypt.later_template], [false, 'antwoord_hoort_bij_later_bericht', 'massa_heropenen'], 'getypt "ja" na een massa-WhatsApp hoort bij de massa');
  db.tab.whatsapp_messages = berichten().filter((m) => m.id !== 'm3');
  assert.equal((await G.beoordeelToegangGate(db, { aanvraag: AANVRAAG, contextWamid: null, convId: CONV, nu: NU })).ok, true);
  const kapot = await G.beoordeelToegangGate(nepDb({}, { faal: 'whatsapp_messages' }), { aanvraag: AANVRAAG, contextWamid: 'wamid.X', convId: CONV, nu: NU });
  assert.deepEqual([kapot.ok, kapot.reden], [false, 'besluit_fout'], 'bij twijfel geen automatische toegang');
});

// DE OORZAAK VAN EEN TOETS DIE OP 13 OKT 14:25 UTC OMVIEL. Deze bak toetst de
// venstergrens via de webhook, en die geeft `nu` niet mee. Stond de standaard
// op `new Date()`, dan las de gate de ECHTE klok terwijl de toets `Date.now`
// stilzet — de Date-constructor trekt zich van een `Date.now`-stub niets aan.
// De fixture is van 10 okt, het venster is 72 uur, dus de toets was groen tot
// 13 okt 14:25 en daarna rood zonder dat er iets aan de code veranderde.
// Hieronder staat de eis: de standaard volgt `Date.now`.
test('beoordeelToegangGate zonder nu: de standaardklok volgt Date.now (geen tijdbom)', async () => {
  const db = () => nepDb({ whatsapp_messages: berichten().filter((m) => m.id !== 'm3') });
  const p = { aanvraag: AANVRAAG, contextWamid: null, convId: CONV };
  const binnen = nu('2026-10-10T15:00:00Z');
  try {
    assert.deepEqual([(await G.beoordeelToegangGate(db(), p)).ok, (await G.beoordeelToegangGate(db(), p)).reden],
      [true, 'binnen_venster'], 'stilgezette klok binnen het venster → ja');
  } finally { binnen(); }
  const buiten = nu('2026-10-20T15:00:00Z');
  try {
    assert.equal((await G.beoordeelToegangGate(db(), p)).reden, 'buiten_venster',
      'stilgezette klok ver buiten het venster → nee; leest de gate hier "binnen_venster", dan negeert de standaard Date.now');
  } finally { buiten(); }
});

// ── 3. De echte webhook-verwerking ─────────────────────────────────────────

function webhookBody({ wamid, context = null, knop = null, tekst = null, ts }) {
  const msg = { from: '31655270212', id: wamid, timestamp: String(Math.floor(Date.parse(ts) / 1000)) };
  if (knop) { msg.type = 'button'; msg.button = { text: knop, payload: knop }; }
  else { msg.type = 'text'; msg.text = { body: tekst }; }
  if (context) msg.context = { from: '31644562426', id: context };
  return { object: 'whatsapp_business_account', entry: [{ id: '2579784712469452', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '31644562426', phone_number_id: '1273723375834177' },
    contacts: [{ wa_id: '31655270212', profile: { name: 'leads test' } }], messages: [msg],
  } }] }] };
}
async function draaiWebhook(body, tab) {
  actieveDb = nepDb(tab);
  geroepen.provisioning.length = 0; geroepen.waLog.length = 0;
  const W = await import(url('api/inbox-webhook.js'));
  const stil = console.log; console.log = () => {};
  try { await W.verwerkWhatsAppWebhookBody({ headers: {} }, body, { bron: '360dialog', nummer: 'hoofdnummer' }); }
  finally { console.log = stil; }
  return actieveDb;
}
const tab = () => ({ toegang_aanvragen: [{ ...AANVRAAG }], whatsapp_messages: berichten(), whatsapp_conversations: [], follow_up_events_log: [] });
const nu = (iso) => { const echt = Date.now; Date.now = () => Date.parse(iso); return () => { Date.now = echt; }; };

test('webhook: massa-"Ja" (knop onder massa_heropenen) → GEEN toegang, GEEN inlogbericht', async () => {
  const terug = nu('2026-10-10T20:57:52Z');
  try {
    const db = await draaiWebhook(webhookBody({ wamid: 'wamid.IN1', context: 'wamid.MASSA', knop: 'Ja, vertel me meer', ts: '2026-10-10T20:57:49Z' }), tab());
    assert.equal(db.tab.whatsapp_messages.filter((m) => m.direction === 'in').length, 1, 'het antwoord staat wel in de draad');
    assert.equal(db.tab.toegang_aanvragen[0].status, 'wachtend', 'aanvraag blijft open');
    assert.equal(db.tab.toegang_aanvragen[0].provisioned_at, null);
    assert.equal(geroepen.provisioning.length, 0, 'geen provisioning');
    assert.equal(geroepen.waLog.filter((a) => a.source === 'toegang-gate-inbox-webhook').length, 0, 'geen "je inloggegevens zijn verstuurd"');
    const trace = JSON.stringify(db.tab.follow_up_events_log);
    assert.match(trace, /"stage":"gate-besluit".*"ok":false.*"reden":"antwoord_op_ander_bericht"/);
  } finally { terug(); }
});

test('webhook: getypt "ja" ná een massa-WhatsApp (geen context) → GEEN toegang', async () => {
  const terug = nu('2026-10-10T20:58:00Z');
  try {
    const db = await draaiWebhook(webhookBody({ wamid: 'wamid.IN2', tekst: 'ja graag', ts: '2026-10-10T20:58:00Z' }), tab());
    assert.equal(db.tab.toegang_aanvragen[0].status, 'wachtend');
    assert.equal(geroepen.provisioning.length, 0);
  } finally { terug(); }
});

test('webhook: antwoord op het toegangsbericht → toegang + inlogbericht zoals voorheen', async () => {
  const terug = nu('2026-10-10T20:57:52Z');
  try {
    const db = await draaiWebhook(webhookBody({ wamid: 'wamid.IN3', context: 'wamid.REM48', tekst: 'Ja ik wil toegang', ts: '2026-10-10T20:57:49Z' }), tab());
    assert.equal(db.tab.toegang_aanvragen[0].status, 'gereageerd');
    assert.deepEqual(geroepen.provisioning, [{ email: 'jeffrey@example.com', voornaam: 'Jeffrey', soort: 'minicursus' }]);
    assert.ok(db.tab.toegang_aanvragen[0].provisioned_at, 'provisioned_at gezet → het inlogbericht volgt (sendText; zonder Meta-config in de test soft-skipped)');
  } finally { terug(); }
});

test('webhook: getypt "ja" vlak na de reminder (geen latere massa) → toegang', async () => {
  const terug = nu('2026-10-10T15:00:00Z');
  try {
    const t = tab(); t.whatsapp_messages = berichten().filter((m) => m.id !== 'm3');
    const db = await draaiWebhook(webhookBody({ wamid: 'wamid.IN4', tekst: 'ja', ts: '2026-10-10T15:00:00Z' }), t);
    assert.equal(db.tab.toegang_aanvragen[0].status, 'gereageerd');
    assert.equal(geroepen.provisioning.length, 1);
  } finally { terug(); }
});

// ── 4. Bedrading ───────────────────────────────────────────────────────────

test('bedrading: beide webhooks beslissen vóór claim/zusterrijen/provisioning', () => {
  const meta = lees('api/inbox-webhook.js');
  assert.match(meta, /beoordeelToegangGate\(supabaseAdmin, \{\s*aanvraag: kandidaten\[0\], contextWamid: msg\.context\?\.id \|\| null, convId: conv\?\.id \|\| null,/);
  assert.ok(meta.indexOf('beoordeelToegangGate(supabaseAdmin') < meta.indexOf('const primair = kandidaten[0] || null;'));
  assert.match(meta, /\.select\(GATE_AANVRAAG_VELDEN\)/);
  const ghl = lees('api/follow-up-ghl-conversation-webhook.js');
  assert.match(ghl, /beoordeelToegangGate\(supabaseAdmin, \{ aanvraag: kandidaten\[0\] \}\)/);
  assert.ok(ghl.indexOf('beoordeelToegangGate(supabaseAdmin') < ghl.indexOf('const primair = kandidaten[0] || null;'));
  assert.match(ghl, /\.select\(GATE_AANVRAAG_VELDEN\)/);
});
