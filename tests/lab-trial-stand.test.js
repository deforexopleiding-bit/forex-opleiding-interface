// tests/lab-trial-stand.test.js
//
// Opvolging › Leads bellen kent sinds 26 okt 2026 ook de trials in het echte
// LMS: labTrialAlsWarmte() geeft dezelfde vorm als normaliseerTrial(), zodat
// warmte en chips ("ingelogd", "3 lessen bekeken") gewoon werken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labScore, labTrialAlsWarmte } from '../api/_lib/lab-trial-stand.js';
import { berekenWarmte, gespreksopener, proefDuur } from '../api/_lib/opvolging-leads-pot.js';

const NU = Date.parse('2026-10-28T10:00:00Z');
const stand = (over = {}) => ({
  labLead: { email: 'lien@x.be', toegang_van: '2026-10-26T10:00:00Z', toegang_tot: '2026-11-02T10:00:00Z', eerste_login_op: '2026-10-26T12:00:00Z', laatste_login_op: '2026-10-27T20:00:00Z', product: 'minicursus', ...over.lead },
  sessie: over.sessie || null, videos: over.videos ?? 3, videoTijden: [], route: 'lab',
});

test('labScore: transparant en op de schaal van trial_warmte (max 45)', () => {
  assert.equal(labScore({ ingelogd: false, videos: 0 }), 0);
  assert.equal(labScore({ ingelogd: true, videos: 3 }), 17);
  assert.equal(labScore({ ingelogd: true, videos: 9, gestart: true, afgerond: true }), 45);
});

test('labTrialAlsWarmte: vorm van normaliseerTrial — ingelogd, lessen, looptijd 7 dagen', () => {
  const t = labTrialAlsWarmte(stand(), NU);
  assert.equal(t.ooit_ingelogd, true);
  assert.equal(t.lessen, 3);
  assert.equal(t.dagen_totaal, 7);
  assert.equal(proefDuur(t, 'Minicursus'), 7, 'de echte looptijd, niet de 30 dagen van de oude minicursus');
  assert.equal(t.dagen_over, 5);
  assert.equal(t.verlopen, false);
  assert.equal(t.laatst_actief, '2026-10-27T20:00:00Z');
  assert.equal(labTrialAlsWarmte(null), null);
});

test('Leads bellen: warmte en opener werken voor een lab-trial', () => {
  const trial = labTrialAlsWarmte(stand(), NU);
  const w = berekenWarmte({ lead: { aangemaakt: '2026-10-26T10:00:00Z', kwalificatie: 'toegang' }, trial, calls: {}, vandaag: '2026-10-28' });
  assert.ok(w.score > 30);
  assert.ok(w.chips.some((c) => c.tekst === 'ingelogd'));
  assert.ok(w.chips.some((c) => c.tekst === '3 lessen bekeken'));
  const niet = labTrialAlsWarmte(stand({ lead: { eerste_login_op: null, laatste_login_op: null }, videos: 0 }), NU);
  assert.match(gespreksopener({ trial: niet, calls: {}, vandaag: '2026-10-28' }), /Nog niet ingelogd/);
});
