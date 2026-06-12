// api/_lib/event-label-matcher.js
// Reverse-lookup van een GHL-dropdown-label naar een event-id. Gebruikt
// dezelfde formatEventLabel als de F2 outbound (computeUpcomingLabels), dus
// per definitie deterministisch en zonder drift.
//
// Geen persistentie van labels per event nodig: bij ontvangst van een
// inbound-webhook fetchen we alle relevante events en re-computen we de
// labels server-side. Bij 0 of 2+ matches signaleert dit aan de caller
// (inbound-endpoint of admin-resolve) om de inbox-rij gepast te markeren.

import { supabaseAdmin } from '../supabase.js';
import { formatEventLabel } from './ghl-custom-field.js';

// Selectiecriteria voor reverse-lookup. Bewust BREDER dan
// computeUpcomingLabels (geen signups_closed filter, en 1 dag terugkijken)
// zodat een webhook die net na een close-flow binnenkomt nog steeds een
// match kan produceren - dan kan admin alsnog beslissen of we de attendee
// toch koppelen of in incasso/wachtlijst zetten.
const MATCH_BACKLOOK_HOURS = 24;

/**
 * Lookup events die mogelijk matchen op label. Returnt rijen met genoeg
 * velden om formatEventLabel + de eigenlijke registratie-flow te kunnen
 * doen (capacity / webflow_item_id voor seat-fill helpers).
 */
async function loadCandidates() {
  const cutoffIso = new Date(Date.now() - MATCH_BACKLOOK_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('events')
    .select('id, title, starts_at, ends_at, niveau, status, capacity, signups_closed, webflow_item_id')
    .eq('status', 'published')
    .gt('starts_at', cutoffIso)
    .order('starts_at', { ascending: true })
    .limit(500);
  if (error) throw new Error('event-label-matcher candidates: ' + error.message);
  return data || [];
}

/**
 * Vind alle events waarvan formatEventLabel exact gelijk is aan `label`.
 *
 * @param {string} label - de string die GHL terugstuurt (gekozen dropdown-optie)
 * @returns {Promise<{ matches: Array<event>, candidateCount: number, normalizedLabel: string }>}
 *
 * normalizedLabel = de input getrimd (whitespace-trim aan beide kanten).
 * formatEventLabel produceert geen leading/trailing whitespace, dus voor
 * een fair vergelijk trimmen we de input.
 *
 * Caller interpreteert matches.length:
 *   0 -> match_status='no_match'
 *   1 -> match_status='matched'
 *   2+ -> match_status='ambiguous'
 */
export async function findEventsByLabel(label) {
  const normalized = (typeof label === 'string') ? label.trim() : '';
  if (!normalized) {
    return { matches: [], candidateCount: 0, normalizedLabel: '' };
  }
  const candidates = await loadCandidates();
  const matches = candidates.filter((row) => formatEventLabel(row) === normalized);
  return {
    matches,
    candidateCount: candidates.length,
    normalizedLabel: normalized,
  };
}

/**
 * Convenience-helper: vind het event-id voor een gegeven label binnen een
 * specifiek niveau (handig voor admin-resolve UI waar het niveau bekend is).
 */
export async function findEventsByLabelInNiveau(label, niveau) {
  const result = await findEventsByLabel(label);
  if (!niveau) return result;
  const filtered = result.matches.filter((m) => String(m.niveau || '').toLowerCase() === String(niveau).toLowerCase());
  return { ...result, matches: filtered };
}
