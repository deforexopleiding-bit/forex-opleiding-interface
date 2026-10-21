// modules/klanten-v2/views/funnel-dashboard-v2.js
//
// Funnel-dashboard (first-party tracking) — wordt bovenaan de tab
// Leadsonderhoud → Funnels getekend door leadsonderhoud-v2.js:
//   window.DFOFunnelDashboard.render(FUNNEL_REGISTRY)
// Data: GET /api/funnel-stats?van=YYYY-MM-DD&tot=YYYY-MM-DD (leads.view).
//
// Periodes worden in Amsterdam-kalenderdagen gerekend (Intl, Europe/Amsterdam),
// nooit via UTC-datum van "nu".
(function () {
  'use strict';
  window.DFO = window.DFO || {};

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const GROEPEN = [
    { groep: 'kmc', titel: 'Mini-cursus (kennismakingscursus)' },
    { groep: '7-daagse', titel: '7-daagse' },
    { groep: 'webinar', titel: 'Webinar (maandag 19:00)' },
    // 2026-10-19: twee aparte funnels. The Lab = tradingsimulator (7 dagen) met
    // daarna een strategiesessie; Strategie-scan = meteen de gratis scan boeken.
    { groep: 'the-lab', titel: 'The Lab (tradingsimulator · 7 dagen)' },
    { groep: 'strategiescan', titel: 'Strategie-scan (gratis scan met Dave)' },
  ];

  // Funnels met een eigen flow (geen quiz, geen A/B/C-boekflow). Wat ze als
  // "geboekt" tellen, is hun eigen afspraak — houd die twee uit elkaar.
  const EIGEN_FLOW = {
    'the-lab': { flow: 'Lab-aanmelding → trial 7 dagen + loginmail', geboekt: 'Strategiesessie' },
    strategiescan: { flow: 'Formulier → meteen de strategie-scan boeken', geboekt: 'Scan geboekt' },
  };

  const PRESETS = [
    ['vandaag', 'Vandaag'],
    ['7d', '7 dagen'],
    ['30d', '30 dagen'],
    ['maand', 'Deze maand'],
    ['custom', 'Aangepast'],
  ];

  const st = window.__fdState = window.__fdState || {
    preset: '7d', customVan: '', customTot: '',
    loading: false, fetched: false, error: null, data: null, _seq: 0, lastKey: null,
    open: {},
    rij: {},    // uitgeklapte regels in het compacte overzicht (2026-10-21)
    // Boek-flow A/B-schakelaar (app_settings.opstartsessie_flow).
    flowCfg: null, flowFetched: false, flowErr: null, flowSaving: false,
  };

  // Welke funnels gebruiken de boek-flow (en krijgen dus een A/B-schakelaar):
  // de 7-daagse- en mini-cursus-varianten. Webinar/website boeken niet via deze
  // flow, dus daar geen schakelaar.
  const FLOW_PRODUCTS = new Set(['7-daagse', 'minicursus']);
  const FLOWS = ['A', 'B', 'C'];
  const normFlow = (x) => (x === 'B' || x === 'C' ? x : 'A');
  const flowOf = (bron) => {
    const c = st.flowCfg || {};
    const per = c.per_funnel || {};
    return FLOWS.includes(per[bron]) ? per[bron] : normFlow(c.default);
  };

  // ── Amsterdam-datums ──────────────────────────────────────────────────────
  function nlVandaag(nu) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(nu || new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  }
  function plusDagen(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n, 12));
    const p2 = (x) => (x < 10 ? '0' : '') + x;
    return dt.getUTCFullYear() + '-' + p2(dt.getUTCMonth() + 1) + '-' + p2(dt.getUTCDate());
  }
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  function presetRange(preset, nu) {
    const t = nlVandaag(nu);
    if (preset === 'vandaag') return { van: t, tot: t };
    if (preset === '30d') return { van: plusDagen(t, -29), tot: t };
    if (preset === 'maand') return { van: t.slice(0, 8) + '01', tot: t };
    if (preset === 'custom') {
      if (ISO.test(st.customVan) && ISO.test(st.customTot) && st.customVan <= st.customTot) {
        return { van: st.customVan, tot: st.customTot };
      }
      return null;
    }
    return { van: plusDagen(t, -6), tot: t };
  }

  function rerender() { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); }

  async function fetchStats(force) {
    const r = presetRange(st.preset);
    if (!r) return;
    const key = r.van + '|' + r.tot;
    if (!force && st.lastKey === key && st.fetched && !st.error) return;
    st.loading = true; st.error = null; st.lastKey = key;
    const seq = ++st._seq;
    rerender();
    try {
      const j = await window.KV.authedJson('/api/funnel-stats?van=' + encodeURIComponent(r.van) + '&tot=' + encodeURIComponent(r.tot));
      if (seq !== st._seq) return;
      st.data = j;
    } catch (e) {
      if (seq !== st._seq) return;
      const s = e && e.status;
      st.error = s === 403 ? 'Geen rechten om funnelcijfers te zien (leads.view).'
        : 'Kon funnelcijfers niet laden' + (s ? ' (HTTP ' + s + ')' : '');
      console.error('[funnel-dashboard] fetch fail:', s, (e && (e.body || e.message)));
    }
    st.loading = false; st.fetched = true;
    rerender();
  }

  window.__fdPreset = function (p) {
    st.preset = p;
    if (p === 'custom' && !st.customVan) {
      const r = presetRange('7d');
      st.customVan = r.van; st.customTot = r.tot;
    }
    if (p === 'custom') { rerender(); return; }
    fetchStats(true);
  };
  window.__fdSetCustom = function (veld, el) {
    const v = String((el && el.value) || '');
    if (veld === 'van') st.customVan = v; else st.customTot = v;
  };
  window.__fdApplyCustom = function () {
    if (!presetRange('custom')) { st.error = 'Kies een geldige van- en tot-datum (van ≤ tot).'; rerender(); return; }
    fetchStats(true);
  };
  window.__fdToggle = function (variant) {
    st.open[variant] = !st.open[variant];
    rerender();
  };
  // Regel in het overzicht open/dicht: de volledige trechter + leadblokjes eronder.
  window.__fdRij = function (variant) {
    st.rij[variant] = !st.rij[variant];
    rerender();
  };
  window.__fdRijToets = function (e, variant) {
    if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); window.__fdRij(variant); }
  };

  // ── Boek-flow A/B/C-schakelaar ────────────────────────────────────────────
  async function fetchFlow(force) {
    if (!force && st.flowFetched && !st.flowErr) return;
    try {
      const j = await window.KV.authedJson('/api/opstartsessie-flow-get');
      st.flowCfg = { default: normFlow(j.default), per_funnel: (j.per_funnel && typeof j.per_funnel === 'object') ? j.per_funnel : {} };
      st.flowErr = null;
    } catch (e) {
      st.flowErr = (e && e.status === 403) ? 'Geen rechten om de boek-flow te zien.' : 'Kon boek-flow niet laden.';
      if (!st.flowCfg) st.flowCfg = { default: 'A', per_funnel: {} };
    }
    st.flowFetched = true;
  }
  async function saveFlow(cfg) {
    st.flowSaving = true; rerender();
    try {
      const j = await window.KV.authedJson('/api/opstartsessie-flow-set', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
      });
      st.flowCfg = { default: normFlow(j.default), per_funnel: j.per_funnel || {} };
      st.flowErr = null;
    } catch (e) {
      st.flowErr = (e && e.status === 403) ? 'Geen rechten om de boek-flow te wijzigen (leads.update).' : 'Opslaan van de boek-flow mislukte.';
    }
    st.flowSaving = false; rerender();
  }
  window.__flowSet = function (variant, flow) {
    if (st.flowSaving) return;
    const c = st.flowCfg || { default: 'A', per_funnel: {} };
    const per = Object.assign({}, c.per_funnel);
    per[variant] = normFlow(flow);
    saveFlow({ default: normFlow(c.default), per_funnel: per });
  };
  window.__flowAll = function (flow) {
    if (st.flowSaving) return;
    // Globaal: zet default en wis alle per-funnel-afwijkingen (echt alles op A, B of C).
    saveFlow({ default: normFlow(flow), per_funnel: {} });
  };

  // ── Render-helpers ────────────────────────────────────────────────────────
  const fmtPct = (v) => (v == null ? '—' : String(v).replace('.', ',') + '%');
  const num = (v) => (v == null ? '—' : String(v));
  // Seconden (1 decimaal van de server) → "12,3 s" of "2m 05s".
  const fmtSec = (v) => {
    if (v == null || !isFinite(v)) return '—';
    if (v < 60) return String(v).replace('.', ',') + ' s';
    const s = Math.round(v % 60);
    return Math.floor(v / 60) + 'm ' + (s < 10 ? '0' : '') + s + 's';
  };

  // Labels voor de gedragssignalen (veldNAMEN en enums — nooit waarden).
  const VELD_LABEL = { voornaam: 'Voornaam', achternaam: 'Achternaam', email: 'E-mail', telefoon: 'Telefoon', akkoord: 'Akkoord-vinkje', overig: 'Overig' };
  const TYPE_LABEL = { leeg: 'leeg gelaten', ongeldig: 'ongeldig', geen_landcode: 'landcode ontbreekt/klopt niet', niet_aangevinkt: 'niet aangevinkt' };
  const FASE_LABEL = { landing: 'Landingspagina', formulier: 'Formulier', quiz: 'Vragenlijst', beoordeling: 'Tijdens beoordelen', toelating: 'Boekstap' };
  const lbl = (map, k) => esc(map[k] || k);

  function funnelHtml(funnel) {
    if (!Array.isArray(funnel) || !funnel.length) {
      return '<div style="padding:12px;color:var(--text-3);font-size:12px;text-align:center;border:1px dashed var(--border);border-radius:var(--r-sm)">Nog geen trackingdata</div>';
    }
    const max = Math.max(1, ...funnel.map((f) => f.sessions || 0));
    return '<div class="fd-funnel" style="display:flex;flex-direction:column;gap:5px">' + funnel.map((f) => {
      const w = Math.round(((f.sessions || 0) / max) * 100);
      const boven = f.conversie_vorige != null && f.conversie_vorige > 100;
      const vorige = f.conversie_vorige == null ? ''
        : `<span title="t.o.v. vorige fase${boven ? ' — meer dan de vorige fase: sessies kunnen halverwege instappen (fase-telling = bereik)' : ''}" style="color:${boven ? 'var(--amber)' : 'var(--text-3)'}">${fmtPct(f.conversie_vorige)}</span>`;
      return `<div class="fd-fase" data-fase="${esc(f.fase)}" style="display:grid;grid-template-columns:minmax(92px,38%) 1fr auto;gap:6px;align-items:center;font-size:11.5px">
        <span style="color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(f.label)}">${esc(f.label)}</span>
        <span style="background:var(--surface-2);border-radius:4px;height:14px;position:relative;overflow:hidden">
          <span style="position:absolute;left:0;top:0;bottom:0;width:${w}%;background:var(--brand,#0A7490);opacity:.85;border-radius:4px"></span>
        </span>
        <span style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap"><b>${num(f.sessions)}</b> ${vorige ? '· ' + vorige : ''}</span>
      </div>`;
    }).join('') + '</div>';
  }

  function afhakenHtml(blokken) {
    if (!Array.isArray(blokken) || !blokken.length) {
      return '<div style="color:var(--text-3);font-size:12px;padding:6px 0">Nog geen quizvragen getoond in deze periode.</div>';
    }
    return blokken.map((b) => {
      const maxAf = Math.max(0, ...b.vragen.map((v) => v.afgehaakt || 0));
      const rows = b.vragen.map((v) => {
        const hot = maxAf > 0 && v.afgehaakt === maxAf;
        return `<tr style="border-top:1px solid var(--border)${hot ? ';background:var(--rose-soft)' : ''}">
          <td style="padding:4px 6px;white-space:nowrap">Vraag ${esc(v.stap_nr)}${v.vraag_id ? `<div style="color:var(--text-3);font-size:10px;font-family:var(--mono,monospace)">${esc(v.vraag_id)}</div>` : ''}</td>
          <td style="padding:4px 6px;text-align:right">${num(v.gezien)}</td>
          <td style="padding:4px 6px;text-align:right">${num(v.door)}</td>
          <td style="padding:4px 6px;text-align:right">${num(v.afgehaakt)}</td>
          <td style="padding:4px 6px;text-align:right;font-weight:600${hot ? ';color:var(--rose)' : ''}">${fmtPct(v.afhaak_pct)}</td>
          <td class="fd-tijd" style="padding:4px 6px;text-align:right" title="${v.tijd_n ? 'mediaan ' + esc(fmtSec(v.mediaan_tijd_s)) + ' · ' + esc(v.tijd_n) + ' sessies' : 'geen tijdmeting'}">${fmtSec(v.gem_tijd_s)}</td>
          <td style="padding:4px 6px;text-align:right;color:var(--text-2)" title="mediaan tijd op deze vraag van wie hier afhaakte">${fmtSec(v.afhakers_mediaan_s)}</td>
        </tr>`;
      }).join('');
      return `<div class="fd-quiz" data-versie="${esc(b.quiz_versie)}" style="margin-top:8px">
        <div style="font-size:11.5px;font-weight:600;margin-bottom:4px">Quizversie ${esc(b.quiz_versie)}
          <span style="color:var(--text-3);font-weight:400">· gestart ${num(b.sessies_gestart)} · voltooid ${num(b.voltooid)} (${fmtPct(b.voltooid_pct)})</span></div>
        <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums">
          <thead><tr style="color:var(--text-3);text-align:left">
            <th style="padding:4px 6px">Vraag</th><th style="padding:4px 6px;text-align:right">Gezien</th>
            <th style="padding:4px 6px;text-align:right">Door</th><th style="padding:4px 6px;text-align:right">Afgehaakt</th>
            <th style="padding:4px 6px;text-align:right">Afhaak %</th>
            <th style="padding:4px 6px;text-align:right" title="gemiddelde tijd op de vraag (hover: mediaan)">Gem. tijd</th>
            <th style="padding:4px 6px;text-align:right" title="mediaan tijd van wie bij deze vraag afhaakte">Afhakers</th>
          </tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    }).join('');
  }

  // ── Waarom afhaken (gedragssignalen) — onder de vraagtabel ────────────────
  function lijstHtml(titel, rijen, leeg) {
    const body = rijen.length
      ? '<div style="display:flex;flex-direction:column;gap:3px">' + rijen.join('') + '</div>'
      : '<div style="color:var(--text-3)">' + esc(leeg) + '</div>';
    return '<div style="min-width:0"><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">' + esc(titel) + '</div>' + body + '</div>';
  }
  function regel(links, rechts) {
    return '<div style="display:flex;gap:8px;justify-content:space-between;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + links + '</span><span style="font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--text-2)">' + rechts + '</span></div>';
  }
  function gedragHtml(g) {
    if (!g) return '';
    if (!g.beschikbaar) {
      return '<div class="fd-gedrag" style="margin-top:10px;color:var(--text-3);font-size:11.5px">Waarom afhaken: nog geen gedragssignalen in deze periode (scroll, laatste veld, validatie, rage clicks). De tijd per vraag hierboven komt dan uit vraag getoond → beantwoord.</div>';
    }
    const s = g.scroll || {};
    const maxB = Math.max(1, ...((s.buckets || []).map((b) => b.sessies || 0)));
    const scrollRijen = (s.buckets || []).map((b) => `<div style="display:grid;grid-template-columns:52px 1fr auto;gap:6px;align-items:center">
        <span style="color:var(--text-2)">${esc(b.label)}</span>
        <span style="background:var(--surface-2);border-radius:3px;height:10px;position:relative;overflow:hidden"><span style="position:absolute;left:0;top:0;bottom:0;width:${Math.round(((b.sessies || 0) / maxB) * 100)}%;background:var(--brand,#0A7490);opacity:.75"></span></span>
        <span style="font-variant-numeric:tabular-nums;color:var(--text-2)">${num(b.sessies)}</span>
      </div>`);
    const ft = g.formulier_tijd || {};
    const formulier = ft.sessies
      ? [regel('Gemiddeld', esc(fmtSec(ft.gem_s))), regel('Mediaan', esc(fmtSec(ft.mediaan_s))), regel('Afhakers (mediaan)', esc(fmtSec(ft.afgehaakt_mediaan_s))), regel('Verstuurd', esc(ft.verstuurd) + ' van ' + esc(ft.sessies))]
      : [];
    return `<div class="fd-gedrag" style="margin-top:12px;padding-top:10px;border-top:1px dashed var(--border);font-size:11.5px">
      <div style="font-size:11.5px;font-weight:600;margin-bottom:8px">Waarom afhaken <span style="color:var(--text-3);font-weight:400">· ${esc(g.afhakers || 0)} afhakers met afhaakpunt</span></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:12px">
        ${lijstHtml('Scrolldiepte (sessies)' + (s.mediaan_pct != null ? ' · mediaan ' + s.mediaan_pct + '%' : ''), s.sessies ? scrollRijen : [], 'Geen scrollmetingen')}
        ${lijstHtml('Laatste veld vóór afhaken', (g.laatste_veld || []).map((r) => regel(lbl(VELD_LABEL, r.veld), esc(r.sessies) + ' · ' + fmtPct(r.pct))), 'Geen afhakers in het formulier')}
        ${lijstHtml('Top validatiefouten', (g.validatie_top || []).map((r) => regel(lbl(VELD_LABEL, r.veld) + ' <span style="color:var(--text-3)">' + lbl(TYPE_LABEL, r.type) + '</span>', esc(r.sessies) + ' sessies')), 'Geen validatiefouten')}
        ${lijstHtml('Waar afgehaakt', (g.afhaak_fases || []).map((r) => regel(lbl(FASE_LABEL, r.fase), esc(r.sessies) + ' · ' + fmtPct(r.pct))), 'Geen afhaakpunten')}
        ${lijstHtml('Rage-click-hotspots', (g.rage_hotspots || []).map((r) => regel('<code style="font-size:10.5px">' + esc(r.doel) + '</code>', esc(r.sessies) + ' sessies · ' + esc(r.klikken) + '×')), 'Geen rage clicks')}
        ${lijstHtml('Tijd op het formulier', formulier, 'Geen formuliermetingen')}
      </div>
    </div>`;
  }

  function leadHtml(lr, trackingActief, groep) {
    if (!lr) return '';
    const eigen = EIGEN_FLOW[groep];
    const cel = (label, waarde, sub) => `<div style="min-width:0"><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
      <div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">${esc(waarde)}${sub ? `<span style="font-size:10.5px;font-weight:400;color:var(--text-3)"> ${esc(sub)}</span>` : ''}</div></div>`;
    return `<div class="fd-leads" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:8px;padding:8px 10px;background:var(--surface-2);border-radius:var(--r-sm)">
      ${cel('Leads', num(lr.leads))}
      ${eigen ? '' : cel('Toegang', num(lr.toegang), lr.toegang_pct == null ? '' : fmtPct(lr.toegang_pct))}
      ${eigen ? '' : cel('Geen toegang', num(lr.geen_toegang))}
      ${cel(eigen ? eigen.geboekt : 'Geboekt', num(lr.geboekt))}
      ${cel('Met sessie', trackingActief ? num(lr.leads_met_sessie) : '—', trackingActief && lr.dekking_pct != null ? fmtPct(lr.dekking_pct) : '')}
    </div>`;
  }

  // ── Compact overzicht (2026-10-21): één regel per variant ─────────────────
  // Alleen presentatie: elke waarde komt uit dezelfde velden als de detailweergave.
  //   Bezoekers = sessies in fase 'landing'; Opt-in% = 'gegevens_ok' / 'landing';
  //   Leads / Geboekt = lead_resultaat.leads / .geboekt (de blokjes in het detail).
  const MINI_FASES = ['landing', 'formulier_start', 'gegevens_ok', 'lead_ingediend', 'geboekt'];
  const faseSessies = (v, k) => {
    const f = Array.isArray(v.funnel) ? v.funnel.find((x) => x && x.fase === k) : null;
    return f ? (f.sessions || 0) : null;
  };
  function rijCijfers(v) {
    const landing = faseSessies(v, 'landing');
    const opt = faseSessies(v, 'gegevens_ok');
    const lr = v.lead_resultaat || {};
    return {
      bezoekers: landing,
      optin: landing ? Math.round(((opt || 0) / landing) * 1000) / 10 : null,
      leads: lr.leads == null ? null : lr.leads,
      geboekt: lr.geboekt == null ? null : lr.geboekt,
    };
  }
  function miniHtml(v) {
    const landing = faseSessies(v, 'landing') || 0;
    const balk = (k) => {
      const w = landing ? Math.min(100, Math.round(((faseSessies(v, k) || 0) / landing) * 1000) / 10) : 0;
      return `<span style="display:block;height:4px;background:var(--surface-2);border-radius:3px;overflow:hidden"><span style="display:block;height:100%;width:${w}%;background:var(--brand,#0A7490);border-radius:3px"></span></span>`;
    };
    return `<span class="fd-mini" aria-hidden="true" style="display:flex;flex-direction:column;gap:2px;width:140px">${MINI_FASES.map(balk).join('')}</span>`;
  }
  function rijHtml(v, reg, trackingActief, besteOptin) {
    const naam = (reg && reg.naam) || v.label || v.variant;
    const route = reg && reg.route;
    const c = rijCijfers(v);
    const isOpen = !!st.rij[v.variant];
    const beste = besteOptin != null && c.optin != null && c.optin === besteOptin && c.optin > 0;
    const td = 'padding:10px 14px;border-bottom:1px solid var(--border);vertical-align:middle';
    const rij = `<tr class="fd-rij${isOpen ? ' open' : ''}" data-variant="${esc(v.variant)}" role="button" tabindex="0" aria-expanded="${isOpen}"
        onclick="window.__fdRij('${esc(v.variant)}')" onkeydown="window.__fdRijToets(event,'${esc(v.variant)}')"
        style="cursor:pointer${isOpen ? ';background:var(--surface-2)' : ''}">
      <td style="${td};white-space:nowrap;font-weight:600" title="${esc(v.variant)}"><span style="display:inline-block;width:14px;color:var(--text-3);font-size:10px">${isOpen ? '▾' : '▸'}</span>${esc(naam)}</td>
      <td class="fd-col-trechter" style="${td}">${miniHtml(v)}</td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(c.bezoekers)}</td>
      <td style="${td};text-align:right"><span class="fd-optin${beste ? ' beste' : ''}" style="font-variant-numeric:tabular-nums;font-weight:600;${beste ? 'color:var(--emerald);background:var(--emerald-soft);border-radius:6px;padding:3px 8px' : 'color:var(--text-2)'}">${fmtPct(c.optin)}</span></td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(c.leads)}</td>
      <td style="${td};text-align:right;font-variant-numeric:tabular-nums">${num(c.geboekt)}</td>
    </tr>`;
    if (!isOpen) return rij;
    const afhakenOpen = !!st.open[v.variant];
    const sessies = v.sessies_totaal == null ? '' : `<span style="font-size:11px;color:var(--text-3)">${esc(v.sessies_totaal)} sessies</span>`;
    return rij + `<tr class="fd-detail" data-variant="${esc(v.variant)}"><td colspan="6" style="padding:8px 14px 18px 34px;background:var(--surface-2);border-bottom:1px solid var(--border)">
      <div style="display:flex;gap:28px;flex-wrap:wrap;align-items:flex-start">
        <div style="flex:1 1 300px;min-width:0;max-width:540px">${funnelHtml(v.funnel)}</div>
        <div style="flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span style="color:var(--text-3);font-size:10.5px;font-family:var(--mono,monospace)">${esc(v.variant)}</span>${sessies}${route ? `<a href="${esc(route)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--brand,#0A7490);font-size:11.5px">Open ↗</a>` : ''}</div>
          ${leadHtml(v.lead_resultaat, trackingActief, v.groep)}
        </div>
      </div>
      ${trackingActief ? `<div style="margin-top:10px">
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px;padding:4px 8px" onclick="event.stopPropagation();window.__fdToggle('${esc(v.variant)}')">${afhakenOpen ? '▾' : '▸'} Afhaken per vraag</button>
        ${afhakenOpen ? `<div class="fd-afhaken">${afhakenHtml(v.afhaken_per_vraag)}${gedragHtml(v.gedrag)}</div>` : ''}
      </div>` : ''}
    </td></tr>`;
  }

  function bannerHtml(meta) {
    if (!meta) return '';
    const vlekken = Array.isArray(meta.blinde_vlekken) ? meta.blinde_vlekken : [];
    if (!meta.tracking_actief) {
      const titel = meta.tabel_bestaat === false
        ? 'Tracking nog niet actief (migratie funnel_events niet gedraaid)'
        : 'Tracking nog niet actief — nog geen events ontvangen';
      return `<div class="fd-inactief" style="padding:10px 12px;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px;margin-bottom:12px">
        <div style="font-weight:700">${esc(titel)}</div>
        <div style="margin-top:4px">Funnelstappen en afhaken verschijnen zodra dfo-website events naar <code>funnel_events</code> schrijft. De lead-resultaten hieronder komen uit de leads-tabel en werken al.</div>
      </div>`;
    }
    if (!vlekken.length) return '';
    return `<details class="fd-vlekken" style="margin-bottom:12px;font-size:12px;color:var(--text-2)">
      <summary style="cursor:pointer;color:var(--text-3)">Blinde vlekken (${vlekken.length})</summary>
      <ul style="margin:6px 0 0 18px;padding:0">${vlekken.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
    </details>`;
  }

  // Funnels met een eigen flow staan ook in het paneel, maar zonder schakelaar:
  // A/B/C is daar niet van toepassing.
  function eigenFlowRows(registry) {
    return (registry || []).filter((r) => r && EIGEN_FLOW[r.product]).map((r) => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.naam)} <span style="color:var(--text-3);font-family:var(--mono,monospace);font-size:10px">${esc(r.bron)}</span></span>
        <span style="font-size:11px;color:var(--text-3);text-align:right">eigen flow · ${esc(EIGEN_FLOW[r.product].flow)}</span>
      </div>`).join('');
  }

  function flowPanelHtml(registry, open) {
    const funnels = (registry || []).filter((r) => r && FLOW_PRODUCTS.has(r.product));
    if (!funnels.length) return '';
    const saving = st.flowSaving;
    const def = st.flowCfg ? normFlow(st.flowCfg.default) : 'A';
    const pillStyle = { A: 'background:var(--surface-2);font-weight:700;', B: 'background:#0A7490;color:#fff;font-weight:700;', C: 'background:#B07D2B;color:#fff;font-weight:700;' };
    const pill = (bron, flow, active) => `<button class="btn btn-sm" style="font-size:11px;padding:3px 11px;${active ? pillStyle[flow] : 'opacity:.55;background:transparent'}" ${saving ? 'disabled' : ''} onclick="window.__flowSet('${esc(bron)}','${flow}')">${flow}</button>`;
    const rows = funnels.map((r) => {
      const f = flowOf(r.bron);
      return `<div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.naam)} <span style="color:var(--text-3);font-family:var(--mono,monospace);font-size:10px">${esc(r.bron)}</span></span>
        <span style="display:inline-flex;gap:4px;border:1px solid var(--border);border-radius:8px;padding:2px">${pill(r.bron, 'A', f === 'A')}${pill(r.bron, 'B', f === 'B')}${pill(r.bron, 'C', f === 'C')}</span>
      </div>`;
    }).join('');
    return `<details class="fd-flow"${open ? ' open' : ''} style="margin-bottom:16px;border:1px solid var(--border);border-radius:var(--r);padding:10px 12px;background:var(--surface)">
      <summary style="cursor:pointer;font-size:13px;font-weight:700;display:flex;align-items:center;gap:8px">
        Boek-flow (A/B/C) <span style="font-weight:400;color:var(--text-3);font-size:11.5px">· per funnel · A = huidige flow, B = snelle flow, C = korte route (geen quiz) · default ${def}</span>
        ${saving ? '<span style="margin-left:auto;color:var(--text-3);font-size:11px">Opslaan…</span>' : ''}
      </summary>
      <div style="margin-top:8px">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:11px;color:var(--text-3)">Globaal:</span>
          <button class="btn btn-sm btn-ghost" style="font-size:11px;padding:3px 10px" ${saving ? 'disabled' : ''} onclick="window.__flowAll('A')">Alles op A</button>
          <button class="btn btn-sm btn-primary" style="font-size:11px;padding:3px 10px;color:#fff" ${saving ? 'disabled' : ''} onclick="window.__flowAll('B')">Alles op B</button>
          <button class="btn btn-sm" style="font-size:11px;padding:3px 10px;background:#B07D2B;color:#fff" ${saving ? 'disabled' : ''} onclick="window.__flowAll('C')">Alles op C</button>
          ${st.flowErr ? `<span style="color:var(--amber);font-size:11px;margin-left:auto">${esc(st.flowErr)}</span>` : ''}
        </div>
        ${rows}
        ${eigenFlowRows(registry)}
        <div style="font-size:10.5px;color:var(--text-3);margin-top:8px">Wijziging is binnen ~1 minuut live op de funnels. A blijft altijd de veilige fallback.</div>
      </div>
    </details>`;
  }

  // opts.zonderFlow: de boek-flow-schakelaar staat dan in een eigen subtab (renderFlow).
  function render(registry, opts) {
    const o = opts || {};
    if (!st.fetched && !st.loading && !st.error) {
      const q = typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f);
      q(() => fetchStats(false));
    }
    if (!st.flowFetched) {
      const q = typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f);
      q(() => fetchFlow(false).then(() => rerender()));
    }
    const regBy = {};
    for (const r of registry || []) regBy[r.bron] = r;
    const data = st.data || {};
    const meta = data.meta || null;
    const per = data.per_variant || {};
    const trackingActief = !!(meta && meta.tracking_actief);

    const chips = PRESETS.map(([v, l]) => `<button class="chip ${st.preset === v ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="window.__fdPreset('${v}')">${l}</button>`).join('');
    const custom = st.preset === 'custom' ? `<span class="fd-custom" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label style="font-size:11.5px;color:var(--text-3)">van <input type="date" value="${esc(st.customVan)}" onchange="window.__fdSetCustom('van', this)" style="padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px;max-width:150px"></label>
        <label style="font-size:11.5px;color:var(--text-3)">tot <input type="date" value="${esc(st.customTot)}" onchange="window.__fdSetCustom('tot', this)" style="padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:16px;max-width:150px"></label>
        <button class="btn btn-primary btn-sm" style="color:#fff;font-size:11.5px;padding:4px 10px" onclick="window.__fdApplyCustom()">Toepassen</button>
      </span>` : '';
    const periodeTxt = data.periode ? (data.periode.van === data.periode.tot ? data.periode.van : data.periode.van + ' t/m ' + data.periode.tot) : '';

    const varianten = Array.isArray(data.varianten) ? data.varianten : [];
    // Compact overzicht: per funnelgroep een kopregel, daaronder één regel per
    // variant; hoogste opt-in% per groep groen; klik = volledige trechter eronder.
    const groepRijen = GROEPEN.map((g) => {
      const vs = varianten.map((v) => per[v]).filter((v) => v && v.groep === g.groep);
      if (!vs.length) return '';
      const optins = vs.map((v) => rijCijfers(v).optin).filter((x) => x != null);
      const beste = optins.length ? Math.max(...optins) : null;
      return `<tr class="fd-groep" data-groep="${esc(g.groep)}"><td colspan="6" style="background:var(--surface-2);font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2);font-weight:700;padding:8px 14px;border-bottom:1px solid var(--border)">${esc(g.titel)}</td></tr>`
        + vs.map((v) => rijHtml(v, regBy[v.variant], trackingActief, beste)).join('');
    }).join('');
    const th = 'padding:11px 14px;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:600;border-bottom:1px solid var(--border);white-space:nowrap';
    const groepen = groepRijen ? `<style>@media (max-width:600px){.fd-overzicht .fd-col-trechter{display:none}.fd-overzicht table{min-width:0!important}.fd-overzicht td,.fd-overzicht th{padding-left:8px!important;padding-right:8px!important}.fd-overzicht .fd-rij td:first-child{white-space:normal!important}}</style><div class="fd-overzicht" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:10px">
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px;min-width:620px">
        <thead><tr style="text-align:left">
          <th style="${th}">Funnel · variant</th><th class="fd-col-trechter" style="${th}">Trechter</th>
          <th style="${th};text-align:right">Bezoekers</th><th style="${th};text-align:right">Opt-in%</th>
          <th style="${th};text-align:right">Leads</th><th style="${th};text-align:right">Geboekt</th>
        </tr></thead>
        <tbody>${groepRijen}</tbody>
      </table></div>
    </div>
    <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">Klik op een regel voor de volledige trechter met alle stappen. Hoogste opt-in% per funnel staat groen. Bezoekers = landing-sessies; opt-in% = gegevens ingevuld ÷ landing.</div>` : '';

    const leeg = !st.loading && st.fetched && !st.error && !varianten.length
      ? '<div style="padding:22px;text-align:center;color:var(--text-3)">Geen funnelvarianten gevonden.</div>' : '';

    return `<div class="fd-root" style="margin-bottom:22px">
      <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div style="font-size:15px;font-weight:700">Funnel-conversie</div>
        <div style="font-size:11.5px;color:var(--text-3)">first-party tracking per variant · Amsterdam-tijd</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Periode</span>
        ${chips}
        ${custom}
        <span style="font-size:12px;color:var(--text-3);margin-left:auto">${st.loading ? 'Laden…' : esc(periodeTxt)}</span>
      </div>
      ${o.zonderFlow ? '' : flowPanelHtml(registry)}
      ${st.error ? `<div class="fd-fout" style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:10px">${esc(st.error)}</div>` : ''}
      ${bannerHtml(meta)}
      ${groepen}
      ${leeg}
      <div style="font-size:11px;color:var(--text-3)">Fase-telling = bereik: een sessie telt voor een fase als dat event in de periode voorkomt, ook als eerdere fases ontbreken (daardoor kan een stap boven 100% uitkomen). Afhaken wordt per quizversie geteld. Geboekt = opstartsessie-aanvragen met afspraak uit deze variant.</div>
    </div>`;
  }

  /** Subtab "Boek-flow (A/B/C)": alleen de schakelaar, open. */
  function renderFlow(registry) {
    if (!st.flowFetched) {
      const q = typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f);
      q(() => fetchFlow(false).then(() => rerender()));
    }
    return '<div class="fd-flow-tab" style="max-width:900px">' + (flowPanelHtml(registry, true) || '<div style="color:var(--text-3)">Geen funnels met een boek-flow.</div>') + '</div>';
  }

  window.DFOFunnelDashboard = { render, renderFlow, state: st, presetRange, nlVandaag, plusDagen, fetchStats };
})();
