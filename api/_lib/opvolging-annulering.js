// api/_lib/opvolging-annulering.js
//
// EEN GEANNULEERDE ZOOMCALL ZONDER NIEUWE AFSPRAAK IS WERK.
//
// Punt 5 van de bouwlijst van 7 september: zelf geannuleerd, no-show of
// onbeslist wordt een kaart, mét een tag die zegt waarom. Tot nu toe gebeurde
// er niets — de call stond alleen doorgestreept in de agenda, en daar kijkt
// niemand meer naar.
//
// Gemeten op 11 september: drie geannuleerde calls van die dag (Priscilla
// Lumengo 11:00, Kimberley Basslé 13:00, Wout Dijkshoorn 17:00), geen van
// drieën met een nieuwe afspraak, geen van drieën met een opvolgtaak.
//
// ── WAAROM DE BESLUITEN HIER STAAN EN NIET IN DE CRON ───────────────────
// Dit bestand bevat alleen pure functies: wat er met één afspraak moet
// gebeuren, en hoe de kaart eruitziet. De cron eromheen doet het lezen, het
// schrijven en het tellen. Zo staan de regels in een test in plaats van in een
// handler die je alleen in productie ziet werken.

const ZONE = 'Europe/Amsterdam';

// ── VANAF WANNEER MAKEN WE KAARTEN? ──────────────────────────────────────
// Er staan ±88 oudere zelf-geannuleerde afspraken in de lijst van 7 september.
// Die in één keer als werklijst op Dave laten vallen is geen opvolging maar een
// muur; Maxim kiest daar zelf het tempo voor. Deze cron gaat dus alleen over
// wat er vanaf nu gebeurt.
//
// 10 september en niet vandaag: de drie gemeten annuleringen van 11 september
// horen er wél in, en Kimberley annuleerde al op de 10e.
export const ANNULERING_VANAF = '2026-09-10';

/** De statussen waarbij een lead zelf opnieuw heeft ingepland. */
export const HERBOEKT_STATUSSEN = ['scheduled', 'in_progress'];

/** De twee redenen, en het verschil is waar de annulering vandaan kwam. */
export const REDEN_ZELF   = 'zelf_geannuleerd';
export const REDEN_AGENDA = 'geannuleerd_in_agenda';

const DAGNAMEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const cijfers = (s) => {
  const c = String(s == null ? '' : s).replace(/\D/g, '');
  if (!c) return null;
  return c.startsWith('00') ? (c.slice(2) || null) : c;
};

/** Dag, tijd en een leesbaar moment ('vr 11/09 13:00') in Amsterdamse tijd. */
export function momentVan(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const m = {};
  for (const p of dtf.formatToParts(new Date(ms))) m[p.type] = p.value;
  const dag = `${m.year}-${m.month}-${m.day}`;
  const tijd = `${m.hour}:${m.minute}`;
  // De weekdagnaam uit onze eigen lijst: Intl geeft 'Fri' in en-CA, en dat
  // willen we niet in een Nederlandse notitie.
  const wd = DAGNAMEN[new Date(Date.UTC(+m.year, +m.month - 1, +m.day)).getUTCDay()] || '';
  return { dag, tijd, tekst: `${wd} ${m.day}/${m.month} ${tijd}` };
}

/**
 * Is deze afspraak zelf geannuleerd, of in de agenda?
 *
 * `annulering_reden_code` wordt alleen gezet door api/public-afspraak-annuleren.js
 * — de link die de lead zelf krijgt. Staat hij er, dan heeft de lead op die
 * link geklikt. Staat hij er niet, dan is de afspraak in GHL zelf geannuleerd
 * en heeft de appointment-poll dat opgepikt.
 *
 * Dat onderscheid is geen detail: bij het eerste weet je waaróm hij afzegde en
 * kun je daarop inspelen, bij het tweede weet je alleen dát het gebeurd is.
 */
export function annuleerBron(afspraak) {
  const code = afspraak && afspraak.annulering_reden_code
    ? String(afspraak.annulering_reden_code).trim() : '';
  return code ? REDEN_ZELF : REDEN_AGENDA;
}

