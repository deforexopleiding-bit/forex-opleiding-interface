// tests/customers-kolommen.test.js
//
// EEN KOLOM DIE NIET BESTAAT, EN EEN SCHERM DAT DAAR NIETS VAN LIET MERKEN.
//
// `api/_lib/iris/koppel.js` vroeg `customers.name` op. Die kolom bestaat niet:
// het klantbestand heeft `first_name`, `last_name` en `company_name`, en de
// weergavenaam wordt daaruit samengesteld. PostgREST gaf dus op élke opvraging
// een fout, `zoekKlant` viel netjes terug op "onbekend", en het scherm zette
// braaf "niet gekoppeld" bij ELK gesprek — met de echte reden in een regel die
// je alleen ziet als je de dossierkaart opent.
//
// Alles werkte precies zoals het bedoeld was, en het geheel was stuk. Dat is
// het gemene aan faalzacht: het houdt de boel overeind én het houdt de oorzaak
// uit het zicht.
//
// ── WAAROM DEZE TEST EEN LIJST IS EN GEEN OPVRAGING ──────────────────────────
// De testomgeving heeft geen databank, en `customers` heeft geen CREATE TABLE
// in docs/sql-migrations (de tabel is ouder dan die map). De lijst hieronder is
// daarom met de hand bijgehouden, uit twee bronnen die elkaar bevestigen:
//
//   1. de meting op productie (22 september): first_name, last_name,
//      company_name, email, phone — en uitdrukkelijk GEEN name;
//   2. elke andere `.from('customers').select(...)` in dit repo, die allemaal
//      al jaren werken en dus bestaande kolommen noemen.
//
// Komt er een kolom bij, dan hoort die hier ook bij te komen. Dat is met opzet
// een handeling: een kolomnaam verzinnen is precies de fout die dit bestand
// moet vangen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** De kolommen van `public.customers` die we kennen. */
export const KOLOMMEN = new Set([
  'id',
  'is_company', 'company_name', 'first_name', 'last_name',
  'email', 'phone',
  'address_street', 'address_number', 'address_postal', 'address_city', 'address_country',
  'vat_number', 'kvk_number', 'birth_date',
  'tl_company_id', 'tl_contact_id', 'ghl_contact_id',
  'status', 'is_test',
  'onboarding_status', 'onboarding_token', 'onboarding_token_expires_at',
  'onboarding_sent_at', 'onboarding_completed_at',
  'retention_marked_at', 'retention_marked_by', 'retention_not_renewing',
  'risk_tag_auto', 'subscription_end_date', 'imported_from_tl_at',
  'archived_at', 'anonymized_at', 'created_at', 'updated_at',
]);

/** Alle .js onder api/. */
function bestanden(map, uit = []) {
  for (const naam of readdirSync(join(ROOT, map))) {
    if (naam === 'node_modules' || naam.startsWith('.')) continue;
    const pad = join(map, naam);
    if (statSync(join(ROOT, pad)).isDirectory()) bestanden(pad, uit);
    else if (naam.endsWith('.js')) uit.push(pad);
  }
  return uit;
}

/**
 * Elke kolom die in een select op `customers` genoemd wordt.
 *
 * Kijkt naar `.from('customers')` gevolgd door een `.select('…')`, met de
 * ketenmethodes ertussen. `select('*')` wordt overgeslagen: daar valt niets
 * fout te spellen.
 */
function gebruikteKolommen() {
  const uit = [];
  for (const pad of bestanden('api')) {
    const bron = readFileSync(join(ROOT, pad), 'utf8');
    // Let op de `[^.]`-klasse in het midden: de select moet de EERSTE zijn na
    // deze from, zonder dat er onderweg een andere tabel begint. Zonder die
    // eis springt de zoektocht over een `from('customers')` heen naar een
    // select verderop in het bestand, en meldt dan kolommen van een heel
    // andere tabel als vondst. Een controle die krijst is er geen.
    for (const m of bron.matchAll(/from\(\s*'customers'\s*\)((?:[^.]|\.(?!select\(|from\())*)\.select\(\s*'([^']*)'/g)) {
      const sel = m[2].trim();
      if (sel === '*' || !sel) continue;
      for (const stuk of sel.split(',')) {
        // 'alias:kolom' en embedded 'tabel(kolom)' terugbrengen tot de kolom.
        const kolom = stuk.trim().split(':').pop().split('(')[0].trim();
        if (kolom) uit.push({ kolom, bestand: relative('.', pad) });
      }
    }
  }
  return uit;
}

test('geen enkele select op customers noemt een kolom die niet bestaat', () => {
  const onbekend = gebruikteKolommen().filter((g) => !KOLOMMEN.has(g.kolom));
  assert.deepEqual(
    onbekend.map((g) => `${g.bestand}: ${g.kolom}`), [],
    'kolom bestaat niet — PostgREST geeft hier een fout op elke opvraging',
  );
});

test('`name` is en blijft geen kolom van customers', () => {
  // Expliciet, omdat dit de fout was en omdat hij er zo logisch uitziet.
  assert.ok(!KOLOMMEN.has('name'), 'name is samengesteld, geen kolom');
  const bron = readFileSync(join(ROOT, 'api/_lib/iris/koppel.js'), 'utf8');
  assert.ok(!/select\('id, name/.test(bron));
});

test('Iris stelt de klantnaam samen met de gedeelde helper', () => {
  // Een tweede versie van "hoe heet deze klant" is een tweede versie die
  // afwijkt zodra er iets verandert aan bedrijven versus particulieren.
  for (const pad of ['api/_lib/iris/koppel.js', 'api/_lib/iris/dossier.js']) {
    const bron = readFileSync(join(ROOT, pad), 'utf8');
    assert.match(bron, /import \{ customerDisplayName \} from '\.\.\/customer-name\.js'/, pad);
    assert.match(bron, /customerDisplayName\(/, pad);
  }
});

test('de selects halen op wat de helper nodig heeft', () => {
  // customerDisplayName kijkt naar is_company, company_name, first_name en
  // last_name. Ontbreekt er een in de select, dan heet iedereen ineens anders
  // zonder dat er iets faalt.
  for (const pad of ['api/_lib/iris/koppel.js', 'api/_lib/iris/dossier.js']) {
    const bron = readFileSync(join(ROOT, pad), 'utf8');
    const m = bron.match(/from\('customers'\)[\s\S]{0,200}?\.select\('([^']*)'/);
    assert.ok(m, pad + ': geen select op customers gevonden');
    for (const nodig of ['is_company', 'company_name', 'first_name', 'last_name']) {
      assert.ok(m[1].includes(nodig), `${pad}: select mist ${nodig}`);
    }
  }
});
