// api/_lib/expenses-recurring.js
//
// Pure JS-helpers voor terugkerende-lasten-detectie ("vaste lasten &
// besparen"). Geen Supabase, geen HTTP — deterministisch testbaar.
//
// Gebruikt door api/finance-expenses-recurring.js.

// ── Naam-normalisatie (minimaal, alleen voor detectie-groepering) ─────────
// Doel: varianten als "GOOGLE*ADS2258929925", "GOOGLE ADS", "Google Ads   "
// bundelen als één abonnement. NIET destructief — de originele
// counterparty_name blijft in DB en UI; deze normalize is puur voor de
// terugkerend-detectie.
//
// Regels (conservatief, alleen wat consistent is):
//   - trim + lowercase
//   - strip trailing digits + '*'-tekens (order-ids/refs)
//   - collapse whitespace
//   - drop trailing punctuatie (.,-)
export function normalizeCounterparty(name) {
  if (name == null) return '';
  let s = String(name).toLowerCase().trim();
  if (!s) return '';
  // Strip trailing numeric/asterisk tokens (bv. "google*ads2258929925" → "google*ads")
  // NB: we strippen alleen ACHTERAAN, niet in het midden — anders wordt "3M" → "".
  s = s.replace(/[\s*\-.,]*[\d*]+[\s*\-.,]*$/g, '');
  // Collapse interne whitespace + trim opnieuw.
  s = s.replace(/\s+/g, ' ').trim();
  // Nogmaals trailing punctuatie strippen (na strip van cijfers).
  s = s.replace(/[\s*\-.,]+$/g, '').trim();
  return s;
}

// ── Datum-utils (pure, geen Date-parsing in productiepad) ────────────────
// Converteer YYYY-MM-DD naar day-number (dagen sinds epoch, integer).
export function daysSinceEpoch(isoDate) {
  const m = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Math.floor(t / 86400000);
}

