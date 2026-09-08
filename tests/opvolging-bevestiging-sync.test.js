// tests/opvolging-bevestiging-sync.test.js
//
// Drukt Dave in de opvolgmodule op Bevestigd, dan bleef dat daar hangen. De
// eventmodule — waar per deelnemer 'bevestigd' of 'voicemail' staat — wist er
// niets van, en iemand moest het met de hand overzetten. Twee administraties
// voor één handeling.
//
// De weg bestond al in follow-up-lead-outcome.js en doet MEER dan één veld.
// Die vier dingen staan nu op één plek; deze tests bewaken elk ervan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bevestigingPatch, bevestigDeelnemer } from '../api/_lib/event-attendee-bevestigen.js';

const NU = '2026-09-07T18:12:00.000Z';

test('een bevestiging zet de badge in de bellijst', () => {
  const p = bevestigingPatch({ huidigeStatus: 'aangemeld', nowIso: NU });
  assert.equal(p.call_status, 'bevestigd');
  assert.equal(p.call_status_at, NU);
});

test('een bevestiging betekent dat de belronde bereik had', () => {
  assert.equal(bevestigingPatch({ huidigeStatus: 'aangemeld', nowIso: NU }).called, true);
});

test('wie geannuleerd stond en alsnog bevestigt, staat weer aangemeld', () => {
  // Het ding dat je vergeet bij een tweede weg: zonder deze correctie bevestigt
  // iemand die als geannuleerd te boek staat, en blijft hij geannuleerd.
  for (const uit of ['geannuleerd', 'switched_to_other_event', 'GEANNULEERD']) {
    assert.equal(bevestigingPatch({ huidigeStatus: uit, nowIso: NU }).status, 'aangemeld', uit);
  }
});

test('een gewone aanmelding krijgt GEEN status-wijziging opgedrongen', () => {
  // 'aanwezig' of 'sale' terugzetten naar 'aangemeld' zou werk vernietigen.
  for (const uit of ['aangemeld', 'aanwezig', 'sale', '']) {
    assert.equal('status' in bevestigingPatch({ huidigeStatus: uit, nowIso: NU }), false, uit);
  }
});

// ── De schrijfkant ─────────────────────────────────────────────────────────

function nepDb({ rij, schrijfFout = null }) {
  const gedaan = { patch: null, gelezen: 0 };
  return {
    gedaan,
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => { gedaan.gelezen += 1; return { data: rij, error: null }; } }) }),
      update: (p) => ({ eq: async () => { gedaan.patch = p; return { error: schrijfFout }; } }),
    }),
  };
}

test('de bevestiging wordt weggeschreven en gemeld', async () => {
  const db = nepDb({ rij: { id: 'a1', event_id: 'e1', status: 'aangemeld' } });
  const r = await bevestigDeelnemer({ supabaseAdmin: db, attendeeId: 'a1', nowIso: NU });
  assert.equal(r.ok, true);
  assert.equal(db.gedaan.patch.call_status, 'bevestigd');
  assert.equal(db.gedaan.patch.called, true);
});

test('een mislukte schrijfactie wordt GEMELD, niet geslikt', async () => {
  // De les van createFollowupLead(): die faalde maanden lang met de fout in een
  // waarschuwingslijst die niemand las, en 225 mensen verdwenen uit beeld.
  const db = nepDb({ rij: { id: 'a1', event_id: 'e1', status: 'aangemeld' }, schrijfFout: { message: 'kapot' } });
  const r = await bevestigDeelnemer({ supabaseAdmin: db, attendeeId: 'a1', nowIso: NU });
  assert.equal(r.ok, false);
  assert.match(r.fout, /kapot/);
});

test('zonder deelnemer geen fout maar een overgeslagen-melding', async () => {
  const r = await bevestigDeelnemer({ supabaseAdmin: nepDb({ rij: null }), attendeeId: null, nowIso: NU });
  assert.equal(r.ok, false);
  assert.equal(r.overgeslagen, true);
});

// ── En de aanroep, niet alleen de hulpfunctie ──────────────────────────────

