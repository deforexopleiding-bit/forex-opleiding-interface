// modules/klanten-v2/views/dashboard-v2.js
//
// A1 — Dashboard-view voor v2-shell (referentie-kwaliteit).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html (r1195-1815):
// helpers + DATA-mock + dashManager/dashMentor/dashMarketing/dashSales.
//
// Non-ES-module (klassieke <script>) zodat we DFO-globals rechtstreeks
// kunnen gebruiken zonder import-gedoe. Wordt door index.html geladen NA
// app-shell.js maar VÓÓR klanten-v2.js.
//
// Registreert:
//   DFO.VIEWS['dashboard/Vandaag'] = rol-bewuste renderer
//   window.KV_V2_ADD?.('dashboard')          — schrijft in V2_MODULES-set
//   window.chartHover / chartOut              — inline-handlers dualChart
//
// Data is MOCK (uit prototype). Bij goedkeuring van de layout haken we
// aparte endpoints in per KPI-tile via een data-loader-refactor.

(function () {
  if (!window.DFO) { console.error('[dashboard-v2] DFO shell niet geladen.'); return; }
  const { I, svg, ROLES, S, F, setF, modUsable, avc, ini, eur, eur0, goMod } = window.DFO;

  /* ── Helpers uit prototype ────────────────────────────────────────── */
  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const trend = (v, up) => `<span class="trend ${up === null ? 'trend-flat' : up ? 'trend-up' : 'trend-down'}">${up !== null ? svg(up ? I.up : I.arrDown) : ''}${v}</span>`;
  const spark = (d, c) => { const mx = Math.max(...d); return `<div class="spark">${d.map((v, i) => `<i class="${i === d.length - 1 ? 'hi' : ''}" style="height:${Math.max(12, v / mx * 100)}%"></i>`).join('')}</div>`; };
  const pill = (c, t) => `<span class="pill pill-${c}">${t}</span>`;

  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)" ${o.click ? `onclick="${o.click}"` : ''}>
      <div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot">${o.trend || ''}<span>${o.sub || ''}</span></div>
      ${o.spark ? spark(o.spark, o.c) : ''}</div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;

  function areaChart(data, labels) {
    const w = 100, h = 42, mx = Math.max(...data);
    const pts = data.map((v, i) => [i / (data.length - 1) * w, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs><linearGradient id="gradA" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <g class="chart-grid">${[0, .33, .66, 1].map(f => `<line x1="0" y1="${(h * f).toFixed(1)}" x2="${w}" y2="${(h * f).toFixed(1)}"/>`).join('')}</g>
      <path class="chart-area" d="${line} L${w},${h} L0,${h} Z"/>
      <path class="chart-line" d="${line}" vector-effect="non-scaling-stroke"/>
      <circle class="chart-dot" cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="1.6" vector-effect="non-scaling-stroke"/>
    </svg><div class="chart-x">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
  }

  function dualChart(id, serieA, serieB, labels, labelA, labelB, colA, colB) {
    const w = 560, h = 170, pl = 8, pr = 8, pt = 14, pb = 26;
    const all = [...serieA, ...serieB], mx = Math.max(...all) * 1.12;
    const X = i => pl + (i / (labels.length - 1)) * (w - pl - pr);
    const Y = v => pt + (1 - v / mx) * (h - pt - pb);
    const path = s => s.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    const area = s => `${path(s)} L${X(s.length - 1)},${h - pb} L${pl},${h - pb} Z`;
    return `<div style="position:relative" id="${id}-wrap">
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:190px;display:block;overflow:visible"
        onmousemove="chartHover(event,'${id}',${labels.length},${pl},${w - pr})" onmouseleave="chartOut('${id}')">
        <defs>
          <linearGradient id="${id}-gA" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--${colA})" stop-opacity=".20"/><stop offset="100%" stop-color="var(--${colA})" stop-opacity="0"/></linearGradient>
          <linearGradient id="${id}-gB" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--${colB})" stop-opacity=".16"/><stop offset="100%" stop-color="var(--${colB})" stop-opacity="0"/></linearGradient>
        </defs>
        ${[0, .25, .5, .75, 1].map(f => `<line x1="${pl}" y1="${(pt + f * (h - pt - pb)).toFixed(1)}" x2="${w - pr}" y2="${(pt + f * (h - pt - pb)).toFixed(1)}" stroke="var(--border)" stroke-width="1"/>`).join('')}
        <path d="${area(serieB)}" fill="url(#${id}-gB)"/>
        <path d="${area(serieA)}" fill="url(#${id}-gA)"/>
        <path d="${path(serieB)}" fill="none" stroke="var(--${colB})" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" style="stroke-dasharray:1400;stroke-dashoffset:1400;animation:draw 1.1s .1s ease-out forwards"/>
        <path d="${path(serieA)}" fill="none" stroke="var(--${colA})" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" style="stroke-dasharray:1400;stroke-dashoffset:1400;animation:draw 1.1s ease-out forwards"/>
        <line id="${id}-vline" x1="0" y1="${pt}" x2="0" y2="${h - pb}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
        ${serieA.map((v, i) => `<circle id="${id}-dA${i}" cx="${X(i)}" cy="${Y(v)}" r="3.6" fill="var(--surface)" stroke="var(--${colA})" stroke-width="2.2" opacity="0" style="transition:opacity .12s"/>`).join('')}
        ${serieB.map((v, i) => `<circle id="${id}-dB${i}" cx="${X(i)}" cy="${Y(v)}" r="3.6" fill="var(--surface)" stroke="var(--${colB})" stroke-width="2.2" opacity="0" style="transition:opacity .12s"/>`).join('')}
        ${labels.map((l, i) => `<text x="${X(i)}" y="${h - 7}" text-anchor="middle" font-size="10.5" fill="var(--text-3)" font-family="IBM Plex Mono">${l}</text>`).join('')}
      </svg>
      <div id="${id}-tip" style="position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;z-index:5;
        background:var(--text);color:var(--bg);border-radius:9px;padding:9px 12px;font-size:12px;box-shadow:var(--shadow-lg);white-space:nowrap"></div>
      <div style="display:flex;gap:18px;margin-top:6px;font-size:11.5px;color:var(--text-3)">
        <span style="display:flex;align-items:center;gap:6px"><span class="legend-dot" style="background:var(--${colA})"></span>${labelA}</span>
        <span style="display:flex;align-items:center;gap:6px"><span class="legend-dot" style="background:var(--${colB})"></span>${labelB}</span></div>
    </div>`;
  }
  const CHARTDATA = {};
  window.chartHover = function (e, id, n, pl, pr) {
    const svgEl = e.currentTarget, r = svgEl.getBoundingClientRect();
    const vb = 560, x = (e.clientX - r.left) / r.width * vb;
    let i = Math.round((x - pl) / ((pr - pl) / (n - 1))); i = Math.max(0, Math.min(n - 1, i));
    const d = CHARTDATA[id]; if (!d) return;
    const line = document.getElementById(id + '-vline');
    const cx = pl + (i / (n - 1)) * (pr - pl);
    line.setAttribute('x1', cx); line.setAttribute('x2', cx); line.style.opacity = '1';
    for (let k = 0; k < n; k++) {
      const a = document.getElementById(id + '-dA' + k), b = document.getElementById(id + '-dB' + k);
      if (a) a.style.opacity = k === i ? '1' : '0'; if (b) b.style.opacity = k === i ? '1' : '0';
    }
    const tip = document.getElementById(id + '-tip');
    tip.innerHTML = `<div style="font-weight:600;margin-bottom:5px;opacity:.7;font-size:11px">${d.labels[i]}</div>
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
        <span style="width:7px;height:7px;border-radius:2px;background:var(--${d.colA})"></span>
        <span style="opacity:.75">${d.labelA}</span>
        <b style="margin-left:auto;font-family:'IBM Plex Mono',monospace">${eur0(d.a[i])}</b></div>
      <div style="display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:2px;background:var(--${d.colB})"></span>
        <span style="opacity:.75">${d.labelB}</span>
        <b style="margin-left:auto;font-family:'IBM Plex Mono',monospace">${eur0(d.b[i])}</b></div>`;
    tip.style.opacity = '1';
    const px = cx / vb * r.width;
    tip.style.left = Math.min(Math.max(px - 72, 0), r.width - 165) + 'px';
    tip.style.top = '6px';
  };
  window.chartOut = function (id) {
    const l = document.getElementById(id + '-vline'); if (l) l.style.opacity = '0';
    const t = document.getElementById(id + '-tip'); if (t) t.style.opacity = '0';
    document.querySelectorAll(`[id^="${id}-dA"],[id^="${id}-dB"]`).forEach(c => c.style.opacity = '0');
  };

  /* ── Mock-data (uit prototype r1300-1440) ─────────────────────────── */
  const TAKEN_MOCK = [
    { titel: 'Bel Ebenezer Adjei — betaalafspraak', van: 'Wanbetalers', deadline: 'Vandaag', prio: 'hoog' },
    { titel: 'WIK-brief printen (4 stuks)',           van: 'Wanbetalers', deadline: 'Vandaag', prio: 'hoog' },
    { titel: 'Offerte Rachael Njoki afmaken',        van: 'Sales',        deadline: 'Morgen',  prio: 'midden' },
    { titel: 'Sessie voorbereiden — groep 4',        van: 'LMS',          deadline: 'Morgen',  prio: 'midden' },
  ];

  /* ── Live data uit /api/dashboard-stats ─────────────────────────────
     Backend ondersteunt: today | week | month. GEEN year / custom.
     Klik op Jaar/Custom toont melding + valt terug op laatst-geladen. */
  const PERIOD_LABEL_TO_PARAM = { Dag: 'today', Week: 'week', Maand: 'month' };
  // _live bundelt responses van meerdere endpoints. Elke tegel leest zijn
  // eigen slice; als slice null → tile toont MOCK-fallback met MOCK-badge.
  const _live = {
    period:   null,
    loading:  false,
    error:    null,
    // Per endpoint een eigen slot. null = niet geladen / gefaald.
    stats:    null,  // /api/dashboard-stats?period=X
    finance:  null,  // /api/finance-dashboard-counts?period=X
    tickets:  null,  // /api/tickets (counts.open)
    events:   null,  // /api/events-list?limit=6 (items[])
    sales:    null,  // /api/sales-dashboard-stats (Zoom counts)
    retention:null,  // /api/sales-retention (items[].length)
  };
  // Sequence-nummer voorkomt race conditions als user snel klikt.
  let _fetchSeq = 0;

  // Helper: fetch met fail-soft (returnt null bij error, logt).
  // 8s timeout per call → een hangende endpoint bevriest het dashboard niet.
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[dashboard-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  async function fetchDashboardBundle(labelPeriod) {
    const paramPeriod = PERIOD_LABEL_TO_PARAM[labelPeriod];
    if (!paramPeriod) return; // Jaar/Custom — geen backend
    if (_live.period === labelPeriod && _live.stats && !_live.error) {
      console.debug('[dashboard-v2] skip: reeds geladen voor', labelPeriod);
      return;
    }
    const seq = ++_fetchSeq;
    _live.loading = true;
    _live.error = null;
    console.debug('[dashboard-v2] bundle start seq=' + seq + ' period=' + labelPeriod);
    if (window.DFO && window.DFO.render) window.DFO.render();
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      // Parallel fetch — elk endpoint is fail-soft (null bij error).
      const [stats, finance, tickets, events, sales, retention] = await Promise.all([
        tryFetch('dashboard-stats',       '/api/dashboard-stats?period=' + paramPeriod),
        tryFetch('finance-counts',        '/api/finance-dashboard-counts?period=' + paramPeriod),
        tryFetch('tickets',               '/api/tickets'),
        tryFetch('events-list',           '/api/events-list?limit=6&status=draft,published'),
        tryFetch('sales-dashboard-stats', '/api/sales-dashboard-stats'),
        tryFetch('sales-retention',       '/api/sales-retention'),
      ]);
      if (seq !== _fetchSeq) {
        console.debug('[dashboard-v2] discard stale seq=' + seq + ' (current=' + _fetchSeq + ')');
        return;
      }
      _live.period    = labelPeriod;
      _live.stats     = stats;
      _live.finance   = finance;
      _live.tickets   = tickets;
      _live.events    = events;
      _live.sales     = sales;
      _live.retention = retention;
      _live.error     = stats ? null : 'dashboard-stats faalde';
      console.debug('[dashboard-v2] bundle done seq=' + seq, {
        leads:      stats?.kpis_groot?.nieuwe_leads?.value,
        mails:      stats?.kpis_klein?.mails_period,
        approvals:  stats?.kpis_klein?.pending_approvals,
        mrr:        finance?.mrrSubscriptions,
        openFact:   finance?.openFacturen,
        openTicket: tickets?.counts?.open,
        events:     Array.isArray(events?.items) ? events.items.length : null,
        zoomToday:  sales?.appointments_today_count,
        retenties:  Array.isArray(retention?.items) ? retention.items.length : null,
      });
    } catch (e) {
      if (seq !== _fetchSeq) return;
      console.error('[dashboard-v2] bundle fail seq=' + seq, e && e.message);
      _live.error = (e && e.message) || 'onbekende fout';
    } finally {
      if (seq === _fetchSeq) {
        _live.loading = false;
        if (window.DFO && window.DFO.render) window.DFO.render();
      }
    }
  }
  // Backward-compat alias (dashManager guard verwijst naar oude naam)
  const fetchDashboardStats = fetchDashboardBundle;

  // Public hook: klik op periode-chip
  window.DFO_dashPeriodClick = function (labelPeriod) {
    console.debug('[dashboard-v2] chip clicked:', labelPeriod);
    if (labelPeriod === 'Jaar' || labelPeriod === 'Custom') {
      alert('De endpoint /api/dashboard-stats ondersteunt momenteel alleen Dag/Week/Maand. '
        + 'Jaar en Custom komen zodra we het backend uitbreiden — dan gaat deze knop live.');
      return;
    }
    // Set filter (triggert render + chip-highlight)
    window.DFO.setF('per', labelPeriod);
    // Force refetch — negeer loading-state, sequence-tracking regelt race
    fetchDashboardStats(labelPeriod);
  };

  // Format helpers voor live-values
  const fmtNum = (v) => (v == null || Number.isNaN(v)) ? '—' : String(v);
  const liveOrMock = (live, mock) => (_live.stats ? (live == null ? '—' : live) : mock);
  // Lokale HTML-escape (klanten-v2.js `esc()` is ES-module, niet bereikbaar hier).
  const esc = (v) => (v == null ? '' : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const mockBadge = (title) => `<span title="${title || 'Voorbeeld-data — geen bestaand endpoint gevonden voor deze tegel'}" style="font-size:9px;font-weight:700;letter-spacing:.06em;color:var(--amber);background:var(--amber-soft);padding:1px 5px;border-radius:3px;margin-left:6px;vertical-align:2px">MOCK</span>`;
  const liveBadgeFor = (data, title) => data ? `<span title="${title || 'Live uit backend'}" style="font-size:9px;font-weight:700;letter-spacing:.06em;color:var(--emerald);background:var(--emerald-soft);padding:1px 5px;border-radius:3px;margin-left:6px;vertical-align:2px">LIVE</span>` : '';
  const liveBadge = () => liveBadgeFor(_live.stats, 'Live uit /api/dashboard-stats');
  const loadingBadge = () => _live.loading ? `<span style="font-size:10px;color:var(--text-3);margin-left:6px">laden…</span>` : '';

  /* ── Dashboard: manager/super_admin/sales (breed overzicht) ───────── */
  function dashManager() {
    const persoon = (ROLES[S.role] && ROLES[S.role].persoon) || 'Jeffrey Biemold';
    const voornaam = persoon.split(' ')[0];
    const curPeriod = F('per', 'Maand');
    // Trigger fetch als de gekozen periode nog niet geladen is (én backend-supported).
    // KRITIEK: !_live.loading-guard voorkomt render-loop. fetchDashboardBundle roept
    // render() aan met loading=true VOORDAT de bundle resolvet — dashManager loopt
    // daardoor opnieuw. Zonder loading-check triggerde die render een 2e fetch die
    // opnieuw render(), enz. → UI-thread bevroor (microtask-storm).
    if (PERIOD_LABEL_TO_PARAM[curPeriod] && _live.period !== curPeriod && !_live.loading) {
      queueMicrotask(() => fetchDashboardBundle(curPeriod));
    }
    const d = _live.stats;   // /api/dashboard-stats
    const f = _live.finance; // /api/finance-dashboard-counts
    const g = d && d.greeting || {};
    const groet = g.tijd_groet || 'Goedemorgen';
    const inzicht = g.inzicht || 'je hele bedrijf in één oogopslag';
    const nu = new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    return `<div style="padding:20px 20px 0">
      <div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:18px">
        <div style="flex:1;min-width:220px">
          <div style="font-size:23px;font-weight:600;letter-spacing:-.03em">${groet}, ${voornaam}${loadingBadge()}${liveBadge()}</div>
          <div style="font-size:13px;color:var(--text-3);margin-top:3px">${nu} · ${d ? inzicht : 'je hele bedrijf in één oogopslag'}</div>
          ${_live.error ? `<div style="font-size:12px;color:var(--rose);margin-top:6px">⚠ ${_live.error} — laatst-bekende cijfers hieronder</div>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div style="display:flex;background:var(--surface-2);border-radius:var(--r-sm);padding:3px;gap:2px">
            ${['Dag', 'Week', 'Maand', 'Jaar'].map(p => `<button class="chip ${curPeriod === p ? 'on' : ''}" style="font-size:12.5px;padding:5px 13px;border-radius:5px" onclick="DFO_dashPeriodClick('${p}')">${p}</button>`).join('')}
            <button class="chip" style="font-size:12.5px;padding:5px 13px;border-radius:5px" onclick="DFO_dashPeriodClick('Custom')">Custom ▾</button>
          </div>
          <button class="btn btn-primary" onclick="DFO.KV && DFO.KV.newAction && DFO.KV.newAction('nieuw')">${svg(I.plus)}Nieuw</button>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1.55fr 1fr;gap:14px;align-items:start">

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:4px">
            <span class="title-dot" style="background:var(--emerald);box-shadow:0 0 0 3px var(--emerald-soft)"></span>
            <div class="card-title">Leads per traject${d ? liveBadge() : mockBadge()}</div></div>
          <div class="card-body" style="padding:10px 17px 14px">
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
              ${(() => {
                // Live: nieuwe_leads.value uit dashboard-stats (totaal deze periode).
                // Per-traject-breakdown vereist eigen endpoint (leads?groupBy=traject).
                // Voor nu: eerste tile toont TOTAAL van nieuwe leads (live), rest = mock.
                const totLeads = d && d.kpis_groot && d.kpis_groot.nieuwe_leads && d.kpis_groot.nieuwe_leads.value;
                const tiles = [
                  ['Alle bronnen', totLeads != null ? totLeads : 21, 100, 'emerald', 'leads', true],
                  ['Event-aanmeldingen', 12, 36, 'teal', 'events', false],
                  ['Webinar', 0, 0, 'blue', 'leads', false],
                  ['Mini cursus', 0, 0, 'violet', 'leads', false],
                ];
                return tiles.map(([n, c, p, col, mod, isLive]) => `<div style="border:1px solid var(--border);border-radius:var(--r);padding:12px 13px;cursor:pointer;transition:all .15s;${c > 0 ? '' : 'opacity:.6'}"
                  onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'" onclick="DFO.goMod('${mod}')">
                  <div style="font-size:11.5px;color:var(--text-2);margin-bottom:5px">${n}${isLive && d ? '' : mockBadge()}</div>
                  <div style="font-size:26px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;line-height:1">${c}</div>
                  <div class="progress" style="margin-top:9px;height:3px"><i style="width:${p}%;background:var(--${col})"></i></div>
                  <div style="font-size:11px;color:var(--text-3);margin-top:5px">${isLive && d ? 'live totaal' : `${p}% van totaal`}</div></div>`).join('');
              })()}
            </div>
          </div>
        </div>

        <div class="card" style="background:linear-gradient(120deg,var(--surface),var(--teal-soft) 130%);border-color:var(--teal-line)">
          <div class="card-body" style="padding:17px">
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:13px">
              <span style="width:40px;height:40px;border-radius:50%;flex-shrink:0;
                background:radial-gradient(circle at 32% 30%,#7BC9DC,#0A7490 70%);box-shadow:0 3px 12px -2px rgba(10,116,144,.45)"></span>
              <div><div style="font-size:15.5px;font-weight:600;letter-spacing:-.02em">AI Manager</div>
              <div style="font-size:12px;color:var(--text-3)">Vraag alles over je bedrijf</div></div></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">
              ${['Hoeveel wanbetalers open?', 'Omzet deze week?', 'Wie heeft geen mentor?']
                .map(q => `<button class="chip" style="font-size:11.5px;padding:4px 10px;background:var(--surface)" onclick="alert('AI Manager: ${q}')">${q}</button>`).join('')}</div>
            <div style="position:relative">
              <input placeholder="Stel je vraag in gewone taal…" style="width:100%;box-sizing:border-box;padding:10px 48px 10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:22px;font-family:inherit;font-size:13px;color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s"
                onfocus="this.style.borderColor='var(--teal)';this.style.boxShadow='0 0 0 3px var(--teal-soft)'"
                onblur="this.style.borderColor='var(--border)';this.style.boxShadow='none'"/>
              <button style="position:absolute;right:5px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;
                background:var(--teal);color:#fff;border:0;cursor:pointer;display:grid;place-items:center;padding:0">${svg(I.up, 'width:15px;height:15px')}</button></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:6px">
            <span class="title-dot" style="background:var(--emerald);box-shadow:0 0 0 3px var(--emerald-soft)"></span>

            <div class="card-title">Omzet — getekende offertes${liveBadgeFor(f, 'Live uit /api/finance-dashboard-counts')}</div>
            <span style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--text-3)">INCL BTW</span></div>
          <div class="card-body" style="padding:6px 17px 16px">
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px">
              ${(() => {
                // MRR live uit finance-dashboard-counts. Totaal-getekende-offertes-in-periode
                // heeft geen aggregate endpoint — mock voorlopig met MOCK-badge.
                const mrr = f && typeof f.mrrSubscriptions === 'number' ? f.mrrSubscriptions : null;
                const tiles = [
                  { l: 'Abonnementen (MRR)', v: mrr != null ? mrr : 47612, s: mrr != null ? 'live · som(amount/cycle)' : '86 actief', c: 'teal', live: mrr != null },
                  { l: 'Totaal incl. btw',   v: 26250, s: '5 offertes',                                                            c: 'blue', live: false },
                ];
                return tiles.map(t => `<div style="border:1px solid var(--border);border-radius:var(--r);padding:13px 15px">
                  <div style="font-size:11.5px;color:var(--text-2);margin-bottom:6px;display:flex;align-items:center;gap:6px">
                    <span class="legend-dot" style="background:var(--${t.c})"></span>${t.l}${t.live ? '' : mockBadge('Geen aggregate-endpoint voor global omzet-total in periode')}</div>
                  <div style="font-size:25px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;line-height:1">${eur0(t.v)}</div>
                  <div style="font-size:11px;color:var(--text-3);margin-top:6px">${t.s}</div></div>`).join('');
              })()}
            </div>
            ${(() => {
              const a = [41200, 42800, 43900, 44600, 45800, 46400, 47100, 47612];
              const b = [62000, 78000, 95000, 88000, 120000, 104000, 86000, 26250];
              const lb = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug'];
              CHARTDATA['omz'] = { a, b, labels: lb, labelA: 'Abonnementen (MRR)', labelB: 'Totaal incl. btw', colA: 'teal', colB: 'blue' };
              return dualChart('omz', a, b, lb, 'Abonnementen (MRR)', 'Totaal incl. btw', 'teal', 'blue');
            })()}
            <div style="margin-top:16px;border:1px solid var(--border);border-radius:var(--r);padding:14px 15px">
              <div style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:12px">Trajecten verkocht</div>
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px">
                ${[['6 maand 1-op-1', 3, 11850, 'violet'], ['12 maand 1-op-1', 2, 14400, 'violet'],
                   ['24 maand 1-op-1', 0, 0, 'violet'], ['Membership', 0, 0, 'blue']]
                  .map(([n, c, b, col]) => `<div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px">
                    <div style="font-size:11px;color:var(--${col});font-weight:500;margin-bottom:4px">${n}</div>
                    <div style="font-size:20px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.035em;line-height:1;${c > 0 ? '' : 'color:var(--text-3)'}">${c}</div>
                    <div style="font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:4px">${eur0(b)}</div></div>`).join('')}
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:6px">
            <span class="title-dot" style="background:var(--rose);box-shadow:0 0 0 3px var(--rose-soft)"></span>
            <div class="card-title">Vereist jouw actie</div></div>
          <div class="card-body" style="padding:4px 15px 15px;display:flex;flex-direction:column;gap:8px">
            ${(() => {
              // Live-wire uit meerdere endpoints:
              //   Open tickets    → /api/tickets counts.open
              //   Retentie        → /api/sales-retention items.length
              //   Goedkeuringen   → /api/dashboard-stats kpis_klein.pending_approvals
              //   Vastgelopen     → /api/finance-dashboard-counts openEscalations (approximate)
              //   Openstaande fac → /api/finance-dashboard-counts openFacturen
              //   Bel-acties      → geen dedicated endpoint (follow-up-cockpit telt gedane calls,
              //                     niet openstaande) — MOCK met melding
              const approvals    = d && d.kpis_klein && d.kpis_klein.pending_approvals;
              const openTickets  = _live.tickets && _live.tickets.counts && _live.tickets.counts.open;
              const retentie     = _live.retention && Array.isArray(_live.retention.items) ? _live.retention.items.length : null;
              const escalaties   = f && typeof f.openEscalations === 'number' ? f.openEscalations : null;
              const openFacturen = f && typeof f.openFacturen === 'number' ? f.openFacturen : null;
              const items = [
                [openTickets != null ? openTickets : 0, 'Open tickets',            'Support',              'slate', 'tickets',     openTickets != null],
                [retentie != null ? retentie : 6,       'Retentie te laat',        'Sales · afloop <30d',  'amber', 'sales',       retentie != null],
                [approvals != null ? approvals : 0,     'Goedkeuringen open',      'Control Center',       'slate', 'binnenkort',  approvals != null],
                [escalaties != null ? escalaties : 41,  'Vastgelopen gesprekken',  'Wanbetalers-escalatie','rose',  'wanbetalers', escalaties != null],
                [54,                                    'Bel-acties te doen',      'Wanbetalers',          'amber', 'wanbetalers', false],
                [openFacturen != null ? openFacturen : 210, 'Openstaande facturen','Wanbetalers',          'amber', 'finance',     openFacturen != null],
              ];
              return items
              .filter(([n, t, s, c, mod]) => modUsable(mod))
              .map(([n, t, s, c, mod, isLive]) => `<button style="display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--border);
                border-radius:var(--r);background:var(--surface);width:100%;text-align:left;transition:all .15s"
                onmouseover="this.style.borderColor='var(--border-strong)';this.style.transform='translateX(2px)'"
                onmouseout="this.style.borderColor='var(--border)';this.style.transform='none'" onclick="DFO.goMod('${mod}')">
                <span style="font-size:21px;font-weight:700;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;min-width:38px;
                  color:${n === 0 ? 'var(--text-3)' : `var(--${c})`}">${n}</span>
                <span style="flex:1"><span style="display:block;font-size:13.5px;font-weight:500">${t}${isLive ? '' : mockBadge()}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-3)">${s}</span></span>
                ${svg('<path d="M5 12h14M13 6l6 6-6 6"/>', 'width:15px;height:15px;color:var(--text-3)')}</button>`).join('');
            })()}
          </div>
        </div>
      </div>

      <div class="grid g3" style="margin-top:14px">
        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:4px">
            <span class="title-dot" style="background:var(--teal);box-shadow:0 0 0 3px var(--teal-soft)"></span>
            <div class="card-title">Zoom-afspraken${liveBadgeFor(_live.sales, 'Live uit /api/sales-dashboard-stats')}</div></div>
          <div class="card-body" style="text-align:center;padding-top:10px">
            ${(() => {
              // Live: appointments_today_count + tomorrow uit sales-dashboard-stats.
              // Week-count komt uit week.appointments (aggregate over huidige week).
              // Maand-count heeft geen endpoint-veld → MOCK.
              const s = _live.sales;
              const todayCnt = s && typeof s.appointments_today_count === 'number' ? s.appointments_today_count : null;
              const tomorrowCnt = s && typeof s.appointments_tomorrow_count === 'number' ? s.appointments_tomorrow_count : null;
              const weekCnt = s && s.week && typeof s.week.appointments === 'number' ? s.week.appointments : null;
              const bigVal = todayCnt != null ? todayCnt : 4;
              return `
                <div style="font-size:44px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.05em;color:var(--teal);line-height:1">${bigVal}</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:5px;margin-bottom:16px">vandaag gepland${todayCnt != null ? '' : mockBadge()}</div>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:9px">
                  ${[[todayCnt != null ? todayCnt : 4, 'VANDAAG', todayCnt != null],
                     [tomorrowCnt != null ? tomorrowCnt : 3, 'MORGEN', tomorrowCnt != null],
                     [weekCnt != null ? weekCnt : 22, 'WEEK', weekCnt != null]]
                    .map(([v, l, isLive]) => `
                    <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 6px">
                      <div style="font-size:18px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.03em">${v}</div>
                      <div style="font-size:9.5px;letter-spacing:.08em;color:var(--text-3);margin-top:2px">${l}${isLive ? '' : mockBadge()}</div></div>`).join('')}
                </div>`;
            })()}
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:4px">
            <span class="title-dot" style="background:var(--teal);box-shadow:0 0 0 3px var(--teal-soft)"></span>
            <div class="card-title">Postvakken</div></div>
          <div class="card-body" style="padding:6px 15px 15px;display:flex;flex-direction:column;gap:7px">
            ${(() => {
              // Live-wire uit meerdere endpoints (alleen LEZEND — geen mutatie):
              //   Wanbetalers    → finance.openVerifyPayment + finance.openEscalations
              //                    (som van actionable inbox-items; alleen read count)
              //   Events         → events-list items.length (draft+published)
              //   E-mail         → dashboard-stats kpis_klein.mails_period (al live)
              //   Leadsonderhoud → geen dedicated count-endpoint → MOCK
              //   Onboarding     → geen dedicated count-endpoint → MOCK
              //   Lisa AI        → geen dedicated count-endpoint → MOCK
              const mails = d && d.kpis_klein && d.kpis_klein.mails_period;
              const wbxCount = f && (typeof f.openVerifyPayment === 'number' || typeof f.openEscalations === 'number')
                ? (f.openVerifyPayment || 0) + (f.openEscalations || 0)
                : null;
              const eventsCount = _live.events && Array.isArray(_live.events.items) ? _live.events.items.length : null;
              const tiles = [
                ['Wanbetalers',    wbxCount != null ? wbxCount : 4,   'amber',  I.alert,  'wanbetalers',    wbxCount != null],
                ['Leadsonderhoud', 0,                                 'teal',   I.repeat, 'leadsonderhoud', false],
                ['Onboarding',     0,                                 'emerald', I.route, 'onboarding',     false],
                ['Lisa AI',        2,                                 'violet', I.bot,    'lisa',           false],
                ['Events',         eventsCount != null ? eventsCount : 3, 'pink', I.cal,  'events',         eventsCount != null],
                ['E-mail',         mails != null ? mails : 989,       'blue',   I.mail,  'email',           mails != null],
              ];
              return tiles
                .filter(([n, c, col, ic, mod]) => modUsable(mod))
                .map(([n, c, col, ic, mod, isLive]) => `<button style="display:flex;align-items:center;gap:11px;padding:10px 13px;border:1px solid var(--border);
                  border-radius:var(--r);background:var(--surface);width:100%;text-align:left;transition:all .15s"
                  onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'" onclick="DFO.goMod('${mod}')">
                  <span class="tile-ico" style="width:26px;height:26px;border-radius:7px;background:var(--${col}-soft);color:var(--${col})">${svg(ic, 'width:14px;height:14px')}</span>
                  <span style="flex:1;font-size:13px;font-weight:500">${n}${isLive ? '' : mockBadge()}</span>
                  <span style="font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:20px;font-family:'IBM Plex Mono',monospace;
                    background:${c === 0 ? 'var(--surface-2)' : 'var(--rose)'};color:${c === 0 ? 'var(--text-3)' : '#fff'}">${c}</span></button>`).join('');
            })()}
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:4px">
            <span class="title-dot" style="background:var(--emerald);box-shadow:0 0 0 3px var(--emerald-soft)"></span>
            <div class="card-title">Mijn taken${d && d.tasks ? liveBadge() : mockBadge()}</div>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto;background:none;color:var(--m)" onclick="DFO.goMod('taken')">Takenbeheer →</button></div>
          <div class="card-body" style="padding:6px 15px 15px;display:flex;flex-direction:column;gap:7px">
            ${(() => {
              // Live: tasks.items uit dashboard-stats (max 4 tonen).
              const live = d && d.tasks && Array.isArray(d.tasks.items) ? d.tasks.items : null;
              const items = live && live.length
                ? live.slice(0, 4).map(t => ({
                    titel: t.titel || '(geen titel)',
                    van: '', // geen "van" in dashboard-stats task-item
                    deadline: t.deadline ? new Date(t.deadline).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—',
                    prio: (t.prioriteit || '').toLowerCase() === 'urgent' || (t.prioriteit || '').toLowerCase() === 'hoog' ? 'hoog' : 'midden',
                  }))
                : TAKEN_MOCK.slice(0, 4);
              if (!items.length) return `<div style="font-size:12.5px;color:var(--text-3);padding:8px 4px">Geen openstaande taken 🎉</div>`;
              return items.map(t => `<div style="display:flex;align-items:center;gap:11px;padding:10px 13px;border:1px solid var(--border);border-radius:var(--r)">
                <div class="checkbox"></div>
                <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.titel}</div>
                <div style="font-size:11px;color:var(--text-3)">${t.van ? t.van + ' · ' : ''}${t.deadline}</div></div>
                ${t.prio === 'hoog' ? `<span class="legend-dot" style="background:var(--rose)"></span>` : ''}</div>`).join('');
            })()}
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px;margin-bottom:20px">
        <div class="card-head" style="border-bottom:none;padding-bottom:4px">
          <span class="title-dot" style="background:var(--teal);box-shadow:0 0 0 3px var(--teal-soft)"></span>
          <div class="card-title">Eerstkomende events — status aanmeldingen${liveBadgeFor(_live.events, 'Live uit /api/events-list')}</div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto;background:none;color:var(--m)" onclick="DFO.goMod('events')">Events →</button></div>
        <div class="card-body" style="padding:6px 15px 15px;display:flex;flex-direction:column;gap:8px">
          ${(() => {
            // Live: events-list items (chronologisch komende events).
            //   title / starts_at / location / attendee_count_active / capacity → live
            //   VRAGENLIJST / GEBELD progress → MOCK (geen aggregate endpoint per event
            //   voor vragenlijst-status en cold-call-status)
            const evItems = _live.events && Array.isArray(_live.events.items) ? _live.events.items : null;
            const MOCK_ROWS = [
              ['Forex Masterclass Gent', 'za 8 aug · 10:00', 'België - Deinsesteenweg 108 | 9031 Drongen (Gent)', 8, 8],
              ['Forex Masterclass Gent', 'wo 12 aug · 18:00', 'België - Deinsesteenweg 108 | 9031 Drongen (Gent)', 7, 8],
              ['Forex Masterclass Gent', 'za 15 aug · 10:00', 'België - Deinsesteenweg 108 | 9031 Drongen (Gent)', 2, 8],
              ['Forex Masterclass Gent', 'wo 19 aug · 18:00', 'België - Deinsesteenweg 108 | 9031 Drongen (Gent)', 0, 8],
              ['Forex Masterclass Gent', 'za 22 aug · 10:00', 'België - Deinsesteenweg 108 | 9031 Drongen (Gent)', 0, 8],
            ];
            const fmtDt = (iso) => {
              try {
                const dObj = new Date(iso);
                const days = ['zo','ma','di','wo','do','vr','za'];
                const months = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
                const hh = String(dObj.getHours()).padStart(2,'0');
                const mm = String(dObj.getMinutes()).padStart(2,'0');
                return `${days[dObj.getDay()]} ${dObj.getDate()} ${months[dObj.getMonth()]} · ${hh}:${mm}`;
              } catch (_) { return iso; }
            };
            const rows = evItems && evItems.length
              ? evItems.slice(0, 5).map(ev => [
                  ev.title || 'Event',
                  ev.starts_at ? fmtDt(ev.starts_at) : '—',
                  ev.location || '—',
                  typeof ev.attendee_count_active === 'number' ? ev.attendee_count_active : 0,
                  typeof ev.capacity === 'number' ? ev.capacity : 8,
                  true, // live
                ])
              : MOCK_ROWS.map(r => [...r, false]);
            return rows.map(([title, dt, loc, ing, cap, isLive]) => {
              // Mock voor vragenlijst + gebeld — geen aggregate endpoint per event.
              const vl = isLive ? 0 : Math.min(cap, ing);
              const vlt = cap;
              const gb = isLive ? 0 : Math.min(cap, ing);
              const gbt = cap;
              return `<button style="display:flex;align-items:center;gap:22px;padding:13px 15px;border:1px solid var(--border);
                border-radius:var(--r);background:var(--surface);width:100%;text-align:left;transition:all .15s"
                onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'" onclick="DFO.goMod('events')">
                <span style="flex:1;min-width:150px"><span style="display:block;font-size:13.5px;font-weight:600">${esc(title)}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-3);margin-top:1px">${esc(dt)} · ${esc(loc)}</span></span>
                <span style="flex:1;max-width:230px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.02em">
                    ${vl}<span style="font-size:11px;color:var(--text-3)">/${vlt}</span></span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin:3px 0 6px">VRAGENLIJST${mockBadge('Geen aggregate endpoint per event')}</span>
                  <span class="progress" style="display:block;height:3px"><i style="width:${vlt ? vl / vlt * 100 : 0}%;background:var(--teal)"></i></span></span>
                <span style="width:96px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;${ing > 0 ? '' : 'color:var(--text-3)'}">${ing}</span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin-top:3px">INGESCHREVEN${isLive ? '' : mockBadge()}</span></span>
                <span style="flex:1;max-width:230px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.02em;${gb > 0 ? '' : 'color:var(--text-3)'}">
                    ${gb}<span style="font-size:11px;color:var(--text-3)">/${gbt}</span></span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin:3px 0 6px">GEBELD${mockBadge('Geen aggregate endpoint per event')}</span>
                  <span class="progress" style="display:block;height:3px"><i style="width:${gbt ? gb / gbt * 100 : 0}%;background:var(--emerald)"></i></span></span>
              </button>`;
            }).join('');
          })()}
        </div>
      </div>
    </div>`;
  }

  /* ── Dashboard: mentor (persoonlijk) — compact uit prototype r1706 ── */
  function dashMentor() {
    return `${kpis([
      { c: 'teal', icon: I.users, label: 'Mijn leerlingen', val: '24', sub: 'actief in begeleiding' },
      { c: 'pink', icon: I.cal, label: 'Sessies deze week', val: '6', hi: 1, sub: '3 nog te plannen' },
      { c: 'emerald', icon: I.chart, label: 'Gem. voortgang', val: '64%', hi: 1, sub: 'over alle modules', trend: trend('+5%', true) },
      { c: 'amber', icon: I.alert, label: 'Vragen aandacht', val: '3', hi: 1, sub: 'weinig activiteit' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div class="grid g2">
        <div class="card card-hover">
          <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span>
            <div class="card-title">Mijn agenda vandaag</div></div>
          <div class="card-list">
            ${[['09:00', 'Sessie — Cabdi Ibrahim', '1-op-1'], ['11:00', 'Sessie — Nikita Bykov', '1-op-1'],
               ['14:00', 'Groepssessie — Basis marktstructuur', 'Groep 4'], ['16:00', 'Intake — Emile Rabaut', 'Nieuw']]
              .map(([t, n, s]) => `<div class="cl-row"><span class="mono" style="color:var(--text-3);width:44px">${t}</span>
              <div style="flex:1"><div class="cell-main">${n}</div><div class="cell-sub">${s}</div></div>
              <button class="btn btn-ghost btn-sm">Openen</button></div>`).join('')}
          </div>
        </div>
        <div class="card card-hover">
          <div class="card-head"><span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.alert)}</span>
            <div class="card-title">Leerlingen die aandacht vragen</div></div>
          <div class="card-list">
            ${[['Dyami Van Praag', '3 weken geen activiteit', 22], ['Christa Noltus Haarkamp', 'Voortgang gestagneerd', 41],
               ['Jennifer Botaka', 'Sessie 2× verzet', 18]]
              .map(([n, r, p]) => `<div class="cl-row" style="cursor:pointer">${av(n, 30)}
              <div style="flex:1"><div class="cell-main">${n}</div><div class="cell-sub">${r}</div>
              <div class="progress" style="max-width:120px"><i style="width:${p}%"></i></div></div>
              <span class="mono" style="font-size:12px;color:var(--text-3)">${p}%</span></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ── Dashboard: marketing (uit prototype r1781) ───────────────────── */
  function dashMarketing() {
    const SOCIALS = [
      ['YouTube', 'YT', 'rose', '12,4K', '+3,2%', '48K weergaven'],
      ['Meta', 'Ⓕ', 'blue', '28,1K', '+5,1%', '112K bereik'],
      ['TikTok', 'TT', 'slate', '19,7K', '+12,4%', '204K views'],
      ['LinkedIn', 'in', 'accent', '6,2K', '+4,0%', '21K bereik'],
      ['Google', 'G', 'amber', '—', '—', '86K impressies'],
    ];
    return `${kpis([
      { c: 'violet', icon: I.megafoon || I.rocket, label: 'Bereik deze maand', val: '471K', hi: 1, sub: 'over alle kanalen', trend: trend('+18%', true), spark: [210, 240, 260, 300, 330, 380, 420, 471] },
      { c: 'emerald', icon: I.users, label: 'Nieuwe volgers', val: '+2.140', hi: 1, sub: 'deze maand', trend: trend('+6,4%', true) },
      { c: 'blue', icon: I.chart, label: 'Engagement', val: '5,8%', sub: 'gem. over posts', trend: trend('+0,7%', true) },
      { c: 'amber', icon: I.target, label: 'Leads via socials', val: '193', hi: 1, sub: 'deze maand', trend: trend('+61%', true) },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="display:flex;align-items:flex-start;gap:11px;padding:13px 15px;background:var(--violet-soft);border:1px solid var(--violet-line);border-radius:var(--r);margin-bottom:16px;font-size:12.5px;color:var(--violet)">
        ${svg(I.rocket, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}<span><b>In opbouw.</b> De volledige postplanner en Creative Studio worden hier binnenkort toegevoegd. Dit is een voorproefje.</span></div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.chart)}</span>
          <div class="card-title">Kanaalprestaties</div></div>
        <div class="card-body">
          ${SOCIALS.map(([n, ab, c, vol, gr, br]) => `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
            <span style="width:34px;height:34px;border-radius:9px;background:var(--${c}-soft);color:var(--${c});display:grid;place-items:center;font-weight:700;font-size:12.5px;flex-shrink:0">${ab}</span>
            <div style="flex:1;min-width:0"><div class="cell-main" style="font-size:13px">${n}</div><div class="cell-sub">${br}</div></div>
            <div style="text-align:right"><div class="mono" style="font-size:14px;font-weight:600">${vol}</div><div style="font-size:11.5px;color:${gr.startsWith('+') ? 'var(--emerald)' : 'var(--text-3)'}">${gr}</div></div></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  /* ── Rol-bewuste dispatcher ───────────────────────────────────────── */
  window.DFO.VIEWS['dashboard/Vandaag'] = () => {
    const r = S.role;
    if (r === 'mentor')    return dashMentor();
    if (r === 'marketing') return dashMarketing();
    return dashManager();
  };
  window.DFO.VIEWS['dashboard/'] = window.DFO.VIEWS['dashboard/Vandaag'];

  // Meld aan bij V2_MODULES-set zodat legacy-fallback dashboard binnen shell houdt.
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('dashboard');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('dashboard');

  console.log('[dashboard-v2] geladen — 3 rol-varianten + mock-data');
})();
