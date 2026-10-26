// api/cron-lab-opvolging.js
//
// De opvolgmotor van ELKE trial-lead (minicursus, 7-daagse, webinar, website,
// The Lab — sinds 26 okt 2026 allemaal lab-leads in het echte LMS). Traject
// "the-lab" — elk kwartier. Drie taken:
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
import { leesLmsStand, leesLabGedrag, isAfgerond, isGestart } from './_lib/lab-dossier.js';
import { maakLoginSleutel } from './_lib/dfo-lms-lab-account.js';
import { stuurLabMail, stuurLabWhatsApp, knop } from './_lib/lab-berichten.js';
import { labLoginLink, LAB_SLUG } from './_lib/lab-config.js';
import { volgendeStap, isStilUur, standaardMail, linkDoel, vulLabSjabloon, kiesVariant, WA_STAPPEN, belofteKort, dagenOver } from './_lib/lab-opvolging.js';
import { herkomstVanAanmelding, isBuitenTrialflow, alleenBuitenTrialflow } from './_lib/trial-product.js';
import { eersteVideoMinuten } from './_lib/lab-video-duur.js';
import { verwerkLmsEnBerichten } from './lab-aanmelding.js';
import { stuurLabEvent, labEventId, labUserData } from './_lib/lab-meta.js';
import { leadHeeftToestemming } from './_lib/advertentie-toestemming.js';

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
    // Webinar: eigen flow — geen nieuwe poging (die zou een welkomstmail sturen).
    if (isBuitenTrialflow(herkomst.product)) continue;
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
  // '*': de herkomstkolommen (product/bron) bestaan pas na de migratie van 26 okt.
  const { data: aanm, error: ae } = await supabaseAdmin.from('lab_aanmeldingen')
    .select('*')
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
    const product = herkomstVanAanmelding(a).product;
    if (!p) perEmail.set(em, { eerste: a, laatste: a, authId: a.lms_auth_id, producten: [product] });
    else { p.laatste = a; p.authId = p.authId || a.lms_auth_id; p.producten.push(product); }
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
  // Afgemeld (lead_mail_voorkeuren) of klant geworden → de motor zwijgt.
  const afgemeld = new Set();
  const klanten = new Set();
  for (let i = 0; i < emails.length; i += 300) {
    const deel = emails.slice(i, i + 300);
    const [{ data: vk, error: ve }, { data: ld, error: le }] = await Promise.all([
      supabaseAdmin.from('lead_mail_voorkeuren').select('email, afgemeld').in('email', deel),
      supabaseAdmin.from('leads').select('email, status, customer_id').in('email', deel),
    ]);
    if (ve) console.warn('[cron-lab-opvolging] mailvoorkeuren (soft):', ve.message);
    if (le) console.warn('[cron-lab-opvolging] leads (soft):', le.message);
    for (const x of vk || []) if (x.afgemeld) afgemeld.add(String(x.email || '').toLowerCase());
    for (const l of ld || []) if (l.customer_id || l.status === 'gewonnen') klanten.add(String(l.email || '').toLowerCase());
  }

  verslag.live = await isLive();
  const tpl = await sjablonen();
  let videoMin; // lazy: alleen als er een stap is die hem nodig heeft
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
    const herkomst = herkomstVanAanmelding(p.eerste);
    const product = labLead.product || herkomst.product;
    const stap = volgendeStap({
      // De start van de trial: toegang_van (ook na een verlenging), anders de aanmelding.
      aangemeldOp: labLead.toegang_van ? Date.parse(labLead.toegang_van) : Date.parse(p.eerste.aangemaakt),
      toestemming: !!p.laatste.toestemming,
      toegangTot: labLead.toegang_tot,
      geboekt: !!labLead.sessie_geboekt_op || geboektViaAgenda.has(em),
      afgemeld: afgemeld.has(em),
      klant: klanten.has(em),
      ingelogd: !!labLead.eerste_login_op,
      gestart, afgerond,
      videos: (gedrag.get(labLead.id)?.videoTijden || []).length,
      gehad: g.stappen,
      laatsteBericht: g.laatste,
      // Webinar heeft een eigen flow: de motor stuurt die leads niets (26 okt).
      buitenFlow: alleenBuitenTrialflow(p.producten),
    }, nu);
    if (!stap) continue;

    if (!verslag.live) { verslag.droog.push({ email: em, stap, product }); continue; }

    try {
      if (stap === 'niet-ingelogd-24u' && videoMin === undefined) videoMin = await eersteVideoMinuten();
      const sleutel = await maakLoginSleutel(labLead.id, 'opvolging');
      const link = labLoginLink(sleutel, linkDoel(stap));
      const voornaam = labLead.voornaam || p.eerste.voornaam;
      const w = {
        voornaam, loginlink: link, belofte: belofteKort(product), eerste_video_min: videoMin || '',
        dagen_over: dagenOver(labLead.toegang_tot, nu), stap: sessie?.stap ?? '', stappen: sessie?.stappen ?? '',
      };
      const score = sessie?.leadscore?.totaal ?? null;
      const eigen = kiesVariant(tpl.filter((t) => t.soort === stap && t.kanaal === 'mail'), score);
      const mail = eigen && (eigen.html || eigen.tekst)
        ? { onderwerp: vulLabSjabloon(eigen.onderwerp || '', w), html: vulLabSjabloon(eigen.html || `<p>${eigen.tekst}</p>`, w) }
        : standaardMail(stap, { voornaam, link, knop, product, eersteVideoMin: videoMin || null });
      const m = await stuurLabMail({ leadId: p.eerste.lead_id, email: em, soort: `lab-${stap}`, ...mail });
      // WhatsApp enkel op de stappen die ervoor bedoeld zijn, en enkel met een
      // goedgekeurd template. Anders overgeslagen — en gelogd — de mail ging wel.
      const wa = WA_STAPPEN.has(stap)
        ? await stuurLabWhatsApp({ leadId: p.eerste.lead_id, telefoon: p.eerste.telefoon_e164, toestemming: !!p.laatste.toestemming, soort: stap, waarden: w })
        : { ok: false, status: 'geen_wa_stap' };
      if (m.ok) await noteer({ aanmelding_id: p.eerste.id, lead_id: p.eerste.lead_id, stap, kanaal: 'mail', status: 'verstuurd' });
      else await noteer({ aanmelding_id: p.eerste.id, lead_id: p.eerste.lead_id, stap: `${stap}-fout-${new Date(nu).toISOString().slice(0, 13)}`, kanaal: 'mail', status: 'fout', detail: String(m.fout || m.status || '').slice(0, 300) });
      if (WA_STAPPEN.has(stap)) {
        await noteer({ aanmelding_id: p.eerste.id, lead_id: p.eerste.lead_id, stap, kanaal: 'whatsapp', status: wa.ok ? 'verstuurd' : 'overgeslagen', detail: wa.status });
      }
      if (m.ok || wa.ok) verzonden++;
      verslag.verstuurd.push({ email: em, stap, product, mail: m.status, whatsapp: wa.status });
    } catch (e) {
      console.error('[cron-lab-opvolging] versturen mislukt', { email: em, stap, fout: e?.message || e });
    }
  }

  console.log('[cron-lab-opvolging]', { live: verslag.live, stil: verslag.stil, verstuurd: verslag.verstuurd.length, droog: verslag.droog.length, herstel: verslag.herstel.length, meta: verslag.meta });
  return res.status(200).json({ ok: true, ...verslag });
}
