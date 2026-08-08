// modules/klanten-v2/views/studenten-v2.js
//
// B-referentie — Studenten-view voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - VIEWS['studenten/']  r1861-1881  (KPI-strip + toolbar + tabel)
//   - openStudent(i)       r1882-1902  (zijpaneel-detail)
//   - STUDENTEN            r1833-1842  (voorbeeld-data)
//   - STUDST               r1843       (status-mapping)
//   - LMSMOD               r1433 (subset gebruikt in panel)
//
// Non-ES-module (klassieke <script>), geladen NA app-shell.js en VOOR
// klanten-v2.js. Zelfde patroon als dashboard-v2.js.
//
// Registreert:
//   DFO.VIEWS['studenten/']       = studentenView
//   window.openStudent            = detail-handler (aangeroepen via table-onclick)
//   window.KV_V2_ADD?.('studenten')  — schrijft in V2_MODULES-set
//
// DATA IS VOORBEELD. Prominent banner bovenaan de view maakt dat expliciet
// zichtbaar. Data-koppeling volgt in een tweede ronde ná goedkeuring van
// deze layout.

(function () {
  if (!window.DFO) { console.error('[studenten-v2] DFO shell niet geladen.'); return; }
  const { I, svg, S, F, openPanel } = window.DFO;

  /* ── Helpers uit prototype (identiek aan dashboard-v2 waar overlap) ─── */
  const { avc, ini } = window.DFO;
  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const trend = (v, up) => `<span class="trend ${up === null ? 'trend-flat' : up ? 'trend-up' : 'trend-down'}">${up !== null ? svg(up ? I.up : I.arrDown) : ''}${v}</span>`;
  const pill = (c, t, nd) => `<span class="pill pill-${c} ${nd ? 'nodot' : ''}">${t}</span>`;

  /* ── kpi / kpis (prototype r1200-1208) ────────────────────────────── */
  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)" ${o.click ? `onclick="${o.click}"` : ''}>
      <div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot">${o.trend || ''}<span>${o.sub || ''}</span></div></div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;

  /* ── toolbar / chips / search (prototype r1195-1198) ──────────────── */
  const toolbar = p => `<div class="toolbar">${p.join('')}</div>`;
  const chips = (n, o, c) => o.map(x => `<button class="chip ${c === x.v ? 'on' : ''}" onclick="DFO.setF('${n}','${x.v}')">${x.l}${x.n !== undefined ? `<span class="cnt">${x.n}</span>` : ''}</button>`).join('');
  const search = ph => `<div class="tb-search">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
    <input placeholder="${ph}" oninput="DFO.setF('q',this.value)" value="${(F('q', '') || '').replace(/"/g, '&quot;')}" /></div>`;

  /* ── table (prototype r1223-1226) ─────────────────────────────────── */
  function table(cols, rows, onclick) {
    return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr ${onclick ? `onclick="${onclick}(${i})"` : ''} class="${S.selIdx === i ? 'sel' : ''}">
        ${r.map((cell, j) => `<td class="${cols[j].cls || ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  /* ── VOORBEELD-banner: prominent module-niveau markering ──────────── */
  const voorbeeldBanner = () => `<div style="margin:14px 20px 0;padding:11px 14px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);
    display:flex;align-items:center;gap:11px;font-size:12.5px;color:var(--amber)">
    ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}
    <span><b>VOORBEELD-DATA</b> — deze view toont layout uit systeemprototype-v45.
    Data-koppeling volgt in de volgende ronde na layout-goedkeuring.</span></div>`;

  /* ── Voorbeeld-data (prototype r1833-1843) ────────────────────────── */
  const STUDENTEN = [
    { n: 'Cabdi Ibrahim',            tr: '12 maand 1-op-1',      voortgang: 64, sessies: 7, laatste: '28-07', volgende: 'Vandaag 09:00', status: 'op schema', tel: '+31 6 55443322',  mail: 'cabdi.i@gmail.com' },
    { n: 'Nikita Bykov',             tr: '36 maand membership',  voortgang: 22, sessies: 3, laatste: '21-07', volgende: 'Vandaag 11:00', status: 'op schema', tel: '+31 6 12009988',  mail: 'n.bykov@bynik.nl' },
    { n: 'Emile Rabaut',             tr: '6 maand 1-op-1',       voortgang: 80, sessies: 9, laatste: '25-07', volgende: '16-08 14:00',   status: 'op schema', tel: '+32 495 88 12 04', mail: 'emile@erschilder.be' },
    { n: 'Chamano BV',               tr: '12 maand 1-op-1',      voortgang: 55, sessies: 6, laatste: '26-07', volgende: '18-08 10:00',   status: 'op schema', tel: '+32 476 22 11 89', mail: 'info@chamano.be' },
    { n: 'Dyami Van Praag',          tr: '12 maand 1-op-1',      voortgang: 22, sessies: 4, laatste: '08-07', volgende: '—',             status: 'aandacht',  tel: '+31 6 21445566',  mail: 'dyami@outlook.com' },
    { n: 'Christa Noltus Haarkamp',  tr: '6 maand 1-op-1',       voortgang: 41, sessies: 5, laatste: '18-07', volgende: '—',             status: 'aandacht',  tel: '+31 6 12425245',  mail: 'christa.nh@gmail.com' },
    { n: 'Jennifer Botaka',          tr: '12 maand 1-op-1',      voortgang: 18, sessies: 2, laatste: '12-07', volgende: '—',             status: 'aandacht',  tel: '+31 6 77889900',  mail: 'j.botaka@gmail.com' },
    { n: 'Aysar Al Dujaili',         tr: '6 maand 1-op-1',       voortgang: 12, sessies: 1, laatste: '02-08', volgende: '12-08 15:00',   status: 'nieuw',     tel: '+31 6 33557799',  mail: 'aysar.ad@gmail.com' },
  ];
  const STUDST = {
    'op schema': { l: 'Op schema',       c: 'ok' },
    'aandacht':  { l: 'Vraagt aandacht', c: 'warn' },
    'nieuw':     { l: 'Nieuw',           c: 'accent' },
  };
  // Subset LMS-modules voor het panel — namen uit prototype r1433 e.v.
  const LMSMOD = [
    { naam: 'Basis marktstructuur' },
    { naam: 'Trend & momentum' },
    { naam: 'Order-blokken' },
    { naam: 'Risk & positiebeheer' },
    { naam: 'Live-sessies week 1' },
    { naam: 'Live-sessies week 2' },
  ];

  /* ── Studenten-view (prototype r1861-1881) ────────────────────────── */
  function studentenView() {
    const f = F('sf', 'all');
    const q = (F('q', '') || '').toLowerCase();
    const rows = STUDENTEN.filter(s => (f === 'all' || s.status === f) && (!q || s.n.toLowerCase().includes(q)));
    S.rows = rows;
    const gem = Math.round(STUDENTEN.reduce((a, s) => a + s.voortgang, 0) / STUDENTEN.length);

    return `${voorbeeldBanner()}
    ${kpis([
      { c: 'teal',    icon: I.users, label: 'Mijn studenten',    val: '24',                 sub: STUDENTEN.length + ' in dit overzicht' },
      { c: 'emerald', icon: I.chart, label: 'Gem. voortgang',    val: gem + '%',   hi: 1,   sub: 'over alle studenten', trend: trend('+5%', true) },
      { c: 'pink',    icon: I.cal,   label: 'Sessies deze week', val: '6',         hi: 1,   sub: '3 nog te plannen' },
      { c: 'amber',   icon: I.alert, label: 'Vragen aandacht',   val: String(STUDENTEN.filter(s => s.status === 'aandacht').length), hi: 1, sub: 'weinig activiteit' },
    ])}
    ${toolbar([
      chips('sf', [
        { l: 'Alle studenten', v: 'all', n: STUDENTEN.length },
        { l: 'Op schema',      v: 'op schema' },
        { l: 'Aandacht',       v: 'aandacht' },
        { l: 'Nieuw',          v: 'nieuw' },
      ], f),
      search('Zoek student…'),
      `<div class="tb-right"><button class="btn btn-primary">${svg(I.cal)}Sessie plannen</button></div>`,
    ])}
    ${table(
      [{ l: 'Student' }, { l: 'Traject', cls: 'optional' }, { l: 'Voortgang' }, { l: 'Sessies', cls: 'optional' }, { l: 'Volgende sessie' }, { l: 'Status' }],
      rows.map(s => [
        `<div class="row-avatar">${av(s.n, 30)}<span class="cell-main">${s.n}</span></div>`,
        `<span style="color:var(--text-2);font-size:12.5px">${s.tr}</span>`,
        `<div style="min-width:120px">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px"><span class="mono">${s.voortgang}%</span></div>
          <div class="progress" style="max-width:130px"><i style="width:${s.voortgang}%;background:var(--${s.voortgang >= 60 ? 'emerald' : s.voortgang >= 35 ? 'amber' : 'rose'})"></i></div>
        </div>`,
        `<span class="mono">${s.sessies}</span>`,
        `<span style="${s.volgende === '—' ? 'color:var(--text-3)' : s.volgende.startsWith('Vandaag') ? 'color:var(--amber);font-weight:600' : 'color:var(--text-2)'}">${s.volgende}</span>`,
        pill(STUDST[s.status].c, STUDST[s.status].l),
      ]),
      'openStudent'
    )}`;
  }

  /* ── openStudent (prototype r1882-1902) — zijpaneel-detail ────────── */
  window.openStudent = function openStudent(i) {
    const s = S.rows[i];
    if (!s) return;
    S.selIdx = i;
    openPanel(
      s.n,
      `${s.tr} · ${s.sessies} sessies gehad`,
      `<div class="hero-amount" style="text-align:left">
        <div class="lbl">Voortgang</div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:4px">
          <div class="big-amount" style="color:var(--${s.voortgang >= 60 ? 'emerald' : s.voortgang >= 35 ? 'amber' : 'rose'})">${s.voortgang}%</div>
          <div style="flex:1">
            <div class="progress" style="height:9px"><i style="width:${s.voortgang}%;background:var(--${s.voortgang >= 60 ? 'emerald' : s.voortgang >= 35 ? 'amber' : 'rose'})"></i></div>
            <div style="margin-top:8px">${pill(STUDST[s.status].c, STUDST[s.status].l)}</div>
          </div>
        </div>
      </div>
      <div class="sect">
        <div class="sect-title">Voortgang per module</div>
        ${LMSMOD.map((m, k) => {
          const p = Math.max(0, Math.min(100, s.voortgang + [12, -4, -14, -24, 8, -18][k % 6]));
          return `<div class="cl-row" style="padding:8px 0">
            <div style="flex:1">
              <div class="cell-main" style="font-size:12.5px">${m.naam}</div>
              <div class="progress" style="max-width:200px;margin-top:5px"><i style="width:${p}%"></i></div>
            </div>
            <span class="mono" style="font-size:12px">${p}%</span>
          </div>`;
        }).join('')}
      </div>
      <div class="sect">
        <div class="sect-title">Sessies</div>
        <div class="kv"><dt>Sessies gehad</dt><dd class="num">${s.sessies}</dd></div>
        <div class="kv"><dt>Laatste sessie</dt><dd class="num">${s.laatste}</dd></div>
        <div class="kv"><dt>Volgende sessie</dt><dd class="num">${s.volgende}</dd></div>
      </div>
      <div class="sect">
        <div class="sect-title">Contact</div>
        <div class="kv"><dt>E-mail</dt><dd>${s.mail}</dd></div>
        <div class="kv"><dt>Telefoon</dt><dd class="num">${s.tel}</dd></div>
      </div>
      <div class="sect">
        <div class="sect-title">Notitie</div>
        <textarea class="inp" style="max-width:none;min-height:64px" placeholder="Notitie over deze student…"></textarea>
      </div>`,
      `<button class="btn btn-ghost" style="flex:1;justify-content:center">${svg(I.chat)}Bericht</button>
       <button class="btn btn-primary" style="flex:1;justify-content:center">${svg(I.cal)}Sessie plannen</button>`
    );
  };

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['studenten/'] = studentenView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('studenten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('studenten');
  }

  console.debug('[studenten-v2] registered VIEWS[studenten/]');
})();
