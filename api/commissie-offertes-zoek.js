// api/commissie-offertes-zoek.js
//
// GET ?q=<klantnaam|e-mail|offertenummer|deal-id> → getekende offertes met
// dealwaarde, abonnement, betaalde som en bestaande commissie (event-bonus of
// toewijzing), zodat dubbel toewijzen zichtbaar is vóór je kiest.
// Recht: mentor.ledger.write (zelfde recht als toewijzen).

import { commissieHandler } from './_lib/commissie-http.js';
import { zoekOffertes } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'GET',
  permissie: 'mentor.ledger.write',
  label: 'commissie-offertes-zoek',
  run: ({ query }) => zoekOffertes({ q: query.q }),
});
