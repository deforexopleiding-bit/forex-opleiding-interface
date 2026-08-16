/* ============================================================================
   modules/shared/klx-softphone.js — Gedeelde softphone (Bijlage 4 SYSTEEMKAART)
   ----------------------------------------------------------------------------
   PR 0-E van de redesign — één shared implementatie voor Klanten / Follow-up /
   Events / Mentoren. Gedrag identiek aan de eerdere klx-softphone IIFE in
   klanten.html (r4608-5148, sinds PR #827 rich-sheet-versie), 1-op-1 verplaatst
   en van een publieke API voorzien. De wbx-softphone in finance.html blijft
   ongemoeid (beschermde wanbetalers-zone; aparte namespace, aparte
   SIP-registratie).

   Vereist:
     - window.SIP  — SIP.js library (laad via <script src="/modules/shared/sip.min.js">)
     - window.AgentShared.apiFetch  — voor de auth-Bearer bij /api/voys-sip-config
     - window.AgentShared.showToast — voor gebruikersfeedback (optioneel)
     - CSS         — <link rel="stylesheet" href="/modules/shared/klx-softphone.css">
     - Server-side — /api/voys-sip-config (per-user SIP-account, RBAC-geleerd)

   Publieke API (window.KlxSoftphone):
     open({ phone, name?, customerId?, source? })  — opent het rich belvenster
     call(phone, { displayName?, line? })          — direct bellen (Promise)
     hangup()                                       — beëindig lopend gesprek
     ensureReady()                                  — fire-and-forget SIP-init
     isConfigured()                                 — sync: ≥1 lijn geregistreerd
     getStatus()                                    — snapshot state-object

   Consumers wiring (voorbeeld — klant-detail):
     document.getElementById('bel-btn').addEventListener('click', (e) => {
       const btn = e.currentTarget;
       KlxSoftphone.open({
         phone: btn.dataset.phone,
         name:  btn.dataset.name,
         customerId: btn.dataset.customerId,
         source: 'klanten.detail',
       });
     });

   Bewuste scope (t.o.v. wbx-softphone in finance.html):
     - Geen call-log tracker, outcome-modal of belronde-focus.
     - Alleen: init → invite → callbar (timer/mute/hangup) → hangup.
   ========================================================================== */
