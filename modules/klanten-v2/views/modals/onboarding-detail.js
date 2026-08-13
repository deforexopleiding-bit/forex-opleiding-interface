// modules/klanten-v2/views/modals/onboarding-detail.js
//
// V2 Onboarding detail-modal. 1-op-1 met v1 shared/onboarding-overzicht.js
// _openDetailModal (regel ~1500-1600). 4 sub-tabs:
//   1. Overzicht — klant/status/mentor + acties (note, resolve, start-date,
//      mentor-select, archive, cancel-preview-execute).
//   2. Account & Bubble — bubble-status, provision-retry, invite-send (WA).
//   3. Vragenlijst — beschikbaarheid + answers-jsonb.
//   4. Tijdlijn — mentor_updates + status-events.
//
// Endpoints:
//   GET  /api/onboarding-detail?id=<uuid>
//   GET  /api/mentor-admin-list
//   POST /api/admin-onboarding-note {onboarding_id, note}
//   POST /api/admin-onboarding-resolve {onboarding_id, handled}
//   POST /api/admin-onboarding-start-date {onboarding_id, start_date}
//   POST /api/onboarding-assign-mentor {onboarding_id, mentor_user_id|null}
//   POST /api/onboarding-archive {onboarding_id, action:'archive'|'restore'}
//   POST /api/onboarding-cancel {onboarding_id, preview:true}
//                             / {onboarding_id, reason, confirm:true}
//   POST /api/onboarding-provision-retry {onboarding_id}
//   POST /api/onboarding-invite-send {onboarding_id, force?}
//
// Modal-primitive: DFO.openModal (bestaande .mdl-* CSS in app-shell.css).
// GEEN nieuwe ongestylede modal-klassen (recidive-fix).

const K = () => window.KV;
const D = () => window.DFO;
const esc = (v) => K().esc(v);

const STATUS_LABEL = {
  aangemeld:    { label: 'Aangemeld',     cls: 'kv-onb-pill-info' },
  bezig:        { label: 'Bezig',         cls: 'kv-onb-pill-warn' },
  afgerond:     { label: 'Afgerond',      cls: 'kv-onb-pill-ok' },
  gearchiveerd: { label: 'Gearchiveerd',  cls: 'kv-onb-pill-neutral' },
  geannuleerd:  { label: 'Geannuleerd',   cls: 'kv-onb-pill-danger' },
};
const INTAKE_LABEL = {
  nog_geen_mentor:   { l: 'Nog geen mentor',   cls: 'kv-onb-pill-warn' },
  gestart:           { l: 'Gestart',           cls: 'kv-onb-pill-violet' },
  wil_niet:          { l: 'Wil niet',          cls: 'kv-onb-pill-danger' },
  no_show:           { l: 'No-show',           cls: 'kv-onb-pill-danger' },
  geen_gehoor:       { l: 'Geen gehoor',       cls: 'kv-onb-pill-danger' },
  wil_later:         { l: 'Wil later',         cls: 'kv-onb-pill-accent' },
  call_ingepland:    { l: 'Call ingepland',    cls: 'kv-onb-pill-ok' },
  nog_te_benaderen:  { l: 'Nog te benaderen',  cls: 'kv-onb-pill-warn' },
};

function statusPill(s) { const m = STATUS_LABEL[s] || { label: s || '—', cls: 'kv-onb-pill-neutral' }; return `<span class="kv-onb-pill ${m.cls}">${esc(m.label)}</span>`; }
function intakePill(s) { const m = INTAKE_LABEL[s]  || { l: s || '—',    cls: 'kv-onb-pill-neutral' }; return `<span class="kv-onb-pill ${m.cls}">${esc(m.l)}</span>`; }
function fmtDate(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return '—'; } }
function fmtDT(iso)   { if (!iso) return '—'; try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } }

// ── State ──────────────────────────────────────────────────────────────────
let state = null;
let _mentorsCache = null;

