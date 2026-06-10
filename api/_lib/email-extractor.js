// api/_lib/email-extractor.js
// Helpers voor de Joost autonomous intake-flow (E2 intake):
//   1) extractEmail(text)          → herkent een e-mailadres in vrije WhatsApp-tekst,
//                                    returnt lowercase + trimmed of null.
//   2) findCustomerByEmail(db, em) → zoekt 1 actieve klant op case-insensitief
//                                    e-mailadres-match. Returnt customer-row of null.
//
// Pattern-keuzes:
//   - Email-regex is bewust eenvoudig (geen RFC5322-volledigheid): vangt de
//     gangbare adressen + voorkomt false-positives op losse @-tokens.
//   - Lookup gebruikt .ilike() op de partial-index 'idx_customers_email_active'
//     (migratie 012). .ilike behoudt index-gebruik bij de '=' shape die we
//     bouwen, en is consistent met inbox-customer-search.js. Geen lower()-call
//     nodig in de query — PostgREST mapt ilike op een index-vriendelijke vorm.
//   - Bij 0 of meerdere matches returnen we null. Caller (joost-suggest / webhook)
//     beslist over fallback-flow (escalation-taak, opnieuw vragen, etc.).

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Probeer een geldig e-mailadres uit een stuk vrije tekst te halen.
 *
 * @param {string|null|undefined} text
 * @returns {string|null} lowercase + trimmed email, of null als niets gevonden.
 */
export function extractEmail(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(EMAIL_RE);
  if (!m || !m[0]) return null;
  return m[0].toLowerCase().trim();
}

/**
 * Zoek een actieve klant op exact e-mailadres (case-insensitief).
 *
 * - Filtert archived_at / anonymized_at = NULL (consistent met findCustomerByPhone
 *   in inbox-webhook.js: alleen klanten die in de UI bestaan koppelen).
 * - Returnt alleen bij precies 1 hit; bij 0 of >1 (ambigu) null. Caller beslist
 *   over fallback (MANUAL_FOLLOWUP-taak, escalatie, etc.).
 *
 * @param {object} supabaseAdmin — service-role client (RLS bypass).
 * @param {string} email          — verwacht al lowercase / trimmed.
 * @returns {Promise<object|null>} customer-row { id, email, ... } of null.
 */
export async function findCustomerByEmail(supabaseAdmin, email) {
  if (!email || typeof email !== 'string') return null;
  const target = email.trim();
  if (!target) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, email, phone, first_name, last_name, company_name, is_company')
      .ilike('email', target)
      .is('archived_at', null)
      .is('anonymized_at', null)
      .limit(2); // 2 zodat we ambiguïteit kunnen detecteren zonder over-fetch
    if (error) {
      console.error('[email-extractor] findCustomerByEmail error:', error.message);
      return null;
    }
    if (!Array.isArray(data) || data.length !== 1) return null;
    return data[0];
  } catch (e) {
    console.error('[email-extractor] findCustomerByEmail exception:', e && e.message);
    return null;
  }
}
