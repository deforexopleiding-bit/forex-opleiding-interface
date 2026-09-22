// tests/support-module.test.js
//
// Tests voor de supportmodule. Drie soorten:
//   1. De CORS-allowlist — een beveiligingsgrens, dus die moet vastliggen.
//   2. De beschikbaarheidslogica — pure functie, injecteerbare `nu`.
//   3. Het botmandaat — idem, en dit is waar de bot wel of niet zelf praat.
//   4. Schil-registratie — structuurtest zoals iris-schil-registratie.test.js:
//      een view die zich alleen in DFO.VIEWS meldt maar niet in MODS staat,
//      geeft een stille blanco module. Dat is hier al eens misgegaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSupportOrigin, isToegestaanOrigin } from '../api/_lib/support-cors.js';
import { bepaalBeschikbaarheid, naarOfficeHoursConfig } from '../api/_lib/support-beschikbaarheid.js';
import { beslisAntwoord, INTENTS, VERIFICATIE_ONDERWERPEN } from '../api/_lib/support-bot-core.js';

/* ── 1. CORS ──────────────────────────────────────────────────────────── */

test('CORS laat de eigen domeinen door', () => {
  for (const o of [
    'https://www.deforexopleiding.nl',
    'https://deforexopleiding.nl',
    'https://crm.deforexopleiding.nl',
    'https://lms.deforexopleiding.nl',
  ]) {
    assert.equal(resolveSupportOrigin(o), o, o + ' moet toegestaan zijn');
    assert.equal(isToegestaanOrigin(o), true);
  }
});

test('CORS laat een preview van het eigen websiteproject door', () => {
  const o = 'https://dfo-website-git-feature-x-de-forex-opleiding-bv-s-projects.vercel.app';
  assert.equal(resolveSupportOrigin(o), o);
});

test('CORS weigert alles daarbuiten', () => {
  const geweigerd = [
    'https://evil.com',
    'http://www.deforexopleiding.nl',                       // geen https
    'https://www.deforexopleiding.nl.evil.com',             // suffix-truc
    'https://dfo-website-x.vercel.app',                     // zonder team-slug
    'https://dfo-website-git-x-iemand-anders.vercel.app',   // ander team
    '',
    undefined,
    null,
  ];
  for (const o of geweigerd) {
    assert.notEqual(resolveSupportOrigin(o), o, String(o) + ' mag NIET gereflecteerd worden');
    assert.equal(resolveSupportOrigin(o), 'https://www.deforexopleiding.nl');
  }
});

/* ── 2. Beschikbaarheid ───────────────────────────────────────────────── */

const UREN = { tz: 'Europe/Amsterdam', dagen: [1, 2, 3, 4, 5], start: '09:00', eind: '17:30' };
const vers = (nu) => [{ beschikbaar: true, bijgewerkt_op: nu.toISOString() }];

test('kantooruren-config wordt naar de juiste sleutels vertaald', () => {
  // Cruciaal: parseOfficeHoursConfig is fail-open en valt bij verkeerde
  // sleutels stil terug op 7 dagen 08:00-20:00. Een verkeerde vertaling
  // levert dus geen fout op maar een verkeerde belofte.
  const c = naarOfficeHoursConfig(UREN);
  assert.equal(c.start, '09:00');
  assert.equal(c.end, '17:30');
  assert.deepEqual(c.days, [1, 2, 3, 4, 5]);
});

test('live binnen kantooruren met een verse hartslag', () => {
  const nu = new Date('2026-09-22T10:00:00Z');   // dinsdag 12:00 lokaal
  const r = bepaalBeschikbaarheid({ urenConfig: UREN, aanwezigen: vers(nu), nu });
  assert.equal(r.live, true);
  assert.equal(r.reden, 'live');
});

test('niet live bij een verlopen hartslag', () => {
  const nu = new Date('2026-09-22T10:00:00Z');
  const oud = [{ beschikbaar: true, bijgewerkt_op: new Date(nu.getTime() - 10 * 60_000).toISOString() }];
  const r = bepaalBeschikbaarheid({ urenConfig: UREN, aanwezigen: oud, nu });
  assert.equal(r.live, false);
  assert.equal(r.reden, 'niemand_online');
});

