// tests/ls-gesprekken-porties.test.js
//
// Leadsonderhoud › Gesprekken (2026-10-09): de "≥1 bericht"-check zat in één
// .in('conversation_id', <500 ids>). Bij >~400 ids te lange URL → request faalt,
// fout werd genegeerd → ALLE WhatsApp-gesprekken weg uit de lijst. Nu:
//   1. selectInPorties (api/_lib/in-porties.js): porties, dedup, fouten verzameld;
//   2. het endpoint bepaalt "heeft berichten" via een embed (geen id-lijst in de
//      URL) en valt bij een fout terug op porties van 25 — en logt die fout;
//   3. cron/onboarding-reminders gebruikt porties voor zijn id-lijsten (tot 1000).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selectInPorties, PORTIE } from '../api/_lib/in-porties.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

test('selectInPorties: porties van 100, ontdubbeld, rijen samengevoegd', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => 'id' + i).concat(['id0', null, '']);
  const porties = [];
  const r = await selectInPorties(ids, async (deel) => { porties.push(deel.length); return { data: deel.map((id) => ({ id })), error: null }; });
  assert.equal(PORTIE, 100);
  assert.deepEqual(porties, [100, 100, 50]);
  assert.equal(r.data.length, 250);
  assert.equal(r.error, null);
});

test('selectInPorties: fout in één portie → eerste fout terug, rijen van de rest blijven', async () => {
  let n = 0;
  const r = await selectInPorties(Array.from({ length: 30 }, (_, i) => 'x' + i), async (deel) => {
    n++;
    if (n === 2) return { data: null, error: { message: 'kapot' } };
    if (n === 3) throw new Error('fetch failed');
    return { data: deel.map((id) => ({ id })), error: null };
  }, { grootte: 10 });
  assert.equal(r.data.length, 10);
  assert.equal(r.error.message, 'kapot');
  assert.deepEqual((await selectInPorties([], async () => { throw new Error('niet aanroepen'); })), { data: [], error: null });
});

// ── Endpoint ─────────────────────────────────────────────────────────────────
const LIJN = '1273723375834177';
const THOMAS = { id: 'lead-thomas', voornaam: 'Thomas', achternaam: 'D', email: 'thomas@example.com', telefoon_e164: '+32470000090', traject: '7-daagse' };
const VINCENT = { id: 'lead-vincent', voornaam: 'Vincent', achternaam: 'E', email: 'vincent@example.com', telefoon_e164: '+31600000077', traject: '7-daagse' };

// 600 gesprekken op de lijn; Thomas en Vincent staan er (met bericht) tussen,
// plus een gesprek zonder berichten dat niet mag verschijnen.
function maakConvs() {
  const convs = [];
  for (let i = 0; i < 600; i++) {
    convs.push({ id: 'c' + i, phone_number: '+3161' + String(i).padStart(7, '0'), customer_id: null, attendee_id: null,
      last_message_at: new Date(Date.UTC(2026, 9, 9, 6) - i * 60000).toISOString(), last_message_preview: 'x', unread_count: 0, last_inbound_at: null, _berichten: i % 2 === 0 ? 1 : 0 });
  }
  convs[3] = { ...convs[3], id: 'c-thomas', phone_number: THOMAS.telefoon_e164, last_message_preview: 'Hoi Thomas!', _berichten: 1 };
  convs[7] = { ...convs[7], id: 'c-vincent', phone_number: VINCENT.telefoon_e164, last_message_preview: 'Hoi Vincent!', _berichten: 5 };
  return convs;
}

function nepAdmin({ convs, embedFout = false }) {
  const calls = [];
  const berichten = convs.flatMap((c) => Array.from({ length: c._berichten }, () => ({ conversation_id: c.id })));
  return {
    calls,
    from(tabel) {
      const st = { tabel, select: '', inKol: null, inIds: null, eq: {}, refLimit: null, limit: null };
      const k = {
        select: (s) => { st.select = s; return k; },
        eq: (c, v) => { st.eq[c] = v; return k; },
        neq: () => k, gte: () => k, is: () => k,
        in: (c, v) => { st.inKol = c; st.inIds = v; return k; },
        order: () => k,
        limit: (n, opts) => { if (opts?.referencedTable) st.refLimit = { tabel: opts.referencedTable, n }; else st.limit = n; return k; },
        then(ok, nok) {
          calls.push(st);
          let res = { data: [], error: null };
          if (tabel === 'whatsapp_conversations') {
            const embed = /whatsapp_messages\(id\)/.test(st.select);
            if (embed && embedFout) res = { data: null, error: { message: 'Could not find a relationship' } };
            else {
              const rijen = convs.filter((c) => c.phone_number_id === undefined || c.phone_number_id === st.eq.phone_number_id).slice(0, st.limit || 1000);
              res = { data: rijen.map(({ _berichten, ...c }) => (embed ? { ...c, whatsapp_messages: _berichten ? [{ id: 'm' }] : [] } : c)), error: null };
            }
          } else if (tabel === 'whatsapp_messages') {
            if (st.inIds && st.inIds.length > 100) res = { data: null, error: { message: 'TypeError: fetch failed' } };
            else res = { data: berichten.filter((b) => st.inIds.includes(b.conversation_id)).slice(0, 1000), error: null };
          } else if (tabel === 'leads') {
            res = { data: [], error: null };
          }
          return Promise.resolve(res).then(ok, nok);
        },
      };
      return k;
    },
  };
}

