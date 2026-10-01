// tests/lisa-ig-stilte.test.js
//
// STILTE-ALARM VOOR DE INSTAGRAM-INSTROOM (1 oktober 2026).
//
// Van 8 t/m 30 sep kwam er geen enkel nieuw IG-gesprek binnen en niemand zag
// het. beoordeelIgStilte() is de pure beslisfunctie; controleerIgStilte() de
// dunne schil die meet, meldt en het meld-moment onthoudt (één keer per
// throttle-venster).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const NU = Date.parse('2026-10-01T10:00:00Z');
const uurGeleden = (u) => new Date(NU - u * 3600 * 1000).toISOString();

async function lib() {
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: null } });
  return import(url('api/_lib/lisa-ig-stilte.js') + '?t=' + Math.random());
}

test('beoordeel: recente instroom → geen alarm', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const o = beoordeelIgStilte({ nuMs: NU, laatsteNieuweConvIso: uurGeleden(5), laatsteInboundIso: uurGeleden(1), laatsteWebhookIso: uurGeleden(1) });
  assert.equal(o.alarm, false);
  assert.deepEqual(o.redenen, []);
});

test('beoordeel: geen nieuw gesprek én geen inbound > 48u → geen_ig_activiteit', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const o = beoordeelIgStilte({ nuMs: NU, laatsteNieuweConvIso: uurGeleden(100), laatsteInboundIso: uurGeleden(49), laatsteWebhookIso: uurGeleden(49) });
  assert.equal(o.alarm, true);
  assert.deepEqual(o.redenen, ['geen_ig_activiteit']);
  assert.equal(o.magMelden, true);
});

test('beoordeel: alleen geen nieuw gesprek maar wel inbound → geen geen_ig_activiteit (EN-regel)', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const o = beoordeelIgStilte({ nuMs: NU, laatsteNieuweConvIso: uurGeleden(100), laatsteInboundIso: uurGeleden(2), laatsteWebhookIso: uurGeleden(2) });
  assert.equal(o.alarm, false);
});

test('beoordeel: het september-incident — webhook stil, poll vindt wél inbound → webhook_stil', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  // Webhook laatst 8 sep, poll vond nog inbound op 24 sep, geen nieuwe gesprekken.
  const o = beoordeelIgStilte({
    nuMs: Date.parse('2026-09-25T10:00:00Z'),
    laatsteNieuweConvIso: '2026-09-08T14:16:24Z',
    laatsteInboundIso:    '2026-09-24T22:14:53Z',
    laatsteWebhookIso:    '2026-09-08T14:16:24Z',
  });
  assert.equal(o.alarm, true);
  assert.deepEqual(o.redenen, ['webhook_stil']);
});

test('beoordeel: rustige periode (webhook stil, geen nieuwere inbound) is geen webhook_stil', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const o = beoordeelIgStilte({ nuMs: NU, laatsteNieuweConvIso: uurGeleden(60), laatsteInboundIso: uurGeleden(60), laatsteWebhookIso: uurGeleden(59), drempelUren: 48 });
  assert.deepEqual(o.redenen, ['geen_ig_activiteit']);
});

test('beoordeel: throttle — binnen 24u na melden niet opnieuw; daarna wel', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const basis = { nuMs: NU, laatsteNieuweConvIso: null, laatsteInboundIso: null, laatsteWebhookIso: null };
  assert.equal(beoordeelIgStilte({ ...basis, gemeldOpIso: uurGeleden(3) }).magMelden, false);
  assert.equal(beoordeelIgStilte({ ...basis, gemeldOpIso: uurGeleden(25) }).magMelden, true);
  assert.equal(beoordeelIgStilte({ ...basis, gemeldOpIso: uurGeleden(3), throttleUren: 2 }).magMelden, true);
});

