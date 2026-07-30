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

// De genormaliseerde telefoonnummers van leads die in een traject zitten.
// "In een traject" = lead.soort komt overeen met een slug uit onderhoud_trajecten.
// Zo zie je in het Gesprekken-scherm alleen leads-met-traject, niet elk
// onboarding-gesprek dat toevallig op dezelfde lijn binnenkwam.
export async function leadNummers() {
  const { data: trs } = await supabaseAdmin.from('onderhoud_trajecten').select('slug');
  const slugs = (trs || []).map((t) => t.slug).filter(Boolean);
  if (!slugs.length) return new Set();
  const { data: leads } = await supabaseAdmin
    .from('leads')
    .select('telefoon_e164')
    .in('soort', slugs)
    .not('telefoon_e164', 'is', null)
    .limit(10000);
  const set = new Set();
  for (const l of leads || []) {
    const n = normNummer(l.telefoon_e164);
    if (n) set.add(n);
  }
  return set;
}