async function loadMentors() {
  if (_mentorsCache) return _mentorsCache;
  try {
    const j = await K().authedJson('/api/mentor-admin-list');
    _mentorsCache = Array.isArray(j?.mentors) ? j.mentors : [];
  } catch (e) { console.warn('[onb-detail] mentor-list fail:', e?.message); _mentorsCache = []; }
  return _mentorsCache;
}
async function loadDetail(id) {
  const j = await K().authedJson('/api/onboarding-detail?id=' + encodeURIComponent(id));
  return j?.onboarding || null;
}

// ── Render: head + tabs + body ─────────────────────────────────────────────
function renderHead() {
  const o = state.data || {};
  return `
    <div class="kv-edit-head">
      <div style="flex:1; min-width:0;">
        <div class="kv-edit-head-eyebrow">Onboarding · ${esc(o.traject_label || 'traject onbekend')}</div>
        <div class="kv-edit-head-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(o.customer_name || 'Laden…')}</div>
      </div>
      <button type="button" class="ds-icon-btn" data-kv-onb-close aria-label="Sluiten">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>`;
}
function renderTabs() {
  const t = state.tab;
  const items = [
    { k: 'overzicht',  l: 'Overzicht' },
    { k: 'account',    l: 'Account & Bubble' },
    { k: 'vragenlijst', l: 'Vragenlijst' },
    { k: 'tijdlijn',   l: 'Tijdlijn' },
  ];
  return `<div class="kv-onb-tabs">
    ${items.map((it) => `<button type="button" class="kv-onb-tab ${t === it.k ? 'is-on' : ''}" data-kv-onb-tab="${it.k}">${it.l}</button>`).join('')}
  </div>`;
}

function renderBody() {
  if (state.loading) return `<div style="padding:32px; text-align:center; color:var(--text-2);">Laden…</div>`;
  if (state.error || !state.data) return `<div class="kv-edit-banner">${esc(state.error || 'Onboarding niet gevonden.')}</div>`;
  const inner = state.tab === 'account'    ? renderAccountTab()
              : state.tab === 'vragenlijst' ? renderVragenlijstTab()
              : state.tab === 'tijdlijn'   ? renderTijdlijnTab()
              : renderOverzichtTab();
  return `
    <form class="kv-edit-form" novalidate>
      ${state.globalError ? `<div class="kv-edit-banner">${esc(state.globalError)}</div>` : ''}
      ${state.saveOk ? `<div class="kv-edit-banner" style="background:var(--emerald-soft,#E4F5EE); color:var(--emerald,#07835A); border-color:var(--emerald-line,#A9DFC9);">${esc(state.saveOk)}</div>` : ''}
      ${renderTabs()}
      <div class="kv-onb-tabbody">${inner}</div>
    </form>`;
}

