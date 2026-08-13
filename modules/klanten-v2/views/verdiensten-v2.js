// modules/klanten-v2/views/verdiensten-v2.js
//
// Fase C module #3 — Verdiensten (mentor-finance) voor v2-shell.
// DATA-KOPPELING 2026-08-13: read-only live-endpoints, dormant tot
// allowlist. Preview via ?v2preview=verdiensten (én rol Mentor via
// 'Bekijk als').
//
// Endpoints (allen mentor.module.access, self-scope via auth.uid()):
//   - GET  /api/mentor-bonus-overview            (Overzicht + Uitbetalingen KPI's)
//   - GET  /api/mentor-coaching-earnings?from=&to=  (coaching-verdiensten)
//   - GET  /api/mentor-payouts-list-self         (Uitbetalingen historie)
//   - GET  /api/mentor-travel-days-self?period_month=YYYY-MM  (Reiskosten)
//   - POST /api/mentor-travel-days-self          (rijdagen doorgeven)
//
// Certificaten-tab: semantiek onbekend — v2-scaffold toont mentor-EIGEN
// trainingscerts (€100 bonus per stuk), maar /api/mentor-funded-certs-self
// gaat over STUDENT-funded-certs (€100 per student-cert). Needs Jeffrey.
// Tab toont een expliciete "needs Jeffrey" empty-state met verwijzing naar
// v1 mentor-dashboard voor de student-funded-cert flow.

