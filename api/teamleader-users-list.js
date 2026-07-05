// api/teamleader-users-list.js
// GET → { users: [{ id, first_name, last_name, email, function, telephones,
//                   language, has_signature }] }
//
// Diagnose-endpoint om de juiste TL-user-UUID te vinden voor
// TEAMLEADER_RESPONSIBLE_USER_ID (handtekening op offertes). Alleen leesbaar
// voor super_admin / admin — manager heeft geen toegang (fine-grained gate
// bovenop de brede ADMIN_ROLES set uit verifyAdmin).
//
// TL-token/secret worden nergens in de response of console-log opgenomen.
// Bij TL-fout → 200 met { users: [], error: '<kort>' } zodat een frontend-
// caller altijd een lege lijst kan verwerken (fail-soft).

import { tlFetch, getActiveToken, refreshIfNeeded } from './_lib/teamleader-token.js';
import { verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Auth: alleen ingelogde super_admin/admin. verifyAdmin() dekt ook
  // 'manager' — wij weren die hier expliciet (deze route is puur voor
  // config-diagnose, niet dagelijks-operationeel).
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!['super_admin', 'admin'].includes(admin.profile?.role)) {
    return res.status(403).json({ error: 'Geen rechten (super_admin/admin vereist)' });
  }

  const tok = await getActiveToken();
  if (!tok) return res.status(200).json({ users: [], error: 'no_token' });

  try {
    await refreshIfNeeded();
    // users.list heeft geen verplichte body-parameters; lege POST volstaat.
    // TL retourneert { data: [ { id, first_name, last_name, email, function,
    // telephones, language, ... } ], meta: {...} }.
    const r = await tlFetch('/users.list', { method: 'POST', body: JSON.stringify({}) });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return res.status(200).json({
        users: [],
        error: `HTTP ${r.status}`,
        body: (body || '').slice(0, 500),
      });
    }
    const data = await r.json();
    const raw  = Array.isArray(data?.data) ? data.data : [];

    // Selecteer alleen id-nuttige velden zodat de response klein blijft en
    // geen ongewenste TL-velden meegetuurd worden. has_signature is
    // defensief: users.list geeft dit niet gedocumenteerd terug — als het
    // veld ooit verschijnt (bv. onder 'preferences' of 'signature') pikken
    // we het op; anders null.
    const users = raw.map(u => ({
      id:            u?.id || null,
      first_name:    u?.first_name || null,
      last_name:     u?.last_name  || null,
      email:         u?.email      || null,
      function:      u?.function   || null,
      telephones:    Array.isArray(u?.telephones) ? u.telephones : null,
      language:      u?.language   || null,
      has_signature: (u?.signature != null || u?.preferences?.signature != null) ? true : null,
    }));

    return res.status(200).json({ users, count: users.length });
  } catch (e) {
    // Geen token of body loggen. Kortgevatte error-tekst is genoeg om
    // config/connectivity-issues van elkaar te onderscheiden.
    console.error('[tl-users-list] exception:', e.message);
    return res.status(200).json({ users: [], error: 'exception: ' + e.message });
  }
}
