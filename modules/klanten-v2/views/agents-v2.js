// modules/klanten-v2/views/agents-v2.js
//
// Fase F — AI Agents (layout-only, voorbeeld-data).
// 1-op-1 uit prototype:
//   - VIEWS['agents/Overzicht']    r6324-6368 (agent-cards + stats)
//   - VIEWS['agents/Configuratie'] r6369-6470 (rijke config-per-agent; VEREENVOUDIGD)
//   - VIEWS['agents/Kennisbank']   r6472-6500
//   - VIEWS['agents/Prestaties']   r6502-6540 (KPI + tabel)
//
// Bewuste vereenvoudiging: Configuratie is in het prototype een complex
// per-agent config-scherm (Persona/Fases/Kennisbank/Follow-ups/Stopwoorden/
// Oefengesprek voor Lisa, plus Gedrag/Autonomie/Beslissingen/Oefengesprek
// generic). Voor layout-preview toont deze tab een compacte agent-picker
// + 4 config-tabs met placeholder-secties. Volledige config-editor komt
// in data-ronde.
//
// Dormant. Preview ?v2preview=agents (rol Super admin/Manager).

(function () {
  if (!window.DFO) { console.error('[agents-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[agents-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, render } = window.DFO;
  const H = window.KV_V2.helpers;

  const AGENTS = [
    { id: 'joost',  n: 'Joost',    rol: 'Wanbetalers-assistent', c: 'amber',    ic: I.alert,   ver: 'v3.1', live: true,  lock: true,  kan: ['Antwoorden', 'Regelingen', 'Escalaties'], venster: '08–20u',        stats: [['147', '24u'], ['84%', 'akkoord'], ['3', 'wacht']] },
    { id: 'simone', n: 'Simone',   rol: 'Events-assistent',      c: 'pink',     ic: I.cal,     ver: 'v1.4', live: true,  lock: false, kan: ['Antwoorden', 'Vragenlijst herinneren'], venster: '08–20u',    stats: [['62', '24u'], ['78%', 'akkoord'], ['2', 'wacht']] },
    { id: 'mila',   n: 'Mila',     rol: 'Onboarding-assistent',  c: 'emerald',  ic: I.route,   ver: 'v0.9', live: true,  lock: false, kan: ['Antwoorden', 'Uploadlink sturen'],       venster: '09–18u',    stats: [['38', '24u'], ['82%', 'akkoord'], ['1', 'wacht']] },
    { id: 'lisa',   n: 'Lisa',     rol: 'Instagram-agent',       c: 'violet',   ic: I.bot,     ver: 'v16',  live: true,  lock: false, kan: ['DM beantwoorden'],                        venster: '24/7',      stats: [['24', '24u'], ['91%', 'akkoord'], ['0', 'wacht']] },
    { id: 'amigo',  n: 'Amigo',    rol: 'Achtergrond',           c: 'blue',     ic: I.sparkle, ver: 'v0.7', live: false, lock: false, kan: [],                                          venster: '',           stats: [['—', 'inactief']] },
    { id: 'ricardo', n: 'Ricardo', rol: 'Achtergrond',           c: 'slate',    ic: I.chart,   ver: 'v0.3', live: false, lock: false, kan: [],                                          venster: '',           stats: [['—', 'inactief']] },
  ];

  window.__agNotice = (l) => { console.info('[agents-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };
  window.__agSetSel = (id) => { agSel = id; render(); };
  window.__agSetCfgTab = (t) => { agCfgTab = t; render(); };
  let agSel = 'joost', agCfgTab = 'Gedrag';

  function overzichtView() {
    const gesprek = AGENTS.filter(a => a.rol !== 'Achtergrond');
    const achter = AGENTS.filter(a => a.rol === 'Achtergrond');
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.bot,   label: 'Actieve agents',           val: '8',  sub: 'van 9 ingericht' },
      { c: 'emerald', icon: I.chat,  label: 'Gesprekken vandaag',       val: '86', hi: 1, sub: 'over alle agents', trend: H.trend('+14', true) },
      { c: 'amber',   icon: I.users, label: 'Overgenomen door mens',    val: '11', hi: 1, sub: '13% van gesprekken' },
      { c: 'rose',    icon: I.alert, label: 'Wacht op jou',             val: '4',  hi: 1, sub: 'buiten hun mandaat' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Gespreksagents</div>
      <div class="grid g3" style="margin-bottom:20px">
        ${gesprek.map(a => `<div class="card card-hover" style="cursor:pointer" onclick="__agSetSel('${a.id}');DFO.goTab('Configuratie')">
          <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
            <span style="width:38px;height:38px;border-radius:50%;flex-shrink:0;background:radial-gradient(circle at 32% 30%,color-mix(in srgb,var(--${a.c}) 45%,white),var(--${a.c}) 72%);box-shadow:0 2px 10px -2px var(--${a.c})"></span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                <span class="card-title">${a.n}</span>
                ${a.lock ? `<span class="pill pill-warn nodot" style="font-size:10.5px">Beschermd</span>` : ''}
                <span class="mono" style="font-size:10.5px;color:var(--text-3);margin-left:auto">${a.ver}</span></div>
              <div style="font-size:11.5px;color:var(--${a.c});font-weight:500;margin-top:2px">${a.rol}</div>
            </div>
          </div>
          <div style="padding:0 17px 13px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
            ${a.live ? H.pill('ok', 'Live') : H.pill('neutral', 'Uit')}
            ${a.kan.map(k => H.pill('neutral', k, 1)).join('')}
            <span style="font-size:11px;color:var(--text-3);margin-left:auto">${a.venster}</span></div>
          <div style="display:grid;grid-template-columns:repeat(${a.stats.length},1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
            ${a.stats.map(([v, l]) => `<div style="background:var(--surface);padding:10px 12px;text-align:center">
              <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.03em">${v}</div>
              <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">${l}</div></div>`).join('')}
          </div></div>`).join('')}
      </div>
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Op de achtergrond</div>
      <div class="grid g3">
        ${achter.map(a => `<div class="card" style="opacity:.6">
          <div class="card-body" style="padding:15px 17px">
            <div style="display:flex;align-items:flex-start;gap:11px">
              <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(a.ic)}</span>
              <div style="flex:1"><div class="card-title">${a.n}</div>
                <div style="font-size:12px;color:var(--text-3);margin-top:3px">${a.rol}</div></div>
              <button class="chip" style="font-size:11px;padding:2px 8px" onclick="__agNotice('Activeer ${a.n}')">Uit</button>
            </div>
          </div></div>`).join('')}
      </div>
    </div>`;
  }

  function configuratieView() {
    const a = AGENTS.find(x => x.id === agSel) || AGENTS[0];
    const isLisa = a.id === 'lisa';
    const subs = isLisa
      ? ['Persona', 'Fases', "Do's en don'ts", 'Kennisbank', 'Follow-ups', 'Stopwoorden', 'Instellingen', 'Oefengesprek']
      : ['Gedrag', 'Autonomie', 'Beslissingen', 'Oefengesprek'];
    if (!subs.includes(agCfgTab)) agCfgTab = subs[0];

    return `${H.voorbeeldBanner()}
    <div style="padding:13px 20px;background:var(--${a.c}-soft);border-bottom:1px solid var(--${a.c}-line);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <span style="width:32px;height:32px;border-radius:50%;flex-shrink:0;background:radial-gradient(circle at 32% 30%,color-mix(in srgb,var(--${a.c}) 45%,white),var(--${a.c}) 72%)"></span>
      <div style="flex:1;min-width:150px">
        <div style="font-size:14px;font-weight:600">${a.n} <span style="font-weight:400;color:var(--text-3)">· ${a.rol}</span></div>
        <div style="font-size:12px;color:var(--text-3)">${a.venster || 'niet actief'} · configuratie ${a.ver}</div></div>
      ${a.lock ? `<span class="pill pill-warn nodot" style="font-size:10.5px">Beschermd — wijzigen in ${a.rol.split('-')[0]}</span>` : ''}
      <select class="filter-sel" onchange="__agSetSel(this.value)">
        ${AGENTS.filter(x => x.rol !== 'Achtergrond').map(x => `<option value="${x.id}" ${x.id === agSel ? 'selected' : ''}>${x.n}</option>`).join('')}</select>
    </div>
    ${a.lock ? `<div style="padding:13px 20px;background:var(--amber-soft);border-bottom:1px solid var(--amber-line);display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--amber)">
      ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}
      <span><b>Beschermde agent.</b> ${a.n} is met zorg ingericht en werkt. Je kunt hier alles bekijken, maar wijzigen gebeurt in de bron-module. Zo blijft er niets per ongeluk stuk.</span></div>` : ''}
    <div class="toolbar" style="padding-bottom:0;border-bottom:none">
      ${subs.map(t => `<button class="chip ${agCfgTab === t ? 'on' : ''}" onclick="__agSetCfgTab('${t.replace(/'/g, "\\'")}')">${t}</button>`).join('')}
    </div>
    <div style="padding:24px;max-width:820px;color:var(--text-3);font-size:13.5px;line-height:1.6">
      <p>Config-sectie <b>${agCfgTab}</b> voor <b>${a.n}</b> — volledige editor met velden, previews en publiceer-flow komt in de data-ronde. Prototype-refs:
      ${isLisa ? '<code>lisaConfigView2()</code> + <code>cfgSectie()</code> r6386-6440' : '<code>agConfigGeneriek()</code> + <code>agGedrag/agAutonomie/agBeslissingen</code> r6455-6470'}.</p>
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn btn-primary" onclick="__agNotice('Publiceren ${a.n}')">${svg(I.tick)}Publiceren</button>
        <button class="btn btn-ghost" onclick="__agNotice('Alle versies')">${svg(I.clock)}Alle versies</button>
      </div>
    </div>`;
  }

  function kennisbankView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('src', [{ l: 'Alle bronnen', v: 'all', n: 24 }, { l: 'PDF', v: 'pdf' }, { l: 'Notities', v: 'note' }, { l: 'FAQ', v: 'faq' }], F('src', 'all')),
      H.search('Zoek in kennisbank…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__agNotice('Bron toevoegen')">${svg(I.plus)}Bron toevoegen</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Bron' }, { l: 'Type', cls: 'optional' }, { l: 'Gebruikt door' }, { l: 'Laatst bijgewerkt', cls: 'r optional' }],
      [
        ['Aanmaanproces & mandaat',           'pdf',  ['Joost'],           '3 aug'],
        ['Product-lijst met prijzen',         'faq',  ['Joost', 'Simone', 'Mila', 'Lisa'], '1 aug'],
        ['Bezwaren en beantwoording',         'note', ['Joost', 'Simone', 'Lisa'], '28 jul'],
        ['Onboarding-stappen + tijdlijnen',   'faq',  ['Mila'],            '15 jul'],
        ['Instagram-tone-of-voice',           'note', ['Lisa'],            '10 jul'],
      ].map(([n, t, ag, d]) => [
        `<span class="cell-main">${n}</span>`,
        H.pill(t === 'pdf' ? 'accent' : t === 'faq' ? 'ok' : 'neutral', t.toUpperCase(), 1),
        `<div style="display:flex;gap:4px;flex-wrap:wrap">${ag.map(a => H.pill('neutral', a, 1)).join('')}</div>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
      ])
    )}
    <div style="padding:14px 20px;font-size:12.5px;color:var(--text-3);line-height:1.6;max-width:760px">
      De kennisbank voedt alle agents. Elke bron is per agent aan of uit te zetten in de <b>Configuratie</b>-tab. Volledige upload-flow + per-agent-filters komen in de data-ronde.</div>`;
  }

  function prestatiesView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.tick,  label: 'Akkoord-ratio',        val: '84%', hi: 1, sub: 'gemiddeld',           trend: H.trend('+6%', true) },
      { c: 'blue',    icon: I.chat,  label: 'Gesprekken totaal',    val: '271', sub: 'laatste 7 dagen' },
      { c: 'amber',   icon: I.users, label: 'Overgenomen',          val: '38',  hi: 1, sub: '14% van totaal' },
      { c: 'rose',    icon: I.alert, label: 'Escalaties',           val: '9',   hi: 1, sub: 'buiten mandaat' },
    ])}
    ${H.toolbar([
      H.chips('p', [{ l: 'Deze week', v: 'w' }, { l: 'Deze maand', v: 'm' }, { l: 'Kwartaal', v: 'q' }], F('p', 'w')),
    ])}
    ${H.table(
      [{ l: 'Agent' }, { l: 'Gesprekken', cls: 'r' }, { l: 'Akkoord', cls: 'r' }, { l: 'Overgenomen', cls: 'r optional' }, { l: 'Gem. antwoord', cls: 'r optional' }, { l: 'Escalaties', cls: 'r' }],
      [
        ['Joost',  '147', '84%', '11', '18s', '3'],
        ['Simone', '62',  '78%', '14', '22s', '2'],
        ['Mila',   '38',  '82%', '9',  '25s', '1'],
        ['Lisa',   '24',  '91%', '4',  '31s', '3'],
      ].map(([n, g, ak, ov, ga, es]) => [
        `<span class="cell-main">${n}</span>`,
        `<span class="mono">${g}</span>`,
        `<span class="pill pill-${parseInt(ak) >= 85 ? 'ok' : parseInt(ak) >= 75 ? 'warn' : 'danger'} nodot">${ak}</span>`,
        `<span class="mono">${ov}</span>`,
        `<span class="mono">${ga}</span>`,
        `<span class="mono" style="${parseInt(es) > 2 ? 'color:var(--rose)' : ''}">${es}</span>`,
      ])
    )}`;
  }

  window.DFO.VIEWS['agents/Overzicht']    = overzichtView;
  window.DFO.VIEWS['agents/Configuratie'] = configuratieView;
  window.DFO.VIEWS['agents/Kennisbank']   = kennisbankView;
  window.DFO.VIEWS['agents/Prestaties']   = prestatiesView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('agents');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('agents');
  console.debug('[agents-v2] registered 4 views (dormant)');
})();
