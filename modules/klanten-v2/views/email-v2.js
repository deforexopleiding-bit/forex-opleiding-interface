// modules/klanten-v2/views/email-v2.js
//
// v2 E-mail — Fase 2A PURE-UI PARITY (feat/v2-email, PR #1289).
//
// Alle styling-gaps t.o.v. prototype (docs/redesign/systeemprototype-v45.html
// r449-532 CSS + r2559-2746 view) opgeloofd zonder schema-wijzigingen.
// Data-clusters (HTML-sanitizer/AI-card-in-reader/nieuwe-mappen-endpoints/
// bulk-endpoints/handtekening/koppel-klant) komen in Fase 2B.
//
// Endpoints in gebruik (uit Fase 1):
//   /api/email-inbox-list  /api/email-body  /api/email-attachment
//   /api/mark-read  /api/email-send-v2 (met preview-guard) /api/email-ai-regenerate
//
// Fase 2A UI-toevoegingen:
//   - Rail 198px met folder-iconen, merkkleur-highlight, postvak-kleurdots,
//     Instellingen-sticky-bottom, "Nieuwe e-mail"-copy
//   - 7 mappen zichtbaar (Inbox/Ongelezen/Vlag/Concepten/Verzonden/Archief/Prullenbak)
//     — 4 niet-wired mappen tonen "Fase 2B"-badge en placeholder-body
//   - Lijst 352px met 2-koloms rij (checkbox+dot links + body rechts),
//     3px accent-strip op selectie, hover-state, monospace relatieve tijd,
//     paperclip-SVG, klantnaam-pill accent, filter-chips Alles/Ongelezen/Bijlage,
//     sort-select Nieuwste/Oudste/Afzender, sticky list-header
//   - Reader 2-laags header (read-head + meta) met 38px initialen-avatar,
//     grid-layout naam/adres/datum, monospace datum, "aan mailbox"-label,
//     actiebar met Vlag/Archief/Trash icon-btns + 3-dots more-menu (noop in 2A),
//     body 14px/lh1.65, attachment horizontale chip-strip met gekleurde icon,
//     nette empty-state
//   - Compose slide-up 660×78vh paneel rechtsonder (ipv center-modal),
//     header met minimize+close, inline Van/Aan met 44px labels,
//     CC/BCC toggle achter knop, recipient-chip met avatar bij reply,
//     footer met bijlage/sjabloon/AI icon-btns (noop hooks tot 2B),
//     tone-chips violet, scrim rgba(17,23,33,.42) + backdrop-filter blur
//   - Design-tokens --m/--m-soft/--r/--r-lg, IBM Plex Mono voor tijd,
//     rose #C22B3E / emerald #07835A / amber #B7791F fallbacks matchen prototype
//
// Registreert: DFO.VIEWS['email/'] = emailView.

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
    { slug: 'inbox',   label: 'Postvak IN',  icon: 'inbox',   wired: true  },
    { slug: 'unread',  label: 'Ongelezen',   icon: 'mail',    wired: true  },
    { slug: 'flag',    label: 'Met vlag',    icon: 'flag',    wired: false },
    { slug: 'draft',   label: 'Concepten',   icon: 'edit',    wired: false },
    { slug: 'sent',    label: 'Verzonden',   icon: 'send',    wired: true  },
    { slug: 'archive', label: 'Archief',     icon: 'archive', wired: false },
    { slug: 'trash',   label: 'Prullenbak',  icon: 'trash',   wired: false },
  ];
  const PAGE_SIZE = 50;

  const ICO = {
    inbox:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
    mail:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
    flag:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>`,
    edit:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
    send:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22 11 13 2 9z"/></svg>`,
    archive:`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`,
    trash:  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
    settings:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    search: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>`,
    paperclip:`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
    plus:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    reply:  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
    replyAll:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 17 2 12 7 7"/><polyline points="12 17 7 12 12 7"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/></svg>`,
    forward:`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>`,
    dots:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/></svg>`,
    x:      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    min:    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
    tick:   `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    file:   `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    sparkle:`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8L4 10.7l6.1 1.9L12 18l1.9-5.4 6.1-1.9-6.1-1.9z"/></svg>`,
  };

  const _live = {
    inbox: { loading: false, error: null, data: null, key: null },
    body:  { loading: {}, error: {}, data: {} },
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
    composeOpen: false,
    composeMinimized: false,
    composeMode: 'new',
    compose: {
      from_mailbox: 'info@deforexopleiding.nl',
      to: '', cc: '', bcc: '', subject: '', body: '', email_id: null,
    },
    ccBccOpen:  false,
    aiTone:     'vriendelijk',
    aiBusy:     false,
    sendBusy:   false,
    lastSend:   null,
    moreMenuOpen: false,
  };
  const _busy = {};

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
    const folderCfg = FOLDERS.find((f) => f.slug === _ui.folder);
    if (folderCfg && !folderCfg.wired) {
      st.data = { items: [], total: 0, hasMore: false, __placeholder: true };
      st.error = null; st.key = key;
      if (render) render();
      return;
    }
    st.loading = true; st.error = null; st.key = key;
    const params = [];
    if (_ui.mailboxSlug) params.push('mailbox=' + encodeURIComponent(_ui.mailboxSlug));
    if (_ui.folder === 'sent') params.push('folder=sent');
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
      st.data = { items, total: Number(j?.total || 0), hasMore: !!j?.hasMore };
    }
    if (render) render();
  }
  async function fetchBody(row) {
    if (!row || !row.mailbox || row.imap_uid == null) return;
    const rid = row.id;
    const st = _live.body;
    if (st.loading[rid] || st.data[rid]) return;
    st.loading[rid] = true; st.error[rid] = null;
    const j = await tryFetch('body:' + rid, '/api/email-body', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid }),
    }, 12000);
    st.loading[rid] = false;
    if (j && j.__error) st.error[rid] = j.__error;
    else st.data[rid] = j || null;
    if (render) render();
  }
  async function markRead(row, seen) {
    if (!row || !row.mailbox || row.imap_uid == null) return;
    if (_busy['read:' + row.id]) return;
    _busy['read:' + row.id] = true;
    const j = await tryFetch('mark-read', '/api/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid, seen: !!seen }),
    }, 8000);
    _busy['read:' + row.id] = false;
    if (j && !j.__error) {
      const items = asArr(_live.inbox.data?.items);
      const idx = items.findIndex((x) => x.id === row.id);
      if (idx >= 0) items[idx].is_read = !!seen;
      if (render) render();
    }
  }
  async function sendMail() {
    if (_ui.sendBusy) return;
    const c = _ui.compose;
    if (!c.from_mailbox || !c.to || !c.subject || !c.body) {
      _ui.lastSend = { ok: false, error: 'Vul from/to/onderwerp/body' };
      if (render) render(); return;
    }
    _ui.sendBusy = true; _ui.lastSend = null; if (render) render();
    const j = await tryFetch('send', '/api/email-send-v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from_mailbox: c.from_mailbox, to: c.to, subject: c.subject, text: c.body,
        cc: c.cc || undefined, bcc: c.bcc || undefined, email_id: c.email_id || undefined,
      }),
    }, 15000);
    _ui.sendBusy = false;
    if (j && j.__error) _ui.lastSend = { ok: false, error: j.__error };
    else if (j?.ok) {
      _ui.lastSend = { ok: true, guarded: !!j.guarded, guard_target: j.guard_target || null, original_to: j.original_to || null, env: j.env || null };
      setTimeout(() => {
        _ui.composeOpen = false;
        _ui.compose = { from_mailbox: c.from_mailbox, to: '', cc: '', bcc: '', subject: '', body: '', email_id: null };
        _ui.lastSend = null; _ui.ccBccOpen = false;
        _live.inbox.data = null; _live.inbox.key = null;
        if (render) render();
      }, 2000);
    } else _ui.lastSend = { ok: false, error: j?.error || 'Onbekende fout' };
    if (render) render();
  }
  async function aiRegenerate() {
    if (_ui.aiBusy) return;
    const row = currentRow();
    const bodyData = row ? _live.body.data[row.id] : null;
    _ui.aiBusy = true; if (render) render();
    const j = await tryFetch('ai-regen', '/api/email-ai-regenerate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        original_subject: row?.subject || '',
        original_body:    bodyData?.text || row?.snippet || '',
        from_name:        row?.from_name || row?.from_address || '',
        tone:             _ui.aiTone,
      }),
    }, 20000);
    _ui.aiBusy = false;
    if (j && !j.__error && j.draft_body) {
      _ui.compose.body = j.draft_body;
      if (j.draft_subject && !_ui.compose.subject) _ui.compose.subject = j.draft_subject;
    } else _ui.compose.body = _ui.compose.body || `[AI-generatie mislukt: ${j?.__error || j?.error || 'onbekende fout'}]`;
    if (render) render();
  }

  function currentRow() {
    const items = asArr(_live.inbox.data?.items);
    return items.find((x) => x.id === _ui.selectedId) || null;
  }
  function hashHue(s) {
    let h = 0; s = String(s || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }
  function initialsOf(name) {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function av(name, size) {
    size = size || 38;
    const hue = hashHue(name);
    const bg1 = `hsl(${hue}, 65%, 52%)`;
    const bg2 = `hsl(${(hue + 30) % 360}, 60%, 42%)`;
    const fs  = Math.round(size * 0.4);
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg, ${bg1}, ${bg2});color:#fff;display:flex;align-items:center;justify-content:center;font-size:${fs}px;font-weight:600;letter-spacing:.02em;flex-shrink:0">${esc(initialsOf(name))}</div>`;
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
  const errBlk = (msg, retryFn) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid ${TOK.roseLine};background:${TOK.roseSoft};border-radius:${TOK.r};color:${TOK.rose};font-size:13px;display:flex;align-items:center;gap:12px">
    <span style="flex:1">⚠ ${esc(msg)}</span>
    ${retryFn ? `<button class="btn btn-ghost btn-sm" onclick="${retryFn}">Opnieuw</button>` : ''}
  </div>`;
  const skel = () => `<div style="padding:24px 20px"><div style="height:80px;background:var(--surface-2);border-radius:${TOK.r};opacity:.5;animation:pulse 1.5s ease-in-out infinite"></div></div>`;
  function fmtRelTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const now = new Date();
    const diffDay = Math.floor((now - d) / 86400000);
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const isYest = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
    if (isYest) return 'gisteren';
    if (diffDay < 7) return diffDay + ' dagen';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
  }
  function fmtDateFull(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }
  function safeHtmlText(text) {
    return esc(String(text || '')).replace(/\n{2,}/g, '</p><p style="margin-bottom:14px">').replace(/\n/g, '<br>');
  }

  function emailView() {
    if (!_live.inbox.loading && (!_live.inbox.data || _live.inbox.key !== inboxKey())) {
      queueMicrotask(fetchInbox);
    }
    const html = `<div class="pad" style="padding:0">
      <div style="display:grid;grid-template-columns:198px 352px 1fr;height:calc(100vh - 120px);border-top:1px solid var(--border)">
        ${_leftRail()}
        ${_middleList()}
        ${_reader()}
      </div>
    </div>`;
    const compose = _ui.composeOpen ? _composeModal() : '';
    return html + compose;
  }

  function _leftRail() {
    return `<aside style="background:var(--surface-2);border-right:1px solid var(--border);overflow-y:auto;padding:12px 0;display:flex;flex-direction:column">
      <div style="padding:0 14px 12px">
        <button class="btn btn-primary" style="width:100%;font-weight:500;gap:6px" onclick="window.__emailNewCompose()">${ICO.plus}Nieuwe e-mail</button>
      </div>
      <div style="padding:6px 0">
        <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:8px 16px 4px">Mappen</div>
        ${FOLDERS.map(_foldBtn).join('')}
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
  function _foldBtn(f) {
    const on = _ui.folder === f.slug;
    const bg = on ? TOK.mSoft : 'transparent';
    const fg = on ? TOK.m : 'var(--text-2)';
    const wt = on ? '600' : '400';
    const opa = f.wired ? '1' : '.55';
    return `<button style="width:100%;text-align:left;padding:8px 16px;background:${bg};border:none;color:${fg};font-size:13px;font-weight:${wt};cursor:pointer;display:flex;align-items:center;gap:10px;opacity:${opa}" onclick="window.__emailSetFolder('${esc(f.slug)}')">
      <span style="display:inline-flex;width:16px;height:16px;flex-shrink:0">${ICO[f.icon] || ''}</span>
      <span style="flex:1">${esc(f.label)}</span>
      ${!f.wired ? '<span style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">2B</span>' : ''}
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
    return `<section style="border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column">
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
      <div style="flex:1;overflow-y:auto">${_listBody()}</div>
      ${_pager()}
    </section>`;
  }
  function _bulkBar(count) {
    return `<div style="padding:8px 12px;background:${TOK.mSoft};border-top:1px solid var(--border);display:flex;align-items:center;gap:8px;font-size:12px">
      <span style="color:${TOK.m};font-weight:600">${count} geselecteerd</span>
      <div style="display:flex;gap:4px;margin-left:auto">
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('read')" title="Als gelezen (2B)" style="opacity:.6">Gelezen</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('archive')" title="Archief (2B)" style="opacity:.6">Archief</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailBulkAction('trash')" title="Trash (2B)" style="opacity:.6">Trash</button>
        <button class="icon-btn" onclick="window.__emailBulkClear()" title="Deselecteer" style="width:24px;height:24px">${ICO.x}</button>
      </div>
    </div>`;
  }
  function _listBody() {
    const st = _live.inbox;
    if (st.error && !st.data) return errBlk(st.error, "window.__emailRefresh()");
    if (st.loading && !st.data) return skel();
    if (st.data && st.data.__placeholder) return _emptyState(_ui.folder + '-map', 'Deze map komt in Fase 2B — endpoints voor flag/concept/archief/prullenbak worden dan gebouwd.');
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
    if (!st.data || st.data.__placeholder || st.data.total === 0) return '';
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
    const bst = _live.body;
    const body = bst.data[row.id];
    const bErr = bst.error[row.id];
    const bLoad = bst.loading[row.id];
    if (!body && !bErr && !bLoad && row.mailbox && row.imap_uid != null) {
      queueMicrotask(() => fetchBody(row));
    }
    if (row._source === 'inbox' && !row.is_read && !_busy['read:' + row.id]) {
      queueMicrotask(() => markRead(row, true));
    }
    return `<section style="overflow-y:auto;display:flex;flex-direction:column;background:var(--bg,var(--surface))">
      ${_readHead(row)}
      ${_readMeta(row)}
      <div style="flex:1;overflow-y:auto">
        ${bErr ? errBlk(bErr, `window.__emailReloadBody('${esc(row.id)}')`) :
          bLoad ? skel() :
          body ? _bodyBlock(body, row) :
          `<div style="padding:20px;color:var(--text-3);font-size:13px">Body wordt geladen…</div>`}
        ${_aiSuggestPlaceholder()}
      </div>
    </section>`;
  }
  function _readerEmpty() {
    return `<section style="display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-3);gap:14px;padding:40px 20px;background:var(--bg,var(--surface))">
      <div style="width:72px;height:72px;border-radius:50%;background:var(--surface-2);display:flex;align-items:center;justify-content:center">${ICO.mail}</div>
      <div style="text-align:center">
        <div style="font-size:15px;font-weight:600;color:var(--text-2);margin-bottom:4px">Geen bericht geopend</div>
        <div style="font-size:12.5px;max-width:320px;line-height:1.5">Kies links een e-mail om 'm te lezen en te beantwoorden.</div>
      </div>
    </section>`;
  }
  function _readHead(row) {
    return `<div style="padding:16px 22px 14px;border-bottom:1px solid var(--border);background:var(--surface)">
      <div style="font-size:18px;font-weight:600;letter-spacing:-.025em;color:var(--text);line-height:1.3;margin-bottom:12px">${esc(row.subject || '(geen onderwerp)')}</div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <button class="btn btn-primary btn-sm" onclick="window.__emailReply()" style="gap:6px">${ICO.reply}Beantwoorden</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailReplyAll()" style="gap:6px">${ICO.replyAll}Allen</button>
        <button class="btn btn-ghost btn-sm" onclick="window.__emailFwd()" style="gap:6px">${ICO.forward}Doorsturen</button>
        <span style="width:1px;height:20px;background:var(--border);margin:0 4px"></span>
        <button class="icon-btn" title="Markeer ongelezen" onclick="window.__emailMarkUnread()" style="width:28px;height:28px">${ICO.mail}</button>
        <button class="icon-btn" title="Vlag (Fase 2B)" onclick="window.__emailTodo2B('vlag')" style="width:28px;height:28px;opacity:.55">${ICO.flag}</button>
        <button class="icon-btn" title="Archief (Fase 2B)" onclick="window.__emailTodo2B('archief')" style="width:28px;height:28px;opacity:.55">${ICO.archive}</button>
        <button class="icon-btn" title="Verwijderen (Fase 2B)" onclick="window.__emailTodo2B('trash')" style="width:28px;height:28px;opacity:.55">${ICO.trash}</button>
        <div style="position:relative;margin-left:auto">
          <button class="icon-btn" title="Meer" onclick="window.__emailToggleMore()" style="width:28px;height:28px">${ICO.dots}</button>
          ${_ui.moreMenuOpen ? _moreMenu(row) : ''}
        </div>
      </div>
    </div>`;
  }
  function _moreMenu(row) {
    const items = [
      { l: 'Koppel aan klant', k: 'link', wired: !!row.customer_id },
      { l: 'Maak ticket van',  k: 'ticket', wired: false },
      { l: 'Maak taak van',    k: 'taak',   wired: false },
      { l: 'Verplaats naar…',  k: 'move',   wired: false },
      { l: 'Regel maken',      k: 'rule',   wired: false },
      { l: 'Afdrukken',        k: 'print',  wired: true },
      { l: 'Origineel bekijken', k: 'src',  wired: false },
    ];
    return `<div style="position:absolute;top:32px;right:0;min-width:200px;background:var(--surface);border:1px solid var(--border);border-radius:${TOK.r};box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:20;padding:4px 0">
      ${items.map((it) => `<button style="width:100%;text-align:left;padding:7px 14px;background:none;border:none;color:var(--text);font-size:12.5px;cursor:${it.wired ? 'pointer' : 'default'};opacity:${it.wired ? '1' : '.55'};display:flex;align-items:center;justify-content:space-between" onclick="window.__emailMoreDo('${esc(it.k)}')">
        <span>${esc(it.l)}</span>
        ${!it.wired ? '<span style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">2B</span>' : ''}
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
          : `<button class="btn btn-ghost btn-sm" style="font-size:11.5px;color:${TOK.m}" onclick="window.__emailTodo2B('koppel-klant')">+ Koppel klant</button>`}
      </div>
    </div>`;
  }
  function _bodyBlock(body, row) {
    const attachments = asArr(body.attachments);
    return `<div style="padding:22px;max-width:900px;margin:0 auto">
      <div style="font-size:14px;line-height:1.65;color:var(--text-2);font-family:inherit"><p style="margin-bottom:14px">${safeHtmlText(body.text || '')}</p></div>
      ${attachments.length > 0 ? _attStrip(attachments, row) : ''}
    </div>`;
  }
  function _attStrip(attachments, row) {
    return `<div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--border)">
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${attachments.map((a) => `
          <a href="/api/email-attachment?mailbox=${encodeURIComponent(row.mailbox + '@deforexopleiding.nl')}&uid=${encodeURIComponent(row.imap_uid)}&index=${encodeURIComponent(a.index)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:8px;padding:6px 10px 6px 6px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface);text-decoration:none;color:var(--text);font-size:12px;transition:border-color .15s" onmouseover="this.style.borderColor='${TOK.m}'" onmouseout="this.style.borderColor='var(--border)'">
            <span style="width:28px;height:28px;border-radius:${TOK.rSm};background:${TOK.roseSoft};color:${TOK.rose};display:flex;align-items:center;justify-content:center;flex-shrink:0">${ICO.file}</span>
            <span style="font-weight:500;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.filename || 'bijlage')}</span>
            <span style="font-size:10.5px;color:var(--text-3);font-family:${TOK.mono}">${(a.size / 1024).toFixed(1)} KB</span>
          </a>
        `).join('')}
      </div>
    </div>`;
  }
  function _aiSuggestPlaceholder() {
    return `<div style="margin:20px 22px 22px;padding:16px 18px;background:${TOK.violetSoft};border:1px solid ${TOK.violetLine};border-radius:${TOK.rLg}">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="width:26px;height:26px;border-radius:50%;background:${TOK.violet};color:#fff;display:flex;align-items:center;justify-content:center">${ICO.sparkle}</span>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:${TOK.violet}">Voorgesteld antwoord</div>
          <div style="font-size:11px;color:var(--text-3)">AI-draft-generatie in-reader komt in Fase 2B — nu via Beantwoorden + AI-knop in compose</div>
        </div>
        <button class="btn btn-ghost btn-sm" style="color:${TOK.violet};font-size:11.5px" onclick="window.__emailReply()">Beantwoorden met AI →</button>
      </div>
    </div>`;
  }

  function _composeModal() {
    const c = _ui.compose;
    const send = _ui.lastSend;
    if (_ui.composeMinimized) return _composeMinBar();
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.42);backdrop-filter:blur(3px);z-index:1000;display:flex;align-items:flex-end;justify-content:flex-end;padding:0 26px 0 0" onclick="window.__emailCloseCompose()">
      <div style="background:var(--surface);width:660px;max-width:calc(100vw - 52px);height:78vh;border-radius:${TOK.rLg} ${TOK.rLg} 0 0;box-shadow:0 -8px 32px rgba(0,0,0,.24);display:flex;flex-direction:column;overflow:hidden;animation:slideUp .28s cubic-bezier(.16,1,.3,1)" onclick="event.stopPropagation()">
        <div style="padding:12px 18px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;border-radius:${TOK.rLg} ${TOK.rLg} 0 0">
          <div style="font-size:14px;font-weight:600">${_ui.composeMode === 'reply' ? 'Beantwoorden' : _ui.composeMode === 'replyall' ? 'Beantwoorden aan allen' : _ui.composeMode === 'fwd' ? 'Doorsturen' : 'Nieuw bericht'}</div>
          <div style="display:flex;gap:4px">
            <button class="icon-btn" title="Minimaliseer" onclick="window.__emailComposeMin()" style="width:24px;height:24px">${ICO.min}</button>
            <button class="icon-btn" title="Sluiten" onclick="window.__emailCloseCompose()" style="width:24px;height:24px">${ICO.x}</button>
          </div>
        </div>
        <div style="padding:12px 18px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:2px">
          ${_composeField('Van', _composeFromSelect(c))}
          ${_composeField('Aan', _composeToInput(c), _ccBccToggle())}
          ${_ui.ccBccOpen ? _composeField('CC',  `<input type="text" value="${esc(c.cc)}" oninput="window.__emailComposeField('cc', this.value)" placeholder="cc@voorbeeld.nl" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`) : ''}
          ${_ui.ccBccOpen ? _composeField('BCC', `<input type="text" value="${esc(c.bcc)}" oninput="window.__emailComposeField('bcc', this.value)" placeholder="bcc@voorbeeld.nl" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`) : ''}
          ${_composeField('Onderwerp', `<input type="text" value="${esc(c.subject)}" oninput="window.__emailComposeField('subject', this.value)" style="width:100%;padding:6px 8px;border:none;background:transparent;color:var(--text);font-size:13px;outline:none" />`)}
          ${_ui.composeMode !== 'new' && c.to ? _recipChip(c.to) : ''}
          <div style="padding:12px 0 4px;flex:1;display:flex;flex-direction:column;min-height:180px">
            <textarea oninput="window.__emailComposeField('body', this.value)" placeholder="Typ je bericht…" style="width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:${TOK.rSm};background:var(--surface);color:var(--text);font-size:13.5px;line-height:1.55;min-height:180px;font-family:inherit;resize:vertical;flex:1">${esc(c.body)}</textarea>
          </div>
          ${_composeSigStrip()}
          ${send ? _sendResultBlock(send) : ''}
        </div>
        <div style="padding:10px 18px;border-top:1px solid var(--border);display:flex;align-items:center;gap:8px">
          <button class="btn btn-primary" ${_ui.sendBusy ? 'disabled' : ''} onclick="window.__emailSend()" style="gap:6px">${ICO.send}${_ui.sendBusy ? 'Versturen…' : 'Versturen'}</button>
          <button class="icon-btn" title="Bijlage toevoegen (Fase 2B)" onclick="window.__emailTodo2B('bijlage')" style="width:32px;height:32px;opacity:.6">${ICO.paperclip}</button>
          <button class="icon-btn" title="Sjabloon (Fase 2B)" onclick="window.__emailTodo2B('sjabloon')" style="width:32px;height:32px;opacity:.6">${ICO.file}</button>
          <button class="icon-btn" title="Later versturen (later)" style="width:32px;height:32px;opacity:.4;cursor:default">🕐</button>
          <div style="display:flex;align-items:center;gap:4px;margin-left:6px">
            ${['vriendelijk','zakelijk','kort','streng'].map((t) => {
              const on = _ui.aiTone === t;
              return `<button class="tone-chip" style="padding:3px 9px;border:1px solid ${on ? TOK.violet : TOK.violetLine};background:${on ? TOK.violet : 'transparent'};color:${on ? '#fff' : TOK.violet};border-radius:20px;font-size:10.5px;font-weight:${on ? '600' : '500'};cursor:pointer" onclick="window.__emailAiSetTone('${t}')">${t}</button>`;
            }).join('')}
            <button class="btn btn-ghost btn-sm" ${_ui.aiBusy ? 'disabled' : ''} onclick="window.__emailAiRegen()" style="gap:5px;color:${TOK.violet}">${ICO.sparkle}${_ui.aiBusy ? 'Bezig…' : 'AI-antwoord'}</button>
          </div>
          <div style="margin-left:auto;font-size:11px;color:var(--text-3)">Concept-autosave: 2B</div>
          <button class="icon-btn" title="Verwerpen (Fase 2B)" onclick="window.__emailTodo2B('trash-concept')" style="width:28px;height:28px;opacity:.55">${ICO.trash}</button>
        </div>
      </div>
    </div>
    <style>@keyframes slideUp { from { transform:translateY(30px); opacity:0 } to { transform:translateY(0); opacity:1 } } @keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:.7} }</style>`;
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
    return `<div style="margin-top:8px;padding:10px 12px;background:var(--surface-2);border:1px dashed var(--border);border-radius:${TOK.rSm};display:flex;align-items:center;gap:10px;font-size:11.5px;color:var(--text-3)">
      <span style="font-weight:600;text-transform:uppercase;letter-spacing:.06em;font-size:10px">Handtekening</span>
      <select disabled style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text-3);font-size:11px;cursor:not-allowed">
        <option>Standaard (Fase 2B)</option>
      </select>
      <span style="margin-left:auto">Beheer komt in 2B</span>
    </div>`;
  }
  function _sendResultBlock(send) {
    if (!send.ok) return `<div style="padding:10px 12px;background:${TOK.roseSoft};border:1px solid ${TOK.roseLine};color:${TOK.rose};border-radius:${TOK.rSm};font-size:12.5px;margin-top:10px">⚠ Verzenden mislukt: ${esc(send.error || 'onbekende fout')}</div>`;
    if (send.guarded) return `<div style="padding:10px 12px;background:${TOK.amberSoft};border:1px solid ${TOK.amber};color:var(--text);border-radius:${TOK.rSm};font-size:12.5px;line-height:1.5;margin-top:10px">
      ✓ Verstuurd (guarded — env <b>${esc(send.env)}</b>)<br>→ Doel: <b>${esc(send.guard_target)}</b><br>→ Origineel to: ${esc(send.original_to || '—')}</div>`;
    return `<div style="padding:10px 12px;background:${TOK.emeraldSoft};border:1px solid ${TOK.emerald};color:${TOK.emerald};border-radius:${TOK.rSm};font-size:12.5px;margin-top:10px">✓ Verstuurd naar ${esc(send.original_to || _ui.compose.to)} (env ${esc(send.env || 'production')})</div>`;
  }

  window.__emailSetFolder = (slug) => { _ui.folder = slug; _ui.offset = 0; _ui.selectedId = null; _ui.selectedRows = {}; _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  window.__emailSetMailbox = (slug) => {
    _ui.mailboxSlug = slug; _ui.offset = 0; _ui.selectedId = null; _ui.selectedRows = {};
    _live.inbox.data = null; _live.inbox.key = null;
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
  window.__emailRefresh = () => { _live.inbox.data = null; _live.inbox.error = null; _live.inbox.key = null; if (render) render(); };
  window.__emailPage = (dir) => { _ui.offset = Math.max(0, _ui.offset + dir * PAGE_SIZE); _live.inbox.data = null; _live.inbox.key = null; if (render) render(); };
  window.__emailOpen = (rid) => { _ui.selectedId = rid; _ui.moreMenuOpen = false; if (render) render(); };
  window.__emailReloadBody = (rid) => { delete _live.body.data[rid]; delete _live.body.error[rid]; if (render) render(); };
  window.__emailMarkUnread = () => { const row = currentRow(); if (row) markRead(row, false); };
  window.__emailToggleSel = (rid) => { _ui.selectedRows[rid] = !_ui.selectedRows[rid]; if (render) render(); };
  window.__emailBulkClear = () => { _ui.selectedRows = {}; if (render) render(); };
  window.__emailBulkAction = (a) => { alert('Bulk-actie "' + a + '" komt in Fase 2B (nieuwe endpoints).'); };
  window.__emailToggleMore = () => { _ui.moreMenuOpen = !_ui.moreMenuOpen; if (render) render(); };
  window.__emailMoreDo = (k) => {
    _ui.moreMenuOpen = false;
    if (k === 'print') { window.print(); if (render) render(); return; }
    if (k === 'link') { const row = currentRow(); if (row?.customer_id) window.__emailOpenKlant(row.customer_id); return; }
    alert('Actie "' + k + '" komt in Fase 2B.');
    if (render) render();
  };
  window.__emailTodo2B = (feat) => { alert(feat + ' — komt in Fase 2B (data-cluster).'); };
  window.__emailSettings = () => { alert('Instellingen (handtekening/regels/notificaties) komen in Fase 2B.'); };
  window.__emailOpenKlant = (customerId) => {
    console.info('[email-v2] Klant-koppeling → v2-detail-view voor ' + customerId + ' (Fase 2B wire).');
    if (H.showToast) H.showToast('Klant-dossier-koppeling komt in v2-detail-view (Fase 2B).');
    else alert('Klant-koppeling komt in Fase 2B.');
  };
  window.__emailNewCompose = () => {
    _ui.composeMode = 'new'; _ui.composeMinimized = false;
    _ui.compose = { from_mailbox: _ui.compose.from_mailbox, to: '', cc: '', bcc: '', subject: '', body: '', email_id: null };
    _ui.composeOpen = true; _ui.lastSend = null; _ui.ccBccOpen = false;
    if (render) render();
  };
  function _replyState(mode) {
    const row = currentRow();
    if (!row) { alert('Selecteer eerst een bericht.'); return; }
    const from = MAILBOXES.find((m) => m.slug === row.mailbox);
    _ui.composeMode = mode; _ui.composeMinimized = false;
    _ui.compose = {
      from_mailbox: from ? from.addr : _ui.compose.from_mailbox,
      to: row.from_address || '', cc: '', bcc: '',
      subject: /^(re|fwd?):/i.test(row.subject || '') ? row.subject : (mode === 'fwd' ? 'Fwd: ' : 'Re: ') + (row.subject || ''),
      body: '',
      email_id: (row.mailbox && row.imap_uid != null) ? `${row.mailbox}@deforexopleiding.nl:${row.imap_uid}` : null,
    };
    _ui.composeOpen = true; _ui.lastSend = null; _ui.ccBccOpen = false;
    if (render) render();
  }
  window.__emailReply    = () => _replyState('reply');
  window.__emailReplyAll = () => _replyState('replyall');
  window.__emailFwd      = () => { _replyState('fwd'); _ui.compose.to = ''; if (render) render(); };
  window.__emailCloseCompose = () => { _ui.composeOpen = false; _ui.composeMinimized = false; _ui.lastSend = null; _ui.ccBccOpen = false; if (render) render(); };
  window.__emailComposeMin = () => { _ui.composeMinimized = true; if (render) render(); };
  window.__emailComposeRestore = () => { _ui.composeMinimized = false; if (render) render(); };
  window.__emailComposeField = (k, v) => { _ui.compose[k] = v; };
  window.__emailToggleCcBcc = () => { _ui.ccBccOpen = !_ui.ccBccOpen; if (render) render(); };
  window.__emailSend = () => { sendMail(); };
  window.__emailAiSetTone = (t) => { _ui.aiTone = t; if (render) render(); };
  window.__emailAiRegen = () => { aiRegenerate(); };

  window.DFO.VIEWS['email/'] = emailView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('email');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('email');
  console.debug('[email-v2] Fase 2A pure-UI parity registered — 7 mailboxen + 7 mappen (4 wachten op 2B)');
})();
