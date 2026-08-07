// modules/klanten-v2/views/modals/link-company.js
//
// Link-company-modal (PR-C4, deel 2 van 2). Koppel of ontkoppel een
// PERSOON-klant aan/van een BEDRIJF-klant. 2-way relatie: het endpoint
// aan de server-kant zorgt dat de bedrijf-tegenhanger (linked_persons)
// synchroon blijft; UI werkt uitsluitend vanuit de persoon-kant.
//
// ⚠ EXTRA ZORGVULDIG (records-relaties):
//   - Alleen open op persoon-klanten (customer.is_company=false). Bedrijf-
//     klanten hebben géén trigger-knop (kijk in link-persons-flow als
//     die ooit gebouwd wordt).
//   - Bedrijf-picker filtert HARD op is_company=true (server + client).
//   - Ontkoppelen vraagt bevestiging (destructive read-side impact:
//     Bedrijf-rij in Profiel-tab wordt "Geen bedrijf gekoppeld").
//   - Server returnt 400/404/409/501 met specifieke error-codes; we
//     mappen die naar bruikbare NL-teksten.
//   - Diff-only: als user het bedrijf niet wijzigt is de submit-btn
//     disabled (voorkomt no-op audit-events).
//
// Endpoints (allen bestaand):
//   POST /api/customer-link-company  body: {person_customer_id, company_customer_id|null}
//   GET  /api/customers?is_company=true&search=<q>&page_size=25  — bedrijf-picker
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }

let state = null;

function initState(person, linkedCompany) {
  state = {
    personId:        person?.id || null,
    personName:      customerFullName(person),
    linkedCompanyId: linkedCompany?.id || null,
    linkedCompany,                            // huidige gekoppelde bedrijf (voor "Ontkoppelen"-flow)
    selectedId:      linkedCompany?.id || null, // wat de user momenteel kiest
    selectedSummary: linkedCompany ? companySummary(linkedCompany) : null,
    searchQuery:     '',
    searchResults:   [],
    searchLoading:   false,
    searchError:     null,
    saving:          false,
    error:           null,
    onSuccess:       null,
    unlinkConfirm:   false,                   // 2e-klik-bevestiging voor ontkoppelen
  };
}

function customerFullName(c) {
  if (!c) return '';
  if (c.is_company && c.company_name) return c.company_name;
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || '';
}
function companySummary(c) {
  const name = c.company_name || customerFullName(c);
  const meta = [c.kvk_number ? `KvK ${c.kvk_number}` : null, c.email].filter(Boolean).join(' · ');
  return { id: c.id, name, meta };
}

// ── Search (debounced buiten renderer) ────────────────────────────────────

