/* modules/shared/finance-dashboard.js
 *
 * Finance Dashboard module (Groep C). Mount-target: container in finance.html
 * (#view-dashboard). Toont 12 KPI-cards + 3 chart-panelen met Recharts (lazy-
 * loaded via CDN-script-tag op demand).
 *
 * Public API:
 *   window.FinanceDashboard.mount({
 *     host:        HTMLElement,     // verplichte container
 *     period?:     'today'|'week'|'month'|'quarter'|'year',  // default uit URL of 'month'
 *     onDrillDown: (target) => void  // optionele callback; target is een object
 *                                    //   { view: 'wanbetalers', sub: 'open-acties', status: 'PENDING' }
 *                                    //   { view: 'facturen', status: 'overdue' }
 *                                    //   etc.
 *   })
 *
 * Idempotent: mount op zelfde host doet niets (early return). Mount op nieuwe
 * host re-render (zelfde patroon als shared/finance-tasks.js +
 * shared/finance-klanten.js).
 *
 * Chart-rendering:
 *   - Recharts wordt LAZY geladen via document.head appendChild(<script>) op
 *     de eerste keer dat een chart moet renderen. CDN: unpkg.com/recharts@2.
 *   - Bij CDN-fail: chart-paneel toont "Charts niet beschikbaar" placeholder,
 *     geen crash, console.warn voor diagnose.
 *
 * Refresh:
 *   - "Vernieuwen" knop rechts bovenin = manual refresh van alle data (force=true).
 *   - GEEN setInterval / polling — manual-only zoals roadmap-doc voorschrijft.
 *
 * Drill-down:
 *   - Klikken op een KPI-card → onDrillDown callback. Caller (finance.html) mapt
 *     dit naar setView/setSubView/URL-update. Zonder callback: stille no-op.
 */
