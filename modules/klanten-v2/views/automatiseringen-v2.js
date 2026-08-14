// modules/klanten-v2/views/automatiseringen-v2.js
//
// Automatiseringen v2 — VOLLEDIGE BOUW (PR #1298).
//
// 5 tabs:
//   Overzicht      — live status via /api/automations-status (motoren +
//                    crons + schakelaars); toggles voor leadsonderhoud;
//                    Wanbetalers = beschermd (read-only + deep-link).
//   Events         — volledige editor-parity: lijst / create / edit /
//                    delete / toggle / test-run / runs-log. Alle step-types
//                    en trigger-configs.
//   Onboarding     — idem (respecteer schema-verschillen: geen scope).
//   Leadsonderhoud — global aan/uit + sjablonen-lijst + trajecten met
//                    stap-editor.
//   Agents         — read-only mirror van joost_config feature_flags per
//                    module, met deep-link naar AI Agents-module.
//
// KRITIEK — Test-endpoints zijn GEEN dry-run: events/onboarding-automation-
// test.js INSERT'en een echte is_test=true attendee/onboarding en de engine
// stuurt écht naar het opgegeven email/phone (wait wordt versneld naar 15s).
// UI dwingt af: default test-target = ingelogde user email/phone, grote
// waarschuwing "TEST STUURT ECHT".
//
// Dormant. Preview ?v2preview=automatiseringen.

