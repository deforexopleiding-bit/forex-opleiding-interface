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

  // ── Focus-bewaring uitgebreid: gewone velden met data-kv-focus-key ─────
  //
  // De patch hierboven redt cursor én waarde van zoekvelden door de DOM-node
  // zelf te bewaren en na de render terug te hangen. Dat kan niet voor velden
  // die als HTML-string uit een view komen: die node bestaat na de render niet
  // meer. Voor die velden bewaren we wat er wél te bewaren valt — welk veld
  // focus had, waar de cursor stond, en hoe ver het venster eromheen gescrold
  // was. De waarde hoeft hier niet bewaard te worden: die staat al in de
  // view-state en komt via het value-attribuut vanzelf terug.
  //
  // Een view meldt een veld aan door het een `data-kv-focus-key` te geven met
  // een waarde die de render overleeft (bv. het deelnemer-id erin verwerkt).
  //
  // Waarom dit nodig is: het venster "Event afronden" hertekent volledig bij
  // elke statuswissel. Stond je op dat moment in het notitieveld van een
  // follow-up, dan was je cursor weg en sprong het venster terug naar boven.
  function scrollOuder(el) {
    for (let p = el && el.parentElement; p; p = p.parentElement) {
      let ov;
      try { ov = getComputedStyle(p).overflowY; } catch (_) { return null; }
      if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }
  function snapshotFocusVeld() {
    const el = document.activeElement;
    if (!el || typeof el.getAttribute !== 'function') return null;
    const key = el.getAttribute('data-kv-focus-key');
    if (!key) return null;
    let start = null, end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch (_) { /* niet elk input-type kent selectie */ }
    const sc = scrollOuder(el);
    return { key, start, end, scrollTop: sc ? sc.scrollTop : null };
  }
  function restoreFocusVeld(snap) {
    if (!snap) return;
    const el = document.querySelector('[data-kv-focus-key="' + snap.key.replace(/"/g, '\\"') + '"]');
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
      if (snap.start != null && snap.end != null && typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(snap.start, snap.end); } catch (_) { /* type=date e.d. gooit hierop */ }
      }
      if (snap.scrollTop != null) {
        const sc = scrollOuder(el);
        if (sc) sc.scrollTop = snap.scrollTop;
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
      const veld = snapshotFocusVeld();
      detachSearchWrapsBeforeRender();
      const result = orig.apply(this, arguments);
      hydrateSearchMounts();
      restoreFocusedSearch(snap);
      restoreFocusVeld(veld);
      vergeetVuilAlsGeenVensterOpen();
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

  // ── Chat-media renderer + emoji picker (Ronde-18: image-thumbnails +
  // emoji-support voor alle inbox/gesprekken-renderers).
  //
  // renderChatBody(m, esc?)
  //   Retourneert HTML voor de body van een chat-message. Herkent:
  //     - m.meta.media_url + media_type='image' (of body='[image]' + url) → <img>
  //     - m.meta.media_url + andere types                                → download-link
  //     - Anders: escaped body-tekst (emoji UTF-8 renderen native OK)
  //   esc = optionele escape-fn (fallback: minimale HTML-escape).
  function renderChatBody(m, escFn) {
    const _esc = escFn || ((s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const meta = m && m.meta || {};
    const mediaUrl  = meta.media_url || null;
    const mediaType = String(meta.media_type || '').toLowerCase();
    const bodyRaw   = String(m && m.body || '');
    // BP3 v4 (2026-09-02) — WhatsApp/IG reactie-berichten worden ingest als
    // '[reaction] {"message_id":"…","emoji":"👍"}'. Toon compact "Reageerde
    // met <emoji>" i.p.v. rauwe JSON. Fallback: raw text bij parse-error.
    if (/^\s*\[reaction\]\s*\{/.test(bodyRaw)) {
      try {
        const parsed = JSON.parse(bodyRaw.replace(/^\s*\[reaction\]\s*/, ''));
        if (parsed && typeof parsed.emoji === 'string' && parsed.emoji) {
          return `<span style="font-style:italic;opacity:.85">Reageerde met <span style="font-style:normal;font-size:1.15em">${_esc(parsed.emoji)}</span></span>`;
        }
      } catch (_) { /* fail-soft → raw hieronder */ }
    }
    // Placeholder-detectie: backend genereert [image]/[video]/[document] als
    // body leeg is. Als er ook een media_url is → gebruik die ipv de tekst.
    const isPlaceholder = /^\[(image|video|audio|voice|document|sticker|file)\]$/i.test(bodyRaw.trim());
    if (mediaUrl && (mediaType.startsWith('image') || (isPlaceholder && /image/i.test(bodyRaw)))) {
      const caption = isPlaceholder ? '' : bodyRaw;
      return `<a href="${_esc(mediaUrl)}" target="_blank" rel="noopener" style="display:block;line-height:0">
          <img src="${_esc(mediaUrl)}" alt="afbeelding" loading="lazy" style="display:block;max-width:240px;max-height:240px;border-radius:8px;cursor:zoom-in"
               onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'[afbeelding kon niet geladen worden]',style:'font-style:italic;opacity:.7;font-size:12px'}))"/>
        </a>${caption ? `<div style="margin-top:6px;white-space:pre-wrap">${_esc(caption)}</div>` : ''}`;
    }
    if (mediaUrl) {
      const label = mediaType || 'bestand';
      return `<a href="${_esc(mediaUrl)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:6px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;text-decoration:none;color:var(--text-1)">
        📎 <span>${_esc(label)}</span></a>${bodyRaw && !isPlaceholder ? `<div style="margin-top:4px;white-space:pre-wrap">${_esc(bodyRaw)}</div>` : ''}`;
    }
    if (isPlaceholder) {
      // Backend placeholder ZONDER media_url = ingestion-gat. Toon nette
      // waarschuwing, geen [image]-tekst die verwart.
      return `<span style="font-style:italic;opacity:.7;font-size:12px">🖼 ${_esc(bodyRaw.replace(/[\[\]]/g,''))} (media niet beschikbaar)</span>`;
    }
    return _esc(bodyRaw || '');
  }

  // ── Chat-thread renderer (2026-08-30: shared moderne compacte chat-look)
  //
  // renderChatThread(items, opts)
  //   Input items[] — normalized shape:
  //     { id, direction: 'inbound'|'outbound', channel: 'whatsapp'|'mail',
  //       body, subject, at (ISO), template_name?, meta? }
  //   meta (optioneel):
  //     { status: 'queued'|'sent'|'delivered'|'read'|'failed',
  //       failed_reason, by_simone, from_name, attachments[] }
  //
  //   Opts (allemaal optioneel):
  //     maxWidthPct   default 72
  //     bubbleFontPx  default 13.5
  //     groupGapPx    default 12
  //     stackGapPx    default 3
  //     escFn         custom escape (default: minimale HTML-escape)
  //     bodyRenderer  custom body renderer(m, escFn)→html (default: renderChatBody)
  //
  //   Groepeert opeenvolgende berichten van dezelfde (direction+channel)
  //   binnen 5 min. Dag-scheider chip bij dag-wissel. Kleuren via CRM-tokens
  //   (surface-2, brand-soft, brand, text-1, text-3, emerald, blue, rose).
  //   Dark-mode-safe: geen hardcoded hexes voor kleuren (fallbacks alleen).
  //
  //   Behoud van functionaliteit blijft aan de caller:
  //     - data-msg-id blijft op elk item (voor mark-read / append-tracking)
  //     - scroll-management gebeurt in de caller (paint-function)
  //     - loading/error-states worden buiten deze functie gerendered
  const _CHAT_DAY = (t) => {
    const d = new Date(t);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  const _CHAT_REL_DAY = (t) => {
    const d = new Date(t); const n = new Date();
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const dDay  = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff  = Math.round((today - dDay) / 86400000);
    if (diff === 0) return 'Vandaag';
    if (diff === 1) return 'Gisteren';
    if (diff > 1 && diff < 7) return `${diff} dagen geleden`;
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  };
  const _CHAT_HHMM = (t) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  function _chatEscDefault(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function _chatStatusIcon(status) {
    switch (String(status || '').toLowerCase()) {
      case 'read':      return '<span style="color:var(--brand)">✓✓</span>';
      case 'delivered': return '✓✓';
      case 'sent':      return '✓';
      case 'queued':    return '<span title="In wachtrij" style="opacity:.55">⏳</span>';
      case 'failed':    return '<span title="Mislukt" style="color:var(--rose)">⚠</span>';
      default:          return '✓✓';
    }
  }
  function renderChatThread(items, opts) {
    if (!Array.isArray(items) || !items.length) return '';
    const o = opts || {};
    const maxW    = o.maxWidthPct   != null ? o.maxWidthPct   : 72;
    const fontPx  = o.bubbleFontPx  != null ? o.bubbleFontPx  : 13.5;
    const groupGap = o.groupGapPx   != null ? o.groupGapPx    : 12;
    const stackGap = o.stackGapPx   != null ? o.stackGapPx    : 3;
    const esc     = o.escFn || _chatEscDefault;
    const bodyRenderer = o.bodyRenderer || renderChatBody;

    // 1) Groepeer opeenvolgend per (direction+channel), split bij >5 min gap.
    const enriched = items.map(m => ({
      ...m,
      channel: (m.channel === 'mail' || m.channel === 'email') ? 'mail' : 'whatsapp',
      direction: (m.direction === 'outbound' || m.direction === 'out') ? 'outbound' : 'inbound',
      _t: m.at ? new Date(m.at).getTime() : 0,
    }));
    const groups = [];
    let cur = null;
    for (const m of enriched) {
      const key = `${m.direction}:${m.channel}`;
      const gap = cur ? (m._t - cur.lastT) : Infinity;
      if (!cur || cur.key !== key || gap > 5 * 60 * 1000) {
        cur = { key, direction: m.direction, channel: m.channel, items: [m], lastT: m._t };
        groups.push(cur);
      } else {
        cur.items.push(m);
        cur.lastT = m._t;
      }
    }

    // 2) Emit met dag-scheiders bij dag-wissel.
    const out = [];
    let lastDay = null;
    for (const g of groups) {
      const firstT = g.items[0]._t;
      const dayKey = firstT ? _CHAT_DAY(firstT) : null;
      if (dayKey && dayKey !== lastDay) {
        out.push(`<div style="text-align:center;margin:14px 0 8px">
          <span style="display:inline-block;padding:3px 10px;border-radius:12px;background:var(--surface-2);color:var(--text-3);font-size:10.5px;font-weight:600;letter-spacing:.02em">${esc(_CHAT_REL_DAY(firstT))}</span>
        </div>`);
        lastDay = dayKey;
      }
      out.push(_chatRenderGroup(g, { maxW, fontPx, groupGap, stackGap, esc, bodyRenderer }));
    }
    return out.join('');
  }
  function _chatRenderGroup(g, cfg) {
    const { maxW, fontPx, groupGap, stackGap, esc, bodyRenderer } = cfg;
    const isOut = g.direction === 'outbound';
    const align = isOut ? 'right' : 'left';
    const bg    = isOut ? 'var(--brand-soft, #E2F1F5)' : 'var(--surface-2)';
    const color = isOut ? 'var(--brand, #0A7490)' : 'var(--text-1)';
    const bubbles = g.items.map((m, i) => {
      const isLast = i === g.items.length - 1;
      let radius = '16px';
      if (isLast) radius = isOut ? '16px 16px 4px 16px' : '16px 16px 16px 4px';
      const meta = m.meta || {};
      // Header-chips binnen bubble: Simone (AI), template-tag, mail-subject.
      const simoneChip = meta.by_simone
        ? `<div style="font-size:10px;font-weight:600;opacity:.7;margin-bottom:4px;color:var(--brand)">✦ Simone · AI</div>`
        : '';
      const tplTag = (isOut && (m.template_name || meta.template_name))
        ? `<div style="font-size:10px;font-weight:600;opacity:.65;margin-bottom:4px;letter-spacing:.02em">Sjabloon · ${esc(m.template_name || meta.template_name)}</div>`
        : '';
      const subjHtml = (m.channel === 'mail' && (m.subject || meta.subject))
        ? `<div style="font-weight:600;font-size:12.5px;margin-bottom:3px">${esc(m.subject || meta.subject)}</div>`
        : '';
      const fromHtml = (m.channel === 'mail' && meta.from_name)
        ? `<div style="font-size:11px;opacity:.65;margin-bottom:4px">${isOut ? 'aan' : 'van'}: ${esc(meta.from_name)}</div>`
        : '';
      const mediaOrText = bodyRenderer(m, esc);
      const bodyHtml = mediaOrText
        ? `<div style="white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere">${mediaOrText}</div>`
        : `<div style="opacity:.55">(leeg bericht)</div>`;
      const attCount = Array.isArray(meta.attachments) ? meta.attachments.length : 0;
      const attHtml = attCount > 0
        ? `<div style="margin-top:5px;font-size:11px;opacity:.65">📎 ${attCount} bijlage(n)</div>`
        : '';
      const failedHtml = meta.failed_reason
        ? `<div style="margin-top:5px;font-size:10.5px;color:var(--rose);opacity:.9">⚠ ${esc(String(meta.failed_reason).slice(0, 120))}</div>`
        : '';
      const mt = i === 0 ? '0' : `${stackGap}px`;
      return `<div data-msg-id="${esc(String(m.id != null ? m.id : ''))}" style="text-align:${align};margin-top:${mt}">
        <span style="display:inline-block;text-align:left;max-width:${maxW}%;padding:8px 12px;background:${bg};color:${color};border-radius:${radius};font-size:${fontPx}px;line-height:1.45;vertical-align:top;box-shadow:0 1px 1px rgba(0,0,0,.04)">${simoneChip}${tplTag}${subjHtml}${fromHtml}${bodyHtml}${attHtml}${failedHtml}</span>
      </div>`;
    }).join('');
    // Footer: kanaal-label + tijd (+ status-icoon outbound) — 1× per groep.
    const last = g.items[g.items.length - 1];
    const tijd = last._t ? _CHAT_HHMM(last._t) : '';
    const chanTxt = g.channel === 'mail' ? 'E-mail' : 'WhatsApp';
    const dot = g.channel === 'mail'
      ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--blue, #3b82f6);margin-right:5px;vertical-align:middle"></span>`
      : `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--emerald, #10b981);margin-right:5px;vertical-align:middle"></span>`;
    const receipt = isOut
      ? `<span style="margin-left:6px;opacity:.7;font-size:11px" title="Bezorging">${_chatStatusIcon(last.meta && last.meta.status)}</span>`
      : '';
    const footer = `<div style="text-align:${align};margin-top:4px;font-size:10.5px;color:var(--text-3);line-height:1;padding:0 4px">
      <span style="display:inline-flex;align-items:center;gap:0">${dot}<span style="font-weight:500">${esc(chanTxt)}</span><span style="opacity:.5;margin:0 6px">·</span><span>${esc(tijd)}</span>${receipt}</span>
    </div>`;
    return `<div style="margin-top:${groupGap}px">${bubbles}${footer}</div>`;
  }

  // Emoji-picker — lightweight veelgebruikte set + insert-op-cursor.
  // Gebruik: attachEmojiPickerButton(buttonEl, textareaEl [, onChange])
  //          of via inline HTML: `${emojiPickerButtonHtml(textareaId)}`
  // Klik = popover met grid; klik emoji = insert bij cursor + trigger input.
  const EMOJIS_COMMON = [
    '👍','👎','😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌',
    '😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🥳',
    '🤩','🥺','😢','😭','😤','😠','😡','🤬','😳','🥵','🥶','😱','😨','😰','😥','😓',
    '🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴',
    '💤','😷','🤒','🤕','🤢','🤮','🤧','🥴','😵','🤯','🤠','🥸','😈','👿','👻','💀',
    '❤️','🧡','💛','💚','💙','💜','🤎','🖤','🤍','💔','❣️','💕','💞','💓','💗','💖',
    '🙏','👏','🤝','🙌','👐','🤲','🤞','✌️','🤟','🤘','👌','🤌','🤏','👈','👉','👆',
    '👇','☝️','✋','🤚','🖐️','🖖','👋','🤙','💪','🦾','🖕','✍️','🙋','🤦','🤷','💁',
    '🎉','🎊','🎁','🎂','🎈','🎀','🥂','🍾','🍰','🍕','☕','🍺','🍻','🥤','🍫','🍪',
    '⭐','🌟','✨','⚡','🔥','💥','💫','🌈','☀️','🌙','☁️','⛅','🌧️','⛈️','🌨️','❄️',
    '✅','☑️','✔️','❌','⭕','❗','❓','⁉️','❕','❔','💯','🆗','🆕','🆒','🔔','🔕',
    '📞','📱','💻','⏰','📅','📆','📌','📍','📎','🔗','💰','💳','💸','🧾','📊','📈',
  ];
  function emojiPickerButtonHtml(textareaId, label) {
    const btnLabel = label || '😊';
    return `<button type="button" class="btn btn-ghost btn-sm" data-emoji-picker-for="${textareaId}"
      style="font-size:13px;padding:4px 9px" title="Emoji invoegen">${btnLabel}</button>`;
  }
  // Live delegation via document-level click. Idempotent: dubbele attach niet mogelijk.
  if (!window.__kvEmojiDelegated) {
    window.__kvEmojiDelegated = true;
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-emoji-picker-for]');
      if (b) {
        e.preventDefault();
        e.stopPropagation();
        _openEmojiPopover(b, b.getAttribute('data-emoji-picker-for'));
      } else {
        // Klik buiten popover → sluit.
        const pop = document.getElementById('kv-emoji-pop');
        if (pop && !pop.contains(e.target)) pop.remove();
      }
    });
  }
  function _openEmojiPopover(anchorBtn, textareaId) {
    document.getElementById('kv-emoji-pop')?.remove();
    const rect = anchorBtn.getBoundingClientRect();
    const pop = document.createElement('div');
    pop.id = 'kv-emoji-pop';
    pop.style.cssText = `position:fixed;z-index:99999;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.16);padding:8px;width:280px;max-height:240px;overflow-y:auto`;
    // Positioneer boven de knop; als geen ruimte → eronder.
    const top = rect.top - 250; // ~popover-height
    pop.style.top  = (top > 8 ? top : rect.bottom + 6) + 'px';
    pop.style.left = Math.max(6, Math.min(window.innerWidth - 290, rect.left)) + 'px';
    pop.innerHTML = EMOJIS_COMMON.map(e => `<button type="button" data-emo="${e}" style="width:28px;height:28px;border:none;background:transparent;cursor:pointer;font-size:18px;padding:0;border-radius:4px" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">${e}</button>`).join('');
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-emo]');
      if (!b) return;
      _insertAtCursor(textareaId, b.getAttribute('data-emo'));
      // Sluit niet — user kan meerdere invoegen. Sluit bij buiten-klik.
    });
    document.body.appendChild(pop);
  }
  function _insertAtCursor(textareaId, text) {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end   = ta.selectionEnd   ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after  = ta.value.slice(end);
    ta.value = before + text + after;
    const pos = start + text.length;
    ta.setSelectionRange(pos, pos);
    ta.focus();
    // Trigger native 'input'-event zodat oninput-handlers (state-sync) vuren.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ─── VENSTERS SLUITEN ALLEEN OP VERZOEK VAN DE GEBRUIKER ───────────────
  //
  // AANLEIDING. In "Event afronden" (events-v2.js) verdween het venster — met
  // alles wat erin ingevuld stond — terwijl er getypt werd. Oorzaak: de
  // donkere achtergrond sluit bij een klik, en een sleep-selectie in een
  // invoerveld die nét buiten de kaart eindigt telt voor de browser als een
  // klik op die achtergrond. Je begint in het veld, je sleept om je eigen
  // notitie te selecteren, je laat los naast de kaart, en het venster is weg.
  //
  // De `event.stopPropagation()` op de kaart helpt daar niet tegen: de klik
  // wordt op de achtergrond zélf afgeleverd en komt langs de kaart niet meer.
  // De variant `if (event.target === this)`, die 26 van de 38 vensters in deze
  // repo gebruiken, helpt er evenmin tegen — in dit geval ís de achtergrond
  // het doelwit, dus de voorwaarde klopt en het venster sluit alsnog.
  // Allebei nagemeten in een kale testpagina met exact deze opmaak.
  //
  // DE REGEL IS NU: een venster sluit alleen als de gebruiker dat zegt — het
  // kruisje of Annuleren. De achtergrond sluit nooit meer. Escape sluit
  // alleen zolang er niets is ingevuld sinds het venster openging.
  //
  // WAAROM HIER, EN NIET IN ELK VENSTER APART. Elk van de 38 vensters heeft
  // zijn eigen inline onclick op de achtergrond, verspreid over ruim twintig
  // bestanden. Eén luisteraar in de vangfase op document vangt ze allemaal
  // tegelijk — inclusief de abonnementen-wizard (.sw-modal-back), het gedeelde
  // venster uit app-shell (.mdl) en elk venster dat er later bij komt.
  // Vangfase op document betekent dat de gebeurtenis stilgezet wordt vóór ze
  // bij de achtergrond aankomt, dus de inline onclick draait niet meer.
  //
  // DEKKING. Dit bestand wordt alleen geladen door modules/klanten-v2/
  // index.html. De losse oudere schermen (modules/finance.html, events.html,
  // sales.html, admin*.html en de andere stand-alone pagina's) laden het niet
  // en houden hun oude gedrag. Zie de PR-tekst voor die lijst.

  /* Herkennen van een venster-achtergrond gebeurt in twee stappen. Eerst een
     goedkope tekstcontrole op het style-attribuut en de klassenaam — die kost
     geen layout en mag daarom bij elke toetsaanslag draaien. Pas als die
     aanslaat volgt de dure controle (computed style + afmetingen). */
  const ACHTERGROND_KLASSEN = /(^|\s)(mdl|sw-modal-back|ev-modal-backdrop|agv-portal|ld-modal-scrim|cdm-scrim|ev-portal)(\s|$)/;
  /* De navigatie-sluier is géén venster: die hóórt te sluiten bij een klik,
     en er staat niets in dat je kwijt kunt raken. */
  const GEEN_VENSTER_IDS = ['scrim'];

  function lijktAchtergrond(el) {
    if (!el || el.nodeType !== 1) return false;
    const st = typeof el.getAttribute === 'function' ? el.getAttribute('style') : null;
    if (st && st.indexOf('inset:0') >= 0 && st.indexOf('position:fixed') >= 0) return true;
    const cls = typeof el.className === 'string' ? el.className : '';
    return ACHTERGROND_KLASSEN.test(cls);
  }
  function isVensterAchtergrond(el) {
    if (!lijktAchtergrond(el)) return false;
    if (GEEN_VENSTER_IDS.indexOf(el.id) >= 0) return false;
    // Een achtergrond draagt altijd een kaart. Een lege fixed laag is iets
    // anders (sluier, toast-laag) en laten we met rust.
    if (!el.firstElementChild) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch (_) { return false; }
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.top <= 1 && r.left <= 1
        && r.width  >= window.innerWidth  - 2
        && r.height >= window.innerHeight - 2;
  }

  /* 1. De achtergrond sluit niet meer. */
  document.addEventListener('click', (ev) => {
    if (!isVensterAchtergrond(ev.target)) return;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  /* 2. Escape sluit alleen als er niets is ingevuld sinds het venster openging.
        "Ingevuld" wordt op twee manieren vastgesteld: deze laag ziet elke
        input/change binnen een venster, en een view mag daarnaast zijn eigen
        test aanmelden voor invoer die niet via een invoerveld loopt (in
        "Event afronden" bv. de statusknoppen Aanwezig / No-show / Afgemeld).
        Bewust géén bevestigingsvenster: dat zou een tweede venster zijn om
        een venster te sluiten. */
  let vensterVuil = false;
  const VUIL_CHECKS = [];

  function registreerVuilCheck(fn) {
    if (typeof fn === 'function' && VUIL_CHECKS.indexOf(fn) < 0) VUIL_CHECKS.push(fn);
  }
  function vensterIsVuil() {
    if (vensterVuil) return true;
    for (let i = 0; i < VUIL_CHECKS.length; i++) {
      try { if (VUIL_CHECKS[i]()) return true; } catch (_) { /* een kapotte test mag Escape niet blokkeren */ }
    }
    return false;
  }
  function markeerVuil(ev) {
    if (vensterVuil) return;
    for (let el = ev.target; el && el !== document.body; el = el.parentElement) {
      if (lijktAchtergrond(el)) { vensterVuil = true; return; }
    }
  }
  document.addEventListener('input',  markeerVuil, true);
  document.addEventListener('change', markeerVuil, true);

  /* Staat er geen venster meer open, dan begint de volgende schoon. Dit draait
     mee in de render-patch hierboven, want elk sluiten loopt via DFO.render(). */
  function vergeetVuilAlsGeenVensterOpen() {
    if (!vensterVuil) return;
    const kandidaten = document.querySelectorAll(
      '[style*="inset:0"],.mdl,.sw-modal-back,.ev-modal-backdrop,.agv-portal,.ld-modal-scrim,.cdm-scrim,.ev-portal');
    for (let i = 0; i < kandidaten.length; i++) {
      if (isVensterAchtergrond(kandidaten[i])) return;
    }
    vensterVuil = false;
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!vensterIsVuil()) return;   // niets ingevuld → Escape mag gewoon sluiten
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  // ─── DE ELF BEZWAREN — één lijst voor het hele CRM ─────────────────────
  //
  // Deze lijst zat in followup-v2.js en werd daar gebruikt bij het afronden
  // van een belgesprek. Sinds stap 2 vraagt ook het afrondscherm van een event
  // ernaar, zodra iemand "Geen interesse" kiest. Twee lijsten die uit elkaar
  // lopen leveren twee rapportages op die niet op te tellen zijn, dus staat
  // hij vanaf nu hier en leest followup-v2.js hem hiervandaan.
  //
  // De serverkant heeft zijn eigen kopie in api/_lib/bezwaren.js — een
  // klassiek script en een ES-module kunnen geen bestand delen. Die twee
  // worden gelijk gehouden door tests/bezwaren-lijst-gelijk.test.js, die dit
  // bestand als tekst leest en rood wordt zodra ze afwijken.
  //
  // Volgorde is betekenisvol: zo staan ze op het scherm.
  const BEZWAREN = [
    'Te duur', 'Geen tijd', 'Moet overleggen', 'Al bij andere partij',
    'Wil eerst resultaten zien', 'Twijfelt over online', 'Geen vertrouwen',
    'Wil eerst zelf proberen', 'Slecht moment', 'Geen budget nu', 'Anders',
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // BP3 v6 (2026-09-02) — GEDEELDE TEMPLATES-PICKER
  //
  // Één modal, gebruikt in WhatsApp-composer (leadsonderhoud), IG-composer
  // (lisa) en mail-composer (leadsonderhoud). Filtert op categorie + zoekterm.
  // Klik voegt de body-tekst in via callback. Placeholders {voornaam}/{naam}
  // worden client-side resolved uit `contactName`.
  //
  // openTemplatePicker({
  //   contactName?: string,        // voor {voornaam}/{naam}-resolve
  //   onInsert: (bodyText) => void, // callback met resolved tekst
  //   channelLabel?: string,       // klein UI-label ("WhatsApp"/"E-mail"/"Instagram")
  // })
  // ═══════════════════════════════════════════════════════════════════════
  const _tplState = { items: null, categories: null, loading: false, error: null, fetchedAt: 0 };

  async function _tplFetch() {
    if (_tplState.items && (Date.now() - _tplState.fetchedAt) < 60 * 1000 && !_tplState.error) return _tplState;
    if (_tplState.loading) return _tplState;
    _tplState.loading = true; _tplState.error = null;
    try {
      const r = await window.KV.authedFetch('/api/wa-snippets-list');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      _tplState.items = Array.isArray(j.items) ? j.items : [];
      _tplState.categories = Array.isArray(j.categories) ? j.categories : [];
      _tplState.fetchedAt = Date.now();
    } catch (e) {
      _tplState.error = e?.message || 'Kon templates niet laden';
      if (!_tplState.items) _tplState.items = [];
      if (!_tplState.categories) _tplState.categories = [];
    } finally {
      _tplState.loading = false;
    }
    return _tplState;
  }

  function _tplResolve(body, contactName) {
    const name  = String(contactName || '').trim();
    const first = name.split(/\s+/)[0] || '';
    return String(body || '')
      .replace(/\{voornaam\}/g, first || 'daar')
      .replace(/\{naam\}/g, name || 'daar');
  }

  function _tplEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }

  async function openTemplatePicker(opts) {
    const options = opts || {};
    const contactName  = options.contactName || '';
    const onInsert     = typeof options.onInsert === 'function' ? options.onInsert : null;
    const channelLabel = options.channelLabel || '';
    if (!onInsert) { console.warn('[templates-picker] onInsert-callback vereist'); return; }

    // State voor deze picker-instance.
    let selectedCategory = ''; // '' = alle
    let searchTerm       = '';

    // Modal-root
    const existing = document.getElementById('kvTemplatePicker');
    if (existing) existing.remove();
    const root = document.createElement('div');
    root.id = 'kvTemplatePicker';
    root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
    root.addEventListener('click', (ev) => { if (ev.target === root) closeModal(); });
    document.body.appendChild(root);

    function closeModal() { if (root.parentNode) root.parentNode.removeChild(root); }

    function paint(state) {
      const items = state.items || [];
      const cats  = state.categories || [];
      const filtered = items.filter((it) => {
        if (selectedCategory && String(it.category || '') !== selectedCategory) return false;
        if (searchTerm) {
          const q = searchTerm.toLowerCase();
          const hay = ((it.titel || '') + ' ' + (it.body_text || '') + ' ' + (it.category || '')).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      // Groepeer per categorie voor de weergave.
      const grouped = new Map();
      for (const it of filtered) {
        const key = it.category && String(it.category).trim() ? String(it.category) : '(zonder categorie)';
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(it);
      }
      const groupsHtml = grouped.size > 0
        ? [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0], 'nl')).map(([cat, arr]) => `
            <div style="margin-bottom:14px">
              <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${_tplEsc(cat)}</div>
              ${arr.map((it) => `
                <button data-tpl-id="${_tplEsc(String(it.id))}"
                  style="display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;font-family:inherit;color:var(--text-1)">
                  <div style="font-size:12.5px;font-weight:600;margin-bottom:2px">${_tplEsc(it.titel || '')}${it.is_mine ? '' : ' <span style="font-size:10px;color:var(--text-3);font-weight:400">(gedeeld)</span>'}</div>
                  <div style="font-size:11.5px;color:var(--text-2);white-space:pre-wrap;line-height:1.35;overflow:hidden;text-overflow:ellipsis;max-height:60px">${_tplEsc(String(it.body_text || '').slice(0, 220))}</div>
                </button>
              `).join('')}
            </div>
          `).join('')
        : `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Geen templates die matchen.</div>`;

      const chipAlle = `<button data-tpl-cat="" class="chip ${!selectedCategory ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px">Alle</button>`;
      const chipCats = cats.map((c) => `<button data-tpl-cat="${_tplEsc(c)}" class="chip ${selectedCategory === c ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px">${_tplEsc(c)}</button>`).join(' ');

      root.innerHTML = `<div style="background:var(--surface);border-radius:var(--r);padding:16px 18px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.35)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
          <div style="font-size:15px;font-weight:600">Kies template${channelLabel ? ' · ' + _tplEsc(channelLabel) : ''}</div>
          <button data-tpl-close="1" style="background:transparent;border:0;font-size:20px;cursor:pointer;color:var(--text-3);padding:0 4px" title="Sluiten">×</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Klik om in te voegen in het bericht. Placeholders {voornaam} en {naam} worden automatisch gevuld.</div>
        <input id="kvTplSearch" type="search" placeholder="Zoek in titel of tekst…" value="${_tplEsc(searchTerm)}"
          style="padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12.5px;margin-bottom:8px" />
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:10px">${chipAlle}${chipCats}</div>
        ${state.loading ? `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Laden…</div>` : ''}
        ${state.error ? `<div style="padding:10px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12px;margin-bottom:10px">⚠ ${_tplEsc(state.error)}</div>` : ''}
        <div style="flex:1;overflow-y:auto;min-height:0">${state.loading && !items.length ? '' : groupsHtml}</div>
      </div>`;

      // Event handlers
      root.querySelectorAll('[data-tpl-close]').forEach((el) => el.addEventListener('click', closeModal));
      root.querySelectorAll('[data-tpl-cat]').forEach((el) => el.addEventListener('click', () => {
        selectedCategory = el.getAttribute('data-tpl-cat');
        paint(_tplState);
      }));
      const searchEl = root.querySelector('#kvTplSearch');
      if (searchEl) {
        searchEl.addEventListener('input', (e) => {
          searchTerm = e.target.value || '';
          paint(_tplState);
          // Refocus zonder rerender-jump.
          const s = root.querySelector('#kvTplSearch');
          if (s) { s.focus(); s.setSelectionRange(searchTerm.length, searchTerm.length); }
        });
      }
      root.querySelectorAll('[data-tpl-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-tpl-id');
          const it = items.find((x) => String(x.id) === String(id));
          if (!it) return;
          const resolved = _tplResolve(it.body_text, contactName);
          try { onInsert(resolved); } catch (e) { console.warn('[templates-picker] onInsert threw:', e?.message || e); }
          closeModal();
        });
      });
    }

    // Toon eerst de placeholder-state (loading spinner) — dan fetchen.
    paint({ items: [], categories: [], loading: true, error: null });
    const st = await _tplFetch();
    paint(st);
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
    // Ronde 18: chat-media + emoji-picker.
    renderChatBody, emojiPickerButtonHtml,
    // 2026-08-30: shared moderne chat-thread renderer (Leadsonderhoud pattern
    // uitgerold naar Events / Onboarding / Inbox). Caller doet paint/scroll,
    // deze functie produceert alleen HTML.
    renderChatThread,
    // De elf bezwaren — gedeeld door de Follow-up-module en het afrondscherm
    // van een event. Zie het blok hierboven.
    BEZWAREN,
    // Vensters sluiten alleen op verzoek: een view meldt hier zijn eigen
    // "is er iets ingevuld"-test aan voor invoer die niet via een invoerveld
    // loopt (knoppen, chips). Zie het blok hierboven.
    registreerVuilCheck,
    // BP3 v6 (2026-09-02): gedeelde templates-picker (WA + IG + mail).
    openTemplatePicker,
  };
  console.debug('[_shared-v2] helpers + stableSearch + joost helpers registered');
})();
