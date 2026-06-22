// api/mentor-funded-certs-self.js
//
// GET → self-scope lijst van funded-certificaten van de ingelogde mentor.
// Wordt door de Mijn-studenten UI gebruikt om per student de claim-status
// (funded_month + filename + last_uploaded_at) te tonen.
//
// Permission: mentor.module.access. Strikte self-scope: mentor_user_id is
// altijd auth.uid(); er is geen ?mentor_user_id param.
//
// Response 200:
//   { ok, certs: [ { student_id, student_name, funded_month,
//                    file_name, last_uploaded_at } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('mentor_funded_certificates')
      .select('student_id, student_name, funded_month, file_name, last_uploaded_at')
      .eq('mentor_user_id', user.id)
      .order('last_uploaded_at', { ascending: false })
      .limit(500);
    if (error) throw new Error('certs fetch: ' + error.message);

    return res.status(200).json({
      ok    : true,
      certs : (data || []).map((r) => ({
        student_id      : r.student_id,
        student_name    : r.student_name || null,
        funded_month    : r.funded_month,
        file_name       : r.file_name || null,
        last_uploaded_at: r.last_uploaded_at,
      })),
    });
  } catch (e) {
    console.error('[mentor-funded-certs-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
