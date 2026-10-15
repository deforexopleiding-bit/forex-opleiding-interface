// Strategie-scan fase 3 (2026-10-15): overzicht + klant-status.
//   1. bepaalKlant: automatisch uit gewonnen deals (lead / klant van de lead /
//      e-mail), nieuwste deal + traject; handmatig heeft voorrang, bron zichtbaar;
//   2. api/scans-overzicht.js: rechten, lijst met klant-status + assessor,
//      werkt ook zonder fase-3-migratie, leads zoeken (veilig), klant-status
//      zetten, verwijderen (rij + PDF's);
//   3. bedrading: module alleen via recht scan.use, allowlist, script-tag, SQL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bepaalKlant, KLANT_STATUSSEN } from '../api/_lib/scan-klant.js';
import { maakHandler, zoekTerm } from '../api/scans-overzicht.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const U = (n) => 'a0000000-0000-4000-8000-' + String(n).padStart(12, '0');
const DAVE = U(900);

// ── 1. bepaalKlant ──────────────────────────────────────────────────────────

const deal = (id, extra = {}) => ({ id, tl_quotation_status: 'accepted', tl_quotation_declined_at: null, archived_at: null,
  tl_quotation_accepted_at: '2026-10-20T10:00:00Z', created_at: '2026-10-18T10:00:00Z', total_amount: 4995, traject_variant_id: 'v1', ...extra });
function ctx({ perLead = {}, perCust = {}, leadCust = {}, mailCust = {} } = {}) {
  return {
    leadNaarCustomer: new Map(Object.entries(leadCust)), emailNaarCustomers: new Map(Object.entries(mailCust)),
    dealsPerLead: new Map(Object.entries(perLead)), dealsPerCustomer: new Map(Object.entries(perCust)),
    trajectLabel: new Map([['v1', 'Mentorschap > 12 maanden'], ['v2', 'Mentorschap > 24 maanden']]),
  };
}

test('klant: automatisch via lead, via de klant van de lead en via e-mail; nieuwste gewonnen deal + traject', () => {
  const viaLead = bepaalKlant({ lead_id: 'L1' }, ctx({ perLead: { L1: [deal('d1')] } }));
  assert.deepEqual(viaLead, { status: 'klant', bron: 'automatisch', klant: true, auto: { deal_id: 'd1', traject: 'Mentorschap > 12 maanden', datum: '2026-10-20T10:00:00Z', bedrag: 4995 } });
  const viaKlant = bepaalKlant({ lead_id: 'L1' }, ctx({ leadCust: { L1: 'C1' }, perCust: { C1: [deal('d2', { traject_variant_id: 'v2' })] } }));
  assert.equal(viaKlant.auto.traject, 'Mentorschap > 24 maanden');
  const viaMail = bepaalKlant({ lead_id: null, deelnemer_email: ' Mark@Email.nl ' }, ctx({ mailCust: { 'mark@email.nl': ['C2'] }, perCust: { C2: [deal('d3')] } }));
  assert.equal(viaMail.klant, true);
  const twee = bepaalKlant({ lead_id: 'L1' }, ctx({ perLead: { L1: [deal('oud', { tl_quotation_accepted_at: '2026-01-01T00:00:00Z' }), deal('nieuw', { tl_quotation_accepted_at: '2026-11-01T00:00:00Z' })] } }));
  assert.equal(twee.auto.deal_id, 'nieuw');
});

test('klant: afgewezen / gearchiveerd / niet-geaccepteerd telt niet; zonder deal → nog geen klant', () => {
  for (const d of [deal('x', { tl_quotation_status: 'sent' }), deal('y', { archived_at: '2026-10-21T00:00:00Z' }), deal('z', { tl_quotation_declined_at: '2026-10-21T00:00:00Z' })]) {
    assert.deepEqual(bepaalKlant({ lead_id: 'L1' }, ctx({ perLead: { L1: [d] } })), { status: null, bron: null, klant: false, auto: null });
  }
  assert.equal(bepaalKlant({ lead_id: null, deelnemer_email: null }, ctx()).klant, false);
});

