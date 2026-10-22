// api/commissie-overzicht.js
//
// GET ?periode=alles|dit_jaar|12m|90d → platformbreed commissie-overzicht voor
// de cockpit (Mentoren → Commissies): KPI's, per mentor, per event, per sale,
// 12-maands projectie per mentor en risico's. Eén call; per mentor wordt
// dezelfde bron gebruikt als het mentorzicht en het payout-rapport
// (computeBonusOverview). Recht: mentor.admin.view.

import { commissieHandler } from './_lib/commissie-http.js';
import { commissieOverzicht } from './_lib/commissie-core.js';

const PERIODES = new Set(['alles', 'dit_jaar', '12m', '90d']);

export default commissieHandler({
  method: 'GET',
  permissie: 'mentor.admin.view',
  label: 'commissie-overzicht',
  run: ({ query }) => commissieOverzicht({
    periode: PERIODES.has(String(query.periode || '')) ? String(query.periode) : 'alles',
  }),
});
