// tests/opvolging-lijstfilter.test.js
//
// ELKE SELECT OP opvolging_taken KIEST BEWUST EEN LIJST.
//
// Sinds 2 oktober 2026 staan er twee lijsten in opvolging_taken: Daves
// daglijst (lijst 'dag') en de leadkaarten van 'Leads bellen' (lijst 'leads').
// De leadkaarten mogen NERGENS in Daves bestaande schermen opduiken: Vandaag,
// weekbalk, Later, Nu-doen, Dashboard, Afgerond, Salesrapport, gezondheid,
// call-rapport.
//
// In deze module is 'fix op één plek, afgeleide telling vergeten' al drie keer
// gebeurd. Daarom geen afspraak maar een toets: elke lezing op opvolging_taken
// in api/ noemt de lijst (alleenDaglijst / alleenLeadlijst / .eq('lijst', …) /
// de kolom 'lijst' in de select), leest op id, of staat hieronder in de
// whitelist MET de reden waarom hij beide lijsten leest.
//
// Een nieuwe select zonder lijst laat deze toets falen. Dat is de bedoeling:
// kies dan bewust — of de nieuwe lezing hoort bij de daglijst (meestal), of
// hij moet beide zien en dan komt hij hier op de lijst met een reden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Wat bewust BEIDE lijsten leest, en waarom. */
const BEIDE_LIJSTEN = Object.freeze({
  'api/cron-opvolging-wacht-check.js': 'de 48-uurcontrole geldt voor daglijst én leadkaarten (eigen terugkeer-vorm per lijst)',
  'api/cron-opvolging-doorrol.js'    : 'de nachtelijke doorrol rolt ook leadkaarten door naar vandaag',
  'api/opvolging-whatsapp-nummers.js': 'de brug moet ook de nummers van leadkaarten kennen, anders kan er niets verstuurd worden',
  'api/opvolging-whatsapp-webhook.js': 'zoekTaak koppelt een bericht aan de kaart van dat nummer, op welke lijst ook',
  'api/softphone-call-log.js'        : 'een belpoging hoort bij de kaart die gebeld werd, ook een leadkaart',
  'api/opvolging-taak-update.js'     : 'werkt op één kaart (op id), beide lijsten',
  'api/opvolging-agenda.js'          : 'boeken werkt op één kaart (op id); de afrond-lezingen filteren zelf op dag',
  'api/opvolging-poging.js'          : 'een poging hoort bij één kaart (op id)',
  'api/_lib/opvolging-meta.js'       : 'een Meta-antwoord telt als contact op de lopende kaart van dat nummer, op welke lijst ook',
  'api/_lib/inbox-categorie.js'      : 'inbox-label Leadsonderhoud: een lopende opvolgtaak op welke lijst ook betekent dat iemand in een opvolgtraject zit',
});

function alleJsBestanden(map) {
  const uit = [];
  for (const naam of readdirSync(map)) {
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) uit.push(...alleJsBestanden(pad));
    else if (naam.endsWith('.js')) uit.push(pad);
  }
  return uit;
}

