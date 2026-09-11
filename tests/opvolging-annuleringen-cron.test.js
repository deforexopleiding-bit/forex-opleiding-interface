// tests/opvolging-annuleringen-cron.test.js
//
// EEN GEANNULEERDE ZOOMCALL ZONDER NIEUWE AFSPRAAK IS WERK.
//
// Punt 5 van de bouwlijst van 7 september. Tot nu toe gebeurde er niets: de
// call stond doorgestreept in de agenda, en daar kijkt niemand meer naar.
//
// ── GEMETEN OP 11 SEPTEMBER ─────────────────────────────────────────────
// Drie geannuleerde calls van die dag, geen van drieën met een nieuwe afspraak
// en geen van drieën met een opvolgtaak:
//
//   Priscilla Lumengo (11:00) — cancelled, annulering_sent_at 07:00:52Z,
//     reden_code 'anders', reden leeg. Zelf geannuleerd via de link, ná het
//     spraakbericht van die ochtend.
//   Kimberley Basslé (13:00) — cancelled, zelf geannuleerd op 10 sep 13:51,
//     code 'geen-tijd', reden 'Geen tijd / te druk'.
//   Wout Dijkshoorn (17:00) — cancelled, maar annulering_sent_at en de code
//     zijn LEEG. Geannuleerd in GHL zelf; de appointment-poll pikte dat op.
//
// Die laatste is het hele punt van het onderscheid: bij de eerste twee weet je
// waaróm iemand afzegde en kun je daarop inspelen, bij Wout weet je alleen dát
// het gebeurd is. Eén reden_code voor allebei zou dat verschil weggooien.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  ANNULERING_VANAF, HERBOEKT_STATUSSEN, REDEN_ZELF, REDEN_AGENDA,
  annuleerBron, bouwNotitie, bouwBadge, bouwNotitieRegel,
  slaOver, heeftHerboekt, momentVan,
  leadAlAfgesloten, zelfdeLead, EINDPUNT_UITKOMSTEN,
} from '../api/_lib/opvolging-annulering.js';
import { afrondLabelVanTaak } from '../api/opvolging-agenda.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CRON = join(ROOT, 'api/cron-opvolging-annuleringen.js');

