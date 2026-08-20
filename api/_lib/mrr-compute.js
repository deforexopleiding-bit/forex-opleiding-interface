// api/_lib/mrr-compute.js
// Gedeelde MRR-berekening. Één bron-van-waarheid voor:
//   - finance-dashboard-counts.mrrSubscriptions   (v2-dashboard-tegel)
//   - sales-mrr-report.current_mrr                (Omzet & MRR-tab)
//   - super-admin-omzet.mrrInclBtw                (Super-admin dashboard KPI)
//
// KEUZES (bevestigd via DB-check 2026-08-20):
//   1) populatie = SNAPSHOT: start_date ≤ asOf AND (end_date IS NULL OR end_date ≥ asOf).
//      NIET status='active' — DB-check toonde snapshot=224 vs status='active'=348.
//      Correcte "lopende MRR" hangt aan het datum-venster, niet aan de status-vlag.
//   2) per-term-bedrag = amount * (1 + vat_percentage/100).
//      DB-check: amount == sum(line_items) voor alle 1140 subs → amount is
//      de canonical som, geen line-items-iteratie nodig. VAT komt via vat_percentage.
//   3) billing_cycle NULL → NIET default 1 (dat was de €10k-landmijn: 34 subs met
//      amount ≥ €1000 die als maandbedrag werden geteld). Leid cycle af uit:
//        A. term_count ≥ 1 EN start+end bekend → cycle = round((end-start)/term_count)
//        B. description-titel bevat "X maanden" / "X mnd" → cycle = X
//        C. start+end bekend en term_count == 1 → cycle = duur in maanden
//      Match afgeleide cycle tegen {1,2,3,6,12}; anders: sub UITGESLOTEN uit som
//      + gerapporteerd in `excluded`-array. Rather safe than wrong.
//
// Response van computeCurrentMrr(subs, {asOf}):
//   {
//     mrr:            number,   // incl BTW, gerond op 2 decimalen
//     count:          number,   // aantal subs in de snapshot (voor de som gebruikt)
//     asOf:           Date,     // welke datum-cutoff werd gebruikt
//     nullCycle: {
//       total:        number,   // aantal snapshot-subs met billing_cycle=NULL
//       inferred:     number,   // #NULL-cycles waarvoor we een cycle konden afleiden
//       excluded:     number,   // #NULL-cycles zonder afleiding → uitgesloten uit MRR
//       excludedIds:  string[], // IDs voor de rapport-modus (max 100)
//     },
//     excludedMrr:    number,   // wat we hadden geteld als we NULL→1 hadden aangenomen
//                              // (diagnose: hoe groot is de landmijn geweest?)
//   }
//
// Read-only helper: geen DB-writes, geen network-calls. Puur reken-logica.

const STANDARD_CYCLES = new Set([1, 2, 3, 6, 12]);
const CYCLE_LABELS = {
  per_month:    1,
  per_2_months: 2,
  per_quarter:  3,
  per_6_months: 6,
  per_year:     12,
};

// Rondt naar de dichtstbijzijnde standaard-cyclus (1/2/3/6/12) als binnen ±10%.
// Voorbeeld: 5.9 → 6, 11.5 → 12. Voorkomt dat 12.1 als exclude eindigt terwijl
// het gewoon 12 is met wat rounding-drift op start/end.
function snapToStandardCycle(m) {
  if (!Number.isFinite(m) || m <= 0) return null;
  for (const std of STANDARD_CYCLES) {
    if (Math.abs(m - std) <= std * 0.10) return std;
  }
  // Anders: verwerpen (geen exotische cycles zoals 4/8/9 in de som).
  return null;
}

function monthsBetween(startISO, endISO) {
  if (!startISO || !endISO) return null;
  const s = new Date(startISO);
  const e = new Date(endISO);
  if (isNaN(s) || isNaN(e)) return null;
  const days = (e - s) / (1000 * 60 * 60 * 24);
  return days / 30.4375; // gemiddelde maand-lengte
}

