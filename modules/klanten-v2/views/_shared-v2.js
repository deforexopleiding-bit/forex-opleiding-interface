// modules/klanten-v2/views/_shared-v2.js
//
// Gedeelde helpers voor v2-module-views (kpi / kpis / toolbar / chips /
// search / table / av / pill / trend + voorbeeldBanner).
//
// 1-op-1 gekopieerd uit docs/redesign/systeemprototype-v45.html:
//   - kpi/kpis    r1200-1208
//   - toolbar     r1195
//   - chips       r1196
//   - search      r1197 (LEGACY — nieuwe views gebruiken stableSearch, zie ronde-4)
//   - pill        r1199
//   - av          r1200 (met avc/ini uit DFO)
//   - trend       r1201
//   - table       r1223-1226
//
// Ronde 4 uitbreidingen (cursor-fix):
//   - H.stableSearch(key, placeholder) → mount-slot voor persistent input
//   - H.mountedList(listKey, initialHTML) → partial-render slot
//   - H.onSearch(key, cb, opts) → registreer debounced handler
//   - H.getSearchValue / setSearchValue
//   - H.setListHTML(listKey, html) → update lijst zonder volledige render
//   - DFO.render monkey-patch: snapshot focus + detach wraps + hydrate + restore
//
// Non-ES-module (klassieke <script>).

