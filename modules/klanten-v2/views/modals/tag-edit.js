// modules/klanten-v2/views/modals/tag-edit.js
//
// Tag-edit-modal (PR-C5, vijfde in de klant-modal-serie). Beheert tag-
// koppelingen aan één klant: toevoegen + verwijderen. Rendert via de
// gedeelde DFO shell-modal.
//
// Endpoints (bestaand):
//   GET  /api/customer-tag-definitions  — catalogus (~50 tags max)
//   POST /api/customer-tag  body: {customer_id, tag_slug} — koppel
//   DELETE /api/customer-tag body: {customer_id, tag_slug} — ontkoppel
// Auth: verifyAdmin. Status-gate: archived/anonymized → 403 (server).
// Audit: customer.tag.added / customer.tag.removed via logCustomerAudit.
//
// Optimistic UI: we passen state.assigned direct aan zonder te wachten
// op server (snelle feedback bij klik). Bij server-fout draaien we het
// terug + tonen error-banner.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }

let state = null;

function initState(customer) {
  const initialTags = Array.isArray(customer?.tags) ? customer.tags : [];
  state = {
    customerId:    customer?.id || null,
    customerName:  customerFullName(customer),
    assigned:      new Set(initialTags.map(t => t.slug)), // huidige koppelingen
    definitions:   [],   // uit /api/customer-tag-definitions
    loading:       true,
    error:         null,
    pending:       new Set(), // slugs die momenteel muteren (voor row-disabled)
    onSuccess:     null,
    // We hebben ook een label/color map nodig zodat chips buiten de
    // catalogus fetch (leeg-state) blijven werken.
    knownTags:     Object.fromEntries(initialTags.map(t => [t.slug, t])),
  };
}

function customerFullName(c) {
  if (!c) return '';
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '';
}

// ── API ────────────────────────────────────────────────────────────────────

async function loadDefinitions() {
  state.loading = true; state.error = null;
  try {
    const j = await K().authedJson('/api/customer-tag-definitions');
    state.definitions = Array.isArray(j?.tags) ? j.tags
                      : Array.isArray(j?.data) ? j.data
                      : (Array.isArray(j) ? j : []);
    // Vul knownTags aan zodat verwijderen-chip ook label/color heeft
    for (const t of state.definitions) {
      if (!state.knownTags[t.slug]) state.knownTags[t.slug] = t;
    }
  } catch (e) {
    state.error = e?.message || 'Kan tag-catalogus niet laden';
    state.definitions = [];
  } finally {
    state.loading = false;
  }
}

async function addTag(slug) {
  state.pending.add(slug);
  state.assigned.add(slug); // optimistic
  rerender();
  try {
    const j = await K().authedJson('/api/customer-tag', {
      method: 'POST',
      body: JSON.stringify({ customer_id: state.customerId, tag_slug: slug }),
    });
    // Server retourneert volledige set — sync ons cache
    if (Array.isArray(j?.tags)) {
      state.assigned = new Set(j.tags.map(t => t.slug));
      for (const t of j.tags) state.knownTags[t.slug] = t;
    }
    K().toast('Tag toegevoegd');
    if (typeof state.onSuccess === 'function') state.onSuccess(j?.tags || null);
  } catch (e) {
    state.assigned.delete(slug); // rollback
    state.error = e?.message || 'Tag toevoegen mislukt';
  } finally {
    state.pending.delete(slug);
    rerender();
  }
}
async function removeTag(slug) {
  state.pending.add(slug);
  state.assigned.delete(slug); // optimistic
  rerender();
  try {
    const j = await K().authedJson('/api/customer-tag', {
      method: 'DELETE',
      body: JSON.stringify({ customer_id: state.customerId, tag_slug: slug }),
    });
    if (Array.isArray(j?.tags)) {
      state.assigned = new Set(j.tags.map(t => t.slug));
    }
    K().toast('Tag verwijderd');
    if (typeof state.onSuccess === 'function') state.onSuccess(j?.tags || null);
  } catch (e) {
    state.assigned.add(slug); // rollback
    state.error = e?.message || 'Tag verwijderen mislukt';
  } finally {
    state.pending.delete(slug);
    rerender();
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Tags beheren</div>
        <div class="kv-edit-head-name">${esc(state.customerName)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-tag-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderChip(t, {removable = false, addable = false}) {
  const slug  = t.slug;
  const label = t.label || slug;
  const color = t.color || 'var(--text-3)';
  const isPending = state.pending.has(slug);
  const style = `background: ${esc(color)}22; border-color: ${esc(color)}; color: ${esc(color)};`;
  const action = removable
    ? `<button type="button" class="kv-tag-chip-x" data-kv-tag-remove="${esc(slug)}" ${isPending ? 'disabled' : ''} aria-label="Verwijderen">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
       </button>`
    : (addable
      ? `<button type="button" class="kv-tag-chip-add" data-kv-tag-add="${esc(slug)}" ${isPending ? 'disabled' : ''} aria-label="Toevoegen">+</button>`
      : '');
  return `
    <span class="kv-tag-chip ${isPending ? 'is-pending' : ''}" style="${style}">
      <span>${esc(label)}</span>
      ${action}
    </span>`;
}

function renderBody() {
  const assigned = [...state.assigned].map(slug => state.knownTags[slug] || { slug, label: slug, color: 'var(--text-3)' });
  const available = state.definitions.filter(t => !state.assigned.has(t.slug));

  const assignedBlock = assigned.length
    ? `<div class="kv-tag-chip-row">${assigned.map(t => renderChip(t, { removable: true })).join('')}</div>`
    : `<div class="kv-prof-empty">Geen tags gekoppeld.</div>`;

  let availableBlock;
  if (state.loading) {
    availableBlock = `<div class="kv-tag-loading">Catalogus laden…</div>`;
  } else if (state.definitions.length === 0) {
    availableBlock = `<div class="kv-prof-empty">Geen tag-definities gevonden.</div>`;
  } else if (available.length === 0) {
    availableBlock = `<div class="kv-prof-empty">Alle beschikbare tags zijn al gekoppeld.</div>`;
  } else {
    availableBlock = `<div class="kv-tag-chip-row">${available.map(t => renderChip(t, { addable: true })).join('')}</div>`;
  }

  return `
    <div class="kv-tag-body">
      ${state.error ? `<div class="kv-edit-banner">${esc(state.error)}</div>` : ''}

      <div class="kv-edit-section-h">Gekoppeld</div>
      ${assignedBlock}

      <div class="kv-edit-section-h">Beschikbaar</div>
      ${availableBlock}
    </div>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-primary" data-kv-tag-close>Klaar</button>
    </div>`;
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-tag-close]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelectorAll('[data-kv-tag-add]').forEach((btn) => {
    btn.addEventListener('click', () => addTag(btn.getAttribute('data-kv-tag-add')));
  });
  box.querySelectorAll('[data-kv-tag-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeTag(btn.getAttribute('data-kv-tag-remove')));
  });
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openTagEditModal({ customer, onSuccess })
 *   customer  — klant-object met `id` en `tags[]`.
 *   onSuccess — callback(newTagsArray|null) na iedere mutatie (add/remove).
 *               Caller kan hiermee de sidebar-tags-chips herrenderen
 *               zonder full page-refresh.
 */
export function openTagEditModal({ customer, onSuccess } = {}) {
  if (!customer?.id) {
    K().toast('Geen klant om te taggen');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(customer);
  state.onSuccess = onSuccess || null;
  rerender();
  loadDefinitions().then(() => rerender());
}
