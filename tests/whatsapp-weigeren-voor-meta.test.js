// tests/whatsapp-weigeren-voor-meta.test.js
//
// WEIGEREN VOOR DE META-CALL IN PLAATS VAN META LATEN WEIGEREN.
//
// GEMETEN 28 september over alle send_whatsapp-stappen in
// event_automation_run_log (203 mislukt, niet 186):
//
//   C template bestaat niet      54   laatste 05/08, oude v3/v4-namen
//   F Meta 131009 telefoonformaat 53   8 deelnemers, laatste 26/09 - liep nog
//   H Meta 131008 parameter mist  50   alleen vragenlijst_herinnering_correct
//   A geen nummer                 43   laatste 03/09
//   G Meta 132000                  3   juni
//
// F en H zijn allebei voorspelbaar VOOR de call. 53 verworpen berichten over
// 8 mensen is 6 a 7 per persoon, en H stond 50 keer op een template met een
// {{1}}-body zonder mapping.
//
// Deze tests werken op de BRON van api/_lib/events-send.js. Die functie praat
// met Supabase en Meta en is niet zonder netwerk te draaien; wat hier telt is
// de VOLGORDE (guard voor de call) en de VORM van het resultaat. Het gedrag
// van die vorm in de engine wordt hieronder met echte advanceRun-runs getest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { advanceRun } from '../api/_lib/events-automation-engine.js';
import { sendEventWhatsAppTemplate } from '../api/_lib/events-send.js';
import { isE164 } from '../api/_lib/phone-e164.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = new Date('2026-09-28T12:00:00.000Z');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

const SEND = zonderUitleg(readFileSync(join(ROOT, 'api/_lib/events-send.js'), 'utf8'));
const ENG  = zonderUitleg(readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));

// ═══════════════════════════════════════════════════════════════════════════
// (a) HET NUMMER — WEIGEREN VOOR DE CALL
// ═══════════════════════════════════════════════════════════════════════════

test('(a) de nummer-guard staat VOOR de Meta-call', () => {
  const iGuard = SEND.indexOf('nummer niet E.164');
  const iSend  = SEND.indexOf('await sendTemplate(');
  assert.ok(iGuard > 0, 'de guard hoort te bestaan');
  assert.ok(iSend > 0);
  assert.ok(iGuard < iSend, 'de guard hoort VOOR sendTemplate te staan');
  // En ook voor de conversation-upsert en de variabele-resolve, zodat er
  // helemaal geen werk gedaan wordt voor een nummer dat niet kan werken.
  const iConv = SEND.indexOf('conv upsert failed');
  if (iConv > 0) assert.ok(iGuard < iConv, 'de guard hoort ook voor de conv-upsert te staan');
});

test('(a) de reden heeft exact de gevraagde vorm en noemt de RAUWE waarde', () => {
  assert.match(SEND, /reason: 'nummer niet E\.164: ' \+ String\(attendee\?\.phone \?\? ''\)\.trim\(\)/,
    'de rauwe kolomwaarde, niet de +-variant die toE164Plus ervan maakt');
});

test('(a) de bestaande no-phone-check blijft staan, de nieuwe komt ernaast', () => {
  assert.match(SEND, /reason: 'no-phone'/);
  assert.ok(SEND.indexOf("reason: 'no-phone'") < SEND.indexOf('nummer niet E.164'),
    'no-phone eerst, dan de vorm-check');
});

