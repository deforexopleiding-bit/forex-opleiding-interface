// api/leadsonderhoud-sjabloon-verwijderen.js
//
// POST -> verwijdert één `onderhoud_sjablonen`-rij.
//
// GUARD: er is geen FK van `onderhoud_stappen` naar `onderhoud_sjablonen`.
// De drip-motor matcht runtime op (traject_slug + soort). Als we een sjabloon
// verwijderen dat door actieve stappen wordt gematched → silent skip in cron
// ("geen sjabloon in de tabel"), geen crash. Maar dat is stille rot: Jeffrey
// weet niet waarom een stap niet uitgaat.
//
// Daarom checken we vóór delete: bestaan er stappen die op (traject_slug =
// sjabloon.traject_slug + soort = sjabloon.soort) matchen? Zo ja:
//   - default: 409 met `{ error, gekoppelde_stappen: [{id,naam,traject_id}] }`
//   - override met `?force=1`: verwijder alsnog (Jeffrey weet wat 'ie doet)
//
// Body: { id, force?: boolean }
// Response 200: { ok:true, gekoppelde_stappen_geraakt?: number }
// Response 409: { error, gekoppelde_stappen: [...] } — zonder force
// Response 400/500: standaard

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

  const b = req.body || {};
  const id = b.id;
  const force = b.force === true || b.force === 'true' || b.force === 1 || b.force === '1';
  if (!id) return res.status(400).json({ error: 'id ontbreekt' });

  try {
    // 1) Sjabloon ophalen voor guard-check
    const { data: sjab, error: sErr } = await supabaseAdmin
      .from('onderhoud_sjablonen')
      .select('id, traject_slug, soort')
      .eq('id', id)
      .maybeSingle();
    if (sErr) throw sErr;
    if (!sjab) return res.status(404).json({ error: 'Sjabloon niet gevonden' });

    // 2) Guard: check gekoppelde stappen via traject_slug + soort.
    //    Join onderhoud_stappen → onderhoud_trajecten op traject_id waar
    //    traject.slug = sjab.traject_slug AND stap.soort = sjab.soort.
    //    PostgREST embedded select om join te doen.
    let gekoppeld = [];
    try {
      const { data: stappen, error: stErr } = await supabaseAdmin
        .from('onderhoud_stappen')
        .select('id, naam, soort, traject_id, actief, onderhoud_trajecten!inner(id, slug)')
        .eq('soort', sjab.soort)
        .eq('onderhoud_trajecten.slug', sjab.traject_slug);
      if (stErr) {
        // Als embedded select faalt (bv. relatie-naam anders): fail-open,
        // laat guard varen. Beter delete-with-warning dan hard-block.
        console.warn('sjabloon-verwijderen: guard-check faalde:', stErr.message);
      } else {
        gekoppeld = (stappen || []).map((s) => ({
          id: s.id,
          naam: s.naam,
          soort: s.soort,
          traject_slug: s.onderhoud_trajecten?.slug || null,
          traject_id:   s.traject_id,
          actief:       s.actief,
        }));
      }
    } catch (guardErr) {
      console.warn('sjabloon-verwijderen: guard-exception:', guardErr.message);
    }

    if (gekoppeld.length > 0 && !force) {
      return res.status(409).json({
        error: 'Sjabloon is gekoppeld aan ' + gekoppeld.length + ' stap(pen). Verwijder eerst die stappen of gebruik force=true om alsnog te verwijderen.',
        gekoppelde_stappen: gekoppeld,
      });
    }

    // 3) Delete
    const { error: delErr } = await supabaseAdmin
      .from('onderhoud_sjablonen')
      .delete()
      .eq('id', id);
    if (delErr) throw delErr;

    return res.status(200).json({
      ok: true,
      gekoppelde_stappen_geraakt: gekoppeld.length,
    });
  } catch (e) {
    console.error('sjabloon-verwijderen mislukt:', e.message);
    return res.status(500).json({ error: 'Verwijderen mislukt: ' + (e.message || 'onbekende fout') });
  }
}
