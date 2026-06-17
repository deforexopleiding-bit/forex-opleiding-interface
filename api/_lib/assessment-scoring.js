// api/_lib/assessment-scoring.js
// Pure scoring + routing-engine voor assessment-inzendingen. Geen DB-calls,
// geen side-effects. Caller is verantwoordelijk voor:
//   1. ophalen van de active questions config (via assessment-validation.js)
//   2. valideren van answers (idem)
//   3. score() aanroepen met (normalized answers, questions config)
//   4. opslaan van routing_result + score jsonb
//
// Drempels zijn env-overrideable zodat de business ze post-launch kan
// kalibreren zonder code-deploy. Startwaarden komen uit de productspec
// (Blok 2 PR 2).

const DEFAULT_GEVORDERD_THRESHOLD = 7;
const DEFAULT_MOTIVATIE_FLOOR     = 5;
const DEFAULT_LOW_MID_THRESHOLD   = 4;

// 5 SKILL-routingvragen die optellen tot skill_score (max 11 met v1-seeds).
export const SKILL_QUESTION_KEYS = [
  'ervaring',
  'handelen',
  'tradeplan_risico',
  'winstgevend',
  'kennis',
];

// 2 engagement-vragen die GEEN punten optellen maar als gate werken.
// Capt 'gevorderd' terug naar 'basis' als motivatie < floor of uitspraak == 'gratis_info'.
export const ENGAGEMENT_GATE_KEYS = ['motivatie', 'uitspraak'];

export const GRATIS_INFO_VALUE = 'gratis_info';

// Masterplan-tekst per copy_tier (zoals afgesproken Blok 2 PR 2).
// API stuurt copy_text direct mee in de submit-response zodat de frontend
// niet zelf hoeft te mappen en wij de tekst kunnen kalibreren zonder
// frontend-deploy.
export const COPY_BY_TIER = {
  high: 'Op basis van jouw antwoorden kom je in aanmerking voor onze exclusieve Forex Masterclass Gevorderd. Tijdens deze masterclass analyseren we samen waarom je ondanks jouw kennis nog niet de gewenste resultaten behaalt.',
  mid:  'Je hebt duidelijk interesse in trading en bent bezig met jouw ontwikkeling. Op dit moment denken we dat Forex Masterclass Basis de meeste waarde zal bieden.',
  low:  'Bedankt voor jouw interesse. Op basis van jouw antwoorden denken we dat het momenteel waardevoller is om eerst verder te bouwen aan jouw fundering. We raden daarom aan om te starten met Forex Masterclass Basis.',
  incomplete: 'Gelieve de ontbrekende onderdelen aan te vullen zodat we jouw aanvraag verder kunnen verwerken.',
};

function getThreshold(envKey, def) {
  const raw = process.env[envKey];
  if (raw == null || raw === '') return def;
  const n = parseInt(String(raw), 10);
  return Number.isInteger(n) ? n : def;
}

/**
 * Returnt de actuele drempels. Volgorde:
 *   1. waarden op het meegegeven questionnaire-object (FEATURE C — per-
 *      vragenlijst drempels uit assessment_questionnaires).
 *   2. env-vars (legacy / globale override).
 *   3. hard-coded defaults.
 *
 * Geen vragenlijst meegegeven → backward-compat (env / default).
 */
export function getThresholds(questionnaire = null) {
  const fromQ = (key) => {
    if (!questionnaire || typeof questionnaire !== 'object') return null;
    const v = questionnaire[key];
    return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  };
  return {
    GEVORDERD_THRESHOLD: fromQ('gevorderd_threshold') ?? getThreshold('ASSESSMENT_GEVORDERD_THRESHOLD', DEFAULT_GEVORDERD_THRESHOLD),
    MOTIVATIE_FLOOR    : fromQ('motivatie_floor')     ?? getThreshold('ASSESSMENT_MOTIVATIE_FLOOR',     DEFAULT_MOTIVATIE_FLOOR),
    LOW_MID_THRESHOLD  : fromQ('low_mid_threshold')   ?? getThreshold('ASSESSMENT_LOW_MID_THRESHOLD',   DEFAULT_LOW_MID_THRESHOLD),
  };
}

/**
 * Zoekt het gewicht voor een gegeven antwoord-value in routing_weights van
 * de questions-config. Returnt null als de question geen routing_weights heeft
 * of het value-key niet voorkomt.
 *
 * Belangrijk: routing_weights zijn jsonb keys -> getal. Voor scales (1..5,
 * 1..10) zijn de keys strings ("1","2",...). We coercen het antwoord naar
 * string voor de lookup zodat number-answers + string-keys matchen.
 */
function lookupWeight(question, answerValue) {
  if (!question || !question.routing_weights || typeof question.routing_weights !== 'object') return null;
  if (answerValue === undefined || answerValue === null) return null;
  const key = String(answerValue);
  const v = question.routing_weights[key];
  return Number.isFinite(v) ? v : null;
}

