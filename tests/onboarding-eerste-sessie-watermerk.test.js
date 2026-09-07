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

async function draai({ sessies, onboardingPerBubble = {}, fouten = new Set() }) {
  const admin = nepAdmin({ onboardingPerBubble, fouten });
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: admin } });
  mock.module(url('api/_lib/dfo-lms-sessies.js'), {
    namedExports: {
      BRON_GELEZEN: 'gelezen',
      haalAfgerondeEersteSessies: async () => ({
        bron_status: 'gelezen', sessies,
        totaal_afgerond: sessies.length, gesloten_op_eerdere_sessie: 0,
        zonder_bubble_koppeling: 0, fout: null,
      }),
    },
  });
  const mod = await import(url('api/cron/onboarding-eerste-sessie-afronden.js') + '?t=' + Math.random());
  const res = nepRes();
  await mod.default(
    { method: 'GET', headers: { authorization: 'Bearer ' + CRON }, query: {} },
    res,
  );
  return { uit: res._uit, geschreven: admin._geschreven };
}

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
