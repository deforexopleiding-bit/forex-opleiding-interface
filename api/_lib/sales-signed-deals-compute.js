// api/_lib/sales-signed-deals-compute.js
//
// Extract van compute-logica in api/sales-signed-deals-total.js. Retourneert
// count + total_incl_vat, én optioneel recent_ids (voor tv-dashboard bling).
//
// Definitie: deals waar tl_quotation_status='accepted', niet declined/archived,
// effective_accepted_at (accepted_at || signed_at || created_at) binnen [since, until).
// Test-deals (via fetchTestDealIds) uitgesloten.
//
// Byte-parity met api/sales-signed-deals-total.js (regels 122-179 op main).

import { fetchTestDealIds } from './test-data-filter.js';

function lineInclVat(li) {
  const qty = Number(li.quantity) || 0;
  const up  = Number(li.unit_price) || 0;
  const vat = Number(li.vat_percentage) || 0;
  const sub = up * qty;
  return li.price_includes_vat ? sub : sub * (1 + vat / 100);
}
function effectiveAcceptedAt(d) {
  return d.tl_quotation_accepted_at || d.tl_quotation_signed_at || d.created_at || null;
}

/**
 * @param {object} opts
 * @param {object} opts.supabaseAdmin
 * @param {string} opts.since  - 'YYYY-MM-DD' inclusief
 * @param {string} opts.until  - 'YYYY-MM-DD' EXclusief
 * @param {boolean} [opts.includeRecentIds=false]
 * @returns {Promise<{total_incl_vat, count, test_excluded, recent_ids?}>}
 */
export async function computeSignedDealsTotal({ supabaseAdmin, since, until, includeRecentIds = false }) {
  const selectCols = 'id, customer_id, tl_quotation_status, tl_quotation_accepted_at, tl_quotation_signed_at, tl_quotation_declined_at, archived_at, created_at, quote_reference';
  const { data: dealsRaw, error: dErr } = await supabaseAdmin
    .from('deals').select(selectCols)
    .eq('tl_quotation_status', 'accepted')
    .is('tl_quotation_declined_at', null)
    .is('archived_at', null)
    .limit(20000);
  if (dErr) throw new Error('deals: ' + dErr.message);

  const inRange = (iso) => {
    if (!iso) return false;
    const d = String(iso).slice(0, 10);
    if (since && d < since) return false;
    if (until && d >= until) return false;
    return true;
  };
  const deals = (dealsRaw || []).filter(d => inRange(effectiveAcceptedAt(d)));

  const testDealIds = await fetchTestDealIds(supabaseAdmin);
  const clean = deals.filter(d => !testDealIds.has(d.id));
  const testExcluded = deals.length - clean.length;
  const ids = clean.map(d => d.id);

  if (!ids.length) {
    return {
      total_incl_vat: 0, count: 0, test_excluded: testExcluded,
      ...(includeRecentIds ? { recent_ids: [] } : {}),
    };
  }

  const { data: lines, error: lErr } = await supabaseAdmin
    .from('deal_line_items')
    .select('deal_id, quantity, unit_price, vat_percentage, price_includes_vat')
    .in('deal_id', ids);
  if (lErr) throw new Error('deal_line_items: ' + lErr.message);

  const perDeal = new Map();
  for (const li of (lines || [])) {
    perDeal.set(li.deal_id, (perDeal.get(li.deal_id) || 0) + lineInclVat(li));
  }
  let total = 0;
  for (const v of perDeal.values()) total += v;
  total = Math.round(total * 100) / 100;

  const out = { total_incl_vat: total, count: clean.length, test_excluded: testExcluded };
  if (includeRecentIds) {
    // Klant-labels voor bling — PII-veilig (individu → "Kevin B.", bedrijf → volledig).
    const customerIds = [...new Set(clean.map(d => d.customer_id).filter(Boolean))];
    let custMap = new Map();
    if (customerIds.length) {
      const { data: custs } = await supabaseAdmin.from('customers')
        .select('id, is_company, company_name, first_name, last_name')
        .in('id', customerIds);
      custMap = new Map((custs || []).map(c => [c.id, c]));
    }
    function trimIndividual(name) {
      if (!name) return '—';
      const parts = name.trim().split(/\s+/);
      if (parts.length === 1) return parts[0];
      const first = parts[0];
      const last  = parts[parts.length - 1];
      return `${first} ${last.charAt(0).toUpperCase()}.`;
    }
    function custLabel(c) {
      if (!c) return '—';
      if (c.is_company) return c.company_name || '—';
      return trimIndividual([c.first_name, c.last_name].filter(Boolean).join(' '));
    }
    out.recent_ids = clean
      .sort((a, b) => (effectiveAcceptedAt(b) || '').localeCompare(effectiveAcceptedAt(a) || ''))
      .map(d => ({
        id: d.id,
        accepted_at: effectiveAcceptedAt(d) ? new Date(effectiveAcceptedAt(d)).toISOString() : null,
        customer_label: custLabel(custMap.get(d.customer_id)),
        amount_incl: Math.round((perDeal.get(d.id) || 0) * 100) / 100,
      }));
  }
  return out;
}
