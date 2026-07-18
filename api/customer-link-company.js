// api/customer-link-company.js
//
// POST → Koppel of ontkoppel een persoon-klant aan/van een bedrijf-klant.
//
// Body: { person_customer_id: uuid, company_customer_id: uuid | null }
//   - company_customer_id=null (of ontbreekt) → ontkoppelen.
//   - company_customer_id=<uuid> → koppelen (of hersluiten van bestaande link).
//
// Auth: identiek aan /api/customer PATCH — verifyAdmin (admin/manager/super_admin).
// De klanten-module page-gate laat sales/mentor ook binnen voor READ, maar
// koppel-mutaties blijven bij admin.
//
// Response 200: { ok:true, person_id, company_id | null, linked_company | null }.
// Response 4xx:
//   400 PERSON_MUST_NOT_BE_COMPANY / COMPANY_MUST_BE_COMPANY / CANNOT_SELF_LINK
//   404 person of company niet gevonden
//   409 klant is gearchiveerd/geanonimiseerd
//   501 MIGRATION_REQUIRED — kolom company_customer_id bestaat nog niet
//
// Audit: schrijft customer.linked / customer.unlinked naar audit_log via
// logCustomerAudit (fail-soft; before/after = de gewijzigde persoon-row).
//
// Fase 2 (buiten scope): TL-sync via contacts.linkToCompany.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';
import { isMissingColumnError, customerLabel, validateLinkRequest } from './_lib/customer-link.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const personId = typeof body.person_customer_id === 'string' ? body.person_customer_id.trim() : '';
  const rawCompanyId = body.company_customer_id;
  const companyId = (rawCompanyId == null || rawCompanyId === '')
    ? null
    : (typeof rawCompanyId === 'string' ? rawCompanyId.trim() : '');

  if (!UUID_RE.test(personId)) {
    return res.status(400).json({ error: 'person_customer_id (uuid) is verplicht' });
  }
  if (companyId !== null && !UUID_RE.test(companyId)) {
    return res.status(400).json({ error: 'company_customer_id moet uuid of null zijn' });
  }

  try {
    // Persoon + (indien opgegeven) bedrijf tegelijk ophalen. Ook lock-status
    // (archived/anonymized) meenemen voor de gate hieronder.
    const { data: person, error: pErr } = await supabaseAdmin
      .from('customers')
      .select('id, is_company, first_name, last_name, company_name, archived_at, anonymized_at')
      .eq('id', personId)
      .maybeSingle();
    if (pErr) throw new Error('person fetch: ' + pErr.message);

    let company = null;
    if (companyId) {
      const { data: comp, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, first_name, last_name, company_name, email, phone, archived_at, anonymized_at')
        .eq('id', companyId)
        .maybeSingle();
      if (cErr) throw new Error('company fetch: ' + cErr.message);
      company = comp;
    }

    // Type-invariant + self-link + not-found checks via shared helper.
    const invalid = validateLinkRequest({ person, company, personId, companyId });
    if (invalid) return res.status(invalid.status).json(invalid.body);

    // Status-gate — locked-state mag niet muteren.
    if (person.archived_at)   return res.status(409).json({ error: 'Persoon is gearchiveerd; eerst heractiveren.' });
    if (person.anonymized_at) return res.status(409).json({ error: 'Persoon is geanonimiseerd; niet bewerkbaar.' });
    if (company && company.archived_at)   return res.status(409).json({ error: 'Bedrijf is gearchiveerd; eerst heractiveren.' });
    if (company && company.anonymized_at) return res.status(409).json({ error: 'Bedrijf is geanonimiseerd; niet bewerkbaar.' });

    // Voor de audit-diff: fetch de HUIDIGE persoon-row inclusief
    // company_customer_id (indien beschikbaar) zodat before/after klopt. Als
    // de kolom er niet is → 501 met migratie-instructie.
    const { data: beforeFull, error: bErr } = await supabaseAdmin
      .from('customers')
      .select('*')
      .eq('id', personId)
      .maybeSingle();
    if (bErr) throw new Error('person full fetch: ' + bErr.message);

    if (!Object.prototype.hasOwnProperty.call(beforeFull || {}, 'company_customer_id')) {
      return res.status(501).json({
        error: 'Kolom company_customer_id ontbreekt in customers. Draai migratie docs/sql-migrations/2026-07-18-customer-link-company.sql en run vervolgens NOTIFY pgrst, \'reload schema\'.',
        code:  'MIGRATION_REQUIRED',
        migration: '2026-07-18-customer-link-company.sql',
      });
    }

    // Update. companyId=null → ontkoppelen; anders link zetten.
    const { data: after, error: uErr } = await supabaseAdmin
      .from('customers')
      .update({ company_customer_id: companyId })
      .eq('id', personId)
      .select('*')
      .single();
    if (uErr) {
      if (isMissingColumnError(uErr)) {
        return res.status(501).json({
          error: 'Kolom company_customer_id ontbreekt of is nog niet in PostgREST schema-cache. Draai migratie + NOTIFY pgrst.',
          code:  'MIGRATION_REQUIRED',
          migration: '2026-07-18-customer-link-company.sql',
        });
      }
      console.error('[customer-link-company] update error:', uErr.message);
      return res.status(500).json({ error: uErr.message });
    }

    // Audit (fail-soft).
    await logCustomerAudit({
      req,
      action:     companyId ? 'customer.linked' : 'customer.unlinked',
      customerId: personId,
      before:     beforeFull,
      after,
      userId:     admin.user.id,
    });

    return res.status(200).json({
      ok:         true,
      person_id:  personId,
      company_id: companyId,
      linked_company: company ? {
        id:    company.id,
        name:  customerLabel(company),
        email: company.email || null,
        phone: company.phone || null,
      } : null,
    });
  } catch (err) {
    console.error('[customer-link-company]', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Interne serverfout' });
  }
}
