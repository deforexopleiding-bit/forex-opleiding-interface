// api/leadsonderhoud-droogloop-opruimen.js
// POST -> verwijdert de droogloop-regels uit berichten_log (status 'droog').
// Voor na een paar dagen testen, zodat je de test-rommel weg kunt halen zonder
// in de database te duiken. Raakt alleen 'droog'-regels; 'verstuurd' en 'fout'
// blijven staan.
//
// Gate: leads.view. Response: { ok:true, verwijderd }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    // .select() erbij zodat we kunnen tellen hoeveel er weg zijn.
    const { data, error } = await supabaseAdmin
      .from('berichten_log').delete().eq('status', 'droog').select('id');
    if (error) throw error;
    return res.status(200).json({ ok: true, verwijderd: (data || []).length });
  } catch (e) {
    console.error('droogloop-opruimen mislukt:', e.message);
    return res.status(500).json({ error: 'Opruimen mislukt' });
  }
}
