// api/leads-update.js
// POST { id, status?, notitie?, eigenaar_id? } → wijzig alleen die 3 velden.
// Permission: leads.update.
//
// KRITIEK: server-side whitelist via buildLeadUpdatePatch(). Vastleg-velden
// (kwalificatie, score, drempel, afwijzer, antwoorden) worden HARD genegeerd
// ook als ze in de body zitten — die zijn de vastlegging van het aanmeld-
// moment en mogen NIET achteraf gewijzigd worden. Zie tests/leads-update-
// whitelist.test.js voor bewijs.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildLeadUpdatePatch } from './_lib/leads-update-whitelist.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = req.body || {};
  const id = body.id ? String(body.id).trim() : null;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  const { patch, error, rejected } = buildLeadUpdatePatch(body);
  if (error) return res.status(422).json({ error, rejected });
  if (Object.keys(patch).length === 0) {
    return res.status(200).json({ ok: true, no_op: true, rejected });
  }

  try {
    const { data, error: dbErr } = await supabaseAdmin
      .from('leads')
      .update(patch)
      .eq('id', id)
      .select('id, status, notitie, eigenaar_id, bijgewerkt')
      .maybeSingle();
    if (dbErr) throw new Error('leads update: ' + dbErr.message);
    if (!data) return res.status(404).json({ error: 'Lead niet gevonden' });

    // Rejected velden loggen zodat misbruik-pogingen zichtbaar zijn in
    // Vercel-logs (client die vastleg-velden probeert mee te sturen).
    if (rejected && rejected.length) {
      console.warn('[leads-update] rejected velden (whitelist):', rejected, 'lead_id=', id, 'user=', user.id);
    }

    return res.status(200).json({ ok: true, lead: data, rejected });
  } catch (e) {
    console.error('[leads-update]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
