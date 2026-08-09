// modules/klanten-v2/views/finance-v2.js
//
// Data-ronde — Finance als live-module. 6 tabs (uit MODS): Dashboard /
// Facturen / Abonnementen / Creditnota's / Bank / Omzet & MRR.
//
// KRITIEK — beschermde-zone-scheiding:
// - Wanbetalers is een APARTE module (Fase H). Finance-tab-set bevat
//   die NIET. Deze view rendert GEEN dunning/joost/voys/arrangements/
//   pending-actions data. Uit /api/finance-dashboard-counts negeren we
//   expliciet de velden: actieveArrangements, openVerifyPayment,
//   openEscalations, joostStats, conversieWanbetalersFlow.
// - Alleen bestaande endpoints, GEEN nieuwe backend.
//
// Endpoints per tab:
//   Dashboard      → /api/finance-dashboard-counts?period=<>
//   Facturen       → /api/finance-invoices?status&entity&from&to&q&page&page_size
//   Abonnementen   → /api/sales-subscriptions-list?status&page&page_size
//                    (Finance-html heeft geen abo-tab; sales-subscriptions
//                     is de gedeelde bron)
//   Creditnota's   → /api/finance-creditnotes-list?q&from&to&page&page_size
//   Bank           → /api/finance-bank-camt-balance
//                    + /api/finance-bank-camt-transactions?direction&from&to&q&limit&offset
//   Omzet & MRR    → /api/super-admin-omzet?from&to&group_by
//                    (Finance-html heeft geen Omzet-tab; super-admin-omzet
//                     is de gedeelde bron van dashboard.html)
//
// Dormant. Preview ?v2preview=finance (rol super_admin/admin/manager/sales).

