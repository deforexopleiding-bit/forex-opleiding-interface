// modules/klanten-v2/views/email-v2.js
//
// Fase B — E-mail-module layout voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - VIEWS['email/']  r2559-2747  (3-koloms mail3-layout + compose-modal)
//   - MAILDATA         r2523-2552  (7 mock-berichten)
//   - MAPPEN           r2553       (7 mappen met tellers)
//   - ACCOUNTS         r2555-2556  (4 postvakken)
//   - state            r2557       (mailSel/mailFold/mailAcc/composeOpen/composeMode)
//
// Non-ES-module (klassieke <script>), geladen NA _shared-v2.js zodat
// window.KV_V2.helpers beschikbaar is.
//
// Registreert:
//   DFO.VIEWS['email/']            = emailView
//   window.openCompose             = compose-modal opener (new/reply/replyall/fwd/ai)
//   window.closeCompose            = compose-modal sluiter
//   window.emailToggleSel          = row-checkbox toggle
//   window.emailToggleDD           = dropdown-toggle in reader
//   window.emailDdDo               = dropdown-item stub (log-only voor demo)
//   window.emailOpenDossier        = klant-dossier stub (log-only)
//   window.KV_V2_ADD?.('email')    — schrijft in V2_MODULES-set
//
// DATA IS VOORBEELD. Amber banner via helpers.voorbeeldBanner().

