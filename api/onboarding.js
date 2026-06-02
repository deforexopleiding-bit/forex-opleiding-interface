// api/onboarding.js
// Anoniem (token = secret), GEEN auth.
//   GET  ?token=X        → { first_name } voor de onboarding-pagina
//   POST { token }       → markeer onboarding_status='completed'

import { supabaseAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const token = req.method === 'GET' ? req.query?.token : (req.body || {}).token;
  if (!token) return res.status(400).json({ error: 'token vereist' });

  try {
    const { data: c } = await supabaseAdmin.from('customers')
      .select('id, first_name, onboarding_status').eq('onboarding_token', token).maybeSingle();
    if (!c) return res.status(404).json({ error: 'Onboarding-link niet gevonden of verlopen' });

    if (req.method === 'GET') {
      return res.status(200).json({ first_name: c.first_name || '', status: c.onboarding_status });
    }
    if (req.method === 'POST') {
      await supabaseAdmin.from('customers').update({
        onboarding_status: 'completed', onboarding_completed_at: new Date().toISOString(),
      }).eq('id', c.id);
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'GET of POST' });
  } catch (e) {
    console.error('[onboarding]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
