// modules/klanten-v2/views/list.js
//
// Klanten Lijst-view (PR-A scope). Dekt uit INVENTARIS.md:
//   - Page header               (r851)
//   - Bulk-result banner        (r862)  — session-only, geen persistent state
//   - KPI-strip                 (r869)  — /api/customers?stats=true
//   - Filters-bar               (r880)  — status-pills + tags-multi + zoek + gemaakt-op
//   - Bulk-action-bar           (r910)  — Archiveren / Tag toevoegen / Deselecteren
//   - Klantenlijst-tabel        (r924)  — selectie + kolommen + kebab-menu
//   - Empty-state               (r956)
//   - Error-state               (r961)
//   - Pagination                (r966)
//
// Detail-view + tabs = PR-B; modals (create/edit/archive/tag/duplicate) = PR-C.
// Waar een actie hier alleen een placeholder-toast triggert is dat expliciet
// gemarkeerd met "// TODO PR-C" of "// TODO PR-B".

const K = () => window.KV;

const STATUS_TABS = [
  { key: 'active',     label: 'Actief',        pillClass: 'ds-pill-ok' },
  { key: 'archived',   label: 'Gearchiveerd',  pillClass: 'ds-pill-neutral' },
  { key: 'anonymized', label: 'Geanonimiseerd', pillClass: 'ds-pill-violet' },
];

const SORT_OPTIONS = [
  { key: 'created_at:desc',      label: 'Nieuwste eerst' },
  { key: 'created_at:asc',       label: 'Oudste eerst' },
  { key: 'last_name:asc',        label: 'Achternaam A→Z' },
  { key: 'last_name:desc',       label: 'Achternaam Z→A' },
  { key: 'first_name:asc',       label: 'Voornaam A→Z' },
  { key: 'last_contact_at:desc', label: 'Laatste contact eerst' },
];

const PAGE_SIZE_DEFAULT = 25;

// Module-scope state (per view-mount vers ge-init)
let state = null;

// ── Public entry ─────────────────────────────────────────────────────────────

export async function renderListView(rootEl, { profile } = {}) {
  state = {
    profile,
    tagsCatalog: [],           // [{slug,label,color}]
    stats: null,               // {active,new_this_month,risico}
    filter: {
      status: 'active',
      tags: [],                // slug-array
      search: '',
      created_from: '',
      created_to: '',
    },
    sort: 'created_at:desc',
    page: 1,
    pageSize: PAGE_SIZE_DEFAULT,
    rows: [],
    total: 0,
    totalPages: 1,
    loading: true,
    error: null,
    selected: new Set(),       // klant-id's
    banner: null,              // {type,text} — bulk-result banner
    kebabOpenFor: null,
  };

  rootEl.innerHTML = renderShell();
  wireControls(rootEl);

  // Topbar-search stuurt vanaf app-shell events, forward naar filter.search
  window.addEventListener('kv:topbar-search', onTopbarSearch);

  // Init parallel: tags + stats + eerste lijst-fetch
  await Promise.all([loadTags(), loadStats(), loadList()]);
  render(rootEl);
}

function onTopbarSearch(ev) {
  if (!state) return;
  state.filter.search = (ev.detail && ev.detail.value) || '';
  state.page = 1;
  loadList().then(() => renderTablePart());
}

// ── Data-fetches ─────────────────────────────────────────────────────────────

async function loadTags() {
  try {
    const j = await K().authedJson('/api/customer-tag-definitions');
    state.tagsCatalog = (j && j.tags) || [];
  } catch (e) {
    console.warn('[klanten-v2] tags load fail:', e.message);
    state.tagsCatalog = [];
  }
}

async function loadStats() {
  try {
    const j = await K().authedJson('/api/customers?stats=true');
    state.stats = (j && j.stats) || null;
  } catch (e) {
    console.warn('[klanten-v2] stats load fail:', e.message);
    state.stats = null;
  }
}