test('(a) de guard gebruikt DE ENE E.164-definitie, geen tweede regex', () => {
  assert.match(SEND, /import \{ isE164 \} from '\.\/phone-e164\.js'/);
  assert.match(SEND, /if \(!isE164\(phone\)\)/);
  // De gemeten gevallen: toE164Plus maakt hier geen geldig nummer van.
  const toE164Plus = (p) => {
    if (!p) return null;
    const s = String(p).trim();
    if (!s) return null;
    return s.startsWith('+') ? s : '+' + s.replace(/^00/, '');
  };
  for (const raw of ['0472223752', '047979884', 'nonclevalerie@gmailcom',
                     '06 12 34 56 78', '+0612345678']) {
    assert.equal(isE164(toE164Plus(raw)), false, raw + ' hoort geweigerd te worden');
  }
  // WAT DEZE GUARD NIET VANGT, en dat is geen tekortkoming van de regex.
  // '639503861' wordt '+639503861', en dat IS een geldig E.164-nummer: +63 is
  // de landcode van de Filipijnen. Vormcontrole kan hier niets vinden, dus
  // Meta accepteert het en het bericht gaat naar een onbekende. Dat nummer
  // staat daarom in stap 5 van de opkuis, bij het handwerk - een mens moet
  // vaststellen welk land bedoeld was. Vastgepind zodat niemand later denkt
  // dat deze guard dat geval dekt.
  assert.equal(isE164(toE164Plus('639503861')), true,
    'formeel geldig, maar inhoudelijk onbekend land - zie stap 5 van de opkuis');
  // En een goed nummer blijft goed.
  for (const raw of ['+31612345678', '+32472223752', '0031612345678']) {
    assert.equal(isE164(toE164Plus(raw)), true, raw + ' hoort door te mogen');
  }
});

test('(a) de ECHTE functie weigert een fout nummer, zonder DB en zonder Meta', async () => {
  // Dit is de enige test die de guard daadwerkelijk UITVOERT in plaats van
  // hem in de bron te lezen. Dat kan omdat hij vóór elke Supabase-call staat:
  // zou hij naar achteren schuiven, dan valt deze test om op een DB-fout in
  // plaats van stil te blijven slagen.
  for (const raw of ['0472223752', '047979884', 'nonclevalerie@gmailcom', '+0612345678']) {
    const r = await sendEventWhatsAppTemplate({
      attendee: { id: 'a1', phone: raw },
      event   : { id: 'ev-1' },
      templateName: 'maakt_niet_uit',
    });
    assert.equal(r.ok, false, raw);
    assert.equal(r.skipped, true, raw);
    assert.equal(r.permanent, true, raw + ' hoort permanent te zijn, anders retryt de engine');
    assert.equal(r.reason, 'nummer niet E.164: ' + raw.trim(), raw);
    // GEEN config_fout: dit is een probleem van de ontvanger, dus de
    // deelnemer hoort juist WEL gemarkeerd te worden.
    assert.notEqual(r.config_fout, true, raw);
  }
});