// ── Sub-tab 1: Overzicht + acties ──────────────────────────────────────────
function renderOverzichtTab() {
  const o = state.data;
  const mentorsOpts = (_mentorsCache || []).map((m) =>
    `<option value="${esc(m.user_id)}" ${o.mentor_user_id === m.user_id ? 'selected' : ''}>${esc(m.name || m.email || m.user_id.slice(0, 8))}</option>`
  ).join('');
  return `
    <div class="kv-onb-meta">
      <div class="kv-onb-meta-row"><span>Klant</span><b>${esc(o.customer_name || '—')}</b></div>
      <div class="kv-onb-meta-row"><span>E-mail</span><span>${o.email ? `<a href="mailto:${esc(o.email)}">${esc(o.email)}</a>` : '—'}</span></div>
      <div class="kv-onb-meta-row"><span>Telefoon</span><span>${o.phone ? esc(o.phone) : '—'}</span></div>
      <div class="kv-onb-meta-row"><span>Traject</span><span>${esc(o.traject_label || '—')}${o.calls ? ` <span style="color:var(--text-3)">· ${o.calls} call(s)</span>` : ''}</span></div>
      <div class="kv-onb-meta-row"><span>Status</span><span>${statusPill(o.status)}</span></div>
      <div class="kv-onb-meta-row"><span>Intake-status</span><span>${intakePill(o.mentor_intake_status)}${o.intake_handled_at ? ` <span style="color:var(--text-3);font-size:11px">· afgehandeld ${fmtDT(o.intake_handled_at)}</span>` : ''}</span></div>
      <div class="kv-onb-meta-row"><span>Mentor</span><b>${esc(o.mentor_name || '— nog geen mentor —')}</b></div>
      <div class="kv-onb-meta-row"><span>Aangemeld</span><span>${fmtDT(o.created_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Startdatum</span><span>${fmtDate(o.start_date)}</span></div>
      <div class="kv-onb-meta-row"><span>Eerste call gepland</span><span>${fmtDT(o.planned_call_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Laatste call voltooid</span><span>${fmtDT(o.last_completed_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Laatste no-show</span><span>${o.last_noshow_at ? `<span style="color:var(--rose)">${fmtDT(o.last_noshow_at)}</span>` : '—'}</span></div>
      <div class="kv-onb-meta-row"><span>Toegewezen</span><span>${fmtDT(o.assigned_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Gestart</span><span>${fmtDT(o.started_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Afgerond</span><span>${fmtDT(o.completed_at)}</span></div>
      ${o.archived_at ? `<div class="kv-onb-meta-row"><span>Gearchiveerd</span><span>${fmtDT(o.archived_at)}</span></div>` : ''}
      <div class="kv-onb-meta-row"><span>Betaling</span><span>${o.paid ? '<span class="kv-onb-pill kv-onb-pill-ok">Betaald</span>' : '<span class="kv-onb-pill kv-onb-pill-warn">Niet betaald</span>'}</span></div>
    </div>

    ${o.cancelled && o.cancellation ? `
      <div class="kv-onb-section" style="border:1px solid var(--rose-line,#F1B4BE); background:var(--rose-soft,#FBEAED); border-radius:var(--r,8px); padding:12px 14px; margin-top:14px;">
        <div class="kv-onb-section-title" style="color:var(--rose,#C22B3E)">⚠ Onboarding geannuleerd</div>
        <div class="kv-onb-meta">
          <div class="kv-onb-meta-row"><span>Geannuleerd op</span><span>${fmtDT(o.cancellation.cancelled_at)}</span></div>
          ${o.cancellation.cancelled_by ? `<div class="kv-onb-meta-row"><span>Door</span><span class="mono">${esc(o.cancellation.cancelled_by)}</span></div>` : ''}
          ${o.cancellation.reason ? `<div class="kv-onb-meta-row"><span>Reden</span><span>${esc(o.cancellation.reason)}</span></div>` : ''}
          ${o.cancellation.subscription_value != null ? `<div class="kv-onb-meta-row"><span>Abo-waarde</span><span>${esc(o.cancellation.subscription_value)}</span></div>` : ''}
          ${o.cancellation.steps ? `<div class="kv-onb-meta-row"><span>Uitgevoerde stappen</span><span style="font-size:11px;color:var(--text-2)">${esc(JSON.stringify(o.cancellation.steps))}</span></div>` : ''}
        </div>
      </div>
    ` : ''}

    <div class="kv-onb-section">
      <div class="kv-onb-section-title">Notitie naar mentor</div>
      <textarea class="ib-input" rows="3" placeholder="Korte context voor de mentor…" data-kv-onb-note maxlength="2000">${esc(state.draftNote)}</textarea>
      <div style="display:flex; justify-content:flex-end; margin-top:6px">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-note-send ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'note' ? 'Versturen…' : 'Verstuur naar mentor'}
        </button>
      </div>
    </div>

    <div class="kv-onb-section">
      <div class="kv-onb-section-title">Acties</div>
      <div class="kv-onb-action-grid">
        <label class="kv-onb-field">
          <span>Mentor toewijzen</span>
          <select class="ib-input" data-kv-onb-mentor-select ${state.savingAction ? 'disabled' : ''}>
            <option value="">— Niet toegewezen —</option>
            ${mentorsOpts}
          </select>
        </label>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-mentor-save ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'mentor' ? 'Opslaan…' : 'Mentor opslaan'}
        </button>

        <label class="kv-onb-field">
          <span>Startdatum wijzigen</span>
          <input class="ib-input" type="date" value="${esc((o.start_date || '').slice(0, 10))}" data-kv-onb-start-date ${state.savingAction ? 'disabled' : ''}>
        </label>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-start-save ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'startdate' ? 'Opslaan…' : 'Startdatum opslaan'}
        </button>
      </div>
      <div class="kv-onb-hint">Startdatum ≥ vandaag+3 dagen (server-gate).</div>

      <div class="kv-onb-action-row">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-resolve ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'resolve' ? 'Bezig…' : (o.intake_handled_at ? 'Markeer als open (heropen intake)' : 'Markeer intake als afgehandeld')}
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-archive ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'archive' ? 'Bezig…' : (o.status === 'gearchiveerd' ? 'Herstellen uit archief' : 'Archiveren')}
        </button>
      </div>
      <div class="kv-onb-action-row" style="margin-top:14px">
        <button type="button" class="ds-btn ds-btn-primary ds-btn-sm kv-onb-danger" data-kv-onb-cancel-preview ${state.savingAction || o.status === 'geannuleerd' ? 'disabled' : ''} title="${o.status === 'geannuleerd' ? 'Al geannuleerd' : 'Preview de cascade (crediteert facturen, deactiveert abo, Bubble-membership)'}">
          ${state.savingAction === 'cancel-preview' ? 'Preview laden…' : 'Student annuleren'}
        </button>
      </div>
    </div>`;
}

