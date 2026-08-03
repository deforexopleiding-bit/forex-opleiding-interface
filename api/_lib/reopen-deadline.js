// api/_lib/reopen-deadline.js
//
// Gedeelde reopen-deadline-berekening. Eén bron van waarheid voor zowel het
// handmatige reopen-endpoint (api/events-reopen-signups.js) als de automatische
// reopen (herevalueerCapaciteit in api/_lib/event-registration.js), zodat de
// deadline-regel tussen beide nooit uit elkaar loopt.

const TZ = 'Europe/Amsterdam';

/**
 * Bereken de reopen-deadline in UTC voor een event.
 *
 * Definitie: middernacht (00:00) Europe/Amsterdam op de dag VOOR de event-dag.
 *
 * Algoritme:
 *   1. Bepaal de event-dag in Europe/Amsterdam (YYYY-MM-DD).
 *   2. Trek 1 dag af -> deadline-dag.
 *   3. Bouw "deadline-dag 00:00 Amsterdam" als UTC-Date door de offset op te
 *      zoeken die Amsterdam op dat moment heeft (CET +01:00 of CEST +02:00).
 *
 * Returnt een Date-object in UTC dat we direct met new Date() kunnen vergelijken.
 * Null bij een ongeldige starts_at.
 */
export function computeReopenDeadlineUtc(startsAtIso) {
  const startUtc = new Date(startsAtIso);
  if (!Number.isFinite(startUtc.getTime())) return null;

  // Stap 1: event-dag in Europe/Amsterdam als YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(startUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = Number(get('year'));
  const m = Number(get('month'));
  const d = Number(get('day'));
  if (!y || !m || !d) return null;

  // Stap 2: deadline-dag = event-dag minus 1 dag. Gebruik UTC-Date om
  // rolover (1 mrt -> 28/29 feb) automatisch correct te krijgen.
  const deadlineDayUtcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  deadlineDayUtcNoon.setUTCDate(deadlineDayUtcNoon.getUTCDate() - 1);
  const dy = deadlineDayUtcNoon.getUTCFullYear();
  const dm = deadlineDayUtcNoon.getUTCMonth() + 1;
  const dd = deadlineDayUtcNoon.getUTCDate();

  // Stap 3: bouw "deadline-dag 00:00 Amsterdam" als UTC. offsetMinutes is de
  // offset die Amsterdam op die dag heeft (+60 CET / +120 CEST).
  const offsetMinutes = getAmsterdamOffsetMinutes(dy, dm, dd);
  // 00:00 Amsterdam = (00:00 - offset) UTC.
  const deadlineUtc = new Date(Date.UTC(dy, dm - 1, dd, 0, 0, 0) - offsetMinutes * 60_000);
  return deadlineUtc;
}

/**
 * Vind de offset (in minuten, positief voor +UTC) die Europe/Amsterdam heeft
 * op een gegeven kalenderdag om 12:00 lokaal. We nemen 12:00 om weg te blijven
 * van DST-overgangsmomenten (DST flipt rond 02:00-03:00 op 'n zondag, dus 12:00
 * geeft altijd een stabiele offset voor die dag).
 */
function getAmsterdamOffsetMinutes(year, month, day) {
  // We bouwen een UTC-stamp voor "die dag 12:00 UTC", en checken wat Amsterdam
  // op dat moment als uur teruggeeft. Het verschil tussen UTC-uur en NL-uur is
  // de offset.
  //
  // Voorbeeld zomer (CEST = UTC+2): 12:00 UTC == 14:00 Amsterdam -> offset = +120
  // Voorbeeld winter (CET = UTC+1): 12:00 UTC == 13:00 Amsterdam -> offset = +60
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(probe);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value || '12');
  const mm = Number(parts.find((p) => p.type === 'minute')?.value || '0');
  // Verschil in minuten t.o.v. 12:00 UTC.
  return (hh - 12) * 60 + mm;
}
