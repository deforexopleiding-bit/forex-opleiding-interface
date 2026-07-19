// api/meta-ads-roas.js
//
// GET → "Tot en met sale"-weergave (fase 5). Attributie × Meta-spend ×
// sales-pipeline. Per-campagne funnel + niet-toegewezen-bak + totalen.
// RBAC: ads.module.access.
//
// Tijd-scoping: lead_attribution.first_seen_at ∈ [from, to]. Downstream
// afspraken/deals van die contacts tellen mee, ongeacht wanneer die
// gebeurden. Zo blijft spend-periode en funnel-periode uitgelijnd.
//
// Attributie-join: eerst ad-first (utm_content → entity(ad).campaign_meta_id),
// dan campaign-fallback (utm_campaign → entity(campaign).meta_id).
// Geen match → niet-toegewezen-bak (nooit stiekem aan een campagne).
//
// Defensief pre-migratie: lead_attribution / meta_ad_entities / meta_insights_daily
// niet bestaand → nette lege respons met data_available:false, geen 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { resolveRange } from './meta-ads-insights.js';
import { aggregateRoas } from './_lib/meta-ads-roas.js';

function isMissingRelationError(err) {
  if (!err) return false;
  if (err.code === '42P01' || err.code === '42703') return true;
  if (err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  const msg = String(err.message || '') + ' ' + String(err.details || '') + ' ' + String(err.hint || '');
  return /relation .* does not exist/i.test(msg)
      || /column .* does not exist/i.test(msg)
      || /could not find the/i.test(msg)
      || /schema cache/i.test(msg);
}

function emptyResponse(range, extra = {}) {
  return {
    range,
    totals: { spend: 0, leads: 0, appointments: 0, sales: 0, customers: 0, revenue: 0, attributed_revenue: 0, unattributed_revenue: 0, roas: null, cost_per_customer: null },
    perCampaign: [],
    unattributed: { leads: 0, appointments: 0, sales: 0, customers: 0, revenue: 0 },
    data_available: false,
    ...extra,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'ads.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (ads.module.access)' });
  }

  // Range: hergebruik resolveRange voor consistentie met /api/meta-ads-insights.
  let range;
  try { range = resolveRange(req.query || {}); }
  catch (e) { return res.status(e.httpStatus || 400).json({ error: e.message }); }

  try {
    // 1) Leads binnen periode (lead_attribution.first_seen_at ∈ [from, to]).
    //    'to' is een YMD; upper-bound tot einde-van-dag zodat een lead die
    //    op 'to' 23:59 binnenkwam ook telt. Gebruik `lt` op de volgende dag
    //    om timezone-drift te vermijden.
    const toNextDay = new Date(range.to + 'T00:00:00Z');
    toNextDay.setUTCDate(toNextDay.getUTCDate() + 1);
    const toNextDayIso = toNextDay.toISOString().slice(0, 10);

    let leads = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('lead_attribution')
        .select('ghl_contact_id, utm_content, utm_campaign, first_seen_at')
        .gte('first_seen_at', range.from)
        .lt('first_seen_at', toNextDayIso)
        .limit(10000);
      if (error) {
        if (isMissingRelationError(error)) return res.status(200).json(emptyResponse(range, { skipped: 'lead_attribution_missing' }));
        throw error;
      }
      leads = data || [];
    } catch (e) {
      if (isMissingRelationError(e)) return res.status(200).json(emptyResponse(range, { skipped: 'lead_attribution_missing' }));
      throw new Error('leads fetch: ' + (e?.message || e));
    }

    if (leads.length === 0) {
      // Geen leads binnen periode: alsnog spend tonen zodat je "budget aan het
      // uitgeven zonder attributie" ziet.
      const spendResult = await fetchSpendAndEntities(range);
      const empty = emptyResponse(range);
      // Fill perCampaign from spend-only (leads=0 for all)
      const emptyEnts = spendResult.entitiesByMetaId;
      const emptyAgg = aggregateRoas({
        leads: [], appointments: [], deals: [],
        spendByCampaign: spendResult.spendByCampaign,
        entitiesByMetaId: emptyEnts,
      });
      return res.status(200).json({
        ...empty,
        totals: emptyAgg.totals,
        perCampaign: emptyAgg.perCampaign,
        data_available: spendResult.spendByCampaign.size > 0,
      });
    }

    // 2) Customers voor de ghl_contact_ids die leads waren.
    //    (Voor deals-attributie via customer.ghl_contact_id.)
    const contactIds = [...new Set(leads.map((l) => l.ghl_contact_id).filter(Boolean))];
    let customers = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('id, ghl_contact_id')
        .in('ghl_contact_id', contactIds);
      if (error) {
        if (isMissingRelationError(error)) { customers = []; }
        else throw error;
      } else {
        customers = data || [];
      }
    } catch (e) {
      if (!isMissingRelationError(e)) throw new Error('customers fetch: ' + (e?.message || e));
    }
    const customerById = new Map(customers.map((c) => [c.id, c]));
    const customerIds  = customers.map((c) => c.id);

    // 3) Deals voor die customers (archived_at IS NULL — status-filter zit
    //    in de aggregator via EXCLUDED_DEAL_STATUSES, maar we filteren de
    //    grofste bulk hier).
    let deals = [];
    if (customerIds.length) {
      try {
        const { data, error } = await supabaseAdmin
          .from('deals')
          .select('customer_id, total_amount, status, archived_at')
          .in('customer_id', customerIds)
          .is('archived_at', null);
        if (error) {
          if (!isMissingRelationError(error)) throw error;
        } else {
          deals = (data || []).map((d) => ({
            customer_ghl_contact_id: customerById.get(d.customer_id)?.ghl_contact_id || null,
            total_amount: d.total_amount,
            status:       d.status,
            archived_at:  d.archived_at,
          }));
        }
      } catch (e) {
        if (!isMissingRelationError(e)) throw new Error('deals fetch: ' + (e?.message || e));
      }
    }

    // 4) Afspraken voor die contact-ids (exclusief cancelled).
    let appointments = [];
    try {
      const { data, error } = await supabaseAdmin
        .from('follow_up_appointments')
        .select('lead_ghl_contact_id, status')
        .in('lead_ghl_contact_id', contactIds)
        .neq('status', 'cancelled');
      if (error) {
        if (!isMissingRelationError(error)) throw error;
      } else {
        appointments = data || [];
      }
    } catch (e) {
      if (!isMissingRelationError(e)) throw new Error('appointments fetch: ' + (e?.message || e));
    }

    // 5) Spend + entities.
    const { spendByCampaign, entitiesByMetaId } = await fetchSpendAndEntities(range);

    // 6) Aggregeer.
    const agg = aggregateRoas({ leads, appointments, deals, spendByCampaign, entitiesByMetaId });

    return res.status(200).json({
      range,
      ...agg,
      data_available: leads.length > 0 || spendByCampaign.size > 0,
      meta: {
        contact_count:    contactIds.length,
        customer_count:   customers.length,
        deal_count:       deals.length,
        appointment_count: appointments.length,
      },
    });
  } catch (e) {
    console.error('[meta-ads-roas]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function fetchSpendAndEntities(range) {
  const spendByCampaign  = new Map();
  const entitiesByMetaId = new Map();

  // Spend per campagne over de range.
  try {
    const { data, error } = await supabaseAdmin
      .from('meta_insights_daily')
      .select('entity_meta_id, spend')
      .eq('level', 'campaign')
      .gte('date', range.from)
      .lte('date', range.to);
    if (error) {
      if (!isMissingRelationError(error)) throw error;
    } else {
      for (const r of (data || [])) {
        const camp = r.entity_meta_id;
        const cur  = spendByCampaign.get(camp) || { spend: 0 };
        cur.spend += Number(r.spend || 0);
        spendByCampaign.set(camp, cur);
      }
    }
  } catch (e) {
    if (!isMissingRelationError(e)) console.warn('[meta-ads-roas] spend fetch:', e?.message || e);
  }

  // Entities (alle levels — zowel campaign voor spend-namen als ad voor de
  // ad-first-attributie-join).
  try {
    const { data, error } = await supabaseAdmin
      .from('meta_ad_entities')
      .select('id, meta_id, level, name, campaign_meta_id, effective_status');
    if (error) {
      if (!isMissingRelationError(error)) throw error;
    } else {
      for (const e of (data || [])) {
        entitiesByMetaId.set(e.meta_id, e);
        // Zet naam/uuid/status op de spend-entry als 'ie een campagne is.
        if (e.level === 'campaign' && spendByCampaign.has(e.meta_id)) {
          const cur = spendByCampaign.get(e.meta_id);
          cur.name = e.name || cur.name || null;
          cur.entity_uuid = e.id || cur.entity_uuid || null;
          cur.effective_status = e.effective_status || cur.effective_status || null;
          spendByCampaign.set(e.meta_id, cur);
        }
      }
    }
  } catch (e) {
    if (!isMissingRelationError(e)) console.warn('[meta-ads-roas] entities fetch:', e?.message || e);
  }

  return { spendByCampaign, entitiesByMetaId };
}
