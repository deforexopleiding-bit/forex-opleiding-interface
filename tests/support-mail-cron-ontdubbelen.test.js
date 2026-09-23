// tests/support-mail-cron-ontdubbelen.test.js
//
// EEN MAILANTWOORD KOMT PRECIES ÉÉN KEER IN DE THREAD.
//
// De mailcron (api/cron-support-mail.js) ziet elke mail tientallen keren
// langs komen, en dezelfde mail staat vaak twee keer in email_messages: één
// keer per mailbox (info@ en events@). Drie regels die deze test vastlegt:
//
//   1. ONTDUBBELEN OP MESSAGE-ID. Twee kopieën van één mail leveren één
//      bericht op, en een Message-ID die al in een bericht staat levert er
//      geen.
//
//   2. EEN BOTSING OP DE UNIEKE INDEX IS "AL VERWERKT", GEEN STORING. Twee
//      gelijktijdige runs komen allebei langs de check; de database weigert
//      de tweede insert. Die run doet dan niets meer: geen statuswissel,
//      geen tweede melding, geen fout in het rapport.
//
//   3. KAN DE CRON NIET METEN, DAN SCHRIJFT HIJ NIETS. Een fout in de
//      idempotentie-check betekent overslaan, niet invoegen.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const GESPREK = {
  id: 'gesprek-1', kenmerk: 'SUP-Z3HB8F', email: 'paulien@hotmail.com',
  naam: 'Paulien', onderwerp: 'Toegang LMS', status: 'wacht_op_klant',
};

const nu = new Date().toISOString();
const MAIL = (id, message_id, extra = {}) => ({
  id, message_id,
  subject: 'Re: Antwoord op je vraag (SUP-Z3HB8F)',
  from_address: 'paulien@hotmail.com',
  body_text: 'Ja hoor, mijn nummer is 0470 12 34 56.\n\nOp 23 sep schreef Support:\n> Hallo',
  snippet: null,
  date_received: nu,
  ...extra,
});

/**
 * Supabase-dubbelganger. Houdt per query de filters bij, zodat de uitkomst
 * kan afhangen van wat er gevraagd wordt (bron_email_id vs bron_message_id).
 */
function nepAdmin({ mails = [], bekendPerId = [], bekendPerMessage = [], bekendFout = null }) {
  const updates = [];
  const queries = [];
  return {
    updates,
    queries,
    from(tabel) {
      const st = { tabel, filters: [] };
      queries.push(st);
      const resultaat = () => {
        if (tabel === 'email_messages') return { data: mails, error: null };
        if (tabel === 'support_gesprekken') return { data: [GESPREK], error: null };
        if (tabel === 'support_berichten') {
          if (st.patch) return { data: [], error: null };
          const inFilter = st.filters.find((f) => f[0] === 'in');
          if (inFilter?.[1] === 'meta->>bron_email_id') {
            if (bekendFout) return { data: null, error: { message: bekendFout } };
            return { data: bekendPerId.map((id) => ({ meta: { bron_email_id: id } })), error: null };
          }
          if (inFilter?.[1] === 'meta->>bron_message_id') {
            return { data: bekendPerMessage.map((m) => ({ meta: { bron_message_id: m } })), error: null };
          }
          return { data: [], error: null }; // wachtende antwoorden: geen
        }
        return { data: [], error: null };
      };
      const k = {
        select: () => k, eq: (...a) => { st.filters.push(['eq', ...a]); return k; },
        in: (...a) => { st.filters.push(['in', ...a]); return k; },
        contains: () => k, gte: () => k, lt: () => k, ilike: () => k, order: () => k, limit: () => k,
        update(v) { st.patch = v; updates.push({ tabel, patch: v }); return k; },
        maybeSingle: async () => ({ data: resultaat().data?.[0] || null, error: resultaat().error }),
        then: (r, j) => Promise.resolve(resultaat()).then(r, j),
      };
      return k;
    },
  };
}

