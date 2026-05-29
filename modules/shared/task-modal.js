// modules/shared/task-modal.js
//
// Gedeeld "Snel taak aanmaken"-modal. Wordt geladen in elke module die een
// "+ Taak"-knop toont. Exposeert window.AgentShared.openCreateTaskModal({ prefill }).
//
// prefill velden:
//   - module        (string)  → wordt opgeslagen in categorie of als prefix in titel
//   - titel         (string)
//   - omschrijving  (string)
//   - prioriteit    ('Laag'|'Normaal'|'Hoog'|'Urgent')
//   - deadline      (yyyy-mm-dd)
//   - email_id, email_subject, customer_id (passthrough naar payload)
//
// Bij submit: POST /api/taken met action='create' en task-payload.
// Na success: toast + window.AgentShared.refreshTakenBadge() trigger.

(function () {
  if (window.AgentShared && window.AgentShared.openCreateTaskModal) return;

  var STYLE_INJECTED = false;
  var teamMembersCache = null;
  var teamMembersPromise = null;

  function injectStyle() {
    if (STYLE_INJECTED) return;
    STYLE_INJECTED = true;
    var css = `
      .tm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9999; display: none; align-items: center; justify-content: center; padding: 16px; }
      .tm-overlay.show { display: flex; }
      .tm-modal { background: var(--bg-elev, #fff); color: var(--text, #0f172a); border-radius: 12px; width: 100%; max-width: 520px; padding: 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); border: 1px solid var(--border, #e5e7eb); }
      .tm-title { font-weight: 700; font-size: 18px; margin: 0 0 14px; }
      .tm-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
      .tm-row label { font-size: 12px; color: var(--text-dim, #475569); font-weight: 500; }
      .tm-input, .tm-select, .tm-textarea { width: 100%; padding: 9px 12px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; background: var(--bg, #fff); color: var(--text, #0f172a); font: inherit; }
      .tm-textarea { min-height: 70px; resize: vertical; }
      .tm-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .tm-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
      .tm-btn { padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border, #e5e7eb); background: var(--bg-elev, #fff); color: var(--text, #0f172a); cursor: pointer; font: inherit; font-weight: 500; }
      .tm-btn-primary { background: linear-gradient(135deg, #093d54 0%, #688b9b 100%); color: #fff; border-color: transparent; }
      .tm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .tm-err { color: var(--red, #dc2626); font-size: 12px; margin-top: 6px; min-height: 16px; }
    `;
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function buildDOM() {
    var html = ''
      + '<div id="tmOverlay" class="tm-overlay" role="dialog" aria-modal="true" aria-labelledby="tmTitle">'
      + '  <div class="tm-modal">'
      + '    <h2 id="tmTitle" class="tm-title">Nieuwe taak</h2>'
      + '    <div class="tm-row"><label for="tmTitel">Titel *</label><input id="tmTitel" class="tm-input" type="text" maxlength="200" placeholder="Korte omschrijving"></div>'
      + '    <div class="tm-row"><label for="tmOmschrijving">Toelichting</label><textarea id="tmOmschrijving" class="tm-textarea" maxlength="2000" placeholder="Optioneel"></textarea></div>'
      + '    <div class="tm-grid2">'
      + '      <div class="tm-row"><label for="tmPrio">Prioriteit</label>'
      + '        <select id="tmPrio" class="tm-select">'
      + '          <option>Laag</option><option selected>Normaal</option><option>Hoog</option><option>Urgent</option>'
      + '        </select></div>'
      + '      <div class="tm-row"><label for="tmDeadline">Deadline</label><input id="tmDeadline" class="tm-input" type="date"></div>'
      + '    </div>'
      + '    <div class="tm-grid2">'
      + '      <div class="tm-row"><label for="tmCat">Categorie</label>'
      + '        <select id="tmCat" class="tm-select">'
      + '          <option>Overige</option><option>E-mail</option><option>Factuur</option><option>Klant</option><option>Intern</option>'
      + '        </select></div>'
      + '      <div class="tm-row"><label for="tmAssignee">Toegewezen aan</label>'
      + '        <select id="tmAssignee" class="tm-select"><option value="">Niemand</option></select></div>'
      + '    </div>'
      + '    <div class="tm-err" id="tmErr"></div>'
      + '    <div class="tm-actions">'
      + '      <button class="tm-btn" id="tmCancel" type="button">Annuleren</button>'
      + '      <button class="tm-btn tm-btn-primary" id="tmSave" type="button">Aanmaken</button>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);
  }

  async function loadTeamMembers() {
    if (teamMembersCache) return teamMembersCache;
    if (teamMembersPromise) return teamMembersPromise;
    teamMembersPromise = (async function () {
      try {
        var res = await window.AgentShared.apiFetch('/api/profiles-list');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        teamMembersCache = data.members || [];
        return teamMembersCache;
      } catch (e) {
        console.warn('[task-modal] team-members fetch fout:', e.message);
        teamMembersCache = [];
        return teamMembersCache;
      } finally {
        teamMembersPromise = null;
      }
    })();
    return teamMembersPromise;
  }

  function populateAssignees(select, members) {
    // Verwijder oude profielopties (behoud lege optie).
    while (select.options.length > 1) select.remove(1);
    members.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.full_name || m.email || '(naamloos)';
      select.appendChild(opt);
    });
  }

  function applyPrefill(prefill) {
    prefill = prefill || {};
    document.getElementById('tmTitel').value        = prefill.titel        || '';
    document.getElementById('tmOmschrijving').value = prefill.omschrijving || '';
    document.getElementById('tmPrio').value         = prefill.prioriteit   || 'Normaal';
    document.getElementById('tmDeadline').value     = prefill.deadline     || '';
    document.getElementById('tmCat').value          = prefill.categorie    || 'Overige';
    document.getElementById('tmErr').textContent    = '';
  }

  function showToast(msg, kind) {
    if (window.AgentShared && typeof window.AgentShared.showToast === 'function') {
      window.AgentShared.showToast(msg, kind || 'success');
    } else {
      console.log('[task-modal]', msg);
    }
  }

  async function open(opts) {
    injectStyle();
    if (!document.getElementById('tmOverlay')) buildDOM();
    var overlay  = document.getElementById('tmOverlay');
    var titleEl  = document.getElementById('tmTitel');
    var assignee = document.getElementById('tmAssignee');
    var members  = await loadTeamMembers();
    populateAssignees(assignee, members);
    applyPrefill(opts && opts.prefill);
    overlay.classList.add('show');
    setTimeout(function () { titleEl.focus(); }, 30);

    return new Promise(function (resolve) {
      function close(result) {
        overlay.classList.remove('show');
        document.getElementById('tmCancel').onclick = null;
        document.getElementById('tmSave').onclick = null;
        overlay.onclick = null;
        document.removeEventListener('keydown', onKey);
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', onKey);
      overlay.onclick = function (e) { if (e.target === overlay) close(null); };
      document.getElementById('tmCancel').onclick = function () { close(null); };
      document.getElementById('tmSave').onclick = async function () {
        var btn  = this;
        var errEl = document.getElementById('tmErr');
        var titel = document.getElementById('tmTitel').value.trim();
        if (titel.length < 3) { errEl.textContent = 'Titel moet minimaal 3 tekens zijn.'; return; }
        btn.disabled = true; errEl.textContent = '';
        var prefill = (opts && opts.prefill) || {};
        var payload = {
          task: {
            id:            (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
            titel:         titel,
            omschrijving:  document.getElementById('tmOmschrijving').value.trim(),
            prioriteit:    document.getElementById('tmPrio').value,
            categorie:     document.getElementById('tmCat').value,
            assignedToId:  document.getElementById('tmAssignee').value || null,
            deadline:      document.getElementById('tmDeadline').value || null,
            status:        'todo',
            emailId:       prefill.email_id || null,
            emailSubject:  prefill.email_subject || null,
            aangemaakt:    new Date().toISOString(),
          },
        };
        try {
          var res = await window.AgentShared.apiFetch('/api/taken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify(payload),
          });
          if (!res.ok) {
            var err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || ('HTTP ' + res.status));
          }
          showToast('Taak aangemaakt', 'success');
          if (window.AgentShared && typeof window.AgentShared.refreshTakenBadge === 'function') {
            window.AgentShared.refreshTakenBadge();
          }
          close({ ok: true, taskId: payload.task.id });
        } catch (e) {
          errEl.textContent = e.message || 'Aanmaken mislukt';
          btn.disabled = false;
        }
      };
    });
  }

  // Exposeer.
  window.AgentShared = window.AgentShared || {};
  window.AgentShared.openCreateTaskModal = open;
})();
