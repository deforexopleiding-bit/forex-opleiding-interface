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
// Setter-salesoverzicht (2026-10):
//   - Saleslijst op deals.total_amount (incl. btw): Naam | Bedrag | Traject |
//     Eerste termijn | Termijnen | Offerte | Ontvangen | Verwachte commissie.
//   - Klik op een rij → betaalplan (reserveringsfee / aanbetaling / N ×
//     termijn met datums), commissie per betaling en de aansluiting op het
//     offertebedrag (afrondingsverschil vs. echte mismatch).
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
    openSale: null,                    // deal_id van het opengeklapte sale-detail
    monthly: null, monthlyLoading: false, monthlyError: null,
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
  async function loadMonthly(setterId) {
    _sp.monthlyLoading = true; _sp.monthlyError = null;
    const q = setterId ? ('?setter_user_id=' + encodeURIComponent(setterId)) : '';
    const j = await tryFetch('monthly', '/api/setter-commission-monthly' + q);
    _sp.monthlyLoading = false;
    if (!j) _sp.monthlyError = 'Kon maandoverzicht niet laden'; else _sp.monthly = j;
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
    _sp.openSale = null;
    _sp.monthly = null;
    loadOverview(id).catch(() => {});
    loadTimeline(id).catch(() => {});
    loadMonthly(id).catch(() => {});
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
  // Klik op een rij → detail met het betaalplan (reserveringsfee /
  // aanbetaling / termijnen), commissie per betaling en de aansluiting op
  // het offertebedrag. Alle bedragen incl. BTW (deals.total_amount).
  const fmtDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '—';
  };
  const _num = 'text-align:right;font-variant-numeric:tabular-nums';
  window.__spToggleSale = (id) => {
    _sp.openSale = (_sp.openSale === id) ? null : id;
    if (window.DFO?.render) window.DFO.render();
  };

  function _offerteChip(s) {
    if (!s.in_afwachting) return '<span style="color:var(--emerald);font-weight:600">✓ geaccepteerd</span>';
    return `<span style="color:var(--amber);font-weight:600">◔ ${esc(s.offerte_status_label || 'in afwachting')}</span>`;
  }

  function _aansluitingBlok(plan) {
    const a = plan.aansluiting || {};
    const delen = [];
    if (plan.reserveringsfee?.van_toepassing) delen.push(`reserveringsfee ${eur(plan.reserveringsfee.bedrag)}`);
    if (plan.aanbetaling?.bedrag > 0) delen.push(`aanbetaling ${eur(plan.aanbetaling.bedrag)}`);
    if (plan.termijnen?.aantal > 0) delen.push(`${plan.termijnen.aantal} × ${eur(plan.termijnen.bedrag)}`);
    const som = `${delen.join(' + ') || '—'} = <b>${esc(eur(a.som))}</b> · offertebedrag <b>${esc(eur(a.totaal))}</b>`;
    const stijl = {
      ok:         ['var(--emerald)', '✓ Sluit aan'],
      afronding:  ['var(--amber)',   '≈ Afrondingsverschil'],
      mismatch:   ['var(--rose)',    '⚠ Sluit NIET aan'],
      geen_plan:  ['var(--amber)',   '⚠ Geen betaalplan'],
    }[a.status] || ['var(--text-3)', ''];
    return `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--border);border-left:3px solid ${stijl[0]};border-radius:var(--r-sm);font-size:12px;color:var(--text-2)">
      <div><span style="font-weight:600;color:${stijl[0]}">${esc(stijl[1])}</span> — ${som}</div>
      ${a.melding ? `<div style="margin-top:4px;color:${stijl[0]}">${esc(a.melding)}</div>` : ''}
    </div>`;
  }

  function _saleDetail(s) {
    const plan = s.plan || {};
    const pct = Number(plan.pct || 0);
    const heeftOntvangen = Array.isArray(s.ontvangen_regels);
    const kv = (k, v) => `<div style="min-width:150px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">${esc(k)}</div><div style="font-size:12.5px;color:var(--text-1);margin-top:2px">${v}</div></div>`;
    const fee = plan.reserveringsfee || {};
    const info = [
      kv('Bedrag (incl. btw)', `<b>${esc(eur(s.bedrag))}</b>`),
      kv('Traject', esc(s.traject || '—')),
      kv('Offerte', _offerteChip(s) + (s.geaccepteerd_op ? ` <span style="color:var(--text-3)">${esc(fmtDate(s.geaccepteerd_op))}</span>` : '')),
      kv('Deal-datum', esc(fmtDate(s.deal_datum))),
      kv('Start cursus', esc(fmtDate(s.start_cursus))),
      kv('Eerste termijn', esc(fmtDate(s.eerste_termijn))),
      kv('Aantal termijnen', esc(String(plan.termijnen?.aantal || 0))),
      kv('Bedrag per termijn', esc(eur(plan.termijnen?.bedrag || 0))),
      kv('Aanbetaling', plan.aanbetaling?.bedrag > 0 ? `${esc(eur(plan.aanbetaling.bedrag))} <span style="color:var(--text-3)">op ${esc(fmtDate(plan.aanbetaling.datum))}</span>` : '—'),
      kv('Reserveringsfee', fee.van_toepassing
        ? `${esc(eur(fee.bedrag))} <span style="color:var(--text-3)">${fee.factuur_id ? 'gefactureerd' : 'wordt gefactureerd bij aanmaken abonnement'}</span>`
        : '—'),
    ].join('');
    const soortLabel = (r) => r.soort === 'termijn' ? `Termijn ${r.nr}` : (r.soort === 'aanbetaling' ? 'Aanbetaling' : 'Reserveringsfee');
    const schemaRows = (plan.schema || []).map((r) => `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 10px;font-size:12px">${esc(soortLabel(r))}</td>
        <td style="padding:5px 10px;font-size:12px;color:var(--text-3)">${r.datum ? esc(fmtDate(r.datum)) : 'bij aanmaken abonnement'}</td>
        <td style="padding:5px 10px;font-size:12px;${_num}">${esc(eur(r.bedrag))}</td>
        <td style="padding:5px 10px;font-size:12px;${_num};color:var(--brand)">${esc(eur(r.commissie))}</td>
      </tr>`).join('');
    const ontvangenBlok = heeftOntvangen ? _ontvangenTabel(s) : '';
    return `<div style="padding:14px 16px;background:var(--surface-2, var(--surface));border-top:1px dashed var(--border)">
      ${s.in_afwachting ? `<div style="margin-bottom:10px;font-size:12px;color:var(--amber)">Offerte is nog niet geaccepteerd — commissie ontstaat pas na acceptatie én betaling.</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:14px 22px;margin-bottom:12px">${info}</div>
      <div style="font-size:12.5px;font-weight:600;color:var(--text-1);margin:6px 0">Gepland betaalschema · jouw ${esc(pct.toFixed(2).replace('.', ','))}% per betaling</div>
      <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:10.5px;text-transform:uppercase">
          <th style="padding:5px 10px">Moment</th><th style="padding:5px 10px">Gepland</th>
          <th style="padding:5px 10px;text-align:right">Bedrag</th><th style="padding:5px 10px;text-align:right">Commissie</th>
        </tr></thead>
        <tbody>${schemaRows || `<tr><td colspan="4" style="padding:12px;text-align:center;color:var(--text-3)">Geen betaalplan op de deal.</td></tr>`}</tbody>
        <tfoot><tr>
          <td colspan="2" style="padding:6px 10px;font-size:12px;font-weight:600">Totaal bij volledige betaling</td>
          <td style="padding:6px 10px;font-size:12px;${_num};font-weight:600">${esc(eur(plan.aansluiting?.som || 0))}</td>
          <td style="padding:6px 10px;font-size:12px;${_num};font-weight:700;color:var(--brand)">${esc(eur(plan.commissie_totaal || 0))}</td>
        </tr></tfoot>
      </table></div>
      ${_aansluitingBlok(plan)}
      ${ontvangenBlok}
    </div>`;
  }

  // Fase B vult sale.ontvangen_regels (facturen met wat er echt binnenkwam).
  function _ontvangenTabel(s) {
    const regels = s.ontvangen_regels || [];
    if (!regels.length) {
      return `<div style="margin-top:12px;font-size:12px;color:var(--text-3)">Nog geen ontvangen betalingen op deze sale.</div>`;
    }
    const rows = regels.map((r) => `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:5px 10px;font-size:12px">${esc(r.factuurnummer || '—')}</td>
        <td style="padding:5px 10px;font-size:12px;color:var(--text-3)">${esc(r.soort || '')}</td>
        <td style="padding:5px 10px;font-size:12px;color:var(--text-3)">${esc(fmtDate(r.betaald_op))}</td>
        <td style="padding:5px 10px;font-size:12px;${_num}">${esc(eur(r.ontvangen))}</td>
        <td style="padding:5px 10px;font-size:12px;${_num};color:var(--brand)">${esc(eur(r.commissie))}</td>
      </tr>`).join('');
    return `<div style="font-size:12.5px;font-weight:600;color:var(--text-1);margin:14px 0 6px">Ontvangen</div>
      <div class="tbl-wrap"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:10.5px;text-transform:uppercase">
          <th style="padding:5px 10px">Factuur</th><th style="padding:5px 10px">Soort</th><th style="padding:5px 10px">Betaald op</th>
          <th style="padding:5px 10px;text-align:right">Ontvangen</th><th style="padding:5px 10px;text-align:right">Commissie</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ── Commissie per maand (maand = betaaldatum van de factuur) ──────────
  const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
  const maandLabel = (ym) => { const m = /^(\d{4})-(\d{2})/.exec(String(ym || '')); return m ? `${MAANDEN[Number(m[2]) - 1]} ${m[1]}` : String(ym || ''); };
  function _monthlySection() {
    if (_sp.monthlyError) return `<div style="margin-bottom:20px;color:var(--rose);font-size:12px">⚠ ${esc(_sp.monthlyError)}</div>`;
    const m = _sp.monthly;
    if (!m) return _sp.monthlyLoading ? `<div style="margin-bottom:20px;color:var(--text-3);font-size:12px">Maandoverzicht laden…</div>` : '';
    const banner = m.dry_run
      ? `<div style="margin-bottom:8px;padding:8px 12px;border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:var(--r-sm);font-size:12px;color:var(--text-2)">Proefmodus: de commissie wordt berekend uit de facturen maar nog <b>niet geboekt</b>. "Berekend" laat zien wat er geboekt gaat worden.</div>`
      : '';
    const rows = (m.maanden || []).map((r) => `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:6px 10px;font-size:12px">${esc(maandLabel(r.maand))}</td>
        <td style="padding:6px 10px;font-size:12px;${_num}">${esc(eur(r.ontvangen))}</td>
        <td style="padding:6px 10px;font-size:12px;${_num};color:var(--brand);font-weight:600">${esc(eur(r.berekend))}</td>
        <td style="padding:6px 10px;font-size:12px;${_num}">${esc(eur(r.geboekt))}</td>
        <td style="padding:6px 10px;font-size:12px;${_num};color:var(--emerald)">${esc(eur(r.uitbetaald))}</td>
      </tr>`).join('');
    return `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:4px">Commissie per maand</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">Op de maand waarin de klant betaalde · ${esc(Number(m.pct || 0).toFixed(2).replace('.', ','))}% van elk ontvangen bedrag incl. btw · creditnota's tellen niet als betaling.</div>
      ${banner}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden"><div class="tbl-wrap">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase">
            <th style="padding:8px 10px">Maand</th>
            <th style="padding:8px 10px;text-align:right">Ontvangen</th>
            <th style="padding:8px 10px;text-align:right">Commissie berekend</th>
            <th style="padding:8px 10px;text-align:right">Geboekt</th>
            <th style="padding:8px 10px;text-align:right">Uitbetaald</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:22px;text-align:center;color:var(--text-3)">Nog geen ontvangen betalingen op jouw sales.</td></tr>`}</tbody>
        </table>
      </div></div>
    </div>`;
  }

  function _salesTable(sales) {
    if (!Array.isArray(sales) || !sales.length) {
      return `<div style="padding:28px;text-align:center;color:var(--text-3);background:var(--surface);border:1px solid var(--border);border-radius:var(--r);margin-bottom:20px">Nog geen geattribueerde sales.</div>`;
    }
    const COLS = 8;
    const rows = sales.map((s) => {
      const open = _sp.openSale === s.deal_id;
      const waarschuwing = s.plan?.aansluiting?.status === 'mismatch' || s.plan?.aansluiting?.status === 'geen_plan'
        ? ' <span title="Betaalplan sluit niet aan op het offertebedrag" style="color:var(--rose)">⚠</span>' : '';
      return `<tr style="border-bottom:1px solid var(--border);cursor:pointer${open ? ';background:var(--surface-2, transparent)' : ''}" onclick="window.__spToggleSale('${esc(s.deal_id)}')">
        <td style="padding:7px 10px;font-size:12px"><span style="color:var(--text-3);margin-right:6px">${open ? '▾' : '▸'}</span>${esc(s.customer || '—')}${waarschuwing}</td>
        <td style="padding:7px 10px;font-size:12px;${_num}">${esc(eur(s.bedrag))}</td>
        <td style="padding:7px 10px;font-size:12px">${esc(s.traject || '—')}</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--text-2)">${esc(fmtDate(s.eerste_termijn))}</td>
        <td style="padding:7px 10px;font-size:12px;text-align:center">${esc(String(s.aantal_termijnen || 0))}</td>
        <td style="padding:7px 10px;font-size:11.5px">${_offerteChip(s)}</td>
        <td style="padding:7px 10px;font-size:12px;${_num}">${esc(eur(s.betaald))}</td>
        <td style="padding:7px 10px;font-size:12px;${_num};font-weight:600;color:var(--brand)">${esc(eur(s.verwachte_commissie))}</td>
      </tr>${open ? `<tr><td colspan="${COLS}" style="padding:0">${_saleDetail(s)}</td></tr>` : ''}`;
    }).join('');
    return `<div style="margin-bottom:20px">
      <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:4px">Mijn sales (geattribueerd)</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">Bedragen incl. btw (offertebedrag). Klik op een sale voor het betaalplan en je commissie per betaling.</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div class="tbl-wrap">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase">
              <th style="padding:8px 10px">Naam</th>
              <th style="padding:8px 10px;text-align:right">Bedrag</th>
              <th style="padding:8px 10px">Traject</th>
              <th style="padding:8px 10px" title="payment_term_start_date — datum van de eerste termijn">Eerste termijn</th>
              <th style="padding:8px 10px;text-align:center">Termijnen</th>
              <th style="padding:8px 10px">Offerte</th>
              <th style="padding:8px 10px;text-align:right">Ontvangen</th>
              <th style="padding:8px 10px;text-align:right">Verwachte commissie</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  }

  function overzichtView() {
    if (!_sp.data && !_sp.loading && !_sp.error) queueMicrotask(() => loadOverview(_sp.selectedSetter));
    if (!_sp.timeline && !_sp.timelineLoading && !_sp.timelineError) queueMicrotask(() => loadTimeline(_sp.selectedSetter));
    if (!_sp.monthly && !_sp.monthlyLoading && !_sp.monthlyError) { _sp.monthlyLoading = true; queueMicrotask(() => loadMonthly(_sp.selectedSetter)); }
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
      ${Number(t.in_afwachting_offerte) > 0 ? `<div style="margin:-12px 0 20px;font-size:12px;color:var(--text-3)">Daarnaast <b>${esc(eur(t.in_afwachting_offerte))}</b> commissie op offertes die nog niet geaccepteerd zijn (niet in de forecast).</div>` : ''}
      ${_timelineChart()}
      ${_monthlySection()}
      ${_salesTable(d.sales)}
      ${canPayout ? `<div style="margin-bottom:14px">
        <button class="btn btn-primary" style="font-size:12.5px;padding:6px 12px" onclick="window.__spRunPayout()">Uitbetaalronde draaien</button>
        <span style="margin-left:10px;font-size:11.5px;color:var(--text-3)">Bundelt alle vrijgegeven regels in de gekozen periode.</span>
      </div>` : ''}
      <div style="font-size:14px;font-weight:600;color:var(--text-1);margin-bottom:8px">Uitbetaalregels (in periode)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div class="tbl-wrap">
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
