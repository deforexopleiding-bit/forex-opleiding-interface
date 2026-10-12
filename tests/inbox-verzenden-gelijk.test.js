// tests/inbox-verzenden-gelijk.test.js
//
// G2 deel 1: hetzelfde gedrag, op een andere plek.
//
// ── WAT DEZE TEST BEWIJST ────────────────────────────────────────────────────
// api/inbox-send.js is een omhulsel geworden; het werk staat in
// api/_lib/inbox-verzenden.js. De belofte bij zo'n verplaatsing is "nul
// gedragswijziging", en dat is een bewering tot iemand het meet.
//
// Hier staat de BEVROREN kopie van main van 12 oktober 2026
// (tests/vast/inbox-send-20261012.js) naast het nieuwe pad. Allebei krijgen
// dezelfde nepdatabank en dezelfde neptransportlaag, en allebei hun spoor wordt
// opgeschreven: welke tabel, welke kolommen, welke waarden, in welke volgorde.
// Verschilt er één stap, dan faalt de test.
//
// ── DE DRIE GEVALLEN DIE ERTOE DOEN ─────────────────────────────────────────
// Een eerdere poging (#1680) was geëxtraheerd uit inbox-send.js van vóór
// 360dialog en miste daardoor twee dingen. Precies die twee worden hier
// gemeten:
//
//   1. HOOFDNUMMER — één phone_number_id, meerdere modules. De module (en dus
//      de rechtencheck) hangt af van de KLANT, niet van het nummer.
//   2. KLANTNUMMER — het tweede 360dialog-nummer, eigen module.
//   3. LIJNWISSEL — het gesprek hangt aan een oud lijn-ID; na het versturen
//      hoort het aan de opvolger te hangen, anders komt het antwoord van de
//      klant in een nieuw, gesplitst gesprek terecht.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── De wereld eromheen ──────────────────────────────────────────────────────
// Eén mutabele `wereld`, zodat elk geval hem opnieuw kan zetten zonder de
// nepmodules opnieuw te hoeven registreren (mock.module werkt per module-URL
// en niet per test).

const wereld = {
  spoor: [],
  conv: null,
  moduleContext: null,
  huidigeLijn: null,        // null = geen wissel
  bezetteLijn: null,        // een bestaand gesprek op de doellijn
  metaAntwoord: { wamid: 'wamid.AAA' },
  metaFout: null,
  gesprekkenV2: false,
};

const log = (wat, hoe) => wereld.spoor.push(hoe === undefined ? wat : [wat, hoe]);

// Een spoorregel is OF een kale tekst ('recht finance.inbox.send') OF een paar
// ['meta sendText', {...}]. Wie daar `s[0]` op doet krijgt bij een kale tekst
// de letter 'r' terug en dus stilletjes nooit een treffer. Dat is precies het
// soort toets dat altijd slaagt en nooit iets bewijst, dus staat het hier één
// keer goed.
const kop = (s) => (Array.isArray(s) ? String(s[0]) : String(s));

/**
 * Nepdatabank die haar vragen opschrijft.
 *
 * Opzettelijk dom: elke keten eindigt in een vast antwoord per tabel. Wat we
 * willen weten is niet of de databank klopt, maar of de twee paden hem op
 * dezelfde manier aanspreken.
 */
