// tests/esign.test.js — E-handtekening fase 1 (2026-11-09)
//
//   1. coördinaten: scherm-fracties ↔ PDF-punten, ook op gedraaide pagina's;
//   2. tokens: 256 bit, alleen de hash, vorm-check;
//   3. volgorde: wie wordt uitgenodigd, wie mag tekenen (sequentieel/parallel);
//   4. versturen: compleetheid; velden uit de editor; invulling bij tekenen;
//   5. het definitieve PDF: velden ingebrand op de juiste plek + certificaatpagina;
//   6. de publieke tekenroute: onbekend = verlopen (zelfde antwoord), rate limit;
//   7. SQL: audit alleen-toevoegen, RLS + REVOKE, geen role_permissions (alleen super_admin).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const C = await import(url('modules/esign/esign-coords.js'));
const K = await import(url('api/_lib/esign-core.js'));
const P = await import(url('api/_lib/esign-pdf.js'));

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const bijna = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

// ── 1. Coördinaten ──────────────────────────────────────────────────────────
test('coords: rotatie 0 — linksboven op het scherm = hoog in de PDF', () => {
  const box = { x: 0, y: 0, breedte: 600, hoogte: 800 };
  const p = C.plaatsInPdf({ x: 0.1, y: 0.25, breedte: 0.2, hoogte: 0.05 }, box, 0);
  bijna(p.x, 60, 'x'); bijna(p.y, 800 * (1 - 0.3), 'y = onderkant van het veld');
  bijna(p.breedte, 120, 'breedte'); bijna(p.hoogte, 40, 'hoogte'); assert.equal(p.rotatie, 0);
});

test('coords: CropBox met offset telt mee', () => {
  const p = C.plaatsInPdf({ x: 0, y: 0, breedte: 0.5, hoogte: 0.5 }, { x: 20, y: 30, breedte: 100, hoogte: 200 }, 0);
  bijna(p.x, 20, 'x'); bijna(p.y, 130, 'y');
});

test('coords: gedraaide pagina\'s — elke hoek van het scherm valt op de juiste PDF-hoek', () => {
  const box = { x: 0, y: 0, breedte: 600, hoogte: 800 };
  // getoond linksboven (0,0) per rotatie
  const lb = { 0: [0, 800], 90: [0, 0], 180: [600, 0], 270: [600, 800] };
  for (const r of [0, 90, 180, 270]) {
    const p = C.getoondNaarPdf(0, 0, box, r);
    bijna(p.x, lb[r][0], `r${r} x`); bijna(p.y, lb[r][1], `r${r} y`);
    // het midden blijft het midden
    const m = C.getoondNaarPdf(0.5, 0.5, box, r);
    bijna(m.x, 300, `r${r} midden x`); bijna(m.y, 400, `r${r} midden y`);
  }
  // getoonde maat wisselt bij 90/270
  assert.deepEqual(C.getoondeMaat(box, 90), { breedte: 800, hoogte: 600 });
  assert.deepEqual(C.getoondeMaat(box, 180), { breedte: 600, hoogte: 800 });
  // veld op een 90°-pagina: breedte in getoonde punten, oorsprong = getoond linksonder van het veld
  const p = C.plaatsInPdf({ x: 0.25, y: 0.5, breedte: 0.5, hoogte: 0.1 }, box, 90);
  bijna(p.breedte, 400, 'breedte 90'); bijna(p.hoogte, 60, 'hoogte 90'); assert.equal(p.rotatie, 90);
  bijna(p.x, 600 * 0.6, 'x 90'); bijna(p.y, 800 * 0.25, 'y 90');
});

test('coords: px ↔ fractie, afgeklemd binnen de pagina', () => {
  const f = C.pxNaarFractie({ left: 900, top: -20, width: 200, height: 50 }, 1000, 1400);
  assert.ok(f.x + f.breedte <= 1 && f.y >= 0, JSON.stringify(f));
  bijna(f.breedte, 0.2, 'breedte'); bijna(f.x, 0.8, 'x geklemd');
  const px = C.fractieNaarPx({ x: 0.1, y: 0.2, breedte: 0.3, hoogte: 0.05 }, 1000, 1400);
  assert.deepEqual(px, { left: 100, top: 280, width: 300, height: 70 });
  assert.equal(C.veldGeldig({ type: 'tekst', pagina: 1, x: 0.9, y: 0, breedte: 0.2, hoogte: 0.1 }), false, 'buiten de pagina');
  assert.equal(C.veldGeldig({ type: 'stempel', pagina: 1, x: 0, y: 0, breedte: 0.2, hoogte: 0.1 }), false, 'onbekend type');
});

