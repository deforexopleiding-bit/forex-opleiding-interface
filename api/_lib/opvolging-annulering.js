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

// ── EEN AFGESLOTEN LEAD KRIJGT GEEN NIEUWE KAART ─────────────────────────
//
// GEMETEN OP 11 SEPTEMBER, en dit is precies wat niet mag. Jeffrey Biemold
// (+31655270212, GHL-contact ZvTcan7kmMWG8GZgyoEr) kreeg een kaart
// 'Geannuleerd · call za 26/09 09:30 … plan hem opnieuw in'. Maar Dave had op
// 10 september om 12:48 voor diezelfde lead al `wilt_niet_meer` vastgelegd —
// geen interesse. De call van de 26e werd vandaag geannuleerd, vermoedelijk
// juist daarom.
//
// De cron keek alleen naar `uitkomst` op de geannuleerde afspraak ZELF en naar
// OPEN kaarten op het nummer. Een lead die al afgesloten is langs een ándere
// afspraak, of via een kaart die intussen gearchiveerd is, viel daar
// helemaal buiten. Iemand die 'geen interesse' zei terugbellen om opnieuw in
// te plannen is het ergste wat deze module kan doen.
//
// ── WELKE UITKOMSTEN ZIJN EEN EINDPUNT ───────────────────────────────────
// Uit de woordenlijsten van de twee outcome-motoren — die blijven ongemoeid,
// hier staat alleen wat ze BETEKENEN voor deze cron:
//
//   api/follow-up-appointment-outcome.js → OUTCOMES
//     sale            klant geworden
//     wilt_niet_meer  geen interesse
//     niet_geschikt   past niet bij ons
//   api/follow-up-lead-outcome.js → OUTCOMES
//     sale, geen_interesse   (dezelfde twee, andere spelling)
//
// NIET in deze lijst, met opzet:
//   gesprek_gehad, no_show, later_opnieuw, terugbel, verzetten, annuleren,
//   snooze, whatsapp_gestuurd — daar leeft de lead gewoon door. 'Gesprek
//   gehad' staat wél in AGENDA_REMOVING_OUTCOMES, maar dat gaat over de
//   Zoom-meeting opruimen, niet over de lead afsluiten.
export const EINDPUNT_UITKOMSTEN = new Set([
  'sale',
  'wilt_niet_meer',
  'geen_interesse',
  'niet_geschikt',
]);

/** reden_code op een gearchiveerde kaart die zegt: deze lead is klaar. */
export const EINDPUNT_REDEN_CODES = new Set(['zoom_geen_interesse']);

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
/**
 * Hoort deze rij bij dezelfde lead als de afspraak?
 *
 * GHL-contact eerst, dan het genormaliseerde nummer — een lead die via een
 * andere weg terugkomt kan een ander contact-id hebben maar belt met dezelfde
 * telefoon. Losgetrokken omdat zowel de herboek-vraag als de afgesloten-vraag
 * hem nodig heeft, en twee kopieën zouden uiteenlopen.
 */
export function zelfdeLead(afspraak, rij) {
  if (!afspraak || !rij) return false;
  const contact = afspraak.lead_ghl_contact_id ? String(afspraak.lead_ghl_contact_id) : null;
  if (contact && rij.lead_ghl_contact_id && String(rij.lead_ghl_contact_id) === contact) return true;

  const tel = cijfers(afspraak.lead_phone);
  const c = cijfers(rij.lead_phone != null ? rij.lead_phone : rij.telefoon);
  if (!tel || !c) return false;
  if (c === tel) return true;
  const staart = tel.length >= 9 ? tel.slice(-9) : null;
  return !!staart && c.length >= 9 && c.slice(-9) === staart;
}

/**
 * IS DEZE LEAD AL AFGESLOTEN?
 *
 * Twee bronnen, want het antwoord kan op twee plekken staan:
 *
 *  1. EENDER WELKE afspraak van deze lead met een eindpunt-uitkomst. Niet
 *     alleen de geannuleerde zelf — Jeffrey's `wilt_niet_meer` stond op een
 *     ándere afspraak, van 9 september, en dat was precies het gat.
 *  2. Een gearchiveerde opvolgkaart op dat nummer die zegt dat hij afhaakte:
 *     reden_code `zoom_geen_interesse` (de zoomcall-uitgang), of een
 *     archief_reden die met 'geen interesse' begint (de aanmeldkaart-uitgang
 *     schrijft 'geen interesse of per ongeluk aangemeld').
 *
 * GEEN datumgrens. Wie ooit 'geen interesse' zei, blijft dat gezegd hebben
 * totdat hij zelf terugkomt — en als hij terugkomt doet hij dat door een
 * nieuwe afspraak te boeken, en dan vangt heeftHerboekt() hem al af.
 */
export function leadAlAfgesloten(afspraak, alleAfspraken, kaarten) {
  for (const a of (Array.isArray(alleAfspraken) ? alleAfspraken : [])) {
    if (!a) continue;
    const u = String(a.uitkomst || '').trim().toLowerCase();
    if (!u || !EINDPUNT_UITKOMSTEN.has(u)) continue;
    if (zelfdeLead(afspraak, a)) return true;
  }

  for (const k of (Array.isArray(kaarten) ? kaarten : [])) {
    if (!k || String(k.status || '') !== 'gearchiveerd') continue;
    const code = String(k.reden_code || '').trim();
    const reden = String(k.archief_reden || '').trim().toLowerCase();
    const eindpunt = EINDPUNT_REDEN_CODES.has(code) || reden.startsWith('geen interesse');
    if (!eindpunt) continue;
    if (zelfdeLead(afspraak, k)) return true;
  }
  return false;
}

export function heeftHerboekt(afspraak, alleAfspraken) {
  const grens = Date.parse(afspraak && afspraak.scheduled_at);
  for (const a of (Array.isArray(alleAfspraken) ? alleAfspraken : [])) {
    if (!a || !afspraak || String(a.id) === String(afspraak.id)) continue;
    if (!HERBOEKT_STATUSSEN.includes(String(a.status || '').toLowerCase())) continue;
    const ms = Date.parse(a.scheduled_at);
    if (!Number.isFinite(ms) || !Number.isFinite(grens) || ms <= grens) continue;
    if (zelfdeLead(afspraak, a)) return true;
  }
  return false;
}
