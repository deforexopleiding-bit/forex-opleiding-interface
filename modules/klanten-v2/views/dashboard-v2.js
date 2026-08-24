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
  // Premium omzet-chart — Ronde-23 definitieve full-width fix.
  // Aanpak: omzChart() rendert alleen een PLACEHOLDER-container met vaste
  // hoogte. _mountOmzChart() meet clientWidth en tekent de SVG met viewBox
  // = "0 0 W H" (1 user-unit = 1 px) → nooit preserveAspectRatio-padding,
  // dus geen witruimte + geen hover-offset. ResizeObserver herbeschouwt bij
  // container-resize. Data bewaart in _omzData[id]; DFO.render() regenereert
  // de placeholder, ensure-mount hook triggert de tekening opnieuw.
  const _omzData = {};
  const _omzObservers = new Map(); // wrapEl → ResizeObserver
  function omzChart(id, serieA, serieB, labels, labelA, labelB, colA, colB, nowIdx, years) {
    _omzData[id] = { serieA, serieB, labels: labels || [], years: years || [], labelA, labelB, colA, colB, nowIdx };
    return `<div id="${id}-wrap" class="omz-chart-container" style="position:relative;height:230px;width:100%">
      <div id="${id}-tip" style="position:absolute;pointer-events:none;opacity:0;transition:opacity .12s;z-index:5;background:var(--text);color:var(--bg);border-radius:9px;padding:9px 12px;font-size:12px;box-shadow:var(--shadow-lg);white-space:nowrap"></div>
      <div style="position:absolute;bottom:-4px;left:17px;right:17px;display:flex;gap:18px;font-size:11.5px;color:var(--text-3)">
        <span style="display:flex;align-items:center;gap:6px"><span class="legend-dot" style="background:var(--${colA})"></span>${labelA}</span>
        <span style="display:flex;align-items:center;gap:6px"><span class="legend-dot" style="background:var(--${colB})"></span>${labelB}</span>
      </div>
      <style>@keyframes omzDraw { to { stroke-dashoffset:0 } }</style>
    </div>`;
  }
  function _ensureOmzMounted(id) {
    const wrap = document.getElementById(id + '-wrap');
    if (!wrap || !_omzData[id]) return;
    _renderOmzInto(wrap, id);
    // (Her)hook ResizeObserver zodat het bij window/panel-resize herbeschouwt.
    // Oude observer op vorige element auto-cleaned door WeakMap? Nee — Map,
    // dus we cleanen expliciet als er een oude entry aan een ander element
    // hing. Als deze wrap-element al observed → niets doen (idempotent).
    if (_omzObservers.has(wrap)) return;
    const ro = new ResizeObserver(() => _renderOmzInto(wrap, id));
    ro.observe(wrap);
    _omzObservers.set(wrap, ro);
    // Cleanup wanneer element verdwijnt (via MutationObserver op body — één
    // instance genoeg voor alle chart-obs). Simpel: bij nieuwe render van de
    // dashboard verliest wrap z'n parent; volgende _ensureOmzMounted-run
    // krijgt een nieuw element en oude observer + Map-entry raakt de node
    // die niet meer bestaat — laat 'm gewoon met de garbage naar geheugen
    // (ResizeObserver houdt geen strong ref naar geobserveerde node; wij wel
    // in de Map — daarom hier defensive prune bij elke render).
    for (const [el, obs] of _omzObservers) {
      if (!el.isConnected) { obs.disconnect(); _omzObservers.delete(el); }
    }
  }
  function _renderOmzInto(wrap, id) {
    const d = _omzData[id];
    if (!d) return;
    const rect = wrap.getBoundingClientRect();
    const W = Math.max(200, Math.round(rect.width || wrap.clientWidth || 640));
    const H = 200;
    const pl = 42, pr = 12, pt = 18, pb = 42;
    const n  = d.labels.length;
    const all = [...(d.serieA || []), ...(d.serieB || [])].filter(v => Number.isFinite(v));
    const mx  = Math.max(1, Math.max(...(all.length ? all : [1])) * 1.12);
    const X = i => pl + (i / Math.max(1, n - 1)) * (W - pl - pr);
    const Y = v => pt + (1 - v / mx) * (H - pt - pb);
    function monotonePath(pts) {
      if (pts.length < 2) return '';
      const nn = pts.length;
      const dx = new Array(nn - 1), dy = new Array(nn - 1), m = new Array(nn - 1);
      for (let i = 0; i < nn - 1; i++) { dx[i] = pts[i+1][0] - pts[i][0]; dy[i] = pts[i+1][1] - pts[i][1]; m[i] = dy[i] / (dx[i] || 1); }
      const tan = new Array(nn); tan[0] = m[0]; tan[nn-1] = m[nn-2];
      for (let i = 1; i < nn - 1; i++) { if (m[i-1] * m[i] <= 0) tan[i] = 0; else tan[i] = (m[i-1] + m[i]) / 2; }
      let out = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
      for (let i = 0; i < nn - 1; i++) {
        const c1x = pts[i][0]   + dx[i] / 3;
        const c1y = pts[i][1]   + tan[i]   * dx[i] / 3;
        const c2x = pts[i+1][0] - dx[i] / 3;
        const c2y = pts[i+1][1] - tan[i+1] * dx[i] / 3;
        out += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i+1][0].toFixed(1)},${pts[i+1][1].toFixed(1)}`;
      }
      return out;
    }
    const ptsA = d.serieA.map((v, i) => [X(i), Y(Number.isFinite(v) ? v : 0)]);
    const ptsB = [];
    for (let i = 0; i < d.serieB.length; i++) {
      const v = d.serieB[i]; if (v == null) break;
      ptsB.push([X(i), Y(v)]);
    }
    const pathA = monotonePath(ptsA);
    const pathB = monotonePath(ptsB);
    const areaA = ptsA.length ? `${pathA} L${ptsA[ptsA.length-1][0].toFixed(1)},${(H-pb).toFixed(1)} L${ptsA[0][0].toFixed(1)},${(H-pb).toFixed(1)} Z` : '';
    const areaB = ptsB.length ? `${pathB} L${ptsB[ptsB.length-1][0].toFixed(1)},${(H-pb).toFixed(1)} L${ptsB[0][0].toFixed(1)},${(H-pb).toFixed(1)} Z` : '';
    const nowLine = (typeof d.nowIdx === 'number' && d.nowIdx >= 0 && d.nowIdx < n)
      ? `<line x1="${X(d.nowIdx).toFixed(1)}" y1="${pt}" x2="${X(d.nowIdx).toFixed(1)}" y2="${(H-pb).toFixed(1)}" stroke="var(--text-3)" stroke-width="1" stroke-dasharray="2 4" opacity=".4"/>
         <text x="${X(d.nowIdx).toFixed(1)}" y="${(pt - 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-3)" font-family="IBM Plex Mono">nu</text>`
      : '';
    const glowAIdx = (typeof d.nowIdx === 'number' && d.nowIdx >= 0) ? d.nowIdx : ptsA.length - 1;
    const lastA = ptsA[glowAIdx];
    const lastB = ptsB[ptsB.length - 1];
    const gridY = [0, .25, .5, .75, 1].map(f => pt + f * (H - pt - pb));
    const gridLabels = [0, .25, .5, .75, 1].map(f => { const v = mx * (1 - f); return v >= 1000 ? `€${Math.round(v/1000)}k` : `€${Math.round(v)}`; });
    // X-as: maand-labels + jaar-labels bij i=0 én bij elke januari-tick.
    const monthLabels = d.labels.map((l, i) => `<text x="${X(i).toFixed(1)}" y="${(H - 22).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--text-3)" font-family="IBM Plex Mono">${l}</text>`).join('');
    const yearLabels = d.labels.map((l, i) => {
      const showYear = (i === 0) || String(l).toLowerCase() === 'jan';
      if (!showYear || !d.years[i]) return '';
      return `<text x="${X(i).toFixed(1)}" y="${(H - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-3)" font-family="IBM Plex Mono" opacity=".7">${d.years[i]}</text>`;
    }).join('');
    const svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="display:block"
      onmousemove="chartHover(event,'${id}',${n},${pl},${W - pr})" onmouseleave="chartOut('${id}')">
      <defs>
        <linearGradient id="${id}-gA" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--${d.colA})" stop-opacity=".35"/>
          <stop offset="55%" stop-color="var(--${d.colA})" stop-opacity=".08"/>
          <stop offset="100%" stop-color="var(--${d.colA})" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="${id}-gB" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--${d.colB})" stop-opacity=".28"/>
          <stop offset="55%" stop-color="var(--${d.colB})" stop-opacity=".06"/>
          <stop offset="100%" stop-color="var(--${d.colB})" stop-opacity="0"/>
        </linearGradient>
        <filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" result="blur"/>
          <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      ${gridY.map((yy, i) => `<line x1="${pl}" y1="${yy.toFixed(1)}" x2="${W - pr}" y2="${yy.toFixed(1)}" stroke="var(--border)" stroke-width="0.6" stroke-dasharray="${i === gridY.length - 1 ? '' : '3 4'}"/>`).join('')}
      ${gridLabels.map((lbl, i) => `<text x="${pl - 6}" y="${(gridY[i] + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="var(--text-3)" font-family="IBM Plex Mono">${lbl}</text>`).join('')}
      ${nowLine}
      <path d="${areaB}" fill="url(#${id}-gB)"/>
      <path d="${areaA}" fill="url(#${id}-gA)"/>
      <path d="${pathB}" fill="none" stroke="var(--${d.colB})" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="2000" stroke-dashoffset="2000" style="animation:omzDraw 1.15s .1s cubic-bezier(.5,.05,.35,1) forwards"/>
      <path d="${pathA}" fill="none" stroke="var(--${d.colA})" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="2000" stroke-dashoffset="2000" style="animation:omzDraw 1.25s cubic-bezier(.5,.05,.35,1) forwards"/>
      <line id="${id}-vline" x1="0" y1="${pt}" x2="0" y2="${H - pb}" stroke="var(--border-strong)" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
      ${ptsA.map((p, i) => `<circle id="${id}-dA${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.8" fill="var(--surface)" stroke="var(--${d.colA})" stroke-width="2.2" opacity="0" style="transition:opacity .12s"/>`).join('')}
      ${ptsB.map((p, i) => `<circle id="${id}-dB${i}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.8" fill="var(--surface)" stroke="var(--${d.colB})" stroke-width="2.2" opacity="0" style="transition:opacity .12s"/>`).join('')}
      ${lastA ? `<circle cx="${lastA[0].toFixed(1)}" cy="${lastA[1].toFixed(1)}" r="5" fill="var(--${d.colA})" filter="url(#${id}-glow)" opacity=".85"/>` : ''}
      ${lastB ? `<circle cx="${lastB[0].toFixed(1)}" cy="${lastB[1].toFixed(1)}" r="5" fill="var(--${d.colB})" filter="url(#${id}-glow)" opacity=".85"/>` : ''}
      ${monthLabels}
      ${yearLabels}
    </svg>`;
    // Vervang bestaande SVG (indien aanwezig), NIET tip/legend/style-nodes.
    const oldSvg = wrap.querySelector('svg');
    if (oldSvg) oldSvg.remove();
    wrap.insertAdjacentHTML('afterbegin', svg);
    // CHARTDATA-slot voor hover (labels + waarden per index).
    CHARTDATA[id] = { a: d.serieA, b: d.serieB, labels: d.labels, years: d.years, labelA: d.labelA, labelB: d.labelB, colA: d.colA, colB: d.colB, nowIdx: d.nowIdx };
  }
  // Public mount-hook: dashManager roept dit via queueMicrotask na render.
  window._omzEnsureMounted = _ensureOmzMounted;
  const CHARTDATA = {};
  window.chartHover = function (e, id, n, pl, pr) {
    const svgEl = e.currentTarget;
    // Ronde-22 PUNT-2: gebruik SVG createSVGPoint + getScreenCTM.inverse()
    // voor exacte viewBox-coord conversion. Vorige formule (r.width * vb) was
    // fout wanneer preserveAspectRatio="xMidYMid meet" (default) padding aan
    // de zijkanten introduceerde omdat wrapper-aspect-ratio ≠ viewBox-ratio.
    // Concreet: wrapper 700×210px, viewBox 640×200 → SVG rendert 672px breed
    // met 14px meet-padding l/r → hover-index viel systematisch te vroeg.
    let x;
    try {
      const pt  = svgEl.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
      const ctm = svgEl.getScreenCTM();
      if (!ctm) throw new Error('no ctm');
      x = pt.matrixTransform(ctm.inverse()).x;
    } catch (_) {
      // Fallback: naïeve bounding-rect mapping (voor SVG's zonder CTM).
      const r  = svgEl.getBoundingClientRect();
      const vb = (svgEl.viewBox && svgEl.viewBox.baseVal && svgEl.viewBox.baseVal.width) || 560;
      x = (e.clientX - r.left) / (r.width || 1) * vb;
    }
    // Bereken index binnen de plot-area [pl..pr]. n = aantal punten.
    // pr in signature = w - pr_marge = rechter-plot-edge. Step = (pr-pl)/(n-1).
    let i;
    if (n <= 1) i = 0;
    else i = Math.round((x - pl) / ((pr - pl) / (n - 1)));
    i = Math.max(0, Math.min(n - 1, i));
    const d = CHARTDATA[id]; if (!d) return;
    const line = document.getElementById(id + '-vline');
    const cx = pl + (i / (n - 1)) * (pr - pl);
    line.setAttribute('x1', cx); line.setAttribute('x2', cx); line.style.opacity = '1';
    for (let k = 0; k < n; k++) {
      const a = document.getElementById(id + '-dA' + k), b = document.getElementById(id + '-dB' + k);
      if (a) a.style.opacity = k === i ? '1' : '0'; if (b) b.style.opacity = k === i ? '1' : '0';
    }
    const tip = document.getElementById(id + '-tip');
    const bVal = d.b[i];
    const isProjection = typeof d.nowIdx === 'number' && d.nowIdx >= 0 && i > d.nowIdx;
    const yr = (d.years && d.years[i]) ? ' ' + d.years[i] : '';
    tip.innerHTML = `<div style="font-weight:600;margin-bottom:5px;opacity:.7;font-size:11px">${d.labels[i]}${yr}${isProjection ? ' · <span style="opacity:.6">projectie</span>' : ''}</div>
      <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
        <span style="width:7px;height:7px;border-radius:2px;background:var(--${d.colA})"></span>
        <span style="opacity:.75">${d.labelA}</span>
        <b style="margin-left:auto;font-family:'IBM Plex Mono',monospace">${eur0(d.a[i])}</b></div>
      <div style="display:flex;align-items:center;gap:7px">
        <span style="width:7px;height:7px;border-radius:2px;background:var(--${d.colB})"></span>
        <span style="opacity:.75">${d.labelB}</span>
        <b style="margin-left:auto;font-family:'IBM Plex Mono',monospace">${bVal == null ? '—' : eur0(bVal)}</b></div>`;
    tip.style.opacity = '1';
    const px = cx / vb * r.width;
    // Flip-positionering: meet actuele tooltip-breedte NA render (offsetWidth)
    // en flip zodat de tip volledig binnen de container blijft. Voorkomt dat
    // de rechterzijde afgekapt wordt op het laatste maand-punt.
    tip.style.left = '0px'; // reset zodat offsetWidth stabiel is
    const tipW = Math.max(140, tip.offsetWidth || 165);
    let left;
    if (px + tipW / 2 > r.width - 4) {
      // Rechterrand: laat tip eindigen 8px voor de rechter-container-rand.
      left = Math.max(4, r.width - tipW - 8);
    } else if (px - tipW / 2 < 4) {
      // Linkerrand: pin tip 4px vanaf de linker-container-rand.
      left = 4;
    } else {
      left = px - tipW / 2;
    }
    tip.style.left = left + 'px';
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

  /* ── Live data ────────────────────────────────────────────────────
     Backend ondersteunt per endpoint verschillend:
     - dashboard-stats: today|week|month (Jaar → fallback naar month)
     - finance-dashboard-counts: today|week|month|quarter|year
     - sales-signed-deals-total: today|week|month|year|all + from/to
     - leads-per-traject-count: today|week|month|all
     Custom = from/to date range picker; alle year/custom-safe endpoints
     krijgen de datums, endpoints die het niet snappen krijgen de dichtstbij
     fallback (month) — fail-soft. */
  const PERIOD_LABEL_TO_PARAM = { Dag: 'today', Week: 'week', Maand: 'month', Jaar: 'year' };
  // Custom-state: als user Custom kiest wordt from/to gezet en labelPeriod='Custom'.
  const _custom = { from: null, to: null };
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
    mrr:      null,  // /api/sales-mrr-report (by_traject[])
    tasks:    null,  // /api/tasks-list?status=PENDING (counts.byCategory + MANUAL_FOLLOWUP filter)
    leadsPer: null,  // /api/leads-per-traject-count?period=X (total + by_traject)
    signed:   null,  // /api/sales-signed-deals-total?period=X (total_incl_vat + count)
    signedTrend:null,// /api/sales-signed-deals-total?group_by=month (b-lijn grafiek)
    signedCat: null, // /api/sales-signed-deals-total?group_by=category&period=X (Trajecten-tegels)
    lsOpen:   null,  // /api/leadsonderhoud-open-count (open_count)
    onbCounts:null,  // /api/onboarding-counts (active_count)
    lisaCnt:  null,  // /api/lisa-conversations-count?status=active (count)
    evStatus: null,  // /api/events-status-aggregate?event_ids=... (items[])
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
    // Custom: gebruik _custom.from/to als querystring-basis; anders period-alias.
    const isCustom = labelPeriod === 'Custom' && _custom.from && _custom.to;
    const paramPeriod = isCustom ? null : PERIOD_LABEL_TO_PARAM[labelPeriod];
    if (!paramPeriod && !isCustom) return; // onbekende label
    if (_live.period === labelPeriod && _live.stats && !_live.error && !isCustom) {
      console.debug('[dashboard-v2] skip: reeds geladen voor', labelPeriod);
      return;
    }
    // Fallback voor endpoints die 'year'/'custom' niet snappen — gebruik 'month'.
    const safeStatsPeriod = (paramPeriod === 'year' || isCustom) ? 'month' : paramPeriod;
    const safeLeadsPeriod = (paramPeriod === 'year' || isCustom) ? 'all'   : paramPeriod;
    // Custom-range querystring voor endpoints die from/to snappen.
    const customQs = isCustom ? `&from=${_custom.from}&to=${_custom.to}` : '';
    const signedPeriodQ = isCustom ? '' : `period=${paramPeriod}`;
    const financePeriodQ = isCustom ? 'period=month' : `period=${paramPeriod}`; // Custom → month fallback
    const leadsPeriodQ = `period=${safeLeadsPeriod}`;
    const statsPeriodQ = `period=${safeStatsPeriod}`;
    const seq = ++_fetchSeq;
    _live.loading = true;
    _live.error = null;
    console.debug('[dashboard-v2] bundle start seq=' + seq + ' period=' + labelPeriod);
    if (window.DFO && window.DFO.render) window.DFO.render();
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      // Parallel fetch — elk endpoint is fail-soft (null bij error).
      // Ronde-14: + sales-mrr-report (by_traject-live), tasks-list (bel-acties
      // via MANUAL_FOLLOWUP-pending count).
      // signedUrl = tegel-totaal; signedTrendUrl = grafiek per-maand (b-lijn live).
      // Voor Jaar: trend = de 12 maanden van huidig jaar. Voor Custom: from/to.
      // Voor Dag/Week/Maand: trend = alleen die maand(en) — Dag geeft 1 punt,
      // dat is prima want de grafiek is dan minder betekenisvol op dag-niveau.
      const signedUrl      = isCustom
        ? `/api/sales-signed-deals-total?${customQs.slice(1)}`
        : `/api/sales-signed-deals-total?${signedPeriodQ}`;
      const signedTrendUrl = isCustom
        ? `/api/sales-signed-deals-total?group_by=month&${customQs.slice(1)}`
        : `/api/sales-signed-deals-total?group_by=month&period=year`;
      // by_category = aanvaarde deals per traject-classify, in de GEKOZEN periode.
      // "Trajecten verkocht" is een periode-metric (was: snapshot van actieve
      // subs → miste 24-mnd deals). Volgt dus periode-chip Dag/Week/Maand/Jaar/Custom.
      const signedCatUrl = isCustom
        ? `/api/sales-signed-deals-total?group_by=category&${customQs.slice(1)}`
        : `/api/sales-signed-deals-total?group_by=category&${signedPeriodQ}`;

      const [stats, finance, tickets, events, sales, retention, mrr, tasks, leadsPer, signed, signedTrend, signedCat, lsOpen, onbCounts, lisaCnt] = await Promise.all([
        tryFetch('dashboard-stats',       '/api/dashboard-stats?' + statsPeriodQ),
        tryFetch('finance-counts',        '/api/finance-dashboard-counts?' + financePeriodQ),
        tryFetch('tickets',               '/api/tickets'),
        tryFetch('events-list',           '/api/events-list?limit=6&status=draft,published'),
        tryFetch('sales-dashboard-stats', '/api/sales-dashboard-stats'),
        tryFetch('sales-retention',       '/api/sales-retention'),
        tryFetch('sales-mrr-report',      '/api/sales-mrr-report'),
        tryFetch('tasks-followup',        '/api/tasks-list?action_type=MANUAL_FOLLOWUP&status=PENDING&limit=1'),
        tryFetch('leads-per-traject',     '/api/leads-per-traject-count?' + leadsPeriodQ),
        tryFetch('signed-deals-total',    signedUrl),
        tryFetch('signed-deals-trend',    signedTrendUrl),
        tryFetch('signed-deals-category', signedCatUrl),
        tryFetch('ls-open-count',         '/api/leadsonderhoud-open-count'),
        tryFetch('onboarding-counts',     '/api/onboarding-counts'),
        tryFetch('lisa-conv-count',       '/api/lisa-conversations-count?status=active'),
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
      _live.mrr       = mrr;
      _live.tasks     = tasks;
      _live.leadsPer   = leadsPer;
      _live.signed     = signed;
      _live.signedTrend= signedTrend;
      _live.signedCat  = signedCat;
      _live.lsOpen     = lsOpen;
      _live.onbCounts = onbCounts;
      _live.lisaCnt   = lisaCnt;
      _live.error     = stats ? null : 'dashboard-stats faalde';
      // 2e roundtrip (chained): events-status-aggregate voor VL/GB per event.
      // Alleen aanroepen als events.items geladen zijn en ids beschikbaar.
      const evIds = events && Array.isArray(events.items)
        ? events.items.slice(0, 6).map(ev => ev && ev.id).filter(Boolean)
        : [];
      if (evIds.length) {
        const evStatus = await tryFetch('events-status-aggregate',
          '/api/events-status-aggregate?event_ids=' + encodeURIComponent(evIds.join(',')));
        if (seq !== _fetchSeq) return; // Race: bail bij stale.
        _live.evStatus = evStatus;
      } else {
        _live.evStatus = null;
      }
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

  // ── AI Manager (V1-port) ─────────────────────────────────────────────
  // 1-op-1 port van de super-admin-dashboard V1-implementatie:
  //   POST /api/super-admin-ai-manager  { question }
  //   → { antwoord, uitleg?, gebruikte_query?, ruwe_data?, row_count?, truncated? }
  // Alleen op user-actie (chip-klik / Enter / verzend-knop) — geen fetch-on-render.
  function _dfoAiEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function _dfoAiRenderTable(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const cols = Array.from(new Set(rows.flatMap(r => Object.keys(r || {}))));
    const th = cols.map(c => `<th style="text-align:left;padding:4px 8px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--text-3)">${_dfoAiEsc(c)}</th>`).join('');
    const body = rows.map(row => {
      const tds = cols.map(c => {
        const v = row?.[c];
        const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        return `<td style="padding:4px 8px;border-bottom:1px solid var(--border);font-size:11.5px;font-family:'IBM Plex Mono',monospace">${_dfoAiEsc(s)}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<div style="margin-top:8px;overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
  }
  async function _dfoAiSubmit(question) {
    const box   = document.getElementById('dfoAiAnswer');
    const input = document.getElementById('dfoAiInput');
    const btn   = document.getElementById('dfoAiSend');
    if (!box) return;
    const q = String(question || '').trim();
    if (!q) return;
    if (q.length > 2000) { box.style.display = ''; box.innerHTML = `<span style="color:var(--rose)">Vraag is te lang (max 2000 tekens).</span>`; return; }
    box.style.display = '';
    box.innerHTML = `<span style="color:var(--text-3);font-style:italic">AI denkt na…</span>`;
    if (input) input.disabled = true;
    if (btn)   btn.disabled = true;
    try {
      const resp = await window.KV.authedFetch('/api/super-admin-ai-manager', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const d = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = d?.error || ('HTTP ' + resp.status);
        const detail = d?.detail ? ` — ${_dfoAiEsc(d.detail)}` : '';
        box.innerHTML = `<span style="color:var(--rose)">Fout: ${_dfoAiEsc(err)}${detail}</span>`;
        return;
      }
      const antwoord = d.antwoord || '(geen samenvatting)';
      const uitleg   = d.uitleg ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text-3);font-style:italic">${_dfoAiEsc(d.uitleg)}</div>` : '';
      const rowInfo  = (d.row_count != null)
        ? `<div style="margin-top:8px;font-size:10.5px;color:var(--text-3);letter-spacing:.06em">${d.row_count} rij(en)${d.truncated ? ' · top ' + ((d.ruwe_data || []).length) + ' getoond' : ''}</div>`
        : '';
      const table = _dfoAiRenderTable(d.ruwe_data || []);
      box.innerHTML = `<div>${_dfoAiEsc(antwoord)}</div>${uitleg}${rowInfo}${table}`;
    } catch (e) {
      box.innerHTML = `<span style="color:var(--rose)">Netwerkfout: ${_dfoAiEsc(e?.message || 'onbekend')}</span>`;
    } finally {
      if (input) input.disabled = false;
      if (btn)   btn.disabled   = false;
      if (input) input.focus();
    }
  }
  window.DFO_aiAsk  = function (question) {
    const input = document.getElementById('dfoAiInput');
    if (input) input.value = question;
    _dfoAiSubmit(question);
  };
  window.DFO_aiSend = function () {
    const input = document.getElementById('dfoAiInput');
    _dfoAiSubmit(input ? input.value : '');
  };

  // Public hook: klik op periode-chip
  window.DFO_dashPeriodClick = function (labelPeriod) {
    console.debug('[dashboard-v2] chip clicked:', labelPeriod);
    if (labelPeriod === 'Custom') {
      // Simpele native date-picker via 2 inputs in modal.
      _openCustomPicker();
      return;
    }
    _custom.from = _custom.to = null; // Reset custom-state bij switch naar preset.
    window.DFO.setF('per', labelPeriod);
    fetchDashboardStats(labelPeriod);
  };

  function _openCustomPicker() {
    // Minimalistische modal — 2 date-inputs. Vermijdt zware datepicker-lib.
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:grid;place-items:center';
    const now = new Date();
    const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const defFrom = _custom.from || toISO(new Date(now.getFullYear(), now.getMonth(), 1));
    const defTo   = _custom.to   || toISO(now);
    wrap.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px 22px;min-width:320px;box-shadow:var(--shadow-lg)">
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">Custom periode</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px">
        <label style="font-size:12px;color:var(--text-2)">Van<input type="date" id="dcpFrom" value="${defFrom}" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-family:inherit;font-size:13px;width:100%;box-sizing:border-box"/></label>
        <label style="font-size:12px;color:var(--text-2)">Tot<input type="date" id="dcpTo" value="${defTo}" style="display:block;margin-top:4px;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text);font-family:inherit;font-size:13px;width:100%;box-sizing:border-box"/></label>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="dcpCancel" style="padding:7px 14px;border:1px solid var(--border);background:var(--surface);border-radius:var(--r-sm);cursor:pointer;font-size:12.5px">Annuleer</button>
        <button id="dcpApply"  style="padding:7px 14px;border:0;background:var(--m);color:#fff;border-radius:var(--r-sm);cursor:pointer;font-size:12.5px;font-weight:500">Toepassen</button>
      </div>
    </div>`;
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#dcpCancel').onclick = close;
    wrap.querySelector('#dcpApply').onclick = () => {
      const f = wrap.querySelector('#dcpFrom').value;
      const t = wrap.querySelector('#dcpTo').value;
      if (!f || !t || f > t) { alert('Vul geldig van/tot in (van ≤ tot).'); return; }
      _custom.from = f; _custom.to = t;
      close();
      window.DFO.setF('per', 'Custom');
      fetchDashboardStats('Custom');
    };
  }

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
    // GUARD 1 (v=8, 2026-08-18 post-mortem): KV.authedJson-availability-check.
    // Als klanten-v2.js boot() nog niet gerund heeft (window.KV.authedJson
    // undefined), rendert dashManager een placeholder ZONDER fetch te
    // triggeren. Zodra klanten-v2.js z'n boot() afmaakt en window.KV
    // toewijst, triggert de volgende render de fetch normaal.
    // ROOT-CAUSE: app-shell.js roept render() aan (via setRoles/goMod)
    // VÓÓR klanten-v2.js's KV-init. fetchDashboardBundle throwt dan direct
    // 'KV.authedJson niet beschikbaar' → catch → _live.loading=false +
    // render → dashManager runt opnieuw → guard `_live.period !==
    // curPeriod && !_live.loading` blijft true (want _live.period nooit
    // gezet) → INFINITE LOOP. Puppeteer meldt 91.990 iteraties in ~10s
    // → CPU 100%, main-thread frozen, shell hangt op "Laden…".
    if (!window.KV || !window.KV.authedJson) {
      return `<div class="pad" style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Sessie laden…</div>`;
    }
    // GUARD 2 (v=8): na een terminal error retry-loop breken. Fallback
    // toont de foutmelding + wacht op user-actie (refresh / navigate) i.p.v.
    // opnieuw fetch → error → render → fetch. Zonder deze guard zou een
    // tweede foutbron (bv. tijdelijke 500 op /api/dashboard-stats) dezelfde
    // loop kunnen introduceren.
    if (_live.error && !_live.loading) {
      return `<div class="pad" style="padding:24px 20px"><div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose);color:var(--rose);border-radius:8px;font-size:13px">⚠ Kan dashboard niet laden: ${String(_live.error).replace(/[<>&]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]))}</div></div>`;
    }
    const persoon = (ROLES[S.role] && ROLES[S.role].persoon) || 'Jeffrey Biemold';
    const voornaam = persoon.split(' ')[0];
    const curPeriod = F('per', 'Maand');
    // Trigger fetch als de gekozen periode nog niet geladen is (én backend-supported).
    // KRITIEK: !_live.loading-guard voorkomt render-loop. fetchDashboardBundle roept
    // render() aan met loading=true VOORDAT de bundle resolvet — dashManager loopt
    // daardoor opnieuw. Zonder loading-check triggerde die render een 2e fetch die
    // opnieuw render(), enz. → UI-thread bevroor (microtask-storm).
    // Loop-safe: alleen fetch als (a) preset-periode NIET geladen, of
    // (b) Custom en er van/tot is + van/tot verschilt van laatst-geladen.
    // Custom-detect: cur='Custom' + _custom.from/to gezet.
    const wantsFetch = !_live.loading && (
      (PERIOD_LABEL_TO_PARAM[curPeriod] && _live.period !== curPeriod) ||
      (curPeriod === 'Custom' && _custom.from && _custom.to && _live.period !== 'Custom')
    );
    if (wantsFetch) queueMicrotask(() => fetchDashboardBundle(curPeriod));
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
            <button class="chip ${curPeriod === 'Custom' ? 'on' : ''}" style="font-size:12.5px;padding:5px 13px;border-radius:5px" onclick="DFO_dashPeriodClick('Custom')">${curPeriod === 'Custom' && _custom.from ? `${_custom.from} · ${_custom.to} ▾` : 'Custom ▾'}</button>
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
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px">
              ${(() => {
                // Ronde-17: "Alle bronnen"-tegel VERVANGEN door "7-daagse".
                // Rest van de logica ongewijzigd: tegels alleen tonen als het
                // label ergens in de DB bestaat (via all_traject_labels).
                // Calls-tegel gebruikt nu de NIEUW-GEBOEKT metric (sales.
                // {today|week|month|year}.booked = created_at in periode),
                // NIET meer scheduled_at.
                const lp = _live.leadsPer;
                // v=28 (2026-08-24): dashboard-tegels tellen nu OOK afgewezen
                // leads mee. Endpoint levert `total_incl_afwijzer` +
                // `by_traject_incl_afwijzer` naast de schone versie
                // (mk-bronnen gebruikt de schone). Fallback op de oude
                // velden voor achterwaartse compat als endpoint nog niet
                // gedeployed is.
                const totLive = lp
                  ? (typeof lp.total_incl_afwijzer === 'number' ? lp.total_incl_afwijzer
                     : (typeof lp.total === 'number' ? lp.total : null))
                  : null;
                const totFallback = d && d.kpis_groot && d.kpis_groot.nieuwe_leads && d.kpis_groot.nieuwe_leads.value;
                const totLeads = totLive != null ? totLive : totFallback;
                const isLive  = !!lp;
                const allLabels = (lp && Array.isArray(lp.all_traject_labels)) ? lp.all_traject_labels.map(x => String(x).toLowerCase()) : null;
                function anyLabelMatches(matchers) {
                  if (!allLabels) return true;
                  return allLabels.some(l => matchers.some(m => l.includes(m)));
                }
                function findCount(matchers) {
                  if (!lp) return 0;
                  const src = lp.by_traject_incl_afwijzer || lp.by_traject;
                  if (!src) return 0;
                  let sum = 0;
                  for (const k of Object.keys(src)) {
                    const lk = String(k).toLowerCase();
                    if (matchers.some(m => lk.includes(m))) sum += src[k] || 0;
                  }
                  return sum;
                }
                // Calls GEBOEKT (nieuw): sales.<periode>.booked = created_at.
                const s = _live.sales;
                let callsCnt = null;
                if (s) {
                  if (curPeriod === 'Dag')       callsCnt = (s.today && typeof s.today.booked  === 'number') ? s.today.booked  : null;
                  else if (curPeriod === 'Week') callsCnt = (s.week  && typeof s.week.booked   === 'number') ? s.week.booked   : null;
                  else if (curPeriod === 'Maand')callsCnt = (s.month && typeof s.month.booked  === 'number') ? s.month.booked  : null;
                  else if (curPeriod === 'Jaar') callsCnt = (s.year  && typeof s.year.booked   === 'number') ? s.year.booked   : null;
                  // Custom: kies month als proxy (endpoint heeft geen range-support).
                  else if (curPeriod === 'Custom') callsCnt = (s.month && typeof s.month.booked === 'number') ? s.month.booked : null;
                }
                const tiles = [];
                if (isLive && anyLabelMatches(['7-daagse','7 daagse','7daagse'])) tiles.push(['7-daagse',      findCount(['7-daagse','7 daagse','7daagse']), totLeads ? Math.round(findCount(['7-daagse','7 daagse','7daagse'])/Math.max(totLeads,1)*100) : 0, 'emerald', 'leads',  true]);
                if (isLive && anyLabelMatches(['event']))   tiles.push(['Event-aanmeldingen', findCount(['event']),  totLeads ? Math.round(findCount(['event'])/Math.max(totLeads,1)*100)  : 0, 'teal',   'events', true]);
                if (isLive && anyLabelMatches(['webinar'])) tiles.push(['Webinar',            findCount(['webinar']),totLeads ? Math.round(findCount(['webinar'])/Math.max(totLeads,1)*100): 0, 'blue',   'leads',  true]);
                if (isLive && anyLabelMatches(['mini']))    tiles.push(['Mini cursus',        findCount(['mini']),   totLeads ? Math.round(findCount(['mini'])/Math.max(totLeads,1)*100)   : 0, 'violet', 'leads',  true]);
                if (callsCnt != null) tiles.push(['Calls geboekt', callsCnt, 100, 'accent', 'sales', true]);
                return tiles.map(([n, c, p, col, mod, tileLive]) => `<div style="border:1px solid var(--border);border-radius:var(--r);padding:12px 13px;cursor:pointer;transition:all .15s;${c > 0 ? '' : 'opacity:.6'}"
                  onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'" onclick="DFO.goMod('${mod}')">
                  <div style="font-size:11.5px;color:var(--text-2);margin-bottom:5px">${n}${tileLive ? '' : mockBadge()}</div>
                  <div style="font-size:26px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;line-height:1">${c}</div>
                  <div class="progress" style="margin-top:9px;height:3px"><i style="width:${p}%;background:var(--${col})"></i></div>
                  <div style="font-size:11px;color:var(--text-3);margin-top:5px">${tileLive ? (n === 'Calls geboekt' ? 'nieuw geboekt' : `${p}% van totaal`) : `${p}% van totaal`}</div></div>`).join('');
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
                .map(q => `<button class="chip" style="font-size:11.5px;padding:4px 10px;background:var(--surface)" data-ai-q="${esc(q)}" onclick="DFO_aiAsk(this.dataset.aiQ)">${q}</button>`).join('')}</div>
            <div style="position:relative">
              <input id="dfoAiInput" placeholder="Stel je vraag in gewone taal…" onkeydown="if(event.key==='Enter'){event.preventDefault();DFO_aiSend()}" style="width:100%;box-sizing:border-box;padding:10px 48px 10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:22px;font-family:inherit;font-size:13px;color:var(--text);outline:none;transition:border-color .15s,box-shadow .15s"
                onfocus="this.style.borderColor='var(--teal)';this.style.boxShadow='0 0 0 3px var(--teal-soft)'"
                onblur="this.style.borderColor='var(--border)';this.style.boxShadow='none'"/>
              <button id="dfoAiSend" onclick="DFO_aiSend()" style="position:absolute;right:5px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:50%;
                background:var(--teal);color:#fff;border:0;cursor:pointer;display:grid;place-items:center;padding:0">${svg(I.up, 'width:15px;height:15px')}</button></div>
            <div id="dfoAiAnswer" style="display:none;margin-top:12px;padding:11px 13px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12.5px;line-height:1.55;color:var(--text-1);max-height:280px;overflow-y:auto"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head" style="border-bottom:none;padding-bottom:6px">
            <span class="title-dot" style="background:var(--emerald);box-shadow:0 0 0 3px var(--emerald-soft)"></span>

            <div class="card-title">Omzet — getekende offertes${liveBadgeFor(f, 'Live uit /api/finance-dashboard-counts')}</div>
            <span style="font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--text-3)">INCL BTW</span></div>
          <div class="card-body" style="padding:6px 0 16px">
            <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin:0 17px 14px">
              ${(() => {
                // Ronde-15: Totaal incl BTW LIVE uit /api/sales-signed-deals-total.
                // MRR blijft live uit finance-dashboard-counts (fase 1).
                const mrr = f && typeof f.mrrSubscriptions === 'number' ? f.mrrSubscriptions : null;
                const sd  = _live.signed;
                const sdTotal = sd && typeof sd.total_incl_vat === 'number' ? sd.total_incl_vat : null;
                const sdCount = sd && typeof sd.count === 'number' ? sd.count : null;
                const tiles = [
                  { l: 'Abonnementen (MRR)', v: mrr != null ? mrr : 47612, s: mrr != null ? 'live · som(amount/cycle)' : '86 actief', c: 'teal', live: mrr != null },
                  { l: 'Totaal incl. btw',   v: sdTotal != null ? sdTotal : 0, s: sdTotal != null ? `${sdCount || 0} offertes` : '—', c: 'blue', live: sdTotal != null },
                ];
                return tiles.map(t => `<div style="border:1px solid var(--border);border-radius:var(--r);padding:13px 15px">
                  <div style="font-size:11.5px;color:var(--text-2);margin-bottom:6px;display:flex;align-items:center;gap:6px">
                    <span class="legend-dot" style="background:var(--${t.c})"></span>${t.l}${t.live ? '' : mockBadge('Endpoint faalde')}</div>
                  <div style="font-size:25px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;line-height:1">${eur0(t.v)}</div>
                  <div style="font-size:11px;color:var(--text-3);margin-top:6px">${t.s}</div></div>`).join('');
              })()}
            </div>
            ${(() => {
              // MRR-lijn (a) LIVE uit sales-mrr-report.trend[] — zelfde helper
              // die de MRR-tegel voedt (api/_lib/mrr-compute.js). Laatste 8
              // maanden ≤ huidige maand. Fallback op mock als geen trend.
              // Totaal-incl-btw-lijn (b): geen per-maand-endpoint, blijft mock
              // (out-of-scope voor deze MRR-brok — user vroeg alleen MRR-fix).
              // Ronde-19: grafiek vooruitkijken.
              // MRR-lijn (a) uit sales-mrr-report.trend — pak 12 mnd terug t/m 12 mnd vooruit
              // (sales-mrr-report levert -12..+12 range; toekomstige punten zijn de
              // projectie via computeCurrentMrr op sub-snapshots per maand-eind).
              // Signed-lijn (b) STOPT bij huidige maand (geen toekomst-actuals).
              const M_ABBR = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
              const mrrTrend = _live.mrr && Array.isArray(_live.mrr.trend) ? _live.mrr.trend : null;
              const sigTrend = _live.signedTrend && Array.isArray(_live.signedTrend.trend) ? _live.signedTrend.trend : null;
              const now = new Date();
              const curYm = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
              // Bereken maand-window: 12 mnd terug t/m 12 mnd vooruit als mrrTrend
              // die dekt; anders wat er is.
              const startWin = (() => { const d = new Date(now.getFullYear(), now.getMonth() - 12, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
              const endWin   = (() => { const d = new Date(now.getFullYear(), now.getMonth() + 12, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; })();
              const keySet = new Set();
              if (mrrTrend) for (const t of mrrTrend) if (t && t.period && t.period >= startWin && t.period <= endWin) keySet.add(t.period);
              if (sigTrend) for (const t of sigTrend) if (t && t.period && t.period >= startWin && t.period <= curYm) keySet.add(t.period);
              const keys = Array.from(keySet).sort();
              let a, b, lb;
              let yr;
              if (keys.length) {
                const mrrByK = {}; if (mrrTrend) for (const t of mrrTrend) mrrByK[t.period] = t.mrr || 0;
                const sigByK = {}; if (sigTrend) for (const t of sigTrend) sigByK[t.period] = t.total_incl_vat || 0;
                a  = keys.map(k => Number(mrrByK[k]) || 0);
                // b: alleen actuals ≤ huidige maand; toekomst = null (weggelaten uit lijn).
                b  = keys.map(k => k <= curYm ? (Number(sigByK[k]) || 0) : null);
                lb = keys.map(k => M_ABBR[parseInt(k.slice(5,7),10)-1] || k);
                yr = keys.map(k => k.slice(0, 4));
              } else {
                a  = [41200, 42800, 43900, 44600, 45800, 46400, 47100, 47612];
                b  = [62000, 78000, 95000, 88000, 120000, 104000, 86000, 26250];
                lb = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug'];
                yr = ['2026','2026','2026','2026','2026','2026','2026','2026'];
              }
              // Vind index waar 'nu' ligt (voor 'vandaag'-verticale marker).
              const nowIdx = keys.length ? keys.indexOf(curYm) : -1;
              CHARTDATA['omz'] = { a, b, labels: lb, years: yr, labelA: 'Abonnementen (MRR)', labelB: 'Totaal incl. btw', colA: 'teal', colB: 'blue', nowIdx };
              // Ronde-23 definitieve full-width: omzChart rendert nu een
              // placeholder-container. _omzEnsureMounted meet clientWidth
              // en tekent SVG met viewBox=W×H (1 unit = 1 px, geen meet-padding).
              // ResizeObserver houdt bij window-resize gelijke tred.
              // GEEN margin-hacks meer — de wrapper heeft nette padding en
              // de SVG loopt tot beide randen van de card zelf.
              queueMicrotask(() => window._omzEnsureMounted && window._omzEnsureMounted('omz'));
              return omzChart('omz', a, b, lb, 'Abonnementen (MRR)', 'Totaal incl. btw', 'teal', 'blue', nowIdx, yr);
            })()}
            <div style="margin:16px 17px 0;border:1px solid var(--border);border-radius:var(--r);padding:14px 15px">
              <div style="font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:12px">
                Trajecten verkocht${_live.signedCat ? liveBadgeFor(_live.signedCat, 'Live uit /api/sales-signed-deals-total group=category (aanvaarde deals in periode)') : mockBadge('signed-deals-category faalde')}
              </div>
              <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px">
                ${(() => {
                  // Ronde-20 PUNT-4: LIVE uit sales-signed-deals-total?group_by=category&period=X.
                  // Bron = aanvaarde deals in de gekozen periode (Dag/Week/Maand/
                  // Jaar/Custom), NIET meer snapshot van actieve subs. Zo landen
                  // 24-mnd deals correct én consistent met "Totaal incl. btw"-tegel.
                  const byCat = _live.signedCat && Array.isArray(_live.signedCat.by_category) ? _live.signedCat.by_category : [];
                  const catMap = {};
                  for (const c of byCat) catMap[c.category] = c;
                  // "Overig" bundelt m_other + other_product + unknown zodat we niet
                  // stille deals verliezen als classify ze niet in m6/m12/m24/mem duwt.
                  const otherCount = (catMap.m_other?.count || 0) + (catMap.other_product?.count || 0) + (catMap.unknown?.count || 0);
                  const otherRev   = (catMap.m_other?.total_incl_vat || 0) + (catMap.other_product?.total_incl_vat || 0) + (catMap.unknown?.total_incl_vat || 0);
                  const cats = [
                    { key: 'm6',    label: '6 mnd 1-op-1',  col: 'violet',   b: catMap.m6 },
                    { key: 'm12',   label: '12 mnd 1-op-1', col: 'violet',   b: catMap.m12 },
                    { key: 'm24',   label: '24 mnd 1-op-1', col: 'violet',   b: catMap.m24 },
                    { key: 'mem',   label: 'Membership',    col: 'blue',     b: catMap.mem },
                    ...(otherCount > 0 ? [{ key: 'overig', label: 'Overig',   col: 'accent-2', b: { count: otherCount, total_incl_vat: otherRev } }] : []),
                  ];
                  return cats.map(cat => {
                    const c = (cat.b && cat.b.count) || 0;
                    const r = (cat.b && cat.b.total_incl_vat) || 0;
                    return `<div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px">
                      <div style="font-size:11px;color:var(--${cat.col});font-weight:500;margin-bottom:4px">${cat.label}</div>
                      <div style="font-size:20px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.035em;line-height:1;${c > 0 ? '' : 'color:var(--text-3)'}">${c}</div>
                      <div style="font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:4px">${eur0(r)}</div></div>`;
                  }).join('');
                })()}
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
                // Ronde-14: Bel-acties live via tasks-list MANUAL_FOLLOWUP+PENDING.
                // tasks-list returns total (all MANUAL_FOLLOWUP-tasks in pending);
                // niet-kind-specifiek maar 'follow-up-task' dekt bel-acties + brieven.
                [(_live.tasks && typeof _live.tasks.total === 'number') ? _live.tasks.total : 54, 'Bel-acties te doen', 'Follow-up-taken', 'amber', 'wanbetalers', !!(_live.tasks && typeof _live.tasks.total === 'number')],
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
              // Live: appointments_today_count + tomorrow + week + month uit sales-dashboard-stats.
              // Ronde-15: month.appointments toegevoegd aan endpoint (rolling 30d).
              const s = _live.sales;
              const todayCnt = s && typeof s.appointments_today_count === 'number' ? s.appointments_today_count : null;
              const tomorrowCnt = s && typeof s.appointments_tomorrow_count === 'number' ? s.appointments_tomorrow_count : null;
              const weekCnt = s && s.week && typeof s.week.appointments === 'number' ? s.week.appointments : null;
              const monthCnt = s && s.month && typeof s.month.appointments === 'number' ? s.month.appointments : null;
              const bigVal = todayCnt != null ? todayCnt : 4;
              return `
                <div style="font-size:44px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.05em;color:var(--teal);line-height:1">${bigVal}</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:5px;margin-bottom:16px">vandaag gepland${todayCnt != null ? '' : mockBadge()}</div>
                <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:9px">
                  ${[[todayCnt != null ? todayCnt : 4, 'VANDAAG', todayCnt != null],
                     [tomorrowCnt != null ? tomorrowCnt : 3, 'MORGEN', tomorrowCnt != null],
                     [weekCnt != null ? weekCnt : 22, 'WEEK', weekCnt != null],
                     [monthCnt != null ? monthCnt : 0, 'MAAND', monthCnt != null]]
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
              // Ronde-15: Leadsonderhoud + Onboarding + Lisa LIVE.
              const lsOpenCnt = _live.lsOpen && typeof _live.lsOpen.open_count === 'number' ? _live.lsOpen.open_count : null;
              const onbActive = _live.onbCounts && typeof _live.onbCounts.active_count === 'number' ? _live.onbCounts.active_count : null;
              const lisaAct   = _live.lisaCnt && typeof _live.lisaCnt.count === 'number' ? _live.lisaCnt.count : null;
              const tiles = [
                ['Wanbetalers',    wbxCount != null ? wbxCount : 4,   'amber',  I.alert,  'wanbetalers',    wbxCount != null],
                ['Leadsonderhoud', lsOpenCnt != null ? lsOpenCnt : 0, 'teal',   I.repeat, 'leadsonderhoud', lsOpenCnt != null],
                ['Onboarding',     onbActive != null ? onbActive : 0, 'emerald', I.route, 'onboarding',     onbActive != null],
                ['Lisa AI',        lisaAct != null ? lisaAct : 0,     'violet', I.bot,    'lisa',           lisaAct != null],
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
            // Ronde-15: events-status-aggregate LIVE per event.
            // Map van event_id -> { active_count, questionnaire_count, called_count }.
            const statusMap = new Map();
            if (_live.evStatus && Array.isArray(_live.evStatus.items)) {
              for (const it of _live.evStatus.items) statusMap.set(it.event_id, it);
            }
            const rows = evItems && evItems.length
              ? evItems.slice(0, 5).map(ev => [
                  ev.title || 'Event',
                  ev.starts_at ? fmtDt(ev.starts_at) : '—',
                  ev.location || '—',
                  typeof ev.attendee_count_active === 'number' ? ev.attendee_count_active : 0,
                  typeof ev.capacity === 'number' ? ev.capacity : 8,
                  true, // live
                  ev.id || null,
                ])
              : MOCK_ROWS.map(r => [...r, false, null]);
            return rows.map(([title, dt, loc, ing, cap, isLive, eventId]) => {
              // Live: haal VL/GB uit status-aggregate. Fallback bij mock: symmetric getal.
              const st = eventId ? statusMap.get(eventId) : null;
              const vlLive = !!st;
              const gbLive = !!st;
              const vl = st ? st.questionnaire_count : (isLive ? 0 : Math.min(cap, ing));
              const vlt = cap;
              const gb = st ? st.called_count : (isLive ? 0 : Math.min(cap, ing));
              const gbt = cap;
              return `<button style="display:flex;align-items:center;gap:22px;padding:13px 15px;border:1px solid var(--border);
                border-radius:var(--r);background:var(--surface);width:100%;text-align:left;transition:all .15s"
                onmouseover="this.style.borderColor='var(--border-strong)'" onmouseout="this.style.borderColor='var(--border)'" onclick="DFO.goMod('events')">
                <span style="flex:1;min-width:150px"><span style="display:block;font-size:13.5px;font-weight:600">${esc(title)}</span>
                <span style="display:block;font-size:11.5px;color:var(--text-3);margin-top:1px">${esc(dt)} · ${esc(loc)}</span></span>
                <span style="flex:1;max-width:230px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.02em">
                    ${vl}<span style="font-size:11px;color:var(--text-3)">/${vlt}</span></span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin:3px 0 6px">VRAGENLIJST${vlLive ? '' : mockBadge()}</span>
                  <span class="progress" style="display:block;height:3px"><i style="width:${vlt ? vl / vlt * 100 : 0}%;background:var(--teal)"></i></span></span>
                <span style="width:96px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;${ing > 0 ? '' : 'color:var(--text-3)'}">${ing}</span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin-top:3px">INGESCHREVEN${isLive ? '' : mockBadge()}</span></span>
                <span style="flex:1;max-width:230px;text-align:center">
                  <span style="display:block;font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.02em;${gb > 0 ? '' : 'color:var(--text-3)'}">
                    ${gb}<span style="font-size:11px;color:var(--text-3)">/${gbt}</span></span>
                  <span style="display:block;font-size:9.5px;letter-spacing:.09em;color:var(--text-3);margin:3px 0 6px">GEBELD${gbLive ? '' : mockBadge()}</span>
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
