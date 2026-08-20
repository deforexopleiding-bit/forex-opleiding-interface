// modules/klanten-v2/views/modals/subscription-actions.js
//
// V2 subscription-mutaties (finance-mutaties ronde). 4 openers:
//   openSubscriptionPostponeModal    — enkele postpone/verleng (POST /api/sales-subscription-postpone)
//   openSubscriptionPostponeAllModal — bulk postpone per klant (POST /api/sales-customer-postpone-all)
//   openSubscriptionUpdateModal      — aanpassen (POST /api/sales-subscription-update)
//   openSubscriptionDeleteModal      — deactiveren (POST /api/sales-subscription-delete)
//
// 1-op-1 port van v1 klanten.html:2173-2391 (openPostponeModal, openPostponeAllModal,
// openSubscriptionEditModal, deleteSubscription). Gebruikt window.DFO.openModal
// primitive + window.KV.authedJson zoals de bestaande invoice-modals.
//
// Server-side RBAC: server geeft 403 als user geen rechten heeft — we vangen
// alleen de 403 op en tonen error-banner (geen client-side gate; v2 heeft geen
// RBAC.can-helper — zie v2-modals audit).
//
// Beschermde-zone: nul aanraking. Endpoints zijn bestaand.

const K = () => window.KV;
const D = () => window.DFO;
function esc(v) { return K().esc(v); }

const EUR = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtEur(n) { if (n == null || Number.isNaN(Number(n))) return '—'; return EUR.format(Number(n)); }

// ══════════════════════════════════════════════════════════════════════════
// POSTPONE (enkele sub)
// ══════════════════════════════════════════════════════════════════════════
let _pp = null;

