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

  const _act = { loading: false, error: null, data: null, stats: null, seq: 0, params: '' };
  const _arc = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _det = { loading: false, error: null, data: null, seq: 0, id: null, saving: false, notitieDraft: '' };
  const _cre = {
    submitting: false,
    producten: null, prodLoading: false,
    form: { voornaam: '', achternaam: '', email: '', telefoon: '', productSlug: '', van: '', tot: '', herkomst: 'handmatig', welkomstmail: false },
  };

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
  window.__leadCreateProductChange = (slug) => {
    _cre.form.productSlug = slug;
    const p = (_cre.producten || []).find(x => x.slug === slug);
    if (p) {
      const now = new Date();
      const iso = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
      _cre.form.van = iso(now);
      const tot = new Date(now); tot.setDate(tot.getDate() + (Number(p.duur_dagen) || 365));
      _cre.form.tot = iso(tot);
    }
    window.DFO.render();
  };
  window.__leadCreateWelkomToggle = () => { _cre.form.welkomstmail = !_cre.form.welkomstmail; window.DFO.render(); };

  window.__leadCreateSubmit = async () => {
    if (_cre.submitting) return;
    const f = _cre.form;
    if (!f.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) { alert('Geldig e-mailadres vereist.'); return; }
    if (!f.productSlug) { alert('Kies een product.'); return; }
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
        producten: [{ slug: f.productSlug, van: f.van, tot: f.tot }],
        welkomstmail: !!f.welkomstmail,
      });
      _cre.submitting = false;
      _cre.form = { voornaam: '', achternaam: '', email: '', telefoon: '', productSlug: '', van: '', tot: '', herkomst: 'handmatig', welkomstmail: false };
      _act.data = null; _arc.data = null;
      setUrlParam('lead-new', null);
      alert('Lead aangemaakt' + (f.welkomstmail ? ' (welkomstmail verstuurd)' : '') + '.');
    } catch (e) {
      _cre.submitting = false;
      window.DFO.render();
      alert('Kon lead niet aanmaken: ' + (e?.message || 'onbekende fout'));
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

  function actiefParams() {
    const st = F('lead-st', 'all');
    const bron = F('lead-bron', 'all');
    const q = (F('q', '') || '').trim();
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
    const items = _act.data?.items || [];
    const total = _act.data?.total ?? null;
    const s = _act.stats || {};
    const scores = items.map(i => Number(i.score)).filter(n => !isNaN(n));
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
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
        H.search('Zoek naam / e-mail / telefoon…'),
        `<div class="tb-right"><button class="btn btn-primary" onclick="__leadNew()">${svg(I.plus)}Nieuwe lead</button></div>`,
      ])}
      <div class="sv-total">${_act.loading ? 'Laden…' : (total != null ? `${total} lead${total === 1 ? '' : 's'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Traject', cls: 'optional' }, { l: 'Status' }, { l: 'Score', cls: 'r' }, { l: 'Aangemaakt', cls: 'r optional' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="ld-name">${esc(l.naam) || '—'}</a></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${esc(l.bron) || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${esc(l.traject) || '—'}</span>`,
            H.pill(c, pl),
            `<span class="mono ${(l.score || 0) >= 80 ? 'strong' : ''}">${l.score != null ? l.score : '—'}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(l.aangemaakt)}</span>`,
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

          <label class="tk-field">
            <span class="tk-field-l">Product <span class="tk-req">*</span></span>
            <select class="ib-input" onchange="__leadCreateProductChange(this.value)"${dis}>
              ${_cre.producten ? _cre.producten.map(p => `<option value="${esc(p.slug)}" ${f.productSlug === p.slug ? 'selected' : ''}>${esc(p.naam)} (${p.duur_dagen || '?'} dagen)</option>`).join('') : '<option>Laden…</option>'}
            </select>
          </label>

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
    const q = (F('q', '') || '').trim();
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
    return `${previewHeader('Gearchiveerd (soft-delete via verwijderd_op)', _arc)}
      ${H.toolbar([H.search('Zoek naam / e-mail / telefoon…')])}
      <div class="sv-total">${_arc.loading ? 'Laden…' : (total != null ? `${total} gearchiveerd${total === 1 ? '' : 'e leads'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Traject', cls: 'optional' }, { l: 'Laatste status', cls: 'optional' }, { l: 'Aangemaakt', cls: 'r optional' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="ld-name">${esc(l.naam) || '—'}</a></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${esc(l.bron) || '—'}</span>`,
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
              <div class="sv-row"><span>Soort</span><b>${esc(l.soort) || '—'}</b></div>
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
              <div style="font-size:12.5px;color:var(--text-3);line-height:1.55">
                Deze acties zitten nog in de oude detail-page:
                <ul style="margin:8px 0 0 20px;padding:0;line-height:1.6">
                  <li>Archiveer / herstel</li>
                  <li>Omzetten naar klant</li>
                  <li>Uitgebreid bewerken (velden buiten status/notitie/eigenaar)</li>
                </ul>
              </div>
              <div style="margin-top:10px">
                <a class="btn btn-sm" href="/modules/leads-detail.html?id=${encodeURIComponent(l.id || '')}" target="_blank">${svg(I.settings)}Open oude detail-page ↗</a>
              </div>
            </div>
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
