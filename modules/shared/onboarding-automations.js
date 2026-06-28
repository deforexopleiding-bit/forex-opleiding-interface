/* modules/shared/onboarding-automations.js
 *
 * Onboarding-automations editor — mountable module (extractie van
 * modules/onboarding-automations.html).
 *
 * Public API:
 *   window.OnboardingAutomations.mount({ host: HTMLElement })
 *
 * Bevat de complete editor zoals voorheen op onboarding-automations.html:
 *   - Lijst van automations met enabled-toggle (LIVE sends)
 *   - Editor: trigger / steps / condities / enrollment
 *   - Tester-modal (is_test=true, maakt test-onboarding + test-customer)
 *   - Runs-modal: runs-historie + per-run step-uitkomsten
 *
 * Endpoints (alle ongewijzigd, byte-voor-byte):
 *   GET  /api/onboarding-automations-list
 *   POST /api/onboarding-automation-save       (LIVE — toggle/save)
 *   POST /api/onboarding-automation-delete
 *   POST /api/onboarding-automation-test       (LIVE — start test-run)
 *   GET  /api/onboarding-automation-runs?automation_id=... | ?run_id=...
 *   GET  /api/onboarding-whatsapp-templates-list
 *   GET  /api/onboarding-trajecten-list        (tester traject-dropdown)
 *
 * RBAC:
 *   - onboarding.automation.view   (page-gate; hub doet ensurePermissionsLoaded
 *     vóór de gate, defense-in-depth-check in init() blijft staan).
 *   - onboarding.automation.edit   (save/delete/toggle/test/edit-knoppen).
 *   Server blijft autoritatief op alle endpoints.
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets. Volgt
 * het patroon van modules/shared/onboarding-wizard.js + onboarding-overzicht.js
 * + finance-klanten.js (IIFE + __loaded-guard + single mount() entrypoint).
 *
 * Crumb-fix: de "← Terug naar Onboarding"-link uit de standalone-pagina
 * is verwijderd — in de hub is dit een sectie, geen "terug naar"-context.
 *
 * Modal-aanpak: runsModal + automationTestModal worden bij mount eenmalig
 * aan document.body geappend (position:fixed; niet afhankelijk van de
 * display:none-state van de hub-sectie wrapper).
 *
 * Globals genamespaced: alle module-scope vars + functies binnen IIFE.
 * Onclick-handlers in MODAL_HTML (closeRunsModal, closeTestModal,
 * backToRunsList, submitTestRun) blijven werken doordat de oorspronkelijke
 * code zelf al window.X = X exports definieert (regels 1115, 1116, 1176,
 * 1223 in het origineel; binnen IIFE worden die expliciete window-exports
 * de enige publieke entry-points).
 */
