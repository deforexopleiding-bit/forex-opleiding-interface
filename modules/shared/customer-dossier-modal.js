/*
 * modules/shared/customer-dossier-modal.js
 *
 * Klantdossier-modal (PR B). Injecteert eenmalig een modal-DOM + scoped CSS
 * en exposeert:
 *
 *   window.AgentShared.openCustomerDossier(customerId)
 *
 * Ingangen (Klanten in deze PR; Gesprekken/Acties/Te-doen volgen in PR C)
 * roepen deze functie aan met een customer-uuid; de modal fetcht
 * /api/customer-dossier?customer_id=… en rendert 3 blokken:
 *
 *   NU          — stand van zaken (klant, dunning-run, gesprek, financieel)
 *   GEBEURD     — chronologische tijdlijn, "meer tonen" via before-cursor
 *   NOG TE DOEN — signalen (prominent), open acties, open facturen
 *
 * KERN-INVARIANT — "geen toegang" vs "leeg" zichtbaar verschillend:
 *   - GEBLOKKEERD: gedempte kaart met 🔒-icon, uitleg-tekst
 *   - LEEG:        neutrale check/info-regel binnen een normaal blok
 *
 * Response-shape uit /api/customer-dossier is stabiel; zie header van dat
 * bestand voor de contract-shape. Deze module valideert defensief maar
 * gaat er van uit dat de payload correct is.
 */
