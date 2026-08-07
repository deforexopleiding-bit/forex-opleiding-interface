// modules/klanten-v2/views/modals/edit-customer.js
//
// Klant-bewerken-modal (PR-C1, eerste van de klant-modal-serie).
// Vervangt de "Bewerken"-toast-placeholders uit PR-B2 met een echte
// werkende modal. Rendert via de gedeelde DFO shell-modal (0-B2:
// window.DFO.openModal / closeModal) zodat de UI-primitive consistent
// blijft met de rest van het redesign.
//
// Endpoint (bestaand): PATCH /api/customer?id=<uuid>
// Auth: verifyAdmin (super_admin / admin / manager)
// WRITABLE_FIELDS (server-side witelist):
//   is_company, company_name, kvk_number, vat_number,
//   first_name, last_name, email, phone, date_of_birth,
//   address_street, address_number, address_postal, address_city,
//   tl_contact_id, ghl_contact_id
//
// Beschermde-zone: nul aanraking. Geen wanbetalers-endpoints, geen
// tag-mutaties (die krijgen eigen PR-Cx), geen bulk-actions.

const K = () => window.KV;
const D = () => window.DFO;

// Field-map per sectie. Order = render-order in de modal.
const FIELDS_PERSONAL = [
  { key: 'first_name',     label: 'Voornaam',       type: 'text',  required: (isCo) => !isCo, autocomplete: 'given-name' },
  { key: 'last_name',      label: 'Achternaam',     type: 'text',  required: (isCo) => !isCo, autocomplete: 'family-name' },
  { key: 'date_of_birth',  label: 'Geboortedatum',  type: 'date',  required: () => false },
];
const FIELDS_COMPANY = [
  { key: 'company_name',   label: 'Bedrijfsnaam',   type: 'text',  required: (isCo) => isCo },
  { key: 'kvk_number',     label: 'KvK-nummer',     type: 'text',  required: () => false },
  { key: 'vat_number',     label: 'BTW-nummer',     type: 'text',  required: () => false },
];
const FIELDS_CONTACT = [
  { key: 'email',          label: 'E-mail',         type: 'email', required: () => false, autocomplete: 'email' },
  { key: 'phone',          label: 'Telefoon',       type: 'tel',   required: () => false, autocomplete: 'tel' },
];
const FIELDS_ADDRESS = [
  { key: 'address_street', label: 'Straat',         type: 'text',  full: true },
  { key: 'address_number', label: 'Nummer',         type: 'text' },
  { key: 'address_postal', label: 'Postcode',       type: 'text' },
  { key: 'address_city',   label: 'Plaats',         type: 'text',  full: true },
];

function esc(v) { return K().esc(v); }
function val(v) { return v == null ? '' : String(v); }

// ── Modal-state (per open() vers) ──────────────────────────────────────────
let state = null;

function initState(customer) {
  const c = customer || {};
  state = {
    id:          c.id || null,
    original:    c,
    form: {
      is_company:      !!c.is_company,
      first_name:      c.first_name      || '',
      last_name:       c.last_name       || '',
      date_of_birth:   c.date_of_birth   || '',
      company_name:    c.company_name    || '',
      kvk_number:      c.kvk_number      || '',
      vat_number:      c.vat_number      || '',
      email:           c.email           || '',
      phone:           c.phone           || '',
      address_street:  c.address_street  || '',
      address_number:  c.address_number  || '',
      address_postal:  c.address_postal  || '',
      address_city:    c.address_city    || '',
      // tl_contact_id + ghl_contact_id blijven server-managed; UI toont ze
      // read-only in de meta-card (Profiel-tab) en modal edit ze niet.
    },
    errors: {},        // field-level → string
    globalError: null, // top-of-modal banner
    saving: false,
    onSuccess: null,   // callback met (updatedCustomer) na 200 OK
  };
}

// ── Field-rendering ────────────────────────────────────────────────────────

