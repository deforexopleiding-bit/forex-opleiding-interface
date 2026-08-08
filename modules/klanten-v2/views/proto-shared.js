// modules/klanten-v2/views/proto-shared.js
//
// Gedeelde helpers + kleine mock-datasets voor A2/A3/B1/B2/B3/B4 scaffolds.
// Non-ES-module: exposet via window.V2Shared.
//
// Bevat: kpi/kpis, toolbar, chips, search, pill, table, av, section-header.

(function () {
  if (!window.DFO) { console.error('[proto-shared] DFO shell niet geladen.'); return; }
  const { I, svg, avc, ini } = window.DFO;

  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const pill = (c, t) => `<span class="pill pill-${c}">${t}</span>`;

  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)">
      <div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot"><span>${o.sub || ''}</span></div></div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;

  const search = (ph = 'Zoeken…') => `<div class="searchbox" style="min-width:220px;flex:1;max-width:340px">
    ${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', 'width:15px;height:15px')}
    <input placeholder="${ph}" style="border:0;background:transparent;flex:1;font-family:inherit;font-size:13px;color:var(--text)"/></div>`;

  function chips(name, opts, sel) {
    const S = window.DFO.S;
    return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      ${opts.map(o => `<button class="chip ${sel === o.v ? 'on' : ''}" onclick="DFO.setF('${name}','${o.v}')">${o.l}${o.n != null ? `<span style="margin-left:5px;opacity:.7">${o.n}</span>` : ''}</button>`).join('')}</div>`;
  }

  const toolbar = arr => `<div class="toolbar" style="display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--border);flex-wrap:wrap">${arr.join('')}</div>`;

  function table(cols, rows) {
    return `<div class="tbl-wrap"><table>
      <thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((cell, j) => `<td class="${cols[j].cls || ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
  }

  const sec = (title, dotColor, body, extra) => `<div class="card" style="margin:14px 20px">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  // Preview-badge — elke scaffold begint hiermee zodat je weet dat data mock is
  const previewBadge = () => `<div style="margin:14px 20px 0;padding:9px 13px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r);color:var(--amber);font-size:12px;display:flex;align-items:center;gap:8px">
    ${svg(I.alert, 'width:14px;height:14px;flex-shrink:0')}
    <span><b>Preview · voorbeeld-data.</b> Layout uit prototype v45. Endpoints haken in bij goedkeuring van dit scherm.</span></div>`;

  window.V2Shared = { av, pill, kpi, kpis, search, chips, toolbar, table, sec, previewBadge };
  console.log('[proto-shared] geladen — kern-helpers V2Shared beschikbaar');
})();
