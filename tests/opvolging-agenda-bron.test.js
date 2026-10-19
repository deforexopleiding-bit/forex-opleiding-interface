// tests/opvolging-agenda-bron.test.js — de agenda geeft de bron van een
// afspraak door, zodat Daves dag een boeking uit The Lab herkenbaar toont
// (chip "The Lab · strategiescan" in modules/klanten-v2/views/opvolging-v2.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

test('gepland en bezet dragen de bron; zonder bron null', () => {
  const dag = '2026-10-20';
  const dagen = voegAgendaSamen({
    slots: { [dag]: ['10:00', '14:00'] },
    afspraken: [
      { id: 'a1', scheduled_at: '2026-10-20T12:00:00Z', lead_name: 'Lien Peeters', status: 'scheduled', booking_source: 'the-lab' },
      { id: 'a2', scheduled_at: '2026-10-20T08:00:00Z', lead_name: 'Jan', status: 'scheduled', booking_source: null },
    ],
    van: dag, tot: dag, timeZone: 'Europe/Brussels', nuMs: Date.parse('2026-10-19T08:00:00Z'),
  });
  const d = dagen.find((x) => x.dag === dag);
  const lab = d.bezet.find((b) => b.naam === 'Lien Peeters');
  assert.equal(lab.bron, 'the-lab');
  assert.equal(d.bezet.find((b) => b.naam === 'Jan').bron, null);
  if (d.gepland) assert.equal(d.gepland.find((b) => b.naam === 'Lien Peeters').bron, 'the-lab');
});
