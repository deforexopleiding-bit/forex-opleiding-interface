// tests/onboarding-eerste-sessie-watermerk.test.js
//
// Het watermerk van de afsluitcron, met de ECHTE handler.
//
// ── WAT HIER MISGING ──────────────────────────────────────────────────────
// De eerste versie verzette het watermerk alleen na een geslaagde schrijf-
// actie. Elk oversla-pad deed `continue` vóór die regel. Dat leek behoudend
// en was het tegenovergestelde:
//
//   - Werd op een ochtend álles overgeslagen, dan bewoog het watermerk niet.
//     Dat is hier de regel en niet de uitzondering: van de twaalf studenten
//     met een afgeronde sessie hadden er elf geen onboardingrij.
//   - Lag een overgeslagen sessie vóór een geschreven sessie, dan sprong het
//     watermerk over de overgeslagen heen. Kreeg die student later alsnog een
//     onboardingrij, dan lag zijn vroegste afgeronde sessie inmiddels áchter
//     het watermerk — en sloot die onboarding nooit meer.
//
// Daarom draaien deze tests de handler echt, met een gestubde databank en een
// gestubde LMS-lezer. Een test op de broncode had 'if (sdMs > highestMs)' zien
// staan en tevreden geweest — precies wat er misging.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const WM   = '2026-09-07T11:30:26.000Z';
const CRON = 'geheim-voor-de-test';

/**
 * Nep-supabase. `onboardings` antwoordt per bubble_user_id, zodat één stub
 * meerdere studenten in één ronde aankan. Schrijfacties naar app_settings
 * worden opgevangen zodat de test kan zien waar het watermerk op uitkomt.
 */
function nepAdmin({ onboardingPerBubble = {}, fouten = new Set() } = {}) {
  const geschreven = { watermerk: null, afgesloten: [] };
  let laatsteBubble = null;

  const ketting = (tabel) => {
    const k = {
      select: () => k,
      order: () => k,
      limit: () => k,
      is:    () => k,
      insert: (rij) => { if (tabel === 'app_settings') geschreven.watermerk = rij?.value?.iso ?? null; return k; },
      update: (rij) => {
        if (tabel === 'app_settings') geschreven.watermerk = rij?.value?.iso ?? null;
        if (tabel === 'onboardings')  geschreven.afgesloten.push(rij);
        return k;
      },
      eq: (kolom, waarde) => {
        if (tabel === 'onboardings' && kolom === 'bubble_user_id') laatsteBubble = waarde;
        return k;
      },
      maybeSingle: async () => {
        if (tabel === 'app_settings') return { data: { value: { iso: WM } }, error: null };
        if (tabel === 'onboardings') {
          if (fouten.has(laatsteBubble)) {
            return { data: null, error: { message: 'databank weg' } };
          }
          const ob = onboardingPerBubble[laatsteBubble] ?? null;
          // Een update-keten eindigt ook op maybeSingle; die geeft de rij terug.
          return { data: ob, error: null };
        }
        return { data: null, error: null };
      },
      then: undefined,
    };
    return k;
  };

  return { from: (t) => ketting(t), _geschreven: geschreven };
}

function nepRes() {
  const uit = { code: null, body: null };
  return {
    setHeader: () => {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

/** Eén rij zoals haalAfgerondeEersteSessies 'm nu teruggeeft. */
const rij = (o) => ({
  id: 'oorzaak', start_tijd: '2026-08-01T10:00:00.000Z',
  aanleiding_id: 'aanleiding', aanleiding_op: '2026-09-10T10:00:00.000Z',
  op_eerdere_sessie: true, student_id: 'stu-1', bubble_user_id: 'bub-1',
  email: 'a@b.nl', voornaam: 'A', achternaam: 'B', ...o,
});

async function draai({
  sessies, onboardingPerBubble = {}, fouten = new Set(),
  ontvangers = ['hoofdmentor-1'], rechtFout = null, meldingFout = null,
} = {}) {
  const admin = nepAdmin({ onboardingPerBubble, fouten });
  const meldingen = [];
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: admin } });
  mock.module(url('api/_lib/notify.js'), {
    namedExports: {
      resolveOntvangersVoorRecht: async () => {
        if (rechtFout) throw new Error(rechtFout);
        return { ok: ontvangers.length > 0, userIds: ontvangers, viaRol: 0, viaGebruiker: 0 };
      },
      createNotification: async (opts) => {
        if (meldingFout) throw new Error(meldingFout);
        meldingen.push(opts);
        return { ok: true, count: 1 };
      },
    },
  });
  mock.module(url('api/_lib/dfo-lms-sessies.js'), {
    namedExports: {
      BRON_GELEZEN: 'gelezen',
      haalAfgerondeEersteSessies: async () => ({
        bron_status: 'gelezen', sessies,
        totaal_afgerond: sessies.length, gesloten_op_eerdere_sessie: 0,
        zonder_bubble_koppeling: 0, titels_gelezen: true, titels_fout: null, fout: null,
      }),
    },
  });
  const mod = await import(url('api/cron/onboarding-eerste-sessie-afronden.js') + '?t=' + Math.random());
  const res = nepRes();
  await mod.default(
    { method: 'GET', headers: { authorization: 'Bearer ' + CRON }, query: {} },
    res,
  );
  return { uit: res._uit, geschreven: admin._geschreven, meldingen };
}

