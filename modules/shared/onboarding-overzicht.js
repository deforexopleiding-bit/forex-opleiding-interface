/* modules/shared/onboarding-overzicht.js
 *
 * Onboarding-overzicht mountable module — extractie van modules/onboarding-admin.html.
 * Public API:
 *   window.OnboardingOverzicht.mount({ host: HTMLElement })
 *
 * Bevat de complete admin-flow zoals voorheen op onboarding-admin.html:
 *   - Tab-strip Actief / Archief / Inbox
 *   - Lijst-tabel met search/traject/mentor-filters + per-row mentor-assign + acties
 *   - Detail-modal met sends/provisioning:
 *       /api/onboarding-detail (read)
 *       /api/onboarding-provision-retry        (RBAC: onboarding.admin)
 *       /api/onboarding-invite-send            (RBAC: onboarding.inbox.send)
 *       /api/onboarding-assign-mentor          (RBAC: onboarding.assign_mentor)
 *       /api/onboarding-archive                (RBAC: onboarding.admin)
 *   - Onboarding-Inbox (Mila) — read + suggest + send + templates + outcome:
 *       /api/inbox-conversations-list           /api/inbox-messages-list
 *       /api/inbox-conversation-context         /api/joost-suggestions-recent
 *       /api/onboarding-suggest (POST)          /api/inbox-send
 *       /api/inbox-template-list                /api/inbox-send-template
 *       /api/joost-mark-outcome
 *
 * RBAC:
 *   - Page-gate (onboarding.admin) wordt door de host (modules/onboarding.html)
 *     gedaan; deze module vertrouwt op de host + de server-side gates per endpoint.
 *   - Per-row mentor-edit: alleen zichtbaar als onboarding.assign_mentor.
 *   - Inbox-tab: alleen zichtbaar als onboarding.inbox.view.
 *   - Mentor-lijst fetch valt elegant terug bij 403 op /api/mentor-admin-list.
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets. Volgt het
 * patroon van modules/shared/finance-klanten.js (IIFE + __loaded-guard +
 * single mount() entrypoint). Alle globals zitten binnen deze IIFE — geen
 * window-vervuiling (behalve window._oiInboxBadgeTimer dat de host-pagina
 * deelt om duplicate intervals bij re-mount te voorkomen).
 *
 * Functionele equivalentie t.o.v. onboarding-admin.html is byte-voor-byte
 * behouden voor de gevoelige acties (sends/provisioning) — alleen de
 * DOMContentLoaded-trigger is vervangen door een mount({host})-call die de
 * HOST_HTML inject en daarna init() draait.
 */
