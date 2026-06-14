// api/_lib/assessment-validation.js
// Shared helpers voor assessment-submit: config-load + answer-validation +
// IP-hash voor rate-limit. Pure functions zodat unit-tests + endpoint
// dezelfde logic delen. Vercel routet _-prefixed files niet als endpoint.

import crypto from 'node:crypto';
import { supabaseAdmin } from '../supabase.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ALLOWED_TYPES = new Set([
  'text', 'email', 'radio', 'scale_1_5', 'scale_1_10', 'open_text',
]);

const SCALE_RANGES = {
  scale_1_5 : { min: 1, max: 5  },
  scale_1_10: { min: 1, max: 10 },
};

/**
 * Laadt alle actieve assessment_questions in volgorde. Strikt server-side;
 * routing_weights wordt NIET uitgesneden hier - caller bepaalt.
 */
export async function loadActiveQuestions() {
  const { data, error } = await supabaseAdmin
    .from('assessment_questions')
    .select('id, key, section, order_index, page, type, label, help_text, required, options, min_words, is_routing, routing_weights, active')
    .eq('active', true)
    .order('page', { ascending: true })
    .order('order_index', { ascending: true });
  if (error) throw new Error('loadActiveQuestions: ' + error.message);
  return data || [];
}

/**
 * Verwijdert server-only velden (routing_weights, is_routing) uit een
 * questions-array voor publieke exposure.
 */
export function sanitizeQuestionsForPublic(questions) {
  return (questions || []).map((q) => ({
    key        : q.key,
    section    : q.section,
    order_index: q.order_index,
    page       : q.page,
    type       : q.type,
    label      : q.label,
    help_text  : q.help_text,
    required   : q.required,
    options    : q.options,
    min_words  : q.min_words,
  }));
}

/**
 * Telt woorden in een open_text-antwoord. Knipt whitespace + leestekens af,
 * splitst op witruimte. Lege string -> 0.
 */
