// api/_lib/lead-lms-account.js
//
// Gedeelde helpers rond "het LMS-account van een lead":
//   - vindLeadAccount        account zoeken (op lead_id, anders op e-mail)
//   - isEmailBezetFout       auth-fout "adres al in gebruik" herkennen
//   - verplaatsAccountEmail  het BESTAANDE account naar een ander adres zetten
//                            (auth + leads.email + lms_gebruikers.email)
//   - normaliseerProductSlug UI-/legacy-aliassen naar de echte lms_producten.slug
//   - bepaalSoort            welk traject (7-daagse / minicursus) hoort bij de lead
//
// Gebruikt door lead-bijwerken.js, lead-welkom-resend.js en
// lead-toegang-verlenen.js. Alle functies krijgen de (admin-)client mee zodat
// ze zonder module-mocks te testen zijn.
//
// NOOIT een nieuw account aanmaken hier — daarvoor bestaat vindOfMaakAccount
// in lms-provisioning.js ("Geef toegang"). Auth-accounts worden nooit verwijderd.

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normaliseerEmail(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Echte slugs (lms_producten, DB-geverifieerd): '7-daagse', 'minicursus',
// '1-op-1-coaching'. De "Geef toegang"-knop stuurde 'mini-cursus' → 400.
const SLUG_ALIASSEN = new Map([
  ['minicursus', 'minicursus'],
  ['mini-cursus', 'minicursus'],
  ['mini cursus', 'minicursus'],
  ['mini_cursus', 'minicursus'],
  ['mini', 'minicursus'],
  ['2', 'minicursus'],
  ['7-daagse', '7-daagse'],
  ['7 daagse', '7-daagse'],
  ['7daagse', '7-daagse'],
  ['7_daagse', '7-daagse'],
  ['7', '7-daagse'],
  ['1', '7-daagse'],
]);

/**
 * Normaliseer een product-keuze naar de lms_producten.slug. Onbekende waarden
 * gaan lowercased/getrimd door (bv. '1-op-1-coaching'); leeg → null.
 */
export function normaliseerProductSlug(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  return SLUG_ALIASSEN.get(s) || s;
}

/**
 * Welk traject hoort bij deze lead? Bepaalt het mail-sjabloon aan dfo-kant.
 * Bron 1: leads.traject ('minicursus', 'kennismakingscursus-v2', '7-daagse-v1', …).
 * Bron 2 (fallback): welke product-grants het account heeft.
 * @param {{ traject?: string|null, grantSlugs?: string[] }} p
 * @returns {'7-daagse'|'minicursus'|null}
 */
export function bepaalSoort({ traject = null, grantSlugs = [] } = {}) {
  const t = String(traject || '').trim().toLowerCase();
  if (t.startsWith('minicursus') || t.startsWith('mini-cursus') || t.startsWith('kennismakingscursus')) return 'minicursus';
  if (t.startsWith('7-daagse') || t.startsWith('7daagse')) return '7-daagse';
  const g = new Set((grantSlugs || []).map(String));
  if (g.has('minicursus') && !g.has('7-daagse')) return 'minicursus';
  if (g.has('7-daagse')) return '7-daagse';
  return null;
}

/**
 * Toegangsstatus voor de popup: laatste einddatum over het account
 * (lms_gebruikers.toegang_tot) en zijn product-grants. NULL op een grant =
 * onbeperkt. Geen enkele datum → verlopen = null (onbekend).
 */
export function toegangStatus(account, grants, nu = new Date()) {
  const onbeperkt = (grants || []).some((g) => g && g.toegang_tot == null);
  if (onbeperkt) return { toegang_tot: null, onbeperkt: true, verlopen: false };
  const data = [account?.toegang_tot, ...(grants || []).map((g) => g?.toegang_tot)]
    .filter(Boolean).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
  if (!data.length) return { toegang_tot: null, onbeperkt: false, verlopen: null };
  const laatste = new Date(Math.max(...data.map((d) => d.getTime())));
  return { toegang_tot: laatste.toISOString(), onbeperkt: false, verlopen: laatste.getTime() < nu.getTime() };
}

const ACCOUNT_KOLOMMEN = 'id, auth_id, email, lead_id, toegang_tot';

/**
 * Zoek het LMS-account van een lead: eerst op lms_gebruikers.lead_id, anders op
 * het e-mailadres van de lead (veel oudere accounts hebben geen lead_id).
 * @returns {Promise<{ account: object|null, fout: string|null }>}
 */
export async function vindLeadAccount(sb, { leadId, email }) {
  if (leadId) {
    const { data, error } = await sb.from('lms_gebruikers')
      .select(ACCOUNT_KOLOMMEN).eq('lead_id', leadId).maybeSingle();
    if (error) return { account: null, fout: 'lms_gebruikers (lead_id): ' + error.message };
    if (data) return { account: data, fout: null };
  }
  const mail = normaliseerEmail(email);
  if (mail) {
    const { data, error } = await sb.from('lms_gebruikers')
      .select(ACCOUNT_KOLOMMEN).eq('email', mail).maybeSingle();
    if (error) return { account: null, fout: 'lms_gebruikers (email): ' + error.message };
    if (data) return { account: data, fout: null };
  }
  return { account: null, fout: null };
}

/** Herken de GoTrue-fout "dit adres hoort al bij een ander auth-account". */
export function isEmailBezetFout(aErr) {
  if (!aErr) return false;
  const msg = String(aErr.message || '').toLowerCase();
  return msg.includes('already') || msg.includes('registered')
    || aErr.status === 422 || aErr.code === 'email_exists';
}

/**
 * Zet het BESTAANDE account van een lead op een nieuw e-mailadres. Spiegelt de
 * e-mail-sync van lead-bijwerken.js (auth.admin.updateUserById + lms_gebruikers
 * + leads.email), met twee extra's:
 *   1. botsingen worden VOORAF gecontroleerd (ander account / andere lead),
 *      zodat er niets half wordt doorgevoerd;
 *   2. faalt een latere stap toch, dan zetten we de eerdere stappen terug
 *      (best-effort) en melden we dat.
 *
 * @param sb  supabaseAdmin
 * @param {{ account: {id, auth_id, email, lead_id}, leadId: string, oudeLeadEmail: string|null, nieuweEmail: string }} p
 * @returns {Promise<{ ok: true } | { ok: false, status: number, code: string, error: string }>}
 */
export async function verplaatsAccountEmail(sb, { account, leadId, oudeLeadEmail, nieuweEmail }) {
  const nieuw = normaliseerEmail(nieuweEmail);
  const oudAccount = normaliseerEmail(account?.email);
  if (!account?.id) return { ok: false, status: 500, code: 'GEEN_ACCOUNT', error: 'Geen account om te verplaatsen.' };
  if (!EMAIL_RE.test(nieuw)) return { ok: false, status: 400, code: 'ONGELDIG_EMAIL', error: `Ongeldig e-mailadres: ${nieuweEmail}` };
  if (account.lead_id && leadId && String(account.lead_id) !== String(leadId)) {
    return { ok: false, status: 409, code: 'ACCOUNT_VAN_ANDERE_LEAD', error: 'Dit LMS-account hoort bij een andere lead; adres niet gewijzigd.' };
  }

  // 1) Botsing met een ANDER LMS-account?
  {
    const { data, error } = await sb.from('lms_gebruikers').select('id').eq('email', nieuw).maybeSingle();
    if (error) return { ok: false, status: 500, code: 'LEESFOUT', error: 'lms_gebruikers: ' + error.message };
    if (data && String(data.id) !== String(account.id)) {
      return { ok: false, status: 409, code: 'EMAIL_IN_GEBRUIK', error: 'Dit e-mailadres is al in gebruik door een ander LMS-account.' };
    }
  }
  // 2) Botsing met een ANDERE lead? (unieke index op lower(leads.email))
  {
    const { data, error } = await sb.from('leads').select('id').eq('email', nieuw).neq('id', leadId).limit(1);
    if (error) return { ok: false, status: 500, code: 'LEESFOUT', error: 'leads: ' + error.message };
    if (Array.isArray(data) && data.length) {
      return { ok: false, status: 409, code: 'EMAIL_IN_GEBRUIK', error: 'Dit e-mailadres is al in gebruik door een andere lead.' };
    }
  }

  // 3) Auth-account (de inlog zelf). Eerst, zodat een auth-botsing niets raakt.
  let authGewijzigd = false;
  if (account.auth_id) {
    const { error: aErr } = await sb.auth.admin.updateUserById(account.auth_id, { email: nieuw });
    if (aErr) {
      if (isEmailBezetFout(aErr)) {
        return { ok: false, status: 409, code: 'EMAIL_IN_GEBRUIK', error: 'Dit e-mailadres is al in gebruik door een ander account.' };
      }
      return { ok: false, status: 500, code: 'AUTH_FOUT', error: 'auth updateUserById: ' + aErr.message };
    }
    authGewijzigd = true;
  }
  const authTerug = async () => {
    if (!authGewijzigd || !oudAccount) return;
    const { error } = await sb.auth.admin.updateUserById(account.auth_id, { email: oudAccount });
    if (error) console.error('[lead-lms-account] auth-terugzetten mislukt:', account.auth_id, error.message);
  };

  // 4) Lead-adres meeverhuizen (zelfde semantiek als lead-bijwerken: de lead
  //    en zijn inlog delen één adres).
  {
    const { error } = await sb.from('leads').update({ email: nieuw }).eq('id', leadId);
    if (error) {
      await authTerug();
      if (error.code === '23505' || /duplicate key|leads_email_uniek/i.test(error.message || '')) {
        return { ok: false, status: 409, code: 'EMAIL_IN_GEBRUIK', error: 'Dit e-mailadres is al in gebruik door een andere lead.' };
      }
      return { ok: false, status: 500, code: 'SCHRIJFFOUT', error: 'leads update: ' + error.message };
    }
  }

  // 5) LMS-gebruikersrij. Koppel meteen lead_id als die nog leeg was.
  {
    const patch = { email: nieuw };
    if (!account.lead_id && leadId) patch.lead_id = leadId;
    const { error } = await sb.from('lms_gebruikers').update(patch).eq('id', account.id);
    if (error) {
      const { error: lErr } = await sb.from('leads').update({ email: oudeLeadEmail || null }).eq('id', leadId);
      if (lErr) console.error('[lead-lms-account] lead-terugzetten mislukt:', leadId, lErr.message);
      await authTerug();
      if (error.code === '23505') {
        return { ok: false, status: 409, code: 'EMAIL_IN_GEBRUIK', error: 'Dit e-mailadres is al in gebruik door een ander LMS-account.' };
      }
      return { ok: false, status: 500, code: 'SCHRIJFFOUT', error: 'lms_gebruikers update: ' + error.message };
    }
  }
  return { ok: true };
}
