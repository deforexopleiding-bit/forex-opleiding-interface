// api/_lib/ghl-telefoon.js
//
// Het nummer van een GHL-afspraak naar follow_up_appointments.lead_phone, met
// onze eigen leaddata als bevestiging (zie telefoonUitGhl in phone-e164.js).
// Gedeeld door de appointment-poll, de go-live-import en de contact-backfill.
// Alleen als GHL de verdachte vorm +314[5-9]… geeft, lezen we de lead (één
// query); anders is er niets te bevestigen.

import { supabaseAdmin } from '../supabase.js';
import { telefoonUitGhl, isMogelijkBeGsmUitGhl, telefoonNlBe } from './phone-e164.js';

/** Escape voor ilike: geen wildcards uit een e-mailadres. */
function exact(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * @param {{ ghlTelefoon: *, email?: ?string, bestaand?: ?string, bron?: string }} p
 * @returns {Promise<?string>}
 */
export async function leadTelefoonUitGhl({ ghlTelefoon, email = null, bestaand = null, bron = 'ghl' }) {
  const kandidaat = telefoonNlBe(ghlTelefoon, { bron });
  if (!isMogelijkBeGsmUitGhl(kandidaat)) return kandidaat;
  const onze = [bestaand];
  if (email && String(email).trim()) {
    try {
      const { data } = await supabaseAdmin
        .from('leads')
        .select('telefoon_e164')
        .ilike('email', exact(String(email).trim()))
        .limit(5);
      for (const r of data || []) onze.push(r.telefoon_e164);
    } catch (e) {
      console.warn('[ghl-telefoon] lead lezen (soft):', e?.message || e);
    }
  }
  const uit = telefoonUitGhl(kandidaat, { onze, bron });
  if (uit !== kandidaat) console.log('[ghl-telefoon] GHL-nummer rechtgezet met onze eigen data', { bron, van: kandidaat, naar: uit });
  return uit;
}
