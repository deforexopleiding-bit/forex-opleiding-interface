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
 * Retourneert { id, nieuw, authId }. authId is het auth.users-id achter het
 * account (nodig om er server-side een wachtwoord op te zetten via zetWachtwoord).
 */
export async function vindOfMaakAccount({ email, voornaam = null, achternaam = null, leadId = null, van, tot }) {
  const mail = String(email).trim().toLowerCase();

  const { data: bestaand } = await supabaseAdmin
    .from('lms_gebruikers').select('id, lead_id, auth_id').eq('email', mail).maybeSingle();
  if (bestaand) {
    if (leadId && !bestaand.lead_id) {
      await supabaseAdmin.from('lms_gebruikers').update({ lead_id: leadId }).eq('id', bestaand.id);
    }
    return { id: bestaand.id, nieuw: false, authId: bestaand.auth_id || null };
  }

  let authId = null;
  // role:'student' expliciet meegeven, anders valt de handle_new_user-trigger
  // terug op v_role := COALESCE(...->>'role','viewer') → de nieuwe student
  // krijgt CRM-rol 'viewer' en wordt door de LMS-rol-guard geweigerd.
  // full_name idem voor een nette profielnaam (trigger valt anders terug op e-mail).
  // Geldt alleen voor dit LMS-provisioning-pad; andere account-aanmaakpaden
  // (mentoren/CRM/backoffice) lopen hier niet langs.
  const fullName = [voornaam, achternaam].filter(Boolean).join(' ').trim() || null;
  const { data: gemaakt, error: maakFout } = await supabaseAdmin.auth.admin.createUser({
    email: mail, email_confirm: true,
    user_metadata: { voornaam, achternaam, full_name: fullName, role: 'student' },
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
  return { id: nieuw.id, nieuw: true, authId };
}

/**
 * Zet een wachtwoord op een bestaand auth-account (service role).
 * Het wachtwoord wordt NOOIT gelogd en niet gepersist buiten auth.users
 * (gehasht door Supabase). Gooit bij een fout; caller vangt fail-soft af.
 */
export async function zetWachtwoord({ authId, wachtwoord }) {
  if (!authId) throw new Error('zetWachtwoord: authId ontbreekt');
  if (!wachtwoord || String(wachtwoord).length < 8) {
    throw new Error('zetWachtwoord: wachtwoord te kort');
  }
  const { error } = await supabaseAdmin.auth.admin.updateUserById(authId, { password: wachtwoord });
  if (error) throw new Error('auth updateUserById (password): ' + error.message);
}

/** Zet (upsert) een grant; dedup op de unique (gebruiker_id, product_id). */
export async function zetGrant({ gebruikerId, productId, van, tot }) {
  const { error } = await supabaseAdmin.from('lms_toegang').upsert(
    { gebruiker_id: gebruikerId, product_id: productId, toegang_van: van, toegang_tot: tot },
    { onConflict: 'gebruiker_id,product_id' },
  );
  if (error) throw new Error('lms_toegang upsert: ' + error.message);
}
