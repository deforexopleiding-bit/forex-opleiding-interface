// api/_lib/customer-name.js
// Centrale weergavenaam voor een klant — B2B (bedrijf) of B2C (particulier).
// Bedrijf → company_name; particulier → "voornaam achternaam".
// Backwards-compatible: oude records zonder is_company gedragen zich als B2C.

export function customerDisplayName(c, fallback = '') {
  if (!c) return fallback;
  if (c.is_company) return (c.company_name || '').trim() || fallback;
  const n = `${(c.first_name || '').trim()} ${(c.last_name || '').trim()}`.trim();
  return n || fallback;
}
