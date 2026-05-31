// api/teamleader-disconnect.js
// DELETE (Bearer-auth) → verwijdert alle TL-token-rijen. Wizard valt daarna
// terug op lokaal-opslaan. Vereist permission admin.integrations.manage.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.integrations.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.integrations.manage)' });
  }

  try {
    const { error } = await supabaseAdmin.from('teamleader_oauth_tokens')
      .delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    return res.status(200).json({ success: true });
  } catch (e) {
    console.error('[tl-disconnect]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
