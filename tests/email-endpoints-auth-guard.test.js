// tests/email-endpoints-auth-guard.test.js
//
// /api/email-body en /api/mark-read hadden GEEN auth-check: een POST met
// mailbox+uid gaf de volledige mailbody terug, respectievelijk zette de IMAP
// \Seen-vlag. Deze test borgt drie dingen:
//   1. requireCrmStaff() weigert alles zonder geldig Bearer-token, en doet dat
//      zonder side-effects (geen DB/IMAP-call op de weiger-tak).
//   2. De rollen-whitelist laat viewer/student en onbekende rollen NIET door.
//   3. Beide endpoints roepen de poort daadwerkelijk aan, vóór ze IMAP of de
//      database aanraken.
//
// Punt 3 checken we op broncode-niveau in plaats van door de handler te
// importeren: die trekt `imapflow` mee, en de suite draait hier bewust zonder
// volledige node_modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  requireCrmStaff,
  isCrmStaffRole,
  authRedirectUrlForRole,
  CRM_STAFF_ROLES,
} from '../api/_lib/crm-roles.js';

// ── 1) requireCrmStaff: weiger-tak ──────────────────────────────────────────

test('requireCrmStaff geeft null zonder Authorization-header', async () => {
  assert.equal(await requireCrmStaff({ headers: {} }), null);
  assert.equal(await requireCrmStaff({}), null);
  assert.equal(await requireCrmStaff(null), null);
});

test('requireCrmStaff weigert niet-Bearer schemes', async () => {
  assert.equal(await requireCrmStaff({ headers: { authorization: 'Basic aGFjazpoYWNr' } }), null);
  assert.equal(await requireCrmStaff({ headers: { authorization: 'token abc' } }), null);
});

test('requireCrmStaff weigert een leeg Bearer-token', async () => {
  assert.equal(await requireCrmStaff({ headers: { authorization: 'Bearer' } }), null);
  assert.equal(await requireCrmStaff({ headers: { authorization: 'Bearer    ' } }), null);
});

// ── 2) Rollen-whitelist ─────────────────────────────────────────────────────

// ACHT, niet zeven. Deze toets eiste er zeven en stond rood vanaf z'n geboorte
// (#1592): 'appointmentsetter' zat op dat moment al bijna een maand in de lijst
// (BP1, 31 aug, voor Romy) en hoort daar — de rol staat ook in
// `public.is_crm_staff()` (2026-08-31-bp1-appointmentsetter-foundation.sql) en
// in `modules/shared/crm-guard.js`. Het getal in de naam was dus mis, niet de
// code.
//
// En met dat getal vervalt de naam van de toets als reden om 'm bij te werken.
// Waar het echt om gaat, staat bovenaan crm-roles.js: deze lijst moet 1-op-1
// gelijk blijven aan die in crm-guard.js. Dat eisen we hieronder, zodat een
// rol die maar aan één kant wordt bijgezet een rode toets geeft in plaats van
// een scherm dat een medewerker naar het LMS wegstuurt.
const CRM_STAFF_ROLES_VERWACHT = [
  'super_admin', 'admin', 'manager', 'sales', 'mentor', 'administratie', 'marketing',
  'appointmentsetter',
];

test('whitelist bevat exact de 8 medewerkersrollen', () => {
  assert.deepEqual([...CRM_STAFF_ROLES].sort(), [...CRM_STAFF_ROLES_VERWACHT].sort());
});

test('crm-guard.js (browser) heeft exact dezelfde achttal', () => {
  const src = readFileSync(new URL('../modules/shared/crm-guard.js', import.meta.url), 'utf8');
  const blok = src.slice(src.indexOf('var CRM_STAFF_ROLES = ['));
  const rollen = [...blok.slice(0, blok.indexOf('];')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(rollen.sort(), [...CRM_STAFF_ROLES_VERWACHT].sort(),
    'de browserlijst loopt uit de pas met api/_lib/crm-roles.js');
});

test('staff-rollen geven true', () => {
  for (const r of CRM_STAFF_ROLES) {
    assert.equal(isCrmStaffRole(r), true, `${r} hoort CRM-staff te zijn`);
  }
});

test('viewer, student en onbekende rollen geven false', () => {
  for (const r of ['viewer', 'student', 'onbekend', 'Sales', '', null, undefined]) {
    assert.equal(isCrmStaffRole(r), false, `${r} hoort GEEN CRM-staff te zijn`);
  }
});

test('invite-redirect: staff naar CRM, niet-staff naar het LMS', () => {
  assert.match(authRedirectUrlForRole('sales'),   /reset-password\.html$/);
  assert.match(authRedirectUrlForRole('viewer'),  /dfo-lms-prototype\.vercel\.app$/);
  assert.match(authRedirectUrlForRole('student'), /dfo-lms-prototype\.vercel\.app$/);
  assert.match(authRedirectUrlForRole(null),      /dfo-lms-prototype\.vercel\.app$/);
});

// ── 3) Wiring: de poort staat in beide endpoints, en staat vooraan ──────────

for (const bestand of ['api/email-body.js', 'api/mark-read.js']) {
  test(`${bestand} roept requireCrmStaff aan en weigert met 403`, () => {
    const src = readFileSync(new URL(`../${bestand}`, import.meta.url), 'utf8');
    assert.ok(src.includes("import { requireCrmStaff }"), 'import ontbreekt');
    assert.ok(src.includes('await requireCrmStaff(req)'), 'aanroep ontbreekt');
    assert.match(src, /status\(403\)/, '403-tak ontbreekt');
  });

  test(`${bestand} doet de rolcheck VOOR IMAP/DB`, () => {
    const src = readFileSync(new URL(`../${bestand}`, import.meta.url), 'utf8');

    // Alleen de handler zelf beoordelen: helper-functies erboven mogen prima
    // supabaseAdmin/ImapFlow noemen, die draaien pas als de handler ze roept.
    const start = src.indexOf('export default async function handler');
    assert.ok(start > -1, 'handler niet gevonden');
    const handler = src.slice(start);

    const poort = handler.indexOf('await requireCrmStaff(req)');
    assert.ok(poort > -1, 'poort niet gevonden in de handler');

    // Eerste plek in de handler waar er echt werk gebeurt.
    for (const patroon of ['new ImapFlow', '.connect(', 'supabaseAdmin.from(', 'loadBodyFromDb(']) {
      const werk = handler.indexOf(patroon);
      if (werk > -1) {
        assert.ok(poort < werk, `rolcheck staat NA "${patroon}" — moet ervoor`);
      }
    }
  });
}
