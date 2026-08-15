// api/sanne-config-get.js
// GET -> haal Sanne-config op (= joost_config module='email' rij).
// Dedicated endpoint zodat we joost-config-get.js niet hoeven aan te raken
// (protected zone). Retourneert de volledige config + feature_flags +
// autonomy_config voor de UI.
//
// Permission: admin.joost_config (spiegelt joost-config-get RBAC).
//
// Response 200: { config: {...} }  OR  404 als de migratie nog niet is
// gedraaid (rij ontbreekt).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  try {
    const { data, error } = await supabaseAdmin.from('joost_config')
      .select('*').eq('module', 'email').maybeSingle();
    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: 'Sanne-config ontbreekt — draai migratie 2026-08-15-sanne-fase-2-0-foundation.sql' });
    return res.status(200).json({ config: data });
  } catch (e) {
    console.error('[sanne-config-get]', e?.message);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
