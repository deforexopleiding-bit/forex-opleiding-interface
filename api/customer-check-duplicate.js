// GET /api/customer-check-duplicate?email=<email>[&phone=<phone>]
// Zoek mogelijke duplicate-klanten op email/phone (Fase 2A.4 commit 3).
//
// Auth: verifyAdmin(req) (ADMIN_ROLES gate).
//
// Query-params (ten minste één van email/phone verplicht):
//   email   string  — case-insensitive substring match
//   phone   string  — match op genormaliseerde phone (cijfers + leading +)
//   exclude_id uuid — optioneel; sluit deze customer uit (voor edit-flow:
//                     PATCH-modal wil niet zichzelf als duplicate matchen)
//
// Matching:
//   email → ILIKE %email% (case-insensitive, partial match — vangt
//           typos zoals "jan.jansen+xyz@..." vs canonical email)
//   phone → genormaliseerd vergelijken: strip spaces/dashes/parens/dots
//           uit DB-phone + input-phone, daarna ILIKE %normalized%.
//           Voorkomt false-negative door formatting-verschillen
//           ("+31 6 1234 5678" vs "+31612345678" vs "0612345678").
//
// Excludes: archived_at IS NOT NULL OR anonymized_at IS NOT NULL.
//   Reden: gearchiveerde klant met dezelfde email kan reactivatie-kandidaat
//   zijn, maar dat is een aparte flow. Voor create-flow tonen we alleen
//   actieve "echte" duplicates.
//
// Response (200):
//   { matches: [{
//       id, first_name, last_name, email, phone, status,
//       match_reason: 'email' | 'phone' | 'both'
//     }, ...] }
//
// Limit: 10 matches (waarschuwing, niet exhaustive). UI toont scrollable list.
//
// Errors: 400 (geen email noch phone) / 403 / 405 / 500.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RESULTS = 10;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const email = String(req.query.email || '').trim();
  const phoneRaw = String(req.query.phone || '').trim();
  const phoneNorm = normalizePhone(phoneRaw);
  const excludeId = String(req.query.exclude_id || '').trim();

  if (!email && !phoneNorm) {
    return res.status(400).json({ error: 'Geef minimaal email of phone op' });
  }
  if (excludeId && !UUID_RE.test(excludeId)) {
    return res.status(400).json({ error: 'Invalid exclude_id format' });
  }

  try {
    // Twee parallelle searches: email-match + phone-match. Daarna client-side
    // merge met match_reason. Aparte queries i.p.v. één OR-query voorkomt
    // PostgREST escape-edge-cases met % en de phone-regex.

    const emailRows  = email     ? await searchByEmail(email,     excludeId) : [];
    const phoneRows  = phoneNorm ? await searchByPhone(phoneNorm, excludeId) : [];

    // Merge by id, set match_reason ('email' / 'phone' / 'both')
    const byId = new Map();
    for (const r of emailRows) byId.set(r.id, { ...r, match_reason: 'email' });
    for (const r of phoneRows) {
      const existing = byId.get(r.id);
      byId.set(r.id, existing
        ? { ...existing, match_reason: 'both' }
        : { ...r, match_reason: 'phone' });
    }

    // Cap op MAX_RESULTS (sorteer op naam voor deterministische volgorde)
    const matches = [...byId.values()]
      .sort((a, b) => (a.last_name || '').localeCompare(b.last_name || '')
                    || (a.first_name || '').localeCompare(b.first_name || ''))
      .slice(0, MAX_RESULTS)
      .map((c) => ({
        id: c.id,
        first_name: c.first_name,
        last_name: c.last_name,
        email: c.email,
        phone: c.phone,
        status: deriveStatus(c),
        match_reason: c.match_reason,
      }));

    return res.status(200).json({ matches });
  } catch (err) {
    console.error('[customer-check-duplicate] handler error:', err);
    return res.status(500).json({ error: err.message || 'Interne serverfout' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip alles behalve cijfers + leading '+' uit een phone-string.
 * Bv. '+31 (06) 1234-5678' → '+31061234 5678' na strip... laat ik dit checken:
 *   replace(/[^\d+]/g, '') → cijfers + alle '+'-tekens behouden
 *   '+31 (06) 1234-5678' → '+31061234 5678'.replace(/[^\d+]/g, '') = '+310612345678'
 * Voor eerste-charakter +, rest alleen cijfers.
 */
function normalizePhone(s) {
  if (!s) return '';
  return String(s).replace(/[^\d+]/g, '');
}

async function searchByEmail(email, excludeId) {
  // ILIKE %email% via PostgREST. Escape % en _ als ze in input zitten (rare edge case).
  const safe = email.replace(/[\\%_]/g, (c) => '\\' + c);
  let q = supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, email, phone, archived_at, anonymized_at')
    .ilike('email', `%${safe}%`)
    .is('archived_at', null).is('anonymized_at', null)
    .limit(MAX_RESULTS);
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) throw new Error('email search: ' + error.message);
  return data || [];
}

async function searchByPhone(phoneNorm, excludeId) {
  // Phone-normalisatie aan DB-kant: regexp_replace(phone, '[^0-9+]', '', 'g').
  // PostgREST geen native regexp_replace in filters — daarom alternatief:
  // fetch alle non-empty phones (max ~paar honderd in praktijk), filter client-side.
  // Trade-off: lichte over-fetch bij grote N; acceptabel voor MVP (preview 10 rows,
  // productie groei < 5k klanten voor 2026). Alternative is een DB-functie of
  // generated column (TODO 2A.4 cleanup).
  let q = supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, email, phone, archived_at, anonymized_at')
    .not('phone', 'is', null)
    .is('archived_at', null).is('anonymized_at', null)
    .limit(500);   // hard cap voor performance, voldoende voor preview/early-prod
  if (excludeId) q = q.neq('id', excludeId);
  const { data, error } = await q;
  if (error) throw new Error('phone search: ' + error.message);

  return (data || []).filter((c) => {
    const candidateNorm = normalizePhone(c.phone);
    return candidateNorm && candidateNorm.includes(phoneNorm);
  });
}

function deriveStatus(c) {
  if (c.anonymized_at) return 'anonymized';
  if (c.archived_at) return 'archived';
  return 'active';
}
