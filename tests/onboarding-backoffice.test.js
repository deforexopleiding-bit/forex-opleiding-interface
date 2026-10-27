// tests/onboarding-backoffice.test.js — de backoffice van de nieuwe onboarding
// (27 okt 2026): tab "Onboarding" in het detailvenster, de KPI-tegel en het
// icoontje in de lijst, en de serverkant die dat voedt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import { kaartStand, interesseVan, automationPerOnboarding, leesPortalStand } from '../api/_lib/onboarding-portal-stand.js';
import { portalLink, portalBasis, klassiekPad, PORTAL_URL_STANDAARD } from '../api/_lib/onboarding-link.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('portal-link: env of standaard, code met streepje, nooit zonder geldige code', () => {
  assert.equal(portalBasis(''), PORTAL_URL_STANDAARD);
  assert.equal(portalBasis('https://staging.example.com/onboarding/'), 'https://staging.example.com/onboarding');
  assert.equal(portalBasis('http://onveilig.example'), PORTAL_URL_STANDAARD);
  assert.equal(portalLink('ABCD2345', ''), 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  assert.equal(portalLink(null, ''), null);
  assert.equal(portalLink('fout', ''), null);
  assert.equal(klassiekPad('abc'), '/modules/onboarding.html?t=abc');
});

test('kaartStand: open / ingepland / afgesloten met reden, belpogingen geteld', () => {
  const open = kaartStand({ id: 'k', status: 'open', due: '2026-10-28' }, [
    { soort: 'call', richting: 'uit', resultaat: 'niet opgenomen' },
    { soort: 'call', richting: 'uit', resultaat: 'gesproken' },
  ]);
  assert.equal(open.stand, 'open');
  assert.equal(open.belpogingen, 2);
  assert.equal(kaartStand({ status: 'ingepland', afspraak_ref: { scheduled_at: '2026-10-30T09:00:00Z' } }).ingepland_op, '2026-10-30T09:00:00Z');
  const dicht = kaartStand({ status: 'gearchiveerd', archief_reden: 'klant_trok_interesse_in', reden_code: 'klant_trok_interesse_in' });
  assert.equal(dicht.stand, 'afgesloten');
  assert.equal(kaartStand(null), null);
});

test('interesse: kolom eerst, anders terugval op answers (ook oude wizard)', () => {
  assert.equal(interesseVan({ automation_interesse: 'ja' }), 'ja');
  assert.equal(interesseVan({ answers: { robot_interesse: 'ja_interesse' } }), 'ja');
  assert.equal(interesseVan({ answers: { robot_interesse: 'nee' } }), 'nee');
  assert.equal(interesseVan({ answers: { robot_interesse: 'laterbespreken' } }), null);
  assert.equal(interesseVan({}), null);
});

function nepDb({ fouten = {}, onboardings = [], taken = [] } = {}) {
  return {
    from(t) {
      let filters = [];
      const rijen = t === 'onboardings' ? onboardings : t === 'opvolging_taken' ? taken : [];
      const veld = (r, k) => (k.includes('->>') ? (r[k.split('->>')[0]] || {})[k.split('->>')[1]] : r[k]);
      const voer = () => {
        if (fouten[t]) return { data: null, error: fouten[t] };
        return { data: rijen.filter((r) => filters.every((f) => f(r))), error: null };
      };
      const q = {
        select() { return q; }, limit() { return q; },
        eq(k, v) { filters.push((r) => veld(r, k) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(veld(r, k))); return q; },
        maybeSingle() { const r = voer(); return Promise.resolve(r.error ? r : { data: r.data[0] || null, error: null }); },
        then(ok, nok) { return Promise.resolve(voer()).then(ok, nok); },
      };
      return q;
    },
  };
}

test('lijst: per onboarding interesse + kaartstatus; faalzacht bij een databankfout', async () => {
  const db = nepDb({
    onboardings: [{ id: 'a', automation_interesse: 'ja' }, { id: 'b', automation_interesse: 'nee' }],
    taken: [{ lijst: 'dag', reden: 'automation_interesse', status: 'ingepland', bron_ref: { onboarding_id: 'a' } }],
  });
  const m = await automationPerOnboarding(db, [{ id: 'a' }, { id: 'b' }, { id: 'c', answers: { robot_interesse: 'ja_interesse' } }]);
  assert.deepEqual(m.get('a'), { interesse: 'ja', kaart_status: 'ingepland' });
  assert.deepEqual(m.get('b'), { interesse: 'nee', kaart_status: null });
  assert.deepEqual(m.get('c'), { interesse: 'ja', kaart_status: null });
  const stuk = await automationPerOnboarding(nepDb({ fouten: { onboardings: { message: 'x' }, opvolging_taken: { message: 'y' } } }), [{ id: 'a' }]);
  assert.equal(stuk.size, 0);
});

