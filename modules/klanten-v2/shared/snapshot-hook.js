// modules/klanten-v2/shared/snapshot-hook.js
// #snapshot-B — client-side capture-hook. Monkey-patcht window.fetch op het
// laagste niveau zodat elke write via elke module (KV.authedFetch,
// wanbetalers-v2 _apiPostH, klx-softphone directe fetch, view-locale wrappers)
// automatisch gedekt is. Fires alleen op GESLAAGDE 2xx-writes naar /api/,
// buiten de denylist.
//
// Denylist-strategie i.p.v. allowlist: elke API-write telt tenzij expliciet
// uitgesloten. Kritisch te weren: recursief snapshot-endpoint + hoog-frequente
// eigen streams. Rest volgt uit method-guard (GET-polls filteren zichzelf uit).
//
// Fail-soft: elke laag mag falen (html2canvas missing, blob-error, netfout,
// storage-fail) — return de originele Response ONGEWIJZIGD zodat de originele
// action-flow nooit blokkeert of muteert.

(function initSnapshotHook() {
  'use strict';
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.__snapshotHookInstalled) return;
  window.__snapshotHookInstalled = true;

  // ── Rate-cap: max 1 snapshot per 5s ────────────────────────────────────
  const CAP_INTERVAL_MS = 5000;
  let _lastCaptureMs = 0;

  // ── Denylist ────────────────────────────────────────────────────────────
  // KRITISCH: /api/snapshot-log-upload voorkomt oneindige recursie
  // (elke snapshot-upload zou anders zelf een nieuwe snapshot triggeren).
  // /api/softphone-call-log: eigen stream, per-bel-hoge frequentie.
  // Overige polls/heartbeats zitten meestal op GET → method-guard filter.
  const DENY = [
    /\/api\/snapshot-log-upload\b/,
    /\/api\/softphone-call-log\b/,
  ];

  function _isApiUrl(url) {
    return typeof url === 'string' && /\/api\//.test(url);
  }

  function _isDenied(url) {
    return DENY.some((re) => re.test(url));
  }

  // ── Action-hint uit URL (generiek, dot-notation, gecapped op 100 chars)
  //    /api/wanbetalers-bulk-wa-send        → 'post.wanbetalers_bulk_wa_send'
  //    /api/cron/generate-monthly-concepts  → 'post.cron.generate_monthly_concepts'
  function _deriveActionHint(url, method) {
    try {
      const noHost = url.replace(/^https?:\/\/[^/]+/, '');
      const path   = noHost.split('?')[0].split('#')[0];
      const clean  = path.replace(/^\/?api\/?/, '')
                         .replace(/\/+/g, '.')
                         .replace(/-+/g, '_')
                         .replace(/^\.+|\.+$/g, '');
      return `${String(method || 'POST').toLowerCase()}.${clean}`.slice(0, 100);
    } catch (_) {
      return 'write.unknown';
    }
  }

  // ── Capture flow ────────────────────────────────────────────────────────
  async function _captureNow(actionHint) {
    if (!window.html2canvas) {
      console.warn('[snapshot-hook] html2canvas niet geladen — skip');
      return;
    }
    if (document.hidden) return;

    try {
      // Full-body zodat modals aan document.body (typ-to-confirm bulk-send)
      // meekomen. Iframes met srcdoc/sandbox blijven ZWART — expliciete
      // beperking (e-mail-body preview, events-automations, tickets-embeds).
      const canvas = await window.html2canvas(document.body, {
        scale:                  0.75,
        useCORS:                true,
        backgroundColor:        null,
        logging:                false,
        foreignObjectRendering: false,
        allowTaint:             false,
        ignoreElements:         (el) => el.hasAttribute && el.hasAttribute('data-snapshot-skip'),
      });

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.7));
      if (!blob) { console.warn('[snapshot-hook] toBlob returned null'); return; }
      if (blob.size > 900 * 1024) {
        console.warn('[snapshot-hook] blob > 900KB (' + blob.size + ') — skip');
        return;
      }
      const ab  = await blob.arrayBuffer();
      const b64 = _bufToBase64(ab);

      const token = (window.AuthShared && (await window.AuthShared.getAccessToken())) || null;
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;

      // BELANGRIJK: raw _originalFetch (niet de gepatchte fetch), zodat de
      // denylist-check niet opnieuw runt en er geen recursie kan ontstaan.
      // GEEN keepalive:true — base64-payload is ~666KB, ver boven de
      // keepalive-limiet van 64KB (zou stille reject geven). Capture gebeurt
      // in idle-tijd ná een geslaagde write, niet tijdens tab-unload.
      await _originalFetch('/api/snapshot-log-upload', {
        method: 'POST', headers,
        body: JSON.stringify({
          data_base64: b64,
          action_hint: actionHint,
          view_url:    (location.pathname + (location.hash || '')).slice(0, 500),
          view_title:  document.title ? document.title.slice(0, 200) : null,
        }),
      });
    } catch (e) {
      console.warn('[snapshot-hook] capture fail (soft):', e?.message || e);
    }
  }

  function _bufToBase64(ab) {
    const bytes = new Uint8Array(ab);
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // ── Monkey-patch window.fetch ─────────────────────────────────────────
  // Bewaar de originele referentie zodat _captureNow zichzelf niet loopt.
  const _originalFetch = window.fetch.bind(window);

  window.fetch = async function patchedFetch(input, init) {
    // Return de originele Response ALTIJD, ongewijzigd. Snapshot-flow eromheen.
    const resp = await _originalFetch(input, init);
    try {
      // URL normaliseren voor alle 3 input-vormen: string, Request (.url), URL (.href).
      const rawUrl = (typeof input === 'string')
        ? input
        : ((input && (input.url || input.href)) || '');

      // Guard 1: HTTP-method moet write zijn. Init-method wint (fetch() spec);
      // fallback naar input.method (Request-object); default GET.
      const method = String(init?.method || (input && input.method) || 'GET').toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return resp;

      // Guard 2: 2xx alleen.
      if (!resp.ok) return resp;

      // Guard 3: URL moet /api/ zijn.
      if (!_isApiUrl(rawUrl)) return resp;

      // Guard 4: denylist (recursie-guard + softphone).
      if (_isDenied(rawUrl)) return resp;

      // Guard 5: tab op de voorgrond.
      if (document.hidden) return resp;

      // Guard 6: rate-cap 5s.
      const now = Date.now();
      if (now - _lastCaptureMs < CAP_INTERVAL_MS) return resp;
      _lastCaptureMs = now;

      // Schedule non-blocking. Elke bug in _captureNow → console.warn,
      // originele resp is al terugreturn-ed hierboven.
      const scheduler = window.requestIdleCallback || ((cb) => setTimeout(cb, 100));
      scheduler(() => { _captureNow(_deriveActionHint(rawUrl, method)); });
    } catch (e) {
      console.warn('[snapshot-hook] wrap-post fail (soft):', e?.message || e);
    }
    return resp;
  };

  console.log('[snapshot-hook] installed (window.fetch patched, denylist ' + DENY.length + ' entries)');
})();
