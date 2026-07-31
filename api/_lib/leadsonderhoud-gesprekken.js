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
  const module = instelWaarde(s) || 'onboarding';
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
export async function trajectSlugs() {
  const { data } = await supabaseAdmin.from('onderhoud_trajecten').select('slug');
  return new Set((data || []).map((t) => t.slug).filter(Boolean));
}

// De leads die in een traject zitten, met de velden die het postvak nodig heeft.
// "In een traject" = lead.soort komt overeen met een slug uit onderhoud_trajecten.
export async function leadsInTraject() {
  const slugs = [...(await trajectSlugs())];
  if (!slugs.length) return [];
  const { data } = await supabaseAdmin
    .from('leads')
    .select('id, voornaam, achternaam, email, telefoon_e164, soort')
    .in('soort', slugs)
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

// Het mail-postvak (IMAP short-name) waarin de antwoorden op de motor-mails
// binnenkomen. Afgeleid uit hetzelfde afzenderadres als de motor gebruikt, zodat
// het meeverhuist als je LEADSONDERHOUD_MAIL_AFZENDER omzet. welkom@… -> 'welkom'.
export function postvakNaam() {
  const afz = process.env.LEADSONDERHOUD_MAIL_AFZENDER || 'welkom@deforexopleiding.nl';
  return String(afz).split('@')[0].trim().toLowerCase() || 'welkom';
}

// Het kale e-mailadres uit een From-veld ("Naam <adres>" of "adres"), kleine letters.
export function adresUit(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
