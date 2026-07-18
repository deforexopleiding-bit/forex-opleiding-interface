// api/_lib/customer-link.js
//
// Pure helpers voor de bedrijf ↔ persoon koppeling (v1 lokaal). Backend-alleen
// (geen TL-sync in fase 1). Wordt gebruikt door:
//   - api/customer.js               — GET verrijking met linked_company /
//                                     linked_persons.
//   - api/customer-link-company.js  — POST link/unlink met server-side gate
//                                     op type-invariant (persoon ↔ bedrijf).
//
// Zie migratie docs/sql-migrations/2026-07-18-customer-link-company.sql voor
// het schema (customers.company_customer_id).

/**
 * Herkent alle PG/PostgREST-varianten die op "kolom ontbreekt" wijzen. Wordt
 * gebruikt zodat GET fail-soft valt terug op zonder-link-payload (migratie
 * nog niet gedraaid) en het link-endpoint een 501 met migratie-instructie
 * kan geven i.p.v. een 500.
 *
 * Bekende codes:
 *   42703    — PG kolom bestaat niet (echte DDL mismatch)
 *   PGRST204 — PostgREST schema-cache miss (bv. na migratie zonder NOTIFY)
 *   PGRST205 — PostgREST relation missing (zelde in deze context)
 *   plus text-match op "could not find the" / "schema cache" varianten.
 *
 * @param {object|null} err  supabase-js error-object
 * @returns {boolean}
 */
export function isMissingColumnError(err) {
  if (!err) return false;
  if (err.code === '42703' || err.code === 'PGRST204' || err.code === 'PGRST205') return true;
  const msg = String(err.message || '') + ' ' + String(err.details || '') + ' ' + String(err.hint || '');
  return /could not find the/i.test(msg) || /schema cache/i.test(msg) || /column .* does not exist/i.test(msg);
}

/**
 * Bepaal de weergave-naam voor een klant-row consistent met de rest van
 * klanten.html (customerDisplayName). Voor bedrijven de company_name; voor
 * personen "First Last".
 *
 * @param {object|null} c  customer-row (partial OK)
 * @returns {string|null}
 */
export function customerLabel(c) {
  if (!c) return null;
  if (c.is_company) return (c.company_name || '').trim() || null;
  const first = (c.first_name || '').trim();
  const last  = (c.last_name  || '').trim();
  const full = (first + ' ' + last).trim();
  return full || null;
}

/**
 * Valideer een link-verzoek. Retourneert null als OK, anders een
 * error-object dat naar de HTTP-response gemapt kan worden.
 *
 * Regels:
 *   - person moet is_company=false (of null — coerce naar false).
 *   - target (indien niet-null) moet is_company=true.
 *   - Geen self-link (person_customer_id === company_customer_id).
 *   - Person en target moeten beide bestaan.
 *
 * @param {object} args
 * @param {object|null} args.person       customer-row (persoon), of null als niet gevonden
 * @param {object|null} args.company      customer-row (bedrijf), of null bij ontkoppel-request
 * @param {string} args.personId          input person id
 * @param {string|null} args.companyId    input company id (of null bij ontkoppel)
 * @returns {null|{status:number,body:object}}
 */
export function validateLinkRequest({ person, company, personId, companyId }) {
  if (!person) {
    return { status: 404, body: { error: 'Persoon-klant niet gevonden', field: 'person_customer_id' } };
  }
  if (person.is_company === true) {
    return {
      status: 400,
      body: {
        error: 'person_customer_id moet naar een persoon-klant wijzen (is_company=false)',
        code: 'PERSON_MUST_NOT_BE_COMPANY',
        field: 'person_customer_id',
      },
    };
  }
  // Ontkoppel-verzoek: companyId=null is legitiem (link leegmaken).
  if (companyId === null) return null;
  if (personId === companyId) {
    return {
      status: 400,
      body: {
        error: 'Kan een klant niet aan zichzelf koppelen',
        code: 'CANNOT_SELF_LINK',
        field: 'company_customer_id',
      },
    };
  }
  if (!company) {
    return { status: 404, body: { error: 'Bedrijf-klant niet gevonden', field: 'company_customer_id' } };
  }
  if (company.is_company !== true) {
    return {
      status: 400,
      body: {
        error: 'company_customer_id moet naar een bedrijf-klant wijzen (is_company=true)',
        code: 'COMPANY_MUST_BE_COMPANY',
        field: 'company_customer_id',
      },
    };
  }
  return null;
}
