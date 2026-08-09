// modules/klanten-v2/views/_shared-v2.js
//
// Gedeelde helpers voor v2-module-views (kpi / kpis / toolbar / chips /
// search / table / av / pill / trend + voorbeeldBanner).
//
// 1-op-1 gekopieerd uit docs/redesign/systeemprototype-v45.html:
//   - kpi/kpis    r1200-1208
//   - toolbar     r1195
//   - chips       r1196
//   - search      r1197
//   - pill        r1199
//   - av          r1200 (met avc/ini uit DFO)
//   - trend       r1201
//   - table       r1223-1226
//
// Non-ES-module (klassieke <script>), geladen NA app-shell.js VÓÓR alle
// andere views die uit `window.KV_V2` willen consumeren.
//
// Waarom shared: dashboard-v2 + studenten-v2 gebruikten deze inline; vanaf
// email-v2 zijn we op de 3e reuse. Extract nu voorkomt drift.
//
// Exposeert:
//   window.KV_V2.helpers = { kpi, kpis, toolbar, chips, search, table,
//                             av, pill, trend, voorbeeldBanner }
// Bestaande dashboard-v2.js + studenten-v2.js blijven hun inline-copies
// gebruiken (geen refactor nu — die is een aparte cleanup-PR).

(function () {
  if (!window.DFO) { console.error('[_shared-v2] DFO shell niet geladen.'); return; }
  const { I, svg, S, F, avc, ini } = window.DFO;

  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const trend = (v, up) => `<span class="trend ${up === null ? 'trend-flat' : up ? 'trend-up' : 'trend-down'}">${up !== null ? svg(up ? I.up : I.arrDown) : ''}${v}</span>`;
  const pill = (c, t, nd) => `<span class="pill pill-${c} ${nd ? 'nodot' : ''}">${t}</span>`;

  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)" ${o.click ? `onclick="${o.click}"` : ''}>
      <div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot">${o.trend || ''}<span>${o.sub || ''}</span></div></div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;

  const toolbar = p => `<div class="toolbar">${p.join('')}</div>`;
  const chips = (n, o, c) => o.map(x => `<button class="chip ${c === x.v ? 'on' : ''}" onclick="DFO.setF('${n}','${x.v}')">${x.l}${x.n !== undefined ? `<span class="cnt">${x.n}</span>` : ''}</button>`).join('');
  const search = ph => `<div class="tb-search">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
    <input placeholder="${ph}" oninput="DFO.setF('q',this.value)" value="${(F('q', '') || '').replace(/"/g, '&quot;')}" /></div>`;

  function table(cols, rows, onclick) {
    return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr ${onclick ? `onclick="${onclick}(${i})"` : ''} class="${S.selIdx === i ? 'sel' : ''}">
        ${r.map((cell, j) => `<td class="${cols[j].cls || ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // Prominent module-niveau markering: layout klopt, data is voorbeeld.
  const voorbeeldBanner = () => `<div style="margin:14px 20px 0;padding:11px 14px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);
    display:flex;align-items:center;gap:11px;font-size:12.5px;color:var(--amber)">
    ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}
    <span><b>VOORBEELD-DATA</b> — deze view toont layout uit systeemprototype-v45.
    Data-koppeling volgt in de volgende ronde na layout-goedkeuring.</span></div>`;

  window.KV_V2 = window.KV_V2 || {};
  window.KV_V2.helpers = { kpi, kpis, toolbar, chips, search, table, av, pill, trend, voorbeeldBanner };
  console.debug('[_shared-v2] helpers registered on window.KV_V2.helpers');
})();
