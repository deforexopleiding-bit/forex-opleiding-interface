// api/contentmachine/genereer.js
//
// Contentmachine — POST /api/contentmachine/genereer
//   { id }                              → volledige Weekeditie genereren (2.0: regisseur → schrijver:
//                                         pagina met blokken, nieuwsbrief, stories, post + vierkant, LinkedIn)
//   { id, onderdeel, instructie? }      → één onderdeel opnieuw (pagina | nieuwsbrief | stories |
//                                         post | linkedin), bv. instructie "korter"
//   { id, blok: { index, type?, instructie? } }
//                                       → één blok van de pagina opnieuw schrijven (type leeg) of een
//                                         NIEUW blok van `type` invoegen op `index`
//
// Bewaart het resultaat als NIEUWE versie (content_drop_versies) en zet de status op
// 'gegenereerd' (een goedgekeurde drop moet na hergenereren opnieuw goedgekeurd worden).
// Er wordt NIETS gepubliceerd of verstuurd.
//
// Duur: regisseur + schrijver (~1-3 min) + eventueel herstelrondes → maxDuration 300 in vercel.json.

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import {
  genereerOnderdeel, toegelatenFormats, gebruikteAssetIds, ONDERDELEN, controleerGrenzen, grensOpties,
} from '../_lib/contentmachine-generator.js';
import { genereerEditie, schrijf, schrijfBlok, valideerV2 } from '../_lib/contentmachine-regie.js';
import { BLOK_TYPES, isWeekeditie, editieTitel } from '../_lib/weekeditie.js';
import { laadContext, bewaarVersie } from '../_lib/contentmachine-opslag.js';
import { paginaUrl } from '../_lib/nieuwsbrief-render.js';

export const BEWERKBAAR = ['concept', 'gegenereerd', 'goedgekeurd'];

const grensWaarschuwingen = (o, input, namen) => controleerGrenzen(o, grensOpties(input, namen))
  .map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment }));

/** Waarschuwingen na een gedeeltelijke wijziging opnieuw opbouwen (schema/cijfers/grenzen van de hele editie). */
function herbereken(output, { input, ctx, metVideo, behoud = [] }) {
  const { meta, regie, ...zonder } = output;
  void meta; void regie;
  const v = isWeekeditie(output.pagina) ? valideerV2(output, { metVideo, assets: ctx.alleAssets, vorige: ctx.vorige, input }) : { fouten: [], cijfers: [] };
  return [
    ...behoud,
    ...v.fouten.map((x) => ({ soort: 'schema', tekst: x })),
    ...v.cijfers.map((c) => ({ soort: 'cijfer', tekst: `${c.pad}: ${c.waarde} staat niet in de feitenbank/invoer` })),
    ...grensWaarschuwingen(zonder, input, ctx.verbodenNamen),
  ];
}

