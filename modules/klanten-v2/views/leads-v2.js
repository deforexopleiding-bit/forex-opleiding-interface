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
  const _act = { loading: false, error: null, data: null, stats: null, seq: 0, params: '', search: '', sortBy: 'aangemaakt', sortDir: 'desc' };
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

  function previewHeader(label, state) {
    const err = state?.error ? `<span class="prev-badge-err">${esc(state.error)}</span>` : '';
    const loading = state?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

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
    // Ronde 5: "Omzetten naar klant" opent nu de offerte-aanmaak-flow met
    // lead-data als prefill (voorlopig oude sales-wizard.html). De v1-endpoint
    // /api/leads-promote maakt alleen customer aan zonder offerte — dat is een
    // fase 1 van 2. Voor Jeffrey is het pas "af" zodra de offerte staat, dus
    // routen we door naar de wizard. Zodra v2-offerte-wizard live is (Batch 2)
    // wordt dit een in-app modal.
    if (kind === 'promote') {
      const lead = _det.data?.lead || {};
      try {
        sessionStorage.setItem('_prefill_lead', JSON.stringify({
          lead_id: lead.id,
          first_name: lead.voornaam || '',
          last_name: lead.achternaam || '',
          email: lead.email || '',
          phone: lead.telefoon || '',
        }));
      } catch (_) { /* ignore quota */ }
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
  window.__leadRowEdit = (id) => { if (id) setUrlParam('lead', id); };
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
    const st = F('lead-st', 'all');
    const bron = F('lead-bron', 'all');
    const q = String(_act.search || '').trim();
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    if (bron && bron !== 'all') p.set('bron', bron);
    if (q) p.set('q', q);
    p.set('archief', '0');
    p.set('limit', '50');
    p.set('offset', '0');
    return p.toString();
  }

  async function fetchActief() {
    const wanted = actiefParams();
    if (_act.loading && _act.params === wanted) return;
    const seq = ++_act.seq;
    _act.loading = true; _act.error = null; _act.params = wanted;
    window.DFO.render();
    const [list, stats] = await Promise.all([
      tryFetch('leads-list',  '/api/leads-list?' + wanted),
      tryFetch('leads-stats', '/api/leads-stats'),
    ]);
    if (seq !== _act.seq) return;
    _act.data = list; _act.stats = stats;
    _act.loading = false;
    if (!list && !stats) _act.error = 'Kon leads niet laden';
    window.DFO.render();
  }

  function actiefListView() {
    const st = F('lead-st', 'all');
    const bron = F('lead-bron', 'all');
    let items = (_act.data?.items || []).slice();
    const total = _act.data?.total ?? null;
    const s = _act.stats || {};

    // Ronde 4: shared stableSearch registreren + client-side sort.
    H.onSearch('leads-act', (val) => {
      _act.search = val || '';
      fetchActief();
    });
    if (H.getSearchValue('leads-act') !== (_act.search || '')) H.setSearchValue('leads-act', _act.search || '');

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
        H.chips('lead-st', [
          { l: 'Alle',       v: 'all' },
          { l: 'Nieuw',      v: 'nieuw' },
          { l: 'Opgevolgd',  v: 'opgevolgd' },
          { l: 'Gewonnen',   v: 'gewonnen' },
          { l: 'Verloren',   v: 'verloren' },
        ], st),
        H.chips('lead-bron', [
          { l: 'Alle bronnen', v: 'all' },
          { l: 'Meta',         v: 'Meta' },
          { l: 'Instagram',    v: 'Instagram' },
          { l: 'Webinar',      v: 'Webinar' },
          { l: 'Referral',     v: 'Referral' },
        ], bron),
        H.stableSearch('leads-act', 'Zoek naam / e-mail / telefoon…'),
        `<div class="tb-right">
          <button class="btn btn-sm" onclick="__leadSort('aangemaakt')" title="Sorteer op aanmaakdatum">Datum${sortIcon('aangemaakt')}</button>
          <button class="btn btn-sm" onclick="__leadSort('score')" title="Sorteer op score">Score${sortIcon('score')}</button>
          <button class="btn btn-primary" onclick="__leadNew()">${svg(I.plus)}Nieuwe lead</button>
        </div>`,
      ])}
      <div class="sv-total">${_act.loading ? 'Laden…' : (total != null ? `${total} lead${total === 1 ? '' : 's'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Herkomst' }, { l: 'Traject', cls: 'optional' }, { l: 'Call gepland', cls: 'optional' }, { l: 'Status' }, { l: 'Score', cls: 'r' }, { l: 'Aangemaakt', cls: 'r optional' }, { l: '', cls: 'r' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          // Herkomst = l.soort (backend-veld heet 'soort', gebruikers-label = Herkomst).
          const herkomst = l.soort || l.herkomst || '';
          // Score-kleuring: groen = toegelaten (score >= drempel), rood = niet.
          // Bij ontbrekende drempel: neutraal.
          const sc = Number(l.score);
          const dr = Number(l.drempel);
          const scColor = (!isNaN(sc) && !isNaN(dr) && dr > 0)
            ? (sc >= dr ? 'var(--emerald, #10b981)' : 'var(--danger, var(--warn, #ef4444))')
            : 'var(--text-2)';
          const scLabel = l.score != null
            ? `${l.score}${l.drempel ? ' / ' + l.drempel : ''}`
            : '—';
          // Call gepland = afspraak_op gezet? Toon datum, anders '—'.
          const call = l.afspraak_op ? dstr(l.afspraak_op) : '—';
          const nameEsc = String(l.naam || '').replace(/"/g, '&quot;').replace(/'/g, "\\'");
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="ld-name">${esc(l.naam) || '—'}</a></div>`,
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
      ${!items.length && !_act.loading ? `<div class="sv-empty">${_act.error || 'Geen leads met deze filters.'}</div>` : ''}`;
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
    return list + modal;
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
    return list + modal;
  }

  async function fetchDetail(id) {
    if (_det.loading && _det.id === id) return;
    const seq = ++_det.seq;
    _det.loading = true; _det.error = null; _det.id = id;
    window.DFO.render();
    const data = await tryFetch('leads-detail', '/api/leads-detail?id=' + encodeURIComponent(id));
    if (seq !== _det.seq) return;
    _det.data = data;
    _det.notitieDraft = data?.notitie || '';
    _det.loading = false;
    if (!data) _det.error = 'Kon lead-detail niet laden';
    window.DFO.render();
  }

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
    return `${previewHeader('Lead-detail · live', _det)}
      <div class="tk-det-head">
        <button class="btn" onclick="__leadBack()">← Terug naar lijst</button>
        <div class="tk-det-title">${esc(l.naam) || (_det.loading ? 'Laden…' : '—')}</div>
        <div class="tk-det-meta">
          ${H.pill(sc, sl)}
          ${l.bron ? `<span class="pill pill-neutral">${esc(l.bron)}</span>` : ''}
          ${l.score != null ? `<span class="pill pill-neutral">Score ${l.score}${l.drempel ? ' / ' + l.drempel : ''}</span>` : ''}
        </div>
      </div>
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
                <a class="btn btn-sm" href="/modules/leads-detail.html?id=${encodeURIComponent(l.id || '')}" target="_blank" style="margin-top:6px">${svg(I.settings)}Uitgebreid bewerken ↗</a>
                <div style="font-size:11px;color:var(--text-3);line-height:1.45">
                  Uitgebreid bewerken (naam / e-mail / telefoon / grants) via oude detail-page.
                  Endpoint <code>/api/lead-bijwerken</code> — v2-full-modal komt in volgende ronde.
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      ${_act2.open ? act2Modal(l) : ''}`;
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