function _ppHead() {
  const running = !!_pp.running;
  const title = running ? 'Looptijd verlengen' : 'Abonnement uitstellen';
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Abonnement-mutatie</div>
        <div class="kv-edit-head-name">${esc(title)}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-pp-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function _ppBody() {
  const running = !!_pp.running;
  const intro = running
    ? 'Dit abonnement loopt al. De einddatum schuift vooruit en er komen extra termijnen bij — de klant betaalt dus X termijnen extra. De startdatum blijft gelijk.'
    : 'Het abonnement is nog niet gestart. Start- én einddatum schuiven beide vooruit; de looptijd blijft hetzelfde.';
  return `
    <form class="kv-edit-form" novalidate>
      ${_pp.globalError ? `<div class="kv-edit-banner">${esc(_pp.globalError)}</div>` : ''}
      <p style="font-size:12.5px;color:var(--text-2);margin:0 0 8px">${esc(intro)}</p>
      <div class="kv-edit-field ${_pp.error ? 'kv-edit-field-error' : ''}">
        <label for="kv-pp-months">Aantal maanden (1–12) <span class="kv-edit-req">*</span></label>
        <input id="kv-pp-months" type="number" min="1" max="12" step="1" value="${esc(_pp.months)}" data-kv-pp-input />
        ${_pp.error ? `<div class="kv-edit-field-msg">${esc(_pp.error)}</div>` : ''}
      </div>
    </form>`;
}
function _ppFoot() {
  const running = !!_pp.running;
  const okLabel = running ? 'Verlengen' : 'Uitstellen';
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-pp-close ${_pp.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-pp-submit ${_pp.saving ? 'disabled' : ''}>
        ${_pp.saving ? 'Bezig…' : esc(okLabel)}
      </button>
    </div>`;
}
async function _ppSave() {
  const m = Number(_pp.months);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    _pp.error = 'Vul een geheel aantal maanden 1 t/m 12 in.';
    _ppRerender();
    return;
  }
  _pp.saving = true; _pp.error = null; _pp.globalError = null;
  _ppRerender();
  try {
    const d = await K().authedJson('/api/sales-subscription-postpone', {
      method: 'POST',
      body: JSON.stringify({ subscription_id: _pp.subId, months: m }),
    });
    const verb = d?.extended ? 'Looptijd verlengd' : 'Uitgesteld';
    const tlPushed = d?.tl?.pushed;
    K().toast(tlPushed ? `${verb} + TL bijgewerkt` : `${verb} (TL niet gesynct)`);
    if (typeof _pp.onSuccess === 'function') _pp.onSuccess();
    D().closeModal();
  } catch (e) {
    _pp.globalError = e?.message || 'Uitstellen mislukt';
    _pp.saving = false;
    _ppRerender();
  }
}
function _ppWire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-pp-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-pp-submit]')?.addEventListener('click', _ppSave);
  box.querySelector('[data-kv-pp-input]')?.addEventListener('input', (e) => {
    _pp.months = e.target.value;
    if (_pp.error) { _pp.error = null; _ppRerender(); }
  });
}
function _ppRerender() { D().openModal({ head: _ppHead(), body: _ppBody(), foot: _ppFoot() }); _ppWire(); }

export function openSubscriptionPostponeModal({ sub, onSuccess } = {}) {
  if (!sub?.id) { K().toast('Geen abonnement geselecteerd'); return; }
  const st = String(sub.status || '').toLowerCase();
  const running = st === 'active' || st === 'running';
  _pp = { subId: sub.id, running, months: '1', error: null, globalError: null, saving: false, onSuccess: onSuccess || null };
  _ppRerender();
}

// ══════════════════════════════════════════════════════════════════════════
// POSTPONE ALL (bulk per klant)
// ══════════════════════════════════════════════════════════════════════════
let _ppa = null;

function _ppaHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Bulk-mutatie · ${esc(String(_ppa.count))} actieve abo's</div>
        <div class="kv-edit-head-name">Alle abonnementen uitstellen</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-ppa-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function _ppaBody() {
  return `
    <form class="kv-edit-form" novalidate>
      ${_ppa.globalError ? `<div class="kv-edit-banner">${esc(_ppa.globalError)}</div>` : ''}
      <p style="font-size:12.5px;color:var(--text-2);margin:0 0 8px">
        Dit verschuift <strong>alle ${esc(String(_ppa.count))} actieve abo's</strong> van deze klant. Reeds lopende abo's worden in looptijd verlengd; nog-niet-gestarte abo's schuiven volledig vooruit.
      </p>
      <div class="kv-edit-field ${_ppa.error ? 'kv-edit-field-error' : ''}">
        <label for="kv-ppa-months">Aantal maanden (1–12) <span class="kv-edit-req">*</span></label>
        <input id="kv-ppa-months" type="number" min="1" max="12" step="1" value="${esc(_ppa.months)}" data-kv-ppa-input />
        ${_ppa.error ? `<div class="kv-edit-field-msg">${esc(_ppa.error)}</div>` : ''}
      </div>
    </form>`;
}
function _ppaFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-ppa-close ${_ppa.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-ppa-submit ${_ppa.saving ? 'disabled' : ''}>
        ${_ppa.saving ? 'Bezig…' : 'Alle uitstellen'}
      </button>
    </div>`;
}
async function _ppaSave() {
  const m = Number(_ppa.months);
  if (!Number.isInteger(m) || m < 1 || m > 12) {
    _ppa.error = 'Vul een geheel aantal maanden 1 t/m 12 in.';
    _ppaRerender();
    return;
  }
  _ppa.saving = true; _ppa.error = null; _ppa.globalError = null;
  _ppaRerender();
  try {
    const d = await K().authedJson('/api/sales-customer-postpone-all', {
      method: 'POST',
      body: JSON.stringify({ customer_id: _ppa.customerId, months: m }),
    });
    K().toast(`${d?.ok ?? '?'} van ${d?.total ?? '?'} abo's uitgesteld${d?.failed ? ` (${d.failed} mislukt)` : ''}`);
    if (typeof _ppa.onSuccess === 'function') _ppa.onSuccess();
    D().closeModal();
  } catch (e) {
    _ppa.globalError = e?.message || 'Bulk-uitstellen mislukt';
    _ppa.saving = false;
    _ppaRerender();
  }
}
function _ppaWire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-ppa-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-ppa-submit]')?.addEventListener('click', _ppaSave);
  box.querySelector('[data-kv-ppa-input]')?.addEventListener('input', (e) => {
    _ppa.months = e.target.value;
    if (_ppa.error) { _ppa.error = null; _ppaRerender(); }
  });
}
function _ppaRerender() { D().openModal({ head: _ppaHead(), body: _ppaBody(), foot: _ppaFoot() }); _ppaWire(); }

export function openSubscriptionPostponeAllModal({ customerId, count, onSuccess } = {}) {
  if (!customerId) { K().toast('Geen klant-id'); return; }
  if (!count || count < 1) { K().toast('Geen actieve abo\'s om uit te stellen'); return; }
  _ppa = { customerId, count, months: '1', error: null, globalError: null, saving: false, onSuccess: onSuccess || null };
  _ppaRerender();
}

