// modules/klanten-v2/shared/inbox-unread.js
//
// Ongelezen-tellers van de inbox: één plek voor het rekenwerk, zodat het
// automatische markeren bij openen en de knoppen niet uit elkaar kunnen
// lopen.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────
//
// De badge is `total_unread = unread_count + email_unread_count` — WhatsApp
// plus e-mail. Het openen van een gesprek zette alleen de WhatsApp-helft op
// nul; de e-mailhelft bleef staan en de badge bleef dus branden. Gemeten in
// productie (11 sep 2026): van 191 gesprekken hadden er 17 een badge, en bij
// vijf daarvan stond `unread_count` op 0 met `email_unread_count` boven nul —
// Jaroslav Balog, Nadia Van den Broeck, Tom Op t Eynde, Samantha Audrit en
// Rachael Njoki. Precies de handtekening van "half gemarkeerd".
//
// Het tweede stuk is een wedloop. De lijst ververst elke 6 seconden en bij
// elke realtime-tick. Een verversing die vóór het markeren begon, levert data
// op van vóór het markeren — en die overschreef de nul weer. Vandaar
// `applyServerRows`: een markeer-intentie die jonger is dan het begin van de
// verversing wint van wat die verversing terugbrengt.
//
// Plain script (geen ES-module) omdat views/wanbetalers-v2.js ook plain
// geladen wordt. De testsuite leest dit bestand en evalueert het met een
// nep-window; zie tests/inbox-unread-gelezen-blijft-gelezen.test.js.

(function (root) {
  'use strict';

  var LEEFTIJD_MS = 60 * 1000;   // een intentie vervalt na een minuut

  function getal(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Badge-waarde van een rij, met dezelfde voorrang als de lijst-render. */
  function badge(row) {
    if (!row) return 0;
    if (row.total_unread !== null && row.total_unread !== undefined) return getal(row.total_unread);
    return getal(row.unread_count);
  }

  /**
   * Alles gelezen — beide kanalen. Dit is wat "markeer als gelezen" betekent:
   * de badge gaat uit en blijft uit.
   */
  function gelezenPatch() {
    return { unread_count: 0, email_unread_count: 0, total_unread: 0 };
  }

  /**
   * Ongelezen — ALLEEN WhatsApp.
   *
   * Eerlijk over wat we kunnen: de e-mailteller komt uit de \Seen-vlag op
   * IMAP, en die kunnen we niet terugzetten. Een gesprek weer op ongelezen
   * zetten is dus een WhatsApp-signaal. Vroeger zette de optimistische update
   * ook `email_unread_count` op 1; de eerstvolgende verversing haalde de echte
   * waarde op en de badge sprong van 1 terug naar 0. Dat was een leugen van
   * één tel, en precies de soort glitch die we hier opruimen.
   */
  function ongelezenPatch(row) {
    var wa   = Math.max(1, getal(row && row.unread_count));
    var mail = getal(row && row.email_unread_count);
    return { unread_count: wa, email_unread_count: mail, total_unread: wa + mail };
  }

  /** Past een patch toe op een rij (muteert de rij, zoals de view verwacht). */
  function pasToe(row, patch) {
    if (!row || !patch) return row;
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) row[k] = patch[k];
    }
    return row;
  }

  /**
   * Onthoud dat er zojuist gemarkeerd is, zodat een verversing die al
   * onderweg was de badge niet terugzet.
   */
  function onthoud(intenties, convId, patch, nuMs) {
    if (!convId) return intenties;
    intenties[String(convId)] = { patch: patch, at: nuMs };
    return intenties;
  }

  /** Vergeet een intentie — na een mislukte serveraanroep. */
  function vergeet(intenties, convId) {
    delete intenties[String(convId)];
    return intenties;
  }

  /**
   * Leg de verse serverlijst over de intenties heen.
   *
   * Een intentie wint alleen als hij JONGER is dan het moment waarop de
   * verversing begon: die data kan het markeren dan nog niet bevatten. Is de
   * verversing ná het markeren begonnen, dan is de server leidend — ook als
   * die een badge teruggeeft, want dan is er echt iets nieuws binnengekomen.
   *
   * Verlopen intenties (ouder dan een minuut) worden opgeruimd zodat een
   * gesprek nooit voorgoed op "gelezen" blijft hangen.
   *
   * @param {object[]} rows            rijen zoals de server ze teruggaf
   * @param {number}   fetchStartMs    tijdstip waarop die fetch begon
   * @param {object}   intenties       { [convId]: { patch, at } } — wordt opgeruimd
   * @param {number}   nuMs
   * @returns {object[]} dezelfde rijen, waar nodig gecorrigeerd
   */
  function applyServerRows(rows, fetchStartMs, intenties, nuMs) {
    var lijst = Array.isArray(rows) ? rows : [];
    var bag   = intenties || {};
    for (var i = 0; i < lijst.length; i++) {
      var row = lijst[i];
      var it  = row && bag[String(row.id)];
      if (!it) continue;
      if (it.at > fetchStartMs) pasToe(row, it.patch);
    }
    for (var id in bag) {
      if (!Object.prototype.hasOwnProperty.call(bag, id)) continue;
      if (bag[id].at <= fetchStartMs || (nuMs - bag[id].at) > LEEFTIJD_MS) delete bag[id];
    }
    return lijst;
  }

  root.WbxInboxUnread = {
    LEEFTIJD_MS: LEEFTIJD_MS,
    badge: badge,
    gelezenPatch: gelezenPatch,
    ongelezenPatch: ongelezenPatch,
    pasToe: pasToe,
    onthoud: onthoud,
    vergeet: vergeet,
    applyServerRows: applyServerRows,
  };
})(typeof window !== 'undefined' ? window : globalThis);