async function loadList() {
  state.loading = true;
  state.error = null;
  try {
    const [sortBy, sortDir] = state.sort.split(':');
    const params = new URLSearchParams();
    if (state.filter.search)       params.set('search', state.filter.search);
    if (state.filter.tags.length)  params.set('tags', state.filter.tags.join(','));
    params.set('status', state.filter.status);
    if (state.filter.created_from) params.set('created_from', state.filter.created_from);
    if (state.filter.created_to)   params.set('created_to', state.filter.created_to);
    params.set('sort_by', sortBy);
    params.set('sort_dir', sortDir || 'desc');
    params.set('page', String(state.page));
    params.set('page_size', String(state.pageSize));

    const j = await K().authedJson(`/api/customers?${params.toString()}`);
    state.rows       = (j && j.customers) || [];
    state.total      = (j && j.total) || 0;
    state.totalPages = (j && j.total_pages) || 1;
  } catch (e) {
    console.error('[klanten-v2] list load error:', e);
    state.rows = [];
    state.total = 0;
    state.totalPages = 1;
    state.error = e.message || 'Onbekende fout bij laden klanten';
  } finally {
    state.loading = false;
  }
}

// ── Shell / render ───────────────────────────────────────────────────────────

function renderShell() {
  return `
    <div id="kv-banner-slot"></div>
    <section class="ds-hero" id="kv-hero"></section>
    <div class="ds-toolbar" id="kv-toolbar"></div>
    <div id="kv-table-slot"></div>
    <div id="kv-pager-slot"></div>
    <div id="kv-bulkbar-slot"></div>
  `;
}

function render(rootEl) {
  renderBanner();
  renderHero();
  renderToolbar();
  renderTablePart();
  renderPager();
  renderBulkbar();
}

// ── 1. Banner (bulk-result) ─────────────────────────────────────────────────

