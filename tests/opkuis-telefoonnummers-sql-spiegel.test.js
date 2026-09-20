// tests/opkuis-telefoonnummers-sql-spiegel.test.js
//
// DE OPKUIS-SQL MOET DEZELFDE REGELS VOLGEN ALS normaliseerStrict.
//
// Maxim, 20 september: "Gebruik dezelfde regels als normaliseerStrict in
// api/_lib/phone-e164.js, zodat code en data dezelfde definitie volgen; wijkt
// de SQL daarvan af, dan is dat een bug in wording."
//
// Die eis is hier mechanisch gemaakt. De SQL is niet uitvoerbaar in deze
// testomgeving (geen Postgres), dus de aanpak is tweeledig:
//
//   1. De uitdrukking uit de migratie is hieronder in JS overgeschreven
//      (sqlKandidaat) en wordt op een tabel invoer vergeleken met
//      normaliseerStrict. Lopen ze uiteen, dan valt deze test om.
//   2. Een tweede test pint de LETTERLIJKE vorm in het SQL-bestand vast, zodat
//      de transcriptie hierboven niet stil los kan raken van de echte SQL.
//
// Zonder die tweede test zou punt 1 een gerust gevoel geven over code die niet
// in het bestand staat.
//
// ── DE SCHADE DIE HIERACHTER ZIT ────────────────────────────────────────
// Gemeten over alle send_whatsapp-stappen in event_automation_run_log:
// 186 WhatsApps die nooit zijn aangekomen (Vragenlijst-herinnering 10/64,
// Welkom + vragenlijst 131/38, Reminder laatste uren 70/38, Bevestiging
// aanmelding 109/16, Reminder 24u 131/16, Warmup vroeg 63/14, Geen gehoor 1/0).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normaliseerStrict, isE164 } from '../api/_lib/phone-e164.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL  = readFileSync(
  join(ROOT, 'docs/sql-migrations/2026-09-20-opkuis-telefoonnummers-e164.sql'), 'utf8');

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Letterlijke transcriptie van de uitdrukking in de migratie:
 *
 *   schoon    := regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g')
 *   kandidaat := CASE WHEN schoon LIKE '+%'  THEN schoon
 *                     WHEN schoon LIKE '00%' THEN '+' || substring(schoon from 3)
 *                     ELSE NULL END
 *
 * En de migratie schrijft alleen als `kandidaat ~ E164` én het huidige nummer
 * dat NIET is. Die twee voorwaarden zitten in `sqlZouSchrijven` hieronder.
 */
function sqlKandidaat(phone) {
  if (phone == null) return null;
  const schoon = String(phone).replace(/[\s\-()\.]/g, '');
  if (schoon.startsWith('+'))  return schoon;
  if (schoon.startsWith('00')) return '+' + schoon.slice(2);
  return null;                       // ELSE NULL — een kale 0-prefix dus
}

