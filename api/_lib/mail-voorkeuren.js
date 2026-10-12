// api/_lib/mail-voorkeuren.js
//
// Mailvoorkeuren van leads (afmelden / per soort uit) — één plek voor iedereen
// die marketingmail stuurt: de massa-motor (massa-mail.js, her-exporteert dit)
// en de webinar-opvolging (webinar-opvolging.js). Uitgesplitst 2026-10-12 zodat
// de webinar-lib niet de hele massa-motor hoeft te laden.
//
// Tabel lead_mail_voorkeuren: 1 rij per e-mailadres, met token. De publieke
// pagina staat op dfo-website (/voorkeuren?token=…).

import crypto from 'node:crypto';

export const WEBSITE_URL = String(process.env.WEBSITE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');

export const nieuwToken = () => crypto.randomBytes(32).toString('base64url');
export const voorkeurenUrl = (token) => `${WEBSITE_URL}/voorkeuren?token=${encodeURIComponent(token)}`;
/** One-click afmelden (RFC 8058, POST) — de List-Unsubscribe-header. */
export const afmeldUrl = (token) => `${WEBSITE_URL}/api/voorkeuren?token=${encodeURIComponent(token)}`;

/** Mag dit adres een mail van deze soort krijgen? PURE. */
export function magOntvangen(voorkeur, soort) {
  if (!voorkeur) return { ok: true, reden: null };
  if (voorkeur.afgemeld) return { ok: false, reden: 'afgemeld' };
  const v = voorkeur.voorkeuren && typeof voorkeur.voorkeuren === 'object' ? voorkeur.voorkeuren : {};
  if (soort && v[soort] === false) return { ok: false, reden: 'voorkeur_uit' };
  return { ok: true, reden: null };
}

/** De voorkeur-rij van een adres; maakt hem (met token) aan als hij er nog niet is. */
export async function zorgVoorkeur(sb, email, leadId = null) {
  const adres = String(email || '').trim().toLowerCase();
  const lees = () => sb.from('lead_mail_voorkeuren').select('id, email, token, afgemeld, voorkeuren').eq('email', adres).maybeSingle();
  const { data, error } = await lees();
  if (error) throw new Error('voorkeur lezen: ' + error.message);
  if (data) return data;
  const { data: nieuw, error: insErr } = await sb.from('lead_mail_voorkeuren')
    .insert({ email: adres, lead_id: leadId, token: nieuwToken() })
    .select('id, email, token, afgemeld, voorkeuren').single();
  if (!insErr) return nieuw;
  if (insErr.code === '23505') { // gelijktijdig aangemaakt → die gebruiken
    const { data: d2, error: e2 } = await lees();
    if (e2 || !d2) throw new Error('voorkeur na conflict lezen: ' + (e2?.message || 'leeg'));
    return d2;
  }
  throw new Error('voorkeur aanmaken: ' + insErr.message);
}
