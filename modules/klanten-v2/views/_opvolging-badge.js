// modules/klanten-v2/views/_opvolging-badge.js
//
// HET ETIKET OP EEN OPVOLGTAAK — ÉÉN PLEK, VOOR ALLE VIEWS.
//
// Dit bestand bestaat omdat dezelfde lange string drie keer op een scherm is
// opgedoken waar hij niet hoort:
//
//   'Forex Masterclass Gent Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)
//    · 23 sep 18:00'
//
// Eerst in de groepskop van het aanmeldblok, toen op de kaart, en nu in het
// Later-paneel — waar hij alle breedte opeiste en de namen afkapte tot
// 'Bryan Van ...'. Drie keer dezelfde fout op drie plekken is geen toeval maar
// een ontbrekende gedeelde helper.
//
// WAAROM DIT GEEN PARSER OP DE OPGESLAGEN TEKST IS
// `opvolging_taken.badge_label` is een platgeslagen string. De eerste versie
// van badgeVoorEvent plakte titel en plaats met een SPATIE aan elkaar
// (commit dca79dde), dus achteraf is er niet meer uit te halen waar de titel
// ophoudt en het adres begint. Dat hoeft ook niet: `bron_ref` draagt
// event_titel, event_plaats en event_start apart, en dat doet het sinds diezelfde
// eerste versie. We bouwen het etiket dus opnieuw op uit de losse velden,
// precies zoals de groepskop dat doet, en vallen alleen terug op badge_label
// als die velden er niet zijn — een handmatige lead, 'Call 07/09',
// 'Agenda doorgestuurd'.
//
// WAAROM EEN EIGEN BESTANDJE EN NIET _shared-v2.js
// Gemeten, niet aangenomen: _shared-v2.js heeft een echte DOM nodig
// (document.addEventListener) en de veertien vm-sandboxen van de
// opvolging-tests hebben die niet. Die allemaal een nep-DOM geven om één
// tekstfunctie te delen is de verkeerde ruil. Dit bestand heeft nul
// afhankelijkheden en draait overal.
//
// LET OP DE LAADVOLGORDE: _shared-v2.js doet `KV_V2.helpers = { ... }` en
// vervangt dus het hele object. Dit bestand moet er ná staan in index.html, en
// zet alleen losse sleutels. tests/opvolging-badge-label.test.js bewaakt die
// volgorde, zodat een herschikking hard faalt in plaats van stil.
//
// Non-ES-module (klassieke <script>), net als de views.

(function () {
  'use strict';

  /**
   * De plaats, maar alleen als het er één is.
   *
   * `events.location` is één vrij tekstveld — er is geen stad-kolom. In de
   * praktijk staat er soms een stad ('Gent') en soms een volledig postadres
   * ('Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)'). De stad uit zo'n
   * adres vissen is een parser bouwen op één voorbeeld, en dat gaat een keer
   * mis op een adres dat we nog niet gezien hebben. Dus andersom: een korte
   * waarde zonder adres-kenmerken is een plaatsnaam, al het andere valt weg.
   *
   * Gelijk aan kortePlaats in api/_lib/opvolging-aanmelding.js; die draait bij
   * het schrijven, deze bij het tonen.
   */
  function opvKortePlaats(location) {
    const v = String(location == null ? '' : location).trim();
    if (!v || v.length > 24) return '';
    if (/[0-9|,;]/.test(v)) return '';
    if (v.includes(' - ') || v.includes('(')) return '';
    return v;
  }

  /** '23 sep 18:00' — het moment van een event, in Amsterdamse tijd. */
  function opvEventMoment(startsAt) {
    const ms = startsAt ? Date.parse(startsAt) : NaN;
    if (!Number.isFinite(ms)) return '';
    try {
      // nl-NL zet er een komma tussen ('23 sep, 18:00'); op een etiket leest
      // dat rommelig, dus die haalt hij eruit.
      return new Intl.DateTimeFormat('nl-NL', {
        timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short',
        hour: '2-digit', minute: '2-digit',
      }).format(new Date(ms)).replace(',', '');
    } catch (_) { return ''; }
  }

  /**
   * Het etiket dat op het scherm hoort: 'Forex Masterclass Gent · 23 sep 18:00'.
   *
   * Geeft '' terug als er niets zinnigs te tonen is — de aanroeper laat het
   * etiket dan gewoon weg in plaats van een lege badge te tekenen.
   */
  function opvBadgeTekst(taak) {
    const t = taak || {};
    const e = (t.bron_ref && typeof t.bron_ref === 'object') ? t.bron_ref : {};
    const titel = e.event_titel ? String(e.event_titel).trim() : '';
    if (titel) {
      const naam = [titel, opvKortePlaats(e.event_plaats)].filter(Boolean).join(' · ');
      const moment = opvEventMoment(e.event_start);
      return [naam, moment].filter(Boolean).join(' · ');
    }
    // Geen event erachter: dan is badge_label alles wat er is, en die is voor
    // die gevallen kort ('Call 07/09', 'Agenda doorgestuurd').
    return t.badge_label ? String(t.badge_label).trim() : '';
  }

  window.KV_V2 = window.KV_V2 || {};
  window.KV_V2.helpers = window.KV_V2.helpers || {};
  // Losse sleutels, geen objectvervanging — zie de laadvolgorde hierboven.
  window.KV_V2.helpers.opvBadgeTekst  = opvBadgeTekst;
  window.KV_V2.helpers.opvKortePlaats = opvKortePlaats;
  window.KV_V2.helpers.opvEventMoment = opvEventMoment;
})();
