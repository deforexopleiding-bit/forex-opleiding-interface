// modules/klanten-v2/views/mentoren-v2.js
//
// Admin-tegenhanger van de per-mentor Verdiensten-module. Voor rollen
// admin/manager. Dormant tot allowlist — QA via ?v2preview=mentoren.
//
// DATA-KOPPELING 2026-08-13. Endpoints (allen admin-scope):
//   GET /api/mentor-admin-list                        (lijst mentoren)
//   GET /api/mentor-ledger-overview                    (grootboek per event/mentor)
//   GET /api/mentor-payouts-admin-list?period_month=  (uitbetaling-rapporten)
//   GET /api/mentor-payout-settings-get?mentor_user_id (config + recurring posten)
//   GET /api/funded-certs-admin-list                   (student-funded-certs)
//   GET /api/assessments-admin-list                    (beoordelingen)
//   GET /api/student-signals-list?status=              (signalen)
//
// Uitbetalingen sub-tabs: Rapporten (live) · Declaraties (needs-Jeffrey —
// geen admin-endpoint voor travel-declarations) · Handmatige posten (via
// payout-settings.recurring, read-only) · Tarieven (needs-Jeffrey — geen
// per-mentor tarieven-endpoint dat 1on1/team/km/event-bonus%/btw dekt).

