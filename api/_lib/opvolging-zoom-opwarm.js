// api/_lib/opvolging-zoom-opwarm.js
//
// DE OPWARMRONDE VOOR EEN GEBOEKTE ZOOMCALL — de beslissing, als pure functie.
//
// ── HET GAT ──────────────────────────────────────────────────────────────
// Een geboekte zoomcall wordt vandaag pas werk op of ná de calldag: het
// spraakbericht vóór 09:00, de instroom van 12:00 (cron-opvolging-zoom-nabel)
// en daarna de no-show-flow. Tussen het boeken en de calldag staat er niemand
// in Daves lijst.
//
// GEMETEN OP 14 SEPTEMBER, op productie: 40 openstaande scheduled afspraken in
// de toekomst, gemiddeld 13,6 dagen tussen created_at en scheduled_at, en 29
// van die 40 zeven dagen of verder vooruit geboekt. Iemand die over drie weken
// een call heeft hoort tussendoor één keer aan de lijn te hebben gezeten. Daar
// komen de no-shows vandaan.
//
// ── DE SPIEGEL VAN DE AANMELDFLOW, MAAR OP DE AFSPRAAKRIJ ────────────────
// Dezelfde opzet als api/_lib/opvolging-aanmelding.js: klok en data komen
// binnen als argument, er is geen database en geen netwerk. De cron eromheen
// (api/cron-opvolging-zoom-opwarm.js) doet het lezen, schrijven en tellen.
//
// En net als daar hangt de instroom aan de RIJ en niet aan een endpoint. Een
// zoomcall ontstaat via de boekingslink, via de cockpit, via 'Opnieuw
// inplannen' in de werklijst en via een verzetting (die maakt een NIEUWE rij
// met parent_appointment_id — zie _lib/verzet-afspraak.js). Wie aan één
// boek-endpoint hangt mist precies de verzette en opnieuw geboekte calls.
//
// ── ÉÉN RONDE, EN DAT IS EEN KEUZE ───────────────────────────────────────
// Bij een event zijn er twee rondes (aanmelding + vier dagen vooraf). Hier
// niet: Maxim koos bewust voor één. Bevestigd betekent kaart dicht, en hij komt
// NIET terug. De calldag zelf is al gedekt door het spraakbericht vóór 09:00 en
// de instroom van 12:00.
//
// ── DE KAART SLUIT ZICHZELF, EN DAT IS BELANGRIJKER DAN DE AANMAAK ───────
// Een kaart die blijft staan terwijl de afspraak allang weg is, is erger dan
// geen kaart: Dave belt dan over een call die niet meer bestaat. Drie
// sluitregels, en de derde is BLOKKEREND voor de bestaande werking:
//
//   · de afspraak staat niet meer op 'scheduled' (geannuleerd, verzet,
//     afgerond) → dicht, met een leesbare reden;
//   · de calldag is aangebroken → dicht. heeftAlKaart() in
//     cron-opvolging-zoom-nabel matcht óók op TELEFOONNUMMER, dus een nog open
//     opwarmkaart zou de nabelkaart van 12:00 verhinderen. Die sluit dus
//     uiterlijk in de ochtend van de calldag;
//   · het moment is verschoven binnen dezelfde rij → NIET dicht, maar
//     bijwerken. Dat is het Redouane-geval: verzetten binnen dezelfde
//     afspraakrij, waarbij alleen scheduled_at verandert.
//
// Een annulering laat de kaart dicht gaan met reden 'afspraak geannuleerd';
// cron-opvolging-annuleringen neemt het daarna over met zijn eigen kaart. Deze
// flow mag die niet blokkeren — vandaar dat wij sluiten en niets op het nummer
// laten staan.

import { momentVan } from './opvolging-annulering.js';

const ZONE = 'Europe/Amsterdam';

/** De reden op de kaart. Zie docs/sql-migrations/2026-09-14-opvolging-zoom-bevestigen.sql. */
export const REDEN = 'zoom_bevestigen';

/** De bron-soort in bron_ref, waarmee deze kaarten terug te vinden zijn. */
export const SOORT  = 'zoom_opwarm';
export const SOURCE = 'cron-opvolging-zoom-opwarm';

