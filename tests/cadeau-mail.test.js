// tests/cadeau-mail.test.js — mail bij een cadeaupagina (/checklist), 2026-11-25.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CADEAU_MAILS, DISCLAIMER, MAIL_VAN, LOG_SOORT, bouwCadeauMail, magCadeauMailWeg,
  valideerCadeauMailVerzoek, veiligeVoornaam,
} from '../api/_lib/cadeau-mail.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('verzoek: bekend cadeau, geldig adres, score 0..5', () => {
  assert.deepEqual(valideerCadeauMailVerzoek({ cadeau: 'checklist', email: ' Jan@X.be ', score: 4 }), { ok: true, cadeau: 'checklist', email: 'jan@x.be', score: 4 });
  for (const b of [{}, { cadeau: 'iets', email: 'a@b.be', score: 1 }, { cadeau: 'checklist', email: 'nee', score: 1 },
    { cadeau: 'checklist', email: 'a@b.be', score: 6 }, { cadeau: 'checklist', email: 'a@b.be', score: -1 }, { cadeau: 'checklist', email: 'a@b.be', score: 2.5 },
    { cadeau: '__proto__', email: 'a@b.be', score: 1 }]) assert.equal(valideerCadeauMailVerzoek(b).ok, false, JSON.stringify(b));
});

test('mail: onderwerp, de zes regels (met het gecorrigeerde order block), score, knop naar Dave, disclaimer', () => {
  const m = bouwCadeauMail('checklist', { voornaam: 'Jan', score: 4 });
  assert.equal(m.subject, 'Je checklist: de entry-check');
  assert.equal(MAIL_VAN, 'welkom@deforexopleiding.nl');
  for (const [label, tekst] of CADEAU_MAILS.checklist.regels) {
    assert.ok(m.text.includes(`${label}: ${tekst}`), label);
  }
  assert.ok(m.text.includes('Order block: De kaars net voor het gat is gemarkeerd.'));
  assert.match(m.text, /Hoi Jan, hier is de checklist die wij bij elke trade openhouden\. Je had er 4 van de 5 in één keer juist\./);
  assert.match(m.text, /Bespreek je resultaat met Dave: https:\/\/www\.deforexopleiding\.nl\/agenda\/strategiescan\?cadeau=checklist/);
  assert.ok(m.text.includes(DISCLAIMER));
  assert.equal(DISCLAIMER, 'Geen garantie op resultaat; traden brengt risico op verlies mee.');
  assert.match(m.html, /href="https:\/\/www\.deforexopleiding\.nl\/agenda\/strategiescan\?cadeau=checklist"/);
  // Geen verkooptaal, beloftes of schaarste.
  assert.doesNotMatch(m.text, /gratis|t\.w\.v|€|plekken|beperkt|laatste kans|garandeer|winst|nu nog|snel/i);
});

test('voornaam uit de lead: alleen letters (geen links of opmaak in de aanhef)', () => {
  assert.equal(veiligeVoornaam('Jan'), 'Jan');
  assert.equal(veiligeVoornaam("Zoë-Ann O'Neil"), "Zoë-Ann O'Neil");
  assert.equal(veiligeVoornaam('Win €1000 op http://x.y <b>nu</b>'), 'Win op httpxy bnub');
  assert.equal(veiligeVoornaam(''), 'daar');
  const m = bouwCadeauMail('checklist', { voornaam: '<script>x</script>', score: 1 });
  assert.doesNotMatch(m.html, /<script>/);
});

test('één verstuurde mail per lead per cadeau; na mislukken opnieuw, max 5 pogingen per uur', () => {
  const nu = Date.parse('2026-11-25T12:00:00Z');
  assert.deepEqual(magCadeauMailWeg([], nu), { mag: true, reden: null });
  assert.deepEqual(magCadeauMailWeg([{ status: 'verstuurd', verstuurd_op: '2026-11-20T10:00:00Z' }], nu), { mag: false, reden: 'al_verstuurd' });
  const mislukt = (min) => ({ status: 'mislukt', verstuurd_op: new Date(nu - min * 60000).toISOString() });
  assert.equal(magCadeauMailWeg([mislukt(5), mislukt(10)], nu).mag, true);
  assert.deepEqual(magCadeauMailWeg([1, 2, 3, 4, 5].map(mislukt), nu), { mag: false, reden: 'te_veel_pogingen' });
  assert.equal(magCadeauMailWeg([1, 2, 3, 4, 90].map(mislukt), nu).mag, true, 'oude pogingen tellen niet');
  assert.equal(LOG_SOORT('checklist'), 'cadeau-checklist');
});

test('route: intern geheim, lead uit de DB (campagne = cadeau), logboek bij de lead', () => {
  const src = readFileSync(join(ROOT, 'api/public-cadeau-mail.js'), 'utf8');
  assert.match(src, /req\.headers\['x-internal-token'\] !== verwacht/);
  assert.match(src, /\.ilike\('email', email\)\.eq\('campagne', cadeau\)/);
  assert.match(src, /bouwCadeauMail\(cadeau, \{ voornaam: lead\.voornaam, score \}\)/);
  assert.match(src, /from\('berichten_log'\)\.insert\(\{/);
  assert.match(src, /status: r\?\.ok \? 'verstuurd' : 'mislukt'/);
  assert.match(src, /to: lead\.email/, 'altijd naar het adres van de lead');
});
