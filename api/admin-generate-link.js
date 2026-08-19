// api/admin-generate-link.js
//
// Diagnose-endpoint: genereert een recovery-link voor een bestaande
// user via Supabase Admin API ZONDER mail te versturen. Bedoeld voor
// troubleshooting van de welkomst-mail / recovery-flow.
//
// POST /api/admin-generate-link
// Body: { email: string }
// Response: { action_link: string }
//
// Auth: vereist admin-rol (super_admin / admin / manager) via Bearer.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { authRedirectUrlForRole } from './_lib/crm-roles.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const auth = await verifyAdmin(req);
  if (!auth) {
    return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  }

  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is verplicht.' });
  }

  try {
    // De redirect volgt de rol van de doelgebruiker: CRM-staff landt op de
    // CRM-reset-pagina, een viewer/student op het LMS. Profiel onvindbaar →
    // rol null → LMS (whitelist, dus de veilige kant).
    const { data: targetProfile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('email', email)
      .maybeSingle();

    const redirectTo = authRedirectUrlForRole(targetProfile?.role || null);

    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type:    'recovery',
      email,
      options: { redirectTo },
    });

    if (error) {
      return res.status(500).json({ error: `generateLink fout: ${error.message}` });
    }

    const actionLink = data?.properties?.action_link;
    if (!actionLink) {
      return res.status(500).json({ error: 'generateLink retourneerde geen action_link.' });
    }

    return res.status(200).json({ action_link: actionLink });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
