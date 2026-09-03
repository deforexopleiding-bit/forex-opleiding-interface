// tests/events-opvolging-taak.test.js
//
// Punt B uit api/_lib/events-complete-core.js: de vertaling van 'wat is er op
// het event gebeurd' naar een kaart in public.opvolging_taken.
//
// Waarom dit bewaakt wordt: elk van de zes gevallen kan stil de verkeerde kant
// op vallen. Een gemiste kaart betekent dat iemand nooit gebeld wordt; een
// kaart te veel betekent dat een klant die net getekend heeft alsnog op de
// bellijst staat. Allebei merk je pas dagen later, en dan is het al gebeurd.
//
// De zes gevallen uit de vertaaltabel:
//   1. aanwezig + opvolgen       → kaart, reden 'wil_nog_beslissen'
//   2. aanwezig + klant_geworden → GEEN kaart
//   3. aanwezig + geen_interesse → kaart, meteen gearchiveerd, met bezwaar
//   4. aanwezig + nog_onbekend   → GEEN kaart
//   5. no_show                   → kaart, reden 'no_show_event'
//   6. afgemeld                  → kaart, reden 'afgemeld'

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwOpvolgingTaak, opvolgingBadgeLabel, AFWEZIG_BELMOMENT_DAGEN, datumOverDagen,
} from '../api/_lib/events-complete-core.js';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const ATT_ID   = '22222222-2222-4222-8222-222222222222';
const FU_ID    = '33333333-3333-4333-8333-333333333333';

const ATT = {
  id: ATT_ID, customer_id: null,
  first_name: 'Dave', last_name: 'Klaassen',
  email: 'dave@example.com', phone: '+32470123456',
};

/** Alles wat niet per geval verschilt, op één plek. */
function bouw(extra) {
  return bouwOpvolgingTaak({
    eventId    : EVENT_ID,
    att        : ATT,
    followupId : FU_ID,
    badgeLabel : 'Masterclass Gent · 27 aug',
    ...extra,
  });
}

// ── De vertaaltabel, geval voor geval ──────────────────────────────────────

test('1 · aanwezig + opvolgen wordt een open kaart met het gekozen belmoment', () => {
  const t = bouw({
    attendanceStatus: 'aanwezig',
    outcome         : 'opvolgen',
    followup        : { follow_up_date: '2026-09-10', reason: 'Wil het thuis bespreken' },
  });
  assert.ok(t, 'er hoort een kaart te ontstaan');
  assert.equal(t.reden, 'wil_nog_beslissen');
  assert.equal(t.status, 'open');
  assert.equal(t.due, '2026-09-10');
  assert.equal(t.notitie, 'Wil het thuis bespreken');
  // Geen archief-sporen op een kaart die juist open moet staan.
  assert.equal(t.gearchiveerd_at, undefined);
  assert.equal(t.archief_reden, undefined);
});

test('2 · aanwezig + klant_geworden levert GEEN kaart op', () => {
  assert.equal(bouw({ attendanceStatus: 'aanwezig', outcome: 'klant_geworden' }), null);
});

test('3 · aanwezig + geen_interesse wordt meteen gearchiveerd, met het bezwaar', () => {
  const t = bouw({
    attendanceStatus: 'aanwezig',
    outcome         : 'geen_interesse',
    outcomeReason   : 'Te duur',
  });
  assert.ok(t, 'ook een afwijzing hoort vastgelegd te worden');
  assert.equal(t.status, 'gearchiveerd');
  assert.equal(t.archief_reden, 'Te duur');
  assert.match(t.gearchiveerd_at, /^\d{4}-\d{2}-\d{2}T/);
  // `reden` is NOT NULL met een CHECK op vijf waarden; ook de dichte kaart
  // draagt er één. De echte informatie zit in archief_reden.
  assert.equal(t.reden, 'wil_nog_beslissen');
});

test('4 · aanwezig + nog_onbekend levert GEEN kaart op', () => {
  assert.equal(bouw({ attendanceStatus: 'aanwezig', outcome: 'nog_onbekend' }), null);
});

test('5 · no_show wordt een kaart met de aangeklikte reden', () => {
  const t = bouw({
    attendanceStatus: 'no_show',
    afwezig         : { reason_code: 'kon_niet', follow_up_date: '2026-09-04', note: 'Ziek' },
  });
  assert.ok(t);
  assert.equal(t.reden, 'no_show_event');
  assert.equal(t.reden_code, 'kon_niet');
  assert.equal(t.status, 'open');
  assert.equal(t.due, '2026-09-04');
  assert.equal(t.notitie, 'Ziek');
});

test('6 · afgemeld wordt een kaart met dezelfde vorm, andere reden', () => {
  const t = bouw({
    attendanceStatus: 'afgemeld',
    afwezig         : { reason_code: 'afgemeld_bericht', follow_up_date: '2026-09-06' },
  });
  assert.ok(t);
  assert.equal(t.reden, 'afgemeld');
  assert.equal(t.reden_code, 'afgemeld_bericht');
  assert.equal(t.status, 'open');
  assert.equal(t.due, '2026-09-06');
});

// ── De randen van dezelfde tabel ───────────────────────────────────────────

