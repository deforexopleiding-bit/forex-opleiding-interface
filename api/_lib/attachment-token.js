// api/_lib/attachment-token.js
//
// Kortlevende, ondertekende tokens voor /api/email-attachment.
//
// WAAROM DIT BESTAAT
// Bijlagen worden opgehaald via een browser-NAVIGATIE: `<a href download>` en
// `window.open()` in de e-mailmodule. Zulke requests kunnen géén
// Authorization-header meesturen, dus `requireCrmStaff()` erop zetten (zoals
// bij /api/email-body en /api/mark-read) zou het downloaden van bijlagen
// breken. Een ondertekend token in de query-string lost dat op: de href blijft
// een gewone link, maar is alleen bruikbaar als hij kort daarvoor is uitgegeven
// door een geauthenticeerde call.
//
// SCOPE VAN EEN TOKEN
// Een token is gebonden aan (mailbox, uid) — niet aan een individuele
// bijlage-index. Dat is bewust: wie de mail mag lezen mag ook alle bijlagen
// van diezelfde mail lezen, dus index is geen aparte rechtengrens. Zo heeft
// één mail ook maar één token nodig in plaats van N.
//
// UITGIFTE
// /api/email-body mint het token en zet het in zijn response. Dat endpoint is
// al geauthenticeerd (requireCrmStaff) en levert al de bijlagenlijst, dus de
// frontend heeft geen extra round-trip nodig.

import crypto from 'crypto';

const TOKEN_VERSION = 'v1';

/** Standaard geldigheidsduur. Lang genoeg om een geopende mail rustig te
 *  bekijken, kort genoeg dat een gelekte link snel waardeloos is. */
const DEFAULT_TTL_SECONDS = Number(process.env.EMAIL_ATTACHMENT_TOKEN_TTL_SECONDS || 1800);

/**
 * Ondertekensleutel. Bij voorkeur een eigen env-var, zodat je 'm kunt roteren
 * zonder aan de service-role key te komen. Ontbreekt die, dan leiden we een
 * aparte sleutel af uit SUPABASE_SERVICE_ROLE_KEY — die is server-side altijd
 * aanwezig, dus deployen kan zonder nieuwe configuratie. De afleiding zorgt
 * dat de service-role key zelf nooit als HMAC-sleutel wordt hergebruikt.
 */
function signingKey() {
  const dedicated = process.env.EMAIL_ATTACHMENT_TOKEN_SECRET;
  if (dedicated) return Buffer.from(dedicated, 'utf8');

  const fallback = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!fallback) throw new Error('Geen sleutel voor attachment-tokens (zet EMAIL_ATTACHMENT_TOKEN_SECRET)');
  return crypto.createHmac('sha256', fallback).update('email-attachment-token-v1').digest();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Canonieke payload-string — exact dezelfde vorm bij tekenen én verifiëren. */
function payloadString({ mailbox, uid, exp }) {
  return [TOKEN_VERSION, String(mailbox), String(uid), String(exp)].join('|');
}

/**
 * Geef een token uit voor (mailbox, uid).
 * @returns {{ token: string, expiresAt: string }}
 */
export function signAttachmentToken({ mailbox, uid, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  if (!mailbox || uid === undefined || uid === null || uid === '') {
    throw new Error('signAttachmentToken: mailbox en uid zijn verplicht');
  }
  const exp     = Math.floor(Date.now() / 1000) + Number(ttlSeconds);
  const payload = payloadString({ mailbox, uid, exp });
  const sig     = crypto.createHmac('sha256', signingKey()).update(payload).digest();

  return {
    token:     `${TOKEN_VERSION}.${exp}.${b64url(sig)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/**
 * Controleer een token tegen de mailbox+uid die daadwerkelijk opgevraagd
 * worden. Geeft een reden terug i.p.v. alleen false, zodat de caller kan
 * loggen zonder zelf te hoeven raden.
 *
 * @returns {{ ok: boolean, reason?: 'missing'|'malformed'|'expired'|'bad_signature' }}
 */
export function verifyAttachmentToken(token, { mailbox, uid }) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };

  const delen = token.split('.');
  if (delen.length !== 3) return { ok: false, reason: 'malformed' };

  const [versie, expRaw, sigRaw] = delen;
  if (versie !== TOKEN_VERSION) return { ok: false, reason: 'malformed' };

  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  // Verlopen vóór de HMAC checken: scheelt werk en lekt niets extra's.
  if (exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };

  const verwacht = crypto.createHmac('sha256', signingKey())
    .update(payloadString({ mailbox, uid, exp }))
    .digest();

  let geleverd;
  try { geleverd = Buffer.from(sigRaw, 'base64url'); }
  catch { return { ok: false, reason: 'malformed' }; }

  // timingSafeEqual gooit bij ongelijke lengte — eerst zelf checken.
  if (geleverd.length !== verwacht.length) return { ok: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(geleverd, verwacht)) return { ok: false, reason: 'bad_signature' };

  return { ok: true };
}
