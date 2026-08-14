// modules/klanten-v2/views/email-v2.js
//
// v2 E-mail — Fase 1 LIVE build (PR #1289 / branch feat/v2-email).
//
// 3-koloms Outlook-look uit docs/redesign/systeemprototype-v45.html r2559-2747.
// Data 100% LIVE via nieuwe endpoints:
//   /api/email-inbox-list      — Supabase-read op email_messages (sync-cache)
//   /api/email-body            — IMAP live body-fetch + attachments metadata
//   /api/email-attachment      — attachment-download
//   /api/mark-read             — IMAP \Seen flag toggle
//   /api/email-send-v2         — reply/compose met server-side preview-guard
//   /api/email-ai-regenerate   — dunne Anthropic wrapper (protected-zone leeg)
//
// 7 mailboxen aangesloten: leads / info / partners / administratie /
// onboarding / events / welkom (matcht sync-emails + send-email + emails.js).
//
// Veiligheidspatronen:
//   - Skeleton bij loading, errBlk bij error met retry-knop
//   - 8s Promise.race timeout op alle fetches
//   - Busy-flags tegen dubbelklik (send, mark-read, ai-regenerate)
//   - Fail-soft: één stuk-endpoint blokkeert niet de rest van de view
//   - Surgical re-render (verwijder body-cache bij mail-switch, niet lijst)
//
// Dormant achter ?v2preview=email (V2_ACTIVE_ALLOWLIST in klanten-v2.js).
//
// Registreert: DFO.VIEWS['email/'] = emailView.

