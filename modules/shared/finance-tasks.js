/* modules/shared/finance-tasks.js
 *
 * Finance Tasks shared module — extract van de Open Acties UI (pre-redirector
 * versie van modules/open-acties.html, commit 29fe398~1) zodat deze logica
 * herbruikbaar is binnen Finance > Wanbetalers > Open Acties sub-tab.
 *
 * Public API: window.FinanceTasks.mount({
 *   host:              HTMLElement,          // verplichte mount-container
 *   statusFilter?:     'PENDING'|'APPROVED'|'EXECUTED'|'FAILED', // default 'PENDING'
 *   actionTypeFilter?: string,               // server-side action_type CSV filter
 *   customerId?:       string,               // server-side customer-scope filter
 * })
 *
 * Hergebruik bestaande endpoints:
 *  - /api/tasks-list
 *  - /api/pending-actions-detail
 *  - /api/pending-actions-approve
 *  - /api/pending-actions-reject
 *  - /api/pending-actions-mark-executed
 *  - /api/pending-actions-mark-not-executed
 *
 * RBAC: respecteert finance.tasks.view / finance.arrangements.view via de
 * onderliggende endpoints (geen extra client-side check — server-side fail-open).
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets (return early).
 * Tweede aanroep op een nieuwe host re-render zodat externe filter-prefill
 * kan veranderen.
 */
