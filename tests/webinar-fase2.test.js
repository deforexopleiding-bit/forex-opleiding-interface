// tests/webinar-fase2.test.js
//
// Webinar fase 2 (2026-10-12): tijdens het webinar een QR naar de boekingslink
// https://deforexopleiding.nl/agenda/webinar (gratis strategie-scan met Dave).
// Karl (host) krijgt 3% via de BESTAANDE setter-opzet — geen nieuwe logica:
//   booking_sources 'webinar'.owner_user_id = Karl
//   → follow_up_appointments.setter_user_id = Karl  (createAppointmentForLead)
//   → deals.setter_user_id                          (sales-deal-create)
//   → commissie pct uit setter_config               (berekenCommissieMutaties)
// Bewaakt hier: de QR (inhoud + endpoint), de keten bij een boeking via
// 'webinar', 3% voor Karl in de commissie-berekening, monthly_fee 0 geeft geen
// €0-rapport, en het SQL-bestand (alleen Karls setter_config; dry-run niet aangeraakt).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const KARL = 'fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7';
const LINK = 'https://deforexopleiding.nl/agenda/webinar';

// ── 1. QR ────────────────────────────────────────────────────────────────────
test('QR: PNG + SVG van precies de boekingslink, groot genoeg voor een scherm', async () => {
  const { webinarQr, WEBINAR_BOEKINGSLINK } = await import(url('api/webinar-admin.js'));
  assert.equal(WEBINAR_BOEKINGSLINK, LINK);
  const q = await webinarQr();
  assert.equal(q.url, LINK);
  assert.match(q.png, /^data:image\/png;base64,/);
  assert.match(q.svg, /^<svg[\s\S]*<\/svg>\s*$/);
  // Inhoud: de QR codeert exact de link (zelfde symbool als QRCode.create).
  const sym = QRCode.create(LINK, { errorCorrectionLevel: 'M' });
  assert.equal(sym.segments.map((s) => Buffer.from(s.data).toString('utf8')).join(''), LINK);
  // PNG is 1024 px breed (IHDR-breedte uit de PNG-header).
  const buf = Buffer.from(q.png.split(',')[1], 'base64');
  assert.equal(buf.readUInt32BE(16), 1024);
  assert.equal(q.png, await QRCode.toDataURL(LINK, { errorCorrectionLevel: 'M', margin: 2, width: 1024, color: { dark: '#10284A', light: '#FFFFFF' } }));
});

async function roepAdmin(query, { mag = true } = {}) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: { from: () => { throw new Error('geen DB nodig voor de QR'); } },
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
    },
  });
  const gevraagd = [];
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async (_req, p) => { gevraagd.push(p); return mag; } } });
  try {
    const mod = await import(url('api/webinar-admin.js') + '?t=' + Math.random());
    let status = 200; let body = null;
    await mod.default({ method: 'GET', query, headers: {} }, { setHeader() {}, status(s) { status = s; return this; }, json(b) { body = b; return this; } });
    return { status, body, gevraagd };
  } finally { mock.reset(); }
}

