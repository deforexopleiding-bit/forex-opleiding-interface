// modules/klanten-v2/views/opvolging-v2.js
//
// Opvolging — het dagsysteem voor Dave. Fase 1.
//
// Nieuw bestand. Raakt geen bestaande view aan en registreert zich op eigen
// sleutels in window.DFO.VIEWS. De oude Follow-up-module blijft ongewijzigd.
//
// Fase 1 levert: de takenlijst met de weekbalk, de twee rondes per dag, het
// blok "wacht op inplanning", het beslisvenster "Wat nu?", het dashboard met
// de dekking van de dag, en Afgerond met de historiek per lead.
//
// Bewust NIET in fase 1 (en daarom leeg met een duidelijke melding, nooit met
// verzonnen cijfers): de spraakberichten- en nabelblokken en de calls van
// vandaag. Die hangen aan de WhatsApp-brug en de agendakoppeling — fase 2 en 3.
//
// Endpoints: /api/opvolging-taken, /api/opvolging-dag,
//            /api/opvolging-taak-update, /api/opvolging-poging

(function () {
  if (!window.DFO) { console.error('[opvolging-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[opvolging-v2] KV_V2.helpers niet geladen.'); return; }

  const DOEL_BELLEN = 2;
  const ARCHIEF_MIN_DAGEN = 3;   // belpogingen op zoveel verschillende dagen
  const ARCHIEF_MIN_WA = 1;

  const render = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const vandaag = () => iso(Date.now());
  const dagPlus = (basis, n) => { const d = new Date(basis + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const nl = (d) => (d ? d.slice(8) + '/' + d.slice(5, 7) : '—');
  const uur = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ═════════════════════════════════════════════════════════════════════════
  // STAAT
  // ═════════════════════════════════════════════════════════════════════════
  const _live = {
    taken: { loading: false, error: null, data: null, key: null },
    dash: { loading: false, error: null, data: null, key: null },
    archief: { loading: false, error: null, data: null },
  };
  const _ui = {
    dagView: null,          // null = vandaag
    modal: null,            // { soort, taakId, ... }
    bezig: false,
  };

  async function haal(url) {
    try {
      const j = await window.KV.authedJson(url);
      if (j && j.error) return { __error: j.error };
      return j;
    } catch (e) {
      return { __error: (e && e.message) || 'Netwerkfout' };
    }
  }

  async function fetchTaken(dag) {
    const st = _live.taken;
    if (st.loading || (st.data && st.key === dag)) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-taken?dag=' + encodeURIComponent(dag));
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j;
    render();
  }
  async function fetchDash(dag) {
    const st = _live.dash;
    if (st.loading || (st.data && st.key === dag)) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-dag?dag=' + encodeURIComponent(dag));
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j;
    render();
  }
  async function fetchArchief() {
    const st = _live.archief;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await haal('/api/opvolging-taken?view=archief');
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j.archief || [];
    render();
  }
  const leegTakenCache = () => { _live.taken.data = null; _live.taken.key = null; _live.dash.data = null; _live.dash.key = null; _live.archief.data = null; };

  async function post(url, body) {
    _ui.bezig = true;
    try {
      const j = await window.KV.authedJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j && j.error) throw new Error(j.error);
      return j;
    } finally { _ui.bezig = false; }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STIJL — één keer ingespoten, volledig gescoped onder .opv zodat er
  // buiten deze module niets kan verschuiven.
  // ═════════════════════════════════════════════════════════════════════════
  function stijl() {
    if (document.getElementById('opv-stijl')) return '';
    const el = document.createElement('style');
    el.id = 'opv-stijl';
    el.textContent = `
.opv{--o-line:#e5e7eb;--o-muted:#6b7280;--o-ink:#0f1419;--o-acc:#2f6bff;--o-accs:#eaf0ff;
 --o-grn:#0ea968;--o-grns:#e6f7f0;--o-amb:#e08700;--o-ambs:#fff5e6;--o-red:#e0393e;--o-reds:#fdeced;
 --o-pur:#7c4dff;--o-purs:#f1ecff;--o-sh:0 1px 2px rgba(16,20,30,.06),0 8px 24px rgba(16,20,30,.05);
 color:var(--o-ink);padding:18px 22px 60px;max-width:1000px}
.opv .wk{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.opv .wkd{flex:1;min-width:104px;background:#fff;border:1px solid var(--o-line);border-radius:12px;padding:9px 11px;cursor:pointer;font-family:inherit;text-align:left;box-shadow:var(--o-sh);display:flex;flex-direction:column;gap:2px}
.opv .wkd .l{font-size:11.5px;color:var(--o-muted);font-weight:600}
.opv .wkd .c{font-size:17px;font-weight:750}
.opv .wkd .c small{font-size:11.5px;font-weight:600;color:var(--o-muted)}
.opv .wkd.on{border-color:var(--o-acc);box-shadow:0 0 0 3px var(--o-accs)}
.opv .wkd.nu .l{color:var(--o-acc)}
.opv .wkd.oud{background:#fbfcfd}
.opv .ronde{font-size:12.5px;color:var(--o-muted);margin:0 0 10px 2px}
.opv .row{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:13px 16px;display:flex;align-items:flex-start;gap:14px;margin-bottom:9px;box-shadow:var(--o-sh)}
.opv .row .who{flex:1;min-width:0}
.opv .row .nm{font-weight:650;font-size:14.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opv .row .mt{font-size:12.5px;margin-top:7px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.opv .act{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;align-self:center}
.opv .tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
.opv .t-blue{background:var(--o-accs);color:#1a49c4}.opv .t-amber{background:var(--o-ambs);color:#9a5d00}
.opv .t-red{background:var(--o-reds);color:#b32b2f}.opv .t-green{background:var(--o-grns);color:#08794a}
.opv .t-purple{background:var(--o-purs);color:#5a2fd6}.opv .t-grey{background:#f0f1f4;color:#5b6472}
.opv .pil{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:3px 10px;font-size:11.5px;font-weight:650;border:1px solid #e4e7ec;background:#fff;color:#7a828f}
.opv .pil.aan{background:#0f1420;border-color:#0f1420;color:#fff}
.opv .pil.wa{background:var(--o-grn);border-color:var(--o-grn);color:#fff}
.opv .pil.uit{background:#f4f5f7;border-color:#eaecf0;color:#a2a9b4}
.opv .dots{display:inline-flex;gap:3px}
.opv .dots i{width:7px;height:7px;border-radius:50%;background:#dadee5;display:block}
.opv .pil.aan .dots i{background:#4b5768}
.opv .dots i.on{background:var(--o-acc)}.opv .pil.aan .dots i.on{background:#7fa5ff}
.opv .note{background:#fbfbfc;border-left:3px solid var(--o-line);padding:7px 11px;border-radius:0 8px 8px 0;font-size:13px;color:#414954;margin-top:9px}
.opv .empty{text-align:center;color:var(--o-muted);font-size:13.5px;padding:24px;border:1px dashed var(--o-line);border-radius:14px;background:#fcfcfd}
.opv .obtn{border:1px solid var(--o-line);background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--o-ink)}
.opv .obtn:hover{border-color:#c9cfd8}
.opv .obtn.p{background:var(--o-acc);border-color:var(--o-acc);color:#fff}
.opv .obtn.wa{background:var(--o-grns);border-color:#bfe9d6;color:#08794a}
.opv .sh{display:flex;align-items:center;gap:9px;margin:22px 0 11px 2px}
.opv .sh .ic{width:25px;height:25px;border-radius:8px;display:grid;place-items:center;font-size:12.5px}
.opv .sh h3{font-size:14px;font-weight:700;margin:0}
.opv .sh .n{background:var(--o-line);color:#4b5563;border-radius:20px;padding:1px 8px;font-size:11px;font-weight:700}
.opv .dhero{background:linear-gradient(135deg,#0e1730,#20366f 55%,#2b4a95);color:#fff;border-radius:18px;padding:20px 24px;margin-bottom:20px}
.opv .dhero .lbl{font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:#9dbaff;font-weight:700}
.opv .dhero .big{font-size:27px;font-weight:750;margin-top:4px}
.opv .dhero .sml{color:#c3d3f5;font-size:13px;margin-top:5px}
.opv .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.opv .kpi{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:15px 16px;box-shadow:var(--o-sh);position:relative;overflow:hidden}
.opv .kpi:before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:#dfe3e9}
.opv .kpi.g:before{background:var(--o-grn)}.opv .kpi.a:before{background:var(--o-amb)}.opv .kpi.r:before{background:var(--o-red)}.opv .kpi.b:before{background:var(--o-acc)}
.opv .kpi .k{font-size:12px;color:var(--o-muted)}
.opv .kpi .v{font-size:26px;font-weight:750;margin-top:6px;font-variant-numeric:tabular-nums}
.opv .kpi .s{font-size:12px;margin-top:4px}
.opv .cov{background:#fff;border:1px solid var(--o-line);border-radius:14px;box-shadow:var(--o-sh);overflow:hidden;margin-top:12px}
.opv .covr{display:flex;align-items:center;gap:12px;padding:10px 15px;border-bottom:1px solid #f1f2f5}
.opv .covr:last-child{border-bottom:0}
.opv .covr .nm2{font-weight:600;font-size:13.5px;flex:1;min-width:0}
.opv .covr .st{font-size:11.5px;font-weight:650;flex:0 0 92px;text-align:right}
.opv .ok{color:var(--o-grn);font-weight:650}.opv .bad{color:var(--o-red);font-weight:650}.opv .laatc{color:var(--o-amb);font-weight:650}
.opv table{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff}
.opv th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--o-muted);padding:11px 14px;border-bottom:1px solid var(--o-line)}
.opv td{padding:12px 14px;border-bottom:1px solid #f1f2f5}
.opv .card{background:#fff;border:1px solid var(--o-line);border-radius:14px;box-shadow:var(--o-sh);overflow:hidden}
.opv .scrim{position:fixed;inset:0;background:rgba(12,16,24,.5);display:grid;place-items:center;z-index:9000;padding:20px}
.opv .modal{background:#fff;border-radius:18px;width:100%;max-width:540px;max-height:88vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.3)}
.opv .mh{padding:20px 22px 14px;border-bottom:1px solid var(--o-line);display:flex;align-items:flex-start;gap:12px}
.opv .mh h3{font-size:17px;margin:0}.opv .mh p{color:var(--o-muted);font-size:13px;margin:3px 0 0}
.opv .mh .x{margin-left:auto;background:none;border:0;font-size:22px;color:#9aa2ad;cursor:pointer}
.opv .mb{padding:18px 22px 22px}
.opv .opt{display:flex;align-items:center;gap:13px;width:100%;text-align:left;padding:14px 15px;border:1px solid var(--o-line);border-radius:13px;background:#fff;cursor:pointer;margin-bottom:9px;font-family:inherit}
.opv .opt:hover{border-color:var(--o-acc);background:var(--o-accs)}
.opv .opt .em{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-size:17px;flex:0 0 auto}
.opv .opt b{display:block;font-size:14.5px}.opv .opt span{font-size:12.5px;color:var(--o-muted)}
.opv .warn{background:var(--o-ambs);border:1px solid #f3ddb4;border-radius:11px;padding:12px 14px;font-size:13px;color:#7a4d00;margin-bottom:12px}
.opv .info{background:var(--o-accs);border:1px solid #cfdcff;border-radius:11px;padding:12px 14px;font-size:13px;color:#1a3d9e;margin-bottom:12px}
.opv textarea,.opv input[type=date]{width:100%;border:1px solid var(--o-line);border-radius:11px;padding:11px 12px;font-size:13.5px;font-family:inherit}
.opv .tl{list-style:none;margin:0;padding:0}
.opv .tl li{display:flex;gap:12px;padding:9px 0;font-size:13.5px;border-bottom:1px solid #f3f4f6}
.opv .tl li:last-child{border:0}
.opv .tl .d{flex:0 0 120px;color:var(--o-muted);font-size:12.5px}
`;
    document.head.appendChild(el);
    return '';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // BOUWSTENEN
  // ═════════════════════════════════════════════════════════════════════════
  const dots = (n, doel) => {
    let o = '';
    for (let i = 0; i < doel; i++) o += '<i class="' + (i < n ? 'on' : '') + '"></i>';
    return '<span class="dots">' + o + '</span>';
  };
  const skel = () => '<div class="empty">Bezig met laden…</div>';
  const fout = (msg, herstel) => '<div class="warn"><b>Kon dit niet laden.</b> ' + esc(msg) +
    ' <button class="obtn" style="margin-left:8px" onclick="' + herstel + '">Opnieuw proberen</button></div>';

  const REDEN_LABEL = {
    wil_nog_beslissen: ['Wil nog beslissen', 't-amber'],
    no_show_event: ['No-show event', 't-purple'],
    no_show_call: ['No-show call', 't-red'],
    afgemeld: ['Afgemeld', 't-grey'],
    niet_ingepland: ['Niet ingepland', 't-red'],
  };

  function taakKaart(t, dag) {
    const r = REDEN_LABEL[t.reden] || [t.reden, 't-grey'];
    const nuDag = vandaag();
    return '<div class="row"><div class="who">' +
      '<div class="nm">' + esc(t.naam) +
        ' <span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>' +
        (t.reden_code ? ' <span class="tag t-grey">' + esc(t.reden_code) + '</span>' : '') +
        (t.badge_label ? ' <span class="tag t-grey">' + esc(t.badge_label) + '</span>' : '') +
        (t.due < nuDag ? ' <span class="tag t-red">bleef liggen</span>' : '') +
        (t.due > nuDag ? ' <span class="tag t-blue">staat op ' + nl(t.due) + '</span>' : '') +
        ((t.uitgesteld_zonder_poging || 0) >= 2 ? ' <span class="tag t-amber">' + t.uitgesteld_zonder_poging + '&times; uitgesteld zonder poging</span>' : '') +
      '</div>' +
      '<div class="mt">' +
        (t.telefoon ? '<span style="color:#6b7280;font-size:12.5px">' + esc(t.telefoon) + '</span>' : '') +
        '<span class="pil ' + (t.bel_totaal ? 'aan' : 'uit') + '" title="belpogingen">&#9742; ' +
          (t.bel_totaal ? t.bel_totaal + '&times; op ' + t.bel_dagen + ' dag' + (t.bel_dagen === 1 ? '' : 'en') : 'nog niet gebeld') + '</span>' +
        '<span class="pil ' + (t.wa_totaal ? 'wa' : 'uit') + '" title="' + (t.wa_totaal ? 'WhatsApp verstuurd' : 'nog geen WhatsApp sinds hij in de lijst kwam') + '">&#128172; ' +
          (t.wa_totaal ? t.wa_totaal + '&times;' : 'geen WhatsApp') + '</span>' +
        '<span class="pil ' + (t.bel_vandaag ? 'aan' : 'uit') + '" title="doel is ' + DOEL_BELLEN + ' belpogingen per dag">vandaag ' + dots(t.bel_vandaag, DOEL_BELLEN) + '</span>' +
        (t.laatste_poging ? '<span style="color:#6b7280;font-size:12px">laatst ' + esc(nl(iso(t.laatste_poging))) + ' ' + uur(t.laatste_poging) + '</span>' : '') +
      '</div>' +
      (t.notitie ? '<div class="note">' + esc(t.notitie) + '</div>' : '') +
      '</div>' +
      '<div class="act">' +
        '<button class="obtn p" onclick="window.__opvBel(\'' + t.id + '\')">&#9742; Bellen</button>' +
        '<button class="obtn wa" onclick="window.__opvWa(\'' + t.id + '\')">&#128172; WhatsApp</button>' +
        '<button class="obtn" onclick="window.__opvWatNu(\'' + t.id + '\')">Wat nu? &rarr;</button>' +
      '</div></div>';
  }

  function weekbalk(dag) {
    const nu = vandaag();
    const d0 = new Date(nu + 'T12:00:00Z');
    const maandag = dagPlus(nu, -(((d0.getUTCDay() + 6) % 7)));
    let h = '<div class="wk">';
    ['Ma', 'Di', 'Wo', 'Do', 'Vr'].forEach((lbl, i) => {
      const d = dagPlus(maandag, i);
      const aan = d === dag;
      h += '<button class="wkd ' + (aan ? 'on' : '') + ' ' + (d === nu ? 'nu' : '') + ' ' + (d < nu ? 'oud' : '') + '"' +
        ' onclick="window.__opvDag(\'' + d + '\')">' +
        '<span class="l">' + lbl + ' ' + nl(d) + (d === nu ? ' · vandaag' : '') + '</span>' +
        '<span class="c">' + (aan && _live.taken.data ? _live.taken.data.taken.length : '·') + '<small> open</small></span></button>';
    });
    return h + '</div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · VANDAAG
  // ═════════════════════════════════════════════════════════════════════════
  function vandaagView() {
    stijl();
    const dag = _ui.dagView || vandaag();
    const st = _live.taken;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) queueMicrotask(() => fetchTaken(dag));

    let h = '<div class="opv">';
    h += '<div class="info"><b>Fase 1.</b> De takenlijst is live. De spraakberichten, het nabelvenster en de calls van vandaag ' +
      'volgen in fase 2 en 3, samen met de agendakoppeling en de WhatsApp-brug — die blokken staan hier bewust leeg ' +
      'in plaats van met cijfers die nog niet gemeten worden.</div>';
    h += weekbalk(dag);

    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>' + modalHtml();
    if (st.loading || !st.data) return h + skel() + '</div>' + modalHtml();

    const alles = st.data.taken || [];
    const r1 = alles.filter((t) => !t.later && !t.bel_vandaag && !t.wa_vandaag);
    const r2 = alles.filter((t) => t.later || t.bel_vandaag || t.wa_vandaag);
    const wacht = st.data.wacht || [];

    h += '<div class="ronde">Elke naam die je aanraakt verlaat deze lijst. Wil je er later vandaag nog eens achter, dan zakt hij naar de tweede ronde — zo wordt deze lijst alleen maar korter. <b>Wat je vandaag niet afwerkt, staat morgen vanzelf terug</b> met de melding "bleef liggen"; doorschuiven naar morgen hoef je niet te doen.</div>';
    h += r1.length ? r1.map((t) => taakKaart(t, dag)).join('')
      : '<div class="empty">Eerste ronde afgewerkt.' + (r2.length ? ' Wat overblijft staat in de tweede ronde.' : '') + '</div>';

    if (r2.length) {
      h += '<div class="sh"><div class="ic" style="background:#eef0f3">&#8635;</div><h3>Tweede ronde vandaag</h3><span class="n">' + r2.length + '</span></div>' +
        '<div class="ronde">Deze heb je vandaag al geprobeerd. Nog eens bellen mag; anders verplaats je ze naar een andere dag.</div>' +
        r2.map((t) => taakKaart(t, dag)).join('');
    }

    if (wacht.length) {
      h += '<div class="sh"><div class="ic" style="background:var(--o-accs)">&#128233;</div><h3>Wacht op inplanning</h3><span class="n">' + wacht.length + '</span></div>' +
        '<div class="ronde">Deze leads kregen de agenda doorgestuurd en kiezen zelf. Staat er na <b>48 uur</b> niets in de agenda, dan komt de naam terug in je takenlijst.</div>';
      h += wacht.map((w) => {
        const uren = w.agenda_doorgestuurd_at ? Math.floor((Date.now() - new Date(w.agenda_doorgestuurd_at)) / 36e5) : 0;
        const rest = Math.max(0, 48 - uren);
        return '<div class="row"><div class="who"><div class="nm">' + esc(w.naam) +
          ' <span class="tag ' + (rest ? 't-blue' : 't-red') + '">' + (rest ? 'nog ' + rest + 'u' : 'termijn voorbij') + '</span>' +
          (w.badge_label ? ' <span class="tag t-grey">' + esc(w.badge_label) + '</span>' : '') + '</div>' +
          '<div class="mt"><span style="color:#6b7280;font-size:12.5px">' + esc(w.telefoon || '') + ' &middot; agenda ' + uren + 'u geleden doorgestuurd</span></div></div>' +
          '<div class="act"><button class="obtn wa" onclick="window.__opvWa(\'' + w.id + '\')">&#128172; Herinneren</button>' +
          '<button class="obtn" onclick="window.__opvTerug(\'' + w.id + '\')">Terug in de lijst</button></div></div>';
      }).join('');
    }

    return h + '</div>' + modalHtml();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · DASHBOARD
  // ═════════════════════════════════════════════════════════════════════════
  function dashboardView() {
    stijl();
    const dag = vandaag();
    const st = _live.dash;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) queueMicrotask(() => fetchDash(dag));

    let h = '<div class="opv">';
    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>';
    if (st.loading || !st.data) return h + skel() + '</div>';

    const d = st.data.dekking, di = st.data.discipline, ip = st.data.inplanning;
    const rest = d.totaal - d.aangeraakt;

    h += '<div class="dhero"><div class="lbl">' + esc(nl(dag)) + '</div>' +
      '<div class="big">' + (rest ? rest + ' lead' + (rest > 1 ? 's' : '') + ' vandaag nog niet aangeraakt' : 'Iedereen is vandaag aangeraakt') + '</div>' +
      '<div class="sml">' + d.volledig + ' van ' + d.totaal + ' leads kregen de ' + d.doel + ' belpogingen die we afgesproken hebben.</div></div>';

    h += '<div class="sh"><div class="ic" style="background:var(--o-accs)">&#9737;</div><h3>Dekking van vandaag</h3></div><div class="grid">' +
      kpi('Twee keer gebeld', d.volledig + '/' + d.totaal, (d.aangeraakt - d.volledig) + ' pas één keer &middot; ' + rest + ' nog niet gebeld', d.volledig === d.totaal ? 'g' : d.volledig ? 'a' : 'r') +
      kpi('Zonder WhatsApp', d.zonder_whatsapp.length, d.zonder_whatsapp.length ? '<span class="bad">' + d.zonder_whatsapp.map((x) => esc(x.naam)).join(', ') + '</span>' : '<span class="ok">iedereen heeft een bericht gehad</span>', d.zonder_whatsapp.length ? 'a' : 'g') +
      '</div>';

    h += '<div class="cov">' + (d.per_lead.length ? d.per_lead.map((p) => {
      const ok = p.bel_vandaag >= d.doel && p.wa_totaal > 0;
      return '<div class="covr"><span class="nm2">' + esc(p.naam) + '</span>' +
        '<span class="pil ' + (p.bel_vandaag ? 'aan' : 'uit') + '">&#9742; ' + p.bel_vandaag + '/' + d.doel + ' ' + dots(p.bel_vandaag, d.doel) + '</span>' +
        '<span class="pil ' + (p.wa_totaal ? 'wa' : 'uit') + '">&#128172; ' + (p.wa_totaal ? p.wa_totaal + '&times;' : 'geen') + '</span>' +
        '<span class="st ' + (ok ? 'ok' : p.bel_vandaag ? 'laatc' : 'bad') + '">' + (ok ? 'volledig' : p.bel_vandaag ? 'niet af' : 'niets gedaan') + '</span></div>';
    }).join('') : '<div class="empty">Geen open taken vandaag.</div>') + '</div>';

    h += '<div class="sh"><div class="ic" style="background:var(--o-ambs)">&#9878;</div><h3>Discipline</h3></div><div class="grid">' +
      kpi('Aangeraakt', d.aangeraakt + '/' + d.totaal, 'taken met een poging vandaag', d.aangeraakt === d.totaal ? 'g' : 'a') +
      kpi('Uitgesteld zonder poging', di.uitgesteld_zonder_poging, di.uitgesteld_zonder_poging ? '<span class="bad">hier verdwijnt werk</span>' : '<span class="ok">geen</span>', di.uitgesteld_zonder_poging ? 'r' : 'g') +
      kpi('Bleef liggen', di.bleef_liggen, 'automatisch doorgerold', di.bleef_liggen ? 'a' : 'g') +
      kpi('Tweede ronde', di.tweede_ronde, 'vandaag nog eens proberen', 'b') +
      '</div>';

    h += '<div class="sh"><div class="ic" style="background:var(--o-purs)">&#128197;</div><h3>Inplanning</h3></div><div class="grid">' +
      kpi('Calls ingepland', ip.ingepland, 'vandaag geboekt', 'g') +
      kpi('Wacht op inplanning', ip.wacht, 'binnen de 48 uur', 'b') +
      kpi('Niet ingepland na 48u', ip.niet_ingepland, ip.niet_ingepland ? '<span class="bad">terug in de lijst</span>' : '<span class="ok">geen</span>', ip.niet_ingepland ? 'r' : 'g') +
      '</div>';

    h += '<div class="sh"><div class="ic" style="background:#eef0f3">&#128200;</div><h3>Deze week</h3></div><div class="card"><table>' +
      '<thead><tr><th>Dag</th><th>Belpogingen</th><th>WhatsApps</th><th>Ingepland</th></tr></thead><tbody>' +
      st.data.week.map((w) => '<tr><td>' + nl(w.dag) + (w.dag === dag ? ' <b>· vandaag</b>' : '') + '</td><td>' + w.belpogingen + '</td><td>' + w.whatsapps + '</td><td>' + w.ingepland + '</td></tr>').join('') +
      '</tbody></table></div>';

    if (st.data.gearchiveerd.length) {
      h += '<div class="sh"><div class="ic" style="background:var(--o-reds)">&#128269;</div><h3>Gearchiveerd vandaag — steekproef</h3></div><div class="card"><table>' +
        '<thead><tr><th>Naam</th><th>Reden</th><th>Moeite</th></tr></thead><tbody>' +
        st.data.gearchiveerd.map((a) => {
          const ok = a.bel_dagen >= ARCHIEF_MIN_DAGEN && a.wa_totaal >= ARCHIEF_MIN_WA;
          return '<tr><td><b>' + esc(a.naam) + '</b></td><td style="color:#6b7280">' + esc(a.archief_reden || '') + '</td>' +
            '<td>' + a.bel_totaal + '&times; gebeld op ' + a.bel_dagen + ' dag' + (a.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + a.wa_totaal + '&times; WhatsApp ' +
            (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    return h + '</div>';
  }
  const kpi = (k, v, s, kleur) => '<div class="kpi ' + (kleur || '') + '"><div class="k">' + k + ' &#9889;</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · AFGEROND
  // ═════════════════════════════════════════════════════════════════════════
  function afgerondView() {
    stijl();
    const st = _live.archief;
    if (!st.loading && !st.error && !st.data) queueMicrotask(fetchArchief);

    let h = '<div class="opv">';
    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>';
    if (st.loading || !st.data) return h + skel() + '</div>';
    if (!st.data.length) return h + '<div class="empty">Nog niets afgerond.</div></div>';

    h += '<div class="ronde">Klik op een naam om te zien hoe vaak er gebeld en geappt is voor die lead afgesloten werd.</div>' +
      '<div class="card"><table><thead><tr><th>Naam</th><th>Reden</th><th>Moeite</th><th>Afgerond</th></tr></thead><tbody>';
    h += st.data.map((a) => {
      const ok = a.bel_dagen >= ARCHIEF_MIN_DAGEN && a.wa_totaal >= ARCHIEF_MIN_WA;
      return '<tr style="cursor:pointer" onclick="window.__opvHist(\'' + a.id + '\')"><td><b>' + esc(a.naam) + '</b>' +
        '<div style="font-size:12.5px;color:#6b7280">' + esc(a.archief_reden || '') + '</div></td>' +
        '<td><span class="tag t-grey">' + esc((REDEN_LABEL[a.reden] || [a.reden])[0]) + '</span></td>' +
        '<td>' + a.bel_totaal + '&times; &#9742; op ' + a.bel_dagen + ' dag' + (a.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + a.wa_totaal + '&times; &#128172; ' +
        (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig</span>') + '</td>' +
        '<td style="color:#6b7280">' + esc(a.gearchiveerd_at ? nl(iso(a.gearchiveerd_at)) : '') + '</td></tr>';
    }).join('');
    return h + '</tbody></table></div></div>' + modalHtml();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // MODALS
  // ═════════════════════════════════════════════════════════════════════════
  function modalHtml() {
    const m = _ui.modal;
    if (!m) return '';
    const t = zoekTaak(m.taakId);
    if (!t) return '';
    let body = '';

    if (m.soort === 'watnu') {
      const gp = (t.bel_vandaag || 0) + (t.wa_vandaag || 0) > 0;
      body =
        (gp ? '' : '<div class="warn"><b>Nog geen poging vandaag.</b> Je moet niets doorschuiven — wat blijft liggen staat morgen vanzelf terug. Kies je toch een latere dag, dan telt dat als <b>uitgesteld zonder poging</b>.</div>') +
        opt('&#128197;', 'var(--o-grns)', 'Opnieuw inplannen', 'Kies samen een moment terwijl je hem aan de lijn hebt.', "window.__opvActie('inplannen')") +
        opt('&#128233;', 'var(--o-accs)', 'Agenda doorgestuurd', 'Hij plant zelf in. Na 48 uur zonder afspraak komt hij terug.', "window.__opvActie('agenda_gestuurd')") +
        opt('&#8595;', 'var(--o-ambs)', 'Later vandaag nog eens', 'Zakt naar de tweede ronde, blijft vandaag staan.', "window.__opvActie('later_vandaag')") +
        opt('&#9200;', 'var(--o-purs)', 'De lead vroeg een later moment', 'Alleen als hij zelf een datum noemde.', "window.__opvActie('kiesdag')") +
        opt('&#128451;', 'var(--o-reds)', 'Archiveren — geen nut meer', 'Alleen na echte moeite. Maxim ziet je historiek.', "window.__opvActie('archiveer')");
      return scrim('Wat nu met ' + esc(t.naam) + '?',
        (t.bel_totaal || 0) + '&times; gebeld op ' + (t.bel_dagen || 0) + ' dag' + (t.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + (t.wa_totaal || 0) + '&times; WhatsApp', body);
    }

    if (m.soort === 'kiesdag') {
      body = '<div style="font-size:12.5px;color:#6b7280;margin-bottom:8px">Morgen hoef je niet te kiezen — wat open blijft, staat er morgen vanzelf terug.</div>' +
        '<input type="date" id="opv-dt" value="' + dagPlus(vandaag(), 7) + '" min="' + dagPlus(vandaag(), 2) + '">' +
        '<button class="obtn p" style="width:100%;margin-top:14px" onclick="window.__opvVerplaats()">Verplaatsen</button>';
      return scrim('Wanneer komt ' + esc(t.naam) + ' terug?', 'Hij verdwijnt uit je lijst tot die dag.', body);
    }

    if (m.soort === 'archiveer') {
      const zwak = (t.bel_dagen || 0) < ARCHIEF_MIN_DAGEN || (t.wa_totaal || 0) < ARCHIEF_MIN_WA;
      body = (zwak ? '<div class="warn"><b>Even checken.</b> Je belde ' + (t.bel_totaal || 0) + ' keer op <b>' + (t.bel_dagen || 0) +
        ' verschillende dag' + (t.bel_dagen === 1 ? '' : 'en') + '</b> en stuurde ' + (t.wa_totaal || 0) + ' WhatsApp' + (t.wa_totaal === 1 ? '' : 's') +
        '. De afspraak is minstens <b>3 belpogingen op 3 verschillende dagen</b> én 1 WhatsApp. Twee keer bellen op dezelfde dag telt als één dag. Maxim ziet deze historiek.</div>' : '') +
        '<label style="display:block;font-size:12.5px;font-weight:650;margin:6px 0">Waarom archiveer je hem? (verplicht)</label>' +
        '<textarea id="opv-reden" rows="3" placeholder="bv. 5x gebeld, 2 WhatsApps, nooit reactie"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:14px;' + (zwak ? 'background:var(--o-amb);border-color:var(--o-amb)' : '') + '" onclick="window.__opvArchiveer()">' +
        (zwak ? 'Toch archiveren' : 'Archiveren') + '</button>';
      return scrim(esc(t.naam) + ' archiveren', 'Deze lead verdwijnt uit je takenlijst.', body);
    }

    if (m.soort === 'inplannen') {
      body = '<div class="info">De agendakoppeling komt in fase 2. Tot dan boek je de call zoals je nu doet, en zet je de lead hier op de dag van de afspraak.</div>' +
        '<input type="date" id="opv-dt" value="' + dagPlus(vandaag(), 1) + '">' +
        '<button class="obtn p" style="width:100%;margin-top:14px" onclick="window.__opvVerplaats()">Zet op deze dag</button>';
      return scrim('Call inplannen met ' + esc(t.naam), 'Fase 1 — nog zonder live agenda', body);
    }

    if (m.soort === 'historiek') {
      body = '<ul class="tl">' + ((t.pogingen || []).map((p) =>
        '<li><span class="d">' + nl(iso(p.tijdstip)) + ' ' + uur(p.tijdstip) + '</span><span>' +
        (p.soort === 'call' ? '&#9742;' : '&#128172;') + ' ' + esc(p.resultaat || p.soort) + ' ' +
        (p.automatisch ? '&#9889;' : '&#9995;') + '</span></li>').join('') ||
        '<li style="color:#6b7280">Geen enkele poging geregistreerd.</li>') + '</ul>';
      return scrim(esc(t.naam), (t.bel_totaal || 0) + ' belpogingen &middot; ' + (t.wa_totaal || 0) + ' WhatsApps', body);
    }
    return '';
  }
  const opt = (em, bg, titel, sub, actie) =>
    '<button class="opt" onclick="' + actie + '"><div class="em" style="background:' + bg + '">' + em + '</div>' +
    '<div><b>' + titel + '</b><span>' + sub + '</span></div></button>';
  const scrim = (titel, sub, body) =>
    '<div class="opv"><div class="scrim" onmousedown="if(event.target===this)window.__opvSluit()"><div class="modal">' +
    '<div class="mh"><div><h3>' + titel + '</h3><p>' + sub + '</p></div><button class="x" onclick="window.__opvSluit()">&times;</button></div>' +
    '<div class="mb">' + body + '</div></div></div></div>';

  function zoekTaak(id) {
    const d = _live.taken.data;
    if (d) {
      const t = (d.taken || []).find((x) => x.id === id) || (d.wacht || []).find((x) => x.id === id);
      if (t) return t;
    }
    if (_live.archief.data) return _live.archief.data.find((x) => x.id === id);
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═════════════════════════════════════════════════════════════════════════
  window.__opvDag = (d) => { _ui.dagView = d; _live.taken.data = null; _live.taken.key = null; render(); };
  window.__opvHerlaad = () => { _live.taken.error = null; _live.dash.error = null; _live.archief.error = null; leegTakenCache(); render(); };
  window.__opvSluit = () => { _ui.modal = null; render(); };
  window.__opvWatNu = (id) => { _ui.modal = { soort: 'watnu', taakId: id }; render(); };
  window.__opvHist = (id) => { _ui.modal = { soort: 'historiek', taakId: id }; render(); };

  window.__opvActie = async (welke) => {
    const m = _ui.modal; if (!m) return;
    if (welke === 'kiesdag' || welke === 'archiveer' || welke === 'inplannen') { _ui.modal = { soort: welke, taakId: m.taakId }; render(); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: welke });
      if (welke === 'agenda_gestuurd') {
        await post('/api/opvolging-poging', { taak_id: m.taakId, soort: 'agenda_doorgestuurd', resultaat: 'agenda doorgestuurd', automatisch: false });
      }
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvVerplaats = async () => {
    const m = _ui.modal; if (!m) return;
    const el = document.getElementById('opv-dt');
    const due = el && el.value;
    if (!due) { alert('Kies eerst een dag.'); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: 'verplaats', due });
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvArchiveer = async () => {
    const m = _ui.modal; if (!m) return;
    const el = document.getElementById('opv-reden');
    const reden = (el && el.value || '').trim();
    if (!reden) { alert('Vul eerst een reden in.'); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: 'archiveer', archief_reden: reden });
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvBel = async (id) => {
    const t = zoekTaak(id); if (!t) return;
    // De softphone opent het gesprek; de poging wordt hier vastgelegd zodat ze
    // meetelt. In fase 2 komt de koppeling met /api/softphone-call-log erbij.
    try {
      if (window.KLX && typeof window.KLX.call === 'function' && t.telefoon) window.KLX.call(t.telefoon);
      await post('/api/opvolging-poging', { taak_id: id, soort: 'call', resultaat: 'gebeld via de softphone', automatisch: false });
      leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvWa = async (id) => {
    const t = zoekTaak(id); if (!t || !t.telefoon) { alert('Geen telefoonnummer bekend.'); return; }
    try {
      window.open('https://wa.me/' + String(t.telefoon).replace(/[^0-9]/g, ''), '_blank', 'noopener');
      await post('/api/opvolging-poging', { taak_id: id, soort: 'whatsapp', resultaat: 'WhatsApp geopend', automatisch: false });
      leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvTerug = async (id) => {
    try {
      await post('/api/opvolging-taak-update', { taak_id: id, actie: 'verplaats', due: vandaag() });
      leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // REGISTREREN
  // ═════════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['opvolging/Vandaag'] = vandaagView;
  window.DFO.VIEWS['opvolging/Dashboard'] = dashboardView;
  window.DFO.VIEWS['opvolging/Afgerond'] = afgerondView;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('opvolging');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('opvolging');

  console.debug('[opvolging-v2] fase 1 — takenlijst, dekking en archief');
})();
