// api/cron-lab-opvolging.js
//
// Traject "the-lab" — elk kwartier. Drie taken:
//
//   1. HERSTEL. Een aanmelding waarvan het LMS-deel mislukte (resultaat
//      'lms_fout') wordt opnieuw geprobeerd: hoogstens 5 keer, binnen 72 uur,
//      met oplopende wachttijd. Dat is de loginmail waar de lead om vroeg, dus
//      dit draait ook als de opvolging zelf nog uit staat.
//   2. OPVOLGING. Per lead de volgende stap uit volgendeStap() (zie
//      api/_lib/lab-opvolging.js voor de regels), mail + WhatsApp.
//      STAAT UIT tot app_settings 'lab_opvolging_live' = true; tot dan is het
//      een droogloop die in het antwoord en de log zegt wat er zou gaan.
//      Noodstop: env LEADSONDERHOUD_UIT (dezelfde als de gewone motor).
//   3. META. LabGestart / LabAfgewerkt naar de Conversions API zodra de stand
//      dat toont (idempotent op event_id; uit zolang de Meta-env leeg is).

import { supabaseAdmin, checkCronAuth } from './supabase.js';
import { instelWaarde } from './_lib/leadsonderhoud-sjabloon.js';
import { leesLmsStand, leesLabGedrag, isAfgerond, isGestart, videosKlaarOp } from './_lib/lab-dossier.js';
import { maakLoginSleutel } from './_lib/dfo-lms-lab-account.js';
import { stuurLabMail, stuurLabWhatsApp, knop } from './_lib/lab-berichten.js';
import { labLoginLink, LAB_SLUG } from './_lib/lab-config.js';
import { volgendeStap, isStilUur, standaardMail, linkDoel, vulLabSjabloon, kiesVariant } from './_lib/lab-opvolging.js';
import { verwerkLmsEnBerichten } from './lab-aanmelding.js';
import { stuurLabEvent, labEventId, labUserData } from './_lib/lab-meta.js';
import { leadHeeftToestemming } from './_lib/advertentie-toestemming.js';
import { herkomstVanAanmelding } from './_lib/trial-product.js';

/** Producten die altijd via de WhatsApp-gate (toegang_aanvragen) binnenkomen. */
const GATE_PRODUCTEN = new Set(['minicursus', '7-daagse', 'website']);

const MAX_PER_RUN = 40;
const HERSTEL_MAX = 5;
const VENSTER_DAGEN = 21;

const aanUit = (v) => ['1', 'true', 'aan', 'on', 'ja'].includes(String(v ?? '').trim().toLowerCase());

async function isLive() {
  const { data, error } = await supabaseAdmin.from('app_settings').select('value').eq('key', 'lab_opvolging_live').maybeSingle();
  if (error) { console.warn('[cron-lab-opvolging] live-schakelaar lezen (soft):', error.message); return false; }
  return aanUit(instelWaarde(data));
}

async function noteer(rij) {
  const { error } = await supabaseAdmin.from('lab_opvolging').insert(rij);
  if (error && String(error.code) !== '23505') console.warn('[cron-lab-opvolging] lab_opvolging (soft):', error.message);
}

async function herstel(nu, verslag) {
  const sinds = new Date(nu - 72 * 3600 * 1000).toISOString();
  const { data, error } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('*').eq('resultaat', 'lms_fout').gte('aangemaakt', sinds).limit(20);
  if (error) { console.warn('[cron-lab-opvolging] herstel lezen (soft):', error.message); return; }
  for (const a of data || []) {
    // Een trial uit de WhatsApp-gate wordt hersteld door cron-toegang-aanvragen
    // (provisioning-retry): niet ook hier. Herkenbaar aan toegang_aanvraag_id,
    // of — zolang die kolom nog niet bestaat — aan het product: minicursus,
    // 7-daagse en website komen altijd via de gate.
    const herkomst = herkomstVanAanmelding(a);
    if (a.toegang_aanvraag_id || GATE_PRODUCTEN.has(herkomst.product)) continue;
    try {
      const { data: pogingen } = await supabaseAdmin.from('lab_opvolging').select('stap').eq('aanmelding_id', a.id).like('stap', 'herstel-%');
      const n = (pogingen || []).length + 1;
      if (n > HERSTEL_MAX) continue;
      if (nu - Date.parse(a.aangemaakt) < n * 10 * 60 * 1000) continue;
      const uit = await verwerkLmsEnBerichten({ aanmeldingId: a.id, leadId: a.lead_id, d: { ...a, ...herkomst } });
      await supabaseAdmin.from('lab_aanmeldingen').update(uit).eq('id', a.id);
      await noteer({ aanmelding_id: a.id, lead_id: a.lead_id, stap: `herstel-${n}`, kanaal: 'mail', status: uit.resultaat === 'lms_fout' ? 'fout' : 'verstuurd', detail: String(uit.resultaat_detail || uit.resultaat || '').slice(0, 300) });
      verslag.herstel.push({ aanmelding: a.id, poging: n, resultaat: uit.resultaat });
    } catch (e) {
      console.error('[cron-lab-opvolging] herstel mislukt', { aanmelding: a.id, fout: e?.message || e });
    }
  }
}