function renderField(f, isCompany) {
  const req = typeof f.required === 'function' ? f.required(isCompany) : !!f.required;
  const v = state.form[f.key];
  const err = state.errors[f.key];
  const inputId = `kv-edit-${f.key}`;
  const ac = f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : '';
  return `
    <div class="kv-edit-field ${f.full ? 'kv-edit-field-full' : ''} ${err ? 'kv-edit-field-error' : ''}">
      <label for="${inputId}">${esc(f.label)}${req ? ' <span class="kv-edit-req">*</span>' : ''}</label>
      <input id="${inputId}" name="${esc(f.key)}" type="${esc(f.type)}" value="${esc(val(v))}"${ac} data-kv-edit-input />
      ${err ? `<div class="kv-edit-field-msg">${esc(err)}</div>` : ''}
    </div>`;
}

function renderBody() {
  const isCo = !!state.form.is_company;
  const companyFields = isCo
    ? FIELDS_COMPANY.map(f => renderField(f, isCo)).join('')
    : '';
  return `
    <form id="kv-edit-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-edit-toggle-row">
        <label class="kv-edit-toggle">
          <input type="checkbox" data-kv-edit-toggle-company ${isCo ? 'checked' : ''} />
          <span>Bedrijfsklant</span>
        </label>
        <div class="kv-edit-hint">Wissel om zakelijke velden (Bedrijfsnaam / KvK / BTW) te tonen.</div>
      </div>

      ${isCo ? `
        <div class="kv-edit-section-h">Bedrijf</div>
        <div class="kv-edit-grid">${companyFields}</div>
      ` : ''}

      <div class="kv-edit-section-h">Persoonlijk</div>
      <div class="kv-edit-grid">${FIELDS_PERSONAL.map(f => renderField(f, isCo)).join('')}</div>

      <div class="kv-edit-section-h">Contact</div>
      <div class="kv-edit-grid">${FIELDS_CONTACT.map(f => renderField(f, isCo)).join('')}</div>

      <div class="kv-edit-section-h">Adres</div>
      <div class="kv-edit-grid kv-edit-grid-address">${FIELDS_ADDRESS.map(f => renderField(f, isCo)).join('')}</div>
    </form>`;
}