(function () {
  if (window.OnboardingOverzicht && window.OnboardingOverzicht.__loaded) return;

  let _mountedHost = null;

  // De HTML-body die voorheen onboarding-admin.html's <body> binnen .app
  // bevatte. Bevat de tab-strip, lijst-pane (Actief/Archief), Inbox-pane (oi-*),
  // template-picker modal, detail-modal en de toast-container.
  const HOST_HTML = '<div class="page-header">' +
    '<div>' +
      '<h1>Onboarding-overzicht</h1>' +
      '<p>Overzicht van alle aangemelde onboardings — mentor-toewijzing, archief en wizard-status.</p>' +
    '</div>' +
  '</div>' +
  '<div class="ob-tabs" role="tablist">' +
    '<button type="button" class="ob-tab active" data-scope="active"   id="tab-active">Actief</button>' +
    '<button type="button" class="ob-tab"        data-scope="archived" id="tab-archived">Archief</button>' +
    '<button type="button" class="ob-tab"        data-scope="inbox"    id="tab-inbox" style="display:none">' +
      'Inbox<span class="oi-tab-badge" id="oiInboxManualBadge">0</span>' +
    '</button>' +
  '</div>' +
  '<div id="pane-list">' +
    '<div class="toolbar">' +
      '<label for="searchBox">Zoeken:</label>' +
      '<input type="search" id="searchBox" placeholder="Klantnaam…" />' +
      '<label for="trajectFilter">Traject:</label>' +
      '<select id="trajectFilter"><option value="">— alle trajecten —</option></select>' +
      '<label for="mentorFilter">Mentor:</label>' +
      '<select id="mentorFilter"><option value="">— alle mentoren —</option></select>' +
      '<div class="spacer"></div>' +
      '<button type="button" class="refresh-btn" id="refreshBtn"><i class="ti ti-refresh"></i> Vernieuwen</button>' +
    '</div>' +
    '<div class="counter" id="counter"><span class="skeleton" style="width:120px"></span></div>' +
    '<div id="tableWrap"><div class="empty-state"><span class="skeleton" style="width:160px"></span></div></div>' +
  '</div>' +
  '<div id="pane-inbox" style="display:none">' +
    '<div class="oi-shell" id="oiInboxShell">' +
      '<aside id="oiInboxListPane" class="oi-list-pane">' +
        '<div class="oi-list-header">' +
          '<div style="font-size:12.5px;font-weight:600;color:var(--text)">Gesprekken</div>' +
          '<button type="button" class="refresh-btn" id="oiInboxRefresh" title="Vernieuwen" style="padding:4px 8px;font-size:12px"><i class="ti ti-refresh"></i></button>' +
        '</div>' +
        '<div id="oiInboxList" class="oi-list-body"><div class="oi-skel-row"></div><div class="oi-skel-row"></div></div>' +
      '</aside>' +
      '<section id="oiThreadPane" class="oi-thread-pane">' +
        '<div id="oiThreadEmpty" class="oi-thread-empty">' +
          '<i class="ti ti-message-circle" style="font-size:36px;color:var(--text-faint)"></i>' +
          '<div style="font-size:13.5px;font-weight:600;color:var(--text)">Selecteer een gesprek</div>' +
          '<div style="font-size:12px;color:var(--text-faint);max-width:320px">Kies een conversatie links om de berichten te zien en met Mila te beantwoorden.</div>' +
        '</div>' +
        '<div id="oiThreadContent" style="display:none;flex:1;min-height:0;flex-direction:column">' +
          '<div class="oi-thread-header">' +
            '<button type="button" id="oiThreadBack" title="Terug naar lijst" style="background:transparent;border:1px solid var(--border);border-radius:6px;padding:4px 8px;cursor:pointer;color:var(--text-dim)"><i class="ti ti-arrow-left"></i></button>' +
            '<div style="flex:1;min-width:0">' +
              '<div id="oiThreadName" style="font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">—</div>' +
              '<div id="oiThreadPhone" style="font-size:11.5px;color:var(--text-faint)">—</div>' +
            '</div>' +
            '<span id="oiThreadWindowBadge" style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.04em">—</span>' +
            '<button type="button" id="oiEmailReplyBtn" style="display:none;margin-left:8px;padding:5px 11px;font-size:12px;font-weight:600;background:var(--brand-deep,#093d54);color:#fff;border:none;border-radius:7px;cursor:pointer" title="Open mailmodule om te reageren"><i class="ti ti-mail-forward"></i> Reageren</button>' +
          '</div>' +
          '<div id="oiCustomerStrip" class="oi-ctx-strip" style="display:none"></div>' +
          '<div id="oiThreadModeBar" style="display:flex;gap:4px;padding:8px 14px 0;align-items:center">' +
            '<div id="oiModeToggle" role="tablist" aria-label="Bron" style="display:inline-flex;background:var(--bg-elev,#f1f5f9);border:1px solid var(--border);border-radius:8px;padding:2px;gap:2px">' +
              '<button type="button" role="tab" aria-selected="true" id="oiModeBtnWa"    data-oi-mode="wa"    style="border:none;background:var(--bg,#fff);color:var(--text);padding:5px 12px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.06)">WhatsApp</button>' +
              '<button type="button" role="tab" aria-selected="false" id="oiModeBtnEmail" data-oi-mode="email" style="border:none;background:transparent;color:var(--text-dim);padding:5px 12px;font-size:12px;font-weight:600;border-radius:6px;cursor:pointer" disabled title="Klant niet gekoppeld">E-mail</button>' +
            '</div>' +
          '</div>' +
          '<div id="oiThreadMessages" class="oi-thread-messages"><div style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">Laden…</div></div>' +
          '<div id="oiEmailThread" style="display:none;flex:1;min-height:0;overflow:auto;padding:8px 14px 14px"></div>' +
          '<div id="oiSuggestionPanel" style="padding:0 14px"></div>' +
          '<div id="oiThreadFooter" class="oi-thread-footer">' +
            '<div style="display:flex;gap:8px;align-items:flex-start">' +
              '<button type="button" class="refresh-btn" id="oiAskMilaBtn" style="background:#d97706;color:#fff;white-space:nowrap" title="Vraag Mila om een suggestie"><i class="ti ti-sparkles"></i> Vraag Mila</button>' +
              '<button type="button" class="refresh-btn" id="oiTemplateBtn" title="Verstuur een goedgekeurde Meta-template" style="padding:6px 10px"><i class="ti ti-template"></i></button>' +
              '<textarea id="oiComposeTextarea" placeholder="Typ een vrij bericht…" style="flex:1;min-height:62px;max-height:140px;font-family:inherit;font-size:13px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);resize:vertical"></textarea>' +
              '<button type="button" class="refresh-btn" id="oiSendBtn" style="background:var(--brand-deep);color:#fff" title="Versturen"><i class="ti ti-send"></i> Versturen</button>' +
            '</div>' +
            '<div id="oiThreadHint" style="font-size:11.5px;color:var(--text-faint);margin-top:4px"></div>' +
          '</div>' +
        '</div>' +
      '</section>' +
    '</div>' +
  '</div>' +
  '<div id="oiTemplateModal" class="oi-modal-overlay" role="dialog" aria-modal="true">' +
    '<div class="oi-modal-card">' +
      '<div class="oi-modal-header">' +
        '<div class="oi-modal-title">Kies template</div>' +
        '<button type="button" id="oiTemplateClose" style="background:transparent;border:none;font-size:18px;color:var(--text-faint);cursor:pointer">&times;</button>' +
      '</div>' +
      '<input type="search" id="oiTemplateSearch" class="oi-modal-search" placeholder="Zoek template…" />' +
      '<div id="oiTemplateList" class="oi-modal-list"><div style="color:var(--text-faint);font-size:12px;padding:10px">Laden…</div></div>' +
    '</div>' +
  '</div>' +
  '<div class="ob-modal" id="obDetailModal" role="dialog" aria-modal="true" aria-labelledby="obDetailTitle" hidden>' +
    '<div class="ob-modal-card">' +
      '<div class="ob-modal-h">' +
        '<h2 id="obDetailTitle">Onboarding-detail</h2>' +
        '<button type="button" class="ob-modal-x" id="obDetailClose" aria-label="Sluiten">&times;</button>' +
      '</div>' +
      '<div class="ob-modal-body" id="obDetailBody"><div class="empty-state"><span class="skeleton" style="width:160px"></span></div></div>' +
    '</div>' +
  '</div>' +
  '<div class="toast" id="toast"></div>';

  // ──────────────────────────────────────────────────────────────────────────
  // Verbatim port van het oude IIFE-body uit onboarding-admin.html. Functies
  // gebruiken document.getElementById tegen de elementen die mount() in de
  // host injecteert (gelijke ID's als voorheen — zelfde flow + handlers).
  // ──────────────────────────────────────────────────────────────────────────

  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function toast(msg, kind) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show ' + (kind || '');
    setTimeout(() => el.classList.remove('show'), 2400);
  }

  function fmtDateNL(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtDateTimeNL(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const STATUS_LABEL = {
    aangemeld    : 'Aangemeld',
    bezig        : 'Bezig',
    afgerond     : 'Afgerond',
    gearchiveerd : 'Gearchiveerd',
  };
  // Voortgang per status — UX-uitleg zonder wizard-koppeling.
  function progressLabel(row) {
    const st = row?.status || '';
    if (st === 'afgerond')     return 'Afgerond';
    if (st === 'gearchiveerd') return '—';
    if (st === 'bezig')        return row?.current_step ? ('Stap ' + esc(row.current_step)) : 'Wizard bezig';
    return 'Wizard nog niet gestart';
  }

  // State
  let _scope         = 'active';
  let _qSearch       = '';
  let _trajectId     = '';
  let _mentorFilter  = '';
  let _rows          = [];
  let _trajecten     = [];
  let _trajectenLoaded = false;
  let _mentors       = [];
  let _mentorsLoaded = false;
  let _mentorsBlocked = false;          // true bij 403 op /api/mentor-admin-list
  let _canAssign     = false;
  let _searchTimer   = null;

  function mentorNameById(uid) {
    if (!uid) return null;
    const m = _mentors.find((x) => x.user_id === uid);
    return m ? (m.name || m.email || uid) : null;
  }

  function setCounter(n) {
    const c = document.getElementById('counter');
    if (!c) return;
    if (n === 0) {
      c.textContent = _scope === 'archived'
        ? 'Geen gearchiveerde onboardings.'
        : 'Geen actieve onboardings.';
    } else {
      c.innerHTML = `<strong>${n}</strong> ${n === 1 ? 'onboarding' : 'onboardings'} in ${_scope === 'archived' ? 'archief' : 'actief'}`;
    }
  }

  function renderError(msg) {
    const wrap = document.getElementById('tableWrap');
    if (wrap) wrap.innerHTML = `<div class="empty-state" style="border-color:#fecaca;color:#b91c1c"><i class="ti ti-alert-triangle"></i>${esc(msg)}</div>`;
    const c = document.getElementById('counter');
    if (c) c.textContent = '';
  }

  function renderLoading() {
    const wrap = document.getElementById('tableWrap');
    if (wrap) wrap.innerHTML = `<div class="empty-state"><span class="skeleton" style="width:160px"></span></div>`;
    const c = document.getElementById('counter');
    if (c) c.innerHTML = `<span class="skeleton" style="width:120px"></span>`;
  }

  function renderTable() {
    const wrap = document.getElementById('tableWrap');
    if (!wrap) return;
    setCounter(_rows.length);

    if (_rows.length === 0) {
      wrap.innerHTML = `<div class="empty-state"><i class="ti ti-inbox-off"></i>Geen onboardings voor deze selectie.</div>`;
      return;
    }

    const body = _rows.map((r) => rowHtml(r)).join('');
    wrap.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>Klant</th>
            <th>Traject</th>
            <th>Status</th>
            <th>Betaling</th>
            <th>Bedenktijd</th>
            <th>Beschikbaarheid</th>
            <th>Mentor</th>
            <th>Voortgang</th>
            <th>Aangemeld</th>
            <th>Startdatum</th>
            <th>Bubble</th>
            <th style="text-align:right">Acties</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;

    wireRowHandlers();
  }

  function trajectLabelHtml(r) {
    const lbl = r.traject_label || '—';
    const calls = (r.calls != null) ? `<div style="font-size:11.5px;color:var(--text-faint)">${r.calls} call${r.calls === 1 ? '' : 's'}</div>` : '';
    return `<div style="font-weight:600">${esc(lbl)}</div>${calls}`;
  }

  function paidBadgeHtml(paid) {
    return paid
      ? '<span class="ob-badge paid-yes">Betaald</span>'
      : '<span class="ob-badge paid-no">Nog niet betaald</span>';
  }

  // Bubble-provisioning-status (F2). Drie states:
  //   bubble_provisioned=true            → groen "✓ Aangemaakt" (tooltip = aanmaakdatum)
  //   bubble_provisioned=false + error   → rood  "⚠ Mislukt"     (tooltip = error-tekst)
  //   anders (nog niet geprobeerd)       → grijs "—"
  function bubbleBadgeHtml(r) {
    const ok    = r && r.bubble_provisioned === true;
    const err   = r && r.bubble_provision_error ? String(r.bubble_provision_error) : '';
    const stamp = r && r.bubble_provisioned_at  ? String(r.bubble_provisioned_at)  : '';
    if (ok) {
      const tooltip = stamp ? fmtDateTimeNL(stamp) : 'Aangemaakt';
      return `<span class="ob-badge bubble-ok" title="${esc(tooltip)}">✓ Aangemaakt</span>`;
    }
    if (err) {
      return `<span class="ob-badge bubble-fail" title="${esc(err)}">⚠ Mislukt</span>`;
    }
    return '<span class="ob-badge bubble-none">—</span>';
  }

  // Bedenktijd-waiver-badge. waiver = { agreed, at } | null.
  //   null            → '—'  (geen waiver-blok in gepubliceerde structuur)
  //   { agreed:false }→ grijs 'Niet afgezien'
  //   { agreed:true } → groen 'Afgezien ✓ (datum)' (met date als beschikbaar)
  // Korte 2-letter dag-prefix uit een dag-label ("Maandag" → "Ma",
  // "Dinsdag" → "Di", etc.). Eerste letter hoofdletter; rest geknipt
  // op 2 chars. Bij eenletterige labels behouden we wat er is.
  function _shortDayPrefix(label) {
    const s = String(label || '').trim();
    if (!s) return '';
    return s.slice(0, 2);
  }

  // Compacte ééndregel-weergave voor de lijst-kolom.
  //   av = { days:[{label, dayparts:[...]}, ...] } | null
  //   → "Ma: Ochtend, Avond · Wo: Middag"
  //   → "—" bij null / lege days.
  function renderAvailabilityShort(av) {
    if (!av || !Array.isArray(av.days) || av.days.length === 0) {
      return '<span style="color:var(--text-faint)">—</span>';
    }
    const parts = av.days.map((d) => {
      const dp = (d.dayparts || []).join(', ');
      return esc(_shortDayPrefix(d.label)) + ': ' + esc(dp);
    });
    return '<span style="font-size:12.5px;line-height:1.5">' + parts.join(' · ') + '</span>';
  }

  // Volledige weergave voor de detail-modal — alle dagen + dagdelen
  // met de full labels uit de wizard-structuur.
  function renderAvailabilityFull(av) {
    if (!av || !Array.isArray(av.days) || av.days.length === 0) {
      return '<span style="color:var(--text-faint)">—</span>';
    }
    const items = av.days.map((d) => {
      const dp = (d.dayparts || []).join(', ');
      return '<li><strong>' + esc(d.label) + '</strong>: ' + esc(dp) + '</li>';
    }).join('');
    return '<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.55">' + items + '</ul>';
  }

  function waiverBadgeHtml(waiver) {
    if (!waiver) return '<span style="color:var(--text-faint)">—</span>';
    if (!waiver.agreed) return '<span class="ob-badge paid-no">Niet afgezien</span>';
    const d = waiver.at ? new Date(waiver.at) : null;
    const label = (d && !Number.isNaN(d.getTime()))
      ? 'Afgezien ✓ (' + d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }) + ')'
      : 'Afgezien ✓';
    return `<span class="ob-badge paid-yes" title="${esc(waiver.at || '')}">${esc(label)}</span>`;
  }

  // dd-mm formatter voor bedenktijd-labels. ISO → '08-07'.
  function _bedenktijdDdMm(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + '-' + pad(d.getMonth() + 1);
  }

  // Bedenktijd-badge — rijkere weergave die de waiver-trigger (a) én de
  // offerte+14d-trigger (b) samenvat. Backward-compat: zonder bedenktijd-
  // payload valt 'm terug op de bestaande waiverBadgeHtml.
  function bedenktijdBadge(bt, waiver) {
    if (!bt) return waiverBadgeHtml(waiver);
    if (bt.status === 'onbekend') return '<span style="color:var(--text-faint)">—</span>';
    if (bt.status === 'lopend') {
      const vervalt = _bedenktijdDdMm(bt.vervalt_op);
      const offerte = _bedenktijdDdMm(bt.offerte_op);
      const titleParts = [];
      if (offerte) titleParts.push('Offerte getekend ' + offerte);
      const title = titleParts.join(' · ');
      return '<span class="ob-badge" title="' + esc(title) + '" '
        + 'style="background:rgba(214,158,20,.14);color:#8a5a00;border-color:rgba(214,158,20,.35)">'
        + 'Loopt — vervalt ' + esc(vervalt) + '</span>';
    }
    if (bt.status === 'vervallen') {
      if (bt.reason === 'afstand') {
        const waived = _bedenktijdDdMm(bt.waived_at);
        const label = waived ? ('Afstand gedaan ' + waived) : 'Afstand gedaan';
        return '<span class="ob-badge paid-yes" title="' + esc(bt.waived_at || '') + '">' + esc(label) + '</span>';
      }
      if (bt.reason === 'verstreken') {
        const vervalt = _bedenktijdDdMm(bt.vervalt_op);
        const offerte = _bedenktijdDdMm(bt.offerte_op);
        const title = offerte ? ('14 dagen na offerte (' + offerte + ')') : '';
        const label = vervalt ? ('Verstreken ' + vervalt) : 'Verstreken';
        return '<span class="ob-badge paid-yes" title="' + esc(title) + '">' + esc(label) + '</span>';
      }
    }
    return waiverBadgeHtml(waiver);
  }

  function statusBadgeHtml(st) {
    const cls = ['aangemeld','bezig','afgerond','gearchiveerd'].includes(st) ? st : 'aangemeld';
    return `<span class="ob-badge ${cls}">${esc(STATUS_LABEL[st] || st || '—')}</span>`;
  }

  function mentorCellHtml(r) {
    const name = r.mentor_name || (r.mentor_user_id ? mentorNameById(r.mentor_user_id) : null);
    if (!_canAssign || _mentorsBlocked) {
      return `<div>${esc(name || '—')}</div>`;
    }
    // Inline edit-pattern: select + save-btn. Save staat default-disabled tot
    // de waarde verandert.
    const cur = r.mentor_user_id || '';
    const opts = ['<option value="">— geen / ontkoppelen —</option>']
      .concat(_mentors.map((m) => {
        const sel = (m.user_id === cur) ? ' selected' : '';
        const lbl = m.name || m.email || m.user_id;
        return `<option value="${esc(m.user_id)}"${sel}>${esc(lbl)}</option>`;
      }))
      .join('');
    return `
      <div class="ob-mentor-cell" data-row-id="${esc(r.id)}" data-cur="${esc(cur)}">
        <select class="ob-mentor-sel">${opts}</select>
        <button type="button" class="save-btn" disabled>Opslaan</button>
      </div>`;
  }

  // Portal-kebab — één <div> op document.body met position:fixed; flip-up
  // als er onderaan geen ruimte is; sluit op outside-click / scroll
  // (capture, dus ook scroll-containers) / Escape / resize.
  let _actMenu = null;
  function ensureKebabStyles() {
    if (document.getElementById('ob-kebab-styles')) return;
    const s = document.createElement('style');
    s.id = 'ob-kebab-styles';
    s.textContent = `
      .ob-kebab{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;
        border:none;border-radius:50%;background:transparent;color:var(--text-dim,#64748b);
        cursor:pointer;font-size:18px;line-height:1;transition:background .12s ease,color .12s ease;}
      .ob-kebab:hover{background:var(--bg-elev,#f1f5f9);color:var(--text,#0f172a);}
      .ob-kebab:focus-visible{outline:2px solid var(--brand-azure,#1e6cd6);outline-offset:1px;}
      .ob-kebab-dots{font-size:20px;line-height:1;font-weight:700;display:block;transform:translateY(-1px);}
      .ob-act-menu{position:fixed;z-index:9999;min-width:178px;background:var(--bg,#fff);
        border:1px solid var(--border,#e2e8f0);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.16);
        padding:5px;display:none;}
      .ob-act-menu.open{display:block;}
      .ob-act-menu button{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:transparent;
        border:none;border-radius:7px;padding:9px 11px;font-size:13.5px;color:var(--text,#0f172a);cursor:pointer;
        white-space:nowrap;}
      .ob-act-menu button:hover{background:var(--bg-elev,#f1f5f9);}
      .ob-act-menu button.danger{color:#b91c1c;}
      .ob-act-menu button.danger:hover{background:rgba(220,38,38,.07);}
      .ob-act-menu .ti{font-size:16px;flex:0 0 auto;}`;
    document.head.appendChild(s);
  }
  function closeActMenu() {
    if (!_actMenu) return;
    _actMenu.classList.remove('open');
    if (_actMenu._kebab) { _actMenu._kebab.setAttribute('aria-expanded', 'false'); _actMenu._kebab = null; }
  }
  function ensureActMenu() {
    if (_actMenu) return _actMenu;
    ensureKebabStyles();
    _actMenu = document.createElement('div');
    _actMenu.className = 'ob-act-menu';
    _actMenu.setAttribute('role', 'menu');
    document.body.appendChild(_actMenu);
    document.addEventListener('mousedown', (e) => {
      if (!_actMenu.classList.contains('open')) return;
      if (_actMenu.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.ob-kebab')) return;
      closeActMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActMenu(); });
    window.addEventListener('scroll', closeActMenu, true); // capture → ook scroll-containers
    window.addEventListener('resize', closeActMenu);
    return _actMenu;
  }
  function openKebabMenu(k) {
    const menu = ensureActMenu();
    if (menu.classList.contains('open') && menu._kebab === k) { closeActMenu(); return; }
    const id = k.dataset.id, token = k.dataset.token || '', archived = k.dataset.archived === '1';
    const archItem = archived
      ? `<button type="button" data-act="restore"><i class="ti ti-archive-off"></i>Herstellen</button>`
      : `<button type="button" data-act="archive" class="danger"><i class="ti ti-archive"></i>Archiveer</button>`;
    menu.innerHTML =
      `<button type="button" data-act="copy"><i class="ti ti-copy"></i>Link kopiëren</button>` +
      `<button type="button" data-act="view"><i class="ti ti-eye"></i>Bekijk</button>` +
      archItem;
    menu.querySelectorAll('button').forEach((mb) => {
      mb.addEventListener('click', () => {
        const act = mb.dataset.act;
        closeActMenu();
        if (act === 'copy')    return copyLink(token, k);
        if (act === 'view')    return openDetail(id);
        if (act === 'archive') return doArchive(id, 'archive');
        if (act === 'restore') return doArchive(id, 'restore');
      });
    });
    // Eerst tonen (voor offsetWidth/Height), dan positioneren.
    menu.classList.add('open');
    const rect = k.getBoundingClientRect();
    const mw = menu.offsetWidth || 178, mh = menu.offsetHeight || 130, pad = 8;
    let left = rect.right - mw;                 // rechts uitlijnen op de kebab
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - pad - mw;
    if (left < pad) left = pad;
    let top = rect.bottom + 6;                  // standaard onder de kebab
    if (top + mh > window.innerHeight - pad) top = rect.top - mh - 6; // anders erboven
    if (top < pad) top = pad;
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';
    menu._kebab = k;
    k.setAttribute('aria-expanded', 'true');
  }

  function actionsCellHtml(r) {
    const isArchived = (r.status === 'gearchiveerd');
    return `
      <div class="ob-row-actions" style="justify-content:flex-end">
        <button type="button" class="ob-kebab" aria-label="Acties" aria-haspopup="true" aria-expanded="false"
          data-id="${esc(r.id)}" data-token="${esc(r.token || '')}" data-archived="${isArchived ? '1' : '0'}">
          <span class="ob-kebab-dots" aria-hidden="true">&#8942;</span>
        </button>
      </div>`;
  }

  function rowHtml(r) {
    return `
      <tr data-row-id="${esc(r.id)}">
        <td><div style="font-weight:600">${esc(r.customer_name || '—')}</div></td>
        <td>${trajectLabelHtml(r)}</td>
        <td>${statusBadgeHtml(r.status)}</td>
        <td>${paidBadgeHtml(!!r.paid)}</td>
        <td>${bedenktijdBadge(r.bedenktijd || null, r.waiver || null)}</td>
        <td>${renderAvailabilityShort(r.availability || null)}</td>
        <td>${mentorCellHtml(r)}</td>
        <td>${esc(progressLabel(r))}</td>
        <td>${esc(fmtDateNL(r.created_at))}</td>
        <td>${r.start_date ? esc(fmtDateNL(r.start_date)) : '<span style="color:var(--text-faint)">— niet ingesteld</span>'}</td>
        <td>${bubbleBadgeHtml(r)}</td>
        <td style="text-align:right">${actionsCellHtml(r)}</td>
      </tr>`;
  }

  function wireRowHandlers() {
    // Mentor inline edit (alleen aanwezig als _canAssign && !blocked).
    document.querySelectorAll('.ob-mentor-cell').forEach((cell) => {
      const sel = cell.querySelector('select');
      const btn = cell.querySelector('button.save-btn');
      if (!sel || !btn) return;
      const orig = cell.dataset.cur || '';
      sel.addEventListener('change', () => {
        btn.disabled = (sel.value === orig);
      });
      btn.addEventListener('click', () => {
        const rowId = cell.dataset.rowId;
        const newVal = sel.value;
        saveMentor(rowId, newVal || null, btn, cell);
      });
    });

    // Kebab — opent het portal-menu; alle acties (copy/view/archive/restore)
    // worden vanuit het menu zelf aan copyLink/openDetail/doArchive gerouteerd.
    document.querySelectorAll('.ob-kebab').forEach((k) => {
      k.addEventListener('click', (e) => { e.stopPropagation(); openKebabMenu(k); });
    });
  }

  async function copyLink(token, btn) {
    if (!token) { toast('Geen token op deze onboarding', 'error'); return; }
    const url = location.origin + '/modules/onboarding.html?t=' + encodeURIComponent(token);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        // execCommand-fallback voor oudere browsers.
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const orig = btn.innerHTML;
      btn.innerHTML = '<i class="ti ti-check"></i>Gekopieerd';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    } catch (e) {
      toast('Kopiëren mislukt', 'error');
    }
  }

  async function saveMentor(onboardingId, mentorUserId, btn, cell) {
    if (!onboardingId) return;
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Bezig…';
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-assign-mentor', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ onboarding_id: onboardingId, mentor_user_id: mentorUserId }),
      });
      let d = null; try { d = await r.json(); } catch {}
      if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
      // Lokale state bijwerken + visuele bevestiging zonder volledige refetch.
      const row = _rows.find((x) => x.id === onboardingId);
      if (row) {
        row.mentor_user_id = mentorUserId || null;
        row.mentor_name    = mentorUserId ? mentorNameById(mentorUserId) : null;
        row.assigned_at    = d?.assigned_at || null;
      }
      cell.dataset.cur = mentorUserId || '';
      btn.textContent = '✓ Opgeslagen';
      setTimeout(() => { btn.textContent = origText; }, 1400);
      toast('Mentor bijgewerkt', 'success');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = origText;
      toast('Mentor opslaan mislukt: ' + (e?.message || e), 'error');
    }
  }

  async function doArchive(onboardingId, action) {
    if (!onboardingId) return;
    const verb = (action === 'archive') ? 'archiveren' : 'herstellen';
    if (!confirm(`Weet je zeker dat je deze onboarding wilt ${verb}?`)) return;
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-archive', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ onboarding_id: onboardingId, action }),
      });
      let d = null; try { d = await r.json(); } catch {}
      if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
      toast((action === 'archive' ? 'Gearchiveerd' : 'Hersteld') + ' (' + (d?.status || '?') + ')', 'success');
      loadList();
    } catch (e) {
      toast('Actie mislukt: ' + (e?.message || e), 'error');
    }
  }

  // ── Detail-modal ─────────────────────────────────────────────────────
  function _closeDetail() {
    const m = document.getElementById('obDetailModal');
    m.classList.remove('open');
    m.setAttribute('hidden', '');
  }
  function _wireDetailModal() {
    const m  = document.getElementById('obDetailModal');
    const x  = document.getElementById('obDetailClose');
    if (!m) return;
    if (x) x.addEventListener('click', _closeDetail);
    m.addEventListener('click', (ev) => { if (ev.target === m) _closeDetail(); });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && m.classList.contains('open')) _closeDetail();
    });
  }

  async function openDetail(id) {
    if (!id) return;
    const m  = document.getElementById('obDetailModal');
    const bd = document.getElementById('obDetailBody');
    m.removeAttribute('hidden');
    m.classList.add('open');
    bd.innerHTML = `<div class="empty-state"><span class="skeleton" style="width:160px"></span></div>`;
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-detail?id=' + encodeURIComponent(id));
      let d = null; try { d = await r.json(); } catch {}
      if (r.status === 404) { bd.innerHTML = `<div class="empty-state">Onboarding niet gevonden.</div>`; return; }
      if (r.status === 401) { bd.innerHTML = `<div class="empty-state" style="color:#b91c1c">Niet (meer) ingelogd.</div>`; return; }
      if (r.status === 403) { bd.innerHTML = `<div class="empty-state" style="color:#b91c1c">Geen rechten (onboarding.admin).</div>`; return; }
      if (!r.ok) { bd.innerHTML = `<div class="empty-state" style="color:#b91c1c">Ophalen mislukt: ${esc(d?.error || ('HTTP ' + r.status))}</div>`; return; }
      const o = d?.onboarding || {};
      const link = (o.token) ? (location.origin + '/modules/onboarding.html?t=' + encodeURIComponent(o.token)) : null;
      const answersJson = (o.answers && typeof o.answers === 'object')
        ? JSON.stringify(o.answers, null, 2)
        : null;
      bd.innerHTML = `
        <dl>
          <dt>Klant</dt>            <dd>${esc(o.customer_name || '—')}</dd>
          <dt>Traject</dt>          <dd>${esc(o.traject_label || '—')}${o.traject_type ? ' <span class="ob-badge paid-no">' + esc(o.traject_type) + '</span>' : ''}${o.calls != null ? ' · ' + o.calls + ' call' + (o.calls===1?'':'s') : ''}${o.duur_maanden != null ? ' · ' + o.duur_maanden + ' mnd' : ''}</dd>
          <dt>Status</dt>           <dd>${statusBadgeHtml(o.status)}</dd>
          <dt>Betaling</dt>         <dd>${paidBadgeHtml(!!o.paid)}</dd>
          <dt>Bedenktijd</dt>       <dd>${bedenktijdBadge(o.bedenktijd || null, o.waiver || null)}</dd>
          <dt>Beschikbaarheid</dt>  <dd>${renderAvailabilityFull(o.availability || null)}</dd>
          <dt>Mentor</dt>           <dd>${esc(o.mentor_name || (o.mentor_user_id || '—'))}</dd>
          <dt>Wizard-stap</dt>      <dd>${esc(o.current_step || '—')}</dd>
          <dt>Aangemeld</dt>        <dd>${esc(fmtDateTimeNL(o.created_at))}</dd>
          <dt>Startdatum</dt>       <dd>${o.start_date ? esc(fmtDateNL(o.start_date)) : '<span style="color:var(--text-faint)">— niet ingesteld (basis = nu)</span>'}</dd>
          <dt>Toegewezen</dt>       <dd>${esc(fmtDateTimeNL(o.assigned_at))}</dd>
          <dt>Gestart</dt>          <dd>${esc(fmtDateTimeNL(o.started_at))}</dd>
          <dt>Afgerond</dt>         <dd>${esc(fmtDateTimeNL(o.completed_at))}</dd>
          <dt>Gearchiveerd</dt>     <dd>${esc(fmtDateTimeNL(o.archived_at))}</dd>
          <dt>Bubble-status</dt>    <dd>${bubbleBadgeHtml(o)}${o.bubble_provisioned_at ? ' <span style="color:var(--text-faint);font-size:12px">· ' + esc(fmtDateTimeNL(o.bubble_provisioned_at)) + '</span>' : ''}</dd>
          ${o.bubble_user_id        ? `<dt>Bubble user-id</dt><dd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all">${esc(o.bubble_user_id)}</dd>` : ''}
          ${o.bubble_provision_error ? `<dt>Bubble-fout</dt><dd style="color:#b91c1c;white-space:pre-wrap;font-size:12.5px">${esc(o.bubble_provision_error)}</dd>` : ''}
          ${(!o.bubble_provisioned)
            ? `<dt>Bubble-actie</dt><dd>
                 <button type="button" class="ob-act primary" id="bubbleRetryBtn" data-id="${esc(o.id)}">
                   <i class="ti ti-refresh"></i>Bubble opnieuw aanmaken
                 </button>
                 <span id="bubbleRetryStatus" style="margin-left:8px;font-size:12.5px;color:var(--text-dim)"></span>
               </dd>`
            : ''}
          <dt>WhatsApp-uitnodiging</dt><dd>
            ${o.invite_sent_at
              ? '<span style="background:rgba(34,197,94,0.14);color:#15803d;padding:2px 9px;border-radius:10px;font-size:11.5px;font-weight:600">✓ Verstuurd</span> <span style="color:var(--text-faint);font-size:12px">· ' + esc(fmtDateTimeNL(o.invite_sent_at)) + '</span>'
              : '<span style="background:rgba(100,116,139,0.18);color:#475569;padding:2px 9px;border-radius:10px;font-size:11.5px;font-weight:600">— Nog niet verstuurd</span>'}
            <button type="button" class="ob-act primary" id="oiInviteSendBtn" data-id="${esc(o.id)}" data-already-sent="${o.invite_sent_at ? '1' : '0'}" style="margin-left:8px;background:#d97706;border-color:#d97706">
              <i class="ti ti-send"></i> ${o.invite_sent_at ? 'Opnieuw versturen' : 'Stuur WhatsApp-uitnodiging'}
            </button>
            <span id="oiInviteSendStatus" style="margin-left:8px;font-size:12.5px;color:var(--text-dim)"></span>
          </dd>
          <dt>Inloggegevens</dt><dd>
            ${o.credentials_email_sent_at
              ? '<span style="background:rgba(34,197,94,0.14);color:#15803d;padding:2px 9px;border-radius:10px;font-size:11.5px;font-weight:600">✓ E-mail verstuurd</span> <span style="color:var(--text-faint);font-size:12px">· ' + esc(fmtDateTimeNL(o.credentials_email_sent_at)) + '</span>'
              : '<span style="background:rgba(100,116,139,0.18);color:#475569;padding:2px 9px;border-radius:10px;font-size:11.5px;font-weight:600">— E-mail nog niet verstuurd</span>'}
          </dd>
          ${link ? `<dt>Persoonlijke link</dt><dd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all">${esc(link)}</dd>` : ''}
        </dl>
        <h3>Vragenlijst-antwoorden</h3>
        ${answersJson
          ? `<pre>${esc(answersJson)}</pre>`
          : `<div class="empty-state"><i class="ti ti-clipboard-off"></i>Nog geen antwoorden — wizard nog niet gestart of nog niet ingevuld.</div>`}`;
      // Bubble-retry knop wiren (alleen aanwezig als onboarding niet-provisioned).
      const retryBtn = document.getElementById('bubbleRetryBtn');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          doProvisionRetry(retryBtn.dataset.id || '', retryBtn);
        });
      }
      // Invite-knop wiren (altijd aanwezig; tekst+force-flag verschillen
      // wanneer invite_sent_at gevuld is).
      const inviteBtn = document.getElementById('oiInviteSendBtn');
      if (inviteBtn) {
        inviteBtn.addEventListener('click', () => {
          const alreadySent = inviteBtn.dataset.alreadySent === '1';
          doSendInvite(inviteBtn.dataset.id || '', inviteBtn, { force: alreadySent });
        });
      }
    } catch (e) {
      bd.innerHTML = `<div class="empty-state" style="color:#b91c1c">Ophalen mislukt: ${esc(e?.message || e)}</div>`;
    }
  }

  // ── Bubble-provisioning retry ────────────────────────────────────────
  // Roept /api/onboarding-provision-retry aan voor één onboarding. Endpoint
  // is fail-soft: 200 met { ok, partial?, error? }. We zetten de knop op
  // disabled tijdens de call, tonen inline status (spinner-tekst), en bij
  // succes refreshen we de lijst + heropenen we de detail-modal zodat de
  // nieuwe badge-status meteen zichtbaar is.
  async function doProvisionRetry(onboardingId, btn) {
    if (!onboardingId) return;
    const status = document.getElementById('bubbleRetryStatus');
    if (btn) btn.disabled = true;
    if (status) {
      status.style.color  = 'var(--text-dim)';
      status.textContent  = 'Bezig met aanmaken in Bubble…';
    }
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-provision-retry', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ onboarding_id: onboardingId }),
      });
      let d = null; try { d = await r.json(); } catch {}
      if (r.status === 401) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Niet (meer) ingelogd.'; }
        return;
      }
      if (r.status === 403) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Geen rechten (onboarding.admin).'; }
        return;
      }
      if (!r.ok) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Mislukt: ' + (d?.error || ('HTTP ' + r.status)); }
        return;
      }
      // Endpoint geeft altijd 200; success vs partial vs hard-fail uit body.
      if (d && d.ok === true) {
        if (status) {
          status.style.color = '#15803d';
          status.textContent = d.skipped ? '✓ Al aangemaakt' : '✓ Gelukt';
        }
        toast(d.skipped ? 'Was al aangemaakt' : 'Bubble-account aangemaakt', 'success');
        // Lijst verversen + modal heropenen met verse data.
        loadList();
        setTimeout(() => { openDetail(onboardingId); }, 250);
        return;
      }
      // partial of harde fail.
      const errMsg = (d?.error || 'Onbekende fout');
      if (status) {
        status.style.color = '#b91c1c';
        status.textContent = (d?.partial ? '⚠ Gedeeltelijk: ' : '✗ Mislukt: ') + errMsg;
      }
      toast((d?.partial ? 'Gedeeltelijk gelukt: ' : 'Bubble-aanmaak mislukt: ') + errMsg, 'error');
      // Bij partial heeft de retry een bubble_user_id opgeslagen — een volgende
      // poging kan zinvol zijn. Re-enable de knop zodat de admin nogmaals kan
      // proberen na onderzoek.
      if (btn) btn.disabled = false;
    } catch (e) {
      console.error('[onboarding-admin] retry:', e?.message || e);
      if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Onverwachte fout: ' + (e?.message || e); }
      if (btn) btn.disabled = false;
    }
  }

  // ── Onboarding-invite (WhatsApp) ─────────────────────────────────────
  // Roept /api/onboarding-invite-send aan voor één onboarding. Endpoint is
  // fail-soft: 200 met { sent, reason?, error?, ... }. Bij { force:true }
  // overschrijft de helper invite_sent_at (gebruikt voor 'Opnieuw versturen').
  // We zetten de knop op disabled tijdens de call + tonen inline status;
  // bij succes refreshen we de lijst + heropenen we de detail-modal.
  async function doSendInvite(onboardingId, btn, opts) {
    if (!onboardingId) return;
    const force = !!(opts && opts.force);
    const status = document.getElementById('oiInviteSendStatus');
    if (force && !confirm('Deze klant heeft al een uitnodiging gehad. Toch opnieuw versturen?')) return;
    if (btn) btn.disabled = true;
    if (status) {
      status.style.color = 'var(--text-dim)';
      status.textContent = 'Bezig met versturen…';
    }
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-invite-send', {
        method  : 'POST',
        headers : { 'Content-Type': 'application/json' },
        body    : JSON.stringify({ onboarding_id: onboardingId, force }),
      });
      let d = null; try { d = await r.json(); } catch {}
      if (r.status === 401) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Niet (meer) ingelogd.'; }
        return;
      }
      if (r.status === 403) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Geen rechten (onboarding.inbox.send).'; }
        return;
      }
      if (!r.ok) {
        if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Mislukt: ' + (d?.error || ('HTTP ' + r.status)); }
        return;
      }
      // 200 — sent vs reason.
      if (d && d.sent === true) {
        if (status) { status.style.color = '#15803d'; status.textContent = '✓ Verstuurd' + (d.meta_wamid ? ' (wamid ' + String(d.meta_wamid).slice(0, 12) + '…)' : ''); }
        toast(force ? 'WhatsApp-uitnodiging opnieuw verstuurd' : 'WhatsApp-uitnodiging verstuurd', 'success');
        loadList();
        setTimeout(() => { openDetail(onboardingId); }, 350);
        return;
      }
      // sent=false → toon reason+error.
      const reason = d?.reason || 'onbekend';
      const errMsg = d?.error ? (' — ' + d.error) : '';
      const label = ({
        'geen-template-config'   : 'Geen template geconfigureerd (joost_config.knowledge_base.invite.template_name)',
        'geen-module-config'     : 'Onboarding-WhatsApp-lijn niet actief in whatsapp_module_config',
        'geen-telefoon'          : 'Klant heeft geen telefoonnummer',
        'already-sent'           : 'Al verstuurd (gebruik Opnieuw versturen)',
        'template-niet-gevonden' : 'Template-naam niet gevonden in whatsapp_meta_templates',
        'template-niet-approved' : 'Template-status is niet APPROVED',
        'archived'               : 'Onboarding is gearchiveerd',
        'no-token'               : 'Geen token op deze onboarding',
        'no-customer'            : 'Geen klant aan deze onboarding gekoppeld',
        'invite-uit-gezet'       : 'Invite-flag staat uit (joost_config.knowledge_base.invite.enabled=false)',
      })[reason] || ('reason=' + reason);
      if (status) { status.style.color = '#b45309'; status.textContent = '⚠ Niet verstuurd: ' + label + errMsg; }
      toast('Niet verstuurd: ' + label, 'info');
    } catch (e) {
      console.error('[onboarding-admin] invite:', e?.message || e);
      if (status) { status.style.color = '#b91c1c'; status.textContent = '✗ Onverwachte fout: ' + (e?.message || e); }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── Fetch ─────────────────────────────────────────────────────────────
  async function loadList() {
    const apiFetch = window.AgentShared?.apiFetch;
    if (typeof apiFetch !== 'function') { renderError('apiFetch niet beschikbaar.'); return; }
    renderLoading();
    try {
      const qs = new URLSearchParams();
      qs.set('scope', _scope);
      if (_qSearch)      qs.set('q',              _qSearch);
      if (_trajectId)    qs.set('traject_id',     _trajectId);
      if (_mentorFilter) qs.set('mentor_user_id', _mentorFilter);
      const r = await apiFetch('/api/onboardings-admin-list?' + qs.toString());
      let d = null; try { d = await r.json(); } catch {}
      if (r.status === 401) { renderError('Niet (meer) ingelogd — log opnieuw in.'); return; }
      if (r.status === 403) { renderError('Geen rechten (onboarding.admin).');       return; }
      if (!r.ok)            { renderError('Ophalen mislukt: ' + (d?.error || ('HTTP ' + r.status))); return; }
      _rows = Array.isArray(d?.rows) ? d.rows : [];
      renderTable();
    } catch (e) {
      console.error('[onboarding-admin] list:', e?.message || e);
      renderError('Ophalen mislukt: ' + (e?.message || e));
    }
  }

  async function ensureTrajectenLoaded() {
    if (_trajectenLoaded) return;
    const sel = document.getElementById('trajectFilter');
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-trajecten-list');
      let d = null; try { d = await r.json(); } catch {}
      if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
      _trajecten = Array.isArray(d?.trajecten) ? d.trajecten : [];
      _trajectenLoaded = true;
      sel.innerHTML = '<option value="">— alle trajecten —</option>'
        + _trajecten.map((t) => `<option value="${esc(t.id)}">${esc(t.label || t.key || t.id)}</option>`).join('');
    } catch (e) {
      console.warn('[onboarding-admin] trajecten:', e?.message || e);
      // Filter blijft "— alle —"; geen blocking.
    }
  }

  async function ensureMentorsLoaded() {
    if (_mentorsLoaded) return;
    // Hergebruik bestaande bron uit mentor-detail.html / mentor-payouts-admin.html.
    const sel = document.getElementById('mentorFilter');
    try {
      const r = await window.AgentShared.apiFetch('/api/mentor-admin-list');
      let d = null; try { d = await r.json(); } catch {}
      if (r.status === 403) {
        // User mag wel onboarding.admin maar niet mentor.admin.view — dan kan
        // hij de mentor-lijst niet zien. UI valt elegant terug: dropdown
        // disabled, inline edit verborgen.
        _mentorsBlocked = true;
        _mentorsLoaded  = true;
        sel.disabled = true;
        sel.title = 'Geen rechten om mentoren te lezen (mentor.admin.view)';
        return;
      }
      if (!r.ok) throw new Error(d?.error || ('HTTP ' + r.status));
      _mentors = Array.isArray(d?.mentors) ? d.mentors : [];
      _mentorsLoaded = true;
      sel.innerHTML = '<option value="">— alle mentoren —</option>'
        + _mentors.map((m) => `<option value="${esc(m.user_id)}">${esc(m.name || m.email || m.user_id)}</option>`).join('');
    } catch (e) {
      console.warn('[onboarding-admin] mentors:', e?.message || e);
      // Geen blocking; filter blijft leeg.
    }
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  function wireTabs() {
    document.querySelectorAll('.ob-tab').forEach((b) => {
      b.addEventListener('click', () => {
        const next = b.dataset.scope;
        if (next === _scope) return;
        _scope = next;
        document.querySelectorAll('.ob-tab').forEach((x) => x.classList.toggle('active', x === b));
        // Tab-switch: 'inbox' toggelt naar de Mila-inbox-pane; 'active'/'archived'
        // gebruiken de bestaande lijst.
        const paneList  = document.getElementById('pane-list');
        const paneInbox = document.getElementById('pane-inbox');
        if (next === 'inbox') {
          if (paneList)  paneList.style.display  = 'none';
          if (paneInbox) paneInbox.style.display = '';
          loadOnboardingInbox();
        } else {
          if (paneInbox) paneInbox.style.display = 'none';
          if (paneList)  paneList.style.display  = '';
          loadList();
        }
      });
    });
  }

  function wireFilters() {
    const search = document.getElementById('searchBox');
    if (search) search.addEventListener('input', () => {
      _qSearch = search.value || '';
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(loadList, 280);
    });
    const trajectSel = document.getElementById('trajectFilter');
    if (trajectSel) trajectSel.addEventListener('change', () => {
      _trajectId = trajectSel.value || '';
      loadList();
    });
    const mentorSel = document.getElementById('mentorFilter');
    if (mentorSel) mentorSel.addEventListener('change', () => {
      _mentorFilter = mentorSel.value || '';
      loadList();
    });
    const refresh = document.getElementById('refreshBtn');
    if (refresh) refresh.addEventListener('click', loadList);
  }

  async function init() {
    try { if (window._authSharedReady) await window._authSharedReady; } catch {}
    // RBAC: bepaal of mentor-assign zichtbaar mag zijn. Page-gate (onboarding.admin)
    // doet sidebar.js al; we vertrouwen ook server-side requirePermission.
    try {
      if (window.RBAC && typeof window.RBAC.ensurePermissionsLoaded === 'function') {
        await window.RBAC.ensurePermissionsLoaded();
        _canAssign = !!window.RBAC.canSync && window.RBAC.canSync('onboarding.assign_mentor');
      }
    } catch (e) { console.warn('[onboarding-admin] RBAC load faalde:', e?.message || e); }

    _wireDetailModal();
    wireTabs();
    wireFilters();
    wireOnboardingInbox();

    // Inbox-tab tonen alleen met onboarding.inbox.view-permissie. Page-gate
    // (onboarding.admin) is door sidebar.js al gedaan; deze tab is een
    // separate read-scope. Bij ontbrekende RBAC.canSync (timing) verbergen
    // we de tab; server-side gate'n endpoints sowieso.
    try {
      const canInbox = !!(window.RBAC?.canSync?.('onboarding.inbox.view'));
      const tab = document.getElementById('tab-inbox');
      if (tab) tab.style.display = canInbox ? '' : 'none';
      if (canInbox) {
        // Initiële badge-fetch + 60s poll-interval (parallel met events-pattern).
        _oiRefreshInboxManualBadge();
        if (!window._oiInboxBadgeTimer) {
          window._oiInboxBadgeTimer = setInterval(_oiRefreshInboxManualBadge, 60000);
          window.addEventListener('beforeunload', () => {
            if (window._oiInboxBadgeTimer) { clearInterval(window._oiInboxBadgeTimer); window._oiInboxBadgeTimer = null; }
          });
        }
      }
    } catch (e) { console.warn('[onboarding-admin] inbox tab gate:', e?.message || e); }

    // Trajecten + mentoren parallel — beide fail-soft.
    await Promise.all([ensureTrajectenLoaded(), ensureMentorsLoaded()]);

    loadList();
  }

  // ────────────────────────────────────────────────────────────────────────
  // Onboarding-inbox (B2 port van events.html inbox-tab).
  //
  // Twee-paneel-shell:
  //   - LINKS: gesprekken voor module=onboarding via /api/inbox-conversations-list
  //   - RECHTS: thread + composer + Mila-suggestiepaneel
  //
  // State volledig lokaal (_oiState); raakt _scope / _rows niet. apiFetch
  // is window.AgentShared.apiFetch (Bearer-token automatisch). Realtime is
  // bewust ge-skipt — handmatige refresh-knop + 60s badge-poll.
  // ────────────────────────────────────────────────────────────────────────
  const _oiState = {
    convId:              null,
    conv:                null,
    canSendText:         false,
    suggestion:          null,
    editingSuggestionId: null,
    mode:                'wa',  // 'wa' | 'email' — segmented control boven thread
    emailLoaded:         false, // cache: één fetch per geopende conv
    emailItems:          [],
    emailWarning:        null,
    emailCustomerEmail:  '',
  };
  const _oiTplState = { items: [], filter: '', loaded: false, sendingFor: null };

  function _oiAvatarInitial(s) {
    const txt = String(s || '?').trim();
    const m = txt.match(/[A-Za-z0-9]/);
    return (m ? m[0] : '?').toUpperCase();
  }

  // Update "Handmatig overnemen"-tab-badge. Bron: items met unread_count > 0
  // (proxy voor "wacht op handmatige reactie" — gespiegeld aan events).
  function _oiUpdateInboxManualBadge(items) {
    const badge = document.getElementById('oiInboxManualBadge');
    if (!badge) return;
    if (!Array.isArray(items)) { badge.style.display = 'none'; return; }
    let n = 0;
    for (const it of items) {
      if (Number(it && it.unread_count) > 0) n++;
    }
    if (n > 0) { badge.textContent = String(n); badge.style.display = ''; }
    else       { badge.style.display = 'none'; }
  }

  async function _oiRefreshInboxManualBadge() {
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-conversations-list?module=onboarding&limit=100');
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (!j || j.configured === false) {
        const badge = document.getElementById('oiInboxManualBadge');
        if (badge) badge.style.display = 'none';
        return;
      }
      _oiUpdateInboxManualBadge(Array.isArray(j.items) ? j.items : []);
    } catch (_e) { /* stille no-op */ }
  }

  function _oiShowThreadView() {
    const shell = document.getElementById('oiInboxShell');
    const empty = document.getElementById('oiThreadEmpty');
    const cont  = document.getElementById('oiThreadContent');
    if (shell) shell.classList.add('thread-open');
    if (empty) empty.style.display = 'none';
    if (cont)  cont.style.display  = 'flex';
  }
  function _oiShowListView() {
    const shell = document.getElementById('oiInboxShell');
    const empty = document.getElementById('oiThreadEmpty');
    const cont  = document.getElementById('oiThreadContent');
    if (shell) shell.classList.remove('thread-open');
    if (empty) empty.style.display = '';
    if (cont)  cont.style.display  = 'none';
    _oiState.convId = null;
    _oiState.conv = null;
    _oiState.suggestion = null;
    _oiState.editingSuggestionId = null;
    document.querySelectorAll('#oiInboxList .oi-conv-row.active').forEach((el) => el.classList.remove('active'));
  }

  async function loadOnboardingInbox() {
    const list = document.getElementById('oiInboxList');
    if (!list) return;
    list.innerHTML = '<div class="oi-skel-row"></div><div class="oi-skel-row"></div>';
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-conversations-list?module=onboarding&limit=100');
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        list.innerHTML = '<div class="empty-state" style="color:#b91c1c;font-size:13px;padding:16px">Fout: ' + esc(j.error || ('HTTP ' + r.status)) + '</div>';
        return;
      }
      const j = await r.json();
      if (!j.configured) {
        list.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center">'
          + '<i class="ti ti-plug-connected-x" style="font-size:24px;color:var(--text-faint)"></i>'
          + '<div style="font-size:14px;font-weight:600;margin-top:6px">Onboarding-lijn nog niet geconfigureerd</div>'
          + '<div style="font-size:12.5px;color:var(--text-dim);margin-top:4px">' + esc(j.warning || 'Vraag een admin om whatsapp_module_config met module=onboarding op is_active=true te zetten.') + '</div>'
          + '</div>';
        return;
      }
      const items = Array.isArray(j.items) ? j.items : [];
      _oiUpdateInboxManualBadge(items);
      if (items.length === 0) {
        list.innerHTML = '<div class="empty-state" style="padding:24px;text-align:center">'
          + '<i class="ti ti-inbox" style="font-size:24px;color:var(--text-faint)"></i>'
          + '<div style="font-size:14px;font-weight:600;margin-top:6px">Nog geen onboarding-conversaties</div>'
          + '<div style="font-size:12.5px;color:var(--text-dim);margin-top:4px">Inbound op de onboarding-WhatsApp-lijn verschijnt hier.</div>'
          + '</div>';
        return;
      }
      const activeId = _oiState.convId || null;
      list.innerHTML = items.map((it) => {
        const preview    = (it.last_message_preview || '').slice(0, 80);
        const nameLabel  = it.customer_name || it.display_name || it.phone_number || '(geen naam)';
        const subtitle   = it.customer_name && it.display_name && it.display_name !== it.customer_name
          ? it.display_name : (it.phone_number || '');
        const timeShort  = it.last_message_at ? esc(fmtDateNL(it.last_message_at)) : '';
        const isActive   = activeId && it.id === activeId ? ' active' : '';
        const dotCls     = it.can_send_text ? 'open' : 'closed';
        const dotTitle   = it.can_send_text ? '24h-venster open — vrij bericht toegestaan' : '24h-venster verlopen — alleen template';
        // "Handmatig overnemen"-badge: gebruikt unread_count > 0 als proxy
        // voor needs_human (events-pattern). Een conv die nog ongelezen
        // inbound heeft = wacht op een handmatig/Mila-antwoord.
        const handoff = Number(it.unread_count) > 0
          ? '<span class="oi-conv-handoff" title="Wacht op handmatig of Mila-antwoord">Handmatig overnemen</span>'
          : '';
        return ''
          + '<div class="oi-conv-row' + isActive + '" data-conv-id="' + esc(it.id) + '"'
          + ' data-phone="' + esc(it.phone_number || '') + '"'
          + ' data-display="' + esc(it.display_name || '') + '"'
          + ' data-customer="' + esc(it.customer_name || '') + '">'
          +   '<div class="oi-conv-avatar">' + esc(_oiAvatarInitial(nameLabel)) + '</div>'
          +   '<div class="oi-conv-body">'
          +     '<div class="oi-conv-toprow">'
          +       '<div class="oi-conv-name">' + esc(nameLabel) + '</div>'
          +       '<div class="oi-conv-time">' + timeShort + '</div>'
          +       '<span class="oi-24h-dot ' + dotCls + '" title="' + esc(dotTitle) + '"></span>'
          +     '</div>'
          +     '<div class="oi-conv-preview">' + esc(preview || subtitle || '—') + '</div>'
          +     (handoff ? '<div class="oi-conv-meta">' + handoff + '</div>' : '')
          +   '</div>'
          + '</div>';
      }).join('');
      list.querySelectorAll('.oi-conv-row[data-conv-id]').forEach((row) => {
        row.addEventListener('click', () => openOnboardingConv({
          id:          row.dataset.convId,
          phone:       row.dataset.phone || '',
          displayName: row.dataset.display || '',
          customer:    row.dataset.customer || '',
        }));
      });
    } catch (e) {
      list.innerHTML = '<div class="empty-state" style="color:#b91c1c;font-size:13px;padding:16px">Fout: ' + esc(e?.message || e) + '</div>';
    }
  }

  async function openOnboardingConv({ id, phone, displayName, customer }) {
    if (!id) return;
    _oiState.convId = id;
    _oiState.suggestion = null;
    _oiState.editingSuggestionId = null;
    _oiShowThreadView();
    document.querySelectorAll('#oiInboxList .oi-conv-row.active').forEach((el) => el.classList.remove('active'));
    const newRow = document.querySelector('#oiInboxList .oi-conv-row[data-conv-id="' + id.replace(/"/g, '') + '"]');
    if (newRow) newRow.classList.add('active');

    document.getElementById('oiThreadName').textContent  = customer || displayName || phone || 'Onbekend';
    document.getElementById('oiThreadPhone').textContent = phone || '—';
    const badge = document.getElementById('oiThreadWindowBadge');
    badge.textContent = '…';
    badge.style.background = 'var(--bg-elev)';
    badge.style.color = 'var(--text-dim)';
    document.getElementById('oiThreadMessages').innerHTML = '<div style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">Laden…</div>';
    document.getElementById('oiSuggestionPanel').innerHTML = '';
    document.getElementById('oiComposeTextarea').value = '';
    document.getElementById('oiThreadHint').textContent = '';

    try {
      const params = new URLSearchParams({ conversation_id: id, limit: '200', mark_as_read: 'true' });
      const r = await window.AgentShared.apiFetch('/api/inbox-messages-list?' + params.toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        document.getElementById('oiThreadMessages').innerHTML =
          '<div style="color:#b91c1c;font-size:12px;padding:14px">Fout: ' + esc(d.error || ('HTTP ' + r.status)) + '</div>';
        return;
      }
      _oiState.conv = d.conversation || null;
      _oiState.canSendText = !!(d.conversation && d.conversation.can_send_text);
      _renderOiThread(d.items || []);
      _applyOiComposeState();
      _oiResetMode();
      // Context-strip via /api/inbox-conversation-context (klant + tel + matches).
      _loadOiCustomerStrip(id);
      // Refresh lijst (badge + active-state).
      loadOnboardingInbox();
      // Laatste suggestion ophalen (PROPOSED, < 60min).
      _loadLatestMilaSuggestion(id);
    } catch (e) {
      document.getElementById('oiThreadMessages').innerHTML =
        '<div style="color:#b91c1c;font-size:12px;padding:14px">Fout: ' + esc(e?.message || e) + '</div>';
    }
  }

  function _renderOiThread(items) {
    const wrap = document.getElementById('oiThreadMessages');
    if (!wrap) return;
    if (!items || items.length === 0) {
      wrap.innerHTML = '<div style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">Nog geen berichten in deze conversatie.</div>';
    } else {
      wrap.innerHTML = items.map((m) => {
        const inbound = m.direction === 'in';
        const align   = inbound ? 'flex-start' : 'flex-end';
        const bg      = inbound ? 'var(--bg-elev)' : '#093d54';
        const color   = inbound ? 'var(--text)' : '#ffffff';
        const time    = m.created_at ? fmtDateTimeNL(m.created_at) : '';
        const body    = String(m.body || (m.template_name ? '[template:' + m.template_name + ']' : '[media]'));
        return '<div style="display:flex;justify-content:' + align + '">'
          + '<div style="max-width:70%;background:' + bg + ';color:' + color + ';padding:7px 11px;border-radius:10px;font-size:13px;line-height:1.4">'
          + '<div style="white-space:pre-wrap;word-wrap:break-word">' + esc(body) + '</div>'
          + '<div style="font-size:10px;opacity:0.65;margin-top:3px;text-align:right">' + esc(time) + '</div>'
          + '</div></div>';
      }).join('');
    }
    wrap.scrollTop = wrap.scrollHeight;
    const badge = document.getElementById('oiThreadWindowBadge');
    if (_oiState.canSendText) {
      badge.textContent = '24h open';
      badge.style.background = 'rgba(5,150,105,0.15)';
      badge.style.color = '#059669';
      badge.title = '24h-venster nog open — vrije tekst toegestaan';
    } else {
      badge.textContent = '24h verlopen';
      badge.style.background = 'rgba(245,158,11,0.18)';
      badge.style.color = '#b45309';
      badge.title = 'Servicewindow verlopen — alleen templates';
    }
  }

  function _applyOiComposeState() {
    const ta = document.getElementById('oiComposeTextarea');
    const sendBtn = document.getElementById('oiSendBtn');
    const hint = document.getElementById('oiThreadHint');
    if (_oiState.canSendText) {
      if (ta) { ta.disabled = false; ta.placeholder = 'Typ een vrij bericht…'; }
      if (sendBtn) { sendBtn.disabled = false; sendBtn.title = 'Versturen'; }
      if (hint) hint.textContent = '';
    } else {
      if (ta) { ta.disabled = true; ta.placeholder = '24h-venster verlopen — alleen templates'; }
      if (sendBtn) { sendBtn.disabled = true; sendBtn.title = '24h-venster verlopen'; }
      if (hint) hint.textContent = '24h-venster verlopen sinds laatste inbound — vrije tekst niet meer toegestaan.';
    }
  }

  // ── E-mail-modus (read-only) ────────────────────────────────────────────
  // Reset per geopende conv: zet mode → 'wa', sync toggle-knoppen + enabled-
  // state (E-mail alleen klikbaar als de conv aan een klant gekoppeld is),
  // en verberg de e-mail-thread/Reageren-knop. _switchOiMode handelt daarna
  // klikken op de toggle af.
  function _oiResetMode() {
    _oiState.mode               = 'wa';
    _oiState.emailLoaded        = false;
    _oiState.emailItems         = [];
    _oiState.emailWarning       = null;
    _oiState.emailCustomerEmail = '';
    const wa    = document.getElementById('oiModeBtnWa');
    const em    = document.getElementById('oiModeBtnEmail');
    const reply = document.getElementById('oiEmailReplyBtn');
    const emailThread = document.getElementById('oiEmailThread');
    const waThread    = document.getElementById('oiThreadMessages');
    const sugg        = document.getElementById('oiSuggestionPanel');
    const footer      = document.getElementById('oiThreadFooter');
    const hasCustomer = !!(_oiState.conv && _oiState.conv.customer_id);
    if (em) {
      em.disabled = !hasCustomer;
      em.title    = hasCustomer ? '' : 'Klant niet gekoppeld';
      em.style.color = 'var(--text-dim)';
      em.style.background = 'transparent';
      em.style.boxShadow = 'none';
      em.setAttribute('aria-selected', 'false');
    }
    if (wa) {
      wa.style.color = 'var(--text)';
      wa.style.background = 'var(--bg,#fff)';
      wa.style.boxShadow = '0 1px 2px rgba(0,0,0,.06)';
      wa.setAttribute('aria-selected', 'true');
    }
    if (emailThread) emailThread.style.display = 'none';
    if (waThread)    waThread.style.display    = '';
    if (sugg)        sugg.style.display        = '';
    if (footer)      footer.style.display      = '';
    if (reply)       reply.style.display       = 'none';
  }

  function _switchOiMode(next) {
    if (next !== 'wa' && next !== 'email') return;
    if (next === 'email' && !(_oiState.conv && _oiState.conv.customer_id)) return;
    if (_oiState.mode === next) return;
    _oiState.mode = next;
    const wa    = document.getElementById('oiModeBtnWa');
    const em    = document.getElementById('oiModeBtnEmail');
    const reply = document.getElementById('oiEmailReplyBtn');
    const emailThread = document.getElementById('oiEmailThread');
    const waThread    = document.getElementById('oiThreadMessages');
    const sugg        = document.getElementById('oiSuggestionPanel');
    const footer      = document.getElementById('oiThreadFooter');
    const setActive = (btn, active) => {
      if (!btn) return;
      btn.style.color      = active ? 'var(--text)' : 'var(--text-dim)';
      btn.style.background = active ? 'var(--bg,#fff)' : 'transparent';
      btn.style.boxShadow  = active ? '0 1px 2px rgba(0,0,0,.06)' : 'none';
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    };
    setActive(wa, next === 'wa');
    setActive(em, next === 'email');
    if (next === 'wa') {
      if (emailThread) emailThread.style.display = 'none';
      if (waThread)    waThread.style.display    = '';
      if (sugg)        sugg.style.display        = '';
      if (footer)      footer.style.display      = '';
      if (reply)       reply.style.display       = 'none';
      // canSendText-state was al toegepast bij open; niets te herstellen.
    } else {
      if (waThread)    waThread.style.display    = 'none';
      if (sugg)        sugg.style.display        = 'none';
      if (footer)      footer.style.display      = 'none';
      if (emailThread) emailThread.style.display = 'block';
      // Reageren-knop alleen als RBAC-key aanwezig.
      const canReplyLink = !!(window.RBAC && window.RBAC.canSync && window.RBAC.canSync('onboarding.inbox.reply_link'));
      if (reply) reply.style.display = canReplyLink ? '' : 'none';
      _loadOiEmailThread();
    }
  }

  async function _loadOiEmailThread() {
    const wrap = document.getElementById('oiEmailThread');
    if (!wrap) return;
    if (_oiState.emailLoaded) {
      _renderOiEmailThread();
      return;
    }
    wrap.innerHTML = '<div style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">E-mails laden…</div>';
    const customerId = _oiState.conv?.customer_id;
    if (!customerId) {
      wrap.innerHTML = '<div style="color:var(--text-faint);font-size:12px;text-align:center;padding:20px">Klant niet gekoppeld — geen e-mails op te halen.</div>';
      return;
    }
    try {
      const r = await window.AgentShared.apiFetch(
        '/api/inbox-emails-list?customer_id=' + encodeURIComponent(customerId) + '&module=onboarding'
      );
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        wrap.innerHTML = '<div style="color:#b91c1c;font-size:12px;padding:14px">Fout: ' + esc(d?.error || ('HTTP ' + r.status)) + '</div>';
        return;
      }
      _oiState.emailLoaded        = true;
      _oiState.emailItems         = Array.isArray(d.items) ? d.items : [];
      _oiState.emailWarning       = d.warning || null;
      _oiState.emailCustomerEmail = d.customer_email || '';
      _renderOiEmailThread();
    } catch (e) {
      wrap.innerHTML = '<div style="color:#b91c1c;font-size:12px;padding:14px">Fout: ' + esc(e?.message || e) + '</div>';
    }
  }

  function _renderOiEmailThread() {
    const wrap = document.getElementById('oiEmailThread');
    if (!wrap) return;
    const items = _oiState.emailItems || [];
    const warning = _oiState.emailWarning;
    // Reageren-knop wire (idempotent).
    const reply = document.getElementById('oiEmailReplyBtn');
    if (reply) {
      reply.onclick = () => {
        const to = _oiState.emailCustomerEmail || '';
        if (!to) return;
        const url = '/modules/email.html?reply_to=' + encodeURIComponent(to) +
                    '&mailbox=' + encodeURIComponent('onboarding@deforexopleiding.nl');
        window.open(url, '_blank');
      };
    }
    if (items.length === 0) {
      let html = '<div style="color:var(--text-faint);font-size:12.5px;text-align:center;padding:24px">Nog geen e-mails voor deze klant.</div>';
      if (warning) {
        html += '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:4px 14px 12px">' + esc(warning) + '</div>';
      }
      wrap.innerHTML = html;
      return;
    }
    // Spiegelt _renderOiThread: inbound=links/bg-elev, outbound=rechts/accent.
    const bubbleHtml = items.map((m) => {
      const inbound = m.direction === 'inbound';
      const align   = inbound ? 'flex-start' : 'flex-end';
      const bg      = inbound ? 'var(--bg-elev)' : '#093d54';
      const color   = inbound ? 'var(--text)' : '#ffffff';
      const time    = m.date ? fmtDateTimeNL(m.date) : '';
      const subj    = m.subject || '(geen onderwerp)';
      const preview = m.preview || '';
      return '<div style="display:flex;justify-content:' + align + ';margin-bottom:8px">'
        + '<div style="max-width:78%;background:' + bg + ';color:' + color + ';padding:8px 11px;border-radius:10px;font-size:13px;line-height:1.4">'
        +   '<div style="font-weight:700;font-size:12.5px;margin-bottom:3px">' + esc(subj) + '</div>'
        +   (preview ? '<div style="white-space:pre-wrap;word-wrap:break-word;font-size:12.5px">' + esc(preview) + '</div>' : '')
        +   '<div style="font-size:10px;opacity:0.65;margin-top:3px;text-align:right">' + esc(time) + '</div>'
        + '</div></div>';
    }).join('');
    let html = bubbleHtml;
    if (warning) {
      html += '<div style="color:var(--text-dim);font-size:11px;text-align:center;padding:6px 14px 0">' + esc(warning) + '</div>';
    }
    wrap.innerHTML = html;
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function _loadOiCustomerStrip(convId) {
    const strip = document.getElementById('oiCustomerStrip');
    if (!strip) return;
    strip.style.display = 'none';
    strip.innerHTML = '';
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-conversation-context?conversation_id=' + encodeURIComponent(convId));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return;
      const c = d?.customer || null;
      const conv = d?.conversation || null;
      if (!c && (!conv || !conv.phone_number)) return;
      strip.style.display = '';
      const parts = [];
      if (c) {
        parts.push('<span class="oi-ctx-label"><i class="ti ti-user"></i> Klant</span>');
        parts.push('<strong>' + esc(c.name || c.email || '(klant)') + '</strong>');
        if (c.email) parts.push('<span style="color:var(--text-faint)">' + esc(c.email) + '</span>');
      } else {
        parts.push('<span class="oi-ctx-label"><i class="ti ti-user-off"></i> Geen koppeling</span>');
        parts.push('<span style="color:var(--text-faint)">Dit nummer is nog niet aan een klant gekoppeld.</span>');
      }
      if (conv && conv.phone_number) {
        parts.push('<span style="margin-left:auto;color:var(--text-faint);font-size:11.5px">' + esc(conv.phone_number) + '</span>');
      }
      strip.innerHTML = parts.join(' ');
    } catch (e) { /* fail-soft */ }
  }

  async function _loadLatestMilaSuggestion(convId) {
    try {
      const r = await window.AgentShared.apiFetch('/api/joost-suggestions-recent?' +
        new URLSearchParams({ module: 'onboarding', conversation_id: convId, max_age_minutes: '60' }).toString());
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { _renderMilaSuggestion(null, d.error || ('HTTP ' + r.status)); return; }
      _oiState.suggestion = d.suggestion || null;
      _renderMilaSuggestion(_oiState.suggestion, null);
    } catch (e) {
      _renderMilaSuggestion(null, e?.message || String(e));
    }
  }

  // Render het Mila-suggestiepaneel. Bij needs_human (uit suggestion top-level
  // OF uit context_snapshot.handoff.needs_human) tonen we een rode banner
  // i.p.v. de normale "Gebruiken/Aanpassen"-knop. Bewerken kan altijd —
  // de medewerker mag zelf besluiten.
  function _renderMilaSuggestion(sugg, errMsg) {
    const wrap = document.getElementById('oiSuggestionPanel');
    if (!wrap) return;
    if (errMsg) {
      wrap.innerHTML = '<div style="color:#b45309;font-size:12px;background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:8px 10px;margin:6px 14px 0 14px">Suggestie laden mislukt: ' + esc(errMsg) + '</div>';
      return;
    }
    if (!sugg) { wrap.innerHTML = ''; return; }
    const needsHuman = !!(sugg.needs_human
      || (sugg.context_snapshot && sugg.context_snapshot.handoff && sugg.context_snapshot.handoff.needs_human));
    const conf = (typeof sugg.confidence === 'number') ? (Math.round(sugg.confidence * 100) + '%') : '—';
    const intent = sugg.detected_intent || '?';
    const reasoning = sugg.reasoning ? '<div style="font-size:11px;color:var(--text-dim);margin-top:6px;font-style:italic">Reasoning: ' + esc(sugg.reasoning) + '</div>' : '';

    if (needsHuman) {
      wrap.innerHTML = ''
        + '<div class="oi-sim-card needs-human">'
        +   '<div class="oi-sim-head">'
        +     '<i class="ti ti-alert-triangle"></i>'
        +     '<span class="oi-sim-title">⚠ Handmatig overnemen — Mila twijfelt</span>'
        +     '<span class="oi-sim-meta">intent: ' + esc(intent) + ' · confidence ' + conf + '</span>'
        +   '</div>'
        +   '<div class="oi-sim-quote">' + esc(sugg.suggested_reply || '(geen tekst)') + '</div>'
        +   reasoning
        +   '<div class="oi-sim-actions">'
        +     '<button type="button" class="refresh-btn" id="oiMilaEditBtn" style="background:transparent;border:1px solid #dc2626;color:#dc2626" title="Open in composer ter handmatige bewerking"><i class="ti ti-edit"></i> Aanpassen</button>'
        +     '<button type="button" class="btn-dismiss" id="oiMilaDismissBtn">Sluiten</button>'
        +   '</div>'
        + '</div>';
      const editBtn = document.getElementById('oiMilaEditBtn');
      const dismissBtn = document.getElementById('oiMilaDismissBtn');
      if (editBtn) editBtn.addEventListener('click', () => editMilaInComposer(sugg));
      if (dismissBtn) dismissBtn.addEventListener('click', () => dismissMilaSuggestion(sugg));
      return;
    }

    wrap.innerHTML = ''
      + '<div class="oi-sim-card">'
      +   '<div class="oi-sim-head">'
      +     '<i class="ti ti-sparkles"></i>'
      +     '<span class="oi-sim-title">Mila-suggestie</span>'
      +     (sugg.auto_triggered ? '<span style="background:#d97706;color:#fff;font-size:9.5px;font-weight:700;padding:2px 7px;border-radius:8px;letter-spacing:.04em">AUTO</span>' : '')
      +     '<span class="oi-sim-meta">intent: ' + esc(intent) + ' · ' + conf + '</span>'
      +   '</div>'
      +   '<div class="oi-sim-quote">' + esc(sugg.suggested_reply || '') + '</div>'
      +   reasoning
      +   '<div class="oi-sim-actions">'
      +     '<button type="button" class="refresh-btn" id="oiMilaUseBtn" style="background:#d97706;color:#fff" title="Verstuur de suggestie ongewijzigd"><i class="ti ti-check"></i> Gebruiken</button>'
      +     '<button type="button" class="refresh-btn" id="oiMilaEditBtn" style="background:transparent;border:1px solid #d97706;color:#d97706" title="Kopieer naar het tekstveld om aan te passen"><i class="ti ti-edit"></i> Bewerken</button>'
      +     '<button type="button" class="btn-dismiss" id="oiMilaDismissBtn">Negeren</button>'
      +   '</div>'
      + '</div>';
    const useBtn = document.getElementById('oiMilaUseBtn');
    const editBtn = document.getElementById('oiMilaEditBtn');
    const dismissBtn = document.getElementById('oiMilaDismissBtn');
    if (useBtn) useBtn.addEventListener('click', () => useMilaAsIs(sugg));
    if (editBtn) editBtn.addEventListener('click', () => editMilaInComposer(sugg));
    if (dismissBtn) dismissBtn.addEventListener('click', () => dismissMilaSuggestion(sugg));
  }

  async function askMila() {
    const convId = _oiState.convId;
    if (!convId) return;
    const btn = document.getElementById('oiAskMilaBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2"></i> Mila denkt na…'; }
    try {
      const r = await window.AgentShared.apiFetch('/api/onboarding-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: convId }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(d.error || ('HTTP ' + r.status), 'error');
        return;
      }
      if (d?.suggestion) {
        _oiState.suggestion = d.suggestion;
        _renderMilaSuggestion(d.suggestion, null);
      } else {
        await _loadLatestMilaSuggestion(convId);
      }
    } catch (e) {
      toast(e?.message || String(e), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-sparkles"></i> Vraag Mila'; }
    }
  }

  async function useMilaAsIs(sugg) {
    const convId = _oiState.convId;
    if (!convId || !sugg) return;
    if (!_oiState.canSendText) {
      toast('24h-venster verlopen — vrij bericht niet meer toegestaan', 'error');
      return;
    }
    const text = String(sugg.suggested_reply || '').trim();
    if (!text) { toast('Suggestie is leeg', 'error'); return; }
    const btn = document.getElementById('oiMilaUseBtn');
    if (btn) btn.disabled = true;
    try {
      const sr = await window.AgentShared.apiFetch('/api/inbox-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: convId, mode: 'text', body: text }),
      });
      const sd = await sr.json().catch(() => ({}));
      if (!sr.ok) {
        toast(sd.error || ('HTTP ' + sr.status), 'error');
        if (btn) btn.disabled = false;
        return;
      }
      window.AgentShared.apiFetch('/api/joost-mark-outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestion_id: sugg.id, status: 'USED_AS_IS', final_sent_text: text }),
      }).catch(() => {});
      toast('Mila-suggestie verstuurd', 'success');
      _oiState.suggestion = null;
      document.getElementById('oiSuggestionPanel').innerHTML = '';
      openOnboardingConv({ id: convId, phone: _oiState.conv?.phone_number || '', displayName: _oiState.conv?.display_name || '', customer: _oiState.conv?.customer_name || '' });
    } catch (e) {
      toast(e?.message || String(e), 'error');
      if (btn) btn.disabled = false;
    }
  }

  function editMilaInComposer(sugg) {
    if (!sugg) return;
    const ta = document.getElementById('oiComposeTextarea');
    if (ta) {
      ta.value = String(sugg.suggested_reply || '');
      ta.focus();
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
    }
    _oiState.editingSuggestionId = sugg.id;
    toast('Mila-tekst in composer geladen — pas aan en verstuur', 'success');
  }

  async function dismissMilaSuggestion(sugg) {
    if (!sugg) return;
    const btn = document.getElementById('oiMilaDismissBtn');
    if (btn) btn.disabled = true;
    try {
      const r = await window.AgentShared.apiFetch('/api/joost-mark-outcome', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestion_id: sugg.id, status: 'DISMISSED' }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(d.error || ('HTTP ' + r.status), 'error');
        if (btn) btn.disabled = false;
        return;
      }
      _oiState.suggestion = null;
      document.getElementById('oiSuggestionPanel').innerHTML = '';
      toast('Suggestie genegeerd', 'success');
    } catch (e) {
      toast(e?.message || String(e), 'error');
      if (btn) btn.disabled = false;
    }
  }

  async function sendOiComposeText() {
    const convId = _oiState.convId;
    if (!convId) return;
    const ta = document.getElementById('oiComposeTextarea');
    const text = ta ? String(ta.value || '').trim() : '';
    if (!text) { toast('Bericht is leeg', 'error'); return; }
    const btn = document.getElementById('oiSendBtn');
    if (btn) btn.disabled = true;
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: convId, mode: 'text', body: text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(d.error || ('HTTP ' + r.status), 'error');
        if (btn) btn.disabled = false;
        return;
      }
      // Als de operator een suggestie heeft "Aangepast" en daarna vrij verstuurt
      // → markeer als USED_EDITED (fail-soft).
      if (_oiState.editingSuggestionId) {
        const eid = _oiState.editingSuggestionId;
        _oiState.editingSuggestionId = null;
        window.AgentShared.apiFetch('/api/joost-mark-outcome', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ suggestion_id: eid, status: 'USED_EDITED', final_sent_text: text }),
        }).catch(() => {});
      }
      toast('Bericht verstuurd', 'success');
      if (ta) ta.value = '';
      openOnboardingConv({ id: convId, phone: _oiState.conv?.phone_number || '', displayName: _oiState.conv?.display_name || '', customer: _oiState.conv?.customer_name || '' });
    } catch (e) {
      toast(e?.message || String(e), 'error');
      if (btn) btn.disabled = false;
    }
  }

  // ── Template-picker (gecondenseerd port van events evx-modal-flow) ────
  async function openOiTemplatePicker() {
    const convId = _oiState.convId;
    if (!convId) { toast('Selecteer eerst een gesprek', 'error'); return; }
    const overlay = document.getElementById('oiTemplateModal');
    if (!overlay) return;
    overlay.classList.add('show');
    _oiTplState.filter = '';
    const search = document.getElementById('oiTemplateSearch');
    if (search) search.value = '';
    await _loadOiTemplates(convId);
  }
  function closeOiTemplatePicker() {
    const overlay = document.getElementById('oiTemplateModal');
    if (overlay) overlay.classList.remove('show');
  }
  async function _loadOiTemplates(convId) {
    const list = document.getElementById('oiTemplateList');
    if (!list) return;
    list.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:10px">Templates laden…</div>';
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-template-list?conversation_id=' + encodeURIComponent(convId));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        list.innerHTML = '<div style="color:#b91c1c;font-size:12px;padding:10px">Fout: ' + esc(d.error || ('HTTP ' + r.status)) + '</div>';
        return;
      }
      _oiTplState.items = Array.isArray(d?.items) ? d.items : (Array.isArray(d?.templates) ? d.templates : []);
      _oiTplState.loaded = true;
      _renderOiTemplateList();
    } catch (e) {
      list.innerHTML = '<div style="color:#b91c1c;font-size:12px;padding:10px">Fout: ' + esc(e?.message || e) + '</div>';
    }
  }
  function _renderOiTemplateList() {
    const list = document.getElementById('oiTemplateList');
    if (!list) return;
    const filter = (_oiTplState.filter || '').toLowerCase();
    const items = (_oiTplState.items || []).filter((t) => {
      if (!filter) return true;
      const haystack = (t.name || t.template_name || '') + ' ' + (t.language || '') + ' ' + (t.category || '');
      return haystack.toLowerCase().includes(filter);
    });
    if (items.length === 0) {
      list.innerHTML = '<div style="color:var(--text-faint);font-size:12px;padding:10px">Geen templates gevonden.</div>';
      return;
    }
    list.innerHTML = items.map((t) => {
      const name = t.name || t.template_name || '(zonder naam)';
      const lang = t.language || 'nl';
      const cat  = t.category || '';
      return ''
        + '<div class="oi-modal-item" data-tpl-name="' + esc(name) + '" data-tpl-lang="' + esc(lang) + '">'
        +   '<div class="iname">' + esc(name) + '</div>'
        +   '<div class="imeta">' + esc(lang) + (cat ? ' · ' + esc(cat) : '') + '</div>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.oi-modal-item[data-tpl-name]').forEach((el) => {
      el.addEventListener('click', () => {
        const tpl = { name: el.dataset.tplName, language: el.dataset.tplLang };
        if (confirm('Template "' + tpl.name + '" verzenden naar dit gesprek?')) {
          sendOiTemplate(tpl);
        }
      });
    });
  }
  async function sendOiTemplate(tpl) {
    const convId = _oiState.convId;
    if (!convId || !tpl) return;
    _oiTplState.sendingFor = tpl.name;
    closeOiTemplatePicker();
    try {
      const r = await window.AgentShared.apiFetch('/api/inbox-send-template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: convId,
          template_name:   tpl.name,
          language:        tpl.language || 'nl',
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast(d.error || ('HTTP ' + r.status), 'error');
        return;
      }
      toast('Template verstuurd', 'success');
      openOnboardingConv({ id: convId, phone: _oiState.conv?.phone_number || '', displayName: _oiState.conv?.display_name || '', customer: _oiState.conv?.customer_name || '' });
    } catch (e) {
      toast(e?.message || String(e), 'error');
    } finally {
      _oiTplState.sendingFor = null;
    }
  }

  function wireOnboardingInbox() {
    const refreshBtn = document.getElementById('oiInboxRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', loadOnboardingInbox);
    const backBtn = document.getElementById('oiThreadBack');
    if (backBtn) backBtn.addEventListener('click', _oiShowListView);
    const askBtn = document.getElementById('oiAskMilaBtn');
    if (askBtn) askBtn.addEventListener('click', askMila);
    const sendBtn = document.getElementById('oiSendBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendOiComposeText);
    const tplBtn = document.getElementById('oiTemplateBtn');
    if (tplBtn) tplBtn.addEventListener('click', openOiTemplatePicker);
    // Mode-toggle (WhatsApp | E-mail). Klik op disabled-knop wordt door de
    // browser geblokkeerd; _switchOiMode heeft daarnaast nog een fail-safe
    // op _oiState.conv.customer_id.
    const waBtn = document.getElementById('oiModeBtnWa');
    if (waBtn) waBtn.addEventListener('click', () => _switchOiMode('wa'));
    const emBtn = document.getElementById('oiModeBtnEmail');
    if (emBtn) emBtn.addEventListener('click', () => _switchOiMode('email'));
    const tplClose = document.getElementById('oiTemplateClose');
    if (tplClose) tplClose.addEventListener('click', closeOiTemplatePicker);
    const tplSearch = document.getElementById('oiTemplateSearch');
    if (tplSearch) tplSearch.addEventListener('input', () => {
      _oiTplState.filter = tplSearch.value || '';
      _renderOiTemplateList();
    });
    // Cmd/Ctrl-Enter in composer → versturen.
    const ta = document.getElementById('oiComposeTextarea');
    if (ta) ta.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        sendOiComposeText();
      }
    });
    // Klik op modal-overlay sluit picker.
    const modal = document.getElementById('oiTemplateModal');
    if (modal) modal.addEventListener('click', (ev) => {
      if (ev.target === modal) closeOiTemplatePicker();
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public mount() — vervangt de DOMContentLoaded-trigger uit de oorspronkelijke
  // standalone-pagina. Idempotent: re-mount op dezelfde host doet niets.
  // ──────────────────────────────────────────────────────────────────────────
  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[OnboardingOverzicht] mount() requires {host}');
      return;
    }
    if (_mountedHost === o.host) return; // idempotent
    _mountedHost = o.host;
    o.host.innerHTML = HOST_HTML;
    init();
  }

  window.OnboardingOverzicht = {
    __loaded: true,
    mount,
  };
})();
