// modules/klanten-v2/views/modals/create-customer.js
//
// Nieuwe-klant-modal (PR-C3, derde in de klant-modal-serie). Vervangt
// de "Nieuwe-klant-modal komt in PR-C"-toast in list.js met een echte
// werkende modal die een klant aanmaakt via de bestaande POST /api/customer
// endpoint. Rendert via de gedeelde DFO shell-modal (0-B2).
//
// Zelfde field-schema als edit-customer.js (Persoonlijk / Bedrijf /
// Contact / Adres). Startt met een lege state en één bewuste default:
// is_company = false zodat 'particulier' de default is (verreweg de
// meeste klanten). Toggle voor bedrijf staat er direct bij.
//
// Endpoint (bestaand): POST /api/customer
// Auth: verifyAdmin (super_admin / admin / manager)
// Response 201: { customer: {...} }
// Server-side validatie: 400 {error, field}
//
// Beschermde-zone: nul aanraking.

import { checkDuplicates, openDuplicateConfirmModal } from './duplicate-confirm.js';

const K = () => window.KV;
const D = () => window.DFO;

// Zelfde field-groepen als edit-customer.js — bewust apart zodat elke
// modal onafhankelijk kan itereren zonder cross-modal impact.
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

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState() {
  state = {
    form: {
      is_company:      false,
      first_name:      '',
      last_name:       '',
      date_of_birth:   '',
      company_name:    '',
      kvk_number:      '',
      vat_number:      '',
      email:           '',
      phone:           '',
      address_street:  '',
      address_number:  '',
      address_postal:  '',
      address_city:    '',
    },
    errors: {},
    globalError: null,
    saving: false,
    onSuccess: null,
  };
}

// ── Renderers ──────────────────────────────────────────────────────────────

function renderField(f, isCompany) {
  const req = typeof f.required === 'function' ? f.required(isCompany) : !!f.required;
  const v = state.form[f.key];
  const err = state.errors[f.key];
  const inputId = `kv-create-${f.key}`;
  const ac = f.autocomplete ? ` autocomplete="${esc(f.autocomplete)}"` : '';
  return `
    <div class="kv-edit-field ${f.full ? 'kv-edit-field-full' : ''} ${err ? 'kv-edit-field-error' : ''}">
      <label for="${inputId}">${esc(f.label)}${req ? ' <span class="kv-edit-req">*</span>' : ''}</label>
      <input id="${inputId}" name="${esc(f.key)}" type="${esc(f.type)}" value="${esc(val(v))}"${ac} data-kv-create-input />
      ${err ? `<div class="kv-edit-field-msg">${esc(err)}</div>` : ''}
    </div>`;
}

