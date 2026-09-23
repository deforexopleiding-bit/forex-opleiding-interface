/* ==========================================================================
 * De Forex Opleiding — supportwidget
 *
 * Eén <script>-regel in de Webflow site-settings en de widget staat er:
 *   <script src="https://crm.deforexopleiding.nl/widget/support.js" async></script>
 *
 * ── WAAROM SHADOW DOM EN GEEN IFRAME ───────────────────────────────────────
 * Twee redenen. De harde: vercel.json zet X-Frame-Options: SAMEORIGIN en CSP
 * frame-ancestors 'self', dus een iframe van het CRM op de Webflow-site wordt
 * door de browser geweigerd. De praktische: een shadow root houdt Webflow's
 * eigen CSS buiten de widget én de widget-CSS buiten de site. Geen van beide
 * kan de ander slopen, en dat scheelt op termijn meer dan het kost.
 *
 * ── GEEN AFHANKELIJKHEDEN ──────────────────────────────────────────────────
 * Geen framework, geen fonts van buiten, geen build. Dit bestand wordt op
 * élke pagina van de website geladen; alles wat er extra bij komt, komt bij
 * iedere bezoeker bij. Het is dan ook bewust klein gehouden en het doet
 * niets tot iemand op de knop klikt — de eerste netwerkcall gaat pas bij het
 * openen van het venster.
 *
 * ── OPSLAG ─────────────────────────────────────────────────────────────────
 * Het sessietoken gaat in localStorage zodat een refresh het gesprek niet
 * weggooit. Alle lees- en schrijfacties staan in try/catch: in een
 * privévenster of met geblokkeerde site-data gooit localStorage, en dan moet
 * de widget gewoon werken zonder geheugen.
 * ======================================================================== */