// ── Sub-tab 2: Account & Bubble ────────────────────────────────────────────
function renderAccountTab() {
  const o = state.data;
  const provOk = !!o.bubble_provisioned;
  return `
    <div class="kv-onb-meta">
      <div class="kv-onb-meta-row"><span>Bubble-provisioning</span><span>${provOk ? '<span class="kv-onb-pill kv-onb-pill-ok">OK</span>' : (o.bubble_provision_error ? '<span class="kv-onb-pill kv-onb-pill-danger">Mislukt</span>' : '<span class="kv-onb-pill kv-onb-pill-warn">Nog niet</span>')}</span></div>
      <div class="kv-onb-meta-row"><span>Bubble-user-id</span><span class="mono">${esc(o.bubble_user_id || '—')}</span></div>
      <div class="kv-onb-meta-row"><span>Provisioned op</span><span>${fmtDT(o.bubble_provisioned_at)}</span></div>
      ${o.bubble_provision_error ? `<div class="kv-onb-meta-row"><span>Fout</span><span style="color:var(--rose)">${esc(o.bubble_provision_error)}</span></div>` : ''}
      <div class="kv-onb-meta-row"><span>Credentials-mail verstuurd</span><span>${fmtDT(o.credentials_email_sent_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Credentials-WA verstuurd</span><span>${fmtDT(o.credentials_wa_sent_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Invite verstuurd</span><span>${fmtDT(o.invite_sent_at)}</span></div>
      <div class="kv-onb-meta-row"><span>Wizard-stap</span><span>${o.current_step != null ? String(o.current_step) : '—'}</span></div>
      <div class="kv-onb-meta-row"><span>Persoonlijke link</span><span>${o.token ? `<a href="/modules/onboarding.html?t=${esc(o.token)}" target="_blank" rel="noopener">Openen ↗</a>` : '—'}</span></div>
    </div>

    <div class="kv-onb-section">
      <div class="kv-onb-section-title">Acties</div>
      <div class="kv-onb-action-row">
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-provision ${state.savingAction ? 'disabled' : ''}>
          ${state.savingAction === 'provision' ? 'Bezig…' : (provOk ? 'Provision opnieuw proberen' : 'Bubble provisionen')}
        </button>
        <button type="button" class="ds-btn ds-btn-ghost ds-btn-sm" data-kv-onb-resend ${state.savingAction || !o.customer_id ? 'disabled' : ''} title="Verstuurt de welkomstmail met onboarding-link opnieuw">
          ${state.savingAction === 'resend' ? 'Versturen…' : 'Onboardingsuitnodiging opnieuw sturen'}
        </button>
      </div>
      <div class="kv-onb-hint">De uitnodiging wordt via e-mail verzonden naar het klant-adres. Het onboarding-token blijft geldig; een bestaande link blijft dus werken.</div>
    </div>`;
}

