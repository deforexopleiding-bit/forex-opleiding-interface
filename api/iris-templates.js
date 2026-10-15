// api/iris-templates.js
//
// De vier templates die Iris mist, indienen bij 360dialog — vanuit het scherm,
// zonder terminal en zonder dat iemand tekst overtypt.
//
// ── WAAROM DIT NIEUW IS ──────────────────────────────────────────────────────
// Er was geen weg. api/admin-meta-templates-submit.js en -sync.js praten met
// graph.facebook.com en gebruiken META_WHATSAPP_ACCESS_TOKEN; sinds 5 oktober
// is die WABA geblokkeerd en loopt alles via 360dialog. Die endpoints geven dus
// een Meta-fout, en die leest als een probleem met de template in plaats van
// met het pad. De enige werkende weg was scripts/360-templates-upload.mjs: een
// terminal met de servicesleutel in een --env-file.
//
// ── DRIE AANROEPEN ───────────────────────────────────────────────────────────
//   GET                             overzicht: per wens de stand bij ons én bij
//                                   360dialog. Schrijft NIETS.
//   POST { actie:'indienen' }       dient in wat er nog niet staat.
//   POST { actie:'status_vernieuwen' }
//                                   haalt de standen op en zet ze in onze rijen.
//
// ── WAAROM "STATUS VERNIEUWEN" ECHT SCHRIJFT ─────────────────────────────────
// Iris leest whatsapp_meta_templates.status en verstuurt alleen bij APPROVED
// (api/_lib/iris/templates.js). Staat een template bij 360dialog op APPROVED
// en bij ons nog op SUBMITTED, dan laat Iris hem liggen en valt ze terug op
// mail. Het overzicht alleen tónen is dus niet genoeg; de stand moet in de rij.
//
// ── IDEMPOTENT, IN TWEE LAGEN ────────────────────────────────────────────────
//   1. Vóór het indienen halen we de lijst bij 360dialog op. Staat naam+taal er
//      al, dan slaan we hem over. Lukt die lijst NIET, dan dienen we niets in —
//      zonder die lijst is "bestaat het al?" een gok, en een gok die fout gaat
//      levert een dubbele template op.
//   2. Zegt 360dialog alsnog "bestaat al" (twee mensen op de knop tegelijk),
//      dan is dat geen fout maar het antwoord dat we wilden.
//
// Rechten: admin.meta_templates.manage — hetzelfde recht als het bestaande
// templatebeheer. Niet iris.instellingen: dit dient iets in bij een partij
// buiten het CRM, en dat is een ander soort handeling dan een schakelaar
// omzetten. super_admin mag alles (zie requirePermission).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { buildComponents } from './_lib/wa-template-components.js';
import {
  TEMPLATE_WENSEN, WENS_NAMEN, WENS_NUMMER, WENS_BUSINESS_ACCOUNT_ID,
} from './_lib/iris/template-wensen.js';
import {
  lijstBij360, dienIn, bestaatAlFout, kortefout, sleutelVan, statusNaarIntern,
  D360GeenSleutelError,
} from './_lib/d360-templates.js';

const RIJ_KOLOMMEN = 'id, name, language, category, status, body_text, body_examples, meta_template_id, business_account_id, submitted_at, approved_at, rejection_reason, last_synced_at';

/** De lijnen waarop dit mag. Een onbekende of andere lijn wordt geweigerd. */
const TOEGESTANE_LIJNEN = Object.freeze(['klantnummer', 'hoofdnummer']);

async function logboek({ actie, payload, status = 'success', fout = null, userId }) {
  try {
    const { error } = await supabaseAdmin.from('agent_audit_log').insert({
      agent_name: 'iris',
      action: actie,
      payload,
      result: {},
      status,
      error_message: fout,
      triggered_by: userId || 'system',
    });
    if (error) console.error('[iris-templates] logboek mislukt:', error.message);
  } catch (e) {
    console.error('[iris-templates] logboek viel om:', e?.message || e);
  }
}

/** Onze rijen voor de vier wensen, op `naam|taal`. */
async function onzeRijen() {
  const { data, error } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .select(RIJ_KOLOMMEN)
    .in('name', WENS_NAMEN);
  if (error) throw new Error('onze templaterijen lezen: ' + error.message);
  const per = new Map();
  for (const r of data || []) per.set(sleutelVan(r.name, r.language), r);
  return per;
}

