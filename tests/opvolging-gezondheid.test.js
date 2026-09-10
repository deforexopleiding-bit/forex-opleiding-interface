// tests/opvolging-gezondheid.test.js
//
// De vijf dagelijkse controles. Elke test is opgezet rond de ECHTE regressie
// van deze week die hij gevangen zou hebben — met de werkelijke getallen, niet
// met verzonnen gevallen.
//
// LET OP WAT DEZE TESTS WEL EN NIET ZIJN. Ze controleren dat de BEOORDELING
// klopt. Of de controle daadwerkelijk elke ochtend draait en de juiste data
// leest, bewijst geen enkele unit-test — dat bewijst de mail van morgenochtend.
// Dat onderscheid is precies wat er deze week zes keer misging.

import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  controleerInstroom, controleerOptelling, controleerDubbels,
  beoordeelPrintweergave, controleerBrug, bouwMail,
  OK, FOUT, NIET_GEMETEN, SLAPER_MAX_DAGEN,
} from '../api/_lib/opvolging-gezondheid.js';

const VANDAAG = '2026-09-07';
const dagPlus = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

// ═══════════════════════════════════════════════════════════════════════════
// 1 · INSTROOM
// ═══════════════════════════════════════════════════════════════════════════

test('de slapende kaarten van 5 september waren opgevallen', () => {
  // Bryan, Kris en Achraf: aangemaakt 5 sep, due 19 sep. Veertien dagen.
  const r = controleerInstroom({
    taken: [
      { naam: 'Bryan Van Der Heyden', due: '2026-09-19', aangemaakt_op: '2026-09-05' },
      { naam: 'Kris Sienaert',        due: '2026-09-19', aangemaakt_op: '2026-09-05' },
      { naam: 'Achraf Deflaoui',      due: '2026-09-19', aangemaakt_op: '2026-09-05' },
    ], vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.slapend, 3);
  assert.match(r.getallen.namen.join(' '), /Bryan/);
});

test('een kaart die vandaag is aangemaakt geeft geen vals alarm', () => {
  // Nog geen dag oud: de cron kan er simpelweg nog niet langs zijn geweest.
  const r = controleerInstroom({
    taken: [{ naam: 'Vers', due: dagPlus(VANDAAG, 14), aangemaakt_op: VANDAAG }],
    vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, OK);
});

test('een kaart binnen de grens is in orde', () => {
  const r = controleerInstroom({
    taken: [{ naam: 'Morgen', due: dagPlus(VANDAAG, SLAPER_MAX_DAGEN), aangemaakt_op: '2026-09-01' }],
    vandaag: VANDAAG, dagPlus,
  });
  assert.equal(r.staat, OK);
});

test('geen enkele onaangeraakte kaart is NIET GEMETEN, geen "in orde"', () => {
  // De val waar dit hele bouwwerk anders in loopt: niets gevonden als groen
  // boeken betekent dat een kapotte bron zich voordoet als een gezonde.
  const r = controleerInstroom({ taken: [], vandaag: VANDAAG, dagPlus });
  assert.equal(r.staat, NIET_GEMETEN);
  assert.notEqual(r.staat, OK);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · OPTELLING
// ═══════════════════════════════════════════════════════════════════════════

// Deze twee toetsten de oude emmers (te_kort). Ze blijven waar ze voor bedoeld
// waren — een som die niet klopt hoort gevonden te worden — maar met de emmers
// die er nu zijn.
test('een som die niet opgaat wordt gevonden', () => {
  // 5 gesproken + 0 niet opgenomen bij 9 uitgaande calls: vier vallen nergens.
  const r = controleerOptelling({ rapport: {
    volume: { bel: { uit: 9, gesproken: 5, niet_opgenomen: 0, onbekend_resultaat: 0, zonder_duur: 0 } },
    aandacht: [],
  } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.som, 5);
  assert.equal(r.getallen.uit, 9);
  assert.match(r.uitleg, /tellen op tot 5/);
});

test('de gerepareerde verdeling telt wél op', () => {
  const r = controleerOptelling({ rapport: {
    volume: { bel: { uit: 9, gesproken: 6, niet_opgenomen: 3, onbekend_resultaat: 0, zonder_duur: 0 } },
    aandacht: [{}, {}],
  } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.som, 9);
  assert.equal(r.getallen.bevindingen, 2);
});

// Derde test die de verwarring cementeerde: een rapport zonder volume-blok is
// een ANTWOORD dat we kregen en dat niet deugt, geen blinde vlek. De echte lege
// meting bij deze controle is een dag met nul uitgaande calls, en die hoort
// gewoon te kloppen (0+0+0+0 === 0) — dus die is 'ok', niet 'niet gemeten'.
test('een dag met nul uitgaande calls telt gewoon op en is ok', () => {
  const r = controleerOptelling({ rapport: {
    volume: { bel: { uit: 0, gesproken: 0, te_kort: 0, niet_opgenomen: 0, zonder_duur: 0 } },
    aandacht: [],
  } });
  assert.equal(r.staat, OK);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DUBBELS
// ═══════════════════════════════════════════════════════════════════════════

test('de dubbele Yasmine was opgevallen', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'y-oud', persoon: 'e:y@x.nl', dag: '2026-09-07', tijd: '14:00' },
    { appointment_id: 'y-nw',  persoon: 'e:y@x.nl', dag: '2026-09-07', tijd: '14:00' },
  ] } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.dubbel_op_persoon_en_tijd, 1);
});

test('hetzelfde afspraak-id twee keer valt ook op', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'a1', persoon: 'e:a@x.nl', dag: '2026-09-07', tijd: '10:00' },
    { appointment_id: 'a1', persoon: 'e:a@x.nl', dag: '2026-09-07', tijd: '11:00' },
  ] } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.dubbel_op_id, 1);
});

