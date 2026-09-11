// tests/opvolging-liever-via-zoom.test.js
//
// 'EIGENLIJK HEB IK LIEVER EEN ZOOMCALL.'
//
// ── DE SITUATIE ─────────────────────────────────────────────────────────
// Dave belt iemand die zich voor een masterclass heeft aangemeld, en die zegt
// dat hij liever een zoomcall wil. Het Wat-nu-venster van de aanmeldkaart kende
// vier uitgangen — Bevestigd, Gesprek gehad, Geen interesse, Verplaatst naar
// ander event — en geen van vieren klopt hier.
//
// Dave moest dus buiten Opvolging een zoom boeken én in de eventmodule de
// persoon zelf afmelden. Twee administraties, en precies waar het misloopt: de
// zoomcall staat er wel en de aanwezigenlijst weet van niets. Of andersom.
//
// ── WAT DEZE UITGANG NIET IS ────────────────────────────────────────────
// Geen afhaker. Deze persoon komt wél, alleen ergens anders. Daarom:
//
//   · een eigen call_status ('liever_zoom'), niet 'komt_niet' — anders staat
//     hij in de aanwezigenlijst naast de mensen die geen interesse hadden;
//   · een eigen reden_code ('naar_zoom'), zodat het rapport hem niet met nul
//     belpogingen als nalatigheid leest;
//   · een herkenbaar merkteken in event_attendees.notes, zodat de
//     'je inschrijving is geannuleerd'-berichten die later nog komen hier
//     NIET op afgaan.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { beoordeelMoeite, MOEITE_NVT } from '../api/_lib/opvolging-vensters.js';
import { bepaalTaakActie } from '../api/_lib/opvolging-aanmelding.js';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const url    = (p) => pathToFileURL(join(ROOT, p)).href;
const VIEW   = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const AGENDA = join(ROOT, 'api/opvolging-agenda.js');
const KERN   = join(ROOT, 'api/opvolging-aanmelding-actie.js');

/** De aanmeldkaart van iemand die liever via zoom wil. */
const KAART = {
  id: 't-aanm', naam: 'Testlead', email: 't@x.nl', telefoon: '+31612345678',
  reden: 'aanmelding', status: 'open', due: '2026-09-11', bron: 'event',
  bron_ref: { event_id: 'ev-1', attendee_id: 'att-1', event_dag: '2026-09-25' },
  notitie: 'Aangemeld via de site.',
};
const MOMENT = '2026-09-15T11:30:00.000Z';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET ENDPOINT — ÉÉN ACTIE, DRIE GEVOLGEN
// ═══════════════════════════════════════════════════════════════════════════

/** Een supabase-dubbelganger die onthoudt wat er geschreven wordt. */
function nepAdmin(rijen = {}) {
  const log = [];
  const maak = (tabel) => {
    const st = { tabel, filters: [] };
    const k = {
      select: () => k, eq: (c, v) => { st.filters.push([c, v]); return k; },
      neq: () => k, in: () => k, gte: () => k, lt: () => k, lte: () => k,
      not: () => k, filter: () => k, order: () => k, limit: () => k,
      update: (v) => { st.op = 'update'; st.waarde = v; log.push({ ...st }); return k; },
      insert: (v) => { st.op = 'insert'; st.waarde = v; log.push({ ...st }); return k; },
      upsert: () => k, delete: () => k,
      maybeSingle: async () => ({ data: (rijen[tabel] || [])[0] || null, error: null }),
      single: async () => ({ data: (rijen[tabel] || [])[0] || null, error: null }),
      then: (r) => Promise.resolve({ data: rijen[tabel] || [], error: null }).then(r),
    };
    return k;
  };
  return { from: maak, _log: log };
}

function nepRes() {
  const uit = { code: null, body: null, headers: {} };
  return {
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

async function laadAgenda({ rijen = {}, boekFaalt = null, komtNiet = 'bijgewerkt' } = {}) {
  const admin = nepAdmin(rijen);
  const geboekt = [];
  const afgemeld = [];
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } },
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }),
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => true,
      requirePermissionFailOpen: async () => true,
      checkPermissionOrDeny: async () => true,
    },
  });
  mock.module(url('api/_lib/create-appointment-from-lead.js'), {
    namedExports: {
      createAppointmentForLead: async (o) => {
        geboekt.push(o);
        if (boekFaalt) throw boekFaalt;
        return {
          appointment_id: 'ap-nieuw', ghl_appointment_id: 'ghl-ap-nieuw',
          zoom_join_url: 'https://zoom/x', scheduled_at: o.scheduledAt,
        };
      },
      // opvolging-agenda haalt de GHL-vertaling uit dezelfde module.
      mapGhlError: (status, body) => String(body || '').includes('slot')
        ? 'Slot niet beschikbaar in Dave\'s GHL-kalender' : `GHL-fout ${status}`,
    },
  });
  mock.module(url('api/opvolging-aanmelding-actie.js'), {
    namedExports: {
      zetLieverZoom: async (attId, nu, moment) => {
        afgemeld.push({ attId, moment });
        return komtNiet;
      },
      zetKomtNiet: async () => 'bijgewerkt',
      LIEVER_ZOOM_CALL_STATUS: 'liever_zoom',
      LIEVER_ZOOM_MARKER: '[liever-zoom]',
    },
  });
  const mod = await import(url('api/opvolging-agenda.js') + '?t=' + Math.random());
  return { handler: mod.default, admin, geboekt, afgemeld };
}

