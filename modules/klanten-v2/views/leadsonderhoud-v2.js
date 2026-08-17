// modules/klanten-v2/views/leadsonderhoud-v2.js
//
// Leadsonderhoud v2 — BROK 2 FASE 1 (v=4, 2026-08-17): Gesprekken-tab live.
// Scope: lead-relatie-werkplek. Config (trajecten/sjablonen/quiz) blijft in
// Automatiseringen. Bulk / Gesprekken (writes) komen in BROK 2.
//
// Tab-set:
//   Overzicht      — trial-warmte KPIs + call-booking-KPI + regels-kaart
//   Contacten      — ALLE leads (leads_overzicht view) met warmte-score +
//                    call-status ("Call geboekt/Niet geboekt") + filters
//                    op traject + call-status + zoek
//   Wachtrij       — welke leads komen bij volgende drip-ronde aan de beurt
//   Gesprekken     — placeholder (BROK 2: /api/leadsonderhoud-gesprekken + reply)
//   Bulk versturen — placeholder (BROK 2: nieuwe bulk-endpoint)
//   Statistieken   — geleide KPIs uit leads-list + berichten-log counts
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
    if (!_live.overzicht.fetched && !_live.overzicht.loading) queueMicrotask(fetchOverzicht);
    if (!_live.droogloop.fetched && !_live.droogloop.loading) queueMicrotask(fetchDroogloop);
    if (!_live.leadsAll.fetched && !_live.leadsAll.loading)   queueMicrotask(fetchLeadCounts);

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
            </tr>
          </thead>
          <tbody>
            ${items.map(l => {
              const w = warmteMeta(l.score);
              const heeftCall = !!l.afspraak_op;
              const callBadge = heeftCall
                ? `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--emerald-soft);color:var(--emerald)">✓ geboekt</span>`
                : `<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--amber-soft);color:var(--amber)">— nog niet</span>`;
              return `<tr style="border-bottom:1px solid var(--border)">
                <td style="padding:8px 10px">
                  <div style="font-weight:600">${esc(l.naam || l.email || '(zonder naam)')}</div>
                  <div style="color:var(--text-3);font-size:11px">${esc(l.email || '')}${l.telefoon ? ' · ' + esc(l.telefoon) : ''}</div>
                </td>
                <td style="padding:8px 10px">${esc(l.traject || '—')}</td>
                <td style="padding:8px 10px">${warmteBar(l.score)}</td>
                <td style="padding:8px 10px">${callBadge}${heeftCall ? `<div style="color:var(--text-3);font-size:11px;margin-top:2px">${esc(fmtDatum(l.afspraak_op))}</div>` : ''}</td>
                <td style="padding:8px 10px"><span style="font-size:11px;color:var(--text-3)">${esc(l.bron || l.soort || '—')}</span></td>
                <td style="padding:8px 10px"><span style="font-size:11px">${esc(l.status || '—')}</span></td>
                <td style="padding:8px 10px;color:var(--text-3)">${esc(fmtDatum(l.aangemaakt))}</td>
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

    return `${st.error ? `<div style="padding:12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(st.error)}</div>` : ''}
      ${toolbar}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        ${st.loading && !items.length ? renderSkeletonRows(6) : rowHtml}
      </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 3 — WACHTRIJ
     ══════════════════════════════════════════════════════════════════ */
  function wachtrijView() {
    if (!_live.wachtrij.fetched && !_live.wachtrij.loading) queueMicrotask(fetchWachtrij);
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
    const tone        = opts?.tone === 'danger' ? 'rose' : 'brand';
    return new Promise((resolve) => {
      _lsInbOpenModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px;white-space:pre-wrap">${esc(body)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="lsInbModalCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="lsInbModalOk" class="btn btn-primary btn-sm" style="background:var(--${tone});border-color:var(--${tone})">${okLabel}</button>
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
    _lsInb.thread.items = asArr(j.items).map(m => ({
      id: m.id,
      channel: m.channel === 'mail' ? 'mail' : 'whatsapp',
      direction: m.direction === 'out' ? 'outbound' : 'inbound',
      body: m.body || '',
      subject: m.subject || '',
      at: m.ts || null,
      is_read: !!m.is_read,
    }));
    _lsInb.thread.conversation = j.conversation || null;
    _lsInb.thread.loading = false;
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

  /* ── Append-only thread paint ────────────────────────────────────────── */
  function _lsInbPaintThread() {
    const container = document.getElementById('lsInbThreadScroll');
    if (!container) return;
    if (!_lsInb.thread.leadId) { container.innerHTML = ''; return; }
    const isNewLead = _lsInb.thread._paintedFor !== _lsInb.thread.leadId;
    if (isNewLead) {
      container.innerHTML = _lsInb.thread.items.map(_lsInbRenderMsg).join('');
      _lsInb.thread._paintedFor = _lsInb.thread.leadId;
      container.scrollTop = container.scrollHeight;
      return;
    }
    const seen = new Set();
    container.querySelectorAll('[data-msg-id]').forEach(el => seen.add(el.getAttribute('data-msg-id')));
    const additions = _lsInb.thread.items.filter(m => !seen.has(String(m.id)));
    if (!additions.length) return;
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 40;
    container.insertAdjacentHTML('beforeend', additions.map(_lsInbRenderMsg).join(''));
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }
  function _lsInbRenderMsg(m) {
    const isOut = m.direction === 'outbound';
    const body = esc(m.body || '');
    const at = m.at ? esc(fmtDatum(m.at)) : '';
    const side = isOut ? 'flex-end' : 'flex-start';
    const bg = isOut ? 'var(--brand-soft,var(--surface-2))' : 'var(--surface-2)';
    const color = isOut ? 'var(--brand)' : 'var(--text-1)';
    const radius = isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px';
    // Kanaal-badge — WA = teal / mail = blue.
    const chanColor = m.channel === 'mail' ? 'blue' : 'teal';
    const chanLabel = m.channel === 'mail' ? 'mail' : 'WA';
    const subjHtml = m.channel === 'mail' && m.subject
      ? `<div style="font-weight:600;font-size:12.5px;margin-bottom:4px">${esc(m.subject)}</div>`
      : '';
    return `<div data-msg-id="${esc(String(m.id))}" style="display:flex;justify-content:${side};margin-bottom:8px">
      <div style="max-width:82%;padding:10px 14px;background:${bg};color:${color};border-radius:${radius};font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:${subjHtml ? '4' : '2'}px;font-size:10.5px;opacity:.6">
          <span style="padding:1px 6px;border-radius:8px;background:var(--${chanColor}-soft);color:var(--${chanColor});font-weight:600;letter-spacing:.04em">${chanLabel}</span>
        </div>
        ${subjHtml}
        ${body || '<span style="opacity:.55">(leeg bericht)</span>'}
        <div style="font-size:10.5px;opacity:.55;font-family:'IBM Plex Mono',monospace;margin-top:4px;text-align:right">${at}</div>
      </div>
    </div>`;
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
      _lsInb.compose.mode[leadId] = 'template';
      _lsInbRepaintCompose();
      _lsInbToast('Buiten 24u-venster of geen WA — kies een template', 'warn');
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
        const j = await resp.json().catch(() => ({}));
        _lsInb.compose.mode[leadId] = 'template';
        _lsInbToast(j.error || 'Buiten 24u-venster — kies een template', 'warn');
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

  // ── Quick-replies + template-picker (WA only) ────────────────────────
  window.__lsInbQuickPicker = async () => {
    const leadId = _lsInb.thread.leadId;
    if (!leadId) return;
    // De quick-replies endpoint verwacht conversation_id (WA-conv). Voor
    // leadsonderhoud is die niet altijd aanwezig — fall-back naar lege lijst.
    _lsInbToast('Snel-antwoorden vereisen een WA-conversatie (niet beschikbaar per lead)', 'warn');
  };
  window.__lsInbTemplatePicker = () => { _lsInbOpenTemplatePicker(_lsInb.thread.leadId); };
  async function _lsInbOpenTemplatePicker(leadId) {
    if (!leadId) return;
    // inbox-template-list vereist conversation_id — voor leadsonderhoud
    // hebben we die niet consistent (mail-only leads). Geef nette melding
    // en bied vrije-tekst-fallback aan.
    _lsInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Templates niet beschikbaar</div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
        De template-picker vereist een WhatsApp-conversatie op de lead. Leadsonderhoud werkt op
        <b>lead_id</b>, dus wanneer de lead nog geen WA-conversatie heeft (of buiten 24u-venster valt)
        kunnen we hier geen approved template ophalen.
        <br><br>
        Stuur in dit geval liever een <b>e-mail</b> vanuit dezelfde compose — die heeft geen
        24u-restrictie.
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="lsInbTplClose" class="btn btn-primary btn-sm">Sluiten</button>
      </div>
    `, { maxWidth: 500 });
    document.getElementById('lsInbTplClose').addEventListener('click', _lsInbCloseModal);
  }

  // ── Live-refresh poll (18s) ──────────────────────────────────────────
  function _lsInbStartPoll() {
    if (_lsInb.poll.handle) return;
    _lsInb.poll.handle = setInterval(_lsInbPollTick, _lsInb.poll.intervalMs);
  }
  function _lsInbStopPoll() {
    if (_lsInb.poll.handle) { clearInterval(_lsInb.poll.handle); _lsInb.poll.handle = null; }
  }
  async function _lsInbPollTick() {
    if (_lsInb.poll.running) return;
    if (!document.querySelector('.ls-inb-split')) { _lsInbStopPoll(); return; }
    if (document.hidden) return;
    _lsInb.poll.running = true;
    try {
      _lsInb.convs.fetched = false;
      await _lsInbFetchConvs();
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
    return `<div class="ls-inb-row ${nw ? 'nw' : ''} ${onCls}" data-row-id="${rowIdAttr}" onclick="__lsInbSel('${rowIdClick}')"
      style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls === 'on' ? 'background:var(--surface-2)' : ''}">
      ${H.av(naam || '?', 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:${nw ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</span>
          <span style="margin-left:auto;font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);flex-shrink:0">${esc(tijd)}</span>
        </div>
        <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(preview)}</div>
        <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
        <div style="margin-top:6px;display:flex;gap:5px;align-items:center">
          ${waBadge} ${mailBadge}
          ${nw ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto"></span>' : ''}
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

    // Buiten-venster / geen-WA → template-modus (met uitleg dat template-picker
    // niet beschikbaar is voor leadsonderhoud — gebruik mail).
    if (mode === 'template') {
      return `<div id="lsInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border)">
        <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px;color:var(--amber);margin-bottom:10px">
          Buiten het 24u-venster — vrije-tekst WA is dan niet toegestaan.
          Kies een <b>e-mail</b>-antwoord (welkom@) of een goedgekeurde template.
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="__lsInbToggleMailForm()">${showMail ? 'Verberg mail' : 'Antwoord per mail'}</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbTemplatePicker()">Templates…</button>
          <button class="btn btn-ghost btn-sm" onclick="__lsInbResetMode()">Probeer WA-tekst</button>
        </div>
        ${showMail ? _lsInbRenderMailForm(conv, sending) : ''}
      </div>`;
    }

    const waDraft = esc(_lsInb.compose.draftsWa[leadId] || '');
    const mailBlock = showMail ? _lsInbRenderMailForm(conv, sending) : '';

    return `<div id="lsInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:10px">
      <div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
          <span style="font-size:10.5px;padding:2px 7px;border-radius:8px;background:var(--teal-soft);color:var(--teal);font-weight:600">WhatsApp</span>
          ${waEnabled ? '<span style="font-size:11px;color:var(--text-3)">binnen 24u-venster</span>' : '<span style="font-size:11px;color:var(--amber)">buiten venster / geen WA</span>'}
        </div>
        <textarea
          placeholder="${waEnabled ? 'Typ een WhatsApp-antwoord… (Ctrl+Enter om te verzenden)' : 'WhatsApp niet beschikbaar — schakel naar mail hieronder'}"
          oninput="__lsInbDraftWa('${String(leadId).replace(/'/g, "\\'")}', this.value)"
          onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();__lsInbSendWa();}"
          ${sending || !waEnabled ? 'disabled' : ''}
          style="width:100%;min-height:64px;max-height:180px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13.5px;line-height:1.5;font-family:inherit;resize:vertical;${!waEnabled ? 'opacity:.5' : ''}">${waDraft}</textarea>
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="__lsInbSendWa()" ${sending || !waEnabled ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Verstuur WA'}</button>
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
      <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
        <button class="btn btn-primary btn-sm" onclick="__lsInbSendMail()" ${sending || !mailEnabled ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Verstuur mail'}</button>
        <span style="font-size:11px;color:var(--text-3);margin-left:auto">verzonden vanaf welkom@deforexopleiding.nl</span>
      </div>
    </div>`;
  }
  function _lsInbRenderRight(row) {
    const naam = _lsInbRowVan(row);
    const ctx  = row.email || row.phone_number || '';
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
          ${chanBadges}
        </div>
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(naam || '?', 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
          </div>
        </div>
      </div>
      <div id="lsInbThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column"></div>
      ${status}
      ${_lsInbRenderCompose()}
    </div>`;
  }

  function gesprekkenView() {
    // Eerste render triggert fetch + poll.
    if (!_lsInb.convs.fetched && !_lsInb.convs.loading) {
      queueMicrotask(_lsInbFetchConvs);
    }
    const rows = asArr(_lsInb.convs.items);
    const sel  = rows.find(r => String(r.lead_id) === String(_lsInb.sel)) || rows[0] || null;
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

    return `<div class="ls-inb-split" style="display:flex;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
      <div id="lsInbList" style="width:360px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto">
        <div style="padding:11px 14px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between;align-items:center">
          <span>Lead-gesprekken (WA + mail)</span>
          <span>${rows.length} leads</span>
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
     TAB 5 — BULK VERSTUREN (placeholder — BROK 2)
     ══════════════════════════════════════════════════════════════════ */
  function bulkView() {
    return `<div style="padding:60px 20px;text-align:center;color:var(--text-3)">
      <div style="font-size:38px;margin-bottom:12px">${svg(I.send || I.mail, 'width:38px;height:38px;color:var(--text-3)')}</div>
      <div style="font-size:15px;font-weight:600;color:var(--text-1);margin-bottom:6px">Bulk versturen volgt in BROK 2</div>
      <div style="font-size:12.5px;max-width:520px;margin:0 auto">
        Broadcast-flow (masterclass-herinnering / marktupdate / event-uitnodiging) naar segmenten.
        Vereist nieuw endpoint (<code>/api/leadsonderhoud-bulk-send</code>) + segment-builder + testmail + confirm.
        Product-keuze staat op de agenda — deze tab blijft leeg tot dat is beslist.
      </div>
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 6 — STATISTIEKEN (afgeleide KPIs uit dezelfde bronnen)
     ══════════════════════════════════════════════════════════════════ */
  function statsView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading) queueMicrotask(fetchOverzicht);
    if (!_live.droogloop.fetched && !_live.droogloop.loading) queueMicrotask(fetchDroogloop);
    if (!_live.leadsAll.fetched && !_live.leadsAll.loading)   queueMicrotask(fetchLeadCounts);

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

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['leadsonderhoud/Overzicht']      = overzichtView;
  window.DFO.VIEWS['leadsonderhoud/Contacten']      = contactenView;
  window.DFO.VIEWS['leadsonderhoud/Wachtrij']       = wachtrijView;
  window.DFO.VIEWS['leadsonderhoud/Gesprekken']     = gesprekkenView;
  window.DFO.VIEWS['leadsonderhoud/Bulk versturen'] = bulkView;
  window.DFO.VIEWS['leadsonderhoud/Statistieken']   = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leadsonderhoud');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leadsonderhoud');

  console.debug('[ls-v2] v=4 BROK 2 FASE 1 — Gesprekken-tab live: lead-gesleutelde inbox (WA + mail door elkaar) via leadsonderhoud-gesprekken/-berichten/-antwoord/-mailantwoord; twee send-knoppen (WA vrije-tekst + mail met subject), 24u-guard, mark-read surgical, append-only thread, poll 18s.');
})();