// ══════════════════════════════════════════════════════════════════════════
// UPDATE (aanpassen)
// ══════════════════════════════════════════════════════════════════════════
let _up = null;

function _upHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow">Abonnement-mutatie</div>
        <div class="kv-edit-head-name">Aanpassen · ${esc(_up.sub.description || 'Abonnement')}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-up-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function _upBody() {
  const s = _up.sub;
  const hasTl = !!s.teamleader_subscription_id;
  const amountReadonly = hasTl;
  const disAttr = (amountReadonly ? 'disabled' : '');
  const amountHint = hasTl
    ? '<span style="color:var(--amber, #C2700A)">Bedrag readonly — TL heeft geen amount-update endpoint. Voor bedrag-wijziging: deactiveer + maak nieuw abo via de wizard.</span>'
    : '<span style="color:var(--text-2)">Nog geen TL-koppeling; bedrag mag lokaal.</span>';
  const f = _up.form;
  return `
    <form class="kv-edit-form" novalidate>
      ${_up.globalError ? `<div class="kv-edit-banner">${esc(_up.globalError)}</div>` : ''}
      <p style="font-size:12px;color:var(--text-2);margin:0 0 10px">
        Nog geen factuur voor dit abo (${hasTl ? 'TL-gekoppeld' : 'lokaal-only'}).
      </p>
      <div class="kv-edit-field">
        <label for="kv-up-desc">Omschrijving</label>
        <input id="kv-up-desc" type="text" maxlength="500" value="${esc(f.description)}" data-kv-up-input data-key="description" />
      </div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field">
          <label for="kv-up-amt">Bedrag per termijn (excl. BTW)</label>
          <input id="kv-up-amt" type="number" step="0.01" min="0" value="${esc(f.amount)}" ${disAttr} data-kv-up-input data-key="amount" />
        </div>
        <div class="kv-edit-field">
          <label for="kv-up-vat">BTW %</label>
          <input id="kv-up-vat" type="number" step="1" min="0" max="100" value="${esc(f.vat_percentage)}" ${disAttr} data-kv-up-input data-key="vat_percentage" />
        </div>
        <div class="kv-edit-field">
          <label for="kv-up-terms">Termijnen</label>
          <input id="kv-up-terms" type="number" step="1" min="1" max="240" value="${esc(f.term_count)}" ${disAttr} data-kv-up-input data-key="term_count" />
        </div>
      </div>
      <div class="kv-edit-grid">
        <div class="kv-edit-field">
          <label for="kv-up-start">Startdatum</label>
          <input id="kv-up-start" type="date" value="${esc(f.start_date)}" data-kv-up-input data-key="start_date" />
        </div>
        <div class="kv-edit-field">
          <label for="kv-up-end">Einddatum</label>
          <input id="kv-up-end" type="date" value="${esc(f.end_date)}" data-kv-up-input data-key="end_date" />
        </div>
      </div>
      <p style="font-size:11.5px;color:var(--text-2);margin:8px 0 0">${amountHint}</p>
    </form>`;
}
function _upFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-up-close ${_up.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-up-submit ${_up.saving ? 'disabled' : ''}>
        ${_up.saving ? 'Bezig…' : 'Bevestig wijzigingen…'}
      </button>
    </div>`;
}

function _upBuildPatch() {
  const s = _up.sub;
  const f = _up.form;
  const hasTl = !!s.teamleader_subscription_id;
  const patch = {};
  const desc = String(f.description || '').trim();
  if (desc !== String(s.description || '').trim()) patch.description = desc;
  if (!hasTl) {
    const a = Number(f.amount);
    const v = Number(f.vat_percentage);
    const t = Number(f.term_count);
    if (Number.isFinite(a) && a !== Number(s.amount)) patch.amount = a;
    if (Number.isInteger(v) && v !== Number(s.vat_percentage)) patch.vat_percentage = v;
    if (Number.isInteger(t) && t !== Number(s.term_count)) patch.term_count = t;
  }
  const sd = f.start_date || '';
  const ed = f.end_date || '';
  if (sd !== (s.start_date || '')) patch.start_date = sd || null;
  if (ed !== (s.end_date || '')) patch.end_date = ed || null;
  return patch;
}

async function _upSave() {
  const patch = _upBuildPatch();
  if (Object.keys(patch).length === 0) {
    _up.globalError = 'Niets gewijzigd.';
    _upRerender();
    return;
  }
  const s = _up.sub;
  const hasTl = !!s.teamleader_subscription_id;
  const confirmMsg = 'Bevestig:\n\n'
    + Object.entries(patch).map(([k, v]) => `${k}: ${s[k] ?? '—'} → ${v ?? '—'}`).join('\n')
    + (hasTl && (patch.start_date || patch.end_date) ? '\n\nWordt naar TeamLeader gepusht.' : '');
  if (!window.confirm(confirmMsg)) return;

  _up.saving = true; _up.globalError = null;
  _upRerender();
  try {
    const resp = await K().authedFetch('/api/sales-subscription-update', {
      method: 'POST',
      body: JSON.stringify({ subscription_id: s.id, patch }),
    });
    const d = await resp.json().catch(() => ({}));
    if (resp.status === 409 && d?.code === 'HAS_INVOICES') {
      _up.globalError = 'Abo is inmiddels gefactureerd — bewerken geblokkeerd. Sluit dit dialoog en ververs de lijst.';
      _up.saving = false; _upRerender();
      return;
    }
    if (resp.status === 502 && d?.code === 'TL_SYNC_FAIL') {
      _up.globalError = 'TL-sync faalde: ' + (d?.error || 'onbekend') + '. Wijziging NIET opgeslagen.';
      _up.saving = false; _upRerender();
      return;
    }
    if (!resp.ok || !d?.ok) throw new Error(d?.error || 'HTTP ' + resp.status);
    if (d.warning) K().toast(d.warning);
    else K().toast('Abo bijgewerkt' + (d?.tl?.pushed ? ' + TL gesynced' : ''));
    if (typeof _up.onSuccess === 'function') _up.onSuccess();
    D().closeModal();
  } catch (e) {
    _up.globalError = 'Fout: ' + (e?.message || 'onbekend');
    _up.saving = false;
    _upRerender();
  }
}
function _upWire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-up-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-up-submit]')?.addEventListener('click', _upSave);
  box.querySelectorAll('[data-kv-up-input]').forEach((inp) => {
    inp.addEventListener('input', (e) => {
      const k = e.target.getAttribute('data-key');
      if (k) _up.form[k] = e.target.value;
    });
  });
}
function _upRerender() { D().openModal({ head: _upHead(), body: _upBody(), foot: _upFoot() }); _upWire(); }

// FIX-RONDE-2 G1: termijnbedrag = SOM van álle line_items (excl. BTW), niet
// alleen line_items[0]. Bij multi-rate abo's (bv. Somchai: 1350@9% + 2600@21%
// = 3950 excl. per termijn) toonde de vorige fallback €1350 — het eerste
// item — waardoor het bedrag met factor >2 miste. TL heeft geen amount-update
// endpoint dus het veld blijft read-only; alleen de weergave klopte niet.
// Fallback-order: som(line_items) → sub.amount → amount_per_termijn → amount_excl.
function _subAmountExcl(s) {
  if (s == null) return 0;
  if (Array.isArray(s.line_items) && s.line_items.length) {
    let sum = 0;
    for (const li of s.line_items) {
      const n = Number(li?.amount ?? li?.amount_excl);
      if (Number.isFinite(n)) sum += n;
    }
    if (sum > 0) return sum;
  }
  const cand = [s.amount, s.amount_per_termijn, s.amount_excl];
  for (const v of cand) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export function openSubscriptionUpdateModal({ sub, onSuccess } = {}) {
  if (!sub?.id) { K().toast('Geen abonnement geselecteerd'); return; }
  if (sub.has_any_invoice) {
    K().toast('Al gefactureerd — bewerken niet toegestaan. Gebruik crediteren + nieuw abo.');
    return;
  }
  const initAmount = _subAmountExcl(sub);
  _up = {
    sub,
    form: {
      description: sub.description || '',
      amount: initAmount ? String(initAmount) : '0',
      vat_percentage: sub.vat_percentage != null ? String(sub.vat_percentage) : '21',
      term_count: sub.term_count != null ? String(sub.term_count) : '1',
      start_date: sub.start_date || '',
      end_date: sub.end_date || '',
    },
    globalError: null, saving: false,
    onSuccess: onSuccess || null,
  };
  _upRerender();
}

// ══════════════════════════════════════════════════════════════════════════
// DELETE (deactiveren)
// ══════════════════════════════════════════════════════════════════════════
let _dl = null;

function _dlHead() {
  return `
    <div class="kv-edit-head">
      <div>
        <div class="kv-edit-head-eyebrow" style="color:var(--rose, #C22B3E)">Abonnement-mutatie · destructief</div>
        <div class="kv-edit-head-name">Deactiveren</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-dl-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function _dlBody() {
  const s = _dl.sub;
  const hasTl = !!s.teamleader_subscription_id;
  return `
    <form class="kv-edit-form" novalidate>
      ${_dl.globalError ? `<div class="kv-edit-banner">${esc(_dl.globalError)}</div>` : ''}
      <p style="font-size:13px;color:var(--text-1);margin:0 0 10px">
        Weet je zeker dat je <strong>${esc(s.description || 'dit abonnement')}</strong> wilt deactiveren?
      </p>
      <p style="font-size:12px;color:var(--text-2);margin:0 0 8px">
        Het abonnement stopt en wordt ${hasTl ? '<strong>in TeamLeader gedeactiveerd</strong>' : 'lokaal beëindigd'} (blijft in de historie staan). Termijnbedrag: ${esc(fmtEur(_subAmountExcl(s)))} excl.
      </p>
      ${_dl.tlFailed ? `<p style="font-size:12px;color:var(--rose);margin:8px 0 0"><strong>TL-deactivatie mislukte.</strong> Wil je alleen lokaal deactiveren (TL handmatig afhandelen)?</p>` : ''}
    </form>`;
}
function _dlFoot() {
  return `
    <div class="kv-edit-foot">
      <button type="button" class="ds-btn ds-btn-ghost" data-kv-dl-close ${_dl.saving ? 'disabled' : ''}>Annuleren</button>
      <button type="button" class="ds-btn ds-btn-primary" data-kv-dl-submit ${_dl.saving ? 'disabled' : ''} style="background:var(--rose, #C22B3E); border-color:var(--rose, #C22B3E)">
        ${_dl.saving ? 'Bezig…' : (_dl.tlFailed ? 'Alleen lokaal deactiveren' : 'Deactiveren')}
      </button>
    </div>`;
}
async function _dlSave() {
  _dl.saving = true; _dl.globalError = null;
  _dlRerender();
  try {
    const resp = await K().authedFetch('/api/sales-subscription-delete', {
      method: 'POST',
      body: JSON.stringify({ subscription_id: _dl.sub.id, force: !!_dl.tlFailed }),
    });
    const d = await resp.json().catch(() => ({}));
    if (resp.status === 502 && d?.tl_failed && !_dl.tlFailed) {
      _dl.tlFailed = true;
      _dl.globalError = 'TeamLeader-deactivatie mislukt: ' + (d?.tl?.error || 'onbekend');
      _dl.saving = false;
      _dlRerender();
      return;
    }
    if (!resp.ok || d?.success === false) throw new Error(d?.error || 'HTTP ' + resp.status);
    const tl = d?.tl || {};
    if (tl.deactivated) K().toast('Abonnement gedeactiveerd (lokaal + TL)');
    else if (tl.skipped) K().toast('Abonnement lokaal gedeactiveerd (geen TL-koppeling)');
    else K().toast('Lokaal gedeactiveerd, maar TL-deactivatie mislukte: ' + (tl.error || 'onbekend'));
    if (typeof _dl.onSuccess === 'function') _dl.onSuccess();
    D().closeModal();
  } catch (e) {
    _dl.globalError = 'Mislukt: ' + (e?.message || 'onbekend');
    _dl.saving = false;
    _dlRerender();
  }
}
function _dlWire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-dl-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelector('[data-kv-dl-submit]')?.addEventListener('click', _dlSave);
}
function _dlRerender() { D().openModal({ head: _dlHead(), body: _dlBody(), foot: _dlFoot() }); _dlWire(); }

export function openSubscriptionDeleteModal({ sub, onSuccess } = {}) {
  if (!sub?.id) { K().toast('Geen abonnement geselecteerd'); return; }
  _dl = { sub, saving: false, globalError: null, tlFailed: false, onSuccess: onSuccess || null };
  _dlRerender();
}
