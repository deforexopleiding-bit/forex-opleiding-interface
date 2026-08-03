// api/_lib/lms-provisioning.js
// Gedeelde LMS-provisioning voor de leads-module (handmatig toevoegen + bewerken).
// Spiegelt geefToegang uit dfo-website. Alles via supabaseAdmin (service role);
// de aanroepende endpoints doen zelf de requirePermission-check.

import { supabaseAdmin } from '../supabase.js';
import { normalizePhoneE164 } from './meta-capi.js';

// Datum 'YYYY-MM-DD' -> ISO-grenzen (begin/eind van de dag, UTC).
export const vanIso = (d) => `${d}T00:00:00.000Z`;
export const totIso = (d) => `${d}T23:59:59.999Z`;

/** +E164 in hetzelfde formaat als leads.telefoon_e164 ('+31…'), of null. */
export function telefoonE164(raw) {
  const d = normalizePhoneE164(raw);
  return d ? '+' + d : null;
}

/**
 * Vind of maak het lms_gebruikers-account voor een e-mail.
 * - Bestaat het al (op email): hergebruiken; koppel lead_id als die nog leeg is.
 * - Anders: auth-user aanmaken (email_confirm=true → OTP-login werkt meteen;
 *   bestaand auth-adres wordt opgepakt) + lms_gebruikers-rij met venster.
 * Retourneert { id, nieuw }.
 */
export async function vindOfMaakAccount({ email, voornaam = null, achternaam = null, leadId = null, van, tot }) {
  const mail = String(email).trim().toLowerCase();

  const { data: bestaand } = await supabaseAdmin
    .from('lms_gebruikers').select('id, lead_id').eq('email', mail).maybeSingle();
  if (bestaand) {
    if (leadId && !bestaand.lead_id) {
      await supabaseAdmin.from('lms_gebruikers').update({ lead_id: leadId }).eq('id', bestaand.id);
    }
    return { id: bestaand.id, nieuw: false };
  }

  let authId = null;
  const { data: gemaakt, error: maakFout } = await supabaseAdmin.auth.admin.createUser({
    email: mail, email_confirm: true, user_metadata: { voornaam, achternaam },
  });
  if (gemaakt?.user) {
    authId = gemaakt.user.id;
  } else if (maakFout) {
    const { data: lijst } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
    const gevonden = (lijst?.users || []).find(u => u.email?.toLowerCase() === mail);
    if (!gevonden) throw new Error('auth createUser: ' + maakFout.message);
    authId = gevonden.id;
  }

  const { data: nieuw, error } = await supabaseAdmin.from('lms_gebruikers').insert({
    auth_id: authId, lead_id: leadId, voornaam, achternaam, email: mail,
    toegang_van: van, toegang_tot: tot,
  }).select('id').single();
  if (error) throw new Error('lms_gebruikers insert: ' + error.message);
  return { id: nieuw.id, nieuw: true };
}

/** Zet (upsert) een grant; dedup op de unique (gebruiker_id, product_id). */
export async function zetGrant({ gebruikerId, productId, van, tot }) {
  const { error } = await supabaseAdmin.from('lms_toegang').upsert(
    { gebruiker_id: gebruikerId, product_id: productId, toegang_van: van, toegang_tot: tot },
    { onConflict: 'gebruiker_id,product_id' },
  );
  if (error) throw new Error('lms_toegang upsert: ' + error.message);
}
