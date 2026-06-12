// api/_lib/event-label-matcher.js
// Reverse-lookup van een (mogelijk inconsistente) GHL/legacy-label-string
// naar een event-id. Gebruikt dezelfde formatEventLabel als de F2 outbound
// (computeUpcomingLabels) als BRON van candidates, maar matched TOLERANT:
// het ' | <niveau>'-suffix is OPTIONEEL aan beide kanten en wordt alleen
// als tiebreaker gebruikt, niet als onderdeel van de canonical key.
//
// Reden: GHL heeft eerder labels zonder niveau-suffix opgeslagen
// (voorbeeld: 'Zaterdag 13 juni 2026 | 10:00 - 13:00'). De F2-export
// produceert nu wél een niveau-suffix waar mogelijk. Een exacte
// string-match zou die historische rijen missen. Daarom matchen we op
// `(date, startTime)` als canonical key, met endTime + niveau als
// tiebreakers in die volgorde.
//
// Deze resolver is bewust geïsoleerd zodat zowel de inbound webhook
// (api/events-signup-inbound.js) als de Fase 0-backfill van de 92
// bestaande GHL-contacten 1-op-1 dezelfde logica gebruiken.

import { supabaseAdmin } from '../supabase.js';
import { formatEventLabel } from './ghl-custom-field.js';

// Selectiecriteria voor candidates. Bewust BREDER dan computeUpcomingLabels:
// geen signups_closed-filter en 24u terugkijken op starts_at. Zo vinden we
// ook een zojuist gesloten of net-gestart event als legacy-label binnenkomt.
const MATCH_BACKLOOK_HOURS = 24;

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
 * Parse een label-string naar { date, startTime, endTime?, niveau? }.
 *
 * Verwacht formaat (zoals formatEventLabel produceert; legacy varianten
 * volgen hetzelfde patroon zonder niveau-suffix):
 *   '<Weekday> <day> <month> <year> | HH:MM[ - HH:MM][ | <Niveau>]'
 *
 * Voorbeelden die we moeten kunnen parsen:
 *   'Woensdag 24 juni 2026 | 18:00 - 21:00 | Gevorderd'   (full)
 *   'Woensdag 24 juni 2026 | 18:00 - 21:00'               (no niveau)
 *   'Woensdag 24 juni 2026 | 18:00 | Gevorderd'           (no ends_at)
 *   'Woensdag 24 juni 2026 | 18:00'                       (minimum)
 *
 * Returnt null bij onparsebare input zodat caller 'no-match'/error-pad
 * kan kiezen zonder uitzondering.
 */
export function parseLabelTime(s) {
  if (typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  const parts = trimmed.split('|').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const date      = parts[0];
  const timeRange = parts[1];
  const niveau    = parts.length >= 3 ? parts[2] : null;

  const timeMatch = timeRange.match(/^(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?$/);
  if (!timeMatch) return null;

  // Normaliseer HH:MM naar 2-digit hours (formatEventLabel gebruikt 24h
  // 2-digit format dankzij Intl). Maar voor robuustheid tegen handmatig
  // gewijzigde GHL-strings ('9:00' i.p.v. '09:00') padden we naar 2-digit.
  const padTime = (t) => {
    const [h, m] = t.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  };

  return {
    date,
    startTime: padTime(timeMatch[1]),
    endTime  : timeMatch[2] ? padTime(timeMatch[2]) : null,
    niveau   : niveau ? niveau.toLowerCase() : null,
  };
}

/**
 * resolveEventByLabel(label)
 *
 * Tolerant resolver: matched op de canonical key (date, startTime). Het
 * niveau-suffix is OPTIONEEL aan beide kanten - input zonder niveau matcht
 * candidates met niveau (en omgekeerd). Bij 2+ canonical-matches probeert
 * de resolver in volgorde:
 *   1. endTime gelijk (als beide zijden een endTime hebben),
 *   2. niveau gelijk (als beide zijden een niveau hebben),
 *   3. anders ambiguous.
 *
 * @param {string} label - de string die GHL terugstuurt of die in een
 *                          legacy contact-record staat.
 * @returns {Promise<{
 *   matches       : Array<eventRow>,
 *   reason        : 'unparseable-label' |
 *                   'no-canonical-match' |
 *                   'unique-canonical-match' |
 *                   'endtime-tiebreaker' |
 *                   'niveau-tiebreaker' |
 *                   'ambiguous-multiple-canonical-matches' |
 *                   'ambiguous-after-niveau',
 *   input         : parsedLabel | null,
 *   candidateCount: number
 * }>}
 *
 * Caller interpreteert matches.length:
 *   0 -> match_status='no_match' (zie reason voor onparsebaar vs geen-kandidaat)
 *   1 -> match_status='matched'
 *   2+ -> match_status='ambiguous' (bewaart match_candidate_ids)
 */
export async function resolveEventByLabel(label) {
  const input = parseLabelTime(label);
  if (!input) {
    return {
      matches       : [],
      reason        : 'unparseable-label',
      input         : null,
      candidateCount: 0,
    };
  }

  const candidates = await loadCandidates();
  const parsed = candidates
    .map((row) => ({ row, parts: parseLabelTime(formatEventLabel(row)) }))
    .filter((c) => c.parts !== null);

  // Canonical filter: date + startTime.
  const canonMatches = parsed.filter((c) =>
    c.parts.date.toLowerCase() === input.date.toLowerCase() &&
    c.parts.startTime === input.startTime
  );

  if (canonMatches.length === 0) {
    return {
      matches       : [],
      reason        : 'no-canonical-match',
      input,
      candidateCount: candidates.length,
    };
  }
  if (canonMatches.length === 1) {
    return {
      matches       : [canonMatches[0].row],
      reason        : 'unique-canonical-match',
      input,
      candidateCount: candidates.length,
    };
  }

  // Tiebreaker 1: endTime (alleen relevant als BEIDE een endTime hebben).
  let pool = canonMatches;
  if (input.endTime) {
    const endMatches = pool.filter((c) => c.parts.endTime === input.endTime);
    if (endMatches.length === 1) {
      return {
        matches       : [endMatches[0].row],
        reason        : 'endtime-tiebreaker',
        input,
        candidateCount: candidates.length,
      };
    }
    if (endMatches.length > 1) pool = endMatches;
    // Bij 0 endMatches: VAL TERUG op de bredere pool (canonMatches). Sommige
    // legacy-labels hebben helemaal geen endTime in de DB-event-vorm.
  }

  // Tiebreaker 2: niveau (alleen relevant als BEIDE een niveau hebben).
  if (input.niveau) {
    const niveauMatches = pool.filter((c) =>
      c.parts.niveau && c.parts.niveau === input.niveau
    );
    if (niveauMatches.length === 1) {
      return {
        matches       : [niveauMatches[0].row],
        reason        : 'niveau-tiebreaker',
        input,
        candidateCount: candidates.length,
      };
    }
    if (niveauMatches.length > 1) {
      return {
        matches       : niveauMatches.map((c) => c.row),
        reason        : 'ambiguous-after-niveau',
        input,
        candidateCount: candidates.length,
      };
    }
    // 0 niveau-matches: VAL TERUG op bredere pool. Input had een niveau,
    // candidates niet (legacy-events of mismatch-niveau) - we kunnen niet
    // disambigueren maar willen niet falen.
  }

  return {
    matches       : pool.map((c) => c.row),
    reason        : 'ambiguous-multiple-canonical-matches',
    input,
    candidateCount: candidates.length,
  };
}
