// tests/opvolging-aanmelding.test.js
//
// Wanneer wordt een aanmelding voor een event een taak, en wanneer sluit die
// taak zichzelf weer?
//
// Twee dingen die hier stil fout kunnen gaan:
//
//  · De instroom hangt aan de DEELNEMERRIJ, niet aan het inschrijfmoment. Een
//    verplaatsing (api/events-attendee-move.js) maakt een nieuwe rij op het
//    doel-event met status 'aangemeld' en een verse registered_at. Wie aan het
//    inschrijf-endpoint hangt, mist die persoon volledig — en dat merk je pas
//    als er iemand niet gebeld is.
//
//  · Eén kaart per persoon per event. Moment A (de aanmelding) en moment B
//    (vier dagen voor het event) mogen samen nooit twee kaarten opleveren, en
//    B mag een kaart die Dave bewust archiveerde niet uit de dood wekken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bepaalTaakActie, dueVoorAanmelding, dagPlus, dagenTussen, dagInZone,
  badgeVoorEvent, isEchtContact, heeftEchtContact, drempelGeldt,
  WAKKER_DAGEN_VOOR_EVENT, MASTERCLASS_NIVEAU,
} from '../api/_lib/opvolging-aanmelding.js';

// 5 september 2026, 10:00 Amsterdamse tijd (zomertijd, UTC+2).
const NU = Date.parse('2026-09-05T08:00:00Z');
const VANDAAG = '2026-09-05';

const ev = (over) => ({
  id: 'ev-1', title: 'Masterclass', location: 'Gent',
  starts_at: '2026-09-20T17:00:00Z', ...over,
});
const att = (over) => ({
  id: 'att-1', status: 'aangemeld',
  registered_at: '2026-09-05T07:50:00Z', switched_from_event_id: null, ...over,
});
const doe = (over = {}) => bepaalTaakActie({ attendee: att(over.attendee), event: ev(over.event), taak: over.taak ?? null, nu: NU });

// ═══════════════════════════════════════════════════════════════════════════
// MOMENT A EN B — ÉÉN KAART
// ═══════════════════════════════════════════════════════════════════════════

test('een verse aanmelding ver vooraf krijgt een slapende kaart', () => {
  // Event op 20 september, dus wakker op de 16e. Tot dan staat hij niet in de
  // lijst: de dagweergave toont alleen due <= vandaag.
  const r = doe();
  assert.equal(r.actie, 'aanmaken');
  assert.equal(r.reden, 'aanmelding');
  assert.equal(r.due, '2026-09-16');
  assert.equal(r.event_dag, '2026-09-20');
});

test('meldt iemand zich binnen vier dagen aan, dan vallen A en B samen', () => {
  // Event overmorgen: wakker-dag ligt in het verleden, dus vandaag.
  const r = doe({ event: { starts_at: '2026-09-07T17:00:00Z' } });
  assert.equal(r.actie, 'aanmaken');
  assert.equal(r.due, VANDAAG, 'één kaart, meteen in de lijst');
});

test('de due ligt nooit in het verleden', () => {
  // Anders komt een verse kaart binnen met de melding 'bleef liggen' terwijl
  // er niets bleef liggen.
  assert.equal(dueVoorAanmelding({ eventDag: '2026-09-06', vandaag: VANDAAG }), VANDAAG);
  assert.equal(dueVoorAanmelding({ eventDag: '2026-09-20', vandaag: VANDAAG }), '2026-09-16');
  assert.equal(dagenTussen(dueVoorAanmelding({ eventDag: '2026-09-20', vandaag: VANDAAG }), '2026-09-20'),
    WAKKER_DAGEN_VOOR_EVENT);
});

test('moment B maakt de bestaande kaart wakker in plaats van een tweede', () => {
  const taak = { id: 't-1', status: 'open', due: '2026-09-16' };
  // Nu is het de 16e geworden: het event is over vier dagen.
  const r = bepaalTaakActie({
    attendee: att(), event: ev({ starts_at: '2026-09-09T17:00:00Z' }), taak, nu: NU,
  });
  assert.equal(r.actie, 'wakker_maken');
  assert.equal(r.taak_id, 't-1');
  assert.equal(r.due, VANDAAG);
});

test('een kaart die al op vandaag staat wordt niet nog eens aangeraakt', () => {
  const taak = { id: 't-1', status: 'open', due: VANDAAG };
  assert.equal(doe({ event: { starts_at: '2026-09-07T17:00:00Z' }, taak }).actie, 'niets');
});

