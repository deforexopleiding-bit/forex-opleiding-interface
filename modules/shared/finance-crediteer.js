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
          <button class="fin-btn primary" id="credRunBtn" type="button" disabled title="Komt in de volgende stap (PR-2)">Crediteer geselecteerde (komt in volgende stap)</button>
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
    if (count === 0) {
      info.textContent = 'Nog geen selectie';
      return;
    }
    let totalCents = 0;
    const selectedSet = state.selected;
    for (const r of state.items) if (selectedSet.has(r.customer_id)) totalCents += (r.totaal_open_cents || 0);
    info.textContent = `${count} klant${count === 1 ? '' : 'en'} geselecteerd · totaal ${fmtCents(totalCents)}`;
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