async function draai({ admin, insertFout = null } = {}) {
  const inserts = [];
  const meldingen = [];
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: admin, checkCronAuth: () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/support-sessie.js'), {
    namedExports: {
      schrijfBerichtOfFout: async (opts) => {
        inserts.push(opts);
        const fout = typeof insertFout === 'function' ? insertFout(inserts.length) : insertFout;
        if (fout) return { bericht: null, error: fout };
        return { bericht: { id: 'b' + inserts.length, ...opts }, error: null };
      },
    },
  });
  mock.module(url('api/_lib/support-mail.js'), {
    namedExports: { stuurAntwoordMail: async () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/notify.js'), {
    namedExports: {
      resolveOntvangersVoorRecht: async () => ({ userIds: ['u1'] }),
      createNotification: async (n) => { meldingen.push(n); return { ok: true }; },
    },
  });
  const mod = await import(url('api/cron-support-mail.js') + '?t=' + Math.random());
  const res = { code: null, body: null,
    setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default({ method: 'GET', headers: {} }, res);
  const statusWissels = admin.updates.filter((u) => u.tabel === 'support_gesprekken');
  return { uit: res.body, inserts, meldingen, statusWissels };
}

const BOTSING = (index) => ({
  code: '23505',
  message: `duplicate key value violates unique constraint "${index}"`,
});

// ═══════════════════════════════════════════════════════════════════════════

test('gewone mail: één bericht met bron_email_id én bron_message_id', async (t) => {
  t.after(() => mock.reset());
  const { uit, inserts, meldingen, statusWissels } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-info', '<abc@gmail.com>')] }),
  });
  assert.equal(inserts.length, 1);
  assert.deepEqual(inserts[0].meta, { via: 'mail', bron_email_id: 'rij-info', bron_message_id: 'abc@gmail.com' });
  assert.equal(inserts[0].tekst, 'Ja hoor, mijn nummer is 0470 12 34 56.');
  assert.equal(uit.binnengekomen, 1);
  assert.equal(statusWissels.length, 1);
  assert.equal(meldingen.length, 1);
});

test('dezelfde mail in info@ en events@: één bericht', async (t) => {
  t.after(() => mock.reset());
  const { uit, inserts } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-info', '<abc@gmail.com>'), MAIL('rij-events', '<abc@gmail.com>')] }),
  });
  assert.equal(inserts.length, 1);
  assert.equal(uit.binnengekomen, 1);
});

test('de kopie met body wint van de kopie zonder', async (t) => {
  t.after(() => mock.reset());
  const { inserts } = await draai({
    admin: nepAdmin({ mails: [
      MAIL('rij-zonder-body', '<abc@gmail.com>', { body_text: null }),
      MAIL('rij-met-body', '<abc@gmail.com>'),
    ] }),
  });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].meta.bron_email_id, 'rij-met-body');
});

test('een Message-ID die al in een bericht staat: niets, ook niet vanuit de andere mailbox', async (t) => {
  t.after(() => mock.reset());
  const { uit, inserts, meldingen, statusWissels } = await draai({
    admin: nepAdmin({
      mails: [MAIL('rij-events', '<abc@gmail.com>')],
      bekendPerMessage: ['abc@gmail.com'],
    }),
  });
  assert.equal(inserts.length, 0);
  assert.equal(uit.binnengekomen, 0);
  assert.equal(statusWissels.length, 0);
  assert.equal(meldingen.length, 0);
});

test('een rij-id dat al in een bericht staat: niets', async (t) => {
  t.after(() => mock.reset());
  const { inserts } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-info', null)], bekendPerId: ['rij-info'] }),
  });
  assert.equal(inserts.length, 0);
});

for (const index of ['uniq_support_bericht_bron_email', 'uniq_support_bericht_bron_message']) {
  test(`botsing op ${index}: al verwerkt, geen status, geen melding, geen fout`, async (t) => {
    t.after(() => mock.reset());
    const { uit, inserts, meldingen, statusWissels } = await draai({
      admin: nepAdmin({ mails: [MAIL('rij-info', '<abc@gmail.com>')] }),
      insertFout: BOTSING(index),
    });
    assert.equal(inserts.length, 1, 'de insert is geprobeerd');
    assert.equal(uit.al_verwerkt, 1);
    assert.equal(uit.binnengekomen, 0);
    assert.deepEqual(uit.fouten, []);
    assert.equal(statusWissels.length, 0, 'de winnende run zette de status al');
    assert.equal(meldingen.length, 0, 'de winnende run meldde al');
  });
}

test('botsing op een andere index telt wél als fout', async (t) => {
  t.after(() => mock.reset());
  const { uit, statusWissels } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-info', '<abc@gmail.com>')] }),
    insertFout: BOTSING('support_berichten_pkey'),
  });
  assert.equal(uit.al_verwerkt, 0);
  assert.equal(uit.fouten.length, 1);
  assert.equal(statusWissels.length, 0);
});

test('een botsing op de ene mail houdt de volgende niet tegen', async (t) => {
  t.after(() => mock.reset());
  const { uit, inserts } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-a', '<a@x>'), MAIL('rij-b', '<b@x>')] }),
    insertFout: (n) => (n === 1 ? BOTSING('uniq_support_bericht_bron_email') : null),
  });
  assert.equal(inserts.length, 2);
  assert.equal(uit.al_verwerkt, 1);
  assert.equal(uit.binnengekomen, 1);
});

test('idempotentie-check faalt: niets geschreven, fout gerapporteerd', async (t) => {
  t.after(() => mock.reset());
  const { uit, inserts } = await draai({
    admin: nepAdmin({ mails: [MAIL('rij-info', '<abc@gmail.com>')], bekendFout: 'statement timeout' }),
  });
  assert.equal(inserts.length, 0);
  assert.equal(uit.fouten.length, 1);
  assert.match(uit.fouten[0], /idempotentie-check/);
});
