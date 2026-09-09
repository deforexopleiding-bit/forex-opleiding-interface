// tests/onboarding-lms-backfill-geen-post.test.js
//
// BEWIJS dat de LMS-inhaalslag niets kan versturen.
//
// De inhaalslag raakt 22 echte klanten in één keer. De uitnodiging is een
// aparte beslissing van Maxim en die is nog niet genomen. "Er zit geen mail in"
// is dus geen geruststelling maar een eis, en een eis hoort gerekend te worden
// in plaats van beweerd.
//
// Deze test rekent de VOLLEDIGE import-afsluiting van
// api/cron/onboarding-lms-backfill.js uit — alles wat dat bestand
// rechtstreeks importeert, plus alles wat díé bestanden importeren, tot er
// niets nieuws meer bij komt — en toetst die verzameling op drie manieren:
//
//   1. geen enkel bestand uit de afsluiting staat op de lijst van modules die
//      in deze repo iets naar buiten kunnen sturen;
//   2. nergens in de afsluiting staat een verzend-woord (nodemailer, resend,
//      stuurLmsUitnodiging, createNotification, ...);
//   3. de inhaalslag doet niets zonder uitdrukkelijke bevestiging.
//
// De derde is er omdat een pad dat niets kan versturen nog steeds 22 rijen
// kan aanmaken op het verkeerde moment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const START = 'api/cron/onboarding-lms-backfill.js';

/**
 * De transitieve import-afsluiting van een bestand.
 *
 * Volgt ALLE relatieve imports, zowel `import ... from '...'` als
 * `await import('...')` — die tweede vorm bestaat in deze repo (zie
 * onboarding-spiegel.js) en zou anders een gat in het bewijs zijn.
 */
function importAfsluiting(startRelatief) {
  const gezien = new Set();
  const wachtrij = [startRelatief];

  // Zowel de statische als de dynamische vorm.
  const IMPORT_RE = /(?:^|\s)(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.[^'"]+)['"]/gm;

  while (wachtrij.length > 0) {
    const rel = wachtrij.pop();
    if (gezien.has(rel)) continue;
    gezien.add(rel);

    const pad = join(ROOT, rel);
    if (!existsSync(pad)) continue;
    const bron = readFileSync(pad, 'utf8');

    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(bron)) !== null) {
      const doel = resolve(dirname(pad), m[1]);
      const kort = doel.slice(ROOT.length + 1);
      const kandidaten = [kort, kort + '.js', join(kort, 'index.js')];
      for (const k of kandidaten) {
        if (existsSync(join(ROOT, k))) { wachtrij.push(k); break; }
      }
    }
  }
  return gezien;
}

// Elke module in deze repo die iets naar buiten kan sturen — mail, WhatsApp,
// een uitnodiging, een wachtwoord of een melding aan een mens. Opgezocht in
// de repo, niet uit het hoofd: alles wat nodemailer/resend/smtp aanraakt plus
// de uitnodigings- en credential-libs.
const KAN_IETS_VERSTUREN = [
  'api/_lib/send-email-core.js',
  'api/_lib/email.js',
  'api/_lib/sanne-send-mail.js',
  'api/_lib/events-send.js',
  'api/_lib/events-invite.js',
  'api/_lib/events-questionnaire-invite.js',
  'api/_lib/onboarding-invite.js',
  'api/_lib/onboarding-credentials.js',
  'api/_lib/dfo-lms-uitnodiging.js',
  'api/_lib/tl-invoice-send.js',
  'api/_lib/toegang-cron-mails.js',
  'api/_lib/mail-shell-afspraak.js',
  'api/_lib/comms-log.js',
  'api/_lib/events-automation-engine.js',
  'api/_lib/notify.js',
];

