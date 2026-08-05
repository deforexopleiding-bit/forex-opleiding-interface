// api/_lib/dunning-office-hours.js
//
// Kantooruren-guard voor de dunning-engine. Blokkeert ALLEEN send-stappen
// (email / whatsapp) buiten het geconfigureerde tijdsvenster; andere step-
// types (wait / task / stop / resume_dunning) mogen altijd doorlopen zodat
// de workflow-pointer niet onnodig stilstaat.
//
// Ontwerp-keuzes:
//  * PURE helpers waar het kan (unit-testbaar zonder Supabase-mock). De DB-
//    lookup zit in één functie apart: readOfficeHoursSetting.
//  * Europe/Amsterdam tijdzone, DST-aware via Intl.DateTimeFormat. NOOIT
//    een hardcoded UTC-offset — CET/CEST-wisseling zou anders 1u drift
//    geven rond eind maart / eind oktober.
//  * Fail-open: bij DB-fout of ongeldige config → veilige default (08:00-
//    20:00 elke dag). De engine mag NIET stilvallen door een config-glitch.
//  * Buiten venster: skip zonder next_action_at-mutatie. De volgende
//    engine-tick (elk uur) pikt de run opnieuw op. Effectieve wachttijd
//    tot venster-open = <60 min.
//
// App-settings key: `dunning_office_hours` (jsonb):
//   {
//     "tz":    "Europe/Amsterdam",           // IANA-timezone
//     "start": "08:00",                       // "HH:MM" lokale tijd
//     "end":   "20:00",                       // "HH:MM" lokale tijd (excl.)
//     "days":  [0, 1, 2, 3, 4, 5, 6]          // 0=zon, 1=ma, ..., 6=zat
//   }
//
// Missende/ongeldige velden → default (zie DEFAULT_OFFICE_HOURS).

// Step-types die als SEND tellen (klant ontvangt een bericht). Blijven
// gelijk aan de switch-cases in dunning-engine.js#advanceActiveRuns —
// als daar ooit een nieuw send-type bijkomt (bv. 'sms') moet dat hier ook.
export const SEND_STEP_TYPES = ['email', 'whatsapp'];

export function isSendStep(stepType) {
  return SEND_STEP_TYPES.includes(String(stepType || '').toLowerCase());
}

// Default-venster: 08:00-20:00 Europe/Amsterdam, elke dag van de week
// (0=zondag t/m 6=zaterdag). Bewust géén werkdagen-only default: user
// heeft expliciet gekozen voor 7 dagen per week, en het is veiliger om
// de UI-config-waarde te spiegelen dan een aparte code-default te hebben.
export const DEFAULT_OFFICE_HOURS = Object.freeze({
  tz:    'Europe/Amsterdam',
  start: '08:00',
  end:   '20:00',
  days:  [0, 1, 2, 3, 4, 5, 6],
});

// "HH:MM" → { hour, minute } | null (bij ongeldig input).
export function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour   = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// Normaliseer + valideer raw config (uit app_settings). Bij ANY ongeldig
// veld valt dat veld terug op de default; andere velden blijven behouden.
// Fail-open: nooit throw — we willen dat de engine draait, niet dat 'ie
// omvalt op een typo in de config.
export function parseOfficeHoursConfig(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const cfg = { ...DEFAULT_OFFICE_HOURS };

  if (typeof src.tz === 'string' && src.tz.trim()) {
    // Validatie: probeer Intl.DateTimeFormat aan te maken. Faalt bij
    // onbekende IANA-tz → fallback naar default.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: src.tz.trim() });
      cfg.tz = src.tz.trim();
    } catch (_) { /* fallback */ }
  }

  if (parseHHMM(src.start))       cfg.start = src.start;
  if (parseHHMM(src.end))         cfg.end   = src.end;

  if (Array.isArray(src.days)) {
    // Filter STRIKT: alleen items die primitief number/string zijn EN naar
    // een geldig integer 0..6 converteren. null/undefined/objects worden
    // afgewezen — Number(null) is 0 en zou anders per ongeluk "zondag"
    // toevoegen aan de config.
    const valid = src.days
      .filter((d) => typeof d === 'number' || typeof d === 'string')
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    // Uniek + gesorteerd voor consistentie in logs.
    const uniqSorted = Array.from(new Set(valid)).sort((a, b) => a - b);
    if (uniqSorted.length > 0) cfg.days = uniqSorted;
  }

  return cfg;
}