/** Een open onboarding voor een gegeven bubble-id. */
const openOnboarding = (naam = 'Klant') => ({
  id: 'ob-1', status: 'bezig', archived_at: null,
  customer_name: naam, auto_afgerond_sessie_id: null,
});

const oudeSecret = process.env.CRON_SECRET;
process.env.CRON_SECRET = CRON;
process.on('exit', () => { process.env.CRON_SECRET = oudeSecret; });

// ═══════════════════════════════════════════════════════════════════════════

test('ALLES overgeslagen: het watermerk gaat tóch vooruit', async (t) => {
  t.after(() => mock.reset());
  // Geen enkele student heeft een onboardingrij — de normale situatie.
  const { uit, geschreven } = await draai({
    sessies: [
      rij({ bubble_user_id: 'bub-1', aanleiding_op: '2026-09-08T10:00:00.000Z' }),
      rij({ bubble_user_id: 'bub-2', aanleiding_op: '2026-09-09T10:00:00.000Z' }),
    ],
    onboardingPerBubble: {},
  });
  assert.equal(uit.code, 200);
  assert.equal(uit.body.geen_onboarding, 2);
  assert.equal(uit.body.afgesloten, 0);
  assert.equal(geschreven.watermerk, '2026-09-09T10:00:00.000Z',
    'het watermerk bleef eerder staan omdat er niets geschreven werd');
  assert.equal(uit.body.watermark_after, '2026-09-09T10:00:00.000Z');
});

test('een overgeslagen rij VÓÓR een geschreven rij raakt niet achterop', async (t) => {
  t.after(() => mock.reset());
  // bub-1 wordt overgeslagen (geen onboarding) en ligt vóór bub-2, die wél
  // sluit. Beide zijn beoordeeld, dus het watermerk mag naar de hoogste.
  const { uit, geschreven } = await draai({
    sessies: [
      rij({ bubble_user_id: 'bub-1', aanleiding_op: '2026-09-08T09:00:00.000Z' }),
      rij({ bubble_user_id: 'bub-2', aanleiding_op: '2026-09-08T10:00:00.000Z' }),
    ],
    onboardingPerBubble: {
      'bub-2': { id: 'ob-2', status: 'bezig', archived_at: null,
                 customer_name: 'Klant', auto_afgerond_sessie_id: null },
    },
  });
  assert.equal(uit.body.geen_onboarding, 1);
  assert.equal(uit.body.afgesloten, 1);
  assert.equal(geschreven.watermerk, '2026-09-08T10:00:00.000Z');
});

test('de vastgelegde oorzaak is de sessie uit de lezer, niet de aanleiding', async (t) => {
  t.after(() => mock.reset());
  const { geschreven } = await draai({
    sessies: [rij({
      id: 'oorzaak-A', start_tijd: '2026-08-01T10:00:00.000Z',
      aanleiding_op: '2026-09-10T10:00:00.000Z',
    })],
    onboardingPerBubble: {
      'bub-1': { id: 'ob-1', status: 'bezig', archived_at: null,
                 customer_name: 'Klant', auto_afgerond_sessie_id: null },
    },
  });
  const upd = geschreven.afgesloten[0];
  assert.equal(upd.auto_afgerond_sessie_id, 'oorzaak-A');
  assert.equal(upd.auto_afgerond_sessie_op, '2026-08-01T10:00:00.000Z',
    'in het dossier hoort de sessie die het onboarden afmaakte');
  assert.equal(upd.status, 'afgerond');
  // En het watermerk staat op de aanleiding, niet op die oude datum.
  assert.equal(geschreven.watermerk, '2026-09-10T10:00:00.000Z');
});

