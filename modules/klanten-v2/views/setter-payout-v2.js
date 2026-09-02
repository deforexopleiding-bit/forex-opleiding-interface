// modules/klanten-v2/views/setter-payout-v2.js
//
// BP2 setter-commissie-module. Toont eigen overzicht (setter) of admin-view
// (manager+). RBAC: setter.ledger.view (basis) / setter.ledger.admin +
// setter.payout.manage (manager+).
//
// BP3 v4 (2026-09-01):
//   - Periodefilter chips (Dag/Week/Maand/Jaar/Custom) op /Overzicht.
//   - Sales-lijst: geattribueerde deals (ook vóór eerste betaling).
//   - Lijngrafiek 6 mnd verleden + 18 mnd forecast — SVG, theme-aware.
//
// Structuur:
//   /Overzicht — periode-chips + 4 KPI's + lijngrafiek + sales + ledger-regels.
//   /Uitbetalen — manager-only: bundelen (setter + periode → run).

(function () {
  'use strict';
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[sp-v2] KV_V2.helpers niet geladen.'); return; }
  const H = window.KV_V2.helpers;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const eur = (v) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(Number(v) || 0);

  async function tryFetch(label, url) {
    try {
      const r = await window.KV.authedFetch(url);
      if (!r.ok) { console.warn('[sp-v2] fetch fail:', label, r.status); return null; }
      return await r.json();
    } catch (e) { console.warn('[sp-v2] fetch exception:', label, e?.message); return null; }
  }

  const _sp = {
    data: null, loading: false, error: null,
    selectedSetter: null,
    period: 'maand',                   // 'dag'|'week'|'maand'|'jaar'|'custom'
    from: '', to: '',                  // custom dates YYYY-MM-DD
    timeline: null, timelineLoading: false, timelineError: null,
  };
  const _spStaff = { items: null, loading: false };

  function _periodQuery() {
    if (_sp.period === 'custom' && _sp.from && _sp.to) {
      return `&period=custom&from=${encodeURIComponent(_sp.from)}&to=${encodeURIComponent(_sp.to)}`;
    }
    return `&period=${encodeURIComponent(_sp.period)}`;
  }

  async function loadOverview(setterId) {
    _sp.loading = true; _sp.error = null;
    if (window.DFO?.render) window.DFO.render();
    const setterQ = setterId ? ('setter_user_id=' + encodeURIComponent(setterId)) : '';
    const url = '/api/setter-overview?' + [setterQ, _periodQuery().slice(1)].filter(Boolean).join('&');
    const j = await tryFetch('overview', url);
    _sp.loading = false;
    if (!j) { _sp.error = 'Kon overzicht niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    _sp.data = j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function loadTimeline(setterId) {
    _sp.timelineLoading = true; _sp.timelineError = null;
    if (window.DFO?.render) window.DFO.render();
    const q = setterId ? ('?setter_user_id=' + encodeURIComponent(setterId)) : '';
    const j = await tryFetch('timeline', '/api/setter-commission-timeline' + q);
    _sp.timelineLoading = false;
    if (!j) { _sp.timelineError = 'Kon grafiek niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    _sp.timeline = j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function loadStaff() {
    if (_spStaff.items || _spStaff.loading) return;
    _spStaff.loading = true;
    const j = await tryFetch('staff', '/api/profiles-list?staff_only=1');
    _spStaff.items = (j && Array.isArray(j.members)) ? j.members : [];
    _spStaff.loading = false;
    if (window.DFO?.render) window.DFO.render();
  }

  window.__spSelectSetter = (id) => {
    _sp.selectedSetter = id || null;
    _sp.timeline = null;
    loadOverview(id).catch(() => {});
    loadTimeline(id).catch(() => {});
  };
  window.__spSetPeriod = (p) => {
    if (p === _sp.period) return;
    _sp.period = String(p || 'maand');
    if (_sp.period !== 'custom') { _sp.from = ''; _sp.to = ''; }
    loadOverview(_sp.selectedSetter).catch(() => {});
  };
  window.__spSetCustomFrom = (v) => { _sp.from = String(v || ''); if (_sp.from && _sp.to) loadOverview(_sp.selectedSetter).catch(() => {}); };
  window.__spSetCustomTo   = (v) => { _sp.to   = String(v || ''); if (_sp.from && _sp.to) loadOverview(_sp.selectedSetter).catch(() => {}); };

  window.__spRunPayout = async () => {
    // BP3 v8 (2026-09-02) BUG-FIX — RBAC.getUserPermissions bestaat NIET;
    // gebruik canSync (super_admin-wildcard zit al in de helper).
    const canPayout = !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync('setter.payout.manage'));
    if (!canPayout) {
      window.KV?.toast?.('Geen rechten (setter.payout.manage)', 'warn'); return;
    }
    const setterId = _sp.selectedSetter || (_sp.data && _sp.data.setter_user_id);
    if (!setterId) return;
    const today = new Date().toISOString().slice(0, 10);
    const first = today.slice(0, 8) + '01';
    const start = prompt('Periode start (YYYY-MM-DD)', first); if (!start) return;
    const end   = prompt('Periode einde (YYYY-MM-DD)', today); if (!end) return;
    try {
      const r = await window.KV.authedJson('/api/setter-payout-run', {
        method: 'POST',
        body: JSON.stringify({ setter_user_id: setterId, period_start: start, period_end: end }),
      });
      window.KV?.toast?.(r?.entry_count ? `Payout aangemaakt: ${r.entry_count} regels, ${eur(r.total_amount || 0)}` : 'Geen vrijgegeven regels in deze periode', 'ok');
      loadOverview(setterId);
    } catch (e) {
      window.KV?.toast?.('Payout mislukt: ' + (e?.message || 'onbekend'), 'warn');
    }
  };

  function _kpi(label, val, color) {
    return `<div style="flex:1;min-width:180px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm)">
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${esc(label)}</div>
      <div style="font-size:22px;font-weight:700;color:${color || 'var(--text-1)'}">${esc(eur(val))}</div>
    </div>`;
  }

  function _periodChips() {
    const opts = [
      ['dag',   'Dag'],
      ['week',  'Week'],
      ['maand', 'Maand'],
      ['jaar',  'Jaar'],
      ['custom','Custom'],
    ];
    const chips = opts.map(([k, l]) => {
      const active = _sp.period === k;
      return `<button class="chip ${active ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="window.__spSetPeriod('${k}')">${esc(l)}</button>`;
    }).join(' ');
    const custom = _sp.period === 'custom'
      ? `<span style="display:inline-flex;gap:6px;align-items:center;margin-left:8px">
          <input type="date" value="${esc(_sp.from)}" onchange="window.__spSetCustomFrom(this.value)"
            style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font-size:12px">
          <span style="color:var(--text-3);font-size:12px">tot</span>
          <input type="date" value="${esc(_sp.to)}" onchange="window.__spSetCustomTo(this.value)"
            style="padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font-size:12px">
        </span>`
      : '';
    return `<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;margin-bottom:14px">${chips}${custom}</div>`;
  }

  // ── Lijngrafiek ──────────────────────────────────────────────────────
  // SVG met 2 lijnen: realized (vol) + forecast (gestippeld). Theme-aware
  // via CSS-vars (--brand, --emerald, --border, --text-3). Y-schaal auto.
  function _timelineChart() {
    if (_sp.timelineLoading && !_sp.timeline) {
      return `<div style="padding:32px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);text-align:center;color:var(--text-3);margin-bottom:20px">Grafiek laden…</div>`;
    }
    if (_sp.timelineError) {
      return `<div style="padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);color:var(--rose);margin-bottom:20px">⚠ ${esc(_sp.timelineError)}</div>`;
    }
    const tl = _sp.timeline;
    if (!tl || !Array.isArray(tl.months) || !tl.months.length) return '';
    const months = tl.months;
    const W = 900, H_ = 220, pad = { l: 46, r: 14, t: 14, b: 34 };
    const iw = W - pad.l - pad.r;
    const ih = H_ - pad.t - pad.b;
    const maxV = Math.max(1, ...months.map((m) => Math.max(m.realized, m.forecast)));
    // Ronde bovengrens af op 100/500/1000 stapjes voor leesbaarheid.
    const step = maxV < 500 ? 100 : maxV < 2000 ? 500 : 1000;
    const yMax = Math.ceil(maxV / step) * step || step;
    const n = months.length;
    const xAt = (i) => pad.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
    const yAt = (v) => pad.t + ih - (Math.max(0, v) / yMax) * ih;

    // Grid + Y-labels
    const gridSteps = 4;
    const gridLines = [];
    for (let g = 0; g <= gridSteps; g++) {
      const y = pad.t + (ih * g) / gridSteps;
      const val = yMax * (1 - g / gridSteps);
      gridLines.push(
        `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1"/>` +
        `<text x="${pad.l - 6}" y="${y + 3}" text-anchor="end" font-size="10" fill="var(--text-3)" font-family="IBM Plex Mono, monospace">${eur(val).replace(/ /g, ' ')}</text>`
      );
    }
    // X-labels (elke 3e maand tonen om overlap te voorkomen)
    const xLabels = months.map((m, i) => {
      if (i % 3 !== 0 && i !== n - 1) return '';
      const x = xAt(i);
      return `<text x="${x}" y="${H_ - pad.b + 16}" text-anchor="middle" font-size="10" fill="var(--text-3)">${esc(m.label)}</text>`;
    }).join('');

    // Bepaal split-index tussen realized (verleden + huidige) en forecast
    // (vanaf volgende maand). Ledger-realized loopt door t/m huidige maand
    // (index 6 in de 25-bucket-lijst), forecast begint bij index 7.
    // Voor de lijnen tekenen we ALLE punten realized in eerste 7 buckets,
    // en ALLE punten forecast van bucket 6 tot 24 (overlap bij 6 = huidige
    // maand: kan beide bevatten).
    const realizedPts = months.map((m, i) => `${xAt(i)},${yAt(m.realized)}`).slice(0, 7).join(' ');
    const forecastPts = months.map((m, i) => `${xAt(i)},${yAt(m.forecast)}`).slice(6).join(' ');

    // Data-punten (kleine dots)
    const dots = months.map((m, i) => {
      const cx = xAt(i);
      const realY = yAt(m.realized);
      const foreY = yAt(m.forecast);
      const parts = [];
      if (i <= 6 && m.realized > 0) parts.push(`<circle cx="${cx}" cy="${realY}" r="2.5" fill="var(--emerald)"/>`);
      if (i >= 6 && m.forecast > 0) parts.push(`<circle cx="${cx}" cy="${foreY}" r="2.5" fill="var(--brand)" opacity="0.8"/>`);
      return parts.join('');
    }).join('');

    return `<div style="padding:18px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin-bottom:20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:14px;font-weight:600;color:var(--text-1)">Commissie-verloop (6 mnd terug · 18 mnd forecast)</div>
        <div style="display:flex;gap:14px;font-size:11px;color:var(--text-3)">
          <span><span style="display:inline-block;width:14px;height:2px;background:var(--emerald);vertical-align:middle;margin-right:4px"></span>Gerealiseerd</span>
          <span><span style="display:inline-block;width:14px;height:2px;background:var(--brand);vertical-align:middle;margin-right:4px;border-top:1px dashed var(--brand);border-bottom:0"></span>Forecast</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <svg viewBox="0 0 ${W} ${H_}" width="100%" style="min-width:640px;display:block;height:${H_}px" preserveAspectRatio="xMidYMid meet">
          ${gridLines.join('')}
          <polyline points="${realizedPts}" fill="none" stroke="var(--emerald)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          <polyline points="${forecastPts}" fill="none" stroke="var(--brand)" stroke-width="2" stroke-dasharray="5,4" stroke-linejoin="round" stroke-linecap="round"/>
          ${dots}
          ${xLabels}
        </svg>
      </div>
    </div>`;
  }

  // ── Sales-lijst (geattribueerde deals, ook vóór betaling) ─────────────
  function _salesTable(sales) {
    if (!Array.isArray(sales) || !sales.length) {
      return `<div style="padding:28px;text-align:center;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin-bottom:20px">Nog geen geattribueerde sales.</div>`;
    }
    const statusChip = (s) => {
      if (s === 'volledig')     return '<span style="color:var(--emerald);font-weight:600">✓ betaald</span>';
      if (s === 'gedeeltelijk') return '<span style="color:var(--amber)">◐ gedeeltelijk</span>';
      return '<span style="color:var(--text-3)">— geen betaling</span>';
    };
    const rows = sales.map((s) => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:7px 10px;font-size:12px">${esc(s.customer || '—')}</td>
      <td style="padding:7px 10px;font-size:12px;color:var(--text-3)">${esc(s.deal_ref || '—')}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(eur(s.bedrag))}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(eur(s.betaald))}</td>
      <td style="padding:7px 10px;font-size:11.5px">${statusChip(s.betaal_status)}</td>
      <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;color:var(--brand)">${esc(eur(s.verwachte_commissie))}</td>
      <td style="padding:7px 10px;font-size:11.5px;color:var(--text-3)">${esc(String(s.created_at || '').slice(0, 10))}</td>
    </tr>`).join('');
    return `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:8px">Mijn sales (geattribueerd)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase">
            <th style="padding:8px 10px">Klant</th>
            <th style="padding:8px 10px">Offerte</th>
            <th style="padding:8px 10px;text-align:right">Bedrag</th>
            <th style="padding:8px 10px;text-align:right">Betaald</th>
            <th style="padding:8px 10px">Betaalstatus</th>
            <th style="padding:8px 10px;text-align:right">Verwachte commissie</th>
            <th style="padding:8px 10px">Aangemaakt</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function overzichtView() {
    if (!_sp.data && !_sp.loading && !_sp.error) queueMicrotask(() => loadOverview(_sp.selectedSetter));
    if (!_sp.timeline && !_sp.timelineLoading && !_sp.timelineError) queueMicrotask(() => loadTimeline(_sp.selectedSetter));
    // BP3 v8 (2026-09-02) BUG-FIX — RBAC.getUserPermissions bestaat NIET;
    // gebruik canSync + ensurePermissionsLoaded. Zonder deze fix zag zelfs
    // super_admin geen staff-picker of "Uitbetaalronde draaien"-knop.
    if (window.RBAC && typeof window.RBAC.ensurePermissionsLoaded === 'function' && !_sp._permsWarmed) {
      _sp._permsWarmed = true;
      window.RBAC.ensurePermissionsLoaded().then(() => { if (window.DFO?.render) window.DFO.render(); }).catch(() => {});
    }
    const _canSync = (k) => !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync(k));
    const isAdmin  = _canSync('setter.ledger.admin');
    const canPayout = _canSync('setter.payout.manage');
    if (isAdmin && !_spStaff.items && !_spStaff.loading) queueMicrotask(() => loadStaff());

    const d = _sp.data;
    const staff = _spStaff.items || [];
    const staffPicker = isAdmin ? `
      <div style="margin-bottom:14px">
        <label style="font-size:11.5px;color:var(--text-3);margin-right:8px">Bekijk setter:</label>
        <select onchange="window.__spSelectSetter(this.value)" style="padding:5px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:12.5px">
          <option value="">— Ikzelf —</option>
          ${staff.map((s) => `<option value="${esc(s.id)}" ${_sp.selectedSetter === s.id ? 'selected' : ''}>${esc(s.full_name || s.email || s.id)}</option>`).join('')}
        </select>
      </div>` : '';

    if (_sp.loading && !d) return `<div class="pad" style="padding:20px">${staffPicker}${_periodChips()}<div>Laden…</div></div>`;
    if (_sp.error) return `<div class="pad" style="padding:20px">${staffPicker}${_periodChips()}<div style="color:var(--rose)">⚠ ${esc(_sp.error)}</div></div>`;
    if (!d) return `<div class="pad" style="padding:20px">${staffPicker}${_periodChips()}<div>Geen data.</div></div>`;

    const t = d.totals || {};
    const rows = (d.regels || []).map((r) => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:7px 10px;font-size:12px">${esc(r.customer || '—')}</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--text-3)">${esc(r.deal_ref || '—')}</td>
        <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums">${esc(eur(r.basis))}</td>
        <td style="padding:7px 10px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${esc(eur(r.amount))}</td>
        <td style="padding:7px 10px;font-size:11.5px">${r.status === 'uitbetaald' ? '<span style="color:var(--emerald)">✓ uitbetaald</span>' : '<span style="color:var(--amber)">◐ vrijgegeven</span>'}</td>
        <td style="padding:7px 10px;font-size:11.5px;color:var(--text-3)">${esc(String(r.created_at || '').slice(0, 10))}</td>
      </tr>`).join('');

    return `<div class="pad" style="padding:20px">
      ${staffPicker}
      ${_periodChips()}
      <div style="margin-bottom:8px;font-size:12px;color:var(--text-3)">Commissie-percentage: <b>${Number(d.pct || 0).toFixed(2)}%</b></div>
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
        ${_kpi('Uitbetaald totaal',           t.uitbetaald_totaal,          'var(--emerald)')}
        ${_kpi('Deze maand te ontvangen',     t.deze_maand_te_ontvangen,    'var(--brand)')}
        ${_kpi('Nog te verwachten (forecast)', t.forecast_nog_te_verwachten, 'var(--text-1)')}
        ${_kpi('Vervallen door annulering',   t.vervallen_door_annulering,  'var(--rose)')}
      </div>
      ${_timelineChart()}
      ${_salesTable(d.sales)}
      ${canPayout ? `<div style="margin-bottom:14px">
        <button class="btn btn-primary" style="font-size:12.5px;padding:6px 12px" onclick="window.__spRunPayout()">Uitbetaalronde draaien</button>
        <span style="margin-left:10px;font-size:11.5px;color:var(--text-3)">Bundelt alle vrijgegeven regels in de gekozen periode.</span>
      </div>` : ''}
      <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:8px">Uitbetaalregels (in periode)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase">
            <th style="padding:8px 10px">Klant</th>
            <th style="padding:8px 10px">Offerte</th>
            <th style="padding:8px 10px;text-align:right">Basis (bruto)</th>
            <th style="padding:8px 10px;text-align:right">Commissie</th>
            <th style="padding:8px 10px">Status</th>
            <th style="padding:8px 10px">Datum</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:28px;text-align:center;color:var(--text-3)">Nog geen regels in deze periode.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  window.DFO = window.DFO || { VIEWS: {} };
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['setter-payout/Overzicht'] = overzichtView;

  // Registreer als v2-native module bij de klanten-v2 shell zodat de
  // hash-router (#setter-payout) 'em oppikt i.p.v. terug te vallen op
  // dashboard. KV_V2_ADD is allowlist-gated; als 'em nog niet bestaat
  // (script-order race), schuif de id in KV_V2_PENDING zodat klanten-v2.js
  // 'em consumeert zodra het definieert.
  try {
    if (typeof window.KV_V2_ADD === 'function') {
      window.KV_V2_ADD('setter-payout');
    } else {
      window.KV_V2_PENDING = window.KV_V2_PENDING || [];
      window.KV_V2_PENDING.push('setter-payout');
    }
  } catch (_) { /* fail-soft */ }

  console.debug('[sp-v2] setter-payout view geregistreerd');
})();
