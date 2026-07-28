// api/_lib/expenses-grouping.js
// Pure-JS helpers voor uitgaven-analyse. Geen Supabase, geen HTTP —
// alleen accumulatie + filter + sort + consensus, zodat we ze in Node-tests
// deterministisch kunnen valideren. Gebruikt door:
//   - api/finance-expenses-counterparties.js
//   - api/finance-expenses-breakdown.js
//
// Contract:
//   tx-shape: { id, counterparty_name, amount_cents, booking_date, source }
//   cat-shape (per tx-id, indien gezet): { camt_transaction_id, category_id, source }
//   catMeta-shape (per category-id): { id, slug, label, color }

export const INTERNAL_NAMES = new Set(['(intern PayPal)']);
export const EMPTY_NAME = '(leeg)';

/**
 * Groepeer transacties per counterparty_name (getrimd; leeg → '(leeg)').
 * Retourneert een Map: name → { total, count, first, last, catCounts, manualCount }
 */
export function groupByCounterparty(txs, catByTxId) {
  const groups = new Map();
  for (const t of txs || []) {
    const name = String(t.counterparty_name || EMPTY_NAME).trim() || EMPTY_NAME;
    if (!groups.has(name)) {
      groups.set(name, { total: 0, count: 0, first: null, last: null, catCounts: new Map(), manualCount: 0 });
    }
    const g = groups.get(name);
    g.total += Number(t.amount_cents) || 0;
    g.count += 1;
    if (!g.first || t.booking_date < g.first) g.first = t.booking_date;
    if (!g.last  || t.booking_date > g.last)  g.last  = t.booking_date;
    const cat = catByTxId?.get?.(t.id);
    if (cat) {
      // ai_suggest telt NIET mee in consensus — dat is een voorstel, geen
      // bevestigde categorisatie. Alleen source in {rule, manual} (of legacy
      // undefined) draagt bij aan catCounts.
      if (cat.source === 'ai_suggest') continue;
      const catId = cat.category_id;
      g.catCounts.set(catId, (g.catCounts.get(catId) || 0) + 1);
      if (cat.source === 'manual') g.manualCount++;
    }
  }
  return groups;
}

/**
 * Bepaal per counterparty de AI-suggestie (mode-category over alle ai_suggest-
 * rijen). Retourneert Map: name → { category_id, avg_confidence, sample_reason, tx_count }.
 * De caller haalt ai_suggest-rijen apart op (zonder ze in catByTxId te stoppen
 * voor groupByCounterparty) en geeft ze hier door.
 */
export function aiSuggestionsByCounterparty(txs, aiSuggestByTxId) {
  const acc = new Map();  // name → { catId → { cnt, sumConf, firstReason } }
  for (const t of txs || []) {
    const name = String(t.counterparty_name || EMPTY_NAME).trim() || EMPTY_NAME;
    const sug = aiSuggestByTxId?.get?.(t.id);
    if (!sug) continue;
    if (!acc.has(name)) acc.set(name, new Map());
    const byCat = acc.get(name);
    const catId = sug.category_id;
    if (!byCat.has(catId)) byCat.set(catId, { cnt: 0, sumConf: 0, firstReason: null });
    const bucket = byCat.get(catId);
    bucket.cnt += 1;
    bucket.sumConf += Number(sug.ai_confidence) || 0;
    if (!bucket.firstReason && sug.ai_reason) bucket.firstReason = sug.ai_reason;
  }
  const out = new Map();
  for (const [name, byCat] of acc) {
    // Winnaar per counterparty: hoogste cnt (bij tie: hoogste avg conf).
    let bestCatId = null, bestCnt = 0, bestConf = 0, bestReason = null;
    for (const [catId, b] of byCat) {
      const avgConf = b.sumConf / Math.max(1, b.cnt);
      if (b.cnt > bestCnt || (b.cnt === bestCnt && avgConf > bestConf)) {
        bestCatId = catId; bestCnt = b.cnt; bestConf = avgConf; bestReason = b.firstReason;
      }
    }
    if (bestCatId) {
      out.set(name, {
        category_id:    bestCatId,
        avg_confidence: Math.round(bestConf * 100) / 100,
        sample_reason:  bestReason,
        tx_count:       bestCnt,
      });
    }
  }
  return out;
}