test('een FOUT houdt het watermerk tegen, ook voor de rijen erna', async (t) => {
  t.after(() => mock.reset());
  // bub-2 faalt. bub-3 ligt erachter en zou anders overheen springen — dan was
  // bub-2 morgen niet meer op te halen.
  const { uit, geschreven } = await draai({
    sessies: [
      rij({ bubble_user_id: 'bub-1', aanleiding_op: '2026-09-08T08:00:00.000Z' }),
      rij({ bubble_user_id: 'bub-2', aanleiding_op: '2026-09-08T09:00:00.000Z' }),
      rij({ bubble_user_id: 'bub-3', aanleiding_op: '2026-09-08T10:00:00.000Z' }),
    ],
    fouten: new Set(['bub-2']),
  });
  assert.equal(uit.body.errors.length, 1);
  assert.equal(geschreven.watermerk, '2026-09-08T08:00:00.000Z',
    'het watermerk blijft staan vóór de mislukte rij');
});

test('een droogloop schrijft geen watermerk en sluit niets af', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin({
    onboardingPerBubble: {
      'bub-1': { id: 'ob-1', status: 'bezig', archived_at: null,
                 customer_name: 'Klant', auto_afgerond_sessie_id: null },
    },
  });
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: admin } });
  mock.module(url('api/_lib/dfo-lms-sessies.js'), {
    namedExports: {
      BRON_GELEZEN: 'gelezen',
      haalAfgerondeEersteSessies: async () => ({
        bron_status: 'gelezen', sessies: [rij({})],
        totaal_afgerond: 1, gesloten_op_eerdere_sessie: 1,
        zonder_bubble_koppeling: 0, fout: null,
      }),
    },
  });
  const mod = await import(url('api/cron/onboarding-eerste-sessie-afronden.js') + '?t=' + Math.random());
  const res = nepRes();
  await mod.default(
    { method: 'GET', headers: { authorization: 'Bearer ' + CRON }, query: { dry: '1' } },
    res,
  );
  assert.equal(res._uit.body.dry, true);
  assert.equal(res._uit.body.afgesloten, 1, 'de droogloop telt wat hij zou doen');
  assert.equal(admin._geschreven.watermerk, null, 'en schrijft geen watermerk');
  assert.equal(admin._geschreven.afgesloten.length, 0, 'en sluit niets af');
});


// ═══════════════════════════════════════════════════════════════════════════
// DE MELDING BIJ EEN AUTOMATISCHE AFSLUITING
//
// Maxim heeft hier ja op gezegd nadat we 'm eerst apart hebben voorgelegd.
// Doel: niemand hoeft een dossier te openen om te zien dat er 'Testsessie'
// staat. Drie randvoorwaarden, alle drie hieronder vastgelegd.
// ═══════════════════════════════════════════════════════════════════════════

test('elke afsluiting levert een melding op, MET de titel erin', async (t) => {
  t.after(() => mock.reset());
  const { uit, meldingen } = await draai({
    sessies: [rij({ titel: 'Testsessie (verificatie)' })],
    onboardingPerBubble: { 'bub-1': openOnboarding('Jansen') },
    ontvangers: ['hm-1', 'hm-2'],
  });
  assert.equal(uit.body.afgesloten, 1);
  assert.equal(meldingen.length, 2, 'beide hoofdmentoren');
  assert.equal(uit.body.meldingen_verstuurd, 2);
  assert.match(meldingen[0].body, /Testsessie \(verificatie\)/,
    'zonder de titel moet je alsnog het dossier open — dan is de melding zinloos');
  assert.match(meldingen[0].body, /Jansen/);
  assert.equal(meldingen[0].type, 'onboarding.auto_afgerond');
  assert.equal(meldingen[0].entityId, 'ob-1');
});

test('RANDVOORWAARDE 1: een mislukte melding laat de afsluiting staan', async (t) => {
  t.after(() => mock.reset());
  // Het omgekeerde zou erger zijn: een onboarding die openblijft omdat een
  // bericht niet aankwam. En de rij mag NIET in de foutafhandeling belanden,
  // want dan blokkeert 'ie het watermerk en komt hij morgen terug als
  // al_automatisch — en dan volgt er nooit meer een melding.
  const { uit, geschreven } = await draai({
    sessies: [rij({})],
    onboardingPerBubble: { 'bub-1': openOnboarding() },
    meldingFout: 'meldingsdienst plat',
  });
  assert.equal(uit.code, 200);
  assert.equal(uit.body.afgesloten, 1, 'de onboarding is en blijft afgesloten');
  assert.equal(geschreven.afgesloten.length, 1);
  assert.equal(uit.body.meldingen_mislukt, 1, 'en de reden is zichtbaar');
  assert.equal(uit.body.errors.length, 0, 'geen fout op de rij: die zou het watermerk blokkeren');
  assert.equal(geschreven.watermerk, '2026-09-10T10:00:00.000Z', 'watermerk loopt gewoon door');
});

