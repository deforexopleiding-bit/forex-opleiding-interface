// api/_lib/expenses-dashboard.js
//
// Pure JS-helpers voor het dashboard-endpoint. Geen Supabase.
// - aggregateByMonth(txs) → chronologische maand-totalen
// - aggregateByGroup(txs, catByTxId, catMetaById) → operationeel/vennoten/belasting
//
// Belangrijk: caller zorgt dat tx-set IDENTIEK is aan wat breakdown gebruikt
// (zelfde filter: interne uit, incoming uit, alleen source rule/manual voor
// categorisaties). Deze helpers doen géén eigen filtering — anders lopen
// dashboard-totalen uiteen met breakdown-totalen.

const PARTNERS_SLUG = 'winstuitkering-vennoten';
const TAXES_SLUG    = 'belastingen_heffingen';

/**
 * Aggregeer tx per YYYY-MM (van booking_date).
 * Retourneert chronologisch gesorteerde lijst { month, total_cents, tx_count }.
 */
export function aggregateByMonth(txs) {
  const acc = new Map();  // 'YYYY-MM' → { total, count }
  const RE = /^(\d{4}-\d{2})-\d{2}/;
  for (const t of txs || []) {
    const d = String(t.booking_date || '');
    const m = d.match(RE);
    if (!m) continue;
    const key = m[1];
    if (!acc.has(key)) acc.set(key, { total: 0, count: 0 });
    const b = acc.get(key);
    b.total += Number(t.amount_cents) || 0;
    b.count += 1;
  }
  return Array.from(acc.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, b]) => ({ month, total_cents: b.total, tx_count: b.count }));
}

/**
 * Aggregeer tx in 3 groepen op basis van category-slug:
 *   - partners  = winstuitkering-vennoten
 *   - taxes     = belastingen_heffingen
 *   - operational = alles anders (inclusief ongecategoriseerd)
 *
 * Interne overboekingen (is_internal=true) worden NIET meegenomen — die zijn
 * al door de caller uitgefilterd (net als bij breakdown).
 */
export function aggregateByGroup(txs, catByTxId, catMetaById) {
  const out = {
    operational_cents: 0, operational_count: 0,
    partners_cents:    0, partners_count:    0,
    taxes_cents:       0, taxes_count:       0,
  };
  for (const t of txs || []) {
    const cents = Number(t.amount_cents) || 0;
    const cat   = catByTxId?.get?.(t.id);
    const meta  = cat ? catMetaById?.get?.(cat.category_id) : null;
    const slug  = meta?.slug || null;
    if (slug === PARTNERS_SLUG) {
      out.partners_cents += cents; out.partners_count++;
    } else if (slug === TAXES_SLUG) {
      out.taxes_cents += cents; out.taxes_count++;
    } else {
      out.operational_cents += cents; out.operational_count++;
    }
  }
  return out;
}

/**
 * Aggregeer tx per categorie (spiegel van bestaande breakdown-helper, maar
 * zonder de zero-bucket-uitbreiding — we tonen alleen categorieën met data
 * of 'ongecategoriseerd').
 */
export function aggregateByCategory(txs, catByTxId, catMetaById) {
  const acc = new Map();  // cat_id → { total, count }
  let uncatTotal = 0, uncatCount = 0;
  for (const t of txs || []) {
    const cents = Number(t.amount_cents) || 0;
    const cat = catByTxId?.get?.(t.id);
    const meta = cat ? catMetaById?.get?.(cat.category_id) : null;
    if (!meta) {
      uncatTotal += cents; uncatCount++;
      continue;
    }
    if (!acc.has(meta.id)) acc.set(meta.id, { total: 0, count: 0, meta });
    const b = acc.get(meta.id);
    b.total += cents;
    b.count += 1;
  }
  const total = (txs || []).reduce((s, t) => s + (Number(t.amount_cents) || 0), 0);
  const totalAbs = Math.abs(total);
  const rows = Array.from(acc.values()).map(({ meta, total: t, count }) => ({
    id: meta.id, slug: meta.slug, label: meta.label, color: meta.color,
    total_cents: t, tx_count: count,
    pct: totalAbs > 0 ? Math.round((Math.abs(t) / totalAbs) * 1000) / 10 : 0,
  }));
  // Sorteer meest-negatief eerst (grootste uitgave bovenaan).
  rows.sort((a, b) => a.total_cents - b.total_cents);
  return {
    categories: rows,
    uncategorized: {
      total_cents: uncatTotal, tx_count: uncatCount,
      pct: totalAbs > 0 ? Math.round((Math.abs(uncatTotal) / totalAbs) * 1000) / 10 : 0,
    },
    total_cents: total,
  };
}
