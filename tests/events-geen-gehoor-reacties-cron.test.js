// tests/events-geen-gehoor-reacties-cron.test.js
//
// IEMAND ANTWOORDT ALSNOG, EN DE KLOK LOOPT DOOR.
//
// De automatisatie controleert ÉÉN keer of er iets binnenkwam: op het moment
// dat de wachtstap van 48 uur afloopt. Antwoordt iemand op dag één, dan ligt
// dat antwoord twee dagen in de inbox terwijl de deelnemer denkt dat het
// geregeld is. Deze cron loopt elke 15 minuten langs de lopende runs en meldt
// elk NIEUW bericht.
//
// Drie regels die deze test vastlegt:
//
//   1. IDEMPOTENT PER BERICHT-ID. Eén antwoord levert nooit twee mails op, ook
//      niet over vier cron-rondes. De ids gaan in
//      event_automation_runs.context.gemelde_reacties — geen nieuwe tabel, dus
//      geen cron die stuk staat tot een migratie gedraaid is.
//
//   2. EEN ID KOMT ER PAS IN NA EEN GESLAAGDE MAIL. Andersom zou een mislukte
//      verzending het antwoord voorgoed verstoppen.
//
//   3. NOOIT STIL SLAGEN. Kan de cron niets meten, dan is dat niet_gemeten met
//      een reden, en ok = false. 'Geen treffers' en 'kon niet meten' zijn twee
//      verschillende uitkomsten.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const BELSTATUS_AT = '2026-09-14T11:05:00.000Z';
const GENT         = '2026-09-26T17:00:00.000Z';

/**
 * Supabase-dubbelganger. Per tabel een vaste uitkomst; updates worden
 * onthouden zodat de test kan nakijken wat er in context terechtkomt.
 */
function nepAdmin(tabellen) {
  const updates = [];
  return {
    updates,
    from(tabel) {
      const conf = tabellen[tabel] || { data: [] };
      const st = { tabel };
      const antwoord = () => Promise.resolve(
        conf.error ? { data: null, error: { message: conf.error } }
                   : { data: conf.data || [], error: null },
      );
      const k = {
        select: () => k, eq: () => k, in: () => k, is: () => k, not: () => k,
        or: () => k, gte: () => k, lte: () => k, ilike: () => k, order: () => k,
        limit: () => k,
        update(v) { st.patch = v; updates.push({ tabel, patch: v }); return k; },
        maybeSingle: async () => (conf.error
          ? { data: null, error: { message: conf.error } }
          : { data: (conf.data || [])[0] || null, error: null }),
        single: async () => ({ data: (conf.data || [])[0] || null, error: null }),
        then: (r, j) => antwoord().then(r, j),
      };
      return k;
    },
  };
}

const AUTO = { id: 'auto-gg', name: 'Geen gehoor - laatste kans',
  trigger_config: { call_status: 'geen_gehoor' } };

const RUN = {
  id: 'run-1', automation_id: 'auto-gg', attendee_id: 'att-werner',
  event_id: 'ev-gent', status: 'active', context: {},
  started_at: '2026-09-14T11:06:00.000Z',
};

const WERNER = {
  id: 'att-werner', event_id: 'ev-gent', first_name: 'Werner', last_name: 'De Kesel',
  email: 'werner@test.be', phone: '+32470112233', status: 'aangemeld',
  call_status: 'geen_gehoor', call_status_at: BELSTATUS_AT,
};

const EVENT = { id: 'ev-gent', title: 'Forex Masterclass Gent', starts_at: GENT, location: 'Gent' };

const WA_IN = { id: 'm1', body: 'sorry, ik was op reis. ik kom zeker!',
  created_at: '2026-09-15T08:10:00.000Z', direction: 'in' };

async function draai({
  tabellen = {}, mailFaalt = false,
} = {}) {
  const admin = nepAdmin(tabellen);
  const verstuurd = [];
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      createUserClient: () => admin,
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/mailer.js'), {
    namedExports: {
      sendEventMail: async (m) => {
        verstuurd.push(m);
        if (mailFaalt) return { ok: false, error: 'SMTP weg' };
        return { ok: true };
      },
      sendMail: async () => ({ ok: true }),
      wrapEmailHtml: (t, b) => b,
    },
  });
  const mod = await import(url('api/cron-events-geen-gehoor-reacties.js') + '?t=' + Math.random());
  const res = { code: null, body: null,
    setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await mod.default({ method: 'GET', headers: {} }, res);
  return { uit: res.body, code: res.code, admin, verstuurd };
}