test('RANDVOORWAARDE 2: niemand met het recht = GEEN terugval op de mentor', async (t) => {
  t.after(() => mock.reset());
  const { uit, meldingen } = await draai({
    sessies: [rij({})],
    onboardingPerBubble: { 'bub-1': openOnboarding() },
    ontvangers: [],
  });
  assert.equal(uit.body.afgesloten, 1, 'afsluiten gaat door');
  assert.equal(meldingen.length, 0, 'er gaat NIETS uit — ook niet naar de sessie-mentor');
  assert.equal(uit.body.meldingen_zonder_ontvanger, 1, 'geteld');
  assert.equal(uit.body.hoofdmentor_ontvangers, 0);
});

test('een kapotte rechten-opzoeking blokkeert het afsluiten niet', async (t) => {
  t.after(() => mock.reset());
  // Een onboarding niet sluiten omdat we niet weten wie we moeten bellen is
  // de verkeerde kant op falen.
  const { uit } = await draai({
    sessies: [rij({})],
    onboardingPerBubble: { 'bub-1': openOnboarding() },
    rechtFout: 'rechten-tabel weg',
  });
  assert.equal(uit.code, 200);
  assert.equal(uit.body.afgesloten, 1);
  assert.equal(uit.body.meldingen_zonder_ontvanger, 1);
});

test('RANDVOORWAARDE 3: hoogstens EEN melding per afsluiting', async (t) => {
  t.after(() => mock.reset());
  // De melding hangt aan de GESLAAGDE overgang, niet aan de staat van de rij.
  // Een rij die al automatisch is afgesloten haalt die tak niet eens.
  const { uit, meldingen } = await draai({
    sessies: [rij({})],
    onboardingPerBubble: {
      'bub-1': { id: 'ob-1', status: 'bezig', archived_at: null,
                 customer_name: 'Klant', auto_afgerond_sessie_id: 'oorzaak' },
    },
  });
  assert.equal(uit.body.al_automatisch, 1);
  assert.equal(uit.body.afgesloten, 0);
  assert.equal(meldingen.length, 0, 'de cron opnieuw laten langskomen mag niet opnieuw rinkelen');
});

test('een overgeslagen of niet-aan-te-raken onboarding meldt niets', async (t) => {
  t.after(() => mock.reset());
  const { uit, meldingen } = await draai({
    sessies: [rij({ bubble_user_id: 'bub-1' }), rij({ bubble_user_id: 'bub-2' })],
    onboardingPerBubble: {},
  });
  assert.equal(uit.body.geen_onboarding, 2);
  assert.equal(meldingen.length, 0);
});

test('een droogloop verstuurt geen meldingen', async (t) => {
  t.after(() => mock.reset());
  const admin = nepAdmin({ onboardingPerBubble: { 'bub-1': openOnboarding() } });
  const meldingen = [];
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: admin } });
  mock.module(url('api/_lib/notify.js'), {
    namedExports: {
      resolveOntvangersVoorRecht: async () => ({ ok: true, userIds: ['hm-1'], viaRol: 0, viaGebruiker: 0 }),
      createNotification: async (o) => { meldingen.push(o); return { ok: true, count: 1 }; },
    },
  });
  mock.module(url('api/_lib/dfo-lms-sessies.js'), {
    namedExports: {
      BRON_GELEZEN: 'gelezen',
      haalAfgerondeEersteSessies: async () => ({
        bron_status: 'gelezen', sessies: [rij({})], totaal_afgerond: 1,
        gesloten_op_eerdere_sessie: 0, zonder_bubble_koppeling: 0,
        titels_gelezen: true, titels_fout: null, fout: null,
      }),
    },
  });
  const mod = await import(url('api/cron/onboarding-eerste-sessie-afronden.js') + '?t=' + Math.random());
  const res = nepRes();
  await mod.default(
    { method: 'GET', headers: { authorization: 'Bearer ' + CRON }, query: { dry: '1' } }, res);
  assert.equal(res._uit.body.afgesloten, 1, 'de droogloop telt wat hij zou doen');
  assert.equal(meldingen.length, 0, 'maar rinkelt bij niemand');
});

test('ontbreekt de titel, dan zegt de melding DAT — niet niets', async (t) => {
  t.after(() => mock.reset());
  // Een melding zonder titel leest anders als 'die sessie heette niets',
  // terwijl het net zo goed een onbereikbaar LMS kan zijn.
  const { meldingen } = await draai({
    sessies: [rij({ titel: null })],
    onboardingPerBubble: { 'bub-1': openOnboarding() },
  });
  assert.match(meldingen[0].body, /titel niet opgehaald/);
});
