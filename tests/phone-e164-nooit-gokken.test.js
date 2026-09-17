// tests/phone-e164-nooit-gokken.test.js
//
// TELEFOONNUMMERS: EENDUIDIG OMZETTEN, ANDERS WEIGEREN.
//
// GEMETEN op 16 september. Maxim zette zichzelf op een testevent met
// '0472223752'. Run 994c0636 ('Welkom + vragenlijst'): stap 0 send_email
// ok:true, stap 1 send_whatsapp ok:FALSE met Meta 131009 "Het telefoonnummer
// is onjuist ingedeeld", permanent:true.
//
// Over alle event_attendees met is_test=false: 159 rijen met een nummer dat
// niet aan ^\+[1-9][0-9]{7,14}$ voldoet (9 op komende events), 25 wel (23 op
// komende events), 10 zonder nummer.
//
// DE KERN VAN DEZE TEST is niet dat er genormaliseerd wordt, maar dat er NIET
// GEGOKT wordt. '0472223752' is als +32472223752 een geldig Belgisch gsm en
// als +31472223752 een nummer dat niet bestaat. Wie daar +31 van maakt stuurt
// iemands eventgegevens naar een wildvreemde.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  normaliseerStrict, normaliseerLenient, isE164, E164_RE,
} from '../api/_lib/phone-e164.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE REGEX IS DIE VAN DE METING
// ═══════════════════════════════════════════════════════════════════════════

