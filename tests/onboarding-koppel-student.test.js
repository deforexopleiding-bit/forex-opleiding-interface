// Een onboarding met de hand aan een LMS-student koppelen (7 okt 2026):
// ER Schilderwerken ↔ Emile Rabaut. Alleen mocks; geen echte klant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const OB = '00000000-0000-4000-8000-000000000001';
const ST = '00000000-0000-4000-8000-0000000000aa';
const ANDER = '00000000-0000-4000-8000-0000000000bb';

function nepDb({ ob = { id: OB, dfo_lms_student_id: null, status: 'bezig' } } = {}) {
  const inserts = [];
  const db = {
    inserts,
    from(t) {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: t === 'onboardings' ? ob : null, error: null }),
        insert: async (rij) => { inserts.push({ t, rij }); return { error: null }; },
      };
    },
  };
  return db;
}
function nepLms(student = { id: ST, voornaam: 'Emile', achternaam: 'Rabaut', email: 'e@x.be' }) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        in() { return this; },
        maybeSingle: async () => ({ data: student, error: null }),
      };
    },
  };
}

test('KOPPELEN: zet de koppeling, met wie in de tijdlijn', async (t) => {
  t.mock.module('../api/_lib/onboarding-spiegel.js', { namedExports: { spiegelNaActie: async () => ({ ok: true }) } });
  const { koppelOnboardingAanStudent } = await import('../api/_lib/onboarding-koppel-student.js?a');
  const db = nepDb();
  let gekoppeld = null;
  const r = await koppelOnboardingAanStudent({
    onboardingId: OB, studentId: ST, door: 'Maxim via het LMS', db, lms: nepLms(),
    koppel: async (o, s) => { gekoppeld = [o, s]; return { ok: true }; },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(gekoppeld, [OB, ST]);
  assert.equal(r.body.student_naam, 'Emile Rabaut');
  assert.match(db.inserts[0].rij.note, /Gekoppeld aan LMS-student Emile Rabaut door Maxim via het LMS/);
});

test('AL AAN EEN ANDERE STUDENT: niets gewijzigd', async () => {
  const { koppelOnboardingAanStudent } = await import('../api/_lib/onboarding-koppel-student.js?b');
  const r = await koppelOnboardingAanStudent({
    onboardingId: OB, studentId: ST, db: nepDb({ ob: { id: OB, dfo_lms_student_id: ANDER } }), lms: nepLms(),
    koppel: async () => { throw new Error('mag niet'); },
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'al_gekoppeld');
});

test('ONGELDIGE INVOER en een onbekende student', async () => {
  const { koppelOnboardingAanStudent } = await import('../api/_lib/onboarding-koppel-student.js?c');
  assert.equal((await koppelOnboardingAanStudent({ onboardingId: 'x', studentId: ST, db: nepDb(), lms: nepLms() })).status, 400);
  const r = await koppelOnboardingAanStudent({ onboardingId: OB, studentId: ST, db: nepDb(), lms: nepLms(null) });
  assert.equal(r.status, 404);
});

test('DE AUTOMATISCHE WEG via de contactpersoon stuurt GEEN uitnodiging', () => {
  const create = readFileSync(new URL('../api/onboarding-create.js', import.meta.url), 'utf8');
  assert.match(create, /dfoLms\.reason !== 'bestond-al-via-contactpersoon'/);
  const lib = readFileSync(new URL('../api/_lib/dfo-lms-student.js', import.meta.url), 'utf8');
  assert.match(lib, /lijst\.length === 1 && treffers\.size === 1/, 'alleen bij precies één treffer');
});
