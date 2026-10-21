// tests/support-telefoon.test.js
//
// GSM VERPLICHT IN DE SUPPORTWIDGET, IN E.164, EN BELBAAR IN HET CRM (2026-10-21).
//
//   1. De regel (api/_lib/support-telefoon.js) geeft exact dezelfde uitkomst als
//      de funnels op de website: tests/fixtures/funnel-telefoon.json is
//      gegenereerd UIT dfo-website lib/lab-scan-funnels.ts (controleerFunnelTelefoon
//      + funnelTelefoonHint) — e164, gsm/vast, melding én de hint.
//   2. De widget draagt een letterlijke kopie van die regel; die kopie is gelijk
//      aan de server-versie en geeft dezelfde uitkomsten.
//   3. support-start weigert een aanvraag zonder geldig nummer (klant én
//      bezoeker) en bewaart het nummer in E.164.
//   4. De widget: veld voor iedereen, placeholder + hint als de funnels, geen
//      verzoek zonder geldig nummer, en het nummer gaat in E.164 mee.
//   5. De supportmodule toont het nummer met een Bel-knop (softphone), en
//      '— geen nummer' voor oude aanvragen.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const FIX = JSON.parse(lees('tests/fixtures/funnel-telefoon.json'));

// ── mocks voor support-start ─────────────────────────────────────────
const ingevoegd = [];
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: {
      from: () => {
        let rij = null;
        const k = {
          insert: (p) => { rij = { id: 'g-' + (ingevoegd.length + 1), ...p }; ingevoegd.push(rij); return k; },
          select: () => k,
          maybeSingle: async () => ({ data: rij, error: null }),
        };
        return k;
      },
    },
    supabase: {}, createUserClient: () => ({}),
  },
});
mock.module('../api/_lib/rate-limit.js', { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module('../api/_lib/support-beschikbaarheid.js', {
  namedExports: { haalBeschikbaarheid: async () => ({ live: false }), beschikbaarheidsTekst: () => '' },
});
mock.module('../api/_lib/support-sessie.js', {
  namedExports: {
    maakSessieToken: () => 'tok', hashToken: () => 'hash', maakKenmerk: () => 'SUP-TEST22',
    schrijfBericht: async () => ({}), publiekGesprek: (g) => ({ kenmerk: g.kenmerk, email: g.email }),
  },
});

const T = await import('../api/_lib/support-telefoon.js');
const { default: start } = await import('../api/support-start.js');

function nepRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}
const verzoek = (body) => ({ method: 'POST', headers: { origin: 'https://www.deforexopleiding.nl' }, body, socket: {} });

test('1. de regel = de funnelregel van de website (53 gevallen: e164, gsm, melding, hint)', () => {
  assert.ok(FIX.gevallen.length >= 50);
  assert.equal(T.SUPPORT_TEL_PLACEHOLDER, FIX.placeholder);
  for (const g of FIX.gevallen) {
    const u = T.controleerSupportTelefoon(g.in);
    assert.equal(u.ok, g.ok, JSON.stringify(g.in));
    if (g.ok) { assert.equal(u.e164, g.e164, g.in); assert.equal(u.gsm, g.gsm, g.in); }
    else assert.equal(u.melding, g.melding, g.in);
    assert.equal(T.supportTelefoonHint(g.in), g.hint, 'hint ' + g.in);
  }
  // de afspraken uit de opdracht, expliciet
  const e = (x) => { const u = T.controleerSupportTelefoon(x); return u.ok ? u.e164 : null; };
  assert.equal(e('020 123 4567'), '+31201234567', '0 + 9 cijfers → +31');
  assert.equal(e('09 123 45 67'), '+3291234567', '0 + 8 cijfers → +32');
  assert.equal(e('0031612345678'), '+31612345678');
  assert.equal(e('0032470123456'), '+32470123456');
  assert.equal(e('+31 6 12345678'), '+31612345678');
  assert.equal(e('+32 470 12 34 56'), '+32470123456');
  for (const x of ['', '06 1234567', '12345', 'abc', '+31 6 123']) assert.equal(e(x), null, x);
});

test('2. de widget draagt een letterlijke kopie van de regel, met dezelfde uitkomsten', () => {
  const blok = (s) => {
    const b = s.slice(s.indexOf('/* TELEFOON-REGEL:BEGIN */'), s.indexOf('/* TELEFOON-REGEL:END */'));
    assert.ok(b.length > 500);
    return b;
  };
  const server = blok(lees('api/_lib/support-telefoon.js'));
  // in de widget staat het blok binnen de IIFE: elke niet-lege regel 2 spaties dieper
  const widget = blok(lees('widget/support.js')).split('\n').map((l) => (l.startsWith('  ') ? l.slice(2) : l)).join('\n');
  assert.equal(widget, server, 'de kopie in widget/support.js wijkt af van api/_lib/support-telefoon.js');
  const ctx = {};
  vm.runInNewContext(widget + '\nthis.R = maakTelefoonRegel();', ctx);
  for (const g of FIX.gevallen) {
    const u = ctx.R.controleer(g.in);
    assert.equal(u.ok, g.ok, g.in);
    if (g.ok) assert.equal(u.e164, g.e164, g.in);
    assert.equal(ctx.R.hint(g.in), g.hint, g.in);
  }
});

test('3. support-start: geen aanvraag zonder geldig nummer (klant én bezoeker), opslag in E.164', async () => {
  const basis = { onderwerp: 'informatie', naam: 'Test', email: 'maxim.delombaerde96+labtest6@gmail.com', vraag: 'Test van het gsm-veld' };
  for (const soort of ['bezoeker', 'klant']) {
    for (const [tel, melding] of [[undefined, T.SUPPORT_TEL_MELDING_LEEG], ['', T.SUPPORT_TEL_MELDING_LEEG], ['12345', T.SUPPORT_TEL_MELDING_FOUT], ['06 1234567', /06-nummer heeft 10 cijfers/]]) {
      const voor = ingevoegd.length;
      const res = nepRes();
      await start(verzoek({ ...basis, soort, telefoon: tel }), res);
      assert.equal(res.statusCode, 400, soort + ' ' + tel);
      assert.equal(res.body.veld, 'telefoon');
      if (melding instanceof RegExp) assert.match(res.body.error, melding); else assert.equal(res.body.error, melding);
      assert.equal(ingevoegd.length, voor, 'geen rij zonder geldig nummer');
    }
  }
  const res = nepRes();
  await start(verzoek({ ...basis, soort: 'bezoeker', telefoon: '06 12 34 56 78' }), res);
  assert.equal(res.statusCode, 201);
  assert.equal(ingevoegd.at(-1).telefoon, '+31612345678');
  const res2 = nepRes();
  await start(verzoek({ ...basis, soort: 'klant', onderwerp: 'lms', telefoon: '0032 470 12 34 56' }), res2);
  assert.equal(res2.statusCode, 201);
  assert.equal(ingevoegd.at(-1).telefoon, '+32470123456');
});

test('4. widget: gsm-veld voor iedereen, placeholder + hint, verplicht en in E.164 naar de server', async () => {
  const { laad, wacht } = await import('./support-widget-harness.js');
  const CONFIG = { status: 200, body: { aan: true, live: false, onderwerpen: { klant: [{ id: 'lms', label: 'LMS' }], bezoeker: [{ id: 'informatie', label: 'Informatie' }] } } };
  const w = laad({ routes: {
    'support-widget-config': CONFIG,
    'support-start': ({ opts }) => ({ status: 201, body: { token: 't', gesprek: { kenmerk: 'SUP-TEST22', email: JSON.parse(opts.body).email }, live: false } }),
    'support-poll': { status: 200, body: { berichten: [], gesprek: { status: 'bot' } } },
  } });
  await wacht();
  await w.klik('knop');
  w.sr().querySelector('[data-a="soort"][data-v="bezoeker"]').click(); await wacht();
  await w.klik('onderwerp');
  const tel = w.sr().querySelector('#f-tel');
  assert.ok(tel, 'ook een bezoeker krijgt het gsm-veld');
  assert.equal(tel.getAttribute('placeholder'), FIX.placeholder);
  assert.equal(tel.getAttribute('type'), 'tel');
  w.invoer('f-naam', 'Test');
  w.invoer('f-mail', 'maxim.delombaerde96+labtest6@gmail.com');
  w.invoer('f-vraag', 'Test van het gsm-veld');
  // zonder nummer: melding, geen verzoek
  await w.klik('start');
  assert.match(w.html(), /Vul je gsm-nummer in/);
  assert.equal(w.log.calls.filter((c) => c.naam === 'support-start').length, 0);
  // te kort 06-nummer: melding, geen verzoek
  w.invoer('f-tel', '06 1234567');
  await w.klik('start');
  assert.match(w.html(), /06-nummer heeft 10 cijfers/);
  assert.equal(w.log.calls.filter((c) => c.naam === 'support-start').length, 0);
  // hint tijdens het typen
  w.invoer('f-tel', '0470 12 34 56');
  w.sr().querySelector('#f-tel').dispatchEvent(new w.window.Event('input', { bubbles: true }));
  assert.equal(w.sr().querySelector('#f-tel-hint').textContent, '✓ We sturen je WhatsApp naar +32 470 12 34 56');
  await w.klik('start');
  const verstuurd = w.log.calls.filter((c) => c.naam === 'support-start');
  assert.equal(verstuurd.length, 1);
  assert.equal(verstuurd[0].body.telefoon, '+32470123456');
});

test('5. supportmodule: nummer + Bel-knop (softphone) in lijst en detail, "— geen nummer" voor oude aanvragen', () => {
  const v = lees('modules/klanten-v2/views/support-v2.js');
  assert.match(v, /\{ l: 'Telefoon' \}/, 'kolom in de lijst');
  assert.match(v, /telMetBel\(r, true\)/, 'lijst');
  assert.match(v, /regel\('Telefoon', telMetBel\(g, false\)\)/, 'detail');
  assert.match(v, /'— geen nummer'/);
  assert.match(v, /window\.KlxSoftphone\.open\(\{ phone: b\.telefoon, name: b\.naam \|\| b\.telefoon, customerId: b\.customerId \|\| '', source: 'support' \}\)/);
  assert.match(v, /event\.stopPropagation\(\);/, 'Bel in de lijst opent het gesprek niet');
  assert.match(lees('modules/klanten-v2/index.html'), /klx-softphone\.js/, 'softphone geladen op de klanten-v2-pagina');
});
