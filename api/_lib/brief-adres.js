// api/_lib/brief-adres.js
//
// Eén bron voor het adresblok van een brief (WIK-/tussenbrief), gedeeld door:
//   - de brief-generator (api/_lib/incasso-pre-brief-core.js → renderBriefPdf)
//   - de adreslabels (api/dunning-briefs-labels.js)
// zodat de labels nooit van de brief kunnen afwijken.
//
// briefGeadresseerde(customer)        → naam zoals op de brief (bedrijfsnaam of
//                                        voornaam + achternaam)
// briefAdresRegels(customer, land)    → regels exact zoals de brief ze tekent
//                                        (vóór sanitizeForPdf, die doet de renderer)
// labelAdresRegels(customer, land)    → dezelfde regels, gesaneerd, met de
//                                        landregel in HOOFDLETTERS (post-gebruik)

import { customerDisplayName } from './customer-name.js';
import { buildAddressBlockLines } from './wik-brief-layout.js';
import { sanitizeForPdf } from './incasso-pdf.js';

export function briefGeadresseerde(customer) {
  const c = customer || {};
  return c.is_company
    ? (c.company_name || customerDisplayName(c, ''))
    : customerDisplayName(c, '');
}

// land = het land waarmee de brief gemaakt is (dunning_briefs.country, 'NL'|'BE');
// leeg → dezelfde afleiding als de generator (bepaalLand).
export function briefAdresRegels(customer, land = null) {
  return buildAddressBlockLines(customer, briefGeadresseerde(customer), land);
}

export function labelAdresRegels(customer, land = null) {
  const regels = briefAdresRegels(customer, land).map((r) => sanitizeForPdf(r));
  // De landregel is altijd de laatste (buildAddressBlockLines zet 'm altijd).
  if (regels.length) regels[regels.length - 1] = regels[regels.length - 1].toUpperCase();
  return regels.filter((r) => r !== '');
}
