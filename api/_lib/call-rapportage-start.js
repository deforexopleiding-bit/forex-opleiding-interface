// api/_lib/call-rapportage-start.js
//
// Vanaf welke Amsterdam-dag call-uitkomsten meetellen (rapport, topbar,
// setter-overzicht). Oudere calls zonder uitkomst zijn geen achterstand.
//
// app_settings.call_rapportage_startdatum = { "datum": "YYYY-MM-DD" }.
// Ontbreekt de rij of is de waarde ongeldig, dan geldt STANDAARD_STARTDATUM.

export const CALL_RAPPORTAGE_START_KEY = 'call_rapportage_startdatum';
export const STANDAARD_STARTDATUM = '2026-10-02';

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseStartdatum(value) {
  const d = value && typeof value === 'object' ? value.datum : null;
  return typeof d === 'string' && DATUM_RE.test(d) ? d : STANDAARD_STARTDATUM;
}

export async function leesCallRapportageStart(db) {
  try {
    const { data, error } = await db.from('app_settings')
      .select('value').eq('key', CALL_RAPPORTAGE_START_KEY).maybeSingle();
    if (error || !data) return STANDAARD_STARTDATUM;
    return parseStartdatum(data.value);
  } catch {
    return STANDAARD_STARTDATUM;
  }
}
