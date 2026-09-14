// tests/opvolging-zoom-opwarm.test.js
//
// DE OPWARMRONDE VOOR EEN GEBOEKTE ZOOMCALL.
//
// ── GEMETEN OP 14 SEPTEMBER, OP PRODUCTIE ────────────────────────────────
// 40 openstaande scheduled afspraken in de toekomst, gemiddeld 13,6 dagen
// tussen created_at en scheduled_at, 29 van de 40 zeven dagen of verder
// vooruit geboekt. Tussen het boeken en de calldag stond er niemand in Daves
// lijst: het spraakbericht van 09:00, de nabelronde van 12:00 en de no-show-
// flow beginnen allemaal pas op of ná de calldag.
//
// ── WAT DEZE TESTS VASTLEGGEN IS WAT BEDOELD IS ──────────────────────────
// Niet wat de code toevallig doet. De ronde-A-regressie van 7 september werd
// permanent en onzichtbaar doordat een test het foute gedrag vastlegde; elke
// assertie hieronder staat er met de reden erbij waarom die uitkomst de juiste
// is.
//
// De belangrijkste is 'de kaart sluit op de ochtend van de calldag'. Dat is
// geen nette opruimregel maar een HARDE voorwaarde voor de bestaande werking:
// heeftAlKaart() in cron-opvolging-zoom-nabel matcht óók op telefoonnummer, dus
// een nog open opwarmkaart zou de nabelkaart van 12:00 verhinderen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  REDEN, SOORT, SOURCE, MAX_ACHTERSTAND_PER_DAG,
  bepaalOpwarmActie, dueVoorOpwarm, kiesInstroom, slaOver,
  bouwBadge, bouwNotitie, dagInZone,
} from '../api/_lib/opvolging-zoom-opwarm.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRON     = join(ROOT, 'api/cron-opvolging-zoom-opwarm.js');
const NABEL    = join(ROOT, 'api/cron-opvolging-zoom-nabel.js');
const ANNULEER = join(ROOT, 'api/cron-opvolging-annuleringen.js');
const MIGRATIE = join(ROOT, 'docs/sql-migrations/2026-09-14-opvolging-zoom-bevestigen.sql');

