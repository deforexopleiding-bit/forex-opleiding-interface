// modules/klanten-v2/views/automatiseringen-v2.js
//
// Fase F — Automatiseringen. DATA-KOPPELING 2026-08-13. Dormant.
// QA via ?v2preview=automatiseringen (rol Manager).
//
// Endpoints (read-only):
//   GET /api/events-automations-list         (Events tab)
//   GET /api/onboarding-automations-list     (Onboarding tab)
//   GET /api/events-automation-runs?...      (per-detail — later)
//   GET /api/onboarding-automation-runs?...  (per-detail — later)
//
// Needs Jeffrey:
// - Overzicht KPI's/motoren aggregatie: gebruikt list-counts uit beide endpoints,
//   maar CRONS/SCHAKELAARS bestaan niet als endpoints (mock blijft).
// - Leadsonderhoud/Wanbetalers/Lisa/Joost hebben geen unified automation-model.
// - Alle write-flows (create/edit/toggle/test-run) — needs Jeffrey.

(function () {
  if (!window.DFO) { console.error('[automatiseringen-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[automatiseringen-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const _live = {
    events:     { loading: false, error: null, data: null },
    onboarding: { loading: false, error: null, data: null },
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[aut-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }
  async function fetchEventsAut() {
    const st = _live.events; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('events-aut', '/api/events-automations-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.automations);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchOnboardingAut() {
    const st = _live.onboarding; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('onb-aut', '/api/onboarding-automations-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.automations);
    if (window.DFO?.render) window.DFO.render();
  }
  window.__autRetry = (b) => {
    if (b === 'events')     { _live.events.data = null; _live.events.error = null; fetchEventsAut(); }
    if (b === 'onboarding') { _live.onboarding.data = null; _live.onboarding.error = null; fetchOnboardingAut(); }
    if (window.DFO?.render) window.DFO.render();
  };
  window.__autGoTab = (t) => { try { goTab(t); } catch (_) {} };
  window.__autNotice = (l) => { console.info('[aut-v2] ' + l); try { alert(l + ' — write-flow needs Jeffrey.'); } catch (_) {} };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__autRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const nj = (r) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;align-items:center;gap:12px"><span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}</span><span><b>Needs Jeffrey</b> — ${esc(r)}</span></div>`;
  const _fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('nl-NL', { day:'numeric', month:'short' }) : '—'; };

  function _autTable(automations) {
    if (!automations.length) return `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen automations</div><div class="empty-s">Er zijn nog geen automations gedefinieerd voor deze motor.</div></div>`;
    return H.table(
      [{ l: 'Naam' }, { l: 'Trigger', cls: 'optional' }, { l: 'Stappen', cls: 'r optional' }, { l: 'Scope', cls: 'optional' }, { l: 'Enroll', cls: 'optional' }, { l: 'Actief' }, { l: 'Bijgewerkt', cls: 'r optional' }],
      automations.map((a) => {
        const enabled = !!a.enabled;
        const steps = asArr(a.steps);
        return [
          `<div><div class="cell-main">${esc(a.name || '—')}</div>${a.description ? `<div class="cell-sub" style="font-size:11.5px">${esc(a.description)}</div>` : ''}</div>`,
          `<span class="mono" style="font-size:11.5px">${esc(a.trigger_type || '—')}</span>`,
          `<span class="mono">${steps.length}</span>`,
          a.scope_type ? H.pill('neutral', a.scope_type) : '<span style="color:var(--text-3);font-size:11px">—</span>',
          a.enroll_mode ? H.pill(a.enroll_mode === 'include_existing' ? 'accent' : 'neutral', a.enroll_mode) : '<span style="color:var(--text-3);font-size:11px">—</span>',
          enabled ? H.pill('ok', 'Aan') : H.pill('neutral', 'Uit'),
          `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(a.updated_at || a.created_at))}</span>`,
        ];
      })
    );
  }

  // ── VIEW: Overzicht ──────────────────────────────────────────────────
  function overzichtView() {
    if (!_live.events.data && !_live.events.loading && !_live.events.error) queueMicrotask(fetchEventsAut);
    if (!_live.onboarding.data && !_live.onboarding.loading && !_live.onboarding.error) queueMicrotask(fetchOnboardingAut);
    const evAut = asArr(_live.events.data);
    const obAut = asArr(_live.onboarding.data);
    const evActive = evAut.filter((a) => a.enabled).length;
    const obActive = obAut.filter((a) => a.enabled).length;
    const evLoading = _live.events.loading && !_live.events.data;
    const obLoading = _live.onboarding.loading && !_live.onboarding.data;

    const motors = [
      { id: 'events', n: 'Events', d: 'Aanmelding, vragenlijst, herinneringen', ic: I.cal, c: 'pink', total: evAut.length, active: evActive, loading: evLoading, error: _live.events.error, live: true },
      { id: 'onboarding', n: 'Onboarding', d: 'Welkom, wizard-herinneringen', ic: I.route, c: 'emerald', total: obAut.length, active: obActive, loading: obLoading, error: _live.onboarding.error, live: true },
      { id: 'leadsonderhoud', n: 'Leadsonderhoud', d: 'Opvolgtrajecten', ic: I.repeat, c: 'teal', needsJeffrey: 'geen unified automation-model' },
      { id: 'wanbetalers', n: 'Wanbetalers', d: 'Aanmaanstappen, wachttijden', ic: I.alert, c: 'amber', needsJeffrey: 'engine-based (protected zone)', lock: true },
      { id: 'lisa', n: 'Lisa', d: 'IG-opvolging', ic: I.bot, c: 'violet', needsJeffrey: 'agent-config, geen automation-tabel' },
    ];

    return `${H.kpis([
      { c: 'blue',    icon: I.repeat, label: 'Automations totaal (live)', val: String(evAut.length + obAut.length), sub: 'events + onboarding' },
      { c: 'emerald', icon: I.tick,   label: 'Actief',                     val: String(evActive + obActive), hi: 1 },
      { c: 'amber',   icon: I.alert,  label: 'Uit',                        val: String((evAut.length + obAut.length) - (evActive + obActive)), hi: 1 },
      { c: 'violet',  icon: I.clock,  label: 'Andere motoren',             val: '3', sub: 'needs Jeffrey (leadsonderhoud/wb/lisa)' },
    ])}
    ${_live.events.error ? errBlk('events', _live.events.error) : ''}
    ${_live.onboarding.error ? errBlk('onboarding', _live.onboarding.error) : ''}
    <div class="pad" style="padding-top:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Motoren</div>
      <div class="grid g3">
        ${motors.map((m) => `<div class="card ${m.live ? 'card-hover' : ''}" style="${m.live ? 'cursor:pointer' : ''}" ${m.live ? `onclick="__autGoTab('${esc(m.n)}')"` : ''}>
          <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
            <span class="tile-ico" style="background:var(--${m.c}-soft);color:var(--${m.c})">${svg(m.ic)}</span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                <span class="card-title">${esc(m.n)}</span>
                ${m.lock ? `<span class="pill pill-warn nodot" style="font-size:10.5px;padding:1.5px 7px">Protected</span>` : ''}
                ${m.live ? H.pill('ok', 'LIVE', 1) : H.pill('warn', 'stub', 1)}
              </div>
              <div style="font-size:12px;color:var(--text-3);margin-top:3px;line-height:1.45">${esc(m.d)}</div>
            </div>
          </div>
          ${m.live
            ? `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
                <div style="background:var(--surface);padding:10px 12px;text-align:center">
                  <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace">${m.loading ? '…' : m.total}</div>
                  <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">TOTAAL</div></div>
                <div style="background:var(--surface);padding:10px 12px;text-align:center">
                  <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:var(--emerald)">${m.loading ? '…' : m.active}</div>
                  <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">ACTIEF</div></div>
              </div>`
            : `<div style="padding:10px 17px;border-top:1px solid var(--border);font-size:11px;color:var(--amber)">${esc(m.needsJeffrey || 'needs Jeffrey')}</div>`}
        </div>`).join('')}
      </div>
      ${nj('Achtergrondtaken (crons) en Schakelaars komen uit config-endpoints die nog gebouwd moeten worden. In v1 zit dit verspreid in admin.html + individuele modules.')}
    </div>`;
  }

  // ── VIEW: Events ─────────────────────────────────────────────────────
  function eventsView() {
    if (!_live.events.data && !_live.events.loading && !_live.events.error) queueMicrotask(fetchEventsAut);
    if (_live.events.error && !_live.events.data) return errBlk('events', _live.events.error);
    if (_live.events.loading && !_live.events.data) return skel();
    return `<div style="padding:16px 22px;font-size:12.5px;color:var(--text-2)">Events-automations (${asArr(_live.events.data).length}) — read-only. Editor + test-runs needs Jeffrey.</div>${_autTable(asArr(_live.events.data))}`;
  }

  // ── VIEW: Onboarding ─────────────────────────────────────────────────
  function onboardingView() {
    if (!_live.onboarding.data && !_live.onboarding.loading && !_live.onboarding.error) queueMicrotask(fetchOnboardingAut);
    if (_live.onboarding.error && !_live.onboarding.data) return errBlk('onboarding', _live.onboarding.error);
    if (_live.onboarding.loading && !_live.onboarding.data) return skel();
    return `<div style="padding:16px 22px;font-size:12.5px;color:var(--text-2)">Onboarding-automations (${asArr(_live.onboarding.data).length}) — read-only. Editor + test-runs needs Jeffrey.</div>${_autTable(asArr(_live.onboarding.data))}`;
  }

  // ── VIEW: Overige tabs (needs Jeffrey) ───────────────────────────────
  const njMotor = (naam, reason) => () => `${nj(reason)}
    <div style="padding:24px;max-width:640px;color:var(--text-3);font-size:13px;line-height:1.6">
      <p><b>${esc(naam)}</b> heeft geen aparte automation-tabel. Config zit in de eigen module of engine.</p>
      <a class="btn btn-ghost btn-sm" href="#" onclick="event.preventDefault();__autGoTab('Overzicht')">← Terug naar Overzicht</a>
    </div>`;

  window.DFO.VIEWS['automatiseringen/Overzicht']      = overzichtView;
  window.DFO.VIEWS['automatiseringen/Events']         = eventsView;
  window.DFO.VIEWS['automatiseringen/Onboarding']     = onboardingView;
  window.DFO.VIEWS['automatiseringen/Leadsonderhoud'] = njMotor('Leadsonderhoud', 'Leadsonderhoud werkt met drip-trajecten (endpoint /api/leadsonderhoud-trajecten), geen unified automation-model. Zie Leadsonderhoud-module.');
  window.DFO.VIEWS['automatiseringen/Wanbetalers']    = njMotor('Wanbetalers', 'Wanbetalers-engine (dunning-engine, /api/cron-dunning-*) zit in protected zone. Beheer via Finance-module.');
  window.DFO.VIEWS['automatiseringen/Lisa']           = njMotor('Lisa', 'Lisa-automatiseringen leven in agent-config (/api/lisa-config, /api/lisa-settings), geen automation-tabel. Zie Lisa-module.');
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('automatiseringen');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('automatiseringen');
  console.debug('[automatiseringen-v2] data-ronde geregistreerd (dormant)');
})();
