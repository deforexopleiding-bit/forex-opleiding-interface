// modules/klanten-v2/views/leads-v2.js
//
// Data-ronde 2 — Leads v2. Live-lijst + v2 detail-view + naam-styling-fix.
// "Nieuwe lead" blijft naar oude /modules/leads.html?new=1 routeren (de
// v1-create-flow vereist producten-picker + LMS-provisioning, te complex
// voor deze ronde — expliciet gemeld in PR-body).
//
// Endpoints:
//   GET  /api/leads-list?status&bron&q&archief&limit&offset  (lijst)
//   GET  /api/leads-stats                                     (KPI's)
//   GET  /api/leads-detail?id=<uuid>                          (detail)
//   POST /api/leads-update  {id, status?, notitie?, eigenaar_id?} (patch)
//
// URL-state:
//   ?lead=<uuid>  → open v2-detail
//   ?lead-new=1   → redirect naar oude leads.html?new=1 (v2-modal niet
//                   gebouwd; complex-endpoint met producten-eis)

(function () {
  if (!window.DFO) { console.error('[leads-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[leads-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  // Ronde 4: sortBy + sortDir op _act voor sort-chips.
  // _cre.form.productSlugs = array voor multi-select (mini-cursus + 7-daagse
  // combineerbaar; endpoint accepteert producten: [{slug,van,tot}] array).
  // Ronde 7b: dropdown-filterbalk (v1 parity) — 6 filters + traject-list lazy.
  const _act = { loading: false, error: null, data: null, stats: null, seq: 0, params: '', search: '', sortBy: 'aangemaakt', sortDir: 'desc' };
  const _traj = { loading: false, list: null };
  const _arc = { loading: false, error: null, data: null, seq: 0, params: '', search: '' };
  const _det = { loading: false, error: null, data: null, seq: 0, id: null, saving: false, notitieDraft: '' };
  const _cre = {
    submitting: false,
    producten: null, prodLoading: false,
    form: { voornaam: '', achternaam: '', email: '', telefoon: '', productSlugs: [], van: '', tot: '', herkomst: 'handmatig', welkomstmail: false },
  };
  // Meer-acties modal state (archiveer / herstel / omzetten-klant).
  const _act2 = { open: false, kind: null, submitting: false };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[leads-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  async function tryPost(label, url, body, timeoutMs = 12000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method: 'POST', body: JSON.stringify(body) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    if (!resp.ok) { console.warn('[leads-v2] post fail:', label, '→', json?.error || resp.status); throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status); }
    return json;
  }

  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const dstrLong = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
  const num  = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);
  const esc  = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Preview-mode badge — VERWIJDERD (per user-verzoek 2026-08-11).
  // Signature behouden als lege string zodat alle call-sites in dit
  // bestand (Actief/Gearchiveerd/Lead-detail) blijven werken zonder
  // aanpassing. Error-/loading-state elders zichtbaar (per-tab
  // "Laden…" + toast).
  function previewHeader(_label, _state) { return ''; }

  const STATUS_TO_PILL = {
    nieuw:     ['info',    'Nieuw'],
    opgevolgd: ['primary', 'Opgevolgd'],
    gewonnen:  ['ok',      'Gewonnen'],
    verloren:  ['warn',    'Verloren'],
  };

  function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }
  function setUrlParam(k, v) {
    try {
      const u = new URL(location.href);
      if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
      history.pushState({}, '', u.toString());
    } catch (_) { /* noop */ }
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  }

  window.__leadNew  = () => setUrlParam('lead-new', '1');
  window.__leadNewClose = () => {
    setUrlParam('lead-new', null);
    _cre.form = { voornaam: '', achternaam: '', email: '', telefoon: '', productSlug: '', van: '', tot: '', herkomst: 'handmatig', welkomstmail: false };
  };
  window.__leadOpen = (id) => { if (id) setUrlParam('lead', id); };
  window.__leadBack = () => setUrlParam('lead', null);

  // Producten voor create-modal (lazy).
  async function fetchProducten() {
    if (_cre.producten || _cre.prodLoading) return;
    _cre.prodLoading = true;
    const data = await tryFetch('lms-producten-actief', '/api/lms-producten-actief');
    _cre.prodLoading = false;
    _cre.producten = data?.producten || [];
    // Default select eerste product + auto-vul van/tot (today → today + duur_dagen).
    if (_cre.producten.length && !_cre.form.productSlug) {
      const p = _cre.producten[0];
      _cre.form.productSlug = p.slug;
      const now = new Date();
      const iso = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
      _cre.form.van = iso(now);
      const tot = new Date(now); tot.setDate(tot.getDate() + (Number(p.duur_dagen) || 365));
      _cre.form.tot = iso(tot);
    }
    window.DFO.render();
  }

  window.__leadCreateInput = (field, val) => { _cre.form[field] = val; };
  // Ronde 4: multi-product checkboxes (mini-cursus + 7-daagse combineerbaar).
  window.__leadCreateProductToggle = (slug) => {
    const arr = Array.isArray(_cre.form.productSlugs) ? _cre.form.productSlugs.slice() : [];
    const idx = arr.indexOf(slug);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(slug);
    _cre.form.productSlugs = arr;
    // Auto-vul van/tot obv langste-duur product als leeg.
    if ((!_cre.form.van || !_cre.form.tot) && arr.length) {
      const chosen = (_cre.producten || []).filter(p => arr.includes(p.slug));
      const maxDuur = chosen.reduce((m, p) => Math.max(m, Number(p.duur_dagen) || 0), 0) || 365;
      const now = new Date();
      const iso = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
      if (!_cre.form.van) _cre.form.van = iso(now);
      if (!_cre.form.tot) { const tot = new Date(now); tot.setDate(tot.getDate() + maxDuur); _cre.form.tot = iso(tot); }
    }
    window.DFO.render();
  };
  window.__leadCreateWelkomToggle = () => { _cre.form.welkomstmail = !_cre.form.welkomstmail; window.DFO.render(); };

  window.__leadCreateSubmit = async () => {
    if (_cre.submitting) return;
    const f = _cre.form;
    if (!f.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { alert('Geldig e-mailadres vereist.'); return; }
    const slugs = Array.isArray(f.productSlugs) ? f.productSlugs : [];
    if (!slugs.length) { alert('Kies minstens één product.'); return; }
    if (!f.van || !f.tot) { alert('Begin- en einddatum vereist.'); return; }
    if (f.van > f.tot) { alert('Einddatum moet na begindatum liggen.'); return; }
    _cre.submitting = true;
    window.DFO.render();
    try {
      await tryPost('lead-handmatig-toevoegen', '/api/lead-handmatig-toevoegen', {
        voornaam: f.voornaam || null,
        achternaam: f.achternaam || null,
        email: f.email.trim().toLowerCase(),
        telefoon: f.telefoon || null,
        herkomst: f.herkomst || 'handmatig',
        producten: slugs.map(slug => ({ slug, van: f.van, tot: f.tot })),
        welkomstmail: !!f.welkomstmail,
      });
      _cre.submitting = false;
      _cre.form = { voornaam: '', achternaam: '', email: '', telefoon: '', productSlugs: [], van: '', tot: '', herkomst: 'handmatig', welkomstmail: false };
      _act.data = null; _arc.data = null;
      setUrlParam('lead-new', null);
      alert('Lead aangemaakt met ' + slugs.length + ' product' + (slugs.length === 1 ? '' : 'en') + (f.welkomstmail ? ' (welkomstmail verstuurd)' : '') + '.');
    } catch (e) {
      _cre.submitting = false;
      window.DFO.render();
      alert('Kon lead niet aanmaken: ' + (e?.message || 'onbekende fout'));
    }
  };

  // ── Ronde 4: Meer-acties in v2 (archiveer / herstel / omzetten-klant) ───
  window.__leadAct2Open = (kind) => {
    _act2.open = true; _act2.kind = kind; window.DFO.render();
  };
  window.__leadAct2Close = () => {
    _act2.open = false; _act2.kind = null; _act2.submitting = false; window.DFO.render();
  };
  window.__leadAct2Confirm = async () => {
    if (!_det.id || !_act2.kind || _act2.submitting) return;
    const kind = _act2.kind;
    // "Omzetten naar klant" opent nu de v2-wizard IN-SHELL met lead-data
    // als prefill (batch2b Feature C). sessionStorage-payload + URL-param
    // blijven behouden voor URL-share/refresh-scenario's; wizard leest via
    // readPrefill() beide bronnen. De detail-slide-over sluit zodat de
    // wizard-modal bovenop schone shell verschijnt. Fallback naar oude
    // wizard-html als sales-wizard-v2.js niet geladen is (defensive).
    if (kind === 'promote') {
      const lead = _det.data?.lead || {};
      const prefill = {
        lead_id:    lead.id,
        first_name: lead.voornaam   || '',
        last_name:  lead.achternaam || '',
        email:      lead.email      || '',
        phone:      lead.telefoon   || '',
      };
      try { sessionStorage.setItem('_prefill_lead', JSON.stringify(prefill)); } catch (_) { /* ignore quota */ }
      _act2.open = false; _act2.kind = null; _act2.submitting = false;
      window.DFO.render();
      if (typeof window.__swOpen === 'function') {
        // Wizard leest sessionStorage in readPrefill; we geven ook opts
        // mee zodat er geen twijfel is over de bron. state.wizard.
        // source_lead_id + prefillLeadId worden door readPrefill gezet.
        // Wizard opent bovenop de shell + lead-detail-panel (die blijft
        // links zichtbaar tot gebruiker klaar is met wizard).
        window.__swOpen({ prefillLead: prefill });
        return;
      }
      // Fallback naar oude wizard-html.
      const url = '/modules/sales-wizard.html?source_lead_id=' + encodeURIComponent(lead.id || '');
      window.location.href = url;
      return;
    }
    _act2.submitting = true; window.DFO.render();
    const endpoint = kind === 'archive'  ? '/api/leads-verwijder'
                   : kind === 'restore'  ? '/api/leads-herstel'
                   : null;
    if (!endpoint) { _act2.submitting = false; window.DFO.render(); return; }
    try {
      await tryPost('lead-action-' + kind, endpoint, { id: _det.id });
      _det.data = null; _act.data = null; _arc.data = null;
      _act2.open = false; _act2.kind = null; _act2.submitting = false;
      if (kind === 'archive') setUrlParam('lead', null);
      else window.DFO.render();
      alert(kind === 'archive' ? 'Lead gearchiveerd.' : 'Lead hersteld.');
    } catch (e) {
      _act2.submitting = false;
      window.DFO.render();
      alert('Actie mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  // Ronde 5: inline rij-acties (Wijzig / Verwijder) vanuit overzicht-tabel.
  // Ronde 10: Wijzig-knop opent nu direct de v2-bewerk-modal (was: openen
  // van detail-page). Detail-page blijft bereikbaar via klik op naam.
  window.__leadRowEdit = (id) => { if (id) window.__leadEditOpen(id); };
  window.__leadRowDelete = async (id, naam) => {
    if (!id) return;
    if (!confirm(`Lead "${naam || id}" archiveren?\n\nSoft-delete via verwijderd_op. Herstellen kan later in het Gearchiveerd-tabblad.`)) return;
    try {
      await tryPost('lead-row-verwijder', '/api/leads-verwijder', { id });
      _act.data = null; _arc.data = null;
      window.DFO.render();
    } catch (e) {
      alert('Kon niet archiveren: ' + (e?.message || 'onbekende fout'));
    }
  };

  // ── Ronde 10: v2 "Lead bewerken"-modal (vervangt link naar oude pagina) ──
  // Fetcht /api/lead-grants (basisvelden + grants) + /api/lms-producten-actief
  // (voor toe-te-voegen producten). Submit via bestaand /api/lead-bijwerken,
  // dat óók e-mailwijziging naar auth-account synct (backend-logica onaangeraakt).
  const _edit = {
    open: false, submitting: false, loading: false, error: null,
    leadId: null,
    form: { voornaam: '', achternaam: '', email: '', telefoon: '', herkomst: '' },
    grants: [],       // [{slug, naam, van, tot, verlopen, _intrekken:bool}]
    producten: [],    // [{slug, naam, duur_dagen}] — alleen niet-al-toegekende
    nieuw: {},        // {slug: {checked, van, tot}} — user-selectie voor "Product toevoegen"
  };
  function _todayIso() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10); }
  function _plusDagenIso(n) { const d = new Date(); d.setDate(d.getDate() + (Number(n) || 14)); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10); }

  window.__leadEditOpen = async (id) => {
    _edit.open = true; _edit.loading = true; _edit.error = null; _edit.leadId = id;
    _edit.form = { voornaam: '', achternaam: '', email: '', telefoon: '', herkomst: '' };
    _edit.grants = []; _edit.producten = []; _edit.nieuw = {};
    window.DFO.render();
    try {
      const [gr, prods] = await Promise.all([
        tryFetch('lead-grants',           '/api/lead-grants?lead_id=' + encodeURIComponent(id)),
        tryFetch('lms-producten-actief',  '/api/lms-producten-actief'),
      ]);
      if (!gr) throw new Error('lead-grants fetch faalde');
      _edit.form = {
        voornaam:   gr.lead?.voornaam   || '',
        achternaam: gr.lead?.achternaam || '',
        email:      gr.lead?.email      || '',
        telefoon:   gr.lead?.telefoon   || '',
        herkomst:   gr.lead?.soort      || '',
      };
      _edit.grants = (Array.isArray(gr.grants) ? gr.grants : []).map(g => ({
        slug: g.slug, naam: g.naam || g.slug, van: g.van || '', tot: g.tot || '',
        verlopen: !!g.verlopen, _intrekken: false,
      }));
      const alHeeft = new Set(_edit.grants.map(g => g.slug));
      const allProd = Array.isArray(prods?.producten) ? prods.producten
                    : Array.isArray(prods?.items) ? prods.items
                    : Array.isArray(prods) ? prods : [];
      // Filter: alleen echte grant-producten (moeten duur_dagen > 0 hebben).
      // Producten zonder duur (bv "1-op-1 Coaching") zijn full-service /
      // abonnements-producten die niet via lead-grants werken. v1 toont ze
      // wel maar renders "? dagen" wat verwarrend is — v2 sluit ze expliciet
      // uit zodat alleen de toegang-grant-producten (7-daagse, mini-cursus)
      // overblijven.
      _edit.producten = allProd.filter(p => p && p.slug && !alHeeft.has(p.slug) && Number(p.duur_dagen) > 0);
      _edit.loading = false;
    } catch (e) {
      _edit.loading = false;
      _edit.error = 'Kon lead-data niet laden: ' + (e?.message || 'onbekend');
      console.error('[leads-v2] __leadEditOpen fail:', e?.message);
    }
    window.DFO.render();
  };
  window.__leadEditClose = () => {
    _edit.open = false; _edit.submitting = false; _edit.error = null; _edit.leadId = null;
    _edit.form = { voornaam: '', achternaam: '', email: '', telefoon: '', herkomst: '' };
    _edit.grants = []; _edit.producten = []; _edit.nieuw = {};
    window.DFO.render();
  };
  window.__leadEditInput = (field, val) => { _edit.form[field] = val; };
  window.__leadEditGrantDate = (slug, field, val) => {
    const g = _edit.grants.find(x => x.slug === slug);
    if (g) g[field] = val;
  };
  window.__leadEditGrantToggle = (slug) => {
    const g = _edit.grants.find(x => x.slug === slug);
    if (g) { g._intrekken = !g._intrekken; window.DFO.render(); }
  };
  window.__leadEditNieuwToggle = (slug) => {
    const p = _edit.producten.find(x => x.slug === slug);
    if (!p) return;
    if (_edit.nieuw[slug]) {
      delete _edit.nieuw[slug];
    } else {
      _edit.nieuw[slug] = { checked: true, van: _todayIso(), tot: _plusDagenIso(p.duur_dagen) };
    }
    window.DFO.render();
  };
  window.__leadEditNieuwDate = (slug, field, val) => {
    if (_edit.nieuw[slug]) _edit.nieuw[slug][field] = val;
  };
  window.__leadEditSubmit = async () => {
    if (_edit.submitting) return;
    _edit.error = null;
    const email = String(_edit.form.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      _edit.error = 'Geldig e-mailadres vereist.'; window.DFO.render(); return;
    }
    _edit.submitting = true; window.DFO.render();
    // Payload matcht /api/lead-bijwerken schema (regel 5-11):
    //   { lead_id, voornaam?, achternaam?, email, telefoon?, herkomst?,
    //     grants?: [{slug, van, tot, intrekken?}], nieuw?: [{slug, van, tot}] }
    const grants = _edit.grants.map(g => ({
      slug: g.slug,
      van:  g.van || null,
      tot:  g.tot || null,
      intrekken: !!g._intrekken,
    }));
    const nieuw = Object.entries(_edit.nieuw)
      .filter(([_, v]) => v && v.checked)
      .map(([slug, v]) => ({ slug, van: v.van, tot: v.tot }));
    try {
      await tryPost('lead-bijwerken', '/api/lead-bijwerken', {
        lead_id:    _edit.leadId,
        voornaam:   _edit.form.voornaam || null,
        achternaam: _edit.form.achternaam || null,
        email,
        telefoon:   _edit.form.telefoon || null,
        herkomst:   _edit.form.herkomst || null,
        grants, nieuw,
      });
      // Success: sluit modal, invalideer caches, herrender.
      window.__leadEditClose();
      _act.data = null; _arc.data = null;
      if (_det.data) _det.data = null;
      window.DFO.render();
    } catch (e) {
      _edit.submitting = false;
      _edit.error = 'Opslaan mislukt: ' + (e?.message || 'onbekend');
      window.DFO.render();
    }
  };
  // Esc-key sluit bewerk-modal.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _edit.open) { e.preventDefault(); window.__leadEditClose(); }
  });

  window.__leadNotitieInput = (v) => { _det.notitieDraft = v; };

  window.__leadPatch = async (patch) => {
    if (_det.saving || !_det.id) return;
    _det.saving = true;
    window.DFO.render();
    try {
      await tryPost('leads-update', '/api/leads-update', { id: _det.id, ...patch });
      _det.data = null;
      _act.data = null; _arc.data = null;
    } catch (e) {
      alert('Wijziging niet opgeslagen: ' + (e?.message || 'onbekende fout'));
    }
    _det.saving = false;
    window.DFO.render();
  };

  window.__leadStatusChange = (val) => window.__leadPatch({ status: val });
  window.__leadNotitieSave = () => {
    const val = String(_det.notitieDraft || '').trim();
    window.__leadPatch({ notitie: val });
  };

  window.__leadSort = (by) => {
    if (_act.sortBy === by) _act.sortDir = _act.sortDir === 'asc' ? 'desc' : 'asc';
    else { _act.sortBy = by; _act.sortDir = by === 'aangemaakt' ? 'desc' : 'desc'; }
    window.DFO.render();
  };
  function actiefParams() {
    // Ronde 7b: 6 dropdown-filters (v1-parity). Elke filter default '' = geen.
    const soort   = F('lead-soort', '');
    const traject = F('lead-traject', '');
    const kwal    = F('lead-kwal', '');
    const bron    = F('lead-bron', '');
    const st      = F('lead-st', '');
    const afspr   = F('lead-afspr', '');
    const q = String(_act.search || '').trim();
    const p = new URLSearchParams();
    if (soort)   p.set('soort', soort);
    if (traject) p.set('traject', traject);
    if (kwal)    p.set('kwalificatie', kwal);
    if (bron)    p.set('bron', bron);
    if (st)      p.set('status', st);
    if (afspr)   p.set('afspraak', afspr);
    if (q)       p.set('q', q);
    p.set('archief', '0');
    p.set('limit', '50');
    p.set('offset', '0');
    return p.toString();
  }
  // Traject-list lazy-fetch (vult Traject-dropdown; 1x per module-load).
  async function fetchTrajecten() {
    if (_traj.list || _traj.loading) return;
    _traj.loading = true;
    const data = await tryFetch('leads-trajecten', '/api/leads-trajecten');
    _traj.list = Array.isArray(data?.trajecten) ? data.trajecten : [];
    _traj.loading = false;
    window.DFO.render();
  }

  async function fetchActief() {
    const wanted = actiefParams();
    if (_act.loading && _act.params === wanted) return;
    const seq = ++_act.seq;
    _act.loading = true; _act.error = null; _act.params = wanted;
    window.DFO.render();
    try {
      const [list, stats] = await Promise.all([
        tryFetch('leads-list',  '/api/leads-list?' + wanted),
        tryFetch('leads-stats', '/api/leads-stats'),
      ]);
      if (seq !== _act.seq) return;
      // FAIL-SOFT: bij null-response nog steeds _act.data zetten op een geldig
      // shape (items:[]) om retry-storm te breken — anders zou !_act.data
      // waar-blijven en elke render triggert opnieuw queueMicrotask(fetchActief).
      // Ronde 5-fix: retry gebeurt alleen op user-klik van de retry-knop.
      _act.data = list || { items: [], total: 0 };
      _act.stats = stats || {};
      if (!list) _act.error = 'Kon leads-list niet laden (netwerk of 500).';
      else if (!stats) _act.error = 'Kon leads-stats niet laden.';
    } catch (e) {
      if (seq !== _act.seq) return;
      _act.data = { items: [], total: 0 };
      _act.stats = {};
      _act.error = 'Fetch-fout: ' + (e?.message || 'onbekend');
      console.error('[leads-v2] fetchActief exception:', e?.message);
    } finally {
      if (seq === _act.seq) {
        _act.loading = false;
        window.DFO.render();
      }
    }
  }
  // Ronde 5: manual retry vanuit error-state knop.
  window.__leadRetry = () => {
    _act.data = null; _act.error = null; _act.params = '';
    fetchActief();
  };

  function actiefListView() {
    // Ronde 7b: dropdown-filters vervangen chip-rijen. F-defaults zijn '' (= alle).
    if (!_traj.list && !_traj.loading) queueMicrotask(fetchTrajecten);
    const fSoort   = F('lead-soort', '');
    const fTraject = F('lead-traject', '');
    const fKwal    = F('lead-kwal', '');
    const fBron    = F('lead-bron', '');
    const fStatus  = F('lead-st', '');
    const fAfspr   = F('lead-afspr', '');
    let items = (_act.data?.items || []).slice();
    const total = _act.data?.total ?? null;
    const s = _act.stats || {};

    // Ronde 4/5: shared stableSearch registreren. GEEN setSearchValue-per-render
    // meer — dat overschrijft de user's getypte waarde vóórdat de 280ms debounce
    // fireet ("zoekveld wist zichzelf"). SEARCH_VALUES + input.value zijn nu
    // source-of-truth vanaf mount; _act.search wordt alleen via de debounced
    // onChange bijgewerkt.
    H.onSearch('leads-act', (val) => {
      _act.search = val || '';
      _act.data = null;   // dwing re-fetch met nieuwe q
      fetchActief();
    });

    // Client-side sort (op zichtbare 50). server-side sort niet in leads-list.
    if (_act.sortBy === 'aangemaakt') {
      items.sort((a, b) => {
        const av = String(a?.aangemaakt || '');
        const bv = String(b?.aangemaakt || '');
        return _act.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    } else if (_act.sortBy === 'score') {
      items.sort((a, b) => {
        const av = Number(a?.score) || 0;
        const bv = Number(b?.score) || 0;
        return _act.sortDir === 'asc' ? av - bv : bv - av;
      });
    }
    const scores = items.map(i => Number(i.score)).filter(n => !isNaN(n));
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const sortIcon = (col) => _act.sortBy === col ? (_act.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

    return `${previewHeader('Actief', _act)}
      ${H.kpis([
        { c: 'teal',    icon: I.users,  label: 'Nieuw vandaag',        val: num(s.vandaag),          hi: 1 },
        { c: 'blue',    icon: I.mail,   label: 'Nieuw totaal',         val: num(s.nieuw),                   sub: 'status = nieuw' },
        { c: 'emerald', icon: I.check,  label: 'Gekwalificeerd (week)',val: num(s.week_gekwalificeerd),     sub: 'deze week' },
        { c: 'violet',  icon: I.trend,  label: 'Gem. score (page)',    val: avgScore != null ? String(avgScore) : '—', sub: 'op zichtbare 50' },
      ])}
      ${H.toolbar([
        // Ronde 7b — 6 dropdown-filters (v1 parity uit modules/leads.html:163-195).
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-soort', this.value)">
          <option value="" ${fSoort === '' ? 'selected' : ''}>Herkomst: alle</option>
          <option value="instagram" ${fSoort === 'instagram' ? 'selected' : ''}>Instagram</option>
          <option value="facebook"  ${fSoort === 'facebook'  ? 'selected' : ''}>Facebook</option>
          <option value="google"    ${fSoort === 'google'    ? 'selected' : ''}>Google</option>
          <option value="via-via"   ${fSoort === 'via-via'   ? 'selected' : ''}>Via-via</option>
          <option value="linkedin"  ${fSoort === 'linkedin'  ? 'selected' : ''}>LinkedIn</option>
          <option value="tiktok"    ${fSoort === 'tiktok'    ? 'selected' : ''}>TikTok</option>
          <option value="overige"   ${fSoort === 'overige'   ? 'selected' : ''}>Overige</option>
          <option value="onbekend"  ${fSoort === 'onbekend'  ? 'selected' : ''}>Onbekend</option>
        </select>`,
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-traject', this.value)">
          <option value="" ${fTraject === '' ? 'selected' : ''}>Traject: alle</option>
          ${(_traj.list || []).map(t => `<option value="${esc(t)}" ${fTraject === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}
          ${(fTraject && !(_traj.list || []).includes(fTraject)) ? `<option value="${esc(fTraject)}" selected>${esc(fTraject)}</option>` : ''}
        </select>`,
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-kwal', this.value)">
          <option value="" ${fKwal === '' ? 'selected' : ''}>Kwalificatie: alle</option>
          <option value="toegang"       ${fKwal === 'toegang'       ? 'selected' : ''}>toegang</option>
          <option value="geen toegang"  ${fKwal === 'geen toegang'  ? 'selected' : ''}>geen toegang</option>
          <option value="geen"          ${fKwal === 'geen'          ? 'selected' : ''}>geen vragenlijst</option>
        </select>`,
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-bron', this.value)">
          <option value="" ${fBron === '' ? 'selected' : ''}>Bron: alle</option>
          <option value="website"                 ${fBron === 'website' ? 'selected' : ''}>website</option>
          <option value="7-daagse-v1"             ${fBron === '7-daagse-v1' ? 'selected' : ''}>7-daagse-v1</option>
          <option value="7-daagse-v2"             ${fBron === '7-daagse-v2' ? 'selected' : ''}>7-daagse-v2</option>
          <option value="kennismakingscursus-v1"  ${fBron === 'kennismakingscursus-v1' ? 'selected' : ''}>kennismakingscursus-v1</option>
          <option value="kennismakingscursus-v2"  ${fBron === 'kennismakingscursus-v2' ? 'selected' : ''}>kennismakingscursus-v2</option>
          <option value="funnel"                  ${fBron === 'funnel' ? 'selected' : ''}>funnel</option>
          <option value="meta"                    ${fBron === 'meta' ? 'selected' : ''}>meta</option>
          <option value="handmatig"               ${fBron === 'handmatig' ? 'selected' : ''}>handmatig</option>
        </select>`,
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-st', this.value)">
          <option value="" ${fStatus === '' ? 'selected' : ''}>Status: alle</option>
          <option value="nieuw"     ${fStatus === 'nieuw'     ? 'selected' : ''}>nieuw</option>
          <option value="opgevolgd" ${fStatus === 'opgevolgd' ? 'selected' : ''}>opgevolgd</option>
          <option value="gewonnen"  ${fStatus === 'gewonnen'  ? 'selected' : ''}>gewonnen</option>
          <option value="verloren"  ${fStatus === 'verloren'  ? 'selected' : ''}>verloren</option>
        </select>`,
        `<select class="ld-filter-sel" onchange="DFO.setF('lead-afspr', this.value)">
          <option value="" ${fAfspr === '' ? 'selected' : ''}>Call gepland: alle</option>
          <option value="ja"  ${fAfspr === 'ja'  ? 'selected' : ''}>Call gepland: ja</option>
          <option value="nee" ${fAfspr === 'nee' ? 'selected' : ''}>Call gepland: nee</option>
        </select>`,
        H.stableSearch('leads-act', 'Zoek naam / e-mail / telefoon…'),
        `<div class="tb-right">
          <button class="btn btn-sm" onclick="__leadSort('aangemaakt')" title="Sorteer op aanmaakdatum">Datum${sortIcon('aangemaakt')}</button>
          <button class="btn btn-sm" onclick="__leadSort('score')" title="Sorteer op score">Score${sortIcon('score')}</button>
          <button class="btn btn-primary" onclick="__leadNew()">${svg(I.plus)}Nieuwe lead</button>
        </div>`,
      ])}
      <div class="sv-total">${_act.loading ? 'Laden…' : (total != null ? `${total} lead${total === 1 ? '' : 's'}` : '—')}</div>
      ${_act.error ? `<div class="sv-empty" style="border:1px solid var(--warn-line, var(--rose-line, var(--line)));background:var(--warn-soft, var(--rose-soft, var(--surface-2)));color:var(--warn, var(--rose));display:flex;align-items:center;gap:12px;padding:14px 18px;margin:12px 20px;border-radius:8px">
        ${svg(I.alert || I.warn, 'width:20px;height:20px;flex-shrink:0')}
        <span style="flex:1"><b>Kon leads niet laden:</b> ${esc(_act.error)}</span>
        <button class="btn btn-sm" onclick="__leadRetry()">${svg(I.repeat || I.settings, 'width:14px;height:14px')} Opnieuw proberen</button>
      </div>` : ''}
      ${H.table(
        [{ l: 'Naam' }, { l: 'E-mail', cls: 'optional' }, { l: 'Telefoon', cls: 'optional' }, { l: 'Herkomst' }, { l: 'Traject', cls: 'optional' }, { l: 'Call gepland', cls: 'optional' }, { l: 'Status' }, { l: 'Score', cls: 'r' }, { l: 'Aangemaakt', cls: 'r optional' }, { l: '', cls: 'r' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          const herkomst = l.soort || l.herkomst || '';
          const sc = Number(l.score);
          const dr = Number(l.drempel);
          const scColor = (!isNaN(sc) && !isNaN(dr) && dr > 0)
            ? (sc >= dr ? 'var(--emerald, #10b981)' : 'var(--danger, var(--warn, #ef4444))')
            : 'var(--text-2)';
          const scLabel = l.score != null
            ? `${l.score}${l.drempel ? ' / ' + l.drempel : ''}`
            : '—';
          const call = l.afspraak_op ? dstr(l.afspraak_op) : '—';
          const nameEsc = String(l.naam || '').replace(/"/g, '&quot;').replace(/'/g, "\\'");
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="ld-name">${esc(l.naam) || '—'}</a></div>`,
            `<span class="mono" style="font-size:11.5px;color:var(--text-2)">${esc(l.email) || '—'}</span>`,
            `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(l.telefoon) || '—'}</span>`,
            `<span class="pill pill-neutral">${esc(herkomst) || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${esc(l.traject) || '—'}</span>`,
            `<span class="mono" style="font-size:12px;color:var(--text-3)">${esc(call)}</span>`,
            H.pill(c, pl),
            `<span class="mono strong" style="color:${scColor}">${scLabel}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(l.aangemaakt)}</span>`,
            `<div style="display:inline-flex;gap:4px;justify-content:flex-end">
              <button class="icon-btn" title="Wijzig lead" onclick="event.stopPropagation();__leadRowEdit('${l.id}')">${svg(I.settings)}</button>
              <button class="icon-btn" title="Verwijder (archiveer)" onclick="event.stopPropagation();__leadRowDelete('${l.id}', '${nameEsc}')" style="color:var(--danger, var(--warn))">${svg(I.x || I.warn)}</button>
            </div>`,
          ];
        })
      )}
      ${!items.length && !_act.loading && !_act.error ? `<div class="sv-empty">Geen leads met deze filters.</div>` : ''}`;
  }

  function createModal() {
    if (!_cre.producten && !_cre.prodLoading) queueMicrotask(fetchProducten);
    const f = _cre.form;
    const dis = _cre.submitting ? ' disabled' : '';
    return `<div class="ld-modal-back" onclick="if(event.target===this)__leadNewClose()">
      <div class="ld-modal">
        <div class="ld-modal-head">
          <div class="ld-modal-title">Nieuwe lead</div>
          <button class="icon-btn" onclick="__leadNewClose()" title="Sluiten (Esc)">${svg(I.x || I.warn)}</button>
        </div>
        <div class="ld-modal-body">
          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Voornaam</span>
              <input class="ib-input" placeholder="Bijv. Jan" defaultValue="${esc(f.voornaam)}" oninput="__leadCreateInput('voornaam', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Achternaam</span>
              <input class="ib-input" placeholder="Bijv. Jansen" defaultValue="${esc(f.achternaam)}" oninput="__leadCreateInput('achternaam', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Herkomst</span>
              <select class="ib-input" onchange="__leadCreateInput('herkomst', this.value)"${dis}>
                ${['handmatig', 'meta', 'instagram', 'webinar', 'referral', 'onbekend'].map(h => `<option value="${h}" ${f.herkomst === h ? 'selected' : ''}>${h[0].toUpperCase() + h.slice(1)}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">E-mail <span class="tk-req">*</span></span>
              <input class="ib-input" type="email" placeholder="lead@voorbeeld.nl" defaultValue="${esc(f.email)}" oninput="__leadCreateInput('email', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Telefoon (optioneel)</span>
              <input class="ib-input" placeholder="+31 6 12 34 56 78" defaultValue="${esc(f.telefoon)}" oninput="__leadCreateInput('telefoon', this.value)"${dis}>
            </label>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Producten (minstens één) <span class="tk-req">*</span></span>
            <div style="display:flex;flex-direction:column;gap:6px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface)">
              ${_cre.producten
                ? _cre.producten.map(p => {
                    const checked = Array.isArray(f.productSlugs) && f.productSlugs.includes(p.slug);
                    return `<label class="ld-check" style="cursor:pointer">
                      <input type="checkbox" ${checked ? 'checked' : ''} onchange="__leadCreateProductToggle('${esc(p.slug)}')"${dis}>
                      <span><b>${esc(p.naam)}</b> <span style="color:var(--text-3);font-size:11.5px">${p.duur_dagen || '?'} dagen · slug: ${esc(p.slug)}</span></span>
                    </label>`;
                  }).join('')
                : `<div style="font-size:12px;color:var(--text-3)">Producten laden…</div>`
              }
            </div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Vink meerdere aan om b.v. mini-cursus + 7-daagse tegelijk toegang te geven (endpoint <code>/api/lead-handmatig-toevoegen</code> accepteert een <code>producten[]</code> array).</div>
          </div>

          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Toegang van</span>
              <input class="ib-input" type="date" defaultValue="${f.van}" oninput="__leadCreateInput('van', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Toegang tot</span>
              <input class="ib-input" type="date" defaultValue="${f.tot}" oninput="__leadCreateInput('tot', this.value)"${dis}>
            </label>
          </div>

          <label class="ld-check">
            <input type="checkbox" ${f.welkomstmail ? 'checked' : ''} onchange="__leadCreateWelkomToggle()"${dis}>
            <span>Welkomstmail direct versturen (met inloglink)</span>
          </label>

          <div class="ld-hint">
            Deze lead wordt aangemaakt met bron <b>${esc(f.herkomst)}</b>. Er wordt automatisch een account gemaakt en toegang tot het gekozen product verleend. Voor meer producten of custom grants: gebruik <a href="/modules/leads.html?new=1" target="_blank">de oude wizard</a>.
          </div>
        </div>
        <div class="ld-modal-foot">
          <button class="btn" onclick="__leadNewClose()"${dis}>Annuleren</button>
          <button class="btn btn-primary" onclick="__leadCreateSubmit()"${dis}>
            ${_cre.submitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.check || I.plus) + 'Lead aanmaken'}
          </button>
        </div>
      </div>
    </div>`;
  }

  function actiefView() {
    if (urlParam('lead')) return detailView();
    if (_det.id != null) { _det.id = null; _det.data = null; _det.error = null; _det.notitieDraft = ''; }
    if (!_act.loading && (!_act.data || _act.params !== actiefParams())) queueMicrotask(fetchActief);
    const list = actiefListView();
    const modal = urlParam('lead-new') === '1' ? createModal() : '';
    const editM = _edit.open ? editModal() : '';
    return list + modal + editM;
  }

  function archiefParams() {
    const q = String(_arc.search || '').trim();
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('archief', '1');
    p.set('limit', '50');
    p.set('offset', '0');
    return p.toString();
  }

  async function fetchArchief() {
    const wanted = archiefParams();
    if (_arc.loading && _arc.params === wanted) return;
    const seq = ++_arc.seq;
    _arc.loading = true; _arc.error = null; _arc.params = wanted;
    window.DFO.render();
    const list = await tryFetch('leads-list-archief', '/api/leads-list?' + wanted);
    if (seq !== _arc.seq) return;
    _arc.data = list;
    _arc.loading = false;
    if (!list) _arc.error = 'Kon archief niet laden';
    window.DFO.render();
  }

  function archiefListView() {
    const items = _arc.data?.items || [];
    const total = _arc.data?.total ?? null;
    H.onSearch('leads-arc', (val) => { _arc.search = val || ''; fetchArchief(); });
    if (H.getSearchValue('leads-arc') !== (_arc.search || '')) H.setSearchValue('leads-arc', _arc.search || '');
    return `${previewHeader('Gearchiveerd (soft-delete via verwijderd_op)', _arc)}
      ${H.toolbar([H.stableSearch('leads-arc', 'Zoek naam / e-mail / telefoon…')])}
      <div class="sv-total">${_arc.loading ? 'Laden…' : (total != null ? `${total} gearchiveerd${total === 1 ? '' : 'e leads'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Herkomst' }, { l: 'Traject', cls: 'optional' }, { l: 'Laatste status', cls: 'optional' }, { l: 'Aangemaakt', cls: 'r optional' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          const herkomst = l.soort || l.herkomst || '';
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="ld-name">${esc(l.naam) || '—'}</a></div>`,
            `<span class="pill pill-neutral">${esc(herkomst) || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${esc(l.traject) || '—'}</span>`,
            H.pill(c, pl),
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(l.aangemaakt)}</span>`,
          ];
        })
      )}
      ${!items.length && !_arc.loading ? `<div class="sv-empty">${_arc.error || 'Geen gearchiveerde leads.'}</div>` : ''}`;
  }

  function archiefView() {
    if (urlParam('lead')) return detailView();
    if (_det.id != null) { _det.id = null; _det.data = null; _det.error = null; _det.notitieDraft = ''; }
    if (!_arc.loading && (!_arc.data || _arc.params !== archiefParams())) queueMicrotask(fetchArchief);
    const list = archiefListView();
    const modal = urlParam('lead-new') === '1' ? createModal() : '';
    const editM = _edit.open ? editModal() : '';
    return list + modal + editM;
  }

  // ── Ronde 10: v2 editModal (1-op-1 pariteit met v1 modules/leads.html:266)
  //  Velden: voornaam / achternaam / e-mail* / telefoon / herkomst-dropdown +
  //  bestaande grants (van/tot editable + intrekken-toggle) + product-toevoegen
  //  (checkboxes met van/tot). Submit → POST /api/lead-bijwerken (incl. email
  //  → auth-account-sync + LMS-provisioning: onaangeraakte backend-logica).
  const HERKOMST_OPTIES = [
    ['', '— kies —'], ['instagram', 'Instagram'], ['facebook', 'Facebook'],
    ['google', 'Google'], ['via-via', 'Via-via'], ['linkedin', 'LinkedIn'],
    ['tiktok', 'TikTok'], ['overige', 'Overige'], ['onbekend', 'Onbekend'],
  ];
  function editModal() {
    const f = _edit.form;
    const dis = _edit.submitting || _edit.loading ? ' disabled' : '';
    return `<div class="ld-modal-back" onclick="if(event.target===this)__leadEditClose()">
      <div class="ld-modal" style="max-width:640px">
        <div class="ld-modal-head">
          <div class="ld-modal-title">Lead bewerken</div>
          <button class="icon-btn" onclick="__leadEditClose()" title="Sluiten (Esc)">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="ld-modal-body">
          <p class="ld-hint" style="margin-top:0">Wijzig de gegevens en het toegangsbeheer. Een e-mailwijziging synct ook het loginaccount.</p>

          ${_edit.loading ? `<div class="sv-empty" style="padding:24px">${svg(I.clock || I.settings, 'width:20px;height:20px')} Laden…</div>` : ''}
          ${!_edit.loading ? `
          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Voornaam</span>
              <input class="ib-input" placeholder="Voornaam" value="${esc(f.voornaam)}" oninput="__leadEditInput('voornaam', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Achternaam</span>
              <input class="ib-input" placeholder="Achternaam" value="${esc(f.achternaam)}" oninput="__leadEditInput('achternaam', this.value)"${dis}>
            </label>
          </div>
          <label class="tk-field">
            <span class="tk-field-l">E-mailadres <span class="tk-req">*</span></span>
            <input class="ib-input" type="email" placeholder="lead@voorbeeld.nl" value="${esc(f.email)}" oninput="__leadEditInput('email', this.value)"${dis}>
          </label>
          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Telefoon</span>
              <input class="ib-input" placeholder="+31 6 …" value="${esc(f.telefoon)}" oninput="__leadEditInput('telefoon', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Herkomst</span>
              <select class="ib-input" onchange="__leadEditInput('herkomst', this.value)"${dis}>
                ${HERKOMST_OPTIES.map(([v, l]) => `<option value="${esc(v)}" ${f.herkomst === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
              </select>
            </label>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Huidige toegang</span>
            <div class="ld-edit-list">
              ${_edit.grants.length ? _edit.grants.map(g => `
                <div class="ld-edit-grant ${g._intrekken ? 'is-ingetrokken' : ''}">
                  <div class="ld-edit-grant-name">
                    <b>${esc(g.naam)}</b>
                    ${g.verlopen ? `<span class="ld-hint" style="color:var(--warn, var(--orange));margin-left:6px">(verlopen)</span>` : ''}
                  </div>
                  <input type="date" class="ib-input ld-edit-date" value="${esc(g.van || '')}" onchange="__leadEditGrantDate('${esc(g.slug)}', 'van', this.value)"${dis}>
                  <input type="date" class="ib-input ld-edit-date" value="${esc(g.tot || '')}" onchange="__leadEditGrantDate('${esc(g.slug)}', 'tot', this.value)"${dis}>
                  <button class="btn btn-sm ${g._intrekken ? '' : 'btn-danger'}" onclick="__leadEditGrantToggle('${esc(g.slug)}')"${dis}>
                    ${g._intrekken ? 'Ongedaan maken' : 'Intrekken'}
                  </button>
                </div>
              `).join('') : `<div class="ld-hint" style="padding:8px 4px">Nog geen toegang.</div>`}
            </div>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Product toevoegen</span>
            <div class="ld-edit-list">
              ${_edit.producten.length ? _edit.producten.map(p => {
                const sel = _edit.nieuw[p.slug];
                const checked = !!(sel && sel.checked);
                const van = sel?.van || _todayIso();
                const tot = sel?.tot || _plusDagenIso(p.duur_dagen);
                return `<div class="ld-edit-grant">
                  <label class="ld-edit-grant-name" style="display:flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" ${checked ? 'checked' : ''} onchange="__leadEditNieuwToggle('${esc(p.slug)}')"${dis}>
                    <span><b>${esc(p.naam || p.slug)}</b> <span class="ld-hint">(${p.duur_dagen || '?'} dagen)</span></span>
                  </label>
                  <input type="date" class="ib-input ld-edit-date" value="${esc(van)}" onchange="__leadEditNieuwDate('${esc(p.slug)}', 'van', this.value)" ${checked ? '' : 'disabled'}>
                  <input type="date" class="ib-input ld-edit-date" value="${esc(tot)}" onchange="__leadEditNieuwDate('${esc(p.slug)}', 'tot', this.value)" ${checked ? '' : 'disabled'}>
                  <span></span>
                </div>`;
              }).join('') : `<div class="ld-hint" style="padding:8px 4px">Alle actieve producten al toegekend.</div>`}
            </div>
          </div>
          ` : ''}

          ${_edit.error ? `<div class="sv-empty" style="border:1px solid var(--warn-line, var(--rose-line, var(--line)));background:var(--warn-soft, var(--rose-soft, var(--surface-2)));color:var(--warn, var(--rose));display:flex;align-items:center;gap:8px;padding:10px 14px;margin-top:10px;border-radius:8px">
            ${svg(I.alert || I.warn, 'width:16px;height:16px;flex-shrink:0')}
            <span>${esc(_edit.error)}</span>
          </div>` : ''}
        </div>
        <div class="ld-modal-foot">
          <button class="btn" onclick="__leadEditClose()"${_edit.submitting ? ' disabled' : ''}>Annuleren</button>
          <button class="btn btn-primary" onclick="__leadEditSubmit()"${_edit.submitting || _edit.loading ? ' disabled' : ''}>
            ${_edit.submitting ? svg(I.clock || I.settings, 'width:14px;height:14px') + 'Bezig…' : svg(I.check || I.plus, 'width:14px;height:14px') + 'Opslaan'}
          </button>
        </div>
      </div>
    </div>`;
  }

  // Ronde 8: dezelfde fail-soft-patroon als fetchActief (ronde 6). 8s timeout
  // via tryFetch/Promise.race; try/catch/finally; loading ALTIJD op false in
  // finally (voorheen bleef 'loading=true' hangen bij seq-mismatch of throw,
  // waardoor detail-view eeuwig "Laden…" toonde). Op fail: _det.data krijgt
  // safe shape { lead:{} } zodat de check !_det.data false wordt en render
  // niet opnieuw queueMicrotask(fetchDetail) triggert (retry-storm break).
  async function fetchDetail(id) {
    if (_det.loading && _det.id === id) return;
    const seq = ++_det.seq;
    _det.loading = true; _det.error = null; _det.id = id;
    window.DFO.render();
    try {
      const data = await tryFetch('leads-detail', '/api/leads-detail?id=' + encodeURIComponent(id));
      if (seq !== _det.seq) return;
      if (!data) {
        _det.data = { lead: {}, antwoorden: [], messages: [], eigenaar: null };
        _det.error = 'Kon lead-detail niet laden (endpoint returnde null; check RBAC/500).';
      } else {
        _det.data = data;
        _det.notitieDraft = data.notitie || '';
      }
    } catch (e) {
      if (seq !== _det.seq) return;
      _det.data = { lead: {}, antwoorden: [], messages: [], eigenaar: null };
      _det.error = 'Fetch-fout: ' + (e?.message || 'onbekend');
      console.error('[leads-v2] fetchDetail exception:', e?.message);
    } finally {
      if (seq === _det.seq) {
        _det.loading = false;
        window.DFO.render();
      }
    }
  }
  window.__leadDetailRetry = () => {
    if (!_det.id) return;
    const id = _det.id;
    _det.data = null; _det.error = null;
    fetchDetail(id);
  };

  function detailView() {
    const id = urlParam('lead');
    if (!id) return '';
    if (!_det.loading && (!_det.data || _det.id !== id)) queueMicrotask(() => fetchDetail(id));
    const d = _det.data || {};
    const l = d.lead || {};
    const antw = Array.isArray(d.antwoorden) ? d.antwoorden : [];
    const messages = Array.isArray(d.messages) ? d.messages : [];
    const eigenaar = d.eigenaar || null;
    const [sc, sl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
    // Ronde 8: Terug-knop STAAT bewust bovenaan en heeft geen data-guard —
    // hij werkt tijdens laden en bij fout. Error-block toont fetch-status +
    // retry-knop zodat de user nooit vastzit. Debug-block (tijdelijk) toont
    // endpoint-URL + response-keys zodat één screenshot de oorzaak toont.
    return `${previewHeader('Lead-detail · live', _det)}
      <div class="tk-det-head">
        <button class="btn" onclick="__leadBack()">← Terug naar lijst</button>
        <div class="tk-det-title">${esc(l.naam) || (_det.loading ? 'Laden…' : '—')}</div>
        <div class="tk-det-meta">
          ${l.status ? H.pill(sc, sl) : ''}
          ${l.bron ? `<span class="pill pill-neutral">${esc(l.bron)}</span>` : ''}
          ${l.score != null ? `<span class="pill pill-neutral">Score ${l.score}${l.drempel ? ' / ' + l.drempel : ''}</span>` : ''}
        </div>
      </div>
      ${_det.error ? `<div class="sv-empty" style="border:1px solid var(--warn-line, var(--rose-line, var(--line)));background:var(--warn-soft, var(--rose-soft, var(--surface-2)));color:var(--warn, var(--rose));display:flex;align-items:center;gap:12px;padding:14px 18px;margin:12px 20px;border-radius:8px">
        ${svg(I.alert || I.warn, 'width:20px;height:20px;flex-shrink:0')}
        <span style="flex:1"><b>Kon lead-detail niet laden:</b> ${esc(_det.error)}</span>
        <button class="btn btn-sm" onclick="__leadDetailRetry()">${svg(I.repeat || I.settings, 'width:14px;height:14px')} Opnieuw proberen</button>
      </div>` : ''}
      <div class="tk-det-grid">
        <div class="tk-det-main">
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.doc)}Contactgegevens</div>
            <div class="sv-card-body">
              <div class="sv-row"><span>E-mail</span><b class="mono" style="font-size:12.5px">${esc(l.email) || '—'}</b></div>
              <div class="sv-row"><span>Telefoon</span><b class="mono" style="font-size:12.5px">${esc(l.telefoon) || '—'}</b></div>
              <div class="sv-row"><span>Herkomst</span><b>${esc(l.soort) || '—'}</b></div>
              <div class="sv-row"><span>Traject</span><b>${esc(l.traject) || '—'}</b></div>
              <div class="sv-row"><span>Kwalificatie</span><b>${esc(l.kwalificatie) || '—'}</b></div>
              <div class="sv-row"><span>Aangemaakt</span><b>${dstrLong(l.aangemaakt)}</b></div>
              ${l.afspraak_op ? `<div class="sv-row"><span>Afspraak op</span><b>${dstrLong(l.afspraak_op)}</b></div>` : ''}
            </div>
          </div>

          <div class="sv-card">
            <div class="sv-card-head">${svg(I.doc)}Notitie</div>
            <div class="sv-card-body">
              <textarea class="ib-input tk-textarea" rows="4" placeholder="Interne notitie over deze lead…" oninput="__leadNotitieInput(this.value)">${esc(_det.notitieDraft)}</textarea>
              <div class="tk-comment-form-foot">
                <button class="btn btn-primary" onclick="__leadNotitieSave()" ${_det.saving ? 'disabled' : ''}>
                  ${_det.saving ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.check) + 'Notitie opslaan'}
                </button>
              </div>
            </div>
          </div>

          ${antw.length ? `<div class="sv-card">
            <div class="sv-card-head">${svg(I.doc)}Antwoorden (uit intake)</div>
            <div class="sv-card-body">
              ${antw.map(a => `<div class="ld-antw">
                <div class="ld-antw-q">${esc(a.vraag) || esc(a.q) || '—'}</div>
                <div class="ld-antw-a">${esc(a.antwoord) || esc(a.a) || '—'}</div>
              </div>`).join('')}
            </div>
          </div>` : ''}

          ${messages.length ? `<div class="sv-card">
            <div class="sv-card-head">${svg(I.mail)}Berichten · ${num(messages.length)}</div>
            <div class="sv-card-body">
              ${messages.slice(0, 10).map(m => `<div class="tk-comment">
                <div class="tk-comment-head">
                  <div class="tk-comment-who">${esc(m.kanaal || m.type) || 'Bericht'}</div>
                  <div class="tk-comment-time">${dstrLong(m.aangemaakt || m.created_at)}</div>
                </div>
                <div class="tk-comment-body">${esc(m.body || m.tekst) || '—'}</div>
              </div>`).join('')}
            </div>
          </div>` : ''}
        </div>

        <div class="tk-det-side">
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.check)}Status wijzigen</div>
            <div class="sv-card-body">
              <select class="ib-input" onchange="__leadStatusChange(this.value)" ${_det.saving ? 'disabled' : ''}>
                <option value="nieuw"     ${l.status === 'nieuw' ? 'selected' : ''}>Nieuw</option>
                <option value="opgevolgd" ${l.status === 'opgevolgd' ? 'selected' : ''}>Opgevolgd</option>
                <option value="gewonnen"  ${l.status === 'gewonnen' ? 'selected' : ''}>Gewonnen</option>
                <option value="verloren"  ${l.status === 'verloren' ? 'selected' : ''}>Verloren</option>
              </select>
            </div>
          </div>

          <div class="sv-card">
            <div class="sv-card-head">${svg(I.users)}Eigenaar</div>
            <div class="sv-card-body">
              ${eigenaar ? `<div class="sv-row"><span>Naam</span><b>${esc(eigenaar.naam) || '—'}</b></div>
                <div class="sv-row"><span>E-mail</span><b class="mono" style="font-size:11.5px">${esc(eigenaar.email) || '—'}</b></div>` : `<div style="font-size:12.5px;color:var(--text-3)">${_det.loading ? 'Laden…' : 'Nog geen eigenaar toegewezen.'}</div>`}
              <div style="margin-top:8px;font-size:11.5px;color:var(--text-3)">Eigenaar-wijziging via /modules/leads-detail.html (v2-picker komt in ronde 3)</div>
            </div>
          </div>

          <div class="sv-card">
            <div class="sv-card-head">${svg(I.settings)}Lead-info</div>
            <div class="sv-card-body">
              <div class="sv-row"><span>Score</span><b>${l.score != null ? l.score : '—'}${l.drempel ? ' / ' + l.drempel : ''}</b></div>
              <div class="sv-row"><span>Tag</span><b>${esc(l.tag) || '—'}</b></div>
              <div class="sv-row"><span>Lead-ID</span><b class="mono" style="font-size:11px">${esc(String(l.id || '').slice(0, 8))}…</b></div>
            </div>
          </div>

          <div class="sv-card">
            <div class="sv-card-head">${svg(I.warn)}Meer acties</div>
            <div class="sv-card-body">
              <div style="display:flex;flex-direction:column;gap:6px">
                ${l.verwijderd_op
                  ? `<button class="btn btn-sm" onclick="__leadAct2Open('restore')">${svg(I.repeat)}Herstel lead uit archief</button>`
                  : `<button class="btn btn-sm" onclick="__leadAct2Open('archive')">${svg(I.x || I.warn)}Archiveer lead</button>`
                }
                ${(!l.verwijderd_op && l.status !== 'gewonnen')
                  ? `<button class="btn btn-primary" onclick="__leadAct2Open('promote')">${svg(I.check)}Omzetten naar klant</button>`
                  : (l.status === 'gewonnen' ? `<div style="font-size:11.5px;color:var(--text-3)">Al omgezet naar klant.</div>` : '')
                }
                <button class="btn btn-sm" onclick="__leadEditOpen('${esc(l.id || '')}')" style="margin-top:6px">${svg(I.settings, 'width:14px;height:14px')}Uitgebreid bewerken…</button>
                <div style="font-size:11px;color:var(--text-3);line-height:1.45">
                  Opent v2-bewerk-modal met naam / e-mail / telefoon / herkomst / toegang-beheer.
                  Endpoint <code>/api/lead-bijwerken</code> (incl. e-mail→auth-sync).
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${_act2.open ? act2Modal(l) : ''}
      ${_edit.open ? editModal() : ''}`;
  }

  // Ronde 4: bevestigings-modal voor archiveer / herstel / omzetten-klant.
  function act2Modal(lead) {
    const kind = _act2.kind;
    const config = kind === 'archive' ? {
      title: 'Lead archiveren?',
      body: `De lead <b>${esc(lead.naam) || '—'}</b> wordt gearchiveerd (soft-delete: <code>verwijderd_op = now()</code>). LMS-grants blijven; auth-account blijft. Herstel is mogelijk via het Gearchiveerd-tabblad.`,
      cta: 'Ja, archiveren',
      variant: 'btn',
    } : kind === 'restore' ? {
      title: 'Lead herstellen?',
      body: `De lead <b>${esc(lead.naam) || '—'}</b> wordt hersteld (<code>verwijderd_op = NULL</code>) en komt weer terug in de actieve lijst.`,
      cta: 'Ja, herstellen',
      variant: 'btn',
    } : {
      title: 'Offerte aanmaken uit deze lead?',
      body: `Je wordt doorgestuurd naar de <b>offerte-aanmaak-flow</b> voor <b>${esc(lead.naam) || '—'}</b> met alle lead-gegevens (naam / e-mail / telefoon) al vooringevuld. Zodra de offerte wordt afgerond wordt de lead-klant-koppeling automatisch gelegd (source_lead_id).<br><br><span style="font-size:11.5px;color:var(--text-3)">Tijdelijk routeert dit naar de oude wizard. Zodra de v2-offerte-wizard live is (Batch 2) wordt dit een in-app modal.</span>`,
      cta: 'Ja, open offerte-flow',
      variant: 'btn btn-primary',
    };
    const dis = _act2.submitting ? ' disabled' : '';
    return `<div class="ld-modal-back" onclick="if(event.target===this)__leadAct2Close()">
      <div class="ld-modal" style="max-width:520px">
        <div class="ld-modal-head">
          <div class="ld-modal-title">${config.title}</div>
          <button class="icon-btn" onclick="__leadAct2Close()" title="Sluiten (Esc)">${svg(I.x || I.warn)}</button>
        </div>
        <div class="ld-modal-body">
          <p style="font-size:13px;line-height:1.5;color:var(--text-2)">${config.body}</p>
        </div>
        <div class="ld-modal-foot">
          <button class="btn" onclick="__leadAct2Close()"${dis}>Annuleren</button>
          <button class="${config.variant}" onclick="__leadAct2Confirm()"${dis}>
            ${_act2.submitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.check || I.plus) + config.cta}
          </button>
        </div>
      </div>
    </div>`;
  }

  window.DFO.VIEWS['leads/Actief']       = actiefView;
  window.DFO.VIEWS['leads/Gearchiveerd'] = archiefView;

  window.addEventListener('popstate', () => {
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (urlParam('lead-new') === '1') { e.preventDefault(); window.__leadNewClose(); }
    else if (urlParam('lead'))        { e.preventDefault(); window.__leadBack(); }
  });

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leads');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leads');
  console.debug('[leads-v2] registered 2 views + detail (data-ronde 2)');
})();
