// api/_lib/leadsonderhoud-gesprekken.js
//
// Gedeelde hulpjes voor het Gesprekken-scherm van leadsonderhoud. Eén plek die
// bepaalt (1) op welke WhatsApp-lijn de module hangt en (2) welke gesprekken bij
// leadsonderhoud horen. Zo staat die keuze niet verspreid over drie endpoints.
//
// De lijn is een INSTELLING, geen aanname: app_settings.leadsonderhoud_wa_module
// noemt een module uit whatsapp_module_config (nu 'onboarding'). Zet daar later
// 'leadsonderhoud' met het eigen Esmee-nummer neer en de module verhuist mee,
// zonder codewijziging.

import { supabaseAdmin } from '../supabase.js';
import { instelWaarde } from './leadsonderhoud-sjabloon.js';

const DAG_MS = 24 * 60 * 60 * 1000;

// Nummers vergelijken op alleen de cijfers. whatsapp_conversations.phone_number
// staat als '+3161…', leads.telefoon_e164 idem — maar door verschillen in '+' of
// spaties matchen we op de kale cijferreeks, dat is robuust genoeg voor E.164.
export function normNummer(s) {
  return String(s || '').replace(/\D/g, '');
}

// Binnen het 24-uurs venster? (mag er nog vrije tekst?) Zelfde rekensom als de
// gedeelde inbox-endpoints, zodat de badge overal hetzelfde zegt.
export function binnenVenster(last_inbound_at) {
  if (!last_inbound_at) return false;
  const t = new Date(last_inbound_at).getTime();
  return Number.isFinite(t) && (Date.now() - t) <= DAG_MS;
}

// De WhatsApp-lijn van deze module, afgeleid uit de instelling.
//   -> { module, phoneNumberId, label }   (phoneNumberId=null als niet gezet)
export async function haalLijn() {
  const { data: s } = await supabaseAdmin
    .from('app_settings').select('value').eq('key', 'leadsonderhoud_wa_module').maybeSingle();
  // Default 'leadsonderhoud' (was 'onboarding'): leads horen niet op de
  // klant-/onboardinglijn. Sinds 2026-10-05 draait leadsonderhoud op het
  // 360dialog-hoofdnummer (api/_lib/wa-nummers.js).
  const module = instelWaarde(s) || 'leadsonderhoud';
  const { data: cfg } = await supabaseAdmin
    .from('whatsapp_module_config')
    .select('phone_number_id, display_label')
    .eq('module', module).eq('is_active', true).maybeSingle();
  return {
    module,
    phoneNumberId: cfg ? cfg.phone_number_id : null,
    label: cfg ? cfg.display_label : null,
  };
}

// De slugs van de trajecten (voor "zit deze lead in een traject?").
// LOWERCASE: het traject-type op de lead is gemengd van hoofdletter (bv.
// 'Membership'), dus we vergelijken overal case-insensitive tegen deze set.
export async function trajectSlugs() {
  const { data } = await supabaseAdmin.from('onderhoud_trajecten').select('slug');
  return new Set((data || []).map((t) => (t.slug || '').toLowerCase()).filter(Boolean));
}

// De leads die in een traject zitten, met de velden die het postvak nodig heeft.
// "In een traject" = leads.traject komt (case-insensitive) overeen met een slug
// uit onderhoud_trajecten. Sinds Feature 2 is leads.soort = herkomst en staat het
// traject-type in leads.traject; ilike per slug = hoofdletter-ongevoelige match.
export async function leadsInTraject() {
  const slugs = [...(await trajectSlugs())];
  if (!slugs.length) return [];
  const orFilter = slugs.map((s) => `traject.ilike.${s}`).join(',');
  const { data } = await supabaseAdmin
    .from('leads')
    .select('id, voornaam, achternaam, email, telefoon_e164, traject')
    .or(orFilter)
    .is('verwijderd_op', null)   // verwijderde leads horen niet in het postvak
    .limit(10000);
  return data || [];
}