(function () {
  if (window.FinanceTasks && window.FinanceTasks.__loaded) return;

  // ── Module-scope state (één globale instance — open-acties was single-page). ──
  let _state = {
    host:            null,
    activeStatus:    'PENDING',
    activeCategory:  'all',
    activeSubtype:   'all',
    searchQuery:     '',
    items:           [],
    loading:         false,
    wired:           false,
    searchTimer:     null,
    customerId:      null,
    actionTypePin:   null,  // niet-wijzigbare server-side action_type filter (caller-set)
  };

  let _currentDetailId   = null;
  let _currentDetailItem = null;
  let _rejectContext     = null;

  // ── esc(): defensief HTML-escape (fallback als AgentShared niet geladen is). ──
  function esc(s) {
    if (s == null) return '';
    try {
      if (window.AgentShared && typeof window.AgentShared.esc === 'function') {
        return window.AgentShared.esc(s);
      }
    } catch (_) { /* fallthrough */ }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Helpers (consistent met admin.html approval-queue renderers) ────────────
  function approvStatusBadge(status) {
    const s = String(status || '').toLowerCase();
    const known = ['pending','approved','rejected','executed','failed','cancelled','rolled_back'];
    const cls = known.includes(s) ? 'approv-status-' + s : 'approv-status-pending';
    return '<span class="approv-status-badge ' + cls + '">' + esc(s || 'pending') + '</span>';
  }

  function approvActionLabel(t) {
    const map = {
      'TL_INVOICE_UPDATE_DUE':              'Uitstel',
      'TL_INVOICE_CONSOLIDATE_AND_RESTART': 'Consolideer + nieuwe regeling',
      'TL_INVOICE_SPLIT':                   'Splitsing in termijnen',
      'TL_SUBSCRIPTION_PAUSE':              'Abonnement pauze',
      'TL_SUBSCRIPTION_STOP':               'Abonnement stop',
      'TL_INVOICE_WRITEOFF':                'Kwijtschelding',
      'MANUAL_VERIFY_PAYMENT':              'Betalingscontrole',
      'MANUAL_ESCALATION':                  'Escalatie',
      'MANUAL_PROPOSE_ARRANGEMENT':         'Voorstel afspraak',
      'MANUAL_FOLLOWUP':                    'Follow-up bericht',
      'arrangement.uitstel':         'Uitstel',
      'arrangement.gespreid':        'Splitsing in termijnen',
      'arrangement.kwijtschelding':  'Kwijtschelding',
      'arrangement.pauze':           'Abonnement pauze',
      'arrangement.abonnement_stop': 'Abonnement stop',
    };
    return map[t] || (t || '—');
  }

  function categoryForActionType(t) {
    const s = String(t || '');
    if (s === 'MANUAL_VERIFY_PAYMENT')       return 'verify_payment';
    if (s === 'MANUAL_ESCALATION')           return 'escalation';
    if (s === 'MANUAL_PROPOSE_ARRANGEMENT')  return 'arrangement';
    if (s === 'MANUAL_FOLLOWUP')             return 'arrangement';
    if (s.indexOf('TL_') === 0)              return 'arrangement';
    if (s.indexOf('arrangement.') === 0)     return 'arrangement';
    return 'other';
  }

  function isJoostAutonomous(it) {
    if (!it) return false;
    if (String(it.source || '').toLowerCase() === 'joost') return true;
    if (String(it.created_by || '').toLowerCase() === 'joost') return true;
    const p = it.payload || {};
    if (String(p.source || '').toLowerCase() === 'joost') return true;
    if (String(p.created_by || '').toLowerCase() === 'joost') return true;
    if (it.linked_joost_suggestion && (it.action_type === 'MANUAL_PROPOSE_ARRANGEMENT' || it.action_type === 'MANUAL_FOLLOWUP')) {
      return true;
    }
    return false;
  }

  function joostAutonomousBadge(opts) {
    const compact = !!(opts && opts.compact);
    const cls = 'tasks-joost-badge' + (compact ? ' compact' : '');
    return '<span class="' + cls + '" title="Aangemaakt door Joost autonoom"><i class="ti ti-sparkles"></i>Joost</span>';
  }

  function approvSummary(it) {
    const p = it.payload || {};
    const parts = [];
    if (Array.isArray(p.invoice_ids) && p.invoice_ids.length) {
      parts.push(p.invoice_ids.length + ' factuur' + (p.invoice_ids.length === 1 ? '' : 'en'));
    } else if (p.invoice_id && !it.invoice_id) {
      parts.push('invoice ' + String(p.invoice_id).slice(0, 8));
    }
    if (p.new_due_date)         parts.push('nieuwe due: ' + String(p.new_due_date).slice(0, 10));
    if (p.installments)         parts.push(p.installments + ' termijnen');
    if (p.amount_total != null) parts.push('€ ' + p.amount_total);
    if (p.claimed_amount != null) parts.push('claim: € ' + p.claimed_amount);
    if (p.percentage != null)   parts.push(p.percentage + '%');
    if (p.rationale)            parts.push(approvTruncate(String(p.rationale), 60));
    return parts.length ? parts.join(' · ') : '(geen payload)';
  }

  function approvFmtDateTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const dd = String(d.getDate()).padStart(2, '0');
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const yy = d.getFullYear();
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return dd + '-' + mm + '-' + yy + ' ' + hh + ':' + mi;
    } catch (_) { return String(iso); }
  }

  function approvFmtDateOnly(s) {
    if (!s) return '—';
    try {
      const d = new Date(String(s).length === 10 ? (String(s) + 'T00:00:00') : String(s));
      if (isNaN(d.getTime())) return String(s);
      return String(d.getDate()).padStart(2, '0') + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + d.getFullYear();
    } catch (_) { return String(s); }
  }

  function approvFmtEur(v) {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    return '€ ' + n.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function approvTruncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function relTime(iso) {
    if (!iso) return '—';
    try {
      if (window.AgentShared && typeof window.AgentShared.relTime === 'function') {
        return window.AgentShared.relTime(iso);
      }
    } catch (_) { /* fallthrough */ }
    try {
      const d = new Date(iso); const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60)    return 'net';
      if (diff < 3600)  return Math.round(diff / 60) + 'm';
      if (diff < 86400) return Math.round(diff / 3600) + 'u';
      return Math.round(diff / 86400) + 'd';
    } catch (_) { return approvFmtDateTime(iso); }
  }

  // ── CSS-injectie (één keer) ─────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('finance-tasks-styles')) return;
    const style = document.createElement('style');
    style.id = 'finance-tasks-styles';
    style.textContent = `
      .ftasks-stats { display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap; }
      .ftasks-stat-chip { background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; padding:12px 16px; min-width:120px; }
      .ftasks-stat-chip-value { font-size:24px; font-weight:700; line-height:1; }
      .ftasks-stat-chip-label { font-size:10px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.5px; margin-top:4px; }
      .ftasks-stat-chip-accent .ftasks-stat-chip-value { color:var(--brand-primary, var(--accent-cyan, #06b6d4)); }

      .approv-filter-strip { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
      .approv-filter-strip .filter-group-label { font-size:11px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.4px; margin-right:4px; }
      .approv-pill { background:var(--bg-elev-2); border:1px solid var(--border); border-radius:999px; padding:6px 14px; font-size:12px; color:var(--text-dim); cursor:pointer; font-family:inherit; font-weight:500; display:inline-flex; align-items:center; gap:6px; }
      .approv-pill:hover { background:var(--surface-card-hover); color:var(--text); }
      .approv-pill.active { background:var(--brand-primary-soft); color:var(--brand-primary); border-color:var(--brand-primary); }
      .approv-pill-count { font-size:10px; padding:1px 6px; border-radius:8px; background:var(--bg-elev); color:var(--text-faint); font-weight:600; }
      .approv-pill.active .approv-pill-count { background:var(--brand-primary); color:#fff; }

      .ftasks-search-wrap { margin-left:auto; display:inline-flex; align-items:center; gap:6px; }
      .ftasks-search-input { background:var(--bg-elev-2); border:1px solid var(--border); border-radius:8px; padding:7px 12px; font-size:12.5px; color:var(--text); font-family:inherit; outline:none; min-width:240px; transition:border-color .15s; }
      .ftasks-search-input:focus { border-color:var(--brand-primary, var(--accent-cyan)); }

      .approv-table { width:100%; border-collapse:collapse; font-size:13px; }
      .approv-table th { text-align:left; padding:10px 12px; font-size:10px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.5px; border-bottom:1px solid var(--border); }
      .approv-table td { padding:11px 12px; border-bottom:0.5px solid var(--border-subtle,var(--border)); vertical-align:middle; }
      .approv-table tr:last-child td { border-bottom:none; }
      .approv-table tr:hover td { background:var(--surface-card); }
      .approv-table .approv-row.clickable { cursor:pointer; }
      .approv-action-type { font-family:monospace; font-size:11.5px; color:var(--text-dim); background:var(--bg-elev-2); padding:2px 6px; border-radius:4px; display:inline-block; }
      .approv-mini-btn { padding:4px 10px; font-size:11.5px; border-radius:6px; border:1px solid var(--border); background:var(--bg-elev); color:var(--text-dim); cursor:pointer; font-family:inherit; }
      .approv-mini-btn:hover { background:var(--bg-elev-2); color:var(--text); }
      .approv-mini-btn.primary { background:var(--brand-primary); color:#fff; border-color:var(--brand-primary); }
      .approv-mini-btn.primary:hover { opacity:.9; }
      .approv-mini-btn.danger { background:transparent; color:var(--color-danger,#dc2626); border-color:var(--color-danger,#dc2626); }
      .approv-mini-btn.danger:hover { background:var(--color-danger-soft,rgba(220,38,38,.08)); }
      .approv-status-badge { display:inline-block; padding:2px 8px; border-radius:8px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; }
      .approv-status-pending  { background:rgba(56,189,248,.15); color:#0284c7; }
      .approv-status-approved { background:rgba(34,197,94,.15); color:#15803d; }
      .approv-status-rejected { background:rgba(239,68,68,.15); color:#b91c1c; }
      .approv-status-executed { background:rgba(34,197,94,.15); color:#15803d; }
      .approv-status-failed   { background:rgba(239,68,68,.15); color:#b91c1c; }
      .approv-status-cancelled{ background:var(--bg-elev-2); color:var(--text-faint); }
      .approv-status-rolled_back { background:rgba(245,158,11,.15); color:#b45309; }
      .approv-truncate { max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

      .tasks-type-badge { display:inline-block; padding:3px 9px; border-radius:6px; font-size:11px; font-weight:500; border:1px solid; white-space:nowrap; }
      .tasks-type-badge.cat-arrangement   { background:rgba(56,189,248,.12); color:#0284c7; border-color:rgba(56,189,248,.4); }
      .tasks-type-badge.cat-verify_payment{ background:rgba(168,85,247,.12); color:#7e22ce; border-color:rgba(168,85,247,.4); }
      .tasks-type-badge.cat-escalation    { background:rgba(239,68,68,.12); color:#b91c1c; border-color:rgba(239,68,68,.4); }
      .tasks-type-badge.cat-other         { background:var(--bg-elev-2); color:var(--text-dim); border-color:var(--border); }

      .tasks-severity-badge { display:inline-block; padding:2px 8px; border-radius:10px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; border:1px solid transparent; }
      .tasks-severity-badge.sev-low    { background:#d4edda; color:#15803d; border-color:rgba(34,197,94,.4); }
      .tasks-severity-badge.sev-medium { background:#fff3cd; color:#b45309; border-color:rgba(245,158,11,.4); }
      .tasks-severity-badge.sev-high   { background:#f8d7da; color:#b91c1c; border-color:rgba(239,68,68,.4); }

      .tasks-joost-badge { display:inline-flex; align-items:center; gap:3px; padding:1px 6px; border-radius:6px; background:rgba(168,85,247,0.12); color:#7e22ce; border:1px solid rgba(168,85,247,0.4); font-size:10px; font-weight:600; letter-spacing:.2px; vertical-align:middle; }
      .tasks-joost-badge .ti { font-size:11px; }
      .tasks-joost-badge.compact { padding:1px 4px; font-size:9.5px; }

      .tasks-subfilter-strip { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin:-6px 0 14px 0; padding:6px 10px; background:var(--bg-elev-2); border:1px dashed var(--border); border-radius:8px; }
      .tasks-subfilter-strip .filter-group-label { font-size:10.5px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.4px; margin-right:4px; }
      .tasks-subfilter-strip .approv-pill { padding:4px 11px; font-size:11px; }

      .ftasks-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:500; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(4px); }
      .ftasks-modal-overlay.hidden { display:none!important; }
      .ftasks-modal-card { background:var(--bg-elev); border:1px solid var(--border-strong); border-radius:14px; width:100%; max-width:440px; margin:20px; }
      .ftasks-modal-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); }
      .ftasks-modal-title { font-size:15px; font-weight:600; }
      .ftasks-modal-close { background:transparent; border:none; color:var(--text-faint); font-size:16px; cursor:pointer; padding:4px; line-height:1; }
      .ftasks-modal-body { padding:20px; }
      .ftasks-modal-footer { display:flex; justify-content:flex-end; gap:8px; padding:14px 20px; border-top:1px solid var(--border); }
      #ftasksDetailModal .ftasks-modal-card { max-width:760px; max-height:90vh; display:flex; flex-direction:column; }
      #ftasksDetailModal .ftasks-modal-body { overflow-y:auto; flex:1; min-height:0; }

      .approv-detail-grid { display:grid; grid-template-columns:140px 1fr; gap:8px 14px; font-size:12.5px; margin-bottom:14px; }
      .approv-detail-grid > div:nth-child(odd) { color:var(--text-faint); }
      .approv-detail-pre { margin:0; padding:8px 10px; background:rgba(0,0,0,.25); border:1px solid var(--border-subtle,var(--border)); border-radius:6px; font-size:11px; color:var(--text-dim); overflow:auto; max-height:200px; font-family:monospace; }
      .approv-detail-section-title { font-size:11px; text-transform:uppercase; color:var(--text-faint); font-weight:600; letter-spacing:.5px; margin:14px 0 6px 0; }

      .ftasks-form-group { margin-bottom:14px; }
      .ftasks-form-label { display:block; font-size:12px; font-weight:600; color:var(--text-dim); margin-bottom:6px; }
      .ftasks-form-input { width:100%; background:var(--bg-elev-2); border:1px solid var(--border-strong); border-radius:8px; padding:9px 12px; font-size:13px; color:var(--text); font-family:inherit; outline:none; transition:border-color .15s; }
      .ftasks-form-input:focus { border-color:var(--brand-secondary, var(--brand-primary)); }
      .ftasks-form-error { margin-top:10px; padding:8px 12px; background:var(--color-danger-soft, rgba(220,38,38,0.08)); border:1px solid var(--color-danger, #dc2626); border-radius:8px; font-size:12px; color:var(--color-danger-text, #b91c1c); }
      .ftasks-form-error.hidden { display:none!important; }
    `;
    document.head.appendChild(style);
  }

  // ── Modals: één keer aanmaken aan document.body level ───────────────────────
  function ensureModalsInBody() {
    if (document.getElementById('ftasksDetailModal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'finance-tasks-modals';
    wrap.innerHTML = `
      <!-- Task detail modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksDetailModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card">
          <div class="ftasks-modal-header">
            <div>
              <div class="ftasks-modal-title" id="ftasksDetailTitle">Task details</div>
              <div id="ftasksDetailSubtitle" style="font-size:11px;color:var(--text-faint);margin-top:2px">Laden…</div>
            </div>
            <button class="ftasks-modal-close" data-ftasks-close="detail">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body" id="ftasksDetailBody">
            <div style="color:var(--text-faint);padding:14px;text-align:center;font-size:12.5px">Laden…</div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="detail">Sluiten</button>
            <button class="btn btn-danger"  id="ftasksDetailRejectBtn"          style="display:none">Reject</button>
            <button class="btn btn-primary" id="ftasksDetailApproveBtn"         style="display:none">Approve</button>
            <button class="btn btn-danger"  id="ftasksDetailMarkNotExecutedBtn" style="display:none">Markeer als niet door te voeren</button>
            <button class="btn btn-primary" id="ftasksDetailMarkExecutedBtn"    style="display:none">Markeer als verwerkt</button>
            <button class="btn"             id="ftasksDetailEscAddNoteBtn"      style="display:none">Voeg notitie toe</button>
            <button class="btn btn-primary" id="ftasksDetailEscResolveBtn"      style="display:none">Markeer afgehandeld</button>
          </div>
        </div>
      </div>

      <!-- Escalatie resolve modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksEscResolveModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card" style="max-width:540px">
          <div class="ftasks-modal-header">
            <div>
              <div class="ftasks-modal-title">Escalatie markeren als afgehandeld</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Leg de outcome vast voor audit-trail</div>
            </div>
            <button class="ftasks-modal-close" data-ftasks-close="escResolve">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body">
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksEscResolveOutcome">Outcome <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <select id="ftasksEscResolveOutcome" class="ftasks-form-input">
                <option value="resolved">Opgelost</option>
                <option value="handed_over">Overgedragen</option>
              </select>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Kies "Overgedragen" als de afhandeling buiten dit dashboard verder loopt.</div>
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksEscResolveNotes">Notes <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <textarea id="ftasksEscResolveNotes" class="ftasks-form-input" rows="4" style="resize:vertical;min-height:90px" placeholder="Hoe is de escalatie afgehandeld? Min 10 chars."></textarea>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Minimaal 10 tekens. Verplicht voor audit-trail.</div>
            </div>
            <div class="ftasks-form-error hidden" id="ftasksEscResolveError"></div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="escResolve">Annuleren</button>
            <button class="btn btn-primary" id="ftasksEscResolveConfirmBtn">Bevestig</button>
          </div>
        </div>
      </div>

      <!-- Escalatie add-note modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksEscAddNoteModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card" style="max-width:540px">
          <div class="ftasks-modal-header">
            <div>
              <div class="ftasks-modal-title">Voeg notitie toe</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Tussenupdate zonder status-wijziging</div>
            </div>
            <button class="ftasks-modal-close" data-ftasks-close="escAddNote">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body">
            <div style="background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.25);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:var(--text-primary,var(--text))">
              Notitie wordt toegevoegd aan voortgangslog. Status blijft ongewijzigd.
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksEscAddNoteText">Notitie <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <textarea id="ftasksEscAddNoteText" class="ftasks-form-input" rows="4" style="resize:vertical;min-height:90px" placeholder="Wat is er gebeurd? Min 10 chars."></textarea>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Minimaal 10 tekens. Verplicht voor audit-trail.</div>
            </div>
            <div class="ftasks-form-error hidden" id="ftasksEscAddNoteError"></div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="escAddNote">Annuleren</button>
            <button class="btn btn-primary" id="ftasksEscAddNoteConfirmBtn">Opslaan</button>
          </div>
        </div>
      </div>

      <!-- Reject modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksRejectModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card" style="max-width:480px">
          <div class="ftasks-modal-header">
            <div class="ftasks-modal-title" id="ftasksRejectTitle">Voorstel afwijzen</div>
            <button class="ftasks-modal-close" data-ftasks-close="reject">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body">
            <div id="ftasksRejectSubtitle" style="font-size:12px;color:var(--text-faint);margin-bottom:10px">Voer een reden in voor deze afwijzing.</div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksRejectReason">Reden <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <textarea id="ftasksRejectReason" class="ftasks-form-input" rows="4" style="resize:vertical;min-height:90px" placeholder="Waarom wijs je dit voorstel af?"></textarea>
            </div>
            <div class="ftasks-form-error hidden" id="ftasksRejectError"></div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="reject">Annuleren</button>
            <button class="btn btn-danger" id="ftasksRejectConfirmBtn">Afwijzen</button>
          </div>
        </div>
      </div>

      <!-- Mark-as-executed modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksMarkExecutedModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card" style="max-width:620px">
          <div class="ftasks-modal-header">
            <div>
              <div class="ftasks-modal-title">Markeer als verwerkt</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Leg vast wat je in TeamLeader hebt gedaan</div>
            </div>
            <button class="ftasks-modal-close" data-ftasks-close="markExec">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body">
            <div id="ftasksMarkExecContext" style="background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.25);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:var(--text-primary,var(--text))">
              <div id="ftasksMarkExecCtxLine1" style="font-weight:600">&mdash;</div>
              <div id="ftasksMarkExecCtxLine2" style="font-size:11.5px;color:var(--text-dim);margin-top:2px">&mdash;</div>
              <div id="ftasksMarkExecCtxLine3" style="font-size:11.5px;color:var(--text-faint);margin-top:2px">&mdash;</div>
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksMarkExecCreditIds">TL credit-note IDs</label>
              <input type="text" id="ftasksMarkExecCreditIds" class="ftasks-form-input" placeholder="TLCN-2026-001, TLCN-2026-002" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Komma-gescheiden. Leeg laten als n.v.t.</div>
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksMarkExecSubscriptionId">TL subscription ID</label>
              <input type="text" id="ftasksMarkExecSubscriptionId" class="ftasks-form-input" placeholder="sub_xxxxxxxx" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Voor abonnement-mutaties.</div>
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksMarkExecInvoiceIds">TL invoice IDs</label>
              <input type="text" id="ftasksMarkExecInvoiceIds" class="ftasks-form-input" placeholder="INV-2026-101, INV-2026-102" />
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Voor SPLITSING, MANUAL_VERIFY_PAYMENT of nieuwe facturen.</div>
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksMarkExecNotes">Manual notes <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <textarea id="ftasksMarkExecNotes" class="ftasks-form-input" rows="4" style="resize:vertical;min-height:90px" placeholder="Wat heb je in TL gedaan? Min 10 chars."></textarea>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Minimaal 10 tekens. Verplicht voor audit-trail.</div>
            </div>
            <div class="ftasks-form-error hidden" id="ftasksMarkExecError"></div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="markExec">Annuleren</button>
            <button class="btn btn-primary" id="ftasksMarkExecConfirmBtn">Bevestig</button>
          </div>
        </div>
      </div>

      <!-- Mark-as-not-executed modal -->
      <div class="ftasks-modal-overlay hidden" id="ftasksMarkNotExecutedModal" role="dialog" aria-modal="true">
        <div class="ftasks-modal-card" style="max-width:520px">
          <div class="ftasks-modal-header">
            <div>
              <div class="ftasks-modal-title">Markeer als niet door te voeren</div>
              <div style="font-size:11px;color:var(--text-faint);margin-top:2px">Status gaat naar FAILED</div>
            </div>
            <button class="ftasks-modal-close" data-ftasks-close="markNotExec">&#x2715;</button>
          </div>
          <div class="ftasks-modal-body">
            <div style="background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.25);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;color:var(--text-primary,var(--text))">
              De actie krijgt status FAILED. Eventueel onderliggend arrangement blijft VOORGESTELD &mdash; annuleer arrangement apart als nodig.
            </div>
            <div class="ftasks-form-group">
              <label class="ftasks-form-label" for="ftasksMarkNotExecReason">Reden <span style="color:var(--color-danger,#dc2626)">*</span></label>
              <textarea id="ftasksMarkNotExecReason" class="ftasks-form-input" rows="4" style="resize:vertical;min-height:90px" placeholder="Waarom kan deze actie niet doorgevoerd worden? Min 10 chars."></textarea>
              <div style="font-size:11px;color:var(--text-faint);margin-top:4px">Minimaal 10 tekens. Verplicht voor audit-trail.</div>
            </div>
            <div class="ftasks-form-error hidden" id="ftasksMarkNotExecError"></div>
          </div>
          <div class="ftasks-modal-footer">
            <button class="btn" data-ftasks-close="markNotExec">Annuleren</button>
            <button class="btn btn-danger" id="ftasksMarkNotExecConfirmBtn">Bevestig</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(wrap);
  }

  // ── Render: host HTML (KPI + filters + tabel — modals zijn body-level). ─────
  function renderHostShell(host) {
    host.innerHTML = `
      <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:12px">
        <div>
          <h2 style="font-size:18px;font-weight:700;letter-spacing:-.3px;margin:0 0 3px 0">Open Acties</h2>
          <div style="font-size:11.5px;color:var(--text-faint)">Open acties (te beoordelen + te verwerken) en historische acties &mdash; arrangement-acties, betalingsclaims en escalaties.</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="sr-abtn" data-ftasks-refresh type="button" style="font-size:11.5px;padding:5px 10px"><i class="ti ti-refresh" style="margin-right:4px"></i>Vernieuw</button>
        </div>
      </div>

      <div class="ftasks-stats">
        <div class="ftasks-stat-chip ftasks-stat-chip-accent">
          <div class="ftasks-stat-chip-value" data-ftasks-kpi="open">0</div>
          <div class="ftasks-stat-chip-label">Open taken</div>
        </div>
        <div class="ftasks-stat-chip">
          <div class="ftasks-stat-chip-value" data-ftasks-kpi="pending">0</div>
          <div class="ftasks-stat-chip-label">Te beoordelen</div>
        </div>
        <div class="ftasks-stat-chip">
          <div class="ftasks-stat-chip-value" data-ftasks-kpi="approved">0</div>
          <div class="ftasks-stat-chip-label">Te verwerken</div>
        </div>
        <div class="ftasks-stat-chip">
          <div class="ftasks-stat-chip-value" data-ftasks-kpi="executed">0</div>
          <div class="ftasks-stat-chip-label">Voltooid</div>
        </div>
        <div class="ftasks-stat-chip">
          <div class="ftasks-stat-chip-value" data-ftasks-kpi="failed">0</div>
          <div class="ftasks-stat-chip-label">Mislukt</div>
        </div>
      </div>

      <div style="background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;padding:20px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:14px;font-weight:600;justify-content:space-between">
          <span>Takenlijst</span>
          <span style="font-size:11.5px;color:var(--text-faint);font-weight:400" data-ftasks-total>0 resultaten</span>
        </div>

        <div class="approv-filter-strip" data-ftasks-strip="status">
          <span class="filter-group-label">Status</span>
          <button type="button" class="approv-pill active" data-ftasks-status="PENDING">Te beoordelen <span class="approv-pill-count" data-ftasks-pill="pending">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-status="APPROVED">Te verwerken <span class="approv-pill-count" data-ftasks-pill="approved">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-status="EXECUTED">Voltooid <span class="approv-pill-count" data-ftasks-pill="executed">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-status="FAILED">Mislukt <span class="approv-pill-count" data-ftasks-pill="failed">0</span></button>
          <div class="ftasks-search-wrap">
            <i class="ti ti-search" style="color:var(--text-faint);font-size:14px"></i>
            <input data-ftasks-search class="ftasks-search-input" type="text" placeholder="Zoek op klantnaam&hellip;" autocomplete="off" />
          </div>
        </div>

        <div class="approv-filter-strip" data-ftasks-strip="category">
          <span class="filter-group-label">Type</span>
          <button type="button" class="approv-pill active" data-ftasks-category="all">Alle <span class="approv-pill-count" data-ftasks-cat="all">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-category="arrangement">Regelingen <span class="approv-pill-count" data-ftasks-cat="arrangement">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-category="verify_payment">Betalingsclaims <span class="approv-pill-count" data-ftasks-cat="verify_payment">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-category="escalation">Escalaties <span class="approv-pill-count" data-ftasks-cat="escalation">0</span></button>
        </div>

        <div class="tasks-subfilter-strip hidden" data-ftasks-substrip>
          <span class="filter-group-label">Sub-type</span>
          <button type="button" class="approv-pill active" data-ftasks-subtype="all">Alle</button>
          <button type="button" class="approv-pill"        data-ftasks-subtype="MANUAL_PROPOSE_ARRANGEMENT">Voorstellen <span class="approv-pill-count" data-ftasks-sub="propose">0</span></button>
          <button type="button" class="approv-pill"        data-ftasks-subtype="MANUAL_FOLLOWUP">Follow-ups <span class="approv-pill-count" data-ftasks-sub="followup">0</span></button>
        </div>

        <div style="overflow-x:auto">
          <table class="approv-table" data-ftasks-table>
            <thead>
              <tr>
                <th style="width:140px">Type</th>
                <th>Klant</th>
                <th>Factuur</th>
                <th>Samenvatting</th>
                <th style="width:130px">Voorgesteld</th>
                <th style="text-align:right;width:200px">Acties</th>
              </tr>
            </thead>
            <tbody data-ftasks-tbody>
              <tr><td colspan="6" style="color:var(--text-faint);padding:20px;text-align:center">Laden&hellip;</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ── Wire host (idempotent op host-bound state) ──────────────────────────────
  function wireHost(host) {
    host.querySelectorAll('[data-ftasks-status]').forEach(b => {
      b.addEventListener('click', () => switchStatus(b.getAttribute('data-ftasks-status')));
    });
    host.querySelectorAll('[data-ftasks-category]').forEach(b => {
      b.addEventListener('click', () => switchCategory(b.getAttribute('data-ftasks-category')));
    });
    host.querySelectorAll('[data-ftasks-subtype]').forEach(b => {
      b.addEventListener('click', () => switchSubtype(b.getAttribute('data-ftasks-subtype')));
    });
    const refresh = host.querySelector('[data-ftasks-refresh]');
    if (refresh) refresh.addEventListener('click', loadTasks);
    const search = host.querySelector('[data-ftasks-search]');
    if (search) {
      search.addEventListener('input', (e) => {
        _state.searchQuery = String(e.target.value || '');
        if (_state.searchTimer) clearTimeout(_state.searchTimer);
        _state.searchTimer = setTimeout(loadTasks, 300);
      });
    }
  }

  // ── Wire modals (één keer per document) ─────────────────────────────────────
  function wireModalsOnce() {
    if (_state.wired) return;
    _state.wired = true;

    // Close handlers via data-ftasks-close="<modalKey>".
    const closers = {
      detail:       closeDetail,
      escResolve:   closeEscResolve,
      escAddNote:   closeEscAddNote,
      reject:       closeReject,
      markExec:     closeMarkExec,
      markNotExec:  closeMarkNotExec,
    };
    document.querySelectorAll('[data-ftasks-close]').forEach(b => {
      const key = b.getAttribute('data-ftasks-close');
      const fn = closers[key];
      if (fn) b.addEventListener('click', fn);
    });

    // Click-outside modal closes.
    const modalIds = {
      ftasksDetailModal:           closeDetail,
      ftasksEscResolveModal:       closeEscResolve,
      ftasksEscAddNoteModal:       closeEscAddNote,
      ftasksRejectModal:           closeReject,
      ftasksMarkExecutedModal:     closeMarkExec,
      ftasksMarkNotExecutedModal:  closeMarkNotExec,
    };
    Object.keys(modalIds).forEach(id => {
      const m = document.getElementById(id);
      if (m) m.addEventListener('click', (e) => { if (e.target === m) modalIds[id](); });
    });

    // Escape closes innermost modal.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const order = ['ftasksEscResolveModal','ftasksEscAddNoteModal','ftasksMarkExecutedModal','ftasksMarkNotExecutedModal','ftasksRejectModal','ftasksDetailModal'];
      for (const id of order) {
        const el = document.getElementById(id);
        if (el && !el.classList.contains('hidden')) {
          (modalIds[id] || (() => {}))();
          return;
        }
      }
    });

    // Footer-buttons in detail-modal.
    document.getElementById('ftasksDetailApproveBtn')?.addEventListener('click', approveFromDetail);
    document.getElementById('ftasksDetailRejectBtn')?.addEventListener('click', () => openRejectModalForId(_currentDetailId));
    document.getElementById('ftasksDetailMarkExecutedBtn')?.addEventListener('click', () => openMarkExecutedModal(_currentDetailId, _currentDetailItem));
    document.getElementById('ftasksDetailMarkNotExecutedBtn')?.addEventListener('click', () => openMarkNotExecutedModal(_currentDetailId));
    document.getElementById('ftasksDetailEscResolveBtn')?.addEventListener('click', openEscResolveFromDetail);
    document.getElementById('ftasksDetailEscAddNoteBtn')?.addEventListener('click', openEscAddNoteFromDetail);

    document.getElementById('ftasksRejectConfirmBtn')?.addEventListener('click', confirmReject);
    document.getElementById('ftasksMarkExecConfirmBtn')?.addEventListener('click', submitMarkExecuted);
    document.getElementById('ftasksMarkNotExecConfirmBtn')?.addEventListener('click', submitMarkNotExecuted);
    document.getElementById('ftasksEscResolveConfirmBtn')?.addEventListener('click', submitEscResolve);
    document.getElementById('ftasksEscAddNoteConfirmBtn')?.addEventListener('click', submitEscAddNote);
  }

  // ── Load + render ──────────────────────────────────────────────────────────
  function buildListUrl() {
    let statusCsv;
    if (_state.activeStatus === 'FAILED') {
      statusCsv = 'FAILED,REJECTED,CANCELLED';
    } else {
      statusCsv = _state.activeStatus;
    }
    const params = new URLSearchParams();
    params.set('status', statusCsv);
    if (_state.activeCategory && _state.activeCategory !== 'all') {
      params.set('category', _state.activeCategory);
    }
    // Subtype heeft voorrang over actionTypePin als beide gezet (gebruiker-keuze wint).
    const at = (_state.activeSubtype && _state.activeSubtype !== 'all')
      ? _state.activeSubtype
      : _state.actionTypePin;
    if (at) params.set('action_type', at);
    if (_state.customerId) params.set('customer_id', _state.customerId);
    if (_state.searchQuery && _state.searchQuery.trim()) {
      params.set('search', _state.searchQuery.trim());
    }
    params.set('limit', '100');
    return '/api/tasks-list?' + params.toString();
  }

  async function loadTasks() {
    if (!_state.host) return;
    const tbody = _state.host.querySelector('[data-ftasks-tbody]');
    if (!tbody) return;
    if (_state.loading) return;
    _state.loading = true;
    tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-faint);padding:20px;text-align:center">Laden&hellip;</td></tr>';
    try {
      const url = buildListUrl();
      const r = await window.AgentShared.apiFetch(url);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        tbody.innerHTML = '<tr><td colspan="6" style="color:var(--color-danger,#dc2626);padding:20px;text-align:center">Fout: ' + esc(d.error || ('HTTP ' + r.status)) + '</td></tr>';
        return;
      }
      _state.items = Array.isArray(d.items) ? d.items : [];
      renderCounts(d.counts || {});
      renderRows();
      const hint = _state.host.querySelector('[data-ftasks-total]');
      if (hint) {
        const n = (typeof d.total === 'number') ? d.total : _state.items.length;
        hint.textContent = n + ' resultaten';
      }
    } catch (e) {
      console.error('[finance-tasks loadTasks]', e);
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--color-danger,#dc2626);padding:20px;text-align:center">Fout: ' + esc(e.message) + '</td></tr>';
    } finally {
      _state.loading = false;
    }
  }

  function renderCounts(counts) {
    if (!_state.host) return;
    const byStatus   = counts.byStatus   || {};
    const byCategory = counts.byCategory || {};
    const pending   = byStatus.PENDING   || 0;
    const approved  = byStatus.APPROVED  || 0;
    const executed  = byStatus.EXECUTED  || 0;
    const failedAll = (byStatus.FAILED || 0) + (byStatus.REJECTED || 0) + (byStatus.CANCELLED || 0);
    const open      = pending + approved;

    const setText = (sel, v) => { const el = _state.host.querySelector(sel); if (el) el.textContent = String(v); };
    setText('[data-ftasks-kpi="open"]', open);
    setText('[data-ftasks-kpi="pending"]', pending);
    setText('[data-ftasks-kpi="approved"]', approved);
    setText('[data-ftasks-kpi="executed"]', executed);
    setText('[data-ftasks-kpi="failed"]', failedAll);
    setText('[data-ftasks-pill="pending"]', pending);
    setText('[data-ftasks-pill="approved"]', approved);
    setText('[data-ftasks-pill="executed"]', executed);
    setText('[data-ftasks-pill="failed"]', failedAll);

    const arrangementCnt   = byCategory.arrangement    || 0;
    const verifyPaymentCnt = byCategory.verify_payment || 0;
    const escalationCnt    = byCategory.escalation     || 0;
    const totalCnt         = arrangementCnt + verifyPaymentCnt + escalationCnt;
    setText('[data-ftasks-cat="all"]', totalCnt);
    setText('[data-ftasks-cat="arrangement"]', arrangementCnt);
    setText('[data-ftasks-cat="verify_payment"]', verifyPaymentCnt);
    setText('[data-ftasks-cat="escalation"]', escalationCnt);

    const byActionType = counts.byActionType || null;
    let proposeCnt = 0;
    let followupCnt = 0;
    if (byActionType) {
      proposeCnt  = Number(byActionType.MANUAL_PROPOSE_ARRANGEMENT || 0);
      followupCnt = Number(byActionType.MANUAL_FOLLOWUP || 0);
    } else if (_state.activeSubtype === 'all') {
      for (const it of _state.items) {
        if (it.action_type === 'MANUAL_PROPOSE_ARRANGEMENT') proposeCnt++;
        else if (it.action_type === 'MANUAL_FOLLOWUP')       followupCnt++;
      }
    }
    setText('[data-ftasks-sub="propose"]', proposeCnt);
    setText('[data-ftasks-sub="followup"]', followupCnt);

    const subStrip = _state.host.querySelector('[data-ftasks-substrip]');
    if (subStrip) {
      const visible = (_state.activeCategory === 'all' || _state.activeCategory === 'arrangement');
      subStrip.classList.toggle('hidden', !visible);
    }
  }

  function renderRows() {
    if (!_state.host) return;
    const tbody = _state.host.querySelector('[data-ftasks-tbody]');
    if (!tbody) return;

    let items = _state.items;
    if (_state.activeSubtype && _state.activeSubtype !== 'all') {
      items = items.filter(it => it.action_type === _state.activeSubtype);
    }

    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="color:var(--text-faint);padding:20px;text-align:center">Geen taken in deze view.</td></tr>';
      return;
    }
    const isPending  = _state.activeStatus === 'PENDING';
    const isApproved = _state.activeStatus === 'APPROVED';

    const rows = items.map(it => {
      const cat = categoryForActionType(it.action_type);
      const catLabel = (cat === 'arrangement') ? 'Regeling'
                     : (cat === 'verify_payment') ? 'Betalingsclaim'
                     : (cat === 'escalation') ? 'Escalatie'
                     : 'Overig';
      const joostMini = isJoostAutonomous(it)
        ? ' ' + joostAutonomousBadge({ compact: true })
        : '';
      const typeBadge =
        '<span class="tasks-type-badge cat-' + esc(cat) + '" title="' + esc(it.action_type || '') + '">' +
          esc(catLabel) +
        '</span>' + joostMini +
        '<div style="font-size:10px;color:var(--text-faint);margin-top:3px">' + esc(approvActionLabel(it.action_type)) + '</div>';

      const cust = it.customer;
      const custCell = (cust && cust.id)
        ? '<a href="/modules/klanten.html?id=' + esc(cust.id) + '" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none;font-weight:500" onclick="event.stopPropagation()">' + esc(cust.name || '(onbekend)') + '</a>'
        : esc((cust && cust.name) ? cust.name : '(geen klant)');

      const inv = it.invoice;
      const invCell = (inv && inv.id)
        ? '<span style="font-size:12px"><strong>' + esc(inv.invoice_number || ('inv ' + String(inv.id).slice(0,8))) + '</strong>'
          + (inv.amount_total != null ? ' <span style="color:var(--text-faint);font-size:11px">' + esc(approvFmtEur(inv.amount_total)) + '</span>' : '')
          + '</span>'
        : '<span style="color:var(--text-faint)">—</span>';

      const summary = esc(approvSummary(it));
      const proposed = it.created_at ? esc(relTime(it.created_at)) : '—';

      let actionsCell;
      if (isPending) {
        actionsCell =
          '<button class="approv-mini-btn primary" data-task-approve="' + esc(it.id) + '" onclick="event.stopPropagation()">Approve</button>' +
          '<button class="approv-mini-btn danger"  data-task-reject="'  + esc(it.id) + '" onclick="event.stopPropagation()" style="margin-left:4px">Reject</button>';
      } else if (isApproved) {
        actionsCell =
          '<button class="approv-mini-btn primary" data-task-mark-executed="' + esc(it.id) + '" onclick="event.stopPropagation()">Verwerkt</button>' +
          '<button class="approv-mini-btn danger"  data-task-mark-not-executed="' + esc(it.id) + '" onclick="event.stopPropagation()" style="margin-left:4px">Niet doorgevoerd</button>';
      } else {
        actionsCell = approvStatusBadge(it.status);
      }

      return '<tr class="approv-row clickable" data-task-row="' + esc(it.id) + '">' +
               '<td>' + typeBadge + '</td>' +
               '<td>' + custCell + '</td>' +
               '<td>' + invCell + '</td>' +
               '<td class="approv-truncate" title="' + summary + '">' + summary + '</td>' +
               '<td style="font-size:11.5px;color:var(--text-dim)" title="' + esc(it.created_at ? approvFmtDateTime(it.created_at) : '') + '">' + proposed + '</td>' +
               '<td style="text-align:right;white-space:nowrap">' + actionsCell + '</td>' +
             '</tr>';
    }).join('');
    tbody.innerHTML = rows;

    tbody.querySelectorAll('tr[data-task-row]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input')) return;
        openTaskDetail(tr.getAttribute('data-task-row'));
      });
    });
    tbody.querySelectorAll('[data-task-approve]').forEach(btn => {
      btn.addEventListener('click', () => approveTask(btn.getAttribute('data-task-approve')));
    });
    tbody.querySelectorAll('[data-task-reject]').forEach(btn => {
      btn.addEventListener('click', () => openRejectModalForId(btn.getAttribute('data-task-reject')));
    });
    tbody.querySelectorAll('[data-task-mark-executed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-task-mark-executed');
        const it = _state.items.find(x => x.id === id);
        openMarkExecutedModal(id, it || null);
      });
    });
    tbody.querySelectorAll('[data-task-mark-not-executed]').forEach(btn => {
      btn.addEventListener('click', () => openMarkNotExecutedModal(btn.getAttribute('data-task-mark-not-executed')));
    });
  }

  function switchStatus(status) {
    if (status === _state.activeStatus) return;
    _state.activeStatus = status;
    if (!_state.host) return;
    _state.host.querySelectorAll('[data-ftasks-status]').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-ftasks-status') === status);
    });
    loadTasks();
  }

  function switchCategory(cat) {
    if (cat === _state.activeCategory) return;
    _state.activeCategory = cat;
    if (!_state.host) return;
    _state.host.querySelectorAll('[data-ftasks-category]').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-ftasks-category') === cat);
    });
    if (cat !== 'all' && cat !== 'arrangement' && _state.activeSubtype !== 'all') {
      _state.activeSubtype = 'all';
      _state.host.querySelectorAll('[data-ftasks-subtype]').forEach(p => {
        p.classList.toggle('active', p.getAttribute('data-ftasks-subtype') === 'all');
      });
    }
    loadTasks();
  }

  function switchSubtype(subtype) {
    if (subtype === _state.activeSubtype) return;
    _state.activeSubtype = subtype;
    if (!_state.host) return;
    _state.host.querySelectorAll('[data-ftasks-subtype]').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-ftasks-subtype') === subtype);
    });
    loadTasks();
  }

  // ── Detail-modal: load + render ─────────────────────────────────────────────
  async function openTaskDetail(id) {
    if (!id) return;
    wireModalsOnce();
    _currentDetailId   = id;
    _currentDetailItem = null;

    const modal = document.getElementById('ftasksDetailModal');
    const body  = document.getElementById('ftasksDetailBody');
    const sub   = document.getElementById('ftasksDetailSubtitle');
    ['ftasksDetailApproveBtn','ftasksDetailRejectBtn','ftasksDetailMarkExecutedBtn','ftasksDetailMarkNotExecutedBtn','ftasksDetailEscResolveBtn','ftasksDetailEscAddNoteBtn'].forEach(bid => {
      const b = document.getElementById(bid);
      if (b) b.style.display = 'none';
    });
    if (sub)  sub.textContent  = 'ID: ' + id;
    if (body) body.innerHTML   = '<div style="color:var(--text-faint);padding:14px;text-align:center;font-size:12.5px">Laden&hellip;</div>';
    if (modal) modal.classList.remove('hidden');

    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-detail?id=' + encodeURIComponent(id));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (body) body.innerHTML = '<div style="color:var(--color-danger,#dc2626);padding:14px">Fout: ' + esc(d.error || ('HTTP ' + r.status)) + '</div>';
        return;
      }
      renderTaskDetail(d);
    } catch (e) {
      console.error('[finance-tasks openTaskDetail]', e);
      if (body) body.innerHTML = '<div style="color:var(--color-danger,#dc2626);padding:14px">Fout: ' + esc(e.message) + '</div>';
    }
  }

  function closeDetail() {
    document.getElementById('ftasksDetailModal')?.classList.add('hidden');
    _currentDetailId   = null;
    _currentDetailItem = null;
  }

  function renderConsolidateActionDetail(payload, invoices) {
    const p   = payload || {};
    const cfg = p.subscription_config || {};
    const invByIdLocal = {};
    (Array.isArray(invoices) ? invoices : []).forEach(inv => {
      if (inv && inv.id) invByIdLocal[inv.id] = inv;
    });
    const creditIds = Array.isArray(p.credit_invoice_ids) ? p.credit_invoice_ids : [];
    const creditList = creditIds.map(id => {
      const inv = invByIdLocal[id] || null;
      return {
        invoice_id:     id,
        invoice_number: inv && inv.invoice_number ? inv.invoice_number : null,
        amount:         inv ? Number(inv.amount_total || 0) : null,
      };
    });
    const creditTotal = creditList.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const creditCount = creditList.length;

    const creditRowsHtml = creditList.length
      ? creditList.map(ci => {
          const label = ci.invoice_number ? esc(ci.invoice_number) : 'invoice ' + esc(String(ci.invoice_id).slice(0, 8));
          const amount = (ci.amount != null && ci.amount > 0) ? approvFmtEur(ci.amount) : '';
          return '<li style="font-size:12px;color:var(--text-dim);margin:2px 0">' +
                   '<strong style="color:var(--text)">' + label + '</strong>' +
                   (amount ? ' <span style="color:var(--text-faint);margin-left:8px">' + esc(amount) + '</span>' : '') +
                 '</li>';
        }).join('')
      : '<li style="font-size:12px;color:var(--text-faint)">(geen factuur-details in payload)</li>';

    const installments = cfg.term_count != null ? Number(cfg.term_count) : null;
    const perInstExcl  = cfg.amount_per_invoice_excl_vat != null ? Number(cfg.amount_per_invoice_excl_vat) : null;
    const startsOn     = cfg.starts_on || null;
    const endsOn       = cfg.ends_on   || null;
    const totalExcl    = (installments != null && perInstExcl != null) ? Math.round(installments * perInstExcl * 100) / 100 : null;

    const subSummary = (installments && perInstExcl != null)
      ? '<strong>' + esc(String(installments)) + '</strong> termijnen van <strong>' + esc(approvFmtEur(perInstExcl)) + '</strong> per termijn'
      : (installments ? '<strong>' + esc(String(installments)) + '</strong> termijnen' : '(termijn-info ontbreekt)');

    const totalLine = (totalExcl != null)
      ? 'Totaal nieuwe contract: <strong>' + esc(approvFmtEur(totalExcl)) + '</strong>'
      : 'Totaal nieuwe contract: <span style="color:var(--text-faint)">—</span>';

    const startLine = 'Eerste vervaldatum: <strong>' + esc(startsOn ? approvFmtDateOnly(startsOn) : '—') + '</strong>';
    const endLine   = 'Laatste vervaldatum: <strong>' + esc(endsOn ? approvFmtDateOnly(endsOn) : '—') + '</strong>';

    return '' +
      '<div class="approv-detail-section-title">Consolidatie + nieuwe regeling</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;padding:10px 12px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.25);border-radius:8px">' +
        '<div style="font-size:12.5px;color:var(--text)">' +
          'Credit <strong>' + creditCount + '</strong> ' + (creditCount === 1 ? 'factuur' : 'facturen') +
          ' (totaal <strong>' + esc(approvFmtEur(creditTotal)) + '</strong>):' +
        '</div>' +
        '<ul style="margin:0;padding-left:20px;list-style:disc">' + creditRowsHtml + '</ul>' +
        '<div style="font-size:12.5px;color:var(--text);margin-top:6px">Nieuwe subscription: ' + subSummary + '</div>' +
        '<div style="font-size:12.5px;color:var(--text)">' + totalLine + '</div>' +
        '<div style="font-size:12.5px;color:var(--text)">' + startLine + '</div>' +
        '<div style="font-size:12.5px;color:var(--text)">' + endLine + '</div>' +
      '</div>';
  }

  function renderVerifyPaymentDetail(payload, invoice) {
    const p = payload || {};
    const claimedAmount = (p.claimed_amount != null) ? approvFmtEur(p.claimed_amount) : '—';
    const claimedAt     = p.claimed_at ? approvFmtDateTime(p.claimed_at) : '—';
    const claimText     = p.claim_text ? esc(String(p.claim_text)) : '<span style="color:var(--text-faint)">(geen klantbericht)</span>';
    const messageRef    = p.klant_message_id || p.message_id || p.conversation_id || null;
    const invLine       = invoice && invoice.id
      ? '<strong>' + esc(invoice.invoice_number || ('inv ' + String(invoice.id).slice(0,8))) + '</strong>' +
        (invoice.amount_total != null ? ' <span style="color:var(--text-faint);font-size:11px">' + esc(approvFmtEur(invoice.amount_total)) + '</span>' : '')
      : '<span style="color:var(--text-faint)">—</span>';

    let msgLink = '<span style="color:var(--text-faint)">—</span>';
    if (messageRef && p.conversation_id) {
      const href = '/modules/finance.html?tab=wanbetalers&sub=inbox#inbox=' + encodeURIComponent(p.conversation_id);
      msgLink = '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none">' + esc(String(messageRef)) + ' <i class="ti ti-external-link" style="font-size:11px"></i></a>';
    } else if (messageRef) {
      msgLink = '<code style="color:var(--text-dim);font-size:11.5px">' + esc(String(messageRef)) + '</code>';
    }

    return '' +
      '<div class="approv-detail-section-title">Betalingsclaim van klant</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;padding:10px 12px;background:rgba(168,85,247,0.06);border:1px solid rgba(168,85,247,0.25);border-radius:8px">' +
        '<div style="font-size:12.5px;color:var(--text)">Factuur: ' + invLine + '</div>' +
        '<div style="font-size:12.5px;color:var(--text)">Geclaimd bedrag: <strong>' + esc(claimedAmount) + '</strong></div>' +
        '<div style="font-size:12.5px;color:var(--text)">Geclaimd op: <strong>' + esc(claimedAt) + '</strong></div>' +
        '<div style="font-size:12.5px;color:var(--text)">Bericht-referentie: ' + msgLink + '</div>' +
        '<div style="font-size:12.5px;color:var(--text);margin-top:4px">Klant-bericht:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px">' + claimText + '</div>' +
      '</div>';
  }

  function renderEscalationActionDetail(payload, execution_result) {
    const p = payload || {};
    const sevRaw = (p.severity != null ? String(p.severity) : '').toLowerCase();
    const sevValid = (sevRaw === 'low' || sevRaw === 'medium' || sevRaw === 'high') ? sevRaw : null;
    const sevLabel = sevValid ? ({ low: 'Laag', medium: 'Middel', high: 'Hoog' })[sevValid] : null;
    const sevBadge = sevValid
      ? '<span class="tasks-severity-badge sev-' + esc(sevValid) + '">' + esc(sevLabel) + '</span>'
      : '<span style="color:var(--text-faint);font-size:11.5px">(geen severity)</span>';

    const reasonText = (p.escalation_text != null && String(p.escalation_text).trim().length > 0)
      ? String(p.escalation_text)
      : (p.reason != null && String(p.reason).trim().length > 0)
        ? String(p.reason)
        : (p.rationale != null ? String(p.rationale) : '');
    const reasonBlock = reasonText
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:6px">Reden:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px;margin-top:4px">' + esc(reasonText) + '</div>'
      : '<div style="font-size:12px;color:var(--text-faint);margin-top:4px">(geen reden vastgelegd)</div>';

    const ctxSummary = (p.context_summary != null && String(p.context_summary).trim().length > 0) ? String(p.context_summary) : null;
    const ctxBlock = ctxSummary
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:8px">Context-samenvatting:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px;margin-top:4px">' + esc(ctxSummary) + '</div>'
      : '';

    let convLink = '';
    if (p.conversation_id) {
      const href = '/modules/finance.html?tab=wanbetalers&sub=inbox#inbox?conversation_id=' + encodeURIComponent(p.conversation_id);
      convLink =
        '<div style="margin-top:8px">' +
          '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none;font-size:12px">' +
            '<i class="ti ti-message-circle" style="font-size:11px"></i> Bekijk gesprek <i class="ti ti-external-link" style="font-size:11px"></i>' +
          '</a>' +
        '</div>';
    }

    const createdAt = p.created_at ? approvFmtDateTime(p.created_at) : null;
    const source = p.source ? esc(String(p.source)) : null;

    const r = execution_result || {};
    const progress = Array.isArray(r.progress_log) ? r.progress_log : [];
    const progressBlock = progress.length
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:10px">Voortgangslog:</div>' +
        '<ul style="margin:4px 0 0;padding-left:20px;list-style:disc">' +
          progress.map(ev => {
            const evTs = ev && ev.at ? approvFmtDateTime(ev.at) : '';
            const evBy = ev && ev.by ? String(ev.by) : '';
            const evNote = ev && (ev.note || ev.notes || ev.text) ? String(ev.note || ev.notes || ev.text) : '';
            return '<li style="font-size:12px;color:var(--text-dim);margin:2px 0">' +
                     (evTs ? '<strong style="color:var(--text)">' + esc(evTs) + '</strong> ' : '') +
                     (evBy ? '<span style="color:var(--text-faint);font-size:11px">' + esc(evBy) + '</span> ' : '') +
                     (evNote ? '<div style="margin-top:2px;white-space:pre-wrap">' + esc(evNote) + '</div>' : '') +
                   '</li>';
          }).join('') +
        '</ul>'
      : '';

    return '' +
      '<div class="approv-detail-section-title">Escalatie</div>' +
      '<div style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.25);border-radius:8px">' +
        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">' +
          '<span style="font-size:12.5px;color:var(--text);font-weight:600">Severity:</span>' +
          sevBadge +
          (source ? ' <span style="font-size:11.5px;color:var(--text-faint);margin-left:6px">bron: <strong style="color:var(--text-dim)">' + source + '</strong></span>' : '') +
          (createdAt ? ' <span style="font-size:11.5px;color:var(--text-faint);margin-left:6px">aangemaakt: <strong style="color:var(--text-dim)">' + esc(createdAt) + '</strong></span>' : '') +
        '</div>' +
        reasonBlock +
        ctxBlock +
        convLink +
        progressBlock +
      '</div>';
  }

  function renderProposeArrangementDetail(it, linkedSugg) {
    const p = it && it.payload ? it.payload : {};
    const cust = it && it.customer ? it.customer : null;
    const inv  = it && it.invoice  ? it.invoice  : null;

    const intentRaw = (p.suggested_intent != null) ? String(p.suggested_intent) : '';
    const intentLabels = {
      UITSTEL: 'Uitstel', SPLITSING: 'Splitsing in termijnen',
      ABONNEMENT_PAUZE: 'Abonnement pauze', ABONNEMENT_STOP: 'Abonnement stop',
      KWIJTSCHELDING: 'Kwijtschelding',
      uitstel: 'Uitstel', gespreid: 'Splitsing in termijnen', splitsing: 'Splitsing in termijnen',
      pauze: 'Abonnement pauze', abonnement_pauze: 'Abonnement pauze', abonnement_stop: 'Abonnement stop', kwijtschelding: 'Kwijtschelding',
    };
    const intentLabel = intentRaw ? (intentLabels[intentRaw] || intentRaw) : null;
    const intentBadge = intentLabel
      ? '<span style="display:inline-block;padding:3px 9px;border-radius:6px;background:rgba(56,189,248,0.18);color:#0284c7;font-size:11px;font-weight:600;border:1px solid rgba(56,189,248,0.4)">' + esc(intentLabel) + '</span>'
      : '<span style="color:var(--text-faint);font-size:11.5px">(geen intent voorgesteld)</span>';

    const ctx = p.customer_context || {};
    const ctxParts = [];
    if (ctx.open_amount != null && isFinite(Number(ctx.open_amount))) ctxParts.push('Openstaand: <strong>' + esc(approvFmtEur(Number(ctx.open_amount))) + '</strong>');
    if (ctx.open_invoices_count != null) ctxParts.push('<strong>' + esc(String(ctx.open_invoices_count)) + '</strong> open ' + (Number(ctx.open_invoices_count) === 1 ? 'factuur' : 'facturen'));
    if (ctx.oldest_due_date) ctxParts.push('Oudste vervaldatum: <strong>' + esc(approvFmtDateOnly(ctx.oldest_due_date)) + '</strong>');
    if (ctx.messages_sent_total != null) ctxParts.push('<strong>' + esc(String(ctx.messages_sent_total)) + '</strong> Joost-berichten verstuurd');
    const ctxBlock = ctxParts.length
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:6px">Klant-context:</div>' +
        '<ul style="margin:4px 0 0;padding-left:20px;list-style:disc">' +
          ctxParts.map(s => '<li style="font-size:12px;color:var(--text-dim);margin:1px 0">' + s + '</li>').join('') +
        '</ul>'
      : '<div style="font-size:12px;color:var(--text-faint);margin-top:4px">(geen context-summary in payload)</div>';

    const joostQuote = (linkedSugg && linkedSugg.suggested_reply)
      ? String(linkedSugg.suggested_reply)
      : (p.suggested_reply ? String(p.suggested_reply) : (p.joost_quote ? String(p.joost_quote) : ''));
    const joostQuoteBlock = joostQuote
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:10px;display:flex;align-items:center;gap:6px">' +
          '<i class="ti ti-sparkles" style="color:#7e22ce;font-size:14px"></i><strong>Joost zegt:</strong>' +
        '</div>' +
        '<blockquote style="margin:4px 0 0;padding:8px 12px;border-left:3px solid #7e22ce;background:rgba(168,85,247,0.06);font-size:12px;color:var(--text-dim);white-space:pre-wrap;font-style:italic">' + esc(joostQuote) + '</blockquote>'
      : '';

    const rationaleText = p.rationale ? String(p.rationale) : (p.reason ? String(p.reason) : '');
    const rationaleBlock = rationaleText
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:10px">Reden:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px;margin-top:4px">' + esc(rationaleText) + '</div>'
      : '';

    const wizardParams = new URLSearchParams();
    if (intentRaw)              wizardParams.set('intent',       intentRaw);
    if (cust && cust.id)        wizardParams.set('customer_id',  cust.id);
    if (inv && inv.id)          wizardParams.set('invoice_id',   inv.id);
    if (it && it.id)            wizardParams.set('task_id',      it.id);
    const wizardHref = '/modules/finance.html?tab=wanbetalers&sub=arrangements#arrangement-wizard?' + wizardParams.toString();
    const wizardBtn =
      '<div style="margin-top:12px">' +
        '<a href="' + esc(wizardHref) + '" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">' +
          '<i class="ti ti-wand"></i> Open afspraak-wizard' +
        '</a>' +
      '</div>';

    return '' +
      '<div class="approv-detail-section-title">Voorstel afspraak (Joost)</div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.25);border-radius:8px">' +
        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px">' +
          '<span style="font-size:12.5px;color:var(--text);font-weight:600">Voorgesteld type:</span>' +
          intentBadge +
        '</div>' +
        ctxBlock + rationaleBlock + joostQuoteBlock + wizardBtn +
      '</div>';
  }

  function renderFollowupDetail(it, linkedSugg) {
    const p = it && it.payload ? it.payload : {};
    const cust = it && it.customer ? it.customer : null;

    const reasonText = p.reason ? String(p.reason) : (p.rationale ? String(p.rationale) : (p.followup_reason ? String(p.followup_reason) : ''));
    const reasonBlock = reasonText
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:6px">Reden:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px;margin-top:4px">' + esc(reasonText) + '</div>'
      : '<div style="font-size:12px;color:var(--text-faint);margin-top:4px">(geen reden vastgelegd)</div>';

    const templateRaw = p.suggested_template || p.template_name || null;
    let templateName = '', templateLang = '', templateParams = null;
    if (templateRaw) {
      if (typeof templateRaw === 'string') templateName = templateRaw;
      else if (typeof templateRaw === 'object') {
        templateName   = templateRaw.name || templateRaw.template_name || '';
        templateLang   = templateRaw.language || templateRaw.lang || '';
        templateParams = templateRaw.params || templateRaw.variables || null;
      }
    }
    const templateBlock = templateName
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:10px">Voorgesteld template:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);padding:8px 10px;background:rgba(0,0,0,0.06);border-radius:6px;margin-top:4px">' +
          '<code style="color:var(--text);font-size:11.5px">' + esc(templateName) + '</code>' +
          (templateLang ? ' <span style="color:var(--text-faint);margin-left:6px">(' + esc(templateLang) + ')</span>' : '') +
          (templateParams ? '<pre class="approv-detail-pre" style="margin-top:6px;max-height:120px">' + esc(JSON.stringify(templateParams, null, 2)) + '</pre>' : '') +
        '</div>'
      : '';

    const dueAt = p.due_at ? approvFmtDateTime(p.due_at) : null;
    const assignee = p.assignee_user_id || p.assignee || null;
    const metaParts = [];
    if (dueAt)    metaParts.push('Deadline: <strong>' + esc(dueAt) + '</strong>');
    if (assignee) metaParts.push('Toegewezen aan: <strong>' + esc(String(assignee)) + '</strong>');
    const metaBlock = metaParts.length
      ? '<div style="font-size:12px;color:var(--text-dim);margin-top:8px">' + metaParts.join(' &middot; ') + '</div>'
      : '';

    const joostQuote = (linkedSugg && linkedSugg.suggested_reply) ? String(linkedSugg.suggested_reply) : '';
    const joostQuoteBlock = joostQuote
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:10px;display:flex;align-items:center;gap:6px">' +
          '<i class="ti ti-sparkles" style="color:#7e22ce;font-size:14px"></i><strong>Joost zegt:</strong>' +
        '</div>' +
        '<blockquote style="margin:4px 0 0;padding:8px 12px;border-left:3px solid #7e22ce;background:rgba(168,85,247,0.06);font-size:12px;color:var(--text-dim);white-space:pre-wrap;font-style:italic">' + esc(joostQuote) + '</blockquote>'
      : '';

    const sendParams = new URLSearchParams();
    if (cust && cust.id)       sendParams.set('customer_id',   cust.id);
    if (templateName)          sendParams.set('template',      templateName);
    if (templateLang)          sendParams.set('language',      templateLang);
    if (p.conversation_id)     sendParams.set('conversation_id', p.conversation_id);
    if (it && it.id)           sendParams.set('task_id',       it.id);
    const sendHref = '/modules/finance.html?tab=wanbetalers&sub=inbox#inbox-compose?' + sendParams.toString();
    const sendBtn =
      '<div style="margin-top:12px">' +
        '<a href="' + esc(sendHref) + '" target="_blank" rel="noopener" class="btn btn-primary btn-sm" style="display:inline-flex;align-items:center;gap:6px;text-decoration:none">' +
          '<i class="ti ti-send"></i> Aanmaak template-send' +
        '</a>' +
      '</div>';

    return '' +
      '<div class="approv-detail-section-title">Follow-up bericht</div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:rgba(56,189,248,0.06);border:1px solid rgba(56,189,248,0.25);border-radius:8px">' +
        reasonBlock + templateBlock + joostQuoteBlock + metaBlock + sendBtn +
      '</div>';
  }

  function renderExecutionResult(result, status) {
    const r = result || {};
    const title = (status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED')
      ? 'Niet doorgevoerd' : 'Verwerkt';
    const rows = [];

    if (r.outcome) {
      const outcomeLabels = {
        resolved: 'Opgelost', handed_over: 'Overgedragen', ongoing: 'Lopend (notitie toegevoegd)',
        confirmed_paid: 'Bevestigd betaald', not_found_in_bank: 'Niet gevonden in bank', klant_misvatting: 'Klant-misvatting',
      };
      const outcomeLabel = outcomeLabels[r.outcome] || r.outcome;
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>Outcome:</strong> <span style="color:var(--text-dim);margin-left:6px">' + esc(outcomeLabel) + '</span></div>');
    }

    if (status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED') {
      const reason = r.failure_reason || r.reason || r.error || '';
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>Reden:</strong> <span style="color:var(--text-dim);margin-left:6px">' + (reason ? esc(reason) : '<span style="color:var(--text-faint)">(geen reden vastgelegd)</span>') + '</span></div>');
    }

    if (Array.isArray(r.tl_credit_note_ids) && r.tl_credit_note_ids.length) {
      const items = r.tl_credit_note_ids.map(id => '<li style="font-size:12px;color:var(--text-dim);margin:2px 0"><code style="color:var(--text)">' + esc(String(id)) + '</code></li>').join('');
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>TL credit-note IDs:</strong><ul style="margin:4px 0 0;padding-left:20px;list-style:disc">' + items + '</ul></div>');
    }
    if (r.tl_subscription_id) {
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>TL subscription ID:</strong> <code style="color:var(--text-dim);margin-left:6px">' + esc(String(r.tl_subscription_id)) + '</code></div>');
    }
    if (Array.isArray(r.tl_invoice_ids) && r.tl_invoice_ids.length) {
      const items = r.tl_invoice_ids.map(id => '<li style="font-size:12px;color:var(--text-dim);margin:2px 0"><code style="color:var(--text)">' + esc(String(id)) + '</code></li>').join('');
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>TL invoice IDs:</strong><ul style="margin:4px 0 0;padding-left:20px;list-style:disc">' + items + '</ul></div>');
    }
    if (r.manual_notes) {
      rows.push('<div style="font-size:12.5px;color:var(--text)"><strong>Notities:</strong><div style="color:var(--text-dim);margin-top:4px;white-space:pre-wrap">' + esc(String(r.manual_notes)) + '</div></div>');
    }
    if (status === 'EXECUTED' && (r.marked_executed_at || r.marked_by)) {
      const parts = [];
      if (r.marked_executed_at) parts.push('op ' + esc(approvFmtDateTime(r.marked_executed_at)));
      if (r.marked_by)          parts.push('door ' + esc(String(r.marked_by)));
      rows.push('<div style="font-size:11.5px;color:var(--text-faint)">Handmatig gemarkeerd ' + parts.join(' ') + '</div>');
    }

    const bodyHtml = rows.length ? rows.join('') : '<div style="font-size:12px;color:var(--text-faint)">(geen execution-details vastgelegd)</div>';
    const bgClass = (status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED')
      ? 'background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.25)'
      : 'background:rgba(16,185,129,0.06);border:1px solid rgba(16,185,129,0.25)';

    return '<div class="approv-detail-section-title">' + esc(title) + '</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px;padding:10px 12px;' + bgClass + ';border-radius:8px">' + bodyHtml + '</div>';
  }

  function renderJoostSuggestionDetail(sugg) {
    if (!sugg || !sugg.id) return '';
    const intentLabelMap = {
      verify_payment: 'Betalingsclaim', arrangement_request: 'Verzoek regeling', escalation_needed: 'Escalatie nodig',
      payment_promise: 'Betalingsbelofte', general_question: 'Algemene vraag', other: 'Overig',
    };
    const intent = sugg.detected_intent || null;
    const intentLabel = intent ? (intentLabelMap[intent] || intent) : null;
    const intentBadge = intentLabel
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:6px;background:rgba(168,85,247,0.18);color:#7e22ce;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.3px">' + esc(intentLabel) + '</span>'
      : '';
    const conf = (sugg.confidence != null && isFinite(Number(sugg.confidence))) ? Math.round(Number(sugg.confidence) * 100) + '%' : null;
    const confBadge = conf ? '<span style="font-size:11px;color:var(--text-faint);margin-left:8px">confidence: <strong style="color:var(--text-dim)">' + esc(conf) + '</strong></span>' : '';

    const reply = sugg.suggested_reply ? String(sugg.suggested_reply) : '';
    const replyBlock = reply
      ? '<div style="font-size:12.5px;color:var(--text);margin-top:8px">Voorgesteld antwoord:</div>' +
        '<div style="font-size:12px;color:var(--text-dim);white-space:pre-wrap;padding:8px 10px;background:rgba(0,0,0,0.08);border-radius:6px;margin-top:4px">' + esc(reply) + '</div>'
      : '';

    let convLink = '';
    if (sugg.conversation_id) {
      const href = '/modules/finance.html?tab=wanbetalers&sub=inbox#inbox?conversation_id=' + encodeURIComponent(sugg.conversation_id);
      convLink = '<div style="margin-top:8px"><a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none;font-size:12px"><i class="ti ti-message-circle" style="font-size:11px"></i> Bekijk gesprek <i class="ti ti-external-link" style="font-size:11px"></i></a></div>';
    }

    return '<div class="approv-detail-section-title">Aangemaakt vanuit Joost-suggestie</div>' +
      '<div style="display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:rgba(168,85,247,0.06);border:1px solid rgba(168,85,247,0.25);border-radius:8px">' +
        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px"><i class="ti ti-sparkles" style="color:#7e22ce;font-size:14px"></i><strong style="font-size:12.5px;color:var(--text)">Joost</strong>' + (intentBadge ? ' ' + intentBadge : '') + confBadge + '</div>' +
        replyBlock + convLink +
      '</div>';
  }

  function renderTaskDetail(d) {
    const body = document.getElementById('ftasksDetailBody');
    if (!body) return;
    const it   = d.item || {};
    const cust = d.customer || null;
    const arr  = d.arrangement || null;
    const inv  = d.invoice || (Array.isArray(d.invoices) && d.invoices.length === 1 ? d.invoices[0] : null);
    const approver = d.approver || null;
    const rejecter = d.rejecter || null;
    const status   = it.status || '';
    const isPending  = status === 'PENDING';
    const isApproved = status === 'APPROVED';
    const isExecuted = status === 'EXECUTED';
    const isFailed   = status === 'FAILED' || status === 'REJECTED' || status === 'CANCELLED';
    _currentDetailItem = it;

    const custLink = (cust && cust.id)
      ? '<a href="/modules/klanten.html?id=' + esc(cust.id) + '" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none">' + esc(cust.name || '(onbekend)') + '</a>'
      : (cust ? esc(cust.name || '(onbekend)') : '<span style="color:var(--text-faint)">—</span>');

    const arrCell = (arr && arr.id)
      ? '<a href="/modules/finance.html?tab=wanbetalers&sub=arrangements#arrangement=' + esc(arr.id) + '" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none">' +
          esc(arr.type || 'arrangement') + ' <span style="color:var(--text-faint);font-size:11px">(' + esc(arr.arrangement_status || arr.status || '') + ')</span></a>'
      : '<span style="color:var(--text-faint)">—</span>';

    const invCell = (inv && inv.id)
      ? '<a href="/modules/finance.html?tab=facturen#invoice=' + esc(inv.id) + '" style="color:var(--brand-secondary,var(--accent-cyan,#06b6d4));text-decoration:none">' +
          esc(inv.invoice_number || ('inv ' + String(inv.id).slice(0,8))) +
          (inv.amount_total != null ? ' <span style="color:var(--text-faint);font-size:11px">' + esc(approvFmtEur(inv.amount_total)) + '</span>' : '') + '</a>'
      : '<span style="color:var(--text-faint)">—</span>';

    const payloadJson = JSON.stringify(it.payload || {}, null, 2);
    const rationale = esc((it.payload && (it.payload.rationale || it.payload.reason)) || '—');
    const source = (it.payload && it.payload.source) ? esc(it.payload.source) : 'manual';

    let auditHtml = '';
    if (approver) auditHtml += '<div>Goedgekeurd door: ' + esc(approver.full_name || approver.email || approver.id) + ' op ' + esc(approvFmtDateTime(it.approved_at)) + '</div>';
    if (rejecter) auditHtml += '<div>Afgewezen door: ' + esc(rejecter.full_name || rejecter.email || rejecter.id) + ' op ' + esc(approvFmtDateTime(it.approved_at)) + '</div>';
    if (it.executed_at)   auditHtml += '<div>Uitgevoerd op: ' + esc(approvFmtDateTime(it.executed_at)) + '</div>';
    if (it.reject_reason) auditHtml += '<div style="margin-top:6px"><span style="color:var(--text-faint)">Reden:</span> ' + esc(it.reject_reason) + '</div>';
    if (!auditHtml) auditHtml = '<div style="color:var(--text-faint)">(nog geen audit-events)</div>';

    if (cust && !it.customer) it.customer = cust;
    if (inv  && !it.invoice)  it.invoice  = inv;

    let specificBlock = '';
    const linkedSugg = it.linked_joost_suggestion || null;
    if (it.action_type === 'TL_INVOICE_CONSOLIDATE_AND_RESTART') {
      specificBlock = renderConsolidateActionDetail(it.payload || {}, Array.isArray(d.invoices) ? d.invoices : []);
    } else if (it.action_type === 'MANUAL_VERIFY_PAYMENT') {
      specificBlock = renderVerifyPaymentDetail(it.payload || {}, inv);
    } else if (it.action_type === 'MANUAL_ESCALATION') {
      specificBlock = renderEscalationActionDetail(it.payload || {}, it.execution_result || {});
    } else if (it.action_type === 'MANUAL_PROPOSE_ARRANGEMENT') {
      specificBlock = renderProposeArrangementDetail(it, linkedSugg);
    } else if (it.action_type === 'MANUAL_FOLLOWUP') {
      specificBlock = renderFollowupDetail(it, linkedSugg);
    }

    const joostBlock = renderJoostSuggestionDetail(linkedSugg);

    const sub = document.getElementById('ftasksDetailSubtitle');
    if (sub) {
      const joostFlag = isJoostAutonomous(it);
      sub.innerHTML = 'ID: ' + esc(it.id || _currentDetailId || '') + (joostFlag ? ' &nbsp; ' + joostAutonomousBadge({ compact: false }) : '');
    }

    const executionBlock = (isExecuted || isFailed) ? renderExecutionResult(it.execution_result || {}, status) : '';

    body.innerHTML = '' +
      '<div class="approv-detail-grid">' +
        '<div>Action type</div><div><span class="approv-action-type">' + esc(approvActionLabel(it.action_type)) + '</span> <span style="color:var(--text-faint);font-size:11px;margin-left:6px">' + esc(it.action_type || '') + '</span></div>' +
        '<div>Status</div><div>' + approvStatusBadge(it.status) + '</div>' +
        '<div>Klant</div><div>' + custLink + '</div>' +
        '<div>Factuur</div><div>' + invCell + '</div>' +
        '<div>Arrangement</div><div>' + arrCell + '</div>' +
        '<div>Source</div><div>' + esc(source) + '</div>' +
        '<div>Rationale</div><div>' + rationale + '</div>' +
        '<div>Voorgesteld op</div><div>' + esc(approvFmtDateTime(it.created_at)) + '</div>' +
        '<div>Verloopt op</div><div>' + esc(it.expires_at ? approvFmtDateTime(it.expires_at) : '—') + '</div>' +
        '<div>Gepland voor</div><div>' + esc(it.scheduled_for ? approvFmtDateTime(it.scheduled_for) : '—') + '</div>' +
      '</div>' +
      specificBlock + joostBlock + executionBlock +
      '<div class="approv-detail-section-title">Payload</div>' +
      '<pre class="approv-detail-pre">' + esc(payloadJson) + '</pre>' +
      '<div class="approv-detail-section-title">Audit historie</div>' +
      '<div style="font-size:12px;color:var(--text-dim)">' + auditHtml + '</div>';

    const approveBtn         = document.getElementById('ftasksDetailApproveBtn');
    const rejectBtn          = document.getElementById('ftasksDetailRejectBtn');
    const markExecutedBtn    = document.getElementById('ftasksDetailMarkExecutedBtn');
    const markNotExecutedBtn = document.getElementById('ftasksDetailMarkNotExecutedBtn');
    const escResolveBtn      = document.getElementById('ftasksDetailEscResolveBtn');
    const escAddNoteBtn      = document.getElementById('ftasksDetailEscAddNoteBtn');
    const isEscalation       = it.action_type === 'MANUAL_ESCALATION';

    if (isEscalation) {
      if (approveBtn)         approveBtn.style.display         = 'none';
      if (rejectBtn)          rejectBtn.style.display          = 'none';
      if (markExecutedBtn)    markExecutedBtn.style.display    = 'none';
      if (markNotExecutedBtn) markNotExecutedBtn.style.display = 'none';
      const showEscActions = isPending || isApproved;
      if (escResolveBtn) escResolveBtn.style.display = showEscActions ? '' : 'none';
      if (escAddNoteBtn) escAddNoteBtn.style.display = showEscActions ? '' : 'none';
    } else {
      if (approveBtn)         approveBtn.style.display         = isPending  ? '' : 'none';
      if (rejectBtn)          rejectBtn.style.display          = isPending  ? '' : 'none';
      if (markExecutedBtn)    markExecutedBtn.style.display    = isApproved ? '' : 'none';
      if (markNotExecutedBtn) markNotExecutedBtn.style.display = isApproved ? '' : 'none';
      if (escResolveBtn) escResolveBtn.style.display = 'none';
      if (escAddNoteBtn) escAddNoteBtn.style.display = 'none';
    }
  }

  // ── Actions: approve / reject / mark-executed / mark-not-executed ─────────
  async function approveTask(id) {
    if (!id) return false;
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { window.AgentShared?.showToast('Approve mislukt: ' + (d.error || ('HTTP ' + r.status)), 'error'); return false; }
      window.AgentShared?.showToast('Voorstel goedgekeurd', 'success');
      loadTasks();
      try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
      return true;
    } catch (e) {
      console.error('[finance-tasks approveTask]', e);
      window.AgentShared?.showToast('Approve mislukt: ' + e.message, 'error');
      return false;
    }
  }

  async function approveFromDetail() {
    if (!_currentDetailId) return;
    const id = _currentDetailId;
    const btn = document.getElementById('ftasksDetailApproveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const ok = await approveTask(id);
      if (ok) closeDetail();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Approve'; }
    }
  }

  function openRejectModalForId(id) {
    if (!id) return;
    _rejectContext = { id };
    const txt = document.getElementById('ftasksRejectReason');
    const err = document.getElementById('ftasksRejectError');
    if (txt) txt.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('ftasksRejectModal')?.classList.remove('hidden');
    setTimeout(() => { try { txt?.focus(); } catch (_) {} }, 50);
  }

  function closeReject() {
    document.getElementById('ftasksRejectModal')?.classList.add('hidden');
    _rejectContext = null;
  }

  async function rejectTask(id, reason) {
    if (!id) return false;
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-reject', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, rejection_reason: reason }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { window.AgentShared?.showToast('Reject mislukt: ' + (d.error || ('HTTP ' + r.status)), 'error'); return false; }
      return true;
    } catch (e) {
      console.error('[finance-tasks rejectTask]', e);
      window.AgentShared?.showToast('Reject mislukt: ' + e.message, 'error');
      return false;
    }
  }

  async function confirmReject() {
    const txt = document.getElementById('ftasksRejectReason');
    const err = document.getElementById('ftasksRejectError');
    const reason = (txt && txt.value || '').trim();
    if (!reason) { if (err) { err.textContent = 'Reden is verplicht.'; err.classList.remove('hidden'); } return; }
    if (!_rejectContext || !_rejectContext.id) { closeReject(); return; }
    const ctx = _rejectContext;
    const btn = document.getElementById('ftasksRejectConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const ok = await rejectTask(ctx.id, reason);
      if (ok) {
        window.AgentShared?.showToast('Voorstel afgewezen', 'success');
        if (_currentDetailId === ctx.id) closeDetail();
        loadTasks();
        try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Afwijzen'; }
      closeReject();
    }
  }

  function openMarkExecutedModal(id, item) {
    if (!id) return;
    wireModalsOnce();
    _currentDetailId = id;
    if (item) _currentDetailItem = item;

    const it = item || _currentDetailItem || {};
    const actionLabel = approvActionLabel(it.action_type) || '—';
    const actionType  = it.action_type || '';
    const cust = it.customer || null;
    const arr  = it.arrangement || null;
    const custName = cust && cust.name ? cust.name : '(klant onbekend)';
    let arrLine;
    if (arr && arr.id) {
      const arrType   = arr.type || 'arrangement';
      const arrStatus = arr.arrangement_status || arr.status || '';
      arrLine = 'Arrangement: ' + arrType + (arrStatus ? ' (' + arrStatus + ')' : '');
    } else arrLine = 'Arrangement: —';
    const summary = approvSummary(it);

    const l1 = document.getElementById('ftasksMarkExecCtxLine1');
    const l2 = document.getElementById('ftasksMarkExecCtxLine2');
    const l3 = document.getElementById('ftasksMarkExecCtxLine3');
    if (l1) l1.innerHTML = esc(actionLabel) + (actionType ? ' <span style="color:var(--text-faint);font-size:11px;margin-left:6px">' + esc(actionType) + '</span>' : '') + ' &middot; ' + esc(custName);
    if (l2) l2.textContent = arrLine;
    if (l3) l3.textContent = summary;

    const elCredit = document.getElementById('ftasksMarkExecCreditIds');
    const elSub    = document.getElementById('ftasksMarkExecSubscriptionId');
    const elInv    = document.getElementById('ftasksMarkExecInvoiceIds');
    const elNotes  = document.getElementById('ftasksMarkExecNotes');
    const elErr    = document.getElementById('ftasksMarkExecError');
    if (elCredit) elCredit.value = '';
    if (elSub)    elSub.value    = '';
    if (elInv)    elInv.value    = '';
    if (elNotes)  elNotes.value  = '';
    if (elErr)    { elErr.classList.add('hidden'); elErr.textContent = ''; }

    document.getElementById('ftasksMarkExecutedModal')?.classList.remove('hidden');
    setTimeout(() => { try { elNotes?.focus(); } catch (_) {} }, 50);
  }

  function closeMarkExec() { document.getElementById('ftasksMarkExecutedModal')?.classList.add('hidden'); }

  function parseCommaSeparated(input) {
    return String(input || '').split(',').map(s => s.trim()).filter(s => s.length > 0);
  }

  async function submitMarkExecuted() {
    const elCredit = document.getElementById('ftasksMarkExecCreditIds');
    const elSub    = document.getElementById('ftasksMarkExecSubscriptionId');
    const elInv    = document.getElementById('ftasksMarkExecInvoiceIds');
    const elNotes  = document.getElementById('ftasksMarkExecNotes');
    const elErr    = document.getElementById('ftasksMarkExecError');
    const btn      = document.getElementById('ftasksMarkExecConfirmBtn');

    const notes = (elNotes && elNotes.value || '').trim();
    if (notes.length < 10) { if (elErr) { elErr.textContent = 'Manual notes zijn verplicht (min 10 tekens).'; elErr.classList.remove('hidden'); } return; }

    const id = _currentDetailId;
    if (!id) { if (elErr) { elErr.textContent = 'Geen taak geselecteerd.'; elErr.classList.remove('hidden'); } return; }

    const execution_result = { manual_notes: notes };
    const creditIds = parseCommaSeparated(elCredit ? elCredit.value : '');
    if (creditIds.length) execution_result.tl_credit_note_ids = creditIds;
    const subId = (elSub && elSub.value || '').trim();
    if (subId) execution_result.tl_subscription_id = subId;
    const invIds = parseCommaSeparated(elInv ? elInv.value : '');
    if (invIds.length) execution_result.tl_invoice_ids = invIds;

    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-mark-executed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, execution_result }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || ('HTTP ' + r.status);
        if (elErr) { elErr.textContent = 'Markeren mislukt: ' + msg; elErr.classList.remove('hidden'); }
        return;
      }
      window.AgentShared?.showToast('Taak gemarkeerd als verwerkt', 'success');
      closeMarkExec();
      closeDetail();
      loadTasks();
      try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
    } catch (e) {
      console.error('[finance-tasks submitMarkExecuted]', e);
      if (elErr) { elErr.textContent = 'Markeren mislukt: ' + e.message; elErr.classList.remove('hidden'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Bevestig'; }
    }
  }

  function openMarkNotExecutedModal(id) {
    if (!id) return;
    wireModalsOnce();
    _currentDetailId = id;
    const elReason = document.getElementById('ftasksMarkNotExecReason');
    const elErr    = document.getElementById('ftasksMarkNotExecError');
    if (elReason) elReason.value = '';
    if (elErr)    { elErr.classList.add('hidden'); elErr.textContent = ''; }
    document.getElementById('ftasksMarkNotExecutedModal')?.classList.remove('hidden');
    setTimeout(() => { try { elReason?.focus(); } catch (_) {} }, 50);
  }

  function closeMarkNotExec() { document.getElementById('ftasksMarkNotExecutedModal')?.classList.add('hidden'); }

  async function submitMarkNotExecuted() {
    const elReason = document.getElementById('ftasksMarkNotExecReason');
    const elErr    = document.getElementById('ftasksMarkNotExecError');
    const btn      = document.getElementById('ftasksMarkNotExecConfirmBtn');

    const reason = (elReason && elReason.value || '').trim();
    if (reason.length < 10) { if (elErr) { elErr.textContent = 'Reden is verplicht (min 10 tekens).'; elErr.classList.remove('hidden'); } return; }

    const id = _currentDetailId;
    if (!id) { if (elErr) { elErr.textContent = 'Geen taak geselecteerd.'; elErr.classList.remove('hidden'); } return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-mark-not-executed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, failure_reason: reason }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || ('HTTP ' + r.status);
        if (elErr) { elErr.textContent = 'Markeren mislukt: ' + msg; elErr.classList.remove('hidden'); }
        return;
      }
      window.AgentShared?.showToast('Taak gemarkeerd als niet doorgevoerd', 'success');
      closeMarkNotExec();
      closeDetail();
      loadTasks();
      try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
    } catch (e) {
      console.error('[finance-tasks submitMarkNotExecuted]', e);
      if (elErr) { elErr.textContent = 'Markeren mislukt: ' + e.message; elErr.classList.remove('hidden'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Bevestig'; }
    }
  }

  // ── Escalatie: resolve + add-note ───────────────────────────────────────────
  function openEscResolveFromDetail() {
    if (!_currentDetailId) return;
    wireModalsOnce();
    const sel   = document.getElementById('ftasksEscResolveOutcome');
    const notes = document.getElementById('ftasksEscResolveNotes');
    const err   = document.getElementById('ftasksEscResolveError');
    if (sel)   sel.value   = 'resolved';
    if (notes) notes.value = '';
    if (err)   { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('ftasksEscResolveModal')?.classList.remove('hidden');
    setTimeout(() => { try { notes?.focus(); } catch (_) {} }, 50);
  }

  function closeEscResolve() { document.getElementById('ftasksEscResolveModal')?.classList.add('hidden'); }

  async function submitEscResolve() {
    const sel   = document.getElementById('ftasksEscResolveOutcome');
    const notes = document.getElementById('ftasksEscResolveNotes');
    const err   = document.getElementById('ftasksEscResolveError');
    const btn   = document.getElementById('ftasksEscResolveConfirmBtn');

    const outcome = sel ? String(sel.value || '') : '';
    if (outcome !== 'resolved' && outcome !== 'handed_over') {
      if (err) { err.textContent = 'Kies een outcome.'; err.classList.remove('hidden'); } return;
    }
    const notesText = (notes && notes.value || '').trim();
    if (notesText.length < 10) {
      if (err) { err.textContent = 'Notes zijn verplicht (min 10 tekens).'; err.classList.remove('hidden'); } return;
    }
    const id = _currentDetailId;
    if (!id) { if (err) { err.textContent = 'Geen taak geselecteerd.'; err.classList.remove('hidden'); } return; }

    const execution_result = { outcome, manual_notes: notesText };

    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-mark-executed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, execution_result }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || ('HTTP ' + r.status);
        if (err) { err.textContent = 'Afhandelen mislukt: ' + msg; err.classList.remove('hidden'); } return;
      }
      window.AgentShared?.showToast('Escalatie afgehandeld', 'success');
      closeEscResolve();
      closeDetail();
      loadTasks();
      try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
    } catch (e) {
      console.error('[finance-tasks submitEscResolve]', e);
      if (err) { err.textContent = 'Afhandelen mislukt: ' + e.message; err.classList.remove('hidden'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Bevestig'; }
    }
  }

  function openEscAddNoteFromDetail() {
    if (!_currentDetailId) return;
    wireModalsOnce();
    const txt = document.getElementById('ftasksEscAddNoteText');
    const err = document.getElementById('ftasksEscAddNoteError');
    if (txt) txt.value = '';
    if (err) { err.classList.add('hidden'); err.textContent = ''; }
    document.getElementById('ftasksEscAddNoteModal')?.classList.remove('hidden');
    setTimeout(() => { try { txt?.focus(); } catch (_) {} }, 50);
  }

  function closeEscAddNote() { document.getElementById('ftasksEscAddNoteModal')?.classList.add('hidden'); }

  async function submitEscAddNote() {
    const txt = document.getElementById('ftasksEscAddNoteText');
    const err = document.getElementById('ftasksEscAddNoteError');
    const btn = document.getElementById('ftasksEscAddNoteConfirmBtn');

    const note = (txt && txt.value || '').trim();
    if (note.length < 10) { if (err) { err.textContent = 'Notitie is verplicht (min 10 tekens).'; err.classList.remove('hidden'); } return; }
    const id = _currentDetailId;
    if (!id) { if (err) { err.textContent = 'Geen taak geselecteerd.'; err.classList.remove('hidden'); } return; }

    const execution_result = { outcome: 'ongoing', manual_notes: note };

    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    try {
      const r = await window.AgentShared.apiFetch('/api/pending-actions-mark-executed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, execution_result }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = d.error || ('HTTP ' + r.status);
        if (err) { err.textContent = 'Notitie toevoegen mislukt: ' + msg; err.classList.remove('hidden'); } return;
      }
      window.AgentShared?.showToast('Notitie toegevoegd', 'success');
      closeEscAddNote();
      try { openTaskDetail(id); } catch (_) {}
      loadTasks();
      try { window.AgentShared?.refreshApprovalsBadge?.(); } catch (_) {}
    } catch (e) {
      console.error('[finance-tasks submitEscAddNote]', e);
      if (err) { err.textContent = 'Notitie toevoegen mislukt: ' + e.message; err.classList.remove('hidden'); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Opslaan'; }
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  function mount(opts) {
    opts = opts || {};
    const host = opts.host;
    if (!host || !(host instanceof HTMLElement)) {
      console.warn('[FinanceTasks.mount] host element ontbreekt of is geen HTMLElement.');
      return;
    }
    if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') {
      console.warn('[FinanceTasks.mount] AgentShared.apiFetch ontbreekt — laad eerst /modules/shared/agent-shared.js.');
      host.innerHTML = '<div style="padding:20px;color:var(--color-danger,#dc2626);font-size:13px">FinanceTasks dependency-fout: AgentShared niet geladen.</div>';
      return;
    }

    // Idempotent: zelfde host + al gemount => alleen reload (filter-prefill kan
    // veranderd zijn).
    const alreadyMounted = host.hasAttribute('data-ftasks-mounted');
    if (alreadyMounted && _state.host === host) {
      // Update filter-prefill als opts gewijzigd zijn.
      const newStatus    = opts.statusFilter    || _state.activeStatus;
      const newActionPin = opts.actionTypeFilter || null;
      const newCustomer  = opts.customerId       || null;
      const changed = (newStatus !== _state.activeStatus) || (newActionPin !== _state.actionTypePin) || (newCustomer !== _state.customerId);
      _state.activeStatus  = newStatus;
      _state.actionTypePin = newActionPin;
      _state.customerId    = newCustomer;
      if (changed) {
        host.querySelectorAll('[data-ftasks-status]').forEach(p => {
          p.classList.toggle('active', p.getAttribute('data-ftasks-status') === _state.activeStatus);
        });
        loadTasks();
      }
      return;
    }

    injectStyles();
    ensureModalsInBody();

    _state.host = host;
    _state.activeStatus    = opts.statusFilter    || 'PENDING';
    _state.actionTypePin   = opts.actionTypeFilter || null;
    _state.customerId      = opts.customerId       || null;
    _state.activeCategory  = 'all';
    _state.activeSubtype   = 'all';
    _state.searchQuery     = '';
    _state.items           = [];

    renderHostShell(host);
    host.querySelectorAll('[data-ftasks-status]').forEach(p => {
      p.classList.toggle('active', p.getAttribute('data-ftasks-status') === _state.activeStatus);
    });
    wireHost(host);
    wireModalsOnce();
    host.setAttribute('data-ftasks-mounted', '1');

    loadTasks();
  }

  function refresh() { loadTasks(); }

  window.FinanceTasks = {
    __loaded: true,
    mount,
    refresh,
  };
})();