(function () {
  if (window.FinanceDashboard && window.FinanceDashboard.__loaded) return;

  // ── Module-scope state ─────────────────────────────────────────────────────
  const _state = {
    host:         null,
    period:       'month',
    onDrillDown:  null,
    counts:       null,
    aging:        null,
    topDebtors:   null,
    arrangements: null,
    joostIntents: null,
    tasksByType:  null,
    cashflow:     null,
    paymentsMix:  null,
    loading:      false,
    rechartsLoading: false,
    rechartsReady: false,
    rechartsFailed: false,
    wired:        false,
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  function esc(s) {
    if (s == null) return '';
    try { if (window.AgentShared?.esc) return window.AgentShared.esc(s); } catch (_) {}
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtEur(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '€ —';
    return '€ ' + v.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtInt(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toLocaleString('nl-NL');
  }
  function fmtPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(1) + ' %';
  }
  function relTimeShort(iso) {
    if (!iso) return '—';
    try {
      const ts = new Date(iso).getTime();
      const diff = Date.now() - ts;
      if (diff < 60_000) return 'net';
      const min = Math.floor(diff / 60_000);
      if (min < 60) return min + ' min';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' uur';
      const d = Math.floor(hr / 24);
      return d + ' dag' + (d === 1 ? '' : 'en');
    } catch (_) { return '—'; }
  }
  async function apiGet(url) {
    let resp;
    if (window.AgentShared && typeof window.AgentShared.apiFetch === 'function') {
      resp = await window.AgentShared.apiFetch(url);
    } else {
      resp = await fetch(url, { credentials: 'include' });
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 120));
    }
    return resp.json();
  }

  // ── CSS-injectie (één keer) ────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('finance-dashboard-styles')) return;
    const s = document.createElement('style');
    s.id = 'finance-dashboard-styles';
    s.textContent = `
      .fd-toolbar { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:18px; padding:12px 16px; background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; }
      .fd-toolbar .fd-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); font-weight:600; margin-right:4px; }
      .fd-select { padding:7px 10px; background:var(--bg-elev-2,var(--bg)); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; font-family:inherit; }
      .fd-select:focus { outline:none; border-color:var(--brand-primary, var(--accent-cyan, #06b6d4)); }
      .fd-refresh-btn { margin-left:auto; padding:7px 14px; background:var(--brand-primary,#06b6d4); color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; gap:6px; align-items:center; }
      .fd-refresh-btn:hover { filter:brightness(1.1); }
      .fd-refresh-btn:disabled { opacity:.5; cursor:not-allowed; }
      .fd-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:12px; margin-bottom:18px; }
      @media (max-width: 1100px) { .fd-grid { grid-template-columns: repeat(2, 1fr); } }
      @media (max-width: 600px)  { .fd-grid { grid-template-columns: 1fr; } }
      .fd-card { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; padding:14px 16px; min-height:104px; display:flex; flex-direction:column; gap:6px; cursor:default; transition:border-color .15s, transform .15s; }
      .fd-card.clickable { cursor:pointer; }
      .fd-card.clickable:hover { border-color: var(--brand-primary,#06b6d4); transform: translateY(-1px); }
      .fd-card-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); font-weight:600; }
      .fd-card-value { font-size:24px; font-weight:700; color:var(--text); font-variant-numeric: tabular-nums; line-height:1.1; }
      .fd-card-meta  { font-size:11.5px; color:var(--text-dim); margin-top:auto; }
      .fd-card-skeleton { height:24px; width:80%; background:linear-gradient(90deg, var(--border) 0%, var(--bg-elev-2,var(--bg)) 50%, var(--border) 100%); border-radius:6px; background-size:200% 100%; animation: fd-shimmer 1.4s ease-in-out infinite; }
      @keyframes fd-shimmer { 0% { background-position: 100% 0; } 100% { background-position: -100% 0; } }
      .fd-charts { display:grid; grid-template-columns: 1fr 1fr; gap:14px; }
      @media (max-width: 900px) { .fd-charts { grid-template-columns: 1fr; } }
      .fd-chart-panel { background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; padding:14px 16px; min-height:280px; display:flex; flex-direction:column; }
      .fd-chart-panel.wide { grid-column: 1 / -1; }
      .fd-chart-title { font-size:13px; font-weight:600; color:var(--text); margin-bottom:10px; display:flex; align-items:center; gap:8px; }
      .fd-chart-title small { color:var(--text-faint); font-weight:500; font-size:11.5px; margin-left:auto; }
      .fd-chart-host { flex:1; min-height:230px; }
      .fd-chart-placeholder { display:flex; align-items:center; justify-content:center; flex:1; color:var(--text-faint); font-size:13px; min-height:230px; }
      .fd-fallback-table { width:100%; border-collapse: collapse; font-size:12.5px; }
      .fd-fallback-table th, .fd-fallback-table td { padding:6px 8px; text-align:left; border-bottom:1px solid var(--border); }
      .fd-fallback-table th { color:var(--text-faint); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
      .fd-fallback-table td.num { text-align:right; font-variant-numeric: tabular-nums; }
      .fd-fallback-note { font-size:10.5px; color:var(--text-faint); padding:4px 0 8px; font-style:italic; }
      .fd-cache-note { font-size:11px; color:var(--text-faint); margin-top:8px; }
      .fd-section-title { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); font-weight:600; margin:6px 0 10px; }
      .fd-todo { font-size:11.5px; color:var(--text-faint); padding:10px 14px; border:1px dashed var(--border); border-radius:10px; background:var(--bg-elev); margin-top:14px; }
    `;
    document.head.appendChild(s);
  }

  // ── Recharts lazy-load ─────────────────────────────────────────────────────
  function loadRechartsOnce() {
    if (_state.rechartsReady)  return Promise.resolve(true);
    if (_state.rechartsFailed) return Promise.resolve(false);
    if (_state.rechartsLoading) {
      return new Promise(resolve => {
        const tick = () => {
          if (_state.rechartsReady)  return resolve(true);
          if (_state.rechartsFailed) return resolve(false);
          setTimeout(tick, 100);
        };
        tick();
      });
    }
    _state.rechartsLoading = true;
    return new Promise(resolve => {
      // Recharts needs React + ReactDOM op window.
      const sources = [
        { id: 'fd-rt-react',     url: 'https://unpkg.com/react@17/umd/react.production.min.js' },
        { id: 'fd-rt-react-dom', url: 'https://unpkg.com/react-dom@17/umd/react-dom.production.min.js' },
        { id: 'fd-rt-recharts',  url: 'https://unpkg.com/recharts@2/umd/Recharts.min.js' },
      ];
      let i = 0;
      const loadNext = () => {
        if (i >= sources.length) {
          if (typeof window.Recharts === 'object' && window.Recharts) {
            _state.rechartsReady = true;
            _state.rechartsLoading = false;
            resolve(true);
          } else {
            console.warn('[FinanceDashboard] Recharts global missing after all scripts');
            _state.rechartsFailed = true;
            _state.rechartsLoading = false;
            resolve(false);
          }
          return;
        }
        const src = sources[i++];
        if (document.getElementById(src.id)) {
          loadNext();
          return;
        }
        const tag = document.createElement('script');
        tag.id = src.id;
        tag.src = src.url;
        tag.async = false; // load in order
        tag.onload = loadNext;
        tag.onerror = () => {
          console.warn('[FinanceDashboard] Recharts script failed:', src.url);
          _state.rechartsFailed = true;
          _state.rechartsLoading = false;
          resolve(false);
        };
        document.head.appendChild(tag);
      };
      loadNext();
    });
  }

  // Inline note voor tabel-fallback (alleen wanneer Recharts NIET geladen is
  // door netwerk-issue, niet wanneer hij nog laadt). Bij rechartsLoading
  // returnt het een lege string zodat de gebruiker niet ten onrechte denkt
  // dat de chart kapot is.
  function fallbackNote() {
    if (_state.rechartsFailed) {
      return '<div class="fd-fallback-note" role="status">Tabel-weergave (chart-bibliotheek niet bereikbaar via CDN).</div>';
    }
    return '';
  }

  // ── Drill-down helper ──────────────────────────────────────────────────────
  function drill(target) {
    try {
      if (typeof _state.onDrillDown === 'function') {
        _state.onDrillDown(target);
        return;
      }
    } catch (e) { console.warn('[FinanceDashboard] drill error:', e?.message); }
    // Fallback: simpele navigatie via URL (laat finance.html DOMContentLoaded
    // de target oppakken).
    try {
      const url = new URL(window.location.href);
      if (target?.view)   url.searchParams.set('tab', target.view);
      if (target?.sub)    url.searchParams.set('sub', target.sub);
      else url.searchParams.delete('sub');
      if (target?.status) url.searchParams.set('status', target.status);
      else url.searchParams.delete('status');
      window.location.href = url.toString();
    } catch (_) {}
  }

  // ── Render: shell (toolbar + grids) ────────────────────────────────────────
  function renderShell() {
    const host = _state.host;
    host.innerHTML = `
      <div class="fd-toolbar">
        <span class="fd-label">Periode</span>
        <select class="fd-select" id="fdPeriod">
          <option value="today">Vandaag</option>
          <option value="week">Deze week</option>
          <option value="month">Deze maand</option>
          <option value="quarter">Dit kwartaal</option>
          <option value="year">Dit jaar</option>
        </select>
        <button class="fd-refresh-btn" id="fdRefresh" type="button">
          <i class="ti ti-refresh"></i> Vernieuwen
        </button>
      </div>
      <div class="fd-section-title">KPI overzicht</div>
      <div class="fd-grid" id="fdGrid"></div>
      <div class="fd-section-title">Grafieken</div>
      <div class="fd-charts" id="fdCharts">
        <div class="fd-chart-panel" id="fdChartAging">
          <div class="fd-chart-title">Aging openstaand <small id="fdAgingMeta">—</small></div>
          <div class="fd-chart-host" id="fdAgingHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel" id="fdChartArrangements">
          <div class="fd-chart-title">Arrangements per status <small id="fdArrMeta">—</small></div>
          <div class="fd-chart-host" id="fdArrHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel wide" id="fdChartTopDebtors">
          <div class="fd-chart-title">Top 10 grootste openstaande klanten <small id="fdTdMeta">—</small></div>
          <div class="fd-chart-host" id="fdTdHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel" id="fdChartTasks">
          <div class="fd-chart-title">Open Acties per type <small id="fdTasksMeta">—</small></div>
          <div class="fd-chart-host" id="fdTasksHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel" id="fdChartJoost">
          <div class="fd-chart-title">Joost intents 30 dagen <small id="fdJoostMeta">—</small></div>
          <div class="fd-chart-host" id="fdJoostHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel wide" id="fdChartCashflow">
          <div class="fd-chart-title">Cashflow trend (binnenkomend 90d, verwacht 30d) <small id="fdCfMeta">—</small></div>
          <div class="fd-chart-host" id="fdCfHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
        <div class="fd-chart-panel wide" id="fdChartPayments">
          <div class="fd-chart-title">Nieuwe vs herhaal-betalingen per maand <small id="fdPmMeta">—</small></div>
          <div class="fd-chart-host" id="fdPmHost"><div class="fd-chart-placeholder">Laden…</div></div>
        </div>
      </div>
    `;
    document.getElementById('fdPeriod').value = _state.period;
  }

  // ── Render: KPI-grid ───────────────────────────────────────────────────────
  function renderKpis() {
    const grid = document.getElementById('fdGrid');
    if (!grid) return;
    const c = _state.counts;
    const skel = (cls) => `<div class="fd-card-skeleton ${cls || ''}"></div>`;

    function card({ label, value, meta, target, key }) {
      const clickable = !!target;
      const clickAttr = clickable ? ` onclick="window.FinanceDashboard.__drill(this)" data-target='${esc(JSON.stringify(target))}'` : '';
      return `
        <div class="fd-card${clickable ? ' clickable' : ''}" data-key="${esc(key)}"${clickAttr}>
          <div class="fd-card-label">${esc(label)}</div>
          <div class="fd-card-value">${value}</div>
          ${meta ? `<div class="fd-card-meta">${meta}</div>` : ''}
        </div>
      `;
    }

    if (!c) {
      // 12 skeleton cards.
      grid.innerHTML = Array.from({ length: 12 }).map((_, i) => `
        <div class="fd-card" data-key="skel${i}">
          <div class="fd-card-label">Laden…</div>
          <div class="fd-card-value">${skel()}</div>
        </div>
      `).join('');
      return;
    }

    const bb = c.bankBalans || { value: 0, fetchedAt: null, accountCount: 0 };
    const js = c.joostStats || { sent: 0, blocked: 0, intents: {} };

    const cards = [
      card({
        key: 'totaalOpenstaand',
        label: 'Totaal openstaand',
        value: fmtEur(c.totaalOpenstaand),
        meta: `${fmtInt(c.openFacturen + c.overdueFacturen)} facturen`,
        target: { view: 'facturen', status: '' },
      }),
      card({
        key: 'openFacturen',
        label: 'Open facturen',
        value: fmtInt(c.openFacturen),
        target: { view: 'facturen', status: 'open' },
      }),
      card({
        key: 'overdueFacturen',
        label: 'Te late facturen',
        value: fmtInt(c.overdueFacturen),
        target: { view: 'facturen', status: 'overdue' },
      }),
      card({
        key: 'actieveArrangements',
        label: 'Actieve arrangements',
        value: fmtInt(c.actieveArrangements),
        target: { view: 'wanbetalers', sub: 'arrangements' },
      }),
      card({
        key: 'openVerifyPayment',
        label: 'Open verify-payment',
        value: fmtInt(c.openVerifyPayment),
        target: { view: 'wanbetalers', sub: 'open-acties', status: 'PENDING' },
      }),
      card({
        key: 'openEscalations',
        label: 'Open escalaties',
        value: fmtInt(c.openEscalations),
        target: { view: 'wanbetalers', sub: 'open-acties', status: 'PENDING' },
      }),
      card({
        key: 'bankBalans',
        label: 'Bank-balans',
        value: fmtEur(bb.value),
        meta: `${fmtInt(bb.accountCount)} rekening${bb.accountCount === 1 ? '' : 'en'}${bb.fetchedAt ? ` · ${relTimeShort(bb.fetchedAt)} oud` : ''}`,
        target: { view: 'bank' },
      }),
      card({
        key: 'cashflowVerwacht30d',
        label: 'Cashflow 30 dagen',
        value: fmtEur(c.cashflowVerwacht30d),
        target: { view: 'facturen', status: '' },
      }),
      card({
        key: 'joostStats',
        label: 'Joost autonoom verzonden',
        value: fmtInt(js.sent),
        meta: `${fmtInt(js.blocked)} blocked`,
        target: { view: 'wanbetalers', sub: 'inbox' },
      }),
      card({
        key: 'conversieWanbetalersFlow',
        label: 'Conversie wanbetaler-flow',
        value: fmtPct(c.conversieWanbetalersFlow),
        target: { view: 'wanbetalers', sub: 'overzicht' },
      }),
      card({
        key: 'mentorBonusPending',
        label: 'Mentor-bonus pending',
        value: fmtEur(c.mentorBonusPending),
        // Geen drill: nog geen mentor-bonus view in Finance.
      }),
      card({
        key: 'mrrSubscriptions',
        label: 'MRR uit subscriptions',
        value: fmtEur(c.mrrSubscriptions),
        // Geen drill: Sales > Abonnementen ligt buiten Finance.
      }),
    ];

    grid.innerHTML = cards.join('');
  }

  // ── Render: Aging chart (bar) ──────────────────────────────────────────────
  function renderAgingChart() {
    const host = document.getElementById('fdAgingHost');
    const meta = document.getElementById('fdAgingMeta');
    if (!host) return;
    const d = _state.aging;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    if (meta) meta.textContent = `${fmtInt(d.totalCount)} facturen · ${fmtEur(d.totalOpenAmount)}`;
    if (d.totalCount === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen openstaande facturen.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      // Fallback: tabel.
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Bucket</th><th class="num">Aantal</th><th class="num">Bedrag</th></tr></thead>
          <tbody>${d.buckets.map(b => `
            <tr><td>${esc(b.label)}</td><td class="num">${fmtInt(b.count)}</td><td class="num">${fmtEur(b.openAmount)}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    // Recharts BarChart.
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      if (!R || !React || !ReactDOM) throw new Error('Recharts ontbreekt');
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 230 },
        React.createElement(R.BarChart, { data: d.buckets, margin: { top: 10, right: 12, left: 0, bottom: 0 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2 }),
          React.createElement(R.XAxis, { dataKey: 'label', fontSize: 11 }),
          React.createElement(R.YAxis, { fontSize: 11 }),
          React.createElement(R.Tooltip, { formatter: (v, n) => n === 'openAmount' ? fmtEur(v) : fmtInt(v) }),
          React.createElement(R.Bar, { dataKey: 'count', fill: '#06b6d4', name: 'Aantal' }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] aging chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Arrangements donut ─────────────────────────────────────────────
  function renderArrangementsChart() {
    const host = document.getElementById('fdArrHost');
    const meta = document.getElementById('fdArrMeta');
    if (!host) return;
    const d = _state.arrangements;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    if (meta) meta.textContent = `${fmtInt(d.totalCount)} totaal`;
    if (d.totalCount === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen arrangements.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Status</th><th class="num">Aantal</th></tr></thead>
          <tbody>${d.items.map(it => `
            <tr><td>${esc(it.label)}</td><td class="num">${fmtInt(it.count)}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      const colors = ['#a78bfa', '#06b6d4', '#10b981', '#ef4444', '#737580'];
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 230 },
        React.createElement(R.PieChart, null,
          React.createElement(R.Pie, {
            data: d.items, dataKey: 'count', nameKey: 'label',
            innerRadius: 50, outerRadius: 80, paddingAngle: 2,
          },
            d.items.map((_, i) => React.createElement(R.Cell, { key: i, fill: colors[i % colors.length] })),
          ),
          React.createElement(R.Tooltip, { formatter: (v) => fmtInt(v) }),
          React.createElement(R.Legend, { verticalAlign: 'bottom', height: 36, iconSize: 8, fontSize: 11 }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] arrangements chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Top 10 debiteuren ──────────────────────────────────────────────
  function renderTopDebtorsChart() {
    const host = document.getElementById('fdTdHost');
    const meta = document.getElementById('fdTdMeta');
    if (!host) return;
    const d = _state.topDebtors;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    const items = Array.isArray(d.items) ? d.items : [];
    if (meta) meta.textContent = `${fmtInt(items.length)} klanten`;
    if (items.length === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen openstaande klanten.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Klant</th><th class="num">Facturen</th><th class="num">Open</th></tr></thead>
          <tbody>${items.map(it => `
            <tr><td>${esc(it.customerName)}</td><td class="num">${fmtInt(it.openCount)}</td><td class="num">${fmtEur(it.openAmount)}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      const chartData = items.map(it => ({ name: it.customerName, openAmount: it.openAmount, openCount: it.openCount }));
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 260 },
        React.createElement(R.BarChart, { data: chartData, layout: 'vertical', margin: { top: 8, right: 18, left: 8, bottom: 0 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2, horizontal: false }),
          React.createElement(R.XAxis, { type: 'number', fontSize: 11 }),
          React.createElement(R.YAxis, { type: 'category', dataKey: 'name', fontSize: 11, width: 150 }),
          React.createElement(R.Tooltip, { formatter: (v, n) => n === 'openAmount' ? fmtEur(v) : fmtInt(v) }),
          React.createElement(R.Bar, { dataKey: 'openAmount', fill: '#f59e0b', name: 'Open bedrag' }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] top-debtors chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Open Acties per type (bar chart C6) ────────────────────────────
  function renderTasksChart() {
    const host = document.getElementById('fdTasksHost');
    const meta = document.getElementById('fdTasksMeta');
    if (!host) return;
    const d = _state.tasksByType;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    const items = Array.isArray(d.items) ? d.items : [];
    if (meta) meta.textContent = `${fmtInt(d.totalCount)} open · ${fmtInt(items.length)} types`;
    if (items.length === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen open acties.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Type</th><th class="num">Aantal</th></tr></thead>
          <tbody>${items.map(it => `
            <tr><td>${esc(it.label)}</td><td class="num">${fmtInt(it.count)}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      const data = items.map(it => ({ name: it.label, count: it.count, category: it.category }));
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 230 },
        React.createElement(R.BarChart, { data, margin: { top: 10, right: 12, left: 0, bottom: 30 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2 }),
          React.createElement(R.XAxis, { dataKey: 'name', fontSize: 10, angle: -25, textAnchor: 'end', interval: 0 }),
          React.createElement(R.YAxis, { fontSize: 11, allowDecimals: false }),
          React.createElement(R.Tooltip, { formatter: (v) => fmtInt(v) }),
          React.createElement(R.Bar, { dataKey: 'count', fill: '#10b981', name: 'Aantal' }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] tasks chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Joost intents trend (stacked line C4) ──────────────────────────
  function renderJoostIntentsChart() {
    const host = document.getElementById('fdJoostHost');
    const meta = document.getElementById('fdJoostMeta');
    if (!host) return;
    const d = _state.joostIntents;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    const series = Array.isArray(d.series) ? d.series : [];
    const dates = Array.isArray(d.dates) ? d.dates : [];
    if (meta) meta.textContent = `${fmtInt(d.totalCount)} suggesties · ${fmtInt(dates.length)} dagen`;
    if (!d.totalCount || dates.length === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Nog geen Joost-suggesties in periode.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      // Fallback: per-intent totaal-tabel.
      const totals = series.map(s => ({
        label: s.label,
        total: (s.points || []).reduce((acc, p) => acc + (p.count || 0), 0),
      })).sort((a, b) => b.total - a.total);
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Intent</th><th class="num">Totaal 30d</th></tr></thead>
          <tbody>${totals.map(t => `
            <tr><td>${esc(t.label)}</td><td class="num">${fmtInt(t.total)}</td></tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      // Flatten naar { date, [intent_label]: count, ... } voor Recharts.
      const rows = dates.map((date, idx) => {
        const row = { date };
        for (const s of series) {
          row[s.label] = (s.points && s.points[idx]) ? s.points[idx].count : 0;
        }
        return row;
      });
      const colors = ['#06b6d4', '#a78bfa', '#10b981', '#f59e0b', '#ef4444', '#737580'];
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 230 },
        React.createElement(R.AreaChart, { data: rows, margin: { top: 10, right: 12, left: 0, bottom: 0 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2 }),
          React.createElement(R.XAxis, { dataKey: 'date', fontSize: 10, tickFormatter: v => String(v).slice(5) }),
          React.createElement(R.YAxis, { fontSize: 11, allowDecimals: false }),
          React.createElement(R.Tooltip, { formatter: (v) => fmtInt(v) }),
          React.createElement(R.Legend, { fontSize: 11, iconSize: 8 }),
          ...series.map((s, i) => React.createElement(R.Area, {
            key:     s.intent,
            type:    'monotone',
            dataKey: s.label,
            stackId: '1',
            stroke:  colors[i % colors.length],
            fill:    colors[i % colors.length],
            fillOpacity: 0.55,
          })),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] joost intents chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Cashflow trend (line C7) ───────────────────────────────────────
  function renderCashflowChart() {
    const host = document.getElementById('fdCfHost');
    const meta = document.getElementById('fdCfMeta');
    if (!host) return;
    const d = _state.cashflow;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    const incoming = Array.isArray(d.incoming) ? d.incoming : [];
    const expected = Array.isArray(d.expected) ? d.expected : [];
    const totals = d.totals || { incoming: 0, expected: 0 };
    if (meta) meta.textContent = `${fmtEur(totals.incoming)} binnen · ${fmtEur(totals.expected)} verwacht`;
    if (incoming.length === 0 && expected.length === 0) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen cashflow-data.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      // Fallback: laatste 7 dagen + komende 7 dagen samenvatting.
      const lastInc = incoming.slice(-7);
      const nextExp = expected.slice(0, 7);
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Periode</th><th>Datum</th><th class="num">Bedrag</th></tr></thead>
          <tbody>
            ${lastInc.map(p => `<tr><td>Binnen</td><td>${esc(p.date)}</td><td class="num">${fmtEur(p.amount)}</td></tr>`).join('')}
            ${nextExp.map(p => `<tr><td>Verwacht</td><td>${esc(p.date)}</td><td class="num">${fmtEur(p.amount)}</td></tr>`).join('')}
          </tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      // Merge naar single rows { date, incoming, expected }.
      const byDate = new Map();
      for (const p of incoming) {
        byDate.set(p.date, { date: p.date, incoming: p.amount, expected: null });
      }
      for (const p of expected) {
        const r = byDate.get(p.date) || { date: p.date, incoming: null, expected: 0 };
        r.expected = p.amount;
        byDate.set(p.date, r);
      }
      const rows = Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 260 },
        React.createElement(R.LineChart, { data: rows, margin: { top: 10, right: 18, left: 0, bottom: 0 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2 }),
          React.createElement(R.XAxis, { dataKey: 'date', fontSize: 10, tickFormatter: v => String(v).slice(5), minTickGap: 18 }),
          React.createElement(R.YAxis, { fontSize: 11, tickFormatter: v => '€' + Math.round(v) }),
          React.createElement(R.Tooltip, { formatter: (v) => v == null ? '—' : fmtEur(v) }),
          React.createElement(R.Legend, { fontSize: 11, iconSize: 8 }),
          React.createElement(R.Line, { type: 'monotone', dataKey: 'incoming', stroke: '#10b981', strokeWidth: 2, dot: false, name: 'Binnenkomend' }),
          React.createElement(R.Line, { type: 'monotone', dataKey: 'expected', stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '4 3', dot: false, name: 'Verwacht' }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] cashflow chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Render: Nieuwe vs herhaal-betalingen (stacked bar C8) ──────────────────
  function renderPaymentsMixChart() {
    const host = document.getElementById('fdPmHost');
    const meta = document.getElementById('fdPmMeta');
    if (!host) return;
    const d = _state.paymentsMix;
    if (!d) { host.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; return; }
    const buckets = Array.isArray(d.buckets) ? d.buckets : [];
    const totals = d.totals || { firstCount: 0, repeatCount: 0 };
    if (meta) meta.textContent = `${fmtInt(totals.firstCount)} nieuw · ${fmtInt(totals.repeatCount)} herhaal`;
    if (buckets.length === 0 || (totals.firstCount === 0 && totals.repeatCount === 0)) {
      host.innerHTML = '<div class="fd-chart-placeholder">Geen betalingen in periode.</div>';
      return;
    }
    if (!_state.rechartsReady) {
      host.innerHTML = fallbackNote() + `
        <table class="fd-fallback-table">
          <thead><tr><th>Maand</th><th class="num">Nieuw</th><th class="num">Herhaal</th><th class="num">Nieuw EUR</th><th class="num">Herhaal EUR</th></tr></thead>
          <tbody>${buckets.map(b => `
            <tr>
              <td>${esc(b.month)}</td>
              <td class="num">${fmtInt(b.firstCount)}</td>
              <td class="num">${fmtInt(b.repeatCount)}</td>
              <td class="num">${fmtEur(b.firstAmount)}</td>
              <td class="num">${fmtEur(b.repeatAmount)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
      return;
    }
    try {
      const R = window.Recharts;
      const React = window.React;
      const ReactDOM = window.ReactDOM;
      const data = buckets.map(b => ({
        month:        b.month,
        Nieuw:        b.firstCount,
        Herhaal:      b.repeatCount,
        firstAmount:  b.firstAmount,
        repeatAmount: b.repeatAmount,
      }));
      host.innerHTML = '';
      const el = React.createElement(R.ResponsiveContainer, { width: '100%', height: 260 },
        React.createElement(R.BarChart, { data, margin: { top: 10, right: 12, left: 0, bottom: 0 } },
          React.createElement(R.CartesianGrid, { strokeDasharray: '3 3', opacity: 0.2 }),
          React.createElement(R.XAxis, { dataKey: 'month', fontSize: 11 }),
          React.createElement(R.YAxis, { fontSize: 11, allowDecimals: false }),
          React.createElement(R.Tooltip, { formatter: (v) => fmtInt(v) }),
          React.createElement(R.Legend, { fontSize: 11, iconSize: 8 }),
          React.createElement(R.Bar, { dataKey: 'Nieuw',   stackId: 'a', fill: '#06b6d4' }),
          React.createElement(R.Bar, { dataKey: 'Herhaal', stackId: 'a', fill: '#a78bfa' }),
        ),
      );
      ReactDOM.render(el, host);
    } catch (e) {
      console.warn('[FinanceDashboard] payments-mix chart render fail:', e?.message);
      host.innerHTML = '<div class="fd-chart-placeholder">Chart-fout (zie console).</div>';
    }
  }

  // ── Data fetching ──────────────────────────────────────────────────────────
  async function loadAll(force = false) {
    if (_state.loading) return;
    _state.loading = true;
    const btn = document.getElementById('fdRefresh');
    if (btn) btn.disabled = true;

    // Skeleton state.
    _state.counts = null;
    _state.aging = null;
    _state.topDebtors = null;
    _state.arrangements = null;
    _state.joostIntents = null;
    _state.tasksByType = null;
    _state.cashflow = null;
    _state.paymentsMix = null;
    renderKpis();
    const skel = (id) => { const h = document.getElementById(id); if (h) h.innerHTML = '<div class="fd-chart-placeholder">Laden…</div>'; };
    skel('fdAgingHost'); skel('fdTdHost'); skel('fdArrHost');
    skel('fdTasksHost'); skel('fdJoostHost'); skel('fdCfHost'); skel('fdPmHost');

    try {
      // Start recharts CDN-load parallel met data-calls.
      const rechartsReadyP = loadRechartsOnce();

      const q = (s) => `?period=${encodeURIComponent(_state.period)}${force ? '&force=true' : ''}${s ? '&' + s : ''}`;
      const f = force ? '?force=true' : '';
      const [countsRes, agingRes, tdRes, arrRes, tasksRes, joostRes, cfRes, pmRes, rechartsOk] = await Promise.allSettled([
        apiGet('/api/finance-dashboard-counts' + q()),
        apiGet('/api/finance-dashboard-chart-aging' + f),
        apiGet('/api/finance-dashboard-chart-top-debtors' + f),
        apiGet('/api/finance-dashboard-chart-arrangements' + f),
        apiGet('/api/finance-dashboard-chart-tasks' + f),
        apiGet('/api/finance-dashboard-chart-joost-intents' + f),
        apiGet('/api/finance-dashboard-chart-cashflow' + f),
        apiGet('/api/finance-dashboard-chart-payments' + f),
        rechartsReadyP,
      ]);

      _state.counts       = countsRes.status === 'fulfilled' ? countsRes.value : null;
      _state.aging        = agingRes.status  === 'fulfilled' ? agingRes.value  : null;
      _state.topDebtors   = tdRes.status     === 'fulfilled' ? tdRes.value     : null;
      _state.arrangements = arrRes.status    === 'fulfilled' ? arrRes.value    : null;
      _state.tasksByType  = tasksRes.status  === 'fulfilled' ? tasksRes.value  : null;
      _state.joostIntents = joostRes.status  === 'fulfilled' ? joostRes.value  : null;
      _state.cashflow     = cfRes.status     === 'fulfilled' ? cfRes.value     : null;
      _state.paymentsMix  = pmRes.status     === 'fulfilled' ? pmRes.value     : null;

      if (countsRes.status === 'rejected') console.warn('[FinanceDashboard] counts:', countsRes.reason?.message);
      if (agingRes.status  === 'rejected') console.warn('[FinanceDashboard] aging:',  agingRes.reason?.message);
      if (tdRes.status     === 'rejected') console.warn('[FinanceDashboard] top-debtors:', tdRes.reason?.message);
      if (arrRes.status    === 'rejected') console.warn('[FinanceDashboard] arrangements:', arrRes.reason?.message);
      if (tasksRes.status  === 'rejected') console.warn('[FinanceDashboard] tasks:', tasksRes.reason?.message);
      if (joostRes.status  === 'rejected') console.warn('[FinanceDashboard] joost-intents:', joostRes.reason?.message);
      if (cfRes.status     === 'rejected') console.warn('[FinanceDashboard] cashflow:', cfRes.reason?.message);
      if (pmRes.status     === 'rejected') console.warn('[FinanceDashboard] payments-mix:', pmRes.reason?.message);

      renderKpis();
      renderAgingChart();
      renderArrangementsChart();
      renderTopDebtorsChart();
      renderTasksChart();
      renderJoostIntentsChart();
      renderCashflowChart();
      renderPaymentsMixChart();

      if (_state.counts) {
        try {
          if (window.AgentShared?.showToast && force) window.AgentShared.showToast('Dashboard vernieuwd', 'success');
        } catch (_) {}
      }
    } catch (e) {
      console.error('[FinanceDashboard] loadAll error:', e?.message);
    } finally {
      _state.loading = false;
      if (btn) btn.disabled = false;
    }
  }

  // ── Wire-up ────────────────────────────────────────────────────────────────
  function wireOnce() {
    if (_state.wired) return;
    _state.wired = true;
    document.getElementById('fdPeriod')?.addEventListener('change', (e) => {
      _state.period = e.target.value;
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('period', _state.period);
        window.history.replaceState(null, '', url.toString());
      } catch (_) {}
      loadAll(false);
    });
    document.getElementById('fdRefresh')?.addEventListener('click', () => loadAll(true));
  }

  // ── Public mount ───────────────────────────────────────────────────────────
  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[FinanceDashboard] mount() requires {host}');
      return;
    }
    // Idempotent.
    if (_state.host === o.host && _state.wired) return;
    _state.host        = o.host;
    _state.wired       = false;
    _state.onDrillDown = typeof o.onDrillDown === 'function' ? o.onDrillDown : null;

    // Period: URL param ?period=… > opt > default 'month'.
    let initialPeriod = o.period;
    try {
      const url = new URL(window.location.href);
      const p = url.searchParams.get('period');
      if (p && ['today','week','month','quarter','year'].includes(p)) initialPeriod = p;
    } catch (_) {}
    _state.period = initialPeriod || 'month';

    injectStyles();
    renderShell();
    wireOnce();
    loadAll(false);
  }

  // ── __drill exposed voor onclick-attr in card-HTML ─────────────────────────
  function __drill(el) {
    try {
      const raw = el?.getAttribute('data-target');
      if (!raw) return;
      const target = JSON.parse(raw);
      drill(target);
    } catch (e) {
      console.warn('[FinanceDashboard] __drill parse fail:', e?.message);
    }
  }

  window.FinanceDashboard = {
    __loaded: true,
    mount,
    __drill,
  };
})();
