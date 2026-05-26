// /api/customer  — Klanten-detail endpoint (Fase 2A.2 + 2A.3)
//
// Methods:
//   GET    ?id=<uuid>         → detail (single row + tags + counts)  [2A.2]
//   POST   (body)             → nieuwe klant aanmaken                [2A.3 commit 1]
//   PATCH  ?id=<uuid> (body)  → klant bijwerken                      [2A.3 commit 2]
//
// Auth: verifyAdmin(req) op ALLE methods (ADMIN_ROLES gate — consistent met
// /api/customers; granulaire customer.* check volgt bij matrix-wide rollout).
//
// Audit: POST/PATCH/archive schrijven naar audit_log via _lib/audit-customer.js
// (fail-soft — audit-fail breekt de mutatie niet).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Witelist: alleen deze velden mag de client setten via POST/PATCH.
// Server-managed (created_at/updated_at/created_by_user_id) en status-flow
// (archived_at/anonymized_at/anonymization_reason) NIET hierin.
// 'notes' bewust NIET hierin — gedeprecateerd via migratie 013 COMMENT;
// notities lopen via customer_notes-tabel (Fase 2A.4).
const WRITABLE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone', 'date_of_birth',
  'address_street', 'address_number', 'address_postal', 'address_city',
  'tl_contact_id', 'ghl_contact_id',
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  if (req.method === 'GET')   return handleGet(req, res);
  if (req.method === 'POST')  return handlePost(req, res, admin);
  if (req.method === 'PATCH') return handlePatch(req, res, admin);

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

    return res.status(200).json({
      customer: {
        ...customer,
        status: deriveStatus(customer),
        tags,
        notes_count: notesCount || 0,
        audit_count: auditCount || 0,
      },
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

  // Required-fields
  const firstName = (cleaned.first_name || '').trim();
  const lastName  = (cleaned.last_name  || '').trim();
  if (!firstName) return res.status(400).json({ error: 'Voornaam is verplicht', field: 'first_name' });
  if (!lastName)  return res.status(400).json({ error: 'Achternaam is verplicht', field: 'last_name' });
  cleaned.first_name = firstName;
  cleaned.last_name  = lastName;

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

  // first_name / last_name: als in body, mogen NIET leeg worden
  if (Object.prototype.hasOwnProperty.call(cleaned, 'first_name')) {
    const v = String(cleaned.first_name || '').trim();
    if (!v) return res.status(400).json({ error: 'Voornaam mag niet leeg zijn', field: 'first_name' });
    cleaned.first_name = v;
  }
  if (Object.prototype.hasOwnProperty.call(cleaned, 'last_name')) {
    const v = String(cleaned.last_name || '').trim();
    if (!v) return res.status(400).json({ error: 'Achternaam mag niet leeg zijn', field: 'last_name' });
    cleaned.last_name = v;
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
        && !['first_name','last_name','email','date_of_birth'].includes(k)) {
      const t = cleaned[k].trim();
      cleaned[k] = t === '' ? null : t;
    }
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

    // 2) Status-gate
    if (before.archived_at)   return res.status(403).json({ error: 'Klant is gearchiveerd; eerst heractiveren.' });
    if (before.anonymized_at) return res.status(403).json({ error: 'Klant is geanonimiseerd; niet bewerkbaar.' });

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
    });
  } catch (err) {
    console.error('[customer PATCH] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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
