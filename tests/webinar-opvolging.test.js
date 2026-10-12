// tests/webinar-opvolging.test.js
//
// Webinar fase 3 (2026-10-12): na-webinar opvolging voor aanmelders zonder call.
//   1. vensters: nudge 1 = einde+10 min t/m 21:30 NL, nudge 2 = dag erna 10–20 NL (DST-correct);
//   2. besluit: geboekt (webinar, ná aanmelding, e-mail/telefoon/lead_id, niet
//      cancelled/verwijderd) of een andere AANKOMENDE afspraak → overslaan;
//   3. mail: canonieke scan-tekst (€99, rapport, certificaat), knop, urgentie,
//      afmeldlink + List-Unsubscribe, voornaam ge-escaped; afgemeld → geen mail;
//   4. ronde tegen een nep-DB: wie wel/niet, nooit dubbel, nudge 2 slaat over na
//      een boeking tussendoor, buiten het venster niets, zonder migratie niets;
//   5. WhatsApp-tekst = exact de goedgekeurde template; bedrading cron/view/SQL.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const verzonden = { mails: [], wa: [] };
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: null } });
mock.module(url('api/_lib/meta-whatsapp.js'), {
  namedExports: {
    sendTemplate: async (a) => { verzonden.wa.push(a); return { wamid: 'wamid-' + verzonden.wa.length }; },
    templateStatusOpLijn: async () => 'APPROVED',
  },
});
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { verzonden.mails.push(m); return { ok: true }; } } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const O = await import(url('api/_lib/webinar-opvolging.js'));
const T = await import(url('api/_lib/webinar-templates.js'));
const reset = () => { verzonden.mails.length = 0; verzonden.wa.length = 0; };

// Ma 19 okt 2026 19:00–20:00 NL (zomertijd, UTC+2) en ma 2 nov (wintertijd, UTC+1).
const OKT = { id: 'sessie-okt', reeks_id: 'reeks-1', status: 'gepland', starts_at: '2026-10-19T17:00:00.000Z', ends_at: '2026-10-19T18:00:00.000Z' };
const NOV = { id: 'sessie-nov', reeks_id: 'reeks-1', status: 'gepland', starts_at: '2026-11-02T18:00:00.000Z', ends_at: '2026-11-02T19:00:00.000Z' };

// ── 1. Vensters ──────────────────────────────────────────────────────────────
test('vensters: nudge 1 einde+10 min t/m 21:30 NL, nudge 2 de dag erna 10:00–20:00 NL (zomer én winter)', () => {
  const v1 = O.opvolgVenster('opvolging_1', OKT);
  assert.equal(v1.van.toISOString(), '2026-10-19T18:10:00.000Z');
  assert.equal(v1.tot.toISOString(), '2026-10-19T19:30:00.000Z', '21:30 NL zomertijd');
  const v2 = O.opvolgVenster('opvolging_2', OKT);
  assert.equal(v2.van.toISOString(), '2026-10-20T08:00:00.000Z');
  assert.equal(v2.tot.toISOString(), '2026-10-20T18:00:00.000Z');
  assert.equal(O.opvolgVenster('opvolging_1', NOV).tot.toISOString(), '2026-11-02T20:30:00.000Z', '21:30 NL wintertijd');
  assert.equal(O.opvolgVenster('opvolging_2', NOV).van.toISOString(), '2026-11-03T09:00:00.000Z');
  const op = (iso) => [O.inVenster('opvolging_1', OKT, new Date(iso)), O.inVenster('opvolging_2', OKT, new Date(iso))];
  assert.deepEqual(op('2026-10-19T17:30:00Z'), [false, false], 'tijdens het webinar niets');
  assert.deepEqual(op('2026-10-19T18:15:00Z'), [true, false], '20:15 NL: nudge 1');
  assert.deepEqual(op('2026-10-19T19:30:00Z'), [false, false], '21:30 NL: gesloten (gemist = vervalt)');
  assert.deepEqual(op('2026-10-19T23:00:00Z'), [false, false], "'s nachts niets");
  assert.deepEqual(op('2026-10-20T07:59:00Z'), [false, false], '09:59 NL nog niet');
  assert.deepEqual(op('2026-10-20T08:00:00Z'), [false, true], '10:00 NL: nudge 2');
  assert.deepEqual(op('2026-10-20T18:00:00Z'), [false, false], '20:00 NL: gesloten');
});

