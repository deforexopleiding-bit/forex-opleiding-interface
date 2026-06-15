// api/_lib/deal-total.js
//
// Pure helper: berekent {excl, incl} totaal van een deal op basis van
// deal-niveau korting + sale_type (domestic vs intra-EU) + line-items met
// hun eigen VAT-percentage en price_includes_vat-flag.
//
// Spiegelt exact de berekening in api/sales-deal-detail.js regel 51-61 zodat
// callers die het deal-totaal nodig hebben (mentor-bonus berekening in F5.1,
// rapportage, etc.) niet hun eigen kopie hoeven te onderhouden.
//
// Geen DB-call hier; caller geeft `deal` (met discount_percentage + sale_type)
// en `lineItems` (met quantity / unit_price / vat_percentage / price_includes_vat).

/**
 * @param {{ discount_percentage?: number|string, sale_type?: string }} deal
 * @param {Array<{ quantity: number|string, unit_price: number|string, vat_percentage: number|string, price_includes_vat: boolean }>} lineItems
 * @returns {{ excl: number, incl: number }}  beide in EUR, 2 decimalen
 */
export function computeDealTotals(deal, lineItems) {
  const factor = 1 - (Number(deal?.discount_percentage) || 0) / 100;
  const zeroVat = !!(deal?.sale_type && deal.sale_type !== 'domestic');
  let excl = 0;
  let incl = 0;
  for (const l of lineItems || []) {
    const rate = zeroVat ? 0 : (Number(l?.vat_percentage) || 0) / 100;
    const base = (Number(l?.quantity) || 0) * (Number(l?.unit_price) || 0);
    const lineExcl = (l?.price_includes_vat ? base / (1 + rate) : base) * factor;
    const lineIncl = lineExcl * (1 + rate);
    excl += lineExcl;
    incl += lineIncl;
  }
  return {
    excl: Math.round(excl * 100) / 100,
    incl: Math.round(incl * 100) / 100,
  };
}