async function draaiEndpoint({ embedFout = false } = {}) {
  const admin = nepAdmin({ convs: maakConvs(), embedFout });
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: admin, createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }) },
  });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
  mock.module(url('api/_lib/inbox-categorie.js'), {
    namedExports: { voegCategorieToe: async (_sb, items) => { for (const it of items) { it.categorie = 'lead_aanmelding'; it.categorie_label = 'Lead-aanmelding'; it.categorie_tags = []; } } },
  });
  const echt = await import(url('api/_lib/leadsonderhoud-gesprekken.js'));
  mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), {
    namedExports: {
      ...echt,
      haalLijn: async () => ({ module: 'leadsonderhoud', phoneNumberId: LIJN, label: 'Esmee' }),
      leadsInTraject: async () => [THOMAS, VINCENT],
      postvakNaam: () => 'welkom',
      mailAfzender: () => 'welkom@deforexopleiding.nl',
    },
  });
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => { errors.push(a.join(' ')); };
  let body = null, status = 200;
  try {
    const { default: handler } = await import(url('api/leadsonderhoud-gesprekken.js') + '?t=' + Date.now() + Math.random());
    const res = { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } };
    await handler({ method: 'GET', headers: {} }, res);
  } finally {
    console.error = origErr;
    mock.reset();
  }
  return { body, status, admin, errors };
}

test('endpoint: 600 gesprekken op de lijn → Thomas en Vincent staan erin (embed, geen id-lijst in de URL)', async () => {
  const { body, status, admin, errors } = await draaiEndpoint();
  assert.equal(status, 200);
  const items = body.items;
  for (const naam of ['Thomas D', 'Vincent E']) {
    const it = items.find((i) => i.naam === naam);
    assert.ok(it, naam + ' ontbreekt in Gesprekken');
    assert.equal(it.has_wa, true);
    assert.equal(it.categorie, 'lead_aanmelding');
  }
  const conv = admin.calls.find((c) => c.tabel === 'whatsapp_conversations');
  assert.match(conv.select, /whatsapp_messages\(id\)/);
  assert.deepEqual(conv.refLimit, { tabel: 'whatsapp_messages', n: 1 });
  assert.equal(conv.limit, 500);
  assert.ok(!admin.calls.some((c) => c.tabel === 'whatsapp_messages'), 'geen losse berichten-query meer');
  // Gesprekken zonder berichten verschijnen niet als lead-loze rij.
  assert.ok(!items.some((i) => i.conversation_id === 'c1'), 'leeg gesprek hoort er niet in');
  assert.ok(items.some((i) => i.conversation_id === 'c2'), 'gesprek met bericht wel');
  assert.deepEqual(errors, []);
});

test('endpoint: embed faalt → fout gelogd, terugval op porties van 25, Thomas en Vincent blijven zichtbaar', async () => {
  const { body, admin, errors } = await draaiEndpoint({ embedFout: true });
  assert.ok(body.items.some((i) => i.naam === 'Thomas D' && i.has_wa));
  assert.ok(body.items.some((i) => i.naam === 'Vincent E' && i.has_wa));
  const msgCalls = admin.calls.filter((c) => c.tabel === 'whatsapp_messages');
  assert.equal(msgCalls.length, 20, '500 gesprekken / 25');
  assert.ok(msgCalls.every((c) => c.inIds.length <= 25));
  assert.ok(errors.some((e) => e.includes('[ls-gesprekken] gesprekken + berichten-embed mislukt') && e.includes('Could not find a relationship')));
});

test('cron/onboarding-reminders: klanten, gesprekken en suggesties in porties', () => {
  const src = readFileSync(join(ROOT, 'api/cron/onboarding-reminders.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /import \{ selectInPorties \} from '\.\.\/_lib\/in-porties\.js';/);
  assert.match(src, /selectInPorties\(customerIds, \(deel\) =>\s+supabaseAdmin\.from\('customers'\)\.select\('id, phone'\)\.in\('id', deel\)\)/);
  assert.match(src, /selectInPorties\(phonesPlus, \(deel\) =>[\s\S]{0,200}\.in\('phone_number', deel\)/);
  assert.match(src, /selectInPorties\(convIds, \(deel\) =>[\s\S]{0,200}\.in\('conversation_id', deel\)/);
  assert.doesNotMatch(src, /\.in\('conversation_id', convIds\)/);
  // Handoff-info van de geslaagde porties wordt ook bij een deelfout gebruikt.
  assert.match(src, /De porties die wél lukten gebruiken we hieronder gewoon\.\n\s+console\.warn[^\n]+\n\s+\}\n\s+for \(const s of \(sugs \|\| \[\]\)\)/);
});
