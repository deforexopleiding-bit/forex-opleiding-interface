// api/_lib/nl-period.js
//
// Kalender-periode helpers in Europe/Amsterdam tijdzone. Geeft UTC-Date
// objecten voor start/eind zodat je ze direct in Supabase queries kunt
// gebruiken (Postgres timestamptz vergelijkt UTC-boundaries correct).
//
// ── Waarom bestaat dit ────────────────────────────────────────────
// Dashboard-tellers werkten met:
//   * "Week" = rolling 7 dagen (NOW - 6 days). Fout: gebruiker verwacht
//     kalenderweek maandag t/m zondag.
//   * "Vandaag/Maand" = `now.toISOString().slice(0,10)` = UTC-datum.
//     In de nacht 00:00-02:00 lokaal (of 01:00 in wintertijd) rekent
//     dit een dag te vroeg → deals van na middernacht verdwijnen uit
//     "vandaag".
//   * Zomertijd/wintertijd DST transitions werden niet correct
//     gehandeld — hardcoded offset breekt half maart / half oktober.
//
// Deze helper gebruikt native Intl (geen extra dependency; werkt op
// Vercel Node runtime) om NL-tijdzone-aware datums te berekenen en
// zet ze terug naar exacte UTC-momenten. Werkt in DST-overgang omdat
// we per opgevraagd moment een verse offset-lookup doen.
//
// ── API ───────────────────────────────────────────────────────────
// Alle functies retourneren Date-objecten (UTC-moment) tenzij anders
// vermeld. Alle date-input default naar `new Date()` (nu).
//
//   nlDayStart(d?)          → Date UTC-moment = NL 00:00 van d
//   nlDayEndExclusive(d?)   → Date UTC-moment = NL 00:00 dag na d
//   nlWeekStart(d?)         → Date UTC-moment = NL maandag 00:00 van d's week (ISO)
//   nlWeekEndExclusive(d?)  → Date UTC-moment = NL volgende maandag 00:00
//   nlMonthStart(d?)        → Date UTC-moment = NL 1e 00:00 van d's maand
//   nlMonthEndExclusive(d?) → Date UTC-moment = NL 1e 00:00 volgende maand
//   nlYearStart(d?)         → Date UTC-moment = NL 1 jan 00:00 van d's jaar
//   nlYearEndExclusive(d?)  → Date UTC-moment = NL 1 jan 00:00 volgende jaar
//
//   nlDateString(d?)        → "YYYY-MM-DD" in NL tijdzone (voor labels)
//   periodRange(period, ref?)
//     → { start, endExclusive, label }
//       period ∈ 'dag' | 'week' | 'maand' | 'jaar'
//       start/endExclusive: UTC Date-objecten
//       label: 'YYYY-MM-DD' voor start (voor debug/URL)

const NL_TZ = 'Europe/Amsterdam';

// Extract NL-lokale datumdelen uit een Date (UTC-moment).
function nlLocaleParts(d) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: NL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

// Bouw een UTC-Date voor het exacte NL-lokale moment (y,m,d,h,mi).
// Truc: probeer offsets 0..3 uur en check welke UTC-moment resulteert in
// het gevraagde NL-moment. Handelt DST correct af omdat Intl per moment
// een verse offset toepast.
//
// Waarom deze truc en niet Date.UTC + hardcoded offset: NL heeft DST
// (zomertijd = +2h, wintertijd = +1h). Op de DST-overgangsdagen zijn er
// zelfs uren die 2× of 0× bestaan lokaal. Door te verifiëren dat de
// resulterende NL-parts exact matchen kiezen we altijd het bedoelde
// moment (of de "veilige" kant bij DST-fold).
function nlLocalToUtc(y, m, d, h = 0, mi = 0) {
  // Normaliseer input (JS Date normaliseert overflow: nlLocalToUtc(y,13,32) → jaar+1, maand=2, dag=1).
  // We doen dit door via Date.UTC eerst een canonical (y,m,d,h,mi) te maken,
  // uit te lezen wat NL zegt, en dan te corrigeren.
  const normalize = new Date(Date.UTC(y, m - 1, d, h, mi, 0));
  const ny = normalize.getUTCFullYear();
  const nm = normalize.getUTCMonth() + 1;
  const nd = normalize.getUTCDate();
  const nh = normalize.getUTCHours();
  const nmi = normalize.getUTCMinutes();

  for (const offsetHours of [0, 1, 2, 3]) {
    const utcCandidate = new Date(Date.UTC(ny, nm - 1, nd, nh - offsetHours, nmi, 0));
    const chk = nlLocaleParts(utcCandidate);
    if (
      chk.year === ny && chk.month === nm && chk.day === nd &&
      chk.hour === nh && chk.minute === nmi
    ) {
      return utcCandidate;
    }
  }
  // Fallback: NL is nooit meer dan +2u van UTC in praktijk. Dit pad zou
  // alleen tijdens de "gap"-uur van voorwaartse DST-sprong (ma-maart
  // 02:00 → 03:00) kunnen gebeuren en dan is +2h de veilige keuze.
  return new Date(Date.UTC(ny, nm - 1, nd, nh - 2, nmi, 0));
}

