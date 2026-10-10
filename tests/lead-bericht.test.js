// tests/lead-bericht.test.js
//
// "Stuur bericht" fase 1 (2026-10-09): 1-op-1 WhatsApp-template of e-mail naar
// een lead vanuit Leads / Leadsonderhoud → Contacten.
//   1. puur: variabelen, voorstel per template, opschonen, platte tekst, shell;
//   2. WhatsApp: validatie (nummer, goedgekeurd, variabelen), versturen via
//      sendTemplate op de lead-lijn, in de draad via logOutboundWa;
//   3. e-mail: validatie, welkom@ + huisstijl, ingevulde (ge-escapete) variabelen,
//      in de draad via email_replies met exact de kolommen die de draad leest;
//   4. sjablonen-validatie, popup-helpers, bedrading + cache-busters.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const LIJN = '1273723375834177';
const afgegeven = { wa: [], waLog: [], mails: [], live: null };
mock.module(url('api/supabase.js'), { namedExports: { supabase: null, supabaseAdmin: null, createUserClient: () => null, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/meta-whatsapp.js'), {
  namedExports: {
    sendTemplate: async (a) => { afgegeven.wa.push(a); return { wamid: 'wamid.1' }; },
    templateStatusOpLijn: async () => 'PENDING',
    goedgekeurdeTemplatesOpLijn: async () => afgegeven.live,
  },
});
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async (_sb, a) => { afgegeven.waLog.push(a); return { ok: true, conv_id: 'conv-1' }; } } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { afgegeven.mails.push(m); return { ok: true, messageId: '<m1@x>' }; } } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), {
  namedExports: {
    haalLijn: async () => ({ module: 'leadsonderhoud', phoneNumberId: LIJN, label: 'Esmee (360dialog)' }),
    mailAfzender: () => 'welkom@deforexopleiding.nl',
  },
});

const L = await import(url('api/_lib/lead-bericht.js'));
const S = await import(url('api/_lib/mail-shell-lead.js'));
const { valideerSjabloon } = await import(url('api/lead-mail-sjablonen.js'));

const LEAD = { id: 'lead-1', voornaam: 'Robby', achternaam: 'Hugens', email: 'Robby@Example.com', telefoon_e164: '+32470000077', traject: 'minicursus' };
const LIVE = {
  ok: true, waba_id: '2579784712469452',
  templates: [
    { name: 'followup_2_druk', language: 'nl', category: 'UTILITY', body: 'Hey {{1}}, ik denk dat je erg druk bent 😊', aantal_vars: 1, header_format: null, header_heeft_var: false, footer: null, knoppen: [] },
    { name: 'vraag_6_agenda', language: 'nl', category: 'UTILITY', body: 'Super! Kijk hier is mijn agenda.', aantal_vars: 0, header_format: null, header_heeft_var: false, footer: null, knoppen: [] },
    { name: 'met_foto', language: 'nl', category: 'MARKETING', body: 'Kijk {{1}}', aantal_vars: 1, header_format: 'IMAGE', header_heeft_var: false, footer: null, knoppen: [] },
  ],
};
function nepDb() {
  const inserts = [];
  return {
    inserts,
    from(t) {
      return {
        insert: async (rij) => { inserts.push({ t, rij }); return { error: null }; },
        select: () => ({ in: () => ({ order: async () => ({ data: [], error: null }) }) }),
      };
    },
  };
}
function reset() { afgegeven.wa.length = 0; afgegeven.waLog.length = 0; afgegeven.mails.length = 0; afgegeven.live = LIVE; }

