// tests/opvolging-geen-gehoor-knop.test.js
//
// GEEN GEHOOR BLEEF IN OPVOLGING HANGEN.
//
// Gemeten op 14 september in productie, op event_attendees.call_status: 85
// leeg, 65 bevestigd, 16 komt_niet, 15 geen_gehoor, 6 voicemail, 3
// terugbellen, 1 foutief_nummer. Werner De Kesel (Forex Masterclass Gent
// 26/09) stond op status 'aangemeld' met een LEGE belstatus terwijl hij al
// meermaals gebeld was.
//
// De oorzaak: het belwerk in Opvolging schreef alleen 'bevestigd' door naar de
// eventmodule (zetBelstatusBevestigd). Elke andere uitkomst bleef in Opvolging
// hangen. Die 15 geen_gehoor-rijen zijn met de hand gezet.
//
// Deze test legt drie dingen vast die samen het verschil maken met de andere
// uitgangen van de aanmeldkaart:
//   1. de belstatus-patch is precies dezelfde vorm als bij 'bevestigd', met
//      'geen_gehoor' als waarde;
//   2. de inschrijvings-status wordt NIET aangeraakt — geen gehoor is geen
//      afmelding, en het afnemen van de plek doet de automatisatie pas ná de
//      mail met deadline (Maxims vierde beslissing);
//   3. de drempel die de knop bewaakt komt uit één definitie, niet uit twee.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zetBelstatusGeenGehoor } from '../api/opvolging-aanmelding-actie.js';
import { drempelTekort, ARCHIEF_MIN_DAGEN, ARCHIEF_MIN_WA } from '../api/_lib/opvolging-vensters.js';

const NU = '2026-09-14T11:05:00.000Z';

/** Nep-databank voor `.from(t).update(p).eq(k, v)` — de hele keten. */
function nepDb({ fout = null } = {}) {
  const geschreven = [];
  return {
    geschreven,
    from(tabel) {
      return {
        update(patch) {
          return {
            eq(kolom, waarde) {
              geschreven.push({ tabel, patch, kolom, waarde });
              return Promise.resolve({ error: fout ? { message: fout } : null });
            },
          };
        },
      };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DE PATCH
// ═══════════════════════════════════════════════════════════════════════════

test('geen gehoor zet call_status, call_status_at en called op de juiste deelnemer', async () => {
  const db = nepDb();
  const uitkomst = await zetBelstatusGeenGehoor('att-werner', NU, db);

  assert.equal(uitkomst, 'bijgewerkt');
  assert.equal(db.geschreven.length, 1);
  const w = db.geschreven[0];
  assert.equal(w.tabel, 'event_attendees');
  assert.equal(w.kolom, 'id');
  assert.equal(w.waarde, 'att-werner');
  assert.deepEqual(w.patch, {
    call_status   : 'geen_gehoor',
    call_status_at: NU,
    called        : true,
  });
});

test('de inschrijvings-status blijft ongemoeid — geen gehoor is geen afmelding', async () => {
  const db = nepDb();
  await zetBelstatusGeenGehoor('att-1', NU, db);
  // Wél deze drie velden, en NIETS anders. Zodra 'status' hier meegeschreven
  // wordt, nemen we een plek af van iemand die de regel nog niet te zien kreeg.
  assert.deepEqual(Object.keys(db.geschreven[0].patch).sort(),
    ['call_status', 'call_status_at', 'called']);
});

test('call_status_at is het nulpunt van de 48-uurdeadline, dus altijd gezet', async () => {
  const db = nepDb();
  await zetBelstatusGeenGehoor('att-1', NU, db);
  // Zonder call_status_at kan de trigger 'on_call_status' met enroll_mode
  // new_only niet bepalen of deze rij nieuw is, en kan de mail geen deadline
  // noemen.
  assert.ok(db.geschreven[0].patch.call_status_at);
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIL-SOFT — de kaart is al dicht, maar het mag niet stil misgaan
// ═══════════════════════════════════════════════════════════════════════════

test('zonder deelnemer gebeurt er niets en is de uitkomst geen_deelnemer', async () => {
  const db = nepDb();
  assert.equal(await zetBelstatusGeenGehoor(null, NU, db), 'geen_deelnemer');
  assert.equal(db.geschreven.length, 0);
});

test('een databankfout geeft "mislukt" terug in plaats van te gooien', async () => {
  const db = nepDb({ fout: 'kolom bestaat niet' });
  assert.equal(await zetBelstatusGeenGehoor('att-1', NU, db), 'mislukt');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DREMPEL — één definitie, en de reden staat er letterlijk bij
// ═══════════════════════════════════════════════════════════════════════════

test('de drempel is niet gehaald met 2 belpogingen en 0 WhatsApps', () => {
  const uit = drempelTekort({ bel_dagen: 2, wa_totaal: 0 });
  assert.equal(uit.gehaald, false);
  assert.deepEqual(uit.redenen, [
    'nog 1 belpoging op een andere dag',
    'nog geen WhatsApp verstuurd',
  ]);
});

test('drie belpogingen op drie dagen plus één WhatsApp haalt de drempel', () => {
  assert.deepEqual(drempelTekort({ bel_dagen: 3, wa_totaal: 1 }),
    { gehaald: true, redenen: [] });
});

test('meer dan genoeg haalt de drempel ook', () => {
  assert.equal(drempelTekort({ bel_dagen: 9, wa_totaal: 4 }).gehaald, true);
});

test('alleen de WhatsApp ontbreekt — dan is dat de enige reden', () => {
  assert.deepEqual(drempelTekort({ bel_dagen: 3, wa_totaal: 0 }).redenen,
    ['nog geen WhatsApp verstuurd']);
});

test('ontbrekende tellers zijn nul pogingen, niet "onbekend dus goedkeuren"', () => {
  // Dit is de tak die telt: een kaart waarvan de tellers nog niet geladen zijn
  // mag de knop NIET vrijgeven. Anders belooft de mail 'meermaals geprobeerd'
  // aan iemand die nul keer gebeld is.
  for (const invoer of [{}, { bel_dagen: null, wa_totaal: null },
    { bel_dagen: undefined }, { bel_dagen: NaN, wa_totaal: NaN },
    { bel_dagen: 'drie', wa_totaal: 'een' }]) {
    assert.equal(drempelTekort(invoer).gehaald, false,
      'onbekende tellers horen de knop dicht te houden: ' + JSON.stringify(invoer));
  }
  assert.equal(drempelTekort().gehaald, false, 'geen argument idem');
});

test('de drempel leest de constanten en heeft geen eigen getallen', () => {
  // Zou drempelTekort zijn eigen 3 en 1 hebben, dan lopen scherm en dagrapport
  // een keer uiteen zonder dat een test rood wordt. Precies aan de grens
  // meten dwingt af dat hij de constanten gebruikt.
  assert.equal(drempelTekort({ bel_dagen: ARCHIEF_MIN_DAGEN, wa_totaal: ARCHIEF_MIN_WA }).gehaald, true);
  assert.equal(drempelTekort({ bel_dagen: ARCHIEF_MIN_DAGEN - 1, wa_totaal: ARCHIEF_MIN_WA }).gehaald, false);
  assert.equal(drempelTekort({ bel_dagen: ARCHIEF_MIN_DAGEN, wa_totaal: ARCHIEF_MIN_WA - 1 }).gehaald, false);
});