function renderHead() {
  const isCo = !!state.form.is_company;
  const preview = isCo
    ? (state.form.company_name || 'Nieuw bedrijf')
    : ([state.form.first_name, state.form.last_name].filter(Boolean).join(' ') || 'Nieuwe klant');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Nieuwe klant</div>
        <div class="kv-edit-head-name">${esc(preview)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-create-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}

function renderBody() {
  const isCo = !!state.form.is_company;
  const companyBlock = isCo
    ? `<div class="kv-edit-section-h">Bedrijf</div>
       <div class="kv-edit-grid">${FIELDS_COMPANY.map(f => renderField(f, isCo)).join('')}</div>`
    : '';
  return `
    <form id="kv-create-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-edit-toggle-row">
        <label class="kv-edit-toggle">
          <input type="checkbox" data-kv-create-toggle-company ${isCo ? 'checked' : ''} />
          <span>Bedrijfsklant</span>
        </label>
        <div class="kv-edit-hint">Vink aan voor zakelijke velden (Bedrijfsnaam / KvK / BTW).</div>
      </div>

      ${companyBlock}

      <div class="kv-edit-section-h">Persoonlijk</div>
      <div class="kv-edit-grid">${FIELDS_PERSONAL.map(f => renderField(f, isCo)).join('')}</div>

      <div class="kv-edit-section-h">Contact</div>
      <div class="kv-edit-grid">${FIELDS_CONTACT.map(f => renderField(f, isCo)).join('')}</div>

      <div class="kv-edit-section-h">Adres</div>
      <div class="kv-edit-grid kv-edit-grid-address">${FIELDS_ADDRESS.map(f => renderField(f, isCo)).join('')}</div>
    </form>`;
}

function renderFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-create-cancel ${state.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-create-submit ${state.saving ? 'disabled' : ''}>
        ${state.saving ? 'Aanmaken…' : 'Klant aanmaken'}
      </button>
    </div>`;
}

// ── Client-side pre-check (matcht server-side required-regel) ─────────────

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

// ── Submit ──────────────────────────────────────────────────────────────────

async function doCreate({ skipDupeCheck = false } = {}) {
  state.errors = clientValidate();
  state.globalError = null;
  if (Object.keys(state.errors).length) {
    rerender();
    return;
  }

  // Duplicate-check vóór POST (alleen als email of phone ingevuld). Skip
  // wanneer user via de confirm-modal expliciet "toch doorgaan" heeft
  // gekozen — anders belanden we in een loop.
  const email = String(state.form.email || '').trim();
  const phone = String(state.form.phone || '').trim();
  if (!skipDupeCheck && (email || phone)) {
    state.saving = true; rerender();
    const matches = await checkDuplicates({ email, phone });
    state.saving = false;
    if (matches.length > 0) {
      const previewName = state.form.is_company
        ? (state.form.company_name || 'Nieuw bedrijf')
        : ([state.form.first_name, state.form.last_name].filter(Boolean).join(' ') || 'Onbekend');
      openDuplicateConfirmModal({
        matches,
        formData: { name: previewName, email, phone },
        onProceed: () => {
          // Terug naar de create-modal (state is nog intact), en submit
          // met skip-flag zodat we niet opnieuw dupe-check doen.
          rerender();
          doCreate({ skipDupeCheck: true });
        },
        onOpenExisting: (id) => {
          K().navigate({ id, tab: 'profiel' });
        },
      });
      return;
    }
  }

  state.saving = true;
  rerender();

  // Body-shape: alleen niet-lege velden meesturen (server accepteert null
  // maar audit-log is netter met alleen ingevulde velden). is_company
  // altijd meesturen zodat de server de create-regel correct volgt.
  const payload = { is_company: !!state.form.is_company };
  for (const key of Object.keys(state.form)) {
    if (key === 'is_company') continue;
    const v = state.form[key];
    if (v != null && String(v).trim() !== '') payload[key] = v;
  }

  try {
    const j = await K().authedJson('/api/customer', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const created = j?.customer || null;
    if (!created?.id) throw new Error('Onverwachte respons van server');
    K().toast('Klant aangemaakt');
    if (typeof state.onSuccess === 'function') state.onSuccess(created);
    D().closeModal();
  } catch (e) {
    const msg = e?.message || 'Aanmaken mislukt';
    const field = e?.body?.field;
    if (field) state.errors[field] = msg;
    else state.globalError = msg;
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-create-close], [data-kv-create-cancel]').forEach((b) => {
    b.addEventListener('click', () => D().closeModal());
  });
  box.querySelector('[data-kv-create-submit]')?.addEventListener('click', doCreate);
  box.querySelector('#kv-create-form')?.addEventListener('submit', (e) => { e.preventDefault(); doCreate(); });

  box.querySelectorAll('[data-kv-create-input]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const name = e.target.name;
      state.form[name] = e.target.value;
      if (state.errors[name]) { delete state.errors[name]; clearFieldError(name); }
    });
    inp.addEventListener('blur', () => {
      if (['first_name', 'last_name', 'company_name'].includes(inp.name)) rerenderHead();
    });
  });
  box.querySelector('[data-kv-create-toggle-company]')?.addEventListener('change', (e) => {
    state.form.is_company = !!e.target.checked;
    state.errors = {};
    rerender();
  });

  // Auto-focus eerste input (Bedrijfsnaam bij is_company=true, anders Voornaam)
  const firstInput = box.querySelector('[data-kv-create-input]');
  if (firstInput) setTimeout(() => firstInput.focus(), 0);
}

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderHead() {
  const el = document.querySelector('#dfoModalHead');
  if (el) el.innerHTML = renderHead();
  document.querySelector('[data-kv-create-close]')?.addEventListener('click', () => D().closeModal());
}
function clearFieldError(name) {
  const el = document.querySelector(`.kv-edit-field input[name="${name}"]`)?.closest('.kv-edit-field');
  if (el) {
    el.classList.remove('kv-edit-field-error');
    el.querySelector('.kv-edit-field-msg')?.remove();
  }
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openCreateCustomerModal({ onSuccess })
 *   onSuccess — callback(createdCustomer) na 201 CREATED. Caller
 *               bepaalt zelf de vervolgstap (bv. navigeren naar het
 *               nieuwe dossier via KV.navigate({id: created.id})).
 */
export function openCreateCustomerModal({ onSuccess } = {}) {
  if (!D() || typeof D().openModal !== 'function') {
    K().toast('Modal-primitive niet beschikbaar (DFO shell).');
    return;
  }
  initState();
  state.onSuccess = onSuccess || null;
  rerender();
}
