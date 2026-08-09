// modules/klanten-v2/views/lisa-v2.js
//
// Fase E — Lisa (Instagram) (layout-only). 3 tabs: Dashboard / Gesprekken / Statistieken.
// Compact-getrouw uit prototype r5820-6220. Gesprekken = split-view (thread-lijst
// links + chat rechts, lean-but-faithful — volledige DM-editor komt in data-ronde).
// Dormant. Preview ?v2preview=lisa (rol Marketing).

(function () {
  if (!window.DFO) { console.error('[lisa-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[lisa-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const THREADS = [
    { user: '@michaelforex',   snip: 'Ik zag je post over risk mgmt, kun je …', tijd: '5m',   unread: 2, tag: 'warm' },
    { user: '@daan.trades',    snip: 'Klopt het dat je een gratis training…',   tijd: '17m',  unread: 1, tag: 'hot'  },
    { user: '@sophia_traidz',  snip: 'Waar kan ik me inschrijven?',              tijd: '1u',              tag: 'hot'  },
    { user: '@nielswork',      snip: 'Bedankt voor je snelle antwoord!',        tijd: '3u',              tag: 'warm' },
    { user: '@marktje.87',     snip: 'Kunnen jullie me helpen met platform…',    tijd: 'gisteren',       tag: 'cold' },
  ];
  const TAG_TO_PILL = { hot: 'warn', warm: 'info', cold: 'neutral' };

  window.__lisaNotice = (l) => { console.info('[lisa-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };

  function dashboardView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'teal',    icon: I.mail,   label: 'DM\'s afgehandeld 30d', val: '312', hi: 1, trend: H.trend('+48', true) },
      { c: 'emerald', icon: I.check,  label: 'Auto-antwoord ratio',   val: '84%',        sub: 'zonder mens' },
      { c: 'blue',    icon: I.target, label: 'Leads → gesprek',       val: '61' },
      { c: 'violet',  icon: I.trend,  label: 'Gem. reactietijd',      val: '2m',         sub: 'p50' },
    ])}
    <div class="stats-grid">
      <div class="ib-card">
        <div class="ib-card-head">
          <div class="ib-card-title">Lisa — status</div>
          <div class="ib-card-sub">Instagram DM-agent</div>
        </div>
        <div class="ib-card-body">
          <div class="fu-item">
            <div class="fu-item-title">${svg(I.check)} Verbinding actief</div>
            <div class="fu-item-meta">Meta Graph API — laatste ping 12s geleden</div>
          </div>
          <div class="fu-item">
            <div class="fu-item-title">Autonomie</div>
            <div class="fu-item-meta">Reactief AAN · Proactief UIT · Draft-only voor hot leads</div>
          </div>
          <div class="fu-item">
            <div class="fu-item-title">Kennisbank</div>
            <div class="fu-item-meta">42 topics · laatst bijgewerkt gisteren</div>
          </div>
        </div>
        <div class="ib-card-foot">
          <button class="btn" onclick="__lisaNotice('Open configuratie')">${svg(I.settings)}Configuratie</button>
          <button class="btn btn-primary" onclick="__lisaNotice('Test-DM sturen')">${svg(I.send)}Test-DM</button>
        </div>
      </div>
      <div class="ib-card">
        <div class="ib-card-head"><div class="ib-card-title">Onderwerpen top-5 (30d)</div></div>
        <div class="ib-card-body">
          ${H.table(
            [{ l: 'Onderwerp' }, { l: 'DM\'s', cls: 'r' }, { l: '→ Lead', cls: 'r' }],
            [
              ['Gratis training', '87', '31'],
              ['Prijs / abonnement', '54', '18'],
              ['Platform-vraag', '42', '4'],
              ['Refund / annulering', '21', '0'],
              ['Overig / anders', '18', '2'],
            ]
          )}
        </div>
      </div>
    </div>`;
  }

  function gesprekkenView() {
    const f = F('lisa-tag', 'all');
    const rows = THREADS.filter(t => f === 'all' || t.tag === f);
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('lisa-tag', [
        { l: 'Alle',  v: 'all'  },
        { l: 'Hot',   v: 'hot'  },
        { l: 'Warm',  v: 'warm' },
        { l: 'Cold',  v: 'cold' },
      ], f),
      H.search('Zoek in DM\'s…'),
    ])}
    <div class="split-2col">
      <div class="split-left">
        <div class="mail-list">
          ${rows.map((t, i) => `
            <div class="mail-item ${i === 0 ? 'is-active' : ''} ${t.unread ? 'is-unread' : ''}">
              <div class="mail-item-l"><div class="av av-sm">${H.av(t.user)}</div></div>
              <div class="mail-item-m">
                <div class="mail-item-from">${t.user} ${H.pill(TAG_TO_PILL[t.tag], t.tag)}</div>
                <div class="mail-item-subject">${t.snip}</div>
              </div>
              <div class="mail-item-r">
                <span style="font-size:12px;color:var(--text-3)">${t.tijd}</span>
                ${t.unread ? `<span class="badge-dot">${t.unread}</span>` : ''}
              </div>
            </div>`).join('')}
        </div>
      </div>
      <div class="split-right">
        <div class="ib-card">
          <div class="ib-card-head">
            <div class="ib-card-title">${svg(I.user)} @michaelforex</div>
            <div class="ib-card-sub">${H.pill('warn', 'hot')} · @michaelforex volgt je · 2 DM's ongelezen</div>
          </div>
          <div class="ib-card-body">
            <div class="chat-msg is-them">
              <div class="chat-bubble">Hey! Ik zag je post over risk management, kun je uitleggen hoe jullie training werkt?</div>
              <div class="chat-meta">5m geleden</div>
            </div>
            <div class="chat-msg is-them">
              <div class="chat-bubble">En werken jullie ook met crypto of alleen forex?</div>
              <div class="chat-meta">4m geleden</div>
            </div>
            <div class="chat-msg is-me">
              <div class="chat-bubble">Hoi Michael! Leuk dat je onze content volgt. Onze training focust op forex met een risk-first-aanpak — geen crypto. Wil je een gratis kennismaking?</div>
              <div class="chat-meta">door Lisa · 3m geleden</div>
            </div>
            <div class="chat-suggest">
              <div class="chat-suggest-lbl">${svg(I.sparkles)}Lisa stelt voor</div>
              <div class="chat-suggest-body">"Perfect — ik stuur je zo de link voor de gratis kennismaking. Heb je een voorkeur voor doordeweeks of weekend?"</div>
              <div class="chat-suggest-actions">
                <button class="btn btn-sm" onclick="__lisaNotice('Plak')">Plak</button>
                <button class="btn btn-sm" onclick="__lisaNotice('Plak + bewerk')">Plak en bewerk</button>
                <button class="btn btn-sm" onclick="__lisaNotice('Negeer')">Negeer</button>
              </div>
            </div>
          </div>
          <div class="ib-card-foot">
            <input class="ib-input" placeholder="Typ een bericht (of gebruik Lisa's suggestie)…">
            <button class="btn btn-primary" onclick="__lisaNotice('Verstuur DM')">${svg(I.send)}Verstuur</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function statsView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'teal',    icon: I.mail,   label: 'DM-volume 30d',       val: '412', hi: 1 },
      { c: 'emerald', icon: I.check,  label: 'Auto-succes',         val: '84%',        sub: 'zonder mens' },
      { c: 'blue',    icon: I.trend,  label: 'Gem. reactie',        val: '2m',         sub: 'p50' },
      { c: 'orange',  icon: I.warn,   label: 'Escalaties',          val: '9',          sub: 'naar mens' },
    ])}
    <div class="stats-grid">
      <div class="ib-card">
        <div class="ib-card-head"><div class="ib-card-title">DM's per dag (30d)</div></div>
        <div class="ib-card-body">
          <div class="chart-placeholder">${svg(I.trend)}<div class="chart-placeholder-txt">Bar-chart per dag — komt in de data-ronde.</div></div>
        </div>
      </div>
      <div class="ib-card">
        <div class="ib-card-head"><div class="ib-card-title">Bron van DM\'s</div></div>
        <div class="ib-card-body">
          ${H.table(
            [{ l: 'Bron' }, { l: 'DM\'s', cls: 'r' }, { l: '%', cls: 'r' }],
            [
              ['Post-reactie',  '187', '45%'],
              ['Story-mention', '92',  '22%'],
              ['Direct',        '84',  '20%'],
              ['Reel-share',    '49',  '12%'],
            ]
          )}
        </div>
      </div>
    </div>`;
  }

  window.DFO.VIEWS['lisa/Dashboard']    = dashboardView;
  window.DFO.VIEWS['lisa/Gesprekken']   = gesprekkenView;
  window.DFO.VIEWS['lisa/Statistieken'] = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('lisa');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('lisa');
  console.debug('[lisa-v2] registered 3 views (dormant)');
})();
