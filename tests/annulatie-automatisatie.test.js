// tests/annulatie-automatisatie.test.js
//
// WIE GEANNULEERD WORDT KRIJGT BERICHT — MAAR NIET TWEE KEER.
//
// Vandaag vertrekt er niets bij een annulatie: er bestond geen enkele trigger
// op `status`. Deze wijziging voegt trigger_type 'on_status' toe plus het
// nulpunt (cancelled_at) en de reden (cancelled_reason).
//
// ── DE VAL DIE DEZE TEST BEWAAKT ────────────────────────────────────────
// 'Geen gehoor - laatste kans' zet in stap 4 ZELF de status op geannuleerd.
// Die persoon heeft net stap 0 en 1 gehad: de mail en de WhatsApp dat zijn
// plek vervalt. Zonder maatregel krijgt hij binnen de minuut ook 'je
// inschrijving is geannuleerd' — twee berichten over hetzelfde.
//
// De maatregel: die stap stempelt cancelled_reason='automation', en de
// annulatie-automatisatie slaat die reden over.
//
// ── EN EEN TWEEDE VAL ───────────────────────────────────────────────────
// De stop-guard uit #1617 houdt sends tegen naar wie niet meer komt, en
// 'geannuleerd' staat in die lijst. De annulatiemail gaat PER DEFINITIE naar
// iemand met die status. Ongescoped zou de automatisatie dus stil niets doen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  advanceRun, magAnnulatiemailKrijgen, GEEN_ANNULATIEMAIL_REDENEN,
  CANCEL_REDEN_AUTOMATISATIE, CANCEL_REDEN_LIEVER_ZOOM,
  CANCEL_REDEN_MANUEEL, CANCEL_REDEN_KOMT_NIET,
} from '../api/_lib/events-automation-engine.js';
import { beginToestandVoorTrigger } from '../api/_lib/events-test-begintoestand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = new Date('2026-09-17T12:00:00.000Z');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

const ANNULATIE = [
  { type: 'send_email',    config: { subject: 'Je inschrijving is geannuleerd', body: '...' } },
  { type: 'send_whatsapp', config: { template_name: 'annulatie_bevestigd' } },
];

