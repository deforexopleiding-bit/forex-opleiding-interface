// modules/klanten-v2/views/logboek-v2.js
//
// Fase F — Logboek (activiteit-/auditlog). DATA-KOPPELING 2026-08-13.
// Dormant — QA via ?v2preview=logboek. Rol super_admin/admin/manager
// (perm audit.log.view op de endpoints).
//
// Endpoints:
//   GET /api/activity-log-list?user_id=&role=&module=&success=&q=&from=&to=&page=&page_size=
//   GET /api/activity-users-list  (users-dropdown pre-fetch)

(function () {
  if (!window.DFO) { console.error('[logboek-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[logboek-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const PAGE_SIZE = 50;
  const _live = {
    activity: { loading: false, error: null, data: null, params: '', page: 1 },
    users:    { loading: false, error: null, data: null },
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[logboek-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  function _presetRange(p) {
    const now = new Date();
    const to = now.toISOString();
    const d = new Date(now);
    if (p === 'd') d.setHours(0, 0, 0, 0);
    else if (p === 'w') d.setDate(d.getDate() - 7);
    else if (p === 'm') d.setMonth(d.getMonth() - 1);
    else return { from: '', to: '' };
    return { from: d.toISOString(), to };
  }

  function _buildParams(page) {
    const p = F('t', 'w');
    const uid = F('user', '');
    const role = F('role', '');
    const mod = F('module', '');
    const succ = F('success', '');
    const q = F('q', '');
    const rng = _presetRange(p);
    const parts = ['page=' + (page || 1), 'page_size=' + PAGE_SIZE];
    if (uid) parts.push('user_id=' + encodeURIComponent(uid));
    if (role) parts.push('role=' + encodeURIComponent(role));
    if (mod) parts.push('module=' + encodeURIComponent(mod));
    if (succ) parts.push('success=' + encodeURIComponent(succ));
    if (q) parts.push('q=' + encodeURIComponent(q));
    if (rng.from) parts.push('from=' + encodeURIComponent(rng.from));
    if (rng.to) parts.push('to=' + encodeURIComponent(rng.to));
    return parts.join('&');
  }

  async function fetchActivity() {
    const st = _live.activity;
    const params = _buildParams(st.page);
    if (st.loading && st.params === params) return;
    st.loading = true; st.error = null; st.params = params; st.data = null;
    const j = await tryFetch('activity', '/api/activity-log-list?' + params);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { rows: asArr(j?.rows), total: Number(j?.total || 0), page: Number(j?.page || 1), page_size: Number(j?.page_size || PAGE_SIZE) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchUsers() {
    const st = _live.users;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('users', '/api/activity-users-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.users);
    if (window.DFO?.render) window.DFO.render();
  }

  window.__logRetry = (b) => {
    if (b === 'activity') { _live.activity.data = null; _live.activity.error = null; fetchActivity(); }
    if (b === 'users')    { _live.users.data = null; _live.users.error = null; fetchUsers(); }
    if (window.DFO?.render) window.DFO.render();
  };
  window.__logFilter = (k, v) => { _live.activity.page = 1; _live.activity.data = null; window.DFO.setF(k, v); };
  window.__logPage = (n) => { _live.activity.page = Math.max(1, Number(n) || 1); _live.activity.data = null; if (window.DFO?.render) window.DFO.render(); };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon gegevens niet ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__logRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const rollePill = (r) => H.pill(r === 'super_admin' ? 'violet' : r === 'admin' || r === 'manager' ? 'accent' : r === 'sales' ? 'emerald' : 'teal', r || '—', 1);

  function _fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function _fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function _relTime(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '—';
    const diff = Date.now() - t;
    if (diff < 60000) return 'nu';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min geleden';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' uur geleden';
    return Math.floor(diff / 86400000) + ' dag geleden';
  }

  // ── VIEW: Activiteit ──────────────────────────────────────────────────
  function activiteitView() {
    if (!_live.users.data && !_live.users.loading && !_live.users.error) queueMicrotask(fetchUsers);
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (_live.activity.error && !_live.activity.data) return errBlk('activity', _live.activity.error);
    if (_live.activity.loading && !_live.activity.data) return skel();
    const users = asArr(_live.users.data);
    const rows = asArr(_live.activity.data?.rows);
    const total = Number(_live.activity.data?.total || 0);
    const page = Number(_live.activity.data?.page || 1);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return `${H.toolbar([
      H.chips('t', [{ l: 'Deze week', v: 'w' }, { l: 'Vandaag', v: 'd' }, { l: 'Deze maand', v: 'm' }, { l: 'Alles', v: 'all' }], F('t', 'w')),
      `<select class="filter-sel" onchange="__logFilter('user', this.value)">
        <option value="">Alle gebruikers</option>
        ${users.map((u) => `<option value="${esc(u.user_id)}" ${F('user','')===u.user_id?'selected':''}>${esc(u.user_email || u.user_id.slice(0,8))}</option>`).join('')}
      </select>`,
      `<select class="filter-sel" onchange="__logFilter('role', this.value)">
        <option value="">Alle rollen</option>
        ${['super_admin','admin','manager','sales','mentor','administratie','viewer'].map((r) => `<option value="${r}" ${F('role','')===r?'selected':''}>${r}</option>`).join('')}
      </select>`,
      `<select class="filter-sel" onchange="__logFilter('success', this.value)">
        <option value="">Alle resultaten</option>
        <option value="true"  ${F('success','')==='true'?'selected':''}>Gelukt</option>
        <option value="false" ${F('success','')==='false'?'selected':''}>Geweigerd</option>
      </select>`,
      H.search('Zoek op actie of e-mail…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__logRetry('activity')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen activiteit</div><div class="empty-s">Geen rijen voldoen aan de filter.</div></div>`
      : H.table(
          [{ l: 'Tijd' }, { l: 'Gebruiker' }, { l: 'Rol', cls: 'optional' }, { l: 'Module', cls: 'optional' }, { l: 'Actie' }, { l: 'Methode', cls: 'optional' }, { l: 'Resultaat' }, { l: 'IP', cls: 'optional' }],
          rows.map((r) => [
            `<span class="mono" style="color:var(--text-3);font-size:12px" title="${esc(r.created_at)}">${esc(_fmtTime(r.created_at))}</span>`,
            `<span class="cell-main">${esc(r.user_email || '—')}</span>`,
            rollePill(r.user_role),
            `<span style="font-size:12.5px;color:var(--text-2)">${esc(r.module || '—')}</span>`,
            `<span class="mono" style="font-size:12.5px">${esc(r.action || '—')}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(r.method || '')}</span>`,
            H.pill(r.success ? 'ok' : 'danger', (r.success ? 'ok ' : 'fout ') + (r.status_code || '?')),
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(r.ip || '—')}</span>`,
          ])
        )}
    <div style="padding:12px 20px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:var(--text-2);flex-wrap:wrap">
      <span>${total > 0 ? ((page - 1) * PAGE_SIZE + 1) + '–' + Math.min(page * PAGE_SIZE, total) + ' van ' + total : '0 rijen'}</span>
      ${totalPages > 1 ? `<div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="__logPage(${page - 1})">← Vorige</button>
        <span class="mono" style="padding:0 8px;align-self:center">${page} / ${totalPages}</span>
        <button class="btn btn-ghost btn-sm" ${page >= totalPages ? 'disabled' : ''} onclick="__logPage(${page + 1})">Volgende →</button>
      </div>` : ''}
    </div>`;
  }

  // ── VIEW: Per gebruiker ───────────────────────────────────────────────
  function perGebruikerView() {
    if (!_live.users.data && !_live.users.loading && !_live.users.error) queueMicrotask(fetchUsers);
    if (_live.users.error && !_live.users.data) return errBlk('users', _live.users.error);
    if (_live.users.loading && !_live.users.data) return skel();
    const users = asArr(_live.users.data);
    const q = (F('q', '') || '').toLowerCase();
    const rows = users.filter((u) => !q || String(u.user_email || '').toLowerCase().includes(q));
    return `${H.toolbar([H.search('Zoek gebruiker…')])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen gebruikers</div></div>`
      : H.table(
          [{ l: 'Gebruiker' }, { l: 'Rol' }, { l: 'Laatst ingelogd', cls: 'optional' }, { l: 'Laatst actief' }, { l: 'IP', cls: 'optional' }, { l: 'Acties', cls: 'r' }],
          rows.map((u) => [
            `<div class="row-avatar">${H.av(u.user_email || '—', 28)}<span class="cell-main">${esc(u.user_email || '—')}</span></div>`,
            rollePill(u.user_role),
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDateTime(u.last_login_at))}</span>`,
            `<span style="font-size:12.5px">${esc(_relTime(u.last_activity_at))}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(u.last_ip || '—')}</span>`,
            `<span class="mono">${Number(u.action_count || 0)}</span>`,
          ])
        )}`;
  }

  window.DFO.VIEWS['logboek/Activiteit']    = activiteitView;
  window.DFO.VIEWS['logboek/Per gebruiker'] = perGebruikerView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('logboek');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('logboek');
  console.debug('[logboek-v2] data-ronde geregistreerd (dormant)');
})();
