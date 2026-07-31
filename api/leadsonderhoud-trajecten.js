// api/leadsonderhoud-trajecten.js
// GET -> de trajecten met hun stappen. Dit voedt het Trajecten-scherm, waar je
// per soort lead (7-daagse, minicursus, student worden, event...) de reeks
// berichten inricht. Beide staan als gegevens in de database (onderhoud_trajecten
// en onderhoud_stappen), niet als code, zodat een nieuw traject rijen invoeren is.
//
// Alleen lezen. Gate: leads.view.
//
// Response: { trajecten: [ { ...traject, stappen: [ ...onderhoud_stappen ] } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const { data: trajecten, error: tErr } = await supabaseAdmin
      .from('onderhoud_trajecten')
      .select('*')
      .order('volgorde', { ascending: true });
    if (tErr) throw tErr;

    const { data: stappen, error: sErr } = await supabaseAdmin
      .from('onderhoud_stappen')
      .select('*')
      .order('volgorde', { ascending: true });
    if (sErr) throw sErr;

    // Stappen per traject groeperen, zodat het scherm ze meteen kan tonen.
    const stappenPer = {};
    for (const s of stappen || []) {
      (stappenPer[s.traject_id] ||= []).push(s);
    }
    const uit = (trajecten || []).map((t) => ({ ...t, stappen: stappenPer[t.id] || [] }));

    return res.status(200).json({ trajecten: uit });
  } catch (e) {
    console.error('leadsonderhoud-trajecten mislukt:', e.message);
    return res.status(500).json({ error: 'Trajecten laden mislukt' });
  }
}
