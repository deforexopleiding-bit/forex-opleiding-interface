// modules/klanten-v2/views/modals/taken-detail.js
//
// V2 Taken detail-modal. Bundelt alle v1-parity in één modal:
//   - Status-strip 3 knoppen (todo/progress/done) → POST /api/taken action=status_change
//   - Meta-grid (prio/cat/assignee/deadline/aangemaakt/afgerond)
//   - Notities-textarea + opslaan (POST /api/taken task upsert)
//   - Reacties (GET/POST /api/taken-comments?task_id=X)
//   - Watchers (GET/POST/DELETE /api/taken-watchers?task_id=X)
//   - Bijlagen (GET/POST/DELETE /api/taken-attachments?task_id=X + Storage bucket 'taken-attachments')
//     + video-embed (YouTube/Vimeo/Loom/Drive) via detectEmbed helper (1-op-1 uit tickets-v2).
//   - Bewerken-knop → openTakenCreateModal in edit-mode.
//   - Verwijderen-knop (POST /api/taken action=delete) — alleen creator/super_admin.
//
// Gebruikt .sw-modal-back namespace (bestaande overlay-CSS in klanten-v2.css).
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;
function esc(v) { return K().esc(v); }

const ATTACH_BUCKET = 'taken-attachments';
const ATTACH_MAX_MB = 10;
const ATTACH_SIGNED_TTL = 3600;

const STATUS_META = {
  todo:     { label: 'Open',   accent: 'var(--rose, #C22B3E)',   soft: 'var(--rose-soft, #FDECEE)' },
  progress: { label: 'Bezig',  accent: 'var(--blue, #1B5FBF)',   soft: 'var(--blue-soft, #E8F0FC)' },
  done:     { label: 'Klaar',  accent: 'var(--emerald, #07835A)', soft: 'var(--emerald-soft, #E4F5EE)' },
};

const PRIO_COLOR = {
  Urgent:  { accent: 'var(--rose, #C22B3E)',   soft: 'var(--rose-soft, #FDECEE)' },
  Hoog:    { accent: 'var(--amber, #C2700A)',  soft: 'var(--amber-soft, #FFF4E5)' },
  Normaal: { accent: 'var(--blue, #1B5FBF)',   soft: 'var(--blue-soft, #E8F0FC)' },
  Laag:    { accent: 'var(--text-2, #586374)', soft: 'var(--surface-2, #F2F4F7)' },
};

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return '—'; }
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch { return '—'; }
}

// Video-embed detector — 1-op-1 uit tickets-v2 (YouTube/Vimeo/Loom/Drive → iframe).
function detectEmbed(url) {
  if (!url) return null;
  const u = String(url).trim();
  if (!u) return null;
  let m;
  if ((m = u.match(/loom\.com\/share\/([a-f0-9]+)/i))) return { kind: 'iframe', src: `https://www.loom.com/embed/${m[1]}`, label: 'Loom video', domain: 'loom.com' };
  if ((m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/i))) return { kind: 'iframe', src: `https://www.youtube.com/embed/${m[1]}`, label: 'YouTube video', domain: 'youtube.com' };
  if ((m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i))) return { kind: 'iframe', src: `https://player.vimeo.com/video/${m[1]}`, label: 'Vimeo video', domain: 'vimeo.com' };
  if ((m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/i))) return { kind: 'iframe', src: `https://drive.google.com/file/d/${m[1]}/preview`, label: 'Drive bestand', domain: 'drive.google.com' };
  let domain = '';
  try { domain = new URL(u).hostname.replace(/^www\./, ''); } catch (_) {}
  return { kind: 'link', src: u, label: domain || u, domain };
}
function isValidHttpUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try { const p = new URL(u.trim()); return p.protocol === 'http:' || p.protocol === 'https:'; }
  catch { return false; }
}
const isImage = (m) => typeof m === 'string' && m.startsWith('image/');