// ── 1. Puur ──────────────────────────────────────────────────────────────────
test('variabelen + voorstel per template (voornaam automatisch, rest handmatig)', () => {
  const v = L.leadVariabelen(LEAD, { boekingslink: '' });
  assert.deepEqual(v, { voornaam: 'Robby', achternaam: 'Hugens', naam: 'Robby Hugens', email: 'robby@example.com', boekingslink: L.STANDAARD_BOEKINGSLINK });
  assert.deepEqual(L.waVariabelenVoorstel({ aantal_vars: 1, body: 'Ben je bekend met traden {{1}}?' }, v), [{ pos: 1, label: 'Voornaam', waarde: 'Robby', auto: true }]);
  const twee = L.waVariabelenVoorstel({ aantal_vars: 2, body: 'Hoi {{1}}, je afspraak is {{2}}.' }, v);
  assert.deepEqual(twee.map((x) => [x.auto, x.waarde]), [[true, 'Robby'], [false, '']]);
  const map = L.waVariabelenVoorstel({ aantal_vars: 2, body: '{{1}} en {{2}}' }, v, { 1: 'lead.gesprek_tijd', 2: 'lead.voornaam' });
  assert.deepEqual(map.map((x) => [x.label, x.auto, x.waarde]), [['gesprek tijd', false, ''], ['Voornaam', true, 'Robby']]);
  assert.equal(L.renderWaTekst('Hey {{1}}, {{2}}', ['Robby']), 'Hey Robby, {{2}}');
  assert.equal(L.waVerstuurbaar(LIVE.templates[2]).ok, false);
  assert.equal(L.waVerstuurbaar(LIVE.templates[0]).ok, true);
});

test('schoonHtml: alleen veilige tags, geen scripts/handlers, veilige href', () => {
  const vies = '<p onclick="x()">Hoi <b>{{voornaam}}</b><script>alert(1)</script></p><img src=x onerror=y><a href="javascript:alert(1)">kwaad</a><a href="https://deforexopleiding.nl" target="_blank">site</a><a href="{{boekingslink}}">boek</a><style>p{}</style><ul><li>één</li></ul><iframe src="x"></iframe>';
  const s = L.schoonHtml(vies);
  assert.equal(s, '<p>Hoi <b>{{voornaam}}</b></p><a>kwaad</a><a href="https://deforexopleiding.nl" style="color:#10284A;text-decoration:underline">site</a><a href="{{boekingslink}}" style="color:#10284A;text-decoration:underline">boek</a><ul><li>één</li></ul>');
  assert.deepEqual(L.onbekendeVariabelen('Hoi {{voornaam}} {{ factuur }} {{boekingslink}} {{x}}'), ['factuur', 'x']);
  assert.equal(L.vulMailVariabelen('<p>{{voornaam}}</p>', { voornaam: '<Robby>' }, { html: true }), '<p>&lt;Robby&gt;</p>');
  assert.equal(S.htmlNaarTekst('<p>Hoi <b>Robby</b></p><ul><li>een</li><li>twee</li></ul><a href="https://x.nl">boek</a>'), 'Hoi Robby\n\n• een\n• twee\n\nboek (https://x.nl)');
  const shell = S.renderLeadMail({ bodyHtml: '<p>Hallo</p>' });
  assert.match(shell, /<p style="margin:0 0 12px;[^"]*">Hallo<\/p>/);
  assert.match(shell, /dfo-logo-email\.png/);
  assert.match(shell, /Met vriendelijke groet,<br><br>Team - De Forex Opleiding/);
});

// ── 2. WhatsApp ──────────────────────────────────────────────────────────────
test('WA: live templates van de lead-WABA met voorstel; mapping uit de CRM-tabel alleen voor de variabelen', async () => {
  reset();
  const r = await L.waTemplatesVoorLead(nepDb(), LEAD, L.leadVariabelen(LEAD));
  assert.equal(r.ok, true);
  assert.equal(r.waba_id, '2579784712469452');
  assert.equal(r.phone_number_id, LIJN);
  assert.deepEqual(r.templates.map((t) => [t.name, t.verstuurbaar.ok]), [['followup_2_druk', true], ['vraag_6_agenda', true], ['met_foto', false]]);
  assert.equal(r.templates[0].variabelen[0].waarde, 'Robby');
});

