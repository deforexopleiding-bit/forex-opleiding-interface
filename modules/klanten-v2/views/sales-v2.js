// modules/klanten-v2/views/sales-v2.js
//
// Data-ronde #1 — Sales als referentie-module.
// Live data via bestaande endpoints (geen nieuwe backend, hergebruik wat
// sales.html + dashboard nu al draaien):
//   Dashboard         → /api/sales-dashboard-stats
//                     + /api/sales-dashboard-metrics
//                     + /api/sales-pending-subscriptions
//   Offertes          → /api/sales-quotations?status&search&owned_by_me
//   Retentie          → /api/sales-retention?owned_by_me
//   Verkoopprestaties → /api/sales-reports?from&to&group_by
//
// SAFETY (identiek aan dashboard-v2.js patroon):
//   - Render meteen; async invullen — nooit blokkeren op fetch.
//   - 8s timeout per call (Promise.race); faal → nette "—"/lege staat.
//   - Sequence-tracking per tab tegen race-condities.
//   - _live.loading als render-loop-guard (auto-fetch-hook checkt !loading).
//   - Alleen bestaande endpoints, GEEN nieuwe backend.
//   - Write-acties routeren naar /modules/sales-wizard.html (bestaand).
//
// Dormant (niet in V2_ACTIVE_ALLOWLIST). Bereikbaar via ?v2preview=sales.

