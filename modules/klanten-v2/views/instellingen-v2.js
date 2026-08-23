// modules/klanten-v2/views/instellingen-v2.js
//
// Fase G — Instellingen (layout-only). 1 view (module heeft tabs:[]),
// met SETS-nav links + set-body rechts (switch per set-page). Focus op de
// WhatsApp-templatebeheer-sectie (com-wa) omdat die het meest concreet is;
// andere set-pages (rechten/trajecten/verzendvenster/bedrijf) hebben een
// lean detail-panel. Prototype: systeemprototype-v45.html r4167-4413.
// Dormant. Preview ?v2preview=instellingen (rol Manager/Admin/Super admin).

(function () {
  if (!window.DFO) { console.error('[instellingen-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[instellingen-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F, setF, S, render } = window.DFO;
  const H = window.KV_V2.helpers;

  // v=2 admin-tools state (verhuisd uit followup-v2.js).
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const _live = {
    adminBackfillContacts: { data: null, error: null },
    adminGhlBackfill:      { data: null, error: null, mode: 'dry_run' },
  };
  const _ui = {
    adminBackfillBusy:       false,
    adminGhlBackfillConfirm: '',    // "IK BEGRIJP HET" token
    adminGhlBackfillBusy:    false,
    confirmModal:            null,  // { msg, onOk, tone }
    toast:                   null,
  };

  // Rol-check (super_admin only). Kijkt naar de v2 shell rol-state; als
  // die niet aanwezig is (browser-preview zonder auth), toont het simpel
  // een block.
  function isSuperAdmin() {
    try {
      const role = window.DFO?.S?.role || window.KV_V2?.role || null;
      return role === 'super_admin';
    } catch (_) { return false; }
  }
  function showToast(msg, tone) {
    // BLOCKER-5: helpers.showToast bestaat niet altijd (v2 shell heeft z'n
    // eigen toast-container #kv-toast). Probeer eerst de v2-shell-toast, dan
    // KV_V2.helpers, dan fallback naar in-page ui.toast (renderer via
    // _renderInPageToast() als onderdeel van elke render). Nooit stil falen.
    try {
      const el = document.getElementById('kv-toast');
      if (el) {
        const cls = tone === 'warn' || tone === 'error' ? 'ds-toast-error' : (tone === 'ok' || tone === 'success' ? 'ds-toast-ok' : '');
        el.className = 'ds-toast show ' + cls;
        el.textContent = String(msg || '');
        // Nit-fix (verify Wave-2): bij dismiss ook textContent leegmaken zodat
        // er geen ghost-tekst in de DOM blijft plakken (visueel onzichtbaar
        // maar detecteerbaar via document.body.innerText).
        setTimeout(() => { try { el.className = 'ds-toast'; el.textContent = ''; } catch (_) {} }, 3500);
        return;
      }
    } catch (_) { /* fall through */ }
    if (window.KV_V2?.helpers?.showToast) { try { window.KV_V2.helpers.showToast(msg, tone); return; } catch (_) {} }
    _ui.toast = { msg, tone: tone || 'info' };
    if (render) render();
    setTimeout(() => { _ui.toast = null; if (render) render(); }, 3000);
  }
  function openConfirm(msg, onOk, tone) {
    _ui.confirmModal = { msg, onOk, tone: tone || 'warn' };
    if (render) render();
  }
  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 60000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      // BLOCKER-5 hardening: log altijd naar console.error (was console.warn
      // die stille failures gaf), status meenemen zodat de call-site kan
      // tonen welke HTTP-fout het was.
      const status = e && e.status ? ` [HTTP ${e.status}]` : '';
      console.error('[instellingen-v2] ' + label + ' fail:' + status, e?.message, e?.body);
      return { __error: (e?.message || 'onbekende fout') + status };
    }
  }

  // Fetchers — 1-op-1 kopie uit followup-v2 v=16 (endpoints identiek,
  // guards identiek). ghl-status-backfill blijft klant-risk met dezelfde
  // 3-staps-guard: dry-run → typ "IK BEGRIJP HET" → confirm-modal.
  async function submitAdminBackfillContacts() {
    if (_ui.adminBackfillBusy) return;
    _ui.adminBackfillBusy = true;
    _live.adminBackfillContacts.data = null;
    _live.adminBackfillContacts.error = null;
    if (render) render();
    const j = await tryFetch('backfill-contacts', '/api/follow-up-backfill-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, 60000);
    _ui.adminBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminBackfillContacts.error = j.__error || j.error;
      showToast('Backfill mislukt: ' + _live.adminBackfillContacts.error, 'warn');
    } else {
      _live.adminBackfillContacts.data = { totaal: j.totaal || 0, updated: j.updated || 0, skipped: j.skipped || 0, errors: j.errors || 0 };
      showToast(`Backfill klaar · ${j.updated || 0}/${j.totaal || 0} bijgewerkt`, 'success');
    }
    if (render) render();
  }
  async function submitAdminGhlBackfill(dryRun) {
    if (_ui.adminGhlBackfillBusy) return;
    _ui.adminGhlBackfillBusy = true;
    if (render) render();
    const body = dryRun
      ? { dry_run: true, mode: 'strict', limit: 50 }
      : { dry_run: false, mode: 'strict', limit: 50, confirm: _ui.adminGhlBackfillConfirm };
    const j = await tryFetch('ghl-backfill', '/api/follow-up-ghl-status-backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 60000);
    _ui.adminGhlBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminGhlBackfill.error = j.__error || j.error;
      showToast('GHL-backfill mislukt: ' + _live.adminGhlBackfill.error, 'warn');
    } else {
      _live.adminGhlBackfill.data = j;
      _live.adminGhlBackfill.mode = dryRun ? 'dry_run' : 'executed';
      showToast(dryRun ? `Dry-run: ${j.returned || 0} kandidaten` : `Executed: ${j.succeeded || 0}/${j.processed || 0} bijgewerkt`, 'success');
      if (!dryRun) _ui.adminGhlBackfillConfirm = '';
    }
    if (render) render();
  }

  // Handlers (global __setAdmin* naming om conflicts met followup-v2 te
  // vermijden; die zijn daar geheel verwijderd).
  window.__setAdminBackfillContacts = () => {
    openConfirm('Backfill GHL-contacts naar alle appointments met ontbrekende email/telefoon? Loopt door alle appts; kan lang duren (max 60s per run).', submitAdminBackfillContacts, 'warn');
  };
  window.__setAdminGhlBackfillDry = () => submitAdminGhlBackfill(true);
  window.__setAdminGhlBackfillConfirm = (v) => { _ui.adminGhlBackfillConfirm = v; if (render) render(); };
  window.__setAdminGhlBackfillExecute = () => {
    if (_ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET') { showToast('Typ letterlijk "IK BEGRIJP HET" in het confirm-veld', 'warn'); return; }
    // Stap 3: harde confirm-modal vóór de mutatie live gaat.
    openConfirm('EXECUTE GHL-status-backfill (mode=strict, limit=50)? Muteert live GHL appointmentStatus → "showed". Alleen super_admin. Onomkeerbaar.', () => submitAdminGhlBackfill(false), 'warn');
  };
  window.__setConfirmOk = () => {
    const m = _ui.confirmModal; if (!m) return;
    _ui.confirmModal = null;
    if (render) render();
    if (typeof m.onOk === 'function') { try { m.onOk(); } catch (_) {} }
  };
  window.__setConfirmCancel = () => { _ui.confirmModal = null; if (render) render(); };

  // Nav — 1-op-1 uit prototype r4167-4222 (9 groepen · 30 set-pages).
  const SETS = [
    { g: 'Verkoop', items: [
      { id: 'sales-trajecten',  n: 'Trajecten',           d: '1-op-1 en membership · looptijden, prijzen en termijnen', ic: I.tag },
      { id: 'sales-producten',  n: 'Losse producten',     d: 'E-books, lascursus, consultancy',                          ic: I.box },
      { id: 'sales-offerte',    n: 'Offerte-sjablonen',    d: 'Opmaak, voorwaarden en standaardteksten',                  ic: I.doc },
      { id: 'sales-bonus',      n: 'Verkopers en bonus',  d: 'Wie verkoopt wat, en hoe de bonus wordt berekend',          ic: I.users, roles: ['super_admin'] },
    ]},
    { g: 'Financieel', items: [
      { id: 'fin-facturatie',   n: 'Facturatie',           d: 'Nummering, betaaltermijn en standaard-btw',                 ic: I.doc },
      { id: 'fin-entiteiten',   n: 'Entiteiten',           d: 'Bedrijfs-entiteiten voor facturatie + MRR-scoping',         ic: I.building || I.file },
      { id: 'fin-teamleader',   n: 'Teamleader-koppeling', d: 'Synchronisatie van klanten, offertes en facturen',          ic: I.link || I.file },
      { id: 'fin-bank',         n: 'Bankkoppeling',        d: 'CAMT-import en matchingregels',                             ic: I.bank || I.file },
    ]},
    { g: 'Wanbetalers', items: [
      { id: 'wb-joost',         n: 'Joost — de toon',      d: 'Persona, autonomie, mandaat en communicatie-limieten',      ic: I.bot },
      { id: 'wb-workflows',     n: 'Wanneer starten & regels', d: 'De automatische stappen: wanneer welke aanmaning afgaat', ic: I.repeat },
      { id: 'wb-berichten',     n: 'Berichten',            d: 'Aanmaan- en briefteksten (incl. WIK-14-dagen)',             ic: I.mail },
      { id: 'wb-venster',       n: 'Verzendvenster',       d: 'Wanneer aanmaningen de deur uit mogen',                     ic: I.clock },
      { id: 'wb-incasso',       n: 'Incassobureaus',       d: 'Partners (NL/BE) waar dossiers naartoe gaan',               ic: I.building || I.file },
    ]},
    { g: 'AI Agents', items: [
      { id: 'agents-lisa',      n: 'Lisa',                 d: 'Persona, fases, follow-ups en verzendvenster',              ic: I.bot },
      { id: 'agents-kennis',    n: 'Kennisbank voor AI',   d: 'Wat Lisa en Joost weten over jullie aanbod',                ic: I.book || I.doc },
      { id: 'agents-manager',   n: 'AI Manager',           d: 'Toegang tot bedrijfsdata en vraagrechten',                  ic: I.sparkles || I.bot },
    ]},
    { g: 'Events & Leren', items: [
      { id: 'ev-auto',          n: 'Event-automatiseringen', d: 'Welke berichten wanneer uitgaan rond een event',           ic: I.repeat },
      { id: 'ev-templates',     n: 'Event-berichten',      d: 'E-mail en WhatsApp-templates',                              ic: I.mail },
      { id: 'lms-instel',       n: 'LMS-instellingen',     d: 'Modules, toegang en certificaten',                          ic: I.book || I.doc },
    ]},
    { g: 'Communicatie', items: [
      { id: 'com-mail',         n: 'E-mailaccounts',       d: 'Postvakken die het systeem uitleest',                       ic: I.mail },
      { id: 'com-handtekening', n: 'E-mail-handtekeningen', d: 'Globale + per-mailbox handtekening (server-side aan mails toegevoegd)', ic: I.mail },
      { id: 'com-wa',           n: 'WhatsApp',             d: 'Meta-koppeling en goedgekeurde templates',                  ic: I.chat || I.mail },
      { id: 'com-tel',          n: 'Telefonie',            d: 'Voys-koppeling en belinstellingen',                         ic: I.phone },
      { id: 'com-sjabloon',     n: 'Berichtsjablonen',     d: 'E-mail-sjablonen voor compose/reply · lijst + editor',       ic: I.doc },
    ]},
    { g: 'Marketing', items: [
      { id: 'mk-meta',          n: 'Meta-koppeling',       d: 'Advertentieaccount en pixel',                               ic: I.target },
      { id: 'mk-bronnen',       n: 'Lead-bronnen',         d: 'Welke bronnen er zijn en hoe ze binnenkomen',               ic: I.target },
      { id: 'mk-sequenties',    n: 'Sequenties',           d: 'Automatische opvolging van leads',                          ic: I.repeat },
      { id: 'mk-webflow',       n: 'Webflow auto-publish', d: 'Na elke CMS-mutatie wordt deforexopleiding.nl gepublisht',  ic: I.link || I.settings },
    ]},
    { g: 'Team & toegang', items: [
      { id: 'team-gebruikers',  n: 'Gebruikers',           d: 'Wie heeft toegang tot het systeem',                         ic: I.users },
      { id: 'team-rechten',     n: 'Rollen en rechten',    d: 'Wat elke rol mag zien en doen',                             ic: I.shield },
      { id: 'team-mentoren',    n: 'Mentoren',             d: 'Toewijzing, beschikbaarheid en vergoedingen',               ic: I.grad },
      { id: 'team-api',         n: 'API-sleutels',         d: 'Koppelingen met externe systemen',                          ic: I.key || I.settings },
    ]},
    { g: 'Algemeen', items: [
      { id: 'alg-bedrijf',      n: 'Bedrijfsgegevens',     d: 'Naam, adres, logo en btw-nummer',                           ic: I.building || I.file },
      { id: 'alg-meldingen',    n: 'Meldingen',            d: 'Wat je wanneer wilt horen',                                 ic: I.bell || I.warn },
      { id: 'alg-weergave',     n: 'Weergave',             d: 'Thema, taal en datumnotatie',                               ic: I.eye || I.settings },
    ]},
    // v=3 — Systeem-groep. Items markeren met `roles: ['super_admin']`;
    // instView filtert die uit voor niet-super_admin (nav-level hide).
    // Body-gate op sys-followup-admin (isSuperAdmin) blijft als 2e laag,
    // en server-side gate op de endpoints blijft de laatste laag.
    { g: 'Systeem', items: [
      { id: 'sys-followup-admin', n: 'Follow-up admin-tools', d: 'Backfill GHL-contacts + GHL-status-backfill', ic: I.settings, roles: ['super_admin'] },
      { id: 'sys-bubble-schema',  n: 'Bubble-schema probe',   d: 'Lees keys+types van een Bubble-objecttype (read-only)', ic: I.settings, roles: ['super_admin'] },
    ]},
  ];

  // WhatsApp — templates (uit prototype r4248-4270).
  const WA_FOLDERS = [
    ['all',        'Alle templates',       I.list || I.doc, 'blue'],
    ['wanbetalers','Wanbetalers',          I.warn,          'amber'],
    ['onboarding', 'Onboarding',           I.route || I.check, 'emerald'],
    ['events',     'Events',               I.cal || I.clock, 'pink'],
    ['sales',      'Sales',                I.sales || I.trend, 'violet'],
    ['lisa',       'Lisa · Instagram',     I.bot,           'violet'],
    ['algemeen',   'Algemeen',             I.chat || I.mail, 'slate'],
  ];
  const WA_STAT = {
    goedgekeurd: { l: 'Goedgekeurd', c: 'ok' },
    in_review:   { l: 'In review',   c: 'warn' },
    afgewezen:   { l: 'Afgewezen',   c: 'warn' },
    concept:     { l: 'Concept',     c: 'neutral' },
  };
  const WA_TPL = [
    { cat: 'wanbetalers', n: 'Eerste herinnering (dag 3)',   taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, we zien dat factuur {{factuur.nr}} van {{factuur.bedrag}} nog openstaat. Je kunt eenvoudig betalen via {{betaallink}}. Alvast bedankt! — De Forex Opleiding', gebruikt: 342 },
    { cat: 'wanbetalers', n: 'Tweede herinnering (dag 7)',   taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je factuur {{factuur.nr}} is nog niet voldaan. Lukt betalen niet in één keer? Dan denken we graag mee over een regeling.', gebruikt: 198 },
    { cat: 'wanbetalers', n: 'Betaalregeling — voorstel',   taal: 'NL', status: 'in_review',   tekst: 'Hoi {{klant.voornaam}}, we kunnen {{factuur.bedrag}} in termijnen verdelen. Akkoord? Reageer met JA.', gebruikt: 0 },
    { cat: 'onboarding',  n: 'Welkom + intake plannen',     taal: 'NL', status: 'goedgekeurd', tekst: 'Welkom {{klant.voornaam}}! Plan je intake met {{mentor.naam}} via {{agendalink}}. Tot snel!', gebruikt: 87 },
    { cat: 'onboarding',  n: 'LMS-toegang verstuurd',       taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je toegang tot de leeromgeving staat klaar. Log in en zet de eerste stap!', gebruikt: 76 },
    { cat: 'events',      n: 'Bevestiging aanmelding',      taal: 'NL', status: 'goedgekeurd', tekst: 'Je bent aangemeld voor {{event.naam}} op {{event.datum}} om {{event.tijd}}. Tot dan!', gebruikt: 512 },
    { cat: 'events',      n: 'Herinnering — 1 dag vooraf',  taal: 'NL', status: 'goedgekeurd', tekst: 'Morgen is het zover: {{event.naam}}! We beginnen om {{event.tijd}}. Tot morgen!', gebruikt: 498 },
    { cat: 'events',      n: 'No-show opvolging',           taal: 'NL', status: 'afgewezen',   tekst: 'Jammer dat je er niet bij kon zijn bij {{event.naam}}. Aanmelden voor een volgende datum?', gebruikt: 0 },
    { cat: 'sales',       n: 'Offerte verstuurd',           taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je offerte {{offerte.nr}} staat klaar. Vragen? Ik hoor het graag!', gebruikt: 143 },
    { cat: 'sales',       n: 'Herinnering openstaande offerte', taal: 'NL', status: 'concept', tekst: 'Hoi {{klant.voornaam}}, heb je al kunnen kijken naar offerte {{offerte.nr}}?', gebruikt: 0 },
    { cat: 'lisa',        n: 'Instagram — eerste reactie',  taal: 'NL', status: 'goedgekeurd', tekst: 'Hey {{klant.voornaam}}! Leuk dat je reageert. Waar wil je graag meer over weten?', gebruikt: 820 },
    { cat: 'lisa',        n: 'Instagram — kennismakingscall', taal: 'NL', status: 'goedgekeurd', tekst: 'Top! Plan hier je gratis kennismakingscall: {{agendalink}}', gebruikt: 405 },
    { cat: 'algemeen',    n: 'Algemene begroeting',         taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, bedankt voor je bericht! We reageren zo snel mogelijk.', gebruikt: 63 },
  ];

  window.__setNotice = (l) => { console.info('[instellingen-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };
  // Ronde-31 v=53 FIX B: gedeelde helper voor "Zet eerst UIT"-disabled-knop
  // (ev-auto + mk-sequenties gebruikten hem eerst inline, nu 1 plek voor derde-
  // sectie-consistency). Toast-msg + tooltip. Retourneert HTML-string voor de knop.
  window.__setBlockedToast = (msg) => { showToast(msg, 'warn'); };
  function _disabledUitKnop(label, tooltipMsg, style) {
    return `<button class="btn btn-ghost btn-sm" onclick="window.__setBlockedToast('${esc(tooltipMsg)}')" title="${esc(tooltipMsg)}" style="${style || ''};opacity:.5;cursor:not-allowed">${esc(label)}</button>`;
  }
  window.__setPick = (id) => {
    if (!S) return;
    S.setPage = id;
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  };
  // Ronde-31 v=52 FIX 3 — cross-cutting nav-race. Eerste-klik na fresh render
  // pakte soms niet (per-item inline onclick handlers werden pas ná de eerste
  // paint effectief). Event-delegation op #content vangt elke klik onmiddellijk,
  // ook vóór de eerste re-render. Geen self-observing: puur event-dispatch,
  // muteert geen node dat we observeren. Idempotent-guard voorkomt dubbele bind.
  if (!window.__kvInstNavDelegationBound) {
    window.__kvInstNavDelegationBound = true;
    document.addEventListener('click', function (evt) {
      const btn = evt.target && evt.target.closest && evt.target.closest('[data-set-pick]');
      if (!btn) return;
      const id = btn.getAttribute('data-set-pick');
      if (!id) return;
      // Voorkom dat de bestaande inline onclick (backward-compat) hem ook triggert.
      evt.preventDefault();
      evt.stopPropagation();
      window.__setPick(id);
    }, true /* capture: vuurt vóór inline-handlers, elimineert race */);
  }

  function highlightVars(t) {
    return String(t || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\{\{([^}]+)\}\}/g, '<span class="wa-var">{{$1}}</span>')
      .replace(/\n/g, '<br>');
  }

  // ── Set-body per id ────────────────────────────────────────────────────
  /* Wave-4 · wb-workflows NATIVE (v=69) — dunning_workflows + _steps CRUD in-shell.
     HOOG RISICO: motor leest deze rijen live (detectAndStartRuns). Alleen bestaande
     config-endpoints: finance-dunning-workflows-list / -detail / -upsert / -delete /
     -toggle (gate finance.dunning.config voor writes; -view voor read).

     KRITIEK — step.id-behoud (FK dunning_log.step_id + dunning_workflow_runs.
     current_step_id). Bij PATCH sturen we ALTIJD de detail-fetch ids mee; save-
     payload weigert (client-side) als bestaande workflow zonder ids of leeg zou
     worden verstuurd (spiegelt server-guards REFUSE_EMPTY_PAYLOAD_ON_POPULATED_
     WORKFLOW en REFUSE_ID_LESS_STEPS_ON_POPULATED_WORKFLOW; server blijft harde
     bron).

     trigger_conditions: JSON-textarea met invalid-JSON-detectie (nul-risico
     ipv key/value-builder; keys uit detectAndStartRuns niet bekend zonder
     aparte discovery).

     Diff-based: steps met id → UPDATE; zonder id → INSERT nieuwe; ontbrekende
     bestaande ids → DELETE (FK SET NULL vangt log-refs). Reorder via ↑/↓;
     step.id blijft door hele bewerking bewaard. */
  const _wkf = {
    loading: false, fetched: false, error: null, items: [],
    busy: {},
    // Editor state
    ed: null,               // { id?, workflow, steps:[{id?, step_order, step_type, config}], _origStepIds: Set<string>, _origActive: bool, trigger_conditions_json: string, trigger_conditions_valid: bool, tcMode: 'builder'|'json', tcExtras: object }
    editorLoading: false, editorError: null,
    // Templates cache per kind — voor step template-picker.
    tpls: {
      email:    { loading: false, fetched: false, error: null, items: [] },
      whatsapp: { loading: false, fetched: false, error: null, items: [] },
    },
  };

  // Bekende motor-keys (gelezen door dunning-engine.js). Zie discovery-rapport
  // 2026-08-23. Alles buiten deze set = tcExtras (ongewijzigd bewaard).
  const WKF_TC_KNOWN = new Set(['min_days_overdue','min_days_since_invoice_date','customer_type','min_total_amount','arrangement_breached','run_once_per_customer_per_workflow']);

  // Splits trigger_conditions in known + extras.
  function _wkfSplitTc(tc) {
    const src = (tc && typeof tc === 'object' && !Array.isArray(tc)) ? tc : {};
    const known = {}; const extras = {};
    Object.keys(src).forEach((k) => { if (WKF_TC_KNOWN.has(k)) known[k] = src[k]; else extras[k] = src[k]; });
    return { known, extras };
  }
  // Bouw finale trigger_conditions uit builder-values + extras.
  // Alleen keys wegschrijven die door de user expliciet zijn gezet (of extras).
  // Dat voorkomt dat de builder ongevraagd defaults schrijft die de motor
  // anders zou hebben afgeleid (bv. min_days_overdue=14 als je min_days_since_
  // invoice_date gebruikt — motor schuift dan naar -1; zouden we 14 wegschrijven,
  // dan overrulen we die default-shift). Alleen numeric > default-schrijven
  // als user 'em echt heeft ingesteld.
  function _wkfBuildTc(b, extras) {
    const out = { ...(extras || {}) };
    if (b.arrangement_breached === true) out.arrangement_breached = true;
    if (b.run_once_per_customer_per_workflow === true) out.run_once_per_customer_per_workflow = true;
    if (b.customer_type && b.customer_type !== 'any') out.customer_type = b.customer_type;
    // Numeric: schrijf alleen als user 'em heeft ingevuld (niet null en niet lege string).
    if (b.min_days_overdue != null && b.min_days_overdue !== '') {
      const n = Number(b.min_days_overdue); if (Number.isFinite(n)) out.min_days_overdue = n;
    }
    if (b.min_days_since_invoice_date != null && b.min_days_since_invoice_date !== '') {
      const n = Number(b.min_days_since_invoice_date); if (Number.isFinite(n) && n >= 0) out.min_days_since_invoice_date = n;
    }
    if (b.min_total_amount != null && b.min_total_amount !== '') {
      const n = Number(b.min_total_amount); if (Number.isFinite(n) && n >= 0) out.min_total_amount = n;
    }
    return out;
  }
  // Preview-tekst: beschrijft wie de workflow matcht in gewone taal.
  function _wkfTcPreview(tc) {
    const has = (k) => tc[k] !== undefined && tc[k] !== null && tc[k] !== '';
    const brk = tc.arrangement_breached === true;
    const sinceInv = has('min_days_since_invoice_date') ? Number(tc.min_days_since_invoice_date) : null;
    const overdue  = has('min_days_overdue') ? Number(tc.min_days_overdue) : null;
    const defaultShifted = (sinceInv !== null) || brk;
    const effOverdue = overdue !== null ? overdue : (defaultShifted ? -1 : 14);
    const ct = tc.customer_type || 'any';
    const minEur = has('min_total_amount') ? Number(tc.min_total_amount) : 0;
    const runOnce = tc.run_once_per_customer_per_workflow === true;
    const parts = [];
    if (brk) parts.push('waarvan de <b>betaalafspraak verbroken</b> is (en onbeheerd blijft)');
    if (sinceInv !== null) parts.push(`waar de oudste factuur <b>≥ ${sinceInv} dagen</b> geleden is opgemaakt`);
    if (effOverdue >= 0) parts.push(`met ≥ 1 factuur <b>≥ ${effOverdue} dagen overdue</b>`);
    else parts.push('ongeacht overdue-status');
    if (minEur > 0) parts.push(`met totaal openstaand <b>≥ €${minEur}</b>`);
    if (ct === 'b2b') parts.push('van type <b>zakelijk (b2b)</b>');
    else if (ct === 'b2c') parts.push('van type <b>particulier (b2c)</b>');
    let s = 'Matcht klanten ' + parts.join(', ');
    if (runOnce) s += ' — <b>éénmalig per klant</b>';
    s += '.';
    return s;
  }

  async function fetchWf() {
    if (_wkf.loading || _wkf.fetched) return;
    _wkf.loading = true; _wkf.error = null; if (render) render();
    const j = await tryFetch('wf-list', '/api/finance-dunning-workflows-list');
    _wkf.loading = false; _wkf.fetched = true;
    if (j?.__error) _wkf.error = j.__error;
    else _wkf.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  async function fetchWfTpls(kind) {
    const st = _wkf.tpls[kind]; if (!st || st.loading || st.fetched) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('wf-tpls-' + kind, '/api/finance-dunning-templates-list?kind=' + encodeURIComponent(kind) + '&active=true');
    st.loading = false; st.fetched = true;
    if (j?.__error) st.error = j.__error;
    else st.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }

  // Sync-from-DOM: leest alle editor-inputs in _wkf.ed vóór save/structural
  // render. Bewaart step.id (uncontrolled, niet in DOM — blijft in state).
  function _wfSyncFromDom() {
    const e = _wkf.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    const qa = (sel) => Array.from(document.querySelectorAll(sel));
    const n  = q('[data-wf-field="name"]');            if (n)  e.workflow.name = String(n.value || '');
    const d  = q('[data-wf-field="description"]');     if (d)  e.workflow.description = String(d.value || '');
    const p  = q('[data-wf-field="priority"]');        if (p)  e.workflow.priority = Number(p.value || 100);
    const a  = q('[data-wf-field="is_active"]');       if (a)  e.workflow.is_active = !!a.checked;
    if (e.tcMode === 'json') {
      const tc = q('[data-wf-field="trigger_conditions"]');
      if (tc) {
        e.trigger_conditions_json = String(tc.value || '');
        const raw = e.trigger_conditions_json.trim();
        if (!raw) { e.workflow.trigger_conditions = {}; e.trigger_conditions_valid = true; e.tcExtras = {}; }
        else {
          try {
            const parsed = JSON.parse(raw);
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
              e.workflow.trigger_conditions = parsed; e.trigger_conditions_valid = true;
              // Re-splits extras zodat een builder-flip meteen consistent is.
              const sp = _wkfSplitTc(parsed); e.tcExtras = sp.extras;
            } else { e.trigger_conditions_valid = false; }
          } catch (_) { e.trigger_conditions_valid = false; }
        }
      }
    } else {
      // Builder-mode: lees 6 inputs, bouw tc met extras behouden.
      const b = {};
      const mdo  = q('[data-wf-tc="min_days_overdue"]');            if (mdo)  b.min_days_overdue = mdo.value;
      const msi  = q('[data-wf-tc="min_days_since_invoice_date"]'); if (msi)  b.min_days_since_invoice_date = msi.value;
      const ct   = q('[data-wf-tc="customer_type"]');               if (ct)   b.customer_type = String(ct.value || 'any');
      const mta  = q('[data-wf-tc="min_total_amount"]');            if (mta)  b.min_total_amount = mta.value;
      const brk  = q('[data-wf-tc="arrangement_breached"]');        if (brk)  b.arrangement_breached = !!brk.checked;
      const ronc = q('[data-wf-tc="run_once_per_customer_per_workflow"]'); if (ronc) b.run_once_per_customer_per_workflow = !!ronc.checked;
      e.workflow.trigger_conditions = _wkfBuildTc(b, e.tcExtras || {});
      e.trigger_conditions_valid = true;
      e.trigger_conditions_json = JSON.stringify(e.workflow.trigger_conditions, null, 2);
    }
    // Per-step velden — id blijft in state (uncontrolled), lees alleen editable velden.
    qa('[data-wf-step-idx]').forEach((row) => {
      const idx = Number(row.getAttribute('data-wf-step-idx'));
      if (!Number.isInteger(idx) || !e.steps[idx]) return;
      const st = e.steps[idx];
      const typeEl = row.querySelector('[data-wf-step-field="step_type"]');
      if (typeEl) st.step_type = String(typeEl.value || 'wait');
      const cfg = st.config = st.config || {};
      if (st.step_type === 'email' || st.step_type === 'whatsapp') {
        const tplEl = row.querySelector('[data-wf-step-field="template_id"]');
        if (tplEl) cfg.template_id = String(tplEl.value || '') || null;
      } else if (st.step_type === 'wait') {
        const dEl = row.querySelector('[data-wf-step-field="days"]');
        if (dEl) cfg.days = Number(dEl.value || 0);
      } else if (st.step_type === 'task') {
        const ttl = row.querySelector('[data-wf-step-field="title"]');
        if (ttl) cfg.title = String(ttl.value || '');
        const desc = row.querySelector('[data-wf-step-field="description"]');
        if (desc) cfg.description = String(desc.value || '');
      }
    });
  }

  window.__setWkfNew = () => {
    _wkf.ed = {
      id: null,
      workflow: { name: '', description: '', is_active: false, priority: 100, trigger_conditions: {} },
      steps: [],
      _origStepIds: new Set(),
      _origActive: false,
      trigger_conditions_json: '{}',
      trigger_conditions_valid: true,
      tcMode: 'builder',
      tcExtras: {},
    };
    fetchWfTpls('email'); fetchWfTpls('whatsapp');
    if (render) render();
  };
  window.__setWkfEdit = async (id) => {
    _wkf.editorLoading = true; _wkf.editorError = null;
    _wkf.ed = {
      id, workflow: { name: '', description: '', is_active: false, priority: 100, trigger_conditions: {} },
      steps: [], _origStepIds: new Set(), _origActive: false,
      trigger_conditions_json: '{}', trigger_conditions_valid: true,
      tcMode: 'builder', tcExtras: {},
    };
    if (render) render();
    const j = await tryFetch('wf-detail', '/api/finance-dunning-workflows-detail?id=' + encodeURIComponent(id));
    _wkf.editorLoading = false;
    if (j?.__error || j?.error) {
      _wkf.editorError = j?.__error || j?.error;
      if (render) render(); return;
    }
    const wf = j?.workflow || {};
    const steps = Array.isArray(j?.steps) ? j.steps : [];
    _wkf.ed.workflow = {
      name: wf.name || '', description: wf.description || '',
      is_active: !!wf.is_active, priority: Number(wf.priority || 100),
      trigger_conditions: (wf.trigger_conditions && typeof wf.trigger_conditions === 'object') ? wf.trigger_conditions : {},
    };
    // Behoud id per step — deep-copy zodat editor-mutaties het detail-cache niet muteren.
    _wkf.ed.steps = steps.map((s) => ({
      id: s.id, step_order: Number(s.step_order || 0), step_type: s.step_type || 'wait',
      config: JSON.parse(JSON.stringify(s.config || {})),
    }));
    _wkf.ed._origStepIds = new Set(steps.map((s) => s.id).filter(Boolean));
    _wkf.ed._origActive = !!wf.is_active;
    _wkf.ed.trigger_conditions_json = JSON.stringify(_wkf.ed.workflow.trigger_conditions, null, 2);
    _wkf.ed.trigger_conditions_valid = true;
    // Splits bestaande trigger_conditions in bekende builder-keys + extras
    // (bv. legacy dead-key `min_amount` uit v1-editor). Extras blijven ongewijzigd
    // in de payload; de builder toont een pill die ze benoemt.
    const _sp = _wkfSplitTc(_wkf.ed.workflow.trigger_conditions);
    _wkf.ed.tcExtras = _sp.extras;
    // Als er extras zijn: start in JSON-mode zodat user 'em direct ziet + kan
    // beslissen. Anders default builder-mode.
    _wkf.ed.tcMode = Object.keys(_sp.extras).length ? 'json' : 'builder';
    fetchWfTpls('email'); fetchWfTpls('whatsapp');
    if (render) render();
  };
  window.__setWkfCancel = () => { _wkf.ed = null; _wkf.editorError = null; if (render) render(); };

  // Step-lijst mutaties — sync-from-DOM VOOR elke mutatie zodat lopende
  // veldwaardes bewaard blijven; dan structural render.
  window.__setWkfStepAdd = () => {
    if (!_wkf.ed) return;
    _wfSyncFromDom();
    const nextOrder = _wkf.ed.steps.length
      ? (Math.max(..._wkf.ed.steps.map((s) => Number(s.step_order || 0))) + 1)
      : 0;
    _wkf.ed.steps.push({ id: null, step_order: nextOrder, step_type: 'wait', config: { days: 1 } });
    if (render) render();
  };
  window.__setWkfStepRemove = (idx) => {
    if (!_wkf.ed || !_wkf.ed.steps[idx]) return;
    _wfSyncFromDom();
    const st = _wkf.ed.steps[idx];
    // Confirm alleen als het een bestaande step is (heeft id) — nieuwe steps zonder id = veilig weg te halen.
    if (st.id) {
      openConfirm(`Stap ${idx + 1} (${esc(st.step_type)}) verwijderen? Bestaande log-referenties naar deze stap worden bij save losgekoppeld (FK SET NULL).`, () => {
        _wkf.ed.steps.splice(idx, 1);
        _wfRenumberOrders();
        if (render) render();
      }, 'warn');
    } else {
      _wkf.ed.steps.splice(idx, 1);
      _wfRenumberOrders();
      if (render) render();
    }
  };
  window.__setWkfStepMove = (idx, dir) => {
    if (!_wkf.ed) return;
    _wfSyncFromDom();
    const to = idx + dir;
    if (to < 0 || to >= _wkf.ed.steps.length) return;
    const arr = _wkf.ed.steps;
    [arr[idx], arr[to]] = [arr[to], arr[idx]];
    _wfRenumberOrders();
    if (render) render();
  };
  function _wfRenumberOrders() {
    if (!_wkf.ed) return;
    _wkf.ed.steps.forEach((s, i) => { s.step_order = i; });
  }
  window.__setWkfStepTypeChange = (idx) => {
    if (!_wkf.ed) return;
    _wfSyncFromDom();
    const st = _wkf.ed.steps[idx]; if (!st) return;
    // Reset config on type-switch — voorkomt vervuilde config (bv. days-veld
    // op een email-step blijft anders in payload staan; server valideert kind
    // maar cleaner om het hier weg te halen).
    if (st.step_type === 'email' || st.step_type === 'whatsapp') st.config = { template_id: null };
    else if (st.step_type === 'wait') st.config = { days: 1 };
    else if (st.step_type === 'task') st.config = { title: '', description: '' };
    else st.config = {};
    if (render) render();
  };

  window.__setWkfSave = async () => {
    if (!_wkf.ed) return;
    _wfSyncFromDom();
    const e = _wkf.ed;
    if (!e.workflow.name.trim()) return showToast('Naam is verplicht', 'warn');
    if (!Number.isInteger(Number(e.workflow.priority))) return showToast('Priority moet integer zijn', 'warn');
    if (!e.trigger_conditions_valid) return showToast('trigger_conditions bevat ongeldige JSON — corrigeer eerst', 'warn');

    // Per-step validatie (spiegel van server-validateSteps).
    for (let i = 0; i < e.steps.length; i++) {
      const s = e.steps[i];
      const lbl = 'Stap ' + (i + 1);
      if (!['email','whatsapp','wait','task','stop'].includes(s.step_type)) return showToast(lbl + ': type ongeldig', 'warn');
      if ((s.step_type === 'email' || s.step_type === 'whatsapp') && !s.config?.template_id) return showToast(lbl + ': kies een template', 'warn');
      if (s.step_type === 'wait' && (!Number.isInteger(Number(s.config?.days)) || Number(s.config.days) < 0)) return showToast(lbl + ': days moet integer >= 0', 'warn');
      if (s.step_type === 'task' && !String(s.config?.title || '').trim()) return showToast(lbl + ': title vereist', 'warn');
    }

    // CLIENT-GUARDS spiegelen server-guards (voordat POST vertrekt).
    // Bij UPDATE met bestaande steps in DB (uit detail-fetch):
    const isUpdate = !!e.id;
    const hadExisting = e._origStepIds && e._origStepIds.size > 0;
    if (isUpdate && hadExisting) {
      if (e.steps.length === 0) {
        return showToast('Kan niet opslaan: workflow heeft ' + e._origStepIds.size + ' bestaande stappen en payload is leeg. (server-guard REFUSE_EMPTY_PAYLOAD_ON_POPULATED_WORKFLOW)', 'warn');
      }
      const withIdCount = e.steps.filter((s) => s.id).length;
      if (withIdCount === 0) {
        return showToast('Kan niet opslaan: workflow heeft ' + e._origStepIds.size + ' bestaande stappen, maar payload bevat geen enkele step-id. Ververs de editor. (server-guard REFUSE_ID_LESS_STEPS_ON_POPULATED_WORKFLOW)', 'warn');
      }
    }

    const doSave = async () => {
      const key = e.id || 'new';
      _wkf.busy[key] = true; if (render) render();
      try {
        const payload = {
          workflow: {
            name: e.workflow.name.trim(),
            description: e.workflow.description?.trim() || null,
            is_active: !!e.workflow.is_active,
            priority: Number(e.workflow.priority),
            trigger_conditions: e.workflow.trigger_conditions,
          },
          steps: e.steps.map((s) => ({
            id: s.id || undefined,  // undefined → server ziet 'ontbreekt' = insert
            step_order: Number(s.step_order),
            step_type: s.step_type,
            config: s.config || {},
          })),
        };
        const url = '/api/finance-dunning-workflows-upsert' + (isUpdate ? '?id=' + encodeURIComponent(e.id) : '');
        const j = await tryFetch('wf-save', url, {
          method: isUpdate ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wkf.ed = null; _wkf.fetched = false; fetchWf();
        showToast(isUpdate ? 'Workflow bijgewerkt' : 'Workflow aangemaakt', 'ok');
      } catch (err) {
        showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn');
      } finally { _wkf.busy[key] = false; if (render) render(); }
    };

    // Custom confirm bij actieve workflow (bestaande of nieuwe die actief opgeslagen wordt).
    if (isUpdate && e._origActive) {
      const activeRuns = (_wkf.items.find((x) => x.id === e.id)?.active_run_count) || 0;
      const runsWarn = activeRuns > 0
        ? ` <b>${activeRuns}</b> lopende run${activeRuns === 1 ? '' : 's'} blijft op de oude versie hangen — nieuwe runs pakken de nieuwe stappen.`
        : '';
      openConfirm(`Actieve workflow "${esc(e.workflow.name)}" opslaan? Nieuwe dunning-runs vanaf nu gebruiken deze versie direct.${runsWarn}`, doSave, 'warn');
    } else if (e.workflow.is_active) {
      openConfirm(`Workflow "${esc(e.workflow.name)}" opslaan ALS ACTIEF? Nieuwe dunning-runs gebruiken deze workflow vanaf nu.`, doSave, 'warn');
    } else {
      doSave();
    }
  };
  window.__setWkfToggle = (id) => {
    const it = _wkf.items.find((x) => x.id === id); if (!it) return;
    const goingActive = !it.is_active;
    const activeRuns = it.active_run_count || 0;
    const runsWarn = (!goingActive && activeRuns > 0)
      ? ` ${activeRuns} lopende run${activeRuns === 1 ? '' : 's'} pauzeert niet — die lopen door.`
      : '';
    const msg = goingActive
      ? `Workflow "${esc(it.name)}" ACTIVEREN? Nieuwe dunning-runs vanaf nu gebruiken deze workflow.`
      : `Workflow "${esc(it.name)}" op INACTIEF zetten? Nieuwe runs skippen deze workflow.${runsWarn}`;
    openConfirm(msg, async () => {
      _wkf.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('wf-toggle', '/api/finance-dunning-workflows-toggle?id=' + encodeURIComponent(id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: goingActive }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wkf.fetched = false; fetchWf();
        showToast(goingActive ? 'Workflow geactiveerd' : 'Workflow gedeactiveerd', 'ok');
      } catch (err) { showToast('Toggle mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _wkf.busy[id] = false; if (render) render(); }
    }, goingActive ? 'warn' : 'info');
  };
  window.__setWkfDelete = (id) => {
    const it = _wkf.items.find((x) => x.id === id); if (!it) return;
    if (it.is_active) return showToast('Deactiveer workflow eerst vóór verwijderen', 'warn');
    if ((it.active_run_count || 0) > 0) return showToast('Workflow heeft ' + it.active_run_count + ' lopende runs — kan niet verwijderen', 'warn');
    openConfirm(`Workflow "${esc(it.name)}" PERMANENT verwijderen? Server-check kan blokkeren als er nog historische runs of stappen aan hangen.`, async () => {
      _wkf.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('wf-del', '/api/finance-dunning-workflows-delete?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wkf.fetched = false; fetchWf();
        showToast('Workflow verwijderd', 'ok');
      } catch (err) { showToast('Verwijderen mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _wkf.busy[id] = false; if (render) render(); }
    }, 'warn');
  };

  // Mode-switch builder ⇄ json. Sync eerst (behoudt current input-waardes),
  // dan flip de mode + re-render. Bij switch naar json: serialize huidige
  // gecombineerde state; bij switch naar builder: split extras opnieuw uit.
  window.__setWkfTcMode = (mode) => {
    if (!_wkf.ed || (mode !== 'builder' && mode !== 'json')) return;
    _wfSyncFromDom();  // v=71 blocker-fix: helper heet _wfSyncFromDom (bulk-rename miste 'em)
    if (mode === 'json') {
      _wkf.ed.trigger_conditions_json = JSON.stringify(_wkf.ed.workflow.trigger_conditions || {}, null, 2);
      _wkf.ed.trigger_conditions_valid = true;
    } else {
      const sp = _wkfSplitTc(_wkf.ed.workflow.trigger_conditions);
      _wkf.ed.tcExtras = sp.extras;
    }
    _wkf.ed.tcMode = mode;
    if (render) render();
  };
  // Live preview-refresh in builder-mode — freeze-veilig (in-place update van
  // preview-strip + warnings; geen full re-render).
  window.__setWkfTcBuilderInput = () => {
    try {
      if (!_wkf.ed || _wkf.ed.tcMode !== 'builder') return;
      _wfSyncFromDom();  // v=71 blocker-fix: update workflow.trigger_conditions via bestaande sync-helper
      const tc = _wkf.ed.workflow.trigger_conditions || {};
      const prev = document.querySelector('[data-wf-tc-preview="1"]');
      if (prev) prev.innerHTML = _wkfTcPreview(tc);
      // Warning: run_once=true zonder breach én zonder min_days_since_invoice_date.
      const runOnceUnsafe = tc.run_once_per_customer_per_workflow === true
        && !tc.arrangement_breached
        && (tc.min_days_since_invoice_date == null);
      const warnEl = document.querySelector('[data-wf-tc-warn="run_once"]');
      if (warnEl) warnEl.style.display = runOnceUnsafe ? '' : 'none';
      // Default-shift note: als min_days_since_invoice_date OF arrangement_breached gezet.
      const shifted = (tc.min_days_since_invoice_date != null) || (tc.arrangement_breached === true);
      const shiftEl = document.querySelector('[data-wf-tc-note="default_shift"]');
      if (shiftEl) shiftEl.style.display = shifted ? '' : 'none';
    } catch (_) { /* fail-soft */ }
  };
  // Live invalid-JSON hint update — freeze-veilig (in-place tekst + kleur).
  window.__setWkfTcInput = (ta) => {
    try {
      if (!_wkf.ed) return;
      const raw = String(ta?.value || '').trim();
      let ok = true;
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          ok = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed));
        } catch (_) { ok = false; }
      }
      const badge = document.querySelector('[data-wf-tc-badge="1"]');
      if (!badge) return;
      if (badge.getAttribute('data-ok') === (ok ? '1' : '0')) return;
      badge.setAttribute('data-ok', ok ? '1' : '0');
      badge.style.background = ok ? 'var(--emerald-soft)' : 'var(--rose-soft)';
      badge.style.color      = ok ? 'var(--emerald)'      : 'var(--rose)';
      badge.textContent = ok ? '✓ Geldige JSON (object)' : '⚠ Ongeldige JSON — save geblokkeerd';
    } catch (_) { /* fail-soft */ }
  };

  function _wfStepRow(idx, s) {
    const kind = s.step_type;
    const isTpl = kind === 'email' || kind === 'whatsapp';
    const tplState = isTpl ? _wkf.tpls[kind] : null;
    const tpls = isTpl && tplState ? tplState.items : [];
    const curId = s.config?.template_id || '';
    const inList = isTpl && tpls.some((t) => t.id === curId);
    const fallbackOpt = (isTpl && curId && !inList)
      ? `<option value="${esc(curId)}" selected>${esc(curId)} — id bestaat niet in actieve ${esc(kind)}-lijst</option>` : '';
    return `<div data-wf-step-idx="${idx}" style="display:grid;grid-template-columns:auto 80px 1fr auto;gap:8px;align-items:start;padding:8px;background:var(--surface-2);border-radius:6px;margin-bottom:6px">
      <div style="display:flex;flex-direction:column;gap:2px;padding-top:4px">
        <button class="btn btn-ghost btn-sm" onclick="window.__setWkfStepMove(${idx},-1)" title="Omhoog" style="padding:2px 6px;font-size:10px" ${idx === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__setWkfStepMove(${idx},1)" title="Omlaag" style="padding:2px 6px;font-size:10px" ${idx === _wkf.ed.steps.length - 1 ? 'disabled' : ''}>▼</button>
      </div>
      <div>
        <div style="font-size:10px;color:var(--text-3);margin-bottom:2px">#${idx + 1}${s.id ? ' · <span style="font-family:\'IBM Plex Mono\',monospace" title="step.id (FK dunning_log.step_id)">' + esc(String(s.id).slice(0,6)) + '…</span>' : ' · <span style="color:var(--amber)" title="Nieuw — krijgt id bij save">nieuw</span>'}</div>
        <select data-wf-step-field="step_type" onchange="window.__setWkfStepTypeChange(${idx})" style="width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11.5px;box-sizing:border-box">
          ${['email','whatsapp','wait','task','stop'].map((t) => `<option value="${t}" ${kind === t ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div style="min-width:0">
        ${isTpl ? (
          tplState?.error
            ? `<input type="text" data-wf-step-field="template_id" value="${esc(curId)}" placeholder="template UUID" style="width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11.5px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
               <div style="font-size:10px;color:var(--rose);margin-top:2px">${esc(kind)}-templates niet geladen: ${esc(tplState.error)} — vul UUID handmatig</div>`
            : `<select data-wf-step-field="template_id" style="width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11.5px;box-sizing:border-box">
                 <option value="" ${!curId ? 'selected' : ''}>— kies actieve ${esc(kind)}-template —</option>
                 ${fallbackOpt}
                 ${tpls.map((t) => `<option value="${esc(t.id)}" ${curId === t.id ? 'selected' : ''}>${esc(t.name)} (${esc(t.language || 'nl')})</option>`).join('')}
               </select>
               <div style="font-size:10px;color:var(--text-3);margin-top:2px">${tpls.length} actieve ${esc(kind)}-templates${tplState?.loading ? ' · laden…' : ''}</div>`
        ) : ''}
        ${kind === 'wait' ? `
          <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px">Wacht (dagen)</label>
          <input type="number" data-wf-step-field="days" min="0" value="${esc(String(s.config?.days ?? 1))}" style="width:100px;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11.5px;box-sizing:border-box" />
        ` : ''}
        ${kind === 'task' ? `
          <input type="text" data-wf-step-field="title" value="${esc(s.config?.title || '')}" placeholder="Task title" style="width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11.5px;box-sizing:border-box;margin-bottom:4px" />
          <textarea data-wf-step-field="description" placeholder="Description (optioneel)" style="width:100%;padding:5px 7px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:11px;box-sizing:border-box;min-height:40px;font-family:inherit;resize:vertical">${esc(s.config?.description || '')}</textarea>
        ` : ''}
        ${kind === 'stop' ? `<div style="font-size:11px;color:var(--text-3);padding:5px 0">Terminal-step (geen config)</div>` : ''}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="window.__setWkfStepRemove(${idx})" style="color:var(--rose);font-size:11px;align-self:flex-start" title="Stap verwijderen">✕</button>
    </div>`;
  }

  // Trigger-conditions sectie — builder ⇄ raw JSON. Extras (onbekende keys)
  // blijven altijd bewaard; in builder-mode toon 'em als amber pill.
  function _wkfTcSectionHtml(e, tcBadgeOk) {
    const mode = e.tcMode || 'builder';
    const tc = e.workflow.trigger_conditions || {};
    const bTab = (name, lbl) => `<button class="btn ${mode === name ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__setWkfTcMode('${name}')" style="font-size:10.5px;padding:3px 10px">${esc(lbl)}</button>`;
    const extrasKeys = Object.keys(e.tcExtras || {});
    const extrasPill = extrasKeys.length
      ? `<div style="margin-top:4px;padding:6px 10px;background:var(--amber-soft);color:var(--amber);border-radius:4px;font-size:10.5px;line-height:1.5">
           ⚠ Onbekende key(s) gedetecteerd: <code>${extrasKeys.map((k) => esc(k)).join('</code>, <code>')}</code>.
           Deze worden door de motor <b>NIET</b> gelezen (bv. legacy <code>min_amount</code> uit de oude v1-editor).
           Ze blijven ongewijzigd bewaard in de payload — verwijderen kan alleen via de rauwe JSON-tab.
         </div>` : '';
    const shiftNoteStyle = ((tc.min_days_since_invoice_date != null) || (tc.arrangement_breached === true)) ? '' : 'display:none';
    const runOnceUnsafe = tc.run_once_per_customer_per_workflow === true && !tc.arrangement_breached && tc.min_days_since_invoice_date == null;
    const runOnceWarnStyle = runOnceUnsafe ? '' : 'display:none';
    const cur = {
      min_days_overdue: tc.min_days_overdue,
      min_days_since_invoice_date: tc.min_days_since_invoice_date,
      customer_type: tc.customer_type || 'any',
      min_total_amount: tc.min_total_amount,
      arrangement_breached: tc.arrangement_breached === true,
      run_once_per_customer_per_workflow: tc.run_once_per_customer_per_workflow === true,
    };
    return `<div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <label style="font-size:11px;color:var(--text-3);font-weight:600">Trigger conditions</label>
        <div style="margin-left:auto;display:flex;gap:4px">${bTab('builder','🧱 Builder')}${bTab('json','⟨⟩ Rauwe JSON')}</div>
      </div>
      ${extrasPill}
      ${mode === 'builder' ? `
        <div style="padding:12px;background:var(--surface-2);border-radius:6px;display:flex;flex-direction:column;gap:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px" title="Minimaal aantal dagen dat een factuur overdue moet zijn om te triggeren. Default: 14 (of -1 als min_days_since_invoice_date of arrangement_breached is gezet).">Min. dagen overdue <span style="color:var(--text-3)">(int)</span></label>
              <input type="number" data-wf-tc="min_days_overdue" oninput="window.__setWkfTcBuilderInput()" value="${cur.min_days_overdue != null ? esc(String(cur.min_days_overdue)) : ''}" placeholder="leeg = default 14" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box" />
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px" title="Optioneel — voor pre-vervaldatum-duwtjes. Als gezet, matcht op ouderdom van issue-datum (niet overdue).">Min. dagen sinds factuurdatum <span style="color:var(--text-3)">(int, opt)</span></label>
              <input type="number" data-wf-tc="min_days_since_invoice_date" oninput="window.__setWkfTcBuilderInput()" value="${cur.min_days_since_invoice_date != null ? esc(String(cur.min_days_since_invoice_date)) : ''}" placeholder="leeg = uit" min="0" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box" />
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px" title="Filter op klanttype: any = alle, b2b = zakelijk (is_company=true of company_name gevuld), b2c = particulier.">Klanttype</label>
              <select data-wf-tc="customer_type" onchange="window.__setWkfTcBuilderInput()" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box">
                <option value="any" ${cur.customer_type === 'any' ? 'selected' : ''}>any (alle klanten)</option>
                <option value="b2b" ${cur.customer_type === 'b2b' ? 'selected' : ''}>b2b (zakelijk)</option>
                <option value="b2c" ${cur.customer_type === 'b2c' ? 'selected' : ''}>b2c (particulier)</option>
              </select>
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-2);display:block;margin-bottom:3px" title="Totaal openstaand bedrag (EUR) dat de klant minimaal open moet hebben. Default: 0 (uit).">Min. totaal openstaand <span style="color:var(--text-3)">(€)</span></label>
              <input type="number" data-wf-tc="min_total_amount" oninput="window.__setWkfTcBuilderInput()" value="${cur.min_total_amount != null ? esc(String(cur.min_total_amount)) : ''}" placeholder="leeg = 0" min="0" step="0.01" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text);font-size:12px;box-sizing:border-box" />
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none" title="Workflow vuurt UITSLUITEND voor klanten met een verbroken betaalafspraak (payment_arrangement.status='VERBROKEN' + breach_handled_at IS NULL). Zet automatisch min_days_overdue-default op -1.">
            <input type="checkbox" data-wf-tc="arrangement_breached" onchange="window.__setWkfTcBuilderInput()" ${cur.arrangement_breached ? 'checked' : ''} />
            <span>Alleen bij <b>verbroken betaalafspraak</b> — event-gedreven (schuift min-days-overdue-default naar -1)</span>
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;user-select:none" title="Skip als er al een run voor deze klant + workflow bestaat (ongeacht status). Bedoeld voor éénmalige duwtjes zoals de dag-7-herinnering.">
            <input type="checkbox" data-wf-tc="run_once_per_customer_per_workflow" onchange="window.__setWkfTcBuilderInput()" ${cur.run_once_per_customer_per_workflow ? 'checked' : ''} />
            <span>Precies <b>1× per klant</b> — skip als er al ooit een run bestaat (ongeacht status)</span>
          </label>

          <div data-wf-tc-note="default_shift" style="${shiftNoteStyle};padding:6px 10px;background:var(--sky-soft,#e0f2fe);color:var(--sky,#0369a1);border-radius:4px;font-size:10.5px;line-height:1.5">
            ℹ Default-shift actief: min_days_overdue-default is nu <b>-1</b> (motor negeert de 14-dagen-default) omdat 'sinds factuurdatum' of 'verbroken betaalafspraak' de trigger is.
          </div>
          <div data-wf-tc-warn="run_once" style="${runOnceWarnStyle};padding:6px 10px;background:var(--amber-soft);color:var(--amber);border-radius:4px;font-size:10.5px;line-height:1.5">
            ⚠ <b>run_once=true</b> zonder breach-trigger of factuurdatum-filter: elke matchende klant krijgt <b>precies 1× ooit</b> deze workflow — daarna nooit meer, zelfs bij nieuwe facturen. Bewust?
          </div>

          <div data-wf-tc-preview="1" style="margin-top:4px;padding:8px 10px;background:var(--emerald-soft);color:var(--emerald);border-radius:4px;font-size:11px;line-height:1.5">${_wkfTcPreview(tc)}</div>
        </div>
      ` : `
        <textarea data-wf-field="trigger_conditions" oninput="window.__setWkfTcInput(this)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:11.5px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box;min-height:120px;resize:vertical">${esc(e.trigger_conditions_json)}</textarea>
        <div data-wf-tc-badge="1" data-ok="${tcBadgeOk ? '1' : '0'}" style="margin-top:4px;padding:4px 8px;background:${tcBadgeOk ? 'var(--emerald-soft)' : 'var(--rose-soft)'};color:${tcBadgeOk ? 'var(--emerald)' : 'var(--rose)'};border-radius:4px;font-size:10.5px;display:inline-block">${tcBadgeOk ? '✓ Geldige JSON (object)' : '⚠ Ongeldige JSON — save geblokkeerd'}</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:3px">Rauwe JSON — voor onbekende keys of debugging. Bekende motor-keys: <code>min_days_overdue</code>, <code>min_days_since_invoice_date</code>, <code>customer_type</code>, <code>min_total_amount</code>, <code>arrangement_breached</code>, <code>run_once_per_customer_per_workflow</code>. Zie discovery-rapport.</div>
      `}
    </div>`;
  }

  function _wfEditorHtml() {
    const e = _wkf.ed; if (!e) return '';
    const isNew = !e.id;
    const key = e.id || 'new';
    const busy = !!_wkf.busy[key];
    if (_wkf.editorLoading) {
      return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:24px;font-size:13px">Editor laden…</div>
      </div>`;
    }
    if (_wkf.editorError) {
      return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setWkfCancel()">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;max-width:400px">
          <div style="font-size:13px;color:var(--rose);margin-bottom:10px">⚠ ${esc(_wkf.editorError)}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setWkfCancel()">Sluiten</button>
        </div>
      </div>`;
    }
    const tcBadgeOk = e.trigger_conditions_valid;
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setWkfCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(880px,100%);max-height:92vh;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);gap:10px">
          <div style="font-size:14px;font-weight:600">${isNew ? 'Nieuwe dunning-workflow' : 'Workflow bewerken: ' + esc(e.workflow.name)}</div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__setWkfCancel()">✕</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;flex:1">
          <div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:11px;line-height:1.5">
            <b>⚠ INCASSO-ZONE.</b> Deze workflow stuurt de dunning-motor rechtstreeks aan. Wijzigingen raken nieuwe runs direct; lopende runs blijven op de oude versie.
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">
            <div>
              <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Naam</label>
              <input type="text" data-wf-field="name" value="${esc(e.workflow.name)}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
            </div>
            <div>
              <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Priority (int, lager = eerder)</label>
              <input type="number" data-wf-field="priority" value="${esc(String(e.workflow.priority))}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
            </div>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Description</label>
            <input type="text" data-wf-field="description" value="${esc(e.workflow.description || '')}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
          </div>
          ${_wkfTcSectionHtml(e, tcBadgeOk)}
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;user-select:none">
            <input type="checkbox" data-wf-field="is_active" ${e.workflow.is_active ? 'checked' : ''} />
            <span>Actief — nieuwe dunning-runs gebruiken deze workflow</span>
          </label>

          <div style="border-top:1px solid var(--border);padding-top:12px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <div style="font-size:12.5px;font-weight:600">Stappen (${e.steps.length}) — id-behoud kritiek</div>
              <button class="btn btn-primary btn-sm" onclick="window.__setWkfStepAdd()" style="font-size:11px">+ Stap toevoegen</button>
            </div>
            ${e.steps.length === 0
              ? `<div style="padding:14px;color:var(--text-3);font-size:12px;text-align:center;background:var(--surface-2);border-radius:6px">Nog geen stappen.</div>`
              : e.steps.map((s, i) => _wfStepRow(i, s)).join('')}
            ${e._origStepIds.size > 0 ? `<div style="margin-top:6px;font-size:10.5px;color:var(--text-3)">Bestaande stap-ids in DB: <b>${e._origStepIds.size}</b> · behouden bij save: <b>${e.steps.filter((s) => s.id).length}</b> · nieuw: <b>${e.steps.filter((s) => !s.id).length}</b> · te verwijderen: <b>${Math.max(0, e._origStepIds.size - e.steps.filter((s) => s.id).length)}</b></div>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__setWkfCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWkfSave()">${busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }

  function bodyWbWorkflows() {
    if (!_wkf.fetched && !_wkf.loading) queueMicrotask(() => fetchWf());
    const all = _wkf.items;
    const rows = all.map((it) => {
      const busy = !!_wkf.busy[it.id];
      const activeRuns = it.active_run_count || 0;
      const runsPill = activeRuns > 0
        ? `<span style="padding:1px 5px;border-radius:3px;background:var(--sky-soft,#e0f2fe);color:var(--sky,#0369a1);font-size:10px;font-weight:600;margin-left:4px">${activeRuns} run${activeRuns === 1 ? '' : 's'}</span>` : '';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:6px 12px;font-size:12px"><b>${esc(it.name || '—')}</b>${runsPill}${it.description ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:2px">${esc(String(it.description).slice(0,80))}</div>` : ''}</td>
        <td style="padding:6px 12px;font-size:11.5px;text-align:center"><code>${esc(String(it.priority ?? 100))}</code></td>
        <td style="padding:6px 12px;font-size:11.5px;text-align:center">${it.step_count ?? 0}</td>
        <td style="padding:6px 12px;text-align:center">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWkfToggle('${esc(it.id)}')" style="font-size:10.5px;color:${it.is_active ? 'var(--emerald)' : 'var(--text-3)'}">${it.is_active ? '✓ AAN' : '⨯ UIT'}</button>
        </td>
        <td style="padding:4px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWkfEdit('${esc(it.id)}')" style="font-size:10.5px">Bewerk</button>
          <button class="btn btn-ghost btn-sm" ${busy || it.is_active || activeRuns > 0 ? 'disabled' : ''} onclick="window.__setWkfDelete('${esc(it.id)}')" style="font-size:10.5px;color:var(--rose)" title="${it.is_active ? 'Deactiveer eerst' : (activeRuns > 0 ? 'Lopende runs' : 'Verwijderen')}">Verwijder</button>
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1100px">
      ${_wfEditorHtml()}
      <div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12px;line-height:1.55;margin-bottom:12px">
        <b>⚠ INCASSO-ZONE · LIVE.</b> Beheer <code>dunning_workflows</code> + <code>dunning_workflow_steps</code>. De dunning-motor leest deze rijen live in <code>detectAndStartRuns</code>. Nieuwe dunning-runs gebruiken de actieve workflows direct; lopende runs blijven op de oude versie hangen.
        <br><b>Step-id-behoud kritiek</b> (FK dunning_log.step_id + dunning_workflow_runs.current_step_id). Client stuurt bij edit ALTIJD de detail-fetch ids mee; server-guards blokkeren id-loze of lege-payload-saves op gevulde workflows.
      </div>
      ${_wkf.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:8px">⚠ ${esc(_wkf.error)} <button class="btn btn-ghost btn-sm" onclick="_wkf.fetched=false;_wkf.error=null;fetchWf()" style="font-size:11px;margin-left:6px">Opnieuw</button></div>` : ''}
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-size:12px;color:var(--text-3)">${all.length} workflow(s) — ${all.filter((x) => x.is_active).length} actief · ${all.filter((x) => !x.is_active).length} uit · ${all.reduce((a, x) => a + (x.active_run_count || 0), 0)} lopende runs</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto;font-size:11.5px" onclick="window.__setWkfNew()">+ Nieuwe workflow</button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Prio</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">#Stappen</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:14px;color:var(--text-3);font-size:12px;text-align:center">${_wkf.loading ? 'Laden…' : 'Geen workflows.'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }
  /* Wave-4 · wb-berichten NATIVE (v=67) — dunning_templates CRUD in-shell.
     Motor onaangeraakt: alleen bestaande config-endpoints
       finance-dunning-templates-list / -upsert / -delete
     onder gate finance.dunning.config. WA-picker via
       wanbetalers-whatsapp-templates-list (approved-only fallback naar
       free-text bij load-fail).
     WIK-14-gate: client-side regex-detectie op body voor brief-kind.
     Blokkeert activeren + opslaan-als-actief als brief-body geen WIK-tekst
     bevat (patronen: "14 dagen" + "€ 40"/kosten-mention). Full server-side
     legal-gate = aparte brok + legal-signoff — deze client-check is een
     MVP-vangnet, niet een juridische substituut. */
  const _wbT = { loading: false, fetched: false, error: null, items: [],
                 kindFilter: 'all', activeFilter: 'all',
                 metaLoaded: false, metaLoading: false, metaErr: null, metaItems: [],
                 ed: null, busy: {} };

  // WIK-detectie: vereist minimaal "14 dagen"-mention + kosten/betaling-mention.
  // Bewust simpel — vangt evidente ontbrekende WIK-tekst; geen juridische
  // legal-parser. Detectie is CASE-INSENSITIVE en tolereert whitespace/spelling
  // ('14 dagen' / '14-dagen' / '14  dagen'). Kosten-detectie op '€' + cijfer
  // OF "kosten"-woord OF "incassokosten".
  function _wikOk(body) {
    const s = String(body || '');
    if (!s.trim()) return false;
    const has14 = /\b14[\s-]+dagen\b/i.test(s) || /\bveertien\s+dagen\b/i.test(s);
    const hasKosten = /€\s*\d/i.test(s) || /\bincassokosten\b/i.test(s) || /\bkosten\b/i.test(s);
    return has14 && hasKosten;
  }

  async function fetchWbT() {
    if (_wbT.loading || _wbT.fetched) return;
    _wbT.loading = true; _wbT.error = null; if (render) render();
    const j = await tryFetch('wbT-list', '/api/finance-dunning-templates-list');
    _wbT.loading = false; _wbT.fetched = true;
    if (j?.__error) _wbT.error = j.__error;
    else _wbT.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  async function fetchWbTMeta() {
    if (_wbT.metaLoaded || _wbT.metaLoading) return;
    _wbT.metaLoading = true; _wbT.metaErr = null;
    const j = await tryFetch('wbT-meta', '/api/wanbetalers-whatsapp-templates-list');
    _wbT.metaLoading = false; _wbT.metaLoaded = true;
    if (j?.__error) _wbT.metaErr = j.__error;
    else _wbT.metaItems = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }

  // Sync-from-DOM: leest ALLE editor-input in _wbT.ed vóór save/validate.
  // Voorkomt state-lag bij uncontrolled inputs. Geen re-render tijdens sync.
  function _wbTSyncFromDom() {
    const e = _wbT.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    const n = q('[data-wbt-field="name"]');       if (n)  e.name = String(n.value || '');
    const k = q('[data-wbt-field="kind"]');       if (k)  e.kind = String(k.value || 'email');
    const s = q('[data-wbt-field="subject"]');    if (s)  e.subject = String(s.value || '');
    const b = q('[data-wbt-field="body"]');       if (b)  e.body = String(b.value || '');
    const m = q('[data-wbt-field="meta_template_name"]'); if (m) e.meta_template_name = String(m.value || '');
    const l = q('[data-wbt-field="language"]');   if (l)  e.language = String(l.value || 'nl');
    const a = q('[data-wbt-field="is_active"]');  if (a)  e.is_active = !!a.checked;
  }

  window.__setWbTNew = () => {
    _wbT.ed = { id: null, name: '', kind: 'email', subject: '', body: '',
                meta_template_name: '', language: 'nl', is_active: false };
    fetchWbTMeta();
    if (render) render();
  };
  window.__setWbTEdit = (id) => {
    const it = _wbT.items.find((x) => x.id === id); if (!it) return;
    _wbT.ed = { id: it.id, name: it.name || '', kind: it.kind || 'email',
                subject: it.subject || '', body: it.body || '',
                meta_template_name: it.meta_template_name || '',
                language: it.language || 'nl', is_active: !!it.is_active };
    fetchWbTMeta();
    if (render) render();
  };
  window.__setWbTCancel = () => { _wbT.ed = null; if (render) render(); };
  window.__setWbTKindChange = () => {
    // Sync eerst zodat body/subject/meta_template_name behouden blijft, dan
    // kind toepassen + kortstondige re-render zodat kind-conditionele velden
    // (subject email-only / meta_template_name WA-only) zichtbaar worden.
    _wbTSyncFromDom();
    const k = document.querySelector('[data-wbt-field="kind"]');
    if (k && _wbT.ed) _wbT.ed.kind = String(k.value || 'email');
    if (render) render();
  };
  window.__setWbTFilter = (dim, v) => {
    if (dim === 'kind') _wbT.kindFilter = v;
    if (dim === 'active') _wbT.activeFilter = v;
    if (render) render();
  };
  window.__setWbTSave = async () => {
    if (!_wbT.ed) return;
    _wbTSyncFromDom();
    const e = _wbT.ed;
    if (!e.name.trim()) return showToast('Naam is verplicht', 'warn');
    if (!e.body.trim()) return showToast('Body is verplicht', 'warn');
    if (e.kind === 'email' && !e.subject.trim()) return showToast('Onderwerp is verplicht bij e-mail', 'warn');
    if (e.kind === 'whatsapp' && !e.meta_template_name.trim()) return showToast('Meta-template-naam is verplicht bij WhatsApp', 'warn');

    // WIK-gate: brief-kind + is_active → body MOET WIK-14-tekst bevatten.
    // Blokkeert save als 'ie actief moet worden zonder WIK-tekst.
    if (e.kind === 'brief' && e.is_active && !_wikOk(e.body)) {
      return showToast('WIK-gate: brief-body mist "14 dagen"- of kosten-vermelding. Zet is_active uit of vul WIK-tekst aan.', 'warn');
    }

    const doSave = async () => {
      const key = e.id || 'new';
      _wbT.busy[key] = true; if (render) render();
      try {
        const isUpdate = !!e.id;
        const url = '/api/finance-dunning-templates-upsert' + (isUpdate ? '?id=' + encodeURIComponent(e.id) : '');
        const payload = {
          name: e.name.trim(),
          kind: e.kind,
          subject: e.kind === 'email' ? e.subject.trim() : null,
          body: e.body,
          meta_template_name: e.kind === 'whatsapp' ? (e.meta_template_name.trim() || null) : null,
          language: (e.language || 'nl').trim().toLowerCase().slice(0, 2),
          is_active: !!e.is_active,
        };
        const j = await tryFetch('wbT-save', url, {
          method: isUpdate ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wbT.ed = null; _wbT.fetched = false; fetchWbT();
        showToast(isUpdate ? 'Sjabloon bijgewerkt' : 'Sjabloon aangemaakt', 'ok');
      } catch (err) {
        showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn');
      } finally { _wbT.busy[key] = false; if (render) render(); }
    };

    // Custom confirm alleen als save actief live-effect heeft.
    if (e.is_active) {
      openConfirm(`Sjabloon "${esc(e.name)}" opslaan als ACTIEF? Nieuwe dunning-runs gebruiken deze tekst direct — bestaande lopende runs niet.`, doSave, 'warn');
    } else {
      // Inactief-save = veilig, direct opslaan zonder confirm.
      doSave();
    }
  };
  window.__setWbTToggle = (id) => {
    const it = _wbT.items.find((x) => x.id === id); if (!it) return;
    const goingActive = !it.is_active;
    // Bij activeren van brief-kind: WIK-gate check op current body.
    if (goingActive && it.kind === 'brief' && !_wikOk(it.body)) {
      return showToast('WIK-gate: kan brief-sjabloon "' + esc(it.name) + '" niet activeren — body mist "14 dagen"- of kosten-vermelding.', 'warn');
    }
    const msg = goingActive
      ? `Sjabloon "${esc(it.name)}" ACTIVEREN? Nieuwe dunning-runs gebruiken deze tekst direct.`
      : `Sjabloon "${esc(it.name)}" op INACTIEF zetten? Nieuwe dunning-runs skippen dit sjabloon.`;
    openConfirm(msg, async () => {
      _wbT.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('wbT-toggle', '/api/finance-dunning-templates-upsert?id=' + encodeURIComponent(id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_active: goingActive }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wbT.fetched = false; fetchWbT();
        showToast(goingActive ? 'Sjabloon geactiveerd' : 'Sjabloon gedeactiveerd', 'ok');
      } catch (err) { showToast('Toggle mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _wbT.busy[id] = false; if (render) render(); }
    }, goingActive ? 'warn' : 'info');
  };
  // Live WIK-refresh (v=68) tijdens typen — freeze-veilig: geen full re-render,
  // geen state-write per toets. Leest textarea-value uit de DOM, evalueert
  // _wikOk (zelfde bron als save/toggle-gate) en update ALLEEN het WIK-block
  // in-place (background/color/innerHTML). Textarea blijft uncontrolled →
  // focus/cursor-positie ongestoord.
  window.__setWbTBodyInput = (ta) => {
    try {
      if (!_wbT.ed || _wbT.ed.kind !== 'brief') return;
      const val = String(ta?.value || '');
      const ok = _wikOk(val);
      const block = document.querySelector('[data-wbt-wik="1"]');
      if (!block) return;
      // Skip DOM-write als de staat niet gewijzigd is (spaart repaint bij typen
      // ná "ok"-staat is bereikt).
      if (block.getAttribute('data-wbt-wik-ok') === (ok ? '1' : '0')) return;
      block.setAttribute('data-wbt-wik-ok', ok ? '1' : '0');
      block.style.background = ok ? 'var(--emerald-soft)' : 'var(--amber-soft)';
      block.style.color      = ok ? 'var(--emerald)'      : 'var(--amber)';
      block.innerHTML = ok
        ? '✓ WIK-tekst gedetecteerd — activeren toegestaan.'
        : '⚠ WIK-gate: body mist "14 dagen"- of kosten-vermelding. Activeren geblokkeerd tot dit is aangevuld. <b>Let op:</b> deze check is een client-side vangnet; juridische juistheid van de WIK-tekst blijft eigen sign-off.';
    } catch (_) { /* fail-soft; save-gate blijft de harde bron */ }
  };
  window.__setWbTDelete = (id) => {
    const it = _wbT.items.find((x) => x.id === id); if (!it) return;
    if (it.is_active) return showToast('Deactiveer sjabloon eerst vóór verwijderen', 'warn');
    openConfirm(`Sjabloon "${esc(it.name)}" PERMANENT verwijderen? Server-check blokkeert als een workflow-stap er nog naar verwijst.`, async () => {
      _wbT.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('wbT-del', '/api/finance-dunning-templates-delete?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _wbT.fetched = false; fetchWbT();
        showToast('Sjabloon verwijderd', 'ok');
      } catch (err) { showToast('Verwijderen mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _wbT.busy[id] = false; if (render) render(); }
    }, 'warn');
  };

  function _wbTEditorHtml() {
    const e = _wbT.ed; if (!e) return '';
    const isNew = !e.id;
    const key = e.id || 'new';
    const busy = !!_wbT.busy[key];
    // WIK-block styling wordt live bijgewerkt door __setWbTBodyInput. Initial
    // state = _wikOk(current e.body). Data-attribuut `data-wbt-wik` maakt het
    // block adresseerbaar zonder id-collisie tussen meerdere edit-sessies.
    const wik = e.kind === 'brief' ? _wikOk(e.body) : true;
    const _wikOkHtml   = '✓ WIK-tekst gedetecteerd — activeren toegestaan.';
    const _wikBadHtml  = '⚠ WIK-gate: body mist "14 dagen"- of kosten-vermelding. Activeren geblokkeerd tot dit is aangevuld. <b>Let op:</b> deze check is een client-side vangnet; juridische juistheid van de WIK-tekst blijft eigen sign-off.';
    const wikBlock = e.kind === 'brief' ? `
      <div data-wbt-wik="1" data-wbt-wik-ok="${wik ? '1' : '0'}" style="padding:10px 12px;background:${wik ? 'var(--emerald-soft)' : 'var(--amber-soft)'};color:${wik ? 'var(--emerald)' : 'var(--amber)'};border-radius:6px;font-size:11.5px;line-height:1.5;margin-top:8px">
        ${wik ? _wikOkHtml : _wikBadHtml}
      </div>` : '';
    const metaOpts = _wbT.metaItems.map((t) => `<option value="${esc(t.name)}" ${e.meta_template_name === t.name ? 'selected' : ''}>${esc(t.name)} (${esc(t.language || 'nl')})</option>`).join('');
    const metaSelectedInList = _wbT.metaItems.some((t) => t.name === e.meta_template_name);
    const metaFallbackOpt = (e.meta_template_name && !metaSelectedInList)
      ? `<option value="${esc(e.meta_template_name)}" selected>${esc(e.meta_template_name)} — opgeslagen (niet in approved-lijst)</option>` : '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setWbTCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:min(720px,100%);max-height:90vh;overflow-y:auto">
        <div style="display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border);gap:10px">
          <div style="font-size:14px;font-weight:600">${isNew ? 'Nieuw dunning-sjabloon' : 'Sjabloon bewerken: ' + esc(e.name)}</div>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__setWbTCancel()">✕</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:10px">
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px">
            <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Naam</label>
              <input type="text" data-wbt-field="name" value="${esc(e.name)}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
            </div>
            <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Kind</label>
              <select data-wbt-field="kind" onchange="window.__setWbTKindChange()" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box">
                ${['email','whatsapp','brief'].map((k) => `<option value="${k}" ${e.kind === k ? 'selected' : ''}>${k}</option>`).join('')}
              </select>
            </div>
            <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Taal</label>
              <input type="text" data-wbt-field="language" value="${esc(e.language)}" maxlength="2" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
            </div>
          </div>
          ${e.kind === 'email' ? `
            <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Onderwerp (email)</label>
              <input type="text" data-wbt-field="subject" value="${esc(e.subject)}" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box" />
            </div>` : ''}
          ${e.kind === 'whatsapp' ? `
            <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Meta-template (approved)</label>
              ${_wbT.metaErr
                ? `<input type="text" data-wbt-field="meta_template_name" value="${esc(e.meta_template_name)}" placeholder="approved template naam" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
                   <div style="font-size:10.5px;color:var(--rose);margin-top:3px">Meta-templates niet geladen: ${esc(_wbT.metaErr)}. Handmatig invullen — moet exact matchen met approved template of WhatsApp-send faalt.</div>`
                : `<select data-wbt-field="meta_template_name" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box">
                     <option value="" ${!e.meta_template_name ? 'selected' : ''}>— kies approved template —</option>
                     ${metaFallbackOpt}
                     ${metaOpts}
                   </select>
                   <div style="font-size:10.5px;color:var(--text-3);margin-top:3px">${_wbT.metaItems.length} approved templates. Placeholders worden server-side via <code>meta_param_mapping</code> geresolved.</div>`}
            </div>` : ''}
          <div><label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Body (max 50k chars)</label>
            <textarea data-wbt-field="body" oninput="window.__setWbTBodyInput(this)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;box-sizing:border-box;min-height:200px;font-family:inherit;resize:vertical">${esc(e.body)}</textarea>
            <div style="font-size:10.5px;color:var(--text-3);margin-top:3px">Placeholders <code>{{klant.voornaam}}</code>, <code>{{factuur.nummer}}</code>, <code>{{factuur.bedrag_open}}</code>, <code>{{factuur.betaal_link}}</code> etc. (zie <a href="/docs/whatsapp-templates-c4-named-variables.md" target="_blank" style="color:var(--sky)">C4-doc</a>).</div>
            ${wikBlock}
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;user-select:none">
            <input type="checkbox" data-wbt-field="is_active" ${e.is_active ? 'checked' : ''} />
            <span>Actief — nieuwe dunning-runs gebruiken dit sjabloon</span>
          </label>
        </div>
        <div style="display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border);justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__setWbTCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWbTSave()">${busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }

  function bodyWbBerichten() {
    if (!_wbT.fetched && !_wbT.loading) queueMicrotask(() => fetchWbT());
    const kindFilter = _wbT.kindFilter;
    const activeFilter = _wbT.activeFilter;
    const all = _wbT.items;
    const filtered = all.filter((it) => {
      if (kindFilter !== 'all' && it.kind !== kindFilter) return false;
      if (activeFilter === 'active' && !it.is_active) return false;
      if (activeFilter === 'inactive' && it.is_active) return false;
      return true;
    });
    const chip = (val, curr, dim, label) => `<button class="chip ${curr === val ? 'on' : ''}" style="font-size:11px;padding:4px 10px;border-radius:14px;border:1px solid ${curr === val ? 'var(--sky)' : 'var(--border)'};background:${curr === val ? 'var(--sky-soft,#e0f2fe)' : 'transparent'};color:${curr === val ? 'var(--sky,#0369a1)' : 'var(--text-2)'};cursor:pointer" onclick="window.__setWbTFilter('${dim}','${val}')">${esc(label)}</button>`;
    const kindPills = ['all','email','whatsapp','brief'].map((k) => chip(k, kindFilter, 'kind', k === 'all' ? 'Alle kinds' : k)).join(' ');
    const actPills = [['all','Alle'],['active','Actief'],['inactive','Inactief']].map(([v,l]) => chip(v, activeFilter, 'active', l)).join(' ');
    const rows = filtered.map((it) => {
      const busy = !!_wbT.busy[it.id];
      const isBrief = it.kind === 'brief';
      const wikBad = isBrief && !_wikOk(it.body);
      const wikTag = wikBad
        ? `<span title="WIK-tekst ontbreekt in body — activeren wordt geblokkeerd" style="padding:1px 5px;border-radius:3px;background:var(--amber-soft);color:var(--amber);font-size:10px;font-weight:600;margin-left:4px">⚠ WIK</span>`
        : '';
      const kindColor = { email: 'var(--sky-soft,#e0f2fe)', whatsapp: 'var(--emerald-soft)', brief: 'var(--amber-soft)' }[it.kind] || 'var(--surface-2)';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:6px 12px;font-size:12px"><b>${esc(it.name || '—')}</b>${wikTag}</td>
        <td style="padding:6px 12px"><span style="padding:1px 6px;border-radius:4px;background:${kindColor};font-size:10.5px;font-weight:600">${esc(it.kind)}</span></td>
        <td style="padding:6px 12px;font-size:11px;color:var(--text-3)">${esc(it.language || 'nl')}${it.subject ? ' · <i>' + esc(String(it.subject).slice(0,40)) + '</i>' : ''}${it.meta_template_name ? ' · <code style="background:var(--surface-2);padding:1px 4px;border-radius:3px">' + esc(it.meta_template_name) + '</code>' : ''}</td>
        <td style="padding:6px 12px;text-align:center">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWbTToggle('${esc(it.id)}')" style="font-size:10.5px;color:${it.is_active ? 'var(--emerald)' : 'var(--text-3)'}">${it.is_active ? '✓ AAN' : '⨯ UIT'}</button>
        </td>
        <td style="padding:4px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWbTEdit('${esc(it.id)}')" style="font-size:10.5px">Bewerk</button>
          <button class="btn btn-ghost btn-sm" ${busy || it.is_active ? 'disabled' : ''} onclick="window.__setWbTDelete('${esc(it.id)}')" style="font-size:10.5px;color:var(--rose)" title="${it.is_active ? 'Deactiveer eerst' : 'Verwijderen'}">Verwijder</button>
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1100px">
      ${_wbTEditorHtml()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:12px">
        <b>Wanbetalers-templates LIVE.</b> Beheer <code>dunning_templates</code> (email / whatsapp / brief). Nieuwe dunning-runs gebruiken de actieve rijen; motor-logica onaangeraakt.
        Voor <b>kind=brief</b> geldt een <b>WIK-gate</b> (client-side vangnet): body moet minimaal "14 dagen"- én kosten-vermelding bevatten om te mogen activeren. Juridische juistheid van de WIK-tekst blijft eigen sign-off.
        Voor <b>WhatsApp</b>: kies uit approved Meta-templates (dropdown geladen uit finance-WABA); vrije-tekst is een fallback bij load-fail.
      </div>
      ${_wbT.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:8px">⚠ ${esc(_wbT.error)} <button class="btn btn-ghost btn-sm" onclick="_wbT.fetched=false;_wbT.error=null;fetchWbT()" style="font-size:11px;margin-left:6px">Opnieuw</button></div>` : ''}
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <div style="display:flex;gap:6px;flex-wrap:wrap">${kindPills}</div>
        <div style="width:1px;height:20px;background:var(--border)"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${actPills}</div>
        <button class="btn btn-primary btn-sm" style="margin-left:auto;font-size:11.5px" onclick="window.__setWbTNew()">+ Nieuw sjabloon</button>
      </div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:6px">${filtered.length} sjabloon(en) — ${all.filter((x) => x.is_active).length} actief · ${all.filter((x) => !x.is_active).length} inactief · totaal ${all.length}</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Kind</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Meta</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:14px;color:var(--text-3);font-size:12px;text-align:center">${_wbT.loading ? 'Laden…' : 'Geen sjablonen (met huidige filters).'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Ronde-31 STAP 3 · wb-incasso — bureaus CRUD via incasso-bureaus-list/upsert/
     delete + auto-settings via incasso-auto-settings-get/set. Alles achter de
     bestaande finance.incasso.manage-gate. Motor onaangeraakt. */
  const _inc = { loading: false, fetched: false, error: null, bureaus: [], settings: null, ed: null, busy: false };
  async function fetchIncasso() {
    if (_inc.loading || _inc.fetched) return;
    _inc.loading = true; _inc.error = null; if (render) render();
    try {
      const [bRes, sRes] = await Promise.all([
        tryFetch('inc-bureaus-list', '/api/incasso-bureaus-list'),
        tryFetch('inc-auto-get',      '/api/incasso-auto-settings-get'),
      ]);
      if (bRes?.__error || bRes?.error) throw new Error(bRes?.__error || bRes?.error);
      if (sRes?.__error || sRes?.error) throw new Error(sRes?.__error || sRes?.error);
      _inc.bureaus  = bRes?.items || [];
      _inc.settings = sRes?.settings || null;
    } catch (e) { _inc.error = e?.message || 'onbekend'; }
    _inc.loading = false; _inc.fetched = true; if (render) render();
  }
  window.__setIncNew    = () => { _inc.ed = { id: null, name: '', email: '', country: 'NL', address: '', notes: '' }; if (render) render(); };
  window.__setIncEdit   = (id) => { const b = _inc.bureaus.find(x => x.id === id); if (!b) return; _inc.ed = { ...b }; if (render) render(); };
  window.__setIncCancel = () => { _inc.ed = null; if (render) render(); };
  window.__setIncField  = (k, v) => { if (_inc.ed) _inc.ed[k] = String(v || ''); };  // FIX 1 pattern
  window.__setIncCountry= (v) => { if (_inc.ed) { _inc.ed.country = (v === 'BE') ? 'BE' : 'NL'; if (render) render(); } };
  window.__setIncSave = () => {
    if (_inc.ed) {
      const g = (n) => document.querySelector(`[data-inc-field="${n}"]`);
      for (const k of ['name','email','address','notes']) { const el = g(k); if (el && typeof el.value === 'string') _inc.ed[k] = el.value; }
    }
    const e = _inc.ed; if (!e) return;
    const name = String(e.name || '').trim();
    if (!name) { showToast('Naam is verplicht', 'warn'); return; }
    openConfirm(`${e.id ? 'Wijzigingen opslaan voor incassobureau' : 'Nieuw incassobureau aanmaken:'} "${name}"?`, async () => {
      _inc.busy = true; if (render) render();
      try {
        const payload = { id: e.id || undefined, name,
          email: String(e.email || '').trim() || null,
          country: e.country === 'BE' ? 'BE' : 'NL',
          address: String(e.address || '').trim() || null,
          notes: String(e.notes || '').trim() || null,
          is_active: true };
        const j = await tryFetch('inc-bureaus-upsert', '/api/incasso-bureaus-upsert', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(e.id ? 'Bureau bijgewerkt' : 'Bureau aangemaakt', 'ok');
        _inc.ed = null; _inc.fetched = false; fetchIncasso();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _inc.busy = false; if (render) render(); }
    });
  };
  window.__setIncDelete = (id) => {
    const b = _inc.bureaus.find(x => x.id === id); if (!b) return;
    openConfirm(`Incassobureau "${b.name}" DEACTIVEREN? Kan alleen als er geen open dossiers meer op dit bureau lopen (server-guard).`, async () => {
      try {
        const j = await tryFetch('inc-bureaus-delete', '/api/incasso-bureaus-delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Bureau gedeactiveerd', 'ok');
        _inc.fetched = false; fetchIncasso();
      } catch (err) { showToast('Deactiveren mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
    });
  };
  window.__setIncAutoToggle = (k) => {
    if (!_inc.settings) return;
    const cur = !!_inc.settings[k];
    const label = ({ enabled: 'Auto-handoff', require_broken_arrangement: 'Vereis verbroken arrangement', require_no_response_after_aanmaning: 'Vereis geen respons na aanmaning', require_refusal_signal: 'Vereis weigering-signaal' })[k] || k;
    openConfirm(`${cur ? 'Uitzetten' : 'Aanzetten'}: "${label}"? Wijzigingen geldig vanaf de volgende cron-run (cron-incasso-auto).`, async () => {
      const next = { ..._inc.settings, [k]: !cur };
      const j = await tryFetch('inc-auto-set', '/api/incasso-auto-settings-set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      if (j?.__error || j?.error) { showToast('Opslaan mislukt: ' + (j?.__error || j?.error), 'warn'); return; }
      _inc.settings = j?.settings || next;
      showToast('Auto-settings bijgewerkt', 'ok'); if (render) render();
    });
  };
  window.__setIncAutoNumber = (k, v) => {
    if (!_inc.settings) return;
    const num = Number(v);
    if (!Number.isFinite(num) || num < 0) { showToast('Ongeldige waarde', 'warn'); return; }
    const label = ({ min_days_overdue: 'Min. dagen overschreden', min_amount_open_eur: 'Min. openstaand bedrag (€)' })[k] || k;
    openConfirm(`Zet "${label}" op ${num}? Effect vanaf volgende cron-run.`, async () => {
      const next = { ..._inc.settings, [k]: num };
      const j = await tryFetch('inc-auto-set', '/api/incasso-auto-settings-set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
      });
      if (j?.__error || j?.error) { showToast('Opslaan mislukt: ' + (j?.__error || j?.error), 'warn'); return; }
      _inc.settings = j?.settings || next;
      showToast('Auto-settings bijgewerkt', 'ok'); if (render) render();
    });
  };
  function _renderIncEditor() {
    const e = _inc.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setIncCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:600px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'Bureau bewerken' : 'Nieuw incassobureau'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setIncCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Naam <span style="color:var(--rose)">*</span>
            <input type="text" data-inc-field="name" value="${esc(e.name || '')}" oninput="window.__setIncField('name',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">E-mail
            <input type="email" data-inc-field="email" value="${esc(e.email || '')}" oninput="window.__setIncField('email',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Land
            <select onchange="window.__setIncCountry(this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
              <option value="NL" ${e.country === 'NL' ? 'selected' : ''}>NL</option>
              <option value="BE" ${e.country === 'BE' ? 'selected' : ''}>BE</option>
            </select>
          </label>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Adres
            <input type="text" data-inc-field="address" value="${esc(e.address || '')}" oninput="window.__setIncField('address',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Notities
            <textarea data-inc-field="notes" rows="2" oninput="window.__setIncField('notes',this.value)" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.notes || '')}</textarea>
          </label>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setIncCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_inc.busy ? 'disabled' : ''} onclick="window.__setIncSave()">${_inc.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodyWbIncasso() {
    if (!_inc.fetched && !_inc.loading) queueMicrotask(() => fetchIncasso());
    const s = _inc.settings || {};
    const bRows = _inc.bureaus.map(b => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(b.name || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(b.email || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px">${esc(b.country || 'NL')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(b.address || '—')}</td>
      <td style="padding:6px 12px;text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="window.__setIncEdit('${esc(b.id)}')" style="font-size:11px">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__setIncDelete('${esc(b.id)}')" style="font-size:11px;color:var(--rose)">Deactiveer</button>
      </td>
    </tr>`).join('');
    const bool = (v) => `<span style="padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;background:${v?'var(--emerald-soft)':'var(--rose-soft)'};color:${v?'var(--emerald)':'var(--rose)'}">${v?'✓ aan':'⨯ uit'}</span>`;
    return `<div style="max-width:1100px">
      ${_renderIncEditor()}
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Deze sectie schrijft LIVE.</b> Bureaus + auto-handoff-instellingen worden ingelezen door <code>cron-incasso-auto</code> (dagelijks). Wijzigingen zijn direct actief voor de volgende cron-run. Motor onaangeraakt.
      </div>
      ${_inc.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_inc.error)}</div>` : ''}

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:12.5px;font-weight:600">Bureaus (${_inc.bureaus.length})</div>
        <button class="btn btn-primary btn-sm" onclick="window.__setIncNew()">➕ Nieuw bureau</button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">E-mail</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Land</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Adres</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${bRows || `<tr><td colspan="5" style="padding:16px;color:var(--text-3);font-size:12.5px">${_inc.loading?'Laden…':'Geen bureaus'}</td></tr>`}</tbody>
        </table>
      </div>

      <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">Auto-handoff · instellingen</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:12px 20px">
        <div style="grid-column:1/-1;display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid var(--border)">
          <div><b>Auto-handoff aan</b> <span style="color:var(--text-3);font-size:11px">— cron-incasso-auto draait dagelijks</span></div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setIncAutoToggle('enabled')">${bool(!!s.enabled)}</button>
        </div>
        <label style="font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">Min. dagen overschreden
          <input type="number" min="0" value="${esc(String(s.min_days_overdue ?? 30))}" onchange="window.__setIncAutoNumber('min_days_overdue',this.value)" style="width:80px;padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
        </label>
        <label style="font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">Min. openstaand (€)
          <input type="number" min="0" step="0.01" value="${esc(String(s.min_amount_open_eur ?? 50))}" onchange="window.__setIncAutoNumber('min_amount_open_eur',this.value)" style="width:100px;padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
        </label>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">Vereis verbroken arrangement <button class="btn btn-ghost btn-sm" onclick="window.__setIncAutoToggle('require_broken_arrangement')">${bool(!!s.require_broken_arrangement)}</button></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">Vereis geen respons na aanmaning <button class="btn btn-ghost btn-sm" onclick="window.__setIncAutoToggle('require_no_response_after_aanmaning')">${bool(!!s.require_no_response_after_aanmaning)}</button></div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">Vereis weigering-signaal <button class="btn btn-ghost btn-sm" onclick="window.__setIncAutoToggle('require_refusal_signal')">${bool(!!s.require_refusal_signal)}</button></div>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:11px;color:var(--text-3);line-height:1.55">Preview van kandidaten voor de volgende cron-run: <code>/api/incasso-auto-preview</code>. Deze pagina schrijft alleen de settings; de daadwerkelijke run is <code>cron-incasso-auto</code> (server-side).</div>
    </div>`;
  }

  /* Ronde-31 STAP 2 · wb-joost — persona (name + tone) WIRE via joost-config-
     get/upsert; arrangement_mandate READ-ONLY tonen (bewerken raakt autonome-
     send-grenzen direct; Finance-signoff-brok apart). Motor onaangeraakt. */
  const _jc = { loading: false, fetched: false, error: null, config: null, ed: null, busy: false };
  async function fetchJoostConfig() {
    if (_jc.loading || _jc.fetched) return;
    _jc.loading = true; _jc.error = null; if (render) render();
    try {
      const j = await tryFetch('joost-config-get', '/api/joost-config-get?module=finance');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _jc.config = j?.config || null;
    } catch (e) { _jc.error = e?.message || 'onbekend'; }
    _jc.loading = false; _jc.fetched = true; if (render) render();
  }
  window.__setJcEdit   = () => { if (!_jc.config) return; _jc.ed = { persona_name: String(_jc.config.persona_name || ''), persona_tone: String(_jc.config.persona_tone || '') }; if (render) render(); };
  window.__setJcCancel = () => { _jc.ed = null; if (render) render(); };
  // FIX 1 pattern: setter geen render() (focus behouden).
  window.__setJcField  = (k, v) => { if (_jc.ed) _jc.ed[k] = String(v || ''); };
  window.__setJcSave = () => {
    if (_jc.ed) {
      const g = (n) => document.querySelector(`[data-jc-field="${n}"]`);
      for (const k of ['persona_name','persona_tone']) { const el = g(k); if (el && typeof el.value === 'string') _jc.ed[k] = el.value; }
    }
    const e = _jc.ed; if (!e) return;
    const name = String(e.persona_name || '').trim();
    const tone = String(e.persona_tone || '').trim();
    if (!name) { showToast('Persona-naam is verplicht', 'warn'); return; }
    if (name.length > 100) { showToast('Persona-naam max 100 tekens', 'warn'); return; }
    if (tone.length > 500) { showToast('Persona-tone max 500 tekens', 'warn'); return; }
    openConfirm(`Joost-persona bijwerken naar "${name}"? Geldt direct voor alle nieuwe suggesties (finance-module).`, async () => {
      _jc.busy = true; if (render) render();
      try {
        const j = await tryFetch('joost-config-upsert', '/api/joost-config-upsert', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ module: 'finance', persona_name: name, persona_tone: tone }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Joost-persona bijgewerkt', 'ok');
        _jc.ed = null; _jc.fetched = false; fetchJoostConfig();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _jc.busy = false; if (render) render(); }
    });
  };
  function _renderJcEditor() {
    const e = _jc.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setJcCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:640px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">Joost-persona bewerken (finance)</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setJcCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
          <label style="font-size:11.5px;color:var(--text-2)">Persona-naam <span style="color:var(--rose)">*</span>
            <input type="text" data-jc-field="persona_name" value="${esc(e.persona_name)}" oninput="window.__setJcField('persona_name',this.value)" maxlength="100" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Persona-toon (kort — hoe presenteert Joost zich)
            <textarea data-jc-field="persona_tone" rows="3" oninput="window.__setJcField('persona_tone',this.value)" maxlength="500" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.persona_tone)}</textarea>
          </label>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setJcCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_jc.busy ? 'disabled' : ''} onclick="window.__setJcSave()">${_jc.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function _renderMandaatReadOnly(am) {
    // arrangement_mandate is jsonb — mogelijk leeg. Tonen wat er is, min/max/enabled.
    if (!am || typeof am !== 'object' || !Object.keys(am).length) {
      return `<div style="padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--text-3)">Geen mandaat-config gezet — Joost handhaaft server-side defaults uit <code>joost-autonomy-evaluate</code>. Editor volgt in aparte Finance-brok.</div>`;
    }
    const types = Object.keys(am);
    return `<div style="display:grid;grid-template-columns:1fr;gap:8px">
      ${types.map(t => {
        const row = am[t] || {};
        const en  = row.enabled ? '<span style="color:var(--emerald);font-weight:600">✓ enabled</span>' : '<span style="color:var(--rose);font-weight:600">⨯ disabled</span>';
        const details = Object.entries(row).filter(([k]) => k !== 'enabled').map(([k,v]) => `<span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3)">${esc(k)}=${esc(String(v))}</span>`).join(' · ');
        return `<div style="padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:12.5px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>${esc(t)}</b> ${en}</div>
          ${details ? `<div style="margin-top:4px">${details}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }
  function bodyWbJoost() {
    // v=71 opruim-ronde: canonieke bewerkplek is AI Agents-module (heeft de
    // volledige editor met history/draft/publish/rollback). Instellingen toont
    // hier alleen een read-only persona-preview + deep-link — voorkomt tweede
    // write-pad op joost_config.
    if (!_jc.fetched && !_jc.loading) queueMicrotask(() => fetchJoostConfig());
    const c = _jc.config;
    const am = c?.autonomy_config?.arrangement_mandate;
    return `<div style="max-width:1000px">
      <div style="padding:12px 14px;background:var(--sky-soft,#e0f2fe);color:var(--sky,#0369a1);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <b>READ-ONLY preview.</b> Joost-persona wordt beheerd in de <b>AI Agents-module</b> (canonieke bewerkplek, met history / draft / publish / rollback). Hier alleen ter overzicht.
        </div>
        <button class="btn btn-primary btn-sm" onclick="DFO.goMod('agents')" style="font-size:11.5px;white-space:nowrap">🤖 Open AI Agents → Joost</button>
      </div>
      ${_jc.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_jc.error)}</div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">Persona · preview</div>
          ${!c ? `<div style="color:var(--text-3);font-size:12px">${_jc.loading?'Laden…':'—'}</div>` : `
            <div style="font-size:12.5px;margin-bottom:4px"><span style="color:var(--text-3)">Naam: </span><b>${esc(c.persona_name || '—')}</b></div>
            <div style="font-size:11.5px;color:var(--text-3);line-height:1.5">${esc(c.persona_tone || '—')}</div>
          `}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">Model + status</div>
          <div style="font-size:12px;line-height:1.7">
            <div><span style="color:var(--text-3)">Model: </span><code>${esc(c?.model || '—')}</code></div>
            <div><span style="color:var(--text-3)">Temperature: </span><code>${esc(String(c?.temperature ?? '—'))}</code></div>
            <div><span style="color:var(--text-3)">Enabled: </span>${c?.is_enabled ? '<b style="color:var(--emerald)">✓ ja</b>' : '<b style="color:var(--rose)">⨯ nee</b>'}</div>
          </div>
        </div>
      </div>
      <div style="margin-bottom:8px;display:flex;align-items:center;gap:8px">
        <div style="font-size:12.5px;font-weight:600">Autonomie · arrangement_mandate</div>
        <span style="padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:10.5px;font-weight:600">READ-ONLY</span>
      </div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Bepaalt welke arrangement-types Joost autonoom mag voorstellen + de caps. Bewerken via AI Agents-module.</div>
      ${_renderMandaatReadOnly(am)}
    </div>`;
  }

  /* Ronde-31 grote-brok · agents-lisa — volledige config-editor native.
     Endpoints: /api/lisa-config (GET ?which=latest / GET ?action=history / POST
     ?action=save_draft|publish|rollback). Auth: verifyAdmin + lisa.config.{view,edit,publish}.
     FREEZE-LES: dynamische lijsten (kb_products / kb_faq / followup_sequence /
     stop_keywords / kb_tag_filter) re-renderen ALLEEN bij add/remove. Typen in
     tekst-inputs = geen render (uncontrolled met data-lc-*-attrs; sync bij save).
     Draft/publish/rollback allemaal met custom openConfirm. Motor: Lisa-productie-
     flow ONAANGERAAKT (bridge via bestaande endpoints). */
  const _LC_PHASE_KEYS = ['intro','doel','situatie','band','call','qualified','disqualified'];
  // Ronde-31 v=45 BLOCKER-fix: phase_* zijn OBJECTEN {system, transition, examples[]},
  // niet strings (bewijs: modules/lisa.html r1580-1583 + r1983-1987). dos/donts zijn
  // arrays van strings. Helpers hieronder normaliseren beide kanten.
  function _lcPhaseObj(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { system: String(raw.system || ''), transition: String(raw.transition || ''), examples: Array.isArray(raw.examples) ? raw.examples.slice() : [] };
    }
    // Legacy: string → als system, transition + examples leeg.
    return { system: raw != null ? String(raw) : '', transition: '', examples: [] };
  }
  function _lcArrLines(raw) {
    if (Array.isArray(raw)) return raw.map(x => String(x || '')).filter(Boolean).join('\n');
    if (raw == null) return '';
    return String(raw);
  }
  function _lcLinesArr(s) { return String(s || '').split('\n').map(x => x.trim()).filter(Boolean); }
  const _lc = {
    loading: false, fetched: false, error: null,
    config: null, active_version: null,           // uit ?which=latest
    history: [], historyFetched: false, historyOpen: false,
    busy: false, savingKind: null, dirty: false,
  };
  function _lcEmptyProduct() { return { naam: '', beschrijving: '', prijs: '', doelgroep: '', duur: '' }; }
  function _lcEmptyFaq()     { return { vraag: '', antwoord: '', keywords: [] }; }
  function _lcEmptyStep()    { return { delay_hours: 24, template: '', conditions: null, use_ai: false }; }
  async function fetchLisaConfig() {
    if (_lc.loading || _lc.fetched) return;
    _lc.loading = true; _lc.error = null; if (render) render();
    try {
      const j = await tryFetch('lisa-config', '/api/lisa-config?which=latest');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      const c = j?.config || {};
      // Zorg dat arrays altijd bestaan (server kan null returnen).
      c.kb_products      = Array.isArray(c.kb_products)      ? c.kb_products      : [];
      c.kb_faq           = Array.isArray(c.kb_faq)           ? c.kb_faq           : [];
      c.kb_tag_filter    = Array.isArray(c.kb_tag_filter)    ? c.kb_tag_filter    : [];
      c.stop_keywords    = Array.isArray(c.stop_keywords)    ? c.stop_keywords    : [];
      c.followup_sequence= Array.isArray(c.followup_sequence)? c.followup_sequence: [];
      c.kb_use_general_kb= !!c.kb_use_general_kb;
      c.followup_enabled = !!c.followup_enabled;
      c.followup_ai_threshold_chars = Number.isFinite(c.followup_ai_threshold_chars) ? c.followup_ai_threshold_chars : 200;
      // v=45 BLOCKER-fix: normaliseer objecten (fases) + arrays (dos/donts).
      ['phase_intro','phase_doel','phase_situatie','phase_band','phase_call'].forEach(k => { c[k] = _lcPhaseObj(c[k]); });
      c.dos   = Array.isArray(c.dos)   ? c.dos   : (c.dos   ? [String(c.dos)]   : []);
      c.donts = Array.isArray(c.donts) ? c.donts : (c.donts ? [String(c.donts)] : []);
      _lc.config = c;
      _lc.active_version = j?.active_version || null;
      _lc.dirty = false;
    } catch (e) { _lc.error = e?.message || 'onbekend'; }
    _lc.loading = false; _lc.fetched = true; if (render) render();
  }
  async function fetchLisaHistory() {
    if (_lc.historyFetched) return;
    try {
      const j = await tryFetch('lisa-history', '/api/lisa-config?action=history');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _lc.history = j?.versions || [];
    } catch (e) { showToast('Historie laden mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
    _lc.historyFetched = true; if (render) render();
  }
  // Sync uncontrolled inputs → _lc.config.
  function _lcSyncFromDom() {
    const c = _lc.config; if (!c) return;
    const q = (sel) => document.querySelector(sel);
    const qAll = (sel) => document.querySelectorAll(sel);
    const readStr = (attr) => { const el = q(`[data-lc-${attr}]`); return el ? String(el.value || '') : c[attr]; };
    // Persona-velden (strings) — dos/donts + phase_* worden apart afgehandeld hieronder.
    ['persona_name','persona_age','persona_background','persona_tone','persona_writing_style','emoji_usage','kb_pricing','kb_usps']
      .forEach(k => { const el = q(`[data-lc-field="${k}"]`); if (el) c[k] = String(el.value || ''); });
    // v=45 BLOCKER-fix: dos/donts als newline-array (1 regel = 1 item).
    ['dos','donts'].forEach(k => { const el = q(`[data-lc-field="${k}"]`); if (el) c[k] = _lcLinesArr(el.value); });
    // v=45 BLOCKER-fix: phase_* als object {system, transition, examples[]}.
    ['intro','doel','situatie','band','call'].forEach(f => {
      const key = 'phase_' + f;
      const sys = q(`[data-lc-phase="${f}"][data-lc-phase-field="system"]`);
      const trn = q(`[data-lc-phase="${f}"][data-lc-phase-field="transition"]`);
      const exp = q(`[data-lc-phase="${f}"][data-lc-phase-field="examples"]`);
      c[key] = {
        system:     sys ? String(sys.value || '') : (c[key]?.system || ''),
        transition: trn ? String(trn.value || '') : (c[key]?.transition || ''),
        examples:   exp ? _lcLinesArr(exp.value)  : (Array.isArray(c[key]?.examples) ? c[key].examples : []),
      };
    });
    // Bool + number.
    const kbGen = q('[data-lc-kb-use-general]'); if (kbGen) c.kb_use_general_kb = !!kbGen.checked;
    const fuEn  = q('[data-lc-followup-enabled]'); if (fuEn) c.followup_enabled = !!fuEn.checked;
    const fuTh  = q('[data-lc-followup-threshold]'); if (fuTh) c.followup_ai_threshold_chars = Math.max(0, Math.min(2000, parseInt(fuTh.value, 10) || 0));
    // v=45 KLEIN 1: delay_hours NIET stil klemmen — behoud raw parseInt; validatie in save.
    // Tag-filter + stop-keywords: comma-separated single-input tekstveld.
    const tagEl = q('[data-lc-tag-filter]'); if (tagEl) c.kb_tag_filter = String(tagEl.value || '').split(',').map(s => s.trim()).filter(Boolean);
    const stopEl= q('[data-lc-stop-keywords]');if (stopEl) c.stop_keywords = String(stopEl.value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    // kb_products (per rij).
    (c.kb_products || []).forEach((_, i) => {
      ['naam','beschrijving','prijs','doelgroep','duur'].forEach(k => {
        const el = q(`[data-lc-prod-idx="${i}"][data-lc-prod-field="${k}"]`);
        if (el) c.kb_products[i][k] = String(el.value || '');
      });
    });
    // kb_faq (per rij, keywords comma-list).
    (c.kb_faq || []).forEach((_, i) => {
      const vraag  = q(`[data-lc-faq-idx="${i}"][data-lc-faq-field="vraag"]`);   if (vraag)  c.kb_faq[i].vraag = String(vraag.value || '');
      const antw   = q(`[data-lc-faq-idx="${i}"][data-lc-faq-field="antwoord"]`);if (antw)   c.kb_faq[i].antwoord = String(antw.value || '');
      const kws    = q(`[data-lc-faq-idx="${i}"][data-lc-faq-field="keywords"]`);if (kws)    c.kb_faq[i].keywords = String(kws.value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    });
    // followup_sequence (per stap). KLEIN 1: geen clamping — save-validatie weigert buiten 1-720.
    (c.followup_sequence || []).forEach((_, i) => {
      const dh = q(`[data-lc-step-idx="${i}"][data-lc-step-field="delay_hours"]`);if (dh) c.followup_sequence[i].delay_hours = parseInt(dh.value, 10);
      const tp = q(`[data-lc-step-idx="${i}"][data-lc-step-field="template"]`);   if (tp) c.followup_sequence[i].template = String(tp.value || '');
    });
    _lc.dirty = true;
  }
  // Structuur-actions — deze wijzigen counts/lengths → render.
  window.__setLcAddProduct = () => { _lcSyncFromDom(); _lc.config.kb_products.push(_lcEmptyProduct()); if (render) render(); };
  window.__setLcRmProduct  = (i) => { _lcSyncFromDom(); _lc.config.kb_products.splice(i, 1); if (render) render(); };
  window.__setLcAddFaq     = () => { _lcSyncFromDom(); _lc.config.kb_faq.push(_lcEmptyFaq()); if (render) render(); };
  window.__setLcRmFaq      = (i) => { _lcSyncFromDom(); _lc.config.kb_faq.splice(i, 1); if (render) render(); };
  window.__setLcAddStep    = () => {
    _lcSyncFromDom();
    if ((_lc.config.followup_sequence || []).length >= 5) { showToast('Max 5 stappen', 'warn'); return; }
    _lc.config.followup_sequence.push(_lcEmptyStep()); if (render) render();
  };
  window.__setLcRmStep     = (i) => { _lcSyncFromDom(); _lc.config.followup_sequence.splice(i, 1); if (render) render(); };
  window.__setLcToggleHistory = () => {
    _lc.historyOpen = !_lc.historyOpen;
    if (_lc.historyOpen && !_lc.historyFetched) fetchLisaHistory();
    if (render) render();
  };
  window.__setLcSave = (kind) => {
    _lcSyncFromDom();
    const c = _lc.config; if (!c) return;
    // Validatie client-side (mirror van server).
    if (!String(c.persona_name || '').trim()) { showToast('Persona-naam is verplicht', 'warn'); return; }
    for (let i = 0; i < (c.followup_sequence||[]).length; i++) {
      const s = c.followup_sequence[i];
      if (!s.template || !String(s.template).trim()) { showToast(`Follow-up stap ${i+1}: template ontbreekt`, 'warn'); return; }
      const d = parseInt(s.delay_hours, 10);
      if (!Number.isFinite(d) || d < 1 || d > 720) { showToast(`Follow-up stap ${i+1}: delay moet tussen 1 en 720 uur zijn (nu: ${s.delay_hours})`, 'warn'); return; }
    }
    // Payload = alleen EDIT_FIELDS (server filtert via pick+EDIT_FIELDS).
    const editKeys = ['persona_name','persona_age','persona_background','persona_tone','persona_writing_style','emoji_usage','dos','donts','phase_intro','phase_doel','phase_situatie','phase_band','phase_call','kb_products','kb_faq','kb_pricing','kb_usps','kb_tag_filter','kb_use_general_kb','followup_sequence','stop_keywords','followup_ai_threshold_chars','followup_enabled'];
    const payload = {}; editKeys.forEach(k => { if (c[k] !== undefined) payload[k] = c[k]; });
    const isPublish = kind === 'publish';
    const msg = isPublish
      ? `Lisa-config PUBLICEREN als nieuwe versie? Geldt DIRECT voor alle nieuwe lead-gesprekken. De vorige actieve versie wordt gedeactiveerd (rollback blijft mogelijk).`
      : `Concept-versie opslaan? Wordt niet live gezet; huidige actieve versie blijft ongewijzigd tot je publiceert.`;
    openConfirm(msg, async () => {
      _lc.busy = true; _lc.savingKind = kind; if (render) render();
      try {
        const j = await tryFetch(`lisa-${kind}`, `/api/lisa-config?action=${kind}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(j?.message || (isPublish ? 'Gepubliceerd' : 'Concept opgeslagen'), 'ok');
        _lc.fetched = false; _lc.historyFetched = false; _lc.dirty = false;
        fetchLisaConfig();
      } catch (e) { showToast('Opslaan mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
      finally { _lc.busy = false; _lc.savingKind = null; if (render) render(); }
    }, isPublish ? 'warn' : undefined);
  };
  window.__setLcRollback = (versionId, ver) => {
    openConfirm(`Terugrollen naar Lisa-versie v${ver}? Er wordt een NIEUWE actieve versie aangemaakt met de inhoud van v${ver}. Vorige actieve versie wordt gedeactiveerd (blijft in historie).`, async () => {
      try {
        const j = await tryFetch('lisa-rollback', '/api/lisa-config?action=rollback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version_id: versionId }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(j?.message || `Teruggerold naar v${ver}`, 'ok');
        _lc.fetched = false; _lc.historyFetched = false;
        fetchLisaConfig();
      } catch (e) { showToast('Rollback mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
    }, 'warn');
  };
  function _lcTextField(label, key, opts) {
    const c = _lc.config || {};
    const val = c[key] != null ? String(c[key]) : '';
    const isTa = opts?.textarea;
    const rows = opts?.rows || 2;
    const help = opts?.help ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:2px">${opts.help}</div>` : '';
    const input = isTa
      ? `<textarea data-lc-field="${key}" rows="${rows}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(val)}</textarea>`
      : `<input type="text" data-lc-field="${key}" value="${esc(val)}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />`;
    return `<label style="font-size:11.5px;color:var(--text-2);display:block">${esc(label)}${input}${help}</label>`;
  }
  function _lcHistoryPanel() {
    if (!_lc.historyOpen) return '';
    const rows = (_lc.history || []).map(v => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:6px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace">v${v.version}</td>
      <td style="padding:6px 12px;font-size:11.5px">${v.is_active ? '<span style="color:var(--emerald);font-weight:600">✓ LIVE</span>' : '<span style="color:var(--text-3)">archief</span>'}</td>
      <td style="padding:6px 12px;font-size:11.5px;color:var(--text-3)">${esc(v.persona_name || '—')}</td>
      <td style="padding:6px 12px;font-size:11px;color:var(--text-3)">${esc(v.created_at || '')}</td>
      <td style="padding:6px 12px;font-size:11px;color:var(--text-3);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.notes || '')}</td>
      <td style="padding:4px 12px;text-align:right">
        ${!v.is_active ? `<button class="btn btn-ghost btn-sm" onclick="window.__setLcRollback('${esc(v.id)}', ${v.version})" style="font-size:11px;color:var(--amber)">↩ Rollback</button>` : ''}
      </td>
    </tr>`).join('');
    return `<div style="margin:12px 0;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <div style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)">
        <div style="font-size:12.5px;font-weight:600">Versie-historie (${_lc.history.length})</div>
        <button class="btn btn-ghost btn-sm" onclick="window.__setLcToggleHistory()" style="font-size:11px">✕ Sluiten</button>
      </div>
      <div style="max-height:280px;overflow-y:auto"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--surface)"><th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Versie</th><th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Status</th><th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Persona</th><th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Aangemaakt</th><th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Notitie</th><th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="6" style="padding:14px;color:var(--text-3);font-size:12px;text-align:center">${_lc.historyFetched?'Geen historie':'Laden…'}</td></tr>`}</tbody>
      </table></div>
    </div>`;
  }
  function bodyAgentsLisa() {
    // v=73 opruim-ronde: canonieke bewerkplek is AI Agents-module (heeft de
    // volledige editor met draft/publish/rollback + history). Instellingen
    // toont hier alleen een read-only preview + deep-link — voorkomt tweede
    // write-pad op lisa_config.
    if (!_lc.fetched && !_lc.loading) queueMicrotask(() => fetchLisaConfig());
    const c = _lc.config;
    if (!c && _lc.loading) return `<div style="padding:24px;color:var(--text-3)">Laden…</div>`;
    if (_lc.error && !c) return `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:13px">⚠ ${esc(_lc.error)}</div>`;
    const isLive = c && c.is_active && (!_lc.active_version || c.version === _lc.active_version);
    const hdr = c
      ? (isLive
          ? `<span style="padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-size:11px;font-weight:600">LIVE v${c.version}</span>`
          : `<span style="padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:11px;font-weight:600">v${c.version}</span>${_lc.active_version ? ' <span style="font-size:11px;color:var(--text-3)">actieve: v' + _lc.active_version + '</span>' : ''}`)
      : '';
    const phases = (c && Array.isArray(c.phase_config)) ? c.phase_config : [];
    const kbProdN = (c && Array.isArray(c.kb_products)) ? c.kb_products.length : 0;
    const kbFaqN  = (c && Array.isArray(c.kb_faq)) ? c.kb_faq.length : 0;
    const followupN = (c && Array.isArray(c.followup_sequence)) ? c.followup_sequence.length : 0;
    const stopN     = (c && Array.isArray(c.stop_keywords)) ? c.stop_keywords.length : 0;
    return `<div style="max-width:1000px">
      <div style="padding:12px 14px;background:var(--sky-soft,#e0f2fe);color:var(--sky,#0369a1);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <b>READ-ONLY preview.</b> Lisa-config wordt beheerd in de <b>AI Agents-module</b> (canonieke bewerkplek, met draft / publish / rollback + history). Hier alleen ter overzicht — geen tweede write-pad op <code>lisa_config</code>.
        </div>
        <button class="btn btn-primary btn-sm" onclick="DFO.goMod('agents')" style="font-size:11.5px;white-space:nowrap">🤖 Open AI Agents → Lisa</button>
      </div>
      ${!c ? `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:13px">⚠ Geen Lisa-config gevonden</div>` : `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="font-size:12.5px;font-weight:600">Status</div>${hdr}</div>
          <div style="font-size:12px;line-height:1.7">
            <div><span style="color:var(--text-3)">Persona: </span><b>${esc(c.persona_name || 'Lisa')}</b></div>
            <div><span style="color:var(--text-3)">Model: </span><code>${esc(c.model || '—')}</code></div>
            <div><span style="color:var(--text-3)">Actief: </span>${c.is_active ? '<b style="color:var(--emerald)">✓ ja</b>' : '<b style="color:var(--rose)">⨯ nee</b>'}</div>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
          <div style="font-size:12.5px;font-weight:600;margin-bottom:8px">Config-omvang</div>
          <div style="font-size:12px;line-height:1.7">
            <div><span style="color:var(--text-3)">Fases: </span><b>${phases.length}</b></div>
            <div><span style="color:var(--text-3)">Kennisbank: </span><b>${kbProdN}</b> product(en) · <b>${kbFaqN}</b> FAQ</div>
            <div><span style="color:var(--text-3)">Follow-up sequenties: </span><b>${followupN}</b></div>
            <div><span style="color:var(--text-3)">Stop-keywords: </span><b>${stopN}</b></div>
          </div>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
        <div style="font-size:12.5px;font-weight:600;margin-bottom:6px">Persona-toon (preview)</div>
        <div style="font-size:11.5px;color:var(--text-3);line-height:1.5;white-space:pre-wrap">${esc(c.persona_tone || '—')}</div>
      </div>`}
    </div>`;
  }
  function bodyLeadBronnen() {
    if (!_lb.fetched && !_lb.loading) queueMicrotask(() => fetchLeadBronnen());
    const rowsB = _lb.byBron.map(x => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 12px;font-size:12.5px">${esc(x.name)}</td><td style="padding:6px 12px;font-size:12.5px;text-align:right;font-family:'IBM Plex Mono',monospace">${x.count}</td><td style="padding:6px 12px;font-size:11px;color:var(--text-3);text-align:right">${_lb.total ? Math.round(x.count/_lb.total*100) : 0}%</td></tr>`).join('');
    const rowsT = _lb.byTraject.map(x => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 12px;font-size:12.5px">${esc(x.name)}</td><td style="padding:6px 12px;font-size:12.5px;text-align:right;font-family:'IBM Plex Mono',monospace">${x.count}</td><td style="padding:6px 12px;font-size:11px;color:var(--text-3);text-align:right">${_lb.total ? Math.round(x.count/_lb.total*100) : 0}%</td></tr>`).join('');
    const rowsX = _lb.byCross.slice(0, 40).map(x => `<tr style="border-top:1px solid var(--border)"><td style="padding:6px 12px;font-size:12px">${esc(x.bron)}</td><td style="padding:6px 12px;font-size:12px">${esc(x.traject)}</td><td style="padding:6px 12px;font-size:12px;text-align:right;font-family:'IBM Plex Mono',monospace">${x.count}</td></tr>`).join('');
    const rowsSrc = (_lb.sources || []).map(s => `<tr style="border-top:1px solid var(--border);${s.is_active?'':'opacity:.55'}"><td style="padding:6px 12px;font-size:12.5px">${esc(s.name)}</td><td style="padding:6px 12px;font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(String(s.id).slice(0,8))}…</td><td style="padding:6px 12px;font-size:11px;text-align:center">${s.is_active?'<span style="color:var(--emerald)">✓ actief</span>':'<span style="color:var(--text-3)">⨯ inactief</span>'}</td></tr>`).join('');
    return `<div style="max-width:1100px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Read-only.</b> ${_lb.total} schone leads${_lb.excluded ? ` <span style="color:var(--text-3);font-weight:normal">(${_lb.excluded} test/afgewezen uitgesloten uit ${_lb.raw} totaal)</span>` : ''} — filter matcht dashboard-tegels &quot;Leads per traject&quot;.
      </div>
      <div style="padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:12px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
        <b>Discovery — waarom géén editor hier:</b> er is <b>geen data-driven bron→traject-mapping</b>. Elke intake-endpoint (bv. <code>lead-handmatig-toevoegen</code>, <code>leadsonderhoud-quiz-opslaan</code>) zet in dezelfde INSERT zowel <code>leads.bron</code> als <code>leads.traject</code> (r78: <code>bron: 'handmatig', traject: primair</code>). <code>lead_sources</code>-tabel bestaat wel maar dient CAC-attributie op <code>deals.source_lead_id</code> — geen traject-koppeling. Mapping-editor vraagt <b>backend-refactor</b>: nieuwe tabel <code>lead_source_traject_map</code>, alle intake-endpoints laten consulteren, evt. backfill van historische leads. Buiten scope zonder afstemming — sectie blijft READ-ONLY.
      </div>
      ${_lb.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_lb.error)}</div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div>
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Per bron</div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="background:var(--surface-2)"><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Bron</th><th style="text-align:right;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Aantal</th><th style="text-align:right;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">%</th></tr></thead>
              <tbody>${rowsB || `<tr><td colspan="3" style="padding:12px;color:var(--text-3);font-size:12px">${_lb.loading?'Laden…':'—'}</td></tr>`}</tbody>
            </table>
          </div>
        </div>
        <div>
          <div style="font-size:13px;font-weight:600;margin-bottom:8px">Per traject</div>
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse">
              <thead><tr style="background:var(--surface-2)"><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Traject</th><th style="text-align:right;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Aantal</th><th style="text-align:right;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">%</th></tr></thead>
              <tbody>${rowsT || `<tr><td colspan="3" style="padding:12px;color:var(--text-3);font-size:12px">${_lb.loading?'Laden…':'—'}</td></tr>`}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">Kruistabel · bron × traject (feitelijke koppelingen, top 40)</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;max-height:360px;overflow-y:auto">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--surface-2);position:sticky;top:0"><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Bron</th><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Traject</th><th style="text-align:right;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Aantal</th></tr></thead>
            <tbody>${rowsX || `<tr><td colspan="3" style="padding:12px;color:var(--text-3);font-size:12px">${_lb.loading?'Laden…':'—'}</td></tr>`}</tbody>
          </table>
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--text-3)">Zo zie je de <b>de-facto mapping</b> zoals die op de rijen staat. Elke unieke (bron, traject)-combinatie = één rij hier.</div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">CAC-attributie · <code>lead_sources</code>-tabel</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--surface-2)"><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th><th style="text-align:left;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">ID</th><th style="text-align:center;padding:6px 12px;font-size:11px;color:var(--text-3);font-weight:600">Actief</th></tr></thead>
            <tbody>${rowsSrc || `<tr><td colspan="3" style="padding:12px;color:var(--text-3);font-size:12px">Geen lead_sources gevonden (of RLS)</td></tr>`}</tbody>
          </table>
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--text-3)"><code>lead_sources</code> is een aparte tabel voor sales-CAC (<code>deals.source_lead_id</code>). Deze bepaalt NIET automatisch het traject van een lead.</div>
      </div>
    </div>`;
  }

  /* Ronde-31 grote-brok · sales-bonus — CRUD op sales_bonus_configs.
     Endpoint: /api/sales-bonus-configs (GET / POST / PATCH ?id / DELETE ?id soft).
     Permission: super_admin (via profiles.role check in endpoint).
     DISCOVERY: sales_bonus_configs-tabel bestaat (docs/sql-migrations/2026-05-30-
     finance-fase-1-fundament.sql r82-91): user_id + percentage (default 3.00) +
     threshold_amount (default 1000.00) + active_from + active_until (soft-delete).
     Gebruikt door api/sales-subscription-create.js r476-488: bij aanmaak van een
     down-payment-sub leest engine de MEEST RECENTE config per sales_user_id + past
     percentage toe op down-amount als >=threshold. Bonus wordt gesnapshot in
     bonuses-tabel (status='pending'). Historische bonusberekeningen behouden dus
     hun snapshot; wijziging aan config raakt alleen NIEUWE deals.
     Geen teamleader-call in het bonus-pad — DB-only. Motor onaangeraakt. */
  const _sb = { loading: false, fetched: false, error: null, configs: [], candidates: [], ed: null, busy: false };
  async function fetchSalesBonus() {
    if (_sb.loading || _sb.fetched) return;
    _sb.loading = true; _sb.error = null; if (render) render();
    try {
      const j = await tryFetch('sb-list', '/api/sales-bonus-configs');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _sb.configs = j?.configs || [];
      _sb.candidates = j?.candidates || [];
    } catch (e) { _sb.error = e?.message || 'onbekend'; }
    _sb.loading = false; _sb.fetched = true; if (render) render();
  }
  window.__setSbReload = () => { _sb.fetched = false; fetchSalesBonus(); };
  window.__setSbNew  = () => { _sb.ed = { id: null, user_id: _sb.candidates[0]?.id || '', percentage: 3.00, threshold_amount: 1000.00, active_from: new Date().toISOString().slice(0,10) }; if (render) render(); };
  window.__setSbEdit = (id) => { const c = _sb.configs.find(x => x.id === id); if (!c) return; _sb.ed = { id: c.id, user_id: c.user_id, percentage: c.percentage, threshold_amount: c.threshold_amount, active_from: c.active_from, active_until: c.active_until || '' }; if (render) render(); };
  window.__setSbCancel = () => { _sb.ed = null; if (render) render(); };
  window.__setSbUser = (v) => { if (_sb.ed) { _sb.ed.user_id = String(v || ''); if (render) render(); } };
  function _sbSyncFromDom() {
    const e = _sb.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    const pct = q('[data-sb-field="percentage"]'); if (pct) e.percentage = Number(pct.value);
    const thr = q('[data-sb-field="threshold_amount"]'); if (thr) e.threshold_amount = Number(thr.value);
    const af  = q('[data-sb-field="active_from"]'); if (af) e.active_from = String(af.value || '');
    const au  = q('[data-sb-field="active_until"]'); if (au) e.active_until = String(au.value || '');
  }
  window.__setSbSave = () => {
    _sbSyncFromDom();
    const e = _sb.ed; if (!e) return;
    const isEdit = !!e.id;
    if (!isEdit && !e.user_id) { showToast('Kies een verkoper', 'warn'); return; }
    const pct = Number(e.percentage);
    const thr = Number(e.threshold_amount);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) { showToast('Percentage moet 0..100 zijn', 'warn'); return; }
    if (!Number.isFinite(thr) || thr < 0) { showToast('Threshold moet >= 0 zijn', 'warn'); return; }
    // Compute old vs new voor confirm-tekst.
    const orig = isEdit ? _sb.configs.find(x => x.id === e.id) : null;
    const changes = [];
    if (isEdit) {
      if (Number(orig.percentage) !== pct) changes.push(`percentage ${Number(orig.percentage).toFixed(2)}% → ${pct.toFixed(2)}%`);
      if (Number(orig.threshold_amount) !== thr) changes.push(`threshold €${Number(orig.threshold_amount).toFixed(2)} → €${thr.toFixed(2)}`);
      if ((orig.active_until || '') !== (e.active_until || '')) changes.push(`active_until ${orig.active_until || '(geen)'} → ${e.active_until || '(geen)'}`);
    }
    const salesName = (isEdit ? (orig?.profile?.full_name || orig?.profile?.email) : _sb.candidates.find(c => c.id === e.user_id)?.full_name) || 'onbekend';
    const msg = isEdit
      ? `Bonus-config wijzigen voor ${salesName}?\n\n${changes.join(' · ') || '(geen wijzigingen)'}\n\n💰 Nieuwe berekeningen gebruiken deze regels. Bestaande bonuses in de bonuses-tabel behouden hun snapshot en worden NIET herrekend.`
      : `Nieuwe bonus-config aanmaken voor ${salesName}?\n\nPercentage: ${pct.toFixed(2)}% · threshold: €${thr.toFixed(2)} · active_from: ${e.active_from}\n\n💰 Deze verkoper krijgt vanaf ${e.active_from} bonus over nieuwe down-payment-subs ≥ threshold.`;
    openConfirm(msg, async () => {
      _sb.busy = true; if (render) render();
      try {
        const url = isEdit ? '/api/sales-bonus-configs?id=' + encodeURIComponent(e.id) : '/api/sales-bonus-configs';
        const method = isEdit ? 'PATCH' : 'POST';
        const payload = isEdit
          ? { percentage: pct, threshold_amount: thr, active_until: e.active_until || null }
          : { user_id: e.user_id, percentage: pct, threshold_amount: thr, active_from: e.active_from };
        const j = await tryFetch('sb-save', url, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(isEdit ? 'Bonus-config bijgewerkt' : 'Bonus-config aangemaakt', 'ok');
        _sb.ed = null; _sb.fetched = false; fetchSalesBonus();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _sb.busy = false; if (render) render(); }
    }, isEdit ? 'warn' : undefined);
  };
  window.__setSbDeactivate = (id) => {
    const c = _sb.configs.find(x => x.id === id); if (!c) return;
    const name = c?.profile?.full_name || c?.profile?.email || 'onbekend';
    openConfirm(`Bonus-config voor ${name} deactiveren (soft-delete via active_until=vandaag)?\n\nHistorische bonusberekeningen behouden hun snapshot in bonuses-tabel. Nieuwe down-payment-subs berekenen geen bonus meer voor deze verkoper tot een nieuwe config wordt aangemaakt.`, async () => {
      _sb.busy = true; if (render) render();
      try {
        const j = await tryFetch('sb-del', '/api/sales-bonus-configs?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Bonus-config gedeactiveerd', 'ok');
        _sb.fetched = false; fetchSalesBonus();
      } catch (err) { showToast('Deactiveren mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _sb.busy = false; if (render) render(); }
    }, 'warn');
  };
  function _sbEditor() {
    const e = _sb.ed; if (!e) return '';
    const isEdit = !!e.id;
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setSbCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:560px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${isEdit ? 'Bonus-config bewerken' : 'Nieuwe bonus-config'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setSbCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
          <div style="padding:10px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:11.5px;line-height:1.55">
            <b>💰 Geld-impact.</b> Wijzigingen gelden voor NIEUWE down-payment-subs. Bestaande bonuses in <code>bonuses</code>-tabel behouden hun snapshot (percentage was gesnapshot op moment van deal-aanmaak).
          </div>
          <label style="font-size:11.5px;color:var(--text-2)">Verkoper ${isEdit ? '(vast bij edit)' : '<span style="color:var(--rose)">*</span>'}
            ${isEdit
              ? `<div style="margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text)">${esc((_sb.configs.find(x=>x.id===e.id)?.profile?.full_name) || '—')} <span style="color:var(--text-3);font-size:11px">(${esc((_sb.configs.find(x=>x.id===e.id)?.profile?.email) || '')})</span></div>`
              : `<select onchange="window.__setSbUser(this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
                  ${_sb.candidates.length ? _sb.candidates.map(c => `<option value="${esc(c.id)}"${c.id===e.user_id?' selected':''}>${esc(c.full_name || '—')} · ${esc(c.role)} · ${esc(c.email || '')}</option>`).join('') : `<option value="">Geen kandidaten (alle verkopers hebben al een actieve config)</option>`}
                </select>`}
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
            <label style="font-size:11.5px;color:var(--text-2)">Percentage (%) <span style="color:var(--rose)">*</span>
              <input type="number" min="0" max="100" step="0.01" data-sb-field="percentage" value="${esc(String(e.percentage ?? 3))}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Threshold (€) <span style="color:var(--rose)">*</span> <span style="color:var(--text-3)">— min. down-amount voor bonus</span>
              <input type="number" min="0" step="0.01" data-sb-field="threshold_amount" value="${esc(String(e.threshold_amount ?? 1000))}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Active from
              <input type="date" data-sb-field="active_from" value="${esc(e.active_from || '')}" ${isEdit?'readonly':''} style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            ${isEdit ? `<label style="font-size:11.5px;color:var(--text-2)">Active until (leeg = onbepaald)
              <input type="date" data-sb-field="active_until" value="${esc(e.active_until || '')}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>` : ''}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setSbCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_sb.busy?'disabled':''} onclick="window.__setSbSave()">${_sb.busy?'Bezig…':'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodySalesBonus() {
    // v=60: hard super_admin-gate. Server (api/sales-bonus-configs.js) is al
    // super_admin-only (isSuperAdmin() r59-60 + r88 op alle methodes), maar de
    // UI liet de sectie zichtbaar voor manager door "Bekijk als"-simulatie.
    // Nu: (a) SETS-item krijgt roles:['super_admin'] → nav-item verborgen voor
    // niet-super_admin; (b) body-gate als 2e laag voor als iemand alsnog via
    // route bij deze body komt (bv. direct S.setPage='sales-bonus' via console).
    if (!isSuperAdmin()) return bodyAccessDenied();
    if (!_sb.fetched && !_sb.loading) queueMicrotask(() => fetchSalesBonus());
    const today = new Date().toISOString().slice(0, 10);
    // Ronde-31 v=57: grens gelijk aan bonus-motor (sales-subscription-create.js r476):
    // actief = active_from <= today AND (active_until IS NULL OR active_until > today).
    // Strikte >. Deactiveren via active_until=today werkt daardoor direct — zelfde dag.
    const isActive = (c) => (c.active_from <= today) && (!c.active_until || c.active_until > today);
    const rows = _sb.configs.map(c => {
      const busy = _sb.busy && _sb.ed?.id === c.id;
      const active = isActive(c);
      const name = c?.profile?.full_name || '—';
      const email = c?.profile?.email || '';
      const role = c?.profile?.role || '—';
      return `<tr style="border-top:1px solid var(--border);${active?'':'opacity:.55'}">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(name)}${email?`<div style="font-size:11px;color:var(--text-3);font-weight:normal;margin-top:2px">${esc(email)}</div>`:''}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(role)}</td>
        <td style="padding:8px 12px;font-size:12.5px;text-align:right;font-family:'IBM Plex Mono',monospace">${Number(c.percentage).toFixed(2)}%</td>
        <td style="padding:8px 12px;font-size:12px;text-align:right;font-family:'IBM Plex Mono',monospace">€${Number(c.threshold_amount).toFixed(2)}</td>
        <td style="padding:8px 12px;font-size:11px;color:var(--text-3);white-space:nowrap">${esc(c.active_from || '')}</td>
        <td style="padding:8px 12px;font-size:11px;color:var(--text-3);white-space:nowrap">${esc(c.active_until || '')}</td>
        <td style="padding:8px 12px;font-size:11px">${active?'<span style="color:var(--emerald)">✓ actief</span>':'<span style="color:var(--text-3)">historie</span>'}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setSbEdit('${esc(c.id)}')" style="font-size:11px">Edit</button>
          ${active ? `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setSbDeactivate('${esc(c.id)}')" style="font-size:11px;color:var(--rose)">Deactiveer</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1200px">
      ${_sbEditor()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE bonus-config-editor · super_admin only.</b> Bonus wordt berekend op <code>sales-subscription-create.js</code> bij aanmaak van een down-payment-sub: leest MEEST RECENTE actieve config per <code>sales_user_id</code>, past <b>percentage</b> toe op down-amount als deze ≥ <b>threshold</b>. Bonus-record wordt <b>gesnapshot</b> in <code>bonuses</code>-tabel — bestaande bonuses veranderen NIET bij config-wijziging. Geen TL-sync. Motor onaangeraakt.
      </div>
      ${_sb.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_sb.error)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:12.5px;color:var(--text-3)">${_sb.configs.length} config(s) · ${_sb.configs.filter(isActive).length} actief · ${_sb.candidates.length} verkopers zonder actieve config</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__setSbReload()" style="font-size:11px">↻ Vernieuwen</button>
          <button class="btn btn-primary btn-sm" ${!_sb.candidates.length?'disabled':''} onclick="window.__setSbNew()" title="${!_sb.candidates.length?'Geen kandidaten':''}">➕ Nieuwe config</button>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:900px">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Verkoper</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Rol</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Percentage</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Threshold</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Vanaf</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Tot</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="8" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_sb.loading?'Laden…':'Geen bonus-configs'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }


  /* Ronde-31 grote-brok · agents-manager — READ-ONLY runtime-status + audit-log.
     DISCOVERY: /api/super-admin-ai-manager is POST-only Q&A-endpoint met hardcoded
     constants (MODEL_SQL_GEN, STATEMENT_TIMEOUT_MS=5000, MAX_ROWS_RETURNED=20,
     MAX_QUESTION_LEN=2000, rate-limit 10/uur/user, guard-rules in _lib/ai-query-
     guard.js). Er is GEEN ai_manager_config-tabel, geen app_settings-key, geen
     bewerkbare persona/kennis/autonomie. System-prompt wordt on-the-fly opgebouwd
     uit ai_readonly.v_schema_help. Autonomie=0: endpoint kan alleen SELECT op
     ai_readonly.* — writes zijn onmogelijk (DB-rol afdwingen). Config-editor
     native vraagt backend-refactor (tabel + endpoint aanpassing). Buiten scope.
     Sectie toont daarom: runtime-parameters info + laatste audit-log-entries. */
  const _am = { loading: false, fetched: false, error: null, audit: [] };
  async function fetchAmAudit() {
    if (_am.loading || _am.fetched) return;
    _am.loading = true; _am.error = null; if (render) render();
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const { data, error } = await window.supabase.from('agent_audit_log')
        .select('id, action, status, payload, result, error_message, created_at')
        .eq('agent_name', 'ai_manager')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      _am.audit = data || [];
    } catch (e) { _am.error = e?.message || 'onbekend'; }
    _am.loading = false; _am.fetched = true; if (render) render();
  }
  window.__setAmReload = () => { _am.fetched = false; fetchAmAudit(); };
  function bodyAgentsManager() {
    if (!_am.fetched && !_am.loading) queueMicrotask(() => fetchAmAudit());
    const auditRows = _am.audit.map(a => {
      const ok = a.status === 'success';
      const rows = a?.result?.row_count ?? '—';
      const tokens = a?.result?.tokens ? (typeof a.result.tokens === 'object' ? (a.result.tokens.total_tokens || a.result.tokens.input_tokens + a.result.tokens.output_tokens || '—') : a.result.tokens) : '—';
      const q = String(a?.payload?.question || '').slice(0, 100);
      const guard = a?.payload?.guard_verdict?.verdict || '—';
      return `<tr style="border-top:1px solid var(--border);${ok?'':'background:var(--rose-soft)'}">
        <td style="padding:6px 12px;font-size:11px;color:var(--text-3);white-space:nowrap">${esc(String(a.created_at || '').slice(0, 19).replace('T', ' '))}</td>
        <td style="padding:6px 12px;font-size:12px">${esc(q)}${a.payload?.question && a.payload.question.length > 100 ? '…' : ''}</td>
        <td style="padding:6px 12px;font-size:11px;text-align:center">${ok ? '<span style="color:var(--emerald)">✓</span>' : `<span style="color:var(--rose)" title="${esc(a.error_message||'')}">✗</span>`}</td>
        <td style="padding:6px 12px;font-size:11px;text-align:center">${esc(String(guard))}</td>
        <td style="padding:6px 12px;font-size:11px;text-align:right;font-family:'IBM Plex Mono',monospace">${rows}</td>
        <td style="padding:6px 12px;font-size:11px;text-align:right;font-family:'IBM Plex Mono',monospace">${tokens}</td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1100px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>READ-ONLY — geen config-tabel.</b> AI Manager is een Q&A-widget op het super-admin-dashboard. Alle gedrag (model, rate-limit, guard-rules, system-prompt) is <b>hardcoded in code</b>: er bestaat geen <code>ai_manager_config</code>-tabel of <code>app_settings</code>-key. <b>Autonomie=0</b>: endpoint kan alléén SELECT op <code>ai_readonly.*</code>-views (DB-rol afdwingen). Config bewerkbaar maken vraagt backend-refactor (nieuwe tabel + endpoint-aanpassing) — buiten scope zonder afstemming.
        <a href="/index.html" class="btn btn-ghost btn-sm" style="margin-left:10px;font-size:11px;text-decoration:none">Open dashboard (AI Manager-widget) →</a>
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Runtime-parameters (hardcoded)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:8px 20px;margin-bottom:16px;font-size:12.5px">
        <div><span style="color:var(--text-3)">Model (SQL-generatie): </span><code>claude-sonnet-4-6</code></div>
        <div><span style="color:var(--text-3)">Model (samenvatting): </span><code>claude-sonnet-4-6</code></div>
        <div><span style="color:var(--text-3)">Statement-timeout: </span><code>5000 ms</code></div>
        <div><span style="color:var(--text-3)">Max rijen per query: </span><code>20</code></div>
        <div><span style="color:var(--text-3)">Max vraag-lengte: </span><code>2000 chars</code></div>
        <div><span style="color:var(--text-3)">Rate-limit: </span><code>10 calls/uur/user</code></div>
        <div><span style="color:var(--text-3)">DB-rol: </span><code>ai_readonly</code> (write onmogelijk)</div>
        <div><span style="color:var(--text-3)">Toegang: </span><code>super_admin only</code></div>
        <div style="grid-column:1/-1"><span style="color:var(--text-3)">System-prompt-bron: </span><code>ai_readonly.v_schema_help</code> (view-metadata, on-the-fly)</div>
        <div style="grid-column:1/-1"><span style="color:var(--text-3)">Guard-rules: </span><code>api/_lib/ai-query-guard.js</code> (SELECT-only, whitelist views)</div>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <div style="font-size:13px;font-weight:600">Laatste 20 queries · <code>agent_audit_log</code></div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Read-only view op <code>agent_name='ai_manager'</code>. Rode rij = failed.</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.__setAmReload()" style="font-size:11px">↻ Vernieuwen</button>
      </div>
      ${_am.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:8px">⚠ ${esc(_am.error)}</div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:700px">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Wanneer</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Vraag</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:center;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Guard</th>
            <th style="text-align:right;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Rijen</th>
            <th style="text-align:right;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Tokens</th>
          </tr></thead>
          <tbody>${auditRows || `<tr><td colspan="6" style="padding:16px;color:var(--text-3);font-size:12px;text-align:center">${_am.loading?'Laden…':'Geen audit-entries voor ai_manager'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Ronde-31 grote-brok · sales-producten — products CRUD native.
     Endpoint: /api/sales-products (GET ?active=true / POST / PUT ?id / DELETE ?id soft).
     Permissions: sales.product.view (read) + sales.product.manage (write).
     DISCOVERY: endpoint doet ZUIVER DB-CRUD. Geen teamleader-call in POST/PUT/DELETE.
     tl_product_id-veld is enkel een REFERENCE voor inbound TL-sync (admin/tl-import-
     subscriptions.js matched op tl_product_id → onze product_id). Geen outbound push
     van default_price naar TL. Nieuwe deals lezen default_price bij aanmaak;
     bestaande deals hebben snapshot in deal_lines (analog aan traject_variants v=46).
     → Save = veilig, geen live TL-actie. Prijs-impact-notice in confirm. Motor onaangeraakt. */
  const _VAT = [0, 9, 21];
  // v=61 quick-fix 1: default filter 'active' (was 'all'). Gearchiveerde/inactieve
  // producten pas zichtbaar als user bewust op 'Alle' of 'Archief' klikt.
  const _sp = { loading: false, fetched: false, error: null, items: [], filterActive: 'active', ed: null, busy: false };
  async function fetchSalesProducten() {
    if (_sp.loading || _sp.fetched) return;
    _sp.loading = true; _sp.error = null; if (render) render();
    try {
      const j = await tryFetch('sp-list', '/api/sales-products');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _sp.items = j?.products || [];
    } catch (e) { _sp.error = e?.message || 'onbekend'; }
    _sp.loading = false; _sp.fetched = true; if (render) render();
  }
  window.__setSpReload = () => { _sp.fetched = false; fetchSalesProducten(); };
  window.__setSpFilter = (v) => { _sp.filterActive = v || 'all'; if (render) render(); };
  window.__setSpNew = () => {
    _sp.ed = { id: null, name: '', description: '', category: '', vat_percentage: 21, default_price: null, default_duration_months: null, tl_product_id: '', is_active: true, price_includes_vat: false };
    if (render) render();
  };
  window.__setSpEdit = (id) => { const p = _sp.items.find(x => x.id === id); if (!p) return; _sp.ed = { ...p, category: p.category || '', description: p.description || '', tl_product_id: p.tl_product_id || '' }; if (render) render(); };
  window.__setSpCancel = () => { _sp.ed = null; if (render) render(); };
  window.__setSpBool = (k, v) => { if (_sp.ed) { _sp.ed[k] = !!v; if (render) render(); } };
  window.__setSpVat  = (v) => { if (_sp.ed) { _sp.ed.vat_percentage = Number(v); if (render) render(); } };
  function _spSyncFromDom() {
    const e = _sp.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    ['name','description','category','tl_product_id'].forEach(k => { const el = q(`[data-sp-field="${k}"]`); if (el) e[k] = String(el.value || ''); });
    const pr = q('[data-sp-field="default_price"]'); if (pr) e.default_price = pr.value === '' ? null : Number(pr.value);
    const du = q('[data-sp-field="default_duration_months"]'); if (du) e.default_duration_months = du.value === '' ? null : (parseInt(du.value, 10) || null);
  }
  window.__setSpSave = () => {
    _spSyncFromDom();
    const e = _sp.ed; if (!e) return;
    if (!String(e.name || '').trim()) { showToast('Naam is verplicht', 'warn'); return; }
    if (!_VAT.includes(Number(e.vat_percentage))) { showToast('BTW% moet 0, 9 of 21 zijn', 'warn'); return; }
    if (e.default_price != null && !(Number(e.default_price) > 0)) { showToast('Prijs moet > 0 zijn (of leeg)', 'warn'); return; }
    if (e.default_duration_months != null) {
      const d = Number(e.default_duration_months);
      if (!Number.isFinite(d) || d < 1 || d > 120) { showToast('Duur moet 1..120 maanden zijn (of leeg)', 'warn'); return; }
    }
    const isEdit = !!e.id;
    const oldPrice = isEdit ? Number(_sp.items.find(x => x.id === e.id)?.default_price || 0) : null;
    const newPrice = e.default_price != null ? Number(e.default_price) : null;
    const priceChanged = isEdit && oldPrice !== newPrice;
    const priceNote = priceChanged
      ? ` ⚠ Prijs wijzigt van €${oldPrice.toFixed(2)} naar €${(newPrice||0).toFixed(2)}. Nieuwe offertes/deals gebruiken de nieuwe prijs; bestaande deals houden hun snapshot in deal_lines. TL-sync gebeurt NIET automatisch (tl_product_id is alleen inbound-reference).`
      : (isEdit ? '' : ' Nieuwe product staat direct beschikbaar voor de Sales-wizard indien actief.');
    const payload = {
      name: String(e.name).trim(),
      description: String(e.description || '').trim() || null,
      category: String(e.category || '').trim() || null,
      vat_percentage: Number(e.vat_percentage),
      default_price: newPrice,
      default_duration_months: e.default_duration_months || null,
      tl_product_id: String(e.tl_product_id || '').trim() || null,
      is_active: e.is_active !== false,
      price_includes_vat: !!e.price_includes_vat,
    };
    openConfirm(`${isEdit ? 'Wijzigingen opslaan voor product' : 'Nieuw product aanmaken:'} "${esc(payload.name)}"?${priceNote}`, async () => {
      _sp.busy = true; if (render) render();
      try {
        const url = isEdit
          ? '/api/sales-products?id=' + encodeURIComponent(e.id)
          : '/api/sales-products';
        const method = isEdit ? 'PUT' : 'POST';
        const j = await tryFetch('sp-save', url, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(isEdit ? 'Product bijgewerkt' : 'Product aangemaakt', 'ok');
        _sp.ed = null; _sp.fetched = false; fetchSalesProducten();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _sp.busy = false; if (render) render(); }
    }, priceChanged ? 'warn' : undefined);
  };
  window.__setSpDelete = (id) => {
    const p = _sp.items.find(x => x.id === id); if (!p) return;
    openConfirm(`Product "${esc(p.name)}" archiveren (soft-delete)? Rij blijft bewaard voor historische deals; is_active=false + archived_at=now(). Kan later via SQL geherreactiveerd worden. Bestaande deals met dit product behouden hun snapshot.`, async () => {
      _sp.busy = true; if (render) render();
      try {
        const j = await tryFetch('sp-del', '/api/sales-products?id=' + encodeURIComponent(id), { method: 'DELETE' });
        // DELETE returnt 204 (no content) — j kan null/empty zijn maar geen error.
        if (j && (j.__error || j.error)) throw new Error(j.__error || j.error);
        showToast('Product gearchiveerd', 'ok');
        _sp.fetched = false; fetchSalesProducten();
      } catch (err) { showToast('Archiveren mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _sp.busy = false; if (render) render(); }
    }, 'warn');
  };
  function _spEditor() {
    const e = _sp.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setSpCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'Product bewerken' : 'Nieuw product'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setSpCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
          <div style="grid-column:1/-1;padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55">
            <b>Geen TL-sync bij opslaan.</b> Prijs/BTW-wijzigingen leven in eigen DB. Nieuwe offertes lezen deze prijs; bestaande deals behouden snapshot in <code>deal_lines</code>. <code>tl_product_id</code> is een reference voor inbound TL-import (matcht sub van TL naar onze product), niet outbound.
          </div>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Naam <span style="color:var(--rose)">*</span> (max 200)
            <input type="text" data-sp-field="name" value="${esc(e.name || '')}" maxlength="200" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Categorie
            <input type="text" data-sp-field="category" value="${esc(e.category || '')}" placeholder="bv. e-book, cursus, consultancy" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">TL Product-ID (inbound-reference, optioneel)
            <input type="text" data-sp-field="tl_product_id" value="${esc(e.tl_product_id || '')}" placeholder="uuid uit TeamLeader" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Standaardprijs (€, leeg = variabel)
            <input type="number" min="0.01" step="0.01" data-sp-field="default_price" value="${esc(e.default_price != null ? String(e.default_price) : '')}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">BTW-percentage <span style="color:var(--rose)">*</span> <span style="color:var(--text-3)">— bewerkbaar; server-side valid = 0/9/21</span>
            <select data-sp-vat onchange="window.__setSpVat(this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
              ${_VAT.map(v => `<option value="${v}"${Number(e.vat_percentage) === v ? ' selected' : ''}>${v}% ${v===0?'(vrijgesteld)':v===9?'(verlaagd)':'(standaard)'}</option>`).join('')}
            </select>
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Standaardduur (mnd, 1-120, leeg=geen default)
            <input type="number" min="1" max="120" data-sp-field="default_duration_months" value="${esc(e.default_duration_months != null ? String(e.default_duration_months) : '')}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Beschrijving
            <textarea data-sp-field="description" rows="2" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.description || '')}</textarea>
          </label>
          <div style="grid-column:1/-1;display:flex;flex-direction:column;gap:6px">
            <label style="font-size:12px;display:flex;align-items:center;gap:6px"><input type="checkbox" ${e.is_active !== false ? 'checked' : ''} onchange="window.__setSpBool('is_active', this.checked)" /> Actief (selecteerbaar in Sales-wizard)</label>
            <label style="font-size:12px;display:flex;align-items:center;gap:6px"><input type="checkbox" ${e.price_includes_vat ? 'checked' : ''} onchange="window.__setSpBool('price_includes_vat', this.checked)" /> Prijs is inclusief BTW</label>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setSpCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_sp.busy ? 'disabled' : ''} onclick="window.__setSpSave()">${_sp.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodySalesProducten() {
    if (!_sp.fetched && !_sp.loading) queueMicrotask(() => fetchSalesProducten());
    const filtered = _sp.filterActive === 'active'
      ? _sp.items.filter(p => p.is_active && !p.archived_at)
      : _sp.filterActive === 'archived'
        ? _sp.items.filter(p => !!p.archived_at)
        : _sp.items;
    const rows = filtered.map(p => {
      const busy = _sp.busy && _sp.ed?.id === p.id;
      const active = p.is_active && !p.archived_at;
      const priceEur = p.default_price != null ? '€' + Number(p.default_price).toFixed(2) : '<span style="color:var(--text-3)">variabel</span>';
      return `<tr style="border-top:1px solid var(--border);${active ? '' : 'opacity:.55'}">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(p.name || '—')}${p.description ? `<div style="font-size:11px;color:var(--text-3);font-weight:normal;margin-top:2px">${esc(String(p.description).slice(0,80))}${p.description.length>80?'…':''}</div>` : ''}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(p.category || '—')}</td>
        <td style="padding:8px 12px;font-size:12px;text-align:right;font-family:'IBM Plex Mono',monospace">${priceEur}${p.price_includes_vat ? '<span style="font-size:10px;color:var(--text-3);margin-left:4px">incl</span>' : ''}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${Number(p.vat_percentage || 0)}%</td>
        <td style="padding:8px 12px;font-size:11px;text-align:center">${p.default_duration_months || '—'}</td>
        <td style="padding:8px 12px;font-size:11px">${p.tl_product_id ? `<code style="font-size:10.5px">${esc(String(p.tl_product_id).slice(0,10))}…</code>` : '<span style="color:var(--text-3)">—</span>'}</td>
        <td style="padding:8px 12px;font-size:11px">${active ? '<span style="color:var(--emerald)">✓ actief</span>' : (p.archived_at ? '<span style="color:var(--rose)">archief</span>' : '<span style="color:var(--text-3)">inactief</span>')}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setSpEdit('${esc(p.id)}')" style="font-size:11px">Edit</button>
          <button class="btn btn-ghost btn-sm" ${busy || !!p.archived_at?'disabled':''} onclick="window.__setSpDelete('${esc(p.id)}')" style="font-size:11px;color:var(--rose)" title="${p.archived_at?'Al gearchiveerd':''}">Archiveer</button>
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1300px">
      ${_spEditor()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE producten-editor.</b> <b>Geen TL-sync</b> — endpoint doet zuiver DB-CRUD. Prijs/BTW-wijzigingen gelden voor nieuwe offertes; bestaande deals behouden snapshot in <code>deal_lines</code>. Soft-delete via archived_at + is_active=false.
      </div>
      ${_sp.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_sp.error)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:12px;flex-wrap:wrap">
        <div style="display:flex;gap:6px;align-items:center">
          <label style="font-size:11.5px;color:var(--text-3)">Filter:</label>
          <select onchange="window.__setSpFilter(this.value)" style="padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
            <option value="all"${_sp.filterActive==='all'?' selected':''}>Alle (${_sp.items.length})</option>
            <option value="active"${_sp.filterActive==='active'?' selected':''}>Actief</option>
            <option value="archived"${_sp.filterActive==='archived'?' selected':''}>Archief</option>
          </select>
          <span style="font-size:11.5px;color:var(--text-3);margin-left:8px">${filtered.length} zichtbaar</span>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__setSpReload()" style="font-size:11px">↻ Vernieuwen</button>
          <button class="btn btn-primary btn-sm" onclick="window.__setSpNew()">➕ Nieuw product</button>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:900px">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Categorie</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Prijs</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">BTW</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Duur (mnd)</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">TL-ref</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="8" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_sp.loading?'Laden…':'Geen producten'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Ronde-31 grote-brok · mk-sequenties — onderhoud-trajecten native lijst + metadata-edit.
     Endpoints: /api/leadsonderhoud-trajecten (GET) + /api/leadsonderhoud-traject-opslaan
     (POST) + /api/leadsonderhoud-traject-verwijderen (POST {id}) + /api/leadsonderhoud-
     stap-opslaan (POST) + /api/leadsonderhoud-stap-verwijderen (POST {id}).
     Permission: leads.view (endpoints gebruiken deze bewust als gate).
     VERZENDING-ONDERZOEK: er is /api/leadsonderhoud-bulk-test-send (bulk-test-send.js)
     — verstuurt echte berichten (naar test-target). Sequenties draaien via cron die
     onderhoud_stappen matched op aanleiding + urgentie; actief=true zet een traject
     LIVE zodat de cron 'em pakt. Zetten van actief=true = LIVE-impact.
     NATIEVE scope: trajecten-metadata (naam/slug/omschrijving/agent/agenda_link/
     archief_na/volgorde/actief) + traject-actief-toggle + traject-delete (server-
     guard: cascade stappen ook weg) + stappen read-only lijst.
     DEEP-LINK: stap-editor (18 velden per stap incl. score-window/weekdag/tijdstip/
     alleen_ingelogd etc.) + test-send blijven Leadsonderhoud-module.
     Motor onaangeraakt (cron-leadsonderhoud + bulk-send-flow niet gewijzigd). */
  const _ms = { loading: false, fetched: false, error: null, trajecten: [], ed: null, busy: {} };
  async function fetchMkSequenties() {
    if (_ms.loading || _ms.fetched) return;
    _ms.loading = true; _ms.error = null; if (render) render();
    try {
      const j = await tryFetch('ms-trajecten', '/api/leadsonderhoud-trajecten');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _ms.trajecten = j?.trajecten || [];
    } catch (e) { _ms.error = e?.message || 'onbekend'; }
    _ms.loading = false; _ms.fetched = true; if (render) render();
  }
  window.__setMsReload = () => { _ms.fetched = false; fetchMkSequenties(); };
  window.__setMsEdit = (id) => { const t = _ms.trajecten.find(x => x.id === id); if (!t) return;
    _ms.ed = { id: t.id, naam: t.naam || '', slug: t.slug || '', omschrijving: t.omschrijving || '', agent: t.agent || '', agenda_link: t.agenda_link || '', archief_na: t.archief_na || 30, volgorde: t.volgorde || 1, actief: t.actief !== false };
    if (render) render();
  };
  window.__setMsNew = () => {
    _ms.ed = { id: null, naam: '', slug: '', omschrijving: '', agent: '', agenda_link: '', archief_na: 30, volgorde: 1, actief: false };
    if (render) render();
  };
  window.__setMsCancel = () => { _ms.ed = null; if (render) render(); };
  window.__setMsBool = (k, v) => { if (_ms.ed) { _ms.ed[k] = !!v; if (render) render(); } };
  function _msSyncFromDom() {
    const e = _ms.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    ['naam','slug','omschrijving','agent','agenda_link'].forEach(k => { const el = q(`[data-ms-field="${k}"]`); if (el) e[k] = String(el.value || ''); });
    const arch = q('[data-ms-field="archief_na"]'); if (arch) e.archief_na = Math.max(1, parseInt(arch.value, 10) || 30);
    const volg = q('[data-ms-field="volgorde"]');   if (volg) e.volgorde   = parseInt(volg.value, 10) || 1;
  }
  window.__setMsSave = () => {
    _msSyncFromDom();
    const e = _ms.ed; if (!e) return;
    if (!String(e.naam || '').trim()) { showToast('Naam is verplicht', 'warn'); return; }
    if (!String(e.slug || '').trim()) { showToast('Slug is verplicht', 'warn'); return; }
    if (!/^[a-z0-9_-]+$/.test(String(e.slug))) { showToast('Slug: alleen lowercase a-z, 0-9, _ en -', 'warn'); return; }
    const payload = {
      id: e.id || undefined,
      naam: e.naam.trim(), slug: e.slug.trim(),
      omschrijving: e.omschrijving.trim() || null,
      agent: e.agent.trim() || null,
      agenda_link: e.agenda_link.trim() || null,
      archief_na: e.archief_na, volgorde: e.volgorde, actief: !!e.actief,
    };
    const wasActief = e.id ? (_ms.trajecten.find(x => x.id === e.id)?.actief || false) : false;
    const isEdit = !!e.id;
    const activationNote = (!wasActief && payload.actief)
      ? ' ⚠ Actief-flag gaat AAN → cron-leadsonderhoud gaat de stappen matchen en berichten uitsturen zodra de aanleiding-triggers vuren.'
      : (wasActief && !payload.actief ? ' Actief-flag gaat UIT → geen nieuwe runs meer voor dit traject.' : '');
    openConfirm(`${isEdit ? 'Wijzigingen opslaan voor traject' : 'Nieuw traject aanmaken:'} "${esc(payload.naam)}" (slug: ${esc(payload.slug)})?${activationNote}`, async () => {
      _ms.busy[e.id || '_new'] = true; if (render) render();
      try {
        const j = await tryFetch('ms-save', '/api/leadsonderhoud-traject-opslaan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(isEdit ? 'Traject bijgewerkt' : 'Traject aangemaakt', 'ok');
        _ms.ed = null; _ms.fetched = false; fetchMkSequenties();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { delete _ms.busy[e.id || '_new']; if (render) render(); }
    }, (!wasActief && payload.actief) ? 'warn' : undefined);
  };
  window.__setMsToggle = (id) => {
    const t = _ms.trajecten.find(x => x.id === id); if (!t) return;
    const next = !t.actief;
    const stapN = Array.isArray(t.stappen) ? t.stappen.filter(s => s.actief).length : 0;
    const msg = next
      ? `Traject "${esc(t.naam)}" AANZETTEN? Zodra 'ie actief is, matcht de cron-leadsonderhoud de ${stapN} actieve stap(pen) en verstuurt automatisch berichten naar leads die aan de aanleiding voldoen. Ga alleen door als de stappen gereviewed zijn.`
      : `Traject "${esc(t.naam)}" UITZETTEN? Cron negeert dit traject; lopende runs draaien tot ze klaar zijn. Kan altijd weer aan.`;
    openConfirm(msg, async () => {
      _ms.busy[id] = true; if (render) render();
      try {
        const payload = { id: t.id, naam: t.naam, slug: t.slug, omschrijving: t.omschrijving, agent: t.agent, agenda_link: t.agenda_link, archief_na: t.archief_na, volgorde: t.volgorde, actief: next };
        const j = await tryFetch('ms-toggle', '/api/leadsonderhoud-traject-opslaan', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        // Optimistic:
        const i = _ms.trajecten.findIndex(x => x.id === id); if (i >= 0) _ms.trajecten[i] = { ..._ms.trajecten[i], actief: next };
        showToast(next ? 'Traject aan' : 'Traject uit', 'ok');
      } catch (e) { showToast('Toggle mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
      finally { delete _ms.busy[id]; if (render) render(); }
    }, next ? 'warn' : undefined);
  };
  window.__setMsDeleteBlocked = () => { showToast('Zet het traject eerst UIT vóór verwijderen', 'warn'); };
  window.__setMsDelete = (id) => {
    const t = _ms.trajecten.find(x => x.id === id); if (!t) return;
    if (t.actief) { showToast('Zet het traject eerst UIT vóór verwijderen', 'warn'); return; }
    const stapN = Array.isArray(t.stappen) ? t.stappen.length : 0;
    openConfirm(`Traject "${esc(t.naam)}" DEFINITIEF verwijderen? Cascade: ${stapN} stap(pen) wordt ook verwijderd. Kan niet ongedaan gemaakt worden.`, async () => {
      _ms.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('ms-del', '/api/leadsonderhoud-traject-verwijderen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _ms.trajecten = _ms.trajecten.filter(x => x.id !== id);
        showToast(`Verwijderd (${j?.stappen_verwijderd || 0} stappen ook weg)`, 'ok');
      } catch (e) { showToast('Verwijderen mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
      finally { delete _ms.busy[id]; if (render) render(); }
    }, 'warn');
  };
  function _msEditor() {
    const e = _ms.ed; if (!e) return '';
    const busy = _ms.busy[e.id || '_new'];
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setMsCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:640px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'Traject bewerken' : 'Nieuw traject'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setMsCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
          <div style="grid-column:1/-1;padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55"><b>Metadata alleen.</b> Individuele stappen (kanaal/aanleiding/timing/filters) beheer je in de Leadsonderhoud-module. Deze editor doet naam/slug/agent/agenda + actief-toggle.</div>
          <label style="font-size:11.5px;color:var(--text-2)">Naam <span style="color:var(--rose)">*</span>
            <input type="text" data-ms-field="naam" value="${esc(e.naam)}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Slug <span style="color:var(--rose)">*</span> <span style="color:var(--text-3)">(a-z, 0-9, _-)</span>
            <input type="text" data-ms-field="slug" value="${esc(e.slug)}" ${e.id ? 'readonly title="Slug niet wijzigen na aanmaak (endpoints gebruiken deze als key)"' : ''} style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Omschrijving
            <textarea data-ms-field="omschrijving" rows="2" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.omschrijving)}</textarea>
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Agent
            <input type="text" data-ms-field="agent" value="${esc(e.agent)}" placeholder="bv. lisa, sanne" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Agenda-link (voor call-CTA in berichten)
            <input type="url" data-ms-field="agenda_link" value="${esc(e.agenda_link)}" placeholder="https://..." style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Archief na (dagen sinds laatste contact)
            <input type="number" min="1" data-ms-field="archief_na" value="${esc(String(e.archief_na))}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Volgorde
            <input type="number" data-ms-field="volgorde" value="${esc(String(e.volgorde))}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <div style="grid-column:1/-1;padding:10px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:11.5px">
            <label style="display:flex;align-items:center;gap:6px"><input type="checkbox" ${e.actief ? 'checked' : ''} onchange="window.__setMsBool('actief', this.checked)" /> <b>Actief</b> — als AAN: cron matcht stappen en verstuurt berichten. Nieuwe trajecten default UIT.</label>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setMsCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setMsSave()">${busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodyMkSequenties() {
    if (!_ms.fetched && !_ms.loading) queueMicrotask(() => fetchMkSequenties());
    const rows = _ms.trajecten.map(t => {
      const busy = !!_ms.busy[t.id];
      const stappen = Array.isArray(t.stappen) ? t.stappen : [];
      const activeStappen = stappen.filter(s => s.actief).length;
      return `<tr style="border-top:1px solid var(--border);${t.actief ? '' : 'opacity:.65'}">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(t.naam || '(zonder naam)')}${t.agent ? `<div style="font-size:11px;color:var(--text-3);font-weight:normal;margin-top:2px">agent: ${esc(t.agent)}</div>` : ''}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(t.slug || '—')}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${activeStappen}/${stappen.length}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${t.archief_na || '—'}</td>
        <td style="padding:8px 12px">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMsToggle('${esc(t.id)}')" style="font-size:11px;color:${t.actief?'var(--emerald)':'var(--text-3)'}">${t.actief ? '✓ AAN' : '⨯ UIT'}</button>
        </td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMsEdit('${esc(t.id)}')" style="font-size:11px">Edit-meta</button>
          <a href="/modules/klanten-v2/?v2preview=automatiseringen&v2tab=Leadsonderhoud&edit_ls_traj=${encodeURIComponent(t.id)}" class="btn btn-ghost btn-sm" style="font-size:11px;text-decoration:none" title="Opent de Automatiseringen v2-editor voor dit traject">Stappen ↗</a>
          ${t.actief
            ? _disabledUitKnop('Verwijder', 'Zet het traject eerst UIT vóór verwijderen', 'font-size:11px;color:var(--rose)')
            : `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMsDelete('${esc(t.id)}')" style="font-size:11px;color:var(--rose)">Verwijder</button>`}
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1200px">
      ${_msEditor()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE-lijst met onderhoud-trajecten.</b> Hier: metadata bewerken (naam/slug/agent/agenda/archief/volgorde) + aan/uit-toggle + delete. <b>Stappen-editor</b> (alle 18 velden: kanaal/aanleiding/timing/filters/quiz-koppeling) zit in de Automatiseringen v2-module (Leadsonderhoud-tab · zelfde shell, geen sprong naar v1). Test-send verstuurt écht via bulk-test-send. Klik "Stappen ↗" per rij om direct de editor voor dit traject te openen.
        <a href="/modules/klanten-v2/?v2preview=automatiseringen&v2tab=Leadsonderhoud" class="btn btn-ghost btn-sm" style="margin-left:10px;font-size:11px;text-decoration:none">Open Automatiseringen v2 →</a>
      </div>
      ${_ms.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_ms.error)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:12.5px;color:var(--text-3)">${_ms.trajecten.length} traject(en) · ${_ms.trajecten.filter(t=>t.actief).length} actief</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__setMsReload()" style="font-size:11px">↻ Vernieuwen</button>
          <button class="btn btn-primary btn-sm" onclick="window.__setMsNew()">➕ Nieuw traject</button>
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam / agent</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Slug</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Stappen (act/tot)</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Archief-na (d)</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_ms.loading?'Laden…':'Geen trajecten'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Ronde-31 grote-brok · agents-kennis — KB-artikelen native CRUD + promote-to-agent.
     Endpoints: /api/kennisbank-artikelen (GET ?q&categorie&agent&limit / POST /
     PATCH ?id / DELETE ?id) + /api/kennisbank-promote-to-agent (POST). Permission:
     admin.joost_config. Schema: onderwerp (max 200) · categorie (max 40) · content
     (max 10000) · agents[] (subset joost/simone/mila/lisa) · usage_count. Fail-soft
     503 MIGRATION_MISSING als tabel nog niet bestaat (nette in-page banner).
     Motor onaangeraakt (agents lezen KB read-only via bestaande queries). */
  const _KB_AGENTS = ['joost','simone','mila','lisa'];
  const _kb = {
    loading: false, fetched: false, error: null, migrationMissing: false,
    items: [], filterQ: '', filterCat: '', filterAgent: '',
    ed: null, busy: false, promoteFor: null,
  };
  async function fetchKbArtikelen() {
    if (_kb.loading || _kb.fetched) return;
    _kb.loading = true; _kb.error = null; _kb.migrationMissing = false; if (render) render();
    try {
      const params = new URLSearchParams();
      if (_kb.filterQ)     params.set('q', _kb.filterQ);
      if (_kb.filterCat)   params.set('categorie', _kb.filterCat);
      if (_kb.filterAgent) params.set('agent', _kb.filterAgent);
      params.set('limit', '500');
      const j = await tryFetch('kb-art', '/api/kennisbank-artikelen?' + params.toString());
      if (j?.code === 'MIGRATION_MISSING') { _kb.migrationMissing = true; }
      else if (j?.__error || j?.error) { throw new Error(j?.__error || j?.error); }
      else _kb.items = j?.items || [];
    } catch (e) { _kb.error = e?.message || 'onbekend'; }
    _kb.loading = false; _kb.fetched = true; if (render) render();
  }
  window.__setKbReload = () => { _kb.fetched = false; fetchKbArtikelen(); };
  window.__setKbFilterAgent = (v) => { _kb.filterAgent = String(v || ''); _kb.fetched = false; fetchKbArtikelen(); };
  window.__setKbNew  = () => { _kb.ed = { id: null, onderwerp: '', categorie: '', content: '', agents: [] }; if (render) render(); };
  window.__setKbEdit = (id) => { const it = _kb.items.find(x => x.id === id); if (!it) return; _kb.ed = { ...it, agents: Array.isArray(it.agents) ? it.agents.slice() : [] }; if (render) render(); };
  window.__setKbCancel = () => { _kb.ed = null; if (render) render(); };
  // Ronde-31 v=53 FIX A: sync-first VOOR checkbox-toggle triggert een render.
  // Voorheen ging het typen in onderwerp/content verloren omdat de re-render de
  // input-nodes vervangt en state nog niet gesynct was. Zelfde patroon als
  // _lcSyncFromDom (Lisa v=44) + _tvSyncFromDom (trajecten v=46).
  window.__setKbAgent = (a, on) => {
    if (!_kb.ed) return;
    _kbSyncFromDom();
    _kb.ed.agents = _kb.ed.agents.filter(x => x !== a);
    if (on) _kb.ed.agents.push(a);
    if (render) render();
  };
  function _kbSyncFromDom() {
    if (!_kb.ed) return;
    const q = (sel) => document.querySelector(sel);
    ['onderwerp','categorie','content'].forEach(k => { const el = q(`[data-kb-field="${k}"]`); if (el) _kb.ed[k] = String(el.value || ''); });
  }
  window.__setKbSave = () => {
    _kbSyncFromDom();
    const e = _kb.ed; if (!e) return;
    if (!String(e.onderwerp || '').trim()) { showToast('Onderwerp is verplicht', 'warn'); return; }
    if (String(e.onderwerp).length > 200)  { showToast('Onderwerp max 200 tekens', 'warn'); return; }
    if (String(e.categorie || '').length > 40) { showToast('Categorie max 40 tekens', 'warn'); return; }
    if (String(e.content || '').length > 10000) { showToast('Content max 10000 tekens', 'warn'); return; }
    const payload = {
      onderwerp: String(e.onderwerp).trim(),
      categorie: String(e.categorie || '').trim() || null,
      content:   String(e.content || ''),
      agents:    (e.agents || []).filter(a => _KB_AGENTS.includes(a)),
    };
    const isEdit = !!e.id;
    const agentNote = payload.agents.length
      ? ' Gekoppeld aan: ' + payload.agents.join(', ')
      : ' (geen agents gekoppeld — artikel is inert tot koppeling of promote).';
    openConfirm(`${isEdit ? 'Wijzigingen opslaan voor artikel' : 'Nieuw KB-artikel aanmaken:'} "${esc(payload.onderwerp)}"?${agentNote}`, async () => {
      _kb.busy = true; if (render) render();
      try {
        const url = isEdit
          ? '/api/kennisbank-artikelen?id=' + encodeURIComponent(e.id)
          : '/api/kennisbank-artikelen';
        const method = isEdit ? 'PATCH' : 'POST';
        const j = await tryFetch('kb-save', url, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(isEdit ? 'Artikel bijgewerkt' : 'Artikel aangemaakt', 'ok');
        _kb.ed = null; _kb.fetched = false; fetchKbArtikelen();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _kb.busy = false; if (render) render(); }
    });
  };
  window.__setKbDelete = (id) => {
    const it = _kb.items.find(x => x.id === id); if (!it) return;
    openConfirm(`Artikel "${esc(it.onderwerp)}" DEFINITIEF verwijderen?${(it.agents||[]).length ? ` Wordt uit ${it.agents.length} agent-KB('s) losgekoppeld.` : ''} Kan niet ongedaan gemaakt worden.`, async () => {
      try {
        const j = await tryFetch('kb-del', '/api/kennisbank-artikelen?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Artikel verwijderd', 'ok');
        _kb.fetched = false; fetchKbArtikelen();
      } catch (err) { showToast('Verwijderen mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
    }, 'warn');
  };
  window.__setKbPromoteOpen  = (id) => { _kb.promoteFor = id; if (render) render(); };
  window.__setKbPromoteClose = () => { _kb.promoteFor = null; if (render) render(); };
  window.__setKbPromote = (id, target) => {
    const it = _kb.items.find(x => x.id === id); if (!it || !_KB_AGENTS.includes(target)) return;
    openConfirm(`Artikel "${esc(it.onderwerp)}" promoten naar de kennisbank van agent "${target}"? Dit voegt het artikel toe aan het agents[]-veld én update de agent-config zodat de agent 't kan gebruiken bij het genereren van antwoorden. Bumped usage_count.`, async () => {
      _kb.busy = true; _kb.promoteFor = null; if (render) render();
      try {
        const j = await tryFetch('kb-promote', '/api/kennisbank-promote-to-agent', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artikel_id: id, target_agent: target }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(`Gepromoot naar ${target}`, 'ok');
        _kb.fetched = false; fetchKbArtikelen();
      } catch (err) { showToast('Promoten mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _kb.busy = false; if (render) render(); }
    });
  };
  function _kbEditor() {
    const e = _kb.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setKbCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'KB-artikel bewerken' : 'Nieuw KB-artikel'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:12px">
          <label style="font-size:11.5px;color:var(--text-2)">Onderwerp <span style="color:var(--rose)">*</span> <span style="color:var(--text-3)">(max 200)</span>
            <input type="text" data-kb-field="onderwerp" value="${esc(e.onderwerp || '')}" maxlength="200" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Categorie <span style="color:var(--text-3)">(max 40, optioneel)</span>
            <input type="text" data-kb-field="categorie" value="${esc(e.categorie || '')}" maxlength="40" placeholder="bv. verkoop, faq, prijzen" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Content <span style="color:var(--text-3)">(max 10000 — markdown/tekst voor RAG)</span>
            <textarea data-kb-field="content" rows="10" maxlength="10000" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.content || '')}</textarea>
          </label>
          <div>
            <div style="font-size:11.5px;color:var(--text-2);margin-bottom:6px">Gekoppelde agents <span style="color:var(--text-3)">— wie mag dit artikel gebruiken</span></div>
            <div style="display:flex;gap:14px;flex-wrap:wrap">
              ${_KB_AGENTS.map(a => `<label style="font-size:12px;display:flex;align-items:center;gap:6px"><input type="checkbox" ${e.agents.includes(a) ? 'checked' : ''} onchange="window.__setKbAgent('${a}', this.checked)" /> ${a}</label>`).join('')}
            </div>
            <div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Alleen artikelen die aan een agent zijn gekoppeld worden gebruikt bij het genereren. Alternatief: promoot via de knop in de lijst (bumpt usage_count).</div>
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_kb.busy ? 'disabled' : ''} onclick="window.__setKbSave()">${_kb.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function _kbPromoteModal() {
    if (!_kb.promoteFor) return '';
    const it = _kb.items.find(x => x.id === _kb.promoteFor); if (!it) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setKbPromoteClose()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:440px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div><div style="font-size:14px;font-weight:600">Promoot naar agent</div><div style="font-size:11px;color:var(--text-3)">Artikel: ${esc(it.onderwerp)}</div></div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbPromoteClose()">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:8px">
          <div style="font-size:12px;color:var(--text-3);margin-bottom:4px">Kies doel-agent. Al gekoppeld: <b>${(it.agents||[]).join(', ') || '—'}</b></div>
          ${_KB_AGENTS.map(a => `<button class="btn btn-ghost btn-sm" onclick="window.__setKbPromote('${esc(it.id)}', '${a}')" style="font-size:12.5px;text-align:left;justify-content:flex-start;padding:8px 12px">→ ${a}${(it.agents||[]).includes(a) ? ' <span style="color:var(--text-3);font-size:10.5px">(al gekoppeld — updatet config)</span>' : ''}</button>`).join('')}
        </div>
      </div>
    </div>`;
  }
  function bodyKbArtikelen() {
    if (!_kb.fetched && !_kb.loading) queueMicrotask(() => fetchKbArtikelen());
    if (_kb.migrationMissing) {
      return `<div style="max-width:900px"><div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:13px;line-height:1.55"><b>Tabel <code>kennisbank_artikelen</code> bestaat nog niet.</b><br>Draai migratie <code>docs/sql-migrations/2026-08-13-kennisbank-artikelen.sql</code> in Supabase SQL-editor om de KB-editor te activeren.</div></div>`;
    }
    const rows = _kb.items.map(it => {
      const agents = (it.agents || []).length ? (it.agents||[]).map(a => `<span style="padding:1px 6px;border-radius:5px;background:var(--violet-soft);color:var(--violet);font-size:10px;font-weight:600;margin-right:3px">${esc(a)}</span>`).join('') : '<span style="font-size:10.5px;color:var(--text-3)">(geen)</span>';
      const preview = String(it.content || '').replace(/\s+/g, ' ').slice(0, 90);
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600;max-width:280px">${esc(it.onderwerp || '(zonder titel)')}${preview ? `<div style="font-size:11px;color:var(--text-3);font-weight:normal;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(preview)}${it.content && it.content.length > 90 ? '…' : ''}</div>` : ''}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(it.categorie || '—')}</td>
        <td style="padding:8px 12px">${agents}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);text-align:center">${it.usage_count || 0}</td>
        <td style="padding:8px 12px;font-size:11px;color:var(--text-3);white-space:nowrap">${esc(String(it.updated_at || '').slice(0,10))}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbEdit('${esc(it.id)}')" style="font-size:11px">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbPromoteOpen('${esc(it.id)}')" style="font-size:11px;color:var(--violet)">→ Promote</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__setKbDelete('${esc(it.id)}')" style="font-size:11px;color:var(--rose)">Verwijder</button>
        </td>
      </tr>`;
    }).join('');
    const agentOpts = ['', ..._KB_AGENTS].map(a => `<option value="${a}"${a === _kb.filterAgent ? ' selected' : ''}>${a ? 'agent: '+a : 'alle agents'}</option>`).join('');
    return `<div style="max-width:1200px">
      ${_kbEditor()}
      ${_kbPromoteModal()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE KB-editor.</b> Artikelen worden door agents (Joost/Lisa/Simone/Mila) opgehaald via RAG. Koppel expliciet aan agent via checkbox OF gebruik <b>→ Promote</b> voor gecontroleerde toevoeging (bumpt usage_count + updatet agent-config).
      </div>
      ${_kb.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_kb.error)}</div>` : ''}
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        <select onchange="window.__setKbFilterAgent(this.value)" style="padding:5px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">${agentOpts}</select>
        <span style="font-size:11.5px;color:var(--text-3);flex:1">${_kb.items.length} artikel(en)</span>
        <button class="btn btn-ghost btn-sm" onclick="window.__setKbReload()" style="font-size:11px">↻ Vernieuwen</button>
        <button class="btn btn-primary btn-sm" onclick="window.__setKbNew()">➕ Nieuw artikel</button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Onderwerp</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Categorie</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Agents</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Usage</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Updated</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_kb.loading?'Laden…':'Geen artikelen'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Ronde-31 grote-brok · ev-auto — event-automations native lijst + metadata-edit.
     Endpoints: /api/events-automations-list (GET), /api/events-automation-save (POST
     full-replace), /api/events-automation-delete (POST {id}). Steps-editor + test-
     run blijven DEEP-LINK naar Automatiseringen-module.
     TEST-RUN-ONDERZOEK: /api/events-automation-test IS GEEN dry-run — het INSERT'et
     een echte is_test=true attendee en de engine verstuurt daadwerkelijk berichten
     (verkorte wait 15s). De bestaande Automatiseringen-module heeft een modal met
     hardgekozen eigen-email/nummer als test-target. Compact porten van die flow
     is te risicovol voor deze commit — deep-link naar Automatiseringen behouden.
     Endpoint events-automation-save is FULL-REPLACE: partial update (bv. enable-toggle)
     vraagt dat we alle bestaande velden meesturen. Op basis van de row uit list. */
  const _EA_TRIGGERS = ['on_signup','on_switch_in','on_switch_out','on_no_show','on_attended','on_final_no_show','on_ticket_purchase','on_assessment_not_completed_after'];
  const _EA_SCOPES   = ['all','niveau','events'];
  const _EA_MODES    = ['prospective_only','all_current','all_current_and_new'];
  const _ea = { loading: false, fetched: false, error: null, items: [], busy: {}, ed: null };
  async function fetchEvAutos() {
    if (_ea.loading || _ea.fetched) return;
    _ea.loading = true; _ea.error = null; if (render) render();
    try {
      const j = await tryFetch('ev-autos-list', '/api/events-automations-list');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _ea.items = j?.automations || [];
    } catch (e) { _ea.error = e?.message || 'onbekend'; }
    _ea.loading = false; _ea.fetched = true; if (render) render();
  }
  // Save-endpoint is full-replace. Bij een enable-toggle of metadata-edit moeten we
  // ALLE bestaande velden meesturen (steps intact laten).
  async function _eaFullReplaceSave(row, overrides) {
    const payload = {
      id: row.id,
      name: row.name,
      description: row.description || '',
      trigger_type: row.trigger_type,
      trigger_config: row.trigger_config || {},
      scope_type: row.scope_type,
      scope_config: row.scope_config || {},
      enroll_mode: row.enroll_mode,
      enabled: !!row.enabled,
      steps: row.steps || [],
      ...overrides,
    };
    const j = await tryFetch('ev-auto-save', '/api/events-automation-save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
    return j?.automation;
  }
  window.__setEaToggle = (id) => {
    const a = _ea.items.find(x => x.id === id); if (!a) return;
    const next = !a.enabled;
    const stepCount = Array.isArray(a.steps) ? a.steps.length : 0;
    const msg = next
      ? `Automation "${esc(a.name || 'zonder naam')}" AANZETTEN? Zodra 'ie live is, triggert de engine bij elke passende ${esc(a.trigger_type)}-event en verstuurt de ${stepCount} stap(pen) — inclusief mails/WA-berichten. Ga hier ALLEEN mee door als de flow gereviewed en getest is.`
      : `Automation "${esc(a.name || 'zonder naam')}" UITZETTEN? Nieuwe events triggeren geen runs meer; lopende runs draaien tot ze klaar zijn. Kan altijd weer aan.`;
    openConfirm(msg, async () => {
      _ea.busy[id] = true; if (render) render();
      try {
        const upd = await _eaFullReplaceSave(a, { enabled: next });
        // Optimistic replace in state:
        const i = _ea.items.findIndex(x => x.id === id); if (i >= 0) _ea.items[i] = upd || { ..._ea.items[i], enabled: next };
        showToast(next ? 'Automation aan' : 'Automation uit', 'ok');
      } catch (e) { showToast('Toggle mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
      finally { delete _ea.busy[id]; if (render) render(); }
    }, next ? 'warn' : undefined);
  };
  window.__setEaDelete = (id) => {
    const a = _ea.items.find(x => x.id === id); if (!a) return;
    if (a.enabled) { showToast('Zet de automation eerst UIT vóór verwijderen', 'warn'); return; }
    openConfirm(`Automation "${esc(a.name || 'zonder naam')}" DEFINITIEF verwijderen? Historische runs blijven in event_automation_runs; deze definitie wordt niet meer getriggerd.`, async () => {
      _ea.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('ev-auto-del', '/api/events-automation-delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _ea.items = _ea.items.filter(x => x.id !== id);
        showToast('Verwijderd', 'ok');
      } catch (e) { showToast('Verwijderen mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
      finally { delete _ea.busy[id]; if (render) render(); }
    }, 'warn');
  };
  window.__setEaEditMeta = (id) => {
    const a = _ea.items.find(x => x.id === id); if (!a) return;
    _ea.ed = { id: a.id, name: a.name || '', description: a.description || '', enroll_mode: a.enroll_mode || 'prospective_only' };
    if (render) render();
  };
  window.__setEaEditCancel = () => { _ea.ed = null; if (render) render(); };
  window.__setEaEditMode = (v) => { if (_ea.ed) _ea.ed.enroll_mode = String(v || 'prospective_only'); };
  window.__setEaEditSave = () => {
    if (!_ea.ed) return;
    const q = (sel) => document.querySelector(sel);
    const nm = q('[data-ea-field="name"]'); if (nm) _ea.ed.name = String(nm.value || '');
    const ds = q('[data-ea-field="description"]'); if (ds) _ea.ed.description = String(ds.value || '');
    const em = q('[data-ea-field="enroll_mode"]'); if (em) _ea.ed.enroll_mode = String(em.value || 'prospective_only');
    const e = _ea.ed;
    if (!String(e.name || '').trim()) { showToast('Naam is verplicht', 'warn'); return; }
    const a = _ea.items.find(x => x.id === e.id); if (!a) return;
    openConfirm(`Metadata bijwerken voor "${esc(e.name)}"? Stappen/trigger/scope blijven ongewijzigd — alleen naam, beschrijving en enroll-mode worden aangepast.`, async () => {
      _ea.busy[e.id] = true; if (render) render();
      try {
        const upd = await _eaFullReplaceSave(a, { name: e.name.trim(), description: e.description.trim(), enroll_mode: e.enroll_mode });
        const i = _ea.items.findIndex(x => x.id === e.id); if (i >= 0) _ea.items[i] = upd || _ea.items[i];
        showToast('Metadata bijgewerkt', 'ok');
        _ea.ed = null;
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { delete _ea.busy[e.id]; if (render) render(); }
    });
  };
  function _eaRenderEditor() {
    const e = _ea.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setEaEditCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:640px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">Metadata bewerken · automation</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setEaEditCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;display:flex;flex-direction:column;gap:12px">
          <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55">
            <b>Alleen naam/beschrijving/enroll-mode.</b> Stappen, trigger, scope en aan/uit-staat blijven ongewijzigd — die vragen de volledige editor (Automatiseringen-module).
          </div>
          <label style="font-size:11.5px;color:var(--text-2)">Naam <span style="color:var(--rose)">*</span>
            <input type="text" data-ea-field="name" value="${esc(e.name)}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Beschrijving (max 2000)
            <textarea data-ea-field="description" rows="3" maxlength="2000" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.description)}</textarea>
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Enroll-mode <span style="color:var(--text-3)">— wie krijgt de flow bij activatie</span>
            <select data-ea-field="enroll_mode" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
              ${_EA_MODES.map(m => `<option value="${m}"${m===e.enroll_mode?' selected':''}>${m}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setEaEditCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_ea.busy[e.id] ? 'disabled' : ''} onclick="window.__setEaEditSave()">${_ea.busy[e.id] ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodyEvAuto() {
    if (!_ea.fetched && !_ea.loading) queueMicrotask(() => fetchEvAutos());
    const chip = (txt, tone) => `<span style="padding:2px 7px;border-radius:6px;background:var(--${tone}-soft);color:var(--${tone});font-size:10.5px;font-weight:600">${esc(txt)}</span>`;
    const rows = _ea.items.map(a => {
      const busy = !!_ea.busy[a.id];
      const stepN = Array.isArray(a.steps) ? a.steps.length : 0;
      return `<tr style="border-top:1px solid var(--border);${a.enabled ? '' : 'opacity:.65'}">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(a.name || '(zonder naam)')}${a.description ? `<div style="font-size:11px;color:var(--text-3);font-weight:normal;margin-top:2px">${esc(String(a.description).slice(0, 90))}${a.description.length>90?'…':''}</div>` : ''}</td>
        <td style="padding:8px 12px">${chip(a.trigger_type || '—', 'violet')}</td>
        <td style="padding:8px 12px">${chip(a.scope_type || 'all', 'teal')}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${stepN}</td>
        <td style="padding:8px 12px">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setEaToggle('${esc(a.id)}')" style="font-size:11px;color:${a.enabled?'var(--emerald)':'var(--text-3)'}">${a.enabled ? '✓ AAN' : '⨯ UIT'}</button>
        </td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          <button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setEaEditMeta('${esc(a.id)}')" style="font-size:11px">Edit-meta</button>
          <a href="/modules/klanten-v2/?v2preview=automatiseringen&v2tab=Events&edit_ev_auto=${encodeURIComponent(a.id)}" class="btn btn-ghost btn-sm" style="font-size:11px;text-decoration:none" title="Opent de Automatiseringen v2-editor voor deze flow">Stappen ↗</a>
          ${a.enabled
            ? _disabledUitKnop('Verwijder', 'Zet de automation eerst UIT vóór verwijderen', 'font-size:11px;color:var(--rose)')
            : `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setEaDelete('${esc(a.id)}')" style="font-size:11px;color:var(--rose)">Verwijder</button>`}
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1200px">
      ${_eaRenderEditor()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE-lijst met event-automations.</b> Hier: metadata bewerken (naam/beschrijving/enroll-mode), aan/uit-toggle, verwijderen. <b>Stappen-editor + test-run</b> zitten in de Automatiseringen v2-module (Events-tab · zelfde shell, geen sprong naar v1). Test-run stuurt échte berichten naar een test-attendee met is_test=true — GEEN dry-run. Klik "Stappen ↗" per rij om direct de editor voor die flow te openen.
        <a href="/modules/klanten-v2/?v2preview=automatiseringen&v2tab=Events" class="btn btn-ghost btn-sm" style="margin-left:10px;font-size:11px;text-decoration:none">Open Automatiseringen v2 →</a>
      </div>
      ${_ea.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_ea.error)}</div>` : ''}
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:8px">${_ea.items.length} automation(s) — ${_ea.items.filter(a=>a.enabled).length} actief · ${_ea.items.filter(a=>!a.enabled).length} uit</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Trigger</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Scope</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Stappen</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="6" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_ea.loading?'Laden…':'Geen automations gevonden'}</td></tr>`}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:11px;color:var(--text-3);line-height:1.55"><b>Nieuw aanmaken</b> vraagt trigger+scope+stappen — dat gaat via de Automatiseringen-wizard. Hier zie je alle bestaande definities.</div>
    </div>`;
  }

  /* Ronde-31 grote-brok · sales-trajecten — variant CRUD native.
     Endpoints: /api/traject-variants (GET ?variant_id / POST / PUT ?id / DELETE ?id)
     + /api/sales-products (GET voor product-picker). Permissions:
     sales.product.view (read) + sales.product.manage (write).
     TL-SYNC-ONDERZOEK: endpoint /api/traject-variants doet ZUIVER DB-CRUD (geen
     teamleader-call). Prijzen zitten NIET op variants maar op `products` (via
     `traject_variant_products`-koppeltabel met quantity). Product-CRUD (met prijs)
     leeft in `/api/sales-products`; variants beheren zelf geen prijzen — alleen
     naam/duur/product-koppelingen. Nieuwe deals gebruiken automatisch de nieuwste
     product-prijs (geen sync-actie nodig). Bestaande deals hebben snapshot.
     → Save = veilig, geen live TL-actie. Notice-banner legt dit uit; product-prijs-
     editor blijft in Sales (products = aparte scope). Motor onaangeraakt.
     FREEZE-LES: uncontrolled inputs met data-tv-*-attrs; dynamische product-koppel-
     lijst re-rendert alleen bij add/remove; typen = geen render. */
  const _tr = {
    loading: false, fetched: false, error: null,
    trajects: [], variants: [], products: [],   // 3 read-lijsten
    ed: null, busy: false,                       // modal-state (id=null → nieuw)
  };
  async function fetchTrajecten() {
    if (_tr.loading || _tr.fetched) return;
    _tr.loading = true; _tr.error = null; if (render) render();
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const [tRes, vRes, pRes] = await Promise.all([
        window.supabase.from('trajects').select('id, name').order('name'),
        window.supabase.from('traject_variants').select('id, name, traject_id, default_duration_months, description, display_order, is_default, is_active').order('display_order'),
        tryFetch('sales-products', '/api/sales-products?active=true'),
      ]);
      if (tRes.error) throw tRes.error;
      if (vRes.error) throw vRes.error;
      if (pRes?.__error || pRes?.error) throw new Error(pRes?.__error || pRes?.error);
      const tById = {};
      for (const t of (tRes.data || [])) tById[t.id] = t.name;
      _tr.trajects = tRes.data || [];
      _tr.variants = (vRes.data || []).map(v => ({ ...v, traject_name: tById[v.traject_id] || '—' }))
        .sort((a,b) => (a.traject_name||'').localeCompare(b.traject_name||'') || (a.display_order||0) - (b.display_order||0) || (a.name||'').localeCompare(b.name||''));
      _tr.products = pRes?.products || [];
    } catch (e) { _tr.error = e?.message || 'onbekend'; }
    _tr.loading = false; _tr.fetched = true; if (render) render();
  }
  async function _tvLoadProducts(variantId) {
    // Detail-fetch voor variant-products (koppelingen). GET ?variant_id=.
    const j = await tryFetch('tv-detail', '/api/traject-variants?variant_id=' + encodeURIComponent(variantId));
    if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
    return Array.isArray(j?.products) ? j.products : [];
  }
  window.__setTvNew  = () => {
    if (!_tr.trajects.length) { showToast('Geen trajecten — maak eerst een traject aan via Sales', 'warn'); return; }
    _tr.ed = { id: null, traject_id: _tr.trajects[0].id, name: '', description: '', default_duration_months: null, display_order: 100, is_default: false, is_active: true, products: [] };
    if (render) render();
  };
  window.__setTvEdit = async (id) => {
    const v = _tr.variants.find(x => x.id === id); if (!v) return;
    _tr.ed = { ...v, products: [], _loadingProducts: true }; if (render) render();
    try { _tr.ed.products = await _tvLoadProducts(id); _tr.ed._loadingProducts = false; }
    catch (e) { _tr.ed._loadingProducts = false; showToast('Producten laden mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
    if (render) render();
  };
  window.__setTvCancel = () => { _tr.ed = null; if (render) render(); };
  window.__setTvTraject = (v) => { if (_tr.ed) { _tr.ed.traject_id = String(v || ''); if (render) render(); } };
  window.__setTvBool = (k, v) => { if (_tr.ed) { _tr.ed[k] = !!v; if (render) render(); } };
  // Sync DOM → _tr.ed vóór structuur-actions + save.
  function _tvSyncFromDom() {
    const e = _tr.ed; if (!e) return;
    const q = (sel) => document.querySelector(sel);
    const qAll = (sel) => document.querySelectorAll(sel);
    ['name','description'].forEach(k => { const el = q(`[data-tv-field="${k}"]`); if (el) e[k] = String(el.value || ''); });
    const durEl = q('[data-tv-field="default_duration_months"]'); if (durEl) e.default_duration_months = durEl.value === '' ? null : (parseInt(durEl.value, 10) || null);
    const ordEl = q('[data-tv-field="display_order"]'); if (ordEl) e.display_order = parseInt(ordEl.value, 10) || 100;
    // products-koppelingen: per rij product_id (select) + quantity (input).
    (e.products || []).forEach((_, i) => {
      const pid = q(`[data-tv-prod-idx="${i}"][data-tv-prod-field="product_id"]`);
      const qty = q(`[data-tv-prod-idx="${i}"][data-tv-prod-field="quantity"]`);
      if (pid) e.products[i].product_id = String(pid.value || '');
      if (qty) e.products[i].quantity = Math.max(1, parseInt(qty.value, 10) || 1);
    });
  }
  window.__setTvAddProduct = () => {
    _tvSyncFromDom();
    if (!_tr.ed) return;
    _tr.ed.products = _tr.ed.products || [];
    _tr.ed.products.push({ product_id: _tr.products[0]?.id || '', quantity: 1 });
    if (render) render();
  };
  window.__setTvRmProduct = (i) => {
    _tvSyncFromDom();
    if (!_tr.ed) return;
    _tr.ed.products.splice(i, 1); if (render) render();
  };
  window.__setTvSave = () => {
    _tvSyncFromDom();
    const e = _tr.ed; if (!e) return;
    if (!String(e.name || '').trim()) { showToast('Naam is verplicht', 'warn'); return; }
    if (!e.traject_id) { showToast('Kies een parent-traject', 'warn'); return; }
    if (e.default_duration_months != null) {
      const d = Number(e.default_duration_months);
      if (!Number.isFinite(d) || d < 1 || d > 120) { showToast('Looptijd moet 1..120 maanden zijn (of leeg)', 'warn'); return; }
    }
    const invalidProduct = (e.products || []).find(p => !p.product_id);
    if (invalidProduct) { showToast('Kies een product voor elke koppeling (of verwijder de lege rij)', 'warn'); return; }
    const products = (e.products || []).map(p => ({ product_id: p.product_id, quantity: Math.max(1, parseInt(p.quantity, 10) || 1) }));
    const isEdit = !!e.id;
    const url = isEdit
      ? '/api/traject-variants?id=' + encodeURIComponent(e.id)
      : '/api/traject-variants';
    const method = isEdit ? 'PUT' : 'POST';
    const payload = {
      traject_id: e.traject_id,
      name: String(e.name || '').trim(),
      description: String(e.description || '').trim() || null,
      default_duration_months: e.default_duration_months || null,
      display_order: e.display_order || 100,
      is_default: !!e.is_default,
      is_active:  e.is_active !== false,
      products,
    };
    openConfirm(`${isEdit ? 'Wijzigingen opslaan voor variant' : 'Nieuwe variant aanmaken:'} "${payload.name}"? Product-koppelingen worden volledig vervangen door de huidige lijst. Wijzigingen worden NIET naar TeamLeader gepusht — prijzen zitten op products (Sales-module).`, async () => {
      _tr.busy = true; if (render) render();
      try {
        const j = await tryFetch('tv-save', url, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(isEdit ? 'Variant bijgewerkt' : 'Variant aangemaakt', 'ok');
        _tr.ed = null; _tr.fetched = false; fetchTrajecten();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _tr.busy = false; if (render) render(); }
    });
  };
  window.__setTvDelete = (id) => {
    const v = _tr.variants.find(x => x.id === id); if (!v) return;
    openConfirm(`Variant "${esc(v.name)}" (traject: ${esc(v.traject_name)}) DEFINITIEF verwijderen? Cascade — product-koppelingen worden ook verwijderd. Bestaande deals met deze variant behouden hun snapshot maar de variant is niet meer selecteerbaar voor nieuwe deals. Overweeg eerst 'deactiveren' via Edit → uitzetten.`, async () => {
      try {
        const j = await tryFetch('tv-delete', '/api/traject-variants?id=' + encodeURIComponent(id), { method: 'DELETE' });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Variant verwijderd', 'ok');
        _tr.fetched = false; fetchTrajecten();
      } catch (err) { showToast('Verwijderen mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
    }, 'warn');
  };
  function _tvProductLabel(p) {
    const prod = _tr.products.find(x => x.id === p.product_id);
    if (!prod) return '— onbekend product —';
    const price = prod.default_price != null ? ` · €${Number(prod.default_price).toFixed(2)}` : '';
    return `${prod.name}${price}${prod.category ? ` · ${prod.category}` : ''}`;
  }
  function _renderTvEditor() {
    const e = _tr.ed; if (!e) return '';
    const productOptions = (_tr.products || []).map(p => `<option value="${esc(p.id)}"${p.id===e.product_id?' selected':''}>${esc(p.name)} · €${Number(p.default_price||0).toFixed(2)}${p.category?` · ${esc(p.category)}`:''}</option>`).join('');
    const productRows = (e.products || []).map((p, i) => `<div style="display:grid;grid-template-columns:1fr 80px 30px;gap:6px;padding:6px 8px;border-top:1px solid var(--border);align-items:center">
      <select data-tv-prod-idx="${i}" data-tv-prod-field="product_id" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
        <option value="">— kies product —</option>
        ${(_tr.products || []).map(pr => `<option value="${esc(pr.id)}"${pr.id===p.product_id?' selected':''}>${esc(pr.name)} · €${Number(pr.default_price||0).toFixed(2)}</option>`).join('')}
      </select>
      <input type="number" min="1" data-tv-prod-idx="${i}" data-tv-prod-field="quantity" value="${esc(String(p.quantity||1))}" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
      <button class="btn btn-ghost btn-sm" onclick="window.__setTvRmProduct(${i})" style="font-size:12px;color:var(--rose);padding:2px 6px">✕</button>
    </div>`).join('');
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setTvCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'Variant bewerken' : 'Nieuwe variant'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setTvCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1">
          <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55;margin-bottom:14px">
            <b>Geen TL-sync bij opslaan.</b> Variant-metadata (naam/duur/koppelingen) leeft alleen in de eigen DB. Product-prijzen wijzigen doe je in Sales &gt; Producten (raakt <code>products.default_price</code> — nieuwe deals gebruiken de nieuwe prijs, bestaande deals behouden snapshot).
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
            <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Parent-traject <span style="color:var(--rose)">*</span>
              <select onchange="window.__setTvTraject(this.value)" ${e.id ? 'disabled title="Kan niet gewijzigd worden na aanmaken"' : ''} style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
                ${_tr.trajects.map(t => `<option value="${esc(t.id)}"${t.id===e.traject_id?' selected':''}>${esc(t.name)}</option>`).join('')}
              </select>
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Naam variant <span style="color:var(--rose)">*</span>
              <input type="text" data-tv-field="name" value="${esc(e.name || '')}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Looptijd (mnd, 1-120, leeg = geen default)
              <input type="number" min="1" max="120" data-tv-field="default_duration_months" value="${esc(e.default_duration_months != null ? String(e.default_duration_months) : '')}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Beschrijving
              <textarea data-tv-field="description" rows="2" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.description || '')}</textarea>
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Volgorde (display_order)
              <input type="number" data-tv-field="display_order" value="${esc(String(e.display_order || 100))}" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <div style="display:flex;flex-direction:column;gap:6px;justify-content:center">
              <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" ${e.is_default ? 'checked' : ''} onchange="window.__setTvBool('is_default', this.checked)" /> Default variant voor dit traject</label>
              <label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" ${e.is_active !== false ? 'checked' : ''} onchange="window.__setTvBool('is_active', this.checked)" /> Actief (selecteerbaar in wizard)</label>
            </div>
          </div>
          <div style="margin-top:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
              <div style="font-size:12px;font-weight:600">Product-koppelingen (${(e.products||[]).length})</div>
              <button class="btn btn-ghost btn-sm" onclick="window.__setTvAddProduct()" style="font-size:11px" ${!(_tr.products||[]).length ? 'disabled' : ''}>➕ Product</button>
            </div>
            ${e._loadingProducts ? `<div style="padding:12px;color:var(--text-3);font-size:11.5px;text-align:center">Laden…</div>` :
              (productRows ? `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;overflow:hidden">
                <div style="padding:6px 8px;font-size:10.5px;color:var(--text-3);display:grid;grid-template-columns:1fr 80px 30px;gap:6px;background:var(--surface);border-bottom:1px solid var(--border)"><span>Product · prijs</span><span style="text-align:center">Aantal</span><span></span></div>
                ${productRows}
              </div>` : `<div style="padding:12px;color:var(--text-3);font-size:11.5px;text-align:center;border:1px dashed var(--border);border-radius:6px">Geen producten gekoppeld — voeg toe via ➕</div>`)}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setTvCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_tr.busy ? 'disabled' : ''} onclick="window.__setTvSave()">${_tr.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodyTrajecten() {
    if (!_tr.fetched && !_tr.loading) queueMicrotask(() => fetchTrajecten());
    const rows = _tr.variants.map(v => `<tr style="border-top:1px solid var(--border);${v.is_active ? '' : 'opacity:.55'}">
      <td style="padding:8px 12px;font-size:12.5px">${esc(v.traject_name)}</td>
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(v.name || '—')}${v.is_default ? ' <span style="font-size:10px;color:var(--emerald);font-weight:600">★ default</span>' : ''}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);text-align:center">${v.default_duration_months || '—'}</td>
      <td style="padding:8px 12px;font-size:11px;text-align:center">${v.is_active ? '<span style="color:var(--emerald)">✓ actief</span>' : '<span style="color:var(--text-3)">⨯ inactief</span>'}</td>
      <td style="padding:6px 12px;text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="window.__setTvEdit('${esc(v.id)}')" style="font-size:11px">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__setTvDelete('${esc(v.id)}')" style="font-size:11px;color:var(--rose)">Verwijder</button>
      </td>
    </tr>`).join('');
    return `<div style="max-width:1100px">
      ${_renderTvEditor()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>LIVE editor.</b> Varianten (naam/duur/product-koppelingen) via <code>/api/traject-variants</code>. <b>Geen TL-sync</b> — wijzigingen leven in eigen DB; product-prijzen zitten op <code>products</code> (Sales-module). Nieuwe offertes gebruiken automatisch de laatste prijs; bestaande deals behouden snapshot.
        <button class="btn btn-ghost btn-sm" style="margin-left:10px;font-size:11px" onclick="DFO.goMod('sales')">Sales → Producten (prijzen)</button>
      </div>
      ${_tr.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_tr.error)}</div>` : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:12.5px;color:var(--text-3)">${_tr.variants.length} variant(en) over ${_tr.trajects.length} traject(en) · ${(_tr.products||[]).length} products beschikbaar voor koppeling</div>
        <button class="btn btn-primary btn-sm" onclick="window.__setTvNew()">➕ Nieuwe variant</button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Traject</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Variant</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Duur (mnd)</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_tr.loading?'Laden…':'Geen varianten gevonden'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Wave-2 · DEEL B — deep-link body voor niet-geporte config-secties.
     Reden per sectie is beknopt uitgelegd zodat de gebruiker snapt WAAROM
     de instelling nu in een andere module leeft. Bij `modKey` opgegeven:
     directe navigatie-knop via DFO.goMod. */
  /* v=75 · mk-meta NATIVE — WABA-koppelingsstatus per module via
     admin-whatsapp-modules-list. Read-only display; koppeling zelf is in v1
     gelegd (whatsapp_module_config-tabel gevuld via admin.html of migraties).
     Meta Business Manager blijft externe secondaire actie. Endpoint eist
     super_admin — non-super_admin ziet nette hint. */
  const _mkm = { loading: false, fetched: false, error: null, items: [] };
  async function fetchMkMeta() {
    if (_mkm.loading || _mkm.fetched) return;
    _mkm.loading = true; _mkm.error = null; if (render) render();
    const j = await tryFetch('mk-meta-mods', '/api/admin-whatsapp-modules-list');
    _mkm.loading = false; _mkm.fetched = true;
    if (j?.__error) _mkm.error = j.__error;
    else _mkm.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  function bodyMkMeta() {
    // v=76 client-gate: sectie is super_admin-scoped (endpoint returnt anders
    // 403; "Bekijk als" is client-illusie, dus echte user zou de data toch
    // zien zonder deze gate). Geef 'em bewust hetzelfde amber-blok als de
    // sectie server-side-forbidden zou zijn.
    if (!isSuperAdmin()) {
      return `<div style="max-width:900px">
        <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:280px">
            <b>Meta-WhatsApp-koppeling.</b> WABA-config leeft in <code>whatsapp_module_config</code>. Meta Business Manager blijft canonieke plek voor ads/pixel.
          </div>
          <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm" style="text-decoration:none;font-size:11.5px;white-space:nowrap">🔗 Open Meta Business Manager ↗</a>
        </div>
        <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55">
          ⚠ WABA-koppelingsstatus is alleen zichtbaar voor <b>super_admin</b>. Vraag Jeffrey om te loggen of de koppeling actief is.
        </div>
      </div>`;
    }
    if (!_mkm.fetched && !_mkm.loading) queueMicrotask(() => fetchMkMeta());
    const items = _mkm.items;
    const anyErr = _mkm.error;
    const isForbidden = anyErr && /super_admin|geen rechten|forbidden|403/i.test(String(anyErr));
    const cards = items.map((m) => {
      const active = m.is_active !== false;
      const badge = active
        ? `<span style="padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-size:11px;font-weight:600">✓ ACTIEF</span>`
        : `<span style="padding:2px 8px;border-radius:6px;background:var(--text-3);color:var(--surface);font-size:11px;font-weight:600">⨯ UIT</span>`;
      const mask = (s) => s ? '<code style="font-family:\'IBM Plex Mono\',monospace;font-size:11px;background:var(--surface-2);padding:1px 5px;border-radius:3px">' + esc(String(s).slice(0, 6)) + '…' + esc(String(s).slice(-4)) + '</code>' : '<span style="color:var(--text-3)">—</span>';
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="font-size:13px;font-weight:600">${esc(m.display_label || m.module || 'onbekend')}</div>
          ${badge}
          ${m.module ? `<code style="font-size:10.5px;background:var(--surface-2);padding:1px 5px;border-radius:3px;color:var(--text-3);margin-left:auto">${esc(m.module)}</code>` : ''}
        </div>
        <div style="font-size:11.5px;line-height:1.7">
          <div><span style="color:var(--text-3)">Phone-number-id: </span>${mask(m.phone_number_id)}</div>
          <div><span style="color:var(--text-3)">Business-account-id: </span>${mask(m.business_account_id)}</div>
          ${m.afdeling_email     ? `<div><span style="color:var(--text-3)">Afdeling-email: </span>${esc(m.afdeling_email)}</div>` : ''}
          ${m.afdeling_telefoon  ? `<div><span style="color:var(--text-3)">Afdeling-telefoon: </span>${esc(m.afdeling_telefoon)}</div>` : ''}
          ${m.afdeling_whatsapp  ? `<div><span style="color:var(--text-3)">Afdeling-WhatsApp: </span>${esc(m.afdeling_whatsapp)}</div>` : ''}
          ${m.afdeling_ondertekenaar ? `<div><span style="color:var(--text-3)">Ondertekenaar: </span>${esc(m.afdeling_ondertekenaar)}</div>` : ''}
        </div>
      </div>`;
    }).join('');
    const active = items.filter((m) => m.is_active !== false).length;
    return `<div style="max-width:900px">
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:280px">
          <b>Meta-WhatsApp-koppeling — READ-ONLY status.</b> WABA-configuratie is in v1 gelegd (tabel <code>whatsapp_module_config</code>). WA-templates + verzenden zie <b>com-wa</b>. Meta Business Manager blijft canonieke plek voor ads/pixel.
        </div>
        <a href="https://business.facebook.com" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm" style="text-decoration:none;font-size:11.5px;white-space:nowrap">🔗 Open Meta Business Manager ↗</a>
      </div>
      ${isForbidden
        ? `<div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55">⚠ WABA-koppelingsstatus is alleen zichtbaar voor <b>super_admin</b>. Vraag Jeffrey om te loggen of de koppeling actief is.</div>`
        : anyErr
          ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px">⚠ ${esc(anyErr)} <button class="btn btn-ghost btn-sm" onclick="_mkm.fetched=false;_mkm.error=null;fetchMkMeta()" style="font-size:11px;margin-left:6px">Opnieuw</button></div>`
          : `<div style="font-size:12px;color:var(--text-3);margin-bottom:8px">${items.length} module(s) — ${active} actief · ${items.length - active} uit</div>
             ${items.length === 0
               ? `<div style="padding:14px;background:var(--surface-2);color:var(--text-3);border-radius:8px;font-size:12.5px;text-align:center">${_mkm.loading ? 'Laden…' : 'Geen WABA-modules geconfigureerd. Beheer in v1 admin.'}</div>`
               : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">${cards}</div>`}`}
    </div>`;
  }

  function bodyDeepLink(modLabel, why, modKey) {
    const btn = modKey ? `<button class="btn btn-primary btn-sm" style="margin-top:12px" onclick="DFO.goMod('${esc(modKey)}')">Open ${esc(modLabel || 'module')} →</button>` : '';
    return `<div style="max-width:720px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55">
        <b>Deze instellingen zijn nog niet gecentraliseerd</b> — reden hieronder. Ze werken wel, maar in hun originele module. Volledige port naar deze pagina volgt in een eigen brok.
      </div>
      <div style="padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text-2);line-height:1.6;margin-top:12px">
        ${esc(why)}
        ${btn}
      </div>
    </div>`;
  }

  /* Wave-2 · mk-webflow — auto-publish toggle + publish-now.
     Reads/writes app-settings ({key: 'webflow_auto_publish_enabled', value: {enabled: bool}}
     — object-shape zoals admin repliceren). Publish-now = ECHTE live-publish → confirm. */
  const _wf = { loading: false, fetched: false, error: null, enabled: false, publishing: false };
  async function fetchWebflow() {
    if (_wf.loading || _wf.fetched) return;
    _wf.loading = true; _wf.error = null; if (render) render();
    const j = await tryFetch('wf-flag', '/api/app-settings?key=webflow_auto_publish_enabled');
    _wf.loading = false; _wf.fetched = true;
    if (j?.__error) _wf.error = j.__error;
    else {
      // admin.html gebruikt shape {enabled:bool}; fallback naar scalar boolean voor tolerantie.
      const v = j?.value;
      _wf.enabled = !!(v && typeof v === 'object' ? v.enabled : v);
    }
    if (render) render();
  }
  window.__setWfToggle = () => {
    const next = !_wf.enabled;
    openConfirm(`Auto-publish ${next ? 'AAN' : 'UIT'}? ${next ? 'Elke CMS-mutatie triggert een deforexopleiding.nl publish (kan traag zijn).' : 'CMS-mutaties triggeren geen automatische publish meer.'}`, async () => {
      const j = await tryFetch('wf-put', '/api/app-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'webflow_auto_publish_enabled', value: { enabled: next } }),
      });
      if (j?.__error || j?.error) showToast('Opslaan mislukt: ' + (j.__error || j.error), 'warn');
      else { _wf.enabled = next; showToast('Instelling opgeslagen', 'ok'); }
      if (render) render();
    }, 'warn');
  };
  window.__setWfPublishNow = () => {
    openConfirm('Publish deforexopleiding.nl NU? Live-actie richting Webflow — kan enkele seconden duren en de site kort onderbreken.', async () => {
      _wf.publishing = true; if (render) render();
      const j = await tryFetch('wf-publish', '/api/admin-webflow-publish-now', { method: 'POST' });
      _wf.publishing = false;
      if (j?.__error || j?.error) showToast('Publish mislukt: ' + (j.__error || j.error), 'warn');
      else showToast('Publish gestart', 'ok');
      if (render) render();
    }, 'warn');
  };
  function bodyWebflow() {
    if (!_wf.fetched && !_wf.loading) queueMicrotask(() => fetchWebflow());
    return `<div style="max-width:700px">
      ${_wf.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_wf.error)}</div>` : ''}
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:14px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">Auto-publish deforexopleiding.nl</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Na elke CMS-mutatie (event aanmaken/wijzigen/sluiten/inschrijving) publisht Webflow automatisch. Zet uit als het team zelf op de site werkt.</div>
          </div>
          <button class="btn ${_wf.enabled ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__setWfToggle()">${_wf.loading ? '…' : (_wf.enabled ? '✓ AAN' : '⨯ UIT')}</button>
        </div>
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Publish nu</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Trigger onmiddellijk een Webflow-publish. Gebruik dit als de site achterloopt.</div>
          <button class="btn btn-primary btn-sm" ${_wf.publishing ? 'disabled' : ''} onclick="window.__setWfPublishNow()" style="background:var(--rose);border-color:var(--rose)">${_wf.publishing ? 'Bezig…' : '🚀 Publish now'}</button>
        </div>
      </div>
    </div>`;
  }

  /* Wave-2 · sys-bubble-schema — lazy op knop-klik (niet bij render).
     Read-only super_admin diagnostiek.
     Ronde-31 BLOK C: endpoint-param FIX (was `?objtype=` — endpoint eist `?type=`)
     + nieuwe option-waarden probe (?type=user&options=1). */
  const _bs = { busy: false, result: null, error: null, type: null, mode: null };
  window.__setBsProbe = async (type, options) => {
    if (_bs.busy) return;
    _bs.busy = true; _bs.result = null; _bs.error = null; _bs.type = type; _bs.mode = options ? 'options' : 'schema'; if (render) render();
    const suffix = options ? '&options=1' : '';
    const j = await tryFetch('bubble-probe', '/api/bubble-schema-probe?type=' + encodeURIComponent(type) + suffix);
    _bs.busy = false;
    if (j?.__error || j?.error) _bs.error = j.__error || j.error;
    else _bs.result = j;
    if (render) render();
  };
  function bodyBubbleProbe() {
    if (!isSuperAdmin()) return bodyAccessDenied();
    const out = _bs.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px">${esc(_bs.error)}</div>`
             : _bs.result ? `<pre style="background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-size:11.5px;max-height:400px;overflow:auto;font-family:'IBM Plex Mono',monospace;margin:0">${esc(JSON.stringify(_bs.result, null, 2))}</pre>`
             : `<div style="color:var(--text-3);font-size:12px">Klik een knop om het schema van dat objecttype op te halen.</div>`;
    return `<div style="max-width:900px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:14px">Sampled een set records van een Bubble-objecttype (default 200) en toont uitsluitend property-keys + JS-typen. Geen waarden/PII. Alleen super_admin.</div>
      <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" ${_bs.busy ? 'disabled' : ''} onclick="window.__setBsProbe('user')">${_bs.busy && _bs.type === 'user' && _bs.mode === 'schema' ? 'Bezig…' : '👤 User-velden'}</button>
        <button class="btn btn-primary btn-sm" ${_bs.busy ? 'disabled' : ''} onclick="window.__setBsProbe('session')">${_bs.busy && _bs.type === 'session' ? 'Bezig…' : '⏱ Session-velden'}</button>
        <button class="btn btn-ghost btn-sm" ${_bs.busy ? 'disabled' : ''} onclick="window.__setBsProbe('user', true)" title="Distinct waarden van option-set-velden op User (whitelist)">${_bs.busy && _bs.type === 'user' && _bs.mode === 'options' ? 'Bezig…' : '🏷 User-option-waarden'}</button>
      </div>
      ${out}
    </div>`;
  }

  /* Wave-2 · fin-entiteiten — read-only lijst van company_entities via
     direct-supabase (zelfde pattern als team-rechten). CRUD blijft in Supabase-
     console (te complex om nu te bouwen; low-frequency actie: entiteiten worden
     nauwelijks toegevoegd). Custom confirm bij delete = deep-link only. */
  // Ronde-28 · CRUD op company_entities via direct-supabase (zoals RBAC).
  // Ronde-31 FIX 2: writes via /api/company-entities (POST/PATCH/DELETE) i.p.v.
  // direct-supabase (dat gaf 403 door RLS). Endpoint doet super_admin-gate +
  // schrijft server-side met supabaseAdmin.
  const _ent = { loading: false, fetched: false, error: null, items: [], ed: null, busy: false };
  async function fetchEntiteiten(force) {
    if (_ent.loading) return;
    if (_ent.fetched && !force) return;
    _ent.loading = true; _ent.error = null; if (render) render();
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const { data, error } = await window.supabase.from('company_entities')
        .select('id, tl_department_id, name, label, description, display_order, is_active')
        .order('display_order', { ascending: true }).order('label');
      if (error) throw error;
      _ent.items = data || [];
    } catch (e) { _ent.error = e?.message || 'onbekend'; }
    _ent.loading = false; _ent.fetched = true;
    if (render) render();
  }
  window.__setEntNew  = () => { _ent.ed = { id: null, tl_department_id: '', name: '', label: '', description: '', display_order: (_ent.items.length + 1) * 10 }; if (render) render(); };
  window.__setEntEdit = (id) => { const it = _ent.items.find(x => x.id === id); if (!it) return; _ent.ed = { ...it }; if (render) render(); };
  window.__setEntCancel = () => { _ent.ed = null; if (render) render(); };
  // Ronde-31 FIX 1 (focus-verlies): setter NIET meer render()en tijdens typen.
  // State-update blijft; render() wordt pas bij open/close/save aangeroepen.
  // Voorkomt dat input-node bij elke keystroke wordt vervangen (focus + cursor weg).
  window.__setEntField = (k, v) => { if (_ent.ed) { _ent.ed[k] = (k === 'display_order') ? (Number(v) || 0) : String(v || ''); } };
  window.__setEntSave = () => {
    // Lees actuele input-values uit de DOM (uncontrolled inputs sinds FIX 1 —
     // window.__setEntField vult _ent.ed maar dat kan achterlopen op de laatste
     // keystroke als de browser 'change' nog niet vuurde). Fallback naar _ent.ed.
    if (_ent.ed) {
      const g = (n) => document.querySelector(`[data-ent-field="${n}"]`);
      for (const k of ['label','tl_department_id','name','description']) {
        const el = g(k); if (el && typeof el.value === 'string') _ent.ed[k] = el.value;
      }
      const doEl = g('display_order');
      if (doEl && doEl.value !== '') _ent.ed.display_order = Number(doEl.value) || 0;
    }
    const e = _ent.ed; if (!e) return;
    if (!String(e.label || '').trim())            { showToast('Label is verplicht', 'warn'); return; }
    if (!String(e.tl_department_id || '').trim()) { showToast('TL Department ID is verplicht', 'warn'); return; }
    openConfirm(`${e.id ? 'Wijzigingen opslaan voor' : 'Nieuwe entiteit aanmaken:'} "${e.label}"? Raakt facturatie- en MRR-scoping.`, async () => {
      _ent.busy = true; if (render) render();
      // ronde-31 marker: server-side write via /api/company-entities.
      try {
        const payload = {
          tl_department_id: String(e.tl_department_id).trim(),
          name: String(e.name || '').trim() || null,
          label: String(e.label).trim(),
          description: String(e.description || '').trim() || null,
          display_order: Number(e.display_order) || 0,
        };
        const url    = e.id ? `/api/company-entities?id=${encodeURIComponent(e.id)}` : '/api/company-entities';
        const method = e.id ? 'PATCH' : 'POST';
        const j = await tryFetch('company-entities-save', url, {
          method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(e.id ? 'Entiteit bijgewerkt' : 'Entiteit aangemaakt', 'ok');
        _ent.ed = null; _ent.fetched = false; fetchEntiteiten(true);
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _ent.busy = false; if (render) render(); }
    });
  };
  window.__setEntToggleActive = (id) => {
    const it = _ent.items.find(x => x.id === id); if (!it) return;
    const next = !it.is_active;
    openConfirm(`${next ? 'HERACTIVEER' : 'DEACTIVEER'} entiteit "${it.label}"?${next ? '' : ' Nieuwe deals/facturen kunnen niet meer aan deze entiteit worden gekoppeld (historie blijft intact).'}`, async () => {
      try {
        // Deactiveer = DELETE (server doet soft-delete: is_active=false).
        // Heractiveer = PATCH met is_active=true.
        const url = `/api/company-entities?id=${encodeURIComponent(id)}`;
        const j = await tryFetch('company-entities-toggle', url, next
          ? { method: 'PATCH',  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: true }) }
          : { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(next ? 'Entiteit heractiveerd' : 'Entiteit gedeactiveerd', 'ok');
        _ent.fetched = false; fetchEntiteiten(true);
      } catch (err) { showToast('Actie mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
    }, 'warn');
  };
  function _renderEntEditor() {
    const e = _ent.ed; if (!e) return '';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setEntCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:560px;width:100%;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">${e.id ? 'Entiteit bewerken' : 'Nieuwe entiteit'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setEntCancel()">✕</button>
        </div>
        <div style="padding:16px 20px;display:grid;grid-template-columns:1fr 1fr;gap:12px 14px">
          <label style="font-size:11.5px;color:var(--text-2)">Label <span style="color:var(--rose)">*</span>
            <input type="text" data-ent-field="label" value="${esc(e.label || '')}" oninput="window.__setEntField('label',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">TL Department ID <span style="color:var(--rose)">*</span>
            <input type="text" data-ent-field="tl_department_id" value="${esc(e.tl_department_id || '')}" oninput="window.__setEntField('tl_department_id',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Naam
            <input type="text" data-ent-field="name" value="${esc(e.name || '')}" oninput="window.__setEntField('name',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2)">Volgorde
            <input type="number" data-ent-field="display_order" value="${esc(String(e.display_order || 0))}" oninput="window.__setEntField('display_order',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <label style="font-size:11.5px;color:var(--text-2);grid-column:1/-1">Beschrijving
            <textarea data-ent-field="description" rows="2" oninput="window.__setEntField('description',this.value)" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(e.description || '')}</textarea>
          </label>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setEntCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_ent.busy ? 'disabled' : ''} onclick="window.__setEntSave()">${_ent.busy ? 'Bezig…' : 'Opslaan'}</button>
        </div>
      </div>
    </div>`;
  }
  function bodyEntiteiten() {
    if (!_ent.fetched && !_ent.loading) queueMicrotask(() => fetchEntiteiten());
    const rows = _ent.items.map(e => `<tr style="border-top:1px solid var(--border);${e.is_active ? '' : 'opacity:.55'}">
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(e.label || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(e.tl_department_id || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(e.name || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px">${e.is_active ? '✓ actief' : '⨯ inactief'}</td>
      <td style="padding:6px 12px;text-align:right;white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="window.__setEntEdit('${esc(e.id)}')" style="font-size:11px">Edit</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__setEntToggleActive('${esc(e.id)}')" style="font-size:11px;color:${e.is_active ? 'var(--rose)' : 'var(--emerald)'}">${e.is_active ? 'Deactiveer' : 'Heractiveer'}</button>
      </td>
    </tr>`).join('');
    return `<div style="max-width:1100px">
      ${_renderEntEditor()}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap">
        <div style="font-size:12.5px;color:var(--text-3)">Entiteiten sturen facturatie + MRR-scoping. Deactiveren i.p.v. hard-delete (historie blijft).</div>
        <button class="btn btn-primary btn-sm" onclick="window.__setEntNew()">➕ Nieuwe entiteit</button>
      </div>
      ${_ent.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_ent.error)}</div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Label</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">TL Department ID</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="5" style="padding:16px;color:var(--text-3);font-size:12.5px">${_ent.loading ? 'Laden…' : 'Geen entiteiten gevonden'}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     Wave-3 · gevoelige secties (secrets / finance-nabij / factuur-impact).
     Alle secrets NOOIT volledig tonen — maskeren (••••1234). Elke write
     achter custom confirm. Write pas na bevestigde impact-analyse; anders
     display-only met notice die aanpak uitlegt.
     ═════════════════════════════════════════════════════════════════════ */

  /* Wave-3 · team-api — API-sleutels. Er bestaat GEEN api-keys-tabel/-endpoint
     op dit moment; alle integraties gebruiken env-vars (Vercel + 1Password).
     CRUD hier bouwen vereist eerst een secrets-management-brok:
       1. Kies opslag (Supabase Vault / dedicated tabel met encryption-at-rest)
       2. Endpoint /api/admin-api-keys met rotate/revoke + audit-log
       3. Env-vars migreren zonder downtime.
     Voor nu: display-only lijst van bekende integraties + hun status. */
  const _apiKeys = { loading: false, fetched: false, error: null, integrations: [] };
  async function fetchApiKeys() {
    if (_apiKeys.loading || _apiKeys.fetched) return;
    _apiKeys.loading = true; if (render) render();
    // Statische inventaris — welke integraties gebruiken keys (informatief).
    _apiKeys.integrations = [
      { name: 'Anthropic',    env: 'ANTHROPIC_API_KEY',        status: 'env-var', usedBy: 'Joost + agents + AI Manager' },
      { name: 'Internal',     env: 'INTERNAL_API_TOKEN',       status: 'env-var', usedBy: 'server-to-server (Joost auto-suggest)' },
      { name: 'TeamLeader',   env: 'OAuth (via UI)',           status: 'OAuth',   usedBy: 'CRM sync (klanten/deals/facturen)' },
      { name: 'Meta Cloud',   env: 'META_WHATSAPP_ACCESS_TOKEN', status: 'env-var', usedBy: 'WhatsApp Business API' },
      { name: 'Webflow',      env: 'WEBFLOW_API_TOKEN',        status: 'env-var', usedBy: 'CMS auto-publish' },
      { name: 'GoHighLevel',  env: 'GHL_* (meerdere)',         status: 'env-var', usedBy: 'Lisa + follow-up' },
      { name: 'Voys',         env: 'VOYS_API_TOKEN + VOYS_CLIENT_UUID', status: 'env-var', usedBy: 'Telefonie/call-outs' },
      { name: 'Bubble',       env: 'BUBBLE_API_TOKEN',         status: 'env-var', usedBy: 'LMS-data' },
      { name: 'Supabase',     env: 'SUPABASE_SERVICE_ROLE_KEY', status: 'env-var', usedBy: 'Server-side DB-writes' },
      { name: 'Strato IMAP',  env: 'STRATO_*_USER/_PASS × 4',  status: 'env-var', usedBy: 'Mail-sync (4 postvakken)' },
    ];
    _apiKeys.loading = false; _apiKeys.fetched = true; if (render) render();
  }
  function bodyApiKeys() {
    if (!_apiKeys.fetched && !_apiKeys.loading) queueMicrotask(() => fetchApiKeys());
    const rows = _apiKeys.integrations.map(k => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(k.name)}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(k.env)} <span style="opacity:.5">••••••</span></td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(k.status)}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(k.usedBy)}</td>
    </tr>`).join('');
    return `<div style="max-width:1000px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Display-only.</b> API-sleutels leven in Vercel env-vars + 1Password. Roteren = handmatig in Vercel dashboard.
        CRUD hier vereist een secrets-management-brok: opslag-keuze (Supabase Vault / eigen encrypted-tabel), endpoint met rotate/revoke/audit-log, en env-var-migratie zonder downtime. Aanpak eerst afstemmen voordat dit gebouwd wordt.
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Integratie</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Env-var</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Type</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Gebruikt door</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Wave-3 · com-mail — E-mailaccounts. IMAP-credentials leven in env-vars
     (STRATO_LEADS_USER/_PASS × 4). Geen DB-tabel voor mailbox-config; sync-code
     leest env direct. Zelfde reden als team-api: CRUD vereist secrets-management-
     brok + refactor sync-code. Display-only. */
  function bodyMailboxen() {
    const rows = [
      { name: 'leads@',         env: 'STRATO_LEADS_USER/_PASS',         cat: 'Lead-intake' },
      { name: 'info@',          env: 'STRATO_INFO_USER/_PASS',          cat: 'Algemeen' },
      { name: 'partners@',      env: 'STRATO_PARTNERS_USER/_PASS',      cat: 'Partner-verkeer' },
      { name: 'administratie@', env: 'STRATO_ADMINISTRATIE_USER/_PASS', cat: 'Facturen + boekhouder' },
      { name: 'welkom@',        env: 'STRATO_WELKOM_USER/_PASS',        cat: 'Wanbetalers-motor' },
      { name: 'onboarding@',    env: 'STRATO_ONBOARDING_USER/_PASS',    cat: 'Onboarding-flow' },
      { name: 'events@',        env: 'STRATO_EVENTS_USER/_PASS',        cat: 'Event-comms' },
    ].map(m => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(m.name)}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(m.env)} <span style="opacity:.5">••••••</span></td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(m.cat)}</td>
    </tr>`).join('');
    return `<div style="max-width:900px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Display-only.</b> IMAP-credentials per postvak leven in Vercel env-vars.
        Toevoegen/wijzigen/verwijderen vereist zelfde secrets-brok als team-api + refactor van <code>api/sync-emails.js</code> zodat het mailbox-config uit DB leest i.p.v. env.
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Postvak</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Env-var</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Gebruik</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Wave-3 · com-tel — Telefonie/Voys. /api/voys-config bestaat + returnt
     'configured' + caller_ids (geen tokens). Lazy read + deep-link naar de
     bestaande cockpit-integratie voor daadwerkelijk bellen. */
  const _tel = { loading: false, fetched: false, error: null, data: null };
  async function fetchTel() {
    if (_tel.loading || _tel.fetched) return;
    _tel.loading = true; _tel.error = null; if (render) render();
    const j = await tryFetch('voys-config', '/api/voys-config');
    _tel.loading = false; _tel.fetched = true;
    if (j?.__error) _tel.error = j.__error;
    else _tel.data = j;
    if (render) render();
  }
  function bodyTelefonie() {
    if (!_tel.fetched && !_tel.loading) queueMicrotask(() => fetchTel());
    const d = _tel.data || {};
    // Dual-account weergave (v=65). Response voegt `accounts:{nl,be}` toe
    // (rest_configured + sip_configured + caller_ids per account). Backward-
    // compat: als een oud endpoint alleen top-level `caller_ids`+`configured`
    // returnt, val terug op NL-only-render met alleen die data.
    const acc = d.accounts && typeof d.accounts === 'object' ? d.accounts : null;
    const legacyOnly = !acc;

    const renderAcc = (label, badge, a) => {
      const rest = !!a.rest_configured;
      const sip = !!a.sip_configured;
      const allCfg = sip && rest;
      const partialCfg = (sip || rest) && !allCfg;
      // 3-staten: volledig ✓ | gedeeltelijk (amber) | niet (grijs).
      // Amber signaleert dat er nog een capability ontbreekt — voorkomt dat
      // een enkel-SIP-account leest als "helemaal klaar" terwijl click-to-dial
      // nog stuk is (of andersom).
      const statusColor = allCfg ? 'var(--emerald)' : (partialCfg ? 'var(--amber)' : 'var(--text-3)');
      const statusText = allCfg
        ? '✓ Volledig geconfigureerd'
        : (partialCfg ? '⚠ Gedeeltelijk geconfigureerd' : '⨯ Nog niet geconfigureerd');
      const cids = Array.isArray(a.caller_ids) ? a.caller_ids : [];
      const capText = (sip || rest)
        ? `Softphone (SIP): ${sip ? '✓' : '⨯'} · Click-to-dial (REST): ${rest ? '✓' : '⨯'}`
        : 'Zet de bijbehorende env-vars in Vercel om te activeren.';
      return `<div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:12px">
        <div style="padding:14px 16px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <div style="font-size:13px;font-weight:600">Voys-koppeling · ${esc(label)}</div>
            <span style="font-size:10px;background:var(--surface-2);color:var(--text-3);padding:2px 6px;border-radius:4px;font-weight:600">${esc(badge)}</span>
          </div>
          <div style="font-size:11.5px;color:${statusColor};margin-bottom:6px">${statusText}</div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:10px">${capText}</div>
          ${cids.length
            ? `<div style="font-size:12px;color:var(--text-2)"><b>Caller-IDs:</b> ${cids.map(x => `<code style="background:var(--surface-2);padding:1px 5px;border-radius:3px;margin:0 2px">${esc(x)}</code>`).join(' ')}</div>`
            : `<div style="font-size:11.5px;color:var(--text-3)">Geen caller-IDs geconfigureerd.</div>`}
        </div>
      </div>`;
    };

    let body;
    if (_tel.error) {
      body = `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px">⚠ ${esc(_tel.error)}</div>`;
    } else if (legacyOnly) {
      // Fallback (oude endpoint): render enkel NL uit legacy top-level.
      body = renderAcc('Nederland', 'NL', { rest_configured: d.configured, sip_configured: false, caller_ids: d.caller_ids || [] });
    } else {
      body = renderAcc('Nederland', 'NL', acc.nl || {}) + renderAcc('België', 'BE', acc.be || {});
    }
    return `<div style="max-width:800px">
      ${body}
      <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55">
        Twee aparte Voys-accounts (NL + BE) elk met eigen credentials. <b>Softphone</b> registreert per lijn; nummers met +32/0032 gaan automatisch via BE-account, rest via NL. <b>Click-to-dial (REST)</b> gebruikt momenteel alleen het NL-account — BE REST-support vereist <code>VOYS_BE_API_TOKEN</code> + <code>_CLIENT_UUID</code> + <code>_A_NUMBER</code> env-vars én een aparte routing-fix. Tokens/wachtwoorden zijn NOOIT zichtbaar in deze sectie (server-side alleen).
      </div>
    </div>`;
  }

  /* Wave-3 · alg-bedrijf — Bedrijfsgegevens. ⚠ COMPANY_* env-vars worden
     gelezen door:
       - api/_lib/incasso-pdf.js         (WIK-brief PDF)         [INCASSO-ZONE]
       - api/_lib/incasso-pre-brief-core.js (pre-briefkaart)     [INCASSO-ZONE]
       - api/_lib/joost-suggest-core.js  (Joost-context)         [WANBETALERS-adjacent]
       - api/_lib/aisha-generate.js      (lead-emails/AI-content)
     Write hier zou factuur/PDF-content veranderen zonder dat de templates de
     nieuwe bron kennen. En INCASSO-ZONE mag niet worden aangepast in deze brok.
     → DISPLAY-ONLY. Toon huidige waardes; write vraagt eigen refactor-brok
     (templates: env-var → app-settings lookup + fallback naar env). */
  const _biz = { fetched: false, data: null, error: null, loading: false };
  async function fetchBiz() {
    if (_biz.loading || _biz.fetched) return;
    _biz.loading = true; if (render) render();
    // Simpel — probeer /api/config voor COMPANY_NAME (dat endpoint returnt
    // publieke config voor de browser). Overige velden staan als 'env-only'
    // gemarkeerd. Als /api/config geen company-velden geeft: fallback hardcoded.
    const j = await tryFetch('public-config', '/api/config');
    _biz.loading = false; _biz.fetched = true;
    if (j?.__error) _biz.error = j.__error;
    _biz.data = (j && !j.__error) ? j : {};
    if (render) render();
  }
  function bodyBedrijf() {
    if (!_biz.fetched && !_biz.loading) queueMicrotask(() => fetchBiz());
    const d = _biz.data || {};
    const fields = [
      { l: 'Naam',    v: d.COMPANY_NAME    || 'De Forex Opleiding NL B.V.', src: 'env-var / fallback' },
      { l: 'Adres',   v: d.COMPANY_ADDRESS || '(niet publiek)',              src: 'env-var COMPANY_ADDRESS' },
      { l: 'KvK',     v: d.COMPANY_KVK     || '(niet publiek)',              src: 'env-var COMPANY_KVK' },
      { l: 'BTW',     v: d.COMPANY_BTW     || '(niet publiek)',              src: 'env-var COMPANY_BTW' },
      { l: 'E-mail',  v: d.COMPANY_EMAIL   || 'info@deforexopleiding.nl',    src: 'env-var / fallback' },
      { l: 'Telefoon',v: d.COMPANY_PHONE   || '(niet publiek)',              src: 'env-var COMPANY_PHONE' },
    ];
    const rows = fields.map(f => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:10px 14px;font-size:12.5px;font-weight:600;width:120px">${esc(f.l)}</td>
      <td style="padding:10px 14px;font-size:12.5px;font-family:'IBM Plex Mono',monospace">${esc(f.v)}</td>
      <td style="padding:10px 14px;font-size:11px;color:var(--text-3)">${esc(f.src)}</td>
    </tr>`).join('');
    return `<div style="max-width:900px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Display-only ronde.</b> COMPANY_*-env-vars worden gelezen door <code>api/_lib/incasso-pdf.js</code>, <code>incasso-pre-brief-core.js</code>, <code>joost-suggest-core.js</code> en <code>aisha-generate.js</code>.
        <b>Write NIET veilig hier:</b> de eerste twee zitten in de <b>incasso-zone</b> — die mag niet worden aangepast in deze brok. Write-support vereist eerst een refactor-brok waarin de templates <code>app-settings</code> lezen met env-var-fallback, gecoördineerd met de incasso-review.
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 14px;font-size:11px;color:var(--text-3);font-weight:600">Veld</th>
            <th style="text-align:left;padding:8px 14px;font-size:11px;color:var(--text-3);font-weight:600">Waarde</th>
            <th style="text-align:left;padding:8px 14px;font-size:11px;color:var(--text-3);font-weight:600">Bron</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* Wave-3 · fin-bank — bank_accounts read via direct-supabase (zoals fin-
     entiteiten). CRUD + CAMT-upload vragen eigen brok: verkeerde IBAN hier
     beïnvloedt dashboard-saldo direct (zie eerdere post-mortem: F2 fix). */
  // v=62: CAMT-upload native in fin-bank. State-uitbreiding:
  // - uploading: boolean guard tegen dubbel-POST bij re-render/dubbele klik.
  // - uploadResult: laatste upload-uitkomst (statement_id + counts + range).
  // - uploadError: fout-string.
  // - recentTx: laatste ~15 transacties (via /api/finance-bank-camt-transactions).
  const _bnk = { loading: false, fetched: false, error: null, items: [], camt: null, camtError: null,
                 uploading: false, uploadResult: null, uploadError: null,
                 recentTx: null, recentTxError: null, recentTxLoading: false };
  async function fetchBank() {
    if (_bnk.loading || _bnk.fetched) return;
    _bnk.loading = true; _bnk.error = null; if (render) render();
    // Ronde-28 · fin-bank zinvol: fetch parallel: registratie-tabel (metadata)
    // + CAMT-saldo-endpoint (dezelfde bron als dashboard-banksaldo). Toon per
    // valid-IBAN het slotsaldo + peildatum zodat sectie klopt met dashboard.
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const [regRes, camtRes] = await Promise.all([
        window.supabase.from('bank_accounts').select('id, iban, is_active, gocardless_account_id, balance_fetched_at').order('iban'),
        tryFetch('bank-camt', '/api/finance-bank-camt-balance'),
      ]);
      if (regRes.error) throw regRes.error;
      _bnk.items = regRes.data || [];
      if (camtRes?.__error || camtRes?.error) _bnk.camtError = camtRes.__error || camtRes.error;
      else _bnk.camt = camtRes || null;
    } catch (e) { _bnk.error = e?.message || 'onbekend'; }
    _bnk.loading = false; _bnk.fetched = true;
    if (render) render();
  }
  // v=62 · CAMT-upload flow. Endpoints hergebruikt: finance-bank-camt-upload
  // (POST base64) + finance-bank-camt-transactions (GET recent 15).
  // Guards: _bnk.uploading tegen dubbele POST bij re-render; sync-from-DOM
  // niet nodig want de file-picker is een one-shot event zonder state-render.
  async function _fetchRecentTx() {
    _bnk.recentTxLoading = true; _bnk.recentTxError = null; if (render) render();
    try {
      const j = await tryFetch('camt-tx', '/api/finance-bank-camt-transactions?limit=15');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _bnk.recentTx = Array.isArray(j?.items) ? j.items : [];
    } catch (e) { _bnk.recentTxError = e?.message || 'onbekend'; }
    _bnk.recentTxLoading = false; if (render) render();
  }
  // File → base64 helper (strip 'data:*;base64,'-prefix van FileReader.readAsDataURL).
  function _fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload  = () => { const s = String(rd.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
      rd.onerror = () => reject(new Error('FileReader-fout'));
      rd.readAsDataURL(file);
    });
  }
  window.__setBnkUploadPick = (inputEl) => {
    const file = inputEl?.files?.[0]; if (!file) return;
    if (_bnk.uploading) { showToast('Upload al bezig…', 'warn'); return; }
    // Basis-check: .xml of .053-extensie. Server valideert ook.
    const nm = String(file.name || '');
    if (!/\.(xml|053)$/i.test(nm)) { showToast('Verwacht een .xml of .053 CAMT-bestand', 'warn'); inputEl.value = ''; return; }
    if (file.size > 4 * 1024 * 1024) { showToast('Bestand te groot (>4MB)', 'warn'); inputEl.value = ''; return; }
    openConfirm(`CAMT-bestand "${esc(nm)}" (${Math.round(file.size / 1024)} KB) importeren? Dit voegt bank-transacties toe aan camt_transactions + registreert betalingen matching (via payment-matcher). Bestaande transacties met dezelfde entry_reference worden geskipt (dedupe).`, async () => {
      _bnk.uploading = true; _bnk.uploadError = null; _bnk.uploadResult = null; if (render) render();
      try {
        const b64 = await _fileToBase64(file);
        const j = await tryFetch('camt-upload', '/api/finance-bank-camt-upload', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_name: nm, xml_content_base64: b64 }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        _bnk.uploadResult = j;
        showToast(`Import ok: ${j?.num_inserted || 0} nieuw · ${j?.num_skipped || 0} skip`, 'ok');
        // Reset file-picker + refresh saldo + recent-tx-lijst.
        try { inputEl.value = ''; } catch (_) {}
        _bnk.fetched = false; fetchBank();     // ververst saldo-tabel
        _fetchRecentTx();                       // toont net-geïmporteerde transacties
      } catch (e) {
        _bnk.uploadError = e?.message || 'Import mislukt';
        showToast('Import mislukt: ' + _bnk.uploadError, 'warn');
      } finally {
        _bnk.uploading = false; if (render) render();
      }
    }, 'warn');
  };
  window.__setBnkRecentTxLoad = () => { if (!_bnk.recentTx && !_bnk.recentTxLoading) _fetchRecentTx(); };

  function bodyFinBank() {
    if (!_bnk.fetched && !_bnk.loading) queueMicrotask(() => fetchBank());
    const eurFmt = (cents) => {
      const v = (Number(cents) || 0) / 100;
      return v.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
    };
    const c = _bnk.camt;
    const camtRows = (c?.per_account || []).map(a => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:10px 12px;font-size:12.5px;font-family:'IBM Plex Mono',monospace">${esc(a.account_iban || '—')}</td>
      <td style="padding:10px 12px;font-size:13px;font-weight:600;text-align:right;font-family:'IBM Plex Mono',monospace;color:${(a.balance_cents || 0) < 0 ? 'var(--rose)' : 'var(--emerald)'}">${eurFmt(a.balance_cents)}</td>
      <td style="padding:10px 12px;font-size:11.5px;color:var(--text-3)">${a.as_of_date ? esc(String(a.as_of_date).slice(0, 10)) : '—'}</td>
      <td style="padding:10px 12px;font-size:11.5px">${a.status === 'registered' ? '✓ registered' : a.status === 'inactive' ? '⚠ inactive' : '◇ unregistered'}</td>
    </tr>`).join('');
    const grandTotal = (c?.per_account || []).reduce((sum, a) => sum + (Number(a.balance_cents) || 0), 0);
    const regRows = _bnk.items.map(a => `<tr style="border-top:1px solid var(--border);${a.is_active ? '' : 'opacity:.55'}">
      <td style="padding:6px 12px;font-size:12px;font-family:'IBM Plex Mono',monospace">${esc(a.iban || '—')}</td>
      <td style="padding:6px 12px;font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(a.gocardless_account_id || '—')}</td>
      <td style="padding:6px 12px;font-size:11px">${a.is_active ? '✓ actief' : '⨯ inactief'}</td>
    </tr>`).join('');
    // v=62: upload-blok bovenaan + result + recent-tx-blok.
    const ur = _bnk.uploadResult;
    const uploadBlock = `<div style="padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:600">CAMT-upload · bank-transacties importeren</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Kies een <code>.xml</code>- of <code>.053</code>-bestand van je bank. Dedupe op <code>entry_reference</code>; bestaande transacties worden geskipt. Bank-writes toegestaan — géén incasso-motor.</div>
        </div>
        <label class="btn btn-primary btn-sm" style="cursor:${_bnk.uploading ? 'wait' : 'pointer'};font-size:12px;opacity:${_bnk.uploading ? '.5' : '1'}" title="${_bnk.uploading ? 'Upload bezig…' : 'Kies CAMT-bestand'}">
          ${_bnk.uploading ? '⏳ Uploaden…' : '📎 Kies CAMT-bestand'}
          <input type="file" accept=".xml,.053,application/xml,text/xml" onchange="window.__setBnkUploadPick(this)" ${_bnk.uploading ? 'disabled' : ''} style="display:none" />
        </label>
      </div>
      ${_bnk.uploadError ? `<div style="margin-top:10px;padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px">⚠ ${esc(_bnk.uploadError)}</div>` : ''}
      ${ur ? `<div style="margin-top:10px;padding:10px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:12px;line-height:1.55">
        ✓ Statement <code style="font-family:'IBM Plex Mono',monospace">${esc(String(ur.statement_id || '').slice(0,8))}…</code> geïmporteerd voor IBAN <code>${esc(ur.account_iban || '—')}</code>.
        Nieuw: <b>${ur.num_inserted || 0}</b> · geskipt (dedupe): <b>${ur.num_skipped || 0}</b> · geparsed: <b>${ur.num_parsed || 0}</b>.
        Periode: ${esc(String(ur.statement_from || '').slice(0,10))} → ${esc(String(ur.statement_to || '').slice(0,10))}.
        Slotsaldo: <code>${ur.closing_balance_cents != null ? ((Number(ur.closing_balance_cents) / 100).toLocaleString('nl-NL', { style:'currency', currency:'EUR' })) : '—'}</code>.
      </div>` : ''}
    </div>`;
    return `<div style="max-width:1100px">
      ${uploadBlock}
      <div style="padding:14px 16px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Upload LIVE · registratie/beheer read-only.</b> CAMT-upload boven schrijft echte transacties (<code>camt_transactions</code>) + registreert matching betalingen (<code>payment-matcher</code>). Bank-account CRUD (IBAN toevoegen/deactiveren) blijft eigen brok — verkeerd IBAN raakt dashboard-saldo direct.
        Bovenste saldo-tabel = <code>finance-bank-camt-balance</code>. Onderste = <code>bank_accounts</code>-registratie.
      </div>
      ${_bnk.error   ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_bnk.error)}</div>` : ''}
      ${_bnk.camtError ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ CAMT-saldo laden mislukt: ${esc(_bnk.camtError)}</div>` : ''}

      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Actueel saldo per IBAN (CAMT)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">IBAN</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Slotsaldo</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Peildatum</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Registratie</th>
          </tr></thead>
          <tbody>${camtRows || `<tr><td colspan="4" style="padding:16px;color:var(--text-3);font-size:12.5px">${_bnk.loading ? 'Laden…' : (c ? 'Nog geen CAMT-bestand geüpload.' : '—')}</td></tr>`}
            ${camtRows ? `<tr style="border-top:2px solid var(--border);background:var(--surface-2);font-weight:600">
              <td style="padding:10px 12px;font-size:12.5px">Totaal</td>
              <td style="padding:10px 12px;font-size:13px;text-align:right;font-family:'IBM Plex Mono',monospace;color:${grandTotal < 0 ? 'var(--rose)' : 'var(--emerald)'}">${eurFmt(grandTotal)}</td>
              <td colspan="2" style="padding:10px 12px;font-size:11.5px;color:var(--text-3)">${c?.as_of_date ? 'per ' + esc(String(c.as_of_date).slice(0,10)) : ''}</td>
            </tr>` : ''}
          </tbody>
        </table>
      </div>

      <div style="font-size:13px;font-weight:600;margin-bottom:8px">bank_accounts-registratie (metadata)</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:14px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">IBAN</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">GoCardless account-id</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
          </tr></thead>
          <tbody>${regRows || `<tr><td colspan="3" style="padding:16px;color:var(--text-3);font-size:12.5px">${_bnk.loading ? 'Laden…' : 'Geen registratie-rijen. Saldo is toch correct (via CAMT hierboven).'}</td></tr>`}</tbody>
        </table>
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div>
          <div style="font-size:13px;font-weight:600">Recente transacties (laatste 15)</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Bron: <code>camt_transactions</code>. Bekijk wat er net geïmporteerd is.</div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="window.__setBnkRecentTxLoad()" style="font-size:11px">${_bnk.recentTxLoading ? 'Laden…' : (_bnk.recentTx ? '↻ Vernieuwen' : '📄 Toon transacties')}</button>
      </div>
      ${_bnk.recentTxError ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:8px">⚠ ${esc(_bnk.recentTxError)}</div>` : ''}
      ${_bnk.recentTx ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;min-width:700px">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Datum</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">IBAN</th>
            <th style="text-align:right;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Bedrag</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Tegenpartij</th>
            <th style="text-align:left;padding:6px 12px;font-size:10.5px;color:var(--text-3);font-weight:600">Omschrijving</th>
          </tr></thead>
          <tbody>${(_bnk.recentTx || []).map(t => {
            const cents = Number(t.amount_cents || 0);
            const amt = (cents/100).toLocaleString('nl-NL', { style:'currency', currency: t.currency || 'EUR' });
            const col = cents < 0 ? 'var(--rose)' : 'var(--emerald)';
            return `<tr style="border-top:1px solid var(--border)">
              <td style="padding:6px 12px;font-size:11.5px;color:var(--text-3);white-space:nowrap">${esc(String(t.booking_date || '').slice(0,10))}</td>
              <td style="padding:6px 12px;font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(t.account_iban || '—')}</td>
              <td style="padding:6px 12px;font-size:12px;text-align:right;font-family:'IBM Plex Mono',monospace;color:${col};font-weight:600">${amt}</td>
              <td style="padding:6px 12px;font-size:11.5px">${esc(t.counterparty_name || '—')}</td>
              <td style="padding:6px 12px;font-size:11px;color:var(--text-3);max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(t.description || '')}">${esc(String(t.description || '—').slice(0,80))}</td>
            </tr>`;
          }).join('') || `<tr><td colspan="5" style="padding:14px;color:var(--text-3);font-size:12px;text-align:center">Geen transacties</td></tr>`}</tbody>
        </table>
      </div>` : ''}
    </div>`;
  }

  /* Wave-3 · fin-facturatie — DISPLAY-ONLY na verify-onderzoek.
     Consumption-check (BLOCKER 3): de 3 keys (default_payment_term_days,
     default_vat_percentage, invoice_number_format) worden NIET gelezen door
     api/finance-invoice-create.js of api/_lib/invoice-create-core.js:
       - payment_term_id komt per-call uit body/TL (TeamLeader-department default)
       - vat_percentage komt per line-item uit body (0/6/9/21 hardcoded valid)
       - invoice_number wordt door TeamLeader geleverd (local.invoice_number),
         geen schema-config aan onze kant.
     → Orphan-keys. Save = loze write. Deze sectie is DISPLAY-ONLY tot facturatie
     ze werkelijk consumeert (aparte brok waarin invoice-create-core deze reads
     krijgt met per-department override). */
  function bodyFinFacturatie() {
    return `<div style="max-width:800px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Display-only.</b> Uit onderzoek: de invoice-create-flow leest deze keys nog niet.
        <code>payment_term_id</code> komt per-factuur uit body/TeamLeader-department; <code>vat_percentage</code> zit per line-item; <code>invoice_number</code> wordt door TeamLeader geleverd.
        Voordat we hier écht writes toestaan: aparte brok waarin <code>invoice-create-core.js</code> deze <code>app-settings</code>-defaults leest (met per-department override) — anders is dit een loze knop.
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:10px">Huidige effectieve defaults (bron-code)</div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:12.5px">
            <div style="color:var(--text-3)">Standaard betaaltermijn</div>
            <div style="font-family:'IBM Plex Mono',monospace">TeamLeader per-department (typisch 14 dagen); geen central override</div>
            <div style="color:var(--text-3)">BTW-%</div>
            <div style="font-family:'IBM Plex Mono',monospace">Per line-item ({0, 6, 9, 21}); wizard-default 21% (domestic)</div>
            <div style="color:var(--text-3)">Factuurnummer-schema</div>
            <div style="font-family:'IBM Plex Mono',monospace">TeamLeader-geleverd (typisch YYYY/NNNN); geen central override</div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* Wave-2 · com-wa LIVE via /api/admin-meta-templates-list. Mock-data is weg.
     Submit/sync/delete via bestaande endpoints achter custom confirm (echte Meta-
     actie). Edit/detail = deep-link (form is complex). WA-nummer registreren:
     custom confirm + POST /api/whatsapp-register-number. */
  const _wa = { loading: false, fetched: false, error: null, items: [], busy: {}, modules: [], moduleId: null, folders: [], collapsed: {} };
  async function fetchWaTemplates() {
    if (_wa.loading || _wa.fetched) return;
    _wa.loading = true; _wa.error = null; if (render) render();
    // BLOCKER-fix B4: /api/admin-meta-templates-list eist ?business_account_id=X.
    // We fetchen eerst de WABA-modules-lijst (multi-tenant: Finance/Events kunnen
    // aparte WABA's hebben) en pakken de eerste actieve module. Bij meerdere:
    // picker in UI (module-dropdown boven de tabel).
    const modsJ = await tryFetch('waba-mods', '/api/admin-whatsapp-modules-list');
    const mods = Array.isArray(modsJ?.items) ? modsJ.items.filter(m => m && m.is_active !== false) : [];
    _wa.modules = mods;
    // Selecteer huidige moduleId (behoud user-keuze; anders eerste actieve).
    if (!_wa.moduleId || !mods.some(m => m.business_account_id === _wa.moduleId)) {
      _wa.moduleId = mods[0]?.business_account_id || null;
    }
    if (!_wa.moduleId) {
      _wa.loading = false; _wa.fetched = true;
      _wa.error = 'Geen actieve WABA-module gevonden. Beheer eerst een module in admin.html.';
      if (render) render();
      return;
    }
    // Parallel: templates + folders per WABA (folders is optioneel; super_admin-
    // only endpoint dus 403 voor manager → nette fallback op Meta category).
    const [j, fj] = await Promise.all([
      tryFetch('meta-tpls',    '/api/admin-meta-templates-list?business_account_id=' + encodeURIComponent(_wa.moduleId)),
      tryFetch('meta-folders', '/api/admin-template-folders-list?business_account_id=' + encodeURIComponent(_wa.moduleId)),
    ]);
    _wa.loading = false; _wa.fetched = true;
    if (j?.__error) _wa.error = j.__error;
    else _wa.items = Array.isArray(j?.items) ? j.items : [];
    _wa.folders = Array.isArray(fj?.folders) ? fj.folders : [];
    if (render) render();
  }
  window.__setWaToggleCat = (key) => { _wa.collapsed[key] = !_wa.collapsed[key]; if (render) render(); };

  /* Ronde-27 · WhatsApp template-editor NATIVE port. Faithful subset uit
     admin.html: name (lowercase+_, max50), language (nl/en/en_US/de/fr),
     category (MARKETING/UTILITY/AUTHENTICATION), header_type (NONE/TEXT +
     optional content.text), body_text (max 1024), footer_text (max 60).
     Complex bits (IMAGE/VIDEO/DOCUMENT header + body_examples + buttons
     jsonb) → v27-aparte-brok; MVP UX voor draft-lifecycle. */
  const _metaEd = { open: false, mode: 'create', id: null, busy: false, error: null,
    fields: { name:'', language:'nl', category:'UTILITY', header_type:'NONE', header_text:'', body_text:'', footer_text:'' },
  };
  const _METAED_LANGS = ['nl','en_US','en','de','fr'];
  const _METAED_CATS  = ['MARKETING','UTILITY','AUTHENTICATION'];
  function _metaEdReset() {
    _metaEd.mode = 'create'; _metaEd.id = null; _metaEd.error = null;
    // Ronde-31 BLOK A: uitgebreid met header_url (voor IMAGE/VIDEO/DOCUMENT),
    // examples ({"1":val,"2":val}), buttons (array {type,text,url?,phone_number?}).
    _metaEd.fields = { name:'', language:'nl', category:'UTILITY', header_type:'NONE', header_text:'', header_url:'', body_text:'', footer_text:'', examples:{}, buttons:[] };
    _metaEd.uploading = false;
  }
  window.__setMetaEdOpen = () => {
    if (!_wa.moduleId) { showToast('Kies eerst een WABA-module', 'warn'); return; }
    _metaEdReset(); _metaEd.open = true; if (render) render();
  };
  window.__setMetaEdClose = () => { _metaEd.open = false; _metaEd.error = null; if (render) render(); };
  // Ronde-31 FIX 1 (focus-verlies): setter NIET meer render()en tijdens typen.
  // Alleen state bijwerken. Voor conditional-UI wijzigers (header_type-select
  // met branch in _renderMetaEdModal) → aparte __setMetaEdSelect met render.
  window.__setMetaEdField  = (k, v) => { _metaEd.fields[k] = String(v || ''); };
  window.__setMetaEdSelect = (k, v) => { _metaEd.fields[k] = String(v || ''); if (render) render(); };
  // Body-teller live updaten zonder heel-modal re-render.
  window.__updMetaBodyMeta = (val) => {
    _metaEd.fields.body_text = String(val || '');
    const el = document.getElementById('kv-metaed-body-meta'); if (!el) return;
    const vars = (String(val || '').match(/\{\{\d+\}\}/g) || []).length;
    el.textContent = `${String(val || '').length}/1024 chars · ${vars} variabele${vars===1?'':'n'} gevonden`;
  };
  // Ronde-31 FIX 4: Naam live-preview + on-blur sanitize (zonder re-render, focus behouden).
  window.__updMetaNamePreview = (val) => {
    const raw = String(val || '');
    _metaEd.fields.name = raw;
    const el = document.getElementById('kv-metaed-name-preview'); if (!el) return;
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (cleaned && cleaned !== raw) el.textContent = 'wordt opgeslagen als: ' + cleaned;
    else                            el.textContent = '';
  };
  window.__setMetaEdNameBlur = (val) => {
    const cleaned = String(val || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    _metaEd.fields.name = cleaned;
    const input = document.querySelector('[data-metaed-name]'); if (input && input.value !== cleaned) input.value = cleaned;
    const el = document.getElementById('kv-metaed-name-preview'); if (el) el.textContent = '';
  };
  async function _metaEdOpenEditor(id, template) {
    if (!id) return;
    _metaEdReset();
    _metaEd.mode = 'edit'; _metaEd.id = id; _metaEd.open = true;
    _metaEd.busy = true; if (render) render();
    // Lazy detail-fetch: bewust 1× per editor-open, geen refetch bij render.
    const j = await tryFetch('meta-detail', '/api/admin-meta-templates-detail?id=' + encodeURIComponent(id));
    _metaEd.busy = false;
    if (j?.__error || j?.error) { _metaEd.error = j?.__error || j?.error; if (render) render(); return; }
    const t = j?.template || j;
    if (t) {
      _metaEd.fields.name         = String(t.name || '');
      _metaEd.fields.language     = String(t.language || 'nl');
      _metaEd.fields.category     = String(t.category || 'UTILITY').toUpperCase();
      _metaEd.fields.header_type  = String(t.header_type || 'NONE').toUpperCase();
      _metaEd.fields.header_text  = (t.header_content && typeof t.header_content === 'object' && t.header_content.text) ? String(t.header_content.text) : '';
      _metaEd.fields.header_url   = (t.header_content && typeof t.header_content === 'object' && t.header_content.example_url) ? String(t.header_content.example_url) : '';
      _metaEd.fields.body_text    = String(t.body_text || '');
      _metaEd.fields.footer_text  = String(t.footer_text || '');
      // Examples: obj {"1":val,"2":val,...} of null.
      _metaEd.fields.examples     = (t.body_examples && typeof t.body_examples === 'object') ? { ...t.body_examples } : {};
      // Buttons: array van {type, text, url?, phone_number?}. Normaliseer.
      _metaEd.fields.buttons      = Array.isArray(t.buttons) ? t.buttons.map(b => ({
        type: String(b?.type || 'URL').toUpperCase(),
        text: String(b?.text || ''),
        url: String(b?.url || ''),
        phone_number: String(b?.phone_number || ''),
      })) : [];
    }
    if (render) render();
  }
  window.__setMetaEdEdit = (id, name, status) => {
    if (status === 'approved') {
      // Zoals admin: approved templates → nieuwe versie (kopie), niet inline edit.
      openConfirm(`"${name}" is APPROVED en kan niet worden gewijzigd. Wil je een NIEUWE VERSIE (draft) maken op basis van deze template? Kies daarna een nieuwe naam (bv. ${name}_v2).`, () => {
        _metaEdOpenEditor(id).then(() => {
          if (_metaEd.fields.name) _metaEd.fields.name = _metaEd.fields.name + '_v2';
          _metaEd.mode = 'create'; _metaEd.id = null; if (render) render();
        });
      });
    } else {
      _metaEdOpenEditor(id);
    }
  };
  function _metaEdValidate() {
    const f = _metaEd.fields;
    if (!/^[a-z0-9_]+$/.test(f.name) || f.name.length === 0 || f.name.length > 50) return 'name: alleen lowercase a-z, 0-9 en _, max 50 chars';
    if (!_METAED_LANGS.includes(f.language)) return 'language: ongeldige waarde';
    if (!_METAED_CATS.includes(f.category)) return 'category: ongeldige waarde';
    if (!['NONE','TEXT'].includes(f.header_type)) return 'header_type: alleen NONE/TEXT in deze editor (IMAGE/VIDEO/DOCUMENT → aparte brok)';
    if (f.header_type === 'TEXT' && (!f.header_text.trim() || f.header_text.length > 60)) return 'header_text: verplicht bij TEXT, max 60 chars';
    if (!f.body_text.trim() || f.body_text.length > 1024) return 'body_text: verplicht, max 1024 chars';
    if (f.footer_text && f.footer_text.length > 60) return 'footer_text: max 60 chars';
    return null;
  }
  async function _metaEdSave(alsoSubmit) {
    // Ronde-31 BLOK A: lees DOM-values voor uncontrolled inputs (buttons + examples
    // + header_url + header_text). Sync fields voor validatie + payload-build.
    _metaSyncFieldsFromDom();
    const err = _metaEdValidate();
    if (err) { _metaEd.error = err; if (render) render(); return; }
    _metaEd.busy = true; _metaEd.error = null; if (render) render();
    const f = _metaEd.fields;
    // header_content: null (NONE), {text:} (TEXT), {example_url:} (IMAGE/VIDEO/DOCUMENT).
    let headerContent = null;
    if (f.header_type === 'TEXT')                                                       headerContent = { text: f.header_text };
    else if (['IMAGE','VIDEO','DOCUMENT'].includes(f.header_type) && f.header_url)      headerContent = { example_url: f.header_url };
    // Buttons: filter lege rijen, normaliseer per type.
    const btns = (f.buttons || []).map(b => {
      const t = String(b.type || 'URL').toUpperCase();
      const o = { type: t, text: String(b.text || '').trim() };
      if (t === 'URL')          o.url = String(b.url || '').trim();
      if (t === 'PHONE_NUMBER') o.phone_number = String(b.phone_number || '').trim();
      return o;
    }).filter(b => b.text || b.url || b.phone_number);
    // Examples: alleen keys 1..N met niet-lege value; enum uit body_text-vars.
    const bodyVarsN = (String(f.body_text || '').match(/\{\{\d+\}\}/g) || []).length;
    const exObj = {};
    for (let i = 1; i <= bodyVarsN; i++) {
      const v = String((f.examples || {})[i] || '').trim();
      if (v) exObj[String(i)] = v;
    }
    const payload = {
      business_account_id: _wa.moduleId,
      name: f.name, language: f.language, category: f.category,
      header_type: f.header_type,
      header_content: headerContent,
      body_text: f.body_text,
      footer_text: f.footer_text || null,
    };
    if (btns.length) payload.buttons = btns;
    if (Object.keys(exObj).length) payload.body_examples = exObj;
    const method = _metaEd.mode === 'edit' ? 'PATCH' : 'POST';
    const url = _metaEd.mode === 'edit'
      ? '/api/admin-meta-templates-upsert?id=' + encodeURIComponent(_metaEd.id)
      : '/api/admin-meta-templates-upsert';
    const j = await tryFetch('meta-upsert', url, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (j?.__error || j?.error) { _metaEd.busy = false; _metaEd.error = j?.__error || j?.error; if (render) render(); return; }
    const savedId = j?.template?.id || j?.id || _metaEd.id;
    showToast(_metaEd.mode === 'edit' ? 'Template bijgewerkt' : 'Template aangemaakt', 'ok');
    if (alsoSubmit && savedId) {
      const ok = await new Promise((res) => openConfirm(`Template "${f.name}" direct indienen bij Meta ter goedkeuring? Kan niet worden teruggedraaid.`, () => res(true), 'warn') || res(false));
      if (ok) {
        const sj = await tryFetch('meta-submit', '/api/admin-meta-templates-submit?template_id=' + encodeURIComponent(savedId), { method: 'POST' });
        if (sj?.__error || sj?.error) showToast('Submit mislukt: ' + (sj?.__error || sj?.error), 'warn');
        else showToast('Ingediend bij Meta', 'ok');
      }
    }
    _metaEd.busy = false; _metaEd.open = false;
    _wa.fetched = false; fetchWaTemplates(); // 1x refetch — binnen fetched-guard
    if (render) render();
  }
  // Ronde-31 FIX 2: "Opslaan als concept" achter custom confirm (was direct upsert
  // zonder bevestiging — inconsistent met rest en kostte eerder een test-template).
  window.__setMetaEdSave       = () => {
    const err = _metaEdValidate();
    if (err) { _metaEd.error = err; if (render) render(); return; }
    const nm = String(_metaEd.fields.name || '').trim();
    openConfirm(`Concept-template "${esc(nm) || '(zonder naam)'}" opslaan? Wordt niet naar Meta gestuurd — blijft lokaal totdat je Submit → Meta klikt.`, () => _metaEdSave(false));
  };
  window.__setMetaEdSaveSubmit = () => {
    openConfirm(`Concept opslaan én DIRECT indienen bij Meta? Meta beoordeelt de template; kan uren duren en niet ongedaan gemaakt worden.`, () => _metaEdSave(true), 'warn');
  };
  /* Ronde-31 BLOK A · com-wa dynamische sub-editors (media/buttons/examples).
     FREEZE-LES: typen in een button/example/header-url veld = GEEN modal-re-render.
     Alleen structuurwijzigingen (btn add/remove, header_type switch) → render.
     Uncontrolled inputs met data-attrs; DOM-lezen bij save via _metaSyncFieldsFromDom. */
  const _META_HEADER_TYPES = ['NONE','TEXT','IMAGE','VIDEO','DOCUMENT'];
  const _META_BTN_TYPES    = ['URL','PHONE_NUMBER','QUICK_REPLY'];
  const _META_MAX_BUTTONS  = 3;
  const _META_UPLOAD_ACCEPT = {
    IMAGE:    'image/jpeg,image/png',
    VIDEO:    'video/mp4,video/3gpp',
    DOCUMENT: 'application/pdf',
  };
  // Sync alle uncontrolled inputs (buttons/examples/header_url/header_text/name/body/footer)
  // uit DOM naar _metaEd.fields — vóór validatie/save/type-switch.
  function _metaSyncFieldsFromDom() {
    const q = (sel) => document.querySelector(sel);
    const qAll = (sel) => document.querySelectorAll(sel);
    const f = _metaEd.fields;
    // Simpele inputs.
    const nameEl = q('[data-metaed-name]');       if (nameEl)   f.name        = String(nameEl.value || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
    const bodyEl = q('[data-metaed-body]');       if (bodyEl)   f.body_text   = String(bodyEl.value || '');
    const footEl = q('[data-metaed-footer]');     if (footEl)   f.footer_text = String(footEl.value || '');
    const hTxt   = q('[data-metaed-header-text]');if (hTxt)     f.header_text = String(hTxt.value || '');
    const hUrl   = q('[data-metaed-header-url]'); if (hUrl)     f.header_url  = String(hUrl.value || '');
    // Examples per index.
    f.examples = {};
    qAll('[data-metaed-example]').forEach((el) => { const idx = el.getAttribute('data-metaed-example'); if (idx) f.examples[idx] = String(el.value || ''); });
    // Buttons per index (type/text/url/phone).
    (f.buttons || []).forEach((_, i) => {
      const bt = q(`[data-btn-idx="${i}"][data-btn-field="text"]`);  if (bt) f.buttons[i].text = String(bt.value || '');
      const bu = q(`[data-btn-idx="${i}"][data-btn-field="url"]`);   if (bu) f.buttons[i].url = String(bu.value || '');
      const bp = q(`[data-btn-idx="${i}"][data-btn-field="phone"]`); if (bp) f.buttons[i].phone_number = String(bp.value || '');
    });
  }
  // Structuur-wijzigende actions → re-render (focus was op knop, niet input).
  window.__setMetaAddBtn = () => {
    _metaSyncFieldsFromDom();
    if (!Array.isArray(_metaEd.fields.buttons)) _metaEd.fields.buttons = [];
    if (_metaEd.fields.buttons.length >= _META_MAX_BUTTONS) { showToast(`Max ${_META_MAX_BUTTONS} knoppen`, 'warn'); return; }
    _metaEd.fields.buttons.push({ type: 'URL', text: '', url: '', phone_number: '' });
    if (render) render();
  };
  window.__setMetaRmBtn = (idx) => {
    _metaSyncFieldsFromDom();
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0) return;
    _metaEd.fields.buttons.splice(i, 1);
    if (render) render();
  };
  window.__setMetaBtnType = (idx, val) => {
    _metaSyncFieldsFromDom();
    const i = Number(idx); if (!_metaEd.fields.buttons[i]) return;
    const t = String(val || 'URL').toUpperCase();
    _metaEd.fields.buttons[i].type = _META_BTN_TYPES.includes(t) ? t : 'URL';
    // Wis niet-relevante velden.
    if (t !== 'URL')          _metaEd.fields.buttons[i].url = '';
    if (t !== 'PHONE_NUMBER') _metaEd.fields.buttons[i].phone_number = '';
    if (render) render();
  };
  // Media-upload via bestaand /api/whatsapp-media-upload. Zet response-URL in
  // header_url en re-render (structuur — nieuw thumbnail).
  window.__setMetaUpload = async (inputEl) => {
    const file = inputEl?.files?.[0]; if (!file) return;
    const ht = _metaEd.fields.header_type;
    if (!['IMAGE','VIDEO','DOCUMENT'].includes(ht)) { showToast('Kies eerst media-header (IMAGE/VIDEO/DOCUMENT)', 'warn'); inputEl.value = ''; return; }
    if (file.size > 3 * 1024 * 1024) { showToast('Max 3 MB', 'warn'); inputEl.value = ''; return; }
    _metaSyncFieldsFromDom();
    _metaEd.uploading = true; if (render) render();
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('type', ht);
      const r = await (window.KV && window.KV.authedFetch
        ? window.KV.authedFetch('/api/whatsapp-media-upload', { method: 'POST', body: fd })
        : fetch('/api/whatsapp-media-upload', { method: 'POST', body: fd }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j?.error) throw new Error(j?.error || `HTTP ${r.status}`);
      const url = j?.url || j?.public_url || j?.example_url;
      if (!url) throw new Error('geen URL in response');
      _metaEd.fields.header_url = url;
      showToast('Upload gelukt', 'ok');
    } catch (e) { showToast('Upload mislukt: ' + (e?.message || 'onbekend'), 'warn'); }
    finally { _metaEd.uploading = false; if (render) render(); }
  };
  function _renderMetaEdModal() {
    if (!_metaEd.open) return '';
    const f = _metaEd.fields;
    const bodyVars = (f.body_text.match(/\{\{\d+\}\}/g) || []).length;
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setMetaEdClose()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:720px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:14px;font-weight:600">${_metaEd.mode === 'edit' ? 'Template bewerken' : 'Nieuwe WhatsApp-template'}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">WABA: <code>${esc(_wa.moduleId || '?')}</code></div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setMetaEdClose()">✕</button>
        </div>
        <div style="padding:16px 20px;overflow-y:auto;flex:1">
          ${_metaEd.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">⚠ ${esc(_metaEd.error)}</div>` : ''}
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;margin-bottom:14px">
            <label style="font-size:11.5px;color:var(--text-2)">Naam (lowercase, _, max 50)
              <input type="text" data-metaed-name value="${esc(f.name)}" oninput="window.__updMetaNamePreview(this.value)" onblur="window.__setMetaEdNameBlur(this.value)" ${_metaEd.mode === 'edit' ? 'readonly' : ''} maxlength="50" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" placeholder="bv. eerste_herinnering" />
              <div id="kv-metaed-name-preview" style="font-size:10.5px;color:var(--text-3);margin-top:2px;min-height:12px;font-family:'IBM Plex Mono',monospace"></div>
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Taal
              <select onchange="window.__setMetaEdField('language',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
                ${_METAED_LANGS.map(l => `<option value="${l}" ${f.language === l ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Categorie
              <select onchange="window.__setMetaEdField('category',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
                ${_METAED_CATS.map(c => `<option value="${c}" ${f.category === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Header
              <select onchange="window.__setMetaEdSelect('header_type',this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box">
                <option value="NONE"     ${f.header_type === 'NONE' ? 'selected' : ''}>Geen</option>
                <option value="TEXT"     ${f.header_type === 'TEXT' ? 'selected' : ''}>Tekst</option>
                <option value="IMAGE"    ${f.header_type === 'IMAGE' ? 'selected' : ''}>Afbeelding</option>
                <option value="VIDEO"    ${f.header_type === 'VIDEO' ? 'selected' : ''}>Video</option>
                <option value="DOCUMENT" ${f.header_type === 'DOCUMENT' ? 'selected' : ''}>Document (PDF)</option>
              </select>
            </label>
          </div>
          ${f.header_type === 'TEXT' ? `<label style="font-size:11.5px;color:var(--text-2);display:block;margin-bottom:12px">Header-tekst (max 60)
            <input type="text" data-metaed-header-text value="${esc(f.header_text)}" maxlength="60" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>` : ''}
          ${['IMAGE','VIDEO','DOCUMENT'].includes(f.header_type) ? `<div style="margin-bottom:12px;padding:10px 12px;background:var(--surface-2);border-radius:6px">
            <label style="font-size:11.5px;color:var(--text-2);display:block">Media-URL (example_url, max 2000) <span style="color:var(--text-3)">— publiek bereikbare URL</span>
              <input type="url" data-metaed-header-url value="${esc(f.header_url || '')}" maxlength="2000" placeholder="https://…" style="display:block;margin-top:4px;padding:6px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
            </label>
            <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">
              <label class="btn btn-ghost btn-sm" style="cursor:pointer;font-size:11.5px">
                ${_metaEd.uploading ? 'Uploading…' : `📎 Upload ${f.header_type.toLowerCase()} (max 3 MB)`}
                <input type="file" accept="${_META_UPLOAD_ACCEPT[f.header_type] || '*'}" onchange="window.__setMetaUpload(this)" ${_metaEd.uploading ? 'disabled' : ''} style="display:none" />
              </label>
              ${f.header_url ? `<a href="${esc(f.header_url)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--text-3);text-decoration:underline">preview ↗</a>` : ''}
              <span style="font-size:10.5px;color:var(--text-3)">accept: ${esc(_META_UPLOAD_ACCEPT[f.header_type] || '—')}</span>
            </div>
          </div>` : ''}
          <label style="font-size:11.5px;color:var(--text-2);display:block;margin-bottom:12px">Body (max 1024) — gebruik <code>{{1}}</code>, <code>{{2}}</code>… voor variabelen
            <textarea data-metaed-body oninput="window.__updMetaBodyMeta(this.value)" maxlength="1024" rows="6" style="display:block;margin-top:4px;padding:8px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;font-family:inherit;resize:vertical">${esc(f.body_text)}</textarea>
            <div id="kv-metaed-body-meta" style="font-size:10.5px;color:var(--text-3);margin-top:4px">${f.body_text.length}/1024 chars · ${bodyVars} variabele${bodyVars===1?'':'n'} gevonden</div>
          </label>
          ${bodyVars > 0 ? `<div style="margin-bottom:12px;padding:10px 12px;background:var(--surface-2);border-radius:6px">
            <div style="font-size:11.5px;font-weight:600;color:var(--text-2);margin-bottom:6px">Voorbeeldwaarden per variabele <span style="color:var(--text-3);font-weight:normal">— vereist door Meta voor review, max 1024/veld</span></div>
            <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px">
              ${Array.from({length: bodyVars}, (_, i) => {
                const n = i + 1;
                return `<label style="font-size:11px;color:var(--text-3);display:flex;align-items:center;gap:6px">
                  <code style="font-size:10.5px">{{${n}}}</code>
                  <input type="text" data-metaed-example="${n}" value="${esc((f.examples||{})[n]||'')}" maxlength="1024" placeholder="voorbeeld voor {{${n}}}" style="flex:1;padding:4px 8px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
                </label>`;
              }).join('')}
            </div>
          </div>` : ''}
          <label style="font-size:11.5px;color:var(--text-2);display:block;margin-bottom:12px">Footer (optioneel, max 60)
            <input type="text" data-metaed-footer value="${esc(f.footer_text)}" maxlength="60" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
          </label>
          <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;margin-bottom:8px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
              <div style="font-size:11.5px;font-weight:600;color:var(--text-2)">Interactieve buttons <span style="color:var(--text-3);font-weight:normal">— max ${_META_MAX_BUTTONS}, per type conditionele velden</span></div>
              <button class="btn btn-ghost btn-sm" ${(f.buttons||[]).length >= _META_MAX_BUTTONS ? 'disabled' : ''} onclick="window.__setMetaAddBtn()" style="font-size:11px">➕ Knop</button>
            </div>
            ${(f.buttons||[]).length ? (f.buttons||[]).map((b, i) => `<div style="display:grid;grid-template-columns:130px 1fr 1fr 30px;gap:6px;align-items:center;padding:6px 0;border-top:${i>0?'1px dashed var(--border)':'none'}">
              <select onchange="window.__setMetaBtnType(${i}, this.value)" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">
                ${_META_BTN_TYPES.map(t => `<option value="${t}" ${b.type===t?'selected':''}>${t}</option>`).join('')}
              </select>
              <input type="text" data-btn-idx="${i}" data-btn-field="text" value="${esc(b.text||'')}" maxlength="25" placeholder="label (max 25)" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
              ${b.type==='URL' ? `<input type="url" data-btn-idx="${i}" data-btn-field="url" value="${esc(b.url||'')}" maxlength="2000" placeholder="https://…" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-family:'IBM Plex Mono',monospace" />` :
                b.type==='PHONE_NUMBER' ? `<input type="tel" data-btn-idx="${i}" data-btn-field="phone" value="${esc(b.phone_number||'')}" placeholder="+31612345678 (E.164)" style="padding:4px 6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-family:'IBM Plex Mono',monospace" />` :
                `<div style="font-size:11px;color:var(--text-3);padding:4px 6px">— (quick reply)</div>`}
              <button class="btn btn-ghost btn-sm" onclick="window.__setMetaRmBtn(${i})" style="font-size:12px;color:var(--rose);padding:2px 6px">✕</button>
            </div>`).join('') : `<div style="font-size:11px;color:var(--text-3);padding:4px 2px">Geen knoppen toegevoegd.</div>`}
          </div>
        </div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;background:var(--surface-2)">
          <button class="btn btn-ghost btn-sm" onclick="window.__setMetaEdClose()">Annuleren</button>
          <button class="btn btn-primary btn-sm" ${_metaEd.busy ? 'disabled' : ''} onclick="window.__setMetaEdSave()">${_metaEd.busy ? 'Bezig…' : 'Opslaan als concept'}</button>
          <button class="btn btn-primary btn-sm" ${_metaEd.busy ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__setMetaEdSaveSubmit()">Opslaan + Submit → Meta</button>
        </div>
      </div>
    </div>`;
  }
  window.__setWaModule = (id) => {
    // Picker-guard: lege waarde (module zonder gekoppelde WABA) → nette
    // waarschuwing i.p.v. stille no-op die de vorige tabel laat staan.
    if (!id) { showToast('Deze module heeft geen gekoppeld WhatsApp-account', 'warn'); return; }
    if (id === _wa.moduleId) return;
    _wa.moduleId = id; _wa.fetched = false; _wa.items = []; _wa.folders = []; _wa.error = null;
    fetchWaTemplates();
  };
  async function waCall(id, url, method, label, body) {
    _wa.busy[id] = true; if (render) render();
    const init = { method, headers: { 'Content-Type': 'application/json' } };
    if (body != null) init.body = JSON.stringify(body);
    const j = await tryFetch('meta-' + label, url, init);
    _wa.busy[id] = false;
    if (j?.__error || j?.error) showToast(label + ' mislukt: ' + (j?.__error || j?.error), 'warn');
    else { showToast(label + ' gelukt', 'ok'); _wa.fetched = false; fetchWaTemplates(); }
  }
  // Submit: endpoint verwacht ?template_id=X (niet ?id=). Delete verwacht ?id=X.
  window.__setWaSubmit = (id, name) => openConfirm(`Template "${name}" indienen bij Meta voor review? Kan enige uren duren. Kan niet ongedaan gemaakt worden.`, () => waCall(id, '/api/admin-meta-templates-submit?template_id=' + encodeURIComponent(id), 'POST', 'Submit'), 'warn');
  window.__setWaDelete = (id, name) => openConfirm(`Template "${name}" definitief verwijderen bij Meta? Kan NIET ongedaan gemaakt worden.`, () => waCall(id, '/api/admin-meta-templates-delete?id=' + encodeURIComponent(id), 'DELETE', 'Delete'), 'warn');
  // Sync: endpoint verwacht body.business_account_id.
  window.__setWaSync = () => {
    if (!_wa.moduleId) { showToast('Geen module gekozen', 'warn'); return; }
    openConfirm('Sync alle templates vanaf Meta? Haalt actuele status/versies binnen.', () => waCall('__sync', '/api/admin-meta-templates-sync', 'POST', 'Sync', { business_account_id: _wa.moduleId }), 'warn');
  };
  const _waReg = { pnid: '', pin: '', busy: false, msg: '' };
  // Ronde-31 FIX 1: geen render() bij typen (focus behouden).
  window.__setWaRegPnid = (v) => { _waReg.pnid = String(v || ''); };
  window.__setWaRegPin  = (v) => { _waReg.pin  = String(v || ''); };
  window.__setWaRegSubmit = () => {
    const pnid = _waReg.pnid.trim(); const pin = _waReg.pin.trim();
    if (!/^\d{5,20}$/.test(pnid)) { showToast('Ongeldig phone_number_id', 'warn'); return; }
    if (!/^\d{6}$/.test(pin))     { showToast('PIN moet 6 cijfers zijn', 'warn'); return; }
    openConfirm(`WhatsApp-nummer registreren bij Meta? phone_number_id ${pnid} met PIN ******. Éénmalige actie, kan niet worden teruggedraaid via deze UI.`, async () => {
      _waReg.busy = true; if (render) render();
      const j = await tryFetch('wa-register', '/api/whatsapp-register-number', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone_number_id: pnid, pin }),
      });
      _waReg.busy = false;
      if (j?.__error || j?.error) { showToast('Registratie mislukt: ' + (j?.__error || j?.error), 'warn'); }
      else { _waReg.pnid = ''; _waReg.pin = ''; showToast('WA-nummer geregistreerd', 'ok'); }
      if (render) render();
    }, 'warn');
  };
  function bodyWhatsApp() {
    if (!_wa.fetched && !_wa.loading) queueMicrotask(() => fetchWaTemplates());
    const rows = _wa.items;
    const busySync = !!_wa.busy.__sync;
    // Ronde-25: categorie-groepering. Bron-prioriteit: folder_id (admin-
    // template-folders-list) → Meta category (MARKETING/UTILITY/AUTHENTICATION)
    // → 'Ongesorteerd'. Folders zijn super_admin-only; bij 403 valt de picker
    // netjes op Meta category terug (elke template heeft er één).
    const folderById = {};
    for (const f of (_wa.folders || [])) folderById[f.id] = f.name;
    const categoryFor = (t) => {
      if (t.folder_id && folderById[t.folder_id]) return folderById[t.folder_id];
      if (t.category) return String(t.category).charAt(0).toUpperCase() + String(t.category).slice(1).toLowerCase();
      return 'Ongesorteerd';
    };
    const grouped = new Map();
    for (const t of rows) {
      const cat = categoryFor(t);
      if (!grouped.has(cat)) grouped.set(cat, []);
      grouped.get(cat).push(t);
    }
    // Sortering: bekende folders eerst (in folder-sort_order), dan Meta-cats
    // alfabetisch, dan 'Ongesorteerd' onderaan.
    const folderNamesInOrder = (_wa.folders || []).slice().sort((a,b) => (a.sort_order||0) - (b.sort_order||0)).map(f => f.name);
    const seenCats = new Set();
    const orderedCats = [];
    for (const n of folderNamesInOrder) if (grouped.has(n) && !seenCats.has(n)) { orderedCats.push(n); seenCats.add(n); }
    for (const c of Array.from(grouped.keys()).sort()) if (c !== 'Ongesorteerd' && !seenCats.has(c)) { orderedCats.push(c); seenCats.add(c); }
    if (grouped.has('Ongesorteerd')) orderedCats.push('Ongesorteerd');

    function renderRow(t) {
      const status = (t.status || 'unknown').toLowerCase();
      const pill = status === 'approved' ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">approved</span>'
                : status === 'pending' ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--amber-soft);color:var(--amber);font-weight:600">pending</span>'
                : status === 'rejected' ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--rose-soft);color:var(--rose);font-weight:600">rejected</span>'
                : `<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--surface-2);color:var(--text-3);font-weight:600">${esc(status)}</span>`;
      const busy = !!_wa.busy[t.id];
      const canSubmit = ['draft','local','concept','rejected'].includes(status);
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${esc(t.name || '—')} <span style="color:var(--text-3);font-size:11px">· ${esc(t.language || 'nl')}</span></div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px;font-family:'IBM Plex Mono',monospace">${esc(t.meta_template_id || '(nog geen meta-id)')}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${pill}
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setMetaEdEdit('${esc(t.id)}','${esc(t.name || '')}','${esc(status)}')" style="font-size:11px">${status === 'approved' ? 'Nieuwe versie' : 'Edit'}</button>
          ${canSubmit ? `<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWaSubmit('${esc(t.id)}','${esc(t.name || '')}')" style="font-size:11px">Submit</button>` : ''}
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setWaDelete('${esc(t.id)}','${esc(t.name || '')}')" style="font-size:11px;color:var(--rose)">Delete</button>
        </div>
      </div>`;
    }
    const rowsHtml = rows.length
      ? orderedCats.map(cat => {
          const items = grouped.get(cat).slice().sort((a,b) => String(a.name||'').localeCompare(String(b.name||'')));
          const isOpen = !_wa.collapsed[cat]; // default open
          return `<div style="border-bottom:1px solid var(--border)">
            <button onclick="window.__setWaToggleCat('${esc(cat).replace(/'/g,"\\'")}')" style="width:100%;display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--surface-2);border:none;text-align:left;cursor:pointer;font:inherit;color:var(--text-1)">
              <span style="font-size:11px;color:var(--text-3);width:12px">${isOpen ? '▼' : '▶'}</span>
              <span style="font-size:12.5px;font-weight:600;flex:1">${esc(cat)}</span>
              <span style="font-size:11px;color:var(--text-3)">${items.length} template${items.length === 1 ? '' : 's'}</span>
            </button>
            ${isOpen ? items.map(renderRow).join('') : ''}
          </div>`;
        }).join('')
      : (_wa.loading ? '<div style="padding:16px;color:var(--text-3);font-size:12.5px">Laden…</div>' : '<div style="padding:16px;color:var(--text-3);font-size:12.5px">Geen templates voor deze WABA.</div>');
    // Ronde-25 picker-fix: opties zonder gekoppelde WABA (leeg business_account_id)
    // krijgen `disabled` + label "— geen WhatsApp-account —". Modules die dezelfde
    // WABA delen worden herkenbaar via het gedeelde id (badge achter label).
    const wabaCount = {};
    for (const m of _wa.modules) if (m.business_account_id) wabaCount[m.business_account_id] = (wabaCount[m.business_account_id] || 0) + 1;
    const moduleSel = _wa.modules.length > 1
      ? `<select onchange="window.__setWaModule(this.value)" style="padding:5px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);max-width:280px">
          ${_wa.modules.map(m => {
            const baid = m.business_account_id;
            const shared = baid && wabaCount[baid] > 1 ? ' (gedeelde WABA)' : '';
            const label = esc((m.display_label || m.module || baid || 'onbekend') + shared);
            if (!baid) return `<option value="" disabled>${esc(m.display_label || m.module || 'module')} — geen WhatsApp-account</option>`;
            return `<option value="${esc(baid)}" ${_wa.moduleId === baid ? 'selected' : ''}>${label}</option>`;
          }).join('')}
        </select>`
      : (_wa.modules.length === 1 ? `<span style="font-size:11.5px;color:var(--text-3)">${esc(_wa.modules[0].display_label || _wa.modules[0].module || '')}</span>` : '');
    return `<div style="max-width:900px">
      ${_renderMetaEdModal()}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;margin-bottom:14px;line-height:1.55">
        <b>Native editor.</b> Nieuwe templates aanmaken, bewerken (draft/pending/rejected) of nieuwe versies maken (approved) kan hier direct — inclusief IMAGE/VIDEO/DOCUMENT-header + body-voorbeelden + interactieve buttons (sinds v=40).
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">Meta-templates</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${rows.length} template(s) ${_wa.error ? '· ⚠ ' + esc(_wa.error) : ''}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${moduleSel}
            <button class="btn btn-primary btn-sm" onclick="window.__setMetaEdOpen()">➕ Nieuwe template</button>
            <button class="btn btn-primary btn-sm" ${busySync ? 'disabled' : ''} onclick="window.__setWaSync()">${busySync ? 'Sync…' : '↻ Sync vanaf Meta'}</button>
          </div>
        </div>
        <div>${rowsHtml}</div>
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 14px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">WhatsApp-nummer registreren (éénmalig)</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Cloud API phone_number_id + 6-cijferige PIN. Alleen bij setup van een nieuwe lijn.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end">
            <label style="font-size:11.5px;color:var(--text-2)">phone_number_id
              <input type="text" value="${esc(_waReg.pnid)}" oninput="window.__setWaRegPnid(this.value)" placeholder="bv. 123456789012345" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">PIN (6 cijfers)
              <input type="password" value="${esc(_waReg.pin)}" oninput="window.__setWaRegPin(this.value)" maxlength="6" placeholder="••••••" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box;letter-spacing:.12em" />
            </label>
            <button class="btn btn-primary btn-sm" ${_waReg.busy ? 'disabled' : ''} onclick="window.__setWaRegSubmit()">${_waReg.busy ? 'Bezig…' : 'Registreer'}</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  window.__waPick = (id) => { setF('waf', id); }; // legacy filter — Wave-2 nieuwe bodyWhatsApp gebruikt geen folder-tabs meer

  /* Wave-1 · team-rechten — role-sync backfill werkend + samenvatting live.
     Volledige RBAC-matrix editor blijft in /modules/admin.html (gebruikt directe
     window.supabase + FEATURE_REGISTRY-lib van 400+ regels; port vereist eigen
     brok met AI-refactor naar API-endpoint). Deze sectie toont een LIVE-
     samenvatting per rol (aantal actieve permissions) + role-sync-backfill met
     custom confirm + deep-link naar de matrix. */
  const _rbac = { loading: false, error: null, fetched: false, byRole: {}, busy: false, matrix: {}, snapshot: {}, activeModule: '', dirty: false, saveBusy: false, search: '' };
  async function fetchRbacSummary() {
    if (_rbac.loading || _rbac.fetched) return;
    _rbac.loading = true; _rbac.error = null; if (render) render();
    // Ronde-26: load VOLLEDIGE matrix (rol × permission → bool) via direct-
    // supabase op role_permissions (zelfde pad als admin). Bewaar snapshot
    // voor diff-save. FEATURE_REGISTRY + RBAC_ROLES uit window.KV_RBAC.
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      if (!window.KV_RBAC?.FEATURE_REGISTRY) throw new Error('KV_RBAC registry niet geladen (verwacht /modules/shared/rbac/registry.js)');
      const matrix = {};
      window.KV_RBAC.RBAC_ROLES.forEach(r => { if (!r.auto) matrix[r.key] = {}; });
      const byRole = {};
      let from = 0; const PAGE = 1000;
      while (true) {
        const { data, error } = await window.supabase
          .from('role_permissions')
          .select('role, feature_key, allowed')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        for (const r of rows) {
          if (!r || !r.role) continue;
          if (matrix[r.role]) matrix[r.role][r.feature_key] = r.allowed === true;
          if (!byRole[r.role]) byRole[r.role] = 0;
          if (r.allowed === true) byRole[r.role] += 1;
        }
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      _rbac.matrix = matrix;
      _rbac.snapshot = JSON.parse(JSON.stringify(matrix));
      _rbac.byRole = byRole;
      _rbac.dirty = false;
      if (!_rbac.activeModule) _rbac.activeModule = window.KV_RBAC.FEATURE_REGISTRY[0]?.moduleKey || '';
    } catch (e) {
      _rbac.error = e?.message || 'onbekende fout';
    }
    _rbac.loading = false; _rbac.fetched = true;
    if (render) render();
  }
  window.__setRbacMod = (mk) => { _rbac.activeModule = mk; if (render) render(); };
  // v=61 quick-fix 2: DOM-only filter, geen render bij typen (focus-behoud).
  // Bewaart _rbac.search voor state-behoud bij een echte structuur-render
  // (bv. module-switch), maar de search-input triggert zelf géén render — hij
  // toggelt display:none per rij op basis van data-rbac-feat-label / -key attrs.
  window.__setRbacSearchInput = (val) => {
    const q = String(val || '').toLowerCase().trim();
    _rbac.search = String(val || '');   // state-behoud, GEEN render.
    document.querySelectorAll('[data-rbac-feat-row]').forEach((tr) => {
      const label = String(tr.getAttribute('data-rbac-feat-label') || '').toLowerCase();
      const key   = String(tr.getAttribute('data-rbac-feat-key')   || '').toLowerCase();
      const match = !q || label.includes(q) || key.includes(q);
      tr.style.display = match ? '' : 'none';
    });
  };
  // v=61 quick-fix 3: rij-alles-toggle. Zet alle checkboxes van deze feature-key
  // in álle rollen op de meerderheidsstate omgekeerd (of hard AAN/UIT). Simpel:
  // als >=1 rol AAN staat → alles UIT; als niks AAN → alles AAN. Idempotent-guard
  // via _rbac.matrix update + surgical checkbox-update in DOM zonder full render.
  window.__setRbacRowToggle = (featKey) => {
    const roles = (window.KV_RBAC?.RBAC_ROLES || []).filter(r => !r.auto);
    // Bepaal doel-state: als tenminste 1 rol AAN heeft → alles UIT; anders alles AAN.
    let anyOn = false;
    for (const r of roles) {
      if (_rbac.matrix[r.key] && _rbac.matrix[r.key][featKey]) { anyOn = true; break; }
    }
    const target = !anyOn;
    let changed = 0;
    for (const r of roles) {
      _rbac.matrix[r.key] = _rbac.matrix[r.key] || {};
      const cur = !!_rbac.matrix[r.key][featKey];
      if (cur !== target) { _rbac.matrix[r.key][featKey] = target; changed++; }
      // Surgical DOM-update op de checkbox (voorkomt full render + focus-verlies).
      const cb = document.querySelector(`input[type="checkbox"][data-rbac-role="${r.key}"][data-rbac-feat="${featKey}"]`);
      if (cb) cb.checked = target;
    }
    if (changed) {
      _rbac.dirty = true;
      // Dirty-badge herteken (bovenaan). Simpelste route: re-check via _rbacCountDirty
      // en zet de tekst in-place als 'ie bestaat.
      const badge = document.getElementById('kv-rbac-dirty-badge');
      const n = _rbacCountDirty();
      if (badge) {
        badge.textContent = n + ' niet-opgeslagen wijziging' + (n === 1 ? '' : 'en');
        badge.style.display = n > 0 ? '' : 'none';
      }
      // Save-knop enable/disable.
      const saveBtn = document.getElementById('kv-rbac-save-btn');
      if (saveBtn) saveBtn.disabled = !_rbac.dirty || _rbac.saveBusy;
    }
  };
  function _rbacCountDirty() {
    if (!window.KV_RBAC?.FEATURE_REGISTRY) return 0;
    let n = 0;
    for (const r of window.KV_RBAC.RBAC_ROLES) {
      if (r.auto) continue;
      for (const m of window.KV_RBAC.FEATURE_REGISTRY) {
        for (const f of m.features) {
          const cur  = !!(_rbac.matrix[r.key]   && _rbac.matrix[r.key][f.key]);
          const prev = !!(_rbac.snapshot[r.key] && _rbac.snapshot[r.key][f.key]);
          if (cur !== prev) n++;
        }
      }
    }
    return n;
  }
  window.__setRbacToggle = (role, key, checked) => {
    if (!_rbac.matrix[role]) _rbac.matrix[role] = {};
    _rbac.matrix[role][key] = !!checked;
    // Clear-on-revert: bij 0 werkelijke diff → dirty weg (i.p.v. sticky true).
    _rbac.dirty = _rbacCountDirty() > 0;
    if (render) render();
  };
  window.__setRbacSave = () => {
    if (!_rbac.dirty || _rbac.saveBusy) return;
    const diffN = _rbacCountDirty();
    if (diffN === 0) { _rbac.dirty = false; if (render) render(); return; }
    openConfirm(`${diffN} rechten-wijziging${diffN === 1 ? '' : 'en'} opslaan? Alleen de veranderde cellen worden weggeschreven (diff-save).`, async () => {
      _rbac.saveBusy = true; if (render) render();
      try {
        const now = new Date().toISOString();
        const ups = [];
        for (const r of window.KV_RBAC.RBAC_ROLES) {
          if (r.auto) continue;
          for (const m of window.KV_RBAC.FEATURE_REGISTRY) {
            for (const f of m.features) {
              const cur  = !!(_rbac.matrix[r.key]   && _rbac.matrix[r.key][f.key]);
              const prev = !!(_rbac.snapshot[r.key] && _rbac.snapshot[r.key][f.key]);
              if (cur !== prev) ups.push({ role: r.key, feature_key: f.key, allowed: cur, updated_at: now });
            }
          }
        }
        if (!ups.length) { showToast('Geen wijzigingen', 'ok'); _rbac.saveBusy = false; if (render) render(); return; }
        const { error } = await window.supabase.from('role_permissions').upsert(ups, { onConflict: 'role,feature_key' });
        if (error) throw error;
        _rbac.snapshot = JSON.parse(JSON.stringify(_rbac.matrix));
        _rbac.dirty = false;
        // Update byRole-teller na save.
        const byRole = {};
        for (const rk of Object.keys(_rbac.matrix)) byRole[rk] = Object.values(_rbac.matrix[rk]).filter(Boolean).length;
        _rbac.byRole = byRole;
        showToast(`${ups.length} wijziging${ups.length===1?'':'en'} opgeslagen`, 'ok');
      } catch (e) {
        showToast('Opslaan mislukt: ' + (e?.message || 'onbekend'), 'warn');
      } finally {
        _rbac.saveBusy = false; if (render) render();
      }
    }, 'warn');
  };
  window.__setRbacBackfill = () => {
    openConfirm('Role-sync backfill: dit herschrijft profiles.role voor ELKE gebruiker met de hoogste rol uit user_roles. Alleen doen als je zeker weet dat user_roles de bron-van-waarheid is.', async () => {
      if (_rbac.busy) return;
      _rbac.busy = true; if (render) render();
      const j = await tryFetch('rbac-backfill', '/api/admin-rbac-backfill-roles', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      _rbac.busy = false;
      if (j?.__error || j?.error) { showToast('Backfill mislukt: ' + (j.__error || j.error), 'warn'); }
      else { showToast(`Backfill klaar — ${j?.updated || 0} profiel(en) bijgewerkt`, 'ok'); }
      if (render) render();
    }, 'warn');
  };
  function bodyRechten() {
    if (!_rbac.fetched && !_rbac.loading) queueMicrotask(() => fetchRbacSummary());
    if (_rbac.error) return `<div style="max-width:900px"><div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px">⚠ ${esc(_rbac.error)}</div></div>`;
    if (_rbac.loading && !_rbac.fetched) return `<div style="padding:20px;color:var(--text-3);font-size:13px">Matrix laden…</div>`;
    const registry = window.KV_RBAC?.FEATURE_REGISTRY || [];
    const roles = (window.KV_RBAC?.RBAC_ROLES || []).filter(r => !r.auto);
    const activeMod = registry.find(m => m.moduleKey === _rbac.activeModule) || registry[0];
    const q = _rbac.search.toLowerCase().trim();
    const feats = activeMod ? activeMod.features.filter(f => !q || f.label.toLowerCase().includes(q) || f.key.toLowerCase().includes(q)) : [];
    // Rol-samenvatting
    const rolesSum = Object.entries(_rbac.byRole).sort((a,b) => b[1] - a[1]);
    // Module-picker (links)
    const modList = registry.map(m => `<button onclick="window.__setRbacMod('${esc(m.moduleKey)}')" style="display:block;width:100%;padding:8px 12px;background:${m.moduleKey === (activeMod?.moduleKey||'') ? 'var(--surface-2)' : 'transparent'};border:none;text-align:left;cursor:pointer;font:inherit;font-size:12.5px;color:var(--text);border-radius:6px">${esc(m.moduleLabel || m.moduleKey)}</button>`).join('');
    // Matrix
    const headRoles = roles.map(r => `<th style="text-align:center;padding:6px 8px;font-size:10.5px;font-weight:600;color:var(--text-3);white-space:nowrap">${esc(r.label)}</th>`).join('');
    const rowsHtml = feats.length ? feats.map(f => {
      const cells = roles.map(r => {
        const checked = !!(_rbac.matrix[r.key] && _rbac.matrix[r.key][f.key]);
        // v=61: data-rbac-role + data-rbac-feat voor surgical checkbox-update in __setRbacRowToggle.
        return `<td style="text-align:center;padding:5px 8px"><input type="checkbox" data-rbac-role="${esc(r.key)}" data-rbac-feat="${esc(f.key)}" ${checked ? 'checked' : ''} onchange="window.__setRbacToggle('${esc(r.key)}','${esc(f.key).replace(/'/g,"\\'")}',this.checked)" style="cursor:pointer" /></td>`;
      }).join('');
      // v=61: data-rbac-feat-row + label/key attrs voor surgical filter in __setRbacSearchInput.
      // v=61 quick-fix 3: rij-alles-toggle-knop naast de feature-label.
      return `<tr data-rbac-feat-row data-rbac-feat-key="${esc(f.key)}" data-rbac-feat-label="${esc(f.label)}" style="border-top:1px solid var(--border)">
        <td style="padding:6px 12px">
          <div style="display:flex;align-items:center;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.__setRbacRowToggle('${esc(f.key).replace(/'/g,"\\'")}')" title="Alles aan / alles uit voor deze functie" style="font-size:10.5px;padding:1px 6px;color:var(--text-3)">⇅</button>
            <div>
              <div style="font-size:12.5px;font-weight:500">${esc(f.label)}</div>
              <div style="font-size:10.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(f.key)}</div>
            </div>
          </div>
        </td>
        <td style="text-align:center;padding:5px 8px;color:var(--text-3);font-size:10.5px">auto</td>
        ${cells}
      </tr>`;
    }).join('') : `<tr><td colspan="${roles.length + 2}" style="padding:16px;color:var(--text-3);font-size:12.5px">Geen functies gevonden.</td></tr>`;
    return `<div style="max-width:1200px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
        <div style="font-size:12.5px;color:var(--text-3)">${rolesSum.map(([r,c]) => `${esc(r)}: ${r === 'super_admin' ? '<span style="color:var(--emerald);font-weight:600">bypass</span>' : `<b>${c}</b>`}`).join(' · ')}</div>
        <div style="display:flex;gap:8px;align-items:center">
          <!-- v=61 quick-fix 2: oninput → __setRbacSearchInput (DOM-only filter, GEEN render). -->
          <input type="text" placeholder="Zoek functie…" value="${esc(_rbac.search)}" oninput="window.__setRbacSearchInput(this.value)" style="padding:5px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);max-width:220px" />
          <span id="kv-rbac-dirty-badge" style="font-size:11px;color:var(--amber);font-weight:600;display:${_rbac.dirty ? '' : 'none'}">${_rbacCountDirty()} niet-opgeslagen wijziging${_rbacCountDirty() === 1 ? '' : 'en'}</span>
          <button id="kv-rbac-save-btn" class="btn btn-primary btn-sm" ${!_rbac.dirty || _rbac.saveBusy ? 'disabled' : ''} onclick="window.__setRbacSave()">${_rbac.saveBusy ? 'Opslaan…' : 'Opslaan'}</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:start">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px;max-height:600px;overflow-y:auto">${modList}</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:auto;max-height:600px">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <thead style="position:sticky;top:0;background:var(--surface-2);z-index:1">
              <tr>
                <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Functie</th>
                <th style="text-align:center;padding:6px 8px;font-size:10.5px;color:var(--text-3);font-weight:600;white-space:nowrap">super_admin</th>
                ${headRoles}
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
      <div class="card" style="margin-top:16px;background:var(--surface);border:1px solid var(--rose-line, #f5b4bc);border-radius:10px">
        <div style="padding:10px 14px;background:var(--rose-soft);border-bottom:1px solid var(--rose-line, #f5b4bc);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:12.5px;font-weight:600;color:var(--rose)">Role-sync backfill</div>
            <div style="font-size:11px;color:var(--rose);margin-top:1px">Zet profiles.role = hoogste rol uit user_roles voor elke gebruiker.</div>
          </div>
          <button class="btn btn-primary btn-sm" ${_rbac.busy ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__setRbacBackfill()">${_rbac.busy ? 'Bezig…' : '🔄 Draai backfill'}</button>
        </div>
      </div>
    </div>`;
  }

  // Wave-1 bodyBedrijf-prototype VERWIJDERD (was: hardcoded input-velden + native
  // alert bij Opslaan). Vervangen door Wave-3 display-only bodyBedrijf hierboven
  // (regel ~566): leest /api/config, geen editors, geen native dialogen.
  // Native-alert-bug (BLOCKER 1 uit verify Wave-3) opgelost door deze declaratie
  // te verwijderen — twee `function bodyBedrijf()` in dezelfde scope liet de
  // laatste (deze prototype) winnen en overschreef de nieuwe render.

  /* Ronde-31 STAP 4 · wb-venster — cooldown schrijfbaar (dunning-settings-get/
     update via bestaand endpoint) + office-hours read-only (direct-supabase op
     app_settings.dunning_office_hours; er is geen set-endpoint, editor volgt in
     aparte brok met audit-log). Motor onaangeraakt. */
  const _dsv = { loading: false, fetched: false, error: null, cooldown: null, office: null, busy: false };
  async function fetchDunningVenster() {
    if (_dsv.loading || _dsv.fetched) return;
    _dsv.loading = true; _dsv.error = null; if (render) render();
    try {
      const cRes = await tryFetch('dun-settings-get', '/api/dunning-settings-get');
      if (cRes?.__error || cRes?.error) throw new Error(cRes?.__error || cRes?.error);
      _dsv.cooldown = { days: cRes?.dunning_cooldown_days ?? 7, is_default: !!cRes?.is_default, updated_at: cRes?.updated_at || null };
      // Office-hours: direct-supabase (read-only). Fail-soft: bij RLS-error tonen we defaults.
      try {
        if (window.supabase?.from) {
          const { data, error } = await window.supabase.from('app_settings').select('value, updated_at').eq('key', 'dunning_office_hours').maybeSingle();
          if (!error && data?.value) _dsv.office = { ...data.value, is_default: false, updated_at: data.updated_at };
          else                       _dsv.office = { tz: 'Europe/Amsterdam', start: '08:00', end: '20:00', days: [1,2,3,4,5], is_default: true };
        }
      } catch (_) { _dsv.office = { tz: 'Europe/Amsterdam', start: '08:00', end: '20:00', days: [1,2,3,4,5], is_default: true }; }
    } catch (e) { _dsv.error = e?.message || 'onbekend'; }
    _dsv.loading = false; _dsv.fetched = true; if (render) render();
  }
  window.__setDsvCooldownSave = () => {
    const el = document.querySelector('[data-dsv-field="cooldown"]');
    const n = Number(el?.value);
    if (!Number.isFinite(n) || n < 1 || n > 90 || Math.trunc(n) !== n) { showToast('Cooldown moet integer 1..90 zijn', 'warn'); return; }
    openConfirm(`Cooldown op ${n} dag${n===1?'':'en'} zetten? Klanten krijgen daarna pas na ${n} dagen opnieuw een aanmaning. Effect vanaf volgende cron-run.`, async () => {
      _dsv.busy = true; if (render) render();
      try {
        const j = await tryFetch('dun-settings-update', '/api/dunning-settings-update', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dunning_cooldown_days: n }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast('Cooldown bijgewerkt naar ' + n + ' dagen', 'ok');
        _dsv.fetched = false; fetchDunningVenster();
      } catch (err) { showToast('Opslaan mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _dsv.busy = false; if (render) render(); }
    });
  };
  function bodyVenster() {
    if (!_dsv.fetched && !_dsv.loading) queueMicrotask(() => fetchDunningVenster());
    const c = _dsv.cooldown;
    const o = _dsv.office;
    const dayNames = ['zo','ma','di','wo','do','vr','za'];
    const activeDays = Array.isArray(o?.days) ? o.days.map(d => dayNames[d] || String(d)) : [];
    return `<div style="max-width:1000px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Cooldown schrijfbaar; verzendvenster + dagen alleen-lezen.</b> Cooldown bepaalt hoeveel dagen er tussen 2 aanmaningen voor dezelfde klant moet zitten. Het verzendvenster (uren/dagen/tijdzone) leeft in <code>app_settings.dunning_office_hours</code> zonder set-endpoint — schrijven vereist aparte brok met audit-log.
      </div>
      ${_dsv.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_dsv.error)}</div>` : ''}

      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px">
          <div>
            <div style="font-size:13px;font-weight:600">Cooldown tussen aanmaningen</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Nu: <b>${c?.days ?? '—'} dag${(c?.days??0)===1?'':'en'}</b>${c?.is_default ? ' (default)' : ''}. Motor leest deze bij elke cron-run.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" min="1" max="90" step="1" data-dsv-field="cooldown" value="${esc(String(c?.days ?? 7))}" style="width:80px;padding:4px 8px;font-size:13px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)" />
            <span style="font-size:12px;color:var(--text-3)">dagen</span>
            <button class="btn btn-primary btn-sm" ${_dsv.busy ? 'disabled' : ''} onclick="window.__setDsvCooldownSave()">${_dsv.busy ? 'Bezig…' : 'Opslaan'}</button>
          </div>
        </div>
        ${c?.updated_at ? `<div style="font-size:10.5px;color:var(--text-3);margin-top:4px">Laatst bijgewerkt: ${esc(c.updated_at)}</div>` : ''}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="font-size:13px;font-weight:600">Verzendvenster (office-hours)</div>
        <span style="padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:10.5px;font-weight:600">ALLEEN-LEZEN</span>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px 20px;font-size:12.5px">
        <div><span style="color:var(--text-3)">Tijdzone: </span><code>${esc(o?.tz || 'Europe/Amsterdam')}</code></div>
        <div><span style="color:var(--text-3)">Uren: </span><b>${esc(o?.start || '08:00')}</b> tot <b>${esc(o?.end || '20:00')}</b></div>
        <div style="grid-column:1/-1"><span style="color:var(--text-3)">Actieve dagen: </span>${activeDays.length ? activeDays.map(d => `<code style="margin-right:4px">${d}</code>`).join('') : '<code>ma-vr (default)</code>'}${o?.is_default ? ' <span style="color:var(--text-3);font-size:11px">(default — geen row in app_settings.dunning_office_hours)</span>' : ''}</div>
      </div>
      <div style="margin-top:12px;padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:11px;color:var(--text-3);line-height:1.55">Server-parser: <code>api/_lib/dunning-office-hours.js</code>. Motor gebruikt dit als send-gate in <code>dunning-engine.js</code> — buiten venster gaan berichten in wachtrij tot binnen-venster.</div>
    </div>`;
  }

  function bodyPlaceholder(cur) {
    return `<div class="set-empty">
      <span class="set-empty-ico">${svg(cur.ic || I.settings)}</span>
      <div class="set-empty-t">Instellingen voor "${cur.n}"</div>
      <div class="set-empty-s">Deze instellingen staan nu nog verspreid in de modules. Ze verhuizen allemaal hierheen, zodat je alles vanaf één plek regelt. Detail-panel komt in de data-ronde.</div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=2 — SYSTEEM · Follow-up admin-tools
     Verhuisd 1-op-1 uit followup-v2 v=16 (adminView + 4 helper-cards).
     Endpoints en 3-staps-guard identiek: dry-run → typ "IK BEGRIJP HET" →
     confirm-modal (harde bevestiging vóór live mutatie).
     ═════════════════════════════════════════════════════════════════════ */
  function bodyAccessDenied() {
    return `<div class="set-empty">
      <span class="set-empty-ico">${svg(I.shield || I.settings)}</span>
      <div class="set-empty-t">Alleen super_admin</div>
      <div class="set-empty-s">Deze systeem-tools zijn zichtbaar voor super_admin. Vraag Amigo of Jeffrey om toegang, of gebruik "Bekijk als → Super admin" (dev/preview).</div>
    </div>`;
  }
  function _sysBackfillContactsCard() {
    const busy = _ui.adminBackfillBusy;
    const d = _live.adminBackfillContacts.data;
    const err = _live.adminBackfillContacts.error;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:600">Backfill GHL-contacts</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Trekt email/telefoon bij van GHL voor appointments met ontbrekende contact-info.</div>
        </div>
        <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setAdminBackfillContacts()">${busy ? 'Bezig…' : 'Start backfill'}</button>
      </div>
      ${d ? `<div style="padding:10px 16px;font-size:12px;color:var(--text-2)">Resultaat: <span class="mono">${d.updated}</span>/<span class="mono">${d.totaal}</span> bijgewerkt · <span class="mono">${d.skipped}</span> geskipped · <span class="mono" style="color:var(--rose)">${d.errors}</span> fouten.</div>` : ''}
      ${err ? `<div style="padding:10px 16px;font-size:12px;color:var(--rose)">Fout: ${esc(err)}</div>` : ''}
    </div>`;
  }
  function _sysGhlBackfillCard() {
    const busy = _ui.adminGhlBackfillBusy;
    const d = _live.adminGhlBackfill.data;
    const err = _live.adminGhlBackfill.error;
    const mode = _live.adminGhlBackfill.mode;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--rose-line, #f5b4bc);border-radius:10px">
      <div style="padding:12px 16px;background:var(--rose-soft);border-bottom:1px solid var(--rose-line, #f5b4bc)">
        <div style="font-size:13px;font-weight:600;color:var(--rose)">⚠ GHL-status-backfill (klant-CRM-mutatie)</div>
        <div style="font-size:11.5px;color:var(--rose);margin-top:2px">Zet historische appointments in GHL op status "showed". Muteert live CRM-data. 3 stappen: dry-run → typ "IK BEGRIJP HET" → confirm-modal → execute.</div>
      </div>
      <div style="padding:12px 16px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setAdminGhlBackfillDry()">${busy && mode === 'dry_run' ? 'Bezig…' : '🔍 1. Dry-run (mode=strict, limit=50)'}</button>
        </div>
        ${d && mode === 'dry_run' ? `<div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;margin-bottom:10px">
          <b>Dry-run resultaat:</b> ${d.total_candidates || 0} totaal kandidaten · toont eerste ${d.returned || 0} · limit ${d.limit || 50}${d.skipped_over_limit ? ` · ${d.skipped_over_limit} overgeslagen boven limit` : ''}<br>
          ${d.note ? `<div style="margin-top:6px;font-style:italic">${esc(d.note)}</div>` : ''}
        </div>` : ''}
        ${d && mode === 'dry_run' ? `<div style="border-top:1px solid var(--border);padding-top:10px">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">2. Bevestigen door te typen  ·  3. Confirm-modal → Execute</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" placeholder='Typ "IK BEGRIJP HET"' value="${esc(_ui.adminGhlBackfillConfirm)}" oninput="window.__setAdminGhlBackfillConfirm(this.value)" style="flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px" />
            <button class="btn btn-primary btn-sm" ${busy || _ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET' ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__setAdminGhlBackfillExecute()">${busy && mode === 'executed' ? 'Executing…' : '🚨 EXECUTE'}</button>
          </div>
        </div>` : ''}
        ${d && mode === 'executed' ? `<div style="padding:10px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:12px;margin-top:10px">
          <b>Executed:</b> ${d.succeeded || 0}/${d.processed || 0} bijgewerkt${d.failed ? ` · ${d.failed} fouten` : ''}.
        </div>` : ''}
        ${err ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-top:10px">${esc(err)}</div>` : ''}
      </div>
    </div>`;
  }
  function _sysReportenCard() {
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">📧 Admin-rapporten (cron)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-admin-daily</b> — verstuurt dagelijks 21:00 NL naar admins/managers via e-mail. Dedup per dag+recipient.<br>
          <b>follow-up-admin-weekly</b> — verstuurt zondag 10:00 NL. Dedup per week.<br>
          <span style="color:var(--text-3);font-size:11.5px">Beide draaien server-side (cron). Ontvangers: alle super_admin + manager. Interne mail — geen klant-verzending.</span>
        </div>
      </div>
    </div>`;
  }
  function _sysCronsCard() {
    return `<div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">🔄 GHL-integratie (server-side)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-ghl-appointment-poll</b> — cron elke 15 min. Sync GHL-appointments naar DB. Ghost-detectie.<br>
          <b>follow-up-ghl-conversations-poll</b> — cron elke 15 min. Safety-net voor conversations-webhook.<br>
          <b>follow-up-ghl-conversation-webhook</b> — inkomend van GHL bij nieuwe messages.<br>
          <span style="color:var(--text-3);font-size:11.5px">Alle drie draaien automatisch. Geen UI-actie nodig — check via server-logs.</span>
        </div>
      </div>
    </div>`;
  }
  function bodySysFollowupAdmin() {
    if (!isSuperAdmin()) return bodyAccessDenied();
    return `<div style="max-width:900px">
      ${_sysBackfillContactsCard()}
      ${_sysGhlBackfillCard()}
      ${_sysReportenCard()}
      ${_sysCronsCard()}
    </div>`;
  }
  function _renderConfirmModal() {
    const m = _ui.confirmModal;
    if (!m) return '';
    const tone = m.tone === 'warn' ? 'rose' : 'blue';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setConfirmCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:520px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden">
        <div style="padding:14px 18px;background:var(--${tone}-soft);color:var(--${tone});font-size:13px;font-weight:600">⚠ Bevestigen</div>
        <div style="padding:16px 18px;font-size:13px;color:var(--text-2);line-height:1.55">${esc(m.msg)}</div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__setConfirmCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" style="background:var(--${tone});border-color:var(--${tone})" onclick="window.__setConfirmOk()">Ja, uitvoeren</button>
        </div>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=4 — COMMUNICATIE · E-mail-handtekeningen (DEEL 3 v2 email-round).
     Beheer 1 globale default + optionele per-mailbox override. Server-side
     voegt de handtekening toe via /api/email-send-v2 (handtekening:true).
     ═════════════════════════════════════════════════════════════════════ */
  const MAILBOX_SLUGS = ['info', 'leads', 'partners', 'administratie', 'onboarding', 'events', 'welkom'];
  const _sig = {
    loading: false, error: null, fetched: false,
    items: [],        // gehele lijst uit /api/email-signatures
    active: null,     // welke mailbox open in editor: null=global, of slug
    draft: null,      // { name, body_html, body_text, logo_url } bewerkt
    busy: false, note: '',
  };
  async function fetchSignatures() {
    if (_sig.loading) return;
    _sig.loading = true; _sig.error = null; if (render) render();
    const j = await tryFetch('email-signatures', '/api/email-signatures');
    _sig.loading = false;
    _sig.fetched = true; // v=6: markeer geladen ook bij lege lijst → voorkomt render-loop
    if (j?.__error) _sig.error = j.__error;
    else if (j?.error) _sig.error = j.error;
    else _sig.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  function _sigFor(mailbox) {
    // mailbox=null → global (mailbox IS NULL in DB).
    return _sig.items.find((s) => (mailbox == null ? s.mailbox == null : s.mailbox === mailbox)) || null;
  }
  window.__setSigOpen = (mailbox) => {
    const key = mailbox === '' ? null : mailbox;
    _sig.active = key;
    const row = _sigFor(key);
    _sig.draft = {
      name:      row?.name || (key ? `Handtekening (${key})` : 'Globale standaard'),
      body_html: row?.body_html || '',
      body_text: row?.body_text || '',
      logo_url:  row?.logo_url  || '',
    };
    _sig.note = '';
    if (render) render();
  };
  window.__setSigField = (k, v) => {
    if (!_sig.draft) return;
    _sig.draft[k] = String(v == null ? '' : v);
    _sig.note = '';
  };
  window.__setSigSave = async () => {
    if (_sig.busy || !_sig.draft) return;
    _sig.busy = true; _sig.note = 'Opslaan…'; if (render) render();
    const payload = {
      mailbox: _sig.active || null,
      name:      _sig.draft.name || 'Standaard',
      body_html: _sig.draft.body_html || '',
      body_text: _sig.draft.body_text || '',
      logo_url:  _sig.draft.logo_url  || null,
      is_active: true,
    };
    const j = await tryFetch('sig-save', '/api/email-signatures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15000);
    _sig.busy = false;
    if (j?.__error || j?.error) {
      _sig.note = 'Fout: ' + (j.__error || j.error);
      if (render) render(); return;
    }
    _sig.note = 'Opgeslagen';
    // Refresh
    _sig.items = _sig.items.filter((s) => (payload.mailbox ? s.mailbox !== payload.mailbox : s.mailbox != null));
    if (j?.item) _sig.items.push(j.item);
    if (render) render();
    setTimeout(() => { _sig.note = ''; if (render) render(); }, 2500);
  };
  window.__setSigDelete = async () => {
    if (!_sig.active) { _sig.note = 'De globale default kan niet verwijderd worden.'; if (render) render(); return; }
    if (_sig.busy) return;
    _sig.busy = true; _sig.note = 'Verwijderen…'; if (render) render();
    const j = await tryFetch('sig-delete', '/api/email-signatures?mailbox=' + encodeURIComponent(_sig.active), { method: 'DELETE' }, 10000);
    _sig.busy = false;
    if (j?.__error || j?.error) { _sig.note = 'Fout: ' + (j.__error || j.error); if (render) render(); return; }
    _sig.items = _sig.items.filter((s) => s.mailbox !== _sig.active);
    _sig.active = null;
    _sig.draft = null;
    _sig.note = 'Verwijderd';
    if (render) render();
    setTimeout(() => { _sig.note = ''; if (render) render(); }, 2500);
  };
  function bodyEmailHandtekeningen() {
    if (!isSuperAdmin() && !(window.DFO?.S?.role === 'manager' || window.DFO?.S?.role === 'admin')) {
      return bodyAccessDenied();
    }
    if (!_sig.loading && !_sig.fetched && !_sig.error) {
      // v=6 auto-load: gate op `fetched` i.p.v. `items.length` — lege lijst is
      // legitieme uitkomst (geen per-mailbox handtekeningen). Zonder deze
      // fix triggerde !items.length de fetcher bij ELKE render → infinite loop.
      queueMicrotask(fetchSignatures);
    }
    const active = _sig.active; // null=global, of slug
    const draft = _sig.draft;
    const globalRow = _sigFor(null);
    const perMailbox = MAILBOX_SLUGS.map((mb) => ({ mb, row: _sigFor(mb) }));
    return `<div style="max-width:900px">
      ${_sig.error ? `<div class="card" style="padding:12px 16px;background:var(--rose-soft);color:var(--rose);border-radius:10px;margin-bottom:14px">Fout: ${esc(_sig.error)}</div>` : ''}
      ${_sig.loading ? `<div style="padding:20px;color:var(--text-3);text-align:center">Laden…</div>` : ''}

      <div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600">Beheer handtekeningen</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Klik op een rij om te bewerken. De globale handtekening wordt gebruikt als een mailbox geen eigen handtekening heeft.</div>
        </div>
        <div>
          <button class="btn btn-ghost" onclick="window.__setSigOpen('')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;border:none;border-bottom:1px solid var(--border);background:${active === null && draft ? 'var(--surface-2)' : 'transparent'};cursor:pointer;text-align:left">
            <div>
              <div style="font-size:13px;font-weight:600">🌐 Globaal (standaard)</div>
              <div style="font-size:11.5px;color:var(--text-3)">${globalRow?.name || 'Standaard'} · ${globalRow?.body_html ? 'geconfigureerd' : 'leeg — vul in'}</div>
            </div>
            <span style="font-size:11.5px;color:var(--text-3)">bewerken →</span>
          </button>
          ${perMailbox.map((x) => `
            <button class="btn btn-ghost" onclick="window.__setSigOpen('${esc(x.mb)}')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;border:none;border-bottom:1px solid var(--border);background:${active === x.mb && draft ? 'var(--surface-2)' : 'transparent'};cursor:pointer;text-align:left">
              <div>
                <div style="font-size:13px;font-weight:600">📮 ${esc(x.mb)}@deforexopleiding.nl</div>
                <div style="font-size:11.5px;color:var(--text-3)">${x.row ? (x.row.name || 'Eigen handtekening') : 'geen eigen — valt terug op globale'}</div>
              </div>
              <span style="font-size:11.5px;color:var(--text-3)">bewerken →</span>
            </button>
          `).join('')}
        </div>
      </div>

      ${draft ? `
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-2)">
          <div style="font-size:13px;font-weight:600">${active === null ? '🌐 Globale handtekening bewerken' : '📮 Handtekening voor ' + esc(active) + '@deforexopleiding.nl bewerken'}</div>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Naam (intern label)</div>
            <input type="text" value="${esc(draft.name)}" oninput="window.__setSigField('name', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">HTML (voor mail-clients met opmaak)</div>
            <textarea oninput="window.__setSigField('body_html', this.value)" rows="6" placeholder="<br><br>Met vriendelijke groet,<br>Team – De Forex Opleiding<br><a href='https://deforexopleiding.nl'>deforexopleiding.nl</a>" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_html)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Platte tekst (voor mail-clients zonder HTML)</div>
            <textarea oninput="window.__setSigField('body_text', this.value)" rows="4" placeholder="\n\nMet vriendelijke groet,\nTeam – De Forex Opleiding" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_text)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Logo-URL (optioneel, publieke URL — bv. https://forex-opleiding-interface.vercel.app/dfo-logo-email.png)</div>
            <input type="url" value="${esc(draft.logo_url)}" oninput="window.__setSigField('logo_url', this.value)" placeholder="https://…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px" />
          </label>
          <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);line-height:1.55">
            <b>Tip:</b> voor betrouwbaardere weergave in Outlook/iOS Mail kan een toekomstige versie het logo als inline attachment (CID) versturen. Nu wordt de URL rechtstreeks in de HTML gebruikt. Sommige clients tonen die pas na klik op "afbeeldingen tonen".
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-size:11.5px;color:${/fout/i.test(_sig.note) ? 'var(--rose)' : /opgeslagen|verwijderd/i.test(_sig.note) ? 'var(--emerald)' : 'var(--text-3)'}">${esc(_sig.note)}</div>
            <div style="display:flex;gap:8px">
              ${active ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__setSigDelete()" ${_sig.busy ? 'disabled' : ''}>Verwijderen</button>` : ''}
              <button class="btn btn-primary btn-sm" onclick="window.__setSigSave()" ${_sig.busy ? 'disabled' : ''}>${_sig.busy ? 'Bezig…' : 'Opslaan'}</button>
            </div>
          </div>
        </div>
      </div>` : `
      <div class="set-empty">
        <span class="set-empty-ico">${svg(I.mail)}</span>
        <div class="set-empty-t">Kies een handtekening om te bewerken</div>
        <div class="set-empty-s">Klik hierboven op "Globaal" of op een specifieke mailbox.</div>
      </div>`}
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=5 — COMMUNICATIE · E-mail-sjablonen (DEEL 2 v2 email-round afbouw).
     Volledige CRUD: lijst + editor + soft-delete. Writes via
     POST /api/email-templates (supabaseAdmin, super_admin/admin/manager
     gate). RLS is deny-all voor client — service-role in endpoint.
     ═════════════════════════════════════════════════════════════════════ */
  const TPL_CATEGORIES = ['algemeen', 'sales', 'onboarding', 'events', 'wanbetalers', 'partners', 'welkom'];
  const _tpl = {
    loading: false, error: null, fetched: false,
    items: [],          // gehele lijst (incl. inactive)
    active: null,       // id van bewerkt sjabloon; 'new' = nieuw
    draft: null,        // { name, subject, body_html, body_text, category, is_active }
    busy: false, note: '',
    confirm: null,      // { id, name } → delete-confirm modal
  };
  async function fetchEmailTemplates() {
    if (_tpl.loading) return;
    _tpl.loading = true; _tpl.error = null; if (render) render();
    const j = await tryFetch('email-templates', '/api/email-templates?include_inactive=1');
    _tpl.loading = false;
    _tpl.fetched = true; // v=6: markeer geladen ook bij lege lijst → voorkomt render-loop
    if (j?.__error) _tpl.error = j.__error;
    else if (j?.error) _tpl.error = j.error;
    else _tpl.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  function _tplBlank() {
    return { name: '', subject: '', body_html: '', body_text: '', category: 'algemeen', is_active: true };
  }
  function _extractVars(text) {
    // {{voornaam}}, {{klant.naam}}, etc. Uniek, gesorteerd, max 30 chars/each.
    const s = String(text || '');
    const set = new Set();
    const re = /\{\{\s*([a-zA-Z0-9_.-]{1,40})\s*\}\}/g;
    let m; while ((m = re.exec(s)) !== null) set.add(m[1]);
    return Array.from(set).sort();
  }
  window.__setTplOpen = (id) => {
    const row = _tpl.items.find((t) => t.id === id);
    if (!row) { _tpl.active = null; _tpl.draft = null; if (render) render(); return; }
    _tpl.active = id;
    _tpl.draft = {
      name: row.name || '', subject: row.subject || '',
      body_html: row.body_html || '', body_text: row.body_text || '',
      category: row.category || 'algemeen',
      is_active: row.is_active !== false,
    };
    _tpl.note = '';
    if (render) render();
  };
  window.__setTplNew = () => {
    _tpl.active = 'new';
    _tpl.draft = _tplBlank();
    _tpl.note = '';
    if (render) render();
  };
  window.__setTplCancel = () => {
    _tpl.active = null; _tpl.draft = null; _tpl.note = '';
    if (render) render();
  };
  window.__setTplField = (k, v) => {
    if (!_tpl.draft) return;
    if (k === 'is_active') _tpl.draft.is_active = !!v;
    else _tpl.draft[k] = String(v == null ? '' : v);
    _tpl.note = '';
  };
  window.__setTplSave = async () => {
    if (_tpl.busy || !_tpl.draft) return;
    const d = _tpl.draft;
    if (!String(d.name || '').trim()) { _tpl.note = 'Naam is verplicht'; if (render) render(); return; }
    _tpl.busy = true; _tpl.note = 'Opslaan…'; if (render) render();
    // Verzamel variabelen client-side (endpoint accepteert ze). Extraheer uit
    // beide body-velden zodat we een complete set hebben.
    const vars = Array.from(new Set([..._extractVars(d.body_html), ..._extractVars(d.body_text)])).sort();
    const payload = {
      name: d.name.trim(),
      subject: d.subject || null,
      body_html: d.body_html || '',
      body_text: d.body_text || '',
      category: d.category || 'algemeen',
      variables: vars,
      is_active: !!d.is_active,
    };
    if (_tpl.active && _tpl.active !== 'new') payload.id = _tpl.active;
    const j = await tryFetch('tpl-save', '/api/email-templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15000);
    _tpl.busy = false;
    if (j?.__error || j?.error) {
      _tpl.note = 'Fout: ' + (j.__error || j.error);
      if (render) render(); return;
    }
    // Merge terug in de lijst
    if (j?.item) {
      const idx = _tpl.items.findIndex((t) => t.id === j.item.id);
      if (idx >= 0) _tpl.items[idx] = j.item;
      else _tpl.items.push(j.item);
      _tpl.active = j.item.id;
      _tpl.draft = {
        name: j.item.name || '', subject: j.item.subject || '',
        body_html: j.item.body_html || '', body_text: j.item.body_text || '',
        category: j.item.category || 'algemeen',
        is_active: j.item.is_active !== false,
      };
    }
    _tpl.note = 'Opgeslagen';
    if (render) render();
    setTimeout(() => { _tpl.note = ''; if (render) render(); }, 2500);
  };
  window.__setTplDeleteConfirm = (id) => {
    const row = _tpl.items.find((t) => t.id === id);
    if (!row) return;
    _tpl.confirm = { id, name: row.name || '(zonder naam)' };
    if (render) render();
  };
  window.__setTplDeleteCancel = () => { _tpl.confirm = null; if (render) render(); };
  window.__setTplDeleteOk = async () => {
    const c = _tpl.confirm; if (!c) return;
    _tpl.confirm = null;
    _tpl.busy = true; _tpl.note = 'Verwijderen…'; if (render) render();
    const j = await tryFetch('tpl-del', '/api/email-templates?id=' + encodeURIComponent(c.id), { method: 'DELETE' }, 10000);
    _tpl.busy = false;
    if (j?.__error || j?.error) { _tpl.note = 'Fout: ' + (j.__error || j.error); if (render) render(); return; }
    // Soft-delete: is_active=false lokaal spiegelen zodat de rij zichtbaar
    // blijft (grijs) — user kan 'em reactiveren via de active-toggle.
    const idx = _tpl.items.findIndex((t) => t.id === c.id);
    if (idx >= 0) _tpl.items[idx].is_active = false;
    if (_tpl.active === c.id && _tpl.draft) _tpl.draft.is_active = false;
    _tpl.note = 'Gedeactiveerd (soft-delete)';
    if (render) render();
    setTimeout(() => { _tpl.note = ''; if (render) render(); }, 3000);
  };

  function bodyEmailSjablonen() {
    if (!isSuperAdmin() && !(window.DFO?.S?.role === 'manager' || window.DFO?.S?.role === 'admin')) {
      return bodyAccessDenied();
    }
    if (!_tpl.loading && !_tpl.fetched && !_tpl.error) queueMicrotask(fetchEmailTemplates); // v=6: gate op fetched (lege lijst = legitieme uitkomst — voorheen infinite fetch-loop)
    const draft = _tpl.draft;
    const active = _tpl.active;
    // Groepeer per categorie voor de lijst.
    const byCat = {};
    for (const t of _tpl.items) { (byCat[t.category || 'algemeen'] ||= []).push(t); }
    const cats = Object.keys(byCat).sort();
    const varsPreview = draft
      ? Array.from(new Set([..._extractVars(draft.body_html), ..._extractVars(draft.body_text)])).sort()
      : [];
    return `<div style="max-width:1100px">
      ${_tpl.error ? `<div class="card" style="padding:12px 16px;background:var(--rose-soft);color:var(--rose);border-radius:10px;margin-bottom:14px">Fout: ${esc(_tpl.error)}</div>` : ''}
      <div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">Berichtsjablonen</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Beschikbaar in de compose/reply-picker (📄-knop). Alleen <b>active</b> sjablonen tonen daar.</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.__setTplNew()" ${_tpl.busy ? 'disabled' : ''}>+ Nieuw sjabloon</button>
        </div>
        <div>
          ${_tpl.loading ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Laden…</div>' : ''}
          ${!_tpl.loading && _tpl.items.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Nog geen sjablonen. Klik "+ Nieuw sjabloon" om je eerste aan te maken.</div>` : ''}
          ${cats.map((cat) => `
            <div style="padding:8px 16px 4px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);border-top:1px solid var(--border);background:var(--surface-2)">${esc(cat)}</div>
            ${byCat[cat].map((t) => `
              <div style="padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--border);${active === t.id ? 'background:var(--surface-2)' : ''};${!t.is_active ? 'opacity:.55' : ''}">
                <div style="flex:1;min-width:0;cursor:pointer" onclick="window.__setTplOpen('${esc(t.id)}')">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(t.name)}${!t.is_active ? ' <span style="font-size:10.5px;color:var(--text-3);font-weight:400">(inactief)</span>' : ''}</div>
                  <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(t.subject || '(geen onderwerp)').slice(0, 120))}</div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="window.__setTplOpen('${esc(t.id)}')">Bewerken</button>
                ${t.is_active ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__setTplDeleteConfirm('${esc(t.id)}')">Verwijderen</button>` : ''}
              </div>
            `).join('')}
          `).join('')}
        </div>
      </div>

      ${draft ? `
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-2);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:13px;font-weight:600">${active === 'new' ? '📄 Nieuw sjabloon' : '✏ Sjabloon bewerken'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setTplCancel()">Sluit</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
            <label>
              <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Naam <span style="color:var(--rose)">*</span></div>
              <input type="text" value="${esc(draft.name)}" oninput="window.__setTplField('name', this.value)" placeholder="Bijv. Welkom nieuwe klant" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
            </label>
            <label>
              <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Categorie</div>
              <select onchange="window.__setTplField('category', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px">
                ${TPL_CATEGORIES.map((c) => `<option value="${esc(c)}" ${draft.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Onderwerp (optioneel — vult subject als leeg bij invoegen)</div>
            <input type="text" value="${esc(draft.subject)}" oninput="window.__setTplField('subject', this.value)" placeholder="Bijv. Welkom bij De Forex Opleiding" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Body HTML (voor mail-clients met opmaak)</div>
            <textarea oninput="window.__setTplField('body_html', this.value)" rows="8" placeholder="<p>Hoi {{voornaam}},</p>" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_html)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Body platte tekst (voor mail-clients zonder HTML)</div>
            <textarea oninput="window.__setTplField('body_text', this.value)" rows="5" placeholder="Hoi {{voornaam}},\n\n..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_text)}</textarea>
          </label>
          <div>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Variabelen (auto-gedetecteerd uit <span class="mono">{{key}}</span>-placeholders)</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${varsPreview.length === 0
                ? `<span style="font-size:11.5px;color:var(--text-3);font-style:italic">Geen variabelen in body — gebruik <span class="mono">{{voornaam}}</span> / <span class="mono">{{klant.naam}}</span> etc.</span>`
                : varsPreview.map((v) => `<span style="padding:3px 10px;background:var(--violet-soft, var(--surface-2));color:var(--violet, var(--text-2));border-radius:20px;font-size:11.5px;font-family:'IBM Plex Mono',monospace">{{${esc(v)}}}</span>`).join('')
              }
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" ${draft.is_active ? 'checked' : ''} onchange="window.__setTplField('is_active', this.checked)" style="width:16px;height:16px;cursor:pointer" />
            <span>Actief (zichtbaar in compose-picker)</span>
          </label>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-size:11.5px;color:${/fout/i.test(_tpl.note) ? 'var(--rose)' : /opgeslagen|gedeactiveerd/i.test(_tpl.note) ? 'var(--emerald)' : 'var(--text-3)'}">${esc(_tpl.note)}</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost btn-sm" onclick="window.__setTplCancel()">Annuleren</button>
              <button class="btn btn-primary btn-sm" onclick="window.__setTplSave()" ${_tpl.busy ? 'disabled' : ''}>${_tpl.busy ? 'Bezig…' : (active === 'new' ? 'Aanmaken' : 'Opslaan')}</button>
            </div>
          </div>
        </div>
      </div>` : ''}

      ${_tpl.confirm ? `
      <div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2100;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__setTplDeleteCancel()">
        <div style="background:var(--surface);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:440px;width:100%;padding:22px 24px" onclick="event.stopPropagation()">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">Sjabloon deactiveren?</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px">
            Sjabloon <b>${esc(_tpl.confirm.name)}</b> wordt gedeactiveerd (soft-delete). Het verdwijnt uit de compose-picker maar blijft bewaard — je kunt 'm later reactiveren via de "Actief"-toggle.
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.__setTplDeleteCancel()">Annuleren</button>
            <button class="btn btn-primary btn-sm" style="background:var(--rose);border-color:var(--rose)" onclick="window.__setTplDeleteOk()">Deactiveren</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     Wave-1 · team-gebruikers — migratie van modules/admin.html Gebruikers-tab.
     Endpoints (bestaand): GET /api/admin-users, PATCH /api/admin-users?id=X,
     POST /api/admin-impersonate. Custom confirms via openConfirm(). Lazy-load
     (1 call bij eerste sectie-open); geen fetch-on-render.
     ═════════════════════════════════════════════════════════════════════ */
  const VALID_ROLES = ['super_admin','admin','manager','sales','mentor','marketing','administratie','viewer'];
  const _users = { loading: false, error: null, fetched: false, items: [], busy: {} };
  async function fetchUsers(force) {
    if (_users.loading) return;
    if (_users.fetched && !force) return;
    _users.loading = true; _users.error = null; if (render) render();
    const j = await tryFetch('admin-users', '/api/admin-users');
    _users.loading = false; _users.fetched = true;
    if (j?.__error) _users.error = j.__error;
    else if (j?.error) _users.error = j.error;
    else _users.items = Array.isArray(j?.users) ? j.users : [];
    if (render) render();
  }
  async function patchUser(userId, body, actionLabel) {
    _users.busy[userId] = true; if (render) render();
    const j = await tryFetch('admin-users-patch', '/api/admin-users?id=' + encodeURIComponent(userId), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    _users.busy[userId] = false;
    if (j?.__error || j?.error) {
      showToast((actionLabel || 'Actie') + ' mislukt: ' + (j.__error || j.error), 'warn');
    } else {
      showToast((actionLabel || 'Actie') + ' gelukt', 'ok');
      _users.fetched = false; await fetchUsers(true);
    }
  }
  window.__setUsersChangeRole = (userId, newRole) => {
    if (!userId || !newRole) return;
    const u = _users.items.find(x => x.id === userId);
    if (!u || u.role === newRole) return;
    openConfirm(`Rol wijzigen voor ${u.email}: ${u.role} → ${newRole}?`, () => patchUser(userId, { role: newRole }, 'Rol wijzigen'), 'warn');
  };
  window.__setUsersToggleActive = (userId) => {
    const u = _users.items.find(x => x.id === userId);
    if (!u) return;
    const next = !u.is_active;
    openConfirm(`${next ? 'Activeer' : 'DEACTIVEER'} ${u.email}?${next ? '' : ' Gebruiker verliest toegang.'}`, () => patchUser(userId, { is_active: next }, next ? 'Activeren' : 'Deactiveren'), 'warn');
  };
  window.__setUsersImpersonate = (userId) => {
    const u = _users.items.find(x => x.id === userId);
    if (!u) return;
    openConfirm(`Impersonate ${u.email}? Je zult INGELOGD zijn als deze gebruiker tot je uitlogt. Alleen voor super_admin. Audit-log wordt geschreven.`, async () => {
      const j = await tryFetch('admin-impersonate', '/api/admin-impersonate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_user_id: userId }),
      });
      if (j?.__error || j?.error) { showToast('Impersonate mislukt: ' + (j.__error || j.error), 'warn'); return; }
      showToast('Impersonate actief — herlaad pagina', 'ok');
      // Redirect naar / zodat de nieuwe sessie effect heeft (identiek gedrag admin.html).
      setTimeout(() => { try { window.location.href = '/'; } catch (_) {} }, 800);
    }, 'warn');
  };
  /* Wave-1 · alg-weergave — sidebar-layout (menu-beheer). Toon huidige items
     met visible-toggle per item; save via POST /api/sidebar-layout-save.
     Drag-drop volgorde-editor blijft in admin.html (complexe UI); hier alleen
     zichtbaarheid + rol-selectie. 'admin' item wordt server-side geforceerd
     visible (anti-lockout) — we tonen dat als disabled toggle. */
  const _menu = { loading: false, error: null, fetched: false, role: '', items: [], busy: false, dirty: false, dragIdx: -1 };
  async function fetchMenu() {
    if (_menu.loading) return;
    _menu.loading = true; _menu.error = null; if (render) render();
    const key = _menu.role ? ('sidebar_layout:' + _menu.role) : 'sidebar_layout';
    const j = await tryFetch('menu-layout', '/api/app-settings?key=' + encodeURIComponent(key));
    _menu.loading = false; _menu.fetched = true;
    if (j?.__error) _menu.error = j.__error;
    else if (j?.error && !j.value) _menu.items = []; // 404 = nog niet geconfigureerd
    else {
      const v = j?.value || null;
      _menu.items = (v && Array.isArray(v.items)) ? v.items : [];
    }
    _menu.dirty = false;
    if (render) render();
  }
  window.__setMenuToggle = (key) => {
    const it = _menu.items.find(x => x.key === key);
    if (!it || it.key === 'admin') return; // admin verplicht visible
    it.visible = !it.visible; _menu.dirty = true; if (render) render();
  };
  // Ronde-31 BLOK D · alg-weergave items toevoegen/verwijderen.
  window.__setMenuRemove = (key) => {
    if (key === 'admin') return; // anti-lockout
    const it = _menu.items.find(x => x.key === key); if (!it) return;
    openConfirm(`Menu-item "${key}" verbergen door 'm uit de layout te halen? Kan altijd terug via de + Toevoegen-knop.`, () => {
      _menu.items = _menu.items.filter(x => x.key !== key);
      _menu.dirty = true; if (render) render();
    });
  };
  window.__setMenuAddOpen  = () => { _menu.addOpen = true; if (render) render(); };
  window.__setMenuAddClose = () => { _menu.addOpen = false; if (render) render(); };
  window.__setMenuAdd = (key) => {
    if (!key) return;
    if (_menu.items.some(x => x.key === key)) { showToast('Al aanwezig', 'warn'); return; }
    // Vind default group uit DFO.MODS (voor consistente rendering na load).
    const mod = (window.DFO?.MODS || []).find(m => m.id === key);
    const group = mod?.g || undefined;
    _menu.items.push({ key, visible: true, ...(group ? { group } : {}) });
    _menu.addOpen = false; _menu.dirty = true; if (render) render();
  };
  window.__setMenuDragStart = (idx) => { _menu.dragIdx = idx; };
  window.__setMenuDragOver  = (evt) => { evt.preventDefault(); };
  window.__setMenuDrop = (targetIdx, evt) => {
    if (evt && evt.preventDefault) evt.preventDefault();
    const from = _menu.dragIdx;
    _menu.dragIdx = -1;
    if (from < 0 || from === targetIdx) { if (render) render(); return; }
    const arr = _menu.items;
    const [moved] = arr.splice(from, 1);
    arr.splice(targetIdx, 0, moved);
    _menu.dirty = true; if (render) render();
  };
  window.__setMenuRoleChange = (role) => {
    if (_menu.dirty) {
      openConfirm('Niet-opgeslagen wijzigingen. Wisselen zonder opslaan?', () => {
        _menu.role = role; _menu.fetched = false; fetchMenu();
      }, 'warn');
      return;
    }
    _menu.role = role; _menu.fetched = false; fetchMenu();
  };
  window.__setMenuSave = () => {
    if (_menu.busy || !_menu.dirty) return;
    openConfirm(`Menu-layout opslaan voor ${_menu.role ? 'rol "' + _menu.role + '"' : 'STANDAARD (alle rollen)'}?`, async () => {
      _menu.busy = true; if (render) render();
      const payload = { role: _menu.role || 'default', items: _menu.items.map(i => ({ key: i.key, visible: !!i.visible, ...(i.group ? { group: i.group } : {}) })) };
      const j = await tryFetch('menu-save', '/api/sidebar-layout-save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      _menu.busy = false;
      if (j?.__error || j?.error) { showToast('Opslaan mislukt: ' + (j.__error || j.error), 'warn'); }
      else { _menu.dirty = false; showToast('Menu-layout opgeslagen', 'ok'); }
      if (render) render();
    }, 'warn');
  };
  function bodyWeergave() {
    if (!_menu.fetched && !_menu.loading) queueMicrotask(() => fetchMenu());
    const rolesOpts = ['','super_admin','manager','sales','mentor','marketing','administratie']
      .map(r => `<option value="${r}" ${_menu.role === r ? 'selected' : ''}>${r ? r : 'Standaard (alle rollen)'}</option>`).join('');
    const list = _menu.items.length
      ? _menu.items.map((it, idx) => {
          const locked = it.key === 'admin';
          return `<div draggable="true"
            ondragstart="window.__setMenuDragStart(${idx})"
            ondragover="window.__setMenuDragOver(event)"
            ondrop="window.__setMenuDrop(${idx}, event)"
            style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:grab;background:var(--surface)"
            onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='var(--surface)'">
            <span style="color:var(--text-3);font-size:14px;cursor:grab;user-select:none" title="Slepen om te herordenen">⋮⋮</span>
            <div style="flex:1;font-size:12.5px">${esc(it.key)}${it.group ? ` <span style="color:var(--text-3);font-size:11px">· ${esc(it.group)}</span>` : ''}${locked ? ` <span style="font-size:10px;color:var(--text-3)">(verplicht zichtbaar)</span>` : ''}</div>
            <button class="btn btn-ghost btn-sm" ${locked ? 'disabled' : ''} onclick="window.__setMenuToggle('${esc(it.key)}')" style="font-size:11.5px">${it.visible ? '✓ zichtbaar' : '⨯ verborgen'}</button>
            <button class="btn btn-ghost btn-sm" ${locked ? 'disabled' : ''} onclick="window.__setMenuRemove('${esc(it.key)}')" style="font-size:11px;color:var(--rose)" title="Uit layout halen">✕</button>
          </div>`;
        }).join('')
      : `<div style="padding:16px;color:var(--text-3);font-size:12.5px">Nog geen items geconfigureerd voor deze rol — sidebar toont standaard-set. Voeg items toe via de + Toevoegen-knop, of sleep uit een andere rol.</div>`;
    // Ronde-31 BLOK D: add-picker met alle DFO.MODS-items die nog niet in de layout zitten.
    const usedKeys = new Set(_menu.items.map(x => x.key));
    const available = (window.DFO?.MODS || []).filter(m => !usedKeys.has(m.id));
    const addPicker = _menu.addOpen ? `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setMenuAddClose()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">Menu-item toevoegen</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setMenuAddClose()">✕</button>
        </div>
        <div style="overflow-y:auto;flex:1">
          ${available.length ? available.map(m => `<button onclick="window.__setMenuAdd('${esc(m.id)}')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:9px 14px;background:transparent;border:none;border-bottom:1px solid var(--border);text-align:left;cursor:pointer;font:inherit;color:var(--text)">
            <div><div style="font-size:12.5px;font-weight:500">${esc(m.naam || m.id)}</div><div style="font-size:10.5px;color:var(--text-3);margin-top:1px">${esc(m.id)}${m.g ? ` · ${esc(m.g)}` : ''}</div></div>
            <span style="font-size:11px;color:var(--emerald)">+ Voeg toe</span>
          </button>`).join('') : `<div style="padding:20px;color:var(--text-3);font-size:12.5px;text-align:center">Alle beschikbare modules staan al in de layout.</div>`}
        </div>
      </div>
    </div>` : '';
    return `<div style="max-width:900px">
      ${addPicker}
      <div style="padding:12px 14px;background:var(--emerald-soft);color:var(--emerald);border-radius:8px;font-size:12.5px;margin-bottom:14px;line-height:1.55">
        <b>Menu-editor in-sectie.</b> Sleep items met het ⋮⋮-handvat om te herordenen; klik ✓/⨯ om te tonen/verbergen; ✕ om uit de layout te halen; + Toevoegen om ontbrekende modules terug te zetten. Opslaan schrijft de layout per rol naar <code>app_settings.sidebar_layout[:role]</code>. Wijzigingen zichtbaar na herladen.
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--text-2)">Rol:
          <select onchange="window.__setMenuRoleChange(this.value)" style="margin-left:6px;padding:5px 8px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">${rolesOpts}</select>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="window.__setMenuAddOpen()" style="font-size:11.5px">+ Toevoegen (${available.length})</button>
        ${_menu.dirty ? '<span style="font-size:11px;color:var(--amber)">niet-opgeslagen wijzigingen</span>' : ''}
        <button class="btn btn-primary btn-sm" ${!_menu.dirty || _menu.busy ? 'disabled' : ''} onclick="window.__setMenuSave()" style="margin-left:auto">${_menu.busy ? 'Opslaan…' : 'Opslaan'}</button>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">${list}</div>
    </div>`;
  }

  /* Wave-1 · team-mentoren ← Mentor↔Bubble-koppeling. Toont per actieve
     mentor de huidige koppel-status + picker om te (ont)koppelen. Endpoints:
     GET team-members-bubble-status (lijst), GET bubble-mentors-list (picker),
     POST mentor-bubble-link (koppel), POST team-member-ensure (fallback als
     mentor nog geen team_member-rij heeft). Custom confirm bij ontkoppel. */
  const _mnt = { loading: false, fetched: false, error: null, mentors: [], bubbleList: [], bubbleFetched: false, pickerFor: null, pickerQ: '', busy: {} };
  async function fetchMentoren() {
    if (_mnt.loading || _mnt.fetched) return;
    _mnt.loading = true; _mnt.error = null; if (render) render();
    const j = await tryFetch('mnt-status', '/api/team-members-bubble-status');
    _mnt.loading = false; _mnt.fetched = true;
    if (j?.__error) _mnt.error = j.__error;
    else if (j?.error) _mnt.error = j.error;
    else _mnt.mentors = Array.isArray(j?.mentors) ? j.mentors : [];
    if (render) render();
  }
  async function fetchBubbleList() {
    if (_mnt.bubbleFetched) return;
    const j = await tryFetch('mnt-bubble', '/api/bubble-mentors-list');
    _mnt.bubbleFetched = true;
    _mnt.bubbleList = Array.isArray(j?.mentors) ? j.mentors : [];
    if (render) render();
  }
  window.__setMntOpenPicker = (teamMemberId) => {
    _mnt.pickerFor = teamMemberId;
    _mnt.pickerQ = '';
    if (!_mnt.bubbleFetched) fetchBubbleList();
    else if (render) render();
  };
  window.__setMntClosePicker = () => { _mnt.pickerFor = null; if (render) render(); };
  window.__setMntPickerQ    = (v) => { _mnt.pickerQ = String(v || ''); if (render) render(); };
  async function linkMentor(teamMemberId, bubbleUserId, label) {
    _mnt.busy[teamMemberId] = true; if (render) render();
    const j = await tryFetch('mnt-link', '/api/mentor-bubble-link', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team_member_id: teamMemberId, bubble_user_id: bubbleUserId }),
    });
    _mnt.busy[teamMemberId] = false;
    if (j?.__error || j?.error) showToast('Koppelen mislukt: ' + (j.__error || j.error), 'warn');
    else { showToast(label || 'Koppeling bijgewerkt', 'ok'); _mnt.fetched = false; fetchMentoren(); }
    _mnt.pickerFor = null;
    if (render) render();
  }
  window.__setMntPickBubble = (bubbleUserId) => {
    if (!_mnt.pickerFor) return;
    linkMentor(_mnt.pickerFor, bubbleUserId, 'Gekoppeld aan Bubble');
  };
  window.__setMntUnlink = (teamMemberId, mentorName) => {
    openConfirm(`Bubble-koppeling verbreken voor ${mentorName || 'deze mentor'}? Het mentor-dashboard verliest z'n Bubble-data-koppeling.`, () => {
      linkMentor(teamMemberId, null, 'Bubble-koppeling verbroken');
    }, 'warn');
  };
  /* Ronde-31 BLOK B · team-mentoren — cash-vergoedingen sectie.
     Endpoints bestaan: mentor-cash-trajects-list / -status / -release.
     Permission: mentor.ledger.write. Motor: cron-mentor-cash-cron (niet aangeraakt).
     Section wordt onder de Bubble-koppeling-tabel gerenderd. Read-first via list;
     status-actions per rij (pause/resume/delete) + globale Release-knop. */
  const _mnc = { loading: false, fetched: false, error: null, trajects: [], busy: {}, releasing: false, lastRelease: null };
  async function fetchMntCash() {
    if (_mnc.loading || _mnc.fetched) return;
    _mnc.loading = true; _mnc.error = null; if (render) render();
    try {
      const j = await tryFetch('mnc-list', '/api/mentor-cash-trajects-list');
      if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
      _mnc.trajects = j?.trajects || [];
    } catch (e) { _mnc.error = e?.message || 'onbekend'; }
    _mnc.loading = false; _mnc.fetched = true; if (render) render();
  }
  window.__setMntCashRefresh = () => { _mnc.fetched = false; fetchMntCash(); };
  window.__setMntCashStatus = (id, action) => {
    const t = _mnc.trajects.find(x => x.id === id); if (!t) return;
    const label = ({ pause: 'PAUZEER', resume: 'HERVAT', delete: 'VERWIJDER' })[action] || action;
    const warn = action === 'delete' ? ' Rij verdwijnt permanent (audit-log behouden server-side).' : '';
    openConfirm(`${label} cash-traject "${esc(t.client_label || '(zonder label)')}" (€${Number(t.total_amount||0).toFixed(2)}, ${t.term_count||'?'} termijnen)?${warn}`, async () => {
      _mnc.busy[id] = true; if (render) render();
      try {
        const j = await tryFetch('mnc-status', '/api/mentor-cash-traject-status', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action }),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        showToast(({ pause: 'Gepauzeerd', resume: 'Hervat', delete: 'Verwijderd' })[action], 'ok');
        _mnc.fetched = false; fetchMntCash();
      } catch (err) { showToast('Actie mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { delete _mnc.busy[id]; if (render) render(); }
    }, action === 'delete' ? 'warn' : undefined);
  };
  window.__setMntCashRelease = () => {
    openConfirm(`Vrijval-motor draaien voor ALLE actieve cash-trajecten? Dit voert de release-berekeningen uit voor elke termijn die vandaag vrijkomt, per event-mentor. Draait normaal via cron; handmatig alleen voor bijzondere gevallen.`, async () => {
      _mnc.releasing = true; if (render) render();
      try {
        const j = await tryFetch('mnc-release', '/api/mentor-cash-traject-release', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        if (j?.__error || j?.error) throw new Error(j?.__error || j?.error);
        const parts = [];
        if (typeof j?.processed === 'number')  parts.push(`${j.processed} verwerkt`);
        if (typeof j?.released === 'number')   parts.push(`${j.released} uitgekeerd`);
        if (typeof j?.skipped === 'number')    parts.push(`${j.skipped} overgeslagen`);
        _mnc.lastRelease = { at: new Date().toISOString(), summary: parts.join(' · ') || 'OK', raw: j };
        showToast('Vrijval-motor uitgevoerd', 'ok');
        _mnc.fetched = false; fetchMntCash();
      } catch (err) { showToast('Vrijval mislukt: ' + (err?.message || 'onbekend'), 'warn'); }
      finally { _mnc.releasing = false; if (render) render(); }
    }, 'warn');
  };
  function _mncCashBlock() {
    if (!_mnc.fetched && !_mnc.loading) queueMicrotask(() => fetchMntCash());
    const rows = _mnc.trajects.map(t => {
      const busy = !!_mnc.busy[t.id];
      const pill = ({
        active:    '<span style="padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-size:11px;font-weight:600">actief</span>',
        paused:    '<span style="padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-size:11px;font-weight:600">gepauzeerd</span>',
        completed: '<span style="padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-3);font-size:11px;font-weight:600">voltooid</span>',
      })[t.status] || `<span style="padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-3);font-size:11px">${esc(t.status || '—')}</span>`;
      const evTitle = t.event?.title || (t.event_id ? String(t.event_id).slice(0,8)+'…' : '—');
      const startM = t.start_month ? String(t.start_month).slice(0,7) : '—';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(t.client_label || '—')}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(evTitle)}</td>
        <td style="padding:8px 12px;font-size:12px;text-align:right;font-family:'IBM Plex Mono',monospace">€${Number(t.total_amount||0).toFixed(2)}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${t.term_count || '—'}</td>
        <td style="padding:8px 12px;font-size:11.5px">${esc(startM)}</td>
        <td style="padding:8px 12px;font-size:11.5px;text-align:center">${t.release_day || '—'}</td>
        <td style="padding:8px 12px">${pill}</td>
        <td style="padding:6px 12px;text-align:right;white-space:nowrap">
          ${t.status === 'active'    ? `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMntCashStatus('${esc(t.id)}','pause')" style="font-size:11px">Pauzeer</button>` : ''}
          ${t.status === 'paused'    ? `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMntCashStatus('${esc(t.id)}','resume')" style="font-size:11px;color:var(--emerald)">Hervat</button>` : ''}
          ${t.status !== 'completed' ? `<button class="btn btn-ghost btn-sm" ${busy?'disabled':''} onclick="window.__setMntCashStatus('${esc(t.id)}','delete')" style="font-size:11px;color:var(--rose)">Verwijder</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    const lr = _mnc.lastRelease;
    return `<div style="margin-top:22px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:600">Cash-vergoedingen · trajecten</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${_mnc.trajects.length} traject(en) · bron: <code>mentor_cash_trajects</code></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__setMntCashRefresh()" style="font-size:11px">↻ Vernieuwen</button>
          <button class="btn btn-primary btn-sm" ${_mnc.releasing?'disabled':''} onclick="window.__setMntCashRelease()" style="font-size:11px;background:var(--amber);border-color:var(--amber)">${_mnc.releasing?'Bezig…':'💸 Vrijval-motor draaien'}</button>
        </div>
      </div>
      ${_mnc.error ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:8px">⚠ ${esc(_mnc.error)}</div>` : ''}
      ${lr ? `<div style="padding:8px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:11.5px;margin-bottom:8px">Laatste vrijval: ${esc(lr.summary)} <span style="color:var(--text-3);margin-left:8px">${esc(lr.at)}</span></div>` : ''}
      <div style="overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Klant/label</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Event</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Totaal</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Termijnen</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Start</th>
            <th style="text-align:center;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Release-dag</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Acties</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="8" style="padding:16px;color:var(--text-3);font-size:12.5px;text-align:center">${_mnc.loading?'Laden…':'Geen cash-trajecten'}</td></tr>`}</tbody>
        </table>
      </div>
      <div style="margin-top:10px;padding:10px 14px;background:var(--surface-2);border-radius:6px;font-size:11px;color:var(--text-3);line-height:1.55">Aanmaken van nieuwe cash-trajecten vraagt event-context (event_id + termijnen + bedrag); die flow leeft in de Mentoren-module. Deze sectie beheert bestaande trajecten (pauzeer/hervat/verwijder) + de globale vrijval-motor.</div>
    </div>`;
  }

  function bodyMentoren() {
    if (!_mnt.fetched && !_mnt.loading) queueMicrotask(() => fetchMentoren());
    if (_mnt.loading && !_mnt.mentors.length) return `<div style="padding:24px;color:var(--text-3)">Laden…</div>`;
    if (_mnt.error) return `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:13px">⚠ ${esc(_mnt.error)}</div>`;
    const rows = _mnt.mentors.map(m => {
      const busy = !!_mnt.busy[m.id];
      const linked = !!m.bubble_user_id;
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:8px 12px;font-size:12.5px">${esc(m.name || '—')}</td>
        <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(m.email || '—')}</td>
        <td style="padding:8px 12px;font-size:11.5px">${linked ? `<span style="color:var(--emerald)">✓ ${esc(m.bubble_user_id).slice(0,10)}…</span>` : `<span style="color:var(--text-3)">niet gekoppeld</span>`}</td>
        <td style="padding:8px 12px;text-align:right">
          ${linked
            ? `<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setMntUnlink('${m.id}', '${esc(m.name || '')}')" style="font-size:11px;color:var(--rose)">Ontkoppel</button>`
            : `<button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setMntOpenPicker('${m.id}')" style="font-size:11px">Koppel Bubble…</button>`}
        </td>
      </tr>`;
    }).join('');
    const picker = _mnt.pickerFor ? _renderMntPicker() : '';
    // Polish C: mentoren-lijst komt uit /api/team-members-bubble-status die
    // ALLE actieve mentoren (gekoppeld + niet) returnt via user_roles + is_active.
    // Als telling afwijkt van de Mentoren-module (bv. 6 hier vs 7 daar), zit dat
    // in test-mentor-filtering elders. Endpoint filtert alleen op is_active.
    return `<div style="max-width:1000px">
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:8px">${_mnt.mentors.length} actieve mentor(en) — bron: /api/team-members-bubble-status</div>
      <div style="overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Naam</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">E-mail</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Bubble</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Actie</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${_mncCashBlock()}
      ${picker}
    </div>`;
  }
  function _renderMntPicker() {
    const q = _mnt.pickerQ.toLowerCase().trim();
    const filtered = q ? _mnt.bubbleList.filter(x => (x.name || '').toLowerCase().includes(q) || (x.email || '').toLowerCase().includes(q)) : _mnt.bubbleList;
    const list = _mnt.bubbleFetched
      ? (filtered.length
          ? filtered.slice(0, 50).map(x => `<button onclick="window.__setMntPickBubble('${esc(x.bubble_user_id)}')" style="display:flex;flex-direction:column;padding:8px 12px;background:transparent;border:none;border-bottom:1px solid var(--border);text-align:left;cursor:pointer;font:inherit;width:100%">
              <span style="font-size:12.5px;font-weight:500;color:var(--text)">${esc(x.name || '—')}</span>
              <span style="font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(x.email || '')} · ${esc(x.bubble_user_id).slice(0,12)}…</span>
            </button>`).join('')
          : `<div style="padding:16px;color:var(--text-3);font-size:12.5px">Geen resultaten</div>`)
      : `<div style="padding:16px;color:var(--text-3);font-size:12.5px">Bubble-lijst laden…</div>`;
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setMntClosePicker()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:560px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:14px;font-weight:600">Kies Bubble-user</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setMntClosePicker()">✕</button>
        </div>
        <div style="padding:12px 18px;border-bottom:1px solid var(--border)">
          <input type="text" placeholder="Zoek op naam of e-mail…" value="${esc(_mnt.pickerQ)}" oninput="window.__setMntPickerQ(this.value)" style="width:100%;padding:7px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);box-sizing:border-box" />
        </div>
        <div style="overflow-y:auto;flex:1">${list}</div>
      </div>
    </div>`;
  }

  /* Wave-1 · sales-offerte — TL email-template + sales-uitzonderingen
     (min term / max start-dagen). Reads via /api/app-settings + /api/teamleader-
     email-templates. Writes via /api/app-settings PUT. Custom confirm bij save. */
  const _sof = {
    loading: false, fetched: false, error: null,
    tplList: [], tplDefault: null, tplChanged: false,
    minTerm: '', maxDays: '', settingsChanged: false,
    busy: false,
  };
  async function fetchSalesOfferte() {
    if (_sof.loading || _sof.fetched) return;
    _sof.loading = true; _sof.error = null; if (render) render();
    // BLOCKER-1/2 fix: shape matcht admin.html — value.amount + value.days
    // (objecten, geen scalars). Template zit op teamleader-settings, niet
    // app-settings. Templates-endpoint kan verschillende keys leveren.
    const [tpls, tlSettings, minT, maxD] = await Promise.all([
      tryFetch('tl-email-tpls',  '/api/teamleader-email-templates'),
      tryFetch('tl-settings',    '/api/teamleader-settings'),
      tryFetch('sof-min',        '/api/app-settings?key=sales_min_term_amount'),
      tryFetch('sof-maxdays',    '/api/app-settings?key=sales_max_start_days'),
    ]);
    _sof.loading = false; _sof.fetched = true;
    _sof.tplList     = Array.isArray(tpls?.items || tpls?.templates) ? (tpls.items || tpls.templates) : [];
    _sof.tplDefault  = tlSettings?.settings?.default_email_template_id ?? tlSettings?.default_email_template_id ?? null;
    const mObj = minT?.value; const dObj = maxD?.value;
    const mNum = (mObj && typeof mObj === 'object' && Number.isFinite(Number(mObj.amount))) ? Number(mObj.amount) : (Number.isFinite(Number(minT?.value)) ? Number(minT.value) : 400);
    const dNum = (dObj && typeof dObj === 'object' && Number.isFinite(Number(dObj.days)))   ? Number(dObj.days)   : (Number.isFinite(Number(maxD?.value)) ? Number(maxD.value) : 40);
    _sof.minTerm = String(mNum);
    _sof.maxDays = String(dNum);
    _sof.tplChanged      = false;
    _sof.settingsChanged = false;
    if (render) render();
  }
  window.__setSofTplChange = (v) => { _sof.tplDefault = v || null; _sof.tplChanged = true; if (render) render(); };
  window.__setSofMinChange = (v) => { _sof.minTerm = String(v || ''); _sof.settingsChanged = true; if (render) render(); };
  window.__setSofMaxChange = (v) => { _sof.maxDays = String(v || ''); _sof.settingsChanged = true; if (render) render(); };
  window.__setSofSaveTpl = () => {
    if (!_sof.tplChanged || _sof.busy) return;
    openConfirm('Standaard offerte-mail-template opslaan? Nieuwe offertes gebruiken deze template.', async () => {
      _sof.busy = true; if (render) render();
      // BLOCKER-1 fix: PUT /api/teamleader-settings (admin gebruikt dit endpoint,
      // niet app-settings). Key = default_email_template_id.
      const j = await tryFetch('sof-put-tpl', '/api/teamleader-settings', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'default_email_template_id', value: _sof.tplDefault || null }),
      });
      _sof.busy = false;
      if (j?.__error || j?.error) showToast('Opslaan mislukt: ' + (j.__error || j.error), 'warn');
      else { _sof.tplChanged = false; showToast('Standaard-template opgeslagen', 'ok'); }
      if (render) render();
    });
  };
  window.__setSofSaveExceptions = () => {
    if (!_sof.settingsChanged || _sof.busy) return;
    openConfirm(`Sales-uitzonderingen opslaan? Onder min-termijnbedrag € ${_sof.minTerm} of boven ${_sof.maxDays} dagen start vraagt de wizard om manager-goedkeuring.`, async () => {
      _sof.busy = true; if (render) render();
      // BLOCKER-1/2 fix: PUT (was POST → 405), value-shape = {amount:N} / {days:N}
      // — exact zoals admin.html:saveSalesExceptionSettings.
      const [a, b] = await Promise.all([
        tryFetch('sof-put-min', '/api/app-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sales_min_term_amount', value: { amount: Number(_sof.minTerm) || 0 } }) }),
        tryFetch('sof-put-max', '/api/app-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'sales_max_start_days', value: { days:   Number(_sof.maxDays) || 0 } }) }),
      ]);
      _sof.busy = false;
      if (a?.__error || a?.error || b?.__error || b?.error) showToast('Opslaan mislukt: ' + (a?.__error || a?.error || b?.__error || b?.error), 'warn');
      else { _sof.settingsChanged = false; showToast('Uitzonderingen opgeslagen', 'ok'); }
      if (render) render();
    });
  };
  function bodySalesOfferte() {
    if (!_sof.fetched && !_sof.loading) queueMicrotask(() => fetchSalesOfferte());
    const tplOpts = ['<option value="">— Geen standaard —</option>']
      .concat(_sof.tplList.map(t => `<option value="${esc(t.id || t.template_id || '')}" ${_sof.tplDefault === (t.id || t.template_id) ? 'selected' : ''}>${esc(t.name || t.title || t.id)}</option>`))
      .join('');
    return `<div style="max-width:900px">
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Standaard offerte-mail-template</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Nieuwe offertes gebruiken deze TL-template.</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <select ${_sof.loading ? 'disabled' : ''} onchange="window.__setSofTplChange(this.value)" style="min-width:280px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">${tplOpts}</select>
            <button class="btn btn-primary btn-sm" ${!_sof.tplChanged || _sof.busy ? 'disabled' : ''} onclick="window.__setSofSaveTpl()">Opslaan</button>
          </div>
        </div>
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Offerte-uitzonderingen (manager-goedkeuring)</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:12px">Grenzen waarboven de wizard om goedkeuring vraagt. Onder de drempel: geen popup, offerte gaat door.</div>
          <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;max-width:640px">
            <label style="font-size:11.5px;color:var(--text-2)">Min termijnbedrag (€/mnd)
              <input type="number" min="0" step="1" value="${esc(_sof.minTerm)}" oninput="window.__setSofMinChange(this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <label style="font-size:11.5px;color:var(--text-2)">Max dagen tot startdatum
              <input type="number" min="1" step="1" value="${esc(_sof.maxDays)}" oninput="window.__setSofMaxChange(this.value)" style="display:block;margin-top:4px;padding:6px 10px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);width:100%;box-sizing:border-box" />
            </label>
            <button class="btn btn-primary btn-sm" ${!_sof.settingsChanged || _sof.busy ? 'disabled' : ''} onclick="window.__setSofSaveExceptions()">Opslaan</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* Wave-1 · fin-teamleader — TL-integratie: status + oauth + disconnect +
     webhook + deep-link naar TL-import. Custom confirm bij disconnect. */
  const _tl = { loading: false, error: null, fetched: false, connection: null, webhooks: null, busy: false };
  async function fetchTeamleader() {
    if (_tl.loading || _tl.fetched) return;
    _tl.loading = true; _tl.error = null; if (render) render();
    const [conn, wh] = await Promise.all([
      tryFetch('tl-conn',   '/api/teamleader-test-connection'),
      tryFetch('tl-hook',   '/api/teamleader-webhook-register'),
    ]);
    _tl.loading = false; _tl.fetched = true;
    _tl.connection = conn && !conn.__error ? conn : { error: conn?.__error || 'onbekend' };
    _tl.webhooks   = wh && !wh.__error ? wh : { error: wh?.__error || 'onbekend' };
    if (render) render();
  }
  window.__setTlConnect = async () => {
    const j = await tryFetch('tl-oauth', '/api/teamleader-oauth-init');
    if (j?.__error || j?.error) { showToast('Init faalde: ' + (j.__error || j.error), 'warn'); return; }
    // OAuth-flow: redirect naar TL-authorize URL.
    if (j?.authorize_url) { try { window.location.href = j.authorize_url; } catch (_) {} }
    else showToast('Geen authorize_url ontvangen', 'warn');
  };
  window.__setTlDisconnect = () => {
    openConfirm('Teamleader-koppeling verbreken? OAuth-tokens worden verwijderd. Bestaande sync-jobs stoppen. Je moet opnieuw connecten om TL-syncs te hervatten.', async () => {
      _tl.busy = true; if (render) render();
      const j = await tryFetch('tl-disconnect', '/api/teamleader-disconnect', { method: 'DELETE' });
      _tl.busy = false;
      if (j?.__error || j?.error) { showToast('Disconnect mislukt: ' + (j.__error || j.error), 'warn'); }
      else { showToast('TL-koppeling verbroken', 'ok'); _tl.fetched = false; fetchTeamleader(); }
    }, 'warn');
  };
  window.__setTlWebhookRegister = () => {
    openConfirm('Webhooks (her)registreren bij TL? Endpoint publiceert onze webhook-URL voor deal.won + deal.moved events.', async () => {
      _tl.busy = true; if (render) render();
      const j = await tryFetch('tl-webhook-reg', '/api/teamleader-webhook-register', { method: 'POST' });
      _tl.busy = false;
      if (j?.__error || j?.error) { showToast('Webhook-register mislukt: ' + (j.__error || j.error), 'warn'); }
      else { showToast('Webhooks geregistreerd', 'ok'); _tl.fetched = false; fetchTeamleader(); }
    }, 'warn');
  };
  function bodyTeamleader() {
    if (!_tl.fetched && !_tl.loading) queueMicrotask(() => fetchTeamleader());
    const c = _tl.connection || {};
    const connected = !!(c && (c.ok || c.connected || c.user));
    const w = _tl.webhooks || {};
    return `<div style="max-width:900px">
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-size:13px;font-weight:600">Teamleader Focus — verbinding</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${_tl.loading ? 'Laden…' : (connected ? '✓ Verbonden' + (c.user?.email ? ' als ' + esc(c.user.email) : '') : (c.error ? '⚠ ' + esc(c.error) : '⨯ Niet verbonden'))}</div>
          </div>
          <div style="display:flex;gap:8px">
            ${connected
              ? `<button class="btn btn-ghost btn-sm" ${_tl.busy ? 'disabled' : ''} onclick="window.__setTlDisconnect()" style="color:var(--rose)">Disconnect</button>`
              : `<button class="btn btn-primary btn-sm" ${_tl.busy ? 'disabled' : ''} onclick="window.__setTlConnect()">Verbind met Teamleader</button>`}
          </div>
        </div>
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Webhooks — deal.won + deal.moved</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">${w.error ? '⚠ ' + esc(w.error) : (w.registered ? '✓ Geregistreerd' : 'Nog niet geregistreerd')}</div>
          <button class="btn btn-primary btn-sm" ${_tl.busy || !connected ? 'disabled' : ''} onclick="window.__setTlWebhookRegister()">(Her)registreer webhooks</button>
        </div>
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Teamleader Import</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Importeer actieve abonnementen + klanten uit TL naar dit systeem (alleen super_admin · met dry-run).</div>
          <a class="btn btn-primary btn-sm" href="/modules/admin-tl-import.html">Open import-tool</a>
        </div>
      </div>
    </div>`;
  }

  function bodyGebruikers() {
    if (!_users.fetched && !_users.loading) queueMicrotask(() => fetchUsers());
    if (_users.loading && !_users.items.length) return `<div style="padding:24px;color:var(--text-3);font-size:13px">Laden…</div>`;
    if (_users.error) return `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:13px">⚠ ${esc(_users.error)}</div>`;
    const isSA = isSuperAdmin();
    const rowsHtml = _users.items.map((u) => {
      const busy = !!_users.busy[u.id];
      const rolOpts = VALID_ROLES.map(r => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('');
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:8px 10px;font-size:12.5px">${esc(u.full_name || '—')}</td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(u.email)}</td>
        <td style="padding:8px 10px">
          <select ${busy ? 'disabled' : ''} onchange="window.__setUsersChangeRole('${u.id}', this.value)" style="padding:4px 6px;font-size:12px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--text)">
            ${rolOpts}
          </select>
        </td>
        <td style="padding:8px 10px;font-size:12px">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setUsersToggleActive('${u.id}')" style="font-size:11.5px">
            ${u.is_active ? '✓ actief' : '⨯ inactief'}
          </button>
        </td>
        <td style="padding:8px 10px;text-align:right">
          ${isSA && u.id ? `<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setUsersImpersonate('${u.id}')" style="font-size:11px" title="Ingelogd worden als deze user (super_admin only)">Impersonate</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    return `<div style="max-width:1000px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:12.5px;color:var(--text-3)">${_users.items.length} gebruiker(s)</div>
        <button class="btn btn-ghost btn-sm" onclick="(function(){window.__setUsersRefresh && window.__setUsersRefresh()})()">↻ Ververs</button>
      </div>
      <div style="overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--border);background:var(--surface-2)">
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em">Naam</th>
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em">E-mail</th>
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em">Rol</th>
            <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em">Status</th>
            <th style="text-align:right;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-3);letter-spacing:.04em">Acties</th>
          </tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </div>`;
  }
  window.__setUsersRefresh = () => { _users.fetched = false; fetchUsers(true); };

  function setBody(cur) {
    if (cur.id === 'com-wa')             return bodyWhatsApp();
    if (cur.id === 'com-handtekening')   return bodyEmailHandtekeningen();
    if (cur.id === 'com-sjabloon')       return bodyEmailSjablonen();
    if (cur.id === 'team-rechten')       return bodyRechten();
    if (cur.id === 'team-gebruikers')    return bodyGebruikers();
    if (cur.id === 'alg-weergave')       return bodyWeergave();
    if (cur.id === 'fin-teamleader')     return bodyTeamleader();
    if (cur.id === 'sales-offerte')      return bodySalesOfferte();
    if (cur.id === 'team-mentoren')      return bodyMentoren();
    if (cur.id === 'mk-webflow')         return bodyWebflow();
    if (cur.id === 'sys-bubble-schema')  return bodyBubbleProbe();
    if (cur.id === 'fin-entiteiten')     return bodyEntiteiten();
    // Wave-3 · gevoelige secties
    if (cur.id === 'team-api')           return bodyApiKeys();
    if (cur.id === 'com-mail')           return bodyMailboxen();
    if (cur.id === 'com-tel')            return bodyTelefonie();
    if (cur.id === 'alg-bedrijf')        return bodyBedrijf();
    if (cur.id === 'fin-bank')           return bodyFinBank();
    if (cur.id === 'fin-facturatie')     return bodyFinFacturatie();
    // Wave-2 · DEEL B — deep-links (config leeft nu in bestaande modules; volledige
    // port vereist eigen brok per sectie omdat de bron-modules eigen state/UI hebben).
    if (cur.id === 'agents-lisa')        return bodyAgentsLisa();
    if (cur.id === 'agents-manager')     return bodyAgentsManager();
    if (cur.id === 'agents-kennis')      return bodyKbArtikelen();
    if (cur.id === 'sales-trajecten')    return bodyTrajecten();
    if (cur.id === 'sales-producten')    return bodySalesProducten();
    if (cur.id === 'sales-bonus')        return bodySalesBonus();
    if (cur.id === 'ev-auto')            return bodyEvAuto();
    if (cur.id === 'ev-templates')       return bodyDeepLink('Events', 'Event-berichten (e-mail + WhatsApp) worden per template beheerd in de Events-module + com-wa hier voor WA-templates.', 'events');
    // v=74 opruim-ronde: ev-locaties verwijderd (locaties zijn vrije-tekst
    // per event, geen registry-tabel; wordt in Events beheerd).
    if (cur.id === 'lms-instel')         return bodyDeepLink(null, 'LMS-instellingen (modules/toegang/certificaten) staan in Bubble; het CRM leest via bubble-api. Zie sys-bubble-schema voor diagnostiek.', null);
    if (cur.id === 'mk-meta')            return bodyMkMeta();
    if (cur.id === 'mk-bronnen')         return bodyLeadBronnen();
    if (cur.id === 'mk-sequenties')      return bodyMkSequenties();
    if (cur.id === 'alg-meldingen')      return bodyDeepLink(null, 'Notification-preferences (dagelijkse/wekelijkse admin-mails) zijn server-side geconfigureerd via cron + rol-lookup. Voor per-user meldingen: aparte brok om notification_preferences-tabel + UI toe te voegen.', null);
    // (alg-bedrijf verplaatst naar Wave-3 bovenaan setBody; bodyBedrijf placeholder blijft ongebruikt)
    if (cur.id === 'wb-venster')         return bodyVenster();
    // Ronde-31 STAP 2: wb-joost — persona WIRE + mandaat READ-ONLY.
    if (cur.id === 'wb-joost')           return bodyWbJoost();
    // Ronde-31 STAP 3: wb-incasso — bureaus CRUD + auto-settings.
    if (cur.id === 'wb-incasso')         return bodyWbIncasso();
    // Ronde-31 STAP 5: wb-workflows + wb-berichten — DEEP-LINK naar Finance.
    // Editor blijft daar (motor leest deze rijen direct; dubbele UI = risico op
    // afwijkende validatie; templates zijn juridisch dwingend WIK-14).
    if (cur.id === 'wb-workflows')       return bodyWbWorkflows();
    if (cur.id === 'wb-berichten')       return bodyWbBerichten();
    if (cur.id === 'sys-followup-admin') return bodySysFollowupAdmin();
    return bodyPlaceholder(cur);
  }

  function instView() {
    // v=3: nav-level rol-filter. Items met een `roles`-veld worden alleen
    // getoond als de huidige rol voorkomt. Groepen zonder overgebleven items
    // worden verborgen. Als de huidige S.setPage niet meer zichtbaar is (bv.
    // door role-switch via "Bekijk als"), fallback naar de eerste zichtbare.
    const currentRole = (window.DFO?.S?.role || window.KV_V2?.role || '') || '';
    const isVisible = (it) => !Array.isArray(it.roles) || it.roles.includes(currentRole);
    const setsVisible = SETS
      .map((g) => ({ g: g.g, items: g.items.filter(isVisible) }))
      .filter((g) => g.items.length > 0);
    const flat = setsVisible.flatMap((g) => g.items);
    if (!S.setPage || !flat.some((i) => i.id === S.setPage)) {
      S.setPage = flat[0]?.id || 'sales-trajecten';
    }
    const cur = flat.find((i) => i.id === S.setPage) || flat[0];
    // BLOCKER-4 fix: banner alleen op placeholder-secties. Wired secties (Wave-1)
    // hebben echte data en verdienen géén "voorbeeld"-badge; wél een subtiel
    // live-label. Systeem-tools (super_admin-only) ook echt-live.
    // Ronde-26: 3 badge-varianten (was: LIVE + DEEPLINK). READ-ONLY is nieuw
    // voor secties die data tonen maar niet schrijven (schrijven gebeurt in
    // env-vars / andere modules / aparte brokken).
    const LIVE = new Set([
      'team-gebruikers','team-rechten','alg-weergave','fin-teamleader','sales-offerte','team-mentoren',
      'com-handtekening','com-sjabloon','sys-followup-admin',
      'com-wa','mk-webflow','fin-entiteiten',
      // Ronde-31 STAP 2: wb-joost persona schrijfbaar (mandaat blijft read-only in body).
      'wb-joost',
      // Ronde-31 STAP 3: wb-incasso bureaus + auto-settings live.
      'wb-incasso',
      // Ronde-31 STAP 4: wb-venster cooldown schrijfbaar (office-hours read-only in body).
      'wb-venster',
      // Ronde-31 grote-brok agents-lisa native — persona/fases/KB/follow-up + draft/publish/rollback.
      'agents-lisa',
      // Ronde-31 grote-brok sales-trajecten native — variant CRUD (naam/duur/koppelingen; geen TL-sync).
      'sales-trajecten',
      // Ronde-31 grote-brok ev-auto native — flow-lijst + metadata-edit + enable-toggle + delete;
      // stappen-editor + test-run blijven deep-link (te complex/risicovol voor deze ronde).
      'ev-auto',
      // Ronde-31 grote-brok agents-kennis native — KB-artikelen CRUD + promote-to-agent.
      'agents-kennis',
      // Ronde-31 grote-brok mk-sequenties native — trajecten-lijst + metadata-edit + actief-toggle + delete; stap-editor + test-send blijven Leadsonderhoud.
      'mk-sequenties',
      // Ronde-31 grote-brok sales-producten native — CRUD op products (naam/categorie/prijs/BTW/duur/tl_product_id/actief); geen TL-sync.
      'sales-producten',
      // Ronde-31 v=56: sales-bonus native — bonus-config CRUD (percentage + threshold per verkoper).
      'sales-bonus',
      // v=67: wb-berichten native — dunning_templates CRUD (email/whatsapp/brief)
      // + client-side WIK-gate voor brief-kind. Motor-endpoints onaangeraakt.
      'wb-berichten',
      // v=69: wb-workflows native — dunning_workflows + _steps CRUD (diff-based
      // upsert met step.id-behoud; client-guards spiegelen server-guards).
      // Motor-/dispatcher-/cron-logica onaangeraakt.
      'wb-workflows',
    ]);
    const READONLY = new Set([
      'alg-bedrijf','fin-facturatie','fin-bank','team-api','com-mail','com-tel','sys-bubble-schema',
      // v=75: mk-meta native READ-ONLY (WABA-status).
      'mk-meta',
      // Ronde-28 C1: mk-bronnen read-native (mapping-editor blijft brok).
      'mk-bronnen',
      // Ronde-31 v=54: agents-manager READ-ONLY — geen config-tabel in DB; alle
      // gedrag is code-side (hardcoded constants + on-the-fly schema-prompt).
      'agents-manager',
      // v=74: ev-locaties sectie VERWIJDERD — vrije-tekst per event, in Events beheerd.
      // Ronde-31 v=56: sales-bonus LIVE — sales_bonus_configs CRUD via nieuwe endpoint.
      'sales-bonus',
    ]);
    // Ronde-28: fin-entiteiten upgraded READ-ONLY → LIVE (CRUD wired).
    if (READONLY.has('fin-entiteiten')) READONLY.delete('fin-entiteiten');
    // Backward-compat: WIRED bevat beide zodat andere logic werkt.
    const WIRED = new Set([...LIVE, ...READONLY]);
    const DEEPLINK = new Set([
      'ev-templates','lms-instel',
      // v=75: mk-meta is nu NATIVE READ-ONLY (WABA-status via admin-whatsapp-modules-list).
      // v=67: wb-berichten LIVE native (dunning-templates CRUD).
      // v=69: wb-workflows LIVE native (dunning-workflows CRUD met diff-based upsert).
      // Polish v26: alg-meldingen krijgt DEEP-LINK badge (was voorbeeld-data);
      // notice-only sectie (server-side crons + rol-lookup, aparte brok voor per-user-prefs).
    ]);
    // Notice-only secties (geen deep-link naar module, wél uitleg met bron).
    const NOTICE = new Set(['alg-meldingen']);
    const bannerHtml = LIVE.has(cur.id)
      ? `<div style="padding:6px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">● LIVE DATA — instellingen op deze pagina zijn echt en worden direct opgeslagen</div>`
      : READONLY.has(cur.id)
        ? `<div style="padding:6px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">● READ-ONLY — toont data, schrijven gebeurt elders</div>`
      : DEEPLINK.has(cur.id)
        ? `<div style="padding:6px 12px;background:var(--blue-soft, var(--surface-2));color:var(--blue, var(--text-2));border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">◇ DEEP-LINK — instelling leeft in een andere module (uitleg hieronder)</div>`
      : NOTICE.has(cur.id)
        ? `<div style="padding:6px 12px;background:var(--blue-soft, var(--surface-2));color:var(--blue, var(--text-2));border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">◇ NOTICE — informatie over waar deze instelling nu leeft (nog geen editor)</div>`
        : H.voorbeeldBanner();
    return `${bannerHtml}
      <div class="set-split">
        <div class="set-nav">
          ${setsVisible.map(g => `
            <div class="set-group">${g.g}</div>
            ${g.items.map(i => `<button class="set-item ${S.setPage === i.id ? 'is-on' : ''}" data-set-pick="${i.id}" onclick="__setPick('${i.id}')">
              ${svg(i.ic)}<span>${i.n}</span>
            </button>`).join('')}
          `).join('')}
        </div>
        <div class="set-body">
          <div class="set-head">
            <div class="set-h1">${cur.n}</div>
            <div class="set-p">${cur.d}</div>
          </div>
          <div class="set-content">${setBody(cur)}</div>
        </div>
      </div>
      ${_renderConfirmModal()}`;
  }

  window.DFO.VIEWS['instellingen/'] = instView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('instellingen');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('instellingen');
  console.debug('[instellingen-v2] v=6 — infinite fetch-loop fix (guard op _fetched i.p.v. !items.length voor zowel _sig als _tpl). Lege lijst is nu legitieme uitkomst. Rest ongewijzigd t.o.v. v=5.');
})();
