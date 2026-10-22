// api/commissie-toewijzing-preview.js
//
// POST { deal_id, mentor_user_ids[], pct?, reden?, basis_incl_btw? } →
// aandeel per mentor + termijnprojectie per maand. Schrijft NIETS.
// Recht: mentor.ledger.write.

import { commissieHandler } from './_lib/commissie-http.js';
import { previewToewijzing } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'POST',
  permissie: 'mentor.ledger.write',
  label: 'commissie-toewijzing-preview',
  run: ({ body }) => previewToewijzing(body),
});
