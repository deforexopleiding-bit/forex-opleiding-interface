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
  patch: null,               // laatste .update()-payload die rijen raakte
  geraakt: null,             // hoeveel rijen die laatste update raakte
  schrijffout: null,         // zet dit om de SLOT-schrijfactie te laten falen
  tussendoor: null,          // draait eenmalig vlak vóór de claim: de race
  gedaan: 0,                 // hoe vaak er echt iets is uitgevoerd
  berichten: [],             // wat er naar de klant geschreven is
};

mock.module('../api/_lib/dfo-lms-uitnodiging.js', {
  namedExports: {
    stuurLmsUitnodiging: (...a) => { stub.gedaan++; return stub.uitnodiging(...a); },
    FOUT_PREFIX_HERSTELBAAR: 'UITNODIGING_MAIL_MISLUKT:',
    FOUT_PREFIX_ACTIE_VEREIST: 'UITNODIGING_WACHTWOORD_NIET_GEZET:',
  },
});
mock.module('../api/_lib/dfo-lms-student.js', {
  namedExports: { provisionDfoLmsStudent: (...a) => { stub.gedaan++; return stub.provision(...a); } },
});
mock.module('../api/_lib/notify.js', {
  namedExports: {
    createNotification: (...a) => { stub.gedaan++; return stub.notify(...a); },
    resolveOntvangersVoorRecht: async () => ({ ok: true, userIds: [] }),
  },
});