/** Elke lezing op opvolging_taken, met het stuk code eromheen. */
export function vindLezingen(bron) {
  const uit = [];
  // `.from('opvolging_taken')` en hulpjes als safeCount('opvolging_taken', …).
  const re = /\(\s*['"]opvolging_taken['"]\s*[,)]/g;
  let m;
  while ((m = re.exec(bron))) {
    const begin = m.index;
    // Terug tot het begin van de uitdrukking: de helper staat ervóór
    // (alleenDaglijst(supabaseAdmin.from(...))). Stop bij ; of { of }.
    let a = begin;
    let stap = 0;
    while (a > 0 && stap < 160 && !';{}'.includes(bron[a - 1])) { a -= 1; stap += 1; }
    // Vooruit tot het einde van de keten: ; of de volgende .from(.
    let e = bron.indexOf(';', begin);
    if (e < 0) e = bron.length;
    for (const naald of ['.from(', 'safeCount(']) {
      const volgende = bron.indexOf(naald, begin + 6);
      if (volgende > 0 && volgende < e) e = volgende;
    }
    const stuk = bron.slice(a, e);
    const regel = bron.slice(0, begin).split('\n').length;
    uit.push({ regel, stuk });
  }
  return uit;
}

export function isLezing(stuk) {
  if (/\.(insert|update|upsert|delete)\(/.test(stuk)) return false;
  // safeCount('opvolging_taken', (q) => …) telt ook: dat is een count-select.
  return /\.select\(|safeCount\(/.test(stuk);
}

export function kiestLijst(stuk) {
  if (/lijst/i.test(stuk)) return true;
  // Op id: één kaart, die lijst doet er niet toe.
  if (/\.eq\(\s*['"]id['"]/.test(stuk)) return true;
  return false;
}

test('elke select op opvolging_taken in api/ kiest bewust een lijst', () => {
  const fout = [];
  for (const pad of alleJsBestanden(join(ROOT, 'api'))) {
    const rel = relative(ROOT, pad).split('\\').join('/');
    const bron = readFileSync(pad, 'utf8');
    if (!bron.includes('opvolging_taken')) continue;
    if (Object.prototype.hasOwnProperty.call(BEIDE_LIJSTEN, rel)) continue;
    for (const { regel, stuk } of vindLezingen(bron)) {
      if (!isLezing(stuk)) continue;
      if (!kiestLijst(stuk)) fout.push(`${rel}:${regel}`);
    }
  }
  assert.deepEqual(fout, [],
    'Deze lezingen op opvolging_taken noemen geen lijst. Filter op de daglijst ' +
    '(alleenDaglijst uit api/_lib/opvolging-lijst.js), of zet het bestand met een ' +
    'reden in BEIDE_LIJSTEN:\n  ' + fout.join('\n  '));
});

test('de whitelist is niet verouderd: elk bestand bestaat en leest opvolging_taken', () => {
  for (const [rel, reden] of Object.entries(BEIDE_LIJSTEN)) {
    assert.ok(reden.length > 20, rel + ': de reden hoort er echt te staan');
    const bron = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(/\.from\(\s*['"]opvolging_taken['"]\s*\)/.test(bron), rel + ' leest opvolging_taken niet meer — haal hem van de lijst');
  }
});

test('de scanner zelf: herkent een select zonder lijst, en laat de helper door', () => {
  const zonder = "const { data } = await supabaseAdmin.from('opvolging_taken').select('*').eq('status','open');";
  const met = "const { data } = await alleenDaglijst(supabaseAdmin.from('opvolging_taken').select('*')).eq('status','open');";
  const opId = "const { data } = await supabaseAdmin.from('opvolging_taken').select('*').eq('id', x).maybeSingle();";
  const schrijf = "await supabaseAdmin.from('opvolging_taken').update({ a: 1 }).eq('status','open').select();";
  const [l1] = vindLezingen(zonder); const [l2] = vindLezingen(met);
  const [l3] = vindLezingen(opId); const [l4] = vindLezingen(schrijf);
  assert.equal(isLezing(l1.stuk) && !kiestLijst(l1.stuk), true);
  assert.equal(kiestLijst(l2.stuk), true);
  assert.equal(kiestLijst(l3.stuk), true);
  assert.equal(isLezing(l4.stuk), false);
});

test('de daglijst-endpoints gebruiken de gedeelde helper (één plek, geen losse strings)', () => {
  for (const rel of ['api/opvolging-dag.js', 'api/opvolging-taken.js', 'api/opvolging-weekbalk.js', 'api/opvolging-rapport.js']) {
    const bron = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(bron, /alleenDaglijst\(/, rel + ' hoort alleenDaglijst te gebruiken');
  }
  // En de pogingen-tellingen van die schermen filteren mee: anders tellen de
  // belpogingen van Leads bellen in Daves dekking en weekbalk.
  for (const rel of ['api/opvolging-dag.js', 'api/opvolging-weekbalk.js', 'api/opvolging-rapport.js']) {
    const bron = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(bron, /pogingenAlleenDaglijst\(/, rel + ' hoort de pogingen op de daglijst te filteren');
  }
});
