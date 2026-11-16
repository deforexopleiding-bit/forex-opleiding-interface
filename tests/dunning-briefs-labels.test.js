// tests/dunning-briefs-labels.test.js
//
// Adreslabels (Wanbetalers → Brieven → 🏷 Labels):
//   - volgorde = exact de volgorde van de PDF-bundel (gedeelde helper)
//   - adresregels = exact die van de brief, land in HOOFDLETTERS
//   - layout: 288 × 432 pt, 3 vakken, regels verkleind tot ze passen
//   - de endpoint leest enkel: geen update/insert (downloaded_at/sent_at blijven)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { leesBriefIds, ordenBriefRijen } from '../api/_lib/dunning-briefs-selectie.js';
import { briefAdresRegels, labelAdresRegels } from '../api/_lib/brief-adres.js';
import {
  maakAdreslabelsPdf, layoutVak, pasGrootte,
  BASE_W, BASE_H, VAK_H, TEKST_MARGE, NAAM_SIZE, REGEL_SIZE, MIN_SIZE,
} from '../api/_lib/adreslabels-pdf.js';

const url = (p) => new URL('../' + p, import.meta.url).href;
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ── Selectie + volgorde ─────────────────────────────────────────────

test('leesBriefIds: dubbels weg, eerste telt, volgorde blijft', () => {
  const r = leesBriefIds({ brief_ids: [U(3), U(1), U(3), U(2)] });
  assert.deepEqual(r, { ok: true, ids: [U(3), U(1), U(2)] });
});

test('leesBriefIds: fouten zoals de bundel', () => {
  assert.equal(leesBriefIds({}).code, 'MISSING_BRIEF_IDS');
  assert.equal(leesBriefIds({ brief_ids: ['x'] }).code, 'INVALID_UUID');
  assert.equal(leesBriefIds({ brief_ids: Array.from({ length: 101 }, (_, i) => U(i)) }).code, 'TOO_MANY');
  assert.equal(leesBriefIds(JSON.stringify({ brief_ids: [U(1)] })).ok, true);
});

test('ordenBriefRijen: volgorde van de selectie, onbekend valt weg', () => {
  const rows = [{ id: U(1) }, { id: U(2) }, { id: U(3) }];
  assert.deepEqual(ordenBriefRijen([U(2), U(9), U(3), U(1)], rows).map((r) => r.id), [U(2), U(3), U(1)]);
});

// ── Adresregels ─────────────────────────────────────────────────────

const BE = { first_name: 'Jan', last_name: 'Peeters', is_company: false, address_street: 'Kerkstraat', address_number: '12 bus 3', address_postal: '9000', address_city: 'Gent', address_country: 'BE' };
const NL_BV = { first_name: 'Piet', last_name: 'Jansen', company_name: 'Jansen Bouw B.V.', is_company: true, address_street: 'Dorpsweg', address_number: '5', address_postal: '1234 AB', address_city: 'Utrecht', address_country: null };

test('label = brief, enkel het land in hoofdletters', () => {
  assert.deepEqual(briefAdresRegels(BE, 'BE'), ['Jan Peeters', 'Kerkstraat 12 bus 3', '9000 Gent', 'België']);
  assert.deepEqual(labelAdresRegels(BE, 'BE'), ['Jan Peeters', 'Kerkstraat 12 bus 3', '9000 Gent', 'BELGIË']);
  assert.deepEqual(labelAdresRegels(NL_BV, 'NL'), ['Jansen Bouw B.V.', 'Dorpsweg 5', '1234 AB Utrecht', 'NEDERLAND']);
});

test('label volgt het land van de brief (dunning_briefs.country), anders dezelfde afleiding', () => {
  assert.equal(labelAdresRegels(NL_BV, 'BE').at(-1), 'BELGIË');
  assert.equal(labelAdresRegels({ ...BE, address_country: null }, null).at(-1), 'BELGIË'); // 4 cijfers → BE
});

// ── Layout ──────────────────────────────────────────────────────────

async function fonts() {
  const doc = await PDFDocument.create();
  return { doc, bold: await doc.embedFont(StandardFonts.HelveticaBold), regular: await doc.embedFont(StandardFonts.Helvetica) };
}

test('pagina 288 × 432 pt, 3 adressen per pagina, laatste mag minder', async () => {
  const adressen = Array.from({ length: 7 }, (_, i) => [`Naam ${i}`, 'Straat 1', '1000 Brussel', 'BELGIË']);
  const pdf = await PDFDocument.load(await maakAdreslabelsPdf(adressen));
  assert.equal(pdf.getPageCount(), 3);
  for (const p of pdf.getPages()) {
    assert.equal(p.getWidth(), 288);
    assert.equal(p.getHeight(), 432);
  }
});

test('vak: naam 14,5 bold, rest 13, links uitgelijnd en blok gecentreerd', async () => {
  const f = await fonts();
  const regels = layoutVak(['Jan Peeters', 'Kerkstraat 12', '9000 Gent', 'BELGIË'], 1, f);
  assert.equal(regels.length, 4);
  assert.equal(regels[0].size, NAAM_SIZE);
  assert.equal(regels[0].font, f.bold);
  assert.ok(regels.slice(1).every((r) => r.size === REGEL_SIZE && r.font === f.regular));
  assert.ok(regels.every((r) => r.x === regels[0].x), 'alle regels zelfde x (links uitgelijnd)');
  const blokW = Math.max(...regels.map((r) => r.font.widthOfTextAtSize(r.tekst, r.size)));
  assert.ok(Math.abs(regels[0].x - (BASE_W - blokW) / 2) < 1e-9, 'horizontaal gecentreerd');
  // Regelafstand 1,32 × fontgrootte.
  assert.ok(Math.abs((regels[1].y - regels[2].y) - 13 * 1.32) < 1e-9);
  // Verticaal: midden van het vak 1 (y 144..288) ligt binnen het blok.
  const top = BASE_H - VAK_H;
  assert.ok(regels[0].y < top && regels[3].y > top - VAK_H);
});

