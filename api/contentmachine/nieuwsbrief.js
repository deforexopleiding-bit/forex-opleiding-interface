// api/contentmachine/nieuwsbrief.js
//
// Contentmachine — de nieuwsbrief van een drop.
//
// GET ?id=<uuid>[&onderwerp=0|1|2][&download=1][&formaat=html|json]
//   → text/html (voorbeeld in het werkblad of download), of JSON { html, onderwerp, preheader, tekst }
// POST { actie:'voorbeeld', id, output, onderwerp? } → JSON van een NIET-bewaarde output
//   (live voorbeeld tijdens het bewerken; er wordt niets opgeslagen)
// GET  ?id=<uuid>&ghl=1 → { ghl:{ gekoppeld, ontbreekt, links }, verzending|null }
// POST { actie:'naar-ghl', id, onderwerp? } → de nieuwsbrief als e-mailtemplate in GHL zetten
//   (nieuw of bijwerken van het template van deze drop) — enkel een goedgekeurde/gepubliceerde drop
// POST { actie:'test', id, onderwerp? } → testmail via GHL naar de INGELOGDE gebruiker
// POST { actie:'stats', id } → campagnes in GHL met dit template + stats (als GHL ze geeft)
//
// Renderen: api/_lib/nieuwsbrief-render.js (puur). Naar de LIJST wordt hier NOOIT
// verstuurd: de campagne maak en verstuur je zelf in GHL (route b, zie
// api/_lib/ghl-nieuwsbrief.js — de officiële API kent geen campagne-aanmaak).

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import { renderNieuwsbrief } from '../_lib/nieuwsbrief-render.js';
import { ASSET_KOLOMMEN } from '../_lib/contentmachine-opslag.js';
import { gebruikteAssetIds } from '../_lib/contentmachine-generator.js';
import {
  ghlNieuwsbriefConfig, ghlLinks, maakTemplate, vulTemplate, eigenContact, stuurTestmail, campagnesVoorTemplate,
} from '../_lib/ghl-nieuwsbrief.js';

/** Uitschrijflink in de mail: de merge-tag van GHL (instelbaar). */
export function uitschrijfTag(env = process.env) {
  return (env.GHL_UITSCHRIJF_TAG || '').trim() || '{{unsubscribe_link}}';
}

const VERZEND_KOLOMMEN = 'id,drop_id,provider,campagne_id,template_id,onderwerp,status,test_verstuurd_op,ingepland_op,verstuurd_op,stats,aangemaakt_op,gewijzigd_op';