test('E164_RE is exact de vorm waarmee de 159 rijen geteld zijn', () => {
  assert.equal(E164_RE.source, '^\\+[1-9][0-9]{7,14}$');
  assert.equal(isE164('+31612345678'), true);
  assert.equal(isE164('+32472223752'), true);
  assert.equal(isE164('+0612345678'), false, 'landcode mag niet met 0 beginnen');
  assert.equal(isE164('0612345678'),  false);
  assert.equal(isE164('+316123'),     false, 'te kort');
  assert.equal(isE164('+3161234567890123'), false, 'te lang');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · WAT EENDUIDIG IS, GAAT DOOR
// ═══════════════════════════════════════════════════════════════════════════

test('+ en 00 zijn eenduidig en worden overgenomen', () => {
  for (const [in_, uit] of [
    ['+31612345678',      '+31612345678'],
    ['+32472223752',      '+32472223752'],
    ['0031612345678',     '+31612345678'],
    ['0032472223752',     '+32472223752'],
    // Spaties, streepjes, haakjes en punten zijn opmaak, geen betekenis.
    ['+31 6 12 34 56 78', '+31612345678'],
    ['+31-6-12345678',    '+31612345678'],
    ['(+31) 612345678',   '+31612345678'],
    ['+31.6.12.34.56.78', '+31612345678'],
    ['  +31612345678  ',  '+31612345678'],
  ]) {
    const r = normaliseerStrict(in_);
    assert.equal(r.e164, uit, in_ + ' hoort ' + uit + ' te worden');
    assert.equal(r.fout, null, in_ + ' hoort geen fout te geven');
  }
});

test('geen nummer is geen fout', () => {
  // Niet iedereen geeft een telefoonnummer, en dat mag een inschrijving niet
  // blokkeren.
  for (const leeg of [null, undefined, '', '   ', '--', '()']) {
    const r = normaliseerStrict(leeg);
    assert.equal(r.e164, null);
    assert.equal(r.fout, null, JSON.stringify(leeg) + ' hoort geen fout te geven');
    assert.equal(r.ambigu, false);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE KERN — WAT NIET EENDUIDIG IS, WORDT GEWEIGERD
// ═══════════════════════════════════════════════════════════════════════════

test("HET GEMETEN NUMMER '0472223752' wordt NIET gegokt", () => {
  const r = normaliseerStrict('0472223752');
  assert.equal(r.e164, null, 'er mag GEEN nummer uit komen');
  assert.equal(r.ambigu, true);
  assert.ok(r.fout, 'er hoort een leesbare melding te zijn');
  // En de melding vraagt om de landcode, want dat is wat de invuller moet doen.
  assert.match(r.fout, /landcode/i);
  // De melding noemt het geval zelf, zodat hij niet als algemene regel leest.
  assert.match(r.fout, /\+31612345678|\+32472223752/,
    'de melding hoort een voorbeeld met landcode te geven');
});

test('een 0-prefix levert NOOIT een landcode op', () => {
  // Dit is de hele reden dat dit bestand bestaat. Hetzelfde '04'-begin
  // betekent in NL iets anders dan in BE: 045x-049x is Belgisch mobiel, maar
  // 040xxxxxxx is een vastnummer in Eindhoven. Er valt niets te concluderen.
  for (const nr of [
    '0612345678',   // NL mobiel
    '0472223752',   // BE mobiel — het gemeten geval
    '0402345678',   // NL vast (Eindhoven) — GEEN BE mobiel
    '0470123456',
    '090012345',
    '0',
  ]) {
    const r = normaliseerStrict(nr);
    assert.equal(r.e164, null, nr + ' mag geen E.164 opleveren');
    assert.ok(r.fout, nr + ' hoort een melding te geven');
  }
});

test('ook zonder 0 en zonder + wordt er niet geraden', () => {
  // '612345678' kan een NL gsm zonder 0 zijn; '31612345678' een NL nummer
  // zonder +. Beide zijn een gok.
  for (const nr of ['612345678', '31612345678', '472223752', '123']) {
    const r = normaliseerStrict(nr);
    assert.equal(r.e164, null, nr + ' mag geen E.164 opleveren');
    assert.equal(r.ambigu, true);
  }
});

test('een + of 00 met een onzinnige rest wordt geweigerd, niet doorgelaten', () => {
  for (const nr of ['+123', '+0612345678', '0012', '+31612345678901234']) {
    const r = normaliseerStrict(nr);
    assert.equal(r.e164, null, nr + ' mag niet doorgelaten worden');
    assert.ok(r.fout, nr + ' hoort een melding te geven');
  }
});

test('wat doorkomt voldoet ALTIJD aan de Meta-vorm', () => {
  // De eigenschap, niet een lijst gevallen: geen invoer mag iets opleveren dat
  // Meta alsnog met 131009 afwijst.
  const invoer = [
    '+31612345678', '0031612345678', '0472223752', '0612345678', '612345678',
    '+123', '', null, '  ', '+32 472 22 37 52', '00 32 472223752', 'abc',
    '+31 (6) 12-34.56.78', '0', '00', '+', '++31612345678', '06/1234567',
  ];
  for (const in_ of invoer) {
    const r = normaliseerStrict(in_);
    if (r.e164 !== null) {
      assert.ok(isE164(r.e164), JSON.stringify(in_) + ' leverde een niet-E.164 op: ' + r.e164);
    }
    // En nooit tegelijk een nummer EN een fout.
    assert.ok(!(r.e164 && r.fout), JSON.stringify(in_) + ' gaf zowel nummer als fout');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET LOG-PAD IS NIET VERANDERD
// ═══════════════════════════════════════════════════════════════════════════

test('normaliseerLenient gedraagt zich exact als de oude _normalizeToE164', () => {
  // De softphone mag de 0-prefix wél mappen: de beller kiest de lijn zelf, dus
  // het land is bekend en er wordt niets geraden. Dit vastpinnen zodat de
  // verhuizing naar _lib geen gedragswijziging is.
  assert.equal(normaliseerLenient('+31612345678', 'nl'), '+31612345678');
  assert.equal(normaliseerLenient('0031612345678', 'nl'), '+31612345678');
  assert.equal(normaliseerLenient('0612345678', 'nl'), '+31612345678');
  assert.equal(normaliseerLenient('0472223752', 'be'), '+32472223752');
  // Geen lijn → geen mapping, en de raw komt eruit (geen 400).
  assert.equal(normaliseerLenient('0612345678', undefined), '0612345678');
  assert.equal(normaliseerLenient('101', 'nl'), '101', 'short-code blijft raw');
  assert.equal(normaliseerLenient('', 'nl'), null);
  assert.equal(normaliseerLenient(null, 'nl'), null);
  // Punten worden hier NIET gestript — dat was het oude gedrag en dat blijft.
  assert.equal(normaliseerLenient('06.12', 'nl'), '+316.12');
});

test('softphone-call-log heeft geen eigen parser meer', () => {
  const bron = zonderUitleg(readFileSync(join(ROOT, 'api/softphone-call-log.js'), 'utf8'));
  assert.doesNotMatch(bron, /function _normalizeToE164/,
    'de tweede definitie hoort weg — één parser in _lib/phone-e164.js');
  assert.match(bron, /normaliseerLenient/, 'hij hoort de lib te gebruiken');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · ALLE VIJF DE SCHRIJFPADEN GEBRUIKEN DE OMZETTER
// ═══════════════════════════════════════════════════════════════════════════

test('elk pad waarlangs een deelnemer een nummer krijgt, normaliseert', () => {
  // Vijf, niet vier: events-signup-inbox-resolve.js heeft zijn EIGEN insert
  // en loopt dus niet via createAttendee. Die zou anders overgeslagen zijn.
  for (const f of [
    'api/events-attendee-add.js',
    'api/events-attendee-update.js',
    'api/_lib/event-signup-processor.js',
    'api/events-signup-inbox-resolve.js',
  ]) {
    const bron = zonderUitleg(readFileSync(join(ROOT, f), 'utf8'));
    assert.match(bron, /normaliseerStrict/, f + ' normaliseert het nummer niet');
  }
});

test('de twee paden met een mens erbij WEIGEREN, de twee andere niet', () => {
  // Weigeren waar iemand het nummer net typte en het meteen kan verbeteren.
  // Niet weigeren waar dat een echte inschrijving zou laten verdwijnen of de
  // inbox-triage zou blokkeren — daar blijft het nummer rauw staan zodat de
  // opschoon-migratie hem kan vinden.
  for (const f of ['api/events-attendee-add.js', 'api/events-attendee-update.js']) {
    const bron = zonderUitleg(readFileSync(join(ROOT, f), 'utf8'));
    assert.match(bron, /status\(400\)[\s\S]{0,120}(phoneNorm|pn)\.fout|(phoneNorm|pn)\.fout[\s\S]{0,200}status\(400\)/,
      f + ' hoort een 400 te geven op een niet-eenduidig nummer');
  }
  for (const f of ['api/_lib/event-signup-processor.js', 'api/events-signup-inbox-resolve.js']) {
    const bron = zonderUitleg(readFileSync(join(ROOT, f), 'utf8'));
    assert.match(bron, /console\.warn/,
      f + ' hoort het luid te loggen in plaats van stil over te slaan');
  }
});
