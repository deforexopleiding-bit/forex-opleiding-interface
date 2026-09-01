// modules/klanten-v2/views/leadsonderhoud-v2.js
//
// Leadsonderhoud v2 — v=14 (2026-08-17): Bulk-tab verwijderd (feature geschrapt).
// Scope: lead-relatie-werkplek. Config (trajecten/sjablonen/quiz) blijft in
// Automatiseringen. Bulk / Gesprekken (writes) komen in BROK 2.
//
// Tab-set:
//   Overzicht      — trial-warmte KPIs + call-booking-KPI + regels-kaart
//   Contacten      — ALLE leads (leads_overzicht view) met warmte-score +
//                    call-status ("Call geboekt/Niet geboekt") + filters
//                    op traject + call-status + zoek
//   Wachtrij       — welke leads komen bij volgende drip-ronde aan de beurt
//   Gesprekken     — lead-gesleutelde inbox (WA + mail) via -gesprekken-endpoints
//   Statistieken   — geleide KPIs uit leads-list + berichten-log counts
// (Bulk versturen tab is v=14 geschrapt — feature-verwijderd. Backend-
//  endpoints + cron blijven onbereikbaar staan; cron-entry verwijderd
//  uit vercel.json.)
//
// Endpoints (allemaal RBAC leads.view):
//   Overzicht : GET /api/leadsonderhoud-overzicht        (trial_warmte + laatste_contact)
//               GET /api/leadsonderhoud-droogloop-log    (laatste 7d droog-berichten)
//               GET /api/leads-list?limit=1              (totalen + counts uit leads_overzicht)
//               GET /api/leads-list?afspraak=ja&limit=1  (call-geboekt KPI)
//   Contacten : GET /api/leads-list?limit=500&…filters   (ALLE trajecten samen)
//   Wachtrij  : GET /api/leadsonderhoud-wachtrij         (onderhoud_wachtrij view)
//   Stats     : hergebruikt Overzicht-fetches + optionele extra count-calls
//
// Dashboard-veiligheid: skeleton, 8s tryFetch-timeout, per-tab try/catch,
// _fetched-guard tegen render-loops.
//
// Dormant — 'leadsonderhoud' NIET in V2_ACTIVE_ALLOWLIST. Protected zone leeg.

