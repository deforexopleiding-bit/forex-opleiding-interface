/* modules/shared/finance-crediteer.js
 *
 * Crediteer-overzicht (PR-1: read-only startpunt voor de kwartaal-crediteerronde).
 *
 * Toont per klant het aantal openstaande facturen + totaalbedrag + pipeline-fase.
 * Standaard voorgevinkt: klanten met ≥2 open facturen. Handmatig aanpasbaar
 * via checkbox per rij + "Alles" / "≥2 alleen" bulk-knoppen.
 *
 * De actie-knop "Crediteer geselecteerde" staat expliciet disabled — het
 * daadwerkelijk crediteren komt in PR-2 (TL-call + schuld registreren + abo
 * verlengen). Deze PR is puur lezen + selecteren, zodat Jeffrey vooraf kan
 * beoordelen wat de crediteer-scope wordt.
 *
 * Public API: window.FinanceCrediteer.mount({ host: HTMLElement }).
 * Idempotent: tweede aanroep op zelfde host is no-op.
 *
 * RBAC: geen client-side gate; het onderliggende endpoint
 * /api/crediteer-overzicht handhaaft finance.dunning.view (403 als geen recht).
 */
(function () {
  if (window.FinanceCrediteer && window.FinanceCrediteer.__loaded) return;

  const state = {
    host           : null,
    wired          : false,
    loading        : false,
    items          : [],
    totals         : { customers: 0, invoices: 0, total_open_cents: 0, tweeplus_customers: 0 },
    filter         : 'all',              // 'all' | 'tweeplus'
    sortKey        : 'totaal_open',      // totaal_open | aantal | oudste | naam
    sortDir        : 'desc',
    selected       : new Set(),          // Set<customer_id>
    error          : null,
    // PR-2 preview/execute state:
    previewOpen    : false,
    previewLoading : false,
    previewError   : null,
    previewDryRun  : true,               // globale dry-run zoals de server hem rapporteert
    previewItems   : [],                 // response.items van crediteer-ronde-preview
    previewChosen  : new Map(),          // customer_id -> subscription_id | null | undefined
                                         //   undefined = nog niet gekozen (bij ≥2 subs)
                                         //   null      = expliciet "geen abo verlengen"
                                         //   uuid      = te verlengen sub
    executing      : false,
    executeResult  : null,               // laatste summary voor de after-toast + panel
  };

  // ── esc: HTML-escape (fallback als AgentShared niet geladen is). ────────
  function esc(s) {
    if (s == null) return '';
    try {
      if (window.AgentShared && typeof window.AgentShared.esc === 'function') {
        return window.AgentShared.esc(s);
      }
    } catch (_) {}
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtCents(cents) {
    const n = Number(cents);
    if (!isFinite(n)) return '—';
    const eur = n / 100;
    return '€ ' + eur.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtDagenTeLaat(dagen, iso) {
    const d = Number(dagen);
    if (!isFinite(d) || d <= 0) {
      return '<span style="color:var(--text-faint)">—</span>';
    }
    const isoStr = iso ? esc(iso) : '';
    return `<span title="Oudste vervaldatum: ${isoStr}">${d} dg</span>`;
  }

  const STAGE_LABELS = {
    nieuw           : 'Nieuw',
    aangemaand      : 'Aangemaand',
    in_gesprek      : 'In gesprek',
    regeling        : 'Regeling',
    brief_verstuurd : 'Brief verstuurd',
    incasso         : 'Incasso',
    afschrijven     : 'Afschrijven',
    opgelost        : 'Opgelost',
  };
  const STAGE_COLORS = {
    nieuw           : '#64748b',
    aangemaand      : '#f59e0b',
    in_gesprek      : '#0ea5e9',
    regeling        : '#8b5cf6',
    brief_verstuurd : '#ec4899',
    incasso         : '#dc2626',
    afschrijven     : '#94a3b8',
    opgelost        : '#10b981',
  };
  function fmtStage(slug) {
    const s = String(slug || 'nieuw').toLowerCase();
    const label = STAGE_LABELS[s] || (s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '));
    const color = STAGE_COLORS[s] || '#64748b';
    return `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:${color}22;color:${color};border:1px solid ${color}44">${esc(label)}</span>`;
  }

  // ── Fetch ─────────────────────────────────────────────────────────────
  async function load() {
    state.loading = true;
    state.error = null;
    renderBody();
    try {
      const url = `/api/crediteer-overzicht?sort=${encodeURIComponent(state.sortKey)}&dir=${encodeURIComponent(state.sortDir)}`;
      const res = window.AgentShared && typeof window.AgentShared.apiFetch === 'function'
        ? await window.AgentShared.apiFetch(url)
        : await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const j = await res.json();
      state.items  = Array.isArray(j?.items) ? j.items : [];
      state.totals = j?.totals || state.totals;
      // Default-selectie: alle klanten met heeft_2plus voorgevinkt (alleen bij
      // eerste load — daarna respecteren we bestaande selectie).
      if (!state.wired) {
        state.selected = new Set(state.items.filter((r) => r.heeft_2plus).map((r) => r.customer_id));
      } else {
        // Bij refresh: snoei uit selectie klanten die niet meer bestaan.
        const alive = new Set(state.items.map((r) => r.customer_id));
        for (const id of state.selected) if (!alive.has(id)) state.selected.delete(id);
      }
      state.wired = true;
    } catch (e) {
      state.error = e?.message || String(e);
    } finally {
      state.loading = false;
      renderBody();
    }
  }

  // ── Render ────────────────────────────────────────────────────────────
  function renderShell() {
    if (!state.host) return;
    state.host.innerHTML = `
      <div class="cred-wrap">
        <div class="cred-header">
          <div class="cred-title">
            <h2>Crediteren</h2>
            <p class="cred-subtitle">Startpunt voor de kwartaalronde — selecteer welke klanten je nu gaat crediteren. Klanten met ≥2 open facturen zijn standaard voorgevinkt.</p>
          </div>
          <button class="sr-ibtn" id="credRefreshBtn" type="button" title="Vernieuwen"><i class="ti ti-refresh"></i></button>
        </div>

        <div class="cred-kpis" id="credKpis"></div>

        <div class="cred-toolbar">
          <div class="sr-segments cred-filter">
            <button class="sr-seg active" data-cred-filter="all"      type="button">Alle klanten</button>
            <button class="sr-seg"        data-cred-filter="tweeplus" type="button">Alleen ≥2 facturen</button>
          </div>
          <div class="cred-bulk-actions">
            <button class="fin-btn" id="credSelectAll"      type="button">Alles selecteren</button>
            <button class="fin-btn" id="credSelectTweeplus" type="button">Alleen ≥2 selecteren</button>
            <button class="fin-btn" id="credSelectNone"     type="button">Alles deselecteren</button>
          </div>
        </div>

        <div class="cred-tablewrap sr-tablewrap">
          <table class="sr-table cred-table" id="credTable">
            <thead>
              <tr>
                <th class="cred-cbcol"><input type="checkbox" id="credChkAllHeader" title="Alles op deze pagina" /></th>
                <th data-sort-key="naam">Klant</th>
                <th class="num" data-sort-key="aantal" title="Openstaande facturen"># open</th>
                <th class="num" data-sort-key="totaal_open">Totaal open</th>
                <th class="num" data-sort-key="oudste" title="Dagen sinds oudste vervaldatum">Oudste te laat</th>
                <th>Fase</th>
              </tr>
            </thead>
            <tbody id="credTbody">
              <tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr>
            </tbody>
          </table>
        </div>

        <div class="cred-footer">
          <div class="cred-selection-info" id="credSelectionInfo">Nog geen selectie</div>
          <button class="fin-btn primary" id="credRunBtn" type="button" disabled title="Selecteer eerst één of meer klanten">Crediteer geselecteerde</button>
        </div>
      </div>
    `;

    // Wire.
    state.host.querySelector('#credRefreshBtn')?.addEventListener('click', load);
    state.host.querySelectorAll('[data-cred-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.filter = btn.dataset.credFilter || 'all';
        state.host.querySelectorAll('[data-cred-filter]').forEach((b) => {
          b.classList.toggle('active', b.dataset.credFilter === state.filter);
        });
        renderBody();
      });
    });
    state.host.querySelector('#credSelectAll')?.addEventListener('click', () => {
      for (const r of filteredItems()) state.selected.add(r.customer_id);
      renderBody();
    });
    state.host.querySelector('#credSelectTweeplus')?.addEventListener('click', () => {
      state.selected.clear();
      for (const r of state.items) if (r.heeft_2plus) state.selected.add(r.customer_id);
      renderBody();
    });
    state.host.querySelector('#credSelectNone')?.addEventListener('click', () => {
      state.selected.clear();
      renderBody();
    });
    state.host.querySelector('#credChkAllHeader')?.addEventListener('click', (ev) => {
      const on = !!ev.target.checked;
      for (const r of filteredItems()) {
        if (on) state.selected.add(r.customer_id); else state.selected.delete(r.customer_id);
      }
      renderBody();
    });

    // Header-sort: click op th met data-sort-key.
    state.host.querySelectorAll('th[data-sort-key]').forEach((th) => {
      th.style.cursor = 'pointer';
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = (key === 'naam') ? 'asc' : 'desc';
        }
        load();
      });
    });

    // "Crediteer geselecteerde" → open preview-overlay.
    state.host.querySelector('#credRunBtn')?.addEventListener('click', () => {
      if (state.selected.size === 0) return;
      openPreview();
    });
  }

  function filteredItems() {
    if (state.filter === 'tweeplus') return state.items.filter((r) => r.heeft_2plus);
    return state.items;
  }

  function renderBody() {
    if (!state.host) return;
    const tbody = state.host.querySelector('#credTbody');
    const kpis  = state.host.querySelector('#credKpis');
    const info  = state.host.querySelector('#credSelectionInfo');
    if (!tbody) return;

    // KPI-strip.
    if (kpis) {
      kpis.innerHTML = `
        <div class="cred-kpi">
          <div class="cred-kpi-label">Klanten met open facturen</div>
          <div class="cred-kpi-val">${state.totals.customers || 0}</div>
        </div>
        <div class="cred-kpi">
          <div class="cred-kpi-label">≥ 2 open facturen</div>
          <div class="cred-kpi-val" style="color:#dc2626">${state.totals.tweeplus_customers || 0}</div>
        </div>
        <div class="cred-kpi">
          <div class="cred-kpi-label">Totaal open facturen</div>
          <div class="cred-kpi-val">${state.totals.invoices || 0}</div>
        </div>
        <div class="cred-kpi">
          <div class="cred-kpi-label">Totaal open bedrag</div>
          <div class="cred-kpi-val">${fmtCents(state.totals.total_open_cents || 0)}</div>
        </div>
      `;
    }

    // Body.
    if (state.loading) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-faint)">Laden…</td></tr>`;
      updateSelectionInfo(info);
      return;
    }
    if (state.error) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#dc2626">Fout: ${esc(state.error)}</td></tr>`;
      updateSelectionInfo(info);
      return;
    }
    const rows = filteredItems();
    if (rows.length === 0) {
      const msg = state.filter === 'tweeplus'
        ? 'Geen klanten met ≥2 open facturen.'
        : 'Geen klanten met openstaande facturen.';
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:var(--text-faint)">${esc(msg)}</td></tr>`;
      updateSelectionInfo(info);
      return;
    }

    tbody.innerHTML = rows.map((r) => {
      const checked = state.selected.has(r.customer_id) ? 'checked' : '';
      const tweePlusBadge = r.heeft_2plus
        ? `<span class="cred-badge-2plus" title="Twee of meer open facturen">≥2</span>`
        : '';
      return `
        <tr data-cid="${esc(r.customer_id)}">
          <td class="cred-cbcol"><input type="checkbox" data-cred-row-check ${checked} /></td>
          <td>
            <div class="cred-name-cell">
              <a href="/modules/klanten.html?id=${esc(r.customer_id)}" target="_blank" rel="noopener" title="Open klantdossier">${esc(r.naam || '(zonder naam)')}</a>
              ${tweePlusBadge}
            </div>
            <div class="cred-email">${esc(r.email || '')}</div>
          </td>
          <td class="num">${r.aantal_open_facturen}</td>
          <td class="num" style="font-variant-numeric:tabular-nums">${fmtCents(r.totaal_open_cents)}</td>
          <td class="num">${fmtDagenTeLaat(r.oudste_factuur_dagen_te_laat, r.oudste_factuur_iso)}</td>
          <td>${fmtStage(r.pipeline_fase)}</td>
        </tr>
      `;
    }).join('');

    // Row-checkbox binding.
    tbody.querySelectorAll('tr[data-cid]').forEach((tr) => {
      const cid = tr.dataset.cid;
      const cb = tr.querySelector('[data-cred-row-check]');
      cb?.addEventListener('change', () => {
        if (cb.checked) state.selected.add(cid); else state.selected.delete(cid);
        updateSelectionInfo(info);
        updateHeaderCheckbox();
      });
    });

    updateHeaderCheckbox();
    updateSelectionInfo(info);
  }

  function updateHeaderCheckbox() {
    if (!state.host) return;
    const chk = state.host.querySelector('#credChkAllHeader');
    if (!chk) return;
    const rows = filteredItems();
    if (rows.length === 0) { chk.checked = false; chk.indeterminate = false; return; }
    const selectedInView = rows.filter((r) => state.selected.has(r.customer_id)).length;
    chk.checked = selectedInView === rows.length;
    chk.indeterminate = selectedInView > 0 && selectedInView < rows.length;
  }

  function updateSelectionInfo(info) {
    if (!info) return;
    const count = state.selected.size;
    const runBtn = state.host?.querySelector('#credRunBtn');
    if (count === 0) {
      info.textContent = 'Nog geen selectie';
      if (runBtn) {
        runBtn.disabled = true;
        runBtn.title = 'Selecteer eerst één of meer klanten';
      }
      return;
    }
    let totalCents = 0;
    const selectedSet = state.selected;
    for (const r of state.items) if (selectedSet.has(r.customer_id)) totalCents += (r.totaal_open_cents || 0);
    info.textContent = `${count} klant${count === 1 ? '' : 'en'} geselecteerd · totaal ${fmtCents(totalCents)}`;
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.title = 'Open preview om de crediteerronde te bevestigen';
    }
  }

  // ── Toast (best-effort fallback als AgentShared.showToast er niet is) ──
  function toast(msg, kind) {
    try {
      if (window.AgentShared && typeof window.AgentShared.showToast === 'function') {
        window.AgentShared.showToast(msg, kind || 'info');
        return;
      }
    } catch (_) {}
    // Fallback: inline banner in footer.
    const info = state.host?.querySelector('#credSelectionInfo');
    if (info) info.textContent = msg;
  }

  // ── Preview-overlay ────────────────────────────────────────────────────
  function overlayEl() {
    let el = document.getElementById('credPreviewOverlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'credPreviewOverlay';
      el.className = 'cred-overlay';
      el.hidden = true;
      document.body.appendChild(el);
    }
    return el;
  }

  async function openPreview() {
    state.previewOpen = true;
    state.previewLoading = true;
    state.previewError = null;
    state.previewItems = [];
    state.previewChosen = new Map();
    state.executeResult = null;
    renderOverlay();
    try {
      const customer_ids = Array.from(state.selected);
      const res = window.AgentShared && typeof window.AgentShared.apiFetch === 'function'
        ? await window.AgentShared.apiFetch('/api/crediteer-ronde-preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_ids }),
          })
        : await fetch('/api/crediteer-ronde-preview', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customer_ids }),
          });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const j = await res.json();
      state.previewDryRun = !!j?.dry_run;
      state.previewItems  = Array.isArray(j?.items) ? j.items : [];
      // Default sub-keuze zetten: 0 subs → null (geen abo). 1 sub → dat sub.
      // ≥2 subs → undefined (gebruiker MOET kiezen). Klanten zonder facturen
      // vallen automatisch buiten (state.previewItems bevat lege invoices dan).
      for (const it of state.previewItems) {
        const withTl = (it.subscriptions || []).filter((s) => !!s.teamleader_subscription_id);
        if (withTl.length === 0)      state.previewChosen.set(it.customer_id, null);
        else if (withTl.length === 1) state.previewChosen.set(it.customer_id, withTl[0].id);
        else                          state.previewChosen.set(it.customer_id, undefined);
      }
    } catch (e) {
      state.previewError = e?.message || String(e);
    } finally {
      state.previewLoading = false;
      renderOverlay();
    }
  }

  function closePreview() {
    state.previewOpen = false;
    state.previewLoading = false;
    state.previewItems = [];
    state.previewChosen = new Map();
    state.executeResult = null;
    renderOverlay();
  }

  function renderOverlay() {
    const el = overlayEl();
    if (!state.previewOpen) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;

    // After-execute summary?
    if (state.executeResult) {
      renderExecuteResult(el);
      return;
    }

    // Loading / error.
    if (state.previewLoading) {
      el.innerHTML = `
        <div class="cred-modal">
          <div class="cred-modal-header"><h3>Preview crediteerronde</h3><button class="cred-close" type="button" data-cred-close>×</button></div>
          <div class="cred-modal-body" style="text-align:center;padding:32px;color:var(--text-dim)">Preview wordt geladen…</div>
        </div>`;
      el.querySelector('[data-cred-close]')?.addEventListener('click', closePreview);
      return;
    }
    if (state.previewError) {
      el.innerHTML = `
        <div class="cred-modal">
          <div class="cred-modal-header"><h3>Preview crediteerronde</h3><button class="cred-close" type="button" data-cred-close>×</button></div>
          <div class="cred-modal-body" style="padding:24px;color:#dc2626">Fout: ${esc(state.previewError)}</div>
          <div class="cred-modal-footer">
            <button class="fin-btn" type="button" data-cred-close>Sluiten</button>
          </div>
        </div>`;
      el.querySelectorAll('[data-cred-close]').forEach((b) => b.addEventListener('click', closePreview));
      return;
    }

    // Geldige items filteren (met minstens 1 credit-baar factuur).
    const runnable = state.previewItems.filter((it) => (it.invoices || []).length > 0);
    const skipped  = state.previewItems.filter((it) => (it.invoices || []).length === 0);

    let grandIncl = 0, grandVat = 0, grandCount = 0, extendCount = 0;
    for (const it of runnable) {
      grandIncl  += Number(it.totals?.open_incl) || 0;
      grandVat   += Number(it.totals?.open_vat)  || 0;
      grandCount += Number(it.totals?.count)     || 0;
      const chosen = state.previewChosen.get(it.customer_id);
      if (chosen) extendCount++;
    }

    // Kan bevestigen? Alleen als er runnable-items zijn en alle klanten met ≥2
    // subs een expliciete keuze hebben (of "geen abo verlengen").
    const needsChoice = runnable.filter((it) => state.previewChosen.get(it.customer_id) === undefined);
    const canConfirm = runnable.length > 0 && needsChoice.length === 0 && !state.executing;

    const runLabelSuffix = state.previewDryRun ? ' (dry-run: niks boeken)' : '';

    el.innerHTML = `
      <div class="cred-modal cred-modal-wide">
        <div class="cred-modal-header">
          <h3>Preview crediteerronde ${state.previewDryRun ? '<span class="cred-dryrun-badge">DRY-RUN</span>' : ''}</h3>
          <button class="cred-close" type="button" data-cred-close>×</button>
        </div>
        <div class="cred-modal-body">
          ${state.previewDryRun ? `
            <div class="cred-dryrun-note">
              <i class="ti ti-flask" style="color:#f59e0b"></i>
              Globale dry-run staat AAN — er wordt niets in Teamleader geboekt. Alle acties worden alleen gelogd. Zet dry-run uit in de Sandbox-instellingen om live te crediteren.
            </div>
          ` : ''}

          <div class="cred-preview-summary">
            <div><strong>${runnable.length}</strong> klant${runnable.length === 1 ? '' : 'en'} · <strong>${grandCount}</strong> facturen · totaal ${fmtEur(grandIncl)} (waarvan ${fmtEur(grandVat)} BTW) · verlengen: ${extendCount}</div>
            ${skipped.length > 0 ? `<div style="color:var(--text-faint);font-size:12px;margin-top:4px">${skipped.length} klant(en) hebben geen te-crediteren facturen — worden overgeslagen.</div>` : ''}
            ${needsChoice.length > 0 ? `<div style="color:#f59e0b;font-size:12.5px;margin-top:4px">${needsChoice.length} klant(en) hebben meerdere abonnementen — kies eerst welke te verlengen.</div>` : ''}
          </div>

          <div class="cred-preview-list">
            ${runnable.map(renderPreviewCard).join('')}
            ${skipped.length > 0 ? `<div class="cred-preview-card cred-card-muted">
              <div style="font-weight:600">Overgeslagen (${skipped.length}):</div>
              <ul style="margin:6px 0 0 18px;padding:0;font-size:12.5px;color:var(--text-faint)">
                ${skipped.map((it) => `<li>${esc(it.customer_name)} — geen open facturen om te crediteren</li>`).join('')}
              </ul>
            </div>` : ''}
          </div>
        </div>
        <div class="cred-modal-footer">
          <button class="fin-btn" type="button" data-cred-close>Annuleren</button>
          <button class="fin-btn primary" type="button" id="credConfirmBtn" ${canConfirm ? '' : 'disabled'}>
            ${state.executing ? 'Bezig…' : `Bevestig en crediteer${runLabelSuffix}`}
          </button>
        </div>
      </div>
    `;

    el.querySelectorAll('[data-cred-close]').forEach((b) => b.addEventListener('click', closePreview));
    el.querySelector('#credConfirmBtn')?.addEventListener('click', executeRun);
    // Sub-picker knoppen.
    el.querySelectorAll('[data-cred-choose-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.credChooseSub;
        openSubPopup(cid);
      });
    });
    el.querySelectorAll('[data-cred-clear-sub]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.credClearSub;
        state.previewChosen.set(cid, null);
        renderOverlay();
      });
    });
  }

  function renderPreviewCard(it) {
    const chosen = state.previewChosen.get(it.customer_id);
    const withTl  = (it.subscriptions || []).filter((s) => !!s.teamleader_subscription_id);
    const nSubs   = withTl.length;
    const chosenSub = chosen && withTl.find((s) => s.id === chosen);
    const nCredit = it.totals?.count || 0;

    let subBlock = '';
    if (nSubs === 0) {
      subBlock = `<div class="cred-sub-line" style="color:var(--text-faint)">Geen abonnement met TL-id — alleen crediteren, niet verlengen.</div>`;
    } else if (chosenSub) {
      subBlock = `
        <div class="cred-sub-line">
          <span><i class="ti ti-calendar-plus" style="color:#10b981"></i> Verlengen: <strong>${esc(chosenSub.description)}</strong> +${nCredit} maand(en)</span>
          ${nSubs > 1 ? `<button class="fin-btn" type="button" data-cred-choose-sub="${esc(it.customer_id)}">Andere abbo kiezen</button>` : ''}
          <button class="fin-btn" type="button" data-cred-clear-sub="${esc(it.customer_id)}">Alleen crediteren</button>
        </div>`;
    } else if (chosen === null) {
      subBlock = `
        <div class="cred-sub-line">
          <span style="color:var(--text-faint)">Alleen crediteren — geen abonnement verlengen</span>
          ${nSubs >= 1 ? `<button class="fin-btn" type="button" data-cred-choose-sub="${esc(it.customer_id)}">Toch abbo kiezen</button>` : ''}
        </div>`;
    } else {
      // chosen === undefined → wachten op keuze
      subBlock = `
        <div class="cred-sub-line cred-sub-choose">
          <span style="color:#f59e0b"><i class="ti ti-alert-triangle"></i> Meerdere abonnementen — kies er één</span>
          <button class="fin-btn primary" type="button" data-cred-choose-sub="${esc(it.customer_id)}">Kies abonnement om te verlengen</button>
          <button class="fin-btn" type="button" data-cred-clear-sub="${esc(it.customer_id)}">Alleen crediteren</button>
        </div>`;
    }

    return `
      <div class="cred-preview-card">
        <div class="cred-preview-card-head">
          <div>
            <div class="cred-preview-name">${esc(it.customer_name)}</div>
            <div class="cred-preview-email">${esc(it.email || '')}</div>
          </div>
          <div style="text-align:right">
            <div class="cred-preview-total">${fmtEur(it.totals?.open_incl || 0)}</div>
            <div class="cred-preview-vat">Waarvan BTW ${fmtEur(it.totals?.open_vat || 0)}</div>
            <div class="cred-preview-count">${nCredit} factuur${nCredit === 1 ? '' : 'en'}</div>
          </div>
        </div>
        <div class="cred-preview-invs">
          ${(it.invoices || []).map((iv) => `
            <div class="cred-preview-inv">
              <span class="cred-preview-inv-nr">${esc(iv.invoice_number || iv.id.slice(0, 8))}</span>
              <span class="cred-preview-inv-due">verval ${esc(iv.due_date || '—')}${iv.days_overdue ? ` · ${iv.days_overdue} dg` : ''}</span>
              <span class="cred-preview-inv-amt">${fmtEur(iv.open_amount)}</span>
            </div>
          `).join('')}
        </div>
        ${subBlock}
      </div>
    `;
  }

  function openSubPopup(customerId) {
    const it = state.previewItems.find((x) => x.customer_id === customerId);
    if (!it) return;
    const withTl = (it.subscriptions || []).filter((s) => !!s.teamleader_subscription_id);
    if (withTl.length === 0) return;
    const currentChoice = state.previewChosen.get(customerId);
    const nCredit = it.totals?.count || 0;

    const el = overlayEl();
    // Popup wordt op de overlay bovenop de modal getekend.
    const popupHtml = `
      <div class="cred-popup">
        <div class="cred-popup-header">
          <div>
            <div style="font-size:15px;font-weight:700">Abonnement kiezen om te verlengen</div>
            <div style="font-size:12.5px;color:var(--text-dim)">${esc(it.customer_name)} — +${nCredit} maand${nCredit === 1 ? '' : 'en'} (per gecrediteerde factuur)</div>
          </div>
          <button class="cred-close" type="button" data-cred-popup-close>×</button>
        </div>
        <div class="cred-popup-body">
          ${withTl.map((s) => {
            const isSel = currentChoice === s.id ? 'cred-popup-sel' : '';
            return `
              <label class="cred-popup-opt ${isSel}">
                <input type="radio" name="credSubPick" value="${esc(s.id)}" ${isSel ? 'checked' : ''} />
                <div style="flex:1">
                  <div style="font-weight:600">${esc(s.description)}</div>
                  <div style="font-size:12px;color:var(--text-dim)">
                    ${fmtEur(s.amount)}/termijn · ${s.term_count || 0} termijnen · ${esc(s.start_date || '—')} → ${esc(s.end_date || '—')}
                    ${s.postponed_months ? ` · al ${s.postponed_months} mnd verlengd` : ''}
                  </div>
                </div>
              </label>
            `;
          }).join('')}
        </div>
        <div class="cred-popup-footer">
          <button class="fin-btn" type="button" data-cred-popup-close>Annuleren</button>
          <button class="fin-btn primary" type="button" id="credSubPickApply">Kiezen</button>
        </div>
      </div>
    `;
    const holder = document.createElement('div');
    holder.className = 'cred-popup-holder';
    holder.innerHTML = popupHtml;
    el.appendChild(holder);
    const closePopup = () => holder.remove();
    holder.querySelectorAll('[data-cred-popup-close]').forEach((b) => b.addEventListener('click', closePopup));
    holder.querySelector('#credSubPickApply')?.addEventListener('click', () => {
      const picked = holder.querySelector('input[name="credSubPick"]:checked');
      if (!picked) { toast('Kies eerst een abonnement', 'warning'); return; }
      state.previewChosen.set(customerId, picked.value);
      closePopup();
      renderOverlay();
    });
  }

  async function executeRun() {
    if (state.executing) return;
    const runnable = state.previewItems.filter((it) => (it.invoices || []).length > 0);
    // Alle keuzes moeten gemaakt zijn.
    for (const it of runnable) {
      if (state.previewChosen.get(it.customer_id) === undefined) {
        toast('Er zijn nog klanten zonder abbo-keuze', 'warning');
        return;
      }
    }
    const items = runnable.map((it) => {
      const sub = state.previewChosen.get(it.customer_id);
      return { customer_id: it.customer_id, subscription_id: sub || null };
    });
    state.executing = true;
    renderOverlay();
    try {
      const res = window.AgentShared && typeof window.AgentShared.apiFetch === 'function'
        ? await window.AgentShared.apiFetch('/api/crediteer-ronde-execute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, confirm: true }),
          })
        : await fetch('/api/crediteer-ronde-execute', {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items, confirm: true }),
          });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j?.error) msg = j.error; } catch (_) {}
        throw new Error(msg);
      }
      const j = await res.json();
      state.executeResult = j;
      const s = j?.summary || {};
      const label = j?.dry_run ? 'Dry-run voltooid' : 'Crediteerronde voltooid';
      toast(`${label} · ${s.credited_invoices || 0} facturen · ${s.extended_subscriptions || 0} abonnementen verlengd${s.error_customers ? ` · ${s.error_customers} met fouten` : ''}`, s.error_customers ? 'warning' : 'success');
      // Herlaad de lijst zodat gecrediteerde facturen verdwijnen.
      if (!j?.dry_run) load();
    } catch (e) {
      toast('Fout: ' + (e?.message || String(e)), 'error');
    } finally {
      state.executing = false;
      renderOverlay();
    }
  }

  function renderExecuteResult(el) {
    const r = state.executeResult;
    const s = r?.summary || {};
    const dry = !!r?.dry_run;
    el.innerHTML = `
      <div class="cred-modal cred-modal-wide">
        <div class="cred-modal-header">
          <h3>${dry ? 'Dry-run resultaat' : 'Crediteerronde afgerond'}</h3>
          <button class="cred-close" type="button" data-cred-close>×</button>
        </div>
        <div class="cred-modal-body">
          <div class="cred-result-grid">
            <div><span>Klanten</span><strong>${s.total_customers || 0}</strong></div>
            <div><span>Facturen ${dry ? '(zou crediteren)' : 'gecrediteerd'}</span><strong>${s.credited_invoices || 0}</strong></div>
            <div><span>Abonnementen ${dry ? '(zou verlengen)' : 'verlengd'}</span><strong>${s.extended_subscriptions || 0}</strong></div>
            <div><span>Overgeslagen (geen facturen)</span><strong>${s.skipped_no_invoices || 0}</strong></div>
            <div><span>Fouten (klanten)</span><strong style="${s.error_customers ? 'color:#dc2626' : ''}">${s.error_customers || 0}</strong></div>
          </div>
          <div class="cred-result-list">
            ${(r.customers || []).map((c) => `
              <div class="cred-result-row">
                <div style="font-weight:600">${esc(c.customer_name || c.customer_id.slice(0, 8))}</div>
                <div style="font-size:12.5px;color:var(--text-dim);margin-top:2px">
                  ${c.credited?.length ? `${c.credited.length} gecrediteerd` : 'niets gecrediteerd'}
                  ${c.extended ? ` · abbo +${c.extended.months} mnd` : ''}
                  ${c.errors?.length ? ` · <span style="color:#dc2626">${c.errors.length} fout(en)</span>` : ''}
                </div>
                ${c.errors?.length ? `<ul style="margin:4px 0 0 18px;padding:0;font-size:12px;color:#dc2626">${c.errors.map((e) => `<li>${esc(e.scope)}: ${esc(e.message)}</li>`).join('')}</ul>` : ''}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="cred-modal-footer">
          <button class="fin-btn primary" type="button" data-cred-close>Sluiten</button>
        </div>
      </div>
    `;
    el.querySelectorAll('[data-cred-close]').forEach((b) => b.addEventListener('click', closePreview));
  }

  function fmtEur(v) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return '€ ' + n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── Style-injectie ────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('finance-crediteer-styles')) return;
    const st = document.createElement('style');
    st.id = 'finance-crediteer-styles';
    st.textContent = `
      .cred-wrap { display:flex; flex-direction:column; gap:16px; }
      .cred-header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
      .cred-title h2 { margin:0 0 4px 0; font-size:18px; font-weight:700; color:var(--text); }
      .cred-subtitle { margin:0; font-size:12.5px; color:var(--text-dim); max-width:640px; line-height:1.5; }
      .cred-kpis { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; }
      .cred-kpi { padding:14px 16px; background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; }
      .cred-kpi-label { font-size:11.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.5px; }
      .cred-kpi-val { font-size:22px; font-weight:700; margin-top:4px; color:var(--text); }
      .cred-toolbar { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
      .cred-bulk-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .cred-tablewrap { overflow-x:auto; }
      .cred-table { width:100%; border-collapse:collapse; font-size:13px; }
      .cred-table th, .cred-table td { padding:10px 12px; border-bottom:1px solid var(--border-subtle, var(--border)); }
      .cred-table th { text-align:left; background:var(--bg-elev); font-weight:600; color:var(--text-dim); font-size:12px; text-transform:uppercase; letter-spacing:.4px; user-select:none; }
      .cred-table td.num, .cred-table th.num { text-align:right; }
      .cred-cbcol { width:36px; text-align:center; }
      .cred-name-cell { display:flex; align-items:center; gap:6px; }
      .cred-name-cell a { color:var(--text); text-decoration:none; font-weight:600; }
      .cred-name-cell a:hover { color:#0ea5e9; text-decoration:underline; }
      .cred-email { font-size:11.5px; color:var(--text-faint); margin-top:2px; }
      .cred-badge-2plus { display:inline-block; padding:1px 6px; border-radius:999px; background:rgba(220,38,38,.14); color:#dc2626; font-size:10px; font-weight:700; border:1px solid rgba(220,38,38,.28); }
      .cred-footer { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 16px; background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; }
      .cred-selection-info { font-size:13px; color:var(--text); font-weight:500; }
      .cred-footer button[disabled] { opacity:.55; cursor:not-allowed; }

      /* PR-2 overlay + modal + popup */
      .cred-overlay { position:fixed; inset:0; z-index:1200; background:rgba(0,0,0,.55); display:flex; align-items:flex-start; justify-content:center; padding:40px 16px; overflow-y:auto; }
      .cred-overlay[hidden] { display:none; }
      .cred-modal { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.5); width:100%; max-width:720px; display:flex; flex-direction:column; }
      .cred-modal-wide { max-width:900px; }
      .cred-modal-header { display:flex; justify-content:space-between; align-items:center; padding:16px 20px; border-bottom:1px solid var(--border-subtle, var(--border)); }
      .cred-modal-header h3 { margin:0; font-size:16px; font-weight:700; color:var(--text); }
      .cred-modal-body { padding:16px 20px; overflow-y:auto; max-height:70vh; }
      .cred-modal-footer { display:flex; justify-content:flex-end; gap:8px; padding:14px 20px; border-top:1px solid var(--border-subtle, var(--border)); }
      .cred-close { background:transparent; border:none; font-size:22px; line-height:1; color:var(--text-dim); cursor:pointer; padding:2px 8px; border-radius:6px; }
      .cred-close:hover { background:var(--bg-elev-2); color:var(--text); }
      .cred-dryrun-badge { display:inline-block; margin-left:8px; padding:2px 8px; background:rgba(245,158,11,.14); color:#f59e0b; border:1px solid rgba(245,158,11,.36); border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.4px; }
      .cred-dryrun-note { padding:10px 12px; background:rgba(245,158,11,.06); border:1px solid rgba(245,158,11,.32); border-radius:8px; font-size:12.5px; color:var(--text-dim); margin-bottom:12px; display:flex; gap:8px; align-items:flex-start; line-height:1.5; }
      .cred-preview-summary { margin-bottom:14px; font-size:13.5px; color:var(--text); }
      .cred-preview-list { display:flex; flex-direction:column; gap:12px; }
      .cred-preview-card { background:var(--bg-elev-2, rgba(255,255,255,.02)); border:1px solid var(--border-subtle, var(--border)); border-radius:10px; padding:12px 14px; }
      .cred-preview-card.cred-card-muted { background:transparent; }
      .cred-preview-card-head { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:8px; }
      .cred-preview-name { font-weight:700; color:var(--text); font-size:14px; }
      .cred-preview-email { font-size:11.5px; color:var(--text-faint); }
      .cred-preview-total { font-size:16px; font-weight:700; color:var(--text); font-variant-numeric:tabular-nums; }
      .cred-preview-vat { font-size:11px; color:var(--text-faint); }
      .cred-preview-count { font-size:11px; color:var(--text-dim); }
      .cred-preview-invs { display:flex; flex-direction:column; gap:2px; padding:6px 0 8px 0; font-size:12.5px; }
      .cred-preview-inv { display:grid; grid-template-columns:1fr auto auto; gap:12px; padding:2px 0; color:var(--text-dim); }
      .cred-preview-inv-nr { font-family:ui-monospace, SFMono-Regular, monospace; color:var(--text); }
      .cred-preview-inv-amt { font-variant-numeric:tabular-nums; color:var(--text); }
      .cred-sub-line { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 0 0 0; border-top:1px dashed var(--border-subtle, var(--border)); font-size:13px; }
      .cred-sub-line span { flex:1; }
      .cred-sub-line.cred-sub-choose { color:#f59e0b; }
      .cred-popup-holder { position:absolute; inset:0; z-index:1300; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.35); padding:16px; }
      .cred-popup { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; box-shadow:0 20px 60px rgba(0,0,0,.55); width:100%; max-width:520px; display:flex; flex-direction:column; max-height:80vh; }
      .cred-popup-header { display:flex; justify-content:space-between; align-items:flex-start; padding:14px 18px; border-bottom:1px solid var(--border-subtle, var(--border)); gap:12px; }
      .cred-popup-body { padding:12px 18px; overflow-y:auto; display:flex; flex-direction:column; gap:6px; }
      .cred-popup-footer { display:flex; gap:8px; justify-content:flex-end; padding:12px 18px; border-top:1px solid var(--border-subtle, var(--border)); }
      .cred-popup-opt { display:flex; gap:10px; align-items:flex-start; padding:8px 10px; border:1px solid var(--border-subtle, var(--border)); border-radius:8px; cursor:pointer; }
      .cred-popup-opt.cred-popup-sel { border-color:#0ea5e9; background:rgba(14,165,233,.06); }
      .cred-popup-opt input[type="radio"] { margin-top:3px; }
      .cred-result-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:10px 20px; margin-bottom:14px; }
      .cred-result-grid > div { display:flex; justify-content:space-between; padding:6px 10px; background:var(--bg-elev-2, rgba(255,255,255,.02)); border:1px solid var(--border-subtle, var(--border)); border-radius:6px; }
      .cred-result-grid span { color:var(--text-dim); font-size:12.5px; }
      .cred-result-grid strong { color:var(--text); font-size:14px; }
      .cred-result-list { display:flex; flex-direction:column; gap:8px; }
      .cred-result-row { padding:8px 10px; background:var(--bg-elev-2, rgba(255,255,255,.02)); border:1px solid var(--border-subtle, var(--border)); border-radius:6px; }
    `;
    document.head.appendChild(st);
  }

  // ── Mount ─────────────────────────────────────────────────────────────
  function mount(opts) {
    const o = opts || {};
    if (!o.host) { console.warn('[FinanceCrediteer] mount() requires {host}'); return; }
    // Idempotent: zelfde host & al gemount → alleen refresh.
    if (state.host === o.host && state.wired) {
      load();
      return;
    }
    state.host = o.host;
    state.wired = false;
    injectStyles();
    renderShell();
    load();
  }

  window.FinanceCrediteer = {
    __loaded: true,
    mount,
  };
})();
