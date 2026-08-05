// tests/lisa-refusal-detector.test.js
//
// Unit-tests voor api/_lib/lisa-refusal-detector.js — de guard die AI-weigeringen
// en meta-reflecties detecteert zodat ze niet naar de klant verstuurd worden.
//
// Kritieke test-set: exacte zinnen uit de burst van 30-31 juli 2026 (DJ-case,
// conv 26d395ee-...) én andere realistische varianten. False-positive-tests
// bevatten normale IG-DM-berichten die Lisa wél zou moeten kunnen versturen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRefusal } from '../api/_lib/lisa-refusal-detector.js';

// ── True positives: bewijs uit productie (moeten geblokkeerd worden) ──────
test('DJ-case: "Kijkend naar dit gesprek, zie ik dat Lisa..." → refused', () => {
  const r = looksLikeRefusal('Kijkend naar dit gesprek, zie ik dat Lisa al zes keer heeft gezegd dat ze niet meer zal berichturen — het zou niet oprecht of respectvol zijn om nu toch nog een follow-up te sturen.');
  assert.equal(r.refused, true);
  assert.ok(['meta_reflection', 'lisa_third_person', 'ethical_meta'].includes(r.reason));
});

test('DJ-case: "Ik kan dit bericht niet genereren..." → refused', () => {
  const r = looksLikeRefusal('Ik kan dit bericht niet genereren. In het vorige gesprek heb ik meerdere keren expliciet beloofd om geen berichten meer te sturen.');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'direct_refusal');
});

test('"Het spijt me, maar ik kan..." → refused', () => {
  const r = looksLikeRefusal('Het spijt me, maar ik kan geen bericht genereren dat de eerder gedane beloftes overtreedt.');
  assert.equal(r.refused, true);
});

test('"Ik ben een AI en kan..." → refused', () => {
  const r = looksLikeRefusal('Ik ben een AI-assistent en kan dit type bericht niet versturen.');
  assert.equal(r.refused, true);
});

test('"Als taalmodel kan ik dit niet..." → refused', () => {
  const r = looksLikeRefusal('Als een taalmodel kan ik dit type verzoek niet uitvoeren.');
  assert.equal(r.refused, true);
});

test('"Meerdere keren expliciet beloofd" → refused', () => {
  const r = looksLikeRefusal('Ik heb meerdere keren expliciet beloofd om te stoppen met berichten sturen.');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'meta_reflection');
});

test('"Het zou niet eerlijk zijn" → refused', () => {
  const r = looksLikeRefusal('Het zou niet eerlijk zijn om nu toch nog een bericht te sturen.');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'ethical_meta');
});

test('"Lisa heeft al..." (3e persoon) → refused', () => {
  // Kan matchen op 'meta_reflection' ("meerdere keren aangegeven") OF
  // 'lisa_third_person' ("Lisa heeft") — beide zijn correct als reden.
  const r = looksLikeRefusal('Lisa heeft al meerdere keren aangegeven dat ze respecteert dat je geen interesse hebt.');
  assert.equal(r.refused, true);
  assert.ok(['lisa_third_person', 'meta_reflection'].includes(r.reason));
});

test('"dat Lisa..." (3e persoon) → refused', () => {
  const r = looksLikeRefusal('Ik denk dat Lisa hier het beste zwijgt.');
  assert.equal(r.refused, true);
});

test('"in het vorige gesprek heb ik" → refused', () => {
  const r = looksLikeRefusal('In het vorige gesprek heb ik gezegd dat ik niet meer zou berichten.');
  assert.equal(r.refused, true);
  assert.equal(r.reason, 'meta_reflection');
});

test('"niet ethisch" → refused', () => {
  const r = looksLikeRefusal('Dat zou niet ethisch zijn.');
  assert.equal(r.refused, true);
});

test('"Ik kan dit niet genereren" (met variatie) → refused', () => {
  const r = looksLikeRefusal('Ik kan dit bericht niet schrijven.');
  assert.equal(r.refused, true);
});

// ── False positives: normale IG-DM-berichten (mogen NIET geblokkeerd) ──────
test('Normale intro-DM → NOT refused', () => {
  const r = looksLikeRefusal('Hey! Bedankt voor het volgen 🙌 Ben je geïnteresseerd in traden of gewoon nieuwsgierig?');
  assert.equal(r.refused, false);
});

test('Doel-fase vraag → NOT refused', () => {
  const r = looksLikeRefusal('Wat trekt je aan? Extra inkomen, passief vermogen of financiële vrijheid?');
  assert.equal(r.refused, false);
});

test('Call voorstellen → NOT refused', () => {
  const r = looksLikeRefusal('Ik denk dat het goed past bij wat je zoekt. Laten we even een korte call inplannen met onze trader. 15 minuten, gratis. Past dat?');
  assert.equal(r.refused, false);
});

test('Met agenda-link → NOT refused', () => {
  const r = looksLikeRefusal('Hier is de link om een tijd te kiezen: dfocrm.nl/agenda. Kies wat past!');
  assert.equal(r.refused, false);
});

test('"Ik ben Lisa" begroeting → NOT refused (ik ben, niet 3e persoon)', () => {
  const r = looksLikeRefusal('Hi! Ik ben Lisa, leuk dat je er bent.');
  assert.equal(r.refused, false);
});

test('Follow-up "hoe gaat het?" → NOT refused', () => {
  const r = looksLikeRefusal('Hoe gaat het? Nog vragen over de opleiding?');
  assert.equal(r.refused, false);
});

test('Empathisch: "ik snap dat het veel is" → NOT refused', () => {
  const r = looksLikeRefusal('Ik snap dat het veel informatie is — neem de tijd om erover na te denken.');
  assert.equal(r.refused, false);
});

test('Emoji + korte vraag → NOT refused', () => {
  const r = looksLikeRefusal('Ha! Nog geen antwoord van je gehad 😊 heb je nog vragen?');
  assert.equal(r.refused, false);
});

// ── Edge cases ────────────────────────────────────────────────────────────
test('lege string → NOT refused', () => {
  assert.equal(looksLikeRefusal('').refused, false);
});

test('null → NOT refused', () => {
  assert.equal(looksLikeRefusal(null).refused, false);
});

test('undefined → NOT refused', () => {
  assert.equal(looksLikeRefusal(undefined).refused, false);
});

test('non-string (number) → NOT refused', () => {
  assert.equal(looksLikeRefusal(42).refused, false);
});

test('whitespace-only → NOT refused', () => {
  assert.equal(looksLikeRefusal('   \n\t  ').refused, false);
});

test('reason label ingevuld bij match', () => {
  const r = looksLikeRefusal('Ik kan dit bericht niet genereren.');
  assert.ok(r.reason);
  assert.equal(typeof r.reason, 'string');
});

test('matched_pattern bevat een substring van de input', () => {
  const text = 'Kijkend naar dit gesprek, denk ik dat we moeten stoppen.';
  const r = looksLikeRefusal(text);
  assert.equal(r.refused, true);
  assert.ok(r.matched_pattern);
  assert.ok(text.toLowerCase().includes(r.matched_pattern.toLowerCase()));
});