(function () {
  if (!window.DFO) { console.error('[email-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[email-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, render } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ═══════════════════════════════════════════════════════════════════════
  // MAILBOX-CONFIG (7 mailboxen — parity met sync-emails + send-email)
  // ═══════════════════════════════════════════════════════════════════════
  const MAILBOXES = [
    { slug: 'leads',         addr: 'leads@deforexopleiding.nl',         label: 'Leads' },
    { slug: 'info',          addr: 'info@deforexopleiding.nl',          label: 'Info' },
    { slug: 'partners',      addr: 'partners@deforexopleiding.nl',      label: 'Partners' },
    { slug: 'administratie', addr: 'administratie@deforexopleiding.nl', label: 'Administratie' },
    { slug: 'onboarding',    addr: 'onboarding@deforexopleiding.nl',    label: 'Onboarding' },
    { slug: 'events',        addr: 'events@deforexopleiding.nl',        label: 'Events' },
    { slug: 'welkom',        addr: 'welkom@deforexopleiding.nl',        label: 'Welkom' },
  ];
  const FOLDERS = [
    { slug: 'inbox',  label: 'Postvak IN',   icon: 'inbox'  },
    { slug: 'unread', label: 'Ongelezen',    icon: 'dot'    },
    { slug: 'sent',   label: 'Verzonden',    icon: 'send'   },
  ];
  const PAGE_SIZE = 50;

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE STATE
  // ═══════════════════════════════════════════════════════════════════════
  const _live = {
    inbox: { loading: false, error: null, data: null, key: null }, // key='mailbox|folder|search|offset'
    body:  { loading: {}, error: {}, data: {} },                    // per rowId
  };
  const _ui = {
    mailboxSlug: '',      // '' = alle mailboxen
    folder:      'inbox', // 'inbox' | 'unread' | 'sent'
    search:      '',
    offset:      0,
    selectedId:  null,    // geopende mail row.id
    composeOpen: false,
    composeMode: 'new',   // 'new' | 'reply' | 'replyall' | 'fwd'
    compose: {
      from_mailbox: 'info@deforexopleiding.nl',
      to:           '',
      cc:           '',
      subject:      '',
      body:         '',
      email_id:     null,   // '<mailbox>:<uid>' voor reply-threading
    },
    aiTone:      'vriendelijk',
    aiBusy:      false,
    sendBusy:    false,
    lastSend:    null,    // { ok, guarded, guard_target, original_to, env, error? }
  };
  const _busy = {};

  // ═══════════════════════════════════════════════════════════════════════
  // FETCHERS (met 8s timeout via Promise.race)
  // ═══════════════════════════════════════════════════════════════════════
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
    return `${_ui.mailboxSlug}|${_ui.folder}|${_ui.search}|${_ui.offset}`;
  }
  async function fetchInbox() {
    const key = inboxKey();
    const st = _live.inbox;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const params = [];
    if (_ui.mailboxSlug) params.push('mailbox=' + encodeURIComponent(_ui.mailboxSlug));
    if (_ui.folder === 'sent')   params.push('folder=sent');
    if (_ui.folder === 'unread') params.push('unread=1');
    if (_ui.search)              params.push('search=' + encodeURIComponent(_ui.search));
    params.push('limit=' + PAGE_SIZE);
    params.push('offset=' + _ui.offset);
    const url = '/api/email-inbox-list?' + params.join('&');
    const j = await tryFetch('inbox', url);
    st.loading = false;
    if (j && j.__error) { st.error = j.__error; st.data = null; }
    else {
      st.data = {
        items:   asArr(j?.items),
        total:   Number(j?.total || 0),
        hasMore: !!j?.hasMore,
      };
    }
    if (render) render();
  }

  async function fetchBody(row) {
    if (!row || !row.mailbox || row.imap_uid == null) return;
    const rid = row.id;
    const st = _live.body;
    if (st.loading[rid] || st.data[rid]) return;
    st.loading[rid] = true; st.error[rid] = null;
    const url = '/api/email-body';
    const j = await tryFetch('body:' + rid, url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid }),
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
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ mailbox: row.mailbox + '@deforexopleiding.nl', uid: row.imap_uid, seen: !!seen }),
    }, 8000);
    _busy['read:' + row.id] = false;
    if (j && !j.__error) {
      // Optimistic: update row in lijst
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
      if (render) render();
      return;
    }
    _ui.sendBusy = true; _ui.lastSend = null; if (render) render();
    const j = await tryFetch('send', '/api/email-send-v2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from_mailbox: c.from_mailbox,
        to:           c.to,
        subject:      c.subject,
        text:         c.body,
        cc:           c.cc || undefined,
        email_id:     c.email_id || undefined,
      }),
    }, 15000);
    _ui.sendBusy = false;
    if (j && j.__error) {
      _ui.lastSend = { ok: false, error: j.__error };
    } else if (j?.ok) {
      _ui.lastSend = {
        ok:           true,
        guarded:      !!j.guarded,
        guard_target: j.guard_target || null,
        original_to:  j.original_to  || null,
        env:          j.env || null,
      };
      // Reset compose form + close after 2s zodat user de guard-melding ziet
      setTimeout(() => {
        _ui.composeOpen = false;
        _ui.compose = { from_mailbox: c.from_mailbox, to: '', cc: '', subject: '', body: '', email_id: null };
        _ui.lastSend = null;
        // Refresh inbox voor verzonden-tab
        _live.inbox.data = null; _live.inbox.key = null;
        if (render) render();
      }, 2000);
    } else {
      _ui.lastSend = { ok: false, error: j?.error || 'Onbekende fout' };
    }
    if (render) render();
  }

  async function aiRegenerate() {
    if (_ui.aiBusy) return;
    const row = currentRow();
    const bodyData = row ? _live.body.data[row.id] : null;
    _ui.aiBusy = true; if (render) render();
    const j = await tryFetch('ai-regen', '/api/email-ai-regenerate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        original_subject: row?.subject || '',
        original_body:    bodyData?.text || row?.snippet || '',
        from_name:        row?.from_name || row?.from_address || '',
        tone:             _ui.aiTone,
      }),
    }, 20000);
    _ui.aiBusy = false;
    if (j && !j.__error && j.draft_body) {
      _ui.compose.body    = j.draft_body;
      if (j.draft_subject && !_ui.compose.subject) _ui.compose.subject = j.draft_subject;
    } else {
      const err = j?.__error || j?.error || 'AI-generatie mislukt';
      _ui.compose.body = _ui.compose.body || `[AI-generatie mislukt: ${err}]`;
    }
    if (render) render();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  function currentRow() {
    const items = asArr(_live.inbox.data?.items);
    return items.find((x) => x.id === _ui.selectedId) || null;
  }
  const errBlk = (msg, retryFn) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line,#f4a);background:var(--rose-soft,#fee);border-radius:8px;color:var(--rose,#c00);font-size:13px;display:flex;align-items:center;gap:12px">
    <span style="flex:1">⚠ ${esc(msg)}</span>
    ${retryFn ? `<button class="btn btn-ghost btn-sm" onclick="${retryFn}">Opnieuw</button>` : ''}
  </div>`;
  const skel = () => `<div style="padding:24px 20px"><div style="height:80px;background:var(--surface-2);border-radius:8px;opacity:.5;animation:pulse 1.5s ease-in-out infinite"></div></div>`;
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    const today = new Date();
    const isSameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
    if (isSameDay) return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' });
  }
  function safeHtmlText(text) {
    // Simple: convert plain text with linebreaks to safe HTML paragraphs.
    return esc(String(text || '')).replace(/\n/g, '<br>');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW — 3-koloms mail3-layout
  // ═══════════════════════════════════════════════════════════════════════
  function emailView() {
    // Trigger fetch als data ontbreekt of key veranderd is
    if (!_live.inbox.loading && (!_live.inbox.data || _live.inbox.key !== inboxKey())) {
      queueMicrotask(fetchInbox);
    }

    const html = `<div class="pad" style="padding:0">
      <div style="display:grid;grid-template-columns:220px 380px 1fr;height:calc(100vh - 120px);border-top:1px solid var(--border)">
        ${_leftRail()}
        ${_middleList()}
        ${_reader()}
      </div>
    </div>`;
    const compose = _ui.composeOpen ? _composeModal() : '';
    return html + compose;
  }

  function _leftRail() {
    return `<aside style="background:var(--surface-2);border-right:1px solid var(--border);overflow-y:auto;padding:12px 0">
      <div style="padding:0 14px 8px">
        <button class="btn btn-primary" style="width:100%;font-weight:500" onclick="window.__emailNewCompose()">${svg(I.plus || I.tick)}Nieuwe mail</button>
      </div>
      <div style="padding:8px 0">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:8px 16px 4px">Mappen</div>
        ${FOLDERS.map((f) => `
          <button class="email-nav-item ${_ui.folder === f.slug ? 'active' : ''}" style="width:100%;text-align:left;padding:8px 16px;background:${_ui.folder === f.slug ? 'var(--surface)' : 'transparent'};border:none;color:var(--text);font-size:13px;cursor:pointer;display:flex;align-items:center;gap:8px" onclick="window.__emailSetFolder('${esc(f.slug)}')">
            <span style="opacity:.7">•</span>${esc(f.label)}
          </button>
        `).join('')}
      </div>
      <div style="padding:8px 0">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);padding:8px 16px 4px">Postvakken</div>
        <button class="email-nav-item ${!_ui.mailboxSlug ? 'active' : ''}" style="width:100%;text-align:left;padding:8px 16px;background:${!_ui.mailboxSlug ? 'var(--surface)' : 'transparent'};border:none;color:var(--text);font-size:13px;cursor:pointer" onclick="window.__emailSetMailbox('')">Alle postvakken</button>
        ${MAILBOXES.map((m) => `
          <button class="email-nav-item ${_ui.mailboxSlug === m.slug ? 'active' : ''}" style="width:100%;text-align:left;padding:8px 16px;background:${_ui.mailboxSlug === m.slug ? 'var(--surface)' : 'transparent'};border:none;color:var(--text);font-size:13px;cursor:pointer" onclick="window.__emailSetMailbox('${esc(m.slug)}')">${esc(m.label)}</button>
        `).join('')}
      </div>
    </aside>`;
  }

  function _middleList() {
    const st = _live.inbox;
    return `<section style="border-right:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column">
      <div style="padding:10px 12px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;gap:8px;align-items:center">
        <input type="search" placeholder="Zoek onderwerp/afzender/tekst..." value="${esc(_ui.search)}" oninput="window.__emailSetSearchDebounced(this.value)" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:12.5px" />
        <button class="icon-btn" title="Vernieuw" onclick="window.__emailRefresh()" style="width:28px;height:28px">↻</button>
      </div>
      <div style="flex:1;overflow-y:auto">
        ${st.error && !st.data ? errBlk(st.error, "window.__emailRefresh()") :
          st.loading && !st.data ? skel() :
          _listRows()}
      </div>
      ${_pager()}
    </section>`;
  }

  function _listRows() {
    const items = asArr(_live.inbox.data?.items);
    if (items.length === 0) {
      return `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen berichten in deze weergave.</div>`;
    }
    return items.map((r) => {
      const isActive = r.id === _ui.selectedId;
      const bold     = !r.is_read && _ui.folder !== 'sent';
      const displayName = r.from_name || r.from_address || (r.to_address ? 'naar ' + r.to_address : '—');
      return `<button style="width:100%;text-align:left;padding:10px 14px;border:none;border-bottom:1px solid var(--border);background:${isActive ? 'var(--surface-2)' : 'transparent'};cursor:pointer;display:flex;flex-direction:column;gap:2px" onclick="window.__emailOpen('${esc(r.id)}')">
        <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-3)">
          <span style="flex:1;font-weight:${bold ? '600' : '400'};color:var(--text)">${esc(displayName)}</span>
          <span>${esc(fmtDate(r.date_received))}</span>
          ${r.has_attachments ? '<span title="Bijlage">📎</span>' : ''}
        </div>
        <div style="font-size:13px;font-weight:${bold ? '600' : '400'};color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.subject || '(geen onderwerp)')}</div>
        ${r.snippet ? `<div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.snippet.slice(0, 120))}</div>` : ''}
        <div style="display:flex;gap:4px;margin-top:2px">
          <span style="font-size:10px;color:var(--text-3);padding:1px 6px;border:1px solid var(--border);border-radius:3px">${esc(r.mailbox || '—')}</span>
          ${r.customer_id ? '<span style="font-size:10px;color:var(--emerald,#0a0);padding:1px 6px;border:1px solid var(--emerald,#0a0);border-radius:3px">Klant</span>' : ''}
          ${r.requires_action ? '<span style="font-size:10px;color:var(--amber,#f80);padding:1px 6px;border:1px solid var(--amber,#f80);border-radius:3px">Actie</span>' : ''}
        </div>
      </button>`;
    }).join('');
  }

  function _pager() {
    const st = _live.inbox;
    if (!st.data) return '';
    const total   = st.data.total;
    const offset  = _ui.offset;
    const shown   = asArr(st.data.items).length;
    const hasMore = st.data.hasMore;
    if (total === 0) return '';
    return `<div style="padding:8px 12px;border-top:1px solid var(--border);background:var(--surface);display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:var(--text-3)">
      <span>${offset + 1}–${offset + shown} van ${total}</span>
      <div style="display:flex;gap:4px">
        <button class="btn btn-ghost btn-sm" ${offset === 0 ? 'disabled' : ''} onclick="window.__emailPage(-1)">Vorige</button>
        <button class="btn btn-ghost btn-sm" ${!hasMore ? 'disabled' : ''} onclick="window.__emailPage(1)">Volgende</button>
      </div>
    </div>`;
  }

  function _reader() {
    const row = currentRow();
    if (!row) {
      return `<section style="display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">
        Selecteer een bericht om te lezen.
      </section>`;
    }
    const bst   = _live.body;
    const body  = bst.data[row.id];
    const bErr  = bst.error[row.id];
    const bLoad = bst.loading[row.id];
    if (!body && !bErr && !bLoad && row.mailbox && row.imap_uid != null) {
      queueMicrotask(() => fetchBody(row));
    }
    // Auto mark-read on open (fire-and-forget), alleen inbox-folder + niet-gelezen
    if (row._source === 'inbox' && !row.is_read && !_busy['read:' + row.id]) {
      queueMicrotask(() => markRead(row, true));
    }
    return `<section style="overflow-y:auto;display:flex;flex-direction:column">
      <div style="padding:14px 20px;border-bottom:1px solid var(--border);background:var(--surface)">
        <div style="display:flex;align-items:flex-start;gap:12px">
          <div style="flex:1">
            <div style="font-size:16px;font-weight:600;color:var(--text);line-height:1.3">${esc(row.subject || '(geen onderwerp)')}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:4px">
              <span style="color:var(--text)">${esc(row.from_name || row.from_address || '—')}</span>
              ${row.from_name && row.from_address ? ` &lt;${esc(row.from_address)}&gt;` : ''}
              · ${esc(fmtDate(row.date_received))}
              · <span style="color:var(--text-3)">${esc(row.mailbox || '—')}</span>
            </div>
            ${row.customer_id ? `<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="window.__emailOpenKlant('${esc(row.customer_id)}')">Open klant-dossier →</button></div>` : ''}
          </div>
          <div style="display:flex;gap:4px">
            <button class="btn btn-primary btn-sm" onclick="window.__emailReply()">${svg(I.reply || I.tick)}Beantwoorden</button>
            <button class="btn btn-ghost btn-sm" onclick="window.__emailReplyAll()">Allen</button>
            <button class="btn btn-ghost btn-sm" onclick="window.__emailFwd()">Doorsturen</button>
            <button class="icon-btn" title="Markeer ongelezen" onclick="window.__emailMarkUnread()">✉</button>
          </div>
        </div>
      </div>
      <div style="flex:1;padding:20px;overflow-y:auto">
        ${bErr ? errBlk(bErr, `window.__emailReloadBody('${esc(row.id)}')`) :
          bLoad ? skel() :
          body ? _bodyContent(body, row) :
          `<div style="color:var(--text-3);font-size:13px">Body wordt geladen...</div>`}
      </div>
    </section>`;
  }

  function _bodyContent(body, row) {
    const attachments = asArr(body.attachments);
    return `<div style="max-width:900px;margin:0 auto">
      <div style="font-size:13.5px;line-height:1.6;color:var(--text);white-space:pre-wrap;font-family:inherit">${safeHtmlText(body.text || '')}</div>
      ${attachments.length > 0 ? `
        <div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Bijlagen (${attachments.length})</div>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${attachments.map((a) => `
              <a href="/api/email-attachment?mailbox=${encodeURIComponent(row.mailbox + '@deforexopleiding.nl')}&uid=${encodeURIComponent(row.imap_uid)}&index=${encodeURIComponent(a.index)}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);text-decoration:none;color:var(--text);font-size:12.5px">
                <span>📎</span>
                <span style="flex:1">${esc(a.filename || 'bijlage')}</span>
                <span style="color:var(--text-3);font-size:11px">${(a.size / 1024).toFixed(1)} KB</span>
              </a>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // COMPOSE MODAL
  // ═══════════════════════════════════════════════════════════════════════
  function _composeModal() {
    const c = _ui.compose;
    const send = _ui.lastSend;
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;display:flex;align-items:center;justify-content:center" onclick="window.__emailCloseCompose()">
      <div style="background:var(--surface);width:min(720px, 92vw);max-height:90vh;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">
        <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:15px;font-weight:600">${_ui.composeMode === 'reply' ? 'Beantwoorden' : _ui.composeMode === 'fwd' ? 'Doorsturen' : 'Nieuwe mail'}</div>
          <button class="icon-btn" onclick="window.__emailCloseCompose()">✕</button>
        </div>
        <div style="padding:14px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Van</label>
            <select onchange="window.__emailComposeField('from_mailbox', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px">
              ${MAILBOXES.map((m) => `<option value="${esc(m.addr)}" ${c.from_mailbox === m.addr ? 'selected' : ''}>${esc(m.label)} (${esc(m.addr)})</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Aan</label>
            <input type="email" value="${esc(c.to)}" oninput="window.__emailComposeField('to', this.value)" placeholder="ontvanger@voorbeeld.nl" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">CC (optioneel)</label>
            <input type="text" value="${esc(c.cc)}" oninput="window.__emailComposeField('cc', this.value)" placeholder="cc@voorbeeld.nl" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-3);display:block;margin-bottom:3px">Onderwerp</label>
            <input type="text" value="${esc(c.subject)}" oninput="window.__emailComposeField('subject', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </div>
          <div>
            <label style="font-size:11px;color:var(--text-3);display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">
              <span>Bericht</span>
              <span style="display:flex;gap:4px;align-items:center">
                <span>AI-toon:</span>
                ${['vriendelijk','zakelijk','kort','streng'].map((t) => `<button class="chip ${_ui.aiTone === t ? 'on' : ''}" style="font-size:10.5px;padding:2px 6px" onclick="window.__emailAiSetTone('${t}')">${t}</button>`).join('')}
                <button class="btn btn-ghost btn-sm" ${_ui.aiBusy ? 'disabled' : ''} onclick="window.__emailAiRegen()" style="font-size:11px">${_ui.aiBusy ? 'Bezig…' : 'AI-antwoord'}</button>
              </span>
            </label>
            <textarea oninput="window.__emailComposeField('body', this.value)" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;min-height:220px;font-family:inherit;resize:vertical">${esc(c.body)}</textarea>
          </div>
          ${send ? _sendResultBlock(send) : ''}
        </div>
        <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div style="font-size:11.5px;color:var(--text-3)">${_previewBadge()}</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" onclick="window.__emailCloseCompose()">Annuleren</button>
            <button class="btn btn-primary" ${_ui.sendBusy ? 'disabled' : ''} onclick="window.__emailSend()">${_ui.sendBusy ? 'Versturen…' : 'Versturen'}</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function _sendResultBlock(send) {
    if (!send.ok) {
      return `<div style="padding:10px 12px;background:var(--rose-soft,#fee);border:1px solid var(--rose-line,#f4a);color:var(--rose,#c00);border-radius:6px;font-size:12.5px">⚠ Verzenden mislukt: ${esc(send.error || 'onbekende fout')}</div>`;
    }
    if (send.guarded) {
      return `<div style="padding:10px 12px;background:var(--amber-soft,#fef7e0);border:1px solid var(--amber-line,#fb0);color:var(--text);border-radius:6px;font-size:12.5px;line-height:1.5">
        ✓ Verstuurd (guarded — omgeving <b>${esc(send.env)}</b>):
        <br>→ Doel: <b>${esc(send.guard_target)}</b>
        <br>→ Oorspronkelijk to: ${esc(send.original_to || '—')}
      </div>`;
    }
    return `<div style="padding:10px 12px;background:var(--emerald-soft,#e6f7ee);border:1px solid var(--emerald-line,#0a0);color:var(--emerald,#080);border-radius:6px;font-size:12.5px">✓ Verstuurd naar ${esc(send.original_to || _ui.compose.to)} (env ${esc(send.env || 'production')})</div>`;
  }

  function _previewBadge() {
    // Client-side hint dat de server-guard actief kan zijn. Server heeft
    // laatste woord. UI toont dit als visuele bevestiging na eerste send.
    return `Env-detect gebeurt server-side. Op preview overschrijft de guard automatisch naar biemoldjeffrey@gmail.com.`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═══════════════════════════════════════════════════════════════════════
  window.__emailSetFolder = (slug) => {
    _ui.folder = slug; _ui.offset = 0; _ui.selectedId = null;
    _live.inbox.data = null; _live.inbox.key = null;
    if (render) render();
  };
  window.__emailSetMailbox = (slug) => {
    _ui.mailboxSlug = slug; _ui.offset = 0; _ui.selectedId = null;
    _live.inbox.data = null; _live.inbox.key = null;
    // Auto-set from_mailbox in compose als er een specifieke gekozen is
    if (slug) {
      const m = MAILBOXES.find((x) => x.slug === slug);
      if (m) _ui.compose.from_mailbox = m.addr;
    }
    if (render) render();
  };
  let _searchDebounceT = null;
  window.__emailSetSearchDebounced = (v) => {
    if (_searchDebounceT) clearTimeout(_searchDebounceT);
    _searchDebounceT = setTimeout(() => {
      _ui.search = String(v || '').trim();
      _ui.offset = 0; _live.inbox.data = null; _live.inbox.key = null;
      if (render) render();
    }, 400);
  };
  window.__emailRefresh = () => {
    _live.inbox.data = null; _live.inbox.error = null; _live.inbox.key = null;
    if (render) render();
  };
  window.__emailPage = (dir) => {
    _ui.offset = Math.max(0, _ui.offset + dir * PAGE_SIZE);
    _live.inbox.data = null; _live.inbox.key = null;
    if (render) render();
  };
  window.__emailOpen = (rid) => {
    _ui.selectedId = rid;
    if (render) render();
  };
  window.__emailReloadBody = (rid) => {
    delete _live.body.data[rid];
    delete _live.body.error[rid];
    if (render) render();
  };
  window.__emailMarkUnread = () => {
    const row = currentRow(); if (row) markRead(row, false);
  };
  window.__emailOpenKlant = (customerId) => {
    // v2-route naar klantdetail; NIET klanten.html of api/customer-dossier.js (protected).
    // Voor Fase 1: log-only (toast). Fase 2 hooked op DFO.goTab / klantdetail-route.
    console.info('[email-v2] TODO Fase 2: navigeer naar v2-klantdetail voor ' + customerId);
    if (H.showToast) H.showToast('Klant-dossier-koppeling komt in v2-detail-view (Fase 2).');
    else alert('Klant-koppeling komt in Fase 2 (v2-detail-view).');
  };
  window.__emailNewCompose = () => {
    _ui.composeMode = 'new';
    _ui.compose = { from_mailbox: _ui.compose.from_mailbox, to: '', cc: '', subject: '', body: '', email_id: null };
    _ui.composeOpen = true; _ui.lastSend = null;
    if (render) render();
  };
  function _replyState(mode) {
    const row = currentRow();
    if (!row) { alert('Selecteer eerst een bericht.'); return; }
    const from = MAILBOXES.find((m) => m.slug === row.mailbox);
    _ui.composeMode = mode;
    _ui.compose = {
      from_mailbox: from ? from.addr : _ui.compose.from_mailbox,
      to:           row.from_address || '',
      cc:           '',
      subject:      /^(re|fwd?):/i.test(row.subject || '') ? row.subject : (mode === 'fwd' ? 'Fwd: ' : 'Re: ') + (row.subject || ''),
      body:         '',
      email_id:     (row.mailbox && row.imap_uid != null) ? `${row.mailbox}@deforexopleiding.nl:${row.imap_uid}` : null,
    };
    _ui.composeOpen = true; _ui.lastSend = null;
    if (render) render();
  }
  window.__emailReply    = () => _replyState('reply');
  window.__emailReplyAll = () => _replyState('replyall');
  window.__emailFwd      = () => { _replyState('fwd'); _ui.compose.to = ''; if (render) render(); };
  window.__emailCloseCompose = () => { _ui.composeOpen = false; _ui.lastSend = null; if (render) render(); };
  window.__emailComposeField = (k, v) => { _ui.compose[k] = v; };
  window.__emailSend = () => { sendMail(); };
  window.__emailAiSetTone = (t) => { _ui.aiTone = t; if (render) render(); };
  window.__emailAiRegen   = () => { aiRegenerate(); };

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTRATIE
  // ═══════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['email/'] = emailView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('email');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('email');
  }
  console.debug('[email-v2] Fase 1 LIVE registered — 7 mailboxen aangesloten');
})();
