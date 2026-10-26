// api/lab-aanmelding.js
//
// POST /api/lab-aanmelding — publieke aanmelding voor The Lab (advertenties →
// landingspagina → hier). Contract en embed-snippet:
// docs/the-lab-aanmelding-api.md.
//
// Wat er gebeurt, in volgorde:
//   1. CORS (lab-cors.js), rate limit per IP, validatie + honeypot.
//   2. De lead in Leadsonderhoud (upsert_lead). Een NIEUWE lead krijgt
//      bron/traject 'the-lab'; een bestaande lead behoudt zijn herkomst — de
//      touch zelf (hook, UTM's) staat in lab_aanmeldingen, dus er gaat niets
//      verloren en er wordt niets overschreven.
//   3. Het trial-account in het LMS (dfo-lms-lab-account.js). Bestaande
//      studenten, mentoren en zaalaccounts worden NOOIT aangeraakt.
//   4. Mail (altijd: de lead vroeg zelf om toegang) en WhatsApp (alleen met
//      toestemming én een goedgekeurd template).
//   5. Meta CAPI 'Lead' (staat uit zolang de env leeg is).
//
// Het antwoord is voor elke e-mail HETZELFDE, of er nu al een account was of
// niet: anders wordt dit een orakel om te testen wie er student is.
//
// Antwoord: 200 { ok:true, event_id, bericht }
//           400 { ok:false, code:'ongeldig', veld, fout }
//           429 { ok:false, code:'te_veel' }

import crypto from 'node:crypto';
import { supabaseAdmin } from './supabase.js';
import { applyLabCors, labPreflight } from './_lib/lab-cors.js';
import { checkRateLimit } from './_lib/rate-limit.js';
import { extractClientIp, hashIp } from './_lib/assessment-validation.js';
import { valideerLabAanmelding } from './_lib/lab-aanmelding-validatie.js';
import { zorgVoorLabAccount, maakLoginSleutel, LabAccountFout } from './_lib/dfo-lms-lab-account.js';
import { mailWelkom, mailNieuweLink, mailAlToegang, stuurLabMail, stuurLabWhatsApp } from './_lib/lab-berichten.js';
import { labLoginLink, LAB_SLUG } from './_lib/lab-config.js';
import { stuurLabEvent, labUserData } from './_lib/lab-meta.js';
import { beslisMetaLead } from './_lib/meta-lead-poort.js';
import { legToestemmingVast, toestemmingUitBody } from './_lib/advertentie-toestemming.js';
import { maakBoektoken } from './_lib/lab-boektoken.js';

export const BERICHT_OK = 'Gelukt! Check je mailbox: je link naar The Lab is onderweg.';
// Het LMS-deel mislukte: de opvolgcron probeert het opnieuw. Dan beloven we geen
// mail die nog niet weg is. Dit zegt niets over het adres (een storing, geen bestaan).
export const BERICHT_LATER = 'Gelukt! We zetten je account klaar — je link komt binnen enkele minuten in je mailbox.';

/** Herkomst-kanaal voor leads.soort. PURE. */
export function soortUitUtm({ utm_source, fbclid }) {
  const s = String(utm_source || '').toLowerCase();
  if (/insta|^ig$/.test(s)) return 'instagram';
  if (/face|^fb$|meta/.test(s)) return 'facebook';
  if (s) return s.replace(/[^a-z0-9-]/g, '').slice(0, 40) || LAB_SLUG;
  return fbclid ? 'facebook' : LAB_SLUG;
}

async function upsertLead(d) {
  let bestaand = null;
  const { data: ex, error: exErr } = await supabaseAdmin.from('leads')
    .select('id').ilike('email', d.email).is('verwijderd_op', null).limit(1);
  if (exErr) console.warn('[lab-aanmelding] lead pre-check (soft):', exErr.message);
  else bestaand = ex?.[0] || null;

  const basis = {
    voornaam: d.voornaam, achternaam: d.achternaam, email: d.email,
    telefoon: d.telefoon_e164, telefoon_e164: d.telefoon_e164,
  };
  const payload = bestaand
    ? basis
    : { ...basis, bron: d.funnel || LAB_SLUG, soort: soortUitUtm(d), traject: LAB_SLUG };
  const { data, error } = await supabaseAdmin.rpc('upsert_lead', { p: payload });
  if (error) throw new Error('upsert_lead: ' + error.message);
  const rij = Array.isArray(data) ? data[0] : data;
  if (!rij?.id) throw new Error('upsert_lead gaf geen id');
  return { id: rij.id, nieuw: !bestaand };
}

/**
 * Funnel-tracking (dfo-website): de events van deze browsersessie aan de lead
 * hangen, net zoals /api/lead op de website dat doet. Fail-soft.
 */