// Interne helper: bepaal cycle-maanden voor een sub.
// Returns:
//   { months: N }                 → OK, gebruik N
//   { months: null, tried: [] }   → afleiden faalde, sluit sub uit
function resolveCycleMonths(sub) {
  const raw = sub.billing_cycle;
  if (raw) {
    const c = String(raw).toLowerCase();
    if (CYCLE_LABELS[c] != null) return { months: CYCLE_LABELS[c] };
    const m = c.match(/per_(\d+)_months/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) return { months: n };
    }
    // Onbekend label → val door naar afleiding (soft).
  }
  const tried = [];
  // A. term_count + start+end.
  const tc = Number(sub.term_count) || 0;
  const totalMonths = monthsBetween(sub.start_date, sub.end_date);
  if (tc >= 1 && totalMonths != null && totalMonths > 0) {
    const guess = totalMonths / tc;
    const snap = snapToStandardCycle(guess);
    tried.push({ src: 'term_count', raw: guess, snap });
    if (snap) return { months: snap };
  }
  // B. description "X maanden" / "X mnd".
  const desc = String(sub.description || '');
  const dm = desc.match(/(\d{1,2})\s*(maand|mnd|month)/i);
  if (dm) {
    const n = parseInt(dm[1], 10);
    const snap = snapToStandardCycle(n);
    tried.push({ src: 'description', raw: n, snap });
    if (snap) return { months: snap };
  }
  // C. term_count implicit=1 → totaal duur = cycle.
  if (totalMonths != null && totalMonths > 0 && !tc) {
    const snap = snapToStandardCycle(totalMonths);
    tried.push({ src: 'total_duration', raw: totalMonths, snap });
    if (snap) return { months: snap };
  }
  return { months: null, tried };
}

// Per-term-bedrag incl BTW. amount * (1 + vat_percentage/100).
// DB-check bevestigde dat amount == sum(line_items[].amount). Geen line-items-loop.
function inclPerTerm(sub) {
  const amt = Number(sub.amount) || 0;
  const vat = Number(sub.vat_percentage) || 0;
  return amt * (1 + vat / 100);
}

function isSnapshotSub(sub, asOfISO) {
  if (!sub || !sub.start_date) return false;
  if (String(sub.start_date) > asOfISO) return false;
  if (sub.end_date && String(sub.end_date) < asOfISO) return false;
  return true;
}

/**
 * Bereken huidige MRR op een gegeven datum.
 * @param {Array} subs   subscription-rijen; verwachte kolommen:
 *   id, status, amount, vat_percentage, billing_cycle, term_count,
 *   start_date, end_date, description
 * @param {object} opts
 * @param {Date|string} [opts.asOf=today] datum-cutoff voor snapshot.
 * @returns {object} zie module-header.
 */
export function computeCurrentMrr(subs, opts = {}) {
  const asOfDate = opts.asOf ? new Date(opts.asOf) : new Date();
  const asOfISO = asOfDate.toISOString().slice(0, 10);

  let mrr = 0;
  let count = 0;
  let nullTotal = 0;
  let nullInferred = 0;
  let nullExcluded = 0;
  let excludedMrr = 0;
  const excludedIds = [];

  for (const s of (subs || [])) {
    if (!isSnapshotSub(s, asOfISO)) continue;
    const isNull = !s.billing_cycle;
    if (isNull) nullTotal += 1;
    const { months } = resolveCycleMonths(s);
    const perTerm = inclPerTerm(s);
    if (months == null) {
      // Uitgesloten. Bereken wat het WEL had geteld (diagnose).
      excludedMrr += perTerm; // in oude code: NULL→1 → perTerm was de MRR
      if (isNull) {
        nullExcluded += 1;
        if (excludedIds.length < 100) excludedIds.push(s.id);
      }
      continue;
    }
    if (isNull) nullInferred += 1;
    mrr += perTerm / months;
    count += 1;
  }

  return {
    mrr:         Math.round(mrr * 100) / 100,
    count,
    asOf:        asOfDate,
    nullCycle: {
      total:       nullTotal,
      inferred:    nullInferred,
      excluded:    nullExcluded,
      excludedIds,
    },
    excludedMrr: Math.round(excludedMrr * 100) / 100,
  };
}

/**
 * Column-lijst die callers uit `subscriptions` moeten selecteren om compute
 * correct te laten werken. Als je hier iets vergeet mist de helper data
 * (bv. zonder term_count valt de afleiding voor NULL-cycles terug op B/C).
 */
export const REQUIRED_SUB_COLUMNS = [
  'id', 'status', 'amount', 'vat_percentage', 'billing_cycle',
  'term_count', 'start_date', 'end_date', 'description',
];
