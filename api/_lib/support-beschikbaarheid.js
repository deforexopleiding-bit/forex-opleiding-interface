// api/_lib/support-beschikbaarheid.js
//
// "Is er nu iemand die live kan antwoorden?"
//
// Twee voorwaarden, allebei nodig:
//   1. Het is kantooruur volgens app_settings.support_kantooruren.
//   2. Er staat minstens één medewerker op beschikbaar mét een verse hartslag.
//
// Die tweede voorwaarde is er omdat een vinkje liegt zodra iemand z'n laptop
// dichtklapt. De CRM-module stuurt elke 60 seconden een hartslag; blijft die
// langer dan HARTSLAG_VENSTER_MS uit, dan telt de medewerker als weg. Liever
// een bezoeker die te horen krijgt "we mailen je terug" en binnen het uur
// antwoord heeft, dan een bezoeker die tien minuten in een lege chat wacht.
//
// FAIL-CLOSED richting "niet live". Bij een storing beloven we geen live chat.
// Dat is de omgekeerde keuze van api/_lib/rate-limit.js (fail-open) en dat is
// met opzet: daar kost falen een legitieme klant toegang, hier kost falen
// alleen een belofte die we toch niet kunnen waarmaken.
//
// De kantooruren-berekening zelf komt uit api/_lib/dunning-office-hours.js —
// die is TZ-aware via Intl.DateTimeFormat en overleeft dus de zomertijd.

import { supabaseAdmin } from '../supabase.js';
import { parseOfficeHoursConfig, isWithinOfficeHours, officeHoursLabel } from './dunning-office-hours.js';

export const HARTSLAG_VENSTER_MS = 5 * 60 * 1000;

const STANDAARD_UREN = {
  tz: 'Europe/Amsterdam',
  dagen: [1, 2, 3, 4, 5],
  start: '09:00',
  eind: '17:30',
};

/**
 * Vertaal onze Nederlandse instelling naar de vorm die
 * dunning-office-hours.js verwacht: `tz` / `start` / `end` / `days`. Onze
 * eigen sleutels blijven Nederlands omdat de instelling in het CRM zichtbaar
 * is, maar `eind` → `end` en `dagen` → `days` moeten hier wél om.
 *
 * Dit is geen cosmetica: parseOfficeHoursConfig is fail-OPEN en valt bij een
 * onbekende sleutel stilzwijgend terug op DEFAULT_OFFICE_HOURS — zeven dagen
 * per week van 08:00 tot 20:00. Een vergeten hernoeming levert dus geen fout
 * op maar een widget die 's avonds live chat belooft die er niet is.
 */
export function naarOfficeHoursConfig(raw) {
  const v = raw && typeof raw === 'object' ? raw : STANDAARD_UREN;
  return {
    tz: v.tz || STANDAARD_UREN.tz,
    days: Array.isArray(v.dagen) && v.dagen.length ? v.dagen : STANDAARD_UREN.dagen,
    start: v.start || STANDAARD_UREN.start,
    end: v.eind || STANDAARD_UREN.eind,
  };
}

/**
 * Pure functie: gegeven de uren, de aanwezigheidsrijen en 'nu', is er live
 * bemensing? Geen DB, geen netwerk, `nu` injecteerbaar — zodat dit zonder
 * draaiende database getest kan worden, net als evaluateAutonomy().
 *
 * @param {object} opts
 * @param {object} opts.urenConfig   — ruwe app_settings-waarde
 * @param {Array}  opts.aanwezigen   — rijen uit support_aanwezigheid
 * @param {Date}   opts.nu
 * @returns {{live:boolean, binnen_kantooruren:boolean, aantal_online:number, reden:string, label:string}}
 */
export function bepaalBeschikbaarheid({ urenConfig, aanwezigen, nu = new Date() }) {
  const cfg = parseOfficeHoursConfig(naarOfficeHoursConfig(urenConfig));
  const label = officeHoursLabel(cfg);

  let binnen = false;
  try {
    binnen = isWithinOfficeHours(nu, cfg);
  } catch (_) {
    // Onbekende tijdzone of kapotte config. Niet live beloven.
    return { live: false, binnen_kantooruren: false, aantal_online: 0, reden: 'uren_onleesbaar', label };
  }

  const grens = nu.getTime() - HARTSLAG_VENSTER_MS;
  const online = (Array.isArray(aanwezigen) ? aanwezigen : []).filter((a) => {
    if (!a?.beschikbaar) return false;
    const t = Date.parse(a.bijgewerkt_op || '');
    return Number.isFinite(t) && t >= grens;
  });

  if (!binnen) {
    return { live: false, binnen_kantooruren: false, aantal_online: online.length, reden: 'buiten_kantooruren', label };
  }
  if (online.length === 0) {
    return { live: false, binnen_kantooruren: true, aantal_online: 0, reden: 'niemand_online', label };
  }
  return { live: true, binnen_kantooruren: true, aantal_online: online.length, reden: 'live', label };
}

/**
 * Dezelfde vraag, maar mét de database erbij. Fail-closed.
 */
export async function haalBeschikbaarheid(nu = new Date()) {
  let urenConfig = STANDAARD_UREN;
  let aanwezigen = [];

  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'support_kantooruren')
      .maybeSingle();
    if (data?.value) urenConfig = data.value;
  } catch (e) {
    console.warn('[support-beschikbaarheid] kantooruren lezen mislukt:', e?.message || e);
  }

  try {
    const sinds = new Date(nu.getTime() - HARTSLAG_VENSTER_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('support_aanwezigheid')
      .select('user_id, beschikbaar, bijgewerkt_op')
      .eq('beschikbaar', true)
      .gte('bijgewerkt_op', sinds);
    if (error) throw new Error(error.message);
    aanwezigen = data || [];
  } catch (e) {
    console.warn('[support-beschikbaarheid] aanwezigheid lezen mislukt (fail-closed):', e?.message || e);
    return {
      live: false, binnen_kantooruren: false, aantal_online: 0,
      reden: 'aanwezigheid_onleesbaar',
      label: officeHoursLabel(parseOfficeHoursConfig(naarOfficeHoursConfig(urenConfig))),
    };
  }

  return bepaalBeschikbaarheid({ urenConfig, aanwezigen, nu });
}

/**
 * De zin die de bezoeker te zien krijgt. Eén plek, zodat widget, mail en
 * CRM-module niet ieder hun eigen belofte gaan formuleren.
 */
export function beschikbaarheidsTekst(b, antwoordMailbox = 'info@deforexopleiding.nl') {
  if (b?.live) return 'Er is nu iemand beschikbaar — je vraag komt direct bij ons binnen.';
  if (b?.reden === 'niemand_online') {
    return `Op dit moment zit er niemand aan de chat. Je vraag staat in de wachtrij; je krijgt antwoord per mail vanaf ${antwoordMailbox}.`;
  }
  return `We zijn bereikbaar ${b?.label || 'op werkdagen'}. Je vraag staat in de wachtrij; je krijgt antwoord per mail vanaf ${antwoordMailbox}.`;
}