test('(a) de ECHTE functie laat een leeg nummer op no-phone vallen', async () => {
  for (const raw of [null, '', '   ']) {
    const r = await sendEventWhatsAppTemplate({
      attendee: { id: 'a1', phone: raw },
      event   : { id: 'ev-1' },
      templateName: 'maakt_niet_uit',
    });
    assert.equal(r.reason, 'no-phone', JSON.stringify(raw) + ' hoort no-phone te blijven');
    assert.notEqual(r.permanent, true, 'no-phone was en blijft geen permanente weigering');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) HET RESULTAAT IS PERMANENT — EN WAT DAT WEL EN NIET DOET
// ═══════════════════════════════════════════════════════════════════════════

const FLOW = [
  { type: 'send_whatsapp', config: { template_name: 'x' } },
  { type: 'send_internal_notification', config: { subject: 'a', body: 'b' } },
];

async function draai(waResultaat, extra = {}) {
  const gelogd = [], gedaan = [], gemarkeerd = [];
  const u = await advanceRun({
    run: { id: 'r1', is_test: false, current_step_index: 0, attempts: 0,
           last_error: null, steps_snapshot: extra.stappen || FLOW },
    attendee: { id: 'a1', status: 'aangemeld', email: 'x@y.nl',
                phone: extra.phone || '0472223752' },
    event: { id: 'ev-1', starts_at: '2026-10-10T17:00:00.000Z' },
    now: NU, triggerType: extra.triggerType || 'on_signup',
    deps: {
      isStepDone: async () => false,
      recordLog:  async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { gedaan.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { gedaan.push('wa'); return waResultaat; },
      setTag:       async () => { gedaan.push('tag'); return { ok: true }; },
      updateAttendeeStatus: async () => { gedaan.push('status'); return { ok: true }; },
      sendInternalNotification: async () => { gedaan.push('intern'); return { ok: true }; },
      markeerWhatsappOnbereikbaar: async (arg) => { gemarkeerd.push(arg); return { ok: true }; },
    },
  });
  return { u, gelogd, gedaan, gemarkeerd };
}

const NUMMER_FOUT = {
  ok: false, skipped: true, permanent: true,
  reason: 'nummer niet E.164: 0472223752',
};

test('(b) een fout nummer markeert de deelnemer als onbereikbaar', async () => {
  const { u, gemarkeerd } = await draai(NUMMER_FOUT);
  assert.equal(gemarkeerd.length, 1, 'precies een markering');
  assert.equal(gemarkeerd[0].attendee.id, 'a1');
  assert.match(gemarkeerd[0].reden, /niet E\.164/);
  assert.match(u.last_error || '', /niet E\.164/, 'en de reden staat op de run');
});

test('(b) het triggert GEEN extra bericht en GEEN statuswijziging', async () => {
  const { gedaan } = await draai(NUMMER_FOUT);
  // De WhatsApp is geprobeerd, de interne melding erna hoort gewoon te gaan,
  // en er is NIETS extra verstuurd of gewijzigd door de weigering zelf.
  assert.deepEqual(gedaan, ['wa', 'intern']);
  assert.equal(gedaan.filter((x) => x === 'email').length, 0, 'geen extra mail');
  assert.equal(gedaan.filter((x) => x === 'status').length, 0, 'geen statuswijziging');
  assert.equal(gedaan.filter((x) => x === 'tag').length, 0, 'geen tag');
});

test('(b) de markering raakt alleen de opvolg-vlag, niet de status', () => {
  const i = ENG.indexOf('markeerWhatsappOnbereikbaar: async');
  assert.ok(i > 0);
  const dep = ENG.slice(i, ENG.indexOf('updateAttendeeStatus:', i));
  assert.match(dep, /follow_up_flagged: true/);
  assert.match(dep, /follow_up_reason/);
  assert.doesNotMatch(dep, /\bstatus:/, 'de dep mag de inschrijvingsstatus niet aanraken');
  assert.doesNotMatch(dep, /sendEventMail|sendEventWhatsAppTemplate/,
    'de dep mag niets versturen');
});

test('(b) de flow loopt door, precies zoals bij elke permanente weigering', async () => {
  const { u } = await draai(NUMMER_FOUT);
  assert.equal(u.status, 'completed');
  assert.equal(u.current_step_index, FLOW.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) DE MAPPING — WEIGEREN VOOR DE CALL, MAAR NIEMAND ONBEREIKBAAR NOEMEN
// ═══════════════════════════════════════════════════════════════════════════

test('(c) de mapping-guard staat VOOR de resolve en de Meta-call', () => {
  const iGuard = SEND.indexOf('variabele(n) in de body maar geen mapping');
  const iRes   = SEND.indexOf('buildMetaVariablesFromMapping(bodyMapping');
  const iSend  = SEND.indexOf('await sendTemplate(');
  assert.ok(iGuard > 0, 'de guard hoort te bestaan');
  assert.ok(iGuard < iRes,  'voor de variabele-resolve');
  assert.ok(iGuard < iSend, 'en voor de Meta-call');
});

test('(c) hij kijkt naar de body EN naar beide mapping-bronnen', () => {
  // De telling komt uit body_text van de templaterij. De twee vormen die
  // geteld worden staan in hun eigen test hieronder.
  assert.match(SEND, /const bodyTekst\s+= String\(templateRow\.body_text \|\| ''\)/,
    'de body van de template is de bron van de telling');
  assert.match(SEND, /const bodyVarsN\s+= \(bodyTekst\.match/);
  assert.match(SEND, /const heeftMapping = !!\(bodyMapping/);
  // bodyMapping is DB-eerst met de stap-mapping als fallback.
  assert.match(SEND, /const bodyMapping = dbMapping \|\| overrideMapping/);
  assert.match(SEND, /config_fout: true/);
});

const MAPPING_FOUT = {
  ok: false, skipped: true, permanent: true, config_fout: true,
  reason: "template 'vragenlijst_herinnering_correct' heeft 1 variabele(n) in de body maar geen mapping",
};

test('(c) een configfout markeert de deelnemer NIET, maar staat wel op de run', async () => {
  const { u, gemarkeerd } = await draai(MAPPING_FOUT);
  assert.deepEqual(gemarkeerd, [],
    '50 mensen onbereikbaar noemen omdat een template stuk is, maakt de markering waardeloos');
  assert.match(u.last_error || '', /geen mapping/, 'maar zichtbaar blijft het wel');
});

test('(c) de engine onderscheidt configfout van ontvanger-fout', () => {
  assert.match(ENG, /const isConfigFout = !!\(result && result\.config_fout\)/);
  assert.match(ENG, /if \(!isConfigFout\s*&&\s*type === 'send_whatsapp'/,
    'de markering hoort achter die check te staan');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET GOEDE PAD BLIJFT ONGEWIJZIGD — DAT IS DE EIS
// ═══════════════════════════════════════════════════════════════════════════

test('een geldig nummer met werkende mapping loopt ongewijzigd door', async () => {
  const { u, gedaan, gelogd, gemarkeerd } = await draai(
    { ok: true, meta_wamid: 'wamid.TEST' },
    { phone: '+31612345678' },
  );
  assert.deepEqual(gedaan, ['wa', 'intern'], 'beide stappen gedraaid');
  assert.equal(u.status, 'completed');
  assert.equal(u.last_error, null, 'geen fout op de run');
  assert.deepEqual(gemarkeerd, [], 'niemand gemarkeerd');
  const wa = gelogd.find((g) => g.t === 'send_whatsapp');
  assert.equal(wa.r.ok, true);
  assert.equal(wa.r.meta_wamid, 'wamid.TEST');
});

test('de guards raken de MAIL-tak niet', async () => {
  // Alleen de WhatsApp-kant is aangepast. Een mailstap met dezelfde deelnemer
  // hoort gewoon te lopen, ook als het nummer onbruikbaar is.
  const { gedaan } = await draai({ ok: true }, {
    stappen: [{ type: 'send_email', config: { subject: 'x', body: 'y' } }],
    phone: '0472223752',
  });
  assert.deepEqual(gedaan, ['email']);
});

test('tijdelijke en gewone skips zijn niet aangeraakt', async () => {
  // Zonder permanent blijft een fout retry-waardig.
  const tijd = await draai({ ok: false, error: 'Meta 500' });
  assert.equal(tijd.u.current_step_index, 0, 'blijft op de stap staan');
  assert.ok(tijd.u.next_run_at);
  assert.deepEqual(tijd.gemarkeerd, []);
  // En no-phone blijft een gewone skip zonder markering.
  const skip = await draai({ ok: false, skipped: true, reason: 'no-phone' });
  assert.equal(skip.u.last_error, null);
  assert.deepEqual(skip.gemarkeerd, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ALLE VIJF DE VERZENDPADEN LOPEN LANGS DEZELFDE GUARDS
// ═══════════════════════════════════════════════════════════════════════════

test('de guards zitten in events-send, dus alle vijf de paden erven ze', () => {
  // Dat is het punt: geen vijf kopieen van dezelfde check.
  for (const f of [
    'api/_lib/events-automation-engine.js',
    'api/_lib/events-invite.js',
    'api/_lib/events-vervolg-invite.js',
    'api/_lib/event-website-berichten.js',
    'api/_lib/events-questionnaire-invite.js',
  ]) {
    const bron = readFileSync(join(ROOT, f), 'utf8');
    assert.match(bron, /sendEventWhatsAppTemplate/, f + ' verstuurt niet via de helper');
    assert.doesNotMatch(zonderUitleg(bron), /isE164\(/,
      f + ' hoort de nummer-check NIET zelf te doen - die staat in events-send');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HET QUESTIONNAIRE-PAD — TEMPLATE DIE NIET BESTOND + ONTBREKENDE MAPPING
// ═══════════════════════════════════════════════════════════════════════════
//
// GEMETEN 28 september: 'vragenlijst_herinnering_v3' bestaat NIET in
// whatsapp_meta_templates, dus elke WhatsApp uit dit pad faalde met "template
// niet gevonden". Er staan drie APPROVED nl-templates, alle met een mapping:
// 'vragenlijst_herinnering' (positioneel), '_correct' en '_v2' (named).
// Maxim kiest '_correct' — dat gebruikt de automatisatie sinds 17/09.

const QI = zonderUitleg(
  readFileSync(join(ROOT, 'api/_lib/events-questionnaire-invite.js'), 'utf8'));

test('het questionnaire-pad gebruikt een template die BESTAAT', () => {
  assert.match(QI, /'vragenlijst_herinnering_correct'/,
    'de gekozen template hoort in de code te staan');
  assert.doesNotMatch(QI, /vragenlijst_herinnering_v3/,
    'de niet-bestaande naam hoort weg te zijn');
});

test('de v3-naam staat NERGENS meer in code of seeds', () => {
  // Hij stond op precies een plek: de fallback in dit bestand. Deze test
  // bewaakt dat hij niet via een seed of een ander bestand terugkomt.
  const bestanden = [
    'api/_lib/events-questionnaire-invite.js',
    'api/events-attendee-send-questionnaire.js',
    'api/_lib/events-send.js',
    'api/_lib/events-automation-engine.js',
  ];
  for (const f of bestanden) {
    let bron;
    try { bron = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
    // In events-send mag de naam in een TOELICHTING staan (de meting), maar
    // niet in code.
    assert.doesNotMatch(zonderUitleg(bron), /vragenlijst_herinnering_v3/,
      f + ' noemt de niet-bestaande template nog in code');
  }
});

test('het questionnaire-pad geeft nu een mapping mee, zoals de andere vier', () => {
  assert.match(QI, /const PARAM_MAPPING\s+= \{ body: \{ 1: 'attendee\.voornaam', 2: 'event\.titel' \} \}/);
  assert.match(QI, /paramMappingOverride : PARAM_MAPPING/);
  // Precies een verzendaanroep in dit bestand, en die heeft de mapping.
  const sends = (QI.match(/sendEventWhatsAppTemplate\(\{/g) || []).length;
  assert.equal(sends, 1, 'een verzendaanroep - de twee andere plekken zijn logComms');
});

test("de mapping gebruikt attendee.voornaam en NIET klant.voornaam", () => {
  // Het template noemt {{klant.voornaam}}, maar dat leest uit de CUSTOMER-
  // context en die geeft dit pad niet mee (alleen event, attendee,
  // moduleContext). getCustomerValue returnt dan stil '' en de klant krijgt
  // 'Hoi , je plek voor...'. Vandaar attendee.voornaam.
  assert.match(QI, /1: 'attendee\.voornaam'/);
  assert.doesNotMatch(QI, /1: 'klant\.voornaam'/);
  // En het bewijs dat de customer-resolver stil leeg teruggeeft.
  const tv = readFileSync(join(ROOT, 'api/_lib/template-variables.js'), 'utf8');
  assert.match(tv, /function getCustomerValue\(customer, key\) \{\s*\n\s*if \(!customer\) return '';/,
    'als dit ooit gaat gooien in plaats van leeg teruggeven, verandert het risico');
});

test('(c) de mapping-guard telt OOK named placeholders', () => {
  // Sinds C4 staat een body soms named in de DB. Van de drie
  // vragenlijst-templates is er een positioneel en zijn er twee named. Alleen
  // op {{N}} tellen zou juist die twee missen.
  const tel = (t) => (t.match(/\{\{\s*\d+\s*\}\}/g) || []).length
                   + (t.match(/\{\{\s*[a-z_]+\.[a-z_]+\s*\}\}/gi) || []).length;
  assert.equal(tel('Hoi {{1}}, je plek voor {{2}} staat klaar!'), 2, 'positioneel');
  assert.equal(tel('Hoi {{klant.voornaam}}, je plek voor de {{event.titel}} staat...'), 2, 'named');
  assert.equal(tel('Hoi {{attendee.voornaam}}, je plek voor {{event.titel}}...'), 2, 'named v2');
  assert.equal(tel('Geen variabelen hier.'), 0, 'zonder variabelen geen guard');
  // En de bron telt beide vormen.
  assert.match(SEND, /bodyTekst\.match\(\/\\\{\\\{\\s\*\\d\+/, 'positionele telling');
  assert.match(SEND, /\[a-z_\]\+\\\.\[a-z_\]\+/, 'named telling');
});