function sqlZouSchrijven(phone) {
  const k = sqlKandidaat(phone);
  if (k == null || !E164.test(k)) return null;   // kandidaat ~ E164
  if (E164.test(String(phone)))   return null;   // phone !~ E164
  return k;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DEZELFDE DEFINITIE ALS DE CODE
// ═══════════════════════════════════════════════════════════════════════════

const INVOER = [
  // De 140 opmaakgevallen: landcode stond er al, alleen rommel ertussen.
  '+31 6 12 34 56 78', '+31-6-12345678', '(+31) 612345678', '+31.6.12.34.56.78',
  '  +32 472 22 37 52  ', '+32 (0) 472223752', '+31612345678',
  // 00-varianten — normaliseerStrict doet die ook, dus de SQL moet dat ook.
  '0031612345678', '00 32 472223752', '0032-472-223-752',
  // De kale 0-prefix: beide moeten WEIGEREN.
  '0612345678', '0472223752', '0402345678', '045 123 45 67', '0475123456',
  // Zonder prefix, en de drie handwerkgevallen uit de meting.
  '612345678', '31612345678', '047979884', '639503861', 'nonclevalerie@gmailcom',
  // Rommel en leegte.
  '', '   ', null, undefined, '--', '()', '+', '00', '++31612345678',
  '+123', '+0612345678', '+31612345678901234', 'abc', '06/1234567',
];

test('de SQL en normaliseerStrict beslissen op elke invoer hetzelfde', () => {
  for (const in_ of INVOER) {
    const code = normaliseerStrict(in_).e164;   // null = geweigerd
    const sql  = sqlKandidaat(in_);
    const sqlOk = sql != null && E164.test(sql) ? sql : null;
    assert.equal(sqlOk, code,
      'verschil op ' + JSON.stringify(in_) + ': code=' + code + ' sql=' + sqlOk);
  }
});

test('de SQL raakt NOOIT een nummer aan dat al geldig is', () => {
  // Dat is de harde eis uit de opdracht, en de tweede voorwaarde in de WHERE.
  for (const geldig of ['+31612345678', '+32472223752', '+4917612345678']) {
    assert.equal(sqlZouSchrijven(geldig), null, geldig + ' hoort ongemoeid te blijven');
  }
});

test('de SQL schrijft alleen als het resultaat ECHT geldig is', () => {
  // De eigenschap, niet een lijst gevallen: wat de migratie wegschrijft moet
  // altijd door Meta geaccepteerd worden, anders is de opkuis zinloos.
  for (const in_ of INVOER) {
    const r = sqlZouSchrijven(in_);
    if (r !== null) {
      assert.ok(isE164(r), JSON.stringify(in_) + ' zou een niet-E.164 wegschrijven: ' + r);
    }
  }
});

test('een kale 0-prefix wordt door de SQL NIET omgezet', () => {
  // Dit is de reden dat de 15 twijfelgevallen in stap 4 staan en niet in stap
  // 2. De ELSE NULL in de CASE maakt het per constructie onmogelijk.
  for (const nr of ['0612345678', '0472223752', '0402345678', '0475123456', '046 1234567']) {
    assert.equal(sqlKandidaat(nr), null, nr + ' mag geen kandidaat opleveren');
    assert.equal(sqlZouSchrijven(nr), null, nr + ' mag niet geschreven worden');
  }
});

test('de omzetting is idempotent: tweede keer raakt niets', () => {
  // Stap 2 nog een keer draaien hoort 0 rijen te raken.
  for (const in_ of INVOER) {
    const eerste = sqlZouSchrijven(in_);
    if (eerste !== null) {
      assert.equal(sqlZouSchrijven(eerste), null,
        'na omzetting naar ' + eerste + ' zou een tweede run hem opnieuw aanraken');
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE TRANSCRIPTIE KLOPT MET HET BESTAND
// ═══════════════════════════════════════════════════════════════════════════

test('het SQL-bestand bevat exact de uitdrukking die hierboven nagespeeld is', () => {
  // Zonder deze test bewaakt de vorige test code die misschien niet in de
  // migratie staat.
  assert.match(SQL, /regexp_replace\(phone, '\[\[:space:\]\\-\\\(\\\)\\\.\]', '', 'g'\)/,
    'de strip-uitdrukking hoort letterlijk zo in het bestand te staan');
  assert.match(SQL, /WHEN schoon LIKE '\+%'\s+THEN schoon/);
  assert.match(SQL, /WHEN schoon LIKE '00%'\s+THEN '\+' \|\| substring\(schoon from 3\)/);
  assert.match(SQL, /ELSE NULL END AS kandidaat/,
    'de ELSE NULL is wat een kale 0-prefix tegenhoudt');
});

test('de UPDATE heeft beide veiligheidsvoorwaarden', () => {
  const i = SQL.indexOf('UPDATE public.event_attendees a');
  assert.ok(i > 0, 'er hoort precies één UPDATE in te staan');
  const upd = SQL.slice(i, SQL.indexOf(';', i));
  assert.match(upd, /k\.kandidaat ~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'/,
    'alleen schrijven als het resultaat geldig is');
  assert.match(upd, /a\.phone\s+!~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'/,
    'nooit een bestaand geldig nummer aanraken');
  assert.match(upd, /is_test = false/, 'testrijen blijven ongemoeid');
  // En er is er maar één.
  assert.equal(SQL.split('UPDATE public.event_attendees').length - 1, 2,
    'één echte UPDATE plus de uitgecommentarieerde voor stap 4');
});

test('de migratie doet geen DELETE en geen schema-wijziging op event_attendees', () => {
  assert.doesNotMatch(SQL, /DELETE\s+FROM\s+public\.event_attendees/i);
  assert.doesNotMatch(SQL, /ALTER TABLE public\.event_attendees/i);
  assert.doesNotMatch(SQL, /DROP COLUMN/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE TELLING EN DE TWEE HANDWERK-LIJSTEN
// ═══════════════════════════════════════════════════════════════════════════

test('er is een telling VOOR en NA in hetzelfde bestand', () => {
  assert.match(SQL, /STAP 1 — TELLING VOOR/);
  assert.match(SQL, /STAP 3 — TELLING NA/);
  // Dezelfde kolommen, anders is voor/na niet te vergelijken.
  for (const kol of ['nu_al_geldig', 'nu_fout', 'opmaak_te_fixen',
                     'blijft_staan_voor_de_mens']) {
    assert.ok(SQL.split(kol).length - 1 >= 2, kol + ' hoort in beide tellingen te staan');
  }
});

test('de twijfelgevallen worden UITGELIJST, niet omgezet', () => {
  const i = SQL.indexOf('STAP 4 — DE 15 TWIJFELGEVALLEN');
  assert.ok(i > 0);
  const stap4 = SQL.slice(i, SQL.indexOf('STAP 5 —', i));
  // Een SELECT, geen UPDATE die draait.
  assert.match(stap4, /^\s*SELECT/m);
  const actieveUpdates = stap4.split('\n')
    .filter((r) => /UPDATE/.test(r) && !r.trim().startsWith('--'));
  assert.deepEqual(actieveUpdates, [], 'stap 4 mag niets schrijven');
  // En de botsing met NL-netnummers staat er per rij bij — dat is het punt.
  assert.match(stap4, /botst_met_nl/);
  assert.match(stap4, /Roermond/);
  assert.match(stap4, /Heerlen/);
});

test('de 3 handwerkgevallen staan met naam en reden in het bestand', () => {
  for (const nr of ['047979884', '639503861', 'nonclevalerie@gmailcom']) {
    assert.ok(SQL.includes(nr), nr + ' hoort expliciet genoemd te worden');
  }
  const i = SQL.indexOf('STAP 5 —');
  const stap5 = SQL.slice(i);
  const actieveUpdates = stap5.split('\n')
    .filter((r) => /UPDATE|DELETE/.test(r) && !r.trim().startsWith('--'));
  assert.deepEqual(actieveUpdates, [], 'stap 5 mag niets schrijven');
  assert.match(stap5, /waarom_handwerk/);
});

test('de back-up staat er en heeft RLS', () => {
  // Een back-up van telefoonnummers is PII. Postgres zet RLS standaard uit, en
  // in Supabase betekent dat leesbaar met de anon-sleutel.
  assert.match(SQL, /CREATE TABLE IF NOT EXISTS public\._backup_phone_20260920/);
  assert.match(SQL, /ALTER TABLE public\._backup_phone_20260920 ENABLE ROW LEVEL SECURITY/);
  // En een terugzet-aanwijzing, anders is een back-up een dood bestand.
  assert.match(SQL, /SET phone = b\.phone_oud/);
});
