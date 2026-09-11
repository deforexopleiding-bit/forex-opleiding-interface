// tests/inbox-unread-gelezen-blijft-gelezen.test.js
//
// GELEZEN BLIJFT GELEZEN.
//
// Maxim opende een gesprek, las het, en daarna stond het nog steeds op
// ongelezen. Gemeten op 11 september 2026 over alle 191 gesprekken in de
// finance-inbox: 17 met een badge, en bij VIJF daarvan stond `unread_count`
// op 0 terwijl `email_unread_count` boven nul stond — Jaroslav Balog, Nadia
// Van den Broeck, Tom Op t Eynde, Samantha Audrit (2 mails) en Rachael Njoki.
// Half gemarkeerd: de WhatsApp-helft ging netjes uit, de e-mailhelft bleef
// branden, en de badge is de som van de twee.
//
// Twee oorzaken, allebei hier vastgelegd:
//
//   1. HET AUTO-PAD NAM DE VERKEERDE ROUTE. Bij het openen ging de e-mail via
//      /api/email-actions {action:'mark-read'}, en dat endpoint schrijft een
//      rij in de audit-tabel `email_actions` — het raakt IMAP niet aan,
//      terwijl de badge juist met de \Seen-vlag op IMAP rekent. De knop was
//      hier al voor gerepareerd; het openen niet. Het commentaar in de view
//      beschreef de juiste route al sinds v=25.
//
//   2. DE VERVERSING DRAAIDE HET TERUG. De lijst ververst elke 6 seconden.
//      Een verversing die vóór het markeren begon levert data van vóór het
//      markeren, en die overschreef de nul weer. Dat is waarom het als een
//      glitch voelde en niet als kapot.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Laadt shared/inbox-unread.js met een nep-window (plain script, geen ESM). */
function laadHelper() {
  const src = readFileSync(join(ROOT, 'modules/klanten-v2/shared/inbox-unread.js'), 'utf8');
  const root = {};
  new Function('window', src)(root);
  assert.ok(root.WbxInboxUnread, 'shared/inbox-unread.js hoort window.WbxInboxUnread te zetten');
  return root.WbxInboxUnread;
}

const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/wanbetalers-v2.js'), 'utf8');

// ── 1. Beide paden delen hetzelfde endpoint ──────────────────────────

test('het auto-pad bij openen gebruikt email-actions NIET meer', () => {
  assert.doesNotMatch(
    VIEW, /email-actions'[^)]*action: *'mark-read'/,
    'email-actions mark-read schrijft alleen een auditrij en raakt IMAP niet aan',
  );
});

