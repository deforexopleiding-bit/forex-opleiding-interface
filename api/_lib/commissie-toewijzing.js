// api/_lib/commissie-toewijzing.js
//
// Handmatige sale-toewijzing aan mentoren (mentor_sale_attributions) —
// gedeelde helpers voor de vrijgave-engine, het bonus-overzicht en de
// commissie-endpoints.
//
// ── DE REGEL ────────────────────────────────────────────────────────────────
// Een toegewezen sale (bv. een VERLENGING) verdient ALLEEN op de facturen van
// zijn eigen deal: invoices.deal_id = deal, of tl_subscription_id van een
// subscription van die deal. Nooit klantbreed — anders valt een nieuwe
// commissie meteen vrij op betalingen van de oude sale.
// Omgekeerd tellen facturen van een toegewezen deal NIET mee voor de
// klantbrede som van een event-bonus — anders geeft een verlengingsbetaling
// de rest van de oude event-bonus vrij.
//
// Fail-soft: zolang docs/sql-migrations/2026-10-22-mentor-sale-attributions.sql
// niet gedraaid is, bestaan tabel en kolom niet. loadAttributions geeft dan
// een lege set terug en alle oude paden gedragen zich exact zoals voorheen.

export const ATTR_KEY_PREFIX = 'attr:';
export const REDENEN = ['verlenging', 'upsell', 'handmatig'];
export const REDEN_LABEL = { verlenging: 'Verlenging', upsell: 'Upsell', handmatig: 'Handmatig' };
export const DEFAULT_PCT = 3;

const ATTR_KEY_RE = /^attr:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** Tabel/kolom bestaat (nog) niet — de migratie is niet gedraaid. */
export function isSchemaOntbreekt(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (['42P01', '42703', 'PGRST205', 'PGRST204', 'PGRST200'].includes(code)) return true;
  const msg = String(err.message || '');
  return /mentor_sale_attributions|attribution_id/i.test(msg)
    && /does not exist|could not find|schema cache/i.test(msg);
}

/** idempotency_key van een toewijzings-parent. */
export function attrIdempotencyKey(attributionId, mentorUserId) {
  return `${ATTR_KEY_PREFIX}${attributionId}:${mentorUserId}`;
}

/**
 * Hoort deze grootboekregel bij een toewijzing? Kolom attribution_id als die
 * er is; anders de idempotency_key (`attr:<id>:<uid>`), zodat lezers ook
 * werken met een select die de kolom (nog) niet noemt.
 */
export function attributionIdOf(entry) {
  if (!entry) return null;
  if (entry.attribution_id) return entry.attribution_id;
  const m = ATTR_KEY_RE.exec(String(entry.idempotency_key || ''));
  return m ? m[1] : null;
}

/** Commissie per mentor: pct × basis / 100 / N, op centen (zelfde als events-complete-core). */
export function aandeelPerMentor(basis, pct, n) {
  const b = Number(basis) || 0;
  const p = Number(pct) || 0;
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (b <= 0 || p <= 0 || k === 0) return 0;
  return round2((p * b / 100) / k);
}

/** tl_subscription_ids van de subscriptions van één deal. */
export function tlSubIdsVanDeal(dealId, subs) {
  const out = new Set();
  for (const s of subs || []) {
    if (s && s.deal_id === dealId && s.teamleader_subscription_id) out.add(s.teamleader_subscription_id);
  }
  return out;
}

/** Hoort deze factuur bij deze deal (deal_id of een sub van de deal)? */
export function factuurVanDeal(inv, dealId, tlSubIds) {
  if (!inv || !dealId) return false;
  if (inv.deal_id && inv.deal_id === dealId) return true;
  return !!(inv.tl_subscription_id && tlSubIds && tlSubIds.has(inv.tl_subscription_id));
}

/** Hoort deze factuur bij één van deze deals? */
export function factuurVanDeals(inv, dealIds, subs) {
  if (!inv || !dealIds || dealIds.size === 0) return false;
  if (inv.deal_id && dealIds.has(inv.deal_id)) return true;
  if (!inv.tl_subscription_id) return false;
  for (const s of subs || []) {
    if (s && dealIds.has(s.deal_id) && s.teamleader_subscription_id === inv.tl_subscription_id) return true;
  }
  return false;
}

/**
 * Toewijzingen ophalen (fail-soft). Filter op customerIds en/of ids.
 * Returnt { ok, list, byId: Map, activeDealIdsByCust: Map<cust, Set<deal>> }.
 * ok=false → tabel bestaat niet (migratie niet gedraaid) of leesfout; de
 * caller gedraagt zich dan zoals vóór deze feature.
 */
export async function loadAttributions(db, { customerIds = null, ids = null } = {}) {
  const leeg = { ok: false, list: [], byId: new Map(), activeDealIdsByCust: new Map() };
  const custs = [...new Set((customerIds || []).filter(Boolean))];
  const idList = [...new Set((ids || []).filter(Boolean))];
  if (!custs.length && !idList.length) return { ...leeg, ok: true };
  const list = [];
  const kolommen = 'id, deal_id, customer_id, reden, pct, basis, basis_incl_btw, status, note, created_by, created_at, cancelled_at, cancelled_by';
  try {
    const vragen = [];
    if (custs.length) vragen.push(db.from('mentor_sale_attributions').select(kolommen).in('customer_id', custs));
    if (idList.length) vragen.push(db.from('mentor_sale_attributions').select(kolommen).in('id', idList));
    for (const v of vragen) {
      const { data, error } = await v;
      if (error) {
        if (!isSchemaOntbreekt(error)) console.warn('[commissie-toewijzing] attributions lezen:', error.message);
        return leeg;
      }
      list.push(...(data || []));
    }
  } catch (e) {
    console.warn('[commissie-toewijzing] attributions lezen:', e?.message || e);
    return leeg;
  }
  const byId = new Map();
  for (const a of list) byId.set(a.id, a);
  const activeDealIdsByCust = new Map();
  for (const a of byId.values()) {
    if (a.status !== 'actief' || !a.customer_id || !a.deal_id) continue;
    if (!activeDealIdsByCust.has(a.customer_id)) activeDealIdsByCust.set(a.customer_id, new Set());
    activeDealIdsByCust.get(a.customer_id).add(a.deal_id);
  }
  return { ok: true, list: [...byId.values()], byId, activeDealIdsByCust };
}

/**
 * Welke deals moet een EVENT-parent uit de klantbrede som houden? De actief
 * toegewezen deals van de klant, behalve zijn eigen deal (als iemand bewust
 * dezelfde deal dubbel toewees, blijft de event-bonus op zijn eigen deal
 * vrijgeven).
 */
export function uitTeSluitenDeals(activeDealIds, eigenDealId) {
  const out = new Set(activeDealIds || []);
  if (eigenDealId) out.delete(eigenDealId);
  return out;
}