function renderHead() {
  const name = state.form.is_company
    ? (state.form.company_name || 'Nieuw bedrijf')
    : [state.form.first_name, state.form.last_name].filter(Boolean).join(' ') || 'Klant';
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Klant bewerken</div>
        <div class="kv-edit-head-name">${esc(name)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-edit-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-edit-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-edit-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Opslaan…' : 'Opslaan'}
      </button>
    </div>`;
}

// ── Client-side pre-check (matcht server-side WRITABLE + required rules) ──
// Server is autoritatief; deze check verlaagt round-trips voor de meest
// voorkomende leeg-verplichte-velden situaties. Voor complexere validatie
// (email-format / BTW-format) laten we de server 400 teruggeven.

function clientValidate() {
  const errors = {};
  const isCo = !!state.form.is_company;
  if (isCo) {
    if (!String(state.form.company_name || '').trim()) errors.company_name = 'Bedrijfsnaam is verplicht';
  } else {
    if (!String(state.form.first_name || '').trim()) errors.first_name = 'Voornaam is verplicht';
    if (!String(state.form.last_name  || '').trim()) errors.last_name  = 'Achternaam is verplicht';
  }
  const email = String(state.form.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Ongeldig e-mailformaat';
  const dob = String(state.form.date_of_birth || '').trim();
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) errors.date_of_birth = 'Formaat moet YYYY-MM-DD zijn';
  return errors;
}

// ── Submit + PATCH ─────────────────────────────────────────────────────────

async function doSave() {
  state.errors = clientValidate();
  state.globalError = null;
  if (Object.keys(state.errors).length) {
    rerender();
    return;
  }
  state.saving = true;
  rerender();

  // Alleen wijzigingen versturen — schoon lijstje voor de audit-log.
  const patch = {};
  for (const key of Object.keys(state.form)) {
    const cur = state.form[key];
    const orig = state.original[key];
    // Normalize: string vs boolean vs null-vs-empty
    const same = (cur === orig) || (cur === '' && (orig == null)) || (!!cur === !!orig && typeof cur === 'boolean');
    if (!same) patch[key] = cur === '' ? null : cur;
  }
  if (Object.keys(patch).length === 0) {
    state.saving = false;
    state.globalError = 'Geen wijzigingen om op te slaan.';
    rerender();
    return;
  }

  try {
    const j = await K().authedJson(`/api/customer?id=${encodeURIComponent(state.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    const updated = j?.customer || null;
    K().toast('Klantgegevens bijgewerkt');
    if (typeof state.onSuccess === 'function') state.onSuccess(updated);
    D().closeModal();
  } catch (e) {
    // Server geeft {error, field} bij validatie-fouten; field-error koppelen
    // aan het juiste input-field zodat de user niet moet zoeken.
    const msg = e?.message || 'Opslaan mislukt';
    const field = e?.body?.field;
    if (field) state.errors[field] = msg;
    else state.globalError = msg;
    state.saving = false;
    rerender();
  }
}

// ── Wire (na elke render) ─────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-edit-close], [data-kv-edit-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-edit-submit]')?.addEventListener('click', doSave);
  box.querySelector('#kv-edit-form')?.addEventListener('submit', (e) => { e.preventDefault(); doSave(); });

  box.querySelectorAll('[data-kv-edit-input]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const name = e.target.name;
      state.form[name] = e.target.value;
      if (state.errors[name]) { delete state.errors[name]; rerenderField(name); }
    });
    inp.addEventListener('blur', () => {
      // Re-render head als naam-veld wijzigde (live-title update)
      if (['first_name', 'last_name', 'company_name'].includes(inp.name)) rerenderHead();
    });
  });
  box.querySelector('[data-kv-edit-toggle-company]')?.addEventListener('change', (e) => {
    state.form.is_company = !!e.target.checked;
    // Wanneer we naar bedrijf switchen, wis field-errors op persoonlijk-velden
    // (en vice versa) — die worden immers non-required.
    state.errors = {};
    rerender();
  });
}

// ── Micro-render helpers (voorkomen focus-verlies bij typen) ──────────────

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderHead() {
  const el = document.querySelector('#dfoModalHead');
  if (el) el.innerHTML = renderHead();
  document.querySelector('[data-kv-edit-close]')?.addEventListener('click', () => D().closeModal());
}
function rerenderField(name) {
  // Genoeg om alleen de foot-error te clearen; volledige input-refresh
  // zou de cursor resetten. We doen dus alleen visueel de error weg via
  // een CSS-class-flip.
  const el = document.querySelector(`.kv-edit-field input[name="${name}"]`)?.closest('.kv-edit-field');
  if (el) {
    el.classList.remove('kv-edit-field-error');
    el.querySelector('.kv-edit-field-msg')?.remove();
  }
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openEditCustomerModal({ customer, onSuccess })
 *   customer  — het klant-object uit dossier.customer (met alle huidige
 *               waarden). Wordt gebruikt als vulling + baseline voor
 *               diff-only PATCH.
 *   onSuccess — optionele callback(updatedCustomer) na een geslaagde
 *               PATCH. Detail-view gebruikt deze om z'n cache te resetten
 *               en de header + Profiel-tab te re-renderen.
 */
export function openEditCustomerModal({ customer, onSuccess }) {
  if (!customer?.id) {
    K().toast('Geen klant om te bewerken');
    return;
  }
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar (DFO shell).');
    return;
  }
  initState(customer);
  state.onSuccess = onSuccess || null;
  rerender();
}
