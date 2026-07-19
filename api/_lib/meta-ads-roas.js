// api/_lib/meta-ads-roas.js
//
// PURE aggregator voor de "Tot en met sale"-weergave (fase 5). Geen DB /
// geen HTTP-calls — volledig unit-testbaar. Neemt reeds-opgehaalde arrays
// (leads/appointments/deals/spend/entities), doet de attributie-join en
// levert per campagne een funnel + totalen + niet-toegewezen-bak.
//
// FUNNEL-CONVENTIE: Leads -> Afspraken -> Sales (=deals) -> Omzet.
//   - Leads = rows in lead_attribution binnen de periode.
//   - Afspraken = DISTINCT lead_ghl_contact_id in follow_up_appointments
//     (exclusief status='cancelled') die matchen op een lead.
//   - Sales = deals (archived_at IS NULL, status niet in
//     EXCLUDED_DEAL_STATUSES) van customers wiens ghl_contact_id ook een
//     lead-attributie heeft in de periode.
//   - Omzet = SUM(deals.total_amount). Bruto (as-is uit deals) — de
//     conventie is per deal consistent; excl-btw-varianten zijn een
//     documentatie-aanname, geen v1-blocker.
//   - Klant = DISTINCT deals.customer_id per campagne (bij meerdere deals
//     van 1 klant op dezelfde campagne telt de klant 1×).
//
// ATTRIBUTIE-JOIN (per lead):
//   1) Ad-first:      lead.utm_content -> entity(level='ad') -> campaign_meta_id
//   2) Campaign-back: lead.utm_campaign -> entity(level='campaign').meta_id
//   3) Geen match  -> "niet-toegewezen"-bak (NOOIT stiekem aan een campagne).
//
// EXCLUDED_DEAL_STATUSES: standaard leeg (v1 telt álle statussen als sale —
// disputed/deceased blijven "sale gebeurd, maar problematisch"). 1 plek
// bovenaan aan te passen als beleid wijzigt.

export const EXCLUDED_DEAL_STATUSES = new Set([]);

// Sleutel om lead → campagne-attributie te bepalen. Return null = geen match
// (deze lead landt in de niet-toegewezen-bak).
export function resolveLeadCampaign(lead, entitiesByMetaId) {
  if (!lead || !entitiesByMetaId) return null;

  // 1) Ad-first via utm_content = ad meta_id
  const adContent = lead.utm_content && String(lead.utm_content).trim();
  if (adContent) {
    const ent = entitiesByMetaId.get(adContent);
    if (ent && ent.level === 'ad' && ent.campaign_meta_id) {
      return ent.campaign_meta_id;
    }
    // utm_content zou ook direct een campagne kunnen zijn (edge — sommige
    // GHL-configuraties zetten campagne-id in content). Val niet stil door.
    if (ent && ent.level === 'campaign' && ent.meta_id) {
      return ent.meta_id;
    }
  }

  // 2) Campaign-fallback via utm_campaign = campagne meta_id
  const campId = lead.utm_campaign && String(lead.utm_campaign).trim();
  if (campId) {
    const ent = entitiesByMetaId.get(campId);
    if (ent && ent.level === 'campaign' && ent.meta_id) {
      return ent.meta_id;
    }
    // Bij ontbrekende entity-lookup accepteren we het utm_campaign nog
    // steeds als ID (de spend-map kan er wel een naam voor hebben, of we
    // laten 'em als "onbekende campagne"-regel zien met de raw meta_id).
    return campId;
  }

  return null;
}

// Kleine helpers.
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function inc(map, key, add = 1) { map.set(key, (map.get(key) || 0) + add); }
function addSet(map, key, val) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(val);
}

/**
 * @param {object} args
 * @param {Array}  args.leads         [{ ghl_contact_id, utm_content, utm_campaign }]
 * @param {Array}  args.appointments  [{ lead_ghl_contact_id, status }]  (cancelled al gefilterd; helper filtert nog voor de zekerheid)
 * @param {Array}  args.deals         [{ customer_ghl_contact_id, total_amount, status, archived_at }]
 * @param {Map}    args.spendByCampaign  Map<campaign_meta_id, { spend, name?, entity_uuid?, effective_status? }>
 * @param {Map}    args.entitiesByMetaId Map<meta_id, { level, meta_id, campaign_meta_id, name, id (uuid) }>
 * @returns {{ totals: object, perCampaign: Array, unattributed: object }}
 */
