// api/contentmachine/genereer.js
//
// Contentmachine — POST /api/contentmachine/genereer
//   { id }                              → volledige drop genereren (format, pagina, nieuwsbrief,
//                                         stories, post + vierkant, LinkedIn)
//   { id, onderdeel, instructie? }      → één onderdeel opnieuw (pagina | nieuwsbrief | stories |
//                                         post | linkedin), bv. instructie "korter"
//
// Bewaart het resultaat als NIEUWE versie (content_drop_versies) en zet de status op
// 'gegenereerd' (een goedgekeurde drop moet na hergenereren opnieuw goedgekeurd worden).
// Er wordt NIETS gepubliceerd of verstuurd.
//
// Duur: één modelaanroep (~1-2 min) + eventueel één herstelronde → maxDuration 300 in vercel.json.

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import {
  genereerDrop, genereerOnderdeel, toegelatenFormats, gebruikteAssetIds, ONDERDELEN, controleerGrenzen,
} from '../_lib/contentmachine-generator.js';
import { laadContext, bewaarVersie } from '../_lib/contentmachine-opslag.js';
import { paginaUrl } from '../_lib/nieuwsbrief-render.js';

export const BEWERKBAAR = ['concept', 'gegenereerd', 'goedgekeurd'];

export default async function handler(req, res) {
  const p = await poort(req, res, { methodes: ['POST'] });
  if (!p) return;
  const db = supabaseAdmin;
  const b = body(req);
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
  const onderdeel = b.onderdeel ? String(b.onderdeel) : null;
  if (onderdeel && !ONDERDELEN.includes(onderdeel)) return res.status(400).json({ error: 'Onbekend onderdeel' });
  const instructie = String(b.instructie || '').trim().slice(0, 500);

  try {
    const { data: drop, error } = await db.from('content_drops').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
    if (!BEWERKBAAR.includes(drop.status)) return res.status(409).json({ error: 'Een gepubliceerde of gearchiveerde drop genereer je niet opnieuw.' });
    if (onderdeel && !drop.output) return res.status(409).json({ error: 'Genereer eerst de volledige drop.' });
    const i = drop.input || {};
    if (!String(i.wat_gebeurde || '').trim() && !i.vimeo_id) {
      const { data: eigen } = await db.from('content_assets').select('id').eq('drop_id', id).is('verwijderd_op', null).limit(1);
      if (!eigen || !eigen.length) return res.status(400).json({ error: 'Vul minstens in wat er deze week gebeurde, een Vimeo-link of een foto.' });
    }

    const ctx = await laadContext({ db, drop });
    const toegelaten = toegelatenFormats(ctx.vorige);
    const assetIds = ctx.alleAssets.map((a) => a.id);
    const basis = {
      drop, input: i, beelden: ctx.beelden, vorige: ctx.vorige, toegelaten, assetIds,
      verbodenNamen: ctx.verbodenNamen, paginaUrl: paginaUrl(drop.slug),
    };

    let output; let reden; let model; let waarschuwingen = [];
    if (!onderdeel) {
      const r = await genereerDrop(basis);
      model = r.model;
      waarschuwingen = r.waarschuwingen;
      output = { ...r.output, meta: { model, herstel: r.herstel, duur_ms: r.duur_ms, gegenereerd_op: new Date().toISOString(), toegelaten_formats: toegelaten, beelden: ctx.beelden.map((a) => a.id), verboden_namen: ctx.verbodenNamen, waarschuwingen } };
      reden = 'Volledig gegenereerd' + (instructie ? ` — ${instructie}` : '');
    } else {
      const r = await genereerOnderdeel({ ...basis, onderdeel, huidige: drop.output, instructie });
      model = r.model;
      const samen = { ...drop.output, ...r.deel };
      // Waarschuwingen opnieuw opbouwen: oude van dit onderdeel weg, nieuwe erbij.
      const vorigeMeta = (drop.output && drop.output.meta) || {};
      const grens = controleerGrenzen(samen, { verbodenNamen: ctx.verbodenNamen }).map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment }));
      const overig = (vorigeMeta.waarschuwingen || []).filter((w) => w.soort !== 'grens' && !String(w.tekst).startsWith(onderdeel));
      waarschuwingen = [...overig, ...grens, ...r.waarschuwingen.filter((w) => w.soort !== 'grens')];
      output = { ...samen, meta: { ...vorigeMeta, model, verboden_namen: ctx.verbodenNamen, waarschuwingen, laatst_onderdeel: { onderdeel, instructie: instructie || null, op: new Date().toISOString() } } };
      reden = `${onderdeel} opnieuw gegenereerd` + (instructie ? ` — ${instructie}` : '');
    }

    const nu = new Date().toISOString();
    const bijgewerkt = await bewaarVersie({
      db, drop, output, reden, userId: p.user.id,
      patch: { status: 'gegenereerd', format_key: output.format_key || drop.format_key || null, gegenereerd_op: nu, goedgekeurd_op: null },
    });

    const gebruikt = gebruikteAssetIds(output);
    if (gebruikt.length) {
      const { error: uErr } = await db.from('content_assets').update({ laatst_gebruikt_op: nu }).in('id', gebruikt);
      if (uErr) console.error('[contentmachine/genereer] laatst_gebruikt_op mislukt:', uErr.message);
    }
    return res.status(200).json({ ok: true, drop: bijgewerkt, waarschuwingen, model });
  } catch (e) {
    if (e?.code === 'ANTHROPIC_KEY_MISSING') return res.status(503).json({ error: 'ANTHROPIC_API_KEY niet geconfigureerd', code: e.code });
    if (e?.code === 'VERSIE_CONFLICT') return res.status(409).json({ error: e.message, code: e.code });
    if (String(e?.code || '').startsWith('ANTHROPIC_')) {
      console.error('[contentmachine/genereer] AI-fout:', e.code, e.status, e.message);
      return res.status(502).json({ error: 'De AI kon de drop niet maken: ' + (e.message || e.code), code: e.code });
    }
    return fout(res, 'contentmachine/genereer', e);
  }
}
