// tests/notify-hoofdmentor-adressering.test.js
//
// Het signaal voor een gemiste EERSTE call gaat naar de HOOFDMENTOR, niet
// naar de mentor van die sessie. Dat is een uitdrukkelijke eis: er moet
// iemand kort op zitten om te voorkomen dat het een wanbetaler wordt, en dat
// is een andere verantwoordelijkheid dan het opvolgen van een gewone no-show.
//
// De rol 'hoofdmentor' bestaat nog niet, en `profiles.role` is enkelvoudig —
// iemand die rol geven zou zijn huidige rol wegnemen. Daarom loopt de
// adressering via een RECHT, dat aan een rol óf aan een persoon gegeven kan
// worden. Deze tests bewaken dat die keuze niet stilletjes verschuift naar
// twee namen in de code of terug naar de sessie-mentor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveOntvangersVoorRecht } from '../api/_lib/notify.js';

const KEY = 'signals.hoofdmentor.receive';

/** Antwoordt per tabel; een Error laat die bevraging mislukken. */
function nepDb(perTabel = {}) {
  const antwoord = (bron) => (bron instanceof Error
    ? { data: null, error: { message: bron.message } }
    : { data: bron || [], error: null });
  return {
    from(tabel) {
      const k = {
        select: () => k, eq: () => k, in: () => k,
        then: (res, rej) => Promise.resolve(antwoord(perTabel[tabel])).then(res, rej),
      };
      return k;
    },
  };
}

// ── 1) Het recht via een ROL ────────────────────────────────────────────────

test('een rol met het recht levert alle actieve profielen met die rol op', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: true }],
    profiles: [{ id: 'u1', is_active: true }, { id: 'u2', is_active: true }],
    user_permissions: [],
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.userIds.sort(), ['u1', 'u2']);
  assert.equal(r.viaRol, 2);
});

test('een rol met allowed=false telt NIET mee', async () => {
  const r = await resolveOntvangersVoorRecht(KEY, nepDb({
    role_permissions: [{ role: 'hoofdmentor', allowed: false }],
    profiles: [{ id: 'u1', is_active: true }],
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
    profiles: [{ id: 'maxim', is_active: true }],
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