// ── 2. Besluit ───────────────────────────────────────────────────────────────
const AANM = { id: 'a1', email: 'Pieter@Example.com', telefoon: '+31612345678', lead_id: 'lead-1', aangemeld_op: '2026-10-15T10:00:00Z', voornaam: 'Pieter' };
const NU = new Date('2026-10-19T18:15:00Z');
const afspraak = (o) => ({ id: 'ap-' + Math.random(), booking_source: 'webinar', status: 'scheduled', created_at: '2026-10-19T17:40:00Z', scheduled_at: '2026-10-22T09:00:00Z', lead_email: null, lead_phone: null, ...o });

test('besluit: geboekt via webinar (e-mail / telefoon / lead_id), alleen ná de aanmelding en niet geannuleerd', () => {
  const b = (afspraken, submissions = []) => O.opvolgBesluit(AANM, { afspraken, aankomend: [], submissions }, NU);
  assert.deepEqual(b([]), { sturen: true, reden: null });
  assert.equal(b([afspraak({ lead_email: ' pieter@example.COM ' })]).reden, 'geboekt', 'e-mail, hoofdletterongevoelig');
  assert.equal(b([afspraak({ lead_phone: '0612 34 56 78' })]).reden, 'geboekt', 'telefoon: laatste 9 cijfers');
  const viaLead = afspraak({ id: 'ap-lead', lead_email: 'ander@example.com' });
  assert.equal(b([viaLead], [{ lead_id: 'lead-1', appointment_id: 'ap-lead', booking_source: 'webinar' }]).reden, 'geboekt', 'lead_id via submissie');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', created_at: '2026-10-10T09:00:00Z' })]).sturen, true, 'vóór de aanmelding telt niet');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', status: 'cancelled' })]).sturen, true, 'geboekt en geannuleerd → wél nudge');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', status: 'verwijderd' })]).sturen, true);
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', status: 'completed' })]).reden, 'geboekt', 'call gehad telt als geboekt');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', booking_source: 'romy' })]).sturen, true, 'andere bron is geen webinar-boeking');
  assert.equal(b([afspraak({ lead_email: 'iemand@anders.nl', lead_phone: '+31699999999' })]).sturen, true, 'iemand anders');
});

test('besluit: een andere AANKOMENDE afspraak (welke bron ook) → overslaan; afgelopen of geannuleerd telt niet', () => {
  const b = (aankomend) => O.opvolgBesluit(AANM, { afspraken: [], aankomend, submissions: [] }, NU);
  assert.equal(b([afspraak({ booking_source: 'romy', lead_email: 'pieter@example.com', created_at: '2026-10-01T09:00:00Z' })]).reden, 'aankomende_afspraak');
  assert.equal(b([afspraak({ booking_source: null, lead_phone: '+31 6 1234 5678', status: 'wacht_op_reschedule' })]).reden, 'aankomende_afspraak');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', scheduled_at: '2026-10-18T09:00:00Z' })]).sturen, true, 'in het verleden');
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', status: 'cancelled' })]).sturen, true);
  assert.equal(b([afspraak({ lead_email: 'pieter@example.com', status: 'verplaatst' })]).sturen, true, 'oude rij van een verzette afspraak');
  assert.equal(O.opvolgBesluit({ ...AANM, is_test: true }, { afspraken: [], aankomend: [], submissions: [] }, NU).reden, 'test');
});