test('QR-endpoint: GET /api/webinar-admin?qr=1 → { url, png, svg }; recht events.event.view', async () => {
  const r = await roepAdmin({ qr: '1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.url, LINK);
  assert.match(r.body.png, /^data:image\/png;base64,/);
  assert.deepEqual(r.gevraagd, ['events.event.view']);
  const geen = await roepAdmin({ qr: '1' }, { mag: false });
  assert.equal(geen.status, 403);
});

test('Webinar-module: QR-kaart met groot tonen + PNG-download; cache-buster', () => {
  const v = lees('modules/klanten-v2/views/webinar-v2.js');
  assert.match(v, /authedJson\('\/api\/webinar-admin\?qr=1'\)/);
  assert.match(v, /download="webinar-strategie-scan-qr\.png"/);
  assert.match(v, /__wbQrGroot\(true\)/);
  assert.match(v, /\$\{qrHtml\(\)\}/);
  assert.ok(Number((lees('modules/klanten-v2/index.html').match(/views\/webinar-v2\.js\?v=(\d+)"/) || [])[1]) >= 3, 'webinar-v2 minstens v3');
  assert.match(lees('package.json'), /"qrcode": "\^1\.5\.4"/);
});

// ── 2. Keten: boeking via /agenda/webinar → setter Karl ──────────────────────
test('boeking via slug "webinar": booking_source=webinar + setter_user_id=Karl; call bij Dave (vaste agenda)', async () => {
  process.env.GHL_CALENDAR_ID = 'cal-1'; process.env.GHL_LOCATION_ID = 'loc-1'; process.env.GHL_DAVE_USER_ID = 'ghl-dave';
  const inserts = []; const ghl = [];
  const booking_sources = [{ slug: 'webinar', label: 'webinar qr', actief: true, owner_user_id: KARL }];
  const db = {
    from(t) {
      const f = {}; let rij = null;
      const k = {
        select: () => k, eq: (c, v) => { f[c] = v; return k; },
        insert: (r) => { rij = r; inserts.push({ t, r }); return k; },
        maybeSingle: async () => {
          if (t === 'booking_sources') return { data: booking_sources.find((b) => b.slug === f.slug && b.actief === f.actief) || null, error: null };
          if (t === 'follow_up_appointments' && rij) return { data: { id: 'appt-1', ...rij }, error: null };
          return { data: null, error: null };
        },
        then: (ok) => Promise.resolve({ data: null, error: null }).then(ok),
      };
      return k;
    },
  };
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db } });
  mock.module(url('api/_lib/ghl-appointment.js'), { namedExports: { createGhlAppointment: async (a) => { ghl.push(a); return { id: 'ghl-appt-1' }; } } });
  try {
    const { createAppointmentForLead } = await import(url('api/_lib/create-appointment-from-lead.js') + '?t=' + Math.random());
    await createAppointmentForLead({
      lead: { id: 'lead-1', lead_name: 'Webinar Deelnemer', lead_email: 'deelnemer@example.com', lead_phone: '+31612345678', source_ref: { ghl_contact_id: 'ghl-contact-1' } },
      scheduledAt: '2026-10-20T08:00:00Z', durationMinutes: 20, source: 'webinar',
    });
  } catch (e) {
    // Fail-soft stappen na de insert (tags e.d.) mogen hier niets uitmaken.
    if (!inserts.some((i) => i.t === 'follow_up_appointments')) throw e;
  } finally { mock.reset(); }
  const appt = inserts.find((i) => i.t === 'follow_up_appointments').r;
  assert.equal(appt.booking_source, 'webinar');
  assert.equal(appt.setter_user_id, KARL, 'setter = Karl (eigenaar van de webinar-link)');
  assert.equal(ghl[0].assignedUserId, 'ghl-dave', 'de call zelf staat in Daves agenda');
});

test('deal-attributie: sales-deal-create neemt setter_user_id van de oudste boeking (e-mail, dan telefoon)', () => {
  const src = lees('api/sales-deal-create.js');
  assert.match(src, /from\('follow_up_appointments'\)\s*\n\s*\.select\('setter_user_id, scheduled_at'\)\s*\n\s*\.ilike\('lead_email', email\)\s*\n\s*\.not\('setter_user_id', 'is', null\)\s*\n\s*\.order\('scheduled_at', \{ ascending: true \}\)/);
});

// ── 3. Commissie: Karl 3% via dezelfde motor als Romy ────────────────────────
test('commissie: met Karls setter_config (3%) → 3% van wat de klant betaalde; zonder config → niets', async () => {
  const { berekenCommissieMutaties } = await import(url('api/_lib/setter-commissie-core.js'));
  const cfg = { user_id: KARL, pct: 3.00, is_active: true, effective_from: '2026-10-12', monthly_fee: 0 };
  const deal = { id: 'deal-1', customer_id: 'klant-1', setter_user_id: KARL, status: 'won' };
  const inv = { id: 'inv-1', invoice_number: 'F-2026-0100', customer_id: 'klant-1', status: 'paid', amount_total: 2420, amount_paid: 2420, credited_amount: 0, paid_date: '2026-10-20' };
  const r = berekenCommissieMutaties({ setterId: KARL, cfg, facturen: [{ inv, deal, bron: 'deal' }], bestaand: [] });
  assert.equal(r.mutaties.length, 1, JSON.stringify(r.overgeslagen));
  assert.equal(r.mutaties[0].setter_user_id, KARL);
  assert.equal(r.mutaties[0].pct, 3);
  assert.equal(r.mutaties[0].amount, 72.6, '3% van 2420');
  const zonder = berekenCommissieMutaties({ setterId: KARL, cfg: null, facturen: [{ inv, deal, bron: 'deal' }], bestaand: [] });
  assert.equal(zonder.mutaties.length, 0);
  assert.equal(zonder.overgeslagen[0].reden, 'geen_setter_config', 'vóór de SQL: Karl krijgt niets');
  const vooraf = berekenCommissieMutaties({ setterId: KARL, cfg, facturen: [{ inv: { ...inv, paid_date: '2026-10-01' }, deal, bron: 'deal' }], bestaand: [] });
  assert.equal(vooraf.overgeslagen[0].reden, 'betaald_voor_effective_from');
});

test('maandrapport: monthly_fee 0 → geen vaste vergoeding (geen €0-regel)', async () => {
  const { vasteVergoeding } = await import(url('api/_lib/setter-report-core.js'));
  assert.equal(vasteVergoeding({ is_active: true, monthly_fee: 0, effective_from: '2026-10-12' }, '2026-11-01'), 0);
  assert.equal(vasteVergoeding({ is_active: true, monthly_fee: 650, effective_from: '2026-08-31' }, '2026-11-01'), 650, 'Romy ongewijzigd');
  // De maandcron slaat lege rapporten over (geen €0-rapport voor Karl zonder commissie).
  assert.match(lees('api/cron/generate-setter-reports.js'), /skipEmpty: true/);
});

// ── 4. SQL ───────────────────────────────────────────────────────────────────
test('SQL: alleen Karls setter_config (3%, fee 0, actief); dry-run en booking_sources niet aangeraakt', () => {
  const sql = lees('docs/sql-migrations/2026-10-12-webinar-karl-setter.sql');
  const stmts = sql.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.match(stmts, /INSERT INTO public\.setter_config \(user_id, pct, is_active, effective_from, monthly_fee\)\s*VALUES \('fdc50852-2f29-46d6-b9bd-9bcfd4ed8ee7', 3\.00, true, CURRENT_DATE, 0\)\s*ON CONFLICT \(user_id\) DO NOTHING;/);
  assert.doesNotMatch(stmts, /app_settings|setter_commissie_dry_run|booking_sources|UPDATE|DELETE/i);
});
