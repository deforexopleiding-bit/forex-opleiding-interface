/* ============================================================
   Quick Task — globale "Nieuwe taak"-knop + modal in de sidebar.
   Self-contained: niets injecteren als de RBAC-permission ontbreekt of
   als één van de helpers (AgentShared / AuthShared / RBAC) niet
   beschikbaar is. Faalt stil bij elke onverwachte fout zodat de
   sidebar/pagina nooit breekt.

   Gebruik: dynamisch geladen door /modules/shared/sidebar.js direct na
   mountSidebar. Geen <script>-tag per pagina nodig.

   ID-prefix `qt-` om botsing met Takenbeheer's eigen modal te vermijden
   (taken.html gebruikt #overlayNieuw, #fTitel, ... — die blijven intact).
   ============================================================ */
(function () {
  'use strict';

  if (window.__quickTaskLoaded) return;
  window.__quickTaskLoaded = true;

  var CAT_OPTIONS = ['Sales', 'Onboarding', 'Mentoring', 'Finance', 'Klant', 'Marketing', 'Intern', 'Overige'];
  var PRIO_OPTIONS = ['Urgent', 'Hoog', 'Normaal', 'Laag'];

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toast(msg, kind) {
    try {
      if (window.AgentShared && typeof window.AgentShared.showToast === 'function') {
        window.AgentShared.showToast(msg, kind || 'success');
      }
    } catch (_) {}
  }

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  async function waitForRbac(maxMs) {
    var start = Date.now();
    while (!window.RBAC || typeof window.RBAC.ensurePermissionsLoaded !== 'function') {
      if (Date.now() - start > maxMs) return null;
      await new Promise(function (r) { setTimeout(r, 50); });
    }
    return window.RBAC;
  }

  function injectButton() {
    var footer = document.querySelector('.sidebar-footer');
    if (!footer) return null;
    if (document.getElementById('qtSidebarBtn')) return document.getElementById('qtSidebarBtn');

    var btn = document.createElement('button');
    btn.id = 'qtSidebarBtn';
    btn.type = 'button';
    btn.title = 'Snel een taak aanmaken';
    btn.setAttribute('aria-label', 'Nieuwe taak');
    btn.style.cssText = [
      'display:flex', 'align-items:center', 'gap:8px',
      'width:calc(100% - 16px)', 'margin:0 8px 10px',
      'padding:9px 12px', 'border:0', 'border-radius:10px',
      'background:var(--accent-grad, linear-gradient(135deg,#093d54 0%,#688b9b 100%))',
      'color:#fff', 'font:600 13px/1 Inter, system-ui, sans-serif',
      'cursor:pointer', 'box-shadow:0 1px 3px rgba(0,0,0,0.15)'
    ].join(';');
    btn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
        '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>' +
      '</svg>' +
      '<span>Nieuwe taak</span>';
    btn.addEventListener('click', openModal);

    // Inject boven .footer-user; valt terug op appendChild.
    var anchor = footer.querySelector('.footer-user');
    if (anchor && anchor.parentNode === footer) {
      footer.insertBefore(btn, anchor);
    } else {
      footer.appendChild(btn);
    }
    return btn;
  }

  function injectModal() {
    if (document.getElementById('qtOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'qtOverlay';
    overlay.style.cssText = [
      'position:fixed', 'inset:0', 'background:rgba(0,0,0,0.55)',
      'display:none', 'align-items:center', 'justify-content:center',
      'z-index:9999', 'padding:24px'
    ].join(';');

    var prioOpts = PRIO_OPTIONS.map(function (p) {
      return '<option value="' + esc(p) + '"' + (p === 'Normaal' ? ' selected' : '') + '>' + esc(p) + '</option>';
    }).join('');
    var catOpts = CAT_OPTIONS.map(function (c) {
      return '<option value="' + esc(c) + '"' + (c === 'Overige' ? ' selected' : '') + '>' + esc(c) + '</option>';
    }).join('');

    var label = 'font:500 12px Inter, system-ui, sans-serif;color:var(--text-dim,#475569);margin:0 0 4px;display:block';
    var input = 'width:100%;padding:8px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--bg-elev,#fff);color:var(--text,#0f172a);font:400 13px Inter, system-ui, sans-serif;font-family:inherit';
    var grp   = 'margin-bottom:12px';

    overlay.innerHTML = (
      '<div role="dialog" aria-modal="true" aria-labelledby="qtTitleHdr" ' +
        'style="background:var(--bg-elev,#fff);color:var(--text,#0f172a);border:1px solid var(--border,#e5e7eb);border-radius:14px;width:100%;max-width:520px;padding:20px 22px;box-shadow:0 12px 40px rgba(0,0,0,0.25)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">' +
          '<div id="qtTitleHdr" style="font:700 16px Inter, system-ui, sans-serif">Nieuwe taak</div>' +
          '<button type="button" id="qtCloseBtn" aria-label="Sluiten" style="background:transparent;border:0;font-size:22px;line-height:1;color:var(--text-dim,#475569);cursor:pointer">×</button>' +
        '</div>' +

        '<div style="' + grp + '"><label style="' + label + '">Titel *</label>' +
          '<input id="qtTitel" type="text" maxlength="200" autocomplete="off" style="' + input + '" /></div>' +

        '<div style="' + grp + '"><label style="' + label + '">Omschrijving</label>' +
          '<textarea id="qtOmschrijving" rows="3" maxlength="2000" style="' + input + ';resize:vertical;min-height:60px"></textarea></div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;' + grp + '">' +
          '<div><label style="' + label + '">Prioriteit</label>' +
            '<select id="qtPrioriteit" style="' + input + '">' + prioOpts + '</select></div>' +
          '<div><label style="' + label + '">Categorie</label>' +
            '<select id="qtCategorie" style="' + input + '">' + catOpts + '</select></div>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;' + grp + '">' +
          '<div><label style="' + label + '">Toewijzen aan</label>' +
            '<select id="qtToegewezen" style="' + input + '"><option value="">— Mijzelf —</option></select></div>' +
          '<div><label style="' + label + '">Deadline</label>' +
            '<input id="qtDeadline" type="date" style="' + input + '" /></div>' +
        '</div>' +

        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:6px">' +
          '<button type="button" id="qtCancelBtn" style="padding:8px 14px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:transparent;color:var(--text,#0f172a);cursor:pointer;font:600 13px Inter, system-ui, sans-serif">Annuleren</button>' +
          '<button type="button" id="qtSaveBtn" style="padding:8px 16px;border:0;border-radius:8px;background:var(--accent-grad, linear-gradient(135deg,#093d54 0%,#688b9b 100%));color:#fff;cursor:pointer;font:600 13px Inter, system-ui, sans-serif">Opslaan</button>' +
        '</div>' +
      '</div>'
    );

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeModal();
    });
    document.body.appendChild(overlay);

    document.getElementById('qtCloseBtn').addEventListener('click', closeModal);
    document.getElementById('qtCancelBtn').addEventListener('click', closeModal);
    document.getElementById('qtSaveBtn').addEventListener('click', saveTask);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && overlay.style.display !== 'none') closeModal();
    });
  }

  var _profilesLoaded = false;
  async function loadProfilesIntoSelect() {
    if (_profilesLoaded) return;
    var sel = document.getElementById('qtToegewezen');
    if (!sel) return;
    try {
      var r = await window.AgentShared.apiFetch('/api/profiles-list');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var d = await r.json();
      var list = Array.isArray(d && d.members) ? d.members : [];
      // Bewaar de bestaande "— Mijzelf —"-optie.
      list.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.id;
        o.textContent = (p.full_name || p.email || p.id) + (p.role ? '  ·  ' + p.role : '');
        sel.appendChild(o);
      });
      _profilesLoaded = true;
    } catch (e) {
      console.warn('[quick-task] profiles-list:', e && e.message);
    }
  }

  function resetForm() {
    var ids = ['qtTitel', 'qtOmschrijving', 'qtDeadline'];
    ids.forEach(function (id) { var el = document.getElementById(id); if (el) el.value = ''; });
    var p = document.getElementById('qtPrioriteit'); if (p) p.value = 'Normaal';
    var c = document.getElementById('qtCategorie'); if (c) c.value = 'Overige';
    var a = document.getElementById('qtToegewezen'); if (a) a.value = '';
  }

  function openModal() {
    var ov = document.getElementById('qtOverlay');
    if (!ov) return;
    resetForm();
    ov.style.display = 'flex';
    loadProfilesIntoSelect();
    setTimeout(function () {
      var t = document.getElementById('qtTitel');
      if (t) t.focus();
    }, 30);
  }

  function closeModal() {
    var ov = document.getElementById('qtOverlay');
    if (ov) ov.style.display = 'none';
  }

  var _saving = false;
  async function saveTask() {
    if (_saving) return;
    var titel = (document.getElementById('qtTitel').value || '').trim();
    if (!titel) {
      var t = document.getElementById('qtTitel');
      if (t) t.focus();
      return;
    }
    var assignedToId = document.getElementById('qtToegewezen').value || '';

    // Self-default: zonder assignee gaat de taak naar de maker zelf.
    if (!assignedToId) {
      try {
        var prof = window.AuthShared ? await window.AuthShared.getProfile() : null;
        if (prof && prof.id) assignedToId = prof.id;
      } catch (_) { /* fall-through; server zal niets met lege id doen */ }
    }

    var task = {
      id           : (window.crypto && typeof window.crypto.randomUUID === 'function')
                       ? window.crypto.randomUUID()
                       : ('qt-' + Math.random().toString(16).slice(2) + Date.now().toString(16)),
      titel        : titel,
      omschrijving : (document.getElementById('qtOmschrijving').value || '').trim(),
      prioriteit   : document.getElementById('qtPrioriteit').value || 'Normaal',
      categorie    : document.getElementById('qtCategorie').value || 'Overige',
      assignedToId : assignedToId,
      deadline     : document.getElementById('qtDeadline').value || '',
      status       : 'todo',
      aangemaakt   : new Date().toISOString()
    };

    var btn = document.getElementById('qtSaveBtn');
    _saving = true;
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.textContent = 'Opslaan…'; }
    try {
      var r = await window.AgentShared.apiFetch('/api/taken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: task })
      });
      if (!r.ok) {
        var msg = 'Taak aanmaken mislukt';
        try { var d = await r.json(); if (d && d.error) msg = d.error; } catch (_) {}
        toast(msg, 'error');
        return;
      }
      toast('Taak aangemaakt', 'success');
      closeModal();
      // Refresh badge in sidebar (zelfde helper als taken-badge.js gebruikt).
      try {
        if (window.AgentShared && typeof window.AgentShared.refreshTakenBadge === 'function') {
          window.AgentShared.refreshTakenBadge();
        }
      } catch (_) {}
      // Bij gebruik op de Takenbeheer-pagina: re-fetch + render het board.
      try {
        if (typeof window.__takenReload === 'function') await window.__takenReload();
      } catch (_) {}
    } catch (e) {
      toast('Netwerkfout bij opslaan', 'error');
    } finally {
      _saving = false;
      if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'Opslaan'; }
    }
  }

  async function init() {
    try {
      // Sidebar moet gemount zijn; mount kan racen met dit script.
      if (!document.querySelector('.sidebar-footer')) {
        await new Promise(function (resolve) {
          var done = false;
          function check() {
            if (done) return;
            if (document.querySelector('.sidebar-footer')) { done = true; resolve(); return true; }
            return false;
          }
          if (check()) return;
          window.addEventListener('sidebar:mounted', function () { check(); }, { once: true });
          // Final safety: poll-loop maximaal 3s.
          var start = Date.now();
          (function tick() {
            if (check()) return;
            if (Date.now() - start > 3000) { done = true; resolve(); return; }
            setTimeout(tick, 80);
          })();
        });
      }
      if (!document.querySelector('.sidebar-footer')) return; // geen sidebar — niets te doen

      // RBAC gate.
      var rbac = await waitForRbac(3000);
      if (!rbac) return;
      try { await rbac.ensurePermissionsLoaded(); } catch (_) { return; }
      if (!rbac.canSync || !rbac.canSync('taken.task.create')) return;

      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;

      injectModal();
      injectButton();
    } catch (e) {
      // Stilte: een falende quick-task mag de sidebar niet meeslepen.
      try { console.warn('[quick-task] init:', e && e.message); } catch (_) {}
    }
  }

  ready(function () { init(); });
})();