test('beoordeel: configureerbare drempel + uit-schakelaar + wisGemeld bij herstel', async (t) => {
  t.after(() => mock.reset());
  const { beoordeelIgStilte } = await lib();
  const stil = { nuMs: NU, laatsteNieuweConvIso: uurGeleden(13), laatsteInboundIso: uurGeleden(13), laatsteWebhookIso: uurGeleden(13) };
  assert.equal(beoordeelIgStilte({ ...stil, drempelUren: 48 }).alarm, false);
  assert.equal(beoordeelIgStilte({ ...stil, drempelUren: 12 }).alarm, true);
  assert.equal(beoordeelIgStilte({ ...stil, drempelUren: 12, uit: true }).alarm, false);
  const hersteld = beoordeelIgStilte({ nuMs: NU, laatsteNieuweConvIso: uurGeleden(1), laatsteInboundIso: uurGeleden(1), laatsteWebhookIso: uurGeleden(1), gemeldOpIso: uurGeleden(30) });
  assert.equal(hersteld.wisGemeld, true);
});

// ── controleerIgStilte: meet + meld + onthoud ─────────────────────────────
function stubDb({ cfg = null, conv, inbound, webhook, fout = null }) {
  const writes = [];
  return {
    writes,
    from(tbl) {
      const k = {
        select: () => k, eq: () => k, order: () => k, limit: () => k,
        upsert: async (row) => { writes.push({ tbl, row }); return { error: null }; },
        maybeSingle: async () => {
          if (fout && tbl === fout) return { data: null, error: { message: 'kapot' } };
          if (tbl === 'app_settings') return { data: cfg ? { value: cfg } : null, error: null };
          if (tbl === 'lisa_conversations') return { data: conv ? { created_at: conv } : null, error: null };
          if (tbl === 'lisa_messages') return { data: inbound ? { sent_at: inbound } : null, error: null };
          if (tbl === 'lisa_settings') return { data: { ghl_webhook_last_received_at: webhook }, error: null };
          return { data: null, error: null };
        },
      };
      return k;
    },
  };
}

test('controleer: alarm → notificatie + mail + gemeld_op opgeslagen; tweede run binnen throttle meldt niet', async (t) => {
  t.after(() => mock.reset());
  const { controleerIgStilte, ALARM_KEY } = await lib();
  const meldingen = [], mails = [];
  const deps = {
    nuMs: NU,
    notify: async (n) => { meldingen.push(n); return { ok: true, count: 2 }; },
    mail: async (m) => { mails.push(m); return { sent: true }; },
  };
  const db1 = stubDb({ conv: uurGeleden(100), inbound: uurGeleden(60), webhook: uurGeleden(60) });
  const r1 = await controleerIgStilte({ ...deps, db: db1 });
  assert.equal(r1.alarm, true);
  assert.equal(r1.gemeld, true);
  assert.equal(meldingen.length, 1);
  assert.deepEqual(meldingen[0].toRole, ['manager', 'super_admin']);
  assert.equal(mails.length, 1);
  assert.equal(db1.writes[0].row.key, ALARM_KEY);
  assert.equal(db1.writes[0].row.value.gemeld_op, new Date(NU).toISOString());

  const db2 = stubDb({ cfg: db1.writes[0].row.value, conv: uurGeleden(100), inbound: uurGeleden(60), webhook: uurGeleden(60) });
  const r2 = await controleerIgStilte({ ...deps, db: db2, nuMs: NU + 15 * 60 * 1000 });
  assert.equal(r2.alarm, true);
  assert.equal(r2.gemeld, false);
  assert.equal(meldingen.length, 1, 'geen tweede melding binnen throttle');
});

test('controleer: leesfout = NIET GEMETEN, geen alarm, geen melding', async (t) => {
  t.after(() => mock.reset());
  const { controleerIgStilte } = await lib();
  let gemeld = 0;
  const r = await controleerIgStilte({
    db: stubDb({ fout: 'lisa_messages' }), nuMs: NU,
    notify: async () => { gemeld++; return { ok: true, count: 1 }; }, mail: async () => { gemeld++; return { sent: true }; },
  });
  assert.equal(r.gemeten, false);
  assert.equal(r.alarm, false);
  assert.equal(gemeld, 0);
});
