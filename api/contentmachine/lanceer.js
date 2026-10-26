// api/contentmachine/lanceer.js
//
// Contentmachine 2.0, fase 5 — "Keur goed en lanceer" (één flow, super_admin).
//
// GET  ?id=<uuid>                       → { voorwaarden, test, lancering, beelden, instellingen, ghl, captions? }
// POST { actie:'test', id, onderwerp }  → testmail van DEZE versie naar de ingelogde gebruiker (via GHL)
// POST { actie:'lanceer', id, modus:'nu'|'ingepland', ingepland_op?, onderwerp, doelgroep:'tag'|'alle', bevestiging? }   (super_admin)
//        doelgroep 'alle' = alle contacten van de GHL-location (zoals de huidige nieuwsbrief), enkel met bevestiging 'VERSTUUR'
// POST { actie:'ontvangers', doelgroep:'tag'|'alle' } → verwacht aantal ontvangers { totaal, zonder_dnd }
//        1. goedkeuren (grenzen/editieregels/cijfers) → 2. pagina gepubliceerd
//        3. nieuwsbrief: workflow bestaat? → (nu) vaste template + onderwerp bijwerken en de
//           verzendtag zetten in batches (rest via de cron) · (ingepland) de cron doet dat op tijd
// POST { actie:'controleer-pagina', id } → training.deforexopleiding.nl/<slug> 200 + juiste titel (± 25 s per oproep)
// POST { actie:'annuleer', id }          → lopende/ingeplande lancering stoppen (super_admin)
// POST { actie:'ghl-check' }             → template, onderwerp, workflow, tags + kandidaten voor de lijst (super_admin)
// POST { actie:'ghl-instellen' }         → vaste template "DFO Weekeditie (actueel)" + custom value aanmaken (super_admin)
// POST { actie:'instellingen', doelgroep_tag?, verzend_tag?, workflow_naam? } (super_admin)
//
// Het CRM verstuurt zelf NOOIT naar de lijst: het zet enkel de tag waarop de GHL-workflow
// "DFO Weekeditie versturen" de mail stuurt (en de tag weer weghaalt).

import { supabaseAdmin } from '../supabase.js';
import { poort, fout, body } from '../_lib/contentmachine-http.js';
import { grensProblemen, editieProblemen } from './drops.js';
import { laadVoorNieuwsbrief, uitschrijfTag } from './nieuwsbrief.js';
import { renderNieuwsbrief } from '../_lib/nieuwsbrief-render.js';
import { metVasteTeksten } from '../_lib/contentmachine-generator.js';
import { ghlNieuwsbriefConfig, ghlLinks, maakTemplate, vulTemplate, eigenContact, stuurTestmail } from '../_lib/ghl-nieuwsbrief.js';
import { zoekWorkflow, zetOnderwerp, tagsVanLocatie, telTag, telOntvangers, nieuwsbriefKandidaten, STANDAARD, ALLE_CONTACTEN } from '../_lib/ghl-weekeditie.js';
import {
  leesInstellingen, bewaarInstellingen, geldigeTag, kanalenVan, beeldenCheck, voorwaarden, laatsteTest, laatsteLancering,
  paginaCheck, verwachteTitel, verwerkLancering, LANCERING_KOLOMMEN,
} from '../_lib/weekeditie-lancering.js';
import { captions, isSocialV2 } from '../_lib/contentmachine-social.js';

export const INLINE_BUDGET_MS = 35000;
const zelfde = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** De mail renderen zoals hij naar GHL gaat. */
export async function mailVan(db, drop, onderwerpIndex) {
  const { assets } = await laadVoorNieuwsbrief(db, drop.id);
  return renderNieuwsbrief({ drop, output: drop.output, assets, onderwerpIndex, uitschrijfLink: uitschrijfTag() });
}

