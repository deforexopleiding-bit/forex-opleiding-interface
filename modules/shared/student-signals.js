/* modules/shared/student-signals.js
   Helpers voor de mentor-zijde van student_signals (mentor meldt een
   aandachtspunt). Wordt geladen door mentor-home + mentor-dashboard;
   admin-zijde (students-overview Aandachtspunten-tab) heeft eigen UI.

   API:
     - StudentSignals.fetchActiveSignals()       → Map<bubble_student_id, signal>
     - StudentSignals.ensureModalMounted()        → idempotent: voegt modal-DOM toe
     - StudentSignals.openCreate(student, onSuccess)
         student = { bubble_student_id, name?, email? }
         onSuccess(signal) wordt aangeroepen na 201; signal = { id, status:'open', type, ... }
     - StudentSignals.badgeHtml()                 → '<span class="ss-badge">Gemeld</span>'

   Geen dependencies behalve window.AgentShared.apiFetch.
*/
(function () {
  'use strict';

  const TYPE_LABELS = {
    eerste_call         : 'Eerste call lukt niet',
    reageert_niet       : 'Reageert niet',
    niet_bereikbaar     : 'Niet bereikbaar',
    geen_reactie_bellen : 'Geen reactie — bellen',
    anders              : 'Anders',
  };
  const TYPE_ORDER = ['eerste_call','reageert_niet','niet_bereikbaar','geen_reactie_bellen','anders'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  let mounted = false;
  let _activeStudent = null;
  let _activeOnSuccess = null;
  let _busy = false;

  function injectStyleOnce() {
    if (document.getElementById('ssStyles')) return;
    const s = document.createElement('style');
    s.id = 'ssStyles';
    s.textContent = `
      .ss-badge { display:inline-block; padding:2px 7px; border-radius:999px; background:rgba(245,158,11,0.18); color:#92400e; font-size:10.5px; font-weight:700; letter-spacing:0.02em; }
      .ss-btn   { padding:4px 9px; font-size:11px; font-weight:600; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); cursor:pointer; font-family:inherit; display:inline-flex; align-items:center; gap:4px; }
      .ss-btn:hover { background:var(--bg-elev); }
      .ss-mb { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:none; align-items:center; justify-content:center; z-index:1000; }
      .ss-mb.show { display:flex; }
      .ss-mw { background:var(--bg-elev); border:1px solid var(--border); border-radius:10px; width:min(440px,92vw); box-shadow:0 12px 36px rgba(0,0,0,0.24); }
      .ss-mh { padding:12px 14px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; }
      .ss-mh-title { font-size:13.5px; font-weight:700; color:var(--text); display:flex; align-items:center; gap:6px; }
      .ss-mh-close { background:transparent; border:none; cursor:pointer; color:var(--text-dim); font-size:18px; }
      .ss-mc { padding:14px; }
      .ss-mc label { display:block; font-size:11.5px; font-weight:600; color:var(--text-dim); margin-bottom:4px; margin-top:8px; }
      .ss-mc select, .ss-mc textarea { width:100%; padding:7px 9px; border:1px solid var(--border); border-radius:7px; background:var(--bg); font-family:inherit; font-size:13px; color:var(--text); }
      .ss-mc textarea { resize:vertical; min-height:80px; }
      .ss-mc .ss-mc-err { font-size:12px; color:#991b1b; margin-top:8px; display:none; }
      .ss-mc .ss-mc-err.show { display:block; }
      .ss-mc .ss-mc-info { font-size:12px; color:var(--text-dim); margin-bottom:8px; }
      .ss-mf { padding:10px 14px; border-top:1px solid var(--border); display:flex; justify-content:flex-end; gap:8px; }
      .ss-mf button { padding:7px 12px; font-size:12.5px; font-weight:600; border:1px solid var(--border); border-radius:7px; background:var(--bg); color:var(--text); cursor:pointer; font-family:inherit; }
      .ss-mf button.primary { background:var(--brand-primary,#093d54); color:#fff; border-color:transparent; }
      .ss-toast { position:fixed; right:18px; bottom:18px; padding:10px 14px; border-radius:8px; font-size:12.5px; font-weight:600; color:#fff; z-index:1001; box-shadow:0 4px 12px rgba(0,0,0,0.18); pointer-events:none; opacity:0; transform:translateY(8px); transition:opacity 180ms ease, transform 180ms ease; }
      .ss-toast.show  { opacity:1; transform:translateY(0); }
      .ss-toast.ok    { background:#15803d; }
      .ss-toast.err   { background:#991b1b; }
    `;
    document.head.appendChild(s);
  }

  function ensureModalMounted() {
    if (mounted) return;
    injectStyleOnce();
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div id="ssMb" class="ss-mb" role="dialog" aria-modal="true" aria-labelledby="ssMbTitle">
        <div class="ss-mw">
          <div class="ss-mh">
            <div class="ss-mh-title" id="ssMbTitle">Aandachtspunt melden</div>
            <button type="button" class="ss-mh-close" id="ssMbClose" aria-label="Sluiten">×</button>
          </div>
          <div class="ss-mc">
            <div class="ss-mc-info" id="ssMbStudent"></div>
            <label for="ssMbType">Type</label>
            <select id="ssMbType">
              ${TYPE_ORDER.map((k) => `<option value="${esc(k)}">${esc(TYPE_LABELS[k])}</option>`).join('')}
            </select>
            <label for="ssMbToel">Toelichting (optioneel)</label>
            <textarea id="ssMbToel" maxlength="2000" placeholder="Wat is er aan de hand?"></textarea>
            <div class="ss-mc-err" id="ssMbErr"></div>
          </div>
          <div class="ss-mf">
            <button type="button" id="ssMbCancel">Annuleren</button>
            <button type="button" class="primary" id="ssMbSave">Melden</button>
          </div>
        </div>
      </div>
      <div id="ssToast" class="ss-toast"></div>
    `;
    document.body.appendChild(wrap);

    document.getElementById('ssMbClose').addEventListener('click', closeModal);
    document.getElementById('ssMbCancel').addEventListener('click', closeModal);
    document.getElementById('ssMbSave').addEventListener('click', submitSignal);
    document.getElementById('ssMb').addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) closeModal();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && document.getElementById('ssMb').classList.contains('show')) closeModal();
    });
    mounted = true;
  }

  function showToast(kind, text) {
    const el = document.getElementById('ssToast');
    if (!el) return;
    el.classList.remove('ok','err');
    el.classList.add(kind);
    el.textContent = text;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2400);
  }

  function openCreate(student, onSuccess) {
    ensureModalMounted();
    if (!student || !student.bubble_student_id) return;
    _activeStudent = student;
    _activeOnSuccess = (typeof onSuccess === 'function') ? onSuccess : null;
    _busy = false;
    document.getElementById('ssMbStudent').textContent =
      (student.name || student.email || '—') + (student.email ? ' · ' + student.email : '');
    document.getElementById('ssMbType').value = TYPE_ORDER[0];
    document.getElementById('ssMbToel').value = '';
    const err = document.getElementById('ssMbErr');
    err.textContent = ''; err.classList.remove('show');
    document.getElementById('ssMb').classList.add('show');
  }
  function closeModal() {
    document.getElementById('ssMb').classList.remove('show');
    _activeStudent = null; _activeOnSuccess = null;
  }
  async function submitSignal() {
    if (_busy || !_activeStudent) return;
    const type = document.getElementById('ssMbType').value || '';
    const toel = document.getElementById('ssMbToel').value || '';
    const err  = document.getElementById('ssMbErr');
    const saveBtn = document.getElementById('ssMbSave');
    _busy = true; saveBtn.disabled = true;
    try {
      const r = await window.AgentShared.apiFetch('/api/student-signals-create', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({
          bubble_student_id : _activeStudent.bubble_student_id,
          type              : type,
          toelichting       : toel || null,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        err.textContent = d?.error || ('Fout: HTTP ' + r.status);
        err.classList.add('show');
        return;
      }
      const signal = {
        id                : d.id,
        bubble_student_id : _activeStudent.bubble_student_id,
        type              : type,
        toelichting       : toel || null,
        status            : 'open',
      };
      if (_activeOnSuccess) {
        try { _activeOnSuccess(signal); } catch (e) { console.warn('[student-signals] onSuccess fout:', e?.message || e); }
      }
      closeModal();
      showToast('ok', 'Aandachtspunt gemeld');
    } catch (e) {
      err.textContent = e?.message || 'Onbekende fout';
      err.classList.add('show');
    } finally {
      _busy = false; saveBtn.disabled = false;
    }
  }

  async function fetchActiveSignals() {
    const map = new Map();
    try {
      const r = await window.AgentShared.apiFetch('/api/student-signals-list?status=open,opnieuw_opvolgen');
      if (!r.ok) return map;
      const d = await r.json().catch(() => ({}));
      const items = Array.isArray(d?.signals) ? d.signals : [];
      for (const s of items) {
        if (s && s.bubble_student_id && !map.has(s.bubble_student_id)) {
          map.set(s.bubble_student_id, s);
        }
      }
    } catch (e) {
      console.warn('[student-signals] fetchActiveSignals:', e?.message || e);
    }
    return map;
  }

  function badgeHtml() {
    return '<span class="ss-badge">Gemeld</span>';
  }
  // role="button" + tabindex zodat dit element binnen een <a class="card">
  // valide is (button-in-anchor is geen valid HTML). Callers wiren keuze
  // van click-/keydown-handler zelf.
  function buttonHtml() {
    return '<span role="button" tabindex="0" class="ss-btn ss-signal-btn"><i class="ti ti-flag"></i> Melden</span>';
  }

  window.StudentSignals = {
    ensureModalMounted,
    openCreate,
    fetchActiveSignals,
    badgeHtml,
    buttonHtml,
  };
})();
