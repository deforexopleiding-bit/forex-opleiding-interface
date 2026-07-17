// api/_lib/customer-monthly-payment.js
//
// Bepaalt het maandbedrag van een klant op basis van actieve abonnementen.
// Wordt gebruikt als DYNAMISCHE ondergrens per termijn bij SPLITSING (#788):
// een regeling-termijn mag nooit onder het maandbedrag zakken, want dat is
// wat de klant al aantoonbaar per maand betaalt.
//
// Beleidsregels (Jeffrey, #788):
//   * Alleen status='active' abonnementen tellen.
//     - cancelled/completed → klant heeft geen lopend ritme → escaleren
//     - paused → tijdelijk niet-betalen; regeling-vraag verdient menselijke aandacht
//   * Meerdere actieve abo's → LAAGSTE maandbedrag telt.
//     Argument: dat is z'n zwakste ritme; boven mag, onder niet (verergert
//     z'n zwakste positie).
//   * Geen actief abo → hasSubscription=false → callers moeten SPLITSING
//     weigeren en escaleren.
//
// Maandbedrag-formule (spiegelt api/inbox-conversation-context.js r55-70 +
// api/sales-mrr-report.js r14 om consistent te blijven met MRR-berekening):
//   incl_per_termijn = line_items.length
//     ? sum(li.amount * (1 + li.vat_percentage/100))     -- mix-safe per regel
//     : amount * (1 + vat_percentage/100)                -- legacy fallback
//   maandbedrag = incl_per_termijn / cycleMonths(billing_cycle)
//
// Koppeling klant → abo: 2-staps via deals (subscriptions.deal_id →
// deals.customer_id). Er is geen directe FK op subscriptions.

const CYCLE_MONTHS = { per_month: 1, per_2_months: 2, per_quarter: 3, per_6_months: 6, per_year: 12 };

function cycleMonths(label) {
  if (!label) return 1; // wizard-subs zonder billing_cycle = per_month
  if (CYCLE_MONTHS[label] != null) return CYCLE_MONTHS[label];
  const m = String(label).match(/per_(\d+)_months/);
  return m ? Number(m[1]) : 1;
}

function inclPerTerm(sub) {
  const lines = Array.isArray(sub.line_items) ? sub.line_items : [];
  if (lines.length) {
    return lines.reduce(
      (sum, li) => sum + (Number(li.amount) || 0) * (1 + (Number(li.vat_percentage) || 0) / 100),
      0,
    );
  }
  return (Number(sub.amount) || 0) * (1 + (Number(sub.vat_percentage) || 0) / 100);
}

/**
 * @param {SupabaseClient} supabase — typisch supabaseAdmin
 * @param {string} customerId — uuid
 * @returns {Promise<{
 *   hasSubscription: boolean,
 *   monthlyAmount:   number | null,   // EUR incl BTW, laagste van actieve abo's
 *   currency:        'EUR',
 *   subscriptions:   Array<{ id, description, monthly_amount, billing_cycle }>,
 * }>}
 * Fail-soft: DB-fout → { hasSubscription:false, monthlyAmount:null,
 *   subscriptions:[] }. Callers moeten defensief zijn: null → SPLITSING niet
 * toestaan, escaleren naar mens.
 */
export async function getCustomerMonthlyPayment(supabase, customerId) {
  const empty = { hasSubscription: false, monthlyAmount: null, currency: 'EUR', subscriptions: [] };
  if (!customerId) return empty;
  try {
    // Stap 1: deals van deze klant.
    const { data: deals, error: dErr } = await supabase
      .from('deals')
      .select('id')
      .eq('customer_id', customerId);
    if (dErr) {
      console.warn('[customer-monthly-payment] deals lookup fail:', dErr.message);
      return empty;
    }
    const dealIds = (deals || []).map((d) => d.id);
    if (!dealIds.length) return empty;

    // Stap 2: actieve subs op die deals.
    const { data: subs, error: sErr } = await supabase
      .from('subscriptions')
      .select('id, deal_id, amount, vat_percentage, billing_cycle, line_items, status, description')
      .in('deal_id', dealIds)
      .eq('status', 'active');
    if (sErr) {
      console.warn('[customer-monthly-payment] subscriptions lookup fail:', sErr.message);
      return empty;
    }
    if (!subs || !subs.length) return empty;

    const monthly = subs.map((s) => {
      const perTerm = inclPerTerm(s);
      const months  = cycleMonths(s.billing_cycle);
      const monthlyAmount = months > 0 ? perTerm / months : perTerm;
      return {
        id:              s.id,
        description:     s.description || '(zonder omschrijving)',
        monthly_amount:  Math.round(monthlyAmount * 100) / 100,
        billing_cycle:   s.billing_cycle || 'per_month',
      };
    }).filter((s) => s.monthly_amount > 0);

    if (!monthly.length) return empty;

    // Laagste maandbedrag = z'n zwakste ritme = strengste ondergrens.
    const lowest = monthly.reduce((min, s) => (s.monthly_amount < min ? s.monthly_amount : min), monthly[0].monthly_amount);
    return {
      hasSubscription: true,
      monthlyAmount:   Math.round(lowest * 100) / 100,
      currency:        'EUR',
      subscriptions:   monthly,
    };
  } catch (e) {
    console.warn('[customer-monthly-payment] exception:', e?.message || e);
    return empty;
  }
}