const post = (body) => ({ method: 'POST', headers: { authorization: 'Bearer x' }, body, query: {} });

test('liever via zoom: één afspraak, afgemeld, kaart dicht met naar_zoom', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin, geboekt, afgemeld } = await laadAgenda({
    rijen: { opvolging_taken: [KAART] },
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), res);

  assert.equal(res._uit.code, 200, JSON.stringify(res._uit.body));

  // 1 · precies één zoomcall, op het gekozen moment
  assert.equal(geboekt.length, 1);
  assert.equal(geboekt[0].scheduledAt, MOMENT);
  assert.equal(res._uit.body.afspraak.appointment_id, 'ap-nieuw');
  assert.equal(res._uit.body.afspraak.uitgang, 'liever_zoom');

  // 2 · afgemeld via de kern, met het moment erbij voor de notitie
  assert.equal(afgemeld.length, 1);
  assert.equal(afgemeld[0].attId, 'att-1');
  assert.match(afgemeld[0].moment, /15\/09/);
  assert.equal(res._uit.body.eventmodule, 'bijgewerkt');

  // 3 · de kaart dicht, met een eigen reden — niet 'geen interesse', en niet
  //     'ingepland' (dan blijft hij wachten op bewijs dat nooit komt).
  const dicht = admin._log.find((r) => r.tabel === 'opvolging_taken' && r.op === 'update');
  assert.equal(dicht.waarde.status, 'gearchiveerd');
  assert.equal(dicht.waarde.reden_code, 'naar_zoom');
  assert.match(dicht.waarde.archief_reden, /liever via zoom/i);
  assert.doesNotMatch(dicht.waarde.archief_reden, /geen interesse/i);
  assert.notEqual(dicht.waarde.status, 'ingepland');
});

test('en er komt GEEN werklijstkaart bij', async (t) => {
  // De hele winst is dat dit één handeling is. Een nieuwe kaart zou het werk
  // dat net is afgerond meteen weer terugzetten.
  t.after(() => mock.reset());
  const { handler, admin } = await laadAgenda({ rijen: { opvolging_taken: [KAART] } });
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), nepRes());
  const nieuwe = admin._log.filter((r) => r.tabel === 'opvolging_taken' && r.op === 'insert');
  assert.equal(nieuwe.length, 0);
});

test('GHL faalt → het event blijft onaangeroerd', async (t) => {
  // Andersom zou iemand afgemeld staan voor een masterclass zonder dat er een
  // zoomcall tegenover staat. Afgemeld én niets, en dat merkt niemand tot de
  // dag zelf.
  t.after(() => mock.reset());
  const fout = Object.assign(new Error('stuk'), { code: 'GHL_API', ghlStatus: 400, ghlBody: 'no slot available' });
  const { handler, admin, afgemeld } = await laadAgenda({
    rijen: { opvolging_taken: [KAART] }, boekFaalt: fout,
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), res);

  assert.equal(res._uit.code, 422);
  assert.match(res._uit.body.error, /niet beschikbaar/i);
  assert.equal(afgemeld.length, 0, 'niemand afgemeld');
  assert.equal(admin._log.filter((r) => r.op === 'update').length, 0, 'de kaart blijft open');
});

test('een mislukte afmelding blijft niet stil', async (t) => {
  // De zoomcall staat al, dus terugdraaien zou een afspraak weggooien die de
  // lead net heeft afgesproken. Maar Dave moet het wél weten, anders denkt hij
  // dat het event bijgewerkt is.
  t.after(() => mock.reset());
  const { handler } = await laadAgenda({
    rijen: { opvolging_taken: [KAART] }, komtNiet: 'mislukt',
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.eventmodule, 'mislukt');

  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /afmelden in de eventmodule lukte niet/i);
});

