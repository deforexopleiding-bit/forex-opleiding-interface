// tests/aanmeldingen-per-funnel.test.js
//
// "Leads per traject" telt sinds 2026-10-25 AANMELDINGEN PER FUNNEL uit de bron
// zelf (api/_lib/aanmeldingen-per-funnel.js):
//   1. 7-daagse/mini = funnelmeting ∪ nieuwe leads, één per persoon; heraanmelding
//      telt, gemiste meting telt, nooit lager dan de oude telling;
//   2. event = event_attendees + apart de afgewezen aanmelders; webinar = tabel;
//   3. Overig vangt de rest; KOP = som van de tegels;
//   4. lezen: venster op elke bron, paging, fail-soft per bron;
//   5. bedrading: endpoint, v2-dashboard, tv-bord; webinar-lead-vangnet.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sent = [];
mock.module('../api/_lib/email.js', {
  namedExports: { sendMail: async (m) => { sent.push(m); return { sent: true }; } },
});

const A = await import('../api/_lib/aanmeldingen-per-funnel.js');
const W = await import('../api/public-webinar-aanmelding.js');
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const fe = (session_id, variant, event_type, lead_id = null) => ({ session_id, variant, event_type, lead_id });

test('7-daagse/mini: funnelmeting ∪ nieuwe leads, één per persoon, afgewezen apart', () => {
  const r = A.telAanmeldingen({
    funnelEvents: [
      fe('s1', '7-daagse-v5', 'lead_ingediend', 'L1'), fe('s1', '7-daagse-v5', 'toegang', 'L1'),   // nieuwe lead, ook gemeten
      fe('s2', '7-daagse-v6', 'lead_ingediend', 'L9'), fe('s2', '7-daagse-v6', 'geen_toegang', 'L9'), // HERaanmelding (L9 is oud)
      fe('s3', '7-daagse-v2', 'lead_ingediend'),                                                     // gemeten, lead niet gekoppeld
      fe('s4', '7-daagse-v2', 'landing'),                                                            // geen aanmelding
      fe('s5', 'kennismakingscursus-v10', 'lead_ingediend', 'L3'),
      fe('s6', 'strategiesessie-v1', 'lead_ingediend', 'L4'),                                        // Flow D = mini
    ],
    nieuweLeads: [
      { id: 'L1', email: 'a@x.nl', bron: '7-daagse-v5', traject: '7-daagse', afwijzer: false },
      { id: 'L2', email: 'b@x.nl', bron: '7-daagse-v5', traject: '7-daagse', afwijzer: true },     // meting gemist (adblocker)
      { id: 'L3', email: 'c@x.nl', bron: 'kennismakingscursus-v10', traject: 'minicursus', afwijzer: false },
      { id: 'L5', email: 'e@x.nl', bron: 'website', traject: '7-daagse', afwijzer: false },        // site-formulier
      { id: 'LT', email: 'test@x.nl', bron: '7-daagse-v5', traject: '7-daagse', afwijzer: false }, // test telt nergens
    ],
  });
  assert.deepEqual(r.tegels['7-daagse'], { totaal: 5, toegelaten: 3, afgewezen: 2 });   // L1, L9(afg), s3, L2(afg), L5
  assert.deepEqual(r.tegels.mini, { totaal: 2, toegelaten: 2, afgewezen: 0 });          // L3, L4
});

test('event: aanmeldingen + apart de afgewezen aanmelders; webinar uit de tabel', () => {
  const r = A.telAanmeldingen({
    eventAanmeldingen: [
      { id: 'e1', email: 'a@x.nl', status: 'aangemeld', is_test: false },
      { id: 'e2', email: 'b@x.nl', status: 'aangemeld', is_test: false },
      { id: 'e3', email: 'c@x.nl', status: 'switched_to_other_event', is_test: false },   // verplaatst: telt via de nieuwe rij
      { id: 'e4', email: 'd@x.nl', status: 'aangemeld', is_test: true },
    ],
    eventInzendingen: [
      { email: 'a@x.nl', resultaat: 'toegelaten' },
      { email: 'x@x.nl', resultaat: 'afgewezen' },
      { email: 'X@x.nl', resultaat: 'afgewezen' },     // zelfde persoon → 1
      { email: 'y@x.nl', resultaat: 'afgewezen' },
      { email: 'y@x.nl', resultaat: 'toegelaten' },    // tweede poging toegelaten → niet afgewezen
      { email: 'b@x.nl', resultaat: 'afgewezen' },     // toch aangemeld → niet afgewezen
    ],
    webinarAanmeldingen: [{ id: 'w1', email: 'p@x.nl', is_test: false }, { id: 'w2', email: 'q@x.nl', is_test: true }],
  });
  assert.deepEqual(r.tegels.event, { totaal: 3, toegelaten: 2, afgewezen: 1 });
  assert.deepEqual(r.tegels.webinar, { totaal: 1, toegelaten: 1, afgewezen: 0 });
});