function cleanFilename(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot >= 0 ? name.slice(0, dot) : name).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bijlage';
  const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  return base.slice(0, 80) + ext.slice(0, 10);
}

// STAFF_ROLES filter (zelfde als taken-create.js). /api/profiles-list
// levert alle actieve accounts (incl. klant/student); wij pikken alleen
// interne staf voor de watcher-picker.
const STAFF_ROLES = new Set(['super_admin', 'manager', 'sales', 'mentor', 'marketing']);
const isStaff = (m) => STAFF_ROLES.has(String(m?.role || '').toLowerCase());

// ── State ──────────────────────────────────────────────────────────────────
let state = null;
let _membersCache = null;
let _currentUserId = null;
const _signedUrls = new Map();

async function loadMembers() {
  if (_membersCache) return _membersCache;
  try {
    const j = await K().authedJson('/api/profiles-list');
    const all = Array.isArray(j?.members) ? j.members : [];
    _membersCache = all.filter(isStaff);
  } catch (_) { _membersCache = []; }
  return _membersCache;
}
async function getCurrentUserId() {
  if (_currentUserId) return _currentUserId;
  try {
    const { data: { user } } = await window.supabase.auth.getUser();
    _currentUserId = user?.id || null;
  } catch (_) { _currentUserId = null; }
  return _currentUserId;
}
async function getSignedUrl(path) {
  if (!path) return null;
  if (_signedUrls.has(path)) return _signedUrls.get(path);
  if (!window.supabase?.storage) return null;
  try {
    const { data, error } = await window.supabase.storage.from(ATTACH_BUCKET).createSignedUrl(path, ATTACH_SIGNED_TTL);
    if (error || !data?.signedUrl) return null;
    _signedUrls.set(path, data.signedUrl);
    return data.signedUrl;
  } catch (_) { return null; }
}

