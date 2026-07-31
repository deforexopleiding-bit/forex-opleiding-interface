// api/leadsonderhoud-instellingen.js
// GET  -> { live, noodstop } : staat de motor live, en is de noodstop aan?
// POST { live: true|false } -> zet de live-schuif in app_settings.
//
// De noodstop (env LEADSONDERHOUD_UIT) staat bóven de schuif: staat die aan,
// dan verstuurt de motor niets, ongeacht deze instelling. De UI toont dat.
//
// Gate: leads.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { instelWaarde } from './_lib/leadsonderhoud-sjabloon.js';

function aanUit(v) {
  return ['1', 'true', 'aan', 'on', 'ja'].includes(String(v || '').trim().toLowerCase());
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const noodstop = aanUit(process.env.LEADSONDERHOUD_UIT);
  // Eigen schuif per omgeving, zodat live op de preview productie niet raakt.
  const omgeving = process.env.VERCEL_ENV || 'development';
  const sleutel = 'leadsonderhoud_live_' + omgeving;

  if (req.method === 'GET') {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', sleutel).maybeSingle();
    return res.status(200).json({ live: instelWaarde(data) === 'true', noodstop, omgeving });
  }

  if (req.method === 'POST') {
    const live = (req.body || {}).live === true;
    const { error } = await supabaseAdmin
      .from('app_settings')
      .upsert({ key: sleutel, value: live ? 'true' : 'false', updated_by_user_id: user.id },
              { onConflict: 'key' });
    if (error) {
      console.error('instellingen opslaan mislukt:', error.message);
      return res.status(500).json({ error: 'Opslaan mislukt' });
    }
    return res.status(200).json({ live, noodstop, omgeving });
  }

  return res.status(405).json({ error: 'GET of POST' });
}
