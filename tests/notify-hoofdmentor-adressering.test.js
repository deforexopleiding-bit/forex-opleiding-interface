// tests/notify-hoofdmentor-adressering.test.js
//
// Het signaal voor een gemiste EERSTE call gaat naar de HOOFDMENTOR, niet
// naar de mentor van die sessie. Dat is een uitdrukkelijke eis: er moet
// iemand kort op zitten om te voorkomen dat het een wanbetaler wordt, en dat
// is een andere verantwoordelijkheid dan het opvolgen van een gewone no-show.
//
// De rol 'hoofdmentor' bestaat nog niet en staat ook niet in
// VALID_SUPABASE_ROLES, dus invoeren is een migratie plus werk in het
// gebruikersbeheer. Daarom loopt de adressering via een RECHT, dat aan een rol
// óf aan een persoon gegeven kan worden. Deze tests bewaken dat die keuze niet
// stilletjes verschuift naar twee namen in de code of terug naar de
// sessie-mentor — en dat de rol-tak `user_roles` leest en niet de afgeleide
// hoofdrol in `profiles.role`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveOntvangersVoorRecht } from '../api/_lib/notify.js';

const KEY = 'signals.hoofdmentor.receive';

/**
 * Antwoordt per tabel; een Error laat die bevraging mislukken.
 * `bevraagd` houdt bij welke tabellen én welke kolom-filters langskwamen,
 * zodat een test kan vastleggen WAAR de rol vandaan gehaald wordt.
 */
function nepDb(perTabel = {}) {
  const antwoord = (bron) => (bron instanceof Error
    ? { data: null, error: { message: bron.message } }
    : { data: bron || [], error: null });
  const bevraagd = [];
  const db = {
    bevraagd,
    from(tabel) {
      const filters = [];
      bevraagd.push({ tabel, filters });
      const k = {
        select: () => k,
        eq: (kolom) => { filters.push(kolom); return k; },
        in: (kolom) => { filters.push(kolom); return k; },
        then: (res, rej) => Promise.resolve(antwoord(perTabel[tabel])).then(res, rej),
      };
      return k;
    },
  };
  return db;
}

// ── 1) Het recht via een ROL ────────────────────────────────────────────────

test('een rol met het recht levert alle actieve profielen met die rol op', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: true }],
    user_roles: [{ user_id: 'u1' }, { user_id: 'u2' }],
    profiles: [{ id: 'u1' }, { id: 'u2' }],
    user_permissions: [],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.userIds.sort(), ['u1', 'u2']);
  assert.equal(r.viaRol, 2);
});

test('de rol wordt uit user_roles gehaald, niet uit de afgeleide profiles.role', async () => {
  // Rollen zijn meervoudig: user_roles draagt ze allemaal, profiles.role is
  // daar de afgeleide HOOFDrol van. Wie 'hoofdmentor' als tweede rol heeft
  // staat dus NIET in profiles.role. Zou deze functie daarop filteren, dan
  // kreeg die persoon geen bericht — stil, en pas merkbaar als er een eerste
  // call gemist is.
  const db = nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: true }],
    user_roles: [{ user_id: 'tweede-rol' }],
    profiles: [{ id: 'tweede-rol' }],
    user_permissions: [],
  });
  const r = await resolveOntvangersVoorRecht(KEY, db);
  assert.deepEqual(r.userIds, ['tweede-rol']);

  const rolTak = db.bevraagd.filter((b) => b.tabel === 'user_roles');
  assert.equal(rolTak.length, 1, 'user_roles is niet bevraagd');
  const profielTak = db.bevraagd.filter((b) => b.tabel === 'profiles');
  for (const t of profielTak) {
    assert.ok(!t.filters.includes('role'),
      'er wordt op profiles.role gefilterd — dat mist ieders tweede rol');
  }
});

test('een niet-actief profiel krijgt geen bericht', async () => {
  // De profiles-tak filtert op is_active; de neppe databank levert alleen
  // wat die filter overlaat, dus een lege profiles-uitkomst staat hier voor
  // "iedereen met die rol is inactief".
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: true }],
    user_roles: [{ user_id: 'weg' }],
    profiles: [],
    user_permissions: [],
  }));
  assert.deepEqual(r.userIds, []);
  assert.equal(r.viaRol, 0);
});

test('een rol met allowed=false telt NIET mee', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: false }],
    user_roles: [{ user_id: 'u1' }],
    profiles: [{ id: 'u1' }],
    user_permissions: [],
  }));
  assert.deepEqual(r.userIds, []);
});

// ── 2) Het recht per PERSOON ────────────────────────────────────────────────

test('een persoonlijk recht levert die persoon op', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [],
    user_permissions: [{ user_id: 'maxim', allowed: true }, { user_id: 'chesney', allowed: true }],
    profiles: [{ id: 'maxim' }, { id: 'chesney' }],
  }));
  assert.deepEqual(r.userIds.sort(), ['chesney', 'maxim']);
  assert.equal(r.viaGebruiker, 2);
});

test('rol én persoon samen leveren ieder één keer op', async () => {
  // Zou de hoofdmentor-rol later bestaan terwijl het persoonlijke recht
  // blijft staan, dan mag niemand twee keer bericht krijgen.
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: true }],
    user_roles: [{ user_id: 'maxim' }],
    profiles: [{ id: 'maxim' }],
    user_permissions: [{ user_id: 'maxim', allowed: true }],
  }));
  assert.deepEqual(r.userIds, ['maxim']);
});

// ── 3) Wat er NIET mag gebeuren ─────────────────────────────────────────────

test('niemand met het recht = LEGE lijst, geen terugval', async () => {
  // Cruciaal: geen enkele terugval op een andere ontvanger. Een terugval op
  // de sessie-mentor zou het bericht precies daar laten belanden waar het
  // uitdrukkelijk niet heen mag.
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [], user_permissions: [], profiles: [],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.userIds, []);
});

test('een mislukte bevraging levert ok:false op, geen stille lege lijst', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: new Error('down'),
  }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.userIds, []);
  assert.match(r.error, /down/);
});

test('een lege sleutel wordt geweigerd', async () => {
  const r = await resolveOntvangersVoorRecht('   ');
  assert.equal(r.ok, false);
  assert.match(r.error, /featureKey/);
});

// ── 4) Contract op de cron ──────────────────────────────────────────────────

const NOSHOW = readFileSync(
  new URL('../api/cron/noshow-detect.js', import.meta.url), 'utf8');

test('CONTRACT: de adressering loopt via een RECHT, niet via namen', () => {
  assert.match(NOSHOW, /signals\.hoofdmentor\.receive/,
    'het recht waarop geadresseerd wordt is niet te vinden');
  assert.match(NOSHOW, /resolveOntvangersVoorRecht/,
    'de ontvangers worden niet via het recht opgezocht');
});

test('CONTRACT: geen e-mailadressen of namen hardgecodeerd als ontvanger', () => {
  // Twee namen in de code zetten verplaatst de beslissing naar een deploy.
  assert.doesNotMatch(NOSHOW, /@deforexopleiding\.nl|@gmail\.com|chesney|maxim/i,
    'er staat een persoon in de code in plaats van een recht');
});

test('CONTRACT: een gemiste eerste call valt NIET terug op de sessie-mentor', () => {
  assert.match(NOSHOW, /isEersteCall\s*\?\s*hoofdmentoren\.userIds/,
    'de ontvanger van een gemiste eerste call is niet de hoofdmentor-lijst');
  assert.match(NOSHOW, /eerste_call_zonder_ontvanger/,
    'zonder ontvanger moet dat geteld en gemeld worden, niet stil opgelost');
});
