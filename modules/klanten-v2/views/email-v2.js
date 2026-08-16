// modules/klanten-v2/views/email-v2.js — Fase 2B (feat/v2-email, PR #1289)
//
// Data-clusters live: HTML-sanitizer + iframe-sandbox render, AI-card in reader,
// Vlag/Concepten/Archief/Prullenbak endpoints + bulk-acties + folder-counts,
// handtekening-picker + preview, koppel-klant → v2-route.
//
// Layout-fix: 3-koloms grid vult beschikbare hoogte (min-height:0 keten).
//
// Endpoints:
//   /api/email-inbox-list         GET  (folder=inbox|unread|flag|draft|sent|archive|trash)
//   /api/email-body               POST (levert body_html_safe + text)
//   /api/email-attachment         GET
//   /api/mark-read                POST
//   /api/email-send-v2            POST (server-side preview-guard)
//   /api/email-ai-regenerate      POST (dunne Anthropic-wrapper, geen joost)
//   /api/email-status-update      POST { ids[], action:'flag|unflag|archive|trash|restore' }
//   /api/email-folder-counts      GET  (badge-tellers per map)
//   /api/email-drafts             GET/POST/DELETE (Concepten CRUD)
//
// Twee-lagen XSS-verdediging voor HTML-mails:
//   1) Server-side sanitizer (api/_lib/email-html-sanitizer.js) — allowlist.
//   2) Client rendert in <iframe sandbox> zonder allow-scripts.

