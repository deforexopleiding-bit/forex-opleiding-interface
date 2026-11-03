// api/commissie-controle.js
//
// GET → controlescherm mentorcommissie (Mentoren › Commissies › Controle):
// per sale event, mentoren, klantstatus, betaald, vrijgegeven, werkelijk
// uitbetaald, wat het zou moeten zijn, verschil en afwijkingen — voor alle
// events, toewijzingen en trajecten. ALLEEN LEZEN: geen correcties.
// Rekenkern: api/_lib/commissie-controle.js. Recht: mentor.admin.view.

import { commissieHandler } from './_lib/commissie-http.js';
import { commissieControle } from './_lib/commissie-controle.js';
import { supabaseAdmin } from './supabase.js';

export default commissieHandler({
  method: 'GET',
  permissie: 'mentor.admin.view',
  label: 'commissie-controle',
  run: () => commissieControle(supabaseAdmin),
});
