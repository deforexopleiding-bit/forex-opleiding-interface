// modules/klanten-v2/views/modals/taken-create.js
//
// V2 Taken create / edit-modal (dual gebruik). Mirror van invoice-* / sub-
// scription-actions modal-pattern: DFO.openModal head/body/foot + window.KV
// authedJson/authedFetch. Gebruikt .sw-modal-back namespace (NIET nieuwe
// klassen — recidive-fix, zie tickets-3fixes commit 4091550).
//
// Endpoint: POST /api/taken (task-upsert, camelCase body)
//   Nieuw:  { task: { titel, omschrijving, prioriteit, categorie,
//                     assignedToId, deadline, customerId?, emailId? } }
//   Edit:   { task: { id, ...bovenstaande } }
//   Server RBAC: taken.task.create (nieuw) / taken.task.edit (edit, alleen
//   creator of super_admin).
//
// Assignee-lijst: /api/profiles-list → { members: [{id, full_name, email, role}] }
// Prio: Urgent / Hoog / Normaal / Laag (v1-format, backend accepteert deze
//   waardes 1-op-1).
// Categorie: Sales/Onboarding/Mentoring/Finance/Klant/Marketing/Intern/Overige.
//
// Create-mode extensie (2026-08-12): CC + bijlagen als pending-lists.
// Na succesvolle task-create wordt task.id gebruikt voor:
//   - POST /api/taken-watchers per CC-item (best-effort, fail-soft)
//   - Storage-upload + POST /api/taken-attachments per file
//   - POST /api/taken-attachments per URL (external_url)
// Edit-mode toont deze secties NIET — CC/bijlagen beheer je in detail-modal
// (geen dubbele beheer-UI).
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;
function esc(v) { return K().esc(v); }

const CATEGORIEEN = ['Sales', 'Onboarding', 'Mentoring', 'Finance', 'Klant', 'Marketing', 'Intern', 'Overige'];
const PRIORITEITEN = ['Urgent', 'Hoog', 'Normaal', 'Laag'];

// FEAT-4 (ronde 8, aangescherpt ronde 3): server-side filter via
// ?staff_only=1 op /api/profiles-list. Client-side isStaff blijft als
// vangnet voor backward-compat. Allowlist (moet gelijk zijn aan server-
// side STAFF_ROLES in api/profiles-list.js):
//   super_admin, manager, sales, mentor, administratie
// 'admin' bewust verwijderd (DFO gebruikt super_admin voor platform-beheer;
// admin-rol bestaat in DB-CHECK maar wordt niet toegewezen aan teamleden).
const STAFF_ROLES = new Set(['super_admin', 'manager', 'sales', 'mentor', 'administratie']);
function isStaff(member) {
  return STAFF_ROLES.has(String(member?.role || '').toLowerCase());
}

// Attachments (post-create pending → upload/link)
const ATTACH_BUCKET  = 'taken-attachments';
const ATTACH_MAX_MB  = 10;
function cleanFilename(name) {
  const dot = name.lastIndexOf('.');
  const base = (dot >= 0 ? name.slice(0, dot) : name).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bijlage';
  const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  return base.slice(0, 80) + ext.slice(0, 10);
}
function isValidHttpUrl(u) {
  if (!u || typeof u !== 'string') return false;
  try { const p = new URL(u.trim()); return p.protocol === 'http:' || p.protocol === 'https:'; }
  catch { return false; }
}
function detectEmbedDomain(url) {
  try { return new URL(String(url).trim()).hostname.replace(/^www\./, ''); }
  catch { return ''; }
}

let state = null;
let _membersCache = null;

async function loadMembers() {
  if (_membersCache) return _membersCache;
  try {
    // FEAT-4: server-side filter via ?staff_only=1. Client-side isStaff
    // blijft als vangnet (defense-in-depth).
    const j = await K().authedJson('/api/profiles-list?staff_only=1');
    const all = Array.isArray(j?.members) ? j.members : [];
    _membersCache = all.filter(isStaff);
  } catch (e) {
    console.warn('[taken-create] profiles-list fail:', e?.message);
    _membersCache = [];
  }
  return _membersCache;
}

