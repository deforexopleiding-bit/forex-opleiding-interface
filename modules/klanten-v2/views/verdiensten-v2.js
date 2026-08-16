// modules/klanten-v2/views/verdiensten-v2.js
//
// Verdiensten (mentor) — BROK 1: mentor-self reads. Alle mock vervangen door
// echte fetches op /api/mentor-* self-endpoints. Read-only in BROK 1 (write-
// acties komen in BROK 3). Module blijft DORMANT — 'verdiensten' staat NIET
// in V2_ACTIVE_ALLOWLIST; alleen bereikbaar via ?v2preview=verdiensten met
// rol "Mentor" via "Bekijk als".
//
// Endpoints gewired (self-scope, RBAC: mentor.module.access):
//   - /api/mentor-bonus-overview         → totals + projection_12m + per_event
//   - /api/mentor-payouts-list-self      → historie payouts (goedgekeurd/uitbetaald)
//   - /api/mentor-travel-days-self?period_month=YYYY-MM → huidige maand reisdagen + config
//   - /api/mentor-funded-certs-self      → funded-certs (€100 per claim per maand)
//
// Guardrails: 8s Promise.race timeout · asArr()-guards · in-flight loading-
// flag · fail-soft errBlk met "Opnieuw"-retry · geen render-loop (queueMicrotask
// + loading-guard). BTW-splitsing (total_excl vs btw_amount vs total) getoond
// waar de payload het geeft (payouts-lijst).
//
// v3.