// ── 3. Mail ──────────────────────────────────────────────────────────────────
test('mail: onderwerpen, canonieke scan-tekst (€99, rapport, certificaat), knop, urgentie, afmeldlink, escaping', () => {
  const m1 = O.bouwOpvolgMail('opvolging_1', { voornaam: 'Pieter', voorkeurenLink: 'https://www.deforexopleiding.nl/voorkeuren?token=T' });
  assert.equal(m1.subject, 'Jouw gratis strategie-scan staat klaar');
  assert.match(m1.html, /Hoi Pieter, bedankt voor je aanmelding voor onze webinar\./);
  assert.match(m1.html, /gratis strategie-scan \(t\.w\.v\. €99\)/);
  assert.match(m1.html, /In 15-20 minuten ontdek je samen met ons precies waar je staat, welke stappen je kunt zetten en wat jouw mogelijkheden zijn\. Je ontvangt daarna een persoonlijk, uitgebreid rapport én een certificaat van De Forex Opleiding\./);
  assert.match(m1.html, /<a href="https:\/\/deforexopleiding\.nl\/agenda\/webinar"[^>]*>Plan je gratis scan<\/a>/);
  assert.match(m1.html, /Er zijn maar 3 gratis scan-plekken per webinar/);
  assert.match(m1.html, /voorkeuren\?token=T[^>]*>Voorkeuren aanpassen of afmelden/);
  assert.match(m1.text, /Plan je gratis scan: https:\/\/deforexopleiding\.nl\/agenda\/webinar/);
  assert.doesNotMatch(m1.html, /90 dagen/, 'oude framing niet in de mail');
  const m2 = O.bouwOpvolgMail('opvolging_2', { voornaam: '<b>x</b>' });
  assert.equal(m2.subject, 'Laatste kans: je gratis scan-plek');
  assert.match(m2.html, /de gratis scan-plekken van deze week zijn bijna vol/);
  assert.match(m2.html, /Plan dan vandaag nog je gratis strategie-scan in\./);
  assert.match(m2.html, /Hoi &lt;b&gt;x&lt;\/b&gt;/, 'voornaam ge-escaped');
  assert.equal(O.SCAN_OMSCHRIJVING, 'Gratis strategie-scan (t.w.v. €99). In 15-20 minuten ontdek je samen met ons precies waar je staat, welke stappen je kunt zetten en wat jouw mogelijkheden zijn. Je ontvangt daarna een persoonlijk, uitgebreid rapport én een certificaat van De Forex Opleiding.');
});

// ── 4. Ronde tegen een nep-DB ────────────────────────────────────────────────
function nepDb({ metKolommen = true } = {}) {
  const tab = { webinar_sessies: [], webinar_aanmeldingen: [], follow_up_appointments: [], opstartsessie_submissions: [], lead_mail_voorkeuren: [], whatsapp_module_config: [{ module: 'events', is_active: true, phone_number_id: '1273723375834177' }] };
  const waarde = (r, c) => r[c];
  function bouwer(t) {
    const f = []; let op = 'select'; let data = null; let lim = null;
    const k = {
      select: () => k,
      eq: (c, v) => { f.push((r) => waarde(r, c) === v); return k; },
      is: (c, v) => { f.push((r) => (waarde(r, c) ?? null) === v); return k; },
      gt: (c, v) => { f.push((r) => String(waarde(r, c)) > v); return k; },
      gte: (c, v) => { f.push((r) => String(waarde(r, c)) >= v); return k; },
      lte: (c, v) => { f.push((r) => String(waarde(r, c)) <= v); return k; },
      in: (c, v) => { f.push((r) => v.includes(waarde(r, c))); return k; },
      not: (c, o, v) => { f.push((r) => !(o === 'is' && (waarde(r, c) ?? null) === v)); return k; },
      limit: (n) => { lim = n; return k; },
      update: (p) => { op = 'update'; data = p; return k; },
      insert: (r) => { op = 'insert'; data = r; return k; },
      maybeSingle: () => k.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })),
      single: () => k.then((r) => ({ data: (r.data || [])[0] || null, error: r.error })),
      then(ok, nok) {
        const rijen = tab[t];
        let res;
        if (op === 'insert') { const n = { id: 'n-' + rijen.length, afgemeld: false, voorkeuren: {}, ...data }; rijen.push(n); res = { data: [{ ...n }], error: null }; }
        else {
          let m = rijen.filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') { for (const r of m) Object.assign(r, data); m = m.map((r) => ({ ...r })); }
          else m = m.map((r) => ({ ...r }));
          if (lim != null) m = m.slice(0, lim);
          res = { data: m, error: null };
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  }
  const db = { tab, from: (t) => bouwer(t) };
  db.aanmelder = (o) => {
    const r = { id: o.id, sessie_id: 'sessie-okt', voornaam: o.voornaam, email: o.email, telefoon: o.telefoon || null, lead_id: o.lead_id || null, is_test: false, aangemeld_op: '2026-10-15T10:00:00Z', berichten: {}, ...(metKolommen ? { opvolging_1_op: null, opvolging_2_op: null } : {}) };
    tab.webinar_aanmeldingen.push(r); return r;
  };
  tab.webinar_sessies.push({ ...OKT });
  return db;
}
const ronde = (db, iso) => { const uit = {}; const fouten = []; return O.opvolgRonde(db, { id: 'reeks-1' }, { nu: new Date(iso), wachtMs: 0, fout: (c, e) => fouten.push(c + ': ' + (e?.message || e)), uit }).then(() => ({ uit, fouten })); };

