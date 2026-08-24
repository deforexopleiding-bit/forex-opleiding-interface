// api/lms-whoami.js
//
// GET → geeft de rol EN naam van de ingelogde gebruiker terug aan het
// externe LMS. Extern-facing endpoint met AUTH: fail-CLOSED overal. Nooit
// rol of naam teruggeven zonder geldige, geverifieerde Supabase-JWT +
// actief profiel.
//
// Contract (LMS): antwoord is UITSLUITEND
//   { "role": "<rol>" | null, "name": "<full_name>" | null }
// — geen e-mail, id, permissions, avatar of andere profielvelden. Bij fout:
// standaard error-shape { error: '...' } met passende status.
//
// CORS: strict op de LMS-origins (geen '*') omdat de browser er een
// Bearer-token overheen stuurt. Naast productie zijn ook de preview-origins
// van hetzelfde LMS-project toegestaan, anders kan er op geen enkele
// branch-preview ingelogd worden. Preflight OPTIONS wordt netjes afgehandeld.
//
// Rol-set die het LMS kan verwachten (autoritatief in code — zie
// api/admin-users.js VALID_ROLES):
//   super_admin | admin | manager | sales | mentor | marketing |
//   administratie | viewer   — of NULL (geen profiel / niet actief).
// Naam: profile.full_name (text) — mag NULL zijn als niet ingevuld.

import { supabase, supabaseAdmin } from './supabase.js';

// LMS-origin (productie). Aanpasbaar zonder aan de logica te sleutelen;
// NOOIT '*' want er gaat een Bearer-token overheen.
const LMS_ORIGIN = 'https://dfo-lms-prototype.vercel.app';

// Preview-origins van HETZELFDE LMS-project. Vercel geeft elke branch-deploy
// een eigen hostnaam (dfo-lms-prototype-git-<branch>-<team>.vercel.app), en
// zonder deze regel blokkeert de browser de call vanaf elke preview — het LMS
// toont dan "tijdelijk niet beschikbaar" en niemand kan er inloggen.
//
// Bewust géén losse wildcard: alleen https, alleen hostnamen die met de
// projectnaam beginnen, alleen op vercel.app, en niets erachter. Reflecteren
// doen we uitsluitend bij een treffer; al het andere krijgt het productie-origin
// terug, wat de browser dan afwijst.
const LMS_PREVIEW_ORIGIN = /^https:\/\/dfo-lms-prototype(?:-[a-z0-9-]+)?\.vercel\.app$/;

/**
 * Welk origin er in de Allow-Origin-header hoort voor dit verzoek.
 * Geëxporteerd zodat de regel los te testen is — dit is een beveiligingsgrens,
 * geen weergavedetail.
 */
export function resolveAllowedOrigin(origin) {
  if (typeof origin === 'string' && LMS_PREVIEW_ORIGIN.test(origin)) return origin;
  return LMS_ORIGIN;
}

function applyCors(req, res) {
  // Vary: Origin is hier geen formaliteit. Het antwoord verschilt nu PER
  // origin, dus zonder deze header kan een cache het antwoord voor de ene
  // preview aan de andere serveren — en dan faalt de CORS-check alsnog.
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin',  resolveAllowedOrigin(req.headers?.origin));
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

export default async function handler(req, res) {
  applyCors(req, res);
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
      .select('role, is_active, full_name')
      .eq('id', user.id)
      .maybeSingle();
    // Geen profiel of gedeactiveerd account → { role: null, name: null }.
    // LMS leidt 'geen toegang' hieruit af (200 zodat de client een
    // deterministische shape leest, niet in error-handling belandt voor
    // een verwachte case).
    if (!profile || !profile.is_active) return res.status(200).json({ role: null, name: null });
    return res.status(200).json({
      role: profile.role || null,
      name: profile.full_name || null,
    });
  } catch (_) {
    // Databasefout mag NIET stilzwijgend als 'geen rol' worden gepresenteerd
    // — dat zou fail-open zijn richting een LMS-fallback. 500 zodat het LMS
    // weet dat 'ie moet retry'en of "tijdelijke fout" tonen i.p.v. de
    // gebruiker onterecht toegang te weigeren.
    return res.status(500).json({ error: 'Internal error' });
  }
}
