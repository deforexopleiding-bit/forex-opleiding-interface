// api/_lib/leads-promote.js
// Pure helpers voor de leads-promote-flow: valideer een lead + bepaal of we
// een bestaande customer moeten linken of een nieuwe aanmaken. Geen Supabase,
// geen HTTP — deterministisch testbaar met mocks.
//
// Business rules (zie tests/leads-promote.test.js voor alle scenarios):
//   - Lead moet een e-mail hebben (case-insensitive-trim); anders 422.
//   - Als er al een customers-rij is met exact die (case-insensitive) email:
//     LINK die, maak GEEN nieuwe aan.
//   - Anders: maak nieuwe customer met naam-splits (voornaam/achternaam) +
//     telefoon.
//   - Als de lead al gepromoveerd is (status='gewonnen' + customer_id gezet):
//     idempotent no-op — return existing customer_id, geen tweede write.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normaliseer een email voor lookup-key. Trim + toLowerCase. Retourneert ''
 * voor null/undefined/geen-@.
 */
export function normalizeEmail(email) {
  if (!email || typeof email !== 'string') return '';
  const t = email.trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : '';
}

/**
 * Splits een "naam"-veld in voornaam + achternaam voor customers-insert.
 * Regel: alles voor de eerste spatie = voornaam, rest = achternaam. Bij één
 * woord: alles = voornaam, achternaam = null.
 */
export function splitName(naam) {
  const s = String(naam || '').trim();
  if (!s) return { first_name: null, last_name: null };
  const idx = s.indexOf(' ');
  if (idx === -1) return { first_name: s, last_name: null };
  return {
    first_name: s.slice(0, idx).trim() || null,
    last_name:  s.slice(idx + 1).trim() || null,
  };
}

/**
 * Valideer een lead-rij (uit leads_overzicht of leads) voor promote.
 * Retourneert { ok: true, email } of { ok: false, code, message }.
 *
 * Codes:
 *   'lead-not-found'      — geen lead met dit id
 *   'email-required'      — lead heeft geen (geldige) email → geen halve customer maken
 *   'already-promoted'    — lead is al doorgezet (status='gewonnen' + customer_id)
 */
export function validateLeadForPromote(lead) {
  if (!lead || typeof lead !== 'object') {
    return { ok: false, code: 'lead-not-found', message: 'Lead niet gevonden' };
  }
  if (lead.status === 'gewonnen' && lead.customer_id) {
    return { ok: false, code: 'already-promoted', message: 'Deze lead is al doorgezet', existing_customer_id: lead.customer_id };
  }
  const email = normalizeEmail(lead.email);
  if (!email) {
    return { ok: false, code: 'email-required', message: 'Lead heeft geen geldig e-mailadres — kan geen customer aanmaken zonder e-mail' };
  }
  return { ok: true, email };
}

/**
 * Beslis: gebruik bestaande customer of maak nieuwe. Retourneert
 *   { action: 'link', customer_id }             — bestaande customer hergebruiken
 *   { action: 'create', payload }               — nieuwe customer met deze payload
 *
 * `existingCustomer` is null of een customers-rij (uit een prior lookup op
 * email). `lead` is de bron-lead-rij met naam/email/telefoon.
 */
export function decidePromoteAction(lead, existingCustomer) {
  if (existingCustomer && existingCustomer.id) {
    return { action: 'link', customer_id: existingCustomer.id };
  }
  const { first_name, last_name } = splitName(lead.naam);
  return {
    action: 'create',
    payload: {
      first_name,
      last_name,
      email: normalizeEmail(lead.email),
      phone: lead.telefoon ? String(lead.telefoon).trim() : null,
    },
  };
}
