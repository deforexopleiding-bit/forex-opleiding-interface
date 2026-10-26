// api/contentmachine/drops.js
//
// Contentmachine (2026-10-23) — de wekelijkse drops.
//
// GET                    → { drops:[…] } nieuwste bovenaan (zonder output-inhoud)
// GET ?id=<uuid>         → { drop, assets:[…], versies:[…], captions? } (captions = social 2.0 per kanaal)
// POST { actie:'maak', datum:'YYYY-MM-DD' }          → nieuwe concept-drop (slug dd-mm-jj[-n])
// POST { actie:'bewaar', id, datum?, input }         → invoer bewaren (enkel concept/gegenereerd)
// POST { actie:'vimeo', url }                        → Vimeo oEmbed: titel, duur, thumbnail
// POST { actie:'archiveer', id } / { actie:'herstel', id }
// POST { actie:'bewaar-output', id, versie, output, reden? }  → bewerkte teksten als nieuwe versie
//      (een goedgekeurde drop gaat terug naar 'gegenereerd': opnieuw goedkeuren)
// POST { actie:'goedkeuren', id }      → enkel zonder grens-overtredingen (verboden woorden/namen)
// POST { actie:'publiceer', id }       → status 'gepubliceerd' (de website toont hem dan)
// POST { actie:'depubliceer', id }     → terug naar 'goedgekeurd'
// POST { actie:'versie-terug', id, versie } → de output van een oudere versie wordt de nieuwste
// POST { actie:'social', id, stijl, bestanden:{naam:{url,breedte,hoogte}} } → lijst van de in
//      Storage opgeslagen social-beelden in output.social (GEEN nieuwe versie: het zijn afgeleiden)
// GET  ?id=<uuid>&versie=<n>           → { versie } (output/input van die versie)
//
// Alleen service role na poort() (recht content.machine). De website leest
// gepubliceerde drops zelf (service-key, status = 'gepubliceerd').

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import {
  slugVanDatum, vrijeSlug, normaliseerInput, soortVanInput, parseVimeo, SOCIAL_NAAM_RE, socialPad, datumUitTitel,
} from '../_lib/contentmachine-core.js';
import { controleerGrenzen, valideerOutput, grensOpties, metVasteTeksten } from '../_lib/contentmachine-generator.js';
import { bewaarVersie, ASSET_KOLOMMEN as CTX_ASSET_KOLOMMEN } from '../_lib/contentmachine-opslag.js';
import { isWeekeditie, editieFouten, BLOKKEN } from '../_lib/weekeditie.js';
import { controleerCijfers } from '../_lib/feitenbank.js';
import { cijferBronnen } from '../_lib/contentmachine-regie.js';
import { captions, isSocialV2, socialGetallen } from '../_lib/contentmachine-social.js';

/**
 * Grens-overtredingen van een output (met de namenlijst van bij het genereren en
 * de weekdag van de training uit de invoer).
 */
export function grensProblemen(output, input) {
  if (!output) return [];
  const namen = (output.meta && Array.isArray(output.meta.verboden_namen)) ? output.meta.verboden_namen : [];
  const { meta, ...zonderMeta } = output;
  return controleerGrenzen(zonderMeta, grensOpties(input, namen));
}

const zelfde = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Weekeditie (2.0): wat goedkeuren blokkeert naast de grenzen — de editieregels (anders
 * laat de website blokken weg) en cijfers die niet in de feitenbank/invoer/beelden staan.
 */
export async function editieProblemen(db, drop) {
  const o = drop.output;
  if (!o || !isWeekeditie(o.pagina)) return [];
  const uit = editieFouten(o.pagina, { metVideo: !!(drop.input && drop.input.vimeo_id) }).map((x) => ({ pad: 'pagina', regel: x }));
  const { data: assets, error } = await db.from('content_assets').select(CTX_ASSET_KOLOMMEN).is('verwijderd_op', null).limit(2000);
  if (error) throw error;
  const relevant = (assets || []).filter((a) => !a.drop_id || a.drop_id === drop.id);
  const social = isSocialV2(o) ? socialGetallen(o).map((x) => ({ ...x, pad: 'social.' + x.pad })) : [];
  for (const c of controleerCijfers(o.pagina, cijferBronnen(drop.input || {}, relevant), social)) uit.push({ pad: c.pad.startsWith('social.') ? c.pad : 'pagina.' + c.pad, regel: `cijfer ${c.waarde} staat niet in de feitenbank, de invoer of op een beeld` });
  return uit;
}

