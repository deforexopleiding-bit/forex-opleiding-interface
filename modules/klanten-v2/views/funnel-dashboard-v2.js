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
  ];

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

  function leadHtml(lr, trackingActief) {
    if (!lr) return '';
    const cel = (label, waarde, sub) => `<div style="min-width:0"><div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">${esc(label)}</div>
      <div style="font-size:15px;font-weight:700;font-variant-numeric:tabular-nums">${esc(waarde)}${sub ? `<span style="font-size:10.5px;font-weight:400;color:var(--text-3)"> ${esc(sub)}</span>` : ''}</div></div>`;
    return `<div class="fd-leads" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(70px,1fr));gap:8px;padding:8px 10px;background:var(--surface-2);border-radius:var(--r-sm)">
      ${cel('Leads', num(lr.leads))}
      ${cel('Toegang', num(lr.toegang), lr.toegang_pct == null ? '' : fmtPct(lr.toegang_pct))}
      ${cel('Geen toegang', num(lr.geen_toegang))}
      ${cel('Geboekt', num(lr.geboekt))}
      ${cel('Met sessie', trackingActief ? num(lr.leads_met_sessie) : '—', trackingActief && lr.dekking_pct != null ? fmtPct(lr.dekking_pct) : '')}
    </div>`;
  }

  function kaartHtml(v, reg, trackingActief) {
    const naam = (reg && reg.naam) || v.label || v.variant;
    const route = reg && reg.route;
    const open = !!st.open[v.variant];
    const sessies = v.sessies_totaal == null ? '' : `<span style="font-size:11px;color:var(--text-3)">${esc(v.sessies_totaal)} sessies</span>`;
    return `<div class="fd-kaart" data-variant="${esc(v.variant)}" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:13.5px">${esc(naam)}</div>
          <div style="color:var(--text-3);font-size:10.5px;font-family:var(--mono,monospace)">${esc(v.variant)}</div>
        </div>
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-shrink:0">${sessies}${route ? `<a href="${esc(route)}" target="_blank" rel="noopener" style="color:var(--brand,#0A7490);font-size:11.5px">Open ↗</a>` : ''}</span>
      </div>
      ${funnelHtml(v.funnel)}
      ${leadHtml(v.lead_resultaat, trackingActief)}
      ${trackingActief ? `<div>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px;padding:4px 8px" onclick="window.__fdToggle('${esc(v.variant)}')">${open ? '▾' : '▸'} Afhaken per vraag</button>
        ${open ? `<div class="fd-afhaken">${afhakenHtml(v.afhaken_per_vraag)}${gedragHtml(v.gedrag)}</div>` : ''}
      </div>` : ''}
    </div>`;
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

  function render(registry) {
    if (!st.fetched && !st.loading && !st.error) {
      const q = typeof queueMicrotask === 'function' ? queueMicrotask : (f) => Promise.resolve().then(f);
      q(() => fetchStats(false));
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
    const groepen = GROEPEN.map((g) => {
      const kaarten = varianten.map((v) => per[v]).filter((v) => v && v.groep === g.groep)
        .map((v) => kaartHtml(v, regBy[v.variant], trackingActief)).join('');
      if (!kaarten) return '';
      return `<section class="fd-groep" data-groep="${esc(g.groep)}" style="margin-bottom:16px">
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${esc(g.titel)}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,270px),1fr));gap:10px">${kaarten}</div>
      </section>`;
    }).join('');

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
      ${st.error ? `<div class="fd-fout" style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:10px">${esc(st.error)}</div>` : ''}
      ${bannerHtml(meta)}
      ${groepen}
      ${leeg}
      <div style="font-size:11px;color:var(--text-3)">Fase-telling = bereik: een sessie telt voor een fase als dat event in de periode voorkomt, ook als eerdere fases ontbreken (daardoor kan een stap boven 100% uitkomen). Afhaken wordt per quizversie geteld. Geboekt = opstartsessie-aanvragen met afspraak uit deze variant.</div>
    </div>`;
  }

  window.DFOFunnelDashboard = { render, state: st, presetRange, nlVandaag, plusDagen, fetchStats };
})();
