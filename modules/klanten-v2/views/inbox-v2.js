// modules/klanten-v2/views/inbox-v2.js
//
// Inbox v2 — BROK 2 (v=4, 2026-08-17): unified werkplek — write-flows.
// LEES-only in deze brok: alle 8 bronnen tonen echte counts + rows, en
// voor conversation-bronnen (WA + Lisa) rendert de detail-pane een
// echte thread. Compose komt in BROK 2.
//
// Bron-mapping (per source in IB_SRC → endpoint):
//   Wanbetalers      wb      /api/inbox-conversations-list?module=finance
//   Events           ev      /api/inbox-conversations-list?module=events
//   Onboarding       ob      /api/inbox-conversations-list?module=onboarding
//   Lisa AI          lisa    /api/lisa-conversations?action=list_live&status=active
//   Leadsonderhoud   lo      /api/leadsonderhoud-overzicht                (deep-link only)
//   E-mail admin@    m_adm   /api/email-inbox-list?mailbox=administratie  (deep-link only)
//   E-mail info@     m_info  /api/email-inbox-list?mailbox=info           (deep-link only)
//   Tickets          tk      /api/tickets?status=open                     (deep-link only)
//
// Thread-render:
//   - WA-bronnen (wb/ev/ob): /api/inbox-messages-list?conversation_id=X
//     → append-only: nieuwe items worden erbij ge-appendt via data-msg-id,
//       bestaande DOM blijft staan, scrollTop bewaard.
//     → Op eerste render van een conv: scrollTop = scrollHeight (naar onder).
//     → mark-read fire-and-forget bij openen (inbox-mark-read POST),
//       fail-soft: 1 poging, geen retry.
//   - Lisa: /api/lisa-conversations?id=X → items met role user/assistant.
//     → Zelfde append-only pattern.
//   - lo/tk/m_adm/m_info: geen thread. Detail-pane toont preview + knop
//     "Open in <module>" naar de bron-module (E-mail / Tickets /
//     Leadsonderhoud). Vermijdt dupliceren met de nu-live modules.
//
// Dashboard-veiligheidsregels (dashboard-pattern):
//   1. Skeleton bij eerste load.
//   2. 8s timeout op elke fetch (tryFetch).
//   3. try/catch per source: 1 fail = source-teller '—', geen crash.
//   4. Sequence-tracking (_fetchSeq) tegen race bij snelle source-switch.
//   5. Render-loop guard: fetch trigger via queueMicrotask, in bundle-fn
//      wordt _fetched flag gezet zodat dezelfde tab niet blijft refetchen.
//   6. Append-only thread render: DOM-diff via data-msg-id, geen full
//      innerHTML rebuild, scroll-preserve.
//   7. Mark-read fail-soft (console.warn, geen retry-loop).
//
// Dormant — 'inbox' NIET in V2_ACTIVE_ALLOWLIST. Preview via ?v2preview=inbox.
// Protected zone leeg (geen klx-softphone / wbx-softphone raakvlak).

