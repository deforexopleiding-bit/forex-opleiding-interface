// modules/klanten-v2/views/leads-v2.js
//
// Data-ronde — Leads als live-module.
// Endpoints (bestaand, uit leads.html):
//   GET /api/leads-list?soort&traject&kwalificatie&bron&status&afspraak
//                      &q&archief=<0|1>&limit=50&offset=0
//   GET /api/leads-stats  → { vandaag, nieuw, week_gekwalificeerd }
//
// Ground truth Actief vs Gearchiveerd (uit leads-list.js:63): actief =
// verwijderd_op IS NULL, gearchiveerd = verwijderd_op IS NOT NULL (via
// ?archief=1). Er is GEEN aparte status voor 'gearchiveerd'; het is een
// soft-delete-vlag.
//
// Status-veld is de funnel-fase: 'nieuw' | 'opgevolgd' | 'gewonnen' |
// 'verloren' — NIET (Nieuw/Contact/Kwalificatie/Offerte) uit het
// prototype. We tonen de echte 4 waardes zodat de cijfers matchen met
// wat leads.html toont.
//
// Write: 'Nieuwe lead' → /modules/leads.html (modal daar aanwezig).
// Row-klik → /modules/leads-detail.html?id=<uuid>.
//
// Dormant. Preview ?v2preview=leads (rol super_admin/admin/manager/
// sales/marketing).

