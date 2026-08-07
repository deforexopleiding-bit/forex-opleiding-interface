// modules/klanten-v2/views/tabs/wanbetalers.js
//
// Wanbetalers-tab van klanten-v2 (PR-B6, deel 2 van 3). 5 items uit de
// INVENTARIS, STRIKT READ-ONLY — BESCHERMDE ZONE.
//
// ⚠ Deze tab MAG UITSLUITEND lezen. Zero mutation-endpoints. Alle acties
// (aanmaan / arrangement voorstellen / escaleren / stoppen) blijven in
// /modules/finance.html sub-view Wanbetalers. Deze tab toont een read-
// only snapshot met een prominente deep-link daarheen zodat de gebruiker
// direct naar de mutation-flow kan.
//
// Data-bronnen (allen GET, allen read-only):
//   /api/customer-dossier?customer_id=X   → NU + GEBEURD + NOG_TE_DOEN
//                                            blocks met dunning-fase,
//                                            open facturen, timeline
//   /api/arrangements-list?customer_id=X  → payment_arrangements-lijst
//                                            (VOORGESTELD/ACTIEF/etc)
//
// De beschermde wanbetalers-zone (finance.html, cron-dunning-*, dunning-*,
// joost-*, voys-*, arrangements-* mutation-endpoints, pending-actions-*,
// _lib/dunning-*, _lib/joost-*) is NIET aangeraakt in deze PR.

const K = () => window.KV;

const ARR_STATUS = {
  VOORGESTELD:  { label: 'Voorgesteld', cls: 'ds-pill-warn'    },
  ACTIEF:       { label: 'Actief',      cls: 'ds-pill-accent'  },
  NAGEKOMEN:    { label: 'Nagekomen',   cls: 'ds-pill-ok'      },
  VERBROKEN:    { label: 'Verbroken',   cls: 'ds-pill-danger'  },
  GEANNULEERD:  { label: 'Geannuleerd', cls: 'ds-pill-neutral' },
};
function arrStatusPill(st) {
  const key = String(st || '').toUpperCase();
  const m = ARR_STATUS[key] || { label: st || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls}">${K().esc(m.label)}</span>`;
}
const ARR_TYPE = {
  UITSTEL:          'Uitstel',
  SPLITSING:        'Splitsing',
  ABONNEMENT_PAUZE: 'Abo pauzeren',
  ABONNEMENT_STOP:  'Abo stoppen',
  KWIJTSCHELDING:   'Kwijtschelding',
  TOEZEGGING:       'Toezegging',
};

let state = null;
function initState(customer) {
  state = {
    customerId: customer?.id || null,
    dossier: null,
    arrangements: [],
    loading: true,
    error: null,
  };
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch (_) { return ''; }
}
function fmtDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