async function koppelFunnelSessie(sessionId, leadId) {
  if (!sessionId || !leadId) return;
  try {
    const { error } = await supabaseAdmin.from('funnel_events')
      .update({ lead_id: leadId }).eq('session_id', sessionId).is('lead_id', null);
    if (error) console.warn('[lab-aanmelding] funnel-koppeling (soft):', error.message);
  } catch (e) {
    console.warn('[lab-aanmelding] funnel-koppeling exception (soft):', e?.message || e);
  }
}

async function bewaarAanmelding(rij) {
  const { error } = await supabaseAdmin.from('lab_aanmeldingen').insert(rij);
  if (error) console.error('[lab-aanmelding] lab_aanmeldingen insert:', error.message);
  return !error;
}

async function werkAanmeldingBij(id, velden) {
  const { error } = await supabaseAdmin.from('lab_aanmeldingen').update(velden).eq('id', id);
  if (error) console.warn('[lab-aanmelding] lab_aanmeldingen bijwerken (soft):', error.message);
}

/**
 * Het LMS-deel + de berichten. Ook gebruikt door de opvolgcron om een
 * aanmelding met resultaat 'lms_fout' later opnieuw te proberen.
 */
export async function verwerkLmsEnBerichten({ aanmeldingId, leadId, d }) {
  const uit = { resultaat: null, resultaat_detail: null, lms_auth_id: null, lms_lead_id: null, mail_status: null, wa_status: null };
  let account;
  try {
    account = await zorgVoorLabAccount({
      email: d.email, voornaam: d.voornaam, achternaam: d.achternaam, telefoon: d.telefoon_e164,
      crmLeadId: leadId, hook: d.hook,
      utm: { source: d.utm_source, medium: d.utm_medium, campaign: d.utm_campaign, content: d.utm_content, term: d.utm_term },
      isTest: d.is_test,
      product: d.product || LAB_SLUG, bron: d.bron || d.funnel || null, variant: d.variant || null,
    });
  } catch (e) {
    const code = e instanceof LabAccountFout ? e.code : 'lms_fout';
    console.error('[lab-aanmelding] LMS-account mislukt', { aanmelding: aanmeldingId, code, fout: e?.message });
    uit.resultaat = 'lms_fout';
    uit.resultaat_detail = String(e?.message || code).slice(0, 300);
    return uit;
  }

  uit.lms_auth_id = account.authId || null;
  uit.lms_lead_id = account.labLead?.id || null;

  if (account.soort === 'heeft_toegang') {
    uit.resultaat = 'al_toegang';
    const m = mailAlToegang({ voornaam: d.voornaam, product: d.product || LAB_SLUG });
    uit.mail_status = (await stuurLabMail({ leadId, email: d.email, soort: 'lab-al-toegang', ...m })).status;
    return uit;
  }

  let sleutel;
  try {
    sleutel = await maakLoginSleutel(account.labLead.id);
  } catch (e) {
    console.error('[lab-aanmelding] sleutel mislukt', { aanmelding: aanmeldingId, fout: e?.message });
    uit.resultaat = 'lms_fout';
    uit.resultaat_detail = String(e?.message || 'sleutel').slice(0, 300);
    return uit;
  }

  const verlopen = !!account.labLead.toegang_tot && new Date(account.labLead.toegang_tot).getTime() < Date.now();
  const link = labLoginLink(sleutel, verlopen ? 'sessie' : 'start');
  const product = d.product || LAB_SLUG;
  if (account.soort === 'nieuw' || account.verlengd) {
    uit.resultaat = account.verlengd ? 'verlengd' : 'nieuw_account';
    const welkom = mailWelkom({ voornaam: d.voornaam, link, product, toegangTot: account.labLead.toegang_tot });
    uit.mail_status = (await stuurLabMail({ leadId, email: d.email, soort: product === LAB_SLUG ? 'lab-welkom' : `welkom-${product}`, ...welkom })).status;
    // Kwam de lead via de WhatsApp-gate binnen, dan kreeg hij daar al "je
    // inloggegevens staan in je mail" — geen tweede WhatsApp.
    uit.wa_status = d.wa_al_bevestigd
      ? 'gate_bevestigd'
      : (await stuurLabWhatsApp({
        leadId, telefoon: d.telefoon_e164, toestemming: d.toestemming, soort: 'welkom',
        waarden: { voornaam: d.voornaam, loginlink: link },
      })).status;
  } else {
    uit.resultaat = 'nieuwe_link';
    const m = mailNieuweLink({ voornaam: d.voornaam, link, verlopen, product });
    uit.mail_status = (await stuurLabMail({ leadId, email: d.email, soort: 'lab-nieuwe-link', ...m })).status;
  }
  return uit;
}