(function () {
  if (!window.DFO) { console.error('[finance-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[finance-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;

  // ── State per tab ─────────────────────────────────────────────────────
  const _dash = { loading: false, error: null, data: null, seq: 0, period: '' };
  const _inv  = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _sub  = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _cn   = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _bnk  = { loading: false, error: null, bal: null, tx: null, seq: 0, params: '' };
  const _mrr  = { loading: false, error: null, data: null, seq: 0, params: '' };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[finance-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  const eur  = window.DFO.eur  || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));
  const eur0 = window.DFO.eur0 || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n));
  const eurC = (cents) => cents == null ? '—' : eur0(cents / 100);
  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const num  = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);
  const isoDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
  const monthStart = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };
  const todayIso = () => isoDay(new Date());

  function previewHeader(label, state) {
    const err = state?.error ? `<span class="prev-badge-err">${state.error}</span>` : '';
    const loading = state?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

  const INV_STATUS_TO_PILL = {
    open:                 ['info',    'Open'],
    partially_paid:       ['info',    'Deels betaald'],
    paid:                 ['ok',      'Betaald'],
    overdue:              ['warn',    'Vervallen'],
    credited:             ['neutral', 'Gecrediteerd'],
    partially_credited:   ['neutral', 'Deels gecrediteerd'],
    booked:               ['info',    'Geboekt'],
    draft:                ['neutral', 'Concept'],
  };
  const SUB_STATUS_TO_PILL = {
    active:    ['ok',      'Actief'],
    cancelled: ['neutral', 'Beëindigd'],
    paused:    ['warn',    'Gepauzeerd'],
  };

  // ── DASHBOARD ────────────────────────────────────────────────────────
  // Period-selector: Dag/Week/Maand/Kwartaal/Jaar (matcht endpoint waardes
  // today/week/month/quarter/year). Default = month (matcht finance.html).
  const PERIOD_LABEL_TO_PARAM = { Dag: 'today', Week: 'week', Maand: 'month', Kwartaal: 'quarter', Jaar: 'year' };
  async function fetchDashboard() {
    const label = F('fin-p', 'Maand');
    const period = PERIOD_LABEL_TO_PARAM[label] || 'month';
    if (_dash.loading && _dash.period === period) return;
    const seq = ++_dash.seq;
    _dash.loading = true; _dash.error = null; _dash.period = period;
    window.DFO.render();
    const data = await tryFetch('finance-dashboard-counts', `/api/finance-dashboard-counts?period=${period}`);
    if (seq !== _dash.seq) return;
    _dash.data = data; _dash.loading = false;
    if (!data) _dash.error = 'Kon dashboard-counts niet laden';
    window.DFO.render();
  }

  function dashboardView() {
    const label = F('fin-p', 'Maand');
    const wantedPeriod = PERIOD_LABEL_TO_PARAM[label] || 'month';
    if (!_dash.loading && (!_dash.data || _dash.period !== wantedPeriod)) queueMicrotask(fetchDashboard);
    const d = _dash.data || {};
    // Beschermde-zone-velden NIET renderen: actieveArrangements,
    // openVerifyPayment, openEscalations, joostStats, conversieWanbetalersFlow.
    return `${previewHeader('Dashboard', _dash)}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,  label: 'Totaal openstaand',    val: eur0(d.totaalOpenstaand),          hi: 1, sub: `${num(d.openFacturen)} open · ${num(d.overdueFacturen)} vervallen` },
        { c: 'blue',    icon: I.euro,  label: 'Bank-saldo',           val: eurC(d.bankBalans?.value),         hi: 1, sub: d.bankBalans?.accountCount ? `${d.bankBalans.accountCount} rekeningen` : '—' },
        { c: 'emerald', icon: I.trend, label: 'MRR (subscriptions)',  val: eur0(d.mrrSubscriptions),          hi: 1, sub: 'actieve abonnementen' },
        { c: 'violet',  icon: I.repeat,label: 'Cashflow verwacht 30d',val: eur0(d.cashflowVerwacht30d),              sub: 'op basis van looptijden' },
      ])}
      ${H.toolbar([
        H.chips('fin-p', [
          { l: 'Dag',      v: 'Dag' },
          { l: 'Week',     v: 'Week' },
          { l: 'Maand',    v: 'Maand' },
          { l: 'Kwartaal', v: 'Kwartaal' },
          { l: 'Jaar',     v: 'Jaar' },
        ], label),
      ])}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Kern-getallen</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Totaal openstaand</span><b>${eur0(d.totaalOpenstaand)}</b></div>
            <div class="sv-row"><span>Open facturen</span><b>${num(d.openFacturen)}</b></div>
            <div class="sv-row"><span>Vervallen facturen</span><b>${num(d.overdueFacturen)}</b></div>
            <div class="sv-row"><span>Cashflow verwacht 30d</span><b>${eur0(d.cashflowVerwacht30d)}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.euro)}Bank</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Actueel saldo</span><b>${eurC(d.bankBalans?.value)}</b></div>
            <div class="sv-row"><span>Aantal rekeningen</span><b>${num(d.bankBalans?.accountCount)}</b></div>
            <div class="sv-row"><span>Bijgewerkt</span><b>${d.bankBalans?.fetchedAt ? dstr(d.bankBalans.fetchedAt) : '—'}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.repeat)}Recurring</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>MRR (abonnementen)</span><b>${eur0(d.mrrSubscriptions)}</b></div>
            <div class="sv-row"><span>Mentor-bonus openstaand</span><b>${eur0(d.mentorBonusPending)}</b></div>
          </div>
        </div>
      </div>`;
  }

  // ── FACTUREN ─────────────────────────────────────────────────────────
  window.__finInvNew  = () => { window.location.href = '/modules/finance.html?tab=facturen&new=1'; };
  window.__finInvOpen = (tlId) => { if (tlId) window.location.href = '/modules/finance.html?tab=facturen&invoice=' + encodeURIComponent(tlId); };

  function invoicesParams() {
    const st = F('fin-inv-st', 'open');
    const q = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    if (q) p.set('q', q);
    p.set('page', '1'); p.set('page_size', '50');
    return p.toString();
  }
  async function fetchInvoices() {
    const wanted = invoicesParams();
    if (_inv.loading && _inv.params === wanted) return;
    const seq = ++_inv.seq;
    _inv.loading = true; _inv.error = null; _inv.params = wanted;
    window.DFO.render();
    const data = await tryFetch('finance-invoices', '/api/finance-invoices?' + wanted);
    if (seq !== _inv.seq) return;
    _inv.data = data; _inv.loading = false;
    if (!data) _inv.error = 'Kon facturen niet laden';
    window.DFO.render();
  }

  function invoicesView() {
    const st = F('fin-inv-st', 'open');
    if (!_inv.loading && (!_inv.data || _inv.params !== invoicesParams())) queueMicrotask(fetchInvoices);
    const items = _inv.data?.items || [];
    const k = _inv.data?.kpis || {};
    const total = _inv.data?.total ?? null;
    return `${previewHeader('Facturen', _inv)}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,  label: 'Openstaand (excl. gecrediteerd)', val: eur0(k.open_total),       hi: 1, sub: `${num(k.open_count)} facturen` },
        { c: 'warn',    icon: I.warn,  label: 'Vervallen',                       val: eur0(k.overdue_total),           sub: `${num(k.overdue_count)} facturen` },
        { c: 'emerald', icon: I.check, label: 'Betaald deze maand',              val: eur0(k.month_in_total),          sub: `${num(k.month_in_count)} betalingen` },
        { c: 'blue',    icon: I.clock, label: 'Gem. betaaltijd',                 val: k.avg_pay_days != null ? Math.round(k.avg_pay_days) + ' d' : '—', sub: 'laatste 90d' },
      ])}
      ${H.toolbar([
        H.chips('fin-inv-st', [
          { l: 'Alle',           v: 'all' },
          { l: 'Open',           v: 'open' },
          { l: 'Vervallen',      v: 'overdue' },
          { l: 'Betaald',        v: 'paid' },
          { l: 'Gecrediteerd',   v: 'credited' },
        ], st),
        H.search('Zoek factuur-nr / klant…'),
        `<div class="tb-right"><button class="btn btn-primary" onclick="__finInvNew()">${svg(I.plus)}Nieuwe factuur</button></div>`,
      ])}
      <div class="sv-total">${_inv.loading ? 'Laden…' : (total != null ? `${total} factuur${total === 1 ? '' : 'en'}` : '—')}</div>
      ${H.table(
        [{ l: 'Factuur-nr' }, { l: 'Klant' }, { l: 'Uitgifte', cls: 'r optional' }, { l: 'Vervaldatum', cls: 'r optional' }, { l: 'Totaal', cls: 'r' }, { l: 'Open', cls: 'r' }, { l: 'Status' }],
        items.map(v => {
          const [c, l] = INV_STATUS_TO_PILL[v.display_status] || INV_STATUS_TO_PILL[v.status] || ['neutral', v.display_status || v.status || '—'];
          return [
            `<a href="javascript:__finInvOpen('${v.tl_invoice_id || v.id}')" class="sv-off-nr">${v.invoice_number || ('#' + String(v.id || '').slice(0, 8))}</a>`,
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(v.customer_name || '?')}</div><span class="cell-main">${v.customer_name || '—'}</span></div>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.issue_date)}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.due_date)}</span>`,
            `<span class="mono">${eur(v.amount_total)}</span>`,
            `<span class="mono ${(v.amount_open || 0) > 0 ? 'strong' : ''}">${eur(v.amount_open)}</span>`,
            H.pill(c, l),
          ];
        })
      )}
      ${!items.length && !_inv.loading ? `<div class="sv-empty">${_inv.error || 'Geen facturen met deze filters.'}</div>` : ''}`;
  }

  // ── ABONNEMENTEN ─────────────────────────────────────────────────────
  function subsParams() {
    const st = F('fin-sub-st', 'active');
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    p.set('page', '1'); p.set('page_size', '100');
    return p.toString();
  }
  async function fetchSubs() {
    const wanted = subsParams();
    if (_sub.loading && _sub.params === wanted) return;
    const seq = ++_sub.seq;
    _sub.loading = true; _sub.error = null; _sub.params = wanted;
    window.DFO.render();
    const data = await tryFetch('sales-subscriptions-list', '/api/sales-subscriptions-list?' + wanted);
    if (seq !== _sub.seq) return;
    _sub.data = data; _sub.loading = false;
    if (!data) _sub.error = 'Kon abonnementen niet laden';
    window.DFO.render();
  }

  function subsView() {
    const st = F('fin-sub-st', 'active');
    if (!_sub.loading && (!_sub.data || _sub.params !== subsParams())) queueMicrotask(fetchSubs);
    const items = _sub.data?.items || [];
    const total = _sub.data?.total ?? null;
    const mrrSum = items.filter(s => (s.status || '') === 'active').reduce((a, s) => a + (Number(s.mrr) || 0), 0);
    return `${previewHeader('Abonnementen · via sales-subscriptions', _sub)}
      ${H.kpis([
        { c: 'emerald', icon: I.check,  label: 'Actief in view',  val: num(items.filter(s => s.status === 'active').length), hi: 1 },
        { c: 'violet',  icon: I.trend,  label: 'MRR (view · actieve)', val: eur0(mrrSum), hi: 1, sub: 'som van .mrr op actieve rijen' },
        { c: 'blue',    icon: I.repeat, label: 'Totaal in view',  val: num(items.length), sub: total != null ? `van ${num(total)} totaal` : '—' },
      ])}
      ${H.toolbar([
        H.chips('fin-sub-st', [
          { l: 'Alle',       v: 'all' },
          { l: 'Actief',     v: 'active' },
          { l: 'Gepauzeerd', v: 'paused' },
          { l: 'Beëindigd',  v: 'cancelled' },
        ], st),
      ])}
      <div class="sv-total">${_sub.loading ? 'Laden…' : (total != null ? `${total} abonnement${total === 1 ? '' : 'en'}` : '—')}</div>
      ${H.table(
        [{ l: 'Klant' }, { l: 'Beschrijving', cls: 'optional' }, { l: 'Entiteit', cls: 'optional' }, { l: 'Per termijn', cls: 'r' }, { l: 'MRR', cls: 'r' }, { l: 'Termijn', cls: 'optional' }, { l: 'Status' }],
        items.map(s => {
          const cName = s.customer?.name || s.customer_name || '—';
          const [c, l] = SUB_STATUS_TO_PILL[s.status] || ['neutral', s.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(cName)}</div><span class="cell-main">${cName}</span></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${s.description || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${s.entity || '—'}</span>`,
            `<span class="mono">${eur(s.per_term_incl)}</span>`,
            `<span class="mono">${eur0(s.mrr)}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${s.billing_cycle || '—'}</span>`,
            H.pill(c, l),
          ];
        })
      )}
      ${!items.length && !_sub.loading ? `<div class="sv-empty">${_sub.error || 'Geen abonnementen met deze filter.'}</div>` : ''}`;
  }

  // ── CREDITNOTA'S ─────────────────────────────────────────────────────
  function cnParams() {
    const q = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('page', '1'); p.set('page_size', '50');
    return p.toString();
  }
  async function fetchCn() {
    const wanted = cnParams();
    if (_cn.loading && _cn.params === wanted) return;
    const seq = ++_cn.seq;
    _cn.loading = true; _cn.error = null; _cn.params = wanted;
    window.DFO.render();
    const data = await tryFetch('finance-creditnotes-list', '/api/finance-creditnotes-list?' + wanted);
    if (seq !== _cn.seq) return;
    _cn.data = data; _cn.loading = false;
    if (!data) _cn.error = 'Kon creditnota\'s niet laden';
    window.DFO.render();
  }

  function cnView() {
    if (!_cn.loading && (!_cn.data || _cn.params !== cnParams())) queueMicrotask(fetchCn);
    const items = _cn.data?.items || [];
    const kpi = _cn.data?.kpi || {};
    const total = _cn.data?.total ?? null;
    return `${previewHeader("Creditnota's", _cn)}
      ${H.kpis([
        { c: 'violet',  icon: I.doc,   label: 'Aantal creditnota\'s', val: num(kpi.count),      hi: 1 },
        { c: 'orange',  icon: I.euro,  label: 'Som bedragen',         val: eur0(kpi.sum_amount), hi: 1 },
      ])}
      ${H.toolbar([
        H.search('Zoek creditnota-nr / klant…'),
      ])}
      <div class="sv-total">${_cn.loading ? 'Laden…' : (total != null ? `${total} creditnota${total === 1 ? '' : "'s"}` : '—')}</div>
      ${H.table(
        [{ l: 'Creditnota-nr' }, { l: 'Klant' }, { l: 'Bij factuur', cls: 'optional' }, { l: 'Datum', cls: 'r optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Status' }],
        items.map(cn => [
          `<span class="sv-off-nr">${cn.credit_note_number || ('#' + String(cn.id || '').slice(0, 8))}</span>`,
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(cn.customer_name || '?')}</div><span class="cell-main">${cn.customer_name || '—'}</span></div>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${cn.invoice_number || '—'}</span>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(cn.credit_note_date)}</span>`,
          `<span class="mono">${eur(cn.amount_total)}</span>`,
          H.pill('neutral', cn.status || '—'),
        ])
      )}
      ${!items.length && !_cn.loading ? `<div class="sv-empty">${_cn.error || 'Geen creditnota\'s in deze view.'}</div>` : ''}`;
  }

  // ── BANK ─────────────────────────────────────────────────────────────
  function bankParams() {
    const dir = F('fin-bank-dir', 'all');
    const q = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (dir && dir !== 'all') p.set('direction', dir);
    if (q) p.set('q', q);
    p.set('limit', '100'); p.set('offset', '0');
    return p.toString();
  }
  async function fetchBank() {
    const wanted = bankParams();
    if (_bnk.loading && _bnk.params === wanted) return;
    const seq = ++_bnk.seq;
    _bnk.loading = true; _bnk.error = null; _bnk.params = wanted;
    window.DFO.render();
    const [bal, tx] = await Promise.all([
      tryFetch('finance-bank-camt-balance',      '/api/finance-bank-camt-balance'),
      tryFetch('finance-bank-camt-transactions', '/api/finance-bank-camt-transactions?' + wanted),
    ]);
    if (seq !== _bnk.seq) return;
    _bnk.bal = bal; _bnk.tx = tx; _bnk.loading = false;
    if (!bal && !tx) _bnk.error = 'Kon bank-data niet laden';
    window.DFO.render();
  }

  function bankView() {
    const dir = F('fin-bank-dir', 'all');
    if (!_bnk.loading && (!_bnk.tx || _bnk.params !== bankParams())) queueMicrotask(fetchBank);
    const items = _bnk.tx?.items || [];
    const bal = _bnk.bal || {};
    const kpis = _bnk.tx?.kpis || {};
    return `${previewHeader('Bank · CAMT-import', _bnk)}
      ${H.kpis([
        { c: 'blue',    icon: I.euro,  label: 'Actueel saldo',       val: eurC(bal.balance_cents),         hi: 1, sub: bal.as_of_date ? `t/m ${dstr(bal.as_of_date)}` : '—' },
        { c: 'emerald', icon: I.trend, label: 'Inkomend (view)',     val: eurC(kpis.sum_in_cents),                sub: `${num(kpis.count_in)} transacties` },
        { c: 'orange',  icon: I.warn,  label: 'Uitgaand (view)',     val: eurC(kpis.sum_out_cents),               sub: `${num(kpis.count_out)} transacties` },
      ])}
      ${H.toolbar([
        H.chips('fin-bank-dir', [
          { l: 'Alle',      v: 'all' },
          { l: 'Inkomend',  v: 'in' },
          { l: 'Uitgaand',  v: 'out' },
        ], dir),
        H.search('Zoek omschrijving / tegenpartij…'),
      ])}
      ${H.table(
        [{ l: 'Boekdatum', cls: 'r' }, { l: 'Tegenpartij' }, { l: 'Omschrijving', cls: 'optional' }, { l: 'IBAN', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }],
        items.map(t => [
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(t.booking_date)}</span>`,
          `<span class="cell-main">${t.counterparty_name || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${t.description || '—'}</span>`,
          `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${t.counterparty_iban || '—'}</span>`,
          `<span class="mono ${(t.amount_cents || 0) > 0 ? 'strong' : ''}" style="color:${(t.amount_cents || 0) > 0 ? 'var(--brand)' : 'var(--warn,var(--orange))'}">${eurC(t.amount_cents)}</span>`,
        ])
      )}
      ${!items.length && !_bnk.loading ? `<div class="sv-empty">${_bnk.error || 'Geen transacties met deze filter.'}</div>` : ''}`;
  }

  // ── OMZET & MRR ──────────────────────────────────────────────────────
  // Gebruikt super-admin-omzet (bron van dashboard.html omzet-KPI's).
  // Default periode = huidige maand (matcht dashboard.html default).
  function mrrParams() {
    const label = F('fin-mrr-p', 'Maand');
    let from, to, gb;
    const now = new Date();
    to = todayIso();
    if (label === 'Week')     { const f = new Date(now); f.setDate(f.getDate() - 6);  from = isoDay(f); gb = 'day'; }
    else if (label === 'Kwartaal') { const q = Math.floor(now.getMonth() / 3) * 3; from = isoDay(new Date(now.getFullYear(), q, 1)); gb = 'week'; }
    else if (label === 'Jaar')     { from = isoDay(new Date(now.getFullYear(), 0, 1)); gb = 'month'; }
    else                          { from = monthStart(); gb = 'day'; }
    return `from=${from}&to=${to}&group_by=${gb}`;
  }
  async function fetchMrr() {
    const wanted = mrrParams();
    if (_mrr.loading && _mrr.params === wanted) return;
    const seq = ++_mrr.seq;
    _mrr.loading = true; _mrr.error = null; _mrr.params = wanted;
    window.DFO.render();
    const data = await tryFetch('super-admin-omzet', '/api/super-admin-omzet?' + wanted);
    if (seq !== _mrr.seq) return;
    _mrr.data = data; _mrr.loading = false;
    if (!data) _mrr.error = 'Kon omzet-rapport niet laden';
    window.DFO.render();
  }

  function mrrView() {
    const label = F('fin-mrr-p', 'Maand');
    if (!_mrr.loading && (!_mrr.data || _mrr.params !== mrrParams())) queueMicrotask(fetchMrr);
    const k = _mrr.data?.kpis || {};
    const trend = Array.isArray(_mrr.data?.trend) ? _mrr.data.trend : [];
    const perProduct = Array.isArray(_mrr.data?.per_product) ? _mrr.data.per_product : [];
    const trendMax = Math.max(1, ...trend.map(t => Number(t.totaal_incl_btw ?? t.total ?? t.revenue) || 0));
    return `${previewHeader('Omzet & MRR · via super-admin-omzet', _mrr)}
      ${H.kpis([
        { c: 'emerald', icon: I.euro,   label: 'Losse verkopen (incl. BTW)', val: eur0(k.los_incl_btw),      hi: 1 },
        { c: 'violet',  icon: I.repeat, label: 'Abo MRR (incl. BTW)',        val: eur0(k.abo_mrr_incl_btw),  hi: 1 },
        { c: 'blue',    icon: I.trend,  label: 'Totaal periode (incl. BTW)', val: eur0(k.totaal_incl_btw),   hi: 1 },
        { c: 'orange',  icon: I.doc,    label: 'Aantal deals',               val: num(k.deal_count) },
      ])}
      ${H.toolbar([
        H.chips('fin-mrr-p', [
          { l: 'Week',     v: 'Week' },
          { l: 'Maand',    v: 'Maand' },
          { l: 'Kwartaal', v: 'Kwartaal' },
          { l: 'Jaar',     v: 'Jaar' },
        ], label),
      ])}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Per product</div>
          <div class="sv-card-body">
            ${perProduct.length ? perProduct.slice(0, 8).map(p => `
              <div class="sv-row"><span>${p.product_name || p.product || p.name || '—'} <span class="sv-row-sub">${num(p.count)}×</span></span><b>${eur0(p.totaal_incl_btw ?? p.total ?? p.revenue)}</b></div>
            `).join('') : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen per-product data.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.trend)}Omzet-trend · incl. BTW</div>
          <div class="sv-card-body">
            ${trend.length ? `<div class="sv-trend">${trend.map(t => {
              const rev = Number(t.totaal_incl_btw ?? t.total ?? t.revenue) || 0;
              const h = Math.max(3, Math.round(rev / trendMax * 100));
              return `<div class="sv-trend-col" title="${t.period || t.label || t.date || ''} · ${eur0(rev)}">
                <div class="sv-trend-bar" style="height:${h}%"></div>
                <div class="sv-trend-lbl">${t.period || t.label || (t.date ? String(t.date).slice(5, 10) : '')}</div>
              </div>`;
            }).join('')}</div>` : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen trend-data.'}</div>`}
          </div>
        </div>
      </div>`;
  }

  window.DFO.VIEWS['finance/Dashboard']    = dashboardView;
  window.DFO.VIEWS['finance/Facturen']     = invoicesView;
  window.DFO.VIEWS['finance/Abonnementen'] = subsView;
  window.DFO.VIEWS["finance/Creditnota's"] = cnView;
  window.DFO.VIEWS['finance/Bank']         = bankView;
  window.DFO.VIEWS['finance/Omzet & MRR']  = mrrView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('finance');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('finance');
  console.debug('[finance-v2] registered 6 views (data-round · live endpoints)');
})();
