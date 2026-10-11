// tests/mail-bouwer.test.js
//
// Mailbouwer (2026-10-11): e-mailsjablonen uit blokken.
//   1. compiler (modules/shared/mail-blokken.js): tabellen + inline CSS, geen
//      flex/grid/<style>, Outlook-kolommen, escaping, alleen veilige links en
//      https-afbeeldingen, rijke tekst opgeschoond;
//   2. huisstijl: één bron (server = browser), afmeldregel één keer;
//   3. server: sjabloon opslaan (blokken + gecompileerde html), terugval zonder
//      kolom, verzenden 1-op-1 en massa compileert ZELF uit de blokken;
//   4. upload: alleen echte afbeeldingen ≤ 2 MB, publieke URL;
//   5. bouwer in jsdom: blokken toevoegen/verplaatsen/verwijderen, upload,
//      voorbeeld desktop/mobiel, opslaan, opnieuw openen = zelfde structuur;
//      "Stuur bericht" laadt een bouwer-sjabloon en verstuurt de blokken;
//   6. bedrading: index.html, cache-busters, SQL + bucket.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const mails = [];
const opslag = { uploads: [], fout: null };
const db = { tab: { lead_mail_sjablonen: [], email_replies: [], berichten_log: [] }, kolomFout: false };
const tabel = (t) => {
  const f = []; let op = 'select'; let rij = null; let velden = '';
  const k = {
    select: (v) => { if (op === 'select') velden = v || ''; return k; },
    eq: (c, v) => { f.push((r) => String(r[c]) === String(v)); return k; },
    order: () => k, limit: () => k,
    insert: (r) => { op = 'insert'; rij = r; return k; },
    update: (r) => { op = 'update'; rij = r; return k; },
    single: () => k,
    then(ok, nok) {
      const lijst = db.tab[t] || (db.tab[t] = []);
      let res;
      if (db.kolomFout && /blokken/.test(velden + JSON.stringify(rij || {}))) res = { data: null, error: { code: '42703', message: 'column lead_mail_sjablonen.blokken does not exist' } };
      else if (op === 'insert') { const n = { id: '00000000-0000-4000-8000-00000000000' + (lijst.length + 1), ...rij }; lijst.push(n); res = { data: t === 'lead_mail_sjablonen' ? n : [n], error: null }; }
      else if (op === 'update') { const sel = lijst.filter((r) => f.every((fn) => fn(r))); sel.forEach((r) => Object.assign(r, rij)); res = { data: sel, error: null }; }
      else res = { data: lijst.filter((r) => f.every((fn) => fn(r))).map((r) => { const { blokken, ...rest } = r; return /blokken/.test(velden) ? r : rest; }), error: null };
      return Promise.resolve(res).then(ok, nok);
    },
  };
  return k;
};
const nepSb = {
  from: tabel,
  storage: { from: (bucket) => ({
    upload: async (pad, bytes, o) => { if (opslag.fout) return { error: { message: opslag.fout } }; opslag.uploads.push({ bucket, pad, grootte: bytes.length, type: o.contentType }); return { error: null }; },
    getPublicUrl: (pad) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${pad}` } }),
  }) },
};
mock.module(url('api/supabase.js'), { namedExports: { supabase: nepSb, supabaseAdmin: nepSb, createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }), verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { mails.push(m); return { ok: true, messageId: '<m@x>' }; }, sluitSmtpPools: () => {} } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: { haalLijn: async () => ({ phoneNumberId: '1' }), mailAfzender: () => 'welkom@deforexopleiding.nl' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), templateStatusOpLijn: async () => null, goedgekeurdeTemplatesOpLijn: async () => null } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const B = await import(url('modules/shared/mail-blokken.js'));
const H = await import(url('modules/shared/mail-huisstijl.js'));
const S = await import(url('api/_lib/mail-shell-lead.js'));
const L = await import(url('api/_lib/lead-bericht.js'));
const SJ = await import(url('api/lead-mail-sjablonen.js'));
const UP = await import(url('api/mail-afbeelding-upload.js'));

const IMG = 'https://x.supabase.co/storage/v1/object/public/mail-afbeeldingen/sjablonen/2026/10/a.png';
const alleBlokken = () => {
  const b = ['kop', 'tekst', 'knop', 'afbeelding', 'kolommen', 'lijn', 'ruimte'].map(B.maakBlok);
  b[3].url = IMG; b[3].alt = 'Grafiek';
  b[4].links.afbeelding = IMG;
  return b;
};

// ── 1. Compiler ────────────────────────────────────────────────────────────

test('compiler: tabellen + inline CSS, geen flex/grid/<style>, Outlook-kolommen', () => {
  const html = B.compileerBlokken(alleBlokken());
  assert.match(html, /^<!-- dfo-mailbouwer v1 --><table role="presentation"/);
  assert.doesNotMatch(html, /display:\s*(flex|grid)|<style|class=/i, 'e-mailveilig');
  assert.match(html, /<h2 style="margin:0;font-family:Arial/);
  assert.match(html, /<td align="center" bgcolor="#10284A"[^>]*>\s*<a href="\{\{boekingslink\}\}" target="_blank" style="display:inline-block;padding:13px 26px/, 'bulletproof knop in navy');
  assert.match(html, new RegExp(`<img src="${IMG.replace(/[.?/]/g, '\\$&')}" alt="Grafiek" width="540"`));
  assert.match(html, /<!--\[if mso\]><table role="presentation" width="100%"[\s\S]*?<!\[endif\]-->/, 'Outlook-tabel voor de kolommen');
  assert.match(html, /display:inline-block;width:100%;max-width:270px/, 'kolommen stapelen op mobiel');
  assert.match(html, /border-top:1px solid #dfe5ec/);
  assert.match(html, /height:24px;font-size:0;line-height:0/);
  const goud = B.compileerBlokken([{ ...B.maakBlok('knop'), stijl: 'goud', url: 'https://x.nl' }]);
  assert.match(goud, /bgcolor="#FFC21A"[\s\S]*color:#10284A/);
});

test('compiler: escaping en alleen veilige links/afbeeldingen', () => {
  const kwaad = B.compileerBlokken([
    { soort: 'kop', tekst: '<script>alert(1)</script>"x' },
    { soort: 'tekst', html: '<p onclick="x">Hoi <img src=x onerror=alert(1)><script>a()</script><b>vet</b> <a href="javascript:alert(1)">klik</a> <a href="{{boekingslink}}">plan</a></p><div>regel</div><style>p{}</style>' },
    { soort: 'knop', tekst: 'Klik', url: 'javascript:alert(1)' },
    { soort: 'afbeelding', url: 'http://onveilig.nl/a.png' },
  ]);
  assert.doesNotMatch(kwaad, /<script|onclick|onerror|javascript:|<style|<img src=x/i);
  assert.match(kwaad, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;x/);
  assert.match(kwaad, /<strong>vet<\/strong>/);
  assert.match(kwaad, /<a style="color:#10284A;text-decoration:underline" href="\{\{boekingslink\}\}">plan<\/a>/);
  assert.doesNotMatch(kwaad, /bgcolor=|<img src=""/, 'halve blokken (knop zonder link, afbeelding zonder bron) vallen weg');
  const n = B.normaliseerBlokken([{ soort: 'knop', tekst: 'Klik', url: 'javascript:x' }, { soort: 'afbeelding', url: 'http://x' }, { soort: 'kop', tekst: '' }, { soort: 'raar' }]);
  assert.equal(n.fouten.length, 4);
  assert.deepEqual(B.normaliseerBlokken([]).fouten, ['Voeg minstens één blok toe.']);
  assert.equal(B.veiligeLink('mailto:info@x.nl'), 'mailto:info@x.nl');
  assert.equal(B.veiligeAfbeelding('https://a/b.png'), 'https://a/b.png');
  assert.deepEqual(B.blokkenUitHtml('<p>Oud <b>sjabloon</b></p>').map((b) => [b.soort, b.html]), [['tekst', '<p>Oud <strong>sjabloon</strong></p>']]);
});

test('huisstijl: één bron voor server en browser; blokken vallen binnen de shell, afmeldregel één keer', () => {
  const body = B.compileerBlokken(alleBlokken());
  assert.equal(S.renderLeadMail({ bodyHtml: body, voorkeurenUrl: 'https://v' }), H.renderLeadMail({ bodyHtml: body, voorkeurenUrl: 'https://v', logoUrl: H.STANDAARD_LOGO_URL }));
  const mail = S.renderLeadMail({ bodyHtml: body, voorkeurenUrl: 'https://www.deforexopleiding.nl/voorkeuren?token=T' });
  assert.equal((mail.match(/Voorkeuren aanpassen of afmelden/g) || []).length, 1);
  assert.equal((mail.match(/De Forex Opleiding<\/div>/g) || []).length, 1, 'één kop');
  assert.ok(mail.indexOf('dfo-mailbouwer') > mail.indexOf('De Forex Opleiding</div>') && mail.indexOf('dfo-mailbouwer') < mail.indexOf('Met vriendelijke groet'));
  const tekst = H.htmlNaarTekst(body);
  assert.doesNotMatch(tekst, /\[if mso\]|<|endif/);
  assert.match(tekst, /Plan een gesprek \(\{\{boekingslink\}\}\)/);
});

// ── 3. Server ──────────────────────────────────────────────────────────────

const roep = async (h, req) => { let status = 200, out; await h({ headers: {}, query: {}, ...req }, { setHeader() {}, status(s) { status = s; return this; }, json(b) { out = b; return this; } }); return { status, out }; };

test('sjabloon opslaan met blokken: blokken + door de server gecompileerde html; bewerken; GET geeft blokken terug', async () => {
  db.tab.lead_mail_sjablonen = [];
  const blokken = alleBlokken();
  const nieuw = await roep(SJ.default, { method: 'POST', body: { naam: 'Welkom', onderwerp: 'Hoi {{voornaam}}', blokken, html: '<script>genegeerd</script>' } });
  assert.equal(nieuw.status, 200);
  const rij = db.tab.lead_mail_sjablonen[0];
  assert.equal(rij.blokken.length, 7);
  assert.equal(rij.html, B.compileerBlokken(blokken), 'html = server-compilatie, niet wat de browser stuurde');
  const upd = await roep(SJ.default, { method: 'POST', body: { id: rij.id, naam: 'Welkom 2', onderwerp: 'Hoi', blokken: blokken.slice(0, 2) } });
  assert.equal(upd.status, 200);
  assert.equal(db.tab.lead_mail_sjablonen[0].blokken.length, 2);
  const lijst = await roep(SJ.default, { method: 'GET' });
  assert.deepEqual(lijst.out.sjablonen[0].blokken.map((b) => b.soort), ['kop', 'tekst']);
  const fout = await roep(SJ.default, { method: 'POST', body: { naam: 'X', onderwerp: 'Y', blokken: [{ soort: 'knop', tekst: 'a', url: 'javascript:x' }] } });
  assert.equal(fout.status, 400);
  assert.equal((await roep(SJ.default, { method: 'POST', body: { naam: 'X', onderwerp: 'Y', blokken: [{ ...B.maakBlok('tekst'), html: '<p>{{korting}}</p>' }] } })).status, 400, 'onbekende variabele');
});

test('zonder de bouwer-migratie: losse sjablonen werken, bouwer-sjabloon → 409 met de migratie', async () => {
  db.kolomFout = true;
  try {
    const lijst = await roep(SJ.default, { method: 'GET' });
    assert.equal(lijst.status, 200, 'GET valt terug op de oude kolommen');
    assert.equal((await roep(SJ.default, { method: 'POST', body: { naam: 'Los', onderwerp: 'Y', html: '<p>tekst</p>' } })).status, 200);
    const b = await roep(SJ.default, { method: 'POST', body: { naam: 'Bouw', onderwerp: 'Y', blokken: alleBlokken() } });
    assert.equal(b.status, 409);
    assert.match(b.out.error, /2026-10-11-mail-bouwer\.sql/);
  } finally { db.kolomFout = false; }
});

test('verstuurMail met blokken: server compileert, tabellen blijven, variabelen ingevuld; massa = afmeldregel één keer', async () => {
  mails.length = 0;
  const lead = { id: 'l1', voornaam: 'Robby', email: 'robby@example.com', traject: '7-daagse' };
  await L.verstuurMail(nepSb, { lead, onderwerp: 'Hoi {{voornaam}}', html: '<p>genegeerd</p>', blokken: alleBlokken(), boekingslink: 'https://agenda.example/7' });
  const m = mails[0];
  assert.equal(m.subject, 'Hoi Robby');
  assert.match(m.html, /<table role="presentation"/);
  assert.match(m.html, /<a href="https:\/\/agenda\.example\/7" target="_blank"/, '{{boekingslink}} in de knop ingevuld');
  assert.match(m.html, /Hoi Robby,/);
  assert.doesNotMatch(m.html, /genegeerd/);
  assert.doesNotMatch(m.html, /Voorkeuren aanpassen/, '1-op-1: geen afmeldregel');
  await L.verstuurMail(nepSb, { lead, onderwerp: 'X', blokken: alleBlokken(), massa: { voorkeurenUrl: 'https://v/t', afmeldUrl: 'https://a/t' } });
  assert.equal((mails[1].html.match(/Voorkeuren aanpassen of afmelden/g) || []).length, 1);
  await assert.rejects(L.verstuurMail(nepSb, { lead, onderwerp: 'X', blokken: [{ soort: 'kop', tekst: '' }] }), (e) => e.code === 'BLOKKEN_ONGELDIG');
});

// ── 4. Upload ──────────────────────────────────────────────────────────────

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c20000000049454e44ae426082', 'hex');

test('upload: echte afbeelding ≤ 2 MB → publieke URL in mail-afbeeldingen; de rest geweigerd', async () => {
  opslag.uploads.length = 0;
  const ok = await roep(UP.default, { method: 'POST', body: { bestandsnaam: 'a.png', content_type: 'image/png', data_base64: PNG.toString('base64') } });
  assert.equal(ok.status, 200);
  assert.match(ok.out.url, /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/public\/mail-afbeeldingen\/sjablonen\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  assert.deepEqual([opslag.uploads[0].bucket, opslag.uploads[0].type], ['mail-afbeeldingen', 'image/png']);
  assert.equal(UP.controleerUpload({ content_type: 'image/svg+xml', data_base64: 'PHN2Zz4=' }).ok, false, 'SVG niet (scripts)');
  assert.match(UP.controleerUpload({ content_type: 'image/png', data_base64: Buffer.from('<html>').toString('base64') }).fout, /geen PNG/);
  assert.match(UP.controleerUpload({ content_type: 'image/jpeg', data_base64: Buffer.alloc(2 * 1024 * 1024 + 10, 0xff).toString('base64') }).fout, /2 MB/);
  opslag.fout = 'Bucket not found';
  const geen = await roep(UP.default, { method: 'POST', body: { content_type: 'image/png', data_base64: PNG.toString('base64') } });
  opslag.fout = null;
  assert.equal(geen.status, 409);
});

// ── 5. Bouwer in jsdom ─────────────────────────────────────────────────────

function nieuweDom(fetchAntwoord) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const verzoeken = [];
  w.MailBlokken = B; w.MailHuisstijl = H;
  w.KV = { toast: () => {}, authedFetch: async (u, init) => { const body = init && init.body ? JSON.parse(init.body) : null; verzoeken.push({ url: u, body }); const j = fetchAntwoord(u, body); return { ok: true, status: 200, json: async () => j }; } };
  w.document.execCommand = () => true;
  w.FileReader = class { readAsDataURL() { this.result = 'data:image/png;base64,' + PNG.toString('base64'); setTimeout(() => this.onload(), 0); } };
  return { w, verzoeken };
}
const wacht = () => new Promise((ok) => setTimeout(ok, 0));

test('bouwer: blokken toevoegen, upload, verplaatsen, verwijderen, voorbeeld desktop/mobiel, opslaan en opnieuw bewerken', async () => {
  const { w, verzoeken } = nieuweDom((u) => (u === '/api/mail-afbeelding-upload' ? { ok: true, url: IMG } : { ok: true, sjabloon: { id: 's1' } }));
  w.eval(lees('modules/klanten-v2/views/_mail-bouwer.js'));
  let opgeslagen = null;
  w.MailBouwer.open({ sjabloon: {}, onOpgeslagen: (s) => { opgeslagen = s; } });
  const $ = (s) => w.document.querySelector(s);
  const klik = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const zet = (s, v) => { const el = $(s); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  for (const soort of ['kop', 'tekst', 'knop', 'afbeelding', 'kolommen', 'lijn']) klik($(`[data-mbw-voeg="${soort}"]`));
  const st = () => w.MailBouwer._intern.staat();
  const soorten = () => JSON.parse(JSON.stringify(st().blokken.map((b) => b.soort)));
  assert.deepEqual(soorten(), ['kop', 'tekst', 'knop', 'afbeelding', 'kolommen', 'lijn']);
  // Afbeelding uploaden in het afbeeldingsblok.
  klik($('[data-mbw-kaart="3"]'));
  const file = $('[data-mbw-upload="url"]');
  Object.defineProperty(file, 'files', { value: [{ name: 'a.png', type: 'image/png', size: PNG.length }] });
  file.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wacht(); await wacht(); await wacht();
  assert.equal(st().blokken[3].url, IMG, 'upload → publieke URL in het blok');
  assert.ok(verzoeken.some((v) => v.url === '/api/mail-afbeelding-upload' && v.body.content_type === 'image/png'));
  zet('[data-mbw-veld="alt"]', 'Grafiek');
  // Kolom-afbeelding ook.
  klik($('[data-mbw-kaart="4"]'));
  const kf = $('[data-mbw-upload="links.afbeelding"]');
  Object.defineProperty(kf, 'files', { value: [{ name: 'b.png', type: 'image/png', size: PNG.length }] });
  kf.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wacht(); await wacht(); await wacht();
  assert.equal(st().blokken[4].links.afbeelding, IMG);
  // Kop bewerken + verplaatsen + verwijderen.
  klik($('[data-mbw-kaart="0"]'));
  zet('[data-mbw-veld="tekst"]', 'Welkom bij De Forex Opleiding');
  klik($('[data-mbw-neer="0"]'));
  assert.deepEqual(soorten().slice(0, 2), ['tekst', 'kop']);
  klik($('[data-mbw-op="1"]'));
  assert.equal(st().blokken[0].tekst, 'Welkom bij De Forex Opleiding');
  klik($('[data-mbw-voeg="ruimte"]'));
  klik($(`[data-mbw-weg="1"]`));
  assert.equal(st().blokken.length, 6);
  // Voorbeeld: tabel in de huisstijl, voorbeeldnaam ingevuld; mobiel = smal.
  await new Promise((ok) => setTimeout(ok, 200));
  const src = $('[data-mbw-voorbeeld]').srcdoc;
  assert.match(src, /lead-mailshell/); assert.match(src, /dfo-mailbouwer v1/); assert.match(src, /Hoi Jeffrey,/);
  assert.equal($('[data-mbw-voorbeeld]').style.width, '640px');
  klik($('[data-mbw-weergave="mobiel"]'));
  assert.equal($('[data-mbw-voorbeeld]').style.width, '390px');
  // Opslaan: alleen blokken + naam + onderwerp.
  zet('[data-mbw-meta="naam"]', 'Testsjabloon');
  zet('[data-mbw-meta="onderwerp"]', 'Hoi {{voornaam}}');
  assert.equal($('[data-mbw-opslaan]').disabled, false);
  klik($('[data-mbw-opslaan]'));
  await wacht(); await wacht();
  const opslaan = verzoeken.find((v) => v.url === '/api/lead-mail-sjablonen');
  assert.deepEqual(Object.keys(opslaan.body).sort(), ['blokken', 'naam', 'onderwerp']);
  assert.deepEqual(opslaan.body.blokken.map((b) => b.soort), ['kop', 'tekst', 'knop', 'afbeelding', 'kolommen', 'lijn']);
  assert.deepEqual(opgeslagen, { id: 's1' });
  assert.equal(w.document.getElementById('mailBouwerRoot'), null);
  // Opnieuw openen: structuur intact.
  w.MailBouwer.open({ sjabloon: { id: 's1', naam: 'Testsjabloon', onderwerp: 'Hoi', blokken: opslaan.body.blokken } });
  assert.deepEqual(JSON.parse(JSON.stringify(st().blokken)), opslaan.body.blokken);
  assert.equal(w.document.querySelectorAll('[data-mbw-kaart]').length, 6);
  w.MailBouwer.sluit();
  // Een los (oud) sjabloon opent als één tekstblok.
  w.MailBouwer.open({ sjabloon: { id: 's2', naam: 'Oud', onderwerp: 'X', html: '<p>Oude tekst</p>' } });
  assert.deepEqual(JSON.parse(JSON.stringify(st().blokken.map((b) => [b.soort, b.html]))), [['tekst', '<p>Oude tekst</p>']]);
});

test('"Stuur bericht": bouwer-sjabloon laden → voorbeeld, en versturen stuurt de blokken', async () => {
  const blokken = alleBlokken();
  const { w, verzoeken } = nieuweDom((u, body) => {
    if (u.startsWith('/api/lead-bericht?')) return { lead: { naam: 'Robby', email: 'r@x.nl', geldig_email: true, geldig_telefoon: false }, variabelen: { voornaam: 'Robby', boekingslink: 'https://a' }, wa: { ok: false, templates: [] } };
    if (u === '/api/lead-mail-sjablonen') return { sjablonen: [{ id: 's1', naam: 'Bouwer', onderwerp: 'Hoi {{voornaam}}', html: B.compileerBlokken(blokken), blokken }] };
    if (u === '/api/lead-bericht') return { ok: true, onderwerp: 'Hoi Robby' };
    return {};
  });
  w.eval(lees('modules/klanten-v2/views/_stuur-bericht.js'));
  w.StuurBericht.open('lead-1');
  await wacht(); await wacht();
  const $ = (s) => w.document.querySelector(s);
  $('[data-sb-tab="mail"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wacht(); await wacht();
  const sel = $('[data-sb-veld="sjabloon"]'); sel.value = 's1'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.match($('[data-sb-bouwer-voorbeeld]').srcdoc, /dfo-mailbouwer v1[\s\S]*Hoi Robby,/);
  $('[data-sb-actie="verstuur-mail"]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  await wacht(); await wacht();
  const v = verzoeken.find((x) => x.url === '/api/lead-bericht' && x.body);
  assert.equal(v.body.blokken.length, 7);
  assert.equal(v.body.onderwerp, 'Hoi {{voornaam}}');
});

// ── 6. Bedrading ───────────────────────────────────────────────────────────

test('bedrading: index.html, cache-busters, SQL + bucket', () => {
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /import \* as MailBlokken from "\.\.\/shared\/mail-blokken\.js";/);
  assert.match(html, /window\.MailHuisstijl = MailHuisstijl;/);
  assert.match(html, /<script src="views\/_mail-bouwer\.js\?v=\d+"><\/script>/);
  assert.ok(Number((html.match(/views\/_stuur-bericht\.js\?v=(\d+)"/) || [])[1]) >= 2);
  assert.ok(Number((html.match(/views\/_massa-bericht\.js\?v=(\d+)"/) || [])[1]) >= 3);
  const sql = lees('docs/sql-migrations/2026-10-11-mail-bouwer.sql');
  assert.match(sql, /ALTER TABLE public\.lead_mail_sjablonen ADD COLUMN IF NOT EXISTS blokken jsonb/);
  assert.match(sql, /ALTER TABLE public\.massa_campagnes ADD COLUMN IF NOT EXISTS blokken jsonb/);
  assert.match(sql, /'mail-afbeeldingen',\s*'mail-afbeeldingen',\s*true,\s*--[^\n]*\n\s*2097152/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /CREATE POLICY/, 'geen upload-policy: alleen via het endpoint');
  assert.match(lees('api/mail-afbeelding-upload.js'), /requirePermission\(req, 'leads\.view'\)/);
});
