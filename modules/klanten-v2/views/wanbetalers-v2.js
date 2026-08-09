// modules/klanten-v2/views/wanbetalers-v2.js
//
// Fase H — Wanbetalers (LAYOUT-ONLY · VOORBEELD-DATA). 4 tabs:
// Gesprekken · Acties · Overzicht · Brieven. Prototype:
// systeemprototype-v45.html r2168-2266.
//
// KRITIEK: dit is een BESCHERMDE-ZONE-module. Alle data hieronder is
// hardcoded, geen fetches, geen imports uit finance/joost/dunning/
// arrangements/pending-actions/klx-softphone/api. Layout dient uitsluitend
// als voorbeeld — de echte data-koppeling gebeurt in een aparte fase met
// separate review.
//
// Dormant. Preview ?v2preview=wanbetalers (rol Sales/Manager/Admin/Super).

(function () {
  if (!window.DFO) { console.error('[wanbetalers-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[wanbetalers-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F, setF, S } = window.DFO;
  const H = window.KV_V2.helpers;

  // ── VOORBEELD-DATA (allemaal fictief, uit prototype r2050-2160 verzonnen) ──
  const GESPREKKEN = [
    { naam: 'Ebenezer Adjei',       tijd: '09:14', ongelezen: 2, open: 7199, kanaal: 'WhatsApp', prev: 'Ik stuur de betaling vandaag door', last_out_txt: 'Top! Bedankt' },
    { naam: 'Dyami Van Praag',      tijd: '08:32', ongelezen: 1, open: 3675, kanaal: 'WhatsApp', prev: 'Kunnen we een regeling maken?',   last_out_txt: 'Ja, we denken graag mee' },
    { naam: 'NazNaz Transport',     tijd: 'gisteren', open: 2500, kanaal: 'WhatsApp', prev: 'Bedankt, ik reageer morgen',                last_out_txt: '' },
    { naam: 'Michel Van Rijsewijk', tijd: '2 dagen',  open: 2400, kanaal: 'WhatsApp', prev: 'Ik zit even in het buitenland',             last_out_txt: 'Geen probleem' },
    { naam: 'Micha Schreuders',     tijd: '3 dagen',  open: 1500, kanaal: 'E-mail',   prev: 'Kunt u de factuur nogmaals sturen?',        last_out_txt: '' },
    { naam: 'Jennifer Botaka',      tijd: 'vorige week', open: 2000, kanaal: 'WhatsApp', prev: '(geen reactie)',                        last_out_txt: 'Herinnering — dag 7' },
  ];

  const ACTIES = [
    { klant: 'Dyami Van Praag',      type: 'Betaalregeling voorstellen', dagen: 12, bedrag: 3675, prio: 'hoog' },
    { klant: 'Ebenezer Adjei',       type: 'Betaal-toezegging',           dagen: 4,  bedrag: 7199, prio: 'hoog' },
    { klant: 'NazNaz Transport',     type: 'WIK-brief aanmaken',          dagen: 14, bedrag: 2500, prio: 'hoog' },
    { klant: 'Michel Van Rijsewijk', type: 'Escalatie naar incasso',      dagen: 21, bedrag: 2400, prio: 'midden' },
    { klant: 'Micha Schreuders',     type: 'Contact opnemen',             dagen: 6,  bedrag: 1500, prio: 'midden' },
    { klant: 'Percy Boateng',        type: 'Herinnering versturen',       dagen: 3,  bedrag: 2000, prio: 'laag' },
  ];

  const OVERZICHT = [
    ['Ebenezer Adjei',       7199.99, 1, '40 d', 'Aanmaning dag 7',  'Morgen 09:00',    'ok'],
    ['Dyami Van Praag',      3675,    3, '129 d','Herinnering 3',    'Vandaag 13:39',   'ok'],
    ['NazNaz Transport',     2500,    6, '149 d','Herinnering 3',    'Vandaag 13:39',   'ok'],
    ['Jennifer Botaka',      2000,    2, '95 d', 'In gesprek',       'Wachten op klant','chat'],
    ['Percy Boateng',        2000,    1, '18 d', 'Herinnering 1',    'Over 2 dagen',    'ok'],
    ['Michel Van Rijsewijk', 2400,    6, '148 d','Gepauzeerd',       'Handmatig',       'stuck'],
    ['Micha Schreuders',     1500,    5, '129 d','Gepauzeerd',       'Actie open',      'stuck'],
  ];

  const BRIEVEN = [
    ['Dyami Van Praag',      'Kerkstraat 12, 3811 Amersfoort',   3675, '04-08-2026', 'new'],
    ['NazNaz Transport',     'Havenweg 8, 3089 Rotterdam',       2500, '04-08-2026', 'new'],
    ['Jennifer Botaka',      'Lindelaan 44, 1102 Amsterdam',     2000, '03-08-2026', 'dl'],
    ['Percy Boateng',        'Molenstraat 3, 5611 Eindhoven',    2000, '03-08-2026', 'new'],
    ['Micha Schreuders',     'Weesperzijde 90, 1091 Amsterdam',  1500, '02-08-2026', 'dl'],
    ['Michel Van Rijsewijk', 'Kanaalweg 22, 3585 Utrecht',       2400, '30-07-2026', 'sent'],
  ];

  const eur  = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n);
  const eur0 = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);

  window.__wbxNotice = (l) => { console.info('[wanbetalers-v2] ' + l); try { alert(l + ' — komt in de data-ronde (aparte review vereist).'); } catch (_) {} };
  window.__wbxPickChat = (i) => { S.wbxChatSel = i; if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  window.__wbxToggleSel = (id) => {
    S.wbxSel = S.wbxSel || {};
    S.wbxSel[id] = !S.wbxSel[id];
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  };

  // ── VIEW: Gesprekken (chat-split, r2168-2214) ─────────────────────────
  function gesprekkenView() {
    const idx = Number.isInteger(S.wbxChatSel) ? S.wbxChatSel : 0;
    const c   = GESPREKKEN[idx] || GESPREKKEN[0];
    const firstName = String(c.naam || '').split(' ')[0];
    return `${H.voorbeeldBanner()}
      <div class="wbx-split">
        <div class="wbx-list">
          <div class="wbx-list-head">
            ${H.search('Zoek gesprek…')}
            <div class="wbx-list-chips">
              <button class="chip is-on">Actief <span class="wbx-row-unread" style="background:transparent;color:var(--brand);border:1px solid var(--brand)">6</span></button>
              <button class="chip">Ongelezen <span class="wbx-row-unread" style="background:transparent;color:var(--text-3);border:1px solid var(--line)">3</span></button>
              <button class="chip">Archief</button>
            </div>
          </div>
          ${GESPREKKEN.map((g, i) => `
            <div class="wbx-row ${idx === i ? 'is-sel' : ''}" onclick="__wbxPickChat(${i})">
              <div class="wbx-row-top">
                <div class="av av-sm">${H.av(g.naam)}</div>
                <span class="wbx-row-name">${g.naam}</span>
                <span class="wbx-row-time">${g.tijd}</span>
                ${g.ongelezen ? `<span class="wbx-row-unread">${g.ongelezen}</span>` : ''}
              </div>
              <div class="wbx-row-prev">${g.prev}</div>
              <div class="wbx-row-meta">
                ${H.pill('warn', eur0(g.open))}
                <span style="font-size:10.5px;color:var(--text-3)">${g.kanaal}</span>
              </div>
            </div>`).join('')}
        </div>
        <div class="wbx-chat">
          <div class="wbx-chat-head">
            <div class="av av-lg">${H.av(c.naam)}</div>
            <div style="flex:1;min-width:0">
              <div class="wbx-chat-head-name">${c.naam}</div>
              <div class="wbx-chat-head-sub">${eur(c.open)} openstaand · 2 facturen</div>
            </div>
            <button class="btn btn-sm" onclick="__wbxNotice('Afhandelen')">${svg(I.check)}Afhandelen</button>
            <button class="btn btn-sm" onclick="__wbxNotice('Actie toevoegen')">${svg(I.plus)}Actie</button>
          </div>
          <div class="wbx-banner">
            ${svg(I.clock || I.settings)}
            <span>Aanmaan-flow gepauzeerd — klant reageerde. Hervat automatisch over 2 dagen.</span>
          </div>
          <div class="wbx-msgs">
            <div class="wbx-msg-in">
              <div class="wbx-msg-meta">${H.pill('neutral', 'KLANT')} <span>WhatsApp · 4 aug 10:31</span></div>
              <div class="wbx-bubble-in">Prima ik ga nu sturen</div>
            </div>
            <div class="wbx-msg-out">
              <div class="wbx-msg-meta">${H.pill('info', 'WIJ')} <span>WhatsApp · 4 aug 10:35</span></div>
              <div class="wbx-bubble-out">Top! Bedankt en prettige dag nog ${firstName}!</div>
            </div>
            <div class="wbx-msg-in">
              <div class="wbx-msg-meta">${H.pill('neutral', 'KLANT')} <span>WhatsApp · vandaag 09:14</span></div>
              <div class="wbx-bubble-in">${c.prev}</div>
            </div>
          </div>
          <div class="wbx-compose">
            <div class="wbx-compose-box" onclick="__wbxNotice('Bericht schrijven')">Typ een bericht…</div>
            <div class="wbx-compose-acts">
              <button class="btn btn-sm" onclick="__wbxNotice('Bijlage')">Bijlage</button>
              <button class="btn btn-sm" onclick="__wbxNotice('Template kiezen')">Template</button>
              <button class="btn btn-sm" onclick="__wbxNotice('Snel antwoord')">Snel antwoord</button>
              <span class="wbx-compose-dot">● 24u venster open</span>
              <button class="btn btn-primary btn-sm" onclick="__wbxNotice('Verstuur bericht')">${svg(I.send)}Verstuur</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  // ── VIEW: Acties (KPI + toolbar + table + bulkbar, r2216-2235) ────────
  function actiesView() {
    const st = F('wbx-st', 'todo');
    const rows = st === 'todo' ? ACTIES : [];
    const sel = S.wbxSel || {};
    const n = Object.keys(sel).filter(k => sel[k]).length;
    const prioPill = (p) => H.pill(p === 'hoog' ? 'warn' : p === 'midden' ? 'info' : 'neutral', p[0].toUpperCase() + p.slice(1));
    return `${H.voorbeeldBanner()}
      ${H.kpis([
        { c: 'orange',  icon: I.warn,  label: 'Te doen',            val: String(ACTIES.length), hi: 1, sub: '3 langer dan 10 dagen' },
        { c: 'blue',    icon: I.euro,  label: 'Bedrag in acties',   val: eur0(ACTIES.reduce((a, r) => a + r.bedrag, 0)), sub: 'over 6 klanten' },
        { c: 'emerald', icon: I.check, label: 'Afgehandeld',        val: '12', hi: 1, sub: 'deze week', trend: H.trend('+4', true) },
      ])}
      ${H.toolbar([
        H.chips('wbx-st', [
          { l: 'Te doen',      v: 'todo' },
          { l: 'Later',        v: 'later' },
          { l: 'Afgehandeld',  v: 'done' },
        ], st),
        H.search('Zoek klant…'),
      ])}
      ${H.table(
        [{ l: '' }, { l: 'Klant' }, { l: 'Actie' }, { l: 'Open sinds', cls: 'r optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Prioriteit' }],
        rows.map((a, i) => [
          `<label class="checkbox ${sel['a' + i] ? 'checked' : ''}" onclick="event.stopPropagation();__wbxToggleSel('a${i}')"><span class="checkbox-mark">${svg(I.check)}</span></label>`,
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(a.klant)}</div><span class="cell-main">${a.klant}</span></div>`,
          a.type,
          `<span class="mono" style="font-size:12.5px;color:${a.dagen > 10 ? 'var(--orange, var(--warn))' : 'var(--text-3)'}">${a.dagen} dagen</span>`,
          `<span class="mono">${eur(a.bedrag)}</span>`,
          prioPill(a.prio),
        ])
      )}
      ${n ? `<div class="wbx-bulkbar">
        <b>${n} geselecteerd</b>
        <button class="btn btn-sm" onclick="__wbxNotice('Goedkeuren')">Goedkeuren</button>
        <button class="btn btn-sm" onclick="__wbxNotice('Afwijzen')">Afwijzen</button>
        <button class="btn btn-sm" onclick="__wbxNotice('Uitstellen')">Uitstellen</button>
        <button class="btn btn-sm" style="margin-left:auto" onclick="S.wbxSel={};DFO.render()">Wissen</button>
      </div>` : ''}`;
  }

  // ── VIEW: Overzicht (KPI + toolbar + table, r2237-2253) ───────────────
  function overzichtView() {
    const f = F('wbx-of', 'all');
    const rows = OVERZICHT.filter(([,,,,,,s]) =>
      f === 'all' ||
      (f === 'ok'    && s === 'ok') ||
      (f === 'chat'  && s === 'chat') ||
      (f === 'stuck' && s === 'stuck'));
    return `${H.voorbeeldBanner()}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,   label: 'Totaal open',     val: eur0(37500), hi: 1, sub: '58 klanten', trend: H.trend('+8%', false) },
        { c: 'emerald', icon: I.repeat, label: 'Loopt vanzelf',    val: '32', hi: 1, sub: 'volgende actie gepland' },
        { c: 'blue',    icon: I.mail,   label: 'In gesprek',       val: '21', hi: 1, sub: 'wachten op reactie' },
        { c: 'violet',  icon: I.warn,   label: 'Vastgelopen',      val: '10',        sub: 'vragen aandacht' },
      ])}
      ${H.toolbar([
        H.chips('wbx-of', [
          { l: 'Alles',       v: 'all' },
          { l: 'Loopt',       v: 'ok' },
          { l: 'In gesprek',  v: 'chat' },
          { l: 'Vastgelopen', v: 'stuck' },
        ], f),
        H.search('Zoek klant…'),
      ])}
      ${H.table(
        [{ l: 'Klant' }, { l: 'Open', cls: 'r' }, { l: 'Facturen', cls: 'r optional' }, { l: 'Oudste', cls: 'r optional' }, { l: 'Fase' }, { l: 'Volgende actie' }],
        rows.map(([n, o, fnr, d, fa, na, s]) => [
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(n)}</div><span class="cell-main">${n}</span></div>`,
          `<span class="mono" style="color:var(--warn,var(--orange))">${eur(o)}</span>`,
          `<span class="mono">${fnr}</span>`,
          `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
          H.pill(s === 'stuck' ? 'warn' : s === 'chat' ? 'info' : 'ok', fa),
          `<span style="color:var(--text-3);font-size:12.5px">${na}</span>`,
        ])
      )}`;
  }

  // ── VIEW: Brieven (toolbar + tabel met checkboxes, r2254-2266) ────────
  function brievenView() {
    const st = F('wbx-bs', 'new');
    const rows = BRIEVEN.filter(([,,,,s]) => s === st);
    const stPill = { new: ['info', 'Aangemaakt'], dl: ['warn', 'Gedownload'], sent: ['ok', 'Verstuurd'] };
    return `${H.voorbeeldBanner()}
      ${H.toolbar([
        H.chips('wbx-bs', [
          { l: 'Aangemaakt', v: 'new' },
          { l: 'Gedownload', v: 'dl' },
          { l: 'Verstuurd',  v: 'sent' },
        ], st),
        H.search('Zoek klant…'),
        `<div class="tb-right">
          <button class="btn" onclick="__wbxNotice('Print selectie')">${svg(I.download || I.doc)}Print selectie</button>
          <button class="btn btn-primary" onclick="__wbxNotice('Markeer verstuurd')">${svg(I.check)}Markeer verstuurd</button>
        </div>`,
      ])}
      ${H.table(
        [{ l: '' }, { l: 'Klant' }, { l: 'Adres', cls: 'optional' }, { l: 'Openstaand', cls: 'r' }, { l: 'Aangemaakt', cls: 'r optional' }, { l: 'Status' }],
        rows.map(([n, a, o, d, s], i) => [
          `<label class="checkbox ${(S.wbxSel || {})['b' + i] ? 'checked' : ''}" onclick="event.stopPropagation();__wbxToggleSel('b${i}')"><span class="checkbox-mark">${svg(I.check)}</span></label>`,
          `<div class="cell-main-wrap"><div class="av av-sm">${H.av(n)}</div><span class="cell-main">${n}</span></div>`,
          `<span style="color:var(--text-3);font-size:12.5px">${a}</span>`,
          `<span class="mono">${eur(o)}</span>`,
          `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
          H.pill(stPill[s][0], stPill[s][1]),
        ])
      )}`;
  }

  window.DFO.VIEWS['wanbetalers/Gesprekken'] = gesprekkenView;
  window.DFO.VIEWS['wanbetalers/Acties']     = actiesView;
  window.DFO.VIEWS['wanbetalers/Overzicht']  = overzichtView;
  window.DFO.VIEWS['wanbetalers/Brieven']    = brievenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('wanbetalers');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('wanbetalers');
  console.debug('[wanbetalers-v2] registered 4 views (dormant, LAYOUT-ONLY · VOORBEELD-DATA)');
})();