test('vijf verschillende calls zijn in orde', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [
    { appointment_id: 'a', persoon: 'e:1@x', dag: '2026-09-07', tijd: '07:30' },
    { appointment_id: 'b', persoon: 'e:2@x', dag: '2026-09-07', tijd: '14:00' },
    { appointment_id: 'c', persoon: 'e:3@x', dag: '2026-09-07', tijd: '17:00' },
    { appointment_id: 'd', persoon: 'e:4@x', dag: '2026-09-07', tijd: '18:30' },
    { appointment_id: 'e', persoon: 'e:5@x', dag: '2026-09-07', tijd: '18:30' },
  ] } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.regels, 5);
});

test('geen zoomcalls is NIET GEMETEN', () => {
  assert.equal(controleerDubbels({ rapport: { zoomcalls: [] } }).staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · PRINTWEERGAVE
// ═══════════════════════════════════════════════════════════════════════════

test('de crash van vanmiddag was opgevallen', () => {
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: "Cannot access 'nlDatum' before initialization",
    html: '<div class="melding">Rapport wordt opgehaald…</div>', versie: null, verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /nlDatum/);
  assert.match(r.uitleg, /laadtekst/);
});

test('de oudere build die daarna nog werd uitgeleverd was óók opgevallen', () => {
  // Dit is de tweede helft van dezelfde halve dag: de code was gerepareerd, de
  // server leverde de oude pagina.
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: null, html: '<div>een compleet rapport</div>',
    versie: 'rp-1', verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /oudere build/);
});

test('een pagina die tekent is in orde', () => {
  const r = beoordeelPrintweergave({
    bereikbaar: true, fout: null, html: 'x'.repeat(4000), versie: 'rp-2', verwachteVersie: 'rp-2',
  });
  assert.equal(r.staat, OK);
});

// Deze test nam 'HTTP 500' als bewijs voor NIET_GEMETEN en cementeerde daarmee
// de verwarring tussen een storing en een ontbrekende instelling. Hij toetst nu
// waar hij over gaat: niet weten WAAR je moet kijken. De storing-kant staat
// onderaan dit bestand.
test('niet weten waar je moet kijken is NIET GEMETEN, geen fout en zeker geen ok', () => {
  const r = beoordeelPrintweergave({ bereikbaar: false, fout: 'geen basis-URL', configFout: true });
  assert.equal(r.staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE BRUG
// ═══════════════════════════════════════════════════════════════════════════

test('de LID-storing van vanochtend was opgevallen', () => {
  // 92 gezien, 1 doorgelaten — maar zelfs 0 doorgelaten hield de brug 'verbonden'.
  //
  // DE SLEUTEL IS `gebeurtenissen`, EN DAT IS GEEN DETAIL. Deze tests voedden
  // controleerBrug met `{ tellers: … }`, een vorm die de echte brug nooit
  // teruggeeft (server.js: `gebeurtenissen: wa.tellers()`). Ze waren dus groen
  // terwijl de controle op productie ALTIJD 'niet gemeten' zei en deze hele
  // FOUT-tak nooit kon afgaan. Zelfde les als bij ronde A: een test die de
  // verkeerde vorm vastlegt maakt de bug onzichtbaar.
  const r = controleerBrug({ status: {
    verbonden: true,
    gebeurtenissen: { gezien: { message: 21, message_create: 38, message_ack: 33 },
                      doorgelaten: { message: 0, message_create: 0, message_ack: 0 } },
  } });
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.gezien, 92);
  assert.match(r.uitleg, /nul door/);
});

test('een brug die eruit ligt is fout', () => {
  const r = controleerBrug({ status: {
    verbonden: false,
    gebeurtenissen: { gezien: { message: 3 }, doorgelaten: { message: 0 } },
  } });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /niet verbonden/);
});

test('verbonden maar niets gezien is NIET GEMETEN', () => {
  // Zondagochtend: er is niets gebeurd. Dat is geen bewijs dat het werkt.
  const r = controleerBrug({ status: { verbonden: true, gebeurtenissen: { gezien: {}, doorgelaten: {} } } });
  assert.equal(r.staat, NIET_GEMETEN);
  assert.match(r.uitleg, /niets gezien/);
});

test('GEEN TELLERS is een eigen uitkomst — niet hetzelfde als nul gezien', () => {
  // Een brug die dit blok helemaal niet meestuurt (oudere versie op de VPS)
  // hebben we niet gemeten. 'Verbonden maar niets gezien' zou daar een
  // bewering zijn over cijfers die we nooit gekregen hebben.
  for (const status of [{ verbonden: true }, { verbonden: true, gebeurtenissen: {} }]) {
    const r = controleerBrug({ status });
    assert.equal(r.staat, NIET_GEMETEN, JSON.stringify(status));
    assert.match(r.uitleg, /geen tellers terug \(andere versie\?\)/);
  }
});

test('een oudere brug die de cijfers nog onder `tellers` zet werkt ook', () => {
  // Terugval, want de VPS loopt altijd achter op een deploy.
  const r = controleerBrug({ status: {
    verbonden: true, tellers: { gezien: { message: 10 }, doorgelaten: { message: 7 } },
  } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.gezien, 10);
});

test('gezien én doorgelaten is in orde', () => {
  // De cijfers van 10 september, zoals /status ze die dag echt teruggaf.
  const r = controleerBrug({ status: {
    verbonden: true,
    gebeurtenissen: {
      gezien     : { message: 87, message_create: 165, message_ack: 149 },
      doorgelaten: { message: 23, message_create: 36,  message_ack: 59  },
    },
  } });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.gezien, 401);
  assert.equal(r.getallen.doorgelaten, 118);
  assert.match(r.uitleg, /118 van 401 gebeurtenissen doorgelaten/);
});

// Idem: 'timeout' is een storing. Deze test gaat over de niet-geconfigureerde brug.
test('een niet-geconfigureerde brug is NIET GEMETEN', () => {
  const r = controleerBrug({ status: null, fout: 'WHATSAPP_BRUG_URL ontbreekt', configFout: true });
  assert.equal(r.staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MAIL
// ═══════════════════════════════════════════════════════════════════════════

test('de mail draagt de getallen, niet alleen een oordeel', () => {
  // Een mail die alleen 'in orde' zegt is niet na te rekenen, en daarmee precies
  // zo'n alibi als de tests die we deze week hebben opgeruimd.
  const m = bouwMail({ dag: VANDAAG, uitkomsten: [
    controleerOptelling({ rapport: { volume: { bel: { uit: 9, gesproken: 6, niet_opgenomen: 3, onbekend_resultaat: 0, zonder_duur: 0 } }, aandacht: [] } }),
  ] });
  assert.match(m.text, /uit=9/);
  assert.match(m.text, /gesproken=6/);
  assert.match(m.text, /som=9/);
});

test('de onderwerpregel draagt het oordeel', () => {
  const stuk = bouwMail({ dag: VANDAAG, uitkomsten: [{ naam: 'x', staat: FOUT, getallen: {}, uitleg: 'y' }] });
  assert.match(stuk.subject, /1 probleem/);
  const goed = bouwMail({ dag: VANDAAG, uitkomsten: [{ naam: 'x', staat: OK, getallen: {}, uitleg: 'y' }] });
  assert.match(goed.subject, /1\/1 in orde/);
});

test('niet-gemeten staat apart in de onderwerpregel', () => {
  // Anders leest een dag waarop niets gemeten kon worden als een goede dag.
  const m = bouwMail({ dag: VANDAAG, uitkomsten: [
    { naam: 'a', staat: OK, getallen: {}, uitleg: '' },
    { naam: 'b', staat: NIET_GEMETEN, getallen: {}, uitleg: '' },
  ] });
  assert.match(m.subject, /1 niet gemeten/);
  assert.doesNotMatch(m.subject, /2\/2 in orde/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 SEPTEMBER — DE BRUG-CONTROLE MAT DE VERKEERDE DINGEN
// ═══════════════════════════════════════════════════════════════════════════
// Controle 5 kwam terug als 'niet gemeten' terwijl WHATSAPP_BRUG_URL en
// WHATSAPP_BRUG_SECRET allebei in Vercel stonden. Drie fouten tegelijk:
//
//   1. De cron las WHATSAPP_BRUG_TOKEN uit — die naam bestaat nergens anders in
//      deze repo. Het geheim heet WHATSAPP_BRUG_SECRET.
//   2. Hij stuurde 'Authorization: Bearer'. De brug leest 'X-Brug-Secret'.
//   3. En het ergste: een 401 of een onbereikbare VPS werd geboekt als
//      NIET_GEMETEN — de emmer voor ontbrekende configuratie. Een echte
//      storing verdween daarmee in de bak voor 'nog niet ingesteld'.
//
// Fout 3 is dezelfde vorm als de tests die we deze week opruimden: de controle
// beweerde iets anders te meten dan hij mat.

test('brug: een 401 van de brug is een STORING, geen ontbrekende instelling', () => {
  const r = controleerBrug({ status: null, fout: 'De brug antwoordde met 401.' });
  assert.equal(r.staat, FOUT);
});

test('brug: een onbereikbare VPS is een storing, geen ontbrekende instelling', () => {
  const r = controleerBrug({ status: null, fout: 'De WhatsApp-brug is niet bereikbaar.' });
  assert.equal(r.staat, FOUT);
});

test('brug: ontbrekende configuratie blijft wél niet_gemeten', () => {
  const r = controleerBrug({ status: null, fout: 'WHATSAPP_BRUG_SECRET ontbreekt', configFout: true });
  assert.equal(r.staat, NIET_GEMETEN);
});

test('printweergave: een HTTP 500 is een storing, geen ontbrekende instelling', () => {
  const r = beoordeelPrintweergave({ bereikbaar: false, fout: 'HTTP 500' });
  assert.equal(r.staat, FOUT);
});

test('printweergave: geen basis-URL blijft wél niet_gemeten', () => {
  const r = beoordeelPrintweergave({ bereikbaar: false, fout: 'geen basis-URL', configFout: true });
  assert.equal(r.staat, NIET_GEMETEN);
});

// ── En het pad zelf, niet alleen de beoordeling ─────────────────────────────
// De drie fouten hierboven zaten in meetBrug(), niet in controleerBrug(). Een
// test die alleen de pure functie voedt had ze geen van drieën gezien — dat is
// de 'hulpfunctie'-vorm uit docs/opvolging-module.md. Deze draait meetBrug echt.

test('meetBrug: een 401 van de brug komt als FOUT terug, niet als niet_gemeten', async () => {
  process.env.WHATSAPP_BRUG_URL = 'https://brug.test';
  process.env.WHATSAPP_BRUG_SECRET = 'x'.repeat(32);
  const { meetBrug } = await import('../api/cron-opvolging-gezondheid.js');
  const r = await meetBrug(async () => {
    const e = new Error('De brug antwoordde met 401.'); e.code = 'BRUG_FOUT'; e.status = 401; throw e;
  });
  assert.equal(r.staat, FOUT);
  assert.match(String(r.getallen.fout), /401/);
});

test('meetBrug: zonder configuratie is het niet_gemeten, niet FOUT', async () => {
  const url = process.env.WHATSAPP_BRUG_URL, sec = process.env.WHATSAPP_BRUG_SECRET;
  delete process.env.WHATSAPP_BRUG_URL; delete process.env.WHATSAPP_BRUG_SECRET;
  const { meetBrug } = await import('../api/cron-opvolging-gezondheid.js');
  const r = await meetBrug(async () => { throw new Error('had niet aangeroepen mogen worden'); });
  assert.equal(r.staat, NIET_GEMETEN);
  process.env.WHATSAPP_BRUG_URL = url; process.env.WHATSAPP_BRUG_SECRET = sec;
});

test('meetBrug stuurt X-Brug-Secret uit WHATSAPP_BRUG_SECRET — de namen die de brug kent', async () => {
  process.env.WHATSAPP_BRUG_URL = 'https://brug.test';
  process.env.WHATSAPP_BRUG_SECRET = 'geheim'.padEnd(32, '0');
  const echt = globalThis.fetch;
  let gezien = null;
  globalThis.fetch = async (url, opties) => {
    gezien = { url: String(url), headers: opties?.headers || {} };
    return { ok: true, status: 200, json: async () => ({
      verbonden: true, gebeurtenissen: { gezien: { message: 9 }, doorgelaten: { message: 9 } } }) };
  };
  try {
    const { meetBrug } = await import('../api/cron-opvolging-gezondheid.js');
    const r = await meetBrug();                       // géén stub: het echte pad
    assert.equal(r.staat, OK);
    assert.equal(gezien.url, 'https://brug.test/status');
    assert.equal(gezien.headers['X-Brug-Secret'], process.env.WHATSAPP_BRUG_SECRET);
    assert.equal(gezien.headers.Authorization, undefined);
  } finally { globalThis.fetch = echt; }
});

test('de logregel noemt de controles bij naam, niet alleen hun aantal', async () => {
  const { samenvatting } = await import('../api/cron-opvolging-gezondheid.js');
  const regel = samenvatting([
    { naam: 'instroom', staat: OK, uitleg: 'geen slapers' },
    { naam: 'optelling', staat: OK, uitleg: 'klopt' },
    { naam: 'brug', staat: NIET_GEMETEN, uitleg: 'De brug is niet geconfigureerd' },
  ]);
  assert.match(regel, /niet gemeten: brug/);
  assert.match(regel, /ok: instroom, optelling/);
  assert.doesNotMatch(regel, /^\d+ fout/);           // niet meer alleen tellen
});

// ═══════════════════════════════════════════════════════════════════════════
// DEZELFDE VERWARRING BIJ DE ANDERE VIER CONTROLES
// ═══════════════════════════════════════════════════════════════════════════
// Nadat de brug-controle een 401 als NIET_GEMETEN bleek te boeken, zijn de
// overige vier nagelopen op hetzelfde patroon. Vier plekken deden het ook:
//
//   · de leesfout op opvolging_taken            → 'de takenlijst was niet te lezen'
//   · een uitzondering uit bouwRapport()         → 'het rapport kon niet gebouwd worden'
//   · een rapport zonder volume-blok             → 'er viel niets op te tellen'
//   · een rapport zonder zoomcall-lijst          → 'geen lijst teruggekregen'
//
// Alle vier zijn ANTWOORDEN DIE WE KREGEN. Een Supabase-fout, een exception uit
// de rapportmotor en een verminkte antwoordvorm zijn storingen, geen blinde
// vlekken. Ze horen in de emmer waar iemand naar kijkt.

test('optelling: een rapport zonder volume-blok is FOUT, geen blinde vlek', () => {
  const r = controleerOptelling({ rapport: { aandacht: [] } });
  assert.equal(r.staat, FOUT);
});

test('dubbels: een rapport zonder zoomcall-lijst is FOUT, geen blinde vlek', () => {
  const r = controleerDubbels({ rapport: { volume: {} } });
  assert.equal(r.staat, FOUT);
});

// ── En de twee die WEL een blinde vlek blijven ──────────────────────────────
// Een lege meting is iets anders dan een geweigerd antwoord: nul zoomcalls op
// een dag is geen storing. Deze twee blijven dus staan, en er is een test die
// dat vasthoudt zodat 'alles maar FOUT maken' niet stilletjes doorglipt.

test('dubbels: nul zoomcalls blijft een blinde vlek, geen FOUT', () => {
  const r = controleerDubbels({ rapport: { zoomcalls: [] } });
  assert.equal(r.staat, NIET_GEMETEN);
});

test('instroom: geen open aanmeldingen blijft een blinde vlek, geen FOUT', () => {
  const r = controleerInstroom({ taken: [], vandaag: '2026-09-07', dagPlus: (d) => d });
  assert.equal(r.staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// 8 SEPTEMBER — DE BEWAKING WAS NIET MEEGEGAAN MET DE MEETREGEL
// ═══════════════════════════════════════════════════════════════════════════
// Dezelfde les als bij duur_sec, nu op de meter zelf: we hebben de regel
// veranderd en de controle die erop toeziet niet meegenomen.
//
// De oude som was gesproken + te_kort + niet_opgenomen + zonder_duur. Maar
// `te_kort` bestaat niet meer, en `zonder_duur` is geen aparte emmer meer maar
// een DEELVERZAMELING van gesproken. Nagerekend op de echte respons van
// 7 september: 21 + 0 + 5 + 5 = 31 terwijl er 26 uitgaande calls zijn. De
// controle zou dus FOUT melden terwijl de cijfers juist kloppen — en die mail
// valt om 07:00 binnen, vlak voordat er gebeld wordt.

/** De echte respons van 7 september, zoals het endpoint hem nu levert. */
const VOLUME_7_SEP = {
  bel: { uit: 26, seconden: 423, gesproken: 21, niet_opgenomen: 5,
         onbekend_resultaat: 0, zonder_duur: 5, via_ander: 0 },
  wa: { uit: 10, in: 9 }, spraak: { uit: 0, in: 0 }, rijen: [],
};

test('de echte dag van 7 september geeft GEEN vals alarm', () => {
  const r = controleerOptelling({ rapport: { volume: VOLUME_7_SEP, aandacht: [] } });
  assert.equal(r.staat, OK, r.uitleg);
  assert.equal(r.getallen.som, 26, '21 gesproken + 5 niet opgenomen + 0 onbekend');
  assert.equal(r.getallen.uit, 26);
});

test('zonder_duur telt NIET mee in de som — het is een deel van gesproken', () => {
  // Vijf van de eenentwintig gesprekken hebben geen geregistreerde lengte. Ze
  // apart optellen maakt van 26 calls er 31.
  const r = controleerOptelling({ rapport: { volume: VOLUME_7_SEP, aandacht: [] } });
  assert.ok(r.getallen.zonder_duur === 5, 'wel zichtbaar in de getallen');
  assert.equal(r.getallen.som, 26, 'maar niet in de optelling');
});

test('een echte telfout wordt nog steeds gevangen', () => {
  const stuk = { bel: { ...VOLUME_7_SEP.bel, gesproken: 19 }, wa: { uit: 0, in: 0 } };
  const r = controleerOptelling({ rapport: { volume: stuk, aandacht: [] } });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /24/);
});

test('onbekend_resultaat wordt bekeken — dat is juist de emmer waar dit voor is', () => {
  // De bewaking keek langs precies het gat waarvoor ze bedoeld is: een
  // resultaatwaarde die onze classificatie niet kent, telde nergens mee.
  const metOnbekend = {
    bel: { ...VOLUME_7_SEP.bel, gesproken: 20, onbekend_resultaat: 1 },
    wa: { uit: 0, in: 0 },
  };
  const r = controleerOptelling({ rapport: { volume: metOnbekend, aandacht: [] } });
  assert.equal(r.getallen.onbekend_resultaat, 1);
  assert.match(r.uitleg, /onbekend/i, 'het hoort in de mail te staan');
  assert.notEqual(r.staat, FOUT, 'maar het is geen fout — de som klopt gewoon');
});

test('de lege vorm draagt dezelfde begrippen als het echte rapport', () => {
  // De lege vorm is wat de controle gebruikt als ze niets kan lezen. Klopt die
  // niet, dan liegt de bewaking juist op het moment dat er iets stuk is.
  const bron = readFileSync('api/cron-opvolging-gezondheid.js', 'utf8');
  // COMMENTAAR ERUIT VOORDAT WE ZOEKEN. De eerste versie van deze test sloeg
  // aan op het woord 'te_kort' in de TOELICHTING die uitlegt dat te_kort
  // vervallen is. Dat is de commentaar-val uit docs/opvolging-module.md, nu in
  // spiegelbeeld: niet groen op een comment, maar rood op een comment.
  const ruw = bron.slice(bron.indexOf('const LEEG_RAPPORT'), bron.indexOf('});', bron.indexOf('const LEEG_RAPPORT')));
  const leeg = ruw.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(leeg, /te_kort/, 'te_kort bestaat niet meer');
  assert.doesNotMatch(leeg, /gesprek_min_sec:\s*10/, 'de grens van tien seconden is vervallen');
  assert.match(leeg, /gesprek_bron:\s*'resultaat'/);
  assert.match(leeg, /onbekend_resultaat/);
  // En de blokken die er sinds vandaag bij zijn gekomen.
  // Op de SLEUTEL, niet op de substring: 'weg_tijdlijn' bevat ook 'tijdlijn',
  // en die hernoeming kwam ongestraft door een eerdere versie van deze test.
  for (const veld of ['werkritme', 'afgehandeld', 'tijdlijn']) {
    assert.match(leeg, new RegExp('(^|[^\\w])' + veld + '\\s*:'), 'de lege vorm mist ' + veld);
  }
});
