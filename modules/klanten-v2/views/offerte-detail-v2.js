// modules/klanten-v2/views/offerte-detail-v2.js
//
// V2 offerte-detail als NATIVE in-shell view binnen klanten-v2.
// Geen iframe — de detail-HTML rendert direct in de shell-content-area
// (net als dashboard-v2 / sales-v2 / leads-v2). Zo erft de view
// automatisch de bestaande .content { overflow-y: auto } scroll van
// de klanten-v2 shell — geen aparte scroll-container, geen vaste
// hoogte, geen postMessage-race-conditions.
//
// URL-contract (ongewijzigd): ?v2preview=sales&deal_id=<uuid>. Sales-v2
// offertes-view detecteert deal_id en delegeert naar deze module
// (window.__odvRender), die de skeleton returnt + lazy load() triggert.
//
// Navigatie:
//   - __odvOpen(dealId)  : pushState + goMod('sales') + goTab('Offertes')
//                          + DFO.render → mount native detail-view.
//   - __odvBack()        : pushState (strip deal_id) + DFO.render → terug
//                          naar offertes-lijst binnen dezelfde shell.
//   - __odvHandleNav(url): backwards-compat alias (was iframe-callback).
//                          Nu direct benaderbaar via window scope.
//
// Modals (send + onboarding) worden 1x body-gemount met #odv-modals-root
// zodat DFO.render() ze niet weghaalt (identiek aan sw-v2-root pattern
// in sales-wizard-v2.js).
//
// Verwijderd t.o.v. standalone HTML (per user-verzoek):
//   - "↻ Vernieuwen" knop (statische header)
//   - "↻ Ververs vanuit Teamleader" — WACHT, deze BLIJFT (per instructie).
//     Weg: alleen de generieke ↻ Vernieuwen.
//   - "↗ Open in TL" knop (dynamische actiebalk)
//   - "📅 Koppel aan historisch event" knop
//   - "👤 Klant-detail" knop in bovenste actiebalk
//   (De "Klant-detail →"-link ONDERIN het Klant-blok blijft staan.)