/** Vaste template + onderwerp bijwerken met deze drop (vlak vóór het taggen). */
export async function bereidGhlVoor(db, cfg, drop, lancering, inst, fetchImpl) {
  const r = await mailVan(db, drop, lancering.onderwerp_index || 0);
  if (r.beeld === false) throw Object.assign(new Error('Het mailbeeld ontbreekt (tab Nieuwsbrief → Beeld voor de mail).'), { code: 'BEELD_ONTBREEKT', publiek: 'Het mailbeeld ontbreekt.' });
  await vulTemplate(cfg, { templateId: inst.template_id, html: r.html, previewText: r.preheader }, fetchImpl);
  const cv = await zetOnderwerp(cfg, { id: inst.custom_value_id || null, naam: inst.custom_value_naam || STANDAARD.custom_value_naam, waarde: r.onderwerp }, fetchImpl);
  if (cv.id && cv.id !== inst.custom_value_id) await bewaarInstellingen(db, { custom_value_id: cv.id, custom_value_sleutel: cv.sleutel }, null);
  return { onderwerp: r.onderwerp };
}

async function laadDrop(db, id) {
  const { data, error } = await db.from('content_drops').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

export default async function handler(req, res) {
  const p = await poort(req, res, { methodes: ['GET', 'POST'] });
  if (!p) return;
  const db = supabaseAdmin;
  const b = req.method === 'POST' ? body(req) : {};
  const actie = req.method === 'POST' ? String(b.actie || '') : 'status';
  const id = String((req.method === 'POST' ? b.id : (req.query || {}).id) || '');
  const superAdmin = p.profiel && p.profiel.role === 'super_admin';
  const cfg = ghlNieuwsbriefConfig();
  const ACTIES = ['status', 'test', 'lanceer', 'controleer-pagina', 'annuleer', 'ghl-check', 'ghl-instellen', 'instellingen', 'ontvangers'];
  if (!ACTIES.includes(actie)) return res.status(400).json({ error: 'Onbekende actie' });
  const ZONDER_DROP = ['ghl-check', 'ghl-instellen', 'instellingen', 'ontvangers'];
  if (!ZONDER_DROP.includes(actie) && !/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'id ontbreekt' });
  if (['lanceer', 'annuleer', 'ghl-check', 'ghl-instellen', 'instellingen'].includes(actie) && !superAdmin) return res.status(403).json({ error: 'Enkel een super_admin kan lanceren en GHL instellen.', code: 'GEEN_SUPER_ADMIN' });

  try {
    const inst = await leesInstellingen(db);

    // ── GHL instellen / controleren (zonder drop) ────────────────────────────
    if (actie === 'instellingen') {
      const patch = {};
      for (const k of ['doelgroep_tag', 'verzend_tag']) if (b[k] != null) { if (!geldigeTag(String(b[k]))) return res.status(400).json({ error: `Ongeldige tag: ${b[k]}` }); patch[k] = String(b[k]).trim(); }
      if (b.workflow_naam != null) patch.workflow_naam = String(b.workflow_naam).trim().slice(0, 120);
      if (patch.doelgroep_tag && patch.verzend_tag && patch.doelgroep_tag === patch.verzend_tag) return res.status(400).json({ error: 'Doelgroep-tag en verzendtag moeten verschillen.' });
      return res.status(200).json({ ok: true, instellingen: await bewaarInstellingen(db, patch, p.user.id) });
    }
    if (actie === 'ontvangers') {
      if (!cfg.ok) return res.status(503).json({ error: `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')})`, code: 'GHL_NIET_GEKOPPELD' });
      const alle = b.doelgroep === 'alle';
      const r = await telOntvangers(cfg, alle ? ALLE_CONTACTEN : inst.doelgroep_tag);
      return res.status(200).json({ ok: true, doelgroep: alle ? 'alle' : 'tag', tag: alle ? null : inst.doelgroep_tag, ...r });
    }
    if (actie === 'ghl-instellen' || actie === 'ghl-check') {
      if (!cfg.ok) return res.status(503).json({ error: `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')})`, code: 'GHL_NIET_GEKOPPELD' });
      let i = inst;
      if (actie === 'ghl-instellen') {
        const patch = {};
        if (!i.template_id) patch.template_id = await maakTemplate(cfg, { naam: i.template_naam });
        const cv = await zetOnderwerp(cfg, { id: i.custom_value_id || null, naam: i.custom_value_naam, waarde: 'De Weekeditie van De Forex Opleiding' });
        patch.custom_value_id = cv.id; patch.custom_value_sleutel = cv.sleutel;
        i = await bewaarInstellingen(db, patch, p.user.id);
      }
      const rapport = { instellingen: i, links: ghlLinks(cfg.locationId) };
      const stap = async (k, f) => { try { rapport[k] = await f(); } catch (e) { rapport[k] = { fout: e.message }; } };
      await stap('workflow', async () => (await zoekWorkflow(cfg, i.workflow_naam)) || { ontbreekt: true });
      await stap('tags', async () => {
        const alle = await tagsVanLocatie(cfg);
        const kand = nieuwsbriefKandidaten(alle).slice(0, 8);
        const tellingen = [];
        for (const t of [...new Set([i.doelgroep_tag, ...kand])]) { try { tellingen.push({ tag: t, contacten: await telTag(cfg, t), bestaat: alle.map((x) => x.toLowerCase()).includes(t.toLowerCase()) }); } catch (e) { tellingen.push({ tag: t, fout: e.message }); } }
        return { aantal: alle.length, kandidaten: tellingen, verzendtag_bestaat: alle.map((x) => x.toLowerCase()).includes(String(i.verzend_tag).toLowerCase()) };
      });
      return res.status(200).json({ ok: true, rapport });
    }

    const drop = await laadDrop(db, id);
    if (!drop) return res.status(404).json({ error: 'Drop niet gevonden' });
    const kanalen = kanalenVan(drop);

    if (actie === 'status') {
      const [test, lancering, problemen] = await Promise.all([laatsteTest(db, drop), laatsteLancering(db, drop.id), drop.output ? Promise.all([grensProblemen(drop.output, drop.input), editieProblemen(db, drop)]).then(([a, c]) => [...a, ...c]) : []]);
      const beelden = beeldenCheck(drop.output, kanalen);
      return res.status(200).json({
        ok: true, test, lancering, beelden, kanalen: [...kanalen],
        voorwaarden: voorwaarden({ drop, problemen, test, cfg, instellingen: inst, beelden, kanalen, rol: p.profiel && p.profiel.role }),
        instellingen: { template_naam: inst.template_naam, template_id: inst.template_id || null, workflow_naam: inst.workflow_naam, doelgroep_tag: inst.doelgroep_tag, verzend_tag: inst.verzend_tag, custom_value_sleutel: inst.custom_value_sleutel || null },
        ghl: { gekoppeld: cfg.ok, ontbreekt: cfg.ontbreekt, links: cfg.ok ? ghlLinks(cfg.locationId) : null },
        super_admin: superAdmin,
        ...(isSocialV2(drop.output) ? { captions: captions(drop.output, drop.slug) } : {}),
      });
    }

    if (actie === 'test') {
      if (!cfg.ok) return res.status(503).json({ error: `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')})`, code: 'GHL_NIET_GEKOPPELD' });
      if (!drop.output || !drop.output.nieuwsbrief) return res.status(409).json({ error: 'Deze drop heeft nog geen nieuwsbrief.' });
      const idx = Math.max(0, Math.min(2, parseInt(b.onderwerp, 10) || 0));
      const r = await mailVan(db, drop, idx);
      if (r.beeld === false) return res.status(409).json({ error: 'Render eerst het beeld voor de mail (tab Nieuwsbrief → Beeld voor de mail).', code: 'BEELD_ONTBREEKT' });
      const email = String((p.profiel && p.profiel.email) || p.user.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'Je account heeft geen e-mailadres.' });
      const contactId = await eigenContact(cfg, { email, naam: (p.profiel && p.profiel.full_name) || null });
      await stuurTestmail(cfg, { contactId, email, onderwerp: r.onderwerp, html: r.html });
      const { data, error } = await db.from('weekeditie_testmails').insert({ drop_id: drop.id, drop_versie: drop.versie, onderwerp_index: idx, email, verstuurd_door: p.user.id }).select('id,drop_versie,onderwerp_index,email,verstuurd_op').single();
      if (error) throw error;
      return res.status(200).json({ ok: true, naar: email, test: data });
    }

    if (actie === 'annuleer') {
      const l = await laatsteLancering(db, drop.id);
      if (!l || !['ingepland', 'taggen'].includes(l.status)) return res.status(409).json({ error: 'Er loopt geen lancering voor deze drop.' });
      const { data, error } = await db.from('weekeditie_lanceringen').update({ status: 'geannuleerd', gewijzigd_op: new Date().toISOString(), fout: `Geannuleerd door ${(p.profiel && p.profiel.email) || p.user.id}` }).eq('id', l.id).select(LANCERING_KOLOMMEN).single();
      if (error) throw error;
      return res.status(200).json({ ok: true, lancering: data });
    }

    if (actie === 'controleer-pagina') {
      if (drop.status !== 'gepubliceerd') return res.status(409).json({ error: 'De pagina is nog niet gepubliceerd.' });
      const check = await paginaCheck({ slug: drop.slug, verwacht: verwachteTitel(drop.output), maxMs: 25000 });
      const l = await laatsteLancering(db, drop.id);
      if (l) {
        const { error } = await db.from('weekeditie_lanceringen').update({ pagina_check: check, gewijzigd_op: new Date().toISOString() }).eq('id', l.id);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true, check });
    }

    // ── lanceer ─────────────────────────────────────────────────────────────
    const modus = b.modus === 'ingepland' ? 'ingepland' : 'nu';
    let ingeplandOp = null;
    if (modus === 'ingepland') {
      const t = new Date(String(b.ingepland_op || ''));
      if (!Number.isFinite(t.getTime()) || t.getTime() < Date.now() + 60000) return res.status(400).json({ error: 'Kies een tijdstip in de toekomst (minstens 1 minuut).' });
      if (t.getTime() > Date.now() + 14 * 864e5) return res.status(400).json({ error: 'Inplannen kan tot 14 dagen vooruit.' });
      ingeplandOp = t.toISOString();
    }
    const idx = Math.max(0, Math.min(2, parseInt(b.onderwerp, 10) || 0));
    const alleContacten = b.doelgroep === 'alle';
    if (alleContacten && b.bevestiging !== 'VERSTUUR') return res.status(400).json({ error: 'Naar alle contacten versturen vraagt een extra bevestiging: typ VERSTUUR.', code: 'BEVESTIGING_NODIG' });
    if (!['gegenereerd', 'goedgekeurd', 'gepubliceerd'].includes(drop.status) || !drop.output) return res.status(409).json({ error: 'Enkel een gegenereerde drop kan je lanceren.' });
    const problemen = [...grensProblemen(drop.output, drop.input), ...await editieProblemen(db, drop)];
    if (problemen.length) return res.status(409).json({ error: 'Eerst deze teksten aanpassen: ' + problemen.slice(0, 3).map((x) => `${x.pad} (${x.regel})`).join('; '), code: 'GRENZEN', problemen });
    if (!zelfde(metVasteTeksten(drop.output, { drop }), drop.output)) return res.status(409).json({ error: 'Deze (oudere) drop mist de vaste formulierteksten: keur hem eerst apart goed.', code: 'VASTE_TEKSTEN' });
    const beelden = beeldenCheck(drop.output, kanalen);
    if (!beelden.ok) return res.status(409).json({ error: `Nog niet in Storage: ${beelden.ontbreekt.join(', ')}. Render en bewaar de beelden.`, code: 'BEELDEN_ONTBREKEN', beelden });
    const metMail = kanalen.has('nieuwsbrief');
    const actief = await laatsteLancering(db, drop.id);
    if (actief && ['ingepland', 'taggen'].includes(actief.status)) return res.status(409).json({ error: 'Er loopt al een lancering voor deze drop.', code: 'LOOPT_AL', lancering: actief });
    if (actief && actief.status === 'klaar' && actief.totaal) return res.status(409).json({ error: 'Deze drop is al naar de lijst gestuurd.', code: 'AL_VERSTUURD', lancering: actief });

    if (metMail) {
      if (!cfg.ok) return res.status(503).json({ error: `GHL niet gekoppeld (ontbreekt: ${cfg.ontbreekt.join(', ')})`, code: 'GHL_NIET_GEKOPPELD' });
      if (!inst.template_id) return res.status(409).json({ error: 'De vaste GHL-template is nog niet ingesteld (GHL controleren / instellen).', code: 'GEEN_TEMPLATE' });
      const test = await laatsteTest(db, drop);
      if (!test) return res.status(409).json({ error: `Stuur eerst een testmail van deze versie (v${drop.versie}) naar jezelf.`, code: 'GEEN_TEST' });
      const wf = await zoekWorkflow(cfg, inst.workflow_naam);
      if (!wf) return res.status(409).json({ error: `De GHL-workflow "${inst.workflow_naam}" bestaat nog niet. Zonder workflow gaat er geen mail uit.`, code: 'GEEN_WORKFLOW' });
      if (wf.status && !/publish|active/i.test(wf.status)) return res.status(409).json({ error: `De GHL-workflow "${inst.workflow_naam}" staat op ${wf.status} (niet gepubliceerd).`, code: 'WORKFLOW_NIET_ACTIEF' });
      const { data: lopend, error: lErr } = await db.from('weekeditie_lanceringen').select('id,drop_id').eq('status', 'taggen').limit(1);
      if (lErr) throw lErr;
      if (modus === 'nu' && lopend && lopend.length) return res.status(409).json({ error: 'Er wordt al een andere editie verstuurd. Probeer het straks opnieuw of plan in.', code: 'ANDERE_LOOPT' });
    }

    // goedkeuren + publiceren
    const nu = new Date().toISOString();
    const patch = { gewijzigd_op: nu };
    if (drop.status === 'gegenereerd') patch.goedgekeurd_op = nu;
    if (kanalen.has('pagina') && drop.status !== 'gepubliceerd') { patch.status = 'gepubliceerd'; patch.gepubliceerd_op = nu; } else if (drop.status === 'gegenereerd') patch.status = 'goedgekeurd';
    const { data: upd, error: uErr } = await db.from('content_drops').update(patch).eq('id', drop.id).eq('versie', drop.versie).select('*');
    if (uErr) throw uErr;
    if (!upd || !upd.length) return res.status(409).json({ error: 'De drop werd intussen gewijzigd. Herlaad.', code: 'VERSIE_CONFLICT' });
    const bijgewerkt = upd[0];

    const rij = {
      drop_id: drop.id, drop_versie: drop.versie, modus, ingepland_op: ingeplandOp || nu, onderwerp_index: idx,
      doelgroep_tag: alleContacten ? ALLE_CONTACTEN : inst.doelgroep_tag, verzend_tag: inst.verzend_tag, template_id: inst.template_id || null, aangemaakt_door: p.user.id,
      status: metMail ? 'ingepland' : 'klaar', totaal: metMail ? null : 0, ...(metMail ? {} : { klaar_op: nu, fout: 'Kanaal nieuwsbrief staat uit.' }),
    };
    const { data: lancering, error: iErr } = await db.from('weekeditie_lanceringen').insert(rij).select(LANCERING_KOLOMMEN).single();
    if (iErr) {
      if (String(iErr.code) === '23505') return res.status(409).json({ error: 'Er loopt al een lancering voor deze drop.', code: 'LOOPT_AL' });
      throw iErr;
    }
    let l = lancering;
    if (metMail && modus === 'nu') {
      try {
        const v = await bereidGhlVoor(db, cfg, bijgewerkt, l, inst);
        const { data, error } = await db.from('weekeditie_lanceringen').update({ onderwerp: v.onderwerp, status: 'taggen', gestart_op: new Date().toISOString(), gewijzigd_op: new Date().toISOString() }).eq('id', l.id).select(LANCERING_KOLOMMEN).single();
        if (error) throw error;
        l = await verwerkLancering(db, cfg, data, { deadline: Date.now() + INLINE_BUDGET_MS });
      } catch (e) {
        console.error('[contentmachine/lanceer] versturen starten mislukt:', e?.code || '', e?.message || e);
        // Nog niets getagd → mislukt markeren (de pagina blijft online); al bezig → de cron gaat verder.
        if (!l.getagd) {
          const { data } = await db.from('weekeditie_lanceringen').update({ status: 'mislukt', fout: String(e?.message || e).slice(0, 500), gewijzigd_op: new Date().toISOString() }).eq('id', l.id).select(LANCERING_KOLOMMEN).single();
          return res.status(502).json({ error: 'De pagina staat online, maar de nieuwsbrief kon niet starten: ' + (e?.message || e), code: e?.code || 'GHL_API', drop: bijgewerkt, lancering: data || l });
        }
      }
    }
    return res.status(200).json({ ok: true, drop: bijgewerkt, lancering: l });
  } catch (e) {
    if (e?.code && String(e.code).startsWith('GHL_')) return res.status(502).json({ error: e.message, code: e.code });
    return fout(res, 'contentmachine/lanceer', e);
  }
}
