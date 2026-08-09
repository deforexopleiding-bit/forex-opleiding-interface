// modules/klanten-v2/views/events-v2.js
//
// Fase D module — Events (layout-only, voorbeeld-data).
// 1-op-1 render uit prototype:
//   - EVENTS mock                            r1391-1397
//   - VIEWS['events/Overzicht']              r4604-4646 (KPI + status-chips + table/cards)
//   - VIEWS['events/Inbox']                  r4648-4690 (chat-split met AI-suggestie 'Simone')
//   - VIEWS['events/Inschrijvingen']         r4692-4709 (koppel-per-inschrijving)
//   - VIEWS['events/Mentor-grootboek']       r4710-4739 (per-event + per-mentor)
//
// Bewuste vereenvoudiging: event-detail wrap (r4757 IIFE + viewEventDetail
// vanaf r4759) NIET meegenomen — Overzicht rendert flat. Dossier komt in
// data-ronde. Verder is de layout 1-op-1.
//
// Dormant — 'events' niet in V2_ACTIVE_ALLOWLIST. Preview ?v2preview=events.

(function () {
  if (!window.DFO) { console.error('[events-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[events-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur0 } = window.DFO;
  const H = window.KV_V2.helpers;

  const EVENTS = [
    { naam: 'Forex Masterclass Gent',    datum: '08-08-2026', tijd: '10:00', plek: 'Drongen (Gent)', aanm: 32, cap: 40, status: 'open' },
    { naam: 'Forex Masterclass Gent',    datum: '12-08-2026', tijd: '18:00', plek: 'Drongen (Gent)', aanm: 28, cap: 40, status: 'open' },
    { naam: 'Forex Masterclass Gent',    datum: '15-08-2026', tijd: '10:00', plek: 'Drongen (Gent)', aanm: 12, cap: 40, status: 'open' },
    { naam: 'Forex Masterclass Gent',    datum: '19-08-2026', tijd: '18:00', plek: 'Drongen (Gent)', aanm:  7, cap: 40, status: 'open' },
    { naam: 'Forex Masterclass Utrecht', datum: '22-08-2026', tijd: '10:00', plek: 'Utrecht',        aanm:  3, cap: 35, status: 'concept' },
  ];

  window.__evNotice = (label) => {
    console.info('[events-v2] ' + label + ' (voorbeeld — komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__evOpen = (i) => { console.info('[events-v2] openEvent idx=' + i + ' (voorbeeld — event-detail komt in data-ronde)'); };

  function overzichtView() {
    const st = F('st', 'published');
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'pink',    icon: I.cal,   label: 'Gepubliceerd',     val: '5',   sub: 'komende events' },
      { c: 'emerald', icon: I.users, label: 'Aanmeldingen',     val: '82', hi: 1, sub: 'over alle events', trend: H.trend('+18', true) },
      { c: 'blue',    icon: I.chart, label: 'Gem. bezetting',   val: '53%', sub: 'van capaciteit' },
      { c: 'amber',   icon: I.euro,  label: 'Kosten per event', val: eur0(680), sub: 'gemiddeld' },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Gepubliceerd', v: 'published', n: 5 },
        { l: 'Concept',      v: 'draft',     n: 1 },
        { l: 'Afgerond',     v: 'done',      n: 12 },
        { l: 'Geannuleerd',  v: 'cancel',    n: 0 },
        { l: 'Alles',        v: 'all',       n: 18 },
      ], st),
      `<select class="filter-sel"><option>Alle niveaus</option><option>Basis</option><option>Gevorderd</option></select>`,
      H.search('Zoek event…'),
      S.role === 'mentor'
        ? `<div class="tb-right"><span style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-3)">${svg(I.eye, 'width:14px;height:14px')}Alleen-lezen weergave</span></div>`
        : `<div class="tb-right"><button class="btn btn-ghost" onclick="__evNotice('Instellingen')">${svg(I.settings)}Instellingen</button>
            <button class="btn btn-primary" onclick="__evNotice('Nieuw event')">${svg(I.plus)}Nieuw event</button></div>`,
    ])}
    ${st === 'done'
      ? `<div class="pad"><div class="grid g2">
          ${[['Forex Masterclass Gent', '1 aug 2026', 14, 3, 2, 1, 1240, 680], ['Forex Masterclass Gent', '25 jul 2026', 18, 2, 1, 3, 1580, 720]]
            .map(([n, d, aa, ns, af, sa, om, ui]) => `<div class="card card-hover" style="cursor:pointer" onclick="__evNotice('Openen: ${n}')">
              <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span>
                <div><div class="card-title">${n}</div><div style="font-size:11.5px;color:var(--text-3)">${d}</div></div>
                ${H.pill('ok', 'Afgerond', 1)}</div>
              <div class="card-body">
                <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:14px">
                  ${H.pill('ok', aa + ' aanwezig')}${H.pill('warn', ns + ' no-show')}${H.pill('neutral', af + ' afgemeld')}${H.pill('violet', sa + ' verkocht')}</div>
                <div class="kv"><dt>Omzet uit event</dt><dd class="num">${eur0(om)}</dd></div>
                <div class="kv"><dt>Uitgaven</dt><dd class="num">− ${eur0(ui)}</dd></div>
                <div class="kv"><dt><b>Netto</b></dt><dd class="num" style="color:var(--emerald)"><b>${eur0(om - ui)}</b></dd></div>
              </div></div>`).join('')}
        </div></div>`
      : H.table(
          [{ l: 'Event' }, { l: 'Datum' }, { l: 'Locatie', cls: 'optional' }, { l: 'Niveau', cls: 'optional' }, { l: 'Capaciteit' }, { l: 'Status' }, { l: 'Sync', cls: 'optional' }, { l: '', cls: 'r' }],
          EVENTS.map(e => [
            `<span class="cell-main">${e.naam}</span>`,
            `<div><div class="mono" style="font-size:12.5px">${e.datum}</div><div class="cell-sub">${e.tijd}</div></div>`,
            `<span style="color:var(--text-2);font-size:12.5px">${e.plek}</span>`,
            H.pill('neutral', 'Basis'),
            `<div style="min-width:90px"><span class="pill pill-${e.aanm / e.cap > .8 ? 'danger' : e.aanm / e.cap > .5 ? 'warn' : 'ok'} nodot">${e.aanm}/${e.cap}</span>
              <div class="progress" style="margin-top:5px;max-width:80px"><i style="width:${e.aanm / e.cap * 100}%"></i></div></div>`,
            H.pill(e.status === 'open' ? 'ok' : 'neutral', e.status === 'open' ? 'Gepubliceerd' : 'Concept'),
            `<div style="display:flex;gap:4px">${H.pill('ok', 'Webflow', 1)}${H.pill('ok', 'GHL', 1)}</div>`,
            `<div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();__evNotice('Kopieer event')">${svg(I.copy || I.doc, 'width:14px;height:14px')}</button>
              <button class="btn btn-primary btn-sm" onclick="event.stopPropagation();__evNotice('Event openen')">Openen</button></div>`,
          ]),
          '__evOpen'
        )}`;
  }

  function inboxView() {
    // Simplified chat-split (ib-split classes gebruiken, ib-* al in CSS).
    return `${H.voorbeeldBanner()}
    <div class="ib-split">
      <div class="ib-list">
        <div class="ib-top">
          <div style="display:flex;gap:5px;margin-bottom:9px">
            <button class="chip on" style="font-size:11.5px;padding:3px 10px">WhatsApp <span class="cnt">3</span></button>
            <button class="chip" style="font-size:11.5px;padding:3px 10px" onclick="__evNotice('E-mail-tab')">E-mail <span class="cnt">1</span></button></div>
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}<input placeholder="Zoek gesprek…"></div>
        </div>
        ${['Miriam Osei', 'Kevin Braams', 'Sander Pieters'].map((n, i) => `<div class="ib-row ${i === 0 ? 'on' : ''}" onclick="__evNotice('Chat: ${n}')">
          ${H.av(n, 28)}
          <div class="ib-b">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
              <span style="font-size:13.5px;font-weight:${i === 0 ? '600' : '500'}">${n}</span>
              <span style="margin-left:auto;font-size:10.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${['1u', '6u', '1d'][i]}</span></div>
            <div class="ib-t">${['Is er nog plek op 12 augustus?', 'Kan ik mijn aanmelding verzetten?', 'Tot zaterdag!'][i]}</div>
            <div style="margin-top:7px">${H.pill('pink', 'Gent · ' + ['12', '8', '15'][i] + ' aug', 1)}</div>
          </div></div>`).join('')}
      </div>
      <div class="ib-detail">
        <div style="padding:16px 22px;background:var(--surface);border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:13px">
            ${H.av('Miriam Osei', 42)}
            <div style="flex:1"><div style="font-size:16px;font-weight:600">Miriam Osei</div>
              <div style="font-size:12.5px;color:var(--text-3)">Aangemeld voor Gent · 12 aug · vragenlijst open</div></div>
            <button class="btn btn-ghost btn-sm" onclick="__evNotice('Vragenlijst')">${svg(I.doc)}Vragenlijst</button>
            <button class="btn btn-ghost btn-sm" onclick="__evNotice('Koppel aanwezige')">${svg(I.users)}Koppel</button>
            <button class="btn btn-ghost btn-sm" onclick="__evNotice('Ander event')">${svg(I.repeat)}Ander event</button>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
          <div style="max-width:660px">
            <div style="padding:14px 18px;background:var(--surface-2);border-radius:14px 14px 14px 4px;font-size:14px;line-height:1.55;margin-bottom:20px">Is er nog plek op 12 augustus?</div>
            <div class="ai-sug">
              <div class="ai-sug-head"><span class="tile-ico" style="width:28px;height:28px;background:linear-gradient(140deg,var(--pink),#E879A9);color:#fff">${svg(I.sparkle, 'width:14px;height:14px')}</span>
                <div style="flex:1"><div style="font-size:13px;font-weight:600">Simone stelt voor</div>
                <div style="font-size:11.5px;color:var(--text-3)">Kent de bezetting en de vragenlijst-status</div></div></div>
              <div class="ai-sug-body">Hoi Miriam! Ja hoor, er is nog plek op 12 augustus — er zijn nu 28 van de 40 plekken bezet. Vul je even de korte vragenlijst in? Dan staat je plek definitief vast.</div>
              <div class="ai-sug-foot"><button class="btn btn-primary btn-sm" style="margin-left:auto;--m:var(--pink);--m-glow:rgba(179,43,114,.4)" onclick="__evNotice('AI gebruiken')">${svg(I.edit)}Gebruiken</button></div>
            </div>
          </div>
        </div>
        <div style="padding:13px 22px;background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" onclick="__evNotice('Template')">Template</button>
          <span style="margin-left:auto;font-size:11.5px;color:var(--emerald)">● 24u venster open</span>
          <button class="btn btn-primary btn-sm" onclick="__evNotice('Bericht verzenden')">${svg(I.send)}Verstuur</button>
        </div>
      </div>
    </div>`;
  }

  function inschrijvingenView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('m', [
        { l: 'Gekoppeld',         v: 'ok',   n: 24 },
        { l: 'Te doen',           v: 'todo', n: 5  },
        { l: 'Geen match',        v: 'no',   n: 3  },
        { l: 'Meerdere opties',   v: 'amb',  n: 2  },
        { l: 'Ongeldig',          v: 'inv',  n: 0  },
        { l: 'Alles',             v: 'all',  n: 34 },
      ], F('m', 'todo')),
      H.search('Zoek naam of e-mail…'),
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'Contact', cls: 'optional' }, { l: 'Opgegeven event' }, { l: 'Vragenlijst' }, { l: 'Ontvangen', cls: 'optional' }, { l: '', cls: 'r' }],
      [
        ['Kevin Braams',  'k.braams@gmail.com',  '"masterclass augustus"', 'nee', '3u', 'amb', 2],
        ['Ruben Maes',    'r.maes@telenet.be',   '"Gent"',                  'ja',  '5u', 'amb', 3],
        ['Lisa Vermeer',  'l.vermeer@live.nl',   '—',                       'nee', '1d', 'no',  0],
        ['Bilal Ait',     'b.ait@gmail.com',     '"12 aug avond"',          'ja',  '1d', 'ok',  1],
      ].map(([n, e, ev, vl, t, st, k]) => [
        `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
        `<span style="color:var(--text-3);font-size:12.5px">${e}</span>`,
        `<div>${st === 'ok'
          ? `<span class="cell-main">Gent · 12 aug 18:00</span>`
          : `<span style="color:var(--text-2)">${ev}</span><div class="cell-sub">${k} mogelijke events</div>`}</div>`,
        H.pill(vl === 'ja' ? 'ok' : 'warn', vl === 'ja' ? 'Ingevuld' : 'Open'),
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t}</span>`,
        st === 'ok'
          ? `<button class="btn btn-ghost btn-sm" onclick="__evNotice('Openen: ${n.replace(/'/g, "\\'")}')">Openen</button>`
          : `<button class="btn btn-primary btn-sm" onclick="__evNotice('Koppel aan event: ${n.replace(/'/g, "\\'")}')">Koppel aan event</button>`,
      ])
    )}`;
  }

  function mentorGrootboekView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro, label: 'Omzet uit events', val: eur0(24800), sub: 'dit kwartaal' },
      { c: 'violet',  icon: I.grad, label: 'Bonuspot',         val: eur0(4960),  hi: 1, sub: '20% van omzet' },
      { c: 'amber',   icon: I.box,  label: 'Uitgaven',         val: eur0(3400),  hi: 1, sub: 'zaal, catering, materiaal' },
      { c: 'emerald', icon: I.tick, label: 'Netto',            val: eur0(16440), hi: 1, sub: 'na bonus en kosten' },
    ])}
    <div class="pad">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span>
          <div class="card-title">Per event</div></div>
        ${H.table(
          [{ l: 'Event' }, { l: 'Datum', cls: 'optional' }, { l: 'Omzet', cls: 'r' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitgaven', cls: 'r' }, { l: 'Netto', cls: 'r' }, { l: 'Status' }],
          [['Gent · 1 aug', '01-08-2026', 12400, 2480, 680, 'uitbetaald'],
           ['Gent · 25 jul', '25-07-2026', 12400, 2480, 720, 'open']].map(([e, d, o, b, u, st]) => [
            `<span class="cell-main">${e}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
            `<span class="money">${eur0(o)}</span>`,
            `<span class="money">${eur0(b)}</span>`,
            `<span class="money">− ${eur0(u)}</span>`,
            `<span class="money" style="color:var(--emerald)">${eur0(o - b - u)}</span>`,
            H.pill(st === 'uitbetaald' ? 'ok' : 'warn', st),
          ])
        )}
      </div>
    </div>`;
  }

  window.DFO.VIEWS['events/Overzicht']       = overzichtView;
  window.DFO.VIEWS['events/Inbox']           = inboxView;
  window.DFO.VIEWS['events/Inschrijvingen']  = inschrijvingenView;
  window.DFO.VIEWS['events/Mentor-grootboek'] = mentorGrootboekView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('events');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('events');
  console.debug('[events-v2] registered 4 views (dormant)');
})();
