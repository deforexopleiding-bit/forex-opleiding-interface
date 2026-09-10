// tests/opvolging-bevestigd-belstatus.test.js
//
// BEVESTIGEN IN OPVOLGING LIET DE EVENTMODULE ONWETEND.
//
// Gemeten op 10 september in productie: van de 18 aanmeldkaarten die op
// 'bevestigd' stonden, hadden er 12 in de aanwezigenlijst van de masterclass
// nog steeds '— nog niet gebeld —' staan. Moulay Ettaibi, Lucky Khadka, Wael
// Khallouf, Danny Cranshoff, Ann Deleu, James Verhaeghe, Serge Mortele, Lemmy
// Jacques, Raimondo Sain, Sibel Er, Bryan Van Der Heyden, Peter Tournelle.
//
// De oorzaak: api/opvolging-aanmelding-actie.js schreef bij 'bevestigd' alleen
// in opvolging_taken. `event_attendees.call_status` bleef leeg. Wie daarna in
// de eventmodule keek zag een ongebelde lead en belde hem nog eens — terwijl
// Dave hem net aan de lijn had gehad.
//
// De andere weg naar dezelfde badge, api/follow-up-lead-outcome.js bij outcome
// 'bevestigd', schreef die drie velden al wel. Deze test legt vast dat de
// opvolgmodule nu precies hetzelfde doet, en niets méér — de inschrijvings-
// status blijft ongemoeid, want bevestigen zegt iets over de belronde en niet
// over aangemeld/wachtlijst/geannuleerd.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { zetBelstatusBevestigd } from '../api/opvolging-aanmelding-actie.js';

const NU = '2026-09-10T09:30:00.000Z';

/**
 * Nep-databank die alleen `.from(tabel).update(patch).eq(kolom, waarde)`
 * ondersteunt — precies de keten die de functie loopt. Alles wordt vastgelegd
 * zodat de test kan nakijken WAT er geschreven werd en op WELKE rij.
 */
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
// DE PATCH — dezelfde drie velden als follow-up-lead-outcome bij 'bevestigd'
// ═══════════════════════════════════════════════════════════════════════════

test('bevestigen zet call_status, call_status_at en called op de juiste deelnemer', async () => {
  const db = nepDb();
  const uitkomst = await zetBelstatusBevestigd('att-1', NU, db);

  assert.equal(uitkomst, 'bijgewerkt');
  assert.equal(db.geschreven.length, 1, 'precies één schrijfactie');

  const [w] = db.geschreven;
  assert.equal(w.tabel, 'event_attendees');
  assert.equal(w.kolom, 'id');
  assert.equal(w.waarde, 'att-1', 'op de deelnemer uit bron_ref.attendee_id');
  assert.deepEqual(w.patch, {
    call_status   : 'bevestigd',
    call_status_at: NU,
    called        : true,
  });
});

test('de inschrijvings-status wordt NIET aangeraakt', () => {
  // Bevestigen gaat over de belronde. Wie de inschrijving zelf wil wijzigen
  // gebruikt de knop 'annuleer_in_event'. Zou deze functie `status` meesturen,
  // dan zou een bevestiging stilletjes een wachtlijst-plek of een annulering
  // kunnen overschrijven.
  const db = nepDb();
  return zetBelstatusBevestigd('att-1', NU, db).then(() => {
    const { patch } = db.geschreven[0];
    assert.equal('status' in patch, false, 'geen status in de patch');
    assert.deepEqual(Object.keys(patch).sort(), ['call_status', 'call_status_at', 'called']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN DEELNEMER — een aanmeldkaart zonder attendee_id
// ═══════════════════════════════════════════════════════════════════════════

test('zonder deelnemer wordt er niets geschreven', async () => {
  // Niet elke opvolgtaak hangt aan een event_attendees-rij (losse leads,
  // zoomcalls). Die mogen geen lege update op een tabel afvuren.
  for (const leeg of [null, undefined, '', 0]) {
    const db = nepDb();
    const uitkomst = await zetBelstatusBevestigd(leeg, NU, db);
    assert.equal(uitkomst, 'geen_deelnemer', String(leeg));
    assert.equal(db.geschreven.length, 0, 'geen schrijfactie voor ' + String(leeg));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FOUT — fail-soft, maar niet stil
// ═══════════════════════════════════════════════════════════════════════════

test('een fout van de databank levert "mislukt" op, geen exception', async () => {
  // De bevestiging zelf staat op dat moment al vast. Een fout hier mag die
  // niet terugdraaien — maar hij mag ook niet in stilte verdwijnen, want dan
  // blijft de eventmodule '— nog niet gebeld —' tonen. De view zet er een
  // melding op zodra dit 'mislukt' teruggeeft.
  const db = nepDb({ fout: 'PGRST204 kolom call_status niet in schema-cache' });
  const uitkomst = await zetBelstatusBevestigd('att-1', NU, db);
  assert.equal(uitkomst, 'mislukt');
});

test('een db die zelf gooit levert ook "mislukt" op', async () => {
  const stuk = { from() { throw new Error('verbinding weg'); } };
  const uitkomst = await zetBelstatusBevestigd('att-1', NU, stuk);
  assert.equal(uitkomst, 'mislukt');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING — het endpoint en de view moeten deze uitkomst dóórgeven
// ═══════════════════════════════════════════════════════════════════════════

test('de bevestigd-tak roept de functie aan en zet de uitkomst in het antwoord', async () => {
  const { readFileSync } = await import('node:fs');
  const bron = readFileSync(new URL('../api/opvolging-aanmelding-actie.js', import.meta.url), 'utf8');

  assert.match(bron, /const belstatus = await zetBelstatusBevestigd\(attendeeId, nu\)/,
    'de bevestigd-tak roept de functie aan met de deelnemer uit bron_ref');
  assert.match(bron, /gearchiveerd: !nogEenRonde,\s*\n\s*belstatus,/,
    'en geeft de uitkomst mee in het JSON-antwoord');
});

test('de view meldt het aan Dave als de belstatus niet gezet kon worden', async () => {
  const { readFileSync } = await import('node:fs');
  const bron = readFileSync(new URL('../modules/klanten-v2/views/opvolging-v2.js', import.meta.url), 'utf8');

  assert.match(bron, /const antwoord = await post\('\/api\/opvolging-aanmelding-actie'/,
    'het antwoord wordt bewaard in plaats van weggegooid');
  assert.match(bron, /antwoord\.belstatus === 'mislukt'/, 'en op mislukt gecontroleerd');
  assert.match(bron, /Zet hem daar even met de hand\./, 'met een melding die zegt wat Dave moet doen');
});
