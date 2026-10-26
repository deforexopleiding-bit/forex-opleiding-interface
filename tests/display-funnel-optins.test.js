// tests/display-funnel-optins.test.js
//
// Borgt dat de funnelstatistieken op het Live Kantoorbord (/api/display-funnel)
// hun OPT-INS uit dezelfde canonieke bron halen als de KPI "Nieuwe leads" en
// "Nieuwe leads per bron" (computeAanmeldingenPerFunnel), zodat:
//   - de som van de funnel-opt-ins = het KPI-totaal voor de periode,
//   - webinar-aanmeldingen in de Webinar-rij meekomen,
//   - heraanmeldingen (bestaande lead, opnieuw via een funnel) meetellen.
//
// We voeden de ECHTE, pure telling (telAanmeldingen) en mappen die met de
// ECHTE canoniekeOptins() uit de endpoint — geen replica.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telAanmeldingen } from '../api/_lib/aanmeldingen-per-funnel.js';
import { canoniekeOptins } from '../api/display-funnel.js';

test('canonieke funnel-opt-ins = KPI-totaal, incl. webinar + heraanmelding', () => {
  const nieuweLeads = [
    { id: 'L1', email: 'a@x.nl', bron: 'kennismakingscursus-v5', traject: 'mini-cursus',   afwijzer: false },
    { id: 'L2', email: 'b@x.nl', bron: '7-daagse-v5',            traject: '7-daagse',      afwijzer: false },
    { id: 'L3', email: 'c@x.nl', bron: 'the-lab-v1',             traject: 'the-lab',       afwijzer: false },
    { id: 'L4', email: 'd@x.nl', bron: 'strategiescan-v1',       traject: 'strategiescan', afwijzer: false },
    { id: 'L5', email: 'e@x.nl', bron: 'opstartsessie',          traject: 'opstartsessie', afwijzer: false },
    { id: 'L6', email: 'f@x.nl', bron: 'iets',                   traject: 'onbekend-iets', afwijzer: false },
  ];
  // Heraanmelding: bestaande lead OLD9 meldt zich opnieuw via een mini-funnel.
  // Die zit NIET in nieuweLeads (aangemaakt op een oude datum), maar moet tóch
  // meetellen voor de mini-opt-ins — precies wat eerder miste.
  const funnelEvents = [
    { session_id: 's1', variant: 'kennismakingscursus-v5', event_type: 'lead_ingediend', lead_id: 'OLD9' },
  ];
  // Twee echte webinar-aanmeldingen (eerder toonde de Webinar-rij 0).
  const webinarAanmeldingen = [
    { id: 'w1', email: 'g@x.nl', is_test: false },
    { id: 'w2', email: 'h@x.nl', is_test: false },
  ];

  const { totaal, tegels } = telAanmeldingen({ nieuweLeads, funnelEvents, webinarAanmeldingen });
  const canon = canoniekeOptins(tegels);
  const som = Object.values(canon).reduce((a, b) => a + b, 0);

  assert.equal(totaal, 9, 'KPI-totaal');
  assert.equal(som, totaal, 'som van de canonieke funnel-opt-ins = KPI-totaal');
  assert.equal(canon.webinar, 2, 'webinar-aanmeldingen tellen mee in de Webinar-rij');
  assert.equal(canon.mini, 2, 'mini bevat de heraanmelding (L1 + OLD9)');
  assert.equal(canon['7-daagse'], 1);
  assert.equal(canon.events, 0);
  assert.equal(canon['the-lab'], 1);
  assert.equal(canon.strategiescan, 1);
  assert.equal(canon.overig, 2, 'overig = opstartsessie + overige leads (L5 + L6)');
});

test('canoniekeOptins(null) → null (endpoint valt dan terug op de tracking-telling)', () => {
  assert.equal(canoniekeOptins(null), null);
});
