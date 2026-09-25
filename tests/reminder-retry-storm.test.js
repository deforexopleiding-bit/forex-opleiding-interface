// tests/reminder-retry-storm.test.js
//
// RETRY-STORM BIJ EEN ONBEZORGBAAR ADRES.
//
// GEMETEN 24 september: afspraak 20630959-… met `denzelcasier6@gmail.col`.
// SMTP antwoordde elke keer `521 5.1.2 Domain does not exist: gmail.col`.
// De bevestiging gaf de mail-claim bij iedere fout weer vrij, dus de cron
// (elke 3 min) probeerde het opnieuw: 1.324 faillog-rijen in drie dagen. Het
// alarm mailde per nieuwe faillog-rij: 95 alarmmails per dag.
//
// Drie lagen in de fix:
//   1. permanent vs tijdelijk — een 5.1.x stopt direct, een eigen-kant-fout
//      (535 auth, 5.7.x policy) juist NIET, anders legt één configfout alle
//      mail plat;
//   2. cap + backoff voor tijdelijke fouten;
//   3. alarm per poging → één dagelijkse samenvatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifySendError, detectEmailTypo, backoffMinNaPoging, MAX_ATTEMPTS, BACKOFF_MIN,
} from '../api/_lib/send-error-classify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');
const bron = (p) => zonderUitleg(readFileSync(join(ROOT, p), 'utf8'));

// ═══════════════════════════════════════════════════════════════════════════
// 1 · PERMANENT VS TIJDELIJK
// ═══════════════════════════════════════════════════════════════════════════

test('de letterlijke bounce uit productie is permanent', () => {
  const r = classifySendError({ kanaal: 'mail', code: 'SMTP_SEND_FAIL',
    reason: "Can't send mail - all recipients were rejected: 521 5.1.2 Domain does not exist: gmail.col" });
  assert.equal(r.soort, 'permanent');
});

for (const reason of [
  '550 5.1.1 <x@example.com>: Recipient address rejected: User unknown in virtual mailbox table',
  '550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup',
  '550 Mailbox unavailable',
  '552 5.2.1 The email account that you tried to reach is disabled',
]) {
  test(`ontvanger-fout is permanent: ${reason.slice(0, 40)}…`, () => {
    assert.equal(classifySendError({ kanaal: 'mail', reason }).soort, 'permanent');
  });
}

for (const [label, reason, code] of [
  ['535 auth (onze creds)', 'Invalid login: 535 5.7.8 Authentication failed', 'SMTP_SEND_FAIL'],
  ['5.7.1 relay/policy', '550 5.7.1 Relaying denied', 'SMTP_SEND_FAIL'],
  ['4xx greylisting', '451 4.7.1 Greylisted, please try again later', 'SMTP_SEND_FAIL'],
  ['timeout', 'Connection timeout', 'SMTP_SEND_FAIL'],
  ['SMTP niet geconfigureerd', 'SMTP-wachtwoord voor welkom niet geconfigureerd (X)', 'SMTP_NOT_CONFIGURED'],
]) {
  test(`eigen-kant of tijdelijke fout markeert het adres NIET: ${label}`, () => {
    assert.equal(classifySendError({ kanaal: 'mail', reason, code }).soort, 'tijdelijk');
  });
}

test('WhatsApp-fouten zijn altijd tijdelijk (geen telefoon-marker; alleen cap)', () => {
  assert.equal(classifySendError({ kanaal: 'whatsapp', reason: '(#131026) Message undeliverable' }).soort, 'tijdelijk');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · CAP + BACKOFF
// ═══════════════════════════════════════════════════════════════════════════

test('cap is 7 pogingen, backoff 3→6→12→24→48→96(→192)', () => {
  assert.equal(MAX_ATTEMPTS, 7);
  assert.deepEqual(BACKOFF_MIN, [3, 6, 12, 24, 48, 96, 192]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoffMinNaPoging), [3, 6, 12, 24, 48, 96]);
  assert.equal(backoffMinNaPoging(99), 192, 'plafond');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · TYPEFOUTEN BIJ IMPORT
// ═══════════════════════════════════════════════════════════════════════════

for (const [in_, uit] of [
  ['denzelcasier6@gmail.col', 'denzelcasier6@gmail.com'],
  ['a@hotmal.com', 'a@hotmail.com'],
  ['a@gmial.com', 'a@gmail.com'],
  ['a@outlook.comm', 'a@outlook.com'],
  ['a@gmail.co', 'a@gmail.com'],
  ['a@bedrijf.con', 'a@bedrijf.com'],
  ['a@hotmial.nl', 'a@hotmail.nl'],
]) {
  test(`typefout herkend: ${in_} → ${uit}`, () => {
    const t = detectEmailTypo(in_);
    assert.ok(t, 'geen typefout gedetecteerd');
    assert.equal(t.suggestie, uit);
    assert.match(t.reden, /^typefout-domein: /);
  });
}

for (const ok of ['a@gmail.com', 'a@hotmail.nl', 'a@bedrijf.co', 'a@site.cm', 'a@deforexopleiding.nl', 'a@sub.domein.be', '', null, 'geen-at']) {
  test(`geen vals alarm op geldig/leeg adres: ${ok}`, () => {
    assert.equal(detectEmailTypo(ok), null);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · STRUCTUUR: GEEN EINDELOZE LUS, GEEN PER-POGING-ALARM
// ═══════════════════════════════════════════════════════════════════════════

const CRON  = bron('api/cron-afspraak-reminders.js');
const ALARM = bron('api/cron-reminder-alarm.js');

test('bevestiging-kandidaten sluiten opgegeven afspraken uit', () => {
  assert.match(CRON, /\.is\('bevestiging_sent_at', null\)\s*\n\s*\.is\('bevestiging_gaveup_at', null\)/);
});

test('mislukte bevestiging boekt de poging (teller + backoff) i.p.v. kaal vrijgeven', () => {
  const blok = CRON.slice(CRON.indexOf('async function verwerkBevestiging'), CRON.indexOf('async function backfillZoom'));
  assert.ok(blok.includes("boekMislukking(appt, 'mail', nowMs)"));
  assert.ok(blok.includes("boekMislukking(appt, 'wa', nowMs)"));
  assert.ok(!/unclaimRow\(appt\.id, 'bevestiging_(mail|wa)_sent_at'\)/.test(blok), 'kaal vrijgeven = oude lus');
});

test('onbezorgbaar adres → geen mail voor reminders én bevestiging', () => {
  assert.equal((CRON.match(/skipped: 'email-onbezorgbaar'/g) || []).length, 2);
});

test('het alarm leest de faillog niet meer (dat doet de dagelijkse digest)', () => {
  assert.ok(!ALARM.includes('afspraak_bericht_faillog'));
  assert.ok(!/newFails/.test(ALARM));
});

test('dagelijkse digest staat als Vercel-cron ingepland', () => {
  const vj = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const c = (vj.crons || []).find((x) => x.path === '/api/cron-reminder-alarm-digest');
  assert.ok(c, 'cron ontbreekt');
  assert.equal(c.schedule, '0 6 * * *');
});
