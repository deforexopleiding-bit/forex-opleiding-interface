// api/_lib/contentmachine-http.js
//
// Contentmachine — gedeelde poort voor api/contentmachine/*.js:
// login + recht content.machine (super_admin altijd). Plus de herkenning van
// "migratie nog niet gedraaid" zodat de module dat netjes kan tonen.

import { createUserClient, supabaseAdmin } from '../supabase.js';
import { requirePermission } from './requirePermission.js';

export const RECHT = 'content.machine';
export const MIGRATIE = 'docs/sql-migrations/2026-10-23-contentmachine-fase1.sql';

/** → { user, profiel } of null (en dan is de response al verstuurd). */
export async function poort(req, res, { methodes = ['GET', 'POST'] } = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (!methodes.includes(req.method)) { res.status(405).json({ error: methodes.join('/') + ' only' }); return null; }
  const supabase = createUserClient(req);
  const { data: { user } = {} } = await supabase.auth.getUser();
  if (!user) { res.status(401).json({ error: 'Niet geauthenticeerd' }); return null; }
  if (!(await requirePermission(req, RECHT))) { res.status(403).json({ error: `Geen rechten (${RECHT})` }); return null; }
  const { data: profiel } = await supabaseAdmin.from('profiles').select('id,email,full_name,role').eq('id', user.id).maybeSingle();
  return { user, profiel: profiel || { id: user.id, email: user.email, role: null } };
}

export function isOntbrekendeTabel(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return /could not find the table|does not exist/i.test(String(err.message || ''));
}

/** Stuur een fout terug; ontbrekende tabel → 409 MIGRATIE_NODIG. */
export function fout(res, tag, e, status = 500) {
  if (isOntbrekendeTabel(e)) {
    return res.status(409).json({ error: `De Contentmachine-tabellen bestaan nog niet — draai ${MIGRATIE}.`, code: 'MIGRATIE_NODIG' });
  }
  console.error(`[${tag}] fout:`, e?.code || '', e?.message || e);
  return res.status(status).json({ error: e?.publiek || 'Er ging iets mis', detail: e?.message || null });
}

export function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
