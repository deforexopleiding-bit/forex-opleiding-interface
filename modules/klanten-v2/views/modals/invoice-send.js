// modules/klanten-v2/views/modals/invoice-send.js
//
// Factuur-verzenden-modal (PR-D4, vierde van de 6 factuur-modals).
//
// KRITIEK: verzenden = e-mail vertrekt naar klant. Niet terug te roepen.
//
// Twee-stapsflow:
//   Stap 1 = preview + template-keuze (blauw-info banner)
//   Stap 2 = rode bevestiging + verplichte checkbox
//
// Guards:
//   - Enter in stap 1 → volgende (veilig, geen send)
//   - Enter in stap 2 → geblokkeerd (preventDefault)
//   - Verplichte checkbox in stap 2 → knop disabled tot aangevinkt
//   - In-flight lock: klik disablet direct + spinner; verdere klikken
//     worden genegeerd tot server-respons. Bij fout re-enable met banner.
//     Bij onduidelijke fout/timeout → "status onbekend — controleer in TL"
//     zonder auto-retry (send-endpoint is niet idempotent).
//
// Endpoint: POST /api/finance-invoice-send
// Body: { invoice_id, mail_template_id, recipient_email?,
//         subject_override?, content_override? }
// Zie NIET-onderdeel-van-body-shape: geen CC-veld, geen WA-veld.
// Endpoint accepteert die parameters niet, dus we tonen ze ook niet
// in de UI (dode controls = misleidend voor de gebruiker).
//
// Template-lijst: GET /api/finance-mail-templates
// (geeft {templates: [{id, name, subject, body, is_default, language}]})
//
// Beschermde-zone: nul aanraking.

const K = () => window.KV;
const D = () => window.DFO;

function esc(v) { return K().esc(v); }
const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

// ── State ──────────────────────────────────────────────────────────────────
let state = null;

function initState(invoice, opts) {
  state = {
    invoiceId: invoice?.id || null,
    invoice,
    step: 1,                          // 1 = preview, 2 = bevestiging
    templatesLoading: true,
    templatesError:   null,
    templates:        [],             // [{id, name, subject, body, is_default}]
    form: {
      mail_template_id: '',
      recipient_email:  invoice?.customer_email || invoice?.customer?.email || '',
      subject_override: '',           // leeg = template.subject
      content_override: '',           // leeg = template.body
      showFullBody:     false,        // toggle voor lange body-preview
    },
    confirmChecked:   false,          // stap 2 checkbox
    errors:      {},
    globalError: null,
    saving:      false,
    unknownStatus: false,             // true bij timeout/onduidelijk → geen retry
    onSuccess:   opts?.onSuccess || null,
  };
}

// ── Loaders ────────────────────────────────────────────────────────────────