(function () {
  if (!window.DFO) { console.error('[verdiensten-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[verdiensten-v2] KV_V2.helpers niet geladen.'); return; }
  if (!window.KV || !window.KV.authedJson) { console.error('[verdiensten-v2] KV.authedJson niet geladen — auth ontbreekt.'); return; }

  const { I, svg, S, F, eur0, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Helpers (data + utils) ───────────────────────────────────────────── */
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const eur   = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));

  // period_month bv "2026-07-01" → "juli 2026"
  const MONTH_NAMES_NL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  function fmtMonth(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return `${MONTH_NAMES_NL[d.getMonth()]} ${d.getFullYear()}`;
    } catch (_) { return String(iso); }
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (_) { return String(iso); }
  }
  // "2026-07-01" → "2026-07" (voor grouping/filter)
  function monthKey(iso) { return typeof iso === 'string' ? iso.slice(0, 7) : ''; }
  // Actuele maand als "YYYY-MM"
  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /* ── Fetch-helper (8s timeout, fail-soft) ─────────────────────────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout na ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[verdiensten-v2] fetch fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout' };
    }
  }

  /* ── State ────────────────────────────────────────────────────────────── */
  const _live = {
    overview: { loading: false, error: null, data: null },  // /api/mentor-bonus-overview
    payouts:  { loading: false, error: null, data: null },  // /api/mentor-payouts-list-self
    travel:   { loading: false, error: null, data: null, key: null }, // huidige maand
    certs:    { loading: false, error: null, data: null },  // /api/mentor-funded-certs-self
  };
  const _ui = {
    py: '26',  // periode-chip: '26' of '25' (jaartal-2-digit, mapt op yyyy)
  };
  const YEAR_OF = { '26': '2026', '25': '2025' };

  /* ── Loading-state helpers ────────────────────────────────────────────── */
  function skel() {
    return `<div class="pad" style="padding-top:16px">
      <div style="height:64px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite;margin-bottom:14px"></div>
      <div style="height:180px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite"></div>
    </div>`;
  }
  function errBlk(msg, retryHandler) {
    return `<div class="pad" style="padding-top:16px">
      <div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>⚠ ${String(msg || 'Onbekende fout')}</span>
        ${retryHandler ? `<button class="btn btn-ghost btn-sm" onclick="${retryHandler}">Opnieuw</button>` : ''}
      </div>
    </div>`;
  }

  /* ── Fetchers (met re-entrancy guard) ─────────────────────────────────── */
  async function fetchOverview() {
    if (_live.overview.loading) return;
    _live.overview.loading = true; _live.overview.error = null;
    const j = await tryFetch('overview', '/api/mentor-bonus-overview');
    _live.overview.loading = false;
    if (!j || j.__error) { _live.overview.error = j?.__error || 'Kon overzicht niet laden'; render(); return; }
    _live.overview.data = j;
    render();
  }
  async function fetchPayouts() {
    if (_live.payouts.loading) return;
    _live.payouts.loading = true; _live.payouts.error = null;
    const j = await tryFetch('payouts', '/api/mentor-payouts-list-self');
    _live.payouts.loading = false;
    if (!j || j.__error) { _live.payouts.error = j?.__error || 'Kon uitbetalingen niet laden'; render(); return; }
    _live.payouts.data = j;
    render();
  }
  async function fetchTravel(monthKeyStr) {
    const key = monthKeyStr || currentMonthKey();
    if (_live.travel.loading && _live.travel.key === key) return;
    _live.travel.loading = true; _live.travel.error = null; _live.travel.key = key;
    const j = await tryFetch('travel', `/api/mentor-travel-days-self?period_month=${encodeURIComponent(key)}`);
    _live.travel.loading = false;
    if (!j || j.__error) { _live.travel.error = j?.__error || 'Kon reisdagen niet laden'; render(); return; }
    _live.travel.data = j;
    render();
  }
  async function fetchCerts() {
    if (_live.certs.loading) return;
    _live.certs.loading = true; _live.certs.error = null;
    const j = await tryFetch('certs', '/api/mentor-funded-certs-self');
    _live.certs.loading = false;
    if (!j || j.__error) { _live.certs.error = j?.__error || 'Kon certificaten niet laden'; render(); return; }
    _live.certs.data = j;
    render();
  }

  /* ── Window handlers (retry-knoppen + periode-chip) ───────────────────── */
  window.__verdRetryOverview = () => { _live.overview.data = null; queueMicrotask(fetchOverview); };
  window.__verdRetryPayouts  = () => { _live.payouts.data  = null; queueMicrotask(fetchPayouts);  };
  window.__verdRetryTravel   = () => { _live.travel.data   = null; queueMicrotask(() => fetchTravel(currentMonthKey())); };
  window.__verdRetryCerts    = () => { _live.certs.data    = null; queueMicrotask(fetchCerts);    };
  window.__verdSetPy         = (v) => {
    if (v !== '25' && v !== '26') return;
    _ui.py = v;
    // F('py', v) heeft de shell-filter al gezet; wij re-renderen zodat de
    // client-side jaar-filter direct doorwerkt op payouts + certs.
    render();
  };

  /* ── Inline UI-helpers (viz + kaartjes) ───────────────────────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:158px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:100px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  function areaChart(data, labels) {
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [data.length > 1 ? i / (data.length - 1) * w : 0, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="verd-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#verd-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
  }

  const GRADICO = `<span style="width:26px;height:26px;border-radius:7px;background:var(--violet-soft);color:var(--violet);display:grid;place-items:center;flex-shrink:0">${svg(I.grad, 'width:14px;height:14px')}</span>`;

  // Rapport-status → pill-mapping
  const PAYOUT_STATUS_PILL = {
    concept:      { c: 'neutral', l: 'Concept' },
    open:         { c: 'info',    l: 'Ter beoordeling' },
    goedgekeurd:  { c: 'warn',    l: 'Goedgekeurd' },
    uitbetaald:   { c: 'ok',      l: 'Uitbetaald' },
  };
  function payoutPill(status) {
    const meta = PAYOUT_STATUS_PILL[String(status || '').toLowerCase()] || { c: 'neutral', l: status || '—' };
    return H.pill(meta.c, meta.l);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 1 — Verdiensten/Overzicht
     ═══════════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!_live.overview.loading && !_live.overview.data && !_live.overview.error) queueMicrotask(fetchOverview);
    if (_live.overview.error && !_live.overview.data) return errBlk(_live.overview.error, 'window.__verdRetryOverview()');
    if (!_live.overview.data) return skel();

    const d = _live.overview.data;
    const t = d.totals || {};
    const projArr = asArr(d.projection_12m);
    const perEvent = asArr(d.per_event);

    // 12-mnd projectie voor de areachart
    const chartData = projArr.map((r) => Number(r.amount) || 0);
    const chartLabels = projArr.map((r) => (typeof r.month === 'string' ? r.month.slice(5) : ''));

    // Opbouw-blok (max voor hbar-schaal)
    const dezeMaand    = Number(t.deze_maand)      || 0;
    const volgendeMnd  = Number(t.volgende_maand)  || 0;
    const openTotaal   = Number(t.open)            || 0;
    const betaaldUit   = Number(t.betaald_uit)     || 0;
    const earnedTotal  = Number(t.earned_total)    || 0;
    const mx = Math.max(dezeMaand, volgendeMnd, openTotaal, 1);

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Deze maand',        val: eur(dezeMaand),   sub: 'bonus-vrijgave' },
      { c: 'amber',   icon: I.clock, label: 'Volgende maand',    val: eur(volgendeMnd), sub: 'geplande vrijgave' },
      { c: 'teal',    icon: I.cal,   label: 'Openstaand totaal', val: eur(openTotaal),  sub: 'niet-uitbetaalde bonus' },
      { c: 'emerald', icon: I.chart, label: 'Totaal verdiend',   val: eur(earnedTotal), sub: 'alle bonussen sinds start' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('Bonus-status', 'blue',
          hbar('Betaald uit',       betaaldUit,  Math.max(earnedTotal, 1), 'emerald', eur(betaaldUit))
          + hbar('Open (nog niet uitbetaald)', openTotaal, Math.max(earnedTotal, 1), 'amber',   eur(openTotaal))
          + `<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px"><b>Totaal verdiend</b><b class="mono">${eur(earnedTotal)}</b></div>`)}
        ${dashCard('Deze maand vs volgende maand', 'emerald',
          hbar('Deze maand',      dezeMaand,     mx, 'blue',  eur(dezeMaand))
          + hbar('Volgende maand', volgendeMnd,  mx, 'amber', eur(volgendeMnd))
          + `<div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Cash-release-schema: bonus wordt vrijgegeven op het moment dat de bijbehorende factuur betaald is (of via cash-traject).</div>`)}
      </div>
      ${chartData.length ? `<div style="margin-top:14px">${dashCard('12-maands projectie', 'blue', areaChart(chartData, chartLabels))}</div>` : ''}
      ${perEvent.length ? `<div style="margin-top:14px">${dashCard('Per event', 'violet',
        perEvent.map((ev) => {
          const sales = asArr(ev.sales);
          const total = sales.reduce((a, s) => a + (Number(s.mentor_share_total) || 0), 0);
          return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600"><span>${H.esc ? H.esc(ev.event_title || '—') : (ev.event_title || '—')}</span><span class="mono">${eur(total)}</span></div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${fmtDate(ev.starts_at)} · ${sales.length} sale${sales.length === 1 ? '' : 's'}</div>
          </div>`;
        }).join(''))}</div>` : ''}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 2 — Verdiensten/Uitbetalingen
     ═══════════════════════════════════════════════════════════════════════ */
  function uitbetalingenView() {
    if (!_live.payouts.loading && !_live.payouts.data && !_live.payouts.error) queueMicrotask(fetchPayouts);
    if (_live.payouts.error && !_live.payouts.data) return errBlk(_live.payouts.error, 'window.__verdRetryPayouts()');
    if (!_live.payouts.data) return skel();

    const allPayouts = asArr(_live.payouts.data.payouts);
    const py = String(F('py', _ui.py) || _ui.py);
    const yr = YEAR_OF[py] || YEAR_OF['26'];

    // Client-side filter op jaar
    const rows = allPayouts.filter((p) => monthKey(p.period_month).startsWith(yr + '-'));
    const uitbetaald = rows.filter((r) => r.status === 'uitbetaald').reduce((a, r) => a + (Number(r.total) || 0), 0);
    const goedgekeurd = rows.filter((r) => r.status === 'goedgekeurd').reduce((a, r) => a + (Number(r.total) || 0), 0);
    const gem = rows.length ? Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) / rows.length) : 0;

    return `${H.kpis([
      { c: 'emerald', icon: I.tick,  label: 'Uitbetaald',    val: eur(uitbetaald),   sub: yr + ' · ' + rows.filter((r) => r.status === 'uitbetaald').length + ' rapport(en)' },
      { c: 'warn',    icon: I.clock, label: 'Goedgekeurd',   val: eur(goedgekeurd),  sub: 'wacht op uitbetaling' },
      { c: 'blue',    icon: I.cal,   label: 'Gem. per maand', val: eur(gem),         sub: rows.length + ' maanden' },
    ])}
    ${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${py === '26' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('26')">2026</button>
        <button class="btn ${py === '25' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('25')">2025</button>
      </div>`,
    ])}
    ${rows.length ? H.table(
      [
        { l: 'Periode' },
        { l: 'Totaal excl.', cls: 'r optional' },
        { l: 'BTW',          cls: 'r optional' },
        { l: 'Totaal incl.', cls: 'r' },
        { l: 'Uitbetaald op', cls: 'optional' },
        { l: 'Status' },
      ],
      rows.map((p) => [
        `<span class="cell-main">${fmtMonth(p.period_month)}</span>`,
        `<span class="money">${eur(Number(p.total_excl) || 0)}</span>`,
        `<span class="money">${eur(Number(p.btw_amount) || 0)}</span>`,
        `<span class="money"><b>${eur(Number(p.total) || 0)}</b></span>`,
        `<span style="color:var(--text-3)">${fmtDate(p.paid_at)}</span>`,
        payoutPill(p.status),
      ]),
    ) : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen uitbetalingen in ${yr}. Concept- en 'open'-rapporten zijn hier niet zichtbaar (die staan bij finance ter beoordeling).</div>`}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 3 — Verdiensten/Reiskosten
     ═══════════════════════════════════════════════════════════════════════ */
  function reiskostenView() {
    const mk = currentMonthKey();
    if (!_live.travel.loading && !_live.travel.data && !_live.travel.error) queueMicrotask(() => fetchTravel(mk));
    if (_live.travel.error && !_live.travel.data) return errBlk(_live.travel.error, 'window.__verdRetryTravel()');
    if (!_live.travel.data) return skel();

    const t = _live.travel.data;
    if (!t.travel_enabled) {
      return `<div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.route)}</div>
        <div class="empty-t">Reiskostenvergoeding staat niet aan</div>
        <div class="empty-s">Voor jou is de reiskostenvergoeding (nog) niet ingeschakeld. Neem contact op met kantoor als dit wel zou moeten.</div>
      </div>`;
    }

    const dayRate = Number(t.day_rate_incl) || 0;
    const days    = Number(t.days)          || 0;
    const amount  = dayRate * days;
    const editable = !!t.editable;
    const status   = t.status || null;

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Vergoeding per rijdag', val: eur(dayRate),                sub: 'jouw vaste bedrag' },
      { c: 'amber',   icon: I.route, label: 'Doorgegeven deze maand', val: String(days),              sub: fmtMonth(t.period_month) },
      { c: 'emerald', icon: I.chart, label: 'Vergoeding deze maand',  val: eur(amount),                sub: days + ' × ' + eur(dayRate) },
    ])}
    <div class="pad" style="padding-top:16px">
      ${dashCard('Huidige maand · ' + fmtMonth(t.period_month), 'blue', `
        <div style="display:flex;align-items:flex-start;gap:11px;padding-bottom:12px;font-size:12.5px;color:var(--text-2)">
          ${svg(I.clock, 'width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--amber)')}
          <span>Reisdagen worden pas verwerkt in het maandrapport. Rapport-status: ${status ? payoutPill(status) : '<i>nog geen concept aangemaakt</i>'}. ${editable ? 'Nog aanpasbaar tot goedkeuring door finance.' : '<b>Vergrendeld</b> — rapport is al goedgekeurd/uitbetaald.'}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2)">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Doorgegeven</div>
            <div class="mono" style="font-size:20px;font-weight:600">${days} <span style="font-size:12px;color:var(--text-3);font-weight:400">dagen</span></div>
          </div>
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2)">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Vergoeding</div>
            <div class="mono" style="font-size:20px;font-weight:600;color:var(--emerald)">${eur(amount)}</div>
          </div>
        </div>
        <div style="margin-top:12px;padding:10px 12px;background:var(--surface-2);border-radius:var(--r);font-size:11.5px;color:var(--text-3)">
          ℹ Doorgeven / bijwerken van reisdagen komt in BROK 3 (write-actie met validatie tegen goedgekeurd rapport).
        </div>
      `)}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 4 — Verdiensten/Certificaten (HERONTWORPEN → funded-certs)
     ═══════════════════════════════════════════════════════════════════════ */
  function certificatenView() {
    if (!_live.certs.loading && !_live.certs.data && !_live.certs.error) queueMicrotask(fetchCerts);
    if (_live.certs.error && !_live.certs.data) return errBlk(_live.certs.error, 'window.__verdRetryCerts()');
    if (!_live.certs.data) return skel();

    const allCerts = asArr(_live.certs.data.certs);
    const py = String(F('py', _ui.py) || _ui.py);
    const yr = YEAR_OF[py] || YEAR_OF['26'];

    // Filter op jaar (client-side)
    const rows = allCerts.filter((c) => monthKey(c.funded_month).startsWith(yr + '-'));

    // Group by funded_month (YYYY-MM-01)
    const byMonth = new Map();
    rows.forEach((c) => {
      const k = monthKey(c.funded_month);
      if (!byMonth.has(k)) byMonth.set(k, { period: c.funded_month, items: [] });
      byMonth.get(k).items.push(c);
    });
    const months = Array.from(byMonth.values()).sort((a, b) => (b.period || '').localeCompare(a.period || ''));

    const totalCerts = rows.length;
    const totalMonths = months.length;
    const totalBonus = totalCerts * 100;

    return `${H.kpis([
      { c: 'violet',  icon: I.grad, label: 'Funded-certs ' + yr, val: String(totalCerts), sub: totalMonths + ' maand(en)' },
      { c: 'emerald', icon: I.tick, label: 'Bonus ' + yr,        val: eur(totalBonus),    sub: '€ 100 per geclaimd cert' },
    ])}
    ${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${py === '26' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('26')">2026</button>
        <button class="btn ${py === '25' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('25')">2025</button>
      </div>`,
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);font-size:12.5px;color:var(--text-2);margin-bottom:14px">
        ℹ Elke geclaimde funded-cert = <b>€ 100 bonus</b> in het maandrapport. Uploaden gebeurt per student vanuit de <b>Mijn studenten</b>-flow (komt in BROK 3). De <code>funded_month</code> wordt gelockt bij de eerste upload — geen dubbele claims mogelijk.
      </div>
      ${months.length ? months.map((m) => `${dashCard(fmtMonth(m.period) + ' · ' + m.items.length + ' cert(s)', 'violet',
        H.table(
          [
            { l: 'Student' },
            { l: 'Bestand',  cls: 'optional' },
            { l: 'Ge-upload', cls: 'optional' },
            { l: 'Bonus',    cls: 'r' },
          ],
          m.items.map((c) => [
            `<div style="display:flex;align-items:center;gap:10px">${GRADICO}<span class="cell-main">${H.esc ? H.esc(c.student_name || '—') : (c.student_name || '—')}</span></div>`,
            `<span style="color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${H.esc ? H.esc(c.file_name || '—') : (c.file_name || '—')}</span>`,
            `<span style="color:var(--text-3)">${fmtDate(c.last_uploaded_at)}</span>`,
            `<span class="money">${eur(100)}</span>`,
          ]),
        ),
      )}<div style="height:12px"></div>`).join('') : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen funded-certificaten in ${yr} geclaimd.</div>`}
    </div>`;
  }

  /* ── Registratie ──────────────────────────────────────────────────────── */
  window.DFO.VIEWS['verdiensten/Overzicht']     = overzichtView;
  window.DFO.VIEWS['verdiensten/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['verdiensten/Reiskosten']    = reiskostenView;
  window.DFO.VIEWS['verdiensten/Certificaten']  = certificatenView;

  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('verdiensten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('verdiensten');
  }

  console.debug('[verdiensten-v2] BROK 1 (v3) — 4 views geregistreerd met echte /api/mentor-* endpoints (dormant tot allowlist of ?v2preview=verdiensten met rol Mentor)');
})();
