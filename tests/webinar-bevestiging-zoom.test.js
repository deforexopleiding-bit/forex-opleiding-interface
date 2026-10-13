// tests/webinar-bevestiging-zoom.test.js
//
// De EERSTE webinar-bevestigingsmail (bij aanmelding) bevat de Zoom-link direct,
// precies zoals de verplaats-mail: klikbare "Online via Zoom" bij Waar + de knop
// "Deelnemen via Zoom". Zelfde bron (zoomVoor: sessie → reeks) en hetzelfde
// mailblok (bouwMail('bevestiging')). Zonder Zoom-link: "Online via Zoom (link
// volgt vóór de start)" zonder knop — nooit een lege of kapotte link.
//
// Aanleiding (2026-10-13): een deelnemer kreeg op 9 okt een bevestiging zónder
// link, de verplaats-mail op 12 okt wél. Oorzaak was de volgorde, niet de code:
// de Zoom-link werd pas op 12 okt 10:25 ingesteld. Deze test legt vast dat beide
// mails uit hetzelfde blok komen en dus altijd gelijk lopen.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: null } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), templateStatusOpLijn: async () => 'APPROVED' } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async () => ({ ok: true }) } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });
const W = await import(url('api/_lib/webinar.js'));

const ZOOM = 'https://us06web.zoom.us/j/81234567890?pwd=abc';
const REEKS = { titel: 'Gratis webinar De Forex Opleiding', zoom_url: ZOOM };
const SESSIE = { starts_at: '2026-10-19T17:00:00.000Z', ends_at: '2026-10-19T18:00:00.000Z', zoom_url: null };
const mail = (aanmelding, sessie = SESSIE, reeks = REEKS) => W.bouwMail('bevestiging', W.bouwContext({ aanmelding, sessie, reeks }));
const waarRegel = (html) => (html.match(/Waar<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/) || [])[1];
const knoppen = (html) => [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => [m[2], m[1]]);

test('eerste bevestiging met Zoom-link: klikbare "Online via Zoom" + knop "Deelnemen via Zoom"', () => {
  const m = mail({ voornaam: 'Pieter' });
  assert.equal(m.subject, 'Je bent aangemeld: webinar op maandag 19 oktober');
  assert.equal(waarRegel(m.html).trim(), `<a href="${ZOOM}" style="color:#10284A">Online via Zoom</a>`);
  assert.deepEqual(knoppen(m.html), [['Online via Zoom', ZOOM], ['Deelnemen via Zoom', ZOOM]]);
  assert.doesNotMatch(m.html, /link volgt/);
  assert.match(m.text, new RegExp(`Deelnemen via Zoom: ${ZOOM.replace(/[.?]/g, '\\$&')}`));
});

test('eerste bevestiging en verplaats-mail: identieke Waar-regel en knop (zelfde mailblok, zelfde bron)', () => {
  const eerste = mail({ voornaam: 'Pieter' });
  const verplaatst = mail({ voornaam: 'Pieter', verplaatst_van_sessie_id: 'sessie-oud' });
  assert.notEqual(eerste.subject, verplaatst.subject);
  assert.equal(waarRegel(eerste.html), waarRegel(verplaatst.html));
  assert.deepEqual(knoppen(eerste.html), knoppen(verplaatst.html));
});

test('Zoom-link van de week gaat voor die van de reeks — ook in de eerste bevestiging', () => {
  const eigen = 'https://us06web.zoom.us/j/99999999999';
  assert.deepEqual(knoppen(mail({ voornaam: 'P' }, { ...SESSIE, zoom_url: eigen }).html).map((k) => k[1]), [eigen, eigen]);
});

test('zonder Zoom-link: "link volgt vóór de start", géén knop en géén lege link', () => {
  for (const [sessie, reeks] of [[SESSIE, { ...REEKS, zoom_url: null }], [SESSIE, { ...REEKS, zoom_url: '   ' }]]) {
    const m = mail({ voornaam: 'Pieter' }, sessie, reeks);
    assert.equal(waarRegel(m.html).trim(), 'Online via Zoom (link volgt vóór de start)');
    assert.deepEqual(knoppen(m.html), []);
    assert.doesNotMatch(m.html, /href=""|Deelnemen via Zoom/);
  }
});