test('niet live buiten kantooruren, ook met iemand online', () => {
  const nu = new Date('2026-09-22T19:00:00Z');   // dinsdag 21:00 lokaal
  const r = bepaalBeschikbaarheid({ urenConfig: UREN, aanwezigen: vers(nu), nu });
  assert.equal(r.live, false);
  assert.equal(r.reden, 'buiten_kantooruren');
});

test('niet live in het weekend', () => {
  const nu = new Date('2026-09-20T10:00:00Z');   // zondag
  const r = bepaalBeschikbaarheid({ urenConfig: UREN, aanwezigen: vers(nu), nu });
  assert.equal(r.live, false);
});

test('onleesbare tijdzone geeft niet-live in plaats van een crash', () => {
  const nu = new Date('2026-09-22T10:00:00Z');
  const r = bepaalBeschikbaarheid({ urenConfig: { tz: 'Mars/Olympus', dagen: [1], start: 'zz', eind: 'qq' }, aanwezigen: vers(nu), nu });
  assert.equal(typeof r.live, 'boolean');
});

/* ── 3. Botmandaat ────────────────────────────────────────────────────── */

const CONFIG = {
  autonomy_config: {
    intents: {
      lms_toegang: { enabled: true, min_confidence: 0.7 },
      discord: { enabled: true, min_confidence: 0.7 },
      financieel: { enabled: false, min_confidence: 0.9 },
      informatie: { enabled: true, min_confidence: 0.6 },
    },
  },
  feature_flags: { s3_buiten_kantooruren: false },
};
const BINNEN = { binnen_kantooruren: true, live: true };
const BUITEN = { binnen_kantooruren: false, live: false };
const GESPREK = { onderwerp: 'lms', geverifieerd: true };

test('binnen mandaat: versturen zonder escalatie', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'Hier is je antwoord.', intent: 'lms_toegang', vertrouwen: 0.9, naar_mens: false },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN,
  });
  assert.equal(r.versturen, true);
  assert.equal(r.escaleren, false);
});

test('het model mag zelf om een mens vragen', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'Ik pak er een collega bij.', intent: 'lms_toegang', vertrouwen: 0.99, naar_mens: true },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN,
  });
  assert.equal(r.escaleren, true);
  assert.equal(r.reden, 'model_escaleert');
});

test('escalatie-intent gaat altijd naar een mens', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'x', intent: 'escalatie', vertrouwen: 1, naar_mens: false },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN,
  });
  assert.equal(r.escaleren, true);
  assert.equal(r.reden, 'intent_escalatie');
});

test('een uitgezet onderwerp wordt niet beantwoord', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'Ik regel je betalingsregeling.', intent: 'financieel', vertrouwen: 0.99, naar_mens: false },
    config: CONFIG, gesprek: { onderwerp: 'financieel', geverifieerd: true }, beschikbaarheid: BINNEN,
  });
  assert.equal(r.versturen, false);
  assert.equal(r.escaleren, true);
  assert.equal(r.reden, 'intent_uit');
});

test('te laag vertrouwen wordt niet verstuurd', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'Ik denk dat…', intent: 'lms_toegang', vertrouwen: 0.4, naar_mens: false },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN,
  });
  assert.equal(r.versturen, false);
  assert.equal(r.reden, 'laag_vertrouwen');
});

test('buiten kantooruren escaleert de bot standaard', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'ok', intent: 'lms_toegang', vertrouwen: 0.95, naar_mens: false },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BUITEN,
  });
  assert.equal(r.escaleren, true);
  assert.equal(r.reden, 'buiten_kantooruren');
});

test('met de vlag aan mag de bot buiten kantooruren wel door', () => {
  const cfg = { ...CONFIG, feature_flags: { s3_buiten_kantooruren: true } };
  const r = beslisAntwoord({
    model: { antwoord: 'ok', intent: 'lms_toegang', vertrouwen: 0.95, naar_mens: false },
    config: cfg, gesprek: GESPREK, beschikbaarheid: BUITEN,
  });
  assert.equal(r.escaleren, false);
});

