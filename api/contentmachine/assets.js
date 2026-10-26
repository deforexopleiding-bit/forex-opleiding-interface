// api/contentmachine/assets.js
//
// Contentmachine (2026-10-23) — beelden: de bibliotheek (drop_id NULL) en de
// foto's/screenshots per drop. Bucket `content` (publiek lezen).
//
// GET ?drop_id=<uuid> | ?bibliotheek=1 [&soort=payout]   → { assets:[…] }
// POST { actie:'upload-url', content_type, slug? }  → { pad, token } (signed upload, 2 u geldig)
//      De browser laadt het bestand ZELF op (geen Vercel-limiet van 4,5 MB).
// POST { actie:'registreer', pad, drop_id?, soort?, bijschrift?, persoon_naam?, toestemming_publiek? }
//      → controleert het bestand in Storage (type aan de bytes, max 10 MB),
//        leest de maat en maakt de content_assets-rij.
// POST { actie:'beschrijf', id }                     → AI (vision) beschrijft het beeld
// POST { actie:'bijwerken', id, …velden }            → bijschrift/persoon/toestemming/soort/tags
// POST { actie:'naar-bibliotheek', id }              → drop-beeld ook in de bibliotheek (drop_id NULL)
// POST { actie:'verwijder', id }                     → verbergen (verwijderd_op); bestand blijft
// POST { actie:'social-upload-url', drop_id, naam }   → signed upload (upsert) voor een
//      gerenderd social-beeld: drops/<slug>/social/<naam>.png (fase 3; geen asset-rij)
// POST { actie:'seed' }                              → de 19 masterclass-beelden uit
//      img/contentmachine/bibliotheek-seed/ eenmalig naar bibliotheek/seed/ (idempotent).

import crypto from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import {
  BUCKET, MAX_BEELD_BYTES, ASSET_SOORTEN, beeldType, typeUitBytes, beeldMaat, assetPad, isEigenPad,
  normaliseerAssetPatch, seedMetadata, SLUG_RE, socialPad,
} from '../_lib/contentmachine-core.js';
import { beschrijfBeeld } from '../_lib/contentmachine-ai.js';

export const SEED_MAP = 'img/contentmachine/bibliotheek-seed';
const KOLOMMEN = 'id,drop_id,soort,storage_path,publieke_url,mime,grootte,breedte,hoogte,bijschrift,ai_beschrijving,ai_details,persoon_naam,toestemming_publiek,tags,laatst_gebruikt_op,aangemaakt_op';
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));

function publiekeUrl(pad) {
  return supabaseAdmin.storage.from(BUCKET).getPublicUrl(pad).data?.publicUrl;
}

