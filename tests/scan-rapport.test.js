// Strategie-scan fase 2 (2026-10-15): rapport + certificaat (PDF), mail, opslag.
//   1. rapportInhoud: secties zoals de mockup; "Jouw volgende stap" valt weg bij "Nu nog niet";
//   2. echte PDF's: geldig, A4 staand (rapport) / A4 liggend (certificaat), fonts ingebed;
//   3. mail vanaf info@ (mailer.js): voornaam, geen prijzen, disclaimer;
//   4. api/scan-rapport.js: rechten, voorbeeld-PDF, signed URL, versturen in de
//      volgorde upload → mail → status; mail mislukt = bestanden weg, status blijft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { ONDERDELEN, berekenUitkomst } from '../modules/scan/scan-model.js';
import { rapportInhoud, maakRapportPdf, maakCertificaatPdf, veiligeNaam, DISCLAIMER } from '../api/_lib/scan-pdf.js';
import { maakHandler, rapportMail, BUCKET } from '../api/scan-rapport.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const GOED = { motivatie: [1, 5, 4, 5, 5], tijd: [2, 4, 4, 4], stijl: [0, 0], financieel: [1, 1, 4], kennis: [1, 4, 4, 3], mindset: [4, 4, 4, 4], verwachtingen: [2, 0, 5, 5], leerstijl: [0, 5, 4, 5] };
const ans = (m) => { const a = {}; ONDERDELEN.forEach((p) => p.items.forEach((_, i) => { a[p.k + '_' + i] = m[p.k][i]; })); return a; };
const SCHULD = ans({ ...GOED, financieel: [3, 2, 2] });
const paginas = (buf) => (buf.toString('latin1').match(/\/Type \/Page[^s]/g) || []).length;

// ── 1. Inhoud ───────────────────────────────────────────────────────────────

test('inhoud: readiness, aanbevelingen, 6 balken, wat opvalt, advies, volgende stap, disclaimer', () => {
  const R = rapportInhoud({ naam: 'Mark de Vries', uitkomst: berekenUitkomst(ans(GOED)), assessor: 'Dave', datum: new Date('2026-10-15T10:00:00Z') });
  assert.equal(R.datum, '15 oktober 2026');
  assert.equal(R.readiness, 83); assert.equal(R.categorie, 'Zeer geschikt');
  assert.deepEqual(R.aanbevelingen.map((a) => a.kop), ['Aanbevolen aanpak', 'Aanbevolen traject']);
  assert.equal(R.balken.length, 6);
  assert.equal(R.volgendeStap.voordelen.length, 4);
  assert.equal(R.volgendeStap.schaars, 'We nemen maar een beperkt aantal nieuwe 1-op-1 cursisten per maand aan.', 'emoji eraf');
  assert.match(R.volgendeStap.cta, /Dave neemt dit rapport met je door/);
  assert.equal(R.disclaimer, DISCLAIMER);
  assert.match(DISCLAIMER, /niet gegarandeerd[\s\S]*risico op verlies[\s\S]*geen financieel advies/);
});

test('inhoud: "Nu nog niet" → geen aanpak, eerlijk advies, GEEN "Jouw volgende stap"', () => {
  const R = rapportInhoud({ naam: 'Sanne', uitkomst: berekenUitkomst(SCHULD) });
  assert.equal(R.categorie, 'Nu nog niet');
  assert.deepEqual(R.aanbevelingen.map((a) => a.titel), ['Eerst de basis op orde']);
  assert.equal(R.volgendeStap, null);
  // Ook via Dave's override.
  const O = rapportInhoud({ naam: 'X', uitkomst: berekenUitkomst(ans(GOED), { categorie: 'Nu nog niet' }) });
  assert.equal(O.volgendeStap, null);
});

// ── 2. Echte PDF's ──────────────────────────────────────────────────────────

