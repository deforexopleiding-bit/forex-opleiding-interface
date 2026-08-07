// modules/klanten-v2/views/tabs/audit.js
//
// Audit-tab van klanten-v2 (PR-B6, deel 3 van 3). 5 items, STRIKT
// READ-ONLY. Toont de audit-history uit /api/customer-audit:
// created / updated / archived / unarchived / anonymized / tag_added /
// tag_removed / note_created / note_updated / note_archived / etc.
//
// Response: { entries: [{id, action, created_at, actor:{id,name},
//   diff:[{field, before, after}], raw_before, raw_after, reason_text,
//   ip_address}], total, page, page_size, total_pages }

const K = () => window.KV;

// action-pill mapping (bekende + fallback). 1-op-1 met audit-conventie
// in klanten.html (r193-198 audit-action classes).
const ACTION_STYLE = {
  created:            { label: 'Aangemaakt',     cls: 'ds-pill-ok'      },
  updated:            { label: 'Bijgewerkt',     cls: 'ds-pill-accent'  },
  archived:           { label: 'Gearchiveerd',   cls: 'ds-pill-warn'    },
  unarchived:         { label: 'Heractief',      cls: 'ds-pill-ok'      },
  anonymized:         { label: 'Geanonimiseerd', cls: 'ds-pill-danger'  },
  tag_added:          { label: 'Tag toegevoegd', cls: 'ds-pill-neutral' },
  tag_removed:        { label: 'Tag verwijderd', cls: 'ds-pill-neutral' },
  note_created:       { label: 'Notitie',        cls: 'ds-pill-violet'  },
  note_updated:       { label: 'Notitie edit',   cls: 'ds-pill-violet'  },
  note_archived:      { label: 'Notitie arch',   cls: 'ds-pill-violet'  },
};
function actionPill(action) {
  const key = String(action || '').toLowerCase();
  const m = ACTION_STYLE[key] || { label: action || '—', cls: 'ds-pill-neutral' };
  return `<span class="ds-pill ${m.cls} nodot">${K().esc(m.label)}</span>`;
}

let state = null;
function initState(customer) {
  state = {
    customerId: customer?.id || null,
    entries: [], total: 0,
    loading: true, error: null,
    expandedRaw: new Set(),  // Set<entry_id>
  };
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (_) { return ''; }
}
function fmtDiffValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'ja' : 'nee';
  if (typeof v === 'object')  return JSON.stringify(v);
  return String(v);
}

async function apiList() {
  const url = `/api/customer-audit?customer_id=${encodeURIComponent(state.customerId)}&page_size=100`;
  return K().authedJson(url);
}

async function actLoad(rootEl) {
  state.loading = true; state.error = null;
  render(rootEl);
  try {
    const j = await apiList();
    state.entries = Array.isArray(j?.entries) ? j.entries : [];
    state.total   = Number(j?.total) || 0;
  } catch (e) {
    state.error = e?.message || 'Kan audit-log niet laden';
    state.entries = []; state.total = 0;
  } finally {
    state.loading = false;
    render(rootEl);
  }
}

// ── Renderers ───────────────────────────────────────────────────────────────

function renderDiffList(diff) {
  if (!Array.isArray(diff) || !diff.length) return '';
  return `
    <div class="kv-aud-diff">
      ${diff.map((d) => `
        <div class="kv-aud-diff-row">
          <div class="kv-aud-diff-field">${K().esc(d.field)}</div>
          <div class="kv-aud-diff-vals">
            <span class="kv-aud-diff-before">${K().esc(fmtDiffValue(d.before))}</span>
            <span class="kv-aud-diff-arrow">→</span>
            <span class="kv-aud-diff-after">${K().esc(fmtDiffValue(d.after))}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderEntry(e) {
  const actor = e.actor?.name || 'systeem';
  const when  = fmtDateTime(e.created_at);
  const hasRaw = !!(e.raw_before || e.raw_after);
  const isExpanded = state.expandedRaw.has(e.id);
  const rawJson = isExpanded
    ? JSON.stringify({ before: e.raw_before, after: e.raw_after }, null, 2)
    : null;
  return `
    <li class="kv-aud-entry">
      <div class="kv-aud-entry-head">
        ${actionPill(e.action)}
        <div class="kv-aud-entry-actor">${K().esc(actor)}</div>
        <div class="kv-aud-entry-time ds-cell-sub">${K().esc(when)}</div>
        ${hasRaw ? `<button type="button" class="ds-icon-btn kv-aud-raw-toggle" data-kv-aud-toggle-raw="${K().esc(e.id)}" title="Toon volledige diff">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${isExpanded ? 'm18 15-6-6-6 6' : 'm6 9 6 6 6-6'}"/></svg>
        </button>` : ''}
      </div>
      ${e.reason_text ? `<div class="kv-aud-entry-reason">${K().esc(e.reason_text)}</div>` : ''}
      ${renderDiffList(e.diff)}
      ${isExpanded ? `<pre class="kv-aud-raw"><code>${K().esc(rawJson)}</code></pre>` : ''}
    </li>`;
}

function renderEmpty() {
  return `
    <div class="ds-empty" style="padding:56px 20px;">
      <div class="ds-empty-ico" style="background:var(--slate-soft); color:var(--slate);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
      </div>
      <div class="ds-empty-t">Geen audit-events</div>
      <div class="ds-empty-s">Elke wijziging aan deze klant (aanmaak, edits, archief, tags, notities) verschijnt hier.</div>
    </div>`;
}

function renderError() {
  const isPerm = /Toegang|geweigerd|403/.test(state.error || '');
  return `
    <div class="ds-error">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
      <div>
        <strong>${isPerm ? 'Geen leesrechten op audit-log' : 'Kan audit-log niet laden.'}</strong>
        <div style="font-size:12px; opacity:.8; margin-top:2px;">${K().esc(state.error)}</div>
        ${!isPerm ? '<div style="margin-top:8px;"><button type="button" class="ds-btn ds-btn-sm ds-btn-ghost" data-kv-aud-retry>Opnieuw proberen</button></div>' : ''}
      </div>
    </div>`;
}

function render(rootEl) {
  let body;
  if (state.loading) body = `<div class="ds-empty" style="padding:32px 20px;"><div class="ds-empty-s">Audit-log laden…</div></div>`;
  else if (state.error) body = renderError();
  else if (!state.entries.length) body = renderEmpty();
  else body = `<ul class="kv-aud-list">${state.entries.map(renderEntry).join('')}</ul>`;

  rootEl.innerHTML = `
    <div class="kv-aud">
      <div class="kv-aud-head">
        <div class="kv-aud-head-title">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/></svg>
          Audit-log
          <span class="kv-prof-count">${state.loading ? '…' : state.entries.length}${state.total > state.entries.length ? ` van ${state.total}` : ''}</span>
        </div>
      </div>
      ${body}
    </div>`;
  wire(rootEl);
}

function wire(rootEl) {
  rootEl.querySelector('[data-kv-aud-retry]')?.addEventListener('click', () => actLoad(rootEl));
  rootEl.querySelectorAll('[data-kv-aud-toggle-raw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-kv-aud-toggle-raw');
      if (state.expandedRaw.has(id)) state.expandedRaw.delete(id);
      else state.expandedRaw.add(id);
      render(rootEl);
    });
  });
}

export async function renderAuditTab(rootEl, { customer } = {}) {
  if (!customer) {
    rootEl.innerHTML = `<div class="ds-empty" style="padding:40px 20px;"><div class="ds-empty-t">Geen klant-data</div></div>`;
    return;
  }
  initState(customer);
  render(rootEl);
  actLoad(rootEl);
}