test('een gearchiveerde kaart wordt NIET uit de dood gewekt', () => {
  // Dave heeft hem bewust weggezet. Moment B mag dat niet ongedaan maken.
  const taak = { id: 't-1', status: 'gearchiveerd', due: '2026-09-01' };
  assert.equal(doe({ event: { starts_at: '2026-09-07T17:00:00Z' }, taak }).actie, 'niets');
});

test('kaarten die al ingepland staan of op verplaatsing wachten blijven met rust', () => {
  for (const status of ['ingepland', 'wacht_verplaatsing', 'wacht_inplanning']) {
    const taak = { id: 't-1', status, due: '2026-09-01' };
    assert.equal(doe({ event: { starts_at: '2026-09-07T17:00:00Z' }, taak }).actie, 'niets', status);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VERPLAATSING
// ═══════════════════════════════════════════════════════════════════════════

test('een verplaatste deelnemer krijgt gewoon een kaart voor het nieuwe event', () => {
  // events-attendee-move maakt een nieuwe rij met status 'aangemeld' en
  // switched_from_event_id gezet. Die moet dezelfde weg in als een verse
  // aanmelding — anders mist de opwarmflow precies deze mensen.
  const r = doe({ attendee: { switched_from_event_id: 'ev-oud' } });
  assert.equal(r.actie, 'aanmaken');
  assert.equal(r.verplaatst, true, 'de kaart moet kunnen tonen dat dit een verplaatsing is');
});

test('de oude kaart sluit zichzelf zodra de bronrij verplaatst is', () => {
  // Betrouwbaarder dan de popup: dit is een meting van wat er in de eventmodule
  // echt gebeurd is, niet van wat Dave aanklikte.
  const taak = { id: 't-oud', status: 'open', due: VANDAAG };
  const r = doe({ attendee: { status: 'switched_to_other_event' }, taak });
  assert.equal(r.actie, 'sluiten_verplaatst');
  assert.equal(r.taak_id, 't-oud');
});

test('een geannuleerde deelnemer sluit zijn kaart ook', () => {
  const taak = { id: 't-1', status: 'open', due: VANDAAG };
  assert.equal(doe({ attendee: { status: 'geannuleerd' }, taak }).actie, 'sluiten_geannuleerd');
});

test('een al gearchiveerde kaart wordt niet nog eens gesloten', () => {
  const taak = { id: 't-1', status: 'gearchiveerd', due: VANDAAG };
  assert.equal(doe({ attendee: { status: 'switched_to_other_event' }, taak }).actie, 'niets');
});

test('zonder kaart levert een verplaatste of geannuleerde rij niets op', () => {
  for (const status of ['switched_to_other_event', 'geannuleerd', 'no_show', 'aanwezig', 'wachtlijst']) {
    assert.equal(doe({ attendee: { status } }).actie, 'niets', status);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GRENZEN
// ═══════════════════════════════════════════════════════════════════════════

test('een event dat al geweest is levert geen instroom meer op', () => {
  // Vanaf dat moment neemt Event afronden het over.
  assert.equal(doe({ event: { starts_at: '2026-09-04T17:00:00Z' } }).actie, 'niets');
  // De dag van het event zelf telt nog wel mee.
  assert.equal(doe({ event: { starts_at: '2026-09-05T19:00:00Z' } }).actie, 'aanmaken');
});

test('een event laat op de avond blijft op de juiste dag staan', () => {
  // 22:30Z op de 19e is 00:30 lokaal op de 20e. Op de UTC-dag afgaan zou de
  // wakker-dag een dag te vroeg zetten.
  assert.equal(dagInZone(Date.parse('2026-09-19T22:30:00Z')), '2026-09-20');
  const r = doe({ event: { starts_at: '2026-09-19T22:30:00Z' } });
  assert.equal(r.event_dag, '2026-09-20');
  assert.equal(r.due, '2026-09-16');
});

test('de wakker-dag klopt over een tijdzonesprong heen', () => {
  // 25 oktober gaat de klok terug. Vier dagen ervoor is de 21e, ongeacht de
  // sprong — kalenderrekenwerk, geen uren optellen.
  assert.equal(dagPlus('2026-10-25', -4), '2026-10-21');
  assert.equal(dagPlus('2026-03-29', -4), '2026-03-25');
});

test('rommelige invoer levert niets op in plaats van een uitzondering', () => {
  assert.equal(bepaalTaakActie({ attendee: null, event: ev(), nu: NU }).actie, 'niets');
  assert.equal(bepaalTaakActie({ attendee: att(), event: null, nu: NU }).actie, 'niets');
  assert.equal(bepaalTaakActie({ attendee: att(), event: ev({ starts_at: 'ooit' }), nu: NU }).actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// ECHT CONTACT — bepaalt of de kaart morgen terugkomt
// ═══════════════════════════════════════════════════════════════════════════

test('een telefoon die overgaat is geen contact', () => {
  // De kern. Zou dit meetellen, dan verdwijnt iemand uit de lijst zonder dat
  // er ooit iemand mee gesproken heeft.
  assert.equal(isEchtContact({ soort: 'call', resultaat: 'niet opgenomen' }), false);
  assert.equal(isEchtContact({ soort: 'call', resultaat: 'gesproken' }), true);
});

test('een bericht van de lead telt, een bericht van ons niet', () => {
  assert.equal(isEchtContact({ soort: 'whatsapp', resultaat: 'antwoord ontvangen: ja' }), true);
  assert.equal(isEchtContact({ soort: 'spraakbericht', resultaat: 'spraakbericht ontvangen' }), true);
  assert.equal(isEchtContact({ soort: 'whatsapp', resultaat: 'WhatsApp verstuurd' }), false);
  assert.equal(isEchtContact({ soort: 'spraakbericht', resultaat: 'spraakbericht verstuurd' }), false);
  assert.equal(isEchtContact({ soort: 'whatsapp', resultaat: 'WhatsApp gelezen' }), false,
    'gelezen is geen reactie');
});

test('andere soorten tellen nooit als contact', () => {
  for (const soort of ['agenda_doorgestuurd', 'ingepland', '', null]) {
    assert.equal(isEchtContact({ soort, resultaat: 'gesproken' }), false, String(soort));
  }
  assert.equal(isEchtContact(null), false);
});

test('heeftEchtContact kijkt naar de hele historiek', () => {
  assert.equal(heeftEchtContact([
    { soort: 'call', resultaat: 'niet opgenomen' },
    { soort: 'call', resultaat: 'gesproken, wil nog beslissen' },
  ]), true);
  assert.equal(heeftEchtContact([{ soort: 'call', resultaat: 'niet opgenomen' }]), false);
  assert.equal(heeftEchtContact([]), false);
  assert.equal(heeftEchtContact(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE ARCHIVEERDREMPEL
// ═══════════════════════════════════════════════════════════════════════════

test('zolang het event nog moet komen geldt de drempel niet', () => {
  // Die mensen komen misschien gewoon opdagen; 'genoeg moeite gedaan' is dan
  // de verkeerde vraag.
  assert.equal(drempelGeldt({ eventDag: '2026-09-20', vandaag: VANDAAG }), false);
  assert.equal(drempelGeldt({ eventDag: VANDAAG, vandaag: VANDAAG }), false, 'de dag zelf ook niet');
  assert.equal(drempelGeldt({ eventDag: '2026-09-04', vandaag: VANDAAG }), true, 'daarna weer wel');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ETIKET
// ═══════════════════════════════════════════════════════════════════════════

test('het badge-label draagt naam, plaats en moment', () => {
  assert.equal(badgeVoorEvent(ev()), 'Masterclass Gent · 20 sep 19:00');
});

test('ontbrekende delen vallen weg zonder rare tekens', () => {
  assert.equal(badgeVoorEvent(ev({ location: null })), 'Masterclass · 20 sep 19:00');
  assert.equal(badgeVoorEvent(ev({ title: null, location: null })), '20 sep 19:00');
  assert.equal(badgeVoorEvent({ starts_at: 'ooit' }), null);
  assert.equal(badgeVoorEvent(null), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// WELKE EVENTS TELLEN MEE
// ═══════════════════════════════════════════════════════════════════════════

test('het niveau is de slug die de eventmodule gebruikt', () => {
  // De keuzelijst boven de eventlijst wordt gevuld uit event_niveau_options
  // (is_active) en events.niveau verwijst naar diezelfde slug. Op productie is
  // dat 'masterclass'. De seed in 2026-06-11-events-f1-foundation.sql noemt
  // 'basis' en 'gevorderd' — dat is de begintoestand, niet de huidige.
  assert.equal(MASTERCLASS_NIVEAU, 'masterclass');
});

test('de cron selecteert events op dat niveau', () => {
  // Zonder deze test kan het filter er ongemerkt uit vallen bij een refactor,
  // en dan stromen alle events weer binnen zodra er een tweede soort bestaat —
  // zichtbaar pas als Dave mensen belt die niet in zijn lijst horen.
  const bron = readFileSync(new URL('../api/cron-opvolging-aanmeldingen.js', import.meta.url), 'utf8');
  assert.match(bron, /\.eq\('niveau',\s*MASTERCLASS_NIVEAU\)/,
    'de events-query hoort op MASTERCLASS_NIVEAU te filteren');
  assert.match(bron, /events_ander_niveau/,
    'wat het filter buiten de deur houdt hoort geteld te worden, anders is een vergeten niveau onzichtbaar');
});
