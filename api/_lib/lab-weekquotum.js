// api/_lib/lab-weekquotum.js
//
// WEEKQUOTUM van de bedankpagina van de Lab-funnels (2026-10-20, Maxim): via
// de bedankpagina kunnen er per kalenderweek (maandag t/m zondag, Belgische/
// Nederlandse tijd, de week van het GEPLANDE moment) maximaal LAB_WEEKQUOTUM
// Lab-strategiesessies geboekt worden. De schaarste op die pagina ("Deze week
// nog X van de 3 plaatsen vrij") is dus ECHT: het getal komt hieruit, en het
// CRM weigert een vierde boeking in dezelfde week.
//
// WAT TELT: alle echte Lab-strategiesessies (booking_source 'the-lab', niet
// is_test, niet geannuleerd) — ook die uit het LMS. Een boeking via de
// bedankpagina is in follow_up_appointments niet te onderscheiden van een
// LMS-boeking zonder schemawijziging, en zo blijft Daves agenda het best
// beschermd. Het quotum BEPERKT alleen de bedankpagina; het LMS boekt vrij.

import { amsPartsOf, amsMidnightMs } from '../public-opstartsessie-free-slots.js';

export const LAB_WEEKQUOTUM = 3;
const DAG = 86400000;
const GEANNULEERD = new Set(['cancelled', 'canceled', 'geannuleerd', 'verwijderd']);

/** De maandag (YYYY-MM-DD) van de week waarin dit moment valt. PURE. */
export function weekVan(ms) {
  const datum = amsPartsOf(ms).date;
  const dow = (new Date(datum + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = maandag
  const d = new Date(datum + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** Start (ms) van de week na deze maandag. PURE. */
export function weekEindeMs(maandag) {
  const d = new Date(maandag + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 7);
  return amsMidnightMs(d.toISOString().slice(0, 10));
}

/** Afspraken → Map(maandag → aantal echte Lab-sessies). PURE. */
export function telPerWeek(afspraken) {
  const uit = new Map();
  for (const a of afspraken || []) {
    if (!a || a.is_test === true || GEANNULEERD.has(String(a.status || '').toLowerCase())) continue;
    if (String(a.booking_source || '') !== 'the-lab') continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms)) continue;
    const w = weekVan(ms);
    uit.set(w, (uit.get(w) || 0) + 1);
  }
  return uit;
}

/**
 * Het quotum zoals de bedankpagina het toont, plus de momenten zonder de
 * weken die vol zijn. PURE.
 * @returns {{ momenten: string[], quotum: { per_week: number, deze_week: { geboekt: number, vrij: number }, volgende_week: { geboekt: number, vrij: number } } }}
 */
export function pasQuotumToe(momenten, perWeek, nu = Date.now(), max = LAB_WEEKQUOTUM) {
  const deze = weekVan(nu);
  const volgende = weekVan(amsMidnightMs(deze) + 7 * DAG + 12 * 3600 * 1000);
  const stand = (w) => { const g = perWeek.get(w) || 0; return { geboekt: g, vrij: Math.max(0, max - g) }; };
  return {
    momenten: (momenten || []).filter((iso) => (perWeek.get(weekVan(Date.parse(iso))) || 0) < max),
    quotum: { per_week: max, deze_week: stand(deze), volgende_week: stand(volgende) },
  };
}
