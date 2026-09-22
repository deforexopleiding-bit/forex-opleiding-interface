// tests/support-acties.test.js
//
// Fase S2 — het uitvoeren van goedgekeurde support-acties.
//
// De kern van deze tests is één regel: een actie geldt alleen als uitgevoerd
// wanneer het onderliggende systeem dat bevestigt. Vooral het geval waarin
// het LMS de uitnodiging OVERSLAAT verdient bewaking — dat antwoord heeft
// ok:true en ziet er op het eerste gezicht uit als succes, terwijl er niets
// verstuurd is.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// mock.module kan per bestand maar ÉÉN keer, dus mocken we eenmalig met
// stubs die naar een mutabel object wijzen. Elke test zet daar zijn eigen
// gedrag in. Dat scheelt ook het cache-busten van de import — zie les 11 in
// CLAUDE.md over mock.module-caches.
const stub = {
  uitnodiging: async () => ({ ok: false, fout: 'niet gestubd' }),
  provision: async () => ({ ok: false, error: 'niet gestubd' }),
  notify: async () => ({ ok: true, count: 1 }),
  onboarding: null,          // rij die supabase teruggeeft voor onboardings
  gesprek: null,             // rij die supabase teruggeeft voor support_gesprekken
};

mock.module('../api/_lib/dfo-lms-uitnodiging.js', {
  namedExports: {
    stuurLmsUitnodiging: (...a) => stub.uitnodiging(...a),
    FOUT_PREFIX_HERSTELBAAR: 'UITNODIGING_MAIL_MISLUKT:',
    FOUT_PREFIX_ACTIE_VEREIST: 'UITNODIGING_WACHTWOORD_NIET_GEZET:',
  },
});
mock.module('../api/_lib/dfo-lms-student.js', {
  namedExports: { provisionDfoLmsStudent: (...a) => stub.provision(...a) },
});
mock.module('../api/_lib/notify.js', {
  namedExports: {
    createNotification: (...a) => stub.notify(...a),
    resolveOntvangersVoorRecht: async () => ({ ok: true, userIds: [] }),
  },
});

// Minimale supabase-dubbel: genoeg voor .from().select().eq().maybeSingle().
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: {
      from(tabel) {
        const rij = tabel === 'onboardings' ? stub.onboarding : stub.gesprek;
        const ketting = {
          select: () => ketting,
          eq: () => ketting,
          maybeSingle: async () => ({ data: rij, error: null }),
        };
        return ketting;
      },
    },
    supabase: {},
    createUserClient: () => ({}),
  },
});

const { voerActieUit, isUitvoerbaar } = await import('../api/_lib/support-actie-uitvoeren.js');

function herstel() {
  stub.uitnodiging = async () => ({ ok: false, fout: 'niet gestubd' });
  stub.provision = async () => ({ ok: false, error: 'niet gestubd' });
  stub.notify = async () => ({ ok: true, count: 1 });
  stub.onboarding = null;
  stub.gesprek = null;
}

const ACTIE = (soort, payload = {}) => ({
  id: 'a1', gesprek_id: 'g1', soort, omschrijving: 'test', payload,
});

test('alleen de drie bedoelde soorten zijn uitvoerbaar', () => {
  herstel();
  assert.equal(isUitvoerbaar('LMS_UITNODIGING_OPNIEUW'), true);
  assert.equal(isUitvoerbaar('LMS_PROVISIONING_OPNIEUW'), true);
  assert.equal(isUitvoerbaar('MENTOR_CONTACT'), true);
  // Een arrangement raakt facturen en abonnementen in TeamLeader; dat blijft
  // mensenwerk, hoe vaak het ook gevraagd wordt.
  assert.equal(isUitvoerbaar('BETALINGSAFSPRAAK'), false);
  assert.equal(isUitvoerbaar('HANDMATIG'), false);
  assert.equal(isUitvoerbaar('VERZONNEN'), false);
});

test('een niet-uitvoerbare soort wordt nooit als uitgevoerd gemeld', async () => {
  herstel();
  const r = await voerActieUit(ACTIE('BETALINGSAFSPRAAK'));
  assert.equal(r.status, 'mislukt');
  assert.equal(r.klantBericht, null);
});

test('een verstuurde uitnodiging telt als uitgevoerd', async () => {
  herstel();
  stub.uitnodiging = async () => ({ ok: true, verstuurd: true, student_id: 's1', verstuurd_naar: 'a@b.nl' });
  const r = await voerActieUit(ACTIE('LMS_UITNODIGING_OPNIEUW', { email: 'a@b.nl' }));
  assert.equal(r.status, 'uitgevoerd');
  assert.match(r.klantBericht, /opnieuw/i);
  assert.equal(r.resultaat.verstuurd_naar, 'a@b.nl');
});