test('te brede regel: enkel die regel kleiner (stappen 0,5, min 7)', async () => {
  const f = await fonts();
  const lang = 'Bischoppenhoflaan-Achterstraat-Verlengde-Zijweg-Noord 332 bus 303';
  const regels = layoutVak(['Jan', lang, '9000 Gent', 'BELGIË'], 0, f);
  const maxW = BASE_W - 2 * TEKST_MARGE;
  assert.ok(regels[1].size < REGEL_SIZE);
  assert.ok((REGEL_SIZE - regels[1].size) % 0.5 === 0);
  assert.ok(f.regular.widthOfTextAtSize(lang, regels[1].size) <= maxW);
  assert.equal(regels[2].size, REGEL_SIZE);
  assert.equal(pasGrootte(f.regular, 'X'.repeat(400), REGEL_SIZE, maxW), MIN_SIZE);
});

// ── Endpoint: volgorde = bundel, puur lezen ─────────────────────────

test('endpoint: zelfde volgorde als de bundel, geen schrijfacties', async () => {
  const klanten = new Map([
    ['c1', { id: 'c1', ...BE }],
    ['c2', { id: 'c2', ...NL_BV }],
    ['c3', { id: 'c3', ...BE, first_name: 'Els', last_name: 'Claes' }],
  ]);
  const brieven = [
    { id: U(1), customer_id: 'c1', country: 'BE', pdf_path: 'p1', generated_at: 'x' },
    { id: U(2), customer_id: 'c2', country: 'NL', pdf_path: 'p2', generated_at: 'x' },
    { id: U(3), customer_id: 'c3', country: 'BE', pdf_path: 'p3', generated_at: 'x' },
    { id: U(4), customer_id: 'c3', country: 'BE', pdf_path: null, generated_at: 'x' }, // bundel slaat over
  ];
  const writes = [];
  function q(table) {
    let ids = null;
    const b = {
      select() { return b; },
      in(_k, v) { ids = v; return b; },
      update(v) { writes.push(['update', table, v]); return b; },
      insert(v) { writes.push(['insert', table, v]); return Promise.resolve({ error: null }); },
      then(res, rej) {
        const src = table === 'dunning_briefs' ? brieven : [...klanten.values()];
        return Promise.resolve({ data: src.filter((r) => !ids || ids.includes(r.id)), error: null }).then(res, rej);
      },
    };
    return b;
  }
  // Een brief-PDF met de klantnaam als tekst, zodat we de bundelvolgorde kunnen lezen.
  async function briefPdf(path) {
    const d = await PDFDocument.create();
    d.setTitle(path);
    d.addPage([595, 842]);
    return new Blob([await d.save()]);
  }
  const admin = {
    from: q,
    storage: { from: () => ({
      download: async (p) => (p ? { data: await briefPdf(p), error: null } : { data: null, error: { message: 'geen pad' } }),
      createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: 'u', error: null })), error: null }),
    }) },
  };
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });

  const labels = (await import(url('api/dunning-briefs-labels.js') + '?t=' + Math.random())).default;
  const bundel = (await import(url('api/dunning-briefs-bulk-print.js') + '?t=' + Math.random())).default;

  const call = async (h, ids) => {
    const res = { code: null, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
    await h({ method: 'POST', headers: {}, body: { brief_ids: ids } }, res);
    return res;
  };

  for (const volgorde of [[U(3), U(1), U(4), U(2)], [U(2), U(4), U(1), U(3)]]) {
    // Bundelvolgorde = paginatitels van de samengevoegde brieven? Die gaan verloren bij
    // copyPages; daarom tellen we de volgorde via de downloads van storage.
    const downloads = [];
    const orig = admin.storage.from;
    admin.storage.from = () => { const s = orig(); const d = s.download; s.download = async (p) => { downloads.push(p); return d(p); }; return s; };
    const b = await call(bundel, volgorde);
    admin.storage.from = orig;
    assert.equal(b.code, 200);
    const bundelKlanten = downloads.filter(Boolean).map((p) => brieven.find((x) => x.pdf_path === p).customer_id);

    const vóór = writes.length;
    const l = await call(labels, volgorde);
    assert.equal(l.code, 200);
    assert.equal(writes.length, vóór, 'labels schrijven niets');
    assert.equal(l.headers['X-Labels-Count'], '3');
    assert.equal(l.headers['X-Labels-Skipped'], '1');
    assert.match(l.headers['Content-Disposition'], /^inline; filename="Adreslabels brieven \d{2}-\d{2}-\d{4}\.pdf"$/);
    const pdf = await PDFDocument.load(l.body);
    assert.equal(pdf.getPageCount(), 1);

    // Volgorde labels = volgorde bundel: herbereken de verwachte adressen.
    const verwacht = bundelKlanten.map((cid) => labelAdresRegels(klanten.get(cid), brieven.find((x) => x.customer_id === cid).country));
    const opnieuw = await PDFDocument.load(await maakAdreslabelsPdf(verwacht, { titel: pdf.getTitle() }));
    assert.equal(opnieuw.getPageCount(), pdf.getPageCount());
    assert.deepEqual(
      ordenBriefRijen(volgorde, brieven).filter((r) => r.pdf_path).map((r) => r.customer_id),
      bundelKlanten,
    );
  }
  // De bundel zelf markeert nog steeds als gedownload (ongewijzigd gedrag).
  assert.ok(writes.some(([k, t, v]) => k === 'update' && t === 'dunning_briefs' && v.downloaded_at));
});
