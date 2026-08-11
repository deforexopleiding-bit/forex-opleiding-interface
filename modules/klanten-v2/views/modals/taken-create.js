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
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;
function esc(v) { return K().esc(v); }

const CATEGORIEEN = ['Sales', 'Onboarding', 'Mentoring', 'Finance', 'Klant', 'Marketing', 'Intern', 'Overige'];
const PRIORITEITEN = ['Urgent', 'Hoog', 'Normaal', 'Laag'];

let state = null;
let _membersCache = null;

async function loadMembers() {
  if (_membersCache) return _membersCache;
  try {
    const j = await K().authedJson('/api/profiles-list');
    _membersCache = Array.isArray(j?.members) ? j.members : [];
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
    </form>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-tc-close ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-tc-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Opslaan…' : (state.mode === 'edit' ? 'Wijzigingen opslaan' : 'Taak aanmaken')}
      </button>
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
  if (state.mode === 'edit') task.id = state.taskId;

  try {
    await K().authedJson('/api/taken', {
      method: 'POST',
      body: JSON.stringify({ task }),
    });
    K().toast(state.mode === 'edit' ? 'Taak bijgewerkt' : 'Taak aangemaakt');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    state.globalError = e?.message || 'Opslaan mislukt';
    state.saving = false;
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
