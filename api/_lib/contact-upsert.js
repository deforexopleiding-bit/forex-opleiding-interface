// api/_lib/contact-upsert.js
// Mapper + upsert van één TL-contact in onze `customers`-tabel (B2C-pad).
// Gebruikt door /api/cron-finance-sync voor de continue sync TL → DB.
//
// Idempotent: 2-staps SELECT op tl_contact_id → UPDATE / INSERT, consistent met
// _lib/invoice-upsert.js. Skipt archived/anonymized customers (we mutten geen
// data op locked-state rijen, zelfde policy als customer.js PATCH-handler).
//
// LET OP: insert-pad zet `is_company=false` + privacy_accepted_at op now() omdat
// een TL-contact dat we nog niet kennen automatisch wordt aangemaakt als nieuwe
// klant in onze DB. Bij dubieuze cases (geen email/voornaam) skippen we i.p.v.
// een halve rij te creëren — dat voorkomt verweesde customers zonder identiteit.

import { supabaseAdmin } from '../supabase.js';
import { tlFetch } from './teamleader-token.js';

function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function isoDate(v) { if (!v) return null; const s = String(v); return s.length >= 10 ? s.slice(0, 10) : null; }

// Pak "primary" email of eerste, geef e-mail-string terug (null als niets).
function primaryEmail(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const prim = emails.find(e => e?.type === 'primary');
  return trimOrNull((prim || emails[0])?.email);
}
// Idem voor telefoons.
function primaryPhone(telephones) {
  if (!Array.isArray(telephones) || telephones.length === 0) return null;
  const prim = telephones.find(t => t?.type === 'phone') || telephones[0];
  return trimOrNull(prim?.number);
}
// Kies "invoicing"-adres of fallback "primary"/eerste; returnt het address-subobject.
function pickAddress(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) return null;
  const inv = addresses.find(a => a?.type === 'invoicing');
  const prim = addresses.find(a => a?.type === 'primary');
  return (inv || prim || addresses[0])?.address || null;
}
// "Hoofdstraat 12B" → { street: "Hoofdstraat", number: "12B" }. Heuristisch:
// pak laatste token dat begint met een cijfer als huisnummer (+toevoeging).
function splitStreetNumber(line1) {
  if (!line1) return { street: null, number: null };
  const s = String(line1).trim();
  const m = s.match(/^(.+?)\s+(\d+\S*)$/);
  if (m) return { street: m[1].trim() || null, number: m[2].trim() || null };
  return { street: s || null, number: null };
}

/**
 * Haal contacts.info op + upsert in `customers`. Returnt het lokale customer-uuid + actie.
 *
 * @param {string} tlContactId
 * @returns {Promise<{ id: string|null, action: 'inserted'|'updated'|'skipped', reason?: string }>}
 */
export async function upsertContactFromTl(tlContactId) {
  if (!tlContactId) throw new Error('tl_contact_id vereist');

  const r = await tlFetch('/contacts.info', { method: 'POST', body: JSON.stringify({ id: tlContactId }) });
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new Error(`contacts.info HTTP ${r.status}: ${text.slice(0, 200)}`);
  let c = null; try { c = JSON.parse(text).data; } catch {}
  if (!c) throw new Error('contacts.info gaf geen data');

  const first_name = trimOrNull(c.first_name);
  const last_name  = trimOrNull(c.last_name);
  const email      = primaryEmail(c.emails);
  const phone      = primaryPhone(c.telephones);
  const addr       = pickAddress(c.addresses);
  const { street, number } = splitStreetNumber(addr?.line_1);

  // Sanity: zonder voor- of achternaam én zonder email kunnen we niets zinvols opslaan.
  if (!first_name && !last_name && !email) {
    return { id: null, action: 'skipped', reason: 'geen identiteit (first_name+last_name+email leeg)' };
  }

  // Match op bestaande customer via tl_contact_id.
  const { data: existing } = await supabaseAdmin
    .from('customers').select('id, archived_at, anonymized_at')
    .eq('tl_contact_id', tlContactId).maybeSingle();

  if (existing) {
    if (existing.archived_at)   return { id: existing.id, action: 'skipped', reason: 'archived' };
    if (existing.anonymized_at) return { id: existing.id, action: 'skipped', reason: 'anonymized' };

    const row = {
      first_name, last_name, email, phone,
      date_of_birth:  isoDate(c.birthdate),
      address_street: street,
      address_number: number,
      address_postal: trimOrNull(addr?.postal_code),
      address_city:   trimOrNull(addr?.city),
      // updated_at expliciet — trigger trg_customers_updated zou 'm ook zetten,
      // maar bij sync-from-TL is "wij volgen TL" semantisch duidelijker.
      updated_at:     new Date().toISOString(),
    };
    const { error } = await supabaseAdmin.from('customers').update(row).eq('id', existing.id);
    if (error) throw new Error('customers update: ' + error.message);
    return { id: existing.id, action: 'updated' };
  }

  // Geen match → INSERT als nieuwe B2C-customer. Privacy-stamp expliciet (TL-import
  // is een impliciete privacy-acceptatie analoog aan Combidesk-import).
  const insertRow = {
    is_company:     false,
    first_name, last_name, email, phone,
    date_of_birth:  isoDate(c.birthdate),
    address_street: street,
    address_number: number,
    address_postal: trimOrNull(addr?.postal_code),
    address_city:   trimOrNull(addr?.city),
    tl_contact_id:  tlContactId,
    privacy_accepted_at: new Date().toISOString(),
  };
  const { data: ins, error } = await supabaseAdmin
    .from('customers').insert(insertRow).select('id').single();
  if (error) throw new Error('customers insert: ' + error.message);
  return { id: ins.id, action: 'inserted' };
}