/**
 * De rij voor een wens aanmaken of bijwerken — de tekst die we indienen staat
 * daarna ook bij ons, zodat Iris hem kan lezen.
 *
 * De STATUS raken we hier niet aan. Een rij die al APPROVED is, mag niet
 * terugvallen naar LOCAL omdat iemand nog eens op de knop drukt: dan stopt het
 * versturen (Iris eist APPROVED). Zelfde reden als de waarschuwing in
 * 2026-09-08-wa-template-event-vragenlijst-definitief.sql.
 */
async function zetRij(wens, bestaand) {
  const velden = {
    business_account_id: WENS_BUSINESS_ACCOUNT_ID,
    name: wens.name,
    language: wens.language,
    category: wens.category,
    header_type: wens.header_type || 'NONE',
    body_text: wens.body_text,
    body_examples: { ...wens.body_examples },
    footer_text: wens.footer_text || null,
    buttons: wens.buttons || null,
  };
  if (bestaand?.id) {
    const { data, error } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .update(velden)
      .eq('id', bestaand.id)
      .select(RIJ_KOLOMMEN)
      .maybeSingle();
    if (error) throw new Error(`rij bijwerken (${wens.name}): ${error.message}`);
    return data;
  }
  const { data, error } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .insert({ ...velden, status: 'LOCAL' })
    .select(RIJ_KOLOMMEN)
    .single();
  if (error) throw new Error(`rij aanmaken (${wens.name}): ${error.message}`);
  return data;
}

/** De payload voor 360dialog. Puur. */
export function bouwPayload(wens) {
  const { components } = buildComponents(wens);
  return { name: wens.name, language: wens.language, category: wens.category, components };
}

/**
 * Heeft elke {{N}} in de body een voorbeeldwaarde? Meta eist dat; zonder
 * voorbeeld volgt een afkeuring en dan is er een dag verloren. Puur.
 */
export function voorbeeldenCompleet(wens) {
  const nodig = [...String(wens?.body_text || '').matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]);
  const uniek = [...new Set(nodig)];
  const ex = wens?.body_examples || {};
  const ontbreekt = uniek.filter((n) => !String(ex[n] ?? '').trim());
  return { ok: ontbreekt.length === 0, nodig: uniek, ontbreekt };
}

/* ── GET: overzicht ────────────────────────────────────────────────────────── */

async function overzicht(res, lijn) {
  const onze = await onzeRijen();

  let bij360 = null;
  let fout360 = null;
  try {
    bij360 = await lijstBij360(lijn);
  } catch (e) {
    if (e instanceof D360GeenSleutelError) fout360 = e.message;
    else fout360 = e?.message || 'De lijst bij 360dialog is niet op te halen.';
  }

  const items = TEMPLATE_WENSEN.map((w) => {
    const s = sleutelVan(w.name, w.language);
    const rij = onze.get(s) || null;
    const extern = bij360 ? (bij360.get(s) || null) : null;
    return {
      naam: w.name,
      taal: w.language,
      categorie: w.category,
      waarvoor: w.waarvoor,
      variabelen: [...w.variabelen],
      body: w.body_text,
      voorbeelden: { ...w.body_examples },
      bij_ons: rij ? { status: rij.status, ingediend_op: rij.submitted_at, goedgekeurd_op: rij.approved_at, afkeurreden: rij.rejection_reason } : null,
      bij_360: extern ? { status: extern.status, categorie: extern.category, afkeurreden: extern.rejected_reason } : null,
      staat_bij_360: bij360 ? bij360.has(s) : null,
      // Iris verstuurt alleen bij APPROVED in ONZE rij — dit is dus het veld
      // dat zegt of de template echt werkt, niet de stand bij 360dialog.
      iris_kan_sturen: String(rij?.status || '').toUpperCase() === 'APPROVED',
    };
  });

  return res.status(200).json({
    lijn,
    bron: 'docs/iris/template-wensen.md',
    items,
    fout_360: fout360,
    te_doen: items.filter((i) => i.staat_bij_360 === false).map((i) => i.naam),
  });
}

/* ── POST: indienen ────────────────────────────────────────────────────────── */