/**
 * Consensus-algoritme: welke categorie hoort bij deze groep?
 * Regel: highest-count wint, en moet >= 50% coverage hebben. Bij minder
 * coverage of tie → null (te veel spreiding → user beslist per tx).
 * Retourneert { categoryId, source, coverage }.
 */
export function consensusCategoryForGroup(g) {
  let bestCatId = null, bestCount = 0;
  for (const [cid, cnt] of g.catCounts) {
    if (cnt > bestCount) { bestCatId = cid; bestCount = cnt; }
  }
  const coverage = bestCount / Math.max(1, g.count);
  if (coverage < 0.5) return { categoryId: null, source: null, coverage };
  const source = (g.manualCount > 0 && bestCount === g.manualCount) ? 'manual' : 'rule';
  return { categoryId: bestCatId, source, coverage };
}

/**
 * Bouw eindrijen voor de counterparties-endpoint met alle filters
 * toegepast. filters = { includeInternal, includeInternalTransfers,
 * includeIncoming, onlyUncategorized, categoryFilter }.
 *
 * - includeInternal          — PayPal-CSV interne rijen ("(intern PayPal)" +
 *                              "(leeg)"). Bewaard-vasthouding-tegenboekingen.
 * - includeInternalTransfers — interne overboekingen tussen eigen rekeningen
 *                              (bv. ING → PayPal-oplaad). Bepaald via
 *                              category.is_internal=true. Default UIT om
 *                              dubbeltelling met PayPal-uitgaven te voorkomen.
 */
export function buildCounterpartyRows(groups, catMetaById, filters = {}) {
  const {
    includeInternal          = false,
    includeInternalTransfers = false,
    includeIncoming          = false,
    includeCredits           = false,
    onlyUncategorized        = false,
    categoryFilter           = null,
  } = filters;
  const rows = [];
  for (const [name, g] of groups) {
    if (!includeInternal && (INTERNAL_NAMES.has(name) || name === EMPTY_NAME)) continue;
    if (!includeIncoming && g.total >= 0) continue;
    const { categoryId, source } = consensusCategoryForGroup(g);
    const category = categoryId ? (catMetaById?.get?.(categoryId) || null) : null;
    // Interne overboekingen (bv. ING → PayPal) verbergen tenzij expliciet gevraagd.
    if (!includeInternalTransfers && category && category.is_internal === true) continue;
    // PayPal-terugbetalingen/credits verbergen tenzij expliciet gevraagd.
    // Signaal: category.is_credit=true (systeem-cat 'terugbetalingen-credits').
    if (!includeCredits && category && category.is_credit === true) continue;
    if (onlyUncategorized && category) continue;
    if (categoryFilter && (!category || category.id !== categoryFilter)) continue;
    rows.push({
      name,
      total_cents:     g.total,
      tx_count:        g.count,
      first_date:      g.first,
      last_date:       g.last,
      category,
      category_source: source,
    });
  }
  return rows;
}

/**
 * Sorteer counterparty-rijen. Sort-keys:
 *   'total_desc'    — meest-negatief eerst (default; grootste uitgave bovenaan)
 *   'total_abs_desc'— grootste absolute bedrag eerst
 *   'count_desc'    — meeste transacties eerst
 *   'name_asc'      — alfabetisch (nl-locale)
 */
export function sortCounterparties(rows, sortKey = 'total_desc') {
  const sorted = [...(rows || [])];
  sorted.sort((a, b) => {
    switch (sortKey) {
      case 'total_abs_desc': return Math.abs(b.total_cents) - Math.abs(a.total_cents);
      case 'count_desc':     return b.tx_count - a.tx_count;
      case 'name_asc':       return a.name.localeCompare(b.name, 'nl');
      case 'total_desc':
      default:               return a.total_cents - b.total_cents;
    }
  });
  return sorted;
}