test('de knop Bevestigd roept de sync echt aan, en meldt de uitkomst terug', () => {
  const bron = readFileSync('api/opvolging-aanmelding-actie.js', 'utf8');
  const i = bron.indexOf("if (actie === 'bevestigd')");
  const j = bron.indexOf("if (actie ===", i + 10);
  const blok = bron.slice(i, j > i ? j : undefined);
  assert.match(blok, /await bevestigDeelnemer\(\{/, 'de bevestigd-tak moet de sync aanroepen');
  assert.match(blok, /event_sync: eventSync/, 'de uitkomst hoort in het antwoord, niet alleen in een log');
  assert.match(blok, /console\.error/, 'een fout hoort luid te zijn');
});

test('beide callers gebruiken dezelfde definitie, er is geen tweede', () => {
  const opvolging = readFileSync('api/opvolging-aanmelding-actie.js', 'utf8');
  const followup  = readFileSync('api/follow-up-lead-outcome.js', 'utf8');
  assert.match(followup, /bevestigingPatch\(\{ huidigeStatus/, 'de oude weg hoort de gedeelde definitie te gebruiken');
  assert.match(opvolging, /event-attendee-bevestigen\.js/);
  // Geen eigen call_status-schrijfsel meer in de bevestigd-tak van de oude weg.
  const i = followup.indexOf("if (outcome === 'bevestigd') {");
  const blok = followup.slice(i, i + 600);
  assert.doesNotMatch(blok, /patchAttendee\.status = 'aangemeld'/,
    'de status-correctie hoort in de gedeelde functie te staan, niet hier opnieuw');
});

test('annuleren telt het aantal bevestigden opnieuw', () => {
  // Hetzelfde gat, de andere kant op: de status werd wel weggeschreven maar de
  // teller niet bijgewerkt, terwijl daar het openen van de inschrijving aan hangt.
  const bron = readFileSync('api/opvolging-aanmelding-actie.js', 'utf8');
  const i = bron.indexOf("if (actie === 'annuleer_in_event')");
  const blok = bron.slice(i, bron.indexOf("if (actie === 'bevestigd')"));
  assert.match(blok, /onConfirmedAttendeeMutation\(/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEE DINGEN DIE DE BOVENSTAANDE TESTS NIET ZAGEN
// ═══════════════════════════════════════════════════════════════════════════
//
// Bij het opnieuw nakijken van deze PR (hij lag 27 commits achter) zijn er twee
// bewuste regressies ingebouwd die NUL rood gaven:
//
//   · de herberekening van het aantal bevestigden overslaan;
//   · een deelnemer die niet meer bestaat als succes melden.
//
// De eerste is uitgerekend het punt dat de kop van
// api/_lib/event-attendee-bevestigen.js zelf aanwijst als 'wat je vergeet als
// je even een tweede weg bouwt' — aan dat aantal hangt het openen en sluiten
// van de inschrijving. Een test die het belangrijkste punt van een bestand niet
// bewaakt is precies de alibi-test die we deze week zes keer hebben opgeruimd.

/** Een supabaseAdmin die genoeg kan voor deze functie, en verder niets. */
function nepAdmin({ rij, schrijfFout = null }) {
  const geschreven = [];
  return {
    geschreven,
    from() {
      const q = {
        select: () => q,
        eq    : () => q,
        maybeSingle: async () => ({ data: rij, error: null }),
        update: (patch) => { geschreven.push(patch); return { eq: async () => ({ error: schrijfFout }) }; },
      };
      return q;
    },
  };
}

test('het aantal bevestigden wordt herberekend zodra de status meebeweegt', async () => {
  // Hieraan hangt het openen en sluiten van de inschrijving. Sla je dit over,
  // dan blijft een event onnodig dicht en ziet niemand waarom.
  const gebeld = [];
  const uit = await bevestigDeelnemer({
    supabaseAdmin: nepAdmin({ rij: { id: 'a1', event_id: 'ev-1', status: 'geannuleerd', call_status: null } }),
    attendeeId: 'a1', nowIso: NU, bron: 'test',
    herbereken: async (eventId, opts) => { gebeld.push({ eventId, opts }); },
  });
  assert.equal(uit.ok, true);
  assert.equal(uit.status_hersteld, 'geannuleerd');
  assert.equal(gebeld.length, 1, 'de teller hoort precies één keer herberekend te worden');
  assert.equal(gebeld[0].eventId, 'ev-1');
});

test('stond de deelnemer al gewoon aangemeld, dan verandert het aantal niet', async () => {
  // Geen status-wijziging betekent geen ander aantal bevestigden. Dan is een
  // herberekening zinloos werk op elke bevestiging.
  const gebeld = [];
  const uit = await bevestigDeelnemer({
    supabaseAdmin: nepAdmin({ rij: { id: 'a1', event_id: 'ev-1', status: 'aangemeld', call_status: null } }),
    attendeeId: 'a1', nowIso: NU,
    herbereken: async () => { gebeld.push(1); },
  });
  assert.equal(uit.ok, true);
  assert.equal(gebeld.length, 0);
});

test('een mislukte herberekening maakt de bevestiging niet ongedaan, maar wordt wel gemeld', async () => {
  const uit = await bevestigDeelnemer({
    supabaseAdmin: nepAdmin({ rij: { id: 'a1', event_id: 'ev-1', status: 'geannuleerd' } }),
    attendeeId: 'a1', nowIso: NU,
    herbereken: async () => { throw new Error('teller stuk'); },
  });
  assert.equal(uit.ok, true, 'de bevestiging zelf is geschreven en blijft staan');
  assert.match(String(uit.telling), /mislukt/);
  assert.match(String(uit.telling), /teller stuk/);
});

test('een deelnemer die niet meer bestaat is GEEN succes', async () => {
  // Ok teruggeven zou de caller laten melden dat de eventmodule bijgewerkt is
  // terwijl er niets gebeurd is. Overgeslagen, met de reden erbij.
  const uit = await bevestigDeelnemer({
    supabaseAdmin: nepAdmin({ rij: null }), attendeeId: 'weg', nowIso: NU,
    herbereken: async () => {},
  });
  assert.equal(uit.ok, false);
  assert.equal(uit.overgeslagen, true);
  assert.match(uit.fout, /bestaat niet meer/);
});

test('zonder attendee_id gebeurt er niets, en dat is geen fout om over te loggen', async () => {
  // Een opvolgkaart hoeft niet aan een deelnemer te hangen. Dan is er niets te
  // synchroniseren, en dat hoort geen foutmelding op te leveren.
  const uit = await bevestigDeelnemer({ supabaseAdmin: nepAdmin({ rij: null }), attendeeId: null, nowIso: NU });
  assert.equal(uit.ok, false);
  assert.equal(uit.overgeslagen, true);
});

test('de velden die weggeschreven worden zijn precies de bevestigingPatch', async () => {
  const admin = nepAdmin({ rij: { id: 'a1', event_id: 'ev-1', status: 'aangemeld' } });
  await bevestigDeelnemer({ supabaseAdmin: admin, attendeeId: 'a1', nowIso: NU, herbereken: async () => {} });
  assert.equal(admin.geschreven.length, 1);
  assert.deepEqual(admin.geschreven[0], bevestigingPatch({ huidigeStatus: 'aangemeld', nowIso: NU }));
});