// Peil lokale tijd (voor cfg.tz) uit een Date-object. Gebruikt
// Intl.DateTimeFormat wat DST-transitions correct meepakt.
// Returns { day: 0-6 (zon-zat), hour: 0-23, minute: 0-59 } | null.
export function getLocalDayHourMinute(nowDate, tz) {
  const d = (nowDate instanceof Date) ? nowDate : new Date();
  try {
    // formatToParts geeft de individuele stukken; 'weekday' short + hour +
    // minute in de doel-tz. 24-uurs door hourCycle:'h23'.
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday : 'short',
      hour    : '2-digit',
      minute  : '2-digit',
      hourCycle: 'h23',
    });
    const parts = fmt.formatToParts(d);
    const map = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;

    // Weekday short → 0..6 (zon..zat).
    const wd = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const day = wd[map.weekday];
    const hour   = parseInt(map.hour,   10);
    const minute = parseInt(map.minute, 10);
    if (!Number.isInteger(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    return { day, hour, minute };
  } catch (_) {
    return null;
  }
}

// Pure guard: is `now` binnen het geconfigureerde venster in cfg.tz?
// Fail-open: bij tz-lookup-fout → return true (send toestaan). Alternatief
// zou zijn: bij fout altijd blokkeren — te agressief, kan alle sends
// stopzetten door een Intl-glitch.
export function isWithinOfficeHours(nowDate, cfgRaw) {
  const cfg = parseOfficeHoursConfig(cfgRaw);
  const local = getLocalDayHourMinute(nowDate, cfg.tz);
  if (!local) return true;
  if (!cfg.days.includes(local.day)) return false;
  const start = parseHHMM(cfg.start) || parseHHMM(DEFAULT_OFFICE_HOURS.start);
  const end   = parseHHMM(cfg.end)   || parseHHMM(DEFAULT_OFFICE_HOURS.end);
  const nowMin = local.hour * 60 + local.minute;
  const startMin = start.hour * 60 + start.minute;
  const endMin   = end.hour   * 60 + end.minute;
  // Half-open interval [start, end): 20:00 sluit precies af, 19:59 nog OK.
  // Bij start >= end (bv. per ongeluk 22:00-06:00 config) → gebruiken we de
  // niet-cross-midnight-interpretatie: dan is NIETS binnen venster.
  // Deze feature is bewust NIET cross-midnight-safe: aanmaan-brieven horen
  // niet 's nachts uit te gaan; als een user 22-06 configureert is dat
  // vermoedelijk een fout.
  if (startMin >= endMin) return false;
  return nowMin >= startMin && nowMin < endMin;
}

// DB-lookup: leest app_settings.dunning_office_hours (jsonb) en returned
// een gevalideerde config. Fail-soft: bij DB-fout of missende row →
// DEFAULT_OFFICE_HOURS. Zelfde pattern als de bestaande
// `dunning_cooldown_days`-lookup in dunning-engine.js.
export async function readOfficeHoursSetting(supabaseAdmin) {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'dunning_office_hours')
      .maybeSingle();
    return parseOfficeHoursConfig(data?.value);
  } catch (e) {
    console.warn('[dunning-office-hours] fail-soft, default 08:00-20:00 NL 7d:', e?.message || e);
    return { ...DEFAULT_OFFICE_HOURS };
  }
}

// Human-leesbare label voor log-payload zodat je in de audit ziet welk
// venster de check toen gebruikte (belangrijk als je 't later verandert).
export function officeHoursLabel(cfg) {
  const c = parseOfficeHoursConfig(cfg);
  const dayNames = ['zo','ma','di','wo','do','vr','za'];
  const daysStr = c.days.length === 7 ? '7d' : c.days.map((d) => dayNames[d]).join(',');
  return `${c.start}-${c.end} ${c.tz} (${daysStr})`;
}