(function () {
  if (!window.DFO) { console.error('[ls-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[ls-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;
  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ── State (dashboard-pattern per fetch) ────────────────────────────── */
  // BROK 1 bug A fix: elk state-object heeft z'n eigen _seq. Één globale
  // teller sloopt parallelle fetches naar verschillende endpoints — een
  // fetch die later start bumpt de globale teller en de eerder-gestarte
  // fetch krijgt onterecht de stale-guard en droppt zijn eigen respons.
  // Per-target _seq laat alleen herstart van DEZELFDE fetcher de vorige
  // in-flight respons droppen — parallel-veilig.
  const _live = {
    overzicht:    { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    droogloop:    { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    wachtrij:     { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    leadsAll:     { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    leadsMet:     { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    contacten:    { loading: false, fetched: false, error: null, data: null, lastKey: null, _seq: 0 },
    // v=21: access-map per lead_id → 'YYYY-MM-DD' | null. Lazy gevuld per
    // batch zodra contactenView een lijst rendert. lastKey = leadIds-signature
    // om dubbele fetches te voorkomen.
    access:       { loading: false, fetched: false, map: {}, lastKey: null },
    // v=15 (2026-08-27): Opstartsessie-tabs. Read-only rendering; CRUD gebeurt
    // in de v1-editor (/modules/leadsonderhoud.html) die via directe URL
    // bereikbaar blijft. Filter-state per tab (periode/resultaat/bron) leeft
    // apart zodat we bij tab-switch niet refetchen.
    bronnen:        { loading: false, fetched: false, error: null, data: null, _seq: 0, periode: 'alles', lastKey: null },
    opstartsessies: { loading: false, fetched: false, error: null, data: null, _seq: 0, periode: 'alles', resultaat: 'alle', bron: '', lastKey: null },
    vragenlijst:    { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    // v=17 (2026-08-28): Toegang-aanvragen tab (WhatsApp-gate).
    toegangAanvragen: { loading: false, fetched: false, error: null, data: null, _seq: 0,
                        status: 'alle', soort: 'alle', periode: 'alles', lastKey: null },
  };

  /* ── tryFetch (8s timeout, non-throwing) ────────────────────────────── */
  async function tryFetch(label, url, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[ls-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  /* ── Individuele fetchers (guards tegen render-loop) ─────────────────── */
  async function fetchOverzicht() {
    const st = _live.overzicht; if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('overzicht', '/api/leadsonderhoud-overzicht');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon overzicht niet laden'; else st.data = { items: asArr(j.items), totaal: j.totaal || 0 };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchDroogloop() {
    const st = _live.droogloop; if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('droogloop', '/api/leadsonderhoud-droogloop-log');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon droogloop niet laden'; else st.data = { items: asArr(j.items), totaal: j.totaal || 0 };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchWachtrij() {
    const st = _live.wachtrij; if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('wachtrij', '/api/leadsonderhoud-wachtrij');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon wachtrij niet laden'; else st.data = { items: asArr(j.items), totaal: j.totaal || 0 };
    if (window.DFO?.render) window.DFO.render();
  }
  // Twee count-calls voor Overzicht/Stats: totaal + met-afspraak.
  // Elk eigen state → elk eigen _seq → parallel-veilig.
  async function fetchLeadCounts() {
    const st = _live.leadsAll; if (!(st.loading || (st.fetched && !st.error))) {
      st.loading = true; st.error = null;
      const seq = ++st._seq;
      const j = await tryFetch('leads-all', '/api/leads-list?limit=1');
      if (seq === st._seq) {
        st.loading = false; st.fetched = true;
        if (!j) st.error = 'Kon leads-tellingen niet laden'; else st.data = { total: Number(j.total || 0) };
        if (window.DFO?.render) window.DFO.render();
      }
    }
    const st2 = _live.leadsMet; if (!(st2.loading || (st2.fetched && !st2.error))) {
      st2.loading = true; st2.error = null;
      const seq = ++st2._seq;
      const j2 = await tryFetch('leads-met', '/api/leads-list?limit=1&afspraak=ja');
      if (seq === st2._seq) {
        st2.loading = false; st2.fetched = true;
        if (!j2) st2.error = 'Kon call-teller niet laden'; else st2.data = { total: Number(j2.total || 0) };
        if (window.DFO?.render) window.DFO.render();
      }
    }
  }
  // v=21: batch-fetch toegang-tot voor de zichtbare contacten. Signatuur op
  // basis van sorted lead_ids voorkomt dubbele fetches als de lijst gelijk is.
  // Fail-soft: bij fout blijft map leeg, UI toont "—" (geen crash).
  async function fetchAccessBatch(leadIds) {
    if (!Array.isArray(leadIds) || !leadIds.length) return;
    const key = leadIds.slice().sort().join(',');
    if (_live.access.loading) return;
    if (_live.access.lastKey === key && _live.access.fetched) return;
    _live.access.loading = true;
    try {
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-access-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_ids: leadIds }),
      });
      const j = await resp.json().catch(() => ({}));
      if (resp.ok && j && j.access) {
        _live.access.map = { ..._live.access.map, ...j.access };
        _live.access.lastKey = key;
        _live.access.fetched = true;
      }
    } catch (e) {
      console.warn('[ls-v2] access-batch fail:', e?.message);
    } finally {
      _live.access.loading = false;
      if (window.DFO?.render) window.DFO.render();
    }
  }
  // v=23: accepteert nu een access-object uit trial_warmte (of null).
  // Legacy string-input blijft werken (backward-compat voor caches).
  function fmtToegangTot(entry) {
    if (!entry) return '<span style="color:var(--text-3);font-size:11.5px">Geen toegang</span>';
    // Legacy: string (oude endpoint-shape v=1).
    const iso = (typeof entry === 'string') ? entry
              : (entry && entry.toegang_tot) ? String(entry.toegang_tot).slice(0, 10) : null;
    const verlopenFlag = (entry && typeof entry === 'object') ? !!entry.verlopen : null;
    const dagen = (entry && typeof entry === 'object' && typeof entry.dagen_over === 'number') ? entry.dagen_over : null;
    if (!iso) return '<span style="color:var(--text-3);font-size:11.5px">Geen toegang</span>';
    try {
      const dt = new Date(iso + 'T00:00:00');
      const nl = dt.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' });
      const today = new Date(); today.setHours(0,0,0,0);
      const isPast = (verlopenFlag !== null) ? verlopenFlag : (dt < today);
      const color = isPast ? 'var(--rose)' : 'var(--text-1)';
      const badge = isPast
        ? '<span style="font-size:10px;color:var(--rose);margin-left:4px">verlopen</span>'
        : (dagen != null && dagen <= 3 ? `<span style="font-size:10px;color:var(--amber);margin-left:4px">nog ${dagen}d</span>` : '');
      return `<span style="font-size:12px;color:${color}">${nl}</span>${badge}`;
    } catch (_) { return String(iso); }
  }
  // v=23: welke trajecten hebben zinvol-verlengen? 7-daagse + minicursus zijn
  // trial-grants met einddatum; event/webinar/membership niet.
  const _EXTEND_TRAJECTS = new Set(['7-daagse', '7 daagse', '7daagse', 'minicursus', 'mini cursus', 'mini-cursus']);
  function _isExtendableTraject(traject) {
    return _EXTEND_TRAJECTS.has(String(traject || '').toLowerCase().trim());
  }

  // Contacten-fetch: filter-key voorkomt refetch bij ongewijzigde filters.
  async function fetchContacten(key, url) {
    const st = _live.contacten;
    if (st.loading || st.lastKey === key) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('contacten', url);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon contacten niet laden';
    else st.data = { items: asArr(j.items), total: Number(j.total || 0), has_more: !!j.has_more };
    if (window.DFO?.render) window.DFO.render();
  }

  /* ── Hulpers voor warmte + tijd ─────────────────────────────────────── */
  function warmteMeta(score) {
    const s = Number(score || 0);
    if (s >= 15) return { label: 'warm',   color: 'rose',    tone: 'ro' };
    if (s >= 5)  return { label: 'midden', color: 'amber',   tone: 'or' };
    return           { label: 'koud',   color: 'blue',    tone: 'bl' };
  }
  function fmtDatum(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const delta = Date.now() - d.getTime();
      if (delta < 3600000)   return Math.max(1, Math.round(delta / 60000)) + 'm';
      if (delta < 86400000)  return Math.round(delta / 3600000) + 'u';
      if (delta < 7 * 86400000) return Math.round(delta / 86400000) + 'd';
      return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    } catch (_) { return '—'; }
  }
  // v=8 FIX D: absolute-datum-formatter voor afspraak_op (toekomstige data
  // krijgen anders "1m" van de relatieve formatter -> betekenisloos). Toont
  // "do 20 aug 09:00" (Europe/Amsterdam). Als tijd 00:00 = alleen datum.
  function fmtDatumAbsoluut(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const dateStr = d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/Amsterdam' });
      const timeStr = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Amsterdam' });
      // Als er echt geen tijd-info is (00:00 exact) → toon alleen de datum.
      if (timeStr === '00:00') return dateStr;
      return dateStr + ' ' + timeStr;
    } catch (_) { return '—'; }
  }
  function warmteBar(score) {
    const s = Math.max(0, Math.min(45, Number(score || 0)));
    const pct = Math.round((s / 45) * 100);
    const c = warmteMeta(s).color;
    return `<div style="display:inline-flex;align-items:center;gap:6px">
      <div style="width:60px;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden">
        <div style="width:${pct}%;height:100%;background:var(--${c})"></div>
      </div>
      <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--${c})">${s}</span>
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 1 — OVERZICHT
     ══════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(fetchOverzicht);
    if (!_live.droogloop.fetched && !_live.droogloop.loading && !_live.droogloop.error) queueMicrotask(fetchDroogloop);
    if (!_live.leadsAll.fetched && !_live.leadsAll.loading && !_live.leadsAll.error) queueMicrotask(fetchLeadCounts);

    const ov = _live.overzicht.data;
    const dr = _live.droogloop.data;
    const lAll = _live.leadsAll.data;
    const lMet = _live.leadsMet.data;

    // KPI-berekeningen (uit trial_warmte view)
    const lopend = ov ? ov.items.length : null;
    const warm   = ov ? ov.items.filter(r => Number(r.score || 0) >= 15).length : null;
    const koud   = ov ? ov.items.filter(r => Number(r.score || 0) < 5).length   : null;
    const droog7 = dr ? dr.totaal : null;
    const totalLeads = lAll ? lAll.total : null;
    const geboekt    = lMet ? lMet.total : null;
    const zonder     = (totalLeads != null && geboekt != null) ? Math.max(0, totalLeads - geboekt) : null;
    const conversie  = (totalLeads != null && geboekt != null && totalLeads > 0)
      ? Math.round((geboekt / totalLeads) * 100) : null;

    const kpiCell = (label, val, sub, color) => `
      <div class="kpi" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    const err = (msg) => `<div style="padding:12px 14px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(msg)}</div>`;

    // Kern-KPI-rij (call-booking)
    const callKpiHtml = `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px;font-weight:600">Doel: call boeken</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          ${kpiCell('Leads totaal', totalLeads, 'over alle trajecten', 'text-1')}
          ${kpiCell('Call geboekt', geboekt,    conversie != null ? conversie + '% conversie' : null, 'emerald')}
          ${kpiCell('Nog geen call', zonder,    'kandidaten voor de motor', 'amber')}
          ${kpiCell('Conversie',     conversie != null ? conversie + '%' : null, 'geboekt / totaal', 'blue')}
        </div>
      </div>`;

    // Warmte-KPIs (uit trial_warmte view)
    const warmteKpiHtml = `
      <div style="margin-bottom:14px">
        <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px;font-weight:600">Warmte-status (lopende proefperiodes)</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
          ${kpiCell('Lopende leads', lopend, 'in warmte-view', 'text-1')}
          ${kpiCell('Warm (15+)',    warm,   'zelf bellen',   'rose')}
          ${kpiCell('Koud (<5)',     koud,   'motor stuurt',  'blue')}
          ${kpiCell('Droogloop 7d',  droog7, 'niet verzonden', 'amber')}
        </div>
      </div>`;

    // "Regels die de motor aanhoudt"-kaart (statisch — beschrijft de motor)
    const regelsHtml = `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;margin-top:12px">
        <div style="font-weight:600;font-size:13.5px;margin-bottom:10px;display:flex;align-items:center;gap:8px">
          ${svg(I.info || I.check, 'width:15px;height:15px;color:var(--brand)')} Regels die de motor aanhoudt
        </div>
        <ul style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--text-2)">
          <li>Elke lead in een <b>traject</b> (7-daagse / minicursus / student / event) krijgt op vaste dagen een <b>stap-bericht</b>.</li>
          <li>Sjabloon-keuze binnen een stap wordt bepaald door de <b>warmte-score</b> (0–45): koud/midden/warm heeft eigen varianten.</li>
          <li>Alleen leads met <b>toestemming</b> krijgen berichten (opt-in check zit in de wachtrij-view).</li>
          <li>Al verzonden berichten worden overgeslagen (idempotent op stap + lead).</li>
          <li>Bij <b>droogloop</b> (geen match / geen toestemming / al gestuurd) belandt de poging in de log — zichtbaar in de KPI hierboven.</li>
          <li>Motor aan/uit staat in <b>Automatiseringen → Leadsonderhoud</b> (schakelaar <code>leadsonderhoud_live</code>).</li>
        </ul>
      </div>`;

    return `${_live.overzicht.error ? err(_live.overzicht.error) : ''}
      ${_live.droogloop.error ? err(_live.droogloop.error) : ''}
      ${_live.leadsAll.error  ? err(_live.leadsAll.error)  : ''}
      ${_live.leadsMet.error  ? err(_live.leadsMet.error)  : ''}
      ${callKpiHtml}
      ${warmteKpiHtml}
      ${regelsHtml}`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 2 — CONTACTEN (alle leads over alle trajecten)
     ══════════════════════════════════════════════════════════════════ */
  function contactenView() {
    const q       = (F('ls-q', '') || '').trim();
    const traject = F('ls-traj', '') || '';
    const call    = F('ls-call', 'all'); // 'all' | 'ja' | 'nee'
    const params = [];
    params.push('limit=500');
    if (q)       params.push('q=' + encodeURIComponent(q));
    if (traject) params.push('traject=' + encodeURIComponent(traject));
    if (call === 'ja')  params.push('afspraak=ja');
    if (call === 'nee') params.push('afspraak=nee');
    const url = '/api/leads-list?' + params.join('&');
    const key = url;
    if (_live.contacten.lastKey !== key && !_live.contacten.loading) {
      queueMicrotask(() => fetchContacten(key, url));
    }
    const st = _live.contacten;
    // v=22 FIX (was v=21 regressie): TDZ-error — `st.data?.items?.length`
    // stond hier vóór `const st = ...` → contactenView throws met
    // "Cannot access 'st' before initialization", Contacten-tab rendert leeg.
    // Nu: eerst st declareren, dán de access-batch queuen. Fail-soft: als
    // items nog niet geladen zijn, gebeurt er niks — na fetchContacten's
    // render loopt contactenView opnieuw en dan wél queued.
    if (st.data && Array.isArray(st.data.items) && st.data.items.length) {
      const leadIds = st.data.items.map(it => it && it.id).filter(Boolean).slice(0, 500);
      if (leadIds.length) queueMicrotask(() => fetchAccessBatch(leadIds));
    }
    const items = st.data ? st.data.items : [];
    const total = st.data ? st.data.total : 0;
    const hasMore = st.data ? st.data.has_more : false;

    // Unieke trajecten uit huidige data — voor de filter-chips.
    const trajectSet = new Set();
    items.forEach(it => { if (it.traject) trajectSet.add(String(it.traject)); });
    const trajectOpts = Array.from(trajectSet).sort();

    const rowHtml = items.length
      ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead>
            <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
              <th style="padding:8px 10px">Naam</th>
              <th style="padding:8px 10px">Traject</th>
              <th style="padding:8px 10px">Warmte</th>
              <th style="padding:8px 10px">Call</th>
              <th style="padding:8px 10px">Bron</th>
              <th style="padding:8px 10px">Status</th>
              <th style="padding:8px 10px">Aangemaakt</th>
              <th style="padding:8px 10px">Toegang tot</th>
              <th style="padding:8px 10px;text-align:right">Acties</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(l => {
              const w = warmteMeta(l.score);
              const heeftCall = !!l.afspraak_op;
              const callBadge = heeftCall
                ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--emerald-soft);color:var(--emerald)">✓ geboekt</span>`
                : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--amber-soft);color:var(--amber)">— nog niet</span>`;
              // v=19: "Verlengen"-actie per lead → opent extend-modal.
              // v=23: alleen tonen voor trajecten met een trial-grant (7-daagse /
              // minicursus). Event/webinar/membership hebben geen einddatum-toegang.
              const nameForBtn = String(l.naam || l.email || '').replace(/'/g, "\\'");
              const idForBtn   = String(l.id || '').replace(/'/g, "\\'");
              const extendable = _isExtendableTraject(l.traject);
              const extendBtn  = (idForBtn && extendable)
                ? `<button class="btn btn-ghost btn-sm" onclick="window.__lsExtOpen('${idForBtn}', '${nameForBtn}')" style="font-size:11px" title="Trial-toegang van deze lead verlengen">Verlengen</button>`
                : (idForBtn ? `<span style="font-size:11px;color:var(--text-3)" title="Verlengen is alleen zinvol voor 7-daagse en minicursus">N.v.t.</span>` : '');
              // BP2 (2026-09-01): "Geef toegang"-knop. Alleen zinvol bij leads
              // met een trial-traject; roept lead-toegang-verlenen (default
              // 7 dagen) + verstuurt de welkomstmail.
              const geefToegangBtn = (idForBtn && extendable)
                ? `<button class="btn btn-ghost btn-sm" onclick="window.__lsGeefToegang('${idForBtn}', '${nameForBtn}')" style="font-size:11px;margin-right:4px" title="Verleen 7-daagse trial-toegang + stuur welkomstmail">Geef toegang</button>`
                : '';
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:8px 10px">
                  <div style="font-weight:600">${esc(l.naam || l.email || '(zonder naam)')}</div>
                  <div style="color:var(--text-3);font-size:11px">${esc(l.email || '')}${l.telefoon ? ' · ' + esc(l.telefoon) : ''}</div>
                </td>
                <td style="padding:8px 10px">${esc(l.traject || '—')}</td>
                <td style="padding:8px 10px">${warmteBar(l.score)}</td>
                <td style="padding:8px 10px">${callBadge}${heeftCall ? `<div style="color:var(--text-3);font-size:11px;margin-top:2px">${esc(fmtDatumAbsoluut(l.afspraak_op))}</div>` : ''}</td>
                <td style="padding:8px 10px"><span style="font-size:11px;color:var(--text-3)">${esc(l.bron || l.soort || '—')}</span></td>
                <td style="padding:8px 10px"><span style="font-size:11px">${esc(l.status || '—')}</span></td>
                <td style="padding:8px 10px;color:var(--text-3)">${esc(fmtDatum(l.aangemaakt))}</td>
                <td style="padding:8px 10px">${fmtToegangTot(_live.access && _live.access.map ? _live.access.map[l.id] : null)}</td>
                <td style="padding:8px 10px;text-align:right;white-space:nowrap">${geefToegangBtn}${extendBtn}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table></div>
        ${hasMore ? `<div style="padding:12px;color:var(--text-3);font-size:11.5px;text-align:center">Meer dan 500 resultaten — verfijn je filter of gebruik zoek.</div>` : ''}`
      : `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Geen leads voor deze filters.'}</div>`;

    // Filter-toolbar (uncontrolled input voor search — focus behouden).
    const currentTraj = traject;
    const trajFilterHtml = `
      <select onchange="DFO.S.filters[DFO.key()+'::ls-traj']=this.value;DFO.render()" style="padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1)">
        <option value="">Alle trajecten</option>
        ${trajectOpts.map(t => `<option value="${esc(t)}" ${currentTraj === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
      </select>`;

    const searchQ = (F('ls-q','') || '').replace(/"/g, '&quot;');
    const toolbar = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <input placeholder="Zoek op naam of e-mail…" value="${searchQ}"
          oninput="DFO.S.filters[DFO.key()+'::ls-q']=this.value;DFO.render();this.focus();this.setSelectionRange(this.value.length,this.value.length)"
          style="flex:1;min-width:200px;padding:7px 11px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1)">
        ${trajFilterHtml}
        <div style="display:flex;gap:4px">
          <button class="chip ${call === 'all' ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="DFO.setF('ls-call','all')">Alle calls</button>
          <button class="chip ${call === 'ja'  ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="DFO.setF('ls-call','ja')">✓ geboekt</button>
          <button class="chip ${call === 'nee' ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="DFO.setF('ls-call','nee')">— nog niet</button>
        </div>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">${st.loading ? 'Laden…' : (total + ' leads')}</span>
      </div>`;

    return `${_lsExtModalHtml()}${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      ${toolbar}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        ${st.loading && !items.length ? renderSkeletonRows(6) : rowHtml}
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 3 — WACHTRIJ
     ══════════════════════════════════════════════════════════════════ */
  function wachtrijView() {
    if (!_live.wachtrij.fetched && !_live.wachtrij.loading && !_live.wachtrij.error) queueMicrotask(fetchWachtrij);
    const st = _live.wachtrij;
    const items = st.data ? st.data.items : [];
    const rowsHtml = items.length ? `<div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:12.5px">
        <thead>
          <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
            <th style="padding:8px 10px">Naar</th>
            <th style="padding:8px 10px">Traject</th>
            <th style="padding:8px 10px">Kanaal</th>
            <th style="padding:8px 10px">Soort</th>
            <th style="padding:8px 10px">Volgorde</th>
            <th style="padding:8px 10px">Dag</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(r => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:8px 10px">
              <div style="font-weight:600">${esc(r.naar || r.voornaam || '(zonder naam)')}</div>
              ${r.email ? `<div style="color:var(--text-3);font-size:11px">${esc(r.email)}</div>` : ''}
            </td>
            <td style="padding:8px 10px">${esc(r.traject || '—')}</td>
            <td style="padding:8px 10px">${esc(r.kanaal || '—')}</td>
            <td style="padding:8px 10px">${esc(r.soort || '—')}</td>
            <td style="padding:8px 10px">${esc(r.volgorde ?? '—')}</td>
            <td style="padding:8px 10px">${esc(r.dag_in_proefperiode ?? r.dag ?? '—')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>`
      : `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Wachtrij is leeg — de motor heeft niets in de eerstvolgende ronde.'}</div>`;

    return `
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:12px">
        Dit is wat de drip-motor bij de volgende ronde zou versturen. De view <code>onderhoud_wachtrij</code> zit toestemming, stap-keuze en al-verzonden-checks al ingebakken.
      </div>
      ${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text-3)">${st.loading ? 'Laden…' : (items.length + ' items in de wachtrij')}</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        ${st.loading && !items.length ? renderSkeletonRows(6) : rowsHtml}
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 4 — GESPREKKEN (BROK 2 FASE 1 — WA + mail per lead)
     ══════════════════════════════════════════════════════════════════
     Spiegel van onboarding-inline-inbox patroon met leadsonderhoud-
     specifieke aanpassingen:
     - Sleutel is lead_id (niet conversation_id) — leads hebben vaak
       geen telnr, dus WA-conv-lookup faalt. leadsonderhoud-gesprekken
       joint WA + mail op lead_id/email server-side.
     - Twee kanalen door elkaar in de thread → per bericht een
       kanaal-badge (WA/mail).
     - Twee send-knoppen (WA + mail met subject-veld) i.p.v. één.
     - Berichten-item-shape uit -gesprek-berichten: channel = 'whatsapp'|'mail',
       direction = 'in'|'out' (niet inbound/outbound) → normalisatie in view.
     - has_wa / can_send_text bepalen of de WA-knop bruikbaar is.
     ══════════════════════════════════════════════════════════════════ */

  const _lsInb = {
    convs:    { loading: false, fetched: false, error: null, items: [], _seq: 0 },
    sel:      null,      // lead_id (uuid)
    thread: {
      leadId: null, items: [], loading: false, error: null,
      conversation: null,
      _paintedFor: null, _markedFor: null, _seq: 0,
    },
    compose: {
      draftsWa: {}, draftsMailSubject: {}, draftsMailText: {},
      mode: {},       // per lead: 'text' | 'template'
      sending: null,  // lead_id in-flight
      showMail: {},   // toon mail-compose (true|false per lead)
      templateCache: {}, quickCache: {},
    },
    poll: { handle: null, running: false, intervalMs: 18000 },
    // v=19: filter voor gesprekken-lijst (client-side over item.unread).
    filter: 'all',   // 'all' | 'unread' | 'read'
  };

  /* ── Access-verleng-modal state (v=19) ─────────────────────────────────── */
  const _lsExt = {
    open: false, leadId: null, leadName: '', busy: false,
    choice: '7',                 // '7' | '14' | '30' | 'custom'
    customDate: '',              // 'YYYY-MM-DD'
  };
  function _lsExtDefaultDate() {
    const d = new Date(); d.setDate(d.getDate() + 30);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }
  // BP2 (2026-09-01): "Geef toegang"-knop → simpel confirm + POST.
  // 7-daagse trial (server-default in api/lead-toegang-verlenen.js).
  window.__lsGeefToegang = async (leadId, leadName) => {
    if (!leadId) return;
    const ok = confirm('Geef 7-daagse trial-toegang aan ' + (leadName || 'deze lead') + '? De welkomstmail wordt automatisch verstuurd.');
    if (!ok) return;
    try {
      const resp = await window.KV.authedFetch('/api/lead-toegang-verlenen', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: leadId }),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.error) {
        _lsInbToast('Toegang verlenen mislukt: ' + (j?.error || 'HTTP ' + resp.status), 'warn');
        return;
      }
      const mailOk = j?.mail?.ok;
      _lsInbToast(
        'Toegang verleend tot ' + (j.geldig_tot || '?') + (mailOk ? ' · welkomstmail verzonden' : ' · welkomstmail MISLUKT'),
        mailOk ? 'ok' : 'warn'
      );
    } catch (e) {
      _lsInbToast('Netwerkfout: ' + (e?.message || e), 'warn');
    }
  };

  window.__lsExtOpen = (leadId, leadName) => {
    _lsExt.open = true; _lsExt.leadId = leadId; _lsExt.leadName = String(leadName || '');
    _lsExt.choice = '7'; _lsExt.customDate = _lsExtDefaultDate(); _lsExt.busy = false;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__lsExtCancel = () => { _lsExt.open = false; if (window.DFO?.render) window.DFO.render(); };
  window.__lsExtChoice = (v) => {
    _lsExt.choice = String(v);
    const cd = document.querySelector('[data-le-field="customDate"]');
    if (cd) _lsExt.customDate = String(cd.value || _lsExt.customDate);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__lsExtSave = async () => {
    if (!_lsExt.open || !_lsExt.leadId) return;
    if (_lsExt.busy) return;
    // Sync-from-DOM: custom date input.
    const cd = document.querySelector('[data-le-field="customDate"]');
    if (cd) _lsExt.customDate = String(cd.value || '');
    const body = { lead_id: _lsExt.leadId };
    if (_lsExt.choice === 'custom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(_lsExt.customDate)) {
        _lsInbToast('Kies een geldige datum (YYYY-MM-DD).', 'warn'); return;
      }
      body.to_date = _lsExt.customDate;
    } else {
      body.days = Number(_lsExt.choice);
    }
    _lsExt.busy = true; if (window.DFO?.render) window.DFO.render();
    try {
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-extend-access', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.error) {
        _lsInbToast('Verlengen mislukt: ' + (j?.error || resp.status), 'warn');
        _lsExt.busy = false; if (window.DFO?.render) window.DFO.render(); return;
      }
      // Success — toaster met status per kanaal.
      const parts = [`Toegang verlengd tot ${j.einddatum_nl || j.new_toegang_tot}`];
      parts.push(j.email_sent ? 'E-mail verstuurd' : `E-mail mislukt (${j.email_error || 'onbekend'})`);
      parts.push(j.wa_sent ? 'WA verstuurd' : `WA niet verstuurd (${(j.wa_error || 'template nog niet approved').slice(0, 60)})`);
      _lsInbToast(parts.join(' · '), j.email_sent ? 'ok' : 'warn');
      _lsExt.open = false; _lsExt.busy = false;
      if (window.DFO?.render) window.DFO.render();
    } catch (e) {
      _lsInbToast('Netwerkfout: ' + (e?.message || e), 'warn');
      _lsExt.busy = false; if (window.DFO?.render) window.DFO.render();
    }
  };
  function _lsExtModalHtml() {
    if (!_lsExt.open) return '';
    const chip = (v, label) => `<button class="chip ${_lsExt.choice === v ? 'on' : ''}" onclick="window.__lsExtChoice('${v}')" style="padding:6px 12px;font-size:12.5px;margin-right:6px">${label}</button>`;
    const previewDatum = _lsExt.choice === 'custom' && _lsExt.customDate
      ? (() => { try { return new Date(_lsExt.customDate + 'T00:00:00').toLocaleDateString('nl-NL', { day:'numeric', month:'long', year:'numeric' }); } catch(_) { return _lsExt.customDate; } })()
      : (() => { const d = new Date(); d.setDate(d.getDate() + Number(_lsExt.choice || 0)); return d.toLocaleDateString('nl-NL', { day:'numeric', month:'long', year:'numeric' }) + ' (bij verlopen toegang — anders vanaf huidige einddatum)'; })();
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__lsExtCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(520px,100%);max-height:90vh;overflow-y:auto">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);gap:10px">
          <div style="font-size:14px;font-weight:600">Toegang verlengen</div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__lsExtCancel()">✕</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
          <div style="font-size:12.5px;color:var(--text-2)">Lead: <b>${esc(_lsExt.leadName || '—')}</b></div>
          <div style="padding:8px 12px;background:var(--info-soft,var(--surface-2));color:var(--text-2);border-radius:6px;font-size:11.5px;line-height:1.5">
            Verlengt <b>alle actieve LMS-grants</b> van deze lead met de gekozen duur. Semantiek: max(vandaag, huidige einddatum) + N dagen. Bij "specifieke datum" wordt die als absolute nieuwe einddatum gezet. De lead krijgt bij succes een e-mail én een WhatsApp-melding (WA is fail-soft — als het Meta-template nog niet goedgekeurd is, gaat alleen e-mail door).
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:5px">Duur</div>
            <div>${chip('7', '+7 dagen')}${chip('14', '+14 dagen')}${chip('30', '+30 dagen')}${chip('custom', 'Specifieke datum')}</div>
          </div>
          ${_lsExt.choice === 'custom' ? `<div>
            <div style="font-size:11px;color:var(--text-3);margin-bottom:5px">Nieuwe einddatum</div>
            <input type="date" data-le-field="customDate" value="${esc(_lsExt.customDate)}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
          </div>` : ''}
          <div style="font-size:12px;color:var(--text-2);padding:8px 10px;background:var(--surface-2);border-radius:6px">
            Verlengen tot <b>${esc(previewDatum)}</b>
          </div>
        </div>
        <div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" ${_lsExt.busy ? 'disabled' : ''} onclick="window.__lsExtCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_lsExt.busy ? 'disabled' : ''} onclick="window.__lsExtSave()">${_lsExt.busy ? 'Bezig…' : 'Verlengen + informeren (e-mail + WA)'}</button>
        </div>
      </div>
    </div>`;
  }
  // v=19: gesprekken-filter setter (client-side, geen refetch).
  window.__lsInbSetFilter = (v) => {
    _lsInb.filter = String(v || 'all');
    if (window.DFO?.render) window.DFO.render();
  };

  /* ── Modal-helpers (custom confirm — geen native window.confirm) ────── */
  function _lsInbCloseModal() {
    const m = document.getElementById('lsInbModalRoot');
    if (m) m.remove();
    document.removeEventListener('keydown', _lsInbModalKey, true);
  }
  function _lsInbModalKey(e) { if (e.key === 'Escape') { e.preventDefault(); _lsInbCloseModal(); } }
  function _lsInbOpenModal(html, opts) {
    _lsInbCloseModal();
    const root = document.createElement('div');
    root.id = 'lsInbModalRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    root.innerHTML = `<div id="lsInbModalBox" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:22px;max-width:${opts?.maxWidth || 480}px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">${html}</div>`;
    root.addEventListener('click', (e) => { if (e.target === root) _lsInbCloseModal(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', _lsInbModalKey, true);
    return root;
  }
  function _lsInbAskConfirm(title, body, opts) {
    const okLabel     = esc(opts?.okLabel     || 'Bevestig');
    const cancelLabel = esc(opts?.cancelLabel || 'Annuleren');
    // v=8 FIX B (ROOT CAUSE): design-tokens.css definieert wél --rose/--emerald/
    // --amber (hex #C22B3E / #07835A / #C2700A) maar GEEN --brand. Onze
    // btn-primary background verwees naar var(--brand) → invalid-at-computed-
    // value → transparent → wit-op-wit. Voor deze modal: gebruik --brand
    // met een hex-fallback (#0A7490, matcht de teal-primary-tint die
    // .btn-primary elders gebruikt).
    const isRose = opts?.tone === 'danger';
    const bgVar  = isRose ? 'var(--rose, #C22B3E)'  : 'var(--brand, #0A7490)';
    return new Promise((resolve) => {
      _lsInbOpenModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px;white-space:pre-wrap">${esc(body)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="lsInbModalCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="lsInbModalOk" class="btn btn-primary btn-sm" style="background:${bgVar};border-color:${bgVar};color:#fff">${okLabel}</button>
        </div>`);
      document.getElementById('lsInbModalCancel').addEventListener('click', () => { _lsInbCloseModal(); resolve(false); });
      document.getElementById('lsInbModalOk').addEventListener('click',    () => { _lsInbCloseModal(); resolve(true);  });
    });
  }
  function _lsInbToast(msg, tone) { try { window.KV && window.KV.toast && window.KV.toast(msg, { tone }); } catch (_) {} }

  /* ── Fetchers ────────────────────────────────────────────────────────── */
  async function _lsInbFetchConvs() {
    const st = _lsInb.convs;
    if (st.fetched && !st.error) return;
    if (st.loading) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('ls-convs', '/api/leadsonderhoud-gesprekken');
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon gesprekken niet laden'; }
    else { st.items = asArr(j.items); st.fetched = true; }
    if (window.DFO?.render) window.DFO.render();
  }
  function _lsInbResetThread() {
    _lsInb.thread.leadId = null;
    _lsInb.thread.items = [];
    _lsInb.thread.loading = false;
    _lsInb.thread.error = null;
    _lsInb.thread.conversation = null;
    _lsInb.thread._paintedFor = null;
    _lsInb.thread._markedFor = null;
  }
  async function _lsInbLoadThread(leadId) {
    if (!leadId) return;
    if (_lsInb.thread.leadId === leadId && !_lsInb.thread.error) return;
    _lsInb.thread.loading = true;
    _lsInb.thread.error = null;
    _lsInb.thread.leadId = leadId;
    _lsInb.thread.items = [];
    _lsInb.thread.conversation = null;
    _lsInb.thread._paintedFor = null;
    if (window.DFO?.render) window.DFO.render();
    const seq = ++_lsInb.thread._seq;
    // mark_as_read=true reset alleen de WA-teller (server: mail-gelezen laat de gedeelde
    // e-mailmodule met rust). Idempotent: 1 poging per open-actie.
    const alreadyMarked = _lsInb.thread._markedFor === leadId;
    const markParam = alreadyMarked ? '' : '&mark_as_read=true';
    const j = await tryFetch('ls-thread ' + leadId, '/api/leadsonderhoud-gesprek-berichten?lead_id=' + encodeURIComponent(leadId) + markParam);
    if (seq !== _lsInb.thread._seq) return;
    if (_lsInb.thread.leadId !== leadId) return;
    if (!j) {
      _lsInb.thread.loading = false;
      _lsInb.thread.error = 'Kon berichten niet laden';
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    // Item-shape normalisatie: 'in'/'out' -> 'inbound'/'outbound' + at-veld.
    // v=29 (2026-08-30): template_name meegenomen voor "Sjabloon · X"-chip
    // op outbound-template-berichten (fallback op meerdere veldnamen die de
    // API-shape historisch heeft gebruikt).
    _lsInb.thread.items = asArr(j.items).map(m => ({
      id: m.id,
      channel: m.channel === 'mail' ? 'mail' : 'whatsapp',
      direction: m.direction === 'out' ? 'outbound' : 'inbound',
      body: m.body || '',
      subject: m.subject || '',
      at: m.ts || null,
      is_read: !!m.is_read,
      template_name: m.template_name || m.templateName || null,
    }));
    _lsInb.thread.conversation = j.conversation || null;
    _lsInb.thread.loading = false;
    // v=8 FIX C: has_wa/has_mail synchronizeren met de ECHTE thread-inhoud
    // zodra we die geladen hebben. Backend -gesprekken-endpoint mist soms
    // een channel (dubbele lead-rijen die niet consistent samensmelten,
    // WA-lead zonder email vs. mail-lead zonder telnr) -> mismatch tussen
    // lijst-badges en draad-inhoud. Client-side sync garandeert: badge in
    // lijstrij = channel bestaat écht in de draad die je zo opent. Update
    // lokale row + het DOM badges-blok surgisch (geen render-trigger).
    try {
      const idx2 = _lsInb.convs.items.findIndex(it => String(it.lead_id) === String(leadId));
      if (idx2 >= 0) {
        const hasMailReal = _lsInb.thread.items.some(m => m.channel === 'mail');
        const hasWaReal   = _lsInb.thread.items.some(m => m.channel === 'whatsapp');
        _lsInb.convs.items[idx2] = { ..._lsInb.convs.items[idx2], has_mail: hasMailReal, has_wa: hasWaReal };
        // Surgisch: patch de badge-row in de lijst (geen full render, scroll blijft).
        const rowEl2 = document.querySelector('#lsInbList .ls-inb-row[data-row-id="' + String(leadId).replace(/"/g, '\\"') + '"]');
        if (rowEl2) {
          const tagRow = rowEl2.querySelector('.ls-inb-tagrow');
          if (tagRow) {
            const waB   = hasWaReal   ? '<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--teal-soft);color:var(--teal);font-weight:600">WA</span>' : '';
            const mailB = hasMailReal ? '<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-weight:600">mail</span>' : '';
            const nwDot = rowEl2.classList.contains('nw')
              ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto"></span>' : '';
            tagRow.innerHTML = (waB + ' ' + mailB).trim() + nwDot;
          }
        }
      }
    } catch (e) { /* fail-soft */ }
    // Lokale WA-teller bijwerken + surgische DOM-patch (was mark_as_read=true).
    if (!alreadyMarked) {
      _lsInb.thread._markedFor = leadId;
      const idx = _lsInb.convs.items.findIndex(it => String(it.lead_id) === String(leadId));
      if (idx >= 0) _lsInb.convs.items[idx] = { ..._lsInb.convs.items[idx], unread: 0 };
      const rowEl = document.querySelector('#lsInbList .ls-inb-row[data-row-id="' + String(leadId).replace(/"/g, '\\"') + '"]');
      if (rowEl) {
        rowEl.classList.remove('nw');
        rowEl.querySelectorAll('span[style*="background:var(--rose)"]').forEach(d => d.remove());
      }
    }
    if (window.DFO?.render) window.DFO.render();
  }

  /* ── Thread paint (v=30 2026-08-30: shared chat-renderer) ─────────────
     Renderer uitgeplaatst naar KV_V2.helpers.renderChatThread (shared over
     Events / Onboarding / Inbox). Local paint-fn behoudt scroll-management. */
  function _lsInbPaintThread() {
    const container = document.getElementById('lsInbThreadScroll');
    if (!container) return;
    if (!_lsInb.thread.leadId) { container.innerHTML = ''; return; }
    const isNewLead = _lsInb.thread._paintedFor !== _lsInb.thread.leadId;
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 40;
    const anchor = container.scrollHeight - container.scrollTop;
    const H = window.KV_V2 && window.KV_V2.helpers;
    container.innerHTML = (H && H.renderChatThread)
      ? H.renderChatThread(_lsInb.thread.items, { escFn: esc })
      : '';
    _lsInb.thread._paintedFor = _lsInb.thread.leadId;
    if (isNewLead || nearBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = container.scrollHeight - anchor;
    }
  }

  /* ── Handlers op window ──────────────────────────────────────────────── */
  window.__lsInbSel = (id) => {
    if (String(_lsInb.sel) === String(id)) return;
    _lsInb.sel = id;
    _lsInbResetThread();
    // Surgische highlight-swap (behoud scrollpositie in de lijst).
    document.querySelectorAll('#lsInbList .ls-inb-row.on').forEach(el => el.classList.remove('on'));
    const newRow = document.querySelector('#lsInbList .ls-inb-row[data-row-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    // Detail-pane vervangen.
    const split = document.querySelector('.ls-inb-split');
    const oldRight = split ? split.querySelector('.ls-inb-right') : null;
    const row = _lsInb.convs.items.find(c => String(c.lead_id) === String(id));
    if (split && row) {
      const wrap = document.createElement('div');
      wrap.innerHTML = _lsInbRenderRight(row);
      const el = wrap.firstElementChild;
      if (el) { if (oldRight) split.replaceChild(el, oldRight); else split.appendChild(el); }
    }
    queueMicrotask(() => _lsInbLoadThread(id));
  };
  // FEAT-2: toggle gelezen/ongelezen — hergebruikt bestaande
  // /api/leadsonderhoud-gesprek-mark-read endpoint. Surgical DOM-update
  // op de rij (geen render-trigger → geen scroll-sprong).
  // Fix-ronde 3: gebruikt window.KV.authedFetch (dezelfde helper als de
  // reply-verzending in deze module) i.p.v. het niet-bestaande tryPost.
  // Alle native alerts vervangen door _lsInbToast.
  window.__lsInbToggleRead = async (convId, unread, leadIdAttr) => {
    if (!convId) return;
    try {
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-gesprek-mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          unread: !!unread,
        }),
      });
      let j = null;
      try { j = await resp.json(); } catch (_) { /* body-parse-fail */ }
      if (!resp.ok) throw new Error((j && j.error) || ('HTTP ' + resp.status));
      // Sync lokale state.
      const idx = _lsInb.convs.items.findIndex((c) => String(c.conversation_id) === String(convId));
      if (idx >= 0) {
        _lsInb.convs.items[idx] = { ..._lsInb.convs.items[idx], unread: j?.unread_count || 0 };
      }
      // Surgical row-repaint: vervang de rij-DOM in-place zonder full render.
      const row = _lsInb.convs.items[idx];
      const oldRow = document.querySelector('#lsInbList .ls-inb-row[data-row-id="' + String(leadIdAttr).replace(/"/g, '\\"') + '"]');
      if (oldRow && row) {
        const wrap = document.createElement('div');
        wrap.innerHTML = _lsInbRenderRow(row);
        const el = wrap.firstElementChild;
        if (el) oldRow.replaceWith(el);
      }
      // Ook de thread-header knop patchen als deze conv geopend is.
      const openLead = String(_lsInb.thread?.leadId || '');
      if (row && openLead === String(row.lead_id)) {
        const right = document.querySelector('.ls-inb-right');
        const split = document.querySelector('.ls-inb-split');
        if (right && split) {
          const wrap2 = document.createElement('div');
          wrap2.innerHTML = _lsInbRenderRight(row);
          const el2 = wrap2.firstElementChild;
          if (el2) split.replaceChild(el2, right);
        }
      }
      _lsInbToast(unread ? 'Gemarkeerd als ongelezen' : 'Gemarkeerd als gelezen', 'ok');
    } catch (e) {
      console.warn('[leadsonderhoud] mark-read toggle fail:', e?.message);
      _lsInbToast('Kon lees-status niet wijzigen: ' + (e?.message || 'onbekende fout'), 'error');
    }
  };

  window.__lsInbDraftWa       = (leadId, val) => { _lsInb.compose.draftsWa[leadId] = val; };
  window.__lsInbDraftMailSub  = (leadId, val) => { _lsInb.compose.draftsMailSubject[leadId] = val; };
  window.__lsInbDraftMailTxt  = (leadId, val) => { _lsInb.compose.draftsMailText[leadId] = val; };
  window.__lsInbResetMode     = () => {
    const leadId = _lsInb.thread.leadId;
    if (!leadId) return;
    _lsInb.compose.mode[leadId] = 'text';
    _lsInbRepaintCompose();
  };
  window.__lsInbToggleMailForm = () => {
    const leadId = _lsInb.thread.leadId;
    if (!leadId) return;
    _lsInb.compose.showMail[leadId] = !_lsInb.compose.showMail[leadId];
    // Pre-fill mail-subject met "Re: <last mail subject>" indien lege draft.
    if (_lsInb.compose.showMail[leadId] && !_lsInb.compose.draftsMailSubject[leadId]) {
      const lastMail = [..._lsInb.thread.items].reverse().find(m => m.channel === 'mail');
      if (lastMail && lastMail.subject) {
        const s = String(lastMail.subject);
        _lsInb.compose.draftsMailSubject[leadId] = s.startsWith('Re:') ? s : ('Re: ' + s);
      }
    }
    _lsInbRepaintCompose();
  };

  function _lsInbOptimisticAppend(leadId, channel, body, subject) {
    if (_lsInb.thread.leadId !== leadId) return;
    _lsInb.thread.items.push({
      id: 'opt-' + Date.now(),
      channel,
      direction: 'outbound',
      body: body || '',
      subject: subject || '',
      at: new Date().toISOString(),
      is_read: true,
    });
    _lsInbPaintThread();
  }
  function _lsInbRepaintCompose() {
    const el = document.getElementById('lsInbComposeBlock');
    if (!el) return;
    el.outerHTML = _lsInbRenderCompose();
  }
  function _lsInbCurrentConv() {
    const leadId = _lsInb.thread.leadId;
    if (!leadId) return null;
    return _lsInb.convs.items.find(c => String(c.lead_id) === String(leadId)) || null;
  }

  // ── WhatsApp reply ───────────────────────────────────────────────────
  window.__lsInbSendWa = async () => {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    const leadId = conv.lead_id;
    if (!conv.has_wa || !conv.can_send_text) {
      // Buiten 24u-venster of geen WA-lijn: template-modus.
      // BP1 2026-08-31: vriendelijker hint i.p.v. technische foutmelding.
      _lsInb.compose.mode[leadId] = 'template';
      _lsInbRepaintCompose();
      _lsInbToast('Dit gesprek is ouder dan 24 uur — kies een goedgekeurde template om het te heropenen.', 'warn');
      _lsInbOpenTemplatePicker(leadId);
      return;
    }
    if (_lsInb.compose.sending === leadId) return;
    const body = String(_lsInb.compose.draftsWa[leadId] || '').trim();
    if (!body) { _lsInbToast('Bericht is leeg', 'warn'); return; }
    const preview = body.length > 140 ? body.slice(0, 140) + '…' : body;
    const ok = await _lsInbAskConfirm(
      `Verstuur WhatsApp naar ${conv.naam || 'de lead'}?`,
      preview + (conv.phone_number ? `\n\nNaar: ${conv.phone_number}` : ''),
      { okLabel: 'Verstuur WhatsApp' }
    );
    if (!ok) return;
    _lsInb.compose.sending = leadId;
    _lsInbRepaintCompose();
    try {
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-gesprek-antwoord', {
        method: 'POST',
        body: JSON.stringify({ lead_id: leadId, body }),
      });
      if (resp.status === 422) {
        // BP1 2026-08-31: vriendelijker hint i.p.v. rauwe 422-error.
        _lsInb.compose.mode[leadId] = 'template';
        _lsInbToast('Dit gesprek is ouder dan 24 uur — kies een goedgekeurde template om het te heropenen.', 'warn');
        _lsInbOpenTemplatePicker(leadId);
        return;
      }
      if (resp.status === 409) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || 'Geen WhatsApp-lijn / gesprek beschikbaar');
      }
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      _lsInbOptimisticAppend(leadId, 'whatsapp', body);
      _lsInb.compose.draftsWa[leadId] = '';
      _lsInbToast('WhatsApp verzonden', 'ok');
    } catch (e) {
      console.warn('[ls-inb] wa-send fail:', e && e.message);
      _lsInbToast('WA versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _lsInb.compose.sending = null;
      _lsInbRepaintCompose();
    }
  };

  // ── Mail reply ────────────────────────────────────────────────────────
  window.__lsInbSendMail = async () => {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    const leadId = conv.lead_id;
    if (!conv.email) { _lsInbToast('Lead heeft geen e-mailadres', 'warn'); return; }
    if (_lsInb.compose.sending === leadId) return;
    const subject = String(_lsInb.compose.draftsMailSubject[leadId] || '').trim();
    const text    = String(_lsInb.compose.draftsMailText[leadId] || '').trim();
    if (!subject) { _lsInbToast('Onderwerp is leeg', 'warn'); return; }
    if (!text)    { _lsInbToast('E-mail-tekst is leeg', 'warn'); return; }
    // Zoek origineel_email_id: laatste inbound mail met numerieke/uuid id.
    const lastInboundMail = [..._lsInb.thread.items].reverse().find(m => m.channel === 'mail' && m.direction === 'inbound' && m.id);
    const origineel = lastInboundMail ? lastInboundMail.id : null;
    const preview = text.length > 140 ? text.slice(0, 140) + '…' : text;
    const ok = await _lsInbAskConfirm(
      `Verstuur e-mail naar ${conv.naam || conv.email}?`,
      `Aan: ${conv.email}\nOnderwerp: ${subject}\n\n${preview}`,
      { okLabel: 'Verstuur e-mail' }
    );
    if (!ok) return;
    _lsInb.compose.sending = leadId;
    _lsInbRepaintCompose();
    try {
      const payload = { lead_id: leadId, subject, text };
      if (origineel) payload.origineel_email_id = origineel;
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-gesprek-mailantwoord', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      _lsInbOptimisticAppend(leadId, 'mail', text, subject);
      _lsInb.compose.draftsMailSubject[leadId] = '';
      _lsInb.compose.draftsMailText[leadId] = '';
      _lsInb.compose.showMail[leadId] = false;
      _lsInbToast('E-mail verzonden', 'ok');
    } catch (e) {
      console.warn('[ls-inb] mail-send fail:', e && e.message);
      _lsInbToast('E-mail versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _lsInb.compose.sending = null;
      _lsInbRepaintCompose();
    }
  };

  /* ══════════════════════════════════════════════════════════════════
     v=6 FIX 5 — Quick-replies (canned) + ECHTE WA-templates op lead_id
     ══════════════════════════════════════════════════════════════════
     DEEL A: quick-replies = vaste canned-teksten (client-side), vult
             actieve compose-veld (WA of mail). Geen conversation_id nodig.
     DEEL D: template-picker leest /api/leadsonderhoud-gesprek-templates
             (WABA-scoped approved templates), variabelen-invulform,
             live preview met vervangingen, confirm-modal (leesbare
             brand-knop uit FIX 2), verzenden via
             /api/leadsonderhoud-gesprek-template.
     ══════════════════════════════════════════════════════════════════ */

  // Canned quick-replies — bewust een korte vaste leadsonderhoud-set (niet
  // afhankelijk van whatsapp_quick_replies-tabel die conversation_id vereist).
  // Uitbreidbaar in code; later evt. server-side per module.
  const _LS_QUICK_REPLIES = [
    { title: 'Vraag om check-in',   body: 'Hey! Hoe gaat het met de proefperiode? Zijn er nog vragen die ik kan beantwoorden?' },
    { title: 'Herinnering call',    body: 'Zullen we een korte kennismakingscall inplannen? Kies gerust een moment dat jou uitkomt.' },
    { title: 'Vraag om feedback',   body: 'Wat vind je tot nu toe van de lessen? Ik ben benieuwd naar je eerste indruk.' },
    { title: 'Extra hulp aanbieden',body: 'Als je ergens tegenaan loopt: laat het weten, ik help je graag verder.' },
    { title: 'Bedankt voor reactie',body: 'Dank voor je bericht! Ik pak het zsm op en laat het je weten.' },
  ];

  // v=9 FIX-SNEL-DOEL: target ('wa' of 'mail') expliciet meegeven vanuit
  // de knop-context. Voorkomt dat een Snel-klik vanuit de mail-toolbar
  // tekst in het WA-veld plakt. Zonder target: heuristiek (mail-form
  // open → mail; anders WA) — legacy fallback voor eventuele callers.
  window.__lsInbQuickPicker = (target) => {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    const leadId = conv.lead_id;
    const mailOpen = !!_lsInb.compose.showMail[leadId];
    const explicit = (target === 'wa' || target === 'mail') ? target : null;
    const useMail = explicit ? (explicit === 'mail') : mailOpen; // default = WA
    const label = useMail ? 'e-mail' : 'WhatsApp';
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:6px">Snel-antwoord invoegen</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">Kies er één. De tekst wordt in het <b>${esc(label)}</b>-veld gezet (achter een eventuele bestaande draft, gescheiden door een lege regel). Je kan 'em nog aanpassen vóór verzenden.</div>
      <div id="lsInbQrList" style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow-y:auto">
        ${_LS_QUICK_REPLIES.map((it, i) => `
          <button class="btn btn-ghost btn-sm" data-qr-idx="${i}" style="text-align:left;justify-content:flex-start;padding:10px 12px;height:auto;white-space:normal">
            <div style="font-weight:600;margin-bottom:2px">${esc(it.title)}</div>
            <div style="font-size:12px;color:var(--text-3);white-space:pre-wrap;line-height:1.45">${esc(it.body)}</div>
          </button>`).join('')}
      </div>
      <div style="margin-top:14px;text-align:right"><button id="lsInbQrCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 560 });
    document.getElementById('lsInbQrCancel').addEventListener('click', _lsInbCloseModal);
    // Helper: append met scheidingsteken.
    const appendWithSep = (existing, addition) => {
      const ex = String(existing || '');
      if (!ex.trim()) return addition;
      // Als bestaande draft niet op newline eindigt: dubbele newline ertussen.
      return ex.replace(/\s+$/, '') + '\n\n' + addition;
    };
    document.querySelectorAll('#lsInbQrList [data-qr-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-qr-idx'));
        const it = _LS_QUICK_REPLIES[idx];
        if (!it) return;
        if (useMail) {
          _lsInb.compose.draftsMailText[leadId] = appendWithSep(_lsInb.compose.draftsMailText[leadId], it.body);
          // Zorg dat het mail-form open staat na invoegen.
          _lsInb.compose.showMail[leadId] = true;
        } else {
          _lsInb.compose.draftsWa[leadId] = appendWithSep(_lsInb.compose.draftsWa[leadId], it.body);
        }
        _lsInbRepaintCompose();
        _lsInbCloseModal();
      });
    });
  };

  // Template-cache — één per open sessie (server-refetch na 5 min zou beter zijn,
  // maar approved templates wijzigen zelden; TTL later toevoegen als 't nodig blijkt).
  const _lsTpl = { loading: false, items: null, error: null, fetchedAt: 0 };
  async function _lsInbFetchTemplates() {
    // Simpele 5-min cache; skip als recent + geen fout.
    if (_lsTpl.items && (Date.now() - _lsTpl.fetchedAt) < 5 * 60 * 1000 && !_lsTpl.error) return _lsTpl.items;
    if (_lsTpl.loading) return _lsTpl.items || [];
    _lsTpl.loading = true; _lsTpl.error = null;
    const j = await tryFetch('ls-templates', '/api/leadsonderhoud-gesprek-templates');
    _lsTpl.loading = false;
    if (!j) { _lsTpl.error = 'Kon templates niet laden'; return _lsTpl.items || []; }
    _lsTpl.items = Array.isArray(j.items) ? j.items : [];
    _lsTpl.fetchedAt = Date.now();
    return _lsTpl.items;
  }

  // ── BP1 Onderdeel B — Snippet-picker + insert-op-cursor ──────────────
  // Snippets zijn korte tekst-blokjes die op de cursor-positie in de
  // composer worden ingevoegd (i.p.v. de tekst te vervangen zoals de
  // template-picker doet). Variabelen: {voornaam} en {naam} worden
  // client-side ingevuld vanuit de lead-context ('daar' als fallback).
  const _lsSnip = { loading: false, items: null, error: null, fetchedAt: 0 };
  async function _lsInbFetchSnippets() {
    if (_lsSnip.items && (Date.now() - _lsSnip.fetchedAt) < 60 * 1000 && !_lsSnip.error) return _lsSnip.items;
    if (_lsSnip.loading) return _lsSnip.items || [];
    _lsSnip.loading = true; _lsSnip.error = null;
    const j = await tryFetch('ls-snippets', '/api/wa-snippets-list');
    _lsSnip.loading = false;
    if (!j) { _lsSnip.error = 'Kon snippets niet laden'; return _lsSnip.items || []; }
    _lsSnip.items = Array.isArray(j.items) ? j.items : [];
    _lsSnip.fetchedAt = Date.now();
    return _lsSnip.items;
  }
  function _lsInbResolveSnippet(body, conv) {
    // Var-invulling: {voornaam} / {naam} → conv.voornaam of split van conv.naam.
    // Fallback 'daar' bij ontbreken (mimicked pattern uit cron-toegang-aanvragen).
    const rawNaam = String(conv?.naam || '').trim();
    const voornaam = String(conv?.voornaam || rawNaam.split(/\s+/)[0] || 'daar').trim() || 'daar';
    const naam = rawNaam || voornaam;
    return String(body || '')
      .replace(/\{voornaam\}/gi, voornaam)
      .replace(/\{naam\}/gi, naam);
  }
  function _lsInbInsertAtCursor(taEl, text) {
    if (!taEl) return;
    const start = taEl.selectionStart != null ? taEl.selectionStart : (taEl.value || '').length;
    const end   = taEl.selectionEnd   != null ? taEl.selectionEnd   : start;
    const cur   = taEl.value || '';
    const nieuw = cur.slice(0, start) + text + cur.slice(end);
    taEl.value = nieuw;
    // Cursor achter ingevoegde tekst.
    const nieuwePos = start + text.length;
    try { taEl.setSelectionRange(nieuwePos, nieuwePos); } catch (_) { /* fail-soft */ }
    // Handmatig input-event triggeren zodat oninput-handler _lsInb.compose.draftsWa bijwerkt.
    taEl.dispatchEvent(new Event('input', { bubbles: true }));
    taEl.focus();
  }
  window.__lsInbSnippetPicker = () => { _lsInbOpenSnippetPicker(); };
  async function _lsInbOpenSnippetPicker() {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    const leadId = conv.lead_id;
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">Kies een snippet om in te voegen</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">
        Wordt <b>ingevoegd op cursor-positie</b> — je kunt 'm daarna nog bewerken.
        Variabelen zoals <code>{voornaam}</code> worden ingevuld met de lead-naam.
      </div>
      <div id="lsInbSnipList" style="max-height:55vh;overflow-y:auto">
        <div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">Snippets laden…</div>
      </div>
      <div style="margin-top:14px;text-align:right">
        <button id="lsInbSnipManage" class="btn btn-ghost btn-sm" style="margin-right:6px">Beheer snippets…</button>
        <button id="lsInbSnipClose" class="btn btn-ghost btn-sm">Sluiten</button>
      </div>
    `, { maxWidth: 620 });
    document.getElementById('lsInbSnipClose').addEventListener('click', _lsInbCloseModal);
    document.getElementById('lsInbSnipManage').addEventListener('click', () => {
      _lsInbCloseModal();
      _lsInbOpenSnippetManager();
    });
    const items = await _lsInbFetchSnippets();
    const listEl = document.getElementById('lsInbSnipList');
    if (!listEl) return;
    if (_lsSnip.error) {
      listEl.innerHTML = `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_lsSnip.error)}</div>`;
      return;
    }
    if (!items.length) {
      listEl.innerHTML = `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">
        Nog geen snippets. Klik <b>Beheer snippets</b> om er een aan te maken.
      </div>`;
      return;
    }
    // Groepeer gedeeld (owner NULL) → eigen.
    const shared = items.filter(x => x.is_shared);
    const eigen  = items.filter(x => x.is_mine);
    const groep = (label, arr) => arr.length ? `
      <div style="font-size:10.5px;font-weight:600;color:var(--text-3);letter-spacing:.03em;text-transform:uppercase;padding:8px 4px 4px">${esc(label)}</div>
      ${arr.map((s, i) => `
        <button data-snip-id="${esc(s.id)}" class="ls-inb-snip-btn" style="display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;font-family:inherit">
          <div style="font-size:13px;font-weight:600;color:var(--text-1);margin-bottom:3px">${esc(s.titel)}</div>
          <div style="font-size:12px;color:var(--text-3);line-height:1.4;white-space:pre-wrap">${esc(String(s.body_text || '').slice(0, 160))}${(s.body_text || '').length > 160 ? '…' : ''}</div>
        </button>`).join('')}
    ` : '';
    listEl.innerHTML = groep('Gedeeld', shared) + groep('Eigen', eigen);
    listEl.querySelectorAll('[data-snip-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-snip-id');
        const snip = items.find(x => String(x.id) === String(id));
        if (!snip) return;
        const resolved = _lsInbResolveSnippet(snip.body_text, conv);
        const taEl = document.getElementById('lsInbWaTxt');
        if (taEl) {
          _lsInbInsertAtCursor(taEl, resolved);
        } else {
          // Fallback: als textarea niet gemount is (buiten 24u fallback-view),
          // gewoon in draftsWa appenden. Verzenden gaat dan alsnog via template.
          _lsInb.compose.draftsWa[leadId] = (String(_lsInb.compose.draftsWa[leadId] || '') + resolved);
          _lsInbRepaintCompose();
        }
        _lsInbCloseModal();
      });
    });
  }

  // BP1 Onderdeel C — Snippet-beheerscherm (modal).
  async function _lsInbOpenSnippetManager() {
    const perms = (window.RBAC && typeof window.RBAC.getUserPermissions === 'function')
      ? (window.RBAC.getUserPermissions() || new Set()) : new Set();
    const kanBeheren = perms.has('*') || perms.has('snippets.manage');
    if (!kanBeheren) {
      _lsInbToast('Geen beheerrechten (snippets.manage)', 'warn');
      return;
    }
    // Bypass cache voor beheerscherm — altijd verse lijst.
    _lsSnip.fetchedAt = 0;
    const items = await _lsInbFetchSnippets();
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">Snippets beheren</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">
        Gedeelde snippets zijn zichtbaar voor het hele team. Eigen snippets alleen voor jou.
        <br>Variabelen: <code>{voornaam}</code>, <code>{naam}</code>.
      </div>
      <div style="max-height:50vh;overflow-y:auto;margin-bottom:12px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead style="text-align:left;color:var(--text-3);font-size:11.5px;text-transform:uppercase">
            <tr><th style="padding:6px 4px">Titel</th><th style="padding:6px 4px">Type</th><th style="padding:6px 4px">Volgorde</th><th style="padding:6px 4px;text-align:right">Acties</th></tr>
          </thead>
          <tbody id="lsInbSnipMgrRows">
            ${items.length ? items.map(s => `
              <tr style="border-top:1px solid var(--border)">
                <td style="padding:8px 4px">${esc(s.titel)}</td>
                <td style="padding:8px 4px">${s.is_shared ? '<span style="color:var(--teal)">Gedeeld</span>' : '<span style="color:var(--text-3)">Eigen</span>'}</td>
                <td style="padding:8px 4px">${Number(s.sort_order) || 100}</td>
                <td style="padding:8px 4px;text-align:right">
                  <button class="btn btn-ghost btn-sm" data-snip-edit="${esc(s.id)}">Bewerk</button>
                  <button class="btn btn-ghost btn-sm" data-snip-del="${esc(s.id)}" style="color:var(--rose)">Verwijder</button>
                </td>
              </tr>
            `).join('') : `<tr><td colspan="4" style="padding:22px;text-align:center;color:var(--text-3)">Nog geen snippets.</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="text-align:right">
        <button id="lsInbSnipMgrNew" class="btn btn-primary btn-sm" style="color:#fff;margin-right:6px">+ Nieuwe snippet</button>
        <button id="lsInbSnipMgrClose" class="btn btn-ghost btn-sm">Sluiten</button>
      </div>
    `, { maxWidth: 720 });
    document.getElementById('lsInbSnipMgrClose').addEventListener('click', _lsInbCloseModal);
    document.getElementById('lsInbSnipMgrNew').addEventListener('click', () => _lsInbOpenSnippetForm(null));
    document.querySelectorAll('[data-snip-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-snip-edit');
        const snip = items.find(x => String(x.id) === String(id));
        if (snip) _lsInbOpenSnippetForm(snip);
      });
    });
    document.querySelectorAll('[data-snip-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-snip-del');
        const snip = items.find(x => String(x.id) === String(id));
        const ok = await _lsInbAskConfirm(
          `Snippet verwijderen?`,
          `"${snip?.titel || id}" wordt definitief verwijderd.`,
          { okLabel: 'Verwijder' }
        );
        if (!ok) return;
        try {
          const resp = await window.KV.authedFetch('/api/wa-snippets-delete?id=' + encodeURIComponent(id), { method: 'DELETE' });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          _lsInbToast('Snippet verwijderd', 'ok');
          _lsSnip.fetchedAt = 0;
          _lsInbCloseModal();
          _lsInbOpenSnippetManager();
        } catch (e) {
          _lsInbToast('Verwijderen mislukt: ' + (e?.message || 'onbekend'), 'error');
        }
      });
    });
  }
  function _lsInbOpenSnippetForm(existing) {
    const isEdit = !!(existing && existing.id);
    const cur = existing || { titel: '', body_text: '', owner_user_id: null, sort_order: 100 };
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:12px">${isEdit ? 'Snippet bewerken' : 'Nieuwe snippet'}</div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:11.5px;color:var(--text-3);margin-bottom:4px">Titel</label>
        <input id="lsSnipTitel" type="text" maxlength="120" value="${esc(cur.titel)}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13px" />
      </div>
      <div style="margin-bottom:10px">
        <label style="display:block;font-size:11.5px;color:var(--text-3);margin-bottom:4px">Bericht (variabelen: {voornaam}, {naam})</label>
        <textarea id="lsSnipBody" maxlength="2000" style="width:100%;min-height:120px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13px;line-height:1.5;font-family:inherit;resize:vertical">${esc(cur.body_text)}</textarea>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px">
        <div style="flex:1">
          <label style="display:block;font-size:11.5px;color:var(--text-3);margin-bottom:4px">Type</label>
          <select id="lsSnipOwner" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13px">
            <option value="shared" ${cur.owner_user_id === null ? 'selected' : ''}>Gedeeld (team)</option>
            <option value="me" ${cur.owner_user_id !== null ? 'selected' : ''}>Eigen (alleen ik)</option>
          </select>
        </div>
        <div style="width:120px">
          <label style="display:block;font-size:11.5px;color:var(--text-3);margin-bottom:4px">Volgorde</label>
          <input id="lsSnipOrder" type="number" min="0" max="9999" value="${Number(cur.sort_order) || 100}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13px" />
        </div>
      </div>
      <div style="text-align:right">
        <button id="lsSnipCancel" class="btn btn-ghost btn-sm" style="margin-right:6px">Annuleer</button>
        <button id="lsSnipSave" class="btn btn-primary btn-sm" style="color:#fff">${isEdit ? 'Opslaan' : 'Toevoegen'}</button>
      </div>
    `, { maxWidth: 560 });
    document.getElementById('lsSnipCancel').addEventListener('click', () => {
      _lsInbCloseModal();
      _lsInbOpenSnippetManager();
    });
    document.getElementById('lsSnipSave').addEventListener('click', async () => {
      const titel = String(document.getElementById('lsSnipTitel')?.value || '').trim();
      const body  = String(document.getElementById('lsSnipBody')?.value  || '').trim();
      const owner = String(document.getElementById('lsSnipOwner')?.value || 'shared');
      const order = Number(document.getElementById('lsSnipOrder')?.value) || 100;
      if (!titel) { _lsInbToast('Titel is leeg', 'warn'); return; }
      if (!body)  { _lsInbToast('Bericht is leeg', 'warn'); return; }
      try {
        const url  = '/api/wa-snippets-upsert';
        const meth = isEdit ? 'PATCH' : 'POST';
        const payload = { titel, body_text: body, owner_user_id: owner, sort_order: order };
        if (isEdit) payload.id = existing.id;
        const resp = await window.KV.authedFetch(url, {
          method: meth,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + resp.status));
        }
        _lsInbToast(isEdit ? 'Snippet opgeslagen' : 'Snippet toegevoegd', 'ok');
        _lsSnip.fetchedAt = 0;
        _lsInbCloseModal();
        _lsInbOpenSnippetManager();
      } catch (e) {
        _lsInbToast('Opslaan mislukt: ' + (e?.message || 'onbekend'), 'error');
      }
    });
  }

  window.__lsInbTemplatePicker = () => { _lsInbOpenTemplatePicker(); };
  async function _lsInbOpenTemplatePicker() {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Kies een goedgekeurde template</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">
        Voor <b>${esc(_lsInbRowVan(conv))}</b>${conv.phone_number ? ` · ${esc(conv.phone_number)}` : ''}. Templates mogen ook buiten het 24u-venster verstuurd worden.
      </div>
      <div id="lsInbTplList" style="max-height:55vh;overflow-y:auto">
        <div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">Templates laden…</div>
      </div>
      <div style="margin-top:14px;text-align:right"><button id="lsInbTplClose" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 620 });
    document.getElementById('lsInbTplClose').addEventListener('click', _lsInbCloseModal);
    const items = await _lsInbFetchTemplates();
    const listEl = document.getElementById('lsInbTplList');
    if (!listEl) return;
    if (_lsTpl.error) {
      listEl.innerHTML = `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_lsTpl.error)}</div>`;
      return;
    }
    if (!items.length) {
      listEl.innerHTML = `<div style="padding:22px;color:var(--text-3);font-size:13px">Geen goedgekeurde templates voor de leadsonderhoud-lijn.</div>`;
      return;
    }
    // v=9 FIX-GROEP-RUIS: alleen echte categorie-groepen (≥2 templates
    // delen de prefix). Alle prefix-eenlingen → één 'overig'-bucket.
    // Dedup impliciet want groepen worden op key gemaakt (Set semantics).
    const prefixOf = (name) => {
      const s = String(name || '').trim();
      const i = s.indexOf('_');
      return (i > 0 ? s.slice(0, i) : (s || 'overig')).toLowerCase();
    };
    // Preliminary count: welke prefix komt ≥2x voor?
    const prefixCountAll = new Map();
    for (const it of items) {
      const p = prefixOf(it.name);
      prefixCountAll.set(p, (prefixCountAll.get(p) || 0) + 1);
    }
    // effectivePrefix() = prefix als deze ≥2 heeft, anders 'overig'.
    const effectivePrefix = (name) => {
      const p = prefixOf(name);
      return (prefixCountAll.get(p) || 0) >= 2 ? p : 'overig';
    };
    // Chips: unieke effective-prefixes, gesorteerd, met de count.
    const uniquePrefixes = Array.from(new Set(items.map(it => effectivePrefix(it.name))));
    // 'overig' altijd onderaan de chip-rij en groups-lijst.
    uniquePrefixes.sort((a, b) => {
      if (a === 'overig') return 1;
      if (b === 'overig') return -1;
      return a.localeCompare(b);
    });
    let activePrefix = 'ALL';
    const renderList = () => {
      const filtered = activePrefix === 'ALL' ? items : items.filter(it => effectivePrefix(it.name) === activePrefix);
      const byPrefix = new Map();
      for (const it of filtered) {
        const key = effectivePrefix(it.name);
        if (!byPrefix.has(key)) byPrefix.set(key, []);
        byPrefix.get(key).push(it);
      }
      const chipsHtml = `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px">
        <button class="chip ${activePrefix === 'ALL' ? 'on' : ''}" data-prefix="ALL" style="font-size:11.5px;padding:3px 10px">Alle (${items.length})</button>
        ${uniquePrefixes.map(p => {
          const n = items.filter(it => effectivePrefix(it.name) === p).length;
          const label = p === 'overig' ? 'overig' : p;
          return `<button class="chip ${activePrefix === p ? 'on' : ''}" data-prefix="${esc(p)}" style="font-size:11.5px;padding:3px 10px">${esc(label)} (${n})</button>`;
        }).join('')}
      </div>`;
      const groups = Array.from(byPrefix.entries()).sort((a, b) => {
        if (a[0] === 'overig') return 1;
        if (b[0] === 'overig') return -1;
        return a[0].localeCompare(b[0]);
      });
      const groupsHtml = groups.length
        ? groups.map(([prefix, tpls]) => `
            <div style="margin-bottom:14px">
              <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                <span style="font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:10px;background:var(--teal-soft);color:var(--teal)">${esc(prefix)}</span>
                <span style="font-size:11px;color:var(--text-3)">${tpls.length} sjablonen</span>
              </div>
              <div style="display:flex;flex-direction:column;gap:5px">
                ${tpls.sort((a, b) => String(a.name).localeCompare(String(b.name))).map(it => {
                  const globalIdx = items.indexOf(it);
                  return `<button class="btn btn-ghost btn-sm" data-tpl-idx="${globalIdx}" style="text-align:left;justify-content:flex-start;padding:9px 12px;height:auto;white-space:normal">
                    <div style="font-weight:600;font-size:12.5px;margin-bottom:2px">${esc(it.name)} <span style="font-size:10.5px;color:var(--text-3);font-weight:400">· ${esc(it.language || 'nl')}</span></div>
                    <div style="font-size:11.5px;color:var(--text-3);white-space:pre-wrap;line-height:1.4">${esc((it.body_text || '').slice(0, 180))}${(it.body_text || '').length > 180 ? '…' : ''}</div>
                  </button>`;
                }).join('')}
              </div>
            </div>`).join('')
        : `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Geen sjablonen in deze groep.</div>`;
      listEl.innerHTML = chipsHtml + groupsHtml;
      // (Re)bind chips + template-clicks.
      listEl.querySelectorAll('[data-prefix]').forEach(chip => {
        chip.addEventListener('click', () => {
          activePrefix = chip.getAttribute('data-prefix');
          renderList();
        });
      });
      listEl.querySelectorAll('[data-tpl-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.getAttribute('data-tpl-idx'));
          const tpl = items[idx];
          if (tpl) _lsInbOpenTemplateForm(conv, tpl);
        });
      });
    };
    renderList();
  }
  // v=8 FIX H: bewaar template-variabelewaarden per template-naam over
  // form-remounts heen (bv. na Annuleren op de confirm-modal). Key =
  // tpl.name; value = { [placeholderKey]: value }.
  const _lsTplValues = {};

  function _lsInbOpenTemplateForm(conv, tpl) {
    const bodyText = String(tpl.body_text || '');
    // v=8 FIX G: universele placeholder-parser — ondersteunt genummerd
    // ({{1}}, {{2}}) EN benoemd ({{klant.voornaam}}, {{factuur.nummer}}).
    // Meta accepteert positional variables[]; we mappen invulwaarden naar
    // de volgorde-van-voorkomen in de body_text. Server-side wordt de
    // template met deze positional values verstuurd (Meta's approved
    // template heeft z'n eigen {{N}} in de goedgekeurde tekst; onze
    // body_text-preview mag benoemd zijn voor leesbaarheid).
    const keys = [];   // unique placeholders in volgorde van voorkomen
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g; let m;
    while ((m = re.exec(bodyText))) { const k = m[1].trim(); if (k && !keys.includes(k)) keys.push(k); }

    // Vorige waarden pre-fillen (FIX H).
    const saved = _lsTplValues[tpl.name] || {};

    // Placeholder → veilige HTML-id (elke niet-woord char wordt _).
    const idFor = (k) => 'lsTplPh_' + String(k).replace(/[^a-zA-Z0-9_]/g, '_');
    const inpIdFor = (k) => 'lsTplVar_' + String(k).replace(/[^a-zA-Z0-9_]/g, '_');

    // Preview: elke {{...}}-match omzetten naar een span met unieke id.
    const previewHtml = esc(bodyText).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (mm, k) => {
      const key = String(k).trim();
      const val = saved[key];
      const shown = val && String(val).length ? esc(val) : ('{{' + esc(key) + '}}');
      return `<b id="${idFor(key)}" style="background:var(--brand-soft,#E2F1F5);padding:0 4px;border-radius:3px">${shown}</b>`;
    });

    const varsForm = keys.length
      ? `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
           ${keys.map(k => {
             const val = esc(saved[k] || '');
             return `<label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px">
               <span style="color:var(--text-3)">Variabele <code style="font-family:'IBM Plex Mono',monospace">${esc('{{' + k + '}}')}</code></span>
               <input class="input" id="${inpIdFor(k)}" data-var-key="${esc(k)}" value="${val}" placeholder="waarde voor ${esc(k)}"
                 style="padding:8px 10px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-1)">
             </label>`;
           }).join('')}
         </div>`
      : `<div style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--surface-2);border-radius:var(--r-sm);margin-bottom:12px">Deze template heeft geen variabelen.</div>`;

    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">${esc(tpl.name)}</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px">${esc(tpl.language || 'nl')}${tpl.category ? ' · ' + esc(tpl.category) : ''}</div>
      <div id="lsTplPreview" style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:13px;line-height:1.55;white-space:pre-wrap;margin-bottom:14px">${previewHtml}</div>
      ${varsForm}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="lsTplBack" class="btn btn-ghost btn-sm">Terug</button>
        <button id="lsTplSend" class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff">Verstuur template</button>
      </div>`, { maxWidth: 580 });

    // Live preview + write-through naar _lsTplValues (FIX H).
    document.querySelectorAll('#lsInbModalBox [data-var-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.getAttribute('data-var-key');
        // Bewaar in _lsTplValues zodat na Annuleren-remount de waarde nog staat.
        if (!_lsTplValues[tpl.name]) _lsTplValues[tpl.name] = {};
        _lsTplValues[tpl.name][key] = inp.value;
        // Live preview: alle spans met dezelfde id updaten (kan meerdere zijn
        // als dezelfde placeholder in de body herhaalt).
        const ph = document.getElementById(idFor(key));
        if (ph) ph.textContent = inp.value || ('{{' + key + '}}');
      });
    });

    document.getElementById('lsTplBack').addEventListener('click', _lsInbOpenTemplatePicker);
    document.getElementById('lsTplSend').addEventListener('click', async () => {
      // Verzamel variabelen in de volgorde van voorkomen in body_text.
      const variables = keys.map(k => {
        const el = document.getElementById(inpIdFor(k));
        return el ? String(el.value || '') : (saved[k] || '');
      });
      // Preview: substitueer per token op exact match (elke placeholder-token
      // met matching key -> value; ongebruikte tokens blijven staan als hint).
      const rendered = bodyText.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (mm, k) => {
        const key = String(k).trim();
        const idx = keys.indexOf(key);
        return idx >= 0 ? (variables[idx] || ('{{' + key + '}}')) : mm;
      });
      const preview = rendered.length > 200 ? rendered.slice(0, 200) + '…' : rendered;
      const ok = await _lsInbAskConfirm(
        `Verstuur template naar ${_lsInbRowVan(conv)}?`,
        `Template: ${tpl.name} (${tpl.language || 'nl'})\n\n${preview}`,
        { okLabel: 'Ja, verstuur' }
      );
      if (!ok) { _lsInbOpenTemplateForm(conv, tpl); return; }
      _lsInbCloseModal();
      _lsInb.compose.sending = conv.lead_id;
      _lsInbRepaintCompose();
      try {
        const resp = await window.KV.authedFetch('/api/leadsonderhoud-gesprek-template', {
          method: 'POST',
          body: JSON.stringify({
            lead_id: conv.lead_id,
            template_name: tpl.name,
            language: tpl.language || 'nl',
            variables,
          }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || j.meta_error || ('HTTP ' + resp.status));
        }
        _lsInbOptimisticAppend(conv.lead_id, 'whatsapp', rendered);
        _lsInb.compose.mode[conv.lead_id] = 'text';
        // v=8: bij succesvolle send de bewaarde variabelewaarden voor deze
        // template opruimen (voorkomt dat de volgende template-send met
        // stale data start).
        try { delete _lsTplValues[tpl.name]; } catch (_) {}
        _lsInbToast('Template verzonden', 'ok');
      } catch (e) {
        console.warn('[ls-inb] template-send fail:', e && e.message);
        _lsInbToast('Template versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
      } finally {
        _lsInb.compose.sending = null;
        _lsInbRepaintCompose();
      }
    });
  }

  // ── Live-refresh poll (18s) ──────────────────────────────────────────
  function _lsInbStartPoll() {
    if (_lsInb.poll.handle) return;
    _lsInb.poll.handle = setInterval(_lsInbPollTick, _lsInb.poll.intervalMs);
  }
  function _lsInbStopPoll() {
    if (_lsInb.poll.handle) { clearInterval(_lsInb.poll.handle); _lsInb.poll.handle = null; }
  }
  // v=6 FIX 1: hash van de convs-lijst zodat we niet meer re-renderen als er
  // niks veranderd is (voorkomt onnodige node-vervanging elke poll-tick).
  function _lsInbConvsHash() {
    const items = asArr(_lsInb.convs.items);
    return items.map(x => [x.lead_id, x.last_activity_at || '', x.unread || 0, x.last_preview || ''].join('|')).join('||');
  }
  async function _lsInbPollTick() {
    if (_lsInb.poll.running) return;
    if (!document.querySelector('.ls-inb-split')) { _lsInbStopPoll(); return; }
    if (document.hidden) return;
    _lsInb.poll.running = true;
    try {
      // v=6 FIX 1: scroll behouden op de conv-lijst tijdens poll-refresh.
      // Vroegere flow: convs.fetched=false -> fetch -> DFO.render() rebuild
      // de hele view -> #lsInbList wordt vervangen -> scrollTop reset naar 0.
      // Nieuwe flow:
      //   1. Bereken hash vóór fetch.
      //   2. Fetch DIRECT via tryFetch (skip render-triggerende _lsInbFetchConvs).
      //   3. Alleen als hash veranderde -> capture scrollTop, doe DFO.render(),
      //      restore scrollTop in RAF.
      //   Als er niks nieuws is doen we geen render en blijft de lijst staan.
      const preHash = _lsInbConvsHash();
      const jList = await tryFetch('ls-poll-convs', '/api/leadsonderhoud-gesprekken');
      if (jList && Array.isArray(jList.items)) {
        _lsInb.convs.items = jList.items;
        _lsInb.convs.fetched = true;
        _lsInb.convs.error = null;
        const postHash = _lsInbConvsHash();
        if (postHash !== preHash) {
          const listEl = document.getElementById('lsInbList');
          const savedScroll = listEl ? listEl.scrollTop : 0;
          if (window.DFO?.render) window.DFO.render();
          // RAF zodat de nieuwe #lsInbList in de DOM staat.
          requestAnimationFrame(() => {
            const el = document.getElementById('lsInbList');
            if (el) el.scrollTop = savedScroll;
          });
        }
      }
      if (_lsInb.thread.leadId) {
        const j = await tryFetch('ls-poll-thread', '/api/leadsonderhoud-gesprek-berichten?lead_id=' + encodeURIComponent(_lsInb.thread.leadId));
        if (j && Array.isArray(j.items)) {
          const seen = new Set(_lsInb.thread.items.map(x => String(x.id)));
          const additions = asArr(j.items)
            .filter(x => !seen.has(String(x.id)))
            .map(x => ({
              id: x.id,
              channel: x.channel === 'mail' ? 'mail' : 'whatsapp',
              direction: x.direction === 'out' ? 'outbound' : 'inbound',
              body: x.body || '',
              subject: x.subject || '',
              at: x.ts || null,
              is_read: !!x.is_read,
            }));
          if (additions.length) {
            _lsInb.thread.items = _lsInb.thread.items.concat(additions);
            _lsInbPaintThread();
          }
        }
      }
    } catch (e) {
      console.warn('[ls-inb] poll error:', e && e.message);
    } finally {
      _lsInb.poll.running = false;
    }
  }

  // ── Renderers ────────────────────────────────────────────────────────
  function _lsInbRowVan(row) {
    if (!row) return 'Onbekend';
    return row.naam || row.email || row.phone_number || 'Onbekend';
  }
  function _lsInbRenderRow(row) {
    const naam    = _lsInbRowVan(row);
    const nw      = (row.unread || 0) > 0;
    const tijd    = fmtDatum(row.last_activity_at);
    const preview = row.last_preview || '—';
    const ctx     = row.email || row.phone_number || '';
    const rowIdAttr  = String(row.lead_id).replace(/"/g, '&quot;');
    const rowIdClick = String(row.lead_id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const onCls   = String(_lsInb.sel) === String(row.lead_id) ? 'on' : '';
    // Kanaal-indicatoren (WA/mail beschikbaar).
    const waBadge = row.has_wa
      ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--teal-soft);color:var(--teal);font-weight:600">WA</span>`
      : '';
    const mailBadge = row.has_mail
      ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-weight:600">mail</span>`
      : '';
    // FEAT-2: duidelijke ongelezen-styling + toggle-knop op de rij.
    // Ongelezen: linker rose-strip (4px), primary background-tint, dikke
    // vette naam. Gelezen: gedempt (opacity), naam normaal-gewicht.
    // Toggle: klein 'gelezen/ongelezen'-knopje rechtsonder (stop-propagation
    // zodat de rij niet ook opent).
    const convIdAttr = String(row.conversation_id || '').replace(/"/g, '&quot;');
    const canToggle = !!row.conversation_id;
    const toggleTitle = nw ? 'Markeer als gelezen' : 'Markeer als ongelezen';
    // Fix-ronde 3: tekst is nu een ACTIE-label (was statuslabel dat als
    // knop las verkeerd op een gelezen rij: "● ongelezen" → leek de
    // status, is de actie). Gelijk aan de knop in de thread-header:
    // '✓ Markeer gelezen' / '● Markeer ongelezen'.
    const toggleLabel = nw ? '✓ Markeer gelezen' : '● Markeer ongelezen';
    const toggleBtn = canToggle
      ? `<button class="ls-inb-read-toggle" data-conv-id="${convIdAttr}" data-target-unread="${nw ? '0' : '1'}"
          onclick="event.stopPropagation();__lsInbToggleRead('${convIdAttr}', ${nw ? 'false' : 'true'}, '${rowIdAttr}')"
          title="${toggleTitle}"
          style="margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--text-3);border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;flex-shrink:0">${toggleLabel}</button>`
      : '';
    const rowStyle = [
      'display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;position:relative',
      nw ? 'background:var(--rose-soft, rgba(220,53,90,.06));border-left:4px solid var(--rose, #DC355A);padding-left:10px' : 'padding-left:14px',
      onCls === 'on' ? 'background:var(--surface-2)' : '',
      !nw ? 'opacity:.88' : '',
    ].filter(Boolean).join(';');
    return `<div class="ls-inb-row ${nw ? 'nw' : ''} ${onCls}" data-row-id="${rowIdAttr}" onclick="__lsInbSel('${rowIdClick}')"
      style="${rowStyle}">
      ${H.av(naam || '?', 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:${nw ? '700' : '500'};color:${nw ? 'var(--text-1)' : 'var(--text-2)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</span>
          ${nw ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--rose);flex-shrink:0" title="Ongelezen"></span>' : ''}
          <span style="margin-left:auto;font-size:10.5px;font-family:\'IBM Plex Mono\',monospace;color:var(--text-3);flex-shrink:0">${esc(tijd)}</span>
        </div>
        <div style="font-size:12.5px;color:${nw ? 'var(--text-1)' : 'var(--text-2)'};font-weight:${nw ? '500' : '400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(preview)}</div>
        <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
        <div class="ls-inb-tagrow" style="margin-top:6px;display:flex;gap:5px;align-items:center">
          ${waBadge} ${mailBadge}
          ${toggleBtn}
        </div>
      </div>
    </div>`;
  }
  function _lsInbRenderCompose() {
    const conv = _lsInbCurrentConv();
    if (!conv) return '';
    const leadId = conv.lead_id;
    const sending = _lsInb.compose.sending === leadId;
    const mode = _lsInb.compose.mode[leadId] || 'text';
    const showMail = !!_lsInb.compose.showMail[leadId];
    const waEnabled = !!(conv.has_wa && conv.can_send_text);
    const mailEnabled = !!conv.email;

    // v=7 FIX B: Sjabloon-knop moet ALTIJD zichtbaar zijn in het WA-compose-
    // gebied. Vroegere flow: mode='text' toonde géén sjabloon-knop -> buiten
    // 24u/geen-WA verscheen alleen disabled 'Verstuur WA' + mail-knop. De
    // template-route bleef verborgen tot user handmatig probeerde te verzenden
    // en de 422-fallback triggerde. Nu:
    //   BUITEN venster / mode=template: Sjabloon is PRIMARY (naast mail-knop).
    //   BINNEN venster / mode=text:     Sjabloon naast Verstuur-WA (ghost).
    //   BUITEN venster / mode=text:     'Verstuur WA' disabled + Sjabloon
    //                                    PRIMARY (want dat is de enige WA-route).

    // Template-mode (na 422 of expliciete switch) — banner + directe knoppen.
    if (mode === 'template') {
      return `<div id="lsInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border)">
        <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px;color:var(--amber);margin-bottom:10px">
          Buiten het 24u-venster — vrije-tekst WA is niet toegestaan.
          Kies een <b>goedgekeurde template</b> of stuur een <b>e-mail</b>.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" style="color:#fff" onclick="__lsInbTemplatePicker()" ${sending ? 'disabled' : ''}>${svg(I.doc || I.mail, 'width:13px;height:13px')} Kies sjabloon</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbToggleMailForm()" ${!mailEnabled ? 'disabled' : ''}>${showMail ? 'Verberg mail' : 'Antwoord per mail'}</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbResetMode()">Probeer WA-tekst</button>
        </div>
        ${showMail ? _lsInbRenderMailForm(conv, sending) : ''}
      </div>`;
    }

    const waDraft = esc(_lsInb.compose.draftsWa[leadId] || '');
    const mailBlock = showMail ? _lsInbRenderMailForm(conv, sending) : '';

    // Sjabloon-primary bij !waEnabled (buiten venster), ghost bij waEnabled.
    const tplBtnClass = waEnabled ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm';
    const tplBtnStyle = waEnabled ? '' : 'style="color:#fff"';

    return `<div id="lsInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="font-size:10.5px;padding:2px 7px;border-radius:8px;background:var(--teal-soft);color:var(--teal);font-weight:600">WhatsApp</span>
          ${waEnabled ? '<span style="font-size:11px;color:var(--text-3)">binnen 24u-venster</span>' : '<span style="font-size:11px;color:var(--amber)">buiten 24u — alleen sjabloon</span>'}
        </div>
        <textarea
          id="lsInbWaTxt"
          placeholder="${waEnabled ? 'Typ een WhatsApp-antwoord… (Ctrl+Enter om te verzenden)' : 'Buiten 24u-venster — gebruik "Sjabloon" hieronder of stuur mail'}"
          oninput="__lsInbDraftWa('${String(leadId).replace(/'/g, "\\'")}', this.value)"
          onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();__lsInbSendWa();}"
          ${sending || !waEnabled ? 'disabled' : ''}
          style="width:100%;min-height:64px;max-height:180px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13.5px;line-height:1.5;font-family:inherit;resize:vertical;${!waEnabled ? 'opacity:.5' : ''}">${waDraft}</textarea>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
          ${waEnabled ? `<button class="btn btn-primary btn-sm" style="color:#fff" onclick="__lsInbSendWa()" ${sending ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Verstuur WA'}</button>` : `<button class="btn btn-ghost btn-sm" disabled title="Buiten 24u-venster — kies een sjabloon">Verstuur WA</button>`}
          <button class="${tplBtnClass}" ${tplBtnStyle} onclick="__lsInbTemplatePicker()" ${sending ? 'disabled' : ''} title="Kies een goedgekeurde WA-template">${svg(I.doc || I.mail, 'width:13px;height:13px')} Sjabloon</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbQuickPicker('wa')" ${sending ? 'disabled' : ''} title="Canned snel-antwoord invoegen">Snel</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbSnippetPicker()" ${sending || !waEnabled ? 'disabled' : ''} title="Snippet invoegen op cursor-positie">Snippet</button>
          ${(window.KV_V2 && window.KV_V2.helpers && window.KV_V2.helpers.emojiPickerButtonHtml) ? window.KV_V2.helpers.emojiPickerButtonHtml('lsInbWaTxt', '😊') : ''}
          <button class="btn btn-ghost btn-sm" onclick="__lsInbToggleMailForm()" ${!mailEnabled ? 'disabled' : ''} title="${mailEnabled ? 'Antwoord per mail' : 'Geen e-mailadres bekend'}">${showMail ? 'Verberg mail' : 'Ook / alleen mail…'}</button>
        </div>
      </div>
      ${mailBlock}
    </div>`;
  }
  function _lsInbRenderMailForm(conv, sending) {
    const leadId = conv.lead_id;
    const subj = esc(_lsInb.compose.draftsMailSubject[leadId] || '');
    const txt  = esc(_lsInb.compose.draftsMailText[leadId] || '');
    const mailEnabled = !!conv.email;
    return `<div style="border-top:1px solid var(--border);padding-top:10px">
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <span style="font-size:10.5px;padding:2px 7px;border-radius:8px;background:var(--blue-soft);color:var(--blue);font-weight:600">E-mail (welkom@)</span>
        ${mailEnabled ? `<span style="font-size:11px;color:var(--text-3)">naar: ${esc(conv.email)}</span>` : '<span style="font-size:11px;color:var(--rose)">geen e-mailadres bekend</span>'}
      </div>
      <input type="text" placeholder="Onderwerp"
        value="${subj}"
        oninput="__lsInbDraftMailSub('${String(leadId).replace(/'/g, "\\'")}', this.value)"
        ${sending || !mailEnabled ? 'disabled' : ''}
        style="width:100%;padding:8px 11px;font-size:13px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);margin-bottom:6px;box-sizing:border-box">
      <textarea
        placeholder="Typ een e-mail-antwoord…"
        oninput="__lsInbDraftMailTxt('${String(leadId).replace(/'/g, "\\'")}', this.value)"
        ${sending || !mailEnabled ? 'disabled' : ''}
        style="width:100%;min-height:100px;max-height:260px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13.5px;line-height:1.5;font-family:inherit;resize:vertical;box-sizing:border-box">${txt}</textarea>
      <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff" onclick="__lsInbSendMail()" ${sending || !mailEnabled ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Verstuur mail'}</button>
        <button class="btn btn-ghost btn-sm" onclick="__lsInbQuickPicker('mail')" ${sending || !mailEnabled ? 'disabled' : ''} title="Canned snel-antwoord invoegen in dit mail-veld">Snel</button>
        <span style="font-size:11px;color:var(--text-3);margin-left:auto">verzonden vanaf welkom@deforexopleiding.nl</span>
      </div>
    </div>`;
  }
  function _lsInbRenderRight(row) {
    const naam = _lsInbRowVan(row);
    const ctx  = row.email || row.phone_number || '';
    // v=6 FIX 4: call-status badge in de header (Jeffrey's noord-ster) —
    // consistent met de Contacten-tab styling. Datum-tooltip toont wanneer
    // 'ie geboekt is.
    const heeftCall = !!row.afspraak_op;
    // v=8 FIX D: absolute datum ipv relatief (toekomst "1m" was betekenisloos).
    const callBadge = heeftCall
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--emerald-soft);color:var(--emerald)" title="Geboekt op ${esc(row.afspraak_op)}">✓ call geboekt · ${esc(fmtDatumAbsoluut(row.afspraak_op))}</span>`
      : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--amber-soft);color:var(--amber)">— nog geen call</span>`;
    const chanBadges = [
      row.has_wa   ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--teal-soft);color:var(--teal)">WA</span>` : '',
      row.has_mail ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--blue-soft);color:var(--blue)">mail</span>` : '',
    ].filter(Boolean).join(' ');
    const status = _lsInb.thread.loading
      ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Berichten laden…</div>`
      : _lsInb.thread.error
        ? `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_lsInb.thread.error)}</div>`
        : (!_lsInb.thread.items.length && _lsInb.thread.leadId === row.lead_id)
          ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Nog geen berichten in deze draad.</div>`
          : '';
    return `<div class="ls-inb-right" style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:11.5px;padding:3px 10px;border-radius:12px;background:var(--teal-soft);color:var(--teal)">Leadsonderhoud</span>
          ${callBadge}
          ${chanBadges}
          <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${row.conversation_id ? (() => {
              const isUnread = (row.unread || 0) > 0;
              const targetUnread = !isUnread;
              const rowIdEsc = String(row.lead_id || '').replace(/'/g, "\\'");
              const convIdEsc = String(row.conversation_id).replace(/'/g, "\\'");
              return `<button class="btn btn-ghost btn-sm" onclick="__lsInbToggleRead('${convIdEsc}', ${targetUnread}, '${rowIdEsc}')"
                title="${isUnread ? 'Markeer als gelezen' : 'Markeer als ongelezen'}">
                ${isUnread ? '✓ Markeer gelezen' : '● Markeer ongelezen'}
              </button>`;
            })() : ''}
            <button class="btn btn-primary btn-sm" onclick="__lsInbOpenAppointmentPicker()" title="Direct een Zoom-afspraak inschieten (bestaande GHL-contact vereist)">${svg(I.cal || I.check, 'width:13px;height:13px')} Direct inschieten</button>
            <button class="btn btn-ghost btn-sm" onclick="__lsInbBookingLinkHelp()" title="Boekingslink verstuurroute (Route B)">Boekingslink…</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(naam || '?', 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
          </div>
        </div>
      </div>
      <div id="lsInbThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:20px;display:block"></div>
      ${status}
      ${_lsInbRenderCompose()}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     BROK 2 FASE 2 — Afspraak inschieten (hybride)
     ══════════════════════════════════════════════════════════════════
     ROUTE A: Direct inschieten (Zoom via GHL) — /api/leadsonderhoud-appointment-create
     ROUTE B: Boekingslink versturen — nog niet automatisch (geen
              GHL_BOOKING_URL env-var); toont uitleg + suggestie om
              handmatig een boekingslink in de compose te plakken.

     Free-slots via /api/follow-up-ghl-free-slots (gate uitgebreid met
     leads.update in dezelfde brok). Response: { slots:[{date,times[]}],
     timezone:'Europe/Amsterdam' }. Timezone-hint tonen zodat de user
     weet in welke TZ de tijden staan.

     Bij NO_GHL_CONTACT (422): nette toast + suggestie Route B.
     ══════════════════════════════════════════════════════════════════ */
  const _lsAppt = { loading: false, error: null, slotsByDate: null, tz: null, sending: false };

  window.__lsInbOpenAppointmentPicker = async () => {
    const conv = _lsInbCurrentConv();
    if (!conv) return;
    _lsAppt.loading = true; _lsAppt.error = null; _lsAppt.slotsByDate = null; _lsAppt.tz = null;
    // Standaard 14-daagse window (default van free-slots).
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Afspraak inschieten voor ${esc(_lsInbRowVan(conv))}</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">Dave's Zoom-agenda (komende 14 dagen). Kies een tijd en bevestig.</div>
      <div id="lsApptBody" style="max-height:60vh;overflow-y:auto">
        <div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">Vrije slots laden…</div>
      </div>
      <div style="margin-top:14px;text-align:right"><button id="lsApptCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>
    `, { maxWidth: 640 });
    document.getElementById('lsApptCancel').addEventListener('click', _lsInbCloseModal);
    // Fetch slots.
    const j = await tryFetch('ls-freeslots', '/api/follow-up-ghl-free-slots');
    _lsAppt.loading = false;
    const bodyEl = document.getElementById('lsApptBody');
    if (!bodyEl) return; // modal ondertussen dicht
    if (!j) {
      bodyEl.innerHTML = `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ Kon vrije slots niet laden</div>`;
      return;
    }
    if (j.error === 'onbeschikbaar' || !Array.isArray(j.slots) || !j.slots.length) {
      bodyEl.innerHTML = `<div style="padding:22px;color:var(--text-3);font-size:13px">Geen vrije slots gevonden in de komende 14 dagen.</div>`;
      return;
    }
    _lsAppt.slotsByDate = j.slots;
    _lsAppt.tz = j.timezone || 'Europe/Amsterdam';
    bodyEl.innerHTML = _lsInbRenderSlots(conv);
    // Bind tijd-klikken.
    bodyEl.querySelectorAll('[data-slot-time]').forEach(btn => {
      btn.addEventListener('click', () => {
        const dateStr = btn.getAttribute('data-slot-date');
        const timeStr = btn.getAttribute('data-slot-time');
        _lsInbConfirmAppointment(conv, dateStr, timeStr);
      });
    });
  };
  function _lsInbRenderSlots(conv) {
    const tz = esc(_lsAppt.tz || 'Europe/Amsterdam');
    return `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Tijden in ${tz}</div>
      ${_lsAppt.slotsByDate.map(day => {
        const dateFmt = _lsInbFmtSlotDate(day.date);
        const times = Array.isArray(day.times) ? day.times : [];
        if (!times.length) return '';
        return `<div style="margin-bottom:14px">
          <div style="font-weight:600;font-size:12.5px;margin-bottom:6px;color:var(--text-2)">${esc(dateFmt)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${times.map(t => `<button class="btn btn-ghost btn-sm" data-slot-date="${esc(day.date)}" data-slot-time="${esc(t)}" style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;padding:5px 10px">${esc(t)}</button>`).join('')}
          </div>
        </div>`;
      }).join('')}`;
  }
  function _lsInbFmtSlotDate(iso) {
    try {
      const d = new Date(iso + 'T00:00:00');
      return d.toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' });
    } catch (_) { return iso; }
  }
  async function _lsInbConfirmAppointment(conv, dateStr, timeStr) {
    // Combineer datum + tijd tot Amsterdam-lokale wall-clock -> ISO met TZ-offset.
    // Gebruikt Intl om te bepalen wat de UTC-offset op die datum is (DST-veilig).
    const [Y, M, D] = dateStr.split('-').map(Number);
    const [h, m]    = timeStr.split(':').map(Number);
    const utcMs = Date.UTC(Y, M - 1, D, h, m, 0);
    // Amsterdam-offset op deze wall-clock berekenen.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Amsterdam', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const mp = {}; for (const p of parts) mp[p.type] = p.value;
    const asUtc = Date.UTC(+mp.year, +mp.month - 1, +mp.day, +mp.hour, +mp.minute, +mp.second);
    const offMin = Math.round((asUtc - utcMs) / 60000);
    const scheduledAt = new Date(utcMs - offMin * 60000).toISOString();

    _lsInbCloseModal();
    const naam = _lsInbRowVan(conv);
    const ok = await _lsInbAskConfirm(
      `Afspraak inschieten voor ${naam}?`,
      `${_lsInbFmtSlotDate(dateStr)} om ${timeStr} (${_lsAppt.tz || 'Europe/Amsterdam'})\n\nDit maakt een echte GHL/Zoom-afspraak aan. De call-status komt binnen ~1 min tevoorschijn in het Contacten-overzicht (sync via poll-cron).`,
      { okLabel: 'Ja, plan de afspraak' }
    );
    if (!ok) return;
    _lsAppt.sending = true;
    try {
      const resp = await window.KV.authedFetch('/api/leadsonderhoud-appointment-create', {
        method: 'POST',
        body: JSON.stringify({
          lead_id: conv.lead_id,
          scheduledAt,
          durationMinutes: 30,
        }),
      });
      if (resp.status === 422) {
        const j = await resp.json().catch(() => ({}));
        if (j.code === 'NO_GHL_CONTACT') {
          _lsInbToast('Geen GHL-contact voor deze lead — verstuur eerst een boekingslink (Route B).', 'warn');
          return;
        }
        throw new Error(j.error || 'Configuratie-fout');
      }
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      _lsInbToast('Afspraak ingeschoten — sync loopt (~1 min)', 'ok');
      // Trigger een refresh van de conv-lijst zodat updated preview later te zien is.
      _lsInb.convs.fetched = false;
      queueMicrotask(_lsInbFetchConvs);
    } catch (e) {
      console.warn('[ls-inb] appointment-create fail:', e && e.message);
      _lsInbToast('Afspraak inschieten mislukt: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _lsAppt.sending = false;
    }
  }

  window.__lsInbBookingLinkHelp = () => {
    const conv = _lsInbCurrentConv();
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:10px">Boekingslink versturen (Route B)</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.6;margin-bottom:14px">
        Er is nog geen automatische boekingslink-flow geconfigureerd (geen <code>GHL_BOOKING_URL</code>
        env-var op de server). Voorlopig kan je een boekingslink handmatig plakken in het
        <b>WhatsApp</b>- of <b>mail</b>-compose-veld en versturen — de lead boekt zelf, en
        <code>afspraak_op</code> wordt binnen ~1 min door de bestaande GHL-poll-cron
        gesynchroniseerd (zichtbaar in het Contacten-overzicht).
        <br><br>
        Gebruik <b>Direct inschieten</b> hierboven wanneer je zelf een tijd wilt kiezen én de
        lead een bestaand GHL-contact heeft.
      </div>
      ${conv ? `<div style="padding:10px 12px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);margin-bottom:14px">
        Geselecteerd: <b>${esc(_lsInbRowVan(conv))}</b>${conv.email ? ` · ${esc(conv.email)}` : ''}${conv.phone_number ? ` · ${esc(conv.phone_number)}` : ''}
      </div>` : ''}
      <div style="text-align:right"><button id="lsBookHelpClose" class="btn btn-primary btn-sm">Sluiten</button></div>
    `, { maxWidth: 560 });
    document.getElementById('lsBookHelpClose').addEventListener('click', _lsInbCloseModal);
  };

  function gesprekkenView() {
    // Eerste render triggert fetch + poll.
    if (!_lsInb.convs.fetched && !_lsInb.convs.loading) {
      queueMicrotask(_lsInbFetchConvs);
    }
    const rowsAll = asArr(_lsInb.convs.items);
    // v=19: client-side gelezen/ongelezen-filter over item.unread.
    const flt = _lsInb.filter || 'all';
    const rows = flt === 'unread'
      ? rowsAll.filter(r => (r.unread || 0) > 0)
      : flt === 'read'
        ? rowsAll.filter(r => (r.unread || 0) === 0)
        : rowsAll;
    const unreadCnt = rowsAll.filter(r => (r.unread || 0) > 0).length;
    const readCnt   = rowsAll.length - unreadCnt;
    // v=20 KRITIEKE FIX: GEEN auto-select fallback op rows[0] bij filter-switch.
    // Voorheen ontstond een cascade: filter=unread → _lsInb.sel valt buiten
    // rows → sel=rows[0] → _lsInbLoadThread(sel) → mark_as_read=true → conv
    // verwijderd uit unread-set → render → sel=nieuwe rows[0] → cascade tot
    // alles gelezen was. De filter is PUUR CLIENT-SIDE; klikken op een chip
    // mag NOOIT een mark-read triggeren. Alleen expliciete rij-klik door de
    // user opent een thread (via __onbRowClick / _lsInbSelect).
    const sel = rows.find(r => String(r.lead_id) === String(_lsInb.sel)) || null;
    if (sel && _lsInb.thread.leadId !== sel.lead_id && !_lsInb.thread.loading) {
      queueMicrotask(() => _lsInbLoadThread(sel.lead_id));
    }
    queueMicrotask(_lsInbPaintThread);
    queueMicrotask(_lsInbStartPoll);

    const listHtml = _lsInb.convs.loading && !rows.length
      ? renderSkeletonRows(5)
      : rows.length
        ? rows.map(_lsInbRenderRow).join('')
        : `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">Nog geen lead-gesprekken.</div>`;

    const filterChip = (v, label, count) => `<button class="chip ${flt === v ? 'on' : ''}" onclick="window.__lsInbSetFilter('${v}')" style="font-size:11px;padding:3px 9px">${label}${count != null ? ` <span style="opacity:.7">(${count})</span>` : ''}</button>`;
    return `<div class="ls-inb-split" style="display:flex;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
      ${_lsExtModalHtml()}
      <div id="lsInbList" style="width:360px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto">
        <div style="padding:11px 14px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between;align-items:center">
          <span>Lead-gesprekken (WA + mail)</span>
          <span>${rows.length}${rows.length !== rowsAll.length ? ' / ' + rowsAll.length : ''} leads</span>
        </div>
        <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;gap:5px;flex-wrap:wrap">
          ${filterChip('all', 'Alle', rowsAll.length)}
          ${filterChip('unread', 'Ongelezen', unreadCnt)}
          ${filterChip('read', 'Gelezen', readCnt)}
        </div>
        ${_lsInb.convs.error ? `<div style="padding:16px;color:var(--rose);font-size:12.5px">⚠ ${esc(_lsInb.convs.error)}</div>` : ''}
        ${listHtml}
      </div>
      ${sel
        ? _lsInbRenderRight(sel)
        : `<div class="ls-inb-right" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een lead</div>`}
    </div>`;
  }


  /* ══════════════════════════════════════════════════════════════════
     TAB 6 — STATISTIEKEN (afgeleide KPIs uit dezelfde bronnen)
     ══════════════════════════════════════════════════════════════════ */
  function statsView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(fetchOverzicht);
    if (!_live.droogloop.fetched && !_live.droogloop.loading && !_live.droogloop.error) queueMicrotask(fetchDroogloop);
    if (!_live.leadsAll.fetched && !_live.leadsAll.loading && !_live.leadsAll.error) queueMicrotask(fetchLeadCounts);

    const ov = _live.overzicht.data;
    const dr = _live.droogloop.data;
    const lAll = _live.leadsAll.data;
    const lMet = _live.leadsMet.data;

    const totalLeads = lAll ? lAll.total : null;
    const geboekt    = lMet ? lMet.total : null;
    const zonder     = (totalLeads != null && geboekt != null) ? Math.max(0, totalLeads - geboekt) : null;
    const conversie  = (totalLeads != null && geboekt != null && totalLeads > 0)
      ? Math.round((geboekt / totalLeads) * 100) : null;
    const lopend = ov ? ov.items.length : null;
    const warm   = ov ? ov.items.filter(r => Number(r.score || 0) >= 15).length : null;
    const midden = ov ? ov.items.filter(r => { const s = Number(r.score || 0); return s >= 5 && s < 15; }).length : null;
    const koud   = ov ? ov.items.filter(r => Number(r.score || 0) < 5).length : null;
    const droog7 = dr ? dr.totaal : null;

    const kpi = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    return `
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:14px">
        Er is (nog) geen dedicated stats-endpoint. Deze KPIs zijn afgeleid uit dezelfde bronnen
        als Overzicht (<code>leads-list</code>, <code>leadsonderhoud-overzicht</code>,
        <code>leadsonderhoud-droogloop-log</code>). Voor engagement-metrics (open-rate,
        klik-rate) is een nieuw endpoint nodig — dat pakken we in BROK 2 op als de bulk-flow
        landt.
      </div>
      <div style="margin-bottom:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);font-weight:600">Doel: call boeken</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
        ${kpi('Leads totaal',   totalLeads, 'over alle trajecten', 'text-1')}
        ${kpi('Call geboekt',   geboekt,    conversie != null ? conversie + '%' : null, 'emerald')}
        ${kpi('Nog geen call',  zonder,     'nurture-kandidaten', 'amber')}
        ${kpi('Conversie',      conversie != null ? conversie + '%' : null, 'geboekt / totaal', 'blue')}
      </div>
      <div style="margin-bottom:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);font-weight:600">Warmte-verdeling (lopende proefperiodes)</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
        ${kpi('Lopend',       lopend, null, 'text-1')}
        ${kpi('Warm (15+)',   warm,   null, 'rose')}
        ${kpi('Midden (5-14)',midden, null, 'amber')}
        ${kpi('Koud (<5)',    koud,   null, 'blue')}
      </div>
      <div style="margin-top:14px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);font-size:12.5px;color:var(--text-2);line-height:1.55">
        <b>Droogloop 7d:</b> ${droog7 == null ? '<span style="opacity:.5">…</span>' : esc(String(droog7))} berichten die de motor wilde sturen maar niet mocht (geen toestemming / al gestuurd / geen sjabloon-match).
      </div>`;
  }

  /* ── Skeleton (dashboard-pattern) ──────────────────────────────────── */
  function renderSkeletonRows(n) {
    return Array.from({ length: n }).map(() => `
      <div style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);opacity:.5">
        <div style="width:32px;height:32px;background:var(--surface-2);border-radius:50%"></div>
        <div style="flex:1">
          <div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:6px"></div>
          <div style="height:11px;width:85%;background:var(--surface-2);border-radius:4px"></div>
        </div>
      </div>`).join('');
  }

  /* ══════════════════════════════════════════════════════════════════
     TABS 6-8 — BRONNEN / OPSTARTSESSIES / VRAGENLIJST (v=15, 2026-08-27)
     ══════════════════════════════════════════════════════════════════
     v=15: verhuisd van modules/leadsonderhoud.html (v1) naar deze v2-view
     zodat de zichtbare Leadsonderhoud-shell (klanten-v2 #leadsonderhoud)
     Opstartsessies + Bronnen + Vragenlijst-tabs krijgt. De v1-editor voor
     volledige CRUD (bewerken vragen/opties/publiceer, bronnen toevoegen,
     detail-modal opstartsessies) blijft via directe URL beschikbaar op
     /modules/leadsonderhoud.html?tab=... — de "Beheren →"-knop in elke tab
     linkt daarheen (opent in nieuw tabblad). Endpoints ongewijzigd:
     - booking-sources-list             → tab Bronnen
     - leadsonderhoud-opstartsessies-list → tab Opstartsessies
     - leadsonderhoud-quiz-lijst        → tab Vragenlijst
     RBAC via de endpoints (leads.view / leads.update, zoals de rest van
     Leadsonderhoud).
     ══════════════════════════════════════════════════════════════════ */

  async function fetchBronnen(force) {
    const st = _live.bronnen;
    const key = 'p=' + st.periode;
    if (!force && st.lastKey === key && st.fetched && !st.error) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    // v=17 (2026-08-27 regressie-fix): direct authedJson met echte error-
    // details. tryFetch slikt de exception-message en toont een generiek
    // "Kon bronnen niet laden" — onmogelijk om zonder Vercel-log de
    // root-cause te vinden. Nu propageren we de HTTP-status + body-error
    // + eventuele DB-code naar st.error zodat 'ie op scherm zichtbaar is.
    try {
      const j = await window.KV.authedJson('/api/booking-sources-list?periode=' + encodeURIComponent(st.periode));
      if (seq !== st._seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st._seq) return;
      const status = e?.status ? ' (HTTP ' + e.status + ')' : '';
      const code   = e?.body?.code ? ' [' + e.body.code + ']' : '';
      const detail = e?.body?.detail ? ' — ' + String(e.body.detail).slice(0, 200) : '';
      st.error = 'Kon bronnen niet laden' + status + code + detail;
      console.error('[ls-v2] bronnen fetch fail:', e?.status, e?.body || e?.message);
    }
    st.loading = false; st.fetched = true;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchOpstartsessies(force) {
    const st = _live.opstartsessies;
    const key = 'p=' + st.periode + '&r=' + st.resultaat + '&b=' + st.bron;
    if (!force && st.lastKey === key && st.fetched && !st.error) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const qs = 'periode=' + encodeURIComponent(st.periode)
      + '&resultaat=' + encodeURIComponent(st.resultaat)
      + (st.bron ? '&bron=' + encodeURIComponent(st.bron) : '');
    const j = await tryFetch('opstartsessies', '/api/leadsonderhoud-opstartsessies-list?' + qs);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon opstartsessies niet laden'; else st.data = j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchVragenlijst() {
    const st = _live.vragenlijst; if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('vragenlijst', '/api/leadsonderhoud-quiz-lijst');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j) st.error = 'Kon vragenlijsten niet laden'; else st.data = { items: asArr(j.items) };
    if (window.DFO?.render) window.DFO.render();
  }

  // Filter-setters (module-scope, aangeroepen door DFO.setF-style inline handlers).
  window._lsSetBronPeriode = function(p){ _live.bronnen.periode = p; fetchBronnen(true); };
  window._lsSetOpPeriode   = function(p){ _live.opstartsessies.periode = p; fetchOpstartsessies(true); };
  window._lsSetOpResultaat = function(r){ _live.opstartsessies.resultaat = r; fetchOpstartsessies(true); };
  window._lsSetOpBron      = function(sel){ _live.opstartsessies.bron = String(sel.value || ''); fetchOpstartsessies(true); };
  window._lsCopyLink = function(url, btn){
    try { navigator.clipboard.writeText(url); if (btn){ const t = btn.textContent; btn.textContent = 'Gekopieerd ✓'; setTimeout(()=>{ btn.textContent = t; }, 1200); } }
    catch (_) { prompt('Kopieer de link:', url); }
  };

  // v=16 (2026-08-27): _lsBeheerKnop verwijderd — alles is nu v2-native.
  // Zie modal-implementaties hieronder (opstart-detail / bron-form / quiz-editor).

  /* ══════════════════════════════════════════════════════════════════
     v=16: BRONNEN — v2-native inline CRUD via booking-sources-upsert.
     Beheren-knop verwijderd (geen v1-link meer); acties per rij in-place.
     Nieuwe-bron form onder de tabel. Kopieerbare link + calls-per-bron
     ongewijzigd.
     ══════════════════════════════════════════════════════════════════ */

  // BP2 Deel A: staff-lijst voor Setter-koppeling in Bronnen-tab.
  // Simpele cache: 1 fetch per pagina-load, verse waardes bij herbezoek.
  const _lsStaff = { loading: false, items: null, fetchedAt: 0 };
  async function _lsFetchStaff(force) {
    if (!force && _lsStaff.items && (Date.now() - _lsStaff.fetchedAt) < 5 * 60 * 1000) return _lsStaff.items;
    if (_lsStaff.loading) return _lsStaff.items || [];
    _lsStaff.loading = true;
    try {
      const j = await tryFetch('ls-staff', '/api/profiles-list?staff_only=1');
      _lsStaff.items = (j && Array.isArray(j.members)) ? j.members : [];
      _lsStaff.fetchedAt = Date.now();
    } catch (_) { _lsStaff.items = _lsStaff.items || []; }
    _lsStaff.loading = false;
    return _lsStaff.items;
  }
  window._lsBronSetOwner = async function(idx, userId){
    const b = (_live.bronnen.data?.items || [])[idx]; if (!b) return;
    const owner = (userId === '' || userId === '__none__') ? null : String(userId);
    try {
      await window.KV.authedJson('/api/booking-sources-upsert', {
        method: 'POST',
        body: JSON.stringify({ id: b.id, slug: b.slug, label: b.label, actief: b.actief, owner_user_id: owner }),
      });
      window.KV.toast(owner ? 'Setter gekoppeld.' : 'Setter losgekoppeld.', 'ok');
      fetchBronnen(true);
    } catch (e) { window.KV.toast('Wijzigen mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
  };

  const _lsBronForm = { slug: '', label: '', busy: false, error: null };
  window._lsBronSetSlug  = function(el){ _lsBronForm.slug  = String(el.value || '').trim().toLowerCase(); };
  window._lsBronSetLabel = function(el){ _lsBronForm.label = String(el.value || '').trim(); };
  window._lsBronToevoegen = async function(){
    if (_lsBronForm.busy) return;
    const slug  = _lsBronForm.slug;
    const label = _lsBronForm.label;
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) { window.KV.toast('Slug moet lowercase alfanumeriek + hyphen zijn (max 64).', 'warn'); return; }
    if (label.length < 1 || label.length > 120)  { window.KV.toast('Label vereist (1-120 tekens).', 'warn'); return; }
    _lsBronForm.busy = true; _lsBronForm.error = null; if (window.DFO?.render) window.DFO.render();
    try {
      await window.KV.authedJson('/api/booking-sources-upsert', {
        method: 'POST', body: JSON.stringify({ slug, label, actief: true }),
      });
      window.KV.toast('Bron "' + label + '" toegevoegd.', 'ok');
      _lsBronForm.slug = ''; _lsBronForm.label = ''; _lsBronForm.busy = false;
      fetchBronnen(true);
    } catch (e) {
      window.KV.toast('Toevoegen mislukt: ' + (e?.message || 'onbekend'), 'warn');
      _lsBronForm.busy = false; if (window.DFO?.render) window.DFO.render();
    }
  };
  window._lsBronBewerken = async function(idx){
    const b = (_live.bronnen.data?.items || [])[idx]; if (!b) return;
    const nieuwLabel = prompt('Nieuw label voor "' + b.slug + '":', b.label);
    if (nieuwLabel == null) return;
    const label = String(nieuwLabel).trim(); if (!label) return;
    try {
      await window.KV.authedJson('/api/booking-sources-upsert', {
        method: 'POST', body: JSON.stringify({ id: b.id, slug: b.slug, label, actief: b.actief }),
      });
      window.KV.toast('Bron bijgewerkt.', 'ok'); fetchBronnen(true);
    } catch (e) { window.KV.toast('Bewerken mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
  };
  window._lsBronToggle = async function(idx){
    const b = (_live.bronnen.data?.items || [])[idx]; if (!b) return;
    try {
      await window.KV.authedJson('/api/booking-sources-upsert', {
        method: 'POST', body: JSON.stringify({ id: b.id, slug: b.slug, label: b.label, actief: !b.actief }),
      });
      window.KV.toast(b.actief ? 'Bron gedeactiveerd.' : 'Bron geactiveerd.', 'ok'); fetchBronnen(true);
    } catch (e) { window.KV.toast('Wijzigen mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
  };
  window._lsBronRegistreren = async function(idx){
    const b = (_live.bronnen.data?.items || [])[idx]; if (!b) return;
    const suggest = b.slug.charAt(0).toUpperCase() + b.slug.slice(1);
    const lbl = prompt('Label voor "' + b.slug + '" (typo of nieuwe bron):', suggest);
    if (lbl == null) return;
    const label = String(lbl).trim(); if (!label) return;
    try {
      await window.KV.authedJson('/api/booking-sources-upsert', {
        method: 'POST', body: JSON.stringify({ slug: b.slug, label, actief: true }),
      });
      window.KV.toast('Bron geregistreerd.', 'ok'); fetchBronnen(true);
    } catch (e) { window.KV.toast('Registreren mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
  };

  function bronnenView() {
    if (!_live.bronnen.fetched && !_live.bronnen.loading && !_live.bronnen.error) queueMicrotask(() => fetchBronnen(false));
    // BP2 Deel A: staff-lijst lazy fetch voor de setter-dropdown.
    if (!_lsStaff.items && !_lsStaff.loading) queueMicrotask(() => _lsFetchStaff(false).then(() => { if (window.DFO?.render) window.DFO.render(); }));
    const st = _live.bronnen;
    const data = st.data || { items: [], total_calls: 0 };
    const items = data.items || [];
    const staff = _lsStaff.items || [];
    const periodes = [['week','Deze week'],['maand','Deze maand'],['alles','Alles']];
    const filterChips = periodes.map(([k,l]) => `<button class="chip ${st.periode===k?'on':''}" style="font-size:11.5px;padding:4px 10px" onclick="window._lsSetBronPeriode('${k}')">${esc(l)}</button>`).join('');
    const rows = items.length ? items.map((b, i) => {
      const url = 'https://deforexopleiding.nl/agenda/' + b.slug;
      const statusBadge = b.is_registered
        ? (b.actief
            ? '<span style="color:var(--emerald);font-weight:600;font-size:11.5px">● Actief</span>'
            : '<span style="color:var(--text-3);font-weight:600;font-size:11.5px">○ Uit</span>')
        : '<span style="color:var(--amber);font-weight:600;font-size:11.5px" title="Slug komt op boekingen voor maar staat niet in de bronnenlijst">⚠ Onbekend</span>';
      const acties = b.is_registered
        ? `<button class="btn btn-secondary" style="font-size:11px;padding:3px 8px;margin-right:4px" onclick="window._lsBronBewerken(${i})">Bewerken</button>
           <button class="btn btn-secondary" style="font-size:11px;padding:3px 8px" onclick="window._lsBronToggle(${i})">${b.actief ? 'Deactiveren' : 'Activeren'}</button>`
        : `<button class="btn btn-primary" style="font-size:11px;padding:3px 8px" onclick="window._lsBronRegistreren(${i})" title="Toevoegen aan bronnenlijst met deze slug">Registreren</button>`;
      // BP2 Deel A: setter-koppeling per bron.
      const setterCell = b.is_registered
        ? `<select onchange="window._lsBronSetOwner(${i}, this.value)" style="padding:4px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:11.5px;max-width:180px">
            <option value="__none__" ${!b.owner_user_id ? 'selected' : ''}>— geen —</option>
            ${staff.map((s) => `<option value="${esc(s.id)}" ${String(b.owner_user_id || '') === String(s.id) ? 'selected' : ''}>${esc(s.full_name || s.email || s.id)}</option>`).join('')}
          </select>`
        : '<span style="color:var(--text-3);font-size:11px">—</span>';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px">
          <div style="font-weight:600">${esc(b.label)}</div>
          <div style="color:var(--text-3);font-size:11px;font-family:var(--mono,monospace)">${esc(b.slug)}</div>
        </td>
        <td style="padding:8px 10px">${statusBadge}</td>
        <td style="padding:8px 10px">${setterCell}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${b.calls || 0}</td>
        <td style="padding:8px 10px">
          <div style="display:flex;align-items:center;gap:6px">
            <code style="background:var(--surface-2);padding:2px 6px;border-radius:4px;font-size:11.5px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(url)}</code>
            <button class="btn btn-secondary" style="font-size:11px;padding:3px 8px" onclick="window._lsCopyLink('${esc(url)}', this)">Kopiëren</button>
          </div>
        </td>
        <td style="padding:8px 10px;white-space:nowrap">${acties}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Nog geen bronnen — voeg er hieronder één toe.'}</td></tr>`;

    return `
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:12px">
        Attributie-bronnen voor <code>deforexopleiding.nl/agenda/&lt;slug&gt;</code>. Elke link telt binnenkomende Opstartsessie-boekingen. Onbekende/typo-slugs verschijnen apart en blijven telbaar.
      </div>
      ${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap">
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Periode</span>
          ${filterChips}
        </div>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">${st.loading ? 'Laden…' : (`${data.total_calls || 0} geboekte Opstartsessies · ${st.periode === 'week' ? 'deze week' : st.periode === 'maand' ? 'deze maand' : 'alle tijd'}`)}</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
                <th style="padding:8px 10px">Bron</th>
                <th style="padding:8px 10px">Status</th>
                <th style="padding:8px 10px">Setter</th>
                <th style="padding:8px 10px;text-align:right">Calls</th>
                <th style="padding:8px 10px">Link</th>
                <th style="padding:8px 10px">Acties</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
      <div style="margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px">
        <div style="font-weight:600;font-size:13px;margin-bottom:10px">Nieuwe bron toevoegen</div>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:0 0 220px">
            <label style="display:block;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Slug (URL)</label>
            <input type="text" placeholder="bv. instagram-story" value="${esc(_lsBronForm.slug)}" oninput="window._lsBronSetSlug(this)" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-family:var(--mono,monospace);font-size:12.5px" ${_lsBronForm.busy ? 'disabled' : ''}>
          </div>
          <div style="flex:1;min-width:200px">
            <label style="display:block;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Label</label>
            <input type="text" placeholder="bv. Instagram Story" value="${esc(_lsBronForm.label)}" oninput="window._lsBronSetLabel(this)" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:12.5px" ${_lsBronForm.busy ? 'disabled' : ''}>
          </div>
          <button class="btn btn-primary" style="font-size:12.5px;padding:7px 16px" onclick="window._lsBronToevoegen()" ${_lsBronForm.busy ? 'disabled' : ''}>${_lsBronForm.busy ? 'Bezig…' : '+ Toevoegen'}</button>
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-3)">Slug = lowercase, alfanumeriek + hyphen (max 64 tekens). Wordt onderdeel van de link.</div>
      </div>`;
  }

  function opstartsessiesView() {
    if (!_live.opstartsessies.fetched && !_live.opstartsessies.loading && !_live.opstartsessies.error) queueMicrotask(() => fetchOpstartsessies(false));
    const st = _live.opstartsessies;
    const data = st.data || { items: [], total: 0, bronnen: [] };
    const items = data.items || [];
    const bronnen = data.bronnen || [];
    const periodes = [['week','Deze week'],['maand','Deze maand'],['alles','Alles']];
    const uitk = [['alle','Alle'],['toegelaten','Toegelaten'],['afgewezen','Afgewezen']];
    const perChips = periodes.map(([k,l]) => `<button class="chip ${st.periode===k?'on':''}" style="font-size:11.5px;padding:4px 10px" onclick="window._lsSetOpPeriode('${k}')">${esc(l)}</button>`).join('');
    const resChips = uitk.map(([k,l]) => `<button class="chip ${st.resultaat===k?'on':''}" style="font-size:11.5px;padding:4px 10px" onclick="window._lsSetOpResultaat('${k}')">${esc(l)}</button>`).join('');
    const bronOpts = `<option value="" ${st.bron ? '' : 'selected'}>Alle bronnen</option>`
      + bronnen.map(b => `<option value="${esc(b.slug)}" ${st.bron===b.slug?'selected':''}>${esc(b.label)}</option>`).join('');
    const kortDt = (iso) => {
      if (!iso) return '—';
      try { const d = new Date(iso); return d.toLocaleString('nl-NL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }); }
      catch(_){ return String(iso); }
    };
    const rows = items.length ? items.map(s => {
      const badge = s.resultaat === 'toegelaten'
        ? '<span style="background:var(--emerald-soft);color:var(--emerald);padding:2px 8px;border-radius:12px;font-size:11.5px;font-weight:600">Toegelaten</span>'
        : '<span style="background:var(--surface-2);color:var(--text-3);padding:2px 8px;border-radius:12px;font-size:11.5px;font-weight:600">Afgewezen</span>';
      const akkoord = s.noshow_akkoord ? '<span style="color:var(--emerald);font-weight:600">✓</span>' : '<span style="color:var(--text-3)">–</span>';
      const afsp = s.heeft_afspraak ? '<span style="color:var(--emerald);font-weight:600">✓ Geboekt</span>' : '<span style="color:var(--text-3)">–</span>';
      const contact = [s.email, s.telefoon].filter(Boolean).join(' · ');
      return `<tr data-op-row="${esc(s.id)}" style="border-bottom:1px solid var(--border);cursor:pointer" onclick="window._lsOpenOpstartDetail('${esc(s.id)}')">
        <td style="padding:8px 10px;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--text-3);font-size:11.5px" title="${esc(s.created_at)}">${esc(kortDt(s.created_at))}</td>
        <td style="padding:8px 10px">
          <div style="font-weight:600">${esc(s.naam || '—')}</div>
          <div style="color:var(--text-3);font-size:11px">${esc(contact || '—')}</div>
        </td>
        <td style="padding:8px 10px">${esc(s.bron_label)}<div style="color:var(--text-3);font-size:10.5px;font-family:var(--mono,monospace)">${esc(s.booking_source || '—')}</div></td>
        <td style="padding:8px 10px">${badge}</td>
        <td style="padding:8px 10px;text-align:center">${akkoord}</td>
        <td style="padding:8px 10px">${esc(s.gekozen_slot || '—')}</td>
        <td style="padding:8px 10px">${afsp}</td>
        <td style="padding:8px 10px"><button class="btn btn-secondary" style="font-size:11px;padding:3px 8px" onclick="event.stopPropagation();window._lsOpenOpstartDetail('${esc(s.id)}')">Detail</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8" style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Geen submissions in dit venster.'}</td></tr>`;

    return `
      ${_lsOpstartDetailModalHtml()}
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:12px">
        Alles wat leads op <code>deforexopleiding.nl/agenda</code> invullen — inclusief afgewezen leads. Klik een rij voor de vragenlijst-antwoorden.
      </div>
      ${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:10px">
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Periode</span>
          ${perChips}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Resultaat</span>
          ${resChips}
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bron</span>
          <select onchange="window._lsSetOpBron(this)" style="padding:4px 8px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:12px;background:var(--surface)">${bronOpts}</select>
        </div>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">${st.loading ? 'Laden…' : ((data.total || items.length) + ' submissions')}</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
                <th style="padding:8px 10px">Wanneer</th>
                <th style="padding:8px 10px">Lead</th>
                <th style="padding:8px 10px">Bron</th>
                <th style="padding:8px 10px">Resultaat</th>
                <th style="padding:8px 10px;text-align:center" title="€50-no-show-akkoord">Akkoord</th>
                <th style="padding:8px 10px">Gekozen moment</th>
                <th style="padding:8px 10px">Afspraak</th>
                <th style="padding:8px 10px"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  function vragenlijstView() {
    if (!_live.vragenlijst.fetched && !_live.vragenlijst.loading && !_live.vragenlijst.error) queueMicrotask(fetchVragenlijst);
    const st = _live.vragenlijst;
    const items = (st.data && st.data.items) || [];
    const rows = items.length ? items.map(q => {
      const live = q.live_versie ? `live v${q.live_versie}` : 'niet gepubliceerd';
      const actief = q.is_active !== false;
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px">
          <div style="font-weight:600">${esc(q.naam)}</div>
          <div style="color:var(--text-3);font-size:11px;font-family:var(--mono,monospace)">${esc(q.slug)}</div>
        </td>
        <td style="padding:8px 10px">${actief ? '<span style="color:var(--emerald);font-weight:600;font-size:11.5px">● Actief</span>' : '<span style="color:var(--text-3);font-size:11.5px">○ Uit</span>'}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${q.drempel}</td>
        <td style="padding:8px 10px;text-align:right;font-variant-numeric:tabular-nums">${q.vragen_actief || 0}<span style="color:var(--text-3);font-size:11px"> / ${q.vragen_totaal || 0}</span></td>
        <td style="padding:8px 10px"><span style="font-family:var(--mono,monospace);font-size:11.5px">${esc(live)}</span></td>
        <td style="padding:8px 10px"><button class="btn btn-primary" style="font-size:11.5px;padding:4px 12px" onclick="window._lsOpenQuizEditor('${esc(q.slug)}')">Bewerken</button></td>
      </tr>`;
    }).join('') : `<tr><td colspan="6" style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Geen vragenlijsten gevonden.'}</td></tr>`;

    return `
      ${_lsQuizEditorModalHtml()}
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:12px">
        Vragenlijsten die de publieke pagina's op <code>deforexopleiding.nl</code> lezen. De <b>werk-versie</b> bewerkt en publiceer je hier; de website ziet alleen de gepubliceerde snapshot.
      </div>
      ${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
        <span style="font-size:12px;color:var(--text-3)">${st.loading ? 'Laden…' : (items.length + ' vragenlijst' + (items.length === 1 ? '' : 'en'))}</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:12.5px">
            <thead>
              <tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
                <th style="padding:8px 10px">Naam</th>
                <th style="padding:8px 10px">Status</th>
                <th style="padding:8px 10px;text-align:right">Drempel</th>
                <th style="padding:8px 10px;text-align:right">Actieve vragen</th>
                <th style="padding:8px 10px">Publicatie</th>
                <th style="padding:8px 10px"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     v=16 MODAL — Opstartsessie detail (read-only, endpoint:
     /api/leadsonderhoud-opstartsessies-detail)
     ══════════════════════════════════════════════════════════════════ */
  const _lsOpDetail = { open: false, id: null, loading: false, error: null, data: null };
  window._lsOpenOpstartDetail = async function(id){
    _lsOpDetail.open = true; _lsOpDetail.id = id; _lsOpDetail.loading = true; _lsOpDetail.error = null; _lsOpDetail.data = null;
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-opstartsessies-detail?id=' + encodeURIComponent(id));
      _lsOpDetail.loading = false; _lsOpDetail.data = j?.item || null;
      if (!_lsOpDetail.data) _lsOpDetail.error = 'Geen data teruggekregen.';
    } catch (e) {
      _lsOpDetail.loading = false; _lsOpDetail.error = e?.message || 'onbekend';
    }
    if (window.DFO?.render) window.DFO.render();
  };
  window._lsCloseOpstartDetail = function(){ _lsOpDetail.open = false; _lsOpDetail.data = null; if (window.DFO?.render) window.DFO.render(); };
  function _lsOpstartDetailModalHtml(){
    if (!_lsOpDetail.open) return '';
    const kortDt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); } catch(_){ return String(iso); } };
    let body = '';
    if (_lsOpDetail.loading) {
      body = `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">Laden…</div>`;
    } else if (_lsOpDetail.error) {
      body = `<div style="padding:24px;color:var(--rose)">⚠ ${esc(_lsOpDetail.error)}</div>`;
    } else if (_lsOpDetail.data) {
      const s = _lsOpDetail.data;
      const badge = s.resultaat === 'toegelaten'
        ? '<span style="background:var(--emerald-soft);color:var(--emerald);padding:4px 12px;border-radius:12px;font-size:12.5px;font-weight:600">Toegelaten</span>'
        : '<span style="background:var(--surface-2);color:var(--text-3);padding:4px 12px;border-radius:12px;font-size:12.5px;font-weight:600">Afgewezen</span>';
      const akkoord = s.noshow_akkoord ? '<span style="color:var(--emerald);font-weight:600">✓ Ja</span>' : '<span style="color:var(--text-3)">Nee</span>';
      const antwoordenHtml = (s.antwoorden || []).map((a, i) => {
        const afw = a.afwijzer ? '<span style="background:var(--rose-soft);color:var(--rose);padding:1px 6px;border-radius:8px;font-size:10.5px;margin-left:6px">afwijzer</span>' : '';
        return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Vraag ${i + 1}</div>
          <div style="font-weight:600;margin:3px 0">${esc(a.vraag || '')}</div>
          <div style="font-size:12.5px">Antwoord: <b>${esc(a.gekozen_label || '—')}</b> <span style="color:var(--text-3);font-size:11.5px">(${Number(a.punten) || 0} punten)</span>${afw}</div>
        </div>`;
      }).join('') || `<div style="color:var(--text-3);padding:12px 0">Geen antwoorden opgeslagen.</div>`;
      let afspraakHtml = '';
      if (s.afspraak) {
        afspraakHtml = `<div style="margin-top:14px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm)">
          <div style="font-weight:600;margin-bottom:4px;font-size:12.5px">Gekoppelde afspraak</div>
          <div style="font-size:12.5px">Ingepland op: <b>${esc(kortDt(s.afspraak.scheduled_at))}</b> — status: <b>${esc(s.afspraak.status || '—')}</b></div>
          ${s.afspraak.zoom_join_url ? `<div style="font-size:12px;margin-top:4px"><a href="${esc(s.afspraak.zoom_join_url)}" target="_blank" rel="noopener" style="color:var(--brand)">Zoom-link openen ↗</a></div>` : ''}
        </div>`;
      } else if (s.resultaat === 'toegelaten') {
        afspraakHtml = `<div style="margin-top:14px;padding:10px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55">Toegelaten, maar nog geen afspraak geboekt (lead heeft niet doorgeklikt na akkoord).</div>`;
      }
      body = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:14px">
          <div>
            <div style="font-size:18px;font-weight:600">${esc(s.naam || 'Anonieme submission')}</div>
            <div style="color:var(--text-3);font-size:12px">${esc([s.email, s.telefoon].filter(Boolean).join(' · ') || '—')}</div>
            <div style="color:var(--text-3);font-size:11.5px;margin-top:2px;font-family:var(--mono,monospace)">${esc(kortDt(s.created_at))}</div>
          </div>
          <div>${badge}</div>
        </div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);margin-bottom:14px">
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bron</div><b>${esc(s.bron_label)}</b><div style="font-family:var(--mono,monospace);font-size:11px;color:var(--text-3)">${esc(s.booking_source || '—')}</div></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Score</div><b>${s.score != null ? s.score : '—'}</b><span style="color:var(--text-3)"> / drempel ${s.drempel != null ? s.drempel : '—'}</span></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">€50 akkoord</div><b>${akkoord}</b></div>
          <div><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Gekozen moment</div><b>${esc(s.gekozen_slot || '—')}</b></div>
        </div>
        <div>
          <div style="font-weight:600;margin-bottom:8px;font-size:13px">Vragenlijst-antwoorden</div>
          ${antwoordenHtml}
        </div>
        ${afspraakHtml}`;
    }
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window._lsCloseOpstartDetail()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(720px,100%);max-height:90vh;overflow-y:auto">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);gap:10px;position:sticky;top:0;background:var(--surface);z-index:1">
          <div style="font-size:14px;font-weight:600">Opstartsessie-submission</div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window._lsCloseOpstartDetail()">✕</button>
        </div>
        <div style="padding:16px 20px">${body}</div>
      </div>
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     v=16 MODAL — Vragenlijst-editor (v2-native, endpoints:
     /api/leadsonderhoud-quiz (GET), /-quiz-opslaan (POST),
     /-quiz-publiceren (POST), /-quiz-versies (GET), /-quiz-rollback (POST))
     Werk-versie CRUD + Publiceren + Versies-lijst met rollback.
     ══════════════════════════════════════════════════════════════════ */
  const _lsQuizEd = {
    open: false, slug: null, loading: false, error: null,
    quiz: null, vragen: [], live: null,   // werk-versie state
    busy: null,                            // 'save'|'publish'|'load' | null
    versies: { open: false, loading: false, items: [], error: null },
  };
  window._lsOpenQuizEditor = async function(slug){
    _lsQuizEd.open = true; _lsQuizEd.slug = String(slug || '');
    _lsQuizEd.loading = true; _lsQuizEd.error = null;
    _lsQuizEd.quiz = null; _lsQuizEd.vragen = []; _lsQuizEd.live = null;
    _lsQuizEd.versies = { open: false, loading: false, items: [], error: null };
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-quiz?slug=' + encodeURIComponent(slug));
      _lsQuizEd.quiz = j?.quiz || null;
      _lsQuizEd.vragen = Array.isArray(j?.vragen) ? j.vragen : [];
      _lsQuizEd.live = j?.live || null;
    } catch (e) { _lsQuizEd.error = e?.message || 'onbekend'; }
    _lsQuizEd.loading = false;
    if (window.DFO?.render) window.DFO.render();
  };
  window._lsCloseQuizEditor = function(){ _lsQuizEd.open = false; if (window.DFO?.render) window.DFO.render(); };

  // DOM-sync: lees huidige input-waardes terug in state (analoog aan v1 leesQuizDom).
  function _lsQuizReadDom(){
    if (!_lsQuizEd.quiz) return;
    const naamEl = document.querySelector('[data-lq-field="naam"]');
    const drmEl  = document.querySelector('[data-lq-field="drempel"]');
    const actEl  = document.querySelector('[data-lq-field="is_active"]');
    if (naamEl) _lsQuizEd.quiz.naam = String(naamEl.value || '').trim();
    if (drmEl)  _lsQuizEd.quiz.drempel = Number(drmEl.value) || 0;
    if (actEl)  _lsQuizEd.quiz.is_active = !!actEl.checked;
    const vragen = [];
    document.querySelectorAll('[data-lq-vraag]').forEach((vEl) => {
      const vi = Number(vEl.getAttribute('data-lq-vraag'));
      const oud = _lsQuizEd.vragen[vi] || {};
      const labEl = vEl.querySelector('[data-lq-vlabel]');
      const actVE = vEl.querySelector('[data-lq-vactive]');
      const opties = [];
      vEl.querySelectorAll('[data-lq-opt]').forEach((oEl) => {
        const olab = oEl.querySelector('[data-lq-olabel]');
        const opnt = oEl.querySelector('[data-lq-opunten]');
        const oafw = oEl.querySelector('[data-lq-oafwijzer]');
        opties.push({
          label: olab ? String(olab.value || '').trim() : '',
          punten: Number(opnt ? opnt.value : 0) || 0,
          afwijzer: !!(oafw && oafw.checked),
        });
      });
      vragen.push({
        id: oud.id || null,
        label: labEl ? String(labEl.value || '').trim() : '',
        options: opties,
        active: actVE ? !!actVE.checked : true,
      });
    });
    _lsQuizEd.vragen = vragen;
  }
  window._lsQuizAction = function(act, i, oi){
    _lsQuizReadDom();
    const vragen = _lsQuizEd.vragen;
    if (act === 'add-vraag') vragen.push({ id: null, label: '', options: [{ label: '', punten: 0, afwijzer: false }], active: true });
    else if (act === 'del-vraag') vragen.splice(i, 1);
    else if (act === 'up' && i > 0) { const t = vragen[i - 1]; vragen[i - 1] = vragen[i]; vragen[i] = t; }
    else if (act === 'down' && i < vragen.length - 1) { const t = vragen[i + 1]; vragen[i + 1] = vragen[i]; vragen[i] = t; }
    else if (act === 'add-opt') vragen[i].options.push({ label: '', punten: 0, afwijzer: false });
    else if (act === 'del-opt') vragen[i].options.splice(oi, 1);
    if (window.DFO?.render) window.DFO.render();
  };
  window._lsQuizSave = async function(){
    if (_lsQuizEd.busy) return;
    _lsQuizReadDom();
    const q = _lsQuizEd.quiz; if (!q) return;
    if (!q.naam) { window.KV.toast('Naam is leeg.', 'warn'); return; }
    if (!Number.isFinite(q.drempel)) { window.KV.toast('Drempel is geen getal.', 'warn'); return; }
    for (let i = 0; i < _lsQuizEd.vragen.length; i++) {
      const v = _lsQuizEd.vragen[i];
      if (!v.label) { window.KV.toast(`Vraag ${i+1}: label is leeg.`, 'warn'); return; }
      if (!v.options?.length) { window.KV.toast(`Vraag ${i+1}: geen opties.`, 'warn'); return; }
      if (v.options.some((o) => !o.label)) { window.KV.toast(`Vraag ${i+1}: optie zonder tekst.`, 'warn'); return; }
    }
    _lsQuizEd.busy = 'save'; if (window.DFO?.render) window.DFO.render();
    try {
      await window.KV.authedJson('/api/leadsonderhoud-quiz-opslaan', {
        method: 'POST',
        body: JSON.stringify({
          slug: q.slug, naam: q.naam, drempel: q.drempel, is_active: q.is_active !== false,
          vragen: _lsQuizEd.vragen,
        }),
      });
      window.KV.toast('Werk-versie opgeslagen.', 'ok');
      // Herlaad om verse ids op te halen (nieuwe vragen krijgen een id).
      await window._lsOpenQuizEditor(q.slug);
      // Vragenlijst-lijst refreshen zodat de status-tabel klopt.
      _live.vragenlijst.fetched = false; fetchVragenlijst();
    } catch (e) {
      window.KV.toast('Opslaan mislukt: ' + (e?.message || 'onbekend'), 'warn');
    }
    _lsQuizEd.busy = null; if (window.DFO?.render) window.DFO.render();
  };
  window._lsQuizPublish = async function(){
    if (_lsQuizEd.busy) return;
    if (!confirm('Publiceer de werk-versie naar live? De website ziet dan direct de nieuwe vragen.')) return;
    _lsQuizEd.busy = 'publish'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-quiz-publiceren', {
        method: 'POST', body: JSON.stringify({ slug: _lsQuizEd.slug }),
      });
      window.KV.toast('Gepubliceerd als versie ' + (j?.versie || '?'), 'ok');
      await window._lsOpenQuizEditor(_lsQuizEd.slug);
      _live.vragenlijst.fetched = false; fetchVragenlijst();
    } catch (e) {
      window.KV.toast('Publiceren mislukt: ' + (e?.message || 'onbekend'), 'warn');
    }
    _lsQuizEd.busy = null; if (window.DFO?.render) window.DFO.render();
  };
  window._lsQuizVersies = async function(){
    _lsQuizEd.versies.open = true; _lsQuizEd.versies.loading = true; _lsQuizEd.versies.error = null;
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-quiz-versies?slug=' + encodeURIComponent(_lsQuizEd.slug));
      _lsQuizEd.versies.items = Array.isArray(j?.items) ? j.items : [];
    } catch (e) { _lsQuizEd.versies.error = e?.message || 'onbekend'; }
    _lsQuizEd.versies.loading = false;
    if (window.DFO?.render) window.DFO.render();
  };
  window._lsQuizVersiesClose = function(){ _lsQuizEd.versies.open = false; if (window.DFO?.render) window.DFO.render(); };
  window._lsQuizRollback = async function(versie){
    if (!confirm('Zet versie ' + versie + ' weer live? De werk-versie blijft ongewijzigd.')) return;
    try {
      await window.KV.authedJson('/api/leadsonderhoud-quiz-rollback', {
        method: 'POST', body: JSON.stringify({ slug: _lsQuizEd.slug, versie }),
      });
      window.KV.toast('Versie ' + versie + ' is nu live.', 'ok');
      await window._lsOpenQuizEditor(_lsQuizEd.slug);
      _lsQuizEd.versies.open = false;
      _live.vragenlijst.fetched = false; fetchVragenlijst();
    } catch (e) {
      window.KV.toast('Rollback mislukt: ' + (e?.message || 'onbekend'), 'warn');
    }
  };
  function _lsQuizEditorModalHtml(){
    if (!_lsQuizEd.open) return '';
    let body;
    if (_lsQuizEd.loading) {
      body = `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">Laden…</div>`;
    } else if (_lsQuizEd.error) {
      body = `<div style="padding:24px;color:var(--rose)">⚠ ${esc(_lsQuizEd.error)}</div>`;
    } else if (_lsQuizEd.quiz) {
      const q = _lsQuizEd.quiz;
      const liveLbl = _lsQuizEd.live ? `Live: v${_lsQuizEd.live.versie} (${esc(new Date(_lsQuizEd.live.op).toLocaleString('nl-NL'))})` : 'Nog niet gepubliceerd';
      const vragenHtml = _lsQuizEd.vragen.map((v, vi) => {
        const optsHtml = (v.options || []).map((o, oi) => `<div data-lq-opt="${oi}" style="display:flex;gap:6px;align-items:center;padding:4px 0">
          <input type="text" data-lq-olabel value="${esc(o.label || '')}" placeholder="Antwoordtekst" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:12.5px;background:var(--surface)">
          <input type="number" data-lq-opunten value="${Number(o.punten) || 0}" title="Punten" style="width:64px;padding:4px 8px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:12.5px;background:var(--surface);text-align:right">
          <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-2);white-space:nowrap"><input type="checkbox" data-lq-oafwijzer ${o.afwijzer ? 'checked' : ''}> afwijzer</label>
          <button class="btn btn-secondary" style="font-size:11px;padding:2px 8px" onclick="window._lsQuizAction('del-opt', ${vi}, ${oi})" title="Optie weg">×</button>
        </div>`).join('');
        return `<div data-lq-vraag="${vi}" style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px 12px;margin-bottom:10px">
          <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
            <span style="background:var(--surface);border:1px solid var(--border);border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${vi + 1}</span>
            <input type="text" data-lq-vlabel value="${esc(v.label || '')}" placeholder="Vraagtekst" style="flex:1;padding:4px 8px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;background:var(--surface);font-weight:600">
            <button class="btn btn-secondary" style="font-size:11px;padding:2px 8px" onclick="window._lsQuizAction('up', ${vi})" ${vi === 0 ? 'disabled' : ''} title="Omhoog">↑</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:2px 8px" onclick="window._lsQuizAction('down', ${vi})" ${vi === _lsQuizEd.vragen.length - 1 ? 'disabled' : ''} title="Omlaag">↓</button>
            <label style="display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-2)"><input type="checkbox" data-lq-vactive ${v.active !== false ? 'checked' : ''}> actief</label>
            <button class="btn btn-secondary" style="font-size:11px;padding:2px 8px;color:var(--rose)" onclick="window._lsQuizAction('del-vraag', ${vi})">Weg</button>
          </div>
          <div>${optsHtml}</div>
          <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px;margin-top:6px" onclick="window._lsQuizAction('add-opt', ${vi})">+ Optie</button>
        </div>`;
      }).join('');

      const versiesPanel = _lsQuizEd.versies.open ? (() => {
        if (_lsQuizEd.versies.loading) return `<div style="padding:12px">Laden…</div>`;
        if (_lsQuizEd.versies.error) return `<div style="padding:12px;color:var(--rose)">⚠ ${esc(_lsQuizEd.versies.error)}</div>`;
        if (!_lsQuizEd.versies.items.length) return `<div style="padding:12px;color:var(--text-3)">Nog geen gepubliceerde versies.</div>`;
        return `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)"><th style="padding:6px 8px">Versie</th><th style="padding:6px 8px">Gepubliceerd</th><th style="padding:6px 8px;text-align:right">Vragen</th><th style="padding:6px 8px">Status</th><th style="padding:6px 8px"></th></tr></thead>
          <tbody>${_lsQuizEd.versies.items.map(v => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:6px 8px"><b>v${v.versie}</b></td>
            <td style="padding:6px 8px;font-family:var(--mono,monospace);font-size:11.5px">${esc(new Date(v.op).toLocaleString('nl-NL'))}</td>
            <td style="padding:6px 8px;text-align:right">${v.vragen || 0}</td>
            <td style="padding:6px 8px">${v.actueel ? '<span style="color:var(--emerald);font-weight:600">● Live</span>' : '<span style="color:var(--text-3)">—</span>'}</td>
            <td style="padding:6px 8px">${!v.actueel ? `<button class="btn btn-secondary" style="font-size:11px;padding:3px 8px" onclick="window._lsQuizRollback(${v.versie})">Zet live</button>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table>`;
      })() : '';

      body = `
        <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:14px">
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
            <div style="flex:1;min-width:200px">
              <label style="display:block;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Naam</label>
              <input type="text" data-lq-field="naam" value="${esc(q.naam || '')}" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:13px">
            </div>
            <div style="flex:0 0 170px">
              <label style="display:block;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Drempel (toegang bij ≥)</label>
              <input type="number" data-lq-field="drempel" value="${Number(q.drempel) || 0}" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);font-size:13px">
            </div>
            <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;padding-bottom:6px"><input type="checkbox" data-lq-field="is_active" ${q.is_active !== false ? 'checked' : ''}> Actief</label>
          </div>
          <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
            <span style="font-size:11.5px;color:var(--text-3)">${esc(liveLbl)}</span>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button class="btn btn-secondary" style="font-size:12px;padding:6px 12px" onclick="window._lsQuizVersies()">Versies</button>
              <button class="btn btn-secondary" style="font-size:12px;padding:6px 12px" onclick="window._lsQuizSave()" ${_lsQuizEd.busy ? 'disabled' : ''}>${_lsQuizEd.busy === 'save' ? 'Opslaan…' : 'Opslaan (werk-versie)'}</button>
              <button class="btn btn-primary" style="font-size:12px;padding:6px 12px" onclick="window._lsQuizPublish()" ${_lsQuizEd.busy ? 'disabled' : ''}>${_lsQuizEd.busy === 'publish' ? 'Publiceren…' : 'Publiceren'}</button>
            </div>
          </div>
        </div>
        ${_lsQuizEd.versies.open ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 4px;margin-bottom:14px">
          <div style="display:flex;align-items:center;padding:0 10px 8px 10px">
            <div style="font-weight:600;font-size:13px">Publicatie-versies</div>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window._lsQuizVersiesClose()">✕</button>
          </div>
          ${versiesPanel}
        </div>` : ''}
        <div>${vragenHtml}</div>
        <button class="btn btn-secondary" style="font-size:12.5px;padding:6px 14px;margin-top:6px" onclick="window._lsQuizAction('add-vraag')">+ Vraag toevoegen</button>`;
    } else {
      body = `<div style="padding:24px;color:var(--text-3)">Geen vragenlijst geladen.</div>`;
    }
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window._lsCloseQuizEditor()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(880px,100%);max-height:92vh;overflow-y:auto">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);gap:10px;position:sticky;top:0;background:var(--surface);z-index:1">
          <div style="font-size:14px;font-weight:600">Vragenlijst-editor · <span style="font-family:var(--mono,monospace);font-size:12px;color:var(--text-3)">${esc(_lsQuizEd.slug || '')}</span></div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window._lsCloseQuizEditor()">✕</button>
        </div>
        <div style="padding:14px 18px">${body}</div>
      </div>
    </div>`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['leadsonderhoud/Overzicht']      = overzichtView;
  window.DFO.VIEWS['leadsonderhoud/Contacten']      = contactenView;
  window.DFO.VIEWS['leadsonderhoud/Wachtrij']       = wachtrijView;
  window.DFO.VIEWS['leadsonderhoud/Gesprekken']     = gesprekkenView;
  window.DFO.VIEWS['leadsonderhoud/Statistieken']   = statsView;
  /* ══════════════════════════════════════════════════════════════════
     v=17 TAB — Toegang-aanvragen (WhatsApp-gate monitoring).
     Read-only lijst uit /api/leadsonderhoud-toegang-aanvragen-list.
     Filters: status / soort / periode. RBAC: leads.view via endpoint.
     ══════════════════════════════════════════════════════════════════ */
  async function fetchToegangAanvragen(force) {
    const st = _live.toegangAanvragen;
    const key = 's=' + st.status + '&t=' + st.soort + '&p=' + st.periode;
    if (!force && st.lastKey === key && st.fetched && !st.error) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const qs = 'status=' + encodeURIComponent(st.status) + '&soort=' + encodeURIComponent(st.soort) + '&periode=' + encodeURIComponent(st.periode);
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-toegang-aanvragen-list?' + qs);
      if (seq !== st._seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st._seq) return;
      st.error = 'Kon toegang-aanvragen niet laden' + (e?.status ? ' (HTTP ' + e.status + ')' : '') + (e?.body?.detail ? ' — ' + String(e.body.detail).slice(0, 150) : '');
    }
    st.loading = false; st.fetched = true;
    if (window.DFO?.render) window.DFO.render();
  }
  window._lsSetTaStatus  = (s) => { _live.toegangAanvragen.status  = s; fetchToegangAanvragen(true); };
  window._lsSetTaSoort   = (s) => { _live.toegangAanvragen.soort   = s; fetchToegangAanvragen(true); };
  window._lsSetTaPeriode = (p) => { _live.toegangAanvragen.periode = p; fetchToegangAanvragen(true); };

  function toegangAanvragenView() {
    if (!_live.toegangAanvragen.fetched && !_live.toegangAanvragen.loading && !_live.toegangAanvragen.error) {
      queueMicrotask(() => fetchToegangAanvragen(false));
    }
    const st = _live.toegangAanvragen;
    const data = st.data || { items: [], total: 0 };
    const items = data.items || [];
    // v=18 (2026-08-29): formaat dd-MM-yyyy HH:mm (Europe/Amsterdam) —
    // consistent met Leads-lijst AANGEMAAKT-kolom (leads-v2.js dtStr).
    const kortDt = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' }); } catch(_){ return String(iso); } };
    const statusOpts  = [['alle','Alle'],['wachtend','Wachtend'],['gereageerd','Gereageerd'],['vervallen','Vervallen']];
    const soortOpts   = [['alle','Alle'],['7-daagse','7-daagse'],['minicursus','Mini-cursus']];
    const periodeOpts = [['week','Deze week'],['maand','Deze maand'],['alles','Alles']];
    const chip = (arr, curr, setter) => arr.map(([k,l]) => `<button class="chip ${curr===k?'on':''}" style="font-size:11.5px;padding:4px 10px" onclick="window.${setter}('${k}')">${esc(l)}</button>`).join('');

    const stapPill = (aan, label) => aan
      ? `<span style="background:var(--emerald-soft);color:var(--emerald);padding:2px 6px;border-radius:8px;font-size:10.5px;font-weight:600;margin-right:2px">${label}✓</span>`
      : `<span style="background:var(--surface-2);color:var(--text-3);padding:2px 6px;border-radius:8px;font-size:10.5px;margin-right:2px">${label}</span>`;

    const statusBadge = (s) => {
      const style = s === 'gereageerd' ? 'background:var(--emerald-soft);color:var(--emerald)'
                   : s === 'vervallen' ? 'background:var(--surface-2);color:var(--text-3)'
                   : 'background:var(--amber-soft);color:var(--amber)';
      return `<span style="${style};padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${esc(s || '—')}</span>`;
    };

    const rows = items.length ? items.map((r) => `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:8px 10px;font-size:11.5px;color:var(--text-3);white-space:nowrap;font-variant-numeric:tabular-nums" title="${esc(r.created_at)}">${esc(kortDt(r.created_at))}</td>
      <td style="padding:8px 10px">
        <div style="font-weight:600">${esc(r.voornaam || '—')}</div>
        <div style="color:var(--text-3);font-size:11px">${esc([r.email, r.telefoon].filter(Boolean).join(' · ') || '—')}</div>
      </td>
      <td style="padding:8px 10px">${esc(r.soort)}<div style="color:var(--text-3);font-size:10.5px;font-family:var(--mono,monospace)">${esc(r.bron || '—')}</div></td>
      <td style="padding:8px 10px;text-align:center">${r.call_geboekt ? '<span style="color:var(--emerald);font-weight:600">✓</span>' : '<span style="color:var(--text-3)">–</span>'}</td>
      <td style="padding:8px 10px">${statusBadge(r.status)}</td>
      <td style="padding:8px 10px;font-size:11.5px;color:var(--text-3);white-space:nowrap">${esc(kortDt(r.reacted_at))}</td>
      <td style="padding:8px 10px;white-space:nowrap">
        ${stapPill(r.bevestiging_sent, 'bev')}${stapPill(r.reminder_2u_sent, '2u')}${stapPill(r.reminder_24u_sent, '24u')}${stapPill(r.reminder_48u_sent, '48u')}${r.soort === '7-daagse' ? stapPill(r.dag6_sent, 'd6') : ''}
      </td>
      <td style="padding:8px 10px;text-align:center">${r.provisioned_at
          ? '<span style="color:var(--emerald);font-weight:600" title="Inlog verstuurd">✓</span>'
          : (r.provisioned_error ? `<span style="color:var(--rose);font-weight:600" title="${esc(r.provisioned_error)}">⚠</span>` : '<span style="color:var(--text-3)">–</span>')}</td>
    </tr>`).join('') : `<tr><td colspan="8" style="padding:44px 20px;text-align:center;color:var(--text-3)">${st.loading ? 'Laden…' : 'Geen aanvragen in dit venster.'}</td></tr>`;

    return `
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:12px;color:var(--text-3);line-height:1.55;margin-bottom:12px">
        WhatsApp-gate voor <b>7-daagse</b> + <b>mini-cursus</b>: gekwalificeerde leads komen hier binnen als 'wachtend'; ze krijgen bevestiging (~2 min) + reminders (2u/24u/48u) via WA/mail; zodra ze op WhatsApp reageren → 'gereageerd' + inlog wordt automatisch verstuurd; anders → 'vervallen' na 48u. Stap-pills: <b>bev</b>=bevestiging · <b>2u/24u/48u</b>=reminders · <b>d6</b>=dag-6 check-in (alleen 7-daagse). Kolom "Inlog": ✓ betekent dfo-website heeft LMS-toegang + mail verstuurd.
      </div>
      ${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-bottom:10px">
        <div style="display:flex;gap:6px;align-items:center"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Status</span>${chip(statusOpts, st.status, '_lsSetTaStatus')}</div>
        <div style="display:flex;gap:6px;align-items:center"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Soort</span>${chip(soortOpts, st.soort, '_lsSetTaSoort')}</div>
        <div style="display:flex;gap:6px;align-items:center"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Periode</span>${chip(periodeOpts, st.periode, '_lsSetTaPeriode')}</div>
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">${st.loading ? 'Laden…' : ((data.total || items.length) + ' aanvraag' + ((data.total || items.length) === 1 ? '' : 'en'))}</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">
          <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
            <th style="padding:8px 10px">Aangemeld</th>
            <th style="padding:8px 10px">Lead</th>
            <th style="padding:8px 10px">Soort</th>
            <th style="padding:8px 10px;text-align:center" title="Call al geboekt in de funnel">Call</th>
            <th style="padding:8px 10px">Status</th>
            <th style="padding:8px 10px">Gereageerd</th>
            <th style="padding:8px 10px">Stappen</th>
            <th style="padding:8px 10px;text-align:center" title="Inlog verstuurd door dfo-website">Inlog</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
  }

  window.DFO.VIEWS['leadsonderhoud/Toegang-aanvragen'] = toegangAanvragenView;
  window.DFO.VIEWS['leadsonderhoud/Bronnen']        = bronnenView;
  window.DFO.VIEWS['leadsonderhoud/Opstartsessies'] = opstartsessiesView;
  window.DFO.VIEWS['leadsonderhoud/Vragenlijst']    = vragenlijstView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leadsonderhoud');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leadsonderhoud');

  console.debug('[ls-v2] v=16 — Bronnen/Opstartsessies/Vragenlijst zijn nu volledig v2-native. Bronnen: inline CRUD (booking-sources-upsert). Opstartsessies: native detail-modal (leadsonderhoud-opstartsessies-detail). Vragenlijst: native quiz-editor met CRUD + Opslaan + Publiceren + Versies-panel + Rollback (quiz-opslaan/publiceren/versies/rollback endpoints). GEEN links meer naar /modules/leadsonderhoud.html — de v1-editor is niet meer nodig vanuit deze shell.');
})();