// ── Sub-tab 3: Vragenlijst ─────────────────────────────────────────────────
function renderVragenlijstTab() {
  const o = state.data;
  const av = o.availability || null;
  const ans = o.answers || null;
  const days = av && Array.isArray(av.days) ? av.days : [];
  const avHtml = days.length
    ? `<ul class="kv-onb-av-list">${days.map((d) => `<li><b>${esc(d.label || '—')}:</b> ${(d.dayparts || []).map(esc).join(', ') || '—'}</li>`).join('')}</ul>`
    : '<div class="kv-onb-empty">Geen beschikbaarheid opgegeven.</div>';
  return `
    <div class="kv-onb-section">
      <div class="kv-onb-section-title">Beschikbaarheid</div>
      ${avHtml}
    </div>
    <div class="kv-onb-section">
      <div class="kv-onb-section-title">Antwoorden (wizard)</div>
      ${ans ? `<pre class="kv-onb-json">${esc(JSON.stringify(ans, null, 2))}</pre>` : '<div class="kv-onb-empty">Nog geen antwoorden ingevuld.</div>'}
    </div>`;
}

// ── Sub-tab 4: Tijdlijn ────────────────────────────────────────────────────
function renderTijdlijnTab() {
  const o = state.data;
  const updates = Array.isArray(o.mentor_updates) ? o.mentor_updates : [];
  const rows = [];
  if (o.created_at)          rows.push({ at: o.created_at,          label: '📝 Aangemeld' });
  if (o.assigned_at)         rows.push({ at: o.assigned_at,         label: `👤 Toegewezen aan ${esc(o.mentor_name || 'mentor')}` });
  if (o.invite_sent_at)      rows.push({ at: o.invite_sent_at,      label: '✉️ Onboarding-uitnodiging verstuurd' });
  if (o.planned_call_at)     rows.push({ at: o.planned_call_at,     label: '📅 Eerste call gepland' });
  if (o.started_at)          rows.push({ at: o.started_at,          label: '▶ Wizard gestart' });
  if (o.last_completed_at)   rows.push({ at: o.last_completed_at,   label: '✓ Call voltooid' });
  if (o.last_noshow_at)      rows.push({ at: o.last_noshow_at,      label: '⚠ No-show' });
  if (o.intake_handled_at)   rows.push({ at: o.intake_handled_at,   label: '✓ Intake afgehandeld' });
  if (o.completed_at)        rows.push({ at: o.completed_at,        label: '🎉 Onboarding afgerond' });
  if (o.archived_at)         rows.push({ at: o.archived_at,         label: '📁 Gearchiveerd' });
  if (o.cancelled && o.cancellation?.cancelled_at) rows.push({ at: o.cancellation.cancelled_at, label: `❌ Onboarding geannuleerd${o.cancellation.reason ? ' — ' + esc(o.cancellation.reason) : ''}` });
  for (const u of updates) {
    if (!u) continue;
    rows.push({
      at: u.created_at,
      label: `${esc(u.kind || 'update')}${u.status ? ' · ' + esc(u.status) : ''}${u.note ? ' — ' + esc(u.note) : ''}`,
    });
  }
  // ASC (oud→nieuw) — historie leest natuurlijk van boven naar beneden.
  rows.sort((a, b) => new Date(a.at || 0).getTime() - new Date(b.at || 0).getTime());
  return rows.length
    ? `<ul class="kv-onb-timeline">${rows.map((r) => `<li><b>${fmtDT(r.at)}</b> — ${r.label}</li>`).join('')}</ul>`
    : '<div class="kv-onb-empty">Nog geen tijdlijn-events.</div>';
}

