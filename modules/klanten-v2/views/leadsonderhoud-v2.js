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
              const nameForBtn = String(l.naam || l.email || '').replace(/'/g, "\\'");
              const idForBtn   = String(l.id || '').replace(/'/g, "\\'");
              const extendBtn  = idForBtn
                ? `<button class="btn btn-ghost btn-sm" onclick="window.__lsExtOpen('${idForBtn}', '${nameForBtn}')" style="font-size:11px" title="LMS-toegang van deze lead verlengen">Verlengen</button>`
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
                <td style="padding:8px 10px;text-align:right;white-space:nowrap">${extendBtn}</td>
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
    // v=9 FIX-HOOGTE (A-restant): "Hey" bubble was compact-breed maar 201px
    // HOOG. Root cause: white-space:pre-wrap stond op de bubble-WRAPPER,
    // dus de whitespace-tekstnodes tussen de tags in de template-literal
    // (indentation "\n        ") renderden als échte lege regels — 4x
    // regelhoogte extra per bubble.
    // Fix: white-space:pre-wrap alleen op de body-<div> zetten (waar de
    // tekst zelf staat), NIET op de wrapper. Wrapper krijgt de default
    // white-space (normal) → collapse van indentation-tekstnodes.
    // Multi-line berichten behouden hun \n's want die staan in body.
    const isOut = m.direction === 'outbound';
    const at = m.at ? esc(fmtDatum(m.at)) : '';
    const align = isOut ? 'right' : 'left';
    const bg = isOut ? 'var(--brand-soft, #E2F1F5)' : 'var(--surface-2)';
    const color = isOut ? 'var(--brand, #0A7490)' : 'var(--text-1)';
    const radius = isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px';
    const chanColor = m.channel === 'mail' ? 'blue' : 'teal';
    const chanLabel = m.channel === 'mail' ? 'mail' : 'WA';
    const subjHtml = m.channel === 'mail' && m.subject
      ? `<div style="font-weight:600;font-size:12.5px;margin-bottom:3px">${esc(m.subject)}</div>`
      : '';
    // Ronde-18: media-thumbnail via gedeelde helper (image/attachment support).
    const mediaOrText = (window.KV_V2 && window.KV_V2.helpers && window.KV_V2.helpers.renderChatBody)
      ? window.KV_V2.helpers.renderChatBody(m, esc)
      : esc(m.body || '');
    const bodyHtml = mediaOrText
      ? `<div style="white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere">${mediaOrText}</div>`
      : `<div style="opacity:.55">(leeg bericht)</div>`;
    return `<div data-msg-id="${esc(String(m.id))}" style="text-align:${align};margin-bottom:6px"><span style="display:inline-block;text-align:left;max-width:70%;padding:7px 11px;background:${bg};color:${color};border-radius:${radius};font-size:13.5px;line-height:1.4;vertical-align:top"><span style="display:inline-block;font-size:9.5px;line-height:1;padding:1px 5px;border-radius:6px;background:var(--${chanColor}-soft);color:var(--${chanColor});font-weight:600;letter-spacing:.04em;margin-bottom:3px;opacity:.85">${chanLabel}</span>${subjHtml}${bodyHtml}<div style="font-size:10px;opacity:.5;font-family:'IBM Plex Mono',monospace;margin-top:3px;text-align:right">${at}</div></span></div>`;
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

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['leadsonderhoud/Overzicht']      = overzichtView;
  window.DFO.VIEWS['leadsonderhoud/Contacten']      = contactenView;
  window.DFO.VIEWS['leadsonderhoud/Wachtrij']       = wachtrijView;
  window.DFO.VIEWS['leadsonderhoud/Gesprekken']     = gesprekkenView;
  window.DFO.VIEWS['leadsonderhoud/Statistieken']   = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leadsonderhoud');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leadsonderhoud');

  console.debug('[ls-v2] v=14 — Bulk-tab verwijderd (feature geschrapt). Nav-tabs: Overzicht/Contacten/Wachtrij/Gesprekken/Statistieken. Backend bulk-endpoints (preview/test-send/approve/cancel/status/jobs-list) + cron blijven in de repo staan maar zijn onbereikbaar zonder UI; cron-entry uit vercel.json verwijderd zodat er geen zinloze invocatie draait.');
})();