/**
 * Filter transactie-lijst analoog aan buildCounterpartyRows (voor breakdown).
 * Retourneert alleen tx die zichtbaar moeten zijn na intern/incoming-filter.
 * Als includeInternalTransfers=false én er is een catByTxId met is_internal-
 * categorie-info, worden interne overboekingen ook gefilterd — dan telt hun
 * bedrag NIET mee in totalAll/breakdown.
 */
export function filterTransactionsForBreakdown(txs, catByTxId, catMetaById, filters = {}) {
  // Backward-compat: als de 2e/3e arg een filters-object is (oude signature),
  // shuffle 'em door zodat oude callers blijven werken.
  if (catByTxId && !(catByTxId instanceof Map) && typeof catByTxId === 'object') {
    filters = catByTxId;
    catByTxId = null;
    catMetaById = null;
  }
  const {
    includeInternal          = false,
    includeInternalTransfers = false,
    includeIncoming          = false,
    includeCredits           = false,
  } = filters || {};
  return (txs || []).filter(t => {
    const name = String(t.counterparty_name || EMPTY_NAME).trim() || EMPTY_NAME;
    if (!includeInternal && (INTERNAL_NAMES.has(name) || name === EMPTY_NAME)) return false;
    if (!includeIncoming && Number(t.amount_cents) >= 0) return false;
    if (catByTxId && catMetaById) {
      const cat = catByTxId.get?.(t.id);
      const meta = cat ? catMetaById.get?.(cat.category_id) : null;
      if (meta) {
        if (!includeInternalTransfers && meta.is_internal === true) return false;
        if (!includeCredits          && meta.is_credit   === true) return false;
      }
    }
    return true;
  });
}

/**
 * Aggregeer uitgaven per categorie (voor breakdown-endpoint).
 * Interne categorieën (is_internal=true) worden overgeslagen in de output.
 * Retourneert { categories: [...], uncategorized, totalAll, totalAbs }.
 */
export function computeBreakdown(txs, catByTxId, allCats) {
  const bucketByCat = new Map();
  const uncat = { total: 0, count: 0 };
  for (const t of txs || []) {
    const cat = catByTxId?.get?.(t.id);
    const catId = cat?.category_id;
    if (catId) {
      if (!bucketByCat.has(catId)) bucketByCat.set(catId, { total: 0, count: 0 });
      const b = bucketByCat.get(catId);
      b.total += Number(t.amount_cents) || 0;
      b.count += 1;
    } else {
      uncat.total += Number(t.amount_cents) || 0;
      uncat.count += 1;
    }
  }
  const totalAll = (txs || []).reduce((s, t) => s + (Number(t.amount_cents) || 0), 0);
  const totalAbs = Math.abs(totalAll);
  // Interne categorieën (is_internal=true) worden niet in de breakdown
  // getoond — dat zijn overboekingen, geen echte uitgaven. Callers zorgen dat
  // die tx sowieso al gefilterd waren via filterTransactionsForBreakdown,
  // dus buckets voor interne categorieën staan hier op 0. We droppen ze uit
  // de output-lijst zodat de UI ze niet als lege rij toont.
  // Interne + credit-categorieën verbergen we uit de breakdown-output (die
  // stromen tellen niet mee als operationele uitgave). Callers zorgen dat de
  // tx ook al gefilterd zijn via filterTransactionsForBreakdown.
  const categories = (allCats || [])
    .filter(cat => cat.is_internal !== true && cat.is_credit !== true)
    .map(cat => {
    const b = bucketByCat.get(cat.id) || { total: 0, count: 0 };
    return {
      id:          cat.id,
      slug:        cat.slug,
      label:       cat.label,
      color:       cat.color,
      total_cents: b.total,
      tx_count:    b.count,
      pct:         totalAbs > 0 ? Math.round((Math.abs(b.total) / totalAbs) * 1000) / 10 : 0,
    };
  }).sort((a, b) => a.total_cents - b.total_cents);
  return {
    categories,
    uncategorized: {
      total_cents: uncat.total,
      tx_count:    uncat.count,
      pct:         totalAbs > 0 ? Math.round((Math.abs(uncat.total) / totalAbs) * 1000) / 10 : 0,
    },
    totalAll,
    totalAbs,
  };
}