(function () {
  'use strict';

  if (window.__dfoSupportGeladen) return;
  window.__dfoSupportGeladen = true;

  // De herkomst van dit script is ook de herkomst van de API. Zo hoeft de
  // URL nergens hardcoded en werkt een preview-deploy vanzelf.
  var BASIS = (function () {
    try {
      var el = document.currentScript || (function () {
        var s = document.getElementsByTagName('script');
        for (var i = s.length - 1; i >= 0; i--) if (/widget\/support\.js/.test(s[i].src)) return s[i];
        return null;
      })();
      return el ? new URL(el.src).origin : 'https://crm.deforexopleiding.nl';
    } catch (_) {
      return 'https://crm.deforexopleiding.nl';
    }
  })();

  var OPSLAG = 'dfo-support-sessie';
  var POLL_MS = 5000;
  var BEWAAR_MS = 30 * 24 * 3600 * 1000;

  // De parameter waarmee onze mails naar een lopend gesprek wijzen. Er staat
  // alleen een kenmerk in, nooit een token — zie api/_lib/support-hervat.js.
  var HERVAT_PARAM = 'dfo-support';
  var KENMERK_RE = /^SUP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

  var st = {
    open: false,
    stap: 'start',       // start | onderwerp | formulier | chat
    soort: null,
    onderwerp: null,
    config: null,
    token: null,
    gesprek: null,
    berichten: [],
    bezig: false,
    fout: null,
    onbereikbaar: false,
    codeVeld: false,
    codeBezig: false,
    hervatKenmerk: null,
    hervatGestuurd: false,
    laatsteTijd: null,
    pollTimer: null,
    ongelezen: 0,
  };

  /* ── opslag ───────────────────────────────────────────────────────────── */
  function bewaar(v) { try { localStorage.setItem(OPSLAG, JSON.stringify(v)); } catch (_) {} }
  function lees() { try { return JSON.parse(localStorage.getItem(OPSLAG) || 'null'); } catch (_) { return null; } }
  function wis() { try { localStorage.removeItem(OPSLAG); } catch (_) {} }

  /* ── netwerk ──────────────────────────────────────────────────────────── */
  function api(pad, opties) {
    opties = opties || {};
    var h = { 'Content-Type': 'application/json' };
    if (st.token) h['X-Support-Token'] = st.token;
    return fetch(BASIS + '/api/' + pad, {
      method: opties.method || 'GET',
      headers: h,
      body: opties.body ? JSON.stringify(opties.body) : undefined,
      credentials: 'omit',
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (_) {}
        if (!r.ok) {
          var f = new Error((j && j.error) || 'Er ging iets mis (' + r.status + ')');
          f.status = r.status;
          throw f;
        }
        return j;
      });
    });
  }

  /* ── opmaak ───────────────────────────────────────────────────────────── */
  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.wrap{position:fixed;right:20px;bottom:20px;z-index:2147483000;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    '--navy:#10284A;--geel:#FFC21A;--ink:#111721;--zacht:#586374;--lijn:#E2E7EE;',
    '--vlak:#F4F6F9;--wit:#fff;--r:14px}',
    '@media (max-width:520px){.wrap{right:12px;bottom:12px;left:12px}}',

    '.knop{position:absolute;right:0;bottom:0;display:flex;align-items:center;gap:9px;',
    'height:54px;padding:0 20px 0 17px;border:0;border-radius:27px;background:var(--navy);',
    'color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 8px 26px rgba(16,40,74,.28);',
    'transition:transform .16s ease,box-shadow .16s ease}',
    '.knop:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(16,40,74,.34)}',
    '.knop svg{width:21px;height:21px;flex:0 0 auto}',
    '.knop .tl{position:absolute;top:-4px;right:-4px;min-width:21px;height:21px;padding:0 6px;',
    'border-radius:11px;background:#E23D4C;color:#fff;font-size:11.5px;font-weight:700;',
    'display:flex;align-items:center;justify-content:center;border:2px solid #fff}',

    // Hoogte volgt de inhoud in de keuze- en formulierstappen; in de chat is
    // 'ie vast, want daar moet de thread scrollen onder een vaste invoerbalk.
    '.paneel{width:394px;max-width:calc(100vw - 24px);max-height:calc(100vh - 100px);',
    'background:var(--wit);border-radius:18px;overflow:hidden;display:flex;flex-direction:column;',
    'box-shadow:0 24px 64px rgba(16,32,58,.24),0 2px 8px rgba(16,32,58,.1);',
    'transform-origin:bottom right;animation:in .2s cubic-bezier(.2,.8,.3,1)}',
    '@keyframes in{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}',
    '.paneel.chat{height:592px}',
    '@media (max-width:520px){.paneel{height:calc(100vh - 92px)}.paneel.chat{height:calc(100vh - 92px)}}',

    '.kop{background:var(--navy);color:#fff;padding:17px 18px 16px;flex:0 0 auto;position:relative}',
    '.kop h2{margin:0;font-size:16.5px;font-weight:650;letter-spacing:-.01em}',
    '.kop p{margin:5px 0 0;font-size:13px;line-height:1.45;color:rgba(255,255,255,.72)}',
    '.kop .x{position:absolute;top:13px;right:12px;width:30px;height:30px;border:0;border-radius:8px;',
    'background:rgba(255,255,255,.1);color:#fff;font-size:17px;line-height:1;cursor:pointer}',
    '.kop .x:hover{background:rgba(255,255,255,.2)}',
    '.status{display:inline-flex;align-items:center;gap:6px;margin-top:11px;padding:4px 10px 4px 8px;',
    'border-radius:20px;background:rgba(255,255,255,.12);font-size:11.5px;font-weight:550;color:rgba(255,255,255,.9)}',
    '.stip{width:7px;height:7px;border-radius:50%;background:#7BE3A8;flex:0 0 auto}',
    '.stip.uit{background:#FFC21A}',

    '.body{flex:1;overflow-y:auto;padding:18px;background:var(--wit)}',
    '.body::-webkit-scrollbar{width:9px}',
    '.body::-webkit-scrollbar-thumb{background:#D6DCE5;border-radius:5px;border:3px solid #fff}',

    '.vraag{margin:0 0 13px;font-size:13.5px;font-weight:600;color:var(--ink)}',
    '.keuzes{display:flex;flex-direction:column;gap:9px}',
    '.keuze{display:flex;align-items:flex-start;gap:11px;width:100%;padding:13px 14px;text-align:left;',
    'border:1px solid var(--lijn);border-radius:var(--r);background:var(--wit);cursor:pointer;',
    'transition:border-color .13s,background .13s,transform .13s}',
    '.keuze:hover{border-color:var(--navy);background:var(--vlak);transform:translateX(2px)}',
    '.keuze b{display:block;font-size:13.8px;font-weight:600;color:var(--ink);line-height:1.35}',
    '.keuze span{display:block;margin-top:2px;font-size:12.2px;color:var(--zacht);line-height:1.4}',
    '.keuze .pijl{margin-left:auto;align-self:center;color:#B6C0CD;font-size:16px}',

    '.terug{display:inline-flex;align-items:center;gap:5px;margin:0 0 14px;padding:0;border:0;',
    'background:none;color:var(--zacht);font-size:12.5px;cursor:pointer}',
    '.terug:hover{color:var(--navy)}',

    '.veld{margin-bottom:12px}',
    '.veld label{display:block;margin-bottom:5px;font-size:12.3px;font-weight:600;color:var(--ink)}',
    '.veld input,.veld textarea{width:100%;padding:10px 12px;border:1px solid var(--lijn);',
    'border-radius:10px;font:inherit;font-size:13.5px;color:var(--ink);background:var(--wit);outline:none}',
    '.veld input:focus,.veld textarea:focus{border-color:var(--navy);box-shadow:0 0 0 3px rgba(16,40,74,.09)}',
    '.veld textarea{min-height:92px;resize:vertical;line-height:1.5}',
    '.hp{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;opacity:0!important}',

    '.btn{width:100%;padding:12px 16px;border:0;border-radius:11px;background:var(--navy);color:#fff;',
    'font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .13s,transform .13s}',
    '.btn:hover:not(:disabled){transform:translateY(-1px)}',
    '.btn:disabled{opacity:.5;cursor:default}',
    '.btn.geel{background:var(--geel);color:var(--navy)}',
    '.btn.rand{background:var(--wit);color:var(--navy);border:1px solid var(--lijn)}',
    '.btn.rand:hover{background:var(--vlak)}',

    '.fout{margin:0 0 12px;padding:10px 12px;border-radius:10px;background:#FDECEE;',
    'border:1px solid #F6C9CF;color:#9A2130;font-size:12.6px;line-height:1.45}',
    '.hint{margin:11px 0 0;font-size:11.6px;line-height:1.5;color:#8B95A5}',

    '.thread{display:flex;flex-direction:column;gap:11px}',
    '.bl{max-width:84%;padding:10px 13px;border-radius:15px;font-size:13.6px;line-height:1.52;',
    'white-space:pre-wrap;word-wrap:break-word;animation:op .18s ease}',
    '@keyframes op{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}',
    '.bl.klant{align-self:flex-end;background:var(--navy);color:#fff;border-bottom-right-radius:5px}',
    '.bl.ons{align-self:flex-start;background:var(--vlak);color:var(--ink);border-bottom-left-radius:5px}',
    '.bl.sys{align-self:center;max-width:100%;text-align:center;background:#FFF8E4;color:#7A5A06;',
    'font-size:12.3px;border-radius:10px;padding:9px 13px}',
    '.van{margin:0 0 3px;font-size:11px;font-weight:650;color:var(--zacht);letter-spacing:.01em}',
    '.tik{align-self:flex-start;display:flex;gap:4px;padding:12px 14px;background:var(--vlak);border-radius:15px}',
    '.tik i{width:6px;height:6px;border-radius:50%;background:#A9B4C2;animation:tk 1.3s infinite}',
    '.tik i:nth-child(2){animation-delay:.18s}.tik i:nth-child(3){animation-delay:.36s}',
    '@keyframes tk{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',

    '.code{display:flex;gap:8px;margin-top:13px}',
    '.code input{flex:1;padding:11px 13px;border:1px solid var(--lijn);border-radius:10px;font:inherit;',
    'font-size:18px;letter-spacing:6px;text-align:center;outline:none}',
    '.code input:focus{border-color:var(--navy)}',
    '.code button{padding:0 18px;border:0;border-radius:10px;background:var(--navy);color:#fff;',
    'font:inherit;font-weight:600;font-size:13.5px;cursor:pointer}',

    '.voet{flex:0 0 auto;border-top:1px solid var(--lijn);padding:11px 12px;background:var(--wit)}',
    '.invoer{display:flex;gap:8px;align-items:flex-end}',
    '.invoer textarea{flex:1;max-height:110px;min-height:42px;padding:11px 13px;border:1px solid var(--lijn);',
    'border-radius:12px;font:inherit;font-size:13.5px;line-height:1.45;resize:none;outline:none}',
    '.invoer textarea:focus{border-color:var(--navy)}',
    '.verstuur{width:42px;height:42px;flex:0 0 auto;border:0;border-radius:12px;background:var(--navy);',
    'color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.verstuur:disabled{opacity:.45;cursor:default}',
    '.verstuur svg{width:18px;height:18px}',
    '.mensknop{display:block;width:100%;margin-top:9px;padding:8px;border:0;background:none;',
    'color:var(--zacht);font:inherit;font-size:12.2px;cursor:pointer;border-radius:8px}',
    '.mensknop:hover{background:var(--vlak);color:var(--navy)}',
    '.merk{padding:0 12px 10px;text-align:center;font-size:10.8px;color:#A9B4C2}',
  ].join('');

  /* ── mount ────────────────────────────────────────────────────────────── */
  var host = document.createElement('div');
  host.setAttribute('data-dfo-support', '');
  var root = host.attachShadow({ mode: 'open' });
  var stijl = document.createElement('style');
  stijl.textContent = CSS;
  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  root.appendChild(stijl);
  root.appendChild(wrap);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var IC_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/></svg>';
  var IC_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4z"/></svg>';

  /* ── weergave ─────────────────────────────────────────────────────────── */
  function teken() {
    if (!st.open) {
      wrap.innerHTML =
        '<button class="knop" data-a="open">' + IC_CHAT + '<span>' +
        esc((st.config && st.config.titel) || 'Hulp nodig?') + '</span>' +
        (st.ongelezen ? '<span class="tl">' + st.ongelezen + '</span>' : '') +
        '</button>';
      bind();
      return;
    }

    var live = st.config && st.config.live;
    var kop =
      '<div class="kop">' +
      '<button class="x" data-a="sluit" aria-label="Sluiten">&times;</button>' +
      '<h2>' + esc((st.config && st.config.titel) || 'Hulp nodig?') + '</h2>' +
      '<p>' + esc((st.config && st.config.welkom) || '') + '</p>' +
      '<span class="status"><span class="stip' + (live ? '' : ' uit') + '"></span>' +
      (live ? 'Er is nu iemand bereikbaar' : esc((st.config && st.config.bereikbaarheid) || 'We reageren per mail')) +
      '</span></div>';

    wrap.innerHTML = '<div class="paneel' + (st.stap === 'chat' ? ' chat' : '') + '">' + kop + tekenBody() + '</div>';
    bind();
    var b = root.querySelector('.body');
    if (b && st.stap === 'chat') b.scrollTop = b.scrollHeight;
  }

  function tekenBody() {
    if (st.stap === 'chat') return tekenChat();

    var h = '<div class="body">';

    if (st.onbereikbaar) {
      return h + '<p style="margin:0 0 12px;font-size:13.5px;line-height:1.6;color:#111721">' +
        'De chat is op dit moment niet bereikbaar.</p>' +
        '<p style="margin:0;font-size:13.5px;line-height:1.6;color:#586374">Mail ons gerust op ' +
        '<a href="mailto:info@deforexopleiding.nl" style="color:#10284A;font-weight:600">info@deforexopleiding.nl</a>' +
        ' of bel <a href="tel:+31851308362" style="color:#10284A;font-weight:600">+31 85 130 83 62</a>. ' +
        'We komen er snel op terug.</p></div>';
    }

    if (st.fout) h += '<div class="fout">' + esc(st.fout) + '</div>';

    if (st.stap === 'hervat') {
      h += '<p class="vraag">Je gesprek ' + esc(st.hervatKenmerk) + '</p>';
      if (!st.hervatGestuurd) {
        h += '<p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:#586374">' +
          'We sturen een code van zes cijfers naar het mailadres waarop je onze mail kreeg. ' +
          'Zo weten we zeker dat jij het bent voordat we het gesprek openen.</p>' +
          '<button class="btn" data-a="hervat-code"' + (st.bezig ? ' disabled' : '') + '>' +
          (st.bezig ? 'Bezig…' : 'Stuur me de code') + '</button>';
      } else {
        h += '<p style="margin:0 0 14px;font-size:13.5px;line-height:1.6;color:#586374">' +
          'Kijk in je mailbox — ook even in de spam. De code is tien minuten geldig.</p>' +
          '<div class="veld"><label for="f-hervat">Code</label>' +
          '<input id="f-hervat" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></div>' +
          '<button class="btn" data-a="hervat-open"' + (st.bezig ? ' disabled' : '') + '>' +
          (st.bezig ? 'Bezig…' : 'Open mijn gesprek') + '</button>';
      }
      h += '<button class="terug" data-a="nieuw" style="margin-top:14px">Liever een nieuwe vraag stellen</button>';
      return h + '</div>';
    }

    if (st.stap === 'start') {
      h += '<p class="vraag">Volg je al een traject bij ons?</p><div class="keuzes">' +
        '<button class="keuze" data-a="soort" data-v="klant"><div><b>Ja, ik ben student</b>' +
        '<span>Vragen over het LMS, Discord, je mentor of je facturen</span></div><span class="pijl">&rsaquo;</span></button>' +
        '<button class="keuze" data-a="soort" data-v="bezoeker"><div><b>Nee, nog niet</b>' +
        '<span>Informatie, een gesprek inplannen of een event</span></div><span class="pijl">&rsaquo;</span></button>' +
        '</div>';
    }

    if (st.stap === 'onderwerp') {
      var lijst = (st.config && st.config.onderwerpen && st.config.onderwerpen[st.soort]) || [];
      h += '<button class="terug" data-a="terug">&lsaquo; terug</button>' +
        '<p class="vraag">Waar gaat je vraag over?</p><div class="keuzes">' +
        lijst.map(function (o) {
          return '<button class="keuze" data-a="onderwerp" data-v="' + esc(o.id) + '"><div><b>' +
            esc(o.label) + '</b>' + (o.hint ? '<span>' + esc(o.hint) + '</span>' : '') +
            '</div><span class="pijl">&rsaquo;</span></button>';
        }).join('') + '</div>';
    }

    if (st.stap === 'formulier') {
      var isKlant = st.soort === 'klant';
      h += '<button class="terug" data-a="terug">&lsaquo; terug</button>';

      // Snelle antwoorden vóór het formulier: wie alleen een link zoekt,
      // hoeft geen gegevens achter te laten.
      var l = (st.config && st.config.links) || {};
      if (st.onderwerp === 'call' && l.agenda) {
        h += '<div class="fout" style="background:#EAF4FF;border-color:#C6E0FB;color:#164C86">' +
          'Direct een gesprek inplannen kan hier: <a href="' + esc(l.agenda) + '" target="_blank" rel="noopener" style="color:#164C86;font-weight:600">de agenda</a>. ' +
          'Liever eerst iets vragen? Vul hieronder je vraag in.</div>';
      }
      if (st.onderwerp === 'event' && l.events) {
        h += '<div class="fout" style="background:#EAF4FF;border-color:#C6E0FB;color:#164C86">' +
          'Alle events staan op <a href="' + esc(l.events) + '" target="_blank" rel="noopener" style="color:#164C86;font-weight:600">de eventpagina</a>. ' +
          'Iets anders nodig? Stel je vraag hieronder.</div>';
      }

      h += '<div class="veld"><label for="f-naam">Je naam</label><input id="f-naam" autocomplete="name"></div>' +
        '<div class="veld"><label for="f-mail">E-mailadres</label><input id="f-mail" type="email" autocomplete="email"></div>' +
        (isKlant ? '<div class="veld"><label for="f-tel">Telefoonnummer</label><input id="f-tel" type="tel" autocomplete="tel"></div>' : '') +
        '<div class="veld"><label for="f-vraag">Je vraag</label><textarea id="f-vraag" placeholder="Beschrijf kort wat er speelt"></textarea></div>' +
        '<input class="hp" id="f-bedrijf" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<button class="btn" data-a="start"' + (st.bezig ? ' disabled' : '') + '>' +
        (st.bezig ? 'Even geduld…' : 'Vraag versturen') + '</button>' +
        '<p class="hint">' + (isKlant
          ? 'Gaat je vraag over je LMS-toegang, je traject of een factuur? Dan sturen we je eerst een code per mail — zo weten we zeker dat wij met jou praten voordat we je gegevens erbij pakken.'
          : 'We gebruiken je gegevens alleen om je vraag te beantwoorden.') + '</p>';
    }

    return h + '</div>';
  }

  function tekenChat() {
    var h = '<div class="body"><div class="thread">';

    st.berichten.forEach(function (b) {
      if (b.afzender === 'systeem') {
        h += '<div class="bl sys">' + esc(b.tekst) + '</div>';
        return;
      }
      if (b.afzender === 'klant') {
        h += '<div class="bl klant">' + esc(b.tekst) + '</div>';
        return;
      }
      var naam = b.naam || (b.afzender === 'bot' ? 'Sam' : 'De Forex Opleiding');
      h += '<div><p class="van">' + esc(naam) + '</p><div class="bl ons">' + esc(b.tekst) + '</div></div>';
    });

    if (st.bezig) h += '<div class="tik"><i></i><i></i><i></i></div>';
    h += '</div>';

    if (st.codeVeld) {
      h += '<div class="code"><input id="f-code" inputmode="numeric" maxlength="6" placeholder="000000">' +
        '<button data-a="code"' + (st.codeBezig ? ' disabled' : '') + '>' +
        (st.codeBezig ? '…' : 'Bevestig') + '</button></div>' +
        '<p class="hint">Geen mail gezien? Kijk ook even in je spam.</p>';
    }
    if (st.fout) h += '<div class="fout" style="margin-top:12px">' + esc(st.fout) + '</div>';
    h += '</div>';

    var klaar = st.gesprek && st.gesprek.status === 'afgehandeld';
    h += '<div class="voet">';
    if (klaar) {
      h += '<button class="btn rand" data-a="nieuw">Nieuw gesprek starten</button>';
    } else {
      h += '<div class="invoer"><textarea id="f-bericht" rows="1" placeholder="Typ je bericht…"></textarea>' +
        '<button class="verstuur" data-a="stuur"' + (st.bezig ? ' disabled' : '') + ' aria-label="Versturen">' + IC_SEND + '</button></div>' +
        '<button class="mensknop" data-a="mens">Liever een medewerker spreken?</button>';
    }
    h += '</div><div class="merk">De Forex Opleiding</div>';
    return h;
  }

  /* ── interactie ───────────────────────────────────────────────────────── */
  function bind() {
    root.querySelectorAll('[data-a]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        e.preventDefault();
        doe(el.getAttribute('data-a'), el.getAttribute('data-v'));
      });
    });

    var ta = root.querySelector('#f-bericht');
    if (ta) {
      ta.addEventListener('keydown', function (e) {
        // Enter verstuurt, shift+enter is een nieuwe regel — zoals in elke
        // chat die mensen al kennen.
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doe('stuur'); }
      });
      ta.addEventListener('input', function () {
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 110) + 'px';
      });
      ta.focus();
    }
    var code = root.querySelector('#f-code');
    if (code) {
      code.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doe('code'); } });
      code.focus();
    }
  }

  function doe(actie, waarde) {
    st.fout = null;

    if (actie === 'open') { open(); return; }
    if (actie === 'sluit') { st.open = false; stopPoll(); teken(); return; }

    if (actie === 'terug') {
      st.stap = st.stap === 'formulier' ? 'onderwerp' : 'start';
      teken(); return;
    }
    if (actie === 'soort') { st.soort = waarde; st.stap = 'onderwerp'; teken(); return; }
    if (actie === 'onderwerp') { st.onderwerp = waarde; st.stap = 'formulier'; teken(); return; }
    if (actie === 'start') { start(); return; }
    if (actie === 'stuur') { stuur(false); return; }
    if (actie === 'mens') { stuur(true); return; }
    if (actie === 'code') { checkCode(); return; }
    if (actie === 'hervat-code') { vraagHervatCode(); return; }
    if (actie === 'hervat-open') { openHervat(); return; }
    if (actie === 'nieuw') {
      wis();
      st.token = null; st.gesprek = null; st.berichten = []; st.stap = 'start';
      st.soort = null; st.onderwerp = null; st.codeVeld = false;
      st.hervatKenmerk = null; st.hervatGestuurd = false;
      teken(); return;
    }
  }

  function open() {
    st.open = true;
    st.ongelezen = 0;
    teken();

    if (!st.config) {
      api('support-widget-config').then(function (c) {
        if (!c || c.aan === false) { st.open = false; teken(); return; }
        st.config = c;
        st.onbereikbaar = false;
        teken();
      }).catch(function () {
        // Geen keuzestappen tonen die we toch niet kunnen invullen; alleen
        // zeggen hoe de bezoeker ons dan wél bereikt.
        st.onbereikbaar = true;
        teken();
      });
    }
    if (st.token && st.stap === 'chat') startPoll();
  }

  function veld(id) {
    var el = root.querySelector('#' + id);
    return el ? el.value.trim() : '';
  }

  function start() {
    var body = {
      soort: st.soort,
      onderwerp: st.onderwerp,
      naam: veld('f-naam'),
      email: veld('f-mail'),
      telefoon: veld('f-tel'),
      vraag: veld('f-vraag'),
      bedrijf: veld('f-bedrijf'),
      bron_url: location.href.slice(0, 500),
    };
    if (!body.naam || !body.email || !body.vraag) {
      st.fout = 'Vul je naam, e-mailadres en je vraag in.';
      teken(); return;
    }

    st.bezig = true; teken();

    api('support-start', { method: 'POST', body: body }).then(function (r) {
      st.token = r.token;
      st.gesprek = r.gesprek;
      st.stap = 'chat';
      st.berichten = [{ afzender: 'klant', tekst: body.vraag, created_at: new Date().toISOString() }];
      st.laatsteTijd = new Date().toISOString();
      bewaar({ token: r.token, tijd: Date.now() });

      if (r.verificatie_nodig) return vraagCode();

      // Geen verificatie nodig: meteen de bot laten antwoorden op de vraag
      // die al in de thread staat. Dat scheelt de bezoeker een tweede keer
      // typen.
      return laatBotAntwoorden(body.vraag);
    }).catch(function (e) {
      st.fout = e.message;
    }).then(function () {
      st.bezig = false;
      teken();
      startPoll();
    });
  }

  function vraagCode() {
    return api('support-verificatie-start', { method: 'POST', body: {} }).then(function (r) {
      if (r && r.al_geverifieerd) { st.codeVeld = false; return; }
      st.codeVeld = true;
      st.berichten.push({
        afzender: 'systeem',
        tekst: 'Ik heb een code gestuurd naar ' + ((st.gesprek && st.gesprek.email) || 'je mailadres') +
          '. Vul die hieronder in, dan kan ik je gegevens erbij pakken.',
        created_at: new Date().toISOString(),
      });
    }).catch(function (e) {
      st.berichten.push({
        afzender: 'systeem',
        tekst: e.message + ' Een collega pakt je vraag op.',
        created_at: new Date().toISOString(),
      });
    });
  }

  function checkCode() {
    var code = veld('f-code');
    if (code.length !== 6) { st.fout = 'Vul de zes cijfers in.'; teken(); return; }

    st.codeBezig = true; teken();
    api('support-verificatie-check', { method: 'POST', body: { code: code } }).then(function (r) {
      st.gesprek = r.gesprek;
      st.codeVeld = false;
      st.berichten.push({ afzender: 'systeem', tekst: 'Gelukt. Ik kijk het even na.', created_at: new Date().toISOString() });
      st.codeBezig = false;
      st.bezig = true;
      teken();
      // De oorspronkelijke vraag opnieuw langs de bot, nu mét gegevens.
      var eerste = st.berichten.find(function (b) { return b.afzender === 'klant'; });
      return laatBotAntwoorden(eerste ? eerste.tekst : 'Kun je mijn status nakijken?');
    }).catch(function (e) {
      st.fout = e.message;
    }).then(function () {
      st.codeBezig = false;
      st.bezig = false;
      teken();
    });
  }

  // Stuurt een bericht dat de bezoeker al gesteld heeft nog eens naar de
  // server zodat de bot erop reageert, zonder het dubbel in de thread te
  // tonen: het antwoord komt terug, de echo gooien we weg.
  function laatBotAntwoorden(tekst) {
    return api('support-bericht', { method: 'POST', body: { tekst: tekst, stil: true } })
      .then(function (r) { verwerkAntwoord(r, true); })
      .catch(function () {
        st.berichten.push({
          afzender: 'systeem',
          tekst: 'Je vraag staat bij ons. Je krijgt antwoord per mail.',
          created_at: new Date().toISOString(),
        });
      });
  }

  function stuur(vraagtMens) {
    var tekst = vraagtMens ? 'Ik wil graag een medewerker spreken.' : veld('f-bericht');
    if (!tekst) return;

    st.berichten.push({ afzender: 'klant', tekst: tekst, created_at: new Date().toISOString() });
    st.bezig = true;
    teken();

    api('support-bericht', { method: 'POST', body: { tekst: tekst, vraagt_mens: !!vraagtMens } })
      .then(function (r) { verwerkAntwoord(r, false); })
      .catch(function (e) { st.fout = e.message; })
      .then(function () { st.bezig = false; teken(); startPoll(); });
  }

  function verwerkAntwoord(r, negeerEcho) {
    if (!r) return;
    if (!negeerEcho && r.bericht) st.laatsteTijd = r.bericht.created_at;
    (r.antwoorden || []).forEach(function (a) {
      st.berichten.push(a);
      if (a.created_at) st.laatsteTijd = a.created_at;
    });
    if (r.status && st.gesprek) st.gesprek.status = r.status;
    if (r.verificatie_nodig && !(st.gesprek && st.gesprek.geverifieerd)) vraagCode();
  }

  /* ── polling ──────────────────────────────────────────────────────────── */
  function startPoll() {
    stopPoll();
    if (!st.token) return;
    st.pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPoll() {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }

  function poll() {
    // Niet pollen als de tab op de achtergrond staat. Een gesloten laptop
    // hoeft ons geen verzoek per vijf seconden te sturen.
    if (document.hidden) return;

    var q = st.laatsteTijd ? '?sinds=' + encodeURIComponent(st.laatsteTijd) : '';
    api('support-poll' + q).then(function (r) {
      if (!r) return;
      var nieuw = 0;
      (r.berichten || []).forEach(function (b) {
        if (st.berichten.some(function (x) { return x.id && x.id === b.id; })) return;
        st.berichten.push(b);
        st.laatsteTijd = b.created_at;
        nieuw++;
      });
      if (r.gesprek) st.gesprek = r.gesprek;
      if (st.config) st.config.live = r.live;

      if (nieuw) {
        if (!st.open) st.ongelezen += nieuw;
        teken();
      }
    }).catch(function (e) {
      // Een 401 is geen netwerkhikje: dit token geldt niet meer. Dat gebeurt
      // wanneer hetzelfde gesprek elders is heropend — support-hervat-check
      // geeft één sleutel per gesprek uit. Blijven pollen levert dan alleen
      // een bevroren venster op, dus we zeggen wat er aan de hand is.
      if (e && e.status === 401) {
        stopPoll();
        wis();
        st.token = null;
        st.berichten = [];
        st.gesprek = null;
        st.stap = 'start';
        st.fout = 'Je hebt dit gesprek ergens anders geopend. Daar staat alles.';
        teken();
        return;
      }
      // Verder: volgende ronde weer; geen melding, dat is alleen maar
      // verwarrend voor een bezoeker die niets fout deed.
    });
  }

  /* ── terugkomen via de link in onze mail ──────────────────────────────── */

  // Het kenmerk uit de URL, en meteen weg uit de adresbalk. Er staat geen
  // geheim in, maar een URL die blijft staan wordt gedeeld en gebookmarkt, en
  // dan opent er straks een leeg codescherm bij iemand anders.
  function kenmerkUitUrl() {
    var k = null;
    try {
      var p = new URLSearchParams(location.search);
      var ruw = (p.get(HERVAT_PARAM) || '').trim().toUpperCase();
      if (!KENMERK_RE.test(ruw)) return null;
      k = ruw;
      p.delete(HERVAT_PARAM);
      var rest = p.toString();
      history.replaceState(null, '', location.pathname + (rest ? '?' + rest : '') + location.hash);
    } catch (_) { return null; }
    return k;
  }

  function vraagHervatCode() {
    st.bezig = true; st.fout = null; teken();
    api('support-hervat-start', { method: 'POST', body: { kenmerk: st.hervatKenmerk } })
      .then(function () { st.hervatGestuurd = true; })
      .catch(function (e) { st.fout = e.message; })
      .then(function () { st.bezig = false; teken(); });
  }

  function openHervat() {
    var code = veld('f-hervat');
    if (code.length !== 6) { st.fout = 'Vul de zes cijfers in.'; teken(); return; }

    st.bezig = true; st.fout = null; teken();
    api('support-hervat-check', { method: 'POST', body: { kenmerk: st.hervatKenmerk, code: code } })
      .then(function (r) {
        st.token = r.token;
        bewaar({ token: r.token, tijd: Date.now() });
        st.gesprek = r.gesprek;
        st.hervatKenmerk = null;
        st.hervatGestuurd = false;
        // De hele thread ophalen, niet alleen wat er na nu bij komt: de
        // bezoeker komt juist terug om te lezen wat er gezegd is.
        return api('support-poll?volledig=1').then(function (p) {
          st.berichten = (p && p.berichten) || [];
          if (p && p.gesprek) st.gesprek = p.gesprek;
          if (st.berichten.length) st.laatsteTijd = st.berichten[st.berichten.length - 1].created_at;
          st.stap = 'chat';
          st.ongelezen = 0;
          startPoll();
        });
      })
      .catch(function (e) { st.fout = e.message; })
      .then(function () { st.bezig = false; teken(); });
  }

  /* ── herstel na refresh ───────────────────────────────────────────────── */
  function herstel() {
    var bewaard = lees();
    // Dertig dagen. Eerder stond hier een dag, en dat was te kort: een vraag
    // die 's ochtends gesteld wordt en 's middags beantwoord, hoort de dag
    // erna nog gewoon open te staan als de bezoeker terugkomt kijken.
    if (!bewaard || !bewaard.token || (Date.now() - (bewaard.tijd || 0)) > BEWAAR_MS) {
      if (bewaard) wis();
      return Promise.resolve();
    }
    st.token = bewaard.token;
    return api('support-poll?volledig=1')
      .then(function (r) {
        if (!r || !r.gesprek) { wis(); st.token = null; return; }
        st.gesprek = r.gesprek;
        st.stap = 'chat';
        st.berichten = r.berichten || [];
        if (st.berichten.length) st.laatsteTijd = st.berichten[st.berichten.length - 1].created_at;
        st.ongelezen = 0;
        startPoll();
      })
      .catch(function () { wis(); st.token = null; });
  }

  function startWidget() {
    document.body.appendChild(host);
    teken();
    // Config alvast ophalen zodat de knop de juiste titel toont, maar pas
    // ná de eerste render: de bezoeker ziet de widget meteen, ook als de
    // server traag is.
    var uitMail = kenmerkUitUrl();

    api('support-widget-config').then(function (c) {
      if (!c || c.aan === false) { host.remove(); return; }
      st.config = c;

      // Komt de bezoeker via de link in onze mail, dan gaat dat vóór wat er
      // toevallig in deze browser bewaard staat — de link wijst naar een
      // specifiek gesprek, en dat is wat 'ie wil zien.
      if (uitMail) {
        st.hervatKenmerk = uitMail;
        st.hervatGestuurd = false;
        st.stap = 'hervat';
        st.open = true;
        return;
      }
      return herstel();
    }).then(function () { teken(); }).catch(function () {
      // Geen config betekent: we weten niet welke onderwerpen er zijn, of we
      // bereikbaar zijn, of wat er al loopt. Een knop die dan tóch opent,
      // zet de bezoeker in een keuzescherm dat nergens heen gaat. Liever
      // helemaal geen knop dan een knop die doodloopt — de site heeft haar
      // eigen contactpagina.
      host.remove();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startWidget);
  } else {
    startWidget();
  }
})();