// Woorden die verraden dat er iets VERSTUURD wordt. Bewust ruim: liever een
// test die te vroeg piept dan een mail die te vroeg vertrekt.
//
// Eén woord staat hier BEWUST niet meer in, en dat verdient uitleg omdat het
// eruit is gehaald nadat de test erop afging. `uitnodiging` sloeg aan op
// `noteerUitnodiging()` in api/_lib/dfo-lms-student.js. Die functie verstuurt
// niets: hij schrijft de uitkomst van een uitnodiging weg in
// `onboardings.dfo_lms_provision_error` — één UPDATE in het CRM, meer niet.
// Hij zit in de afsluiting omdat het hele bestand erin zit, niet omdat de
// inhaalslag 'm aanroept.
//
// Het woord vervangen door "hij hoeft niet mee te tellen" zou de test
// verslappen tot hij groen is. Daarom is er iets sterkers voor in de plaats
// gekomen: BEWIJS 2b hieronder toetst of er in de hele afsluiting überhaupt
// een UITGAANDE VERBINDING gemaakt kan worden. Post verlaat het pand via
// fetch of een mail-bibliotheek; kan dat niet, dan kan er niets vertrekken —
// ongeacht welke woorden er in de bestandsnamen staan.
const VERZEND_WOORDEN = [
  'nodemailer', 'createTransport', 'sendgrid', 'resend', 'postmark', 'mailgun',
  'stuurLmsUitnodiging', 'sendInvite', 'send_invite',
  'createNotification', 'sendEmail', 'send-email', 'inbox-send',
  'credentials_email', 'credentials_wa',
];

// Alles waarmee je deze container kunt verlaten.
const UITGAANDE_VERBINDING = [
  'fetch(', 'axios', "require('http", 'from \'http', 'XMLHttpRequest',
];

const AFSLUITING = importAfsluiting(START);

test('de import-afsluiting is compleet en klein genoeg om te begrijpen', () => {
  // Als dit getal ineens explodeert, is er iets binnengehaald dat er niet
  // hoort. Een pad dat 22 klanten raakt hoort overzichtelijk te zijn.
  assert.ok(AFSLUITING.has(START), 'het startbestand hoort in zijn eigen afsluiting');
  assert.ok(AFSLUITING.size <= 8,
    'de afsluiting is gegroeid naar ' + AFSLUITING.size + ' bestanden: '
    + [...AFSLUITING].join(', ') + ' — kijk na wat erbij is gekomen');
});

test('BEWIJS 1: geen enkel verzend-bestand zit in de afsluiting', () => {
  const gevonden = KAN_IETS_VERSTUREN.filter((m) => AFSLUITING.has(m));
  assert.deepEqual(gevonden, [],
    'de inhaalslag haalt een module binnen die iets kan versturen: ' + gevonden.join(', '));
});

test('BEWIJS 2: nergens in de afsluiting staat een verzend-woord', () => {
  const treffers = [];
  for (const rel of AFSLUITING) {
    const bron = readFileSync(join(ROOT, rel), 'utf8');
    // Commentaarregels tellen niet mee: dit bestand en de inhaalslag PRATEN
    // over uitnodigingen om uit te leggen dat ze er niet in zitten.
    const code = bron.split('\n')
      .filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
      .join('\n');
    for (const woord of VERZEND_WOORDEN) {
      if (code.includes(woord)) treffers.push(rel + ' → ' + woord);
    }
  }
  assert.deepEqual(treffers, [],
    'er staat een verzend-woord in het pad van de inhaalslag:\n  ' + treffers.join('\n  '));
});

test('BEWIJS 2b: nergens in de afsluiting kan een uitgaande verbinding gemaakt worden', () => {
  // Dit is het sterkste van de reeks. Een mail, een uitnodiging of een
  // wachtwoord verlaat het pand via een netwerk-call. Zit er in het hele pad
  // geen enkele manier om er een te maken, dan kán er niets vertrekken —
  // hoe de functies ook heten.
  const treffers = [];
  for (const rel of AFSLUITING) {
    const bron = readFileSync(join(ROOT, rel), 'utf8');
    const code = bron.split('\n')
      .filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
      .join('\n');
    for (const woord of UITGAANDE_VERBINDING) {
      if (code.includes(woord)) treffers.push(rel + ' → ' + woord);
    }
  }
  assert.deepEqual(treffers, [],
    'er kan een uitgaande verbinding gemaakt worden vanuit het pad van de '
    + 'inhaalslag:\n  ' + treffers.join('\n  '));
});

test('TEGENBEWIJS: de uitnodigingsmodule kan dat WEL, en zit er dus niet in', () => {
  // Zonder dit is BEWIJS 2b niet te onderscheiden van een test die nergens
  // naar kijkt. De module die wél kan versturen moet aantoonbaar aanslaan.
  const bron = readFileSync(join(ROOT, 'api/_lib/dfo-lms-uitnodiging.js'), 'utf8');
  const code = bron.split('\n')
    .filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
    .join('\n');
  assert.ok(UITGAANDE_VERBINDING.some((w) => code.includes(w)),
    'de uitnodigingsmodule doet geen netwerk-call meer — dan meet BEWIJS 2b niets');
});