function renderBanner() {
  const el = K().$('#kv-banner-slot');
  if (!el) return;
  if (!state.banner) { el.innerHTML = ''; return; }
  const cls = state.banner.type === 'error' ? 'ds-banner-error'
            : state.banner.type === 'warn'  ? 'ds-banner-warn'
            : 'ds-banner-ok';
  el.innerHTML = `
    <div class="ds-banner ${cls}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/></svg>
      <span>${K().esc(state.banner.text)}</span>
      <button class="ds-icon-btn" style="margin-left:auto;" aria-label="Sluiten" data-act="banner-close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
  el.querySelector('[data-act="banner-close"]').addEventListener('click', () => {
    state.banner = null; renderBanner();
  });
}

// ── 2. Hero (KPI-strip + page-header) ────────────────────────────────────────

function renderHero() {
  const el = K().$('#kv-hero');
  if (!el) return;
  const s = state.stats || { active: '–', new_this_month: '–', risico: '–', wanbetalers_placeholder: '–' };
  el.innerHTML = `
    <div style="display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:14px; flex-wrap:wrap;">
      <div>
        <div style="font-size:20px; font-weight:600; letter-spacing:-.03em;">Klantenoverzicht</div>
        <div style="font-size:12.5px; color:var(--text-3); margin-top:2px;">Alle klanten in ons systeem — koppelingen, offertes, betalingen en geschiedenis.</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="ds-btn ds-btn-ghost" type="button" data-act="export">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>
          Exporteren
        </button>
        <button class="ds-btn ds-btn-primary" type="button" data-act="new-customer">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          Nieuwe klant
        </button>
      </div>
    </div>
    <div class="ds-kpi-grid">
      ${kpiCard('Actieve klanten', s.active, 'var(--emerald)', 'var(--emerald-soft)', usersIcon(), 'Totaal actief in systeem')}
      ${kpiCard('Nieuw deze maand', s.new_this_month, 'var(--blue)', 'var(--blue-soft)', plusIcon(), 'Aangemaakt vanaf maandstart')}
      ${kpiCard('Risico', s.risico, 'var(--amber)', 'var(--amber-soft)', warnIcon(), "Klanten met tag 'risico'")}
      ${kpiCard('Wanbetalers', '—', 'var(--rose)', 'var(--rose-soft)', invoiceIcon(), 'Volgt in Finance-koppeling')}
    </div>
  `;

  el.querySelector('[data-act="new-customer"]').addEventListener('click', () => {
    // TODO PR-C: open create-modal
    K().toast('Nieuwe-klant-modal komt in PR-C');
  });
  el.querySelector('[data-act="export"]').addEventListener('click', () => {
    // TODO PR-C: CSV-export
    K().toast('CSV-export komt in PR-C');
  });
}

function kpiCard(label, value, color, softColor, iconSvg, footNote) {
  return `
    <div class="ds-kpi" style="--kc:${color}; --kc-soft:${softColor};">
      <div class="ds-kpi-top">
        <span class="ds-kpi-ico">${iconSvg}</span>
        <span class="ds-kpi-label">${K().esc(label)}</span>
      </div>
      <div class="ds-kpi-val">${K().esc(value)}</div>
      <div class="ds-kpi-foot">${K().esc(footNote || '')}</div>
    </div>`;
}

// ── 3. Toolbar (filters + zoek + sort) ───────────────────────────────────────

function renderToolbar() {
  const el = K().$('#kv-toolbar');
  if (!el) return;

  const statusChips = STATUS_TABS.map((t) => `
    <button class="ds-chip ${state.filter.status === t.key ? 'on' : ''}" type="button" data-status="${t.key}">
      ${K().esc(t.label)}
    </button>`).join('');

  const tagsSelected = state.filter.tags.length;
  const tagsSelector = `
    <div class="ds-dd" data-dd="tags">
      <button class="ds-filter-sel" type="button" data-act="dd-toggle">
        Tags ${tagsSelected ? `<span class="cnt" style="opacity:.7;">· ${tagsSelected}</span>` : ''}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:12px; height:12px; margin-left:4px; vertical-align:middle;"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="ds-dd-menu" data-menu style="min-width:220px; max-height:320px; overflow-y:auto; bottom:auto; top:calc(100% + 6px);">
        ${state.tagsCatalog.length
          ? state.tagsCatalog.map((t) => `
              <label class="ds-dd-item" style="cursor:pointer;">
                <input type="checkbox" data-tag="${K().esc(t.slug)}" ${state.filter.tags.includes(t.slug) ? 'checked' : ''} style="margin-right:6px;"/>
                <span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${K().esc(t.color || '#8B95A5')};"></span>
                <span style="flex:1;">${K().esc(t.label || t.slug)}</span>
              </label>`).join('')
          : `<div class="ds-dd-item" style="cursor:default;">Geen tags beschikbaar</div>`}
        ${state.filter.tags.length ? `<div class="ds-dd-sep"></div><button type="button" class="ds-dd-item" data-act="tags-clear" style="width:100%; text-align:left;">Tag-filters wissen</button>` : ''}
      </div>
    </div>`;

  const sortSelect = `
    <select class="ds-filter-sel" data-act="sort">
      ${SORT_OPTIONS.map((o) => `<option value="${o.key}" ${state.sort === o.key ? 'selected' : ''}>${K().esc(o.label)}</option>`).join('')}
    </select>`;

  const dateRange = `
    <input type="date" class="ds-filter-sel" data-act="date-from" value="${K().esc(state.filter.created_from)}" title="Gemaakt vanaf" style="min-width:140px;">
    <span style="color:var(--text-3); font-size:12px;">–</span>
    <input type="date" class="ds-filter-sel" data-act="date-to" value="${K().esc(state.filter.created_to)}" title="Gemaakt tot" style="min-width:140px;">
    ${(state.filter.created_from || state.filter.created_to) ? `<button type="button" class="ds-chip" data-act="date-clear" title="Wis datum-filter">✕ datum</button>` : ''}
  `;

  el.innerHTML = `
    ${statusChips}
    <div style="width:1px; height:22px; background:var(--border); margin:0 4px;"></div>
    ${tagsSelector}
    ${dateRange}
    <div class="ds-tb-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" placeholder="Zoek in resultaten…" data-act="search" value="${K().esc(state.filter.search)}"/>
    </div>
    <div class="ds-tb-right">
      ${sortSelect}
      <span style="font-size:11.5px; color:var(--text-3); font-family:'IBM Plex Mono',monospace;">${K().esc(state.total)} klanten</span>
    </div>
  `;

  // Status-chips
  el.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter.status = btn.getAttribute('data-status');
      state.page = 1;
      loadList().then(() => renderTablePart());
      renderToolbar();
    });
  });

  // Tags dropdown
  const dd = el.querySelector('.ds-dd[data-dd="tags"]');
  if (dd) {
    const menu = dd.querySelector('[data-menu]');
    dd.querySelector('[data-act="dd-toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    dd.querySelectorAll('input[type="checkbox"][data-tag]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const slug = cb.getAttribute('data-tag');
        if (cb.checked) { if (!state.filter.tags.includes(slug)) state.filter.tags.push(slug); }
        else            { state.filter.tags = state.filter.tags.filter((s) => s !== slug); }
        state.page = 1;
        loadList().then(() => { renderTablePart(); renderToolbar(); });
      });
    });
    const clearBtn = dd.querySelector('[data-act="tags-clear"]');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      state.filter.tags = []; state.page = 1;
      loadList().then(() => { renderTablePart(); renderToolbar(); });
    });
    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target)) menu.classList.remove('open');
    }, { once: true });
  }

  // Sort
  el.querySelector('[data-act="sort"]').addEventListener('change', (e) => {
    state.sort = e.target.value;
    loadList().then(() => renderTablePart());
  });

  // Date range
  const fromEl = el.querySelector('[data-act="date-from"]');
  const toEl   = el.querySelector('[data-act="date-to"]');
  const bounce = (fn) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), 250); }; };
  fromEl && fromEl.addEventListener('change', () => {
    state.filter.created_from = fromEl.value || '';
    state.page = 1; loadList().then(() => { renderTablePart(); renderToolbar(); });
  });
  toEl && toEl.addEventListener('change', () => {
    state.filter.created_to = toEl.value || '';
    state.page = 1; loadList().then(() => { renderTablePart(); renderToolbar(); });
  });
  const dClear = el.querySelector('[data-act="date-clear"]');
  if (dClear) dClear.addEventListener('click', () => {
    state.filter.created_from = ''; state.filter.created_to = '';
    state.page = 1; loadList().then(() => { renderTablePart(); renderToolbar(); });
  });

  // In-toolbar search (naast topbar-search)
  const searchInput = el.querySelector('[data-act="search"]');
  const debSearch = bounce(() => {
    state.filter.search = searchInput.value || ''; state.page = 1;
    loadList().then(() => renderTablePart());
  });
  searchInput.addEventListener('input', debSearch);
}

// ── 4. Tabel + empty + error ────────────────────────────────────────────────

function renderTablePart() {
  const el = K().$('#kv-table-slot');
  if (!el) return;

  if (state.loading && state.rows.length === 0) {
    el.innerHTML = tableFrame(skeletonRows(8));
    return;
  }
  if (state.error) {
    el.innerHTML = `
      <div class="ds-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <div>
          <strong>Fout bij laden klanten.</strong>
          <div style="font-size:12.5px; opacity:.85; margin-top:2px;">${K().esc(state.error)}</div>
        </div>
        <button class="ds-btn ds-btn-ghost" style="margin-left:auto;" data-act="retry">Opnieuw</button>
      </div>`;
    el.querySelector('[data-act="retry"]').addEventListener('click', () => {
      loadList().then(() => renderTablePart());
    });
    return;
  }
  if (state.rows.length === 0) {
    el.innerHTML = `
      <div class="ds-empty">
        <div class="ds-empty-ico">${searchIcon()}</div>
        <div class="ds-empty-t">Geen klanten gevonden</div>
        <div class="ds-empty-s">Pas de filters aan of maak een nieuwe klant aan om te beginnen.</div>
        <div style="margin-top:14px;">
          <button class="ds-btn ds-btn-primary" data-act="new-customer">Nieuwe klant</button>
        </div>
      </div>`;
    el.querySelector('[data-act="new-customer"]').addEventListener('click', () => K().toast('Nieuwe-klant-modal komt in PR-C'));
    return;
  }

  el.innerHTML = tableFrame(renderRows());
  wireTableRows(el);
  renderBulkbar();
}

function tableFrame(bodyHtml) {
  const allSelected = state.rows.length > 0 && state.rows.every((r) => state.selected.has(r.id));
  return `
    <div class="ds-tbl-wrap">
      <table class="ds-tbl">
        <thead>
          <tr>
            <th style="width:38px;">
              <div class="ds-checkbox ${allSelected ? 'on' : ''}" data-act="sel-all" role="checkbox" aria-checked="${allSelected}" tabindex="0">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
              </div>
            </th>
            <th>Klant</th>
            <th>Contact</th>
            <th class="ds-optional">Tags</th>
            <th class="ds-optional">Status</th>
            <th class="ds-optional">Aangemaakt</th>
            <th style="width:44px;"></th>
          </tr>
        </thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </div>`;
}

function renderRows() {
  return state.rows.map((c) => rowHtml(c)).join('');
}

function rowHtml(c) {
  const sel = state.selected.has(c.id);
  const name = customerDisplayName(c);
  const emailPhone = [c.email, c.phone].filter(Boolean).join(' · ');
  const tagsHtml = (c.tags || []).slice(0, 3).map((t) => `
    <span class="ds-pill ds-pill-neutral nodot" style="background:${K().esc(t.color || 'var(--surface-2)')}22; color:${K().esc(t.color || 'var(--text-2)')}; border-color:transparent;">${K().esc(t.label || t.slug)}</span>
  `).join('');
  const extraTags = (c.tags || []).length > 3 ? `<span class="ds-pill ds-pill-neutral nodot">+${(c.tags || []).length - 3}</span>` : '';
  const statusPill = statusPillFor(c);
  const created = formatDate(c.created_at);
  const biz = c.is_company
    ? `<span class="kv-biz-badge" title="Bedrijfsklant"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V8l9-4 9 4v13"/><path d="M9 21v-6h6v6"/></svg></span>`
    : '';

  return `
    <tr class="${sel ? 'sel' : ''}" data-id="${K().esc(c.id)}">
      <td>
        <div class="ds-checkbox ${sel ? 'on' : ''}" data-act="row-select" role="checkbox" aria-checked="${sel}" tabindex="0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </div>
      </td>
      <td>
        <div class="ds-row-avatar">
          ${K().renderAvatar(c.id, name)}
          <div>
            <div class="ds-cell-main" style="display:flex; align-items:center;">${K().esc(name)}${biz}</div>
            ${c.email ? `<div class="ds-cell-sub">${K().esc(c.email)}</div>` : ''}
          </div>
        </div>
      </td>
      <td><div class="ds-cell-main">${K().esc(emailPhone || '—')}</div></td>
      <td class="ds-optional"><div style="display:flex; gap:4px; flex-wrap:wrap;">${tagsHtml}${extraTags || ''}${!(c.tags || []).length ? '<span style="color:var(--text-3); font-size:12px;">—</span>' : ''}</div></td>
      <td class="ds-optional">${statusPill}</td>
      <td class="ds-optional"><span class="num" style="font-size:12.5px; color:var(--text-2);">${K().esc(created)}</span></td>
      <td>
        <div class="ds-dd">
          <button class="ds-icon-btn" data-act="row-kebab" aria-label="Meer acties" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
          </button>
          <div class="ds-dd-menu">
            <button class="ds-dd-item" data-act="row-open">${eyeIcon()} Openen</button>
            <button class="ds-dd-item" data-act="row-edit">${pencilIcon()} Bewerken</button>
            <button class="ds-dd-item" data-act="row-tag">${tagIcon()} Tag toevoegen</button>
            <div class="ds-dd-sep"></div>
            <button class="ds-dd-item danger" data-act="row-archive">${archiveIcon()} Archiveren</button>
          </div>
        </div>
      </td>
    </tr>`;
}

