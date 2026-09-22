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

  const _lijst = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _det = { loading: false, error: null, data: null, id: null, seq: 0, bezig: false, concept: '' };
  const _aanwezig = { loading: false, data: null, bezig: false };

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

  function kpis() {
    const g = _lijst.data?.gesprekken || [];
    const wacht = g.filter((x) => x.status === 'wacht_op_ons').length;
    const bot = g.filter((x) => x.status === 'bot').length;
    const acties = g.reduce((s, x) => s + (x.open_acties || 0), 0);
    const langst = g
      .filter((x) => x.status === 'wacht_op_ons' && x.laatste_klant_bericht_op)
      .map((x) => Date.parse(x.laatste_klant_bericht_op))
      .sort((a, b) => a - b)[0];

    const a = _aanwezig.data;
    return H.kpis([
      { c: 'amber',   icon: I.alert,  label: 'Wacht op ons',    val: wacht,  sub: wacht ? 'langst: ' + geleden(langst ? new Date(langst).toISOString() : null) : 'niets openstaand', hi: wacht > 0 },
      { c: 'violet',  icon: I.bot,    label: 'Bij de bot',      val: bot,    sub: 'zelf afgehandeld' },
      { c: 'rose',    icon: I.check2, label: 'Open acties',     val: acties, sub: 'wachten op goedkeuring', hi: acties > 0 },
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
      `<button class="btn ${aan ? '' : 'btn-primary'}" style="margin-left:auto" onclick="window.__supAanwezig()" ${_aanwezig.bezig ? 'disabled' : ''}>
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
        `<div class="cell-main" style="${ongelezen ? 'font-weight:650' : ''}">${esc(r.naam || 'Onbekend')}</div>
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
      _det.data = r;
      if (stil && oudAantal === nieuwAantal && zelfdeStatus) return;
    }
    if (window.DFO?.render) window.DFO.render();
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
      if (window.KV?.toast) window.KV.toast(r?.gemaild ? 'Verstuurd — ook per mail' : 'Verstuurd');
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
      await stuur('actie', '/api/support-actie-besluit', { actie_id: actieId, besluit });
      await laadDetail(_det.id);
      if (window.KV?.toast) window.KV.toast(
        besluit === 'goedkeuren' ? 'Goedgekeurd — voer ’m uit en zet hem daarna op gedaan'
          : besluit === 'uitgevoerd' ? 'Op uitgevoerd gezet, de klant krijgt bericht' : 'Afgewezen');
    } catch (e) { if (window.KV?.toast) window.KV.toast(e.message, 'err'); }
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
        <div style="padding:9px 13px;border-radius:13px;font-size:13.3px;line-height:1.5;white-space:pre-wrap;
          ${vanKlant
            ? 'background:var(--surface-2);color:var(--text);border-bottom-left-radius:4px'
            : 'background:var(--m);color:#fff;border-bottom-right-radius:4px'}">${esc(b.tekst)}</div>
        <div style="font-size:10.5px;color:var(--text-3);margin-top:3px;text-align:${vanKlant ? 'left' : 'right'}">${dtijd(b.created_at)}</div>
      </div>`;
    }).join('');
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
        h += `<a class="btn btn-sm" style="display:block;text-align:center;margin-bottom:16px"
          href="/modules/klanten-v2/?mod=klanten&klant=${esc(ctx.customer_id)}">Open het klantdossier</a>`;
      }
    } else if (g.geverifieerd) {
      h += `<div style="margin-bottom:16px;padding:11px 13px;border:1px solid var(--surface-3);
        background:var(--surface-2);border-radius:var(--r);font-size:12.3px;color:var(--text-2);line-height:1.5">
        Mailadres bevestigd, maar er staat geen klant met dit adres in het systeem.</div>`;
    }

    const open = (acties || []).filter((a) => a.status === 'voorgesteld');
    const rest = (acties || []).filter((a) => a.status !== 'voorgesteld');

    if (open.length || rest.length) {
      h += blok('Voorgestelde acties', [
        ...open.map((a) => `<div style="padding:11px 12px;border:1px solid var(--m-line);background:var(--m-soft);
          border-radius:var(--r);margin-bottom:8px">
          <div style="font-size:12.6px;font-weight:650;color:var(--text);margin-bottom:3px">${esc(ACTIE_LABEL[a.soort] || a.soort)}</div>
          <div style="font-size:12.2px;color:var(--text-2);line-height:1.5;margin-bottom:9px">${esc(a.omschrijving)}</div>
          ${a.payload?.lms_reden ? `<div style="font-size:11.4px;color:var(--text-3);margin-bottom:9px">reden: ${esc(a.payload.lms_reden)}</div>` : ''}
          <div style="display:flex;gap:7px">
            <button class="btn btn-sm btn-primary" onclick="window.__supActie('${a.id}','goedkeuren')">Goedkeuren</button>
            <button class="btn btn-sm" onclick="window.__supActie('${a.id}','afwijzen')">Afwijzen</button>
          </div></div>`),
        ...rest.map((a) => `<div style="padding:9px 12px;border:1px solid var(--border);border-radius:var(--r);
          margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div><div style="font-size:12.3px;color:var(--text)">${esc(ACTIE_LABEL[a.soort] || a.soort)}</div>
          <div style="font-size:11.4px;color:var(--text-3)">${esc(a.status)}</div></div>
          ${a.status === 'goedgekeurd'
            ? `<button class="btn btn-sm" onclick="window.__supActie('${a.id}','uitgevoerd')">Gedaan</button>` : ''}
        </div>`),
      ].join(''));

      if (open.length) {
        h += `<div style="font-size:11.4px;color:var(--text-3);line-height:1.5;margin-top:-6px;margin-bottom:16px">
          Goedkeuren legt vast dát het mag — uitvoeren doe je zelf en zet je daarna op “gedaan”.
          De klant krijgt pas bericht bij “gedaan”.</div>`;
      }
    }

    return h;
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
        <button class="btn btn-sm" style="margin-left:12px" onclick="window.__supTerug()">Terug</button></div>`;
    }

    const d = _det.data;
    if (!d?.gesprek) return '';
    const g = d.gesprek;
    const [pc, pl] = STATUS_PIL[g.status] || ['neutral', g.status];
    const klaar = g.status === 'afgehandeld';

    return `
    <div style="padding:16px 20px 0">
      <button class="btn btn-sm" onclick="window.__supTerug()">&lsaquo; Terug naar de lijst</button>
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
          ${H.pill(pc, pl)}
          ${!g.toegewezen_aan && !klaar ? `<button class="btn btn-sm btn-primary" onclick="window.__supPak()">Oppakken</button>` : ''}
          ${!klaar ? `<button class="btn btn-sm" onclick="window.__supStatus('afgehandeld')">Afronden</button>`
                   : `<button class="btn btn-sm" onclick="window.__supStatus('in_behandeling')">Heropenen</button>`}
        </div>

        <div id="sup-thread" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px">
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
               <div style="font-size:11.2px;color:var(--text-3);margin-top:6px">
                 Kijkt de bezoeker niet meer mee, dan gaat je antwoord ook per mail.</div>`}
        </div>
      </div>

      <div style="border:1px solid var(--border);border-radius:var(--r-lg);background:var(--surface);
        padding:16px;max-height:calc(100vh - 230px);overflow-y:auto">
        ${contextPaneel(g, d.context, d.acties)}
      </div>
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