(function () {
  if (window.OnboardingAutomations && window.OnboardingAutomations.__loaded) return;

  let _mountedHost = null;

  // De host-div wordt eenmalig geprefixed met <div id="page-content"></div>
  // zodat alle bestaande document.getElementById('page-content') calls in
  // de geporteerde script-body identiek blijven werken.
  const HOST_HTML = '<div class="app-inner" id="page-content"></div>';

  // Runs-modal + Tester-modal worden naar document.body geappend zodat
  // ze niet wegvallen wanneer de Automations-sectie display:none krijgt.
  // Onclick-attrs gebruiken de window-exports onderaan deze module.
  const MODAL_HTML =
    '<div class="modal-overlay hidden" id="runsModal" role="dialog" aria-modal="true">' +
      '<div class="modal-card">' +
        '<div class="modal-header">' +
          '<div class="modal-title" id="runsModalTitle">Run-historie</div>' +
          '<button class="modal-close" type="button" onclick="closeRunsModal()">&#x2715;</button>' +
        '</div>' +
        '<div class="modal-body" id="runsModalBody"></div>' +
        '<div class="modal-footer">' +
          '<button class="btn-secondary" type="button" id="runsBackBtn" style="display:none" onclick="backToRunsList()"><i class="ti ti-arrow-left"></i> Terug</button>' +
          '<button class="btn-secondary" type="button" onclick="closeRunsModal()">Sluiten</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-overlay hidden" id="automationTestModal" role="dialog" aria-modal="true">' +
      '<div class="modal-card" style="max-width:520px">' +
        '<div class="modal-header">' +
          '<div class="modal-title">Automation testen</div>' +
          '<button class="modal-close" type="button" onclick="closeTestModal()">&#x2715;</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div id="automationTestBanner" style="display:none;margin-bottom:10px;padding:8px 12px;border-radius:6px;font-size:12px;white-space:pre-wrap"></div>' +
          '<div style="font-size:12.5px;color:var(--text-dim);margin-bottom:10px">' +
            'Maakt een test-klant + test-onboarding (<code>is_test=true</code>) aan en triggert deze automation direct. Wait-stappen versnellen naar 15s. Test-rijen verschijnen NIET in de gewone onboarding-lijst.' +
          '</div>' +
          '<div class="form-field"><label>Volledige naam <span class="req">*</span></label><input id="atName" type="text" value="Jeffrey Test" maxlength="80" /></div>' +
          '<div class="form-field"><label>E-mail <span class="req">*</span></label><input id="atEmail" type="email" placeholder="jij@example.com" /></div>' +
          '<div class="form-field"><label>Telefoon (E.164) <span class="req">*</span></label><input id="atPhone" type="tel" placeholder="+31612345678" /><div class="form-help">E.164-formaat: +31&hellip; (geen spaties / streepjes).</div></div>' +
          '<div class="form-field"><label>Traject <span class="req">*</span></label><select id="atTraject"><option value="">Laden&hellip;</option></select><div class="form-help">Test-onboarding krijgt dit traject (wordt door de wizard NIET echt doorlopen).</div></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn-secondary" type="button" onclick="closeTestModal()">Annuleer</button>' +
          '<button class="btn-primary" type="button" id="atStartBtn" onclick="submitTestRun()"><i class="ti ti-flask"></i> Start test</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  function injectStyles() {
    if (document.getElementById('onboarding-automations-styles')) return;
    const style = document.createElement('style');
    style.id = 'onboarding-automations-styles';
    style.textContent = ONBOARDING_AUTOMATIONS_STYLES;
    document.head.appendChild(style);
  }

  function ensureModalsInBody() {
    if (document.getElementById('runsModal')) return;
    const div = document.createElement('div');
    div.id = 'onboarding-automations-modals-mount';
    div.innerHTML = MODAL_HTML;
    document.body.appendChild(div);
  }

  const ONBOARDING_AUTOMATIONS_STYLES = String.raw`
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; -webkit-font-smoothing: antialiased; }
    .app { margin-left: 220px; padding: 24px 28px 60px; max-width: 1100px; }

    .crumb { font-size: 12px; color: var(--text-faint); margin-bottom: 8px; }
    .crumb a { color: var(--brand-secondary-light, #688b9b); text-decoration: none; }
    .crumb a:hover { text-decoration: underline; }

    .page-head { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; padding-bottom: 14px; border-bottom: 1px solid var(--border); margin-bottom: 18px; }
    .page-title { font-size: 22px; font-weight: 800; letter-spacing: -.3px; }
    .page-sub { font-size: 13px; color: var(--text-dim); margin-top: 4px; }
    .page-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }

    .btn-primary { background: var(--brand-primary, #093d54); color: #fff; border: none; padding: 7px 13px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; text-decoration:none; }
    .btn-primary:hover { opacity: .9; }
    .btn-primary:disabled { opacity: .5; cursor: not-allowed; }
    .btn-secondary { background: var(--bg-elev); color: var(--text-dim); border: 1px solid var(--border); padding: 7px 13px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; text-decoration:none; }
    .btn-secondary:hover { background: var(--bg-elev-2); color: var(--text); }
    .btn-danger { background: var(--red, #dc2626); color: #fff; border: none; padding: 7px 13px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 6px; }
    .btn-danger:hover { opacity: .9; }
    .btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text-dim); padding: 5px 10px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; display: inline-flex; align-items: center; gap: 5px; }
    .btn-ghost:hover { background: var(--bg-elev-2); color: var(--text); }

    .a-list { display: grid; gap: 12px; }
    .a-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start; }
    .a-name { font-size: 15px; font-weight: 700; margin-bottom: 2px; }
    .a-desc { font-size: 12.5px; color: var(--text-dim); margin-bottom: 8px; }
    .a-meta { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--text-dim); }
    .a-meta .it { display: inline-flex; align-items: center; gap: 5px; }
    .a-meta .it i { color: var(--text-faint); }
    .a-badge { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; background: var(--bg-elev-2); color: var(--text-dim); border: 1px solid var(--border); }
    .a-badge.enroll-new { background: rgba(5,150,105,0.12); color:#059669; border-color: rgba(5,150,105,0.25); }
    .a-badge.enroll-incl { background: rgba(245,158,11,0.15); color:#b45309; border-color: rgba(245,158,11,0.3); }
    .a-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .a-actions .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-dim); }

    .toggle { position: relative; width: 36px; height: 20px; background: var(--bg-elev-2); border-radius: 99px; cursor: pointer; transition: background .15s; border: 1px solid var(--border); }
    .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: #fff; border-radius: 50%; transition: left .15s; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
    .toggle.on { background: var(--brand-primary, #093d54); border-color: var(--brand-primary, #093d54); }
    .toggle.on::after { left: 18px; }
    .toggle.busy { opacity: .5; cursor: wait; }

    .empty-state { padding: 60px 20px; text-align: center; color: var(--text-faint); font-size: 13px; background: var(--bg-elev); border: 1px dashed var(--border); border-radius: 12px; }
    .empty-state .empty-icon { font-size: 36px; margin-bottom: 12px; opacity: .55; }
    .empty-state .empty-title { font-size: 14px; font-weight: 600; color: var(--text-dim); margin-bottom: 4px; }

    .forbidden-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 32px 28px; max-width: 480px; margin: 40px auto; text-align: center; }
    .forbidden-card h2 { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
    .forbidden-card p { font-size: 13px; color: var(--text-dim); margin-bottom: 16px; }
    .forbidden-card a { color: var(--brand-secondary-light, #688b9b); text-decoration: none; font-size: 13px; font-weight: 500; }
    .forbidden-card a:hover { text-decoration: underline; }

    .editor-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 12px; padding: 20px 22px; }
    .editor-section { margin-bottom: 18px; }
    .editor-section h3 { font-size: 12px; font-weight: 700; color: var(--text-faint); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px; }
    .form-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
    .form-field label { font-size: 12px; font-weight: 500; color: var(--text-faint); }
    .form-field label .req { color: #ef4444; }
    .form-field input, .form-field textarea, .form-field select { padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 13px; font-family: inherit; }
    .form-field input:focus, .form-field textarea:focus, .form-field select:focus { outline: none; border-color: var(--brand-primary, #093d54); }
    .form-field textarea { resize: vertical; min-height: 80px; }
    .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .form-help { font-size: 11.5px; color: var(--text-faint); margin-top: 2px; }
    .radio-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .radio-row label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text); cursor: pointer; }
    .radio-row input[type=radio] { accent-color: var(--brand-primary, #093d54); }

    .steps-list { display: grid; gap: 10px; margin-bottom: 12px; }
    .step-card { background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; position: relative; }
    .step-card .step-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
    .step-card .step-type { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: .04em; }
    .step-card .step-type i { color: var(--brand-primary, #093d54); font-size: 14px; }
    .step-card .step-tools { display: flex; gap: 4px; }
    .step-tool { background: transparent; border: 1px solid var(--border); color: var(--text-faint); cursor: pointer; padding: 3px 7px; border-radius: 6px; font-size: 12px; font-family: inherit; }
    .step-tool:hover { background: var(--bg-elev); color: var(--text); }
    .step-tool.danger:hover { color: var(--red, #dc2626); border-color: rgba(220,38,38,0.4); }
    .step-tool:disabled { opacity: .4; cursor: not-allowed; }
    .step-add-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
    .step-add-row .step-add-label { font-size: 12px; color: var(--text-faint); margin-right: 4px; }

    .var-picker { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; margin-top: 6px; }
    .var-picker .vp-group { margin-bottom: 6px; }
    .var-picker .vp-group:last-child { margin-bottom: 0; }
    .var-picker .vp-label { font-size: 10.5px; font-weight: 700; color: var(--text-faint); text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px; }
    .var-picker .vp-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .vp-chip { padding: 3px 9px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 99px; font-size: 11.5px; cursor: pointer; color: var(--text); font-family: inherit; line-height: 1.3; }
    .vp-chip:hover { background: var(--bg-elev-2); }

    .editor-footer { display: flex; justify-content: space-between; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border); margin-top: 8px; }
    .editor-footer .right { display: flex; gap: 8px; }
    .editor-banner { padding: 10px 12px; margin-bottom: 12px; background: rgba(239,68,68,0.1); border: 1px solid #ef4444; border-radius: 8px; color: #ef4444; font-size: 13px; display: none; }
    .editor-banner.visible { display: block; }

    /* Modal — gedeeld door Runs-modal (Fase 3a) + Tester-modal (Fase 3b).
       Default max-width 760px is groot genoeg voor de Runs-tabel; de Tester-
       modal overschrijft 'm inline op de .modal-card-div naar 520px. */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 500; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); padding: 20px; }
    .modal-overlay.hidden { display: none !important; }
    .modal-card { background: var(--bg-elev); border: 1px solid var(--border); border-radius: 14px; width: 100%; max-width: 760px; max-height: calc(100vh - 40px); display: flex; flex-direction: column; }
    .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border); }
    .modal-title { font-size: 15px; font-weight: 700; }
    .modal-close { background: transparent; border: none; color: var(--text-faint); font-size: 18px; cursor: pointer; padding: 4px; line-height: 1; }
    .modal-body { padding: 18px 20px; overflow-y: auto; }
    .modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 20px; border-top: 1px solid var(--border); }

    /* Runs-modal styling (Fase 3a) */
    .runs-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
    .runs-table th { text-align: left; font-weight: 600; color: var(--text-faint); padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .runs-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); color: var(--text); }
    .runs-table tr:last-child td { border-bottom: none; }
    .runs-table tr.clickable { cursor: pointer; }
    .runs-table tr.clickable:hover td { background: var(--bg-elev-2); }
    .runs-status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
    .runs-status.active     { background: rgba(245,158,11,0.15); color:#b45309; }
    .runs-status.completed  { background: rgba(5,150,105,0.15); color:#059669; }
    .runs-status.exited     { background: var(--bg-elev-2); color: var(--text-faint); border: 1px solid var(--border); }
    .runs-status.cancelled  { background: rgba(148,163,184,0.2); color: var(--text-faint); }
    .runs-status.failed     { background: rgba(220,38,38,0.15); color:#b91c1c; }

    .log-list { display: grid; gap: 8px; font-size: 12.5px; }
    .log-row { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 11px; }
    .log-row .log-head { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; font-weight: 600; color: var(--text); }
    .log-row .log-idx { display: inline-block; min-width: 22px; padding: 1px 6px; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 10px; font-size: 10.5px; font-weight: 700; text-align: center; color: var(--text-faint); }
    .log-row .log-type { color: var(--brand-primary, #093d54); }
    .log-row .log-ts { margin-left: auto; font-size: 11px; color: var(--text-faint); font-weight: 500; }
    .log-row pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; color: var(--text-dim); margin-top: 4px; }


    @media (max-width: 880px) {
      .app { margin-left: 0; padding: 14px; }
      .form-row-2 { grid-template-columns: 1fr; }
      .a-card { grid-template-columns: 1fr; }
      .a-actions { justify-content: flex-start; }
    }
  </style>

  `;

  // ──────────────────────────────────────────────────────────────────────────
  // Verbatim port van het script-body uit onboarding-automations.html.
  // Originele DOMContentLoaded-IIFE-init is vervangen door een named init()
  // die mount() aanroept (zie onderaan). Crumb-link is verwijderd — in de
  // hub is dit een sectie, geen "terug"-context.
  // ──────────────────────────────────────────────────────────────────────────

// ── Constants ────────────────────────────────────────────────────────────────
const TRIGGER_LABELS = {
  on_onboarding_created:       'Bij aanmelden',
  on_wizard_completed:         'Wizard afgerond',
  time_after_signup:           'Tijd na aanmelden',
  on_wizard_not_started_after: 'Wizard niet gestart na…',
  on_first_call_in:            'Vóór eerste call',
};
const ENROLL_LABELS = {
  new_only:          'Alleen nieuwe',
  include_existing:  'Ook bestaande',
};
const COND_CHECK_LABELS = {
  wizard_not_started:    'Wizard niet gestart',
  wizard_completed:      'Wizard afgerond',
  no_inbound:            'Heeft niet gereageerd',
  invoice_unpaid:        'Factuur onbetaald',
  traject_is_1op1:       'Traject is 1-op-1',
  traject_is_membership: 'Traject is membership',
};
const COND_FAIL_LABELS = { exit: 'Stoppen', skip_to_end: 'Door naar einde' };
const WAIT_UNIT_LABELS = { minutes: 'minuten', hours: 'uren', days: 'dagen' };
const ONBOARDING_STATUSES = [
  ['aangemeld',    'Aangemeld'],
  ['bezig',        'Bezig'],
  ['afgerond',     'Afgerond'],
  ['gearchiveerd', 'Gearchiveerd'],
];

// Variabelen-picker — alleen de keys die de send-pipeline ondersteunt.
// `onboarding.wizard_link` komt uit de helper sendOnboardingTemplateGeneric
// (vars-resolver) of uit de simpele tekst-substitution in send_email.
const CUSTOMER_VARS = [
  { key: 'klant.voornaam',   label: 'Voornaam' },
  { key: 'klant.achternaam', label: 'Achternaam' },
  { key: 'klant.email',      label: 'E-mail' },
];
const ONBOARDING_VARS = [
  { key: 'onboarding.wizard_link', label: 'Wizard-link' },
];

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  view: 'list',           // 'list' | 'editor'
  automations: [],
  waTemplates: [],
  waTemplatesLoaded: false,
  waTemplatesError: null,
  editing: null,
  saving: false,
  lastFocusedFieldId: null,
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toastErr(msg) {
  try { window.AgentShared?.showToast?.(msg, 'error'); } catch { alert(msg); }
}
function toastOk(msg) {
  try { window.AgentShared?.showToast?.(msg, 'success'); } catch {}
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function can(key) { return window.RBAC?.canSync?.(key) || false; }

// ── Boot ─────────────────────────────────────────────────────────────────────
// IIFE-init verwijderd — vervangen door mount()->init() in onboarding-automations.js wrapper.

// ── Data-loaders ─────────────────────────────────────────────────────────────
async function loadAutomations() {
  const r = await window.AgentShared.apiFetch('/api/onboarding-automations-list');
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error || 'list failed');
  state.automations = Array.isArray(data.automations) ? data.automations : [];
}

// Cache goedgekeurde WhatsApp-templates voor de send_whatsapp-stap-editor.
async function loadWaTemplatesForEditor() {
  if (state.waTemplatesLoaded) return;
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-whatsapp-templates-list');
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      state.waTemplatesError = data?.error || ('HTTP ' + r.status);
      state.waTemplates = [];
    } else {
      state.waTemplates = Array.isArray(data.items) ? data.items : [];
      state.waTemplatesError = null;
    }
  } catch (e) {
    console.error('[onboarding-automations] wa-templates load:', e?.message || e);
    state.waTemplatesError = e?.message || 'fetch failed';
    state.waTemplates = [];
  }
  state.waTemplatesLoaded = true;
}

