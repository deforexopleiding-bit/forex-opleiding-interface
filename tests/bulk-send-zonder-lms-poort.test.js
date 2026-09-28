// tests/bulk-send-zonder-lms-poort.test.js
//
// DE BULK-VERZENDING HEEFT GEEN LMS-POORT MEER (28 september 2026).
//
// Tot nu toe liet api/cron-dunning-bulk-send.js een ontvanger op 'pending'
// staan zolang er in het LMS een stilte/afspraak liep (#1642). Op verzoek is
// die poort uit de bulk-flow gehaald: een goedgekeurde bulk-ronde gaat nu
// ook uit naar een klant met een lopende LMS-stilte.
//
// Deze test draait de echte handler met een nep-database en legt vast:
//   1. een klant met een actieve LMS-stilte wordt WEL gemaand;
//   2. de LMS-stilte wordt niet eens meer bevraagd;
//   3. de send-time hercheck "geen open bedrag meer" slaat nog steeds over.
//
// De stilte-poort in de automatische motor en de gesprek-reminders blijft
// staan — dat bewaken tests/lms-stilte.test.js en lms-geen-hold-poort.test.js.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const JOB = {
  id: 'job-1', channel: 'email', template_name: null, email_template_id: null,
  status: 'approved', batch_size: 10, sent_count: 0, failed_count: 0,
  skipped_count: 0, total_recipients: 2, is_test: false,
};

const ONTVANGER = (id, customer_id) => ({
  id, job_id: 'job-1', customer_id,
  customer_name: 'Klant ' + id, customer_email: id + '@voorbeeld.nl', customer_phone: null,
  channel_whatsapp: false, channel_email: true, invoice_ids: [],
  resolved_preview_whatsapp: null,
  resolved_preview_email_subject: 'Herinnering', resolved_preview_email_body: 'Graag betalen.',
  status: 'pending',
});

const MET_STILTE   = 'klant-met-stilte';     // heeft open factuur + lopende LMS-afspraak
const NIETS_OPEN   = 'klant-niets-open';     // heeft intussen alles betaald

function nepAdmin() {
  const updates = [];
  return {
    updates,
    from(tabel) {
      const st = { tabel, filters: [] };
      const resultaat = () => {
        if (tabel === 'dunning_bulk_jobs') return { data: st.patch ? [] : [JOB], error: null };
        if (tabel === 'dunning_bulk_recipients') {
          if (st.patch) {
            const id = st.filters.find((f) => f[0] === 'eq' && f[1] === 'id')?.[2];
            // De atomische claim geeft de geclaimde rij terug.
            return { data: [{ id }], error: null };
          }
          if (st.head) return { data: null, count: 0, error: null };
          return { data: [ONTVANGER('r-stilte', MET_STILTE), ONTVANGER('r-open', NIETS_OPEN)], error: null };
        }
        if (tabel === 'customers') {
          const id = st.filters.find((f) => f[1] === 'id')?.[2];
          return { data: [{ id, first_name: 'Test', last_name: id, email: id + '@voorbeeld.nl', is_test: false }], error: null };
        }
        if (tabel === 'invoices') {
          const cid = st.filters.find((f) => f[1] === 'customer_id')?.[2];
          if (cid === NIETS_OPEN) return { data: [], error: null };
          return { data: [{ id: 'inv-1', invoice_number: 'F-1', amount_total: 100, amount_paid: 0,
            credited_amount: 0, due_date: '2026-08-01', status: 'overdue' }], error: null };
        }
        return { data: null, error: null };
      };
      const k = {
        select: (_c, opts) => { if (opts?.head) st.head = true; return k; },
        eq: (...a) => { st.filters.push(['eq', ...a]); return k; },
        in: (...a) => { st.filters.push(['in', ...a]); return k; },
        order: () => k, limit: () => k,
        update(v) { st.patch = v; updates.push({ tabel, patch: v, st }); return k; },
        insert: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: resultaat().data?.[0] || null, error: null }),
        then: (r, j) => Promise.resolve(resultaat()).then(r, j),
      };
      return k;
    },
  };
}

