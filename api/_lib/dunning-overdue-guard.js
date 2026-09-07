// api/_lib/dunning-overdue-guard.js
//
// Harde vervaldatum-guard voor de aanmaan-motor.
//
// AANLEIDING (bug 06-09-2026): facturen die nog NIET vervallen waren kregen
// automatisch een aanmaning. Twee oorzaken die elkaar versterkten:
//
//   1. `days_overdue` werd overal geclampt op 0 (`Math.max(0, diff)` /
//      `diff > 0 ? diff : 0` / `GREATEST(0, ...)` in de AI-views). Daardoor
//      is "vervalt over 12 dagen" niet te onderscheiden van "vervalt vandaag":
//      beide lezen als 0.
//   2. De selectie in dunning-engine.js#detectAndStartRuns gebruikte die
//      geclampte teller (`agg.days_overdue < minDays`), en `minDays` valt op
//      -1 zodra een workflow op `min_days_since_invoice_date` (het dag-7-
//      duwtje) of `arrangement_breached` staat. -1 <= 0 → de overdue-check
//      slaagde ALTIJD, ook voor facturen met een vervaldatum in de toekomst.
//
// Deze module levert daarom één bron van waarheid voor:
//   * "welke dag is het NU in Europe/Amsterdam" (nooit UTC — tussen 00:00 en
//     02:00 zomertijd wijkt de UTC-datum een dag af);
//   * de ONGECLAMPTE dagen-teller (negatief = nog niet vervallen);
//   * de harde poort `isOverdue()` inclusief instelbare gratieperiode;
//   * de LADDER: welke template bij welk aantal dagen NA de vervaldatum hoort.
//
// ANKERDATUM-BESLISSING (vervolg op #1466): de vervaldatum die het CRM uit
// TeamLeader synchroniseert is de ENIGE waarheid. Nergens zelf een betaal-
// termijn bij de factuurdatum optellen — die termijn zit al in `due_date`
// verwerkt en is niet bij elke klant gelijk (betalingsregelingen,
// splitsingen, afwijkende termijnen). `min_days_since_invoice_date` is
// daarom geen selectiecriterium meer; zie dunning-engine.js.
//
// Alles PURE behalve `readGraceDaysSetting()` (één app_settings-lookup).
// Fail-soft-conventie van de dunning-modules: bij een config-glitch valt de
// grace terug op 0 — de VEILIGE kant, want grace 0 is de strengste waarde
// die de vervaldag zelf nog steeds beschermt.

export const AMSTERDAM_TZ = 'Europe/Amsterdam';

// app_settings-key + default. 0 = geen extra respijt; de vervaldag zelf en
// alles daarvoor blijft sowieso beschermd (zie isOverdue).
export const GRACE_SETTING_KEY  = 'dunning_grace_days';
export const DEFAULT_GRACE_DAYS = 0;
export const MAX_GRACE_DAYS     = 90;

/**
 * Vandaag als 'YYYY-MM-DD' in de opgegeven tijdzone (default Europe/
 * Amsterdam), DST-aware via Intl. NOOIT `toISOString().slice(0,10)` gebruiken
 * voor dag-vergelijkingen: dat is UTC en schuift 's nachts een dag op.
 *
 * @param {Date} [now]
 * @param {string} [tz]
 * @returns {string} 'YYYY-MM-DD'
 */