test('klant: handmatig heeft voorrang (ook tegen een gewonnen deal in), de auto-uitkomst blijft zichtbaar', () => {
  const tegen = bepaalKlant({ lead_id: 'L1', klant_status_handmatig: 'geen_klant' }, ctx({ perLead: { L1: [deal('d1')] } }));
  assert.equal(tegen.status, 'geen_klant'); assert.equal(tegen.bron, 'handmatig'); assert.equal(tegen.klant, false);
  assert.equal(tegen.auto.deal_id, 'd1');
  const zelf = bepaalKlant({ lead_id: null, klant_status_handmatig: 'klant' }, ctx());
  assert.deepEqual([zelf.status, zelf.bron, zelf.klant], ['klant', 'handmatig', true]);
  assert.equal(bepaalKlant({ klant_status_handmatig: 'in_gesprek' }, ctx()).klant, false);
  assert.equal(bepaalKlant({ klant_status_handmatig: 'onzin' }, ctx()).bron, null);
  assert.deepEqual(KLANT_STATUSSEN, ['klant', 'in_gesprek', 'geen_klant']);
});

// ── 2. API ──────────────────────────────────────────────────────────────────

function nepDb(begin, { zonderKlantKolommen = false } = {}) {
  const t = JSON.parse(JSON.stringify(begin));
  const opslag = { verwijderd: [] };
  const from = (tabel) => {
    t[tabel] = t[tabel] || [];
    const f = []; let upd = null; let del = false; let max = null; let kolommen = '';
    const pas = () => { let r = t[tabel].filter((x) => f.every((g) => g(x))); if (max != null) r = r.slice(0, max); return r; };
    const uit = () => {
      if (zonderKlantKolommen && tabel === 'scans' && (/klant_status/.test(kolommen) || (upd && 'klant_status_handmatig' in upd))) {
        return { data: null, error: { code: '42703', message: 'column scans.klant_status_handmatig does not exist' } };
      }
      if (del) { const weg = pas(); t[tabel] = t[tabel].filter((x) => !weg.includes(x)); return { data: weg, error: null }; }
      if (upd) { const r = pas(); r.forEach((x) => Object.assign(x, upd)); return { data: r, error: null }; }
      return { data: pas(), error: null };
    };
    const k = {
      select: (c) => { kolommen = c || ''; return k; },
      eq: (c, v) => { f.push((r) => r[c] === v); return k; },
      is: (c, v) => { f.push((r) => (r[c] ?? null) === v); return k; },
      in: (c, v) => { f.push((r) => v.includes(r[c])); return k; },
      or: (expr) => {
        const m = String(expr).match(/naam\.ilike\.%(.*)%,email\.ilike\.%(.*)%/);
        const w = m ? m[1].toLowerCase() : '';
        f.push((r) => String(r.naam || '').toLowerCase().includes(w) || String(r.email || '').toLowerCase().includes(w));
        return k;
      },
      order: () => k,
      limit: (n) => { max = n; return k; },
      update: (v) => { upd = v; return k; },
      delete: () => { del = true; return k; },
      maybeSingle: async () => { const r = uit(); return { data: r.data ? r.data[0] || null : null, error: r.error }; },
      then: (res, rej) => Promise.resolve(uit()).then(res, rej),
    };
    return k;
  };
  const storage = { from: () => ({
    list: async (pad) => ({ data: [{ name: 'a-rapport.pdf' }, { name: 'a-certificaat.pdf' }].map((x) => ({ ...x, _pad: pad })), error: null }),
    remove: async (paden) => { opslag.verwijderd.push(...paden); return { error: null }; },
  }) };
  return { from, storage, t, opslag };
}

