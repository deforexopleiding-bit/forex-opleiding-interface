// tests/events-geen-gehoor-automatisatie.test.js
//
// DE AUTOMATISATIE EN DE TEKSTEN.
//
// De INSERT en de twee UPDATEs staan als bestand in docs/sql-migrations/ —
// Cowork draait ze, niet deze sessie. Wat een test hier wél kan vastleggen:
//
//   1. de deadline in de mail wordt berekend door DEZELFDE functie als de
//      bovengrens van de wachtstap. Lopen die uiteen, dan belooft de mail een
//      moment waarop de automatisatie al gehandeld heeft;
//   2. de variabele {{attendee.geen_gehoor_deadline}} bestaat, rendert, en
//      geeft een lege string als er geen nulpunt is;
//   3. de migratie zelf: de vijf stappen in de juiste volgorde, uit aan,
//      new_only, en de teksten die Maxim heeft vastgelegd.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  geenGehoorDeadline, formatDeadlineNl, plafondMs,
  GEEN_GEHOOR_UREN_NA_BELSTATUS, GEEN_GEHOOR_UITERLIJK_UREN_VOOR_EVENT,
} from '../api/_lib/geen-gehoor-deadline.js';
import { applyWaitCeiling, computeNextRunAt } from '../api/_lib/events-automation-engine.js';
import { resolveVariables, AVAILABLE_VARIABLES } from '../api/_lib/template-variables.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SQL  = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-14-events-geen-gehoor-laatste-kans.sql'), 'utf8');

// Werner De Kesel, Forex Masterclass Gent 26/09 — het geval uit de meting.
const BELSTATUS_AT = '2026-09-14T11:05:00.000Z';
const GENT         = '2026-09-26T17:00:00.000Z';

// ═══════════════════════════════════════════════════════════════════════════
// DE DEADLINE — 48 UUR, MAAR NOOIT TE LAAT
// ═══════════════════════════════════════════════════════════════════════════

test('de twee getallen zijn beide 48', () => {
  assert.equal(GEEN_GEHOOR_UREN_NA_BELSTATUS, 48);
  assert.equal(GEEN_GEHOOR_UITERLIJK_UREN_VOOR_EVENT, 48);
});

test('ruim voor het event is de deadline gewoon 48 uur later', () => {
  const d = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: GENT });
  assert.equal(d.toISOString(), '2026-09-16T11:05:00.000Z');
});

test('dichtbij het event wint de bovengrens', () => {
  // Event op 17 september 12:00 → 48 uur ervoor is 15 september 12:00, en dat
  // is eerder dan 48 uur na de belstatus (16 september 11:05).
  const d = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: '2026-09-17T12:00:00.000Z' });
  assert.equal(d.toISOString(), '2026-09-15T12:00:00.000Z');
});

test('ligt de grens al vóór de belstatus, dan is de belstatus zelf de deadline', () => {
  // Event over minder dan 48 uur: de deadline was verstreken op het moment dat
  // ze gesteld werd. De automatisatie gaat dan meteen door, en de tekst hoort
  // dat ook te zeggen in plaats van een moment in het verleden te noemen.
  const d = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: '2026-09-15T12:00:00.000Z' });
  assert.equal(d.toISOString(), BELSTATUS_AT);
});

test('zonder nulpunt is er GEEN deadline — geen verzonnen datum', () => {
  for (const at of [null, undefined, '', 'gisteren']) {
    assert.equal(geenGehoorDeadline({ callStatusAt: at, eventStartsAt: GENT }), null, 'at=' + String(at));
  }
});

test('zonder leesbare eventdatum blijft de kale 48 uur staan', () => {
  const d = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: 'binnenkort' });
  assert.equal(d.toISOString(), '2026-09-16T11:05:00.000Z');
});

test('de deadline leest als Nederlandse tekst in Amsterdamse tijd', () => {
  const d = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: GENT });
  // 16 september 11:05 UTC = 13:05 in Amsterdam (zomertijd).
  const tekst = formatDeadlineNl(d);
  assert.match(tekst, /^woensdag 16 september om 13:05$/);
  assert.equal(formatDeadlineNl('rommel'), '');
  assert.equal(formatDeadlineNl(null), '');
});