function wireTableRows(el) {
  // Select-all
  const selAll = el.querySelector('[data-act="sel-all"]');
  if (selAll) selAll.addEventListener('click', () => {
    const allSelected = state.rows.every((r) => state.selected.has(r.id));
    if (allSelected) state.rows.forEach((r) => state.selected.delete(r.id));
    else             state.rows.forEach((r) => state.selected.add(r.id));
    renderTablePart();
  });

  // Rij-selectie + rij-klik + kebab
  el.querySelectorAll('tbody tr').forEach((tr) => {
    const id = tr.getAttribute('data-id');

    tr.querySelector('[data-act="row-select"]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.selected.has(id)) state.selected.delete(id);
      else state.selected.add(id);
      renderTablePart();
    });

    // Rij-klik = openen (detail-view, PR-B)
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="row-kebab"]')) return;
      if (e.target.closest('.ds-dd-menu')) return;
      if (e.target.closest('[data-act="row-select"]')) return;
      window.KV.navigate({ id, tab: 'profiel' });
    });

    const kebab = tr.querySelector('[data-act="row-kebab"]');
    const menu  = tr.querySelector('.ds-dd-menu');
    kebab.addEventListener('click', (e) => {
      e.stopPropagation();
      // Sluit andere menu's
      document.querySelectorAll('.ds-dd-menu.open').forEach((m) => { if (m !== menu) m.classList.remove('open'); });
      menu.classList.toggle('open');
    });
    menu.querySelector('[data-act="row-open"]').addEventListener('click', (e) => {
      e.stopPropagation(); menu.classList.remove('open');
      window.KV.navigate({ id, tab: 'profiel' });
    });
    menu.querySelector('[data-act="row-edit"]').addEventListener('click', (e) => {
      e.stopPropagation(); menu.classList.remove('open');
      K().toast('Bewerk-modal komt in PR-C');
    });
    menu.querySelector('[data-act="row-tag"]').addEventListener('click', (e) => {
      e.stopPropagation(); menu.classList.remove('open');
      K().toast('Tag-modal komt in PR-C');
    });
    menu.querySelector('[data-act="row-archive"]').addEventListener('click', (e) => {
      e.stopPropagation(); menu.classList.remove('open');
      K().toast('Archiveer-bevestiging komt in PR-C');
    });
  });

  // Klik buiten sluit alle kebab-menus
  document.addEventListener('click', () => {
    document.querySelectorAll('.ds-dd-menu.open').forEach((m) => m.classList.remove('open'));
  }, { once: true });
}

