// tests/events-belstatus-cascade.test.js
//
// EEN BELSTATUS KON EEN EVENT NIET MEER OPENEN OF SLUITEN.
//
// Sinds 15 sep 2026 neemt belstatus 'bevestigd' een plek in. Daarmee kan een
// belletje een event vol maken (sluiten) of, andersom, een plek teruggeven
// (heropenen). Vóór deze wijziging riep NIETS de cascade aan bij een
// call_status-wijziging: de teller klopte, maar het event bleef open staan tot
// er toevallig een vragenlijst binnenkwam.
//
// Deze test legt de beslisregel vast: de cascade draait ALLEEN als de
// plek-toestand daadwerkelijk kantelt, en nooit ten koste van de schrijfactie
// zelf — een fout in de cascade mag een belstatuswijziging niet laten mislukken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { plekToestandGewijzigd, PLEK_SELECT } from '../api/_lib/event-attendee-mutations.js';
import { zetBelstatusBevestigd, zetBelstatusGeenGehoor } from '../api/opvolging-aanmelding-actie.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = '2026-09-15T09:30:00.000Z';
const AR   = '11111111-2222-3333-4444-555555555555';

const zonderVragenlijst = (extra) => ({
  id: 'att-1', event_id: 'ev-1', status: 'aangemeld',
  assessment_response_id: null, is_test: false, call_status: null, ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE BESLISREGEL
// ═══════════════════════════════════════════════════════════════════════════

test('van niets naar bevestigd is een kanteling (event kan vol raken)', () => {
  assert.equal(plekToestandGewijzigd(
    zonderVragenlijst(),
    zonderVragenlijst({ call_status: 'bevestigd' }),
  ), true);
});

test('van bevestigd naar geen_gehoor is een kanteling (plek komt vrij)', () => {
  assert.equal(plekToestandGewijzigd(
    zonderVragenlijst({ call_status: 'bevestigd' }),
    zonderVragenlijst({ call_status: 'geen_gehoor' }),
  ), true);
});

test('gebeld -> voicemail raakt de bezetting niet', () => {
  // Geen van beide neemt een plek in; de cascade zou werk voor niets zijn.
  assert.equal(plekToestandGewijzigd(
    zonderVragenlijst({ call_status: 'gebeld' }),
    zonderVragenlijst({ call_status: 'voicemail' }),
  ), false);
});

test('wie de vragenlijst al invulde, kantelt niet door zijn belstatus', () => {
  // Die plek staat al vast via de vragenlijst. Bevestigd erbij of komt_niet
  // eroverheen verandert daar niets aan — de status doet dat wel, niet de bel.
  const met = (cs) => zonderVragenlijst({ assessment_response_id: AR, call_status: cs });
  assert.equal(plekToestandGewijzigd(met(null), met('bevestigd')),   false);
  assert.equal(plekToestandGewijzigd(met('bevestigd'), met('komt_niet')), false);
});

test('op de wachtlijst kantelt er niets, ook niet met bevestigd', () => {
  const w = (cs) => zonderVragenlijst({ status: 'wachtlijst', call_status: cs });
  assert.equal(plekToestandGewijzigd(w(null), w('bevestigd')), false);
});

test('een onleesbare before-state (null) telt als "nam geen plek in"', () => {
  // leesPlekRij geeft null bij een leesfout. Dan is de veilige aanname dat er
  // niets bezet was: naar bevestigd is dan een kanteling omhoog, en die
  // cascade is idempotent.
  assert.equal(plekToestandGewijzigd(null, zonderVragenlijst({ call_status: 'bevestigd' })), true);
  assert.equal(plekToestandGewijzigd(null, zonderVragenlijst()), false);
});

test('PLEK_SELECT bevat de vier velden waar de regel op rust', () => {
  for (const kolom of ['event_id', 'status', 'assessment_response_id', 'is_test', 'call_status']) {
    assert.ok(PLEK_SELECT.includes(kolom), kolom + ' hoort in PLEK_SELECT');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE BEDRADING IN DE OPVOLGMODULE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Nep-databank die `.from(t).select(..).eq(..).maybeSingle()` en
 * `.from(t).update(p).eq(..)` ondersteunt — de twee ketens die de
 * belstatus-zetters lopen.
 */
function nepDb({ rij = zonderVragenlijst(), leesFout = null, schrijfFout = null } = {}) {
  const geschreven = [];
  const gelezen = [];
  return {
    geschreven,
    gelezen,
    from(tabel) {
      return {
        select(kolommen) {
          gelezen.push({ tabel, kolommen });
          return {
            eq: () => ({
              maybeSingle: () => Promise.resolve({
                data : leesFout ? null : rij,
                error: leesFout ? { message: leesFout } : null,
              }),
            }),
          };
        },
        update(patch) {
          return {
            eq(kolom, waarde) {
              geschreven.push({ tabel, patch, kolom, waarde });
              return Promise.resolve({ error: schrijfFout ? { message: schrijfFout } : null });
            },
          };
        },
      };
    },
  };
}

/** Vangt de cascade-aanroepen op in plaats van er echt een te draaien. */
function nepCascade() {
  const calls = [];
  const fn = async (voor, na, opts) => { calls.push({ voor, na, opts }); return { changed: true }; };
  fn.calls = calls;
  return fn;
}

test('bevestigen draait de cascade als de plek daardoor bezet raakt', async () => {
  const db = nepDb({ rij: zonderVragenlijst() });
  const cascade = nepCascade();
  const uitkomst = await zetBelstatusBevestigd('att-1', NU, db, { cascade });

  assert.equal(uitkomst, 'bijgewerkt');
  assert.equal(db.geschreven.length, 1, 'de belstatus wordt nog steeds geschreven');
  assert.equal(cascade.calls.length, 1);
  assert.equal(cascade.calls[0].na.call_status, 'bevestigd');
  assert.equal(cascade.calls[0].opts.reason, 'opvolging-bevestigd');
});

test("'geen gehoor' draait de cascade zodat de plek weer vrijkomt", async () => {
  const db = nepDb({ rij: zonderVragenlijst({ call_status: 'bevestigd' }) });
  const cascade = nepCascade();
  await zetBelstatusGeenGehoor('att-1', NU, db, { cascade });

  assert.equal(cascade.calls.length, 1);
  assert.equal(cascade.calls[0].voor.call_status, 'bevestigd');
  assert.equal(cascade.calls[0].na.call_status, 'geen_gehoor');
  assert.equal(cascade.calls[0].opts.reason, 'opvolging-geen-gehoor');
});

test('een mislukte schrijfactie draait GEEN cascade', async () => {
  // De belstatus staat dan niet; het event mag daar niet op reageren.
  const db = nepDb({ schrijfFout: 'PGRST204' });
  const cascade = nepCascade();
  assert.equal(await zetBelstatusBevestigd('att-1', NU, db, { cascade }), 'mislukt');
  assert.equal(cascade.calls.length, 0);
});

test('een leesfout vooraf blokkeert de belstatus NIET', async () => {
  // Fail-soft de goede kant op: de bevestiging is het harde feit. Lukt het
  // vóórlezen niet, dan schrijven we gewoon en laten we de cascade beslissen
  // met een lege before-state.
  const db = nepDb({ leesFout: 'verbinding weg' });
  const cascade = nepCascade();
  assert.equal(await zetBelstatusBevestigd('att-1', NU, db, { cascade }), 'bijgewerkt');
  assert.equal(db.geschreven.length, 1);
});

test('de belstatus-zetters lezen de plek-velden vooraf', async () => {
  const db = nepDb();
  await zetBelstatusBevestigd('att-1', NU, db, { cascade: nepCascade() });
  assert.equal(db.gelezen.length, 1);
  assert.equal(db.gelezen[0].tabel, 'event_attendees');
  assert.equal(db.gelezen[0].kolommen, PLEK_SELECT);
});

test('zonder deelnemer gebeurt er niets — geen lees, geen schrijf, geen cascade', async () => {
  for (const leeg of [null, undefined, '', 0]) {
    const db = nepDb();
    const cascade = nepCascade();
    assert.equal(await zetBelstatusBevestigd(leeg, NU, db, { cascade }), 'geen_deelnemer');
    assert.equal(await zetBelstatusGeenGehoor(leeg, NU, db, { cascade }), 'geen_deelnemer');
    assert.equal(db.geschreven.length, 0);
    assert.equal(cascade.calls.length, 0);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE BEDRADING IN DE ANDERE TWEE SCHRIJFPADEN
// ═══════════════════════════════════════════════════════════════════════════

test('events-attendee-update hangt de cascade aan een call_status-patch', () => {
  const bron = readFileSync(join(ROOT, 'api/events-attendee-update.js'), 'utf8');
  assert.match(bron, /if \(patch\.call_status !== undefined\) \{/,
    'de cascade hangt aan de belstatus, niet aan elke patch');
  assert.match(bron, /onAttendeePlekChange\(/);
  // De before-fetch moet de plek-velden meelezen, anders kan er niets
  // vergeleken worden.
  for (const kolom of ['status', 'assessment_response_id', 'is_test']) {
    assert.match(bron, new RegExp('follow_up_reason, call_status,[^\\n]*' + kolom), kolom);
  }
});

test('follow-up-lead-outcome draait de cascade ook op een call_status-wijziging', () => {
  const bron = readFileSync(join(ROOT, 'api/follow-up-lead-outcome.js'), 'utf8');
  assert.match(bron, /patchAttendee\.status !== undefined \|\| patchAttendee\.call_status !== undefined/);
  assert.match(bron, /restoreAttendee\.status !== undefined \|\| restoreAttendee\.call_status !== undefined/,
    'ook het undo-pad, dat call_status herstelt');
  assert.match(bron, /onAttendeePlekChange\(voorRij, naRij/);
});

test('het komt-niet-pad kijkt naar de plek, niet meer alleen naar de status', () => {
  // Iemand op 'aanwezig' die enkel via bevestigd een plek had, houdt zijn
  // status maar verliest zijn plek. De oude gate (statusWijzigt) miste dat.
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  const i = bron.indexOf('export async function zetKomtNiet');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 4800);
  // De GATE blijft, niet de eenregelige vorm. Sinds de annulatie-automatisatie
  // stempelt dit blok ook cancelled_at + cancelled_reason, dus staat het in
  // accolades. Wat hier telt is dat de statuswijziging nog steeds achter
  // `statusWijzigt` hangt.
  assert.match(blok, /if \(statusWijzigt\)\s*\{?\s*patch\.status = 'geannuleerd'/,
    'de status-regel zelf blijft achter statusWijzigt hangen');
  assert.doesNotMatch(blok, /if \(statusWijzigt && rij\.event_id\)/,
    'de cascade hangt niet meer alleen aan de statuswijziging');
  assert.match(blok, /onAttendeePlekChange\)\(\s*rij,/);
});
