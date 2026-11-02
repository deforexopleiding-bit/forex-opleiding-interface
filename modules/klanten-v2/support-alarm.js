// modules/klanten-v2/support-alarm.js
//
// DE CHATMELDING — een supportchat mag nooit gemist worden.
//
// Op ELKE CRM-pagina (de v2-shell), voor wie mag antwoorden (support.reply):
//
//   - een balk bovenaan in de bannerstapel (banner-stapel.js):
//       "Iemand zit in de chat — Naam · eerste woorden"
//       [Beantwoorden] [Ik neem het] [Stil]
//     Rood als een chat langer dan `escalatie_min` onbeantwoord blijft;
//   - een belletje in de topbalk met de teller van onbeantwoorde chats, met
//     een paneel (alle chats, geluid aan/uit in deze browser);
//   - GELUID: een dubbel belletje dat in een lus klinkt (elke `interval_s`)
//     tot iemand klikt op Beantwoorden / Ik neem het / Stil. Escaleert de
//     chat (rood), dan rinkelt het opnieuw, ook na Stil;
//   - een bureaubladmelding (Notification API) als het tabblad niet in beeld
//     is, een knipperende tabtitel "(1) Chat!" en een teller op het favicon.
//
// WAT "ONBEANTWOORD" IS beslist de server (api/support-alarm.js →
// api/_lib/support-alarm.js alarmLijst). Deze file toont het alleen.
//
// REALTIME: "Ik neem het" wijzigt support_gesprekken; die tabel staat in de
// publicatie supabase_realtime (migratie 2026-10-21-support-chat-alarm.sql).
// Elke open CRM-pagina krijgt die wijziging binnen en vraagt de lijst opnieuw
// op → het rinkelen stopt bij iedereen. Een poll elke 20 s is het vangnet.
//
// AUTOPLAY: browsers laten geluid pas toe na een klik op de pagina. Daarom
// één keer per browser de vraag "Klik om chatgeluid aan te zetten"; het
// antwoord blijft bewaard (localStorage). Daarna ontgrendelt elke eerste klik
// of toetsaanslag op een pagina het geluid stil op de achtergrond.
//
// ÉÉN TABBLAD RINKELT: met meerdere CRM-tabbladen open zou het geluid
// door elkaar klinken. Een Web Lock wijst één tabblad aan (het eerste met
// ontgrendeld geluid); sluit dat, dan neemt het volgende het over.
//
// Het geluid is een gegenereerde buffer die zelf in een lus speelt (geen
// timer), zodat het ook in een tabblad op de achtergrond blijft klinken,
// waar browsers timers vertragen.
//
// De beslissingen (alarmStaat, niveauNu, wachtTekst, markeerStil) zijn PUUR
// en getest in tests/support-alarm.test.js. Klassiek script; geladen vóór
// klanten-v2.js, gestart vanuit de boot met startSupportAlarm().
(function () {
  'use strict';

  var BANNER_ID = 'kv-support-alarm';
  var BEL_ID = 'kvChatBel';
  var VOLGORDE = 5;                    // onder de impersonatiebanner (0), boven de closer-topbar (10)
  var POLL_MS = 20 * 1000;
  var TIK_MS = 5 * 1000;
  var STIL_BEWAAR_MS = 24 * 60 * 60 * 1000;
  var SLOT = 'kv-support-alarm-geluid';
  var KEUZE_SLEUTEL = 'kv_support_chatgeluid';      // 'aan' | 'uit' (per browser)
  var GESPREK_PAD = '/modules/klanten-v2/?v2preview=support&gesprek=';

  // ── PUUR ──────────────────────────────────────────────────────────────────

  /** Het niveau nu, ook tussen twee verversingen in. PUUR. */
  function niveauNu(chat, nuMs, gehaaldOpMs, escalatieMin) {
    if (!chat) return null;
    if (chat.niveau === 'urgent') return 'urgent';
    var wachtMs = (Number(chat.wacht_s) || 0) * 1000 + Math.max(0, (Number(nuMs) || 0) - (Number(gehaaldOpMs) || 0));
    return wachtMs >= (Number(escalatieMin) || 5) * 60 * 1000 ? 'urgent' : 'nieuw';
  }

  /** Sleutel voor Stil/Beantwoorden: per onbeantwoord stuk én per niveau. PUUR. */
  function stilSleutel(chat, niveau) {
    return String((chat && (chat.sleutel || chat.id)) || '') + '|' + (niveau || 'nieuw');
  }

  /** "net" · "3 min" · "1 u 5 min". PUUR. */
  function wachtTekst(seconden) {
    var s = Math.max(0, Math.floor(Number(seconden) || 0));
    if (s < 60) return 'net';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min';
    var u = Math.floor(m / 60);
    var rest = m % 60;
    return u + ' u' + (rest ? ' ' + rest + ' min' : '');
  }

  /**
   * Wat moet er nu getoond en gehoord worden? PUUR.
   * @param {object} p
   * @param {object[]} p.chats         uit /api/support-alarm
   * @param {number}   p.nu            ms
   * @param {number}   p.gehaaldOp     ms waarop de chats binnenkwamen
   * @param {object}   p.instellingen  { geluid, interval_s, escalatie_min }
   * @param {object}   p.stil          { [stilSleutel]: ms }
   * @param {string|null} p.geluidKeuze  'aan' | 'uit' | null (nog niet gevraagd)
   */
  function alarmStaat(p) {
    var inst = (p && p.instellingen) || {};
    var stil = (p && p.stil) || {};
    var nu = Number(p && p.nu) || 0;
    var gehaald = Number(p && p.gehaaldOp) || nu;
    var chats = ((p && p.chats) || []).map(function (c) {
      var niveau = niveauNu(c, nu, gehaald, inst.escalatie_min);
      var wacht = (Number(c.wacht_s) || 0) + Math.max(0, Math.floor((nu - gehaald) / 1000));
      return Object.assign({}, c, { niveauNu: niveau, wachtNu: wacht, stilGezet: !!stil[stilSleutel(c, niveau)] });
    });
    chats.sort(function (a, b) {
      if (a.niveauNu !== b.niveauNu) return a.niveauNu === 'urgent' ? -1 : 1;
      return b.wachtNu - a.wachtNu;
    });
    var open = chats.filter(function (c) { return !c.stilGezet; });
    var urgent = chats.some(function (c) { return c.niveauNu === 'urgent'; });
    return {
      zichtbaar: chats.length > 0,
      teller: chats.length,
      chats: chats,
      hoofd: open[0] || chats[0] || null,
      meer: Math.max(0, chats.length - 1),
      variant: chats.length ? (urgent ? 'urgent' : 'nieuw') : null,
      onbevestigd: open.length,
      rinkelen: open.length > 0 && inst.geluid !== false && p.geluidKeuze !== 'uit',
      knipperen: open.length > 0,
      titel: '(' + chats.length + ') Chat!',
      interval_s: Math.min(30, Math.max(2, Number(inst.interval_s) || 4)),
    };
  }

  /** Stil zetten + opruimen van oude sleutels. PUUR: geeft een nieuw object. */
  function markeerStil(stil, chats, nuMs) {
    var uit = {};
    var grens = (Number(nuMs) || 0) - STIL_BEWAAR_MS;
    Object.keys(stil || {}).forEach(function (k) { if (Number(stil[k]) > grens) uit[k] = stil[k]; });
    (chats || []).forEach(function (c) { uit[stilSleutel(c, c.niveauNu || c.niveau)] = nuMs; });
    return uit;
  }

  /** De zin op de balk. PUUR. */
  function balkTekst(staat) {
    var h = staat && staat.hoofd;
    if (!h) return { kop: '', rest: '' };
    var wie = (h.test ? '[TEST] ' : '') + (h.naam || 'Een bezoeker');
    var kop = h.niveauNu === 'urgent' ? 'Chat wacht al ' + wachtTekst(h.wachtNu) : 'Iemand zit in de chat';
    var rest = wie + (h.eerste_woorden ? ' · ' + h.eerste_woorden : '');
    return { kop: kop, rest: rest };
  }

  // ── Opslag (try/catch: privévenster / geblokkeerd) ────────────────────────
  var geheugen = {};
  function lees(k) {
    try { var v = window.localStorage.getItem(k); if (v != null) return v; } catch (_) { /* geheugen */ }
    return Object.prototype.hasOwnProperty.call(geheugen, k) ? geheugen[k] : null;
  }
  function schrijf(k, v) {
    geheugen[k] = v;
    try { window.localStorage.setItem(k, v); } catch (_) { /* geheugen volstaat */ }
  }
  function stilSleutelOpslag() { return 'kv_support_alarm_stil:' + (st.ik || 'onbekend'); }
  function leesStil() {
    try { return JSON.parse(lees(stilSleutelOpslag()) || '{}') || {}; } catch (_) { return {}; }
  }
  function geluidKeuze() {
    var v = lees(KEUZE_SLEUTEL);
    return v === 'aan' || v === 'uit' ? v : null;
  }

  // ── Toestand ──────────────────────────────────────────────────────────────
  var st = {
    gestart: false, opties: null, ik: null,
    chats: [], instellingen: { geluid: true, interval_s: 4, escalatie_min: 5 }, gehaaldOp: 0,
    timer: null, tik: null, plan: null, bezig: false, kanaal: null,
    leider: false, leiderGevraagd: false, gemeld: {}, actie: {}, laatsteStaat: null,
  };

  // ── Geluid ────────────────────────────────────────────────────────────────
  var audio = { ctx: null, bron: null, interval: null };

  function audioCtx(maak) {
    if (audio.ctx || !maak) return audio.ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audio.ctx = new AC(); } catch (_) { audio.ctx = null; }
    return audio.ctx;
  }
  function ontgrendeld() { return !!(audio.ctx && audio.ctx.state === 'running'); }

  /** Een dubbel belletje aan het begin, daarna stilte tot `intervalS`. */
  function belBuffer(ctx, intervalS) {
    var sr = ctx.sampleRate;
    var buf = ctx.createBuffer(1, Math.max(1, Math.round(sr * intervalS)), sr);
    var d = buf.getChannelData(0);
    var stoten = [[0, 0.38], [0.55, 0.93]];
    for (var s = 0; s < stoten.length; s++) {
      var a = stoten[s][0], b = stoten[s][1];
      for (var i = Math.floor(a * sr); i < Math.min(d.length, Math.floor(b * sr)); i++) {
        var t = i / sr;
        var omhulling = Math.min(1, (t - a) / 0.01, (b - t) / 0.04);
        var toon = (Math.sin(2 * Math.PI * 880 * t) + Math.sin(2 * Math.PI * 1320 * t) * 0.6) / 1.6;
        var tril = 0.6 + 0.4 * Math.sin(2 * Math.PI * 24 * t);
        d[i] = 0.5 * omhulling * toon * tril;
      }
    }
    return buf;
  }

  function startGeluid(intervalS) {
    var ctx = audio.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (audio.bron && audio.interval === intervalS) return;
    stopGeluid();
    try {
      var bron = ctx.createBufferSource();
      bron.buffer = belBuffer(ctx, intervalS);
      bron.loop = true;
      bron.connect(ctx.destination);
      bron.start();
      audio.bron = bron;
      audio.interval = intervalS;
    } catch (e) { console.warn('[support-alarm] geluid starten mislukt:', e && e.message); }
  }

  function stopGeluid() {
    if (!audio.bron) return;
    try { audio.bron.stop(); } catch (_) { /* al gestopt */ }
    try { audio.bron.disconnect(); } catch (_) { /* idem */ }
    audio.bron = null;
    audio.interval = null;
  }

  /** Eén keer "ding" ter bevestiging na het aanzetten. */
  function testDing() {
    var ctx = audio.ctx;
    if (!ctx || ctx.state !== 'running') return;
    try {
      var bron = ctx.createBufferSource();
      bron.buffer = belBuffer(ctx, 1);
      bron.connect(ctx.destination);
      bron.start();
    } catch (_) { /* geen ding, geen ramp */ }
  }

  function ontgrendel() {
    var ctx = audioCtx(true);
    if (!ctx) return Promise.resolve(false);
    var p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    return Promise.resolve(p).then(function () {
      if (ontgrendeld()) neemLeiding();
      render();
      return ontgrendeld();
    }, function () { return false; });
  }

  /** Eerste klik of toets op de pagina: geluid stil ontgrendelen. */
  function bijGebaar() {
    if (geluidKeuze() === 'aan' && !ontgrendeld()) ontgrendel();
  }

  function neemLeiding() {
    if (st.leiderGevraagd) return;
    st.leiderGevraagd = true;
    var locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') { st.leider = true; return; }
    try {
      locks.request(SLOT, function () {
        st.leider = true;
        render();
        return new Promise(function () { /* vasthouden tot het tabblad sluit */ });
      }).catch(function () { st.leider = true; render(); });
    } catch (_) { st.leider = true; }
  }

  // ── Bureaubladmelding ─────────────────────────────────────────────────────
  function kanMelden() {
    return typeof window.Notification === 'function' && window.Notification.permission === 'granted';
  }
  function vraagMeldingToestemming() {
    try {
      if (typeof window.Notification === 'function' && window.Notification.permission === 'default') {
        var r = window.Notification.requestPermission();
        if (r && typeof r.then === 'function') r.then(function () { render(); }, function () {});
      }
    } catch (_) { /* oudere browser */ }
  }
  function meldOpBureaublad(staat) {
    if (!kanMelden()) return;
    var inBeeld = document.visibilityState === 'visible'
      && (typeof document.hasFocus !== 'function' || document.hasFocus());
    if (inBeeld) return;
    staat.chats.forEach(function (c) {
      if (c.stilGezet) return;
      var k = stilSleutel(c, c.niveauNu);
      if (st.gemeld[k]) return;
      // Over tabbladen heen: één melding per chat per niveau.
      var gedeeld = 'kv_support_alarm_gemeld:' + k;
      if (lees(gedeeld)) { st.gemeld[k] = 1; return; }
      schrijf(gedeeld, String(Date.now()));
      st.gemeld[k] = 1;
      try {
        var tekst = balkTekst({ hoofd: c });
        var n = new window.Notification(tekst.kop, {
          body: tekst.rest,
          tag: 'dfo-support-' + c.id,
          requireInteraction: c.niveauNu === 'urgent',
        });
        n.onclick = function () {
          try { window.focus(); } catch (_) { /* best effort */ }
          beantwoord(c);
          try { n.close(); } catch (_) { /* al dicht */ }
        };
      } catch (_) { /* geen melding mogelijk */ }
    });
  }

  // ── Tabtitel + favicon ────────────────────────────────────────────────────
  var titel = { timer: null, origineel: null, tekst: null };
  function knipper(staat) {
    if (staat.knipperen) {
      titel.tekst = staat.titel;
      if (titel.timer) return;
      titel.origineel = document.title;
      titel.timer = setInterval(function () {
        if (document.title === titel.tekst) {
          document.title = titel.origineel || '';
        } else {
          titel.origineel = document.title;   // de module kan de titel intussen gewijzigd hebben
          document.title = titel.tekst;
        }
      }, 1000);
      return;
    }
    if (titel.timer) { clearInterval(titel.timer); titel.timer = null; }
    if (titel.tekst && document.title === titel.tekst) document.title = titel.origineel || '';
    titel.tekst = null;
  }

  var favicon = { getal: 0 };
  function zetFavicon(n) {
    if (n === favicon.getal) return;
    favicon.getal = n;
    var link = document.getElementById('kv-support-favicon');
    if (!n) { if (link && link.parentNode) link.parentNode.removeChild(link); return; }
    try {
      var c = document.createElement('canvas');
      c.width = 32; c.height = 32;
      var g = c.getContext('2d');
      if (!g) return;
      g.fillStyle = '#10284A';
      g.beginPath(); g.arc(14, 18, 13, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#FFC21A';
      g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('D', 14, 19);
      g.fillStyle = '#dc2626';
      g.beginPath(); g.arc(23, 9, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.font = 'bold 12px sans-serif';
      g.fillText(n > 9 ? '9+' : String(n), 23, 10);
      if (!link) {
        link = document.createElement('link');
        link.id = 'kv-support-favicon';
        link.rel = 'icon';
        (document.head || document.body).appendChild(link);
      }
      link.href = c.toDataURL('image/png');
    } catch (_) { /* geen canvas: geen badge */ }
  }

  // ── DOM ───────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function stijl() {
    if (document.getElementById('kv-support-alarm-stijl')) return;
    var el = document.createElement('style');
    el.id = 'kv-support-alarm-stijl';
    el.textContent = [
      '#' + BANNER_ID + '{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 18px;font:600 13.5px/1.35 \'IBM Plex Sans\',system-ui,sans-serif;color:#fff;background:#0f766e;border-bottom:1px solid #115e59}',
      '#' + BANNER_ID + '[data-variant="urgent"]{background:#b91c1c;border-bottom-color:#7f1d1d}',
      '#' + BANNER_ID + ' .kvsa-stip{width:10px;height:10px;border-radius:50%;background:#fff;flex-shrink:0;animation:kvsaPuls 1s ease-in-out infinite}',
      '#' + BANNER_ID + ' .kvsa-tekst{flex:1;min-width:180px}',
      '#' + BANNER_ID + ' .kvsa-meta{font-weight:500;opacity:.85}',
      '#' + BANNER_ID + ' button{font:700 12.5px/1 inherit;border-radius:7px;padding:7px 12px;cursor:pointer;border:1px solid rgba(255,255,255,.55);background:transparent;color:#fff;white-space:nowrap}',
      '#' + BANNER_ID + ' button.kvsa-hoofd{background:#fff;color:#0f766e;border-color:#fff}',
      '#' + BANNER_ID + '[data-variant="urgent"] button.kvsa-hoofd{color:#b91c1c}',
      '#' + BANNER_ID + ' button[disabled]{opacity:.6;cursor:default}',
      '@keyframes kvsaPuls{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}',
      '@keyframes kvsaSchud{0%,100%{transform:rotate(0)}20%{transform:rotate(14deg)}40%{transform:rotate(-12deg)}60%{transform:rotate(8deg)}80%{transform:rotate(-5deg)}}',
      '#' + BEL_ID + '[data-rinkelt="1"] svg{animation:kvsaSchud .9s ease-in-out infinite;transform-origin:50% 10%}',
      '#' + BEL_ID + ' .kv-notif-badge{background:#0f766e}',
      '#' + BEL_ID + '[data-variant="urgent"] .kv-notif-badge{background:#dc2626}',
      '.kvsa-rij{display:flex;flex-direction:column;gap:6px;padding:11px 14px;border-bottom:1px solid var(--border,#e5e7eb)}',
      '.kvsa-rij[data-variant="urgent"]{background:rgba(220,38,38,.07)}',
      '.kvsa-rij-kop{font-size:13px;font-weight:650;color:var(--text,#111)}',
      '.kvsa-rij-sub{font-size:12px;color:var(--text-2,#555)}',
      '.kvsa-rij-knoppen{display:flex;gap:6px;flex-wrap:wrap}',
      '.kvsa-paneel-voet{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;font-size:12px;color:var(--text-2,#555);flex-wrap:wrap}',
      '#kv-support-geluidvraag{position:fixed;right:16px;bottom:16px;z-index:99998;max-width:330px;background:var(--surface,#fff);color:var(--text,#111);border:1px solid var(--border,#e5e7eb);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.18);padding:14px 16px;font:500 13px/1.45 \'IBM Plex Sans\',system-ui,sans-serif}',
      '#kv-support-geluidvraag .kvsa-vraag-knoppen{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    ].join('\n');
    (document.head || document.body).appendChild(el);
  }

  function tekenBalk(staat) {
    var stapel = window.KVBannerStapel;
    var bestaand = document.getElementById(BANNER_ID);
    if (!staat.zichtbaar) {
      if (bestaand && stapel) stapel.haalWeg(bestaand);
      else if (bestaand && bestaand.parentNode) bestaand.parentNode.removeChild(bestaand);
      return;
    }
    var h = staat.hoofd;
    var t = balkTekst(staat);
    var bar = bestaand || document.createElement('div');
    bar.id = BANNER_ID;
    bar.setAttribute('role', 'alert');
    bar.setAttribute('data-variant', h.niveauNu);
    var meta = ' · wacht ' + wachtTekst(h.wachtNu) + (staat.meer ? ' · +' + staat.meer + ' meer' : '');
    var bezig = !!st.actie[h.id];
    var geluidKnop = staat.rinkelen && !ontgrendeld() && geluidKeuze() === 'aan'
      ? '<button type="button" data-kvsa="geluid" title="Je browser wacht op een klik voor het geluid">&#128264; Klik voor geluid</button>' : '';
    bar.innerHTML =
      '<span class="kvsa-stip" aria-hidden="true"></span>' +
      '<span class="kvsa-tekst"><b>' + esc(t.kop) + '</b> — ' + esc(t.rest) +
        '<span class="kvsa-meta">' + esc(meta) + '</span></span>' +
      geluidKnop +
      '<button type="button" class="kvsa-hoofd" data-kvsa="beantwoord">Beantwoorden</button>' +
      (h.voor_mij ? '' : '<button type="button" data-kvsa="neem"' + (bezig ? ' disabled' : '') + '>' + (bezig ? 'Bezig…' : 'Ik neem het') + '</button>') +
      (staat.onbevestigd ? '<button type="button" data-kvsa="stil" title="Stopt het belletje in deze browser tot de chat escaleert">Stil</button>' : '');
    bar.querySelectorAll('[data-kvsa]').forEach(function (knop) {
      knop.addEventListener('click', function () {
        var a = knop.getAttribute('data-kvsa');
        if (a === 'beantwoord') beantwoord(h);
        else if (a === 'neem') neem(h);
        else if (a === 'stil') zetStil(staat.chats);
        else if (a === 'geluid') ontgrendel();
      });
    });
    if (stapel) stapel.plaats(bar, VOLGORDE);
    else if (!bar.parentNode) document.body.insertBefore(bar, document.body.firstChild);
  }

  var BEL_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" '
    + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>'
    + '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M2 8c0-2.2.7-4.3 2-6"/><path d="M22 8a10 10 0 0 0-2-6"/></svg>';

  function maakBel() {
    if (document.getElementById(BEL_ID)) return;
    var notif = document.querySelector('.kv-notif-wrap');
    var ouder = notif ? notif.parentNode : document.querySelector('.topbar');
    if (!ouder) return;
    var wrap = document.createElement('div');
    wrap.className = 'kv-notif-wrap kvsa-bel-wrap';
    wrap.innerHTML =
      '<button type="button" id="' + BEL_ID + '" class="kv-notif-btn" aria-label="Onbeantwoorde chats" aria-haspopup="true" aria-expanded="false" title="Onbeantwoorde chats">' +
        BEL_SVG + '<span class="kv-notif-badge" data-kvsa-teller hidden>0</span></button>' +
      '<div class="kv-notif-panel" data-kvsa-paneel hidden></div>';
    ouder.insertBefore(wrap, notif || null);
    var knop = wrap.querySelector('#' + BEL_ID);
    var paneel = wrap.querySelector('[data-kvsa-paneel]');
    knop.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var open = paneel.hidden;
      paneel.hidden = !open;
      knop.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { tekenPaneel(st.laatsteStaat); ververs(); }
    });
    document.addEventListener('click', function (ev) {
      // Een knop in het paneel kan het paneel net hertekend hebben; dan hangt
      // het doelwit niet meer in de pagina en is het géén klik ernaast.
      if (paneel.hidden || !ev.target || ev.target.isConnected === false || wrap.contains(ev.target)) return;
      paneel.hidden = true;
      knop.setAttribute('aria-expanded', 'false');
    });
  }

  function tekenBel(staat) {
    var knop = document.getElementById(BEL_ID);
    if (!knop) return;
    var teller = knop.querySelector('[data-kvsa-teller]');
    if (teller) {
      // Alleen bij verschil: dit draait elke vijf seconden, en textContent
      // vervangt de tekstnode ook als het getal gelijk bleef.
      var tekst = staat.teller > 99 ? '99+' : String(staat.teller);
      if (teller.hidden !== !staat.teller) teller.hidden = !staat.teller;
      if (teller.textContent !== tekst) teller.textContent = tekst;
    }
    knop.setAttribute('data-variant', staat.variant || '');
    knop.setAttribute('data-rinkelt', staat.onbevestigd ? '1' : '0');
    knop.title = staat.teller ? staat.teller + (staat.teller === 1 ? ' onbeantwoorde chat' : ' onbeantwoorde chats') : 'Geen onbeantwoorde chats';
    tekenPaneel(staat);
  }

  function tekenPaneel(staat) {
    var paneel = document.querySelector('[data-kvsa-paneel]');
    if (!paneel || paneel.hidden || !staat) return;
    var keuze = geluidKeuze();
    var html = '<div class="kv-notif-head"><div class="kv-notif-title">Chats</div></div><div class="kv-notif-list">';
    if (!staat.chats.length) html += '<div class="kv-notif-empty">Geen onbeantwoorde chats.</div>';
    staat.chats.forEach(function (c, i) {
      var t = balkTekst({ hoofd: c });
      html += '<div class="kvsa-rij" data-variant="' + esc(c.niveauNu) + '">' +
        '<div class="kvsa-rij-kop">' + esc(t.rest) + '</div>' +
        '<div class="kvsa-rij-sub">' + esc(c.niveauNu === 'urgent' ? 'Wacht al ' + wachtTekst(c.wachtNu) : 'Wacht ' + wachtTekst(c.wachtNu)) +
          (c.voor_mij ? ' · bij jou' : '') + (c.stilGezet ? ' · stil' : '') + '</div>' +
        '<div class="kvsa-rij-knoppen">' +
          '<button type="button" class="btn btn-sm btn-primary" data-kvsa-p="beantwoord" data-i="' + i + '">Beantwoorden</button>' +
          (c.voor_mij ? '' : '<button type="button" class="btn btn-sm btn-ghost" data-kvsa-p="neem" data-i="' + i + '">Ik neem het</button>') +
        '</div></div>';
    });
    html += '</div><div class="kvsa-paneel-voet">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-kvsa-p="keuze"' +
        (keuze === 'aan' ? ' checked' : '') + '> Geluid in deze browser</label>' +
      (staat.onbevestigd ? '<button type="button" class="btn btn-sm btn-ghost" data-kvsa-p="stil">Stil</button>' : '') +
      (typeof window.Notification === 'function' && window.Notification.permission === 'default'
        ? '<button type="button" class="btn btn-sm btn-ghost" data-kvsa-p="melding">Bureaubladmeldingen aan</button>' : '') +
      '<a href="/modules/klanten-v2/?v2preview=support" data-kvsa-p="naar">Naar Support &rarr;</a>' +
      (st.instellingen.geluid === false ? '<div style="width:100%;opacity:.8">Het belletje staat team-breed uit (Support → Instellingen).</div>' : '') +
      '</div>';
    paneel.innerHTML = html;
    paneel.querySelectorAll('[data-kvsa-p]').forEach(function (el) {
      var a = el.getAttribute('data-kvsa-p');
      var c = staat.chats[Number(el.getAttribute('data-i'))];
      el.addEventListener(a === 'keuze' ? 'change' : 'click', function (ev) {
        if (a === 'beantwoord' && c) beantwoord(c);
        else if (a === 'neem' && c) neem(c);
        else if (a === 'stil') zetStil(staat.chats);
        else if (a === 'melding') vraagMeldingToestemming();
        else if (a === 'keuze') kiesGeluid(el.checked ? 'aan' : 'uit');
        else if (a === 'naar') {
          var dfo = window.DFO;
          if (dfo && typeof dfo.goMod === 'function') { ev.preventDefault(); try { dfo.goMod('support'); } catch (_) { window.location.href = el.href; } }
        }
      });
    });
  }

  /** Eén keer per browser: "Klik om chatgeluid aan te zetten". */
  function tekenGeluidVraag() {
    var bestaand = document.getElementById('kv-support-geluidvraag');
    if (geluidKeuze() !== null) { if (bestaand && bestaand.parentNode) bestaand.parentNode.removeChild(bestaand); return; }
    if (bestaand) return;
    var el = document.createElement('div');
    el.id = 'kv-support-geluidvraag';
    el.setAttribute('role', 'dialog');
    el.innerHTML = '<b>&#128276; Chatmeldingen</b><div>Rinkelt het als iemand in de supportchat zit? Je browser laat geluid pas toe na een klik.</div>' +
      '<div class="kvsa-vraag-knoppen"><button type="button" class="btn btn-sm btn-primary" data-kvsa-v="aan">Klik om chatgeluid aan te zetten</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-kvsa-v="uit">Liever niet</button></div>';
    el.querySelector('[data-kvsa-v="aan"]').addEventListener('click', function () {
      kiesGeluid('aan');
      vraagMeldingToestemming();
    });
    el.querySelector('[data-kvsa-v="uit"]').addEventListener('click', function () { kiesGeluid('uit'); });
    document.body.appendChild(el);
  }

  // ── Acties ────────────────────────────────────────────────────────────────
  function kiesGeluid(keuze) {
    schrijf(KEUZE_SLEUTEL, keuze);
    if (keuze === 'aan') {
      ontgrendel().then(function (ok) { if (ok) testDing(); });
    } else {
      stopGeluid();
    }
    render();
  }

  function zetStil(chats) {
    schrijf(stilSleutelOpslag(), JSON.stringify(markeerStil(leesStil(), chats, Date.now())));
    render();
  }

  function openGesprek(id) {
    var dfo = window.DFO;
    var inShell = String(window.location.pathname || '').indexOf('/modules/klanten-v2/') === 0;
    if (inShell && dfo && typeof dfo.goMod === 'function') {
      try {
        var u = new URL(window.location.href);
        ['v2preview', 'v2tab', 'id', 'tab', 'deal_id', 'invoice_id', 'subscription_id'].forEach(function (k) { u.searchParams.delete(k); });
        u.searchParams.set('gesprek', id);
        u.hash = 'support';
        window.history.pushState({}, '', u.toString());
        dfo.goMod('support');
        if (typeof dfo.render === 'function') dfo.render();
        return;
      } catch (_) { /* val terug op een gewone navigatie */ }
    }
    window.location.href = GESPREK_PAD + encodeURIComponent(id);
  }

  function beantwoord(chat) {
    if (!chat) return;
    zetStil([chat]);
    openGesprek(chat.id);
  }

  async function neem(chat) {
    var o = st.opties || {};
    if (!chat || st.actie[chat.id] || typeof o.haal !== 'function') return;
    st.actie[chat.id] = true;
    render();
    try {
      var r = await o.haal('/api/support-gesprek-update', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gesprek_id: chat.id, toegewezen_aan: 'mij', alleen_als_vrij: true }),
      });
      var d = {};
      try { d = await r.json(); } catch (_) { d = {}; }
      if (r.ok || (r.status === 409 && d.toegewezen_aan && d.toegewezen_aan === st.ik)) {
        toast('Je hebt de chat van ' + (chat.naam || 'de bezoeker') + ' opgepakt');
        zetStil([chat]);
        openGesprek(chat.id);
      } else {
        toast(d.error || 'Oppakken lukte niet — probeer het opnieuw');
      }
    } catch (_) {
      toast('Oppakken lukte niet — controleer je verbinding');
    } finally {
      delete st.actie[chat.id];
      ververs();
    }
  }

  function toast(tekst) {
    var o = st.opties || {};
    try { if (typeof o.toast === 'function') o.toast(tekst); } catch (_) { /* geen toast */ }
  }

  // ── Levenscyclus ──────────────────────────────────────────────────────────
  function render() {
    if (!st.gestart) return;
    var staat = alarmStaat({
      chats: st.chats, nu: Date.now(), gehaaldOp: st.gehaaldOp,
      instellingen: st.instellingen, stil: leesStil(), geluidKeuze: geluidKeuze(),
    });
    st.laatsteStaat = staat;
    tekenBalk(staat);
    tekenBel(staat);
    tekenGeluidVraag();
    knipper(staat);
    zetFavicon(staat.teller);
    if (staat.rinkelen && st.leider && ontgrendeld()) startGeluid(staat.interval_s);
    else stopGeluid();
    meldOpBureaublad(staat);
  }

  function stop() {
    if (st.timer) { clearInterval(st.timer); st.timer = null; }
    if (st.tik) { clearInterval(st.tik); st.tik = null; }
    stopGeluid();
    knipper({ knipperen: false });
    zetFavicon(0);
    try { if (st.kanaal && window.supabase && window.supabase.removeChannel) window.supabase.removeChannel(st.kanaal); } catch (_) { /* best effort */ }
    st.kanaal = null;
  }

  async function ververs() {
    var o = st.opties || {};
    if (st.bezig || typeof o.haal !== 'function') return;
    st.bezig = true;
    try {
      var r = await o.haal('/api/support-alarm');
      if (r && (r.status === 401 || r.status === 403)) {
        // Geen supportrechten (meer): alles weg, niet blijven vragen.
        st.chats = []; render(); stop();
        var wrap = document.querySelector('.kvsa-bel-wrap');
        if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
        st.gestart = false;
        return;
      }
      if (!r || !r.ok) return;            // tijdelijke fout: laatste stand blijft staan
      var d = await r.json();
      st.chats = Array.isArray(d.chats) ? d.chats : [];
      if (d.instellingen) st.instellingen = d.instellingen;
      if (d.ik) st.ik = d.ik;
      st.gehaaldOp = Date.now();
      render();
    } catch (_) {
      /* netwerkfout: laatste stand blijft staan, de volgende ronde probeert weer */
    } finally {
      st.bezig = false;
    }
  }

  function planVervers() {
    if (st.plan) return;
    st.plan = setTimeout(function () { st.plan = null; ververs(); }, 400);
  }

  function koppelRealtime() {
    var sb = window.supabase;
    if (!sb || typeof sb.channel !== 'function') return;
    try {
      st.kanaal = sb.channel('kv-support-alarm')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'support_gesprekken' }, planVervers)
        .subscribe();
    } catch (e) {
      console.warn('[support-alarm] realtime niet beschikbaar, alleen de poll:', e && e.message);
    }
  }

  /**
   * @param {{ haal:(url:string, init?:object)=>Promise<Response>, userId:string, toast?:Function }} opties
   */
  /** Oude "al gemeld"-merktekens (bureaubladmelding) opruimen. */
  function ruimGemeldOp() {
    try {
      var grens = Date.now() - STIL_BEWAAR_MS;
      var weg = [];
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf('kv_support_alarm_gemeld:') === 0 && !(Number(window.localStorage.getItem(k)) > grens)) weg.push(k);
      }
      weg.forEach(function (k) { window.localStorage.removeItem(k); });
    } catch (_) { /* geen opslag: niets op te ruimen */ }
  }

  function start(opties) {
    if (st.gestart) return;
    st.gestart = true;
    ruimGemeldOp();
    st.opties = opties || {};
    st.ik = st.opties.userId || null;
    stijl();
    maakBel();
    ververs();
    st.timer = setInterval(ververs, POLL_MS);
    st.tik = setInterval(render, TIK_MS);
    koppelRealtime();
    document.addEventListener('pointerdown', bijGebaar, true);
    document.addEventListener('keydown', bijGebaar, true);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') ververs();
    });
    // Stil gezet of geluid gekozen in een ander tabblad → hier ook.
    window.addEventListener('storage', function (ev) {
      if (!ev || !ev.key || ev.key === KEUZE_SLEUTEL || ev.key.indexOf('kv_support_alarm_stil:') === 0) render();
    });
    window.addEventListener('beforeunload', stop);
  }

  window.KVSupportAlarm = {
    // puur
    alarmStaat: alarmStaat,
    niveauNu: niveauNu,
    stilSleutel: stilSleutel,
    wachtTekst: wachtTekst,
    markeerStil: markeerStil,
    balkTekst: balkTekst,
    // levenscyclus
    start: start,
    ververs: ververs,
    render: render,
    // voor tests
    _st: st,
    POLL_MS: POLL_MS,
    BANNER_ID: BANNER_ID,
    BEL_ID: BEL_ID,
    KEUZE_SLEUTEL: KEUZE_SLEUTEL,
  };
})();
