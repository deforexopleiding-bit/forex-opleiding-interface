// api/_lib/followup-notitie.js
//
// Eén regel in het notitielog van een lead schrijven.
//
// WAAROM APART
// follow-up-lead-outcome.js heeft hetzelfde nodig en doet het daar met een
// eigen `insertOutcomeNote`. Die laat ik met rust: het is een werkend pad in
// de belmotor en er is geen reden om daaraan te komen. Importeren kan ook
// niet — whatsapp-taak.js wordt dóór dat bestand geïmporteerd, dus andersom
// zou een kringetje opleveren.
//
// Wat hier staat is de kern van dezelfde ladder: probeer met entry_kind en
// outcome_code, en zakt terug zodra de database een van die kolommen niet
// kent. Van follow_up_lead_notes bestaat geen migratie in deze repo, dus
// welke kolommen er precies zijn is van buitenaf niet vast te stellen.

import { supabaseAdmin } from '../supabase.js';

function isMissendeKolom(error) {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = `${error.message || ''} ${error.details || ''} ${error.hint || ''}`;
  return /could not find the/i.test(msg) || /schema cache/i.test(msg);
}

/**
 * Schrijf één notitieregel bij een lead. Gooit nooit — een mislukte notitie
 * mag nooit een handeling tegenhouden die verder wel gelukt is.
 *
 * @returns {Promise<{ok:boolean, id?:string, reden?:string}>}
 */
export async function schrijfLeadNotitie(leadId, tekst, {
  doorUserId  = null,
  entryKind   = 'system',
  outcomeCode = null,
} = {}) {
  if (!leadId || !tekst) return { ok: false, reden: 'lead_id of tekst ontbreekt' };

  const basis = {
    lead_id: leadId,
    note: String(tekst).slice(0, 4000),
    created_by_user_id: doorUserId,
  };
  const pogingen = [
    { ...basis, entry_kind: entryKind, ...(outcomeCode ? { outcome_code: outcomeCode } : {}) },
    { ...basis, entry_kind: entryKind },
    basis,
  ];

  let laatste = null;
  for (const rij of pogingen) {
    const { data, error } = await supabaseAdmin
      .from('follow_up_lead_notes').insert(rij).select('id').maybeSingle();
    if (!error) return { ok: true, id: data?.id || null };
    laatste = error;
    if (!isMissendeKolom(error)) break;
  }
  console.warn('[followup-notitie] schrijven faalde voor lead', leadId, ':', laatste?.message || laatste);
  return { ok: false, reden: laatste?.message || 'onbekend' };
}