test('alleen vanaf een aanmeldkaart', async (t) => {
  // Op een gewone opvolgtaak bestaat 'Opnieuw inplannen' al, en daar is geen
  // event om iemand voor af te melden.
  t.after(() => mock.reset());
  const { handler, geboekt } = await laadAgenda({
    rijen: { opvolging_taken: [{ ...KAART, reden: 'no_show_call' }] },
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), res);
  assert.equal(res._uit.code, 409);
  assert.match(res._uit.body.error, /Opnieuw inplannen/);
  assert.equal(geboekt.length, 0, 'en er is niets geboekt');
});

test('en niet twee keer op dezelfde kaart', async (t) => {
  // Twee tabbladen, of een dubbele klik die er toch doorheen komt: een tweede
  // zoomcall boeken voor iemand die er al een heeft is erger dan niets doen.
  t.after(() => mock.reset());
  const { handler, geboekt } = await laadAgenda({
    rijen: { opvolging_taken: [{ ...KAART, status: 'gearchiveerd' }] },
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-aanm', start: MOMENT, uitgang: 'liever_zoom' }), res);
  assert.equal(res._uit.code, 409);
  assert.match(res._uit.body.error, /al afgerond/i);
  assert.equal(geboekt.length, 0);
});

test('de gewone boekweg en het verzetten blijven werken', async (t) => {
  // Drie uitgangen op één endpoint, en de twee oudere mogen hier niet door
  // veranderen.
  t.after(() => mock.reset());
  const bron = readFileSync(AGENDA, 'utf8');
  assert.match(bron, /if \(b\.appointment_id\) return await verzetCall/);
  assert.match(bron, /uitgang \|\| ''\) === 'liever_zoom'\) return await lieverZoom/);
  // De GHL-vertaling staat op ÉÉN plek; twee kopieën lopen bij de eerste
  // wijziging uiteen.
  assert.equal((bron.match(/er is niets om het GHL-contact op te vinden/g) || []).length, 1,
    'de melding hoort maar één keer in dit bestand te staan');
  assert.equal((bron.match(/function boekFoutNaarHttp/g) || []).length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE KERN IN DE EVENTMODULE
// ═══════════════════════════════════════════════════════════════════════════

test('zetLieverZoom gebruikt de bestaande kern, niet een eigen UPDATE', () => {
  // De losse UPDATE van vroeger zette alleen status='geannuleerd': geen
  // belstatus, en geen capaciteitshook. Een plaats die vrijkwam heropende het
  // event dus nooit.
  const bron = readFileSync(KERN, 'utf8');
  const i = bron.indexOf('export async function zetLieverZoom');
  assert.ok(i > 0, 'zetLieverZoom hoort te bestaan');
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /return await zetKomtNiet\(/, 'via de bestaande kern');
  assert.doesNotMatch(blok, /from\('event_attendees'\)/, 'geen eigen UPDATE');

  // En die kern doet nog steeds de hook + de statusregel.
  const j = bron.indexOf('export async function zetKomtNiet');
  const kern = bron.slice(j, j + 4200);
  assert.match(kern, /onConfirmedAttendeeMutation/);
  assert.match(kern, /huidige === 'aangemeld' \|\| huidige === 'wachtlijst'/);
  assert.match(kern, /patch\.status = 'geannuleerd'/);
});

test('de reden staat in twee velden, elk met een eigen lezer', () => {
  const bron = readFileSync(KERN, 'utf8');
  // call_status: de badge in de aanwezigenlijst.
  assert.match(bron, /LIEVER_ZOOM_CALL_STATUS = 'liever_zoom'/);
  // notes: vrije tekst, dus die landt zeker — én het is het merkteken waar de
  // latere 'je inschrijving is geannuleerd'-automatisering op kan filteren.
  assert.match(bron, /LIEVER_ZOOM_MARKER = '\[liever-zoom\]'/);
  const i = bron.indexOf('export async function zetLieverZoom');
  assert.match(bron.slice(i, i + 900), /LIEVER_ZOOM_MARKER/);
});

test('een onbekende call_status mag de afmelding niet meeslepen', () => {
  // De statuswijziging is het belangrijke deel. Zou call_status in dezelfde
  // UPDATE zitten en de databank hem weigeren, dan faalt de hele afmelding en
  // staat die persoon nog gewoon op de aanwezigenlijst.
  const bron = readFileSync(KERN, 'utf8');
  const i = bron.indexOf('export async function zetKomtNiet');
  const blok = bron.slice(i, i + 4200);
  assert.match(blok, /opties\.callStatus && opties\.callStatus !== 'komt_niet'/);
  assert.match(blok, /console\.warn[\s\S]{0,120}call_status/, 'fail-soft, maar niet stil');
});

test("'komt niet' blijft precies doen wat het deed", () => {
  // De bestaande aanroepers geven geen opties mee; dan hoort er niets te
  // veranderen aan de patch.
  const bron = readFileSync(KERN, 'utf8');
  assert.match(bron, /zetKomtNiet\(attendeeId, nuIso, db = supabaseAdmin, opties = \{\}\)/);
  assert.match(bron, /if \(opties\.notitieRegel\)/, 'de notitie is optioneel');
  const i = bron.indexOf('export async function zetKomtNiet');
  assert.match(bron.slice(i, i + 1200), /call_status: 'komt_niet'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WAT ER DAARNA NIET MEER MAG GEBEUREN
// ═══════════════════════════════════════════════════════════════════════════

const EVENT = { id: 'ev-1', starts_at: '2026-09-25T18:00:00.000Z' };
const NU = Date.parse('2026-09-11T10:00:00.000Z');

test('de reminder-ronde van vier dagen gaat niet meer af', () => {
  // De kaart is gearchiveerd, en bepaalTaakActie laat een gearchiveerde kaart
  // met rust. Zou hij toch wakker worden, dan belt Dave iemand over een event
  // waarvoor hij net is afgemeld.
  const dicht = { id: 't-aanm', status: 'gearchiveerd', due: '2026-09-11' };
  const vlakVoorEvent = Date.parse('2026-09-22T10:00:00.000Z');
  for (const nu of [NU, vlakVoorEvent]) {
    const b = bepaalTaakActie({
      attendee: { id: 'att-1', status: 'geannuleerd' }, event: EVENT, taak: dicht, nu,
    });
    assert.equal(b.actie, 'niets');
  }
});

test('de aanmeldingen-cron maakt geen nieuwe kaart voor deze deelnemer', () => {
  // status 'geannuleerd' zit niet in ACTIEF, dus er komt niets bij — ook niet
  // als de kaart er niet meer zou zijn.
  const b = bepaalTaakActie({
    attendee: { id: 'att-1', status: 'geannuleerd' }, event: EVENT, taak: null, nu: NU,
  });
  assert.equal(b.actie, 'niets');
});

test('en hij overschrijft onze archief_reden niet met "geannuleerd in de eventmodule"', () => {
  // sluiten_geannuleerd geldt alleen voor een LOPENDE kaart. De onze is al
  // dicht, en zou anders in Afgerond als een gewone annulering lezen.
  const b = bepaalTaakActie({
    attendee: { id: 'att-1', status: 'geannuleerd' }, event: EVENT,
    taak: { id: 't-aanm', status: 'gearchiveerd' }, nu: NU,
  });
  assert.notEqual(b.actie, 'sluiten_geannuleerd');

  const cron = readFileSync(join(ROOT, 'api/cron-opvolging-aanmeldingen.js'), 'utf8');
  assert.match(cron, /\.neq\('status', 'gearchiveerd'\)/, 'en de cron schrijft er ook niet overheen');
});

test('na het event wordt hij geen no_show_event-kaart', () => {
  // Die kaart ontstaat uit attendance_status 'no_show', dat iemand per
  // deelnemer op het afrondscherm zet. Een geannuleerde inschrijving staat daar
  // niet in de actieve lijst, dus er valt niets aan te vinken.
  const kern = readFileSync(join(ROOT, 'api/_lib/events-complete-core.js'), 'utf8');
  assert.match(kern, /reden\s*:\s*status === 'no_show' \? 'no_show_event' : 'afgemeld'/);
  assert.match(kern, /AFWEZIG_STATUSSEN\.has\(status\)/,
    'de kaart hangt aan attendance_status, niet aan de inschrijvingsstatus');

  // En de instroom-kant: ACTIEF kent 'geannuleerd' niet.
  const aanm = readFileSync(join(ROOT, 'api/_lib/opvolging-aanmelding.js'), 'utf8');
  const i = aanm.indexOf('ACTIEF');
  assert.ok(i > 0);
  assert.doesNotMatch(aanm.slice(i, i + 300), /'geannuleerd'/);
});

test('het rapport noemt dit geen te weinig moeite', () => {
  // Nul belpogingen, want er was één gesprek en dat leverde meteen een afspraak
  // op. Zonder eigen regel leest dat als nalatigheid — precies het valse
  // verwijt waar dit rapport al drie keer op is bijgestuurd.
  const zonder = beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: null });
  assert.equal(zonder.staat, 'te_weinig');

  const met = beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: 'naar_zoom' });
  assert.equal(met.staat, 'nvt');
  assert.match(met.reden, /zoomcall/);

  // De bestaande uitzondering blijft.
  assert.equal(beoordeelMoeite({ reden_code: 'zoom_geen_interesse' }).staat, 'nvt');
  assert.ok(MOEITE_NVT.naar_zoom && MOEITE_NVT.zoom_geen_interesse);
});

test('en telt hem niet als geen interesse of als afgesloten lead', () => {
  // leadAlAfgesloten (PR 9) kijkt naar een archief_reden die met 'geen
  // interesse' begint. De onze doet dat niet, en dat moet zo blijven: anders
  // zou een geannuleerde zoomcall van deze persoon later geen kaart meer
  // opleveren.
  const bron = readFileSync(AGENDA, 'utf8');
  const m = bron.match(/LIEVER_ZOOM_ARCHIEF_REDEN = '([^']+)'/);
  assert.ok(m);
  assert.ok(!m[1].toLowerCase().startsWith('geen interesse'));

  const ann = readFileSync(join(ROOT, 'api/_lib/opvolging-annulering.js'), 'utf8');
  assert.match(ann, /reden\.startsWith\('geen interesse'\)/);
  assert.doesNotMatch(ann, /naar_zoom/, 'naar_zoom is geen eindpunt-reden');
});

test('de badge leest als "Liever via zoom", niet als een kale belstatus', () => {
  // Zonder eigen badge viel de waarde door naar de called_at-terugval en las
  // hij als 'Gebeld' — of stond hij bij de mensen die geen interesse hadden.
  const detail = readFileSync(join(ROOT, 'modules/events-detail.html'), 'utf8');
  assert.match(detail, /liever_zoom\s*:\s*\{ label: 'Liever via zoom'/);

  const v2 = readFileSync(join(ROOT, 'modules/klanten-v2/views/events-v2.js'), 'utf8');
  assert.match(v2, /CALL_STATUS_ALLEEN_LEZEN = \{ liever_zoom: 'Liever via zoom' \}/);
  assert.match(v2, /if \(s === 'liever_zoom'\)/, 'en een eigen kleur, niet het grijs van komt_niet');

  // MAAR GEEN MENUKEUZE. Hem met de hand kunnen zetten zou een halve handeling
  // zijn: belstatus veranderd, inschrijving niet, geen zoomcall.
  const i = v2.indexOf('const CALL_STATUS_OPTIONS');
  const opts = v2.slice(i, v2.indexOf('];', i));
  assert.doesNotMatch(opts, /liever_zoom/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET VENSTER
// ═══════════════════════════════════════════════════════════════════════════

test('het Wat-nu-venster van de aanmeldkaart heeft een vijfde uitgang', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf("if (m.soort === 'watnu' && isAanmelding(t))");
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2600);
  for (const bestaand of ['bevestigd', 'gesprek_gehad', 'geen_interesse']) {
    assert.match(blok, new RegExp("__opvAanmeldActie\\('" + bestaand + "'\\)"), bestaand + ' hoort te blijven');
  }
  assert.match(blok, /__opvVerplaatsNaarEvent\(\)/);
  assert.match(blok, /Liever via zoom/);
  assert.match(blok, /window\.__opvAanmeldZoom\(\)/);
});

test('het zoom-venster toont de agenda en geen handmatige datumkeuze', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf("if (m.soort === 'aanmeld-zoom')");
  assert.ok(i > 0, 'het venster hoort te bestaan');
  const blok = bron.slice(i, i + 1600);
  assert.match(blok, /agendaBlok\(\{ handmatig: false \}\)/);
  assert.doesNotMatch(blok, /type="date"/, 'een zoomcall heeft een uur nodig');
  // En het zegt vooraf wat er gaat gebeuren, inclusief dat een mislukte
  // boeking het event ongemoeid laat.
  assert.match(blok, /afgemeld/i);
  assert.match(blok, /verandert er <b>niets<\/b> aan het event/);
});

test('__opvBoek kent nu drie bestemmingen', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('window.__opvBoek = async');
  const blok = bron.slice(i, i + 3000);
  assert.match(blok, /m\.soort === 'aanmeld-zoom'/);
  assert.match(blok, /uitgang: 'liever_zoom'/);
  assert.match(blok, /appointment_id: call\.appointment_id/, 'verzetten blijft');
  assert.match(blok, /taak_id: m\.taakId, start: startIso \}\)/, 'de gewone weg blijft');
  assert.match(blok, /if \(_ui\.bezig\) return;/, 'dubbelklik-guard');
  assert.match(blok, /finally \{/);
});

test('de view is opgehoogd', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= 65, 'PR 12 hoort hem op minstens 65 te zetten');
});