(function () {
  if (!window.DFO) { console.error('[verdiensten-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[verdiensten-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, eur0, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── Live-state per data-blok ──────────────────────────────────────────
  const _live = {
    overview:   { loading: false, error: null, data: null },
    coaching:   { loading: false, error: null, data: null },
    payouts:    { loading: false, error: null, data: null },
    travelDays: { loading: false, error: null, byMonth: new Map() },
    travelSubmitting: false,
  };

  // ── Fetch-helper: 8s timeout + asArr-guards + fail-soft ───────────────
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[verd-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }
  async function tryPost(label, url, body, timeoutMs = 10000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, { method: 'POST', body: JSON.stringify(body) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[verd-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  // ── Datum-helpers ─────────────────────────────────────────────────────
  function _todayNL() { const d = new Date(); return d; }
  function _ymOf(d) {
    const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }
  function _currentYm() { return _ymOf(_todayNL()); }
  function _prevYm(ym, back) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 - back, 1);
    return _ymOf(d);
  }
  const MAAND_NL = ['Januari','Februari','Maart','April','Mei','Juni','Juli','Augustus','September','Oktober','November','December'];
  function _ymLabel(ym) {
    if (!ym || typeof ym !== 'string') return '—';
    const [y, m] = ym.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
    return (MAAND_NL[m - 1] || m) + ' ' + y;
  }
  function _isoToNL(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── Fetchers per data-blok ────────────────────────────────────────────
  async function fetchOverview() {
    const st = _live.overview;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('overview', '/api/mentor-bonus-overview');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchCoaching() {
    const st = _live.coaching;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const now = _todayNL();
    const from = _ymOf(new Date(now.getFullYear(), 0, 1)) + '-01';
    const to   = _ymOf(now) + '-' + String(new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()).padStart(2, '0');
    const j = await tryFetch('coaching', '/api/mentor-coaching-earnings?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchPayouts() {
    const st = _live.payouts;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('payouts', '/api/mentor-payouts-list-self');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { payouts: asArr(j?.payouts) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchTravelDays(months) {
    const st = _live.travelDays;
    if (st.loading) return;
    st.loading = true; st.error = null;
    try {
      const results = await Promise.all(months.map((ym) => tryFetch('travel:' + ym, '/api/mentor-travel-days-self?period_month=' + encodeURIComponent(ym))));
      let firstErr = null;
      results.forEach((r, i) => {
        if (r && r.__error) { if (!firstErr) firstErr = r.__error; return; }
        if (r && typeof r === 'object') st.byMonth.set(months[i], r);
      });
      st.error = firstErr;
    } catch (e) { st.error = e?.message || 'onbekende fout'; }
    st.loading = false;
    if (window.DFO?.render) window.DFO.render();
  }

  // ── Retry-knop-handler ────────────────────────────────────────────────
  window.__verdRetry = (block) => {
    if (block === 'overview')   { _live.overview.data   = null; _live.overview.error   = null; fetchOverview(); }
    if (block === 'coaching')   { _live.coaching.data   = null; _live.coaching.error   = null; fetchCoaching(); }
    if (block === 'payouts')    { _live.payouts.data    = null; _live.payouts.error    = null; fetchPayouts(); }
    if (block === 'travelDays') { _live.travelDays.byMonth = new Map(); _live.travelDays.error = null; _loadTravelHistory(); }
    if (window.DFO?.render) window.DFO.render();
  };

  // ── Travel-day submit ─────────────────────────────────────────────────
  window.__verdDienRijdagen = async () => {
    if (_live.travelSubmitting) return;
    const el = document.getElementById('rijdagenInp');
    const v = el ? parseInt(el.value, 10) : NaN;
    if (!Number.isFinite(v) || v < 0 || v > 62) { alert('Vul een geldig aantal rijdagen in (0–62).'); return; }
    _live.travelSubmitting = true;
    if (window.DFO?.render) window.DFO.render();
    const ym = _currentYm();
    const j = await tryPost('travel:submit', '/api/mentor-travel-days-self', { period_month: ym, days: v });
    _live.travelSubmitting = false;
    if (j && j.__error) {
      alert('Doorgeven mislukt: ' + j.__error);
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    // Herlaad huidige maand + historie na succes.
    _live.travelDays.byMonth = new Map();
    _loadTravelHistory();
    try { window.KV?.toast?.('Rijdagen doorgegeven'); } catch (_) {}
  };

  function _loadTravelHistory() {
    const now = _currentYm();
    const months = [now, _prevYm(now, 1), _prevYm(now, 2), _prevYm(now, 3), _prevYm(now, 4), _prevYm(now, 5)];
    fetchTravelDays(months);
  }

  // ── UI-helpers (bewaard uit scaffold, geen mock-data meer) ────────────
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:130px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:82px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  function areaChart(data, labels) {
    if (!Array.isArray(data) || !data.length) return '<div style="color:var(--text-3);font-size:12px;padding:12px 0">Geen data.</div>';
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [i / Math.max(1, data.length - 1) * w, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="verd-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#verd-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${labels.map((l) => `<span>${esc(l)}</span>`).join('')}</div>`;
  }

  // ── Skeleton + error-blocks ───────────────────────────────────────────
  const skelKpis = () => `<div class="kpi-row" style="opacity:.55">${Array.from({length:4}).map(()=>`<div class="kpi kpi-blue"><div class="kpi-l"><div class="kpi-lbl">Laden…</div><div class="kpi-val">—</div></div></div>`).join('')}</div>`;
  const skelCard = () => `<div class="pad" style="padding-top:16px"><div class="card"><div class="card-body" style="padding:22px"><div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:12px"></div><div style="height:8px;width:80%;background:var(--surface-2);border-radius:4px;margin-bottom:8px"></div><div style="height:8px;width:70%;background:var(--surface-2);border-radius:4px"></div></div></div></div>`;
  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon gegevens niet ophalen: ${esc(msg || 'onbekende fout')}</span>
    <button class="btn btn-ghost btn-sm" onclick="__verdRetry('${block}')">Opnieuw</button>
  </div>`;
  const emptyBlk = (title, sub) => `<div class="empty" style="padding:44px 20px">
    <div class="empty-t">${esc(title)}</div>
    <div class="empty-s">${esc(sub || '')}</div>
  </div>`;

  window.__verdGoToReiskosten = () => { try { goTab('Reiskosten'); } catch (_) {} };

  // ── VIEW 1: Overzicht ─────────────────────────────────────────────────
  function overzichtView() {
    // Lazy-load beide fetches op eerste render.
    if (!_live.overview.data && !_live.overview.loading && !_live.overview.error) queueMicrotask(fetchOverview);
    if (!_live.coaching.data && !_live.coaching.loading && !_live.coaching.error) queueMicrotask(fetchCoaching);

    // Guard: als beide errors → toon één error-blok met retry.
    if (_live.overview.error && !_live.overview.data) return skelKpis() + errBlk('overview', _live.overview.error);
    if (_live.overview.loading && !_live.overview.data) return skelKpis() + skelCard();

    const o = _live.overview.data || {};
    const t = o.totals || {};
    const c = _live.coaching.data || {};
    const coachingMonth = _monthCoaching(c);
    const coachingYtd = Number(c.grand_total || 0);
    const deze = Number(t.deze_maand || 0) + coachingMonth;
    const volgende = Number(t.volgende_maand || 0);
    const open = Number(t.open || 0);
    const verdiendTotaal = Number(t.earned_total || 0) + coachingYtd;

    const proj = asArr(o.projection_12m);
    const projData = proj.map((p) => Number(p?.amount || 0));
    const projLbls = proj.map((p) => _shortMonthLabel(p?.month));

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Verdiend deze maand',   val: eur0(deze),           sub: _ymLabel(_currentYm()) },
      { c: 'amber',   icon: I.clock, label: 'Volgende maand (proj.)', val: eur0(volgende),      sub: _ymLabel(_prevYm(_currentYm(), -1)) },
      { c: 'teal',    icon: I.cal,   label: 'Openstaand',            val: eur0(open),           sub: 'nog uit te betalen' },
      { c: 'emerald', icon: I.chart, label: 'Totaal verdiend',       val: eur0(verdiendTotaal), sub: 'coaching + bonussen · YTD' },
    ])}
    ${_live.coaching.error ? errBlk('coaching', _live.coaching.error) : ''}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('Opbouw deze maand — ' + _ymLabel(_currentYm()), 'blue',
          hbar('Coaching (1-op-1 + team)', coachingMonth, Math.max(coachingMonth, Number(t.deze_maand || 0), 1), 'teal', eur0(coachingMonth))
          + hbar('Event-bonussen', Number(t.deze_maand || 0), Math.max(coachingMonth, Number(t.deze_maand || 0), 1), 'violet', eur0(Number(t.deze_maand || 0)))
          + `<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px"><b>Subtotaal (excl. reiskosten)</b><b class="mono">${eur0(deze)}</b></div>`)}
        ${dashCard('Openstaand', 'emerald',
          `<div style="text-align:center;padding:8px 0">
            <div style="font-size:30px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:var(--emerald)">${eur0(open)}</div>
            <div style="font-size:12px;color:var(--text-3);margin:4px 0 14px">nog te ontvangen</div>
            <div style="font-size:11.5px;color:var(--text-2)">Volgende uitbetalingen worden per maand verwerkt; controleer de tab <b>Uitbetalingen</b> voor status.</div>
          </div>`)}
      </div>
      <div style="margin-top:14px">${dashCard('Bonus-projectie komende 12 maanden', 'blue',
        proj.length ? areaChart(projData, projLbls) : `<div style="color:var(--text-3);font-size:12px;padding:12px 0">Nog geen projectie beschikbaar.</div>`)}</div>
    </div>`;
  }
  function _monthCoaching(coachingData) {
    if (!coachingData || typeof coachingData !== 'object') return 0;
    // grand_total is YTD; monthly-breakdown is optioneel — heuristiek: pak
    // laatste breakdown-entry indien key = huidige YYYY-MM.
    const b = coachingData.breakdown;
    if (b && typeof b === 'object' && b[_currentYm()]) {
      const v = b[_currentYm()];
      if (typeof v === 'number') return v;
      if (typeof v === 'object' && v.total != null) return Number(v.total || 0);
    }
    return 0;
  }
  function _shortMonthLabel(ym) {
    if (!ym) return '';
    const [y, m] = String(ym).split('-').map(Number);
    if (!Number.isFinite(m)) return String(ym);
    return (MAAND_NL[m - 1] || '').slice(0, 3).toLowerCase();
  }

  // ── VIEW 2: Uitbetalingen ─────────────────────────────────────────────
  function uitbetalingenView() {
    if (!_live.payouts.data && !_live.payouts.loading && !_live.payouts.error) queueMicrotask(fetchPayouts);
    if (_live.payouts.error && !_live.payouts.data) return skelKpis() + errBlk('payouts', _live.payouts.error);
    if (_live.payouts.loading && !_live.payouts.data) return skelKpis() + skelCard();

    const payouts = asArr(_live.payouts.data?.payouts);
    const uitbetaald = payouts.filter((p) => p.status === 'uitbetaald').reduce((a, p) => a + Number(p.total || 0), 0);
    const goedgekeurd = payouts.filter((p) => p.status === 'goedgekeurd').reduce((a, p) => a + Number(p.total || 0), 0);
    const gem = payouts.length ? Math.round(payouts.reduce((a, p) => a + Number(p.total || 0), 0) / payouts.length) : 0;

    return `${H.kpis([
      { c: 'emerald', icon: I.tick,  label: 'Uitbetaald totaal',    val: eur0(uitbetaald), sub: payouts.filter((p) => p.status === 'uitbetaald').length + ' uitbetalingen' },
      { c: 'amber',   icon: I.clock, label: 'Goedgekeurd (nog uit)', val: eur0(goedgekeurd), sub: payouts.filter((p) => p.status === 'goedgekeurd').length + ' rijen' },
      { c: 'blue',    icon: I.cal,   label: 'Gemiddeld per maand',   val: eur0(gem),         sub: payouts.length ? ('laatste ' + payouts.length + ' maanden') : '—' },
    ])}
    ${payouts.length === 0
      ? emptyBlk('Nog geen uitbetalingen', 'Zodra kantoor je eerste maand-uitbetaling verwerkt verschijnt die hier.')
      : H.table(
          [{ l: 'Periode' }, { l: 'Excl. BTW', cls: 'r optional' }, { l: 'BTW', cls: 'r optional' }, { l: 'Totaal', cls: 'r' }, { l: 'Aangemaakt', cls: 'optional' }, { l: 'Uitbetaald op', cls: 'optional' }, { l: 'Status' }],
          payouts.map((p) => [
            `<span class="cell-main">${esc(_ymLabel(p.period_month))}</span>`,
            `<span class="money">${eur0(Number(p.total_excl || 0))}</span>`,
            `<span class="money">${eur0(Number(p.btw_amount || 0))}</span>`,
            `<span class="money"><b>${eur0(Number(p.total || 0))}</b></span>`,
            `<span style="color:var(--text-3)">${esc(_isoToNL(p.created_at))}</span>`,
            `<span style="color:var(--text-3)">${p.paid_at ? esc(_isoToNL(p.paid_at)) : '—'}</span>`,
            p.status === 'uitbetaald' ? H.pill('ok', 'Uitbetaald') : H.pill('warn', 'Goedgekeurd'),
          ])
        )}`;
  }

  // ── VIEW 3: Reiskosten ────────────────────────────────────────────────
  function reiskostenView() {
    if (_live.travelDays.byMonth.size === 0 && !_live.travelDays.loading && !_live.travelDays.error) {
      queueMicrotask(_loadTravelHistory);
    }
    if (_live.travelDays.error && _live.travelDays.byMonth.size === 0) return skelKpis() + errBlk('travelDays', _live.travelDays.error);
    if (_live.travelDays.loading && _live.travelDays.byMonth.size === 0) return skelKpis() + skelCard();

    const currentYm = _currentYm();
    const current = _live.travelDays.byMonth.get(currentYm) || null;

    // Als travel_enabled=false op de huidige maand: mentor heeft geen
    // reiskostenvergoeding-config. Toon net dezelfde empty-state als v1.
    if (current && current.travel_enabled === false) {
      return `<div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.route || I.euro)}</div>
        <div class="empty-t">Reiskostenvergoeding staat niet aan</div>
        <div class="empty-s">Voor jou is de reiskostenvergoeding (nog) niet ingeschakeld. Neem contact op met kantoor als dit wel zou moeten.</div>
      </div>`;
    }

    const dayRate = Number(current?.day_rate_incl || 0);
    const history = Array.from(_live.travelDays.byMonth.entries())
      .filter(([ym]) => ym !== currentYm)
      .map(([ym, r]) => ({ ym, ...(r || {}) }))
      .sort((a, b) => b.ym.localeCompare(a.ym));

    const jaar = history.reduce((a, r) => a + (Number(r.days || 0) * Number(r.day_rate_incl || dayRate)), 0)
      + (current && current.status !== null ? (Number(current.days || 0) * dayRate) : 0);

    const openInput = !current || (current.editable !== false && !current.submitted);

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Vergoeding per rijdag', val: eur0(dayRate), sub: 'jouw vaste bedrag' },
      { c: 'amber',   icon: I.route || I.clock, label: 'Open aanvraag', val: openInput ? '1' : '0', hi: openInput ? 1 : 0, sub: openInput ? _ymLabel(currentYm) : 'niets openstaand' },
      { c: 'emerald', icon: I.chart, label: 'Reiskosten dit jaar',   val: eur0(jaar), sub: history.length + ' maanden historie' },
    ])}
    <div class="pad" style="padding-top:16px">
      ${openInput ? _travelInputCard(currentYm, dayRate, current) : _travelDoneCard(currentYm, current)}
      <div style="margin-top:14px">${dashCard('Doorgegeven rijdagen', 'blue',
        history.length
          ? H.table(
              [{ l: 'Maand' }, { l: 'Rijdagen', cls: 'r' }, { l: 'Per dag', cls: 'r optional' }, { l: 'Vergoeding', cls: 'r' }, { l: 'Status' }],
              history.map((r) => {
                const dr = Number(r.day_rate_incl || dayRate);
                const days = Number(r.days || 0);
                return [
                  `<span class="cell-main">${esc(_ymLabel(r.ym))}</span>`,
                  `<span class="mono">${days}</span>`,
                  `<span class="money">${eur0(dr)}</span>`,
                  `<span class="money">${eur0(days * dr)}</span>`,
                  r.status === 'uitbetaald' ? H.pill('ok', 'Uitbetaald') : (r.status === 'goedgekeurd' ? H.pill('warn', 'Wordt verwerkt') : H.pill('neutral', 'Verwerking')),
                ];
              })
            )
          : `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Nog geen historie.</div>`)}</div>
    </div>`;
  }
  function _travelInputCard(ym, dayRate, current) {
    const submitting = !!_live.travelSubmitting;
    return dashCard('Rijdagen doorgeven — ' + _ymLabel(ym), 'amber', `
      <div style="display:flex;align-items:flex-start;gap:11px;padding-bottom:14px;font-size:12.5px;color:var(--text-2)">
        ${svg(I.clock, 'width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--amber)')}
        <span>Hoeveel dagen heb je in <b>${esc(_ymLabel(ym))}</b> gereden? Geef het door vóór de eerstvolgende uitbetaling.</span>
      </div>
      <div style="display:grid;grid-template-columns:160px auto 1fr;gap:14px;align-items:end">
        <div><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:7px">Aantal rijdagen</div>
          <input class="inp" id="rijdagenInp" type="number" min="0" max="62" style="max-width:none" placeholder="0"
            value="${current && current.days != null ? current.days : ''}"
            oninput="var b=document.getElementById('rijBedrag');if(b)b.textContent='€ '+((parseInt(this.value)||0)*${dayRate})"></div>
        <button class="btn btn-primary" onclick="__verdDienRijdagen()" ${submitting ? 'disabled' : ''}>${svg(I.tick)}${submitting ? 'Doorgeven…' : 'Doorgeven'}</button>
        <div style="text-align:right;font-size:12.5px;color:var(--text-3)">Vergoeding: <b id="rijBedrag" class="mono" style="color:var(--text);font-size:15px">€ ${(Number(current?.days || 0) * dayRate)}</b> <span>(${eur0(dayRate)}/dag)</span></div>
      </div>`);
  }
  function _travelDoneCard(ym, current) {
    const days = Number(current?.days || 0);
    const dr = Number(current?.day_rate_incl || 0);
    return `<div style="display:flex;align-items:center;gap:11px;padding:14px 16px;background:var(--emerald-soft);border:1px solid var(--emerald-line);border-radius:var(--r);font-size:13px;color:var(--emerald)">
      ${svg(I.tick, 'width:16px;height:16px')}
      <span><b>${esc(_ymLabel(ym))}</b> is doorgegeven — ${days} rijdag${days === 1 ? '' : 'en'} × ${eur0(dr)} = <b>${eur0(days * dr)}</b>. Wordt meegenomen in de eerstvolgende uitbetaling.</span>
    </div>`;
  }

  // ── VIEW 4: Certificaten — needs Jeffrey ──────────────────────────────
  function certificatenView() {
    return `<div class="empty" style="padding:72px 20px">
      <div class="empty-ico">${svg(I.grad || I.doc)}</div>
      <div class="empty-t">Certificaten-tab komt in een volgende ronde</div>
      <div class="empty-s" style="max-width:520px;margin:0 auto">
        Semantiek is nog niet eenduidig — het bestaande endpoint
        <code>/api/mentor-funded-certs-self</code> gaat over <b>student</b>-certificaten
        (funded-cert bonus) en niet over mentor-eigen trainingscerts zoals
        deze v2-tab in de layout-ronde toonde. We koppelen dit zodra Jeffrey
        heeft besloten of hij een aparte tabel voor mentor-trainingscerts
        wil, of dat deze tab de funded-cert flow overneemt (of vervalt).
        Voor nu: student-funded-cert uploads blijven in de v1-mentor-dashboard.
      </div>
    </div>`;
  }

  // ── Registratie ───────────────────────────────────────────────────────
  window.DFO.VIEWS['verdiensten/Overzicht']     = overzichtView;
  window.DFO.VIEWS['verdiensten/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['verdiensten/Reiskosten']    = reiskostenView;
  window.DFO.VIEWS['verdiensten/Certificaten']  = certificatenView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('verdiensten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('verdiensten');
  }

  console.debug('[verdiensten-v2] data-ronde geregistreerd — dormant tot allowlist of ?v2preview=verdiensten');
})();
