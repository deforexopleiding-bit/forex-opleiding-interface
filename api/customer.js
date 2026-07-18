// /api/customer  — Klanten-detail endpoint (Fase 2A.2 + 2A.3)
//
// Methods:
//   GET    ?id=<uuid>         → detail (single row + tags + counts)  [2A.2]
//   POST   (body)             → nieuwe klant aanmaken                [2A.3 commit 1]
//   PATCH  ?id=<uuid> (body)  → klant bijwerken                      [2A.3 commit 2]
//
// Auth (method-gesplitst):
//   GET    → verifyAdmin(req) OF requirePermission(req,'customer.module.access').
//            Manager/sales/mentor hebben customer.module.access via migratie
//            014/015 + de klanten.html page-gate; READ moet voor hen open zijn
//            anders kunnen ze geen klant openen vanuit aanwezige/onboarding.
//   POST   → verifyAdmin(req) — admin-only (writes blijven beschermd).
//   PATCH  → verifyAdmin(req) — admin-only.
//
// Audit: POST/PATCH/archive schrijven naar audit_log via _lib/audit-customer.js
// (fail-soft — audit-fail breekt de mutatie niet).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { logCustomerAudit } from './_lib/audit-customer.js';
import { tlFetch } from './_lib/teamleader-token.js';
import { isMissingColumnError, customerLabel } from './_lib/customer-link.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Witelist: alleen deze velden mag de client setten via POST/PATCH.
// Server-managed (created_at/updated_at/created_by_user_id) en status-flow
// (archived_at/anonymized_at/anonymization_reason) NIET hierin.
// 'notes' bewust NIET hierin — gedeprecateerd via migratie 013 COMMENT;
// notities lopen via customer_notes-tabel (Fase 2A.4).
const WRITABLE_FIELDS = [
  'is_company', 'company_name', 'kvk_number', 'vat_number',
  'first_name', 'last_name', 'email', 'phone', 'date_of_birth',
  'address_street', 'address_number', 'address_postal', 'address_city',
  'tl_contact_id', 'ghl_contact_id',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Method-resolve VOOR auth — zo krijgen onbekende methods 405 i.p.v. 403,
  // wat clients sneller naar de juiste oorzaak leidt.
  if (req.method === 'GET') {
    // GET = read-only detail. Admin mag altijd; niet-admin mag mits hij de
    // customer.module.access-key heeft (manager/sales/mentor via 014/015).
    // Identiek aan de page-gate op klanten.html — anders kan een mentor de
    // klant openen vanuit aanwezige/onboarding maar het detail niet laden.
    const admin = await verifyAdmin(req);
    if (!admin) {
      const allowed = await requirePermission(req, 'customer.module.access');
      if (!allowed) {
        return res.status(403).json({ error: 'Toegang geweigerd. customer.module.access vereist.' });
      }
    }
    return handleGet(req, res);
  }

  if (req.method === 'POST') {
    // Create blijft admin-only — geen verbreding naar manager/sales/mentor.
    const admin = await verifyAdmin(req);
    if (!admin) {
      return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
    }
    return handlePost(req, res, admin);
  }

  if (req.method === 'PATCH') {
    // Update blijft admin-only.
    const admin = await verifyAdmin(req);
    if (!admin) {
      return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
    }
    return handlePatch(req, res, admin);
  }

  res.setHeader('Allow', 'GET, POST, PATCH');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

// ── GET — detail ─────────────────────────────────────────────────────────────

async function handleGet(req, res) {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid customer ID format' });

  try {
    const { data: customer, error: custErr } = await supabaseAdmin
      .from('customers').select('*').eq('id', id).maybeSingle();
    if (custErr) throw new Error('customer fetch: ' + custErr.message);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });

    const { data: tagRows, error: tagErr } = await supabaseAdmin
      .from('customer_tags')
      .select('customer_tag_definitions(slug, label, color)')
      .eq('customer_id', id);
    if (tagErr) throw new Error('tags fetch: ' + tagErr.message);
    const tags = (tagRows || [])
      .map((r) => r.customer_tag_definitions)
      .filter(Boolean)
      .map((d) => ({ slug: d.slug, label: d.label, color: d.color }));

    const { count: notesCount, error: nErr } = await supabaseAdmin
      .from('customer_notes').select('id', { count: 'exact', head: true })
      .eq('customer_id', id).is('archived_at', null);
    if (nErr) throw new Error('notes count: ' + nErr.message);

    const { count: auditCount, error: aErr } = await supabaseAdmin
      .from('audit_log').select('id', { count: 'exact', head: true })
      .eq('entity_type', 'customer').eq('entity_id', id);
    if (aErr) throw new Error('audit count: ' + aErr.message);

    // Bedrijf ↔ persoon koppeling (v1 lokaal). Defensief: als de kolom
    // company_customer_id nog niet bestaat (migratie 2026-07-18 niet
    // gedraaid), skippen we deze lookups fail-soft. GET blijft functioneel.
    let linkedCompany = null;
    let linkedPersons = [];
    let linkAvailable = true;
    const cci = Object.prototype.hasOwnProperty.call(customer, 'company_customer_id')
      ? customer.company_customer_id
      : undefined;
    if (cci === undefined) {
      // customer.select('*') gaf de kolom niet terug → kolom bestaat niet.
      linkAvailable = false;
    } else {
      // Persoon → hoort deze bij een bedrijf?
      if (customer.is_company === false && cci) {
        const { data: comp, error: compErr } = await supabaseAdmin
          .from('customers')
          .select('id, is_company, company_name, first_name, last_name, email, phone')
          .eq('id', cci)
          .maybeSingle();
        if (compErr && !isMissingColumnError(compErr)) {
          console.warn('[customer GET] linked_company fetch:', compErr.message);
        } else if (comp && comp.is_company === true) {
          linkedCompany = {
            id: comp.id,
            name: customerLabel(comp),
            email: comp.email || null,
            phone: comp.phone || null,
          };
        }
      }
      // Bedrijf → welke personen zijn eraan gekoppeld?
      if (customer.is_company === true) {
        const { data: personRows, error: prErr } = await supabaseAdmin
          .from('customers')
          .select('id, is_company, first_name, last_name, email, phone')
          .eq('company_customer_id', id)
          .order('last_name', { ascending: true, nullsFirst: false });
        if (prErr) {
          if (isMissingColumnError(prErr)) {
            linkAvailable = false;
          } else {
            console.warn('[customer GET] linked_persons fetch:', prErr.message);
          }
        } else {
          linkedPersons = (personRows || [])
            .filter((r) => r && r.is_company === false)
            .map((r) => ({
              id: r.id,
              name: customerLabel(r),
              email: r.email || null,
              phone: r.phone || null,
            }));
        }
      }
    }

    return res.status(200).json({
      customer: {
        ...customer,
        status: deriveStatus(customer),
        tags,
        notes_count: notesCount || 0,
        audit_count: auditCount || 0,
      },
      linked_company: linkedCompany,
      linked_persons: linkedPersons,
      link_available: linkAvailable,
    });
  } catch (err) {
    console.error('[customer GET] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── POST — create ────────────────────────────────────────────────────────────
//
// Body (JSON): { first_name, last_name, email?, phone?, date_of_birth?,
//                address_street?, address_number?, address_postal?, address_city?,
//                tl_contact_id?, ghl_contact_id?, notes? }
//
// Validatie:
//   - first_name, last_name verplicht (trim → non-empty)
//   - email format (als gegeven)
//   - date_of_birth ISO YYYY-MM-DD (als gegeven)
//
// Response 201: { customer: <volledige row> }  + Location header
// Errors: 400 { error, field? } / 403 / 500
//
// Audit: customer.created — before_json=null, after_json=full row.

async function handlePost(req, res, admin) {
  const body = req.body || {};
  const cleaned = pickWritable(body);

  // Type: bedrijf (B2B) of particulier (B2C). Backwards-compatible default = B2C.
  const isCompany = cleaned.is_company === true || cleaned.is_company === 'true';
  cleaned.is_company = isCompany;
  if (isCompany) {
    const cn = (cleaned.company_name || '').trim();
    if (!cn) return res.status(400).json({ error: 'Bedrijfsnaam is verplicht', field: 'company_name' });
    cleaned.company_name = cn;
    // Contactpersoon (voor-/achternaam) optioneel bij een bedrijf.
    cleaned.first_name = (cleaned.first_name || '').trim() || null;
    cleaned.last_name  = (cleaned.last_name  || '').trim() || null;
  } else {
    const firstName = (cleaned.first_name || '').trim();
    const lastName  = (cleaned.last_name  || '').trim();
    if (!firstName) return res.status(400).json({ error: 'Voornaam is verplicht', field: 'first_name' });
    if (!lastName)  return res.status(400).json({ error: 'Achternaam is verplicht', field: 'last_name' });
    cleaned.first_name = firstName;
    cleaned.last_name  = lastName;
  }

  // Format-validatie (alleen niet-leeg veld checken)
  if (cleaned.email != null && String(cleaned.email).trim() !== '') {
    const e = String(cleaned.email).trim();
    if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'Ongeldig email-formaat', field: 'email' });
    cleaned.email = e;
  } else {
    delete cleaned.email;
  }
  if (cleaned.date_of_birth != null && String(cleaned.date_of_birth).trim() !== '') {
    const d = String(cleaned.date_of_birth).trim();
    if (!ISO_DATE_RE.test(d)) return res.status(400).json({ error: 'Geboortedatum moet ISO-formaat zijn (YYYY-MM-DD)', field: 'date_of_birth' });
    cleaned.date_of_birth = d;
  } else {
    delete cleaned.date_of_birth;
  }

  // Trim string-velden, gooi lege strings weg (DB stores NULL i.p.v. '')
  for (const k of Object.keys(cleaned)) {
    if (typeof cleaned[k] === 'string') {
      const t = cleaned[k].trim();
      if (t === '') delete cleaned[k];
      else cleaned[k] = t;
    }
  }

  // Server-managed velden
  cleaned.created_by_user_id = admin.user.id;

  // AVG-privacy: acceptatie-stempel server-side zetten (niet client-controlled).
  if (body.privacy_accepted === true || body.privacy_accepted === 'true') {
    cleaned.privacy_accepted_at = new Date().toISOString();
    cleaned.privacy_accepted_by_user_id = admin.user.id;
  }

  try {
    const { data: customer, error: insErr } = await supabaseAdmin
      .from('customers').insert(cleaned).select('*').single();
    if (insErr) {
      console.error('[customer POST] insert error:', insErr.message);
      return res.status(500).json({ error: insErr.message });
    }

    // Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: 'customer.created',
      customerId: customer.id,
      before: null,
      after: customer,
      userId: admin.user.id,
    });

    res.setHeader('Location', `/api/customer?id=${encodeURIComponent(customer.id)}`);
    return res.status(201).json({
      customer: {
        ...customer,
        status: deriveStatus(customer),
        tags: [],          // nieuwe klant heeft nog geen tag-koppelingen
        notes_count: 0,
        audit_count: 1,    // de net-aangemaakte audit-entry
      },
    });
  } catch (err) {
    console.error('[customer POST] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── PATCH — update ───────────────────────────────────────────────────────────
//
// Query: ?id=<uuid>  (verplicht)
// Body : partial customer (WRITABLE_FIELDS); alleen aanwezige velden worden geüpdatet.
//
// PATCH-semantiek (vs POST):
//   - field niet in body   → NIET aangeraakt
//   - field = ''  in body  → DB-NULL (clear het veld) — voor optionele velden
//   - first_name/last_name in body met empty trim → 400 (kan niet leegmaken)
//
// Status-gate: archived/anonymized → 403 (geen edits toegestaan; eerst heractiveren).
// Geen optimistic-concurrency check (last-write-wins; 2A.3 MVP).
//
// Audit: customer.updated — before=oude row, after=nieuwe row.
//   Server slaat full before/after op; UI berekent diff bij audit-rendering.
//
// Response 200: { customer: <volledige nieuwe row + status/tags/counts> }
// Errors: 400 (validatie / geen geldige velden) / 403 (auth of locked-state)
//         / 404 (customer bestaat niet) / 500.

async function handlePatch(req, res, admin) {
  const id = String(req.query.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing customer id' });
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Invalid customer ID format' });

  const body = req.body || {};
  const cleaned = pickWritable(body);

  // is_company: coerce naar boolean indien meegegeven. Identiteits-validatie
  // (company_name vs first+last) gebeurt na de pre-fetch op de samengevoegde staat,
  // zodat first_name/last_name leegmaken is toegestaan zodra het een bedrijf is.
  if (Object.prototype.hasOwnProperty.call(cleaned, 'is_company')) {
    cleaned.is_company = cleaned.is_company === true || cleaned.is_company === 'true';
  }

  // Email — empty string clear (=NULL); niet-empty → format-check
  if (Object.prototype.hasOwnProperty.call(cleaned, 'email')) {
    const e = String(cleaned.email || '').trim();
    if (e === '') cleaned.email = null;
    else if (!EMAIL_RE.test(e)) return res.status(400).json({ error: 'Ongeldig email-formaat', field: 'email' });
    else cleaned.email = e;
  }

  // Geboortedatum — empty string clear (=NULL); niet-empty → ISO-check
  if (Object.prototype.hasOwnProperty.call(cleaned, 'date_of_birth')) {
    const d = String(cleaned.date_of_birth || '').trim();
    if (d === '') cleaned.date_of_birth = null;
    else if (!ISO_DATE_RE.test(d)) return res.status(400).json({ error: 'Geboortedatum moet ISO-formaat zijn (YYYY-MM-DD)', field: 'date_of_birth' });
    else cleaned.date_of_birth = d;
  }

  // Overige optionele strings: trim → empty wordt NULL (clear)
  for (const k of Object.keys(cleaned)) {
    if (typeof cleaned[k] === 'string'
        && !['email','date_of_birth'].includes(k)) {
      const t = cleaned[k].trim();
      cleaned[k] = t === '' ? null : t;
    }
  }

  // AVG-privacy: acceptatie-stempel server-side (UI stuurt dit enkel als nog niet eerder gezet).
  if (body.privacy_accepted === true || body.privacy_accepted === 'true') {
    cleaned.privacy_accepted_at = new Date().toISOString();
    cleaned.privacy_accepted_by_user_id = admin.user.id;
  }

  if (Object.keys(cleaned).length === 0) {
    return res.status(400).json({ error: 'Geen geldige velden om te updaten' });
  }

  try {
    // 1) Lees oude staat (voor audit-before + status-gate)
    const { data: before, error: bErr } = await supabaseAdmin
      .from('customers').select('*').eq('id', id).maybeSingle();
    if (bErr) throw new Error('customer pre-fetch: ' + bErr.message);
    if (!before) return res.status(404).json({ error: 'Klant niet gevonden' });

    // 2) Status-gate — 409 = "Conflict": klant is in locked-state, niet bewerkbaar.
    if (before.archived_at)   return res.status(409).json({ error: 'Klant is gearchiveerd; eerst heractiveren.' });
    if (before.anonymized_at) return res.status(409).json({ error: 'Klant is geanonimiseerd; niet bewerkbaar.' });

    // 2b) Identiteit valideren op de samengevoegde staat (B2B: bedrijfsnaam; B2C: voor+achternaam).
    const merged = { ...before, ...cleaned };
    if (merged.is_company) {
      if (!String(merged.company_name || '').trim()) return res.status(400).json({ error: 'Bedrijfsnaam is verplicht', field: 'company_name' });
    } else {
      if (!String(merged.first_name || '').trim()) return res.status(400).json({ error: 'Voornaam is verplicht', field: 'first_name' });
      if (!String(merged.last_name || '').trim())  return res.status(400).json({ error: 'Achternaam is verplicht', field: 'last_name' });
    }

    // 2c) Synchrone TL-push vóór DB-commit (Fase 4 bidirectionele sync).
    //   - B2C met tl_contact_id → /contacts.update
    //   - B2B met tl_company_id → /companies.update
    //   - Zonder TL-id → skip TL-call, DB-update doorgaan (klant is nog niet
    //     gekoppeld; eerst koppelen via offerte/factuur-flow).
    //   - TL-4xx → 422 + tl_request_payload + tl_request_keys + tl_response echo,
    //     DB-write wordt NIET uitgevoerd (TL = source of truth voor klantdata).
    //   - TL-5xx of netwerk → 502 + tl_response, DB-write NIET uitgevoerd.
    const tlSyncResult = await pushCustomerToTl({ before, cleaned, merged });
    if (tlSyncResult.error) {
      return res.status(tlSyncResult.httpStatus).json(tlSyncResult.body);
    }

    // 3) UPDATE (trg_customers_updated zet updated_at = now())
    const { data: after, error: uErr } = await supabaseAdmin
      .from('customers').update(cleaned).eq('id', id).select('*').single();
    if (uErr) {
      console.error('[customer PATCH] update error:', uErr.message);
      return res.status(500).json({ error: uErr.message });
    }

    // 4) Audit (fail-soft) — full before/after; UI rendert diff client-side
    await logCustomerAudit({
      req, action: 'customer.updated',
      customerId: id, before, after,
      userId: admin.user.id,
    });

    // 5) Response met tags + counts (consistent met GET/POST shape)
    const { data: tagRows } = await supabaseAdmin
      .from('customer_tags').select('customer_tag_definitions(slug, label, color)').eq('customer_id', id);
    const tags = (tagRows || []).map((r) => r.customer_tag_definitions).filter(Boolean)
      .map((d) => ({ slug: d.slug, label: d.label, color: d.color }));
    const { count: notesCount } = await supabaseAdmin
      .from('customer_notes').select('id', { count: 'exact', head: true })
      .eq('customer_id', id).is('archived_at', null);
    const { count: auditCount } = await supabaseAdmin
      .from('audit_log').select('id', { count: 'exact', head: true })
      .eq('entity_type', 'customer').eq('entity_id', id);

    return res.status(200).json({
      customer: {
        ...after,
        status: deriveStatus(after),
        tags,
        notes_count: notesCount || 0,
        audit_count: auditCount || 0,
      },
      tl_synced:          tlSyncResult.synced,
      tl_endpoint:        tlSyncResult.endpoint || null,
      tl_fields_updated:  tlSyncResult.fieldsUpdated || [],
      tl_skip_reason:     tlSyncResult.skipReason || null,
    });
  } catch (err) {
    console.error('[customer PATCH] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Push customer-changes naar Teamleader (contacts.update of companies.update).
 *
 * Strategie:
 *   - Bouw payload op basis van `cleaned` (de gewijzigde velden) gecombineerd met
 *     `merged` (volledige nieuwe staat) — TL vervangt arrays (emails/telephones/
 *     addresses) volledig, dus bij elke wijziging in die clusters sturen we de
 *     gewenste eindstaat (primary entry).
 *   - Geen TL-call als er na mapping geen TL-relevante velden in payload zitten
 *     (alleen interne velden gewijzigd zoals tl_contact_id of ghl_contact_id).
 *   - Geen TL-call als er geen tl_contact_id (B2C) of tl_company_id (B2B) is —
 *     klant nog niet gekoppeld; lokale edit mag wel doorgaan.
 *
 * BEKEND RISICO (gedocumenteerd voor Fase 4 v1):
 *   - Bij email-wijziging vervangen we de hele emails-array door één primary.
 *     Als de klant in TL meerdere emails (cc, admin) had: die gaan verloren.
 *     Mitigatie voor v2: eerst contacts.info ophalen, merge met huidige emails-
 *     array. Voor v1 acceptabel omdat DFO klanten typisch één email hebben.
 *   - Idem voor telephones en addresses.
 *
 * @returns {Promise<{
 *   error: false, synced: boolean, endpoint?: string, fieldsUpdated?: string[], skipReason?: string,
 * } | {
 *   error: true, httpStatus: number, body: object,
 * }>}
 */
async function pushCustomerToTl({ before, cleaned, merged }) {
  const isCompany = merged.is_company === true;
  const tlId = isCompany ? before.tl_company_id : before.tl_contact_id;
  if (!tlId) {
    return { error: false, synced: false, skipReason: isCompany ? 'geen tl_company_id' : 'geen tl_contact_id' };
  }

  // Bepaal of een cluster (email/phone/address) is gewijzigd. Bij ja: sturen we
  // de complete primary-entry uit `merged` mee.
  const has = (k) => Object.prototype.hasOwnProperty.call(cleaned, k);
  const emailChanged   = has('email');
  const phoneChanged   = has('phone');
  const addrChanged    = has('address_street') || has('address_number') || has('address_postal') || has('address_city');

  const payload = { id: tlId };
  const fieldsUpdated = [];

  if (isCompany) {
    // /companies.update
    if (has('company_name'))   { payload.name = (merged.company_name || '').trim(); fieldsUpdated.push('name'); }
    if (has('vat_number'))     { payload.vat_number = (merged.vat_number || '').trim() || null; fieldsUpdated.push('vat_number'); }
    if (has('kvk_number'))     { payload.national_identification_number = (merged.kvk_number || '').trim() || null; fieldsUpdated.push('national_identification_number'); }
  } else {
    // /contacts.update
    if (has('first_name'))     { payload.first_name = (merged.first_name || '').trim(); fieldsUpdated.push('first_name'); }
    if (has('last_name'))      { payload.last_name  = (merged.last_name  || '').trim(); fieldsUpdated.push('last_name'); }
    if (has('date_of_birth'))  {
      const dob = (merged.date_of_birth ? String(merged.date_of_birth).slice(0, 10) : null);
      payload.birthdate = dob;  // null = clear (TL accepteert null voor optioneel veld)
      fieldsUpdated.push('birthdate');
    }
  }

  // Gedeeld voor B2B + B2C: emails/telephones/addresses.
  if (emailChanged) {
    const e = (merged.email || '').trim();
    payload.emails = e ? [{ type: 'primary', email: e }] : [];
    fieldsUpdated.push('emails');
  }
  if (phoneChanged) {
    const p = (merged.phone || '').trim();
    payload.telephones = p ? [{ type: 'phone', number: p }] : [];
    fieldsUpdated.push('telephones');
  }
  if (addrChanged) {
    const street = (merged.address_street || '').trim();
    const number = (merged.address_number || '').trim();
    const line1 = [street, number].filter(Boolean).join(' ').trim();
    const postal = (merged.address_postal || '').trim();
    const city   = (merged.address_city || '').trim();
    if (line1 || postal || city) {
      payload.addresses = [{
        type: 'primary',
        address: {
          line_1:      line1 || null,
          postal_code: postal || null,
          city:        city || null,
          country:     'NL',
        },
      }];
    } else {
      // Alle adres-velden zijn leeg → expliciet lege array (clear address in TL).
      payload.addresses = [];
    }
    fieldsUpdated.push('addresses');
  }

  // Geen TL-relevante velden in payload? Alleen interne flags gewijzigd → skip TL-call.
  if (fieldsUpdated.length === 0) {
    return { error: false, synced: false, skipReason: 'geen TL-relevante velden in wijziging' };
  }

  const endpoint = isCompany ? '/companies.update' : '/contacts.update';
  let r, tlText = '';
  try {
    r = await tlFetch(endpoint, { method: 'POST', body: JSON.stringify(payload) });
    tlText = await r.text().catch(() => '');
  } catch (netErr) {
    console.error('[customer PATCH] TL netwerk', endpoint, netErr.message);
    return {
      error: true, httpStatus: 502,
      body: {
        error: 'Teamleader niet bereikbaar: ' + netErr.message,
        tl_endpoint: endpoint,
        tl_request_payload: payload,
        tl_request_keys: Object.keys(payload),
        tl_response: 'NETWERK: ' + netErr.message,
      },
    };
  }

  if (r.ok) {
    console.log(`[customer PATCH] TL OK | ${endpoint} | tl_id=${tlId} | fields=${fieldsUpdated.join(',')}`);
    return { error: false, synced: true, endpoint, fieldsUpdated };
  }

  // 4xx of 5xx — echo volledige payload + response voor diagnose.
  const isClient = r.status >= 400 && r.status < 500;
  console.error(`[customer PATCH] TL ${r.status} | ${endpoint} | response=`, tlText.slice(0, 500));
  return {
    error: true,
    httpStatus: isClient ? 422 : 502,
    body: {
      error: isClient
        ? `Teamleader weigerde update (HTTP ${r.status}). DB-wijziging niet uitgevoerd.`
        : `Teamleader gaf serverfout (HTTP ${r.status}). DB-wijziging niet uitgevoerd.`,
      tl_endpoint: endpoint,
      tl_status: r.status,
      tl_request_payload: payload,
      tl_request_keys: Object.keys(payload),
      tl_response: tlText.slice(0, 2000),
    },
  };
}


function deriveStatus(c) {
  if (c.anonymized_at) return 'anonymized';
  if (c.archived_at) return 'archived';
  return 'active';
}

/**
 * Witelist body → alleen WRITABLE_FIELDS doorlaten.
 * Voorkomt dat client per ongeluk/moedwillig server-managed velden
 * (archived_at, created_at, …) probeert te setten.
 */
function pickWritable(body) {
  const out = {};
  for (const k of WRITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}
