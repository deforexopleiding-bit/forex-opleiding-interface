// tests/hlms-lezers-kloppen.test.js
//
// Leest het CRM een kolom die in het LMS niet bestaat?
//
// ── WAAROM DEZE TOETS BESTAAT ───────────────────────────────────────────────
// #1708: `haalSignalen()` vroeg `hlms_signaal` om `created_at`. Die kolom
// bestaat niet. Gevolg: een 400 in de LMS-logs, elke vijf minuten, maanden
// lang. De eerste reparatie verving hem door `aangemaakt_op` — gelezen uit een
// migratiebestand in de LMS-repo dat toen niet gedraaid was — en gaf dezelfde
// 400. Een repo is geen schema.
//
// De dumps in tests/vast/hlms-kolommen-<datum>*.json zijn METINGEN op
// `information_schema` van dfo-lms (13 en 15 oktober 2026). Geen aanname.
//
// ── DE RICHTING VAN DEZE TOETS, EN WAAROM DAT UITMAAKT ──────────────────────
// Hij faalt als een lezer een kolom gebruikt die NIET in de dump staat. Hij
// faalt NIET als het LMS kolommen bij krijgt — en dat is met opzet, want dat
// gebeurt (hlms_signaal kreeg er negen bij op 1 oktober). Een toets die eist
// dat de dump volledig actueel is, verjaart binnen een maand en pint dan een
// onwaarheid vast; dat is les 16.
//
// WAT DEZE TOETSE NIET VANGT: een kolom die uit het LMS VERDWIJNT. Dan staat
// hij nog in de dump, komt de lezer er hier mee door, en valt hij in productie
// om. Daar is alleen een nieuwe meting tegen, niet een toets. Vandaar de datum
// in de bestandsnaam: hij is leesbaar oud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HIER = dirname(fileURLToPath(import.meta.url));
const WORTEL = join(HIER, '..');
const API = join(WORTEL, 'api');

// Twee metingen: de brede van 13 oktober en die van 15 oktober na de migratie
// hlms_lab_lead.sql (hlms_rol, hlms_lab_*, hlms_les — daar zaten ze nog niet in).
const DUMP = {
  ...JSON.parse(readFileSync(join(HIER, 'vast/hlms-kolommen-20261013.json'), 'utf8')),
  ...JSON.parse(readFileSync(join(HIER, 'vast/hlms-kolommen-20261015-lab.json'), 'utf8')),
  // Na hlms_lab_lead_gebeurtenis.sql (route + gebeurtenissen van een lab-lead).
  ...Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(HIER, 'vast/hlms-kolommen-20261015-gebeurtenis.json'), 'utf8'))).filter(([t]) => !t.startsWith('_'))),
};

// VERWACHT, NIET GEMETEN — tabellen die nog niet in de meting staan (nieuw uit
// een LMS-migratie, of nog nooit meegemeten). Apart bestand met de bron per
// tabel, zodat het verschil tussen "gemeten" en "verwacht" zichtbaar blijft.
// De toets onderaan eist dat een tabel hier verdwijnt zodra hij gemeten is.
const VERWACHT_RUW = JSON.parse(readFileSync(join(HIER, 'vast/hlms-kolommen-verwacht-lab.json'), 'utf8'));
const VERWACHT = Object.fromEntries(Object.entries(VERWACHT_RUW).filter(([t]) => !t.startsWith('_')));

const KOLOMMEN = Object.fromEntries(
  Object.entries({ ...VERWACHT, ...DUMP }).map(([t, c]) => [t, new Set(c.split(',').map((x) => x.trim()))])
);

const FILTERS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'overlaps'];

function jsBestanden(map) {
  const uit = [];
  for (const naam of readdirSync(map)) {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) uit.push(...jsBestanden(pad));
    else if (naam.endsWith('.js')) uit.push(pad);
  }
  return uit;
}

/** Commentaar eruit: een kolomnaam in een uitleg is geen opvraging. */
function zonderCommentaar(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
}

/**
 * Elke kolom die een lezer van een hlms_-tabel noemt, met waar hij staat.
 *
 * Pakt select-lijsten, filters, order, not, en de sleutels op diepte 1 van
 * insert/update/upsert. Een select met een geneste join (een haakje in de
 * lijst) wordt apart gemeld in plaats van half geparseerd — half parseren is
 * hoe een toets iets doorlaat.
 */
