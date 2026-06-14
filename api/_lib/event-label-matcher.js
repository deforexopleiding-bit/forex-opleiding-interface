// api/_lib/event-label-matcher.js
// Reverse-lookup van een (mogelijk inconsistente) GHL/legacy-label-string
// naar een event-id. TOLERANT: parseLabelTime trekt datum + starttijd uit de
// string via regex, ongeacht weekday-prefix, titel-prefix, pipes of "om HH:MM".
// Canonical key = (jaar, maand, dag, starttijd). endTime + niveau zijn alleen
// tiebreakers. Zo matchen zowel het canonical pipe-formaat
// ("Zaterdag 20 juni 2026 | 10:00 - 13:00 | Basis") als het natuurlijke
// funnel-formaat ("Gevorderde Forex Masterclass Gent - zaterdag 27 juni 2026 om 10:00").

import { supabaseAdmin } from '../supabase.js';
import { formatEventLabel } from './ghl-custom-field.js';

const MATCH_BACKLOOK_HOURS = 24;

const NL_MONTHS = {
  januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6,
  juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12,
};

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
 * Parse een label-string naar { y, m, d, startTime, endTime?, niveau?, date }.
 * Tolerant: vindt de datum (<dag> <nl-maand> <jaar>) en tijd ergens in de string.
 * Tijd: eerst een range "HH:MM - HH:MM", anders een enkele "HH:MM" (ook na "om").
 * Returnt null als datum of tijd ontbreekt, zodat caller no-match/error kan kiezen.
 */
export function parseLabelTime(s) {
  if (typeof s !== 'string') return null;
  const str = s.trim();
  if (!str) return null;
  const lower = str.toLowerCase();

  const dm = lower.match(
    /(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/
  );
  if (!dm) return null;
  const d = parseInt(dm[1], 10);
  const m = NL_MONTHS[dm[2]];
  const y = parseInt(dm[3], 10);

  const pad = (h, mm) => `${String(parseInt(h, 10)).padStart(2, '0')}:${mm}`;
  let startTime = null;
  let endTime = null;
  const range = str.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (range) {
    startTime = pad(range[1], range[2]);
    endTime   = pad(range[3], range[4]);
  } else {
    const single = str.match(/(\d{1,2}):(\d{2})/);
    if (!single) return null;
    startTime = pad(single[1], single[2]);
  }

  let niveau = null;
  if (lower.includes('gevorderd')) niveau = 'gevorderd';
  else if (lower.includes('basis')) niveau = 'basis';

  return { y, m, d, startTime, endTime, niveau, date: `${d} ${dm[2]} ${y}` };
}

/**
 * Pure match-core (DB-vrij, unit-testbaar). Matched een label tegen een set
 * candidate-event-rijen. Canonical key = (y,m,d,startTime); endTime dan niveau
 * als tiebreakers. Reasons identiek aan voorheen.
 */
export function matchLabelToCandidates(label, candidates) {
  const list = candidates || [];
  const input = parseLabelTime(label);
  if (!input) {
    return { matches: [], reason: 'unparseable-label', input: null, candidateCount: list.length };
  }

  const parsed = list
    .map((row) => ({ row, parts: parseLabelTime(formatEventLabel(row)) }))
    .filter((c) => c.parts !== null);

  const sameDay = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
  const canonMatches = parsed.filter((c) =>
    sameDay(c.parts, input) && c.parts.startTime === input.startTime
  );

  if (canonMatches.length === 0) {
    return { matches: [], reason: 'no-canonical-match', input, candidateCount: list.length };
  }
  if (canonMatches.length === 1) {
    return { matches: [canonMatches[0].row], reason: 'unique-canonical-match', input, candidateCount: list.length };
  }

  let pool = canonMatches;
  if (input.endTime) {
    const endMatches = pool.filter((c) => c.parts.endTime === input.endTime);
    if (endMatches.length === 1) {
      return { matches: [endMatches[0].row], reason: 'endtime-tiebreaker', input, candidateCount: list.length };
    }
    if (endMatches.length > 1) pool = endMatches;
  }

  if (input.niveau) {
    const niveauMatches = pool.filter((c) => c.parts.niveau && c.parts.niveau === input.niveau);
    if (niveauMatches.length === 1) {
      return { matches: [niveauMatches[0].row], reason: 'niveau-tiebreaker', input, candidateCount: list.length };
    }
    if (niveauMatches.length > 1) {
      return { matches: niveauMatches.map((c) => c.row), reason: 'ambiguous-after-niveau', input, candidateCount: list.length };
    }
  }

  return { matches: pool.map((c) => c.row), reason: 'ambiguous-multiple-canonical-matches', input, candidateCount: list.length };
}

/**
 * resolveEventByLabel(label): laadt candidates uit de DB en delegeert naar de
 * pure match-core. Publieke API + return-shape ongewijzigd t.o.v. voorheen.
 */
export async function resolveEventByLabel(label) {
  const candidates = await loadCandidates();
  return matchLabelToCandidates(label, candidates);
}