test('WA: versturen via de lead-lijn, in de draad via logOutboundWa, berichten_log', async () => {
  reset();
  const db = nepDb();
  const r = await L.verstuurWaTemplate(db, { lead: LEAD, templateNaam: 'followup_2_druk', variabelen: ['Robby'], agent: 'romy@x' });
  assert.deepEqual(r, { ok: true, wamid: 'wamid.1', conversation_id: 'conv-1', in_draad: true });
  assert.deepEqual(afgegeven.wa[0], { to: '32470000077', templateName: 'followup_2_druk', languageCode: 'nl', variables: ['Robby'], phoneNumberId: LIJN });
  assert.equal(afgegeven.waLog[0].toPhone, '+32470000077');
  assert.equal(afgegeven.waLog[0].phoneNumberId, LIJN);
  assert.equal(afgegeven.waLog[0].body, 'Hey Robby, ik denk dat je erg druk bent 😊');
  assert.equal(afgegeven.waLog[0].templateName, 'followup_2_druk');
  assert.deepEqual(db.inserts[0], { t: 'berichten_log', rij: { lead_id: 'lead-1', traject: 'minicursus', soort: 'handmatig-template', kanaal: 'whatsapp', naar: '+32470000077', agent: 'romy@x', status: 'ok', verstuurd_op: db.inserts[0].rij.verstuurd_op, extern_id: 'wamid.1' } });
});

test('WA: geen geldig nummer / niet goedgekeurd / lege variabele / media-kop → nette fout, niets verstuurd', async () => {
  reset();
  const fout = async (opts) => { try { await L.verstuurWaTemplate(nepDb(), opts); return null; } catch (e) { return [e.status, e.code, e.message]; } };
  assert.deepEqual((await fout({ lead: { ...LEAD, telefoon_e164: '0612' }, templateNaam: 'followup_2_druk', variabelen: ['x'] })).slice(0, 2), [409, 'GEEN_GELDIG_NUMMER']);
  const nietOk = await fout({ lead: LEAD, templateNaam: 'webinar_live', variabelen: ['x', 'y'] });
  assert.deepEqual(nietOk.slice(0, 2), [409, 'TEMPLATE_NIET_GOEDGEKEURD']);
  assert.match(nietOk[2], /PENDING/);
  assert.deepEqual((await fout({ lead: LEAD, templateNaam: 'followup_2_druk', variabelen: ['  '] })).slice(0, 2), [400, 'VARIABELE_LEEG']);
  assert.deepEqual((await fout({ lead: LEAD, templateNaam: 'followup_2_druk', variabelen: [] })).slice(0, 2), [400, 'VARIABELEN']);
  assert.deepEqual((await fout({ lead: LEAD, templateNaam: 'met_foto', variabelen: ['x'] })).slice(0, 2), [409, 'TEMPLATE_NIET_ONDERSTEUND']);
  afgegeven.live = { ok: false, reden: 'LIJST_NIET_OP_TE_HALEN' };
  assert.deepEqual((await fout({ lead: LEAD, templateNaam: 'followup_2_druk', variabelen: ['x'] })).slice(0, 2), [503, 'TEMPLATES_ONBEKEND']);
  assert.equal(afgegeven.wa.length, 0);
});

