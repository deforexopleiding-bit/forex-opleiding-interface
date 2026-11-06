// api/_lib/sales-bonus-regels.js
//
// Wanneer mag er AUTOMATISCH een sales-bonus (tabel `bonuses`) ontstaan?
// Puur, zonder database — gedeeld door api/sales-subscription-create.js en
// de tests. Regels van Maxim (6 nov 2026):
//
//   1. Wie een abonnement aanmaakt of aanpast krijgt daardoor NOOIT
//      automatisch een bonus. De bonus is van de verkoper van de offerte
//      (deals.sales_user_id van de getekende deal), nooit van de ingelogde
//      gebruiker. Een abonnement zonder offerte (standalone, ghost-deal
//      `source='subscription_only'`) geeft dus nooit een automatische bonus.
//   2. Een aanpassing, regeling of incasso-abonnement maakt nooit een nieuwe
//      bonus; de commissie blijft bij de sale waar het aan hangt.
//   3. De regeling zelf (ongewijzigd, zie sales-subscription-create): de
//      verkoper krijgt `percentage` (sales_bonus_configs, standaard 3%) over
//      het regelbedrag EXCL. btw van het EERSTE abonnement met 1 termijn
//      (aanbetaling of eenmalige betaling), als dat ≥ `threshold_amount`
//      (standaard € 1.000) is. Eén bonus per deal.
//   4. Verdiend/meegeteld wordt pas naar betaling: api/_lib/sales-bonus-stand.js.
//
// Uitzondering: een admin kent een bonus met de hand toe (ontvanger + reden,
// gelogd) via api/sales-bonus-beslissing.js.

export const STANDAARD_PCT = 3;
export const STANDAARD_DREMPEL = 1000;

const GHOST_BRONNEN = new Set(['subscription_only']);

/** Ghost-deal: abonnement zonder offerte (standalone of geïmporteerd zonder offerte). */
export function isGhostDeal(deal) {
  if (!deal) return true;
  if (GHOST_BRONNEN.has(String(deal.source || ''))) return true;
  return String(deal.tl_quotation_status || '').toLowerCase() === 'no_quotation';
}

/**
 * Mag deze abonnement-aanmaak automatisch een bonus maken?
 * @param {object} p
 * @param {boolean} p.standalone        abonnement zonder offerte (nieuwe ghost-deal)
 * @param {object}  p.deal              de deal waarop de abonnementen komen
 * @param {Array}   p.soorten           per nieuw abonnement { soort, sale_deal_id }
 *                                      (null-items = soort onbekend, oude callers)
 * @param {number}  p.eerdereAbonnementen  abonnementen die al op deze deal stonden
 *                                      (ook geannuleerde): dan is dit een vervanging
 * @returns {{ ok: boolean, reden: string, ontvanger: string|null }}
 */
export function magAutomatischeBonus({ standalone = false, deal = null, soorten = [], eerdereAbonnementen = 0 } = {}) {
  const nee = (reden) => ({ ok: false, reden, ontvanger: null });
  if (standalone) return nee('abonnement zonder offerte: wie het aanmaakt krijgt geen automatische bonus (regel 1)');
  if (!deal) return nee('geen deal');
  if (isGhostDeal(deal)) return nee('deal zonder offerte (ghost-deal): geen automatische bonus (regel 1)');
  if (!deal.sales_user_id) return nee('offerte zonder verkoper');
  if ((Number(eerdereAbonnementen) || 0) > 0) {
    return nee('de offerte had al abonnementen: dit is een vervanging, geen nieuwe bonus (regel 2)');
  }
  for (const s of soorten || []) {
    const soort = s?.soort || null;
    if (soort === 'aanpassing' || soort === 'incasso_regeling') {
      return nee('aanpassing/regeling/incasso maakt geen nieuwe bonus; de commissie blijft bij de sale (regel 2)');
    }
    // Een "origineel" dat aan een ANDERE sale hangt is in feite een vervanging
    // van die sale: ook geen nieuwe bonus.
    if (soort === 'origineel' && s.sale_deal_id && s.sale_deal_id !== deal.id) {
      return nee('abonnement hangt aan een andere sale; de commissie blijft daar (regel 2)');
    }
  }
  return { ok: true, reden: 'eerste abonnement op de offerte', ontvanger: deal.sales_user_id };
}

/** Bonusbedrag volgens de ingestelde regeling (null = onder de drempel). */
export function bonusVolgensRegeling(basisExcl, { percentage = STANDAARD_PCT, threshold_amount = STANDAARD_DREMPEL } = {}) {
  const b = Number(basisExcl) || 0;
  if (!(b > 0) || b < Number(threshold_amount)) return null;
  return Math.round(b * Number(percentage)) / 100;
}
