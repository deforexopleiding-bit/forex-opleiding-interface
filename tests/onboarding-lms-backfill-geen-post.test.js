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
// DRIE startpunten: de gedeelde logica en allebei de ingangen. Het bewijs
// moet gelden voor elke weg waarlangs de inhaalslag kan lopen — de knop in
// het CRM net zo goed als het cron-pad.
const KERN   = 'api/_lib/onboarding-lms-backfill.js';
const KNOP   = 'api/onboarding-lms-backfill-run.js';
const CRON   = 'api/cron/onboarding-lms-backfill.js';
const START  = KERN;
const INGANGEN = [KERN, KNOP, CRON];

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

// De afsluiting van ALLE ingangen samen. Zou de knop iets binnenhalen dat
// het cron-pad niet heeft, dan valt dat hier op.
const AFSLUITING = new Set();
for (const ingang of INGANGEN) {
  for (const bestand of importAfsluiting(ingang)) AFSLUITING.add(bestand);
}

test('de import-afsluiting is compleet en klein genoeg om te begrijpen', () => {
  // Als dit getal ineens explodeert, is er iets binnengehaald dat er niet
  // hoort. Een pad dat 22 klanten raakt hoort overzichtelijk te zijn.
  for (const ingang of INGANGEN) {
    assert.ok(AFSLUITING.has(ingang), ingang + ' hoort in de afsluiting te zitten');
  }
  assert.ok(AFSLUITING.size <= 14,
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

const BACKFILL = readFileSync(join(ROOT, KERN), 'utf8');

test('BEWIJS 5: zonder ?uitvoeren=ja doet de inhaalslag NIETS', () => {
  // Bewust losjes op spaties, streng op de betekenis: uitvoeren moet uit een
  // expliciete parameter komen, en er moet een harde uitgang staan vóór er
  // ook maar iets geschreven wordt.
  assert.match(BACKFILL, /wilUitvoeren\s*=\s*opties\.uitvoeren === true/,
    'uitvoeren staat niet standaard uit');
  assert.match(BACKFILL, /if \(!wilUitvoeren\) return \{ status: 200, result \}/,
    'er is geen harde uitgang vóór de schrijf-lus');

  // En die uitgang moet ECHT vóór de lus staan, niet erna.
  const iUitgang = BACKFILL.indexOf('if (!wilUitvoeren) return { status: 200, result }');
  const iLus     = BACKFILL.indexOf('for (const regel of result.rijen)');
  assert.ok(iUitgang > -1 && iLus > -1 && iUitgang < iLus,
    'de uitgang staat niet vóór de schrijf-lus');
});

test('BEWIJS 6: uitvoeren vereist BEIDE getallen uit de droogloop', () => {
  // Twee getallen, want koppelen en aanmaken zijn verschillende acties met
  // een verschillend risico. Zo kan er niets veranderd zijn tussen kijken en
  // doen, en kan niemand dit aanzetten zonder eerst gekeken te hebben.
  assert.match(BACKFILL, /bevestigKoppel === result\.zou_koppelen/,
    'het koppel-getal wordt niet tegen de droogloop gehouden');
  assert.match(BACKFILL, /bevestigMaak\s+=== result\.zou_aanmaken/,
    'het aanmaak-getal wordt niet tegen de droogloop gehouden');
  assert.match(BACKFILL, /status: 409/,
    'een verkeerd bevestigingsgetal hoort te weigeren, niet door te lopen');
});

test('BEWIJS 7: een klant die op naam matcht met een ander adres wordt overgeslagen', () => {
  // De bekende klant die in beide systemen onder twee adressen staat. Op naam
  // matchen is raden; die rij gaat naar een mens.
  assert.match(BACKFILL, /naamTreffers/,
    'er wordt niet op naam-dubbelen gecontroleerd');
  assert.match(BACKFILL, /besluit = 'overslaan_naam_treffer'/,
    'een naam-treffer leidt niet tot overslaan');
  // De schrijf-lus mag UITSLUITEND op de twee doe-besluiten afgaan. Alles wat
  // de droogloop heeft overgeslagen blijft overgeslagen.
  assert.match(BACKFILL, /if \(!koppelen && !maken\) continue;/,
    'de schrijf-lus filtert niet op het besluit uit de droogloop');
  assert.match(BACKFILL, /const koppelen = regel\.besluit === 'zou_koppelen'/);
  assert.match(BACKFILL, /const maken\s+= regel\.besluit === 'zou_aanmaken'/);
});

test('de uitkomst zegt zelf dat er geen mail uitgaat', () => {
  // Zodat wie de JSON leest het niet hoeft te geloven op basis van een
  // commit-tekst die hij niet ziet.
  assert.match(BACKFILL, /verstuurt_mail: false/);
});


// ═══════════════════════════════════════════════════════════════════════════
// TESTRIJEN. Dit is geen theoretisch randgeval: de testonboarding op
// maxim.delombaerde96+onbtest@gmail.com stond in de eerste versie gewoon
// tussen de kandidaten — terwijl we die LMS-rij diezelfde ochtend juist
// hadden opgeruimd. Zonder filter had de inhaalslag 'm meteen opnieuw
// aangemaakt. Vandaar drie tests in plaats van één.
// ═══════════════════════════════════════════════════════════════════════════

test('TESTRIJEN 1: de onboarding-selectie sluit is_test uit', () => {
  assert.match(BACKFILL, /\.eq\('is_test', false\)/,
    'de kandidaten-query filtert niet op onboardings.is_test');
});

test('TESTRIJEN 2: ook een testKLANT wordt uitgesloten', () => {
  // Een echte onboarding op een testklant is net zo goed een testrij. De
  // vlag staat op beide tabellen (migratie 036 voor customers,
  // onboardings sinds api/onboarding-counts.js:95).
  assert.match(BACKFILL, /select\('id, first_name, last_name, email, is_test'\)/,
    'de klanten-query haalt is_test niet op');
  assert.match(BACKFILL, /klant\?\.is_test === true\)\s*besluit = 'overslaan_testrij'/,
    'een testklant leidt niet tot overslaan');
});

test('TESTRIJEN 3: de testrij-check staat VOOR alle andere besluiten', () => {
  // Volgorde doet ertoe: zou 'zou_koppelen' eerder staan, dan koppelt hij
  // een testonboarding alsnog aan een bestaande rij.
  const blok = BACKFILL.slice(BACKFILL.indexOf('let besluit;'));
  const iTest    = blok.indexOf("'overslaan_testrij'");
  const iKoppel  = blok.indexOf("'zou_koppelen'");
  const iMaak    = blok.indexOf("'zou_aanmaken'");
  assert.ok(iTest > -1, 'er is geen testrij-tak');
  assert.ok(iTest < iKoppel && iTest < iMaak,
    'de testrij-check staat niet als eerste — dan glipt een testrij er alsnog door');
});

// ═══════════════════════════════════════════════════════════════════════════
// KOPPELEN IS IETS ANDERS DAN AANMAKEN
// ═══════════════════════════════════════════════════════════════════════════

const STUDENT_LIB = readFileSync(join(ROOT, 'api/_lib/dfo-lms-student.js'), 'utf8');

test('KOPPELEN 1: een bestaande rij op e-mail wordt GEKOPPELD, niet overgeslagen', () => {
  // Zestien van de tweeëntwintig zitten in dit geval. Ze overslaan zou
  // betekenen dat het mentorblok voor die zestien leeg blijft.
  assert.match(BACKFILL, /else if \(alOpEmail\)\s+besluit = 'zou_koppelen'/,
    'een bestaande rij op e-mail leidt niet tot koppelen');
  assert.match(BACKFILL, /koppelBestaandeStudent\(regel\.onboarding_id, regel\.bestaat_op_email\)/,
    'er wordt niet daadwerkelijk gekoppeld');
});

test('KOPPELEN 2: de logregel zegt WELKE van de twee er gebeurd is', () => {
  assert.match(BACKFILL, /GEKOPPELD/, 'de logregel onderscheidt koppelen niet');
  assert.match(BACKFILL, /AANGEMAAKT/, 'de logregel onderscheidt aanmaken niet');
  assert.match(BACKFILL, /gekoppeld aan bestaande rij/);
  assert.match(BACKFILL, /nieuwe studentrij aangemaakt/);
  // En apart geteld, niet op één hoop.
  assert.match(BACKFILL, /zou_koppelen: 0, gekoppeld: 0/);
  assert.match(BACKFILL, /zou_aanmaken: 0, aangemaakt: 0/);
});

test('KOPPELEN 3: koppelen raakt PRECIES één kolom aan', () => {
  // Naam, traject en aantal calls van die zestien komen uit de
  // Bubble-migratie en mogen niet met CRM-waarden overschreven worden.
  const fn = STUDENT_LIB.slice(STUDENT_LIB.indexOf('export async function koppelBestaandeStudent'));
  const einde = fn.indexOf('\n}\n');
  const body = fn.slice(0, einde);
  const update = body.slice(body.indexOf('.update('));
  assert.match(update, /\.update\(\{ crm_onboarding_id: onboardingId \}\)/,
    'koppelen schrijft meer dan crm_onboarding_id');
  for (const verboden of ['voornaam', 'achternaam', 'traject_maanden', 'calls_totaal',
                          'mentor_id', 'product_soort', 'start_datum', 'eind_datum']) {
    assert.ok(!update.includes(verboden),
      'koppelen raakt ' + verboden + ' aan — dat is een Bubble-waarde en die blijft staan');
  }
});

test('KOPPELEN 4: koppelen kapt geen rij die aan een ANDERE onboarding hangt', () => {
  const fn = STUDENT_LIB.slice(STUDENT_LIB.indexOf('export async function koppelBestaandeStudent'));
  assert.match(fn, /rij\.crm_onboarding_id !== onboardingId/,
    'er is geen bescherming tegen het kapen van een gekoppelde rij');
});

test('KOPPELEN 5: de mentor-vraag wordt gemeld, niet stilletjes beantwoord', () => {
  // Bij koppelen blijft een LMS-rij zonder mentor zonder mentor, ook als het
  // CRM er wél een weet. Dat hoort zichtbaar te zijn in de droogloop zodat
  // een mens erover beslist.
  assert.match(BACKFILL, /lms_mentor_leeg/);
  assert.match(BACKFILL, /crm_kent_mentor/);
});


// ═══════════════════════════════════════════════════════════════════════════
// DE KNOP. Maxim werkt met knoppen, niet met een geheim in een terminal.
// Maar een knop mag niet losser zijn dan het cron-pad — daarom deze reeks.
// ═══════════════════════════════════════════════════════════════════════════

const KNOP_BRON = readFileSync(join(ROOT, KNOP), 'utf8');
const CRON_BRON = readFileSync(join(ROOT, CRON), 'utf8');

test('KNOP 1: er is één implementatie, twee dunne ingangen', () => {
  // Zou de knop zijn eigen kopie van de logica krijgen, dan kunnen de twee
  // uit elkaar lopen — en dan bewaakt het post-bewijs op de kern maar de
  // helft.
  for (const [naam, bron] of [['knop', KNOP_BRON], ['cron', CRON_BRON]]) {
    assert.match(bron, /draaiLmsBackfill\(/, naam + ' roept de gedeelde logica niet aan');
    assert.ok(!/\.from\('onboardings'\)/.test(bron),
      naam + ' bevraagt onboardings zelf — dat hoort in de kern te staan');
    assert.ok(!/provisionDfoLmsStudent|koppelBestaandeStudent/.test(bron),
      naam + ' schrijft zelf naar het LMS — dat hoort in de kern te staan');
  }
});

test('KNOP 2: sessie + dezelfde rechtencontrole als de andere adminschermen', () => {
  assert.match(KNOP_BRON, /createUserClient\(req\)/, 'de knop leest geen user-sessie');
  assert.match(KNOP_BRON, /auth\.getUser\(\)/);
  assert.match(KNOP_BRON, /status\(401\)/, 'niet-ingelogd levert geen 401');
  assert.match(KNOP_BRON, /requirePermission\(req, 'students\.all\.view'\)/,
    'de knop gebruikt niet dezelfde rechtensleutel als het studentenoverzicht');
  assert.match(KNOP_BRON, /status\(403\)/, 'zonder recht levert het geen 403');
});

test('KNOP 3: alleen POST — een link kan dit niet per ongeluk aanroepen', () => {
  assert.match(KNOP_BRON, /req\.method !== 'POST'/);
  assert.match(KNOP_BRON, /status\(405\)/);
});

test('KNOP 4: uitvoeren vereist ook hier de twee getallen uit de droogloop', () => {
  // De grendel zit in de kern, dus hij geldt voor beide ingangen. De knop
  // geeft de getallen alleen door; hij kan ze niet omzeilen.
  assert.match(KNOP_BRON, /uitvoeren:\s*body\.uitvoeren === true/,
    'uitvoeren komt niet uit een expliciete vlag in de body');
  assert.match(KNOP_BRON, /bevestigKoppel:\s*Number\(body\.koppelen\)/);
  assert.match(KNOP_BRON, /bevestigMaak:\s*Number\(body\.aanmaken\)/);
});

test('KNOP 5: wie er drukte belandt in de logregel', () => {
  // Twintig echte klanten aanraken hoort een naam te hebben.
  assert.match(KNOP_BRON, /door\s*=\s*user\.id/);
  assert.match(KNOP_BRON, /prof\?\.email/);
  assert.match(BACKFILL, /\[lms-backfill\/' \+ door \+ '\]/,
    'de logregel draagt niet wie de actie deed');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SCHERM
// ═══════════════════════════════════════════════════════════════════════════

const HUB = readFileSync(join(ROOT, 'modules/onboarding-hub.html'), 'utf8');

test('SCHERM 1: uitvoeren kan niet zonder dat de droogloop iets getoond heeft', () => {
  // Drie sloten op een rij: de knop staat uit tot er een droogloop is, de
  // klik-afhandeling weigert zonder droogloop, en de server eist de twee
  // getallen. Het derde is de echte grendel; de eerste twee zijn zodat je er
  // niet tegenaan loopt.
  assert.match(HUB, /id="obLmsUitvoeren"[^>]*disabled/,
    'de uitvoer-knop staat niet standaard uit');
  assert.match(HUB, /if \(uitvoeren && !_lmsDroogloop\)/,
    'de klik-afhandeling laat uitvoeren zonder droogloop toe');
  assert.match(HUB, /koppelen: _lmsDroogloop\.zou_koppelen/,
    'de getallen komen niet uit de droogloop');
});

test('SCHERM 2: na uitvoeren is de droogloop verlopen', () => {
  // Anders kun je twee keer achter elkaar uitvoeren op oude getallen. De
  // server zou dat alsnog met 409 weigeren, maar dan lees je een foutmelding
  // in plaats van een duidelijke knop.
  assert.match(HUB, /_lmsDroogloop = null;/);
});

test('SCHERM 3: de uitkomst toont PER KLANT wat er gebeurd is, ook bij mislukking', () => {
  // Niet een totaalgetal dat alleen telt wat gelukt is.
  assert.match(HUB, /r\.uitkomst \|\| LMS_LABEL\[r\.besluit\]/,
    'de tabel toont de per-klant-uitkomst niet');
  assert.match(HUB, /mislukt = \/mislukt\/i\.test/,
    'een mislukte rij wordt niet als mislukt herkend');
  // Op INHOUD toetsen, niet op de letterlijke uitdrukking. De `|| 0` die hier
  // eerst stond is er met opzet uit: bij een mislukte ronde is er NIETS
  // geteld en hoort er een streepje te staan in plaats van een 0 — vier keer
  // nul plus een foutregel ziet er identiek uit als een geslaagde droogloop
  // op een lege lijst. Dat gedrag wordt echt uitgevoerd en nagekeken in
  // tests/onboarding-hub-frontend.test.js (TELLERS); hier borgen we alleen
  // dat de teller überhaupt in de samenvatting staat.
  assert.match(HUB, /tel\(d\.mislukt,\s*'mislukt'\)/,
    'het aantal mislukkingen staat niet in de samenvatting');
});

test('SCHERM 4: de sectie is gegate op dezelfde sleutel als de server', () => {
  assert.match(HUB, /canSync\('students\.all\.view'\)/,
    'de tab wordt niet op students.all.view getoond');
  assert.match(HUB, /id="obTabLms"[^>]*style="display:none"/,
    'de tab staat niet standaard verborgen');
});

test('SCHERM 5: het scherm zegt dat er geen mail uitgaat', () => {
  assert.match(HUB, /geen enkele mail uit/i);
});