test('een afwezige zonder ingevuld blok raakt niet kwijt', () => {
  // Dit is de reden dat de bestaande weg hierboven altijd opengaat bij een
  // no-show: op 26 augustus verdween iemand omdat er niets was aangeklikt.
  // Punt B mag dat gat niet opnieuw maken.
  for (const status of ['no_show', 'afgemeld']) {
    const t = bouw({ attendanceStatus: status });
    assert.ok(t, `${status} zonder blok hoort toch een kaart op te leveren`);
    assert.equal(t.reden_code, 'onbekend');
    assert.equal(t.due, datumOverDagen(AFWEZIG_BELMOMENT_DAGEN[status]));
    assert.equal(t.notitie, undefined);
  }
});

test('een verzonnen afwezig-reden wordt onbekend, niet doorgelaten', () => {
  const t = bouw({ attendanceStatus: 'no_show', afwezig: { reason_code: 'had_geen_zin' } });
  assert.equal(t.reden_code, 'onbekend');
});

test('opvolgen zonder belmoment laat due weg zodat de database vandaag invult', () => {
  const t = bouw({
    attendanceStatus: 'aanwezig', outcome: 'opvolgen',
    followup        : { reason: 'Belt zelf terug' },
  });
  // due heeft `default current_date`; de sleutel weglaten is dus veiliger dan
  // er null in schrijven — die kolom is NOT NULL.
  assert.equal('due' in t, false);
  assert.equal(t.notitie, 'Belt zelf terug');
});

test('geen_interesse zonder bezwaar levert nog steeds een gearchiveerde kaart', () => {
  const t = bouw({ attendanceStatus: 'aanwezig', outcome: 'geen_interesse' });
  assert.equal(t.status, 'gearchiveerd');
  assert.equal(t.archief_reden, null);
});

// ── De vaste velden die elke kaart draagt ──────────────────────────────────

test('elke kaart draagt bron, bron_ref, badge en contactgegevens', () => {
  const gevallen = [
    { attendanceStatus: 'aanwezig', outcome: 'opvolgen', followup: { follow_up_date: '2026-09-10', reason: 'x' } },
    { attendanceStatus: 'aanwezig', outcome: 'geen_interesse', outcomeReason: 'Te duur' },
    { attendanceStatus: 'no_show',  afwezig: { reason_code: 'kon_niet' } },
    { attendanceStatus: 'afgemeld', afwezig: { reason_code: 'kon_niet' } },
  ];
  for (const g of gevallen) {
    const t = bouw(g);
    assert.equal(t.bron, 'event');
    assert.deepEqual(t.bron_ref, { event_id: EVENT_ID, attendee_id: ATT_ID, followup_id: FU_ID });
    assert.equal(t.badge_label, 'Masterclass Gent · 27 aug');
    assert.equal(t.naam, 'Dave Klaassen');
    assert.equal(t.email, 'dave@example.com');
    assert.equal(t.telefoon, '+32470123456');
    // De RLS op opvolging_taken is is_crm_staff() — een rolcheck, geen
    // eigenaarscheck. Zonder eigenaar is de kaart dus van het team, niet
    // van niemand.
    assert.equal(t.eigenaar_id, null);
  }
});

test('naam valt terug op het mailadres en dan op (onbekend)', () => {
  const zonderNaam = bouwOpvolgingTaak({
    attendanceStatus: 'no_show', eventId: EVENT_ID,
    att: { id: ATT_ID, email: 'x@example.com' },
  });
  assert.equal(zonderNaam.naam, 'x@example.com');

  const kaal = bouwOpvolgingTaak({
    attendanceStatus: 'no_show', eventId: EVENT_ID, att: { id: ATT_ID },
  });
  // `naam` is NOT NULL — een lege string zou de insert laten klappen.
  assert.equal(kaal.naam, '(onbekend)');
  assert.equal(kaal.bron_ref.followup_id, null);
});

test('een onbekende aanwezigheidsstatus levert niets op', () => {
  for (const raar of [null, '', 'switched_to_other_event', 'AANWEZIG']) {
    assert.equal(bouw({ attendanceStatus: raar, outcome: 'opvolgen' }), null);
  }
});

// ── Het etiket op de kaart ─────────────────────────────────────────────────

test('het badge-label is de eventnaam plus de dag in Amsterdamse tijd', () => {
  assert.equal(opvolgingBadgeLabel('Masterclass Gent', '2026-08-27T18:00:00Z'), 'Masterclass Gent · 27 aug');
  // 23:30 UTC is in Amsterdam al de volgende dag. Op de UTC-dag afgaan zou
  // een avondevent stelselmatig een dag te vroeg labelen.
  assert.equal(opvolgingBadgeLabel('Avondsessie', '2026-08-27T23:30:00Z'), 'Avondsessie · 28 aug');
});

test('een half of kapot label is geen reden om de kaart te laten vallen', () => {
  assert.equal(opvolgingBadgeLabel('Alleen naam', null), 'Alleen naam');
  assert.equal(opvolgingBadgeLabel(null, '2026-08-27T18:00:00Z'), '27 aug');
  assert.equal(opvolgingBadgeLabel(null, 'geen datum'), null);
  assert.equal(opvolgingBadgeLabel('', null), null);
});