// ── 5. Pagination ────────────────────────────────────────────────────────────

function renderPager() {
  const el = K().$('#kv-pager-slot');
  if (!el) return;
  if (state.total === 0) { el.innerHTML = ''; return; }

  const from = (state.page - 1) * state.pageSize + 1;
  const to   = Math.min(state.page * state.pageSize, state.total);
  el.innerHTML = `
    <div class="ds-pager">
      <div class="ds-pager-info">
        <strong style="color:var(--text-2);">${from}–${to}</strong> van <strong style="color:var(--text-2);">${state.total}</strong> klanten
        <span style="margin-left:14px;">·&nbsp; Per pagina:</span>
        <select class="ds-filter-sel" style="padding:3px 8px; margin-left:6px;" data-act="page-size">
          ${[25, 50, 100].map((n) => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
      </div>
      <div class="ds-pager-controls">
        <button class="ds-pager-btn" data-act="page-prev" ${state.page <= 1 ? 'disabled' : ''} aria-label="Vorige pagina">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <span class="num" style="font-size:12.5px; color:var(--text-2); padding:0 8px;">${state.page} / ${state.totalPages}</span>
        <button class="ds-pager-btn" data-act="page-next" ${state.page >= state.totalPages ? 'disabled' : ''} aria-label="Volgende pagina">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
        </button>
      </div>
    </div>
  `;
  el.querySelector('[data-act="page-prev"]').addEventListener('click', () => {
    if (state.page > 1) { state.page--; loadList().then(() => { renderTablePart(); renderPager(); }); }
  });
  el.querySelector('[data-act="page-next"]').addEventListener('click', () => {
    if (state.page < state.totalPages) { state.page++; loadList().then(() => { renderTablePart(); renderPager(); }); }
  });
  el.querySelector('[data-act="page-size"]').addEventListener('change', (e) => {
    state.pageSize = parseInt(e.target.value, 10) || PAGE_SIZE_DEFAULT;
    state.page = 1;
    loadList().then(() => { renderTablePart(); renderPager(); });
  });
}