export function nlDayStart(d = new Date()) {
  const { year, month, day } = nlLocaleParts(d);
  return nlLocalToUtc(year, month, day, 0, 0);
}

export function nlDayEndExclusive(d = new Date()) {
  const { year, month, day } = nlLocaleParts(d);
  // day+1: JS Date normaliseert overflow (31 aug + 1 = 1 sep, 31 dec + 1 = 1 jan)
  return nlLocalToUtc(year, month, day + 1, 0, 0);
}

// ISO-week: maandag start. dayOfWeek in JS: 0=zo, 1=ma, ..., 6=za.
// Ma → offset 0, di → offset 1, ..., zo → offset 6.
export function nlWeekStart(d = new Date()) {
  const { year, month, day } = nlLocaleParts(d);
  // Bereken dow via een dummy Date in NL-parts. Dow is timezone-onafhankelijk
  // want we werken met een kalender-datum, niet met een moment.
  const dummy = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dow = dummy.getUTCDay(); // gebruik UTCDay omdat dummy in UTC noon staat
  const daysBackToMonday = dow === 0 ? 6 : dow - 1;
  return nlLocalToUtc(year, month, day - daysBackToMonday, 0, 0);
}

export function nlWeekEndExclusive(d = new Date()) {
  const start = nlWeekStart(d);
  return new Date(start.getTime() + 7 * 24 * 3600 * 1000);
}

export function nlMonthStart(d = new Date()) {
  const { year, month } = nlLocaleParts(d);
  return nlLocalToUtc(year, month, 1, 0, 0);
}

export function nlMonthEndExclusive(d = new Date()) {
  const { year, month } = nlLocaleParts(d);
  // month+1 → JS Date normaliseert (dec → jaar+1, jan)
  return nlLocalToUtc(year, month + 1, 1, 0, 0);
}

export function nlYearStart(d = new Date()) {
  const { year } = nlLocaleParts(d);
  return nlLocalToUtc(year, 1, 1, 0, 0);
}

export function nlYearEndExclusive(d = new Date()) {
  const { year } = nlLocaleParts(d);
  return nlLocalToUtc(year + 1, 1, 1, 0, 0);
}

// "YYYY-MM-DD" in NL-tijdzone. Voor UI-labels/URL-serialisatie waar we
// een NL-kalenderdatum willen tonen zonder tijd-info.
export function nlDateString(d = new Date()) {
  const { year, month, day } = nlLocaleParts(d);
  const mm = month < 10 ? '0' + month : String(month);
  const dd = day < 10 ? '0' + day : String(day);
  return `${year}-${mm}-${dd}`;
}

// Centraal periode-lookup — één plek waar 'dag/week/maand/jaar' worden
// vertaald naar UTC-boundaries. Callers gebruiken deze in plaats van
// zelf te fiddlen met dates.
//
// Return-shape:
//   { start: Date, endExclusive: Date, label: 'YYYY-MM-DD' }
//     start/endExclusive: UTC-moment; endExclusive is de eerste seconde
//       NA de periode zodat je in queries kunt doen: `col >= start AND
//       col < endExclusive` (open-interval-rechts, matcht SQL half-open).
//     label: string YYYY-MM-DD van start (voor debug + URL-round-tripping)
export function periodRange(period, ref = new Date()) {
  switch (String(period || '').toLowerCase()) {
    case 'dag': {
      const start = nlDayStart(ref);
      return { start, endExclusive: nlDayEndExclusive(ref), label: nlDateString(start) };
    }
    case 'week': {
      const start = nlWeekStart(ref);
      return { start, endExclusive: nlWeekEndExclusive(ref), label: nlDateString(start) };
    }
    case 'maand': {
      const start = nlMonthStart(ref);
      return { start, endExclusive: nlMonthEndExclusive(ref), label: nlDateString(start) };
    }
    case 'jaar': {
      const start = nlYearStart(ref);
      return { start, endExclusive: nlYearEndExclusive(ref), label: nlDateString(start) };
    }
    default:
      throw new Error(`periodRange: onbekende period '${period}' (verwacht dag|week|maand|jaar)`);
  }
}

// Test-exports (voor unit-tests zonder Intl-mock-gedoe)
export const _internals = { nlLocaleParts, nlLocalToUtc, NL_TZ };