const VOLLEDIG = {
  event_automations     : { data: [AUTO] },
  event_automation_runs : { data: [RUN] },
  event_attendees       : { data: [WERNER] },
  events                : { data: [EVENT] },
  whatsapp_conversations: { data: [{ id: 'c1', phone_number: '+32470112233' }] },
  whatsapp_messages     : { data: [WA_IN] },
  email_messages        : { data: [] },
};

// ═══════════════════════════════════════════════════════════════════════════
// DE GELUKKIGE WEG
// ═══════════════════════════════════════════════════════════════════════════

test('een inkomend bericht levert één melding aan Maxim op', async (t) => {
  t.after(() => mock.reset());
  const { uit, code, verstuurd } = await draai({ tabellen: VOLLEDIG });

  assert.equal(code, 200);
  assert.equal(uit.ok, true);
  assert.equal(uit.niet_gemeten, false);
  assert.equal(uit.runs_bekeken, 1);
  assert.equal(uit.reacties, 1);
  assert.equal(uit.gemeld, 1);
  assert.equal(verstuurd.length, 1);
  assert.equal(verstuurd[0].to, 'maxim@deforexopleiding.nl');
});

test('de melding noemt naam, event, kanaal, tijdstip en de tekst', async (t) => {
  t.after(() => mock.reset());
  const { verstuurd } = await draai({ tabellen: VOLLEDIG });
  const m = verstuurd[0];

  assert.match(m.subject, /Reactie na geen gehoor: Werner De Kesel \(Forex Masterclass Gent\)/);
  assert.match(m.text, /Werner De Kesel heeft gereageerd via WhatsApp/);
  assert.match(m.text, /Forex Masterclass Gent/);
  // Tijdstip in Amsterdamse tijd: 15 september 08:10 UTC = 10:10 lokaal.
  assert.match(m.text, /dinsdag 15 september om 10:10/);
  assert.match(m.text, /sorry, ik was op reis\. ik kom zeker!/);
  assert.match(m.text, /werner@test\.be/);
});

test('de melding zegt dat de plek nog niet vervallen is, en wat de deadline was', async (t) => {
  t.after(() => mock.reset());
  const { verstuurd } = await draai({ tabellen: VOLLEDIG });
  // Zonder die twee moet Maxim het dossier erbij zoeken om te weten of hij nog
  // tijd heeft.
  assert.match(verstuurd[0].text, /De plek is NOG NIET vervallen/);
  assert.match(verstuurd[0].text, /Deadline in de mail: woensdag 16 september om 13:05/);
});

test('staat de inschrijving al op geannuleerd, dan zegt de mail dát in plaats van het tegendeel', async (t) => {
  t.after(() => mock.reset());
  const { verstuurd } = await draai({
    tabellen: { ...VOLLEDIG, event_attendees: { data: [{ ...WERNER, status: 'geannuleerd' }] } },
  });
  assert.match(verstuurd[0].text, /staat al op GEANNULEERD/);
  assert.doesNotMatch(verstuurd[0].text, /NOG NIET vervallen/);
});

// ═══════════════════════════════════════════════════════════════════════════
// IDEMPOTENTIE
// ═══════════════════════════════════════════════════════════════════════════

test('het bericht-id gaat in context.gemelde_reacties', async (t) => {
  t.after(() => mock.reset());
  const { admin } = await draai({ tabellen: VOLLEDIG });
  const u = admin.updates.find((x) => x.tabel === 'event_automation_runs');
  assert.ok(u, 'context hoort bijgewerkt te worden');
  assert.deepEqual(u.patch.context.gemelde_reacties, ['wa:m1']);
});