export function aggregateRoas({ leads, appointments, deals, spendByCampaign, entitiesByMetaId }) {
  const _leads = Array.isArray(leads) ? leads : [];
  const _apts  = Array.isArray(appointments) ? appointments : [];
  const _deals = Array.isArray(deals) ? deals : [];
  const _spend = spendByCampaign instanceof Map ? spendByCampaign : new Map();
  const _ents  = entitiesByMetaId instanceof Map ? entitiesByMetaId : new Map();

  // Contact → campagne-meta_id (of null = unattributed).
  const contactToCampaign = new Map();
  for (const l of _leads) {
    if (!l?.ghl_contact_id) continue;
    contactToCampaign.set(l.ghl_contact_id, resolveLeadCampaign(l, _ents));
  }

  // Tellers per campagne (of 'UNATTRIBUTED'-sentinel key).
  const UNATTR = '__UNATTRIBUTED__';
  const leadsBy         = new Map();  // camp → count
  const apptContactsBy  = new Map();  // camp → Set<contact>
  const customersBy     = new Map();  // camp → Set<customer_id or ghl_contact_id proxy>
  const salesCountBy    = new Map();  // camp → count of deals
  const revenueBy       = new Map();  // camp → sum

  for (const [contact, camp] of contactToCampaign.entries()) {
    const key = camp || UNATTR;
    inc(leadsBy, key, 1);
    // Init sets zodat downstream berekeningen deterministic zijn.
    if (!apptContactsBy.has(key)) apptContactsBy.set(key, new Set());
    if (!customersBy.has(key))    customersBy.set(key, new Set());
  }

  // Afspraken: DISTINCT lead_ghl_contact_id per campagne (via de contactToCampaign-map).
  for (const a of _apts) {
    if (!a || a.status === 'cancelled') continue;
    const contact = a.lead_ghl_contact_id;
    if (!contact) continue;
    if (!contactToCampaign.has(contact)) continue; // afspraak zonder lead-in-window → skip
    const camp = contactToCampaign.get(contact);
    const key  = camp || UNATTR;
    addSet(apptContactsBy, key, contact);
  }

  // Deals: filter EXCLUDED_DEAL_STATUSES + archived_at is null (endpoint doet dat ook,
  // maar defensief hier). Attributie via customer.ghl_contact_id.
  for (const d of _deals) {
    if (!d) continue;
    if (d.archived_at) continue;
    if (EXCLUDED_DEAL_STATUSES.has(d.status)) continue;
    const contact = d.customer_ghl_contact_id;
    if (!contact) continue;
    if (!contactToCampaign.has(contact)) continue; // deal zonder lead-in-window → skip
    const camp = contactToCampaign.get(contact);
    const key  = camp || UNATTR;
    inc(salesCountBy, key, 1);
    inc(revenueBy, key, safeNum(d.total_amount));
    // Klant-teller: DISTINCT customer via contact-id als proxy (per lead-window
    // is er 1 contact per klant; als de klant meerdere ghl-ids heeft valt dat
    // buiten deze schaal).
    addSet(customersBy, key, contact);
  }

  // Build per-campagne rows. Union van: spend-only + leads-only + beide.
  const allCamps = new Set([
    ..._spend.keys(),
    ...Array.from(leadsBy.keys()).filter((k) => k !== UNATTR),
  ]);

  const perCampaign = [];
  for (const camp of allCamps) {
    const spendInfo = _spend.get(camp) || {};
    const spend     = safeNum(spendInfo.spend);
    const leadsN    = leadsBy.get(camp) || 0;
    const apptN     = (apptContactsBy.get(camp) || new Set()).size;
    const salesN    = salesCountBy.get(camp) || 0;
    const revenue   = revenueBy.get(camp) || 0;
    const customersN = (customersBy.get(camp) || new Set()).size;
    perCampaign.push({
      campaign_meta_id: camp,
      name:             spendInfo.name || (_ents.get(camp)?.name) || null,
      entity_uuid:      spendInfo.entity_uuid || (_ents.get(camp)?.id) || null,
      effective_status: spendInfo.effective_status || null,
      spend, leads: leadsN, appointments: apptN, sales: salesN, customers: customersN, revenue,
      cost_per_customer: customersN > 0 ? Number((spend / customersN).toFixed(2)) : null,
      roas:              spend > 0 ? Number((revenue / spend).toFixed(2)) : null,
    });
  }
  // Sorteer op spend desc — grootste budget bovenaan.
  perCampaign.sort((a, b) => (b.spend || 0) - (a.spend || 0));

  // Niet-toegewezen-bak (geen spend — die is per campagne bekend).
  const unattributed = {
    leads:        leadsBy.get(UNATTR)        || 0,
    appointments: (apptContactsBy.get(UNATTR) || new Set()).size,
    sales:        salesCountBy.get(UNATTR)   || 0,
    customers:    (customersBy.get(UNATTR)    || new Set()).size,
    revenue:      revenueBy.get(UNATTR)      || 0,
  };

  // Totalen (som over campagnes + unattributed voor de funnel-cijfers;
  // spend ALLEEN uit campagnes want unattributed heeft per definitie
  // geen bekende spend).
  const totalSpend    = perCampaign.reduce((s, r) => s + (r.spend || 0), 0);
  const totalLeads    = perCampaign.reduce((s, r) => s + r.leads, 0) + unattributed.leads;
  const totalAppts    = perCampaign.reduce((s, r) => s + r.appointments, 0) + unattributed.appointments;
  const totalSales    = perCampaign.reduce((s, r) => s + r.sales, 0) + unattributed.sales;
  const totalCust     = perCampaign.reduce((s, r) => s + r.customers, 0) + unattributed.customers;
  const totalRevenue  = perCampaign.reduce((s, r) => s + r.revenue, 0) + unattributed.revenue;
  // Toegewezen-revenue voor ROAS-berekening (niet-toegewezen is niet gecrediteerd
  // aan spend, dus telt niet mee in de global ROAS-noemer/teller-verhouding).
  const attributedRevenue = totalRevenue - unattributed.revenue;

  const totals = {
    spend:              Number(totalSpend.toFixed(2)),
    leads:              totalLeads,
    appointments:       totalAppts,
    sales:              totalSales,
    customers:          totalCust,
    revenue:            Number(totalRevenue.toFixed(2)),
    attributed_revenue: Number(attributedRevenue.toFixed(2)),
    unattributed_revenue: Number(unattributed.revenue.toFixed(2)),
    roas:               totalSpend > 0 ? Number((attributedRevenue / totalSpend).toFixed(2)) : null,
    cost_per_customer:  totalCust > 0  ? Number((totalSpend / totalCust).toFixed(2)) : null,
  };

  return { totals, perCampaign, unattributed };
}
