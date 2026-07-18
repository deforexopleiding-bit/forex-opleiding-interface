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
import { getOrCreateContact, getOrCreateTlCustomer } from './_lib/teamleader-contact.js';
import { linkContactToCompany, unlinkContactFromCompany } from './_lib/teamleader-contact-company-link.js';

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
    // (archived/anonymized) meenemen voor de gate hieronder. TL-fields
    // (tl_contact_id / tl_company_id + address/email/phone/dob) worden
    // meegeselecteerd zodat de fase-2 TL-sync direct beschikt over de IDs
    // (of ze via getOrCreate kan aanmaken zonder nog een fetch te doen).
    const CUSTOMER_TL_COLS = 'id, is_company, first_name, last_name, company_name, email, phone, date_of_birth, address_street, address_number, address_postal, address_city, address_country, tl_contact_id, tl_company_id, archived_at, anonymized_at';

    const { data: person, error: pErr } = await supabaseAdmin
      .from('customers')
      .select(CUSTOMER_TL_COLS)
      .eq('id', personId)
      .maybeSingle();
    if (pErr) throw new Error('person fetch: ' + pErr.message);

    let company = null;
    if (companyId) {
      const { data: comp, error: cErr } = await supabaseAdmin
        .from('customers')
        .select(CUSTOMER_TL_COLS + ', vat_number')
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

    // ── Fase 2: TL-sync via contacts.linkToCompany / unlinkFromCompany ──
    //
    // Best-effort: de lokale koppeling staat al gecommit en blijft staan óók
    // als de TL-push faalt. Reden: een TL-storing mag de werkende lokale
    // feature niet blokkeren. Frontend toont een subtiele waarschuwing als
    // tl_sync.ok === false. Audit log krijgt tl_sync-resultaat mee.
    //
    // Skip TL-sync als de klant archived/anonymized is (redundant — die
    // status-gate stond al hierboven, maar dubbele guard voor de zekerheid).
    let tlSync = { ok: false, skipped: true, reason: 'not_attempted' };
    const skipTlForStatus = (c) => !!(c && (c.archived_at || c.anonymized_at));

    if (companyId && company && !skipTlForStatus(person) && !skipTlForStatus(company)) {
      // LINK-path: zorg dat beide TL-IDs bestaan, dan linkToCompany.
      try {
        // Person's tl_contact_id — resolve of aanmaken via TL /contacts.add.
        let personTlId = person.tl_contact_id;
        if (!personTlId) {
          personTlId = await getOrCreateContact(person);
        }
        // Company's tl_company_id — resolve of aanmaken via TL /companies.add.
        let companyTlId = company.tl_company_id;
        if (!companyTlId) {
          const ref = await getOrCreateTlCustomer(company);
          companyTlId = ref?.id || null;
        }
        if (!personTlId || !companyTlId) {
          tlSync = {
            ok: false,
            skipped: false,
            error: 'TL-ID kon niet worden aangemaakt/gevonden voor person of company',
            person_tl_contact_id:  personTlId  || null,
            company_tl_company_id: companyTlId || null,
          };
        } else {
          const linkRes = await linkContactToCompany(personTlId, companyTlId);
          tlSync = {
            ok:                    linkRes.ok,
            skipped:               false,
            endpoint:              linkRes.endpoint,
            already_linked:        linkRes.already_linked || false,
            person_tl_contact_id:  personTlId,
            company_tl_company_id: companyTlId,
            error:                 linkRes.ok ? undefined : linkRes.error,
            status:                linkRes.status,
          };
          if (!linkRes.ok) {
            console.warn('[customer-link-company] TL link faalde:', linkRes.error);
          }
        }
      } catch (e) {
        console.warn('[customer-link-company] TL link exception:', e?.message || e);
        tlSync = {
          ok:      false,
          skipped: false,
          error:   'TL-sync exception: ' + (e?.message || 'onbekend'),
        };
      }
    } else if (!companyId) {
      // UNLINK-path: haal de VORIGE company op (via beforeFull.company_customer_id)
      // om z'n tl_company_id te vinden en TL te informeren.
      const prevCompanyCustomerId = beforeFull?.company_customer_id || null;
      if (!prevCompanyCustomerId) {
        // Ontkoppel-verzoek op een persoon die al niet gekoppeld was → niks te
        // doen bij TL. Geen fout.
        tlSync = { ok: true, skipped: true, reason: 'no_previous_link' };
      } else {
        try {
          const { data: prevCompany } = await supabaseAdmin
            .from('customers')
            .select('id, is_company, tl_company_id, archived_at, anonymized_at')
            .eq('id', prevCompanyCustomerId)
            .maybeSingle();
          if (!prevCompany || !prevCompany.tl_company_id) {
            tlSync = { ok: true, skipped: true, reason: 'previous_company_no_tl_id' };
          } else if (!person.tl_contact_id) {
            tlSync = { ok: true, skipped: true, reason: 'person_no_tl_contact_id' };
          } else if (skipTlForStatus(prevCompany)) {
            tlSync = { ok: true, skipped: true, reason: 'previous_company_locked' };
          } else {
            const unlinkRes = await unlinkContactFromCompany(person.tl_contact_id, prevCompany.tl_company_id);
            tlSync = {
              ok:                    unlinkRes.ok,
              skipped:               false,
              endpoint:              unlinkRes.endpoint,
              already_unlinked:      unlinkRes.already_unlinked || false,
              person_tl_contact_id:  person.tl_contact_id,
              company_tl_company_id: prevCompany.tl_company_id,
              error:                 unlinkRes.ok ? undefined : unlinkRes.error,
              status:                unlinkRes.status,
            };
            if (!unlinkRes.ok) {
              console.warn('[customer-link-company] TL unlink faalde:', unlinkRes.error);
            }
          }
        } catch (e) {
          console.warn('[customer-link-company] TL unlink exception:', e?.message || e);
          tlSync = {
            ok:      false,
            skipped: false,
            error:   'TL-sync exception: ' + (e?.message || 'onbekend'),
          };
        }
      }
    }

    // Audit (fail-soft) — before/after via bestaande helper. tl_sync-resultaat
    // beknopt in `reason` zodat een fase-3 reconciliation-cron kan filteren op
    // gefaalde syncs via audit_log.reason_text ILIKE '%tl_sync=fail%'. Volledige
    // tl_sync-object gaat naar console.log + de response.
    const auditReason = tlSync.ok
      ? (tlSync.skipped ? `tl_sync=skipped(${tlSync.reason || 'n/a'})` : 'tl_sync=ok')
      : `tl_sync=fail(${(tlSync.error || 'onbekend').slice(0, 200)})`;
    await logCustomerAudit({
      req,
      action:     companyId ? 'customer.linked' : 'customer.unlinked',
      customerId: personId,
      before:     beforeFull,
      after,
      reason:     auditReason,
      userId:     admin.user.id,
    });
    console.log('[customer-link-company] tl_sync', { personId, companyId, tl_sync: tlSync });

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
      tl_sync: tlSync,
    });
  } catch (err) {
    console.error('[customer-link-company]', err?.message || err);
    return res.status(500).json({ error: err?.message || 'Interne serverfout' });
  }
}
