// tests/inbox-verzenden-gedeeld.test.js
//
// De verhuizing van de verzendlogica naar _lib/inbox-verzenden.js.
//
// ── WAT HIER BEWEZEN MOET WORDEN ─────────────────────────────────────────────
// Dit is een verhuizing, geen verbouwing. Vijf schermen hangen aan
// /api/inbox-send — inbox-v2, onboarding-v2, wanbetalers-v2, events-v2 en
// onboarding-overzicht — en die kennen de foutvormen uit hun hoofd. Een 422 die
// stilletjes een 400 wordt, is voor hen een andere foutmelding: de een toont
// "gebruik een template", de ander "er ging iets mis".
//
// De keuring is daarom zuiver gemaakt (geen database, geen netwerk) zodat elke
// afwijzing hier los te testen is. Dat is precies de laag die bepaalt of een
// bericht de moeite van het versturen waard is, en die verdient een test die
// niet eerst een halve wereld hoeft op te starten.
//
// ── EN WAT JOOST EN DE AUTOMATIONS BETREFT ───────────────────────────────────
// Die lopen hier niet langs. Er is geen enkele server-side aanroeper van
// inbox-send; Joost gebruikt joost-send-autonomous en de aanmaanmotor
// cron-dunning-bulk-send. Dat is geen belofte maar iets dat na te kijken is, en
// de laatste test hieronder kijkt het na.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
// Uit de zuivere laag, niet uit inbox-verzenden.js: dat bestand trekt de
// databaselaag mee en valt dan om op een ontbrekende omgevingsvariabele. Een
// test die faalt om een reden die niets met de keuring te maken heeft, leert je
// alleen maar de test te negeren.
import {
  leesVerzendOpdracht,
  MAX_BODY,
  MAX_TEMPLATE_NAME,
  MEDIA_SOORTEN,
  TWENTY_FOUR_HOURS_MS,
} from '../api/_lib/inbox-verzendopdracht.js';

const CONV = '11111111-2222-3333-4444-555555555555';

/** Korter opschrijven wat er uit een afwijzing moet komen. */
const keur = (body) => leesVerzendOpdracht(body);

// ── wat er door mag ─────────────────────────────────────────────────────────

test('een gewoon tekstbericht komt er gekeurd uit', () => {
  const r = keur({ conversation_id: CONV, mode: 'text', body: '  Dag Jan  ' });
  assert.equal(r.ok, true);
  assert.equal(r.opdracht.convId, CONV);
  assert.equal(r.opdracht.mode, 'text');
  assert.equal(r.opdracht.text, 'Dag Jan', 'spaties eromheen horen eraf');
  assert.equal(r.opdracht.mediaKind, null);
});

test('een template krijgt nl als taal wanneer er niets staat', () => {
  const r = keur({ conversation_id: CONV, mode: 'template', template_name: 'herinnering' });
  assert.equal(r.ok, true);
  assert.equal(r.opdracht.templateLanguage, 'nl');
});

test('de drie media-soorten worden herkend', () => {
  for (const soort of MEDIA_SOORTEN) {
    const r = keur({ conversation_id: CONV, mode: soort, media_link: 'https://x.nl/a.pdf' });
    assert.equal(r.ok, true, soort);
    assert.equal(r.opdracht.mediaKind, soort);
  }
});

test('een bestandsnaam hoort alleen bij een document', () => {
  // Meta negeert filename bij image en video. Die dan tóch meesturen is geen
  // ramp, maar het zou wel in onze eigen opslag terechtkomen als body-tekst.
  const doc = keur({ conversation_id: CONV, mode: 'document', media_link: 'https://x.nl/a.pdf', filename: 'factuur.pdf' });
  const img = keur({ conversation_id: CONV, mode: 'image', media_link: 'https://x.nl/a.png', filename: 'factuur.pdf' });
  assert.equal(doc.opdracht.mediaFilename, 'factuur.pdf');
  assert.equal(img.opdracht.mediaFilename, '');
});

// ── wat er niet door mag, en met welke code ─────────────────────────────────

test('een ontbrekend of onzinnig gesprek is een 400, geen 500', () => {
  assert.deepEqual(keur({}), { ok: false, http: 400, payload: { error: 'conversation_id vereist' } });
  assert.equal(keur({ conversation_id: 'abc', mode: 'text', body: 'x' }).http, 400);
  assert.match(keur({ conversation_id: 'abc', mode: 'text', body: 'x' }).payload.error, /geldige uuid/);
});

test('een onbekende modus noemt de modi die wél bestaan', () => {
  // Een foutmelding die alleen "ongeldig" zegt, laat je zoeken in code die je
  // niet hebt.
  const r = keur({ conversation_id: CONV, mode: 'duif' });
  assert.equal(r.http, 400);
  for (const soort of ['text', 'template', ...MEDIA_SOORTEN]) {
    assert.ok(r.payload.error.includes(soort), `${soort} hoort in de melding te staan`);
  }
});

