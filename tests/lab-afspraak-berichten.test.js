// tests/lab-afspraak-berichten.test.js
//
// DE BEVESTIGING EN HERINNERINGEN VAN DE STRATEGIESESSIE NA THE LAB.
//   - een Lab-boeking (booking_source 'the-lab') krijgt eigen teksten: met
//     Dave, 30 minuten, wat we bespreken — nooit "kennismakingsgesprek";
//   - de bevestiging draagt een geldige .ics (UTC, 30 min, stabiele UID);
//   - de korte herinnering valt 1 uur vooraf (niet 2) en gaat niet via de
//     "over 2 uur"-WhatsApp-template;
//   - elke herinnering draagt de link om te verzetten;
//   - een gewone boeking blijft precies zoals ze was.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: {} } });

const B = await import(url('api/_lib/afspraak-berichten.js'));
const { maakIcs, icsTekst, vouw } = await import(url('api/_lib/ics.js'));

const START = '2026-10-21T14:00:00.000Z'; // woensdag 16:00 in Brussel
const LAB = { id: 'appt-1', lead_name: 'Lien Peeters', scheduled_at: START, booking_source: 'the-lab', zoom_join_url: 'https://zoom.us/j/123', afspraak_token: 'tok', gastheer_voornaam: 'Dave' };
const GEWOON = { ...LAB, booking_source: 'webinar', gastheer_voornaam: undefined };
const mom = (k) => B.MOMENTEN.find((m) => m.key === k);

test('LAB-BEVESTIGING: met Dave, 30 minuten, wat we bespreken, verzetlink — geen "kennismakingsgesprek"', () => {
  const c = B.bouwContext(LAB);
  const v = B.labVariant('bevestiging', LAB, c);
  assert.match(v.mail.subject, /strategiesessie met Dave/);
  assert.match(v.mail.html, /30 minuten/);
  assert.match(v.mail.html, /Wat we bespreken/);
  for (const punt of B.LAB_BESPREKEN) assert.ok(v.mail.html.includes(punt), punt);
  assert.match(v.mail.html, /afspraak\/tok/);
  assert.doesNotMatch(v.mail.html + v.mail.text, /kennismakingsgesprek/i);
  assert.equal(v.whatsapp, true);
});

test('LAB-BEVESTIGING: de .ics-bijlage — 30 minuten, UTC, stabiele UID, Zoom als locatie', () => {
  const v = B.labVariant('bevestiging', LAB, B.bouwContext(LAB));
  const ics = v.mail.attachments[0];
  assert.equal(ics.filename, 'strategiesessie.ics');
  assert.match(ics.contentType, /text\/calendar/);
  const ontvouwen = ics.content.replace(/\r\n /g, '');
  assert.match(ontvouwen, /DTSTART:20261021T140000Z/);
  assert.match(ontvouwen, /DTEND:20261021T143000Z/);
  assert.match(ontvouwen, /UID:appt-1@deforexopleiding\.nl/);
  assert.match(ontvouwen, /LOCATION:https:\/\/zoom\.us\/j\/123/);
  assert.match(ontvouwen, /SUMMARY:Strategiesessie met Dave — De Forex Opleiding/);
  assert.ok(ics.content.split('\r\n').every((r) => Buffer.byteLength(r, 'utf8') <= 75), 'regels gevouwen op 75 octetten');
});

test('ZONDER GASTHEER: "met ons team", nooit een lege naam', () => {
  const a = { ...LAB, gastheer_voornaam: null };
  const v = B.labVariant('r24', a, B.bouwContext(a));
  assert.match(v.mail.subject, /met ons team/);
  assert.doesNotMatch(v.mail.subject, /met\s*$/);
});

test('1 UUR VOORAF voor Lab (mail, geen WhatsApp), 2 uur voor een gewone boeking', () => {
  const r2 = mom('r2');
  const t = Date.parse(START);
  // 90 minuten vooraf: gewone boeking ja, Lab nog niet.
  assert.equal(r2.match(GEWOON, t - 90 * 60000), true);
  assert.equal(r2.match(LAB, t - 90 * 60000), false);
  // 50 minuten vooraf: allebei.
  assert.equal(r2.match(LAB, t - 50 * 60000), true);
  const v = B.labVariant('r2', LAB, B.bouwContext(LAB));
  assert.equal(v.whatsapp, false);
  assert.match(v.mail.subject, /Over een uur/);
  assert.match(v.mail.html, /afspraak\/tok/, 'verzetlink');
});

test('24U: herinnering met verzetlink; alle Lab-momenten zeggen "strategiesessie"', () => {
  const c = B.bouwContext(LAB);
  for (const k of ['bevestiging', 'r24', 'r2', 'r30', 'zoom5']) {
    const v = B.labVariant(k, LAB, c);
    assert.match(v.mail.subject + v.mail.html, /strategiesessie|Morgen|sessie/i, k);
    assert.doesNotMatch(v.mail.html, /kennismakingsgesprek/i, k);
  }
  assert.match(B.labVariant('r24', LAB, c).mail.html, /afspraak\/tok/);
});

test('GEWONE BOEKING: ongewijzigd (geen Lab-variant, oude tekst)', () => {
  assert.equal(B.isLabAfspraak(GEWOON), false);
  const m = mom('bevestiging').mail(GEWOON, B.bouwContext(GEWOON));
  assert.match(m.subject, /kennismakingsgesprek/);
});

test('ics-hulpjes', () => {
  assert.equal(icsTekst('a,b;c\\d\ne'), 'a\\,b\;c\\\\d\\ne');
  assert.ok(vouw('x'.repeat(200)).split('\r\n').every((r) => r.length <= 75));
  const ics = maakIcs({ uid: 'u', start: START, titel: 't', nu: new Date(START) });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
});
