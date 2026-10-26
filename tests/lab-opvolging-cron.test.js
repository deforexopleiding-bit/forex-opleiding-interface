// tests/lab-opvolging-cron.test.js
//
// De echte cron-lab-opvolging tegen een nep-CRM en nep-LMS:
//   - live-schakelaar uit → droogloop, er gaat niets weg en er wordt niets genoteerd;
//   - live aan → de nudge gaat uit, wordt genoteerd, en komt de volgende run niet terug;
//   - na een boeking (ook via de gewone agenda), afmelding of als klant gaat er niets meer;
//   - de belofte (product) komt in de tekst; WhatsApp zonder template = overgeslagen + gelogd.

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
mock.module(url('api/_lib/lab-video-duur.js'), { namedExports: { eersteVideoMinuten: async () => 6, minutenUitSeconden: () => null, EERSTE_LES: 'Market Structure' } });

const { default: cron } = await import(url('api/cron-lab-opvolging.js'));

const twee = new Date(Date.now() - 2 * 86400000).toISOString();
function opzet({ live, geboekt = false, agenda = false, video = 0, route = 'lab', ingelogd = false, product = 'minicursus', afgemeld = false, klant = false, tot = 5 } = {}) {
  crm = maakFakeDb({
    app_settings: live ? [{ key: 'lab_opvolging_live', value: 'true' }] : [],
    lab_aanmeldingen: [{ id: 'a1', aangemaakt: twee, lead_id: 'l1', email: 'lien@x.be', voornaam: 'Lien', telefoon_e164: '+32472223752', toestemming: true, lms_auth_id: 'auth-1', resultaat: 'nieuw_account', product }],
    lab_opvolging: [],
    follow_up_appointments: agenda ? [{ lead_email: 'lien@x.be', booking_source: 'the-lab' }] : [],
    onderhoud_sjablonen: [],
    lead_mail_voorkeuren: afgemeld ? [{ email: 'lien@x.be', afgemeld: true }] : [],
    leads: [{ id: 'l1', email: 'lien@x.be', status: klant ? 'gewonnen' : 'nieuw', customer_id: null }],
  }, { rpc: { upsert_lead: upsertLeadRpc } });
  lms = maakFakeDb({
    hlms_lab_lead: [{ id: 'll1', auth_id: 'auth-1', email: 'lien@x.be', voornaam: 'Lien', toegang_van: twee, toegang_tot: new Date(Date.now() + tot * 86400000).toISOString(), sessie_geboekt_op: geboekt ? twee : null, aangemaakt_op: twee, route, product, eerste_login_op: ingelogd ? twee : null }],
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
  assert.deepEqual(b.droog, [{ email: 'lien@x.be', stap: 'niet-ingelogd-48u', product: 'minicursus' }]);
  assert.equal(mails.length, 0);
  assert.equal(crm.tabellen.lab_opvolging.length, 0);
});

test('live aan: 48u niet ingelogd → één mail met de belofte + loginlink; WhatsApp zonder template overgeslagen en gelogd', async () => {
  opzet({ live: true });
  const b = await run();
  assert.equal(b.verstuurd.length, 1);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, 'Je toegang loopt maar 7 dagen');
  assert.match(mails[0].html, /\/the-lab\/start\/\?s=[^"]+"/);
  assert.doesNotMatch(mails[0].html, /naar=/);
  assert.deepEqual(crm.tabellen.lab_opvolging.map((o) => [o.stap, o.kanaal, o.status]).sort(), [['niet-ingelogd-48u', 'mail', 'verstuurd'], ['niet-ingelogd-48u', 'whatsapp', 'overgeslagen']]);
  await run();
  assert.equal(mails.length, 1, 'niet nog eens');
});

test('geboekt in het LMS of via de agenda, afgemeld of klant: niets meer', async () => {
  for (const o of [{ geboekt: true }, { agenda: true }, { afgemeld: true }, { klant: true }]) {
    opzet({ live: true, ...o });
    await run();
  }
  assert.equal(mails.length, 0);
});

test('warm: 2 video\'s gezien → uitnodiging strategiesessie, naar de boeking', async () => {
  opzet({ live: true, ingelogd: true, video: 2 });
  await run();
  assert.equal(mails[0].subject, 'Je bent er klaar voor: je strategiesessie');
  assert.match(mails[0].html, /naar=sessie/);
});

test('ingelogd, 1 video, Lab niet gestart, dag 2: nog niets', async () => {
  opzet({ live: false, ingelogd: true, video: 1 });
  const b = await run();
  assert.deepEqual(b.droog, []);
});

test('dag 5: de belofte van de 7-daagse staat in de tekst', async () => {
  opzet({ live: true, ingelogd: true, product: '7-daagse', tot: 1.5 });
  await run();
  assert.equal(mails[0].subject, 'Je toegang verloopt binnenkort');
  assert.match(mails[0].html, /je 7 dagen meekijken/);
});
