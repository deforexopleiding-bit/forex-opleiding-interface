// api/agenda-beschikbaarheid-set.js
//
// Schrijft de agenda-beschikbaarheid naar app_settings['agenda_beschikbaarheid'].
// Eén gezamenlijke opstartsessie-agenda. De publieke funnel (free-slots + book)
// leest dit server-side en dwingt het hard af; de handmatige CRM-boeking toont
// alleen een waarschuwing (admin-override).
//
//   POST { max_per_dag:int>=0, gesloten_dagen:[ 'YYYY-MM-DD' ], gesloten_ranges:[ {van,tot} ] }
//   → 200 { ok:true, max_per_dag, gesloten_dagen, gesloten_ranges }
//
// max_per_dag = 0 → geen limiet (cap uit). Permission: leads.update.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KEY = 'agenda_beschikbaarheid';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const geldigeDatum = (d) => typeof d === 'string' && DATE_RE.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};

  const maxRaw = Number(body.max_per_dag);
  if (!Number.isFinite(maxRaw) || maxRaw < 0 || maxRaw > 1000) {
    return res.status(400).json({ error: 'max_per_dag moet 0..1000 zijn (0 = geen limiet)' });
  }
  const max_per_dag = Math.floor(maxRaw);

  // Losse dagen: dedup + sorteer; ongeldige stil negeren.
  const gesloten_dagen = [...new Set(
    (Array.isArray(body.gesloten_dagen) ? body.gesloten_dagen : []).filter(geldigeDatum),
  )].sort();

  // Ranges: beide uiteinden geldig én van <= tot; anders weglaten.
  const gesloten_ranges = (Array.isArray(body.gesloten_ranges) ? body.gesloten_ranges : [])
    .filter((r) => r && geldigeDatum(r.van) && geldigeDatum(r.tot) && r.van <= r.tot)
    .map((r) => ({ van: r.van, tot: r.tot }));

  const value = { max_per_dag, gesloten_dagen, gesloten_ranges };

  try {
    const { error } = await supabaseAdmin.from('app_settings').upsert({ key: KEY, value }, { onConflict: 'key' });
    if (error) throw error;
    return res.status(200).json({ ok: true, ...value });
  } catch (e) {
    console.error('[agenda-beschikbaarheid-set]', e?.message || e);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
