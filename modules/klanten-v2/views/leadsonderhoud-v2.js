// modules/klanten-v2/views/leadsonderhoud-v2.js
//
// Fase E — Leadsonderhoud (layout-only). 4 tabs: Inbox / Contacten / Bulk versturen / Statistieken.
// Compact-getrouw uit prototype r3620-3800. Bulk-form + safety-checkboxes 1-op-1.
// Dormant. Preview ?v2preview=leadsonderhoud (rol Marketing).

(function () {
  if (!window.DFO) { console.error('[leadsonderhoud-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[leadsonderhoud-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const INBOX = [
    { from: 'sanne.hendriks@…',    ond: 'Vraag over de gratis training',      tijd: '14:22', unread: true },
    { from: 'niels.postma@…',      ond: 'Kan ik me nog inschrijven?',         tijd: '11:07', unread: true },
    { from: 'joan.veldman@…',      ond: 'Re: Welkom bij De Forex Opleiding',  tijd: 'gisteren' },
    { from: 'peter.mulder@…',      ond: 'Uitschrijven',                        tijd: '2 dagen' },
  ];
  const CONTACTEN = [
    { naam: 'Sanne Hendriks',   mail: 'sanne.hendriks@gmail.com',   ingang: 'Meta Ads',  laatst: '14:22',   status: 'actief' },
    { naam: 'Niels Postma',     mail: 'niels.postma@outlook.com',   ingang: 'Webinar',   laatst: '11:07',   status: 'actief' },
    { naam: 'Joan Veldman',     mail: 'joan.veldman@yahoo.com',     ingang: 'Referral',  laatst: 'gisteren',status: 'actief' },
    { naam: 'Peter Mulder',     mail: 'peter.mulder@ziggo.nl',      ingang: 'Meta Ads',  laatst: '2 dagen', status: 'uitgeschreven' },
  ];
  const RECENT_BULK = [
    { titel: 'Zomer masterclass — herinnering',   verzonden: '02-08-2026', ontvangers: 843, open: '38%' },
    { titel: 'Marktupdate week 30',                verzonden: '26-07-2026', ontvangers: 812, open: '41%' },
    { titel: 'Trader-story: Kevin',                verzonden: '19-07-2026', ontvangers: 806, open: '44%' },
  ];

  window.__lsNotice = (l) => { console.info('[leadsonderhoud-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };
  window.__lsToggle = (id) => { const el = document.getElementById(id); if (el) el.classList.toggle('checked'); };

  function inboxView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.search('Zoek in inbox…'),
      `<div class="tb-right"><button class="btn" onclick="__lsNotice('Markeer alles als gelezen')">${svg(I.check)}Alles gelezen</button></div>`,
    ])}
    <div class="mail-list">
      ${INBOX.map(m => `
        <div class="mail-item ${m.unread ? 'is-unread' : ''}">
          <div class="mail-item-l"><div class="av av-sm">${H.av(m.from)}</div></div>
          <div class="mail-item-m">
            <div class="mail-item-from">${m.from}${m.unread ? ' <span class="mail-dot"></span>' : ''}</div>
            <div class="mail-item-subject">${m.ond}</div>
          </div>
          <div class="mail-item-r"><span style="font-size:12px;color:var(--text-3)">${m.tijd}</span></div>
        </div>`).join('')}
    </div>`;
  }

  function contactenView() {
    const f = F('ls-contact', 'all');
    const rows = CONTACTEN.filter(c => f === 'all' || c.status === f);
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'teal',    icon: I.users,  label: 'Contacten totaal',      val: '3.142', hi: 1 },
      { c: 'emerald', icon: I.check,  label: 'Actief',                val: '2.986',       sub: '95%' },
      { c: 'orange',  icon: I.warn,   label: 'Uitgeschreven',         val: '156',         sub: '5%' },
      { c: 'blue',    icon: I.plus,   label: 'Nieuw deze week',       val: '31' },
    ])}
    ${H.toolbar([
      H.chips('ls-contact', [
        { l: 'Alle',           v: 'all' },
        { l: 'Actief',         v: 'actief' },
        { l: 'Uitgeschreven',  v: 'uitgeschreven' },
      ], f),
      H.search('Zoek contact…'),
      `<div class="tb-right"><button class="btn" onclick="__lsNotice('Exporteer contacten')">${svg(I.download)}Exporteer</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'E-mail', cls: 'optional' }, { l: 'Ingang', cls: 'optional' }, { l: 'Laatst', cls: 'optional' }, { l: 'Status' }],
      rows.map(c => [
        `<div class="cell-main-wrap"><div class="av av-sm">${H.av(c.naam)}</div><span class="cell-main">${c.naam}</span></div>`,
        `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${c.mail}</span>`,
        `<span class="pill pill-neutral">${c.ingang}</span>`,
        `<span style="font-size:12.5px;color:var(--text-3)">${c.laatst}</span>`,
        c.status === 'actief' ? H.pill('ok', 'Actief') : H.pill('neutral', 'Uitgeschreven'),
      ])
    )}`;
  }

  function bulkView() {
    return `${H.voorbeeldBanner()}
    <div class="bulk-grid">
      <div class="bulk-main">
        <div class="ib-card">
          <div class="ib-card-head">
            <div class="ib-card-title">Nieuw bulk-bericht</div>
            <div class="ib-card-sub">Selecteer doelgroep, kies template, controleer preview.</div>
          </div>
          <div class="ib-card-body">
            <div class="ib-field">
              <label class="ib-lbl">Doelgroep</label>
              <div class="radio-row">
                <label class="radio"><input type="radio" name="ls-doel" checked> Alle actieve contacten <span class="mono muted">(2.986)</span></label>
                <label class="radio"><input type="radio" name="ls-doel"> Alleen Meta-Ads-ingang <span class="mono muted">(1.842)</span></label>
                <label class="radio"><input type="radio" name="ls-doel"> Alleen webinar-inschrijvers <span class="mono muted">(487)</span></label>
                <label class="radio"><input type="radio" name="ls-doel"> Custom segment… <span class="muted">(bouwer)</span></label>
              </div>
            </div>

            <div class="ib-field">
              <label class="ib-lbl">Template</label>
              <select class="ib-input" onchange="__lsNotice('Template geladen')">
                <option>— Kies template —</option>
                <option>Zomer masterclass — herinnering</option>
                <option>Marktupdate week X</option>
                <option>Trader-story spotlight</option>
              </select>
            </div>

            <div class="ib-field">
              <label class="ib-lbl">Onderwerp</label>
              <input class="ib-input" placeholder="Onderwerp e-mail…" value="Herinnering: masterclass zaterdag 10:00">
            </div>

            <div class="ib-field">
              <label class="ib-lbl">Preview</label>
              <div class="ib-preview">
                <div class="ib-preview-h">Van: nieuwsbrief@deforexopleiding.nl</div>
                <div class="ib-preview-b">Hoi {{voornaam}},<br><br>Aanstaande zaterdag om 10:00 gaat de masterclass live. Wees erbij! Klik op de knop hieronder om je plek te bevestigen.<br><br><span class="btn btn-primary btn-sm">Plek bevestigen</span></div>
              </div>
            </div>

            <div class="ib-field">
              <label class="ib-lbl">Veiligheid</label>
              <label class="checkbox" id="ls-cb-1" onclick="__lsToggle('ls-cb-1')"><span class="checkbox-mark">${svg(I.check)}</span> Ik heb de doelgroep dubbel gecontroleerd</label>
              <label class="checkbox" id="ls-cb-2" onclick="__lsToggle('ls-cb-2')"><span class="checkbox-mark">${svg(I.check)}</span> Testmail naar mezelf verstuurd</label>
              <label class="checkbox" id="ls-cb-3" onclick="__lsToggle('ls-cb-3')"><span class="checkbox-mark">${svg(I.check)}</span> Uitschrijflink is aanwezig</label>
            </div>
          </div>
          <div class="ib-card-foot">
            <button class="btn" onclick="__lsNotice('Testmail')">${svg(I.mail)}Testmail naar mezelf</button>
            <button class="btn btn-primary" onclick="__lsNotice('Verstuur bulk-bericht')">${svg(I.send)}Verstuur naar 2.986 contacten</button>
          </div>
        </div>
      </div>
      <div class="bulk-side">
        <div class="ib-card">
          <div class="ib-card-head"><div class="ib-card-title">Recent verzonden</div></div>
          <div class="ib-card-body">
            ${RECENT_BULK.map(r => `
              <div class="fu-item">
                <div class="fu-item-title">${r.titel}</div>
                <div class="fu-item-meta"><span class="mono">${r.verzonden}</span> · ${r.ontvangers} ontv · open ${r.open}</div>
              </div>`).join('')}
          </div>
        </div>
      </div>
    </div>`;
  }

  function statsView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'teal',    icon: I.mail,   label: 'Verzonden 30d',        val: '2.472', hi: 1, sub: '4 campagnes' },
      { c: 'emerald', icon: I.check,  label: 'Gem. open rate',       val: '41%',          trend: H.trend('+3%', true) },
      { c: 'blue',    icon: I.target, label: 'Gem. klikratio',       val: '8,1%' },
      { c: 'orange',  icon: I.warn,   label: 'Uitschrijvingen',      val: '18',           sub: '0,7%' },
    ])}
    <div class="stats-grid">
      <div class="ib-card">
        <div class="ib-card-head"><div class="ib-card-title">Engagement per campagne (30d)</div></div>
        <div class="ib-card-body">
          ${H.table(
            [{ l: 'Campagne' }, { l: 'Ontvangers', cls: 'r' }, { l: 'Open', cls: 'r' }, { l: 'Klik', cls: 'r' }, { l: 'Uitschr.', cls: 'r' }],
            RECENT_BULK.map(r => [
              r.titel,
              `<span class="mono">${r.ontvangers}</span>`,
              `<span class="mono">${r.open}</span>`,
              `<span class="mono">${(Math.random() * 3 + 6).toFixed(1)}%</span>`,
              `<span class="mono">${Math.floor(Math.random() * 8) + 2}</span>`,
            ])
          )}
        </div>
      </div>
      <div class="ib-card">
        <div class="ib-card-head"><div class="ib-card-title">Groei contactenlijst</div></div>
        <div class="ib-card-body">
          <div class="chart-placeholder">${svg(I.trend)}<div class="chart-placeholder-txt">Line-chart met wekelijkse groei — komt in de data-ronde.</div></div>
        </div>
      </div>
    </div>`;
  }

  window.DFO.VIEWS['leadsonderhoud/Inbox']          = inboxView;
  window.DFO.VIEWS['leadsonderhoud/Contacten']      = contactenView;
  window.DFO.VIEWS['leadsonderhoud/Bulk versturen'] = bulkView;
  window.DFO.VIEWS['leadsonderhoud/Statistieken']   = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leadsonderhoud');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leadsonderhoud');
  console.debug('[leadsonderhoud-v2] registered 4 views (dormant)');
})();
