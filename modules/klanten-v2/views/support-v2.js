// modules/klanten-v2/views/support-v2.js
//
// Supportmodule — de CRM-kant van de widget op de website.
//
// Vier tabs, één detailweergave. De detailweergave is waar het werk gebeurt:
// links het gesprek, rechts alles wat je nodig hebt om het te beantwoorden
// (klantgegevens, LMS-status, facturen, mentor, voorgestelde acties). Dat
// rechterpaneel bestaat omdat de vijf vragen die het vaakst binnenkomen
// anders elk drie modules kosten om te beantwoorden.
//
// ── AANWEZIGHEID ───────────────────────────────────────────────────────────
// De knop rechtsboven zet je op beschikbaar voor de live chat. Zolang die
// aanstaat stuurt deze view elke 45 seconden een hartslag; blijft die uit,
// dan telt de server je na vijf minuten als weg (zie
// api/_lib/support-beschikbaarheid.js). Dat interval wordt netjes opgeruimd
// bij het verlaten van de module én bij beforeunload — een setInterval die
// blijft draaien na een modulewissel is in dit project al eerder een bug
// geweest (zie de nav-badge in modules/shared/sidebar.js).
//
// URL-state:
//   ?gesprek=<uuid>   → open dit gesprek

(function () {
  if (!window.DFO) { console.error('[support-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[support-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;

  // Eén stijlregel die niet inline kan: de bubbel van ons gebruikt het
  // module-accent als achtergrond, en dat accent is in donkere modus licht.
  // Witte tekst daarop is onleesbaar. Dezelfde correctie die app-shell.css
  // al doet voor .btn-primary.
  (function stijl() {
    if (document.getElementById('sup-stijl')) return;
    const el = document.createElement('style');
    el.id = 'sup-stijl';
    el.textContent = `
      .sup-bubbel-ons{background:var(--m);color:#fff}
      :root[data-theme="dark"] .sup-bubbel-ons{color:#0B0E13}
      .sup-thread::-webkit-scrollbar{width:9px}
      .sup-thread::-webkit-scrollbar-thumb{background:var(--surface-3);border-radius:5px;border:3px solid var(--surface)}
    `;
    document.head.appendChild(el);
  })();

  const _lijst = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _det = { loading: false, error: null, data: null, id: null, seq: 0, bezig: false, concept: '' };
  const _aanwezig = { loading: false, data: null, bezig: false };
  const _inst = { loading: false, error: null, data: null, bezig: false, melding: null, concept: {} };

  let _hartslag = null;
  let _lijstPoll = null;
  let _detPoll = null;

  const HARTSLAG_MS = 45_000;
  const LIJST_POLL_MS = 20_000;
  const DETAIL_POLL_MS = 8_000;

  /* ── helpers ──────────────────────────────────────────────────────────── */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const dtijd = (iso) => {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const vandaag = new Date();
      const zelfdeDag = d.toDateString() === vandaag.toDateString();
      return zelfdeDag
        ? d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })
        : d.toLocaleString('nl-NL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  };

  const geleden = (iso) => {
    if (!iso) return '—';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'net';
    if (m < 60) return m + ' min';
    const u = Math.floor(m / 60);
    if (u < 24) return u + ' uur';
    return Math.floor(u / 24) + ' dg';
  };

  // Zit de bezoeker nu met de chat open? De widget stuurt met het venster
  // open elke paar seconden een hartslag (klant_gezien_op, zie
  // api/support-poll.js); 40 seconden is dezelfde grens die
  // api/support-antwoord.js gebruikt om te beslissen of er ook gemaild wordt.
  // `null` = onbekend (migratie nog niet gedraaid) — dan tonen we niets.
  const IN_CHAT_MS = 40 * 1000;
  function inChat(g) {
    if (!g || !('klant_gezien_op' in g)) return null;
    const t = Date.parse(g.klant_gezien_op || '');
    return Number.isFinite(t) && Date.now() - t <= IN_CHAT_MS;
  }
  function aanwezigPil(g, klein) {
    const nu = inChat(g);
    if (nu === null || g.status === 'afgehandeld') return '';
    if (nu) {
      return `<span title="De chat staat nu open bij de bezoeker — je antwoord verschijnt direct." style="display:inline-flex;align-items:center;gap:5px;
        padding:${klein ? '1px 7px' : '3px 9px'};border-radius:20px;background:var(--emerald-soft,#e3f7ec);color:var(--emerald,#07835A);
        font-size:${klein ? '11px' : '11.5px'};font-weight:650;white-space:nowrap">
        <span style="width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 3px rgba(7,131,90,.18)"></span>In de chat</span>`;
    }
    if (klein) return '';
    return `<span title="De bezoeker heeft de chat niet open. Je antwoord gaat ook per mail." style="display:inline-flex;align-items:center;gap:5px;
      padding:3px 9px;border-radius:20px;background:var(--surface-2);color:var(--text-2);font-size:11.5px;font-weight:600;white-space:nowrap">
      <span style="width:7px;height:7px;border-radius:50%;background:#A9B4C2"></span>Niet in de chat${g.klant_gezien_op ? ' · ' + geleden(g.klant_gezien_op) + ' geleden' : ''}</span>`;
  }

  function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }
  function setUrlParam(k, v) {
    try {
      const u = new URL(location.href);
      if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
      history.pushState({}, '', u.toString());
    } catch (_) {}
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  }

  async function haal(label, url, timeoutMs = 9000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[support-v2] ophalen mislukt:', label, '→', e?.message || e);
      return null;
    }
  }

  async function stuur(label, url, body, methode = 'POST', timeoutMs = 14000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method: methode, body: JSON.stringify(body) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const tekst = await resp.text();
    const json = tekst ? JSON.parse(tekst) : null;
    if (!resp.ok) {
      console.warn('[support-v2] mislukt:', label, '→', json?.error || resp.status);
      throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status);
    }
    return json;
  }

  const STATUS_PIL = {
    bot:            ['info',    'Bot'],
    wacht_op_ons:   ['warn',    'Wacht op ons'],
    in_behandeling: ['info',    'In behandeling'],
    wacht_op_klant: ['neutral', 'Wacht op klant'],
    afgehandeld:    ['ok',      'Afgehandeld'],
  };
  const ONDERWERP_LABEL = {
    lms: 'LMS', discord: 'Discord', traject: 'Traject', financieel: 'Financieel',
    informatie: 'Informatie', event: 'Event', inschrijving: 'Inschrijving',
    call: 'Gesprek inplannen', overig: 'Overig',
  };
  const STATUS_ACTIE = {
    voorgesteld: 'wacht op besluit',
    goedgekeurd: 'goedgekeurd — nog doen',
    afgewezen: 'afgewezen',
    uitgevoerd: 'gedaan',
    mislukt: 'uitvoeren mislukt',
  };
  const ACTIE_LABEL = {
    LMS_UITNODIGING_OPNIEUW: 'LMS-uitnodiging opnieuw sturen',
    LMS_PROVISIONING_OPNIEUW: 'LMS-account opnieuw aanmaken',
    BETALINGSAFSPRAAK: 'Betalingsafspraak voorbereiden',
    MENTOR_CONTACT: 'Mentor laten bellen',
    HANDMATIG: 'Handmatige actie',
  };

  /* ── aanwezigheid ─────────────────────────────────────────────────────── */
  async function laadAanwezigheid() {
    _aanwezig.loading = true;
    const r = await haal('aanwezigheid', '/api/support-aanwezigheid');
    _aanwezig.loading = false;
    if (r) { _aanwezig.data = r; regelHartslag(); }
    if (window.DFO?.render) window.DFO.render();
  }

  function regelHartslag() {
    stopHartslag();
    if (!_aanwezig.data?.ik_sta_aan) return;
    // Dezelfde stand opnieuw sturen is precies het punt: de server leest de
    // tijd van dit bericht, niet de waarde.
    _hartslag = setInterval(() => {
      stuur('hartslag', '/api/support-aanwezigheid', { beschikbaar: true })
        .catch((e) => console.warn('[support-v2] hartslag mislukt:', e?.message || e));
    }, HARTSLAG_MS);
  }
  function stopHartslag() { if (_hartslag) { clearInterval(_hartslag); _hartslag = null; } }

  window.__supAanwezig = async () => {
    if (_aanwezig.bezig) return;
    _aanwezig.bezig = true;
    const nieuw = !_aanwezig.data?.ik_sta_aan;
    try {
      const r = await stuur('aanwezigheid', '/api/support-aanwezigheid', { beschikbaar: nieuw });
      _aanwezig.data = r;
      regelHartslag();
      if (window.KV?.toast) window.KV.toast(nieuw ? 'Je staat aan voor de live chat' : 'Je staat uit voor de live chat');
    } catch (e) {
      if (window.KV?.toast) window.KV.toast(e.message, 'err');
    }
    _aanwezig.bezig = false;
    if (window.DFO?.render) window.DFO.render();
  };

  /* ── lijst ────────────────────────────────────────────────────────────── */
  function lijstParams(tab) {
    const p = new URLSearchParams();
    if (tab === 'Wachtrij') p.set('status', 'wacht_op_ons');
    if (tab === 'Mijn gesprekken') p.set('mijn', '1');
    if (tab === 'Afgehandeld') p.set('status', 'afgehandeld');
    const zoek = H.getSearchValue ? (H.getSearchValue('sup-q') || '') : '';
    if (zoek) p.set('q', zoek);
    const ond = F('sup-onderwerp', 'alle');
    if (ond && ond !== 'alle') p.set('onderwerp', ond);
    return p.toString();
  }

  async function laadLijst(tab) {
    const params = lijstParams(tab);
    const seq = ++_lijst.seq;
    _lijst.loading = true;
    _lijst.error = null;
    if (window.DFO?.render) window.DFO.render();

    const r = await haal('lijst', '/api/support-gesprekken-list?' + params);
    if (seq !== _lijst.seq) return;              // een nieuwere vraag won
    _lijst.loading = false;
    _lijst.params = params;
    if (!r) _lijst.error = 'Kon de gesprekken niet ophalen.';
    else _lijst.data = r;
    if (window.DFO?.render) window.DFO.render();
  }

  // De tellers komen van de server en tellen over ALLE gesprekken, niet over
  // wat er toevallig in de lijst staat. Anders toont "Bij de bot" op het
  // tabblad Wachtrij altijd nul en is de strip een herhaling van de lijst.
  function kpis() {
    const t = _lijst.data?.tellingen || {};
    const g = _lijst.data?.gesprekken || [];
    const getal = (v) => (v == null ? '—' : v);

    // De langst wachtende komt wél uit de lijst — die staat er alleen in als
    // je ook echt naar de wachtrij kijkt, en dan klopt 'ie.
    const langst = g
      .filter((x) => x.status === 'wacht_op_ons' && x.laatste_klant_bericht_op)
      .map((x) => Date.parse(x.laatste_klant_bericht_op))
      .sort((a, b) => a - b)[0];

    const a = _aanwezig.data;
    return H.kpis([
      { c: 'amber', icon: I.alert, label: 'Wacht op ons', val: getal(t.wacht_op_ons),
        sub: langst ? 'langst: ' + geleden(new Date(langst).toISOString()) : 'niets openstaand',
        hi: (t.wacht_op_ons || 0) > 0 },
      { c: 'violet', icon: I.bot, label: 'Bij de bot', val: getal(t.bot), sub: 'bot handelt zelf af' },
      { c: 'rose', icon: I.check2, label: 'Open acties', val: getal(t.open_acties),
        sub: 'wachten op goedkeuring', hi: (t.open_acties || 0) > 0 },
      { c: a?.live ? 'emerald' : 'slate', icon: I.chat, label: 'Live chat',
        val: a?.live ? 'Aan' : 'Uit',
        sub: a ? (a.online_namen?.length ? a.online_namen.join(', ') : (a.binnen_kantooruren ? 'niemand online' : 'buiten kantooruren')) : '…' },
    ]);
  }

  function balk() {
    const a = _aanwezig.data;
    const aan = !!a?.ik_sta_aan;
    const ond = F('sup-onderwerp', 'alle');
    return H.toolbar([
      H.stableSearch ? H.stableSearch('sup-q', 'Zoek op naam, mail of kenmerk') : H.search('Zoek…'),
      H.chips('sup-onderwerp', [
        { l: 'Alle', v: 'alle' },
        { l: 'LMS', v: 'lms' },
        { l: 'Discord', v: 'discord' },
        { l: 'Traject', v: 'traject' },
        { l: 'Financieel', v: 'financieel' },
        { l: 'Informatie', v: 'informatie' },
      ], ond),
      `<button class="btn ${aan ? 'btn-ghost' : 'btn-primary'}" style="margin-left:auto" onclick="window.__supAanwezig()" ${_aanwezig.bezig ? 'disabled' : ''}>
         <span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;
           background:${aan ? '#07835A' : '#C9D2DE'}"></span>
         ${aan ? 'Ik sta aan' : 'Zet me aan voor live chat'}
       </button>`,
    ]);
  }

  function lijstTabel(tab) {
    if (_lijst.loading && !_lijst.data) {
      return `<div style="padding:40px;text-align:center;color:var(--text-3)">Laden…</div>`;
    }
    if (_lijst.error) {
      return `<div style="margin:16px 20px;padding:14px;border:1px solid var(--rose-line);background:var(--rose-soft);
        border-radius:var(--r);color:var(--rose)">${esc(_lijst.error)}</div>`;
    }
    const rijen = _lijst.data?.gesprekken || [];
    if (!rijen.length) {
      return `<div style="padding:52px 20px;text-align:center;color:var(--text-3)">
        <div style="font-size:14px;color:var(--text-2);margin-bottom:4px">Niets te doen${tab === 'Wachtrij' ? ' — de wachtrij is leeg' : ''}.</div>
        <div style="font-size:12.5px">Nieuwe vragen vanaf de website verschijnen hier vanzelf.</div></div>`;
    }

    window.__supRij = (i) => { const r = rijen[i]; if (r) setUrlParam('gesprek', r.id); };

    const cols = [
      { l: '' }, { l: 'Wie' }, { l: 'Onderwerp' }, { l: 'Laatste bericht' },
      { l: 'Status' }, { l: 'Van ons' }, { l: '' },
    ];
    const data = rijen.map((r) => {
      const [pc, pl] = STATUS_PIL[r.status] || ['neutral', r.status];
      const ongelezen = r.ongelezen_voor_ons > 0;
      return [
        ongelezen ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--amber)"></span>` : '',
        `<div class="cell-main" style="display:flex;align-items:center;gap:7px;${ongelezen ? 'font-weight:650' : ''}">${esc(r.naam || 'Onbekend')}${aanwezigPil(r, true)}</div>
         <div class="cell-sub">${esc(r.email || '')} · ${esc(r.kenmerk)}${r.geverifieerd ? ' · geverifieerd' : ''}</div>`,
        `${esc(ONDERWERP_LABEL[r.onderwerp] || r.onderwerp)}
         <div class="cell-sub">${r.soort === 'klant' ? 'student' : 'bezoeker'}</div>`,
        `${dtijd(r.laatste_bericht_op)}<div class="cell-sub">${geleden(r.laatste_bericht_op)} geleden</div>`,
        H.pill(pc, pl),
        r.toegewezen_naam ? esc(r.toegewezen_naam) : '<span style="color:var(--text-3)">—</span>',
        r.open_acties ? H.pill('warn', r.open_acties + ' actie' + (r.open_acties > 1 ? 's' : '')) : '',
      ];
    });
    return H.table(cols, data, 'window.__supRij');
  }

  /* ── detail ───────────────────────────────────────────────────────────── */
  async function laadDetail(id, stil = false) {
    const seq = ++_det.seq;
    if (!stil) { _det.loading = true; _det.error = null; if (window.DFO?.render) window.DFO.render(); }

    const r = await haal('detail', '/api/support-gesprek-detail?id=' + encodeURIComponent(id));
    if (seq !== _det.seq) return;
    _det.loading = false;
    _det.id = id;
    if (!r) { if (!stil) _det.error = 'Kon het gesprek niet ophalen.'; }
    else {
      // Alleen hertekenen als er iets veranderd is — anders springt de
      // cursor uit het antwoordveld bij elke poll.
      const oudAantal = _det.data?.berichten?.length || 0;
      const nieuwAantal = r.berichten?.length || 0;
      const zelfdeStatus = _det.data?.gesprek?.status === r.gesprek?.status;
      const zelfdeAanwezig = inChat(_det.data?.gesprek) === inChat(r.gesprek);
      const zelfdeMail = mailSig(_det.data?.berichten) === mailSig(r.berichten);
      _det.data = r;
      if (stil && oudAantal === nieuwAantal && zelfdeStatus && zelfdeAanwezig && zelfdeMail) return;
    }
    if (window.DFO?.render) window.DFO.render();
  }

  // Verandert de mailstatus van een antwoord (wacht → gemaild), dan moet
  // het label mee. Een korte vingerafdruk is genoeg.
  function mailSig(berichten) {
    return (berichten || []).filter((b) => b.afzender === 'medewerker').map((b) => b.meta?.mail_status || '').join(',');
  }

  function startDetailPoll(id) {
    stopDetailPoll();
    _detPoll = setInterval(() => {
      if (document.hidden) return;
      laadDetail(id, true);
    }, DETAIL_POLL_MS);
  }
  function stopDetailPoll() { if (_detPoll) { clearInterval(_detPoll); _detPoll = null; } }

  window.__supTerug = () => { stopDetailPoll(); _det.id = null; _det.data = null; setUrlParam('gesprek', null); };
  window.__supConcept = (v) => { _det.concept = v; };

  window.__supAntwoord = async () => {
    const el = document.querySelector('#sup-antwoord');
    const tekst = (el ? el.value : _det.concept || '').trim();
    if (!tekst || _det.bezig) return;
    _det.bezig = true;
    if (window.DFO?.render) window.DFO.render();
    try {
      const r = await stuur('antwoord', '/api/support-antwoord', { gesprek_id: _det.id, tekst });
      _det.concept = '';
      if (window.KV?.toast) {
        const m = r?.mail_status;
        window.KV.toast(
          m === 'niet_nodig' ? 'Verstuurd — de bezoeker zit in de chat en ziet het direct'
          : r?.gemaild ? 'Verstuurd in de chat én per mail'
          : m === 'wacht' ? 'Verstuurd — gaat over een paar minuten gebundeld per mail'
          : m === 'geen_adres' ? 'Verstuurd in de chat — er is geen mailadres, dus geen mail'
          : 'Verstuurd — de mail wordt nog verstuurd');
      }
      await laadDetail(_det.id);
    } catch (e) {
      if (window.KV?.toast) window.KV.toast(e.message, 'err');
    }
    _det.bezig = false;
    if (window.DFO?.render) window.DFO.render();
  };

  window.__supStatus = async (status) => {
    try {
      await stuur('status', '/api/support-gesprek-update', { gesprek_id: _det.id, status }, 'PATCH');
      await laadDetail(_det.id);
      if (window.KV?.toast) window.KV.toast('Bijgewerkt');
    } catch (e) { if (window.KV?.toast) window.KV.toast(e.message, 'err'); }
  };

  window.__supPak = async () => {
    try {
      await stuur('toewijzen', '/api/support-gesprek-update', { gesprek_id: _det.id, toegewezen_aan: 'mij' }, 'PATCH');
      await laadDetail(_det.id);
      if (window.KV?.toast) window.KV.toast('Je hebt dit gesprek opgepakt');
    } catch (e) { if (window.KV?.toast) window.KV.toast(e.message, 'err'); }
  };

  window.__supActie = async (actieId, besluit) => {
    try {
      const r = await stuur('actie', '/api/support-actie-besluit', { actie_id: actieId, besluit });
      await laadDetail(_det.id);
      if (!window.KV?.toast) return;

      // De melding moet zeggen wat er ECHT gebeurde. Sinds S2 kan een
      // goedkeuring de handeling direct uitvoeren — of proberen en falen.
      if (besluit === 'afwijzen') { window.KV.toast('Afgewezen'); return; }
      if (besluit === 'uitgevoerd') { window.KV.toast('Op gedaan gezet, de klant krijgt bericht'); return; }

      const u = r && r.uitvoering;
      if (!u) { window.KV.toast('Goedgekeurd — voer ’m uit en zet hem daarna op gedaan'); return; }
      if (u.status === 'uitgevoerd') { window.KV.toast('Goedgekeurd en uitgevoerd, de klant heeft bericht'); return; }
      window.KV.toast('Goedgekeurd, maar uitvoeren lukte niet — zie de reden bij de actie', 'err');
    } catch (e) {
      // Ook na een fout opnieuw laden. Bij een 409 was een collega je voor en
      // klopt het scherm per definitie niet meer; bij een mislukte
      // slotschrijfactie staat de actie inmiddels op goedgekeurd. In beide
      // gevallen is de oude kaart misleidend.
      try { await laadDetail(_det.id); } catch (_) { /* de melding is leidend */ }
      if (window.KV?.toast) window.KV.toast(e.message, 'err');
    }
  };

  function thread(berichten) {
    if (!berichten?.length) return `<div style="color:var(--text-3);font-size:13px">Nog geen berichten.</div>`;
    return berichten.map((b) => {
      if (b.afzender === 'systeem') {
        return `<div style="align-self:center;max-width:90%;padding:7px 12px;border-radius:9px;
          background:var(--amber-soft);color:var(--amber);font-size:12px;text-align:center">${esc(b.tekst)}</div>`;
      }
      const vanKlant = b.afzender === 'klant';
      const naam = vanKlant ? '' : (b.meta?.afzender_naam || (b.afzender === 'bot' ? 'Sam (bot)' : 'Collega'));
      const vertrouwen = b.afzender === 'bot' && b.meta?.vertrouwen != null
        ? `<span style="margin-left:7px;opacity:.7">${Math.round(b.meta.vertrouwen * 100)}% · ${esc(b.meta.intent || '')}</span>` : '';
      return `<div style="align-self:${vanKlant ? 'flex-start' : 'flex-end'};max-width:78%">
        ${naam ? `<div style="font-size:11px;font-weight:650;color:var(--text-2);margin-bottom:3px;text-align:right">${esc(naam)}${vertrouwen}</div>` : ''}
        <div class="${vanKlant ? '' : 'sup-bubbel-ons'}"
          style="padding:9px 13px;border-radius:13px;font-size:13.3px;line-height:1.5;white-space:pre-wrap;
          ${vanKlant
            ? 'background:var(--surface-2);color:var(--text);border-bottom-left-radius:4px'
            : 'border-bottom-right-radius:4px'}">${esc(b.tekst)}</div>
        <div style="font-size:10.5px;color:var(--text-3);margin-top:3px;text-align:${vanKlant ? 'left' : 'right'}">${dtijd(b.created_at)}${mailLabel(b)}</div>
      </div>`;
    }).join('');
  }

  // Per mail binnengekomen: het afzenderadres klopte, maar een From is te
  // vervalsen — dit bericht staat niet op één lijn met een geverifieerde
  // chat. En een antwoord dat per mail niet aankwam, moet de collega zien;
  // anders denkt iedereen dat de klant het heeft.
  //
  // Bij elk antwoord van ons staat hoe het bij de klant terechtkwam: in de
  // chat (hij zat er), per mail, of nog onderweg.
  const MAIL_LABEL = {
    niet_nodig: ['in de chat getoond', 'var(--emerald,#07835A)', 'De bezoeker had de chat open; er ging geen mail.'],
    direct:     ['mail wordt verstuurd', 'var(--text-3)', 'De bezoeker zat niet in de chat; de mail gaat nu de deur uit.'],
    versturen:  ['mail wordt verstuurd', 'var(--text-3)', 'De bezoeker zat niet in de chat; de mail gaat nu de deur uit.'],
    wacht:      ['mail volgt', 'var(--text-3)', 'Wordt binnen een paar minuten gebundeld met je andere antwoorden per mail verstuurd.'],
    gemaild:    ['✓ gemaild', 'var(--blue,#1f5fbf)', 'Ook per mail naar de bezoeker verstuurd.'],
  };
  function mailLabel(b) {
    if (b.afzender === 'klant' && b.meta?.via === 'mail') {
      return ` · <span title="Via een mailantwoord binnengekomen. Het afzenderadres klopt met dit gesprek, maar is niet geverifieerd.">per mail</span>`;
    }
    if (b.afzender === 'medewerker' && (b.meta?.mail_status === 'mislukt' || b.meta?.mail_status === 'geen_adres')) {
      const uitleg = b.meta.mail_status === 'mislukt' ? 'mail niet aangekomen' : 'geen mailadres';
      return ` · <span style="color:var(--red,#c1272d);font-weight:650">⚠ ${uitleg}</span>`;
    }
    const l = b.afzender === 'medewerker' ? MAIL_LABEL[b.meta?.mail_status] : null;
    if (l) return ` · <span title="${esc(l[2])}" style="color:${l[1]};font-weight:600">${l[0]}</span>`;
    return '';
  }

  function contextPaneel(g, ctx, acties) {
    const blok = (titel, inhoud) => `<div style="margin-bottom:16px">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
        color:var(--text-3);margin-bottom:7px">${titel}</div>${inhoud}</div>`;
    const regel = (l, v, kleur) => `<div style="display:flex;justify-content:space-between;gap:12px;
      padding:5px 0;font-size:12.5px;border-bottom:1px solid var(--surface-2)">
      <span style="color:var(--text-2)">${l}</span>
      <span style="color:${kleur || 'var(--text)'};text-align:right;font-weight:550">${v}</span></div>`;

    let h = '';

    // Openstaande acties bovenaan. Dat is wat er van jou gevraagd wordt; de
    // gegevens eronder zijn achtergrond. Stonden ze onderaan, dan verdwenen
    // ze onder de vouw van een paneel dat toch al scrollt.
    const open = (acties || []).filter((a) => a.status === 'voorgesteld');
    const rest = (acties || []).filter((a) => a.status !== 'voorgesteld');

    if (open.length) {
      h += blok('Wacht op jouw besluit', open.map((a) => `<div style="padding:11px 12px;border:1px solid var(--m-line);
        background:var(--m-soft);border-radius:var(--r);margin-bottom:8px">
        <div style="font-size:12.6px;font-weight:650;color:var(--text);margin-bottom:3px">${esc(ACTIE_LABEL[a.soort] || a.soort)}</div>
        <div style="font-size:12.2px;color:var(--text-2);line-height:1.5;margin-bottom:9px">${esc(a.omschrijving)}</div>
        ${a.payload?.lms_reden ? `<div style="font-size:11.4px;color:var(--text-3);margin-bottom:9px">reden: ${esc(a.payload.lms_reden)}</div>` : ''}
        <div style="display:flex;gap:7px">
          <button class="btn btn-primary btn-sm" onclick="window.__supActie('${a.id}','goedkeuren')">Goedkeuren</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__supActie('${a.id}','afwijzen')">Afwijzen</button>
        </div></div>`).join('')
        + `<div style="font-size:11.4px;color:var(--text-3);line-height:1.5">
             Goedkeuren legt vast dát het mag — uitvoeren doe je zelf en zet je daarna op &ldquo;gedaan&rdquo;.
             De klant krijgt pas bericht bij &ldquo;gedaan&rdquo;.</div>`);
    }

    h += blok('Contact', [
      regel('Naam', esc(g.naam || '—')),
      regel('E-mail', esc(g.email || '—')),
      regel('Telefoon', esc(g.telefoon || '—')),
      regel('Kenmerk', esc(g.kenmerk)),
      regel('Geverifieerd', g.geverifieerd ? 'ja' : 'nee', g.geverifieerd ? 'var(--emerald)' : 'var(--amber)'),
    ].join(''));

    if (!g.geverifieerd) {
      h += `<div style="margin-bottom:16px;padding:11px 13px;border:1px solid var(--amber-line);
        background:var(--amber-soft);border-radius:var(--r);font-size:12.3px;color:var(--amber);line-height:1.5">
        Deze bezoeker heeft zijn mailadres nog niet bevestigd. De bot heeft daarom geen persoonlijke gegevens
        gezien — en jij ziet ze hier ook niet. Controleer zelf wie je voor je hebt voor je iets deelt.</div>`;
    }

    if (ctx?.klant_gevonden) {
      const l = ctx.lms || {};
      h += blok('LMS', [
        regel('Status', esc(l.onbereikbaar ? 'niet op te vragen' : (l.reden || '—')),
          l.reden === 'account_actief' ? 'var(--emerald)' : 'var(--amber)'),
        l.toelichting ? `<div style="font-size:12.2px;color:var(--text-2);line-height:1.5;padding:7px 0">${esc(l.toelichting)}</div>` : '',
        l.traject_einddatum ? regel('Traject tot', esc(l.traject_einddatum)) : '',
      ].join(''));

      if (ctx.facturen && !ctx.facturen.onbereikbaar) {
        h += blok('Facturen', [
          regel('Open', ctx.facturen.open_aantal),
          regel('Vervallen', ctx.facturen.vervallen_aantal, ctx.facturen.vervallen_aantal > 0 ? 'var(--rose)' : null),
          ctx.lopende_betalingsafspraak
            ? regel('Afspraak', esc(ctx.lopende_betalingsafspraak.type + ' · ' + ctx.lopende_betalingsafspraak.status))
            : '',
        ].join(''));
      }

      if (ctx.stilte) {
        h += `<div style="margin-bottom:16px;padding:11px 13px;border:1px solid var(--blue-line);
          background:var(--blue-soft);border-radius:var(--r);font-size:12.3px;color:var(--blue);line-height:1.5">
          Er loopt al een afspraak tot en met <b>${esc(ctx.stilte.stil_tot)}</b>${ctx.stilte.door_naam ? ' (met ' + esc(ctx.stilte.door_naam) + ')' : ''}.
          Laat de student dat niet opnieuw uitleggen.</div>`;
      }

      h += blok('Traject', [
        regel('Onboarding', esc(ctx.onboarding_status || '—')),
        regel('Mentor', esc(ctx.mentor?.naam || '—')),
        regel('Volgende sessie', ctx.volgende_sessie?.start_tijd ? dtijd(ctx.volgende_sessie.start_tijd) : '—'),
      ].join(''));

      if (ctx.customer_id) {
        h += `<a class="btn btn-ghost btn-sm" style="display:block;text-align:center;margin-bottom:16px"
          href="/modules/klanten-v2/?mod=klanten&klant=${esc(ctx.customer_id)}">Open het klantdossier</a>`;
      }
    } else if (g.geverifieerd) {
      h += `<div style="margin-bottom:16px;padding:11px 13px;border:1px solid var(--surface-3);
        background:var(--surface-2);border-radius:var(--r);font-size:12.3px;color:var(--text-2);line-height:1.5">
        Mailadres bevestigd, maar er staat geen klant met dit adres in het systeem.</div>`;
    }

    if (rest.length) {
      h += blok('Eerdere acties', rest.map((a) => {
        const mislukt = a.status === 'mislukt';
        return `<div style="padding:9px 12px;border:1px solid ${mislukt ? 'var(--rose-line)' : 'var(--border)'};
          background:${mislukt ? 'var(--rose-soft)' : 'transparent'};border-radius:var(--r);margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div><div style="font-size:12.3px;color:var(--text)">${esc(ACTIE_LABEL[a.soort] || a.soort)}</div>
            <div style="font-size:11.4px;color:${mislukt ? 'var(--rose)' : 'var(--text-3)'}">${esc(STATUS_ACTIE[a.status] || a.status)}</div></div>
            ${a.status === 'goedgekeurd'
              ? `<button class="btn btn-ghost btn-sm" onclick="window.__supActie('${a.id}','uitgevoerd')">Gedaan</button>` : ''}
            ${mislukt
              ? `<button class="btn btn-ghost btn-sm" onclick="window.__supActie('${a.id}','uitgevoerd')">Toch gedaan</button>` : ''}
          </div>
          ${mislukt && a.besluit_reden
            ? `<div style="font-size:11.6px;color:var(--rose);line-height:1.5;margin-top:7px">${esc(a.besluit_reden)}</div>` : ''}
        </div>`;
      }).join(''));
    }

    return h;
  }

  function antwoordHint(g) {
    const nu = inChat(g);
    if (nu === true) return '<b style="color:var(--emerald,#07835A)">De bezoeker zit nu in de chat</b> — je antwoord verschijnt daar direct.';
    if (nu === false) {
      return g.email
        ? `De bezoeker heeft de chat niet open — je antwoord gaat ook per mail naar <b>${esc(g.email)}</b>.`
        : 'De bezoeker heeft de chat niet open en er is geen mailadres — je antwoord staat alleen in de chat.';
    }
    return 'Kijkt de bezoeker niet meer mee, dan gaat je antwoord ook per mail.';
  }

  function detailView() {
    const id = urlParam('gesprek');
    if (!id) return '';

    if (_det.id !== id && !_det.loading) {
      queueMicrotask(() => { laadDetail(id); startDetailPoll(id); });
    }

    if (_det.loading && !_det.data) {
      return `<div style="padding:42px;text-align:center;color:var(--text-3)">Gesprek laden…</div>`;
    }
    if (_det.error) {
      return `<div style="margin:16px 20px;padding:14px;border:1px solid var(--rose-line);background:var(--rose-soft);
        border-radius:var(--r);color:var(--rose)">${esc(_det.error)}
        <button class="btn btn-ghost btn-sm" style="margin-left:12px" onclick="window.__supTerug()">Terug</button></div>`;
    }

    const d = _det.data;
    if (!d?.gesprek) return '';
    const g = d.gesprek;
    const [pc, pl] = STATUS_PIL[g.status] || ['neutral', g.status];
    const klaar = g.status === 'afgehandeld';

    return `
    <div style="padding:16px 20px 0">
      <button class="btn btn-ghost btn-sm" onclick="window.__supTerug()">&lsaquo; Terug naar de lijst</button>
    </div>

    <div style="display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:18px;padding:14px 20px 20px;align-items:start">

      <div style="border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);
        display:flex;flex-direction:column;height:calc(100vh - 230px);min-height:460px;overflow:hidden">

        <div style="flex:0 0 auto;padding:13px 16px;border-bottom:1px solid var(--border);
          display:flex;align-items:center;gap:11px;flex-wrap:wrap">
          <div style="flex:1;min-width:150px">
            <div style="font-size:14.5px;font-weight:650;color:var(--text)">${esc(g.naam || 'Onbekend')}</div>
            <div style="font-size:12px;color:var(--text-2)">${esc(ONDERWERP_LABEL[g.onderwerp] || g.onderwerp)} · ${esc(g.kenmerk)}</div>
          </div>
          ${aanwezigPil(g, false)}
          ${H.pill(pc, pl)}
          ${!g.toegewezen_aan && !klaar ? `<button class="btn btn-sm btn-primary" onclick="window.__supPak()">Oppakken</button>` : ''}
          ${!klaar ? `<button class="btn btn-ghost btn-sm" onclick="window.__supStatus('afgehandeld')">Afronden</button>`
                   : `<button class="btn btn-ghost btn-sm" onclick="window.__supStatus('in_behandeling')">Heropenen</button>`}
        </div>

        <div id="sup-thread" class="sup-thread" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px">
          ${thread(d.berichten)}
        </div>

        <div style="flex:0 0 auto;border-top:1px solid var(--border);padding:11px 13px">
          ${klaar
            ? `<div style="font-size:12.5px;color:var(--text-3);text-align:center;padding:6px">
                 Dit gesprek is afgerond. Heropen het om nog te kunnen antwoorden.</div>`
            : `<div style="display:flex;gap:9px;align-items:flex-end">
                 <textarea id="sup-antwoord" rows="2" placeholder="Typ je antwoord…"
                   oninput="window.__supConcept(this.value)"
                   style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:10px;
                     font:inherit;font-size:13.3px;line-height:1.5;resize:vertical;min-height:44px;max-height:150px;
                     background:var(--surface);color:var(--text)">${esc(_det.concept)}</textarea>
                 <button class="btn btn-primary" onclick="window.__supAntwoord()" ${_det.bezig ? 'disabled' : ''}
                   style="height:44px;padding:0 18px">${_det.bezig ? '…' : 'Stuur'}</button>
               </div>
               <div style="font-size:11.4px;color:var(--text-3);margin-top:6px">${antwoordHint(g)}</div>`}
        </div>
      </div>

      <div style="border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);
        padding:16px;max-height:calc(100vh - 230px);overflow-y:auto">
        ${contextPaneel(g, d.context, d.acties)}
      </div>
    </div>`;
  }

  /* ── instellingen ─────────────────────────────────────────────────────── */
  //
  // Alles hier stond eerst alleen in de database. Zonder dit scherm is
  // "we zijn voortaan tot 18:00 bereikbaar" een SQL-opdracht, en dan
  // verandert het nooit.

  const DAGEN = [[1, 'ma'], [2, 'di'], [3, 'wo'], [4, 'do'], [5, 'vr'], [6, 'za'], [0, 'zo']];

  async function laadInstellingen() {
    _inst.loading = true; _inst.error = null;
    if (window.DFO?.render) window.DFO.render();
    const r = await haal('instellingen', '/api/support-instellingen');
    _inst.loading = false;
    if (!r) _inst.error = 'Kon de instellingen niet ophalen.';
    else { _inst.data = r; _inst.concept = {}; }
    if (window.DFO?.render) window.DFO.render();
  }

  // Wijzigingen verzamelen in _inst.concept en pas bij Opslaan versturen.
  // Per toetsaanslag opslaan zou betekenen dat een half ingetypte tijd ook
  // echt de kantooruren wordt.
  window.__supInst = (pad, waarde) => {
    const [groep, veld] = pad.split('.');
    _inst.concept[groep] = _inst.concept[groep] || {};
    _inst.concept[groep][veld] = waarde;
  };

  window.__supInstDag = (dag, el) => {
    const huidig = _inst.concept.kantooruren?.dagen
      || _inst.data?.kantooruren?.dagen || [1, 2, 3, 4, 5];
    const set = new Set(huidig.map(Number));
    if (el.checked) set.add(Number(dag)); else set.delete(Number(dag));
    window.__supInst('kantooruren.dagen', [...set].sort((a, b) => a - b));
  };

  window.__supInstOpslaan = async () => {
    if (_inst.bezig) return;
    // De kantooruren gaan als geheel mee: de server valideert start, eind,
    // dagen en tijdzone samen, en een half object zou de andere velden
    // wissen.
    const body = {};
    if (_inst.concept.kantooruren) {
      body.kantooruren = { ...(_inst.data?.kantooruren || {}), ...(_inst.concept.kantooruren) };
    }
    if (_inst.concept.widget) body.widget = _inst.concept.widget;
    if (_inst.concept.bot) body.bot = _inst.concept.bot;
    if (!Object.keys(body).length) { if (window.KV?.toast) window.KV.toast('Er is niets gewijzigd'); return; }

    _inst.bezig = true;
    if (window.DFO?.render) window.DFO.render();
    try {
      const r = await stuur('instellingen', '/api/support-instellingen', body, 'PATCH');
      _inst.data = r; _inst.concept = {};
      if (window.KV?.toast) window.KV.toast('Opgeslagen');
    } catch (e) {
      _inst.error = e.message;
      if (window.KV?.toast) window.KV.toast(e.message, 'err');
    }
    _inst.bezig = false;
    if (window.DFO?.render) window.DFO.render();
  };

  window.__supKopieer = async (tekst) => {
    try {
      await navigator.clipboard.writeText(tekst);
      if (window.KV?.toast) window.KV.toast('Gekopieerd');
    } catch (_) {
      if (window.KV?.toast) window.KV.toast('Kopiëren lukte niet — selecteer de regel handmatig', 'err');
    }
  };

  function kaart(titel, uitleg, inhoud) {
    return `<div style="border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);
      padding:18px;margin-bottom:16px">
      <div style="font-size:14px;font-weight:650;color:var(--text);margin-bottom:3px">${titel}</div>
      ${uitleg ? `<div style="font-size:12.4px;color:var(--text-2);line-height:1.5;margin-bottom:14px">${uitleg}</div>` : ''}
      ${inhoud}</div>`;
  }

  function veld(label, inner, hint) {
    return `<div style="margin-bottom:13px">
      <label style="display:block;font-size:12.3px;font-weight:600;color:var(--text);margin-bottom:5px">${label}</label>
      ${inner}
      ${hint ? `<div style="font-size:11.4px;color:var(--text-3);margin-top:4px;line-height:1.45">${hint}</div>` : ''}
    </div>`;
  }

  const invoerStijl = 'width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:9px;'
    + 'font:inherit;font-size:13.2px;background:var(--surface);color:var(--text);outline:none';

  function instellingenView() {
    if (!_inst.data && !_inst.loading && !_inst.error) queueMicrotask(laadInstellingen);
    if (_inst.loading && !_inst.data) return `<div style="padding:42px;text-align:center;color:var(--text-3)">Instellingen laden…</div>`;
    if (_inst.error && !_inst.data) {
      return `<div style="margin:16px 20px;padding:14px;border:1px solid var(--rose-line);background:var(--rose-soft);
        border-radius:var(--r);color:var(--rose)">${esc(_inst.error)}</div>`;
    }

    const d = _inst.data || {};
    const uren = { ...(d.kantooruren || { tz: 'Europe/Amsterdam', dagen: [1, 2, 3, 4, 5], start: '09:00', eind: '17:30' }), ...(_inst.concept.kantooruren || {}) };
    const w = { ...(d.widget || {}), ...(_inst.concept.widget || {}) };
    const bot = { ...(d.bot || {}), ...(_inst.concept.bot || {}) };
    const mag = d.mag_wijzigen !== false;
    const ro = mag ? '' : ' disabled';

    return `<div style="max-width:780px;padding:18px 20px 30px">

      ${!mag ? `<div style="margin-bottom:16px;padding:11px 13px;border:1px solid var(--border);
        background:var(--surface-2);border-radius:var(--r);font-size:12.4px;color:var(--text-2)">
        Je kunt deze instellingen bekijken maar niet wijzigen — daarvoor is het recht
        <code>support.config</code> nodig.</div>` : ''}

      ${kaart('De widget op de website',
        'Eén regel in Webflow → Site settings → Custom code → Footer. Staat die er eenmaal, dan is alles hieronder aan te passen zonder de website aan te raken.',
        `<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px">
           <code style="flex:1;padding:9px 11px;background:var(--surface-2);border-radius:9px;
             font-family:'IBM Plex Mono',monospace;font-size:11.8px;color:var(--text-2);overflow-x:auto;white-space:nowrap">${esc(d.widget_snippet || '')}</code>
           <button class="btn btn-ghost btn-sm" onclick="window.__supKopieer(this.previousElementSibling.textContent)">Kopieer</button>
         </div>
         ${veld('Widget staat aan',
           `<label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer">
              <input type="checkbox" ${w.aan ? 'checked' : ''}${ro}
                onchange="window.__supInst('widget.aan', this.checked)">
              <span>Bezoekers zien de chatknop</span></label>`,
           'Uit betekent: de knop verschijnt niet meer. Lopende gesprekken blijven gewoon in de module staan.')}
         ${veld('Titel', `<input style="${invoerStijl}" value="${esc(w.titel || '')}"${ro} oninput="window.__supInst('widget.titel', this.value)">`)}
         ${veld('Welkomstzin', `<input style="${invoerStijl}" value="${esc(w.welkom || '')}"${ro} oninput="window.__supInst('widget.welkom', this.value)">`)}
         ${veld('Antwoordadres',
           `<input style="${invoerStijl}" value="${esc(w.antwoord_mailbox || '')}"${ro} oninput="window.__supInst('widget.antwoord_mailbox', this.value)">`,
           'Moet een eigen @deforexopleiding.nl-mailbox zijn — een ander domein komt niet door SPF en belandt in de spam.')}
         ${veld('Link naar de agenda', `<input style="${invoerStijl}" value="${esc(w.agenda_url || '')}"${ro} oninput="window.__supInst('widget.agenda_url', this.value)">`)}
         ${veld('Link naar de events', `<input style="${invoerStijl}" value="${esc(w.events_url || '')}"${ro} oninput="window.__supInst('widget.events_url', this.value)">`)}`)}

      ${kaart('Bereikbaarheid',
        `Binnen deze uren én met minstens één collega op &ldquo;ik sta aan&rdquo; belooft de widget live chat. Daarbuiten krijgt de bezoeker te horen dat het antwoord per mail komt. Nu ingesteld: <b>${esc(d.kantooruren_label || '—')}</b>.`,
        `${veld('Dagen',
          `<div style="display:flex;gap:6px;flex-wrap:wrap">${DAGEN.map(([n, l]) => `
             <label style="display:inline-flex;align-items:center;gap:6px;padding:7px 11px;border:1px solid var(--border);
               border-radius:9px;font-size:12.5px;color:var(--text-2);cursor:pointer;background:${(uren.dagen || []).includes(n) ? 'var(--m-soft)' : 'var(--surface)'}">
               <input type="checkbox" ${(uren.dagen || []).includes(n) ? 'checked' : ''}${ro}
                 onchange="window.__supInstDag(${n}, this)">${l}</label>`).join('')}</div>`)}
         <div style="display:flex;gap:12px">
           <div style="flex:1">${veld('Van', `<input style="${invoerStijl}" value="${esc(uren.start || '')}" placeholder="09:00"${ro} oninput="window.__supInst('kantooruren.start', this.value)">`)}</div>
           <div style="flex:1">${veld('Tot', `<input style="${invoerStijl}" value="${esc(uren.eind || '')}" placeholder="17:30"${ro} oninput="window.__supInst('kantooruren.eind', this.value)">`)}</div>
         </div>
         ${veld('Tijdzone', `<input style="${invoerStijl}" value="${esc(uren.tz || '')}"${ro} oninput="window.__supInst('kantooruren.tz', this.value)">`,
           'Een IANA-zone zoals Europe/Amsterdam, geen +02:00 — dan klopt de zomertijd vanzelf.')}`)}

      ${kaart('De bot',
        `Sam beantwoordt wat 'ie zeker weet en zet de rest door naar de wachtrij. Welke onderwerpen hij zelf mag doen en bij welk vertrouwen, staat in <code>joost_config.autonomy_config</code> — dat is bewust geen veldje hier.`,
        `${veld('Bot staat aan',
           `<label style="display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--text-2);cursor:pointer">
              <input type="checkbox" ${bot.is_enabled ? 'checked' : ''}${ro}
                onchange="window.__supInst('bot.is_enabled', this.checked)">
              <span>Sam antwoordt zelf</span></label>`,
           'Uit betekent: elk gesprek gaat direct naar de wachtrij. Handig als je even wilt meekijken.')}
         ${veld('Naam', `<input style="${invoerStijl}" value="${esc(bot.persona_name || '')}"${ro} oninput="window.__supInst('bot.persona_name', this.value)">`)}
         ${veld('Instructie',
           `<textarea style="${invoerStijl};min-height:190px;line-height:1.5;resize:vertical;font-family:'IBM Plex Mono',monospace;font-size:12.2px"${ro}
             oninput="window.__supInst('bot.system_prompt_template', this.value)">${esc(bot.system_prompt_template || '')}</textarea>`,
           'Dit is letterlijk wat Sam als opdracht meekrijgt. <code>{klant_naam}</code> wordt vervangen door de voornaam als die bekend is.')}
         ${veld('Temperatuur', `<input style="${invoerStijl};max-width:120px" value="${esc(String(bot.temperature ?? 0.3))}"${ro} oninput="window.__supInst('bot.temperature', this.value)">`,
           'Tussen 0 en 1. Laag is voorspelbaar en saai, hoog is losser en minder betrouwbaar. 0.3 is een goede plek voor support.')}
         ${bot.feature_flags ? `<div style="font-size:11.6px;color:var(--text-3);line-height:1.6;margin-top:6px">
            Fases: ${Object.entries(bot.feature_flags).map(([k, v]) => `<code>${esc(k)}</code> ${v ? 'aan' : 'uit'}`).join(' · ')}</div>` : ''}`)}

      ${mag ? `<button class="btn btn-primary" onclick="window.__supInstOpslaan()" ${_inst.bezig ? 'disabled' : ''}
        style="padding:10px 20px">${_inst.bezig ? 'Opslaan…' : 'Wijzigingen opslaan'}</button>` : ''}
      ${_inst.error ? `<div style="margin-top:12px;padding:11px 13px;border:1px solid var(--rose-line);
        background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:12.6px">${esc(_inst.error)}</div>` : ''}
    </div>`;
  }

  /* ── tabs ─────────────────────────────────────────────────────────────── */
  function lijstView(tab) {
    const params = lijstParams(tab);
    if (!_lijst.loading && (_lijst.data === null || _lijst.params !== params)) {
      queueMicrotask(() => laadLijst(tab));
    }
    if (!_aanwezig.data && !_aanwezig.loading) queueMicrotask(laadAanwezigheid);
    if (!_lijstPoll) {
      _lijstPoll = setInterval(() => {
        if (document.hidden || urlParam('gesprek')) return;
        laadLijst(tab);
      }, LIJST_POLL_MS);
    }
    return kpis() + balk() + lijstTabel(tab);
  }

  function wrap(tab) {
    return () => {
      if (tab === 'Instellingen') { stopDetailPoll(); return instellingenView(); }
      if (urlParam('gesprek')) return detailView();
      stopDetailPoll();
      if (_det.id) { _det.id = null; _det.data = null; _det.error = null; }
      return lijstView(tab);
    };
  }

  window.DFO.VIEWS['support/Wachtrij']        = wrap('Wachtrij');
  window.DFO.VIEWS['support/Mijn gesprekken'] = wrap('Mijn gesprekken');
  window.DFO.VIEWS['support/Alles']           = wrap('Alles');
  window.DFO.VIEWS['support/Afgehandeld']     = wrap('Afgehandeld');
  window.DFO.VIEWS['support/Instellingen']   = wrap('Instellingen');

  // Opruimen. Een setInterval die een modulewissel overleeft blijft de
  // server bevragen voor een scherm dat niemand ziet — en dat is in dit
  // project al eens misgegaan met de nav-badge.
  function ruimOp() {
    stopHartslag();
    stopDetailPoll();
    if (_lijstPoll) { clearInterval(_lijstPoll); _lijstPoll = null; }
  }
  window.addEventListener('beforeunload', ruimOp);
  window.addEventListener('popstate', () => {
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && urlParam('gesprek')) { e.preventDefault(); window.__supTerug(); }
  });

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('support');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('support');

  console.debug('[support-v2] 4 views + detail geregistreerd');
})();
