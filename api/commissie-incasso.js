// api/commissie-incasso.js
//
// POST { actie: 'markeren', customer_id, deal_id?, sinds: 'YYYY-MM-DD', reden, bron? }
//    | { actie: 'opheffen', id, reden? }
// Incasso voor de mentorcommissie: vanaf `sinds` tellen betalingen van deze
// klant (of alleen deze sale) niet meer voor de mentor. Grootboek blijft
// ongemoeid; al vrijgegeven/uitbetaald blijft van de mentor. Opheffen: telt
// weer mee vanaf nu (de vrijgave haalt in). 503 zolang de migratie
// 2026-10-22-commissie-incasso-en-koppeling.sql niet gedraaid is.
// Recht: mentor.ledger.write.

import { commissieHandler } from './_lib/commissie-http.js';
import { incassoActie } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'POST',
  permissie: 'mentor.ledger.write',
  label: 'commissie-incasso',
  run: ({ body, user }) => incassoActie(body, { actorId: user.id }),
});
