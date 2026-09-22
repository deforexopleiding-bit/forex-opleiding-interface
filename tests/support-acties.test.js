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
  config: null,              // rij die supabase teruggeeft voor joost_config
  actie: null,               // rij die supabase teruggeeft voor support_acties
  patch: null,               // laatste .update()-payload, om te kunnen nakijken
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

// Minimale supabase-dubbel: genoeg voor .from().select().eq().maybeSingle()
// en voor de .update().eq().select().maybeSingle() van het besluit-endpoint.
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: {
      from(tabel) {
        const rij = tabel === 'onboardings' ? stub.onboarding
          : tabel === 'joost_config' ? stub.config
          : tabel === 'support_acties' ? stub.actie
          : stub.gesprek;
        const ketting = {
          select: () => ketting,
          eq: () => ketting,
          update: (p) => { stub.patch = p; return ketting; },
          maybeSingle: async () => ({ data: rij, error: null }),
        };
        return ketting;
      },
    },
    supabase: {},
    createUserClient: () => ({}),
  },
});

// Het besluit-endpoint erbij: auth en het schrijven in het gesprek zijn hier
// niet wat we toetsen, dus die worden weggenomen.
mock.module('../api/_lib/support-staff.js', {
  namedExports: {
    staffUit: async () => ({ user: { id: '00000000-0000-4000-8000-000000000001' } }),
    verkeerdeMethode: () => false,
    basisHeaders: () => {},
  },
});
mock.module('../api/_lib/support-sessie.js', {
  namedExports: { schrijfBericht: async () => ({ ok: true }) },
});

const { voerActieUit, isUitvoerbaar } = await import('../api/_lib/support-actie-uitvoeren.js');
const { default: besluitHandler } = await import('../api/support-actie-besluit.js');

function herstel() {
  stub.uitnodiging = async () => ({ ok: false, fout: 'niet gestubd' });
  stub.provision = async () => ({ ok: false, error: 'niet gestubd' });
  stub.notify = async () => ({ ok: true, count: 1 });
  stub.onboarding = null;
  stub.gesprek = null;
  stub.config = null;
  stub.actie = null;
  stub.patch = null;
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

test('MENTOR_CONTACT: ok met count 0 is geen succes', async () => {
  // Dezelfde vorm als de LMS-grendel: van buiten geslaagd, van binnen niets
  // gebeurd. createNotification() geeft dit terug bij een lege ontvangerslijst
  // of wanneer de dedup-tak de melding overslaat. Telde dit als uitgevoerd,
  // dan hoorde de student dat zijn mentor is ingelicht terwijl er geen melding
  // bestaat.
  herstel();
  stub.onboarding = { mentor_user_id: 'm1' };
  stub.notify = async () => ({ ok: true, count: 0 });
  const r = await voerActieUit(ACTIE('MENTOR_CONTACT', { onboarding_id: 'o1' }));
  assert.equal(r.status, 'mislukt');
  assert.equal(r.klantBericht, null, 'de klant mag hier niets over horen');
  assert.equal(r.resultaat.reden, 'notificatie_leeg');
  assert.match(r.uitleg, /zelf even in/, 'de uitleg moet zeggen wat een mens moet doen');
});

test('MENTOR_CONTACT: een weggeschreven melding telt wel', async () => {
  herstel();
  stub.onboarding = { mentor_user_id: 'm1' };
  stub.notify = async () => ({ ok: true, count: 1 });
  const r = await voerActieUit(ACTIE('MENTOR_CONTACT', { onboarding_id: 'o1' }));
  assert.equal(r.status, 'uitgevoerd');
  assert.equal(r.resultaat.mentor_user_id, 'm1');
  assert.match(r.klantBericht, /mentor/i);
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


/* ── "Toch gedaan": het herstelpad na een mislukte uitvoering ─────────── */

const ACTIE_ID = '11111111-1111-4111-8111-111111111111';

/** Roept het besluit-endpoint aan en geeft { code, body } terug. */
async function besluit(status, keuze) {
  stub.actie = {
    id: ACTIE_ID, gesprek_id: 'g1', soort: 'MENTOR_CONTACT',
    omschrijving: 'mentor laten bellen', payload: {}, status,
  };
  const res = { code: null, body: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = () => {};
  await besluitHandler(
    { method: 'POST', headers: {}, body: { actie_id: ACTIE_ID, besluit: keuze } },
    res,
  );
  return res;
}

test('een MISLUKTE actie mag alsnog op gedaan — anders is "Toch gedaan" een dode knop', async () => {
  herstel();
  const res = await besluit('mislukt', 'uitgevoerd');
  assert.equal(res.code, 200);
  assert.equal(stub.patch.status, 'uitgevoerd');
  assert.ok(stub.patch.uitgevoerd_op, 'het tijdstip hoort vastgelegd te worden');
});

test('een goedgekeurde actie op gedaan zetten blijft werken', async () => {
  herstel();
  const res = await besluit('goedgekeurd', 'uitgevoerd');
  assert.equal(res.code, 200);
  assert.equal(stub.patch.status, 'uitgevoerd');
});

test('een tweede klik op een al uitgevoerde actie geeft 409', async () => {
  // Anders krijgt de klant een tweede "we hebben dit voor je gedaan".
  herstel();
  const res = await besluit('uitgevoerd', 'uitgevoerd');
  assert.equal(res.code, 409);
  assert.equal(stub.patch, null, 'er mag dan niets weggeschreven worden');
});

test('de andere besluiten blijven ongemoeid: alleen vanuit voorgesteld', async () => {
  for (const [status, keuze] of [
    ['mislukt', 'goedkeuren'], ['mislukt', 'afwijzen'],
    ['goedgekeurd', 'goedkeuren'], ['afgewezen', 'uitgevoerd'],
    ['voorgesteld', 'uitgevoerd'],
  ]) {
    herstel();
    const res = await besluit(status, keuze);
    assert.equal(res.code, 409, `${status} + ${keuze} hoort 409 te geven`);
  }
});