// ── 2. Tokens ───────────────────────────────────────────────────────────────
test('tokens: 256 bit base64url, alleen de hash bewaren, 14 dagen geldig', () => {
  const nu = new Date('2026-11-09T10:00:00Z');
  const a = K.maakToken(nu); const b = K.maakToken(nu);
  assert.notEqual(a.token, b.token);
  assert.equal(a.token.length, 43); assert.ok(K.tokenVorm(a.token));
  assert.equal(a.hash, K.hashToken(a.token)); assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(a.verloopt_op, '2026-11-23T10:00:00.000Z');
  assert.equal(K.tokenVorm('abc'), false); assert.equal(K.tokenVorm(a.token + '='), false);
});

// ── 3. Volgorde ─────────────────────────────────────────────────────────────
const O = (n, status) => ({ id: 'o' + n, volgnummer: n, status, naam: 'Persoon ' + n, soort: 'intern' });

test('volgorde: sequentieel nodigt één tegelijk uit, parallel iedereen', () => {
  const lijst = [O(1, 'wacht'), O(2, 'wacht'), O(3, 'wacht')];
  assert.deepEqual(K.teUitnodigen(lijst, 'sequentieel').map((o) => o.id), ['o1']);
  assert.deepEqual(K.teUitnodigen(lijst, 'parallel').map((o) => o.id), ['o1', 'o2', 'o3']);
  const na1 = [O(1, 'getekend'), O(2, 'wacht'), O(3, 'wacht')];
  assert.deepEqual(K.teUitnodigen(na1, 'sequentieel').map((o) => o.id), ['o2']);
  assert.deepEqual(K.teUitnodigen([O(1, 'getekend'), O(2, 'uitgenodigd'), O(3, 'wacht')], 'sequentieel'), [], 'nr 2 heeft al een link');
  assert.deepEqual(K.aanDeBeurt([O(1, 'getekend'), O(2, 'geopend'), O(3, 'wacht')], 'sequentieel').map((o) => o.id), ['o2']);
});

test('volgorde: mag tekenen pas als de eerdere getekend hebben', () => {
  const lijst = [O(1, 'geopend'), O(2, 'uitgenodigd')];
  assert.equal(K.magTekenen(lijst[0], lijst, 'sequentieel'), true);
  assert.equal(K.magTekenen(lijst[1], lijst, 'sequentieel'), false);
  assert.equal(K.magTekenen(lijst[1], lijst, 'parallel'), true);
  assert.equal(K.magTekenen(O(3, 'wacht'), lijst, 'parallel'), false, 'zonder uitnodiging niet');
  assert.equal(K.statusUitOntvangers([O(1, 'getekend'), O(2, 'geopend')]), 'deels_getekend');
  assert.equal(K.iedereenGetekend([O(1, 'getekend'), O(2, 'getekend')]), true);
  assert.equal(K.iedereenGetekend([]), false);
});

// ── 4. Versturen, velden, invulling ─────────────────────────────────────────
test('versturen: concept + één PDF + iedereen een handtekeningveld; geen externen', () => {
  const env = { status: 'concept' };
  const docs = [{ id: 'd1', paginas: [{}] }];
  const ontv = [O(1, 'wacht'), O(2, 'wacht')];
  const velden = [{ ontvanger_id: 'o1', type: 'handtekening' }];
  const p = K.klaarOmTeVersturen({ envelope: env, documenten: docs, ontvangers: ontv, velden });
  assert.equal(p.length, 1); assert.match(p[0], /Persoon 2/);
  assert.deepEqual(K.klaarOmTeVersturen({ envelope: env, documenten: docs, ontvangers: ontv, velden: [...velden, { ontvanger_id: 'o2', type: 'handtekening' }] }), []);
  assert.ok(K.klaarOmTeVersturen({ envelope: env, documenten: docs, ontvangers: [{ ...O(1, 'wacht'), soort: 'extern' }], velden }).some((x) => /Externe/.test(x)));
});