function nepDb() {
  const bouw = (tabel) => {
    const vraag = { tabel, kolommen: null, filters: [], rij: null };
    const b = {
      select: (k) => { vraag.kolommen = k; return b; },
      insert: (r) => { vraag.rij = r; log('insert ' + tabel, r); return b; },
      update: (r) => { vraag.rij = r; log('update ' + tabel, r); return b; },
      eq: (k, v) => { vraag.filters.push(['eq', k, v]); return b; },
      in: (k, v) => { vraag.filters.push(['in', k, v]); return b; },
      maybeSingle: async () => { log('lees ' + tabel, { kolommen: vraag.kolommen, filters: vraag.filters }); return antwoord(tabel, vraag); },
      single: async () => { log('lees-1 ' + tabel, { kolommen: vraag.kolommen, filters: vraag.filters }); return antwoord(tabel, vraag); },
      then: (f, g) => {
        if (vraag.rij) log('klaar ' + tabel, { filters: vraag.filters });
        return Promise.resolve(antwoord(tabel, vraag)).then(f, g);
      },
    };
    return b;
  };
  const antwoord = (tabel, vraag) => {
    if (tabel === 'whatsapp_module_config') return { data: { phone_number_id: 'FINANCE_LIJN' }, error: null };
    if (tabel === 'whatsapp_conversations') {
      // hechtAanHuidigeLijn kijkt of de doellijn al bezet is: dat is de
      // opvraging met twee eq-filters op phone_number + phone_number_id.
      const pnFilter = vraag.filters.find((f) => f[1] === 'phone_number_id');
      if (pnFilter) return { data: wereld.bezetteLijn, error: null };
      return { data: wereld.conv, error: null };
    }
    if (tabel === 'whatsapp_messages') return { data: { id: 'msg-1', meta_wamid: 'wamid.AAA', status: 'queued', sent_at: 'T' }, error: null };
    return { data: null, error: null };
  };
  return { from: (t) => bouw(t) };
}

mock.module(url('api/supabase.js'), { namedExports: {
  supabaseAdmin: nepDb(),
  createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } }),
} });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: {
  requirePermission: async (_req, sleutel) => { log('recht ' + sleutel); return wereld.rechten.includes(sleutel); },
} });
mock.module(url('api/_lib/audit-customer.js'), { namedExports: { getClientIp: () => '1.2.3.4' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  getConfigStatus: () => ({ configured: true, missing: [] }),
  MetaNotConfiguredError: class MetaNotConfiguredError extends Error {},
  sendText:     async (a) => { log('meta sendText', a);     if (wereld.metaFout) throw wereld.metaFout; return wereld.metaAntwoord; },
  sendTemplate: async (a) => { log('meta sendTemplate', a); if (wereld.metaFout) throw wereld.metaFout; return wereld.metaAntwoord; },
  sendMedia:    async (a) => { log('meta sendMedia', a);    if (wereld.metaFout) throw wereld.metaFout; return wereld.metaAntwoord; },
} });
mock.module(url('api/_lib/render-template-preview.js'), { namedExports: {
  renderTemplatePreview: async (a) => { log('voorbeeld', a); return { body: 'weergegeven tekst' }; },
} });
mock.module(url('api/_lib/dunning-arrangement-hooks.js'), { namedExports: {
  unpauseRunsForConversation: async (id) => { log('ontpauzeer', id); return { ok: true }; },
} });
mock.module(url('api/_lib/gesprekken-vlag.js'), { namedExports: {
  gesprekkenV2Aan: () => wereld.gesprekkenV2,
} });
mock.module(url('api/_lib/module-context.js'), { namedExports: {
  getModuleContextByPhoneNumberId: async (_db, pnId, opts) => {
    log('module-context', { pnId, opts });
    return wereld.moduleContext;
  },
} });
mock.module(url('api/_lib/wa-gesprek-lijn.js'), { namedExports: {
  hechtAanHuidigeLijn: async (_sb, conv) => { log('hecht-aan-lijn', { conv_id: conv?.id, pnId: conv?.phone_number_id }); return null; },
  huidigeLijnId: async (pnId) => wereld.huidigeLijn || pnId,
} });

const OUD = (await import(url('tests/vast/inbox-send-20261012.js'))).default;
const NIEUW = (await import(url('api/inbox-send.js'))).default;

// ── Een nep-antwoord dat onthoudt wat eruit kwam ────────────────────────────

function nepRes() {
  const uit = { status: null, body: null, headers: {} };
  const r = {
    setHeader: (k, v) => { uit.headers[k] = v; },
    status: (c) => { uit.status = c; return r; },
    json: (b) => { uit.body = b; return r; },
  };
  return { r, uit };
}

