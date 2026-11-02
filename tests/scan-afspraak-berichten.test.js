// tests/scan-afspraak-berichten.test.js
//
// DE BEVESTIGING EN HERINNERINGEN VAN DE STRATEGIE-SCAN (webinar + strategiescan).
//   - booking_source 'webinar' en 'strategiescan' krijgen de scan-variant:
//     "strategie-scan", 20 minuten via Zoom met ons team, wat we bekijken,
//     actieplan — nooit "kennismakingsgesprek", nooit Dave of Heylen;
//   - elke bevestigingsmail (alle bronnen) draagt een .ics met de juiste titel,
//     De Forex Opleiding als naam en GEEN ORGANIZER;
//   - WhatsApp blijft de goedgekeurde templates gebruiken (geen nieuwe namen);
//   - andere bronnen blijven inhoudelijk ongewijzigd;
//   - het webinar-scherm zegt "met ons team", niet "bij Dave".

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: {} } });

const B = await import(url('api/_lib/afspraak-berichten.js'));

const START = '2026-11-04T18:00:00.000Z'; // woensdag 19:00 in Brussel
const basis = { id: 'appt-9', lead_name: 'Jonas Peeters', scheduled_at: START, zoom_join_url: 'https://zoom.us/j/999', afspraak_token: 'tok9' };
const WEBINAR = { ...basis, booking_source: 'webinar' };
const SCAN = { ...basis, booking_source: 'strategiescan' };
const GEWOON = { ...basis, booking_source: 'opstartsessie' };
const LAB = { ...basis, booking_source: 'the-lab', gastheer_voornaam: 'Dave' };
const KEYS = ['bevestiging', 'r24', 'r2', 'r30', 'zoom5'];
const mom = (k) => B.MOMENTEN.find((m) => m.key === k);
const ontvouw = (ics) => ics.replace(/\r\n /g, '');
const alles = (m) => m.subject + '\n' + m.html + '\n' + m.text;

test('BRONNEN: webinar en strategiescan zijn een scan, de rest niet', () => {
  assert.equal(B.isScanAfspraak(WEBINAR), true);
  assert.equal(B.isScanAfspraak(SCAN), true);
  assert.equal(B.isScanAfspraak({ booking_source: ' Webinar ' }), true);
  for (const a of [GEWOON, LAB, { booking_source: null }, {}]) assert.equal(B.isScanAfspraak(a), false);
});

test('SCAN-BEVESTIGING: onderwerp, 20 minuten via Zoom met ons team, wat we bekijken, actieplan', () => {
  for (const a of [WEBINAR, SCAN]) {
    const v = B.varianteVoor('bevestiging', a, B.bouwContext(a));
    assert.equal(v.mail.subject, 'Je strategie-scan staat gepland');
    const t = alles(v.mail);
    assert.match(t, /20 minuten via Zoom met ons team/);
    assert.match(t, /tradeplan/);
    assert.match(t, /journal/);
    assert.match(t, /strategie/);
    assert.match(t, /dagelijks leven/);
    assert.match(t, /actieplan/);
    assert.match(t, /afspraak\/tok9/, 'verzetlink');
    assert.match(t, /De Forex Opleiding/);
  }
});

test('SCAN: geen enkel moment zegt kennismakingsgesprek, Dave of Heylen', () => {
  for (const a of [WEBINAR, SCAN]) {
    const c = B.bouwContext(a);
    for (const k of KEYS) {
      const v = B.varianteVoor(k, a, c);
      assert.ok(v, k);
      const t = alles(v.mail);
      assert.match(t, /strategie-scan/i, k);
      assert.doesNotMatch(t, /kennismaking/i, k);
      assert.doesNotMatch(t, /dave|heylen/i, k);
      if (k === 'bevestiging') assert.doesNotMatch(v.mail.attachments[0].content, /dave|heylen|kennismaking/i);
    }
  }
});

test('SCAN: WhatsApp blijft aan met de goedgekeurde templates (geen nieuwe namen)', () => {
  const c = B.bouwContext(WEBINAR);
  for (const k of KEYS) assert.equal(B.varianteVoor(k, WEBINAR, c).whatsapp, true, k);
  assert.deepEqual(B.MOMENTEN.map((m) => m.waTemplate), [
    'afspraak_bevestiging_v1', 'afspraak_reminder_24u_v1', 'afspraak_reminder_2u_v1', 'afspraak_reminder_30m_v1', 'afspraak_zoom_5min_v1',
  ]);
});