// ── Mediaan van array ──────────────────────────────────────────────────────
export function median(numbers) {
  if (!numbers || !numbers.length) return NaN;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

// ── Interval-classificatie op basis van mediaan-diff in dagen ─────────────
// Retourneert 'monthly' | 'quarterly' | 'yearly' | null.
// Tolerantie:
//   monthly:   25..40 dagen (dekt 28-31d cycli + kleine drift bij zwakke maanden)
//   quarterly: 82..100 dagen
//   yearly:    355..380 dagen
export function classifyInterval(medianDays) {
  if (!Number.isFinite(medianDays) || medianDays <= 0) return null;
  if (medianDays >= 25  && medianDays <= 40)  return 'monthly';
  if (medianDays >= 82  && medianDays <= 100) return 'quarterly';
  if (medianDays >= 355 && medianDays <= 380) return 'yearly';
  return null;
}

// ── Interval → dagen (voor "ongebruikt"-detectie) ────────────────────────
const INTERVAL_DAYS = { monthly: 30, quarterly: 91, yearly: 365 };

// ── Interval → maand-equivalent factor ────────────────────────────────────
const INTERVAL_MONTHLY_FACTOR = { monthly: 1, quarterly: 1 / 3, yearly: 1 / 12 };

/**
 * Voor 1 groep tx van dezelfde tegenpartij: bepaal of 't terugkerend is en
 * lever detail-info. Input: array tx-objecten met booking_date + amount_cents.
 * Retourneert null als de groep niet als terugkerend classificeert.
 */
export function detectRecurringForGroup(txs, opts = {}) {
  const { minTxCount = 3, minDistinctMonths = 3, todayDayNum = null } = opts;
  const validTxs = (txs || [])
    .filter(t => t && typeof t.booking_date === 'string')
    .map(t => ({ ...t, _dayNum: daysSinceEpoch(t.booking_date) }))
    .filter(t => Number.isFinite(t._dayNum))
    .sort((a, b) => a._dayNum - b._dayNum);
  if (validTxs.length < minTxCount) return null;

  // Distinct maanden check (YYYY-MM).
  const monthsSet = new Set(validTxs.map(t => t.booking_date.slice(0, 7)));
  if (monthsSet.size < minDistinctMonths) return null;

  // Diffs tussen opeenvolgende dates.
  const diffs = [];
  for (let i = 1; i < validTxs.length; i++) {
    diffs.push(validTxs[i]._dayNum - validTxs[i - 1]._dayNum);
  }
  const medianDiff = median(diffs);
  const interval = classifyInterval(medianDiff);
  if (!interval) return null;

  // Gemiddeld bedrag (absolute, want uitgaven zijn negatief).
  const amounts = validTxs.map(t => Math.abs(Number(t.amount_cents) || 0));
  const totalCents = amounts.reduce((s, n) => s + n, 0);
  const avgCents = Math.round(totalCents / amounts.length);
  const monthlyCents = Math.round(avgCents * (INTERVAL_MONTHLY_FACTOR[interval] || 0));

  const firstDate = validTxs[0].booking_date;
  const lastDate  = validTxs[validTxs.length - 1].booking_date;
  const lastDayNum = validTxs[validTxs.length - 1]._dayNum;

  // "Mogelijk ongebruikt": last tx > 2× interval-dagen geleden.
  // Conservatief: alleen als we een todayDayNum meekrijgen; anders skippen.
  let possibleUnused = false;
  let daysSinceLast = null;
  if (Number.isFinite(todayDayNum)) {
    daysSinceLast = todayDayNum - lastDayNum;
    if (daysSinceLast > 2 * INTERVAL_DAYS[interval]) possibleUnused = true;
  }

  return {
    interval,                    // 'monthly' | 'quarterly' | 'yearly'
    tx_count:      validTxs.length,
    distinct_months: monthsSet.size,
    median_days:   medianDiff,
    avg_amount_cents: avgCents,   // per-transactie
    monthly_cents: monthlyCents,  // omgerekend naar maandequivalent
    total_cents:   totalCents,    // over de gehele looptijd
    first_date:    firstDate,
    last_date:     lastDate,
    days_since_last: daysSinceLast,
    possible_unused: possibleUnused,
  };
}

/**
 * Orchestrator: neem alle tx (incl. optionele categoryByTxId map) →
 * groepeer per genormaliseerde naam → detecteer per groep.
 * Retourneert { recurring: [...], total_monthly_cents, insights: {...} }.
 */
export function detectRecurringAll(txs, opts = {}) {
  const { categoryByTxId, categoryMetaById, todayDayNum } = opts;
  // Groepeer per normalized name (behoud de "display name" = meest voorkomende
  // originele naam per groep, want die tonen we in UI).
  const groups = new Map();  // normKey → { displayName, count, txs }
  const displayCounts = new Map();  // normKey → Map<origName, count>
  for (const t of txs || []) {
    const orig = String(t.counterparty_name || '').trim();
    if (!orig) continue;
    const key = normalizeCounterparty(orig);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { normalizedName: key, txs: [] });
    groups.get(key).txs.push(t);
    if (!displayCounts.has(key)) displayCounts.set(key, new Map());
    const dc = displayCounts.get(key);
    dc.set(orig, (dc.get(orig) || 0) + 1);
  }

  const recurring = [];
  for (const [key, g] of groups) {
    const det = detectRecurringForGroup(g.txs, { todayDayNum });
    if (!det) continue;
    // Display name = meest voorkomende originele variant.
    const dc = displayCounts.get(key) || new Map();
    let bestName = key, bestCnt = 0;
    for (const [n, c] of dc) if (c > bestCnt) { bestName = n; bestCnt = c; }

    // Consensus-categorie: mode over de tx van deze groep (alleen source in
    // {rule, manual} — ai_suggest telt niet). Bij tie: null.
    let categoryId = null;
    let category = null;
    if (categoryByTxId && categoryMetaById) {
      const catCounts = new Map();
      for (const t of g.txs) {
        const c = categoryByTxId.get?.(t.id);
        if (!c || !c.category_id) continue;
        catCounts.set(c.category_id, (catCounts.get(c.category_id) || 0) + 1);
      }
      let best = 0;
      for (const [cid, cnt] of catCounts) {
        if (cnt > best) { best = cnt; categoryId = cid; }
      }
      if (categoryId) category = categoryMetaById.get(categoryId) || null;
    }

    recurring.push({
      normalized_name: key,
      display_name:    bestName,
      ...det,
      category_id:     categoryId,
      category,
    });
  }

  // Sort default: hoogste maandbedrag eerst (grootste bespaarkans).
  recurring.sort((a, b) => b.monthly_cents - a.monthly_cents);

  // "Mogelijk dubbel" — meerdere terugkerende in DEZELFDE categorie
  // (skip categorie 'overig' en null — te vaag om dubbel te noemen).
  const perCategory = new Map();
  for (const r of recurring) {
    if (!r.category_id || r.category?.slug === 'overig') continue;
    if (!perCategory.has(r.category_id)) perCategory.set(r.category_id, []);
    perCategory.get(r.category_id).push(r.normalized_name);
  }
  const duplicateCategoryIds = new Set();
  for (const [cid, arr] of perCategory) {
    if (arr.length >= 2) duplicateCategoryIds.add(cid);
  }
  for (const r of recurring) {
    r.possible_duplicate = !!(r.category_id && duplicateCategoryIds.has(r.category_id));
  }

  // Totaal per maand.
  const totalMonthlyCents = recurring.reduce((s, r) => s + (r.monthly_cents || 0), 0);

  return {
    recurring,
    total_monthly_cents: totalMonthlyCents,
    insights: {
      count_total:        recurring.length,
      count_monthly:      recurring.filter(r => r.interval === 'monthly').length,
      count_quarterly:    recurring.filter(r => r.interval === 'quarterly').length,
      count_yearly:       recurring.filter(r => r.interval === 'yearly').length,
      count_possibly_unused: recurring.filter(r => r.possible_unused).length,
      count_possibly_duplicate: recurring.filter(r => r.possible_duplicate).length,
    },
  };
}