async function downloadBytes(pad) {
  const { data, error } = await supabaseAdmin.storage.from(BUCKET).download(pad);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

/** Seed: bestanden uit de deploy (includeFiles) naar Storage + rijen. Idempotent op storage_path. */
export async function seedBibliotheek({ db = supabaseAdmin, map = SEED_MAP, userId = null } = {}) {
  let bestanden;
  try { bestanden = readdirSync(join(process.cwd(), map)).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort(); }
  catch (e) { return { ok: false, fout: 'Seed-map niet gevonden in de deploy: ' + map }; }
  const paden = bestanden.map((f) => `bibliotheek/seed/${f.toLowerCase()}`);
  const { data: bestaand, error } = await db.from('content_assets').select('storage_path').in('storage_path', paden);
  if (error) throw error;
  const al = new Set((bestaand || []).map((x) => x.storage_path));
  const resultaat = { ok: true, totaal: bestanden.length, nieuw: 0, al_aanwezig: 0, fouten: [] };
  for (const f of bestanden) {
    const pad = `bibliotheek/seed/${f.toLowerCase()}`;
    if (al.has(pad)) { resultaat.al_aanwezig++; continue; }
    try {
      const bytes = readFileSync(join(process.cwd(), map, f));
      const type = typeUitBytes(bytes);
      if (!type) throw new Error('geen beeld');
      const up = await db.storage.from(BUCKET).upload(pad, bytes, { contentType: type, cacheControl: '31536000', upsert: true });
      if (up.error) throw up.error;
      const maat = beeldMaat(bytes) || {};
      const meta = seedMetadata(f);
      const ins = await db.from('content_assets').insert({
        drop_id: null, storage_path: pad, publieke_url: db.storage.from(BUCKET).getPublicUrl(pad).data?.publicUrl,
        mime: type, grootte: bytes.length, breedte: maat.breedte || null, hoogte: maat.hoogte || null,
        soort: meta.soort, bijschrift: meta.bijschrift, persoon_naam: meta.persoon_naam,
        toestemming_publiek: meta.toestemming_publiek, tags: meta.tags, aangemaakt_door: userId,
      });
      if (ins.error) throw ins.error;
      resultaat.nieuw++;
    } catch (e) {
      console.error('[contentmachine/assets] seed fout:', f, e?.message || e);
      resultaat.fouten.push({ bestand: f, fout: e?.message || String(e) });
    }
  }
  return resultaat;
}

export default async function handler(req, res) {
  const p = await poort(req, res);
  if (!p) return;
  const db = supabaseAdmin;

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      let query = db.from('content_assets').select(KOLOMMEN).is('verwijderd_op', null);
      if (isUuid(q.drop_id)) query = query.eq('drop_id', q.drop_id);
      else query = query.is('drop_id', null);
      if (ASSET_SOORTEN.includes(q.soort)) query = query.eq('soort', q.soort);
      const { data, error } = await query.order('aangemaakt_op', { ascending: false }).limit(1000);
      if (error) throw error;
      return res.status(200).json({ assets: data || [] });
    }

    const b = body(req);
    const actie = String(b.actie || '');

    if (actie === 'upload-url') {
      const t = beeldType(b.content_type);
      if (!t) return res.status(400).json({ error: 'Alleen PNG, JPEG, GIF of WebP.' });
      const slug = SLUG_RE.test(String(b.slug || '')) ? b.slug : null;
      const pad = assetPad({ slug, ext: t.ext, uuid: crypto.randomUUID() });
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(pad);
      if (error) {
        if (/bucket not found|not found/i.test(error.message || '')) return res.status(409).json({ error: 'De bucket content bestaat nog niet — draai de Contentmachine-migratie.', code: 'MIGRATIE_NODIG' });
        throw error;
      }
      return res.status(200).json({ ok: true, pad, token: data.token, bucket: BUCKET });
    }

    if (actie === 'social-upload-url') {
      if (!isUuid(b.drop_id)) return res.status(400).json({ error: 'drop_id ontbreekt' });
      const { data: drop, error: dErr } = await db.from('content_drops').select('id,slug').eq('id', b.drop_id).maybeSingle();
      if (dErr) throw dErr;
      if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
      const pad = socialPad(drop.slug, b.naam);
      if (!pad) return res.status(400).json({ error: 'Ongeldige naam voor een social-beeld.' });
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(pad, { upsert: true });
      if (error) throw error;
      return res.status(200).json({ ok: true, pad, token: data.token, bucket: BUCKET, publieke_url: publiekeUrl(pad) });
    }

    if (actie === 'registreer') {
      const pad = String(b.pad || '');
      if (!isEigenPad(pad)) return res.status(400).json({ error: 'Ongeldig pad.' });
      if (b.drop_id && !isUuid(b.drop_id)) return res.status(400).json({ error: 'Ongeldige drop.' });
      const bytes = await downloadBytes(pad);
      if (!bytes) return res.status(404).json({ error: 'Het bestand staat (nog) niet in Storage.' });
      const type = typeUitBytes(bytes);
      if (!type || bytes.length > MAX_BEELD_BYTES) {
        await db.storage.from(BUCKET).remove([pad]);
        return res.status(400).json({ error: !type ? 'Dat is geen PNG, JPEG, GIF of WebP.' : 'Het beeld is groter dan 10 MB.' });
      }
      const maat = beeldMaat(bytes) || {};
      const patch = normaliseerAssetPatch(b);
      const { data, error } = await db.from('content_assets').insert({
        drop_id: b.drop_id || null, storage_path: pad, publieke_url: publiekeUrl(pad), mime: type, grootte: bytes.length,
        breedte: maat.breedte || null, hoogte: maat.hoogte || null, soort: patch.soort || 'overig',
        bijschrift: patch.bijschrift ?? null, persoon_naam: patch.persoon_naam ?? null,
        toestemming_publiek: patch.toestemming_publiek === true, tags: patch.tags || [], aangemaakt_door: p.user.id,
      }).select(KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, asset: data });
    }

    if (actie === 'seed') {
      return res.status(200).json(await seedBibliotheek({ db, userId: p.user.id }));
    }

    const id = String(b.id || '');
    if (!isUuid(id)) return res.status(400).json({ error: 'id ontbreekt' });
    const { data: asset, error: aErr } = await db.from('content_assets').select(KOLOMMEN).eq('id', id).is('verwijderd_op', null).maybeSingle();
    if (aErr) throw aErr;
    if (!asset) return res.status(404).json({ error: 'Beeld niet gevonden' });

    if (actie === 'beschrijf') {
      let r;
      try {
        r = await beschrijfBeeld({ url: asset.publieke_url, bijschrift: asset.bijschrift, persoon: asset.persoon_naam });
      } catch (e) {
        if (e?.code === 'ANTHROPIC_KEY_MISSING') return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd', code: e.code });
        console.error('[contentmachine/assets] beschrijven mislukt:', e?.code, e?.message);
        return res.status(502).json({ error: 'De AI kon het beeld niet beschrijven.', code: e?.code || null });
      }
      const d = r.details || {};
      const patch = { ai_beschrijving: String(d.beschrijving || '').slice(0, 2000) || null, ai_details: { ...d, model: r.model } };
      if (asset.soort === 'overig' && ASSET_SOORTEN.includes(d.soort)) patch.soort = d.soort;
      if (!asset.bijschrift && d.bijschrift_voorstel) patch.bijschrift = String(d.bijschrift_voorstel).slice(0, 500);
      const extra = Array.isArray(d.tags) ? d.tags.map((t) => String(t).toLowerCase().slice(0, 40)) : [];
      patch.tags = [...new Set([...(asset.tags || []), ...extra])].slice(0, 20);
      const { data, error } = await db.from('content_assets').update(patch).eq('id', id).select(KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, asset: data });
    }

    if (actie === 'bijwerken') {
      const patch = normaliseerAssetPatch(b);
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Niets om bij te werken.' });
      const { data, error } = await db.from('content_assets').update(patch).eq('id', id).select(KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, asset: data });
    }

    if (actie === 'naar-bibliotheek') {
      const { data, error } = await db.from('content_assets').update({ drop_id: null }).eq('id', id).select(KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, asset: data });
    }

    if (actie === 'verwijder') {
      const { error } = await db.from('content_assets').update({ verwijderd_op: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    return fout(res, 'contentmachine/assets', e);
  }
}