export default async function handler(req, res) {
  const p = await poort(req, res, { methodes: ['POST'] });
  if (!p) return;
  const db = supabaseAdmin;
  const b = body(req);
  const id = String(b.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
  const onderdeel = b.onderdeel ? String(b.onderdeel) : null;
  if (onderdeel && !ONDERDELEN.includes(onderdeel)) return res.status(400).json({ error: 'Onbekend onderdeel' });
  const blokOpdracht = b.blok && typeof b.blok === 'object' ? b.blok : null;
  if (blokOpdracht) {
    if (!Number.isInteger(blokOpdracht.index) || blokOpdracht.index < 0 || blokOpdracht.index > 20) return res.status(400).json({ error: 'blok.index ontbreekt' });
    if (blokOpdracht.type != null && !BLOK_TYPES.includes(String(blokOpdracht.type))) return res.status(400).json({ error: 'Onbekend bloktype' });
  }
  const instructie = String((blokOpdracht && blokOpdracht.instructie) || b.instructie || '').trim().slice(0, 500);

  try {
    const { data: drop, error } = await db.from('content_drops').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
    if (!BEWERKBAAR.includes(drop.status)) return res.status(409).json({ error: 'Een gepubliceerde of gearchiveerde drop genereer je niet opnieuw.' });
    if ((onderdeel || blokOpdracht) && !drop.output) return res.status(409).json({ error: 'Genereer eerst de volledige drop.' });
    if (blokOpdracht && !isWeekeditie(drop.output.pagina)) return res.status(409).json({ error: 'Blokken bestaan enkel in een Weekeditie (genereer de drop opnieuw).' });
    const i = drop.input || {};
    if (!String(i.wat_gebeurde || '').trim() && !i.vimeo_id) {
      const { data: eigen } = await db.from('content_assets').select('id').eq('drop_id', id).is('verwijderd_op', null).limit(1);
      if (!eigen || !eigen.length) return res.status(400).json({ error: 'Vul minstens in wat er deze week gebeurde, een Vimeo-link of een foto.' });
    }

    const ctx = await laadContext({ db, drop, v2: true });
    const toegelaten = toegelatenFormats(ctx.vorige);
    const metVideo = !!i.vimeo_id;
    const basis = {
      drop, input: i, beelden: ctx.beelden, vorige: ctx.vorige, toegelaten, assetIds: ctx.alleAssets.map((a) => a.id),
      assets: ctx.alleAssets, verbodenNamen: ctx.verbodenNamen, paginaUrl: paginaUrl(drop.slug),
    };
    const vorigeMeta = (drop.output && drop.output.meta) || {};

    let output; let reden; let model; let waarschuwingen = [];
    if (blokOpdracht) {
      const huidige = drop.output;
      const r = await schrijfBlok(basis, { huidige, index: blokOpdracht.index, type: blokOpdracht.type || null, instructie });
      model = r.model;
      if (!r.blok || r.fouten.length) {
        return res.status(422).json({ error: 'Het blok voldeed niet aan de regels: ' + (r.fouten.slice(0, 3).join('; ') || 'leeg'), fouten: r.fouten });
      }
      const blokken = huidige.pagina.blokken.slice();
      if (blokOpdracht.type) blokken.splice(Math.min(blokOpdracht.index, blokken.length), 0, r.blok);
      else blokken[blokOpdracht.index] = r.blok;
      const pagina = { ...huidige.pagina, blokken };
      output = { ...huidige, pagina, titel: editieTitel(pagina) };
      waarschuwingen = herbereken(output, { input: i, ctx, metVideo, behoud: (vorigeMeta.waarschuwingen || []).filter((w) => !['schema', 'cijfer', 'grens'].includes(w.soort)) });
      output.meta = { ...vorigeMeta, model, waarschuwingen, laatst_onderdeel: { onderdeel: 'blok', blok: r.blok.type, index: blokOpdracht.index, nieuw: !!blokOpdracht.type, instructie: instructie || null, op: new Date().toISOString() } };
      reden = (blokOpdracht.type ? `Blok ${r.blok.type} toegevoegd` : `Blok ${blokOpdracht.index + 1} (${r.blok.type}) opnieuw geschreven`) + (instructie ? ` — ${instructie}` : '');
    } else if (!onderdeel) {
      const r = await genereerEditie(basis);
      model = r.model;
      waarschuwingen = r.waarschuwingen;
      output = { ...r.output, meta: { model, herstel: r.herstel, duur_ms: r.duur_ms, gegenereerd_op: new Date().toISOString(), toegelaten_formats: toegelaten, beelden: ctx.beelden.map((a) => a.id), verboden_namen: ctx.verbodenNamen, waarschuwingen } };
      reden = 'Weekeditie gegenereerd' + (instructie ? ` — ${instructie}` : '');
    } else if (onderdeel === 'pagina' && isWeekeditie(drop.output.pagina) && drop.output.regie) {
      const r = await schrijf(basis, drop.output.regie, { onderdelen: ['pagina'], huidige: drop.output, instructie });
      model = r.model;
      output = { ...drop.output, ...r.output };
      waarschuwingen = herbereken(output, { input: i, ctx, metVideo, behoud: (vorigeMeta.waarschuwingen || []).filter((w) => !['schema', 'cijfer', 'grens'].includes(w.soort)) });
      output.meta = { ...vorigeMeta, model, waarschuwingen, laatst_onderdeel: { onderdeel, instructie: instructie || null, op: new Date().toISOString() } };
      reden = 'pagina opnieuw geschreven' + (instructie ? ` — ${instructie}` : '');
    } else {
      const r = await genereerOnderdeel({ ...basis, onderdeel, huidige: drop.output, instructie });
      model = r.model;
      const samen = { ...drop.output, ...r.deel };
      // Waarschuwingen opnieuw opbouwen: oude van dit onderdeel weg, nieuwe erbij.
      const grens = grensWaarschuwingen((({ meta, regie, ...x }) => { void meta; void regie; return x; })(samen), i, ctx.verbodenNamen);
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

    const gebruikt = gebruikteAssetIds((({ regie, meta, ...x }) => { void regie; void meta; return x; })(output));
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
