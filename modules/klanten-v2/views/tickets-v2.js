// modules/klanten-v2/views/tickets-v2.js
//
// Data-ronde 2 + Ronde 3-fixes — Tickets v2. Live /api/tickets + volledige
// v2-detail-view + v2 create-modal. Blijft dormant (?v2preview=tickets).
// Ronde 3-fixes: modal-CSS (recidive .fn-modal-back-bug), titel-styling
// rustiger, en video/link-embed voor YouTube / Vimeo / Loom / Drive.
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
  // Ronde 4: priority values matchen VALID_PRIORITIES in api/tickets.js
  // (laag/middel/hoog, lowercase Dutch). Type values matchen VALID_TYPES
  // (bug/feature/question). Eerder gebruikt: low/medium/high/urgent + task
  // — dat faalde met 400 "Ongeldige priority" / "Ongeldig type" bij POST.
  // Ronde 5: pendingFiles = File[] die pas na ticket-create worden geüpload.
  // Ronde 3-fixes: pendingUrls = string[] van video/link-URLs die als
  //   external_url attachment worden opgeslagen na ticket-create.
  const _cre  = { submitting: false, uploading: false, form: { title: '', description: '', type: 'question', priority: 'middel', module: '' }, pendingFiles: [], pendingUrls: [], newUrl: '' };
  // Ronde 5: attachment-state voor detail-view (uploading + signed-url cache).
  // Ronde 3-fixes: newUrl = input voor detail-view video/link-URL toevoegen.
  const _att = { uploading: false, signedUrls: new Map(), newUrl: '', urlSubmitting: false };
  const ATTACH_BUCKET = 'tickets-attachments';
  const ATTACH_MAX_MB = 20;
  const ATTACH_SIGNED_TTL = 3600;

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

  // Preview-mode badge — VERWIJDERD (2026-08-11, consistent met sales-v2 +
  // leads-v2 + finance-v2). Signature behouden.
  function previewHeader(_label, _state) { return ''; }

  // Ronde 4: keys matchen VALID_PRIORITIES / VALID_TYPES in api/tickets.js.
  // Aliases voor legacy waarden (low/medium/high) laten we vallen — DB
  // heeft geen legacy waarden, backend accepteert alleen deze set.
  const PRIO_TO_PILL = { laag: ['neutral', 'Laag'], middel: ['info', 'Middel'], hoog: ['warn', 'Hoog'] };
  const TYPE_TO_PILL = { bug: ['warn', 'Bug'], feature: ['info', 'Feature'], question: ['neutral', 'Vraag'] };
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
  window.__ticketCloseCreate = () => { setUrlParam('ticket-new', null); _cre.pendingFiles = []; _cre.pendingUrls = []; _cre.newUrl = ''; };
  window.__ticketCreateInput = (field, val) => { _cre.form[field] = val; };

  // ── Ronde 5: attachment-helpers ─────────────────────────────────────
  // 1) uploadAttachment(file, ticketId): upload naar tickets-attachments
  //    bucket (per-user prefix) + POST /api/ticket-attachments met
  //    storage_path + filename + mime_type. Returnt attachment-row of null.
  // 2) getSignedUrl(path): 1u signed URL uit bucket, gecached in module-map.
  // 3) Bucket-RLS: path MOET beginnen met <user.id>/<ticket_id>/ zodat
  //    andere gebruikers niet uploaden onder jouw naam.
  function cleanFilename(name) {
    const dot = name.lastIndexOf('.');
    const base = (dot >= 0 ? name.slice(0, dot) : name).toLowerCase()
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bijlage';
    const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
    return base.slice(0, 80) + ext.slice(0, 10);
  }
  async function uploadAttachment(file, ticketId) {
    if (!file || !ticketId) return null;
    if (!window.supabase || !window.supabase.storage) {
      console.warn('[tickets-v2] window.supabase.storage niet beschikbaar');
      return null;
    }
    if (file.size > ATTACH_MAX_MB * 1024 * 1024) {
      alert(`Bestand "${file.name}" te groot (max ${ATTACH_MAX_MB} MB).`);
      return null;
    }
    try {
      const { data: { user }, error: uErr } = await window.supabase.auth.getUser();
      if (uErr || !user) throw new Error('Auth-fout bij upload');
      const path = `${user.id}/${ticketId}/${Date.now()}-${cleanFilename(file.name || 'bijlage')}`;
      const { error: upErr } = await window.supabase.storage
        .from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (upErr) throw new Error('Storage: ' + upErr.message);
      const json = await tryPost('ticket-attachment-create', '/api/ticket-attachments', {
        ticket_id: ticketId,
        storage_path: path,
        filename: file.name || null,
        mime_type: file.type || null,
      });
      return json?.attachment || null;
    } catch (e) {
      console.warn('[tickets-v2] uploadAttachment fail:', e?.message);
      // Best-effort cleanup als DB-insert faalde na storage-upload — geen
      // rollback als storage-upload zelf faalde (dan bestaat 'path' niet).
      alert('Bijlage-upload mislukt: ' + (e?.message || 'onbekende fout'));
      return null;
    }
  }
  async function getSignedUrl(path) {
    if (!path) return null;
    if (_att.signedUrls.has(path)) return _att.signedUrls.get(path);
    if (!window.supabase?.storage) return null;
    try {
      const { data, error } = await window.supabase.storage
        .from(ATTACH_BUCKET)
        .createSignedUrl(path, ATTACH_SIGNED_TTL);
      if (error || !data?.signedUrl) return null;
      _att.signedUrls.set(path, data.signedUrl);
      return data.signedUrl;
    } catch (_) { return null; }
  }
  const isImage = (mime) => typeof mime === 'string' && mime.startsWith('image/');

  // ── Ronde 3-fixes: video/link-URL detectie (1-op-1 uit v1 tickets-detail).
  // Returnt { kind: 'iframe'|'link', src, label?, domain } of null als leeg.
  // Detecteert Loom / YouTube (watch/youtu.be/embed) / Vimeo / Google Drive.
  // Fallback: gewone link met alleen domain-label.
  function detectEmbed(url) {
    if (!url) return null;
    const u = String(url).trim();
    if (!u) return null;
    let m;
    if ((m = u.match(/loom\.com\/share\/([a-f0-9]+)/i))) {
      return { kind: 'iframe', src: `https://www.loom.com/embed/${m[1]}`, label: 'Loom video', domain: 'loom.com' };
    }
    if ((m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/i))) {
      return { kind: 'iframe', src: `https://www.youtube.com/embed/${m[1]}`, label: 'YouTube video', domain: 'youtube.com' };
    }
    if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) {
      return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}`, label: 'Vimeo video', domain: 'vimeo.com' };
    }
    if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/i))) {
      return { kind: 'iframe', src: `https://drive.google.com/file/d/${m[1]}/preview`, label: 'Drive bestand', domain: 'drive.google.com' };
    }
    let domain = '';
    try { domain = new URL(u).hostname.replace(/^www\./, ''); } catch (_) { /* geen valid URL */ }
    return { kind: 'link', src: u, label: domain || u, domain };
  }
  function isValidHttpUrl(u) {
    if (!u || typeof u !== 'string') return false;
    try {
      const parsed = new URL(u.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_) { return false; }
  }

  window.__ticketCreatePickFiles = (input) => {
    const files = Array.from(input.files || []);
    _cre.pendingFiles = _cre.pendingFiles.concat(files);
    input.value = '';
    window.DFO.render();
  };
  window.__ticketCreateRemovePending = (idx) => {
    _cre.pendingFiles.splice(idx, 1);
    window.DFO.render();
  };
  // Ronde 3-fixes: URL-lijst voor video/link-bijlagen in create-modal.
  window.__ticketCreateUrlInput = (val) => { _cre.newUrl = val; };
  window.__ticketCreateAddUrl = () => {
    const raw = (_cre.newUrl || '').trim();
    if (!raw) return;
    if (!isValidHttpUrl(raw)) { alert('Ongeldige URL (moet beginnen met http:// of https://).'); return; }
    _cre.pendingUrls.push(raw);
    _cre.newUrl = '';
    window.DFO.render();
  };
  window.__ticketCreateRemoveUrl = (idx) => {
    _cre.pendingUrls.splice(idx, 1);
    window.DFO.render();
  };
  // Detail-view: paste-and-save URL flow (POST /api/ticket-attachments met external_url).
  window.__ticketDetailUrlInput = (val) => { _att.newUrl = val; };
  window.__ticketDetailAddUrl = async () => {
    if (_att.urlSubmitting || !_det.id) return;
    const raw = (_att.newUrl || '').trim();
    if (!raw) return;
    if (!isValidHttpUrl(raw)) { alert('Ongeldige URL (moet beginnen met http:// of https://).'); return; }
    _att.urlSubmitting = true; window.DFO.render();
    try {
      const j = await tryPost('ticket-attachment-url', '/api/ticket-attachments', {
        ticket_id: _det.id,
        external_url: raw,
      });
      if (j?.attachment) {
        _det.data = _det.data || { ticket: {}, attachments: [] };
        _det.data.attachments = (_det.data.attachments || []).concat(j.attachment);
      }
      _att.newUrl = '';
    } catch (e) {
      alert('URL niet opgeslagen: ' + (e?.message || 'onbekende fout'));
    }
    _att.urlSubmitting = false;
    window.DFO.render();
  };
  window.__ticketDetailPickFiles = async (input) => {
    if (!_det.id) return;
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    _att.uploading = true; window.DFO.render();
    for (const f of files) {
      const att = await uploadAttachment(f, _det.id);
      if (att) {
        _det.data = _det.data || { ticket: {}, attachments: [] };
        _det.data.attachments = (_det.data.attachments || []).concat(att);
      }
    }
    _att.uploading = false;
    window.DFO.render();
  };
  window.__ticketAttDelete = async (attId) => {
    if (!attId) return;
    if (!confirm('Bijlage verwijderen?')) return;
    try {
      if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
      const resp = await window.KV.authedFetch('/api/ticket-attachments?id=' + encodeURIComponent(attId), { method: 'DELETE' });
      if (!resp.ok && resp.status !== 204) {
        const t = await resp.text();
        const j = t ? (function(){ try { return JSON.parse(t); } catch { return null; } })() : null;
        throw new Error(j?.error || 'HTTP ' + resp.status);
      }
      if (_det.data) _det.data.attachments = (_det.data.attachments || []).filter(a => a.id !== attId);
      window.DFO.render();
    } catch (e) {
      alert('Verwijderen mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };
  window.__ticketAttOpen = async (path) => {
    const url = await getSignedUrl(path);
    if (url) window.open(url, '_blank', 'noopener');
    else alert('Kon bijlage-URL niet ophalen.');
  };
  // Post-render: laad signed-URLs voor <img data-att-path=...>-nodes lazy.
  function hydrateAttachmentImages() {
    document.querySelectorAll('img[data-att-path]:not([src])').forEach(async (img) => {
      const p = img.getAttribute('data-att-path');
      const url = await getSignedUrl(p);
      if (url) img.src = url;
    });
  }
  // Hook aan DFO.render — één keer patchen zodat 'ie na elke render draait.
  (function patchRenderForAttImages() {
    if (!window.DFO || typeof window.DFO.render !== 'function') { setTimeout(patchRenderForAttImages, 40); return; }
    if (window.DFO.__ticketsAttImagesPatched) return;
    window.DFO.__ticketsAttImagesPatched = true;
    const orig = window.DFO.render;
    window.DFO.render = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(hydrateAttachmentImages);
      return r;
    };
  })();

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
        priority: f.priority || 'middel',
        module: f.module || null,
      });
      const newId = result?.ticket?.id;
      // Ronde 5: batch-upload van pending attachments NA ticket-create.
      // Faalt best-effort per file zodat één corrupte upload de andere
      // niet blokkeert. Rapporteert alleen via alert bij failures.
      if (newId && _cre.pendingFiles.length) {
        _cre.uploading = true; window.DFO.render();
        for (const f of _cre.pendingFiles) {
          await uploadAttachment(f, newId);
        }
        _cre.uploading = false;
      }
      // Ronde 3-fixes: pending video/link-URLs als external_url attachments.
      if (newId && _cre.pendingUrls.length) {
        for (const raw of _cre.pendingUrls) {
          try {
            await tryPost('ticket-attachment-url', '/api/ticket-attachments', {
              ticket_id: newId, external_url: raw,
            });
          } catch (e) { console.warn('[tickets-v2] url-attach fail:', e?.message); }
        }
      }
      _cre.submitting = false;
      _cre.form = { title: '', description: '', type: 'question', priority: 'middel', module: '' };
      _cre.pendingFiles = [];
      _cre.pendingUrls = [];
      _cre.newUrl = '';
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
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
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
      ], t),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__ticketNew()">${svg(I.plus)}Nieuw ticket</button></div>`,
    ]);
  }

  // MODS-lijst uit DFO voor de Module-select in create-modal. Fallback
  // op hard-coded lijst als DFO.MODS niet exposed is (defensief).
  function moduleOptions(current) {
    const mods = Array.isArray(window.DFO?.MODS) ? window.DFO.MODS : [];
    const list = mods.length
      ? mods.map(m => ({ id: m.id, naam: m.naam }))
      : [
          { id: 'dashboard', naam: 'Dashboard' }, { id: 'inbox', naam: 'Inbox' },
          { id: 'taken', naam: 'Takenbeheer' }, { id: 'klanten', naam: 'Klanten' },
          { id: 'wanbetalers', naam: 'Wanbetalers' }, { id: 'email', naam: 'E-mail' },
          { id: 'tickets', naam: 'Tickets' }, { id: 'followup', naam: 'Follow-up' },
          { id: 'sales', naam: 'Sales' }, { id: 'finance', naam: 'Finance' },
          { id: 'events', naam: 'Events' }, { id: 'onboarding', naam: 'Onboarding' },
          { id: 'mentoren', naam: 'Mentoren' }, { id: 'leads', naam: 'Leads' },
          { id: 'nieuwsbrief', naam: 'Nieuwsbrief' }, { id: 'lisa', naam: 'Lisa' },
          { id: 'automatiseringen', naam: 'Automatiseringen' },
          { id: 'agents', naam: 'AI Agents' }, { id: 'logboek', naam: 'Toegangslog' },
          { id: 'instellingen', naam: 'Instellingen' },
        ];
    const opts = ['<option value="">— geen —</option>']
      .concat(list.map(m => `<option value="${m.id}" ${current === m.id ? 'selected' : ''}>${m.naam}</option>`));
    return opts.join('');
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
              </select>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Prioriteit</span>
              <select class="ib-input" onchange="__ticketCreateInput('priority', this.value)"${disabled}>
                <option value="laag"   ${f.priority === 'laag'   ? 'selected' : ''}>Laag</option>
                <option value="middel" ${f.priority === 'middel' ? 'selected' : ''}>Middel</option>
                <option value="hoog"   ${f.priority === 'hoog'   ? 'selected' : ''}>Hoog</option>
              </select>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Module (optioneel)</span>
              <select class="ib-input" onchange="__ticketCreateInput('module', this.value)"${disabled}>
                ${moduleOptions(f.module)}
              </select>
            </label>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Bijlagen (optioneel)</span>
            <div class="tk-att-pending">
              ${_cre.pendingFiles.length ? `<div class="tk-att-pending-list">
                ${_cre.pendingFiles.map((f, i) => `
                  <div class="tk-att-pending-item">
                    ${svg(I.doc)}
                    <span class="tk-att-pending-name">${esc(f.name || 'bestand')}</span>
                    <span class="tk-att-pending-size">${(f.size / 1024 < 1024) ? (Math.round(f.size / 1024) + ' KB') : ((f.size / 1024 / 1024).toFixed(1) + ' MB')}</span>
                    <button class="icon-btn" onclick="__ticketCreateRemovePending(${i})" title="Verwijder">${svg(I.x || I.warn)}</button>
                  </div>
                `).join('')}
              </div>` : ''}
              <label class="tk-att-picker">
                <input type="file" multiple accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx" onchange="__ticketCreatePickFiles(this)"${disabled} style="display:none">
                <span class="btn btn-sm">${svg(I.plus)}Bestand/foto/video toevoegen</span>
              </label>
              <div class="tk-att-hint">Afbeeldingen, video's, PDF's, Office-bestanden. Max ${ATTACH_MAX_MB} MB per bestand. Upload gebeurt na aanmaken.</div>
            </div>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Video / link (YouTube · Vimeo · Loom · Drive · andere URL)</span>
            ${_cre.pendingUrls.length ? `<div class="tk-att-links">
              ${_cre.pendingUrls.map((u, i) => {
                const e = detectEmbed(u);
                const domain = e?.domain || '';
                return `<div class="tk-att-link-item">
                  ${svg(I.mail || I.doc)}
                  <span class="tk-att-link-url" title="${esc(u)}">${esc(u)}</span>
                  ${domain ? `<span class="tk-att-file-mime">${esc(domain)}</span>` : ''}
                  <button class="icon-btn" onclick="__ticketCreateRemoveUrl(${i})" title="Verwijder">${svg(I.x || I.warn)}</button>
                </div>`;
              }).join('')}
            </div>` : ''}
            <div class="tk-att-link-add">
              <input class="ib-input" type="url" placeholder="https://youtu.be/… of https://www.loom.com/share/…"
                value="${esc(_cre.newUrl)}"
                oninput="__ticketCreateUrlInput(this.value)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();__ticketCreateAddUrl()}"${disabled}>
              <button class="btn btn-sm" onclick="__ticketCreateAddUrl()"${disabled}>${svg(I.plus)}Toevoegen</button>
            </div>
            <div class="tk-att-hint">Video's uit YouTube / Vimeo / Loom / Google Drive worden als embed getoond. Andere URLs krijgen een klikbare kaart.</div>
          </div>
        </div>
        <div class="tk-modal-foot">
          <button class="btn" onclick="__ticketCloseCreate()"${disabled}>Annuleren</button>
          <button class="btn btn-primary" onclick="__ticketCreateSubmit()"${disabled}>
            ${_cre.uploading ? svg(I.clock || I.settings) + `Uploaden (${_cre.pendingFiles.length})…`
              : _cre.submitting ? svg(I.clock || I.settings) + 'Bezig…'
              : svg(I.check || I.plus) + 'Ticket aanmaken' + (_cre.pendingFiles.length ? ` (+${_cre.pendingFiles.length})` : '')}
          </button>
        </div>
      </div>
    </div>`;
  }

  // Ronde 5 + Ronde 3-fixes: attachments-card voor detail-view.
  // Images tonen als thumbnail (lazy signed-URL fetch via hydrateAttachmentImages
  // post-render), niet-images als file-link met open-in-tab (ook signed-URL).
  // external_url attachments met bekende video-host (YouTube/Vimeo/Loom/Drive)
  // renderen als iframe-embed (16:9 responsive), andere URLs als link-kaart.
  function renderAttachmentsCard(attachments) {
    const images = attachments.filter(a => a.storage_path && isImage(a.mime_type));
    const files  = attachments.filter(a => a.storage_path && !isImage(a.mime_type));
    const links  = attachments.filter(a => a.external_url);
    return `<div class="sv-card">
      <div class="sv-card-head">${svg(I.doc)}Bijlagen · ${num(attachments.length)}</div>
      <div class="sv-card-body">
        ${images.length ? `<div class="tk-att-grid">
          ${images.map(a => `<div class="tk-att-img-card" onclick="__ticketAttOpen('${esc(a.storage_path)}')">
            <img data-att-path="${esc(a.storage_path)}" alt="${esc(a.filename || 'bijlage')}" class="tk-att-img"/>
            <div class="tk-att-meta">${esc(a.filename || 'bijlage')}</div>
            <button class="tk-att-del" onclick="event.stopPropagation();__ticketAttDelete('${a.id}')" title="Verwijder">×</button>
          </div>`).join('')}
        </div>` : ''}
        ${files.length ? `<div class="tk-att-files">
          ${files.map(a => `<div class="tk-att-file-row">
            ${svg(I.doc)}
            <a href="#" onclick="event.preventDefault();__ticketAttOpen('${esc(a.storage_path)}')" class="tk-att-file-name">${esc(a.filename || (a.storage_path || '').split('/').pop() || 'bestand')}</a>
            <span class="tk-att-file-mime">${esc(a.mime_type || '')}</span>
            <button class="icon-btn" onclick="__ticketAttDelete('${a.id}')" title="Verwijder">${svg(I.x || I.warn)}</button>
          </div>`).join('')}
        </div>` : ''}
        ${links.length ? `<div class="tk-embed-wrap">
          ${links.map(a => {
            const e = detectEmbed(a.external_url);
            const body = (e && e.kind === 'iframe')
              ? `<div class="tk-embed-card"><iframe src="${esc(e.src)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe></div>`
              : `<a class="tk-embed-link" href="${esc(a.external_url)}" target="_blank" rel="noopener">
                   ${svg(I.mail || I.doc)}
                   <span class="tk-embed-link-name">${esc(a.filename || (e && e.label) || a.external_url)}</span>
                   <span class="tk-embed-link-domain">${esc((e && e.domain) || '')}</span>
                 </a>`;
            return `<div class="tk-embed-row">
              <div class="tk-embed-body">${body}</div>
              <button class="icon-btn" onclick="__ticketAttDelete('${a.id}')" title="Verwijder">${svg(I.x || I.warn)}</button>
            </div>`;
          }).join('')}
        </div>` : ''}
        ${!attachments.length ? `<div class="sv-empty" style="padding:14px 6px">Nog geen bijlagen.</div>` : ''}
        <label class="tk-att-picker" style="margin-top:12px">
          <input type="file" multiple accept="image/*,video/*,application/pdf,.doc,.docx,.xls,.xlsx" onchange="__ticketDetailPickFiles(this)" ${_att.uploading ? 'disabled' : ''} style="display:none">
          <span class="btn btn-sm">${_att.uploading ? svg(I.clock || I.settings) + 'Uploaden…' : svg(I.plus) + 'Bestand/foto/video toevoegen'}</span>
        </label>
        <div class="tk-att-link-add">
          <input class="ib-input" type="url" placeholder="Plak YouTube / Vimeo / Loom / Drive-link…"
            value="${esc(_att.newUrl)}"
            oninput="__ticketDetailUrlInput(this.value)"
            onkeydown="if(event.key==='Enter'){event.preventDefault();__ticketDetailAddUrl()}"
            ${_att.urlSubmitting ? 'disabled' : ''}>
          <button class="btn btn-sm" onclick="__ticketDetailAddUrl()" ${_att.urlSubmitting ? 'disabled' : ''}>
            ${_att.urlSubmitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.plus) + 'Toevoegen'}
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
    if (!_det.loading && !_det.error && (!_det.data || _det.id !== id)) queueMicrotask(() => fetchDetail(id));
    const d = _det.data || {};
    const t = d.ticket || {};
    const comments = Array.isArray(d.comments) ? d.comments : [];
    // STAFF_ROLES-filter: /api/ticket-detail's `assignees`-lijst komt direct
    // uit `profiles WHERE is_active=true` (ticket-detail.js:57-60) → bevat
    // ook klant/student-accounts. Assignee-picker toont alleen interne staf.
    // Zelfde set als taken-modals (super_admin/manager/sales/mentor/marketing).
    const STAFF_ROLES_TK = new Set(['super_admin', 'manager', 'sales', 'mentor', 'marketing']);
    const assignees = (Array.isArray(d.assignees) ? d.assignees : [])
      .filter((a) => STAFF_ROLES_TK.has(String(a?.role || '').toLowerCase()));
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
          ${renderAttachmentsCard(Array.isArray(d.attachments) ? d.attachments : [])}
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
        </div>
      </div>`;
  }

  // ── Kanban-integratie (uit #1271, op ronde-4 basis herbouwd) ─────────
  // View-toggle Lijst ↔ Pipeline op elke tab. In pipeline-mode wordt de
  // status-tab-filtered lijst vervangen door één kanban die de 4 echte
  // ticket-statussen toont (matcht VALID_STATUSES in api/tickets.js).
  // Drag-drop → PATCH /api/ticket-detail?id=X {status:new} en re-fetch
  // van de actieve tab. Best-effort (geen optimistic update); bij fail
  // console.warn — geen rollback want de refetch corrigeert visueel.
  const TICKET_KANBAN_STATUSES = [
    { key: 'open',        label: 'Open',            color: 'rose'    },
    { key: 'in_progress', label: 'In behandeling',  color: 'amber'   },
    { key: 'resolved',    label: 'Opgelost',        color: 'emerald' },
    { key: 'closed',      label: 'Gesloten',        color: 'slate'   },
  ];
  function _allTicketItems() {
    // Combineer de 3 tab-fetches. Bij eerste render zijn de meeste _*.data
    // nog null → kanban is leeg tot fetches klaar zijn.
    const a = _open.data?.tickets || [];
    const b = _wait.data?.tickets || [];
    const c = _done.data?.tickets || [];
    // De-dup op id (dezelfde ticket kan technisch niet in 2 status-buckets
    // maar defensief blijven we correct bij race-conditions).
    const seen = new Set();
    const out = [];
    for (const t of a.concat(b, c)) {
      if (!t || !t.id || seen.has(t.id)) continue;
      seen.add(t.id); out.push(t);
    }
    return out;
  }
  if (window.KV_V2 && window.KV_V2.kanban) {
    window.KV_V2.kanban.register('tickets', {
      statuses: TICKET_KANBAN_STATUSES,
      getItems: _allTicketItems,
      statusOf: (t) => t.status || 'open',
      itemId: (t) => t.id,
      renderCard: (t) => {
        const prio = PRIO_TO_PILL[t.priority] || ['neutral', t.priority || '—'];
        return `
          <div class="kv-kanban-card-title">${esc(t.title || '(geen titel)')}</div>
          <div class="kv-kanban-card-sub">
            <span class="mono">#${String(t.id).slice(0, 8)}</span>${t.module ? ' · ' + esc(t.module) : ''}
          </div>
          <div class="kv-kanban-card-foot">
            ${H.pill(prio[0], prio[1])}
            <span style="margin-left:auto">${esc(t.assignee_name || t.assigned_to || '—')}</span>
          </div>`;
      },
      onMove: async (id, newStatus) => {
        try {
          await tryPatch('ticket-status', '/api/ticket-detail?id=' + encodeURIComponent(id), { status: newStatus });
          // Force refetch alle 3 tabs (invalidate params).
          _open.params = ''; _wait.params = ''; _done.params = '';
          if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
        } catch (e) {
          console.warn('[tickets-v2 kanban] status-update fail:', e?.message);
          // Rollback via refetch (data van server wint).
          _open.params = ''; _wait.params = ''; _done.params = '';
          if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
        }
      },
    });
  }
  function ticketsViewToggle() {
    const cur = F('tk-view', 'list');
    return `<div style="padding:0 20px;margin-top:14px"><div class="kv-viewtoggle">
      <button class="${cur === 'list' ? 'on' : ''}" onclick="DFO.setF('tk-view','list')">${svg(I.list || I.doc)} Lijst</button>
      <button class="${cur === 'kanban' ? 'on' : ''}" onclick="DFO.setF('tk-view','kanban')">${svg(I.grid || I.settings)} Pipeline</button>
    </div></div>`;
  }
  function ticketsKanbanView() {
    // Trigger fetches als data ontbreekt zodat de kanban vult.
    if (!_open.loading && !_open.error && (!_open.data || _open.params !== ('open|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_open, ['open']));
    if (!_wait.loading && !_wait.error && (!_wait.data || _wait.params !== ('in_progress|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_wait, ['in_progress']));
    if (!_done.loading && !_done.error && (!_done.data || _done.params !== ('resolved,closed|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_done, ['resolved', 'closed']));
    return `${previewHeader('Pipeline · alle statussen', _open)}
      ${ticketsViewToggle()}
      ${window.KV_V2.kanban ? window.KV_V2.kanban.html('tickets') : '<div class="sv-empty">Kanban laden…</div>'}`;
  }

  function wrapView(fn) {
    return () => {
      if (urlParam('ticket')) return detailView();
      if (_det.id != null) { _det.id = null; _det.data = null; _det.error = null; }
      // Kanban-mode: één pipeline over alle 3 tabs, geen tab-specifieke lijst.
      if (F('tk-view', 'list') === 'kanban') {
        const overlay = urlParam('ticket-new') === '1' ? createModal() : '';
        return ticketsKanbanView() + overlay;
      }
      const listHtml = fn();
      const overlay = urlParam('ticket-new') === '1' ? createModal() : '';
      return ticketsViewToggle() + listHtml + overlay;
    };
  }

  function openView() {
    if (!_open.loading && !_open.error && (!_open.data || _open.params !== ('open|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_open, ['open']));
    const items = _open.data?.tickets || [];
    return `${previewHeader('Open', _open)}
      ${kpiStrip(_open.data?.counts)}
      ${toolbar()}
      ${ticketTable(items, _open.loading, _open.error)}`;
  }
  function waitView() {
    if (!_wait.loading && !_wait.error && (!_wait.data || _wait.params !== ('in_progress|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_wait, ['in_progress']));
    const items = _wait.data?.tickets || [];
    return `${previewHeader('Wacht op klant · maps naar status=in_progress', _wait)}
      ${kpiStrip(_wait.data?.counts)}
      ${toolbar()}
      ${ticketTable(items, _wait.loading, _wait.error)}`;
  }
  function doneView() {
    if (!_done.loading && !_done.error && (!_done.data || _done.params !== ('resolved,closed|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_done, ['resolved', 'closed']));
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