// ── Foot ───────────────────────────────────────────────────────────────────
function renderFoot() {
  return `<div class="kv-edit-foot"><button type="button" class="ds-btn ds-btn-ghost" data-kv-onb-close>Sluiten</button></div>`;
}

// ── Actions ────────────────────────────────────────────────────────────────
async function callAction(key, url, body) {
  state.savingAction = key; state.globalError = null; state.saveOk = null;
  rerender();
  try {
    const j = await K().authedJson(url, { method: 'POST', body: JSON.stringify(body) });
    state.savingAction = null;
    // Herlaad detail-data
    state.data = await loadDetail(state.id);
    state.saveOk = 'Opgeslagen';
    if (typeof state.onSuccess === 'function') state.onSuccess();
    return j;
  } catch (e) {
    state.savingAction = null;
    state.globalError = e?.message || 'Actie mislukt';
    return null;
  } finally { rerender(); }
}
function actNote() {
  const n = String(state.draftNote || '').trim();
  if (!n) { K().toast('Notitie is leeg'); return; }
  return callAction('note', '/api/admin-onboarding-note', { onboarding_id: state.id, note: n }).then((j) => {
    if (j) state.draftNote = '';
  });
}
function actResolve() {
  const current = !!state.data?.intake_handled_at;
  return callAction('resolve', '/api/admin-onboarding-resolve', { onboarding_id: state.id, handled: !current });
}
function actStartDate() {
  const inp = document.querySelector('[data-kv-onb-start-date]');
  const v = inp?.value;
  if (!v) { K().toast('Kies een datum'); return; }
  return callAction('startdate', '/api/admin-onboarding-start-date', { onboarding_id: state.id, start_date: v });
}
function actMentor() {
  const sel = document.querySelector('[data-kv-onb-mentor-select]');
  const v = sel?.value || null;
  return callAction('mentor', '/api/onboarding-assign-mentor', { onboarding_id: state.id, mentor_user_id: v });
}
function actArchive() {
  const isArchived = state.data?.status === 'gearchiveerd';
  const action = isArchived ? 'restore' : 'archive';
  if (!confirm(isArchived ? 'Onboarding uit archief herstellen?' : 'Onboarding archiveren?')) return;
  return callAction('archive', '/api/onboarding-archive', { onboarding_id: state.id, action });
}
async function actCancelPreview() {
  state.savingAction = 'cancel-preview'; state.globalError = null; state.saveOk = null;
  rerender();
  try {
    const j = await K().authedJson('/api/onboarding-cancel', {
      method: 'POST',
      body: JSON.stringify({ onboarding_id: state.id, preview: true }),
    });
    state.savingAction = null;
    openCancelConfirmModal(j);
  } catch (e) {
    state.savingAction = null;
    state.globalError = e?.message || 'Cancel-preview mislukt';
    rerender();
  }
}
async function actProvision() {
  await callAction('provision', '/api/onboarding-provision-retry', { onboarding_id: state.id });
}
async function actResend() {
  const cid = state.data?.customer_id;
  if (!cid) { K().toast('Geen klant-koppeling — kan uitnodiging niet versturen'); return; }
  state.savingAction = 'resend'; state.globalError = null; state.saveOk = null;
  rerender();
  try {
    const j = await K().authedJson('/api/sales-onboarding-send', {
      method: 'POST', body: JSON.stringify({ customer_id: cid }),
    });
    state.savingAction = null;
    state.saveOk = j?.mail_sent ? 'Uitnodiging verstuurd naar ' + esc(state.data?.email || 'klant') : 'Token vernieuwd (mail niet verzonden)';
    // Herlaad — invite_sent_at / onboarding_sent_at moet updaten
    state.data = await loadDetail(state.id);
    if (typeof state.onSuccess === 'function') state.onSuccess();
  } catch (e) {
    state.savingAction = null;
    state.globalError = 'Uitnodiging mislukt: ' + (e?.message || 'onbekende fout');
  } finally { rerender(); }
}

