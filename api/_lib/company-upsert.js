// api/_lib/company-upsert.js
// Mapper + upsert van één TL-company in onze `customers`-tabel (B2B-pad,
// is_company=true). Tegenhanger van _lib/contact-upsert.js.
//
// Mapping default (fase 4):
//   customers.kvk_number ← TL companies.national_identification_number
//   customers.vat_number ← TL companies.vat_number
//   customers.company_name ← TL name
//   adressen/email/phone idem als contact-upsert
//
// Idempotent (2-staps op tl_company_id). Skipt archived/anonymized.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function primaryEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const prim = emails.find(e => e?.type === 'primary');
  return trimOrNull((prim || emails[0])?.email);
}
function primaryPhone(telephones) {
  if (!Array.isArray(telephones) || telephones.length === 0) return null;
  const prim = telephones.find(t => t?.type === 'phone') || telephones[0];
  return trimOrNull(prim?.number);
}
function pickAddress(addresses, primaryAddress) {
  if (Array.isArray(addresses) && addresses.length) {
    const inv = addresses.find(a => a?.type === 'invoicing');
    const prim = addresses.find(a => a?.type === 'primary');
    return (inv || prim || addresses[0])?.address || null;
  }
  // companies.info heeft soms een `primary_address` top-level i.p.v. addresses[].
  return primaryAddress || null;
}
function splitStreetNumber(line1) {
  if (!line1) return { street: null, number: null };
  const s = String(line1).trim();
  const m = s.match(/^(.+?)\s+(\d+\S*)$/);
  if (m) return { street: m[1].trim() || null, number: m[2].trim() || null };
  return { street: s || null, number: null };
}

/**
 * Haal companies.info op + upsert in `customers` als B2B-rij.
 *
 * @param {string} tlCompanyId
 * @returns {Promise<{ id: string|null, action: 'inserted'|'updated'|'skipped', reason?: string }>}
 */
export async function upsertCompanyFromTl(tlCompanyId) {
  if (!tlCompanyId) throw new Error('tl_company_id vereist');

  const r = await tlFetch('/companies.info', { method: 'POST', body: JSON.stringify({ id: tlCompanyId }) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`companies.info HTTP ${r.status}: ${text.slice(0, 200)}`);
  let c = null; try { c = JSON.parse(text).data; } catch {}
  if (!c) throw new Error('companies.info gaf geen data');

  const company_name = trimOrNull(c.name);
  if (!company_name) {
    return { id: null, action: 'skipped', reason: 'geen company name' };
  }
  const email = primaryEmail(c.emails);
  const phone = primaryPhone(c.telephones);
  const addr  = pickAddress(c.addresses, c.primary_address);
  const { street, number } = splitStreetNumber(addr?.line_1);
  const vat_number = trimOrNull(c.vat_number);
  // kvk komt op companies binnen als national_identification_number (NL).
  const kvk_number = trimOrNull(c.national_identification_number);

  const { data: existing } = await supabaseAdmin
    .from('customers').select('id, archived_at, anonymized_at')
    .eq('tl_company_id', tlCompanyId).maybeSingle();

  if (existing) {
    if (existing.archived_at)   return { id: existing.id, action: 'skipped', reason: 'archived' };
    if (existing.anonymized_at) return { id: existing.id, action: 'skipped', reason: 'anonymized' };
    const row = {
      company_name, email, phone,
      vat_number, kvk_number,
      address_street: street,
      address_number: number,
      address_postal: trimOrNull(addr?.postal_code),
      address_city:   trimOrNull(addr?.city),
      updated_at:     new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from('customers').update(row).eq('id', existing.id);
    if (error) throw new Error('customers update: ' + error.message);
    return { id: existing.id, action: 'updated' };
  }

  const insertRow = {
    is_company:     true,
    company_name,
    email, phone,
    vat_number, kvk_number,
    address_street: street,
    address_number: number,
    address_postal: trimOrNull(addr?.postal_code),
    address_city:   trimOrNull(addr?.city),
    tl_company_id:  tlCompanyId,
    privacy_accepted_at: new Date().toISOString(),
  };
  const { data: ins, error } = await supabaseAdmin
    .from('customers').insert(insertRow).select('id').single();
  if (error) throw new Error('customers insert: ' + error.message);
  return { id: ins.id, action: 'inserted' };
}
