// tests/dunning-event-labels.test.js
//
// Unit-test voor api/_lib/dunning-event-labels.js — vertaal-tabel voor
// klantdossier. Geen DB, geen mocks — pure functie-tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  labelForDunningEvent,
  labelForPendingActionEvent,
  labelForArrangementEvent,
  humanize,
} from '../api/_lib/dunning-event-labels.js';

// ── Bekende event-types ───────────────────────────────────────────────────

test('labelForDunningEvent: bekend type geeft nette title', () => {
  assert.equal(labelForDunningEvent('email_sent').title, 'Aanmaning per e-mail verstuurd');
  assert.equal(labelForDunningEvent('whatsapp_sent').title, 'WhatsApp-aanmaning verstuurd');
  assert.equal(
    labelForDunningEvent('paused_customer_replied').title,
    'Klant reageerde — aanmaning gepauzeerd'
  );
  assert.equal(
    labelForDunningEvent('skipped_open_action').title,
    'Overgeslagen: er ligt nog een openstaande actie'
  );
});

test('labelForDunningEvent: paused_customer_replied gebruikt payload.channel in detail', () => {
  const out = labelForDunningEvent('paused_customer_replied', { channel: 'whatsapp' });
  assert.match(out.detail, /whatsapp/i);
});

test('labelForDunningEvent: skipped_open_action zet count + typen in detail', () => {
  const out = labelForDunningEvent('skipped_open_action', {
    count: 2,
    action_types: ['TL_INVOICE_UPDATE_DUE', 'MANUAL_VERIFY_PAYMENT'],
  });
  assert.match(out.detail, /2 openstaande actie/);
  assert.match(out.detail, /Factuur — nieuwe vervaldag/);
  assert.match(out.detail, /Betaling verifiëren/);
});

test('labelForDunningEvent: wait berekent dagen uit payload.seconds', () => {
  assert.equal(labelForDunningEvent('wait', { seconds: 86400 }).title, 'Wachtperiode van 1 dag');
  assert.equal(labelForDunningEvent('wait', { seconds: 604800 }).title, 'Wachtperiode van 7 dagen');
  assert.equal(labelForDunningEvent('wait', {}).title, 'Wachtperiode');
});

test('labelForDunningEvent: completed geeft reden in detail', () => {
  assert.match(labelForDunningEvent('completed', { reason: 'paid' }).detail, /klant heeft betaald/);
  assert.match(labelForDunningEvent('completed', { reason: 'manual' }).detail, /handmatig/);
});

test('labelForDunningEvent: run_control_pause krijgt status-transitie in detail', () => {
  const out = labelForDunningEvent('run_control_pause', {
    before_status: 'active',
    after_status:  'paused',
  });
  assert.equal(out.title, 'Aanmaan-flow handmatig gepauzeerd');
  assert.match(out.detail, /active/);
  assert.match(out.detail, /paused/);
});

// ── Onbekende types ───────────────────────────────────────────────────────

test('labelForDunningEvent: ONBEKEND type valt terug op humanized fallback (niet raw code)', () => {
  const out = labelForDunningEvent('some_new_event_type_added_by_mystery_pr');
  // Belangrijk: NIET de ruwe code, wel leesbaar.
  assert.notEqual(out.title, 'some_new_event_type_added_by_mystery_pr');
  assert.equal(out.title, 'Some new event type added by mystery pr');
});

test('labelForDunningEvent: leeg/null type geeft "Onbekend event"', () => {
  assert.equal(labelForDunningEvent(null).title, 'Onbekend event');
  assert.equal(labelForDunningEvent('').title, 'Onbekend event');
});

test('humanize: snake_case → Sentence case', () => {
  assert.equal(humanize('email_send_failed'), 'Email send failed');
  assert.equal(humanize('hello_world'), 'Hello world');
  assert.equal(humanize(''), 'Onbekend event');
});

// ── Pending-action state-transitions ──────────────────────────────────────

test('labelForPendingActionEvent: bekende action_type + transitie', () => {
  const out = labelForPendingActionEvent('TL_INVOICE_UPDATE_DUE', 'approved');
  assert.equal(out.title, 'Actie goedgekeurd: Factuur — nieuwe vervaldag');
});

test('labelForPendingActionEvent: onbekende action_type valt terug op humanized', () => {
  const out = labelForPendingActionEvent('NEW_ACTION_TYPE_2027', 'created');
  assert.match(out.title, /aangemaakt/);
  assert.match(out.title, /New action type 2027/);
});

// ── Arrangement events ────────────────────────────────────────────────────

test('labelForArrangementEvent: type + status samengesteld', () => {
  assert.equal(
    labelForArrangementEvent('UITSTEL', 'VOORGESTELD').title,
    'Regeling voorgesteld: Uitstel'
  );
  assert.equal(
    labelForArrangementEvent('SPLITSING', 'ACTIEF').title,
    'Regeling actief: Splitsing'
  );
  assert.equal(
    labelForArrangementEvent('KWIJTSCHELDING', 'GEANNULEERD').title,
    'Regeling geannuleerd: Kwijtschelding'
  );
});