async function verzendingVan(db, dropId) {
  const { data, error } = await db.from('nieuwsbrief_verzendingen').select(VERZEND_KOLOMMEN)
    .eq('drop_id', dropId).eq('provider', 'ghl').order('aangemaakt_op', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

function ghlStatus(cfg) {
  return { gekoppeld: cfg.ok, ontbreekt: cfg.ontbreekt, links: cfg.ok ? ghlLinks(cfg.locationId) : null };
}

const NIET_GEKOPPELD = (cfg) => ({ error: `GHL nog niet gekoppeld — ontbrekende env: ${cfg.ontbreekt.join(', ')}. De HTML kan je wel downloaden.`, code: 'GHL_NIET_GEKOPPELD' });

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
  const actie = req.method === 'POST' ? String(b.actie || '') : '';
  if (req.method === 'POST' && !['voorbeeld', 'naar-ghl', 'test', 'stats'].includes(actie)) return res.status(400).json({ error: 'Onbekende actie' });
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
  const db = supabaseAdmin;
  const cfg = ghlNieuwsbriefConfig();
  try {
    if (req.method === 'GET' && q.ghl === '1') {
      return res.status(200).json({ ok: true, ghl: ghlStatus(cfg), verzending: await verzendingVan(db, id) });
    }

    const voorbeeld = actie === 'voorbeeld' && b.output && typeof b.output === 'object' ? b.output : null;
    const { drop, assets } = await laadVoorNieuwsbrief(db, id, voorbeeld);
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
    const output = voorbeeld || drop.output;
    if (!output || !output.nieuwsbrief) return res.status(409).json({ error: 'Deze drop heeft nog geen nieuwsbrief.' });
    const idx = Math.max(0, Math.min(2, parseInt(q.onderwerp, 10) || 0));
    const r = renderNieuwsbrief({ drop, output, assets, onderwerpIndex: idx, uitschrijfLink: uitschrijfTag() });

    if (actie === 'naar-ghl' || actie === 'test' || actie === 'stats') {
      if (!cfg.ok) return res.status(503).json(NIET_GEKOPPELD(cfg));
      const nu = new Date().toISOString();
      let v = await verzendingVan(db, id);

      if (actie === 'naar-ghl') {
        if (!['goedgekeurd', 'gepubliceerd'].includes(drop.status)) return res.status(409).json({ error: 'Keur de drop eerst goed: enkel een nagekeken nieuwsbrief gaat naar GHL.' });
        const naam = `DFO drop ${drop.slug} — ${r.onderwerp}`.slice(0, 120);
        let templateId = v && v.template_id;
        if (!templateId) templateId = await maakTemplate(cfg, { naam });
        await vulTemplate(cfg, { templateId, html: r.html, previewText: r.preheader });
        const rij = { template_id: templateId, onderwerp: r.onderwerp, gewijzigd_op: nu };
        if (v) {
          const { data, error } = await db.from('nieuwsbrief_verzendingen').update(rij).eq('id', v.id).select(VERZEND_KOLOMMEN).single();
          if (error) throw error; v = data;
        } else {
          const { data, error } = await db.from('nieuwsbrief_verzendingen').insert({ ...rij, drop_id: id, provider: 'ghl', status: 'concept', aangemaakt_door: p.user.id }).select(VERZEND_KOLOMMEN).single();
          if (error) throw error; v = data;
        }
        return res.status(200).json({ ok: true, verzending: v, ghl: ghlStatus(cfg) });
      }

      if (actie === 'test') {
        const email = String(p.profiel?.email || p.user.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Je account heeft geen e-mailadres.' });
        const contactId = await eigenContact(cfg, { email, naam: p.profiel?.full_name || null });
        await stuurTestmail(cfg, { contactId, email, onderwerp: r.onderwerp, html: r.html });
        if (v) {
          const { data, error } = await db.from('nieuwsbrief_verzendingen').update({ test_verstuurd_op: nu, status: v.status === 'concept' ? 'test_verstuurd' : v.status, gewijzigd_op: nu }).eq('id', v.id).select(VERZEND_KOLOMMEN).single();
          if (error) throw error; v = data;
        }
        return res.status(200).json({ ok: true, naar: email, verzending: v });
      }

      // stats
      if (!v || !v.template_id) return res.status(409).json({ error: 'Deze nieuwsbrief staat nog niet in GHL.' });
      const campagnes = await campagnesVoorTemplate(cfg, { templateId: v.template_id });
      const c = campagnes[0] || null;
      const verstuurd = c && /complete|sent|finished|delivered/i.test(c.status || '');
      const ingepland = c && /schedul|queued/i.test(c.status || '');
      const patch = {
        campagne_id: c ? c.id : v.campagne_id, gewijzigd_op: nu,
        stats: { ...(v.stats || {}), campagnes, opgehaald_op: nu, ...(c && c.stats ? { laatste: c.stats } : {}) },
        ...(verstuurd ? { status: 'verstuurd', verstuurd_op: v.verstuurd_op || nu } : ingepland ? { status: 'ingepland', ingepland_op: v.ingepland_op || nu } : {}),
      };
      const { data, error } = await db.from('nieuwsbrief_verzendingen').update(patch).eq('id', v.id).select(VERZEND_KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, verzending: data, campagnes });
    }

    if (q.formaat === 'json') return res.status(200).json({ ok: true, ...r });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (q.download === '1') res.setHeader('Content-Disposition', `attachment; filename="nieuwsbrief-${drop.slug}.html"`);
    return res.status(200).send(r.html);
  } catch (e) {
    if (e?.code && String(e.code).startsWith('GHL_')) return res.status(502).json({ error: e.message, code: e.code });
    return fout(res, 'contentmachine/nieuwsbrief', e);
  }
}