(function initKlxSoftphone(global) {
  'use strict';
  if (global.KlxSoftphone) return; // singleton — dubbele laad = no-op

  const state = {
    initPromise    : null,
    config         : null,
    uaByLine       : {},
    regByLine      : {},
    accByLine      : {},
    // configuredLines: welke lijnen server-side ingesteld zijn. Gebruikt
    // door de UI om de BE-optie in de lijn-select te tonen zodra BE
    // CONFIGURED is (i.p.v. wachten tot registered).
    configuredLines: { nl: false, be: false },
    session        : null,
    audioEl        : null,
    activeLine     : null,
    lastState      : 'idle',
    lastError      : null,
    muted          : false,
    timerStart     : 0,
    timerHandle    : null,
    // Overrides — user kan lijn en/of nummer wijzigen via de sheet.
    // lineOverride: 'auto' | 'nl' | 'be' (default auto = detectLine).
    // numberOverride: string of null (default = klantnummer uit open-call).
    // selectedCallerId: uitgaand telefoonnummer dat als CLI wordt getoond
    //                   ('' = Voys · standaard → account-default). Komt uit
    //                   /api/voys-sip-config caller_ids (per lijn of top-
    //                   level). Send-flow: als gezet, wordt toegevoegd als
    //                   P-Asserted-Identity + Remote-Party-ID header in de
    //                   SIP INVITE (mirror follow-up.html:7359-7374).
    // v=1da: lineOverride + selectedCallerId gepersisteerd in localStorage
    // zodat de user zijn keuze niet elke call opnieuw hoeft te maken.
    // Read-once bij init met try/catch (private browsing → fallback).
    lineOverride   : (function () {
      try {
        const v = localStorage.getItem('klx-softphone-line');
        return (v === 'nl' || v === 'be' || v === 'auto') ? v : 'auto';
      } catch (_) { return 'auto'; }
    })(),
    numberOverride : null,
    selectedCallerId: (function () {
      try { return localStorage.getItem('klx-softphone-caller-id') || ''; }
      catch (_) { return ''; }
    })(),
    // Actieve klant-context (naam + telefoon + optionele meta) voor de sheet-
    // header. Wordt gezet bij open() en gewist bij closeSheet().
    activeCustomer : null,
  };

  // ── Lokale ringback-toon (v=1dc) ─────────────────────────────────────────
  // WebAudio-gegenereerde European ringback (ETSI EN 300 001): 425 Hz sine,
  // cadence 1s aan / 4s uit. Speelt tijdens 'Establishing' zodat de user
  // altijd hoort dat het toestel overgaat, óók wanneer Voys geen SIP early
  // media (183 Session Progress met SDP) stuurt. Als Voys wél early media
  // stuurt, geeft _bindRemoteAudio() daaraan voorrang en wordt de lokale
  // toon direct gestopt om dubbele audio te voorkomen. Cleanup gebeurt bij
  // Established / Terminated / error zodat er nooit een oscillator blijft
  // hangen.
  const ringback = (function () {
    let ctx = null, osc = null, gain = null, cadenceTimer = null, playing = false;
    function ensureCtx() {
      if (!ctx) {
        const AC = global.AudioContext || global.webkitAudioContext;
        if (!AC) return null;
        try { ctx = new AC(); } catch (_) { return null; }
      }
      if (ctx.state === 'suspended') {
        try { ctx.resume(); } catch (_) { /* autoplay policy */ }
      }
      return ctx;
    }
    function schedulePhase(on) {
      if (!playing || !ctx || !gain) return;
      try {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        // Kleine ramp (10ms) om klik-artefacten te voorkomen bij aan/uit.
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(on ? 0.12 : 0.0, now + 0.01);
      } catch (_) { /* AudioContext kan closed zijn */ }
      cadenceTimer = setTimeout(() => schedulePhase(!on), on ? 1000 : 4000);
    }
    function start() {
      if (playing) return;
      const c = ensureCtx();
      if (!c) return;
      try {
        osc  = c.createOscillator();
        gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = 425;
        gain.gain.value = 0;
        osc.connect(gain).connect(c.destination);
        osc.start();
        playing = true;
        schedulePhase(true);
      } catch (_) {
        playing = false;
      }
    }
    function stop() {
      playing = false;
      if (cadenceTimer) { clearTimeout(cadenceTimer); cadenceTimer = null; }
      if (gain && ctx) {
        try {
          const now = ctx.currentTime;
          gain.gain.cancelScheduledValues(now);
          gain.gain.setValueAtTime(gain.gain.value, now);
          gain.gain.linearRampToValueAtTime(0, now + 0.02);
        } catch (_) {}
      }
      if (osc) {
        try { osc.stop(ctx ? ctx.currentTime + 0.03 : 0); } catch (_) {}
        try { osc.disconnect(); } catch (_) {}
        osc = null;
      }
      if (gain) {
        try { gain.disconnect(); } catch (_) {}
        gain = null;
      }
    }
    return { start, stop };
  })();

  // NL/BE line-detectie op basis van nummer (E.164). +32 = BE, alles anders = NL.
  // Zelfde regel als _wbxDetectLine in finance.html en fu-softphone in follow-up.
  function detectLine(phone) {
    const p = String(phone || '').trim();
    if (/^\+?32/.test(p) || /^0032/.test(p)) return 'be';
    return 'nl';
  }

  function digitsFor(phone) {
    return String(phone || '').replace(/[^\d+]/g, '');
  }

  function resolveEffectivePhone(customerPhone) {
    const p = String(state.numberOverride != null ? state.numberOverride : (customerPhone || '')).trim();
    return p;
  }
  function resolveEffectiveLine(customerPhone) {
    const ov = String(state.lineOverride || 'auto').toLowerCase();
    if (ov === 'nl' || ov === 'be') return ov;
    return detectLine(customerPhone);
  }
  function isBeAvailable() {
    return state.config ? !!state.configuredLines?.be : false;
  }
  // v=1da: caller-ID resolvers.
  // Bron-volgorde:
  //   1. state.accByLine[line].caller_ids  (per-account, na SIP-init).
  //   2. state.config.accounts[line]?.caller_ids (van cfg-payload).
  //   3. state.config.caller_ids            (top-level backward-compat).
  function callerIdsForLine(line) {
    if (!state.config) return [];
    const perAccount = state.accByLine?.[line]?.caller_ids
      || state.config?.accounts?.[line]?.caller_ids
      || [];
    if (Array.isArray(perAccount) && perAccount.length) return perAccount;
    return Array.isArray(state.config.caller_ids) ? state.config.caller_ids : [];
  }
  // Effectieve CID: alleen doorsturen als 'ie in de lijst van de huidige
  // lijn zit (voorkomt dat een NL-nummer per ongeluk over de BE-lijn gaat).
  // Lege waarde = "Voys · standaard" = geen extraHeaders in INVITE.
  function resolveEffectiveCallerId(line) {
    const cid = String(state.selectedCallerId || '').trim();
    if (!cid) return '';
    const list = callerIdsForLine(line);
    return list.includes(cid) ? cid : '';
  }
  function registrationStatusForLine(line) {
    if (state.uaByLine?.[line]) return 'connected';
    if (state.initPromise && state.config) return 'disabled';
    if (state.lastError) return 'failed';
    if (state.initPromise) return 'connecting';
    return 'idle';
  }

  // ── Callbar (fixed bottom-right, blijft zichtbaar wanneer sheet dicht is) ──
  function ensureCallbar() {
    let bar = document.getElementById('klxSoftphoneCallbar');
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'klxSoftphoneCallbar';
    bar.className = 'klx klx-call-callbar';
    bar.hidden = true;
    bar.innerHTML = `
      <div class="klx-call-callbar-status">
        <div class="klx-call-callbar-title" id="klxSoftphoneCallbarTitle">Kiezen…</div>
        <div class="klx-call-callbar-sub" id="klxSoftphoneCallbarSub"></div>
      </div>
      <div class="klx-call-callbar-timer" id="klxSoftphoneCallbarTimer">00:00</div>
      <div class="klx-call-callbar-actions">
        <button type="button" class="klx-call-callbar-btn mute" id="klxSoftphoneMuteBtn" title="Mute microfoon"><i class="ti ti-microphone"></i></button>
        <button type="button" class="klx-call-callbar-btn hangup" id="klxSoftphoneHangupBtn" title="Ophangen"><i class="ti ti-phone-off"></i></button>
      </div>
    `;
    document.body.appendChild(bar);
    bar.querySelector('#klxSoftphoneMuteBtn')?.addEventListener('click', toggleMute);
    bar.querySelector('#klxSoftphoneHangupBtn')?.addEventListener('click', hangup);
    return bar;
  }
  function showCallbar(visible, title, sub) {
    const bar = ensureCallbar();
    bar.hidden = !visible;
    if (visible) {
      const t = bar.querySelector('#klxSoftphoneCallbarTitle');
      if (t && title != null) t.textContent = title;
      const s = bar.querySelector('#klxSoftphoneCallbarSub');
      if (s && sub != null) s.textContent = sub;
    }
  }
  function updateCallbarStatus(title, sub) {
    const bar = document.getElementById('klxSoftphoneCallbar');
    if (!bar || bar.hidden) return;
    if (title != null) { const t = bar.querySelector('#klxSoftphoneCallbarTitle'); if (t) t.textContent = title; }
    if (sub   != null) { const s = bar.querySelector('#klxSoftphoneCallbarSub');   if (s) s.textContent = sub; }
  }
  function startCallTimer() {
    stopCallTimer();
    state.timerStart = Date.now();
    const el = document.getElementById('klxSoftphoneCallbarTimer');
    if (el) el.textContent = '00:00';
    state.timerHandle = setInterval(() => {
      const secs = Math.max(0, Math.floor((Date.now() - state.timerStart) / 1000));
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      const t = document.getElementById('klxSoftphoneCallbarTimer');
      if (t) t.textContent = mm + ':' + ss;
    }, 1000);
  }
  function stopCallTimer() {
    if (state.timerHandle) { clearInterval(state.timerHandle); state.timerHandle = null; }
  }
  function toggleMute() {
    const session = state.session;
    if (!session || !session.sessionDescriptionHandler) return;
    const pc = session.sessionDescriptionHandler.peerConnection;
    if (!pc) return;
    state.muted = !state.muted;
    pc.getSenders().forEach((s) => {
      if (s.track && s.track.kind === 'audio') s.track.enabled = !state.muted;
    });
    const btn = document.getElementById('klxSoftphoneMuteBtn');
    if (btn) {
      btn.classList.toggle('on', state.muted);
      btn.innerHTML = state.muted
        ? '<i class="ti ti-microphone-off"></i>'
        : '<i class="ti ti-microphone"></i>';
      btn.title = state.muted ? 'Microfoon aan' : 'Mute microfoon';
    }
  }

  // ── Lazy SIP.js UA-init (singleton via initPromise) ──────────────────────
  async function initSoftphone() {
    if (state.initPromise) return state.initPromise;
    state.initPromise = (async () => {
      let SIPLib = global.SIP;
      for (let i = 0; !SIPLib?.UserAgent && i < 30; i++) {
        await new Promise((r) => setTimeout(r, 100));
        SIPLib = global.SIP;
      }
      if (!SIPLib?.UserAgent) throw new Error('SIP.js niet geladen');

      const r = await global.AgentShared.apiFetch('/api/voys-sip-config');
      if (!r.ok) throw new Error('voys-sip-config HTTP ' + r.status);
      const cfg = await r.json();
      state.config = cfg;

      if (!state.audioEl) {
        const a = document.createElement('audio');
        a.id = 'klxSoftphoneAudio';
        a.autoplay = true;
        a.style.display = 'none';
        document.body.appendChild(a);
        state.audioEl = a;
      }

      let accounts = [];
      if (cfg.accounts && typeof cfg.accounts === 'object' && !Array.isArray(cfg.accounts)) {
        for (const key of ['nl', 'be']) {
          const acc = cfg.accounts[key];
          if (acc && acc.configured) accounts.push({ key, ...acc });
        }
      } else if (Array.isArray(cfg.accounts) && cfg.accounts.length) {
        accounts = cfg.accounts;
      } else if (cfg.user) {
        accounts = [{ key: 'nl', ...cfg }];
      }
      // configuredLines vullen VOORDAT de register-loop draait, zodat de
      // UI-gate ('BE-optie tonen') per lijn onafhankelijk is van of de
      // register-poging al klaar is (matcht finance-parity).
      state.configuredLines = {
        nl: accounts.some((a) => (a.key || 'nl') === 'nl'),
        be: accounts.some((a) => a.key === 'be'),
      };
      for (const acc of accounts) {
        if (!acc?.user || !acc?.password || !acc?.domain) continue;
        try {
          const uri = SIPLib.UserAgent.makeURI('sip:' + acc.user + '@' + acc.domain);
          const ua  = new SIPLib.UserAgent({
            uri,
            transportOptions    : { server: acc.wss || 'wss://websocket.voipgrid.nl' },
            authorizationUsername: acc.user,
            authorizationPassword: acc.password,
            displayName          : acc.display_name || 'Klanten',
          });
          await ua.start();
          const reg = new SIPLib.Registerer(ua);
          await reg.register();
          state.uaByLine[acc.key || 'nl']  = ua;
          state.regByLine[acc.key || 'nl'] = reg;
          state.accByLine[acc.key || 'nl'] = acc;
        } catch (e) {
          console.warn('[klx-softphone] account ' + (acc.key || 'nl') + ' init failed:', e?.message || e);
        }
      }
      if (!Object.keys(state.uaByLine).length) {
        throw new Error('Geen SIP-account geregistreerd. Check VOYS_SIP_* env vars.');
      }
      return true;
    })().catch((e) => {
      state.lastError = e?.message || String(e);
      state.initPromise = null; // retry mogelijk
      throw e;
    });
    return state.initPromise;
  }

  // ── Place call ───────────────────────────────────────────────────────────
  async function placeCall(customerPhone, opts = {}) {
    const effPhone = resolveEffectivePhone(customerPhone);
    // Line-override optie meegegeven in opts wint van state.lineOverride,
    // zonder de state permanent te muteren (voor eenmalige bulk-calls).
    const line = opts.line
      ? String(opts.line).toLowerCase()
      : resolveEffectiveLine(effPhone);
    const digits = digitsFor(effPhone);
    if (!digits) {
      global.AgentShared?.showToast?.('Geen telefoonnummer om te bellen.', 'error');
      return { ok: false, line };
    }

    try {
      await initSoftphone();
    } catch (e) {
      state.lastError = e?.message || String(e);
      global.AgentShared?.showToast?.('SIP niet beschikbaar: ' + (e?.message || 'onbekend'), 'error');
      renderSheet();
      return { ok: false, line, error: e?.message || 'init' };
    }

    const ua = state.uaByLine[line];
    if (!ua) {
      const msg = `${line.toUpperCase()}-lijn niet geregistreerd. Check VOYS_SIP_*_${line.toUpperCase()} env vars.`;
      state.lastError = msg;
      global.AgentShared?.showToast?.(msg, 'error');
      renderSheet();
      return { ok: false, line };
    }

    state.activeLine = line;
    state.lastState  = 'dialing';
    state.lastError  = null;
    state.muted      = false;
    renderSheet();

    const displayName = opts?.displayName || '';
    showCallbar(true, 'Kiezen…', displayName ? `${displayName} — ${effPhone}` : effPhone);
    const muteBtn = document.getElementById('klxSoftphoneMuteBtn');
    if (muteBtn) { muteBtn.classList.remove('on'); muteBtn.innerHTML = '<i class="ti ti-microphone"></i>'; muteBtn.title = 'Mute microfoon'; }

    try {
      const acc    = state.accByLine?.[line];
      const domain = acc?.domain || state.config?.domain || 'voipgrid.nl';
      const target = global.SIP.UserAgent.makeURI('sip:' + digits + '@' + domain);
      // v=1da: als user een specifiek Voys-nummer heeft gekozen, stuur het
      // mee als P-Asserted-Identity + Remote-Party-ID (RFC 3325 / historisch).
      // Mirror van follow-up.html:7359-7374. Leeg = "Voys · standaard" →
      // account-default CLI (geen extraHeaders).
      const chosenCid = resolveEffectiveCallerId(line);
      const extraHeaders = [];
      if (chosenCid) {
        const cidDigits = String(chosenCid).replace(/\D/g, '');
        const cidUri = 'sip:' + cidDigits + '@' + domain;
        extraHeaders.push('P-Asserted-Identity: <' + cidUri + '>');
        extraHeaders.push('Remote-Party-ID: <' + cidUri + '>;privacy=off;screen=yes');
      }
      const inviter = new global.SIP.Inviter(ua, target, {
        sessionDescriptionHandlerOptions: {
          constraints: { audio: true, video: false },
        },
        extraHeaders: extraHeaders.length ? extraHeaders : undefined,
      });
      state.session = inviter;
      // v=1da: bind audio al bij Establishing zodat SIP early media (183
      // Session Progress met SDP → ringback-tone van de provider) hoorbaar
      // wordt terwijl het gesprek nog niet is opgenomen. Voorheen werd
      // pas bij Established gebonden → gebruiker hoorde niets tijdens
      // "gaat over". Bindings zijn idempotent — we vervangen de srcObject
      // niet als 'ie al gezet is bij Established.
      // v=1dc: returnt boolean zodat de caller kan zien of early media al
      // beschikbaar is → local ringback kan dan direct stoppen.
      const _bindRemoteAudio = () => {
        const pc = inviter.sessionDescriptionHandler?.peerConnection;
        if (!pc || !state.audioEl) return false;
        const stream = new MediaStream();
        pc.getReceivers().forEach((rr) => { if (rr.track && rr.track.kind === 'audio') stream.addTrack(rr.track); });
        if (stream.getAudioTracks().length === 0) return false; // nog geen audio in SDP
        // Alleen (re)binden als srcObject leeg is — voorkomt "click" bij
        // Establishing→Established overgang wanneer stream al loopt.
        if (!state.audioEl.srcObject) {
          state.audioEl.srcObject = stream;
          try { state.audioEl.play(); } catch (_) { /* autoplay policy */ }
        }
        return true;
      };
      // v=1dc: als bij Establishing nog geen early media binnenkomt → start
      // lokale ringback en poll elke 500ms of provider alsnog een stream
      // aanlevert; zodra dat gebeurt stopt de lokale toon zodat er geen
      // dubbele audio speelt. Poll wordt onvoorwaardelijk opgeruimd bij
      // Established/Terminated en in de catch-branch hieronder.
      let _earlyMediaPollTimer = null;
      const _stopEarlyMediaPoll = () => {
        if (_earlyMediaPollTimer) { clearInterval(_earlyMediaPollTimer); _earlyMediaPollTimer = null; }
      };
      inviter.stateChange.addListener((s) => {
        if (s === 'Establishing') {
          state.lastState = 'ringing';
          const hasEarlyMedia = _bindRemoteAudio(); // early media / ringback
          if (hasEarlyMedia) {
            ringback.stop(); // safety — voor het geval 'ie ooit gestart is
          } else {
            ringback.start();
            _stopEarlyMediaPoll();
            _earlyMediaPollTimer = setInterval(() => {
              if (_bindRemoteAudio()) {
                ringback.stop();
                _stopEarlyMediaPoll();
              }
            }, 500);
          }
          updateCallbarStatus('Gaat over…', displayName ? `${displayName} — ${effPhone}` : effPhone);
          renderSheet();
        } else if (s === 'Established') {
          ringback.stop();
          _stopEarlyMediaPoll();
          state.lastState = 'connected';
          _bindRemoteAudio(); // zet audio als 'ie nog niet was gebonden
          updateCallbarStatus('In gesprek', displayName ? `${displayName} — ${effPhone}` : effPhone);
          startCallTimer();
          renderSheet();
        } else if (s === 'Terminated') {
          ringback.stop();
          _stopEarlyMediaPoll();
          state.lastState = 'ended';
          stopCallTimer();
          showCallbar(false);
          const audioEl = state.audioEl;
          if (audioEl) audioEl.srcObject = null;
          state.session = null;
          renderSheet();
        }
      });
      await inviter.invite();
      return { ok: true, line };
    } catch (e) {
      ringback.stop(); // v=1dc: nooit een oscillator achterlaten bij invite-fout
      state.lastState = 'error';
      state.lastError = e?.message || String(e);
      stopCallTimer();
      showCallbar(false);
      state.session = null;
      global.AgentShared?.showToast?.('Bellen mislukt: ' + (e?.message || 'onbekend'), 'error');
      renderSheet();
      return { ok: false, line, error: e?.message || 'invite' };
    }
  }

  async function hangup() {
    const s = state.session;
    if (!s) { showCallbar(false); stopCallTimer(); renderSheet(); return; }
    try {
      const st = s.state;
      if (st === 'Established')       await s.bye();
      else if (st === 'Establishing') await s.cancel();
      else if (typeof s.dispose === 'function') await s.dispose();
    } catch (e) {
      console.warn('[klx-softphone] hangup:', e?.message || e);
    }
    state.session = null;
    state.lastState = 'ended';
    stopCallTimer();
    showCallbar(false);
    renderSheet();
  }

  // ── Rich sheet (floating belvenster) ─────────────────────────────────────
  function ensureSheet() {
    let sheet = document.getElementById('klxSoftphoneSheet');
    if (sheet) return sheet;
    sheet = document.createElement('div');
    sheet.id = 'klxSoftphoneSheet';
    sheet.className = 'klx klx-call-sheet';
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="klx-call-sheet-header">
        <div class="klx-call-sheet-title" id="klxCallSheetTitle">Bellen</div>
        <button type="button" class="klx-call-sheet-close" id="klxCallSheetClose" aria-label="Sluiten">&#x2715;</button>
      </div>
      <div class="klx-call-sheet-body" id="klxCallSheetBody"></div>
    `;
    document.body.appendChild(sheet);
    sheet.querySelector('#klxCallSheetClose')?.addEventListener('click', closeSheet);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !sheet.hidden) closeSheet();
    });
    return sheet;
  }

  function openSheet(customer) {
    const sheet = ensureSheet();
    state.activeCustomer = customer || null;
    // Reset numberOverride bij nieuwe klant zodat vorige call niet lekt
    // naar deze sessie. lineOverride BEHOUDEN — die is gepersisteerd in
    // localStorage zodat de user zijn NL/BE-keuze niet elke call opnieuw
    // hoeft te maken (v=1da).
    state.numberOverride = null;
    state.lastError      = null;
    const nm = String(customer?.name || '').trim();
    const t = document.getElementById('klxCallSheetTitle');
    if (t) t.textContent = nm ? `Bellen · ${nm}` : 'Bellen';
    sheet.hidden = false;
    renderSheet();
    // Eager init on sheet-open (fire-and-forget).
    if (!state.initPromise
        && !Object.keys(state.uaByLine).length
        && !state.lastError) {
      initSoftphone().catch(() => {}).finally(() => renderSheet());
    }
  }

  function closeSheet() {
    const sheet = document.getElementById('klxSoftphoneSheet');
    if (sheet) sheet.hidden = true;
    state.activeCustomer = null;
    // Number/line-overrides niet resetten — user kan sheet dichtklappen
    // tijdens gesprek en de callbar-fallback blijft de call door-tonen.
  }

  function renderSheet() {
    const sheet = document.getElementById('klxSoftphoneSheet');
    if (!sheet || sheet.hidden) return;
    const body = sheet.querySelector('#klxCallSheetBody');
    if (!body) return;
    const cust    = state.activeCustomer || {};
    const phone   = cust.phone || '';
    const effPhone = resolveEffectivePhone(phone);
    const line    = resolveEffectiveLine(effPhone);
    const detected = detectLine(effPhone);
    const detectedLbl = detected === 'be' ? 'BE-lijn' : 'NL-lijn';
    const autoOptLabel = effPhone ? `Lijn · automatisch (→ ${detectedLbl})` : 'Lijn · automatisch';
    const beAvailable = isBeAvailable();
    const ov = state.lineOverride || 'auto';
    const connState = registrationStatusForLine(line);
    const connLabelMap = {
      idle       : '○ Nog niet verbonden',
      connecting : '○ Verbinden…',
      connected  : '● Verbonden',
      failed     : '● Verbinding mislukt',
      disabled   : `● ${line.toUpperCase()}-lijn niet beschikbaar`,
    };
    const connLabel = connLabelMap[connState] || connLabelMap.idle;
    const showConnRetry = (connState === 'failed' || connState === 'disabled');
    const st = state.lastState;
    const stateLabel =
      st === 'dialing'   ? 'Bellen…' :
      st === 'ringing'   ? 'Gaat over…' :
      st === 'connected' ? 'Verbonden' :
      st === 'ended'     ? 'Beëindigd' :
      st === 'error'     ? 'Fout: ' + (state.lastError || 'onbekend') :
      'Klaar';
    const inCall = st === 'dialing' || st === 'ringing' || st === 'connected';
    const canCall = !!effPhone;
    const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    // v=1da: uitgaand-nummer keuze — dropdown "Voys · standaard" + per-lijn
    // caller_ids uit /api/voys-sip-config. Alleen tonen wanneer er ≥1 optie
    // beschikbaar is (anders zou 'ie een lege lijst tonen).
    const availableCids = callerIdsForLine(line);
    const selectedCid = String(state.selectedCallerId || '');
    body.innerHTML = `
      <div class="klx-call-sheet-top">
        <div class="klx-call-sheet-label"><i class="ti ti-phone"></i> Uitbellen via</div>
        <select class="klx-call-sheet-lineselect" id="klxCallLineSel" ${inCall ? 'disabled' : ''} title="Kies handmatig NL/BE of laat automatisch bepalen op basis van het klantnummer">
          <option value="auto" ${ov === 'auto' ? 'selected' : ''}>${esc(autoOptLabel)}</option>
          <option value="nl"   ${ov === 'nl'   ? 'selected' : ''}>NL-lijn (+31)</option>
          ${beAvailable ? `<option value="be" ${ov === 'be' ? 'selected' : ''}>BE-lijn (+32)</option>` : ''}
        </select>
      </div>
      ${availableCids.length ? `
        <div class="klx-call-sheet-top" style="margin-top:6px">
          <div class="klx-call-sheet-label"><i class="ti ti-user"></i> Uitgaand nummer</div>
          <select class="klx-call-sheet-lineselect" id="klxCallCidSel" ${inCall ? 'disabled' : ''} title="Kies welk Voys-nummer als beller-ID uitgaat. 'Voys · standaard' laat Voys de account-default kiezen.">
            <option value=""${selectedCid ? '' : ' selected'}>Voys · standaard</option>
            ${availableCids.map((n) => `<option value="${esc(n)}"${selectedCid === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}
          </select>
        </div>
      ` : ''}
      <div class="klx-call-sheet-conn ${connState}" aria-live="polite">
        <span class="klx-call-sheet-conn-label">${esc(connLabel)}</span>
        <button type="button" class="klx-call-sheet-conn-retry" id="klxCallConnRetry" ${showConnRetry ? '' : 'hidden'} title="Opnieuw verbinden"><i class="ti ti-refresh"></i></button>
      </div>
      ${inCall
        ? `<div class="klx-call-sheet-number klx-mono">${esc(effPhone || 'geen nummer')}</div>`
        : `<input type="tel" class="klx-call-sheet-numinput klx-mono" id="klxCallNumberInput" value="${esc(effPhone)}" placeholder="+31 6..." />`
      }
      <div class="klx-call-sheet-state ${st}">${esc(stateLabel)}</div>
      <div class="klx-call-sheet-actions">
        ${inCall
          ? `<button class="klx-call-sheet-btn hangup" type="button" id="klxCallHangup"><i class="ti ti-phone-off"></i> Ophangen</button>
             <button class="klx-call-sheet-btn mute${state.muted ? ' on' : ''}" type="button" id="klxCallMute" title="${state.muted ? 'Microfoon aan' : 'Mute microfoon'}"><i class="ti ${state.muted ? 'ti-microphone-off' : 'ti-microphone'}"></i></button>`
          : `<button class="klx-call-sheet-btn dial" type="button" id="klxCallDial" ${!canCall ? 'disabled' : ''}>${canCall ? '📞 Bel nu' : 'Vul nummer in'}</button>`
        }
      </div>
    `;
    bindSheet();
  }

  function bindSheet() {
    const body = document.querySelector('#klxCallSheetBody');
    if (!body) return;
    const numIn = body.querySelector('#klxCallNumberInput');
    if (numIn) {
      numIn.addEventListener('input', (e) => {
        state.numberOverride = String(e.target.value || '').trim() || null;
        const dialBtn = body.querySelector('#klxCallDial');
        if (dialBtn) dialBtn.disabled = !state.numberOverride;
      });
      numIn.addEventListener('blur', () => renderSheet());
    }
    const lineSel = body.querySelector('#klxCallLineSel');
    if (lineSel) {
      lineSel.addEventListener('change', (e) => {
        const v = String(e.target.value || 'auto');
        state.lineOverride = v;
        // v=1da: onthoud de keuze cross-call/cross-session.
        try { localStorage.setItem('klx-softphone-line', v); } catch (_) { /* private mode */ }
        renderSheet();
      });
    }
    // v=1da: caller-ID keuze — persistente state.
    const cidSel = body.querySelector('#klxCallCidSel');
    if (cidSel) {
      cidSel.addEventListener('change', (e) => {
        const v = String(e.target.value || '');
        state.selectedCallerId = v;
        try { localStorage.setItem('klx-softphone-caller-id', v); } catch (_) { /* private mode */ }
      });
    }
    const retryBtn = body.querySelector('#klxCallConnRetry');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        state.initPromise = null;
        state.lastError   = null;
        renderSheet();
        initSoftphone().catch(() => {}).finally(() => renderSheet());
      });
    }
    const dialBtn = body.querySelector('#klxCallDial');
    if (dialBtn) {
      dialBtn.addEventListener('click', () => {
        const cust = state.activeCustomer || {};
        placeCall(cust.phone || '', { displayName: cust.name || '' });
      });
    }
    body.querySelector('#klxCallHangup')?.addEventListener('click', () => hangup());
    body.querySelector('#klxCallMute')?.addEventListener('click', () => {
      toggleMute();
      renderSheet();
    });
  }

  // ── Publieke API ─────────────────────────────────────────────────────────
  global.KlxSoftphone = {
    /**
     * open({ phone, name?, customerId?, source? }) — opent het rich belvenster
     * met lijn-select + bewerkbaar nummer + connect-status. customerId/source
     * zijn optionele meta-velden (voor toekomstige call-log-koppeling).
     */
    open(customer) {
      openSheet(customer || {});
    },
    /**
     * call(phone, { displayName?, line? }) — direct bellen zonder sheet
     * (voor bulk-flows / rij-actie in lijsten). Retourneert Promise met
     * { ok, line, error? }. NIET aanroepen als een gesprek al actief is —
     * bel eerst hangup().
     */
    call(phone, opts = {}) {
      return placeCall(phone, opts || {});
    },
    /**
     * hangup() — beëindig het lopende gesprek (indien any).
     */
    hangup() {
      return hangup();
    },
    /**
     * ensureReady() — fire-and-forget SIP-init. Handig voor pagina's die
     * verwachten dat de gebruiker gaat bellen: warm de registratie op zodat
     * de eerste call geen extra latency heeft. Retourneert Promise die
     * resolvet zodra ≥1 lijn geregistreerd is (of rejecteert bij init-fout).
     */
    ensureReady() {
      return initSoftphone();
    },
    /**
     * isConfigured() — synchrone check: heeft de user server-side ≥1
     * SIP-account (na tenminste 1 init-attempt)? Returns false vóór init.
     */
    isConfigured() {
      return Object.keys(state.uaByLine).length > 0;
    },
    /**
     * getStatus() — snapshot van state (state/activeLine/muted/
     * activeCustomer/configuredLines/lastError). Wordt bewust een KOPIE
     * gereturnt zodat callers niet in de state kunnen schrijven.
     */
    getStatus() {
      return {
        state           : state.lastState,
        activeLine      : state.activeLine,
        muted           : state.muted,
        activeCustomer  : state.activeCustomer,
        configuredLines : { ...state.configuredLines },
        lastError       : state.lastError,
      };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