// ── Load all task-related data ─────────────────────────────────────────────
async function loadTaskDetail(taskId) {
  // taken.js /api/taken returnt de hele lijst — filter client-side. Voor
  // detail hebben we scope=mine + scope=assigned_by_me nodig (creator kan
  // ook edit doen zonder assignee te zijn).
  try {
    const [mine, byMe, comments, watchers, attachments] = await Promise.all([
      K().authedJson('/api/taken?scope=mine').catch(() => ({ taken: [] })),
      K().authedJson('/api/taken?scope=assigned_by_me').catch(() => ({ taken: [] })),
      K().authedJson('/api/taken-comments?task_id=' + encodeURIComponent(taskId)).catch(() => ({ comments: [] })),
      K().authedJson('/api/taken-watchers?task_id=' + encodeURIComponent(taskId)).catch(() => ({ watchers: [] })),
      K().authedJson('/api/taken-attachments?task_id=' + encodeURIComponent(taskId)).catch(() => ({ attachments: [] })),
    ]);
    const all = [].concat(mine?.taken || [], byMe?.taken || []);
    const task = all.find((t) => t.id === taskId) || null;
    return {
      task,
      comments: Array.isArray(comments?.comments) ? comments.comments : [],
      watchers: Array.isArray(watchers?.watchers) ? watchers.watchers : [],
      attachments: Array.isArray(attachments?.attachments) ? attachments.attachments : [],
    };
  } catch (e) {
    throw new Error(e?.message || 'Kon taak niet laden');
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────
function renderHead() {
  const t = state.task || {};
  return `
    <div class="kv-edit-head">
      <div style="flex:1; min-width:0;">
        <div class="kv-edit-head-eyebrow">Taak · ${esc(t.categorie || 'Overige')}</div>
        <div class="kv-edit-head-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(t.titel || 'Laden…')}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-td-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderStatusStrip() {
  const cur = state.task?.status || 'todo';
  return `
    <div class="kv-td-status-strip">
      ${['todo', 'progress', 'done'].map((s) => {
        const m = STATUS_META[s];
        const active = cur === s;
        return `<button type="button" class="kv-td-status-btn ${active ? 'is-active' : ''}"
                  data-kv-td-status="${s}"
                  style="${active ? `background:${m.soft}; color:${m.accent}; border-color:${m.accent};` : ''}"
                  ${state.saving ? 'disabled' : ''}>
                  ${m.label}
                </button>`;
      }).join('')}
    </div>`;
}

function renderMeta() {
  const t = state.task || {};
  const pMeta = PRIO_COLOR[t.prioriteit] || PRIO_COLOR.Normaal;
  return `
    <div class="kv-td-meta-grid">
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Prioriteit</span>
        <span class="kv-td-meta-v">
          <span class="kv-td-prio-pill" style="background:${pMeta.soft}; color:${pMeta.accent}; border-color:${pMeta.accent};">${esc(t.prioriteit || 'Normaal')}</span>
        </span>
      </div>
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Categorie</span>
        <span class="kv-td-meta-v">${esc(t.categorie || 'Overige')}</span>
      </div>
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Toegewezen aan</span>
        <span class="kv-td-meta-v">${esc(t.assigned_to_name || (t.assigned_to_id ? '#' + String(t.assigned_to_id).slice(0, 6) : 'Niemand'))}</span>
      </div>
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Toegewezen door</span>
        <span class="kv-td-meta-v">${esc(t.created_by_name || (t.created_by_agent ? t.created_by_agent + ' (agent)' : '—'))}</span>
      </div>
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Deadline</span>
        <span class="kv-td-meta-v">${fmtDate(t.deadline)}</span>
      </div>
      <div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Aangemaakt</span>
        <span class="kv-td-meta-v">${fmtDateTime(t.aangemaakt)}</span>
      </div>
      ${t.afgerond_op ? `<div class="kv-td-meta-row">
        <span class="kv-td-meta-l">Afgerond op</span>
        <span class="kv-td-meta-v">${fmtDateTime(t.afgerond_op)}</span>
      </div>` : ''}
    </div>`;
}

function renderOmschrijving() {
  const t = state.task || {};
  return `
    <div class="kv-td-section">
      <div class="kv-td-section-title">Omschrijving</div>
      <div class="kv-td-desc">${t.omschrijving ? esc(t.omschrijving).replace(/\n/g, '<br>') : '<em style="color:var(--text-3)">Geen omschrijving.</em>'}</div>
    </div>`;
}

function renderNotities() {
  const canEdit = state.canEdit;
  return `
    <div class="kv-td-section">
      <div class="kv-td-section-title">Notities <span style="color:var(--text-3); font-weight:400;">(privé / eigen aantekeningen)</span></div>
      <textarea class="ib-input" rows="3" placeholder="Persoonlijke notities…" data-kv-td-notities ${canEdit ? '' : 'readonly'}>${esc(state.notitiesDraft)}</textarea>
      ${canEdit ? `<div style="display:flex; justify-content:flex-end; margin-top:6px;">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-td-save-notities ${state.savingNotities ? 'disabled' : ''}>
          ${state.savingNotities ? 'Opslaan…' : 'Notities opslaan'}
        </button>
      </div>` : ''}
    </div>`;
}

function renderComments() {
  const cs = state.comments || [];
  return `
    <div class="kv-td-section">
      <div class="kv-td-section-title">Reacties <span style="color:var(--text-3); font-weight:400;">(${cs.length})</span></div>
      ${cs.length ? `<div class="kv-td-comments">
        ${cs.map((c) => `
          <div class="kv-td-comment">
            <div class="kv-td-comment-head">
              <strong>${esc(c.author_name || 'Onbekend')}</strong>
              <span class="kv-td-comment-time">${fmtDateTime(c.created_at)}</span>
            </div>
            <div class="kv-td-comment-body">${esc(c.body).replace(/\n/g, '<br>')}</div>
          </div>
        `).join('')}
      </div>` : `<div style="font-size:12.5px; color:var(--text-3); font-style:italic;">Nog geen reacties.</div>`}
      <div class="kv-td-comment-form">
        <textarea class="ib-input" rows="2" placeholder="Schrijf een reactie…" data-kv-td-comment-input maxlength="2000">${esc(state.commentDraft)}</textarea>
        <div style="display:flex; justify-content:flex-end; margin-top:6px;">
          <button type="button" class="ds-btn ds-btn-primary ds-btn-sm" data-kv-td-comment-submit ${state.savingComment ? 'disabled' : ''}>
            ${state.savingComment ? 'Bezig…' : 'Verstuur reactie'}
          </button>
        </div>
      </div>
    </div>`;
}

function renderWatchers() {
  const ws = state.watchers || [];
  const membersOpts = state.membersLoading
    ? '<option value="">Laden…</option>'
    : ['<option value="">— Kies persoon —</option>']
        .concat(
          (_membersCache || [])
            .filter((m) => !ws.some((w) => w.profile_id === m.id))
            .map((m) => `<option value="${esc(m.id)}">${esc(m.full_name || m.email || m.id.slice(0, 8))}</option>`)
        )
        .join('');
  return `
    <div class="kv-td-section">
      <div class="kv-td-section-title">CC <span style="color:var(--text-3); font-weight:400;">· kijkt mee (${ws.length})</span></div>
      ${ws.length ? `<div class="kv-td-watchers">
        ${ws.map((w) => `
          <div class="kv-td-watcher-row">
            <span>${esc(w.profile_name || w.profile_email || '#' + String(w.profile_id).slice(0, 6))}</span>
            <button type="button" class="ds-icon-btn kv-td-watcher-del" data-kv-td-watcher-del="${esc(w.id)}" title="Verwijderen" ${state.savingWatcher ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        `).join('')}
      </div>` : `<div style="font-size:12.5px; color:var(--text-3); font-style:italic;">Nog geen watchers.</div>`}
      <div class="kv-td-watcher-add">
        <select class="ib-input" data-kv-td-watcher-select ${state.savingWatcher ? 'disabled' : ''}>${membersOpts}</select>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-td-watcher-add ${state.savingWatcher ? 'disabled' : ''}>
          ${state.savingWatcher ? 'Bezig…' : 'Toevoegen'}
        </button>
      </div>
    </div>`;
}

function renderAttachments() {
  const atts = state.attachments || [];
  const images = atts.filter((a) => a.storage_path && isImage(a.mime_type));
  const files  = atts.filter((a) => a.storage_path && !isImage(a.mime_type));
  const links  = atts.filter((a) => a.external_url);
  return `
    <div class="kv-td-section">
      <div class="kv-td-section-title">Bijlagen <span style="color:var(--text-3); font-weight:400;">(${atts.length})</span></div>

      ${images.length ? `<div class="tk-att-grid">
        ${images.map((a) => `<div class="tk-att-img-card" onclick="__takenAttOpen('${esc(a.storage_path)}')">
          <img data-att-path="${esc(a.storage_path)}" alt="${esc(a.filename || 'bijlage')}" class="tk-att-img"/>
          <div class="tk-att-meta">${esc(a.filename || 'bijlage')}</div>
          <button class="tk-att-del" onclick="event.stopPropagation();__takenAttDelete('${esc(a.id)}')" title="Verwijder">×</button>
        </div>`).join('')}
      </div>` : ''}

      ${files.length ? `<div class="tk-att-files">
        ${files.map((a) => `<div class="tk-att-file-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          <a href="#" onclick="event.preventDefault();__takenAttOpen('${esc(a.storage_path)}')" class="tk-att-file-name">${esc(a.filename || (a.storage_path || '').split('/').pop() || 'bestand')}</a>
          <span class="tk-att-file-mime">${esc(a.mime_type || '')}</span>
          <button class="ds-icon-btn" onclick="__takenAttDelete('${esc(a.id)}')" title="Verwijderen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>`).join('')}
      </div>` : ''}

      ${links.length ? `<div class="tk-embed-wrap">
        ${links.map((a) => {
          const e = detectEmbed(a.external_url);
          const body = (e && e.kind === 'iframe')
            ? `<div class="tk-embed-card"><iframe src="${esc(e.src)}" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe></div>`
            : `<a class="tk-embed-link" href="${esc(a.external_url)}" target="_blank" rel="noopener">
                 <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;flex-shrink:0"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                 <span class="tk-embed-link-name">${esc(a.filename || (e && e.label) || a.external_url)}</span>
                 <span class="tk-embed-link-domain">${esc((e && e.domain) || '')}</span>
               </a>`;
          return `<div class="tk-embed-row">
            <div class="tk-embed-body">${body}</div>
            <button class="ds-icon-btn" onclick="__takenAttDelete('${esc(a.id)}')" title="Verwijderen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>`;
        }).join('')}
      </div>` : ''}

      ${!atts.length ? `<div style="font-size:12.5px; color:var(--text-3); font-style:italic;">Nog geen bijlagen.</div>` : ''}

      <label class="tk-att-picker" style="margin-top:10px; display:inline-block;">
        <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" onchange="__takenAttPickFiles(this)" ${state.attUploading ? 'disabled' : ''} style="display:none">
        <span class="ds-btn ds-btn-ghost ds-btn-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${state.attUploading ? 'Uploaden…' : 'Bestand toevoegen'}
        </span>
      </label>
      <div class="tk-att-link-add">
        <input class="ib-input" type="url" placeholder="Plak YouTube / Vimeo / Loom / Drive-link…"
          value="${esc(state.attUrlDraft)}"
          data-kv-td-att-url
          ${state.attUrlSubmitting ? 'disabled' : ''}>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-td-att-url-add ${state.attUrlSubmitting ? 'disabled' : ''}>
          ${state.attUrlSubmitting ? 'Bezig…' : 'URL toevoegen'}
        </button>
      </div>
      <div class="tk-att-hint">Alleen afbeeldingen (PNG/JPG/GIF/WEBP) direct uploaden, max ${ATTACH_MAX_MB} MB. Video's / documenten via URL (YouTube, Vimeo, Loom, Drive).</div>
    </div>`;
}

function renderBody() {
  if (state.loading) return `<div style="padding:32px; text-align:center; color:var(--text-2);">Taak laden…</div>`;
  if (state.error || !state.task) return `<div class="kv-edit-banner">${esc(state.error || 'Kon taak niet vinden.')}</div>`;
  return `
    <form class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      ${renderStatusStrip()}
      ${renderMeta()}
      ${renderOmschrijving()}
      ${renderNotities()}
      ${renderComments()}
      ${renderWatchers()}
      ${renderAttachments()}
    </form>`;
}

function renderFoot() {
  const canEdit = state.canEdit;
  const canDelete = state.canDelete;
  return `
    <div class="kv-edit-foot" style="justify-content:space-between;">
      <div>
        ${canDelete ? `<button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-td-delete style="color:var(--rose);" ${state.saving ? 'disabled' : ''}>Verwijderen</button>` : ''}
      </div>
      <div style="display:flex; gap:8px;">
        <button type="button" class="ds-btn ds-btn-ghost" data-kv-td-close>Sluiten</button>
        ${canEdit ? `<button type="button" class="ds-btn ds-btn-primary" data-kv-td-edit>Bewerken</button>` : ''}
      </div>
    </div>`;
}

// ── Actions ────────────────────────────────────────────────────────────────
async function changeStatus(newStatus) {
  if (state.saving || !state.task) return;
  const old = state.task.status;
  state.saving = true;
  state.task.status = newStatus;   // optimistic
  rerender();
  try {
    await K().authedJson('/api/taken', {
      method: 'POST',
      body: JSON.stringify({ action: 'status_change', id: state.task.id, status: newStatus }),
    });
    if (newStatus === 'done' && !state.task.afgerond_op) state.task.afgerond_op = new Date().toISOString();
    if (newStatus !== 'done') state.task.afgerond_op = null;
    K().toast('Status → ' + STATUS_META[newStatus].label);
    if (typeof state.onSuccess === 'function') state.onSuccess();
  } catch (e) {
    state.task.status = old;   // rollback
    state.globalError = e?.message || 'Status-wijziging mislukt';
  }
  state.saving = false;
  rerender();
}

async function saveNotities() {
  if (state.savingNotities || !state.task) return;
  const patch = String(state.notitiesDraft || '').trim();
  if (patch === (state.task.notities || '')) { K().toast('Geen wijzigingen'); return; }
  state.savingNotities = true;
  rerender();
  try {
    // KRITIEK: server toRow zet defaults ('todo', now(), '') voor niet-
    // meegestuurde velden. Alleen {id, notities} sturen zou titel/status/
    // aangemaakt/etc destructief overschrijven bij UPSERT. Stuur alle
    // bestaande task-velden mee zodat server geen defaults toepast.
    const t = state.task;
    await K().authedJson('/api/taken', {
      method: 'POST',
      body: JSON.stringify({ task: {
        id: t.id,
        titel: t.titel || '',
        omschrijving: t.omschrijving || '',
        prioriteit: t.prioriteit || 'Normaal',
        categorie: t.categorie || 'Overige',
        assignedToId: t.assigned_to_id || null,
        customerId: t.customer_id || null,
        deadline: t.deadline || null,
        emailId: t.email_id || null,
        emailSubject: t.email_subject || null,
        status: t.status || 'todo',
        aangemaakt: t.aangemaakt || null,
        afgerondOp: t.afgerond_op || null,
        notities: patch || null,
      }}),
    });
    state.task.notities = patch;
    K().toast('Notities opgeslagen');
    if (typeof state.onSuccess === 'function') state.onSuccess();
  } catch (e) {
    state.globalError = e?.message || 'Notities-opslag mislukt';
  }
  state.savingNotities = false;
  rerender();
}

async function submitComment() {
  if (state.savingComment || !state.task) return;
  const body = String(state.commentDraft || '').trim();
  if (!body) { K().toast('Reactie is leeg'); return; }
  state.savingComment = true;
  rerender();
  try {
    const j = await K().authedJson('/api/taken-comments', {
      method: 'POST',
      body: JSON.stringify({ task_id: state.task.id, body }),
    });
    if (j?.comment) state.comments.push(j.comment);
    state.commentDraft = '';
    K().toast('Reactie geplaatst');
  } catch (e) {
    state.globalError = e?.message || 'Reactie plaatsen mislukt';
  }
  state.savingComment = false;
  rerender();
}

async function addWatcher() {
  if (state.savingWatcher || !state.task) return;
  const sel = document.querySelector('[data-kv-td-watcher-select]');
  const profile_id = sel?.value;
  if (!profile_id) { K().toast('Kies een persoon'); return; }
  state.savingWatcher = true;
  rerender();
  try {
    const j = await K().authedJson('/api/taken-watchers', {
      method: 'POST',
      body: JSON.stringify({ task_id: state.task.id, profile_id }),
    });
    if (j?.watcher) {
      const member = (_membersCache || []).find((m) => m.id === profile_id);
      state.watchers.push({
        ...j.watcher,
        profile_name: member?.full_name || null,
        profile_email: member?.email || null,
      });
    }
    K().toast('Watcher toegevoegd');
  } catch (e) {
    state.globalError = e?.message || 'Watcher toevoegen mislukt';
  }
  state.savingWatcher = false;
  rerender();
}

async function removeWatcher(watcherId) {
  if (state.savingWatcher) return;
  if (!confirm('Watcher verwijderen?')) return;
  state.savingWatcher = true;
  rerender();
  try {
    const resp = await K().authedFetch('/api/taken-watchers?id=' + encodeURIComponent(watcherId), { method: 'DELETE' });
    if (!resp.ok && resp.status !== 204) {
      const t = await resp.text();
      const j = t ? (function () { try { return JSON.parse(t); } catch { return null; } })() : null;
      throw new Error(j?.error || 'HTTP ' + resp.status);
    }
    state.watchers = state.watchers.filter((w) => w.id !== watcherId);
    K().toast('Watcher verwijderd');
  } catch (e) {
    state.globalError = e?.message || 'Watcher verwijderen mislukt';
  }
  state.savingWatcher = false;
  rerender();
}

async function pickFiles(input) {
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length) return;
  state.attUploading = true;
  rerender();
  for (const file of files) {
    if (file.size > ATTACH_MAX_MB * 1024 * 1024) {
      alert(`Bestand "${file.name}" te groot (max ${ATTACH_MAX_MB} MB).`);
      continue;
    }
    try {
      const { data: { user } } = await window.supabase.auth.getUser();
      if (!user) throw new Error('Auth-fout bij upload');
      const path = `${user.id}/${state.task.id}/${Date.now()}-${cleanFilename(file.name || 'bijlage')}`;
      const { error: upErr } = await window.supabase.storage
        .from(ATTACH_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
      if (upErr) throw new Error('Storage: ' + upErr.message);
      const j = await K().authedJson('/api/taken-attachments', {
        method: 'POST',
        body: JSON.stringify({ task_id: state.task.id, storage_path: path, filename: file.name || null, mime_type: file.type || null }),
      });
      if (j?.attachment) state.attachments.push(j.attachment);
    } catch (e) {
      console.warn('[taken-detail] upload fail:', e?.message);
      alert('Upload mislukt: ' + (e?.message || 'onbekende fout'));
    }
  }
  state.attUploading = false;
  rerender();
}

async function addAttachmentUrl() {
  if (state.attUrlSubmitting || !state.task) return;
  const raw = String(state.attUrlDraft || '').trim();
  if (!raw) return;
  if (!isValidHttpUrl(raw)) { alert('Ongeldige URL (moet beginnen met http:// of https://).'); return; }
  state.attUrlSubmitting = true;
  rerender();
  try {
    const j = await K().authedJson('/api/taken-attachments', {
      method: 'POST',
      body: JSON.stringify({ task_id: state.task.id, external_url: raw }),
    });
    if (j?.attachment) state.attachments.push(j.attachment);
    state.attUrlDraft = '';
    K().toast('Link toegevoegd');
  } catch (e) {
    state.globalError = e?.message || 'URL toevoegen mislukt';
  }
  state.attUrlSubmitting = false;
  rerender();
}

async function deleteAttachment(attId) {
  if (!attId || !confirm('Bijlage verwijderen?')) return;
  try {
    const resp = await K().authedFetch('/api/taken-attachments?id=' + encodeURIComponent(attId), { method: 'DELETE' });
    if (!resp.ok && resp.status !== 204) {
      const t = await resp.text();
      const j = t ? (function () { try { return JSON.parse(t); } catch { return null; } })() : null;
      throw new Error(j?.error || 'HTTP ' + resp.status);
    }
    state.attachments = state.attachments.filter((a) => a.id !== attId);
    K().toast('Bijlage verwijderd');
    rerender();
  } catch (e) {
    alert('Verwijderen mislukt: ' + (e?.message || 'onbekende fout'));
  }
}

async function openAttachment(path) {
  const url = await getSignedUrl(path);
  if (url) window.open(url, '_blank', 'noopener');
  else alert('Kon bijlage-URL niet ophalen.');
}

async function deleteTask() {
  if (!state.task || !state.canDelete) return;
  if (!confirm(`Weet je zeker dat je "${state.task.titel}" wilt verwijderen? Dit kan niet ongedaan worden gemaakt.`)) return;
  state.saving = true;
  rerender();
  try {
    await K().authedJson('/api/taken', {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', id: state.task.id }),
    });
    K().toast('Taak verwijderd');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    state.globalError = e?.message || 'Verwijderen mislukt';
    state.saving = false;
    rerender();
  }
}

async function openEdit() {
  try {
    const mod = await import('./taken-create.js');
    mod.openTakenCreateModal({
      task: state.task,
      mode: 'edit',
      onSuccess: () => {
        // Sluit edit-modal, herlaad detail.
        if (typeof state.onSuccess === 'function') state.onSuccess();
        // Herlaad detail met verse data.
        if (state.task?.id) openTakenDetailModal({ taskId: state.task.id, onSuccess: state.onSuccess });
      },
    });
  } catch (e) {
    K().toast('Kon edit-modal niet laden');
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────
function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-td-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelectorAll('[data-kv-td-status]').forEach((b) => b.addEventListener('click', () => changeStatus(b.getAttribute('data-kv-td-status'))));
  box.querySelector('[data-kv-td-notities]')?.addEventListener('input', (e) => { state.notitiesDraft = e.target.value; });
  box.querySelector('[data-kv-td-save-notities]')?.addEventListener('click', saveNotities);
  box.querySelector('[data-kv-td-comment-input]')?.addEventListener('input', (e) => { state.commentDraft = e.target.value; });
  box.querySelector('[data-kv-td-comment-submit]')?.addEventListener('click', submitComment);
  box.querySelector('[data-kv-td-watcher-add]')?.addEventListener('click', addWatcher);
  box.querySelectorAll('[data-kv-td-watcher-del]').forEach((b) => b.addEventListener('click', () => removeWatcher(b.getAttribute('data-kv-td-watcher-del'))));
  box.querySelector('[data-kv-td-att-url]')?.addEventListener('input', (e) => { state.attUrlDraft = e.target.value; });
  box.querySelector('[data-kv-td-att-url-add]')?.addEventListener('click', addAttachmentUrl);
  box.querySelector('[data-kv-td-delete]')?.addEventListener('click', deleteTask);
  box.querySelector('[data-kv-td-edit]')?.addEventListener('click', openEdit);
  // Hydrateer attachment thumbnails.
  box.querySelectorAll('img[data-att-path]:not([src])').forEach(async (img) => {
    const p = img.getAttribute('data-att-path');
    const url = await getSignedUrl(p);
    if (url) img.src = url;
  });
}

// Window-exports (voor onclick-handlers in innerHTML). Guard voor
// non-browser import (Node syntax-check).
if (typeof window !== 'undefined') {
  window.__takenAttOpen = openAttachment;
  window.__takenAttDelete = deleteAttachment;
  window.__takenAttPickFiles = pickFiles;
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ───────────────────────────────────────────────────────────
export async function openTakenDetailModal({ taskId, onSuccess } = {}) {
  if (!taskId) { K().toast('Geen taak-id'); return; }
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar'); return; }
  state = {
    loading: true, error: null,
    task: null, comments: [], watchers: [], attachments: [],
    notitiesDraft: '', commentDraft: '', attUrlDraft: '',
    saving: false, savingNotities: false, savingComment: false, savingWatcher: false,
    attUploading: false, attUrlSubmitting: false,
    canEdit: false, canDelete: false,
    globalError: null,
    onSuccess: onSuccess || null,
    membersLoading: true,
  };
  rerender();

  // Parallel: load task + members + current user
  const [data, members, currentUserId] = await Promise.all([
    loadTaskDetail(taskId).catch((e) => ({ _error: e?.message })),
    loadMembers(),
    getCurrentUserId(),
  ]);
  if (!state) return;
  state.membersLoading = false;

  if (data?._error || !data?.task) {
    state.loading = false;
    state.error = data?._error || 'Taak niet gevonden of geen toegang.';
    rerender();
    return;
  }

  state.loading = false;
  state.task = data.task;
  state.comments = data.comments;
  state.watchers = data.watchers;
  state.attachments = data.attachments;
  state.notitiesDraft = data.task.notities || '';
  state.canEdit = !!currentUserId && (
    data.task.created_by === currentUserId ||
    data.task.assigned_to_id === currentUserId
  );
  state.canDelete = !!currentUserId && data.task.created_by === currentUserId;
  rerender();
}
