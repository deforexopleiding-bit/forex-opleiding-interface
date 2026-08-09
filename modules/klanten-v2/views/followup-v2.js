// modules/klanten-v2/views/followup-v2.js
//
// Fase B — Follow-up-cockpit voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - FU / BUCKETS / OUTCOMES_CALL / BEZWAREN  r2804-2839
//   - VIEWS['followup/Werklijst']       r2844-2994  (split-pane + call-modal)
//   - VIEWS['followup/Event-bellijst']  r3005-3027
//   - VIEWS['followup/Opvolglijst']     r3029-3046
//   - VIEWS['followup/Retenties']       r3048-3067
//   - VIEWS['followup/Afspraken']       r3069-3095
//   - VIEWS['followup/Sluimerpot']      r3097-3112
//   - VIEWS['followup/Statistieken']    r3114-3151
//   - VIEWS['followup/Afgeboekt']       r3153-3166
//
// Non-ES-module. Consumeert helpers uit window.KV_V2.helpers.
//
// Registreert 8 views + module 'followup' in KV_V2_ADD.
// Call-modal (callbar) toont layout maar wizard-state (obj-chip / warm-slider /
// outcome-more panels) rendered wel; save-flow logt naar console.

(function () {
  if (!window.DFO) { console.error('[followup-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[followup-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, avc, ini, eur, eur0, render, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Voorbeeld-data (prototype r2804-2839) ────────────────────────── */
  const FU = [
    { id: 1, naam: 'Kevin Braams',        tel: '+31 6 55667788',  mail: 'k.braams@gmail.com',  bron: 'event',    hot: true,  bucket: 'telaat',  when: '2 d te laat',  pogingen: 2, status: 'terugbellen', traject: 'Masterclass 8 aug',       laatste: 'Voicemail ingesproken',   eigenaar: 'Joost',   warmte: 7, event: 'Forex Masterclass Gent · 8 aug' },
    { id: 2, naam: 'Miriam Osei',         tel: '+32 478 99 11 22', mail: 'm.osei@gmail.com',    bron: 'event',    hot: true,  bucket: 'telaat',  when: '1 d te laat',  pogingen: 1, status: 'terugbellen', traject: 'Masterclass 12 aug',      laatste: 'Geen gehoor',             eigenaar: 'Joost',   warmte: 8, event: 'Forex Masterclass Gent · 12 aug' },
    { id: 3, naam: 'Valentine Manisha',   tel: '+31 6 44112233',  mail: 'v.manisha@outlook.com', bron: 'retentie', hot: false, bucket: 'vandaag', when: 'vandaag 14:00', pogingen: 0, status: 'terugbellen', traject: 'Membership 12 mnd · loopt af', laatste: 'Afspraak gemaakt', eigenaar: 'Jeffrey', warmte: 5, event: null },
    { id: 4, naam: 'Sander Pieters',      tel: '+31 6 11223344',  mail: 's.pieters@live.nl',   bron: 'event',    hot: false, bucket: 'vandaag', when: 'vandaag 16:30', pogingen: 0, status: 'nieuw',       traject: '7-daagse',                laatste: 'Nog niet gebeld',         eigenaar: null,     warmte: 6, event: 'Forex Masterclass Gent · 15 aug' },
    { id: 5, naam: 'Ayla Demir',          tel: '+31 6 99887766',  mail: 'ayla.d@gmail.com',    bron: 'zoom',     hot: false, bucket: 'vandaag', when: 'Zoom 15:00',   pogingen: 0, status: 'zoom',        traject: 'Kennismaking',            laatste: 'Zoom ingepland',          eigenaar: 'Joost',   warmte: 9, event: null },
    { id: 6, naam: 'Tom Verheyen',        tel: '+32 495 11 22 33', mail: 'tom.v@telenet.be',    bron: 'event',    hot: false, bucket: 'week',    when: 'do 7 aug',     pogingen: 1, status: 'terugbellen', traject: '7-daagse',                laatste: 'Belt terug na vakantie',  eigenaar: 'Jeffrey', warmte: 4, event: null },
    { id: 7, naam: 'Karim Alian',         tel: '+31 6 77889900',  mail: 'karim@alian.nl',      bron: 'retentie', hot: false, bucket: 'week',    when: 'vr 8 aug',     pogingen: 0, status: 'terugbellen', traject: '1-op-1 6 mnd · gepauzeerd', laatste: 'Wil eerst nadenken',    eigenaar: 'Jeffrey', warmte: 3, event: null },
    { id: 8, naam: 'Fatima Zahra',        tel: '+31 6 44556677',  mail: 'f.zahra@gmail.com',   bron: 'event',    hot: false, bucket: 'later',   when: 'over 6 mnd',   pogingen: 3, status: 'gesluimerd',  traject: 'Masterclass',             laatste: 'Nu geen budget',          eigenaar: 'Joost',   warmte: 2, event: null },
  ];
  const BUCKETS = [['telaat', '⏰ Te laat', 'rose'], ['vandaag', '📅 Vandaag', 'amber'], ['week', 'Komende 7 dagen', 'blue'], ['later', '💤 Later', 'slate']];
  const OUTCOMES_CALL = [
    ['geen_gehoor', 'Geen gehoor', I.phone, 'slate'], ['voicemail', 'Voicemail', I.mail, 'slate'],
    ['terugbel', 'Terugbellen', I.clock, 'amber'], ['whatsapp', 'WhatsApp gestuurd', I.chat, 'emerald'],
    ['zoom', 'Zoom ingepland', I.cal, 'violet'], ['sale', 'Verkocht', I.tick, 'emerald'],
    ['geen_interesse', 'Geen interesse', I.x, 'rose'], ['foutief', 'Foutief nummer', I.alert, 'rose'],
    ['snooze', 'Later opnieuw', I.repeat, 'blue'],
  ];
  const BEZWAREN = ['Te duur', 'Geen tijd', 'Moet overleggen', 'Al bij andere partij', 'Wil eerst resultaten zien',
    'Twijfelt over online', 'Geen vertrouwen', 'Wil eerst zelf proberen', 'Slecht moment', 'Geen budget nu', 'Anders'];

  /* ── Module state ─────────────────────────────────────────────────── */
  let fuSel = 1, fuOutcome = null, fuBez = [], fuWarm = 0, callActive = false, fuFilter = 'all';
  const fuLead = () => FU.find(l => l.id === fuSel) || FU[0];

  /* ── Handler-stubs op window ──────────────────────────────────────── */
  window.__fuSel = (id) => { fuSel = id; fuOutcome = null; render(); };
  window.__fuFilter = (v) => { fuFilter = v; render(); };
  window.__fuOutcome = (v) => { fuOutcome = v; render(); };
  window.__fuWarm = (n) => { fuWarm = n; render(); };
  window.__fuToggleBez = (b) => { fuBez.includes(b) ? (fuBez = fuBez.filter(x => x !== b)) : fuBez.push(b); render(); };
  window.startCall = () => { callActive = true; render(); };
  window.endCall = () => { callActive = false; fuOutcome = 'geen_gehoor'; render(); };
  window.saveOutcome = () => {
    console.info('[followup-v2] saveOutcome:', { fuSel, fuOutcome, fuBez, fuWarm });
    const i = FU.findIndex(l => l.id === fuSel);
    fuOutcome = null; fuBez = []; fuWarm = 0;
    if (i < FU.length - 1) fuSel = FU[i + 1].id;
    render();
  };
  window.fuDdDo = (label) => { console.info('[followup-v2] dd-item: ' + label + ' (voorbeeld — geen actie)'); };
  window.__fuNotice = (label) => {
    console.info('[followup-v2] ' + label + ' (voorbeeld — modal/flow komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };

  /* ── VIEW 1: Werklijst (prototype r2844-2994) ─────────────────────── */
  function werklijstView() {
    const q = (F('q', '') || '').toLowerCase();
    const list = FU.filter(l =>
      (fuFilter === 'all' || (fuFilter === 'hot' && l.hot) || (fuFilter === 'mijn' && l.eigenaar === 'Joost') || (fuFilter === l.bron))
      && (!q || l.naam.toLowerCase().includes(q)));
    const c = fuLead();

    return `${H.voorbeeldBanner()}
    <div class="fu-split">
      <div class="fu-list">
        <div class="fu-list-top">
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
            <input placeholder="Zoek lead, telefoon of e-mail…" value="${(F('q','') || '').replace(/"/g, '&quot;')}"
              oninput="S.filters[DFO.key()+'::q']=this.value;DFO.render();this.focus();this.setSelectionRange(this.value.length,this.value.length)"></div>
          <div style="display:flex;gap:5px;margin-top:9px;flex-wrap:wrap">
            ${[['all', 'Alles'], ['hot', '🔥 Hot'], ['mijn', 'Mijn leads'], ['event', 'Event'], ['retentie', 'Retentie'], ['zoom', 'Zoom']]
              .map(([v, l]) => `<button class="chip ${fuFilter === v ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__fuFilter('${v}')">${l}</button>`).join('')}
          </div>
        </div>
        ${BUCKETS.map(([b, label, col]) => {
          const items = list.filter(l => l.bucket === b);
          if (!items.length) return '';
          return `<div class="fu-bucket"><span style="color:var(--${col})">${label}</span><span class="c">${items.length}</span></div>
          ${items.map(l => `<div class="fu-row ${fuSel === l.id ? 'on' : ''}" onclick="__fuSel(${l.id})">
            ${H.av(l.naam, 32)}
            <div class="fu-row-b">
              <div style="display:flex;align-items:baseline;gap:8px">
                <span class="fu-name">${l.hot ? '<span class="fu-hot">🔥 </span>' : ''}${l.naam}</span>
                <span class="fu-when" style="margin-left:auto;${b === 'telaat' ? 'color:var(--rose)' : ''}">${l.when}</span></div>
              <div class="fu-sub">${l.traject}</div>
              <div class="fu-tags">
                ${H.pill(l.bron === 'event' ? 'pink' : l.bron === 'retentie' ? 'violet' : 'teal', l.bron, 1)}
                ${l.pogingen ? `<span class="pill pill-neutral nodot" style="font-size:10.5px">${l.pogingen}× gebeld</span>` : ''}
                ${l.eigenaar ? `<span style="font-size:10.5px;color:var(--text-3)">${l.eigenaar}</span>` : `<span class="pill pill-warn nodot" style="font-size:10.5px">Geen eigenaar</span>`}
              </div>
            </div></div>`).join('')}`;
        }).join('') || `<div class="empty" style="padding:44px 20px"><div class="empty-t">Werklijst leeg 🎉</div></div>`}
      </div>

      <div class="fu-card">
        <div class="fu-card-scroll">
          <div class="fu-hero">
            <div class="fu-hero-top">
              <span class="avatar-lg" style="background:${avc(c.naam)}">${ini(c.naam)}</span>
              <div style="flex:1;min-width:0">
                <div class="dossier-name">${c.hot ? '🔥 ' : ''}${c.naam}</div>
                <div class="dossier-meta">
                  ${H.pill(c.bron === 'event' ? 'pink' : c.bron === 'retentie' ? 'violet' : 'teal', c.bron)}
                  <span>${c.mail}</span>
                  ${c.event ? `<span>${c.event}</span>` : ''}</div>
                <div class="dial">
                  <select class="filter-sel" style="font-size:12.5px">
                    <option>${c.tel.startsWith('+32') ? 'BE-lijn · +32 3 808 15 42' : 'NL-lijn · +31 85 580 36 26'}</option>
                    <option>Andere lijn…</option></select>
                  <span class="fu-num">${c.tel}</span>
                  <button class="btn-call" onclick="startCall()">${svg(I.phone, 'width:17px;height:17px')}Bel nu</button>
                  <button class="btn btn-ghost" onclick="console.info('[followup-v2] Uitkomst corrigeren (voorbeeld)')">${svg(I.refresh)}Uitkomst corrigeren</button>
                  <button class="btn btn-ghost" onclick="console.info('[followup-v2] Notitie (voorbeeld)')">${svg(I.edit)}Notitie</button>
                </div>
              </div>
            </div>
          </div>

          <div class="fu-info">
            ${[['Status', c.status], ['Pogingen', c.pogingen + '×'], ['Eigenaar', c.eigenaar || '—'],
               ['Laatste contact', c.laatste], ['Traject', c.traject], ['Warmte', c.warmte + '/10']]
              .map(([l, v]) => `<div class="fu-info-c"><div class="fu-info-l">${l}</div><div class="fu-info-v">${v}</div></div>`).join('')}
          </div>

          <div class="oc-panel">
            <div class="oc-head">
              <span class="tile-ico" style="width:28px;height:28px;background:var(--m-soft);color:var(--m)">${svg(I.check2, 'width:14px;height:14px')}</span>
              <div style="flex:1"><div style="font-size:13.5px;font-weight:600">Uitkomst vastleggen</div>
                <div style="font-size:11.5px;color:var(--text-3)">Kies wat er uit het gesprek kwam</div></div>
              ${fuOutcome ? H.pill('accent', OUTCOMES_CALL.find(o => o[0] === fuOutcome)[1]) : ''}
            </div>
            <div class="oc-grid">
              ${OUTCOMES_CALL.map(([v, l, ic, col]) => `<button class="oc-btn ${fuOutcome === v ? 'on' : ''}"
                style="--oc:var(--${col});--oc-soft:var(--${col}-soft)" onclick="__fuOutcome('${v}')">
                <span class="i">${svg(ic)}</span>${l}</button>`).join('')}
            </div>
            ${fuOutcome ? `
            <div class="oc-more">
              <div class="oc-lbl">Warmte — hoe kansrijk is deze lead?</div>
              <div class="warm">${[1,2,3,4,5,6,7,8,9,10].map(n => `<i class="${n <= (fuWarm || c.warmte) ? 'on' : ''}"
                style="--warmc:${n <= 3 ? 'var(--rose)' : n <= 6 ? 'var(--amber)' : 'var(--emerald)'}" onclick="__fuWarm(${n})"></i>`).join('')}</div>
              <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-3);margin-top:5px">
                <span>Koud</span><span style="font-weight:600;color:var(--text-2);font-family:'IBM Plex Mono',monospace">${fuWarm || c.warmte}/10</span><span>Heet</span></div>
            </div>
            <div class="oc-more">
              <div class="oc-lbl">Bezwaren gehoord</div>
              <div style="display:flex;gap:6px;flex-wrap:wrap">
                ${BEZWAREN.map(b => `<button class="obj-chip ${fuBez.includes(b) ? 'on' : ''}" onclick="__fuToggleBez('${b.replace(/'/g, "\\'")}')">${b}</button>`).join('')}</div>
            </div>
            ${['terugbel', 'snooze', 'zoom'].includes(fuOutcome) ? `
            <div class="oc-more">
              <div class="oc-lbl">Volgende afspraak</div>
              <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
                <input class="inp" type="date" style="max-width:170px" value="2026-08-08">
                <input class="inp" type="time" style="max-width:120px" value="10:00">
                ${fuOutcome === 'snooze' ? `<select class="inp" style="max-width:160px"><option>Over 6 maanden</option><option>Over 12 maanden</option><option>Over 30 dagen</option></select>` : ''}
                <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:var(--text-2)">
                  <div class="checkbox on">${svg(I.tick)}</div>Markeer als hot</label>
              </div>
            </div>` : ''}
            <div class="oc-more">
              <div class="oc-lbl">Notitie</div>
              <textarea class="inp" placeholder="Wat is er besproken?" style="min-height:70px"></textarea>
            </div>
            <div style="padding:13px 16px;border-top:1px solid var(--border);display:flex;gap:8px;background:var(--surface-2)">
              <button class="btn btn-ghost" onclick="__fuOutcome(null)">Annuleren</button>
              <button class="btn btn-primary" style="margin-left:auto" onclick="saveOutcome()">${svg(I.tick)}Opslaan en volgende</button>
            </div>` : ''}
          </div>

          <div class="fu-tl">
            <div class="card">
              <div class="card-head"><span class="tile-ico" style="background:var(--m-soft);color:var(--m)">${svg(I.clock)}</span>
                <div class="card-title">Contactgeschiedenis</div>
                <span class="pill pill-neutral nodot" style="margin-left:auto">${c.pogingen + 2} momenten</span></div>
              <div class="card-body"><div class="timeline">
                <div class="tl-item hi"><div class="tl-when">Vandaag 09:14</div><div class="tl-what">${c.laatste}</div></div>
                <div class="tl-item"><div class="tl-when">4 aug 15:22</div><div class="tl-what">WhatsApp verstuurd — geen reactie</div></div>
                <div class="tl-item"><div class="tl-when">2 aug 11:05</div><div class="tl-what">Aangemeld via ${c.bron === 'event' ? 'event' : 'website'}</div></div>
              </div></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    ${callActive ? `<div class="callbar">
      <div class="callbar-top"><span class="pulse"></span>
        <div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:600">${c.naam}</div>
          <div style="font-size:11.5px;opacity:.7">In gesprek · <span class="mono">01:24</span></div></div>
        ${H.av(c.naam, 30)}</div>
      <div class="callbar-acts">
        <button class="cb-btn" title="Dempen">${svg('<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v4"/>')}</button>
        <button class="cb-btn" title="Toetsen">${svg('<circle cx="6" cy="6" r="1"/><circle cx="12" cy="6" r="1"/><circle cx="18" cy="6" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18" cy="12" r="1"/><circle cx="12" cy="18" r="1"/>')}</button>
        <button class="cb-btn end" onclick="endCall()" title="Ophangen">${svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2 4.1 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.8.7a2 2 0 0 1 1.7 2z"/><path d="M2 2l20 20" stroke-width="2.4"/>')}</button>
      </div></div>` : ''}`;
  }

  /* ── VIEW 2: Event-bellijst (prototype r3005-3027) ────────────────── */
  function eventBellijstView() {
    const rows = FU.filter(l => l.bron === 'event');
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      `<select class="filter-sel" style="min-width:280px"><option>Forex Masterclass Gent — za 8 aug 10:00</option>
        <option>Forex Masterclass Gent — wo 12 aug 18:00</option><option>Forex Masterclass Gent — za 15 aug 10:00</option></select>`,
      H.chips('st', [{ l: 'Alle', v: 'all', n: 8 }, { l: 'Nog niet gebeld', v: 'nb', n: 3 }, { l: 'Bevestigd', v: 'b', n: 4 }, { l: 'Komt niet', v: 'kn', n: 1 }], F('st', 'all')),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__fuNotice('Vernieuwen')">${svg(I.refresh)}Vernieuwen</button>
        <button class="btn btn-primary" onclick="DFO.goTab('Werklijst')">${svg(I.phone)}Start belronde</button></div>`,
    ])}
    ${H.kpis([
      { c: 'pink',    icon: I.cal,   label: 'Aangemeld',           val: '8',   sub: 'voor dit event' },
      { c: 'emerald', icon: I.tick,  label: 'Gebeld',              val: '5',   hi: 1, sub: 'van 8 deelnemers' },
      { c: 'amber',   icon: I.phone, label: 'Nog te bellen',       val: '3',   hi: 1, sub: 'pak deze op' },
      { c: 'blue',    icon: I.doc,   label: 'Vragenlijst ingevuld', val: '7/8',       sub: '1 open' },
    ])}
    ${H.table(
      [{ l: 'Deelnemer' }, { l: 'Telefoon', cls: 'optional' }, { l: 'Vragenlijst' }, { l: 'Belstatus' }, { l: 'Laatste poging', cls: 'optional' }, { l: '', cls: 'r' }],
      rows.concat(rows.slice(0, 2)).map((l, i) => [
        `<div class="row-avatar">${H.av(l.naam, 28)}<div><div class="cell-main">${l.naam}</div><div class="cell-sub">${l.mail}</div></div></div>`,
        `<span class="mono" style="font-size:12.5px">${l.tel}</span>`,
        H.pill(i % 4 === 3 ? 'warn' : 'ok', i % 4 === 3 ? 'Open' : 'Ingevuld'),
        H.pill(i < 3 ? 'ok' : i === 3 ? 'warn' : 'neutral', i < 3 ? 'Bevestigd' : i === 3 ? 'Geen gehoor' : 'Nog niet gebeld'),
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${i < 4 ? '5 aug 14:2' + i : '—'}</span>`,
        `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();DFO.goTab('Werklijst')">${svg(I.phone)}Bel nu</button>`,
      ])
    )}`;
  }

  /* ── VIEW 3: Opvolglijst (prototype r3029-3046) ───────────────────── */
  function opvolglijstView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('br', [{ l: 'Alles', v: 'all', n: 12 }, { l: 'Event no-show', v: 'en', n: 5 }, { l: 'Zoom no-show', v: 'zn', n: 3 },
        { l: 'Zoom verzet', v: 'zv', n: 3 }, { l: 'Zoom geannuleerd', v: 'zg', n: 1 }], F('br', 'all')),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__fuNotice('Vernieuwen')">${svg(I.refresh)}Vernieuwen</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'Herkomst' }, { l: 'Event / afspraak', cls: 'optional' }, { l: 'Sinds', cls: 'optional' }, { l: 'Status' }, { l: '', cls: 'r' }],
      [['Jeroen Wilders', 'Event no-show', 'Masterclass Gent · 1 aug', '5 d', 'open', 'pink'],
       ['Sanne de Boer',  'Zoom no-show',  'Kennismaking · 3 aug',   '3 d', 'open', 'teal'],
       ['Bilal Ait',      'Zoom verzet',   'Kennismaking · 4 aug',   '2 d', 'wacht', 'amber'],
       ['Ruben Maes',     'Event no-show', 'Masterclass Gent · 1 aug', '5 d', 'niet bereikt', 'pink'],
       ['Lisa Vermeer',   'Zoom geannuleerd', 'Kennismaking · 2 aug', '4 d', 'open', 'rose']]
        .map(([n, h, e, s, st, c]) => [
          `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
          H.pill(c, h),
          `<span style="color:var(--text-2);font-size:12.5px">${e}</span>`,
          `<span class="mono" style="color:var(--text-3);font-size:12.5px">${s}</span>`,
          H.pill(st === 'open' ? 'accent' : st === 'wacht' ? 'warn' : 'neutral', st),
          `<div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-primary btn-sm">${svg(I.phone)}Bel</button>
            <button class="icon-btn" title="Afschrijven" onclick="event.stopPropagation();fuDdDo('Afschrijven')">${svg(I.trash)}</button></div>`,
        ])
    )}`;
  }

  /* ── VIEW 4: Retenties (prototype r3048-3067) ─────────────────────── */
  function retentiesView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.repeat, label: 'Verlopen abonnementen', val: '23',        hi: 1, sub: 'sinds januari 2026' },
      { c: 'amber',   icon: I.phone,  label: 'Nog niet opgepakt',     val: '11',        hi: 1, sub: 'pak deze eerst' },
      { c: 'emerald', icon: I.tick,   label: 'Heraangesloten',        val: '7',         hi: 1, sub: 'dit kwartaal', trend: H.trend('30%', true) },
      { c: 'rose',    icon: I.euro,   label: 'MRR verloren',          val: eur0(4820),  hi: 1, sub: 'niet heraangesloten' },
    ])}
    ${H.toolbar([H.chips('st', [{ l: 'Alle', v: 'all', n: 23 }, { l: 'Nieuw', v: 'n', n: 11 }, { l: 'Opgepakt', v: 'o', n: 5 }, { l: 'Afgehandeld', v: 'a', n: 7 }], F('st', 'n')),
      H.search('Zoek klant…')])}
    ${H.table(
      [{ l: 'Klant' }, { l: 'Laatste abonnement' }, { l: 'Afgelopen op', cls: 'optional' }, { l: 'Was MRR', cls: 'r' }, { l: 'Status' }, { l: '', cls: 'r' }],
      [['Mari Israiljan',   '12 maand 1-op-1',      '12-04-2026', 600, 'nieuw'],
       ['Dennis Kroon',     '12 maand membership',  '28-03-2026',  80, 'nieuw'],
       ['Wesley Bruin',     '6 maand 1-op-1',       '15-02-2026', 658, 'opgepakt'],
       ['Anouk Timmer',     '36 maand membership',  '03-01-2026',  65, 'afgehandeld']]
        .map(([n, p, d, m, st]) => [
          `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
          p,
          `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
          `<span class="money">${eur(m)}</span>`,
          H.pill(st === 'nieuw' ? 'accent' : st === 'opgepakt' ? 'warn' : 'ok', st[0].toUpperCase() + st.slice(1)),
          st === 'nieuw'
            ? `<button class="btn btn-primary btn-sm">${svg(I.plus)}Oppakken</button>`
            : `<button class="btn btn-ghost btn-sm">Openen</button>`,
        ])
    )}`;
  }

  /* ── VIEW 5: Afspraken (prototype r3069-3095) ─────────────────────── */
  function afsprakenView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('t', [{ l: 'Alles', v: 'all', n: 9 }, { l: '📹 Zoom', v: 'z', n: 4 }, { l: '📞 Terugbel', v: 't', n: 3 }, { l: '💤 Wacht', v: 'w', n: 1 }, { l: '✓ Afgehandeld', v: 'a', n: 1 }], F('t', 'all')),
      `<label style="display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--text-2)">
        <div class="checkbox on">${svg(I.tick)}</div>Alleen mijn afspraken</label>`,
      `<div class="tb-right"><button class="btn btn-primary" onclick="__fuNotice('Afspraak plannen')">${svg(I.plus)}Afspraak plannen</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Tijd' }, { l: 'Type' }, { l: 'Met' }, { l: 'Onderwerp', cls: 'optional' }, { l: 'Eigenaar', cls: 'optional' }, { l: '', cls: 'r' }],
      [['Vandaag 14:00', 'terugbel', 'Valentine Manisha', 'Membership verlengen',  'Jeffrey'],
       ['Vandaag 15:00', 'zoom',     'Ayla Demir',        'Kennismaking',           'Joost'],
       ['Vandaag 16:30', 'terugbel', 'Sander Pieters',    '7-daagse opvolging',     'Joost'],
       ['Morgen 10:00',  'zoom',     'Bilal Ait',         'Kennismaking (verzet)',  'Joost'],
       ['Morgen 13:00',  'terugbel', 'Tom Verheyen',      'Na vakantie',            'Jeffrey']]
        .map(([t, ty, m, o, e]) => [
          `<span class="mono" style="font-weight:500">${t}</span>`,
          H.pill(ty === 'zoom' ? 'violet' : 'amber', ty === 'zoom' ? '📹 Zoom' : '📞 Terugbel', 1),
          `<div class="row-avatar">${H.av(m, 26)}<span class="cell-main">${m}</span></div>`,
          `<span style="color:var(--text-2)">${o}</span>`, e,
          `<div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-primary btn-sm">${svg(I.phone)}Bel</button>
            <button class="icon-btn" title="Meer" onclick="event.stopPropagation();fuDdDo('Afspraak-menu')">${svg(I.dots)}</button></div>`,
        ])
    )}`;
  }

  /* ── VIEW 6: Sluimerpot (prototype r3097-3112) ────────────────────── */
  function sluimerpotView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([H.chips('b', [{ l: 'Alles', v: 'all', n: 18 }, { l: 'Retentie', v: 'r', n: 11 }, { l: 'Event', v: 'e', n: 7 }], F('b', 'all')), H.search('Zoek…')])}
    <div class="pad">
      ${[['Binnenkort terug — binnen 30 dagen', 3, 'amber'], ['Over ongeveer 6 maanden', 9, 'blue'], ['Over ongeveer 12 maanden', 6, 'slate']]
        .map(([g, n, c]) => `<div class="card" style="margin-bottom:14px">
        <div class="card-head"><span class="tile-ico" style="background:var(--${c}-soft);color:var(--${c})">${svg(I.clock)}</span>
          <div class="card-title">${g}</div><span class="pill pill-neutral nodot" style="margin-left:auto">${n}</span></div>
        <div class="card-list">
          ${FU.filter(l => l.bucket === 'later').concat(FU.slice(0, 2)).slice(0, Math.min(n, 3)).map(l => `<div class="cl-row">
            ${H.av(l.naam, 30)}<div style="flex:1"><div class="cell-main">${l.naam}</div>
            <div class="cell-sub">${l.laatste} · ${l.traject}</div></div>
            <span class="mono" style="font-size:12px;color:var(--text-3)">${l.when}</span>
            <button class="btn btn-ghost btn-sm">Nu oppakken</button></div>`).join('')}
        </div></div>`).join('')}
    </div>`;
  }

  /* ── VIEW 7: Statistieken (prototype r3114-3151) ──────────────────── */
  function statistiekenView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([H.chips('p', [{ l: 'Vandaag', v: 'd' }, { l: 'Deze week', v: 'w' }, { l: 'Deze maand', v: 'm' }], F('p', 'w'))])}
    ${H.kpis([
      { c: 'blue',    icon: I.phone, label: 'Gebeld',           val: '147', sub: 'deze week', trend: H.trend('+22', true) },
      { c: 'emerald', icon: I.tick,  label: 'Bereikt',          val: '89',  hi: 1, sub: '61% van gebeld', trend: H.trend('+6%', true) },
      { c: 'violet',  icon: I.doc,   label: 'Offerte gestart',  val: '23',  hi: 1, sub: '26% van bereikt' },
      { c: 'pink',    icon: I.cal,   label: 'Zoom ingepland',   val: '14',  hi: 1, sub: '16% van bereikt' },
      { c: 'amber',   icon: I.euro,  label: 'Gewonnen',         val: '6',   hi: 1, sub: eur0(28400) + ' waarde', trend: H.trend('+2', true) },
    ])}
    <div class="pad">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.users)}</span>
          <div class="card-title">Per medewerker</div></div>
        ${H.table(
          [{ l: 'Medewerker' }, { l: 'Gebeld', cls: 'r' }, { l: 'Bereikt', cls: 'r' }, { l: 'Bereik-%', cls: 'r' }, { l: 'Offertes', cls: 'r' }, { l: 'Zoom', cls: 'r' }, { l: 'Gewonnen', cls: 'r' }, { l: 'Conversie', cls: 'r' }],
          [['Joost Berg',      82, 54, '66%', 14, 9, 4, '7,4%', 'ok'],
           ['Jeffrey Biemold', 65, 35, '54%',  9, 5, 2, '5,7%', 'warn']]
            .map(([n, g, b, bp, o, z, w, c, cl]) => [
              `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n.split(' ')[0]}</span></div>`,
              `<span class="mono">${g}</span>`, `<span class="mono">${b}</span>`,
              `<span class="pill pill-${cl} nodot">${bp}</span>`, `<span class="mono">${o}</span>`,
              `<span class="mono">${z}</span>`, `<span class="mono">${w}</span>`,
              `<span class="pill pill-${cl} nodot">${c}</span>`,
            ])
        )}
      </div>
      <div class="card" style="margin-top:14px">
        <div class="card-head"><span class="tile-ico" style="background:var(--rose-soft);color:var(--rose)">${svg(I.alert)}</span>
          <div class="card-title">Meest gehoorde bezwaren</div></div>
        <div class="card-list">
          ${[['Te duur', 34, 'rose'], ['Moet overleggen', 22, 'amber'], ['Geen tijd', 18, 'amber'],
             ['Wil eerst resultaten zien', 14, 'blue'], ['Slecht moment', 9, 'slate']]
            .map(([b, n, c]) => `<div class="cl-row"><div style="flex:1"><div class="cell-main">${b}</div>
              <div class="progress" style="max-width:260px;margin-top:5px"><i style="width:${n * 2.5}%;background:var(--${c})"></i></div></div>
              <span class="mono" style="font-size:13px">${n}×</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  /* ── VIEW 8: Afgeboekt (prototype r3153-3166) ─────────────────────── */
  function afgeboektView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('r', [{ l: 'Alles', v: 'all', n: 31 }, { l: 'No-show', v: 'ns', n: 9 }, { l: 'Geannuleerd', v: 'ga', n: 6 },
        { l: 'Geen interesse', v: 'gi', n: 12 }, { l: 'Onbereikbaar', v: 'ob', n: 4 }], F('r', 'all')),
      H.search('Zoek…'),
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'Reden' }, { l: 'Bron', cls: 'optional' }, { l: 'Afgeboekt op', cls: 'optional' }, { l: 'Pogingen', cls: 'r optional' }, { l: '', cls: 'r' }],
      [['Peter Vos',       'Geen interesse', 'Event',    '02-08-2026', 3],
       ['Nadia El Amrani', 'Onbereikbaar',   'Retentie', '01-08-2026', 4],
       ['Marco Dijk',      'No-show',        'Event',    '30-07-2026', 2],
       ['Sylvia Brandt',   'Geannuleerd',    'Zoom',     '28-07-2026', 1]]
        .map(([n, r, b, d, p]) => [
          `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
          H.pill(r === 'Geen interesse' ? 'rose' : r === 'Onbereikbaar' ? 'slate' : 'amber', r),
          H.pill('neutral', b),
          `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
          `<span class="mono">${p}×</span>`,
          `<button class="btn btn-ghost btn-sm">${svg(I.refresh)}Opnieuw</button>`,
        ])
    )}`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['followup/Werklijst']       = werklijstView;
  window.DFO.VIEWS['followup/Event-bellijst']  = eventBellijstView;
  window.DFO.VIEWS['followup/Opvolglijst']     = opvolglijstView;
  window.DFO.VIEWS['followup/Retenties']       = retentiesView;
  window.DFO.VIEWS['followup/Afspraken']       = afsprakenView;
  window.DFO.VIEWS['followup/Sluimerpot']      = sluimerpotView;
  window.DFO.VIEWS['followup/Statistieken']    = statistiekenView;
  window.DFO.VIEWS['followup/Afgeboekt']       = afgeboektView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('followup');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('followup');
  }

  console.debug('[followup-v2] registered 8 follow-up views');
})();
