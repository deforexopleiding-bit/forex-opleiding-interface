// modules/klanten-v2/views/events-v2.js
//
// Fase D module — Events (evenementen/cursussen + deelnemers).
// DATA-KOPPELING 2026-08-13. Dormant — QA via ?v2preview=events.
//
// Endpoints:
//   GET /api/events-list?status=&niveau=&q=&limit=&offset=  (Overzicht)
//   GET /api/events-completed-list                           (Overzicht "afgerond" + Mentor-grootboek)
//   GET /api/events-signup-inbox-list?status=                (Inschrijvingen-tab)
//   GET /api/events-niveau-options                           (niveau-filter)
//
// Needs Jeffrey:
//   Inbox-tab — v1 heeft geen dedicated conversations-per-event endpoint;
//   v1-render is inline in events.html met whatsapp_messages. Aparte
//   endpoint bouwen of skippen. Deze tab toont needs-Jeffrey banner.
//   Event-detail (attendees + comms + mentors) komt in latere ronde —
//   nu geen dossier-flow, alleen tab-navigatie.

(function () {
  if (!window.DFO) { console.error('[events-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[events-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur0 } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const _live = {
    events:    { loading: false, error: null, data: null, filter: 'published' },
    completed: { loading: false, error: null, data: null },
    signups:   { loading: false, error: null, data: null, filter: '' },
    niveaus:   { loading: false, error: null, data: null },
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[ev-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  async function fetchEvents(status) {
    status = status != null ? status : _live.events.filter;
    const st = _live.events;
    if (st.loading || (st.data && st.filter === status)) return;
    st.loading = true; st.error = null; st.filter = status; st.data = null;
    // status='afgerond' → completed endpoint
    if (status === 'afgerond') {
      const j = await tryFetch('completed', '/api/events-completed-list');
      st.loading = false;
      if (j && j.__error) st.error = j.__error;
      else st.data = { items: asArr(j?.events).map(_normalizeCompleted), total: asArr(j?.events).length };
    } else {
      const url = '/api/events-list?limit=200&status=' + encodeURIComponent(status || 'published');
      const j = await tryFetch('events:' + status, url);
      st.loading = false;
      if (j && j.__error) st.error = j.__error;
      else st.data = { items: asArr(j?.items), total: Number(j?.total || 0) };
    }
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchCompleted() {
    const st = _live.completed;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('completed', '/api/events-completed-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.events);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSignups(status) {
    status = status != null ? status : _live.signups.filter;
    const st = _live.signups;
    if (st.loading || (st.data && st.filter === status)) return;
    st.loading = true; st.error = null; st.filter = status; st.data = null;
    const url = '/api/events-signup-inbox-list' + (status ? '?status=' + encodeURIComponent(status) : '');
    const j = await tryFetch('signups:' + status, url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { rows: asArr(j?.rows), counts: j?.counts || {} };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchNiveaus() {
    const st = _live.niveaus;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('niveaus', '/api/events-niveau-options');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.niveaus || j?.options || []);
    if (window.DFO?.render) window.DFO.render();
  }

  function _normalizeCompleted(e) {
    return {
      id: e.event_id,
      title: e.title,
      starts_at: e.starts_at,
      status: 'afgerond',
      attendee_count_active: Number(e.aanwezig || 0),
      attendee_count_total: Number(e.aanwezig || 0) + Number(e.no_show || 0) + Number(e.afgemeld || 0),
      capacity: null,
      completion_summary: e.completion_summary,
      expenses_total: Number(e.expenses_total || 0),
      bonus_total: Number(e.bonus_total || 0),
      sales: Number(e.sales || 0),
      _raw: e,
    };
  }

  window.__evRetry = (block) => {
    if (block === 'events')    { _live.events.data = null; _live.events.error = null; fetchEvents(); }
    if (block === 'completed') { _live.completed.data = null; _live.completed.error = null; fetchCompleted(); }
    if (block === 'signups')   { _live.signups.data = null; _live.signups.error = null; fetchSignups(); }
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evSetStatus = (v) => { fetchEvents(v); };
  window.__evSetSignupStatus = (v) => { fetchSignups(v); };
  window.__evOpen = (id) => {
    if (!id) return;
    try { window.open('/modules/events-detail.html?id=' + encodeURIComponent(id), '_blank'); }
    catch (_) { console.info('[events-v2] openEvent id=' + id); }
  };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon events niet ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__evRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const emptyBlk = (title, sub) => `<div class="empty" style="padding:44px 20px"><div class="empty-t">${esc(title)}</div><div class="empty-s">${esc(sub || '')}</div></div>`;
  const needsJeffrey = (reason) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}</span>
    <span><b>Needs Jeffrey</b> — ${esc(reason)}</span></div>`;
  function _fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function _fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  }

  // ── VIEW 1: Overzicht ─────────────────────────────────────────────────
  function overzichtView() {
    const status = _live.events.filter || 'published';
    if (!_live.events.data && !_live.events.loading && !_live.events.error) queueMicrotask(() => fetchEvents(status));
    if (!_live.niveaus.data && !_live.niveaus.loading && !_live.niveaus.error) queueMicrotask(fetchNiveaus);
    if (_live.events.error && !_live.events.data) return errBlk('events', _live.events.error);
    if (_live.events.loading && !_live.events.data) return skel();
    const items = asArr(_live.events.data?.items);
    const total = Number(_live.events.data?.total || items.length);
    const q = (F('q', '') || '').toLowerCase();
    const rows = items.filter((e) => !q || String(e.title || '').toLowerCase().includes(q));
    S.rows = rows;
    const activeAttendees = items.reduce((a, e) => a + Number(e.attendee_count_active || 0), 0);
    const totalCap = items.reduce((a, e) => a + Number(e.capacity || 0), 0);
    const bezetting = totalCap > 0 ? Math.round((activeAttendees / totalCap) * 100) : 0;
    return `${H.kpis([
      { c: 'pink',    icon: I.cal,   label: 'Events (' + status + ')', val: String(total), sub: 'in scope' },
      { c: 'teal',    icon: I.users, label: 'Aanmeldingen',   val: String(activeAttendees), sub: 'actief' },
      { c: 'emerald', icon: I.chart, label: 'Gem. bezetting', val: bezetting + '%', hi: 1, sub: totalCap ? '(cap ' + totalCap + ')' : '(capaciteit onbekend)' },
      { c: 'amber',   icon: I.alert, label: 'Bijna vol',      val: String(items.filter((e) => Number(e.capacity || 0) > 0 && Number(e.attendee_count_active || 0) / Number(e.capacity) >= 0.8).length), hi: 1, sub: '≥80% bezet' },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Gepubliceerd', v: 'published' },
        { l: 'Concept',       v: 'draft' },
        { l: 'Afgerond',     v: 'afgerond' },
        { l: 'Geannuleerd',  v: 'cancelled' },
        { l: 'Archief',      v: 'archived' },
      ], status),
      H.search('Zoek event…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__evRetry('events')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    ${rows.length === 0
      ? emptyBlk('Geen events', 'Er zijn geen events die aan de filter voldoen.')
      : H.table(
          [{ l: 'Event' }, { l: 'Datum', cls: 'optional' }, { l: 'Tijd', cls: 'optional' }, { l: 'Locatie', cls: 'optional' }, { l: 'Niveau', cls: 'optional' }, { l: 'Aanm/Cap', cls: 'r' }, { l: 'Status' }],
          rows.map((e) => {
            const aanm = Number(e.attendee_count_active || 0);
            const cap = Number(e.capacity || 0);
            const ratio = cap > 0 ? aanm / cap : 0;
            const barCol = ratio >= 0.8 ? 'danger' : ratio >= 0.5 ? 'warn' : 'ok';
            const statusMap = { published: ['ok','Gepubliceerd'], draft: ['neutral','Concept'], cancelled: ['danger','Geannuleerd'], archived: ['neutral','Archief'], afgerond: ['accent','Afgerond'] };
            const [sc, sl] = statusMap[e.status] || ['neutral', e.status || '—'];
            return [
              `<span class="cell-main" onclick="__evOpen('${esc(e.id)}')" style="cursor:pointer">${esc(e.title || '—')}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.starts_at))}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtTime(e.starts_at))}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(e.location || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(e.niveau || '')}</span>`,
              cap > 0
                ? `<div style="min-width:100px"><div style="display:flex;justify-content:space-between;font-size:11.5px"><span class="mono">${aanm}/${cap}</span></div><div class="progress" style="max-width:100px"><i style="width:${Math.min(100, ratio * 100)}%;background:var(--${barCol})"></i></div></div>`
                : `<span class="mono">${aanm}${e.status === 'afgerond' ? ' (afg)' : ''}</span>`,
              H.pill(sc, sl),
            ];
          })
        )}`;
  }

  // ── VIEW 2: Inbox (needs-Jeffrey) ─────────────────────────────────────
  function inboxView() {
    return needsJeffrey('Geen dedicated /api/events-conversations endpoint. v1 rendert whatsapp-messages inline in events.html. Aparte endpoint nodig, of tab schrappen.') +
      `<div class="pad"><div class="empty" style="padding:44px 20px"><div class="empty-t">Inbox — v1</div><div class="empty-s">Gebruik zolang de v1-events-inbox voor per-event conversaties.</div><a class="btn btn-ghost btn-sm" style="margin-top:10px" href="/modules/events.html#inbox" target="_blank">${svg(I.eye || I.doc)}Openen in v1</a></div></div>`;
  }

  // ── VIEW 3: Inschrijvingen ────────────────────────────────────────────
  function inschrijvingenView() {
    const status = _live.signups.filter;
    if (!_live.signups.data && !_live.signups.loading && !_live.signups.error) queueMicrotask(() => fetchSignups(status));
    if (_live.signups.error && !_live.signups.data) return errBlk('signups', _live.signups.error);
    if (_live.signups.loading && !_live.signups.data) return skel();
    const rows = asArr(_live.signups.data?.rows);
    const counts = _live.signups.data?.counts || {};
    return `${H.toolbar([
      H.chips('signup-st', [
        { l: 'Alles', v: '', n: Number(counts.total || rows.length) },
        { l: 'Matched', v: 'matched', n: Number(counts.matched || 0) },
        { l: 'Ambigu', v: 'ambiguous', n: Number(counts.ambiguous || 0) },
        { l: 'Geen match', v: 'no_match', n: Number(counts.no_match || 0) },
        { l: 'Ongeldig', v: 'invalid_payload', n: Number(counts.invalid_payload || 0) },
      ], status),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__evRetry('signups')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    <div style="padding:0 20px"><script>document.querySelectorAll('[data-signup-st]').forEach(b=>b.onclick=()=>__evSetSignupStatus(b.getAttribute('data-signup-st')));</script></div>
    ${rows.length === 0
      ? emptyBlk('Geen inschrijvingen', 'Er zijn geen inbound-inschrijvingen in deze categorie.')
      : H.table(
          [{ l: 'Deelnemer' }, { l: 'E-mail', cls: 'optional' }, { l: 'Opgegeven event', cls: 'optional' }, { l: 'Match' }, { l: 'Ontvangen', cls: 'r optional' }, { l: '', cls: 'r' }],
          rows.map((r) => {
            const naam = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '—';
            const ev = r.matched_event?.title || r.event_date_label || r.opgegeven_event || '—';
            const ms = r.match_status || 'onbekend';
            const [mc, ml] = ms === 'matched' ? ['ok', 'Matched'] : ms === 'ambiguous' ? ['warn', 'Ambigu'] : ms === 'no_match' ? ['danger', 'Geen match'] : ['neutral', 'Ongeldig'];
            return [
              `<div class="row-avatar">${H.av(naam, 28)}<span class="cell-main">${esc(naam)}</span></div>`,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(r.email || '—')}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(ev)}</span>`,
              H.pill(mc, ml) + (Array.isArray(r.match_candidate_ids) && r.match_candidate_ids.length ? ` <span style="font-size:11px;color:var(--text-3);margin-left:4px">${r.match_candidate_ids.length} kandidaten</span>` : ''),
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(r.received_at))}</span>`,
              `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('/modules/events.html#signup-inbox', '_blank')">Openen in v1</button>`,
            ];
          })
        )}`;
  }

  // ── VIEW 4: Mentor-grootboek (via completed) ──────────────────────────
  function mentorGrootboekView() {
    if (!_live.completed.data && !_live.completed.loading && !_live.completed.error) queueMicrotask(fetchCompleted);
    if (_live.completed.error && !_live.completed.data) return errBlk('completed', _live.completed.error);
    if (_live.completed.loading && !_live.completed.data) return skel();
    const events = asArr(_live.completed.data);
    const totBonus = events.reduce((a, e) => a + Number(e.bonus_total || 0), 0);
    const totExp = events.reduce((a, e) => a + Number(e.expenses_total || 0), 0);
    const totSales = events.reduce((a, e) => a + Number(e.sales || 0), 0);
    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Sales uit events',    val: eur0(totSales), sub: events.length + ' afgeronde events' },
      { c: 'violet',  icon: I.grad,  label: 'Bonus mentoren',      val: eur0(totBonus), hi: 1 },
      { c: 'amber',   icon: I.box,   label: 'Uitgaven',            val: eur0(totExp), hi: 1 },
      { c: 'emerald', icon: I.tick,  label: 'Netto (schatting)',   val: eur0(totSales - totBonus - totExp), hi: 1 },
    ])}
    ${events.length === 0
      ? emptyBlk('Geen afgeronde events', 'Zodra events worden afgerond verschijnt hier de mentor-grootboek data.')
      : `<div class="pad"><div class="card"><div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span><div class="card-title">Per afgerond event (${events.length})</div></div>
        ${H.table(
          [{ l: 'Event' }, { l: 'Voltooid op', cls: 'optional' }, { l: 'Aanwezig', cls: 'r optional' }, { l: 'Sales', cls: 'r' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitgaven', cls: 'r' }, { l: 'Netto', cls: 'r' }],
          events.map((e) => {
            const netto = Number(e.sales || 0) - Number(e.bonus_total || 0) - Number(e.expenses_total || 0);
            return [
              `<span class="cell-main">${esc(e.title || '—')}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.completed_at || e.starts_at))}</span>`,
              `<span class="mono">${Number(e.aanwezig || 0)}</span>`,
              `<span class="money">${eur0(Number(e.sales || 0))}</span>`,
              `<span class="money">${eur0(Number(e.bonus_total || 0))}</span>`,
              `<span class="money">− ${eur0(Number(e.expenses_total || 0))}</span>`,
              `<span class="money" style="color:var(--emerald)">${eur0(netto)}</span>`,
            ];
          })
        )}</div></div>`}`;
  }

  // ── Registratie ───────────────────────────────────────────────────────
  window.DFO.VIEWS['events/Overzicht']        = overzichtView;
  window.DFO.VIEWS['events/Inbox']            = inboxView;
  window.DFO.VIEWS['events/Inschrijvingen']   = inschrijvingenView;
  window.DFO.VIEWS['events/Mentor-grootboek'] = mentorGrootboekView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('events');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('events');

  console.debug('[events-v2] data-ronde geregistreerd — dormant tot allowlist of ?v2preview=events');
})();
