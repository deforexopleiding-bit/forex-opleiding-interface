// modules/klanten-v2/views/modals/bulk-tag.js
//
// Bulk-tag-modal (PR-C6, zesde in de klant-modal-serie, deel 1 van 2).
// Voegt één tag toe (of verwijdert 'em) aan N geselecteerde klanten
// vanuit de list-view bulk-bar. POST /api/customer-bulk met action
// 'tag-add' of 'tag-remove'.
//
// Endpoint (bestaand): POST /api/customer-bulk
// Auth: verifyAdmin. Idempotent: no-op (al gekoppeld / al niet gekoppeld)
// telt als success. Max 100 klanten per call (server-cap).
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }

let state = null;

function initState(customerIds) {
  state = {
    customerIds:  Array.isArray(customerIds) ? customerIds.slice(0, 100) : [],
    definitions:  [],
    loadingDefs:  true,
    error:        null,
    selectedSlug: '',
    mode:         'add',   // 'add' | 'remove'
    saving:       false,
    result:       null,    // {success_count, fail_count, failed: [{id, reason}]}
    onSuccess:    null,
  };
}

async function loadDefinitions() {
  try {
    const j = await K().authedJson('/api/customer-tag-definitions');
    state.definitions = Array.isArray(j?.tags) ? j.tags
                      : Array.isArray(j?.data) ? j.data
                      : (Array.isArray(j) ? j : []);
  } catch (e) {
    state.error = e?.message || 'Kan tag-catalogus niet laden';
  } finally {
    state.loadingDefs = false;
  }
}

async function doSubmit() {
  if (!state.selectedSlug) return;
  state.saving = true; state.error = null; state.result = null;
  rerender();
  try {
    const j = await K().authedJson('/api/customer-bulk', {
      method: 'POST',
      body: JSON.stringify({
        action:       state.mode === 'add' ? 'tag-add' : 'tag-remove',
        customer_ids: state.customerIds,
        tag_slug:     state.selectedSlug,
      }),
    });
    state.result = {
      total:         j?.total || 0,
      success_count: j?.success_count || 0,
      fail_count:    j?.fail_count || 0,
      failed:        Array.isArray(j?.failed) ? j.failed : [],
    };
    K().toast(`${state.mode === 'add' ? 'Toegevoegd' : 'Verwijderd'}: ${state.result.success_count}/${state.result.total}`);
    if (typeof state.onSuccess === 'function') state.onSuccess(state.result);
    // Als er 0 fails zijn: sluit modal na 1s zodat user de toast + result ziet
    if (state.result.fail_count === 0) {
      setTimeout(() => D().closeModal(), 1200);
    }
  } catch (e) {
    state.error = e?.message || 'Bulk-actie mislukt';
  } finally {
    state.saving = false;
    rerender();
  }
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Bulk tag-actie</div>
        <div class="kv-edit-head-name">${state.customerIds.length} klant${state.customerIds.length === 1 ? '' : 'en'}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-btag-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderResult() {
  if (!state.result) return '';
  const r = state.result;
  const cls = r.fail_count === 0 ? 'is-ok' : 'is-partial';
  return `
    <div class="kv-bulk-result ${cls}">
      <div class="kv-bulk-result-h">
        ${r.fail_count === 0 ? '✅' : '⚠'}
        ${r.success_count} van ${r.total} verwerkt${r.fail_count ? ` — ${r.fail_count} mislukt` : ''}
      </div>
      ${r.failed.length ? `
        <details class="kv-bulk-fail-details">
          <summary>Toon fout-details (${r.failed.length})</summary>
          <ul>
            ${r.failed.slice(0, 20).map(f => `<li><code>${esc(String(f.id).slice(0, 8))}</code>: ${esc(f.reason || 'onbekend')}</li>`).join('')}
            ${r.failed.length > 20 ? `<li>… en ${r.failed.length - 20} meer</li>` : ''}
          </ul>
        </details>
      ` : ''}
    </div>`;
}

function renderBody() {
  return `
    <div class="kv-bulk-body">
      ${state.error ? `<div class="kv-edit-banner">${esc(state.error)}</div>` : ''}
      ${renderResult()}

      <div class="kv-bulk-mode-row">
        <label class="kv-bulk-mode-opt">
          <input type="radio" name="kv-btag-mode" value="add" ${state.mode === 'add' ? 'checked' : ''} data-kv-btag-mode />
          <span>Tag <strong>toevoegen</strong></span>
        </label>
        <label class="kv-bulk-mode-opt">
          <input type="radio" name="kv-btag-mode" value="remove" ${state.mode === 'remove' ? 'checked' : ''} data-kv-btag-mode />
          <span>Tag <strong>verwijderen</strong></span>
        </label>
      </div>

      <div class="kv-edit-field">
        <label for="kv-btag-slug">Kies een tag</label>
        <select id="kv-btag-slug" data-kv-btag-slug>
          <option value="">— Selecteer —</option>
          ${state.definitions.map(t => `<option value="${esc(t.slug)}" ${state.selectedSlug === t.slug ? 'selected' : ''}>${esc(t.label || t.slug)}</option>`).join('')}
        </select>
      </div>

      <div class="kv-bulk-hint">
        Deze actie wordt uitgevoerd op <strong>${state.customerIds.length}</strong> geselecteerde klant${state.customerIds.length === 1 ? '' : 'en'}.
        Gearchiveerde/geanonimiseerde klanten worden overgeslagen. No-op cases
        (al gekoppeld / al niet gekoppeld) tellen als success zonder audit-entry.
      </div>
    </div>`;
}

function renderFoot() {
  const canGo = !!state.selectedSlug && !state.saving && !state.result;
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-btag-close ${state.saving ? 'disabled' : ''}>${state.result ? 'Sluiten' : 'Annuleren'}</button>
      ${!state.result ? `<button type="button" class="ds-btn ds-btn-primary" data-kv-btag-submit ${canGo ? '' : 'disabled'}>
        ${state.saving ? 'Bezig…' : (state.mode === 'add' ? 'Tag toevoegen aan selectie' : 'Tag verwijderen uit selectie')}
      </button>` : ''}
    </div>`;
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-btag-close]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelectorAll('[data-kv-btag-mode]').forEach((r) => {
    r.addEventListener('change', (e) => { state.mode = e.target.value; rerender(); });
  });
  const sel = box.querySelector('[data-kv-btag-slug]');
  if (sel) sel.addEventListener('change', (e) => { state.selectedSlug = e.target.value; rerender(); });
  box.querySelector('[data-kv-btag-submit]')?.addEventListener('click', doSubmit);
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

/**
 * openBulkTagModal({ customerIds, onSuccess })
 *   customerIds — array van uuid's; capped at 100 (server-cap).
 *   onSuccess   — callback(result) na een succesvolle POST (ook bij
 *                 207 Multi-Status). Caller herlaadt de list-view.
 */
export function openBulkTagModal({ customerIds, onSuccess } = {}) {
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    K().toast('Geen klanten geselecteerd');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(customerIds);
  state.onSuccess = onSuccess || null;
  rerender();
  loadDefinitions().then(() => rerender());
}
