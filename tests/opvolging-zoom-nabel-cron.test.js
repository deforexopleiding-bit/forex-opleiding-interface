// tests/opvolging-zoom-nabel-cron.test.js
//
// DE INSTROOM VAN 12:00 — wie kreeg een spraakbericht en reageerde niet?
//
// De afspraak: elke lead met een zoomcall krijgt vóór 09:00 een ingesproken
// bericht; wie daar niet op reageert wordt tussen 12 en 13 uur gebeld. Dat
// nabellen stond nergens als taak — het was een venster in een rapport en
// verder een kwestie van eraan denken.
//
// ── DE REGEL DIE DEZE HELE CRON BEPAALT ──────────────────────────────────
// GEEN REACTIE IS IETS ANDERS DAN NIET GEMETEN. Ziet de brug geen uitgaande
// berichten, of valt de dag buiten het bereik van de leadlijst, dan weten we
// niet of er een spraakbericht ging en al helemaal niet of er geantwoord is.
// Kaarten maken op zo'n dag laat Dave bellen naar mensen die vanochtend gewoon
// geantwoord hebben — precies de dubbeling die deze cron moet voorkomen.
//
// ── EN DE KLOK ───────────────────────────────────────────────────────────
// Vercel draait crons in UTC. `0 10,11 * * *` is 's zomers 12:00 en 13:00 in
// Amsterdam, 's winters 11:00 en 12:00. Zomer én winter raakt er precies één
// run het venster van 12:00 tot 21:00, en twee runs zijn idempotent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  magHandelen, bepaalKaart, bouwNotitie,
  VENSTER_VAN_UUR, VENSTER_TOT_UUR, REDEN_GEEN_REACTIE, REDEN_GEEN_SPRAAK,
} from '../api/cron-opvolging-zoom-nabel.js';
import { bepaalDoorrol, isVoorbijeNabelkaart, ZOOM_NABEL_REDENEN } from '../api/_lib/opvolging-doorrol.js';
import { controleerDagritme, OK, FOUT, NIET_GEMETEN } from '../api/_lib/opvolging-gezondheid.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DAG = '2026-09-11';

