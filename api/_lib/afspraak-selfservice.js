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