export function countWords(s) {
  if (typeof s !== 'string') return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

/**
 * Valideert een answers-object tegen de configured questions.
 * Returns { ok, errors: [{key, code, message}], normalized: { ... } }.
 *
 * Per type:
 *   - text / email: niet-lege string; email moet aan EMAIL_RE voldoen.
 *   - radio: value moet voorkomen in q.options[].value.
 *   - scale_1_5 / scale_1_10: integer binnen [min,max].
 *   - open_text: string met >= q.min_words woorden (als min_words gezet).
 *
 * required: indien true en antwoord ontbreekt of leeg -> required-fout.
 *
 * Velden die NIET in questions voorkomen worden genegeerd (niet als fout
 * gerapporteerd, ook niet doorgegeven naar normalized).
 */
export function validateAnswers({ questions, answers }) {
  const errors = [];
  const normalized = {};
  const ansObj = (answers && typeof answers === 'object') ? answers : {};

  for (const q of questions) {
    if (!ALLOWED_TYPES.has(q.type)) {
      // Mocht ooit een nieuw type in DB zonder code-update verschijnen,
      // dan slaan we 'm over (forward-compat veiligheidsklep).
      continue;
    }
    const raw = ansObj[q.key];
    const present = raw !== undefined && raw !== null && (typeof raw !== 'string' || raw.trim() !== '');

    if (!present) {
      if (q.required) {
        errors.push({ key: q.key, code: 'REQUIRED', message: `Veld "${q.key}" is verplicht.` });
      }
      continue;
    }

    switch (q.type) {
      case 'text': {
        if (typeof raw !== 'string') {
          errors.push({ key: q.key, code: 'TYPE', message: `Veld "${q.key}" moet tekst zijn.` });
        } else {
          normalized[q.key] = raw.trim();
        }
        break;
      }
      case 'email': {
        if (typeof raw !== 'string' || !EMAIL_RE.test(raw.trim())) {
          errors.push({ key: q.key, code: 'EMAIL', message: `Veld "${q.key}" is geen geldig e-mailadres.` });
        } else {
          normalized[q.key] = raw.trim().toLowerCase();
        }
        break;
      }
      case 'radio': {
        const allowed = Array.isArray(q.options)
          ? q.options.map((o) => o && o.value).filter((v) => v != null)
          : [];
        if (!allowed.includes(raw)) {
          errors.push({ key: q.key, code: 'OPTION', message: `Veld "${q.key}" heeft een ongeldige optie.` });
        } else {
          normalized[q.key] = raw;
        }
        break;
      }
      case 'scale_1_5':
      case 'scale_1_10': {
        const range = SCALE_RANGES[q.type];
        const n = Number(raw);
        if (!Number.isInteger(n) || n < range.min || n > range.max) {
          errors.push({ key: q.key, code: 'SCALE', message: `Veld "${q.key}" moet een geheel getal van ${range.min} t/m ${range.max} zijn.` });
        } else {
          normalized[q.key] = n;
        }
        break;
      }
      case 'open_text': {
        if (typeof raw !== 'string') {
          errors.push({ key: q.key, code: 'TYPE', message: `Veld "${q.key}" moet tekst zijn.` });
          break;
        }
        const trimmed = raw.trim();
        const min = Number.isInteger(q.min_words) ? q.min_words : 0;
        const words = countWords(trimmed);
        if (min > 0 && words < min) {
          errors.push({
            key: q.key,
            code: 'MIN_WORDS',
            message: `Veld "${q.key}" moet minstens ${min} woorden bevatten (nu ${words}).`,
          });
        } else {
          normalized[q.key] = trimmed;
        }
        break;
      }
    }
  }

  return { ok: errors.length === 0, errors, normalized };
}

/**
 * Hasht een IP-string deterministisch zodat we wel rate-limit kunnen maar
 * geen raw IP opslaan. Salt = SUPABASE_URL (server-only constante, niet
 * geheim maar wel uniek per project). SHA-256 truncated tot 32 hex chars.
 */
export function hashIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const salt = process.env.SUPABASE_URL || 'assessment-fallback-salt';
  return crypto.createHash('sha256').update(salt + '|' + ip.trim()).digest('hex').slice(0, 32);
}

/**
 * Extraheert het client-IP uit een Vercel/Node request. Probeert in volgorde:
 *   - x-real-ip (Vercel zet deze)
 *   - x-forwarded-for (eerste IP in de lijst)
 *   - req.socket.remoteAddress
 */
export function extractClientIp(req) {
  const xri = req.headers?.['x-real-ip'];
  if (xri && typeof xri === 'string') return xri.trim();
  const xff = req.headers?.['x-forwarded-for'];
  if (xff && typeof xff === 'string') {
    const first = xff.split(',')[0];
    if (first) return first.trim();
  }
  return req.socket?.remoteAddress || null;
}

/**
 * Soft rate-limit: weigert als zelfde IP-hash een succesvolle inzending heeft
 * gedaan binnen `withinSeconds` (default 30). Returns { limited: bool,
 * latest_at: timestamptz|null }.
 *
 * Soft-fail: bij DB-fout returnt limited=false zodat een glitch in de
 * rate-limit-query geen legitieme inzendingen blokkeert.
 */
export async function isRateLimited({ ipHash, withinSeconds = 30 }) {
  if (!ipHash) return { limited: false, latest_at: null };
  const since = new Date(Date.now() - withinSeconds * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from('assessment_responses')
    .select('id, submitted_at')
    .eq('submitter_ip_hash', ipHash)
    .gte('submitted_at', since)
    .order('submitted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[assessment-validation] rate-limit query error:', error.message);
    return { limited: false, latest_at: null };
  }
  if (!data) return { limited: false, latest_at: null };
  return { limited: true, latest_at: data.submitted_at };
}

export { UUID_RE, EMAIL_RE };