test('velden uit de editor: pagina en ondertekenaar moeten bestaan', () => {
  const ctx = { documenten: [{ id: 'd1', paginas: [{}, {}] }], ontvangers: [{ id: 'o1' }] };
  const goed = { document_id: 'd1', ontvanger_id: 'o1', type: 'tekst', pagina: 2, x: 0.1, y: 0.1, breedte: 0.2, hoogte: 0.03, verplicht: false };
  const r = K.valideerVeldDefinities([goed, { ...goed, type: 'handtekening', verplicht: false }], ctx);
  assert.ok(r.ok); assert.equal(r.velden[0].verplicht, false); assert.equal(r.velden[1].verplicht, true, 'handtekening altijd verplicht');
  assert.equal(K.valideerVeldDefinities([{ ...goed, pagina: 3 }], ctx).ok, false);
  assert.equal(K.valideerVeldDefinities([{ ...goed, ontvanger_id: 'o9' }], ctx).ok, false);
});

test('invulling: akkoord verplicht, handtekening als PNG, datum en naam vult de server', () => {
  const velden = [
    { id: 'v1', type: 'handtekening', verplicht: true },
    { id: 'v2', type: 'datum', verplicht: true },
    { id: 'v3', type: 'naam', verplicht: true },
    { id: 'v4', type: 'checkbox', verplicht: true },
    { id: 'v5', type: 'tekst', verplicht: false },
  ];
  const basis = { akkoord: true, handtekening: { dataUrl: PNG_1x1, methode: 'getekend' }, waarden: { v4: true, v5: '  hallo  ' } };
  const nu = new Date('2026-11-09T23:30:00Z');   // in Brussel al 10 november
  const r = K.valideerInvulling(velden, basis, { naam: 'Seppe Hellin' }, nu);
  assert.ok(r.ok, r.fout);
  assert.equal(r.waarden.get('v2'), '10-11-2026'); assert.equal(r.waarden.get('v3'), 'Seppe Hellin');
  assert.equal(r.waarden.get('v4'), 'ja'); assert.equal(r.waarden.get('v5'), 'hallo');
  assert.equal(r.beelden.handtekening.methode, 'getekend');
  assert.equal(K.valideerInvulling(velden, { ...basis, akkoord: false }, {}).ok, false);
  assert.equal(K.valideerInvulling(velden, { ...basis, handtekening: { dataUrl: 'data:image/png;base64,AAAA', methode: 'getekend' } }, {}).ok, false);
  assert.equal(K.valideerInvulling(velden, { ...basis, waarden: { v4: false } }, {}).ok, false, 'verplicht vinkje');
  assert.equal(K.valideerInvulling(velden, { ...basis, handtekening: { dataUrl: PNG_1x1, methode: 'stempel' } }, {}).ok, false);
});

test('winAnsi: typografische tekens vervangen, emoji weg, accenten blijven', () => {
  assert.equal(K.winAnsi('“Café” – één 😀'), '"Café" - één ');
});

// ── 5. Het definitieve PDF ──────────────────────────────────────────────────
async function maakTestPdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([595.28, 841.89]);
  const p2 = pdf.addPage([595.28, 841.89]); p2.setRotation(degrees(90));
  return pdf.save();
}

test('PDF: pagina-info leest rotatie en getoonde maat', async () => {
  const info = await P.leesPaginas(await maakTestPdf());
  assert.equal(info.length, 2);
  assert.equal(info[0].rotatie, 0); assert.equal(info[1].rotatie, 90);
  bijna(info[1].breedte, 841.89, 'gedraaid: getoonde breedte = hoogte');
});