async function loadAll() {
  // Twee parallelle read-only fetches. Faults blokkeren elkaar niet.
  const [dossierR, arrR] = await Promise.allSettled([
    K().authedJson(`/api/customer-dossier?customer_id=${encodeURIComponent(state.customerId)}`),
    K().authedJson(`/api/arrangements-list?customer_id=${encodeURIComponent(state.customerId)}`),
  ]);
  const dossier = dossierR.status === 'fulfilled' ? dossierR.value : null;
  const items   = arrR.status     === 'fulfilled' ? (arrR.value?.items || []) : [];
  return { dossier, arrangements: items,
           errors: [dossierR, arrR].filter(r => r.status === 'rejected').map(r => r.reason?.message || 'fout') };
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const { dossier, arrangements, errors } = await loadAll();
    state.dossier = dossier;
    state.arrangements = arrangements;
    if (errors.length && !dossier && !arrangements.length) state.error = errors.join(' · ');
  } catch (e) {
    state.error = e?.message || 'Kan wanbetalers-data niet laden';
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

// ── Dunning-fase card (uit customer-dossier) ────────────────────────────────

function renderDunningFaseCard() {
  const nu = state.dossier?.blocks?.nu;
  if (!nu || nu.granted === false) {
    return `
      <div class="kv-prof-card kv-wbp-fase">
        <div class="kv-prof-card-title">Dunning-fase</div>
        <div class="kv-prof-empty">
          ${nu?.granted === false ? 'Geen leesrechten (finance.dunning.view vereist).' : 'Geen dunning-status bekend.'}
        </div>
      </div>`;
  }
  const fase       = nu.dunning_stage || nu.pipeline_stage || '—';
  const lastAction = nu.last_dunning_action_at || nu.last_dunning_sent_at;
  const openInvs   = Array.isArray(nu.open_invoices) ? nu.open_invoices : [];
  const openTotal  = openInvs.reduce((s, i) => s + (Number(i.open_amount) || Number(i.amount_total) || 0), 0);
  return `
    <div class="kv-prof-card kv-wbp-fase">
      <div class="kv-prof-card-title">Dunning-fase (nu)</div>
      <div class="kv-wbp-fase-head">
        <div class="kv-wbp-fase-name">${K().esc(fase)}</div>
        ${lastAction ? `<div class="kv-wbp-fase-sub">Laatste actie: ${K().esc(fmtDateTime(lastAction))}</div>` : ''}
      </div>
      <div class="kv-wbp-fase-row">
        <div class="kv-wbp-fase-stat">
          <div class="kv-wbp-fase-stat-l">Open facturen</div>
          <div class="kv-wbp-fase-stat-v">${openInvs.length}</div>
        </div>
        <div class="kv-wbp-fase-stat">
          <div class="kv-wbp-fase-stat-l">Openstaand bedrag</div>
          <div class="kv-wbp-fase-stat-v mono">${K().esc(fmtEur(openTotal))}</div>
        </div>
      </div>
    </div>`;
}

// ── Arrangements card ──────────────────────────────────────────────────────

function renderArrangementCard(arr) {
  const type = ARR_TYPE[String(arr.type || '').toUpperCase()] || arr.type || '—';
  const created = fmtDate(arr.created_at);
  const details = arr.details || {};
  // Voor UITSTEL: ends_on; voor SPLITSING: parts[].length; voor abo-pauze: pause_until.
  let extra = '';
  const t = String(arr.type || '').toUpperCase();
  if (t === 'UITSTEL' && (details.ends_on || details.new_due_date)) {
    extra = `Tot ${K().esc(fmtDate(details.ends_on || details.new_due_date))}`;
  } else if (t === 'SPLITSING' && Array.isArray(details.parts)) {
    extra = `${details.parts.length} termijnen`;
  } else if (t === 'ABONNEMENT_PAUZE' && details.pause_until) {
    extra = `Tot ${K().esc(fmtDate(details.pause_until))}`;
  }
  return `
    <li class="kv-wbp-arr-row">
      <div class="kv-wbp-arr-main">
        <div class="kv-wbp-arr-type">${K().esc(type)}</div>
        ${extra ? `<div class="kv-wbp-arr-extra">${extra}</div>` : ''}
      </div>
      <div class="kv-wbp-arr-meta">
        ${arrStatusPill(arr.status)}
        <span class="ds-cell-sub">${K().esc(created)}</span>
      </div>
    </li>`;
}

function renderArrangementsCard() {
  const arrs = state.arrangements || [];
  const active = arrs.filter(a => (a.status || '').toUpperCase() === 'ACTIEF').length;
  if (!arrs.length) {
    return `
      <div class="kv-prof-card kv-wbp-arrs">
        <div class="kv-prof-card-title-row">
          <div class="kv-prof-card-title" style="margin:0">Betalingsregelingen</div>
        </div>
        <div class="kv-prof-empty">Geen regelingen voor deze klant.</div>
      </div>`;
  }
  return `
    <div class="kv-prof-card kv-wbp-arrs">
      <div class="kv-prof-card-title-row">
        <div class="kv-prof-card-title" style="margin:0">Betalingsregelingen</div>
        <div class="kv-prof-count">${arrs.length}${active ? ` · ${active} actief` : ''}</div>
      </div>
      <ul class="kv-wbp-arr-list">${arrs.map(renderArrangementCard).join('')}</ul>
    </div>`;
}

// ── Timeline preview (dossier.gebeurd) ─────────────────────────────────────

function renderTimelinePreview() {
  const g = state.dossier?.blocks?.gebeurd;
  if (!g || g.granted === false) return '';
  const items = Array.isArray(g.timeline) ? g.timeline.slice(0, 5) : [];
  if (!items.length) return '';
  return `
    <div class="kv-prof-card kv-wbp-timeline">
      <div class="kv-prof-card-title">Recente wanbetaler-events</div>
      <ul class="kv-wbp-tl">
        ${items.map(t => `
          <li>
            <div class="kv-wbp-tl-dot"></div>
            <div class="kv-wbp-tl-body">
              <div class="kv-wbp-tl-t">${K().esc(t.title || t.event_type || 'Event')}</div>
              ${t.summary ? `<div class="kv-wbp-tl-s">${K().esc(t.summary)}</div>` : ''}
              <div class="kv-wbp-tl-time ds-cell-sub">${K().esc(fmtDateTime(t.occurred_at || t.created_at))}</div>
            </div>
          </li>`).join('')}
      </ul>
    </div>`;
}

// ── Deep-link banner (naar Finance › Wanbetalers voor mutations) ───────────

function renderProtectedBanner() {
  return `
    <div class="ds-banner ds-banner-warn kv-wbp-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <strong>Read-only weergave.</strong>
        <div style="font-size:12px; opacity:.85; margin-top:2px;">
          Alle wanbetaler-acties (aanmanen · regelingen voorstellen · escaleren · stoppen) blijven in
          <a href="/modules/finance.html#view-wanbetalers" target="_blank" rel="noopener" style="color:var(--m); text-decoration:underline; font-weight:600;">Finance › Wanbetalers</a>.
          Deze tab toont alleen wat er nu speelt voor deze klant — geen mutation-flow.
        </div>
      </div>
      <a class="ds-btn ds-btn-primary ds-btn-sm" href="/modules/finance.html#view-wanbetalers" target="_blank" rel="noopener" style="margin-left:auto;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open in Finance
      </a>
    </div>`;
}

function renderError() {
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>Kan wanbetaler-data niet laden.</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(state.error)}</div>
        <div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-wbp-retry>Opnieuw proberen</button></div>
      </div>
    </div>`;
}

function render(rootEl) {
  let body;
  if (state.loading) {
    body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Wanbetaler-data laden…</div></div>`;
  } else if (state.error) {
    body = renderError();
  } else {
    body = `
      ${renderProtectedBanner()}
      ${renderDunningFaseCard()}
      ${renderArrangementsCard()}
      ${renderTimelinePreview()}
    `;
  }
  rootEl.innerHTML = `<div class="kv-wbp">${body}</div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-wbp-retry]')?.addEventListener('click', () => actLoad(rootEl));
}

export async function renderWanbetalersTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `<div class="ds-empty" style="padding:40px 20px;"><div class="ds-empty-t">Geen klant-data</div></div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
