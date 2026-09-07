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
//   * de tier-koppeling (aanmaning_dagNN hoort bij ECHTE days_overdue >= NN).
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
// Tier-koppeling: aanmaning_dagNN hoort bij ECHTE days_overdue >= NN
// ---------------------------------------------------------------------------

// Vangt 'aanmaning_dag14', 'aanmaning-dag 14', 'Aanmaning dag 21', 'dag7'.
const TIER_RE = /dag[\s_-]*(\d{1,3})/i;

/** 'aanmaning_dag14' → 14. Geen match → null. PURE. */
export function tierFromName(name) {
  if (typeof name !== 'string') return null;
  const m = name.match(TIER_RE);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : null;
}

/**
 * Hoeveel ECHTE dagen te laat moet de klant zijn voordat deze stap mag
 * versturen? Volgorde van waarheid:
 *
 *   1. `step.config.min_days_overdue` — expliciet gezet door een beheerder,
 *      wint altijd (ook als die 0 is: dan is er bewust geen tier-eis).
 *   2. de Meta-templatenaam (`aanmaning_dag14` → 14) — dat is het label dat
 *      de klant in het bericht ziet; die moet kloppen met de werkelijkheid.
 *   3. de interne templatenaam, daarna `step.config.title`
 *      ("Aanmaning dag 21").
 *
 * null = geen tier af te leiden → geen tier-eis (oud gedrag; de harde
 * vervaldatum-poort blijft uiteraard wel gelden).
 *
 * PURE.
 */
export function resolveStepTierDays(step, template = null) {
  const explicit = step?.config?.min_days_overdue;
  if (Number.isFinite(Number(explicit))) {
    const n = Math.trunc(Number(explicit));
    if (n >= 0) return n;
  }
  return tierFromName(template?.meta_template_name)
      ?? tierFromName(template?.name)
      ?? tierFromName(step?.config?.title)
      ?? null;
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