test('een al gemeld bericht levert GEEN tweede mail op', async (t) => {
  t.after(() => mock.reset());
  const { uit, verstuurd, admin } = await draai({
    tabellen: {
      ...VOLLEDIG,
      event_automation_runs: { data: [{ ...RUN, context: { gemelde_reacties: ['wa:m1'] } }] },
    },
  });
  assert.equal(verstuurd.length, 0);
  assert.equal(uit.gemeld, 0);
  assert.equal(uit.al_gemeld, 1);
  assert.equal(admin.updates.find((x) => x.tabel === 'event_automation_runs'), undefined,
    'niets te schrijven, dus geen schrijfactie');
});

test('een tweede, nieuw bericht wordt wél gemeld en bij de lijst gezet', async (t) => {
  t.after(() => mock.reset());
  const { uit, verstuurd, admin } = await draai({
    tabellen: {
      ...VOLLEDIG,
      event_automation_runs: { data: [{ ...RUN, context: { gemelde_reacties: ['wa:m1'] } }] },
      whatsapp_messages: { data: [WA_IN,
        { id: 'm2', body: 'is het nog gelukt?', created_at: '2026-09-15T09:00:00.000Z' }] },
    },
  });
  assert.equal(verstuurd.length, 1);
  assert.match(verstuurd[0].text, /is het nog gelukt\?/);
  assert.equal(uit.al_gemeld, 1);
  const u = admin.updates.find((x) => x.tabel === 'event_automation_runs');
  assert.deepEqual(u.patch.context.gemelde_reacties, ['wa:m1', 'wa:m2']);
});

test('de rest van context blijft ongemoeid', async (t) => {
  t.after(() => mock.reset());
  const { admin } = await draai({
    tabellen: {
      ...VOLLEDIG,
      event_automation_runs: { data: [{ ...RUN, context: { iets_anders: 'van een ander' } }] },
    },
  });
  const u = admin.updates.find((x) => x.tabel === 'event_automation_runs');
  assert.equal(u.patch.context.iets_anders, 'van een ander');
  assert.deepEqual(u.patch.context.gemelde_reacties, ['wa:m1']);
});

test('een MISLUKTE mail komt NIET in de lijst — anders is het antwoord voorgoed weg', async (t) => {
  t.after(() => mock.reset());
  const { uit, admin, verstuurd } = await draai({ tabellen: VOLLEDIG, mailFaalt: true });
  assert.equal(verstuurd.length, 1, 'er is wél een poging gedaan');
  assert.equal(uit.gemeld, 0);
  assert.equal(uit.mail_mislukt, 1);
  assert.equal(admin.updates.find((x) => x.tabel === 'event_automation_runs'), undefined,
    'niets weggeschreven, dus de volgende ronde probeert het opnieuw');
});

// ═══════════════════════════════════════════════════════════════════════════
// NOOIT STIL SLAGEN
// ═══════════════════════════════════════════════════════════════════════════

test('gemeten en niets binnengekomen is rustig, niet niet_gemeten', async (t) => {
  t.after(() => mock.reset());
  const { uit, verstuurd } = await draai({
    tabellen: { ...VOLLEDIG, whatsapp_messages: { data: [] } },
  });
  assert.equal(uit.ok, true);
  assert.equal(uit.niet_gemeten, false);
  assert.equal(uit.reacties, 0);
  assert.equal(uit.onmeetbaar.length, 0);
  assert.equal(verstuurd.length, 0);
});

test('een gefaalde hoofdquery is niet_gemeten met een reden, niet "alles rustig"', async (t) => {
  t.after(() => mock.reset());
  const { uit } = await draai({ tabellen: { event_automations: { error: 'timeout' } } });
  assert.equal(uit.ok, false);
  assert.equal(uit.niet_gemeten, true);
  assert.match(uit.reden, /timeout/);
});

test('een deelnemer zonder nummer en zonder mailadres is onmeetbaar, geen "geen reactie"', async (t) => {
  t.after(() => mock.reset());
  const { uit, verstuurd } = await draai({
    tabellen: { ...VOLLEDIG,
      event_attendees: { data: [{ ...WERNER, phone: null, email: null }] } },
  });
  assert.equal(uit.onmeetbaar.length, 1);
  assert.match(uit.onmeetbaar[0].reden, /geen telefoonnummer en geen e-mailadres/);
  assert.equal(verstuurd.length, 0);
  // Alle bekeken runs onmeetbaar → de hele ronde heeft niets gemeten.
  assert.equal(uit.ok, false);
  assert.equal(uit.niet_gemeten, true);
  assert.match(uit.reden, /geen enkele lopende run was meetbaar/);
});

