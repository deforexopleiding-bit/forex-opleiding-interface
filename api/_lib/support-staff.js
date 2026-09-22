// api/_lib/support-staff.js
//
// Gedeelde voorkant voor de ingelogde-medewerker-endpoints van de
// supportmodule: wie ben je, mag je dit, en hoe heet je.
//
// De naam hebben we nodig omdat die in de chat bij de bezoeker verschijnt
// ("Maxim: ..."). Eén lookup hier scheelt 'm in vier endpoints.

import { supabase, supabaseAdmin } from '../supabase.js';
import { checkPermissionOrDeny } from './requirePermission.js';

/**
 * Authenticeer + autoriseer. Returnt null als het antwoord al verstuurd is.
 *
 * @param {object} req
 * @param {object} res
 * @param {string} recht — feature-key, bv. 'support.reply'
 * @returns {Promise<{user:object, naam:string}|null>}
 */
export async function staffUit(req, res, recht) {
  const header = req.headers?.authorization || '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Niet geauthenticeerd' });
    return null;
  }

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(header.slice(7));
    if (error || !data?.user) throw new Error('geen user');
    user = data.user;
  } catch (_) {
    res.status(401).json({ error: 'Niet geauthenticeerd' });
    return null;
  }

  if (!(await checkPermissionOrDeny(req, res, recht))) return null;

  let naam = null;
  try {
    const { data } = await supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .maybeSingle();
    naam = data?.full_name || null;
  } catch (_) { /* naam is prettig, niet kritiek */ }

  return { user, naam: naam || 'Support' };
}

/** Nette methode-check met Allow-header. */
export function verkeerdeMethode(req, res, toegestaan) {
  const lijst = Array.isArray(toegestaan) ? toegestaan : [toegestaan];
  if (lijst.includes(req.method)) return false;
  res.setHeader('Allow', lijst.join(', '));
  res.status(405).json({ error: `Method ${req.method} not allowed` });
  return true;
}

/** Standaardheaders voor de interne endpoints. */
export function basisHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
}
