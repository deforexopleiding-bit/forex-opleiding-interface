// modules/klanten-v2/views/leadsonderhoud-v2.js
//
// Fase D module — Leadsonderhoud (trial-warmte / nurturing-motor).
// Dormant tot allowlist — QA via ?v2preview=leadsonderhoud.
//
// DATA-KOPPELING 2026-08-13 — LICHT + needs-Jeffrey.
//
// KRITIEKE MISMATCH tussen v2-scaffold en v1:
// - v2-scaffold had bulk-nieuwsbrief-tabs (Inbox / Contacten / Bulk / Statistieken).
// - v1 modules/leadsonderhoud.html is een drip-motor + inbox per lead: 6 tabs
//   Overzicht / Wachtrij / Gesprekken / Trajecten / Berichten / Vragenlijst.
// De v2-scaffold matcht dus niet met de bestaande v1-realiteit.
//
// Aanpak deze data-ronde:
// - We vervangen de bulk-scaffold met de v1-tab-set (namen).
// - Alleen Overzicht is nu écht gekoppeld aan /api/leadsonderhoud-overzicht
//   (read-only lijst). De 5 andere tabs krijgen een needs-Jeffrey banner
//   met link naar de v1-pagina.
// - Alle write-flows (reply, traject-CRUD, quiz-editor, live-schuif) blijven
//   in v1. Zodra Jeffrey beslist hoe de v2-scaffold moet, kunnen we die tabs
//   apart uitbouwen.

