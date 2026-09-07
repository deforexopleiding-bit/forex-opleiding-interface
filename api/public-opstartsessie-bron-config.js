// api/public-opstartsessie-bron-config.js
//
// Publieke CONFIG-endpoint voor de agendapagina op deforexopleiding.nl.
// Geeft per bron-slug terug of de vragenlijst (quiz/intake → scoring →
// toelating) aan of uit staat. Server-to-server via x-internal-token ==
// OPSTARTSESSIE_SECRET (least privilege; dfo-website's proxy roept aan,
// de browser NIET direct).
//
// GET ?slug=<bron-slug>
//   Zoekt de bron in public.booking_sources (actief) en leest de kolom
//   `vragenlijst`. Niet gevonden / typo / 'direct' / kolom ontbreekt
//   (pre-migratie) → { vragenlijst: true } (veilige default = huidig gedrag,
//   quiz aan). Alleen een expliciete false zet de vragenlijst uit.
//
// Response:
//   200 { vragenlijst: boolean }
//   401 { error }
//   503 { error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' }
//
// 0 writes. Alleen een SELECT op booking_sources.

import { supabaseAdmin } from './supabase.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth (zelfde patroon als public-opstartsessie-book/-submit).
  const tokenHeader = req.headers['x-internal-token'] || null;
  const verwacht    = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if (!tokenHeader || tokenHeader !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  // Slug normaliseren. Ongeldig/leeg/direct → default (quiz aan).
  let slug = String((req.query || {}).slug || '').trim().toLowerCase();
  if (!slug || slug === 'direct' || !SLUG_RE.test(slug)) {
    return res.status(200).json({ vragenlijst: true });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('booking_sources')
      .select('vragenlijst')
      .eq('slug', slug)
      .eq('actief', true)
      .maybeSingle();
    // 42703 (kolom bestaat nog niet) of geen rij → veilige default true.
    if (error && error.code !== '42703') {
      console.warn('[public-opstartsessie-bron-config] lookup (soft):', error.code, error.message);
    }
    const vragenlijst = data ? (data.vragenlijst !== false) : true;
    return res.status(200).json({ vragenlijst });
  } catch (e) {
    // Fail-safe: bij elke storing quiz AAN houden (huidig gedrag).
    console.error('[public-opstartsessie-bron-config]', e?.message || e);
    return res.status(200).json({ vragenlijst: true });
  }
}
