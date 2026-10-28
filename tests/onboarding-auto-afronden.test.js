// tests/onboarding-auto-afronden.test.js — automatisch afronden zonder sessie
// (Maxim, 28 oktober 2026): membership op de startdatum, mits ingevuld.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  besluitMembershipAfronden, autoAfrondPatch, dagBrussel, dagVan, dagPlus, dagenTussen,
  REDEN_MEMBERSHIP,
} from '../api/_lib/onboarding-auto-afronden.js';
import { afgeslotenDoor, onboardingAfgesloten, wizardDoorKlantVoltooid, lmsStandVoor } from '../api/_lib/onboarding-einde.js';

const VANDAAG = '2026-10-28';
const ingevuld = (over = {}) => ({ id: 'ob1', status: 'afgerond', completed_at: '2026-10-20T10:00:00Z', start_date: VANDAAG, ...over });

test('MEMBERSHIP: dicht op de startdatum (Brussel), mits zelf ingevuld', () => {
  assert.deepEqual(besluitMembershipAfronden(ingevuld(), 'membership', VANDAAG), { dicht: true, waarom: REDEN_MEMBERSHIP });
  assert.equal(besluitMembershipAfronden(ingevuld({ start_date: '2026-10-01' }), 'membership', VANDAAG).dicht, true);
  //  De dag ervoor nog niet.
  assert.equal(besluitMembershipAfronden(ingevuld({ start_date: '2026-10-29' }), 'membership', VANDAAG).waarom, 'start_nog_niet');
  //  Niet ingevuld: blijft open (dan doen de herinneringen hun werk).
  assert.equal(besluitMembershipAfronden(ingevuld({ status: 'bezig', completed_at: null }), 'membership', VANDAAG).waarom, 'niet_ingevuld');
  //  Met de hand afgerond = niet door de klant ingevuld, en al dicht.
  assert.equal(besluitMembershipAfronden(ingevuld({ handmatig_afgerond_op: '2026-10-20T10:00:00Z' }), 'membership', VANDAAG).waarom, 'al_afgerond');
});

test('MEMBERSHIP: 1-op-1, test, geannuleerd, incasso en zonder startdatum blijven open', () => {
  assert.equal(besluitMembershipAfronden(ingevuld(), '1op1', VANDAAG).waarom, 'geen_membership');
  assert.equal(besluitMembershipAfronden(ingevuld(), null, VANDAAG).waarom, 'geen_membership', 'onbekend traject = 1-op-1');
  assert.equal(besluitMembershipAfronden(ingevuld({ is_test: true }), 'membership', VANDAAG).waarom, 'test');
  assert.equal(besluitMembershipAfronden(ingevuld({ status: 'geannuleerd' }), 'membership', VANDAAG).waarom, 'niet_aanraken');
  assert.equal(besluitMembershipAfronden(ingevuld({ archived_at: '2026-10-01T00:00:00Z' }), 'membership', VANDAAG).waarom, 'niet_aanraken');
  assert.equal(besluitMembershipAfronden(ingevuld({ incasso_op: '2026-10-10T00:00:00Z' }), 'membership', VANDAAG).waarom, 'incasso');
  assert.equal(besluitMembershipAfronden(ingevuld({ start_date: null }), 'membership', VANDAAG).waarom, 'geen_startdatum');
});

test('DE PATCH: status + auto_afgerond_op; het wizardmoment blijft; de reden alleen met de kolom', () => {
  const p = autoAfrondPatch(ingevuld(), REDEN_MEMBERSHIP, '2026-10-28T07:10:00Z');
  assert.equal(p.status, 'afgerond');
  assert.equal(p.completed_at, '2026-10-20T10:00:00Z');
  assert.equal(p.auto_afgerond_op, '2026-10-28T07:10:00Z');
  assert.equal(p.auto_afgerond_reden, REDEN_MEMBERSHIP);
  assert.equal('auto_afgerond_reden' in autoAfrondPatch(ingevuld(), REDEN_MEMBERSHIP, 'x', { metReden: false }), false);
  //  Zonder wizardmoment: completed_at = het afsluitmoment → niet "door de klant ingevuld".
  const leeg = { id: 'ob2', status: 'bezig', completed_at: null };
  const q = autoAfrondPatch(leeg, 'oud_dossier', '2026-10-28T07:10:00Z');
  const na = { ...leeg, ...q };
  assert.equal(q.completed_at, '2026-10-28T07:10:00Z');
  assert.equal(wizardDoorKlantVoltooid(na), false);
  assert.equal(onboardingAfgesloten(na), true);
});

test('HOE HIJ DICHT GING: de reden, nooit "sessie" zonder sessie', () => {
  const na = { ...ingevuld(), auto_afgerond_op: '2026-10-28T07:10:00Z', auto_afgerond_reden: REDEN_MEMBERSHIP };
  assert.equal(afgeslotenDoor(na), 'membership_start');
  assert.equal(lmsStandVoor(na), 'afgerond');
  assert.equal(afgeslotenDoor({ ...na, auto_afgerond_reden: null }), 'automatisch', 'reden niet bewaard');
  assert.equal(afgeslotenDoor({ ...na, auto_afgerond_sessie_id: 'sess-1' }), 'sessie');
});

test('DAGEN IN BRUSSEL: 23:30 UTC is al de volgende dag', () => {
  assert.equal(dagBrussel(new Date('2026-10-27T23:30:00Z')), '2026-10-28');
  assert.equal(dagVan('2026-10-27T23:30:00Z'), '2026-10-28');
  assert.equal(dagVan('2026-10-28'), '2026-10-28');
  assert.equal(dagVan(null), null);
  assert.equal(dagPlus('2026-10-25', 15), '2026-11-09');
  assert.equal(dagenTussen('2026-10-25', '2026-11-09'), 15);
});

test('DE CRON: geheim, droogloop, idempotent, en in vercel.json', () => {
  const src = readFileSync(new URL('../api/cron/onboarding-auto-afronden.js', import.meta.url), 'utf8');
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /dry/);
  assert.match(src, /\.is\('auto_afgerond_op', null\)/);
  assert.doesNotMatch(src, /sendMail\(|sendOnboardingMail\(|sendOnboardingTemplate|metaPostMessage/, 'geen mail, geen WhatsApp');
  const lib = readFileSync(new URL('../api/_lib/onboarding-auto-afronden.js', import.meta.url), 'utf8');
  assert.match(lib, /\.is\('auto_afgerond_op', null\)\s*\n\s*\.is\('handmatig_afgerond_op', null\)/);
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(v.crons.some((c) => c.path === '/api/cron/onboarding-auto-afronden'));
});

test('DE WELKOMSTMAIL: uitnodiging_op valt terug op het log van de automation', () => {
  const src = readFileSync(new URL('../api/_lib/onboarding-overzicht-rijen.js', import.meta.url), 'utf8');
  assert.match(src, /uitnodiging_op:\s+r\.invite_sent_at \|\| welkomstByOb\.get\(r\.id\) \|\| null/);
  const lib = readFileSync(new URL('../api/_lib/onboarding-opvolg-kolommen.js', import.meta.url), 'utf8');
  assert.match(lib, /on_onboarding_created/);
  assert.match(lib, /result\?\.ok !== true/);
});