// ── 3. E-mail ────────────────────────────────────────────────────────────────
test('mail: welkom@, huisstijl, variabelen ingevuld + ge-escapet, in de draad via email_replies', async () => {
  reset();
  const db = nepDb();
  const r = await L.verstuurMail(db, {
    lead: { ...LEAD, voornaam: 'Rob<b>' }, onderwerp: 'Hoi {{voornaam}}', boekingslink: 'https://www.deforexopleiding.nl/agenda/romy',
    html: '<p>Hoi {{voornaam}},</p><p>Plan hier: <a href="{{boekingslink}}">mijn agenda</a></p><script>x</script>', userId: 'user-1',
  });
  assert.equal(r.ok, true);
  const m = afgegeven.mails[0];
  assert.equal(m.fromMailbox, 'welkom@deforexopleiding.nl');
  assert.equal(m.to, 'robby@example.com');
  assert.equal(m.subject, 'Hoi Rob<b>');
  assert.match(m.html, /lead-mailshell/);
  assert.match(m.html, /Hoi Rob&lt;b&gt;,/);
  assert.match(m.html, /<a href="https:\/\/www\.deforexopleiding\.nl\/agenda\/romy" style="[^"]*">mijn agenda<\/a>/);
  assert.doesNotMatch(m.html, /<script/);
  assert.match(m.text, /Met vriendelijke groet,\n\nTeam - De Forex Opleiding$/);
  // De draad (leadsonderhoud-gesprek-berichten) leest email_replies op
  // from_address ILIKE mailAfzender() en to_address = lead-e-mail.
  const er = db.inserts.find((i) => i.t === 'email_replies').rij;
  assert.equal(er.from_address, 'welkom@deforexopleiding.nl');
  assert.equal(er.to_address, 'robby@example.com');
  assert.equal(er.email_subject, 'Hoi Rob<b>');
  assert.match(er.final_reply, /^Hoi Rob<b>,/);
  assert.equal(er.sent_by_id, 'user-1');
  assert.ok(er.sent_at);
  const bl = db.inserts.find((i) => i.t === 'berichten_log').rij;
  assert.equal(bl.soort, 'handmatig-antwoord', 'draad slaat deze soort over → geen dubbele bubbel');
  const draad = lees('api/leadsonderhoud-gesprek-berichten.js');
  assert.match(draad, /\.from\('email_replies'\)[\s\S]{0,200}\.ilike\('from_address', mailAfzender\(\)\)/);
  assert.match(draad, /\.neq\('soort', 'handmatig-antwoord'\)/);
});

test('mail: geen geldig adres / leeg / onbekende variabele → nette fout, niets verstuurd', async () => {
  reset();
  const fout = async (opts) => { try { await L.verstuurMail(nepDb(), opts); return null; } catch (e) { return [e.status, e.code]; } };
  assert.deepEqual(await fout({ lead: { ...LEAD, email: 'geen' }, onderwerp: 'x', html: '<p>x</p>' }), [409, 'GEEN_GELDIG_EMAIL']);
  assert.deepEqual(await fout({ lead: LEAD, onderwerp: '', html: '<p>x</p>' }), [400, 'ONDERWERP_LEEG']);
  assert.deepEqual(await fout({ lead: LEAD, onderwerp: 'x', html: '<p> </p><script>y</script>' }), [400, 'BERICHT_LEEG']);
  assert.deepEqual(await fout({ lead: LEAD, onderwerp: 'x {{factuur}}', html: '<p>x</p>' }), [400, 'ONBEKENDE_VARIABELEN']);
  assert.equal(afgegeven.mails.length, 0);
});

// ── 4. Sjablonen, popup, bedrading ───────────────────────────────────────────
test('sjablonen: validatie (naam, onderwerp, inhoud, variabelen) en opschonen', () => {
  const ok = valideerSjabloon({ naam: ' Welkom ', onderwerp: 'Hoi {{voornaam}}', html: '<p onclick="x">Hoi</p><script>y</script>' });
  assert.deepEqual(ok, { ok: true, rij: { naam: 'Welkom', onderwerp: 'Hoi {{voornaam}}', html: '<p>Hoi</p>' } });
  assert.equal(valideerSjabloon({ naam: '', onderwerp: 'x', html: '<p>x</p>' }).ok, false);
  assert.equal(valideerSjabloon({ naam: 'a', onderwerp: '', html: '<p>x</p>' }).ok, false);
  assert.equal(valideerSjabloon({ naam: 'a', onderwerp: 'x', html: '<p></p>' }).ok, false);
  assert.match(valideerSjabloon({ naam: 'a', onderwerp: 'x', html: '<p>{{iets}}</p>' }).fout, /\{\{iets\}\}/);
});

