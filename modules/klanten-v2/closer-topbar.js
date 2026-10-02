// modules/klanten-v2/closer-topbar.js
//
// DE CLOSER-TOPBAR — "Maak je dagrapportage in orde — X/Y beoordeeld".
//
// Voor wie het recht calls.closer heeft (nu: rol sales = Dave) én afspraken
// bezit. Leest /api/mijn-calls-vandaag en staat in de bannerstapel
// (banner-stapel.js), onder een eventuele impersonatiebanner.
//
// GEDRAG
//   - zichtbaar zolang er vandaag calls voorbij duur + 15 min zonder uitkomst
//     staan (open > 0);
//   - weg te klikken (×), maar hooguit voor een uur: daarna komt hij terug als
//     het werk er nog ligt. Bewaard in localStorage per gebruiker; zonder
//     opslag (privévenster, geblokkeerd) werkt het wegklikken voor deze
//     pagina-sessie;
//   - verdwijnt vanzelf als alles beoordeeld is;
//   - de dag erna, met calls van gisteren nog zonder uitkomst: een rode,
//     dringender variant. Ook die is maar een uur weg te klikken. Een
//     wegklik geldt per variant en per dag — wordt het 'urgent' of een nieuwe
//     dag, dan staat hij er meteen weer.
//   - ververst elke 5 minuten, bij terugkeer naar het tabblad, en direct na
//     het vastleggen van een uitkomst (event 'kv:call-uitkomst-vastgelegd'
//     uit views/opvolging-v2.js).
//
// De beslissing zelf (bannerStaat) is een pure functie en getest in
// tests/closer-topbar.test.js. Klassiek script; geladen vóór klanten-v2.js.
(function () {
  'use strict';

  var EEN_UUR_MS = 60 * 60 * 1000;
  var POLL_MS = 5 * 60 * 1000;
  var BANNER_ID = 'kv-closer-topbar';
  var VOLGORDE = 10;               // onder de impersonatiebanner (0)
  var LINK = '/modules/klanten-v2/?v2preview=opvolging&v2tab=Vandaag';
  var EVENT = 'kv:call-uitkomst-vastgelegd';

  function getal(n) { var v = Number(n); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; }
  function callsWoord(n) { return n === 1 ? '1 call' : n + ' calls'; }

  /**
   * PUUR. Wat moet de balk nu doen?
   * @param {object|null} data      antwoord van /api/mijn-calls-vandaag
   * @param {number}      nuMs
   * @param {{sleutel:string, tot:number}|null} verborgen  laatste wegklik
   * @returns {{ zichtbaar:boolean, variant:'urgent'|'normaal'|null,
   *             sleutel:string|null, tekst:string, sluitbaar:boolean,
   *             verborgenTot:number|null }}
   */
  function bannerStaat(data, nuMs, verborgen) {
    var leeg = { zichtbaar: false, variant: null, sleutel: null, tekst: '', sluitbaar: false, verborgenTot: null };
    if (!data || typeof data !== 'object') return leeg;

    var open = getal(data.open);
    var teBeoordelen = getal(data.te_beoordelen);
    var vastgelegd = Math.min(getal(data.vastgelegd), teBeoordelen);
    var gisterenOpen = getal(data.gisteren_open);

    var variant = gisterenOpen > 0 ? 'urgent' : (open > 0 ? 'normaal' : null);
    if (!variant) return leeg;

    var sleutel = variant + '|' + String(variant === 'urgent' ? (data.gisteren || '') : (data.dag || ''));
    var tekst = variant === 'urgent'
      ? 'Gisteren nog ' + callsWoord(gisterenOpen) + ' zonder uitkomst — vul ze nu in'
        + (open > 0 ? ' · vandaag ' + vastgelegd + '/' + teBeoordelen + ' beoordeeld' : '')
      : 'Maak je dagrapportage in orde — ' + vastgelegd + '/' + teBeoordelen + ' beoordeeld';

    // Een wegklik geldt alleen voor dezelfde variant op dezelfde dag, en
    // nooit langer dan een uur — ook niet als er een latere tijd in de opslag
    // staat (handmatig gezet, klok verzet).
    var tot = verborgen && verborgen.sleutel === sleutel ? Number(verborgen.tot) : NaN;
    if (Number.isFinite(tot) && tot > nuMs && tot - nuMs <= EEN_UUR_MS) {
      return { zichtbaar: false, variant: variant, sleutel: sleutel, tekst: tekst, sluitbaar: true, verborgenTot: tot };
    }
    return { zichtbaar: true, variant: variant, sleutel: sleutel, tekst: tekst, sluitbaar: true, verborgenTot: null };
  }

  /** PUUR. Wat er na een klik op × bewaard wordt. */
  function wegklik(staat, nuMs) {
    if (!staat || !staat.sleutel) return null;
    return { sleutel: staat.sleutel, tot: nuMs + EEN_UUR_MS };
  }

  // ── Opslag (try/catch: privévenster / geblokkeerd) ────────────────────────
  var geheugen = {};
  function opslagSleutel(userId) { return 'kv_closer_topbar_verborgen:' + (userId || 'onbekend'); }
  function leesVerborgen(userId) {
    var k = opslagSleutel(userId);
    try {
      var raw = window.localStorage.getItem(k);
      if (raw) return JSON.parse(raw);
    } catch (_) { /* val terug op geheugen */ }
    return geheugen[k] || null;
  }
  function bewaarVerborgen(userId, w) {
    var k = opslagSleutel(userId);
    geheugen[k] = w;
    try { window.localStorage.setItem(k, JSON.stringify(w)); } catch (_) { /* geheugen volstaat */ }
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function teken(staat, opties) {
    var stapel = window.KVBannerStapel;
    var bestaand = document.getElementById(BANNER_ID);
    if (!staat.zichtbaar) {
      if (bestaand && stapel) stapel.haalWeg(bestaand);
      else if (bestaand && bestaand.parentNode) bestaand.parentNode.removeChild(bestaand);
      return;
    }
    var urgent = staat.variant === 'urgent';
    var bar = bestaand || document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', urgent ? 'alert' : 'status');
    bar.setAttribute('data-variant', staat.variant);
    bar.style.cssText = [
      'background:' + (urgent ? '#991b1b' : '#fef3c7'),
      'color:' + (urgent ? '#fff' : '#78350f'),
      'border-bottom:1px solid ' + (urgent ? '#7f1d1d' : '#f59e0b'),
      'padding:8px 18px',
      'display:flex', 'align-items:center', 'gap:12px',
      "font:600 13px/1.3 'IBM Plex Sans',system-ui,sans-serif",
    ].join(';');
    bar.innerHTML =
      '<span aria-hidden="true" style="flex-shrink:0">' + (urgent ? '&#9888;' : '&#128222;') + '</span>' +
      '<span style="flex:1;min-width:0">' + esc(staat.tekst) + '</span>' +
      '<a href="' + LINK + '" data-kv-closer-link style="flex-shrink:0;white-space:nowrap;font-weight:700;' +
        'color:inherit;text-decoration:underline">Naar je calls &rarr;</a>' +
      '<button type="button" data-kv-closer-sluit aria-label="Verberg een uur" title="Verberg een uur" ' +
        'style="flex-shrink:0;background:transparent;border:0;color:inherit;font:700 18px/1 inherit;' +
        'cursor:pointer;padding:0 4px;opacity:.8">&times;</button>';

    var link = bar.querySelector('[data-kv-closer-link]');
    if (link) link.addEventListener('click', function (ev) {
      // In de shell blijven: geen herlaad, gewoon naar Opvolging → Vandaag.
      var dfo = window.DFO;
      if (dfo && typeof dfo.goMod === 'function') {
        ev.preventDefault();
        try { dfo.goMod('opvolging'); if (typeof dfo.goTab === 'function') dfo.goTab('Vandaag'); }
        catch (_) { window.location.href = LINK; }
      }
    });
    var sluit = bar.querySelector('[data-kv-closer-sluit]');
    if (sluit) sluit.addEventListener('click', function () { if (opties && opties.onSluit) opties.onSluit(); });

    if (stapel) stapel.plaats(bar, VOLGORDE);
    else if (!bar.parentNode) document.body.insertBefore(bar, document.body.firstChild);
  }

  // ── Levenscyclus ──────────────────────────────────────────────────────────
  var st = { gestart: false, data: null, timer: null, wekker: null, laatst: 0, bezig: false, opties: null };

  function render() {
    var o = st.opties || {};
    var nu = Date.now();
    var staat = bannerStaat(st.data, nu, leesVerborgen(o.userId));
    teken(staat, {
      onSluit: function () {
        var w = wegklik(staat, Date.now());
        if (!w) return;
        bewaarVerborgen(o.userId, w);
        render();
        // Precies na het uur opnieuw kijken, niet pas bij de volgende poll.
        if (st.wekker) clearTimeout(st.wekker);
        st.wekker = setTimeout(function () { st.wekker = null; ververs(); }, EEN_UUR_MS + 1000);
      },
    });
  }

  function stop() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.wekker) { clearTimeout(st.wekker); st.wekker = null; }
  }

  async function ververs() {
    var o = st.opties || {};
    if (st.bezig || typeof o.haal !== 'function') return;
    st.bezig = true;
    try {
      var r = await o.haal('/api/mijn-calls-vandaag');
      st.laatst = Date.now();
      if (r && (r.status === 401 || r.status === 403)) {
        // Geen closer (meer): balk weg, niet blijven vragen.
        st.data = null; render(); stop(); return;
      }
      if (!r || !r.ok) return;            // tijdelijke fout: laatste stand blijft
      var d = await r.json();
      st.data = d;
      render();
      if (d && d.heeft_afspraken === false) stop();
    } catch (_) {
      /* netwerkfout: laatste stand blijft staan, volgende poll probeert weer */
    } finally {
      st.bezig = false;
    }
  }

  /**
   * @param {{ haal:(url:string)=>Promise<Response>, userId:string }} opties
   */
  function start(opties) {
    if (st.gestart) return;
    st.gestart = true;
    st.opties = opties || {};
    ververs();
    st.timer = setInterval(ververs, POLL_MS);
    window.addEventListener(EVENT, function () { ververs(); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && Date.now() - st.laatst > 60 * 1000) ververs();
    });
    window.addEventListener('beforeunload', stop);
  }

  window.KVCloserTopbar = {
    bannerStaat: bannerStaat,
    wegklik: wegklik,
    start: start,
    ververs: ververs,
    EEN_UUR_MS: EEN_UUR_MS,
    POLL_MS: POLL_MS,
    EVENT: EVENT,
    LINK: LINK,
  };
})();
