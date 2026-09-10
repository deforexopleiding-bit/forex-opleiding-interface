// tests/opvolging-aanmelding-eventsync.test.js
//
// DE AANMELDKAART STUURT DE EVENTMODULE AAN.
//
// Maxims regel: voor een masterclass-aanmelding hoeft Dave NOOIT meer naar de
// eventmodule. Op de kaart heeft hij drie uitgangen, en elk daarvan zet de
// aanwezigenlijst meteen goed:
//
//   1. Bevestigd  → belstatus 'bevestigd'. Dat deed de vorige PR al.
//   2. Geen interesse / per ongeluk aangemeld → 'Komt niet'.
//   3. Verplaatst → dezelfde keuzelijst als ⋮ → 'Verplaatsen naar ander event',
//      en daarna staat de persoon op het nieuwe event meteen als bevestigd.
//
// ── WAT ER MIS WAS BIJ AFMELDEN ──────────────────────────────────────────
// De actie 'annuleer_in_event' zette ALLEEN `status = 'geannuleerd'`. Twee
// gevolgen, allebei onzichtbaar:
//
//   · de belstatus bleef leeg, dus stond er '— nog niet gebeld —' bij iemand
//     die net had afgezegd, en belde de volgende hem nog eens;
//   · er draaide geen capaciteitshook, dus heropende een vrijgekomen plaats
//     het event nooit — een vol event bleef dicht terwijl er ruimte was.
//
// 'Komt niet' in de eventmodule doet allebei wel. Deze test legt vast dat de
// opvolgmodule nu precies hetzelfde doet, en niets méér.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { zetKomtNiet, zetBelstatusBevestigd } from '../api/opvolging-aanmelding-actie.js';
import { bepaalTaakActie, WAKKER_DAGEN_VOOR_EVENT, dagPlus } from '../api/_lib/opvolging-aanmelding.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU = '2026-09-10T09:30:00.000Z';

/**
 * De code zonder commentaar.
 *
 * Deze module legt in het commentaar uit wat er vroeger stond en waarom het
 * weg is. Een test die op de rauwe tekst zoekt vindt dus precies de zinnen die
 * hij verboden wil verklaren — en zou groen worden zodra iemand de uitleg
 * weghaalt. Dus: kijken naar wat er DRAAIT.
 */
const zonderUitleg = (tekst) => tekst
  .split('\n')
  .filter((r) => {
    const t = r.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  })
  .join('\n');

/**
 * Nep-databank die `.from(t).select(..).eq(..).maybeSingle()` en
 * `.from(t).update(p).eq(..)` ondersteunt — de twee ketens die zetKomtNiet
 * loopt. Alles wordt vastgelegd zodat de test kan nakijken WAT er geschreven
 * werd en op WELKE rij.
 */
