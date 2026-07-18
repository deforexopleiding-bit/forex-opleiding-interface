// api/_lib/teamleader-contact-company-link.js
//
// TL-sync helpers voor de contact ↔ company link (fase 2 van #820).
//
// Endpoints (TL API v2):
//   POST /contacts.linkToCompany     { id, company_id [, position, decision_maker] }
//   POST /contacts.unlinkFromCompany { id, company_id }
//
// Best-effort: throwt bij TL-fout met genoeg metadata voor de caller om een
// `tl_sync:{ok:false, error, endpoint}` te bouwen — de lokale link blijft
// staan zodat een TL-storing de werkende feature niet blokkeert.
//
// Idempotentie: TL geeft geen exacte "already linked"-code terug in v2 docs.
// We vangen typische signalen (400 + "already", "duplicate", "exists" in de
// error-body) op als `already_linked`/`already_unlinked` — dan is de sync
// vanuit ons perspectief succesvol.

import { tlFetch } from './teamleader-token.js';

const LINK_ENDPOINT   = '/contacts.linkToCompany';
const UNLINK_ENDPOINT = '/contacts.unlinkFromCompany';

/**
 * Herken idempotent-scenario in een TL-error-body. TL retourneert HTTP 400
 * bij dubbel-link, met een message die vaak varianten van "already linked"
 * bevat. Geen documented code — we tekstmatchen defensief zodat een dubbel-
 * link geen harde fout wordt.
 *
 * @param {number} status  HTTP-status van TL
 * @param {string} body    responsebody (kan JSON of tekst zijn)
 * @returns {boolean}
 */
export function isAlreadyLinkedError(status, body) {
  if (status !== 400) return false;
  const s = String(body || '').toLowerCase();
  return /already\s*(linked|exists|associated)/.test(s)
      || /duplicate/.test(s)
      || /link\s*(already|exists)/.test(s);
}

/**
 * Herken idempotent-scenario voor unlink: TL geeft 404 als de link al weg is,
 * of 400 met "not linked" / "no association" / etc.
 */
export function isAlreadyUnlinkedError(status, body) {
  if (status !== 400 && status !== 404) return false;
  const s = String(body || '').toLowerCase();
  return /not\s*(linked|associated)/.test(s)
      || /no\s*(link|association)/.test(s)
      || /does\s*not\s*exist/.test(s)
      || status === 404;
}

/**
 * Link een TL-contact aan een TL-company. Retourneert altijd een structured
 * result — throwt niet voor 4xx/5xx zodat de caller kan kiezen (best-effort).
 *
 * @param {string} tlContactId
 * @param {string} tlCompanyId
 * @returns {Promise<{ok:boolean, endpoint:string, already_linked?:boolean,
 *   status?:number, error?:string}>}
 */
export async function linkContactToCompany(tlContactId, tlCompanyId) {
  if (!tlContactId || !tlCompanyId) {
    return { ok: false, endpoint: LINK_ENDPOINT, error: 'tl_contact_id of tl_company_id ontbreekt' };
  }
  let r, txt = '';
  try {
    r = await tlFetch(LINK_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ id: tlContactId, company_id: tlCompanyId }),
    });
    txt = await r.text().catch(() => '');
  } catch (netErr) {
    return { ok: false, endpoint: LINK_ENDPOINT, error: 'Netwerkfout: ' + (netErr?.message || 'onbekend') };
  }
  if (r.ok) return { ok: true, endpoint: LINK_ENDPOINT };
  if (isAlreadyLinkedError(r.status, txt)) {
    return { ok: true, endpoint: LINK_ENDPOINT, already_linked: true };
  }
  return {
    ok: false,
    endpoint: LINK_ENDPOINT,
    status: r.status,
    error: `HTTP ${r.status}: ${String(txt).slice(0, 300)}`,
  };
}

/**
 * Unlink een TL-contact van een TL-company.
 *
 * @param {string} tlContactId
 * @param {string} tlCompanyId
 * @returns {Promise<{ok:boolean, endpoint:string, already_unlinked?:boolean,
 *   status?:number, error?:string}>}
 */
export async function unlinkContactFromCompany(tlContactId, tlCompanyId) {
  if (!tlContactId || !tlCompanyId) {
    return { ok: false, endpoint: UNLINK_ENDPOINT, error: 'tl_contact_id of tl_company_id ontbreekt' };
  }
  let r, txt = '';
  try {
    r = await tlFetch(UNLINK_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ id: tlContactId, company_id: tlCompanyId }),
    });
    txt = await r.text().catch(() => '');
  } catch (netErr) {
    return { ok: false, endpoint: UNLINK_ENDPOINT, error: 'Netwerkfout: ' + (netErr?.message || 'onbekend') };
  }
  if (r.ok) return { ok: true, endpoint: UNLINK_ENDPOINT };
  if (isAlreadyUnlinkedError(r.status, txt)) {
    return { ok: true, endpoint: UNLINK_ENDPOINT, already_unlinked: true };
  }
  return {
    ok: false,
    endpoint: UNLINK_ENDPOINT,
    status: r.status,
    error: `HTTP ${r.status}: ${String(txt).slice(0, 300)}`,
  };
}