// ── List view ────────────────────────────────────────────────────────────────
function summarizeTrigger(a) {
  const cfg = a.trigger_config || {};
  if (a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after') {
    const hours = Number(cfg.hours_after_signup) || 0;
    const days  = Number(cfg.days_after_signup)  || 0;
    const parts = [];
    if (days > 0)  parts.push(days + ' ' + (days  === 1 ? 'dag'  : 'dagen'));
    if (hours > 0) parts.push(hours + ' ' + (hours === 1 ? 'uur' : 'uur'));
    const tijd = parts.length ? parts.join(' + ') : '—';
    return (TRIGGER_LABELS[a.trigger_type] || a.trigger_type) + ': ' + tijd;
  }
  if (a.trigger_type === 'on_first_call_in') {
    const d = Number(cfg.days_before_call);
    const dn = Number.isFinite(d) ? d : 0;
    const tijd = dn + ' ' + (dn === 1 ? 'dag' : 'dagen');
    return (TRIGGER_LABELS[a.trigger_type] || a.trigger_type) + ': ' + tijd;
  }
  return TRIGGER_LABELS[a.trigger_type] || a.trigger_type;
}
function summarizeSteps(a) {
  const steps = Array.isArray(a.steps) ? a.steps : [];
  return `${steps.length} ${steps.length === 1 ? 'stap' : 'stappen'}`;
}
function enrollBadge(a) {
  if (a.enroll_mode === 'include_existing') return `<span class="a-badge enroll-incl">${esc(ENROLL_LABELS.include_existing)}</span>`;
  return `<span class="a-badge enroll-new">${esc(ENROLL_LABELS.new_only)}</span>`;
}

function renderList() {
  state.view = 'list';
  const canEdit = can('onboarding.automation.edit');
  const list = state.automations;
  const cards = list.map((a) => `
    <div class="a-card" data-aid="${esc(a.id)}">
      <div class="a-body">
        <div class="a-name">${esc(a.name || '(zonder naam)')}</div>
        ${a.description ? `<div class="a-desc">${esc(a.description)}</div>` : ''}
        <div class="a-meta">
          <span class="it"><i class="ti ti-bolt"></i> ${esc(summarizeTrigger(a))}</span>
          <span class="it"><i class="ti ti-list-numbers"></i> ${esc(summarizeSteps(a))}</span>
          ${enrollBadge(a)}
        </div>
      </div>
      <div class="a-actions">
        <span class="switch">
          <span class="toggle ${a.enabled ? 'on' : ''}" data-toggle="${esc(a.id)}" title="${a.enabled ? 'Aan — klik om uit te zetten' : 'Uit — klik om aan te zetten'}"></span>
          <span>${a.enabled ? 'Aan' : 'Uit'}</span>
        </span>
        <button class="btn-ghost" type="button" data-act="runs" data-aid="${esc(a.id)}"><i class="ti ti-history"></i> Runs</button>
        ${canEdit ? `<button class="btn-ghost" type="button" data-act="test" data-aid="${esc(a.id)}" title="Trigger een test-run met fake gegevens"><i class="ti ti-flask"></i> Test</button>` : ''}
        ${canEdit ? `<button class="btn-secondary" type="button" data-act="edit" data-aid="${esc(a.id)}"><i class="ti ti-edit"></i> Bewerken</button>` : ''}
        ${canEdit ? `<button class="btn-danger" type="button" data-act="delete" data-aid="${esc(a.id)}"><i class="ti ti-trash"></i></button>` : ''}
      </div>
    </div>
  `).join('');

  const empty = `
    <div class="empty-state">
      <div class="empty-icon"><i class="ti ti-robot"></i></div>
      <div class="empty-title">Nog geen automations</div>
      <div>Maak er een en stuur klanten automatisch de juiste mail of WhatsApp op het juiste moment.</div>
    </div>`;

  document.getElementById('page-content').innerHTML = `
    <div class="page-head">
      <div>
        <div class="page-title">Onboarding-automations</div>
        <div class="page-sub">Configureer automatische mail- en WhatsApp-flows rond onboardings.</div>
      </div>
      <div class="page-actions">
        ${canEdit ? `<button class="btn-primary" type="button" data-act="new"><i class="ti ti-plus"></i> Nieuwe automation</button>` : ''}
      </div>
    </div>
    ${list.length === 0 ? empty : `<div class="a-list">${cards}</div>`}
  `;

  document.getElementById('page-content').addEventListener('click', onListClick);
}