test('DE GRENDEL: overgeslagen is geen succes, ook al is ok true', async () => {
  // Dit is het geval waar de actie juist voor bedoeld is, en precies het
  // geval waarin het LMS niets doet. Zou dit als uitgevoerd tellen, dan
  // krijgt de student een bericht dat er een mail onderweg is die nooit komt.
  herstel();
  stub.uitnodiging = async () => ({
    ok: true, overgeslagen: true, verstuurd: false,
    student_id: 's1', uitnodiging_verstuurd_op: '2026-09-01T10:00:00Z',
  });
  const r = await voerActieUit(ACTIE('LMS_UITNODIGING_OPNIEUW', { email: 'a@b.nl' }));
  assert.equal(r.status, 'mislukt');
  assert.equal(r.klantBericht, null, 'de klant mag hier niets over horen');
  assert.equal(r.resultaat.reden, 'lms_grendel');
  assert.match(r.uitleg, /wachtwoord resetten|uitnodiging_verstuurd_op/,
    'de uitleg moet zeggen wat een mens aan LMS-kant moet doen');
});

test('het onderscheid tussen mail-mislukt en wachtwoord-niet-gezet blijft leesbaar', async () => {
  for (const geval of [
    { code: 'mail_mislukt', fout: 'UITNODIGING_MAIL_MISLUKT: niets veranderd', herstelbaar: true },
    { code: 'mail_verstuurd_wachtwoord_niet_gezet', fout: 'UITNODIGING_WACHTWOORD_NIET_GEZET: kan niet inloggen', actie_vereist: true },
  ]) {
    herstel();
    stub.uitnodiging = async () => ({ ok: false, ...geval });
    const r = await voerActieUit(ACTIE('LMS_UITNODIGING_OPNIEUW', { email: 'a@b.nl' }));
    assert.equal(r.status, 'mislukt');
    assert.equal(r.resultaat.code, geval.code);
    assert.ok(r.uitleg.includes(geval.fout.split(':')[0]), 'de prefix moet in de uitleg blijven staan');
  }
});

test('zonder e-mailadres wordt er niets geprobeerd', async () => {
  herstel();
  let aangeroepen = 0;
  stub.uitnodiging = async () => { aangeroepen++; return { ok: true, verstuurd: true }; };
  const r = await voerActieUit({ id: 'a1', gesprek_id: null, soort: 'LMS_UITNODIGING_OPNIEUW', payload: {} });
  assert.equal(r.status, 'mislukt');
  assert.equal(aangeroepen, 0);
});

test('provisioning: geslaagd belooft een account, geen inlog', async () => {
  herstel();
  stub.provision = async () => ({ ok: true, student_id: 's9', email: 'a@b.nl' });
  const r = await voerActieUit(ACTIE('LMS_PROVISIONING_OPNIEUW', { onboarding_id: 'o1' }));
  assert.equal(r.status, 'uitgevoerd');
  assert.match(r.klantBericht, /account/i);
  assert.ok(!/inloggen kan nu/i.test(r.klantBericht), 'geen belofte over inloggen — dat is een aparte stap');
});

test('provisioning zonder onboarding faalt netjes', async () => {
  herstel();
  const r = await voerActieUit(ACTIE('LMS_PROVISIONING_OPNIEUW', {}));
  assert.equal(r.status, 'mislukt');
  assert.equal(r.resultaat.reden, 'geen_onboarding');
});

test('een uitzondering wordt een mislukking met uitleg, geen crash', async () => {
  herstel();
  stub.uitnodiging = async () => { throw new Error('netwerk stuk'); };
  const r = await voerActieUit(ACTIE('LMS_UITNODIGING_OPNIEUW', { email: 'a@b.nl' }));
  assert.equal(r.status, 'mislukt');
  assert.equal(r.resultaat.reden, 'uitzondering');
  assert.match(r.uitleg, /met de hand/);
});

/* ── De poort in het endpoint ─────────────────────────────────────────── */

test('uitvoeren hangt aan de S2-vlag en is fail-closed', () => {
  const src = readFileSync(new URL('../api/support-actie-besluit.js', import.meta.url), 'utf8');
  assert.match(src, /s2_acties_uitvoeren/, 'de vlag wordt niet gelezen');
  assert.match(src, /isUitvoerbaar\(actie\.soort\) && await mag_uitvoeren\(\)/,
    'goedkeuren moet zowel de soort als de vlag controleren');
  const fn = src.slice(src.indexOf('async function mag_uitvoeren'));
  assert.match(fn.slice(0, 600), /catch[\s\S]*?return false/,
    'bij een leesfout moet de vlag als uit gelden');
});

test('de klant hoort alleen iets bij een bevestigde uitvoering', () => {
  const src = readFileSync(new URL('../api/support-actie-besluit.js', import.meta.url), 'utf8');
  assert.match(src, /uitkomst\.status === 'uitgevoerd' && uitkomst\.klantBericht/,
    'er mag geen bericht naar de klant bij een mislukte of onzekere uitvoering');
});
