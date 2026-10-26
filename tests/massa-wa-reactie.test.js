// tests/massa-wa-reactie.test.js
//
// Massa-WhatsApp: reactie op de knoppen ("Ja, stuur maar" / "Nu even niet").
//   1. puur: herkenReactie, vulVervolg, valideerVervolg, planWhatsApp 'nu_niet';
//   2. verwerkMassaReactie: ja → vervolg met voornaam + link (één keer),
//      nee → afsluiting + leads.wa_nu_niet_op, stop → alleen markeren,
//      buiten 24 uur / geen tekst / onbekende wamid / geen migratie;
//   3. tellingPerKanaal: ja / nee / geen reactie;
//   4. bedrading: webhook-hook, SQL, cache-buster.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

mock.module(url('api/supabase.js'), { namedExports: { supabase: null, supabaseAdmin: null, createUserClient: () => null, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async () => ({ ok: true }), sluitSmtpPools: () => {} } });
mock.module(url('api/_lib/inbox-categorie.js'), { namedExports: { bepaalCategorieen: async () => new Map() } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: { haalLijn: async () => ({ phoneNumberId: '1' }), mailAfzender: () => 'welkom@deforexopleiding.nl' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendText: async () => { throw new Error('niet de echte sendText gebruiken in tests'); },
  sendTemplate: async () => ({}), templateStatusOpLijn: async () => null, goedgekeurdeTemplatesOpLijn: async () => null,
} });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const R = await import(url('api/_lib/massa-wa-reactie.js'));
const M = await import(url('api/_lib/massa-mail.js'));