test('openen en de knop lopen allebei via _wbxMarkConversationRead', () => {
  const aanroepen = VIEW.match(/_wbxMarkConversationRead\(/g) || [];
  assert.ok(aanroepen.length >= 3,
    `verwacht: definitie + auto-pad + knop, gevonden ${aanroepen.length}`);
  assert.match(VIEW, /_wbxMarkConversationRead\(convId, \{ stil: true \}\)/,  'auto-pad');
  assert.match(VIEW, /_wbxMarkConversationRead\(convId, \{ stil: false \}\)/, 'knop');
});

test('die ene functie raakt beide kanalen aan', () => {
  const i = VIEW.indexOf('async function _wbxMarkConversationRead');
  const blok = VIEW.slice(i, i + 2600);
  assert.match(blok, /\/api\/inbox-mark-read/,       'WhatsApp-kant');
  assert.match(blok, /\/api\/inbox-email-mark-read/, 'e-mail-kant, via IMAP');
});

test('geen enkele markeer-aanroep gooit zijn fout nog weg', () => {
  assert.doesNotMatch(VIEW, /apiPost\('\/api\/inbox-mark-read'[^;]*\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(VIEW, /apiPost\('\/api\/inbox-email-mark-read'[^;]*\.catch\(\(\) => \{\}\)/);
});

// ── 2. De tellers ────────────────────────────────────────────────────

test('gelezen zet beide kanalen op nul — niet alleen WhatsApp', () => {
  const U = laadHelper();
  const p = U.gelezenPatch();
  assert.deepEqual(p, { unread_count: 0, email_unread_count: 0, total_unread: 0 });
});

test('de vijf gemeten gesprekken vallen stil zodra beide kanalen meegaan', () => {
  const U = laadHelper();
  const gemeten = [
    { naam: 'Jaroslav Balog',       unread_count: 0, email_unread_count: 1 },
    { naam: 'Nadia Van den Broeck', unread_count: 0, email_unread_count: 1 },
    { naam: 'Tom Op t Eynde',       unread_count: 0, email_unread_count: 1 },
    { naam: 'Samantha Audrit',      unread_count: 0, email_unread_count: 2 },
    { naam: 'Rachael Njoki',        unread_count: 0, email_unread_count: 1 },
  ];
  for (const row of gemeten) {
    const r = { ...row, total_unread: row.unread_count + row.email_unread_count };
    assert.ok(U.badge(r) > 0, `${row.naam} had een badge`);
    U.pasToe(r, U.gelezenPatch());
    assert.equal(U.badge(r), 0, `${row.naam} hoort na markeren uit te staan`);
  }
});

test('ongelezen is WhatsApp-only en laat de e-mailteller staan', () => {
  const U = laadHelper();
  // Samantha: 2 ongelezen mails, 0 WhatsApp. Vroeger zette de optimistische
  // update email_unread_count op 1 en sprong de badge daarna terug naar de
  // echte waarde. Nu blijft de mailteller precies zoals hij is.
  const r = { unread_count: 0, email_unread_count: 2, total_unread: 2 };
  U.pasToe(r, U.ongelezenPatch(r));
  assert.equal(r.unread_count, 1);
  assert.equal(r.email_unread_count, 2, 'de e-mailteller wordt niet vervalst');
  assert.equal(r.total_unread, 3);
});

test('ongelezen op een gesprek zonder mails geeft gewoon 1', () => {
  const U = laadHelper();
  const r = { unread_count: 0, email_unread_count: 0, total_unread: 0 };
  U.pasToe(r, U.ongelezenPatch(r));
  assert.equal(r.total_unread, 1);
});

// ── 3. De volgorde: openen → markeren → verversen ────────────────────

test('DE GLITCH: een verversing die al onderweg was zet de badge niet terug', () => {
  const U = laadHelper();
  const intenties = {};

  // t=0   de poll begint (de server weet nog van niets)
  const fetchStart = 1_000;
  // t=1s  gebruiker opent het gesprek en het wordt gemarkeerd
  U.onthoud(intenties, 'conv-1', U.gelezenPatch(), 2_000);
  // t=2s  het antwoord van die poll komt binnen, met de OUDE waarde
  const vanServer = [{ id: 'conv-1', unread_count: 0, email_unread_count: 1, total_unread: 1 }];

  const na = U.applyServerRows(vanServer, fetchStart, intenties, 3_000);
  assert.equal(U.badge(na[0]), 0, 'de badge hoort uit te blijven');
});

test('een verversing die NA het markeren begon is wél leidend', () => {
  const U = laadHelper();
  const intenties = {};
  U.onthoud(intenties, 'conv-1', U.gelezenPatch(), 2_000);

  // Deze fetch begon ná het markeren, dus een badge betekent nieuwe post.
  const na = U.applyServerRows(
    [{ id: 'conv-1', unread_count: 1, email_unread_count: 0, total_unread: 1 }],
    5_000, intenties, 6_000,
  );
  assert.equal(U.badge(na[0]), 1, 'een nieuw bericht moet gewoon doorkomen');
  assert.equal(Object.keys(intenties).length, 0, 'de intentie is opgeruimd');
});

test('een intentie verloopt, zodat niets voorgoed op gelezen blijft hangen', () => {
  const U = laadHelper();
  const intenties = {};
  U.onthoud(intenties, 'conv-1', U.gelezenPatch(), 1_000);
  U.applyServerRows([], 500, intenties, 1_000 + U.LEEFTIJD_MS + 1);
  assert.equal(Object.keys(intenties).length, 0);
});

test('een mislukte aanroep vergeet de intentie, zodat de server weer wint', () => {
  const U = laadHelper();
  const intenties = {};
  U.onthoud(intenties, 'conv-1', U.gelezenPatch(), 2_000);
  U.vergeet(intenties, 'conv-1');

  const na = U.applyServerRows(
    [{ id: 'conv-1', unread_count: 0, email_unread_count: 1, total_unread: 1 }],
    1_000, intenties, 3_000,
  );
  assert.equal(U.badge(na[0]), 1, 'na een mislukking hoort de badge terug te komen');
});

test('een gesprek zonder intentie blijft ongemoeid', () => {
  const U = laadHelper();
  const na = U.applyServerRows(
    [{ id: 'conv-2', unread_count: 3, email_unread_count: 0, total_unread: 3 }],
    1_000, {}, 2_000,
  );
  assert.equal(U.badge(na[0]), 3);
});

// ── 4. De view gebruikt die bescherming ook echt ─────────────────────

test('de lijst-fetch legt de serverrijen door applyServerRows heen', () => {
  assert.match(VIEW, /const fetchStartMs = Date\.now\(\)/);
  assert.match(VIEW, /applyServerRows\(rows, fetchStartMs, _ui\.inbox\.unreadIntents/);
});

test('bij een mislukking wordt de badge teruggezet', () => {
  const i = VIEW.indexOf('async function _wbxMarkConversationRead');
  const blok = VIEW.slice(i, i + 2600);
  assert.match(blok, /if \(!waResp\.ok \|\| !mailResp\.ok\)/);
  assert.match(blok, /vergeet\(_ui\.inbox\.unreadIntents/);
  assert.match(blok, /_toast\(`Markeren als gelezen mislukt/);
});

// ── 5. De poll die TIJDENS het schrijven begint ──────────────────────
//
// Maxim vond dit bij het nalezen van de diff, en hij had gelijk. Het stempel
// stond vóór de twee POSTs. Daarmee draagt de intentie het moment waarop het
// schrijven BEGON, terwijl hij hoort te dragen vanaf wanneer de server de
// nieuwe stand kent. Een verversing die tussen die twee momenten begint, haalt
// data op die het markeren nog niet bevat — en wint, want `at > fetchStartMs`
// is dan onwaar. De badge ging uit, weer aan, en anderhalve seconde later door
// de reconcile weer uit. Niet blijvend fout, wél precies de flikkering die we
// hier aan het opruimen zijn.
//
// De klok in deze tests, in milliseconden:
//
//   t=1     klik; eerste stempel
//   t=2     de poll vertrekt  (fetchStartMs = 2)
//   t=2,5   de server verwerkt het markeren
//   t=3     het pollantwoord komt binnen, met de oude waarde
//
// Het antwoord van t=3 is niet fout — het is gewoon ouder dan het lijkt.

/**
 * Speelt die volgorde af zoals de view hem uitvoert.
 * @param {boolean} herStempelen zet het tweede stempel (de fix)
 */
function speelVolgordeAf(U, herStempelen) {
  const intenties = {};
  const patch     = U.gelezenPatch();
  const rij       = { id: 'conv-1', unread_count: 0, email_unread_count: 1, total_unread: 1 };

  U.onthoud(intenties, 'conv-1', patch, 1);   // klik
  U.pasToe(rij, patch);                       // optimistisch uit beeld

  const fetchStartMs = 2;                     // de poll vertrekt tijdens het schrijven
  const vanServer    = [{ id: 'conv-1', unread_count: 0, email_unread_count: 1, total_unread: 1 }];

  if (herStempelen) U.onthoud(intenties, 'conv-1', patch, 2.5);  // beide responses ok

  const na = U.applyServerRows(vanServer, fetchStartMs, intenties, 3);
  return U.badge(na[0]);
}

test('een poll die tijdens het schrijven vertrekt zet de badge niet terug', () => {
  const U = laadHelper();
  assert.equal(speelVolgordeAf(U, true), 0,
    'na het her-stempelen hoort de badge uit te blijven');
});

test('zonder het tweede stempel flikkert hij — daarom staat die regel er', () => {
  const U = laadHelper();
  assert.equal(speelVolgordeAf(U, false), 1,
    'dit is de fout die het her-stempelen verhelpt; faalt deze test niet meer, '
    + 'dan is de bescherming ergens anders vandaan gekomen en mag dit weg');
});

test('markeren als gelezen stempelt opnieuw nadat beide responses ok zijn', () => {
  const i    = VIEW.indexOf('async function _wbxMarkConversationRead');
  const eind = VIEW.indexOf('function _wbxScheduleUnreadReconcile');
  const blok = VIEW.slice(i, eind);

  const naCheck = blok.slice(blok.indexOf('if (!waResp.ok || !mailResp.ok)'));
  assert.match(naCheck, /onthoud\(_ui\.inbox\.unreadIntents, convId, patch, Date\.now\(\)\)/,
    'het stempel van vóór de POSTs draagt het verkeerde moment; er hoort er één ná te staan');

  const stempels = blok.match(/onthoud\(_ui\.inbox\.unreadIntents/g) || [];
  assert.equal(stempels.length, 2, 'precies twee: één bij de klik, één na de bevestiging');
});

test('markeren als ongelezen doet hetzelfde', () => {
  const i    = VIEW.indexOf('window.__wbxInboxMarkUnread');
  const eind = VIEW.indexOf('window.__wbxInboxPauseFlow');
  const blok = VIEW.slice(i, eind);

  const naCheck = blok.slice(blok.indexOf("_toast('Markeren als ongelezen mislukt"));
  assert.match(naCheck, /onthoud\(_ui\.inbox\.unreadIntents, convId, patch, Date\.now\(\)\)/,
    'ook hier vertrekt er een poll tijdens de POST');
});