(function () {
  if (!window.DFO) { console.error('[leadsonderhoud-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[leadsonderhoud-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const _live = {
    overzicht: { loading: false, error: null, data: null, filterTraject: '' },
  };
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[lo-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }
  async function fetchOverzicht(traject) {
    const st = _live.overzicht;
    const t = traject != null ? traject : st.filterTraject;
    if (st.loading || (st.data && st.filterTraject === t)) return;
    st.loading = true; st.error = null; st.filterTraject = t; st.data = null;
    const url = '/api/leadsonderhoud-overzicht' + (t ? '?traject=' + encodeURIComponent(t) : '');
    const j = await tryFetch('overzicht', url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { items: asArr(j?.items), totaal: Number(j?.totaal || 0) };
    if (window.DFO?.render) window.DFO.render();
  }
  window.__loRetry = () => { _live.overzicht.data = null; _live.overzicht.error = null; fetchOverzicht(); };
  window.__loSetTraject = (v) => { fetchOverzicht(v); };

  function _relTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Date.now() - t;
    const min = Math.floor(diff / 60000);
    const hr = Math.floor(diff / 3600000);
    const day = Math.floor(diff / 86400000);
    if (diff < 60000) return 'zojuist';
    if (min < 60) return min + 'm';
    if (hr < 24) return hr + 'u';
    return day + 'd';
  }
  function _naam(r) { return [r?.voornaam, r?.achternaam].filter(Boolean).join(' ') || r?.email || '—'; }

  const errBlk = (msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon overzicht niet ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__loRetry()">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;

  const needsJeffreyTab = (label, endpoint) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;line-height:1.6">
    <div style="display:flex;align-items:flex-start;gap:12px">
      <span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}</span>
      <div>
        <b>Tab '${esc(label)}' — needs Jeffrey</b><br>
        Endpoint bestaat wel (<code>${esc(endpoint)}</code>) maar de v2-scaffold matchte
        oorspronkelijk niet met de v1-tab-set. Voor deze data-ronde is alleen Overzicht
        gekoppeld; deze tab wacht op Jeffrey's beslissing over de definitieve v2-UI.
        Gebruik zolang de v1-pagina.
      </div>
    </div>
    <div style="margin-top:10px"><a class="btn btn-ghost btn-sm" href="/modules/leadsonderhoud.html" target="_blank">${svg(I.eye || I.doc)}Openen in v1</a></div>
  </div>`;

  // ── VIEW: Overzicht ───────────────────────────────────────────────────
  function overzichtView() {
    if (!_live.overzicht.data && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(fetchOverzicht);
    if (_live.overzicht.error && !_live.overzicht.data) return errBlk(_live.overzicht.error);
    if (_live.overzicht.loading && !_live.overzicht.data) return skel();
    const items = asArr(_live.overzicht.data?.items);
    const totaal = Number(_live.overzicht.data?.totaal || items.length);
    const q = (F('q', '') || '').toLowerCase();
    const rows = items.filter((r) => {
      if (!q) return true;
      const n = _naam(r).toLowerCase();
      return n.includes(q) || String(r.email || '').toLowerCase().includes(q);
    });
    const warm = items.filter((r) => Number(r.score || 0) >= 5).length;
    const koud = items.filter((r) => Number(r.score || 0) < 5).length;
    const gesprek = items.filter((r) => r.gesprek_op).length;
    return `${H.kpis([
      { c: 'violet',  icon: I.users, label: 'Actieve trials', val: String(totaal), sub: 'in nurturing' },
      { c: 'emerald', icon: I.tick,  label: 'Warm (score ≥5)', val: String(warm), hi: 1, sub: 'kansrijk' },
      { c: 'amber',   icon: I.alert, label: 'Koud (score <5)', val: String(koud), hi: 1, sub: 'weinig activiteit' },
      { c: 'blue',    icon: I.phone, label: 'Gesprek gepland', val: String(gesprek), sub: 'komende sessies' },
    ])}
    ${H.toolbar([
      `<input class="filter-sel" placeholder="Filter traject…" value="${esc(_live.overzicht.filterTraject || '')}" onchange="__loSetTraject(this.value)">`,
      H.search('Zoek naam of e-mail…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__loRetry()">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen trials</div><div class="empty-s">${items.length === 0 ? 'Geen trials in nurturing op dit moment.' : 'Geen resultaten voor je zoekopdracht.'}</div></div>`
      : H.table(
          [{ l: 'Lead' }, { l: 'Traject', cls: 'optional' }, { l: 'Dag', cls: 'r' }, { l: 'Lessen', cls: 'r optional' }, { l: 'Trades', cls: 'r optional' }, { l: 'Discord', cls: 'optional' }, { l: 'Sessie', cls: 'optional' }, { l: 'Warmte', cls: 'r' }, { l: 'Laatste contact', cls: 'r optional' }, { l: 'Status' }],
          rows.map((r) => {
            const score = Number(r.score || 0);
            const kleur = score >= 7 ? 'emerald' : score >= 5 ? 'amber' : 'rose';
            return [
              `<div class="row-avatar">${H.av(_naam(r), 28)}<div><div class="cell-main">${esc(_naam(r))}</div><div class="cell-sub">${esc(r.email || '')}</div></div></div>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(r.traject || '—')}</span>`,
              `<span class="mono">${r.dag != null ? r.dag : '—'}${r.dagen_over != null ? ' <span style="color:var(--text-3)">(' + r.dagen_over + ' te gaan)</span>' : ''}</span>`,
              `<span class="mono">${r.lessen_gezien != null ? r.lessen_gezien : '—'}</span>`,
              `<span class="mono">${r.trades != null ? r.trades : '—'}</span>`,
              r.discord ? H.pill('ok', 'ja') : H.pill('neutral', 'nee'),
              r.sessie_bijgewoond ? H.pill('ok', 'ja') : H.pill('neutral', 'nee'),
              `<span class="mono" style="color:var(--${kleur});font-weight:600">${score}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${_relTime(r.laatste_contact)}</span>`,
              r.onderhoud_pauze ? H.pill('warn', 'Gepauzeerd') : r.gesprek_op ? H.pill('accent', 'Gesprek') : H.pill('neutral', 'Actief'),
            ];
          })
        )}`;
  }

  function wachtrijView()   { return needsJeffreyTab('Wachtrij',   '/api/leadsonderhoud-wachtrij'); }
  function gesprekkenView() { return needsJeffreyTab('Gesprekken', '/api/leadsonderhoud-gesprekken'); }
  function trajectenView()  { return needsJeffreyTab('Trajecten',  '/api/leadsonderhoud-trajecten'); }
  function berichtenView()  { return needsJeffreyTab('Berichten',  '/api/leadsonderhoud-sjablonen'); }
  function vragenlijstView(){ return needsJeffreyTab('Vragenlijst','/api/leadsonderhoud-quiz-list'); }

  // ── Registratie ───────────────────────────────────────────────────────
  // De v2-shell registreert momenteel 4 tabs voor leadsonderhoud in
  // app-shell.js:81 (`['Inbox','Contacten','Bulk versturen','Statistieken']`).
  // v1 heeft echter 6 andere tabs (Overzicht/Wachtrij/Gesprekken/Trajecten/
  // Berichten/Vragenlijst) — scaffold-mismatch die Jeffrey moet oplossen.
  //
  // We registreren alle relevante tab-keys zodat: (a) shell-nav werkt met
  // huidige 4 tabs, en (b) toekomstige nav-swap naar v1-tab-set direct
  // werkt zonder deze file te wijzigen. Overzicht is de ENIGE live tab;
  // de andere tab-keys tonen needs-Jeffrey banner.
  window.DFO.VIEWS['leadsonderhoud/']              = overzichtView; // default-fallback
  window.DFO.VIEWS['leadsonderhoud/Overzicht']     = overzichtView;
  window.DFO.VIEWS['leadsonderhoud/Wachtrij']      = wachtrijView;
  window.DFO.VIEWS['leadsonderhoud/Gesprekken']    = gesprekkenView;
  window.DFO.VIEWS['leadsonderhoud/Trajecten']     = trajectenView;
  window.DFO.VIEWS['leadsonderhoud/Berichten']     = berichtenView;
  window.DFO.VIEWS['leadsonderhoud/Vragenlijst']   = vragenlijstView;
  // Bestaande shell-tabnamen (bulk-nieuwsbrief) — bewaren tot Jeffrey beslist:
  window.DFO.VIEWS['leadsonderhoud/Inbox']         = overzichtView; // toon huidige overzicht
  window.DFO.VIEWS['leadsonderhoud/Contacten']     = overzichtView;
  window.DFO.VIEWS['leadsonderhoud/Bulk versturen'] = () => needsJeffreyTab('Bulk versturen', 'geen v1-endpoint');
  window.DFO.VIEWS['leadsonderhoud/Statistieken']  = () => needsJeffreyTab('Statistieken', 'geen v1-stats-endpoint');
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leadsonderhoud');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leadsonderhoud');

  console.debug('[leadsonderhoud-v2] data-ronde geregistreerd — Overzicht LIVE, scaffold-mismatch needs Jeffrey');
})();
