// api/_lib/teamleader-contact.js
// Gedeelde TL-contact logica. Hergebruikt door teamleader-push-deal.js
// (Wizard 2 / subscriptions) en teamleader-quotation.js (Wizard 1 / offerte).

import { tlFetch } from './teamleader-token.js';
import { supabaseAdmin } from '../supabase.js';
import { normalizeVat } from './vat-normalize.js';
import { linkContactToCompany } from './teamleader-contact-company-link.js';

// Resolve TL address country vanuit customer.address_country. Whitelist
// NL/BE (matcht customers_address_country_check + de UI-keuze in de
// sales-wizard). Fallback 'NL' voor legacy customers waar de kolom
// nog NULL is — bewaart backward-compat gedrag.
function resolveTlCountry(customer) {
  return customer?.address_country === 'BE' ? 'BE' : 'NL';
}

// Geeft bestaande customer.tl_contact_id terug, of maakt een TL-contact aan
// via /contacts.add en bewaart het id op de customer-rij.
// Throwt bij een TL-fout (caller vangt dit af en zet de juiste status).
export async function getOrCreateContact(customer) {
  if (!customer) throw new Error('Customer ontbreekt voor TL-contact');
  if (customer.tl_contact_id) return customer.tl_contact_id;

  const contactBody = {
    first_name: customer.first_name || '',
    last_name:  customer.last_name || '',
    emails:     customer.email ? [{ type: 'primary', email: customer.email }] : [],
    telephones: customer.phone ? [{ type: 'phone', number: customer.phone }] : [],
  };
  // Geboortedatum (TL: top-level 'birthdate', formaat YYYY-MM-DD).
  if (customer.date_of_birth) contactBody.birthdate = String(customer.date_of_birth).slice(0, 10);
  // Adres meesturen indien aanwezig (TL contacts.add addresses[]).
  const line1 = [customer.address_street, customer.address_number].filter(Boolean).join(' ').trim();
  if (line1 || customer.address_postal || customer.address_city) {
    contactBody.addresses = [{
      type: 'primary',
      address: {
        line_1:      line1 || null,
        postal_code: customer.address_postal || null,
        city:        customer.address_city || null,
        country:     resolveTlCountry(customer),
      },
    }];
  }
  const cr = await tlFetch('/contacts.add', { method: 'POST', body: JSON.stringify(contactBody) });
  if (!cr.ok) {
    const txt = await cr.text();
    throw new Error(`TL contacts.add HTTP ${cr.status}: ${txt.slice(0, 200)}`);
  }
  const cData = await cr.json();
  const tlContactId = (cData.data?.id || cData.data?.type === 'contact') ? cData.data?.id : null;
  if (tlContactId) {
    await supabaseAdmin.from('customers').update({ tl_contact_id: tlContactId }).eq('id', customer.id);
    // Cache lokaal zodat verdere calls binnen dezelfde flow (bv. linkContactToCompany)
    // 'em direct kunnen gebruiken zonder DB-refetch.
    customer.tl_contact_id = tlContactId;
  }
  return tlContactId;
}

// Normaliseer een TL customer-referentie: string (legacy contact-id) of {type,id}.
export function toCustomerRef(x) {
  if (!x) return null;
  if (typeof x === 'string') return { type: 'contact', id: x };
  return { type: x.type || 'contact', id: x.id };
}

// Normaliseer + valideer customer.vat_number vóór het naar TL gaat. Bij een
// legitieme wijziging (spaties/punten/kleine letters/afgeleide landcode)
// schrijft de helper de genormaliseerde waarde óók terug naar
// customers.vat_number (fail-soft) zodat de DB overal consistent staat.
//
// Throwt bij ongeldig formaat met .code=VAT_* zodat caller een 422 met
// leesbare Nederlandse melding kan geven i.p.v. een cryptische TL 400.
//
// @param {object} customer  min. { id, vat_number }
// @returns {Promise<string|null>}  Genormaliseerd BTW-nummer of null bij ontbreken.
async function normalizeCustomerVat(customer) {
  if (!customer.vat_number) return null;
  const vatRes = normalizeVat(customer.vat_number);
  if (!vatRes.ok) {
    const err = new Error(vatRes.error);
    err.code = vatRes.code;
    err.raw_vat = customer.vat_number;
    throw err;
  }
  if (vatRes.changed) {
    try {
      await supabaseAdmin.from('customers').update({ vat_number: vatRes.normalized }).eq('id', customer.id);
      customer.vat_number = vatRes.normalized;
    } catch (e) {
      console.warn('[tl-contact] vat-normalize write-back fail-soft:', customer.id, e?.message || e);
    }
  }
  return vatRes.normalized;
}

