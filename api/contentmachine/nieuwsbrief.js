// api/contentmachine/nieuwsbrief.js
//
// Contentmachine — de nieuwsbrief van een drop.
//
// GET ?id=<uuid>[&onderwerp=0|1|2][&download=1][&formaat=html|json]
//   → text/html (voorbeeld in het werkblad of download), of JSON { html, onderwerp, preheader, tekst }
// POST { actie:'voorbeeld', id, output, onderwerp? } → JSON van een NIET-bewaarde output
//   (live voorbeeld tijdens het bewerken; er wordt niets opgeslagen)
//
// Renderen: api/_lib/nieuwsbrief-render.js (puur). Er wordt hier NIETS verstuurd.

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import { renderNieuwsbrief } from '../_lib/nieuwsbrief-render.js';
import { ASSET_KOLOMMEN } from '../_lib/contentmachine-opslag.js';
import { gebruikteAssetIds } from '../_lib/contentmachine-generator.js';

/** Drop + de beelden die de nieuwsbrief gebruikt. */
export async function laadVoorNieuwsbrief(db, id, outputOverride = null) {
  const { data: drop, error } = await db.from('content_drops').select('id,slug,datum,soort,status,input,output,versie').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!drop) return { drop: null, assets: [] };
  const o = outputOverride || drop.output;
  const ids = gebruikteAssetIds(o && o.nieuwsbrief);
  let assets = [];
  if (ids.length) {
    const r = await db.from('content_assets').select(ASSET_KOLOMMEN).in('id', ids);
    if (r.error) throw r.error;
    assets = r.data || [];
  }
  return { drop, assets };
}

export default async function handler(req, res) {
  const p = await poort(req, res, { methodes: ['GET', 'POST'] });
  if (!p) return;
  const b = req.method === 'POST' ? body(req) : {};
  const q = req.method === 'POST' ? { ...b, formaat: 'json' } : (req.query || {});
  const id = String(q.id || '');
  if (req.method === 'POST' && b.actie !== 'voorbeeld') return res.status(400).json({ error: 'Onbekende actie' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
  try {
    const voorbeeld = req.method === 'POST' && b.output && typeof b.output === 'object' ? b.output : null;
    const { drop, assets } = await laadVoorNieuwsbrief(supabaseAdmin, id, voorbeeld);
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
    const output = voorbeeld || drop.output;
    if (!output || !output.nieuwsbrief) return res.status(409).json({ error: 'Deze drop heeft nog geen nieuwsbrief.' });
    const idx = Math.max(0, Math.min(2, parseInt(q.onderwerp, 10) || 0));
    const r = renderNieuwsbrief({ drop, output, assets, onderwerpIndex: idx });
    if (q.formaat === 'json') return res.status(200).json({ ok: true, ...r });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (q.download === '1') res.setHeader('Content-Disposition', `attachment; filename="nieuwsbrief-${drop.slug}.html"`);
    return res.status(200).send(r.html);
  } catch (e) {
    return fout(res, 'contentmachine/nieuwsbrief', e);
  }
}