test('ronde: alleen echt openstaande aanmelders krijgen nudge 1 (mail + WhatsApp), nooit dubbel', async () => {
  reset();
  const db = nepDb();
  db.aanmelder({ id: 'open', voornaam: 'Open', email: 'open@example.com', telefoon: '+31611111111' });
  db.aanmelder({ id: 'geboekt', voornaam: 'Geboekt', email: 'geboekt@example.com', telefoon: '+31622222222' });
  db.aanmelder({ id: 'romy', voornaam: 'Romy-lead', email: 'romy@example.com', telefoon: '+31633333333' });
  db.aanmelder({ id: 'annuleerde', voornaam: 'Annuleerde', email: 'ann@example.com' });
  db.tab.follow_up_appointments.push(
    { id: 'ap1', booking_source: 'webinar', status: 'scheduled', lead_email: 'GEBOEKT@example.com', created_at: '2026-10-19T17:50:00Z', scheduled_at: '2026-10-21T08:00:00Z' },
    { id: 'ap2', booking_source: 'romy', status: 'scheduled', lead_phone: '0633333333', created_at: '2026-10-01T08:00:00Z', scheduled_at: '2026-10-22T08:00:00Z' },
    { id: 'ap3', booking_source: 'webinar', status: 'cancelled', lead_email: 'ann@example.com', created_at: '2026-10-19T17:55:00Z', scheduled_at: '2026-10-21T08:00:00Z' },
  );
  const { uit, fouten } = await ronde(db, '2026-10-19T18:15:00Z');
  assert.deepEqual(fouten, []);
  assert.equal(uit.opvolging_1, 2, 'open + annuleerde');
  assert.equal(uit.opvolging_overgeslagen, 2, 'geboekt + aankomende Romy-afspraak');
  assert.deepEqual(verzonden.mails.map((m) => m.to).sort(), ['ann@example.com', 'open@example.com']);
  assert.equal(verzonden.mails[0].subject, 'Jouw gratis strategie-scan staat klaar');
  assert.ok(verzonden.mails.every((m) => m.headers && /^<https:\/\/www\.deforexopleiding\.nl\/api\/voorkeuren\?token=/.test(m.headers['List-Unsubscribe'])), 'List-Unsubscribe');
  assert.deepEqual(verzonden.wa.map((w) => [w.to, w.templateName, w.variables]), [['31611111111', 'webinar_opvolging_1', ['Open']]], 'WhatsApp alleen met telefoon');
  const rij = (id) => db.tab.webinar_aanmeldingen.find((a) => a.id === id);
  assert.equal(rij('geboekt').berichten.opvolging_1.overgeslagen, 'geboekt');
  assert.equal(rij('romy').berichten.opvolging_1.overgeslagen, 'aankomende_afspraak');
  assert.ok(rij('open').opvolging_1_op && rij('open').berichten.opvolging_1.mail.ok);
  // Volgende minuut: niets dubbel.
  reset();
  const tweede = await ronde(db, '2026-10-19T18:16:00Z');
  assert.equal(verzonden.mails.length + verzonden.wa.length, 0);
  assert.equal(tweede.uit.opvolging_1 || 0, 0);
});