// De genormaliseerde telefoonnummers van leads-in-een-traject (voor de
// WhatsApp-kant van het filter).
export async function leadNummers() {
  const set = new Set();
  for (const l of await leadsInTraject()) {
    const n = normNummer(l.telefoon_e164);
    if (n) set.add(n);
  }
  return set;
}

// Het volledige afzenderadres van de module (zelfde bron als de motor). Standaard
// welkom@deforexopleiding.nl, via env om te zetten zonder codewijziging.
export function mailAfzender() {
  return (process.env.LEADSONDERHOUD_MAIL_AFZENDER || 'welkom@deforexopleiding.nl').trim().toLowerCase();
}

// Het mail-postvak (IMAP short-name) waarin de antwoorden op de motor-mails
// binnenkomen. Afgeleid uit hetzelfde afzenderadres, zodat het meeverhuist als je
// de afzender omzet. welkom@… -> 'welkom'.
export function postvakNaam() {
  return mailAfzender().split('@')[0].trim() || 'welkom';
}

// Het kale e-mailadres uit een From-veld ("Naam <adres>" of "adres"), kleine letters.
export function adresUit(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// ── Het WA-gesprek van een lead (2026-10-09, verhuisd 2026-10-10) ─────────
// Stond in api/leadsonderhoud-gesprek-berichten.js (#1760). Nu gedeeld, zodat
// ook de "Sjabloon"-route (leadsonderhoud-gesprek-template.js) het gesprek
// direct vindt i.p.v. in een ongesorteerde .limit(500) van de lijn.
const CONV_VELDEN = 'id, phone_number, phone_number_id, last_inbound_at, unread_count';

/** Telefoonnummer-varianten zoals ze in whatsapp_conversations.phone_number kunnen staan. PURE. */
export function nummerVarianten(e164) {
  const d = normNummer(e164);
  return d ? [...new Set(['+' + d, d, '00' + d])] : [];
}

/**
 * Het WhatsApp-gesprek van een lead op de leadsonderhoud-lijn.
 *   1. De conv die de caller al kende (hint): alleen als hij op de lijn staat
 *      en het nummer bij de lead hoort — anders loggen en terugvallen.
 *   2. Anders DIRECT op phone_number_id + de nummervarianten, nieuwste eerst.
 * Nooit "pak N gesprekken en zoek erin" (dat miste >50% op >1000 convs).
 * opts.sb = de client van de caller (default de gedeelde service-role client).
 */
export async function vindLeadConv(lijn, lead, hintId = null, { sb = supabaseAdmin, tag = '[leadsonderhoud-gesprek-berichten]' } = {}) {
  if (!lijn?.phoneNumberId) return null;
  const doel = normNummer(lead?.telefoon_e164);
  if (hintId) {
    const { data, error } = await sb.from('whatsapp_conversations')
      .select(CONV_VELDEN).eq('id', hintId).maybeSingle();
    if (error) {
      console.error(tag + ' conv-hint lezen mislukt:', { hint: hintId, fout: error.message });
    } else if (data && String(data.phone_number_id) === String(lijn.phoneNumberId) && (!doel || normNummer(data.phone_number) === doel)) {
      return data;
    } else {
      console.warn(tag + ' conv-hint past niet bij lead/lijn — zoek op nummer', { hint: hintId, lead: lead?.id, gevonden: !!data });
    }
  }
  if (!doel) return null;
  const { data, error } = await sb.from('whatsapp_conversations')
    .select(CONV_VELDEN)
    .eq('phone_number_id', lijn.phoneNumberId)
    .in('phone_number', nummerVarianten(lead.telefoon_e164))
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) {
    console.error(tag + ' conv op nummer zoeken mislukt:', { lead: lead?.id, fout: error.message });
    return null;
  }
  return (data || [])[0] || null;
}
