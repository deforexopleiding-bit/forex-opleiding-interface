// api/_lib/audit-customer.js
// Audit-log helper voor klanten-module mutaties (Fase 2A.3+).
// Schrijft naar de NIEUWE audit_log-tabel uit migratie 012 (NIET agent_audit_log,
// die heeft een ander schema voor agent-acties).
//
// Schema (migratie 012):
//   id, user_id, action, entity_type, entity_id,
//   before_json, after_json, reason_text, ip_address, created_at
//
// Action-conventie (entity-namespaced): customer.created / customer.updated /
//   customer.archived / customer.unarchived / customer.anonymized (latere fase).
//
// Fail-soft: errors gaan naar console.error, gooien geen exception — een
// gefaalde audit mag de business-actie niet breken (pattern uit admin-users.js).

import { supabaseAdmin } from '../supabase.js';

/**
 * Best-effort client-IP uit Vercel proxy-headers.
 * Returns null als geen header beschikbaar (ip_address-kolom is nullable).
 */
export function getClientIp(req) {
  const xff = req.headers?.['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.headers?.['x-real-ip'] || null;
}

/**
 * Schrijf een audit-entry voor een customer-mutation.
 *
 * @param {object} opts
 * @param {object} opts.req      — Vercel request (voor IP-extractie)
 * @param {string} opts.action   — 'customer.created' / 'customer.updated' / etc.
 * @param {string} opts.customerId — UUID van de klant
 * @param {object|null} opts.before — pre-mutatie staat (null bij create)
 * @param {object|null} opts.after  — post-mutatie staat (null bij hard-delete)
 * @param {string|null} [opts.reason] — vrije tekst (bv. archive-reden)
 * @param {string} opts.userId   — uuid van de uitvoerende admin (uit verifyAdmin().user.id)
 */
export async function logCustomerAudit({ req, action, customerId, before, after, reason = null, userId }) {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert({
      user_id:     userId || null,
      action,
      entity_type: 'customer',
      entity_id:   customerId,
      before_json: before ?? null,
      after_json:  after ?? null,
      reason_text: reason,
      ip_address:  getClientIp(req),
    });
    if (error) console.error('[audit-customer]', action, 'insert failed:', error.message);
  } catch (e) {
    console.error('[audit-customer]', action, 'exception:', e && e.message);
  }
}
