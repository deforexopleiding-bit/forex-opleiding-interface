// api/_lib/assessment-questionnaires.js
//
// FEATURE C — helper voor meerdere benoemde vragenlijsten.
//
// Bestaat sinds migratie 2026-06-17-assessment-multi-questionnaires.sql.
// Tabel: assessment_questionnaires(id, slug, name, is_active, gevorderd_threshold,
//   motivatie_floor, low_mid_threshold, …).
//
// Backward-compat: als de tabel nog niet bestaat (pre-migration), retourneren
// de getter-functies null zodat de oude flow (env-var / defaults in
// assessment-scoring.js) blijft werken.

import { supabaseAdmin } from '../supabase.js';

const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

/**
 * Haal de actieve vragenlijst op. Returnt null als geen actieve rij bestaat
 * (bv. tabel nog niet gemigreerd of geen rij actief).
 */
export async function getActiveQuestionnaire() {
  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_questionnaires')
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold')
      .eq('is_active', true)
      .maybeSingle();
    if (error) {
      console.error('[questionnaires] getActive:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.error('[questionnaires] getActive exception:', e?.message || e);
    return null;
  }
}

/**
 * Haal één vragenlijst op via id.
 */
export async function getQuestionnaireById(id) {
  if (!id) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_questionnaires')
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold, created_at, updated_at')
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error('[questionnaires] getById:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.error('[questionnaires] getById exception:', e?.message || e);
    return null;
  }
}

/**
 * Valideer slug-vorm: lowercase a-z0-9_- en max 64 tekens.
 */
export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug);
}
