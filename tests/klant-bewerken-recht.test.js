// tests/klant-bewerken-recht.test.js
//
// KLANT BEWERKEN MET HET RECHT `customer.edit` (5 november 2026).
//
// PATCH /api/customer was admin-only (verifyAdmin: super_admin/admin/manager).
// Een mentor die een klant mocht AANMAKEN (customer.create, migratie 045) kreeg
// bij opslaan in "Klant bewerken" de melding "Toegang geweigerd. Admin-rol
// vereist." — het recht `customer.edit` stond wel in de registry/Admin-UI maar
// werd nergens gecontroleerd. Nu: verifyAdmin OF customer.edit, net als POST.
//
// Deze test draait de echte handler met een nep-database en legt vast:
//   1. admin mag bewerken (ongewijzigd);
//   2. niet-admin MET customer.edit mag bewerken (o.a. bedrijf → privé),
//      en de audit draagt zijn eigen user-id;
//   3. niet-admin ZONDER customer.edit krijgt 403 en er wordt niets geschreven;
//   4. de status-gate (gearchiveerd → 409) geldt ook voor customer.edit;
//   5. POST controleert nog steeds customer.create (niet customer.edit).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const KLANT_ID = '11111111-2222-3333-4444-555555555555';
const BEDRIJF = {
  id: KLANT_ID, is_company: true, company_name: 'De Bock BV',
  first_name: 'Marc', last_name: 'De Bock', email: 'marc@voorbeeld.be',
  tl_company_id: null, tl_contact_id: null, archived_at: null, anonymized_at: null,
};

const omgeving = {
  isAdmin: false,       // verifyAdmin slaagt
  rechten: new Set(),   // requirePermission-keys die slagen
  klant: { ...BEDRIJF },
  updates: [],
  audits: [],
  permVragen: [],
};

function nepQuery(tabel) {
  const st = { tabel, patch: null, head: false };
  const resultaat = () => {
    if (tabel === 'customers') {
      if (st.patch) {
        omgeving.updates.push(st.patch);
        return { data: { ...omgeving.klant, ...st.patch }, error: null };
      }
      return { data: omgeving.klant, error: null };
    }
    if (tabel === 'profiles') return { data: { id: 'u-mentor', email: 'mentor@voorbeeld.nl', full_name: 'Mentor', role: 'mentor' }, error: null };
    if (st.head) return { data: null, count: 0, error: null };
    return { data: [], error: null };
  };
  const q = {
    select(_c, opts) { if (opts?.head) st.head = true; return q; },
    update(p) { st.patch = p; return q; },
    eq() { return q; }, is() { return q; }, order() { return q; },
    maybeSingle: async () => resultaat(),
    single: async () => resultaat(),
    then(ok, fout) { return Promise.resolve(resultaat()).then(ok, fout); },
  };
  return q;
}

const nepAdmin = {
  from: (t) => nepQuery(t),
  auth: { getUser: async () => ({ data: { user: { id: 'u-mentor', email: 'mentor@voorbeeld.nl' } }, error: null }) },
};

mock.module(url('api/supabase.js'), {
  namedExports: {
    supabaseAdmin: nepAdmin,
    verifyAdmin: async () => (omgeving.isAdmin
      ? { user: { id: 'u-admin' }, profile: { id: 'u-admin', role: 'manager' } }
      : null),
  },
});
mock.module(url('api/_lib/requirePermission.js'), {
  namedExports: {
    requirePermission: async (_req, key) => { omgeving.permVragen.push(key); return omgeving.rechten.has(key); },
  },
});
mock.module(url('api/_lib/audit-customer.js'), {
  namedExports: { logCustomerAudit: async (a) => { omgeving.audits.push(a); } },
});
mock.module(url('api/_lib/teamleader-token.js'), {
  namedExports: { tlFetch: async () => { throw new Error('TL hoort niet te lopen zonder TL-id'); } },
});

const { default: handler } = await import(url('api/customer.js'));

function nepRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

async function patch(body) {
  const res = nepRes();
  await handler({
    method: 'PATCH', query: { id: KLANT_ID }, body,
    headers: { authorization: 'Bearer test-token' },
  }, res);
  return res;
}

function reset({ isAdmin = false, rechten = [], klant = {} } = {}) {
  omgeving.isAdmin = isAdmin;
  omgeving.rechten = new Set(rechten);
  omgeving.klant = { ...BEDRIJF, ...klant };
  omgeving.updates = [];
  omgeving.audits = [];
  omgeving.permVragen = [];
}

