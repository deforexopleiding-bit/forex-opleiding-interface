// api/_lib/afspraak-selfservice.js
//
// Gedeelde helpers voor de publieke, getokende self-service-endpoints
// (public-afspraak-info / -verzetten / -annuleren). De dfo-website-pagina
// /afspraak/<token> praat server-to-server met deze endpoints via de
// x-internal-token-header (zoals /api/opstartsessie/*). De afspraak_token is
// het ongokbare (122-bit UUID) self-service-token per afspraak; het endpoint
// resolvet 'm server-side naar de afspraak — appointment_id komt nooit in de URL.

import { supabaseAdmin } from '../supabase.js';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Server-to-server secret (dfo-website proxy). Losstaand van OPSTARTSESSIE_SECRET.
export function checkSelfserviceSecret(req) {
  const secret = process.env.AFSPRAAK_SELFSERVICE_SECRET || null;
  if (!secret) return { ok: false, status: 503, body: { error: 'self-service niet geconfigureerd (AFSPRAAK_SELFSERVICE_SECRET ontbreekt)' } };
  const got = req.headers['x-internal-token'];
  if (!got || got !== secret) return { ok: false, status: 401, body: { error: 'unauthorized' } };
  return { ok: true };
}

// Resolve token → afspraak. Retourneert { appt } of { status, error }.
export async function haalAfspraakViaToken(token) {
  const t = String(token || '').trim();
  if (!UUID_RE.test(t)) return { status: 400, error: 'ongeldig-token' };
  const { data, error } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, ghl_appointment_id, lead_name, lead_email, lead_phone, scheduled_at, duration_minutes, status, zoom_join_url, afspraak_token')
    .eq('afspraak_token', t)
    .maybeSingle();
  if (error) return { status: 500, error: 'db: ' + error.message };
  if (!data)  return { status: 404, error: 'niet-gevonden' };
  return { appt: data };
}

export function voornaamVan(naam) {
  const eerste = String(naam || '').trim().split(/\s+/)[0];
  return eerste || 'daar';
}

// ── Self-service-regels (gedeeld door info/verzetten/annuleren) ──────────────
// 1) Annuleren mag alleen als het NU meer dan 2 uur vóór scheduled_at is.
// 2) Zowel verzetten als annuleren vereisen ALTIJD een serieuze reden.
export const TWEE_UUR_MS = 2 * 60 * 60 * 1000;
export const REDEN_MIN_LENGTE = 15;

// true zodra er ≤ 2 uur tot de afspraak resteert (of de afspraak al voorbij is).
export function binnen2Uur(scheduledAt) {
  const t = new Date(scheduledAt).getTime();
  if (!Number.isFinite(t)) return false;
  return t - Date.now() <= TWEE_UUR_MS;
}

// Serieuze reden: ≥15 tekens, genoeg letters (geen losse cijfers/leestekens) en
// niet één herhaald teken ("aaaaaaaaaaaaaaa"). Bewust mild — de bedoeling is
// nietszeggende invoer weren, niet de klant frustreren.
export function redenGeldig(reden) {
  const t = String(reden || '').trim();
  if (t.length < REDEN_MIN_LENGTE) return false;
  const letters = (t.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
  if (letters < 8) return false;
  const uniek = new Set(t.toLowerCase().replace(/\s+/g, '')).size;
  if (uniek < 5) return false;
  return true;
}

// Normaliseer + kap een aangeleverde reden (of null als leeg).
export function schoonReden(reden, max = 500) {
  const t = String(reden || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}
