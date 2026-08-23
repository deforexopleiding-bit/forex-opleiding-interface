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
  // v=17 BLOCKER-fix: sales-v2 gebruikt esc() in svStatusIcon + error-branches
  // maar had geen esc-import. Klanten-v2.js exposet 'em via window.KV.esc;
  // fallback op inline-implementatie voor het edge-case dat KV nog niet klaar is.
  // Zonder deze bind: ReferenceError bij eerste rij-render → geen zichtbare
  // error in DFO.render()-wrapper → lijst leeg (was root-cause van v=16 blocker).
  const esc = (window.KV && window.KV.esc)
    || ((v) => v == null ? '' : String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

  // ── State per tab (los zodat cross-tab-fetches niet elkaars data raken) ──
  // Dashboard-state: houdt ook company-scope-slices bij (report + accepted-deals)
  // die alleen fetch't worden voor super_admin/manager. Rol-check gebeurt bij
  // elke fetchDashboard — bij rol-wissel triggert de shell een re-render en de
  // fetcher merkt het via de `boot`-hook (params-verandering equivalent).
  const _dash = { loading: false, error: null, stats: null, metrics: null, pending: null, companyReport: null, companyAccepted: null, seq: 0, boot: false, bootRole: '' };
  const _off  = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _ret  = { loading: false, error: null, data: null, seq: 0, params: '' };
  // Reports: naast sales-reports slaan we ook accepted-deals van dezelfde
  // periode op. Alle omzet-KPI's (main + per-verkoper) worden client-side
  // uit sales-quotations gesommeerd via total_amount_incl (leidende definitie
  // van de gebruiker: OMZET = getekende offertes INCL. BTW).
  const _rep  = { loading: false, error: null, data: null, accepted: null, seq: 0, params: '', customFrom: '', customTo: '' };

  // Rol-detectie: super_admin/manager/admin → company-view. Anders (sales/
  // mentor/marketing/administratie) → mijn-view. Prefer admin bij overlap.
  const isAdminRole = () => {
    const r = (window.DFO && window.DFO.S && window.DFO.S.roles) || [];
    return r.includes('super_admin') || r.includes('manager') || r.includes('admin');
  };

  // Date-helpers voor periode-fetches (start-of-month + range voor prestaties).
  const isoDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
  const monthStart = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };
  const todayIso   = () => isoDay(new Date());

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

  // Preview-mode badge — VERWIJDERD (per user-verzoek 2026-08-11).
  // Signature/return-shape behouden als lege string zodat alle 5 call-sites
  // in dit bestand (Dashboard/Offertes/Offerte-detail/Retentie/
  // Verkoopprestaties) blijven werken zonder aanpassing. Error-/loading-
  // state is elders zichtbaar (per-tab "Laden…" placeholders + toast).
  function previewHeader(_label, _extra) { return ''; }

  const OST_TO_PILL = {
    draft:     ['neutral', 'Concept'],
    sent:      ['info',    'Verzonden'],
    accepted:  ['ok',      'Geaccepteerd'],
    declined:  ['warn',    'Afgewezen'],
    cancelled: ['neutral', 'Geannuleerd'],
  };

  // Client-side status-afleiding (v=... pre-flip fix 1). Bron: dezelfde
  // signalen die het dashboard gebruikt (accepted_at/declined_at/sent_at).
  // Vangnet voor rijen waar tl_quotation_status leeg of afwijkend is —
  // voorheen viel de lijst dan leeg omdat de server-filter geen match had.
  // Prioriteit: expliciete tl_quotation_status → timestamp-afgeleid.
  function deriveOfferteStatus(q) {
    const s = String(q?.tl_quotation_status || '').toLowerCase();
    if (s === 'accepted' || s === 'signed')             return 'accepted';
    if (s === 'declined' || s === 'refused')            return 'declined';
    if (s === 'cancelled' || s === 'canceled')          return 'cancelled';
    if (s === 'sent')                                    return 'sent';
    if (s === 'draft')                                   return 'draft';
    // Onbekende / lege tl_quotation_status → afleiden uit timestamps.
    if (q?.accepted_at)  return 'accepted';
    if (q?.declined_at)  return 'declined';
    if (q?.sent_at)      return 'sent';
    return 'draft';
  }

  // Compacte gedaan/niet-gedaan indicator (groen vinkje / rood kruisje) voor de
  // Abbo- en Onboarding-kolommen op het Offertes-overzicht.
  const svStatusIcon = (ok, doneTitle, notTitle) => ok
    ? `<span title="${esc(doneTitle)}" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:12px;font-weight:800;background:var(--emerald-soft,rgba(16,185,129,.16));color:var(--emerald,#10b981)">✓</span>`
    : `<span title="${esc(notTitle)}" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:12px;font-weight:800;background:var(--rose-soft,rgba(244,63,94,.16));color:var(--rose,#f43f5e)">✗</span>`;

  const RET_STATUS_TO_PILL = (item) => {
    if (item.retention_not_renewing) return ['warn', 'Niet verlengen'];
    if ((item.days_left || 0) < 0)   return ['warn', 'Afgelopen'];
    if ((item.days_left || 0) <= 14) return ['info', `Nog ${item.days_left} d`];
    return ['neutral', `Nog ${item.days_left} d`];
  };

  // ── DASHBOARD ────────────────────────────────────────────────────────────
  // Rol-bewust: super_admin/manager → company-view (bedrijfsbreed);
  // sales/mentor/... → mijn-view (uit sales-dashboard-metrics).
  //
  // OMZET-definitie (per user): som van GETEKENDE (geaccepteerde) offertes
  // INCL. BTW, met accepted_at in de periode. Voor company-view halen we
  // dus /api/sales-quotations?status=accepted (page_size=250) en sommeren
  // client-side total_amount_incl per accepted_at-filter (huidige maand voor
  // dashboard, gekozen range voor prestaties). Als total > 250: console.warn.
  //
  // Highest deal company: max op total_amount_incl over dezelfde set.
  //
  // Sales-dashboard-metrics.my_revenue_month is excl-BTW — die blijft voor
  // "mijn"-view zoals-is (matcht wat sales.html toont voor Sales-rol).
  // BROK SALES-1 (v=11, 2026-08-19): paginate helper voor accepted-deals.
  // Voorheen: page_size=250 vaste cap → omzet + hoogste-deal berekend op
  // eerste 250 rijen (v1: 783 rijen). Nu: eerste pagina bepaalt total →
  // loop overige pagina's parallel → concat. Backward-compatible: nieuwe
  // helper, bestaande endpoint ongewijzigd → v1 sales.html blijft werken.
  // Cap: 10 pagina's (= 2500 rijen) als hard safety-net tegen runaway.
  async function _fetchAllAcceptedPages(baseLabel, baseUrl) {
    const first = await tryFetch(baseLabel + ':p1', baseUrl + '&page=1&page_size=250');
    if (!first || first.error) return first; // errored → laat caller error afhandelen
    const total = Number(first.total || 0);
    const pageSize = 250;
    const totalPages = Math.min(10, Math.ceil(total / pageSize));
    if (totalPages <= 1) return first;
    const extraPages = [];
    for (let p = 2; p <= totalPages; p++) {
      extraPages.push(tryFetch(baseLabel + ':p' + p, baseUrl + '&page=' + p + '&page_size=' + pageSize));
    }
    const results = await Promise.all(extraPages);
    const combined = [...(first.quotations || first.items || [])];
    for (const r of results) {
      if (!r || r.error) continue;
      combined.push(...(r.quotations || r.items || []));
    }
    return { ...first, quotations: combined, items: combined, total };
  }

  async function fetchDashboard() {
    if (_dash.loading) return;
    const admin = isAdminRole();
    const seq = ++_dash.seq;
    _dash.loading = true; _dash.error = null; _dash.bootRole = admin ? 'admin' : 'own';
    // FLICKER-FIX: geen loading-render meer (zie fetchOffertes). Stale data
    // blijft staan tot de fetch klaar is.
    const calls = [
      tryFetch('sales-dashboard-stats',       '/api/sales-dashboard-stats'),
      tryFetch('sales-dashboard-metrics',     '/api/sales-dashboard-metrics'),
      tryFetch('sales-pending-subscriptions', '/api/sales-pending-subscriptions'),
      admin ? _fetchAllAcceptedPages('sales-accepted-month', '/api/sales-quotations?status=accepted') : Promise.resolve(null),
    ];
    const [stats, metrics, pending, companyAccepted] = await Promise.all(calls);
    if (seq !== _dash.seq) return;
    _dash.stats = stats; _dash.metrics = metrics; _dash.pending = pending;
    _dash.companyAccepted = companyAccepted;
    _dash.loading = false;
    if (stats == null && metrics == null && pending == null) _dash.error = 'Alle dashboard-calls faalden';
    // BROK SALES-1 (v=11): 250-cap opgeheven via paginate helper. Log
    // alleen als het HARDE plafond (10 pagina's = 2500) bereikt is —
    // dat betekent dat we méér data missen dan we konden ophalen.
    if (admin && companyAccepted && companyAccepted.total > 2500) {
      console.warn('[sales-v2] company-accepted total > 2500 (' + companyAccepted.total + ') — omzet+hoogste-deal berekend op eerste 2500 rijen (cap safety-net)');
    }
    window.DFO.render();
  }

  // Client-side aggregatie over accepted deals waarvan accepted_at in
  // [fromIso, toIso] valt. Returnt { totalIncl, totalExcl, count, highestIncl }.
  // Fallback: als total_amount_incl null is → val terug op total_amount (excl)
  // zodat de deal in ieder geval meetelt in count/totaal (nieuwe/handmatige
  // deals kunnen incl-veld missen als TL de sync nog niet deed).
  function acceptedAgg(list, fromIso, toIso) {
    let totalIncl = 0, totalExcl = 0, count = 0, highestIncl = null;
    for (const q of (list || [])) {
      const dt = q.accepted_at || q.sent_at || q.created_at;
      if (!dt) continue;
      const day = String(dt).slice(0, 10);
      if (day < fromIso || day > toIso) continue;
      const incl = Number(q.total_amount_incl) || Number(q.total_amount) || 0;
      const excl = Number(q.total_amount) || 0;
      totalIncl += incl; totalExcl += excl; count++;
      if (highestIncl == null || incl > highestIncl) highestIncl = incl;
    }
    return { totalIncl, totalExcl, count, highestIncl };
  }

  function dashboardView() {
    const admin = isAdminRole();
    const wantedRole = admin ? 'admin' : 'own';
    if (!_dash.loading && (!_dash.boot || _dash.bootRole !== wantedRole)) {
      _dash.boot = true;
      queueMicrotask(fetchDashboard);
    }
    const m = _dash.metrics || {};
    const s = _dash.stats   || {};
    const p = _dash.pending || {};
    const openActies = s.open_acties?.total ?? null;
    const recent = Array.isArray(m.my_recent_quotations) ? m.my_recent_quotations : [];

    // Company: incl-BTW som van accepted deals met accepted_at in huidige
    // maand. Voor Sales-rol: my_revenue_month (excl-BTW, uit metrics-endpoint).
    let totalRev, totalCount, highestDeal, revLabel, revSub, hiLabel, hiSub;
    if (admin) {
      // Ronde-19: omzet-KPI = INCL BTW. Jeffrey vraagt bedrijfsbreed incl,
      // consistent met TL-officieel (aug € 72.549,95 incl / 11 deals).
      const agg = acceptedAgg(_dash.companyAccepted?.quotations, monthStart(), todayIso());
      totalRev = agg.count ? agg.totalIncl : null;
      totalCount = agg.count;
      highestDeal = agg.highestIncl;
      revLabel = 'Totale omzet deze maand';
      revSub   = agg.count ? `${num(agg.count)} getekende offertes · incl. BTW` : 'incl. BTW · bedrijfsbreed';
      hiLabel  = 'Hoogste deal deze maand';
      hiSub    = 'bedrijfsbreed · incl. BTW';
    } else {
      totalRev = m.my_revenue_month;
      totalCount = m.my_sales_count_month;
      highestDeal = m.my_highest_deal;
      revLabel = 'Mijn omzet deze maand';
      revSub   = `${num(totalCount)} deals · excl. BTW`;
      hiLabel  = 'Mijn hoogste deal';
      hiSub    = 'deze maand · excl. BTW';
    }

    return `${previewHeader('Dashboard' + (admin ? ' · company-view' : ' · mijn-view'), _dash)}
      ${H.kpis([
        { c: 'violet',  icon: I.doc,    label: 'Mijn open offertes',    val: num(m.my_open_quotations), hi: 1, sub: 'nog niet getekend' },
        { c: 'emerald', icon: I.euro,   label: revLabel,                val: eur0(totalRev),            hi: 1, sub: revSub },
        { c: 'blue',    icon: I.trend,  label: hiLabel,                 val: eur0(highestDeal),                sub: hiSub },
        { c: 'orange',  icon: I.warn,   label: 'Open follow-up-acties', val: num(openActies),                  sub: 'in mijn werklijst' },
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
                  <div class="sv-recent-sub">${q.quote_reference || ('#' + String(q.deal_id || '').slice(0, 8))} · ${dstr(q.created_at)}</div>
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
  // Nieuwe offerte: opent v2-wizard in-shell (body-mounted modal via #sw-v2-root).
  // Fallback naar oude wizard-html als sales-wizard-v2.js niet geladen is
  // (defensive; script wordt vanaf klanten-v2/index.html geladen).
  window.__svOfferteNew  = () => {
    if (typeof window.__swOpen === 'function') { window.__swOpen(); return; }
    window.location.href = '/modules/sales-wizard.html';
  };
  // Klik op een offerte-rij opent de v2-detail-pagina (niet de wizard).
  // 'Bewerken' vanuit die detail-pagina redirect wél naar de wizard in
  // edit-mode.
  // Klik op offerte-rij opent de detail in-shell (iframe binnen klanten-v2
  // shell — sidebar/topbar blijven). Fallback op standalone page-nav als
  // offerte-detail-v2.js niet geladen is (defensive; script wordt normaal
  // vanaf klanten-v2/index.html geladen).
  window.__svOfferteOpen = (dealId) => {
    if (!dealId) return;
    if (typeof window.__odvOpen === 'function') { window.__odvOpen(dealId); return; }
    window.location.href = '/modules/offerte-detail-v2.html?id=' + encodeURIComponent(dealId);
  };
  // Row-click handler voor H.table: resolvet index → deal_id → __svOfferteOpen.
  window.__svOfferteRowClick = (i) => {
    const q = (_off.data && _off.data.quotations && _off.data.quotations[i]) || null;
    if (q && q.deal_id) window.__svOfferteOpen(q.deal_id);
  };

  function offertesParams() {
    // v=17 pre-flip fix 1+2+3:
    // - status: client-side via deriveOfferteStatus (rijen zonder tl_quotation_
    //   status vielen anders weg bij server-eq-filter).
    // - owned_by_me: server-side (endpoint accepteert nu '1'/'true'/true).
    // - page_size = 500 per pagina; client-loop haalt ALLE pagina's zodat de
    //   chip-tellingen op de volledige dataset kloppen (843 rijen ≈ 2 requests).
    //   Server-side derived-status-filter zou net zijn; interim client-loop
    //   dekt de tellingen zonder API-refactor.
    const mine   = F('sv-off-mine', '1') === '1' ? '1' : '';
    const q = String(
      (H.getSearchValue && H.getSearchValue('sv-off-q'))
      || F('q', '')
      || ''
    ).trim();
    const p = new URLSearchParams();
    if (mine) p.set('owned_by_me', '1');
    if (q)    p.set('search', q);
    p.set('page_size', '500');
    return p.toString();
  }

  async function fetchOffertes() {
    const wanted = offertesParams();
    if (_off.loading && _off.params === wanted) return;
    const seq = ++_off.seq;
    _off.loading = true; _off.error = null; _off.params = wanted;
    // v=17 pagineer-loop: haal ALLE pagina's zodat client-side status-filter
    // + chip-tellingen op de volledige dataset werken (was 250-cap → chips
    // toonden subset i.p.v. totaal). Guard: max 20 pagina's = 10k rijen —
    // meer dan genoeg voor productie (843 nu), voorkomt runaway loop bij
    // buggy pagination.
    const allQuotations = [];
    let firstTotal = null;
    let page = 1;
    let hadError = false;
    while (page <= 20) {
      const p = new URLSearchParams(wanted);
      p.set('page', String(page));
      const data = await tryFetch('sales-quotations', '/api/sales-quotations?' + p.toString());
      if (seq !== _off.seq) return;  // superseded — abandon
      if (!data) { hadError = true; break; }
      const rows = Array.isArray(data?.quotations) ? data.quotations : [];
      allQuotations.push(...rows);
      if (firstTotal === null) firstTotal = data?.total ?? rows.length;
      const totalPages = data?.total_pages || 1;
      if (page >= totalPages || rows.length === 0) break;
      page += 1;
    }
    if (seq !== _off.seq) return;
    _off.loading = false;
    if (hadError && allQuotations.length === 0) {
      _off.error = 'Kon offertes niet laden';
      _off.data = null;
    } else {
      _off.data = { quotations: allQuotations, total: firstTotal ?? allQuotations.length };
    }
    window.DFO.render();
  }

  function offertesView() {
    // In-shell offerte-detail: als URL ?deal_id=X, delegeer naar de shell-
    // view module (iframe-embed van /modules/offerte-detail-v2.html). Sidebar
    // + topbar blijven staan; detail vult content-area.
    try {
      const _dealId = new URLSearchParams(location.search).get('deal_id');
      if (_dealId && typeof window.__odvRender === 'function') {
        return `${previewHeader('Offerte-detail', {})}
          <div class="tb-row" style="padding:0 20px 8px">
            <button class="btn btn-ghost btn-sm" onclick="__odvBack()">← Terug naar Offertes</button>
          </div>
          ${window.__odvRender(_dealId)}`;
      }
    } catch (_) { /* fall through to normal offertes-lijst */ }
    const st   = F('sv-off-st', 'all');
    const mine = F('sv-off-mine', '1');
    // Registreer debounced onSearch één keer per view-mount (idempotent — H.onSearch
    // overschrijft handler op zelfde key). Cursor-bug fix: stableSearch behoudt de
    // input-DOM-node tussen renders, dus focus/cursor blijven staan tijdens typen.
    if (H.onSearch) {
      H.onSearch('sv-off-q', () => {
        // FLICKER-FIX: NIET _off.data = null zetten — dat combineert met de
        // auto-fetch-check in offertesView (!_off.data) en kan een
        // dubbel-fetch triggeren via de wachtende queueMicrotask. Enkel
        // _off.params reset zodat de wanted-vs-params-check triggert.
        _off.params = '';
        fetchOffertes();
      }, { debounceMs: 260 });
    }
    // Trigger fetch bij eerste render OF wanneer filter-params veranderd zijn.
    const wanted = offertesParams();
    if (!_off.loading && !_off.error && (!_off.data || _off.params !== wanted)) queueMicrotask(fetchOffertes);
    // v=... pre-flip fix 1: client-side statusfilter op afgeleide status
    // (dezelfde bron die het dashboard gebruikt). Server returnt alle deals;
    // hier filteren we op de chip. Totaal = filtered.length zodat de "N offertes"
    // teller klopt met wat de user ziet.
    const raw = _off.data?.quotations || [];
    const items = st && st !== 'all' ? raw.filter(q => deriveOfferteStatus(q) === st) : raw;
    const total = items.length;
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
        H.stableSearch
          ? H.stableSearch('sv-off-q', 'Zoek klant / offerte-nr…')
          : H.search('Zoek klant / offerte-nr…'),
        `<div class="tb-right">
          <button class="btn btn-primary" onclick="__svOfferteNew()">${svg(I.plus)}Nieuwe offerte</button>
        </div>`,
      ])}
      <div class="sv-total">${_off.loading ? 'Laden…' : (total != null ? `${total} offerte${total === 1 ? '' : 's'}` : '—')}</div>
      ${H.table(
        [{ l: 'Offerte-nr' }, { l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Verkoper', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Datum', cls: 'r optional' }, { l: 'Status' }, { l: 'Abbo' }, { l: 'Onboarding' }],
        items.map(q => [
          `<span class="sv-off-nr">${q.quote_reference || ('#' + String(q.deal_id || '').slice(0, 8))}</span>`,
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(q.customer_name || '?')}</div><span class="cell-main">${q.customer_name || '—'}</span></div>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${q.traject_label || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${q.sales_user || '—'}</span>`,
          `<span class="mono">${eur0(q.total_amount)}</span>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(q.created_at)}</span>`,
          (() => { const ds = deriveOfferteStatus(q); const p = OST_TO_PILL[ds] || ['neutral', ds]; return H.pill(p[0], p[1]); })(),
          svStatusIcon(q.has_subscription, 'Abbo ingevoerd', 'Nog geen abbo'),
          svStatusIcon(q.has_onboarding, 'Onboarding aangemeld', 'Onboarding niet aangemeld'),
        ]),
        '__svOfferteRowClick'
      )}
      ${!items.length && !_off.loading ? (
        _off.error
          ? `<div class="sv-empty">${esc(_off.error)} <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:11.5px" onclick="__svRetryOff()">↻ Opnieuw</button></div>`
          : `<div class="sv-empty">Geen offertes met deze filters.</div>`
      ) : ''}`;
  }
  window.__svRetryOff = () => { _off.error = null; _off.data = null; _off.params = ''; queueMicrotask(fetchOffertes); if (window.DFO?.render) window.DFO.render(); };
  window.__svRetryRet = () => { _ret.error = null; _ret.data = null; _ret.params = ''; queueMicrotask(fetchRetentie); if (window.DFO?.render) window.DFO.render(); };
  window.__svRetryRep = () => { _rep.error = null; _rep.data = null; _rep.accepted = null; _rep.params = ''; queueMicrotask(fetchReports); if (window.DFO?.render) window.DFO.render(); };

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
    // FLICKER-FIX: geen loading-render meer (zie fetchOffertes).
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
    if (!_ret.loading && !_ret.error && (!_ret.data || _ret.params !== wanted)) queueMicrotask(fetchRetentie);
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
      ${!items.length && !_ret.loading ? (
        _ret.error
          ? `<div class="sv-empty">${esc(_ret.error)} <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:11.5px" onclick="__svRetryRet()">↻ Opnieuw</button></div>`
          : `<div class="sv-empty">Geen retentie-klanten in dit venster.</div>`
      ) : ''}`;
  }

  // ── VERKOOPPRESTATIES ───────────────────────────────────────────────────
  // Period-selector: Dag / Week / Maand / Jaar / Custom. Mapt naar
  // sales-reports from/to/group_by. Custom = 2 date-inputs (state in _rep).
  function rangeForLabel(label) {
    const now = new Date(); const to = todayIso();
    if (label === 'Dag')   return { from: to, to, group_by: 'day' };
    if (label === 'Week')  { const f = new Date(now); f.setDate(f.getDate() - 6); return { from: isoDay(f), to, group_by: 'day' }; }
    if (label === 'Maand') return { from: monthStart(), to, group_by: 'day' };
    if (label === 'Jaar')  return { from: isoDay(new Date(now.getFullYear(), 0, 1)), to, group_by: 'month' };
    if (label === 'Custom') {
      // Fallback als state nog leeg: laatste 30 dagen.
      if (!_rep.customFrom || !_rep.customTo) {
        const f = new Date(now); f.setDate(f.getDate() - 30);
        _rep.customFrom = isoDay(f); _rep.customTo = to;
      }
      const f = _rep.customFrom, t = _rep.customTo;
      const days = Math.max(1, Math.round((new Date(t) - new Date(f)) / 86400000));
      return { from: f, to: t, group_by: days <= 31 ? 'day' : days <= 120 ? 'week' : 'month' };
    }
    return { from: monthStart(), to, group_by: 'day' };
  }
  function reportsParams() {
    const label = F('sv-rep-p', 'Maand');
    const r = rangeForLabel(label);
    return `from=${r.from}&to=${r.to}&group_by=${r.group_by}`;
  }
  async function fetchReports() {
    const wanted = reportsParams();
    if (_rep.loading && _rep.params === wanted) return;
    const seq = ++_rep.seq;
    _rep.loading = true; _rep.error = null; _rep.params = wanted;
    // FLICKER-FIX: geen loading-render meer (zie fetchOffertes).
    // Parallel: sales-reports (funnel-leads/-quotations counts + retention +
    // bonus + trend) + accepted-deals (voor omzet + per-verkoper + funnel-
    // signed/paid — allemaal incl-BTW client-side gesommeerd).
    const [data, accepted] = await Promise.all([
      tryFetch('sales-reports',         '/api/sales-reports?' + wanted),
      _fetchAllAcceptedPages('sales-accepted-period', '/api/sales-quotations?status=accepted'),
    ]);
    if (seq !== _rep.seq) return;
    _rep.loading = false; _rep.data = data; _rep.accepted = accepted;
    if (!data && !accepted) _rep.error = 'Kon rapport + accepted niet laden';
    // BROK SALES-1 (v=11): 250-cap opgeheven via paginate helper.
    if (accepted && accepted.total > 2500) {
      console.warn('[sales-v2] accepted total > 2500 (' + accepted.total + ') — cap safety-net');
    }
    window.DFO.render();
  }

  // Client-side aggregatie over accepted deals in [from, to].
  // Levert: incl-BTW-totaal, excl-BTW-totaal, aantal getekend, aantal betaald
  // (= subs actief), en per-verkoper-map (naam → incl/excl/count).
  // LEIDENDE DEFINITIE (gebruiker): OMZET = som total_amount_incl van deals
  // waarvan accepted_at in periode.
  function acceptedAggReports(fromIso, toIso) {
    const list = _rep.accepted?.quotations || [];
    let totalIncl = 0, totalExcl = 0, signedCount = 0, paidCount = 0;
    const userMap = new Map();
    for (const q of list) {
      const dt = q.accepted_at || q.sent_at || q.created_at;
      if (!dt) continue;
      const day = String(dt).slice(0, 10);
      if (day < fromIso || day > toIso) continue;
      const incl = Number(q.total_amount_incl) || Number(q.total_amount) || 0;
      const excl = Number(q.total_amount) || 0;
      totalIncl += incl; totalExcl += excl; signedCount++;
      if (q.has_subscription) paidCount++;
      const uname = q.sales_user || 'Onbekend';
      if (!userMap.has(uname)) userMap.set(uname, { user_name: uname, count: 0, revenue_incl: 0, revenue_excl: 0 });
      const u = userMap.get(uname);
      u.count++; u.revenue_incl += incl; u.revenue_excl += excl;
    }
    const perUser = [...userMap.values()].sort((a, b) => b.revenue_incl - a.revenue_incl);
    return { totalIncl, totalExcl, signedCount, paidCount, perUser };
  }

  window.__svRepCustomFrom = (v) => { _rep.customFrom = v; setF('sv-rep-p', 'Custom'); };
  window.__svRepCustomTo   = (v) => { _rep.customTo   = v; setF('sv-rep-p', 'Custom'); };

  function prestatiesView() {
    const label = F('sv-rep-p', 'Maand');
    const wanted = reportsParams();
    if (!_rep.loading && !_rep.error && (!_rep.data || _rep.params !== wanted)) queueMicrotask(fetchReports);
    const k = _rep.data?.kpis || {};
    const period = _rep.data?.period || rangeForLabel(label);
    const agg = acceptedAggReports(period.from, period.to);

    // Funnel: leads + quotations counts komen van server (created in period);
    // signed + paid overriden we client-side uit accepted-set zodat 't 1-op-1
    // consistent is met de omzet-berekening (accepted_at in period, niet
    // created_at). Zonder deze override kan Getekend > 0 zijn terwijl Omzet
    // = 0 (deal created buiten periode, accepted binnen — of andersom).
    const fObj = _rep.data?.funnel || {};
    const funnelRows = [
      ['Leads (aangemaakt in periode)', fObj.leads],
      ['Offertes verstuurd',            fObj.quotations],
      ['Getekend (accepted in periode)', agg.signedCount],
      ['Betaald / gestart (heeft sub)',  agg.paidCount],
    ];

    const trend = _rep.data?.trend || [];
    const trendMax = Math.max(1, ...trend.map(t => Number(t.revenue) || 0));

    // Custom-inputs: alleen renderen als Custom actief is.
    const customRow = label === 'Custom' ? `
      <div class="sv-custom-range">
        <label>Van <input type="date" value="${_rep.customFrom || ''}" onchange="__svRepCustomFrom(this.value)"></label>
        <label>Tot <input type="date" value="${_rep.customTo   || ''}" onchange="__svRepCustomTo(this.value)"></label>
      </div>` : '';

    return `${previewHeader('Verkoopprestaties', _rep)}
      ${H.kpis([
        { c: 'violet',  icon: I.trend,  label: 'Pipeline-waarde',    val: eur0(k.pipeline_value),          hi: 1, sub: 'open + verzonden · excl. BTW' },
        // BROK B (2026-08-19): omzet-KPI EXCL BTW. Sub-lijn toont incl-
        // variant tussenhaakjes ALS incl > excl (data-driven — vermijdt
        // "(€X incl.)" bij deals met identieke incl/excl door line-item-
        // fallback).
        { c: 'emerald', icon: I.euro,   label: 'Omzet in periode',   val: agg.signedCount ? eur0(agg.totalExcl) : eur0(0), hi: 1,
          sub: `${num(agg.signedCount)} getekend · excl. BTW${(agg.totalIncl && agg.totalExcl && agg.totalIncl > agg.totalExcl) ? ` · (${eur0(agg.totalIncl)} incl.)` : ''}` },
        { c: 'blue',    icon: I.doc,    label: 'Bonus openstaand',   val: eur0(k.bonus_pending) },
        { c: 'orange',  icon: I.repeat, label: 'Retentie-ratio',     val: k.retention_rate != null ? Math.round(k.retention_rate * 100) + '%' : '—' },
      ])}
      ${H.toolbar([
        H.chips('sv-rep-p', [
          { l: 'Dag',    v: 'Dag' },
          { l: 'Week',   v: 'Week' },
          { l: 'Maand',  v: 'Maand' },
          { l: 'Jaar',   v: 'Jaar' },
          { l: 'Custom', v: 'Custom' },
        ], label),
      ])}
      ${customRow}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Verkoop-funnel</div>
          <div class="sv-card-body">
            ${funnelRows.map(([l, v]) => `
              <div class="sv-row"><span>${l}</span><b>${num(v)}</b></div>
            `).join('')}
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.users)}Per verkoper · incl. BTW</div>
          <div class="sv-card-body">
            ${agg.perUser.length ? agg.perUser.slice(0, 8).map(u => `
              <div class="sv-row"><span>${u.user_name} <span class="sv-row-sub">${num(u.count)} deals</span></span><b>${eur0(u.revenue_incl)}</b></div>
            `).join('') : `<div class="sv-empty">${_rep.loading ? 'Laden…' : 'Geen getekende offertes in deze periode.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.trend)}Omzet-trend · excl. BTW (sales-reports)</div>
          <div class="sv-card-body">
            ${(Array.isArray(trend) && trend.length) ? `<div class="sv-trend">${trend.map(t => {
              const rev = Number(t.revenue) || 0;
              const h = Math.max(3, Math.round(rev / trendMax * 100));
              return `<div class="sv-trend-col" title="${t.period || ''} · ${eur0(rev)}">
                <div class="sv-trend-bar" style="height:${h}%"></div>
                <div class="sv-trend-lbl">${t.period || ''}</div>
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
  console.debug('[sales-v2] v=12 BROK SALES-1: (2) paginate _fetchAllAcceptedPages tot alle rijen (cap 10p=2500); (3) BTW-tussenhaakjes (X excl.) alleen tonen als excl<incl; (4) error-block Opnieuw-knop op offertes + retentie + reports (via __svRetryOff/Ret/Rep). Beschermde zone ongemoeid.');
})();