function basis() {
  return {
    scans: [
      { id: U(1), lead_id: U(11), assessor_id: DAVE, status: 'verstuurd', deelnemer_naam: 'Mark de Vries', deelnemer_email: 'mark@email.nl', readiness_score: 83, categorie: 'Zeer geschikt', aanbevolen_aanpak: 'Daytrading', aanbevolen_traject: '24 maanden 1-op-1', aangemaakt: '2026-10-15T10:00:00Z', klant_status_handmatig: null },
      { id: U(2), lead_id: null, assessor_id: DAVE, status: 'concept', deelnemer_naam: 'Anna', deelnemer_email: 'anna@x.nl', readiness_score: 60, categorie: 'Geschikt met de juiste begeleiding', aangemaakt: '2026-10-14T10:00:00Z', klant_status_handmatig: 'in_gesprek' },
    ],
    profiles: [{ id: DAVE, full_name: 'Dave Test', email: 'dave@x.nl' }],
    leads: [{ id: U(11), customer_id: U(21), naam: 'Mark de Vries', email: 'mark@email.nl', verwijderd_op: null }, { id: U(12), naam: 'Markus', email: 'markus@y.nl', verwijderd_op: null }],
    customers: [{ id: U(21), email: 'Mark@Email.nl' }],
    deals: [{ id: U(31), customer_id: U(21), source_lead_id: null, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-10-22T10:00:00Z', archived_at: null, tl_quotation_declined_at: null, total_amount: 4995, traject_variant_id: U(41) }],
    traject_variants: [{ id: U(41), name: '24 maanden', traject_id: U(51) }],
    trajects: [{ id: U(51), name: 'Mentorschap' }],
  };
}

function opzet({ mag = true, user = { id: DAVE }, ...opties } = {}) {
  const db = nepDb(basis(), opties);
  const h = maakHandler({ db, userVan: async () => user, magHet: async () => mag, nu: () => new Date('2026-10-23T12:00:00Z') });
  const roep = async (method, { query = {}, body } = {}) => {
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ method, headers: {}, query, body }, res);
    return res;
  };
  return { db, roep };
}

test('api: 401 / 403 (strikt scan.use) / 405', async () => {
  assert.equal((await opzet({ user: null }).roep('GET')).code, 401);
  assert.equal((await opzet({ mag: false }).roep('GET')).code, 403);
  assert.equal((await opzet().roep('PUT')).code, 405);
});

test('api: lijst met assessor, klant-status (auto via de klant van de lead + traject; handmatig) en assessoren', async () => {
  const r = await opzet().roep('GET');
  assert.equal(r.code, 200); assert.equal(r.body.migratie_nodig, false);
  const [mark, anna] = r.body.scans;
  assert.equal(mark.assessor_naam, 'Dave Test');
  assert.deepEqual(mark.klant, { status: 'klant', bron: 'automatisch', klant: true, auto: { deal_id: U(31), traject: 'Mentorschap > 24 maanden', datum: '2026-10-22T10:00:00Z', bedrag: 4995 } });
  assert.deepEqual([anna.klant.status, anna.klant.bron, anna.klant.klant], ['in_gesprek', 'handmatig', false]);
  assert.deepEqual(r.body.assessoren, [{ id: DAVE, naam: 'Dave Test' }]);
});

test('api: zonder fase-3-migratie → lijst werkt (alles automatisch), zetten geeft 409 MIGRATIE_NODIG', async () => {
  const o = opzet({ zonderKlantKolommen: true });
  const r = await o.roep('GET');
  assert.equal(r.code, 200); assert.equal(r.body.migratie_nodig, true);
  assert.equal(r.body.scans[0].klant.bron, 'automatisch');
  assert.equal(r.body.scans[1].klant.status, null, 'handmatig niet leesbaar zonder kolom');
  const p = await o.roep('POST', { body: { actie: 'klant_status', id: U(1), klant_status: 'klant' } });
  assert.equal(p.code, 409); assert.equal(p.body.code, 'MIGRATIE_NODIG');
});

test('api: leads zoeken voor "Nieuwe scan" (min. 2 tekens, max 10, zoekterm veilig)', async () => {
  const { roep } = opzet();
  assert.deepEqual((await roep('GET', { query: { leads: 'm' } })).body.leads, []);
  const r = await roep('GET', { query: { leads: 'mark' } });
  assert.deepEqual(r.body.leads.map((l) => l.naam), ['Mark de Vries', 'Markus']);
  assert.equal(zoekTerm('a,b(c)%*\\ d'), 'a b c d');
});