async function draai({ stappen, triggerType, attendee, stepIndex = 0, conditieWaar = true }) {
  const gelogd = [], gedaan = [];
  const u = await advanceRun({
    run: { id: 'r1', is_test: false, current_step_index: stepIndex, attempts: 0,
           last_error: null, steps_snapshot: stappen },
    attendee,
    event: { id: 'ev-1', starts_at: '2026-09-23T17:00:00.000Z' },
    now: NU, triggerType,
    deps: {
      isStepDone: async () => false,
      recordLog:  async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { gedaan.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { gedaan.push('wa'); return { ok: true }; },
      setTag:       async () => { gedaan.push('tag'); return { ok: true }; },
      updateAttendeeStatus: async () => { gedaan.push('status'); return { ok: true }; },
      sendInternalNotification: async () => { gedaan.push('intern'); return { ok: true }; },
      measureCondition: async () => ({ gemeten: true, waar: conditieWaar, reden: 'test' }),
    },
  });
  return { u, gelogd, gedaan };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE VAL — GEEN TWEEDE BERICHT NA DE GEEN-GEHOOR-FLOW
// ═══════════════════════════════════════════════════════════════════════════

test('EEN ANNULATIE UIT DE GEEN-GEHOOR-FLOW KRIJGT GEEN ANNULATIEMAIL', () => {
  // DIT IS DE BELANGRIJKSTE TEST. De flow mailde al in stap 0 en 1.
  const uitDeFlow = { status: 'geannuleerd', cancelled_reason: CANCEL_REDEN_AUTOMATISATIE };
  assert.equal(magAnnulatiemailKrijgen(uitDeFlow), false,
    'wie al "je plek is vervallen" kreeg, hoort geen "je inschrijving is geannuleerd" te krijgen');
  assert.ok(GEEN_ANNULATIEMAIL_REDENEN.includes(CANCEL_REDEN_AUTOMATISATIE));
});

test('de geen-gehoor-flow stempelt die reden ook echt', () => {
  // Op de BRON: de dep zit in stepDueRuns en heeft een echte DB nodig. Wat we
  // hier bewaken is dat stap 4 (update_attendee_status → geannuleerd) de reden
  // meestempelt; zonder die stempel valt de hele maatregel weg.
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf('updateAttendeeStatus: async (step)');
  assert.ok(i > 0);
  const dep = bron.slice(i, bron.indexOf('setTag:', i) > i ? bron.indexOf('setTag:', i) : i + 4000);
  assert.match(dep, /newStatus === 'geannuleerd'/, 'de stempel hoort aan geannuleerd te hangen');
  assert.match(dep, /patch\.cancelled_at\s*=/);
  assert.match(dep, /patch\.cancelled_reason\s*=\s*CANCEL_REDEN_AUTOMATISATIE/);
  // Alleen bij een ECHTE overgang, zodat een tweede pass het tijdstip niet
  // opschuift en new_only niet ineens opnieuw aanslaat.
  assert.match(dep, /!statusAlGoed && newStatus === 'geannuleerd'/);
});

test('de kandidaat-query filtert die reden eruit', () => {
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  assert.match(bron, /kandidaten\.filter\(\(a\) => magAnnulatiemailKrijgen\(a\)\)/,
    'de filter hoort op de kandidaten te staan');
  // In JS en niet in PostgREST: een kale not-in zou elke rij met een NULL-reden
  // laten wegvallen, en die vorm is offline niet te verifiëren.
  assert.doesNotMatch(bron, /cancelled_reason\.not\.in/,
    'de reden-filter hoort in JS te staan, testbaar');
  // En niet stil: zichtbaar hoeveel er afvielen.
  assert.match(bron, /overgeslagen/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE TWEEDE VAL — DE AUTOMATISATIE MAG ZIJN EIGEN STATUS NEGEREN
// ═══════════════════════════════════════════════════════════════════════════

test('DE ANNULATIEMAIL WORDT NIET DOOR DE #1617-GUARD GEBLOKKEERD', async () => {
  // 'geannuleerd' staat in NIET_MEER_KOMEND_STATUSSEN. Zonder vrijstelling zou
  // deze automatisatie stil niets doen: run afgerond, twee stappen
  // overgeslagen, geen mail, geen WhatsApp.
  const { gedaan, u } = await draai({
    stappen: ANNULATIE, triggerType: 'on_status',
    attendee: { id: 'a1', status: 'geannuleerd', cancelled_reason: CANCEL_REDEN_MANUEEL,
                email: 'x@y.nl', phone: '+31612345678' },
  });
  assert.deepEqual(gedaan, ['email', 'wa'], 'mail EN WhatsApp horen uit te gaan');
  assert.equal(u.status, 'completed');
});

test('maar andere triggers houden die guard onverkort', async () => {
  // Een welkomstmail of reminder naar wie afzegde blijft tegengehouden — dat
  // is precies wat #1617 opleverde en dat mag niet verwateren.
  for (const tt of ['on_signup', 'time_before_event', 'on_call_status',
                    'on_assessment_completed', null]) {
    const { gedaan } = await draai({
      stappen: ANNULATIE, triggerType: tt,
      attendee: { id: 'a1', status: 'geannuleerd', email: 'x@y.nl', phone: '+31612345678' },
    });
    assert.deepEqual(gedaan, [], String(tt) + ' hoort NIET te sturen naar wie geannuleerd is');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WIE WEL EN WIE NIET
// ═══════════════════════════════════════════════════════════════════════════

test('wel mailen: handmatig geannuleerd en komt-niet', () => {
  assert.equal(magAnnulatiemailKrijgen({ cancelled_reason: CANCEL_REDEN_MANUEEL }), true);
  assert.equal(magAnnulatiemailKrijgen({ cancelled_reason: CANCEL_REDEN_KOMT_NIET }), true);
});

test("niet mailen: 'liever via zoom' haakt niet af", () => {
  // 'Je plek is vrijgegeven' is daar onwaar. Dit stond al als bedoeling in
  // api/opvolging-aanmelding-actie.js en is nu afdwingbaar.
  assert.equal(magAnnulatiemailKrijgen({ cancelled_reason: CANCEL_REDEN_LIEVER_ZOOM }), false);
  const bron = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');
  assert.match(bron, /liever_zoom'\s*$|liever_zoom'\s*:/m);
  assert.match(zonderUitleg(bron), /cancelled_reason = opties\.callStatus === 'liever_zoom'/);
});

test('een onbekende of lege reden mag WEL mailen', () => {
  // Dezelfde veilige kant als de rest: liever een bericht te veel dan iemand
  // stil uit de flow laten vallen op een leeg veld. Een annulatie zonder reden
  // komt van een pad dat we nog niet kennen, en daar hoort bericht bij.
  for (const r of [null, undefined, '', 'iets_nieuws']) {
    assert.equal(magAnnulatiemailKrijgen({ cancelled_reason: r }), true,
      JSON.stringify(r) + ' hoort wel te mogen');
  }
  assert.equal(magAnnulatiemailKrijgen({}), true);
  assert.equal(magAnnulatiemailKrijgen(null), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET NULPUNT — AANZETTEN MAG DE 35 BESTAANDE NIET MAILEN
// ═══════════════════════════════════════════════════════════════════════════

test('new_only eist cancelled_at NOT NULL, dus geen terugwerkende kracht', () => {
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf("auto.trigger_type === 'on_status'");
  const j = bron.indexOf("auto.trigger_type === 'on_call_status'", i);
  assert.ok(i > 0 && j > i);
  const tak = bron.slice(i, j);
  assert.match(tak, /\.not\('cancelled_at', 'is', null\)/,
    'zonder NOT NULL liften rijen zonder stempel mee op de gte-vergelijking');
  assert.match(tak, /\.gte\('cancelled_at', ondergrens\)/);
  // Het event moet nog komen.
  assert.match(tak, /\.gt\('events\.starts_at', nowIso\)/);
  // En de status komt uit de configuratie, niet hardgecodeerd.
  assert.match(tak, /auto\.trigger_config && auto\.trigger_config\.status/);
  assert.match(tak, /q\.eq\('status', wanted\)/);
});

test('de migratie backfilt NIET en zegt waarom', () => {
  const sql = readFileSync(
    join(ROOT, 'docs/sql-migrations/2026-09-17-annulatie-automatisatie.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cancelled_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS cancelled_reason/);
  assert.doesNotMatch(sql, /UPDATE public\.event_attendees\s+SET cancelled_at/i,
    'er mag geen backfill in staan');
  assert.match(sql, /GEEN BACKFILL/);
  // En de blokkerende waarschuwing hoort bovenaan, want de code noemt de
  // kolommen bij naam in UPDATE-patches.
  assert.match(sql, /BLOKKEREND/);
  // De automatisatie staat UIT.
  assert.match(sql, /'Annulatie bevestigd'/);
  assert.match(sql, /false,\s*--\s*UIT/);
  assert.match(sql, /'on_status'/);
  assert.match(sql, /jsonb_build_object\('status', 'geannuleerd'\)/);
  assert.match(sql, /'new_only'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · ALLE DRIE DE PADEN STEMPELEN
// ═══════════════════════════════════════════════════════════════════════════

test('elk pad dat op geannuleerd zet, stempelt cancelled_at', () => {
  for (const [f, patroon] of [
    ['api/events-attendee-status-change.js', /case 'geannuleerd':[\s\S]{0,200}cancelled_at/],
    ['api/opvolging-aanmelding-actie.js',    /patch\.cancelled_at\s*=\s*nuIso/],
    ['api/_lib/events-automation-engine.js', /patch\.cancelled_at\s*=\s*nowIso/],
  ]) {
    const bron = zonderUitleg(readFileSync(join(ROOT, f), 'utf8'));
    assert.match(bron, patroon, f + ' stempelt cancelled_at niet');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE TESTER KAN DIT MEten
// ═══════════════════════════════════════════════════════════════════════════

test('de tester zet de testdeelnemer in de juiste begintoestand', () => {
  // Zonder dit maakt de tester een deelnemer op 'aangemeld' aan en meet de
  // annulatie-automatisatie niets — precies de bug uit #1606.
  const r = beginToestandVoorTrigger(
    { trigger_type: 'on_status', trigger_config: { status: 'geannuleerd' } },
    '2026-09-17T12:00:00.000Z');
  assert.equal(r.fout, null);
  assert.equal(r.patch.status, 'geannuleerd');
  assert.equal(r.patch.cancelled_at, '2026-09-17T12:00:00.000Z', 'het nulpunt hoort mee');
  // NIET 'automation' — dat is juist de reden die overgeslagen wordt, dan zou
  // een testrun de mail nooit zien.
  assert.notEqual(r.patch.cancelled_reason, CANCEL_REDEN_AUTOMATISATIE);
  assert.equal(magAnnulatiemailKrijgen(r.patch), true,
    'de testdeelnemer moet de mail WEL kunnen krijgen');
  assert.ok(r.tekst && r.tekst.includes('geannuleerd'), 'het scherm hoort te zeggen wat er gezet is');
});

test('on_status zonder status weigert de testrun', () => {
  // Nooit stil slagen: een run starten die niets kan meten laat het lijken
  // alsof de automatisatie kapot is.
  const r = beginToestandVoorTrigger({ trigger_type: 'on_status', trigger_config: {} }, NU.toISOString());
  assert.ok(r.fout, 'hier hoort een weigering te staan');
  assert.match(r.fout, /trigger_config\.status/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · DE SERVER-VALIDATIE
// ═══════════════════════════════════════════════════════════════════════════

test('de server kent on_status en eist een status', () => {
  const save = readFileSync(join(ROOT, 'api/events-automation-save.js'), 'utf8');
  assert.match(save, /const TRIGGERS = \[[^\]]*'on_status'[^\]]*\]/);
  assert.match(save, /on_status vereist trigger_config\.status/);
  // En new_only alleen voor geannuleerd, want dat is de enige status met een
  // eigen tijdstempel. Anders zou new_only stil niemand pakken.
  assert.match(save, /on_status met enroll_mode new_only werkt vandaag alleen voor status/);
});

test('de migratie laat on_status toe in de CHECK', () => {
  const sql = readFileSync(
    join(ROOT, 'docs/sql-migrations/2026-09-17-annulatie-automatisatie.sql'), 'utf8');
  const i = sql.indexOf('ADD CONSTRAINT event_automations_trigger_type_check');
  assert.ok(i > 0, 'de CHECK hoort opnieuw gezet te worden');
  const blok = sql.slice(i, i + 400);
  // Alle bestaande triggers moeten mee, anders breekt hij de rest.
  for (const t of ['on_signup', 'on_assessment_completed', 'time_before_event',
                   'on_assessment_not_completed_after', 'on_call_status', 'on_status']) {
    assert.match(blok, new RegExp("'" + t + "'"), t + ' hoort in de nieuwe CHECK te staan');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 · DE WHATSAPP-MAPPING — ANDERS KOMT ER NIETS AAN
// ═══════════════════════════════════════════════════════════════════════════

test('de send_whatsapp-stap geeft zijn eigen mapping mee', () => {
  // GEMETEN 20 september: 186 mislukte send_whatsapp-stappen. Naast het
  // telefoonformaat (Meta 131009) zat hier een tweede oorzaak — de stap gaf
  // helemaal geen mapping mee, en een {{N}}-body met 0 parameters weigert Meta
  // met 132000. 26 goedgekeurde templates hebben meta_param_mapping NULL.
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf('sendWhatsApp: async (step, ctx)');
  assert.ok(i > 0);
  const dep = bron.slice(i, bron.indexOf('setTag:', i));
  assert.match(dep, /step\.config\.param_mapping/,
    'de stap hoort zijn mapping uit de config te kunnen halen');
  assert.match(dep, /paramMappingOverride: stapMapping/,
    'en die door te geven aan sendEventWhatsAppTemplate');
  // null als de stap niets zet → terugvallen op de DB-mapping, dus geen
  // enkele bestaande stap verandert.
  assert.match(dep, /\? step\.config\.param_mapping\s*:\s*null/);
});

test('sendEventWhatsAppTemplate gebruikt de override als FALLBACK', () => {
  // Staat er wél een mapping in de DB, dan wint die. Anders zou een stap de
  // mapping die het templatescherm toont stil overrulen.
  const send = zonderUitleg(readFileSync(join(ROOT, 'api/_lib/events-send.js'), 'utf8'));
  assert.match(send, /paramMappingOverride/);
});

test('de migratie zet de goedgekeurde template MET mapping in stap 1', () => {
  const sql = readFileSync(
    join(ROOT, 'docs/sql-migrations/2026-09-17-annulatie-automatisatie.sql'), 'utf8');
  assert.match(sql, /'template_name', 'annulatie_bevestigd'/,
    'de echte naam, geen placeholder meer');
  assert.doesNotMatch(sql, /VUL_IN_NA_META_GOEDKEURING/,
    'de placeholder hoort weg te zijn');
  // De mapping, in de vorm die events-invite.js ook gebruikt.
  assert.match(sql, /'param_mapping', jsonb_build_object/);
  assert.match(sql, /'1', 'attendee\.voornaam'/);
  assert.match(sql, /'2', 'event\.datum'/);
  // En de reden staat erbij, zodat de volgende lezer de mapping niet weghaalt.
  assert.match(sql, /132000/);
});