function vindGebruik() {
  const gebruik = [];
  const genest = [];

  for (const pad of jsBestanden(API)) {
    const src = zonderCommentaar(readFileSync(pad, 'utf8'));
    const bestand = relative(WORTEL, pad);

    for (const m of src.matchAll(/\.from\('(hlms_[a-z_]+)'\)/g)) {
      const tabel = m.group ? m.group(1) : m[1];
      let rest = src.slice(m.index + m[0].length, m.index + m[0].length + 1400);
      const volgende = rest.indexOf(".from('");
      if (volgende > 0) rest = rest.slice(0, volgende);

      const meld = (soort, kol) => {
        const k = String(kol || '').trim();
        if (!k || k === '*' || k === 'count') return;
        // `alias:kolom->>pad` leest de kolom `kolom`; het json-pad is geen kolom.
        const zonderAlias = k.includes(':') ? k.split(':').pop().trim() : k;
        gebruik.push({ bestand, tabel, soort, kolom: zonderAlias.split('->')[0].trim() });
      };

      for (const sm of rest.matchAll(/\.select\(\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g)) {
        const lijst = sm[1] || sm[2] || sm[3] || '';
        if (lijst.includes('(')) { genest.push({ bestand, tabel, lijst: lijst.slice(0, 160) }); continue; }
        for (const stuk of lijst.split(',')) meld('select', stuk);
      }
      for (const fm of rest.matchAll(new RegExp(`\\.(${FILTERS.join('|')})\\(\\s*'([^']+)'`, 'g'))) meld(fm[1], fm[2]);
      for (const om of rest.matchAll(/\.order\(\s*'([^']+)'/g)) meld('order', om[1]);
      for (const nm of rest.matchAll(/\.not\(\s*'([^']+)'/g)) meld('not', nm[1]);

      for (const wm of rest.matchAll(/\.(insert|update|upsert)\(\s*\{/g)) {
        const start = rest.indexOf('{', wm.index);
        let diepte = 0, i = start;
        for (; i < rest.length; i++) {
          if (rest[i] === '{') diepte++;
          else if (rest[i] === '}') { diepte--; if (diepte === 0) break; }
        }
        const blok = rest.slice(start, i + 1);
        let d = 0;
        for (const km of blok.matchAll(/([{}])|([a-z_][a-z0-9_]*)\s*:/g)) {
          if (km[1] === '{') d++;
          else if (km[1] === '}') d--;
          else if (d === 1 && km[2]) meld(wm[1], km[2]);
        }
      }
    }
  }
  return { gebruik, genest };
}

const { gebruik, genest } = vindGebruik();

/* ── de toetsen ───────────────────────────────────────────────────────────── */

test('er wordt echt gezocht — de scanner vindt de lezers', () => {
  // Zonder deze toets kan een stille regressie in de scanner zelf de hele
  // audit in een groene nul veranderen.
  assert.ok(gebruik.length > 200, `maar ${gebruik.length} kolomverwijzingen gevonden — de scanner werkt niet`);
  const tabellen = new Set(gebruik.map((g) => g.tabel));
  assert.ok(tabellen.size >= 8, `maar ${tabellen.size} hlms-tabellen gevonden`);
});

test('GEEN ENKELE CRM-LEZER NOEMT EEN KOLOM DIE NIET BESTAAT', () => {
  const fout = [];
  for (const g of gebruik) {
    if (!KOLOMMEN[g.tabel]) { fout.push(`${g.bestand}: tabel ${g.tabel} staat niet in de dump`); continue; }
    if (!KOLOMMEN[g.tabel].has(g.kolom)) fout.push(`${g.bestand}: ${g.tabel}.${g.kolom} (${g.soort}) bestaat niet`);
  }
  assert.deepEqual(fout, [], `\n  ${fout.join('\n  ')}\n`);
});

test('elke gelezen tabel staat in de dump', () => {
  // Een tabel die niet in de dump staat, is of nieuw of verkeerd gespeld — en
  // het tweede geval is #1708 met een tabelnaam in plaats van een kolomnaam.
  const onbekend = [...new Set(gebruik.map((g) => g.tabel))].filter((t) => !KOLOMMEN[t]);
  assert.deepEqual(onbekend, []);
});

test('geen select met een geneste join blijft ongezien', () => {
  // Zo'n select kan deze scanner niet betrouwbaar lezen. Nul is de bedoeling;
  // komt er ooit één, dan hoort hij met de hand nagekeken te worden en niet
  // stil overgeslagen.
  assert.deepEqual(genest, []);
});

test('de dump dekt de elf tabellen die we lezen, inclusief de twee van 13 oktober', () => {
  for (const t of ['hlms_student', 'hlms_personeel', 'hlms_sessie', 'hlms_signaal',
                   'hlms_signaal_gebeurtenis', 'hlms_crm_stilte', 'hlms_crm_factuurstand',
                   'hlms_teamtraining', 'hlms_teamtraining_trainer',
                   'hlms_intake', 'hlms_sessie_taak']) {
    assert.ok(KOLOMMEN[t], `${t} staat niet in de dump`);
  }
});

test('hlms_student heeft geen `naam` en geen `product` — de twee namen waar je naast grijpt', () => {
  // voornaam/achternaam en product_soort. Een lezer die `naam` vraagt krijgt
  // een 400, en dat is precies de klasse fout van #1708.
  assert.ok(!KOLOMMEN.hlms_student.has('naam'));
  assert.ok(!KOLOMMEN.hlms_student.has('product'));
  assert.ok(KOLOMMEN.hlms_student.has('voornaam'));
  assert.ok(KOLOMMEN.hlms_student.has('product_soort'));
});

test('verwacht-bestand: geen tabel die al gemeten is, en elke tabel heeft een bron', () => {
  // Staat een tabel in de meting, dan hoort hij uit het verwacht-bestand: een
  // meting wint altijd van een verwachting.
  const dubbel = Object.keys(VERWACHT).filter((t) => DUMP[t]);
  assert.deepEqual(dubbel, [], `gemeten, dus weg uit hlms-kolommen-verwacht-lab.json: ${dubbel.join(', ')}`);
  for (const t of Object.keys(VERWACHT)) assert.ok(VERWACHT_RUW._bron?.[t], `${t} mist zijn bron`);
});