test('popup-helpers: voorbeeld en knopstatus', () => {
  const win = {};
  const doc = { createElement: () => { const el = { _h: '' }; Object.defineProperty(el, 'innerHTML', { set(v) { this._h = v; }, get() { return this._h; } }); Object.defineProperty(el, 'textContent', { get() { return this._h.replace(/<[^>]+>/g, ''); } }); return el; } };
  new Function('window', 'document', lees('modules/klanten-v2/views/_stuur-bericht.js'))(win, doc);
  const H = win.StuurBericht._intern;
  assert.equal(H.renderWaTekst('Hey {{1}}!', ['Robby']), 'Hey Robby!');
  assert.deepEqual(H.onbekendeVars('{{voornaam}} {{iets}}'), ['iets']);
  const st = { data: { lead: { geldig_telefoon: true, geldig_email: true }, wa: { templates: [LIVE.templates[0]] } }, wa: { gekozen: 'followup_2_druk|nl', waarden: [''] }, mail: { onderwerp: 'x' } };
  LIVE.templates[0].verstuurbaar = { ok: true };
  assert.equal(H.waKnopStatus(st).uit, true);
  st.wa.waarden = ['Robby'];
  assert.equal(H.waKnopStatus(st).uit, false);
  st.data.lead.geldig_telefoon = false;
  assert.match(H.waKnopStatus(st).reden, /geen geldig telefoonnummer/);
  assert.equal(H.mailKnopStatus(st, '<p>Hoi</p>').uit, false);
  assert.match(H.mailKnopStatus(st, '<p>{{x}}</p>').reden, /Onbekende variabele/);
  st.data.lead.geldig_email = false;
  assert.match(H.mailKnopStatus(st, '<p>Hoi</p>').reden, /geen geldig e-mailadres/);
});

test('bedrading: knoppen in Leads + Contacten, script-tag, cache-busters, SQL met RLS', () => {
  assert.match(lees('modules/klanten-v2/views/leads-v2.js'), /window\.StuurBericht && window\.StuurBericht\.open\('\$\{esc\(l\.id \|\| ''\)\}'\)/);
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ls, /window\.StuurBericht && window\.StuurBericht\.open\('\$\{idForBtn\}', '\$\{nameForBtn\}'\)/);
  assert.match(ls, /\$\{berichtBtn\}\$\{inlogBtn\}/);
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /<script src="views\/_stuur-bericht\.js\?v=1"><\/script>/);
  const versie = (re) => Number((html.match(re) || [])[1] || 0);
  assert.ok(versie(/views\/leads-v2\.js\?v=(\d+)"/) >= 29, 'leads-v2 minstens v29');
  assert.ok(versie(/views\/leadsonderhoud-v2\.js\?v=(\d+)"/) >= 68, 'leadsonderhoud-v2 minstens v68');
  assert.ok(html.indexOf('views/_stuur-bericht.js') < html.indexOf('views/leads-v2.js'), 'popup vóór de views');
  const sql = lees('docs/sql-migrations/2026-10-09-lead-mail-sjablonen.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.lead_mail_sjablonen/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FOR ALL TO authenticated USING \(true\) WITH CHECK \(true\)/);
  assert.match(sql, /REVOKE ALL ON public\.lead_mail_sjablonen FROM anon/);
});

test('lead-modal: geen factuur-, onboarding- of interne templates (gedeelde WABA)', async () => {
  for (const n of ['aanmaning_dag7', 'meerdere_facturen_open_1', 'betaalherinnering_eerste_call', 'welkom_onboarding', 'interne_nieuwe_afspraak_nl', 'nieuwe_lead', 'opvolging_geen_reactie2']) {
    assert.equal(L.isLeadTemplate(n), false, n);
  }
  for (const n of ['followup_2_druk', 'vraag_6_agenda', 'webinar_bevestiging', 'nieuwe_lead_v2', 'afspraak_bevestiging_v1']) assert.equal(L.isLeadTemplate(n), true, n);
  reset();
  afgegeven.live = { ...LIVE, templates: [...LIVE.templates, { ...LIVE.templates[0], name: 'aanmaning_dag7' }] };
  const r = await L.waTemplatesVoorLead(nepDb(), LEAD, L.leadVariabelen(LEAD));
  assert.ok(!r.templates.some((t) => t.name === 'aanmaning_dag7'));
  await assert.rejects(L.verstuurWaTemplate(nepDb(), { lead: LEAD, templateNaam: 'aanmaning_dag7', variabelen: ['x'] }), (e) => e.code === 'GEEN_LEAD_TEMPLATE');
  assert.equal(afgegeven.wa.length, 0);
});