async function sjablonen() {
  const { data, error } = await supabaseAdmin.from('onderhoud_sjablonen')
    .select('soort, kanaal, onderwerp, html, tekst, score_min, score_max').eq('traject_slug', LAB_SLUG).eq('actief', true);
  if (error) { console.warn('[cron-lab-opvolging] sjablonen (soft):', error.message); return []; }
  return data || [];
}

export default async function handler(req, res) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);
  if (aanUit(process.env.LEADSONDERHOUD_UIT)) return res.status(200).json({ ok: true, overgeslagen: 'noodstop (LEADSONDERHOUD_UIT)' });

  const nu = Date.now();
  const verslag = { herstel: [], verstuurd: [], droog: [], meta: 0, live: false, stil: isStilUur(nu) };

  await herstel(nu, verslag);

  // ── De stand van alle lab-leads uit de laatste weken ───────────────────
  const { data: aanm, error: ae } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('id, aangemaakt, lead_id, email, voornaam, telefoon_e164, toestemming, lms_auth_id, fbc, fbp, landingspagina, resultaat')
    .gte('aangemaakt', new Date(nu - VENSTER_DAGEN * 86400000).toISOString())
    .order('aangemaakt', { ascending: true }).limit(5000);
  if (ae) {
    if (ae.code === '42P01' || ae.code === 'PGRST205') return res.status(200).json({ ok: true, overgeslagen: 'migratie ontbreekt', ...verslag });
    console.error('[cron-lab-opvolging] aanmeldingen:', ae.message);
    return res.status(500).json({ error: 'aanmeldingen lezen mislukt' });
  }
  const perEmail = new Map();
  for (const a of aanm || []) {
    const em = String(a.email || '').toLowerCase();
    const p = perEmail.get(em);
    if (!p) perEmail.set(em, { eerste: a, laatste: a, authId: a.lms_auth_id });
    else { p.laatste = a; p.authId = p.authId || a.lms_auth_id; }
  }
  const authIds = [...new Set([...perEmail.values()].map((p) => p.authId).filter(Boolean))];
  if (!authIds.length) return res.status(200).json({ ok: true, ...verslag });

  let lms;
  try { lms = await leesLmsStand({ authIds }); } catch (e) {
    console.error('[cron-lab-opvolging] LMS:', e?.message || e);
    return res.status(200).json({ ok: false, fout: 'LMS onbereikbaar', ...verslag });
  }
  const leadPerAuth = new Map(lms.leads.map((l) => [l.auth_id, l]));
  // Jouw route: gekozen ingang + de video's van het leerpad (fail-soft).
  const gedrag = await leesLabGedrag(lms.leads.map((l) => l.id));

  const eersteIds = [...perEmail.values()].map((p) => p.eerste.id);
  const gehadPer = new Map();
  for (let i = 0; i < eersteIds.length; i += 300) {
    const { data: ov } = await supabaseAdmin.from('lab_opvolging').select('aanmelding_id, stap, status, aangemaakt').in('aanmelding_id', eersteIds.slice(i, i + 300));
    for (const o of ov || []) {
      const g = gehadPer.get(o.aanmelding_id) || { stappen: new Set(), laatste: null };
      g.stappen.add(o.stap);
      if (o.status === 'verstuurd') g.laatste = Math.max(g.laatste || 0, Date.parse(o.aangemaakt));
      gehadPer.set(o.aanmelding_id, g);
    }
  }
  // Een boeking via de gewone agendalink (bron the-lab) telt ook als geboekt.
  const emails = [...perEmail.keys()];
  const geboektViaAgenda = new Set();
  for (let i = 0; i < emails.length; i += 300) {
    const { data: fa } = await supabaseAdmin.from('follow_up_appointments').select('lead_email').in('lead_email', emails.slice(i, i + 300));
    for (const f of fa || []) geboektViaAgenda.add(String(f.lead_email || '').toLowerCase());
  }

  verslag.live = await isLive();
  const tpl = await sjablonen();
  let verzonden = 0;

  for (const [em, p] of perEmail) {
    const labLead = p.authId ? leadPerAuth.get(p.authId) : null;
    if (!labLead) continue;
    const sessie = lms.sessiePerAuth.get(labLead.auth_id) || null;
    const gestart = isGestart(sessie);
    const afgerond = isAfgerond(sessie);

    // 3 · Meta — de stand gezien? Dan het event (één keer, op event_id).
    try {
      const ud = () => labUserData({ email: em, telefoonE164: p.eerste.telefoon_e164, voornaam: p.eerste.voornaam, externalId: p.eerste.lead_id || p.eerste.id, fbc: p.eerste.fbc, fbp: p.eerste.fbp });
      const recent = sessie?.bijgewerkt_op && nu - Date.parse(sessie.bijgewerkt_op) < 3 * 86400000;
      // Alleen met toestemming advertentiecookies op de lead (fail-closed).
      const toestemming = (gestart || afgerond) && recent
        ? await leadHeeftToestemming(supabaseAdmin, { leadId: p.eerste.lead_id, email: em }) : false;
      if (gestart && recent) { await stuurLabEvent({ eventName: 'LabGestart', eventId: labEventId('LabGestart', labLead.auth_id), aanmeldingId: p.eerste.id, userData: ud(), toestemming }); verslag.meta++; }
      if (afgerond && recent) { await stuurLabEvent({ eventName: 'LabAfgewerkt', eventId: labEventId('LabAfgewerkt', labLead.auth_id), aanmeldingId: p.eerste.id, userData: ud(), toestemming }); verslag.meta++; }
    } catch (e) { console.warn('[cron-lab-opvolging] meta (soft):', e?.message || e); }

    if (verslag.stil || verzonden >= MAX_PER_RUN) continue;

    const g = gehadPer.get(p.eerste.id) || { stappen: new Set(), laatste: null };
    const stap = volgendeStap({
      aangemeldOp: Date.parse(p.eerste.aangemaakt),
      toestemming: !!p.laatste.toestemming,
      toegangTot: labLead.toegang_tot,
      geboekt: !!labLead.sessie_geboekt_op || geboektViaAgenda.has(em),
      gestart, afgerond,
      laatsteActiviteit: sessie?.bijgewerkt_op ? Date.parse(sessie.bijgewerkt_op) : null,
      gehad: g.stappen,
      laatsteBericht: g.laatste,
      // Jouw route: stap 1 (de video's) af — zelfde regel als het LMS.
      videoBekeken: videosKlaarOp(gedrag.get(labLead.id)) != null,
      videoOp: videosKlaarOp(gedrag.get(labLead.id)),
    }, nu);
    if (!stap) continue;

    if (!verslag.live) { verslag.droog.push({ email: em, stap }); continue; }

    try {
      const sleutel = await maakLoginSleutel(labLead.id, 'opvolging');
      const link = labLoginLink(sleutel, linkDoel(stap));
      const w = { voornaam: labLead.voornaam || p.eerste.voornaam, loginlink: link, stap: sessie?.stap ?? '', stappen: sessie?.stappen ?? '' };
      const score = sessie?.leadscore?.totaal ?? null;
      const eigen = kiesVariant(tpl.filter((t) => t.soort === stap && t.kanaal === 'mail'), score);
      const mail = eigen && (eigen.html || eigen.tekst)
        ? { onderwerp: vulLabSjabloon(eigen.onderwerp || '', w), html: vulLabSjabloon(eigen.html || `<p>${eigen.tekst}</p>`, w) }
        : standaardMail(stap, { ...w, link, knop });
      const m = await stuurLabMail({ leadId: p.eerste.lead_id, email: em, soort: `lab-${stap}`, ...mail });
      const wa = await stuurLabWhatsApp({ leadId: p.eerste.lead_id, telefoon: p.eerste.telefoon_e164, toestemming: !!p.laatste.toestemming, soort: stap, waarden: w });
      if (m.ok) await noteer({ aanmelding_id: p.eerste.id, lead_id: p.eerste.lead_id, stap, kanaal: 'mail', status: 'verstuurd' });
      if (wa.ok || ['geen_template', 'niet_goedgekeurd', 'geen_nummer'].includes(wa.status)) {
        await noteer({ aanmelding_id: p.eerste.id, lead_id: p.eerste.lead_id, stap, kanaal: 'whatsapp', status: wa.ok ? 'verstuurd' : 'overgeslagen', detail: wa.status });
      }
      if (m.ok || wa.ok) verzonden++;
      verslag.verstuurd.push({ email: em, stap, mail: m.status, whatsapp: wa.status });
    } catch (e) {
      console.error('[cron-lab-opvolging] versturen mislukt', { email: em, stap, fout: e?.message || e });
    }
  }

  console.log('[cron-lab-opvolging]', { live: verslag.live, stil: verslag.stil, verstuurd: verslag.verstuurd.length, droog: verslag.droog.length, herstel: verslag.herstel.length, meta: verslag.meta });
  return res.status(200).json({ ok: true, ...verslag });
}
