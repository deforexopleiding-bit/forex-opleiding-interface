// api/_lib/retention-groups.js
//
// Kern-logica voor retentie-set-berekening — gedeeld tussen:
//   /api/sales-retention.js          (huidige retentie-tab in sales)
//   /api/follow-up-oude-retenties.js (achterstand-tab in follow-up)
//
// Bepaalt per klant de MAX(end_date) over active + cancelled subs, en
// meldt of er dekking voorbij de horizon is (opvolgende active sub of
// open-eind). Caller doet z'n eigen window-filter en joins.
//
// Deze helper is bewust DUN: geen klant-joins, geen mentor-lookups. Dat
// blijft in de caller waar de output-shape verschilt.

import { supabaseAdmin } from '../supabase.js';

const HORIZON_DAYS_DEFAULT = 30;

// PostgREST slikt lange IN-lijsten stil af op de URL-lengte-limiet.
// chunkedIn splitst een grote ids-set in batches van 200. Herbruikbaar
// vanuit callers voor hun eigen chunked lookups.
export async function chunkedIn(table, column, ids, selectCols, extra) {
  const out = [];
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return out;
  const B = 200;
  for (let i = 0; i < uniq.length; i += B) {
    let q = supabaseAdmin.from(table).select(selectCols).in(column, uniq.slice(i, i + B));
    if (typeof extra === 'function') q = extra(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table} fetch: ${error.message}`);
    if (data) out.push(...data);
  }
  return out;
}

// Bereken retentie-groepen (per klant): MAX(end_date), lastStatus,
// hasActiveCoverageBeyondHorizon, plus behouden ruwe subs voor de
// caller (varianten/labels).
//
// Opties:
//   ownedByMe   : boolean       — filter deals op sales_user_id.
//   ownerUserId : uuid|null     — vereist als ownedByMe=true.
//   horizonDays : number        — grens voor "beyond horizon" (default 30).
//
// Return: { subs, dealById, byCust, horizonIso }
//   byCust = { [customer_id]: { customer_id, subs, maxEnd, maxDeal,
//                               lastStatus, activeCount,
//                               hasActiveCoverageBeyondHorizon } }
export async function getRetentionGroups({ ownedByMe = false, ownerUserId = null, horizonDays = HORIZON_DAYS_DEFAULT } = {}) {
  // 1) Subs (active + cancelled) — nieuwe subs met later end_date maken
  //    dat een klant automatisch wegvalt uit het retention-window.
  const { data: subs, error: subErr } = await supabaseAdmin.from('subscriptions')
    .select('id, deal_id, end_date, start_date, description, status')
    .in('status', ['active', 'cancelled'])
    .order('end_date', { ascending: true, nullsFirst: false })
    .limit(1000);
  if (subErr) throw new Error('subs fetch: ' + subErr.message);
  if (!subs || !subs.length) return { subs: [], dealById: {}, byCust: {}, horizonIso: computeHorizonIso(horizonDays) };

  // 2) Deals via chunked IN (archived weg + optioneel eigenaar-filter).
  const dealIds = [...new Set(subs.map((s) => s.deal_id).filter(Boolean))];
  let dealById = {};
  if (dealIds.length) {
    const deals = await chunkedIn(
      'deals', 'id', dealIds,
      'id, customer_id, sales_user_id, traject_variant_id, tl_department_id, archived_at',
      (q) => (ownedByMe && ownerUserId
        ? q.is('archived_at', null).eq('sales_user_id', ownerUserId)
        : q.is('archived_at', null)),
    );
    for (const d of deals) dealById[d.id] = d;
  }
  if (!Object.keys(dealById).length) return { subs, dealById: {}, byCust: {}, horizonIso: computeHorizonIso(horizonDays) };

  // 3) Groepeer per klant.
  const horizonIso = computeHorizonIso(horizonDays);
  const byCust = {};
  for (const s of subs) {
    const deal = dealById[s.deal_id];
    if (!deal?.customer_id) continue;
    const cid = deal.customer_id;
    const g = (byCust[cid] ||= {
      customer_id: cid, subs: [], maxEnd: null, maxDeal: null,
      lastStatus: null, activeCount: 0, hasActiveCoverageBeyondHorizon: false,
    });
    if (s.status === 'active') {
      g.activeCount++;
      if (!s.end_date || s.end_date > horizonIso) {
        g.hasActiveCoverageBeyondHorizon = true;
      }
    }
    if (!s.end_date) continue;
    g.subs.push({
      description: s.description || '—',
      start_date : s.start_date,
      end_date   : s.end_date,
      status     : s.status,
    });
    if (!g.maxEnd || s.end_date > g.maxEnd) {
      g.maxEnd = s.end_date; g.maxDeal = deal; g.lastStatus = s.status;
    }
  }

  return { subs, dealById, byCust, horizonIso };
}

function computeHorizonIso(horizonDays) {
  const horizon = Date.now() + horizonDays * 86400000;
  return new Date(horizon).toISOString().slice(0, 10);
}

// Ondergrens sinds sales de retentie systematisch oppakt.
export const RETENTION_WINDOW_FROM = '2026-01-01';