test('BEWIJS 3: de uitnodiging leeft in een bestand dat hier NIET bij zit', () => {
  // Het tegenbewijs: die module bestaat wel degelijk en kan wel degelijk
  // versturen. Hij zit alleen niet in dit pad. Zou iemand 'm er ooit bij
  // zetten, dan valt BEWIJS 1 om.
  const uitnodiging = 'api/_lib/dfo-lms-uitnodiging.js';
  assert.ok(existsSync(join(ROOT, uitnodiging)), 'de uitnodigingsmodule hoort te bestaan');
  assert.ok(!AFSLUITING.has(uitnodiging), 'de uitnodigingsmodule zit in het pad — dat mag niet');

  // En de enige plek die 'm wél gebruikt is de handmatige knop, met een
  // uitdrukkelijke opt-in.
  const knop = readFileSync(join(ROOT, 'api/onboarding-dfo-lms-provision.js'), 'utf8');
  assert.match(knop, /send_invite/,
    'de uitnodiging hoort achter een expliciete opt-in te zitten');
});

test('BEWIJS 4: provisionDfoLmsStudent zelf verstuurt niets', () => {
  // De enige schrijfactie in de inhaalslag. Deze functie maakt een rij aan in
  // hlms_student en raakt uitnodiging/wachtwoord uitdrukkelijk niet aan —
  // dat staat ook zo in de kop van dat bestand.
  const bron = readFileSync(join(ROOT, 'api/_lib/dfo-lms-student.js'), 'utf8');
  const code = bron.split('\n')
    .filter((r) => !r.trim().startsWith('//') && !r.trim().startsWith('*'))
    .join('\n');
  for (const woord of ['nodemailer', 'createTransport', 'sendgrid', 'resend',
                       'stuurLmsUitnodiging', 'createNotification']) {
    assert.ok(!code.includes(woord),
      'provisioning raakt ' + woord + ' aan — dat hoort in de uitnodigingsmodule');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Niets kunnen versturen is niet genoeg: hij mag ook niet per ongeluk lopen.
// ═══════════════════════════════════════════════════════════════════════════

const BACKFILL = readFileSync(join(ROOT, START), 'utf8');

test('BEWIJS 5: zonder ?uitvoeren=ja doet de inhaalslag NIETS', () => {
  assert.match(BACKFILL, /const wilUitvoeren = String\(req\.query\?\.uitvoeren \|\| ''\) === 'ja'/,
    'de droogloop is niet de standaard');
  assert.match(BACKFILL, /if \(!wilUitvoeren\) return res\.status\(200\)\.json\(result\)/,
    'er is geen harde uitgang vóór de schrijf-lus');
});

test('BEWIJS 6: uitvoeren vereist het getal uit de droogloop', () => {
  // Zo kan er niets veranderd zijn tussen kijken en doen, en kan niemand dit
  // aanzetten zonder eerst gekeken te hebben.
  assert.match(BACKFILL, /bevestigd !== result\.zou_aanmaken/,
    'het bevestigingsgetal wordt niet tegen de droogloop gehouden');
  assert.match(BACKFILL, /status\(409\)/,
    'een verkeerd bevestigingsgetal hoort te weigeren, niet door te lopen');
});

test('BEWIJS 7: een klant die op naam matcht met een ander adres wordt overgeslagen', () => {
  // De bekende klant die in beide systemen onder twee adressen staat. Op naam
  // matchen is raden; die rij gaat naar een mens.
  assert.match(BACKFILL, /naamTreffers/,
    'er wordt niet op naam-dubbelen gecontroleerd');
  assert.match(BACKFILL, /besluit = 'overslaan_naam_treffer'/,
    'een naam-treffer leidt niet tot overslaan');
  assert.match(BACKFILL, /if \(regel\.besluit !== 'zou_aanmaken'\) continue;/,
    'de schrijf-lus filtert niet op het besluit uit de droogloop');
});

test('de uitkomst zegt zelf dat er geen mail uitgaat', () => {
  // Zodat wie de JSON leest het niet hoeft te geloven op basis van een
  // commit-tekst die hij niet ziet.
  assert.match(BACKFILL, /verstuurt_mail: false/);
});