(function () {
  if (!window.DFO) { console.error('[sales-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[sales-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;
  const K = () => window.KV;

  // ── State per tab (los zodat cross-tab-fetches niet elkaars data raken) ──
  const _dash = { loading: false, error: null, stats: null, metrics: null, pending: null, seq: 0, boot: false };
  const _off  = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _ret  = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _rep  = { loading: false, error: null, data: null, seq: 0, params: '' };

  // ── tryFetch: race met 8s-timeout, fail-soft null-return + console.warn ──
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[sales-v2] fetch fail:', label, '→', e?.message || e);
      return null;
    }
  }

  // Format-helpers (fallback op eigen Intl als DFO.eur / eur0 niet aanwezig).
  const eur  = window.DFO.eur  || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));
  const eur0 = window.DFO.eur0 || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n));
  const dstr = (iso) => { if (!iso) return '—'; try { const d = new Date(iso); return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const num  = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);

  // Preview-mode badge (vervangt VOORBEELD-banner nu er live data is).
  function previewHeader(label, extra) {
    const err = extra?.error ? `<span class="prev-badge-err">${extra.error}</span>` : '';
    const loading = extra?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

  const OST_TO_PILL = {
    draft:     ['neutral', 'Concept'],
    sent:      ['info',    'Verzonden'],
    accepted:  ['ok',      'Geaccepteerd'],
    declined:  ['warn',    'Afgewezen'],
    cancelled: ['neutral', 'Geannuleerd'],
  };

  const RET_STATUS_TO_PILL = (item) => {
    if (item.retention_not_renewing) return ['warn', 'Niet verlengen'];
    if ((item.days_left || 0) < 0)   return ['warn', 'Afgelopen'];
    if ((item.days_left || 0) <= 14) return ['info', `Nog ${item.days_left} d`];
    return ['neutral', `Nog ${item.days_left} d`];
  };

  // ── DASHBOARD ────────────────────────────────────────────────────────────
  async function fetchDashboard() {
    if (_dash.loading) return;
    const seq = ++_dash.seq;
    _dash.loading = true; _dash.error = null;
    window.DFO.render();
    const [stats, metrics, pending] = await Promise.all([
      tryFetch('sales-dashboard-stats',    '/api/sales-dashboard-stats'),
      tryFetch('sales-dashboard-metrics',  '/api/sales-dashboard-metrics'),
      tryFetch('sales-pending-subscriptions', '/api/sales-pending-subscriptions'),
    ]);
    if (seq !== _dash.seq) return; // race-guard
    _dash.stats = stats; _dash.metrics = metrics; _dash.pending = pending;
    _dash.loading = false;
    if (stats == null && metrics == null && pending == null) _dash.error = 'Alle 3 dashboard-calls faalden';
    window.DFO.render();
  }

  function dashboardView() {
    // Auto-fetch bij eerste render (loop-guard: !boot + !loading).
    if (!_dash.boot && !_dash.loading) {
      _dash.boot = true;
      queueMicrotask(fetchDashboard);
    }
    const m = _dash.metrics || {};
    const s = _dash.stats   || {};
    const p = _dash.pending || {};
    const openActies = s.open_acties?.total ?? null;
    const recent = Array.isArray(m.my_recent_quotations) ? m.my_recent_quotations : [];

    return `${previewHeader('Dashboard', _dash)}
      ${H.kpis([
        { c: 'violet',  icon: I.doc,    label: 'Mijn open offertes',      val: num(m.my_open_quotations),  hi: 1, sub: 'nog niet getekend' },
        { c: 'emerald', icon: I.euro,   label: 'Mijn omzet deze maand',   val: eur0(m.my_revenue_month),   hi: 1, sub: `${num(m.my_sales_count_month)} deals` },
        { c: 'blue',    icon: I.trend,  label: 'Mijn hoogste deal',       val: eur0(m.my_highest_deal),           sub: 'deze maand' },
        { c: 'orange',  icon: I.warn,   label: 'Open follow-up-acties',   val: num(openActies),                   sub: 'in mijn werklijst' },
      ])}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.mail)}Vandaag & week</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Afspraken vandaag</span><b>${num(s.appointments_today_count)}</b></div>
            <div class="sv-row"><span>Afspraken morgen</span><b>${num(s.appointments_tomorrow_count)}</b></div>
            <div class="sv-row"><span>Nieuwe leads (vandaag)</span><b>${num(s.today?.leads)}</b></div>
            <div class="sv-row"><span>Nieuwe leads (deze week)</span><b>${num(s.week?.leads)}</b></div>
            <div class="sv-row"><span>Events (deze week)</span><b>${num(s.week?.events)}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Bonus + onboarding</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Openstaande bonus deze maand</span><b>${eur0(m.my_bonus_month)}</b></div>
            <div class="sv-row"><span>Onboardings live</span><b>${num(m.onboarding_count)}</b></div>
            <div class="sv-row"><span>Retentie-klanten (≤30d)</span><b>${num(m.retention_count)}</b></div>
            <div class="sv-row"><span>Pending subscription-koppelingen</span><b>${num(p.count)}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.trend)}Mijn recente offertes</div>
          <div class="sv-card-body">
            ${recent.length ? recent.slice(0, 6).map(q => `
              <div class="sv-recent">
                <div class="sv-recent-l">
                  <div class="cell-main">${(q.customer_name || '—')}</div>
                  <div class="sv-recent-sub">${q.quote_reference || 'OFF-' + String(q.deal_id || '').slice(0, 6)} · ${dstr(q.created_at)}</div>
                </div>
                <div class="sv-recent-r">
                  <span class="mono">${eur0(q.total_amount)}</span>
                  ${H.pill((OST_TO_PILL[q.tl_quotation_status] || ['neutral', q.tl_quotation_status || '—'])[0], (OST_TO_PILL[q.tl_quotation_status] || ['neutral', q.tl_quotation_status || '—'])[1])}
                </div>
              </div>`).join('') : `<div class="sv-empty">${_dash.loading ? 'Laden…' : (m.my_recent_quotations ? 'Nog geen recente offertes.' : '—')}</div>`}
          </div>
        </div>
      </div>`;
  }

  // ── OFFERTES ─────────────────────────────────────────────────────────────
  window.__svOfferteNew  = () => { window.location.href = '/modules/sales-wizard.html'; };
  window.__svOfferteOpen = (dealId) => { if (dealId) window.location.href = '/modules/sales-wizard.html?edit_deal_id=' + encodeURIComponent(dealId); };

  function offertesParams() {
    const status = F('sv-off-st', 'all');
    const mine   = F('sv-off-mine', '1') === '1' ? '1' : '';
    const q      = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (status && status !== 'all') p.set('status', status);
    if (mine) p.set('owned_by_me', '1');
    if (q)    p.set('search', q);
    p.set('page', '1');
    p.set('page_size', '25');
    return p.toString();
  }

  async function fetchOffertes() {
    const wanted = offertesParams();
    if (_off.loading && _off.params === wanted) return;
    const seq = ++_off.seq;
    _off.loading = true; _off.error = null; _off.params = wanted;
    window.DFO.render();
    const data = await tryFetch('sales-quotations', '/api/sales-quotations?' + wanted);
    if (seq !== _off.seq) return;
    _off.loading = false; _off.data = data;
    if (!data) _off.error = 'Kon offertes niet laden';
    window.DFO.render();
  }

  function offertesView() {
    const st   = F('sv-off-st', 'all');
    const mine = F('sv-off-mine', '1');
    // Trigger fetch bij eerste render OF wanneer filter-params veranderd zijn.
    const wanted = offertesParams();
    if (!_off.loading && (!_off.data || _off.params !== wanted)) queueMicrotask(fetchOffertes);
    const items = _off.data?.quotations || [];
    const total = _off.data?.total ?? null;
    return `${previewHeader('Offertes', _off)}
      ${H.toolbar([
        H.chips('sv-off-st', [
          { l: 'Alle',         v: 'all' },
          { l: 'Concept',      v: 'draft' },
          { l: 'Verzonden',    v: 'sent' },
          { l: 'Geaccepteerd', v: 'accepted' },
          { l: 'Afgewezen',    v: 'declined' },
        ], st),
        H.chips('sv-off-mine', [
          { l: 'Mijn offertes', v: '1' },
          { l: 'Alle',          v: '0' },
        ], mine),
        H.search('Zoek klant / offerte-nr…'),
        `<div class="tb-right">
          <button class="btn btn-primary" onclick="__svOfferteNew()">${svg(I.plus)}Nieuwe offerte</button>
        </div>`,
      ])}
      <div class="sv-total">${_off.loading ? 'Laden…' : (total != null ? `${total} offerte${total === 1 ? '' : 's'}` : '—')}</div>
      ${H.table(
        [{ l: 'Offerte-nr' }, { l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Verkoper', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Datum', cls: 'r optional' }, { l: 'Status' }],
        items.map(q => [
          `<a href="javascript:__svOfferteOpen('${q.deal_id}')" class="cell-main">${q.quote_reference || 'OFF-' + String(q.deal_id || '').slice(0, 6)}</a>`,
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(q.customer_name || '?')}</div><span class="cell-main">${q.customer_name || '—'}</span></div>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${q.traject_label || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${q.sales_user || '—'}</span>`,
          `<span class="mono">${eur0(q.total_amount)}</span>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(q.created_at)}</span>`,
          H.pill((OST_TO_PILL[q.tl_quotation_status] || ['neutral', q.tl_quotation_status || '—'])[0], (OST_TO_PILL[q.tl_quotation_status] || ['neutral', q.tl_quotation_status || '—'])[1]),
        ])
      )}
      ${!items.length && !_off.loading ? `<div class="sv-empty">${_off.error ? _off.error : 'Geen offertes met deze filters.'}</div>` : ''}`;
  }

  // ── RETENTIE ─────────────────────────────────────────────────────────────
  function retentieParams() {
    const mine = F('sv-ret-mine', '0') === '1' ? '1' : '';
    return mine ? 'owned_by_me=1' : '';
  }
  async function fetchRetentie() {
    const wanted = retentieParams();
    if (_ret.loading && _ret.params === wanted) return;
    const seq = ++_ret.seq;
    _ret.loading = true; _ret.error = null; _ret.params = wanted;
    window.DFO.render();
    const url = '/api/sales-retention' + (wanted ? '?' + wanted : '');
    const data = await tryFetch('sales-retention', url);
    if (seq !== _ret.seq) return;
    _ret.loading = false; _ret.data = data;
    if (!data) _ret.error = 'Kon retentie niet laden';
    window.DFO.render();
  }

  function retentieView() {
    const mine = F('sv-ret-mine', '0');
    const wanted = retentieParams();
    if (!_ret.loading && (!_ret.data || _ret.params !== wanted)) queueMicrotask(fetchRetentie);
    const items = _ret.data?.items || [];
    return `${previewHeader('Retentie', _ret)}
      ${H.kpis([
        { c: 'violet',  icon: I.repeat, label: 'Retentie-klanten',       val: num(items.length), hi: 1, sub: 'sub loopt binnen 30d af' },
        { c: 'orange',  icon: I.warn,   label: 'Al gemarkeerd',          val: num(items.filter(i => i.retention_not_renewing).length), sub: 'niet-verlengen' },
        { c: 'emerald', icon: I.check,  label: 'Actieve subs (totaal)',  val: num(items.reduce((a, i) => a + (i.active_subs_count || 0), 0)), sub: 'over alle retentie-klanten' },
      ])}
      ${H.toolbar([
        H.chips('sv-ret-mine', [
          { l: 'Alle', v: '0' },
          { l: 'Mijn klanten', v: '1' },
        ], mine),
      ])}
      ${H.table(
        [{ l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Mentor', cls: 'optional' }, { l: 'Einddatum', cls: 'r' }, { l: 'Nog', cls: 'r' }, { l: 'Actieve subs', cls: 'r optional' }, { l: 'Status' }],
        items.map(i => {
          const [c, l] = RET_STATUS_TO_PILL(i);
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(i.customer_name || '?')}</div><span class="cell-main">${i.customer_name || '—'}</span></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${i.traject_label || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${i.mentor_name || 'Niet toegewezen'}</span>`,
            `<span class="mono">${dstr(i.end_date)}</span>`,
            `<span class="mono">${i.days_left != null ? i.days_left + ' d' : '—'}</span>`,
            `<span class="mono">${num(i.active_subs_count)}</span>`,
            H.pill(c, l),
          ];
        })
      )}
      ${!items.length && !_ret.loading ? `<div class="sv-empty">${_ret.error ? _ret.error : 'Geen retentie-klanten in dit venster.'}</div>` : ''}`;
  }

  // ── VERKOOPPRESTATIES ───────────────────────────────────────────────────
  function rangeFor(pKey) {
    const now = new Date(); const to = now.toISOString().slice(0, 10);
    const from = new Date(now); const days = pKey === '7' ? 7 : pKey === '30' ? 30 : pKey === '365' ? 365 : 90;
    from.setDate(from.getDate() - days);
    return { from: from.toISOString().slice(0, 10), to, group_by: days <= 30 ? 'day' : days <= 90 ? 'week' : 'month' };
  }
  function reportsParams() {
    const p = F('sv-rep-p', '90');
    const r = rangeFor(p);
    return `from=${r.from}&to=${r.to}&group_by=${r.group_by}`;
  }
  async function fetchReports() {
    const wanted = reportsParams();
    if (_rep.loading && _rep.params === wanted) return;
    const seq = ++_rep.seq;
    _rep.loading = true; _rep.error = null; _rep.params = wanted;
    window.DFO.render();
    const data = await tryFetch('sales-reports', '/api/sales-reports?' + wanted);
    if (seq !== _rep.seq) return;
    _rep.loading = false; _rep.data = data;
    if (!data) _rep.error = 'Kon rapport niet laden';
    window.DFO.render();
  }

  function prestatiesView() {
    const p = F('sv-rep-p', '90');
    const wanted = reportsParams();
    if (!_rep.loading && (!_rep.data || _rep.params !== wanted)) queueMicrotask(fetchReports);
    const k = _rep.data?.kpis || {};
    const funnel = _rep.data?.funnel || [];
    const bySales = _rep.data?.by_sales_user || [];
    const trend = _rep.data?.trend || [];
    const trendMax = Math.max(1, ...trend.map(t => Number(t.revenue) || 0));

    return `${previewHeader('Verkoopprestaties', _rep)}
      ${H.kpis([
        { c: 'violet',  icon: I.trend,  label: 'Pipeline-waarde',    val: eur0(k.pipeline_value), hi: 1, sub: 'open + verzonden' },
        { c: 'emerald', icon: I.euro,   label: 'Omzet in periode',   val: eur0(k.revenue_period), hi: 1 },
        { c: 'blue',    icon: I.doc,    label: 'Bonus openstaand',   val: eur0(k.bonus_pending) },
        { c: 'orange',  icon: I.repeat, label: 'Retentie-ratio',     val: k.retention_rate != null ? Math.round(k.retention_rate * 100) + '%' : '—' },
      ])}
      ${H.toolbar([
        H.chips('sv-rep-p', [
          { l: '7 d',    v: '7' },
          { l: '30 d',   v: '30' },
          { l: '90 d',   v: '90' },
          { l: '365 d',  v: '365' },
        ], p),
      ])}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Verkoop-funnel</div>
          <div class="sv-card-body">
            ${(Array.isArray(funnel) && funnel.length) ? funnel.map(f => `
              <div class="sv-row"><span>${f.label || f.stage || '—'}</span><b>${num(f.count ?? f.value ?? f.total)}</b></div>
            `).join('') : `<div class="sv-empty">${_rep.loading ? 'Laden…' : 'Geen funnel-data.'}</div>`}
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.users)}Per verkoper</div>
          <div class="sv-card-body">
            ${(Array.isArray(bySales) && bySales.length) ? bySales.slice(0, 8).map(u => `
              <div class="sv-row"><span>${u.full_name || u.name || u.sales_user || '—'}</span><b>${eur0(u.revenue ?? u.total ?? u.total_amount)}</b></div>
            `).join('') : `<div class="sv-empty">${_rep.loading ? 'Laden…' : 'Geen data per verkoper.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.trend)}Omzet-trend</div>
          <div class="sv-card-body">
            ${(Array.isArray(trend) && trend.length) ? `<div class="sv-trend">${trend.map(t => {
              const rev = Number(t.revenue) || 0;
              const h = Math.max(3, Math.round(rev / trendMax * 100));
              return `<div class="sv-trend-col" title="${t.label || t.bucket || t.date || ''} · ${eur0(rev)}">
                <div class="sv-trend-bar" style="height:${h}%"></div>
                <div class="sv-trend-lbl">${t.label || t.bucket || (t.date ? String(t.date).slice(5, 10) : '')}</div>
              </div>`;
            }).join('')}</div>` : `<div class="sv-empty">${_rep.loading ? 'Laden…' : 'Geen trend-data.'}</div>`}
          </div>
        </div>
      </div>`;
  }

  window.DFO.VIEWS['sales/Dashboard']         = dashboardView;
  window.DFO.VIEWS['sales/Offertes']          = offertesView;
  window.DFO.VIEWS['sales/Retentie']          = retentieView;
  window.DFO.VIEWS['sales/Verkoopprestaties'] = prestatiesView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('sales');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('sales');
  console.debug('[sales-v2] registered 4 views (data-round · live endpoints)');
})();
