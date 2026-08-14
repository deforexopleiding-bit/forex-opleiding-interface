// api/leadsonderhoud-sjabloon-opslaan.js
//
// POST -> create OR update van één `onderhoud_sjablonen`-rij.
//
// Conventie identiek aan `-traject-opslaan.js` / `-stap-opslaan.js`:
//   - Auth: user-session + requirePermission('leads.view')
//   - Body-id aanwezig ⇒ UPDATE .eq('id', id).select().single()
//   - Body-id afwezig  ⇒ INSERT .select().single()
//   - Whitelist: alleen expliciete kolommen (geen NOT-NULL DB-defaults
//     overschrijven; `bijgewerkt` wordt door DB-trigger of default gezet).
//
// Validation:
//   - `traject_slug`, `soort`, `kanaal`, `tekst` verplicht (DB NOT NULL)
//   - `kanaal` ∈ {'mail','whatsapp'} (DB check-constraint)
//   - `score_min` <= `score_max` als beide gezet
//   - Unieke-index-conflict (23505) → 409 met leesbare boodschap
//
// Response 200: { sjabloon: <row> }
// Response 400: validation error
// Response 409: unieke-constraint conflict
// Response 500: server-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const KANALEN = new Set(['mail', 'whatsapp']);

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

  const b = req.body || {};

  // ── Validation ─────────────────────────────────────────────────────────
  const traject_slug = typeof b.traject_slug === 'string' ? b.traject_slug.trim() : '';
  const soort        = typeof b.soort === 'string'        ? b.soort.trim()        : '';
  const kanaal       = typeof b.kanaal === 'string'       ? b.kanaal.trim()       : '';
  const tekst        = typeof b.tekst === 'string'        ? b.tekst               : '';

  if (!traject_slug) return res.status(400).json({ error: 'traject_slug is verplicht' });
  if (!soort)        return res.status(400).json({ error: 'soort is verplicht' });
  if (!kanaal || !KANALEN.has(kanaal)) return res.status(400).json({ error: `kanaal moet 'mail' of 'whatsapp' zijn` });
  if (!tekst && kanaal === 'mail')     return res.status(400).json({ error: 'tekst is verplicht (mail-body of platte-tekst fallback)' });
  if (!tekst && kanaal === 'whatsapp') return res.status(400).json({ error: 'tekst is verplicht (UI-preview van WA-template)' });

  const score_min = b.score_min == null || b.score_min === '' ? null : Number(b.score_min);
  const score_max = b.score_max == null || b.score_max === '' ? null : Number(b.score_max);
  if (score_min != null && Number.isNaN(score_min)) return res.status(400).json({ error: 'score_min moet een getal zijn' });
  if (score_max != null && Number.isNaN(score_max)) return res.status(400).json({ error: 'score_max moet een getal zijn' });
  if (score_min != null && score_max != null && score_min > score_max) {
    return res.status(400).json({ error: 'score_min mag niet groter zijn dan score_max' });
  }

  // variabele_volgorde: text[] — normaliseer naar array van strings of null
  let variabele_volgorde = null;
  if (Array.isArray(b.variabele_volgorde)) {
    variabele_volgorde = b.variabele_volgorde.map((s) => String(s || '').trim()).filter(Boolean);
    if (variabele_volgorde.length === 0) variabele_volgorde = null;
  } else if (typeof b.variabele_volgorde === 'string' && b.variabele_volgorde.trim()) {
    variabele_volgorde = b.variabele_volgorde.split(',').map((s) => s.trim()).filter(Boolean);
    if (variabele_volgorde.length === 0) variabele_volgorde = null;
  }

  // ── Whitelist velden ───────────────────────────────────────────────────
  const velden = {
    traject_slug,
    soort,
    kanaal,
    onderwerp:          typeof b.onderwerp === 'string' ? b.onderwerp : null,
    html:               typeof b.html === 'string' ? b.html : null,
    tekst,
    meta_template:      typeof b.meta_template === 'string' && b.meta_template.trim() ? b.meta_template.trim() : null,
    variabele_volgorde,
    score_min,
    score_max,
    actief:             b.actief === undefined ? true : !!b.actief,
    bijgewerkt:         new Date().toISOString(),
  };

  try {
    let out;
    if (b.id) {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_sjablonen')
        .update(velden)
        .eq('id', b.id)
        .select()
        .single();
      if (error) throw error;
      out = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_sjablonen')
        .insert(velden)
        .select()
        .single();
      if (error) throw error;
      out = data;
    }
    return res.status(200).json({ sjabloon: out });
  } catch (e) {
    if (e?.code === '23505') {
      return res.status(409).json({
        error: 'Er bestaat al een sjabloon met deze combinatie (traject_slug + soort + score-range). Verander één van de velden of bewerk het bestaande sjabloon.',
      });
    }
    console.error('sjabloon-opslaan mislukt:', e.message);
    return res.status(500).json({ error: 'Opslaan mislukt: ' + (e.message || 'onbekende fout') });
  }
}
