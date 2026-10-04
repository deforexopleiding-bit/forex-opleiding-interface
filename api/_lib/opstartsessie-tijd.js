// api/_lib/opstartsessie-tijd.js
//
// Tijd-filter (Aankomend / Verleden / Alles) voor de LIJST van
// Leadsonderhoud → Kennismakingsgesprekken. Pure functies, geen I/O.
//
// Het effectieve moment van een rij is het GEKOZEN MOMENT zoals de lijst het
// toont: de live `follow_up_appointments.scheduled_at` als er een gekoppelde
// afspraak is (verzette calls), anders de bevroren
// `opstartsessie_submissions.gekozen_start_at`. NOOIT `created_at` — dat is
// de submissiedatum (kolom WANNEER).
//
// Rijen zonder effectief moment (afgewezen leads zonder afspraak, of oude
// submissions met alleen een leesbare `gekozen_slot`-tekst en geen
// timestamp) zijn aankomend noch verleden: die staan alleen onder 'Alles'.

/** ISO-string of null — scheduled_at van de afspraak wint van gekozen_start_at. */
export function effectiefMoment(gekozenStartAt, scheduledAt) {
  for (const v of [scheduledAt, gekozenStartAt]) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

/**
 * Hoort een rij met dit effectieve moment bij het tijd-filter?
 *   aankomend → moment >= nu
 *   verleden  → moment <  nu
 *   alles     → altijd (ook zonder moment)
 */
export function pastBijTijd(momentIso, tijd, nowMs = Date.now()) {
  if (tijd !== 'aankomend' && tijd !== 'verleden') return true;
  const t = momentIso ? Date.parse(momentIso) : NaN;
  if (!Number.isFinite(t)) return false;
  return tijd === 'aankomend' ? t >= nowMs : t < nowMs;
}