// ── Mini nep-database (select/update + eq/is/not, maybeSingle, count/head) ──
function nepDb(tab, { fout = null } = {}) {
  const db = { tab, updates: [] };
  db.from = (t) => {
    const f = []; let op = 'select'; let patch = null; let terug = false; let enkel = false; let head = false;
    const k = {
      select: (_c, o) => { if (op === 'update') terug = true; if (o && o.head) head = true; return k; },
      update: (p) => { op = 'update'; patch = p; return k; },
      eq: (c, v) => { f.push((r) => r[c] === v); return k; },
      is: (c, v) => { f.push((r) => (v === null ? r[c] == null : r[c] === v)); return k; },
      not: (c, o, v) => { if (o === 'is' && v === null) f.push((r) => r[c] != null); return k; },
      in: (c, v) => { f.push((r) => v.includes(r[c])); return k; },
      maybeSingle: () => { enkel = true; return k; },
      then: (ok, nok) => {
        let res;
        if (fout && fout(t, op)) res = { data: null, error: fout(t, op) };
        else {
          const rijen = tab[t] || [];
          const sel = rijen.filter((r) => f.every((x) => x(r)));
          if (op === 'update') { for (const r of sel) Object.assign(r, patch); db.updates.push({ t, patch }); res = { data: terug ? sel.map((r) => ({ ...r })) : null, error: null }; }
          else if (head) res = { data: null, count: sel.length, error: null };
          else res = { data: enkel ? (sel[0] ? { ...sel[0] } : null) : sel.map((r) => ({ ...r })), error: null };
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  };
  return db;
}

const NU = new Date('2026-10-26T10:00:00Z');
const basis = () => ({
  massa_campagnes: [{ id: 'c1', wa_vervolg_ja: 'Top, {{voornaam}}! Hier is alles over het gratis webinar: {{link}} Tot dan!', wa_vervolg_ja_link: 'https://deforexopleiding.nl/webinar', wa_vervolg_nee: 'Helemaal goed, {{voornaam}}. We sturen je hierover niets meer.' }],
  massa_items: [
    { id: 'i1', campagne_id: 'c1', lead_id: 'l1', kanaal: 'whatsapp', extern_id: 'wamid.T1', status: 'sent', reactie: null },
    { id: 'i2', campagne_id: 'c1', lead_id: 'l2', kanaal: 'whatsapp', extern_id: 'wamid.T2', status: 'sent', reactie: null },
    { id: 'i3', campagne_id: 'c1', lead_id: 'l3', kanaal: 'whatsapp', extern_id: 'wamid.T3', status: 'sent', reactie: null },
  ],
  leads: [{ id: 'l1', voornaam: 'Robby van Dijk', wa_nu_niet_op: null }, { id: 'l2', voornaam: '', wa_nu_niet_op: null }, { id: 'l3', voornaam: 'Sam', wa_nu_niet_op: null }],
});
function spionnen() {
  const s = { verzonden: [], gelogd: [] };
  s.opts = {
    nu: NU,
    verstuur: async (a) => { s.verzonden.push(a); return { wamid: 'wamid.V' + s.verzonden.length }; },
    log: async (_sb, a) => { s.gelogd.push(a); return { ok: true }; },
  };
  return s;
}
const reactie = (wamid, tekst, extra = {}) => ({ contextWamid: wamid, tekst, payload: tekst, telefoon: '+31612345678', phoneNumberId: '1273723375834177', ontvangenOp: new Date(NU.getTime() - 60 * 1000), ...extra });

test('herkenReactie + vulVervolg', () => {
  assert.equal(R.herkenReactie('Ja, stuur maar'), 'ja');
  assert.equal(R.herkenReactie('ja graag!'), 'ja');
  assert.equal(R.herkenReactie('Nu even niet'), 'nee');
  assert.equal(R.herkenReactie('Nee'), 'nee');
  assert.equal(R.herkenReactie('Stop promoties'), 'stop');
  assert.equal(R.herkenReactie('Ja, vertel me meer'), 'ja');
  assert.equal(R.herkenReactie('Wat kost het?'), null, 'onbekend → aan de inbox laten');
  assert.equal(R.herkenReactie(null, 'Nu even niet'), 'nee', 'payload leeg → tekst');
  assert.equal(R.vulVervolg('Top, {{voornaam}}! Link: {{link}}', { voornaam: 'Robby van Dijk', link: 'https://x.nl/w' }), 'Top, Robby! Link: https://x.nl/w');
  assert.equal(R.vulVervolg('Top, {{voornaam}}! Tot dan.', { voornaam: '' }), 'Top! Tot dan.');
  assert.equal(R.vulVervolg('Helemaal goed, {{ voornaam }}. Fijne dag!', {}), 'Helemaal goed. Fijne dag!');
  assert.match(R.STANDAARD_VERVOLG_JA, /\{\{voornaam\}\}.*\{\{link\}\}/);
});

test('valideerVervolg + planWhatsApp slaat "nu niet" over', () => {
  const fout = (b) => { try { M.valideerVervolg(b); return null; } catch (e) { return e.code; } };
  assert.deepEqual(M.valideerVervolg({}), { ja: null, link: null, nee: null });
  assert.deepEqual(M.valideerVervolg({ wa_vervolg_ja: ' Hoi {{voornaam}}: {{link}} ', wa_vervolg_ja_link: 'https://x.nl/w', wa_vervolg_nee: 'Ok' }), { ja: 'Hoi {{voornaam}}: {{link}}', link: 'https://x.nl/w', nee: 'Ok' });
  assert.equal(fout({ wa_vervolg_ja: 'Hier: {{link}}' }), 'VERVOLG_LINK_LEEG');
  assert.equal(fout({ wa_vervolg_ja: 'x', wa_vervolg_ja_link: 'http://x.nl' }), 'VERVOLG_LINK_ONGELDIG', 'alleen https');
  assert.equal(fout({ wa_vervolg_ja: 'Hoi {{naam}}' }), 'VERVOLG_ONBEKENDE_VARIABELE');
  assert.equal(fout({ wa_vervolg_nee: 'Zie {{link}}' }), 'VERVOLG_ONBEKENDE_VARIABELE', 'geen link in de afsluiting');
  assert.equal(fout({ wa_vervolg_ja: 'x'.repeat(1001) }), 'VERVOLG_TE_LANG');
  const v = M.valideerCampagne({ naam: 'Okt', kanaal: 'whatsapp', wa_template: 'massa_aanbod', wa_vervolg_ja: 'Ja! {{link}}', wa_vervolg_ja_link: 'https://x.nl/w' });
  assert.deepEqual(v.wa.vervolg, { ja: 'Ja! {{link}}', link: 'https://x.nl/w', nee: null });
  const p = M.planWhatsApp([{ id: 'a', telefoon_e164: '+31612345678', wa_nu_niet: true }, { id: 'b', telefoon_e164: '+31612345679' }]);
  assert.deepEqual(p.verzenden.map((l) => l.id), ['b']);
  assert.deepEqual(p.redenen, { nu_niet: 1 });
});

test('"Ja, stuur maar" → vervolg met voornaam + link, precies één keer', async () => {
  const db = nepDb(basis());
  const s = spionnen();
  const r = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar'), s.opts);
  assert.deepEqual(r, { verwerkt: true, reactie: 'ja', vervolg_status: 'verstuurd' });
  assert.equal(s.verzonden.length, 1);
  assert.deepEqual(s.verzonden[0], { to: '+31612345678', body: 'Top, Robby! Hier is alles over het gratis webinar: https://deforexopleiding.nl/webinar Tot dan!', phoneNumberId: '1273723375834177' });
  assert.equal(s.gelogd[0].source, 'massa-vervolg');
  assert.equal(s.gelogd[0].wamid, 'wamid.V1');
  const it = db.tab.massa_items[0];
  assert.equal(it.reactie, 'ja');
  assert.equal(it.reactie_op, NU.toISOString());
  assert.equal(it.vervolg_status, 'verstuurd');
  assert.equal(db.tab.leads[0].wa_nu_niet_op, null, '"ja" markeert niet als nu-niet');
  // Tweede klik (of Meta-retry): niets opnieuw.
  const r2 = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar'), s.opts);
  assert.equal(r2.verwerkt, false);
  assert.equal(r2.reden, 'al_gereageerd');
  // Ook niet na eerst "ja" en dan "nu even niet".
  const r3 = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Nu even niet'), s.opts);
  assert.equal(r3.reden, 'al_gereageerd');
  assert.equal(s.verzonden.length, 1);
});

test('"Nu even niet" → afsluiting + lead gemarkeerd; stop → alleen markeren', async () => {
  const db = nepDb(basis());
  const s = spionnen();
  const r = await R.verwerkMassaReactie(db, reactie('wamid.T2', 'Nu even niet'), s.opts);
  assert.deepEqual(r, { verwerkt: true, reactie: 'nee', vervolg_status: 'verstuurd' });
  assert.equal(s.verzonden[0].body, 'Helemaal goed. We sturen je hierover niets meer.', 'zonder voornaam netjes');
  assert.equal(db.tab.leads[1].wa_nu_niet_op, NU.toISOString());
  const r2 = await R.verwerkMassaReactie(db, reactie('wamid.T3', 'Stop promoties'), s.opts);
  assert.deepEqual(r2, { verwerkt: true, reactie: 'stop', vervolg_status: 'geen_tekst' });
  assert.equal(s.verzonden.length, 1, 'na stop sturen we niets');
  assert.equal(db.tab.leads[2].wa_nu_niet_op, NU.toISOString());
});

test('buiten 24 uur, geen tekst, onbekende knop/wamid, geen migratie, verzendfout', async () => {
  // Buiten het venster: wel gelogd, niets verstuurd.
  let db = nepDb(basis()); let s = spionnen();
  let r = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar', { ontvangenOp: new Date(NU.getTime() - 25 * 3600 * 1000) }), s.opts);
  assert.deepEqual(r, { verwerkt: true, reactie: 'ja', vervolg_status: 'buiten_venster' });
  assert.equal(s.verzonden.length, 0);
  // Campagne zonder vervolgtekst (of {{link}} zonder link): alleen loggen.
  const t = basis(); t.massa_campagnes[0].wa_vervolg_ja = null; t.massa_campagnes[0].wa_vervolg_nee = 'Hier: {{link}}'; t.massa_campagnes[0].wa_vervolg_ja_link = null;
  db = nepDb(t); s = spionnen();
  r = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar'), s.opts);
  assert.equal(r.vervolg_status, 'geen_tekst');
  assert.equal(db.tab.massa_items[0].reactie, 'ja', 'reactie wel gelogd');
  r = await R.verwerkMassaReactie(db, reactie('wamid.T2', 'Nu even niet'), s.opts);
  assert.equal(r.vervolg_status, 'geen_tekst');
  assert.equal(s.verzonden.length, 0);
  // Onbekende knop / geen massa-bericht / geen context.
  db = nepDb(basis()); s = spionnen();
  assert.equal((await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Wat kost het?'), s.opts)).reden, 'onbekende_knop');
  assert.equal((await R.verwerkMassaReactie(db, reactie('wamid.ANDERS', 'Ja, stuur maar'), s.opts)).reden, 'geen_massa_bericht');
  assert.equal((await R.verwerkMassaReactie(db, reactie('', 'Ja, stuur maar'), s.opts)).reden, 'geen_context');
  assert.equal(db.updates.length, 0);
  // Migratie nog niet gedraaid: niets, geen crash.
  db = nepDb(basis(), { fout: (t) => (t === 'massa_items' ? { code: '42703', message: 'column massa_items.reactie does not exist' } : null) });
  assert.equal((await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar'), s.opts)).reden, 'migratie_nodig');
  // Verzendfout: status mislukt + fout, gooit niet.
  db = nepDb(basis());
  r = await R.verwerkMassaReactie(db, reactie('wamid.T1', 'Ja, stuur maar'), { nu: NU, verstuur: async () => { throw new Error('Meta 131047'); }, log: async () => ({}) });
  assert.deepEqual(r, { verwerkt: true, reactie: 'ja', vervolg_status: 'mislukt' });
  assert.equal(db.tab.massa_items[0].vervolg_fout, 'Meta 131047');
});

test('tellingPerKanaal: reacties ja / nee / geen reactie', async () => {
  const t = basis();
  t.massa_items[0].reactie = 'ja'; t.massa_items[0].vervolg_status = 'verstuurd';
  t.massa_items[1].reactie = 'nee';
  const uit = await M.tellingPerKanaal(nepDb(t), 'c1');
  assert.equal(uit.whatsapp.sent, 3);
  assert.deepEqual(uit.whatsapp.reacties, { ja: 1, nee: 1, stop: 0, geen: 1, vervolg_verstuurd: 1 });
});

test('bedrading: webhook-hook, SQL, popup + cache-buster', () => {
  const wh = lees('api/inbox-webhook.js');
  assert.match(wh, /import \{ verwerkMassaReactie \} from '\.\/_lib\/massa-wa-reactie\.js'/);
  assert.match(wh, /\(msg\.type === 'button' \|\| msg\.type === 'interactive'\) && msg\.context\?\.id/);
  assert.match(wh, /contextWamid: msg\.context\.id/);
  const sql = lees('docs/sql-migrations/2026-10-26-massa-wa-reacties.sql');
  for (const k of ['wa_vervolg_ja text', 'wa_vervolg_ja_link text', 'wa_vervolg_nee text', 'reactie text', 'reactie_op timestamptz', 'vervolg_status text', 'wa_nu_niet_op timestamptz']) assert.match(sql, new RegExp('ADD COLUMN IF NOT EXISTS ' + k));
  assert.match(sql, /CHECK \(reactie IS NULL OR reactie IN \('ja', 'nee', 'stop'\)\)/);
  assert.doesNotMatch(sql, /\bDO \$\$/);
  assert.equal(M.MIGRATIE_REACTIES, '2026-10-26-massa-wa-reacties.sql');
  const pop = lees('modules/klanten-v2/views/_massa-bericht.js');
  assert.match(pop, /data-mb-b="wa_vervolg_ja_link"/);
  assert.match(pop, /nu_niet:/);
  assert.ok(Number((lees('modules/klanten-v2/index.html').match(/views\/_massa-bericht\.js\?v=(\d+)"/) || [])[1]) >= 5);
});