function nepDb({ rij = { id: 'att-1', event_id: 'ev-1', status: 'aangemeld' }, leesFout = null, schrijfFout = null } = {}) {
  const geschreven = [];
  return {
    geschreven,
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: () => Promise.resolve({
                  data : leesFout ? null : rij,
                  error: leesFout ? { message: leesFout } : null,
                }),
              };
            },
          };
        },
        update(patch) {
          return {
            eq(kolom, waarde) {
              geschreven.push({ patch, kolom, waarde });
              return Promise.resolve({ error: schrijfFout ? { message: schrijfFout } : null });
            },
          };
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · KOMT NIET — de patch
// ═══════════════════════════════════════════════════════════════════════════

test("afmelden zet call_status 'komt_niet', de tijd en called op de juiste rij", async () => {
  const db = nepDb();
  const uitkomst = await zetKomtNiet('att-1', NU, db);

  assert.equal(uitkomst, 'bijgewerkt');
  assert.equal(db.geschreven.length, 1);

  const [w] = db.geschreven;
  assert.equal(w.kolom, 'id');
  assert.equal(w.waarde, 'att-1');
  assert.equal(w.patch.call_status, 'komt_niet');
  assert.equal(w.patch.call_status_at, NU);
  assert.equal(w.patch.called, true);
});

test("'aangemeld' en 'wachtlijst' gaan naar geannuleerd", async () => {
  for (const status of ['aangemeld', 'wachtlijst', 'AANGEMELD']) {
    const db = nepDb({ rij: { id: 'att-1', event_id: 'ev-1', status } });
    await zetKomtNiet('att-1', NU, db);
    assert.equal(db.geschreven[0].patch.status, 'geannuleerd', status);
  }
});

test("'sale', 'aanwezig' en 'switched_to_other_event' houden hun status", async () => {
  // Die drie zeggen iets over wat er ECHT gebeurd is. Overschrijven met een
  // afmelding zou geschiedenis wissen: iemand die verkocht heeft is geen
  // afzegging, en wie naar een ander event is verplaatst is niet weg.
  for (const status of ['sale', 'aanwezig', 'switched_to_other_event']) {
    const db = nepDb({ rij: { id: 'att-1', event_id: 'ev-1', status } });
    await zetKomtNiet('att-1', NU, db);
    const { patch } = db.geschreven[0];
    assert.equal('status' in patch, false, status + ' — status hoort er niet in te staan');
    // De belronde heeft wél plaatsgevonden, ongeacht wat de inschrijving doet.
    assert.equal(patch.call_status, 'komt_niet', status);
  }
});

test('zonder deelnemer wordt er niets geschreven', async () => {
  for (const leeg of [null, undefined, '', 0]) {
    const db = nepDb();
    assert.equal(await zetKomtNiet(leeg, NU, db), 'geen_deelnemer', String(leeg));
    assert.equal(db.geschreven.length, 0);
  }
});

test("een fout levert 'mislukt' op, geen exception", async () => {
  assert.equal(await zetKomtNiet('att-1', NU, nepDb({ schrijfFout: 'PGRST204' })), 'mislukt');
  assert.equal(await zetKomtNiet('att-1', NU, nepDb({ leesFout: 'verbinding weg' })), 'mislukt');
  assert.equal(await zetKomtNiet('att-1', NU, { from() { throw new Error('stuk'); } }), 'mislukt');
});

test('een deelnemer die niet bestaat is een mislukking, geen stilte', async () => {
  const db = nepDb({ rij: null });
  assert.equal(await zetKomtNiet('att-1', NU, db), 'mislukt');
  assert.equal(db.geschreven.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE CAPACITEITSHOOK — alleen bij een echte statuswijziging
// ═══════════════════════════════════════════════════════════════════════════

test('de capaciteitshook draait alleen als de status echt verandert', () => {
  // Zonder wijziging is er niets veranderd aan de bezetting; de cascade zou
  // dan werk voor niets zijn. Mét wijziging komt er een plaats vrij en hoort
  // een vol event weer open te gaan — dat miste in de oude actie volledig.
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('export async function zetKomtNiet');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2200);

  assert.match(blok, /const statusWijzigt = huidige === 'aangemeld' \|\| huidige === 'wachtlijst'/);
  assert.match(blok, /if \(statusWijzigt\) patch\.status = 'geannuleerd'/);
  assert.match(blok, /if \(statusWijzigt && rij\.event_id\)/,
    'de hook hangt aan de statuswijziging, niet aan de schrijfactie');
  assert.match(blok, /onConfirmedAttendeeMutation\(rij\.event_id, \{ reason: 'opvolging-aanmelding-actie' \}\)/);
});

test('de uitkomstmotor wordt niet aangeraakt', () => {
  // follow-up-lead-outcome.js draagt een waarschuwingsblok en een
  // productie-incident van 20 mei. We doen hetzelfde, we roepen het niet aan.
  const bron = zonderUitleg(readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8'));
  assert.doesNotMatch(bron, /follow-up-lead-outcome/, 'niet importeren en niet aanroepen');
  assert.doesNotMatch(bron, /follow_up_leads/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE BEDRADING VAN AFMELDEN
// ═══════════════════════════════════════════════════════════════════════════

test("de tak 'geen_interesse' schrijft komt_niet en geeft de uitkomst terug", () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf("if (actie === 'geen_interesse')");
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1200);
  assert.match(blok, /const eventmodule = await zetKomtNiet\(attendeeId, nu\)/);
  assert.match(blok, /success: true, eventmodule/);
  assert.doesNotMatch(blok, /vraag_annuleren/, 'het tussenvenster is weg');
});

test("'annuleer_in_event' gebruikt voortaan zetKomtNiet", () => {
  // Blijft bestaan voor een oud tabblad, maar doet nu hetzelfde: komt_niet
  // plus de capaciteitshook, in plaats van alleen 'geannuleerd'.
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf("if (actie === 'annuleer_in_event')");
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 800);
  assert.match(blok, /await zetKomtNiet\(attendeeId, nu\)/);
  assert.doesNotMatch(blok, /update\(\{ status: 'geannuleerd' \}\)/, 'de kale status-update is weg');
});

test('de view toont één knop en meldt een mislukking', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /Vastleggen &mdash; komt niet/);
  assert.match(view, /In de eventmodule komt hij op \\'Komt niet\\'/);
  assert.match(view, /antwoord\.eventmodule === 'mislukt'/);
  assert.match(view, /kon hij niet op "Komt niet" gezet worden/);

  // De twee oude knoppen en de gele waarschuwing zijn weg.
  const code = zonderUitleg(view);
  assert.doesNotMatch(code, /Archiveren &eacute;n in de eventmodule annuleren/);
  assert.doesNotMatch(code, /Alleen archiveren/);
  assert.doesNotMatch(code, /Zet hem ook in de eventmodule op geannuleerd/);

  // En de optietekst in 'Wat nu?'.
  assert.match(view, /Kaart dicht, en in de eventmodule op Komt niet\./);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · VERPLAATSEN — één kern, twee ingangen
// ═══════════════════════════════════════════════════════════════════════════

test('de verplaatsing staat op één plek en wordt door beide endpoints gebruikt', () => {
  const kern = readFileSync(join(ROOT, 'api/_lib/event-attendee-move-core.js'), 'utf8');
  const endpoint = readFileSync(join(ROOT, 'api/events-attendee-move.js'), 'utf8');
  const opvolging = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');

  // De kern kent geen HTTP.
  assert.doesNotMatch(kern, /res\.status/, 'de kern geeft data terug, geen HTTP-antwoord');
  assert.match(kern, /export async function verplaatsDeelnemer/);

  // Beide ingangen roepen 'm aan, en het endpoint dupliceert niets meer.
  assert.match(endpoint, /import \{ verplaatsDeelnemer \}/);
  assert.match(opvolging, /import \{ verplaatsDeelnemer \}/);
  assert.doesNotMatch(zonderUitleg(endpoint), /from\('event_attendees'\)/,
    'het endpoint schrijft zelf niets meer');
  assert.doesNotMatch(zonderUitleg(endpoint), /getConfirmedCount|onConfirmedAttendeeMutation/);
  assert.doesNotMatch(zonderUitleg(opvolging), /switched_to_other_event/,
    'de opvolgmodule schrijft de bronrij niet zelf');
});

test('het endpoint houdt zijn eigen permissie en geeft de status van de kern door', () => {
  const endpoint = readFileSync(join(ROOT, 'api/events-attendee-move.js'), 'utf8');
  assert.match(endpoint, /requirePermission\(req, 'events\.attendee\.create'\)/);
  assert.match(endpoint, /return res\.status\(uitkomst\.status\)\.json\(uitkomst\.body\)/);
});

test('de kern valideert de twee uuids voordat er iets gebeurt', async () => {
  const { verplaatsDeelnemer } = await import('../api/_lib/event-attendee-move-core.js');
  const geen = await verplaatsDeelnemer({ attendeeId: null, targetEventId: 'x' });
  assert.equal(geen.ok, false);
  assert.equal(geen.status, 400);
  assert.match(geen.body.error, /attendee_id/);

  const geldig = '11111111-2222-3333-4444-555555555555';
  const fout = await verplaatsDeelnemer({ attendeeId: geldig, targetEventId: 'geen-uuid' });
  assert.equal(fout.status, 400);
  assert.match(fout.body.error, /target_event_id/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · VERPLAATSEN VANUIT DE AANMELDKAART
// ═══════════════════════════════════════════════════════════════════════════

test('een 409 uit de kern gaat letterlijk terug en laat de kaart ONGEMOEID', () => {
  // 'Doel-event is vol (12/12 met ingevulde vragenlijst)' zegt precies wat er
  // aan de hand is. Een kaart sluiten bij een mislukte verplaatsing zou de
  // lead laten verdwijnen zonder dat er iets gebeurd is.
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('async function verplaatsNaarEvent');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 5000);

  assert.match(blok, /if \(!uitkomst\.ok\) return res\.status\(uitkomst\.status\)\.json\(uitkomst\.body\);/);

  // De volgorde: pas NA de geslaagde verplaatsing gaat de kaart dicht.
  const iRetour = blok.indexOf('if (!uitkomst.ok)');
  const iDicht  = blok.indexOf("archief_reden  : 'verplaatst naar ander event'");
  assert.ok(iRetour > 0 && iDicht > iRetour, 'de kaart gaat pas dicht na een geslaagde verplaatsing');
});

test('de oude kaart gaat dicht met de bestemming in de notitie, plus een poging', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('async function verplaatsNaarEvent');
  const blok = bron.slice(i, i + 3000);
  assert.match(blok, /status\s*:\s*'gearchiveerd'/);
  assert.match(blok, /archief_reden\s*:\s*'verplaatst naar ander event'/);
  assert.match(blok, /Verplaatst naar \$\{eventNaam\}/);
  assert.match(blok, /schrijfPoging\(taak\.id, 'call', 'gesproken: bevestigd \(verplaatst\)'\)/,
    "het resultaat begint met 'gesproken' zodat isEchtContact() 'm herkent");
});

test('de nieuwe kaart draagt de NIEUWE attendee-id en is meteen bevestigd', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('async function maakBevestigdeKaart');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2600);

  assert.match(blok, /attendee_id\s*:\s*nieuweAttendeeId/);
  assert.match(blok, /event_dag\s*:\s*eventDag/);
  assert.match(blok, /bevestigd_op\s*:\s*nu/);
  assert.match(blok, /Bevestigd bij het verplaatsen/);
  assert.match(blok, /reden\s*:\s*'aanmelding'/);
});

test('is er nog een reminder-ronde, dan slaapt de nieuwe kaart tot event−4', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('async function verplaatsNaarEvent');
  const blok = bron.slice(i, i + 4000);
  assert.match(blok, /const wakker = eventDag \? dagPlus\(eventDag, -WAKKER_DAGEN_VOOR_EVENT\) : null;/);
  assert.match(blok, /const nogEenRonde = !!wakker && wakker > vandaag;/);

  const kaart = bron.slice(bron.indexOf('async function maakBevestigdeKaart'));
  assert.match(kaart, /velden\.due\s*=\s*wakker/);
  assert.match(kaart, /velden\.archief_reden\s*=\s*'bevestigd'/,
    'binnen vier dagen is er geen ronde meer en gaat de kaart meteen dicht');
});

test('de belstatus op de nieuwe rij wordt gezet', () => {
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  assert.match(bron, /const belstatus = await zetBelstatusBevestigd\(nieuweAttendeeId, nu\)/);
  assert.match(bron, /nieuwe_attendee_id: nieuweAttendeeId/);
  assert.match(bron, /nieuwe_taak_id\s*:\s*nieuweTaakId/);
  // En die functie doet nog steeds wat hij deed.
  assert.equal(typeof zetBelstatusBevestigd, 'function');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE CRON ZET ER GEEN TWEEDE KAART NAAST
// ═══════════════════════════════════════════════════════════════════════════

const NU_MS = Date.parse('2026-09-10T08:00:00Z');   // 10:00 Amsterdam
const VANDAAG = '2026-09-10';

test('bepaalTaakActie doet NIETS voor de nieuwe rij zolang onze kaart er staat', () => {
  // Dit is de reden dat we de kaart zelf maken in plaats van de cron zijn gang
  // te laten gaan: die zet er anders een verse ronde-A-kaart neer ('bellen
  // binnen 24 uur') voor iemand die net bevestigd heeft.
  const eventDag = dagPlus(VANDAAG, 20);
  const event = { id: 'ev-2', title: 'Masterclass Gent', starts_at: eventDag + 'T17:00:00Z' };
  const attendee = { id: 'att-nieuw', status: 'aangemeld', switched_from_event_id: 'ev-1' };
  const onzeKaart = { id: 'taak-nieuw', status: 'open', due: dagPlus(eventDag, -WAKKER_DAGEN_VOOR_EVENT) };

  const besluit = bepaalTaakActie({ attendee, event, taak: onzeKaart, nu: NU_MS });
  assert.equal(besluit.actie, 'niets', 'geen tweede kaart, en ook geen wakker maken');
});

test('zonder onze kaart zou de cron er wél een maken — dat is precies wat we voorkomen', () => {
  const eventDag = dagPlus(VANDAAG, 20);
  const event = { id: 'ev-2', title: 'Masterclass Gent', starts_at: eventDag + 'T17:00:00Z' };
  const attendee = { id: 'att-nieuw', status: 'aangemeld', switched_from_event_id: 'ev-1' };
  assert.equal(bepaalTaakActie({ attendee, event, taak: null, nu: NU_MS }).actie, 'aanmaken');
});

test('een gearchiveerde kaart binnen vier dagen houdt de cron ook tegen', () => {
  // Ligt het event dichtbij, dan is onze kaart meteen dicht. bepaalTaakActie
  // laat een gearchiveerde kaart met rust — hij zou 'm anders alsnog als
  // 'geen kaart' lezen en er een nieuwe naast zetten.
  const eventDag = dagPlus(VANDAAG, 2);
  const event = { id: 'ev-2', title: 'Masterclass Gent', starts_at: eventDag + 'T17:00:00Z' };
  const attendee = { id: 'att-nieuw', status: 'aangemeld' };
  const onzeKaart = { id: 'taak-nieuw', status: 'gearchiveerd', due: VANDAAG };
  assert.equal(bepaalTaakActie({ attendee, event, taak: onzeKaart, nu: NU_MS }).actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE KEUZELIJST — één venster, twee modules
// ═══════════════════════════════════════════════════════════════════════════

test('de keuzelijst staat als herbruikbare GLOBALE functie', () => {
  // Stond eerst alleen op window.KV, en dat brak in beide modules: klanten-v2.js
  // is een module, draait dus na alle views, en verving KV in zijn geheel. Zie
  // tests/klanten-v2-kv-laadvolgorde.test.js.
  const ev = readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8');
  assert.match(ev, /window\.__evKiesAnderEvent = async \(\{ eventId, naam \} = \{\}\)/);
  assert.match(ev, /window\.KV\.evKiesAnderEvent = \(opties\) => window\.__evKiesAnderEvent\(opties\)/,
    'de KV-alias mag blijven, als gemak');
  assert.match(ev, /\/api\/events-list\?status=draft,published&limit=200/);
  // Het filteren zit sinds de polish-PR in _evToekomstigeEvents: huidige event
  // eruit, voorbije events eruit, chronologisch. Zie
  // tests/opvolging-verplaats-polish.test.js voor de regels zelf.
  assert.match(ev, /events = _evToekomstigeEvents\(j\?\.items, eventId\)/,
    'het huidige event valt weg, en alles wat al geweest is');
  assert.match(ev, /return await _evMovePicker\(events, naam\)/);
});

test('__evAttMove gebruikt dezelfde functie en gedraagt zich verder hetzelfde', () => {
  const ev = readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8');
  const i = ev.indexOf('window.__evAttMove = async');
  assert.ok(i > 0);
  const blok = ev.slice(i, i + 900);
  assert.match(blok, /const target = await window\.__evKiesAnderEvent\(\{ eventId \}\)/);
  assert.match(blok, /if \(!target\) return;/);
  assert.match(blok, /\/api\/events-attendee-move/, 'de eventmodule blijft haar eigen endpoint gebruiken');
  // De eigen ophaal- en filtercode is weg; die zit nu in de gedeelde functie.
  assert.doesNotMatch(blok, /events-list/);
});

test('de aanmeldkaart opent de keuzelijst en heeft geen tussenvenster meer', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /window\.__opvVerplaatsNaarEvent = async/);
  assert.match(view, /window\.__evKiesAnderEvent\(\{ eventId: ev\.event_id \|\| null, naam: t\.naam \|\| null \}\)/);
  assert.match(view, /if \(!doel\) return;/, 'annuleren doet niets, de kaart blijft staan');
  assert.match(view, /actie: 'verplaats_naar_event', target_event_id: doel/);
  assert.match(view, /Kies het nieuwe event; hij staat daar meteen als bevestigd\./);

  // Ontbreekt de functie, dan zeggen we dat — geen stille guard.
  assert.match(view, /De eventlijst is hier niet beschikbaar/);
});

test('de toast noemt het event en de dag waarop hij terugkomt', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /'Verplaatst naar ' \+ waarheen \+ ' — bevestigd, komt terug op ' \+ nl\(antwoord\.slaapt_tot\)/);
  assert.match(view, /'Verplaatst naar ' \+ waarheen \+ ' — bevestigd'/);
});

test('showToast bestond hier niet — elke melding loopt nu via één helper', () => {
  // Twee bestaande aanroepen deden `showToast(...)` zonder dat die naam in dit
  // bestand bestaat. Dat is een ReferenceError op precies het moment dat je een
  // melding nodig hebt, en dus geen melding.
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.doesNotMatch(zonderUitleg(view), /(?<!\.)\bshowToast\(/);
  assert.match(view, /function opvToast\(msg\)/);
  assert.match(view, /window\.KV && typeof window\.KV\.toast === 'function'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · GEEN OVERLAY-VALKUILEN
// ═══════════════════════════════════════════════════════════════════════════

test('de vensters gebruiken het bestaande overlay-patroon van deze module', () => {
  // `class="scrim on"` is hier GEEN valkuil maar de afspraak — zie de uitleg
  // bij waPaneelHtml. Wat wél fout gaat is een venster dat zijn eigen vorm
  // verzint; deze test legt vast dat de scrim-helper de enige weg blijft.
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /class="scrim on"/);
  // De nieuwe verplaats-flow tekent zelf helemaal geen venster: die leent de
  // keuzelijst van de eventmodule.
  const i = view.indexOf('window.__opvVerplaatsNaarEvent = async');
  const blok = view.slice(i, i + 1800);
  assert.doesNotMatch(blok, /scrim/, 'geen eigen overlay naast die van events-v2');
});

test('er staan geen HTML-entities binnen esc()', () => {
  // esc() ontsnapt zijn invoer; een entity die er doorheen gaat verschijnt
  // letterlijk op het scherm als '&mdash;'.
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.doesNotMatch(view, /esc\([^)]*&(mdash|eacute|oacute|nbsp|amp);/);
});