async function onListClick(ev) {
  const t = ev.target.closest('[data-act], [data-toggle]');
  if (!t) return;
  if (t.dataset.act === 'new') return startEditor(null);
  if (t.dataset.act === 'edit') { const a = state.automations.find((x) => x.id === t.dataset.aid); if (a) startEditor(a); return; }
  if (t.dataset.act === 'delete') return deleteAutomation(t.dataset.aid);
  if (t.dataset.act === 'runs')   return openRunsModal(t.dataset.aid);
  if (t.dataset.act === 'test')   return openTestModal(t.dataset.aid);
  if (t.dataset.toggle) return toggleEnabled(t.dataset.toggle, t);
}

// ── Toggle enable (PATCH via save) ───────────────────────────────────────────
async function toggleEnabled(automationId, toggleEl) {
  const a = state.automations.find((x) => x.id === automationId);
  if (!a) return;
  if (!can('onboarding.automation.edit')) { toastErr('Geen rechten (onboarding.automation.edit)'); return; }
  toggleEl.classList.add('busy');
  const payload = {
    id: a.id, name: a.name, description: a.description,
    enabled: !a.enabled,
    trigger_type: a.trigger_type, trigger_config: a.trigger_config || {},
    enroll_mode: a.enroll_mode, steps: a.steps || [],
  };
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-save', { method: 'POST', body: JSON.stringify(payload) });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'save failed');
    a.enabled    = !!data.automation?.enabled;
    a.enabled_at = data.automation?.enabled_at ?? a.enabled_at;
    toastOk(a.enabled ? 'Automation aan' : 'Automation uit');
    renderList();
  } catch (e) {
    toastErr('Bijwerken mislukt: ' + (e?.message || e));
  } finally {
    toggleEl.classList.remove('busy');
  }
}

// ── Delete ───────────────────────────────────────────────────────────────────
async function deleteAutomation(id) {
  const a = state.automations.find((x) => x.id === id);
  if (!a) return;
  if (!can('onboarding.automation.edit')) { toastErr('Geen rechten (onboarding.automation.edit)'); return; }
  if (!confirm(`Weet je zeker dat je "${a.name}" wilt verwijderen?\n\nLopende runs van deze automation worden ook verwijderd.`)) return;
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-delete', { method: 'POST', body: JSON.stringify({ id }) });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'delete failed');
    state.automations = state.automations.filter((x) => x.id !== id);
    toastOk('Verwijderd');
    renderList();
  } catch (e) {
    toastErr('Verwijderen mislukt: ' + (e?.message || e));
  }
}

// ── Editor view ──────────────────────────────────────────────────────────────
function defaultEditing() {
  return {
    id: null, name: '', description: '',
    enabled: false,
    trigger_type: 'on_onboarding_created',
    trigger_config: {},
    enroll_mode: 'new_only',
    steps: [],
  };
}
function cloneEditing(a) {
  return JSON.parse(JSON.stringify({
    id: a.id || null, name: a.name || '', description: a.description || '',
    enabled: !!a.enabled,
    trigger_type: a.trigger_type || 'on_onboarding_created',
    trigger_config: a.trigger_config && typeof a.trigger_config === 'object' ? a.trigger_config : {},
    enroll_mode: a.enroll_mode || 'new_only',
    steps: Array.isArray(a.steps) ? a.steps : [],
  }));
}

async function startEditor(a) {
  if (!can('onboarding.automation.edit')) { toastErr('Geen rechten (onboarding.automation.edit)'); return; }
  state.editing = a ? cloneEditing(a) : defaultEditing();
  // Best-effort: WhatsApp-templates voor send_whatsapp-stap-dropdown.
  await loadWaTemplatesForEditor();
  renderEditor();
}