(function () {
  if (!window.DFO) { console.error('[inbox-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[inbox-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Source-registry ───────────────────────────────────────────────── */
  // v = source-slug, n = label, ic = icon, col = accent,
  // kind = 'wa'|'lisa'|'leadsonderhoud'|'tickets'|'email' (bepaalt fetcher +
  //         detail-render), mod = shell-target voor "Open in X"-knop.
  const IB_SRC = [
    // v         n                        ic          col       kind             mod
    ['wb',      'Wanbetalers',           I.alert,    'amber',   'wa',            'wanbetalers'],
    ['ev',      'Events',                I.cal,      'pink',    'wa',            'events'],
    ['ob',      'Onboarding',            I.route,    'emerald', 'wa',            'onboarding'],
    ['lisa',    'Lisa AI',               I.bot,      'violet',  'lisa',          'lisa'],
    ['lo',      'Leadsonderhoud',        I.repeat,   'teal',    'leadsonderhoud','leadsonderhoud'],
    ['m_adm',   'E-mail administratie@', I.mail,     'blue',    'email',         'email'],
    ['m_info',  'E-mail info@',          I.mail,     'emerald', 'email',         'email'],
    ['tk',      'Tickets',               I.ticket,   'rose',    'tickets',       'tickets'],
  ];
  const IB_GRP = [
    ['Aandacht',     IB_SRC.filter(x => ['wb', 'lisa'].includes(x[0]))],
    ['Klantcontact', IB_SRC.filter(x => ['ev', 'ob', 'm_adm', 'm_info'].includes(x[0]))],
    ['Overig',       IB_SRC.filter(x => ['lo', 'tk'].includes(x[0]))],
  ];
  // Per-source endpoint-map + response-key voor de items array. `mailbox`
  // is een email-source-specifieke parameter.
  const SRC_ENDPOINTS = {
    wb:     { url: '/api/inbox-conversations-list?module=finance&status_filter=active&limit=200',    itemsKey: 'items' },
    ev:     { url: '/api/inbox-conversations-list?module=events&status_filter=active&limit=200',     itemsKey: 'items' },
    ob:     { url: '/api/inbox-conversations-list?module=onboarding&status_filter=active&limit=200', itemsKey: 'items' },
    lisa:   { url: '/api/lisa-conversations?action=list_live&status=active&limit=100',               itemsKey: 'conversations' },
    lo:     { url: '/api/leadsonderhoud-overzicht',                                                  itemsKey: 'items' },
    m_adm:  { url: '/api/email-inbox-list?mailbox=administratie&folder=inbox&limit=100',             itemsKey: 'items', mailbox: 'administratie' },
    m_info: { url: '/api/email-inbox-list?mailbox=info&folder=inbox&limit=100',                      itemsKey: 'items', mailbox: 'info' },
    tk:     { url: '/api/tickets?status=open',                                                       itemsKey: 'tickets' },
  };

  /* ── State ─────────────────────────────────────────────────────────── */
  let ibSrc = 'wb';
  let ibSel = null; // id van geselecteerde rij (uuid/int, source-afhankelijk)
  const _live = {
    loading: false,
    error: null,
    fetched: false, // eenmalige-bundle-guard
    // per source: { items:[], raw:<response>, error:<msg|null> } of null bij fail
    sources: { wb: null, ev: null, ob: null, lisa: null, lo: null, m_adm: null, m_info: null, tk: null },
  };
  let _fetchSeq = 0;

  // Thread-state (WA/Lisa). Reset bij ibSel-wissel.
  const _thread = {
    loading: false,
    error: null,
    convId: null,        // waar de items bij horen (voor DOM-diff detectie)
    src: null,           // source-slug waaruit convId komt
    items: [],           // { id, direction: 'inbound'|'outbound', body, at }
    _paintedFor: null,   // convId waarvoor DOM al gepaint is (append-guard)
    _markedFor: null,    // convId waarvoor mark-read al is aangeroepen
  };

  // BROK 2: compose-state per conv (draft-text + mode). Text-mode is default;
  // switcht naar 'template' zodra inbox-send een 422 24h-window-error geeft.
  // Draft wordt bewaard per conv-id zodat wisselen tussen convs niets kwijt-
  // maakt. Send-in-flight guard voorkomt dubbele POST bij double-click.
  const _compose = {
    drafts: {},        // { convId: 'text draft' }
    mode:   {},        // { convId: 'text' | 'template' }
    sending: null,     // convId waarvoor send momenteel in-flight is
    templateCache: {}, // { convId: [templates] } — lazy loaded
    quickCache:    {}, // { convId: [quick_replies] } — lazy loaded
  };

  // Live-refresh poll (BROK 2 punt 6). setInterval-handle + guard tegen
  // dubbele start. Refresh doet: bundle counts + open-thread append-only.
  // Stopt zodra #ibThreadScroll niet meer in DOM zit (module verlaten).
  const _poll = {
    handle: null,
    intervalMs: 18000,
    running: false,
  };

  /* ── tryFetch met 8s timeout (dashboard-pattern) ──────────────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[inbox-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  /* ── Bundle-fetch: 8 bronnen parallel ─────────────────────────────── */
  async function fetchInboxBundle() {
    if (_live.fetched && !_live.error) return; // eenmalige guard
    if (_live.loading) return;                 // race-guard
    const seq = ++_fetchSeq;
    _live.loading = true;
    _live.error = null;
    console.debug('[inbox-v2] bundle start seq=' + seq);
    if (window.DFO && window.DFO.render) window.DFO.render();

    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      const keys = Object.keys(SRC_ENDPOINTS);
      const results = await Promise.all(
        keys.map(k => tryFetch('src ' + k, SRC_ENDPOINTS[k].url))
      );
      if (seq !== _fetchSeq) { console.debug('[inbox-v2] discard stale seq=' + seq); return; }
      let anyOk = false;
      keys.forEach((k, i) => {
        const resp = results[i];
        if (resp && typeof resp === 'object') {
          const itemsKey = SRC_ENDPOINTS[k].itemsKey;
          const arr = Array.isArray(resp[itemsKey]) ? resp[itemsKey] : [];
          _live.sources[k] = { items: arr, raw: resp, error: null };
          anyOk = true;
        } else {
          _live.sources[k] = { items: [], raw: null, error: 'fetch failed' };
        }
      });
      _live.fetched = true;
      _live.error = anyOk ? null : 'Alle inbox-endpoints faalden';
      console.debug('[inbox-v2] bundle done seq=' + seq, Object.fromEntries(keys.map(k => [k, _live.sources[k]?.items?.length ?? '—'])));
    } catch (e) {
      if (seq !== _fetchSeq) return;
      console.error('[inbox-v2] bundle fail seq=' + seq, e && e.message);
      _live.error = (e && e.message) || 'onbekende fout';
    } finally {
      if (seq === _fetchSeq) {
        _live.loading = false;
        if (window.DFO && window.DFO.render) window.DFO.render();
      }
    }
  }

  /* ── HTML-escape helper (BROK 1 bug 3 fix) ─────────────────────────── */
  // Root cause bug 3: mapEmailRow zet raw m.from_name in de row-HTML.
  // E-mail from_name bevat vaak RFC 5322 formaat "Naam <email@x.nl>".
  // Elk '<' opende een fake tag → 85 rijen cascadeerden in elkaar en
  // .ib-detail belandde als grandchild van .ib-list i.p.v. sibling.
  // Alle user-strings die in innerHTML landen worden nu via _esc gerend.
  function _esc(v) {
    if (v == null) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── Modal-helpers (non-blocking confirm + generic overlay) ─────── */
  // KLANT-VEILIG: elke verstuur-actie eist een expliciete confirm-klik.
  // Geen native window.confirm — die bevriest de compose in Chrome. Custom
  // overlay met backdrop; Esc + backdrop-klik = annuleren.
  function _closeModal() {
    const m = document.getElementById('ibModalRoot');
    if (m) m.remove();
    document.removeEventListener('keydown', _modalKeyHandler, true);
  }
  function _modalKeyHandler(e) {
    if (e.key === 'Escape') { e.preventDefault(); _closeModal(); }
  }
  function _openModal(innerHtml, opts) {
    _closeModal();
    const root = document.createElement('div');
    root.id = 'ibModalRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    root.innerHTML = `<div id="ibModalBox" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:22px;max-width:${opts?.maxWidth || 460}px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">${innerHtml}</div>`;
    root.addEventListener('click', (e) => { if (e.target === root) _closeModal(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', _modalKeyHandler, true);
    return root;
  }
  function _askConfirm(title, body, opts) {
    const okLabel     = _esc(opts?.okLabel     || 'Bevestig');
    const cancelLabel = _esc(opts?.cancelLabel || 'Annuleren');
    const tone        = opts?.tone === 'danger' ? 'rose' : 'brand';
    return new Promise((resolve) => {
      _openModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${_esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px;white-space:pre-wrap">${_esc(body)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="ibModalCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="ibModalOk" class="btn btn-primary btn-sm" style="background:var(--${tone});border-color:var(--${tone})">${okLabel}</button>
        </div>`);
      document.getElementById('ibModalCancel').addEventListener('click', () => { _closeModal(); resolve(false); });
      document.getElementById('ibModalOk').addEventListener('click', () => { _closeModal(); resolve(true); });
    });
  }
  function _toast(msg, tone) {
    // Herbruikt v2-toast (window.KV.toast bestaat via klanten-v2.js).
    try { if (window.KV && window.KV.toast) window.KV.toast(msg, { tone }); } catch (_) {}
  }

  /* ── Handler-stubs op window ──────────────────────────────────────── */
  window.__ibSetSrc = (v) => {
    ibSrc = v;
    ibSel = null;
    _resetThread();
    if (window.DFO && window.DFO.render) window.DFO.render();
  };
  // BROK 1 bug 1 fix: surgische selectie zonder full DFO.render().
  // Full render zou .ib-list innerHTML herbouwen → scrollTop 1800 → 0.
  // Nu: toggle 'on'-class op de rijen (behoud scrollpositie in .ib-list),
  // vervang alleen de .ib-detail sibling, trigger thread-load. Router-
  // filters (F('q'/'fl')) blijven staan.
  window.__ibSel = (id) => {
    if (String(ibSel) === String(id)) return;
    ibSel = id;
    _resetThread();
    // 1) Selection-highlight surgisch bijwerken.
    document.querySelectorAll('.ib-row.on').forEach(el => el.classList.remove('on'));
    const newRow = document.querySelector('.ib-row[data-row-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    // 2) Detail-pane vervangen. Zoek gekozen row-data + srcInfo, render
    //    detail-HTML, vervang bestaande .ib-detail (of injecteer als sibling
    //    in .ib-split als 'ie er nog niet is).
    const srcInfo = IB_SRC.find(x => x[0] === ibSrc) || IB_SRC[0];
    const row = currentRows().find(r => String(r.id) === String(id));
    const split = document.querySelector('.ib-split');
    const oldDetail = split ? split.querySelector('.ib-detail') : null;
    if (split && row) {
      const wrap = document.createElement('div');
      wrap.innerHTML = renderDetail(row, srcInfo);
      const newDetail = wrap.firstElementChild;
      if (newDetail) {
        if (oldDetail) split.replaceChild(newDetail, oldDetail);
        else split.appendChild(newDetail);
      }
    }
    // 3) Thread-load voor WA/Lisa (loadThread doet zelf paint via microtask).
    const kind = srcInfo[4];
    if (row && (kind === 'wa' || kind === 'lisa')) {
      queueMicrotask(() => _loadThread(row, ibSrc));
    } else {
      // Deep-link kinds: geen thread; paint alsnog om lege container te clearen.
      queueMicrotask(_paintThread);
    }
  };
  window.__ibGoMod = (mod) => { try { if (window.DFO && window.DFO.goMod) window.DFO.goMod(mod); } catch (_) {} };

  /* ── BROK 2 write-handlers ────────────────────────────────────────── */

  // Compose-textarea uncontrolled input. Alleen state, geen render.
  window.__ibDraftInput = (convId, val) => { _compose.drafts[convId] = val; };

  // Send text (of switch naar template bij 422 24h-window).
  window.__ibSend = async () => {
    const convId = _thread.convId;
    const src = _thread.src;
    if (!convId || !src) return;
    if (_compose.sending === convId) return; // race-guard
    const kind = (IB_SRC.find(x => x[0] === src) || [])[4];
    const body = String(_compose.drafts[convId] || '').trim();
    if (!body) { _toast('Bericht is leeg', 'warn'); return; }

    // Klant-context voor confirm (naam uit rijlijst).
    const row = currentRows().find(r => String(r.id) === String(convId));
    const naam = row?.van || 'de klant';
    const preview = body.length > 140 ? body.slice(0, 140) + '…' : body;

    // KLANT-VEILIG: confirm vóór echte verzending.
    const ok = await _askConfirm(
      `Verstuur bericht naar ${naam}?`,
      preview,
      { okLabel: 'Verstuur', cancelLabel: 'Annuleren' }
    );
    if (!ok) return;

    _compose.sending = convId;
    _repaintCompose(); // toont "verzenden…"

    try {
      if (kind === 'lisa') {
        // Lisa: intervene endpoint (mens neemt over via GHL DM).
        const resp = await window.KV.authedFetch('/api/lisa-conversations?action=intervene&id=' + encodeURIComponent(convId), {
          method: 'POST',
          body: JSON.stringify({ content: body }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + resp.status));
        }
        _optimisticAppend(convId, body);
        _compose.drafts[convId] = '';
        _toast('Verstuurd via Lisa', 'ok');
      } else if (kind === 'wa') {
        // WA: eerst free-form text; 422 → template-modus.
        const resp = await window.KV.authedFetch('/api/inbox-send', {
          method: 'POST',
          body: JSON.stringify({ conversation_id: convId, mode: 'text', body }),
        });
        if (resp.status === 422) {
          const j = await resp.json().catch(() => ({}));
          const reason = j.error || '24h_window_expired';
          if (String(reason).includes('24h') || String(reason).includes('window')) {
            _compose.mode[convId] = 'template';
            _toast('Buiten 24u-venster — kies een goedgekeurde template', 'warn');
            _openTemplatePicker(convId);
            return;
          }
          throw new Error(reason);
        }
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + resp.status));
        }
        _optimisticAppend(convId, body);
        _compose.drafts[convId] = '';
        _toast('WhatsApp verzonden', 'ok');
      } else {
        _toast('Deze bron ondersteunt (nog) geen verzenden', 'warn');
      }
    } catch (e) {
      console.warn('[inbox-v2] send fail:', e && e.message);
      _toast('Versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _compose.sending = null;
      _repaintCompose();
    }
  };

  // Optimistic-append: voeg meteen een outbound msg toe aan de thread.
  function _optimisticAppend(convId, body) {
    if (_thread.convId !== convId) return;
    _thread.items.push({
      id: 'opt-' + Date.now(),
      direction: 'outbound',
      body,
      at: new Date().toISOString(),
      meta: {},
    });
    _paintThread();
  }

  // Quick-replies popover — lazy fetch, kies = vul textarea.
  window.__ibQuickPicker = async () => {
    const convId = _thread.convId;
    if (!convId) return;
    let items = _compose.quickCache[convId];
    if (!items) {
      const resp = await tryFetch('quick-replies', '/api/inbox-quick-replies-list?conversation_id=' + encodeURIComponent(convId));
      items = (resp && Array.isArray(resp.items)) ? resp.items : [];
      _compose.quickCache[convId] = items;
    }
    if (!items.length) { _toast('Geen snel-antwoorden geconfigureerd', 'warn'); return; }
    _openModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:12px">Snel-antwoord kiezen</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow-y:auto">
        ${items.map(it => `
          <button class="btn btn-ghost btn-sm" data-qr-id="${_esc(it.id)}" style="text-align:left;justify-content:flex-start;padding:10px 12px;height:auto;white-space:normal">
            <div style="font-weight:600;margin-bottom:2px">${_esc(it.title || '(zonder titel)')}</div>
            <div style="font-size:12px;color:var(--text-3);white-space:pre-wrap;line-height:1.45">${_esc(it.body_text || '')}</div>
          </button>`).join('')}
      </div>
      <div style="margin-top:14px;text-align:right"><button id="ibQrCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 560 });
    document.getElementById('ibQrCancel').addEventListener('click', _closeModal);
    document.querySelectorAll('#ibModalBox [data-qr-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-qr-id');
        const it = items.find(x => String(x.id) === String(id));
        if (it) {
          _compose.drafts[convId] = (String(_compose.drafts[convId] || '') + (it.body_text || '')).trimStart();
          _repaintCompose();
          _closeModal();
        }
      });
    });
  };

  // Template-picker (WA). Toont approved templates; kies → variable-form (positional {{1}}
  // simpel; named=meta_param_mapping → server-side resolve, geen invoer).
  window.__ibTemplatePicker = () => { _openTemplatePicker(_thread.convId); };
  async function _openTemplatePicker(convId) {
    if (!convId) return;
    let items = _compose.templateCache[convId];
    if (!items) {
      const resp = await tryFetch('template-list', '/api/inbox-template-list?conversation_id=' + encodeURIComponent(convId));
      items = (resp && Array.isArray(resp.items)) ? resp.items : [];
      _compose.templateCache[convId] = items;
    }
    if (!items.length) { _toast('Geen goedgekeurde templates beschikbaar', 'warn'); return; }
    _openModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Kies een goedgekeurde template</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">Templates mogen ook buiten het 24u-venster verstuurd worden.</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:55vh;overflow-y:auto" id="ibTplList">
        ${items.map(it => `
          <button class="btn btn-ghost btn-sm" data-tpl-id="${_esc(it.id)}" style="text-align:left;justify-content:flex-start;padding:10px 12px;height:auto;white-space:normal">
            <div style="font-weight:600;margin-bottom:2px">${_esc(it.name)} <span style="font-size:10.5px;color:var(--text-3);font-weight:400">· ${_esc(it.language || 'nl')} · ${_esc(it.category || '')}</span></div>
            <div style="font-size:12px;color:var(--text-3);white-space:pre-wrap;line-height:1.45">${_esc((it.body_text || '').slice(0, 200))}</div>
          </button>`).join('')}
      </div>
      <div style="margin-top:14px;text-align:right"><button id="ibTplCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 620 });
    document.getElementById('ibTplCancel').addEventListener('click', _closeModal);
    document.querySelectorAll('#ibTplList [data-tpl-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-tpl-id');
        const it = items.find(x => String(x.id) === String(id));
        if (it) _openTemplateForm(convId, it);
      });
    });
  }
  function _openTemplateForm(convId, tpl) {
    const bodyText = String(tpl.body_text || '');
    // Detecteer variables {{1}}, {{2}}, ... — als er een meta_param_mapping
    // met body-keys is, kiezen we voor auto-resolve (server doet 't).
    const namedMapping = tpl.meta_param_mapping && typeof tpl.meta_param_mapping === 'object' && tpl.meta_param_mapping.body;
    const positionalKeys = [];
    const re = /\{\{(\d+)\}\}/g; let m;
    while ((m = re.exec(bodyText))) if (!positionalKeys.includes(m[1])) positionalKeys.push(m[1]);
    positionalKeys.sort((a, b) => Number(a) - Number(b));

    const previewHtml = _esc(bodyText).replace(/\{\{(\d+)\}\}/g, '<b style="background:var(--brand-soft,var(--surface-2));padding:0 4px;border-radius:3px">{{$1}}</b>');
    const variablesForm = (namedMapping || positionalKeys.length === 0)
      ? `<div style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--surface-2);border-radius:var(--r-sm);margin-bottom:12px">
           ${namedMapping ? 'Variabelen worden automatisch ingevuld (klant + factuur-context).' : 'Deze template heeft geen variabelen.'}
         </div>`
      : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
           ${positionalKeys.map(k => `
             <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px">
               <span style="color:var(--text-3)">Variabele {{${_esc(k)}}}</span>
               <input class="input" id="ibTplVar_${_esc(k)}" placeholder="waarde voor {{${_esc(k)}}}" style="padding:8px 10px;font-size:13px">
             </label>`).join('')}
         </div>`;

    _openModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">${_esc(tpl.name)}</div>
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:13px;line-height:1.55;white-space:pre-wrap;margin-bottom:14px">${previewHtml}</div>
      ${variablesForm}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="ibTplBack" class="btn btn-ghost btn-sm">Terug</button>
        <button id="ibTplSend" class="btn btn-primary btn-sm">Verstuur template</button>
      </div>`, { maxWidth: 560 });

    document.getElementById('ibTplBack').addEventListener('click', () => _openTemplatePicker(convId));
    document.getElementById('ibTplSend').addEventListener('click', async () => {
      // Collect variables (alleen positional; named laat server resolven).
      const variables = {};
      if (!namedMapping) {
        positionalKeys.forEach(k => {
          const el = document.getElementById('ibTplVar_' + k);
          if (el) variables[k] = el.value || '';
        });
      }
      // Confirm klant-veilig.
      const row = currentRows().find(r => String(r.id) === String(convId));
      const naam = row?.van || 'de klant';
      const ok = await _askConfirm(
        `Verstuur template naar ${naam}?`,
        `Template: ${tpl.name}\n${namedMapping ? '(auto-resolve variabelen)' : (positionalKeys.length ? 'Ingevulde variabelen: ' + positionalKeys.map(k => '{{' + k + '}}=' + (variables[k] || '(leeg)')).join(', ') : 'geen variabelen')}`,
        { okLabel: 'Verstuur template' }
      );
      if (!ok) { _openTemplateForm(convId, tpl); return; }
      _closeModal();
      _compose.sending = convId;
      _repaintCompose();
      try {
        const payload = {
          conversation_id: convId,
          template_name: tpl.name,
          meta_template_id: tpl.meta_template_id || undefined,
          language: tpl.language || 'nl',
          variables,
        };
        const resp = await window.KV.authedFetch('/api/inbox-send-template', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + resp.status));
        }
        // Optimistic append — toon bericht als "template: <name>".
        _optimisticAppend(convId, bodyText.replace(/\{\{(\d+)\}\}/g, (mm, k) => variables[k] || ('{{' + k + '}}')));
        _compose.mode[convId] = 'text'; // volgende bericht mag weer text als binnen 24u
        _toast('Template verzonden', 'ok');
      } catch (e) {
        console.warn('[inbox-v2] template-send fail:', e && e.message);
        _toast('Template versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
      } finally {
        _compose.sending = null;
        _repaintCompose();
      }
    });
  }

  // Status-wijzigen: archiveren / heropenen / markeer ongelezen.
  window.__ibSetStatus = async (uiStatus) => {
    const convId = _thread.convId;
    const src    = _thread.src;
    if (!convId || !src) return;
    const kind = (IB_SRC.find(x => x[0] === src) || [])[4];
    if (kind !== 'wa') { _toast('Alleen WhatsApp-conversaties hebben deze status', 'warn'); return; }

    const row = currentRows().find(r => String(r.id) === String(convId));
    const naam = row?.van || 'de conversatie';
    const label = uiStatus === 'gearchiveerd' ? 'Archiveren' : uiStatus === 'open' ? 'Heropenen' : 'Afhandelen';
    const ok = await _askConfirm(
      `${label} — ${naam}?`,
      uiStatus === 'gearchiveerd'
        ? 'Deze conversatie verdwijnt uit de actieve lijst en komt NIET vanzelf terug bij een nieuwe inbound.'
        : uiStatus === 'afgehandeld'
          ? 'Tijdelijk uit de lijst; komt terug zodra de klant weer inbound stuurt.'
          : 'Verplaats terug naar de actieve lijst.',
      { okLabel: label, tone: uiStatus === 'gearchiveerd' ? 'danger' : 'brand' }
    );
    if (!ok) return;
    try {
      const resp = await window.KV.authedFetch('/api/inbox-conversation-set-status', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: convId, status: uiStatus }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      // Surgische update: verwijder rij uit lokale state + DOM (actieve
      // lijst toont alleen 'open'; bij 'heropenen' zou 'ie moeten terugkomen
      // maar dan met bundle-refresh — voor nu simpelweg verwijderen).
      const s = _live.sources[src];
      if (s && Array.isArray(s.items)) {
        s.items = s.items.filter(it => String(it.id) !== String(convId));
      }
      const rowEl = document.querySelector('.ib-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
      if (rowEl) rowEl.remove();
      // Volgende rij selecteren of leeg-state tonen.
      ibSel = null;
      _resetThread();
      const split = document.querySelector('.ib-split');
      const oldDetail = split ? split.querySelector('.ib-detail') : null;
      if (oldDetail) oldDetail.remove();
      _toast(label + ' — gelukt', 'ok');
    } catch (e) {
      console.warn('[inbox-v2] set-status fail:', e && e.message);
      _toast('Status wijzigen mislukt: ' + (e?.message || 'onbekend'), 'error');
    }
  };

  window.__ibMarkUnread = async () => {
    const convId = _thread.convId;
    const src    = _thread.src;
    if (!convId || !src) return;
    const kind = (IB_SRC.find(x => x[0] === src) || [])[4];
    if (kind !== 'wa') { _toast('Alleen WhatsApp-conversaties hebben ongelezen-vlag', 'warn'); return; }
    try {
      const resp = await window.KV.authedFetch('/api/inbox-mark-unread', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: convId }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      // Surgische update: zet unread_count > 0 + .nw class terug.
      const s = _live.sources[src];
      if (s && Array.isArray(s.items)) {
        const idx = s.items.findIndex(it => String(it.id) === String(convId));
        if (idx >= 0) s.items[idx] = { ...s.items[idx], unread_count: (s.items[idx].unread_count || 0) + 1 };
      }
      const rowEl = document.querySelector('.ib-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
      if (rowEl && !rowEl.classList.contains('nw')) {
        rowEl.classList.add('nw');
        // Voeg rose-stip toe (matcht renderRow markup).
        const tagRow = rowEl.querySelector('.ib-src-tag')?.parentElement;
        if (tagRow && !tagRow.querySelector('span[style*="background:var(--rose)"]')) {
          const dot = document.createElement('span');
          dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto';
          tagRow.appendChild(dot);
        }
      }
      // Reset _markedFor zodat opnieuw openen ook opnieuw mark-read triggert.
      _thread._markedFor = null;
      _toast('Gemarkeerd als ongelezen', 'ok');
    } catch (e) {
      console.warn('[inbox-v2] mark-unread fail:', e && e.message);
      _toast('Ongelezen markeren mislukt: ' + (e?.message || 'onbekend'), 'error');
    }
  };

  // Klant/Attendee koppelen — search-modal met uncontrolled input +
  // debounce. Endpoint per source-kind.
  window.__ibLinkModal = () => {
    const convId = _thread.convId;
    const src    = _thread.src;
    if (!convId || !src) return;
    const kind = (IB_SRC.find(x => x[0] === src) || [])[4];
    if (kind !== 'wa') { _toast('Koppelen is alleen voor WhatsApp-conversaties', 'warn'); return; }
    const isEvents = (src === 'ev');
    const searchUrl = isEvents ? '/api/inbox-attendee-search' : '/api/inbox-customer-search';
    const linkUrl   = isEvents ? '/api/inbox-link-conversation-to-attendee' : '/api/inbox-link-conversation-to-customer';
    const bodyKey   = isEvents ? 'attendee_id' : 'customer_id';
    const label     = isEvents ? 'aanmelding' : 'klant';

    _openModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:10px">Koppel ${label}</div>
      <input id="ibLinkQ" class="input" placeholder="Zoek op naam / e-mail / telefoon (min. 2 tekens)…" style="width:100%;padding:9px 11px;font-size:13.5px;margin-bottom:12px">
      <div id="ibLinkResults" style="max-height:50vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;font-size:13px">
        <div style="padding:20px;color:var(--text-3);text-align:center">Typ om te zoeken…</div>
      </div>
      <div style="margin-top:14px;text-align:right"><button id="ibLinkCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 620 });

    document.getElementById('ibLinkCancel').addEventListener('click', _closeModal);
    const inp = document.getElementById('ibLinkQ');
    inp.focus();
    let _debounce = null;
    let _seq = 0;
    inp.addEventListener('input', () => {
      const q = inp.value.trim();
      if (_debounce) clearTimeout(_debounce);
      if (q.length < 2) {
        _renderLinkResults([], null, isEvents, convId, linkUrl, bodyKey);
        return;
      }
      _debounce = setTimeout(async () => {
        const seq = ++_seq;
        const resp = await tryFetch('link-search', searchUrl + '?q=' + encodeURIComponent(q) + '&limit=20');
        if (seq !== _seq) return;
        const results = (resp && Array.isArray(resp.results)) ? resp.results : [];
        _renderLinkResults(results, resp?.error || null, isEvents, convId, linkUrl, bodyKey);
      }, 250);
    });
  };
  function _renderLinkResults(results, error, isEvents, convId, linkUrl, bodyKey) {
    const container = document.getElementById('ibLinkResults');
    if (!container) return;
    if (error) { container.innerHTML = `<div style="padding:18px;color:var(--rose)">⚠ ${_esc(error)}</div>`; return; }
    if (!results.length) { container.innerHTML = `<div style="padding:18px;color:var(--text-3);text-align:center">Geen resultaten</div>`; return; }
    container.innerHTML = results.map(r => {
      const naam = isEvents ? [r.first_name, r.last_name].filter(Boolean).join(' ') || (r.email || 'onbekend') : (r.name || 'onbekend');
      const meta = isEvents
        ? `${_esc(r.email || '')}${r.event_title ? ' · ' + _esc(r.event_title) : ''}`
        : `${_esc(r.email || '')}${r.phone ? ' · ' + _esc(r.phone) : ''}`;
      return `<button class="btn btn-ghost btn-sm" data-link-id="${_esc(r.id)}" style="text-align:left;justify-content:flex-start;padding:9px 11px;height:auto">
        <div style="font-weight:600">${_esc(naam)}</div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:1px">${meta}</div>
      </button>`;
    }).join('');
    container.querySelectorAll('[data-link-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-link-id');
        const ok = await _askConfirm('Koppel deze conversatie?', 'De conversatie wordt aan de gekozen ' + (isEvents ? 'aanmelding' : 'klant') + ' vastgeplakt.', { okLabel: 'Koppel' });
        if (!ok) return;
        try {
          const resp = await window.KV.authedFetch(linkUrl, {
            method: 'POST',
            body: JSON.stringify({ conversation_id: convId, [bodyKey]: id }),
          });
          if (!resp.ok) {
            const j = await resp.json().catch(() => ({}));
            throw new Error(j.error || ('HTTP ' + resp.status));
          }
          const j = await resp.json();
          _closeModal();
          _toast('Gekoppeld: ' + (j.customer_name || 'gelukt'), 'ok');
          // Refresh bundle om de nieuwe koppeling in de rijen te zien.
          _live.fetched = false;
          queueMicrotask(() => fetchInboxBundle());
        } catch (e) {
          console.warn('[inbox-v2] link fail:', e && e.message);
          _toast('Koppelen mislukt: ' + (e?.message || 'onbekend'), 'error');
        }
      });
    });
  }

  // Alleen de compose-block herrenderen (bij _sending state-change).
  function _repaintCompose() {
    const el = document.getElementById('ibComposeBlock');
    if (!el) return;
    el.outerHTML = _renderCompose();
  }

  /* ── Source-teller ─────────────────────────────────────────────────── */
  function srcCount(v) {
    const s = _live.sources[v];
    if (!s) return null;                             // nog niet geladen
    if (s.error) return null;                        // fetch mislukt → '—'
    // tickets: filter op open/in_progress voor het "aandacht"-getal.
    if (v === 'tk') {
      const counts = s.raw?.counts || {};
      const open = (counts.open || 0) + (counts.in_progress || 0);
      return open;
    }
    // BROK 2: E-mail — response bevat 'total' (kan groter zijn dan limit=100).
    // Toon het echte totaal. srcCountDisplay() rendert daarna evt. '100+' vs '113'.
    if (v === 'm_adm' || v === 'm_info') {
      const total = Number(s.raw?.total || 0);
      if (Number.isFinite(total) && total > 0) return total;
      return s.items.length;
    }
    // Overige: aantal items uit response.
    return s.items.length;
  }
  // Display-helper: bij WA/onboarding/events limit=200 (default weergave =
  // exact getal). Bij e-mail willen we '100+' als items limit-truncated is
  // maar het echte totaal onbekend/gelijk. Response geeft total mee — we
  // tonen dus altijd het exact getal, tenzij total ontbreekt en items ==
  // limit → dan '100+'.
  function srcCountDisplay(v, cnt) {
    if (cnt == null) return '—';
    if (v === 'm_adm' || v === 'm_info') {
      const s = _live.sources[v];
      const total = Number(s?.raw?.total || 0);
      if (!Number.isFinite(total) || total <= 0) {
        return s?.items?.length >= 100 ? '100+' : String(s?.items?.length || 0);
      }
      // Als items truncated zijn en total meer is → wel exact getal (dat is duidelijker).
      return String(total);
    }
    return String(cnt);
  }

  /* ── Row-mapping per source-kind ──────────────────────────────────── */
  function currentRows() {
    const s = _live.sources[ibSrc];
    if (!s || !Array.isArray(s.items)) return [];
    const kind = (IB_SRC.find(x => x[0] === ibSrc) || [])[4];

    if (kind === 'wa')          return s.items.map(mapWaRow);
    if (kind === 'lisa')        return s.items.map(mapLisaRow);
    if (kind === 'leadsonderhoud') return s.items.slice(0, 50).map(mapLoRow);
    if (kind === 'email')       return s.items.map(mapEmailRow);
    if (kind === 'tickets') {
      // Alleen open/in_progress; sorteer nieuwste eerst.
      return s.items
        .filter(t => t.status === 'open' || t.status === 'in_progress')
        .map(mapTicketRow);
    }
    return [];
  }

  function _fmtTijd(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const delta = Date.now() - d.getTime();
      if (delta < 0) return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
      if (delta < 3600000) return Math.max(1, Math.round(delta / 60000)) + 'm';
      if (delta < 86400000) return Math.round(delta / 3600000) + 'u';
      if (delta < 7 * 86400000) return Math.round(delta / 86400000) + 'd';
      return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    } catch (_) { return '—'; }
  }

  function mapWaRow(c) {
    const custName = c.customer
      ? (c.customer.is_company ? c.customer.company_name : [c.customer.first_name, c.customer.last_name].filter(Boolean).join(' '))
      : (c.attendee ? [c.attendee.first_name, c.attendee.last_name].filter(Boolean).join(' ') : null);
    const van = custName || c.display_name || c.phone_number || 'Onbekend';
    return {
      id: c.id,
      van,
      t: c.last_message_preview || '—',
      p: c.attendee?.event?.title || c.customer?.email || '',
      tijd: _fmtTijd(c.last_message_at || c.last_activity_at),
      nw: (c.unread_count || 0) > 0,
      kan: 'WhatsApp',
      ctx: c.customer?.email || c.phone_number || '',
      _raw: c,
    };
  }
  function mapLisaRow(c) {
    const van = c.contact_name || c.instagram_handle || c.ghl_contact_id || 'Onbekend';
    return {
      id: c.id,
      van,
      t: c.preview || '—',
      p: c.phase ? ('fase: ' + c.phase) : '',
      tijd: _fmtTijd(c.last_message_at || c.created_at),
      nw: false, // Lisa levert geen unread-state
      kan: 'Lisa AI',
      ctx: c.instagram_handle || '',
      _raw: c,
    };
  }
  function mapLoRow(l) {
    const van = l.naam || l.email || 'Onbekend';
    return {
      id: l.id || l.contact_id || l.email,
      van,
      t: l.laatste_bericht_preview || l.traject || l.status || '—',
      p: l.email || '',
      tijd: _fmtTijd(l.laatste_activiteit || l.last_contact_at || l.updated_at || l.created_at),
      nw: false,
      kan: 'Leadsonderhoud',
      ctx: l.email || '',
      _raw: l,
    };
  }
  function mapEmailRow(m) {
    const van = m.from_name || m.from_address || 'Onbekend';
    return {
      id: m.id,
      van,
      t: m.subject || '(geen onderwerp)',
      p: (m.snippet || '').slice(0, 120),
      tijd: _fmtTijd(m.date_received),
      nw: !m.is_read,
      kan: 'E-mail',
      ctx: m.from_address || '',
      _raw: m,
    };
  }
  function mapTicketRow(t) {
    return {
      id: t.id,
      van: t.creator_name || t.assignee_name || t.type || 'Ticket',
      t: t.title || '(geen titel)',
      p: (t.description || '').slice(0, 120),
      tijd: _fmtTijd(t.updated_at || t.created_at),
      nw: t.status === 'open',
      kan: 'Tickets',
      ctx: (t.priority || '') + (t.module ? ' · ' + t.module : ''),
      _raw: t,
    };
  }

  /* ── Thread reset (bij source- of item-wissel) ────────────────────── */
  function _resetThread() {
    _thread.loading = false;
    _thread.error = null;
    _thread.convId = null;
    _thread.src = null;
    _thread.items = [];
    _thread._paintedFor = null;
    _thread._markedFor = null;
  }

  /* ── Thread-fetch (WA / Lisa) ─────────────────────────────────────── */
  async function _loadThread(row, src) {
    const kind = (IB_SRC.find(x => x[0] === src) || [])[4];
    if (!row || !row.id) return;
    if (kind !== 'wa' && kind !== 'lisa') return; // deep-link kinds hebben geen thread
    // Bewaak per-conv: skip als al voor deze conv geladen is.
    if (_thread.convId === row.id && !_thread.error) return;
    _thread.loading = true;
    _thread.error = null;
    _thread.convId = row.id;
    _thread.src = src;
    _thread.items = [];
    _thread._paintedFor = null;
    if (window.DFO && window.DFO.render) window.DFO.render();

    const seq = ++_fetchSeq;
    let resp = null;
    if (kind === 'wa') {
      resp = await tryFetch('thread wa ' + row.id, '/api/inbox-messages-list?conversation_id=' + encodeURIComponent(row.id) + '&limit=200');
    } else if (kind === 'lisa') {
      resp = await tryFetch('thread lisa ' + row.id, '/api/lisa-conversations?id=' + encodeURIComponent(row.id));
    }
    if (seq !== _fetchSeq) return;
    if (_thread.convId !== row.id) return; // user is doorgeklikt naar andere conv

    if (!resp) {
      _thread.loading = false;
      _thread.error = 'Kon berichten niet laden';
      if (window.DFO && window.DFO.render) window.DFO.render();
      return;
    }

    if (kind === 'wa') {
      // items van inbox-messages-list: { id, direction, body, sent_at, created_at, ... }
      _thread.items = (resp.items || []).map(m => ({
        id: m.id,
        direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
        body: m.body || '',
        at: m.sent_at || m.created_at || null,
        meta: { status: m.status, template_name: m.template_name, media_url: m.media_url },
      }));
      // Mark-read fire-and-forget (1 poging, geen retry).
      _markReadOnce(row.id, src);
    } else if (kind === 'lisa') {
      // Lisa-response: { conversation, messages: [{ id, direction, content, sent_at, role }] }
      const msgs = resp.messages || resp.conversation?.messages || [];
      _thread.items = msgs.map(m => ({
        id: m.id,
        direction: (m.direction === 'outbound' || m.role === 'assistant') ? 'outbound' : 'inbound',
        body: m.content || m.body || '',
        at: m.sent_at || m.created_at || null,
        meta: { role: m.role },
      }));
    }
    _thread.loading = false;
    if (window.DFO && window.DFO.render) window.DFO.render();
  }

  /* ── Mark-read fire-and-forget (WA only) ──────────────────────────── */
  // BROK 1 bug 2 fix: bij succes-response reset unread lokaal + patch de
  // DOM van díe rij surgisch (verwijder .nw + het rose-stip-element).
  // Geen full render — behoudt scrollpositie in .ib-list.
  function _markReadOnce(conversationId, src) {
    if (!conversationId) return;
    if (_thread._markedFor === conversationId) return; // 1 poging per conv
    _thread._markedFor = conversationId;
    try {
      window.KV.authedFetch('/api/inbox-mark-read', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: conversationId }),
      }).then(async (r) => {
        if (!r.ok) { console.warn('[inbox-v2] mark-read HTTP', r.status); return; }
        // Lokale state: reset unread_count in _live.sources[src].items[X]
        // zodat srcCount() correct blijft bij re-render + toekomstige row-map.
        const srcKey = src || ibSrc;
        const s = _live.sources[srcKey];
        if (s && Array.isArray(s.items)) {
          const idx = s.items.findIndex(it => String(it.id) === String(conversationId));
          if (idx >= 0) {
            s.items[idx] = { ...s.items[idx], unread_count: 0 };
          }
        }
        // Surgische DOM-patch op de rij (geen full render → scroll blijft).
        try {
          const rowEl = document.querySelector('.ib-row[data-row-id="' + String(conversationId).replace(/"/g, '\\"') + '"]');
          if (rowEl) {
            rowEl.classList.remove('nw');
            // Rose-stip zit als laatste child in de tag-row; herken aan
            // background:var(--rose) inline-style-marker (uit renderRow).
            const dots = rowEl.querySelectorAll('span[style*="background:var(--rose)"]');
            dots.forEach(d => d.remove());
            // Van-label was font-weight:600 bij nw; die staat inline maar
            // valt niet in de weg — geen probleem als 'ie blijft. Volgende
            // re-render pikt de nieuwe unread_count=0 op via mapWaRow.
          }
        } catch (e) { /* fail-soft */ }
      }).catch(e => console.warn('[inbox-v2] mark-read fail:', e && e.message));
    } catch (e) {
      console.warn('[inbox-v2] mark-read setup fail:', e && e.message);
    }
  }

  /* ── Append-only thread paint ─────────────────────────────────────── */
  // Runt na elke render via queueMicrotask. Als de thread-container voor
  // deze conv al bestaat en items zijn nieuw → append de nieuwe onder-aan.
  // Als de conv is gewisseld → full rebuild + scroll naar onder.
  function _paintThread() {
    const container = document.getElementById('ibThreadScroll');
    if (!container) return; // detail-pane niet in DOM (bv. deep-link kind)
    if (!_thread.convId) { container.innerHTML = ''; return; }

    const isNewConv = _thread._paintedFor !== _thread.convId;
    if (isNewConv) {
      container.innerHTML = _thread.items.map(_renderMsgHtml).join('');
      _thread._paintedFor = _thread.convId;
      // Scroll naar onder (nieuwste onderaan).
      container.scrollTop = container.scrollHeight;
      return;
    }
    // Append-only: welke IDs staan er al?
    const seen = new Set();
    container.querySelectorAll('[data-msg-id]').forEach(el => seen.add(el.getAttribute('data-msg-id')));
    const additions = _thread.items.filter(m => !seen.has(String(m.id)));
    if (!additions.length) return;
    // Behoud scrollpositie tenzij user aan de onderkant hangt (autoscroll dan).
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 40;
    container.insertAdjacentHTML('beforeend', additions.map(_renderMsgHtml).join(''));
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }

  function _renderMsgHtml(m) {
    const isOut = m.direction === 'outbound';
    const at = m.at ? _fmtTijd(m.at) : '';
    const body = String(m.body || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const side = isOut ? 'flex-end' : 'flex-start';
    const bg = isOut ? 'var(--brand-soft,var(--surface-2))' : 'var(--surface-2)';
    const color = isOut ? 'var(--brand)' : 'var(--text-1)';
    const radius = isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px';
    return `<div data-msg-id="${String(m.id)}" style="display:flex;justify-content:${side};margin-bottom:8px">
      <div style="max-width:78%;padding:10px 14px;background:${bg};color:${color};border-radius:${radius};font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">
        ${body || '<span style="opacity:.55">(leeg bericht)</span>'}
        <div style="font-size:10.5px;opacity:.55;font-family:'IBM Plex Mono',monospace;margin-top:4px;text-align:right">${at}${m.meta?.template_name ? ' · template' : ''}</div>
      </div>
    </div>`;
  }

  /* ── VIEW ─────────────────────────────────────────────────────────── */
  function inboxView() {
    // Trigger bundle-fetch als nog niet geladen.
    if (!_live.fetched && !_live.loading) {
      queueMicrotask(() => fetchInboxBundle());
    }

    const totaal = IB_SRC.reduce((a, x) => a + (srcCount(x[0]) || 0), 0);
    const rows = currentRows();
    const q = (F('q', '') || '').toLowerCase();
    const filtered = q ? rows.filter(r => r.van.toLowerCase().includes(q) || (r.t || '').toLowerCase().includes(q)) : rows;
    const flOnlyNw = F('fl', 'all') === 'nw';
    const list = flOnlyNw ? filtered.filter(r => r.nw) : filtered;
    const c = list.find(r => r.id === ibSel) || list[0] || null;
    const srcInfo = IB_SRC.find(x => x[0] === ibSrc) || IB_SRC[0];
    const [, srcName, srcIc, srcCol, srcKind, srcMod] = srcInfo;

    // Trigger thread-load voor conversation-kinds (WA/Lisa) zodra er een
    // geselecteerde row is en de convId van _thread nog niet matcht.
    if (c && (srcKind === 'wa' || srcKind === 'lisa')) {
      if (_thread.convId !== c.id && !_thread.loading) {
        queueMicrotask(() => _loadThread(c, ibSrc));
      }
    }
    // Post-render paint van thread (append-only).
    queueMicrotask(_paintThread);
    // BROK 2: start live-refresh poll bij eerste render van de inbox-view.
    queueMicrotask(_startPollIfNeeded);

    return `
    <div class="ib-split">
      <div class="ib-rail">
        <button class="ib-src" onclick="__ibSetSrc('wb')" style="margin-bottom:4px" title="Alles = default source (Wanbetalers)">
          <span class="ic" style="background:var(--teal-soft);color:var(--teal)">${svg(I.inbox)}</span>
          <span style="flex:1">Alles</span><span class="n ${totaal ? '' : 'zero'}">${_live.loading && !_live.fetched ? '…' : totaal}</span></button>
        ${IB_GRP.map(([g, items]) => `
          <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:14px 9px 6px">${g}</div>
          ${items.map(([v, n, ic, col]) => {
            const cnt = srcCount(v);
            const disp = cnt == null ? (_live.loading ? '…' : '—') : srcCountDisplay(v, cnt);
            return `<button class="ib-src ${ibSrc === v ? 'on' : ''}" onclick="__ibSetSrc('${v}')">
              <span class="ic" style="background:var(--${col}-soft);color:var(--${col})">${svg(ic)}</span>
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}</span>
              <span class="n ${cnt ? '' : 'zero'}">${disp}</span></button>`;
          }).join('')}`).join('')}
        <div style="margin-top:16px;padding:11px 12px;background:var(--surface-2);border-radius:var(--r);font-size:11.5px;color:var(--text-3);line-height:1.5">
          Alles wat aandacht vraagt op één plek. Elk bericht blijft ook in zijn eigen module staan.</div>
        ${_live.error ? `<div style="margin-top:10px;padding:9px 11px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);font-size:11.5px;color:var(--rose)">⚠ ${_live.error}</div>` : ''}
      </div>

      <div class="ib-list">
        <div class="ib-top">
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
            <input placeholder="Zoek in ${srcName}…" value="${(F('q','') || '').replace(/"/g, '&quot;')}"
              oninput="S.filters[DFO.key()+'::q']=this.value;DFO.render();this.focus();this.setSelectionRange(this.value.length,this.value.length)"></div>
          <div style="display:flex;gap:6px;margin-top:9px;align-items:center">
            <button class="chip ${!flOnlyNw ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','all')">Alles</button>
            <button class="chip ${flOnlyNw ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','nw')">Nieuw</button>
            <span style="font-size:12px;color:var(--text-3);margin-left:auto">${_live.loading && !list.length ? 'laden…' : list.length + ' items'}</span></div>
        </div>
        ${_live.loading && !list.length
          ? renderSkeletonRows(6)
          : (list.map(i => renderRow(i, srcInfo)).join('') || `<div class="empty" style="padding:44px 20px"><div class="empty-t">Alles afgehandeld 🎉</div></div>`)}
      </div>

      ${c
        ? renderDetail(c, srcInfo)
        : `<div class="ib-detail"><div class="empty" style="margin:auto">
            <div class="empty-ico">${svg(I.inbox)}</div><div class="empty-t">Selecteer een item</div></div></div>`}
    </div>`;
  }

  /* ── Rij-renderer ─────────────────────────────────────────────────── */
  // BROK 1 bug 3 fix: escape ALLE user-strings (van/t/p) — anders breekt
  // een RFC 5322 e-mail-adres "Naam <x@y.nl>" of een subject met '<' de
  // hele row-markup en nested vervolgens 85 rijen in elkaar.
  // data-row-id gebruikt door __ibSel voor surgische highlight-swap.
  function renderRow(i, srcInfo) {
    const [, n, ic, col] = srcInfo;
    const rowIdAttr  = String(i.id).replace(/"/g, '&quot;');
    const rowIdClick = String(i.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<div class="ib-row ${i.nw ? 'nw' : ''} ${String(ibSel) === String(i.id) ? 'on' : ''}" data-row-id="${rowIdAttr}" onclick="__ibSel('${rowIdClick}')">
      ${H.av(String(i.van || '?'), 34)}
      <div class="ib-b">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:${i.nw ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(i.van)}</span>
          <span style="margin-left:auto;font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);flex-shrink:0">${_esc(i.tijd)}</span></div>
        <div class="ib-t">${_esc(i.t)}</div>
        <div class="ib-p">${_esc(i.p)}</div>
        <div style="margin-top:7px;display:flex;gap:6px;align-items:center">
          <span class="ib-src-tag" style="background:var(--${col}-soft);color:var(--${col})">${svg(ic, 'width:11px;height:11px')}${_esc(n)}</span>
          ${i.nw ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto"></span>' : ''}</div>
      </div></div>`;
  }

  /* ── Detail-renderer ──────────────────────────────────────────────── */
  function renderDetail(c, srcInfo) {
    const [, n, ic, col, kind, mod] = srcInfo;
    const modShort = String(n).split(/[ /]/)[0];
    const isWa = kind === 'wa';
    const raw = c._raw || {};
    // Koppel-banner: 'gekoppeld aan …' als de conv al een klant/attendee heeft.
    const linkedName = raw.customer
      ? (raw.customer.is_company ? raw.customer.company_name : [raw.customer.first_name, raw.customer.last_name].filter(Boolean).join(' '))
      : (raw.attendee ? [raw.attendee.first_name, raw.attendee.last_name].filter(Boolean).join(' ') : null);
    const linkedBadge = isWa
      ? (linkedName
          ? `<span style="font-size:11.5px;color:var(--emerald);background:var(--emerald-soft);padding:2px 8px;border-radius:12px">✓ gekoppeld: ${_esc(linkedName)}</span>`
          : `<span style="font-size:11.5px;color:var(--amber);background:var(--amber-soft);padding:2px 8px;border-radius:12px">⚠ niet gekoppeld</span>`)
      : '';
    const headerHtml = `
      <div style="padding:16px 22px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px;flex-wrap:wrap">
          <span class="ib-src-tag" style="background:var(--${col}-soft);color:var(--${col});font-size:11.5px;padding:3px 10px">
            ${svg(ic, 'width:12px;height:12px')}${_esc(n)}</span>
          <span class="pill pill-neutral nodot">${_esc(c.kan)}</span>
          <span style="font-size:12px;color:var(--text-3)">${_esc(c.tijd)}</span>
          ${linkedBadge}
          <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
            ${isWa ? `
              <button class="btn btn-ghost btn-sm" onclick="__ibLinkModal()" title="Koppel klant/aanmelding">${svg(I.users, 'width:13px;height:13px')} Koppel</button>
              <button class="btn btn-ghost btn-sm" onclick="__ibMarkUnread()" title="Markeer als ongelezen">${svg(I.mail, 'width:13px;height:13px')} Ongelezen</button>
              <button class="btn btn-ghost btn-sm" onclick="__ibSetStatus('afgehandeld')" title="Afhandelen (komt terug bij inbound)">${svg(I.check || I.clock, 'width:13px;height:13px')} Afhandelen</button>
              <button class="btn btn-ghost btn-sm" onclick="__ibSetStatus('gearchiveerd')" title="Archiveren (permanent uit lijst)">${svg(I.box, 'width:13px;height:13px')} Archief</button>
            ` : ''}
            <button class="btn btn-ghost btn-sm" onclick="__ibGoMod('${_esc(mod)}')">
              Open in ${_esc(modShort)} ${svg('<path d="m9 18 6-6-6-6"/>', 'width:13px;height:13px')}</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(String(c.van || '?'), 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.van)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(c.ctx)}</div>
          </div>
        </div>
      </div>`;

    // Body per source-kind
    let bodyHtml = '';
    if (kind === 'wa' || kind === 'lisa') {
      // Echte thread. Container blijft leeg; _paintThread vult 'm append-only.
      // NB: id="ibThreadScroll" wordt door _paintThread opgezocht.
      const status = _thread.loading
        ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Berichten laden…</div>`
        : _thread.error
          ? `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${_thread.error}</div>`
          : (!_thread.items.length && _thread.convId === c.id)
            ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Nog geen berichten in deze conversatie.</div>`
            : '';
      bodyHtml = `
        <div id="ibThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:22px;display:flex;flex-direction:column"></div>
        ${status}
        ${_renderCompose(kind)}`;
    } else if (kind === 'email') {
      // E-mail admin@/info@ — geen inline thread; deep-link naar E-mail-module.
      // BROK 1 bug 3: consistent _esc() gebruiken i.p.v. partial replace.
      const raw = c._raw || {};
      const hasAtt = !!raw.has_attachments;
      bodyHtml = `
        <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
          <div style="max-width:660px">
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">${_esc(raw.subject || '(geen onderwerp)')}</div>
            <div style="font-size:12.5px;color:var(--text-3);margin-bottom:16px">
              van <b>${_esc(raw.from_name || raw.from_address || '')}</b> · ${_esc(_fmtTijd(raw.date_received))}${hasAtt ? ' · 📎 bijlage' : ''}
            </div>
            <div style="padding:14px 18px;background:var(--surface-2);border-radius:14px 14px 14px 4px;font-size:14px;line-height:1.6;white-space:pre-wrap">${_esc(raw.snippet || '(geen preview)')}</div>
            <div style="margin-top:20px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12.5px;color:var(--text-3);line-height:1.55">
              Volledig bericht + reageren gebeurt in de <b>E-mail-module</b>. Klik hieronder om te openen.
            </div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" onclick="__ibGoMod('email')">Open in E-mail</button>
            </div>
          </div>
        </div>`;
    } else if (kind === 'tickets') {
      const raw = c._raw || {};
      bodyHtml = `
        <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
          <div style="max-width:660px">
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">${_esc(raw.title || '(geen titel)')}</div>
            <div style="font-size:12.5px;color:var(--text-3);margin-bottom:16px">
              ${_esc((raw.type || '').toUpperCase())} · ${_esc(raw.priority || '—')} · status <b>${_esc(raw.status || '?')}</b> · ${_esc(_fmtTijd(raw.updated_at || raw.created_at))}
            </div>
            <div style="padding:14px 18px;background:var(--surface-2);border-radius:var(--r);font-size:14px;line-height:1.6;white-space:pre-wrap">${_esc(raw.description || '(geen beschrijving)')}</div>
            <div style="margin-top:20px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12.5px;color:var(--text-3)">
              Comments + status wijzigen gebeurt in het ticket-detail. Klik hieronder om te openen.
            </div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" onclick="__ibGoMod('tickets')">Open in Tickets</button>
            </div>
          </div>
        </div>`;
    } else if (kind === 'leadsonderhoud') {
      const raw = c._raw || {};
      bodyHtml = `
        <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
          <div style="max-width:660px">
            <div style="font-size:15px;font-weight:600;margin-bottom:6px">${_esc(raw.naam || '(onbekend)')}</div>
            <div style="font-size:12.5px;color:var(--text-3);margin-bottom:16px">
              ${_esc(raw.email || '')}${raw.traject ? ' · traject: ' + _esc(raw.traject) : ''}${raw.status ? ' · ' + _esc(raw.status) : ''}
            </div>
            <div style="padding:14px 18px;background:var(--surface-2);border-radius:var(--r);font-size:14px;line-height:1.6">${_esc(raw.laatste_bericht_preview || raw.warmte_reden || '(geen preview)')}</div>
            <div style="margin-top:20px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12.5px;color:var(--text-3)">
              Volledige historie + acties in de Leadsonderhoud-module.
            </div>
            <div style="margin-top:14px;display:flex;gap:8px">
              <button class="btn btn-primary btn-sm" onclick="__ibGoMod('leadsonderhoud')">Open in Leadsonderhoud</button>
            </div>
          </div>
        </div>`;
    }

    return `<div class="ib-detail" style="display:flex;flex-direction:column;min-height:0">
      ${headerHtml}
      ${bodyHtml}
    </div>`;
  }

  /* ── Compose-block renderer (BROK 2) ──────────────────────────────── */
  // Uncontrolled textarea: oninput muteert alleen _compose.drafts, geen
  // render → focus + cursor blijven. Ctrl/Cmd+Enter = shortcut send.
  // Send-knop toont "Verzenden…" tijdens in-flight.
  function _renderCompose(kind) {
    const convId = _thread.convId;
    if (!convId) return '';
    const draft   = String(_compose.drafts[convId] || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const sending = _compose.sending === convId;
    const mode    = _compose.mode[convId] || 'text';
    const isLisa  = kind === 'lisa';
    const isWa    = kind === 'wa';

    // Bij template-mode: geen textarea, direct picker-knop.
    if (isWa && mode === 'template') {
      return `<div id="ibComposeBlock" style="padding:12px 22px;background:var(--surface);border-top:1px solid var(--border)">
        <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px;color:var(--amber);margin-bottom:10px">
          Buiten het 24u-venster — alleen goedgekeurde <b>templates</b> mogen verstuurd worden.
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="__ibTemplatePicker()" ${sending ? 'disabled' : ''}>
            ${sending ? 'Verzenden…' : 'Kies template'}
          </button>
          <button class="btn btn-ghost btn-sm" onclick="(function(){window.__ibResetMode && window.__ibResetMode();})()" title="Probeer alsnog vrije tekst (kan opnieuw op 24u falen)">Probeer tekst</button>
        </div>
      </div>`;
    }

    return `<div id="ibComposeBlock" style="padding:12px 22px;background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      <textarea
        placeholder="Typ een bericht… (Ctrl+Enter om te verzenden)"
        oninput="__ibDraftInput('${String(convId).replace(/'/g, "\\'")}', this.value)"
        onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();__ibSend();}"
        ${sending ? 'disabled' : ''}
        style="width:100%;min-height:70px;max-height:200px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13.5px;line-height:1.5;font-family:inherit;resize:vertical">${draft}</textarea>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${isWa ? `<button class="btn btn-ghost btn-sm" onclick="__ibQuickPicker()" ${sending ? 'disabled' : ''} title="Snel-antwoord invoegen">${svg(I.zap || I.list, 'width:13px;height:13px')} Snel</button>` : ''}
        ${isWa ? `<button class="btn btn-ghost btn-sm" onclick="__ibTemplatePicker()" ${sending ? 'disabled' : ''} title="Verstuur een goedgekeurde template">${svg(I.doc || I.mail, 'width:13px;height:13px')} Template</button>` : ''}
        <span style="font-size:11px;color:var(--text-3);margin-left:auto">${isLisa ? 'Lisa: mens neemt over (via GHL)' : (isWa ? 'WhatsApp — binnen 24u-venster' : '')}</span>
        <button class="btn btn-primary btn-sm" onclick="__ibSend()" ${sending ? 'disabled' : ''}>
          ${sending ? 'Verzenden…' : 'Verstuur'}
        </button>
      </div>
    </div>`;
  }
  // Handler voor "Probeer tekst" (mode reset).
  window.__ibResetMode = () => {
    const convId = _thread.convId;
    if (!convId) return;
    _compose.mode[convId] = 'text';
    _repaintCompose();
  };

  /* ── Live-refresh poll (BROK 2 punt 6) ────────────────────────────── */
  // 18s tick die (a) de source-tellers ververst en (b) de open thread
  // opnieuw ophaalt met append-only paint. Stop-conditie: als
  // #ibThreadScroll niet meer in DOM zit (module verlaten) → poll stopt
  // vanzelf. Ook op tab-hidden pauzeren om onnodige requests te vermijden.
  function _startPollIfNeeded() {
    if (_poll.handle) return;
    _poll.handle = setInterval(_pollTick, _poll.intervalMs);
  }
  function _stopPoll() {
    if (_poll.handle) { clearInterval(_poll.handle); _poll.handle = null; }
  }
  async function _pollTick() {
    if (_poll.running) return;
    // Stop-detect: als de inbox-view niet meer in DOM zit → kill poll.
    const inboxLive = !!document.querySelector('.ib-split');
    if (!inboxLive) { _stopPoll(); return; }
    if (document.hidden) return; // tab niet zichtbaar → skip
    _poll.running = true;
    try {
      // (a) Bundle refetch — zet fetched=false zodat fetchInboxBundle
      //     opnieuw draait; render-loop guard via _live.loading.
      _live.fetched = false;
      await fetchInboxBundle();
      // (b) Thread refetch (append-only via _paintThread).
      if (_thread.convId && _thread.src) {
        const kind = (IB_SRC.find(x => x[0] === _thread.src) || [])[4];
        if (kind === 'wa') {
          const resp = await tryFetch('poll-thread ' + _thread.convId, '/api/inbox-messages-list?conversation_id=' + encodeURIComponent(_thread.convId) + '&limit=200');
          if (resp && Array.isArray(resp.items) && _thread.convId) {
            const seen = new Set(_thread.items.map(m => String(m.id)));
            const additions = resp.items
              .filter(m => !seen.has(String(m.id)))
              .map(m => ({
                id: m.id,
                direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
                body: m.body || '',
                at: m.sent_at || m.created_at || null,
                meta: { status: m.status, template_name: m.template_name },
              }));
            if (additions.length) {
              _thread.items = _thread.items.concat(additions);
              _paintThread();
            }
          }
        }
        // Lisa: kan later dezelfde flow krijgen; skip nu (poll voor Lisa
        // is minder kritisch — GHL levert de outbound al terug bij intervene).
      }
    } catch (e) {
      console.warn('[inbox-v2] poll tick error:', e && e.message);
    } finally {
      _poll.running = false;
    }
  }

  /* ── Skeleton-rows tijdens initial load ───────────────────────────── */
  function renderSkeletonRows(n) {
    return Array.from({ length: n }).map(() => `
      <div class="ib-row" style="opacity:.55">
        <div class="avatar" style="width:34px;height:34px;background:var(--surface-2)"></div>
        <div class="ib-b">
          <div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:6px"></div>
          <div style="height:11px;background:var(--surface-2);border-radius:4px;width:85%;margin-bottom:5px"></div>
          <div style="height:10px;background:var(--surface-2);border-radius:4px;width:40%"></div>
        </div></div>`).join('');
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['inbox/'] = inboxView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('inbox');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('inbox');
  }

  console.debug('[inbox-v2] v=4 BROK 2 — write-flows live: inbox-send (text) + inbox-send-template (24u-fallback), Lisa intervene, quick-replies + template-picker, archief/heropen/mark-unread (surgische update), klant/attendee-koppeling (search-modal debounce), email-count total, 18s live-poll met stop-detect + hidden-pause.');
})();