test('Overig + kop: elke nieuwe lead landt precies één keer; kop = som van de tegels', () => {
  const r = A.telAanmeldingen({
    funnelEvents: [
      fe('s1', 'strategiescan-v1', 'lead_ingediend', 'L1'),
      fe('s2', 'training-22-10-26', 'lead_ingediend'),
      fe('s3', 'the-lab-v1', 'lead_ingediend', 'L6'),          // Lab telt uit lab_aanmeldingen
      fe('s4', 'webinar-v1', 'lead_ingediend', 'L7'),          // webinar telt uit de tabel
    ],
    nieuweLeads: [
      { id: 'L1', email: 'a@x.nl', bron: 'strategiescan-v1', traject: 'strategiescan' },
      { id: 'L2', email: 'b@x.nl', bron: 'training-22-10-26', traject: null },
      { id: 'L3', email: 'c@x.nl', bron: 'opstartsessie', traject: 'opstartsessie' },
      { id: 'L4', email: 'd@x.nl', bron: 'website', traject: 'Membership' },
      { id: 'L5', email: 'e@x.nl', bron: 'handmatig', traject: null },
      { id: 'L6', email: 'f@x.nl', bron: 'the-lab-v1', traject: 'the-lab' },
      { id: 'L7', email: 'g@x.nl', bron: 'webinar-v1', traject: 'webinar' },   // niet in Overig
      { id: 'L8', email: 'h@x.nl', bron: 'event-1', traject: 'event' },        // niet in Overig
    ],
    labAanmeldingen: [{ email: 'F@x.nl' }, { email: 'z@x.nl' }],
    webinarAanmeldingen: [{ id: 'w', email: 'g@x.nl' }],
    eventAanmeldingen: [{ id: 'e', email: 'h@x.nl', status: 'aangemeld' }],
  });
  assert.deepEqual(r.tegels.overig.delen, { 'the-lab': 2, strategiescan: 1, training: 2, opstartsessie: 1, rest: 2 });
  assert.equal(r.tegels.overig.totaal, 8);
  const som = Object.values(r.tegels).reduce((a, t) => a + t.totaal, 0);
  assert.equal(r.totaal, som, 'kop = som van de tegels');
  assert.equal(r.totaal, 8 + 1 + 1);   // overig + webinar + event
});

test('lezen: venster op elke bron, paging, fail-soft per bron', async () => {
  const gelezen = [];
  const rijen = {
    funnel_events: Array.from({ length: 1500 }, (_, i) => fe('s' + i, '7-daagse-v5', 'lead_ingediend')),
    leads: [{ id: 'L1', email: 'a@x.nl', bron: 'website', traject: 'Membership' }],
    webinar_aanmeldingen: [{ id: 'w1', email: 'w@x.nl' }],
  };
  const sb = {
    from(tabel) {
      const q = { tabel, filters: [] };
      gelezen.push(q);
      const k = {
        select: () => k, is: () => k, in: (c, v) => { q.filters.push(['in', c, v]); return k; },
        gte: (c, v) => { q.filters.push(['gte', c, v]); return k; }, lt: (c, v) => { q.filters.push(['lt', c, v]); return k; },
        order: () => k,
        range: (a, b) => {
          if (tabel === 'lab_aanmeldingen') return Promise.resolve({ data: null, error: { message: 'stuk' } });
          return Promise.resolve({ data: (rijen[tabel] || []).slice(a, b + 1), error: null });
        },
      };
      return k;
    },
  };
  const range = { start: new Date('2026-10-24T22:00:00Z'), endExclusive: new Date('2026-10-25T22:00:00Z') };
  const r = await A.computeAanmeldingenPerFunnel({ supabaseAdmin: sb, range });
  assert.equal(r.tegels['7-daagse'].totaal, 1500, 'twee pagina\'s gelezen');
  assert.equal(r.tegels.webinar.totaal, 1);
  assert.equal(r.tegels.overig.delen.rest, 1);
  assert.deepEqual(r.bronfouten, ['lab_aanmeldingen']);
  const venster = { funnel_events: 'ts', leads: 'aangemaakt', event_attendees: 'created_at', event_kwalificatie_submissions: 'created_at', webinar_aanmeldingen: 'created_at', lab_aanmeldingen: 'aangemaakt' };
  for (const [tabel, kol] of Object.entries(venster)) {
    const q = gelezen.find((x) => x.tabel === tabel);
    assert.ok(q, tabel);
    assert.deepEqual(q.filters.find((f) => f[0] === 'gte'), ['gte', kol, range.start.toISOString()], tabel);
    assert.deepEqual(q.filters.find((f) => f[0] === 'lt'), ['lt', kol, range.endExclusive.toISOString()], tabel);
  }
});