/**
 * score(answers, questionsConfig)
 *
 * @param {object} answers - normalized answers (key -> value)
 * @param {Array<object>} questionsConfig - rows uit assessment_questions
 *        (mag de volledige rij bevatten incl. routing_weights)
 *
 * @returns {{
 *   skill_score: number,
 *   skill_breakdown: {[key:string]: number},
 *   motivatie: number|null,
 *   engagement_ok: boolean,
 *   routing_result: 'gevorderd'|'basis'|'incomplete',
 *   copy_tier: 'high'|'mid'|'low'|'incomplete',
 *   copy_text: string,
 *   reason: string,
 *   thresholds: object,
 *   missing_keys: string[]
 * }}
 */
export function score(answers, questionsConfig, questionnaire = null) {
  // FEATURE C: 3e param 'questionnaire' bepaalt drempels per-vragenlijst.
  // null/undefined → backward-compat (env / defaults via getThresholds).
  const ans = (answers && typeof answers === 'object') ? answers : {};
  const cfg = Array.isArray(questionsConfig) ? questionsConfig : [];
  const T   = getThresholds(questionnaire);

  const qByKey = {};
  for (const q of cfg) {
    if (q && q.key) qByKey[q.key] = q;
  }

  // ── Completeness-check ──────────────────────────────────────────────────
  // Voor routing moeten alle 5 SKILL-keys en de 2 engagement-gate keys
  // aanwezig zijn. Ontbreekt er iets -> 'incomplete'.
  const missing_keys = [];
  for (const k of SKILL_QUESTION_KEYS) {
    const v = ans[k];
    if (v === undefined || v === null || v === '') missing_keys.push(k);
  }
  for (const k of ENGAGEMENT_GATE_KEYS) {
    const v = ans[k];
    if (v === undefined || v === null || v === '') missing_keys.push(k);
  }

  if (missing_keys.length > 0) {
    return {
      skill_score    : 0,
      skill_breakdown: {},
      motivatie      : null,
      engagement_ok  : false,
      routing_result : 'incomplete',
      copy_tier      : 'incomplete',
      copy_text      : COPY_BY_TIER.incomplete,
      reason         : 'missing-answers: ' + missing_keys.join(','),
      thresholds     : T,
      missing_keys,
    };
  }

  // ── Skill-score = som van weights van de 5 SKILL-keys ───────────────────
  let skill_score = 0;
  const skill_breakdown = {};
  for (const k of SKILL_QUESTION_KEYS) {
    const w = lookupWeight(qByKey[k], ans[k]);
    skill_breakdown[k] = Number.isFinite(w) ? w : 0;
    if (Number.isFinite(w)) skill_score += w;
  }

  // ── Engagement-gate ─────────────────────────────────────────────────────
  // motivatie raw-waarde (1-10). uitspraak raw-string.
  const motivatie = Number(ans.motivatie);
  const uitspraak = String(ans.uitspraak == null ? '' : ans.uitspraak);
  const motivatieOk = Number.isFinite(motivatie) && motivatie >= T.MOTIVATIE_FLOOR;
  const uitspraakOk = uitspraak !== GRATIS_INFO_VALUE;
  const engagement_ok = motivatieOk && uitspraakOk;

  // ── Routing ─────────────────────────────────────────────────────────────
  let routing_result, copy_tier, reason;
  if (skill_score >= T.GEVORDERD_THRESHOLD && engagement_ok) {
    routing_result = 'gevorderd';
    copy_tier      = 'high';
    reason = `skill_score ${skill_score} >= GEVORDERD_THRESHOLD ${T.GEVORDERD_THRESHOLD} + engagement OK`;
  } else if (skill_score >= T.GEVORDERD_THRESHOLD) {
    // Engagement gecapt: skill genoeg maar motivatie/uitspraak signaleren laag commitment.
    routing_result = 'basis';
    copy_tier      = 'mid';
    const why = [];
    if (!motivatieOk) why.push(`motivatie ${motivatie} < MOTIVATIE_FLOOR ${T.MOTIVATIE_FLOOR}`);
    if (!uitspraakOk) why.push(`uitspraak=gratis_info`);
    reason = `skill_score ${skill_score} >= ${T.GEVORDERD_THRESHOLD} maar engagement-gate gecapt (${why.join(', ')})`;
  } else if (skill_score >= T.LOW_MID_THRESHOLD) {
    routing_result = 'basis';
    copy_tier      = 'mid';
    reason = `skill_score ${skill_score} in [${T.LOW_MID_THRESHOLD}, ${T.GEVORDERD_THRESHOLD - 1}]`;
  } else {
    routing_result = 'basis';
    copy_tier      = 'low';
    reason = `skill_score ${skill_score} < LOW_MID_THRESHOLD ${T.LOW_MID_THRESHOLD}`;
  }

  return {
    skill_score,
    skill_breakdown,
    motivatie,
    engagement_ok,
    routing_result,
    copy_tier,
    copy_text : COPY_BY_TIER[copy_tier] || COPY_BY_TIER.incomplete,
    reason,
    thresholds: T,
    missing_keys: [],
  };
}
