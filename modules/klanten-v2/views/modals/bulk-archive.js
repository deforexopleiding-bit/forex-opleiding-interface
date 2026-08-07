// modules/klanten-v2/views/modals/bulk-archive.js
//
// Bulk-archive-modal (PR-C6, deel 2 van 2). Archiveert (of heractiveert)
// N geselecteerde klanten vanuit de list-view bulk-bar. POST /api/customer-
// bulk met action 'archive' of 'unarchive' + optionele reason.
//
// Endpoint (bestaand): POST /api/customer-bulk (Fase 2A.4)
// Auth: verifyAdmin. Idempotent. Anonymized klanten worden overgeslagen
// (server-side). Max 100 per call.
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }

let state = null;

function initState(customerIds, mode) {
  state = {
    customerIds: Array.isArray(customerIds) ? customerIds.slice(0, 100) : [],
    mode:        mode || 'archive',
    reason:      '',
    saving:      false,
    error:       null,
    result:      null,
    onSuccess:   null,
  };
}

async function doSubmit() {
  state.saving = true; state.error = null; state.result = null;
  rerender();
  try {
    const body = {
      action:       state.mode,
      customer_ids: state.customerIds,
    };
    const reason = String(state.reason || '').trim();
    if (reason) body.reason = reason;
    const j = await K().authedJson('/api/customer-bulk', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    state.result = {
      total:         j?.total || 0,
      success_count: j?.success_count || 0,
      fail_count:    j?.fail_count || 0,
      failed:        Array.isArray(j?.failed) ? j.failed : [],
    };
    K().toast(`${state.mode === 'archive' ? 'Gearchiveerd' : 'Heractief'}: ${state.result.success_count}/${state.result.total}`);
    if (typeof state.onSuccess === 'function') state.onSuccess(state.result);
    if (state.result.fail_count === 0) setTimeout(() => D().closeModal(), 1200);
  } catch (e) {
    state.error = e?.message || 'Bulk-actie mislukt';
  } finally {
    state.saving = false;
    rerender();
  }
}

function renderHead() {
  const title = state.mode === 'archive' ? 'Bulk archiveren' : 'Bulk heractiveren';
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">${state.customerIds.length} klant${state.customerIds.length === 1 ? '' : 'en'}</div>
        <div class="kv-edit-head-name">${esc(title)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-barch-close aria-label="Sluiten">
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
          <ul>${r.failed.slice(0, 20).map(f => `<li><code>${esc(String(f.id).slice(0, 8))}</code>: ${esc(f.reason || 'onbekend')}</li>`).join('')}${r.failed.length > 20 ? `<li>… en ${r.failed.length - 20} meer</li>` : ''}</ul>
        </details>
      ` : ''}
    </div>`;
}

function renderBody() {
  const isArchive = state.mode === 'archive';
  const explanation = isArchive
    ? `Verplaatst ${state.customerIds.length} klant${state.customerIds.length === 1 ? '' : 'en'} naar het archief. Historische data blijft bewaard. Al-gearchiveerde en geanonimiseerde klanten worden overgeslagen (no-op).`
    : `Maakt ${state.customerIds.length} klant${state.customerIds.length === 1 ? '' : 'en'} weer actief. Al-actieve klanten worden overgeslagen.`;
  return `
    <div class="kv-arch-body">
      ${state.error ? `<div class="kv-edit-banner">${esc(state.error)}</div>` : ''}
      ${renderResult()}

      <div class="kv-arch-explain ${isArchive ? 'is-archive' : 'is-unarchive'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          ${isArchive
            ? '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/>'
            : '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>'}
        </svg>
        <div>${explanation}</div>
      </div>

      <div class="kv-edit-field kv-arch-reason">
        <label for="kv-barch-reason">Reden (optioneel)</label>
        <textarea id="kv-barch-reason" rows="3" data-kv-barch-reason placeholder="Vrije tekst — wordt bij elke bulk-audit-entry meegeschreven.">${esc(state.reason)}</textarea>
      </div>
    </div>`;
}

function renderFoot() {
  const isArchive = state.mode === 'archive';
  const confirmCls = isArchive ? 'ds-btn-danger' : 'ds-btn-primary';
  const confirmLbl = isArchive
    ? `Archiveer ${state.customerIds.length}`
    : `Heractiveer ${state.customerIds.length}`;
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-barch-close ${state.saving ? 'disabled' : ''}>${state.result ? 'Sluiten' : 'Annuleren'}</button>
      ${!state.result ? `<button type="button" class="ds-btn ${confirmCls}" data-kv-barch-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Bezig…' : esc(confirmLbl)}
      </button>` : ''}
    </div>`;
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-barch-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-barch-submit]')?.addEventListener('click', doSubmit);
  const ta = box.querySelector('[data-kv-barch-reason]');
  if (ta) {
    ta.addEventListener('input', (e) => { state.reason = e.target.value; });
    setTimeout(() => ta.focus(), 0);
  }
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

/**
 * openBulkArchiveModal({ customerIds, mode, onSuccess })
 *   customerIds — array van uuid's; capped at 100.
 *   mode        — 'archive' (default) of 'unarchive'.
 *   onSuccess   — callback(result) na een succesvolle POST (ook bij 207).
 */
export function openBulkArchiveModal({ customerIds, mode = 'archive', onSuccess } = {}) {
  if (!Array.isArray(customerIds) || customerIds.length === 0) {
    K().toast('Geen klanten geselecteerd');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(customerIds, mode);
  state.onSuccess = onSuccess || null;
  rerender();
}