test('ronde: nudge 2 de dag erna — overgeslagen voor wie tussendoor boekte; buiten de vensters niets', async () => {
  reset();
  const db = nepDb();
  const a = db.aanmelder({ id: 'boekte-later', voornaam: 'Later', email: 'later@example.com', telefoon: '+31644444444' });
  db.aanmelder({ id: 'nog-open', voornaam: 'Nog', email: 'nog@example.com', telefoon: '+31655555555' });
  await ronde(db, '2026-10-19T18:20:00Z');
  assert.equal(verzonden.mails.length, 2, 'beiden nudge 1');
  // 22:00 NL en 's nachts: niets.
  reset();
  await ronde(db, '2026-10-19T20:00:00Z');
  await ronde(db, '2026-10-20T03:00:00Z');
  assert.equal(verzonden.mails.length + verzonden.wa.length, 0);
  // 's Ochtends boekt "Later" alsnog via de QR.
  db.tab.follow_up_appointments.push({ id: 'ap9', booking_source: 'webinar', status: 'scheduled', lead_email: 'later@example.com', created_at: '2026-10-20T07:30:00Z', scheduled_at: '2026-10-23T08:00:00Z' });
  reset();
  const { uit } = await ronde(db, '2026-10-20T08:05:00Z');
  assert.equal(uit.opvolging_2, 1);
  assert.equal(uit.opvolging_overgeslagen, 1);
  assert.deepEqual(verzonden.mails.map((m) => [m.to, m.subject]), [['nog@example.com', 'Laatste kans: je gratis scan-plek']]);
  assert.deepEqual(verzonden.wa.map((w) => w.templateName), ['webinar_opvolging_2']);
  assert.equal(a.berichten.opvolging_2.overgeslagen, 'geboekt');
});

test('ronde: afgemeld voor mail → geen mail (WhatsApp wel); overgeslagen sessie en testaanmelding → niets', async () => {
  reset();
  const db = nepDb();
  db.aanmelder({ id: 'afgemeld', voornaam: 'Af', email: 'af@example.com', telefoon: '+31666666666' });
  db.tab.lead_mail_voorkeuren.push({ id: 'v1', email: 'af@example.com', token: 'TOK', afgemeld: true, voorkeuren: {} });
  db.aanmelder({ id: 'test', voornaam: 'Test', email: 'test@example.com' }).is_test = true;
  await ronde(db, '2026-10-19T18:15:00Z');
  assert.equal(verzonden.mails.length, 0);
  assert.equal(verzonden.wa.length, 1);
  assert.equal(db.tab.webinar_aanmeldingen.find((x) => x.id === 'afgemeld').berichten.opvolging_1.mail.overgeslagen, 'afgemeld');
  // Overgeslagen sessie: geen nudges.
  reset();
  const db2 = nepDb();
  db2.tab.webinar_sessies[0].status = 'overgeslagen';
  db2.aanmelder({ id: 'x', voornaam: 'X', email: 'x@example.com' });
  await ronde(db2, '2026-10-19T18:15:00Z');
  assert.equal(verzonden.mails.length, 0);
});