(function () {
  if (!window.DFO) { console.error('[email-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[email-v2] KV_V2.helpers niet geladen (laad _shared-v2.js eerst).'); return; }

  const { I, svg, S, F, key, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Module-state (prototype r2557) ───────────────────────────────── */
  let mailSel = 1;
  let mailFold = 'in';
  let mailAcc = 'all';
  let composeOpen = false;
  let composeMode = 'new';
  let ddOpen = false;

  /* ── Voorbeeld-data (prototype r2523-2556) ────────────────────────── */
  const MAILDATA = [
    { id: 1, van: 'Nico Berghorst', mail: 'n.berghorst@live.nl', ond: 'Re: Tweede betalingsherinnering — Factuur 2026/1192',
      tijd: '09:14', datum: '6 aug 2026', ongelezen: true, vlag: true, att: [], map: 'in', klant: 'Nico Berghorst', acc: 'administratie',
      prev: 'Ik betaal niks meer, jullie hebben mijn geld al gehad…',
      body: '<p>Beste,</p><p>Ik betaal niks meer. Jullie hebben mijn geld al gehad en ik heb nooit gekregen wat er beloofd was. Ik heb Ricardo hierover bericht, geloof me.</p><p>Laatste keer dat ik hierop reageer.</p><p>Nico</p>',
      ai: 'Hoi Nico, ik begrijp dat je gefrustreerd bent en dat wil ik graag serieus nemen. Ik zie in ons systeem dat er nog €600,00 openstaat over factuur 2026/1192. Zou je me kunnen vertellen wat er precies is misgegaan? Dan kijk ik er persoonlijk naar en zoeken we samen een oplossing.' },
    { id: 2, van: 'Mollie', mail: 'noreply@mollie.com', ond: 'Nieuwe betaling ontvangen — € 600,00',
      tijd: '08:52', datum: '6 aug 2026', ongelezen: true, vlag: false, att: [], map: 'in', klant: null, acc: 'administratie',
      prev: 'Er is een betaling bijgeschreven op je rekening…',
      body: '<p>Er is een betaling van € 600,00 bijgeschreven.</p><p>Referentie: 2026/0921<br>Van: C. Noltus Haarkamp</p>', ai: null },
    { id: 3, van: 'Emile Rabaut', mail: 'emile@erschilder.be', ond: 'Betalingsbewijs traject',
      tijd: 'gisteren', datum: '5 aug 2026', ongelezen: true, vlag: false, att: [{ n: 'betaalbewijs.pdf', s: '184 kB', t: 'pdf' }],
      map: 'in', klant: 'ER Schilderwerken', acc: 'administratie',
      prev: 'Bij deze het bewijs van de overschrijving…',
      body: '<p>Beste,</p><p>Bij deze het bewijs van de overschrijving van vorige week. Het bedrag zou inmiddels binnen moeten zijn.</p><p>Met vriendelijke groet,<br>Emile Rabaut<br>ER Schilderwerken</p>',
      ai: 'Beste Emile, dank je wel voor het toesturen van het betaalbewijs. Ik zie de betaling inderdaad binnen — je factuur staat nu op betaald. Fijne dag verder!' },
    { id: 4, van: 'Stéphane Seutin', mail: 'info@chamano.be', ond: 'Vraag over de startdatum',
      tijd: 'gisteren', datum: '5 aug 2026', ongelezen: false, vlag: false, att: [], map: 'in', klant: 'Chamano BV', acc: 'info',
      prev: 'Wanneer kan ik precies beginnen met het traject?',
      body: '<p>Hallo,</p><p>Wanneer kan ik precies beginnen met het traject? Ik heb de offerte getekend maar zie nog geen startdatum.</p><p>Groet, Stéphane</p>',
      ai: 'Hallo Stéphane, leuk dat je aan de slag wilt! Je onboarding staat klaar — je mentor Dave neemt binnen twee werkdagen contact op om de eerste sessie in te plannen. Je kunt alvast inloggen in de leeromgeving.' },
    { id: 5, van: 'Teamleader', mail: 'noreply@teamleader.eu', ond: 'Offerte OFF-2026-219 is bekeken',
      tijd: '2 dagen', datum: '4 aug 2026', ongelezen: false, vlag: false, att: [], map: 'in', klant: 'Chamano BV', acc: 'administratie',
      prev: 'Je offerte is zojuist geopend door de ontvanger', body: '<p>Je offerte OFF-2026-219 is geopend.</p>', ai: null },
    { id: 6, van: 'Miriam Osei', mail: 'm.osei@gmail.com', ond: 'Aanmelding masterclass Gent',
      tijd: '2 dagen', datum: '4 aug 2026', ongelezen: false, vlag: true, att: [], map: 'in', klant: null, acc: 'leads',
      prev: 'Ik zou graag komen naar de masterclass van 12 augustus',
      body: '<p>Goedemiddag,</p><p>Ik zou graag komen naar de masterclass van 12 augustus. Is er nog plek?</p><p>Miriam</p>',
      ai: 'Hallo Miriam, wat leuk dat je erbij wilt zijn! Er is nog plek op 12 augustus. Ik stuur je zo de aanmeldlink — als je die invult staat je plek vast en krijg je alle praktische informatie toegestuurd.' },
  ];
  const MAPPEN = [
    ['in', 'Postvak IN', I.inbox, 3], ['unread', 'Ongelezen', I.mail, 3], ['flag', 'Met vlag', I.tag, 2],
    ['draft', 'Concepten', I.edit, 1], ['sent', 'Verzonden', I.send, 0], ['arch', 'Archief', I.box, 0], ['trash', 'Prullenbak', I.trash, 0],
  ];
  const ACCOUNTS = [
    ['administratie', 'administratie@', 'blue'], ['info', 'info@', 'emerald'],
    ['leads', 'leads@', 'amber'], ['partners', 'partners@', 'violet'],
  ];

  /* ── E-mail-view (prototype r2559-2747) ───────────────────────────── */
  function emailView() {
    let list = MAILDATA.filter(m => {
      if (mailFold === 'unread') return m.ongelezen;
      if (mailFold === 'flag') return m.vlag;
      if (mailFold === 'in') return m.map === 'in';
      return m.map === mailFold;
    });
    if (mailAcc !== 'all') list = list.filter(m => m.acc === mailAcc);
    const q = (F('q', '') || '').toLowerCase();
    if (q) list = list.filter(m => m.van.toLowerCase().includes(q) || m.ond.toLowerCase().includes(q));
    const cur = MAILDATA.find(m => m.id === mailSel) || list[0];
    S.sel = S.sel || {};
    const nsel = Object.keys(S.sel).filter(k => S.sel[k] && k[0] === 'm').length;

    return `${H.voorbeeldBanner()}
    <div class="mail3">
      <div class="mail-rail">
        <button class="btn btn-primary mail-compose-btn" onclick="openCompose('new')">${svg(I.plus)}Nieuwe e-mail</button>
        ${MAPPEN.map(([id, n, ic, c]) => `<button class="mail-fold ${mailFold === id ? 'on' : ''}" onclick="window.__emailSetFold('${id}')">
          ${svg(ic)}<span>${n}</span>${c ? `<span class="cnt ${id === 'in' || id === 'unread' ? 'hot' : ''}">${c}</span>` : ''}</button>`).join('')}
        <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:16px 9px 6px">Postvakken</div>
        <button class="mail-acc" onclick="window.__emailSetAcc('all')"
          style="${mailAcc === 'all' ? 'background:var(--surface-2);font-weight:600;color:var(--text)' : ''}">
          <span class="dotc" style="background:var(--text-3)"></span>Alle postvakken</button>
        ${ACCOUNTS.map(([id, n, c]) => `<button class="mail-acc" onclick="window.__emailSetAcc('${id}')"
          style="${mailAcc === id ? 'background:var(--surface-2);font-weight:600;color:var(--text)' : ''}">
          <span class="dotc" style="background:var(--${c})"></span>${n}</button>`).join('')}
        <div style="margin-top:auto;padding-top:14px">
          <button class="mail-fold" onclick="console.info('[email-v2] goSet(com-mail) — instellingen zijn placeholder in voorbeeld')">${svg(I.settings)}<span>Instellingen</span></button>
        </div>
      </div>

      <div class="mail-list">
        <div class="mail-list-top">
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
            <input placeholder="Zoek in e-mail…" value="${(F('q', '') || '').replace(/"/g, '&quot;')}"
              oninput="S.filters[DFO.key()+'::q']=this.value;DFO.render();this.focus();this.setSelectionRange(this.value.length,this.value.length)"></div>
          <div style="display:flex;gap:5px;margin-top:9px;align-items:center">
            <button class="chip ${F('fl', 'all') === 'all' ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','all')">Alles</button>
            <button class="chip ${F('fl', 'all') === 'un' ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','un')">Ongelezen</button>
            <button class="chip ${F('fl', 'all') === 'att' ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','att')">Bijlage</button>
            <select class="filter-sel" style="margin-left:auto;font-size:11.5px;padding:3px 7px">
              <option>Nieuwste</option><option>Oudste</option><option>Afzender</option></select>
          </div>
        </div>
        <div class="mail-list-scroll">
          ${list.map(m => `<div class="mail-row ${m.ongelezen ? 'mail-unread' : ''} ${mailSel === m.id ? 'on' : ''}" onclick="window.__emailSelect(${m.id})">
            <div style="display:flex;flex-direction:column;align-items:center;gap:6px;padding-top:2px">
              <div class="checkbox ${S.sel['m' + m.id] ? 'on' : ''}" onclick="event.stopPropagation();emailToggleSel('m${m.id}')">${svg(I.tick)}</div>
              ${m.ongelezen ? '<span class="mr-dot"></span>' : ''}
            </div>
            <div class="mr-body">
              <div class="mr-top"><span class="mr-from">${m.van}</span><span class="mr-time">${m.tijd}</span></div>
              <div class="mr-subj">${m.ond}</div>
              <div class="mr-prev">${m.prev}</div>
              <div class="mr-tags">
                ${m.klant ? H.pill('accent', m.klant, 1) : `<span class="pill pill-neutral nodot">Niet gekoppeld</span>`}
                ${m.att.length ? `<span style="color:var(--text-3);display:inline-flex">${svg('<path d="M21.4 11l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>', 'width:12px;height:12px')}</span>` : ''}
                ${m.vlag ? `<span style="color:var(--amber);display:inline-flex">${svg(I.tag, 'width:12px;height:12px')}</span>` : ''}
                ${m.ai ? `<span class="pill pill-violet nodot" style="font-size:10.5px;padding:1.5px 7px">AI-suggestie</span>` : ''}
              </div>
            </div>
          </div>`).join('') || `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen berichten</div></div>`}
        </div>
        ${nsel ? `<div class="mail-bulk" style="padding:10px 13px;border-top:1px solid var(--border);background:var(--surface-2);display:flex;gap:6px;align-items:center">
          <b style="font-size:12.5px">${nsel}</b>
          <button class="btn btn-ghost btn-sm">${svg(I.mail)}Gelezen</button>
          <button class="btn btn-ghost btn-sm">${svg(I.box)}Archief</button>
          <button class="btn btn-ghost btn-sm">${svg(I.trash)}</button>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="S.sel={};DFO.render()">×</button></div>` : ''}
      </div>

      ${cur ? `<div class="mail-read">
        <div class="mail-read-head">
          <div class="mail-subject">${cur.ond}</div>
          <div class="mail-acts">
            <button class="btn btn-primary btn-sm" onclick="openCompose('reply')">${svg('<path d="M9 17l-5-5 5-5"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/>')}Beantwoorden</button>
            <button class="btn btn-ghost btn-sm" onclick="openCompose('replyall')">${svg('<path d="M7 17l-5-5 5-5M12 17l-5-5 5-5"/><path d="M22 18v-2a4 4 0 0 0-4-4H7"/>')}Allen</button>
            <button class="btn btn-ghost btn-sm" onclick="openCompose('fwd')">${svg('<path d="M15 17l5-5-5-5"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>')}Doorsturen</button>
            <span style="width:1px;height:20px;background:var(--border);margin:0 3px"></span>
            <button class="icon-btn" title="Markeer ongelezen">${svg(I.mail)}</button>
            <button class="icon-btn" title="Vlag" style="${cur.vlag ? 'color:var(--amber)' : ''}">${svg(I.tag)}</button>
            <button class="icon-btn" title="Archiveren">${svg(I.box)}</button>
            <button class="icon-btn" title="Verwijderen">${svg(I.trash)}</button>
            <div class="dd"><button class="icon-btn" onclick="event.stopPropagation();emailToggleDD()">${svg(I.dots)}</button>
              <div class="dd-menu ${ddOpen ? 'open' : ''}" style="bottom:auto;top:calc(100% + 6px)">
                <button class="dd-item" onclick="emailDdDo('Koppel aan klant')">${svg(I.users)}Koppel aan klant</button>
                <button class="dd-item" onclick="emailDdDo('Maak ticket')">${svg(I.ticket)}Maak ticket van</button>
                <button class="dd-item" onclick="emailDdDo('Maak taak')">${svg(I.check2)}Maak taak van</button>
                <button class="dd-item" onclick="emailDdDo('Verplaats naar map')">${svg(I.box)}Verplaats naar…</button>
                <button class="dd-item" onclick="emailDdDo('Regel maken')">${svg(I.sliders)}Regel maken</button>
                <div class="dd-sep"></div>
                <button class="dd-item" onclick="emailDdDo('Afdrukken')">${svg(I.file)}Afdrukken</button>
                <button class="dd-item" onclick="emailDdDo('Bron bekijken')">${svg(I.eye)}Origineel bekijken</button>
              </div></div>
          </div>
        </div>
        <div class="mail-meta">
          ${H.av(cur.van, 38)}
          <div style="flex:1;min-width:0">
            <div style="font-size:14px;font-weight:600">${cur.van}</div>
            <div style="font-size:12.5px;color:var(--text-3)">${cur.mail} · aan administratie@deforexopleiding.nl</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:12px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${cur.datum} · ${cur.tijd}</div>
            ${cur.klant
              ? `<button class="btn btn-ghost btn-sm" style="margin-top:5px" onclick="emailOpenDossier('${cur.klant.replace(/'/g, "\\'")}')">${svg(I.users)}Open dossier</button>`
              : `<button class="btn btn-ghost btn-sm" style="margin-top:5px">${svg(I.plus)}Koppel klant</button>`}
          </div>
        </div>
        <div class="mail-body">${cur.body}</div>
        ${cur.att.length ? `<div class="mail-att">
          ${cur.att.map(a => `<div class="att-chip">
            <span class="att-ico" style="background:var(--rose-soft);color:var(--rose)">${svg(I.file, 'width:14px;height:14px')}</span>
            <div><div style="font-weight:500">${a.n}</div><div style="font-size:11px;color:var(--text-3)">${a.s}</div></div>
            ${svg(I.down, 'width:14px;height:14px;color:var(--text-3);margin-left:6px')}</div>`).join('')}
        </div>` : ''}
        ${cur.ai ? `<div class="ai-sug">
          <div class="ai-sug-head">
            <span class="tile-ico" style="width:28px;height:28px;background:linear-gradient(140deg,var(--violet),#8B5CF6);color:#fff">
              ${svg(I.sparkle, 'width:14px;height:14px')}</span>
            <div style="flex:1"><div style="font-size:13px;font-weight:600">Voorgesteld antwoord</div>
              <div style="font-size:11.5px;color:var(--text-3)">Op basis van dit gesprek en het klantdossier</div></div>
            <button class="icon-btn" title="Opnieuw genereren">${svg(I.refresh)}</button>
          </div>
          <div class="ai-sug-body">${cur.ai}</div>
          <div class="ai-sug-foot">
            <span style="font-size:11.5px;color:var(--text-3);margin-right:2px">Toon:</span>
            <button class="tone-chip on">Vriendelijk</button>
            <button class="tone-chip">Zakelijk</button>
            <button class="tone-chip">Kort</button>
            <button class="tone-chip">Streng</button>
            <button class="btn btn-primary btn-sm" style="margin-left:auto;--m:var(--violet);--m-glow:rgba(109,63,212,.4)"
              onclick="openCompose('ai')">${svg(I.edit)}Gebruiken</button>
          </div>
        </div>` : ''}
      </div>` : `<div class="mail-read"><div class="empty" style="margin:auto">
        <div class="empty-ico">${svg(I.mail)}</div><div class="empty-t">Selecteer een bericht</div>
        <div class="empty-s">Kies links een e-mail om 'm te lezen en te beantwoorden.</div></div></div>`}
    </div>

    <div class="kv-mail-modal-bg ${composeOpen ? 'open' : ''}" onclick="if(event.target===this)closeCompose()">
      <div class="compose">
        <div class="compose-head">
          <span style="font-size:13.5px;font-weight:600;flex:1">${composeMode === 'new' ? 'Nieuw bericht' : composeMode === 'fwd' ? 'Doorsturen' : 'Beantwoorden'}</span>
          <button class="icon-btn" title="Minimaliseren">${svg('<path d="M5 12h14"/>')}</button>
          <button class="icon-btn" onclick="closeCompose()">${svg(I.x)}</button>
        </div>
        <div class="compose-field">
          <span class="compose-lbl">Van</span>
          <select class="compose-inp" style="cursor:pointer">
            ${ACCOUNTS.map(([id, n]) => `<option>${n}deforexopleiding.nl</option>`).join('')}</select>
        </div>
        <div class="compose-field">
          <span class="compose-lbl">Aan</span>
          <div style="flex:1;display:flex;align-items:center;flex-wrap:wrap;gap:3px">
            ${composeMode !== 'new' && cur ? `<span class="recip">${H.av(cur.van, 18)}${cur.mail}<button>${svg(I.x, 'width:9px;height:9px')}</button></span>` : ''}
            <input class="compose-inp" style="min-width:120px" placeholder="${composeMode === 'new' ? 'naam@voorbeeld.nl' : ''}">
          </div>
          <button class="btn btn-ghost btn-sm" onclick="var c=document.getElementById('ccRow'),b=document.getElementById('bccRow');if(c)c.style.display='flex';if(b)b.style.display='flex'">CC/BCC</button>
        </div>
        <div class="compose-field" id="ccRow" style="display:none"><span class="compose-lbl">CC</span>
          <input class="compose-inp" placeholder="naam@voorbeeld.nl"></div>
        <div class="compose-field" id="bccRow" style="display:none"><span class="compose-lbl">BCC</span>
          <input class="compose-inp" placeholder="naam@voorbeeld.nl"></div>
        <div class="compose-field">
          <span class="compose-lbl">Onderwerp</span>
          <input class="compose-inp" value="${composeMode === 'new' ? '' : (composeMode === 'fwd' ? 'Fwd: ' : 'Re: ') + (cur ? cur.ond.replace(/^(Re: |Fwd: )/, '') : '')}">
        </div>
        <div class="compose-body" contenteditable="true">${composeMode === 'ai' && cur && cur.ai ? cur.ai : ''}</div>
        <div class="compose-sig">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            <span style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3)">Handtekening</span>
            <select class="filter-sel" style="font-size:11.5px;padding:2px 7px">
              <option>Standaard — Team DFO</option><option>Persoonlijk — Amigo</option><option>Kort</option><option>Geen</option></select>
            <button class="btn btn-ghost btn-sm" style="margin-left:auto;font-size:11.5px">Beheren</button>
          </div>
          Met vriendelijke groet,<br><b style="color:var(--text-2)">Team De Forex Opleiding</b><br>
          +31 85 580 36 26 · deforexopleiding.nl
        </div>
        <div class="compose-foot">
          <button class="btn btn-primary">${svg(I.send)}Versturen</button>
          <button class="icon-btn" title="Bijlage toevoegen">${svg('<path d="M21.4 11l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>')}</button>
          <button class="icon-btn" title="Sjabloon invoegen">${svg(I.doc)}</button>
          <button class="icon-btn" title="Later versturen">${svg(I.clock)}</button>
          <button class="icon-btn" title="AI: help me schrijven" style="color:var(--violet)">${svg(I.sparkle)}</button>
          <span style="margin-left:auto;font-size:11.5px;color:var(--text-3)">Concept opgeslagen</span>
          <button class="icon-btn" title="Verwijderen" onclick="closeCompose()">${svg(I.trash)}</button>
        </div>
      </div>
    </div>`;
  }

  /* ── Handler-stubs — geëxposeerd op window omdat prototype ze inline
     via onclick-attrs aanroept. ─────────────────────────────────────── */
  window.__emailSetFold = (id) => { mailFold = id; ddOpen = false; render(); };
  window.__emailSetAcc  = (id) => { mailAcc = id; ddOpen = false; render(); };
  window.__emailSelect  = (id) => { mailSel = id; ddOpen = false; render(); };
  window.openCompose    = (mode) => { composeMode = mode; composeOpen = true; ddOpen = false; render(); };
  window.closeCompose   = () => { composeOpen = false; render(); };
  window.emailToggleSel = (k) => { S.sel = S.sel || {}; S.sel[k] = !S.sel[k]; render(); };
  window.emailToggleDD  = () => { ddOpen = !ddOpen; render(); };
  window.emailDdDo      = (label) => { console.info('[email-v2] dd-item: ' + label + ' (voorbeeld — geen actie)'); ddOpen = false; render(); };
  window.emailOpenDossier = (klant) => { console.info('[email-v2] Open dossier voor: ' + klant + ' (voorbeeld — no-op)'); };

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['email/'] = emailView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('email');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('email');
  }

  console.debug('[email-v2] registered VIEWS[email/]');
})();
