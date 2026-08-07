// modules/klanten-v2/views/modals/archive-customer.js
//
// Archive / Unarchive-modal (PR-C2, tweede van de klant-modal-serie).
// Vervangt de "komt in volgende PR-C"-toast op de Archive-knop uit
// detail.js met een echte werkende modal. Rendert via de gedeelde DFO
// shell-modal-primitive (0-B2 openModal/closeModal).
//
// Endpoint (bestaand): POST /api/customer-archive?id=<uuid>&action=archive|unarchive
// Auth: verifyAdmin (super_admin / admin / manager)
// Body (optional): { reason: string } — opgeslagen in audit_log.reason_text
// Idempotent: archive-op-archived → no-op zonder audit. Anonymized klant
// → 403 (eindstaat).
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

let state = null;

function initState(customer, mode) {
  state = {
    id:         customer?.id || null,
    customer,
    mode,                    // 'archive' | 'unarchive'
    reason:     '',
    saving:     false,
    error:      null,
    onSuccess:  null,        // callback (updatedCustomer, mode) na 200 OK
  };
}

function customerFullName(c) {
  if (!c) return 'Klant';
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || 'Klant';
}
function esc(v) { return K().esc(v); }

// ── Renderers ───────────────────────────────────────────────────────────────

function renderHead() {
  const title = state.mode === 'archive' ? 'Klant archiveren' : 'Klant heractiveren';
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">${esc(state.mode === 'archive' ? 'Archief' : 'Heractiveren')}</div>
        <div class="kv-edit-head-name">${esc(title)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-arch-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderBody() {
  const name = customerFullName(state.customer);
  const isArchive = state.mode === 'archive';
  const explanation = isArchive
    ? `<strong>${esc(name)}</strong> wordt verplaatst naar het archief. De klant verdwijnt uit de actieve lijst; historische data (offertes, facturen, notities) blijft bewaard. Je kunt de klant later heractiveren.`
    : `<strong>${esc(name)}</strong> wordt weer actief gemaakt en verschijnt weer in de actieve lijst. Alle historische data blijft ongewijzigd.`;

  return `
    <div class="kv-arch-body">
      ${state.error ? `<div class="kv-edit-banner">${esc(state.error)}</div>` : ''}

      <div class="kv-arch-explain ${isArchive ? 'is-archive' : 'is-unarchive'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          ${isArchive
            ? '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><line x1="10" y1="12" x2="14" y2="12"/>'
            : '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>'
          }
        </svg>
        <div>${explanation}</div>
      </div>

      <div class="kv-edit-field kv-arch-reason">
        <label for="kv-arch-reason">Reden ${isArchive ? '' : '(optioneel)'}</label>
        <textarea id="kv-arch-reason" rows="3" data-kv-arch-reason
                  placeholder="${isArchive ? 'Bv. \'geen actieve klant meer sinds mrt 2024\' — wordt bewaard in de audit-log.' : 'Bv. \'klant heeft opnieuw interesse\' — audit-context.'}"
        >${esc(state.reason)}</textarea>
      </div>
    </div>`;
}

function renderFoot() {
  const isArchive = state.mode === 'archive';
  const confirmCls = isArchive ? 'ds-btn-danger' : 'ds-btn-primary';
  const confirmLbl = isArchive ? 'Archiveren' : 'Heractiveren';
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-arch-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ${confirmCls}" data-kv-arch-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Bezig…' : esc(confirmLbl)}
      </button>
    </div>`;
}

// ── Submit ──────────────────────────────────────────────────────────────────

async function doSubmit() {
  state.saving = true; state.error = null;
  rerender();
  try {
    const url = `/api/customer-archive?id=${encodeURIComponent(state.id)}&action=${encodeURIComponent(state.mode)}`;
    const body = state.reason.trim() ? JSON.stringify({ reason: state.reason.trim() }) : JSON.stringify({});
    const j = await K().authedJson(url, { method: 'POST', body });
    const updated = j?.customer || null;
    K().toast(state.mode === 'archive' ? 'Klant gearchiveerd' : 'Klant heractief');
    if (typeof state.onSuccess === 'function') state.onSuccess(updated, state.mode);
    D().closeModal();
  } catch (e) {
    state.error = e?.message || 'Actie mislukt';
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-arch-close], [data-kv-arch-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-arch-submit]')?.addEventListener('click', doSubmit);
  const ta = box.querySelector('[data-kv-arch-reason]');
  if (ta) {
    ta.addEventListener('input', (e) => { state.reason = e.target.value; });
    // Auto-focus (na render) — helpt sneller typen.
    setTimeout(() => ta.focus(), 0);
  }
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openArchiveCustomerModal({ customer, mode, onSuccess })
 *   customer  — het klant-object. Vereist `id`. `archived_at` bepaalt de
 *               default-mode als geen expliciete `mode` gegeven wordt.
 *   mode      — 'archive' | 'unarchive' | undefined (auto-detect).
 *   onSuccess — callback(updatedCustomer, mode) na 200 OK. Detail-view
 *               gebruikt dit om:
 *                 - bij archive: terug naar lijst-view (klant is uit
 *                   actieve view)
 *                 - bij unarchive: cache resetten + tab re-renderen
 */
export function openArchiveCustomerModal({ customer, mode, onSuccess }) {
  if (!customer?.id) {
    K().toast('Geen klant om te archiveren');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar (DFO shell).');
    return;
  }
  const effectiveMode = mode || (customer.archived_at ? 'unarchive' : 'archive');
  initState(customer, effectiveMode);
  state.onSuccess = onSuccess || null;
  rerender();
}
