// api/_lib/test-data-filter.js
// Gedeelde helpers om test-data uit dashboard-aggregates te weren.
//
// Achtergrond: onboarding-automation-test insert customers-rijen met
// is_test=true (+ hun onboardings/deals-vervolg). Er is GEEN is_test-vlag
// op `deals` of `subscriptions` zelf — die worden test via hun customer_id.
//
// Read-only. Elke helper cache-loos (roept fresh); ok voor de dashboard-
// aggregates die per-request al Vercel-cold-start-lag hebben.

/**
 * @returns {Promise<Set<string>>} customer-IDs die is_test=true zijn.
 */
export async function fetchTestCustomerIds(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('is_test', true)
    .limit(10000);
  if (error) throw new Error('test-customers: ' + error.message);
  return new Set((data || []).map(r => r.id));
}

/**
 * Deals die tot een test-customer horen. Deal-tabel zelf heeft geen is_test.
 * @returns {Promise<Set<string>>} deal-IDs die als test beschouwd worden.
 */
export async function fetchTestDealIds(supabaseAdmin) {
  const testCustomers = await fetchTestCustomerIds(supabaseAdmin);
  if (testCustomers.size === 0) return new Set();
  const { data, error } = await supabaseAdmin
    .from('deals')
    .select('id')
    .in('customer_id', Array.from(testCustomers))
    .limit(20000);
  if (error) throw new Error('test-deals: ' + error.message);
  return new Set((data || []).map(r => r.id));
}