test('een leeg tekstbericht gaat niet de deur uit', () => {
  // Ook niet als het alleen uit spaties bestaat: dan krijgt de klant een lege
  // bel op zijn telefoon.
  assert.equal(keur({ conversation_id: CONV, mode: 'text', body: '' }).http, 400);
  assert.equal(keur({ conversation_id: CONV, mode: 'text', body: '   ' }).http, 400);
  assert.match(keur({ conversation_id: CONV, mode: 'text' }).payload.error, /body vereist/);
});

test('te lange tekst wordt hier geweigerd en niet door Meta', () => {
  // Meta kapt niet af maar weigert. Dat hier vangen scheelt een mislukte
  // verzending die er in het scherm uitziet als een netwerkprobleem.
  const r = keur({ conversation_id: CONV, mode: 'text', body: 'a'.repeat(MAX_BODY + 1) });
  assert.equal(r.http, 400);
  assert.ok(r.payload.error.includes(String(MAX_BODY)));
  assert.equal(keur({ conversation_id: CONV, mode: 'text', body: 'a'.repeat(MAX_BODY) }).ok, true,
    'precies op de grens mag wel');
});

test('een template zonder naam en een te lange naam vallen af', () => {
  assert.match(keur({ conversation_id: CONV, mode: 'template' }).payload.error, /template_name vereist/);
  const lang = keur({ conversation_id: CONV, mode: 'template', template_name: 'x'.repeat(MAX_TEMPLATE_NAME + 1) });
  assert.equal(lang.http, 400);
});

test('media zonder link, of over http, komt er niet door', () => {
  // http zou de link door Meta laten ophalen over een onbeveiligde verbinding;
  // Meta weigert dat, maar dan zijn we al een rondje verder.
  assert.match(keur({ conversation_id: CONV, mode: 'image' }).payload.error, /media_link vereist/);
  const onveilig = keur({ conversation_id: CONV, mode: 'image', media_link: 'http://x.nl/a.png' });
  assert.equal(onveilig.http, 400);
  assert.match(onveilig.payload.error, /https/);
});

test('onzin als hele body gooit niets om', () => {
  for (const rommel of [null, undefined, 'tekst', 42, []]) {
    const r = keur(rommel);
    assert.equal(r.ok, false);
    assert.equal(r.http, 400);
  }
});

// ── de vormen die de schermen kennen ────────────────────────────────────────

const LIB = readFileSync(new URL('../api/_lib/inbox-verzenden.js', import.meta.url), 'utf8');

test('het 24-uursvenster geeft nog steeds 422 met dezelfde sleutel', () => {
  // De schermen kijken op deze exacte tekst om de venster-badge om te zetten
  // en de juiste uitleg te tonen.
  assert.match(LIB, /http: 422/);
  assert.match(LIB, /error: '24h_window_expired'/);
  assert.match(LIB, /source : 'meta'/, 'het scherm wil kunnen zien wie het zei');
});

test('de Meta-codes die "venster dicht" betekenen staan er alle drie', () => {
  for (const code of ['131047', '131051', '131026']) {
    assert.ok(LIB.includes(code), `Meta-code ${code} ontbreekt`);
  }
});

test('een Meta-storing blijft 502 en een ontbrekende config 503', () => {
  assert.match(LIB, /http: 502, payload: \{ error: 'Meta API fout'/);
  assert.match(LIB, /http: 503, payload: \{ error: 'Meta WhatsApp niet geconfigureerd'/);
});

test('het venster wordt gemeten op 24 uur, niet op iets anders', () => {
  assert.equal(TWENTY_FOUR_HOURS_MS, 24 * 60 * 60 * 1000);
});

test('alles ná de Meta-call is faalzacht', () => {
  // Vanaf het moment dat Meta het bericht heeft, mag niets in deze functie de
  // verzending nog ongedaan laten lijken. Audit, ontpauzeren en werkstand
  // hebben daarom elk hun eigen vangnet.
  const na = LIB.slice(LIB.indexOf('const wamid ='));
  assert.match(na, /catch \(auditErr\)/);
  assert.match(na, /catch \(unpauseErr\)/);
  assert.match(na, /catch \(wEx\)/);
});

// ── en waar het niet langs loopt ────────────────────────────────────────────

test('geen enkel ander endpoint verstuurt via inbox-send', () => {
  // Joost en de aanmaanmotor hebben hun eigen weg. Zou er ooit een
  // server-side aanroeper bijkomen, dan verandert deze verhuizing wél iets
  // voor hem, en dan hoort dat op te vallen.
  const apiMap = new URL('../api/', import.meta.url);
  const verdacht = [];
  for (const naam of readdirSync(apiMap).filter((f) => f.endsWith('.js'))) {
    if (naam === 'inbox-send.js') continue;
    const src = readFileSync(new URL(naam, apiMap), 'utf8');
    // Een echte aanroep, geen verwijzing in een comment.
    if (/fetch\([^)]*['"`][^'"`]*\/api\/inbox-send['"`]/.test(src)) verdacht.push(naam);
  }
  assert.deepEqual(verdacht, []);
});
