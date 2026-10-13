// modules/shared/inbox-wanbetaler-selectie.js
//
// Welke gesprekken ziet Wanbetalers → Gesprekken?
//
// ── WAAROM DIT UIT DE VIEW IS GEHAALD ───────────────────────────────────────
// Deze functie stond als `_selectVisibleInboxItems` in de closure van
// wanbetalers-v2.js, en was daardoor door geen enkele toets te bereiken. Ze
// beslist wel wat Maxim ziet: zoekterm, wanbetaler-scope, werkstand-filter,
// categorie en sortering, achter elkaar, over de volle lijst.
//
// Op 13 oktober toonde de module "Geen wanbetaler-gesprekken in dit filter"
// terwijl het endpoint 249 items gaf. De oorzaak lag niet hier (de opvraging
// liep in een timeout en een mislukte opvraging werd als een lege lijst
// behandeld), maar dat kostte uren uitsluiten — precies omdat deze functie
// niet te toetsen was. Nu wel, met de echte responsvorm als invoer.
//
// ── DE VOLGORDE IS DE BEDOELING ─────────────────────────────────────────────
//   1. zoekterm   — over de VOLLE lijst, vóór de scope
//   2. wanbetaler — alleen klanten met open facturen (is_debtor van de server)
//   3. werkstand  — alleen met de vlag aan; krijgt de volle lijst erbij mee,
//                   want "niet gekoppeld" moet juist buiten de scope zoeken
//   4. categorie  — 'alles' laat alles door
//   5. sortering
//
// Puur: geen fetch, geen DOM, geen globale staat. Alles wat ze nodig heeft
// komt als parameter binnen.

(function () {
  'use strict';

  /** Wat een lege/ontbrekende lijst betekent: niets, niet "alles". */
  function alsLijst(x) { return Array.isArray(x) ? x : []; }

  /**
   * @param {Array}  items                 de respons van inbox-conversations-list
   * @param {object} opties
   * @param {string} opties.zoek           zoekterm (leeg = niet zoeken)
   * @param {Array}  opties.overzichtKlantIds  terugval voor een respons zonder is_debtor
   * @param {string} opties.focusModus     'geen' of een werkstand-sleutel
   * @param {string} opties.categorie      'alles' of een categorie-sleutel
   * @param {string} opties.sorteer        'unread_first' of iets anders
   * @param {object} opties.gv             window.GESPREKKEN_V2, of null
   * @param {object} opties.ic             window.INBOX_CATEGORIE, of null
   */
  function kies(items, opties) {
    var o = opties || {};
    var alleItems = alsLijst(items);

    // 1. Zoeken gaat over de VOLLE lijst. Zoeken binnen de wanbetaler-scope
    //    zou een klant zonder open factuur nooit vinden, en dan lijkt het of
    //    hij niets gestuurd heeft.
    var q = String(o.zoek || '').trim().toLowerCase();
    var alle = q
      ? alleItems.filter(function (c) {
          return (
            (c.customer_name || '') + ' ' +
            (c.display_name || '') + ' ' +
            (c.phone_number || '')
          ).toLowerCase().indexOf(q) !== -1;
        })
      : alleItems;

    // 2. De wanbetaler-scope. `is_debtor` komt van de server; een oudere
    //    respons zonder dat veld valt terug op de klant-id's uit het overzicht.
    //
    //    De test is "kent ÉÉN item het veld", niet "kennen ze het allemaal":
    //    een respons waarin het veld ontbreekt is een andere serverversie, en
    //    niet een lijst waarin niemand wanbetaler is.
    var kentVlag = alle.some(function (c) { return c && 'is_debtor' in c; });
    var out;
    if (kentVlag) {
      out = alle.filter(function (c) { return !!c.is_debtor; });
    } else {
      var ids = {};
      var n = 0;
      alsLijst(o.overzichtKlantIds).forEach(function (id) {
        if (id == null) return;
        ids[String(id)] = true; n++;
      });
      out = n
        ? alle.filter(function (c) { return c.customer_id && ids[String(c.customer_id)]; })
        : alle;
    }

    // 3. De werkstand. `alle` gaat er óók in: 'niet gekoppeld' moet juist de
    //    gesprekken tonen die stap 2 wegfiltert.
    var modus = String(o.focusModus || 'geen');
    if (o.gv && typeof o.gv.focusFilter === 'function' && modus !== 'geen') {
      out = o.gv.focusFilter(alle, out, modus);
    }

    // 4. Categorie.
    if (o.ic && typeof o.ic.past === 'function') {
      var cat = o.categorie == null ? 'alles' : o.categorie;
      out = out.filter(function (c) { return o.ic.past(c, cat); });
    }

    // 5. Sortering.
    var tijd = function (c) {
      if (c && c.last_activity_at) return Date.parse(c.last_activity_at) || 0;
      if (c && c.last_message_at) return Date.parse(c.last_message_at) || 0;
      return 0;
    };
    var ongelezen = function (c) {
      var n2 = Number(c && (c.total_unread != null ? c.total_unread : c.unread_count));
      return n2 > 0 ? 1 : 0;
    };
    return out.slice().sort(function (a, b) {
      if (String(o.sorteer || 'unread_first') === 'unread_first') {
        var ua = ongelezen(a), ub = ongelezen(b);
        if (ua !== ub) return ub - ua;
      }
      return tijd(b) - tijd(a);
    });
  }

  var api = { kies: kies };
  if (typeof window !== 'undefined') window.INBOX_WANBETALER_SELECTIE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
