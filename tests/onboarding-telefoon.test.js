// tests/onboarding-telefoon.test.js — het telefoonnummer van een onboarding
// uit één afleiding met vaste voorrang (Maxim, 6 oktober 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  kiesTelefoon, telefoonsUitAntwoorden, telefoonsVoorOnboardings,
} from '../api/_lib/onboarding-telefoon.js';

test('VOORRANG: de eerste bron met een eenduidig nummer wint', () => {
  const r = kiesTelefoon([
    { bron: 'klant', ruw: null },
    { bron: 'whatsapp', ruw: '+32470123456' },
    { bron: 'lead', ruw: '+31612345678' },
  ]);
  assert.deepEqual(r, { telefoon: '+32470123456', bron: 'whatsapp', zeker: true });
});

test('NORMALISATIE: 0470… wordt +32, 06… wordt +31 (de gedeelde NL/BE-regel)', () => {
  assert.equal(kiesTelefoon([{ bron: 'klant', ruw: '0470 12 34 56' }]).telefoon, '+32470123456');
  assert.equal(kiesTelefoon([{ bron: 'klant', ruw: '06-12345678' }]).telefoon, '+31612345678');
});

test('NOOIT GOKKEN: een twijfelnummer verliest van een zeker nummer verderop', () => {
  // '+3147979884' is een cijfer te kort: phone-e164 laat het rauw.
  const r = kiesTelefoon([
    { bron: 'klant', ruw: '+3147979884' },
    { bron: 'lead', ruw: '+31612345678' },
  ]);
  assert.equal(r.bron, 'lead');
  // Een vast nummer krijgt het land van de klantkaart.
  assert.deepEqual(kiesTelefoon([{ bron: 'klant', ruw: '02 123 45 67' }], 'BE'),
    { telefoon: '+3221234567', bron: 'klant', zeker: true });
});

test('ALLEEN TWIJFEL: het ruwe nummer blijft zichtbaar, maar niet als zeker', () => {
  const r = kiesTelefoon([{ bron: 'klant', ruw: '+3147979884' }]);
  assert.equal(r.telefoon, '+3147979884');
  assert.equal(r.zeker, false);
});

test('LEEG is leeg — geen verzonnen nummer', () => {
  assert.deepEqual(kiesTelefoon([{ bron: 'klant', ruw: '' }, { bron: 'lead', ruw: null }]),
    { telefoon: null, bron: null, zeker: false });
});

test('WIZARD: alleen velden met telefoon/gsm/whatsapp in de naam', () => {
  assert.deepEqual(telefoonsUitAntwoorden({ gsm_nummer: '0470123456', naam: 'Jan', telefoon: '+32470000000', ok: true }),
    ['0470123456', '+32470000000']);
  assert.deepEqual(telefoonsUitAntwoorden(null), []);
});

// Een nep-databank die per tabel rijen teruggeeft en elke filter negeert.
function nepDb(tabellen, kapot = new Set()) {
  return {
    from(t) {
      const q = {
        select() { return q; }, in() { return q; }, order() { return q; },
        then(ok) {
          if (kapot.has(t)) return Promise.resolve({ data: null, error: { message: 'stuk' } }).then(ok);
          return Promise.resolve({ data: tabellen[t] || [], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('BATCH: elke bron één keer, en de voorrang per onboarding', async () => {
  const db = nepDb({
    customers: [
      { id: 'k1', phone: null, email: 'Jonas@Voorbeeld.be', address_country: 'BE' },
      { id: 'k2', phone: '+31612345678', email: 'q@x.nl', address_country: 'NL' },
      { id: 'k3', phone: '', email: 'leeg@x.be', address_country: null },
    ],
    whatsapp_conversations: [],
    leads: [{ email: 'jonas@voorbeeld.be', telefoon: '0470 11 22 33', telefoon_e164: null }],
    follow_up_appointments: [],
  });
  const m = await telefoonsVoorOnboardings(db, [
    { id: 'o1', customer_id: 'k1' },
    { id: 'o2', customer_id: 'k2' },
    { id: 'o3', customer_id: 'k3', answers: { telefoon: '0499 12 34 56' } },
    { id: 'o4', customer_id: null },
  ]);
  assert.deepEqual(m.get('o1'), { telefoon: '+32470112233', bron: 'lead', zeker: true });
  assert.deepEqual(m.get('o2'), { telefoon: '+31612345678', bron: 'klant', zeker: true });
  assert.equal(m.get('o3').bron, 'wizard');
  assert.equal(m.get('o3').telefoon, '+32499123456');
  assert.equal(m.get('o4').telefoon, null);
});

test('FAALZACHT: een bron die faalt valt weg, de volgende neemt over', async () => {
  const db = nepDb({
    customers: [{ id: 'k1', phone: null, email: 'a@b.be', address_country: 'BE' }],
    follow_up_appointments: [{ lead_email: 'a@b.be', lead_phone: '+32470999888' }],
  }, new Set(['whatsapp_conversations', 'leads']));
  const m = await telefoonsVoorOnboardings(db, [{ id: 'o1', customer_id: 'k1' }]);
  assert.deepEqual(m.get('o1'), { telefoon: '+32470999888', bron: 'afspraak', zeker: true });
});

test('NIETS GESCHREVEN: de afleiding leest alleen', async () => {
  const { readFileSync } = await import('node:fs');
  const bron = readFileSync(new URL('../api/_lib/onboarding-telefoon.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bron, /\.(insert|update|upsert|delete)\(/);
});

test('SPIEGEL VOOR DE MIGRATIE: een ontbrekende kolom telefoon wordt herkend, een andere fout niet', async () => {
  const { isTelefoonKolomOntbreekt } = await import('../api/_lib/onboarding-spiegel.js');
  assert.equal(isTelefoonKolomOntbreekt({ code: 'PGRST204', message: "Could not find the 'telefoon' column of 'hlms_crm_onboarding'" }), true);
  assert.equal(isTelefoonKolomOntbreekt({ code: '42703', message: 'column "telefoon" does not exist' }), true);
  assert.equal(isTelefoonKolomOntbreekt({ code: '42501', message: 'permission denied' }), false);
});

test('STUDENT AANVULLEN: alleen als hlms_student.telefoon leeg is — de voorwaarde zit in de update', async () => {
  const { readFileSync } = await import('node:fs');
  const bron = readFileSync(new URL('../api/_lib/onboarding-spiegel.js', import.meta.url), 'utf8');
  assert.match(bron, /from\('hlms_student'\)\s*\.update\(\{ telefoon \}\)\s*\.eq\('id', studentId\)\s*\.or\('telefoon\.is\.null,telefoon\.eq\.'\)/);
});
