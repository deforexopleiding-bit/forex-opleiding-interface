/* ==========================================================================
 * De Forex Opleiding — supportwidget
 *
 * Eén <script>-regel op de website en de widget staat er:
 *   <script src="https://crm.deforexopleiding.nl/widget/support.js" async></script>
 *
 * ── WAAROM SHADOW DOM EN GEEN IFRAME ───────────────────────────────────────
 * Twee redenen. De harde: vercel.json zet X-Frame-Options: SAMEORIGIN en CSP
 * frame-ancestors 'self', dus een iframe van het CRM op de website wordt
 * door de browser geweigerd. De praktische: een shadow root houdt de CSS van
 * de site buiten de widget én de widget-CSS buiten de site.
 *
 * ── GEEN AFHANKELIJKHEDEN ──────────────────────────────────────────────────
 * Geen framework, geen fonts van buiten, geen build. Dit bestand wordt op
 * élke pagina van de website geladen; alles wat er extra bij komt, komt bij
 * iedere bezoeker bij. Het lettertype is dat van de site zelf ("Instrument
 * Sans" staat daar al geladen) met een systeemfont als terugval.
 *
 * ── WAAROM HET VENSTER NIET MEER IN ÉÉN KEER OPNIEUW GETEKEND WORDT ──────────
 * Tot september 2026 zette elke render — ook elke poll van vijf seconden —
 * het hele venster opnieuw via innerHTML. Dat gaf precies de klachten:
 *   * het tekstveld werd vervangen terwijl je typte (cursor weg, soms tekst
 *     weg, toetsenbord op mobiel dicht en weer open);
 *   * de openingsanimatie van het paneel en van élk bericht speelde bij elke
 *     render opnieuw af → flikkeren;
 *   * de thread sprong naar beneden, ook als je net naar boven scrolde.
 * Nu staat het skelet (knop, paneel, kop, statusbalk, thread, invoer) er één
 * keer en werkt elke render alleen bij wat er veranderd is. Nieuwe berichten
 * worden aangehangen, niet opnieuw getekend. De keuzestappen en formulieren
 * worden alleen vervangen als hun inhoud echt anders is, en dan blijven
 * ingevulde velden en de focus staan.
 *
 * Op iPhone zoomt Safari in op elk invoerveld met een lettergrootte onder
 * 16px — de pagina "springt" dan bij elke tik. Alle velden zijn daarom 16px.
 *
 * ── OPSLAG ─────────────────────────────────────────────────────────────────
 * Het sessietoken gaat in localStorage zodat een refresh het gesprek niet
 * weggooit. Alle lees- en schrijfacties staan in try/catch: in een
 * privévenster of met geblokkeerde site-data gooit localStorage, en dan moet
 * de widget gewoon werken zonder geheugen.
 *
 * ── VANAF DE PAGINA ZELF OPENEN ────────────────────────────────────────────
 *   window.DFOSupport.open()                 — vanuit eigen code
 *   <a href="#support">…</a>                 — elke link naar #support
 *   <button data-dfo-support-open>…</button> — elk element met dit attribuut
 *   <div data-dfo-support-kaart></div>       — hier komt een supportkaart
 * Op /contact zet de widget die kaart zelf in het blok "Direct contact" als
 * er nergens een data-dfo-support-kaart staat.
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
  var TEASER_OPSLAG = 'dfo-support-teaser';
  var POLL_MS = 5000;
  // Met het venster dicht maar een lopend gesprek pollen we één op de vier
  // rondes (± 20 s): genoeg om een antwoord als badge op de knop te zetten,
  // zonder dat de bezoeker als "in de chat" telt (zie `dicht=1`).
  var POLL_DICHT_ELKE = 4;
  var BEWAAR_MS = 30 * 24 * 3600 * 1000;
  var TEASER_PAUZE_MS = 3 * 24 * 3600 * 1000;
  var MAIL = 'info@deforexopleiding.nl';
  var TEL = '+31 85 130 83 62';
  var TEL_HREF = 'tel:+31851308362';

  // De parameter waarmee onze mails naar een lopend gesprek wijzen. Er staat
  // alleen een kenmerk in, nooit een token — zie api/_lib/support-hervat.js.
  var HERVAT_PARAM = 'dfo-support';
  var KENMERK_RE = /^SUP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

  var st = {
    open: false,
    stap: 'start',       // start | onderwerp | formulier | chat | hervat
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
    volledigNodig: false,
    laatsteTijd: null,
    pollTimer: null,
    pollTel: 0,
    ongelezen: 0,
  };

  /* ── opslag ───────────────────────────────────────────────────────────── */
  function bewaar(v) { try { localStorage.setItem(OPSLAG, JSON.stringify(v)); } catch (_) {} }
  function lees() { try { return JSON.parse(localStorage.getItem(OPSLAG) || 'null'); } catch (_) { return null; } }
  function wis() { try { localStorage.removeItem(OPSLAG); } catch (_) {} }

  // Is dit token echt niet meer geldig? Alleen dán ruimen we de sessie op.
  // Twee sloten, want opruimen gooit een lopend gesprek weg: de status moet
  // 401 zijn ÉN de server moet er zelf SESSIE_ONGELDIG bij zetten. Een 503
  // (storing), een netwerkfout of een kale 401 van iets anders dan onze API
  // (proxy, deploy-beveiliging) laat de sessie staan. Zie gesprekUitToken in
  // api/_lib/support-sessie.js.
  function tokenOngeldig(e) {
    return !!(e && e.status === 401 && e.code === 'SESSIE_ONGELDIG');
  }

  // Naar de chat met het token dat we hebben, en de thread laten ophalen door
  // de poll. Niet wachten op een eerste geslaagde call: lukt die niet, dan
  // staat de bezoeker tenminste in zijn gesprek en vult de volgende ronde het
  // aan, in plaats van dat hij op een scherm blijft hangen dat nergens heen
  // gaat.
  function naarChat() {
    st.stap = 'chat';
    st.berichten = [];
    st.laatsteTijd = null;
    st.volledigNodig = true;
    st.ongelezen = 0;
    startPoll();
  }

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
          f.code = (j && j.code) || null;
          throw f;
        }
        return j;
      });
    });
  }

  /* ── opmaak ───────────────────────────────────────────────────────────── */
  // Kleuren van de website zelf (:root op deforexopleiding.nl): night/deep/
  // ink voor de donkere vlakken, goud als accent, paper als achtergrond.
  // De knop is goud: op een donkere site verdwijnt een donkerblauwe knop.
  var CSS = [
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.wrap{position:fixed;right:22px;bottom:22px;z-index:2147483000;',
    'font-family:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    '-webkit-font-smoothing:antialiased;color:#0d2230;',
    '--night:#03151d;--deep:#04202d;--ink:#093d54;--gold:#c98b2e;--gold2:#e3a94c;--goldzacht:#fbf3e6;',
    '--paper:#f6f8f9;--lijn:#dce6ea;--mut:#4f7085;--tekst:#0d2230;--groen:#2dbd6e;--wit:#fff}',
    'button{font-family:inherit}',

    /* ── knop ── */
    '.knop{position:relative;display:flex;align-items:center;gap:11px;height:60px;padding:0 22px 0 8px;',
    'border:0;border-radius:30px;cursor:pointer;color:var(--night);',
    'background:linear-gradient(135deg,var(--gold2),var(--gold));',
    'box-shadow:0 10px 30px rgba(201,139,46,.38),0 2px 6px rgba(3,21,29,.25);',
    'transition:transform .2s cubic-bezier(.2,.8,.3,1),box-shadow .2s,opacity .2s}',
    '.knop:hover{transform:translateY(-2px);box-shadow:0 14px 38px rgba(201,139,46,.46),0 3px 8px rgba(3,21,29,.28)}',
    '.knop:focus-visible{outline:3px solid #fff;outline-offset:3px}',
    '.knop .bol{position:relative;width:44px;height:44px;border-radius:50%;background:var(--night);',
    'display:flex;align-items:center;justify-content:center;color:var(--gold2);flex:0 0 auto}',
    '.knop .bol svg{width:22px;height:22px}',
    '.knop .aan{position:absolute;right:1px;bottom:1px;width:12px;height:12px;border-radius:50%;',
    'background:var(--groen);border:2px solid var(--gold)}',
    '.knop .aan[hidden]{display:none}',
    '.knop .txt{display:flex;flex-direction:column;align-items:flex-start;line-height:1.15;text-align:left}',
    '.knop .txt b{font-size:15.5px;font-weight:700;letter-spacing:-.01em}',
    '.knop .txt small{font-size:12px;font-weight:550;opacity:.78;margin-top:2px}',
    '.knop .tl{position:absolute;top:-5px;right:-3px;min-width:22px;height:22px;padding:0 6px;',
    'border-radius:11px;background:#d8373f;color:#fff;font-size:12px;font-weight:700;',
    'display:flex;align-items:center;justify-content:center;border:2px solid #fff}',
    '.knop .tl[hidden]{display:none}',
    '.knop.dicht{width:60px;padding:0;justify-content:center;background:#fff;color:var(--night);',
    'box-shadow:0 10px 30px rgba(3,21,29,.35),0 0 0 1px rgba(3,21,29,.06)}',
    '.knop.dicht .bol,.knop.dicht .txt,.knop.dicht .tl{display:none}',
    '.knop .kruis{display:none;width:22px;height:22px}',
    '.knop.dicht .kruis{display:block}',
    // Een zachte ring die een paar keer uitdijt, zodat het oog de knop vindt.
    // Drie keer, niet eindeloos: een knop die blijft pulsen, gaat irriteren.
    '.knop.puls::after{content:"";position:absolute;inset:0;border-radius:inherit;',
    'box-shadow:0 0 0 0 rgba(227,169,76,.55);animation:puls 2.4s ease-out 3}',
    '@keyframes puls{0%{box-shadow:0 0 0 0 rgba(227,169,76,.55)}80%,100%{box-shadow:0 0 0 16px rgba(227,169,76,0)}}',

    /* ── teaser ── */
    '.teaser{position:absolute;right:0;bottom:74px;width:268px;padding:14px 34px 14px 15px;background:#fff;',
    'border-radius:16px 16px 4px 16px;box-shadow:0 14px 40px rgba(3,21,29,.22),0 1px 3px rgba(3,21,29,.1);',
    'font-size:14px;line-height:1.45;color:var(--tekst);cursor:pointer;',
    'animation:omhoog .35s cubic-bezier(.2,.8,.3,1)}',
    '.teaser b{display:block;font-size:14.5px;margin-bottom:2px}',
    '.teaser .x{position:absolute;top:8px;right:8px;width:24px;height:24px;border:0;border-radius:6px;',
    'background:transparent;color:var(--mut);font-size:16px;cursor:pointer;line-height:1}',
    '.teaser .x:hover{background:var(--paper)}',
    '.teaser[hidden]{display:none}',
    '@keyframes omhoog{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}',

    /* ── paneel ── */
    '.paneel{position:absolute;right:0;bottom:76px;width:410px;height:min(690px,calc(100vh - 118px));',
    'background:var(--paper);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;',
    'box-shadow:0 30px 80px rgba(3,21,29,.32),0 2px 10px rgba(3,21,29,.12);',
    'transform-origin:bottom right;opacity:0;transform:translateY(14px) scale(.97);pointer-events:none;',
    'visibility:hidden;transition:opacity .22s ease,transform .26s cubic-bezier(.2,.8,.3,1),visibility 0s linear .26s}',
    '.paneel.open{opacity:1;transform:none;pointer-events:auto;visibility:visible;',
    'transition:opacity .22s ease,transform .26s cubic-bezier(.2,.8,.3,1),visibility 0s}',

    /* ── kop ── */
    '.kop{flex:0 0 auto;position:relative;color:#fff;padding:18px 18px 16px;',
    'background:radial-gradient(120% 140% at 100% 0%,#0b4a66 0%,var(--deep) 55%,var(--night) 100%)}',
    '.kop::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;',
    'background:linear-gradient(90deg,transparent,var(--gold) 30%,var(--gold2) 70%,transparent)}',
    '.kop .rij{display:flex;align-items:center;gap:12px;padding-right:40px}',
    '.avs{display:flex;flex:0 0 auto}',
    '.av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
    'font-size:15px;font-weight:700;border:2px solid var(--deep);position:relative}',
    '.av+.av{margin-left:-12px}',
    '.av.sam{background:linear-gradient(135deg,var(--gold2),var(--gold));color:var(--night)}',
    '.av.team{background:#e9f0f3;color:var(--ink)}',
    '.av.team svg{width:20px;height:20px}',
    '.av .punt{position:absolute;right:-1px;bottom:-1px;width:12px;height:12px;border-radius:50%;',
    'border:2px solid var(--deep);background:#8aa2ae}',
    '.av .punt.live{background:var(--groen)}',
    '.kop h2{margin:0;font-size:17px;font-weight:700;letter-spacing:-.015em;line-height:1.2}',
    '.kop .sub{margin:3px 0 0;font-size:12.8px;line-height:1.4;color:rgba(255,255,255,.74)}',
    '.kop .sub i{font-style:normal;color:#8ff0b8;font-weight:600}',
    '.kop .x{position:absolute;top:16px;right:14px;width:34px;height:34px;border:0;border-radius:10px;',
    'background:rgba(255,255,255,.1);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}',
    '.kop .x:hover{background:rgba(255,255,255,.2)}',
    '.kop .x svg{width:18px;height:18px}',

    /* ── statusbalk in de chat ── */
    '.strip{flex:0 0 auto;display:flex;gap:10px;align-items:flex-start;padding:10px 16px;',
    'font-size:12.8px;line-height:1.45;border-bottom:1px solid var(--lijn);background:#fff;color:var(--mut)}',
    '.strip[hidden]{display:none}',
    '.strip .ic{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;',
    'justify-content:center;margin-top:0}',
    '.strip .ic svg{width:13px;height:13px}',
    '.strip.bot .ic{background:var(--goldzacht);color:var(--gold)}',
    '.strip.live .ic{background:#e3f7ec;color:#18894c}',
    '.strip.wacht .ic{background:#e8f1f5;color:var(--ink)}',
    '.strip.mens .ic{background:#e3f7ec;color:#18894c}',
    '.strip b{color:var(--tekst);font-weight:650}',

    /* ── body ── */
    '.body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:18px 16px 20px;',
    '-webkit-overflow-scrolling:touch;scroll-behavior:auto}',
    '.body::-webkit-scrollbar{width:9px}',
    '.body::-webkit-scrollbar-thumb{background:#cfdbe1;border-radius:5px;border:3px solid var(--paper)}',
    '.stap{animation:stapin .22s ease}',
    '@keyframes stapin{from{opacity:0;transform:translateX(8px)}to{opacity:1;transform:none}}',

    '.hallo{margin:2px 2px 16px}',
    '.hallo h3{margin:0 0 4px;font-size:20px;font-weight:700;letter-spacing:-.02em;color:var(--tekst)}',
    '.hallo p{margin:0;font-size:14px;line-height:1.5;color:var(--mut)}',
    '.vraag{margin:0 2px 11px;font-size:13px;font-weight:650;color:var(--mut);letter-spacing:.01em}',
    '.keuzes{display:flex;flex-direction:column;gap:9px}',
    '.keuze{display:flex;align-items:center;gap:13px;width:100%;padding:14px 14px;text-align:left;',
    'border:1px solid var(--lijn);border-radius:14px;background:#fff;cursor:pointer;color:var(--tekst);',
    'transition:border-color .15s,box-shadow .15s,transform .15s}',
    '.keuze:hover{border-color:var(--gold);box-shadow:0 6px 18px rgba(3,21,29,.08);transform:translateY(-1px)}',
    '.keuze:focus-visible{outline:2px solid var(--gold);outline-offset:2px}',
    '.keuze .kic{flex:0 0 auto;width:40px;height:40px;border-radius:12px;background:var(--goldzacht);',
    'color:var(--gold);display:flex;align-items:center;justify-content:center}',
    '.keuze .kic svg{width:20px;height:20px}',
    '.keuze b{display:block;font-size:14.5px;font-weight:650;line-height:1.3}',
    '.keuze span.h{display:block;margin-top:2px;font-size:12.8px;color:var(--mut);line-height:1.4}',
    '.keuze .pijl{margin-left:auto;color:#a3b6c0;font-size:20px;line-height:1}',
    '.keuzes.klein .keuze{padding:12px 14px}',

    '.contact{margin-top:18px;padding:14px;border-radius:14px;background:#fff;border:1px solid var(--lijn)}',
    '.contact h4{margin:0 0 9px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}',
    '.crij{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:13.5px;color:var(--tekst)}',
    '.crij svg{width:17px;height:17px;color:var(--gold);flex:0 0 auto}',
    '.crij a{color:var(--tekst);text-decoration:none;font-weight:600}',
    '.crij a:hover{color:var(--gold)}',
    '.crij span{color:var(--mut)}',

    '.terug{display:inline-flex;align-items:center;gap:6px;margin:0 0 14px;padding:6px 10px 6px 6px;border:0;',
    'border-radius:8px;background:none;color:var(--mut);font-size:13px;font-weight:600;cursor:pointer}',
    '.terug:hover{background:#e9f0f3;color:var(--ink)}',

    '.veld{margin-bottom:12px}',
    '.veld label{display:block;margin-bottom:6px;font-size:13px;font-weight:650;color:var(--tekst)}',
    '.veld label small{font-weight:500;color:var(--mut)}',
    '.veld input,.veld textarea{width:100%;padding:12px 13px;border:1px solid var(--lijn);border-radius:11px;',
    'font:inherit;font-size:16px;color:var(--tekst);background:#fff;outline:none;-webkit-appearance:none;',
    'transition:border-color .15s,box-shadow .15s}',
    '.veld input:focus,.veld textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,139,46,.16)}',
    '.veld textarea{min-height:96px;resize:none;line-height:1.5}',
    '.hp{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;opacity:0!important}',

    '.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:14px 16px;border:0;',
    'border-radius:12px;background:var(--night);color:#fff;font:inherit;font-size:15px;font-weight:650;cursor:pointer;',
    'transition:opacity .15s,transform .15s,background .15s}',
    '.btn:hover:not(:disabled){background:var(--ink)}',
    '.btn:disabled{opacity:.55;cursor:default}',
    '.btn.goud{background:linear-gradient(135deg,var(--gold2),var(--gold));color:var(--night)}',
    '.btn.rand{background:#fff;color:var(--ink);border:1px solid var(--lijn)}',
    '.btn.rand:hover:not(:disabled){background:#eef3f5}',

    '.fout{margin:0 0 12px;padding:11px 13px;border-radius:11px;background:#fdecee;',
    'border:1px solid #f6c9cf;color:#9a2130;font-size:13px;line-height:1.45}',
    '.info{margin:0 0 14px;padding:11px 13px;border-radius:11px;background:#eaf3f7;border:1px solid #cfe2ea;',
    'color:var(--ink);font-size:13px;line-height:1.5}',
    '.info a{color:var(--ink);font-weight:700}',
    '.hint{margin:11px 2px 0;font-size:12px;line-height:1.5;color:#7d93a0}',
    '.p{margin:0 0 14px;font-size:14px;line-height:1.6;color:var(--mut)}',
    '.p a{color:var(--ink);font-weight:650}',

    /* ── thread ── */
    '.thread{display:flex;flex-direction:column;gap:12px}',
    '.bl{display:flex;flex-direction:column;max-width:86%}',
    '.bl.nieuw{animation:op .22s ease}',
    '@keyframes op{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
    '.bl .b{padding:10px 14px;border-radius:17px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;',
    'word-wrap:break-word;overflow-wrap:anywhere}',
    '.bl .t{margin-top:4px;font-size:11px;color:#8ba0ab}',
    '.bl.klant{align-self:flex-end;align-items:flex-end}',
    '.bl.klant .b{background:var(--ink);color:#fff;border-bottom-right-radius:5px}',
    '.bl.ons{align-self:flex-start;align-items:flex-start}',
    '.bl.ons .b{background:#fff;color:var(--tekst);border:1px solid var(--lijn);border-bottom-left-radius:5px}',
    '.bl.ons.mens .b{border-color:#bfe3cf;background:#f4fbf7}',
    '.van{display:flex;align-items:center;gap:7px;margin:0 0 5px 2px;font-size:12px;font-weight:650;color:var(--tekst)}',
    '.van .mini{width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
    'font-size:10.5px;font-weight:700}',
    '.van .mini.sam{background:linear-gradient(135deg,var(--gold2),var(--gold));color:var(--night)}',
    '.van .mini.mens{background:var(--ink);color:#fff}',
    '.van .tag{font-size:10.5px;font-weight:600;color:var(--mut);background:#e9f0f3;padding:2px 7px;border-radius:10px}',
    '.bl.sys{align-self:stretch;max-width:100%}',
    '.bl.sys .b{display:flex;gap:10px;align-items:flex-start;background:var(--goldzacht);color:#6b4a12;',
    'border:1px solid #f0dcb8;font-size:13.2px;border-radius:13px;padding:11px 13px}',
    '.bl.sys .b svg{flex:0 0 auto;width:17px;height:17px;margin-top:1px;color:var(--gold)}',
    '.tik{align-self:flex-start;display:flex;gap:4px;padding:13px 15px;background:#fff;border:1px solid var(--lijn);',
    'border-radius:17px;border-bottom-left-radius:5px}',
    '.tik[hidden]{display:none}',
    '.tik i{width:7px;height:7px;border-radius:50%;background:#9fb3be;animation:tk 1.3s infinite}',
    '.tik i:nth-child(2){animation-delay:.18s}.tik i:nth-child(3){animation-delay:.36s}',
    '@keyframes tk{0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}',

    '.code{display:flex;gap:8px;margin-top:14px}',
    '.code input{flex:1;min-width:0;padding:12px 13px;border:1px solid var(--lijn);border-radius:11px;font:inherit;',
    'font-size:20px;letter-spacing:7px;text-align:center;outline:none;background:#fff;color:var(--tekst)}',
    '.code input:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,139,46,.16)}',
    '.code button{padding:0 18px;border:0;border-radius:11px;background:var(--night);color:#fff;',
    'font:inherit;font-weight:650;font-size:14px;cursor:pointer}',
    '.code button:disabled{opacity:.55}',
    '.extra[hidden],.cfout[hidden]{display:none}',
    '.cfout{margin-top:12px}',

    /* ── invoer ── */
    '.voet{flex:0 0 auto;border-top:1px solid var(--lijn);padding:10px 12px 8px;background:#fff}',
    '.voet[hidden]{display:none}',
    '.invoer{display:flex;gap:8px;align-items:flex-end;padding:5px 5px 5px 14px;border:1px solid var(--lijn);',
    'border-radius:16px;background:var(--paper);transition:border-color .15s,box-shadow .15s}',
    '.invoer:focus-within{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,139,46,.14);background:#fff}',
    '.invoer textarea{flex:1;min-width:0;height:40px;max-height:120px;padding:9px 0;border:0;background:transparent;',
    'font:inherit;font-size:16px;line-height:1.4;resize:none;outline:none;color:var(--tekst)}',
    '.verstuur{width:40px;height:40px;flex:0 0 auto;border:0;border-radius:12px;',
    'background:linear-gradient(135deg,var(--gold2),var(--gold));color:var(--night);cursor:pointer;',
    'display:flex;align-items:center;justify-content:center;transition:opacity .15s,transform .15s}',
    '.verstuur:hover:not(:disabled){transform:scale(1.05)}',
    '.verstuur:disabled{opacity:.4;cursor:default}',
    '.verstuur svg{width:18px;height:18px}',
    '.mensknop{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:7px;padding:8px;',
    'border:0;background:none;color:var(--ink);font:inherit;font-size:13px;font-weight:600;cursor:pointer;border-radius:9px}',
    '.mensknop:hover{background:#eef3f5}',
    '.mensknop svg{width:15px;height:15px}',
    '.mensknop[hidden],.invoerblok[hidden],.klaarblok[hidden]{display:none}',
    '.merk{padding:6px 12px 2px;text-align:center;font-size:10.8px;color:#9fb0b9}',

    /* ── mobiel: volledig scherm ── */
    '@media (max-width:560px){',
    '.wrap{right:14px;bottom:14px}',
    '.knop{height:54px;padding:0 18px 0 6px}',
    '.knop .bol{width:42px;height:42px}',
    '.knop .txt small{display:none}',
    '.knop.dicht{display:none}',
    '.teaser{width:calc(100vw - 28px);max-width:300px;bottom:66px}',
    '.paneel{position:fixed;left:0;right:0;top:0;bottom:auto;width:100%;height:100%;border-radius:0;',
    'transform:translateY(24px);transform-origin:bottom center}',
    '.kop{padding-top:calc(16px + env(safe-area-inset-top,0px))}',
    '.voet{padding-bottom:calc(8px + env(safe-area-inset-bottom,0px))}',
    '}',
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}',
  ].join('');

  var KAART_CSS = [
    ':host{all:initial;display:block}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.k{display:flex;gap:14px;align-items:center;padding:16px;margin:4px 0 10px;border-radius:14px;',
    'background:linear-gradient(135deg,#04202d,#093d54);color:#fff;',
    'font-family:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'box-shadow:0 8px 24px rgba(3,21,29,.18)}',
    '.ic{position:relative;flex:0 0 auto;width:46px;height:46px;border-radius:13px;',
    'background:linear-gradient(135deg,#e3a94c,#c98b2e);color:#03151d;display:flex;align-items:center;justify-content:center}',
    '.ic svg{width:23px;height:23px}',
    '.ic .p{position:absolute;right:-3px;top:-3px;width:13px;height:13px;border-radius:50%;background:#8aa2ae;border:2px solid #04202d}',
    '.ic .p.live{background:#2dbd6e}',
    '.m{flex:1;min-width:0}',
    '.m b{display:block;font-size:15px;font-weight:700;letter-spacing:-.01em}',
    '.m span{display:block;margin-top:3px;font-size:12.8px;line-height:1.4;color:rgba(255,255,255,.75)}',
    'button{flex:0 0 auto;padding:11px 16px;border:0;border-radius:11px;cursor:pointer;',
    'background:linear-gradient(135deg,#e3a94c,#c98b2e);color:#03151d;font:inherit;font-size:14px;font-weight:700;',
    'transition:transform .15s}',
    'button:hover{transform:translateY(-1px)}',
    '@media (max-width:420px){.k{flex-wrap:wrap}button{width:100%}}',
  ].join('');

  /* ── iconen ───────────────────────────────────────────────────────────── */
  function ic(pad) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + pad + '</svg>';
  }
  var IC = {
    chat: ic('<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 20.5l1.6-4.9A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/><path d="M8 11.5h.01M12 11.5h.01M16 11.5h.01" stroke-width="2.6"/>'),
    send: ic('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
    x: ic('<path d="M18 6 6 18M6 6l12 12"/>'),
    neer: ic('<path d="m6 9 6 6 6-6"/>'),
    team: ic('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M19.5 19a3 3 0 0 1-3 3H13"/>'),
    student: ic('<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c3 2 9 2 12 0v-5"/>'),
    nieuw: ic('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>'),
    mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/>'),
    tel: ic('<path d="M6 3.5h3l1.5 4-2 1.2a10 10 0 0 0 4.8 4.8l1.2-2 4 1.5v3a2 2 0 0 1-2.2 2A15 15 0 0 1 4 5.7 2 2 0 0 1 6 3.5z"/>'),
    klok: ic('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    bot: ic('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>'),
    info: ic('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    check: ic('<path d="m5 12 5 5 9-10"/>'),
    mens: ic('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  };

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

  function isMobiel() {
    try { return window.matchMedia && window.matchMedia('(max-width:560px)').matches; } catch (_) { return false; }
  }
  function isTouch() {
    try { return window.matchMedia && window.matchMedia('(pointer:coarse)').matches; } catch (_) { return false; }
  }

  // Het skelet: één keer opgebouwd, daarna alleen bijgewerkt.
  wrap.innerHTML =
    '<div class="teaser" hidden role="button" tabindex="0" data-a="open">' +
      '<button class="x" data-a="teaser-weg" aria-label="Verbergen">&times;</button>' +
      '<b>Vragen? Wij helpen je graag.</b>' +
      'Over de opleiding, je traject of je factuur — stel je vraag hier in de chat.' +
    '</div>' +
    '<section class="paneel" role="dialog" aria-label="Support De Forex Opleiding" aria-hidden="true">' +
      '<header class="kop"></header>' +
      '<div class="strip" hidden></div>' +
      '<div class="body">' +
        '<div class="stapvak"></div>' +
        '<div class="chatvak" hidden>' +
          '<div class="thread" aria-live="polite"></div>' +
          '<div class="tik" hidden><i></i><i></i><i></i></div>' +
          '<div class="extra" hidden></div>' +
          '<div class="cfout fout" hidden></div>' +
        '</div>' +
      '</div>' +
      '<footer class="voet" hidden>' +
        '<div class="invoerblok">' +
          '<div class="invoer">' +
            '<textarea id="f-bericht" rows="1" placeholder="Typ je bericht…" aria-label="Je bericht" enterkeyhint="send"></textarea>' +
            '<button class="verstuur" data-a="stuur" aria-label="Versturen">' + IC.send + '</button>' +
          '</div>' +
          '<button class="mensknop" data-a="mens">' + IC.mens + '<span></span></button>' +
        '</div>' +
        '<div class="klaarblok" hidden><button class="btn rand" data-a="nieuw">Nieuw gesprek starten</button></div>' +
        '<div class="merk">De Forex Opleiding · support</div>' +
      '</footer>' +
    '</section>' +
    '<button class="knop" data-a="knop" aria-label="Open de support-chat">' +
      '<span class="bol">' + IC.chat + '<span class="aan" hidden></span></span>' +
      '<span class="txt"><b></b><small>Chat met ons supportteam</small></span>' +
      '<span class="kruis">' + IC.x + '</span>' +
      '<span class="tl" hidden></span>' +
    '</button>';

  var el = {
    knop: wrap.querySelector('.knop'),
    knopTitel: wrap.querySelector('.knop .txt b'),
    knopAan: wrap.querySelector('.knop .aan'),
    knopTl: wrap.querySelector('.knop .tl'),
    teaser: wrap.querySelector('.teaser'),
    paneel: wrap.querySelector('.paneel'),
    kop: wrap.querySelector('.kop'),
    strip: wrap.querySelector('.strip'),
    body: wrap.querySelector('.body'),
    stapvak: wrap.querySelector('.stapvak'),
    chatvak: wrap.querySelector('.chatvak'),
    thread: wrap.querySelector('.thread'),
    tik: wrap.querySelector('.tik'),
    extra: wrap.querySelector('.extra'),
    cfout: wrap.querySelector('.cfout'),
    voet: wrap.querySelector('.voet'),
    invoerblok: wrap.querySelector('.invoerblok'),
    klaarblok: wrap.querySelector('.klaarblok'),
    ta: wrap.querySelector('#f-bericht'),
    verstuur: wrap.querySelector('.verstuur'),
    mensknop: wrap.querySelector('.mensknop'),
    mensTekst: wrap.querySelector('.mensknop span'),
  };

  // Wat er nu getekend staat, zodat een render die niets verandert ook
  // niets aanraakt.
  var getekend = { kop: null, strip: null, stap: null, extra: null, keys: [] };

  function zet(node, html, sleutel) {
    if (getekend[sleutel] === html) return false;
    getekend[sleutel] = html;
    node.innerHTML = html;
    return true;
  }
  function toon(node, ja) {
    if (ja) node.removeAttribute('hidden'); else node.setAttribute('hidden', '');
  }

  /* ── afgeleide toestand ───────────────────────────────────────────────── */
  function cfg() { return st.config || {}; }
  function isLive() { return !!cfg().live; }
  function botNaam() { return cfg().bot_naam || 'Sam'; }
  function mailbox() { return cfg().antwoord_mailbox || MAIL; }
  function uren() { return cfg().bereikbaarheid || 'op werkdagen'; }

  function laatsteMedewerker() {
    for (var i = st.berichten.length - 1; i >= 0; i--) {
      var b = st.berichten[i];
      if (b.afzender === 'medewerker') return b.naam || 'Een collega';
    }
    return null;
  }

  function tijdLabel(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var z = function (n) { return (n < 10 ? '0' : '') + n; };
      var nu = new Date();
      var tijd = z(d.getHours()) + ':' + z(d.getMinutes());
      if (d.toDateString() === nu.toDateString()) return tijd;
      return d.getDate() + '/' + (d.getMonth() + 1) + ' ' + tijd;
    } catch (_) { return ''; }
  }

  /* ── weergave ─────────────────────────────────────────────────────────── */
  function teken() {
    // De supportkaart op de pagina volgt de live-stand mee.
    if (kaarten.length) werkKaartenBij();
    tekenKnop();
    el.paneel.classList.toggle('open', st.open);
    el.paneel.setAttribute('aria-hidden', st.open ? 'false' : 'true');
    el.paneel.classList.toggle('chat', st.open && st.stap === 'chat');
    if (!st.open) return;

    tekenKop();
    if (st.stap === 'chat' && !st.onbereikbaar) {
      toon(el.stapvak, false);
      toon(el.chatvak, true);
      getekend.stap = null;
      tekenStrip();
      tekenThread();
      tekenExtra();
      tekenVoet();
    } else {
      toon(el.chatvak, false);
      toon(el.voet, false);
      toon(el.strip, false);
      getekend.strip = null;
      toon(el.stapvak, true);
      tekenStap();
    }
  }

  function tekenKnop() {
    el.knopTitel.textContent = cfg().titel || 'Hulp nodig?';
    toon(el.knopAan, isLive());
    toon(el.knopTl, !st.open && st.ongelezen > 0);
    el.knopTl.textContent = st.ongelezen > 9 ? '9+' : String(st.ongelezen || '');
    el.knop.classList.toggle('dicht', st.open);
    el.knop.setAttribute('aria-label', st.open ? 'Sluit de support-chat' : 'Open de support-chat');
    el.knop.setAttribute('aria-expanded', st.open ? 'true' : 'false');
    if (st.open) toon(el.teaser, false);
  }

  function tekenKop() {
    var live = isLive();
    var sub;
    if (st.onbereikbaar) sub = 'Even niet bereikbaar via de chat';
    else if (!st.config) sub = 'Even laden…';
    else if (live) sub = '<i>● Online</i> — een collega kan je nu direct helpen';
    else if (cfg().reden === 'niemand_online') sub = botNaam() + ' helpt je meteen · een collega reageert per mail';
    else sub = botNaam() + ' helpt je meteen · team bereikbaar ' + esc(uren());

    zet(el.kop,
      '<div class="rij">' +
        '<div class="avs"><span class="av sam">' + esc(botNaam().charAt(0)) + '</span>' +
        '<span class="av team">' + IC.team + '<span class="punt' + (live ? ' live' : '') + '"></span></span></div>' +
        '<div><h2>Support De Forex Opleiding</h2><p class="sub">' + sub + '</p></div>' +
      '</div>' +
      '<button class="x" data-a="sluit" aria-label="Sluiten">' + (isMobiel() ? IC.neer : IC.x) + '</button>',
      'kop');
  }

  // De balk bovenaan de chat zegt altijd in één zin met wie je praat en wat
  // er met je vraag gebeurt. Dat was de vraag die bezoekers het meest
  // hadden: "zit hier nu iemand, of praat ik tegen een bot?"
  function tekenStrip() {
    var s = st.gesprek && st.gesprek.status;
    var live = isLive();
    var mail = (st.gesprek && st.gesprek.email) || null;
    var soort, icoon, tekst;

    if (s === 'afgehandeld') {
      soort = 'wacht'; icoon = IC.check;
      tekst = '<b>Dit gesprek is afgerond.</b> Nog een vraag? Start hieronder een nieuw gesprek.';
    } else if (s === 'in_behandeling' || s === 'wacht_op_klant') {
      soort = 'mens'; icoon = IC.mens;
      tekst = '<b>' + esc(laatsteMedewerker() || 'Een collega') + '</b> helpt je verder. ' +
        'Ben je weg? Dan komt ons antwoord ook per mail' + (mail ? ' naar ' + esc(mail) : '') + '.';
    } else if (s === 'wacht_op_ons') {
      if (live) {
        soort = 'live'; icoon = IC.mens;
        tekst = '<b>Een collega is op de hoogte</b> en komt zo in dit gesprek. Blijf gerust even hier.';
      } else {
        soort = 'wacht'; icoon = IC.mail;
        tekst = '<b>Je vraag staat bij ons team.</b> Er is nu niemand online; je krijgt antwoord per mail' +
          (mail ? ' op <b>' + esc(mail) + '</b>' : '') + '. Je mag dit venster sluiten.';
      }
    } else {
      soort = 'bot'; icoon = IC.bot;
      tekst = live
        ? 'Je praat met <b>' + esc(botNaam()) + '</b>, onze digitale assistent. Liever een collega? Er is er nu één online.'
        : 'Je praat met <b>' + esc(botNaam()) + '</b>, onze digitale assistent. Er is nu geen collega online — wil je iemand spreken, dan krijg je antwoord per mail.';
    }

    toon(el.strip, true);
    el.strip.className = 'strip ' + soort;
    zet(el.strip, '<span class="ic">' + icoon + '</span><div>' + tekst + '</div>', 'strip');
  }

  function berichtSleutel(b) {
    if (b.id) return 'i' + b.id;
    return 'l' + b.afzender + '|' + (b.created_at || '') + '|' + String(b.tekst || '').length;
  }

  function berichtHtml(b) {
    var t = b.created_at ? '<span class="t">' + esc(tijdLabel(b.created_at)) + '</span>' : '';
    if (b.afzender === 'systeem') {
      return '<div class="b">' + IC.info + '<span>' + esc(b.tekst) + '</span></div>';
    }
    if (b.afzender === 'klant') {
      return '<div class="b">' + esc(b.tekst) + '</div>' + t;
    }
    var isBot = b.afzender === 'bot';
    var naam = b.naam || (isBot ? botNaam() : 'De Forex Opleiding');
    return '<p class="van"><span class="mini ' + (isBot ? 'sam' : 'mens') + '">' + esc(naam.charAt(0).toUpperCase()) + '</span>' +
      esc(naam) + '<span class="tag">' + (isBot ? 'digitale assistent' : 'team De Forex Opleiding') + '</span></p>' +
      '<div class="b">' + esc(b.tekst) + '</div>' + t;
  }

  function berichtNode(b, animeer) {
    var d = document.createElement('div');
    var soort = b.afzender === 'systeem' ? 'sys' : b.afzender === 'klant' ? 'klant' : 'ons' + (b.afzender === 'medewerker' ? ' mens' : '');
    d.className = 'bl ' + soort + (animeer ? ' nieuw' : '');
    d.innerHTML = berichtHtml(b);
    return d;
  }

  function onderaan() {
    var b = el.body;
    return b.scrollHeight - b.scrollTop - b.clientHeight < 90;
  }
  function naarOnder() {
    var b = el.body;
    b.scrollTop = b.scrollHeight;
  }

  // Alleen aanhangen wat er nieuw is. Klopt de reeks niet meer met wat er
  // staat (na een herstel of een volledige poll), dan één keer opnieuw
  // opbouwen — zonder animatie, dus zonder flits.
  function tekenThread() {
    var keys = st.berichten.map(berichtSleutel);
    var oud = getekend.keys;
    var prefix = oud.length <= keys.length && oud.every(function (k, i) { return k === keys[i]; });
    var bleefOnder = onderaan();
    var eigen = false;

    if (!prefix) {
      el.thread.innerHTML = '';
      st.berichten.forEach(function (b) { el.thread.appendChild(berichtNode(b, false)); });
      getekend.keys = keys;
      toon(el.tik, st.bezig);
      naarOnder();
      return;
    }
    for (var i = oud.length; i < keys.length; i++) {
      el.thread.appendChild(berichtNode(st.berichten[i], true));
      if (st.berichten[i].afzender === 'klant') eigen = true;
    }
    var nieuw = keys.length > oud.length;
    getekend.keys = keys;
    var wasTik = !el.tik.hasAttribute('hidden');
    toon(el.tik, st.bezig);
    if ((nieuw || (st.bezig && !wasTik)) && (bleefOnder || eigen)) naarOnder();
  }

  function tekenExtra() {
    var h = '';
    if (st.codeVeld) {
      h = '<div class="code"><input id="f-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-label="Code uit je mail">' +
        '<button data-a="code"' + (st.codeBezig ? ' disabled' : '') + '>' + (st.codeBezig ? '…' : 'Bevestig') + '</button></div>' +
        '<p class="hint">Geen mail gezien? Kijk ook even in je spam.</p>';
    }
    var waarde = veld('f-code');
    var nieuw = zet(el.extra, h, 'extra');
    toon(el.extra, !!h);
    if (nieuw && h) {
      var inp = root.querySelector('#f-code');
      if (inp) {
        inp.value = waarde;
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doe('code'); } });
        if (!st.codeBezig) { inp.focus(); naarOnder(); }
      }
    }
    el.cfout.textContent = st.fout || '';
    toon(el.cfout, !!st.fout);
  }

  function tekenVoet() {
    var klaar = st.gesprek && st.gesprek.status === 'afgehandeld';
    var s = st.gesprek && st.gesprek.status;
    toon(el.voet, true);
    toon(el.invoerblok, !klaar);
    toon(el.klaarblok, !!klaar);
    el.verstuur.disabled = !!st.bezig;
    // De knop naar een mens alleen zolang de bot aan zet is. Daarna staat
    // de vraag al bij ons, en dan is "ik wil een medewerker" dubbel.
    var mensZinvol = !s || s === 'bot';
    toon(el.mensknop, mensZinvol && !st.codeVeld);
    el.mensTekst.textContent = isLive()
      ? 'Liever direct met een medewerker praten?'
      : 'Liever een medewerker? Laat je vraag achter';
  }

  function tekenStap() {
    var h;
    if (st.onbereikbaar) {
      h = '<div class="hallo"><h3>De chat is even niet bereikbaar</h3>' +
        '<p>Excuses daarvoor. Je bereikt ons gewoon via mail of telefoon — we komen er snel op terug.</p></div>' +
        contactBlok();
    } else if (!st.config) {
      h = '<div class="hallo"><h3>Hoi!</h3><p>Even geduld, de chat wordt geladen…</p></div>';
    } else {
      h = (st.fout ? '<div class="fout">' + esc(st.fout) + '</div>' : '') + stapHtml();
    }
    h = '<div class="stap" data-stap="' + esc(st.stap) + '">' + h + '</div>';

    // Waarden en focus vasthouden als een stap opnieuw getekend moet worden
    // (foutmelding, "Bezig…"): niemand wil zijn vraag opnieuw typen.
    var velden = {};
    var actief = root.activeElement && root.activeElement.id;
    Array.prototype.forEach.call(el.stapvak.querySelectorAll('input[id],textarea[id]'), function (i) { velden[i.id] = i.value; });
    var vorigeStap = getekend.stapNaam;
    if (!zet(el.stapvak, h, 'stap')) return;
    getekend.stapNaam = st.stap + '|' + st.soort + '|' + st.onderwerp;
    // Zelfde stap opnieuw getekend: geen instap-animatie.
    if (vorigeStap === getekend.stapNaam) {
      var s = el.stapvak.querySelector('.stap');
      if (s) s.classList.remove('stap');
    } else {
      el.body.scrollTop = 0;
    }
    Object.keys(velden).forEach(function (id) {
      var i = root.querySelector('#' + id);
      if (i) i.value = velden[id];
    });
    if (actief) { var a = root.querySelector('#' + actief); if (a) a.focus(); }
    var hv = root.querySelector('#f-hervat');
    if (hv) hv.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doe('hervat-open'); } });
  }

  function contactBlok() {
    return '<div class="contact"><h4>Direct contact</h4>' +
      '<div class="crij">' + IC.mail + '<a href="mailto:' + MAIL + '">' + MAIL + '</a></div>' +
      '<div class="crij">' + IC.tel + '<a href="' + TEL_HREF + '">' + TEL + '</a></div>' +
      (st.config ? '<div class="crij">' + IC.klok + '<span>Team bereikbaar ' + esc(uren()) + '</span></div>' : '') +
      '</div>';
  }

  function keuze(actie, waarde, icoon, titel, hint) {
    return '<button class="keuze" data-a="' + actie + '" data-v="' + esc(waarde) + '">' +
      (icoon ? '<span class="kic">' + icoon + '</span>' : '') +
      '<span><b>' + esc(titel) + '</b>' + (hint ? '<span class="h">' + esc(hint) + '</span>' : '') + '</span>' +
      '<span class="pijl">&rsaquo;</span></button>';
  }

  function stapHtml() {
    var h = '';

    if (st.stap === 'hervat') {
      h += '<button class="terug" data-a="hervat-terug">&lsaquo; Terug</button>' +
        '<div class="hallo"><h3>Je gesprek ' + esc(st.hervatKenmerk) + '</h3></div>';
      if (!st.hervatGestuurd) {
        h += '<p class="p">We sturen een code van zes cijfers naar het mailadres waarop je onze mail kreeg. ' +
          'Zo weten we zeker dat jij het bent voordat we het gesprek openen.</p>' +
          '<button class="btn" data-a="hervat-code"' + (st.bezig ? ' disabled' : '') + '>' +
          (st.bezig ? 'Bezig…' : 'Stuur me de code') + '</button>';
      } else {
        h += '<p class="p">Kijk in je mailbox — ook even in de spam. De code is tien minuten geldig.</p>' +
          '<div class="veld"><label for="f-hervat">Code</label>' +
          '<input id="f-hervat" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></div>' +
          '<button class="btn" data-a="hervat-open"' + (st.bezig ? ' disabled' : '') + '>' +
          (st.bezig ? 'Bezig…' : 'Open mijn gesprek') + '</button>';
      }
      return h;
    }

    if (st.stap === 'start') {
      var live = isLive();
      h += '<div class="hallo"><h3>Hoi! Waarmee kunnen we helpen?</h3><p>' +
        esc(cfg().welkom || 'Stel je vraag — vaak heb je binnen een minuut antwoord.') + '</p></div>';
      if (!live) {
        h += '<div class="info">' + (cfg().reden === 'niemand_online'
          ? 'Er is nu geen collega online. <b>' + esc(botNaam()) + '</b>, onze digitale assistent, helpt je meteen verder. Wil je iemand van het team spreken? Laat je vraag achter, dan krijg je antwoord per mail.'
          : 'Ons team is bereikbaar ' + esc(uren()) + '. <b>' + esc(botNaam()) + '</b>, onze digitale assistent, helpt je nu al verder — en wat hij niet weet, beantwoorden we per mail.') + '</div>';
      }
      h += '<p class="vraag">Volg je al een traject bij ons?</p><div class="keuzes">' +
        keuze('soort', 'klant', IC.student, 'Ja, ik ben student', 'LMS, Discord, je mentor of je facturen') +
        keuze('soort', 'bezoeker', IC.nieuw, 'Nee, nog niet', 'Informatie, een gesprek inplannen of een event') +
        '</div>' + contactBlok();
      return h;
    }

    if (st.stap === 'onderwerp') {
      var lijst = (cfg().onderwerpen && cfg().onderwerpen[st.soort]) || [];
      h += '<button class="terug" data-a="terug">&lsaquo; Terug</button>' +
        '<div class="hallo"><h3>Waar gaat je vraag over?</h3><p>Dan zetten we je meteen bij het juiste antwoord.</p></div>' +
        '<div class="keuzes klein">' +
        lijst.map(function (o) { return keuze('onderwerp', o.id, null, o.label, o.hint); }).join('') + '</div>';
      return h;
    }

    if (st.stap === 'formulier') {
      var isKlant = st.soort === 'klant';
      h += '<button class="terug" data-a="terug">&lsaquo; Terug</button>' +
        '<div class="hallo"><h3>Stel je vraag</h3><p>' + (isLive()
          ? 'Een collega is online en leest mee.'
          : esc(botNaam()) + ' reageert direct; ons team volgt per mail als dat nodig is.') + '</p></div>';

      // Snelle antwoorden vóór het formulier: wie alleen een link zoekt,
      // hoeft geen gegevens achter te laten.
      var l = cfg().links || {};
      if (st.onderwerp === 'call' && l.agenda) {
        h += '<div class="info">Direct een gesprek inplannen kan in <a href="' + esc(l.agenda) + '" target="_blank" rel="noopener">de agenda</a>. ' +
          'Liever eerst iets vragen? Vul hieronder je vraag in.</div>';
      }
      if (st.onderwerp === 'event' && l.events) {
        h += '<div class="info">Alle events staan op <a href="' + esc(l.events) + '" target="_blank" rel="noopener">de eventpagina</a>. ' +
          'Iets anders nodig? Stel je vraag hieronder.</div>';
      }

      h += '<div class="veld"><label for="f-naam">Je naam</label><input id="f-naam" autocomplete="name"></div>' +
        '<div class="veld"><label for="f-mail">E-mailadres <small>— hier komt ons antwoord</small></label><input id="f-mail" type="email" inputmode="email" autocomplete="email"></div>' +
        (isKlant ? '<div class="veld"><label for="f-tel">Telefoonnummer</label><input id="f-tel" type="tel" autocomplete="tel"></div>' : '') +
        '<div class="veld"><label for="f-vraag">Je vraag</label><textarea id="f-vraag" placeholder="Beschrijf kort wat er speelt"></textarea></div>' +
        '<input class="hp" id="f-bedrijf" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '<button class="btn goud" data-a="start"' + (st.bezig ? ' disabled' : '') + '>' +
        (st.bezig ? 'Even geduld…' : 'Start de chat') + '</button>' +
        '<p class="hint">' + (isKlant
          ? 'Gaat je vraag over je LMS-toegang, je traject of een factuur? Dan sturen we je eerst een code per mail — zo weten we zeker dat wij met jou praten voordat we je gegevens erbij pakken.'
          : 'We gebruiken je gegevens alleen om je vraag te beantwoorden.') + '</p>';
      return h;
    }
    return h;
  }

  /* ── interactie ───────────────────────────────────────────────────────── */
  // Eén luisteraar voor het hele venster. Knoppen die opnieuw getekend
  // worden hoeven dan niet opnieuw gekoppeld te worden.
  root.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-a]') : null;
    if (!t || !root.contains(t)) return;
    e.preventDefault();
    if (t.getAttribute('data-a') === 'teaser-weg') e.stopPropagation();
    doe(t.getAttribute('data-a'), t.getAttribute('data-v'));
  });

  el.ta.addEventListener('keydown', function (e) {
    // Enter verstuurt, shift+enter is een nieuwe regel — zoals in elke chat
    // die mensen al kennen. Tijdens IME-invoer (isComposing) niet.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doe('stuur'); }
  });
  el.ta.addEventListener('input', groei);
  function groei() {
    el.ta.style.height = '40px';
    el.ta.style.height = Math.min(Math.max(el.ta.scrollHeight, 40), 120) + 'px';
  }

  root.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && st.open) { doe('sluit'); }
  });

  function doe(actie, waarde) {
    if (actie !== 'code' && actie !== 'stuur') st.fout = null;

    if (actie === 'knop') { if (st.open) sluit(); else open(); return; }
    if (actie === 'open') { open(); return; }
    if (actie === 'sluit') { sluit(); return; }
    if (actie === 'teaser-weg') { verbergTeaser(true); return; }

    if (actie === 'terug') {
      st.stap = st.stap === 'formulier' ? 'onderwerp' : 'start';
      teken(); return;
    }
    if (actie === 'soort') { st.soort = waarde; st.stap = 'onderwerp'; teken(); return; }
    if (actie === 'onderwerp') {
      st.onderwerp = waarde; st.stap = 'formulier'; teken();
      if (!isTouch()) { var n = root.querySelector('#f-naam'); if (n) n.focus(); }
      return;
    }
    if (actie === 'start') { start(); return; }
    if (actie === 'stuur') { stuur(false); return; }
    if (actie === 'mens') { stuur(true); return; }
    if (actie === 'code') { checkCode(); return; }
    if (actie === 'hervat-code') { vraagHervatCode(); return; }
    if (actie === 'hervat-open') { openHervat(); return; }
    if (actie === 'hervat-terug') {
      st.hervatKenmerk = null; st.hervatGestuurd = false; st.stap = 'start';
      teken();
      herstel().then(function () { teken(); });
      return;
    }
    if (actie === 'nieuw') {
      wis();
      stopPoll();
      st.token = null; st.gesprek = null; st.berichten = []; st.stap = 'start';
      st.soort = null; st.onderwerp = null; st.codeVeld = false;
      st.hervatKenmerk = null; st.hervatGestuurd = false;
      getekend.keys = []; el.thread.innerHTML = '';
      teken(); return;
    }
  }

  var scrollOud = null;
  function vergrendelPagina(aan) {
    // Op mobiel beslaat het venster het hele scherm; de pagina eronder mag
    // dan niet meescrollen.
    try {
      var d = document.documentElement;
      if (aan && isMobiel()) {
        if (scrollOud === null) { scrollOud = d.style.overflow || ''; d.style.overflow = 'hidden'; }
      } else if (scrollOud !== null) {
        d.style.overflow = scrollOud; scrollOud = null;
      }
    } catch (_) {}
  }

  // iOS schuift bij het toetsenbord de pagina op in plaats van het venster
  // kleiner te maken. Met visualViewport houden we het venster precies zo
  // groot als wat er zichtbaar is, zodat de invoerbalk boven het toetsenbord
  // blijft staan.
  function pasViewportAan() {
    var vv = window.visualViewport;
    if (!vv || !st.open || !isMobiel()) {
      el.paneel.style.height = ''; el.paneel.style.top = '';
      return;
    }
    el.paneel.style.height = vv.height + 'px';
    el.paneel.style.top = vv.offsetTop + 'px';
  }
  try {
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', pasViewportAan);
      window.visualViewport.addEventListener('scroll', pasViewportAan);
    }
  } catch (_) {}

  function open() {
    var wasOpen = st.open;
    st.open = true;
    st.ongelezen = 0;
    verbergTeaser(false);
    teken();
    vergrendelPagina(true);
    pasViewportAan();

    if (!st.config) {
      api('support-widget-config').then(function (c) {
        if (!c || c.aan === false) { st.open = false; vergrendelPagina(false); teken(); return; }
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
    if (st.token && st.stap === 'chat') {
      startPoll();
      if (!wasOpen) poll();
      naarOnder();
      if (!isTouch()) el.ta.focus();
    }
  }

  function sluit() {
    st.open = false;
    vergrendelPagina(false);
    pasViewportAan();
    // Het gesprek loopt door: de poll gaat in de langzame stand, zodat een
    // antwoord als badge op de knop verschijnt.
    teken();
    try { el.knop.focus({ preventScroll: true }); } catch (_) {}
  }

  function veld(id) {
    var e = root.querySelector('#' + id);
    return e ? String(e.value || '').trim() : '';
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      st.fout = 'Dat e-mailadres lijkt niet te kloppen — daar sturen we ons antwoord naartoe.';
      teken(); return;
    }

    st.bezig = true; teken();

    api('support-start', { method: 'POST', body: body }).then(function (r) {
      st.token = r.token;
      st.gesprek = r.gesprek;
      if (st.gesprek && !st.gesprek.email) st.gesprek.email = body.email;
      st.stap = 'chat';
      st.berichten = [{ afzender: 'klant', tekst: body.vraag, created_at: new Date().toISOString() }];
      st.laatsteTijd = new Date().toISOString();
      bewaar({ token: r.token, tijd: Date.now() });
      teken();

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
      if (st.stap === 'chat' && !isTouch()) el.ta.focus();
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

    st.fout = null;
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
    if (st.bezig) return;
    var tekst = vraagtMens ? 'Ik wil graag een medewerker spreken.' : String(el.ta.value || '').trim();
    if (!tekst) return;
    st.fout = null;

    if (!vraagtMens) { el.ta.value = ''; groei(); }
    st.berichten.push({ afzender: 'klant', tekst: tekst, created_at: new Date().toISOString() });
    st.bezig = true;
    teken();

    api('support-bericht', { method: 'POST', body: { tekst: tekst, vraagt_mens: !!vraagtMens } })
      .then(function (r) { verwerkAntwoord(r, false); })
      .catch(function (e) { st.fout = e.message; })
      .then(function () {
        st.bezig = false; teken(); startPoll();
        if (!isTouch()) el.ta.focus();
      });
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
    st.pollTel = 0;
    st.pollTimer = setInterval(poll, POLL_MS);
  }
  function stopPoll() {
    if (st.pollTimer) { clearInterval(st.pollTimer); st.pollTimer = null; }
  }

  function poll() {
    // Niet pollen als de tab op de achtergrond staat. Een gesloten laptop
    // hoeft ons geen verzoek per vijf seconden te sturen.
    if (document.hidden) return;
    if (!st.token) return;

    // Na een herstel of heropening die de thread nog niet binnen heeft, halen
    // we 'm in zijn geheel op; daarna weer alleen wat er bij kwam.
    var volledig = st.volledigNodig;
    var dicht = !st.open;
    // Venster dicht: rustiger aan. Een eerste volledige ophaalronde gaat wel
    // altijd door, anders staat er bij openen niets.
    st.pollTel++;
    if (dicht && !volledig && st.pollTel % POLL_DICHT_ELKE !== 0) return;

    var q = volledig ? '?volledig=1'
      : (st.laatsteTijd ? '?sinds=' + encodeURIComponent(st.laatsteTijd) : '');
    if (dicht) q += (q ? '&' : '?') + 'dicht=1';

    api('support-poll' + q).then(function (r) {
      if (!r) return;
      var liveWas = isLive();
      if (st.config) { st.config.live = r.live; if (r.reden !== undefined) st.config.reden = r.reden; }
      if (volledig) {
        st.volledigNodig = false;
        st.berichten = r.berichten || [];
        if (st.berichten.length) st.laatsteTijd = st.berichten[st.berichten.length - 1].created_at;
        if (r.gesprek) st.gesprek = r.gesprek;
        teken();
        return;
      }
      var nieuw = 0;
      (r.berichten || []).forEach(function (b) {
        if (st.berichten.some(function (x) { return x.id && x.id === b.id; })) return;
        st.berichten.push(b);
        st.laatsteTijd = b.created_at;
        nieuw++;
      });
      var statusWas = st.gesprek && st.gesprek.status;
      if (r.gesprek) st.gesprek = r.gesprek;

      if (nieuw && !st.open) st.ongelezen += nieuw;
      // Alleen tekenen als er iets te zien valt. De render is incrementeel,
      // maar niets aanraken is nog altijd het rustigst.
      if (nieuw || liveWas !== isLive() || statusWas !== (st.gesprek && st.gesprek.status)) teken();
    }).catch(function (e) {
      // Een 401 is geen netwerkhikje: dit token geldt niet meer. Dat gebeurt
      // wanneer hetzelfde gesprek elders is heropend — support-hervat-check
      // geeft één sleutel per gesprek uit. Blijven pollen levert dan alleen
      // een bevroren venster op, dus we zeggen wat er aan de hand is.
      if (tokenOngeldig(e)) {
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
        // Het token is op dit moment al geroteerd; het oude geldt niet meer.
        // Dus nu meteen de chat in. De bezoeker komt terug om te lezen wat er
        // gezegd is, dus de poll haalt de hele thread erbij.
        naarChat();
        poll();
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
    return api('support-poll?volledig=1&dicht=1')
      .then(function (r) {
        st.gesprek = (r && r.gesprek) || null;
        st.stap = 'chat';
        st.berichten = (r && r.berichten) || [];
        if (st.berichten.length) st.laatsteTijd = st.berichten[st.berichten.length - 1].created_at;
        st.ongelezen = 0;
        startPoll();
      })
      .catch(function (e) {
        // Alleen een token dat de server zelf ongeldig noemt, gaat weg. Bij
        // een storing of netwerkfout houden we het: een sessie leeft dertig
        // dagen, en die gooien we niet weg om een hikje bij het laden. De
        // poll haalt de thread op zodra de server weer antwoordt.
        if (tokenOngeldig(e)) { wis(); st.token = null; return; }
        naarChat();
      });
  }

  /* ── de teaser ────────────────────────────────────────────────────────── */
  // Eén keer per drie dagen, na een paar seconden, en nooit als er al een
  // gesprek loopt of het venster open is. Na twaalf seconden gaat 'ie weer
  // weg: het is een wegwijzer, geen pop-up.
  var teaserTimer = null;
  function planTeaser() {
    try {
      var t = Number(localStorage.getItem(TEASER_OPSLAG) || 0);
      if (Date.now() - t < TEASER_PAUZE_MS) return;
    } catch (_) { return; }
    teaserTimer = setTimeout(function () {
      if (st.open || st.token) return;
      toon(el.teaser, true);
      el.knop.classList.add('puls');
      try { localStorage.setItem(TEASER_OPSLAG, String(Date.now())); } catch (_) {}
      teaserTimer = setTimeout(function () { verbergTeaser(false); }, 12000);
    }, 5000);
  }
  function verbergTeaser(bewust) {
    toon(el.teaser, false);
    if (bewust) { try { localStorage.setItem(TEASER_OPSLAG, String(Date.now())); } catch (_) {} }
  }

  /* ── openen vanaf de pagina ───────────────────────────────────────────── */
  window.DFOSupport = {
    open: function () { open(); },
    sluit: function () { sluit(); },
    close: function () { sluit(); },
  };

  function openVanPagina(e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-dfo-support-open],a[href="#support"],a[href$="/#support"]') : null;
    if (!t) return;
    e.preventDefault();
    open();
  }

  /* ── de supportkaart op de contactpagina ──────────────────────────────── */
  var kaarten = [];

  function kaartHtml() {
    var live = isLive();
    var sub = live
      ? 'Er is nu een collega online — je hebt direct antwoord.'
      : 'Onze assistent helpt je meteen. Een collega reageert ' + (cfg().reden === 'niemand_online' ? 'per mail' : esc(uren()) + ', anders per mail') + '.';
    return '<div class="k"><div class="ic">' + IC.chat + '<span class="p' + (live ? ' live' : '') + '"></span></div>' +
      '<div class="m"><b>Live chat &amp; support</b><span>' + sub + '</span></div>' +
      '<button type="button">Start de chat</button></div>';
  }

  function maakKaart(doel, plaats) {
    var h = document.createElement('div');
    h.setAttribute('data-dfo-support-kaart-host', '');
    var r = h.attachShadow({ mode: 'open' });
    var s = document.createElement('style');
    s.textContent = KAART_CSS;
    var inhoud = document.createElement('div');
    inhoud.innerHTML = kaartHtml();
    r.appendChild(s);
    r.appendChild(inhoud);
    r.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('button')) open();
    });
    if (plaats === 'na' && doel.parentNode) doel.parentNode.insertBefore(h, doel.nextSibling);
    else doel.appendChild(h);
    kaarten.push(inhoud);
  }

  function werkKaartenBij() {
    var html = kaartHtml();
    kaarten.forEach(function (k) { if (k.innerHTML !== html) k.innerHTML = html; });
  }

  // Idempotent: een doel dat al een kaart heeft, krijgt er geen tweede bij.
  // De website is een Next.js-app die pagina's zonder volledige reload
  // wisselt, dus dit draait opnieuw als de pagina verandert.
  function plaatsKaarten() {
    if (!st.config) return;
    kaarten = kaarten.filter(function (k) { return k.getRootNode && k.getRootNode().host && k.getRootNode().host.isConnected; });
    var doelen = document.querySelectorAll('[data-dfo-support-kaart]');
    Array.prototype.forEach.call(doelen, function (d) {
      if (d.querySelector('[data-dfo-support-kaart-host]')) return;
      maakKaart(d, 'in');
    });
    if (doelen.length) return;
    // Geen expliciete plek: op de contactpagina bovenaan het blok "Direct
    // contact". Staat dat blok er niet, dan doen we niets — liever geen kaart
    // dan een kaart op een rare plek.
    if (!/^\/contact\/?$/.test(location.pathname)) return;
    var blok = document.querySelector('.cinfo');
    if (!blok || blok.querySelector('[data-dfo-support-kaart-host]')) return;
    var kopje = blok.querySelector('h1,h2,h3,h4');
    if (kopje) maakKaart(kopje, 'na'); else maakKaart(blok, 'in');
  }

  var kaartTimer = null;
  function volgPagina() {
    try {
      var mo = new MutationObserver(function () {
        if (kaartTimer) return;
        kaartTimer = setTimeout(function () { kaartTimer = null; plaatsKaarten(); }, 400);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  /* ── start ────────────────────────────────────────────────────────────── */
  function startWidget() {
    document.body.appendChild(host);
    teken();
    try { document.addEventListener('click', openVanPagina, true); } catch (_) {}
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
      //
      // Eerst wel kijken wat er bewaard staat. Wijst de link naar precies dat
      // gesprek, dan openen we het gewoon: geen code, en dus ook geen rotatie
      // die het token vervangt dat hier al klopte.
      if (!uitMail) return herstel();
      return herstel().then(function () {
        st.open = true;
        if (st.gesprek && st.gesprek.kenmerk === uitMail) return;
        // Een ander gesprek (of niets): naar het codescherm. Het bewaarde
        // gesprek blijft in localStorage staan; de uitweg haalt het terug.
        stopPoll();
        st.token = null;
        st.gesprek = null;
        st.berichten = [];
        st.volledigNodig = false;
        st.hervatKenmerk = uitMail;
        st.hervatGestuurd = false;
        st.stap = 'hervat';
      });
    }).then(function () {
      if (!host.isConnected) return;         // widget staat uit
      teken();
      if (st.open) { vergrendelPagina(true); pasViewportAan(); }
      setTimeout(function () { plaatsKaarten(); volgPagina(); }, 800);
      if (!st.token && !st.open) planTeaser();
    }).catch(function () {
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