test('api: klant-status handmatig zetten en terug naar automatisch; ongeldig → 400; onbekend → 404', async () => {
  const { roep, db } = opzet();
  const r = await roep('POST', { body: { actie: 'klant_status', id: U(1), klant_status: 'geen_klant' } });
  assert.equal(r.code, 200);
  const s = db.t.scans[0];
  assert.equal(s.klant_status_handmatig, 'geen_klant'); assert.equal(s.klant_status_door, DAVE); assert.equal(s.klant_status_op, '2026-10-23T12:00:00.000Z');
  const terug = await roep('POST', { body: { actie: 'klant_status', id: U(1), klant_status: null } });
  assert.equal(terug.code, 200);
  assert.equal(s.klant_status_handmatig, null); assert.equal(s.klant_status_door, null);
  assert.equal((await roep('POST', { body: { actie: 'klant_status', id: U(1), klant_status: 'misschien' } })).code, 400);
  assert.equal((await roep('POST', { body: { actie: 'iets', id: U(1) } })).code, 400);
  assert.equal((await roep('POST', { body: { actie: 'klant_status', id: U(99), klant_status: 'klant' } })).code, 404);
});

test('api: verwijderen = rij weg + alle PDF\'s onder <id>/; onbekend → 404', async () => {
  const { roep, db } = opzet();
  const r = await roep('DELETE', { query: { id: U(1) } });
  assert.equal(r.code, 200);
  assert.equal(db.t.scans.length, 1);
  assert.deepEqual(db.opslag.verwijderd, [U(1) + '/a-rapport.pdf', U(1) + '/a-certificaat.pdf']);
  assert.equal((await roep('DELETE', { query: { id: U(1) } })).code, 404);
  assert.equal((await roep('DELETE', { query: { id: 'x' } })).code, 400);
});

// ── 3. Bedrading ────────────────────────────────────────────────────────────

test('bedrading: module "Strategie-scans" alleen via scan.use, allowlist, script-tag, view, SQL', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /\{ g: 'Leren & Events',\s+id: 'scans',\s+naam: 'Strategie-scans',[^\n]*roles: \[\], permKey: 'scan\.use', tabs: \['Overzicht'(, 'Dashboard')?\]/);
  assert.ok(shell.indexOf("id: 'scans'") > shell.indexOf("id: 'webinar'"), 'direct onder Webinar');
  assert.match(lees('modules/klanten-v2/klanten-v2.js'), /'support', 'scans'\]\);/);
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /<script src="views\/scans-v2\.js\?v=\d+"><\/script>/);
  // Minstens deze versies (latere wijzigingen hogen ze verder op).
  for (const [f, v] of [['app-shell', '1e3'], ['klanten-v2', '1f7']]) {
    const nu = (html.match(new RegExp(`${f}\\.js\\?v=([0-9a-z]+)"`)) || [])[1];
    assert.ok(nu && parseInt(nu, 36) >= parseInt(v, 36), f + ' v=' + nu);
  }
  const view = lees('modules/klanten-v2/views/scans-v2.js');
  assert.match(view, /window\.DFO\.VIEWS\['scans\/Overzicht'\] = scansView;/);
  assert.match(view, /window\.KV_V2_ADD\('scans'\)/);
  assert.match(view, /H\.stableSearch\(ZOEK, /, 'zoekveld behoudt focus');
  for (const f of ["sel('status'", "sel('categorie'", "sel('traject'", "sel('aanpak'", "sel('klant'", "sel('assessor'", "__scF('periode'"]) assert.ok(view.includes(f), f);
  assert.match(view, /window\.confirm\(vraag\)/);
  const sql = lees('docs/sql-migrations/2026-10-15-scan-fase3.sql');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS klant_status_handmatig text NULL\s+CHECK \(klant_status_handmatig IN \('klant', 'in_gesprek', 'geen_klant'\)\)/);
  assert.match(sql, /klant_status_door uuid NULL REFERENCES public\.profiles\(id\)/);
});