let searchTimer = null;
function scheduleSearch(rootEl) {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(rootEl), 200);
}
async function runSearch(rootEl) {
  const q = String(state.searchQuery || '').trim();
  state.searchLoading = true;
  state.searchError = null;
  rerenderResults();
  try {
    const params = new URLSearchParams();
    params.set('is_company', 'true');
    params.set('page_size', '25');
    if (q) params.set('search', q);
    const j = await K().authedJson(`/api/customers?${params.toString()}`);
    // /api/customers response-shape: { customers: [...] } (list-view gebruikt zelfde endpoint).
    const rows = Array.isArray(j?.customers) ? j.customers
               : Array.isArray(j?.data)      ? j.data
               : [];
    // Client-side extra guard: filter alleen echte bedrijven + niet gearchiveerd
    state.searchResults = rows
      .filter(r => r && r.is_company === true && r.status === 'active')
      .slice(0, 25);
  } catch (e) {
    state.searchError = e?.message || 'Zoekfout';
    state.searchResults = [];
  } finally {
    state.searchLoading = false;
    rerenderResults();
  }
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Bedrijf-koppeling</div>
        <div class="kv-edit-head-name">${esc(state.personName)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-link-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderCurrentLink() {
  if (!state.linkedCompany) {
    return `
      <div class="kv-link-current is-none">
        <div class="kv-link-current-l">Huidige koppeling</div>
        <div class="kv-link-current-v">Geen bedrijf gekoppeld</div>
      </div>`;
  }
  const s = companySummary(state.linkedCompany);
  return `
    <div class="kv-link-current is-linked">
      <div class="kv-link-current-l">Huidige koppeling</div>
      <div class="kv-link-current-v">
        <strong>${esc(s.name)}</strong>
        ${s.meta ? `<div class="kv-link-current-meta">${esc(s.meta)}</div>` : ''}
      </div>
      <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm kv-link-unlink"
              data-kv-link-unlink title="Bedrijfskoppeling verwijderen">
        ${state.unlinkConfirm ? '<strong style="color:var(--rose);">Bevestig ontkoppelen</strong>' : 'Ontkoppelen'}
      </button>
    </div>`;
}

function renderSelectedPreview() {
  if (!state.selectedId || state.selectedId === state.linkedCompanyId) return '';
  const s = state.selectedSummary || (state.searchResults.find(r => r.id === state.selectedId) && companySummary(state.searchResults.find(r => r.id === state.selectedId)));
  if (!s) return '';
  return `
    <div class="kv-link-selected">
      <div class="kv-link-selected-l">Nieuwe koppeling</div>
      <div class="kv-link-selected-v">
        <strong>${esc(s.name)}</strong>
        ${s.meta ? `<div class="kv-link-selected-meta">${esc(s.meta)}</div>` : ''}
      </div>
    </div>`;
}

function renderResults() {
  if (state.searchLoading) {
    return `<div class="kv-link-loading">Bedrijven zoeken…</div>`;
  }
  if (state.searchError) {
    return `<div class="kv-link-error">${esc(state.searchError)}</div>`;
  }
  const rows = state.searchResults || [];
  if (!rows.length) {
    return `<div class="kv-link-empty">${state.searchQuery ? `Geen bedrijven gevonden voor "${esc(state.searchQuery)}".` : 'Typ om te zoeken in actieve bedrijven…'}</div>`;
  }
  return `
    <ul class="kv-link-results">
      ${rows.map((c) => {
        const s = companySummary(c);
        const isSel = state.selectedId === c.id;
        const isCur = state.linkedCompanyId === c.id;
        return `
          <li class="kv-link-result ${isSel ? 'is-selected' : ''} ${isCur ? 'is-current' : ''}">
            <button type="button" class="kv-link-result-btn" data-kv-link-select="${esc(c.id)}">
              <div class="kv-link-result-main">
                <div class="kv-link-result-name">${esc(s.name)}${isCur ? ' <span class="kv-link-cur-badge">Huidig</span>' : ''}</div>
                ${s.meta ? `<div class="kv-link-result-meta">${esc(s.meta)}</div>` : ''}
              </div>
              ${isSel ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px;color:var(--m);"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
            </button>
          </li>`;
      }).join('')}
    </ul>`;
}

function renderBody() {
  return `
    <div class="kv-link-body">
      ${state.error ? `<div class="kv-edit-banner">${esc(state.error)}</div>` : ''}

      ${renderCurrentLink()}
      ${renderSelectedPreview()}

      <div class="kv-link-section-h">Zoek een ander bedrijf</div>
      <div class="kv-link-searchbox">
        <input type="search" data-kv-link-search value="${esc(state.searchQuery)}"
               placeholder="Naam, KvK-nummer of e-mail…" autocomplete="off" />
      </div>
      <div class="kv-link-results-wrap" id="kv-link-results">${renderResults()}</div>
    </div>`;
}

function renderFoot() {
  const hasChange = (state.selectedId || null) !== (state.linkedCompanyId || null);
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-link-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-link-submit
              ${(!hasChange || state.saving) ? 'disabled' : ''}>
        ${state.saving ? 'Opslaan…' : (state.selectedId ? 'Koppeling opslaan' : 'Ontkoppelen')}
      </button>
    </div>`;
}

// ── Submit ─────────────────────────────────────────────────────────────────

function mapErrorCode(msg) {
  // Endpoint-error-codes vertalen naar bruikbare NL-teksten.
  const s = String(msg || '');
  if (/PERSON_MUST_NOT_BE_COMPANY/.test(s)) return 'Alleen persoon-klanten kunnen aan een bedrijf gekoppeld worden.';
  if (/COMPANY_MUST_BE_COMPANY/.test(s))    return 'Gekozen record is geen bedrijf.';
  if (/CANNOT_SELF_LINK/.test(s))           return 'Een klant kan zichzelf niet als bedrijf koppelen.';
  if (/MIGRATION_REQUIRED/.test(s))         return 'Server-migratie ontbreekt (customer_customer_id kolom). Vraag de admin de klanten-2A.2-migratie te draaien.';
  if (/gearchiveerd|geanonimiseerd|409/.test(s)) return 'Één van beide klanten is gearchiveerd of geanonimiseerd — koppeling niet mogelijk.';
  return s || 'Actie mislukt';
}

async function doSubmit() {
  state.saving = true; state.error = null;
  rerender();
  try {
    const body = {
      person_customer_id:  state.personId,
      company_customer_id: state.selectedId || null,
    };
    const j = await K().authedJson('/api/customer-link-company', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    K().toast(state.selectedId ? 'Bedrijf gekoppeld' : 'Bedrijf ontkoppeld');
    if (typeof state.onSuccess === 'function') state.onSuccess(j);
    D().closeModal();
  } catch (e) {
    state.error = mapErrorCode(e?.message);
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-link-close], [data-kv-link-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-link-submit]')?.addEventListener('click', doSubmit);

  // Ontkoppel-flow: 2-clicks confirm (state.unlinkConfirm toggle). Bij 2e klik
  // zetten we selectedId=null en submitten meteen — actie is duidelijk
  // (huidig → geen) en past niet in de standaard "kies + opslaan"-flow.
  box.querySelector('[data-kv-link-unlink]')?.addEventListener('click', () => {
    if (!state.unlinkConfirm) {
      state.unlinkConfirm = true;
      rerender();
      setTimeout(() => { if (state) { state.unlinkConfirm = false; rerender(); } }, 4000);
      return;
    }
    state.selectedId = null;
    state.selectedSummary = null;
    state.unlinkConfirm = false;
    doSubmit();
  });

  const sInp = box.querySelector('[data-kv-link-search]');
  if (sInp) {
    sInp.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      scheduleSearch(box);
    });
    // Auto-focus + eerste search-call bij open (leeg → recente 25 bedrijven).
    setTimeout(() => { sInp.focus(); if (!state.searchResults.length && !state.searchLoading) scheduleSearch(box); }, 0);
  }

  wireResultButtons();
}

function wireResultButtons() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-link-select]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-link-select');
      state.selectedId = id;
      const row = state.searchResults.find(r => r.id === id);
      state.selectedSummary = row ? companySummary(row) : null;
      rerender();
    });
  });
}

// Alleen de results-container hertekenen om focus in het zoekveld te
// behouden tijdens typen. rerenderResults doet niet de hele modal.
function rerenderResults() {
  const el = document.getElementById('kv-link-results');
  if (el) el.innerHTML = renderResults();
  wireResultButtons();
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openLinkCompanyModal({ person, linkedCompany, onSuccess })
 *   person        — persoon-klant (is_company=false). Vereist id.
 *   linkedCompany — huidig gekoppeld bedrijf (of null).
 *   onSuccess     — callback(response) na 200 OK.
 */
export function openLinkCompanyModal({ person, linkedCompany, onSuccess } = {}) {
  if (!person?.id) {
    K().toast('Geen klant om te koppelen');
    return;
  }
  if (person.is_company) {
    K().toast('Deze modal werkt alleen op persoon-klanten (niet op bedrijven).');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar.');
    return;
  }
  initState(person, linkedCompany || null);
  state.onSuccess = onSuccess || null;
  rerender();
}