test('ronde zonder migratie (kolommen ontbreken): niets verstuurd, melding, geen fout', async () => {
  reset();
  const db = nepDb({ metKolommen: false });
  db.aanmelder({ id: 'open', voornaam: 'Open', email: 'open@example.com' });
  const warns = []; const ow = console.warn; console.warn = (...a) => warns.push(a.join(' '));
  try {
    const { uit, fouten } = await ronde(db, '2026-10-19T18:15:00Z');
    assert.deepEqual(fouten, []);
    assert.equal(uit.opvolging_migratie_ontbreekt, true);
  } finally { console.warn = ow; }
  assert.equal(verzonden.mails.length, 0);
  assert.ok(warns.some((w) => w.includes('2026-10-12-webinar-opvolging.sql')));
});

// ── 5. Templates + bedrading ─────────────────────────────────────────────────
test('WhatsApp: tekst = exact de goedgekeurde templates; {{1}} = voornaam; URL-knop', () => {
  assert.equal(T.renderTemplateTekst('webinar_opvolging_1', { voornaam: 'Jeffrey' }),
    "Hoi Jeffrey! 👋\n\nJe had je aangemeld voor onze webinar. De volgende stap is je gratis strategie-scan: een persoonlijk plan om binnen 90 dagen je eerste winsten te maken met traden.\n\nEr zijn maar een paar scan-plekken. Plan 'm hieronder in 👇");
  assert.equal(T.renderTemplateTekst('webinar_opvolging_2', { voornaam: 'Jeffrey' }),
    'Hoi Jeffrey, laatste kans ⏳\n\nDe gratis scan-plekken van deze week zijn bijna vol. Wil je jouw persoonlijke 90-dagen-plan? Plan dan nu je gratis strategie-scan in 👇');
  assert.deepEqual(T.templateVariabelen('webinar_opvolging_2', { voornaam: 'Jeffrey' }), ['Jeffrey']);
  assert.deepEqual(Object.keys(T.WEBINAR_TEMPLATES), ['webinar_bevestiging', 'webinar_reminder_dag', 'webinar_reminder_uur', 'webinar_live'], 'de vier UTILITY-templates ongewijzigd');
  assert.equal(T.OPVOLG_TEMPLATES.webinar_opvolging_1.buttons[0].url, 'https://deforexopleiding.nl/agenda/webinar');
});

test('bedrading: cronRonde roept opvolgRonde aan; view toont Nudge 1/2 + €99 op de QR; SQL los en herhaalbaar', () => {
  const w = lees('api/_lib/webinar.js');
  assert.match(w, /import \{ opvolgRonde \} from '\.\/webinar-opvolging\.js';/);
  assert.match(w, /await opvolgRonde\(sb, reeks, \{ nu, wachtMs, tijdOp, fout, uit \}\)/);
  assert.match(lees('api/cron-webinar.js'), /uit\.opvolging_1 \|\| uit\.opvolging_2 \|\| uit\.opvolging_overgeslagen/);
  const v = lees('modules/klanten-v2/views/webinar-v2.js');
  assert.match(v, /<th[^>]*>Nudge 1<\/th><th[^>]*>Nudge 2<\/th>/);
  assert.match(v, /vinkje\(a, 'opvolging_1'\)/);
  assert.match(v, /Plan je gratis strategie-scan \(t\.w\.v\. €99\)/);
  assert.ok(Number(lees('modules/klanten-v2/index.html').match(/views\/webinar-v2\.js\?v=(\d+)"/)[1]) >= 4);
  assert.match(lees('api/webinar-admin.js'), /from\('webinar_aanmeldingen'\)\s*\n\s*\.select\('\*'\)/);
  const sql = lees('docs/sql-migrations/2026-10-12-webinar-opvolging.sql');
  assert.match(sql, /ALTER TABLE public\.webinar_aanmeldingen ADD COLUMN IF NOT EXISTS opvolging_1_op timestamptz;/);
  assert.match(sql, /ALTER TABLE public\.webinar_aanmeldingen ADD COLUMN IF NOT EXISTS opvolging_2_op timestamptz;/);
  assert.doesNotMatch(sql, /DO \$\$|TEMP TABLE|DROP /i);
});
