// api/admin-template-variables-list.js
// GET → beschikbare merge-variabelen voor de WhatsApp-template-bouwer.
// Retourneert AVAILABLE_VARIABLES uit api/_lib/template-variables.js zodat
// de editor-UI de exact-gelijke keys aanbiedt die de send-time resolver
// snapt. Read-only.
//
// SUPER_ADMIN ONLY (editor is super_admin-scope).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { AVAILABLE_VARIABLES } from './_lib/template-variables.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile } = await supabaseAdmin
      .from('profiles').select('id, role, is_active').eq('id', user.id).single();
    if (!profile || !profile.is_active) return res.status(403).json({ error: 'Geen profiel' });
    if (profile.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin' });

    // Trim naar UI-shape (geen requires_context / requires_module_context — UI
    // gebruikt alleen key/label/example/category voor picker-render).
    const variables = AVAILABLE_VARIABLES.map((v) => ({
      key:      v.key,
      label:    v.label,
      example:  v.example,
      category: v.category,
    }));

    // Sort per category → key voor stabiele UI.
    variables.sort((a, b) => (a.category + a.key).localeCompare(b.category + b.key));

    return res.status(200).json({ variables });
  } catch (e) {
    console.error('[admin-template-variables-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