async function indienen(res, lijn, userId, alleenNamen) {
  // Eerst de lijst. Lukt dit niet, dan dienen we NIETS in.
  let bij360;
  try {
    bij360 = await lijstBij360(lijn);
  } catch (e) {
    const code = e instanceof D360GeenSleutelError ? 503 : 502;
    await logboek({ actie: 'iris.template.indienen', payload: { lijn }, status: 'error', fout: e?.message || 'lijst mislukt', userId });
    return res.status(code).json({
      error: e?.message || 'De templatelijst bij 360dialog is niet op te halen.',
      uitleg: 'Er is NIETS ingediend. Zonder die lijst is niet te zien wat er al staat, en dan zou een tweede keer drukken een dubbele template kunnen opleveren.',
    });
  }

  const onze = await onzeRijen();
  const wensen = alleenNamen?.length
    ? TEMPLATE_WENSEN.filter((w) => alleenNamen.includes(w.name))
    : TEMPLATE_WENSEN;
  if (!wensen.length) {
    return res.status(400).json({ error: 'Geen van de opgegeven namen is een bekende wens.', bekend: [...WENS_NAMEN] });
  }

  const uit = [];
  for (const wens of wensen) {
    const s = sleutelVan(wens.name, wens.language);
    try {
      // Eén onvolledige wens mag de andere drie niet tegenhouden.
      const vb = voorbeeldenCompleet(wens);
      if (!vb.ok) {
        uit.push({ naam: wens.name, actie: 'geweigerd', reden: `voorbeeldwaarde ontbreekt voor {{${vb.ontbreekt.join('}}, {{')}}} — Meta keurt dat af` });
        continue;
      }

      // De rij bij ons eerst: ook als het indienen mislukt, staat de tekst dan
      // vast en is zichtbaar wat er is gevraagd.
      const rij = await zetRij(wens, onze.get(s));

      if (bij360.has(s)) {
        const extern = bij360.get(s);
        const nieuweStatus = statusNaarIntern(extern.status);
        await supabaseAdmin.from('whatsapp_meta_templates').update({
          status: nieuweStatus,
          meta_template_id: extern.id || rij?.meta_template_id || null,
          last_synced_at: new Date().toISOString(),
          ...(nieuweStatus === 'APPROVED' ? { approved_at: new Date().toISOString(), rejection_reason: null } : {}),
        }).eq('id', rij.id);
        uit.push({ naam: wens.name, actie: 'overgeslagen', reden: 'staat al bij 360dialog', status_360: extern.status || null, status: nieuweStatus });
        continue;
      }

      const r = await dienIn(lijn, bouwPayload(wens));
      if (r.ok) {
        const status = statusNaarIntern(r.json?.status);
        await supabaseAdmin.from('whatsapp_meta_templates').update({
          status,
          meta_template_id: r.json?.id || null,
          submitted_at: new Date().toISOString(),
          rejection_reason: null,
          last_synced_at: new Date().toISOString(),
        }).eq('id', rij.id);
        uit.push({ naam: wens.name, actie: 'ingediend', status, status_360: r.json?.status || null, id_360: r.json?.id || null });
        continue;
      }
      if (bestaatAlFout(r)) {
        uit.push({ naam: wens.name, actie: 'overgeslagen', reden: '360dialog zegt dat hij al bestaat' });
        continue;
      }
      uit.push({ naam: wens.name, actie: 'mislukt', reden: `HTTP ${r.status}: ${kortefout(r)}` });
    } catch (e) {
      console.error(`[iris-templates] ${wens.name} mislukt:`, e?.message || e);
      uit.push({ naam: wens.name, actie: 'mislukt', reden: e?.message || 'onbekende fout' });
    }
  }

  const tel = (a) => uit.filter((u) => u.actie === a).length;
  const mislukt = tel('mislukt') + tel('geweigerd');
  await logboek({
    actie: 'iris.template.indienen',
    payload: { lijn, ingediend: tel('ingediend'), overgeslagen: tel('overgeslagen'), mislukt },
    status: mislukt ? 'partial' : 'success',
    fout: mislukt ? uit.filter((u) => u.reden && u.actie !== 'overgeslagen').map((u) => `${u.naam}: ${u.reden}`).join(' · ') : null,
    userId,
  });

  return res.status(200).json({
    lijn,
    items: uit,
    samenvatting: { ingediend: tel('ingediend'), overgeslagen: tel('overgeslagen'), mislukt },
    uitleg: tel('ingediend')
      ? 'Ingediend. Meta beoordeelt dit meestal binnen enkele minuten tot enkele uren. Druk daarna op "Status vernieuwen" — Iris verstuurt pas als de stand bij ons APPROVED is.'
      : 'Er is niets nieuws ingediend.',
  });
}

/* ── POST: status vernieuwen ───────────────────────────────────────────────── */