(function () {
  if (!window.DFO) { console.error('[leads-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[leads-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const _act = { loading: false, error: null, data: null, stats: null, seq: 0, params: '' };
  const _arc = { loading: false, error: null, data: null, seq: 0, params: '' };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[leads-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const num  = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);

  function previewHeader(label, state) {
    const err = state?.error ? `<span class="prev-badge-err">${state.error}</span>` : '';
    const loading = state?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

  // Funnel-status pill-mapping (echte v1-waarden).
  const STATUS_TO_PILL = {
    nieuw:     ['info',    'Nieuw'],
    opgevolgd: ['primary', 'Opgevolgd'],
    gewonnen:  ['ok',      'Gewonnen'],
    verloren:  ['warn',    'Verloren'],
  };

  window.__leadNew  = () => { window.location.href = '/modules/leads.html?new=1'; };
  window.__leadOpen = (id) => { if (id) window.location.href = '/modules/leads-detail.html?id=' + encodeURIComponent(id); };

  // ── ACTIEF ────────────────────────────────────────────────────────────
  function actiefParams() {
    const st = F('lead-st', 'all');
    const bron = F('lead-bron', 'all');
    const q = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    if (bron && bron !== 'all') p.set('bron', bron);
    if (q) p.set('q', q);
    p.set('archief', '0');
    p.set('limit', '50');
    p.set('offset', '0');
    return p.toString();
  }

  async function fetchActief() {
    const wanted = actiefParams();
    if (_act.loading && _act.params === wanted) return;
    const seq = ++_act.seq;
    _act.loading = true; _act.error = null; _act.params = wanted;
    window.DFO.render();
    const [list, stats] = await Promise.all([
      tryFetch('leads-list',  '/api/leads-list?' + wanted),
      tryFetch('leads-stats', '/api/leads-stats'),
    ]);
    if (seq !== _act.seq) return;
    _act.data = list; _act.stats = stats;
    _act.loading = false;
    if (!list && !stats) _act.error = 'Kon leads niet laden';
    window.DFO.render();
  }

  function actiefView() {
    if (!_act.loading && (!_act.data || _act.params !== actiefParams())) queueMicrotask(fetchActief);
    const st = F('lead-st', 'all');
    const bron = F('lead-bron', 'all');
    const items = _act.data?.items || [];
    const total = _act.data?.total ?? null;
    const s = _act.stats || {};
    // Gem. leadscore uit huidige page (client-side heuristiek — geen
    // dedicated endpoint. Toon "—" als geen data).
    const scores = items.map(i => Number(i.score)).filter(n => !isNaN(n));
    const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    return `${previewHeader('Actief', _act)}
      ${H.kpis([
        { c: 'teal',    icon: I.users,  label: 'Nieuw vandaag',        val: num(s.vandaag),          hi: 1 },
        { c: 'blue',    icon: I.mail,   label: 'Nieuw totaal',         val: num(s.nieuw),                   sub: 'status = nieuw' },
        { c: 'emerald', icon: I.check,  label: 'Gekwalificeerd (week)',val: num(s.week_gekwalificeerd),     sub: 'deze week' },
        { c: 'violet',  icon: I.trend,  label: 'Gem. score (page)',    val: avgScore != null ? String(avgScore) : '—', sub: 'op zichtbare 50' },
      ])}
      ${H.toolbar([
        H.chips('lead-st', [
          { l: 'Alle',       v: 'all' },
          { l: 'Nieuw',      v: 'nieuw' },
          { l: 'Opgevolgd',  v: 'opgevolgd' },
          { l: 'Gewonnen',   v: 'gewonnen' },
          { l: 'Verloren',   v: 'verloren' },
        ], st),
        H.chips('lead-bron', [
          { l: 'Alle bronnen', v: 'all' },
          { l: 'Meta',         v: 'Meta' },
          { l: 'Instagram',    v: 'Instagram' },
          { l: 'Webinar',      v: 'Webinar' },
          { l: 'Referral',     v: 'Referral' },
        ], bron),
        H.search('Zoek naam / e-mail / telefoon…'),
        `<div class="tb-right"><button class="btn btn-primary" onclick="__leadNew()">${svg(I.plus)}Nieuwe lead</button></div>`,
      ])}
      <div class="sv-total">${_act.loading ? 'Laden…' : (total != null ? `${total} lead${total === 1 ? '' : 's'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Traject', cls: 'optional' }, { l: 'Status' }, { l: 'Score', cls: 'r' }, { l: 'Aangemaakt', cls: 'r optional' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="cell-main">${l.naam || '—'}</a></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${l.bron || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${l.traject || '—'}</span>`,
            H.pill(c, pl),
            `<span class="mono ${(l.score || 0) >= 80 ? 'strong' : ''}">${l.score != null ? l.score : '—'}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(l.aangemaakt)}</span>`,
          ];
        })
      )}
      ${!items.length && !_act.loading ? `<div class="sv-empty">${_act.error || 'Geen leads met deze filters.'}</div>` : ''}`;
  }

  // ── GEARCHIVEERD ──────────────────────────────────────────────────────
  function archiefParams() {
    const q = (F('q', '') || '').trim();
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    p.set('archief', '1');
    p.set('limit', '50');
    p.set('offset', '0');
    return p.toString();
  }

  async function fetchArchief() {
    const wanted = archiefParams();
    if (_arc.loading && _arc.params === wanted) return;
    const seq = ++_arc.seq;
    _arc.loading = true; _arc.error = null; _arc.params = wanted;
    window.DFO.render();
    const list = await tryFetch('leads-list-archief', '/api/leads-list?' + wanted);
    if (seq !== _arc.seq) return;
    _arc.data = list;
    _arc.loading = false;
    if (!list) _arc.error = 'Kon archief niet laden';
    window.DFO.render();
  }

  function archiefView() {
    if (!_arc.loading && (!_arc.data || _arc.params !== archiefParams())) queueMicrotask(fetchArchief);
    const items = _arc.data?.items || [];
    const total = _arc.data?.total ?? null;
    return `${previewHeader('Gearchiveerd (soft-delete via verwijderd_op)', _arc)}
      ${H.toolbar([
        H.search('Zoek naam / e-mail / telefoon…'),
      ])}
      <div class="sv-total">${_arc.loading ? 'Laden…' : (total != null ? `${total} gearchiveerd${total === 1 ? '' : 'e leads'}` : '—')}</div>
      ${H.table(
        [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Traject', cls: 'optional' }, { l: 'Laatste status', cls: 'optional' }, { l: 'Aangemaakt', cls: 'r optional' }],
        items.map(l => {
          const [c, pl] = STATUS_TO_PILL[l.status] || ['neutral', l.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam || '?')}</div><a href="javascript:__leadOpen('${l.id}')" class="cell-main">${l.naam || '—'}</a></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${l.bron || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${l.traject || '—'}</span>`,
            H.pill(c, pl),
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(l.aangemaakt)}</span>`,
          ];
        })
      )}
      ${!items.length && !_arc.loading ? `<div class="sv-empty">${_arc.error || 'Geen gearchiveerde leads.'}</div>` : ''}`;
  }

  window.DFO.VIEWS['leads/Actief']       = actiefView;
  window.DFO.VIEWS['leads/Gearchiveerd'] = archiefView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leads');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leads');
  console.debug('[leads-v2] registered 2 views (data-round · live /api/leads-list + /api/leads-stats)');
})();
