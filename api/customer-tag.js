// /api/customer-tag  — Tag-toekenning per klant (Fase 2A.4 commit 1).
//
// Methods:
//   POST   body: { customer_id, tag_slug }   → koppel tag aan klant
//   DELETE body: { customer_id, tag_slug }   → ontkoppel tag van klant
//                (Vercel DELETE-bodies werken; alternatief is query-params).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate, consistent met andere customer-endpoints).
//
// Status-gate:
//   - archived/anonymized klant → 403 (geen mutaties op locked state).
//
// Audit (entity_type='customer', entity_id=customer_id):
//   customer.tag.added   → before=null, after={slug,label,color}
//   customer.tag.removed → before={slug,label,color}, after=null
//
// Response (200 voor beide methods):
//   { customer_id, tags: [{slug,label,color}, ...] }   // volledige set ná mutatie
//
// Errors: 400 (format) / 403 (auth of locked) / 404 (customer/tag bestaat niet of
//   tag niet gekoppeld bij DELETE) / 405 / 409 (al gekoppeld bij POST) / 500.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { logCustomerAudit } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9_-]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  if (req.method === 'POST')   return handlePost(req, res, admin);
  if (req.method === 'DELETE') return handleDelete(req, res, admin);

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

// ── POST — tag koppelen ──────────────────────────────────────────────────────

async function handlePost(req, res, admin) {
  const { customer_id, tag_slug } = parseBody(req.body);
  const valErr = validate(customer_id, tag_slug);
  if (valErr) return res.status(400).json(valErr);

  try {
    // 1) Customer bestaat + status-gate
    const customer = await fetchCustomer(customer_id);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
    const lockedErr = checkLocked(customer);
    if (lockedErr) return res.status(403).json(lockedErr);

    // 2) Tag-definition bestaat (zodat 409 != 404 onderscheidbaar is in errors)
    const tagDef = await fetchTagDefinition(tag_slug);
    if (!tagDef) return res.status(404).json({ error: `Tag '${tag_slug}' bestaat niet`, field: 'tag_slug' });

    // 3) INSERT (UNIQUE-conflict → 409)
    const { error: insErr } = await supabaseAdmin
      .from('customer_tags').insert({
        customer_id,
        tag_slug,
        created_by_user_id: admin.user.id,
      });
    if (insErr) {
      // Postgres unique-violation code = 23505 (PostgREST geeft 'duplicate key' in message)
      const msg = String(insErr.message || '');
      if (msg.includes('duplicate') || msg.includes('unique')) {
        return res.status(409).json({ error: 'Tag is al gekoppeld aan deze klant' });
      }
      console.error('[customer-tag POST] insert error:', msg);
      return res.status(500).json({ error: msg });
    }

    // 4) Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: 'customer.tag.added',
      customerId: customer_id,
      before: null,
      after: { slug: tagDef.slug, label: tagDef.label, color: tagDef.color },
      userId: admin.user.id,
    });

    // 5) Response met volledige tags-set
    const tags = await fetchTagsForCustomer(customer_id);
    return res.status(200).json({ customer_id, tags });
  } catch (err) {
    console.error('[customer-tag POST] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── DELETE — tag ontkoppelen ─────────────────────────────────────────────────

async function handleDelete(req, res, admin) {
  // Body bij DELETE kan ontbreken in sommige clients; ook query als fallback.
  const src = (req.body && Object.keys(req.body).length) ? req.body : req.query;
  const { customer_id, tag_slug } = parseBody(src);
  const valErr = validate(customer_id, tag_slug);
  if (valErr) return res.status(400).json(valErr);

  try {
    const customer = await fetchCustomer(customer_id);
    if (!customer) return res.status(404).json({ error: 'Klant niet gevonden' });
    const lockedErr = checkLocked(customer);
    if (lockedErr) return res.status(403).json(lockedErr);

    // Definition lookup (voor audit before-payload)
    const tagDef = await fetchTagDefinition(tag_slug);
    if (!tagDef) return res.status(404).json({ error: `Tag '${tag_slug}' bestaat niet`, field: 'tag_slug' });

    // DELETE (idempotentie: 404 als rij niet bestond)
    const { data: deleted, error: dErr } = await supabaseAdmin
      .from('customer_tags').delete()
      .eq('customer_id', customer_id).eq('tag_slug', tag_slug)
      .select('id');
    if (dErr) {
      console.error('[customer-tag DELETE] delete error:', dErr.message);
      return res.status(500).json({ error: dErr.message });
    }
    if (!deleted || deleted.length === 0) {
      return res.status(404).json({ error: 'Tag was niet gekoppeld aan deze klant' });
    }

    // Audit (fail-soft)
    await logCustomerAudit({
      req,
      action: 'customer.tag.removed',
      customerId: customer_id,
      before: { slug: tagDef.slug, label: tagDef.label, color: tagDef.color },
      after: null,
      userId: admin.user.id,
    });

    const tags = await fetchTagsForCustomer(customer_id);
    return res.status(200).json({ customer_id, tags });
  } catch (err) {
    console.error('[customer-tag DELETE] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseBody(src) {
  src = src || {};
  return {
    customer_id: String(src.customer_id || '').trim(),
    tag_slug:    String(src.tag_slug    || '').trim().toLowerCase(),
  };
}

function validate(customer_id, tag_slug) {
  if (!customer_id) return { error: 'Missing customer_id', field: 'customer_id' };
  if (!UUID_RE.test(customer_id)) return { error: 'Invalid customer_id format', field: 'customer_id' };
  if (!tag_slug) return { error: 'Missing tag_slug', field: 'tag_slug' };
  if (!SLUG_RE.test(tag_slug)) return { error: 'Invalid tag_slug format', field: 'tag_slug' };
  return null;
}

async function fetchCustomer(id) {
  const { data, error } = await supabaseAdmin
    .from('customers').select('id, archived_at, anonymized_at').eq('id', id).maybeSingle();
  if (error) throw new Error('customer fetch: ' + error.message);
  return data;
}

function checkLocked(c) {
  if (c.anonymized_at) return { error: 'Klant is geanonimiseerd; tag-mutaties niet beschikbaar.' };
  if (c.archived_at)   return { error: 'Klant is gearchiveerd; eerst heractiveren.' };
  return null;
}

async function fetchTagDefinition(slug) {
  const { data, error } = await supabaseAdmin
    .from('customer_tag_definitions').select('slug, label, color').eq('slug', slug).maybeSingle();
  if (error) throw new Error('tag-def fetch: ' + error.message);
  return data;
}

async function fetchTagsForCustomer(customerId) {
  const { data, error } = await supabaseAdmin
    .from('customer_tags')
    .select('customer_tag_definitions(slug, label, color)')
    .eq('customer_id', customerId);
  if (error) throw new Error('tags fetch: ' + error.message);
  return (data || [])
    .map((r) => r.customer_tag_definitions)
    .filter(Boolean)
    .map((d) => ({ slug: d.slug, label: d.label, color: d.color }));
}
