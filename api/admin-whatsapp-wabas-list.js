// api/admin-whatsapp-wabas-list.js
// GET → lijst alle actieve whatsapp_module_config rijen die een business_account_id hebben.
// SUPER_ADMIN ONLY. Read-only — geen audit-log.
//
// Levert distinct (business_account_id, module, display_label) tuples voor de
// Templates-UI om een WABA te kiezen (multi-WABA-ready, single-WABA in C1).
//
// Response: { items: [{ business_account_id, module, display_label }] }

import { createUserClient, supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    // PostgREST kent geen DISTINCT — we filteren JS-side. Volume is klein (<10 rows).
    const { data, error } = await supabaseAdmin
      .from('whatsapp_module_config')
      .select('business_account_id, module, display_label')
      .not('business_account_id', 'is', null)
      .eq('is_active', true)
      .order('display_label', { ascending: true });

    if (error) {
      console.error('[admin-whatsapp-wabas-list] select:', error.message);
      return res.status(500).json({ error: error.message });
    }

    // Dedup op (business_account_id, module, display_label) — eerste rij wint.
    const seen = new Set();
    const items = [];
    for (const row of data || []) {
      const key = `${row.business_account_id}|${row.module}|${row.display_label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        business_account_id: row.business_account_id,
        module:              row.module,
        display_label:       row.display_label,
      });
    }

    return res.status(200).json({ items });
  } catch (e) {
    console.error('[admin-whatsapp-wabas-list] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