// Update de vat_number van een bestaande TL-company als 't in onze DB verschilt
// (of altijd wanneer refresh=true). Fail-soft: bij een TL-fout logt de helper en
// gaat verder — de push mag hier niet op stukvallen.
//
// De vat-waarde is al genormaliseerd op customer.vat_number bij de caller;
// deze helper gebruikt die genormaliseerde waarde voor de compare + update.
async function ensureCompanyVatInSync(customer, tlCompanyId, { refresh = false } = {}) {
  const desired = String(customer.vat_number || '').trim();
  if (!desired) return { updated: false, reason: 'no_vat_in_db' };
  try {
    if (!refresh) {
      // Best-effort GET om te vergelijken; als de call faalt, doen we alsnog een update
      // (defensief — we willen dat vat_number altijd op de factuur staat).
      const gr = await tlFetch('/companies.info', { method: 'POST', body: JSON.stringify({ id: tlCompanyId }) });
      if (gr.ok) {
        const gd = await gr.json();
        const remote = String(gd?.data?.vat_number || '').trim();
        if (remote === desired) return { updated: false, reason: 'already_in_sync' };
      }
    }
    const ur = await tlFetch('/companies.update', {
      method: 'POST',
      body: JSON.stringify({ id: tlCompanyId, vat_number: desired }),
    });
    if (!ur.ok) {
      const txt = await ur.text();
      console.warn('[tl-contact] companies.update vat_number failed:', tlCompanyId, ur.status, txt.slice(0, 200));
      return { updated: false, error: `HTTP ${ur.status}` };
    }
    return { updated: true };
  } catch (e) {
    console.warn('[tl-contact] ensureCompanyVatInSync exception:', e?.message || e);
    return { updated: false, error: e?.message || 'onbekend' };
  }
}

/**
 * B2B-flow: garandeert dat er ÉÉN company + ÉÉN contact voor de klant bestaan
 * in TL, en dat ze gelinkt zijn via /contacts.linkToCompany. Wordt aangeroepen
 * vanuit getOrCreateTlCustomer bij is_company=true.
 *
 * Blokkeert wanneer er geen persoonsnaam bekend is — een TL-company zonder
 * primary contact rendert vaak leeg op de PDF; met een gelinkte contact
 * verschijnt zowel bedrijfsnaam als contactpersoon.
 *
 * Throwt Error met:
 *   .code='TL_B2B_CONTACT_NAME_REQUIRED'  — first_name én last_name beide leeg
 *   .code='VAT_EMPTY'|'VAT_INVALID_FORMAT'|'VAT_COUNTRY_UNDETECTABLE'
 *                                          — btw-nummer ongeldig na normalisatie
 * Caller vertaalt naar 422 met leesbare melding.
 *
 * Idempotent — safe bij herhaalde aanroepen:
 *   - company: bij bestaande tl_company_id → hergebruik + vat-refresh
 *   - contact: bij bestaande tl_contact_id → hergebruik
 *   - link:    linkContactToCompany geeft `already_linked=true` bij dubbelop
 *
 * Fail-soft op de link zelf: als het contact niet gelinkt kan worden (TL-storing),
 * loggen we een warning en gaan verder. Zonder link belandt bill-to op de company
 * zoals bedoeld; met link toont TL ook de contactpersoon.
 *
 * @param {object} customer  customers-row (min: id, is_company, company_name,
 *                           first_name, last_name, email, phone, address_*, vat_number,
 *                           tl_company_id, tl_contact_id)
 * @returns {Promise<{ok:true, tl_company_id:string, tl_contact_id:string|null,
 *                    linked:boolean, link_error?:string, vat_sync?:object}>}
 */
