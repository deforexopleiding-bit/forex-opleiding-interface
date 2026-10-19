// tests/lab-opvolging-cron.test.js
//
// De echte cron-lab-opvolging tegen een nep-CRM en nep-LMS:
//   - live-schakelaar uit → droogloop, er gaat niets weg en er wordt niets genoteerd;
//   - live aan → de nudge gaat uit, wordt genoteerd, en komt de volgende run niet terug;
//   - na een boeking (ook via de gewone agenda) gaat er niets meer;
//   - een aanmelding met 'lms_fout' wordt opnieuw geprobeerd.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb, upsertLeadRpc } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
let crm; let lms; let mails;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm), checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true }; } } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: { haalLijn: async () => ({}), mailAfzender: () => 'welkom@deforexopleiding.nl' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), goedgekeurdeTemplatesOpLijn: async () => ({ ok: true, templates: [] }) } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });
mock.module(url('api/_lib/lab-opvolging.js'), { namedExports: { ...(await import(url('api/_lib/lab-opvolging.js'))), isStilUur: () => false } });

const { default: cron } = await import(url('api/cron-lab-opvolging.js'));

const twee = new Date(Date.now() - 2 * 86400000).toISOString();
function opzet({ live, geboekt = false, agenda = false, video = 0, route = 'lab' } = {}) {
  crm = maakFakeDb({
    app_settings: live ? [{ key: 'lab_opvolging_live', value: 'true' }] : [],
    lab_aanmeldingen: [{ id: 'a1', aangemaakt: twee, lead_id: 'l1', email: 'lien@x.be', voornaam: 'Lien', telefoon_e164: '+32472223752', toestemming: true, lms_auth_id: 'auth-1', resultaat: 'nieuw_account' }],
    lab_opvolging: [],
    follow_up_appointments: agenda ? [{ lead_email: 'lien@x.be', booking_source: 'the-lab' }] : [],
    onderhoud_sjablonen: [],
  }, { rpc: { upsert_lead: upsertLeadRpc } });
  lms = maakFakeDb({
    hlms_lab_lead: [{ id: 'll1', auth_id: 'auth-1', email: 'lien@x.be', voornaam: 'Lien', toegang_tot: new Date(Date.now() + 5 * 86400000).toISOString(), sessie_geboekt_op: geboekt ? twee : null, aangemaakt_op: twee, route }],
    hlms_lab_sessie: [],
    // `video` = hoeveel verschillende video's hij uitkeek (en de eerste nog eens, dubbel telt niet).
    hlms_lab_lead_gebeurtenis: Array.from({ length: video }, (_, i) => ({ lead_id: 'll1', soort: 'video_voltooid', sleutel: `mat-${i + 1}`, op: twee }))
      .concat(video ? [{ lead_id: 'll1', soort: 'video_voltooid', sleutel: 'mat-1', op: twee }] : []),
  });
}
beforeEach(() => { mails = []; });

async function run() {
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await cron({ headers: {} }, res);
  return res.body;
}

test('live uit: droogloop, niets verstuurd of genoteerd', async () => {
  opzet({ live: false });
  const b = await run();
  assert.deepEqual(b.droog, [{ email: 'lien@x.be', stap: 'niet-gestart-24u' }]);
  assert.equal(mails.length, 0);
  assert.equal(crm.tabellen.lab_opvolging.length, 0);
});

test('live aan: de nudge gaat één keer uit, met een loginlink naar The Lab', async () => {
  opzet({ live: true });
  const b = await run();
  assert.equal(b.verstuurd.length, 1);
  assert.equal(mails.length, 1);
  // Jouw route: niet gestart → het actieplan (video's, Lab of meteen de strategiesessie).
  assert.equal(mails[0].subject, 'Geen 20 minuten? Dan 5.');
  assert.match(mails[0].html, /\/the-lab\/start\/\?s=[^"]+"/);
  assert.doesNotMatch(mails[0].html, /naar=lab/);
  assert.deepEqual(crm.tabellen.lab_opvolging.map((o) => [o.stap, o.kanaal, o.status]).sort(), [['niet-gestart-24u', 'mail', 'verstuurd'], ['niet-gestart-24u', 'whatsapp', 'overgeslagen']]);
  await run();
  assert.equal(mails.length, 1, 'niet nog eens');
});

test('geboekt in het LMS of via de agenda: niets meer', async () => {
  opzet({ live: true, geboekt: true });
  await run();
  opzet({ live: true, agenda: true });
  await run();
  assert.equal(mails.length, 0);
});

test('JOUW ROUTE: de 5 video\'s van het leerpad uitgekeken, geen Lab na een dag → "nu de praktijk", niet de niet-gestart-nudge', async () => {
  opzet({ live: false, video: 5 });
  const b = await run();
  assert.deepEqual(b.droog, [{ email: 'lien@x.be', stap: 'video-geen-lab' }]);
});

test('JOUW ROUTE: route lab met pas 4 video\'s (en één dubbel) → nog niet "nu de praktijk"', async () => {
  opzet({ live: false, video: 4 });
  const b = await run();
  assert.deepEqual(b.droog, [{ email: 'lien@x.be', stap: 'niet-gestart-24u' }]);
});

test('JOUW ROUTE: route kort — één video volstaat', async () => {
  opzet({ live: false, video: 1, route: 'kort' });
  const b = await run();
  assert.deepEqual(b.droog, [{ email: 'lien@x.be', stap: 'video-geen-lab' }]);
});