test('PDF: velden ingebrand + certificaatpagina, origineel ongewijzigd qua pagina\'s', async () => {
  const origineel = await maakTestPdf();
  const paginas = await P.leesPaginas(origineel);
  const document = { naam: 'contract.pdf', sha256: K.sha256Hex(origineel), paginas };
  const envelope = { id: 'e1', titel: 'Samenwerkingsovereenkomst “2026”', volgorde: 'sequentieel', verzonden_op: '2026-11-09T09:00:00Z', voltooid_op: '2026-11-09T10:00:00Z' };
  const ontvangers = [{ id: 'o1', volgnummer: 1, naam: 'Seppe Hellin', email: 's@x.nl', soort: 'intern', handtekening_methode: 'getekend', uitgenodigd_op: '2026-11-09T09:00:00Z', getekend_op: '2026-11-09T09:30:00Z' }];
  const velden = [
    { ontvanger_id: 'o1', type: 'handtekening', pagina: 1, x: 0.1, y: 0.8, breedte: 0.3, hoogte: 0.06, waarde: 'pad' },
    { ontvanger_id: 'o1', type: 'datum', pagina: 2, x: 0.1, y: 0.1, breedte: 0.2, hoogte: 0.04, waarde: '09-11-2026' },
    { ontvanger_id: 'o1', type: 'checkbox', pagina: 1, x: 0.5, y: 0.5, breedte: 0.03, hoogte: 0.02, waarde: 'ja' },
    { ontvanger_id: 'o1', type: 'tekst', pagina: 1, x: 0.5, y: 0.6, breedte: 0.3, hoogte: 0.03, waarde: 'Opmerking 😀 met emoji' },
  ];
  const beelden = new Map([['o1', { handtekening: K.pngUitDataUrl(PNG_1x1) }]]);
  const events = [
    { type: 'verzonden', tijdstip: '2026-11-09T09:00:00Z', methode: 'crm_login', ip: '1.2.3.4', details: { door_naam: 'Jeffrey' } },
    { type: 'getekend', ontvanger_id: 'o1', tijdstip: '2026-11-09T09:30:00Z', methode: 'email_token_link', ip: '5.6.7.8', user_agent: 'Mozilla/5.0 (Windows NT 10.0) ' + 'x'.repeat(200) },
  ];
  const uit = await P.maakGetekendePdf({ origineel, document, envelope, ontvangers, velden, beelden, events });
  const terug = await PDFDocument.load(uit);
  assert.ok(terug.getPageCount() >= 3, 'origineel (2) + certificaat');
  assert.equal(terug.getPage(1).getRotation().angle, 90, 'rotatie van het origineel blijft');
  assert.match(K.sha256Hex(uit), /^[0-9a-f]{64}$/);
  assert.notEqual(K.sha256Hex(uit), document.sha256);
});

test('PDF: versleutelde of kapotte PDF wordt geweigerd', async () => {
  await assert.rejects(() => P.leesPaginas(new TextEncoder().encode('%PDF-1.4 kapot')));
});