/**
 * Tijdstempels gelijktrekken.
 *
 * De twee ritten liggen een milliseconde uit elkaar, dus `new Date()` geeft
 * twee verschillende waarden. Dat is geen gedragsverschil. Wat we WEL willen
 * zien is dát er een tijdstempel staat en op welke sleutel -- vandaar <tijd> in
 * plaats van de regel weglaten.
 */
function zonderTijd(x) {
  if (typeof x === 'string') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(x) ? '<tijd>' : x;
  if (Array.isArray(x)) return x.map(zonderTijd);
  if (x && typeof x === 'object') {
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, zonderTijd(v)]));
  }
  return x;
}

/** Draai één handler en geef {spoor, antwoord} terug. */
async function draai(handler, body) {
  wereld.spoor = [];
  const { r, uit } = nepRes();
  await handler({ method: 'POST', body, headers: {} }, r);
  return { spoor: zonderTijd(wereld.spoor), antwoord: zonderTijd(uit), ruwSpoor: wereld.spoor };
}

/**
 * Draai allebei en vergelijk.
 *
 * De `wereld` wordt tussen de twee ritten opnieuw gezet door `zet`, zodat het
 * tweede pad niet meeprofiteert van wat het eerste achterliet.
 */
async function vergelijk(naam, zet, body) {
  zet();
  const oud = await draai(OUD, body);
  zet();
  const nieuw = await draai(NIEUW, body);
  assert.deepEqual(nieuw.antwoord, oud.antwoord, naam + ': het ANTWOORD wijkt af');
  assert.deepEqual(nieuw.spoor, oud.spoor, naam + ': het SPOOR wijkt af');
  return oud;
}

// ── De drie gevallen ────────────────────────────────────────────────────────

const HOOFDNUMMER = '1273723375834177';
const KLANTNUMMER = '9988776655443322';
const CONV = (pnId, extra = {}) => ({
  id: 'conv-1',
  phone_number: '+32470123456',
  phone_number_id: pnId,
  customer_id: 'klant-1',
  last_inbound_at: new Date(Date.now() - 60_000).toISOString(),
  last_message_preview: 'eerder',
  ...extra,
});

