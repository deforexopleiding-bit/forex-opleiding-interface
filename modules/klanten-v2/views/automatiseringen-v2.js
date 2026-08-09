// modules/klanten-v2/views/automatiseringen-v2.js
//
// Fase F — Automatiseringen (layout-only, voorbeeld-data).
// 1-op-1 uit prototype:
//   - MOTOREN + CRONS mock  r5025-5072
//   - VIEWS['automatiseringen/Overzicht']  r5074-5172 (motor-cards + crons + schakelaars)
//
// Bewuste vereenvoudiging: de 5 sub-tabs Events/Onboarding/Leadsonderhoud/
// Wanbetalers/Lisa uit MODS zijn NIET expliciet gedefinieerd in het prototype
// — daar rendert automatiseringen/<motor> per-motor rules-lijstjes. Voor
// deze layout-preview tonen de 5 sub-tabs een explanatory placeholder die
// verwijst naar de motor-cards op Overzicht + de vervolg-data-ronde.
//
// Dormant. Preview ?v2preview=automatiseringen (rol Manager).

(function () {
  if (!window.DFO) { console.error('[automatiseringen-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[automatiseringen-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  const MOTOREN = [
    { id: 'events',          n: 'Events',          d: 'Aanmelding, vragenlijst, herinneringen en opvolging', ic: I.cal,     c: 'pink',    actief: 6, runs: 142, fouten: 0, lock: false },
    { id: 'onboarding',      n: 'Onboarding',      d: 'Welkom, wizard-herinneringen en startdatum',            ic: I.route,   c: 'emerald', actief: 4, runs:  38, fouten: 0, lock: false },
    { id: 'leadsonderhoud',  n: 'Leadsonderhoud',  d: 'Opvolgtrajecten voor leads die nog niet klaar zijn',   ic: I.repeat,  c: 'teal',    actief: 4, runs:  87, fouten: 1, lock: false },
    { id: 'wanbetalers',     n: 'Wanbetalers',     d: 'Aanmaanstappen, wachttijden en beltaken',              ic: I.alert,   c: 'amber',   actief: 3, runs: 216, fouten: 0, lock: true  },
    { id: 'lisa',            n: 'Lisa — opvolging', d: 'Berichten aan volgers die niet reageren',              ic: I.bot,     c: 'violet',  actief: 3, runs:  24, fouten: 0, lock: false },
    { id: 'joost',           n: 'Joost & Simone',  d: 'Wanneer de assistenten zelf mogen handelen',            ic: I.sparkle, c: 'blue',    actief: 2, runs:  61, fouten: 0, lock: false },
  ];
  const CRONS = [
    ['Aanmaan-motor',              'Elk uur',           'ok',    '09:00',   'Wanbetalers'],
    ['Aanmaan-herinneringen',      'Elke 15 min',       'ok',    '13:15',   'Wanbetalers'],
    ['Bulk versturen',             'Elke 3 min',        'ok',    '13:24',   'Wanbetalers'],
    ['Event-automatiseringen',     'Elke minuut',       'ok',    '13:26',   'Events'],
    ['Onboarding-automatiseringen', 'Elke minuut',       'ok',    '13:26',   'Onboarding'],
    ['Leadsonderhoud',             'Elke minuut',       'warn',  '13:26',   'Leadsonderhoud'],
    ['Lisa-berichten',             'Elke minuut',       'ok',    '13:26',   'Lisa'],
    ['E-mail ophalen',             'Elke 5 min',        'ok',    '13:25',   'E-mail'],
    ['Teamleader synchroniseren',  'Elk uur',           'ok',    '13:00',   'Finance'],
    ['Bank ophalen',               'Elke 15 min',       'ok',    '13:15',   'Finance'],
    ['Meta Ads synchroniseren',    'Elke 30 min',       'ok',    '13:00',   'Meta Ads'],
    ['Belronde events',            'Dagelijks 07:00',   'ok',    '07:00',   'Events'],
    ['No-show detectie',           'Dagelijks 06:00',   'ok',    '06:00',   'Mentoren'],
    ['Uitbetalingen genereren',    '1e vrijdag 06:00',  'ok',    '1 aug',   'Mentoren'],
  ];
  const SCHAKELAARS = [
    ['Joost mag zelf antwoorden',          'Wanbetalers · reactief',      true,  'amber'],
    ['Joost mag regelingen voorstellen',    'tot € 1.500',                 true,  'amber'],
    ['Joost stuurt zelf aanmaningen',       'uitgezet na incident',        false, 'amber'],
    ['Simone mag zelf antwoorden',          'Events · reactief',           true,  'pink'],
    ['Lisa is live',                        'Instagram-gesprekken',        true,  'violet'],
    ['Leadsonderhoud actief',               'opvolgtrajecten',              true,  'teal'],
    ['Onboarding-herinneringen',            'dagelijks 09:00',              false, 'emerald'],
    ['Incasso automatisch',                  'dagelijks 09:15',              false, 'rose'],
  ];

  window.__autNotice = (l) => { console.info('[automatiseringen-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };
  window.__autGoTab = (t) => { try { goTab(t); } catch (_) {} };

  function overzichtView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.repeat, label: 'Actieve automatiseringen', val: '22',  sub: 'over 6 motoren' },
      { c: 'emerald', icon: I.send,   label: 'Verstuurd vandaag',        val: '568', hi: 1, sub: 'berichten en taken', trend: H.trend('+12%', true) },
      { c: 'amber',   icon: I.alert,  label: 'Fouten',                   val: '1',   hi: 1, sub: 'Leadsonderhoud' },
      { c: 'violet',  icon: I.clock,  label: 'Lopende reeksen',          val: '147', sub: 'wachten op volgende stap' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Motoren</div>
      <div class="grid g3">
        ${MOTOREN.map(m => `<div class="card card-hover" style="cursor:pointer" onclick="__autGoTab('${m.n.split(' ')[0]}')">
          <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
            <span class="tile-ico" style="background:var(--${m.c}-soft);color:var(--${m.c})">${svg(m.ic)}</span>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                <span class="card-title">${m.n}</span>
                ${m.lock ? `<span class="pill pill-warn nodot" style="font-size:10.5px;padding:1.5px 7px">${svg(I.shield || I.alert, 'width:10px;height:10px')}Beschermd</span>` : ''}</div>
              <div style="font-size:12px;color:var(--text-3);margin-top:3px;line-height:1.45">${m.d}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
            ${[[m.actief, 'ACTIEF'], [m.runs, 'RUNS 24U'], [m.fouten, 'FOUTEN']].map(([v, l], i) => `<div style="background:var(--surface);padding:10px 12px;text-align:center">
              <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.03em;${l === 'FOUTEN' && v ? 'color:var(--rose)' : ''}">${v}</div>
              <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">${l}</div></div>`).join('')}
          </div></div>`).join('')}
      </div>

      <div class="grid g2" style="margin-top:18px">
        <div class="card">
          <div class="card-head"><span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.clock)}</span>
            <div class="card-title">Achtergrondtaken</div>
            <span class="pill pill-ok nodot" style="margin-left:auto">13 van 14 gezond</span></div>
          <div style="max-height:330px;overflow-y:auto">
            ${CRONS.map(([n, f, st, l, mod]) => `<div style="display:flex;align-items:center;gap:12px;padding:11px 16px;border-bottom:1px solid var(--border);font-size:13px">
              <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--${st === 'ok' ? 'emerald' : 'amber'})"></span>
              <div style="flex:1;min-width:0"><div style="font-weight:500">${n}</div>
                <div style="font-size:11.5px;color:var(--text-3)">${f} · ${mod}</div></div>
              <span class="mono" style="font-size:11.5px;color:var(--text-3)">${l}</span></div>`).join('')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.sliders)}</span>
            <div class="card-title">Schakelaars</div>
            <span style="font-size:11.5px;color:var(--text-3);margin-left:auto">Alles op één plek</span></div>
          <div class="card-body" style="padding:4px 0">
            ${SCHAKELAARS.map(([n, s, on, c]) => `<div style="display:flex;align-items:center;gap:12px;padding:11px 17px;border-bottom:1px solid var(--border)">
              <span class="legend-dot" style="background:var(--${c})"></span>
              <div style="flex:1"><div style="font-size:13px;font-weight:500">${n}</div>
                <div style="font-size:11.5px;color:var(--text-3)">${s}</div></div>
              <button class="chip ${on ? 'on' : ''}" style="font-size:11px;padding:2px 8px" onclick="__autNotice('Toggle: ' + '${n.replace(/'/g, "\\'")}')">${on ? 'Aan' : 'Uit'}</button></div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  // Per-motor sub-tab: placeholder met verwijzing naar Overzicht + prototype-refs.
  const perMotorView = (motorNaam) => () => `${H.voorbeeldBanner()}
    <div style="padding:32px 24px;max-width:640px">
      <h2 style="font-size:18px;margin-bottom:12px">${motorNaam} — automatiseringen</h2>
      <p style="color:var(--text-3);font-size:13.5px;line-height:1.6">Deze tab toont in de data-ronde de reeksen (triggers/stappen/wachten/berichten) voor de <b>${motorNaam}</b>-motor. Voor de layout-review: zie de motor-card op <a href="#" onclick="event.preventDefault();__autGoTab('Overzicht')" style="color:var(--m)">Overzicht</a> voor de stats en beschermde-status. Motor-rules + editable-wizard komen in de data-ronde uit het prototype (r5074+).</p>
      <button class="btn btn-primary" style="margin-top:14px" onclick="__autNotice('${motorNaam} regels bekijken')">${svg(I.eye)}Regels bekijken</button>
    </div>`;

  window.DFO.VIEWS['automatiseringen/Overzicht']       = overzichtView;
  window.DFO.VIEWS['automatiseringen/Events']          = perMotorView('Events');
  window.DFO.VIEWS['automatiseringen/Onboarding']      = perMotorView('Onboarding');
  window.DFO.VIEWS['automatiseringen/Leadsonderhoud']  = perMotorView('Leadsonderhoud');
  window.DFO.VIEWS['automatiseringen/Wanbetalers']     = perMotorView('Wanbetalers');
  window.DFO.VIEWS['automatiseringen/Lisa']            = perMotorView('Lisa');
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('automatiseringen');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('automatiseringen');
  console.debug('[automatiseringen-v2] registered 6 views (dormant)');
})();
