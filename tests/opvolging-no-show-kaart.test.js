// tests/opvolging-no-show-kaart.test.js
//
// EEN NO-SHOW WORDT EEN KAART, ONGEACHT WIE HEM ZO GEZET HEEFT.
//
// De keten: de zoomcalls van 8 september die no-show werden zijn nooit door
// Dave in de opvolgmodule als no-show gemarkeerd, dus is er nooit een kaart
// ontstaan, dus zijn Mehran Jahani en Sebastian Kolodziejski nooit meegekomen
// naar vandaag.
//
// De bestaande weg — de knop 'Afronden → no-show' — werkt aantoonbaar: er staan
// vier kaarten met bron_ref.source 'opvolging-call'. Het probleem is dat het de
// enige aanleiding is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  bepaalNoShowKaart, kaartNotitie, kaartenPerAfspraak, NO_SHOW_VANAF, REDEN, BRON,
  AANMAKEN, NIETS, GEEN_NO_SHOW, VOOR_DE_GRENS, AL_EEN_KAART, GEEN_ID,
} from '../api/_lib/opvolging-no-show.js';

// Een no-show van VANDAAG. Mehran en Sebastian zijn van 8 september en vallen
// bewust buiten de grens — zie het blok over de grens hieronder.
const VANDAAG_NO_SHOW = {
  id: 'appt-vandaag', lead_name: 'Iemand Van Vandaag', status: 'no_show',
  scheduled_at: '2026-09-09T16:00:00Z', lead_phone: '+32470111222',
  lead_email: 'iemand@example.com', zoom_join_url: 'https://zoom.us/j/1',
};

// ═══════════════════════════════════════════════════════════════════════════
// DE AANLEIDING
// ═══════════════════════════════════════════════════════════════════════════

test('een no-show van vandaag krijgt een kaart', () => {
  const b = bepaalNoShowKaart({ afspraak: VANDAAG_NO_SHOW });
  assert.equal(b.actie, AANMAKEN);
  assert.equal(b.dag, '2026-09-09');
  assert.equal(b.tijd, '18:00');
});

test('en de reden staat er in Daves taal op', () => {
  assert.equal(kaartNotitie(VANDAAG_NO_SHOW), 'Kwam niet opdagen bij de zoomcall van 9 september om 18:00.');
});

test('met het nummer en de zoomlink erbij, zodat nabellen in een handeling kan', () => {
  const { kaart } = bepaalNoShowKaart({ afspraak: VANDAAG_NO_SHOW });
  assert.equal(kaart.telefoon, '+32470111222');
  assert.equal(kaart.bron_ref.zoom_url, 'https://zoom.us/j/1');
});