(function () {
  'use strict';

  const CSS = `
    .cdm-scrim {
      position: fixed; inset: 0; z-index: 9999;
      display: none; align-items: center; justify-content: center;
      padding: 24px;
      background: rgba(6, 24, 31, .48);
      font-family: 'Inter', system-ui, sans-serif;
    }
    .cdm-scrim.open { display: flex; }
    .cdm-card {
      background: var(--ds-surface, #ffffff);
      color: var(--ds-text, #06181f);
      border: 1px solid var(--ds-border, #dfe8ec);
      border-radius: 10px;
      width: min(820px, 100%); max-height: 92vh;
      display: flex; flex-direction: column;
      overflow: hidden;
      box-shadow: 0 12px 40px rgba(6, 24, 31, .28);
    }
    .cdm-head {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 12px; padding: 16px 20px;
      border-bottom: 1px solid var(--ds-border, #dfe8ec);
    }
    .cdm-title { margin: 0; font-size: 17px; font-weight: 600; line-height: 1.3; }
    .cdm-subtitle { font-size: 12.5px; color: var(--ds-text-faint, #7a8b92); margin-top: 3px; }
    .cdm-close {
      background: transparent; border: 0; cursor: pointer;
      color: var(--ds-text-muted, #48585f);
      width: 32px; height: 32px; border-radius: 6px;
      font-size: 18px; line-height: 1;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .cdm-close:hover { background: var(--ds-surface-2, #f9fbfc); color: var(--ds-text, #06181f); }
    .cdm-body {
      overflow-y: auto; -webkit-overflow-scrolling: touch;
      padding: 16px 20px; flex: 1;
      display: flex; flex-direction: column; gap: 18px;
    }

    /* Sectie-blokken (NU / GEBEURD / NOG TE DOEN). */
    .cdm-section { }
    .cdm-section-h {
      display: flex; align-items: center; gap: 8px;
      font-size: 11px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--ds-text-muted, #48585f);
      margin: 0 0 8px;
    }
    .cdm-card-plain {
      background: var(--ds-surface-2, #f9fbfc);
      border: 1px solid var(--ds-border, #dfe8ec);
      border-radius: 10px;
      padding: 12px 14px;
      font-size: 13px; line-height: 1.5;
    }

    /* NU-blok: 2-koloms grid met key/value rijen. */
    .cdm-nu-grid {
      display: grid; grid-template-columns: 130px 1fr; gap: 6px 12px;
      font-size: 13px;
    }
    .cdm-nu-grid dt { color: var(--ds-text-muted, #48585f); font-weight: 500; }
    .cdm-nu-grid dd { margin: 0; color: var(--ds-text, #06181f); }
    .cdm-nu-grid dd strong { font-weight: 600; }

    /* Locked-blok — GEBLOKKEERD visueel onderscheiden van LEEG. */
    .cdm-locked {
      background: repeating-linear-gradient(
        135deg,
        var(--ds-surface-2, #f9fbfc),
        var(--ds-surface-2, #f9fbfc) 8px,
        var(--ds-surface, #ffffff) 8px,
        var(--ds-surface, #ffffff) 16px
      );
      border: 1px dashed var(--ds-border, #dfe8ec);
      border-radius: 10px;
      padding: 12px 14px;
      color: var(--ds-text-muted, #48585f);
      font-size: 12.5px; font-style: italic;
      display: flex; align-items: flex-start; gap: 8px;
    }
    .cdm-locked-icon { flex-shrink: 0; font-size: 14px; }
    .cdm-empty {
      color: var(--ds-text-faint, #7a8b92);
      font-size: 12.5px;
      padding: 4px 0;
      display: flex; align-items: center; gap: 6px;
    }

    /* Timeline. */
    .cdm-tl { list-style: none; margin: 0; padding: 0; }
    .cdm-tl-item {
      display: grid; grid-template-columns: 110px 1fr;
      gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--ds-border, #dfe8ec);
      font-size: 13px;
    }
    .cdm-tl-item:last-child { border-bottom: 0; }
    .cdm-tl-when { color: var(--ds-text-faint, #7a8b92); font-size: 11.5px; }
    .cdm-tl-title { font-weight: 500; }
    .cdm-tl-detail { font-size: 12px; color: var(--ds-text-muted, #48585f); margin-top: 2px; }
    .cdm-tl-actor  { font-size: 11px; color: var(--ds-text-faint, #7a8b92); margin-top: 2px; }
    .cdm-tl-more {
      margin-top: 10px; text-align: center;
    }
    .cdm-tl-more-btn {
      background: var(--ds-surface-2, #f9fbfc);
      color: var(--ds-text, #06181f);
      border: 1px solid var(--ds-border, #dfe8ec);
      border-radius: 6px;
      padding: 8px 14px; cursor: pointer;
      font-size: 12.5px; font-family: inherit;
    }
    .cdm-tl-more-btn:hover:not(:disabled) {
      border-color: var(--ds-border-strong, #c1d0d7);
    }
    .cdm-tl-more-btn:disabled { opacity: .55; cursor: default; }

    /* Signalen. */
    .cdm-signal {
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex; gap: 10px; align-items: flex-start;
      font-size: 13px; line-height: 1.4;
    }
    .cdm-signal:last-child { margin-bottom: 0; }
    .cdm-signal-icon { flex-shrink: 0; font-size: 16px; line-height: 1.2; }
    .cdm-signal-msg { font-weight: 500; }
    .cdm-signal-evidence {
      font-size: 11.5px;
      color: var(--ds-text-muted, #48585f);
      margin-top: 3px;
      font-family: ui-monospace, Menlo, Consolas, monospace;
    }
    .cdm-signal.crit {
      background: rgba(220, 38, 38, .08);
      border: 1px solid rgba(220, 38, 38, .32);
      color: var(--ds-danger, #b91c1c);
    }
    .cdm-signal.warn {
      background: rgba(217, 119, 6, .08);
      border: 1px solid rgba(217, 119, 6, .32);
      color: var(--ds-warning, #92400e);
    }
    .cdm-signal.info {
      background: var(--ds-brand-soft, rgba(10, 81, 120, .08));
      border: 1px solid var(--ds-border, #dfe8ec);
      color: var(--ds-brand-strong, #083b52);
    }
    .cdm-signal.ok {
      background: rgba(34, 197, 94, .06);
      border: 1px solid rgba(34, 197, 94, .28);
      color: #166534;
    }

    /* Open-actie / factuur-lijsten. */
    .cdm-list { list-style: none; margin: 0; padding: 0; }
    .cdm-list-item {
      display: grid; grid-template-columns: 1fr auto;
      gap: 6px;
      padding: 6px 0;
      border-bottom: 1px solid var(--ds-border, #dfe8ec);
      font-size: 13px;
    }
    .cdm-list-item:last-child { border-bottom: 0; }
    .cdm-list-meta { font-size: 11.5px; color: var(--ds-text-faint, #7a8b92); }
    .cdm-mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 600; }

    /* Foutstate. */
    .cdm-error {
      background: rgba(220, 38, 38, .08);
      border: 1px solid rgba(220, 38, 38, .32);
      color: var(--ds-danger, #b91c1c);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
    }
    .cdm-loading {
      color: var(--ds-text-faint, #7a8b92);
      font-size: 13px;
      text-align: center;
      padding: 24px;
    }

    /* Meta-footer. */
    .cdm-meta {
      font-size: 11px; color: var(--ds-text-faint, #7a8b92);
      padding: 8px 20px;
      border-top: 1px solid var(--ds-border, #dfe8ec);
      background: var(--ds-surface-2, #f9fbfc);
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;
    }

    /* Mobiel — @media letterlijk (geen CSS-var). */
    @media (max-width: 720px) {
      .cdm-scrim { padding: 0; align-items: stretch; }
      .cdm-card {
        width: 100%; max-width: 100%;
        max-height: 100vh; min-height: 100vh;
        border-radius: 0; border: 0;
      }
      .cdm-close { width: 44px; height: 44px; font-size: 20px; }
      .cdm-body { padding: 14px 16px; }
      .cdm-nu-grid { grid-template-columns: 1fr; gap: 2px 0; }
      .cdm-nu-grid dt { margin-top: 8px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .04em; }
      .cdm-tl-item { grid-template-columns: 1fr; gap: 2px; }
      .cdm-tl-when { order: 2; margin-top: 2px; }
      .cdm-tl-more-btn { min-height: 44px; padding: 10px 16px; font-size: 14px; }
      .cdm-list-item { grid-template-columns: 1fr; gap: 2px; }
    }
  `;

  // ── DOM-injectie (eenmalig) ──────────────────────────────────────────────
  let _mounted = false;
  let _scrimEl = null;
  function ensureMounted() {
    if (_mounted) return;
    _mounted = true;
    // CSS
    const styleEl = document.createElement('style');
    styleEl.id = 'cdm-style';
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    // DOM
    _scrimEl = document.createElement('div');
    _scrimEl.className = 'cdm-scrim';
    _scrimEl.id = 'cdm-scrim';
    _scrimEl.setAttribute('role', 'dialog');
    _scrimEl.setAttribute('aria-modal', 'true');
    _scrimEl.setAttribute('aria-labelledby', 'cdm-title');
    _scrimEl.innerHTML = `
      <div class="cdm-card">
        <div class="cdm-head">
          <div style="min-width:0;flex:1">
            <h2 class="cdm-title" id="cdm-title">Klantdossier</h2>
            <div class="cdm-subtitle" id="cdm-subtitle">—</div>
          </div>
          <button type="button" class="cdm-close" id="cdm-close" aria-label="Sluiten">&times;</button>
        </div>
        <div class="cdm-body" id="cdm-body"></div>
        <div class="cdm-meta" id="cdm-meta"></div>
      </div>`;
    document.body.appendChild(_scrimEl);

    // Sluit-interacties.
    _scrimEl.querySelector('#cdm-close').addEventListener('click', close);
    _scrimEl.addEventListener('click', (e) => {
      if (e.target === _scrimEl) close();  // klik buiten kaart
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _scrimEl.classList.contains('open')) close();
    });
  }

  function close() {
    if (!_scrimEl) return;
    _scrimEl.classList.remove('open');
    _currentCustomerId = null;
    _loadedTimeline = [];
    _nextCursor = null;
  }

  // ── State ────────────────────────────────────────────────────────────────
  let _currentCustomerId = null;   // stale-guard
  let _loadedTimeline = [];
  let _nextCursor = null;
  let _canFinance = false;
  let _canAdmin = false;

  // ── Fetch ────────────────────────────────────────────────────────────────
  async function fetchDossier(customerId, opts) {
    const params = new URLSearchParams({ customer_id: customerId });
    if (opts?.before) params.set('before', opts.before);
    if (opts?.limit)  params.set('limit', String(opts.limit));
    const url = '/api/customer-dossier?' + params.toString();
    // AgentShared.apiFetch is beschikbaar (script wordt na agent-shared.js
    // geladen). Fail-loud: 4xx/5xx worden door de caller afgevangen.
    const r = await window.AgentShared.apiFetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
    return d;
  }

  // ── Openen ───────────────────────────────────────────────────────────────
  async function open(customerId) {
    if (!customerId) return;
    ensureMounted();
    _currentCustomerId = customerId;
    _loadedTimeline = [];
    _nextCursor = null;
    _scrimEl.classList.add('open');

    const body = _scrimEl.querySelector('#cdm-body');
    const meta = _scrimEl.querySelector('#cdm-meta');
    const title = _scrimEl.querySelector('#cdm-title');
    const sub = _scrimEl.querySelector('#cdm-subtitle');
    title.textContent = 'Klantdossier';
    sub.textContent = 'Laden…';
    body.innerHTML = '<div class="cdm-loading"><i class="ti ti-loader-2"></i> Dossier laden…</div>';
    meta.innerHTML = '';

    try {
      const data = await fetchDossier(customerId);
      // Stale-guard: user opende inmiddels een andere klant.
      if (_currentCustomerId !== customerId) return;
      render(data);
    } catch (e) {
      if (_currentCustomerId !== customerId) return;
      body.innerHTML = `<div class="cdm-error">
        <strong>Kon dossier niet laden.</strong><br>
        ${escapeHtml(e?.message || 'Onbekende fout')}
      </div>`;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render(data) {
    const body = _scrimEl.querySelector('#cdm-body');
    const meta = _scrimEl.querySelector('#cdm-meta');
    const titleEl = _scrimEl.querySelector('#cdm-title');
    const subEl = _scrimEl.querySelector('#cdm-subtitle');

    _canFinance = !!(data?._meta?.permissions?.finance);
    _canAdmin   = !!(data?._meta?.permissions?.admin);

    const nu       = data?.blocks?.nu || {};
    const gebeurd  = data?.blocks?.gebeurd || {};
    const nogTeDoen = data?.blocks?.nog_te_doen || {};

    const custName = nu?.data?.customer?.name || 'Klant';
    titleEl.textContent = custName;
    const email = nu?.data?.customer?.email;
    const phone = nu?.data?.customer?.phone;
    subEl.textContent = [email, phone].filter(Boolean).join(' · ') || '—';

    // Reset timeline-cache voor nieuwe render.
    _loadedTimeline = Array.isArray(gebeurd?.data?.timeline) ? gebeurd.data.timeline : [];
    _nextCursor = gebeurd?.data?.pagination?.next_cursor || null;

    body.innerHTML = `
      ${renderNu(nu)}
      ${renderGebeurd(gebeurd)}
      ${renderNogTeDoen(nogTeDoen)}
    `;

    // Meta-footer: permissie-status + gegenereerd op.
    const generated = data?.generated_at
      ? new Date(data.generated_at).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' })
      : '—';
    meta.innerHTML = `
      <span>Bijgewerkt om ${escapeHtml(generated)}</span>
      <span>${_canFinance ? '💰 finance' : '· basis'}${_canAdmin ? ' · admin' : ''}</span>
    `;

    // Bind "meer tonen"-knop als aanwezig.
    const moreBtn = body.querySelector('[data-cdm-more]');
    if (moreBtn) moreBtn.addEventListener('click', loadMoreTimeline);
  }

  // ── Blok 1: NU ───────────────────────────────────────────────────────────
  function renderNu(block) {
    if (block?.granted === false) {
      return sectionWithLocked('Nu', block.reason);
    }
    const d = block?.data || {};
    const cust = d.customer || {};
    const dun = d.dunning || { state: 'none' };
    const conv = d.conversation || { state: 'none' };
    const fin = d.financial;

    let dunLine;
    if (dun.state === 'active') {
      dunLine = `<strong>Actief</strong>${dun.next_action_at ? ' — volgende actie: ' + escapeHtml(fmtDateTime(dun.next_action_at)) : ''}`;
    } else if (dun.state === 'paused') {
      dunLine = `<strong>Gepauzeerd</strong>${dun.reason ? ' — ' + escapeHtml(dun.reason) : ''}`;
    } else {
      dunLine = 'Geen actieve run';
    }
    const convLine = conv.state === 'none'
      ? 'Geen gesprek'
      : escapeHtml(String(conv.state).charAt(0).toUpperCase() + String(conv.state).slice(1));

    // Financial: LEEG vs GEBLOKKEERD.
    let finHtml;
    if (!fin || fin.granted === false) {
      finHtml = `<div class="cdm-locked" style="margin-top:8px">
        <span class="cdm-locked-icon">🔒</span>
        <span>Financiële details afgeschermd — je hebt geen <code>finance.dunning.view</code> of <code>finance.arrangements.view</code>.</span>
      </div>`;
    } else {
      const bedrag = eurFmt(fin.open_total_amount || 0);
      const cnt = fin.open_invoice_count || 0;
      const arr = fin.live_arrangement;
      const sub = fin.subscription;
      finHtml = `<dl class="cdm-nu-grid" style="margin-top:8px">
        <dt>Openstaand</dt>
        <dd><strong class="cdm-mono">${escapeHtml(bedrag)}</strong>${cnt ? ' · ' + cnt + ' factuur' + (cnt === 1 ? '' : 'en') : ''}</dd>
        <dt>Regeling</dt>
        <dd>${arr
          ? `<strong>${escapeHtml(arr.type_label || arr.type)}</strong> — ${escapeHtml(arr.status_label || arr.status)}`
          : '<span class="cdm-empty" style="padding:0">Geen lopende regeling</span>'}</dd>
        <dt>Abonnement</dt>
        <dd>${sub
          ? `<strong class="cdm-mono">${escapeHtml(eurFmt(sub.amount))}</strong>${sub.start_date ? ' · start ' + escapeHtml(fmtDate(sub.start_date)) : ''}${sub.term_count ? ' · ' + sub.term_count + ' termijnen' : ''}`
          : '<span class="cdm-empty" style="padding:0">Geen actief abonnement</span>'}</dd>
      </dl>`;
    }

    return `
      <section class="cdm-section" aria-labelledby="cdm-h-nu">
        <h3 class="cdm-section-h" id="cdm-h-nu">📌 Nu — stand van zaken</h3>
        <div class="cdm-card-plain">
          <dl class="cdm-nu-grid">
            <dt>Contact</dt>
            <dd>${cust.email ? escapeHtml(cust.email) : '<span class="cdm-empty" style="padding:0">geen e-mail</span>'}${cust.phone ? ' · ' + escapeHtml(cust.phone) : ''}</dd>
            ${cust.company ? `<dt>Bedrijf</dt><dd>${escapeHtml(cust.company)}</dd>` : ''}
            <dt>Aanmaning</dt><dd>${dunLine}</dd>
            <dt>Gesprek</dt><dd>${convLine}</dd>
          </dl>
          ${finHtml}
        </div>
      </section>
    `;
  }

  // ── Blok 2: GEBEURD ─────────────────────────────────────────────────────
  function renderGebeurd(block) {
    if (block?.granted === false) {
      return sectionWithLocked('Gebeurd', block.reason);
    }
    const items = _loadedTimeline;
    const hasMore = !!_nextCursor;
    const notes = block?.data?.notes;

    let bodyHtml;
    if (items.length === 0) {
      bodyHtml = '<div class="cdm-empty">✓ Geen activiteit vastgelegd voor deze klant.</div>';
    } else {
      bodyHtml = `<ul class="cdm-tl" id="cdm-tl-list">${items.map(renderTimelineItem).join('')}</ul>`;
      if (hasMore) {
        bodyHtml += `<div class="cdm-tl-more"><button type="button" class="cdm-tl-more-btn" data-cdm-more>Meer tonen</button></div>`;
      }
    }

    let notesHtml = '';
    if (notes) {
      if (notes.granted === false) {
        notesHtml = `<div class="cdm-locked" style="margin-top:10px">
          <span class="cdm-locked-icon">🔒</span>
          <span>Klantnotities alleen voor admins.</span>
        </div>`;
      } else if (Array.isArray(notes.items) && notes.items.length > 0) {
        notesHtml = `<div style="margin-top:12px">
          <div class="cdm-section-h" style="font-size:10.5px">Notities (admin)</div>
          ${notes.items.slice(0, 3).map((n) => `<div class="cdm-card-plain" style="margin-bottom:6px">
            <div style="font-size:11.5px;color:var(--ds-text-faint,#7a8b92);margin-bottom:2px">${escapeHtml(fmtDateTime(n.created_at))}</div>
            <div style="white-space:pre-wrap">${escapeHtml(n.body || '')}</div>
          </div>`).join('')}
        </div>`;
      }
    }

    return `
      <section class="cdm-section" aria-labelledby="cdm-h-gebeurd">
        <h3 class="cdm-section-h" id="cdm-h-gebeurd">🕐 Gebeurd — tijdlijn</h3>
        <div class="cdm-card-plain">${bodyHtml}${notesHtml}</div>
      </section>
    `;
  }

  function renderTimelineItem(it) {
    const when = it?.at ? fmtRelativeDateTime(it.at) : '—';
    const title = escapeHtml(it?.title || '—');
    const detail = it?.detail ? `<div class="cdm-tl-detail">${escapeHtml(it.detail)}</div>` : '';
    const actor = it?.actor?.user_id ? `<div class="cdm-tl-actor">door ${escapeHtml(String(it.actor.user_id).slice(0, 8))}…</div>` : '';
    return `<li class="cdm-tl-item">
      <span class="cdm-tl-when">${escapeHtml(when)}</span>
      <div>
        <div class="cdm-tl-title">${title}</div>
        ${detail}
        ${actor}
      </div>
    </li>`;
  }

  async function loadMoreTimeline() {
    if (!_currentCustomerId || !_nextCursor) return;
    const btn = _scrimEl.querySelector('[data-cdm-more]');
    if (btn) { btn.disabled = true; btn.textContent = 'Laden…'; }
    try {
      const data = await fetchDossier(_currentCustomerId, { before: _nextCursor, limit: 15 });
      const newItems = data?.blocks?.gebeurd?.data?.timeline || [];
      _loadedTimeline = _loadedTimeline.concat(newItems);
      _nextCursor = data?.blocks?.gebeurd?.data?.pagination?.next_cursor || null;
      // Append + update knop-state.
      const list = _scrimEl.querySelector('#cdm-tl-list');
      if (list) list.insertAdjacentHTML('beforeend', newItems.map(renderTimelineItem).join(''));
      if (btn) {
        if (_nextCursor) {
          btn.disabled = false; btn.textContent = 'Meer tonen';
        } else {
          btn.parentElement.remove();
        }
      }
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Opnieuw proberen';
        btn.title = e?.message || 'Fout bij laden';
      }
    }
  }

  // ── Blok 3: NOG TE DOEN ──────────────────────────────────────────────────
  function renderNogTeDoen(block) {
    if (block?.granted === false) {
      return sectionWithLocked('Nog te doen', block.reason);
    }
    const d = block?.data || {};
    const sig = d.signals;
    const actions = d.open_actions;
    const invs = d.open_invoices;
    const free = d.free_tasks;

    // Signalen komen eerst — ze zijn het belangrijkst.
    let sigHtml;
    if (!sig || sig.granted === false) {
      sigHtml = `<div class="cdm-locked">
        <span class="cdm-locked-icon">🔒</span>
        <span>Signalen afgeschermd — je hebt geen financiële permissie.</span>
      </div>`;
    } else if (!sig.items || sig.items.length === 0) {
      sigHtml = `<div class="cdm-signal ok">
        <span class="cdm-signal-icon">✅</span>
        <div><div class="cdm-signal-msg">Geen actiepunten — dossier is up-to-date.</div></div>
      </div>`;
    } else {
      sigHtml = sig.items.map(renderSignal).join('');
    }

    // Open acties.
    let actionsHtml;
    if (!actions || actions.granted === false) {
      actionsHtml = `<div class="cdm-locked">
        <span class="cdm-locked-icon">🔒</span>
        <span>Open acties afgeschermd — je hebt geen financiële permissie.</span>
      </div>`;
    } else if (!actions.items || actions.items.length === 0) {
      actionsHtml = '<div class="cdm-empty">✓ Geen openstaande acties.</div>';
    } else {
      actionsHtml = `<ul class="cdm-list">${actions.items.map((a) => `<li class="cdm-list-item">
        <div>
          <strong>${escapeHtml(a.action_label || a.action_type || '—')}</strong>
          <div class="cdm-list-meta">${escapeHtml(a.status_label || a.status || '')}${a.days_open != null ? ' · ' + a.days_open + ' dag' + (a.days_open === 1 ? '' : 'en') + ' open' : ''}</div>
        </div>
      </li>`).join('')}</ul>`;
    }

    // Open facturen.
    let invHtml;
    if (!invs || invs.granted === false) {
      invHtml = `<div class="cdm-locked">
        <span class="cdm-locked-icon">🔒</span>
        <span>Open facturen afgeschermd — je hebt geen financiële permissie.</span>
      </div>`;
    } else if (!invs.items || invs.items.length === 0) {
      invHtml = '<div class="cdm-empty">✓ Geen openstaande facturen.</div>';
    } else {
      invHtml = `<ul class="cdm-list">${invs.items.map((iv) => `<li class="cdm-list-item">
        <div>
          <strong>${escapeHtml(iv.invoice_number || iv.id?.slice(0, 8) || '—')}</strong>
          <div class="cdm-list-meta">${iv.days_overdue > 0 ? iv.days_overdue + ' dag' + (iv.days_overdue === 1 ? '' : 'en') + ' te laat' : (iv.due_date ? 'vervalt ' + fmtDate(iv.due_date) : 'geen vervaldatum')}</div>
        </div>
        <div class="cdm-mono">${escapeHtml(eurFmt(iv.amount_open))}</div>
      </li>`).join('')}</ul>`;
    }

    // Free-tasks (altijd granted:false in PR A → placeholder-hint).
    let freeHtml = '';
    if (free && free.granted === false && free.reason === 'not_supported_yet') {
      freeHtml = `<div class="cdm-locked" style="margin-top:10px">
        <span class="cdm-locked-icon">⏳</span>
        <span>Vrije taken (Takenbeheer) komen later — koppeling aan klant volgt in PR D.</span>
      </div>`;
    }

    return `
      <section class="cdm-section" aria-labelledby="cdm-h-todo">
        <h3 class="cdm-section-h" id="cdm-h-todo">⚠️ Nog te doen</h3>
        <div style="margin-bottom:12px">${sigHtml}</div>
        <div class="cdm-card-plain" style="margin-bottom:10px">
          <div class="cdm-section-h" style="font-size:10.5px">Open acties</div>
          ${actionsHtml}
        </div>
        <div class="cdm-card-plain">
          <div class="cdm-section-h" style="font-size:10.5px">Open facturen</div>
          ${invHtml}
        </div>
        ${freeHtml}
      </section>
    `;
  }

  function renderSignal(sig) {
    const sev = String(sig?.severity || 'info').toLowerCase();
    const cls = sev === 'critical' ? 'crit' : sev === 'warning' ? 'warn' : 'info';
    const icon = sev === 'critical' ? '🔥' : sev === 'warning' ? '⚠️' : 'ℹ️';
    const evidenceStr = sig?.evidence && Object.keys(sig.evidence).length > 0
      ? JSON.stringify(sig.evidence)
      : null;
    return `<div class="cdm-signal ${cls}">
      <span class="cdm-signal-icon">${icon}</span>
      <div>
        <div class="cdm-signal-msg">${escapeHtml(sig?.message || sig?.code || '—')}</div>
        ${evidenceStr ? `<div class="cdm-signal-evidence">${escapeHtml(evidenceStr)}</div>` : ''}
      </div>
    </div>`;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function sectionWithLocked(title, reason) {
    const reasonMsg = reason === 'admin_only'
      ? 'Alleen zichtbaar voor admins.'
      : reason === 'no_permission'
        ? 'Geen rechten voor dit blok.'
        : 'Niet beschikbaar.';
    return `<section class="cdm-section">
      <h3 class="cdm-section-h">${escapeHtml(title)}</h3>
      <div class="cdm-locked">
        <span class="cdm-locked-icon">🔒</span>
        <span>${escapeHtml(reasonMsg)}</span>
      </div>
    </section>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function eurFmt(n) {
    const v = Number(n) || 0;
    return '€ ' + v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch { return String(iso); }
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('nl-NL', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return String(iso); }
  }
  function fmtRelativeDateTime(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return String(iso);
    const now = Date.now();
    const diffMs = now - t;
    const absMs = Math.abs(diffMs);
    if (absMs < 60_000)         return diffMs >= 0 ? 'net' : 'zo';
    if (absMs < 3600_000)       return Math.round(absMs / 60_000) + ' min';
    if (absMs < 86400_000)      return Math.round(absMs / 3600_000) + ' uur';
    if (absMs < 7 * 86400_000)  return Math.round(absMs / 86400_000) + ' d';
    return fmtDate(iso);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  // Hangt aan window.AgentShared zodra dat namespace bestaat; als 'ie later
  // wordt geïnitialiseerd wordt de functie alsnog toegevoegd via observer.
  function exposeApi() {
    if (window.AgentShared && typeof window.AgentShared === 'object') {
      window.AgentShared.openCustomerDossier = open;
      window.AgentShared.closeCustomerDossier = close;
    }
  }
  exposeApi();
  // Fallback als agent-shared.js na dit script laadt (script-tag volgorde
  // in module-pages is niet altijd deterministisch).
  if (!window.AgentShared?.openCustomerDossier) {
    let tries = 0;
    const interval = setInterval(() => {
      exposeApi();
      tries++;
      if (window.AgentShared?.openCustomerDossier || tries >= 20) clearInterval(interval);
    }, 100);
  }
})();