(function () {
  if (!window.DFO) { console.error('[_shared-v2] DFO shell niet geladen.'); return; }
  const { I, svg, S, F, avc, ini } = window.DFO;

  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const trend = (v, up) => `<span class="trend ${up === null ? 'trend-flat' : up ? 'trend-up' : 'trend-down'}">${up !== null ? svg(up ? I.up : I.arrDown) : ''}${v}</span>`;
  const pill = (c, t, nd) => `<span class="pill pill-${c} ${nd ? 'nodot' : ''}">${t}</span>`;

  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)" ${o.click ? `onclick="${o.click}"` : ''}>
      <div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot">${o.trend || ''}<span>${o.sub || ''}</span></div></div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;

  const toolbar = p => `<div class="toolbar">${p.join('')}</div>`;
  const chips = (n, o, c) => o.map(x => `<button class="chip ${c === x.v ? 'on' : ''}" onclick="DFO.setF('${n}','${x.v}')">${x.l}${x.n !== undefined ? `<span class="cnt">${x.n}</span>` : ''}</button>`).join('');

  // LEGACY search — gebruikt nog value="" wat cursor-drop veroorzaakt.
  // Nieuwe views MOETEN stableSearch gebruiken.
  const search = ph => `<div class="tb-search">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
    <input placeholder="${ph}" oninput="DFO.setF('q',this.value)" value="${(F('q', '') || '').replace(/"/g, '&quot;')}" /></div>`;

  function table(cols, rows, onclick) {
    return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr ${onclick ? `onclick="${onclick}(${i})"` : ''} class="${S.selIdx === i ? 'sel' : ''}">
        ${r.map((cell, j) => `<td class="${cols[j].cls || ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  const voorbeeldBanner = () => `<div style="margin:14px 20px 0;padding:11px 14px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);
    display:flex;align-items:center;gap:11px;font-size:12.5px;color:var(--amber)">
    ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}
    <span><b>VOORBEELD-DATA</b> — deze view toont layout uit systeemprototype-v45.
    Data-koppeling volgt in de volgende ronde na layout-goedkeuring.</span></div>`;

  // ─── RONDE 4: stableSearch + mountedList + DFO.render patch ────────────
  //
  // Root-cause cursor-bug: H.search() rendert <input> als HTML-string. Elke
  // DFO.render() doet #content.innerHTML swap → input-DOM-node wordt volledig
  // vervangen → focus/cursor/waarde weg. defaultValue is geen HTML-attribuut
  // (React-ism) dus deed ook niets.
  //
  // Fix: input leeft in module-scope cache (Map). View retourneert alleen
  // een leeg mount-slot. Rond elke render():
  //   - snapshotFocusedSearch (welk key had focus + selection)
  //   - detachSearchWrapsBeforeRender (haal wraps uit oude DOM)
  //   - orig render (innerHTML swap #content)
  //   - hydrateSearchMounts (herplaats cached wraps in nieuwe slots)
  //   - restoreFocusedSearch (focus + setSelectionRange)
  //
  // Input-DOM-node identity blijft = cursor + value bewaard.
  const SEARCH_HANDLERS   = new Map(); // key → {onChange, debounceMs}
  const SEARCH_VALUES     = new Map(); // key → current string value
  const SEARCH_INPUT_CACHE = new Map(); // key → HTMLInputElement (in wrap)
  const SEARCH_TIMERS     = new Map(); // key → setTimeout handle

  const stableSearch = (key, placeholder, _opts = {}) =>
    `<div class="kv-search-mount" data-search-key="${key}" data-search-ph="${String(placeholder || '').replace(/"/g, '&quot;')}"></div>`;

  function onSearch(key, onChange, opts) {
    opts = opts || {};
    SEARCH_HANDLERS.set(key, { onChange, debounceMs: opts.debounceMs != null ? opts.debounceMs : 280 });
  }
  const getSearchValue = (key) => SEARCH_VALUES.get(key) || '';
  function setSearchValue(key, value) {
    SEARCH_VALUES.set(key, value || '');
    const input = SEARCH_INPUT_CACHE.get(key);
    if (input) input.value = value || '';
    const clear = input && input.parentElement && input.parentElement.querySelector('.kv-search-clear');
    if (clear) clear.style.display = (value ? '' : 'none');
  }

  const mountedList = (listKey, initialHTML) =>
    `<div class="kv-list-mount" data-list-key="${listKey}">${initialHTML || ''}</div>`;

  function setListHTML(listKey, html) {
    const slot = document.querySelector(`.kv-list-mount[data-list-key="${listKey}"]`);
    if (slot) slot.innerHTML = html;
  }

  function fireSearchChange(key, val) {
    const h = SEARCH_HANDLERS.get(key);
    if (!h) return;
    const prev = SEARCH_TIMERS.get(key);
    if (prev) clearTimeout(prev);
    SEARCH_TIMERS.set(key, setTimeout(() => {
      try { h.onChange(val); }
      catch (e) { console.warn('[stableSearch] onChange threw for', key, e); }
    }, h.debounceMs));
  }

  function createSearchWrap(key, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'tb-search kv-search-wrap';
    wrap.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'kv-search-input';
    input.placeholder = placeholder || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = SEARCH_VALUES.get(key) || '';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'kv-search-clear';
    clear.setAttribute('aria-label', 'Zoekopdracht wissen');
    clear.textContent = '×';
    clear.style.display = input.value ? '' : 'none';
    input.addEventListener('input', () => {
      const v = input.value;
      SEARCH_VALUES.set(key, v);
      clear.style.display = v ? '' : 'none';
      fireSearchChange(key, v);
    });
    // Native <input type=search> heeft 'search' event bij X-klik (WebKit),
    // en ESC om te wissen. Vang beide om state synced te houden.
    input.addEventListener('search', () => {
      const v = input.value;
      SEARCH_VALUES.set(key, v);
      clear.style.display = v ? '' : 'none';
      fireSearchChange(key, v);
    });
    clear.addEventListener('mousedown', (e) => { e.preventDefault(); });
    clear.addEventListener('click', (e) => {
      e.preventDefault();
      input.value = '';
      SEARCH_VALUES.set(key, '');
      clear.style.display = 'none';
      input.focus();
      fireSearchChange(key, '');
    });
    wrap.appendChild(input);
    wrap.appendChild(clear);
    SEARCH_INPUT_CACHE.set(key, input);
    return wrap;
  }

  function hydrateSearchMounts() {
    document.querySelectorAll('.kv-search-mount').forEach((mount) => {
      const key = mount.getAttribute('data-search-key');
      if (!key) return;
      if (mount.firstChild) return; // al gehydreerd
      const cached = SEARCH_INPUT_CACHE.get(key);
      if (cached && cached.parentElement && cached.parentElement.classList.contains('kv-search-wrap')) {
        mount.appendChild(cached.parentElement);
      } else {
        const fresh = createSearchWrap(key, mount.getAttribute('data-search-ph') || '');
        mount.appendChild(fresh);
      }
    });
  }

  function snapshotFocusedSearch() {
    const el = document.activeElement;
    if (!el || el.tagName !== 'INPUT' || !el.classList.contains('kv-search-input')) return null;
    const mount = el.closest('.kv-search-mount');
    const key = mount && mount.getAttribute('data-search-key');
    if (!key) return null;
    let start = null, end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch (_) { /* type=search: no selection API in some browsers */ }
    return { key, start, end };
  }

  function restoreFocusedSearch(snap) {
    if (!snap) return;
    const input = SEARCH_INPUT_CACHE.get(snap.key);
    if (!input || !input.isConnected) return;
    try {
      input.focus({ preventScroll: true });
      if (snap.start != null && snap.end != null && typeof input.setSelectionRange === 'function') {
        try { input.setSelectionRange(snap.start, snap.end); } catch (_) { /* type=search may throw */ }
      }
    } catch (_) { /* noop */ }
  }

  function detachSearchWrapsBeforeRender() {
    SEARCH_INPUT_CACHE.forEach((input) => {
      const wrap = input.parentElement;
      if (wrap && wrap.parentElement) wrap.parentElement.removeChild(wrap);
    });
  }

  function patchDfoRender(attempt) {
    attempt = attempt || 0;
    if (!window.DFO || typeof window.DFO.render !== 'function') {
      if (attempt < 40) setTimeout(() => patchDfoRender(attempt + 1), 25);
      else console.warn('[_shared-v2] Kon DFO.render niet patchen (DFO ontbreekt na 1s).');
      return;
    }
    if (window.DFO.__kvSearchPatchApplied) return;
    window.DFO.__kvSearchPatchApplied = true;
    const orig = window.DFO.render;
    window.DFO.render = function () {
      const snap = snapshotFocusedSearch();
      detachSearchWrapsBeforeRender();
      const result = orig.apply(this, arguments);
      hydrateSearchMounts();
      restoreFocusedSearch(snap);
      return result;
    };
  }
  patchDfoRender();

  // ── joost_config safe-upsert helpers (extracted from agents-v2.js) ──
  //
  // joost_config heeft NOT-NULL kolommen (system_prompt_template etc.).
  // Als je een losse toggle schrijft zonder de volle rij mee te sturen faalt
  // de INSERT bij een module zonder bestaande rij. Deze helpers laden altijd
  // eerst de volle config en mergen dan de overrides erin.
  //
  // Voor module='finance' worden autonomy_config + feature_flags GESTRIPT
  // (protected zone — dunning-config mag alleen via finance-endpoints).
  async function joostFetchDefaults(moduleKey) {
    try {
      if (!window.KV || !window.KV.authedJson) return null;
      const j = await window.KV.authedJson('/api/joost-config-get?module=' + encodeURIComponent(moduleKey));
      return j && (j.config || j) || null;
    } catch (_) { return null; }
  }
  async function joostBuildFullBody(moduleKey, overrides) {
    const cur = await joostFetchDefaults(moduleKey) || {};
    const safe = {
      module: moduleKey,
      persona_name:           overrides?.persona_name           ?? cur.persona_name           ?? '—',
      persona_tone:           overrides?.persona_tone           ?? cur.persona_tone           ?? 'professional',
      system_prompt_template: overrides?.system_prompt_template ?? cur.system_prompt_template ?? '(nog niet ingesteld)',
      knowledge_base:         overrides?.knowledge_base         ?? cur.knowledge_base         ?? '',
      model:                  overrides?.model                  ?? cur.model                  ?? 'claude-sonnet-4-20250514',
      temperature:            overrides?.temperature            ?? cur.temperature            ?? 0.4,
      context_message_count:  overrides?.context_message_count  ?? cur.context_message_count  ?? 10,
      is_enabled:             overrides?.is_enabled             ?? cur.is_enabled             ?? false,
      feature_flags:          overrides?.feature_flags          ?? cur.feature_flags          ?? {},
      autonomy_config:        overrides?.autonomy_config        ?? cur.autonomy_config        ?? {},
    };
    // Protected-zone strip: finance-config mag NOOIT autonomy_config of
    // feature_flags overschrijven via v2 (dunning-config leeft in Finance).
    if (moduleKey === 'finance') {
      delete safe.autonomy_config;
      delete safe.feature_flags;
    }
    return safe;
  }
  async function joostSafeUpsert(moduleKey, overrides) {
    if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
    const body = await joostBuildFullBody(moduleKey, overrides || {});
    return await window.KV.authedJson('/api/joost-config-upsert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  window.KV_V2 = window.KV_V2 || {};
  window.KV_V2.helpers = {
    kpi, kpis, toolbar, chips, search, table, av, pill, trend, voorbeeldBanner,
    // Ronde 4:
    stableSearch, onSearch, getSearchValue, setSearchValue,
    mountedList, setListHTML,
    // Blootgesteld voor modules met eigen lokale re-render (bv. subw-v2
    // overlay-root swap) — na innerHTML-swap moeten cached search-inputs
    // opnieuw geplaatst worden zodat cursor + waarde overleven.
    hydrateSearchMounts,
    // joost_config safe-upsert helpers (Automatiseringen v2 + Agents v2)
    joostFetchDefaults, joostBuildFullBody, joostSafeUpsert,
  };
  console.debug('[_shared-v2] helpers + stableSearch + joost helpers registered');
})();