test('SCAN: herinnering 2 uur vooraf, zoals de standaard (niet 1 uur zoals The Lab)', () => {
  const t = Date.parse(START);
  assert.equal(mom('r2').match(WEBINAR, t - 90 * 60000), true);
  assert.match(B.varianteVoor('r2', WEBINAR, B.bouwContext(WEBINAR)).mail.subject, /Over 2 uur/);
});

test('SCAN-ICS: titel, 20 minuten, UTC, stabiele UID, Zoom, geen ORGANIZER', () => {
  const v = B.varianteVoor('bevestiging', WEBINAR, B.bouwContext(WEBINAR));
  assert.equal(v.mail.attachments.length, 1);
  const ics = v.mail.attachments[0];
  assert.equal(ics.filename, 'strategie-scan.ics');
  assert.match(ics.contentType, /text\/calendar/);
  const o = ontvouw(ics.content);
  assert.match(o, /SUMMARY:Strategie-scan — De Forex Opleiding/);
  assert.match(o, /DTSTART:20261104T180000Z/);
  assert.match(o, /DTEND:20261104T182000Z/);
  assert.match(o, /UID:appt-9@deforexopleiding\.nl/);
  assert.match(o, /LOCATION:https:\/\/zoom\.us\/j\/999/);
  assert.match(o, /met ons team/);
  assert.doesNotMatch(o, /ORGANIZER|ATTENDEE|gmail/i);
  assert.ok(ics.content.split('\r\n').every((r) => Buffer.byteLength(r, 'utf8') <= 75), 'gevouwen op 75 octetten');
});

test('STANDAARD-BEVESTIGING: tekst ongewijzigd, nu met .ics (kennismakingsgesprek, 20 min, geen ORGANIZER)', () => {
  assert.equal(B.varianteVoor('bevestiging', GEWOON, B.bouwContext(GEWOON)), null);
  const m = mom('bevestiging').mail(GEWOON, B.bouwContext(GEWOON));
  assert.equal(m.subject, 'Je kennismakingsgesprek staat gepland');
  assert.match(m.html, /In ongeveer 20 minuten kijken we samen naar jouw situatie/);
  const ics = m.attachments[0];
  assert.equal(ics.filename, 'kennismakingsgesprek.ics');
  const o = ontvouw(ics.content);
  assert.match(o, /SUMMARY:Kennismakingsgesprek — De Forex Opleiding/);
  assert.match(o, /DTEND:20261104T182000Z/);
  assert.doesNotMatch(o, /ORGANIZER|ATTENDEE/);
});

test('STANDAARD-HERINNERINGEN: ongewijzigd en zonder bijlage', () => {
  const c = B.bouwContext(GEWOON);
  for (const k of ['r24', 'r2', 'r30', 'zoom5']) {
    assert.equal(B.varianteVoor(k, GEWOON, c), null, k);
    const m = mom(k).mail(GEWOON, c);
    assert.match(m.subject, /kennismakingsgesprek/, k);
    assert.equal(m.attachments, undefined, k);
  }
});

test('THE LAB: blijft de Lab-variant met eigen .ics', () => {
  const v = B.varianteVoor('bevestiging', LAB, B.bouwContext(LAB));
  assert.match(v.mail.subject, /strategiesessie met Dave/);
  assert.equal(v.mail.attachments[0].filename, 'strategiesessie.ics');
  assert.equal(B.varianteVoor('r2', LAB, B.bouwContext(LAB)).whatsapp, false);
});

test('CRON: kiest de variant via varianteVoor en geeft bijlagen door', () => {
  const src = readFileSync(join(ROOT, 'api/cron-afspraak-reminders.js'), 'utf8');
  assert.match(src, /varianteVoor\(moment\.key, appt, ctx\)/);
  assert.equal((src.match(/attachments = null \} = variant \? variant\.mail : moment\.mail\(appt, ctx\)/g) || []).length, 2);
  assert.doesNotMatch(src, /labVariant\(/);
});

test('WEBINAR-SCHERM: "met ons team", niet "bij Dave"', () => {
  const src = readFileSync(join(ROOT, 'modules/klanten-v2/views/webinar-v2.js'), 'utf8');
  assert.match(src, /strategie-scan \(t\.w\.v\. €99\) met ons team mee\./);
  assert.doesNotMatch(src, /bij Dave/);
});
