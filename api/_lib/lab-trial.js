// api/_lib/lab-trial.js
//
// "Eén login voor alle funnels" (26 okt 2026). Elke trial-lead — minicursus,
// 7-daagse, webinar, website — krijgt dezelfde bestemming als The Lab: een
// lab-lead in het echte LMS (dfo-lms), met een loginlink en een welkomstmail
// die de belofte uit de advertentie overneemt.
//
// Eén weg voor allemaal: een rij in lab_aanmeldingen (met de herkomst) en
// daarna verwerkLmsEnBerichten() uit lab-aanmelding.js — dezelfde code die The
// Lab al gebruikt. Zo tellen de opvolgmotor (cron-lab-opvolging), het dossier
// en de statistieken in Leadsonderhoud › The Lab vanzelf elke trial mee.
//
// De registratie van de lead in `leads` gebeurt NIET hier: die blijft exact
// zoals ze was (dfo-website /api/lead, /api/webinar-aanmelding). Hier zoeken we
// de lead alleen op om lead_id, telefoon en toestemming mee te geven.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';
import { verwerkLmsEnBerichten } from '../lab-aanmelding.js';
import { productUitBron, variantUitBron, herkomstMarker, isTestEmail, isProduct } from './trial-product.js';

const KOLOM_ONTBREEKT = (e) => e && (e.code === 'PGRST204' || e.code === '42703' || /column .* does not exist|Could not find the '.*' column/i.test(String(e.message || '')));

/** De CRM-lead bij dit adres (niet verwijderd). Null = geen. */
export async function leadOpEmail(email) {
  const { data, error } = await supabaseAdmin.from('leads')
    .select('id, voornaam, achternaam, telefoon_e164, toestemming')
    .ilike('email', String(email || '').trim()).is('verwijderd_op', null)
    .order('aangemaakt', { ascending: true }).limit(1);
  if (error) { console.warn('[lab-trial] lead opzoeken (soft):', error.message); return null; }
  return data?.[0] || null;
}

/**
 * De lab_aanmeldingen-rij. Bestaat er al een voor deze toegang-aanvraag (een
 * herhaling na een LMS-storing), dan die — nooit een tweede trial voor
 * dezelfde aanvraag. Zonder de migratie van 26 okt: de herkomst in
 * landingspagina (zie trial-product.js → herkomstVanAanmelding).
 */
async function bewaarAanmelding(rij, herkomst) {
  if (herkomst.toegang_aanvraag_id) {
    const { data: al, error } = await supabaseAdmin.from('lab_aanmeldingen')
      .select('id').eq('toegang_aanvraag_id', herkomst.toegang_aanvraag_id).limit(1);
    if (!error && al?.[0]) return { id: al[0].id, bewaard: true, hergebruikt: true };
    if (error && !KOLOM_ONTBREEKT(error)) console.warn('[lab-trial] bestaande aanmelding (soft):', error.message);
  }
  const { error } = await supabaseAdmin.from('lab_aanmeldingen').insert({ ...rij, ...herkomst });
  if (!error) return { id: rij.id, bewaard: true };
  if (KOLOM_ONTBREEKT(error)) {
    const { error: e2 } = await supabaseAdmin.from('lab_aanmeldingen').insert({
      ...rij, landingspagina: rij.landingspagina || herkomstMarker(herkomst.product, herkomst.bron),
    });
    if (!e2) return { id: rij.id, bewaard: true };
    console.error('[lab-trial] lab_aanmeldingen insert (zonder herkomst):', e2.message);
    return { id: rij.id, bewaard: false };
  }
  console.error('[lab-trial] lab_aanmeldingen insert:', error.message);
  return { id: rij.id, bewaard: false };
}

/**
 * Geeft een lead zijn trial in het echte LMS. Gooit nooit.
 *
 * @param {object} p
 * @param {string} p.email
 * @param {string|null} [p.voornaam]
 * @param {string|null} [p.achternaam]
 * @param {string|null} [p.telefoon]        E.164
 * @param {boolean|null} [p.toestemming]    null = lezen van de lead
 * @param {string|null} [p.leadId]          null = opzoeken op e-mail
 * @param {string|null} [p.product]         null = afgeleid uit bron/soort
 * @param {string|null} [p.bron]
 * @param {string|null} [p.soort]           toegang_aanvragen.soort (terugval)
 * @param {string|null} [p.toegangAanvraagId]
 * @param {boolean} [p.waAlBevestigd]       de WhatsApp-gate stuurde al "check je mail"
 * @param {boolean} [p.isTest]
 * @returns {Promise<{ ok: boolean, aanmeldingId: string, leadId: string|null, product: string, resultaat: string|null, mail_status: string|null, wa_status: string|null, fout?: string }>}
 */
export async function geefLabTrial(p) {
  const email = String(p.email || '').trim().toLowerCase();
  const product = isProduct(p.product) ? p.product : productUitBron(p.bron, p.soort);
  const bron = p.bron || null;
  const lead = p.leadId ? null : await leadOpEmail(email);
  const leadId = p.leadId || lead?.id || null;
  if (!leadId) console.warn('[lab-trial] geen CRM-lead gevonden voor deze trial', { product, bron });

  let toestemming = p.toestemming;
  let telefoon = p.telefoon || null;
  if (toestemming == null || !telefoon) {
    const l = lead || (leadId ? (await supabaseAdmin.from('leads').select('telefoon_e164, toestemming').eq('id', leadId).maybeSingle()).data : null);
    if (toestemming == null) toestemming = l?.toestemming === true;
    telefoon = telefoon || l?.telefoon_e164 || null;
  }

  const aanmeldingId = crypto.randomUUID();
  const isTest = p.isTest === true || isTestEmail(email);
  const d = {
    email, voornaam: p.voornaam || lead?.voornaam || null, achternaam: p.achternaam || lead?.achternaam || null,
    telefoon_e164: telefoon, toestemming: !!toestemming, hook: null,
    is_test: isTest, product, bron, variant: variantUitBron(bron), wa_al_bevestigd: p.waAlBevestigd === true,
  };
  const b = await bewaarAanmelding({
    id: aanmeldingId, lead_id: leadId, email, voornaam: d.voornaam, achternaam: d.achternaam,
    telefoon_e164: telefoon, toestemming: d.toestemming, hook: null, is_test: isTest, landingspagina: null,
  }, { product, bron, variant: d.variant, toegang_aanvraag_id: p.toegangAanvraagId || null });

  let uit;
  try {
    uit = await verwerkLmsEnBerichten({ aanmeldingId: b.id, leadId, d });
  } catch (e) {
    uit = { resultaat: 'lms_fout', resultaat_detail: String(e?.message || e).slice(0, 300) };
  }
  if (b.bewaard) {
    const { error } = await supabaseAdmin.from('lab_aanmeldingen').update(uit).eq('id', b.id);
    if (error) console.warn('[lab-trial] lab_aanmeldingen bijwerken (soft):', error.message);
  }
  const ok = uit.resultaat && uit.resultaat !== 'lms_fout';
  console.log('[lab-trial]', { aanmelding: b.id, lead: leadId, product, bron, resultaat: uit.resultaat, mail: uit.mail_status, wa: uit.wa_status, test: isTest });
  return {
    ok: !!ok, aanmeldingId: b.id, leadId, product,
    resultaat: uit.resultaat || null, mail_status: uit.mail_status || null, wa_status: uit.wa_status || null,
    ...(ok ? {} : { fout: uit.resultaat_detail || 'lms_fout' }),
  };
}
