// api/_lib/teamleader-contact.js
// Gedeelde TL-contact logica. Hergebruikt door teamleader-push-deal.js
// (Wizard 2 / subscriptions) en teamleader-quotation.js (Wizard 1 / offerte).

import { tlFetch } from './teamleader-token.js';
import { supabaseAdmin } from '../supabase.js';

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

// Maakt een TL-deal (opportunity) aan voor een contact. Returnt tl_deal_id.
// Quotations vereisen een deal_id, dus zowel offerte- als subscription-flow
// hangen onder een TL-deal.
export async function createDeal(deal, tlContactId) {
  const dealBody = {
    lead: { customer: { type: 'contact', id: tlContactId } },
    title: `Deal ${String(deal.id).slice(0, 8)}`,
    estimated_value: deal.total_amount ? { amount: Number(deal.total_amount), currency: 'EUR' } : undefined,
  };
  const dr = await tlFetch('/deals.create', { method: 'POST', body: JSON.stringify(dealBody) });
  if (!dr.ok) {
    const txt = await dr.text();
    throw new Error(`TL deals.create HTTP ${dr.status}: ${txt.slice(0, 200)}`);
  }
  const dData = await dr.json();
  return dData.data?.id;
}