async function statusVernieuwen(res, lijn, userId) {
  let bij360;
  try {
    bij360 = await lijstBij360(lijn);
  } catch (e) {
    const code = e instanceof D360GeenSleutelError ? 503 : 502;
    return res.status(code).json({ error: e?.message || 'De templatelijst bij 360dialog is niet op te halen.' });
  }

  // Alle rijen die wij hebben, niet alleen de vier wensen: de bestaande
  // aanmaan- en opvolgtemplates staan op dezelfde lijn en hun stand veroudert
  // net zo goed. admin-meta-templates-sync.js deed dit via Meta en kan het
  // sinds 5 oktober niet meer.
  const { data: rijen, error } = await supabaseAdmin
    .from('whatsapp_meta_templates')
    .select('id, name, language, status, approved_at')
    .limit(500);
  if (error) return res.status(500).json({ error: 'onze templaterijen lezen: ' + error.message });

  const nu = new Date().toISOString();
  const veranderd = [];
  let gelijk = 0;
  let onbekend = 0;
  for (const rij of rijen || []) {
    const extern = bij360.get(sleutelVan(rij.name, rij.language));
    if (!extern) { onbekend++; continue; }
    const nieuw = statusNaarIntern(extern.status);
    // Geen `undefined` in het veldenobject: supabase-js laat die sleutel weg,
    // maar een nabouw in een toets doet dat niet per se — en een kolom die
    // stil op undefined gezet wordt, is een verschil tussen toets en
    // productie dat je pas ziet als het misgaat.
    const velden = { last_synced_at: nu };
    if (extern.id) velden.meta_template_id = extern.id;
    if (nieuw !== rij.status) {
      velden.status = nieuw;
      if (nieuw === 'APPROVED') { velden.approved_at = rij.approved_at || nu; velden.rejection_reason = null; }
      if (nieuw === 'REJECTED' && extern.rejected_reason) velden.rejection_reason = String(extern.rejected_reason).slice(0, 500);
    }
    const { error: upErr } = await supabaseAdmin.from('whatsapp_meta_templates').update(velden).eq('id', rij.id);
    if (upErr) {
      console.error(`[iris-templates] status zetten (${rij.name}):`, upErr.message);
      continue;
    }
    if (velden.status) veranderd.push({ naam: rij.name, van: rij.status, naar: nieuw });
    else gelijk++;
  }

  await logboek({
    actie: 'iris.template.status_vernieuwen',
    payload: { lijn, veranderd: veranderd.length, gelijk, niet_bij_360: onbekend },
    userId,
  });

  const wensen = TEMPLATE_WENSEN.map((w) => {
    const extern = bij360.get(sleutelVan(w.name, w.language));
    return { naam: w.name, status_360: extern?.status || null, staat_bij_360: !!extern };
  });

  return res.status(200).json({
    lijn, veranderd, gelijk, niet_bij_360: onbekend, wensen,
    uitleg: veranderd.length
      ? `${veranderd.length} template(s) kregen een nieuwe stand.`
      : 'Alle standen waren al gelijk aan wat 360dialog zegt.',
  });
}

/* ── Handler ───────────────────────────────────────────────────────────────── */

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Niet ingelogd' });
    if (!(await requirePermission(req, 'admin.meta_templates.manage'))) {
      return res.status(403).json({ error: 'Geen rechten (admin.meta_templates.manage)' });
    }

    const gevraagdeLijn = String(req.body?.lijn || req.query?.lijn || WENS_NUMMER).trim();
    if (!TOEGESTANE_LIJNEN.includes(gevraagdeLijn)) {
      return res.status(400).json({ error: `Onbekende lijn "${gevraagdeLijn}".`, toegestaan: [...TOEGESTANE_LIJNEN] });
    }

    if (req.method === 'GET') return await overzicht(res, gevraagdeLijn);

    if (req.method === 'POST') {
      const actie = String(req.body?.actie || '').trim();
      if (actie === 'indienen') {
        const namen = Array.isArray(req.body?.namen)
          ? req.body.namen.map((n) => String(n || '').trim()).filter((n) => WENS_NAMEN.includes(n))
          : null;
        return await indienen(res, gevraagdeLijn, user.id, namen);
      }
      if (actie === 'status_vernieuwen') return await statusVernieuwen(res, gevraagdeLijn, user.id);
      return res.status(400).json({ error: 'actie moet "indienen" of "status_vernieuwen" zijn' });
    }

    return res.status(405).json({ error: 'Alleen GET of POST' });
  } catch (e) {
    console.error('[iris-templates] viel om:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Onbekende fout' });
  }
}
