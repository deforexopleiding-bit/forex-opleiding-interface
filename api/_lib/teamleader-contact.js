// api/_lib/teamleader-contact.js
// Gedeelde TL-contact logica. Hergebruikt door teamleader-push-deal.js
// (Wizard 2 / subscriptions) en teamleader-quotation.js (Wizard 1 / offerte).

import { tlFetch } from './teamleader-token.js';
import { supabaseAdmin } from '../supabase.js';

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
  }
  return tlContactId;
}

// Normaliseer een TL customer-referentie: string (legacy contact-id) of {type,id}.
export function toCustomerRef(x) {
  if (!x) return null;
  if (typeof x === 'string') return { type: 'contact', id: x };
  return { type: x.type || 'contact', id: x.id };
}

// Geeft een TL customer-referentie { type, id } terug: B2C → contact, B2B → company.
// Maakt de company aan via /companies.add indien nog niet gekoppeld en bewaart
// tl_company_id op de customer-rij. Voor B2C delegeert het naar getOrCreateContact.
export async function getOrCreateTlCustomer(customer) {
  if (!customer) throw new Error('Customer ontbreekt voor TL-koppeling');
  if (!customer.is_company) {
    const id = await getOrCreateContact(customer);
    return { type: 'contact', id };
  }
  if (customer.tl_company_id) return { type: 'company', id: customer.tl_company_id };

  const body = { name: (customer.company_name || '').trim() || 'Onbekend bedrijf' };
  if (customer.vat_number) body.vat_number = String(customer.vat_number).trim();
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
  const tlCompanyId = cData.data?.id || null;
  if (tlCompanyId) {
    await supabaseAdmin.from('customers').update({ tl_company_id: tlCompanyId }).eq('id', customer.id);
  }
  return { type: 'company', id: tlCompanyId };
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