(function () {
  if (!window.DFO) { console.error('[odv-native] DFO shell niet geladen.'); return; }

  // ── Utilities ────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const eur = (v) => v == null ? '—' : '€' + Number(v).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

  // ── State ────────────────────────────────────────────────────────────────
  const _odv = {
    dealId: null,
    loading: false,
    error: null,
    data: null,          // { deal, customer, line_items, totals, entity, has_subscription, traject }
    seq: 0,
    // Onboarding-modal state (F0.2)
    obTrajecten: [],
    obTrajectenLoaded: false,
    obSelectedType: null, // '1op1' | 'membership' | null
  };
  const OB_TYPES = ['1op1', 'membership'];

  // Auth-fetch wrapper (dezelfde helper als in standalone HTML).
  async function apiFetch(url, init = {}) {
    const token = (window.AuthShared && (await window.AuthShared.getAccessToken())) || null;
    const headers = new Headers(init.headers || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (!headers.has('Content-Type') && init.body && !(init.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }
  async function apiJson(url, init = {}) {
    const r = await apiFetch(url, init);
    const text = await r.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!r.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + r.status);
    return data;
  }

  // Toast via body-mount (los van shell-toast om z-index niet te vervuilen).
  function _ensureToastEl() {
    let el = document.getElementById('odvToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'odvToast';
    el.className = 'odv-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
  }
  let _toastTimer = null;
  function toast(msg) {
    const el = _ensureToastEl();
    el.textContent = msg;
    el.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── Scoped CSS-injectie (1x per session) ────────────────────────────────
  // Zelfde tokens/kleuren als standalone HTML; puur .odv-* namespace zodat
  // klanten-v2 core niet vervuild raakt.
  function _ensureCss() {
    if (document.getElementById('odv-native-css')) return;
    const st = document.createElement('style');
    st.id = 'odv-native-css';
    st.textContent = `
      .odv-app { padding: 4px 4px 40px; }
      .odv-head {
        display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
        gap: 16px; margin: 4px 0 20px;
        padding-bottom: 16px; border-bottom: 1px solid var(--border, #E2E7EE);
      }
      .odv-head-l { flex: 1; min-width: 260px; }
      .odv-title { font-size: 22px; font-weight: 700; margin: 4px 0 6px; color: var(--text, #111721); }
      .odv-meta { font-size: 12.5px; color: var(--text-2, #586374); display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .odv-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; border: 1px solid; }
      .odv-badge-draft   { background: var(--surface-2, #F2F4F7); color: var(--text-2, #586374); border-color: var(--border, #E2E7EE); }
      .odv-badge-sent    { background: var(--blue-soft, #E8F0FC); color: var(--blue, #1B5FBF); border-color: var(--blue-line, #B7D0F2); }
      .odv-badge-accepted{ background: var(--emerald-soft, #E4F5EE); color: var(--emerald, #07835A); border-color: var(--emerald-line, #A9DFC9); }
      .odv-badge-declined{ background: var(--rose-soft, #FDECEE); color: var(--rose, #C22B3E); border-color: var(--rose-line, #F5C2C9); }
      .odv-badge-tl      { background: var(--teal-soft, #E2F3F8); color: var(--teal, #0A7490); border-color: var(--teal-line, #A5D8E8); }
      .odv-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }

      .odv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
      @media (max-width: 720px) { .odv-grid { grid-template-columns: 1fr; } }
      .odv-card {
        background: var(--surface, #FFFFFF);
        border: 1px solid var(--border-strong, #C9D2DE);
        border-radius: 10px;
        padding: 0;
        overflow: hidden;
      }
      .odv-card-h {
        padding: 10px 14px;
        background: var(--surface-2, #F2F4F7);
        border-bottom: 1px solid var(--border, #E2E7EE);
        font-size: 12px; font-weight: 700; color: var(--text, #111721);
        text-transform: uppercase; letter-spacing: .04em;
      }
      .odv-card-b { padding: 12px 14px; font-size: 13px; line-height: 1.55; color: var(--text, #111721); }
      .odv-row    { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; gap: 12px; }
      .odv-row .lbl { color: var(--text-2, #586374); }
      .odv-row a { color: var(--m, #6D3FD4); text-decoration: none; }
      .odv-row a:hover { text-decoration: underline; }

      .odv-tbl-wrap { overflow-x: auto; }
      .odv-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .odv-tbl th, .odv-tbl td { padding: 8px 12px; text-align: left; }
      .odv-tbl thead th {
        background: var(--surface-2, #F2F4F7); font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
        color: var(--text-2, #586374); border-bottom: 1px solid var(--border, #E2E7EE);
      }
      .odv-tbl tbody tr + tr td { border-top: 1px solid var(--border, #E2E7EE); }
      .odv-tbl .num    { text-align: right; }
      .odv-tbl .center { text-align: center; }

      .odv-total-big {
        display: flex; justify-content: space-between; align-items: center;
        background: var(--surface-2, #F2F4F7); padding: 10px 12px; border-radius: 8px; margin-top: 8px;
        font-weight: 700; font-size: 15px; color: var(--text, #111721);
      }

      .odv-sig-banner {
        background: var(--emerald-soft, #E4F5EE);
        border: 1px solid var(--emerald-line, #A9DFC9);
        border-radius: 10px;
        padding: 14px 18px;
        margin-bottom: 16px;
        display: flex; align-items: center; gap: 12px;
      }
      .odv-sig-banner b { color: var(--emerald, #07835A); font-size: 14px; }

      .odv-toast {
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: var(--text, #111721); color: var(--bg, #F7F8FA);
        padding: 10px 18px; border-radius: 8px; font-size: 13px;
        opacity: 0; pointer-events: none; transition: opacity .2s;
        z-index: 10000; max-width: 90vw;
      }
      .odv-toast.show { opacity: 1; }

      .odv-modal-back {
        position: fixed; inset: 0; background: rgba(17, 23, 33, .42); backdrop-filter: blur(3px);
        z-index: 9500; display: none; align-items: center; justify-content: center; padding: 24px;
      }
      .odv-modal-back.is-open { display: flex; }
      .odv-modal {
        width: 100%; max-width: 520px; max-height: calc(100vh - 48px);
        background: var(--surface, #FFFFFF); border-radius: var(--r-lg, 14px);
        box-shadow: 0 24px 48px rgba(0, 0, 0, .32);
        display: flex; flex-direction: column; overflow: hidden;
      }
      .odv-modal-head { padding: 13px 17px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 10px; background: var(--surface-2); }
      .odv-modal-title { font-size: 15px; font-weight: 600; color: var(--text); flex: 1; }
      .odv-modal-body { padding: 16px 18px; overflow-y: auto; }
      .odv-modal-foot { padding: 12px 17px; border-top: 1px solid var(--border); display: flex; gap: 8px; align-items: center; background: var(--surface-2); justify-content: flex-end; }

      .odv-mini-label { display: block; font-size: 11px; font-weight: 600; color: var(--text-2); margin: 10px 0 4px; text-transform: uppercase; letter-spacing: .04em; }
      .odv-read-only { padding: 8px 10px; background: var(--surface-2); border-radius: 6px; font-size: 12.5px; color: var(--text); }
      .odv-hint { font-size: 11.5px; color: var(--text-3); margin-top: 4px; line-height: 1.45; }
      .odv-err  { font-size: 12px; color: var(--rose, #C22B3E); margin-top: 8px; }

      /* Onboarding type-switch + success-blok (v1-parity). */
      .odv-type-switch { display: flex; gap: 0; margin-bottom: 14px; border: 1px solid var(--border, #E2E7EE); border-radius: 8px; padding: 3px; background: var(--surface-2, #F2F4F7); }
      .odv-type-switch button { flex: 1; padding: 8px 12px; font-size: 12.5px; font-weight: 600; border: 0; border-radius: 6px; background: transparent; color: var(--text-2, #586374); cursor: pointer; font-family: inherit; transition: background .12s, color .12s; }
      .odv-type-switch button:hover { color: var(--text, #111721); }
      .odv-type-switch button.is-active { background: #0a2f63; color: #fff; }
      .odv-ob-success {
        background: var(--emerald-soft, #E4F5EE);
        border: 1px solid var(--emerald-line, #A9DFC9);
        color: var(--emerald, #07835A);
        padding: 11px 13px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; line-height: 1.45;
      }
      .odv-ob-link-row { display: flex; gap: 8px; align-items: center; }
      .odv-ob-link-row .ib-input { flex: 1; font-family: 'IBM Plex Mono', monospace; font-size: 12px; }

      /* btn-danger/btn-success zijn niet in klanten-v2.css — voeg toe. */
      .btn-danger { background: var(--rose, #C22B3E); color: #fff; border-color: var(--rose, #C22B3E); }
      .btn-danger:hover { filter: brightness(1.08); }
      .btn-success { background: var(--emerald, #07835A); color: #fff; border-color: var(--emerald, #07835A); }
      .btn-success:hover { filter: brightness(1.08); }
    `;
    document.head.appendChild(st);
  }

  // ── Body-gemount modal-root (overleeft DFO.render #content-swap) ────────
  function _ensureModalsRoot() {
    if (document.getElementById('odv-modals-root')) return;
    _ensureCss();
    const root = document.createElement('div');
    root.id = 'odv-modals-root';
    root.innerHTML = `
      <!-- Verstuur-modal (v1-parity template-keuze). -->
      <div class="odv-modal-back" id="odvSendBack">
        <div class="odv-modal">
          <div class="odv-modal-head">
            <div class="odv-modal-title">Offerte versturen</div>
            <button class="icon-btn" onclick="odvSendClose()" title="Sluiten" aria-label="Sluiten">×</button>
          </div>
          <div class="odv-modal-body">
            <span class="odv-mini-label">Ontvanger</span>
            <div class="odv-read-only" id="odvSendRecipient">—</div>
            <span class="odv-mini-label" for="odvSendTemplate">E-mail template</span>
            <select id="odvSendTemplate" class="ib-input"><option value="">Standaard (instelling)</option></select>
            <div class="odv-hint" id="odvSendHint">Templates laden…</div>
            <div class="odv-err" id="odvSendErr" hidden></div>
          </div>
          <div class="odv-modal-foot">
            <button class="btn btn-ghost" onclick="odvSendClose()">Annuleren</button>
            <button class="btn btn-success" id="odvSendConfirmBtn" onclick="odvSendConfirm()">Verstuur nu</button>
          </div>
        </div>
      </div>

      <!-- Onboarding-modal (F0.2 v1 pariteit). -->
      <div class="odv-modal-back" id="odvObBack">
        <div class="odv-modal">
          <div class="odv-modal-head">
            <div class="odv-modal-title">Onboarding-traject aanmelden</div>
            <button class="icon-btn" onclick="obClose()" title="Sluiten" aria-label="Sluiten">×</button>
          </div>
          <div class="odv-modal-body" id="odvObBody">
            <div id="odvObForm">
              <span class="odv-mini-label">Klant</span>
              <div class="odv-read-only" id="odvObCust">—</div>
              <span class="odv-mini-label">Type begeleiding</span>
              <div class="odv-type-switch" id="odvObTypeSwitch" role="tablist" aria-label="Type begeleiding">
                <button type="button" role="tab" data-ob-type="1op1"       aria-selected="false">1-op-1 begeleiding</button>
                <button type="button" role="tab" data-ob-type="membership" aria-selected="false">Membership</button>
              </div>
              <span class="odv-mini-label" for="odvObTraject">Traject</span>
              <select id="odvObTraject" class="ib-input" disabled><option value="">Kies eerst een type</option></select>
              <span class="odv-mini-label" for="odvObStart">Startdatum</span>
              <input type="date" id="odvObStart" class="ib-input">
              <div class="odv-hint">Minimaal vandaag + 3 kalenderdagen. Vooringevuld uit de offerte (clamped naar het minimum). De looptijd in Bubble loopt vanaf deze datum — toegang start direct.</div>
              <div class="odv-err" id="odvObErr" hidden></div>
            </div>
            <div id="odvObDone" hidden></div>
          </div>
          <div class="odv-modal-foot" id="odvObFoot">
            <button class="btn btn-ghost" id="odvObCancelBtn" onclick="obClose()">Annuleren</button>
            <button class="btn btn-success" id="odvObSubmitBtn" onclick="obSubmit()" disabled>Aanmelden</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    // Wire type-switch klikken 1x (buttons zijn statisch binnen deze root).
    root.querySelectorAll('#odvObTypeSwitch button[data-ob-type]').forEach(b => {
      b.addEventListener('click', () => obSelectType(b.dataset.obType));
    });
    // Traject-select change → submit-btn enable.
    const trSel = document.getElementById('odvObTraject');
    if (trSel) trSel.addEventListener('change', (e) => {
      const sb = document.getElementById('odvObSubmitBtn');
      if (sb) sb.disabled = !e.target.value;
    });
    // Backdrop-click sluit (per modal).
    document.getElementById('odvSendBack').addEventListener('click', (e) => {
      if (e.target.id === 'odvSendBack') odvSendClose();
    });
    document.getElementById('odvObBack').addEventListener('click', (e) => {
      if (e.target.id === 'odvObBack') obClose();
    });
    // Esc sluit send-modal / onboarding-modal.
    if (!window._odvKeydownBound) {
      window._odvKeydownBound = true;
      window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const send = document.getElementById('odvSendBack');
        const ob   = document.getElementById('odvObBack');
        if (ob && ob.classList.contains('is-open')) { obClose(); return; }
        if (send && send.classList.contains('is-open')) { odvSendClose(); return; }
      });
    }
  }

  // ── Skeleton-view (returnt HTML voor #content) + lazy load-trigger ──────
  // Wordt aangeroepen vanuit sales-v2 offertesView() als er ?deal_id in URL
  // staat. Zorgt voor CSS-injectie + modal-mount + kickstart load() zodra
  // de HTML in de DOM staat.
  window.__odvRender = function (dealId) {
    const id = String(dealId || '').trim();
    if (!id) return `<div style="padding:24px;color:var(--rose,#C22B3E)">Geen offerte-id in URL.</div>`;

    _ensureCss();
    _ensureModalsRoot();

    // Detecteer of dealId veranderd is — trigger dan (opnieuw) een load.
    // Anders re-rendert offertesView vanuit stale data van vorige fetch.
    if (_odv.dealId !== id) {
      _odv.dealId = id;
      _odv.data = null;
      _odv.error = null;
      queueMicrotask(() => _odvLoad(id));
    } else if (!_odv.loading && !_odv.data && !_odv.error) {
      queueMicrotask(() => _odvLoad(id));
    }

    // Als data al geladen: render 'em direct. Anders skeleton + statische
    // header met "Ververs vanuit TL"-knop (BEHOUDEN per user-instructie).
    const bodyHtml = _odv.data
      ? _odvRenderBody(_odv.data)
      : (_odv.error
        ? `<div class="odv-card"><div class="odv-card-b" style="color:var(--rose,#C22B3E)">Kon offerte niet laden: ${esc(_odv.error)}</div></div>`
        : `<div class="odv-card"><div class="odv-card-b" style="color:var(--text-2)">Laden…</div></div>`);

    const headerHtml = _odv.data
      ? _odvRenderHeader(_odv.data)
      : `<div class="odv-head"><div class="odv-head-l">
          <h1 class="odv-title">Offerte laden…</h1>
          <div class="odv-meta"></div>
        </div>
        <div class="odv-actions">
          <button class="btn btn-ghost" onclick="__odvDoTLSync()" title="Haal live status uit Teamleader (checkt of klant getekend heeft)">↻ Ververs vanuit Teamleader</button>
        </div></div>`;

    const sigHtml = _odv.data ? _odvRenderSigBanner(_odv.data) : '';

    return `<div class="odv-app">
      ${headerHtml}
      ${sigHtml}
      ${bodyHtml}
    </div>`;
  };

  // ── Header (title + status-badges + statische acties) ────────────────────
  function _odvRenderHeader(d) {
    const deal = d.deal || {};
    const st = deal.tl_quotation_status || 'draft';
    const stMap = {
      draft:     { l: 'Concept',       cls: 'odv-badge-draft' },
      sent:      { l: 'Verzonden',     cls: 'odv-badge-sent' },
      accepted:  { l: 'Getekend',      cls: 'odv-badge-accepted' },
      signed:    { l: 'Getekend',      cls: 'odv-badge-accepted' },
      declined:  { l: 'Afgewezen',     cls: 'odv-badge-declined' },
      expired:   { l: 'Verlopen',      cls: 'odv-badge-draft' },
    };
    const sb = stMap[st] || stMap.draft;
    const title = (d.traject?.label) || `Offerte ${String(deal.id).slice(0, 8)}`;
    const offNr = deal.quote_reference || ('#' + String(deal.id).slice(0, 8));

    const metaParts = [];
    metaParts.push(`<span class="odv-badge ${sb.cls}">${sb.l}</span>`);
    if (deal.tl_quotation_id) metaParts.push(`<span class="odv-badge odv-badge-tl">TL-gekoppeld</span>`);
    metaParts.push(`<span>${esc(offNr)}</span>`);
    metaParts.push(`<span>· Aangemaakt ${esc(fmtDate(deal.created_at))}</span>`);
    if (deal.tl_quotation_accepted_at) metaParts.push(`<span>· Getekend ${esc(fmtDate(deal.tl_quotation_accepted_at))}</span>`);

    return `<div class="odv-head">
      <div class="odv-head-l">
        <h1 class="odv-title">${esc(title)}</h1>
        <div class="odv-meta">${metaParts.join(' ')}</div>
      </div>
      <div class="odv-actions">
        <button class="btn btn-ghost" onclick="__odvDoTLSync()" title="Haal live status uit Teamleader (checkt of klant getekend heeft)">↻ Ververs vanuit Teamleader</button>
        ${_odvRenderDynamicActions(d)}
      </div>
    </div>`;
  }

  // ── Signature-banner (bovenaan, alleen bij accepted/signed) ─────────────
  function _odvRenderSigBanner(d) {
    const deal = d.deal || {};
    const st = deal.tl_quotation_status || 'draft';
    if (st !== 'accepted' && st !== 'signed') return '';
    return `<div class="odv-sig-banner">
      <div style="font-size:24px">✓</div>
      <div>
        <b>Klant heeft getekend</b>
        <div style="font-size:12px;color:var(--text-2);margin-top:2px">${deal.tl_quotation_accepted_at ? 'Op ' + esc(fmtDate(deal.tl_quotation_accepted_at)) : 'Datum onbekend'} · Klaar voor omzetting naar abonnement + onboarding.</div>
      </div>
    </div>`;
  }

  // ── Dynamische acties per status ─────────────────────────────────────────
  // VERWIJDERD (per user-instructie):
  //   - "↗ Open in TL" (tlBtn)
  //   - "📅 Koppel aan historisch event" (histEvBtn)
  //   - "👤 Klant-detail" bovenaan (custBtn)
  //     De "Klant-detail →"-link ONDERIN het Klant-blok blijft (zie card).
  function _odvRenderDynamicActions(d) {
    const deal = d.deal || {};
    const c = d.customer || {};
    const hasSub = !!d.has_subscription;
    const st = deal.tl_quotation_status || 'draft';

    const copyBtn = `<button class="btn btn-ghost" onclick="__odvDoCopy()" title="Maak een verse concept-offerte met dezelfde gegevens">📋 Kopiëren</button>`;

    if (st === 'accepted' || st === 'signed') {
      const convLabel = hasSub ? '✓ Abbo al ingevoerd' : 'Omzetten naar abonnement';
      const convClass = hasSub ? 'btn' : 'btn btn-success';
      const convTitle = hasSub ? 'Er bestaat al een abonnement voor deze offerte. Klik om (opnieuw) om te zetten.' : '';
      // V2 in-shell wizard (2026-08-12); fallback naar v1 als handler niet geladen.
      const convertBtn = `<a class="${convClass}" href="javascript:void(0)" onclick="if(window.__subwOpen){window.__subwOpen({dealId:'${esc(deal.id)}'})}else{window.location.href='/modules/subscription-wizard.html?deal_id=${encodeURIComponent(deal.id)}'}"${convTitle ? ` title="${esc(convTitle)}"` : ''}>${convLabel}</a>`;
      const onboardBtn = c.id
        ? `<button class="btn" style="background:#0a2f63;color:#fff" onclick="obOpen()" title="Onboarding-traject aanmelden (F0.2 modal)">📋 Onboarding aanmelden</button>`
        : '';
      return `${convertBtn} ${onboardBtn} ${copyBtn}`;
    }
    if (st === 'sent') {
      // Bewerken bij 'sent' — DIVERGENTIE van v1 op expliciet verzoek van
      // Jeffrey (2026-08-11). v1 offerte-detail.html:401-403 toont Bewerken
      // alleen in de 'draft'-branch. Rationale: Jeffrey wil ook een
      // reeds-verzonden (maar nog-niet-getekende) offerte kunnen aanpassen.
      // Server-side is dat veilig: api/sales-deal-update.js blokkeert alleen
      // 'accepted'/'signed' (SALES_DEAL_SIGNED, r38-48). Wijzigingen aan
      // een deal met tl_quotation_id blijven LOKAAL (tl_sync_skipped:true,
      // r145-149) — TL-quotation wordt NIET auto-geüpdatet; volgende
      // 'Opnieuw versturen' triggert de update naar de klant. Zelfde
      // gedrag als v1 sales-deal-update.
      return `<button class="btn" onclick="odvSendOpen()">Opnieuw versturen</button>
        <button class="btn" style="background:var(--amber, #C2700A);color:#fff" onclick="__odvDoMarkAccepted()">Markeer als getekend</button>
        <button class="btn btn-ghost" onclick="__odvEditDeal('${esc(deal.id)}')" title="Bewerken in v2-wizard (wijzigingen lokaal — TL-quotation niet auto-geüpdatet)">Bewerken</button>
        ${copyBtn}
        <button class="btn btn-danger" onclick="__odvDoDelete()">Verwijderen</button>`;
    }
    if (st === 'draft') {
      const sendOrPush = deal.tl_quotation_id
        ? `<button class="btn btn-success" onclick="odvSendOpen()">Versturen</button>`
        : `<button class="btn" onclick="__odvDoPush()">Push naar TL</button>`;
      return `${sendOrPush}
        <button class="btn btn-ghost" onclick="__odvEditDeal('${esc(deal.id)}')" title="Bewerken in v2-wizard (in-shell)">Bewerken</button>
        ${copyBtn}
        <button class="btn btn-danger" onclick="__odvDoDelete()">Verwijderen</button>`;
    }
    // declined / expired / other
    return `${copyBtn}`;
  }

  // ── Body (cards + producten-tabel + totalen + betalingsvoorwaarden) ─────
  function _odvRenderBody(d) {
    const deal = d.deal || {};
    const c = d.customer || {};
    const lines = d.line_items || [];
    const t = d.totals || {};
    const entity = d.entity || '';

    const disc = Number(deal.discount_percentage) || 0;
    const factor = 1 - disc / 100;
    const zeroVat = deal.sale_type && deal.sale_type !== 'domestic';
    const btwByRate = {};
    for (const l of lines) {
      const rate = zeroVat ? 0 : (Number(l.vat_percentage) || 0);
      const base = Number(l.quantity) * Number(l.unit_price);
      const lineExcl = (l.price_includes_vat && rate > 0 ? base / (1 + rate / 100) : base) * factor;
      if (rate > 0) btwByRate[rate] = (btwByRate[rate] || 0) + lineExcl * rate / 100;
    }

    const pay = [];
    if (deal.payment_downpayment_amount) pay.push(['Aanbetaling', `${eur(deal.payment_downpayment_amount)}${deal.payment_downpayment_date ? ' op ' + fmtDate(deal.payment_downpayment_date) : ''}`]);
    if (deal.payment_term_count)         pay.push(['Termijnen', `${deal.payment_term_count}× ${deal.payment_term_amount ? eur(deal.payment_term_amount) + ' incl.' : ''}`]);
    if (deal.payment_term_start_date)    pay.push(['1e termijn', fmtDate(deal.payment_term_start_date)]);
    if (deal.payment_start_date)         pay.push(['Startdatum cursus', fmtDate(deal.payment_start_date)]);

    const custName = c.is_company ? (c.company_name || '—') : `${c.first_name || ''} ${c.last_name || ''}`.trim() || '—';

    return `
      <div class="odv-grid">
        <div class="odv-card">
          <div class="odv-card-h">Klant</div>
          <div class="odv-card-b">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px">${esc(custName)}${c.is_company ? ' <span class="odv-badge odv-badge-tl">Bedrijf</span>' : ''}</div>
            <div class="odv-row"><span class="lbl">Entiteit</span><span>${esc(entity || '—')}</span></div>
            <div class="odv-row"><span class="lbl">E-mail</span><span>${c.email ? `<a href="mailto:${encodeURIComponent(c.email)}">${esc(c.email)}</a>` : '—'}</span></div>
            <div class="odv-row"><span class="lbl">Telefoon</span><span>${c.phone ? `<a href="tel:${encodeURIComponent(c.phone)}">${esc(c.phone)}</a>` : '—'}</span></div>
            ${c.id ? `<div style="margin-top:10px"><a class="btn btn-ghost" href="/modules/klanten.html?id=${encodeURIComponent(c.id)}" target="_blank" rel="noopener">Klant-detail →</a></div>` : ''}
          </div>
        </div>
        <div class="odv-card">
          <div class="odv-card-h">Offerte-info</div>
          <div class="odv-card-b">
            <div class="odv-row"><span class="lbl">Entiteit</span><span>${esc(entity || '—')}</span></div>
            <div class="odv-row"><span class="lbl">Type verkoop</span><span>${esc(deal.sale_type === 'intracommunautair' ? 'Intracommunautair' : (deal.sale_type === 'outside_eu' ? 'Buiten EU' : 'Normaal NL/BE'))}</span></div>
            <div class="odv-row"><span class="lbl">Looptijd</span><span>${deal.duration_months ? deal.duration_months + ' mnd' : '—'}</span></div>
            <div class="odv-row"><span class="lbl">Startdatum cursus</span><span>${esc(fmtDate(deal.payment_start_date || deal.start_date))}</span></div>
          </div>
        </div>
      </div>

      <div class="odv-card" style="margin-bottom:14px">
        <div class="odv-card-h">Producten (${lines.length} regel${lines.length === 1 ? '' : 's'})</div>
        <div class="odv-tbl-wrap">
          <table class="odv-tbl">
            <thead><tr>
              <th>Product</th><th class="center">Aantal</th><th class="num">Prijs/stuk excl.</th>
              <th class="center">BTW</th><th class="num">Subtotaal excl.</th><th class="num">Incl. BTW</th>
            </tr></thead>
            <tbody>${lines.map(l => {
              const rate = zeroVat ? 0 : (Number(l.vat_percentage) || 0);
              const base = Number(l.quantity) * Number(l.unit_price);
              const unitExcl = l.price_includes_vat && rate > 0 ? Number(l.unit_price) / (1 + rate / 100) : Number(l.unit_price);
              const subExcl = l.price_includes_vat && rate > 0 ? base / (1 + rate / 100) : base;
              const incl = subExcl * (1 + rate / 100);
              return `<tr>
                <td>${esc(l.product_name)}</td>
                <td class="center">${l.quantity}×</td>
                <td class="num">${eur(unitExcl)}</td>
                <td class="center"><span class="odv-badge ${rate === 0 ? 'odv-badge-accepted' : (rate === 9 ? 'odv-badge-tl' : 'odv-badge-sent')}">${rate}%</span></td>
                <td class="num">${eur(subExcl)}</td>
                <td class="num"><b>${eur(incl)}</b></td>
              </tr>`;
            }).join('') || '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:20px">Geen regels</td></tr>'}</tbody>
          </table>
        </div>
      </div>

      <div class="odv-grid" style="grid-template-columns:1fr 1fr">
        <div class="odv-card">
          <div class="odv-card-h">Totalen</div>
          <div class="odv-card-b">
            <div class="odv-row"><span class="lbl">Subtotaal excl. BTW</span><span>${eur(t.excl)}</span></div>
            ${disc > 0 ? `<div class="odv-row" style="color:var(--rose)"><span class="lbl">Korting</span><span>−${disc}%</span></div>` : ''}
            ${Object.keys(btwByRate).sort((a, b) => Number(b) - Number(a)).map(r => `<div class="odv-row"><span class="lbl">BTW ${r}%</span><span>${eur(btwByRate[r])}</span></div>`).join('')}
            <div class="odv-total-big"><span>Totaal incl. BTW</span><span>${eur(t.incl)}</span></div>
          </div>
        </div>
        <div class="odv-card">
          <div class="odv-card-h">Betalingsvoorwaarden</div>
          <div class="odv-card-b">
            ${pay.length ? pay.map(p => `<div class="odv-row"><span class="lbl">${esc(p[0])}</span><span>${esc(p[1])}</span></div>`).join('') : '<div style="color:var(--text-3);font-size:12.5px">Geen betalingsschema — alleen totaalbedrag.</div>'}
          </div>
        </div>
      </div>
    `;
  }

  // ── Fetch (lazy, met sequence-tracking tegen race-condities) ────────────
  async function _odvLoad(id) {
    if (_odv.loading) return;
    const seq = ++_odv.seq;
    _odv.loading = true; _odv.error = null;
    try {
      const d = await apiJson('/api/sales-deal-detail?id=' + encodeURIComponent(id));
      if (seq !== _odv.seq) return; // stale
      _odv.data = d;
    } catch (e) {
      if (seq !== _odv.seq) return;
      _odv.error = e?.message || 'load failed';
      console.warn('[odv-native] load fail:', _odv.error);
    } finally {
      if (seq === _odv.seq) _odv.loading = false;
      try { window.DFO.render(); } catch (_) {}
    }
  }

  // ── Actie-handlers (identiek aan standalone HTML, 1-op-1 endpoints) ─────
  window.__odvDoTLSync = async function () {
    if (!_odv.dealId) return;
    toast('TL-status ophalen…');
    try {
      const r = await apiFetch('/api/sales-deal-sync-status', {
        method: 'POST', body: JSON.stringify({ deal_id: _odv.dealId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) toast('Sync mislukt: ' + (d?.error || ('HTTP ' + r.status)));
      else if (d?.updated > 0) toast('Status bijgewerkt uit Teamleader.');
      else toast('Status ongewijzigd.');
    } catch (e) {
      toast('Sync mislukt: ' + (e?.message || e));
    } finally {
      _odv.data = null; // force re-fetch
      _odv.error = null;
      _odvLoad(_odv.dealId);
    }
  };

  window.__odvDoMarkAccepted = async function () {
    if (!_odv.dealId) return;
    if (!confirm('Markeert deze offerte handmatig als getekend (gebruik vóór de TL-webhook actief is). Doorgaan?')) return;
    try {
      await apiJson('/api/sales-quotation-mark-accepted', { method: 'POST', body: JSON.stringify({ deal_id: _odv.dealId }) });
      toast('Gemarkeerd als getekend');
      _odv.data = null; _odv.error = null; _odvLoad(_odv.dealId);
    } catch (e) { toast('Actie mislukt: ' + e.message); }
  };

  window.__odvDoPush = async function () {
    if (!_odv.dealId) return;
    try { window.__swLog && window.__swLog('odv-push:start', { deal_id: _odv.dealId }); } catch (_) {}
    try {
      const resp = await apiJson('/api/sales-deal-retry-push', { method: 'POST', body: JSON.stringify({ deal_id: _odv.dealId }) });
      try { window.__swLog && window.__swLog('odv-push:parsed-ok', { success: resp?.success, tl_status: resp?.tl_quotation_status || null }); } catch (_) {}
      toast('Naar TeamLeader gepusht');
      _odv.data = null; _odv.error = null; _odvLoad(_odv.dealId);
    } catch (e) {
      try { window.__swLog && window.__swLog('odv-push:error', { msg: e?.message || String(e) }); } catch (_) {}
      toast('Push mislukt: ' + e.message);
    }
  };

  window.__odvDoCopy = async function () {
    if (!_odv.dealId) return;
    try {
      const d = await apiJson('/api/sales-deal-copy', { method: 'POST', body: JSON.stringify({ source_deal_id: _odv.dealId }) });
      toast('Gekopieerd — nieuwe concept-offerte aangemaakt');
      if (d?.deal_id) setTimeout(() => window.__odvOpen(d.deal_id), 800);
    } catch (e) { toast('Kopiëren mislukt: ' + e.message); }
  };

  // Bewerken (batch2b Feature B): open v2-wizard in-shell in edit-mode.
  // Fallback naar oude wizard-html als sales-wizard-v2.js niet geladen is
  // (defensive; script normaal via klanten-v2/index.html geladen).
  window.__odvEditDeal = function (dealId) {
    const id = String(dealId || _odv.dealId || '').trim();
    if (!id) return;
    if (typeof window.__swOpen === 'function') {
      window.__swOpen({ editDealId: id });
      return;
    }
    window.location.href = '/modules/sales-wizard.html?edit_deal_id=' + encodeURIComponent(id);
  };

  window.__odvDoDelete = async function () {
    if (!_odv.dealId) return;
    if (!confirm('Offerte verwijderen? Dit trekt hem ook in TeamLeader in (indien gekoppeld). Kan niet ongedaan gemaakt worden.')) return;
    try {
      await apiJson('/api/teamleader-delete-quotation', { method: 'POST', body: JSON.stringify({ deal_id: _odv.dealId }) });
      toast('Offerte verwijderd');
      setTimeout(() => window.__odvBack(), 700);
    } catch (e) { toast('Verwijderen mislukt: ' + e.message); }
  };

  // ── Verstuur-modal (template-keuze) ─────────────────────────────────────
  window.odvSendOpen = async function () {
    _ensureModalsRoot();
    const back = document.getElementById('odvSendBack');
    const recip = document.getElementById('odvSendRecipient');
    const sel = document.getElementById('odvSendTemplate');
    const hint = document.getElementById('odvSendHint');
    const errEl = document.getElementById('odvSendErr');
    errEl.hidden = true; errEl.textContent = '';
    const cust = _odv.data?.customer || {};
    recip.textContent = (cust.email || '(geen e-mail — vul eerst in klant-detail)');
    sel.innerHTML = '<option value="">Standaard (instelling)</option>';
    hint.textContent = 'Templates laden…';
    back.classList.add('is-open');
    try {
      const r = await apiFetch('/api/teamleader-email-templates?type=quotation');
      const d = await r.json();
      const list = Array.isArray(d?.templates) ? d.templates : [];
      if (list.length) {
        const opts = list.map(t => `<option value="${esc(t.id)}">${esc(t.name || t.title || t.id)}</option>`).join('');
        sel.innerHTML = '<option value="">Standaard (instelling)</option>' + opts;
        // Voorselectie 'Offerte verzenden DFO'.
        const auto = list.find(t => String(t.name || t.title || '').toLowerCase().startsWith('offerte verzenden dfo'));
        if (auto) sel.value = auto.id;
        hint.textContent = 'Kies template of gebruik standaard.';
      } else {
        hint.textContent = 'Geen custom templates — standaard TL-template wordt gebruikt.';
      }
    } catch (e) {
      hint.textContent = 'Templates niet geladen (' + esc(e.message) + '). Standaard TL-template wordt gebruikt.';
    }
  };
  window.odvSendClose = function () {
    const el = document.getElementById('odvSendBack');
    if (el) el.classList.remove('is-open');
  };
  window.odvSendConfirm = async function () {
    if (!_odv.dealId) return;
    const btn = document.getElementById('odvSendConfirmBtn');
    const errEl = document.getElementById('odvSendErr');
    const templateId = document.getElementById('odvSendTemplate').value || null;
    btn.disabled = true; btn.textContent = 'Verzenden…'; errEl.hidden = true;
    try {
      await apiJson('/api/teamleader-send-quotation', {
        method: 'POST',
        body: JSON.stringify({ deal_id: _odv.dealId, template_id: templateId || undefined }),
      });
      const cust = _odv.data?.customer || {};
      toast('Offerte verzonden naar ' + (cust.email || 'klant'));
      odvSendClose();
      _odv.data = null; _odv.error = null; _odvLoad(_odv.dealId);
    } catch (e) {
      errEl.textContent = 'Verzenden mislukt: ' + e.message;
      errEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Verstuur nu';
    }
  };

  // ── F0.2 Onboarding-modal (1-op-1 v1 pariteit) ──────────────────────────
  function obMinStartNL() {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' });
    const s = fmt.format(new Date());
    const [y, m, d] = s.split('-').map(x => parseInt(x, 10));
    const anchor = new Date(Date.UTC(y, m - 1, d));
    anchor.setUTCDate(anchor.getUTCDate() + 3);
    return `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, '0')}-${String(anchor.getUTCDate()).padStart(2, '0')}`;
  }
  function obTypeSwitchRender() {
    const sw = document.getElementById('odvObTypeSwitch');
    if (!sw) return;
    sw.querySelectorAll('button[data-ob-type]').forEach(b => {
      const active = b.dataset.obType === _odv.obSelectedType;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
  }
  function obTrajectOptsRender() {
    const sel = document.getElementById('odvObTraject');
    const sb  = document.getElementById('odvObSubmitBtn');
    if (!sel) return;
    if (sb) sb.disabled = true;
    if (!_odv.obSelectedType) {
      sel.disabled = true;
      sel.innerHTML = '<option value="">Kies eerst een type</option>';
      return;
    }
    if (!_odv.obTrajectenLoaded) {
      sel.disabled = true;
      sel.innerHTML = '<option value="">Trajecten laden…</option>';
      return;
    }
    const filtered = _odv.obTrajecten.filter(t => t && t.type === _odv.obSelectedType);
    if (!filtered.length) {
      sel.disabled = true;
      sel.innerHTML = '<option value="">Geen trajecten voor dit type</option>';
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">— kies traject —</option>' +
      filtered.map(t => `<option value="${esc(t.id)}">${esc(t.label || t.key || t.id)}</option>`).join('');
    sel.value = '';
  }
  function obSelectType(type) {
    if (!OB_TYPES.includes(type)) return;
    if (_odv.obSelectedType === type) return;
    _odv.obSelectedType = type;
    obTypeSwitchRender();
    obTrajectOptsRender();
  }
  async function obEnsureTrajecten() {
    if (_odv.obTrajectenLoaded) return;
    try {
      const d = await apiJson('/api/onboarding-trajecten-list');
      _odv.obTrajecten = Array.isArray(d?.trajecten) ? d.trajecten : [];
      _odv.obTrajectenLoaded = true;
      obTrajectOptsRender();
    } catch (e) {
      const sel = document.getElementById('odvObTraject');
      if (sel) sel.innerHTML = '<option value="">Laden mislukt</option>';
      const err = document.getElementById('odvObErr');
      if (err) {
        err.textContent = 'Trajecten ophalen mislukt: ' + (e?.message || e);
        err.hidden = false;
      }
    }
  }
  function obReset() {
    document.getElementById('odvObForm').hidden = false;
    document.getElementById('odvObDone').hidden = true;
    document.getElementById('odvObDone').innerHTML = '';
    document.getElementById('odvObErr').hidden = true;
    document.getElementById('odvObErr').textContent = '';
    document.getElementById('odvObFoot').style.display = '';
    const sb = document.getElementById('odvObSubmitBtn');
    sb.disabled = true; sb.textContent = 'Aanmelden'; sb.style.display = '';
    document.getElementById('odvObCancelBtn').textContent = 'Annuleren';
    _odv.obSelectedType = null;
    obTypeSwitchRender();
    obTrajectOptsRender();
    const dt = document.getElementById('odvObStart');
    if (dt) dt.value = '';
  }
  window.obOpen = function () {
    _ensureModalsRoot();
    const cust = _odv.data?.customer || {};
    const deal = _odv.data?.deal || {};
    if (!cust.id) { toast('Geen klant-id beschikbaar'); return; }
    obReset();
    document.getElementById('odvObCust').textContent = (cust.is_company ? (cust.company_name || '') : `${cust.first_name || ''} ${cust.last_name || ''}`.trim()) || cust.id;
    // Startdatum-prefill uit offerte (clamp naar minimum).
    const dt = document.getElementById('odvObStart');
    const min = obMinStartNL();
    if (dt) {
      dt.min = min;
      const rawStart = deal.payment_start_date || deal.start_date || null;
      const prefill = (typeof rawStart === 'string' && rawStart) ? rawStart.slice(0, 10) : null;
      dt.value = (prefill && prefill >= min) ? prefill : min;
    }
    document.getElementById('odvObBack').classList.add('is-open');
    obEnsureTrajecten();
  };
  window.obClose = function () {
    const el = document.getElementById('odvObBack');
    if (el) el.classList.remove('is-open');
  };
  window.obSubmit = async function () {
    const sel = document.getElementById('odvObTraject');
    const sb  = document.getElementById('odvObSubmitBtn');
    const trajectId = (sel.value || '').trim();
    const cust = _odv.data?.customer || {};
    if (!cust.id || !trajectId) return;
    document.getElementById('odvObErr').hidden = true;
    sb.disabled = true; sb.textContent = 'Bezig…';
    const dt = document.getElementById('odvObStart');
    const startDate = dt && dt.value ? dt.value : null;
    if (startDate) {
      const min = obMinStartNL();
      if (startDate < min) {
        const err = document.getElementById('odvObErr');
        err.textContent = 'Startdatum moet minimaal 3 kalenderdagen in de toekomst liggen (vanaf ' + min + ').';
        err.hidden = false;
        sb.disabled = false; sb.textContent = 'Aanmelden';
        return;
      }
    }
    const payload = { customer_id: cust.id, traject_id: trajectId };
    if (startDate) payload.start_date = startDate;
    payload.lms_provision = false;
    try {
      const r = await apiFetch('/api/onboarding-create', {
        method: 'POST', body: JSON.stringify(payload),
      });
      let d = null; try { d = await r.json(); } catch (_) {}
      if (r.status === 409) {
        const err = document.getElementById('odvObErr');
        err.textContent = 'Er bestaat al een (actieve) onboarding voor deze klant.';
        err.hidden = false;
        sb.disabled = false; sb.textContent = 'Aanmelden';
        return;
      }
      if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
      const linkPath = d?.link || '';
      const fullLink = linkPath ? (location.origin + linkPath) : '';
      const done = document.getElementById('odvObDone');
      done.innerHTML = `
        <div class="odv-ob-success">
          <strong>✓ Aangemeld.</strong> De persoonlijke onboarding-link is hieronder kopieerbaar.
        </div>
        <span class="odv-mini-label">Persoonlijke link</span>
        <div class="odv-ob-link-row">
          <input type="text" class="ib-input" id="odvObLinkInp" readonly value="${esc(fullLink)}">
          <button type="button" class="btn" id="odvObCopyBtn">📋 Kopieer</button>
        </div>
        <div class="odv-hint" style="margin-top:10px">Status: <strong>${esc(d?.onboarding?.status || 'aangemeld')}</strong></div>`;
      document.getElementById('odvObForm').hidden = true;
      done.hidden = false;
      sb.style.display = 'none';
      document.getElementById('odvObCancelBtn').textContent = 'Sluiten';
      const cp = document.getElementById('odvObCopyBtn');
      cp.addEventListener('click', async () => {
        const v = document.getElementById('odvObLinkInp').value;
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(v);
          else { const inp = document.getElementById('odvObLinkInp'); inp.select(); inp.setSelectionRange(0, v.length); document.execCommand('copy'); }
          toast('Link gekopieerd');
        } catch (e) { toast('Kopiëren mislukt: ' + (e?.message || e)); }
      });
    } catch (e) {
      const err = document.getElementById('odvObErr');
      err.textContent = 'Aanmelden mislukt: ' + (e?.message || e);
      err.hidden = false;
      sb.disabled = false; sb.textContent = 'Aanmelden';
    }
  };

  // ── Shell-navigatie: open / back / handleNav ─────────────────────────────
  window.__odvOpen = function (dealId) {
    if (!dealId) return;
    const url = new URL(location.href);
    url.searchParams.set('deal_id', String(dealId));
    if (!url.searchParams.has('v2preview')) url.searchParams.set('v2preview', 'sales');
    history.pushState({}, '', url.toString());
    try { window.DFO.goMod && window.DFO.goMod('sales'); } catch (_) {}
    try { window.DFO.goTab && window.DFO.goTab('Offertes'); } catch (_) {}
    window.DFO.render();
  };

  window.__odvBack = function () {
    const url = new URL(location.href);
    url.searchParams.delete('deal_id');
    history.pushState({}, '', url.toString());
    // Reset state zodat een volgende __odvOpen niet stale data pakt.
    _odv.dealId = null;
    _odv.data = null;
    _odv.error = null;
    window.DFO.render();
  };

  // Backwards-compat: was iframe-callback via parent.__odvHandleNav; nu
  // gewoon shell-navigatie op window-scope. Callers vanuit standalone
  // HTML (embed=1 mode) mogen 'em blijven aanroepen.
  window.__odvHandleNav = function (url) {
    if (typeof url !== 'string' || !url) { window.__odvBack(); return; }
    const m = url.match(/\/modules\/offerte-detail-v2\.html\?id=([^&]+)/);
    if (m && m[1]) { window.__odvOpen(decodeURIComponent(m[1])); return; }
    if (/\/modules\/klanten-v2\//.test(url)) { window.__odvBack(); return; }
    window.location.href = url;
  };

  // popstate: browser back/forward → re-render zodat de detail-view komt/gaat
  // op basis van huidige URL (?deal_id=X aanwezig of niet).
  window.addEventListener('popstate', () => {
    // Reset dealId zodat __odvRender opnieuw laadt bij volgende render.
    try {
      const cur = new URLSearchParams(location.search).get('deal_id');
      if (cur !== _odv.dealId) {
        _odv.dealId = null;
        _odv.data = null;
        _odv.error = null;
      }
      window.DFO.render();
    } catch (_) {}
  });

  console.debug('[odv-native] loaded — window.__odvRender/Open/Back/HandleNav beschikbaar (native, geen iframe)');
})();
