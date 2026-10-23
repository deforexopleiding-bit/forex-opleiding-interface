// api/contentmachine/drops.js
//
// Contentmachine (2026-10-23) — de wekelijkse drops.
//
// GET                    → { drops:[…] } nieuwste bovenaan (zonder output-inhoud)
// GET ?id=<uuid>         → { drop, assets:[…], versies:[…] }
// POST { actie:'maak', datum:'YYYY-MM-DD' }          → nieuwe concept-drop (slug dd-mm-jj[-n])
// POST { actie:'bewaar', id, datum?, input }         → invoer bewaren (enkel concept/gegenereerd)
// POST { actie:'vimeo', url }                        → Vimeo oEmbed: titel, duur, thumbnail
// POST { actie:'archiveer', id } / { actie:'herstel', id }
//
// Alleen service role na poort() (recht content.machine). De website leest
// gepubliceerde drops zelf (service-key, status = 'gepubliceerd').

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import {
  slugVanDatum, vrijeSlug, normaliseerInput, soortVanInput, parseVimeo,
} from '../_lib/contentmachine-core.js';

const LIJST_KOLOMMEN = 'id,slug,datum,soort,status,format_key,versie,aangemaakt_op,gewijzigd_op,gegenereerd_op,goedgekeurd_op,gepubliceerd_op,input,kern:output->>kernidee,titel:output->pagina->>hero_titel';
const ASSET_KOLOMMEN = 'id,drop_id,soort,storage_path,publieke_url,breedte,hoogte,bijschrift,ai_beschrijving,ai_details,persoon_naam,toestemming_publiek,tags,laatst_gebruikt_op,aangemaakt_op';

export async function vimeoInfo(url, fetchImpl = fetch) {
  const v = parseVimeo(url);
  if (!v) return { ok: false, fout: 'Geen geldige Vimeo-link.' };
  // oEmbed kent privé-links (met hash) via de player-URL.
  const oembed = 'https://vimeo.com/api/oembed.json?width=1280&url=' + encodeURIComponent(v.vimeo_hash
    ? `https://vimeo.com/${v.vimeo_id}/${v.vimeo_hash}` : `https://vimeo.com/${v.vimeo_id}`);
  try {
    const r = await fetchImpl(oembed, { headers: { Accept: 'application/json' } });
    if (!r.ok) return { ok: true, ...v, titel: null, duur: null, thumbnail: null, waarschuwing: `Vimeo gaf ${r.status} — titel/duur onbekend (link is wel bewaard).` };
    const j = await r.json();
    return {
      ok: true, ...v,
      titel: j.title || null,
      duur: Number.isFinite(+j.duration) ? +j.duration : null,
      thumbnail: j.thumbnail_url || null,
    };
  } catch (e) {
    return { ok: true, ...v, titel: null, duur: null, thumbnail: null, waarschuwing: 'Vimeo niet bereikbaar — titel/duur onbekend.' };
  }
}

function lijstRij(d) {
  const i = d.input || {};
  return {
    id: d.id, slug: d.slug, datum: d.datum, soort: d.soort, status: d.status, format_key: d.format_key,
    versie: d.versie, aangemaakt_op: d.aangemaakt_op, gewijzigd_op: d.gewijzigd_op,
    gegenereerd_op: d.gegenereerd_op, goedgekeurd_op: d.goedgekeurd_op, gepubliceerd_op: d.gepubliceerd_op,
    kernidee: d.kern || null, titel: d.titel || null,
    heeft_video: !!i.vimeo_id, vimeo_thumbnail: i.vimeo_thumbnail || null,
    kanalen: Array.isArray(i.kanalen) ? i.kanalen : [],
    wat_gebeurde_kort: String(i.wat_gebeurde || '').slice(0, 140),
  };
}

export default async function handler(req, res) {
  const p = await poort(req, res);
  if (!p) return;
  const db = supabaseAdmin;

  try {
    if (req.method === 'GET') {
      const id = String(req.query?.id || '');
      if (id) {
        const { data: drop, error } = await db.from('content_drops').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
        const [a, v] = await Promise.all([
          db.from('content_assets').select(ASSET_KOLOMMEN).eq('drop_id', id).is('verwijderd_op', null).order('aangemaakt_op', { ascending: true }),
          db.from('content_drop_versies').select('id,versie,reden,aangemaakt_op,aangemaakt_door').eq('drop_id', id).order('versie', { ascending: false }).limit(50),
        ]);
        if (a.error) throw a.error;
        if (v.error) throw v.error;
        return res.status(200).json({ drop, assets: a.data || [], versies: v.data || [] });
      }
      const { data, error } = await db.from('content_drops').select(LIJST_KOLOMMEN)
        .order('datum', { ascending: false }).order('aangemaakt_op', { ascending: false }).limit(200);
      if (error) throw error;
      return res.status(200).json({ drops: (data || []).map(lijstRij) });
    }

    const b = body(req);
    const actie = String(b.actie || '');

    if (actie === 'vimeo') {
      return res.status(200).json(await vimeoInfo(b.url));
    }

    if (actie === 'maak') {
      const slugBasis = slugVanDatum(b.datum);
      if (!slugBasis) return res.status(400).json({ error: 'Ongeldige datum (YYYY-MM-DD).' });
      const { data: bestaand, error: bErr } = await db.from('content_drops').select('slug').like('slug', slugBasis + '%');
      if (bErr) throw bErr;
      const slug = vrijeSlug(slugBasis, (bestaand || []).map((x) => x.slug));
      if (!slug) return res.status(409).json({ error: 'Te veel drops op deze dag.' });
      const input = normaliseerInput(b.input || {});
      const { data, error } = await db.from('content_drops').insert({
        slug, datum: b.datum, soort: soortVanInput(input), status: 'concept', input, aangemaakt_door: p.user.id,
      }).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    const id = String(b.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
    const { data: drop, error: dErr } = await db.from('content_drops').select('id,slug,datum,status,versie,heeft_output:output->>format_key').eq('id', id).maybeSingle();
    if (dErr) throw dErr;
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });

    if (actie === 'bewaar') {
      if (!['concept', 'gegenereerd', 'goedgekeurd'].includes(drop.status)) {
        return res.status(409).json({ error: 'Een gepubliceerde of gearchiveerde drop kan je niet meer aanpassen.' });
      }
      const input = normaliseerInput(b.input || {});
      const patch = { input, soort: soortVanInput(input), gewijzigd_op: new Date().toISOString() };
      if (b.datum && b.datum !== drop.datum) {
        if (drop.status !== 'concept') return res.status(409).json({ error: 'De datum kan je enkel bij een concept wijzigen.' });
        const basis = slugVanDatum(b.datum);
        if (!basis) return res.status(400).json({ error: 'Ongeldige datum.' });
        const { data: bestaand, error: bErr } = await db.from('content_drops').select('slug').like('slug', basis + '%').neq('id', id);
        if (bErr) throw bErr;
        patch.datum = b.datum;
        patch.slug = vrijeSlug(basis, (bestaand || []).map((x) => x.slug));
      }
      const { data, error } = await db.from('content_drops').update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    if (actie === 'archiveer' || actie === 'herstel') {
      const status = actie === 'archiveer' ? 'gearchiveerd' : (drop.heeft_output ? 'gegenereerd' : 'concept');
      if (actie === 'herstel' && drop.status !== 'gearchiveerd') return res.status(409).json({ error: 'Alleen een gearchiveerde drop kan je herstellen.' });
      const { data, error } = await db.from('content_drops').update({ status, gewijzigd_op: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    return fout(res, 'contentmachine/drops', e);
  }
}