export default async function handler(req, res) {
  applyLabCors(req, res, 'POST, OPTIONS');
  if (labPreflight(req, res, 'POST')) return;

  const { limited } = await checkRateLimit({ req, bucket: 'lab-aanmelding', maxHits: 6, withinSeconds: 600 });
  if (limited) return res.status(429).json({ ok: false, code: 'te_veel', fout: 'Even geduld — probeer het over een paar minuten opnieuw.' });

  const v = valideerLabAanmelding(req.body);
  if (!v.ok) return res.status(400).json({ ok: false, code: 'ongeldig', veld: v.veld, fout: v.fout });
  if (v.bot) return res.status(200).json({ ok: true, event_id: null, bericht: BERICHT_OK, boek_token: null });
  const d = v.data;

  const aanmeldingId = crypto.randomUUID();
  const ip = extractClientIp(req);
  const userAgent = String(req.headers?.['user-agent'] || '').slice(0, 400) || null;

  // 1. Lead (fail-soft: zonder lead gaat de lead nog altijd The Lab in).
  let leadId = null;
  try {
    leadId = (await upsertLead(d)).id;
  } catch (e) {
    console.error('[lab-aanmelding] lead mislukt:', e?.message || e);
  }
  await koppelFunnelSessie(d.session_id, leadId);

  // 2. De touch zelf, vóór het LMS-werk: mislukt dat, dan staat de aanmelding
  //    er toch en pakt de opvolgcron hem opnieuw op.
  const bewaard = await bewaarAanmelding({
    id: aanmeldingId, lead_id: leadId,
    email: d.email, voornaam: d.voornaam, achternaam: d.achternaam, telefoon_e164: d.telefoon_e164,
    toestemming: d.toestemming, hook: d.hook,
    utm_source: d.utm_source, utm_medium: d.utm_medium, utm_campaign: d.utm_campaign,
    utm_content: d.utm_content, utm_term: d.utm_term,
    landingspagina: d.landingspagina, fbclid: d.fbclid, fbc: d.fbc, fbp: d.fbp,
    ip_hash: hashIp(ip), user_agent: userAgent, is_test: d.is_test,
  });

  // 3 + 4. LMS-account en berichten.
  const uitkomst = await verwerkLmsEnBerichten({ aanmeldingId, leadId, d });
  if (bewaard) await werkAanmeldingBij(aanmeldingId, uitkomst);

  // 5. Meta 'Lead' — één keer per CRM-lead (event_id 'lead_<lead_id>', zelfde als de
  //    website), alleen productie, geen test/bot (api/_lib/meta-lead-poort.js). De
  //    browser vuurt de pixel alleen met het event_id uit dit antwoord.
  // Toestemming advertentiecookies uit het formulier (alleen true telt) → op de lead + de poort.
  const advToestemming = toestemmingUitBody(req.body);
  await legToestemmingVast(supabaseAdmin, leadId, advToestemming, 'lab-aanmelding');
  const metaLead = await beslisMetaLead(supabaseAdmin, { leadId, email: d.email, userAgent, isTest: d.is_test, toestemming: advToestemming });
  const eventId = metaLead.eventId;
  if (!eventId) console.log('[lab-aanmelding] geen Meta-Lead', { aanmelding: aanmeldingId, reden: metaLead.reden });
  else await stuurLabEvent({
    eventName: 'Lead', eventId, aanmeldingId: bewaard ? aanmeldingId : null,
    userData: labUserData({
      email: d.email, telefoonE164: d.telefoon_e164, voornaam: d.voornaam, achternaam: d.achternaam,
      externalId: leadId || aanmeldingId, fbc: d.fbc, fbp: d.fbp, ip, userAgent,
    }),
    bronUrl: d.landingspagina,
    toestemming: advToestemming,
    customData: { content_name: 'The Lab', content_category: LAB_SLUG, funnel: d.funnel || LAB_SLUG },
  });

  console.log('[lab-aanmelding]', { aanmelding: aanmeldingId, lead: leadId, funnel: d.funnel, resultaat: uitkomst.resultaat, mail: uitkomst.mail_status, wa: uitkomst.wa_status, hook: d.hook, test: d.is_test });
  // Boektoken voor de bedankpagina van de funnels (meteen de sessie plannen).
  // Elke bewaarde aanmelding krijgt er één — ook een bestaande student — zodat
  // het antwoord voor elk adres dezelfde vorm heeft (geen orakel).
  const boekToken = bewaard ? maakBoektoken({ aanmeldingId, funnel: d.funnel }) : null;
  return res.status(200).json({ ok: true, event_id: eventId, bericht: uitkomst.resultaat === 'lms_fout' ? BERICHT_LATER : BERICHT_OK, boek_token: boekToken });
}