test('pdf: rapport is een geldige A4-PDF met ingebedde fonts; certificaat A4 liggend, 1 pagina', async () => {
  const r = await maakRapportPdf({ naam: 'Mark de Vries', uitkomst: berekenUitkomst(ans(GOED)), assessor: 'Dave', datum: new Date('2026-10-15T10:00:00Z') });
  assert.equal(r.subarray(0, 5).toString(), '%PDF-');
  assert.ok(paginas(r) >= 2 && paginas(r) <= 4, 'rapport: ' + paginas(r) + ' pagina\'s');
  assert.match(r.toString('latin1'), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(r.toString('latin1'), /Fraunces/); assert.match(r.toString('latin1'), /Inter/);
  const n = await maakRapportPdf({ naam: 'Sanne', uitkomst: berekenUitkomst(SCHULD) });
  assert.ok(paginas(n) < paginas(r), 'zonder salesblok korter');
  const c = await maakCertificaatPdf({ naam: 'Mark de Vries', doel: 'Financiële vrijheid', assessor: 'Dave', datum: new Date('2026-10-15T10:00:00Z') });
  assert.equal(c.subarray(0, 5).toString(), '%PDF-');
  assert.equal(paginas(c), 1);
  assert.match(c.toString('latin1'), /\/MediaBox \[0 0 841\.89 595\.28\]/);
});

test('fonts: Fraunces + Inter (WOFF) met OFL-licentie in de repo; bestandsnamen veilig', () => {
  for (const f of ['fraunces-latin-600-normal.woff', 'fraunces-latin-700-normal.woff', 'inter-latin-400-normal.woff', 'inter-latin-500-normal.woff', 'inter-latin-600-normal.woff', 'inter-latin-700-normal.woff']) {
    assert.ok(existsSync(new URL('../api/_lib/fonts/scan/' + f, import.meta.url)), f);
  }
  assert.match(lees('api/_lib/fonts/scan/OFL-fraunces.txt'), /SIL Open Font License, Version 1\.1/);
  assert.match(lees('api/_lib/fonts/scan/OFL-inter.txt'), /SIL Open Font License, Version 1\.1/);
  assert.equal(veiligeNaam('Jan/de "Vries"\n'), 'Jan de Vries');
  assert.equal(veiligeNaam(''), 'deelnemer');
});

// ── 3. Mail ─────────────────────────────────────────────────────────────────

test('mail: voornaam, assessor, certificaat genoemd, disclaimer; geen prijzen', () => {
  const m = rapportMail({ naam: 'Mark de Vries', assessor: 'Dave' });
  assert.equal(m.subject, 'Jouw persoonlijke strategie-scan rapport');
  assert.match(m.html, /Hoi Mark,/); assert.match(m.html, /met Dave de strategie-scan/);
  assert.match(m.html, /Strategie-scan voltooid/);
  assert.match(m.text, /geen financieel advies/);
  // Alleen de tekst (de mail-shell heeft width="100%" in de opmaak).
  assert.doesNotMatch(m.html.replace(/<[^>]+>/g, ' ') + m.text, /€|\d+\s*%/);
  assert.match(rapportMail({ naam: '<b>x</b>', assessor: 'Dave' }).html, /Hoi &lt;b&gt;x&lt;\/b&gt;,/, 'naam ge-escaped');
  // Afzender = info@ via api/mailer.js (sendMail).
  assert.match(lees('api/scan-rapport.js'), /import \{ sendMail \} from '\.\/mailer\.js';/);
  assert.match(lees('api/mailer.js'), /const FROM_ADDRESS = 'info@deforexopleiding\.nl';/);
});

// ── 4. API ──────────────────────────────────────────────────────────────────

const ID = 'e0000000-0000-4000-8000-000000000001';
const DAVE = 'd0000000-0000-4000-8000-00000000da7e';
const PDF_R = Buffer.from('%PDF-rapport'); const PDF_C = Buffer.from('%PDF-certificaat');

function scanRij(extra = {}) {
  return { id: ID, status: 'afgerond', deelnemer_naam: 'Mark de Vries', deelnemer_email: 'mark@email.nl', assessor_id: DAVE,
    antwoorden: ans(GOED), override: {}, afgerond_op: '2026-10-15T10:00:00Z', aangemaakt: '2026-10-15T09:40:00Z',
    rapport_pdf_ref: null, certificaat_pdf_ref: null, ...extra };
}

function opzet({ scan = scanRij(), mag = true, user = { id: DAVE }, mailOk = true, uploadFout = null } = {}) {
  const st = { scans: scan ? [scan] : [], profiles: [{ id: DAVE, full_name: 'Dave Test' }] };
  const opslag = { geupload: [], verwijderd: [], signed: [] };
  const db = {
    from(t) {
      const f = []; let upd = null;
      const k = {
        select: () => k,
        eq: (c, v) => { f.push((r) => r[c] === v); return k; },
        update: (v) => { upd = v; return k; },
        maybeSingle: async () => ({ data: (st[t] || []).filter((r) => f.every((x) => x(r)))[0] || null, error: null }),
        then: (res) => {
          const rijen = (st[t] || []).filter((r) => f.every((x) => x(r)));
          if (upd) rijen.forEach((r) => Object.assign(r, upd));
          return Promise.resolve({ data: rijen, error: null }).then(res);
        },
      };
      return k;
    },
    storage: {
      from(b) {
        assert.equal(b, BUCKET);
        return {
          upload: async (pad, buf, o) => { if (uploadFout && pad.endsWith(uploadFout)) return { error: { message: 'nee' } }; opslag.geupload.push({ pad, buf, o }); return { error: null }; },
          remove: async (paden) => { opslag.verwijderd.push(...paden); return { error: null }; },
          createSignedUrl: async (pad, s) => { opslag.signed.push([pad, s]); return { data: { signedUrl: 'https://opslag/' + pad }, error: null }; },
        };
      },
    },
  };
  const mails = [];
  const h = maakHandler({
    db, userVan: async () => user, magHet: async () => mag,
    mail: async (m) => { mails.push(m); return mailOk ? { success: true } : { success: false, error: 'smtp weg' }; },
    rapportPdf: async () => PDF_R, certificaatPdf: async () => PDF_C,
    nu: () => new Date('2026-10-15T12:00:00Z'),
  });
  const roep = async (method, { query = {}, body } = {}) => {
    const res = { code: 0, body: null, kop: {}, setHeader(k, v) { this.kop[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end(b) { this.body = b; return this; } };
    await h({ method, headers: {}, query, body }, res);
    return res;
  };
  return { st, opslag, mails, roep };
}

test('api: 401 / 403 (strikt scan.use) / 400 / 404', async () => {
  assert.equal((await opzet({ user: null }).roep('GET', { query: { id: ID, soort: 'rapport' } })).code, 401);
  assert.equal((await opzet({ mag: false }).roep('POST', { body: { id: ID } })).code, 403);
  assert.equal((await opzet().roep('GET', { query: { id: 'x', soort: 'rapport' } })).code, 400);
  assert.equal((await opzet().roep('GET', { query: { id: ID, soort: 'iets' } })).code, 400);
  assert.equal((await opzet({ scan: null }).roep('POST', { body: { id: ID } })).code, 404);
});

test('api: voorbeeld-PDF inline; opgeslagen PDF via tijdelijke signed URL (1 uur)', async () => {
  const { roep } = opzet({ scan: scanRij({ rapport_pdf_ref: ID + '/x-rapport.pdf' }) });
  const r = await roep('GET', { query: { id: ID, soort: 'rapport' } });
  assert.equal(r.code, 200); assert.equal(r.kop['Content-Type'], 'application/pdf');
  assert.equal(r.body, PDF_R);
  assert.match(r.kop['Content-Disposition'], /^inline; filename="Strategie-scan rapport - Mark de Vries\.pdf"$/);
  const s = await roep('GET', { query: { id: ID, soort: 'rapport', opgeslagen: '1' } });
  assert.equal(s.body.url, 'https://opslag/' + ID + '/x-rapport.pdf');
  assert.equal((await roep('GET', { query: { id: ID, soort: 'certificaat', opgeslagen: '1' } })).code, 404);
});

test('api: versturen = upload (privé bucket) → mail met 2 bijlagen naar de deelnemer → status verstuurd + refs', async () => {
  const { st, opslag, mails, roep } = opzet();
  const r = await roep('POST', { body: { id: ID } });
  assert.equal(r.code, 200);
  assert.deepEqual(opslag.geupload.map((u) => u.pad), [ID + '/2026-10-15T12-00-00-000Z-rapport.pdf', ID + '/2026-10-15T12-00-00-000Z-certificaat.pdf']);
  assert.ok(opslag.geupload.every((u) => u.o.contentType === 'application/pdf' && u.o.upsert === false));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'mark@email.nl');
  assert.equal(mails[0].from, undefined, 'standaard-afzender van mailer.js = info@');
  assert.deepEqual(mails[0].attachments.map((a) => a.filename), ['Strategie-scan rapport - Mark de Vries.pdf', 'Certificaat strategie-scan - Mark de Vries.pdf']);
  assert.equal(mails[0].attachments[0].content, PDF_R);
  const s = st.scans[0];
  assert.equal(s.status, 'verstuurd'); assert.equal(s.verstuurd_op, '2026-10-15T12:00:00.000Z');
  assert.equal(s.rapport_pdf_ref, ID + '/2026-10-15T12-00-00-000Z-rapport.pdf');
  assert.equal(s.certificaat_pdf_ref, ID + '/2026-10-15T12-00-00-000Z-certificaat.pdf');
  assert.equal(s.uitkomst.readiness, 83, 'uitkomst opnieuw berekend en bewaard');
  assert.equal(r.body.scan.status, 'verstuurd');
});

test('api: mail mislukt → bestanden weer weg, status blijft afgerond (502); upload mislukt → niets gemaild', async () => {
  const a = opzet({ mailOk: false });
  const r = await a.roep('POST', { body: { id: ID } });
  assert.equal(r.code, 502); assert.equal(r.body.code, 'MAIL_MISLUKT');
  assert.equal(a.opslag.verwijderd.length, 2);
  assert.equal(a.st.scans[0].status, 'afgerond'); assert.equal(a.st.scans[0].rapport_pdf_ref, null);
  const b = opzet({ uploadFout: 'certificaat.pdf' });
  const r2 = await b.roep('POST', { body: { id: ID } });
  assert.equal(r2.code, 500);
  assert.equal(b.mails.length, 0);
  assert.deepEqual(b.opslag.verwijderd, [ID + '/2026-10-15T12-00-00-000Z-rapport.pdf'], 'de al geüploade helft opgeruimd');
});

test('api: concept → 409 (eerst afronden); geen e-mail → 422; opnieuw versturen mag', async () => {
  assert.equal((await opzet({ scan: scanRij({ status: 'concept' }) }).roep('POST', { body: { id: ID } })).body.code, 'NIET_AFGEROND');
  assert.equal((await opzet({ scan: scanRij({ deelnemer_email: null }) }).roep('POST', { body: { id: ID } })).code, 422);
  const o = opzet({ scan: scanRij({ status: 'verstuurd' }) });
  assert.equal((await o.roep('POST', { body: { id: ID } })).code, 200);
  assert.equal(o.mails.length, 1);
});

test('bedrading: bucket-SQL privé + alleen PDF; pagina-knoppen + cache-busters', () => {
  const sql = lees('docs/sql-migrations/2026-10-15-scan-fase2-bucket.sql');
  assert.match(sql, /VALUES \('scan-rapporten', 'scan-rapporten', false, 10485760, ARRAY\['application\/pdf'\]\)/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  const html = lees('modules/scan/index.html');
  assert.match(html, /id="verstuurBtn"[^>]*>Verstuur rapport \(info@\) →</);
  assert.match(html, /id="pdfRapportBtn"/); assert.match(html, /id="pdfCertBtn"/);
  // Minstens v=2 (latere wijzigingen hogen ze verder op).
  for (const f of ['scan-app\\.js', 'scan\\.css']) {
    const v = Number((html.match(new RegExp(f + '\\?v=(\\d+)')) || [])[1]);
    assert.ok(v >= 2, f + ' v=' + v);
  }
  const app = lees('modules/scan/scan-app.js');
  assert.match(app, /api\('POST', '\/api\/scan-rapport', \{ id: S\.id \}\)/);
  assert.match(app, /window\.confirm\(/);
});