test('een afspraak die geen no-show is levert niets op', () => {
  for (const status of ['scheduled', 'completed', 'cancelled', 'in_progress']) {
    const b = bepaalNoShowKaart({ afspraak: { ...VANDAAG_NO_SHOW, status } });
    assert.equal(b.actie, NIETS, status);
    assert.equal(b.code, GEEN_NO_SHOW, status);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RANDVOORWAARDE 1 — GEEN DUBBELE KAARTEN
// ═══════════════════════════════════════════════════════════════════════════

test('drukte Dave zelf al op no-show, dan komt er GEEN tweede kaart', () => {
  // Het geval dat expliciet benoemd is: de knop maakt een kaart, en daarna komt
  // de status nog eens langs. Eén kaart, niet twee.
  const b = bepaalNoShowKaart({ afspraak: VANDAAG_NO_SHOW, kaartVanAfspraak: { id: 'taak-1' } });
  assert.equal(b.actie, NIETS);
  assert.equal(b.code, AL_EEN_KAART);
  assert.equal(b.taak_id, 'taak-1');
});

test('de sleutel is het appointment_id — niet de naam, niet het nummer', () => {
  // Naam en nummer zijn te zwak: er zijn mensen met dezelfde naam. De kaart die
  // de knop zet draagt bron_ref.appointment_id, en dat is waarop ontdubbeld
  // wordt.
  const { kaart } = bepaalNoShowKaart({ afspraak: VANDAAG_NO_SHOW });
  assert.equal(kaart.bron_ref.appointment_id, 'appt-vandaag');

  // Een naamgenoot met een ANDERE afspraak krijgt gewoon zijn eigen kaart.
  const naamgenoot = { ...VANDAAG_NO_SHOW, id: 'appt-ander' };
  assert.equal(bepaalNoShowKaart({ afspraak: naamgenoot, kaartVanAfspraak: null }).actie, AANMAKEN);
});

test('zonder appointment_id gebeurt er niets, in plaats van elke run een nieuwe kaart', () => {
  const b = bepaalNoShowKaart({ afspraak: { ...VANDAAG_NO_SHOW, id: null } });
  assert.equal(b.actie, NIETS);
  assert.equal(b.code, GEEN_ID);
});

// ═══════════════════════════════════════════════════════════════════════════
// RANDVOORWAARDE 2 — ALLEEN VANAF DE GRENS
// ═══════════════════════════════════════════════════════════════════════════

test('de grens staat op 9 september — de hele achterstand blijft buiten schot', () => {
  // Gemeten: 110 no-show-afspraken over 101 personen, waarvan er 108 vóór
  // 7 september liggen. Die zitten al in de warme-leadslijst die gedripfeed
  // wordt. Twee zijn er nieuw: Mehran en Sebastian van 8 september.
  assert.equal(NO_SHOW_VANAF, '2026-09-09');
});

test('Mehran en Sebastian van 8 september komen hier bewust NIET in', () => {
  // Zij worden zichtbaar in het dagbeeld en kan Dave zelf afronden. Dat is de
  // nettere weg: een mens die een uitkomst vastlegt, in plaats van kaarten met
  // terugwerkende kracht verzinnen.
  for (const naam of ['Mehran Jahani', 'Sebastian Kolodziejski']) {
    const b = bepaalNoShowKaart({ afspraak: {
      ...VANDAAG_NO_SHOW, id: 'appt-' + naam, lead_name: naam,
      scheduled_at: '2026-09-08T16:00:00Z',
    } });
    assert.equal(b.actie, NIETS, naam);
    assert.equal(b.code, VOOR_DE_GRENS, naam);
  }
});

test('en de 108 uit de historie al helemaal niet', () => {
  for (const dag of ['2026-09-06', '2026-08-27', '2026-06-01']) {
    const b = bepaalNoShowKaart({ afspraak: { ...VANDAAG_NO_SHOW, scheduled_at: dag + 'T16:00:00Z' } });
    assert.equal(b.code, VOOR_DE_GRENS, dag);
  }
});

test('de grens ligt op de AMSTERDAMSE dag van de afspraak', () => {
  // Een call van 8 september 23:30 Amsterdamse tijd is 21:30 UTC. Wie op de
  // UTC-datum grenst telt die verkeerd — dezelfde val als de doorrol.
  const laat  = { ...VANDAAG_NO_SHOW, scheduled_at: '2026-09-08T21:30:00Z' };  // 23:30 op de 8e
  assert.equal(bepaalNoShowKaart({ afspraak: laat }).code, VOOR_DE_GRENS);
  const vroeg = { ...VANDAAG_NO_SHOW, scheduled_at: '2026-09-08T22:30:00Z' };  // 00:30 op de 9e
  assert.equal(bepaalNoShowKaart({ afspraak: vroeg }).actie, AANMAKEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE ONTDUBBELING ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('kaartenPerAfspraak zet bestaande kaarten op hun appointment_id', () => {
  // Dit IS de ontdubbeling, dus die hoort in een test en niet alleen in de cron.
  const map = kaartenPerAfspraak([
    { id: 't1', bron_ref: { appointment_id: 'a1', source: 'opvolging-call' } },
    { id: 't2', bron_ref: { appointment_id: 'a2', source: 'opvolging-no-show-sync' } },
    { id: 't3', bron_ref: null },
    { id: 't4', bron_ref: { start: 'x' } },
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get('a1').id, 't1');
});

test('een kaart die de KNOP maakte telt net zo goed als bestaand', () => {
  // Het geval dat expliciet benoemd is: Dave drukt op no-show, de cron komt
  // daarna langs. Beide dragen bron_ref.appointment_id, dus de cron ziet hem.
  const vanDeKnop = kaartenPerAfspraak([
    { id: 'taak-van-dave', bron_ref: { appointment_id: 'appt-vandaag', source: 'opvolging-call' } },
  ]);
  const b = bepaalNoShowKaart({
    afspraak: VANDAAG_NO_SHOW,
    kaartVanAfspraak: vanDeKnop.get('appt-vandaag') || null,
  });
  assert.equal(b.actie, NIETS);
  assert.equal(b.code, AL_EEN_KAART);
  assert.equal(b.taak_id, 'taak-van-dave');
});

test('twee kaarten voor dezelfde afspraak leveren er één op', () => {
  const map = kaartenPerAfspraak([
    { id: 't1', bron_ref: { appointment_id: 'a1' } },
    { id: 't2', bron_ref: { appointment_id: 'a1' } },
  ]);
  assert.equal(map.size, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DEZELFDE KAARTVORM ALS DE KNOP
// ═══════════════════════════════════════════════════════════════════════════

test('reden en bron zijn precies wat api/opvolging-taak-create.js toestaat', () => {
  // Geen nieuwe machinerie: dezelfde weg. Zou de cron een reden gebruiken die
  // het endpoint niet kent, dan lopen de twee kaartsoorten uiteen en telt het
  // scherm ze anders.
  const bron = readFileSync('api/opvolging-taak-create.js', 'utf8');
  const redenen = bron.match(/const REDENEN\s*=\s*new Set\(\[([^\]]+)\]/)[1];
  const bronnen = bron.match(/const BRONNEN\s*=\s*new Set\(\[([^\]]+)\]/)[1];
  assert.match(redenen, new RegExp("'" + REDEN + "'"), 'de reden hoort bij de bestaande set');
  assert.match(bronnen, new RegExp("'" + BRON + "'"), 'de bron hoort bij de bestaande set');
});

test('en de knop gebruikt diezelfde reden', () => {
  const view = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  assert.match(view, new RegExp("reden\\s*:\\s*uitkomst === 'no_show' \\? '" + REDEN + "'"),
    'de knop en de cron horen dezelfde kaartsoort te maken');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP HET PAD DAT ECHT DRAAIT
// ═══════════════════════════════════════════════════════════════════════════

test('de cron zoekt de bestaande kaarten ook echt op', () => {
  // Sabotage die eerst NUL rood gaf: het statusfilter in deze query kapot
  // maken. Dan vindt de cron geen enkele bestaande kaart en maakt hij naast
  // elke kaart van Dave een tweede. De ontdubbelingsLOGICA staat inmiddels in
  // kaartenPerAfspraak en is hierboven getest; dit bewaakt de QUERY die hem
  // voedt, en dat kan alleen op de brontekst.
  const bron = readFileSync('api/cron-opvolging-no-show.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.match(bron, /\.eq\('reden', REDEN\)/);
  assert.match(bron, /\.neq\('status', 'gearchiveerd'\)/,
    'zonder dit filter mist de cron bestaande kaarten en ontstaan er dubbele');
  assert.match(bron, /kaartenPerAfspraak\(kaartRijen\)/);
  assert.match(bron, /kaartVanAfspraak: kaartPerAfspraak\.get\(String\(a\.id\)\)/);
});

test('de cron kent een droge run, zodat je kunt tellen voor je de grens verzet', () => {
  const bron = readFileSync('api/cron-opvolging-no-show.js', 'utf8');
  assert.match(bron, /droog/);
  assert.match(bron, /if \(droog\) \{ summary\.aangemaakt \+= 1; continue; \}/);
});