// ── Cancel-confirm sub-modal ───────────────────────────────────────────────
// 2-step preview→confirm. Reden verplicht (min 10 chars), geen typ-CANCEL
// meer — expliciete waarschuwing + destructieve knop-label is voldoende.
const CANCEL_WARNING_TEXT = 'Dit is een onomkeerbare cascade: alle openstaande facturen worden gecrediteerd, actieve abonnementen worden gedeactiveerd, gekoppelde offertes worden op geannuleerd gezet en de Bubble-membership wordt beëindigd. De klant behoudt toegang tot voltooide onderdelen tot Bubble-sync.';

let _cancelPreview = null;
let _cancelReason  = '';
let _cancelSaving  = false;

function openCancelConfirmModal(preview) {
  _cancelPreview = preview || {};
  _cancelReason  = '';
  _cancelSaving  = false;
  cancelRerender();
}
function cancelRerender() {
  D().openModal({
    head: `<div class="kv-edit-head"><div><div class="kv-edit-head-eyebrow" style="color:var(--rose,#C22B3E)">Student annuleren · destructief</div><div class="kv-edit-head-name">${esc(_cancelPreview.customer_name || 'Onboarding')}</div></div><button type="button" class="ds-icon-btn" data-kv-onbc-close><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>`,
    body: cancelBody(),
    foot: cancelFoot(),
  });
  cancelWire();
}
function cancelBody() {
  const p = _cancelPreview;
  const invoices = Array.isArray(p.invoices) ? p.invoices : [];
  const subs     = Array.isArray(p.subscriptions) ? p.subscriptions : [];
  const offs     = Array.isArray(p.offertes) ? p.offertes : [];
  return `
    <form class="kv-edit-form" novalidate>
      ${p.already_cancelled ? `<div class="kv-edit-banner">Deze onboarding is al geannuleerd op ${fmtDT(p.already_cancelled)}.</div>` : ''}
      <div class="kv-edit-banner" style="background:var(--rose-soft,#FBEAED); color:var(--rose,#C22B3E); border-color:var(--rose-line,#F1B4BE); line-height:1.5;">
        <b>⚠ Waarschuwing</b><br>${esc(CANCEL_WARNING_TEXT)}
      </div>
      <div class="kv-onb-cancel-summary">
        <div class="kv-onb-cancel-row"><b>${invoices.length}</b> facturen worden gecrediteerd</div>
        <div class="kv-onb-cancel-row"><b>${subs.length}</b> abonnementen worden gedeactiveerd${p.subscription_value != null ? ` <span style="color:var(--text-3)">(waarde ${p.subscription_value})</span>` : ''}</div>
        <div class="kv-onb-cancel-row"><b>${offs.length}</b> offertes gemarkeerd als geannuleerd</div>
        <div class="kv-onb-cancel-row">Bubble-membership ${p.bubble_user_id ? '<b>wordt beëindigd</b>' : '— (geen Bubble-user)'}</div>
      </div>
      <div class="kv-edit-field">
        <label>Reden voor annulering <span class="kv-edit-req">*</span> <span style="color:var(--text-3);font-weight:400">(min. 10 tekens)</span></label>
        <textarea class="ib-input" rows="3" data-kv-onbc-reason placeholder="Bv. Klant heeft bedenktijd ingeroepen op 2026-08-12 — refund via TL">${esc(_cancelReason)}</textarea>
      </div>
    </form>`;
}
function cancelFoot() {
  const canConfirm = (_cancelReason || '').trim().length >= 10;
  return `<div class="kv-edit-foot" style="justify-content:space-between">
    <button type="button" class="ds-btn ds-btn-ghost" data-kv-onbc-close ${_cancelSaving ? 'disabled' : ''}>Terug</button>
    <button type="button" class="ds-btn ds-btn-primary kv-onb-danger" data-kv-onbc-execute ${(_cancelSaving || !canConfirm) ? 'disabled' : ''}>
      ${_cancelSaving ? 'Uitvoeren…' : 'Student definitief annuleren'}
    </button>
  </div>`;
}
function cancelWire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-onbc-close]').forEach((b) => b.addEventListener('click', () => {
    // Terug naar detail-modal
    if (state) rerender(); else D().closeModal();
  }));
  // Uncontrolled input: geen re-render bij typen (voorkomt cursor-jump).
  // Alleen re-render bij een debounce-tick vanuit blur/click op execute.
  box.querySelector('[data-kv-onbc-reason]')?.addEventListener('input', (e) => { _cancelReason = e.target.value; });
  box.querySelector('[data-kv-onbc-reason]')?.addEventListener('blur',  () => cancelRerender());
  box.querySelector('[data-kv-onbc-execute]')?.addEventListener('click', async () => {
    if (_cancelSaving) return;
    _cancelSaving = true; cancelRerender();
    try {
      await K().authedJson('/api/onboarding-cancel', {
        method: 'POST',
        body: JSON.stringify({ onboarding_id: state.id, reason: _cancelReason.trim(), confirm: true }),
      });
      K().toast('Onboarding geannuleerd — cascade voltooid');
      if (typeof state.onSuccess === 'function') state.onSuccess();
      D().closeModal();
    } catch (e) {
      alert('Annuleren mislukt: ' + (e?.message || 'onbekende fout'));
      _cancelSaving = false; cancelRerender();
    }
  });
}