function renderEditor() {
  state.view = 'editor';
  const a = state.editing;
  const isEdit = !!a.id;

  document.getElementById('page-content').innerHTML = `
    <div class="crumb"><a href="#" data-act="back-list">&larr; Terug naar lijst</a></div>
    <div class="page-head">
      <div>
        <div class="page-title">${isEdit ? 'Automation bewerken' : 'Nieuwe automation'}</div>
        <div class="page-sub">${isEdit ? esc(a.name || '') : 'Configureer trigger en stappen.'}</div>
      </div>
    </div>

    <div class="editor-card">
      <div class="editor-banner" id="editorBanner"></div>

      <div class="editor-section">
        <h3>Algemeen</h3>
        <div class="form-field">
          <label>Naam <span class="req">*</span></label>
          <input type="text" id="fName" maxlength="255" value="${esc(a.name)}" />
        </div>
        <div class="form-field">
          <label>Omschrijving</label>
          <textarea id="fDesc" rows="2" maxlength="2000">${esc(a.description || '')}</textarea>
        </div>
      </div>

      <div class="editor-section">
        <h3>Trigger</h3>
        <div class="form-field">
          <label>Wanneer start deze automation? <span class="req">*</span></label>
          <select id="fTrigger">
            <option value="on_onboarding_created"       ${a.trigger_type === 'on_onboarding_created' ? 'selected' : ''}>Bij aanmelden</option>
            <option value="on_wizard_completed"         ${a.trigger_type === 'on_wizard_completed'   ? 'selected' : ''}>Wizard afgerond</option>
            <option value="time_after_signup"           ${a.trigger_type === 'time_after_signup'     ? 'selected' : ''}>Tijd na aanmelden</option>
            <option value="on_wizard_not_started_after" ${a.trigger_type === 'on_wizard_not_started_after' ? 'selected' : ''}>Wizard niet gestart na…</option>
            <option value="on_first_call_in" ${a.trigger_type === 'on_first_call_in' ? 'selected' : ''}>Vóór eerste call…</option>
          </select>
        </div>
        <div id="fTriggerExtra"></div>
      </div>

      <div class="editor-section">
        <h3>Enrollment</h3>
        <div class="radio-row">
          <label><input type="radio" name="fEnroll" value="new_only"         ${a.enroll_mode === 'new_only'         ? 'checked' : ''}> Alleen nieuwe onboardings</label>
          <label><input type="radio" name="fEnroll" value="include_existing" ${a.enroll_mode === 'include_existing' ? 'checked' : ''}> Ook bestaande onboardings</label>
        </div>
        <div class="form-help">"Alleen nieuwe" filtert op gebeurtenissen na het moment dat de automation aan ging.</div>
      </div>

      <div class="editor-section">
        <h3>Stappen</h3>
        <div class="steps-list" id="stepsList"></div>
        <div class="step-add-row">
          <span class="step-add-label">Stap toevoegen:</span>
          <button class="btn-ghost" type="button" data-add="wait"><i class="ti ti-hourglass"></i> Wacht</button>
          <button class="btn-ghost" type="button" data-add="condition"><i class="ti ti-git-branch"></i> Conditie</button>
          <button class="btn-ghost" type="button" data-add="send_email"><i class="ti ti-mail"></i> Stuur e-mail</button>
          <button class="btn-ghost" type="button" data-add="send_whatsapp"><i class="ti ti-brand-whatsapp"></i> Stuur WhatsApp</button>
          <button class="btn-ghost" type="button" data-add="update_onboarding_status"><i class="ti ti-user-check"></i> Status wijzigen</button>
          <button class="btn-ghost" type="button" data-add="send_internal_notification"><i class="ti ti-bell"></i> Interne melding</button>
        </div>
      </div>

      <div class="editor-footer">
        <button class="btn-secondary" type="button" data-act="cancel-editor"><i class="ti ti-arrow-left"></i> Annuleren</button>
        <div class="right">
          <button class="btn-primary" type="button" data-act="save" id="btnSave"><i class="ti ti-device-floppy"></i> Opslaan</button>
        </div>
      </div>
    </div>
  `;

  renderTriggerExtra();
  renderSteps();

  document.getElementById('fTrigger').addEventListener('change', (e) => {
    a.trigger_type = e.target.value;
    // Defaults voor time-based triggers.
    if ((a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after')
        && !(Number(a.trigger_config?.hours_after_signup) > 0 || Number(a.trigger_config?.days_after_signup) > 0)) {
      a.trigger_config = { days_after_signup: 1 };
    }
    if (a.trigger_type === 'on_first_call_in'
        && !(Number.isFinite(Number(a.trigger_config?.days_before_call)))) {
      a.trigger_config = { days_before_call: 1 };
    }
    if (a.trigger_type === 'on_onboarding_created' || a.trigger_type === 'on_wizard_completed') {
      a.trigger_config = {};
    }
    renderTriggerExtra();
  });
  document.querySelectorAll('input[name=fEnroll]').forEach((r) => {
    r.addEventListener('change', (e) => { a.enroll_mode = e.target.value; });
  });

  document.getElementById('page-content').addEventListener('click', onEditorClick);
}

function renderTriggerExtra() {
  const a = state.editing;
  const host = document.getElementById('fTriggerExtra');
  if (a.trigger_type === 'on_first_call_in') {
    const d = Number(a.trigger_config?.days_before_call);
    const val = Number.isFinite(d) ? d : 1;
    host.innerHTML = `
      <div class="form-field">
        <label>Dagen vóór de eerste call</label>
        <input type="number" id="fDaysBeforeCall" min="0" step="1" value="${val}" />
      </div>`;
    function syncFC() {
      const v = Math.max(0, Math.floor(Number(document.getElementById('fDaysBeforeCall')?.value) || 0));
      a.trigger_config = { days_before_call: v };
    }
    document.getElementById('fDaysBeforeCall').addEventListener('input', syncFC);
    return;
  }
  if (a.trigger_type !== 'time_after_signup' && a.trigger_type !== 'on_wizard_not_started_after') {
    host.innerHTML = '';
    return;
  }
  const hours = Number(a.trigger_config?.hours_after_signup) || 0;
  const days  = Number(a.trigger_config?.days_after_signup)  || 0;
  host.innerHTML = `
    <div class="form-row-2">
      <div class="form-field">
        <label>Dagen na aanmelden</label>
        <input type="number" id="fDaysAfterSignup" min="0" step="1" value="${days}" />
      </div>
      <div class="form-field">
        <label>Uren na aanmelden</label>
        <input type="number" id="fHoursAfterSignup" min="0" step="1" value="${hours}" />
      </div>
    </div>
    <div class="form-help">Minstens één van beide moet groter dan 0 zijn. Beide tellen op (bv. 1 dag + 12 uur = 36 uur).</div>
  `;
  function sync() {
    const dEl = document.getElementById('fDaysAfterSignup');
    const hEl = document.getElementById('fHoursAfterSignup');
    const d = Math.max(0, Math.floor(Number(dEl?.value) || 0));
    const h = Math.max(0, Math.floor(Number(hEl?.value) || 0));
    const cfg = {};
    if (d > 0) cfg.days_after_signup  = d;
    if (h > 0) cfg.hours_after_signup = h;
    a.trigger_config = cfg;
  }
  document.getElementById('fDaysAfterSignup').addEventListener('input', sync);
  document.getElementById('fHoursAfterSignup').addEventListener('input', sync);
}

// ── Steps editor ─────────────────────────────────────────────────────────────
function renderSteps() {
  const a = state.editing;
  const host = document.getElementById('stepsList');
  if (!host) return;
  const steps = a.steps || [];
  if (steps.length === 0) {
    host.innerHTML = `<div class="empty-state" style="padding:24px 12px">
      <div>Nog geen stappen. Voeg er een toe hieronder.</div>
    </div>`;
    return;
  }
  host.innerHTML = steps.map((s, idx) => renderStepCard(s, idx, steps.length)).join('');
}

function renderStepCard(s, idx, total) {
  const head = `
    <div class="step-head">
      <span class="step-type">${stepIcon(s.type)} Stap ${idx + 1} · ${stepTypeLabel(s.type)}</span>
      <div class="step-tools">
        <button class="step-tool" type="button" data-step-act="up"   data-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Omhoog"><i class="ti ti-chevron-up"></i></button>
        <button class="step-tool" type="button" data-step-act="down" data-idx="${idx}" ${idx === total - 1 ? 'disabled' : ''} title="Omlaag"><i class="ti ti-chevron-down"></i></button>
        <button class="step-tool danger" type="button" data-step-act="remove" data-idx="${idx}" title="Verwijderen"><i class="ti ti-x"></i></button>
      </div>
    </div>`;
  let body = '';
  if (s.type === 'wait') {
    const c = s.config || {};
    body = `
      <div class="form-row-2">
        <div class="form-field">
          <label>Wacht hoeveel?</label>
          <input type="number" min="1" value="${Number(c.amount) > 0 ? c.amount : 1}" data-step-field="amount" data-idx="${idx}" />
        </div>
        <div class="form-field">
          <label>Eenheid</label>
          <select data-step-field="unit" data-idx="${idx}">
            <option value="minutes" ${c.unit === 'minutes' ? 'selected' : ''}>minuten</option>
            <option value="hours"   ${c.unit === 'hours'   ? 'selected' : ''}>uren</option>
            <option value="days"    ${c.unit === 'days'    ? 'selected' : ''}>dagen</option>
          </select>
        </div>
      </div>`;
  } else if (s.type === 'condition') {
    const c = s.config || {};
    const checkOpts = Object.entries(COND_CHECK_LABELS)
      .map(([v, l]) => `<option value="${v}" ${c.check === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    body = `
      <div class="form-row-2">
        <div class="form-field">
          <label>Conditie</label>
          <select data-step-field="check" data-idx="${idx}">${checkOpts}</select>
        </div>
        <div class="form-field">
          <label>Anders</label>
          <select data-step-field="on_fail" data-idx="${idx}">
            <option value="exit"        ${(c.on_fail || 'exit') === 'exit' ? 'selected' : ''}>Stoppen</option>
            <option value="skip_to_end" ${c.on_fail === 'skip_to_end' ? 'selected' : ''}>Door naar einde</option>
          </select>
        </div>
      </div>`;
  } else if (s.type === 'send_email') {
    const c = s.config || {};
    const subjectId = `eSubj_${idx}`, bodyId = `eBody_${idx}`;
    body = `
      <div class="form-field">
        <label>Onderwerp <span class="req">*</span></label>
        <input type="text" id="${subjectId}" data-step-field="subject" data-idx="${idx}" value="${esc(c.subject || '')}" onfocus="trackEmailFocus('${subjectId}')" />
      </div>
      <div class="form-field">
        <label>Bericht <span class="req">*</span></label>
        <textarea id="${bodyId}" data-step-field="body" data-idx="${idx}" rows="5" onfocus="trackEmailFocus('${bodyId}')">${esc(c.body || '')}</textarea>
        ${varPickerHtml()}
        <div class="form-help">Variabelen worden vervangen vóór verzending. E-mail vertrekt vanaf <code>info@deforexopleiding.nl</code>.</div>
      </div>`;
  } else if (s.type === 'send_whatsapp') {
    const c = s.config || {};
    body = `
      <div class="form-field">
        <label>WhatsApp-template <span class="req">*</span></label>
        ${renderWaTemplateSelect(idx, c.template_name || '')}
        ${state.waTemplatesError
          ? `<div class="form-help" style="color:#dc2626">Templates konden niet geladen worden: ${esc(state.waTemplatesError)}</div>`
          : `<div class="form-help">Alleen goedgekeurde Meta-templates van de onboarding-WABA worden getoond.</div>`}
      </div>
      <div class="form-field">
        <label>Taal</label>
        <input type="text" data-step-field="language" data-idx="${idx}" value="${esc(c.language || 'nl')}" maxlength="16" />
        <div class="form-help">Default <code>nl</code>. Komt op de Meta-template-call mee als <code>language</code>.</div>
      </div>`;
  } else if (s.type === 'update_onboarding_status') {
    const c = s.config || {};
    body = `
      <div class="form-field">
        <label>Nieuwe status <span class="req">*</span></label>
        <select data-step-field="new_status" data-idx="${idx}">
          ${ONBOARDING_STATUSES.map(([v, l]) => `<option value="${v}" ${c.new_status === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <div class="form-help">Status van de onboarding. Idempotent — slaat over als de status al klopt.</div>
      </div>`;
  } else if (s.type === 'send_internal_notification') {
    const c = s.config || {};
    body = `
      <div class="form-field">
        <label>Onderwerp <span class="req">*</span></label>
        <input type="text" data-step-field="subject" data-idx="${idx}" value="${esc(c.subject || '')}" />
      </div>
      <div class="form-field">
        <label>Bericht <span class="req">*</span></label>
        <textarea data-step-field="body" data-idx="${idx}" rows="4">${esc(c.body || '')}</textarea>
        <div class="form-help">Korte interne notificatie aan het team. Wordt verzonden vanaf <code>info@</code>.</div>
      </div>
      <div class="form-field">
        <label>Naar e-mail (optioneel)</label>
        <input type="email" data-step-field="to_email" data-idx="${idx}" value="${esc(c.to_email || '')}" placeholder="leeg = INTERNAL_NOTIFICATION_EMAIL env / jeffrey@deforexopleiding.nl" />
      </div>`;
  } else {
    body = `<div class="form-help">Onbekend staptype.</div>`;
  }
  return `<div class="step-card" data-step-idx="${idx}">${head}${body}</div>`;
}

function renderWaTemplateSelect(idx, currentValue) {
  const items = Array.isArray(state.waTemplates) ? state.waTemplates : [];
  const known = items.some((t) => t.name === currentValue);
  let opts = '<option value="">— Kies template —</option>';
  for (const t of items) {
    const lang  = t.language ? ` · ${t.language}` : '';
    const label = `${t.name}${lang}`;
    const sel   = (t.name === currentValue) ? ' selected' : '';
    opts += `<option value="${esc(t.name)}"${sel}>${esc(label)}</option>`;
  }
  if (currentValue && !known) {
    opts += `<option value="${esc(currentValue)}" selected>${esc(currentValue)} (niet meer goedgekeurd)</option>`;
  }
  return `<select data-step-field="template_name" data-idx="${idx}">${opts}</select>`;
}

function stepTypeLabel(t) {
  return {
    wait:                       'Wachten',
    condition:                  'Conditie',
    send_email:                 'E-mail sturen',
    send_whatsapp:              'WhatsApp sturen',
    update_onboarding_status:   'Onboarding-status wijzigen',
    send_internal_notification: 'Interne notificatie',
  }[t] || t;
}
function stepIcon(t) {
  const map = {
    wait:                       'hourglass',
    condition:                  'git-branch',
    send_email:                 'mail',
    send_whatsapp:              'brand-whatsapp',
    update_onboarding_status:   'user-check',
    send_internal_notification: 'bell',
  };
  return `<i class="ti ti-${map[t] || 'circle'}"></i>`;
}

function varPickerHtml() {
  const chips = (arr) => arr.map((v) => `<button class="vp-chip" type="button" data-var="${esc(v.key)}" title="{{${esc(v.key)}}}">${esc(v.label)}</button>`).join('');
  return `
    <div class="var-picker">
      <div class="vp-group">
        <div class="vp-label">Klant</div>
        <div class="vp-chips">${chips(CUSTOMER_VARS)}</div>
      </div>
      <div class="vp-group">
        <div class="vp-label">Onboarding</div>
        <div class="vp-chips">${chips(ONBOARDING_VARS)}</div>
      </div>
    </div>`;
}

window.trackEmailFocus = function (id) { state.lastFocusedFieldId = id; };

function insertVarAtCursor(varKey) {
  const id = state.lastFocusedFieldId;
  if (!id) { toastErr('Klik eerst in een tekstveld'); return; }
  const el = document.getElementById(id);
  if (!el) return;
  const token = `{{${varKey}}}`;
  const start = el.selectionStart ?? el.value.length;
  const end   = el.selectionEnd   ?? el.value.length;
  const before = el.value.slice(0, start);
  const after  = el.value.slice(end);
  el.value = before + token + after;
  const pos = start + token.length;
  el.focus();
  try { el.setSelectionRange(pos, pos); } catch {}
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Editor click-delegation ──────────────────────────────────────────────────
function onEditorClick(ev) {
  const back = ev.target.closest('[data-act="back-list"]');
  if (back) { ev.preventDefault(); cancelEditor(); return; }
  const cancel = ev.target.closest('[data-act="cancel-editor"]');
  if (cancel) return cancelEditor();
  const save = ev.target.closest('[data-act="save"]');
  if (save) return saveEditor();
  const add = ev.target.closest('[data-add]');
  if (add) return addStep(add.dataset.add);
  const stepBtn = ev.target.closest('[data-step-act]');
  if (stepBtn) {
    const idx = Number(stepBtn.dataset.idx);
    if (stepBtn.dataset.stepAct === 'up')     return moveStep(idx, -1);
    if (stepBtn.dataset.stepAct === 'down')   return moveStep(idx,  1);
    if (stepBtn.dataset.stepAct === 'remove') return removeStep(idx);
  }
  const varChip = ev.target.closest('[data-var]');
  if (varChip) return insertVarAtCursor(varChip.dataset.var);
}

// Algemene input/change delegation om steps[].config bij te werken.
document.addEventListener('input', (ev) => {
  const t = ev.target.closest('[data-step-field][data-idx]');
  if (!t || state.view !== 'editor') return;
  applyStepFieldChange(t);
});
document.addEventListener('change', (ev) => {
  const t = ev.target.closest('[data-step-field][data-idx]');
  if (!t || state.view !== 'editor') return;
  applyStepFieldChange(t);
});

function applyStepFieldChange(input) {
  const idx = Number(input.dataset.idx);
  const field = input.dataset.stepField;
  const step = state.editing?.steps?.[idx];
  if (!step) return;
  if (!step.config) step.config = {};
  if      (field === 'amount')        step.config.amount = Math.max(1, Number(input.value) || 1);
  else if (field === 'unit')          step.config.unit = input.value;
  else if (field === 'check')         step.config.check = input.value;
  else if (field === 'on_fail')       step.config.on_fail = input.value;
  else if (field === 'subject')       step.config.subject = input.value;
  else if (field === 'body')          step.config.body = input.value;
  else if (field === 'template_name') step.config.template_name = input.value;
  else if (field === 'language')      step.config.language = input.value;
  else if (field === 'new_status')    step.config.new_status = input.value;
  else if (field === 'to_email')      step.config.to_email = input.value;
}

function addStep(type) {
  const a = state.editing;
  const defaults = {
    wait:                       { type: 'wait',                       config: { amount: 1, unit: 'hours' } },
    condition:                  { type: 'condition',                  config: { check: 'wizard_not_started', on_fail: 'exit' } },
    send_email:                 { type: 'send_email',                 config: { subject: '', body: '' } },
    send_whatsapp:              { type: 'send_whatsapp',              config: { template_name: '', language: 'nl' } },
    update_onboarding_status:   { type: 'update_onboarding_status',   config: { new_status: 'bezig' } },
    send_internal_notification: { type: 'send_internal_notification', config: { subject: '', body: '', to_email: '' } },
  };
  if (!defaults[type]) return;
  a.steps = a.steps || [];
  a.steps.push(JSON.parse(JSON.stringify(defaults[type])));
  renderSteps();
}
function moveStep(idx, delta) {
  const a = state.editing;
  const ni = idx + delta;
  if (ni < 0 || ni >= a.steps.length) return;
  const [s] = a.steps.splice(idx, 1);
  a.steps.splice(ni, 0, s);
  renderSteps();
}
function removeStep(idx) {
  const a = state.editing;
  if (!confirm('Deze stap verwijderen?')) return;
  a.steps.splice(idx, 1);
  renderSteps();
}

// ── Cancel + Save ────────────────────────────────────────────────────────────
function cancelEditor() {
  if (state.editing) {
    if (!confirm('Wijzigingen weggooien?')) return;
  }
  state.editing = null;
  renderList();
}

function readAndValidateEditor() {
  const a = state.editing;
  a.name        = (document.getElementById('fName')?.value || '').trim();
  a.description = (document.getElementById('fDesc')?.value || '').trim();
  a.trigger_type = document.getElementById('fTrigger')?.value || a.trigger_type;
  if (a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after') {
    const d = Math.max(0, Math.floor(Number(document.getElementById('fDaysAfterSignup')?.value)  || 0));
    const h = Math.max(0, Math.floor(Number(document.getElementById('fHoursAfterSignup')?.value) || 0));
    const cfg = {};
    if (d > 0) cfg.days_after_signup  = d;
    if (h > 0) cfg.hours_after_signup = h;
    a.trigger_config = cfg;
  } else if (a.trigger_type === 'on_first_call_in') {
    const d = Math.max(0, Math.floor(Number(document.getElementById('fDaysBeforeCall')?.value) || 0));
    a.trigger_config = { days_before_call: d };
  } else {
    a.trigger_config = {};
  }
  const enroll = document.querySelector('input[name=fEnroll]:checked');
  if (enroll) a.enroll_mode = enroll.value;

  if (!a.name) return 'Naam is verplicht.';
  if (a.trigger_type === 'time_after_signup' || a.trigger_type === 'on_wizard_not_started_after') {
    const cfg = a.trigger_config || {};
    const hasH = Number(cfg.hours_after_signup) > 0;
    const hasD = Number(cfg.days_after_signup)  > 0;
    if (!hasH && !hasD) return 'Vul minstens één van dagen / uren na aanmelden in (> 0).';
  }
  if (!Array.isArray(a.steps)) a.steps = [];
  for (let i = 0; i < a.steps.length; i++) {
    const s = a.steps[i];
    const c = s?.config || {};
    if (s.type === 'wait') {
      if (!(Number(c.amount) > 0)) return `Stap ${i + 1}: vul een geldige duur in.`;
      if (!['minutes', 'hours', 'days'].includes(c.unit)) return `Stap ${i + 1}: kies een eenheid.`;
    } else if (s.type === 'condition') {
      if (!Object.keys(COND_CHECK_LABELS).includes(c.check)) return `Stap ${i + 1}: kies een conditie.`;
    } else if (s.type === 'send_email') {
      if (!c.subject) return `Stap ${i + 1}: onderwerp is verplicht.`;
      if (!c.body)    return `Stap ${i + 1}: bericht is verplicht.`;
    } else if (s.type === 'send_whatsapp') {
      if (!c.template_name) return `Stap ${i + 1}: kies een template.`;
    } else if (s.type === 'update_onboarding_status') {
      if (!ONBOARDING_STATUSES.some(([v]) => v === c.new_status)) return `Stap ${i + 1}: kies een nieuwe status.`;
    } else if (s.type === 'send_internal_notification') {
      if (!c.subject) return `Stap ${i + 1}: onderwerp interne notificatie is verplicht.`;
      if (!c.body)    return `Stap ${i + 1}: bericht interne notificatie is verplicht.`;
    }
  }
  return null;
}

async function saveEditor() {
  const err = readAndValidateEditor();
  const banner = document.getElementById('editorBanner');
  if (err) {
    if (banner) { banner.textContent = err; banner.classList.add('visible'); }
    return;
  }
  if (banner) { banner.textContent = ''; banner.classList.remove('visible'); }

  const a = state.editing;
  state.saving = true;
  const btn = document.getElementById('btnSave');
  if (btn) btn.disabled = true;
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-save', { method: 'POST', body: JSON.stringify(a) });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'save failed');
    toastOk('Opgeslagen');
    await loadAutomations();
    state.editing = null;
    renderList();
  } catch (e) {
    if (banner) { banner.textContent = 'Opslaan mislukt: ' + (e?.message || e); banner.classList.add('visible'); }
    toastErr('Opslaan mislukt: ' + (e?.message || e));
  } finally {
    state.saving = false;
    if (btn) btn.disabled = false;
  }
}

// ── Runs modal (Fase 3a) ────────────────────────────────────────────────────
// Twee weergaven: lijst van runs per automation + detail van één run (log).
// We onthouden de huidige automation in _runsState zodat de "Terug"-knop
// in de detail-view de juiste lijst opnieuw kan tonen.
const _runsState = { automationId: null, automationName: null };

async function openRunsModal(automationId) {
  const a = state.automations.find((x) => x.id === automationId);
  _runsState.automationId   = automationId;
  _runsState.automationName = a?.name || '';
  document.getElementById('runsModalTitle').textContent = `Run-historie · ${a?.name || ''}`;
  document.getElementById('runsBackBtn').style.display = 'none';
  document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px"><i class="ti ti-loader-2"></i> Laden…</div>`;
  document.getElementById('runsModal').classList.remove('hidden');
  await loadRunsForAutomation(automationId);
}

async function loadRunsForAutomation(automationId) {
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-runs?automation_id=' + encodeURIComponent(automationId));
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'runs failed');
    const runs = Array.isArray(data.runs) ? data.runs : [];
    if (runs.length === 0) {
      document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px">Nog geen runs voor deze automation.</div>`;
      return;
    }

    // Verzamel onboarding_ids zodat we per run de klant-naam erbij kunnen
    // tonen (read-only join via onboardings-admin-list zou duurder zijn —
    // we doen geen extra fetch en tonen de id-prefix).
    document.getElementById('runsModalBody').innerHTML = `
      <table class="runs-table">
        <thead><tr>
          <th>Status</th><th>Stap</th><th>Onboarding</th><th>Volgende run</th><th>Gestart</th><th>Laatste fout</th>
        </tr></thead>
        <tbody>
          ${runs.map((r) => `
            <tr class="clickable" data-run-id="${esc(r.id)}">
              <td><span class="runs-status ${esc(r.status)}">${esc(r.status)}</span></td>
              <td>${esc(String(r.current_step_index ?? '—'))}</td>
              <td title="${esc(r.onboarding_id || '')}">${esc(String(r.onboarding_id || '').slice(0, 8))}…</td>
              <td>${esc(fmtDate(r.next_run_at))}</td>
              <td>${esc(fmtDate(r.started_at))}</td>
              <td style="color:var(--text-faint)">${esc(r.last_error || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="form-help" style="margin-top:8px">Klik op een rij voor de stap-log.</div>
    `;
    document.querySelectorAll('#runsModalBody tr.clickable[data-run-id]').forEach((row) => {
      row.addEventListener('click', () => openRunDetail(row.getAttribute('data-run-id')));
    });
  } catch (e) {
    document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px">Laden mislukt: ${esc(e?.message || e)}</div>`;
  }
}

async function openRunDetail(runId) {
  if (!runId) return;
  document.getElementById('runsModalTitle').textContent = `Run · ${runId.slice(0, 8)}…`;
  document.getElementById('runsBackBtn').style.display = '';
  document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px"><i class="ti ti-loader-2"></i> Laden…</div>`;
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-runs?run_id=' + encodeURIComponent(runId));
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || 'run-detail failed');
    const run = data.run || null;
    const log = Array.isArray(data.log) ? data.log : [];

    const metaTable = run ? `
      <table class="runs-table" style="margin-bottom:14px">
        <tbody>
          <tr><th style="width:140px">Status</th><td><span class="runs-status ${esc(run.status)}">${esc(run.status)}</span></td></tr>
          <tr><th>Huidige stap</th><td>${esc(String(run.current_step_index ?? '—'))}</td></tr>
          <tr><th>Volgende run</th><td>${esc(fmtDate(run.next_run_at))}</td></tr>
          <tr><th>Gestart</th><td>${esc(fmtDate(run.started_at))}</td></tr>
          <tr><th>Afgerond</th><td>${esc(fmtDate(run.completed_at))}</td></tr>
          <tr><th>Onboarding</th><td><code>${esc(run.onboarding_id || '')}</code></td></tr>
          <tr><th>Automation</th><td><code>${esc(run.automation_id || '')}</code></td></tr>
          ${run.last_error ? `<tr><th>Laatste fout</th><td style="color:#b91c1c">${esc(run.last_error)}</td></tr>` : ''}
        </tbody>
      </table>` : '<div class="empty-state" style="padding:20px 12px">Run niet gevonden.</div>';

    const logHtml = log.length === 0
      ? '<div class="empty-state" style="padding:20px 12px">Nog geen log-rijen voor deze run.</div>'
      : `<div class="log-list">${log.map((r) => `
          <div class="log-row">
            <div class="log-head">
              <span class="log-idx">${esc(String(r.step_index ?? '?'))}</span>
              <span class="log-type">${esc(r.step_type || 'unknown')}</span>
              <span class="log-ts">${esc(fmtDate(r.executed_at))}</span>
            </div>
            ${r.result ? `<pre>${esc(JSON.stringify(r.result, null, 2))}</pre>` : ''}
          </div>
        `).join('')}</div>`;

    document.getElementById('runsModalBody').innerHTML = metaTable + logHtml;
  } catch (e) {
    document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px">Laden mislukt: ${esc(e?.message || e)}</div>`;
  }
}

function backToRunsList() {
  const a = state.automations.find((x) => x.id === _runsState.automationId);
  document.getElementById('runsModalTitle').textContent = `Run-historie · ${a?.name || _runsState.automationName || ''}`;
  document.getElementById('runsBackBtn').style.display = 'none';
  document.getElementById('runsModalBody').innerHTML = `<div class="empty-state" style="padding:30px 12px"><i class="ti ti-loader-2"></i> Laden…</div>`;
  loadRunsForAutomation(_runsState.automationId);
}

function closeRunsModal() {
  document.getElementById('runsModal').classList.add('hidden');
}
window.closeRunsModal = closeRunsModal;
window.backToRunsList = backToRunsList;

// ── Tester (Fase 3b) ────────────────────────────────────────────────────────
// Opens modal, vult traject-dropdown via /api/onboarding-trajecten-list,
// POST'et naar /api/onboarding-automation-test bij submit.
const _atState = { automationId: null, trajectsLoaded: false, trajectsCache: [] };

function _atShowBanner(msg, kind) {
  const el = document.getElementById('automationTestBanner');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  const palette = kind === 'error'
    ? 'background:rgba(220,38,38,.08);border:1px solid rgba(220,38,38,.3);color:#b91c1c'
    : kind === 'success'
      ? 'background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);color:#059669'
      : 'background:rgba(99,102,241,.08);border:1px solid rgba(99,102,241,.3);color:#6366f1';
  el.style.cssText = 'display:block;margin-bottom:10px;padding:8px 12px;border-radius:6px;font-size:12px;white-space:pre-wrap;' + palette;
  el.textContent = msg;
}

async function openTestModal(automationId) {
  if (!automationId) return;
  if (!can('onboarding.automation.edit')) { toastErr('Geen rechten (onboarding.automation.edit)'); return; }
  _atState.automationId = automationId;
  _atShowBanner('', null);
  document.getElementById('automationTestModal').classList.remove('hidden');
  const sel = document.getElementById('atTraject');
  if (!_atState.trajectsLoaded) {
    sel.innerHTML = '<option value="">Laden…</option>';
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-trajecten-list');
      const data = await r.json();
      if (!r.ok) throw new Error(data?.error || ('HTTP ' + r.status));
      const items = Array.isArray(data?.trajecten) ? data.trajecten
                  : Array.isArray(data?.items)     ? data.items
                  : Array.isArray(data?.rows)      ? data.rows
                  : Array.isArray(data)            ? data
                  : [];
      // Alleen actieve trajecten als is_active-veld bestaat (anders allemaal).
      const list = items.filter((t) => t && (t.is_active !== false));
      _atState.trajectsCache = list;
      _atState.trajectsLoaded = true;
      if (list.length === 0) {
        sel.innerHTML = '<option value="">Geen trajecten gevonden</option>';
      } else {
        sel.innerHTML = list.map((t, i) => {
          const label = t.label || t.name || ('Traject ' + (t.id || '').slice(0, 8));
          const typ = t.type ? ' · ' + t.type : '';
          return '<option value="' + esc(t.id) + '"' + (i === 0 ? ' selected' : '') + '>' + esc(label + typ) + '</option>';
        }).join('');
      }
    } catch (e) {
      sel.innerHTML = '<option value="">Fout: ' + esc(e?.message || 'onbekend') + '</option>';
    }
  }
}

function closeTestModal() {
  document.getElementById('automationTestModal').classList.add('hidden');
}
window.closeTestModal = closeTestModal;

async function submitTestRun() {
  _atShowBanner('', null);
  const automationId = _atState.automationId;
  if (!automationId) return;
  const trajectId = document.getElementById('atTraject').value || '';
  const name      = (document.getElementById('atName').value  || '').trim();
  const email     = (document.getElementById('atEmail').value || '').trim();
  const phone     = (document.getElementById('atPhone').value || '').trim();
  if (!trajectId) { _atShowBanner('Kies een traject.', 'error'); return; }
  if (!name)      { _atShowBanner('Naam is verplicht.', 'error'); return; }
  if (!email)     { _atShowBanner('E-mail is verplicht.', 'error'); return; }
  if (!phone)     { _atShowBanner('Telefoon (E.164) is verplicht.', 'error'); return; }

  const btn = document.getElementById('atStartBtn');
  if (btn) btn.disabled = true;
  _atShowBanner('Test starten…', 'info');
  try {
    const r = await window.AgentShared.apiFetch('/api/onboarding-automation-test', {
      method: 'POST',
      body: JSON.stringify({
        automation_id: automationId,
        traject_id:    trajectId,
        name,
        email,
        phone,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { _atShowBanner(data?.error || ('HTTP ' + r.status), 'error'); return; }
    toastOk('Test gestart — bekijk Runs voor de voortgang');
    closeTestModal();
    // Open Runs-modal als die functie aanwezig is (Fase 3a). Anders een
    // simpele toast met de run_id zodat de gebruiker 'm via een andere weg
    // kan opzoeken.
    if (typeof window.openRunsModal === 'function') {
      try { window.openRunsModal(automationId); } catch (e) { /* niet-blokkerend */ }
    } else if (data?.run_id) {
      toastOk('Run-id: ' + String(data.run_id).slice(0, 8) + '…');
    }
  } catch (e) {
    _atShowBanner('Starten mislukt: ' + (e?.message || e), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.submitTestRun = submitTestRun;

  // ──────────────────────────────────────────────────────────────────────────
  // Mount() — vervangt de DOMContentLoaded-IIFE-init uit de oorspronkelijke
  // standalone-pagina. Idempotent: re-mount op dezelfde host doet niets. De
  // hub heeft al ensurePermissionsLoaded() gedaan vóór ons gemount wordt
  // (mountAutomationsIfNeeded gates op canSync('onboarding.automation.view'))
  // dus de defense-in-depth check binnen init() introduceert geen race.
  // ──────────────────────────────────────────────────────────────────────────
  async function init() {
    try {
      if (window._authSharedReady) await window._authSharedReady;
      // requireAuth is door de host-pagina al gedaan; geen redirect-flow nodig.
      if (!can('onboarding.automation.view')) {
        document.getElementById('page-content').innerHTML =
          '<div class="forbidden-card">' +
            '<h2>Geen toegang</h2>' +
            '<p>Je hebt geen rechten om onboarding-automations te bekijken.</p>' +
          '</div>';
        return;
      }
      await loadAutomations();
      renderList();
    } catch (e) {
      console.error('[onboarding-automations] init', e);
      toastErr('Pagina laden mislukt: ' + (e && e.message ? e.message : e));
    }
  }

  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[OnboardingAutomations] mount() requires {host}');
      return;
    }
    if (_mountedHost === o.host) return; // idempotent
    _mountedHost = o.host;
    injectStyles();
    o.host.innerHTML = HOST_HTML;
    ensureModalsInBody();
    init();
  }

  window.OnboardingAutomations = {
    __loaded: true,
    mount,
  };
})();
