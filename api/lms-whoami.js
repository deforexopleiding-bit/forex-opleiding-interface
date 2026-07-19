// api/lms-whoami.js
//
// GET → geeft de rol van de ingelogde gebruiker terug aan het externe LMS.
// Extern-facing endpoint met AUTH: fail-CLOSED overal. Nooit een rol
// teruggeven zonder geldige, geverifieerde Supabase-JWT + actief profiel.
//
// Contract (LMS): antwoord is UITSLUITEND { "role": "<rol>" | null } — geen
// e-mail, naam, id, permissions of andere velden. Bij fout: standaard
// error-shape { error: '...' } met passende status.
//
// CORS: strict op het LMS-origin (geen '*') omdat de browser er een
// Bearer-token overheen stuurt. Preflight OPTIONS wordt netjes afgehandeld.
//
// Rol-set die het LMS kan verwachten (autoritatief in code — zie
// api/admin-users.js VALID_ROLES):
//   super_admin | admin | manager | sales | mentor | marketing |
//   administratie | viewer   — of NULL (geen profiel / niet actief).

import { supabase, supabaseAdmin } from './supabase.js';

// LMS-origin. Aanpasbaar zonder aan de logica te sleutelen; NOOIT '*' want
// er gaat een Bearer-token overheen.
const LMS_ORIGIN = 'https://dfo-lms-prototype.vercel.app';

function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin',  LMS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Vary', 'Origin');
}

export default async function handler(req, res) {
  applyCors(res);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  // ── Auth (fail-CLOSED) ────────────────────────────────────────────────
  const authHeader = req.headers?.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.slice(7).trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  let user;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Unauthorized' });
    user = data.user;
  } catch (_) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── Rol-lookup ────────────────────────────────────────────────────────
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    // Geen profiel of gedeactiveerd account → { role: null }. LMS leidt
    // 'geen toegang' hieruit af (200 zodat de client een deterministische
    // shape leest, niet in error-handling belandt voor een verwachte case).
    if (!profile || !profile.is_active) return res.status(200).json({ role: null });
    return res.status(200).json({ role: profile.role || null });
  } catch (_) {
    // Databasefout mag NIET stilzwijgend als 'geen rol' worden gepresenteerd
    // — dat zou fail-open zijn richting een LMS-fallback. 500 zodat het LMS
    // weet dat 'ie moet retry'en of "tijdelijke fout" tonen i.p.v. de
    // gebruiker onterecht toegang te weigeren.
    return res.status(500).json({ error: 'Internal error' });
  }
}
