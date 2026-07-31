// api/finance-active-profiles-list.js
//
// GET → lijst van actieve profielen voor de assignee-picker in de Gesprekken-tab
// popup "→ Actie maken" (Blok 3). Gebruikt door de finance-inbox UI om een
// dropdown "Toewijzen aan teamlid" te vullen die naar /api/taken doorpost.
//
// Response:
//   { items: [ { id, full_name, role }, ... ] }  — gesorteerd op full_name.
//
// Alleen actieve profielen (is_active=true). Rollen die geen taken-module
// zien (bv. viewer) worden niet uitgefilterd — dat is aan de aanroeper. Het
// takenbeheer-endpoint /api/taken checkt zelf of assigned_to_id ergens toe
// kan (en anders faalt de insert alsnog).
//
// Permission: finance.dunning.view (elke finance-gebruiker mag deze lijst
// zien — het is puur een UI-hulpdropdown, geen mutatie).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { filterActiveProfilesForPicker } from './_lib/gesprek-actie-helpers.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, role')
      .eq('is_active', true)
      .order('full_name', { ascending: true });
    if (error) throw new Error('profiles: ' + error.message);

    const items = filterActiveProfilesForPicker(data);
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[finance-active-profiles-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