test('admin mag een klant bewerken (ongewijzigd)', async () => {
  reset({ isAdmin: true });
  const res = await patch({ phone: '+32470000000' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(omgeving.updates, [{ phone: '+32470000000' }]);
  assert.equal(omgeving.audits[0].userId, 'u-admin');
  assert.deepEqual(omgeving.permVragen, [], 'admin: geen permissie-check nodig');
});

test('niet-admin MET customer.edit mag een bedrijfsklant naar privé omzetten', async () => {
  reset({ rechten: ['customer.edit'] });
  const res = await patch({ is_company: false });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(omgeving.updates, [{ is_company: false }]);
  assert.equal(res.body.customer.is_company, false);
  assert.equal(omgeving.audits.length, 1);
  assert.equal(omgeving.audits[0].action, 'customer.updated');
  assert.equal(omgeving.audits[0].userId, 'u-mentor', 'audit op naam van de medewerker zelf');
  assert.deepEqual(omgeving.permVragen, ['customer.edit']);
});

test('niet-admin ZONDER customer.edit: 403 en niets geschreven', async () => {
  reset({ rechten: ['customer.create'] });
  const res = await patch({ is_company: false });
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /customer\.edit/);
  assert.deepEqual(omgeving.updates, []);
  assert.deepEqual(omgeving.audits, []);
});

test('customer.edit omzeilt de status-gate niet: gearchiveerd → 409', async () => {
  reset({ rechten: ['customer.edit'], klant: { archived_at: '2026-10-01T00:00:00Z' } });
  const res = await patch({ phone: '+32470000000' });
  assert.equal(res.statusCode, 409);
  assert.deepEqual(omgeving.updates, []);
});

test('POST blijft op customer.create, niet op customer.edit', async () => {
  reset({ rechten: ['customer.edit'] });
  const res = nepRes();
  await handler({
    method: 'POST', query: {}, body: { first_name: 'A', last_name: 'B' },
    headers: { authorization: 'Bearer test-token' },
  }, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /customer\.create/);
  assert.deepEqual(omgeving.permVragen, ['customer.create']);
});

// ── Knoppen in de browser (klant-rechten.js) ────────────────────────────────
// Zelfde regel als de server: admin-rol in de shell OF customer.edit; fail-open
// zolang de rechten niet geladen zijn. Archiveren blijft op _isPrivilegedRole.

import { readFileSync } from 'node:fs';

const { magKlantBewerken } = await import(url('modules/klanten-v2/views/klant-rechten.js'));

function metVenster({ rollen = [], rechten = [], geladen = true, rbac = true } = {}) {
  globalThis.window = {
    DFO: { S: { roles: rollen } },
    RBAC: rbac ? {
      canSync: (k) => rechten.includes(k),
      permissiesGeladen: () => geladen,
    } : undefined,
  };
}

test('knop: super_admin/manager altijd, mentor alleen met customer.edit', () => {
  try {
    metVenster({ rollen: ['super_admin'] });            assert.equal(magKlantBewerken(), true);
    metVenster({ rollen: ['manager'] });                assert.equal(magKlantBewerken(), true);
    metVenster({ rollen: ['mentor'] });                 assert.equal(magKlantBewerken(), false);
    metVenster({ rollen: ['sales'] });                  assert.equal(magKlantBewerken(), false);
    metVenster({ rollen: ['mentor'], rechten: ['customer.edit'] }); assert.equal(magKlantBewerken(), true);
    metVenster({ rollen: ['mentor'], rechten: ['customer.create'] }); assert.equal(magKlantBewerken(), false);
  } finally { delete globalThis.window; }
});

test('knop: fail-open als de rechten niet geladen zijn of RBAC ontbreekt', () => {
  try {
    metVenster({ rollen: ['mentor'], geladen: false }); assert.equal(magKlantBewerken(), true);
    metVenster({ rollen: ['mentor'], rbac: false });    assert.equal(magKlantBewerken(), true);
  } finally { delete globalThis.window; }
});

test('knoppen: alle drie de Bewerken-ingangen gebruiken magKlantBewerken; Archiveren niet', () => {
  const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const detail = lees('modules/klanten-v2/views/detail.js');
  assert.match(detail, /import \{ magKlantBewerken \}\s+from '\.\/klant-rechten\.js';/);
  assert.match(detail, /\$\{magKlantBewerken\(\) \? `\s*<button type="button" class="ds-btn ds-btn-ghost" data-kv-action="edit"/);
  assert.match(detail, /\$\{_isPrivilegedRole\(\) \? `\s*\$\{customer\?\.archived_at/, 'archiveren blijft op de oude rol-check');
  const profiel = lees('modules/klanten-v2/views/tabs/profiel.js');
  assert.match(profiel, /\$\{magKlantBewerken\(\) \? `<button[^>]*data-kv-action-inline="edit"/);
  const list = lees('modules/klanten-v2/views/list.js');
  assert.doesNotMatch(list, /^import /m, 'list.js houdt geen statische imports');
  assert.match(list, /await import\('\.\/klant-rechten\.js'\)/);
  assert.match(list, /\$\{state\.magBewerken \? `<button class="ds-dd-item" data-act="row-edit">/);
  assert.match(list, /querySelector\('\[data-act="row-edit"\]'\)\?\.addEventListener/);
});