const LIJST_KOLOMMEN = 'id,slug,datum,soort,status,format_key,versie,aangemaakt_op,gewijzigd_op,gegenereerd_op,goedgekeurd_op,gepubliceerd_op,input,kern:output->>kernidee,titel:output->pagina->>hero_titel,titel2:output->>titel,thema:output->pagina->>thema';
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
      training_datum: datumUitTitel(j.title),
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
    kernidee: d.kern || null, titel: d.titel || d.titel2 || null, weekeditie: !!d.thema, thema: d.thema || null,
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
      // De blokken van de Weekeditie (schema's van de website) voor de editor in het werkblad.
      if (req.query?.blokken) return res.status(200).json({ blokken: BLOKKEN });
      const id = String(req.query?.id || '');
      const versieNr = parseInt(req.query?.versie, 10);
      if (id && Number.isFinite(versieNr)) {
        const { data, error } = await db.from('content_drop_versies').select('*').eq('drop_id', id).eq('versie', versieNr).maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: 'Versie niet gevonden' });
        return res.status(200).json({ versie: data });
      }
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
        // Social 2.0: de captions per kanaal met de juiste link (afgeleid, niet bewaard).
        const extra = drop.output && isSocialV2(drop.output) ? { captions: captions(drop.output, drop.slug) } : {};
        return res.status(200).json({ drop, assets: a.data || [], versies: v.data || [], ...extra });
      }
      const { data, error } = await db.from('content_drops').select(LIJST_KOLOMMEN)
        .order('datum', { ascending: false }).order('aangemaakt_op', { ascending: false }).limit(200);
      if (error) throw error;
      const drops = (data || []).map(lijstRij);
      // Nieuwsbrief per drop (laatste GHL-verzending) — fail-soft.
      if (drops.length) {
        const { data: vz, error: vErr } = await db.from('nieuwsbrief_verzendingen').select('drop_id,status,stats,aangemaakt_op')
          .in('drop_id', drops.map((d) => d.id)).order('aangemaakt_op', { ascending: false });
        if (vErr) console.error('[contentmachine/drops] verzendingen lezen mislukt:', vErr.message);
        const per = {};
        for (const x of vz || []) if (!per[x.drop_id]) per[x.drop_id] = x;
        for (const d of drops) {
          const x = per[d.id];
          d.nieuwsbrief = x ? { status: x.status, stats: (x.stats && x.stats.laatste) || null } : null;
        }
      }
      return res.status(200).json({ drops });
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
    const { data: drop, error: dErr } = await db.from('content_drops').select('*').eq('id', id).maybeSingle();
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
      const status = actie === 'archiveer' ? 'gearchiveerd' : (drop.output ? 'gegenereerd' : 'concept');
      if (actie === 'herstel' && drop.status !== 'gearchiveerd') return res.status(409).json({ error: 'Alleen een gearchiveerde drop kan je herstellen.' });
      const { data, error } = await db.from('content_drops').update({ status, gewijzigd_op: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    if (actie === 'bewaar-output') {
      if (!['gegenereerd', 'goedgekeurd'].includes(drop.status) || !drop.output) return res.status(409).json({ error: 'Er is (nog) geen bewerkbare output.' });
      if (Number(b.versie) !== drop.versie) return res.status(409).json({ error: 'De drop werd intussen gewijzigd. Herlaad en probeer opnieuw.', code: 'VERSIE_CONFLICT' });
      const o = b.output;
      if (!o || typeof o !== 'object' || Array.isArray(o)) return res.status(400).json({ error: 'output ontbreekt' });
      // Structuur blijft die van de generator; meta en format komen van de server.
      // Het formulier op de pagina is vast (vasteFormulierTeksten).
      const vast = { format_key: drop.output.format_key, meta: drop.output.meta || {} };
      if (drop.output.regie) vast.regie = drop.output.regie;
      if (drop.output.versie) vast.versie = drop.output.versie;
      const output = metVasteTeksten({ ...o, ...vast }, { drop });
      if (isWeekeditie(output.pagina)) output.titel = String((output.pagina.blokken.find((x) => x && x.type === 'hero') || { props: {} }).props.titel || '').replace(/\*\*/g, '').trim();
      const v = valideerOutput(output, { toegelaten: [output.format_key], metVideo: !!(drop.input && drop.input.vimeo_id) });
      if (!v.ok) return res.status(400).json({ error: 'De output klopt niet meer: ' + v.fouten.slice(0, 3).join('; ') });
      const grens = grensProblemen(output, drop.input).map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment }));
      output.meta = { ...output.meta, waarschuwingen: [...(output.meta.waarschuwingen || []).filter((w) => w.soort !== 'grens'), ...grens] };
      const bijgewerkt = await bewaarVersie({ db, drop, output, reden: String(b.reden || 'Teksten bewerkt'), userId: p.user.id, patch: { status: 'gegenereerd', goedgekeurd_op: null } });
      return res.status(200).json({ ok: true, drop: bijgewerkt });
    }

    if (actie === 'goedkeuren') {
      if (drop.status !== 'gegenereerd' || !drop.output) return res.status(409).json({ error: 'Alleen een gegenereerde drop kan je goedkeuren.' });
      const problemen = [...grensProblemen(drop.output, drop.input), ...await editieProblemen(db, drop)];
      if (problemen.length) return res.status(409).json({ error: 'Eerst deze teksten aanpassen: ' + problemen.slice(0, 3).map((x) => `${x.pad} (${x.regel})`).join('; '), code: 'GRENZEN', problemen });
      // Oudere drops: de vaste formulierteksten erin zetten (als nieuwe versie).
      const vast = metVasteTeksten(drop.output, { drop });
      if (!zelfde(vast, drop.output)) {
        const nu = new Date().toISOString();
        const bijgewerkt = await bewaarVersie({ db, drop, output: vast, reden: 'Vaste formulierteksten bij goedkeuren', userId: p.user.id, patch: { status: 'goedgekeurd', goedgekeurd_op: nu } });
        return res.status(200).json({ ok: true, drop: bijgewerkt });
      }
      const { data, error } = await db.from('content_drops').update({ status: 'goedgekeurd', goedgekeurd_op: new Date().toISOString(), gewijzigd_op: new Date().toISOString() }).eq('id', id).eq('versie', drop.versie).select('*');
      if (error) throw error;
      if (!data || !data.length) return res.status(409).json({ error: 'De drop werd intussen gewijzigd. Herlaad.', code: 'VERSIE_CONFLICT' });
      return res.status(200).json({ ok: true, drop: data[0] });
    }

    if (actie === 'publiceer') {
      if (drop.status !== 'goedgekeurd') return res.status(409).json({ error: 'Keur de drop eerst goed.' });
      if (grensProblemen(drop.output, drop.input).length || (await editieProblemen(db, drop)).length) return res.status(409).json({ error: 'Er staan nog teksten of blokken in die niet mogen.', code: 'GRENZEN' });
      const kanalen = (drop.input && drop.input.kanalen) || [];
      if (kanalen.length && !kanalen.includes('pagina')) return res.status(409).json({ error: 'Het kanaal Pagina staat uit voor deze drop.' });
      const nu = new Date().toISOString();
      const { data, error } = await db.from('content_drops').update({ status: 'gepubliceerd', gepubliceerd_op: nu, gewijzigd_op: nu }).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    if (actie === 'depubliceer') {
      if (drop.status !== 'gepubliceerd') return res.status(409).json({ error: 'Deze drop staat niet online.' });
      const { data, error } = await db.from('content_drops').update({ status: 'goedgekeurd', gewijzigd_op: new Date().toISOString() }).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, drop: data });
    }

    if (actie === 'social') {
      if (!drop.output) return res.status(409).json({ error: 'Deze drop heeft nog geen output.' });
      const bestanden = {};
      for (const [naam, v] of Object.entries(b.bestanden && typeof b.bestanden === 'object' ? b.bestanden : {})) {
        if (!SOCIAL_NAAM_RE.test(naam) || !v || typeof v.url !== 'string') continue;
        // Enkel onze eigen Storage-URL van precies dit pad.
        const pad = socialPad(drop.slug, naam);
        const echt = pad && db.storage.from('content').getPublicUrl(pad).data?.publicUrl;
        if (!echt || v.url.split('?')[0] !== echt) continue;
        bestanden[naam] = { url: v.url.slice(0, 600), breedte: Number(v.breedte) || null, hoogte: Number(v.hoogte) || null };
      }
      if (!Object.keys(bestanden).length) return res.status(400).json({ error: 'Geen geldige bestanden.' });
      // samenvoegen: enkel deze bestanden bijwerken (bv. het mailbeeld). Anders vervangt de social-set
      // alles, behalve het mailbeeld (dat hoort bij de nieuwsbrief, niet bij de social-set).
      const oud = (drop.output.social && drop.output.social.bestanden) || {};
      const behoud = b.samenvoegen === true ? oud : (oud.nieuwsbrief ? { nieuwsbrief: oud.nieuwsbrief } : {});
      const vorigeStijl = drop.output.social && Number.isInteger(drop.output.social.stijl) ? drop.output.social.stijl : 0;
      const social = { ...(drop.output.social || {}), stijl: Number.isInteger(b.stijl) ? b.stijl % 3 : vorigeStijl, bestanden: { ...behoud, ...bestanden }, opgeslagen_op: new Date().toISOString() };
      const { data, error } = await db.from('content_drops').update({ output: { ...drop.output, social } }).eq('id', id).select('id').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, social, id: data.id });
    }

    if (actie === 'versie-terug') {
      if (!['gegenereerd', 'goedgekeurd'].includes(drop.status)) return res.status(409).json({ error: 'Enkel bij een gegenereerde of goedgekeurde drop.' });
      const nr = parseInt(b.versie, 10);
      const { data: oud, error: vErr } = await db.from('content_drop_versies').select('versie,output').eq('drop_id', id).eq('versie', nr).maybeSingle();
      if (vErr) throw vErr;
      if (!oud || !oud.output) return res.status(404).json({ error: 'Die versie heeft geen output.' });
      const bijgewerkt = await bewaarVersie({ db, drop, output: oud.output, reden: `Teruggezet naar versie ${nr}`, userId: p.user.id, patch: { status: 'gegenereerd', goedgekeurd_op: null, format_key: oud.output.format_key || drop.format_key } });
      return res.status(200).json({ ok: true, drop: bijgewerkt });
    }

    return res.status(400).json({ error: 'Onbekende actie' });
  } catch (e) {
    if (e?.code === 'VERSIE_CONFLICT') return res.status(409).json({ error: e.message, code: e.code });
    return fout(res, 'contentmachine/drops', e);
  }
}
