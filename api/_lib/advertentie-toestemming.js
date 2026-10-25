// api/_lib/advertentie-toestemming.js
//
// Toestemming voor advertentiecookies (2026-10-25) — de CRM-kant van de
// Meta-gate. Spiegel van dfo-website lib/advertentie-toestemming.ts.
//
// Regel: er gaat NIETS naar Meta (CAPI) voor iemand zonder toestemming.
//   · Aanmeldingen die het CRM zelf ontvangt (The Lab): de keuze staat in de
//     body (`cookie_toestemming`), alleen een expliciete true telt.
//   · Events die later volgen (Lab-Schedule, LabGestart/LabAfgewerkt,
//     CRMCustomer): de keuze op de lead (leads.advertentie_toestemming, gezet bij
//     elke aanmelding — de laatste keuze telt).
// FAIL-CLOSED: geen lead, NULL, kolom bestaat nog niet of een leesfout → geen
// toestemming. Migratie: dfo-website docs/sql-migrations/2026-10-25-leads-advertentie-toestemming.sql.

/** Body van een aanmelding: alleen `cookie_toestemming === true` telt. PURE. */
export function toestemmingUitBody(body) {
  return !!body && typeof body === 'object' && body.cookie_toestemming === true;
}

/**
 * Heeft deze lead toestemming? Zoekt op lead-id, anders op e-mail.
 * Gooit nooit; elke twijfel = false.
 */
export async function leadHeeftToestemming(sb, { leadId = null, email = null } = {}) {
  try {
    let q = sb.from('leads').select('advertentie_toestemming').is('verwijderd_op', null).limit(1);
    if (leadId) q = q.eq('id', leadId);
    else if (email) q = q.ilike('email', String(email).trim().toLowerCase());
    else return false;
    const { data, error } = await q;
    if (error) {
      if (!['42703', 'PGRST204'].includes(String(error.code))) {
        console.warn('[advertentie-toestemming] lezen mislukt → geen toestemming', { code: error.code, fout: error.message });
      }
      return false;
    }
    return data?.[0]?.advertentie_toestemming === true;
  } catch (e) {
    console.warn('[advertentie-toestemming] exception → geen toestemming', e?.message || e);
    return false;
  }
}

/** De keuze van deze aanmelding op de lead (laatste keuze telt). Fail-soft. */
export async function legToestemmingVast(sb, leadId, toestemming, label) {
  if (!leadId) return;
  try {
    const { error } = await sb.from('leads')
      .update({ advertentie_toestemming: toestemming === true, advertentie_toestemming_op: new Date().toISOString() })
      .eq('id', leadId);
    if (error) console.warn(`[${label}] advertentie-toestemming niet vastgelegd (soft)`, { leadId, code: error.code, fout: error.message });
  } catch (e) {
    console.warn(`[${label}] advertentie-toestemming exception (soft)`, { leadId, fout: e?.message || String(e) });
  }
}
