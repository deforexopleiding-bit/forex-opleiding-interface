// api/toegang-flow-overview.js
//
// BP3 v38 (2026-09-04) — READ-ONLY drilldown-data voor de #automatiseringen/
// Toegang-subtab (7-daagse + mini-cursus branch-view). Per soort de 10
// stap-buckets met count + top-N kaartjes.
//
// GET ?soort=7-daagse|minicursus (optional; omit = beide)
//
// Response:
//   { ok, generated_at,
//     flows: {
//       '7-daagse':   { by_bucket: {...counts...}, buckets: {...top-N-rows...}, errors:{...} },
//       'minicursus': { ... }
//     }
//   }
//
// Puur SELECT + count:'exact',head:true — geen writes. Cron/actie-endpoints
// (cron-toegang-aanvragen, toegang-aanvraag-start) onaangeroerd.
// Incasso-zone (dunning_*/arrangement_*/pending_actions) niet aangeraakt.
//
// RBAC: automatiseringen.module.view (fallback: super_admin), zelfde patroon
// als api/automations-overview.js.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SOORTEN = ['7-daagse', 'minicursus'];
const TOP_N = 20;

// Bucket-definitie. Elk item: { key, applyFn(query) → filtered query }.
// applyFn wordt bovenop `.eq('soort', <soort>)` toegepast. Volgorde matcht de
// branch-layout in de UI (1-5 pre + NEE-lane, 6-8 JA-lane, 9 = NEE-eindstaat,
// 10 = operator-alert).
const BUCKETS = [
  { key: '1_nieuw',                 apply: (q) => q.eq('status', 'wachtend').is('bevestiging_sent_at', null) },
  { key: '2_wacht_reactie',         apply: (q) => q.eq('status', 'wachtend').not('bevestiging_sent_at', 'is', null).is('reminder_2u_at', null) },
  { key: '3_na_2u',                 apply: (q) => q.eq('status', 'wachtend').not('reminder_2u_at', 'is', null).is('reminder_24u_at', null) },
  { key: '4_na_24u',                apply: (q) => q.eq('status', 'wachtend').not('reminder_24u_at', 'is', null).is('reminder_48u_at', null) },
  { key: '5_na_48u',                apply: (q) => q.eq('status', 'wachtend').not('reminder_48u_at', 'is', null) },
  { key: '6_gereageerd_wacht_prov', apply: (q) => q.eq('status', 'gereageerd').is('provisioned_at', null) },
  { key: '7_in_cursus',             apply: (q) => q.eq('status', 'gereageerd').not('provisioned_at', 'is', null) },
  { key: '8_dag6_verzonden',        apply: (q) => q.not('dag6_sent_at', 'is', null) }, // 7-daagse-only via caller-filter
  { key: '9_vervallen',             apply: (q) => q.eq('status', 'vervallen') },
  { key: '10_provisioning_fout',    apply: (q) => q.eq('status', 'gereageerd').is('provisioned_at', null).not('provisioned_error', 'is', null) },
];

const SELECT_COLS = 'id, created_at, soort, bron, voornaam, email, telefoon, call_geboekt, status, bevestiging_sent_at, reminder_2u_at, reminder_24u_at, reminder_48u_at, reacted_at, provisioned_at, provisioned_error, dag6_sent_at, vervallen_at';

async function bucketCountAndRows(soort, bucketKey, applyFn) {
  try {
    // Count
    let qCount = supabaseAdmin.from('toegang_aanvragen').select('id', { count: 'exact', head: true }).eq('soort', soort);
    qCount = applyFn(qCount);
    const { count, error: cErr } = await qCount;
    if (cErr) return { count: null, rows: [], error: cErr.message };

    // Top-N rows
    let qRows = supabaseAdmin.from('toegang_aanvragen').select(SELECT_COLS).eq('soort', soort).order('created_at', { ascending: false }).limit(TOP_N);
    qRows = applyFn(qRows);
    const { data, error: rErr } = await qRows;
    if (rErr) return { count: Number(count) || 0, rows: [], error: rErr.message };

    return { count: Number(count) || 0, rows: Array.isArray(data) ? data : [], error: null };
  } catch (e) {
    return { count: null, rows: [], error: e?.message || String(e) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'automatiseringen.module.view');
  if (!allowed) {
    const { data: prof } = await supabaseAdmin
      .from('profiles').select('role, is_active').eq('id', user.id).maybeSingle();
    allowed = !!prof && prof.is_active && prof.role === 'super_admin';
  }
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (automatiseringen.module.view)' });

  const soortParam = String(req.query?.soort || '').toLowerCase();
  const soortenScope = SOORTEN.includes(soortParam) ? [soortParam] : SOORTEN;

  const flows = {};

  await Promise.all(soortenScope.map(async (soort) => {
    // Voor 7-daagse doen we alle 10 buckets; voor minicursus skippen we
    // bucket 8 (dag-6 is 7-daagse-only) — we retourneren count:0 en rows:[]
    // zodat UI consistent kan renderen zonder if-else per soort.
    const results = await Promise.all(BUCKETS.map(async (b) => {
      if (b.key === '8_dag6_verzonden' && soort !== '7-daagse') {
        return [b.key, { count: 0, rows: [], error: null, na: true }];
      }
      const r = await bucketCountAndRows(soort, b.key, b.apply);
      return [b.key, r];
    }));

    const by_bucket = {};
    const buckets = {};
    const errors = {};
    for (const [key, r] of results) {
      by_bucket[key] = r.count;
      buckets[key] = r.rows;
      if (r.error) errors[key] = r.error;
    }
    flows[soort] = { by_bucket, buckets, errors };
  }));

  return res.status(200).json({
    ok: true,
    generated_at: new Date().toISOString(),
    flows,
  });
}