export function todayIsoInTz(now = new Date(), tz = AMSTERDAM_TZ) {
  const d = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  try {
    // en-CA formatteert als YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
  } catch (_) {
    // Onbekende tz → val terug op de lokale runtime-datum (Vercel = UTC).
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}

/** 'YYYY-MM-DD…' → epoch-ms op UTC-middernacht, of null bij onparseerbaar. */
function ymdToUtcMs(iso) {
  if (!iso) return null;
  const ymd = String(iso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const ms = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * ONGECLAMPTE dagen te laat: positief = te laat, 0 = vervalt vandaag,
 * NEGATIEF = vervalt over |n| dagen. null als de datum ontbreekt/onparseerbaar.
 *
 * Beide kanten worden op UTC-middernacht genormaliseerd, dus DST speelt geen
 * rol; `todayIso` is al in Europe/Amsterdam bepaald.
 */
export function daysOverdueSigned(dueIso, todayIso) {
  const dueMs   = ymdToUtcMs(dueIso);
  const todayMs = ymdToUtcMs(todayIso);
  if (dueMs == null || todayMs == null) return null;
  return Math.round((todayMs - dueMs) / 86400000);
}

/** Geclampte variant (>= 0) — voor UI-teksten die geen negatief getal aankunnen. */
export function daysOverdueClamped(dueIso, todayIso) {
  const n = daysOverdueSigned(dueIso, todayIso);
  return n == null ? 0 : Math.max(0, n);
}

/** Normaliseer een grace-waarde naar integer 0..MAX_GRACE_DAYS (default 0). */
export function parseGraceDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GRACE_DAYS;
  const t = Math.trunc(n);
  if (t < 0) return DEFAULT_GRACE_DAYS;
  if (t > MAX_GRACE_DAYS) return MAX_GRACE_DAYS;
  return t;
}

/**
 * DE harde poort. True = er MAG een automatische aanmaning uit.
 *
 * Regel: `due_date + graceDays < vandaag (Europe/Amsterdam)`, oftewel
 * `daysOverdueSigned > graceDays`. Met de default grace 0 betekent dat
 * minimaal 1 dag NA de vervaldag — op en vóór de vervaldag gaat er niets uit.
 *
 * Geen due_date → false (fail-closed): zonder vervaldatum kunnen we niet
 * aantonen dat de factuur te laat is, en dan sturen we niets.
 */
export function isOverdue(dueIso, todayIso, graceDays = DEFAULT_GRACE_DAYS) {
  const n = daysOverdueSigned(dueIso, todayIso);
  if (n == null) return false;
  return n > parseGraceDays(graceDays);
}

/**
 * Leest app_settings.dunning_grace_days ({ days: int }). Fail-soft → 0.
 * Zelfde 2-staps patroon als de cooldown-lookup in dunning-engine.js.
 */
export async function readGraceDaysSetting(db) {
  try {
    const { data } = await db
      .from('app_settings')
      .select('value')
      .eq('key', GRACE_SETTING_KEY)
      .maybeSingle();
    if (!data) return DEFAULT_GRACE_DAYS;
    return parseGraceDays(data?.value?.days);
  } catch (e) {
    console.warn('[dunning-overdue-guard] grace-setting fail-soft, default 0:', e?.message || e);
    return DEFAULT_GRACE_DAYS;
  }
}

// ---------------------------------------------------------------------------
// De ladder: templatenaam → aantal dagen NA de vervaldatum
// ---------------------------------------------------------------------------
//
// De Meta-templatenamen (`aanmaning_dagNN`) blijven ongewijzigd — die zijn bij
// Meta goedgekeurd en kunnen niet zomaar hernoemd worden. Het getal in de naam
// zegt daarom NIETS over het moment van verzenden; de ladder hieronder doet
// dat. `aanmaning_dag7` is het vriendelijke duwtje dat op dag 1 na de
// vervaldatum vertrekt.
//
// Instelbaar via app_settings-key `dunning_ladder`:
//   { "rungs": { "aanmaning_dag7": 1, "aanmaning_dag14": 7, ... } }
// Ontbrekende sporten vallen terug op DEFAULT_LADDER; onbekende templates
// (niet in de ladder) hebben geen drempel en worden dus niet door de ladder
// tegengehouden — alleen door de harde vervaldatum-poort.

export const LADDER_SETTING_KEY = 'dunning_ladder';

export const DEFAULT_LADDER = Object.freeze({
  aanmaning_dag7 : 1,   // vriendelijk duwtje: "misschien had je het gemist"
  aanmaning_dag14: 7,
  aanmaning_dag17: 14,
  aanmaning_dag21: 21,
  aanmaning_dag37: 30,
});

export const MAX_LADDER_DAYS = 365;

/**
 * Normaliseer een ruwe ladder-config naar `{ <templatenaam>: <dagen> }`.
 * Ontbrekende default-sporten worden aangevuld; eigen templatenamen mogen
 * erbij. Ongeldige waarden (niet-integer, negatief, > MAX_LADDER_DAYS) vallen
 * terug op de default voor die sport, of worden genegeerd als er geen default
 * is. Nooit throw — fail-soft, net als de office-hours-parser.
 *
 * PURE.
 */
export function parseLadder(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  // Zowel `{ rungs: {...} }` als een plat object wordt geaccepteerd.
  const rungs = (src.rungs && typeof src.rungs === 'object' && !Array.isArray(src.rungs))
    ? src.rungs
    : src;

  const out = { ...DEFAULT_LADDER };
  for (const [key, val] of Object.entries(rungs)) {
    const name = String(key || '').trim();
    if (!name) continue;
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    const t = Math.trunc(n);
    if (t < 0 || t > MAX_LADDER_DAYS) continue;
    out[name] = t;
  }
  return out;
}

/**
 * Leest app_settings.dunning_ladder. Fail-soft → DEFAULT_LADDER.
 */
export async function readLadderSetting(db) {
  try {
    const { data } = await db
      .from('app_settings')
      .select('value')
      .eq('key', LADDER_SETTING_KEY)
      .maybeSingle();
    if (!data) return { ...DEFAULT_LADDER };
    return parseLadder(data?.value);
  } catch (e) {
    console.warn('[dunning-overdue-guard] ladder-setting fail-soft, default:', e?.message || e);
    return { ...DEFAULT_LADDER };
  }
}

/**
 * Hoeveel dagen NA de vervaldatum moet de klant zijn voordat deze stap mag
 * versturen? Volgorde van waarheid:
 *
 *   1. `step.config.min_days_overdue` — expliciet gezet door een beheerder,
 *      wint altijd (ook 0: dan is er bewust geen ladder-eis voor deze stap).
 *   2. de ladder, opgezocht op `template.meta_template_name` en daarna op
 *      `template.name`.
 *
 * null = deze stap zit niet op de ladder → geen ladder-eis. De harde
 * vervaldatum-poort blijft uiteraard wel gelden.
 *
 * BEWUST GEEN afleiding uit het getal IN de templatenaam: `aanmaning_dag14`
 * vertrekt op dag 7, en die verwarring is precies wat de ladder oplost.
 *
 * PURE.
 */
export function resolveStepTierDays(step, template = null, ladder = DEFAULT_LADDER) {
  const explicit = step?.config?.min_days_overdue;
  if (Number.isFinite(Number(explicit))) {
    const n = Math.trunc(Number(explicit));
    if (n >= 0) return n;
  }
  const lad = (ladder && typeof ladder === 'object') ? ladder : DEFAULT_LADDER;
  for (const key of [template?.meta_template_name, template?.name]) {
    const name = typeof key === 'string' ? key.trim() : '';
    if (!name) continue;
    const n = Number(lad[name]);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

/**
 * Vanaf hoeveel dagen te laat mag een workflow überhaupt STARTEN?
 *
 *   1. `trigger_conditions.min_days_overdue` als die expliciet gezet is.
 *   2. anders de LAAGSTE ladder-sport onder de eigen send-stappen — zo gaat
 *      het eerste bericht op zijn eigen dag de deur uit in plaats van pas bij
 *      een willekeurige default.
 *   3. anders `fallbackDays` (de historische default van 14).
 *
 * Nooit lager dan 1: op en vóór de vervaldag gaat er niets uit. De harde
 * poort in `isOverdue()` bewaakt dat sowieso; dit houdt de twee consistent.
 *
 * `min_days_since_invoice_date` komt hier BEWUST niet in voor: de factuurdatum
 * is geen ankerdatum meer.
 *
 * PURE.
 */
export function resolveWorkflowStartDays({
  triggerConditions = null,
  stepTierDays = [],
  fallbackDays = 14,
} = {}) {
  const tc = triggerConditions || {};
  const explicit = Number(tc.min_days_overdue);
  if (Number.isFinite(explicit)) return Math.max(1, Math.trunc(explicit));

  const rungs = (Array.isArray(stepTierDays) ? stepTierDays : [])
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n));
  if (rungs.length) return Math.max(1, Math.trunc(Math.min(...rungs)));

  const fb = Number(fallbackDays);
  return Math.max(1, Number.isFinite(fb) ? Math.trunc(fb) : 14);
}

/**
 * Label voor UI en logs: "verstuurd op dag 1 na vervaldatum". null als de
 * template niet op de ladder staat. PURE.
 */
export function ladderLabel(templateName, ladder = DEFAULT_LADDER) {
  const lad = (ladder && typeof ladder === 'object') ? ladder : DEFAULT_LADDER;
  const name = typeof templateName === 'string' ? templateName.trim() : '';
  if (!name) return null;
  const n = Number(lad[name]);
  if (!Number.isFinite(n)) return null;
  const d = Math.trunc(n);
  if (d <= 0) return 'verstuurd vanaf de vervaldatum';
  return `verstuurd op dag ${d} na vervaldatum`;
}

/**
 * Vanaf welke DATUM is `minDaysOverdue` bereikt voor deze vervaldatum?
 * Gebruikt om `next_action_at` vooruit te zetten in plaats van de run te
 * laten hameren. Returnt een ISO-timestamp (UTC-middernacht van die dag) of
 * null als er niets te rekenen valt.
 */
export function earliestSendIso(dueIso, minDaysOverdue) {
  const dueMs = ymdToUtcMs(dueIso);
  const n = Number(minDaysOverdue);
  if (dueMs == null || !Number.isFinite(n)) return null;
  return new Date(dueMs + Math.max(0, Math.trunc(n)) * 86400000).toISOString();
}