(function () {
  if (!window.DFO) { console.error('[automatiseringen-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[automatiseringen-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Toast helper — kopie van events-v2.js pattern. Deelt DOM-element #kv-toast
  // uit modules/klanten-v2/index.html (r129).
  function _showToast(msg) {
    const el = document.getElementById('kv-toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(_showToast._t); _showToast._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE STATE
  // ═══════════════════════════════════════════════════════════════════════
  const _live = {
    status:      { loading: false, error: null, data: null },   // /api/automations-status
    evAutos:     { loading: false, error: null, data: null },   // events-automations-list
    evRuns:      { loading: {}, error: {}, data: {} },          // per automation_id
    obAutos:     { loading: false, error: null, data: null },   // onboarding-automations-list
    obRuns:      { loading: {}, error: {}, data: {} },
    lsInst:      { loading: false, error: null, data: null },   // leadsonderhoud-instellingen
    lsSjab:      { loading: false, error: null, data: null },   // leadsonderhoud-sjablonen
    lsTraj:      { loading: false, error: null, data: null },   // leadsonderhoud-trajecten
    lsDrog:      { loading: false, error: null, data: null },   // leadsonderhoud-droogloop-log
    lsQuiz:      { loading: false, error: null, data: null },   // leadsonderhoud-quiz-lijst (voor picker)
    // WA-templates voor send_whatsapp step, PER MODULE (events-whatsapp-templates-list
    // en onboarding-whatsapp-templates-list — inbox-template-list eist conversation_id
    // en werkt niet in de automation-builder context, gaf oneindige 400-loop).
    evTpls:      { loading: false, error: null, data: null },
    obTpls:      { loading: false, error: null, data: null },
    // Berichten-tab data (Events + Onboarding read-view over steps[])
    evBerichten: { loading: false, error: null, data: null },   // events-berichten-list
    obBerichten: { loading: false, error: null, data: null },   // onboarding-berichten-list
    // Leadsonderhoud berichten-log (voor Log-tab)
    lsLog:       { loading: false, error: null, data: null },
    // Automation-lookup voor bericht-editor surgical write (per id)
    evAutoById:  { loading: {}, error: {}, data: {} },
    obAutoById:  { loading: {}, error: {}, data: {} },
  };

  const _ui = {
    // Editor state per module — voorkomt dat we tussen sub-tabs interferereren
    ev: { subtab: 'flows', editing: null, wizardStep: 1, testModal: null, runsModal: null, filter: 'all', berichtEdit: null },
    ob: { subtab: 'flows', editing: null, wizardStep: 1, testModal: null, runsModal: null, filter: 'all', berichtEdit: null },
    ls: {
      subtab: 'flows',             // 'flows' | 'berichten' | 'instellingen' | 'log'
      view: 'trajecten',           // deprecated (voor backwards-compat, chip-toolbar hergebruikt subtab)
      editingTraject: null,        // {} tijdens create/edit
      editingStap: null,           // { traject_id, stap? } tijdens create/edit
      editingSjabloon: null,       // {} tijdens create/edit
      expandedTrajectId: null,     // welke traject-row is uitgeklapt
    },
    // Busy-flags tegen dubbelklik
    busy: {},   // key → true
    // Toggle-confirm modal
    confirmModal: null,   // { title, body, onConfirm, danger }
  };

  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[auto-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FETCHERS
  // ═══════════════════════════════════════════════════════════════════════
  async function fetchStatus() {
    const st = _live.status; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('status', '/api/automations-status');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchEvAutos() {
    const st = _live.evAutos; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('evAutos', '/api/events-automations-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.automations || j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchEvRuns(automationId) {
    const st = _live.evRuns; if (st.loading[automationId] || st.data[automationId]) return;
    st.loading[automationId] = true; st.error[automationId] = null;
    const j = await tryFetch('evRuns:' + automationId, '/api/events-automation-runs?automation_id=' + encodeURIComponent(automationId));
    st.loading[automationId] = false;
    if (j && j.__error) st.error[automationId] = j.__error; else st.data[automationId] = asArr(j?.runs || j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchObAutos() {
    const st = _live.obAutos; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('obAutos', '/api/onboarding-automations-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.automations || j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchObRuns(automationId) {
    const st = _live.obRuns; if (st.loading[automationId] || st.data[automationId]) return;
    st.loading[automationId] = true; st.error[automationId] = null;
    const j = await tryFetch('obRuns:' + automationId, '/api/onboarding-automation-runs?automation_id=' + encodeURIComponent(automationId));
    st.loading[automationId] = false;
    if (j && j.__error) st.error[automationId] = j.__error; else st.data[automationId] = asArr(j?.runs || j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsInst() {
    const st = _live.lsInst; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lsInst', '/api/leadsonderhoud-instellingen');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsSjab() {
    const st = _live.lsSjab; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lsSjab', '/api/leadsonderhoud-sjablonen');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = { items: asArr(j?.items), logo_url: j?.logo_url || null };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsTraj() {
    const st = _live.lsTraj; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lsTraj', '/api/leadsonderhoud-trajecten');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.trajecten);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsDrog() {
    const st = _live.lsDrog; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lsDrog', '/api/leadsonderhoud-droogloop-log');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsQuiz() {
    const st = _live.lsQuiz; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lsQuiz', '/api/leadsonderhoud-quiz-lijst');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  // ── HARMONISATIE — Berichten + Log fetchers ─────────────────────────────
  async function fetchEvBerichten() {
    const st = _live.evBerichten; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('evBerichten', '/api/events-berichten-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchObBerichten() {
    const st = _live.obBerichten; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('obBerichten', '/api/onboarding-berichten-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLsLog(filters) {
    const st = _live.lsLog; if (st.loading) return;
    st.loading = true; st.error = null;
    const f = filters || {};
    const params = [];
    if (f.traject) params.push('traject=' + encodeURIComponent(f.traject));
    if (f.status)  params.push('status='  + encodeURIComponent(f.status));
    if (f.soort)   params.push('soort='   + encodeURIComponent(f.soort));
    const url = '/api/leadsonderhoud-berichten-log' + (params.length ? '?' + params.join('&') : '');
    const j = await tryFetch('lsLog', url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { items: asArr(j?.items), totaal: j?.totaal || 0, statussen: j?.statussen || { verstuurd: 0, droog: 0, fout: 0 } };
    if (window.DFO?.render) window.DFO.render();
  }
  // Enkele automation ophalen (voor bericht-editor surgical write)
  async function fetchEvAutoById(id) {
    const st = _live.evAutoById; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    // Hergebruik events-automations-list en filter client-side (geen /api/events-automation-get endpoint)
    if (!_live.evAutos.data) await fetchEvAutos();
    const a = asArr(_live.evAutos.data).find((x) => x.id === id);
    st.loading[id] = false;
    if (!a) st.error[id] = 'Automation niet gevonden';
    else st.data[id] = JSON.parse(JSON.stringify(a));
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchObAutoById(id) {
    const st = _live.obAutoById; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    if (!_live.obAutos.data) await fetchObAutos();
    const a = asArr(_live.obAutos.data).find((x) => x.id === id);
    st.loading[id] = false;
    if (!a) st.error[id] = 'Automation niet gevonden';
    else st.data[id] = JSON.parse(JSON.stringify(a));
    if (window.DFO?.render) window.DFO.render();
  }
  // Template-picker voor send_whatsapp step — PER MODULE.
  // Guard bevat st.error om oneindige refetch-loop te voorkomen (queueMicrotask
  // uit render zou anders elke tick opnieuw fetchen bij persistent error).
  // Retry: window.__autTplsRetry(moduleKey) reset error + fetcht opnieuw.
  async function fetchEvTpls() {
    const st = _live.evTpls; if (st.loading || st.data || st.error) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('evTpls', '/api/events-whatsapp-templates-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchObTpls() {
    const st = _live.obTpls; if (st.loading || st.data || st.error) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('obTpls', '/api/onboarding-whatsapp-templates-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  window.__autTplsRetry = (moduleKey) => {
    const st = moduleKey === 'ev' ? _live.evTpls : _live.obTpls;
    st.data = null; st.error = null;
    if (moduleKey === 'ev') fetchEvTpls(); else fetchObTpls();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  const errBlk = (block, msg, retryFn) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span style="flex:1">${svg(I.alert)} ${esc(msg)}</span>
    ${retryFn ? `<button class="btn btn-ghost btn-sm" onclick="${retryFn}">Opnieuw</button>` : ''}
  </div>`;
  const skel = () => `<div style="padding:24px 20px"><div style="height:120px;background:var(--surface-2);border-radius:12px;opacity:.5"></div></div>`;
  const emptyBlk = (title, sub) => `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">
    <div style="font-size:15px;font-weight:600;color:var(--text-2);margin-bottom:6px">${esc(title)}</div>
    <div style="font-size:12.5px">${esc(sub)}</div>
  </div>`;

  function _fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('nl-NL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  }
  function _fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day:'2-digit', month:'short', year:'numeric' });
  }
  function _fmtRel(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return s + 's geleden';
    if (s < 3600) return Math.floor(s/60) + 'm geleden';
    if (s < 86400) return Math.floor(s/3600) + 'u geleden';
    return Math.floor(s/86400) + 'd geleden';
  }
  function _statusPill(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'active')  return H.pill('ok', 'Actief');
    if (s === 'idle')    return H.pill('neutral', 'Idle (24u)');
    if (s === 'unknown') return H.pill('warn', 'Onbekend');
    if (s === 'failed' || s === 'error') return H.pill('danger', 'Fout');
    return H.pill('neutral', status || '—');
  }
  function _busy(key) { return !!_ui.busy[key]; }
  function _setBusy(key, val) {
    _ui.busy[key] = !!val;
    if (window.DFO?.render) window.DFO.render();
  }

  // Confirm-modal helper
  window.__autConfirm = null;
  function askConfirm(title, body, onConfirm, opts) {
    _ui.confirmModal = { title, body, onConfirm, danger: opts?.danger || false, confirmLabel: opts?.confirmLabel || 'Bevestigen' };
    if (window.DFO?.render) window.DFO.render();
  }
  window.__autConfirmYes = async () => {
    const m = _ui.confirmModal;
    if (!m) return;
    _ui.confirmModal = null;
    if (window.DFO?.render) window.DFO.render();
    try { await m.onConfirm(); } catch (e) { alert('Actie mislukt: ' + (e?.message || 'onbekende fout')); }
  };
  window.__autConfirmNo = () => { _ui.confirmModal = null; if (window.DFO?.render) window.DFO.render(); };

  function _confirmModalHtml() {
    const m = _ui.confirmModal; if (!m) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__autConfirmNo()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);font-size:14px;font-weight:600">${esc(m.title)}</div>
        <div style="padding:16px 18px;font-size:13px;line-height:1.55;color:var(--text-2)">${m.body}</div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__autConfirmNo()">Annuleren</button>
          <button class="btn ${m.danger ? 'btn-danger' : 'btn-primary'} btn-sm" onclick="window.__autConfirmYes()">${esc(m.confirmLabel)}</button>
        </div>
      </div>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TAB: OVERZICHT (live status)
  // ═══════════════════════════════════════════════════════════════════════
  function overzichtView() {
    if (!_live.status.data && !_live.status.loading && !_live.status.error) queueMicrotask(fetchStatus);
    if (_live.status.error && !_live.status.data) return errBlk('status', _live.status.error, "window.__autRetry('status')") + _confirmModalHtml();
    if (_live.status.loading && !_live.status.data) return skel() + _confirmModalHtml();

    const d = _live.status.data || {};
    const motoren = asArr(d.motoren);
    const crons = asArr(d.crons);
    const schakelaars = asArr(d.schakelaars);

    const activeCnt = motoren.filter((m) => m.status === 'active').length;
    const unknownCnt = motoren.filter((m) => m.status === 'unknown').length;
    const failedCnt = motoren.reduce((a, m) => a + Number(m.last_24h_failed || 0), 0);

    return `${H.kpis([
      { c:'pink',    icon:I.zap    || I.tick, label:'Motoren actief (24u)', val:String(activeCnt), sub:motoren.length + ' totaal' },
      { c:'amber',   icon:I.alert, label:'Fouten (24u)',              val:String(failedCnt), hi: failedCnt > 0 ? 1 : 0 },
      { c:'slate',   icon:I.clock, label:'Status onbekend',           val:String(unknownCnt), sub:'Beheer via Vercel-dashboard' },
      { c:'blue',    icon:I.cog   || I.settings, label:'Crons geregistreerd', val:String(crons.length), sub:'in vercel.json' },
    ])}

    <div class="pad" style="padding-top:14px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.zap || I.tick)}</span>
          <div class="card-title">Motoren</div>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">env: ${esc(d.env || '—')}</span>
        </div>
        <div class="card-body" style="padding:0">
          ${motoren.length === 0 ? emptyBlk('Geen motoren', 'Kon geen motor-status ophalen.') : `<div>
            ${motoren.map((m) => _motorCard(m)).join('')}
          </div>`}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.slider || I.cog || I.settings)}</span>
          <div class="card-title">Schakelaars</div>
        </div>
        <div class="card-body" style="padding:12px 17px">
          ${schakelaars.length === 0 ? emptyBlk('Geen schakelaars', 'Geen toggle-flags gevonden.') : schakelaars.map((s) => _schakelaarRow(s)).join('')}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--slate-soft);color:var(--slate)">${svg(I.clock)}</span>
          <div class="card-title">Crons (vercel.json)</div>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">${crons.length} geregistreerd</span>
        </div>
        <div class="card-body" style="padding:0">
          ${crons.length === 0 ? emptyBlk('Geen crons', 'vercel.json bevat geen crons-array.') : H.table(
            [{l:'Cron'},{l:'Schedule',cls:'mono'},{l:'Endpoint',cls:'mono'}],
            crons.map((c) => [
              `<span style="font-size:12.5px">${esc(c.label)}</span>`,
              `<span class="mono" style="font-size:12px;color:var(--text-3)">${esc(c.schedule)}</span>`,
              `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(c.endpoint)}</span>`,
            ])
          )}
        </div>
      </div>
    </div>
    ${_confirmModalHtml()}`;
  }

  function _motorCard(m) {
    const statusChip = _statusPill(m.status);
    const failed = Number(m.last_24h_failed || 0);
    return `<div style="padding:14px 17px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:flex-start">
      <span class="tile-ico" style="background:var(--emerald-soft);color:var(--emerald);width:36px;height:36px;flex-shrink:0">${svg(I.zap || I.tick, 'width:16px;height:16px')}</span>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
          <div style="font-size:13.5px;font-weight:600">${esc(m.label)}</div>
          ${statusChip}
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:3px;display:flex;gap:14px;flex-wrap:wrap">
          ${m.schedule ? `<span class="mono">Schedule: ${esc(m.schedule)}</span>` : ''}
          ${m.last_24h_runs != null ? `<span>Runs (24u): <b style="color:var(--text-2)">${m.last_24h_runs}</b></span>` : `<span style="color:var(--text-3)">Runs onbekend</span>`}
          ${failed > 0 ? `<span style="color:var(--rose)">Fouten: <b>${failed}</b></span>` : ''}
          ${m.last_run_at ? `<span>Laatste run: ${esc(_fmtRel(m.last_run_at))}</span>` : ''}
        </div>
      </div>
      <div style="flex-shrink:0">
        ${m.key === 'events-automations' ? `<button class="btn btn-ghost btn-sm" onclick="window.__autGoTab('events')">Beheren →</button>`
          : m.key === 'onboarding-automations' ? `<button class="btn btn-ghost btn-sm" onclick="window.__autGoTab('onboarding')">Beheren →</button>`
          : m.key === 'leadsonderhoud' ? `<button class="btn btn-ghost btn-sm" onclick="window.__autGoTab('leadsonderhoud')">Beheren →</button>`
          : ''}
      </div>
    </div>`;
  }

  function _schakelaarRow(s) {
    const val = s.value;
    let valDisplay = '—';
    if (val === null || val === undefined) valDisplay = 'niet gezet';
    else if (typeof val === 'boolean') valDisplay = val ? 'aan' : 'uit';
    else if (typeof val === 'object' && val.enabled !== undefined) valDisplay = val.enabled ? 'aan' : 'uit';
    else if (typeof val === 'object' && val.hours !== undefined) valDisplay = val.hours + ' uur';
    else valDisplay = JSON.stringify(val).slice(0, 50);
    const editableLs = s.key === 'leadsonderhoud_live' && s.editable;
    return `<div style="display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500">${esc(s.label)}${s.protectedZone ? ' <span class="pill pill-warn nodot" style="font-size:9px;padding:1px 5px">🔒 protected</span>' : ''}</div>
        <div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:2px">${esc(s.source)}</div>
      </div>
      <div style="font-size:12px;color:var(--text-2)">${esc(valDisplay)}</div>
      ${editableLs
        ? `<button class="btn btn-ghost btn-sm" onclick="window.__autLsToggle()" ${_busy('lsToggle') ? 'disabled' : ''}>${(val === true || val?.enabled === true) ? 'Uit zetten' : 'Aan zetten'}</button>`
        : s.protectedZone
          ? `<a href="/modules/finance.html#wanbetalers" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none;font-size:11px">Open bron ↗</a>`
          : `<span style="font-size:10.5px;color:var(--text-3)">read-only</span>`}
    </div>`;
  }

  window.__autRetry = (block) => {
    if (block === 'status')   { _live.status.data = null; _live.status.error = null; fetchStatus(); }
    if (block === 'evAutos')  { _live.evAutos.data = null; _live.evAutos.error = null; fetchEvAutos(); }
    if (block === 'obAutos')  { _live.obAutos.data = null; _live.obAutos.error = null; fetchObAutos(); }
    if (block === 'lsInst')   { _live.lsInst.data = null; _live.lsInst.error = null; fetchLsInst(); }
    if (block === 'lsSjab')   { _live.lsSjab.data = null; _live.lsSjab.error = null; fetchLsSjab(); }
    if (block === 'lsTraj')   { _live.lsTraj.data = null; _live.lsTraj.error = null; fetchLsTraj(); }
    if (block === 'lsDrog')   { _live.lsDrog.data = null; _live.lsDrog.error = null; fetchLsDrog(); }
    if (block === 'evBerichten') { _live.evBerichten.data = null; _live.evBerichten.error = null; fetchEvBerichten(); }
    if (block === 'obBerichten') { _live.obBerichten.data = null; _live.obBerichten.error = null; fetchObBerichten(); }
    if (block === 'lsLog')       { _live.lsLog.data = null; _live.lsLog.error = null; fetchLsLog(); }
    if (window.DFO?.render) window.DFO.render();
  };
  // Bug-fix: bestaande handler gebruikte DFO.setTab (bestaat niet). Correct is
  // DFO.goTab. Tab-namen in app-shell zijn Kapitalized ('Events','Onboarding',
  // 'Leadsonderhoud') — mapping via title-case op de subtab-key.
  window.__autGoTab = (subtab) => {
    try {
      const label = String(subtab || '').charAt(0).toUpperCase() + String(subtab || '').slice(1);
      if (window.DFO?.goTab) window.DFO.goTab(label);
    } catch (e) { console.warn('[aut] goTab fail:', e?.message); }
  };

  // Leadsonderhoud toggle (met confirm)
  window.__autLsToggle = async () => {
    const cur = _live.status.data?.schakelaars?.find((s) => s.key === 'leadsonderhoud_live');
    const isOn = cur?.value === true || cur?.value?.enabled === true;
    askConfirm(
      isOn ? 'Leadsonderhoud UIT zetten?' : 'Leadsonderhoud AAN zetten?',
      `<p>Zet <b>leadsonderhoud_live_${esc(_live.status.data?.env || '?')}</b> ${isOn ? 'op <b style="color:var(--rose)">uit</b>' : 'op <b style="color:var(--emerald)">aan</b>'}.</p>
       <p>${isOn ? 'De drip-motor stopt met versturen tot je hem weer aan zet.' : 'De drip-motor start binnen 15 min met versturen volgens de trajecten.'}</p>`,
      async () => {
        _setBusy('lsToggle', true);
        try {
          const j = await window.KV.authedJson('/api/leadsonderhoud-instellingen', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ live: !isOn }),
          });
          if (j?.error) throw new Error(j.error);
          // Invalidate + refetch status
          _live.status.data = null; _live.status.error = null;
          _live.lsInst.data = null; _live.lsInst.error = null;
          queueMicrotask(fetchStatus);
        } finally { _setBusy('lsToggle', false); }
      },
      { confirmLabel: isOn ? 'Ja, uit zetten' : 'Ja, aan zetten', danger: isOn }
    );
  };

  // ═══════════════════════════════════════════════════════════════════════
  // TAB: EVENTS — volledige editor-parity
  // ═══════════════════════════════════════════════════════════════════════
  const EV_TRIGGERS = [
    { v: 'on_signup',                       l: 'Bij aanmelding' },
    { v: 'on_assessment_completed',         l: 'Bij ingevulde vragenlijst' },
    { v: 'time_before_event',               l: 'X tijd vóór event' },
    { v: 'on_assessment_not_completed_after', l: 'X tijd na aanmelding, vragenlijst nog niet in' },
  ];
  const EV_SCOPES  = ['all', 'niveau', 'events'];
  const EV_ENROLL  = ['new_only', 'include_existing'];
  const EV_STEP_TYPES = [
    { v: 'wait',                      l: 'Wachten (X tijd)' },
    { v: 'condition',                 l: 'Voorwaarde (check + stop-of-doorgaan)' },
    { v: 'send_email',                l: 'E-mail versturen' },
    { v: 'send_whatsapp',             l: 'WhatsApp-template versturen' },
    { v: 'set_tag',                   l: 'Tag toevoegen aan deelnemer' },
    { v: 'update_attendee_status',    l: 'Deelnemer-status bijwerken' },
    { v: 'send_internal_notification',l: 'Interne notificatie' },
  ];

  function eventsView() {
    if (!_live.evAutos.data && !_live.evAutos.loading && !_live.evAutos.error) queueMicrotask(fetchEvAutos);
    // Full-screen editor/modal-modes hebben voorrang boven subtab-toolbar
    if (_ui.ev.editing) return _evEditor(_ui.ev.editing) + _confirmModalHtml();
    if (_ui.ev.testModal) return _evTestModal() + _confirmModalHtml();
    // Subtab-router
    const sub = _ui.ev.subtab || 'flows';
    let content;
    if (sub === 'berichten')          content = _evBerichtenView();
    else if (sub === 'instellingen')  content = _evInstellingenView();
    else if (sub === 'log')           content = _evLogView();
    else {
      // 'flows' — bestaande lijst-editor
      if (_live.evAutos.error && !_live.evAutos.data) content = errBlk('evAutos', _live.evAutos.error, "window.__autRetry('evAutos')");
      else if (_live.evAutos.loading && !_live.evAutos.data) content = skel();
      else content = _evList();
    }
    return _subtabToolbar('ev', sub) + content + _confirmModalHtml();
  }
  function _evList() {
    const all = asArr(_live.evAutos.data);
    const filter = _ui.ev.filter;
    const rows = filter === 'enabled' ? all.filter((a) => a.enabled)
              : filter === 'disabled' ? all.filter((a) => !a.enabled)
              : all;
    return `<div class="toolbar" style="padding:12px 20px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${[['all','Alles'],['enabled','Actief'],['disabled','Uit']].map(([v, l]) => `<button class="chip ${filter === v ? 'on' : ''}" onclick="window.__autEvFilter('${v}')">${esc(l)}<span class="cnt">${v === 'all' ? all.length : (v === 'enabled' ? all.filter((a) => a.enabled).length : all.filter((a) => !a.enabled).length)}</span></button>`).join('')}
      <div class="tb-right" style="margin-left:auto">
        <button class="btn btn-primary btn-sm" onclick="window.__autEvNew()">${svg(I.plus)}Nieuwe automation</button>
      </div>
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen automations', 'Klik "Nieuwe automation" om er een te maken.')
      : `<div style="padding:0 20px 20px">${H.table(
          [{l:'Naam'},{l:'Trigger',cls:'optional'},{l:'Scope',cls:'optional'},{l:'Stappen',cls:'r optional'},{l:'Status'},{l:'',cls:'r'}],
          rows.map((a) => [
            `<div><div class="cell-main">${esc(a.name || '—')}</div>${a.description ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(a.description)}</div>` : ''}</div>`,
            `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(a.trigger_type || '—')}</span>`,
            `<span style="font-size:11.5px;color:var(--text-3)">${esc(a.scope_type || 'all')}</span>`,
            `<span class="mono">${asArr(a.steps).length}</span>`,
            a.enabled ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
            `<div style="display:flex;gap:4px;justify-content:flex-end">
              <button class="icon-btn" title="Toggle" onclick="window.__autEvToggle('${esc(a.id)}')" ${_busy('evTog:' + a.id) ? 'disabled' : ''} style="width:28px;height:28px">${svg(a.enabled ? (I.pause || I.x) : (I.play || I.tick), 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Test" onclick="window.__autEvTest('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.flask || I.tick, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Runs" onclick="window.__autEvRuns('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.clock, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Bewerken" onclick="window.__autEvEdit('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.edit || I.settings, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Verwijderen" onclick="window.__autEvDelete('${esc(a.id)}','${esc(a.name || '')}')" style="width:28px;height:28px">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
            </div>`,
          ])
        )}</div>`}`;
  }

  window.__autEvFilter = (v) => { _ui.ev.filter = v; if (window.DFO?.render) window.DFO.render(); };
  window.__autEvNew = () => {
    _ui.ev.editing = {
      id: null,
      name: '', description: '', enabled: false,
      trigger_type: 'on_signup', trigger_config: {},
      scope_type: 'all', scope_config: {},
      enroll_mode: 'new_only',
      steps: [],
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autEvEdit = (id) => {
    const a = asArr(_live.evAutos.data).find((x) => x.id === id);
    if (!a) return alert('Automation niet gevonden.');
    _ui.ev.editing = JSON.parse(JSON.stringify(a));   // deep copy voor edit
    _ui.ev.editing.trigger_config = _ui.ev.editing.trigger_config || {};
    _ui.ev.editing.scope_config = _ui.ev.editing.scope_config || {};
    _ui.ev.editing.steps = asArr(_ui.ev.editing.steps);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autEvBack = () => { _ui.ev.editing = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autEvToggle = async (id) => {
    const a = asArr(_live.evAutos.data).find((x) => x.id === id);
    if (!a) return;
    _setBusy('evTog:' + id, true);
    try {
      const j = await window.KV.authedJson('/api/events-automation-save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...a, enabled: !a.enabled }),
      });
      if (j?.error) throw new Error(j.error);
      _live.evAutos.data = null; queueMicrotask(fetchEvAutos);
    } catch (e) { alert('Toggle mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('evTog:' + id, false); }
  };
  window.__autEvDelete = (id, name) => {
    askConfirm(
      'Automation verwijderen?',
      `<p>Weet je zeker dat je <b>${esc(name)}</b> permanent wilt verwijderen?</p>
       <p style="color:var(--rose);font-size:12px">Deze actie kan niet ongedaan gemaakt worden. Bestaande runs blijven wel bewaard.</p>`,
      async () => {
        const j = await window.KV.authedJson('/api/events-automation-delete', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id }),
        });
        if (j?.error) throw new Error(j.error);
        _live.evAutos.data = null; queueMicrotask(fetchEvAutos);
      },
      { confirmLabel: 'Ja, verwijderen', danger: true }
    );
  };
  window.__autEvTest = (id) => {
    const a = asArr(_live.evAutos.data).find((x) => x.id === id);
    if (!a) return;
    if (!a.enabled) return alert('Zet de automation eerst aan voordat je een test-run doet.');
    _ui.ev.testModal = {
      automation_id: id,
      automation_name: a.name || '—',
      event_id: '',
      first_name: 'TEST',
      last_name: 'Jeffrey',
      email: 'biemoldjeffrey@gmail.com',
      phone: '+31600000000',
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autEvRuns = (id) => {
    _ui.ev.runsModal = { automation_id: id };
    if (!_live.evRuns.data[id]) queueMicrotask(() => fetchEvRuns(id));
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autEvRunsClose = () => { _ui.ev.runsModal = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autEvTestClose = () => { _ui.ev.testModal = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autEvTestField = (k, v) => { if (_ui.ev.testModal) _ui.ev.testModal[k] = v; };
  window.__autEvTestSubmit = async () => {
    const t = _ui.ev.testModal; if (!t) return;
    if (!t.event_id || !t.first_name || !t.last_name || !t.email || !t.phone) return alert('Alle velden zijn verplicht.');
    _setBusy('evTestSubmit', true);
    try {
      const j = await window.KV.authedJson('/api/events-automation-test', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          automation_id: t.automation_id, event_id: t.event_id,
          first_name: t.first_name, last_name: t.last_name, email: t.email, phone: t.phone,
        }),
      });
      if (j?.error) throw new Error(j.error);
      alert('Test gestart. Attendee-ID: ' + (j?.attendee_id || '—') + '\nRun-ID: ' + (j?.run_id || '—') + '\n\nDe automation loopt nu ECHT met versnelde wait-stappen. Berichten worden verstuurd naar het opgegeven email/nummer.');
      _ui.ev.testModal = null;
      if (window.DFO?.render) window.DFO.render();
    } catch (e) { alert('Test mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('evTestSubmit', false); }
  };

  function _evTestModal() {
    const t = _ui.ev.testModal; if (!t) return '';
    const busy = _busy('evTestSubmit');
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__autEvTestClose()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:560px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">Test-run: ${esc(t.automation_name)}</div>
          <button class="icon-btn" onclick="window.__autEvTestClose()" title="Sluiten" style="width:28px;height:28px">${svg(I.x || I.close, 'width:13px;height:13px')}</button>
        </div>
        <div style="padding:16px 18px">
          <div style="padding:10px 12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:8px;color:var(--rose);font-size:12.5px;line-height:1.5;margin-bottom:14px">
            <b>⚠ TEST STUURT ECHT.</b> Dit is <b>geen dry-run</b> — de automation-engine INSERT'et een test-attendee (is_test=true) en verstuurt daadwerkelijk berichten (met verkorte wait van 15s). Gebruik je eigen email/nummer om te voorkomen dat klanten test-berichten krijgen.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${_field('Event-ID (uuid)', 'event_id', t.event_id, 'text', 'Zoek in Events > Overzicht > kopieer event-ID')}
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              ${_field('Voornaam', 'first_name', t.first_name, 'text')}
              ${_field('Achternaam', 'last_name', t.last_name, 'text')}
            </div>
            ${_field('E-mail (jouw eigen adres)', 'email', t.email, 'email')}
            ${_field('Telefoon (+316…)', 'phone', t.phone, 'tel', 'E.164 format, bv. +31612345678')}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__autEvTestClose()">Annuleren</button>
          <button class="btn btn-primary btn-sm" onclick="window.__autEvTestSubmit()" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Start test-run'}</button>
        </div>
      </div>
    </div>`;
    function _field(label, key, val, kind, hint) {
      return `<div>
        <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">${esc(label)}</label>
        <input type="${kind}" value="${esc(val)}" oninput="window.__autEvTestField('${key}', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
        ${hint ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:3px">${esc(hint)}</div>` : ''}
      </div>`;
    }
  }

  function _evRunsModal() {
    const m = _ui.ev.runsModal; if (!m) return '';
    const runs = asArr(_live.evRuns.data[m.automation_id]);
    const loading = _live.evRuns.loading[m.automation_id];
    const err = _live.evRuns.error[m.automation_id];
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__autEvRunsClose()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:720px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">Runs-log</div>
          <button class="icon-btn" onclick="window.__autEvRunsClose()" title="Sluiten" style="width:28px;height:28px">${svg(I.x || I.close, 'width:13px;height:13px')}</button>
        </div>
        <div style="padding:16px 18px">
          ${err ? errBlk('evRuns', err)
            : loading ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Runs laden…</div>'
            : runs.length === 0 ? emptyBlk('Geen runs', 'Deze automation heeft nog niet gedraaid.')
            : `<div style="display:flex;flex-direction:column;gap:6px">${runs.slice(0, 50).map((r) => `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface)">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  ${_statusPill(r.status)}
                  ${r.is_test ? H.pill('warn','TEST') : ''}
                  <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(_fmtDateTime(r.started_at))}</span>
                  ${r.next_run_at ? `<span style="font-size:10.5px;color:var(--text-3)">volgende: ${esc(_fmtDateTime(r.next_run_at))}</span>` : ''}
                </div>
                <div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:3px">step_index: ${esc(String(r.current_step_index ?? '—'))} · attendee: ${esc(String(r.attendee_id || '').slice(0, 8))}…</div>
              </div>`).join('')}</div>`}
        </div>
      </div>
    </div>`;
  }

  // ── EVENTS EDITOR ──────────────────────────────────────────────────────
  function _evEditor(a) {
    const isNew = !a.id;
    const busy = _busy('evSave');
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autEvBack()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar lijst</button>
      <span style="font-size:14px;font-weight:600">${isNew ? 'Nieuwe automation' : 'Bewerken: ' + esc(a.name || '—')}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autEvSave()" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      ${_evCardBasis(a)}
      ${_evCardTrigger(a)}
      ${_evCardScope(a)}
      ${_evCardSteps(a)}
    </div></div>`;
  }
  function _evCardBasis(a) {
    return `<div class="card">
      <div class="card-head"><div class="card-title">Basis</div></div>
      <div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Naam</label>
          <input type="text" value="${esc(a.name)}" oninput="window.__autEvField('name', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Beschrijving</label>
          <textarea oninput="window.__autEvField('description', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box;min-height:60px;resize:vertical;font-family:inherit">${esc(a.description || '')}</textarea>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="window.__autEvField('enabled', this.checked)" />
          <span>Actief (draaien vanaf nu)</span>
        </label>
      </div>
    </div>`;
  }
  function _evCardTrigger(a) {
    return `<div class="card">
      <div class="card-head"><div class="card-title">Trigger</div></div>
      <div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Trigger-type</label>
          <select onchange="window.__autEvField('trigger_type', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
            ${EV_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger_type === t.v ? 'selected' : ''}>${esc(t.l)}</option>`).join('')}
          </select>
        </div>
        ${(a.trigger_type === 'time_before_event' || a.trigger_type === 'on_assessment_not_completed_after') ? (() => {
          // Canonieke keys (events-automation-save + engine):
          //   time_before_event               → trigger_config.hours_before
          //   on_assessment_not_completed_after → trigger_config.hours_after_signup
          // Legacy fallback op oude trigger_config.value voor migratie-safe read.
          const key = a.trigger_type === 'time_before_event' ? 'hours_before' : 'hours_after_signup';
          const label = a.trigger_type === 'time_before_event' ? 'Uren vóór event' : 'Uren na aanmelding';
          const currentHours = a.trigger_config?.[key] ?? a.trigger_config?.value ?? 24;
          return `<div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">${esc(label)}</label>
            <input type="number" min="1" value="${esc(String(currentHours))}" oninput="window.__autEvTrigHours(Number(this.value))" style="width:180px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
            <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Alleen uren — event-cron rekent in hele uren.</div>
          </div>`;
        })() : ''}
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Enroll-mode</label>
          <select onchange="window.__autEvField('enroll_mode', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
            ${EV_ENROLL.map((m) => `<option value="${m}" ${a.enroll_mode === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;
  }
  function _evCardScope(a) {
    return `<div class="card">
      <div class="card-head"><div class="card-title">Scope (welke events?)</div></div>
      <div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Scope-type</label>
          <select onchange="window.__autEvField('scope_type', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
            ${EV_SCOPES.map((s) => `<option value="${s}" ${a.scope_type === s ? 'selected' : ''}>${esc(s === 'all' ? 'Alle events' : s === 'niveau' ? 'Per niveau' : 'Specifieke events')}</option>`).join('')}
          </select>
        </div>
        ${a.scope_type === 'niveau' ? `
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Niveau-slug (comma-separated)</label>
            <input type="text" value="${esc((a.scope_config?.niveaus || []).join(','))}" oninput="window.__autEvScopeConfig('niveaus', this.value.split(',').map((s) => s.trim()).filter(Boolean))" placeholder="bv. beginner,gevorderd" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
          </div>
        ` : ''}
        ${a.scope_type === 'events' ? `
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Event-IDs (comma-separated uuids)</label>
            <textarea oninput="window.__autEvScopeConfig('event_ids', this.value.split(',').map((s) => s.trim()).filter(Boolean))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box;min-height:60px;font-family:'IBM Plex Mono',monospace;resize:vertical">${esc((a.scope_config?.event_ids || []).join(','))}</textarea>
          </div>
        ` : ''}
      </div>
    </div>`;
  }
  function _evCardSteps(a) {
    return `<div class="card">
      <div class="card-head"><div class="card-title">Stappen (${asArr(a.steps).length})</div>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__autEvStepAdd()">${svg(I.plus)}Stap toevoegen</button>
      </div>
      <div class="card-body" style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
        ${asArr(a.steps).length === 0
          ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12.5px;font-style:italic">Geen stappen — klik "Stap toevoegen" om te beginnen.</div>`
          : asArr(a.steps).map((step, idx) => _evStepCard(step, idx)).join('')}
      </div>
    </div>`;
  }
  function _evStepCard(step, idx) {
    return `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:10.5px;color:var(--text-3);font-weight:600">${idx + 1}.</span>
        <select onchange="window.__autEvStepType(${idx}, this.value)" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12.5px">
          ${EV_STEP_TYPES.map((t) => `<option value="${t.v}" ${step.type === t.v ? 'selected' : ''}>${esc(t.l)}</option>`).join('')}
        </select>
        <button class="icon-btn" title="Omhoog" onclick="window.__autEvStepMove(${idx}, -1)" style="width:24px;height:24px" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" title="Omlaag" onclick="window.__autEvStepMove(${idx}, 1)" style="width:24px;height:24px">↓</button>
        <button class="icon-btn" title="Verwijderen" onclick="window.__autEvStepDelete(${idx})" style="width:24px;height:24px">${svg(I.trash || I.x, 'width:11px;height:11px')}</button>
      </div>
      ${_evStepConfig(step, idx)}
    </div>`;
  }
  function _evStepConfig(step, idx) {
    const cfg = step.config || {};
    const upd = (k) => `window.__autEvStepConfig(${idx}, '${k}', this.value)`;
    if (step.type === 'wait') {
      // Canoniek veld = cfg.amount (save-validator + engine). Legacy fallback op cfg.value
      // voor pre-fix rijen; bij eerste re-save wordt cfg.amount geschreven.
      const waitVal = (cfg.amount != null ? cfg.amount : (cfg.value != null ? cfg.value : 1));
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label style="font-size:11px;color:var(--text-3)">Wachttijd</label><input type="number" value="${esc(String(waitVal))}" oninput="${upd('amount')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" /></div>
        <div><label style="font-size:11px;color:var(--text-3)">Eenheid</label><select onchange="${upd('unit')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">${['minutes','hours','days'].map((u) => `<option value="${u}" ${cfg.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      </div>`;
    }
    if (step.type === 'condition') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Check</label>
      <select onchange="${upd('check')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
        ${['assessment_completed','assessment_not_completed','still_registered','niveau_is_basis','niveau_is_gevorderd'].map((c) => `<option value="${c}" ${cfg.check === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <label style="font-size:11px;color:var(--text-3);margin-top:6px;display:block">Bij FALSE</label>
      <select onchange="${upd('on_fail')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
        ${['exit','skip_to_end'].map((v) => `<option value="${v}" ${cfg.on_fail === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>`;
    if (step.type === 'send_email') return `<div style="display:flex;flex-direction:column;gap:6px">
      <div><label style="font-size:11px;color:var(--text-3)">Onderwerp</label><input type="text" value="${esc(cfg.subject || '')}" oninput="${upd('subject')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" /></div>
      <div><label style="font-size:11px;color:var(--text-3)">Body (text)</label><textarea oninput="${upd('body')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box;min-height:80px;font-family:inherit;resize:vertical">${esc(cfg.body || '')}</textarea></div>
      <div class="mono" style="font-size:10.5px;color:var(--text-3)">Placeholders: {{attendee.voornaam}}, {{event.titel}}, {{event.datum}}</div>
    </div>`;
    if (step.type === 'send_whatsapp') {
      const stTpls = _live.evTpls;
      if (!stTpls.data && !stTpls.loading && !stTpls.error) queueMicrotask(fetchEvTpls);
      const tpls = asArr(stTpls.data);
      const savedName = cfg.template_name || '';
      const savedInList = tpls.some((t) => t.name === savedName);
      // Fallback-option: opgeslagen template staat niet in de geladen lijst
      // (of lijst kon niet laden). Renderen om te voorkomen dat de dropdown
      // "— kies template —" toont voor een LIVE opgeslagen template en de
      // gebruiker per ongeluk de waarde wist.
      const fallbackOpt = (savedName && !savedInList)
        ? `<option value="${esc(savedName)}" selected>${esc(savedName)} — opgeslagen (niet in huidige lijst)</option>` : '';
      const errNote = stTpls.error
        ? `<div style="font-size:10.5px;color:var(--rose);margin-top:4px">Templates niet geladen: ${esc(stTpls.error)}. <button class="btn btn-ghost btn-sm" onclick="window.__autTplsRetry('ev')" style="padding:2px 6px;font-size:10.5px">Opnieuw</button></div>`
        : `<div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:4px">${tpls.length} approved templates. Named placeholders (bv. {{attendee.voornaam}}) worden server-side geresolved.</div>`;
      // Placeholder is hidden zodra er een opgeslagen waarde is (zonder disabled
      // want dan kan user niet opnieuw kiezen). Op initieel-leeg wordt de
      // placeholder wel getoond als default.
      const placeholderSelected = !savedName ? 'selected' : '';
      return `<div>
        <label style="font-size:11px;color:var(--text-3)">Meta-template</label>
        <select onchange="window.__autEvStepConfigTpl(${idx}, this.value)" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
          <option value="" ${placeholderSelected}>— kies template —</option>
          ${fallbackOpt}
          ${tpls.map((t) => `<option value="${esc(t.name)}" ${savedName === t.name ? 'selected' : ''}>${esc(t.name)} (${esc(t.language || 'nl')})</option>`).join('')}
        </select>
        ${errNote}
      </div>`;
    }
    if (step.type === 'set_tag') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Tag</label>
      <input type="text" value="${esc(cfg.tag || '')}" oninput="${upd('tag')}" placeholder="bv. warm-lead" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" />
    </div>`;
    if (step.type === 'update_attendee_status') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Nieuwe status</label>
      <select oninput="${upd('status')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
        ${['aangemeld','aanwezig','no_show','sale','switched_to_other_event','geannuleerd'].map((s) => `<option value="${s}" ${cfg.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select>
    </div>`;
    if (step.type === 'send_internal_notification') return `<div style="display:flex;flex-direction:column;gap:6px">
      <div><label style="font-size:11px;color:var(--text-3)">Interne bericht (Slack/mail intern)</label><textarea oninput="${upd('message')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box;min-height:60px;font-family:inherit;resize:vertical">${esc(cfg.message || '')}</textarea></div>
    </div>`;
    return `<div style="font-size:11px;color:var(--text-3);font-style:italic">Nog geen editor voor "${esc(step.type)}"</div>`;
  }

  // Events editor handlers
  window.__autEvField = (k, v) => { if (_ui.ev.editing) _ui.ev.editing[k] = v; if (window.DFO?.render && (k === 'trigger_type' || k === 'scope_type')) window.DFO.render(); };
  window.__autEvTrigConfig = (k, v) => { if (_ui.ev.editing) { _ui.ev.editing.trigger_config = _ui.ev.editing.trigger_config || {}; _ui.ev.editing.trigger_config[k] = v; } };
  // Trigger-config canoniek: schrijft hours_before OF hours_after_signup afhankelijk
  // van trigger_type; ruimt legacy value/unit keys op zodat re-save schoon is.
  window.__autEvTrigHours = (h) => {
    if (!_ui.ev.editing) return;
    const cfg = _ui.ev.editing.trigger_config = _ui.ev.editing.trigger_config || {};
    const t = _ui.ev.editing.trigger_type;
    if (t === 'time_before_event') cfg.hours_before = h;
    else if (t === 'on_assessment_not_completed_after') cfg.hours_after_signup = h;
    delete cfg.value; delete cfg.unit;
  };
  window.__autEvScopeConfig = (k, v) => { if (_ui.ev.editing) { _ui.ev.editing.scope_config = _ui.ev.editing.scope_config || {}; _ui.ev.editing.scope_config[k] = v; } };
  window.__autEvStepAdd = () => { if (_ui.ev.editing) { _ui.ev.editing.steps = asArr(_ui.ev.editing.steps); _ui.ev.editing.steps.push({ type:'wait', config:{ amount:1, unit:'days' } }); if (window.DFO?.render) window.DFO.render(); } };
  window.__autEvStepDelete = (idx) => { if (_ui.ev.editing) { _ui.ev.editing.steps.splice(idx, 1); if (window.DFO?.render) window.DFO.render(); } };
  window.__autEvStepMove = (idx, dir) => {
    if (!_ui.ev.editing) return;
    const steps = _ui.ev.editing.steps;
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const tmp = steps[idx]; steps[idx] = steps[target]; steps[target] = tmp;
    if (window.DFO?.render) window.DFO.render();
  };
  // Per-type canonieke defaults: matcht wat de save-validator eist en wat
  // __autEvStepAdd initieel zet, zodat een terugschakeling naar 'wait' NIET
  // stille minutes toont maar direct de canonieke {amount:1, unit:'days'}.
  function _evStepDefaults(type) {
    if (type === 'wait')      return { amount: 1, unit: 'days' };
    if (type === 'condition') return { check: 'assessment_completed', on_fail: 'exit' };
    if (type === 'update_attendee_status') return { new_status: 'aangemeld' };
    return {};
  }
  window.__autEvStepType = (idx, type) => {
    if (!_ui.ev.editing) return;
    _ui.ev.editing.steps[idx] = { type, config: _evStepDefaults(type) };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autEvStepConfig = (idx, k, v) => { if (_ui.ev.editing) { _ui.ev.editing.steps[idx].config = _ui.ev.editing.steps[idx].config || {}; _ui.ev.editing.steps[idx].config[k] = v; } };
  window.__autEvStepConfigBool = (idx, k, v) => { if (_ui.ev.editing) { _ui.ev.editing.steps[idx].config = _ui.ev.editing.steps[idx].config || {}; _ui.ev.editing.steps[idx].config[k] = !!v; } };
  // Guarded WA-template writer voor flow-editor: skip als new leeg is EN saved bestaat.
  window.__autEvStepConfigTpl = (idx, v) => {
    if (!_ui.ev.editing) return;
    const step = _ui.ev.editing.steps[idx]; if (!step) return;
    step.config = step.config || {};
    if (v === '' && step.config.template_name) return;
    step.config.template_name = v;
  };
  window.__autEvSave = async () => {
    const a = _ui.ev.editing; if (!a) return;
    if (!a.name || !a.name.trim()) return alert('Naam is verplicht.');
    _setBusy('evSave', true);
    try {
      const j = await window.KV.authedJson('/api/events-automation-save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(a),
      });
      if (j?.error) throw new Error(j.error);
      _ui.ev.editing = null;
      _live.evAutos.data = null; queueMicrotask(fetchEvAutos);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('evSave', false); }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // TAB: ONBOARDING — vergelijkbaar met Events, MAAR geen scope
  // ═══════════════════════════════════════════════════════════════════════
  const OB_TRIGGERS = [
    { v: 'on_onboarding_created',     l: 'Bij nieuwe onboarding' },
    { v: 'on_wizard_completed',       l: 'Bij afgeronde wizard' },
    { v: 'time_after_signup',         l: 'X tijd na aanmelding' },
    { v: 'on_wizard_not_started_after', l: 'X tijd na aanmelding, wizard niet gestart' },
  ];
  const OB_STEP_TYPES = [
    { v: 'wait',                      l: 'Wachten' },
    { v: 'condition',                 l: 'Voorwaarde' },
    { v: 'send_email',                l: 'E-mail versturen' },
    { v: 'send_whatsapp',             l: 'WhatsApp-template versturen' },
    { v: 'update_onboarding_status',  l: 'Onboarding-status bijwerken' },
    { v: 'send_internal_notification',l: 'Interne notificatie' },
  ];
  const OB_CONDITION_CHECKS = ['wizard_not_started','wizard_completed','no_inbound','traject_is_1op1','traject_is_membership'];

  function onboardingView() {
    if (!_live.obAutos.data && !_live.obAutos.loading && !_live.obAutos.error) queueMicrotask(fetchObAutos);
    if (_ui.ob.editing) return _obEditor(_ui.ob.editing) + _confirmModalHtml();
    if (_ui.ob.testModal) return _obTestModal() + _confirmModalHtml();
    const sub = _ui.ob.subtab || 'flows';
    let content;
    if (sub === 'berichten')          content = _obBerichtenView();
    else if (sub === 'instellingen')  content = _obInstellingenView();
    else if (sub === 'log')           content = _obLogView();
    else {
      if (_live.obAutos.error && !_live.obAutos.data) content = errBlk('obAutos', _live.obAutos.error, "window.__autRetry('obAutos')");
      else if (_live.obAutos.loading && !_live.obAutos.data) content = skel();
      else content = _obList();
    }
    return _subtabToolbar('ob', sub) + content + _confirmModalHtml();
  }
  function _obList() {
    const all = asArr(_live.obAutos.data);
    const filter = _ui.ob.filter;
    const rows = filter === 'enabled' ? all.filter((a) => a.enabled)
              : filter === 'disabled' ? all.filter((a) => !a.enabled)
              : all;
    return `<div class="toolbar" style="padding:12px 20px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${[['all','Alles'],['enabled','Actief'],['disabled','Uit']].map(([v, l]) => `<button class="chip ${filter === v ? 'on' : ''}" onclick="window.__autObFilter('${v}')">${esc(l)}<span class="cnt">${v === 'all' ? all.length : (v === 'enabled' ? all.filter((a) => a.enabled).length : all.filter((a) => !a.enabled).length)}</span></button>`).join('')}
      <div class="tb-right" style="margin-left:auto">
        <button class="btn btn-primary btn-sm" onclick="window.__autObNew()">${svg(I.plus)}Nieuwe automation</button>
      </div>
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen automations', 'Klik "Nieuwe automation" om er een te maken.')
      : `<div style="padding:0 20px 20px">${H.table(
          [{l:'Naam'},{l:'Trigger',cls:'optional'},{l:'Stappen',cls:'r optional'},{l:'Status'},{l:'',cls:'r'}],
          rows.map((a) => [
            `<div><div class="cell-main">${esc(a.name || '—')}</div>${a.description ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(a.description)}</div>` : ''}</div>`,
            `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(a.trigger_type || '—')}</span>`,
            `<span class="mono">${asArr(a.steps).length}</span>`,
            a.enabled ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
            `<div style="display:flex;gap:4px;justify-content:flex-end">
              <button class="icon-btn" title="Toggle" onclick="window.__autObToggle('${esc(a.id)}')" ${_busy('obTog:' + a.id) ? 'disabled' : ''} style="width:28px;height:28px">${svg(a.enabled ? (I.pause || I.x) : (I.play || I.tick), 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Test" onclick="window.__autObTest('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.flask || I.tick, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Runs" onclick="window.__autObRuns('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.clock, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Bewerken" onclick="window.__autObEdit('${esc(a.id)}')" style="width:28px;height:28px">${svg(I.edit || I.settings, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Verwijderen" onclick="window.__autObDelete('${esc(a.id)}','${esc(a.name || '')}')" style="width:28px;height:28px">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
            </div>`,
          ])
        )}</div>`}`;
  }
  window.__autObFilter = (v) => { _ui.ob.filter = v; if (window.DFO?.render) window.DFO.render(); };
  window.__autObNew = () => {
    _ui.ob.editing = {
      id: null, name: '', description: '', enabled: false,
      trigger_type: 'on_onboarding_created', trigger_config: {},
      enroll_mode: 'new_only',
      steps: [],
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autObEdit = (id) => {
    const a = asArr(_live.obAutos.data).find((x) => x.id === id);
    if (!a) return;
    _ui.ob.editing = JSON.parse(JSON.stringify(a));
    _ui.ob.editing.trigger_config = _ui.ob.editing.trigger_config || {};
    _ui.ob.editing.steps = asArr(_ui.ob.editing.steps);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autObBack = () => { _ui.ob.editing = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autObToggle = async (id) => {
    const a = asArr(_live.obAutos.data).find((x) => x.id === id);
    if (!a) return;
    _setBusy('obTog:' + id, true);
    try {
      const j = await window.KV.authedJson('/api/onboarding-automation-save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ...a, enabled: !a.enabled }),
      });
      if (j?.error) throw new Error(j.error);
      _live.obAutos.data = null; queueMicrotask(fetchObAutos);
    } catch (e) { alert('Toggle mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('obTog:' + id, false); }
  };
  window.__autObDelete = (id, name) => {
    askConfirm(
      'Automation verwijderen?',
      `<p>Weet je zeker dat je <b>${esc(name)}</b> permanent wilt verwijderen?</p>`,
      async () => {
        const j = await window.KV.authedJson('/api/onboarding-automation-delete', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id }),
        });
        if (j?.error) throw new Error(j.error);
        _live.obAutos.data = null; queueMicrotask(fetchObAutos);
      },
      { confirmLabel: 'Ja, verwijderen', danger: true }
    );
  };
  window.__autObTest = (id) => {
    const a = asArr(_live.obAutos.data).find((x) => x.id === id);
    if (!a) return;
    if (!a.enabled) return alert('Zet de automation eerst aan voordat je een test-run doet.');
    _ui.ob.testModal = {
      automation_id: id,
      automation_name: a.name || '—',
      traject_id: '',
      name: 'Test Jeffrey',
      email: 'biemoldjeffrey@gmail.com',
      phone: '+31600000000',
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autObRuns = (id) => {
    _ui.ob.runsModal = { automation_id: id };
    if (!_live.obRuns.data[id]) queueMicrotask(() => fetchObRuns(id));
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autObRunsClose = () => { _ui.ob.runsModal = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autObTestClose = () => { _ui.ob.testModal = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autObTestField = (k, v) => { if (_ui.ob.testModal) _ui.ob.testModal[k] = v; };
  window.__autObTestSubmit = async () => {
    const t = _ui.ob.testModal; if (!t) return;
    if (!t.traject_id || !t.name || !t.email || !t.phone) return alert('Alle velden zijn verplicht.');
    _setBusy('obTestSubmit', true);
    try {
      const j = await window.KV.authedJson('/api/onboarding-automation-test', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          automation_id: t.automation_id, traject_id: t.traject_id,
          name: t.name, email: t.email, phone: t.phone,
        }),
      });
      if (j?.error) throw new Error(j.error);
      alert('Test gestart. Run-ID: ' + (j?.run_id || '—') + '\nOnboarding-ID: ' + (j?.onboarding_id || '—') + '\n\nDe automation loopt nu ECHT met versnelde wait-stappen. Berichten worden verstuurd naar het opgegeven email/nummer.');
      _ui.ob.testModal = null;
      if (window.DFO?.render) window.DFO.render();
    } catch (e) { alert('Test mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('obTestSubmit', false); }
  };

  function _obTestModal() {
    const t = _ui.ob.testModal; if (!t) return '';
    const busy = _busy('obTestSubmit');
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__autObTestClose()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:560px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">Test-run: ${esc(t.automation_name)}</div>
          <button class="icon-btn" onclick="window.__autObTestClose()" title="Sluiten" style="width:28px;height:28px">${svg(I.x || I.close, 'width:13px;height:13px')}</button>
        </div>
        <div style="padding:16px 18px">
          <div style="padding:10px 12px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:8px;color:var(--rose);font-size:12.5px;line-height:1.5;margin-bottom:14px">
            <b>⚠ TEST STUURT ECHT.</b> Dit is <b>geen dry-run</b> — er wordt een test-customer + test-onboarding aangemaakt (is_test=true) en de engine verstuurt daadwerkelijk berichten (wait wordt versneld naar 15s). Gebruik je eigen email/nummer.
          </div>
          <div style="display:flex;flex-direction:column;gap:10px">
            ${_obField('Traject-ID (uuid)', 'traject_id', t.traject_id, 'text', 'Zoek in Onboarding-module > Trajecten')}
            ${_obField('Naam', 'name', t.name, 'text')}
            ${_obField('E-mail (jouw eigen adres)', 'email', t.email, 'email')}
            ${_obField('Telefoon (+316…)', 'phone', t.phone, 'tel', 'E.164 format')}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__autObTestClose()">Annuleren</button>
          <button class="btn btn-primary btn-sm" onclick="window.__autObTestSubmit()" ${busy ? 'disabled' : ''}>${busy ? '…' : 'Start test-run'}</button>
        </div>
      </div>
    </div>`;
    function _obField(label, key, val, kind, hint) {
      return `<div>
        <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">${esc(label)}</label>
        <input type="${kind}" value="${esc(val)}" oninput="window.__autObTestField('${key}', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
        ${hint ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:3px">${esc(hint)}</div>` : ''}
      </div>`;
    }
  }
  function _obRunsModal() {
    const m = _ui.ob.runsModal; if (!m) return '';
    const runs = asArr(_live.obRuns.data[m.automation_id]);
    const loading = _live.obRuns.loading[m.automation_id];
    const err = _live.obRuns.error[m.automation_id];
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__autObRunsClose()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:720px;width:100%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">Runs-log</div>
          <button class="icon-btn" onclick="window.__autObRunsClose()" title="Sluiten" style="width:28px;height:28px">${svg(I.x || I.close, 'width:13px;height:13px')}</button>
        </div>
        <div style="padding:16px 18px">
          ${err ? errBlk('obRuns', err)
            : loading ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Runs laden…</div>'
            : runs.length === 0 ? emptyBlk('Geen runs', 'Deze automation heeft nog niet gedraaid.')
            : `<div style="display:flex;flex-direction:column;gap:6px">${runs.slice(0, 50).map((r) => `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface)">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                  ${_statusPill(r.status)}
                  ${r.is_test ? H.pill('warn','TEST') : ''}
                  <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(_fmtDateTime(r.started_at))}</span>
                </div>
                <div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:3px">step_index: ${esc(String(r.current_step_index ?? '—'))} · onboarding: ${esc(String(r.onboarding_id || '').slice(0, 8))}…</div>
              </div>`).join('')}</div>`}
        </div>
      </div>
    </div>`;
  }

  // Onboarding editor
  function _obEditor(a) {
    const isNew = !a.id;
    const busy = _busy('obSave');
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autObBack()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar lijst</button>
      <span style="font-size:14px;font-weight:600">${isNew ? 'Nieuwe automation' : 'Bewerken: ' + esc(a.name || '—')}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autObSave()" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:900px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      <div class="card"><div class="card-head"><div class="card-title">Basis</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Naam</label><input type="text" value="${esc(a.name)}" oninput="window.__autObField('name', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" /></div>
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Beschrijving</label><textarea oninput="window.__autObField('description', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box;min-height:60px;resize:vertical;font-family:inherit">${esc(a.description || '')}</textarea></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer"><input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="window.__autObField('enabled', this.checked)" /><span>Actief</span></label>
      </div></div>
      <div class="card"><div class="card-head"><div class="card-title">Trigger</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Trigger-type</label>
          <select onchange="window.__autObField('trigger_type', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
            ${OB_TRIGGERS.map((t) => `<option value="${t.v}" ${a.trigger_type === t.v ? 'selected' : ''}>${esc(t.l)}</option>`).join('')}
          </select>
        </div>
        ${(a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after') ? (() => {
          // Canonieke keys (onboarding-automation-save r103-104):
          //   trigger_config.hours_after_signup  OF  trigger_config.days_after_signup
          // Read: prefer days (als >0), dan hours, dan legacy value.
          // Unit picker biedt alleen hours+days (minutes is niet canoniek voor deze triggers).
          const days  = Number(a.trigger_config?.days_after_signup);
          const hours = Number(a.trigger_config?.hours_after_signup);
          const legacy = Number(a.trigger_config?.value);
          let dispVal, dispUnit;
          if (Number.isFinite(days) && days > 0)       { dispVal = days;   dispUnit = 'days';  }
          else if (Number.isFinite(hours) && hours > 0){ dispVal = hours;  dispUnit = 'hours'; }
          else if (Number.isFinite(legacy) && legacy > 0) {
            dispVal = legacy;
            dispUnit = (a.trigger_config?.unit === 'days') ? 'days' : 'hours';
          } else { dispVal = 24; dispUnit = 'hours'; }
          return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Waarde</label><input id="ob-trig-value" type="number" min="1" value="${esc(String(dispVal))}" oninput="window.__autObTrigDur(Number(this.value), (document.getElementById('ob-trig-unit')||{}).value || '${esc(dispUnit)}')" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" /></div>
            <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Eenheid</label><select id="ob-trig-unit" onchange="window.__autObTrigDur(Number((document.getElementById('ob-trig-value')||{}).value)||${esc(String(dispVal))}, this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">${['hours','days'].map((u) => `<option value="${u}" ${dispUnit === u ? 'selected' : ''}>${esc(u)}</option>`).join('')}</select></div>
          </div>`;
        })() : ''}
      </div></div>
      <div class="card"><div class="card-head"><div class="card-title">Stappen (${asArr(a.steps).length})</div>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__autObStepAdd()">${svg(I.plus)}Stap toevoegen</button>
      </div><div class="card-body" style="padding:12px 16px;display:flex;flex-direction:column;gap:10px">
        ${asArr(a.steps).length === 0 ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12.5px;font-style:italic">Geen stappen — klik "Stap toevoegen".</div>` : asArr(a.steps).map((step, idx) => _obStepCard(step, idx)).join('')}
      </div></div>
    </div></div>`;
  }
  function _obStepCard(step, idx) {
    return `<div style="padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:10.5px;color:var(--text-3);font-weight:600">${idx + 1}.</span>
        <select onchange="window.__autObStepType(${idx}, this.value)" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12.5px">
          ${OB_STEP_TYPES.map((t) => `<option value="${t.v}" ${step.type === t.v ? 'selected' : ''}>${esc(t.l)}</option>`).join('')}
        </select>
        <button class="icon-btn" title="Omhoog" onclick="window.__autObStepMove(${idx}, -1)" style="width:24px;height:24px" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" title="Omlaag" onclick="window.__autObStepMove(${idx}, 1)" style="width:24px;height:24px">↓</button>
        <button class="icon-btn" title="Verwijderen" onclick="window.__autObStepDelete(${idx})" style="width:24px;height:24px">${svg(I.trash || I.x, 'width:11px;height:11px')}</button>
      </div>
      ${_obStepConfig(step, idx)}
    </div>`;
  }
  function _obStepConfig(step, idx) {
    const cfg = step.config || {};
    const upd = (k) => `window.__autObStepConfig(${idx}, '${k}', this.value)`;
    if (step.type === 'wait') {
      const waitVal = (cfg.amount != null ? cfg.amount : (cfg.value != null ? cfg.value : 1));
      return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div><label style="font-size:11px;color:var(--text-3)">Wachttijd</label><input type="number" value="${esc(String(waitVal))}" oninput="${upd('amount')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" /></div>
        <div><label style="font-size:11px;color:var(--text-3)">Eenheid</label><select onchange="${upd('unit')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">${['minutes','hours','days'].map((u) => `<option value="${u}" ${cfg.unit === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>
      </div>`;
    }
    if (step.type === 'condition') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Check</label>
      <select onchange="${upd('check')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
        ${OB_CONDITION_CHECKS.map((c) => `<option value="${c}" ${cfg.check === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
      <label style="font-size:11px;color:var(--text-3);margin-top:6px;display:block">Bij FALSE</label>
      <select onchange="${upd('on_fail')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
        ${['exit','skip_to_end'].map((v) => `<option value="${v}" ${cfg.on_fail === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>`;
    if (step.type === 'send_email') return `<div style="display:flex;flex-direction:column;gap:6px">
      <div><label style="font-size:11px;color:var(--text-3)">Onderwerp</label><input type="text" value="${esc(cfg.subject || '')}" oninput="${upd('subject')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" /></div>
      <div><label style="font-size:11px;color:var(--text-3)">Body (text)</label><textarea oninput="${upd('body')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box;min-height:80px;font-family:inherit;resize:vertical">${esc(cfg.body || '')}</textarea></div>
    </div>`;
    if (step.type === 'send_whatsapp') {
      const stTpls = _live.obTpls;
      if (!stTpls.data && !stTpls.loading && !stTpls.error) queueMicrotask(fetchObTpls);
      const tpls = asArr(stTpls.data);
      const savedName = cfg.template_name || '';
      const savedInList = tpls.some((t) => t.name === savedName);
      const fallbackOpt = (savedName && !savedInList)
        ? `<option value="${esc(savedName)}" selected>${esc(savedName)} — opgeslagen (niet in huidige lijst)</option>` : '';
      const errNote = stTpls.error
        ? `<div style="font-size:10.5px;color:var(--rose);margin-top:4px">Templates niet geladen: ${esc(stTpls.error)}. <button class="btn btn-ghost btn-sm" onclick="window.__autTplsRetry('ob')" style="padding:2px 6px;font-size:10.5px">Opnieuw</button></div>`
        : '';
      const placeholderSelected = !savedName ? 'selected' : '';
      return `<div>
        <label style="font-size:11px;color:var(--text-3)">Meta-template</label>
        <select onchange="window.__autObStepConfigTpl(${idx}, this.value)" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px">
          <option value="" ${placeholderSelected}>— kies template —</option>
          ${fallbackOpt}
          ${tpls.map((t) => `<option value="${esc(t.name)}" ${savedName === t.name ? 'selected' : ''}>${esc(t.name)} (${esc(t.language || 'nl')})</option>`).join('')}
        </select>
        ${errNote}
      </div>`;
    }
    if (step.type === 'update_onboarding_status') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Nieuwe status</label>
      <input type="text" value="${esc(cfg.status || '')}" oninput="${upd('status')}" placeholder="bv. wizard_gestart" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box" />
    </div>`;
    if (step.type === 'send_internal_notification') return `<div>
      <label style="font-size:11px;color:var(--text-3)">Interne bericht</label>
      <textarea oninput="${upd('message')}" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);font-size:12.5px;box-sizing:border-box;min-height:60px;font-family:inherit;resize:vertical">${esc(cfg.message || '')}</textarea>
    </div>`;
    return `<div style="font-size:11px;color:var(--text-3);font-style:italic">Nog geen editor voor "${esc(step.type)}"</div>`;
  }
  window.__autObField = (k, v) => { if (_ui.ob.editing) _ui.ob.editing[k] = v; if (window.DFO?.render && k === 'trigger_type') window.DFO.render(); };
  window.__autObTrigConfig = (k, v) => { if (_ui.ob.editing) { _ui.ob.editing.trigger_config = _ui.ob.editing.trigger_config || {}; _ui.ob.editing.trigger_config[k] = v; } };
  // Trigger-duur canoniek voor onboarding time_after_signup / on_wizard_not_started_after:
  // schrijft days_after_signup als unit='days', anders hours_after_signup. Ruimt de andere
  // key + legacy value/unit op, zodat re-save schoon is en de save-validator ('OF hours OF
  // days > 0') altijd 1 geldig veld ziet.
  window.__autObTrigDur = (value, unit) => {
    if (!_ui.ob.editing) return;
    const cfg = _ui.ob.editing.trigger_config = _ui.ob.editing.trigger_config || {};
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return;
    if (unit === 'days') {
      cfg.days_after_signup = v;
      delete cfg.hours_after_signup;
    } else {
      cfg.hours_after_signup = v;
      delete cfg.days_after_signup;
    }
    delete cfg.value; delete cfg.unit;
  };
  window.__autObStepAdd = () => { if (_ui.ob.editing) { _ui.ob.editing.steps = asArr(_ui.ob.editing.steps); _ui.ob.editing.steps.push({ type:'wait', config:{ amount:1, unit:'days' } }); if (window.DFO?.render) window.DFO.render(); } };
  window.__autObStepDelete = (idx) => { if (_ui.ob.editing) { _ui.ob.editing.steps.splice(idx, 1); if (window.DFO?.render) window.DFO.render(); } };
  window.__autObStepMove = (idx, dir) => {
    if (!_ui.ob.editing) return;
    const steps = _ui.ob.editing.steps;
    const target = idx + dir;
    if (target < 0 || target >= steps.length) return;
    const tmp = steps[idx]; steps[idx] = steps[target]; steps[target] = tmp;
    if (window.DFO?.render) window.DFO.render();
  };
  function _obStepDefaults(type) {
    if (type === 'wait')      return { amount: 1, unit: 'days' };
    if (type === 'condition') return { check: 'wizard_not_started', on_fail: 'exit' };
    if (type === 'update_onboarding_status') return { new_status: 'aangemeld' };
    return {};
  }
  window.__autObStepType = (idx, type) => {
    if (!_ui.ob.editing) return;
    _ui.ob.editing.steps[idx] = { type, config: _obStepDefaults(type) };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autObStepConfig = (idx, k, v) => { if (_ui.ob.editing) { _ui.ob.editing.steps[idx].config = _ui.ob.editing.steps[idx].config || {}; _ui.ob.editing.steps[idx].config[k] = v; } };
  window.__autObStepConfigBool = (idx, k, v) => { if (_ui.ob.editing) { _ui.ob.editing.steps[idx].config = _ui.ob.editing.steps[idx].config || {}; _ui.ob.editing.steps[idx].config[k] = !!v; } };
  window.__autObStepConfigTpl = (idx, v) => {
    if (!_ui.ob.editing) return;
    const step = _ui.ob.editing.steps[idx]; if (!step) return;
    step.config = step.config || {};
    if (v === '' && step.config.template_name) return;
    step.config.template_name = v;
  };
  window.__autObSave = async () => {
    const a = _ui.ob.editing; if (!a) return;
    if (!a.name || !a.name.trim()) return alert('Naam is verplicht.');
    _setBusy('obSave', true);
    try {
      const j = await window.KV.authedJson('/api/onboarding-automation-save', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(a),
      });
      if (j?.error) throw new Error(j.error);
      _ui.ob.editing = null;
      _live.obAutos.data = null; queueMicrotask(fetchObAutos);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('obSave', false); }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // TAB: LEADSONDERHOUD — volledig in-place, geen deep-links
  //   Sub-views (chip-toolbar): trajecten / sjablonen / drooglog
  //   Trajecten: full CRUD (list/create/edit/delete) + stappen (add/edit/delete)
  //   Sjablonen: read-only lijst (backend heeft geen save/delete endpoint)
  //   Drooglog: laatste 7 dagen "wat zou verstuurd zijn" uit berichten_log
  //   Modals: trajecten-editor + stap-editor (inline, geen deep-links)
  // ═══════════════════════════════════════════════════════════════════════
  const LS_AANLEIDINGEN = [
    { v: 'na_start',           l: 'X dagen na start' },
    { v: 'dag_van_periode',    l: 'Vaste dag in periode' },
    { v: 'dagen_voor_einde',   l: 'X dagen voor einde' },
    { v: 'na_einde',           l: 'X dagen na einde' },
    { v: 'geen_activiteit',    l: 'Bij geen activiteit' },
    { v: 'vast_moment',        l: 'Vast moment' },
  ];
  const LS_KANALEN = ['mail', 'whatsapp'];

  function leadsonderhoudView() {
    if (!_live.lsInst.data && !_live.lsInst.loading && !_live.lsInst.error) queueMicrotask(fetchLsInst);
    if (!_live.lsSjab.data && !_live.lsSjab.loading && !_live.lsSjab.error) queueMicrotask(fetchLsSjab);
    if (!_live.lsTraj.data && !_live.lsTraj.loading && !_live.lsTraj.error) queueMicrotask(fetchLsTraj);

    // Editor-modals hebben voorrang (full-screen)
    if (_ui.ls.editingTraject !== null) return _lsTrajEditor() + _confirmModalHtml();
    if (_ui.ls.editingStap !== null) return _lsStapEditor() + _confirmModalHtml();
    if (_ui.ls.editingSjabloon !== null) return _lsSjabloonEditor() + _confirmModalHtml();

    const sub = _ui.ls.subtab || 'flows';
    let content;
    if (sub === 'berichten')          content = `<div class="pad" style="padding-top:14px"><div style="max-width:1100px;margin:0 auto">${_lsSjablonenBlock()}</div></div>`;
    else if (sub === 'instellingen')  content = _lsInstellingenView();
    else if (sub === 'log')           content = _lsLogView();
    else {
      // 'flows' = trajecten & stappen
      content = `<div class="pad" style="padding-top:14px"><div style="max-width:1100px;margin:0 auto">${_lsTrajectenBlock()}</div></div>`;
    }
    return _subtabToolbar('ls', sub) + content + _confirmModalHtml();
  }

  function _lsTrajectenBlock() {
    const trajecten = asArr(_live.lsTraj.data);
    return `<div class="card">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.doc || I.file)}</span>
        <div class="card-title">Trajecten & stappen</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autLsTrajNew()">${svg(I.plus)}Nieuw traject</button>
      </div>
      <div class="card-body" style="padding:0">
        ${_live.lsTraj.error ? errBlk('lsTraj', _live.lsTraj.error, "window.__autRetry('lsTraj')")
          : _live.lsTraj.loading && !_live.lsTraj.data ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Laden…</div>'
          : trajecten.length === 0 ? emptyBlk('Geen trajecten', 'Klik "Nieuw traject" om te beginnen.')
          : `<div>${trajecten.map((t) => _lsTrajRow(t)).join('')}</div>`}
      </div>
    </div>`;
  }

  function _lsSjablonenBlock() {
    const items = asArr(_live.lsSjab.data?.items);
    return `<div class="card">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.file || I.doc)}</span>
        <div class="card-title">Sjablonen</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3);margin-right:8px">${items.length} sjablonen</span>
        <button class="btn btn-primary btn-sm" onclick="window.__autLsSjabNew()">${svg(I.plus)}Nieuw sjabloon</button>
      </div>
      <div class="card-body" style="padding:0">
        ${_live.lsSjab.error ? errBlk('lsSjab', _live.lsSjab.error, "window.__autRetry('lsSjab')")
          : _live.lsSjab.loading && !_live.lsSjab.data ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Laden…</div>'
          : items.length === 0 ? emptyBlk('Geen sjablonen', 'Klik "Nieuw sjabloon" om er een te maken.')
          : `<div style="padding:12px 16px">${H.table(
              [{l:'Traject'},{l:'Soort',cls:'optional'},{l:'Kanaal',cls:'optional'},{l:'Onderwerp / Meta-tpl'},{l:'Score-range',cls:'r optional'},{l:'Actief',cls:'r'},{l:'',cls:'r'}],
              items.map((s) => [
                `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(s.traject_slug || '—')}</span>`,
                `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(s.soort || '—')}</span>`,
                `<span style="font-size:11.5px">${s.kanaal === 'whatsapp' ? '<span style="color:#25d366">📱 WA</span>' : '<span style="color:var(--blue)">✉ Mail</span>'}</span>`,
                s.kanaal === 'whatsapp'
                  ? `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(s.meta_template || '(geen meta-template)')}</span>`
                  : `<span style="font-size:12.5px">${esc(s.onderwerp || '—')}</span>`,
                `<span class="mono" style="font-size:11.5px">${s.score_min ?? '—'} – ${s.score_max ?? '—'}</span>`,
                s.actief ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
                `<div style="display:flex;gap:3px;justify-content:flex-end">
                  <button class="icon-btn" title="Bewerken" onclick="window.__autLsSjabEdit('${esc(s.id)}')" style="width:26px;height:26px">${svg(I.edit || I.settings, 'width:11px;height:11px')}</button>
                  <button class="icon-btn" title="Verwijderen" onclick="window.__autLsSjabDelete('${esc(s.id)}','${esc((s.traject_slug || '') + ' · ' + (s.soort || ''))}')" style="width:26px;height:26px">${svg(I.trash || I.x, 'width:11px;height:11px')}</button>
                </div>`,
              ])
            )}</div>`}
      </div>
    </div>`;
  }

  // ── SJABLOON-EDITOR ────────────────────────────────────────────────────
  // Beschikbare placeholders voor mail-body (uit api/_lib/leadsonderhoud-sjabloon.js).
  // Deze worden als hint onder het body-veld getoond.
  const LS_SJAB_PLACEHOLDERS = [
    '{voornaam}', '{dagen_over}', '{dag}', '{lessen}', '{trades}',
    '{score}', '{agendalink}', '{inloglink}', '{datum}', '{tijd}', '{logo}',
  ];

  window.__autLsSjabNew = () => {
    // Trajectenlijst is nodig voor slug-picker; borg dat 'ie geladen is
    if (!_live.lsTraj.data && !_live.lsTraj.loading) queueMicrotask(fetchLsTraj);
    _ui.ls.editingSjabloon = {
      id: null,
      traject_slug: '',
      soort: '',
      kanaal: 'mail',
      onderwerp: '',
      html: '',
      tekst: '',
      meta_template: '',
      variabele_volgorde: '',   // komma-gescheiden string in de UI, array in payload
      score_min: null,
      score_max: null,
      actief: true,
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsSjabEdit = (id) => {
    const s = asArr(_live.lsSjab.data?.items).find((x) => x.id === id);
    if (!s) return;
    if (!_live.lsTraj.data && !_live.lsTraj.loading) queueMicrotask(fetchLsTraj);
    _ui.ls.editingSjabloon = {
      ...s,
      variabele_volgorde: Array.isArray(s.variabele_volgorde) ? s.variabele_volgorde.join(', ') : (s.variabele_volgorde || ''),
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsSjabClose = () => { _ui.ls.editingSjabloon = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autLsSjabField = (k, v) => {
    if (_ui.ls.editingSjabloon) _ui.ls.editingSjabloon[k] = v;
    if (window.DFO?.render && k === 'kanaal') window.DFO.render();
  };
  window.__autLsSjabFieldBool = (k, v) => { if (_ui.ls.editingSjabloon) _ui.ls.editingSjabloon[k] = !!v; };
  window.__autLsSjabFieldNum = (k, v) => {
    if (!_ui.ls.editingSjabloon) return;
    const s = String(v || '').trim();
    _ui.ls.editingSjabloon[k] = s === '' ? null : Number(s);
  };
  window.__autLsSjabSave = async () => {
    const s = _ui.ls.editingSjabloon; if (!s) return;
    if (!s.traject_slug || !s.traject_slug.trim()) return alert('Traject is verplicht.');
    if (!s.soort || !s.soort.trim()) return alert('Soort is verplicht.');
    if (!s.kanaal || !['mail','whatsapp'].includes(s.kanaal)) return alert("Kanaal moet 'mail' of 'whatsapp' zijn.");
    if (!s.tekst || !s.tekst.trim()) return alert('Tekst is verplicht (mail-body of WA-preview).');
    _setBusy('lsSjabSave', true);
    try {
      // Normaliseer variabele_volgorde naar array
      const payload = { ...s };
      if (typeof payload.variabele_volgorde === 'string') {
        payload.variabele_volgorde = payload.variabele_volgorde.split(',').map((x) => x.trim()).filter(Boolean);
        if (payload.variabele_volgorde.length === 0) payload.variabele_volgorde = null;
      }
      const j = await window.KV.authedJson('/api/leadsonderhoud-sjabloon-opslaan', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      if (j?.error) throw new Error(j.error);
      _ui.ls.editingSjabloon = null;
      _live.lsSjab.data = null; queueMicrotask(fetchLsSjab);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('lsSjabSave', false); }
  };
  window.__autLsSjabDelete = (id, label) => {
    askConfirm(
      'Sjabloon verwijderen?',
      `<p>Weet je zeker dat je sjabloon <b>${esc(label)}</b> wilt verwijderen?</p>
       <p style="font-size:12px;color:var(--text-3)">Als er stappen aan gekoppeld zijn krijg je eerst een overzicht.</p>`,
      async () => {
        try {
          const j = await window.KV.authedJson('/api/leadsonderhoud-sjabloon-verwijderen', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ id }),
          });
          if (j?.error) {
            // 409 — gekoppelde stappen bestaan; toon lijst + vraag force
            if (j?.gekoppelde_stappen && Array.isArray(j.gekoppelde_stappen)) {
              const lijst = j.gekoppelde_stappen.map((g) => `• ${esc(g.naam || g.soort)} (${esc(g.traject_slug)}${g.actief ? '' : ' — inactief'})`).join('<br>');
              askConfirm(
                'Sjabloon toch verwijderen?',
                `<p><b>${j.gekoppelde_stappen.length} stap(pen) verwijzen nog naar dit sjabloon</b> (via traject_slug + soort match). Als je verwijdert, blijven die stappen bestaan maar zullen ze silent skippen bij de cron.</p>
                 <div style="max-height:200px;overflow-y:auto;padding:8px 10px;background:var(--surface-2);border-radius:6px;font-size:11.5px;line-height:1.6;margin-top:8px">${lijst}</div>
                 <p style="margin-top:10px;font-size:12px;color:var(--rose)">Aanbevolen: verwijder eerst de stappen, of maak een nieuw sjabloon met dezelfde soort/slug.</p>`,
                async () => {
                  const j2 = await window.KV.authedJson('/api/leadsonderhoud-sjabloon-verwijderen', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ id, force: true }),
                  });
                  if (j2?.error) throw new Error(j2.error);
                  _live.lsSjab.data = null; queueMicrotask(fetchLsSjab);
                },
                { confirmLabel: 'Ja, verwijder alsnog', danger: true }
              );
              return;
            }
            throw new Error(j.error);
          }
          _live.lsSjab.data = null; queueMicrotask(fetchLsSjab);
        } catch (e) { throw e; }
      },
      { confirmLabel: 'Ja, verwijderen', danger: true }
    );
  };

  function _lsSjabloonEditor() {
    const s = _ui.ls.editingSjabloon; if (!s) return '';
    const isNew = !s.id;
    const busy = _busy('lsSjabSave');
    const trajecten = asArr(_live.lsTraj.data);
    const isMail = s.kanaal === 'mail';
    const isWA   = s.kanaal === 'whatsapp';
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autLsSjabClose()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug</button>
      <span style="font-size:14px;font-weight:600">${isNew ? 'Nieuw sjabloon' : 'Bewerken: ' + esc(s.traject_slug + ' · ' + s.soort)}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autLsSjabSave()" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      <div class="card"><div class="card-head"><div class="card-title">Koppeling & kanaal</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Traject (slug)</label>
            <select oninput="window.__autLsSjabField('traject_slug', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
              <option value="">— kies traject —</option>
              ${trajecten.map((t) => `<option value="${esc(t.slug)}" ${s.traject_slug === t.slug ? 'selected' : ''}>${esc(t.naam || t.slug)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Soort (matcht stap.soort)</label>
            <input type="text" value="${esc(s.soort)}" oninput="window.__autLsSjabField('soort', this.value)" placeholder="bv. herinnering_dag3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Kanaal</label>
            <select oninput="window.__autLsSjabField('kanaal', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
              <option value="mail" ${isMail ? 'selected' : ''}>Mail</option>
              <option value="whatsapp" ${isWA ? 'selected' : ''}>WhatsApp</option>
            </select>
          </div>
        </div>
        <div style="padding:8px 10px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);line-height:1.5">
          De drip-motor matcht sjablonen op <b>(traject_slug + soort + actief=true)</b> en kiest een variant binnen de score-range van de lead. Meerdere sjablonen mogen dezelfde soort hebben mits andere score-ranges.
        </div>
      </div></div>

      ${isMail ? `<div class="card"><div class="card-head"><div class="card-title">Mail-inhoud</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Onderwerp</label>
          <input type="text" value="${esc(s.onderwerp || '')}" oninput="window.__autLsSjabField('onderwerp', this.value)" placeholder="bv. Nog {dagen_over} dagen om je scores op te bouwen" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" />
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">HTML-body (optioneel — voor rich e-mail)</label>
          <textarea oninput="window.__autLsSjabField('html', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box;min-height:120px;font-family:'IBM Plex Mono',monospace;resize:vertical">${esc(s.html || '')}</textarea>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Platte tekst (fallback, verplicht)</label>
          <textarea oninput="window.__autLsSjabField('tekst', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box;min-height:140px;font-family:inherit;resize:vertical">${esc(s.tekst || '')}</textarea>
          <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Beschikbare variabelen: ${LS_SJAB_PLACEHOLDERS.map((p) => `<code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">${esc(p)}</code>`).join(' ')}</div>
        </div>
      </div></div>` : ''}

      ${isWA ? `<div class="card"><div class="card-head"><div class="card-title">WhatsApp-template</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Meta-template naam (approved)</label>
          <input type="text" value="${esc(s.meta_template || '')}" oninput="window.__autLsSjabField('meta_template', this.value)" placeholder="bv. leadsonderhoud_dag3" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
          <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Naam moet overeenkomen met een APPROVED template in <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">whatsapp_meta_templates</code>. Underscore-conventie (bv. <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">niet_ingelogd</code>).</div>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Variabele volgorde (fallback, komma-gescheiden)</label>
          <input type="text" value="${esc(s.variabele_volgorde || '')}" oninput="window.__autLsSjabField('variabele_volgorde', this.value)" placeholder="bv. voornaam, dagen_over, agendalink" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
          <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Bij WhatsApp-send worden {{1}}, {{2}}, … in de meta-template gevuld in deze volgorde. Als leeg: fallback op <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">meta_param_mapping.body</code> uit whatsapp_meta_templates.</div>
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Preview-tekst (UI, verplicht — wat je in de log ziet)</label>
          <textarea oninput="window.__autLsSjabField('tekst', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box;min-height:80px;font-family:inherit;resize:vertical">${esc(s.tekst || '')}</textarea>
          <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Deze tekst wordt <b>niet</b> naar WhatsApp verzonden (Meta-template wordt gebruikt). Alleen voor UI-preview in log/gesprek.</div>
        </div>
      </div></div>` : ''}

      <div class="card"><div class="card-head"><div class="card-title">Filter & status</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Score min (leeg = geen ondergrens)</label>
            <input type="number" value="${s.score_min == null ? '' : esc(String(s.score_min))}" oninput="window.__autLsSjabFieldNum('score_min', this.value)" placeholder="—" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" />
          </div>
          <div>
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Score max (leeg = geen bovengrens)</label>
            <input type="number" value="${s.score_max == null ? '' : esc(String(s.score_max))}" oninput="window.__autLsSjabFieldNum('score_max', this.value)" placeholder="—" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" />
          </div>
        </div>
        <div style="padding:6px 10px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.5">
          De motor kiest de sjabloon-variant waarvan de lead-score binnen (score_min, score_max) valt. Bij overlap wint de <b>engste range</b>. Unieke index dwingt af dat je geen twee sjablonen met dezelfde (traject_slug + soort + score-range) hebt.
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" ${s.actief ? 'checked' : ''} onchange="window.__autLsSjabFieldBool('actief', this.checked)" />
          <span>Actief (motor gebruikt dit sjabloon voor matching)</span>
        </label>
      </div></div>
    </div></div>`;
  }

  function _lsDrooglogBlock() {
    const items = asArr(_live.lsDrog.data);
    return `<div class="card">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.clock)}</span>
        <div class="card-title">Drooglog</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">Laatste 7d · status='droog'</span>
      </div>
      <div class="card-body" style="padding:0">
        <div style="padding:12px 16px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:12px;color:var(--text-2);line-height:1.5">
          Wat de motor de <b>afgelopen 7 dagen</b> in droogloop-modus <b>zou hebben verstuurd</b>. Zo zie je of de juiste leads het juiste bericht zouden krijgen zonder dat het echt is uitgegaan.
        </div>
        ${_live.lsDrog.error ? errBlk('lsDrog', _live.lsDrog.error, "window.__autRetry('lsDrog')")
          : _live.lsDrog.loading && !_live.lsDrog.data ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Laden…</div>'
          : items.length === 0 ? emptyBlk('Geen droogloop-items', 'Er waren geen berichten in droogloop de afgelopen 7 dagen.')
          : `<div style="padding:12px 16px">${H.table(
              [{l:'Wanneer'},{l:'Traject'},{l:'Kanaal',cls:'optional'},{l:'Soort',cls:'optional'},{l:'Naar'},{l:'Agent',cls:'optional'}],
              items.slice(0, 200).map((d) => [
                `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(_fmtDateTime(d.verstuurd_op))}</span>`,
                `<span style="font-size:12.5px">${esc(d.traject || '—')}</span>`,
                `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(d.kanaal || '—')}</span>`,
                `<span style="font-size:11.5px;color:var(--text-3)">${esc(d.soort || '—')}</span>`,
                `<span class="mono" style="font-size:11.5px">${esc(d.naar || '—')}</span>`,
                `<span style="font-size:11.5px;color:var(--text-3)">${esc(d.agent || '—')}</span>`,
              ])
            )}</div>`}
      </div>
    </div>`;
  }

  function _lsTrajRow(t) {
    const stappen = asArr(t.stappen);
    const isExp = _ui.ls.expandedTrajectId === t.id;
    return `<div style="border-bottom:1px solid var(--border)">
      <div style="padding:12px 17px;display:flex;gap:12px;align-items:center">
        <div style="flex:1;min-width:0;cursor:pointer" onclick="window.__autLsToggleTraject('${esc(t.id)}')">
          <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
            <div style="font-size:13.5px;font-weight:600">${esc(t.naam || t.slug || '—')}</div>
            <span class="mono" style="font-size:10.5px;color:var(--text-3)">${esc(t.slug || '')}</span>
            ${t.actief ? H.pill('ok','Actief') : H.pill('neutral','Uit')}
          </div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">${stappen.length} stappen · agent: ${esc(t.agent || '—')} · archief na ${esc(String(t.archief_na || '?'))}d</div>
        </div>
        <button class="icon-btn" title="Bewerken" onclick="window.__autLsTrajEdit('${esc(t.id)}')" style="width:28px;height:28px">${svg(I.edit || I.settings, 'width:13px;height:13px')}</button>
        <button class="icon-btn" title="Verwijderen" onclick="window.__autLsTrajDelete('${esc(t.id)}','${esc(t.naam || t.slug || '')}')" style="width:28px;height:28px">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
        <span style="font-size:16px;color:var(--text-3);cursor:pointer" onclick="window.__autLsToggleTraject('${esc(t.id)}')">${isExp ? '▾' : '▸'}</span>
      </div>
      ${isExp ? `<div style="padding:0 17px 16px;background:var(--surface-2)">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0">
          <div style="font-size:11.5px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Stappen (${stappen.length})</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__autLsStapNew('${esc(t.id)}')">${svg(I.plus)}Stap toevoegen</button>
        </div>
        ${stappen.length === 0 ? `<div style="padding:14px;text-align:center;color:var(--text-3);font-size:12px;font-style:italic">Geen stappen.</div>`
          : H.table(
            [{l:'Stap'},{l:'Kanaal',cls:'optional'},{l:'Aanleiding',cls:'optional'},{l:'Wanneer',cls:'optional'},{l:'Score-range',cls:'r optional'},{l:'Actief',cls:'r'},{l:'',cls:'r'}],
            stappen.map((s) => [
              `<span style="font-size:12.5px">${esc(s.naam || s.soort || '—')}</span>`,
              `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(s.kanaal || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(s.aanleiding || '—')}</span>`,
              `<span class="mono" style="font-size:11px;color:var(--text-3)">${esc(String(s.waarde || '—'))}${s.weekdag ? ' · ' + esc(s.weekdag) : ''}${s.tijdstip ? ' · ' + esc(s.tijdstip) : ''}</span>`,
              `<span class="mono" style="font-size:11px">${s.score_min ?? '—'} – ${s.score_max ?? '—'}</span>`,
              s.actief ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
              `<div style="display:flex;gap:3px;justify-content:flex-end">
                <button class="icon-btn" title="Bewerken" onclick="window.__autLsStapEdit('${esc(t.id)}','${esc(s.id)}')" style="width:26px;height:26px">${svg(I.edit || I.settings, 'width:11px;height:11px')}</button>
                <button class="icon-btn" title="Verwijderen" onclick="window.__autLsStapDelete('${esc(s.id)}','${esc(s.naam || s.soort || '')}')" style="width:26px;height:26px">${svg(I.trash || I.x, 'width:11px;height:11px')}</button>
              </div>`,
            ])
          )}
      </div>` : ''}
    </div>`;
  }
  window.__autLsView = (v) => { _ui.ls.view = v; if (window.DFO?.render) window.DFO.render(); };
  window.__autLsToggleTraject = (id) => {
    _ui.ls.expandedTrajectId = _ui.ls.expandedTrajectId === id ? null : id;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsTrajNew = () => {
    _ui.ls.editingTraject = { id: null, slug: '', naam: '', omschrijving: '', agent: '', agenda_link: '', archief_na: 30, volgorde: 1, actief: true };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsTrajEdit = (id) => {
    const t = asArr(_live.lsTraj.data).find((x) => x.id === id);
    if (!t) return;
    _ui.ls.editingTraject = { ...t };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsTrajClose = () => { _ui.ls.editingTraject = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autLsTrajField = (k, v) => { if (_ui.ls.editingTraject) _ui.ls.editingTraject[k] = v; };
  window.__autLsTrajFieldBool = (k, v) => { if (_ui.ls.editingTraject) _ui.ls.editingTraject[k] = !!v; };
  window.__autLsTrajSave = async () => {
    const t = _ui.ls.editingTraject; if (!t) return;
    if (!t.naam || !t.naam.trim()) return alert('Naam is verplicht.');
    if (!t.slug || !t.slug.trim()) return alert('Slug is verplicht.');
    _setBusy('lsTrajSave', true);
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-traject-opslaan', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(t),
      });
      if (j?.error) throw new Error(j.error);
      _ui.ls.editingTraject = null;
      _live.lsTraj.data = null; queueMicrotask(fetchLsTraj);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('lsTrajSave', false); }
  };
  window.__autLsTrajDelete = (id, naam) => {
    askConfirm(
      'Traject verwijderen?',
      `<p>Weet je zeker dat je <b>${esc(naam)}</b> permanent wilt verwijderen? <b style="color:var(--rose)">Alle stappen van dit traject worden ook verwijderd.</b></p>`,
      async () => {
        const j = await window.KV.authedJson('/api/leadsonderhoud-traject-verwijderen', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id }),
        });
        if (j?.error) throw new Error(j.error);
        _live.lsTraj.data = null; queueMicrotask(fetchLsTraj);
      },
      { confirmLabel: 'Ja, verwijderen', danger: true }
    );
  };
  window.__autLsStapNew = (traject_id) => {
    _ui.ls.editingStap = {
      id: null, traject_id,
      naam: '', soort: '', kanaal: 'whatsapp',
      aanleiding: 'na_start', waarde: '', weekdag: '', tijdstip: '',
      score_min: 0, score_max: 100,
      alleen_zonder_gesprek: false, alleen_ingelogd: null, alleen_verlengd: null,
      herhaalbaar: false, urgentie: 3, volgorde: 1, actief: true,
      // Quiz-koppeling voor vragenlijst-stappen (optioneel)
      quiz_slug: '',
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsStapEdit = (traject_id, stap_id) => {
    const t = asArr(_live.lsTraj.data).find((x) => x.id === traject_id);
    if (!t) return;
    const s = asArr(t.stappen).find((x) => x.id === stap_id);
    if (!s) return;
    _ui.ls.editingStap = { ...s, traject_id, quiz_slug: s.quiz_slug || '' };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autLsStapClose = () => { _ui.ls.editingStap = null; if (window.DFO?.render) window.DFO.render(); };
  window.__autLsStapField = (k, v) => { if (_ui.ls.editingStap) _ui.ls.editingStap[k] = v; if (window.DFO?.render && (k === 'aanleiding' || k === 'kanaal')) window.DFO.render(); };
  window.__autLsStapFieldBool = (k, v) => { if (_ui.ls.editingStap) _ui.ls.editingStap[k] = !!v; };
  window.__autLsStapFieldTri = (k, v) => { if (_ui.ls.editingStap) _ui.ls.editingStap[k] = v === '' ? null : (v === 'true'); };
  window.__autLsStapSave = async () => {
    const s = _ui.ls.editingStap; if (!s) return;
    if (!s.naam || !s.naam.trim()) return alert('Naam is verplicht.');
    if (!s.traject_id) return alert('Traject-ID ontbreekt.');
    _setBusy('lsStapSave', true);
    try {
      const j = await window.KV.authedJson('/api/leadsonderhoud-stap-opslaan', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(s),
      });
      if (j?.error) throw new Error(j.error);
      _ui.ls.editingStap = null;
      _live.lsTraj.data = null; queueMicrotask(fetchLsTraj);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('lsStapSave', false); }
  };
  window.__autLsStapDelete = (id, naam) => {
    askConfirm(
      'Stap verwijderen?',
      `<p>Weet je zeker dat je <b>${esc(naam || 'deze stap')}</b> wilt verwijderen?</p>`,
      async () => {
        const j = await window.KV.authedJson('/api/leadsonderhoud-stap-verwijderen', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ id }),
        });
        if (j?.error) throw new Error(j.error);
        _live.lsTraj.data = null; queueMicrotask(fetchLsTraj);
      },
      { confirmLabel: 'Ja, verwijderen', danger: true }
    );
  };

  function _lsTrajEditor() {
    const t = _ui.ls.editingTraject; if (!t) return '';
    const isNew = !t.id;
    const busy = _busy('lsTrajSave');
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autLsTrajClose()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug</button>
      <span style="font-size:14px;font-weight:600">${isNew ? 'Nieuw traject' : 'Bewerken: ' + esc(t.naam || t.slug)}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autLsTrajSave()" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:720px;margin:0 auto"><div class="card"><div class="card-body" style="padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Naam</label><input type="text" value="${esc(t.naam)}" oninput="window.__autLsTrajField('naam', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Slug (uniek)</label><input type="text" value="${esc(t.slug)}" oninput="window.__autLsTrajField('slug', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" /></div>
      </div>
      <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Omschrijving</label><textarea oninput="window.__autLsTrajField('omschrijving', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box;min-height:60px;resize:vertical;font-family:inherit">${esc(t.omschrijving || '')}</textarea></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Agent</label><input type="text" value="${esc(t.agent || '')}" oninput="window.__autLsTrajField('agent', this.value)" placeholder="bv. Aisha" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Volgorde</label><input type="number" value="${esc(String(t.volgorde || 1))}" oninput="window.__autLsTrajField('volgorde', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Archief na (dagen)</label><input type="number" value="${esc(String(t.archief_na || 30))}" oninput="window.__autLsTrajField('archief_na', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
      </div>
      <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Agenda-link (optioneel)</label><input type="text" value="${esc(t.agenda_link || '')}" oninput="window.__autLsTrajField('agenda_link', this.value)" placeholder="https://…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" ${t.actief ? 'checked' : ''} onchange="window.__autLsTrajFieldBool('actief', this.checked)" />
        <span>Actief (traject draait mee in drip-motor)</span>
      </label>
    </div></div></div></div>`;
  }

  function _lsStapEditor() {
    const s = _ui.ls.editingStap; if (!s) return '';
    const isNew = !s.id;
    const busy = _busy('lsStapSave');
    // Quiz-picker preload
    if (s.kanaal === 'quiz' || s.soort === 'quiz' || s.quiz_slug !== undefined) {
      if (!_live.lsQuiz.data && !_live.lsQuiz.loading) queueMicrotask(fetchLsQuiz);
    }
    const quizzes = asArr(_live.lsQuiz.data);
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autLsStapClose()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug</button>
      <span style="font-size:14px;font-weight:600">${isNew ? 'Nieuwe stap' : 'Bewerken: ' + esc(s.naam || s.soort || '—')}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autLsStapSave()" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:780px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      <div class="card"><div class="card-head"><div class="card-title">Basis</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Naam</label><input type="text" value="${esc(s.naam)}" oninput="window.__autLsStapField('naam', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Soort (slug, auto)</label><input type="text" value="${esc(s.soort || '')}" oninput="window.__autLsStapField('soort', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" /></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Kanaal</label>
            <select oninput="window.__autLsStapField('kanaal', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
              ${LS_KANALEN.map((k) => `<option value="${k}" ${s.kanaal === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}
            </select>
          </div>
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Urgentie (1-5)</label><input type="number" min="1" max="5" value="${esc(String(s.urgentie || 3))}" oninput="window.__autLsStapField('urgentie', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        </div>
      </div></div>

      <div class="card"><div class="card-head"><div class="card-title">Timing</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Aanleiding</label>
          <select oninput="window.__autLsStapField('aanleiding', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
            ${LS_AANLEIDINGEN.map((a) => `<option value="${a.v}" ${s.aanleiding === a.v ? 'selected' : ''}>${esc(a.l)}</option>`).join('')}
          </select>
        </div>
        ${(s.aanleiding === 'na_start' || s.aanleiding === 'dagen_voor_einde' || s.aanleiding === 'na_einde' || s.aanleiding === 'geen_activiteit' || s.aanleiding === 'dag_van_periode') ? `
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Waarde (aantal dagen)</label><input type="text" value="${esc(String(s.waarde || ''))}" oninput="window.__autLsStapField('waarde', this.value)" placeholder="bv. 7" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        ` : ''}
        ${s.aanleiding === 'vast_moment' ? `
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Weekdag</label>
              <select oninput="window.__autLsStapField('weekdag', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
                ${['','ma','di','wo','do','vr','za','zo'].map((w) => `<option value="${w}" ${s.weekdag === w ? 'selected' : ''}>${w || '—'}</option>`).join('')}
              </select>
            </div>
            <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Tijdstip</label><input type="text" value="${esc(s.tijdstip || '')}" oninput="window.__autLsStapField('tijdstip', this.value)" placeholder="HH:MM" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
          </div>
        ` : ''}
      </div></div>

      <div class="card"><div class="card-head"><div class="card-title">Filters</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Score min</label><input type="number" value="${esc(String(s.score_min ?? 0))}" oninput="window.__autLsStapField('score_min', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Score max</label><input type="number" value="${esc(String(s.score_max ?? 100))}" oninput="window.__autLsStapField('score_max', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" ${s.alleen_zonder_gesprek ? 'checked' : ''} onchange="window.__autLsStapFieldBool('alleen_zonder_gesprek', this.checked)" />
          <span>Alleen als er geen actief gesprek is</span>
        </label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Alleen ingelogd</label>
            <select oninput="window.__autLsStapFieldTri('alleen_ingelogd', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
              <option value="" ${s.alleen_ingelogd === null || s.alleen_ingelogd === undefined ? 'selected' : ''}>— beide —</option>
              <option value="true" ${s.alleen_ingelogd === true ? 'selected' : ''}>Ja (ingelogd)</option>
              <option value="false" ${s.alleen_ingelogd === false ? 'selected' : ''}>Nee (niet ingelogd)</option>
            </select>
          </div>
          <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Alleen verlengd</label>
            <select oninput="window.__autLsStapFieldTri('alleen_verlengd', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
              <option value="" ${s.alleen_verlengd === null || s.alleen_verlengd === undefined ? 'selected' : ''}>— beide —</option>
              <option value="true" ${s.alleen_verlengd === true ? 'selected' : ''}>Ja (verlengd)</option>
              <option value="false" ${s.alleen_verlengd === false ? 'selected' : ''}>Nee (niet verlengd)</option>
            </select>
          </div>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" ${s.herhaalbaar ? 'checked' : ''} onchange="window.__autLsStapFieldBool('herhaalbaar', this.checked)" />
          <span>Herhaalbaar (mag meerdere keren draaien voor dezelfde lead)</span>
        </label>
      </div></div>

      <div class="card"><div class="card-head"><div class="card-title">Vragenlijst-koppeling (optioneel)</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);line-height:1.5">
          <b>Vragenlijsten worden centraal beheerd in Instellingen (komt eraan).</b> Voor nu kies je een bestaande quiz uit de dropdown; de editor verhuist zonder herbouw van de backend.
        </div>
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Gekoppelde quiz</label>
          <select oninput="window.__autLsStapField('quiz_slug', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box">
            <option value="">— geen quiz —</option>
            ${quizzes.map((q) => `<option value="${esc(q.slug)}" ${s.quiz_slug === q.slug ? 'selected' : ''}>${esc(q.naam || q.slug)} (${q.vragen_actief || 0} vragen actief)</option>`).join('')}
          </select>
          ${_live.lsQuiz.loading && !_live.lsQuiz.data ? '<div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Quizzes laden…</div>' : ''}
        </div>
      </div></div>

      <div class="card"><div class="card-head"><div class="card-title">Volgorde & status</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div><label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Volgorde binnen traject</label><input type="number" value="${esc(String(s.volgorde || 1))}" oninput="window.__autLsStapField('volgorde', Number(this.value))" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:13px;box-sizing:border-box" /></div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
          <input type="checkbox" ${s.actief ? 'checked' : ''} onchange="window.__autLsStapFieldBool('actief', this.checked)" />
          <span>Actief</span>
        </label>
      </div></div>
    </div></div>`;
  }

  // NOTE: Lisa / Agent-autonomie-tab is verwijderd — die functionaliteit
  // hoort in de AI Agents-module, niet hier. Wanbetalers-tegel is ook weg
  // (dunning-backend blijft in Finance).

  // ═══════════════════════════════════════════════════════════════════════
  // HARMONISATIE — gedeelde 4-tab chip-toolbar (Flows/Berichten/Instellingen/Log)
  // ═══════════════════════════════════════════════════════════════════════
  const SUBTABS = [
    { v: 'flows',         l: 'Flows' },
    { v: 'berichten',     l: 'Berichten' },
    { v: 'instellingen',  l: 'Instellingen' },
    { v: 'log',           l: 'Log' },
  ];
  function _subtabToolbar(moduleKey, current) {
    return `<div class="toolbar" style="padding:12px 20px;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--border);background:var(--surface-2)">
      ${SUBTABS.map((s) => `<button class="chip ${current === s.v ? 'on' : ''}" onclick="window.__autSetSubtab('${esc(moduleKey)}','${s.v}')">${esc(s.l)}</button>`).join('')}
    </div>`;
  }
  window.__autSetSubtab = (moduleKey, subtab) => {
    if (moduleKey === 'ev') _ui.ev.subtab = subtab;
    else if (moduleKey === 'ob') _ui.ob.subtab = subtab;
    else if (moduleKey === 'ls') _ui.ls.subtab = subtab;
    if (window.DFO?.render) window.DFO.render();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // HARMONISATIE — Berichten-tab views (Events + Onboarding)
  //   Read: virtuele berichten uit steps[]. Bewerken: opent editor die de
  //   volledige automation ophaalt, alleen step.config muteert, en via
  //   bestaande save-endpoint terugschrijft. Rest van flow blijft 1-op-1.
  // ═══════════════════════════════════════════════════════════════════════
  function _evBerichtenView() {
    if (!_live.evBerichten.data && !_live.evBerichten.loading && !_live.evBerichten.error) queueMicrotask(fetchEvBerichten);
    if (_ui.ev.berichtEdit) return _berichtEditor('ev', _ui.ev.berichtEdit) + _confirmModalHtml();
    if (_live.evBerichten.error && !_live.evBerichten.data) return errBlk('evBerichten', _live.evBerichten.error, "window.__autRetry('evBerichten')");
    if (_live.evBerichten.loading && !_live.evBerichten.data) return skel();
    return _berichtenList('ev', asArr(_live.evBerichten.data));
  }
  function _obBerichtenView() {
    if (!_live.obBerichten.data && !_live.obBerichten.loading && !_live.obBerichten.error) queueMicrotask(fetchObBerichten);
    if (_ui.ob.berichtEdit) return _berichtEditor('ob', _ui.ob.berichtEdit) + _confirmModalHtml();
    if (_live.obBerichten.error && !_live.obBerichten.data) return errBlk('obBerichten', _live.obBerichten.error, "window.__autRetry('obBerichten')");
    if (_live.obBerichten.loading && !_live.obBerichten.data) return skel();
    return _berichtenList('ob', asArr(_live.obBerichten.data));
  }
  function _berichtenList(moduleKey, items) {
    if (items.length === 0) return emptyBlk('Geen berichten', 'Bericht-stappen (e-mail + WhatsApp) verschijnen hier zodra ze in een flow bestaan.');
    return `<div style="padding:12px 20px 20px">
      <div style="padding:10px 12px;background:var(--surface-2);border-radius:8px;font-size:12px;color:var(--text-2);line-height:1.5;margin-bottom:12px">
        Berichten worden bewerkt in de flow-stap zelf (bron-van-waarheid). Klik op een bericht om de editor te openen — je wijziging schrijft terug naar die specifieke stap, de rest van de flow blijft ongewijzigd.
      </div>
      ${H.table(
        [{l:'Automation'},{l:'Stap',cls:'r optional'},{l:'Kanaal'},{l:'Inhoud / Template'},{l:'Actief',cls:'r'},{l:'',cls:'r'}],
        items.map((b) => [
          `<div><div class="cell-main">${esc(b.automation_name || '—')}</div><div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:2px">${esc(String(b.automation_id || '').slice(0,8))}…</div></div>`,
          `<span class="mono" style="font-size:11.5px;color:var(--text-3)">step_${b.step_index}</span>`,
          `<span style="font-size:11.5px">${b.kanaal === 'whatsapp' ? '<span style="color:#25d366">📱 WA</span>' : '<span style="color:var(--blue)">✉ Mail</span>'}</span>`,
          b.kanaal === 'whatsapp'
            ? `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(b.template_name || '(geen template)')}</span>`
            : `<div style="max-width:340px"><div style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.onderwerp || '(geen onderwerp)')}</div>${b.body ? `<div style="font-size:10.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${esc(b.body.slice(0, 80))}${b.body.length > 80 ? '…' : ''}</div>` : ''}</div>`,
          b.automation_enabled ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
          `<div style="display:flex;gap:3px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick="window.__autBerichtEdit('${esc(moduleKey)}','${esc(b.automation_id)}',${b.step_index})">Bewerken →</button>
          </div>`,
        ])
      )}
    </div>`;
  }
  window.__autBerichtEdit = async (moduleKey, automationId, stepIndex) => {
    // Laad volledige automation (surgical-safe: we sturen 'em straks 1-op-1
    // terug met alleen step.config gewijzigd)
    const cacheKey = moduleKey === 'ev' ? 'evAutoById' : 'obAutoById';
    if (!_live[cacheKey].data[automationId]) {
      if (moduleKey === 'ev') await fetchEvAutoById(automationId);
      else await fetchObAutoById(automationId);
    }
    const auto = _live[cacheKey].data[automationId];
    if (!auto) return alert('Automation niet gevonden.');
    const step = asArr(auto.steps)[stepIndex];
    if (!step) return alert('Stap niet gevonden.');
    if (step.type !== 'send_email' && step.type !== 'send_whatsapp') {
      return alert('Deze stap is geen bericht-stap.');
    }
    const target = moduleKey === 'ev' ? _ui.ev : _ui.ob;
    target.berichtEdit = {
      automation_id: automationId,
      automation_name: auto.name || '(geen naam)',
      step_index: stepIndex,
      step_type: step.type,
      // Editable snapshot van step.config
      cfg: { ...(step.config || {}) },
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autBerichtClose = (moduleKey) => {
    (moduleKey === 'ev' ? _ui.ev : _ui.ob).berichtEdit = null;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autBerichtField = (moduleKey, k, v) => {
    const target = moduleKey === 'ev' ? _ui.ev : _ui.ob;
    if (target.berichtEdit) target.berichtEdit.cfg[k] = v;
  };
  // Guarded WA-template write: skip als newVal leeg is EN er al een saved template
  // is. Voorkomt dat een misklik op "— kies template —" een LIVE template wist.
  window.__autBerichtFieldTpl = (moduleKey, v) => {
    const target = moduleKey === 'ev' ? _ui.ev : _ui.ob;
    if (!target.berichtEdit) return;
    if (v === '' && target.berichtEdit.cfg.template_name) return;
    target.berichtEdit.cfg.template_name = v;
  };
  window.__autBerichtSave = async (moduleKey) => {
    const target = moduleKey === 'ev' ? _ui.ev : _ui.ob;
    const be = target.berichtEdit; if (!be) return;
    const cacheKey = moduleKey === 'ev' ? 'evAutoById' : 'obAutoById';
    const auto = _live[cacheKey].data[be.automation_id];
    if (!auto) return alert('Automation niet meer in cache.');
    // SURGICAL: kopieer de VOLLEDIGE automation, wijzig alleen die ene
    // step.config, en stuur alles 1-op-1 terug via bestaande save-endpoint.
    // Dit voorkomt dat andere velden (trigger/scope/andere steps) muteren.
    const payload = JSON.parse(JSON.stringify(auto));
    const step = asArr(payload.steps)[be.step_index];
    if (!step) return alert('Stap niet meer aanwezig.');
    step.config = { ...(step.config || {}), ...be.cfg };
    _setBusy('berichtSave', true);
    try {
      const endpoint = moduleKey === 'ev' ? '/api/events-automation-save' : '/api/onboarding-automation-save';
      const j = await window.KV.authedJson(endpoint, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload),
      });
      if (j?.error) throw new Error(j.error);
      target.berichtEdit = null;
      // Invalidate caches — herfetch bericht-lijst + automation-cache
      _live[cacheKey].data[be.automation_id] = null;
      if (moduleKey === 'ev') { _live.evBerichten.data = null; _live.evAutos.data = null; queueMicrotask(fetchEvBerichten); queueMicrotask(fetchEvAutos); }
      else { _live.obBerichten.data = null; _live.obAutos.data = null; queueMicrotask(fetchObBerichten); queueMicrotask(fetchObAutos); }
      _showToast('Bericht opgeslagen');
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _setBusy('berichtSave', false); }
  };

  function _berichtEditor(moduleKey, be) {
    const isMail = be.step_type === 'send_email';
    const isWA   = be.step_type === 'send_whatsapp';
    const busy = _busy('berichtSave');
    const cfg = be.cfg || {};
    // Template-picker preload voor WA
    const stTpls = moduleKey === 'ev' ? _live.evTpls : _live.obTpls;
    if (isWA && !stTpls.data && !stTpls.loading && !stTpls.error) {
      queueMicrotask(moduleKey === 'ev' ? fetchEvTpls : fetchObTpls);
    }
    const tpls = asArr(stTpls.data);
    const savedTplName = cfg.template_name || '';
    const savedTplInList = tpls.some((t) => t.name === savedTplName);
    const tplFallbackOpt = (savedTplName && !savedTplInList)
      ? `<option value="${esc(savedTplName)}" selected>${esc(savedTplName)} — opgeslagen (niet in huidige lijst)</option>` : '';
    const tplErrNote = stTpls.error
      ? `<div style="font-size:10.5px;color:var(--rose);margin-top:4px">Templates niet geladen: ${esc(stTpls.error)}. <button class="btn btn-ghost btn-sm" onclick="window.__autTplsRetry('${esc(moduleKey)}')" style="padding:2px 6px;font-size:10.5px">Opnieuw</button></div>`
      : `<div style="font-size:10.5px;color:var(--text-3);margin-top:4px">${tpls.length} approved templates. Named placeholders worden server-side geresolved.</div>`;
    const tplPlaceholderSelected = !savedTplName ? 'selected' : '';
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__autBerichtClose('${esc(moduleKey)}')">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar berichten</button>
      <span style="font-size:14px;font-weight:600">Bericht bewerken — ${esc(be.automation_name)} · step_${be.step_index}</span>
      <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="window.__autBerichtSave('${esc(moduleKey)}')" ${busy ? 'disabled' : ''}>${busy ? 'Opslaan…' : (svg(I.tick) + 'Opslaan')}</button>
    </div>
    <div class="pad" style="padding-top:14px"><div style="max-width:820px;margin:0 auto;display:flex;flex-direction:column;gap:14px">
      <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line, var(--amber));border-radius:8px;font-size:12px;color:var(--text-2);line-height:1.5">
        <b>Surgical write:</b> alleen deze specifieke bericht-stap wordt gewijzigd. De rest van de flow (trigger, scope, andere stappen) blijft 1-op-1 zoals hij is.
      </div>
      ${isMail ? `<div class="card"><div class="card-head"><div class="card-title">E-mail</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Onderwerp</label>
          <input type="text" value="${esc(cfg.subject || '')}" oninput="window.__autBerichtField('${esc(moduleKey)}','subject', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box" />
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Body (tekst)</label>
          <textarea oninput="window.__autBerichtField('${esc(moduleKey)}','body', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box;min-height:180px;font-family:inherit;resize:vertical">${esc(cfg.body || '')}</textarea>
          <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Placeholders: <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">{{attendee.voornaam}}</code>, <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">{{event.titel}}</code>, <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">{{event.datum}}</code></div>
        </div>
      </div></div>` : ''}
      ${isWA ? `<div class="card"><div class="card-head"><div class="card-title">WhatsApp-template</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px">
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Meta-template</label>
          <select onchange="window.__autBerichtFieldTpl('${esc(moduleKey)}', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;box-sizing:border-box">
            <option value="" ${tplPlaceholderSelected}>— kies template —</option>
            ${tplFallbackOpt}
            ${tpls.map((t) => `<option value="${esc(t.name)}" ${savedTplName === t.name ? 'selected' : ''}>${esc(t.name)} (${esc(t.language || 'nl')})</option>`).join('')}
          </select>
          ${tplErrNote}
        </div>
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:4px">Taal</label>
          <input type="text" value="${esc(cfg.language || 'nl')}" oninput="window.__autBerichtField('${esc(moduleKey)}','language', this.value)" style="width:120px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
        </div>
      </div></div>` : ''}
    </div></div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HARMONISATIE — Log-tab views
  // ═══════════════════════════════════════════════════════════════════════
  function _evLogView() {
    // Toon lijst van automations met per-automation "Runs bekijken"-knop
    if (!_live.evAutos.data && !_live.evAutos.loading && !_live.evAutos.error) queueMicrotask(fetchEvAutos);
    if (_ui.ev.runsModal) return _evRunsModal() + _confirmModalHtml();
    if (_live.evAutos.loading && !_live.evAutos.data) return skel();
    const items = asArr(_live.evAutos.data);
    if (items.length === 0) return emptyBlk('Geen runs', 'Nog geen automations om logs voor te tonen.');
    return _autoLogList('ev', items);
  }
  function _obLogView() {
    if (!_live.obAutos.data && !_live.obAutos.loading && !_live.obAutos.error) queueMicrotask(fetchObAutos);
    if (_ui.ob.runsModal) return _obRunsModal() + _confirmModalHtml();
    if (_live.obAutos.loading && !_live.obAutos.data) return skel();
    const items = asArr(_live.obAutos.data);
    if (items.length === 0) return emptyBlk('Geen runs', 'Nog geen automations om logs voor te tonen.');
    return _autoLogList('ob', items);
  }
  function _autoLogList(moduleKey, items) {
    return `<div style="padding:12px 20px 20px">
      ${H.table(
        [{l:'Automation'},{l:'Trigger',cls:'optional'},{l:'Stappen',cls:'r optional'},{l:'Status'},{l:'',cls:'r'}],
        items.map((a) => [
          `<span class="cell-main">${esc(a.name || '—')}</span>`,
          `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(a.trigger_type || '—')}</span>`,
          `<span class="mono">${asArr(a.steps).length}</span>`,
          a.enabled ? H.pill('ok','Actief') : H.pill('neutral','Uit'),
          `<button class="btn btn-ghost btn-sm" onclick="window.__aut${moduleKey === 'ev' ? 'Ev' : 'Ob'}Runs('${esc(a.id)}')">Runs bekijken →</button>`,
        ])
      )}
    </div>`;
  }
  function _lsLogView() {
    const f = _ui.ls.logFilters = _ui.ls.logFilters || {};
    if (!_live.lsLog.data && !_live.lsLog.loading && !_live.lsLog.error) queueMicrotask(() => fetchLsLog(f));
    // Filter-controls (traject/status/soort) — leeg = alles.
    const trajectOpts = ['','fase1','fase2','fase3','fase4','fase5','fase6','fase7'];
    const statusOpts  = ['','verstuurd','droog','fout'];
    const soortOpts   = ['','tip','herinnering','uitnodiging','anders'];
    const filterBar = `<div class="toolbar" style="padding:0 20px 12px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border);margin-bottom:12px">
      <label style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:6px">Traject
        <select onchange="window.__autLsLogFilter('traject', this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12.5px">
          ${trajectOpts.map((v) => `<option value="${esc(v)}" ${f.traject === v ? 'selected' : ''}>${esc(v || 'Alle')}</option>`).join('')}
        </select>
      </label>
      <label style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:6px">Status
        <select onchange="window.__autLsLogFilter('status', this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12.5px">
          ${statusOpts.map((v) => `<option value="${esc(v)}" ${f.status === v ? 'selected' : ''}>${esc(v || 'Alle')}</option>`).join('')}
        </select>
      </label>
      <label style="font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:6px">Soort
        <select onchange="window.__autLsLogFilter('soort', this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12.5px">
          ${soortOpts.map((v) => `<option value="${esc(v)}" ${f.soort === v ? 'selected' : ''}>${esc(v || 'Alle')}</option>`).join('')}
        </select>
      </label>
      ${(f.traject || f.status || f.soort) ? `<button class="btn btn-ghost btn-sm" onclick="window.__autLsLogFilterReset()">Reset filters</button>` : ''}
    </div>`;
    if (_live.lsLog.error && !_live.lsLog.data) return filterBar + errBlk('lsLog', _live.lsLog.error, "window.__autLsLogRetry()");
    if (_live.lsLog.loading && !_live.lsLog.data) return filterBar + skel();
    const d = _live.lsLog.data || {};
    const items = asArr(d.items);
    const s = d.statussen || { verstuurd: 0, droog: 0, fout: 0 };
    return `<div style="padding:12px 20px 20px">
      ${filterBar}
      ${H.kpis([
        { c:'emerald', icon:I.tick,  label:'Verstuurd (14d)', val:String(s.verstuurd || 0) },
        { c:'amber',   icon:I.clock, label:'Droog (simulatie)', val:String(s.droog || 0) },
        { c:'rose',    icon:I.alert, label:'Fout',             val:String(s.fout || 0), hi: s.fout > 0 ? 1 : 0 },
      ])}
      ${items.length === 0 ? emptyBlk('Geen log-items', 'Geen berichten die aan de filters voldoen (14d venster).')
        : `<div style="padding:0">${H.table(
            [{l:'Wanneer'},{l:'Traject'},{l:'Soort',cls:'optional'},{l:'Kanaal',cls:'optional'},{l:'Naar'},{l:'Agent',cls:'optional'},{l:'Status'}],
            items.slice(0, 200).map((r) => [
              `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(_fmtDateTime(r.verstuurd_op))}</span>`,
              `<span style="font-size:12.5px">${esc(r.traject || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(r.soort || '—')}</span>`,
              `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(r.kanaal || '—')}</span>`,
              `<span class="mono" style="font-size:11.5px">${esc(r.naar || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(r.agent || '—')}</span>`,
              r.status === 'verstuurd' ? H.pill('ok','Verstuurd') : r.status === 'droog' ? H.pill('warn','Droog') : H.pill('danger', r.status || '—'),
            ])
          )}</div>`}
    </div>`;
  }
  window.__autLsLogRetry = () => { _live.lsLog.data = null; _live.lsLog.error = null; fetchLsLog(_ui.ls.logFilters || {}); };
  window.__autLsLogFilter = (k, v) => {
    _ui.ls.logFilters = _ui.ls.logFilters || {};
    _ui.ls.logFilters[k] = v || '';
    _live.lsLog.data = null; _live.lsLog.error = null;
    fetchLsLog(_ui.ls.logFilters);
  };
  window.__autLsLogFilterReset = () => {
    _ui.ls.logFilters = {};
    _live.lsLog.data = null; _live.lsLog.error = null;
    fetchLsLog({});
  };

  // ═══════════════════════════════════════════════════════════════════════
  // HARMONISATIE — Instellingen-tab views
  // ═══════════════════════════════════════════════════════════════════════
  function _evInstellingenView() {
    return `<div class="pad" style="padding-top:14px"><div style="max-width:720px;margin:0 auto">
      <div class="card"><div class="card-head"><div class="card-title">Instellingen — Events-automatiseringen</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--text-2);line-height:1.6">
        <div><b>Trigger-defaults</b> worden per flow gezet in de Flows-tab (open een flow → Trigger-sectie).</div>
        <div><b>Enroll-mode</b> (new_only vs include_existing) staat per flow.</div>
        <div><b>Scope</b> (all/niveau/events) staat per flow.</div>
        <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3)">Er zijn geen module-brede events-automation-instellingen. De Overzicht-tab toont de cron-status (elke minuut).</div>
      </div></div>
    </div></div>`;
  }
  function _obInstellingenView() {
    return `<div class="pad" style="padding-top:14px"><div style="max-width:720px;margin:0 auto">
      <div class="card"><div class="card-head"><div class="card-title">Instellingen — Onboarding-automatiseringen</div></div><div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:10px;font-size:12.5px;color:var(--text-2);line-height:1.6">
        <div><b>Trigger-defaults</b> worden per flow gezet in de Flows-tab.</div>
        <div><b>Enroll-mode</b> staat per flow.</div>
        <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3)">Onboarding-automations hebben geen scope-veld (verschilt van Events, bewust: onboarding is 1-op-1 per klant).</div>
      </div></div>
    </div></div>`;
  }
  function _lsInstellingenView() {
    if (!_live.lsInst.data && !_live.lsInst.loading && !_live.lsInst.error) queueMicrotask(fetchLsInst);
    const inst = _live.lsInst.data;
    const isLive = inst?.live === true;
    const noodstop = inst?.noodstop === true;
    return `<div class="pad" style="padding-top:14px"><div style="max-width:720px;margin:0 auto"><div class="card">
      <div class="card-head"><div class="card-title">Instellingen — Leadsonderhoud</div></div>
      <div class="card-body" style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;gap:12px;padding:10px;border:1px solid var(--border);border-radius:8px">
          <div style="flex:1">
            <div style="font-size:13.5px;font-weight:500">Drip-motor live</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Env: <span class="mono">${esc(inst?.omgeving || '—')}</span> · Status: ${isLive ? '<span style="color:var(--emerald)">LIVE</span>' : '<span style="color:var(--text-3)">uit</span>'}${noodstop ? ' · <span style="color:var(--rose);font-weight:600">⚠ NOODSTOP env-var actief</span>' : ''}</div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.__autLsToggle()" ${_busy('lsToggle') ? 'disabled' : ''}>${isLive ? 'Uit zetten' : 'Aan zetten'}</button>
        </div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>Stille uren:</b> 21:00–08:00 (motor stuurt niets in dit venster).<br>
          <b>Max berichten/dag/persoon:</b> 1 (motor skipt herhalingen binnen 24u).<br>
          <b>Cron:</b> elk kwartier (via Vercel cron).
        </div>
      </div>
    </div></div></div>
    ${_confirmModalHtml()}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW REGISTRATIE
  // ═══════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  window.DFO.VIEWS['automatiseringen/Overzicht']      = overzichtView;
  window.DFO.VIEWS['automatiseringen/Events']         = eventsView;
  window.DFO.VIEWS['automatiseringen/Onboarding']     = onboardingView;
  window.DFO.VIEWS['automatiseringen/Leadsonderhoud'] = leadsonderhoudView;

  console.debug('[automatiseringen-v2] views geregistreerd (Overzicht/Events/Onboarding/Leadsonderhoud)');
})();