async function draai() {
  const admin = nepAdmin();
  const mails = [];
  const stilteVragen = [];
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: admin, checkCronAuth: () => ({ ok: true }) },
  });
  // De LMS zegt: voor MET_STILTE loopt er een afspraak. Vroeger hield dat de
  // bulk tegen; nu mag het geen verschil meer maken.
  mock.module(url('api/_lib/lms-stilte.js'), {
    namedExports: {
      BRON_ONBEREIKBAAR: 'onbereikbaar',
      haalStilteStand: async () => { stilteVragen.push('stand'); return { bron_status: 'ok', stiltes: new Map(), vangnet: new Set() }; },
      stilteStandSamenvatting: () => 'stilte-stand (test)',
      stilteBlokkade: (_stand, cid) => {
        stilteVragen.push(cid);
        return cid === MET_STILTE ? { reden: 'Afspraak in het LMS — stil tot en met 01-10-2026' } : null;
      },
    },
  });
  mock.module(url('api/_lib/send-email-core.js'), {
    namedExports: { sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true, messageId: 'm-' + mails.length }; } },
  });
  mock.module(url('api/_lib/dunning-dry-run.js'), {
    namedExports: { isDryRunEnabled: async () => false, assertRecipientMatchesSandbox: async () => {} },
  });
  mock.module(url('api/_lib/dunning-pipeline.js'), {
    namedExports: { ensurePipelineCustomer: async () => {}, setStage: async () => {}, isAutoEnabled: async () => false },
  });
  mock.module(url('api/_lib/notify.js'), {
    namedExports: { createNotification: async () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/meta-whatsapp.js'), {
    namedExports: { sendTemplate: async () => { throw new Error('WA hoort niet te lopen in deze test'); } },
  });
  mock.module(url('api/_lib/conv-upsert.js'), {
    namedExports: { upsertOutboundConversation: async () => ({ id: 'conv-1' }) },
  });

  const mod = await import(url('api/cron-dunning-bulk-send.js') + '?t=' + Math.random());
  const res = { code: null, body: null,
    setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default({ method: 'GET', headers: {} }, res);

  const eindstatus = (rid) => admin.updates
    .filter((u) => u.tabel === 'dunning_bulk_recipients'
      && u.st.filters.some((f) => f[1] === 'id' && f[2] === rid))
    .map((u) => u.patch.status).pop() ?? 'pending';
  return { res, mails, stilteVragen, eindstatus };
}

test('bulk: klant met een lopende LMS-stilte wordt nu WEL gemaand', async (t) => {
  t.after(() => mock.reset());
  const { res, mails, eindstatus } = await draai();
  assert.equal(res.code, 200);
  assert.equal(eindstatus('r-stilte'), 'sent',
    'de LMS-stilte houdt de bulk-ontvanger nog steeds tegen');
  assert.deepEqual(mails.map((m) => m.to), ['r-stilte@voorbeeld.nl']);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.lms_stilte, undefined, 'de lms_stilte-teller hoort niet meer in het bulk-rapport');
});

test('bulk: de LMS-stilte wordt niet meer bevraagd', async (t) => {
  t.after(() => mock.reset());
  const { stilteVragen } = await draai();
  assert.deepEqual(stilteVragen, [], 'de bulk-flow vraagt de LMS-stilte nog op');
});

test('bulk: de overige uitsluiting blijft — geen open bedrag = overgeslagen', async (t) => {
  t.after(() => mock.reset());
  const { res, mails, eindstatus } = await draai();
  assert.equal(eindstatus('r-open'), 'skipped');
  assert.ok(!mails.some((m) => m.to === 'r-open@voorbeeld.nl'), 'klant zonder open bedrag kreeg toch een mail');
  assert.equal(res.body.skipped, 1);
});
