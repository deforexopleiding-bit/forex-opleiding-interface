// modules/klanten-v2/views/tickets-v2.js
//
// Data-ronde 2 — Tickets v2. Live /api/tickets + volledige v2-detail-view +
// v2 create-modal. Blijft dormant (?v2preview=tickets).
//
// Endpoints (allemaal bestaand, uit tickets.html):
//   GET   /api/tickets?status&type&module           (lijst per tab)
//   POST  /api/tickets                              (create — v2-modal)
//   GET   /api/ticket-detail?id=<uuid>              (detail-view)
//   PATCH /api/ticket-detail?id=<uuid>              (status/assignee/etc)
//   POST  /api/ticket-comments                      (comment toevoegen)
//
// URL-state:
//   ?ticket=<uuid>     → open v2-detail voor dat ticket
//   ?ticket-new=1      → open v2-create-modal
// Zonder deze params: normale tab-lijst.

(function () {
  if (!window.DFO) { console.error('[tickets-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[tickets-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;

  const _open = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _wait = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _done = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _det  = { loading: false, error: null, data: null, seq: 0, id: null, saving: false, commentText: '', commentSubmitting: false };
  const _cre  = { submitting: false, form: { title: '', description: '', type: 'question', priority: 'medium', module: '' } };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[tickets-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  async function tryPost(label, url, body, timeoutMs = 12000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method: 'POST', body: JSON.stringify(body) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    if (!resp.ok) { console.warn('[tickets-v2] post fail:', label, '→', json?.error || resp.status); throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status); }
    return json;
  }

  async function tryPatch(label, url, body, timeoutMs = 12000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method: 'PATCH', body: JSON.stringify(body) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    if (!resp.ok) { console.warn('[tickets-v2] patch fail:', label, '→', json?.error || resp.status); throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status); }
    return json;
  }

  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
  const dstrShort = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
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

  const PRIO_TO_PILL = { low: ['neutral', 'Laag'], medium: ['info', 'Middel'], high: ['warn', 'Hoog'], urgent: ['warn', 'Urgent'] };
  const TYPE_TO_PILL = { bug: ['warn', 'Bug'], feature: ['info', 'Feature'], question: ['neutral', 'Vraag'], task: ['neutral', 'Taak'], incident: ['warn', 'Incident'] };
  const STATUS_TO_PILL = { open: ['warn', 'Open'], in_progress: ['info', 'In behandeling'], resolved: ['ok', 'Opgelost'], closed: ['neutral', 'Gesloten'] };

  function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }
  function setUrlParam(k, v) {
    try {
      const u = new URL(location.href);
      if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
      history.pushState({}, '', u.toString());
    } catch (_) { /* noop */ }
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  }

  window.__ticketNew   = () => setUrlParam('ticket-new', '1');
  window.__ticketOpen  = (id) => { if (id) setUrlParam('ticket', id); };
  window.__ticketBack  = () => { setUrlParam('ticket', null); };
  window.__ticketCloseCreate = () => { setUrlParam('ticket-new', null); };
  window.__ticketCreateInput = (field, val) => { _cre.form[field] = val; };

  window.__ticketCreateSubmit = async () => {
    if (_cre.submitting) return;
    const f = _cre.form;
    if (!f.title || !f.title.trim()) { alert('Titel is verplicht.'); return; }
    _cre.submitting = true;
    window.DFO.render();
    try {
      const result = await tryPost('tickets-create', '/api/tickets', {
        title: f.title.trim(),
        description: f.description || '',
        type: f.type || 'question',
        priority: f.priority || 'medium',
        module: f.module || null,
      });
      const newId = result?.ticket?.id;
      _cre.submitting = false;
      _cre.form = { title: '', description: '', type: 'question', priority: 'medium', module: '' };
      _open.data = null; _wait.data = null; _done.data = null;
      const u = new URL(location.href);
      u.searchParams.delete('ticket-new');
      if (newId) u.searchParams.set('ticket', newId);
      history.pushState({}, '', u.toString());
      window.DFO.render();
    } catch (e) {
      _cre.submitting = false;
      window.DFO.render();
      alert('Kon ticket niet aanmaken: ' + (e?.message || 'onbekende fout'));
    }
  };

  window.__ticketDetailPatch = async (field, val) => {
    if (_det.saving || !_det.id) return;
    _det.saving = true;
    window.DFO.render();
    try {
      const body = {}; body[field] = val;
      const result = await tryPatch('ticket-detail-patch', '/api/ticket-detail?id=' + encodeURIComponent(_det.id), body);
      if (result?.ticket) _det.data = { ..._det.data, ticket: result.ticket };
      _open.data = null; _wait.data = null; _done.data = null;
    } catch (e) {
      alert('Wijziging niet opgeslagen: ' + (e?.message || 'onbekende fout'));
    }
    _det.saving = false;
    window.DFO.render();
  };

  window.__ticketCommentInput = (val) => { _det.commentText = val; };
  window.__ticketCommentSubmit = async () => {
    if (_det.commentSubmitting || !_det.id) return;
    const body = (_det.commentText || '').trim();
    if (!body) { alert('Reactie is leeg.'); return; }
    _det.commentSubmitting = true;
    window.DFO.render();
    try {
      const result = await tryPost('ticket-comment', '/api/ticket-comments', { ticket_id: _det.id, body });
      if (result?.comment) {
        _det.data = { ..._det.data, comments: [...(_det.data?.comments || []), result.comment] };
      } else {
        _det.data = null;
      }
      _det.commentText = '';
    } catch (e) {
      alert('Reactie niet opgeslagen: ' + (e?.message || 'onbekende fout'));
    }
    _det.commentSubmitting = false;
    window.DFO.render();
  };

  function typeParam() { const t = F('tk-type', 'all'); return t === 'all' ? '' : '&type=' + encodeURIComponent(t); }

  async function fetchTab(state, statusList) {
    const wanted = statusList.join(',') + '|' + F('tk-type', 'all');
    if (state.loading && state.params === wanted) return;
    const seq = ++state.seq;
    state.loading = true; state.error = null; state.params = wanted;
    window.DFO.render();
    const calls = statusList.map(s => tryFetch('tickets:' + s, `/api/tickets?status=${s}${typeParam()}`));
    const results = await Promise.all(calls);
    if (seq !== state.seq) return;
    const firstCounts = results.find(r => r && r.counts)?.counts || null;
    const allTickets = results.flatMap(r => (r && Array.isArray(r.tickets)) ? r.tickets : []);
    state.data = { tickets: allTickets, counts: firstCounts };
    state.loading = false;
    if (results.every(r => r == null)) state.error = 'Kon tickets niet laden';
    window.DFO.render();
  }

  function toolbar() {
    const t = F('tk-type', 'all');
    return H.toolbar([
      H.chips('tk-type', [
        { l: 'Alle types', v: 'all' },
        { l: 'Bug',        v: 'bug' },
        { l: 'Feature',    v: 'feature' },
        { l: 'Vraag',      v: 'question' },
        { l: 'Taak',       v: 'task' },
      ], t),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__ticketNew()">${svg(I.plus)}Nieuw ticket</button></div>`,
    ]);
  }

  function ticketTable(items, loading, error) {
    if (!items.length && !loading) return `<div class="sv-empty">${error || 'Geen tickets in deze categorie.'}</div>`;
    return H.table(
      [{ l: 'Titel' }, { l: 'Type', cls: 'optional' }, { l: 'Module', cls: 'optional' }, { l: 'Prioriteit' }, { l: 'Aangemaakt door', cls: 'optional' }, { l: 'Toegewezen aan', cls: 'optional' }, { l: 'Datum', cls: 'r' }],
      items.map(t => {
        const [pc, pl] = PRIO_TO_PILL[t.priority] || ['neutral', t.priority || '—'];
        const [tc, tl] = TYPE_TO_PILL[t.type] || ['neutral', t.type || '—'];
        return [
          `<a href="javascript:__ticketOpen('${t.id}')" class="tk-title">${esc(t.title) || '—'}</a>`,
          H.pill(tc, tl),
          `<span style="font-size:12.5px;color:var(--text-3)">${esc(t.module) || '—'}</span>`,
          H.pill(pc, pl),
          `<span style="font-size:12.5px;color:var(--text-3)">${esc(t.created_by_name) || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${esc(t.assigned_to_name) || 'Niet toegewezen'}</span>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstrShort(t.created_at)}</span>`,
        ];
      })
    );
  }

  function kpiStrip(counts) {
    return H.kpis([
      { c: 'orange',  icon: I.warn,   label: 'Open',            val: num(counts?.open),          hi: 1 },
      { c: 'blue',    icon: I.repeat, label: 'Wacht op klant',  val: num(counts?.in_progress),          sub: 'in_progress in DB' },
      { c: 'emerald', icon: I.check,  label: 'Afgehandeld',     val: num((counts?.resolved || 0) + (counts?.closed || 0)), sub: 'resolved + closed' },
    ]);
  }

  function createModal() {
    const f = _cre.form;
    const disabled = _cre.submitting ? ' disabled' : '';
    return `<div class="tk-modal-back" onclick="if(event.target===this)__ticketCloseCreate()">
      <div class="tk-modal">
        <div class="tk-modal-head">
          <div class="tk-modal-title">Nieuw ticket</div>
          <button class="icon-btn" onclick="__ticketCloseCreate()" title="Sluiten (Esc)">${svg(I.x || I.warn)}</button>
        </div>
        <div class="tk-modal-body">
          <label class="tk-field">
            <span class="tk-field-l">Titel <span class="tk-req">*</span></span>
            <input class="ib-input" placeholder="Korte beschrijving van het probleem…" value="${esc(f.title)}" oninput="__ticketCreateInput('title', this.value)"${disabled}>
          </label>
          <label class="tk-field">
            <span class="tk-field-l">Omschrijving</span>
            <textarea class="ib-input tk-textarea" rows="5" placeholder="Wat is er gebeurd? Wat verwachtte je?" oninput="__ticketCreateInput('description', this.value)"${disabled}>${esc(f.description)}</textarea>
          </label>
          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Type</span>
              <select class="ib-input" onchange="__ticketCreateInput('type', this.value)"${disabled}>
                <option value="question" ${f.type === 'question' ? 'selected' : ''}>Vraag</option>
                <option value="bug"      ${f.type === 'bug' ? 'selected' : ''}>Bug</option>
                <option value="feature"  ${f.type === 'feature' ? 'selected' : ''}>Feature</option>
                <option value="task"     ${f.type === 'task' ? 'selected' : ''}>Taak</option>
              </select>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Prioriteit</span>
              <select class="ib-input" onchange="__ticketCreateInput('priority', this.value)"${disabled}>
                <option value="low"    ${f.priority === 'low' ? 'selected' : ''}>Laag</option>
                <option value="medium" ${f.priority === 'medium' ? 'selected' : ''}>Middel</option>
                <option value="high"   ${f.priority === 'high' ? 'selected' : ''}>Hoog</option>
                <option value="urgent" ${f.priority === 'urgent' ? 'selected' : ''}>Urgent</option>
              </select>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Module (optioneel)</span>
              <input class="ib-input" placeholder="bv. finance, sales, klanten" value="${esc(f.module)}" oninput="__ticketCreateInput('module', this.value)"${disabled}>
            </label>
          </div>
        </div>
        <div class="tk-modal-foot">
          <button class="btn" onclick="__ticketCloseCreate()"${disabled}>Annuleren</button>
          <button class="btn btn-primary" onclick="__ticketCreateSubmit()"${disabled}>
            ${_cre.submitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.check || I.plus) + 'Ticket aanmaken'}
          </button>
        </div>
      </div>
    </div>`;
  }

  async function fetchDetail(id) {
    if (_det.loading && _det.id === id) return;
    const seq = ++_det.seq;
    _det.loading = true; _det.error = null; _det.id = id;
    window.DFO.render();
    const data = await tryFetch('ticket-detail', '/api/ticket-detail?id=' + encodeURIComponent(id));
    if (seq !== _det.seq) return;
    _det.data = data;
    _det.loading = false;
    if (!data) _det.error = 'Kon ticket-detail niet laden';
    window.DFO.render();
  }

  function detailView() {
    const id = urlParam('ticket');
    if (!id) return '';
    if (!_det.loading && (!_det.data || _det.id !== id)) queueMicrotask(() => fetchDetail(id));
    const d = _det.data || {};
    const t = d.ticket || {};
    const comments = Array.isArray(d.comments) ? d.comments : [];
    const assignees = Array.isArray(d.assignees) ? d.assignees : [];
    const [pc, pl] = PRIO_TO_PILL[t.priority] || ['neutral', t.priority || '—'];
    const [tc, tl] = TYPE_TO_PILL[t.type] || ['neutral', t.type || '—'];
    const [sc, sl] = STATUS_TO_PILL[t.status] || ['neutral', t.status || '—'];
    return `${previewHeader('Ticket-detail · live', _det)}
      <div class="tk-det-head">
        <button class="btn" onclick="__ticketBack()">← Terug naar lijst</button>
        <div class="tk-det-title">${esc(t.title) || (_det.loading ? 'Laden…' : '—')}</div>
        <div class="tk-det-meta">
          ${H.pill(sc, sl)} ${H.pill(pc, pl)} ${H.pill(tc, tl)}
          ${t.module ? `<span class="pill pill-neutral">${esc(t.module)}</span>` : ''}
        </div>
      </div>
      <div class="tk-det-grid">
        <div class="tk-det-main">
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.doc)}Omschrijving</div>
            <div class="sv-card-body">
              <div class="tk-det-desc">${t.description ? esc(t.description).replace(/\n/g, '<br>') : '<em style="color:var(--text-3)">Geen omschrijving.</em>'}</div>
            </div>
          </div>
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.mail)}Reacties · ${num(comments.length)}</div>
            <div class="sv-card-body">
              ${comments.length ? comments.map(c => `
                <div class="tk-comment">
                  <div class="tk-comment-head">
                    <div class="av av-sm">${H.av(c.author_name || '?')}</div>
                    <div class="tk-comment-who">${esc(c.author_name) || '—'}</div>
                    <div class="tk-comment-time">${dstr(c.created_at)}</div>
                  </div>
                  <div class="tk-comment-body">${esc(c.body).replace(/\n/g, '<br>')}</div>
                </div>
              `).join('') : `<div class="sv-empty" style="padding:24px 6px">${_det.loading ? 'Laden…' : 'Nog geen reacties.'}</div>`}
              <div class="tk-comment-form">
                <textarea class="ib-input tk-textarea" id="tt-comment-input" rows="3" placeholder="Schrijf een reactie…" oninput="__ticketCommentInput(this.value)"></textarea>
                <div class="tk-comment-form-foot">
                  <button class="btn btn-primary" onclick="__ticketCommentSubmit()" ${_det.commentSubmitting ? 'disabled' : ''}>
                    ${_det.commentSubmitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.send || I.plus) + 'Verstuur reactie'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="tk-det-side">
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.settings)}Ticket-info</div>
            <div class="sv-card-body">
              <div class="sv-row"><span>Aangemaakt door</span><b>${esc(t.created_by_name) || '—'}</b></div>
              <div class="sv-row"><span>Aangemaakt op</span><b>${dstrShort(t.created_at)}</b></div>
              ${t.resolved_at ? `<div class="sv-row"><span>Opgelost op</span><b>${dstrShort(t.resolved_at)}</b></div>` : ''}
              <div class="sv-row"><span>Ticket-ID</span><b class="mono" style="font-size:11px">${esc(String(t.id || '').slice(0, 8))}…</b></div>
            </div>
          </div>
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.check)}Status wijzigen</div>
            <div class="sv-card-body">
              <select class="ib-input" onchange="__ticketDetailPatch('status', this.value)" ${_det.saving ? 'disabled' : ''}>
                <option value="open"        ${t.status === 'open' ? 'selected' : ''}>Open</option>
                <option value="in_progress" ${t.status === 'in_progress' ? 'selected' : ''}>In behandeling / Wacht op klant</option>
                <option value="resolved"    ${t.status === 'resolved' ? 'selected' : ''}>Opgelost</option>
                <option value="closed"      ${t.status === 'closed' ? 'selected' : ''}>Gesloten</option>
              </select>
            </div>
          </div>
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.users)}Toegewezen aan</div>
            <div class="sv-card-body">
              ${assignees.length ? `
                <select class="ib-input" onchange="__ticketDetailPatch('assigned_to', this.value || null)" ${_det.saving ? 'disabled' : ''}>
                  <option value="">— Niet toegewezen —</option>
                  ${assignees.map(a => `<option value="${a.id}" ${t.assigned_to === a.id ? 'selected' : ''}>${esc(a.name)}${a.role ? ' · ' + esc(a.role) : ''}</option>`).join('')}
                </select>
              ` : `<div style="font-size:12.5px;color:var(--text-3)">${_det.loading ? 'Laden…' : 'Geen assignees beschikbaar.'}</div>`}
            </div>
          </div>
          <div class="sv-card">
            <div class="sv-card-head">${svg(I.doc)}Bijlagen</div>
            <div class="sv-card-body">
              ${(d.attachments || []).length ? d.attachments.map(a => `
                <div class="sv-row"><span>${esc(a.name || a.file_name || '—')}</span><b style="font-size:11px;color:var(--text-3)">${a.size ? Math.round(a.size / 1024) + ' kB' : ''}</b></div>
              `).join('') : `<div style="font-size:12.5px;color:var(--text-3)">${_det.loading ? 'Laden…' : 'Geen bijlagen. Upload nog niet in v2 — gebruik oude tickets-detail.html voor uploads.'}</div>`}
            </div>
          </div>
        </div>
      </div>`;
  }

  function wrapView(fn) {
    return () => {
      if (urlParam('ticket')) return detailView();
      if (_det.id != null) { _det.id = null; _det.data = null; _det.error = null; }
      const listHtml = fn();
      const overlay = urlParam('ticket-new') === '1' ? createModal() : '';
      return listHtml + overlay;
    };
  }

  function openView() {
    if (!_open.loading && (!_open.data || _open.params !== ('open|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_open, ['open']));
    const items = _open.data?.tickets || [];
    return `${previewHeader('Open', _open)}
      ${kpiStrip(_open.data?.counts)}
      ${toolbar()}
      ${ticketTable(items, _open.loading, _open.error)}`;
  }
  function waitView() {
    if (!_wait.loading && (!_wait.data || _wait.params !== ('in_progress|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_wait, ['in_progress']));
    const items = _wait.data?.tickets || [];
    return `${previewHeader('Wacht op klant · maps naar status=in_progress', _wait)}
      ${kpiStrip(_wait.data?.counts)}
      ${toolbar()}
      ${ticketTable(items, _wait.loading, _wait.error)}`;
  }
  function doneView() {
    if (!_done.loading && (!_done.data || _done.params !== ('resolved,closed|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_done, ['resolved', 'closed']));
    const items = _done.data?.tickets || [];
    return `${previewHeader('Afgehandeld · resolved + closed samengevoegd', _done)}
      ${kpiStrip(_done.data?.counts)}
      ${toolbar()}
      ${ticketTable(items, _done.loading, _done.error)}`;
  }

  window.DFO.VIEWS['tickets/Open']           = wrapView(openView);
  window.DFO.VIEWS['tickets/Wacht op klant'] = wrapView(waitView);
  window.DFO.VIEWS['tickets/Afgehandeld']    = wrapView(doneView);

  window.addEventListener('popstate', () => {
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (urlParam('ticket-new') === '1') { e.preventDefault(); window.__ticketCloseCreate(); }
    else if (urlParam('ticket'))         { e.preventDefault(); window.__ticketBack(); }
  });

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('tickets');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('tickets');
  console.debug('[tickets-v2] registered 3 views + detail + create-modal (data-ronde 2)');
})();