// ── 6. Bulk-action-bar ───────────────────────────────────────────────────────

function renderBulkbar() {
  const el = K().$('#kv-bulkbar-slot');
  if (!el) return;
  if (state.selected.size === 0) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="ds-bulkbar" role="region" aria-label="Bulk-acties">
      <span style="font-weight:600;">${state.selected.size} geselecteerd</span>
      <div style="width:1px; height:20px; background:rgba(255,255,255,.2);"></div>
      <button class="ds-btn ds-btn-ghost" data-act="bulk-tag">${tagIcon()} Tag toevoegen</button>
      <button class="ds-btn ds-btn-ghost" data-act="bulk-archive">${archiveIcon()} Archiveren</button>
      <button class="ds-btn ds-btn-ghost" data-act="bulk-clear" style="margin-left:auto;">Deselecteren</button>
    </div>
  `;
  el.querySelector('[data-act="bulk-clear"]').addEventListener('click', () => {
    state.selected.clear(); renderTablePart();
  });
  el.querySelector('[data-act="bulk-tag"]').addEventListener('click', () => {
    K().toast('Bulk-tag-modal komt in PR-C');
  });
  el.querySelector('[data-act="bulk-archive"]').addEventListener('click', () => {
    K().toast('Bulk-archiveer-bevestiging komt in PR-C');
  });
}

// ── 7. Helpers ────────────────────────────────────────────────────────────────

function wireControls(rootEl) { /* nothing global for now */ }

function customerDisplayName(c) {
  if (c.is_company && c.company_name) return c.company_name;
  const parts = [c.first_name, c.last_name].filter(Boolean);
  if (parts.length) return parts.join(' ');
  return c.email || '(naamloos)';
}

function statusPillFor(c) {
  const s = c.status || 'active';
  if (s === 'archived')   return `<span class="ds-pill ds-pill-neutral">Gearchiveerd</span>`;
  if (s === 'anonymized') return `<span class="ds-pill ds-pill-violet">Geanoniem.</span>`;
  return `<span class="ds-pill ds-pill-ok">Actief</span>`;
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}-${mm}-${yy}`;
  } catch (_) { return '—'; }
}