test('detail: startcode/portal-link/automation, en zonder kolommen gewoon nulls', async () => {
  const db = nepDb({
    onboardings: [{ id: 'a', startcode: 'ABCD2345', automation_interesse: 'ja', automation_interesse_op: '2026-10-27T10:00:00Z', automation_belmoment: ['avond'] }],
  });
  const p = await leesPortalStand(db, { id: 'a', answers: {} });
  assert.equal(p.startcode_fmt, 'ABCD-2345');
  assert.equal(p.portal_link, 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  assert.equal(p.automation.interesse, 'ja');
  assert.deepEqual(p.automation.belmoment, ['avond']);
  const leeg = await leesPortalStand(nepDb({ fouten: { onboardings: { code: '42703', message: 'kolom' }, opvolging_taken: { message: 'x' } } }),
    { id: 'a', answers: { robot_interesse: 'nee' } });
  assert.equal(leeg.startcode, null);
  assert.equal(leeg.automation.interesse, 'nee');
  assert.equal(leeg.automation.kaart, null);
});

test('detail-endpoint en lijst geven het blok mee', () => {
  assert.match(lees('api/onboarding-detail.js'), /const portal = await leesPortalStand\(supabaseAdmin, row\)/);
  assert.match(lees('api/onboarding-detail.js'), /\n\s+portal,\n/);
  assert.match(lees('api/_lib/onboarding-overzicht-rijen.js'), /automation:\s+automationByOb\.get\(r\.id\) \|\| null/);
});

// ── Het detailvenster, echt getekend (jsdom) ──────────────────────────────

async function openDetail(onboarding) {
  const dom = new JSDOM('<!doctype html><body><div id="dfoModal"></div></body>', { url: 'https://crm.example/modules/klanten-v2/' });
  const vorige = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator };
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const box = dom.window.document.getElementById('dfoModal');
  window.KV = {
    esc: (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    toast: () => {},
    authedJson: async (url) => {
      if (url.startsWith('/api/onboarding-detail')) return { onboarding };
      if (url.startsWith('/api/mentor-admin-list')) return { mentors: [] };
      return { items: [] };
    },
  };
  window.DFO = { openModal: ({ head, body, foot }) => { box.innerHTML = head + body + foot; }, closeModal: () => {} };
  const mod = await import('../modules/klanten-v2/views/modals/onboarding-detail.js?t=' + Math.random());
  await mod.openOnboardingDetailModal({ onboardingId: onboarding.id });
  box.querySelector('[data-kv-onb-tab="vragenlijst"]').click();
  const html = box.innerHTML;
  const tabTekst = box.querySelector('[data-kv-onb-tab="vragenlijst"]').textContent;
  globalThis.window = vorige.window; globalThis.document = vorige.document;
  return { html, tabTekst, box };
}

const BASIS = {
  id: '11111111-2222-4333-8444-555555555555', customer_name: 'Wim Peeters', status: 'bezig',
  answers: {
    coaching_locatie_voorkeur: 'bootcamp_dan_online', ervaring_trading: 'gemiddeld', motivatie_primair: 'extra_inkomen',
    commitment_uren_per_week: 10, beschikbaarheid: { ma: ['avond'], za: ['ochtend', 'middag'] }, robot_interesse: 'ja_interesse',
  },
};

test('tab "Onboarding": startcode + kopieerknoppen, leesbare antwoorden, raster, automation met kaartstand', async () => {
  const { html, tabTekst } = await openDetail({
    ...BASIS,
    portal: {
      startcode: 'ABCD2345', startcode_fmt: 'ABCD-2345', portal_link: 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345',
      automation: { interesse: 'ja', op: '2026-10-27T10:00:00Z', belmoment: ['avond', 'weekend'],
        kaart: { id: 'k', stand: 'open', status: 'open', belpogingen: 2, due: '2026-10-28' } },
    },
  });
  assert.equal(tabTekst.trim(), 'Onboarding');
  assert.match(html, /ABCD-2345/);
  assert.match(html, /data-kv-onb-copy="code"/);
  assert.match(html, /data-kv-onb-copy="link"/);
  assert.match(html, /Portal-link kopiëren/);
  // Labels, geen ruwe waarden.
  assert.match(html, /Bootcamp op kantoor, daarna online/);
  assert.match(html, /1 – 3 jaar/);
  assert.match(html, /Extra inkomen/);
  assert.match(html, /10\+ uur per week/);
  assert.doesNotMatch(html, />bootcamp_dan_online</);
  // Raster: 7 dagen × 4 dagdelen, 3 aan.
  assert.match(html, /3 momenten aangeduid/);
  assert.equal((html.match(/title="(Ma|Di|Wo|Do|Vr|Za|Zo) /g) || []).length, 28);
  // Automation.
  assert.match(html, /Ja, wil gebeld worden/);
  assert.match(html, /Avond, Zaterdag/);
  assert.match(html, /Open bij Dave · 2× gebeld/);
  assert.match(html, /Open in Opvolging/);
});

test('tab "Onboarding": zonder startcode, zonder antwoorden, kaart dicht door de klant', async () => {
  const { html } = await openDetail({
    ...BASIS, answers: {},
    portal: { startcode: null, automation: { interesse: 'nee', kaart: { stand: 'afgesloten', status: 'gearchiveerd', reden_code: 'klant_trok_interesse_in', gearchiveerd_at: '2026-10-27T10:00:00Z' } } },
  });
  assert.match(html, /Nog geen startcode/);
  assert.match(html, /Geen beschikbaarheid opgegeven/);
  assert.match(html, /de klant trok zijn interesse in/);
});

test('lijst: KPI-tegel Automation-interesse die filtert, violet icoontje, cache-busters opgehoogd', () => {
  const v = lees('modules/klanten-v2/views/onboarding-v2.js');
  assert.match(v, /label: 'Automation-interesse'/);
  assert.match(v, /click: 'window\.__onbAutoFilter\(\)'/);
  assert.match(v, /autoFilter\(raw\) \|\| startFilter\(raw\)/);
  assert.match(v, /class="kv-onb-auto"/);
  assert.match(v, /import\('\.\/modals\/onboarding-detail\.js\?v=2'\)/);
  assert.match(lees('modules/klanten-v2/klanten-v2.css'), /\.kv-onb-auto \{[^}]*#6D3FD4/);
  const idx = lees('modules/klanten-v2/index.html');
  assert.match(idx, /views\/onboarding-v2\.js\?v=20/);
  assert.match(idx, /klanten-v2\.css\?v=1r15/);
});
