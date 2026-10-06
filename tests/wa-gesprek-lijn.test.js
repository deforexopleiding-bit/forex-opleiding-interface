// tests/wa-gesprek-lijn.test.js
//
// Eén gesprek per lead op de HUIDIGE lijn, ook na de nummerwissel (2026-10-06):
//   1. transport: een send uit een gesprek op een vervangen lijn gaat via de opvolger;
//   2. vindOfHechtGesprek: gesprek op een oude lead-lijn wordt gehecht, niet verdubbeld;
//      finance/onboarding blijven strikt per lijn;
//   3. logOutboundWa: logt NIET meer in een willekeurig gesprek van het nummer
//      (de oorzaak van de gesplitste inbox);
//   4. upsertOutboundConversation: nieuw gesprek komt op de huidige lijn;
//   5. hechtAanHuidigeLijn na een inbox-send; module-context voor een oud ID;
//   6. v3-template-default en de datafix-SQL (idempotent, backup, geen DELETE).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NIEUW = '1273723375834177';
const OUD_LEAD = '758003047390806';
const OUD_ESMEE = '1232908829908396';
const OUD_EVENTS = '1156034510929407';
const FINANCE = '1194351613761790';

// ── Nep-databank met precies de query-vormen die deze code gebruikt ─────────
const db = { tabellen: {}, volgId: 1 };
function from(tabel) {
  const q = { filters: [], order: null, lim: null, actie: 'select', waarde: null, kol: null, enkel: null };
  const rows = () => (db.tabellen[tabel] ||= []);
  const match = (r) => q.filters.every(([op, c, v]) =>
    op === 'eq' ? String(r[c]) === String(v)
      : op === 'in' ? v.map(String).includes(String(r[c]))
        : op === 'is' ? (r[c] ?? null) === v : true);
  function run() {
    if (q.actie === 'insert') {
      const nieuw = (Array.isArray(q.waarde) ? q.waarde : [q.waarde]).map((w) => ({ id: 'id-' + db.volgId++, ...w }));
      if (tabel === 'whatsapp_conversations') {
        for (const n of nieuw) {
          if (rows().some((r) => r.phone_number === n.phone_number && String(r.phone_number_id) === String(n.phone_number_id))) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
      }
      rows().push(...nieuw);
      return { data: q.enkel ? nieuw[0] : nieuw, error: null };
    }
    if (q.actie === 'update') {
      const hits = rows().filter(match);
      if (tabel === 'whatsapp_conversations' && 'phone_number_id' in q.waarde) {
        for (const h of hits) {
          if (rows().some((r) => r !== h && r.phone_number === h.phone_number && String(r.phone_number_id) === String(q.waarde.phone_number_id))) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
        }
      }
      for (const h of hits) Object.assign(h, q.waarde);
      return { data: hits, error: null };
    }
    let r = rows().filter(match);
    if (q.order) r = r.sort((a, b) => String(b[q.order] || '').localeCompare(String(a[q.order] || '')));
    if (q.lim != null) r = r.slice(0, q.lim);
    if (q.enkel === 'maybe') return { data: r[0] || null, error: null };
    if (q.enkel === 'single') return { data: r[0] || null, error: r[0] ? null : { message: 'geen rij' } };
    return { data: r, error: null };
  }
  const k = {
    select: (kol) => { q.kol = kol; return k; },
    insert: (w) => { q.actie = 'insert'; q.waarde = w; return k; },
    update: (w) => { q.actie = 'update'; q.waarde = w; return k; },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
    in: (c, v) => { q.filters.push(['in', c, v]); return k; },
    is: (c, v) => { q.filters.push(['is', c, v]); return k; },
    order: (c) => { q.order = c; return k; },
    limit: (n) => { q.lim = n; return k; },
    maybeSingle: () => { q.enkel = 'maybe'; return k; },
    single: () => { q.enkel = 'single'; return k; },
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  return k;
}
const sb = { from };
mock.module('../api/supabase.js', { namedExports: { supabaseAdmin: sb, supabase: sb, createUserClient: () => sb } });

process.env.D360_API_KEY_HOOFDNUMMER = 'test-key';
process.env.D360_PHONE_NUMBER_ID_HOOFDNUMMER = NIEUW;

const W = await import('../api/_lib/meta-whatsapp.js');
const L = await import('../api/_lib/wa-gesprek-lijn.js');
const { logOutboundWa } = await import('../api/_lib/wa-outbound-log.js');
const { upsertOutboundConversation } = await import('../api/_lib/conv-upsert.js');
const MC = await import('../api/_lib/module-context.js');

function reset(convs = []) {
  db.tabellen = { whatsapp_conversations: convs.map((c) => ({ ...c })), whatsapp_messages: [], whatsapp_meta_templates: [], whatsapp_module_config: [] };
}
const convs = () => db.tabellen.whatsapp_conversations;

// ── 1. Transport ────────────────────────────────────────────────────────────
test('transport: send uit een gesprek op een oude lead-lijn gaat via het nieuwe nummer', async () => {
  for (const oud of [OUD_LEAD, OUD_ESMEE, OUD_EVENTS]) {
    const r = await W.kiesVerzendroute({ phoneNumberId: oud });
    assert.equal(r.provider, '360dialog', oud);
    assert.equal(r.nummer.sleutel, 'hoofdnummer');
  }
  assert.equal((await W.kiesVerzendroute({ phoneNumberId: FINANCE })).provider, 'meta');
  await assert.rejects(() => W.kiesVerzendroute({ phoneNumberId: OUD_LEAD, module: 'onboarding' }), W.WaGeenNummerError);
});

test('huidigeLijnId / lijnFamilie: oud → nieuw; finance blijft zichzelf', async () => {
  assert.equal(await W.huidigeLijnId(OUD_ESMEE), NIEUW);
  assert.equal(await W.huidigeLijnId(FINANCE), FINANCE);
  const fam = await W.lijnFamilie(NIEUW);
  assert.equal(fam.huidig, NIEUW);
  assert.deepEqual([...fam.alle].sort(), [NIEUW, OUD_LEAD, OUD_ESMEE, OUD_EVENTS].sort());
  assert.deepEqual((await W.lijnFamilie(FINANCE)).alle, [FINANCE]);
});

// ── 2. vindOfHechtGesprek ───────────────────────────────────────────────────
test('vindOfHechtGesprek: gesprek op de huidige lijn wordt gewoon gevonden', async () => {
  reset([{ id: 'c1', phone_number: '+31600000001', phone_number_id: NIEUW }]);
  const r = await L.vindOfHechtGesprek(sb, { phoneE164Plus: '+31600000001', phoneNumberId: NIEUW });
  assert.equal(r.conv.id, 'c1');
  assert.equal(r.gehecht, false);
});

test('vindOfHechtGesprek: alleen een gesprek op een oude lead-lijn → gehecht (zelfde id), geen tweede gesprek', async () => {
  reset([
    { id: 'oud1', phone_number: '+31600000002', phone_number_id: OUD_ESMEE, last_message_at: '2026-10-05' },
    { id: 'oud2', phone_number: '+31600000002', phone_number_id: OUD_LEAD, last_message_at: '2026-10-01' },
    { id: 'fin', phone_number: '+31600000002', phone_number_id: FINANCE, last_message_at: '2026-10-06' },
  ]);
  const r = await L.vindOfHechtGesprek(sb, { phoneE164Plus: '+31600000002', phoneNumberId: NIEUW });
  assert.equal(r.conv.id, 'oud1');           // meest recente lead-gesprek, niet finance
  assert.equal(r.gehecht, true);
  assert.equal(convs().find((c) => c.id === 'oud1').phone_number_id, NIEUW);
  assert.equal(convs().find((c) => c.id === 'fin').phone_number_id, FINANCE);
  assert.equal(convs().length, 3);
});

test('vindOfHechtGesprek: finance-lijn hecht NOOIT een lead-gesprek', async () => {
  reset([{ id: 'oud', phone_number: '+31600000003', phone_number_id: OUD_ESMEE }]);
  const r = await L.vindOfHechtGesprek(sb, { phoneE164Plus: '+31600000003', phoneNumberId: FINANCE });
  assert.equal(r.conv, null);
  assert.equal(r.lijnId, FINANCE);
  assert.equal(convs()[0].phone_number_id, OUD_ESMEE);
});

// ── 3. logOutboundWa — de oorzaak ───────────────────────────────────────────
test('logOutboundWa: lead met alleen een oud gesprek → bericht in DAT gesprek, gesprek nu op de nieuwe lijn', async () => {
  reset([{ id: 'oud', phone_number: '+31600000004', phone_number_id: OUD_LEAD }]);
  const r = await logOutboundWa(sb, { toPhone: '+31600000004', phoneNumberId: NIEUW, body: 'hoi', wamid: 'w1' });
  assert.equal(r.ok, true);
  assert.equal(r.conv_id, 'oud');
  assert.equal(convs().length, 1);
  assert.equal(convs()[0].phone_number_id, NIEUW);
});

test('logOutboundWa: lead met alleen een FINANCE-gesprek → nieuw gesprek op de nieuwe lijn (niet in finance loggen)', async () => {
  reset([{ id: 'fin', phone_number: '+31600000005', phone_number_id: FINANCE }]);
  const r = await logOutboundWa(sb, { toPhone: '+31600000005', phoneNumberId: NIEUW, body: 'hoi', wamid: 'w2' });
  assert.equal(r.ok, true);
  assert.notEqual(r.conv_id, 'fin');
  const nieuw = convs().find((c) => c.id === r.conv_id);
  assert.equal(nieuw.phone_number_id, NIEUW);
  assert.equal(convs().find((c) => c.id === 'fin').phone_number_id, FINANCE);
});

test('logOutboundWa: verzonden met een OUD lijn-ID → toch gelogd op de huidige lijn', async () => {
  reset([]);
  const r = await logOutboundWa(sb, { toPhone: '+31600000006', phoneNumberId: OUD_ESMEE, body: 'x', wamid: 'w3' });
  assert.equal(convs().find((c) => c.id === r.conv_id).phone_number_id, NIEUW);
});

test('logOutboundWa: echte legacy-rij zonder lijn-ID wordt nog steeds gebruikt en geheeld', async () => {
  reset([{ id: 'leeg', phone_number: '+31600000007', phone_number_id: null }]);
  const r = await logOutboundWa(sb, { toPhone: '+31600000007', phoneNumberId: NIEUW, body: 'x', wamid: 'w4' });
  assert.equal(r.conv_id, 'leeg');
  assert.equal(convs()[0].phone_number_id, NIEUW);
});

// ── 4. upsertOutboundConversation ───────────────────────────────────────────
test('upsertOutboundConversation: oud lijn-ID meegegeven → nieuw gesprek op de huidige lijn; oud gesprek wordt gehecht', async () => {
  reset([]);
  const a = await upsertOutboundConversation({ phoneE164Plus: '+31600000008', phoneNumberId: OUD_EVENTS });
  assert.equal(convs().find((c) => c.id === a.id).phone_number_id, NIEUW);
  reset([{ id: 'oud', phone_number: '+31600000009', phone_number_id: OUD_EVENTS }]);
  const b = await upsertOutboundConversation({ phoneE164Plus: '+31600000009', phoneNumberId: NIEUW });
  assert.equal(b.id, 'oud');
  assert.equal(b.created, false);
  assert.equal(convs().length, 1);
});

// ── 5. Na een inbox-send + module-context ──────────────────────────────────
test('hechtAanHuidigeLijn: oud gesprek → nieuwe lijn; bestaat er al één op de nieuwe lijn → ongemoeid (datafix voegt samen)', async () => {
  reset([{ id: 'oud', phone_number: '+31600000010', phone_number_id: OUD_ESMEE }]);
  assert.equal(await L.hechtAanHuidigeLijn(sb, convs()[0]), NIEUW);
  assert.equal(convs()[0].phone_number_id, NIEUW);
  reset([
    { id: 'oud', phone_number: '+31600000011', phone_number_id: OUD_ESMEE },
    { id: 'nw', phone_number: '+31600000011', phone_number_id: NIEUW },
  ]);
  assert.equal(await L.hechtAanHuidigeLijn(sb, convs()[0]), null);
  assert.equal(convs()[0].phone_number_id, OUD_ESMEE);
  reset([{ id: 'fin', phone_number: '+31600000012', phone_number_id: FINANCE }]);
  assert.equal(await L.hechtAanHuidigeLijn(sb, convs()[0]), null);
});

test('module-context: oud lijn-ID zonder eigen rij → module van de huidige lijn (leadsonderhoud)', async () => {
  reset([]);
  db.tabellen.whatsapp_module_config = [
    { module: 'leadsonderhoud', phone_number_id: NIEUW, is_active: true },
    { module: 'events', phone_number_id: NIEUW, is_active: true },
    { module: 'finance', phone_number_id: FINANCE, is_active: true },
  ];
  assert.equal((await MC.getModuleContextByPhoneNumberId(sb, OUD_ESMEE)).module, 'leadsonderhoud');
  assert.equal((await MC.getModuleContextByPhoneNumberId(sb, FINANCE)).module, 'finance');
  assert.equal(await MC.getModuleContextByPhoneNumberId(sb, '999'), null);
});

// ── 6. Bron-checks ──────────────────────────────────────────────────────────
test('events-vragenlijstuitnodiging: default is vragenlijst_herinnering_correct (env blijft overrulen)', () => {
  const src = readFileSync(new URL('../api/_lib/events-questionnaire-invite.js', import.meta.url), 'utf8');
  assert.match(src, /EVENTS_QUESTIONNAIRE_TEMPLATE_NAME \|\| 'vragenlijst_herinnering_correct'/);
  assert.doesNotMatch(src, /\|\| 'vragenlijst_herinnering_v3'/);
});

test('inbox-send(-template) en de webhook gebruiken de lijn-helpers', () => {
  for (const f of ['api/inbox-send.js', 'api/inbox-send-template.js']) {
    assert.match(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /await hechtAanHuidigeLijn\(supabaseAdmin, conv\)/, f);
  }
  assert.match(readFileSync(new URL('../api/inbox-webhook.js', import.meta.url), 'utf8'), /vindOfHechtGesprek\(supabaseAdmin,/);
});

test('datafix-SQL: één DO-block, backup vóór wijziging, idempotent, parkeert i.p.v. verwijdert', () => {
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-10-06-whatsapp-gesprekken-lijn-samenvoegen.sql', import.meta.url), 'utf8');
  const actief = sql.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.equal((actief.match(/DO \$\$/g) || []).length, 1);
  assert.doesNotMatch(actief, /\bDELETE\b|\bDROP\b|TRUNCATE/i);
  assert.match(actief, /HAVING count\(\*\) > 1 OR bool_or\(phone_number_id <> nieuw\)/);
  assert.ok(actief.indexOf('wa_lijnfix_20261006_verhuisd') < actief.indexOf('UPDATE public.whatsapp_messages'));
  for (const id of [NIEUW, OUD_LEAD, OUD_ESMEE, OUD_EVENTS]) assert.ok(actief.includes(id), id);
  assert.ok(!actief.includes(FINANCE) && !actief.includes('1163203046877082'));
});
