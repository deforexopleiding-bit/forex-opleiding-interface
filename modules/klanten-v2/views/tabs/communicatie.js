// modules/klanten-v2/views/tabs/communicatie.js
//
// Communicatie-tab van klanten-v2 (PR-B3). 19 items uit de INVENTARIS:
// notities-CRUD (16) + WhatsApp/Email placeholders (3).
//
// Notities zijn WEL werkend (create/edit/archive/unarchive) via de
// bestaande endpoints /api/customer-notes + /api/customer-note-archive.
// WhatsApp- en Email-thread-integratie zijn placeholders die naar de
// bestaande /modules/email.html en /modules/finance.html verwijzen
// tot die modules hun v2-renders krijgen.

const K = () => window.KV;

// ── Module-state (per tab-mount vers geïnitialiseerd) ───────────────────────
let state = null;

function initState(customer) {
  state = {
    customerId:      customer?.id || null,
    customerName:    customerFullName(customer),
    notes:           [],
    includeArchived: false,
    loading:         true,
    error:           null,
    composing:       false,
    composeText:     '',
    composeError:    null,
    editingId:       null,
    editingText:     '',
    editingError:    null,
    saving:          false,
  };
}

function customerFullName(c) {
  if (!c) return '';
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '';
}

// ── Formatters ──────────────────────────────────────────────────────────────

function fmtRel(iso) {
  if (!iso) return '';
  try {
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then)) return '';
    const diff = Date.now() - then;
    if (diff < 60_000) return 'zojuist';
    if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m geleden`;
    if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}u geleden`;
    if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d geleden`;
    return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch (_) { return ''; }
}
function fmtAbs(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (_) { return ''; }
}

// ── API-callers ─────────────────────────────────────────────────────────────

async function apiListNotes() {
  const url = `/api/customer-notes?customer_id=${encodeURIComponent(state.customerId)}${state.includeArchived ? '&include_archived=true' : ''}`;
  const j = await K().authedJson(url);
  return Array.isArray(j?.notes) ? j.notes : [];
}

async function apiCreateNote(body) {
  const j = await K().authedJson('/api/customer-notes', {
    method: 'POST',
    body: JSON.stringify({ customer_id: state.customerId, body }),
  });
  return j?.note || null;
}

async function apiPatchNote(id, body) {
  const j = await K().authedJson(`/api/customer-notes?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  return j?.note || null;
}