/** September 2026 is zomertijd: Amsterdam is UTC+2. */
const op = (dag, hh, mm = 0) =>
  `${dag}T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

/** 14 september 2026, 10:00 Amsterdamse tijd. */
const NU = Date.parse(op('2026-09-14', 10));
const VANDAAG = '2026-09-14';

const afspraak = (o = {}) => ({
  id: 'ap-1', lead_name: 'Redouane', lead_email: null, lead_phone: '+32470111222',
  scheduled_at: op('2026-09-25', 14), status: 'scheduled', is_test: false,
  created_at: op('2026-09-14', 9, 30),
  ...o,
});

const kaart = (o = {}) => ({
  id: 'tk-1', status: 'open', due: '2026-09-15', notitie: 'oude notitie',
  badge_label: 'Zoomcall vr 25/09 14:00',
  bron_ref: { appointment_id: 'ap-1', start: op('2026-09-25', 14), soort: SOORT, source: SOURCE },
  created_at: op('2026-09-14', 9, 40),
  ...o,
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DUE — de dag ná het boeken, en nooit een leugen
// ═══════════════════════════════════════════════════════════════════════════

test('de kaart staat op de dag NA het boeken, niet op de dag dat de cron draait', () => {
  // Dezelfde regel als dueVoorRondeA() bij de aanmeldflow, en om dezelfde
  // reden: hing de due aan het moment van de cron-run, dan schuift de kaart
  // elke ronde een dag mee en komt hij nooit boven.
  const due = dueVoorOpwarm({
    vandaag: VANDAAG, geboekt: op('2026-09-14', 9, 30), calldag: '2026-09-25',
  });
  assert.equal(due, '2026-09-15');
});

test('de opwarmronde valt nooit op of na de calldag — dan staat hij vandaag', () => {
  // Boeken op maandag voor een call op dinsdag: de dag erna is de calldag zelf,
  // en dan is er geen opwarmronde meer. Bellen VOOR de call is het hele punt.
  const due = dueVoorOpwarm({
    vandaag: VANDAAG, geboekt: op('2026-09-14', 9), calldag: '2026-09-15',
  });
  assert.equal(due, VANDAAG);
});

test('een kaart uit de achterstand wordt nooit geboren met een due in het verleden', () => {
  // Geboekt op 28 augustus, kaart pas vandaag aangemaakt door de dripfeed.
  // Zonder deze grens zou hij meteen het rode etiket 'bleef liggen' dragen
  // terwijl er niets bleef liggen — en dat is precies de onwaarheid waar deze
  // module al twee keer op is vastgelopen.
  const due = dueVoorOpwarm({
    vandaag: VANDAAG, geboekt: op('2026-08-28', 11), calldag: '2026-09-30',
  });
  assert.equal(due, VANDAAG);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE INSTROOM
// ═══════════════════════════════════════════════════════════════════════════

test('een verse boeking levert een kaart met reden zoom_bevestigen', () => {
  const b = bepaalOpwarmActie({ afspraak: afspraak(), taak: null, nu: NU });
  assert.equal(b.actie, 'aanmaken');
  assert.equal(b.due, '2026-09-15');
  assert.equal(b.vers, true, 'vandaag geboekt is gewone instroom, geen achterstand');
  assert.equal(REDEN, 'zoom_bevestigen');
  assert.match(b.badge_label, /^Zoomcall vr 25\/09 14:00$/);
  assert.match(b.notitie, /25\/09/);
  assert.match(b.notitie, /Geboekt op/, 'de notitie zegt wanneer de call geboekt is');
});

test('de notitie zegt wanneer de call staat, hoe ver weg dat is, en wanneer hij geboekt is', () => {
  const n = bouwNotitie(afspraak(), { vandaag: VANDAAG });
  assert.match(n, /Zoomcall staat op vr 25\/09 14:00/);
  assert.match(n, /over 11 dagen/);
  assert.match(n, /Geboekt op ma 14\/09/);
});

test('geen kaart bij een testafspraak, zonder nummer, of als de calldag er al is', () => {
  assert.equal(slaOver(afspraak({ is_test: true }), VANDAAG), 'is_test');
  assert.equal(slaOver(afspraak({ lead_phone: '  ' }), VANDAAG), 'geen_nummer');
  assert.equal(slaOver(afspraak({ status: 'cancelled' }), VANDAAG), 'niet_scheduled');
  // Een call van vandaag hoort bij de nabelronde van 12:00, niet hier.
  assert.equal(slaOver(afspraak({ scheduled_at: op(VANDAAG, 15) }), VANDAAG), 'calldag_is_hier');
});

test('een afspraak van vandaag levert GEEN opwarmkaart op', () => {
  const b = bepaalOpwarmActie({
    afspraak: afspraak({ scheduled_at: op(VANDAAG, 15) }), taak: null, nu: NU,
  });
  assert.equal(b.actie, 'niets');
  assert.equal(b.reden, 'calldag_is_hier');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART SLUIT ZICHZELF — en dit is het blokkerende deel
// ═══════════════════════════════════════════════════════════════════════════

test('BLOKKEREND · de opwarmkaart gaat dicht op de ochtend van de calldag', () => {
  // WAAROM DIT GEEN OPRUIMREGEL IS MAAR EEN VOORWAARDE.
  //
  // heeftAlKaart() in cron-opvolging-zoom-nabel matcht op TELEFOONNUMMER, niet
  // alleen op appointment_id. Een opwarmkaart die om 12:00 nog openstaat zou
  // de nabelkaart van die cron dus verhinderen — en dan verdwijnt een
  // bestaande, werkende functie stil achter een nieuwe. Vandaar: zodra de dag
  // van scheduled_at op of vóór vandaag ligt, gaat deze kaart dicht.
  const ochtend = Date.parse(op('2026-09-25', 7));   // calldag, 07:00 Amsterdam
  const b = bepaalOpwarmActie({
    afspraak: afspraak(), taak: kaart(), nu: ochtend,
  });
  assert.equal(b.actie, 'sluiten');
  assert.equal(b.archief_reden, 'calldag aangebroken');
  assert.match(b.regel, /2026-09-25/);
});

test('BLOKKEREND · de nabelcron matcht nog steeds op nummer — daarom moet de kaart dicht', () => {
  // Verandert die match ooit, dan hoort deze test rood te worden zodat iemand
  // opnieuw nadenkt over de regel hierboven, in plaats van dat de nabelronde
  // stil wegvalt.
  const src = readFileSync(NABEL, 'utf8');
  assert.match(src, /function heeftAlKaart/);
  assert.match(src, /slice\(-9\)/, 'de nabelcron vergelijkt op de laatste negen cijfers van het nummer');
});

test('een geannuleerde afspraak sluit de kaart met een leesbare reden', () => {
  const b = bepaalOpwarmActie({
    afspraak: afspraak({ status: 'cancelled' }), taak: kaart(), nu: NU,
  });
  assert.equal(b.actie, 'sluiten');
  assert.equal(b.archief_reden, 'afspraak geannuleerd');
  assert.match(b.regel, /geannuleerd/);
});

test('de annuleringsronde wordt niet geblokkeerd door onze gesloten kaart', () => {
  // cron-opvolging-annuleringen slaat een lead over als er al een LOPENDE
  // kaart op het nummer staat. Onze kaart is dan gearchiveerd, en
  // gearchiveerd staat niet in die lijst — dus die cron doet gewoon zijn werk.
  const src = readFileSync(ANNULEER, 'utf8');
  const m = src.match(/const LOPEND = \[([^\]]*)\]/);
  assert.ok(m, 'LOPEND staat in cron-opvolging-annuleringen');
  assert.ok(!m[1].includes('gearchiveerd'),
    'een gearchiveerde opwarmkaart mag de annuleringskaart niet tegenhouden');
  // En: hij slaat wél over als er al een kaart UIT DEZELFDE AFSPRAAK bestaat,
  // ongeacht status. Dat is hier onschadelijk — onze bron_ref hangt aan de
  // afspraak die zojuist geannuleerd is, dus dat is dezelfde gebeurtenis.
  assert.match(src, /kaart_bestaat_al/);
});

test('een verzette afspraak sluit de kaart; de nieuwe rij krijgt vanzelf een nieuwe', () => {
  const b = bepaalOpwarmActie({
    afspraak: afspraak({ status: 'verplaatst' }), taak: kaart(), nu: NU,
  });
  assert.equal(b.actie, 'sluiten');
  assert.equal(b.archief_reden, 'afspraak verzet');
});

test('bevestigd is dicht: een gearchiveerde kaart komt NOOIT terug', () => {
  // De hele belofte van deze flow, en anders dan bij de aanmeldkaart: daar is
  // een tweede ronde, hier niet. Maxims keuze — de calldag zelf is al gedekt.
  const b = bepaalOpwarmActie({
    afspraak: afspraak(), taak: kaart({ status: 'gearchiveerd' }), nu: NU,
  });
  assert.equal(b.actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET REDOUANE-GEVAL — verzetten binnen dezelfde rij
// ═══════════════════════════════════════════════════════════════════════════

test('een verschoven moment werkt de kaart bij; hij blijft staan', () => {
  // Niet elke verzetting maakt een nieuwe rij. Er staat ook een vorm in de
  // data waarbij scheduled_at op de bestaande rij wordt overschreven. Dan is
  // de kaart nog steeds de juiste kaart — alleen etiket en notitie kloppen
  // niet meer. Sluiten zou hier de opwarmronde weggooien bij iemand die hem
  // juist nog nodig heeft.
  const b = bepaalOpwarmActie({
    afspraak: afspraak({ scheduled_at: op('2026-09-28', 11) }), taak: kaart(), nu: NU,
  });
  assert.equal(b.actie, 'bijwerken');
  assert.equal(b.badge_label, 'Zoomcall ma 28/09 11:00');
  assert.equal(b.start, op('2026-09-28', 11));
  assert.match(b.regel, /verzet naar ma 28\/09 11:00/);
});

test('een ongewijzigde afspraak met een lopende kaart levert niets op', () => {
  const b = bepaalOpwarmActie({ afspraak: afspraak(), taak: kaart(), nu: NU });
  assert.equal(b.actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIPFEED
// ═══════════════════════════════════════════════════════════════════════════

test('de achterstand komt er gespreid in: tien per dag, eerstvolgende calls eerst', () => {
  const kandidaten = Array.from({ length: 36 }, (_, i) => ({
    id: 'ap-' + i, scheduled_at: op('2026-10-' + String(i + 1).padStart(2, '0'), 10), vers: false,
  })).reverse();   // omgekeerd aangeboden, zodat de sortering echt getest wordt

  const eerste = kiesInstroom({ kandidaten, alGemaaktVandaag: 0 });
  assert.equal(eerste.nu.length, MAX_ACHTERSTAND_PER_DAG);
  assert.equal(eerste.wachtrij.length, 26);
  assert.equal(eerste.nu[0].id, 'ap-0', 'de eerstvolgende call staat vooraan');
  assert.equal(eerste.nu[9].id, 'ap-9');
});

test('een verse boeking van vandaag heeft altijd voorrang op de achterstand', () => {
  // Ook als de dagquota al vol is. Anders zou de hele afspraak — de dag ná het
  // boeken bellen — sneuvelen zolang de achterstand loopt.
  const kandidaten = [
    { id: 'oud-1', scheduled_at: op('2026-09-20', 10), vers: false },
    { id: 'vers-1', scheduled_at: op('2026-10-30', 10), vers: true },
  ];
  const k = kiesInstroom({ kandidaten, alGemaaktVandaag: MAX_ACHTERSTAND_PER_DAG });
  assert.deepEqual(k.nu.map((x) => x.id), ['vers-1']);
  assert.deepEqual(k.wachtrij.map((x) => x.id), ['oud-1']);
  assert.equal(k.ruimte, 0);
});

test('wat er vandaag al uit de achterstand kwam, telt mee in de quota', () => {
  const kandidaten = Array.from({ length: 5 }, (_, i) => ({
    id: 'ap-' + i, scheduled_at: op('2026-10-0' + (i + 1), 10), vers: false,
  }));
  const k = kiesInstroom({ kandidaten, alGemaaktVandaag: 8 });
  assert.equal(k.nu.length, 2);
  assert.equal(k.wachtrij.length, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING
// ═══════════════════════════════════════════════════════════════════════════

test('de cron staat elk kwartier in vercel.json', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rij = (cfg.crons || []).find((c) => c.path === '/api/cron-opvolging-zoom-opwarm');
  assert.ok(rij, 'de cron staat in vercel.json');
  assert.equal(rij.schedule, '*/15 * * * *');
});

test('de cron schrijft alleen in opvolging_taken en leest de afspraakrij', () => {
  const src = readFileSync(CRON, 'utf8');
  assert.match(src, /checkCronAuth/, 'auth via CRON_SECRET, net als de andere opvolging-crons');
  assert.match(src, /from\('follow_up_appointments'\)/);
  // Geen enkele .update/.insert op een andere tabel dan opvolging_taken.
  const schrijft = [...src.matchAll(/from\('([a-z_]+)'\)\s*\n?\s*\.(insert|update|delete)/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(schrijft)], ['opvolging_taken']);
});

test('de cron leest ALLE opwarmkaarten, ook de gearchiveerde', () => {
  // Alleen de open kaarten lezen zou betekenen dat elke bevestigde lead morgen
  // opnieuw in de lijst staat — precies wat 'bevestigd is dicht' moet
  // uitsluiten.
  const src = readFileSync(CRON, 'utf8');
  const blok = src.slice(src.indexOf('async function leesKaarten'), src.indexOf('async function leesToekomstigeAfspraken'));
  assert.match(blok, /\.eq\('reden', REDEN\)/);
  assert.ok(!/\.eq\('status'|\.neq\('status'|\.in\('status'/.test(blok),
    'geen statusfilter: gearchiveerd telt mee als "deze kaart is al geweest"');
});

test('de migratie behoudt alle negen redenen en is idempotent', () => {
  const sql = readFileSync(MIGRATIE, 'utf8');
  for (const reden of [
    'wil_nog_beslissen', 'no_show_event', 'no_show_call', 'afgemeld', 'niet_ingepland',
    'aanmelding', 'zoom_nabellen', 'zoom_geannuleerd', 'zoom_bevestigen',
  ]) {
    assert.ok(sql.includes(`'${reden}'`), 'de lijst draagt ' + reden);
  }
  // Eén atomair DO-block, zoals 2026-09-11: de Supabase-editor knipt op
  // statement-grenzen, dus state die tussen twee blocks door moet overleven
  // gaat daar stuk.
  assert.equal((sql.match(/DO \$\$/g) || []).length, 1);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk/);
  assert.match(sql, /RAISE EXCEPTION/, 'valt er een waarde weg, dan stopt hij');
});

test('dagInZone rekent in Amsterdam, niet in UTC', () => {
  // 23:30 UTC op 14 september is 01:30 op 15 september in Amsterdam.
  assert.equal(dagInZone(Date.parse('2026-09-14T23:30:00Z')), '2026-09-15');
});

test('het etiket valt terug op leesbare tekst als het moment ontbreekt', () => {
  assert.equal(bouwBadge({ scheduled_at: null }), 'Zoomcall onbekend moment');
});