test('een deelnemer zonder call_status_at is onmeetbaar — geen nulpunt', async (t) => {
  t.after(() => mock.reset());
  const { uit } = await draai({
    tabellen: { ...VOLLEDIG,
      event_attendees: { data: [{ ...WERNER, call_status_at: null }] } },
  });
  assert.equal(uit.onmeetbaar.length, 1);
  assert.match(uit.onmeetbaar[0].reden, /nulpunt/);
});

test('een verdwenen deelnemer is onmeetbaar en geen crash', async (t) => {
  t.after(() => mock.reset());
  const { uit } = await draai({
    tabellen: { ...VOLLEDIG, event_attendees: { data: [] } },
  });
  assert.equal(uit.onmeetbaar.length, 1);
  assert.match(uit.onmeetbaar[0].reden, /bestaat niet meer/);
});

test('geen automatisatie met deze trigger is een geldige uitkomst, niet een fout', async (t) => {
  t.after(() => mock.reset());
  const { uit } = await draai({ tabellen: { event_automations: { data: [] } } });
  assert.equal(uit.ok, true);
  assert.equal(uit.niet_gemeten, false);
  assert.equal(uit.automatisaties, 0);
  assert.match(uit.reden, /geen automatisatie met trigger_type on_call_status/);
});

test('één kapotte run blokkeert de rest van de batch niet', async (t) => {
  t.after(() => mock.reset());
  // Twee runs, en de attendee-lookup faalt voor allebei (de nep-databank kent
  // geen per-id-antwoord). Wat deze test bewijst: er wordt doorgelopen, en
  // beide komen in onmeetbaar in plaats van dat de handler stopt.
  const { uit } = await draai({
    tabellen: { ...VOLLEDIG,
      event_automation_runs: { data: [RUN, { ...RUN, id: 'run-2', attendee_id: 'att-2' }] },
      event_attendees: { error: 'kolom bestaat niet' } },
  });
  assert.equal(uit.runs_bekeken, 2);
  assert.equal(uit.onmeetbaar.length, 2);
  assert.equal(uit.ok, false);
  assert.equal(uit.niet_gemeten, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WIRING
// ═══════════════════════════════════════════════════════════════════════════

test('de cron staat elke 15 minuten in vercel.json', () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const rij = (vercel.crons || []).find((c) => c.path === '/api/cron-events-geen-gehoor-reacties');
  assert.ok(rij, 'anders draait hij nooit');
  assert.equal(rij.schedule, '*/15 * * * *');
});

test('alleen LOPENDE runs worden bekeken', () => {
  // Een run die al geannuleerd heeft is completed of exited, en dan is de zin
  // 'je plek is nog niet vervallen' onwaar.
  const bron = readFileSync(join(ROOT, 'api/cron-events-geen-gehoor-reacties.js'), 'utf8');
  assert.match(bron, /\.eq\('status', 'active'\)/);
});

test('de cron gebruikt dezelfde meting als de condition-check', () => {
  // Twee definities van 'heeft geantwoord' zou betekenen dat deze cron
  // 'gereageerd' meldt terwijl de automatisatie een uur later de plek afneemt.
  const bron = readFileSync(join(ROOT, 'api/cron-events-geen-gehoor-reacties.js'), 'utf8');
  assert.match(bron, /from '\.\/_lib\/events-geen-gehoor-reactie\.js'/);
  assert.match(bron, /from '\.\/_lib\/geen-gehoor-deadline\.js'/);
});

test('de cron zit achter CRON_SECRET en weigert andere methodes', () => {
  const bron = readFileSync(join(ROOT, 'api/cron-events-geen-gehoor-reacties.js'), 'utf8');
  assert.match(bron, /checkCronAuth\(req\)/);
  assert.match(bron, /Method not allowed/);
});