export async function ensureCompanyWithContact(customer) {
  if (!customer) throw new Error('Customer ontbreekt voor TL-B2B-koppeling');

  // Persoonsnaam-guard: minstens een first_name OF last_name vereist.
  // Zonder naam kan TL geen zinnige contact aanmaken en blijft de PDF leeg.
  const firstName = String(customer.first_name || '').trim();
  const lastName  = String(customer.last_name  || '').trim();
  if (!firstName && !lastName) {
    const err = new Error(
      'Bedrijfsklant heeft geen contactpersoon: vul first_name of last_name aan ' +
      'zodat TL het contact aan het bedrijf kan koppelen. Zonder contactpersoon staat ' +
      'de offerte/factuur wel op het bedrijf, maar mist de PDF de persoonsnaam.',
    );
    err.code = 'TL_B2B_CONTACT_NAME_REQUIRED';
    err.customer_id = customer.id;
    throw err;
  }

  // BTW-normalisatie vóór ELKE TL-call in deze flow. Throwt bij ongeldig
  // formaat met VAT_*-code zodat caller een 422 kan geven met leesbare
  // Nederlandse melding i.p.v. een cryptische TL 400. Genormaliseerde
  // waarde wordt ook teruggeschreven naar customers.vat_number (fail-soft).
  const normalizedVat = await normalizeCustomerVat(customer);

  // 1. Company: hergebruik of maak aan.
  let tlCompanyId = customer.tl_company_id || null;
  let vatSync = { updated: false, reason: 'no_action' };
  if (!tlCompanyId) {
    const body = { name: (customer.company_name || '').trim() || 'Onbekend bedrijf' };
    if (normalizedVat) body.vat_number = normalizedVat;
    if (customer.email) body.emails = [{ type: 'primary', email: customer.email }];
    if (customer.phone) body.telephones = [{ type: 'phone', number: customer.phone }];
    const line1 = [customer.address_street, customer.address_number].filter(Boolean).join(' ').trim();
    if (line1 || customer.address_postal || customer.address_city) {
      body.addresses = [{
        type: 'primary',
        address: { line_1: line1 || null, postal_code: customer.address_postal || null, city: customer.address_city || null, country: resolveTlCountry(customer) },
      }];
    }
    const cr = await tlFetch('/companies.add', { method: 'POST', body: JSON.stringify(body) });
    if (!cr.ok) {
      const txt = await cr.text();
      throw new Error(`TL companies.add HTTP ${cr.status}: ${txt.slice(0, 200)}`);
    }
    const cData = await cr.json();
    tlCompanyId = cData.data?.id || null;
    if (tlCompanyId) {
      await supabaseAdmin.from('customers').update({ tl_company_id: tlCompanyId }).eq('id', customer.id);
      customer.tl_company_id = tlCompanyId;
    }
  } else {
    // Bestaande company: verifieer/update vat_number zodat 't op de factuur staat.
    // Compare gebruikt genormaliseerde customer.vat_number (door normalizeCustomerVat
    // hierboven al bijgewerkt).
    vatSync = await ensureCompanyVatInSync(customer, tlCompanyId, { refresh: false });
  }
  if (!tlCompanyId) throw new Error('TL company aanmaken/vinden mislukt (geen id)');

  // 2. Contact: hergebruik of maak aan. Delegeert naar getOrCreateContact
  // (die persisteert tl_contact_id + cached 'em op customer).
  const tlContactId = await getOrCreateContact(customer);

  // 3. Link contact → company. Idempotent (already_linked=true bij dubbelop).
  // Fail-soft: bij een link-fout gaat de flow door — deal/quotation belandt
  // sowieso op de company. Zonder link mist alleen de gepersonaliseerde
  // contactpersoon op de PDF.
  let linked = false;
  let linkError;
  if (tlContactId && tlCompanyId) {
    const linkRes = await linkContactToCompany(tlContactId, tlCompanyId);
    linked = !!linkRes.ok;
    if (!linked) {
      linkError = linkRes.error || `link_failed_status_${linkRes.status || '?'}`;
      console.warn('[tl-contact] linkContactToCompany fail-soft:', linkError);
    }
  }

  return { ok: true, tl_company_id: tlCompanyId, tl_contact_id: tlContactId, linked, link_error: linkError, vat_sync: vatSync };
}

// Geeft een TL customer-referentie { type, id } terug: B2C → contact, B2B → company.
//
// Voor B2B (is_company=true) roept 'ie ensureCompanyWithContact aan die:
//   - btw-nummer normaliseert vóór ELKE TL-call (throwt VAT_* bij ongeldig),
//   - de company aanmaakt/hergebruikt (met genormaliseerd vat_number),
//   - een contact aanmaakt/hergebruikt voor de persoon,
//   - contact ↔ company linkt via /contacts.linkToCompany.
//
// Bij ontbrekende persoonsnaam bij B2B: throwt TL_B2B_CONTACT_NAME_REQUIRED zodat
// caller een 422 kan teruggeven. Zonder deze guard belandde de offerte weliswaar
// op de company, maar rendert de PDF zonder contactpersoon.
export async function getOrCreateTlCustomer(customer) {
  if (!customer) throw new Error('Customer ontbreekt voor TL-koppeling');
  if (!customer.is_company) {
    const id = await getOrCreateContact(customer);
    return { type: 'contact', id };
  }
  const ensured = await ensureCompanyWithContact(customer);
  return { type: 'company', id: ensured.tl_company_id };
}

// Maakt een TL-deal (opportunity) aan voor een contact OF company. Returnt tl_deal_id.
// Quotations vereisen een deal_id, dus zowel offerte- als subscription-flow
// hangen onder een TL-deal. customerRef = string (legacy contact-id) of {type,id}.
export async function createDeal(deal, customerRef, departmentId, title) {
  const ref = toCustomerRef(customerRef);
  const dealBody = {
    lead: { customer: ref },
    title: title || `Offerte ${String(deal.id).slice(0, 8)}`,
    estimated_value: deal.total_amount ? { amount: Number(deal.total_amount), currency: 'EUR' } : undefined,
  };
  if (departmentId) dealBody.department_id = departmentId;
  const dr = await tlFetch('/deals.create', { method: 'POST', body: JSON.stringify(dealBody) });
  if (!dr.ok) {
    const txt = await dr.text();
    throw new Error(`TL deals.create HTTP ${dr.status}: ${txt.slice(0, 200)}`);
  }
  const dData = await dr.json();
  return dData.data?.id;
}