(function () {
  if (!window.DFO) { console.error('[mentoren-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[mentoren-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur0 } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── Live-state per data-blok ──────────────────────────────────────────
  const _live = {
    mentors:      { loading: false, error: null, data: null },
    ledger:       { loading: false, error: null, data: null },
    payouts:      { loading: false, error: null, data: null, month: _currentYm() },
    settings:     new Map(),   // mentor_user_id → {loading, error, data}
    certs:        { loading: false, error: null, data: null },
    assessments:  { loading: false, error: null, data: null, month: _currentYm() },
    signals:      { loading: false, error: null, data: null, status: 'open' },
  };

  function _currentYm() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[mentoren-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  async function fetchMentors() {
    const st = _live.mentors; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('mentors', '/api/mentor-admin-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.mentors);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLedger() {
    const st = _live.ledger; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('ledger', '/api/mentor-ledger-overview');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { totals: j?.totals || {}, byStatus: j?.byStatus || {}, byEvent: asArr(j?.byEvent), byMentor: asArr(j?.byMentor) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchPayouts(ym) {
    ym = ym || _live.payouts.month;
    const st = _live.payouts;
    if (st.loading || (st.data && st.month === ym)) return;
    st.loading = true; st.error = null; st.month = ym; st.data = null;
    const j = await tryFetch('payouts:' + ym, '/api/mentor-payouts-admin-list?period_month=' + encodeURIComponent(ym));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { period_month: j?.period_month || ym, payouts: asArr(j?.payouts) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSettings(mentorUserId) {
    if (!mentorUserId) return;
    let entry = _live.settings.get(mentorUserId);
    if (entry && (entry.loading || entry.data)) return;
    entry = { loading: true, error: null, data: null };
    _live.settings.set(mentorUserId, entry);
    const j = await tryFetch('settings:' + mentorUserId, '/api/mentor-payout-settings-get?mentor_user_id=' + encodeURIComponent(mentorUserId));
    entry.loading = false;
    if (j && j.__error) entry.error = j.__error; else entry.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchCerts() {
    const st = _live.certs; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('certs', '/api/funded-certs-admin-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.certs);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchAssessments(ym) {
    ym = ym || _live.assessments.month;
    const st = _live.assessments;
    if (st.loading || (st.data && st.month === ym)) return;
    st.loading = true; st.error = null; st.month = ym; st.data = null;
    const j = await tryFetch('assess:' + ym, '/api/assessments-admin-list?month=' + encodeURIComponent(ym));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.rows);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSignals(status) {
    status = status || _live.signals.status;
    const st = _live.signals;
    if (st.loading || (st.data && st.status === status)) return;
    st.loading = true; st.error = null; st.status = status; st.data = null;
    const j = await tryFetch('signals:' + status, '/api/student-signals-list?status=' + encodeURIComponent(status));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.signals);
    if (window.DFO?.render) window.DFO.render();
  }

  // Retry handlers
  window.__mentRetry = (block) => {
    if (block === 'mentors')     { _live.mentors.data = null; _live.mentors.error = null; fetchMentors(); }
    if (block === 'ledger')      { _live.ledger.data = null; _live.ledger.error = null; fetchLedger(); }
    if (block === 'payouts')     { _live.payouts.data = null; _live.payouts.error = null; fetchPayouts(); }
    if (block === 'certs')       { _live.certs.data = null; _live.certs.error = null; fetchCerts(); }
    if (block === 'assessments') { _live.assessments.data = null; _live.assessments.error = null; fetchAssessments(); }
    if (block === 'signals')     { _live.signals.data = null; _live.signals.error = null; fetchSignals(); }
    if (window.DFO?.render) window.DFO.render();
  };

  // Sub-tab state (Uitbetalingen) — client-side.
  let uSub = 'Rapporten';
  window.__mentSetUSub = (t) => { uSub = t; if (window.DFO?.render) window.DFO.render(); };
  window.__mentSetPayoutMonth = (ym) => { fetchPayouts(ym); };
  window.__mentSetAssessMonth = (ym) => { fetchAssessments(ym); };
  window.__mentSetSignalStatus = (s) => { fetchSignals(s); };

  // ── UI-helpers ────────────────────────────────────────────────────────
  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon gegevens niet ophalen: ${esc(msg || 'onbekende fout')}</span>
    <button class="btn btn-ghost btn-sm" onclick="__mentRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55">
    <div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div>
    <div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const emptyBlk = (title, sub) => `<div class="empty" style="padding:44px 20px"><div class="empty-t">${esc(title)}</div><div class="empty-s">${esc(sub || '')}</div></div>`;
  const needsJeffrey = (reason) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}</span>
    <span><b>Needs Jeffrey</b> — ${esc(reason)}</span></div>`;
  function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function _ymLabel(ym) {
    if (!ym) return '—';
    const [y, m] = String(ym).split('-').map(Number);
    const M = ['Jan','Feb','Mrt','Apr','Mei','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
    return (M[m - 1] || m) + ' ' + y;
  }

  // ── VIEW 1: Overzicht ─────────────────────────────────────────────────
  function overzichtView() {
    if (!_live.mentors.data && !_live.mentors.loading && !_live.mentors.error) queueMicrotask(fetchMentors);
    if (!_live.ledger.data && !_live.ledger.loading && !_live.ledger.error) queueMicrotask(fetchLedger);
    if (_live.mentors.error && !_live.mentors.data) return errBlk('mentors', _live.mentors.error);
    if (_live.mentors.loading && !_live.mentors.data) return skel();
    const mentors = asArr(_live.mentors.data);
    const ledger = _live.ledger.data || {};
    const byMentor = asArr(ledger.byMentor);
    const bySeed = new Map();
    for (const b of byMentor) if (b?.mentor_user_id) bySeed.set(b.mentor_user_id, b);
    const q = (F('q', '') || '').toLowerCase();
    const rows = mentors.filter((m) => !q || String(m.name || '').toLowerCase().includes(q) || String(m.email || '').toLowerCase().includes(q));
    S.rows = rows;
    const totalSaldo = byMentor.reduce((a, b) => a + Number(b?.saldo || 0), 0);
    return `${H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Mentoren',           val: String(mentors.length), sub: 'in beheer' },
      { c: 'emerald', icon: I.euro,  label: 'Bonus-saldo (open)', val: eur0(totalSaldo), hi: 1, sub: 'som byMentor' },
      { c: 'blue',    icon: I.euro,  label: 'Omzet events',       val: eur0(Number(ledger.totals?.omzet || 0)), sub: 'grootboek totaal' },
      { c: 'amber',   icon: I.box,   label: 'Uitgaven events',    val: eur0(Number(ledger.totals?.uitgaven || 0)), hi: 1, sub: 'declaraties + kosten' },
    ])}
    ${_live.ledger.error ? errBlk('ledger', _live.ledger.error) : ''}
    ${H.toolbar([H.search('Zoek mentor…')])}
    ${rows.length === 0
      ? emptyBlk('Geen mentoren', mentors.length === 0 ? 'Kantoor koppelt mentoren via de admin-view.' : 'Geen mentoren voldoen aan de zoekopdracht.')
      : H.table(
          [{ l: 'Mentor' }, { l: 'E-mail', cls: 'optional' }, { l: 'Rol', cls: 'optional' }, { l: 'Bonus-saldo', cls: 'r' }, { l: '', cls: 'r' }],
          rows.map((m) => {
            const seed = bySeed.get(m.user_id);
            const saldo = Number(seed?.saldo || 0);
            return [
              `<div class="row-avatar">${H.av(m.name || '—', 30)}<div><div class="cell-main">${esc(m.name || '—')}</div></div></div>`,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(m.email || '—')}</span>`,
              `<span style="color:var(--text-2);font-size:12px">${esc(m.role || '—')}</span>`,
              `<span class="money" style="color:var(--${saldo > 0 ? 'emerald' : 'text-3'})">${eur0(saldo)}</span>`,
              `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('/modules/mentoren-beheer.html', '_blank')">Openen in v1</button>`,
            ];
          })
        )}`;
  }

  // ── VIEW 2: Grootboek ─────────────────────────────────────────────────
  function grootboekView() {
    if (!_live.ledger.data && !_live.ledger.loading && !_live.ledger.error) queueMicrotask(fetchLedger);
    if (_live.ledger.error && !_live.ledger.data) return errBlk('ledger', _live.ledger.error);
    if (_live.ledger.loading && !_live.ledger.data) return skel();
    const d = _live.ledger.data || {};
    const t = d.totals || {};
    const byEvent = asArr(d.byEvent);
    const byMentor = asArr(d.byMentor);
    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Omzet events',  val: eur0(Number(t.omzet || 0)), sub: 'totaal grootboek' },
      { c: 'violet',  icon: I.grad,  label: 'Bonuspot',      val: eur0(Number(t.bonuspot || 0)), hi: 1 },
      { c: 'amber',   icon: I.box,   label: 'Uitgaven',      val: eur0(Number(t.uitgaven || 0)), hi: 1 },
      { c: 'emerald', icon: I.tick,  label: 'Netto',         val: eur0(Number(t.netto || 0)), hi: 1 },
    ])}
    <div class="pad">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span>
          <div class="card-title">Per event (${byEvent.length})</div></div>
        ${byEvent.length === 0
          ? emptyBlk('Geen event-data', 'Nog geen omzet/uitgaven per event.')
          : H.table(
              [{ l: 'Event' }, { l: 'Datum', cls: 'optional' }, { l: 'Omzet', cls: 'r' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitgaven', cls: 'r' }, { l: 'Netto', cls: 'r' }],
              byEvent.map((e) => [
                `<span class="cell-main">${esc(e.event_title || e.title || '—')}</span>`,
                `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.starts_at || e.date))}</span>`,
                `<span class="money">${eur0(Number(e.omzet || 0))}</span>`,
                `<span class="money">${eur0(Number(e.bonus || 0))}</span>`,
                `<span class="money">− ${eur0(Number(e.uitgaven || 0))}</span>`,
                `<span class="money" style="color:var(--emerald)">${eur0(Number(e.netto || (Number(e.omzet||0) - Number(e.bonus||0) - Number(e.uitgaven||0))))}</span>`,
              ])
            )}
      </div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.users)}</span>
          <div class="card-title">Per mentor (${byMentor.length})</div></div>
        ${byMentor.length === 0
          ? emptyBlk('Geen mentor-saldi', 'Nog geen bonus-toewijzingen.')
          : H.table(
              [{ l: 'Mentor' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitbetaald', cls: 'r' }, { l: 'Saldo', cls: 'r' }],
              byMentor.map((m) => [
                `<div class="row-avatar">${H.av(m.mentor_name || '—', 28)}<span class="cell-main">${esc(m.mentor_name || '—')}</span></div>`,
                `<span class="money">${eur0(Number(m.bonus || 0))}</span>`,
                `<span class="money">${eur0(Number(m.uitbetaald || 0))}</span>`,
                `<span class="money" style="color:var(--${Number(m.saldo||0) > 0 ? 'emerald' : 'text-3'})">${eur0(Number(m.saldo || 0))}</span>`,
              ])
            )}
      </div>
    </div>`;
  }

  // ── VIEW 3: Uitbetalingen (sub-tabs) ──────────────────────────────────
  function uitbetalingenView() {
    const subs = ['Rapporten', 'Declaraties', 'Handmatige posten', 'Tarieven'];
    const tabs = `<div class="toolbar" style="padding-bottom:0;border-bottom:none">
      ${subs.map(t => `<button class="chip ${uSub === t ? 'on' : ''}" onclick="__mentSetUSub('${t}')">${t}</button>`).join('')}</div>`;
    if (uSub === 'Rapporten') return tabs + _payoutsSubView();
    if (uSub === 'Declaraties') return tabs + needsJeffrey('Geen admin-endpoint voor reis-declaraties. /api/mentor-travel-days-self is self-scope. Uitbreiden met ?mentor_user_id= of nieuwe admin-variant.');
    if (uSub === 'Handmatige posten') return tabs + _recurringSubView();
    if (uSub === 'Tarieven') return tabs + needsJeffrey('Endpoint /api/mentor-payout-config-set dekt alleen travel_enabled + day_rate. Voor 1on1/team/km/event-bonus%/btw-flag per mentor is een nieuwe tarieven-tabel + endpoint nodig.');
    return tabs;
  }
  function _payoutsSubView() {
    const ym = _live.payouts.month || _currentYm();
    if (!_live.payouts.data && !_live.payouts.loading && !_live.payouts.error) queueMicrotask(() => fetchPayouts(ym));
    if (_live.payouts.error && !_live.payouts.data) return errBlk('payouts', _live.payouts.error);
    if (_live.payouts.loading && !_live.payouts.data) return skel();
    const payouts = asArr(_live.payouts.data?.payouts);
    const som = payouts.reduce((a, p) => a + Number(p.total || 0), 0);
    const uitbetaald = payouts.filter((p) => p.status === 'uitbetaald').length;
    const goedgekeurd = payouts.filter((p) => p.status === 'goedgekeurd').length;
    const concept = payouts.filter((p) => p.status === 'concept').length;
    return `${H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Bonus totaal',   val: eur0(payouts.reduce((a, p) => a + Number(p.bonus_total || 0), 0)) },
      { c: 'emerald', icon: I.users, label: 'Coaching totaal', val: eur0(payouts.reduce((a, p) => a + Number(p.coaching_total || 0), 0)), hi: 1 },
      { c: 'amber',   icon: I.euro,  label: 'Totaal',         val: eur0(som), hi: 1, sub: payouts.length + ' rapporten' },
      { c: 'rose',    icon: I.alert, label: 'Concept · Goedgekeurd · Uitbetaald', val: concept + ' · ' + goedgekeurd + ' · ' + uitbetaald, hi: 1 },
    ])}
    <div class="toolbar">
      <input class="filter-sel" type="month" value="${esc(ym)}" onchange="__mentSetPayoutMonth(this.value)">
      <div class="tb-right"><button class="btn btn-ghost" onclick="__mentRetry('payouts')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>
    </div>
    ${payouts.length === 0
      ? emptyBlk('Geen rapporten voor ' + _ymLabel(ym), 'Genereer eerst via de admin-flow (v1: Mentoren-beheer → Uitbetalingen).')
      : H.table(
          [{ l: 'Mentor' }, { l: 'Bonus', cls: 'r' }, { l: 'Coaching', cls: 'r' }, { l: 'Totaal', cls: 'r' }, { l: 'BTW', cls: 'r optional' }, { l: 'Status' }, { l: 'Uitbetaald op', cls: 'optional' }],
          payouts.map((p) => [
            `<div class="row-avatar">${H.av(p.mentor_name || '—', 28)}<div><div class="cell-main">${esc(p.mentor_name || '—')}</div><div class="cell-sub">${esc(p.mentor_email || '')}</div></div></div>`,
            `<span class="money">${eur0(Number(p.bonus_total || 0))}</span>`,
            `<span class="money">${eur0(Number(p.coaching_total || 0))}</span>`,
            `<span class="money"><b>${eur0(Number(p.total || 0))}</b></span>`,
            `<span class="money">${eur0(Number(p.btw_amount || 0))}</span>`,
            H.pill(p.status === 'uitbetaald' ? 'ok' : p.status === 'goedgekeurd' ? 'warn' : 'neutral', p.status || '—'),
            `<span style="color:var(--text-3)">${p.paid_at ? esc(_fmtDate(p.paid_at)) : '—'}</span>`,
          ])
        )}`;
  }
  function _recurringSubView() {
    const mentors = asArr(_live.mentors.data);
    if (!_live.mentors.data && !_live.mentors.loading) queueMicrotask(fetchMentors);
    if (_live.mentors.loading && !_live.mentors.data) return skel();
    if (!mentors.length) return emptyBlk('Geen mentoren geladen', 'Ga eerst naar tab Overzicht.');
    return `<div style="padding:16px 22px;font-size:12.5px;color:var(--text-2);line-height:1.6">
      <b>Handmatige (terugkerende) posten per mentor.</b> Vaste maandelijkse bijtellingen of inhoudingen die op elke payout landen. Read-only in v2 — bewerken via v1 mentor-detail. Klik een mentor voor de posten.
    </div>
    ${H.table(
      [{ l: 'Mentor' }, { l: 'Posten', cls: 'r' }, { l: '', cls: 'r' }],
      mentors.map((m) => {
        const entry = _live.settings.get(m.user_id);
        const recurring = asArr(entry?.data?.recurring);
        return [
          `<div class="row-avatar">${H.av(m.name || '—', 28)}<span class="cell-main">${esc(m.name || '—')}</span></div>`,
          entry?.loading ? '<span style="color:var(--text-3);font-size:11.5px">Laden…</span>'
            : entry?.error ? `<span style="color:var(--rose);font-size:11.5px">${esc(entry.error)}</span>`
            : entry?.data ? `<span class="mono">${recurring.length}</span>`
            : `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.__mentLoadSettings('${esc(m.user_id)}')">Laden</button>`,
          `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('/modules/mentor-detail.html?user_id=' + encodeURIComponent('${esc(m.user_id)}'), '_blank')">Openen in v1</button>`,
        ];
      })
    )}`;
  }
  window.__mentLoadSettings = (userId) => { fetchSettings(userId); };

  // ── VIEW 4: Beoordelingen ─────────────────────────────────────────────
  function beoordelingenView() {
    const ym = _live.assessments.month || _currentYm();
    if (!_live.assessments.data && !_live.assessments.loading && !_live.assessments.error) queueMicrotask(() => fetchAssessments(ym));
    if (_live.assessments.error && !_live.assessments.data) return errBlk('assessments', _live.assessments.error);
    if (_live.assessments.loading && !_live.assessments.data) return skel();
    const rows = asArr(_live.assessments.data);
    return `${H.toolbar([
      `<input class="filter-sel" type="month" value="${esc(ym)}" onchange="__mentSetAssessMonth(this.value)">`,
      H.search('Zoek leerling…'),
    ])}
    ${rows.length === 0
      ? emptyBlk('Geen beoordelingen voor ' + _ymLabel(ym), 'Mentoren beoordelen studenten via v1 (Mentor-portal → Studenten).')
      : H.table(
          [{ l: 'Leerling' }, { l: 'Mentor', cls: 'optional' }, { l: 'Maand', cls: 'optional' }, { l: 'Status' }, { l: 'Cijfer', cls: 'r' }, { l: 'Notitie', cls: 'optional' }, { l: 'Bijgewerkt', cls: 'r optional' }],
          rows.map((r) => [
            `<div class="row-avatar">${H.av(r.student_name || '—', 28)}<span class="cell-main">${esc(r.student_name || '—')}</span></div>`,
            `<span style="color:var(--text-2);font-size:12.5px">${esc(r.mentor_name || '—')}</span>`,
            `<span style="color:var(--text-3);font-size:12.5px">${esc(_ymLabel(r.period_month))}</span>`,
            H.pill(r.status === 'op_schema' ? 'ok' : r.status === 'aandacht' ? 'warn' : r.status === 'risico' ? 'danger' : 'neutral', String(r.status || '—').replace('_', ' ')),
            `<span class="mono">${r.score != null ? r.score : '—'}</span>`,
            `<span style="color:var(--text-3);font-size:12.5px">${esc(r.note || '')}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(r.updated_at))}</span>`,
          ])
        )}`;
  }

  // ── VIEW 5: Certificaten (funded certs) ───────────────────────────────
  function certificatenView() {
    if (!_live.certs.data && !_live.certs.loading && !_live.certs.error) queueMicrotask(fetchCerts);
    if (_live.certs.error && !_live.certs.data) return errBlk('certs', _live.certs.error);
    if (_live.certs.loading && !_live.certs.data) return skel();
    const rows = asArr(_live.certs.data);
    return `${needsJeffrey('Endpoint /api/funded-certs-admin-list levert STUDENT-funded-certs (bonus per student-cert). Mentor-EIGEN trainings-certs uit prototype (uitgever/bonus/status) bestaan nog niet als endpoint.')}
    ${H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Certificaten totaal', val: String(rows.length), sub: 'funded-certs' },
      { c: 'emerald', icon: I.euro,  label: 'Uitgekeerde bonus',   val: eur0(rows.length * 100), sub: rows.length + ' × € 100' },
    ])}
    ${rows.length === 0
      ? emptyBlk('Geen funded-certs', 'Zodra mentoren een student-certificaat uploaden verschijnt het hier.')
      : H.table(
          [{ l: 'Mentor' }, { l: 'Student' }, { l: 'Maand', cls: 'optional' }, { l: 'Bestand', cls: 'optional' }, { l: 'Geüpload', cls: 'r optional' }, { l: '', cls: 'r' }],
          rows.map((c) => [
            `<div class="row-avatar">${H.av(c.mentor_name || '—', 26)}<span class="cell-main">${esc(c.mentor_name || '—')}</span></div>`,
            `<span style="font-size:12.5px">${esc(c.student_name || '—')}</span>`,
            `<span style="color:var(--text-3);font-size:12px">${esc(_ymLabel(c.funded_month))}</span>`,
            `<span style="color:var(--text-3);font-size:11.5px">${esc(c.file_name || '—')}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(c.last_uploaded_at))}</span>`,
            c.download_url ? `<a class="btn btn-ghost btn-sm" href="${esc(c.download_url)}" target="_blank" onclick="event.stopPropagation()">${svg(I.down)}Download</a>` : '<span style="color:var(--text-3);font-size:11.5px">—</span>',
          ])
        )}`;
  }

  // ── VIEW 6: Signalen ──────────────────────────────────────────────────
  function signalenView() {
    const status = _live.signals.status || 'open';
    if (!_live.signals.data && !_live.signals.loading && !_live.signals.error) queueMicrotask(() => fetchSignals(status));
    if (_live.signals.error && !_live.signals.data) return errBlk('signals', _live.signals.error);
    if (_live.signals.loading && !_live.signals.data) return skel();
    const rows = asArr(_live.signals.data);
    return `${H.toolbar([
      `<select class="filter-sel" onchange="__mentSetSignalStatus(this.value)">
        <option value="open"       ${status === 'open' ? 'selected' : ''}>Open</option>
        <option value="handled"    ${status === 'handled' ? 'selected' : ''}>Afgehandeld</option>
        <option value="all"        ${status === 'all' ? 'selected' : ''}>Alles</option>
      </select>`,
    ])}
    ${rows.length === 0
      ? emptyBlk('Geen signalen', 'Voor status "' + esc(status) + '" zijn er geen signalen.')
      : H.table(
          [{ l: 'Leerling' }, { l: 'Signaal' }, { l: 'Mentor', cls: 'optional' }, { l: 'Toelichting', cls: 'optional' }, { l: 'Aangemaakt', cls: 'r optional' }],
          rows.map((s) => [
            `<div class="row-avatar">${H.av(s.student_name || '—', 28)}<span class="cell-main">${esc(s.student_name || '—')}</span></div>`,
            H.pill(s.type === 'no_show' ? 'danger' : 'warn', String(s.type || '—').replace('_', ' ')),
            `<span style="font-size:12.5px">${esc(s.mentor_name || '—')}</span>`,
            `<span style="color:var(--text-3);font-size:12.5px">${esc(s.toelichting || '')}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(s.created_at))}</span>`,
          ])
        )}`;
  }

  // ── Registratie ───────────────────────────────────────────────────────
  window.DFO.VIEWS['mentoren/Overzicht']     = overzichtView;
  window.DFO.VIEWS['mentoren/Grootboek']     = grootboekView;
  window.DFO.VIEWS['mentoren/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['mentoren/Beoordelingen'] = beoordelingenView;
  window.DFO.VIEWS['mentoren/Certificaten']  = certificatenView;
  window.DFO.VIEWS['mentoren/Signalen']      = signalenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('mentoren');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('mentoren');

  console.debug('[mentoren-v2] data-ronde geregistreerd — dormant tot allowlist of ?v2preview=mentoren');
})();
