// api/commissie-incasso-overzicht.js
//
// GET → Finance › "Commissie & incasso": KPI's, Te checken (zelfde bron als
// Mentoren › Commissies › Controle + de annulatie-signalen), Incasso (de ene
// status), Abonnementen per soort. Alleen lezen.
// Recht: mentor.admin.view (zelfde als Commissies / Controle).

import { commissieHandler } from './_lib/commissie-http.js';
import { supabaseAdmin } from './supabase.js';
import { commissieIncassoOverzicht } from './_lib/commissie-incasso-overzicht.js';

export default commissieHandler({
  method: 'GET',
  permissie: 'mentor.admin.view',
  label: 'commissie-incasso-overzicht',
  run: () => commissieIncassoOverzicht(supabaseAdmin),
});