/** Amsterdamse tijd op een zomerdag (UTC+2). */
const zomer = (hh, mm = 0, dag = DAG) =>
  Date.parse(`${dag}T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
/** Amsterdamse tijd op een winterdag (UTC+1). */
const winter = (hh, mm = 0, dag = '2026-12-11') =>
  Date.parse(`${dag}T${String(hh - 1).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);

const wa = (over) => ({ soort: 'spraakbericht', richting: 'uit', tijdstip: new Date(zomer(8, 12)).toISOString(), ...over });

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET TIJDVENSTER — zomer én winter
// ═══════════════════════════════════════════════════════════════════════════

test('het venster loopt van 12:00 tot 21:00 Amsterdamse tijd', () => {
  assert.equal(VENSTER_VAN_UUR, 12);
  assert.equal(VENSTER_TOT_UUR, 21);
  assert.equal(magHandelen(zomer(12, 0)).mag, true, '12:00 precies mag');
  assert.equal(magHandelen(zomer(20, 59)).mag, true);
  assert.equal(magHandelen(zomer(11, 59)).mag, false);
  assert.equal(magHandelen(zomer(21, 0)).mag, false, '21:00 precies mag niet meer');
});

test('IN DE ZOMER raakt precies één van de twee UTC-runs het venster', () => {
  // `0 10,11 * * *` = 12:00 en 13:00 in Amsterdam. Allebei binnen het venster,
  // en dat mag: de tweede run is idempotent (zie de test verderop).
  assert.equal(magHandelen(zomer(12)).mag, true, '10:00 UTC → 12:00 Amsterdam');
  assert.equal(magHandelen(zomer(13)).mag, true, '11:00 UTC → 13:00 Amsterdam');
});

test('IN DE WINTER valt de eerste run buiten het venster en de tweede erin', () => {
  // Dit is de reden dat het schema twee uren draagt. Met alleen `0 11 * * *`
  // zou de cron 's zomers om 13:00 draaien (nog net goed) en met alleen
  // `0 10 * * *` 's winters om 11:00 — een uur vóór het venster.
  assert.equal(magHandelen(winter(11)).mag, false, '10:00 UTC → 11:00 Amsterdam, te vroeg');
  assert.equal(magHandelen(winter(12)).mag, true, '11:00 UTC → 12:00 Amsterdam');
});

test('een onbruikbare klok laat de cron niets doen', () => {
  assert.equal(magHandelen(NaN).mag, false);
  assert.equal(magHandelen(null).mag, false);
});

test('het schema in vercel.json staat op twee UTC-uren', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rij = (cfg.crons || []).find((c) => c.path === '/api/cron-opvolging-zoom-nabel');
  assert.ok(rij, 'de cron hoort in vercel.json te staan');
  assert.equal(rij.schedule, '0 10,11 * * *');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · ALLEEN ALS DE METING WERKT
// ═══════════════════════════════════════════════════════════════════════════

test('zonder verbonden brug of gedekte dag komen er GEEN kaarten', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  const i = bron.indexOf('async function meetbaar');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1400);

  assert.match(blok, /leadlijstDektDag\(dag\)/, 'de dag moet gedekt zijn');
  assert.match(blok, /status\.verbonden !== true/);
  assert.match(blok, /status\.ziet_uitgaand !== true/,
    'een oudere brug die dit veld niet meestuurt telt niet als gemeten');
  // Dezelfde bron als /api/opvolging-whatsapp-status.
  assert.match(blok, /brugFetch\('\/status'\)/);

  // En de handler stopt erop, met een reden in het antwoord.
  assert.match(bron, /if \(!meting\.gemeten\)/);
  assert.match(bron, /gemeten: false, reden: meting\.reden/);
  assert.match(bron, /NIET GEMETEN: ' \+ meting\.reden/);
});

test('kunnen de berichten niet gelezen worden, dan ook geen kaarten', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  const i = bron.indexOf('const { regels, fout } = await haalWaRegels');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 600);
  assert.match(blok, /if \(fout\)/);
  assert.match(blok, /gemeten: false/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE TWEE REDENEN, EN HET ANTWOORD DAT ALLES AFBLAAST
// ═══════════════════════════════════════════════════════════════════════════

test('een antwoord van vandaag → geen kaart', () => {
  const b = bepaalKaart([
    wa({ tijdstip: new Date(zomer(8, 12)).toISOString() }),
    wa({ soort: 'whatsapp', richting: 'in', tijdstip: new Date(zomer(9, 5)).toISOString() }),
  ], DAG);
  assert.equal(b.kaart, false);
});

test('spraakbericht zonder antwoord → zoom_geen_reactie, met de tijd erbij', () => {
  const b = bepaalKaart([wa({ tijdstip: new Date(zomer(8, 12)).toISOString() })], DAG);
  assert.equal(b.kaart, true);
  assert.equal(b.reden_code, REDEN_GEEN_REACTIE);
  assert.equal(b.spraak_tijd, '08:12');
});

test('geen spraakbericht → zoom_geen_spraakbericht, een groter gat en dus een eigen reden', () => {
  const b = bepaalKaart([], DAG);
  assert.equal(b.kaart, true);
  assert.equal(b.reden_code, REDEN_GEEN_SPRAAK);
  assert.equal(b.spraak_tijd, null);

  // Alleen een tekstje telt niet als spraakbericht.
  const b2 = bepaalKaart([wa({ soort: 'whatsapp' })], DAG);
  assert.equal(b2.reden_code, REDEN_GEEN_SPRAAK);
});

test('het eerste spraakbericht van de dag bepaalt de tijd', () => {
  const b = bepaalKaart([
    wa({ tijdstip: new Date(zomer(10, 30)).toISOString() }),
    wa({ tijdstip: new Date(zomer(8, 12)).toISOString() }),
  ], DAG);
  assert.equal(b.spraak_tijd, '08:12');
});

test('berichten van een ANDERE dag tellen niet mee', () => {
  const b = bepaalKaart([wa({ tijdstip: new Date(zomer(8, 12, '2026-09-10')).toISOString() })], DAG);
  assert.equal(b.reden_code, REDEN_GEEN_SPRAAK, 'gisteren zegt niets over vandaag');
});

test('de notitie zegt precies wat er wel en niet gebeurd is', () => {
  assert.equal(
    bouwNotitie({ callTijd: '15:00', reden_code: REDEN_GEEN_REACTIE, spraak_tijd: '08:12' }),
    'Zoomcall vandaag om 15:00 — geen reactie op het spraakbericht van 08:12.');
  assert.equal(
    bouwNotitie({ callTijd: '15:00', reden_code: REDEN_GEEN_SPRAAK, spraak_tijd: null }),
    'Zoomcall vandaag om 15:00 — er ging geen spraakbericht uit.');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE SELECTIE — alleen calls die nog moeten komen
// ═══════════════════════════════════════════════════════════════════════════

test('een call die al geweest is krijgt geen kaart — dat is de no-show-flow', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  const i = bron.indexOf('async function leesAfspraken');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1200);
  assert.match(blok, /\.gt\('scheduled_at', vanIso\)/, 'strikt ná nu');
  assert.match(blok, /\.eq\('status', 'scheduled'\)/);
  assert.match(blok, /\.not\('lead_phone', 'is', null\)/);
  assert.match(blok, /a\.is_test === true/);
  // De aanroep gebruikt het huidige moment als ondergrens.
  assert.match(bron, /const nuIso = new Date\(startedAt\)\.toISOString\(\)/);
  assert.match(bron, /leesAfspraken\(nuIso, eindDagIso, vandaag\)/);
});

test('idempotent: een bestaande kaart op nummer of appointment_id houdt een tweede tegen', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  const i = bron.indexOf('function heeftAlKaart');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /bron_ref\.appointment_id/);
  assert.match(blok, /c\.slice\(-9\) === staart/, 'zelfde nummermatch als zoekTaak in de webhook');

  // En binnen één run telt een verse kaart meteen mee, zodat twee calls voor
  // dezelfde lead op één dag niet twee kaarten opleveren.
  assert.match(bron, /bestaandeTaken\.push\(\{ telefoon: a\.lead_phone/);
});

test('de kaart draagt de afgesproken velden', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  const i = bron.indexOf('async function maakKaart');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1400);
  assert.match(blok, /reden\s*:\s*'zoom_nabellen'/);
  assert.match(blok, /badge_label: 'Zoomcall ' \+ callTijd/);
  assert.match(blok, /soort\s*:\s*'zoom_nabel'/);
  assert.match(blok, /due\s*:\s*vandaag/);
  assert.match(blok, /afspraak\.is_test === true \? \{ is_test: true \} : \{\}/,
    'een proefafspraak levert een proefkaart op, geen echte');
});