// ── 6. Publieke tekenroute ──────────────────────────────────────────────────
const omg = { limited: false, lookups: 0, rijen: null };
mock.module(url('api/supabase.js'), {
  namedExports: {
    supabase: { auth: { getUser: async () => ({ data: { user: { id: '00000000-0000-4000-8000-000000000001', email: 'test@dfo.nl' } }, error: null }) } },
    supabaseAdmin: {
      from() {
        // Elke filtermethode geeft de keten terug; awaiten zonder maybeSingle
        // levert omg.rijen (lijsten zoals teamleden/klanten).
        const q = {
          maybeSingle: async () => { omg.lookups++; return { data: null, error: null }; },
          then: (ok, nok) => Promise.resolve({ data: omg.rijen, error: null }).then(ok, nok),
        };
        for (const m of ['select', 'eq', 'not', 'is', 'or', 'order', 'limit', 'in']) q[m] = () => q;
        return q;
      },
    },
  },
});
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: omg.limited }) } });
mock.module(url('api/mailer.js'), { namedExports: { sendMail: async () => ({ success: true }) } });
const { default: teken } = await import(url('api/esign-teken.js'));
function nepRes() { const r = { statusCode: 200, headers: {} }; r.setHeader = (k, v) => { r.headers[k] = v; }; r.status = (c) => { r.statusCode = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; }
const roep = async (body) => { const res = nepRes(); await teken({ method: 'POST', body, headers: {} }, res); return res; };

test('tekenroute: rare vorm en onbekend token → zelfde 404, geen lookup voor rommel', async () => {
  omg.limited = false; omg.lookups = 0;
  const a = await roep({ actie: 'open', token: 'kort' });
  const b = await roep({ actie: 'open', token: K.maakToken().token });
  assert.equal(a.statusCode, 404); assert.equal(b.statusCode, 404);
  assert.equal(a.body.error, b.body.error, 'geen orakel');
  assert.equal(omg.lookups, 1, 'alleen het echte token raakt de DB');
  assert.equal(a.headers['Referrer-Policy'], 'no-referrer');
});

test('tekenroute: rate limit → 429, onbekende actie → 400, GET → 405', async () => {
  omg.limited = true;
  assert.equal((await roep({ actie: 'teken', token: K.maakToken().token })).statusCode, 429);
  omg.limited = false;
  assert.equal((await roep({ actie: 'wis' })).statusCode, 400);
  const res = nepRes(); await teken({ method: 'GET', headers: {} }, res); assert.equal(res.statusCode, 405);
});

// Regressie preview 9 nov: de editor laadt eerst ?actie=teamleden (zonder id) en
// kreeg "Ongeldig envelope-id" omdat de id-controle vóór die acties stond.
const { default: crm } = await import(url('api/esign.js'));
const crmGet = async (query) => { const res = nepRes(); await crm({ method: 'GET', query, headers: { authorization: 'Bearer x' } }, res); return res; };

test('CRM-route: teamleden en klanten hebben geen envelope-id nodig; detail wel', async () => {
  omg.rijen = [{ id: 'p1', full_name: 'Amigo', email: 'amigo@dfo.nl', role: 'super_admin', is_active: true }];
  try {
    const t = await crmGet({ actie: 'teamleden' });
    assert.equal(t.statusCode, 200, JSON.stringify(t.body));
    assert.deepEqual(t.body.teamleden.map((x) => x.email), ['amigo@dfo.nl']);
    const k = await crmGet({ actie: 'klanten', q: 'am' });
    assert.equal(k.statusCode, 200, JSON.stringify(k.body));
    assert.equal((await crmGet({ actie: 'detail', id: 'geen-uuid' })).statusCode, 400);
    assert.equal((await crmGet({ actie: 'download' })).statusCode, 400);
    assert.equal((await crmGet({ actie: 'iets' })).statusCode, 400);
  } finally { omg.rijen = null; }
});

// ── 7. SQL + bedrading ──────────────────────────────────────────────────────
test('SQL: audit alleen-toevoegen, RLS + REVOKE, extern-ready, geen role_permissions', () => {
  const sql = lees('docs/sql-migrations/2026-11-09-e-handtekening-fase1-tabellen.sql');
  assert.match(sql, /BEFORE UPDATE OR DELETE ON public\.esign_events/);
  assert.match(sql, /BEFORE TRUNCATE ON public\.esign_events/);
  for (const t of ['esign_envelopes', 'esign_documenten', 'esign_ontvangers', 'esign_velden', 'esign_events']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), t);
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon, authenticated`), t);
  }
  assert.match(sql, /soort\s+text NOT NULL DEFAULT 'intern' CHECK \(soort IN \('intern','extern'\)\)/);
  assert.match(sql, /CHECK \(soort <> 'intern' OR profile_id IS NOT NULL\)/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /role_permissions/, 'alleen super_admin: geen rol-rechten');
  assert.doesNotMatch(sql, /DO \$\$|TEMP TABLE/);
  const bucket = lees('docs/sql-migrations/2026-11-09-e-handtekening-fase1-bucket.sql');
  assert.match(bucket, /VALUES \('e-handtekening', 'e-handtekening', false,/);
});

test('bedrading: token in de #-hash, rewrite /teken, module + rechten in de registry', () => {
  assert.match(lees('api/_lib/esign-server.js'), /\/teken#t=\$\{token\}/);
  const vercel = JSON.parse(lees('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/teken' && r.destination === '/modules/esign/teken.html'));
  assert.ok(vercel.headers.some((h) => h.source === '/teken' && h.headers.some((x) => x.key === 'Referrer-Policy' && x.value === 'no-referrer')));
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /id: 'esign',\s+naam: 'E-handtekening'.*roles: \[\], permKey: 'esign\.view'/);
  const reg = lees('modules/shared/rbac/registry.js');
  assert.match(reg, /key:'esign\.view'/); assert.match(reg, /key:'esign\.send'/);
  assert.match(lees('modules/klanten-v2/index.html'), /<script src="views\/esign-v2\.js\?v=1"><\/script>/);
});