// Supabase-dubbel dat de RIJ-GRENDEL echt nabootst. Een update met een
// status-filter (de claim) raakt alleen een rij waarvan de stand klopt; anders
// nul rijen. Zonder die getrouwheid zou de race-test niets bewijzen.
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: {
      from(tabel) {
        const filters = [];
        let modus = 'select';
        let patch = null;

        const rijVoorTabel = () => (
          tabel === 'onboardings' ? stub.onboarding
            : tabel === 'joost_config' ? stub.config
              : tabel === 'support_acties' ? stub.actie
                : stub.gesprek
        );
        const statusFilter = () => filters.find((f) => f[1] === 'status') || null;
        const voldoet = (rij) => {
          const f = statusFilter();
          if (!f) return true;
          return f[0] === 'in' ? f[2].includes(rij?.status) : rij?.status === f[2];
        };

        async function resultaat(enkel) {
          const leeg = enkel ? { data: null, error: null } : { data: [], error: null };
          if (modus !== 'update') {
            const rij = rijVoorTabel();
            return enkel ? { data: rij, error: null } : { data: rij ? [rij] : [], error: null };
          }

          const isClaim = !!statusFilter();
          // De race: iemand anders wijzigt de rij tussen het lezen en de claim.
          if (isClaim && stub.tussendoor) {
            const f = stub.tussendoor; stub.tussendoor = null; f();
          }
          if (!isClaim && stub.schrijffout) {
            return { data: null, error: { message: stub.schrijffout } };
          }

          const rij = rijVoorTabel();
          if (!rij || !voldoet(rij)) { stub.geraakt = 0; return leeg; }

          Object.assign(rij, patch);
          stub.patch = patch;
          stub.geraakt = 1;
          const kopie = { ...rij };
          return enkel ? { data: kopie, error: null } : { data: [kopie], error: null };
        }

        const ketting = {
          select: () => ketting,
          eq: (k, v) => { filters.push(['eq', k, v]); return ketting; },
          in: (k, v) => { filters.push(['in', k, v]); return ketting; },
          update: (p) => { modus = 'update'; patch = p; return ketting; },
          maybeSingle: () => resultaat(true),
          then: (ok, nee) => resultaat(false).then(ok, nee),
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
  namedExports: {
    schrijfBericht: async (b) => { stub.berichten.push(b); return { ok: true }; },
  },
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
  stub.geraakt = null;
  stub.schrijffout = null;
  stub.tussendoor = null;
  stub.gedaan = 0;
  stub.berichten = [];
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

/* ── Het besluit-endpoint: claim → uitvoeren → vastleggen ─────────────── */

const ACTIE_ID = '11111111-1111-4111-8111-111111111111';

/** Zet een actie klaar in de gegeven stand. */
function actieOp(status, soort = 'MENTOR_CONTACT') {
  stub.actie = {
    id: ACTIE_ID, gesprek_id: 'g1', soort, status,
    omschrijving: 'mentor laten bellen', payload: { onboarding_id: 'o1' },
  };
}

/** Zet de S2-vlag aan en maak MENTOR_CONTACT uitvoerbaar. */
function s2Aan() {
  stub.config = { feature_flags: { s2_acties_uitvoeren: true } };
  stub.onboarding = { mentor_user_id: 'm1' };
  stub.notify = async () => ({ ok: true, count: 1 });
}

async function besluit(keuze) {
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

test('de gelukkige weg: claim, uitvoeren, vastleggen', async () => {
  herstel(); actieOp('voorgesteld'); s2Aan();
  const res = await besluit('goedkeuren');
  assert.equal(res.code, 200);
  assert.equal(res.body.uitvoering.status, 'uitgevoerd');
  assert.equal(res.body.uitvoering.vastgelegd, true);
  assert.equal(stub.actie.status, 'uitgevoerd');
  assert.equal(stub.gedaan, 1);
  assert.equal(stub.berichten.length, 1, 'de klant hoort het pas na een bevestigde uitvoering');
});

test('VERLOREN RACE: wie de claim verliest voert NIETS uit', async () => {
  // De actie staat op 'voorgesteld' als het endpoint 'm leest, maar een
  // collega keurt 'm goed vlak voordat onze claim landt. Zonder de grendel in
  // de query zouden we hier de handeling een tweede keer uitvoeren.
  herstel(); actieOp('voorgesteld'); s2Aan();
  stub.tussendoor = () => { stub.actie.status = 'goedgekeurd'; };

  const res = await besluit('goedkeuren');
  assert.equal(res.code, 409);
  assert.equal(stub.geraakt, 0, 'de claim hoort nul rijen te raken');
  assert.equal(stub.gedaan, 0, 'er mag NIETS uitgevoerd zijn');
  assert.equal(stub.berichten.length, 0, 'en de klant hoort niets');
  assert.match(res.body.error, /inmiddels op goedgekeurd/);
});

test('VERLOREN RACE bij "Gedaan": de klant krijgt geen tweede bericht', async () => {
  herstel(); actieOp('goedgekeurd');
  stub.tussendoor = () => { stub.actie.status = 'uitgevoerd'; };

  const res = await besluit('uitgevoerd');
  assert.equal(res.code, 409);
  assert.equal(stub.berichten.length, 0);
});

test('een tweede klik op een al uitgevoerde actie voert niets uit', async () => {
  herstel(); actieOp('uitgevoerd'); s2Aan();
  const res = await besluit('uitgevoerd');
  assert.equal(res.code, 409);
  assert.equal(stub.gedaan, 0);
  assert.equal(stub.berichten.length, 0);
});

test('GEFAALDE SLOTSCHRIJFACTIE: eerlijk melden, niet stilletjes doorgaan', async () => {
  // De handeling is gebeurd, het vastleggen niet. Dat mag geen 200 opleveren
  // en al helemaal geen bericht aan de klant — de collega moet weten dat hij
  // moet controleren en met de hand moet afronden.
  herstel(); actieOp('voorgesteld'); s2Aan();
  stub.schrijffout = 'verbinding weg';

  const res = await besluit('goedkeuren');
  assert.equal(res.code, 500);
  assert.equal(stub.gedaan, 1, 'de handeling is wél uitgevoerd');
  assert.equal(res.body.uitvoering.vastgelegd, false);
  assert.match(res.body.error, /WÉL uitgevoerd/);
  assert.match(res.body.error, /op gedaan/, 'zeg wat de collega nu moet doen');
  assert.equal(stub.berichten.length, 0, 'geen bericht: dat komt bij "Gedaan"');
  assert.equal(stub.actie.status, 'goedgekeurd', 'de actie blijft in de S1-toestand staan');
});

test('een MISLUKTE actie mag alsnog op gedaan — anders is "Toch gedaan" een dode knop', async () => {
  herstel(); actieOp('mislukt');
  const res = await besluit('uitgevoerd');
  assert.equal(res.code, 200);
  assert.equal(stub.actie.status, 'uitgevoerd');
  assert.equal(stub.berichten.length, 1, 'de klant hoort nu alsnog dat het geregeld is');
});

test('een goedgekeurde actie op gedaan zetten blijft werken', async () => {
  herstel(); actieOp('goedgekeurd');
  const res = await besluit('uitgevoerd');
  assert.equal(res.code, 200);
  assert.equal(stub.actie.status, 'uitgevoerd');
});

test('staat de vlag uit, dan blijft het bij goedgekeurd en gebeurt er niets', async () => {
  herstel(); actieOp('voorgesteld');
  stub.config = { feature_flags: {} };
  const res = await besluit('goedkeuren');
  assert.equal(res.code, 200);
  assert.equal(res.body.uitvoering, null);
  assert.equal(stub.actie.status, 'goedgekeurd');
  assert.equal(stub.gedaan, 0);
  assert.equal(stub.berichten.length, 0);
});

test('alleen vooruit: de verboden overgangen geven 409 zonder iets te doen', async () => {
  for (const [status, keuze] of [
    ['mislukt', 'goedkeuren'], ['mislukt', 'afwijzen'],
    ['goedgekeurd', 'goedkeuren'], ['afgewezen', 'uitgevoerd'],
    ['voorgesteld', 'uitgevoerd'], ['uitgevoerd', 'goedkeuren'],
  ]) {
    herstel(); actieOp(status); s2Aan();
    const res = await besluit(keuze);
    assert.equal(res.code, 409, `${status} + ${keuze} hoort 409 te geven`);
    assert.equal(stub.actie.status, status, 'de stand mag niet wijzigen');
    assert.equal(stub.gedaan, 0);
  }
});

test('afwijzen kan ook maar één keer', async () => {
  herstel(); actieOp('voorgesteld');
  assert.equal((await besluit('afwijzen')).code, 200);
  assert.equal(stub.actie.status, 'afgewezen');
  assert.equal((await besluit('afwijzen')).code, 409);
});
