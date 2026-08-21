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
      { id: 'sales-bonus',      n: 'Verkopers en bonus',  d: 'Wie verkoopt wat, en hoe de bonus wordt berekend',          ic: I.users },
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
      { id: 'ev-locaties',      n: 'Locaties',             d: 'Zalen, adressen en routebeschrijvingen',                    ic: I.building || I.file },
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
  window.__setPick = (id) => {
    if (!S) return;
    S.setPage = id;
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  };

  function highlightVars(t) {
    return String(t || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\{\{([^}]+)\}\}/g, '<span class="wa-var">{{$1}}</span>')
      .replace(/\n/g, '<br>');
  }

  // ── Set-body per id ────────────────────────────────────────────────────
  /* Wave-2 · DEEL B — deep-link body voor niet-geporte config-secties.
     Reden per sectie is beknopt uitgelegd zodat de gebruiker snapt WAAROM
     de instelling nu in een andere module leeft. Bij `modKey` opgegeven:
     directe navigatie-knop via DFO.goMod. */
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
     Read-only super_admin diagnostiek. */
  const _bs = { busy: false, result: null, error: null, type: null };
  window.__setBsProbe = async (objtype) => {
    if (_bs.busy) return;
    _bs.busy = true; _bs.result = null; _bs.error = null; _bs.type = objtype; if (render) render();
    const j = await tryFetch('bubble-probe', '/api/bubble-schema-probe?objtype=' + encodeURIComponent(objtype));
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
        <button class="btn btn-primary btn-sm" ${_bs.busy ? 'disabled' : ''} onclick="window.__setBsProbe('user')">${_bs.busy && _bs.type === 'user' ? 'Bezig…' : '👤 User-velden'}</button>
        <button class="btn btn-primary btn-sm" ${_bs.busy ? 'disabled' : ''} onclick="window.__setBsProbe('session')">${_bs.busy && _bs.type === 'session' ? 'Bezig…' : '⏱ Session-velden'}</button>
      </div>
      ${out}
    </div>`;
  }

  /* Wave-2 · fin-entiteiten — read-only lijst van company_entities via
     direct-supabase (zelfde pattern als team-rechten). CRUD blijft in Supabase-
     console (te complex om nu te bouwen; low-frequency actie: entiteiten worden
     nauwelijks toegevoegd). Custom confirm bij delete = deep-link only. */
  const _ent = { loading: false, fetched: false, error: null, items: [] };
  async function fetchEntiteiten() {
    if (_ent.loading || _ent.fetched) return;
    _ent.loading = true; _ent.error = null; if (render) render();
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const { data, error } = await window.supabase.from('company_entities').select('*').order('label');
      if (error) throw error;
      _ent.items = data || [];
    } catch (e) { _ent.error = e?.message || 'onbekend'; }
    _ent.loading = false; _ent.fetched = true;
    if (render) render();
  }
  function bodyEntiteiten() {
    if (!_ent.fetched && !_ent.loading) queueMicrotask(() => fetchEntiteiten());
    const rows = _ent.items.map(e => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:12.5px;font-weight:600">${esc(e.label || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(e.tl_department_id || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${esc(e.country || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${e.is_active ? '✓ actief' : '⨯ inactief'}</td>
    </tr>`).join('');
    return `<div style="max-width:1000px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:14px">
        <b>CRUD volgt:</b> read-only lijst nu. Aanmaken/bewerken/verwijderen van entiteiten (raakt facturatie + MRR-scoping) vraagt eigen brok. Nieuwe entiteit nodig? Vraag Amigo.
      </div>
      ${_ent.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_ent.error)}</div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Label</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">TL Department ID</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Land</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="4" style="padding:16px;color:var(--text-3);font-size:12.5px">${_ent.loading ? 'Laden…' : 'Geen entiteiten gevonden'}</td></tr>`}</tbody>
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
    const configured = !!d.configured;
    const cids = Array.isArray(d.caller_ids) ? d.caller_ids : [];
    return `<div style="max-width:800px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Display-only.</b> Voys-tokens (VOYS_API_TOKEN + VOYS_CLIENT_UUID + VOYS_A_NUMBER) leven in Vercel env-vars.
        Caller-ID lijst = <code>VOYS_CALLER_IDS</code>. Roteren = handmatig in Vercel.
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:14px 16px">
          <div style="font-size:13px;font-weight:600;margin-bottom:4px">Voys-koppeling</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">${_tel.error ? '⚠ ' + esc(_tel.error) : (configured ? '✓ Geconfigureerd' : '⨯ Nog niet geconfigureerd')}</div>
          ${cids.length ? `<div style="font-size:12px;color:var(--text-2)"><b>Caller-IDs:</b> ${cids.map(x => `<code style="background:var(--surface-2);padding:1px 5px;border-radius:3px;margin:0 2px">${esc(x)}</code>`).join(' ')}</div>` : ''}
        </div>
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
  const _bnk = { loading: false, fetched: false, error: null, items: [] };
  async function fetchBank() {
    if (_bnk.loading || _bnk.fetched) return;
    _bnk.loading = true; _bnk.error = null; if (render) render();
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      // BLOCKER-2 fix: tabel heeft `iban, is_active, gocardless_account_id`
      // (geen label/currency-kolommen). Bevestigd via api/_lib/bank-balance.js:145.
      const { data, error } = await window.supabase.from('bank_accounts').select('id, iban, is_active, gocardless_account_id, balance_fetched_at').order('iban');
      if (error) throw error;
      _bnk.items = data || [];
    } catch (e) { _bnk.error = e?.message || 'onbekend'; }
    _bnk.loading = false; _bnk.fetched = true;
    if (render) render();
  }
  function bodyFinBank() {
    if (!_bnk.fetched && !_bnk.loading) queueMicrotask(() => fetchBank());
    const rows = _bnk.items.map(a => `<tr style="border-top:1px solid var(--border)">
      <td style="padding:8px 12px;font-size:12.5px;font-family:'IBM Plex Mono',monospace">${esc(a.iban || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(a.gocardless_account_id || '—')}</td>
      <td style="padding:8px 12px;font-size:11.5px;color:var(--text-3)">${a.balance_fetched_at ? esc(String(a.balance_fetched_at).slice(0,10)) : '—'}</td>
      <td style="padding:8px 12px;font-size:11.5px">${a.is_active ? '✓ actief' : '⨯ inactief'}</td>
    </tr>`).join('');
    return `<div style="max-width:1000px">
      <div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;line-height:1.55;margin-bottom:14px">
        <b>Read-only.</b> Deze tabel toont de <code>bank_accounts</code>-registratie. Bij lege tabel is het dashboard-saldo NOG steeds correct — <code>finance-bank-camt-balance.js</code> sommeert alle valid-IBAN accounts uit de CAMT-data (F2-postmortem-fix), niet uit deze tabel. In een latere fin-bank CRUD-brok kan deze sectie beter de CAMT-accounts tonen die daadwerkelijk saldo hebben.
      </div>
      ${_bnk.error ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px;margin-bottom:12px">⚠ ${esc(_bnk.error)}</div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--surface-2)">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">IBAN</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">GoCardless account-id</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Saldo-fetch</th>
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Status</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="4" style="padding:16px;color:var(--text-3);font-size:12.5px">${_bnk.loading ? 'Laden…' : 'Geen bank-accounts geregistreerd (verwacht — saldo komt uit CAMT-data).'}</td></tr>`}</tbody>
        </table>
      </div>
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
  window.__setWaRegPnid = (v) => { _waReg.pnid = String(v || ''); if (render) render(); };
  window.__setWaRegPin  = (v) => { _waReg.pin  = String(v || ''); if (render) render(); };
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
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:14px;line-height:1.55">
        <b>Template-editor:</b> voor nieuwe/complexe wijzigingen: <a href="/modules/admin.html#tab-integraties" style="color:inherit;text-decoration:underline">admin.html</a>. Deze pagina toont live-status + Submit/Delete/Sync + WA-nummer-registratie.
      </div>
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px;margin-bottom:14px">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">Meta-templates</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${rows.length} template(s) ${_wa.error ? '· ⚠ ' + esc(_wa.error) : ''}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            ${moduleSel}
            <a class="btn btn-primary btn-sm" href="/modules/admin.html#tab-integraties${_wa.moduleId ? '&waba=' + encodeURIComponent(_wa.moduleId) : ''}" style="text-decoration:none">➕ Nieuwe template</a>
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
  const _rbac = { loading: false, error: null, fetched: false, byRole: {}, busy: false };
  async function fetchRbacSummary() {
    if (_rbac.loading || _rbac.fetched) return;
    _rbac.loading = true; _rbac.error = null; if (render) render();
    // BLOCKER-3 fix: /api/permissions bestaat niet op deze deploy. Admin leest
    // via direct-supabase op public.role_permissions. Zelfde pad hier via
    // window.supabase (shared client is al geladen door supabase-client.js).
    // Fail-soft: bij RLS-403 tonen we een nette fallback + deep-link.
    try {
      if (!window.supabase?.from) throw new Error('supabase-client nog niet klaar');
      const byRole = {};
      let from = 0; const PAGE = 1000;
      while (true) {
        const { data, error } = await window.supabase
          .from('role_permissions')
          .select('role, allowed')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        const rows = data || [];
        for (const r of rows) {
          if (!r || !r.role) continue;
          if (!byRole[r.role]) byRole[r.role] = 0;
          if (r.allowed === true) byRole[r.role] += 1;
        }
        if (rows.length < PAGE) break;
        from += PAGE;
      }
      _rbac.byRole = byRole;
    } catch (e) {
      _rbac.error = e?.message || 'onbekende fout';
    }
    _rbac.loading = false; _rbac.fetched = true;
    if (render) render();
  }
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
    const rolesSum = Object.entries(_rbac.byRole).sort((a,b) => b[1] - a[1]);
    const summary = _rbac.loading && !rolesSum.length
      ? `<div style="color:var(--text-3);font-size:13px">Samenvatting laden…</div>`
      : _rbac.error
        ? `<div style="padding:12px 14px;background:var(--rose-soft);color:var(--rose);border-radius:8px;font-size:12.5px">⚠ ${esc(_rbac.error)}</div>`
        : rolesSum.length
          ? `<table style="width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
              <thead><tr style="background:var(--surface-2)"><th style="text-align:left;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Rol</th><th style="text-align:right;padding:8px 12px;font-size:11px;color:var(--text-3);font-weight:600">Actieve permissions</th></tr></thead>
              <tbody>${rolesSum.map(([r,c]) => {
                // Polish C: super_admin heeft altijd bypass ('*'); toon dat i.p.v. het letterlijke row-getal.
                const display = r === 'super_admin' ? '<span style="color:var(--emerald);font-weight:600">volledige toegang (bypass)</span>' : String(c);
                return `<tr style="border-top:1px solid var(--border)"><td style="padding:8px 12px;font-size:12.5px">${esc(r)}</td><td style="padding:8px 12px;font-size:12.5px;text-align:right;font-family:'IBM Plex Mono',monospace">${display}</td></tr>`;
              }).join('')}</tbody>
            </table>`
          : `<div style="color:var(--text-3);font-size:12.5px">Geen permissions-data ontvangen. Endpoint retourneerde geen items/matrix.</div>`;
    return `<div style="max-width:900px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:14px;line-height:1.55">
        <b>Matrix-editor:</b> de vinkjes-editor (per functie per rol) staat nog in <a href="/modules/admin.html" style="color:inherit;text-decoration:underline">admin.html · tab Rechten</a>. Volledige port naar deze pagina volgt in een aparte migratie-brok (afhankelijk van FEATURE_REGISTRY + direct-Supabase → API-refactor).
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">Live-samenvatting per rol</div>
      ${summary}
      <div class="card" style="margin-top:16px;background:var(--surface);border:1px solid var(--rose-line, #f5b4bc);border-radius:10px">
        <div style="padding:12px 16px;background:var(--rose-soft);border-bottom:1px solid var(--rose-line, #f5b4bc)">
          <div style="font-size:13px;font-weight:600;color:var(--rose)">⚠ Role-sync backfill</div>
          <div style="font-size:11.5px;color:var(--rose);margin-top:2px">Zet profiles.role = hoogste rol uit user_roles voor elke gebruiker. Alleen als user_roles bron-van-waarheid is.</div>
        </div>
        <div style="padding:12px 16px">
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

  function bodyVenster() {
    return `
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Verzendvenster</div><div class="set-field-d">Buiten deze tijden gaan er geen aanmaningen uit. De motor draait wel door.</div></div>
        <div class="set-field-c set-field-row"><input class="ib-input" value="08:00" style="max-width:110px"><span class="set-sep">tot</span><input class="ib-input" value="20:00" style="max-width:110px"></div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Dagen</div><div class="set-field-d">Op welke dagen mag er verstuurd worden</div></div>
        <div class="set-field-c set-field-row" style="flex-wrap:wrap">
          ${['ma','di','wo','do','vr','za','zo'].map(d => `<button class="chip is-on">${d}</button>`).join('')}
        </div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Tijdzone</div><div class="set-field-d">Zomer- en wintertijd worden automatisch meegenomen</div></div>
        <div class="set-field-c"><select class="ib-input" style="max-width:240px"><option>Europe/Amsterdam</option></select></div>
      </div>
      <div class="set-actions"><button class="btn btn-primary" onclick="__setNotice('Verzendvenster opslaan')">Opslaan</button></div>`;
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
  const _menu = { loading: false, error: null, fetched: false, role: '', items: [], busy: false, dirty: false };
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
      ? _menu.items.map(it => {
          const locked = it.key === 'admin';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border)">
            <div style="flex:1;font-size:12.5px">${esc(it.key)}${it.group ? ` <span style="color:var(--text-3);font-size:11px">· ${esc(it.group)}</span>` : ''}${locked ? ` <span style="font-size:10px;color:var(--text-3)">(verplicht zichtbaar)</span>` : ''}</div>
            <button class="btn btn-ghost btn-sm" ${locked ? 'disabled' : ''} onclick="window.__setMenuToggle('${esc(it.key)}')" style="font-size:11.5px">${it.visible ? '✓ zichtbaar' : '⨯ verborgen'}</button>
          </div>`;
        }).join('')
      : `<div style="padding:16px;color:var(--text-3);font-size:12.5px">Nog geen items geconfigureerd voor deze rol — sidebar toont standaard-set.</div>`;
    return `<div style="max-width:900px">
      <div style="padding:12px 14px;background:var(--amber-soft);color:var(--amber);border-radius:8px;font-size:12.5px;margin-bottom:14px;line-height:1.55">
        <b>Volgorde slepen</b> (drag-drop) en <b>groep-toewijzing</b> zitten nog in <a href="/modules/admin.html#tab-menu-manager" style="color:inherit;text-decoration:underline">admin.html · Menu beheer</a>. Hier kun je items <b>tonen/verbergen</b> per rol.
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--text-2)">Rol:
          <select onchange="window.__setMenuRoleChange(this.value)" style="margin-left:6px;padding:5px 8px;font-size:12.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text)">${rolesOpts}</select>
        </label>
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
    if (cur.id === 'agents-lisa')        return bodyDeepLink('AI Agents', 'De Lisa-config (persona/fases/follow-ups) staat in de AI Agents-module. Verhuizen naar hier vereist port van de agents-config-UI + endpoints — aparte brok.', 'agents');
    if (cur.id === 'agents-manager')     return bodyDeepLink('AI Agents', 'AI Manager-instellingen (system-prompt, kennis, autonomie) staan in de AI Agents-module. Het werkende endpoint /api/super-admin-ai-manager voedt de widget op het dashboard.', 'agents');
    if (cur.id === 'agents-kennis')      return bodyDeepLink('AI Agents', 'Kennisbank voor AI (Lisa/Joost) staat verspreid over de AI Agents-module + Joost-config. Aparte brok om te centraliseren.', 'agents');
    if (cur.id === 'sales-trajecten')    return bodyDeepLink('Sales', 'Trajecten (looptijden/prijzen/termijnen) worden in de Sales-wizard beheerd. Directe editor volgt in Wave 3.', 'sales');
    if (cur.id === 'sales-producten')    return bodyDeepLink('Sales', 'Losse producten (E-books, lascursus, consultancy) staan in de Sales-catalogus/wizard. Aparte brok voor centrale editor.', 'sales');
    if (cur.id === 'sales-bonus')        return bodyDeepLink('Sales', 'Verkopers en bonus-config zit in de Sales-module + team_members-tabel. Bonus-berekening is server-side; UI-editor volgt in Wave 3.', 'sales');
    if (cur.id === 'ev-auto')            return bodyDeepLink('Automatiseringen', 'Event-automatiseringen worden in de Automatiseringen-module bewerkt (per-trigger flows). Directe centralisatie vereist port van die UI.', 'automatiseringen');
    if (cur.id === 'ev-templates')       return bodyDeepLink('Events', 'Event-berichten (e-mail + WhatsApp) worden per template beheerd in de Events-module + com-wa hier voor WA-templates.', 'events');
    if (cur.id === 'ev-locaties')        return bodyDeepLink('Events', 'Locaties (zalen/adressen/routes) staan in de events-config; centrale editor volgt.', 'events');
    if (cur.id === 'lms-instel')         return bodyDeepLink(null, 'LMS-instellingen (modules/toegang/certificaten) staan in Bubble; het CRM leest via bubble-api. Zie sys-bubble-schema voor diagnostiek.', null);
    if (cur.id === 'mk-meta')            return bodyDeepLink(null, 'Meta-koppeling (ads-account + pixel) wordt beheerd in Meta Business Manager. Alleen de WhatsApp-Cloud-API-koppeling wordt hier bewerkt (zie com-wa).', 'com-wa');
    if (cur.id === 'mk-bronnen')         return bodyDeepLink('Leads', 'Lead-bronnen (leads.bron / leads.traject-mapping) worden in de Leads-module gezet; dashboard-tegels lezen /api/leads-per-traject-count. Centrale editor vraagt eigen brok.', 'leads');
    if (cur.id === 'mk-sequenties')      return bodyDeepLink('Leadsonderhoud', 'Sequenties (automatische lead-opvolging) worden in de Leadsonderhoud-module beheerd. Aparte brok voor centralisatie.', 'leadsonderhoud');
    if (cur.id === 'alg-meldingen')      return bodyDeepLink(null, 'Notification-preferences (dagelijkse/wekelijkse admin-mails) zijn server-side geconfigureerd via cron + rol-lookup. Voor per-user meldingen: aparte brok om notification_preferences-tabel + UI toe te voegen.', null);
    // (alg-bedrijf verplaatst naar Wave-3 bovenaan setBody; bodyBedrijf placeholder blijft ongebruikt)
    if (cur.id === 'wb-venster')         return bodyVenster();
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
    ]);
    const READONLY = new Set([
      'alg-bedrijf','fin-facturatie','fin-bank','team-api','com-mail','com-tel','sys-bubble-schema',
    ]);
    // Backward-compat: WIRED bevat beide zodat andere logic werkt.
    const WIRED = new Set([...LIVE, ...READONLY]);
    const DEEPLINK = new Set([
      'agents-lisa','agents-manager','agents-kennis',
      'sales-trajecten','sales-producten','sales-bonus',
      'ev-auto','ev-templates','ev-locaties','lms-instel',
      'mk-meta','mk-bronnen','mk-sequenties',
      'alg-meldingen',
    ]);
    const bannerHtml = LIVE.has(cur.id)
      ? `<div style="padding:6px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">● LIVE DATA — instellingen op deze pagina zijn echt en worden direct opgeslagen</div>`
      : READONLY.has(cur.id)
        ? `<div style="padding:6px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">● READ-ONLY — toont data, schrijven gebeurt elders</div>`
      : DEEPLINK.has(cur.id)
        ? `<div style="padding:6px 12px;background:var(--blue-soft, var(--surface-2));color:var(--blue, var(--text-2));border-radius:6px;font-size:11px;font-weight:600;letter-spacing:.04em;margin-bottom:14px;display:inline-flex;align-items:center;gap:6px">◇ DEEP-LINK — instelling leeft in een andere module (uitleg hieronder)</div>`
        : H.voorbeeldBanner();
    return `${bannerHtml}
      <div class="set-split">
        <div class="set-nav">
          ${setsVisible.map(g => `
            <div class="set-group">${g.g}</div>
            ${g.items.map(i => `<button class="set-item ${S.setPage === i.id ? 'is-on' : ''}" onclick="__setPick('${i.id}')">
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