// ── Wire (main detail-modal) ───────────────────────────────────────────────
function wire() {
  const box = document.getElementById('dfoModal');
  if (!box) return;
  box.querySelectorAll('[data-kv-onb-close]').forEach((b) => b.addEventListener('click', () => D().closeModal()));
  box.querySelectorAll('[data-kv-onb-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.getAttribute('data-kv-onb-tab') || 'overzicht';
    state.saveOk = null; state.globalError = null;
    rerender();
  }));
  box.querySelector('[data-kv-onb-note]')?.addEventListener('input', (e) => { state.draftNote = e.target.value; });
  box.querySelector('[data-kv-onb-note-send]')?.addEventListener('click', actNote);
  box.querySelector('[data-kv-onb-resolve]')?.addEventListener('click', actResolve);
  box.querySelector('[data-kv-onb-mentor-save]')?.addEventListener('click', actMentor);
  box.querySelector('[data-kv-onb-start-save]')?.addEventListener('click', actStartDate);
  box.querySelector('[data-kv-onb-archive]')?.addEventListener('click', actArchive);
  box.querySelector('[data-kv-onb-cancel-preview]')?.addEventListener('click', actCancelPreview);
  box.querySelector('[data-kv-onb-provision]')?.addEventListener('click', actProvision);
  box.querySelector('[data-kv-onb-resend]')?.addEventListener('click', actResend);
}
function rerender() {
  D().openModal({ head: renderHead(), body: renderBody(), foot: renderFoot() });
  wire();
}

// ── Public entry ───────────────────────────────────────────────────────────
export async function openOnboardingDetailModal({ onboardingId, onSuccess } = {}) {
  if (!onboardingId) { K().toast('Geen onboarding-id'); return; }
  if (!D() || typeof D().openModal !== 'function') { K().toast('Modal-primitive niet beschikbaar'); return; }
  state = {
    id: onboardingId, tab: 'overzicht',
    loading: true, error: null, data: null,
    draftNote: '', savingAction: null, globalError: null, saveOk: null,
    onSuccess: onSuccess || null,
  };
  rerender();
  const [data] = await Promise.all([
    loadDetail(onboardingId).catch((e) => ({ _error: e?.message })),
    loadMentors(),
  ]);
  if (!state) return;
  if (data?._error || !data) {
    state.loading = false; state.error = data?._error || 'Onboarding niet gevonden.';
  } else {
    state.loading = false; state.data = data;
  }
  rerender();
}