/**
 * Hoeveel kaarten uit de ACHTERSTAND mogen er per dag bij?
 *
 * Er staan 36 boekingen na vandaag. Die in één keer op Dave laten vallen is
 * geen opvolging maar een muur. Maxims keuze: ze mogen er allemaal in, maar
 * gespreid — de eerstvolgende calls eerst.
 *
 * Verse boekingen tellen hier NIET in mee. Die zijn geen achterstand maar de
 * gewone instroom, en die mag nooit vertraagd worden: de hele afspraak is dat
 * je de dag ná het boeken belt.
 */
export const MAX_ACHTERSTAND_PER_DAG = 10;

/** De dag in Amsterdamse tijd, zoals de rest van deze module dat doet. */
export function dagInZone(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/** Kalenderrekenwerk op UTC-noon, zodat de zomertijdgrens geen dag verschuift. */
export function dagPlus(dag, n) {
  const ms = Date.parse(`${dag}T12:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + n * 86400000).toISOString().slice(0, 10);
}

/**
 * OP WELKE DAG HOORT DEZE KAART TE STAAN?
 *
 * De dag ná het boeken — dezelfde regel als dueVoorRondeA() in
 * _lib/opvolging-aanmelding.js, en om dezelfde reden: de due hangt aan het
 * moment van BOEKEN, niet aan het moment waarop de cron toevallig draait.
 * Anders schuift de kaart elke ronde een dag mee en komt hij nooit boven.
 *
 * Twee grenzen eromheen:
 *
 *   · valt die dag op of ná de calldag, dan is er geen opwarmronde meer en
 *     staat de kaart vandaag — bellen vóór de call is het hele punt;
 *   · nooit in het verleden. Een kaart uit de achterstand (geboekt op 28
 *     augustus, vandaag pas aangemaakt) zou anders geboren worden met een due
 *     van drie weken terug en meteen het rode etiket 'bleef liggen' dragen,
 *     terwijl er niets bleef liggen. Dat is precies het soort onwaarheid
 *     waar deze module al twee keer op is vastgelopen.
 */
export function dueVoorOpwarm({ vandaag, geboekt = null, calldag = null }) {
  if (!vandaag) return null;
  const dagVanBoeken = geboekt ? dagInZone(Date.parse(geboekt)) : null;
  const basis = dagVanBoeken && /^\d{4}-\d{2}-\d{2}$/.test(dagVanBoeken) ? dagVanBoeken : vandaag;
  let due = dagPlus(basis, 1) || vandaag;
  if (due < vandaag) due = vandaag;
  if (calldag && due >= calldag) due = vandaag;
  return due;
}

/** Het etiket op de kaart: 'Zoomcall di 16/09 14:00'. */
export function bouwBadge(afspraak) {
  const m = momentVan(afspraak && afspraak.scheduled_at);
  return 'Zoomcall ' + (m ? m.tekst : 'onbekend moment');
}

/**
 * De notitie: wanneer de call staat, en wanneer hij geboekt is.
 *
 * Dat tweede getal is wat het gesprek stuurt. Een call die vanmorgen geboekt
 * is en over drie weken staat vraagt om iets anders dan een call van morgen
 * die vorige maand geboekt werd.
 */
export function bouwNotitie(afspraak, { vandaag = null } = {}) {
  const m = momentVan(afspraak && afspraak.scheduled_at);
  const wanneer = m ? m.tekst : 'onbekend moment';
  const b = momentVan(afspraak && afspraak.created_at);
  const geboekt = b ? b.tekst.slice(0, b.tekst.lastIndexOf(' ')) : null;
  const dagen = (m && vandaag) ? dagenTussen(vandaag, m.dag) : null;
  const over = Number.isFinite(dagen) && dagen > 0
    ? ` — over ${dagen} dag${dagen === 1 ? '' : 'en'}`
    : '';
  return `Zoomcall staat op ${wanneer}${over}.`
    + (geboekt ? ` Geboekt op ${geboekt}.` : '')
    + ' Bel om te bevestigen.';
}

/** Hoeveel hele dagen liggen er tussen twee dagen? Negatief = in het verleden. */
export function dagenTussen(vanaf, tot) {
  const a = Date.parse(`${vanaf}T12:00:00Z`);
  const b = Date.parse(`${tot}T12:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** De regel die bij het sluiten of bijwerken aan de notitie wordt geplakt. */
export function bouwNotitieRegel(tekst, vandaag) {
  return `${vandaag} · ${tekst}`;
}

/**
 * WAAROM IS DEZE AFSPRAAK GEEN KANDIDAAT?
 *
 * Pure voorcontrole op de rij zelf. De vragen die de databank nodig hebben
 * (staat er al een kaart) zitten in de cron.
 *
 * @returns {?string} de reden om over te slaan, of null als hij meedoet.
 */
export function slaOver(afspraak, vandaag) {
  if (!afspraak) return 'geen_rij';
  if (afspraak.is_test === true) return 'is_test';
  if (String(afspraak.status || '').toLowerCase() !== 'scheduled') return 'niet_scheduled';
  if (!String(afspraak.lead_phone || '').trim()) return 'geen_nummer';
  const m = momentVan(afspraak.scheduled_at);
  if (!m) return 'geen_moment';
  // Stringvergelijking mag: ISO-datums sorteren lexicografisch gelijk aan
  // chronologisch.
  if (vandaag && m.dag <= vandaag) return 'calldag_is_hier';
  return null;
}

/**
 * WAT MOET ER MET DEZE AFSPRAAK GEBEUREN?
 *
 *   afspraak — de rij uit follow_up_appointments
 *   taak     — de bestaande opwarmkaart voor deze afspraak, of null
 *   nu       — referentiemoment in ms
 *
 * Vier uitkomsten. 'niets' is verreweg de meest voorkomende en dat hoort zo:
 * deze functie draait elk kwartier over alle openstaande afspraken.
 */
export function bepaalOpwarmActie({ afspraak, taak = null, nu = Date.now() }) {
  if (!afspraak) return { actie: 'niets' };

  const vandaag = dagInZone(nu);
  const m = momentVan(afspraak.scheduled_at);
  const calldag = m ? m.dag : null;
  const status = String(afspraak.status || '').toLowerCase();
  const taakLoopt = !!taak && String(taak.status || '') !== 'gearchiveerd';

  // ── De kaart sluit zichzelf ───────────────────────────────────────────
  if (taakLoopt) {
    if (status !== 'scheduled') {
      return {
        actie        : 'sluiten',
        taak_id      : taak.id,
        archief_reden: sluitReden(status),
        regel        : bouwNotitieRegel(sluitRegel(status), vandaag),
      };
    }
    // DE CALLDAG IS AANGEBROKEN — en dit is de blokkerende regel.
    //
    // heeftAlKaart() in cron-opvolging-zoom-nabel matcht óók op
    // telefoonnummer, niet alleen op appointment_id. Een opwarmkaart die op de
    // ochtend van de calldag nog openstaat zou de nabelkaart van 12:00 dus
    // verhinderen — en dan verdwijnt een bestaande, werkende functie stil
    // achter een nieuwe. Vandaar: zodra de dag van scheduled_at op of vóór
    // vandaag ligt, gaat deze kaart dicht.
    if (!calldag || calldag <= vandaag) {
      return {
        actie        : 'sluiten',
        taak_id      : taak.id,
        archief_reden: 'calldag aangebroken',
        regel        : bouwNotitieRegel(
          calldag
            ? 'De calldag is aangebroken. Vanaf hier nemen het spraakbericht van vanochtend en de nabelronde van 12:00 het over.'
            : 'De afspraak heeft geen leesbaar moment meer. Deze kaart kan niets meer zeggen.',
          vandaag),
      };
    }
    // HET MOMENT IS VERSCHOVEN BINNEN DEZELFDE RIJ.
    //
    // Verzetten maakt normaal een nieuwe rij (_lib/verzet-afspraak.js), maar
    // niet elke weg doet dat: er staat ook een vorm in de data waarbij
    // scheduled_at op de bestaande rij wordt overschreven. Dan is de kaart nog
    // steeds de juiste kaart — alleen het etiket en de notitie kloppen niet
    // meer. Sluiten zou hier de opwarmronde weggooien voor iemand die hem juist
    // nog nodig heeft.
    if (String(taak.status || '') === 'open') {
      const badge = bouwBadge(afspraak);
      const start = taak.bron_ref && taak.bron_ref.start ? String(taak.bron_ref.start) : null;
      const verschoven = start && Date.parse(start) !== Date.parse(afspraak.scheduled_at);
      if (verschoven || String(taak.badge_label || '') !== badge) {
        return {
          actie      : 'bijwerken',
          taak_id    : taak.id,
          badge_label: badge,
          start      : afspraak.scheduled_at,
          due        : dueVoorOpwarm({ vandaag, geboekt: afspraak.created_at, calldag }),
          regel      : bouwNotitieRegel('De call is verzet naar ' + (m ? m.tekst : 'een ander moment') + '.', vandaag),
        };
      }
    }
    return { actie: 'niets' };
  }

  // Vanaf hier: er is geen lopende kaart. Een GEARCHIVEERDE kaart is
  // geschiedenis en mag nooit opnieuw ontstaan — Dave heeft hem bewust
  // weggezet, of hij is bevestigd. Dat is de hele belofte van deze flow:
  // bevestigd is dicht, en komt niet terug.
  if (taak) return { actie: 'niets' };

  const reden = slaOver(afspraak, vandaag);
  if (reden) return { actie: 'niets', reden };

  return {
    actie      : 'aanmaken',
    due        : dueVoorOpwarm({ vandaag, geboekt: afspraak.created_at, calldag }),
    calldag,
    badge_label: bouwBadge(afspraak),
    notitie    : bouwNotitie(afspraak, { vandaag }),
    // Een boeking van vandaag is geen achterstand maar gewone instroom, en die
    // gaat nooit in de wachtrij. Zie kiesInstroom().
    vers       : dagInZone(Date.parse(afspraak.created_at || 0)) === vandaag,
  };
}

/** Waarom is deze kaart gesloten? Kort genoeg voor archief_reden. */
function sluitReden(status) {
  if (status === 'cancelled')           return 'afspraak geannuleerd';
  if (status === 'verplaatst')          return 'afspraak verzet';
  if (status === 'wacht_op_reschedule') return 'afspraak wacht op een nieuw moment';
  if (status === 'completed')           return 'afspraak afgerond';
  if (status === 'no_show' || status === 'noshow') return 'call was een no-show';
  return 'afspraak staat niet meer op scheduled (' + (status || 'onbekend') + ')';
}

/** En dezelfde uitleg, maar dan in een zin voor in de notitie. */
function sluitRegel(status) {
  if (status === 'cancelled') {
    return 'De zoomcall is geannuleerd, dus er valt niets meer te bevestigen. '
      + 'Staat er geen nieuwe afspraak, dan komt hij terug via de annuleringsronde.';
  }
  if (status === 'verplaatst') {
    return 'De zoomcall is verzet. Voor de nieuwe afspraak komt er vanzelf een nieuwe kaart.';
  }
  if (status === 'completed') return 'De zoomcall is afgerond. Deze kaart is daarmee klaar.';
  if (status === 'no_show' || status === 'noshow') {
    return 'De zoomcall staat op no-show. Vanaf hier neemt de no-show-flow het over.';
  }
  return 'De afspraak staat op ' + (status || 'onbekend') + ' en is dus geen geboekte zoomcall meer.';
}

/**
 * DE DRIPFEED — wie mag er vandaag in, en wie wacht nog?
 *
 * Verse boekingen eerst en zonder maximum: die zijn de gewone instroom en
 * mogen nooit wachten. De achterstand daarachter, oplopend op scheduled_at
 * (de eerstvolgende calls eerst), tot de dagquota vol is.
 *
 * @param {object} o
 * @param {Array}  o.kandidaten       [{ id, scheduled_at, vers, ... }]
 * @param {number} o.alGemaaktVandaag hoeveel ACHTERSTAND-kaarten er vandaag al zijn
 * @param {number} [o.max]            de dagquota
 * @returns {{nu:Array, wachtrij:Array, vers:number, ruimte:number}}
 */
export function kiesInstroom({ kandidaten, alGemaaktVandaag = 0, max = MAX_ACHTERSTAND_PER_DAG }) {
  const lijst = Array.isArray(kandidaten) ? kandidaten : [];
  const vers = lijst.filter((k) => k && k.vers === true);
  const achter = lijst.filter((k) => !k || k.vers !== true)
    .sort((a, b) => String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')));
  const ruimte = Math.max(0, max - (Number(alGemaaktVandaag) || 0));
  return {
    nu      : vers.concat(achter.slice(0, ruimte)),
    wachtrij: achter.slice(ruimte),
    vers    : vers.length,
    ruimte,
  };
}