function initState({ task, mode, onSuccess } = {}) {
  const isEdit = mode === 'edit' && !!task?.id;
  state = {
    mode: isEdit ? 'edit' : 'create',
    taskId: isEdit ? task.id : null,
    // Bewaar de originele task voor edit — status/aangemaakt/notities moeten
    // 1-op-1 mee in de EDIT-payload om te voorkomen dat server-toRow-defaults
    // ('todo' / now() / '') de bestaande waarden overschrijven.
    original: isEdit ? task : null,
    form: {
      titel:         task?.titel || '',
      omschrijving:  task?.omschrijving || '',
      prioriteit:    task?.prioriteit || 'Normaal',
      categorie:     task?.categorie || 'Overige',
      assignedToId:  task?.assigned_to_id || task?.assignedToId || '',
      deadline:      task?.deadline ? String(task.deadline).slice(0, 10) : '',
      customerId:    task?.customer_id || task?.customerId || null,
      emailId:       task?.email_id || task?.emailId || null,
      emailSubject:  task?.email_subject || task?.emailSubject || null,
    },
    members: [],
    membersLoading: true,
    errors: {},
    globalError: null,
    saving: false,
    onSuccess: onSuccess || null,
    // Pending CC/bijlagen (alleen relevant in create-mode; edit-mode toont
    // deze secties niet — beheer daarvan gebeurt in de detail-modal).
    pendingCC:    [],   // [{id, name, email}]
    pendingFiles: [],   // File[]
    pendingUrls:  [],   // [{url, domain}]
    urlDraft: '',
    ccSelect: '',       // huidige select-value (voor render-consistency)
    postSavePhase: null, // 'watchers' | 'uploads' | 'urls' | null (voor UX-hint)
  };
}

function renderHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">${state.mode === 'edit' ? 'Taak bewerken' : 'Nieuwe taak'}</div>
        <div class="kv-edit-head-name">${esc(state.form.titel || (state.mode === 'edit' ? 'Taak' : 'Aanmaken'))}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-tc-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderBody() {
  const f = state.form;
  const eTitel = state.errors.titel;
  const membersOpts = state.membersLoading
    ? '<option value="">Laden…</option>'
    : ['<option value="">— Niet toegewezen (zelf) —</option>']
        .concat(state.members.map((m) => `<option value="${esc(m.id)}" ${m.id === f.assignedToId ? 'selected' : ''}>${esc(m.full_name || m.email || m.id.slice(0, 8))}${m.role ? ' · ' + esc(m.role) : ''}</option>`))
        .join('');
  return `
    <form class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-edit-field ${eTitel ? 'kv-edit-field-error' : ''}">
        <label for="kv-tc-titel">Titel <span class="kv-edit-req">*</span></label>
        <input id="kv-tc-titel" class="ib-input" type="text" maxlength="500" placeholder="Korte omschrijving van de taak…" value="${esc(f.titel)}" data-kv-tc-input data-key="titel" />
        ${eTitel ? `<div class="kv-edit-field-msg">${esc(eTitel)}</div>` : ''}
      </div>

      <div class="kv-edit-field">
        <label for="kv-tc-desc">Omschrijving</label>
        <textarea id="kv-tc-desc" class="ib-input" rows="4" placeholder="Details, context, links…" data-kv-tc-input data-key="omschrijving">${esc(f.omschrijving)}</textarea>
      </div>

      <div class="kv-edit-grid">
        <div class="kv-edit-field">
          <label for="kv-tc-prio">Prioriteit</label>
          <select id="kv-tc-prio" class="ib-input" data-kv-tc-input data-key="prioriteit">
            ${PRIORITEITEN.map((p) => `<option value="${p}" ${f.prioriteit === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="kv-edit-field">
          <label for="kv-tc-cat">Categorie</label>
          <select id="kv-tc-cat" class="ib-input" data-kv-tc-input data-key="categorie">
            ${CATEGORIEEN.map((c) => `<option value="${c}" ${f.categorie === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="kv-edit-field">
          <label for="kv-tc-dl">Deadline</label>
          <input id="kv-tc-dl" class="ib-input" type="date" value="${esc(f.deadline)}" data-kv-tc-input data-key="deadline" />
        </div>
      </div>

      <div class="kv-edit-field">
        <label for="kv-tc-assign">Toegewezen aan</label>
        <select id="kv-tc-assign" class="ib-input" data-kv-tc-input data-key="assignedToId">
          ${membersOpts}
        </select>
        <div class="kv-edit-hint">Leeg = zelf toewijzen (jouw account).</div>
      </div>

      ${f.emailSubject ? `<div class="kv-edit-field">
        <label>Gekoppeld aan e-mail</label>
        <div style="font-size:12.5px; color: var(--text-2, #586374); padding: 6px 10px; background: var(--surface-2, #F2F4F7); border-radius: 6px;">${esc(f.emailSubject)}</div>
      </div>` : ''}

      ${state.mode === 'create' ? renderCCSection() + renderAttachSection() : `
        <div class="kv-edit-hint" style="margin-top:8px">
          CC en bijlagen beheer je in de detail-modal (open de taak na opslaan).
        </div>
      `}
    </form>`;
}

// ── CC-picker (create-mode alleen) ────────────────────────────────────────
function renderCCSection() {
  const cc = state.pendingCC;
  const opts = state.membersLoading
    ? '<option value="">Laden…</option>'
    : ['<option value="">— Kies persoon —</option>']
        .concat(
          state.members
            .filter((m) => !cc.some((c) => c.id === m.id) && m.id !== state.form.assignedToId)
            .map((m) => `<option value="${esc(m.id)}">${esc(m.full_name || m.email || m.id.slice(0, 8))}</option>`)
        )
        .join('');
  return `
    <div class="kv-td-section" style="margin-top:14px">
      <div class="kv-td-section-title">CC <span style="color:var(--text-3); font-weight:400;">· kijkt mee (${cc.length})</span></div>
      ${cc.length ? `<div class="kv-td-watchers">
        ${cc.map((c, i) => `
          <div class="kv-td-watcher-row">
            <span>${esc(c.name || c.email || '#' + String(c.id).slice(0, 6))}</span>
            <button type="button" class="ds-icon-btn kv-td-watcher-del" data-kv-tc-cc-del="${i}" title="Verwijderen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        `).join('')}
      </div>` : ''}
      <div class="kv-td-watcher-add">
        <select class="ib-input" data-kv-tc-cc-select>${opts}</select>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-tc-cc-add>Toevoegen</button>
      </div>
    </div>`;
}

// ── Bijlagen: files + URLs (create-mode alleen) ───────────────────────────
function renderAttachSection() {
  const files = state.pendingFiles;
  const urls  = state.pendingUrls;
  return `
    <div class="kv-td-section" style="margin-top:14px">
      <div class="kv-td-section-title">Bijlagen <span style="color:var(--text-3); font-weight:400;">(${files.length + urls.length})</span></div>

      ${files.length ? `<div class="tk-att-pending-list" style="margin-bottom:8px">
        ${files.map((f, i) => `
          <div class="tk-att-pending-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;flex-shrink:0"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="tk-att-pending-name" title="${esc(f.name)}">${esc(f.name)}</span>
            <span class="tk-att-pending-size">${(f.size / 1024 < 1024) ? (Math.round(f.size / 1024) + ' KB') : ((f.size / 1024 / 1024).toFixed(1) + ' MB')}</span>
            <button type="button" class="ds-icon-btn" data-kv-tc-file-del="${i}" title="Verwijder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        `).join('')}
      </div>` : ''}

      ${urls.length ? `<div class="tk-att-links" style="margin-bottom:8px">
        ${urls.map((u, i) => `
          <div class="tk-att-link-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;flex-shrink:0"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            <span class="tk-att-link-url" title="${esc(u.url)}">${esc(u.url)}</span>
            ${u.domain ? `<span class="tk-att-file-mime">${esc(u.domain)}</span>` : ''}
            <button type="button" class="ds-icon-btn" data-kv-tc-url-del="${i}" title="Verwijder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
        `).join('')}
      </div>` : ''}

      <label class="tk-att-picker" style="display:inline-block; margin-right:8px;">
        <input type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" data-kv-tc-file-input style="display:none">
        <span class="ds-btn ds-btn-ghost ds-btn-sm">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Bestand toevoegen
        </span>
      </label>
      <div class="tk-att-link-add">
        <input class="ib-input" type="url" placeholder="Plak YouTube / Vimeo / Loom / Drive-link…" value="${esc(state.urlDraft)}" data-kv-tc-url-input>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-tc-url-add>URL toevoegen</button>
      </div>
      <div class="tk-att-hint">
        Alleen afbeeldingen (PNG/JPG/GIF/WEBP) direct uploaden, max ${ATTACH_MAX_MB} MB.
        Video's / documenten via URL. Bijlagen + CC worden na aanmaken automatisch aan de taak gekoppeld.
      </div>
    </div>`;
}

function renderFoot() {
  let label;
  if (state.saving) {
    if      (state.postSavePhase === 'watchers') label = 'CC koppelen…';
    else if (state.postSavePhase === 'uploads')  label = 'Bijlagen uploaden…';
    else if (state.postSavePhase === 'urls')     label = 'Links koppelen…';
    else                                          label = 'Opslaan…';
  } else {
    label = state.mode === 'edit' ? 'Wijzigingen opslaan' : 'Taak aanmaken';
  }
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-tc-close ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-tc-submit ${state.saving ? 'disabled' : ''}>${esc(label)}</button>
    </div>`;
}

function clientValidate() {
  const errors = {};
  const t = String(state.form.titel || '').trim();
  if (!t) errors.titel = 'Titel is verplicht';
  else if (t.length > 500) errors.titel = 'Titel mag max 500 tekens zijn';
  return errors;
}

async function doSave() {
  state.errors = clientValidate();
  state.globalError = null;
  if (Object.keys(state.errors).length) { rerender(); return; }

  state.saving = true;
  rerender();

  const f = state.form;
  const task = {
    titel: String(f.titel).trim(),
    omschrijving: String(f.omschrijving || '').trim() || null,
    prioriteit: f.prioriteit || 'Normaal',
    categorie: f.categorie || 'Overige',
    assignedToId: f.assignedToId || null,
    customerId: f.customerId || null,
    deadline: f.deadline || null,
    emailId: f.emailId || null,
    emailSubject: f.emailSubject || null,
  };
  // Server /api/taken (POST { task }) verwacht ALTIJD task.id — er is geen
  // create-zonder-id-pad (zie api/taken.js:366 "task.id vereist"). Nieuwe
  // taken krijgen dus een client-side uuid v4. Bij edit hergebruikt hij de
  // bestaande id + we sturen status/aangemaakt/notities mee zodat
  // server-toRow-defaults die niet destructief overschrijven.
  if (state.mode === 'edit') {
    task.id = state.taskId;
    const orig = state.original || {};
    task.status       = orig.status || 'todo';
    task.aangemaakt   = orig.aangemaakt || null;
    task.notities     = orig.notities != null ? orig.notities : '';
    task.afgerondOp   = orig.afgerond_op || null;
  } else {
    task.id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      // Fallback voor oudere browsers: 8-4-4-4-12 met Math.random.
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
  }

  try {
    await K().authedJson('/api/taken', {
      method: 'POST',
      body: JSON.stringify({ task }),
    });

    // Post-create: pending CC + bijlagen koppelen aan de nieuwe taak.
    // Alleen in create-mode; edit gaat niet door deze tak (CC/bijlagen
    // beheer je in de detail-modal). Best-effort: één falend item mag
    // de rest niet blokkeren; failure-count in de eind-toast.
    let failCount = 0;
    if (state.mode === 'create') {
      const taskId = task.id;

      // 1) Watchers (CC)
      if (state.pendingCC.length) {
        state.postSavePhase = 'watchers';
        rerender();
        for (const cc of state.pendingCC) {
          try {
            await K().authedJson('/api/taken-watchers', {
              method: 'POST',
              body: JSON.stringify({ task_id: taskId, profile_id: cc.id }),
            });
          } catch (e) { failCount++; console.warn('[taken-create] watcher fail:', e?.message); }
        }
      }

      // 2) File uploads → Storage bucket 'taken-attachments' + attachment-row
      if (state.pendingFiles.length && window.supabase?.storage) {
        state.postSavePhase = 'uploads';
        rerender();
        let userId = null;
        try {
          const { data } = await window.supabase.auth.getUser();
          userId = data?.user?.id || null;
        } catch (_) { /* fail-soft */ }

        for (const file of state.pendingFiles) {
          try {
            if (!userId) throw new Error('Auth-fout bij upload');
            const path = `${userId}/${taskId}/${Date.now()}-${cleanFilename(file.name || 'bijlage')}`;
            const { error: upErr } = await window.supabase.storage
              .from(ATTACH_BUCKET)
              .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
            if (upErr) throw new Error('Storage: ' + upErr.message);
            await K().authedJson('/api/taken-attachments', {
              method: 'POST',
              body: JSON.stringify({
                task_id: taskId,
                storage_path: path,
                filename: file.name || null,
                mime_type: file.type || null,
              }),
            });
          } catch (e) { failCount++; console.warn('[taken-create] upload fail:', e?.message); }
        }
      }

      // 3) URL-attachments (external_url)
      if (state.pendingUrls.length) {
        state.postSavePhase = 'urls';
        rerender();
        for (const u of state.pendingUrls) {
          try {
            await K().authedJson('/api/taken-attachments', {
              method: 'POST',
              body: JSON.stringify({ task_id: taskId, external_url: u.url }),
            });
          } catch (e) { failCount++; console.warn('[taken-create] url fail:', e?.message); }
        }
      }

      state.postSavePhase = null;
    }

    const baseToast = state.mode === 'edit' ? 'Taak bijgewerkt' : 'Taak aangemaakt';
    K().toast(failCount ? `${baseToast} (${failCount} bijlage/CC-koppeling mislukt)` : baseToast);
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    state.globalError = e?.message || 'Opslaan mislukt';
    state.saving = false;
    state.postSavePhase = null;
    rerender();
  }
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-tc-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-tc-submit]')?.addEventListener('click', doSave);
  box.querySelectorAll('[data-kv-tc-input]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const k = e.target.getAttribute('data-key');
      if (!k) return;
      state.form[k] = e.target.value;
      if (state.errors[k]) { delete state.errors[k]; rerender(); }
    });
    el.addEventListener('change', (e) => {
      const k = e.target.getAttribute('data-key');
      if (!k) return;
      state.form[k] = e.target.value;
    });
  });

  // CC-picker
  box.querySelector('[data-kv-tc-cc-add]')?.addEventListener('click', () => {
    const sel = box.querySelector('[data-kv-tc-cc-select]');
    const pid = sel && sel.value;
    if (!pid) return;
    const m = (state.members || []).find((x) => x.id === pid);
    if (!m) return;
    if (state.pendingCC.some((c) => c.id === pid)) return;
    state.pendingCC.push({ id: m.id, name: m.full_name || m.email || m.id, email: m.email || null });
    rerender();
  });
  box.querySelectorAll('[data-kv-tc-cc-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-kv-tc-cc-del'));
      if (Number.isInteger(i)) { state.pendingCC.splice(i, 1); rerender(); }
    });
  });

  // Files
  box.querySelector('[data-kv-tc-file-input]')?.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      if (f.size > ATTACH_MAX_MB * 1024 * 1024) {
        alert(`Bestand "${f.name}" te groot (max ${ATTACH_MAX_MB} MB) — overgeslagen.`);
        continue;
      }
      state.pendingFiles.push(f);
    }
    rerender();
  });
  box.querySelectorAll('[data-kv-tc-file-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-kv-tc-file-del'));
      if (Number.isInteger(i)) { state.pendingFiles.splice(i, 1); rerender(); }
    });
  });

  // URLs
  box.querySelector('[data-kv-tc-url-input]')?.addEventListener('input', (e) => { state.urlDraft = e.target.value; });
  box.querySelector('[data-kv-tc-url-add]')?.addEventListener('click', () => {
    const raw = String(state.urlDraft || '').trim();
    if (!raw) return;
    if (!isValidHttpUrl(raw)) { alert('Ongeldige URL (http:// of https:// vereist).'); return; }
    state.pendingUrls.push({ url: raw, domain: detectEmbedDomain(raw) });
    state.urlDraft = '';
    rerender();
  });
  box.querySelectorAll('[data-kv-tc-url-del]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.getAttribute('data-kv-tc-url-del'));
      if (Number.isInteger(i)) { state.pendingUrls.splice(i, 1); rerender(); }
    });
  });
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

export async function openTakenCreateModal({ task, mode, onSuccess } = {}) {
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar'); return; }
  initState({ task, mode, onSuccess });
  rerender();
  const members = await loadMembers();
  if (!state) return;
  state.members = members;
  state.membersLoading = false;
  rerender();
}