test('de migratie zet reden zoom_nabellen in de CHECK — anders faalt elke insert', () => {
  // CLAUDE.md: een nieuwe enum-waarde in de code MOET samen met een ALTER van
  // de constraint. Zonder deze migratie faalt elke kaart van deze cron met
  // 'violates check constraint opvolging_taken_reden_chk', en doet de instroom
  // van 12:00 helemaal niets.
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-10-opvolging-zoom-nabellen.sql'), 'utf8');
  assert.match(sql, /BLOKKEREND/);
  assert.match(sql, /'zoom_nabellen'/);
  assert.match(sql, /is_test boolean/);

  // De volledige lijst moet erin staan: een CHECK is niet uit te breiden zonder
  // hem te vervangen, en een vergeten waarde breekt bestaande inserts.
  for (const reden of ['wil_nog_beslissen', 'no_show_event', 'no_show_call',
    'afgemeld', 'niet_ingepland', 'aanmelding']) {
    assert.match(sql, new RegExp("'" + reden + "'"), reden + ' hoort in de nieuwe CHECK');
  }
});

test('de werklijst heeft een etiket voor de nieuwe reden', () => {
  // Zonder REDEN_LABEL-regel toont de badge de rauwe sleutel 'zoom_nabellen'.
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /zoom_nabellen: \['Zoomcall nabellen'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE KAART SLUIT ZICHZELF
// ═══════════════════════════════════════════════════════════════════════════

test('de webhook archiveert de nabelkaart zodra de lead antwoordt', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-whatsapp-webhook.js'), 'utf8');
  assert.match(bron, /if \(soort === 'antwoord_ontvangen'\) await sluitNabelkaart\(taak\);/);

  const i = bron.indexOf('async function sluitNabelkaart');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /archief_reden\s*:\s*'antwoord ontvangen op WhatsApp'/);
  assert.match(blok, /\.in\('reden_code', ZOOM_NABEL_REDENEN\)/,
    'ALLEEN onze eigen kaarten — anders sluit elk bericht een willekeurige taak');
  assert.match(blok, /\.eq\('status', 'open'\)/);
  assert.match(bron, /ZOOM_NABEL_REDENEN = \['zoom_geen_reactie', 'zoom_geen_spraakbericht'\]/);
  // zoekTaak moet reden_code meelezen, anders is er niets om op te filteren.
  assert.match(bron, /\.select\('id, telefoon, status, reden_code, updated_at'\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE DOORROL ARCHIVEERT WAT NIET MEER KAN
// ═══════════════════════════════════════════════════════════════════════════

const nabelkaart = (over) => ({
  id: 't1', status: 'open', due: '2026-09-11', later: false,
  reden_code: REDEN_GEEN_REACTIE,
  bron_ref: { appointment_id: 'ap-1', start: new Date(zomer(15)).toISOString(), soort: 'zoom_nabel' },
  ...over,
});

test('een nabelkaart waarvan de call voorbij is wordt GEARCHIVEERD, niet doorgerold', () => {
  // 'Bel deze lead vóór zijn call van vanmiddag' is na die call niet meer uit
  // te voeren; de uitkomst komt uit de call zelf. Zou hij doorrollen, dan
  // vraagt hij morgen — en overmorgen — om iets wat gisteren al niet kon.
  const [r] = bepaalDoorrol({ taken: [nabelkaart()], vandaag: '2026-09-12', nuMs: zomer(10, 0, '2026-09-12') });
  assert.equal(r.id, 't1');
  assert.equal(r.patch.status, 'gearchiveerd');
  assert.equal(r.patch.archief_reden, 'zoomcall voorbij — uitkomst via de call');
  assert.equal(r.patch.due, undefined, 'geen nieuwe due erbij');
});

test('een gewone achterstallige taak rolt gewoon door', () => {
  const [r] = bepaalDoorrol({
    taken: [{ id: 't2', status: 'open', due: '2026-09-10', later: true }],
    vandaag: '2026-09-12',
  });
  assert.deepEqual(r.patch, { due: '2026-09-12', later: false });
});

test('een nabelkaart waarvan de call NOG MOET KOMEN rolt ook gewoon door', () => {
  const kaart = nabelkaart({ bron_ref: { start: new Date(zomer(15, 0, '2026-09-12')).toISOString() } });
  const [r] = bepaalDoorrol({ taken: [kaart], vandaag: '2026-09-12', nuMs: zomer(10, 0, '2026-09-12') });
  assert.equal(r.patch.due, '2026-09-12');
});

test('zonder starttijd archiveren we NIET — op een gok werk laten verdwijnen is de duurste fout', () => {
  for (const ref of [null, {}, { start: null }, { start: 'gisteren' }]) {
    assert.equal(isVoorbijeNabelkaart({ reden_code: REDEN_GEEN_REACTIE, bron_ref: ref }, Date.now()), false,
      JSON.stringify(ref));
  }
});

test('alleen ONZE reden-codes tellen — een andere kaart raken we niet aan', () => {
  assert.deepEqual(ZOOM_NABEL_REDENEN, ['zoom_geen_reactie', 'zoom_geen_spraakbericht']);
  const vreemd = nabelkaart({ reden_code: 'zoom_geen_interesse' });
  assert.equal(isVoorbijeNabelkaart(vreemd, zomer(20)), false);
  const [r] = bepaalDoorrol({ taken: [vreemd], vandaag: '2026-09-12', nuMs: zomer(10, 0, '2026-09-12') });
  assert.equal(r.patch.due, '2026-09-12', 'die rolt gewoon door');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE ZESDE CONTROLE — dagritme
// ═══════════════════════════════════════════════════════════════════════════

test('geen enkele open taak van vóór vandaag → ok', () => {
  // Gemeten op 10 september: 0. De eerste run hoort dus ok te zijn.
  const u = controleerDagritme({
    taken: [{ due: DAG }, { due: '2026-09-12' }, { due: DAG }],
    vandaag: DAG, leesfout: null,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.open, 3);
  assert.equal(u.getallen.achter, 0);
});

test('een open taak van gisteren → fout, met het aantal en de oudste dag', () => {
  const u = controleerDagritme({
    taken: [{ due: '2026-09-09' }, { due: '2026-09-10' }, { due: DAG }],
    vandaag: DAG, leesfout: null,
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.achter, 2);
  assert.equal(u.getallen.oudste, '2026-09-09');
  assert.match(u.uitleg, /Draaide de nachtelijke doorrol\?/);
});

test('GEEN NAMEN in de getallen — dit is een alarm, geen werklijst in een mailbox', () => {
  const u = controleerDagritme({
    taken: [{ due: '2026-09-09', naam: 'Rani Peeters' }],
    vandaag: DAG, leesfout: null,
  });
  assert.doesNotMatch(JSON.stringify(u), /Rani/);
});

test('kan hij niet lezen, dan is het NIET GEMETEN en nooit ok', () => {
  // Zie de kop van opvolging-gezondheid.js: een controle die niets kon meten
  // is niet in orde, en 'niet gemeten' telt in de mail even zwaar als 'fout'.
  const u = controleerDagritme({ taken: [], vandaag: DAG, leesfout: 'relatie bestaat niet' });
  assert.equal(u.staat, NIET_GEMETEN);
  assert.match(u.uitleg, /relatie bestaat niet/);

  assert.equal(controleerDagritme({ taken: [], vandaag: 'gisteren', leesfout: null }).staat, NIET_GEMETEN);
});

test('een lege takenlijst is hier WEL ok — de meting is er, hij is alleen leeg', () => {
  // Anders dan bij de instroomcontrole: daar is 'geen rijen' geen meting, hier
  // is de lijst openstaande taken zelf de meting.
  const u = controleerDagritme({ taken: [], vandaag: DAG, leesfout: null });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.achter, 0);
});

test('de gezondheidscron draait de zesde controle mee', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-gezondheid.js'), 'utf8');
  assert.match(bron, /controleerDagritme/);
  assert.match(bron, /uitkomsten\.push\(await meetDagritme\(vandaag\)\)/);
  const i = bron.indexOf('async function meetDagritme');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 700);
  assert.match(blok, /\.eq\('status', 'open'\)/);
  assert.match(blok, /leesfout: kort\(e\)/, 'een leesfout gaat als leesfout naar de controle');
});
