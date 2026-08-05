// api/_lib/customer-patch-from-wizard.js
//
// Wanneer een sales-wizard (offerte of subscription) een BESTAANDE klant
// hergebruikt (matched_customer_id), stuurt de wizard alsnog customer_data
// mee met de HUIDIGE formulierwaarden. Voorheen negeerden sales-deal-create
// en sales-subscription-create dat blok volledig — dan werd de push met de
// OUDE DB-waarde uitgevoerd (bv. oude vat_number NL2113476100B01 i.p.v. de
// zojuist ingevoerde NL864823770B01).
//
// Deze helper past de door de user gewijzigde velden toe op de bestaande
// customers-rij VÓÓR de push zodat de push met verse data draait.
//
// PRINCIPES:
//   - Non-empty-wins: alleen niet-lege/niet-null waarden overschrijven de DB.
//     Voorkomt dat een leeg wizard-veld een gevulde DB-waarde per ongeluk wist.
//     Als de user actief wil leegmaken, doet 'ie dat via het klantdossier
//     (aparte flow met impliciete bevestiging).
//   - is_company + address_country worden strikt gevalideerd (booleaans / NL|BE).
//   - Fail-loud bij DB-fout — caller weet dan dat de push niet verder mag,
//     anders wordt de push alsnog op oude data uitgevoerd.
//
// PURE-adjacent: enige zij-effect is de UPDATE op customers. Return een
// samenvatting zodat callers/tests kunnen zien welke velden veranderden.

/**
 * @param {object} supabaseAdmin  Service-role client (bypass RLS).
 * @param {string} customerId     UUID van de bestaande klant.
 * @param {object} customerData   Wizard-payload (customer_data-blok).
 * @returns {Promise<{applied:boolean, fields:string[]}>}
 * @throws  DB-error indien UPDATE faalt.
 */
export async function applyCustomerPatchFromWizard(supabaseAdmin, customerId, customerData) {
  if (!customerId || !customerData || typeof customerData !== 'object') {
    return { applied: false, fields: [] };
  }
  const patch = {};
  // Non-empty setter: skipt undefined, null, en whitespace-only strings.
  const setIf = (key, val) => {
    if (val === undefined || val === null) return;
    if (typeof val === 'string' && val.trim() === '') return;
    patch[key] = typeof val === 'string' ? val.trim() : val;
  };

  // Persoonsgegevens (relevant voor B2C + B2B contact-persoon).
  setIf('first_name',    customerData.first_name);
  setIf('last_name',     customerData.last_name);
  setIf('email',         customerData.email);
  setIf('phone',         customerData.phone);
  setIf('date_of_birth', customerData.date_of_birth);

  // Bedrijfsgegevens.
  setIf('company_name',  customerData.company_name);
  setIf('kvk_number',    customerData.kvk_number);
  setIf('vat_number',    customerData.vat_number);

  // Adres.
  setIf('address_street', customerData.address_street);
  setIf('address_number', customerData.address_number);
  setIf('address_postal', customerData.address_postal);
  setIf('address_city',   customerData.address_city);

  // address_country strikt: alleen NL/BE valid.
  if (customerData.address_country === 'BE' || customerData.address_country === 'NL') {
    patch.address_country = customerData.address_country;
  }

  // is_company strikt: alleen boolean of stringified boolean overzetten.
  // (Wizard stuurt vaak `false`/`true` als echte boolean.)
  if (customerData.is_company === true || customerData.is_company === 'true') {
    patch.is_company = true;
  } else if (customerData.is_company === false || customerData.is_company === 'false') {
    patch.is_company = false;
  }

  if (Object.keys(patch).length === 0) {
    return { applied: false, fields: [] };
  }

  const { error } = await supabaseAdmin.from('customers').update(patch).eq('id', customerId);
  if (error) throw error;
  return { applied: true, fields: Object.keys(patch) };
}
