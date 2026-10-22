// api/commissie-factuur-koppelen.js
//
// POST { invoice_id, deal_id | null, note? }   → regelingsfactuur aan een
//      commissie-sale hangen (deal_id null = bewust bij geen sale)
//    | { invoice_id, actie: 'wissen' }          → keuze wissen (automatische
//      koppelregel geldt weer)
// Overschrijft invoices.deal_id NIET (tabel commissie_factuur_koppeling).
// Recht: mentor.ledger.write.

import { commissieHandler } from './_lib/commissie-http.js';
import { factuurKoppelen } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'POST',
  permissie: 'mentor.ledger.write',
  label: 'commissie-factuur-koppelen',
  run: ({ body, user }) => factuurKoppelen(body, { actorId: user.id }),
});
