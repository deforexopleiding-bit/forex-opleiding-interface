// modules/klanten-v2/views/checkin-inzichten-v2.js
//
// STUDENTENCHECK-IN › INZICHTEN (Maxim, 29 okt 2026) — wat de antwoorden samen
// zeggen: KPI's, per vraag horizontale balken, de zekerheid per trechterstap
// (de zwakste uitgelicht), het gebruik per onderdeel (vaak/soms/nooit + waarom
// niet), de top-knelpunten en alle open antwoorden. Filters op traject,
// mentor, fase en trade-stand; CSV met één rij per inzending.
//
// Rekenkern: api/_lib/checkin-inzichten.js (dezelfde als het LMS). Data:
// GET /api/checkin-beheer?inzichten=1 (recht checkin.view). Alleen lezen.

(function () {
  'use strict';
  if (!window.DFO) return;
  window.DFO.VIEWS = window.DFO.VIEWS || {};
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const API = '/api/checkin-beheer?inzichten=1';
  const st = window.__ciState = window.__ciState || { laden: false, data: null, fout: null, seq: 0, f: { traject: '', mentor: '', fase: '', trade_stand: '', test: '' } };
  const rerender = () => { if (typeof window.DFO.render === 'function') window.DFO.render(); };
  const getal = (n) => (n == null ? '—' : String(n).replace('.', ','));
  const query = () => Object.entries(st.f).filter(([, v]) => v).map(([k, v]) => '&' + k + '=' + encodeURIComponent(v)).join('');

  async function laad() {
    st.laden = true; st.fout = null;
    const seq = ++st.seq;
    rerender();
    try {
      const j = await window.KV.authedJson(API + query());
      if (seq === st.seq) st.data = j;
    } catch (e) {
      if (seq === st.seq) st.fout = e && e.status === 403 ? 'Geen toegang (recht checkin.view).' : ((e && e.body && e.body.error) || (e && e.message) || 'De inzichten konden niet geladen worden.');
    } finally {
      if (seq === st.seq) { st.laden = false; rerender(); }
    }
  }
  window.__ciFilter = (k, v) => { st.f[k] = v; laad(); };
  window.__ciCsv = async () => {
    try {
      const r = await window.KV.authedFetch(API + query() + '&csv=1');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'checkin-inzichten.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      if (window.KV && window.KV.toast) window.KV.toast('Export mislukt: ' + (e.message || e));
    }
  };

  const balk = (pct, kleur) => `<span style="display:block;height:8px;border-radius:4px;background:var(--line,#e5e7eb);overflow:hidden"><i style="display:block;height:100%;width:${Math.max(0, Math.min(100, pct || 0))}%;background:${kleur}"></i></span>`;

  function kaart(titel, inhoud, extra = '') {
    return `<div class="card" style="margin-bottom:12px" ${extra}><div class="card-body"><h4 style="margin:0 0 10px;font-size:13.5px">${esc(titel)}</h4>${inhoud}</div></div>`;
  }

  function grafiek(v) {
    if (!v.beantwoord) return '';
    const rijen = v.balken.map((b) => `<div style="display:grid;grid-template-columns:minmax(120px,38%) 1fr 72px;gap:8px;align-items:center;font-size:12.5px;margin:3px 0">
      <span>${esc(b.label)}</span>${balk(b.pct, 'var(--gold,#c98b2e)')}<span style="text-align:right;color:var(--text-3)">${b.aantal} · ${getal(b.pct)}%</span></div>`).join('');
    return kaart(`${v.vraag} (${v.beantwoord})${v.soort === 'meer' ? ' · meerdere keuzes' : ''}`, rijen, `data-vraag="${esc(v.sleutel)}"`);
  }

  function filters(d) {
    const k = d.inzichten.keuzes;
    const sel = (naam, label, opties) => `<label style="font-size:12px">${esc(label)} <select onchange="window.__ciFilter('${naam}', this.value)" data-testid="ci-filter-${naam}">
      <option value="">Alle</option>${opties.map(([v, l]) => `<option value="${esc(v)}" ${st.f[naam] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    return `<div class="card" style="margin-bottom:12px"><div class="card-body" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center">
      ${sel('traject', 'Traject', k.trajecten)}
      ${sel('mentor', 'Mentor', [['geen', 'Zonder mentor'], ...k.mentoren])}
      ${sel('fase', 'Fase', k.fases)}
      ${sel('trade_stand', 'Trade-stand', k.trade_standen)}
      <label style="font-size:12px"><input type="checkbox" ${st.f.test ? 'checked' : ''} onchange="window.__ciFilter('test', this.checked ? '1' : '')"> Met testinzendingen</label>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__ciCsv()" data-testid="ci-csv">Export CSV</button>
    </div></div>`;
  }

  function view() {
    if (!st.data && !st.laden && !st.fout) laad();
    if (st.fout) return `<div class="card"><div class="card-body" style="color:var(--rose)">${esc(st.fout)}</div></div>`;
    if (!st.data) return `<div class="card"><div class="card-body" style="color:var(--text-3)">Laden…</div></div>`;
    const d = st.data;
    const z = d.inzichten;
    let h = `<div data-testid="checkin-inzichten">` + filters(d);
    const t = (l, w, s) => `<div class="card"><div class="card-body"><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em">${esc(l)}</div><div style="font-size:22px;font-weight:700">${w}</div><div style="font-size:11.5px;color:var(--text-3)">${s || ''}</div></div></div>`;
    h += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px">
      ${t('Ingevuld', z.kpi.ingevuld, `van ${z.kpi.toegewezen} · ${getal(z.kpi.respons_pct)}% respons`)}
      ${t('Gemiddelde NPS', getal(z.kpi.nps_gemiddeld), z.kpi.nps_score == null ? '' : 'NPS-score ' + z.kpi.nps_score)}
      ${t('Feedbackpanel ja', z.kpi.feedbackpanel_ja_pct == null ? '—' : getal(z.kpi.feedbackpanel_ja_pct) + '%', 'wil meedenken')}
      ${t('Tevredenheid mentor', getal(z.kpi.mentor_score_gemiddeld), 'gemiddeld op 5 (1-op-1)')}
    </div>`;
    if (!z.genoeg) {
      h += `<div class="card" style="margin-bottom:12px"><div class="card-body" data-testid="ci-te-weinig">Te weinig antwoorden voor een betrouwbaar beeld (${z.kpi.ingevuld} van minstens ${z.min}). ${z.kpi.ingevuld ? 'Wat er al is, staat hieronder — lees het met de nodige voorzichtigheid.' : ''}</div></div>`;
      if (!z.kpi.ingevuld) return h + '</div>';
    }
    //  De methode: zekerheid per trechterstap, de zwakste uitgelicht.
    h += kaart('De methode — zekerheid per stap (gemiddelde op 5)', z.zekerheid.map((s) => {
      const zwak = s.stap === z.zwakste;
      return `<div style="margin:6px 0;${zwak ? 'padding:6px 8px;border-radius:8px;background:var(--rose-tint,#fde8e8)' : ''}" data-stap="${esc(s.stap)}" ${zwak ? 'data-testid="ci-zwakste"' : ''}>
        <div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${zwak ? '<b>Zwakste stap · </b>' : ''}${esc(s.label)}</span><b>${getal(s.gemiddelde)}</b></div>
        ${balk(s.gemiddelde ? (s.gemiddelde / 5) * 100 : 0, zwak ? 'var(--rose,#e5484d)' : 'var(--gold,#c98b2e)')}
        <div style="font-size:11px;color:var(--text-3)">${s.verdeling.map((v) => `${v.score}: ${v.aantal}`).join(' · ')} · ${getal(s.laag_pct)}% ≤ 2</div></div>`;
    }).join(''));
    //  Gebruik per onderdeel: gestapelde balk vaak/soms/nooit + top "waarom niet".
    h += kaart('Wat gebruiken ze van ons?', z.gebruik.map((g) => {
      const p = (n) => (g.totaal ? (n / g.totaal) * 100 : 0);
      return `<div style="margin:7px 0" data-onderdeel="${esc(g.onderdeel)}">
        <div style="display:flex;justify-content:space-between;font-size:12.5px"><span>${esc(g.label)}</span><span style="color:var(--text-3)">${g.vaak} vaak · ${g.soms} soms · ${g.nooit} nooit</span></div>
        <span style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:var(--line,#e5e7eb)"><i style="width:${p(g.vaak)}%;background:#3ecf8e"></i><i style="width:${p(g.soms)}%;background:#c98b2e"></i><i style="width:${p(g.nooit)}%;background:#e5484d"></i></span>
        ${g.waarom_niet.length ? `<div style="font-size:11px;color:var(--text-3)">Waarom niet: ${g.waarom_niet.map((w) => `${esc(w.label)} (${w.aantal})`).join(' · ')}</div>` : ''}</div>`;
    }).join(''));
    const lijst = (l) => (l.length ? l.map((b) => `<li>${esc(b.label)} — <b>${b.aantal}</b></li>`).join('') : '<li style="color:var(--text-3)">nog niets</li>');
    h += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      ${kaart('Top knelpunten', `<ol style="margin:0;padding-left:18px;font-size:12.5px">${lijst(z.top.knelpunten)}</ol>`)}
      ${kaart('Top vooruithelpen', `<ol style="margin:0;padding-left:18px;font-size:12.5px">${lijst(z.top.vooruithelpen)}</ol>`)}
      ${kaart('Beste live-moment', `<ol style="margin:0;padding-left:18px;font-size:12.5px">${lijst(z.top.live_moment)}</ol>`)}
    </div>`;
    h += z.vragen.map(grafiek).join('');
    h += kaart(`Open antwoorden (${z.open.length})`, z.open.length
      ? z.open.map((o) => `<div style="padding:8px 0;border-top:1px solid var(--line,#e5e7eb);font-size:12.5px" data-testid="ci-open">
          <div style="color:var(--text-3);font-size:11.5px">${esc(o.naam)} · ${o.traject === '1op1' ? '1-op-1' : 'Membership'} · ${esc(o.mentor || 'geen mentor')}${o.oud ? ' · (oude vraag "Wat kunnen we beter doen")' : ''}</div>
          <div>${esc(o.tekst)}</div></div>`).join('')
      : '<p style="color:var(--text-3);font-size:12.5px;margin:0">Nog geen open antwoorden binnen deze filter.</p>');
    return h + '</div>';
  }

  window.DFO.VIEWS['checkin/Inzichten'] = view;
})();