/**
 * De notitie op de kaart.
 *
 * Zegt drie dingen, en elk ervan is wat Dave nodig heeft voordat hij belt:
 * wanneer de call stond, hoe hij is afgezegd, en wat er nu moet gebeuren.
 * De vrije reden gaat mee als die er is — 'Geen tijd / te druk' verandert het
 * gesprek dat hij gaat voeren.
 */
export function bouwNotitie(afspraak) {
  const m = momentVan(afspraak && afspraak.scheduled_at);
  const wanneer = m ? m.tekst : 'onbekend moment';
  const zelf = annuleerBron(afspraak) === REDEN_ZELF;
  const reden = afspraak && afspraak.annulering_reden
    ? String(afspraak.annulering_reden).trim() : '';

  const hoe = zelf
    ? 'zelf geannuleerd' + (reden ? ' — reden: ' + reden : '')
    : 'geannuleerd in de agenda';
  return `Zoomcall van ${wanneer} ${hoe}. Nog niet opnieuw ingepland: plan hem opnieuw in.`;
}

/** Het etiket op de kaart. */
export function bouwBadge(afspraak) {
  const m = momentVan(afspraak && afspraak.scheduled_at);
  return 'Geannuleerd · call ' + (m ? m.tekst : 'onbekend');
}

/** De regel die aan een BESTAANDE kaart wordt toegevoegd. */
export function bouwNotitieRegel(afspraak, vandaag) {
  const m = momentVan(afspraak && afspraak.scheduled_at);
  return `${vandaag} · Zoomcall van ${m ? m.tekst : 'onbekend moment'} geannuleerd.`;
}

/**
 * Hoort deze afspraak überhaupt in de selectie?
 *
 * Pure voorcontrole op de rij zelf; de vragen die de databank moeten raadplegen
 * (heeft hij herboekt, staat er al een kaart) zitten in de cron.
 *
 * @returns {?string} de reden om over te slaan, of null als hij meedoet.
 */
export function slaOver(afspraak) {
  if (!afspraak) return 'geen_rij';
  if (afspraak.is_test === true) return 'is_test';
  if (afspraak.uitkomst) return 'uitkomst_al_vastgelegd';
  if (!String(afspraak.lead_phone || '').trim()) return 'geen_nummer';
  const m = momentVan(afspraak.scheduled_at);
  if (!m) return 'geen_moment';
  // Stringvergelijking mag: ISO-datums sorteren lexicografisch gelijk aan
  // chronologisch.
  if (m.dag < ANNULERING_VANAF) return 'voor_de_grens';
  return null;
}

/**
 * Heeft deze lead zelf een nieuwe afspraak geboekt?
 *
 * Op het GHL-contact als dat er is, anders op het genormaliseerde nummer — een
 * lead die via een andere weg terugkomt kan een ander contact-id hebben maar
 * belt met dezelfde telefoon.
 *
 * NIEUWER DAN DE GEANNULEERDE. Een oude afspraak die toevallig nog op
 * 'scheduled' staat is geen herboeking; dan zou een annulering van vandaag
 * verstommen door iets van vorige maand.
 */
export function heeftHerboekt(afspraak, alleAfspraken) {
  const contact = afspraak && afspraak.lead_ghl_contact_id
    ? String(afspraak.lead_ghl_contact_id) : null;
  const tel = cijfers(afspraak && afspraak.lead_phone);
  const staart = tel && tel.length >= 9 ? tel.slice(-9) : null;
  const grens = Date.parse(afspraak && afspraak.scheduled_at);

  for (const a of (Array.isArray(alleAfspraken) ? alleAfspraken : [])) {
    if (!a || String(a.id) === String(afspraak.id)) continue;
    if (!HERBOEKT_STATUSSEN.includes(String(a.status || '').toLowerCase())) continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms) || !Number.isFinite(grens) || ms <= grens) continue;

    if (contact && a.lead_ghl_contact_id && String(a.lead_ghl_contact_id) === contact) return true;
    const c = cijfers(a.lead_phone);
    if (!c || !tel) continue;
    if (c === tel) return true;
    if (staart && c.length >= 9 && c.slice(-9) === staart) return true;
  }
  return false;
}