test('webinar-vangnet: lead_id mee → niets; bestaande lead → die; anders upsert; faalt alles → alarm', async () => {
  const w = { voornaam: 'Jan', email: 'jan@x.nl', telefoon: '+31600000000', bron: 'webinar-v2', toestemming: true };
  const sb = (opts) => ({
    calls: [],
    from() { const k = { select: () => k, ilike: () => k, is: () => k, limit: async () => ({ data: opts.bestaand ? [{ id: 'OUD' }] : [], error: null }) }; return k; },
    async rpc(naam, args) { this.calls.push(args.p); return opts.rpcFout ? { data: null, error: { message: 'kapot' } } : { data: [{ id: 'NIEUW' }], error: null }; },
  });
  assert.equal(await W.zorgVoorLead(sb({}), { ...w, leadId: 'GEGEVEN' }), 'GEGEVEN');
  assert.equal(await W.zorgVoorLead(sb({ bestaand: true }), w), 'OUD');
  const s1 = sb({});
  assert.equal(await W.zorgVoorLead(s1, w), 'NIEUW');
  assert.equal(s1.calls[0].traject, 'webinar');
  assert.equal(s1.calls[0].bron, 'webinar-v2');
  let gealarmeerd = null;
  assert.equal(await W.zorgVoorLead(sb({ rpcFout: true }), w, async (x, fout) => { gealarmeerd = fout; }), null);
  assert.match(gealarmeerd, /upsert_lead: kapot/);
  // Standaard-alarm = een mail.
  sent.length = 0;
  await W.zorgVoorLead(sb({ rpcFout: true }), w);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /Webinar-aanmelding zonder lead/);
  assert.match(lees('api/public-webinar-aanmelding.js'), /const leadId = await zorgVoorLead\(supabaseAdmin, v\.waarden\);\s+const r = await meldAan\(supabaseAdmin, \{ \.\.\.v\.waarden, leadId \}\);/);
});

test('bedrading: endpoint, v2-dashboard (tegels + Overig + kop), tv-bord', () => {
  const ep = lees('api/leads-per-traject-count.js');
  assert.match(ep, /computeAanmeldingenPerFunnel\(\{ supabaseAdmin, range \}\)/);
  assert.match(ep, /out\.aanmeldingen = aanmeldingen;/);
  const d = lees('modules/klanten-v2/views/dashboard-v2.js');
  assert.match(d, /const am = lp && lp\.aanmeldingen && lp\.aanmeldingen\.tegels \? lp\.aanmeldingen : null;/);
  for (const t of ["'7-daagse'", "'Event-aanmeldingen'", "'Webinar'", "'Mini cursus'", "'Overig'"]) assert.ok(d.includes('tiles.push([' + t), t);
  assert.match(d, /aangemeld · <span style="color:var\(--rose\);font-weight:600">\$\{tg\('event'\)\.afgewezen\}<\/span> afgewezen/);
  assert.match(d, /\$\{am\.totaal\}<\/b> aanmeldingen · \$\{per\}/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/dashboard-v2\.js\?v=36"/);
  const dm = lees('api/display-metrics.js');
  assert.match(dm, /computeAanmeldingenPerFunnel\(\{ supabaseAdmin, range: \{ start: dayStart, endExclusive: dayEnd \} \}\)/);
  assert.match(dm, /const aanmeldingen\s+= pick\(30, null\);/);
  assert.match(dm, /\{ key: 'overig',\s+label: 'Overig',\s+count: T\.overig\.totaal \}/);
  const tv = lees('display.html');
  // Kop "nieuwe leads per bron" = som van de tegels, calls tellen NIET mee.
  assert.match(tv, /if \(b\.key !== 'calls' && b\.count != null\) som \+=/);
  assert.match(tv, /Nieuwe leads per bron/);
});