test('persoonlijk onderwerp zonder verificatie levert geen inhoudelijk antwoord', () => {
  for (const onderwerp of VERIFICATIE_ONDERWERPEN) {
    const cfg = {
      ...CONFIG,
      autonomy_config: { intents: { ...CONFIG.autonomy_config.intents, traject: { enabled: true, min_confidence: 0.5 } } },
    };
    const r = beslisAntwoord({
      model: { antwoord: 'x', intent: 'lms_toegang', vertrouwen: 0.95, naar_mens: false },
      config: cfg, gesprek: { onderwerp, geverifieerd: false }, beschikbaarheid: BINNEN,
    });
    assert.equal(r.reden, 'verificatie_nodig', onderwerp + ' moet verificatie eisen');
  }
});

test('een leeg modelantwoord escaleert in plaats van een lege chatbubbel', () => {
  for (const model of [null, {}, { antwoord: '   ', intent: 'lms_toegang', vertrouwen: 1 }]) {
    const r = beslisAntwoord({ model, config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN });
    assert.equal(r.versturen, false);
    assert.equal(r.escaleren, true);
  }
});

test('een onbekende intent valt terug op overig en wordt niet verstuurd', () => {
  const r = beslisAntwoord({
    model: { antwoord: 'x', intent: 'iets_verzonnen', vertrouwen: 1, naar_mens: false },
    config: CONFIG, gesprek: GESPREK, beschikbaarheid: BINNEN,
  });
  assert.equal(r.reden, 'intent_uit');
});

/* ── 4. Schil-registratie ─────────────────────────────────────────────── */

test('support staat in MODS, in index.html en in de allowlist', () => {
  const shell = readFileSync(new URL('../modules/shared/design-system/app-shell.js', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
  const kv2 = readFileSync(new URL('../modules/klanten-v2/klanten-v2.js', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../modules/klanten-v2/views/support-v2.js', import.meta.url), 'utf8');

  assert.match(shell, /id: 'support'/, 'MODS-regel ontbreekt — goMod() doet dan een stille return');
  assert.match(index, /views\/support-v2\.js/, 'script-tag ontbreekt in index.html');
  assert.match(kv2, /'support'/, 'support ontbreekt in V2_ACTIVE_ALLOWLIST');

  // Elke tab uit MODS moet een geregistreerde view hebben, anders is het
  // tabblad leeg zonder enige fout in de console.
  const tabs = shell.match(/id: 'support'[\s\S]*?tabs: \[([^\]]*)\]/)[1]
    .split(',').map((t) => t.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.ok(tabs.length >= 1);
  for (const tab of tabs) {
    assert.ok(view.includes(`VIEWS['support/${tab}']`), `view voor tab "${tab}" ontbreekt`);
  }
});

test('de rechten staan in beide kopieën van het RBAC-register', () => {
  const reg = readFileSync(new URL('../modules/shared/rbac/registry.js', import.meta.url), 'utf8');
  const adm = readFileSync(new URL('../modules/admin.html', import.meta.url), 'utf8');
  for (const key of ['support.module.access', 'support.reply', 'support.assign', 'support.actie.besluit', 'support.config']) {
    assert.ok(reg.includes(key), key + ' ontbreekt in rbac/registry.js');
    assert.ok(adm.includes(key), key + ' ontbreekt in admin.html');
  }
});

test('de migratie dekt alle tabellen en rechten die de code gebruikt', () => {
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-09-22-support-module-fundament.sql', import.meta.url), 'utf8');
  for (const t of ['support_gesprekken', 'support_berichten', 'support_verificaties', 'support_aanwezigheid', 'support_acties']) {
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.' + t), t + ' ontbreekt in de migratie');
    assert.match(sql, new RegExp('ALTER TABLE public\\.' + t + '\\s+ENABLE ROW LEVEL SECURITY'), t + ' heeft geen RLS');
  }
  // Nooit USING (true) — zie docs/rls-regels-nieuwe-tabellen.md.
  assert.ok(!/USING\s*\(\s*true\s*\)/i.test(sql), 'de migratie bevat een kale USING (true)-policy');
  assert.ok(sql.includes('is_crm_staff()'), 'de policies gebruiken geen rolcheck');
});

test('INTENTS en de databaseconfig kennen dezelfde intents', () => {
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-09-22-support-module-fundament.sql', import.meta.url), 'utf8');
  for (const i of INTENTS) {
    assert.ok(sql.includes(`"${i}"`), `intent ${i} ontbreekt in de seed van joost_config`);
  }
});
