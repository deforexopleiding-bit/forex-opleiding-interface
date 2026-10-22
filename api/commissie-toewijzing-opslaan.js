// api/commissie-toewijzing-opslaan.js
//
// POST { deal_id, mentor_user_ids[], pct?, reden?, basis_incl_btw?, note?,
//        toch_toevoegen?, toch_reden? }
// → mentor_sale_attributions-rij + per mentor één parent in het grootboek
//   (status pending, event_id NULL). Daarna meteen vrijgave voor wat al
//   betaald is op DEZE deal. 409 als er al een toewijzing of (zonder
//   toch_toevoegen + reden) een event-bonus op de deal staat; 503 als de
//   migratie nog niet gedraaid is. Recht: mentor.ledger.write.

import { commissieHandler } from './_lib/commissie-http.js';
import { opslaanToewijzing } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'POST',
  permissie: 'mentor.ledger.write',
  label: 'commissie-toewijzing-opslaan',
  run: ({ body, user }) => opslaanToewijzing(body, { actorId: user.id }),
});