/** 11 september 2026 is een vrijdag; zomertijd, dus UTC+2. */
const op = (hh, mm = 0, dag = '2026-09-11') =>
  `${dag}T${String(hh - 2).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

/** De drie gemeten gevallen. */
const PRISCILLA = {
  id: 'ap-p', lead_name: 'Priscilla Lumengo', lead_phone: '+32470111222',
  lead_ghl_contact_id: 'ghl-p', scheduled_at: op(11), status: 'cancelled',
  uitkomst: null, is_test: false,
  annulering_sent_at: '2026-09-11T07:00:52.000Z',
  annulering_reden_code: 'anders', annulering_reden: null,
};
const KIMBERLEY = {
  id: 'ap-k', lead_name: 'Kimberley Basslé', lead_phone: '+32470333444',
  lead_ghl_contact_id: 'ghl-k', scheduled_at: op(13), status: 'cancelled',
  uitkomst: null, is_test: false,
  annulering_sent_at: '2026-09-10T11:51:00.000Z',
  annulering_reden_code: 'geen-tijd', annulering_reden: 'Geen tijd / te druk',
};
const WOUT = {
  id: 'ap-w', lead_name: 'Wout Dijkshoorn', lead_phone: '+31612345678',
  lead_ghl_contact_id: 'ghl-w', scheduled_at: op(17), status: 'cancelled',
  uitkomst: null, is_test: false,
  annulering_sent_at: null, annulering_reden_code: null, annulering_reden: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ZELF GEANNULEERD OF IN DE AGENDA
// ═══════════════════════════════════════════════════════════════════════════

test('een reden_code betekent: de lead klikte zelf op de annuleerlink', () => {
  // public-afspraak-annuleren.js is de ENIGE weg die annulering_reden_code
  // zet. Staat hij er, dan heeft de lead zelf afgezegd.
  assert.equal(annuleerBron(PRISCILLA), REDEN_ZELF);
  assert.equal(annuleerBron(KIMBERLEY), REDEN_ZELF);
});

test('geen reden_code betekent: geannuleerd in de agenda', () => {
  assert.equal(annuleerBron(WOUT), REDEN_AGENDA);
  assert.equal(annuleerBron({ annulering_reden_code: '' }), REDEN_AGENDA);
  assert.equal(annuleerBron({ annulering_reden_code: '   ' }), REDEN_AGENDA);
  assert.equal(annuleerBron({}), REDEN_AGENDA);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE NOTITIE — wat Dave moet weten voordat hij belt
// ═══════════════════════════════════════════════════════════════════════════

test('de notitie noemt het moment, hoe er afgezegd is, en wat er nu moet', () => {
  assert.equal(bouwNotitie(KIMBERLEY),
    'Zoomcall van vr 11/09 13:00 zelf geannuleerd — reden: Geen tijd / te druk. '
    + 'Nog niet opnieuw ingepland: plan hem opnieuw in.');
});

test('zonder vrije reden valt dat stuk gewoon weg', () => {
  // Priscilla koos 'anders' en vulde niets in. Dan is er niets te melden, en
  // ' — reden: ' met niets erachter is erger dan het weglaten.
  assert.equal(bouwNotitie(PRISCILLA),
    'Zoomcall van vr 11/09 11:00 zelf geannuleerd. Nog niet opnieuw ingepland: plan hem opnieuw in.');
});

test('geannuleerd in de agenda leest anders', () => {
  assert.equal(bouwNotitie(WOUT),
    'Zoomcall van vr 11/09 17:00 geannuleerd in de agenda. '
    + 'Nog niet opnieuw ingepland: plan hem opnieuw in.');
});

test('het etiket draagt het moment van de call', () => {
  assert.equal(bouwBadge(KIMBERLEY), 'Geannuleerd · call vr 11/09 13:00');
});

test('de regel voor een bestaande kaart is kort en draagt de dag', () => {
  assert.equal(bouwNotitieRegel(WOUT, '2026-09-11'),
    '2026-09-11 · Zoomcall van vr 11/09 17:00 geannuleerd.');
});

test('het moment wordt in Amsterdamse tijd gerekend', () => {
  // 17:00 Amsterdam is 15:00 UTC. Via toISOString zou de notitie er een ander
  // uur in zetten, en 's winters zelfs een andere dag bij een avondcall.
  const m = momentVan(WOUT.scheduled_at);
  assert.equal(m.dag, '2026-09-11');
  assert.equal(m.tijd, '17:00');
  assert.equal(m.tekst, 'vr 11/09 17:00');
  assert.equal(momentVan(null), null);
  assert.equal(momentVan('binnenkort'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WIE VALT ER AF, EN WAAROM
// ═══════════════════════════════════════════════════════════════════════════

test('de drie gemeten gevallen doen gewoon mee', () => {
  for (const a of [PRISCILLA, KIMBERLEY, WOUT]) {
    assert.equal(slaOver(a), null, a.lead_name);
  }
});

test('een proefrij valt af', () => {
  assert.equal(slaOver({ ...WOUT, is_test: true }), 'is_test');
});

test('een afspraak met een vastgelegde uitkomst valt af', () => {
  // Daar heeft Dave zelf al iets over besloten; een kaart erbij is dubbel werk.
  assert.equal(slaOver({ ...WOUT, uitkomst: 'wilt_niet_meer' }), 'uitkomst_al_vastgelegd');
});

test('zonder telefoonnummer valt hij af — er valt niets te bellen', () => {
  assert.equal(slaOver({ ...WOUT, lead_phone: null }), 'geen_nummer');
  assert.equal(slaOver({ ...WOUT, lead_phone: '  ' }), 'geen_nummer');
});

test('alles vóór ANNULERING_VANAF valt af', () => {
  // De ±88 oudere zelf-geannuleerden uit de lijst van 7 september horen hier
  // NIET in: dat is een muur, geen werklijst. Maxim kiest daar zelf het tempo
  // voor.
  assert.equal(ANNULERING_VANAF, '2026-09-10');
  assert.equal(slaOver({ ...WOUT, scheduled_at: op(17, 0, '2026-09-09') }), 'voor_de_grens');
  assert.equal(slaOver({ ...WOUT, scheduled_at: op(17, 0, '2026-09-10') }), null, 'de 10e doet mee');
});

test('een onbruikbaar moment valt af in plaats van een kaart met "onbekend" op te leveren', () => {
  assert.equal(slaOver({ ...WOUT, scheduled_at: null }), 'geen_moment');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HEEFT HIJ ZELF OPNIEUW INGEPLAND?
// ═══════════════════════════════════════════════════════════════════════════

const nieuwe = (over) => ({
  id: 'ap-nieuw', lead_phone: '+32470333444', lead_ghl_contact_id: 'ghl-k',
  scheduled_at: op(10, 0, '2026-09-18'), status: 'scheduled', ...over,
});

test('een nieuwere scheduled-afspraak op hetzelfde contact telt als herboekt', () => {
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe()]), true);
});

test('herboeken wordt ook op het telefoonnummer gevonden', () => {
  // Een lead die via een andere weg terugkomt kan een ander GHL-contact
  // krijgen, maar belt met dezelfde telefoon.
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({ lead_ghl_contact_id: 'ghl-anders' })]), true);
  // Ook lokaal genoteerd.
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({
    lead_ghl_contact_id: null, lead_phone: '0470 33 34 44',
  })]), true);
});

test('in_progress telt ook — die call is bezig', () => {
  assert.deepEqual([...HERBOEKT_STATUSSEN].sort(), ['in_progress', 'scheduled']);
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({ status: 'in_progress' })]), true);
});

test('een OUDERE afspraak die nog op scheduled staat is GEEN herboeking', () => {
  // Anders verstomt een annulering van vandaag door iets van vorige maand.
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({
    scheduled_at: op(10, 0, '2026-08-20'),
  })]), false);
});

test('een nieuwere afspraak die zelf geannuleerd is telt niet', () => {
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({ status: 'cancelled' })]), false);
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({ status: 'no_show' })]), false);
});

test('een andere lead telt niet mee', () => {
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY, nieuwe({
    lead_ghl_contact_id: 'ghl-anders', lead_phone: '+31600000000',
  })]), false);
});

test('zonder andere afspraken is er niets herboekt', () => {
  assert.equal(heeftHerboekt(KIMBERLEY, [KIMBERLEY]), false);
  assert.equal(heeftHerboekt(KIMBERLEY, null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE CRON — de drie overslag-regels en de kaart
// ═══════════════════════════════════════════════════════════════════════════

test('de selectie leest alle statussen vanaf de grens, niet alleen cancelled', () => {
  // De herboek-vraag heeft de scheduled-afspraken nodig; alleen de
  // geannuleerde lezen zou die vraag onbeantwoordbaar maken.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function leesAfspraken');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 900);
  assert.doesNotMatch(blok, /\.eq\('status', 'cancelled'\)/);
  assert.match(bron, /const geannuleerd = afspraken\.filter\(\(a\) => String\(a\.status \|\| ''\)\.toLowerCase\(\) === 'cancelled'\)/);
  assert.match(blok, /annulering_reden_code/, 'de reden-velden moeten mee');
});

test('een bestaande kaart uit dezelfde afspraak houdt een tweede tegen — alle statussen', () => {
  // Ook een gearchiveerde: die betekent dat het al is afgehandeld, en opnieuw
  // aanmaken zou het werk laten terugkomen.
  const bron = readFileSync(CRON, 'utf8');
  assert.match(bron, /kaarten\.some\(\(k\) => k\.bron_ref && String\(k\.bron_ref\.appointment_id \|\| ''\) === String\(a\.id\)\)/);
  const i = bron.indexOf('async function leesKaarten');
  const blok = bron.slice(i, i + 500);
  assert.doesNotMatch(blok, /\.in\('status'/, 'geen statusfilter bij het lezen');
});

test('een lopende kaart op het nummer geeft een notitieregel in plaats van een tweede kaart', () => {
  const bron = readFileSync(CRON, 'utf8');
  assert.match(bron, /const bestaande = kaartOpNummer\(kaarten, a\.lead_phone\);/);
  assert.match(bron, /voegNotitieToe\(bestaande, bouwNotitieRegel\(a, vandaag\)\)/);

  // Zelfde nummermatch als zoekTaak in de webhook.
  const i = bron.indexOf('function kaartOpNummer');
  const blok = bron.slice(i, i + 700);
  assert.match(blok, /c\.slice\(-9\) === staart/);
  assert.match(blok, /LOPEND\.includes/);
});

test('dezelfde regel wordt niet twee keer toegevoegd', () => {
  // De cron draait elk kwartier. Zonder deze controle groeit de notitie elke
  // vijftien minuten met dezelfde zin.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function voegNotitieToe');
  assert.ok(i > 0);
  assert.match(bron.slice(i, i + 700), /if \(oud\.includes\(regel\)\) return false;/);
});

test('de kaart draagt de afgesproken velden', () => {
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function maakKaart');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1600);
  assert.match(blok, /reden\s*:\s*REDEN/);
  assert.match(bron, /const REDEN = 'zoom_geannuleerd'/);
  assert.match(blok, /reden_code\s*:\s*annuleerBron\(afspraak\)/);
  assert.match(blok, /soort\s*:\s*'zoom_geannuleerd'/);
  assert.match(blok, /annulering_reden_code\s*:\s*afspraak\.annulering_reden_code/);
  assert.match(blok, /due\s*:\s*vandaag/);
  assert.match(blok, /is_test\s*:\s*afspraak\.is_test === true/);
});

test('binnen één run levert een tweede annulering voor dezelfde lead geen tweede kaart op', () => {
  const bron = readFileSync(CRON, 'utf8');
  assert.match(bron, /kaarten\.push\(kaart\);/);
});

test('de summary telt per overslag-reden, plus aangemaakt en gesloten', () => {
  const bron = readFileSync(CRON, 'utf8');
  for (const sleutel of ['bekeken', 'aangemaakt', 'gesloten', 'herboekt',
    'kaart_bestaat_al', 'kaart_op_nummer', 'notitie_toegevoegd', 'errors']) {
    assert.match(bron, new RegExp('\\b' + sleutel + '\\b'), sleutel);
  }
  assert.match(bron, /console\.log\('\[cron-opvolging-annuleringen\] klaar'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE KAART SLUIT ZICHZELF
// ═══════════════════════════════════════════════════════════════════════════

test('een open zoom_geannuleerd-kaart gaat dicht zodra de lead zelf herboekt', () => {
  // Een kaart die blijft staan nadat hij zelf herboekte is een valse taak:
  // Dave belt iemand op om iets te regelen wat al geregeld is.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function sluitVervallenKaarten');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1400);
  assert.match(blok, /String\(k\.reden \|\| ''\) === REDEN/, 'alleen onze eigen kaarten');
  assert.match(blok, /String\(k\.status \|\| ''\) === 'open'/);
  assert.match(blok, /heeftHerboekt\(bron, afspraken\)/);
  assert.match(blok, /'zelf opnieuw ingepland'/);
  assert.match(blok, /archief_reden\s*:\s*tekst/);
  assert.match(blok, /\.eq\('status', 'open'\)/, 'niets doen als hij intussen dicht is');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE AGENDA TOONT HET
// ═══════════════════════════════════════════════════════════════════════════

test('een geannuleerde call met zo\'n kaart toont "geannuleerd · in je werklijst"', () => {
  // Zelfde mechaniek als no_show_call: de uitkomst staat niet in
  // follow_up_appointments.uitkomst maar in de werklijstkaart.
  const v = afrondLabelVanTaak({ reden: 'zoom_geannuleerd', reden_code: 'zelf_geannuleerd' });
  assert.equal(v.code, 'zoom_geannuleerd');
  assert.equal(v.label, 'geannuleerd · in je werklijst');

  // Ook bij een agenda-annulering.
  assert.equal(
    afrondLabelVanTaak({ reden: 'zoom_geannuleerd', reden_code: 'geannuleerd_in_agenda' }).label,
    'geannuleerd · in je werklijst');
});

test('de bestaande labels blijven werken', () => {
  assert.equal(afrondLabelVanTaak({ reden: 'no_show_call' }).label, 'niet gekomen · in je werklijst');
  assert.equal(afrondLabelVanTaak({ reden: 'afgemeld', reden_code: 'zoom_geen_interesse' }).label, 'geen interesse');
  assert.equal(afrondLabelVanTaak({ reden: 'zoom_nabellen' }), null, 'een nabelkaart rondt niets af');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · HET SCHEMA EN HET SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

test('de migratie voegt zoom_geannuleerd toe en behoudt de hele bestaande lijst', () => {
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-11-opvolging-zoom-geannuleerd.sql'), 'utf8');
  assert.match(sql, /BLOKKEREND/);
  assert.match(sql, /'zoom_geannuleerd'/);
  for (const reden of ['wil_nog_beslissen', 'no_show_event', 'no_show_call', 'afgemeld',
    'niet_ingepland', 'aanmelding', 'zoom_nabellen']) {
    assert.match(sql, new RegExp("'" + reden + "'"), reden + ' hoort behouden te blijven');
  }
});

test('de migratie is één atomair DO-block dat eerst controleert', () => {
  // De Supabase-editor knipt op statement-grenzen; state die tussen twee
  // blokken door moet overleven is er dan niet meer. En een vergeten waarde in
  // de overgetikte lijst laat elke toekomstige insert met die reden falen.
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-11-opvolging-zoom-geannuleerd.sql'), 'utf8');
  assert.equal((sql.match(/DO \$\$/g) || []).length, 1, 'precies één DO-block');
  assert.match(sql, /RAISE EXCEPTION/, 'stoppen als er een waarde zou wegvallen');
  assert.match(sql, /pg_get_constraintdef/, 'de huidige lijst uit de databank lezen');
  // DDL neemt geen PL/pgSQL-variabele aan; dat moet dynamische SQL zijn.
  assert.match(sql, /EXECUTE format\(/);
});

test('de cron staat elk kwartier in vercel.json', () => {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rij = (cfg.crons || []).find((c) => c.path === '/api/cron-opvolging-annuleringen');
  assert.ok(rij, 'de cron hoort in vercel.json te staan');
  assert.equal(rij.schedule, '*/15 * * * *');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9 · EEN AFGESLOTEN LEAD KRIJGT GEEN KAART
//
// GEMETEN OP 11 SEPTEMBER, de valse vierde kaart van de eerste echte run.
//
// Jeffrey Biemold (+31655270212, GHL-contact ZvTcan7kmMWG8GZgyoEr) kreeg
// 'Geannuleerd · call za 26/09 09:30 … plan hem opnieuw in'. Maar Dave had op
// 10 september om 12:48 al `wilt_niet_meer` vastgelegd — geen interesse — op
// een ándere afspraak van dezelfde lead ('jeffr reybiem', 9 september). De
// call van de 26e werd waarschijnlijk juist daarom geannuleerd.
//
// De cron keek alleen naar `uitkomst` op de geannuleerde afspraak zelf (die
// was leeg) en naar OPEN kaarten op het nummer (die waren er niet). Iemand die
// 'geen interesse' zei terugbellen om opnieuw in te plannen is precies wat
// deze module nooit mag doen.
// ═══════════════════════════════════════════════════════════════════════════

/** De geannuleerde call van 26 september, 09:30 Amsterdamse tijd. */
const JEFFREY_GEANNULEERD = {
  id: 'ap-j-26', lead_name: 'Jeffrey Biemold', lead_phone: '+31655270212',
  lead_ghl_contact_id: 'ZvTcan7kmMWG8GZgyoEr',
  scheduled_at: '2026-09-26T07:30:00.000Z', status: 'cancelled',
  uitkomst: null, is_test: false,
  annulering_sent_at: null, annulering_reden_code: null, annulering_reden: null,
};

/** De oudere afspraak waarop Dave 'geen interesse' vastlegde. */
const JEFFREY_AFGESLOTEN = {
  id: 'ap-j-09', lead_name: 'jeffr reybiem', lead_phone: '+31655270212',
  lead_ghl_contact_id: 'ZvTcan7kmMWG8GZgyoEr',
  scheduled_at: '2026-09-09T10:00:00.000Z', status: 'completed',
  uitkomst: 'wilt_niet_meer', is_test: false,
};

test('het gemeten geval: wilt_niet_meer op een ándere afspraak → geen kaart', () => {
  const alles = [JEFFREY_AFGESLOTEN, JEFFREY_GEANNULEERD];

  // Vóór de fix kwam hij hier ongehinderd doorheen: slaOver ziet niets
  // (uitkomst op de geannuleerde rij zelf is leeg) en herboekt is hij niet.
  assert.equal(slaOver(JEFFREY_GEANNULEERD), null, 'de voorcontrole vangt hem niet');
  assert.equal(heeftHerboekt(JEFFREY_GEANNULEERD, alles), false, 'en herboekt is hij niet');

  // De nieuwe regel wél.
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, alles, []), true);
});

test('idem voor sale — wie klant geworden is hoeft geen nieuwe verkoopcall', () => {
  const klant = { ...JEFFREY_AFGESLOTEN, id: 'ap-j-sale', uitkomst: 'sale' };
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [klant, JEFFREY_GEANNULEERD], []), true);
});

test('en voor de andere twee eindpunten, in beide spellingen', () => {
  for (const u of ['geen_interesse', 'niet_geschikt', 'WILT_NIET_MEER', ' sale ']) {
    const rij = { ...JEFFREY_AFGESLOTEN, id: 'ap-' + u, uitkomst: u };
    assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [rij], []), true, u);
  }
});

test('een lead die gewoon doorleeft blijft werk', () => {
  // Deze uitkomsten staan met opzet NIET in de lijst: daar is het gesprek nog
  // niet klaar. 'gesprek_gehad' staat wél in AGENDA_REMOVING_OUTCOMES, maar
  // dat gaat over het opruimen van de Zoom-meeting, niet over de lead.
  for (const u of ['gesprek_gehad', 'no_show', 'later_opnieuw', 'terugbel',
    'verzetten', 'annuleren', 'snooze', 'whatsapp_gestuurd', 'voicemail',
    'geen_gehoor', 'zoom_ingepland', 'bevestigd', 'komt_niet', '']) {
    const rij = { ...JEFFREY_AFGESLOTEN, id: 'ap-' + u, uitkomst: u };
    assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [rij], []), false, u);
  }
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [JEFFREY_GEANNULEERD], []), false);
});

test('de uitkomst van een ándere lead telt niet mee', () => {
  // Dat zou de regel van een bescherming in een blinddoek veranderen.
  const vreemde = {
    id: 'ap-x', lead_phone: '+31699998888', lead_ghl_contact_id: 'ghl-x',
    status: 'completed', uitkomst: 'wilt_niet_meer',
  };
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [vreemde], []), false);
});

test('zonder GHL-contact matcht het nummer, ook zonder landcode', () => {
  const zonderContact = { ...JEFFREY_GEANNULEERD, lead_ghl_contact_id: null };
  const lokaal = { id: 'ap-l', lead_phone: '0655270212', lead_ghl_contact_id: null,
    status: 'completed', uitkomst: 'wilt_niet_meer' };
  assert.equal(zelfdeLead(zonderContact, lokaal), true);
  assert.equal(leadAlAfgesloten(zonderContact, [lokaal], []), true);
});

test('een gearchiveerde kaart die zegt "geen interesse" telt óók', () => {
  // De tweede uitgang: de lead haakte af via de aanmeldkaart of de
  // zoom-uitgang, en er is helemaal geen afspraak-uitkomst.
  const viaCode = { id: 't1', telefoon: '+31655270212', status: 'gearchiveerd',
    reden_code: 'zoom_geen_interesse', archief_reden: null };
  const viaReden = { id: 't2', telefoon: '+31655270212', status: 'gearchiveerd',
    reden_code: null, archief_reden: 'geen interesse of per ongeluk aangemeld' };

  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [], [viaCode]), true);
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [], [viaReden]), true);
});

test('een gearchiveerde kaart om een ándere reden telt niet', () => {
  // 'verplaatst naar ander event', 'gesprek gehad', 'zelf opnieuw ingepland':
  // allemaal geen afsluiting van de lead.
  for (const reden of ['verplaatst naar ander event', 'gesprek gehad',
    'zelf opnieuw ingepland', 'antwoord ontvangen op WhatsApp', '']) {
    const k = { id: 't', telefoon: '+31655270212', status: 'gearchiveerd',
      reden_code: 'iets_anders', archief_reden: reden };
    assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [], [k]), false, reden);
  }
  // En een OPEN kaart is geen afsluiting, wat er ook op staat.
  const open = { id: 't', telefoon: '+31655270212', status: 'open',
    reden_code: 'zoom_geen_interesse', archief_reden: null };
  assert.equal(leadAlAfgesloten(JEFFREY_GEANNULEERD, [], [open]), false);
});

test('de woordenlijst is uit de twee outcome-motoren overgenomen, niet verzonnen', () => {
  // De motoren blijven ongemoeid; deze test dwingt af dat elke waarde die we
  // als eindpunt behandelen daar ook echt bestaat. Hernoemt iemand er één,
  // dan wordt dit rood in plaats van dat de bescherming stil vervalt.
  const woordenlijst = (bestand) => {
    const bron = readFileSync(join(ROOT, bestand), 'utf8');
    const i = bron.indexOf('const OUTCOMES = new Set([');
    assert.ok(i > 0, bestand + ' hoort een OUTCOMES-lijst te hebben');
    const blok = bron.slice(i, bron.indexOf(']);', i));
    return new Set([...blok.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
  };
  const bekend = new Set([
    ...woordenlijst('api/follow-up-appointment-outcome.js'),
    ...woordenlijst('api/follow-up-lead-outcome.js'),
  ]);
  for (const u of EINDPUNT_UITKOMSTEN) {
    assert.ok(bekend.has(u), u + ' hoort in een van de twee OUTCOMES-lijsten te staan');
  }
});

// ── DE CRON GEBRUIKT DE REGEL OOK ECHT ─────────────────────────────────────

test('de cron slaat een afgesloten lead over, vóór de kaart-controles', () => {
  // De volgorde is geen smaak: de valse kaart van 11 september STAAT er al
  // (gearchiveerd met de hand). Stond deze controle ná (b), dan telde de run
  // hem als 'kaart_bestaat_al' en bleef onzichtbaar dat de regel werkt.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('leadAlAfgesloten(a, afspraken, kaarten)');
  const j = bron.indexOf('overgeslagen.kaart_bestaat_al');
  assert.ok(i > 0, 'de cron hoort leadAlAfgesloten aan te roepen');
  assert.ok(j > i, 'en wel vóór de kaart_bestaat_al-controle');
  assert.match(bron, /overgeslagen\.lead_al_afgesloten \+= 1/);
  assert.match(bron, /lead_al_afgesloten: 0/, 'de teller hoort in de summary te staan');
});

test('de cron leest archief_reden mee — anders is de halve regel blind', () => {
  // leadAlAfgesloten leest k.archief_reden. Staat die kolom niet in de select,
  // dan is hij altijd undefined en vervalt de kaart-tak geruisloos.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function leesKaarten');
  assert.ok(i > 0);
  assert.match(bron.slice(i, i + 600), /archief_reden/);
});

test('een open kaart voor een lead die alsnog afhaakt gaat dicht', () => {
  // De sluitregel, want de uitkomst kan NA het aanmaken worden vastgelegd:
  // de kaart staat er dan al en zou blijven staan.
  const bron = readFileSync(CRON, 'utf8');
  const i = bron.indexOf('async function sluitVervallenKaarten');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2200);
  assert.match(blok, /leadAlAfgesloten\(bron, afspraken, kaarten\)/);
  assert.match(blok, /'lead al afgesloten \(geen interesse \/ klant\)'/);
  assert.match(blok, /\.eq\('status', 'open'\)/, 'niets doen als hij intussen dicht is');
  // Herboekt blijft voorgaan: dat is de vrolijkere waarheid van de twee.
  assert.ok(blok.indexOf('heeftHerboekt(bron, afspraken)')
          < blok.indexOf('leadAlAfgesloten(bron, afspraken, kaarten)'));
});