test('HOOFDNUMMER: de module komt van de klant, niet van het nummer', async () => {
  // Dit is wat #1680 miste. Op het 360dialog-hoofdnummer delen meerdere modules
  // één phone_number_id; een losse whatsapp_module_config-opvraging geeft daar
  // een willekeurige rij terug, en die rij IS de rechtencheck.
  const oud = await vergelijk('hoofdnummer', () => {
    wereld.conv = CONV(HOOFDNUMMER);
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  const ctx = oud.spoor.find((s) => kop(s) === 'module-context');
  assert.ok(ctx, 'module-context hoort aangeroepen te worden');
  assert.equal(ctx[1].pnId, HOOFDNUMMER);
  assert.deepEqual(ctx[1].opts, { customerId: 'klant-1' },
    'de KLANT hoort meegegeven te worden -- daar hangt de module aan op het hoofdnummer');
});

test('KLANTNUMMER: het tweede nummer met zijn eigen module', async () => {
  await vergelijk('klantnummer', () => {
    wereld.conv = CONV(KLANTNUMMER);
    wereld.moduleContext = { module: 'onboarding' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['onboarding.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });
});

test('KLANTNUMMER: zonder het juiste recht gaat er niets uit', async () => {
  // Een events-gesprek met alleen onboarding-rechten. Allebei de paden horen
  // dezelfde 403 te geven, met dezelfde tekst -- vijf schermen kennen die vorm.
  const oud = await vergelijk('module-zonder-recht', () => {
    wereld.conv = CONV(KLANTNUMMER);
    wereld.moduleContext = { module: 'events' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['onboarding.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  assert.equal(oud.antwoord.status, 403);
  assert.match(oud.antwoord.body.error, /events\.simone\.use/);
  assert.ok(!oud.spoor.some((s) => kop(s).startsWith('meta ')), 'er mag niets bij Meta aankomen');
});

test('LET OP: finance-rechten gelden impliciet ook voor de andere modules', async () => {
  // Dit is GEEN wijziging van mij -- het is wat main doet, en het is
  // verrassend genoeg om vast te pinnen. De grove poort kort af:
  //
  //   hasSimoneUse      = hasFinanceSend ? true : <opvragen>
  //   hasOnboardingSend = (finance || simone) ? true : <opvragen>
  //
  // Wie finance.inbox.send heeft, slaagt dus ook op een onboarding- of
  // events-gesprek, zonder dat die rechten ooit gecontroleerd zijn. Of dat de
  // bedoeling is, is een vraag voor Maxim; deze herbouw verandert het niet.
  const oud = await vergelijk('finance-kort-af', () => {
    wereld.conv = CONV(KLANTNUMMER);
    wereld.moduleContext = { module: 'onboarding' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  assert.equal(oud.antwoord.status, 200, 'main laat dit door; het nieuwe pad ook');
  // En de kortsluiting is zichtbaar in het spoor: na finance wordt er niets
  // meer opgevraagd.
  const rechten = oud.spoor.filter((s) => kop(s).startsWith('recht '));
  assert.deepEqual(rechten, ['recht finance.inbox.send'],
    'de andere twee rechten worden niet eens opgevraagd');
});

test('LIJNWISSEL: het gesprek wordt aan de huidige lijn gehecht', async () => {
  // Zonder deze stap blijft het gesprek aan het oude lijn-ID hangen en komt het
  // antwoord van de klant in een NIEUW, gesplitst gesprek terecht. Dat is het
  // tweede ding dat #1680 miste.
  const oud = await vergelijk('lijnwissel', () => {
    wereld.conv = CONV('OUDE_LIJN');
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = HOOFDNUMMER;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  const hecht = oud.spoor.find((s) => kop(s) === 'hecht-aan-lijn');
  assert.ok(hecht, 'hechtAanHuidigeLijn hoort aangeroepen te worden');
  assert.equal(hecht[1].pnId, 'OUDE_LIJN', 'met het gesprek zoals het was; de helper zoekt de opvolger zelf');

  // En de volgorde: eerst versturen, dan hechten. Andersom zou het gesprek al
  // verhuisd zijn terwijl het bericht nog over de oude lijn ging.
  const iMeta  = oud.spoor.findIndex((s) => kop(s).startsWith('meta '));
  const iHecht = oud.spoor.findIndex((s) => kop(s) === 'hecht-aan-lijn');
  assert.ok(iMeta >= 0 && iHecht > iMeta, 'versturen hoort vóór het hechten te komen');
});

test('TEMPLATE buiten het venster: zelfde weg, zelfde uitkomst', async () => {
  await vergelijk('template', () => {
    wereld.conv = CONV(HOOFDNUMMER, { last_inbound_at: new Date(Date.now() - 48 * 3600_000).toISOString() });
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    mode: 'template',
    template_name: 'aanmaning_dag7',
    template_components: [{ type: 'body', parameters: [{ type: 'text', text: 'Els' }] }],
  });
});

test('VRIJE TEKST buiten het venster: allebei 422, zelfde tekst', async () => {
  const oud = await vergelijk('venster-dicht', () => {
    wereld.conv = CONV(HOOFDNUMMER, { last_inbound_at: new Date(Date.now() - 48 * 3600_000).toISOString() });
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  assert.equal(oud.antwoord.status, 422);
  assert.equal(oud.antwoord.body.error, '24h_window_expired');
});

test('META weigert met 131047: allebei dezelfde 422 met source=meta', async () => {
  const fout = Object.assign(new Error('re-engagement'), { metaCode: 131047, metaSubcode: null, metaMessage: 'x', metaFbtrace: 'y' });
  const oud = await vergelijk('meta-131047', () => {
    wereld.conv = CONV(HOOFDNUMMER);
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = fout;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });

  assert.equal(oud.antwoord.status, 422);
  assert.equal(oud.antwoord.body.source, 'meta');
});

test('MEDIA: dezelfde weg voor een afbeelding', async () => {
  await vergelijk('media', () => {
    wereld.conv = CONV(HOOFDNUMMER);
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.rechten = ['finance.inbox.send'];
  }, {
    conversation_id: '11111111-1111-4111-8111-111111111111',
    mode: 'image',
    media_link: 'https://bucket.example/foto.jpg',
    caption: 'kijk',
  });
});

test('GESPREKKEN_V2 aan: de werkstand gaat ook in het nieuwe pad om', async () => {
  const oud = await vergelijk('werkstand', () => {
    wereld.conv = CONV(HOOFDNUMMER);
    wereld.moduleContext = { module: 'finance' };
    wereld.huidigeLijn = null;
    wereld.bezetteLijn = null;
    wereld.metaFout = null;
    wereld.gesprekkenV2 = true;
    wereld.rechten = ['finance.inbox.send'];
  }, { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: 'hallo' });
  wereld.gesprekkenV2 = false;

  const stand = oud.spoor.find((s) => kop(s) === 'update iris_gesprekken');
  assert.ok(stand, 'de werkstand hoort op wacht_op_klant te komen');
  assert.equal(stand[1].status, 'wacht_op_klant');
});

test('ONGELDIGE OPDRACHT: dezelfde 400 uit allebei', async () => {
  for (const [naam, body] of [
    ['geen conv', { mode: 'text', body: 'x' }],
    ['geen uuid', { conversation_id: 'nope', mode: 'text', body: 'x' }],
    ['rare mode', { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'duif' }],
    ['tekst leeg', { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'text', body: '  ' }],
    ['media zonder link', { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'image' }],
    ['media geen https', { conversation_id: '11111111-1111-4111-8111-111111111111', mode: 'image', media_link: 'http://x/y.jpg' }],
  ]) {
    await vergelijk('400 ' + naam, () => {
      wereld.conv = CONV(HOOFDNUMMER);
      wereld.moduleContext = { module: 'finance' };
      wereld.huidigeLijn = null;
      wereld.bezetteLijn = null;
      wereld.metaFout = null;
      wereld.rechten = ['finance.inbox.send'];
    }, body);
  }
});

// ── De bedrading ────────────────────────────────────────────────────────────

test('het endpoint is een omhulsel en doet het werk niet zelf', () => {
  const ep = lees('api/inbox-send.js');
  assert.ok(ep.split('\n').length < 120, 'inbox-send.js hoort klein te zijn');
  assert.match(ep, /verstuurInGesprek/);
  // Geen databank- of transportwerk meer in het endpoint zelf.
  assert.ok(!ep.includes("from('whatsapp_messages')"), 'het boeken hoort in de lib');
  assert.ok(!ep.includes('sendText'), 'het versturen hoort in de lib');
});

test('de lib gebruikt module-context EN lijn-aanhechting', () => {
  // Dit is de reden dat deze herbouw bestaat; een test erop zodat een volgende
  // extractie ze niet opnieuw laat vallen.
  const lib = lees('api/_lib/inbox-verzenden.js');
  assert.match(lib, /getModuleContextByPhoneNumberId\(db, conv\.phone_number_id, \{ customerId: conv\.customer_id \}\)/);
  assert.match(lib, /hechtAanHuidigeLijn\(db, conv\)/);
  assert.ok(!lib.includes("from('whatsapp_module_config')\n        .select('module')"),
    'de module hoort NIET uit een losse config-opvraging te komen');
});

test('de bevroren kopie is main van 12 oktober, met alleen andere importpaden', () => {
  // Wordt dit bestand ooit "even bijgewerkt", dan is de vergelijking leeg en
  // bewijst deze hele test niets meer.
  const vast = lees('tests/vast/inbox-send-20261012.js');
  assert.match(vast, /BEVROREN KOPIE/);
  assert.match(vast, /from '\.\.\/\.\.\/api\/supabase\.js'/);
  // Op de CODE, niet op de kop -- die legt juist uit waar de nieuwe lib staat.
  const code = vast.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((r) => r.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
  assert.ok(!code.includes('inbox-verzenden'), 'de bevroren kopie mag de nieuwe lib niet importeren');
  assert.ok(code.includes("from('whatsapp_messages')"), 'de bevroren kopie hoort het werk zelf nog te doen');
});