test('ÉÉN DEFINITIE: de mail en de wachtstap rekenen met dezelfde grens', () => {
  // Dit is de test die het waard is. De wachtstap bepaalt WANNEER de plek
  // vervalt; de mail vertelt de deelnemer WANNEER. Lopen die uiteen, dan is de
  // mail een leugen — in de ene of in de andere richting.
  const gevallen = [
    ['ruim voor het event', GENT],
    ['net binnen de grens', '2026-09-17T12:00:00.000Z'],
    ['grens al verstreken', '2026-09-15T12:00:00.000Z'],
    ['event zonder datum',  null],
  ];
  const nuMs = Date.parse(BELSTATUS_AT);
  for (const [naam, start] of gevallen) {
    const uitMail = geenGehoorDeadline({ callStatusAt: BELSTATUS_AT, eventStartsAt: start });
    const uitStap = applyWaitCeiling(
      computeNextRunAt({ amount: 48, unit: 'hours' }, nuMs),
      { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 },
      start, nuMs,
    );
    assert.equal(uitMail.getTime(), uitStap.getTime(), naam);
  }
});

test('plafondMs is de enige plek waar de grens gerekend wordt', () => {
  assert.equal(plafondMs(GENT, 48), Date.parse('2026-09-24T17:00:00.000Z'));
  assert.equal(plafondMs(GENT, null), null);
  assert.equal(plafondMs(null, 48), null);
  // Number([]) is 0 en Number('') ook — dat zou 'uiterlijk bij de start van
  // het event' betekenen in plaats van 'geen grens'.
  assert.equal(plafondMs(GENT, []), null);
  assert.equal(plafondMs(GENT, ''), null);
  assert.equal(plafondMs(GENT, {}), null);
  assert.equal(plafondMs(GENT, -1), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VARIABELE
// ═══════════════════════════════════════════════════════════════════════════

test('de variabele staat in de registry', () => {
  const v = AVAILABLE_VARIABLES.find((x) => x.key === 'attendee.geen_gehoor_deadline');
  assert.ok(v, 'anders is hij niet te kiezen in de template-editors');
  assert.equal(v.category, 'attendee');
  assert.equal(v.requires_context, 'attendee');
});

test('de mailtekst rendert met voornaam, datum, plaats en deadline', () => {
  const uit = resolveVariables(
    'Beste {{attendee.voornaam}}, de Forex Masterclass van {{event.datum}} in {{event.locatie}}. '
    + 'Laat voor {{attendee.geen_gehoor_deadline}} weten of je erbij bent.',
    null,
    {
      attendee: { first_name: 'Werner', call_status_at: BELSTATUS_AT },
      event   : { title: 'Forex Masterclass', starts_at: GENT, location: 'Gent' },
    },
  ).text;
  assert.match(uit, /^Beste Werner, /);
  assert.match(uit, /zaterdag 26 september 2026/);
  assert.match(uit, /in Gent\./);
  assert.match(uit, /voor woensdag 16 september om 13:05 weten/);
});

test('zonder nulpunt blijft de deadline leeg in plaats van fout', () => {
  const uit = resolveVariables('[{{attendee.geen_gehoor_deadline}}]', null,
    { attendee: { first_name: 'X' }, event: { starts_at: GENT } }).text;
  assert.equal(uit, '[]');
});

test('zonder attendee-context crasht er niets', () => {
  assert.equal(resolveVariables('[{{attendee.geen_gehoor_deadline}}]', null, {}).text, '[]');
  assert.equal(resolveVariables('[{{attendee.geen_gehoor_deadline}}]', null, null).text, '[]');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MIGRATIE
// ═══════════════════════════════════════════════════════════════════════════

/** Alleen de regels die echt draaien — commentaar eruit. */
const ACTIEF = SQL.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');

test('de CHECK op trigger_type wordt uitgebreid, met de vier bestaande erin', () => {
  // Een CHECK die de bestaande waarden vergeet maakt elke bestaande
  // automatisatie ongeldig.
  for (const t of ['on_signup', 'on_assessment_completed', 'time_before_event',
    'on_assessment_not_completed_after', 'on_call_status']) {
    assert.match(ACTIEF, new RegExp("'" + t + "'"), t);
  }
  assert.match(ACTIEF, /ADD CONSTRAINT event_automations_trigger_type_check/);
});

test('de automatisatie wordt UIT aangemaakt', () => {
  assert.match(ACTIEF, /'Geen gehoor - laatste kans'/);
  // De INSERT-kolomlijst en de eerste twee waarden: enabled = false,
  // enabled_at = null. Op de regels staat commentaar, dus niet op regeleinde
  // matchen.
  assert.match(ACTIEF, /\(name, description, enabled, enabled_at, trigger_type, trigger_config,/);
  assert.match(ACTIEF, /^\s*false,/m, 'enabled hoort false te zijn');
  // enabled_at blijft leeg: dat wordt het moment van aanzetten, en dat is ook
  // de grens waarop new_only toetst.
  assert.match(ACTIEF, /^\s*null,\s*(--.*)?$/m, 'enabled_at hoort null te zijn');
});

test('trigger, scope en enroll-mode staan goed', () => {
  assert.match(ACTIEF, /'on_call_status',/);
  assert.match(ACTIEF, /jsonb_build_object\('call_status', 'geen_gehoor'\)/);
  assert.match(ACTIEF, /'niveau',/);
  assert.match(ACTIEF, /jsonb_build_object\('niveau', v_niveau\)/);
  // ZONDER new_only worden de 15 bestaande geen_gehoor-rijen bij het aanzetten
  // meteen ingeschreven — Maxims vierde beslissing.
  assert.match(ACTIEF, /'new_only',/);
});

test('de vijf stappen staan in de juiste volgorde', () => {
  const idx = (s) => ACTIEF.indexOf(s);
  const mail      = idx("'type', 'send_email'");
  const wacht     = idx("'type', 'wait'");
  const conditie  = idx("'type', 'condition'");
  const annuleer  = idx("'type', 'update_attendee_status'");
  const melding   = idx("'type', 'send_internal_notification'");
  for (const [naam, i] of Object.entries({ mail, wacht, conditie, annuleer, melding })) {
    assert.ok(i > 0, naam + ' hoort erin te staan');
  }
  assert.ok(mail < wacht,     'eerst de mail, dan de klok');
  assert.ok(wacht < conditie, 'eerst wachten, dan meten');
  assert.ok(conditie < annuleer, 'eerst meten, dan annuleren — nooit omgekeerd');
  assert.ok(annuleer < melding);
});

test('de wachtstap is 48 uur met de bovengrens van 48 uur', () => {
  assert.match(ACTIEF, /'amount', 48/);
  assert.match(ACTIEF, /'unit', 'hours'/);
  assert.match(ACTIEF, /'uiterlijk_uren_voor_event', 48/);
});

test('de conditie stopt de flow bij twijfel', () => {
  assert.match(ACTIEF, /'check', 'geen_reactie_sinds_belstatus'/);
  assert.match(ACTIEF, /'on_fail', 'exit'/);
});

test('de annuleerstap zet status én belstatus', () => {
  assert.match(ACTIEF, /'new_status', 'geannuleerd'/);
  assert.match(ACTIEF, /'call_status', 'komt_niet'/);
});

test('de melding gaat naar Maxim en noemt wie, welk event en de deadline', () => {
  assert.match(ACTIEF, /'to_email', 'maxim@deforexopleiding\.nl'/);
  const i = ACTIEF.indexOf("'type', 'send_internal_notification'");
  const blok = ACTIEF.slice(i);
  assert.match(blok, /\{\{attendee\.naam\}\}/,  'wie');
  assert.match(blok, /\{\{event\.titel\}\}/,    'welk event');
  assert.match(blok, /\{\{attendee\.geen_gehoor_deadline\}\}/, 'wat de deadline was');
  assert.match(blok, /VERVALLEN/,               'en dat de plek vervallen is');
});

test('de mailtekst staat er zoals afgesproken', () => {
  assert.match(ACTIEF, /Je plek voor de Forex Masterclass - we hebben je niet kunnen bereiken/);
  for (const zin of [
    'meermaals telefonisch proberen te bereiken',
    'de zaal heeft een beperkt aantal plaatsen en de deelname is gratis',
    'Daar maken we geen uitzonderingen op',
    'Antwoorden op deze mail volstaat, een zin is genoeg',
    'dan handelen we het verder schriftelijk af',
    'dan gaat je plek naar iemand anders en vervalt',
    'Team De Forex Opleiding',
  ]) {
    assert.ok(ACTIEF.includes(zin), 'ontbrekende zin: ' + zin);
  }
  // Twee keer de deadline: bij de vraag en bij het gevolg.
  assert.ok((ACTIEF.match(/\{\{attendee\.geen_gehoor_deadline\}\}/g) || []).length >= 3,
    'twee keer in de mail plus een keer in de melding');
});

test('de plaats komt uit het event, niet uit een vaste stad', () => {
  // De automatisatie hangt aan een NIVEAU, dus hij pakt elke masterclass. Een
  // vaste 'in Gent' zou fout staan in een mail over een andere stad; voor het
  // event van 26/09 rendert {{event.locatie}} letterlijk 'in Gent'.
  const i = ACTIEF.indexOf("'Je plek voor de Forex Masterclass");
  const blok = ACTIEF.slice(i, ACTIEF.indexOf("'type', 'wait'", i));
  assert.match(blok, /in \{\{event\.locatie\}\}/);
  assert.doesNotMatch(blok, /in Gent/);
});

test('de twee UPDATEs zijn idempotent en append-only', () => {
  const updates = ACTIEF.split('UPDATE public.event_automations a').slice(1);
  assert.equal(updates.length, 2, 'welkomstmail en bevestigingsmail');
  for (const u of updates) {
    // Idempotent: staat de alinea er al, dan raakt de UPDATE de rij niet aan.
    assert.match(u, /position\('Let op: je plek is pas definitief' in \(a\.steps -> 0 -> 'config' ->> 'body'\)\) = 0/);
    // Append-only: de bestaande body wordt meegenomen, niet vervangen.
    assert.match(u, /a\.steps -> 0 -> 'config' ->> 'body'/);
    // Alleen op stap 0 en alleen als dat echt een mailstap is.
    assert.match(u, /a\.steps -> 0 ->> 'type' = 'send_email'/);
    assert.match(u, /'\{0,config,body\}'/);
  }
  assert.match(ACTIEF, /WHERE a\.name = 'Welkom \+ vragenlijst'/);
  assert.match(ACTIEF, /WHERE a\.name = 'Bevestiging aanmelding'/);
});

test('de toegevoegde alinea is de zin die Maxim heeft vastgelegd', () => {
  assert.ok(ACTIEF.includes(
    'Let op: je plek is pas definitief nadat we je telefonisch hebben gesproken. '
    + 'We bellen elke deelnemer persoonlijk - de plaatsen zijn beperkt en gratis, '
    + 'en we houden er geen bezet voor iemand die niet komt.'));
});

test('de migratie toont de huidige body vóór hij wijzigt', () => {
  // Dit is productietekst die klanten lezen. Beide UPDATEs hebben een SELECT
  // ervóór die zowel de huidige body als het resultaat toont.
  assert.equal((SQL.match(/AS huidige_body/g) || []).length, 2);
  assert.equal((SQL.match(/AS body_na_de_update/g) || []).length, 2);
});

test('de migratie waarschuwt dat steps_snapshot bevroren wordt', () => {
  // Lopende runs houden hun eigen versie van de stappen; een wijziging aan de
  // teksten raakt alleen wie daarna ingeschreven wordt.
  assert.match(SQL, /steps_snapshot WORDT BEVROREN/);
});

test('er staat beschreven waar de WhatsApp-stap later tussen komt', () => {
  assert.match(SQL, /DE WHATSAPP-STAP/);
  assert.match(SQL, /jsonb_insert\(steps, '\{1\}'/,
    'tussen de mail en het wachten, niet erachter');
});