function skeletonRows(n) {
  const row = `
    <tr>
      <td><div class="ds-checkbox"></div></td>
      <td><div style="height:14px; width:60%; background:var(--surface-2); border-radius:5px;"></div></td>
      <td><div style="height:12px; width:50%; background:var(--surface-2); border-radius:5px;"></div></td>
      <td class="ds-optional"><div style="height:12px; width:40%; background:var(--surface-2); border-radius:5px;"></div></td>
      <td class="ds-optional"><div style="height:12px; width:30%; background:var(--surface-2); border-radius:5px;"></div></td>
      <td class="ds-optional"><div style="height:12px; width:35%; background:var(--surface-2); border-radius:5px;"></div></td>
      <td></td>
    </tr>`;
  return Array(n).fill(row).join('');
}

// ── SVG icons ────────────────────────────────────────────────────────────────

function usersIcon()   { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M22 20v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13A4 4 0 0 1 16 11"/></svg>`; }
function plusIcon()    { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`; }
function warnIcon()    { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`; }
function invoiceIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>`; }
function searchIcon()  { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`; }
function eyeIcon()     { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s4-8 10-8 10 8 10 8-4 8-10 8S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function pencilIcon()  { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>`; }
function tagIcon()     { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 12 22l-9-9V3h10Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>`; }
function archiveIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>`; }