(function () {
  if (!window.DFO) { console.error('[email-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[email-v2] KV_V2.helpers niet geladen.'); return; }

  const { render } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const MAILBOXES = [
    { slug: 'leads',         addr: 'leads@deforexopleiding.nl',         label: 'Leads',         dot: '#3B82F6' },
    { slug: 'info',          addr: 'info@deforexopleiding.nl',          label: 'Info',          dot: '#07835A' },
    { slug: 'partners',      addr: 'partners@deforexopleiding.nl',      label: 'Partners',      dot: '#B7791F' },
    { slug: 'administratie', addr: 'administratie@deforexopleiding.nl', label: 'Administratie', dot: '#7C3AED' },
    { slug: 'onboarding',    addr: 'onboarding@deforexopleiding.nl',    label: 'Onboarding',    dot: '#0EA5E9' },
    { slug: 'events',        addr: 'events@deforexopleiding.nl',        label: 'Events',        dot: '#EC4899' },
    { slug: 'welkom',        addr: 'welkom@deforexopleiding.nl',        label: 'Welkom',        dot: '#94A3B8' },
  ];
  const FOLDERS = [
    { slug: 'inbox',   label: 'Postvak IN',  icon: 'inbox'   },
    { slug: 'unread',  label: 'Ongelezen',   icon: 'mail'    },
    { slug: 'flag',    label: 'Met vlag',    icon: 'flag'    },
    { slug: 'draft',   label: 'Concepten',   icon: 'edit'    },
    { slug: 'sent',    label: 'Verzonden',   icon: 'send'    },
    { slug: 'archive', label: 'Archief',     icon: 'archive' },
    { slug: 'trash',   label: 'Prullenbak',  icon: 'trash'   },
  ];
  const SIGNATURES = [
    { key: 'standaard', label: 'Standaard', text: '\n\nMet vriendelijke groet,\nDe Forex Opleiding\ninfo@deforexopleiding.nl' },
    { key: 'kort',      label: 'Kort',      text: '\n\nGroet,\nDe Forex Opleiding' },
    { key: 'zakelijk',  label: 'Zakelijk',  text: '\n\nMet vriendelijke groet,\n\nDe Forex Opleiding NL B.V.\nKvK — deforexopleiding.nl' },
    { key: 'geen',      label: 'Geen',      text: '' },
  ];
  const PAGE_SIZE = 50;
  const DRAFT_AUTOSAVE_MS = 2500;

  const ICO = {
    inbox:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
    mail:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
    flag:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
    edit:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    send:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>`,
    archive:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
    trash:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
    settings:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    search:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>`,
    paperclip:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    plus:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    reply:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
    replyAll:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg>`,
    forward:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>`,
    dots:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
    x:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    min:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    tick:`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    file:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    sparkle:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8L4 10.7l6.1 1.9L12 18l1.9-5.4 6.1-1.9-6.1-1.9z"/></svg>`,
    img:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>`,
    attach:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    template:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`,
  };

  const _live = {
    inbox:   { loading: false, error: null, data: null, key: null },
    body:    { loading: {}, error: {}, data: {} },
    counts:  { loading: false, data: null, ts: 0 },
    aiDraft: { loading: {}, error: {}, data: {} }, // per rowId → { subject, body }
    sanne:   { loading: {}, error: {}, data: {} }, // per rowId (email_id) → { suggestion, flags }
    templates: { loading: false, error: null, data: null }, // v2 email-round DEEL 2
  };
  const _ui = {
    mailboxSlug: '',
    folder:      'inbox',
    search:      '',
    filter:      'all',
    sort:        'newest',
    offset:      0,
    selectedId:  null,
    selectedRows: {},
    showImages:  {},      // rowId → true, unlockt originele img src
    composeOpen: false,
    composeMinimized: false,
    composeMode: 'new',
    compose: {
      from_mailbox: 'info@deforexopleiding.nl',
      to: '', cc: '', bcc: '', subject: '',
      body_html: '',      // rich-text (contenteditable)
      body_text: '',      // plaintext fallback (auto-synced uit body_html)
      email_id: null,
      signature: 'standaard',
      draft_id: null,     // gezet zodra draft opgeslagen
    },
    ccBccOpen:  false,
    aiTone:     'vriendelijk',
    aiBusy:     false,
    sendBusy:   false,
    lastSend:   null,
    moreMenuOpen: false,
    bulkBusy: false,
    statusBusy: {},       // action-key → true
    draftDirty: false,
    draftSaveT: null,
    draftMigrationRequired: false,
    // In-UI dialogs — vervangen native alert()/confirm() die de compose-modal bevroren.
    confirmDialog: null,  // { msg, onOk, onCancel } → gerenderd als portal
    infoDialog:    null,  // { title, msg, tone } tone: 'info'|'warn'
    templatePickerOpen: false, // v2 email-round DEEL 2
    _listScrollTop: 0,    // v2 email-round bug-4: list-scroll snapshot
  };
  function _showToastLocal(msg, tone) {
    try {
      if (H && typeof H.showToast === 'function') { H.showToast(msg, tone || 'info'); return; }
    } catch (_) {}
    // Fallback: minimal DOM-toast op body zodat we NOOIT native alert doen.
    const el = document.createElement('div');
    el.textContent = String(msg || '');
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:20000;background:#1F2937;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:80vw;text-align:center';
    document.body.appendChild(el);
    setTimeout(() => { try { el.remove(); } catch (_) {} }, 3500);
  }
  function _openConfirm(msg, onOk, onCancel) {
    _ui.confirmDialog = { msg: String(msg || ''), onOk: onOk || null, onCancel: onCancel || null };
    if (render) render();
  }
  function _openInfo(title, msg, tone) {
    _ui.infoDialog = { title: String(title || 'Info'), msg: String(msg || ''), tone: tone || 'info' };
    if (render) render();
  }

  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[email-v2] ' + label + ' fail:', e?.message);
      return { __error: e?.message || 'onbekende fout' };
    }
  }
  function inboxKey() {
    return `${_ui.mailboxSlug}|${_ui.folder}|${_ui.filter}|${_ui.sort}|${_ui.search}|${_ui.offset}`;
  }
  async function fetchInbox() {
    const key = inboxKey();
    const st = _live.inbox;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const params = [];
    if (_ui.mailboxSlug) params.push('mailbox=' + encodeURIComponent(_ui.mailboxSlug));
    if (_ui.folder && _ui.folder !== 'inbox') params.push('folder=' + encodeURIComponent(_ui.folder));
    if (_ui.folder === 'unread' || _ui.filter === 'unread') params.push('unread=1');
    if (_ui.search) params.push('search=' + encodeURIComponent(_ui.search));
    params.push('limit=' + PAGE_SIZE);
    params.push('offset=' + _ui.offset);
    const url = '/api/email-inbox-list?' + params.join('&');
    const j = await tryFetch('inbox', url);
    st.loading = false;
    if (j && j.__error) { st.error = j.__error; st.data = null; }
    else {
      let items = asArr(j?.items);
      if (_ui.filter === 'attach') items = items.filter((r) => r.has_attachments);
      if (_ui.sort === 'oldest') items = items.slice().sort((a, b) => new Date(a.date_received) - new Date(b.date_received));
      else if (_ui.sort === 'sender') items = items.slice().sort((a, b) => String(a.from_name || a.from_address || '').localeCompare(String(b.from_name || b.from_address || '')));
      st.data = { items, total: Number(j?.total || 0), hasMore: !!j?.hasMore, migration_required: !!j?.__migration_required };
    }
    if (render) render();
  }
  async function fetchCounts() {
    const st = _live.counts;
    // Cache 30s.
    if (st.loading) return;
    if (st.data && (Date.now() - st.ts) < 30000) return;
    st.loading = true;
    const url = '/api/email-folder-counts' + (_ui.mailboxSlug ? '?mailbox=' + encodeURIComponent(_ui.mailboxSlug) : '');
    const j = await tryFetch('counts', url);
    st.loading = false;
    if (j && !j.__error) { st.data = j; st.ts = Date.now(); if (render) render(); }
  }
  async function fetchBody(row) {
    if (!row || !row.mailbox || row.imap_uid == null) return;
    const rid = row.id;
    const st = _live.body;
    if (st.loading[rid] || st.data[rid]) return;
    st.loading[rid] = true; st.error[rid] = null;
    const j = await tryFetch('body:' + rid, '/api/email-body', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid }),
    }, 12000);
    st.loading[rid] = false;
    if (j && j.__error) st.error[rid] = j.__error;
    else st.data[rid] = j || null;
    if (render) render();
  }
  async function markRead(row, seen) {
    if (!row || !row.mailbox || row.imap_uid == null) return;
    const key = 'read:' + row.id;
    if (_ui.statusBusy[key]) return;
    _ui.statusBusy[key] = true;
    const j = await tryFetch('mark-read', '/api/mark-read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid, seen: !!seen }),
    }, 8000);
    _ui.statusBusy[key] = false;
    if (j && !j.__error) {
      const items = asArr(_live.inbox.data?.items);
      const idx = items.findIndex((x) => x.id === row.id);
      if (idx >= 0) items[idx].is_read = !!seen;
      _live.counts.data = null; // invalideer badges
      if (render) render();
    }
  }
  async function statusUpdate(ids, action) {
    if (!ids || ids.length === 0) return;
    const key = 'status:' + action;
    if (_ui.statusBusy[key]) return;
    _ui.statusBusy[key] = true;
    const j = await tryFetch('status:' + action, '/api/email-status-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action }),
    }, 15000);
    _ui.statusBusy[key] = false;
    if (j && j.__error) { _showToastLocal('Actie mislukt: ' + j.__error, 'warn'); return; }
    if (j?.error) {
      if (j.migration_required) _openInfo('Migratie vereist', 'SQL-migratie ' + j.migration_required + ' moet eerst gedraaid worden op productie voordat vlaggen/archief/prullenbak werken.', 'warn');
      else _showToastLocal('Actie mislukt: ' + j.error, 'warn');
      return;
    }
    // Optimistic: verwijder uit huidige lijst als action het buiten deze folder plaatst
    if (['archive','trash','restore'].includes(action) || (action === 'unflag' && _ui.folder === 'flag')) {
      const items = asArr(_live.inbox.data?.items);
      if (items.length) {
        _live.inbox.data.items = items.filter((x) => !ids.includes(x.id));
      }
      if (ids.includes(_ui.selectedId)) _ui.selectedId = null;
    } else if (action === 'flag' || action === 'unflag') {
      const items = asArr(_live.inbox.data?.items);
      items.forEach((it) => { if (ids.includes(it.id)) it.flagged = (action === 'flag'); });
    }
    _ui.selectedRows = {};
    _live.counts.data = null;
    if (render) render();
  }
  async function sendMail() {
    if (_ui.sendBusy) return;
    const c = _ui.compose;
    // Sync plaintext-fallback uit HTML voor de send.
    c.body_text = htmlToPlaintext(c.body_html);
    if (!c.from_mailbox || !c.to || !c.subject || !c.body_text) {
      _ui.lastSend = { ok: false, error: 'Vul Van/Aan/Onderwerp/Bericht' };
      if (render) render(); return;
    }
    // v2 email-round DEEL 3: server-side voegt de per-mailbox handtekening
    // toe (of globale default) via handtekening:true flag. De legacy
    // client-side SIGNATURES-blok is verwijderd — de user beheert nu de
    // handtekening in Instellingen → Communicatie → E-mail-handtekeningen.
    // c.signature (dropdown-keuze) blijft in de state maar wordt niet meer
    // gebruikt bij send (Fase-A: één handtekening per mailbox, later evt.
    // multi-signature per mailbox).
    _ui.sendBusy = true; _ui.lastSend = null; if (render) render();
    const j = await tryFetch('send', '/api/email-send-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_mailbox: c.from_mailbox, to: c.to, subject: c.subject,
        text: c.body_text, html: c.body_html || undefined,
        cc: c.cc || undefined, bcc: c.bcc || undefined, email_id: c.email_id || undefined,
        handtekening: true, // v2 email-round DEEL 3: server-side add
      }),
    }, 15000);
    _ui.sendBusy = false;
    if (j && j.__error) _ui.lastSend = { ok: false, error: j.__error };
    else if (j?.ok) {
      _ui.lastSend = { ok: true, guarded: !!j.guarded, guard_target: j.guard_target || null, original_to: j.original_to || null, env: j.env || null };
      // Draft opruimen na succesvolle send.
      if (c.draft_id) { deleteDraft(c.draft_id).catch(() => {}); }
      setTimeout(() => {
        _ui.composeOpen = false;
        _ui.compose = { from_mailbox: c.from_mailbox, to: '', cc: '', bcc: '', subject: '', body_html: '', body_text: '', email_id: null, signature: 'standaard', draft_id: null };
        _ui.lastSend = null; _ui.ccBccOpen = false;
        _live.inbox.data = null; _live.inbox.key = null;
        _live.counts.data = null;
        if (render) render();
      }, 2000);
    } else _ui.lastSend = { ok: false, error: j?.error || 'Onbekende fout' };
    if (render) render();
  }
  async function aiRegenerateInReader(row) {
    if (!row) return;
    const rid = row.id;
    const st = _live.aiDraft;
    if (st.loading[rid]) return;
    st.loading[rid] = true; st.error[rid] = null;
    const bodyData = _live.body.data[rid] || {};
    const j = await tryFetch('ai-regen:' + rid, '/api/email-ai-regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original_subject: row.subject || '',
        original_body:    bodyData.text || row.snippet || '',
        from_name:        row.from_name || row.from_address || '',
        tone:             _ui.aiTone,
      }),
    }, 20000);
    st.loading[rid] = false;
    if (j && !j.__error && j.draft_body) {
      st.data[rid] = { subject: j.draft_subject || row.subject || '', body: j.draft_body };
    } else {
      st.error[rid] = j?.__error || j?.error || 'AI-generatie mislukt';
    }
    if (render) render();
  }
  // ── Sanne (Fase 2.1) — reader-card fetcher ─────────────────────────────
  async function fetchSanneForRow(rowId) {
    if (!rowId) return;
    const st = _live.sanne;
    if (st.loading[rowId] || st.data[rowId]) return;
    st.loading[rowId] = true; st.error[rowId] = null;
    const j = await tryFetch('sanne:' + rowId, '/api/sanne-suggestion-get?email_id=' + encodeURIComponent(rowId), null, 8000);
    st.loading[rowId] = false;
    if (j && !j.__error) st.data[rowId] = j;
    else st.error[rowId] = j?.__error || 'sanne-fetch fout';
    if (render) render();
  }
  async function sanneOutcome(sugId, outcome, notes) {
    if (!sugId || !outcome) return;
    const j = await tryFetch('sanne-outcome:' + outcome, '/api/sanne-suggestion-outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ suggestion_id: sugId, outcome, notes: notes || null }),
    }, 8000);
    return j;
  }
  async function saveDraftDebounced() {
    if (_ui.draftSaveT) clearTimeout(_ui.draftSaveT);
    _ui.draftSaveT = setTimeout(saveDraft, DRAFT_AUTOSAVE_MS);
  }
  async function saveDraft() {
    const c = _ui.compose;
    if (!c.to && !c.subject && !c.body_html) return; // niks om op te slaan
    if (_ui.draftMigrationRequired) return; // silenced na eerste 503
    const body = {
      id: c.draft_id || undefined,
      from_mailbox: c.from_mailbox, to_address: c.to, cc_address: c.cc,
      bcc_address: c.bcc, subject: c.subject, body_html: c.body_html,
      in_reply_to_email_id: c.email_id || null,
    };
    const j = await tryFetch('draft-save', '/api/email-drafts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000);
    // Nette fout: tabel email_drafts bestaat niet (503 migration_required).
    if (j && (j.migration_required || /email_drafts.*ontbreekt|does not exist/i.test(String(j?.error || j?.__error || '')))) {
      _ui.draftMigrationRequired = true;
      _ui.draftDirty = false;
      _showToastLocal('Concepten uit — SQL-migratie 2026-08-15-email-v2-fase-2b.sql draait nog niet op productie.', 'warn');
      if (render) render();
      return;
    }
    if (j && (j.__error || j.error)) {
      // Andere fout — laat één keer een toast zien, geen browser-crash.
      _ui.draftDirty = false;
      _showToastLocal('Concept opslaan mislukt: ' + (j.__error || j.error), 'warn');
      if (render) render();
      return;
    }
    if (j?.item?.id) {
      const wasNew = !c.draft_id;
      c.draft_id = j.item.id;
      _ui.draftDirty = false;
      // Surgical badge/list refresh: invalideer alleen counts + de drafts-lijst
      // (als de gebruiker die open heeft) — geen inbox-reload, geen mailbox-switch.
      _live.counts.data = null;
      _live.counts.ts   = 0;
      if (_ui.folder === 'draft') {
        _live.inbox.data = null;
        _live.inbox.key  = null;
      }
      if (wasNew) queueMicrotask(fetchCounts);
      if (render) render();
    }
  }
  async function deleteDraft(id) {
    if (!id) return;
    const j = await tryFetch('draft-del', '/api/email-drafts', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }, 8000);
    // Badge ticks direct — geen wachten op de 30s counts-cache.
    _live.counts.data = null; _live.counts.ts = 0;
    if (j && (j.__error || j.error)) throw new Error(j.__error || j.error);
    return j;
  }

  function currentRow() {
    const items = asArr(_live.inbox.data?.items);
    return items.find((x) => x.id === _ui.selectedId) || null;
  }
  function hashHue(s) { let h = 0; s = String(s || ''); for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return Math.abs(h) % 360; }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function av(name, size) {
    size = size || 38;
    const hue = hashHue(name);
    const bg1 = `hsl(${hue}, 65%, 52%)`, bg2 = `hsl(${(hue + 30) % 360}, 60%, 42%)`;
    const fs = Math.round(size * 0.4);
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,${bg1},${bg2});color:#fff;display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:600;letter-spacing:.02em;flex-shrink:0">${esc(initialsOf(name))}</div>`;
  }
  const TOK = {
    m:'var(--m, #3B82F6)', mSoft:'var(--m-soft, rgba(59,130,246,.12))',
    r:'var(--r, 10px)', rSm:'var(--r-sm, 7px)', rLg:'var(--r-lg, 14px)',
    rose:'var(--rose, #C22B3E)', roseSoft:'var(--rose-soft, #FDECEE)', roseLine:'var(--rose-line, #F5B4BC)',
    emerald:'var(--emerald, #07835A)', emeraldSoft:'var(--emerald-soft, #E6F5EE)',
    amber:'var(--amber, #B7791F)', amberSoft:'var(--amber-soft, #FEF7E0)',
    violet:'var(--violet, #7C3AED)', violetSoft:'var(--violet-soft, #F0EAFB)', violetLine:'var(--violet-line, #D6C5F5)',
    mono:"'IBM Plex Mono', 'SF Mono', Menlo, Consolas, monospace",
  };
  const errBlk = (msg, retryFn) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid ${TOK.roseLine};background:${TOK.roseSoft};border-radius:${TOK.r};color:${TOK.rose};font-size:13px;display:flex;align-items:center;gap:12px"><span style="flex:1">⚠ ${esc(msg)}</span>${retryFn ? `<button class="btn btn-ghost btn-sm" onclick="${retryFn}">Opnieuw</button>` : ''}</div>`;
  const skel = () => `<div style="padding:24px 20px"><div style="height:80px;background:var(--surface-2);border-radius:${TOK.r};opacity:.5;animation:pulse 1.5s ease-in-out infinite"></div></div>`;
  function fmtRelTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '—';
    const now = new Date();
    const diffDay = Math.floor((now - d) / 86400000);
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const y = new Date(now); y.setDate(y.getDate() - 1);
    if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) return 'gisteren';
    if (diffDay < 7) return diffDay + ' dagen';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
  }
  function fmtDateFull(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }
  // Plaintext-fallback: strip HTML-tags voor plain-text-fallback in send.
  function htmlToPlaintext(html) {
    if (!html) return '';
    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  function safePlainText(text) {
    return esc(String(text || '')).replace(/\n{2,}/g, '</p><p style="margin-bottom:14px">').replace(/\n/g, '<br>');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW — full-height 3-koloms grid met min-height:0 keten
  // ═══════════════════════════════════════════════════════════════════════
  function emailView() {
    if (!_live.inbox.loading && (!_live.inbox.data || _live.inbox.key !== inboxKey())) queueMicrotask(fetchInbox);
    if (!_live.counts.data && !_live.counts.loading) queueMicrotask(fetchCounts);
    // Layout-fix: outer height:calc(100dvh - 60px), min-height:0 tot in de kolommen.
    const html = `<div class="pad" style="padding:0;height:calc(100dvh - 60px);min-height:400px;display:flex;flex-direction:column">
      <div style="flex:1;display:grid;grid-template-columns:198px 352px 1fr;min-height:0;border-top:1px solid var(--border)">
        ${_leftRail()}
        ${_middleList()}
        ${_reader()}
      </div>
    </div>`;
    const compose = _ui.composeOpen ? _composeModal() : '';
    const dialogs = _dialogsLayer();
    return html + compose + dialogs;
  }
  function _dialogsLayer() {
    const c = _ui.confirmDialog;
    const i = _ui.infoDialog;
    const tp = _ui.templatePickerOpen;
    if (!c && !i && !tp) return '';
    let html = '';
    if (c) {
      // z-index 2000 → boven compose (1000), boven overlay-modals. Native dialogs zijn hiermee vervangen.
      html += `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__emailConfirmCancel()">
        <div style="background:var(--surface);border-radius:${TOK.rLg};box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:420px;width:100%;padding:22px 24px" onclick="event.stopPropagation()">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">Bevestigen</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px">${esc(c.msg)}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost" onclick="window.__emailConfirmCancel()">Annuleren</button>
            <button class="btn btn-primary" onclick="window.__emailConfirmOk()">OK</button>
          </div>
        </div>
      </div>`;
    }
    if (i) {
      const accentBg = i.tone === 'warn' ? TOK.amberSoft : TOK.mSoft;
      const accentFg = i.tone === 'warn' ? TOK.amber    : TOK.m;
      html += `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__emailInfoClose()">
        <div style="background:var(--surface);border-radius:${TOK.rLg};box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:460px;width:100%;padding:0;overflow:hidden" onclick="event.stopPropagation()">
          <div style="padding:14px 22px;background:${accentBg};color:${accentFg};font-size:14px;font-weight:600;border-bottom:1px solid var(--border)">${esc(i.title)}</div>
          <div style="padding:18px 22px;font-size:13px;color:var(--text-2);line-height:1.6">${esc(i.msg)}</div>
          <div style="padding:0 18px 16px;display:flex;justify-content:flex-end"><button class="btn btn-primary" onclick="window.__emailInfoClose()">Sluiten</button></div>
        </div>
      </div>`;
    }
    if (tp) {
      // v2 email-round DEEL 2: template-picker modal.
      const list = Array.isArray(_live.templates.data) ? _live.templates.data : [];
      const byCategory = list.reduce((acc, t) => { (acc[t.category || 'algemeen'] ||= []).push(t); return acc; }, {});
      const cats = Object.keys(byCategory).sort();
      html += `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__emailTemplateCancel()">
        <div style="background:var(--surface);border-radius:${TOK.rLg};box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">
          <div style="padding:14px 22px;background:${TOK.mSoft};color:${TOK.m};font-size:14px;font-weight:600;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <span>Sjabloon invoegen</span>
            <button class="icon-btn" onclick="window.__emailTemplateCancel()" title="Sluiten" style="width:26px;height:26px">${ICO.x}</button>
          </div>
          <div style="padding:14px 22px;overflow-y:auto;flex:1">
            ${list.length === 0
              ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Nog geen sjablonen aangemaakt.<br><br>Beheer sjablonen in <b>Instellingen → Communicatie → Berichtsjablonen</b>.</div>`
              : cats.map((cat) => `
                <div style="margin-bottom:14px">
                  <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);margin-bottom:6px">${esc(cat)}</div>
                  <div style="display:grid;gap:6px">
                    ${byCategory[cat].map((t) => `
                      <button class="btn btn-ghost" onclick="window.__emailTemplateApply('${esc(t.id)}')" style="text-align:left;padding:10px 12px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface);cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:2px">
                        <span style="font-size:13.5px;font-weight:600;color:var(--text)">${esc(t.name)}</span>
                        ${t.subject ? `<span style="font-size:11.5px;color:var(--text-3)">${esc(String(t.subject).slice(0, 100))}</span>` : ''}
                      </button>
                    `).join('')}
                  </div>
                </div>
              `).join('')
            }
          </div>
          <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-3)">
            <span>${list.length} sjabl${list.length === 1 ? 'oon' : 'onen'} · beheer in Instellingen</span>
            <button class="btn btn-ghost" onclick="window.__emailTemplateCancel()">Annuleren</button>
          </div>
        </div>
      </div>`;
    }
    return html;
  }

  function _leftRail() {
    const counts = _live.counts.data || {};
    return `<aside style="background:var(--surface-2);border-right:1px solid var(--border);overflow-y:auto;min-height:0;padding:12px 0;display:flex;flex-direction:column">
      <div style="padding:0 14px 12px">
        <button class="btn btn-primary" style="width:100%;font-weight:500;gap:6px" onclick="window.__emailNewCompose()">${ICO.plus}Nieuwe e-mail</button>
      </div>
      <div style="padding:6px 0">
        <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:8px 16px 4px">Mappen</div>
        ${FOLDERS.map((f) => _foldBtn(f, counts)).join('')}
      </div>
      <div style="padding:6px 0">
        <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:8px 16px 4px">Postvakken</div>
        ${_acctBtn({ slug:'', label:'Alle postvakken', dot:'#94A3B8' })}
        ${MAILBOXES.map(_acctBtn).join('')}
      </div>
      <div style="margin-top:auto;padding:12px 14px;border-top:1px solid var(--border)">
        <button class="btn btn-ghost btn-sm" style="width:100%;justify-content:flex-start;gap:8px;color:var(--text-3)" onclick="window.__emailSettings()">${ICO.settings}Instellingen</button>
      </div>
    </aside>`;
  }
  function _foldBtn(f, counts) {
    const on = _ui.folder === f.slug;
    const bg = on ? TOK.mSoft : 'transparent';
    const fg = on ? TOK.m : 'var(--text-2)';
    const wt = on ? '600' : '400';
    const cnt = Number(counts[f.slug] || 0);
    const hot = f.slug === 'inbox' || f.slug === 'unread';
    const countPill = cnt > 0
      ? `<span style="font-family:${TOK.mono};font-size:10.5px;padding:1px 7px;border-radius:20px;background:${on ? TOK.m : (hot && cnt > 0 ? TOK.roseSoft : 'var(--surface-2)')};color:${on ? '#fff' : (hot && cnt > 0 ? TOK.rose : 'var(--text-3)')};font-weight:600">${cnt > 999 ? '999+' : cnt}</span>`
      : '';
    return `<button style="width:100%;text-align:left;padding:8px 16px;background:${bg};border:none;color:${fg};font-size:13px;font-weight:${wt};cursor:pointer;display:flex;align-items:center;gap:10px" onclick="window.__emailSetFolder('${esc(f.slug)}')">
      <span style="display:inline-flex;width:16px;height:16px;flex-shrink:0">${ICO[f.icon] || ''}</span>
      <span style="flex:1">${esc(f.label)}</span>
      ${countPill}
    </button>`;
  }
  function _acctBtn(m) {
    const on = _ui.mailboxSlug === m.slug;
    const bg = on ? 'var(--surface)' : 'transparent';
    const wt = on ? '600' : '400';
    return `<button style="width:100%;text-align:left;padding:8px 16px;background:${bg};border:none;color:var(--text);font-size:12.5px;font-weight:${wt};cursor:pointer;display:flex;align-items:center;gap:10px" onclick="window.__emailSetMailbox('${esc(m.slug)}')">
      <span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${m.dot};flex-shrink:0"></span>
      <span style="flex:1">${esc(m.label)}</span>
    </button>`;
  }

  function _middleList() {
    const selCount = Object.values(_ui.selectedRows).filter(Boolean).length;
    const bulkBar = selCount > 0 ? _bulkBar(selCount) : '';
    return `<section style="border-right:1px solid var(--border);overflow:hidden;display:flex;flex-direction:column;min-height:0">
      <div style="position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="padding:10px 12px;display:flex;gap:8px;align-items:center">
          <div style="flex:1;position:relative">
            <span style="position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--text-3);display:flex;pointer-events:none">${ICO.search}</span>
            <input type="search" placeholder="Zoek onderwerp / afzender / tekst" value="${esc(_ui.search)}" oninput="window.__emailSetSearchDebounced(this.value)" style="width:100%;padding:7px 10px 7px 30px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface-2);color:var(--text);font-size:12.5px" />
          </div>
          <button class="icon-btn" title="Vernieuw" onclick="window.__emailRefresh()" style="width:28px;height:28px">↻</button>
        </div>
        <div style="padding:0 12px 10px;display:flex;gap:6px;align-items:center">
          ${['all','unread','attach'].map((f) => {
            const on = _ui.filter === f;
            const label = f === 'all' ? 'Alles' : f === 'unread' ? 'Ongelezen' : 'Bijlage';
            return `<button class="chip" style="padding:3px 10px;border:1px solid ${on ? TOK.m : 'var(--border)'};background:${on ? TOK.mSoft : 'transparent'};color:${on ? TOK.m : 'var(--text-2)'};border-radius:20px;font-size:11.5px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__emailSetFilter('${f}')">${label}</button>`;
          }).join('')}
          <select onchange="window.__emailSetSort(this.value)" style="margin-left:auto;padding:3px 8px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface-2);color:var(--text);font-size:11.5px;cursor:pointer">
            ${[['newest','Nieuwste'],['oldest','Oudste'],['sender','Afzender']].map(([v, l]) => `<option value="${v}" ${_ui.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        ${bulkBar}
      </div>
      <div id="emailListScroll" style="flex:1;overflow-y:auto;min-height:0" onscroll="window.__emailListScrollSnap && window.__emailListScrollSnap(this.scrollTop)">${_listBody()}</div>
      ${_pager()}
    </section>`;
  }
  function _bulkBar(count) {
    const b = _ui.statusBusy;
    return `<div style="padding:8px 12px;background:${TOK.mSoft};border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px">
      <span style="color:${TOK.m};font-weight:600">${count} geselecteerd</span>
      <div style="display:flex;gap:4px;margin-left:auto">
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('read')" ${b['bulk:read'] ? 'disabled' : ''} title="Markeer als gelezen">Gelezen</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('flag')" ${b['status:flag'] ? 'disabled' : ''}>Vlag</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('archive')" ${b['status:archive'] ? 'disabled' : ''}>Archief</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('trash')" ${b['status:trash'] ? 'disabled' : ''}>Trash</button>
        <button class="icon-btn" onclick="window.__emailBulkClear()" title="Deselecteer" style="width:24px;height:24px">${ICO.x}</button>
      </div>
    </div>`;
  }
  function _listBody() {
    const st = _live.inbox;
    if (st.error && !st.data) return errBlk(st.error, "window.__emailRefresh()");
    if (st.loading && !st.data) return skel();
    if (st.data && st.data.migration_required) return _emptyState('Migratie vereist', 'Voer 2026-08-15-email-v2-fase-2b.sql uit op productie om Concepten/Vlag/Archief/Prullenbak te activeren.');
    return _listRows();
  }
  function _listRows() {
    const items = asArr(_live.inbox.data?.items);
    if (items.length === 0) return _emptyState('Geen berichten', 'Deze weergave heeft geen mails die aan de filters voldoen.');
    return items.map(_listRow).join('');
  }
  function _listRow(r) {
    const isActive = r.id === _ui.selectedId;
    const isSel = !!_ui.selectedRows[r.id];
    const isUnread = !r.is_read && _ui.folder !== 'sent';
    const displayName = r.from_name || r.from_address || (r.to_address ? 'aan ' + r.to_address : '—');
    const mailboxDot = MAILBOXES.find((m) => m.slug === r.mailbox);
    const bg = isActive ? TOK.mSoft : 'transparent';
    const leftBorder = isActive ? `border-left:3px solid ${TOK.m}` : 'border-left:3px solid transparent';
    return `<div style="position:relative;border-bottom:1px solid var(--border);${leftBorder};background:${bg};transition:background .15s" onmouseover="this.style.background='${isActive ? TOK.mSoft : 'var(--surface-2)'}'" onmouseout="this.style.background='${bg}'">
      <div style="display:flex;gap:11px;padding:11px 14px 12px 11px;cursor:pointer" onclick="window.__emailOpen('${esc(r.id)}')">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:2px;flex-shrink:0">
          <label style="display:inline-flex;width:16px;height:16px;border:1.5px solid var(--border);border-radius:3px;cursor:pointer;background:${isSel ? TOK.m : 'transparent'};color:#fff;align-items:center;justify-content:center" onclick="event.stopPropagation();window.__emailToggleSel('${esc(r.id)}')">
            ${isSel ? ICO.tick : ''}
          </label>
          ${isUnread ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${TOK.m}"></span>` : '<span style="display:inline-block;width:8px;height:8px"></span>'}
        </div>
        <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
          <div style="display:flex;align-items:baseline;gap:8px">
            <span style="flex:1;font-size:13.5px;font-weight:${isUnread ? '600' : '400'};color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(displayName)}</span>
            <span style="font-size:10.5px;font-family:${TOK.mono};color:var(--text-3);flex-shrink:0">${esc(fmtRelTime(r.date_received))}</span>
          </div>
          <div style="font-size:13px;font-weight:${isUnread ? '600' : '400'};color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject || '(geen onderwerp)')}</div>
          ${r.snippet ? `<div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.snippet.slice(0, 140))}</div>` : ''}
          <div style="display:flex;gap:5px;align-items:center;margin-top:3px;flex-wrap:wrap">
            ${mailboxDot ? `<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-3)"><span style="display:inline-block;width:6px;height:6px;border-radius:2px;background:${mailboxDot.dot}"></span>${esc(mailboxDot.label)}</span>` : ''}
            ${r.has_attachments ? `<span style="display:inline-flex;color:var(--text-3)" title="Bijlage">${ICO.paperclip}</span>` : ''}
            ${r.flagged ? `<span style="display:inline-flex;color:${TOK.amber}" title="Vlag">${ICO.flag}</span>` : ''}
            ${r.customer_id
              ? `<span style="font-size:10px;padding:1px 7px;background:${TOK.mSoft};color:${TOK.m};border-radius:20px;font-weight:500">Klant</span>`
              : `<span style="font-size:10px;padding:1px 7px;background:var(--surface-2);color:var(--text-3);border-radius:20px">Niet gekoppeld</span>`}
            ${r.requires_action ? `<span style="font-size:10px;padding:1px 7px;background:${TOK.amberSoft};color:${TOK.amber};border-radius:20px;font-weight:500">Actie</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }
  function _emptyState(title, tag) {
    return `<div style="padding:60px 24px;text-align:center;color:var(--text-3)">
      <div style="width:56px;height:56px;margin:0 auto 14px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center;color:var(--text-3)">${ICO.mail}</div>
      <div style="font-size:14px;font-weight:600;color:var(--text-2);margin-bottom:6px">${esc(title)}</div>
      <div style="font-size:12.5px;max-width:280px;margin:0 auto;line-height:1.5">${esc(tag)}</div>
    </div>`;
  }
  function _pager() {
    const st = _live.inbox;
    if (!st.data || st.data.total === 0) return '';
    const offset = _ui.offset, shown = asArr(st.data.items).length, hasMore = st.data.hasMore;
    return `<div style="padding:8px 12px;border-top:1px solid var(--border);background:var(--surface);display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-3);font-family:${TOK.mono}">
      <span>${offset + 1}–${offset + shown} van ${st.data.total}</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" ${offset === 0 ? 'disabled' : ''} onclick="window.__emailPage(-1)">Vorige</button>
        <button class="btn btn-ghost btn-sm" ${!hasMore ? 'disabled' : ''} onclick="window.__emailPage(1)">Volgende</button>
      </div>
    </div>`;
  }

  function _reader() {
    const row = currentRow();
    if (!row) return _readerEmpty();
    // Draft-open: open direct compose (Concepten-folder klik).
    if (row._source === 'draft') {
      // Idempotent: alleen open-schedulen als compose NIET al aanstaat op deze draft.
      // Zonder deze guard vuurt elke render een setTimeout -> composeOpen weer true
      // -> re-render -> nieuwe setTimeout ... -> modal wordt elk frame ge-remount ->
      // slideUp-animatie start telkens op opacity:0 -> paneel wordt nooit zichtbaar,
      // backdrop blijft klik-dood liggen. Root-cause van bug A in feat/v2-email hertest.
      const draftKey = row._draft_id || row.id;
      const alreadyOpen = _ui.composeOpen && _ui.compose && _ui.compose.draft_id === draftKey;
      if (!alreadyOpen) setTimeout(() => window.__emailOpenDraftFromRow(row), 0);
      return _readerEmpty();
    }
    const bst = _live.body;
    let body = bst.data[row.id]; const bErr = bst.error[row.id], bLoad = bst.loading[row.id];
    // Sent-mails: body is al inline uit email_replies.final_reply (imap_uid=null).
    // Direct hydrateren zonder /api/email-body-call zodat de reader NIET hangt op
    // "Body wordt geladen…" — dat was de root-cause van de leeg-blijvende Verzonden-reader.
    if (!body && row._source === 'sent') {
      body = { text: String(row._body_text || ''), body_html_safe: '', hasHtml: false, attachments: asArr(row._attachments), external_images_blocked: 0 };
      bst.data[row.id] = body;
    }
    // Alleen IMAP-fetch voor inbox/archief/prullenbak — die hebben een echte imap_uid.
    if (!body && !bErr && !bLoad && row._source !== 'sent' && row.mailbox && row.imap_uid != null) queueMicrotask(() => fetchBody(row));
    if (row._source === 'inbox' && !row.is_read && !_ui.statusBusy['read:' + row.id]) queueMicrotask(() => markRead(row, true));
    // Sanne (Fase 2.1) — fetch suggestion voor inbox-rows (skip sent/draft).
    if (row._source === 'inbox' && !_live.sanne.data[row.id] && !_live.sanne.loading[row.id]) queueMicrotask(() => fetchSanneForRow(row.id));
    return `<section style="overflow:hidden;display:flex;flex-direction:column;background:var(--bg,var(--surface));min-height:0">
      ${_readHead(row)}
      ${_readMeta(row)}
      <div style="flex:1;overflow-y:auto;min-height:0">
        ${bErr ? errBlk(bErr, `window.__emailReloadBody('${esc(row.id)}')`) :
          bLoad ? skel() :
          body ? _bodyBlock(body, row) :
          `<div style="padding:20px;color:var(--text-3);font-size:13px">Body wordt geladen…</div>`}
        ${row._source === 'inbox' ? _sanneCard(row) : ''}
        ${body && row._source !== 'sent' ? _aiSuggestCard(row) : ''}
      </div>
    </section>`;
  }
  // ═════════════════════════════════════════════════════════════════════
  // SANNE (Fase 2.1) — reader-card met suggestie
  // Verschijnt alleen als: sanne_enabled + reactive_suggest_flag + mailbox
  // in scope + suggestie bestaat + status is PROPOSED/DRAFT_SAVED/USED/EDITED.
  // Concept-tekst wordt via esc() weergegeven (XSS-veilig, geen ruwe HTML).
  // ═════════════════════════════════════════════════════════════════════
  function _sanneCard(row) {
    const st = _live.sanne.data[row.id];
    if (!st || !st.suggestion) return '';
    if (!st.reactive_suggest_flag) return '';
    if (!st.mailbox_in_scope) return '';
    const s = st.suggestion;
    const status = String(s.status || '').toUpperCase();
    if (!['PROPOSED', 'DRAFT_SAVED', 'USED', 'EDITED'].includes(status)) return '';
    const confPct = Math.round(Number(s.confidence || 0) * 100);
    const confBadgeColor = confPct >= 80 ? TOK.emerald : (confPct >= 60 ? TOK.violet : TOK.amber);
    const statusLabel = status === 'DRAFT_SAVED' ? 'Concept opgeslagen'
      : status === 'USED' ? 'Gebruikt'
      : status === 'EDITED' ? 'Bewerkt'
      : 'Voorstel';
    const bodyText = String(s.draft_body_text || '');
    return `<div style="margin:20px 22px 6px;padding:16px 18px;background:${TOK.violetSoft};border:1px solid ${TOK.violetLine};border-radius:${TOK.rLg}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="width:26px;height:26px;border-radius:50%;background:${TOK.violet};color:#fff;display:flex;align-items:center;justify-content:center">${ICO.sparkle}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:${TOK.violet}">Sanne stelt voor · ${esc(statusLabel)}</div>
          <div style="font-size:11px;color:var(--text-3)">Intent: <span class="mono">${esc(s.detected_intent || '—')}</span></div>
        </div>
        <span style="font-family:${TOK.mono};font-size:11px;padding:2px 8px;border-radius:20px;background:${confBadgeColor};color:#fff;font-weight:600">${confPct}%</span>
      </div>
      <div style="padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:${TOK.rSm};font-size:13px;line-height:1.5;color:var(--text);white-space:pre-wrap;max-height:280px;overflow-y:auto">${esc(bodyText)}</div>
      ${s.draft_subject ? `<div style="margin-top:6px;font-size:11px;color:var(--text-3)">Onderwerp: <span style="color:var(--text-2)">${esc(s.draft_subject)}</span></div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px">
        <button class="btn btn-ghost btn-sm" onclick="window.__emailSanneDismiss('${esc(s.id)}')">Negeer</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailSanneEdit('${esc(s.id)}','${esc(row.id)}')">Bewerken</button>
        <button class="btn btn-primary btn-sm" style="background:${TOK.violet};border-color:${TOK.violet}" onclick="window.__emailSanneUse('${esc(s.id)}','${esc(row.id)}')">Plak in antwoord →</button>
      </div>
    </div>`;
  }
  function _readerEmpty() {
    return `<section style="display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-3);gap:14px;padding:40px 20px;background:var(--bg,var(--surface));min-height:0">
      <div style="width:72px;height:72px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center">${ICO.mail}</div>
      <div style="text-align:center">
        <div style="font-size:15px;font-weight:600;color:var(--text-2);margin-bottom:4px">Geen bericht geopend</div>
        <div style="font-size:12.5px;max-width:320px;line-height:1.5">Kies links een e-mail om 'm te lezen en te beantwoorden.</div>
      </div>
    </section>`;
  }
  function _readHead(row) {
    const isFlagged = !!row.flagged;
    return `<div style="padding:16px 22px 14px;border-bottom:1px solid var(--border);background:var(--surface)">
      <div style="font-size:18px;font-weight:600;letter-spacing:-.025em;color:var(--text);line-height:1.3;margin-bottom:12px">${esc(row.subject || '(geen onderwerp)')}</div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="window.__emailReply()" style="gap:6px">${ICO.reply}Beantwoorden</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailReplyAll()" style="gap:6px">${ICO.replyAll}Allen</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailFwd()" style="gap:6px">${ICO.forward}Doorsturen</button>
        <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
        <button class="icon-btn" title="Markeer ongelezen" onclick="window.__emailMarkUnread()" style="width:28px;height:28px">${ICO.mail}</button>
        <button class="icon-btn" title="${isFlagged ? 'Vlag verwijderen' : 'Vlag toevoegen'}" onclick="window.__emailFlagToggle()" style="width:28px;height:28px;color:${isFlagged ? TOK.amber : 'inherit'}">${ICO.flag}</button>
        <button class="icon-btn" title="Archiveren" onclick="window.__emailArchive()" style="width:28px;height:28px">${ICO.archive}</button>
        <button class="icon-btn" title="Verwijderen" onclick="window.__emailTrash()" style="width:28px;height:28px">${ICO.trash}</button>
        <div style="position:relative;margin-left:auto">
          <button class="icon-btn" title="Meer" onclick="window.__emailToggleMore()" style="width:28px;height:28px">${ICO.dots}</button>
          ${_ui.moreMenuOpen ? _moreMenu(row) : ''}
        </div>
      </div>
    </div>`;
  }
  function _moreMenu(row) {
    const items = [
      { l: 'Koppel aan klant', k: 'link',   wired: true },
      { l: 'Verplaats naar…',  k: 'move',   wired: false },
      { l: 'Afdrukken',        k: 'print',  wired: true },
      { l: 'Origineel bekijken', k: 'src',  wired: false },
    ];
    return `<div style="position:absolute;top:32px;right:0;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:${TOK.r};box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:20;padding:4px 0">
      ${items.map((it) => `<button style="width:100%;text-align:left;padding:7px 14px;background:none;border:none;color:var(--text);font-size:12.5px;cursor:${it.wired ? 'pointer' : 'default'};opacity:${it.wired ? '1' : '.55'};display:flex;align-items:center;justify-content:space-between" onclick="window.__emailMoreDo('${esc(it.k)}')">
        <span>${esc(it.l)}</span>
        ${!it.wired ? '<span style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">wip</span>' : ''}
      </button>`).join('')}
    </div>`;
  }
  function _readMeta(row) {
    const dispName = row.from_name || row.from_address || '—';
    const mbLabel = MAILBOXES.find((m) => m.slug === row.mailbox);
    return `<div style="padding:14px 22px;border-bottom:1px solid var(--border);background:var(--surface);display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center">
      ${av(dispName, 38)}
      <div style="min-width:0">
        <div style="font-size:14px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(dispName)}${row.from_address && row.from_name ? ` <span style="font-weight:400;color:var(--text-3);font-size:12.5px">&lt;${esc(row.from_address)}&gt;</span>` : ''}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">aan <span style="color:var(--text-2)">${esc(mbLabel ? mbLabel.addr : (row.mailbox || '—'))}</span></div>
      </div>
      <div style="text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <span style="font-size:12px;color:var(--text-3);font-family:${TOK.mono}">${esc(fmtDateFull(row.date_received))}</span>
        ${row.customer_id
          ? `<button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="window.__emailOpenKlant('${esc(row.customer_id)}')">Open klant-dossier →</button>`
          : `<button class="btn btn-ghost btn-sm" style="font-size:11.5px;color:${TOK.m}" onclick="window.__emailKoppelKlant()">+ Koppel klant</button>`}
      </div>
    </div>`;
  }
  // BODY: render sanitized HTML via <iframe sandbox srcdoc> = 2e verdedigingslaag.
  // Fallback naar plaintext-render als er geen safe HTML is.
  function _bodyBlock(body, row) {
    const attachments = asArr(body.attachments);
    const hasSafeHtml = body.body_html_safe && String(body.body_html_safe).trim().length > 0;
    const imgBlocked = Number(body.external_images_blocked || 0);
    const showImgs = !!_ui.showImages[row.id];
    let bodyRender;
    if (hasSafeHtml) {
      // srcdoc met sandbox (geen allow-scripts) — browser blokkeert alle JS binnen iframe.
      let html = String(body.body_html_safe);
      if (showImgs) {
        // Herstel externe images vanuit data-orig-src.
        html = html.replace(/data-orig-src="([^"]+)"[^>]*data-blocked-external="1"/g,
          (m, src) => `src="${src.replace(/"/g, '&quot;')}"`);
        html = html.replace(/src="data:image\/svg\+xml;utf8,%3Csvg[^"]*"\s*/g, '');
      }
      const srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;padding:22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.65;color:#1F2937;background:#fff;max-width:900px}p{margin-bottom:14px}img{max-width:100%;height:auto}a{color:#3B82F6}table{border-collapse:collapse}</style></head><body>${html}</body></html>`;
      bodyRender = `<iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(srcdoc)}" style="width:100%;min-height:400px;border:none;background:#fff" onload="try{this.style.height=(this.contentWindow.document.body.scrollHeight+40)+'px'}catch(e){}"></iframe>`;
      if (imgBlocked > 0 && !showImgs) {
        bodyRender = `<div style="padding:10px 22px;background:${TOK.amberSoft};border:1px solid ${TOK.amber};border-radius:${TOK.rSm};margin:16px 22px 0;font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:10px"><span>${ICO.img}</span><span style="flex:1">${imgBlocked} externe afbeeldingen zijn geblokkeerd om trackers te voorkomen.</span><button class="btn btn-ghost btn-sm" onclick="window.__emailShowImages('${esc(row.id)}')" style="color:${TOK.amber}">Afbeeldingen tonen</button></div>` + bodyRender;
      }
    } else {
      bodyRender = `<div style="padding:22px;max-width:900px;margin:0 auto">
        <div style="font-size:14px;line-height:1.65;color:var(--text-2)"><p style="margin-bottom:14px">${safePlainText(body.text || '')}</p></div>
      </div>`;
    }
    return `<div>${bodyRender}${attachments.length > 0 ? _attStrip(attachments, row) : ''}</div>`;
  }
  function _attStrip(attachments, row) {
    return `<div style="margin:22px 22px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${attachments.map((a) => `
          <a href="/api/email-attachment?mailbox=${encodeURIComponent(row.mailbox + '@deforexopleiding.nl')}&uid=${encodeURIComponent(row.imap_uid)}&index=${encodeURIComponent(a.index)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface);text-decoration:none;color:var(--text);font-size:12px" onmouseover="this.style.borderColor='${TOK.m}'" onmouseout="this.style.borderColor='var(--border)'">
            <span style="width:28px;height:28px;border-radius:${TOK.rSm};background:${TOK.roseSoft};color:${TOK.rose};display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICO.file}</span>
            <span style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.filename || 'bijlage')}</span>
            <span style="font-size:10.5px;color:var(--text-3);font-family:${TOK.mono}">${(a.size / 1024).toFixed(1)} KB</span>
          </a>
        `).join('')}
      </div>
    </div>`;
  }
  function _aiSuggestCard(row) {
    const st = _live.aiDraft;
    const draft = st.data[row.id];
    const busy = st.loading[row.id];
    const err  = st.error[row.id];
    return `<div style="margin:20px 22px 22px;padding:16px 18px;background:${TOK.violetSoft};border:1px solid ${TOK.violetLine};border-radius:${TOK.rLg}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:${draft || err || busy ? '12px' : '0'}">
        <span style="width:26px;height:26px;border-radius:50%;background:${TOK.violet};color:#fff;display:flex;align-items:center;justify-content:center">${ICO.sparkle}</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:${TOK.violet}">Voorgesteld antwoord</div>
          <div style="font-size:11px;color:var(--text-3)">${draft ? 'Concept gegenereerd — bewerk of gebruik' : (busy ? 'AI genereert…' : err ? 'Fout bij genereren' : 'Klik "Genereer" om een concept te maken')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:4px">
          ${['vriendelijk','zakelijk','kort','streng'].map((t) => {
            const on = _ui.aiTone === t;
            return `<button class="tone-chip" style="padding:2px 8px;border:1px solid ${on ? TOK.violet : TOK.violetLine};background:${on ? TOK.violet : 'transparent'};color:${on ? '#fff' : TOK.violet};border-radius:20px;font-size:10px;font-weight:${on ? '600' : '500'};cursor:pointer" onclick="window.__emailAiSetToneAndRegen('${t}','${esc(row.id)}')">${t}</button>`;
          }).join('')}
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__emailAiGenReader('${esc(row.id)}')" style="color:${TOK.violet};font-size:11.5px;gap:5px">${ICO.sparkle}${busy ? 'Bezig…' : (draft ? 'Opnieuw' : 'Genereer')}</button>
        </div>
      </div>
      ${err ? `<div style="padding:10px;background:${TOK.roseSoft};color:${TOK.rose};border-radius:${TOK.rSm};font-size:12px">${esc(err)}</div>` : ''}
      ${draft ? `
        <div style="padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:${TOK.rSm};font-size:13px;line-height:1.5;color:var(--text);white-space:pre-wrap;max-height:280px;overflow-y:auto">${esc(draft.body)}</div>
        <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:10px">
          <button class="btn btn-ghost btn-sm" onclick="window.__emailAiClear('${esc(row.id)}')">Negeren</button>
          <button class="btn btn-primary btn-sm" style="background:${TOK.violet};border-color:${TOK.violet}" onclick="window.__emailAiUse('${esc(row.id)}')">Gebruiken →</button>
        </div>
      ` : ''}
    </div>`;
  }

  function _composeModal() {
    const c = _ui.compose;
    const send = _ui.lastSend;
    if (_ui.composeMinimized) return _composeMinBar();
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.42);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:flex-end;justify-content:flex-end;padding:0 26px 30px 0" onclick="window.__emailCloseCompose()">
      <div style="background:var(--surface);width:660px;max-width:calc(100vw - 52px);height:min(78vh, calc(100dvh - 90px));border-radius:${TOK.rLg};box-shadow:0 -8px 32px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;animation:slideUp .28s cubic-bezier(.16,1,.3,1)" onclick="event.stopPropagation()">
        <div style="padding:12px 18px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;border-radius:${TOK.rLg} ${TOK.rLg} 0 0">
          <div style="font-size:14px;font-weight:600">${_ui.composeMode === 'reply' ? 'Beantwoorden' : _ui.composeMode === 'replyall' ? 'Beantwoorden aan allen' : _ui.composeMode === 'fwd' ? 'Doorsturen' : 'Nieuw bericht'}${c.draft_id ? ' — concept opgeslagen' : ''}</div>
          <div style="display:flex;gap:4px">
            <button class="icon-btn" title="Minimaliseer" onclick="window.__emailComposeMin()" style="width:24px;height:24px">${ICO.min}</button>
            <button class="icon-btn" title="Sluiten" onclick="window.__emailCloseCompose()" style="width:24px;height:24px">${ICO.x}</button>
          </div>
        </div>
        <div style="padding:12px 18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:2px;min-height:0">
          ${_composeField('Van', _composeFromSelect(c))}
          ${_composeField('Aan', _composeToInput(c), _ccBccToggle())}
          ${_ui.ccBccOpen ? _composeField('CC',  `<input type="text" value="${esc(c.cc)}" oninput="window.__emailComposeField('cc', this.value)" placeholder="cc@voorbeeld.nl" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`) : ''}
          ${_ui.ccBccOpen ? _composeField('BCC', `<input type="text" value="${esc(c.bcc)}" oninput="window.__emailComposeField('bcc', this.value)" placeholder="bcc@voorbeeld.nl" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`) : ''}
          ${_composeField('Onderwerp', `<input type="text" value="${esc(c.subject)}" oninput="window.__emailComposeField('subject', this.value)" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`)}
          ${_ui.composeMode !== 'new' && c.to ? _recipChip(c.to) : ''}
          <div style="padding:12px 0 4px;flex:1;display:flex;flex-direction:column;min-height:180px">
            <div contenteditable="true" oninput="window.__emailComposeBody(this.innerHTML)" data-placeholder="Typ je bericht…" style="width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface);color:var(--text);font-size:13.5px;line-height:1.55;min-height:180px;font-family:inherit;flex:1;outline:none;overflow-y:auto">${c.body_html || ''}</div>
          </div>
          ${_composeSigStrip()}
          ${send ? _sendResultBlock(send) : ''}
        </div>
        <div style="padding:10px 18px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px">
          <button class="btn btn-primary" ${_ui.sendBusy ? 'disabled' : ''} onclick="window.__emailSend()" style="gap:6px">${ICO.send}${_ui.sendBusy ? 'Versturen…' : 'Versturen'}</button>
          <button class="icon-btn" title="Bijlage toevoegen" onclick="window.__emailComposeAttach()" style="width:28px;height:28px">${ICO.attach}</button>
          <button class="icon-btn" title="Sjabloon invoegen" onclick="window.__emailComposeTemplate()" style="width:28px;height:28px">${ICO.template}</button>
          <button class="icon-btn" title="AI-suggestie" onclick="window.__emailComposeAi()" style="width:28px;height:28px;color:${TOK.violet}">${ICO.sparkle}</button>
          <div style="margin-left:auto;font-size:11px;color:var(--text-3);font-family:${TOK.mono}">${_ui.draftMigrationRequired ? '⚠ Concepten uit — migratie vereist' : (c.draft_id ? '● Concept auto-saved' : (_ui.draftDirty ? '● Wijzigingen…' : ''))}</div>
          <button class="icon-btn" title="Verwerpen" onclick="window.__emailDiscardCompose()" style="width:28px;height:28px">${ICO.trash}</button>
        </div>
      </div>
    </div>
    <style>@keyframes slideUp { from { transform:translateY(30px); opacity:0 } to { transform:translateY(0); opacity:1 } } @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.7} } [contenteditable=true]:empty:before { content: attr(data-placeholder); color:var(--text-3); pointer-events:none; }</style>`;
  }
  function _composeMinBar() {
    return `<div style="position:fixed;bottom:0;right:26px;background:var(--surface);border:1px solid var(--border);border-radius:${TOK.rLg} ${TOK.rLg} 0 0;box-shadow:0 -4px 12px rgba(0,0,0,.12);padding:8px 14px;display:flex;align-items:center;gap:10px;z-index:1000;cursor:pointer" onclick="window.__emailComposeRestore()">
      <span style="font-size:13px;font-weight:500">Concept: ${esc(_ui.compose.subject || '(geen onderwerp)')}</span>
      <button class="icon-btn" onclick="event.stopPropagation();window.__emailCloseCompose()" style="width:22px;height:22px">${ICO.x}</button>
    </div>`;
  }
  function _composeField(label, ctrl, right) {
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <label style="flex:0 0 44px;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">${esc(label)}</label>
      <div style="flex:1;min-width:0">${ctrl}</div>
      ${right || ''}
    </div>`;
  }
  function _composeFromSelect(c) {
    return `<select onchange="window.__emailComposeField('from_mailbox', this.value)" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;cursor:pointer;outline:none">
      ${MAILBOXES.map((m) => `<option value="${esc(m.addr)}" ${c.from_mailbox === m.addr ? 'selected' : ''}>${esc(m.label)} — ${esc(m.addr)}</option>`).join('')}
    </select>`;
  }
  function _composeToInput(c) {
    return `<input type="email" value="${esc(c.to)}" oninput="window.__emailComposeField('to', this.value)" placeholder="ontvanger@voorbeeld.nl" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`;
  }
  function _ccBccToggle() {
    return `<button class="btn btn-ghost btn-sm" style="font-size:11px;flex-shrink:0" onclick="window.__emailToggleCcBcc()">${_ui.ccBccOpen ? '– CC/BCC' : '+ CC/BCC'}</button>`;
  }
  function _recipChip(to) {
    return `<div style="padding:6px 0"><span style="display:inline-flex;align-items:center;gap:6px;padding:3px 4px 3px 3px;background:var(--surface-2);border:1px solid var(--border);border-radius:20px;font-size:12px">
      ${av(to, 20)}
      <span>${esc(to)}</span>
      <button class="icon-btn" style="width:18px;height:18px" onclick="window.__emailComposeField('to','')">${ICO.x}</button>
    </span></div>`;
  }
  function _composeSigStrip() {
    const c = _ui.compose;
    const sig = SIGNATURES.find((s) => s.key === c.signature) || SIGNATURES[0];
    return `<div style="margin-top:8px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:${TOK.rSm};display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--text-2);flex-wrap:wrap">
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px;color:var(--text-3)">Handtekening</span>
      <select onchange="window.__emailComposeField('signature', this.value)" style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:11px">
        ${SIGNATURES.map((s) => `<option value="${s.key}" ${c.signature === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>
      ${sig && sig.text ? `<span style="margin-left:12px;color:var(--text-3);font-style:italic;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sig.text.trim().replace(/\n/g, ' · '))}</span>` : `<span style="margin-left:12px;color:var(--text-3)">(geen handtekening)</span>`}
    </div>`;
  }
  function _sendResultBlock(send) {
    if (!send.ok) return `<div style="padding:10px 12px;background:${TOK.roseSoft};border:1px solid ${TOK.roseLine};color:${TOK.rose};border-radius:${TOK.rSm};font-size:12.5px;margin-top:10px">⚠ Verzenden mislukt: ${esc(send.error || 'onbekende fout')}</div>`;
    if (send.guarded) return `<div style="padding:10px 12px;background:${TOK.amberSoft};border:1px solid ${TOK.amber};color:var(--text);border-radius:${TOK.rSm};font-size:12.5px;line-height:1.5;margin-top:10px">✓ Verstuurd (guarded — env <b>${esc(send.env)}</b>)<br>→ Doel: <b>${esc(send.guard_target)}</b><br>→ Origineel to: ${esc(send.original_to || '—')}</div>`;
    return `<div style="padding:10px 12px;background:${TOK.emeraldSoft};border:1px solid ${TOK.emerald};color:${TOK.emerald};border-radius:${TOK.rSm};font-size:12.5px;margin-top:10px">✓ Verstuurd naar ${esc(send.original_to || _ui.compose.to)} (env ${esc(send.env || 'production')})</div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═══════════════════════════════════════════════════════════════════════
  window.__emailSetFolder = (slug) => { _ui.folder = slug; _ui.offset = 0; _ui.selectedId = null; _ui.selectedRows = {}; _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  window.__emailSetMailbox = (slug) => {
    _ui.mailboxSlug = slug; _ui.offset = 0; _ui.selectedId = null; _ui.selectedRows = {};
    _live.inbox.data = null; _live.inbox.key = null; _live.counts.data = null;
    if (slug) { const m = MAILBOXES.find((x) => x.slug === slug); if (m) _ui.compose.from_mailbox = m.addr; }
    if (render) render();
  };
  window.__emailSetFilter = (f) => { _ui.filter = f; _ui.offset = 0; _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  window.__emailSetSort   = (s) => { _ui.sort = s; _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  let _searchDebounceT = null;
  window.__emailSetSearchDebounced = (v) => {
    if (_searchDebounceT) clearTimeout(_searchDebounceT);
    _searchDebounceT = setTimeout(() => {
      _ui.search = String(v || '').trim();
      _ui.offset = 0; _live.inbox.data = null; _live.inbox.key = null;
      if (render) render();
    }, 400);
  };
  window.__emailRefresh = () => { _live.inbox.data = null; _live.inbox.error = null; _live.inbox.key = null; _live.counts.data = null; if (render) render(); };
  window.__emailPage = (dir) => { _ui.offset = Math.max(0, _ui.offset + dir * PAGE_SIZE); _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  // v2 email-round bug-4: snapshot + restore list-scrollTop bij open van een
  // mail. De list-scroller (#emailListScroll) is een nested div die bij elke
  // render() vernieuwd wordt → scrollTop reset naar 0. App-shell's scroll-
  // restore werkt alleen op #content, niet op deze nested container.
  window.__emailListScrollSnap = (top) => { _ui._listScrollTop = Number(top) || 0; };
  window.__emailOpen = (rid) => {
    _ui.selectedId = rid;
    _ui.moreMenuOpen = false;
    // Snapshot BEFORE render (in case scroll-listener miste een frame).
    try {
      const el = document.getElementById('emailListScroll');
      if (el) _ui._listScrollTop = el.scrollTop;
    } catch (_) {}
    if (render) render();
    // Restore NA render — 2 rAF zodat de layout definitief is.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try {
        const el = document.getElementById('emailListScroll');
        if (el && typeof _ui._listScrollTop === 'number') el.scrollTop = _ui._listScrollTop;
      } catch (_) {}
    }));
  };
  window.__emailReloadBody = (rid) => { delete _live.body.data[rid]; delete _live.body.error[rid]; if (render) render(); };
  window.__emailShowImages = (rid) => { _ui.showImages[rid] = true; if (render) render(); };
  window.__emailMarkUnread = () => { const row = currentRow(); if (row) markRead(row, false); };
  window.__emailFlagToggle = () => { const row = currentRow(); if (row) statusUpdate([row.id], row.flagged ? 'unflag' : 'flag'); };
  window.__emailArchive = () => {
    const row = currentRow(); if (!row) return;
    if (row._source === 'draft') { _showToastLocal('Concepten kunnen niet gearchiveerd worden — gebruik Verwijderen.', 'info'); return; }
    statusUpdate([row.id], 'archive');
  };
  window.__emailTrash   = () => {
    const row = currentRow(); if (!row) return;
    // Concepten wonen in email_drafts — daar hoort DELETE, geen email_messages-status.
    if (row._source === 'draft') { deleteDraftIds([row._draft_id || row.id]); return; }
    statusUpdate([row.id], 'trash');
  };
  async function deleteDraftIds(ids) {
    if (!ids || ids.length === 0) return;
    const key = 'bulk:draft-delete';
    if (_ui.statusBusy[key]) return;
    _ui.statusBusy[key] = true; if (render) render();
    let okCount = 0, failCount = 0;
    for (const id of ids) {
      try {
        await deleteDraft(id);
        okCount++;
      } catch (e) { failCount++; console.warn('[email-v2] draft-delete fail', id, e?.message); }
    }
    // Optimistic UI: verwijder uit lijst + clear selectie.
    const items = asArr(_live.inbox.data?.items);
    if (items.length) {
      _live.inbox.data.items = items.filter((x) => !ids.includes(x._draft_id || x.id));
    }
    ids.forEach((id) => { delete _ui.selectedRows[id]; });
    if (_ui.selectedId && ids.includes(_ui.selectedId)) _ui.selectedId = null;
    // Als compose openstond op een verwijderd concept: sluit + clear.
    if (_ui.composeOpen && _ui.compose.draft_id && ids.includes(_ui.compose.draft_id)) {
      _ui.composeOpen = false; _ui.composeMinimized = false;
      _ui.compose = { from_mailbox: _ui.compose.from_mailbox, to: '', cc: '', bcc: '', subject: '', body_html: '', body_text: '', email_id: null, signature: 'standaard', draft_id: null };
    }
    _live.counts.data = null;
    _ui.statusBusy[key] = false;
    if (failCount > 0) _showToastLocal(okCount + ' verwijderd, ' + failCount + ' mislukt.', 'warn');
    else if (okCount > 0) _showToastLocal(okCount + (okCount === 1 ? ' concept verwijderd.' : ' concepten verwijderd.'), 'info');
    if (render) render();
  }
  window.__emailToggleSel = (rid) => { _ui.selectedRows[rid] = !_ui.selectedRows[rid]; if (render) render(); };
  window.__emailBulkClear = () => { _ui.selectedRows = {}; if (render) render(); };
  window.__emailBulkAction = (a) => {
    const ids = Object.keys(_ui.selectedRows).filter((k) => _ui.selectedRows[k]);
    if (ids.length === 0) return;
    if (a === 'read' || a === 'unread') { bulkMarkRead(ids, a === 'read'); return; }
    // Concepten (folder='draft') horen naar email_drafts, NIET naar email_messages-status.
    // Bug: pre-fix stuurde de trash-actie naar email-status-update -> "Geen matches op ids"
    // omdat email_drafts.id niet in email_messages voorkomt.
    if (_ui.folder === 'draft') {
      if (a === 'trash') {
        const items = asArr(_live.inbox.data?.items);
        const rowsById = new Map(items.map((r) => [r.id, r]));
        const draftIds = ids.map((id) => {
          const r = rowsById.get(id);
          return r ? (r._draft_id || r.id) : id;
        });
        deleteDraftIds(draftIds);
      } else {
        _showToastLocal('Deze actie is niet beschikbaar op concepten.', 'info');
      }
      return;
    }
    statusUpdate(ids, a);
  };
  async function bulkMarkRead(ids, seen) {
    const key = 'bulk:read';
    if (_ui.statusBusy[key]) return;
    _ui.statusBusy[key] = true; if (render) render();
    // Groepeer per mailbox — één mark-read-call per mailbox met alle uids.
    const items = asArr(_live.inbox.data?.items);
    const rowsById = new Map(items.map((r) => [r.id, r]));
    const perMailbox = {};
    ids.forEach((id) => {
      const r = rowsById.get(id);
      if (!r || !r.mailbox || r.imap_uid == null) return;
      const mb = r.mailbox + '@deforexopleiding.nl';
      (perMailbox[mb] = perMailbox[mb] || []).push(r.imap_uid);
    });
    let okCount = 0, failCount = 0;
    for (const mb of Object.keys(perMailbox)) {
      const j = await tryFetch('bulk-mark-read:' + mb, '/api/mark-read', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailbox: mb, uids: perMailbox[mb], seen: !!seen }),
      }, 15000);
      if (j && !j.__error && !j.error) { okCount += Number(j.count || perMailbox[mb].length); }
      else { failCount += perMailbox[mb].length; }
    }
    // Optimistic UI-update.
    ids.forEach((id) => {
      const r = rowsById.get(id);
      if (r) r.is_read = !!seen;
    });
    _ui.selectedRows = {};
    _live.counts.data = null;
    _ui.statusBusy[key] = false;
    if (failCount > 0) _showToastLocal(okCount + ' gemarkeerd, ' + failCount + ' mislukt.', 'warn');
    else if (okCount > 0) _showToastLocal(okCount + ' gemarkeerd als gelezen.', 'info');
    if (render) render();
  }
  window.__emailToggleMore = () => { _ui.moreMenuOpen = !_ui.moreMenuOpen; if (render) render(); };
  window.__emailMoreDo = (k) => {
    _ui.moreMenuOpen = false;
    if (k === 'print') { window.print(); if (render) render(); return; }
    if (k === 'link') { window.__emailKoppelKlant(); return; }
    _showToastLocal('Actie "' + k + '" is nog niet beschikbaar.', 'info');
    if (render) render();
  };
  window.__emailSettings = () => {
    _openInfo('Instellingen', 'Handtekening kan al gekozen worden in het compose-venster. Regels/notificaties/handtekening-beheer komen in Fase 3.', 'info');
  };
  window.__emailOpenKlant = (customerId) => {
    if (!customerId) return;
    // v2-route: navigate binnen klanten-v2-shell naar klant-detail.
    if (window.DFO && typeof window.DFO.setActiveItem === 'function') {
      window.DFO.setActiveItem('detail', { id: customerId });
    } else {
      try { window.location.hash = '#detail/customer/' + encodeURIComponent(customerId); }
      catch (e) { console.warn('[email-v2] navigate fail', e); }
    }
    _showToastLocal('Openen klant-dossier…', 'info');
  };
  window.__emailKoppelKlant = () => {
    // Voor Fase 2B: opent detail-view als er al customer_id is; anders in-UI melding
    // (NIET blocking alert — die bevriest de compose-modal in Chrome).
    const row = currentRow();
    if (row && row.customer_id) { window.__emailOpenKlant(row.customer_id); return; }
    _openInfo(
      'Klant-koppeling — komt in Fase 3',
      'Handmatig koppelen van deze e-mail-thread aan een klant zit in Fase 3 van de v2-email-module. Voor nu: open de klanten-module, zoek de klant en de sync-cron matcht ze automatisch op e-mailadres.',
      'info'
    );
  };
  window.__emailNewCompose = () => {
    _ui.composeMode = 'new'; _ui.composeMinimized = false;
    _ui.compose = { from_mailbox: _ui.compose.from_mailbox, to: '', cc: '', bcc: '', subject: '', body_html: '', body_text: '', email_id: null, signature: 'standaard', draft_id: null };
    _ui.composeOpen = true; _ui.lastSend = null; _ui.ccBccOpen = false;
    _ui.draftMigrationRequired = false;
    if (render) render();
  };
  async function _replyState(mode) {
    const row = currentRow();
    if (!row) { _showToastLocal('Selecteer eerst een bericht.', 'info'); return; }
    const from = MAILBOXES.find((m) => m.slug === row.mailbox);
    const emailId = (row.mailbox && row.imap_uid != null) ? `${row.mailbox}@deforexopleiding.nl:${row.imap_uid}` : null;
    _ui.composeMode = mode; _ui.composeMinimized = false;
    // v2 email-round bug-3: zoek eerst een bestaand concept voor deze mail
    // (in_reply_to_email_id) zodat Beantwoorden het opgeslagen concept
    // teruglaadt i.p.v. leeg te openen. Fail-soft: als de lookup faalt of
    // niet gevonden, val terug op verse compose.
    let existingDraft = null;
    if (emailId && (mode === 'reply' || mode === 'replyall')) {
      try {
        const j = await tryFetch('draft-find', '/api/email-drafts?in_reply_to_email_id=' + encodeURIComponent(emailId));
        if (j && !j.__error && j.item) existingDraft = j.item;
      } catch (_) { /* fail-soft */ }
    }
    if (existingDraft) {
      _ui.compose = {
        from_mailbox: existingDraft.from_mailbox || (from ? from.addr : _ui.compose.from_mailbox),
        to:          existingDraft.to_address    || row.from_address || '',
        cc:          existingDraft.cc_address    || '',
        bcc:         existingDraft.bcc_address   || '',
        subject:     existingDraft.subject       || ((/^(re|fwd?):/i.test(row.subject || '') ? row.subject : (mode === 'fwd' ? 'Fwd: ' : 'Re: ') + (row.subject || ''))),
        body_html:   existingDraft.body_html     || '',
        body_text:   '',
        email_id:    emailId,
        signature:   'standaard',
        draft_id:    existingDraft.id || null,
      };
      _ui.ccBccOpen = !!(_ui.compose.cc || _ui.compose.bcc);
    } else {
      _ui.compose = {
        from_mailbox: from ? from.addr : _ui.compose.from_mailbox,
        to: row.from_address || '', cc: '', bcc: '',
        subject: /^(re|fwd?):/i.test(row.subject || '') ? row.subject : (mode === 'fwd' ? 'Fwd: ' : 'Re: ') + (row.subject || ''),
        body_html: '', body_text: '',
        email_id: emailId,
        signature: 'standaard', draft_id: null,
      };
      _ui.ccBccOpen = false;
    }
    _ui.composeOpen = true; _ui.lastSend = null;
    if (render) render();
  }
  window.__emailReply    = () => _replyState('reply');
  window.__emailReplyAll = () => _replyState('replyall');
  window.__emailFwd      = () => { _replyState('fwd'); _ui.compose.to = ''; if (render) render(); };
  window.__emailCloseCompose = () => {
    _ui.composeOpen = false; _ui.composeMinimized = false; _ui.lastSend = null; _ui.ccBccOpen = false;
    // KRITIEK: als selectedId een draft is, ontkoppel 'm — anders zou _reader() bij de
    // volgende render de draft opnieuw open-schedulen (backdrop blijft klik-dood).
    if (_ui.folder === 'draft') { _ui.selectedId = null; }
    else {
      const cur = currentRow();
      if (cur && cur._source === 'draft') _ui.selectedId = null;
    }
    if (render) render();
  };
  window.__emailDiscardCompose = () => {
    // In-UI confirm — geen native confirm() die de compose-modal bevriest.
    _openConfirm('Concept verwijderen? Dit kan niet ongedaan gemaakt worden.', () => {
      const discardedDraftId = _ui.compose.draft_id;
      if (discardedDraftId) deleteDraft(discardedDraftId).catch(() => {});
      _ui.composeOpen = false;
      _ui.compose = { from_mailbox: _ui.compose.from_mailbox, to: '', cc: '', bcc: '', subject: '', body_html: '', body_text: '', email_id: null, signature: 'standaard', draft_id: null };
      _ui.draftMigrationRequired = false;
      // Verwijder de discarded draft uit de zichtbare lijst + clear selectedId
      // (anders zou _reader() 'm meteen opnieuw willen openen).
      if (discardedDraftId) {
        const items = asArr(_live.inbox.data?.items);
        if (items.length) _live.inbox.data.items = items.filter((x) => (x._draft_id || x.id) !== discardedDraftId);
        if (_ui.selectedId && (_ui.selectedId === discardedDraftId || _ui.selectedId === String(discardedDraftId))) _ui.selectedId = null;
      }
      const cur = currentRow();
      if (cur && cur._source === 'draft') _ui.selectedId = null;
      _live.counts.data = null;
      if (render) render();
    });
  };
  window.__emailComposeAttach   = () => { _showToastLocal('Bijlage toevoegen komt in Fase 3 (multipart-upload via IMAP).', 'info'); };
  // v2 email-round DEEL 2: templates-picker. Klik → laad templates uit
  // /api/email-templates (fail-soft), toon modale keuze, apply op body.
  async function fetchTemplates() {
    if (_live.templates.loading) return;
    if (_live.templates.data && Array.isArray(_live.templates.data)) return; // cached
    _live.templates.loading = true; _live.templates.error = null;
    const j = await tryFetch('email-templates', '/api/email-templates', undefined, 8000);
    _live.templates.loading = false;
    if (j && j.__error) { _live.templates.error = j.__error; }
    else if (j?.error && /migratie/i.test(String(j.error || ''))) { _live.templates.error = j.error; }
    else { _live.templates.data = Array.isArray(j?.items) ? j.items : []; }
  }
  window.__emailComposeTemplate = async () => {
    await fetchTemplates();
    if (_live.templates.error) {
      _openInfo('Sjablonen niet beschikbaar', _live.templates.error, 'warn');
      return;
    }
    _ui.templatePickerOpen = true;
    if (render) render();
  };
  window.__emailTemplateApply = (id) => {
    const list = Array.isArray(_live.templates.data) ? _live.templates.data : [];
    const t = list.find((x) => x.id === id);
    if (!t) { _ui.templatePickerOpen = false; if (render) render(); return; }
    // Vul body_html met template-body. Als subject leeg is en template heeft
    // 'r een, vul die ook in. NIET overschrijven van bestaande subject om
    // typefouten te voorkomen.
    if (t.subject && !_ui.compose.subject) _ui.compose.subject = t.subject;
    _ui.compose.body_html = (_ui.compose.body_html || '') + (t.body_html || t.body_text || '');
    _ui.draftDirty = true;
    _ui.templatePickerOpen = false;
    saveDraftDebounced();
    if (render) render();
    _showToastLocal(`Sjabloon "${t.name}" ingevoegd.`, 'success');
  };
  window.__emailTemplateCancel = () => { _ui.templatePickerOpen = false; if (render) render(); };
  window.__emailComposeAi       = () => { _showToastLocal('AI in compose: open eerst een bericht en gebruik "Voorgesteld antwoord" in de reader.', 'info'); };
  window.__emailConfirmOk     = () => { const d = _ui.confirmDialog; _ui.confirmDialog = null; if (render) render(); try { if (d?.onOk) d.onOk(); } catch (e) { console.warn('[email-v2] confirm onOk fail', e); } };
  window.__emailConfirmCancel = () => { const d = _ui.confirmDialog; _ui.confirmDialog = null; if (render) render(); try { if (d?.onCancel) d.onCancel(); } catch (_) {} };
  window.__emailInfoClose     = () => { _ui.infoDialog = null; if (render) render(); };
  window.__emailComposeMin = () => { _ui.composeMinimized = true; if (render) render(); };
  window.__emailComposeRestore = () => { _ui.composeMinimized = false; if (render) render(); };
  window.__emailComposeField = (k, v) => { _ui.compose[k] = v; _ui.draftDirty = true; saveDraftDebounced(); };
  window.__emailComposeBody = (html) => { _ui.compose.body_html = html; _ui.draftDirty = true; saveDraftDebounced(); };
  window.__emailToggleCcBcc = () => { _ui.ccBccOpen = !_ui.ccBccOpen; if (render) render(); };
  window.__emailSend = () => { sendMail(); };
  window.__emailOpenDraftFromRow = (row) => {
    // Open draft in compose.
    _ui.composeMode = 'new'; _ui.composeMinimized = false;
    _ui.compose = {
      from_mailbox: (row.from_address || _ui.compose.from_mailbox),
      to: row.to_address || '', cc: row._draft_cc || '', bcc: row._draft_bcc || '',
      subject: row.subject || '', body_html: row._draft_body || '', body_text: '',
      email_id: row._draft_reply_id || null,
      signature: 'standaard', draft_id: row._draft_id || null,
    };
    _ui.composeOpen = true; _ui.lastSend = null; _ui.ccBccOpen = !!(_ui.compose.cc || _ui.compose.bcc);
    if (render) render();
  };
  // AI-card handlers (in reader)
  window.__emailAiGenReader   = (rid) => { const items = asArr(_live.inbox.data?.items); const row = items.find((x) => x.id === rid); if (row) aiRegenerateInReader(row); };
  window.__emailAiSetToneAndRegen = (t, rid) => { _ui.aiTone = t; const items = asArr(_live.inbox.data?.items); const row = items.find((x) => x.id === rid); if (row) aiRegenerateInReader(row); };
  window.__emailAiClear = (rid) => { delete _live.aiDraft.data[rid]; delete _live.aiDraft.error[rid]; if (render) render(); };
  // ── Sanne-card handlers (Fase 2.1) ────────────────────────────────────
  window.__emailSanneUse = async (sugId, rowId) => {
    const st = _live.sanne.data[rowId]; if (!st || !st.suggestion) return;
    const s = st.suggestion;
    // Open reply-compose met Sanne-tekst 1-op-1
    _replyState('reply');
    _ui.compose.body_html = String(s.draft_body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    if (s.draft_subject && !_ui.compose.subject) _ui.compose.subject = s.draft_subject;
    // Optimistic status-update in de card + fire outcome-endpoint.
    st.suggestion.status = 'USED';
    if (render) render();
    sanneOutcome(sugId, 'used').catch(() => {});
  };
  window.__emailSanneEdit = async (sugId, rowId) => {
    const st = _live.sanne.data[rowId]; if (!st || !st.suggestion) return;
    const s = st.suggestion;
    _replyState('reply');
    _ui.compose.body_html = String(s.draft_body_text || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
    if (s.draft_subject && !_ui.compose.subject) _ui.compose.subject = s.draft_subject;
    st.suggestion.status = 'EDITED';
    if (render) render();
    sanneOutcome(sugId, 'edited').catch(() => {});
  };
  window.__emailSanneDismiss = async (sugId) => {
    // Verberg card door status-mutatie (DISMISSED valt buiten de whitelist).
    for (const rid of Object.keys(_live.sanne.data || {})) {
      const st = _live.sanne.data[rid];
      if (st?.suggestion?.id === sugId) { st.suggestion.status = 'DISMISSED'; }
    }
    if (render) render();
    sanneOutcome(sugId, 'dismissed').catch(() => {});
  };
  window.__emailAiUse = (rid) => {
    const draft = _live.aiDraft.data[rid]; if (!draft) return;
    // Open reply-compose met AI-draft in body.
    _replyState('reply');
    _ui.compose.body_html = String(draft.body || '').replace(/\n/g, '<br>');
    if (draft.subject && !_ui.compose.subject) _ui.compose.subject = draft.subject;
    if (render) render();
  };

  window.DFO.VIEWS['email/'] = emailView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('email');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('email');
  console.debug('[email-v2] v=17 — bug-4-fixes (mark-read DB persist, sanne null-guard, reply-concept reload, list-scroll preserve) + templates-picker + handtekening server-side.');
})();
