// modules/shared/inbox-categorie.js
//
// Categorie-label + filterchips voor de WhatsApp-inboxen (2026-10-07).
// De categorie zelf rekent de server uit (api/_lib/inbox-categorie.js) en
// levert per gesprek `categorie`, `categorie_label` en `categorie_tags`.
// Dit bestand tekent alleen: één label per rij en een chiprij bovenin.
//
// Gebruik in een view:
//   const IC = window.INBOX_CATEGORIE;
//   IC.badge(row)                         → html van het label (+ kleine tags)
//   IC.chips(rows, actief, '__xxxCat')    → html van de chiprij (Alles + per categorie, met aantallen)
//   rows.filter((r) => IC.past(r, actief)) → filter
// Ontbreekt dit script, dan tekent de view zoals voorheen (alle aanroepen zijn optioneel).
(function () {
  'use strict';

  var VOLGORDE = ['wanbetaler', 'onboarding', 'leadsonderhoud', 'lead_aanmelding', 'events', 'klant', 'onbekend'];
  var LABELS = {
    wanbetaler: 'Wanbetaler',
    onboarding: 'Onboarding',
    leadsonderhoud: 'Leadsonderhoud',
    lead_aanmelding: 'Lead-aanmelding',
    events: 'Events',
    klant: 'Klant',
    onbekend: 'Onbekend',
  };
  var KORT = {
    wanbetaler: 'wanbet.',
    onboarding: 'onb.',
    leadsonderhoud: 'leadso.',
    lead_aanmelding: 'lead',
    events: 'event',
    klant: 'klant',
    onbekend: '?',
  };
  var KLEUR = {
    wanbetaler: 'rose',
    onboarding: 'emerald',
    leadsonderhoud: 'violet',
    lead_aanmelding: 'blue',
    events: 'amber',
    klant: 'teal',
    onbekend: 'slate',
  };

  function bekend(c) { return Object.prototype.hasOwnProperty.call(LABELS, c); }

  /** Label voor één gesprek. Leeg als de server (nog) geen categorie gaf. */
  function badge(row, opts) {
    var c = row && row.categorie;
    if (!bekend(c)) return '';
    var k = KLEUR[c];
    var html = '<span class="ic-badge" title="Categorie (afgeleid uit de CRM-status)" style="display:inline-block;'
      + 'font-size:10px;line-height:1.5;padding:0 6px;border-radius:8px;font-weight:600;white-space:nowrap;'
      + 'background:var(--' + k + '-soft);color:var(--' + k + ')">' + LABELS[c] + '</span>';
    var metTags = !(opts && opts.tags === false);
    var tags = metTags && Array.isArray(row.categorie_tags) ? row.categorie_tags.filter(bekend).slice(0, 2) : [];
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      html += ' <span class="ic-tag" title="Ook: ' + LABELS[t] + '" style="display:inline-block;font-size:9px;line-height:1.5;'
        + 'padding:0 4px;border-radius:6px;border:1px solid var(--' + KLEUR[t] + '-line);color:var(--' + KLEUR[t] + ');'
        + 'white-space:nowrap">' + KORT[t] + '</span>';
    }
    return html;
  }

  /** Aantal gesprekken per categorie. */
  function telling(rows) {
    var m = {};
    (rows || []).forEach(function (r) { if (bekend(r && r.categorie)) m[r.categorie] = (m[r.categorie] || 0) + 1; });
    return m;
  }

  /** Past dit gesprek bij de gekozen categorie ('alles' of leeg = alles)? */
  function past(row, actief) {
    if (!actief || actief === 'alles') return true;
    return !!row && row.categorie === actief;
  }

  /**
   * Chiprij: "Alles" + elke categorie die in de lijst voorkomt (plus de actieve,
   * ook als die nu 0 heeft, zodat je er weer uit kunt). `handler` is de naam van
   * een globale functie die de gekozen categorie krijgt.
   */
  function chips(rows, actief, handler) {
    var t = telling(rows);
    var a = actief || 'alles';
    var totaal = (rows || []).length;
    var stijl = 'font-size:11px;padding:3px 9px';
    var knop = function (sleutel, tekst, n) {
      return '<button type="button" class="chip' + (a === sleutel ? ' on' : '') + '" style="' + stijl + '" '
        + 'onclick="' + handler + '(\'' + sleutel + '\')">' + tekst
        + (n != null ? ' <span class="cnt">' + n + '</span>' : '') + '</button>';
    };
    var html = knop('alles', 'Alles', totaal);
    VOLGORDE.forEach(function (c) {
      if (!t[c] && a !== c) return;
      html += knop(c, LABELS[c], t[c] || 0);
    });
    return '<div class="ic-chips" style="display:flex;gap:4px;flex-wrap:wrap;align-items:center">' + html + '</div>';
  }

  window.INBOX_CATEGORIE = Object.freeze({
    VOLGORDE: VOLGORDE, LABELS: LABELS, badge: badge, chips: chips, past: past, telling: telling,
  });
})();