async function loadTemplates() {
  try {
    const j = await K().authedJson('/api/finance-mail-templates');
    const tpls = Array.isArray(j?.templates) ? j.templates : [];
    state.templates = tpls;
    // Auto-select is_default (of eerste) zodat preview meteen zinvol is.
    if (tpls.length && !state.form.mail_template_id) {
      const def = tpls.find((t) => t.is_default) || tpls[0];
      state.form.mail_template_id = def.id;
    }
  } catch (e) {
    state.templatesError = e?.message || 'Templates niet geladen';
  } finally {
    state.templatesLoading = false;
    rerender();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function activeTemplate() {
  return state.templates.find((t) => t.id === state.form.mail_template_id) || null;
}
function activeSubject() {
  return String(state.form.subject_override || '').trim() || String(activeTemplate()?.subject || '').trim() || '';
}
function activeBody() {
  return String(state.form.content_override || '').trim() || String(activeTemplate()?.body || '').trim() || '';
}
function bodyPreview(txt, showAll) {
  const clean = String(txt || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (showAll || clean.length <= 240) return clean;
  return clean.slice(0, 240) + '…';
}

// ── Stap 1 — Preview + template-keuze ─────────────────────────────────────

function renderStep1() {
  const eEmail = state.errors.recipient_email;
  const eTpl   = state.errors.mail_template_id;
  const tpl    = activeTemplate();
  const subj   = activeSubject();
  const body   = activeBody();

  return `
    <form id="kv-invsend-form" class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}

      <div class="kv-invsend-notice kv-invsend-notice-info">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        <div>
          <div class="kv-invsend-notice-t"><strong>Deze factuur wordt per e-mail naar de klant gestuurd.</strong></div>
          <div class="kv-invsend-notice-s">Zodra je verstuurt kan dit niet worden teruggeroepen.</div>
        </div>
      </div>

      <div class="kv-edit-grid">
        <div class="kv-edit-field kv-edit-field-full ${eEmail ? 'kv-edit-field-error' : ''}">
          <label for="kv-invsend-email">Ontvanger <span class="kv-edit-req">*</span></label>
          <input id="kv-invsend-email" name="recipient_email" type="email"
                 value="${esc(state.form.recipient_email)}" data-kv-invsend-input
                 autocomplete="off" />
          ${eEmail ? `<div class="kv-edit-field-msg">${esc(eEmail)}</div>` : ''}
        </div>
        <div class="kv-edit-field kv-edit-field-full ${eTpl ? 'kv-edit-field-error' : ''}">
          <label for="kv-invsend-tpl">TL mail-template <span class="kv-edit-req">*</span></label>
          ${state.templatesLoading
            ? '<div class="kv-inv-loading">Templates laden…</div>'
            : state.templatesError
              ? `<div class="kv-inv-warn">Templates niet geladen: ${esc(state.templatesError)}</div>`
              : `<select id="kv-invsend-tpl" name="mail_template_id" data-kv-invsend-input>
                   ${state.templates.length ? '' : '<option value="">(Geen templates gevonden)</option>'}
                   ${state.templates.map((t) => `
                     <option value="${esc(t.id)}" ${state.form.mail_template_id === t.id ? 'selected' : ''}>
                       ${esc(t.name)}${t.is_default ? ' (default)' : ''}${t.language ? ' · ' + esc(t.language) : ''}
                     </option>
                   `).join('')}
                 </select>`}
          ${eTpl ? `<div class="kv-edit-field-msg">${esc(eTpl)}</div>` : ''}
        </div>
      </div>

      ${tpl ? `
        <div class="kv-edit-section-h">Preview</div>
        <div class="kv-invsend-preview">
          <div class="kv-invsend-preview-row">
            <span class="kv-invsend-preview-l">Onderwerp</span>
            <input class="kv-invsend-preview-inp" type="text" name="subject_override"
                   value="${esc(subj)}" data-kv-invsend-input placeholder="(gebruik template-onderwerp)" />
          </div>
          <div class="kv-invsend-preview-body">
            ${esc(bodyPreview(body, state.form.showFullBody))}
          </div>
          ${String(body || '').length > 240 ? `
            <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-invsend-toggle-body>
              ${state.form.showFullBody ? 'Verberg volledige tekst' : 'Toon volledige tekst'}
            </button>
          ` : ''}
          <div class="kv-invsend-preview-att">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Bijlage: <span class="mono">${esc(state.invoice?.invoice_number || 'FACTUUR')}.pdf</span>
          </div>
        </div>
      ` : ''}
    </form>`;
}

function renderStep1Foot() {
  const disabled = state.templatesLoading || !state.form.mail_template_id;
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invsend-cancel>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-invsend-next ${disabled ? 'disabled' : ''}>
        Volgende: bevestigen →
      </button>
    </div>`;
}

// ── Stap 2 — Rode bevestiging ─────────────────────────────────────────────

function renderStep2() {
  const inv = state.invoice;
  const nr  = inv?.invoice_number || (inv?.id ? '#' + String(inv.id).slice(0, 8) : '—');
  const amt = fmtEur(inv?.amount_total);
  return `
    <div class="kv-edit-form">
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      ${state.unknownStatus ? `
        <div class="kv-edit-banner kv-invsend-banner-unknown">
          <strong>Status onbekend.</strong> Controleer eerst in TeamLeader of deze factuur is verzonden voordat je opnieuw probeert.
        </div>` : ''}

      <div class="kv-invsend-notice kv-invsend-notice-danger">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div>
          <div class="kv-invsend-notice-t"><strong>Klaar om te verzenden naar <span class="mono">${esc(state.form.recipient_email)}</span></strong></div>
          <div class="kv-invsend-notice-s">Onomkeerbaar — de e-mail vertrekt direct uit TeamLeader.</div>
        </div>
      </div>

      <div class="kv-invsend-recap">
        <div class="kv-invsend-recap-row"><span>Factuurnummer</span><span class="mono">${esc(nr)}</span></div>
        <div class="kv-invsend-recap-row"><span>Bedrag</span><span class="mono">${esc(amt)}</span></div>
        <div class="kv-invsend-recap-row"><span>Ontvanger</span><span class="mono">${esc(state.form.recipient_email)}</span></div>
        <div class="kv-invsend-recap-row"><span>Template</span><span>${esc(activeTemplate()?.name || '—')}</span></div>
      </div>

      <label class="kv-invsend-confirm">
        <input type="checkbox" data-kv-invsend-confirm-check ${state.confirmChecked ? 'checked' : ''}
               ${state.saving ? 'disabled' : ''} />
        <span>Ik heb de ontvanger en het factuurnummer gecontroleerd</span>
      </label>
    </div>`;
}

function renderStep2Foot() {
  const canSubmit = state.confirmChecked && !state.saving && !state.unknownStatus;
  return `
    <div class="kv-edit-foot kv-invsend-foot-danger">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-invsend-back ${state.saving ? 'disabled' : ''}>← Terug naar preview</button>
      <button type="button" class="ds-btn ds-btn-danger" data-kv-invsend-submit
              ${canSubmit ? '' : 'disabled'} aria-busy="${state.saving ? 'true' : 'false'}">
        ${state.saving ? '<span class="kv-inv-spinner"></span> Verzenden…' : 'Verzenden nu'}
      </button>
    </div>`;
}

// ── Head + wrappers ────────────────────────────────────────────────────────

function renderHead() {
  const nr = state.invoice?.invoice_number || (state.invoiceId ? '#' + String(state.invoiceId).slice(0, 8) : '—');
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Factuur verzenden ${state.step === 2 ? '· stap 2 van 2' : '· stap 1 van 2'}</div>
        <div class="kv-edit-head-name kv-inv-head-title">
          <span class="mono">${esc(nr)}</span>
        </div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-invsend-close aria-label="Sluiten" ${state.saving ? 'disabled' : ''}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function renderBody() { return state.step === 2 ? renderStep2() : renderStep1(); }
function renderFoot() { return state.step === 2 ? renderStep2Foot() : renderStep1Foot(); }

// ── Validatie ──────────────────────────────────────────────────────────────

function validateStep1() {
  const errors = {};
  const email = String(state.form.recipient_email || '').trim();
  if (!email) errors.recipient_email = 'E-mailadres is verplicht';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.recipient_email = 'Ongeldig e-mailformaat';
  if (!state.form.mail_template_id) errors.mail_template_id = 'Kies een template';
  return errors;
}

// ── Submit — in-flight lock + geen auto-retry bij onduidelijke fout ───────

async function doSubmit() {
  if (state.saving || state.unknownStatus) return;    // in-flight lock — verdere klikken negeren
  if (!state.confirmChecked) return;

  state.saving = true;
  state.globalError = null;
  rerender();

  const body = {
    invoice_id:       state.invoiceId,
    mail_template_id: state.form.mail_template_id,
  };
  const emailTrim = String(state.form.recipient_email || '').trim();
  if (emailTrim && emailTrim !== (state.invoice?.customer_email || state.invoice?.customer?.email || '')) {
    body.recipient_email = emailTrim;
  }
  const subjTrim = String(state.form.subject_override || '').trim();
  const tplSubj  = String(activeTemplate()?.subject || '').trim();
  if (subjTrim && subjTrim !== tplSubj) body.subject_override = subjTrim;
  const cntTrim  = String(state.form.content_override || '').trim();
  const tplBody  = String(activeTemplate()?.body || '').trim();
  if (cntTrim && cntTrim !== tplBody) body.content_override = cntTrim;

  try {
    await K().authedJson('/api/finance-invoice-send', { method: 'POST', body: JSON.stringify(body) });
    K().toast('Factuur verzonden');
    if (typeof state.onSuccess === 'function') state.onSuccess();
    D().closeModal();
  } catch (e) {
    const msg = e?.message || '';
    // Timeout / netwerk-onbekend → status onbekend, GEEN retry-mogelijkheid tonen.
    // Endpoint is niet idempotent; dubbel-klik of retry na timeout kan 2x e-mail sturen.
    if (/timeout|network|502|503|504|Failed to fetch/i.test(msg)) {
      state.unknownStatus = true;
      state.globalError = null;
    } else {
      state.globalError = msg || 'Verzenden mislukt';
    }
    state.saving = false;
    rerender();
  }
}

// ── Wire ───────────────────────────────────────────────────────────────────

// BROK SALES-2 (v=2, 2026-08-19): idempotente bindOnce (zie invoice-create.js).
function bindOnce(node, evt, handler) {
  if (!node) return;
  const k = '__kvBound_' + evt;
  if (node[k]) return;
  node[k] = true;
  node.addEventListener(evt, handler);
}

function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;

  box.querySelectorAll('[data-kv-invsend-close], [data-kv-invsend-cancel]').forEach((b) => {
    bindOnce(b, 'click', () => { if (!state.saving) D().closeModal(); });
  });

  if (state.step === 1) {
    box.querySelectorAll('[data-kv-invsend-input]').forEach((inp) => {
      bindOnce(inp, 'input', (e) => {
        state.form[e.target.name] = e.target.value;
        if (state.errors[e.target.name]) { delete state.errors[e.target.name]; }
        // Bij template-wisseling → volledige preview refresh; anders alleen lokaal.
        if (e.target.name === 'mail_template_id') rerenderBody();
      });
    });
    bindOnce(box.querySelector('[data-kv-invsend-toggle-body]'), 'click', () => {
      state.form.showFullBody = !state.form.showFullBody;
      rerenderBody();
    });
    // Enter in stap 1 → volgende (veilig).
    bindOnce(box.querySelector('#kv-invsend-form'), 'submit', (e) => { e.preventDefault(); goNext(); });
    bindOnce(box.querySelector('[data-kv-invsend-next]'), 'click', goNext);
  } else {
    // Stap 2 — Enter geblokkeerd (geen form-submit, geen keydown-hijack nodig want geen form-el).
    bindOnce(box.querySelector('[data-kv-invsend-back]'), 'click', () => {
      if (state.saving) return;
      state.step = 1; state.confirmChecked = false; state.unknownStatus = false;
      rerender();
    });
    bindOnce(box.querySelector('[data-kv-invsend-confirm-check]'), 'change', (e) => {
      state.confirmChecked = !!e.target.checked;
      rerenderFoot();
    });
    bindOnce(box.querySelector('[data-kv-invsend-submit]'), 'click', doSubmit);
  }
}

function goNext() {
  state.errors = validateStep1();
  if (Object.keys(state.errors).length) { rerender(); return; }
  state.step = 2;
  state.confirmChecked = false;
  rerender();
}

// ── Micro-render ───────────────────────────────────────────────────────────

function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}
function rerenderBody() {
  const el = document.querySelector('#dfoModalBody');
  const ft = document.querySelector('#dfoModalFoot');
  if (el) el.innerHTML = renderBody();
  if (ft) ft.innerHTML = renderFoot();
  wire();
}
function rerenderFoot() {
  const ft = document.querySelector('#dfoModalFoot');
  if (ft) ft.innerHTML = renderFoot();
  wire();
}

// ── Public entry ──────────────────────────────────────────────────────────

/**
 * openInvoiceSendModal({ invoice, onSuccess })
 */
export function openInvoiceSendModal({ invoice, onSuccess } = {}) {
  if (!invoice?.id) { K().toast('Geen factuur om te verzenden'); return; }
  const st = invoice.display_status || invoice.status;
  if (st === 'credited') { K().toast('Gecrediteerde facturen kunnen niet worden verzonden.'); return; }
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar.'); return; }
  initState(invoice, { onSuccess });
  rerender();
  loadTemplates();
}