async function apiArchiveNote(id, action) {
  // action: 'archive' | 'unarchive'
  const j = await K().authedJson(`/api/customer-note-archive?id=${encodeURIComponent(id)}&action=${action}`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return j?.note || null;
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function actLoad(rootEl) {
  state.loading = true;
  state.error = null;
  render(rootEl);
  try {
    state.notes = await apiListNotes();
  } catch (e) {
    state.error = e?.message || 'Kan notities niet laden';
    state.notes = [];
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

async function actCreateSubmit(rootEl) {
  const text = String(state.composeText || '').trim();
  if (!text) {
    state.composeError = 'Notitie mag niet leeg zijn';
    render(rootEl);
    return;
  }
  state.saving = true; state.composeError = null;
  render(rootEl);
  try {
    const note = await apiCreateNote(text);
    if (note) state.notes = [note, ...state.notes];
    state.composing = false;
    state.composeText = '';
    K().toast('Notitie toegevoegd');
  } catch (e) {
    state.composeError = e?.message || 'Aanmaken mislukt';
  } finally {
    state.saving = false;
    render(rootEl);
  }
}

async function actEditSubmit(rootEl) {
  const id = state.editingId;
  const text = String(state.editingText || '').trim();
  if (!id) return;
  if (!text) {
    state.editingError = 'Notitie mag niet leeg zijn';
    render(rootEl);
    return;
  }
  state.saving = true; state.editingError = null;
  render(rootEl);
  try {
    const updated = await apiPatchNote(id, text);
    if (updated) {
      state.notes = state.notes.map(n => n.id === id ? { ...n, ...updated } : n);
    }
    state.editingId = null;
    state.editingText = '';
    K().toast('Notitie bijgewerkt');
  } catch (e) {
    state.editingError = e?.message || 'Bijwerken mislukt';
  } finally {
    state.saving = false;
    render(rootEl);
  }
}

async function actArchiveToggle(rootEl, note) {
  const isArchived = !!note.archived_at;
  const action = isArchived ? 'unarchive' : 'archive';
  const label  = isArchived ? 'heractiveren' : 'archiveren';
  if (!isArchived) {
    // Confirm alleen bij archiveren (destructive-ish). MVP: browser confirm;
    // de nette modal komt in PR-C (customer-modals cluster).
    if (!window.confirm(`Weet je zeker dat je deze notitie wilt ${label}?`)) return;
  }
  try {
    const updated = await apiArchiveNote(note.id, action);
    if (updated) {
      state.notes = state.notes.map(n => n.id === note.id ? { ...n, ...updated } : n);
      // Als include_archived UIT staat en we archiveren: verwijder uit lijst
      if (!state.includeArchived && action === 'archive') {
        state.notes = state.notes.filter(n => n.id !== note.id);
      }
    }
    K().toast(action === 'archive' ? 'Notitie gearchiveerd' : 'Notitie heractiveerd');
  } catch (e) {
    K().toast(`Kon niet ${label}: ${e?.message || 'onbekende fout'}`);
  } finally {
    render(rootEl);
  }
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderComposer() {
  if (!state.composing) {
    return `
      <div class="kv-comm-compose-cta">
        <button type="button" class="ds-btn ds-btn-primary" data-kv-comm-open-compose>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          Nieuwe notitie
        </button>
      </div>`;
  }
  return `
    <div class="kv-comm-composer">
      <div class="kv-comm-composer-label">Nieuwe notitie</div>
      <textarea class="kv-comm-textarea" data-kv-comm-compose-input placeholder="Schrijf een notitie…" rows="4">${K().esc(state.composeText || '')}</textarea>
      ${state.composeError ? `<div class="kv-comm-error">${K().esc(state.composeError)}</div>` : ''}
      <div class="kv-comm-composer-actions">
        <button type="button" class="ds-btn ds-btn-ghost" data-kv-comm-compose-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
        <button type="button" class="ds-btn ds-btn-primary" data-kv-comm-compose-submit ${state.saving ? 'disabled' : ''}>
          ${state.saving ? 'Opslaan…' : 'Opslaan'}
        </button>
      </div>
    </div>`;
}

function renderNoteRow(note) {
  const isEditing  = state.editingId === note.id;
  const isArchived = !!note.archived_at;
  const author     = note.author_name || note.created_by_user_id?.slice(0, 8) || 'Onbekend';
  const created    = fmtRel(note.created_at);
  const createdAbs = fmtAbs(note.created_at);
  const edited     = note.edited_at ? fmtAbs(note.edited_at) : null;

  if (isEditing) {
    return `
      <li class="kv-comm-note ${isArchived ? 'is-archived' : ''}">
        <div class="kv-comm-note-editing">
          <textarea class="kv-comm-textarea" data-kv-comm-edit-input rows="4">${K().esc(state.editingText || '')}</textarea>
          ${state.editingError ? `<div class="kv-comm-error">${K().esc(state.editingError)}</div>` : ''}
          <div class="kv-comm-composer-actions">
            <button type="button" class="ds-btn ds-btn-ghost" data-kv-comm-edit-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
            <button type="button" class="ds-btn ds-btn-primary" data-kv-comm-edit-submit ${state.saving ? 'disabled' : ''}>
              ${state.saving ? 'Opslaan…' : 'Opslaan'}
            </button>
          </div>
        </div>
      </li>`;
  }

  return `
    <li class="kv-comm-note ${isArchived ? 'is-archived' : ''}">
      <div class="kv-comm-note-body">${K().esc(note.body || '')}</div>
      <div class="kv-comm-note-meta">
        <span class="kv-comm-note-author">${K().esc(author)}</span>
        <span class="kv-comm-note-sep">·</span>
        <span class="kv-comm-note-time" title="${K().esc(createdAbs)}">${K().esc(created)}</span>
        ${edited ? `<span class="kv-comm-note-edited" title="${K().esc(edited)}">· bewerkt</span>` : ''}
        ${isArchived ? `<span class="ds-pill ds-pill-neutral nodot kv-comm-note-badge">Gearchiveerd</span>` : ''}
        <span class="kv-comm-note-actions">
          ${!isArchived ? `<button type="button" class="ds-icon-btn kv-comm-note-btn" data-kv-comm-edit="${K().esc(note.id)}" title="Bewerken">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
          </button>` : ''}
          <button type="button" class="ds-icon-btn kv-comm-note-btn" data-kv-comm-archive="${K().esc(note.id)}" title="${isArchived ? 'Heractiveren' : 'Archiveren'}">
            ${isArchived
              ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>'
              : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/></svg>'
            }
          </button>
        </span>
      </div>
    </li>`;
}

function renderNotesSection() {
  const activeCount   = state.notes.filter(n => !n.archived_at).length;
  const archivedCount = state.notes.filter(n =>  n.archived_at).length;

  let listInner;
  if (state.loading) {
    listInner = `<div class="kv-comm-loading">Notities laden…</div>`;
  } else if (state.error) {
    listInner = `
      <div class="ds-error">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <div>
          <strong>Kan notities niet laden.</strong>
          <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(state.error)}</div>
          <div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-comm-retry>Opnieuw proberen</button></div>
        </div>
      </div>`;
  } else if (!state.notes.length) {
    listInner = `
      <div class="ds-empty" style="padding:36px 20px;">
        <div class="ds-empty-t">Geen notities</div>
        <div class="ds-empty-s">
          ${state.includeArchived
            ? 'Deze klant heeft nog geen notities. Maak er één aan via de knop hierboven.'
            : 'Geen actieve notities. Zet "Toon gearchiveerde" aan om alles te zien of maak een nieuwe.'}
        </div>
      </div>`;
  } else {
    listInner = `<ul class="kv-comm-note-list">${state.notes.map(renderNoteRow).join('')}</ul>`;
  }

  return `
    <div class="kv-prof-card kv-comm-card">
      <div class="kv-comm-header">
        <div class="kv-comm-header-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5h10M11 12h10M11 19h10"/><rect x="3" y="4" width="4" height="4" rx="1"/><rect x="3" y="11" width="4" height="4" rx="1"/><rect x="3" y="18" width="4" height="4" rx="1"/></svg>
          Notities
          <span class="kv-prof-count">${activeCount}${archivedCount ? ` <span style="opacity:.6">(+${archivedCount} gearchiveerd)</span>` : ''}</span>
        </div>
        <label class="kv-comm-toggle">
          <input type="checkbox" data-kv-comm-toggle-archived ${state.includeArchived ? 'checked' : ''} />
          <span>Toon gearchiveerde</span>
        </label>
      </div>

      ${renderComposer()}
      ${listInner}
    </div>`;
}

function renderWhatsAppCard() {
  return `
    <div class="kv-prof-card kv-comm-placeholder">
      <div class="kv-comm-placeholder-head">
        <div class="kv-comm-placeholder-ico" style="background:#25D36620; color:#25D366;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        </div>
        <div class="kv-comm-placeholder-title">
          <div class="kv-comm-placeholder-h">WhatsApp-thread</div>
          <div class="kv-comm-placeholder-sub">Inbound + outbound berichten voor deze klant.</div>
        </div>
      </div>
      <div class="kv-comm-placeholder-body">
        Volledige WA-integratie in de dossier-view komt zodra de <strong>Finance-inbox v2</strong> live is
        (aparte redesign-PR). Voor nu open je de gesprekken via:
      </div>
      <a class="ds-btn ds-btn-ghost ds-btn-sm" href="/modules/finance.html#view-inbox" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open in Finance › Inbox
      </a>
    </div>`;
}

function renderEmailCard() {
  return `
    <div class="kv-prof-card kv-comm-placeholder">
      <div class="kv-comm-placeholder-head">
        <div class="kv-comm-placeholder-ico" style="background:var(--teal-soft); color:var(--teal);">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="m4 4 8 8 8-8"/></svg>
        </div>
        <div class="kv-comm-placeholder-title">
          <div class="kv-comm-placeholder-h">E-mail-thread</div>
          <div class="kv-comm-placeholder-sub">Inbox-berichten (leads/info/partners/administratie).</div>
        </div>
      </div>
      <div class="kv-comm-placeholder-body">
        E-mail-thread per klant komt in de <strong>E-mail-module v2</strong> (aparte redesign-PR). Voor nu
        open je berichten via de bestaande e-mailmodule:
      </div>
      <a class="ds-btn ds-btn-ghost ds-btn-sm" href="/modules/email.html" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        Open in E-mail-module
      </a>
    </div>`;
}

// ── Render + wire ───────────────────────────────────────────────────────────

function render(rootEl) {
  // Ronde-11: WhatsApp-thread + E-mail-thread placeholder-blokken
  // verwijderd — verwezen naar v1/redesign-PR, hoort niet in klant-facing
  // weergave. renderNotesSection nu volledig-breedte.
  rootEl.innerHTML = `
    <div class="kv-comm-grid kv-comm-grid-nosides">
      ${renderNotesSection()}
    </div>`;
  wire(rootEl);
  // Textarea auto-focus + cursor-behoud
  if (state.composing) {
    const ta = rootEl.querySelector('[data-kv-comm-compose-input]');
    if (ta && document.activeElement !== ta) {
      ta.focus();
      const v = ta.value; ta.value = ''; ta.value = v;
    }
  }
  if (state.editingId) {
    const ta = rootEl.querySelector('[data-kv-comm-edit-input]');
    if (ta && document.activeElement !== ta) {
      ta.focus();
      const v = ta.value; ta.value = ''; ta.value = v;
    }
  }
}

function wire(rootEl) {
  // Toggle "Toon gearchiveerde"
  rootEl.querySelector('[data-kv-comm-toggle-archived]')?.addEventListener('change', (e) => {
    state.includeArchived = !!e.target.checked;
    actLoad(rootEl);
  });
  // Retry na fetch-error
  rootEl.querySelector('[data-kv-comm-retry]')?.addEventListener('click', () => actLoad(rootEl));

  // Composer open/cancel/submit
  rootEl.querySelector('[data-kv-comm-open-compose]')?.addEventListener('click', () => {
    state.composing = true; state.composeText = ''; state.composeError = null;
    render(rootEl);
  });
  rootEl.querySelector('[data-kv-comm-compose-cancel]')?.addEventListener('click', () => {
    state.composing = false; state.composeText = ''; state.composeError = null;
    render(rootEl);
  });
  rootEl.querySelector('[data-kv-comm-compose-input]')?.addEventListener('input', (e) => {
    state.composeText = e.target.value;
  });
  rootEl.querySelector('[data-kv-comm-compose-submit]')?.addEventListener('click', () => actCreateSubmit(rootEl));

  // Per-note actions (edit start/cancel/submit + archive/unarchive)
  rootEl.querySelectorAll('[data-kv-comm-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-comm-edit');
      const note = state.notes.find(n => n.id === id);
      if (!note) return;
      state.editingId = id;
      state.editingText = note.body || '';
      state.editingError = null;
      render(rootEl);
    });
  });
  rootEl.querySelector('[data-kv-comm-edit-cancel]')?.addEventListener('click', () => {
    state.editingId = null; state.editingText = ''; state.editingError = null;
    render(rootEl);
  });
  rootEl.querySelector('[data-kv-comm-edit-input]')?.addEventListener('input', (e) => {
    state.editingText = e.target.value;
  });
  rootEl.querySelector('[data-kv-comm-edit-submit]')?.addEventListener('click', () => actEditSubmit(rootEl));

  rootEl.querySelectorAll('[data-kv-comm-archive]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-comm-archive');
      const note = state.notes.find(n => n.id === id);
      if (!note) return;
      actArchiveToggle(rootEl, note);
    });
  });
}

// ── Public entry ────────────────────────────────────────────────────────────

export async function renderCommunicatieTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `
      <div class="ds-empty" style="padding:40px 20px;">
        <div class="ds-empty-t">Geen klant-data</div>
        <div class="ds-empty-s">Kan communicatie-tab niet renderen zonder klant.</div>
      </div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
