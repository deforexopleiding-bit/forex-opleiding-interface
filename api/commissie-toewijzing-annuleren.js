// api/commissie-toewijzing-annuleren.js
//
// POST { attribution_id, bevestiging: 'ANNULEER', reden? } → toewijzing op
// 'geannuleerd' + open (niet vrijgegeven) parents op 'geannuleerd'. Al
// vrijgegeven/uitbetaald blijft staan (forward-only); was er al uitbetaald,
// dan volgt een zichtbare melding voor manager/super_admin.
// Recht: mentor.ledger.write.

import { commissieHandler } from './_lib/commissie-http.js';
import { annuleerToewijzing } from './_lib/commissie-core.js';

export default commissieHandler({
  method: 'POST',
  permissie: 'mentor.ledger.write',
  label: 'commissie-toewijzing-annuleren',
  run: ({ body, user }) => annuleerToewijzing(body, { actorId: user.id }),
});
