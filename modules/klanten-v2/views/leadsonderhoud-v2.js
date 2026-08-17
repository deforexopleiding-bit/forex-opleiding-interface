// modules/klanten-v2/views/leadsonderhoud-v2.js
//
// Leadsonderhoud v2 — BROK 1 (v=3, 2026-08-17): read-tabs + 2 bugfixes.
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
     TAB 4 — GESPREKKEN (placeholder — BROK 2)
     ══════════════════════════════════════════════════════════════════ */
  function gesprekkenView() {
    return `<div style="padding:60px 20px;text-align:center;color:var(--text-3)">
      <div style="font-size:38px;margin-bottom:12px">${svg(I.chat || I.mail, 'width:38px;height:38px;color:var(--text-3)')}</div>
      <div style="font-size:15px;font-weight:600;color:var(--text-1);margin-bottom:6px">Gesprekken volgt in BROK 2</div>
      <div style="font-size:12.5px;max-width:480px;margin:0 auto">
        In-app antwoorden op inkomende lead-berichten (mail via <code>welkom@</code> + WhatsApp) komt hier.
        Endpoints staan klaar: <code>/api/leadsonderhoud-gesprekken</code>, <code>-gesprek-berichten</code>,
        <code>-gesprek-antwoord</code> (WA), <code>-gesprek-mailantwoord</code> (mail). Reads-only in deze brok.
      </div>
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

  console.debug('[ls-v2] v=3 BROK 1 (fix) — bug A per-fetcher _seq (parallelle KPI-fetches vielen weg door globale teller), bug B S -> DFO.S in oninput/onchange (S was ReferenceError, filter-handlers crashten pre-render).');
})();
