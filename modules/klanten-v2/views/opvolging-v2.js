// modules/klanten-v2/views/opvolging-v2.js
//
// Opvolging — het dagsysteem voor Dave. Fase 1.
//
// Nieuw bestand. Raakt geen bestaande view aan en registreert zich op eigen
// sleutels in window.DFO.VIEWS. De oude Follow-up-module blijft ongewijzigd.
//
// Fase 1 levert: de takenlijst met de weekbalk, de twee rondes per dag, het
// blok "wacht op inplanning", het beslisvenster "Wat nu?", het dashboard met
// de dekking van de dag, en Afgerond met de historiek per lead.
//
// Bewust NIET in fase 1 (en daarom leeg met een duidelijke melding, nooit met
// verzonnen cijfers): de spraakberichten- en nabelblokken en de calls van
// vandaag. Die hangen aan de WhatsApp-brug en de agendakoppeling — fase 2 en 3.
//
// Fase 2 voegt toe: belpogingen worden automatisch geteld (de softphone
// stuurt de taak-id mee in zijn call-log), en 'Opnieuw inplannen' opent een
// echte weekweergave uit de agenda in plaats van alleen een datumveld.
//
// Fase 3a voegt toe: het blok 'Calls van vandaag' boven de takenlijst, gevoed
// uit dezelfde agenda als de weekweergave. Afronden van een call maakt hooguit
// een taak aan; de afspraakrecords zelf blijven ongemoeid.
//
// Het lampje rechtsboven in Vandaag toont of de WhatsApp-brug gekoppeld is, en
// het paneel erachter laat Maxim of Dave zelf opnieuw koppelen als de sessie
// eruit ligt. Alleen lezen, via het bestaande /api/opvolging-whatsapp-status.
//
// Endpoints: /api/opvolging-taken, /api/opvolging-dag,
//            /api/opvolging-taak-update, /api/opvolging-poging,
//            /api/opvolging-agenda (fase 2),
//            /api/opvolging-taak-create (fase 3a),
//            /api/opvolging-whatsapp-status (alleen lezen),
//            /api/opvolging-aanmelding-actie
//
// Aanmeldingen voor een event stromen binnen via cron-opvolging-aanmeldingen en
// staan hier gegroepeerd per event. Ze hebben eigen uitgangen: er is nog niets
// gebeurd, dus 'opnieuw inplannen' slaat er niet op.

(function () {
  if (!window.DFO) { console.error('[opvolging-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[opvolging-v2] KV_V2.helpers niet geladen.'); return; }

  const DOEL_BELLEN = 2;
  // Zoveel dagen voor het event komt een aanmeldkaart terug voor de
  // reminder-call. Dit is een kopie van WAKKER_DAGEN_VOOR_EVENT uit
  // api/_lib/opvolging-aanmelding.js — een browser-view kan daar niet uit
  // importeren. Het venster hier vertelt Dave op welke dag de kaart terugkomt,
  // en de server bepaalt die dag echt; lopen ze uiteen, dan belooft het scherm
  // iets anders dan er gebeurt. Daarom bewaakt tests/opvolging-bevestigd.test.js
  // dat deze twee gelijk blijven.
  const WAKKER_DAGEN = 4;
  const ARCHIEF_MIN_DAGEN = 3;   // belpogingen op zoveel verschillende dagen
  const ARCHIEF_MIN_WA = 1;

  const render = () => { if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render(); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  const vandaag = () => iso(Date.now());
  const dagPlus = (basis, n) => { const d = new Date(basis + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const nl = (d) => (d ? d.slice(8) + '/' + d.slice(5, 7) : '—');
  const uur = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // ═════════════════════════════════════════════════════════════════════════
  // STAAT
  // ═════════════════════════════════════════════════════════════════════════
  const _live = {
    taken: { loading: false, error: null, data: null, key: null },
    dash: { loading: false, error: null, data: null, key: null },
    archief: { loading: false, error: null, data: null },
  };
  const _ui = {
    dagView: null,          // null = vandaag
    modal: null,            // { soort, taakId, ... }
    bezig: false,
    weekOffset: 0,          // 0 = de week die de balk bij openen toont
  };

  // Hoe ver de weekbalk vooruit en achteruit mag. Niet omdat er een grens
  // nodig is in de data — taken staan er gewoon — maar zodat een blijven
  // klikken op de pijl niet in een jaar ver weg eindigt zonder dat iemand
  // doorheeft waar hij is.
  const WEEK_MIN_OFFSET = -8;
  const WEEK_MAX_OFFSET = 8;

  // Fase 2 — de agenda achter 'Opnieuw inplannen'. weekStart is de maandag
  // die getoond wordt; weekOffset telt hoeveel weken we vooruit staan zodat
  // de pijlen op zes weken kunnen stoppen.
  const AGENDA_MAX_WEKEN = 6;
  const _agenda = { loading: false, error: null, data: null, key: null, offset: 0 };

  // Fase 3a — de calls van de getoonde dag. Zelfde bron als de weekweergave
  // (/api/opvolging-agenda), maar dan één dag: de bezette momenten daarin
  // zijn Daves calls.
  const _calls = { loading: false, error: null, data: null, key: null };

  // ── De WhatsApp-brug ──────────────────────────────────────────────────────
  // Een lampje rechtsboven en een paneel om opnieuw te koppelen als de sessie
  // eruit ligt. Leest alleen /api/opvolging-whatsapp-status; er wordt hier
  // niets geschreven en er komt geen endpoint bij.
  const WA_POLL_RUSTIG_MS  = 60000;   // lampje op de achtergrond
  const WA_POLL_PANEEL_MS  = 5000;    // paneel open en nog niet gekoppeld
  const WA_POLL_QR_MS      = 20000;   // de QR verloopt, dus die halen we opnieuw
  const _wa = {
    laden: false, data: null, error: null,
    paneelOpen: false,
    qr: null, qrError: null, qrLaden: false,
  };
  // Handles apart van de staat: een timer is geen gegeven maar een ding dat
  // opgeruimd moet worden. Zie stopWaTimers().
  //
  // Naast de handle bewaren we op wélke cadans hij loopt. Zonder dat kun je een
  // lopende timer niet met rust laten, en dan moet je hem bij elke herstelronde
  // vervangen — waarmee een trage timer nooit afgaat als er een snellere naast
  // loopt. Zie herstelWaTimers().
  const _waTimers = { status: null, statusMs: null, qr: null, qrMs: null };

  async function haal(url) {
    try {
      const j = await window.KV.authedJson(url);
      if (j && j.error) return { __error: j.error };
      return j;
    } catch (e) {
      return { __error: (e && e.message) || 'Netwerkfout' };
    }
  }

  async function fetchTaken(dag) {
    const st = _live.taken;
    if (st.loading || (st.data && st.key === dag)) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-taken?dag=' + encodeURIComponent(dag));
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j;
    render();
  }
  async function fetchDash(dag) {
    const st = _live.dash;
    if (st.loading || (st.data && st.key === dag)) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-dag?dag=' + encodeURIComponent(dag));
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j;
    render();
  }
  async function fetchArchief() {
    const st = _live.archief;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await haal('/api/opvolging-taken?view=archief');
    st.loading = false;
    if (j.__error) st.error = j.__error; else st.data = j.archief || [];
    render();
  }
  /** De maandag van de week waarin `d` valt. */
  function maandagVan(d) {
    const dt = new Date(d + 'T12:00:00Z');
    const dow = dt.getUTCDay();               // 0 = zondag
    dt.setUTCDate(dt.getUTCDate() - ((dow + 6) % 7));
    return dt.toISOString().slice(0, 10);
  }
  const agendaVan = () => dagPlus(maandagVan(vandaag()), _agenda.offset * 7);
  const agendaTot = () => dagPlus(agendaVan(), 4);   // maandag t/m vrijdag

  async function fetchAgenda() {
    const van = agendaVan(), tot = agendaTot();
    const key = van + '|' + tot;
    const st = _agenda;
    if (st.loading || (st.data && st.key === key)) return;
    st.loading = true; st.error = null; st.key = key;
    const j = await haal('/api/opvolging-agenda?van=' + van + '&tot=' + tot);
    st.loading = false;
    // Een fout is hier geen dood scherm: de handmatige datumkeuze staat
    // eronder en blijft werken. Zie de melding in de modal.
    if (j.__error) { st.error = j.__error; st.data = null; } else { st.data = j; }
    render();
  }

  async function fetchCalls(dag) {
    const st = _calls;
    // Zelfde regel als callsBlok hanteert: een mislukte poging voor deze dag
    // telt óók als 'geladen', anders draait de melding in een lus rond.
    if (st.loading || (st.key === dag && (st.data || st.error))) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-agenda?van=' + dag + '&tot=' + dag);
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; }
    else { st.data = ((j.dagen || [])[0] || { bezet: [] }).bezet || []; }
    render();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // WHATSAPP-BRUG — twee besluiten, apart en zonder DOM
  // ═════════════════════════════════════════════════════════════════════════
  // Deze twee functies bepalen wat je ziet en welke timers er lopen. Ze raken
  // niets aan en zijn daarom los te controleren; zie
  // tests/opvolging-whatsapp-koppel.test.js. Ze hangen onderaan dit bestand ook
  // aan window.__opvWaHelpers, zodat je ze vanuit de console kunt naslaan.

  /**
   * De brug-status in gewone taal.
   *
   * Drie uitkomsten, en 'onbekend' is er bewust één van: als de status niet op
   * te halen is weten we niet of de koppeling leeft. Dat dan als 'niet
   * gekoppeld' tonen zou mensen naar de QR sturen terwijl er misschien niets
   * aan de hand is — grijs met een korte uitleg is eerlijker.
   */
  function beschrijfWaStatus({ data, error } = {}) {
    if (error) {
      return {
        kleur: 'grijs', label: 'WhatsApp', nummer: null, verbonden: false,
        uitleg: 'De status is niet op te halen. ' + String(error),
      };
    }
    if (!data) {
      return { kleur: 'grijs', label: 'WhatsApp', nummer: null, verbonden: false, uitleg: 'Status wordt opgehaald…' };
    }
    if (data.verbonden === true) {
      const nummer = toonNummer(data.nummer);
      return {
        kleur: 'groen', label: nummer || 'gekoppeld', nummer, verbonden: true,
        uitleg: 'De brug is gekoppeld' + (nummer ? ' met ' + nummer : '') + '.',
      };
    }
    return {
      kleur: 'grijs', label: 'niet gekoppeld', nummer: null, verbonden: false,
      uitleg: data.wacht_op_qr
        ? 'Niet gekoppeld. Er staat een QR klaar om te scannen.'
        : 'Niet gekoppeld. De brug draait wel; open dit paneel om te koppelen.',
    };
  }

  /**
   * Welke timers horen er te lopen?
   *
   *   gemount    — staat het lampje nog in beeld? Zo niet, dan is de gebruiker
   *                weggenavigeerd en moet ALLES stoppen. Zonder deze uitgang
   *                blijven de intervallen doorlopen op elke andere pagina.
   *   paneelOpen — het koppelpaneel staat open.
   *   verbonden  — de brug is gekoppeld.
   *
   * Zodra er gekoppeld is stopt het pollen helemaal: er valt niets meer te
   * zien, en doorgaan zou de brug elke vijf seconden blijven bevragen voor een
   * antwoord dat niet meer verandert.
   */
  function bepaalWaTimers({ gemount, paneelOpen, verbonden } = {}) {
    if (!gemount) return { statusMs: null, qrMs: null };
    if (!paneelOpen) return { statusMs: WA_POLL_RUSTIG_MS, qrMs: null };
    if (verbonden)  return { statusMs: null, qrMs: null };
    return { statusMs: WA_POLL_PANEEL_MS, qrMs: WA_POLL_QR_MS };
  }

  /** '32470111222' → '+32 470 111 222'. Onleesbaar? Dan onveranderd terug. */
  function toonNummer(raw) {
    const c = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!c) return null;
    return '+' + c.replace(/(\d{2})(\d{3})(\d{3})(\d+)/, '$1 $2 $3 $4');
  }

  /** Hoe lang geleden, in gewone taal. */
  function geledenTekst(iso) {
    if (!iso) return 'nog niets gezien';
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'zojuist';
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'zojuist';
    if (min < 60) return min + ' min geleden';
    const uur = Math.floor(min / 60);
    if (uur < 24) return uur + ' uur geleden';
    return Math.floor(uur / 24) + ' dag' + (Math.floor(uur / 24) === 1 ? '' : 'en') + ' geleden';
  }

  // ── Ophalen ──────────────────────────────────────────────────────────────
  // Fail-soft: een fout wordt onthouden en getoond, niet gegooid. De rest van
  // het dagscherm mag hier nooit op stuklopen.
  async function fetchWaStatus() {
    if (_wa.laden) return;
    _wa.laden = true;
    const j = await haal('/api/opvolging-whatsapp-status?wat=status');
    _wa.laden = false;
    if (j.__error) { _wa.error = j.__error; _wa.data = null; }
    else { _wa.data = j; _wa.error = null; }
    herstelWaTimers();
    render();
  }

  async function fetchWaQr() {
    if (_wa.qrLaden) return;
    _wa.qrLaden = true;
    const j = await haal('/api/opvolging-whatsapp-status?wat=qr');
    _wa.qrLaden = false;
    if (j.__error) { _wa.qrError = j.__error; _wa.qr = null; }
    else { _wa.qr = j.qr || null; _wa.qrError = j.qr ? null : (j.melding || null); }
    render();
  }

  // ── Timers ───────────────────────────────────────────────────────────────
  /** Alles stil. Wordt aangeroepen bij sluiten, bij wegnavigeren en bij unload. */
  function stopWaTimers() {
    if (_waTimers.status) clearInterval(_waTimers.status);
    if (_waTimers.qr)     clearInterval(_waTimers.qr);
    _waTimers.status = null; _waTimers.statusMs = null;
    _waTimers.qr     = null; _waTimers.qrMs     = null;
  }

  /**
   * Wat moet er met één timer gebeuren?
   *
   *   lopendMs  — de cadans waarop hij nu draait, of null als hij stilstaat.
   *   gewenstMs — de cadans die hij zou moeten hebben, of null voor uit.
   *
   * Dit is de kern van de bug die dit bestand hiervoor had. herstelWaTimers()
   * stopte altijd álles en zette daarna alles opnieuw. Met het paneel open
   * kwam de status elke 5 seconden binnen en riep die herstel aan, dus werd de
   * QR-timer van 20 seconden elke 5 seconden vernietigd en opnieuw begonnen.
   * Hij haalde zijn deadline nooit: de code op het scherm ververste niet, en
   * Dave stond een verlopen code te scannen zonder dat er iets in de logs
   * misging.
   *
   * 'behouden' is daarom geen optimalisatie maar het punt: een timer die al op
   * de goede cadans loopt moet je met rust laten, niet vervangen.
   */
  function bepaalTimerActie(lopendMs, gewenstMs) {
    if (!gewenstMs) return lopendMs ? 'stoppen' : 'niets';
    if (!lopendMs)  return 'starten';
    return lopendMs === gewenstMs ? 'behouden' : 'herstarten';
  }

  /** Staat het lampje nog in beeld? Zo niet, dan is de view weg. */
  function waGemount() {
    return typeof document !== 'undefined' && !!document.getElementById('opv-wa-lamp');
  }

  /**
   * Zet de timers gelijk aan wat bepaalWaTimers() voorschrijft — maar raakt
   * alleen aan wat écht verandert.
   *
   * Deze functie wordt bij elke statusronde aangeroepen, dus met het paneel
   * open om de vijf seconden. Alles blind stoppen en opnieuw starten laat de
   * QR-timer van twintig seconden dan nooit afgaan. Per timer geldt daarom:
   * loopt hij al op de goede cadans, dan blijft hij lopen.
   */
  function herstelWaTimers() {
    const wens = bepaalWaTimers({
      gemount   : waGemount(),
      paneelOpen: _wa.paneelOpen,
      verbonden : !!(_wa.data && _wa.data.verbonden),
    });

    // De view kan vervangen zijn zonder dat iemand het ons vertelt; de shell
    // kent geen afscheidshaak. Het lampje is het levensteken — vandaar deze
    // check in elke tik, niet alleen bij het opzetten.
    const tik = (fn) => () => { if (!waGemount()) { stopWaTimers(); return; } fn(); };

    zetTimer('status', 'statusMs', wens.statusMs, tik(fetchWaStatus));
    zetTimer('qr',     'qrMs',     wens.qrMs,     tik(fetchWaQr));
  }

  /** Past één timer aan volgens bepaalTimerActie(). */
  function zetTimer(handleSleutel, msSleutel, gewenstMs, fn) {
    const actie = bepaalTimerActie(_waTimers[msSleutel], gewenstMs);
    if (actie === 'niets' || actie === 'behouden') return;
    if (_waTimers[handleSleutel]) clearInterval(_waTimers[handleSleutel]);
    if (actie === 'stoppen') {
      _waTimers[handleSleutel] = null;
      _waTimers[msSleutel] = null;
      return;
    }
    _waTimers[handleSleutel] = setInterval(fn, gewenstMs);
    _waTimers[msSleutel] = gewenstMs;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DE TWEE VENSTERS VAN DE DAG
  // ═════════════════════════════════════════════════════════════════════════
  // Twee afspraken met een klok eraan:
  //   1. Elke ingeplande lead krijgt vóór 09:00 een spraakbericht.
  //   2. Wie dat kreeg en niet antwoordde, wordt tussen 12:00 en 13:00 gebeld.
  //
  // Een moment telt alleen mee als het in zijn venster viel. Om 16:20 bellen is
  // niet 'gedaan' maar 'te laat' — anders meet de dekking of het werk gebeurd
  // is, niet of het op tijd gebeurd is, en dan is het cijfer stuurloos.
  //
  // Alles in Amsterdamse tijd, net als cron-opvolging-doorrol. NOOIT via
  // toISOString(): dat is UTC, en dan valt een gesprek van 00:30 op de vorige
  // dag en zit een spraakbericht van 08:30 's winters ineens vóór de deadline
  // die het net miste.
  const ZONE = 'Europe/Amsterdam';
  const SPRAAK_DEADLINE_UUR = 9;      // vóór 09:00; precies 09:00 is te laat
  const NABEL_VAN_UUR       = 12;     // vanaf 12:00, inclusief
  const NABEL_TOT_UUR       = 13;     // tot 13:00, exclusief

  /** Dag en minuut-van-de-dag van een tijdstip, in Amsterdamse tijd. */
  function inZone(ts) {
    const ms = ts == null ? NaN : new Date(ts).getTime();
    if (!Number.isFinite(ms)) return null;
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    const m = {};
    for (const deel of dtf.formatToParts(new Date(ms))) m[deel.type] = deel.value;
    return {
      dag   : `${m.year}-${m.month}-${m.day}`,
      minuut: (+m.hour) * 60 + (+m.minute),
      tijd  : `${m.hour}:${m.minute}`,
    };
  }

  /** Is dit een spraakbericht dat wij verstuurd hebben? */
  function isSpraakVerstuurd(p) {
    return p && p.soort === 'spraakbericht' && /verstuurd/i.test(String(p.resultaat || ''));
  }
  /** Is dit iets dat de lead ons stuurde? */
  function isAntwoord(p) {
    return p && (p.soort === 'whatsapp' || p.soort === 'spraakbericht')
      && /ontvangen/i.test(String(p.resultaat || ''));
  }

  /**
   * Het spraakbericht van vandaag: op tijd, te laat, of niet gebeurd.
   *
   * Alleen het EERSTE spraakbericht van die dag telt. Nog een keer inspreken om
   * 11:00 maakt de gemiste deadline niet ongedaan, en zou anders een gemiste
   * ochtend als gehaald laten tellen.
   */
  function beoordeelSpraak(pogingen, dag) {
    const vanDieDag = (Array.isArray(pogingen) ? pogingen : [])
      .filter(isSpraakVerstuurd)
      .map((p) => ({ p, z: inZone(p.tijdstip) }))
      .filter((x) => x.z && x.z.dag === dag)
      .sort((a, b) => a.z.minuut - b.z.minuut);
    if (vanDieDag.length === 0) return { staat: 'niet_gedaan', tijd: null };
    const eerste = vanDieDag[0];
    return {
      staat: eerste.z.minuut < SPRAAK_DEADLINE_UUR * 60 ? 'op_tijd' : 'te_laat',
      tijd : eerste.z.tijd,
    };
  }

  /**
   * Het nabellen van vandaag.
   *
   * Nodig is het alleen als er een spraakbericht uitging én de lead niet
   * antwoordde. Wie wél antwoordde hoeft niet nagebeld; die staat op
   * 'niet_nodig' en telt niet mee als gemist.
   *
   * Een gesprek telt als op tijd binnen [12:00, 13:00). Daarbuiten is het te
   * laat — ook als het vroeger was: om 10:00 bellen is niet het afgesproken
   * moment. Het eerste gesprek van de dag bepaalt het oordeel.
   */
  function beoordeelNabel(pogingen, dag) {
    const lijst = Array.isArray(pogingen) ? pogingen : [];
    const spraak = beoordeelSpraak(lijst, dag);
    if (spraak.staat === 'niet_gedaan') return { staat: 'niet_nodig', reden: 'geen spraakbericht', tijd: null };

    const heeftGeantwoord = lijst
      .filter(isAntwoord)
      .map((p) => inZone(p.tijdstip))
      .some((z) => z && z.dag === dag);
    if (heeftGeantwoord) return { staat: 'niet_nodig', reden: 'heeft geantwoord', tijd: null };

    const calls = lijst
      .filter((p) => p && p.soort === 'call')
      .map((p) => inZone(p.tijdstip))
      .filter((z) => z && z.dag === dag)
      .sort((a, b) => a.minuut - b.minuut);
    if (calls.length === 0) return { staat: 'niet_gedaan', reden: null, tijd: null };

    const eerste = calls[0];
    const inVenster = eerste.minuut >= NABEL_VAN_UUR * 60 && eerste.minuut < NABEL_TOT_UUR * 60;
    return { staat: inVenster ? 'op_tijd' : 'te_laat', reden: null, tijd: eerste.tijd };
  }

  /** De twee oordelen samen, per taak. */
  function beoordeelDag(taak, dag) {
    const pg = (taak && taak.pogingen) || [];
    return { spraak: beoordeelSpraak(pg, dag), nabel: beoordeelNabel(pg, dag) };
  }

  /**
   * WIE HOORT ER IN DE VENSTERS?
   *
   * Alleen de leads met een zoomcall op die dag — niet iedereen op de lijst.
   * Een masterclass-aanmelding hoort geen ochtendspraakbericht te krijgen en
   * hoeft tussen 12 en 13 uur niet nagebeld te worden; die twee vensters gaan
   * over de call-afspraken.
   *
   * Dat stond fout: spraakBlok en nabelBlok kregen álle taken van de dag mee.
   * Met tien masterclass-aanmeldingen erbij las het scherm '0 op tijd, 0 na
   * 09:00, 10 geen, van 10' — tien keer rood voor mensen voor wie er geen
   * spraakbericht bestaat. Dat is precies het soort nul waar deze module
   * nergens anders in trapt.
   *
   * De juiste verzameling staat al op het scherm: de calls uit
   * /api/opvolging-agenda, hetzelfde lijstje dat 'Calls van vandaag' toont.
   */

  /**
   * Koppelt de calls van een dag aan de taken erachter.
   *
   * Pure functie: `zoekTaak` is de opzoeker (in het scherm taakVoorNummer, in
   * de test een stub). Een call zonder taak is niet te beoordelen — daar is
   * geen pogingen-historiek voor — en komt apart terug in plaats van als
   * 'geen spraakbericht' mee te tellen.
   *
   * Twee calls voor dezelfde persoon leveren één taak op; anders telt die lead
   * dubbel in de dekking.
   */
  function koppelCalls({ calls, zoekTaak }) {
    const taken = [];
    const gezien = new Set();
    const zonderTaak = [];
    for (const c of (Array.isArray(calls) ? calls : [])) {
      const t = typeof zoekTaak === 'function' ? zoekTaak(c) : null;
      if (!t) { zonderTaak.push(c); continue; }
      if (gezien.has(t.id)) continue;
      gezien.add(t.id);
      taken.push(t);
    }
    return { taken, zonderTaak };
  }

  /**
   * Heeft deze taak een zoomcall op deze dag?
   *
   * Bepaalt of de venster-etiketten op de kaart zelf iets te zeggen hebben.
   * Op een aanmeldkaart hoort er niets over spraakberichten te staan — dat was
   * de rode 'geen spraakbericht' die op tien aanmeldingen verscheen.
   */
  function callVoorTaak(taak, calls) {
    const doel = telCijfers(taak && taak.telefoon);
    if (!doel) return null;
    const staart = doel.length >= 9 ? doel.slice(-9) : null;
    for (const c of (Array.isArray(calls) ? calls : [])) {
      const cc = telCijfers(c && c.telefoon);
      if (!cc) continue;
      if (cc === doel) return c;
      if (staart && cc.length >= 9 && cc.slice(-9) === staart) return c;
    }
    return null;
  }

  /**
   * De stand van de venster-blokken op een dag, in één beslissing.
   *
   * Geeft terug wat er te tonen is, niet hoe. Vijf uitkomsten, en vier daarvan
   * zijn 'hier valt niets te meten' — dat is bewust: liever vier keer uitleg
   * dan één keer een nul die eruitziet alsof er gemeten is.
   */
  function vensterBron(dag) {
    if (!brugZietUitgaand()) return { staat: 'geen_brug' };
    const versGeladen = _calls.key === dag && (_calls.data || _calls.error);
    if (!versGeladen) {
      // Zelf ophalen, niet leunen op callsBlok: het dashboard tekent dat blok
      // niet, en dan bleef dit op 'laden' hangen zonder dat er ooit iemand de
      // agenda opvroeg. fetchCalls bewaakt zelf op dubbele aanvragen.
      if (!_calls.loading) queueMicrotask(() => fetchCalls(dag));
      return { staat: 'laden' };
    }
    if (_calls.error) return { staat: 'agenda_fout', error: _calls.error };
    const calls = _calls.data || [];
    if (calls.length === 0) return { staat: 'geen_calls' };
    const { taken, zonderTaak } = koppelCalls({ calls, zoekTaak: (c) => taakVoorNummer(c.telefoon) });
    if (taken.length === 0) return { staat: 'geen_taken', calls: calls.length, zonderTaak };
    return { staat: 'ok', taken, zonderTaak, calls: calls.length };
  }

  /**
   * Staat er voor deze taak een zoomcall op deze dag?
   *
   * Alleen dan zeggen de venster-etiketten iets. Is de agenda nog niet geladen
   * of niet bereikbaar, dan is het antwoord nee: niets tonen is hier beter dan
   * iets tonen dat op niets gebaseerd is.
   */
  function heeftCallOpDag(taak, dag) {
    if (_calls.key !== dag || !_calls.data) return false;
    return !!callVoorTaak(taak, _calls.data);
  }

  /** Eén zin onder de balk over de calls die niet te beoordelen waren. */
  function zonderTaakRegel(zonderTaak) {
    const n = (zonderTaak || []).length;
    if (!n) return '';
    return '<div class="ronde zacht">' + n + ' ingeplande call' + (n === 1 ? '' : 's') +
      ' staan niet in de takenlijst, dus daar valt niets over te zeggen. ' +
      'Ze tellen hierboven niet mee &mdash; als \'geen spraakbericht\' zou dat een oordeel zijn ' +
      'over iets wat we niet gemeten hebben.</div>';
  }

  /** Tellingen over een hele lijst taken, voor het dashboard. */
  function telVensters(taken, dag) {
    const leeg = { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0 };
    const uit = { spraak: { ...leeg }, nabel: { ...leeg } };
    for (const t of (Array.isArray(taken) ? taken : [])) {
      const o = beoordeelDag(t, dag);
      uit.spraak.totaal += 1;
      uit.spraak[o.spraak.staat] += 1;
      // Het nabellen telt alleen mee voor wie het nodig had; anders zakt de
      // dekking door mensen die gewoon geantwoord hebben.
      if (o.nabel.staat !== 'niet_nodig') { uit.nabel.totaal += 1; uit.nabel[o.nabel.staat] += 1; }
      else uit.nabel.niet_nodig += 1;
    }
    return uit;
  }

  const leegTakenCache = () => {
    _live.taken.data = null; _live.taken.key = null;
    _live.dash.data = null; _live.dash.key = null;
    _live.archief.data = null;
    // De calls hangen aan dezelfde dag; een nieuwe taak verandert welke
    // belknop een taak-koppeling krijgt.
    _calls.data = null; _calls.key = null; _calls.error = null;
  };

  async function post(url, body) {
    _ui.bezig = true;
    try {
      const j = await window.KV.authedJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j && j.error) throw new Error(j.error);
      return j;
    } finally { _ui.bezig = false; }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // STIJL — één keer ingespoten, volledig gescoped onder .opv zodat er
  // buiten deze module niets kan verschuiven.
  // ═════════════════════════════════════════════════════════════════════════
  function stijl() {
    if (document.getElementById('opv-stijl')) return '';
    const el = document.createElement('style');
    el.id = 'opv-stijl';
    el.textContent = `
.opv{--o-line:#e5e7eb;--o-muted:#6b7280;--o-ink:#0f1419;--o-acc:#2f6bff;--o-accs:#eaf0ff;
 --o-grn:#0ea968;--o-grns:#e6f7f0;--o-amb:#e08700;--o-ambs:#fff5e6;--o-red:#e0393e;--o-reds:#fdeced;
 --o-pur:#7c4dff;--o-purs:#f1ecff;--o-sh:0 1px 2px rgba(16,20,30,.06),0 8px 24px rgba(16,20,30,.05);
 color:var(--o-ink);padding:18px 22px 60px;max-width:1000px}
.opv .wk{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
.opv .wkbar{display:flex;align-items:stretch;gap:8px;margin:0 0 14px}
.opv .wkbar .wkmid{flex:1;min-width:0}
/* Zes tegels naast elkaar, ook op een smal scherm.
   Het was een flexrij met min-width:104px per tegel en flex-wrap; bij zes
   tegels paste dat niet meer, en dan viel zaterdag op een eigen regel over de
   volle breedte terwijl de andere vijf boven elkaar kwamen te staan. Een grid
   met zes gelijke kolommen kan niet afbreken: minmax(0,1fr) laat elke kolom
   krimpen in plaats van te wrappen. De min-width moet daarvoor expliciet terug
   naar 0, anders houdt de tegel zichzelf breed en loopt het grid over. */
.opv .wkbar .wk{margin:0;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
.opv .wkbar .wkd{flex:none;min-width:0;overflow:hidden}
/* De vandaag-markering is een los element, zodat hij op een smal scherm kan
   verdwijnen zonder de datum mee te nemen. De tegel zelf verandert nergens van
   vorm: 'nu' kleurt alleen, 'on' legt een ring om de rand die geen ruimte
   inneemt, en het grid geeft alle zes dezelfde breedte en hoogte. */
.opv .wkd .l .vd{color:var(--o-acc);font-weight:700}
.opv .wkd .l .d{white-space:nowrap}
@media (max-width:1000px){
  .opv .wkbar{gap:6px}
  .opv .wkbar .wk{gap:6px}
  .opv .wkbar .wkd{padding:8px 9px}
  .opv .wkd .l{font-size:10.5px}
  .opv .wkd .c{font-size:15px}
}
@media (max-width:820px){
  .opv .wkd .l .vd{display:none}
  .opv .wkd .c small{display:none}
  .opv .wkbar .wkd{padding:7px 7px}
}
.opv .obtn.wkp{display:flex;align-items:center;justify-content:center;min-width:34px;font-size:15px;line-height:1;padding:0 10px}
.opv .wklbl{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650;color:var(--o-muted);margin:0 0 6px 2px}
.opv .wknu{border:0;background:none;padding:0;font:inherit;font-size:11.5px;font-weight:600;color:var(--o-acc);cursor:pointer;text-decoration:underline}
.opv .wkd{flex:1;min-width:0;background:#fff;border:1px solid var(--o-line);border-radius:12px;padding:9px 11px;cursor:pointer;font-family:inherit;text-align:left;box-shadow:var(--o-sh);display:flex;flex-direction:column;gap:2px}
.opv .wkd .l{font-size:11.5px;color:var(--o-muted);font-weight:600}
.opv .wkd .c{font-size:17px;font-weight:750}
.opv .wkd .c small{font-size:11.5px;font-weight:600;color:var(--o-muted)}
.opv .wkd.on{border-color:var(--o-acc);box-shadow:0 0 0 3px var(--o-accs)}
.opv .wkd.nu .l{color:var(--o-acc)}
.opv .wkd.oud{background:#fbfcfd}
.opv .ronde{font-size:12.5px;color:var(--o-muted);margin:0 0 10px 2px}
.opv .ronde.zacht{margin:8px 0 0 2px;font-size:11.5px;font-style:italic}
.opv .row{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:13px 16px;display:flex;align-items:flex-start;gap:14px;margin-bottom:9px;box-shadow:var(--o-sh)}
.opv .row .who{flex:1;min-width:0}
.opv .row .nm{font-weight:650;font-size:14.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.opv .row .mt{font-size:12.5px;margin-top:7px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.opv .act{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;align-self:center}
.opv .tag{font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px}
.opv .t-blue{background:var(--o-accs);color:#1a49c4}.opv .t-amber{background:var(--o-ambs);color:#9a5d00}
.opv .t-red{background:var(--o-reds);color:#b32b2f}.opv .t-green{background:var(--o-grns);color:#08794a}
.opv .t-purple{background:var(--o-purs);color:#5a2fd6}.opv .t-grey{background:#f0f1f4;color:#5b6472}
.opv .pil{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:3px 10px;font-size:11.5px;font-weight:650;border:1px solid #e4e7ec;background:#fff;color:#7a828f}
.opv .pil.aan{background:#0f1420;border-color:#0f1420;color:#fff}
.opv .pil.wa{background:var(--o-grn);border-color:var(--o-grn);color:#fff}
.opv .pil.uit{background:#f4f5f7;border-color:#eaecf0;color:#a2a9b4}
.opv .dots{display:inline-flex;gap:3px}
.opv .dots i{width:7px;height:7px;border-radius:50%;background:#dadee5;display:block}
.opv .pil.aan .dots i{background:#4b5768}
.opv .dots i.on{background:var(--o-acc)}.opv .pil.aan .dots i.on{background:#7fa5ff}
.opv .note{background:#fbfbfc;border-left:3px solid var(--o-line);padding:7px 11px;border-radius:0 8px 8px 0;font-size:13px;color:#414954;margin-top:9px}
.opv .empty{text-align:center;color:var(--o-muted);font-size:13.5px;padding:24px;border:1px dashed var(--o-line);border-radius:14px;background:#fcfcfd}
.opv .obtn{border:1px solid var(--o-line);background:#fff;border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--o-ink)}
.opv .obtn:hover{border-color:#c9cfd8}
.opv .obtn.p{background:var(--o-acc);border-color:var(--o-acc);color:#fff}
.opv .obtn.wa{background:var(--o-grns);border-color:#bfe9d6;color:#08794a}
.opv .sh{display:flex;align-items:center;gap:9px;margin:22px 0 11px 2px}
.opv .sh .ic{width:25px;height:25px;border-radius:8px;display:grid;place-items:center;font-size:12.5px}
.opv .sh h3{font-size:14px;font-weight:700;margin:0}
.opv .sh .n{background:var(--o-line);color:#4b5563;border-radius:20px;padding:1px 8px;font-size:11px;font-weight:700}
.opv .dhero{background:linear-gradient(135deg,#0e1730,#20366f 55%,#2b4a95);color:#fff;border-radius:18px;padding:20px 24px;margin-bottom:20px}
.opv .dhero .lbl{font-size:11px;text-transform:uppercase;letter-spacing:1.1px;color:#9dbaff;font-weight:700}
.opv .dhero .big{font-size:27px;font-weight:750;margin-top:4px}
.opv .dhero .sml{color:#c3d3f5;font-size:13px;margin-top:5px}
.opv .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.opv .kpi{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:15px 16px;box-shadow:var(--o-sh);position:relative;overflow:hidden}
.opv .kpi:before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:#dfe3e9}
.opv .kpi.g:before{background:var(--o-grn)}.opv .kpi.a:before{background:var(--o-amb)}.opv .kpi.r:before{background:var(--o-red)}.opv .kpi.b:before{background:var(--o-acc)}
.opv .kpi .k{font-size:12px;color:var(--o-muted)}
.opv .kpi .v{font-size:26px;font-weight:750;margin-top:6px;font-variant-numeric:tabular-nums}
.opv .kpi .s{font-size:12px;margin-top:4px}
.opv .cov{background:#fff;border:1px solid var(--o-line);border-radius:14px;box-shadow:var(--o-sh);overflow:hidden;margin-top:12px}
.opv .covr{display:flex;align-items:center;gap:12px;padding:10px 15px;border-bottom:1px solid #f1f2f5}
.opv .covr:last-child{border-bottom:0}
.opv .covr .nm2{font-weight:600;font-size:13.5px;flex:1;min-width:0}
.opv .covr .st{font-size:11.5px;font-weight:650;flex:0 0 92px;text-align:right}
.opv .ok{color:var(--o-grn);font-weight:650}.opv .bad{color:var(--o-red);font-weight:650}.opv .laatc{color:var(--o-amb);font-weight:650}
.opv table{width:100%;border-collapse:collapse;font-size:13.5px;background:#fff}
.opv th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--o-muted);padding:11px 14px;border-bottom:1px solid var(--o-line)}
.opv td{padding:12px 14px;border-bottom:1px solid #f1f2f5}
.opv .card{background:#fff;border:1px solid var(--o-line);border-radius:14px;box-shadow:var(--o-sh);overflow:hidden}
.opv .scrim{position:fixed;inset:0;background:rgba(12,16,24,.5);display:grid;place-items:center;z-index:9000;padding:20px}
.opv .modal{background:#fff;border-radius:18px;width:100%;max-width:540px;max-height:88vh;overflow:auto;box-shadow:0 24px 70px rgba(0,0,0,.3)}
.opv .mh{padding:20px 22px 14px;border-bottom:1px solid var(--o-line);display:flex;align-items:flex-start;gap:12px}
.opv .mh h3{font-size:17px;margin:0}.opv .mh p{color:var(--o-muted);font-size:13px;margin:3px 0 0}
.opv .mh .x{margin-left:auto;background:none;border:0;font-size:22px;color:#9aa2ad;cursor:pointer}
/* Fase 2 — de agenda achter 'Opnieuw inplannen'. Vijf dagkolommen naast
   elkaar; op een smal scherm wordt het één kolom per dag onder elkaar. */
.opv .agh{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.opv .agh .rng{font-weight:650;font-size:13.5px;flex:1;text-align:center}
.opv .agw{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}
@media(max-width:640px){.opv .agw{grid-template-columns:1fr}}
.opv .agd{border:1px solid var(--o-line);border-radius:12px;background:#fcfcfd;padding:8px;min-height:96px}
.opv .agd>.dh{font-size:11.5px;font-weight:700;color:var(--o-muted);text-align:center;margin-bottom:7px}
.opv .agd>.dh b{display:block;font-size:14px;color:var(--o-ink);font-weight:750}
.opv .slot{display:block;width:100%;border-radius:8px;padding:5px 6px;font-size:12px;font-weight:650;font-family:inherit;margin-bottom:5px;text-align:center;border:1px solid transparent}
.opv .slot.vrij{background:var(--o-accs);border-color:#c8d8ff;color:#1a49c4;cursor:pointer}
.opv .slot.vrij:hover{background:var(--o-acc);border-color:var(--o-acc);color:#fff}
.opv .slot.bezet{background:#f1f2f5;color:#8b93a0;cursor:default}
.opv .slot.bezet .w{display:block;font-size:10.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.opv .agleeg{font-size:11.5px;color:#a2a9b4;text-align:center;padding:10px 0}
.opv .warn2{background:var(--o-ambs);border:1px solid #f0d9ac;color:#8a5300;border-radius:10px;padding:9px 12px;font-size:12.5px;margin-bottom:12px}
/* Fase 3a — 'Calls van vandaag'. Zelfde rij-vorm als een taakkaart, maar met
   het tijdstip vooraan: bij een callrij is het uur het eerste dat je zoekt. */
.opv .call{background:#fff;border:1px solid var(--o-line);border-radius:14px;padding:12px 16px;display:flex;align-items:center;gap:14px;margin-bottom:9px;box-shadow:var(--o-sh)}
.opv .call .tijd{font-size:16px;font-weight:750;font-variant-numeric:tabular-nums;flex:0 0 52px;color:var(--o-acc)}
.opv .call.geweest .tijd{color:#a2a9b4}
.opv .call .who{flex:1;min-width:0}
.opv .call .nm{font-weight:650;font-size:14.5px}
.opv .call .sub{font-size:12.5px;color:var(--o-muted);margin-top:3px}
.opv .call .act{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
.opv .obtn.zoom{background:var(--o-purs);border-color:#d9ccff;color:#5a2fd6}
/* WhatsApp-brug — lampje rechtsboven plus het koppelpaneel. Alles onder .opv,
   zoals de rest van deze module; er staat niets globaals in. */
.opv .kop{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.opv .kop .info{flex:1;margin:0}
.opv .walamp{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--o-line);background:#fff;border-radius:20px;padding:6px 12px 6px 10px;font-size:12.5px;font-weight:650;font-family:inherit;cursor:pointer;color:var(--o-ink);box-shadow:var(--o-sh);white-space:nowrap}
.opv .walamp:hover{border-color:#c9cfd8}
.opv .walamp i{width:9px;height:9px;border-radius:50%;background:#c7ccd4;display:block;flex:0 0 auto}
.opv .walamp.aan i{background:var(--o-grn);box-shadow:0 0 0 3px rgba(14,169,104,.18)}
.opv .walamp .wt{color:var(--o-muted);font-weight:600}
.opv .walamp.aan .wt{color:var(--o-ink);font-weight:650}
.opv .waregel{display:flex;justify-content:space-between;gap:14px;padding:8px 0;border-bottom:1px solid #f1f2f5;font-size:13.5px}
.opv .waregel:last-child{border-bottom:0}
.opv .waregel span:first-child{color:var(--o-muted)}
.opv .waqr{display:block;width:320px;max-width:100%;height:auto;margin:14px auto 0;border:1px solid var(--o-line);border-radius:14px;background:#fff}
.opv .wastap{margin:12px 0 0;padding-left:20px;font-size:13px;color:#414954;line-height:1.7}
.opv .waklaar{background:var(--o-grns);border:1px solid #bfe9d6;color:#08794a;border-radius:12px;padding:14px 16px;text-align:center;font-size:14px;font-weight:650}
/* De twee vensters van de dag: spraakbericht voor 09:00 en nabellen 12–13u. */
.opv .vst{display:inline-flex;align-items:center;gap:5px;border-radius:20px;padding:3px 9px;font-size:11.5px;font-weight:650;border:1px solid transparent}
.opv .vst.ok{background:var(--o-grns);border-color:#bfe9d6;color:#08794a}
.opv .vst.laat{background:var(--o-ambs);border-color:#f0d9ac;color:#8a5300}
.opv .vst.mist{background:var(--o-reds);border-color:#f3c9cb;color:#b32b2f}
.opv .vst.nvt{background:#f4f5f7;border-color:#eaecf0;color:#8b93a0}
.opv .vstrij{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px}
.opv .vstrij>div{flex:1;min-width:200px}
.opv .vstkop{font-size:11.5px;color:var(--o-muted);font-weight:650;margin-bottom:5px}
.opv .balk{display:flex;height:9px;border-radius:6px;overflow:hidden;background:#eef0f3}
.opv .balk i{display:block;height:100%}
.opv .balk i.ok{background:var(--o-grn)}
.opv .balk i.laat{background:var(--o-amb)}
.opv .balk i.mist{background:var(--o-red)}
.opv .balklegenda{font-size:12px;color:var(--o-muted);margin-top:6px;display:flex;gap:12px;flex-wrap:wrap}
.opv .nietgemeten{border:1px dashed var(--o-line);border-radius:14px;background:#fcfcfd;padding:18px 20px;font-size:13.5px;color:#414954}
.opv .nietgemeten b{color:var(--o-ink)}
/* Aanmeldingen: gegroepeerd per event. De groepskop draagt de context, de
   kaarten eronder houden exact de vorm die ze overal in deze module hebben —
   geen gekleurde randjes per kaart. */
.opv .evgroep{margin:18px 0 4px}
.opv .evkop{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;background:#fbfcfd;border:1px solid var(--o-line);border-radius:12px;padding:10px 14px;margin-bottom:9px}
.opv .evkop b{font-size:14px;font-weight:700}
.opv .evkop .wan{font-size:12.5px;color:var(--o-muted)}
.opv .evkop .tel{margin-left:auto;font-size:11.5px;font-weight:700;background:var(--o-line);color:#4b5563;border-radius:20px;padding:2px 9px}
.opv .evkop .straks{font-size:11.5px;font-weight:700;border-radius:20px;padding:2px 9px;background:var(--o-ambs);color:#8a5300}
.opv .evkop .straks.dichtbij{background:var(--o-reds);color:#b32b2f}
.opv .evkop{display:block}
.opv .evkop .evkr{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.opv .evkop .evadr{font-size:11.5px;color:var(--o-muted);margin-top:3px}
/* De rustige kaart: naam als duidelijkste element, meer wit, alleen de
   voortgang van vandaag. Wat er nog niet is blijft stil — de teller zegt dat. */
.opv .row.rst{padding:13px 15px}
.opv .row.rst .nm2{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:15px;font-weight:700;color:var(--o-ink);line-height:1.25}
.opv .row.rst .mt2{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-top:5px}
.opv .row.rst .tel2{font-size:13px;color:#4b5563;font-variant-numeric:tabular-nums}
.opv .row.rst .vdg{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--o-muted)}
.opv .row.rst .hist{font-size:12px;color:var(--o-muted)}
.opv .row.rst .afw{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.opv .row.rst .note{margin-top:8px}
.opv .row.rst .note.zacht{background:var(--o-grns);border-left-color:#bfe9d6;color:#0a6b45}
.opv .klaarblok{opacity:.72}
.opv .klaarblok .row{background:#fcfcfd}
.opv .mb{padding:18px 22px 22px}
.opv .opt{display:flex;align-items:center;gap:13px;width:100%;text-align:left;padding:14px 15px;border:1px solid var(--o-line);border-radius:13px;background:#fff;cursor:pointer;margin-bottom:9px;font-family:inherit}
.opv .opt:hover{border-color:var(--o-acc);background:var(--o-accs)}
.opv .opt .em{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;font-size:17px;flex:0 0 auto}
.opv .opt b{display:block;font-size:14.5px}.opv .opt span{font-size:12.5px;color:var(--o-muted)}
.opv .warn{background:var(--o-ambs);border:1px solid #f3ddb4;border-radius:11px;padding:12px 14px;font-size:13px;color:#7a4d00;margin-bottom:12px}
.opv .info{background:var(--o-accs);border:1px solid #cfdcff;border-radius:11px;padding:12px 14px;font-size:13px;color:#1a3d9e;margin-bottom:12px}
.opv textarea,.opv input[type=date]{width:100%;border:1px solid var(--o-line);border-radius:11px;padding:11px 12px;font-size:13.5px;font-family:inherit}
.opv .tl{list-style:none;margin:0;padding:0}
.opv .tl li{display:flex;gap:12px;padding:9px 0;font-size:13.5px;border-bottom:1px solid #f3f4f6}
.opv .tl li:last-child{border:0}
.opv .tl .d{flex:0 0 120px;color:var(--o-muted);font-size:12.5px}
`;
    document.head.appendChild(el);
    return '';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // BOUWSTENEN
  // ═════════════════════════════════════════════════════════════════════════
  const dots = (n, doel) => {
    let o = '';
    for (let i = 0; i < doel; i++) o += '<i class="' + (i < n ? 'on' : '') + '"></i>';
    return '<span class="dots">' + o + '</span>';
  };
  const skel = () => '<div class="empty">Bezig met laden…</div>';
  const fout = (msg, herstel) => '<div class="warn"><b>Kon dit niet laden.</b> ' + esc(msg) +
    ' <button class="obtn" style="margin-left:8px" onclick="' + herstel + '">Opnieuw proberen</button></div>';

  const REDEN_LABEL = {
    wil_nog_beslissen: ['Wil nog beslissen', 't-amber'],
    no_show_event: ['No-show event', 't-purple'],
    no_show_call: ['No-show call', 't-red'],
    afgemeld: ['Afgemeld', 't-grey'],
    niet_ingepland: ['Niet ingepland', 't-red'],
  };

  /**
   * De badge 'Bevestigd op 01/09' met de notitie eronder.
   *
   * In ronde B moet in één oogopslag te zien zijn dat deze persoon in ronde A
   * al bevestigd heeft. Dan belt Dave niet meer met de vraag óf hij komt, maar
   * als herinnering. Zonder dit is een kaart in ronde B niet te onderscheiden
   * van een verse aanmelding.
   */
  function bevestigdBadge(t) {
    if (!t || !t.bevestigd_op) return '';
    return '<span class="tag t-green" title="in de eerste ronde bevestigd">&#10003; Bevestigd op ' +
      esc(nl(iso(t.bevestigd_op))) + '</span>';
  }

  /**
   * Wat Dave op een kaart moet zien, en niet meer dan dat.
   *
   * `opties.inGroep` is waar de aanmeldkaarten mee getekend worden: die staan
   * onder een groepskop die de eventnaam, het moment en het aantal al noemt.
   * Alles wat die kop herhaalt gaat er dan af — het reden-etiket ('aanmelding',
   * terwijl het blok Aanmeldingen heet) en het badge-label met dezelfde
   * eventnaam, hetzelfde adres en hetzelfde uur.
   *
   * Verder geldt daar: niets negatiefs zolang er nog niets misgegaan is. 'nog
   * niet gebeld' en 'geen WhatsApp' zeggen precies hetzelfde als de nul in de
   * voortgang van vandaag, maar klinken als een verwijt bij iemand die zich
   * vanmorgen heeft aangemeld. De teller blijft, de verwijten gaan eraf, en
   * rood blijft over voor wat écht te laat is.
   */
  function taakKaart(t, dag, opties) {
    const inGroep = !!(opties && opties.inGroep);
    const r = REDEN_LABEL[t.reden] || [t.reden, 't-grey'];
    const nuDag = vandaag();
    if (inGroep) return taakKaartRustig(t, dag, nuDag);
    return '<div class="row"><div class="who">' +
      '<div class="nm">' + esc(t.naam) +
        ' <span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>' +
        (t.reden_code ? ' <span class="tag t-grey">' + esc(t.reden_code) + '</span>' : '') +
        (t.badge_label ? ' <span class="tag t-grey">' + esc(t.badge_label) + '</span>' : '') +
        (t.due < nuDag ? ' <span class="tag t-red">bleef liggen</span>' : '') +
        (t.due > nuDag ? ' <span class="tag t-blue">staat op ' + nl(t.due) + '</span>' : '') +
        ((t.uitgesteld_zonder_poging || 0) >= 2 ? ' <span class="tag t-amber">' + t.uitgesteld_zonder_poging + '&times; uitgesteld zonder poging</span>' : '') +
        (t.bevestigd_op ? ' ' + bevestigdBadge(t) : '') +
      '</div>' +
      '<div class="mt">' +
        (t.telefoon ? '<span style="color:#6b7280;font-size:12.5px">' + esc(t.telefoon) + '</span>' : '') +
        '<span class="pil ' + (t.bel_totaal ? 'aan' : 'uit') + '" title="belpogingen">&#9742; ' +
          (t.bel_totaal ? t.bel_totaal + '&times; op ' + t.bel_dagen + ' dag' + (t.bel_dagen === 1 ? '' : 'en') : 'nog niet gebeld') + '</span>' +
        '<span class="pil ' + (t.wa_totaal ? 'wa' : 'uit') + '" title="' + (t.wa_totaal ? 'WhatsApp verstuurd' : 'nog geen WhatsApp sinds hij in de lijst kwam') + '">&#128172; ' +
          (t.wa_totaal ? t.wa_totaal + '&times;' : 'geen WhatsApp') + '</span>' +
        '<span class="pil ' + (t.bel_vandaag ? 'aan' : 'uit') + '" title="doel is ' + DOEL_BELLEN + ' belpogingen per dag">vandaag ' + dots(t.bel_vandaag, DOEL_BELLEN) + '</span>' +
        (t.laatste_poging ? '<span style="color:#6b7280;font-size:12px">laatst ' + esc(nl(iso(t.laatste_poging))) + ' ' + uur(t.laatste_poging) + '</span>' : '') +
      '</div>' +
      vensterBadges(t, dag) +
      (t.notitie ? '<div class="note">' + esc(t.notitie) + '</div>' : '') +
      '</div>' +
      '<div class="act">' +
        '<button class="obtn p" onclick="window.__opvBel(\'' + t.id + '\')">&#9742; Bellen</button>' +
        '<button class="obtn wa" onclick="window.__opvWa(\'' + t.id + '\')">&#128172; WhatsApp</button>' +
        '<button class="obtn" onclick="window.__opvWatNu(\'' + t.id + '\')">Wat nu? &rarr;</button>' +
      '</div></div>';
  }


  /**
   * De rustige kaart, voor aanmeldingen onder een groepskop.
   *
   * Drie dingen staan er altijd: de naam, het telefoonnummer en de voortgang
   * van vandaag. De rest verschijnt alleen als het een afwijking is — een kaart
   * die bleef liggen, twee keer uitstellen zonder poging, of een venster dat te
   * laat is gehaald. Wat er nog niet is, blijft stil: de teller zegt dat al.
   */
  function taakKaartRustig(t, dag, nuDag) {
    const pogingen = (t.bel_vandaag || 0) + (t.wa_vandaag || 0);
    const afwijkingen =
      (t.due < nuDag ? '<span class="tag t-red">bleef liggen sinds ' + esc(nl(t.due)) + '</span>' : '') +
      ((t.uitgesteld_zonder_poging || 0) >= 2
        ? '<span class="tag t-amber">' + t.uitgesteld_zonder_poging + '&times; uitgesteld zonder poging</span>' : '') +
      vensterAfwijking(t, dag);

    return '<div class="row rst"><div class="who">' +
      '<div class="nm2">' + esc(t.naam) +
        (t.bevestigd_op ? ' ' + bevestigdBadge(t) : '') + '</div>' +
      '<div class="mt2">' +
        (t.telefoon ? '<span class="tel2">' + esc(t.telefoon) + '</span>' : '') +
        '<span class="vdg" title="doel is ' + DOEL_BELLEN + ' pogingen per dag">vandaag ' +
          dots(pogingen, DOEL_BELLEN) + ' ' + pogingen + '/' + DOEL_BELLEN + '</span>' +
        ((t.bel_totaal || 0) > 0
          ? '<span class="hist">' + t.bel_totaal + '&times; gebeld op ' + t.bel_dagen +
            ' dag' + (t.bel_dagen === 1 ? '' : 'en') + '</span>' : '') +
        ((t.wa_totaal || 0) > 0 ? '<span class="hist">' + t.wa_totaal + '&times; WhatsApp</span>' : '') +
      '</div>' +
      (afwijkingen ? '<div class="afw">' + afwijkingen + '</div>' : '') +
      (t.bevestigd_notitie ? '<div class="note zacht">' + esc(t.bevestigd_notitie) + '</div>' : '') +
      (t.notitie ? '<div class="note">' + esc(t.notitie) + '</div>' : '') +
      '</div>' +
      '<div class="act">' +
        '<button class="obtn p" onclick="window.__opvBel(\'' + t.id + '\')">&#9742; Bellen</button>' +
        '<button class="obtn wa" onclick="window.__opvWa(\'' + t.id + '\')">&#128172; WhatsApp</button>' +
        '<button class="obtn" onclick="window.__opvWatNu(\'' + t.id + '\')">Wat nu? &rarr;</button>' +
      '</div></div>';
  }

  /**
   * Alleen wat er over de vensters te zeggen valt als er iets gebeurd is.
   *
   * De volledige vensterbadges (vensterBadges) tonen ook 'geen spraakbericht'
   * en 'niet nagebeld'. Op een kaart onder de groepskop leverde dat twee keer
   * dezelfde melding op — één rood uit de spraak-beoordeling en één grijs als
   * reden waarom nabellen niet nodig was — bij iemand die zich vanmorgen heeft
   * aangemeld en waar dus nog niets fout is. Hier blijft over wat gemeten is:
   * op tijd (groen) of te laat (rood).
   */
  function vensterAfwijking(t, dag) {
    if (!brugZietUitgaand()) return '';
    if (!heeftCallOpDag(t, dag)) return '';
    const o = beoordeelDag(t, dag);
    let h = '';
    if (o.spraak.staat === 'te_laat') h += '<span class="tag t-red">&#127908; spraak ' + esc(o.spraak.tijd || '') + ' &middot; na 09:00</span>';
    else if (o.spraak.staat === 'op_tijd') h += '<span class="tag t-green">&#127908; spraak ' + esc(o.spraak.tijd || '') + '</span>';
    if (o.nabel.staat === 'te_laat') h += '<span class="tag t-red">&#9742; nagebeld ' + esc(o.nabel.tijd || '') + ' &middot; buiten 12&ndash;13u</span>';
    else if (o.nabel.staat === 'op_tijd') h += '<span class="tag t-green">&#9742; nagebeld ' + esc(o.nabel.tijd || '') + '</span>';
    return h;
  }

  /** Cijfers van een nummer, 00-prefix weg — zelfde regel als de server. */
  function telCijfers(s) {
    const c = String(s == null ? '' : s).replace(/\D/g, '');
    if (!c) return null;
    return c.startsWith('00') ? (c.slice(2) || null) : c;
  }

  /**
   * Bestaat er al een taak voor dit nummer? Dan krijgt de belknop de koppeling
   * mee, zodat het gesprek meteen als poging bij die taak landt in plaats van
   * pas via de match-op-nummer op de server.
   */
  function taakVoorNummer(tel) {
    const doel = telCijfers(tel);
    if (!doel || !_live.taken.data) return null;
    const alles = (_live.taken.data.taken || []).concat(_live.taken.data.wacht || []);
    const staart = doel.length >= 9 ? doel.slice(-9) : null;
    return alles.find((t) => telCijfers(t.telefoon) === doel)
      || (staart ? alles.find((t) => { const c = telCijfers(t.telefoon); return c && c.length >= 9 && c.slice(-9) === staart; }) : null)
      || null;
  }

  /**
   * Calls van vandaag — de bezette momenten uit de agenda, als werkrij.
   *
   * Bewust géén eigen administratie: dit blok leest de agenda en schrijft
   * hooguit een taak. De afspraakrecords zelf en /api/follow-up-appointment-outcome
   * blijven waar ze zijn; wat daar met de afspraak gebeurt is een andere
   * administratie en die verandert hier niet.
   */
  function callsBlok(dag) {
    // Let op de sleutel, niet op de aanwezigheid van data: bij het wisselen van
    // dag staat de vorige rij er nog, en die onder de kop van vandaag tonen is
    // erger dan even 'laden'.
    const versGeladen = _calls.key === dag && (_calls.data || _calls.error);
    if (!_calls.loading && !versGeladen) queueMicrotask(() => fetchCalls(dag));

    const kop = '<div class="sh"><div class="ic" style="background:var(--o-purs)">&#127909;</div>' +
      '<h3>Calls van ' + (dag === vandaag() ? 'vandaag' : nl(dag)) + '</h3>' +
      (_calls.key === dag && _calls.data ? '<span class="n">' + _calls.data.length + '</span>' : '') + '</div>';

    if (!versGeladen) return kop + '<div class="empty">Agenda laden&hellip;</div>';
    if (_calls.error) {
      return kop + '<div class="warn2"><b>De agenda is nu niet bereikbaar.</b> ' + esc(_calls.error) +
        ' De takenlijst hieronder werkt gewoon.</div>';
    }
    if (_calls.data.length === 0) return kop + '<div class="empty">Geen calls ingepland op deze dag.</div>';

    const nuMs = Date.now();
    return kop + _calls.data.map((c, i) => {
      const geweest = c.start && new Date(c.start).getTime() < nuMs;
      const taak = taakVoorNummer(c.telefoon);
      const knoppen =
        (c.zoom_url ? '<a class="obtn zoom" href="' + esc(c.zoom_url) + '" target="_blank" rel="noopener">&#127909; Zoom</a>' : '') +
        (c.telefoon ? '<button class="obtn p" onclick="window.__opvCallBel(' + i + ')">&#9742; Bellen</button>' : '') +
        (c.telefoon ? '<button class="obtn wa" onclick="window.__opvCallWa(' + i + ')">&#128172; WhatsApp</button>' : '') +
        '<button class="obtn" onclick="window.__opvCallAfrond(' + i + ')">Afronden &rarr;</button>';
      return '<div class="call' + (geweest ? ' geweest' : '') + '">' +
        '<div class="tijd">' + esc(c.tijd) + '</div>' +
        '<div class="who"><div class="nm">' + esc(c.naam) + '</div>' +
        '<div class="sub">' + esc(c.telefoon || 'geen nummer bekend') +
          (taak ? ' &middot; staat al in je lijst' : '') + '</div></div>' +
        '<div class="act">' + knoppen + '</div></div>';
    }).join('');
  }

  /**
   * Het lampje rechtsboven. Groen met het nummer als er gekoppeld is, anders
   * grijs. Bij het eerste bezoek staat er nog niets: dan halen we de status op
   * en start meteen de rustige cadans van één keer per minuut.
   */
  function waLamp() {
    if (!_wa.data && !_wa.error && !_wa.laden) {
      queueMicrotask(() => { fetchWaStatus(); });
    } else if (!_waTimers.status && !_wa.paneelOpen) {
      // Terug op deze tab na een uitstapje: de timers zijn dan opgeruimd.
      queueMicrotask(() => herstelWaTimers());
    }
    const s = beschrijfWaStatus(_wa);
    return '<button id="opv-wa-lamp" class="walamp' + (s.kleur === 'groen' ? ' aan' : '') + '"' +
      ' title="' + esc(s.uitleg) + '" onclick="window.__opvWaOpen()">' +
      '<i></i>&#128172;<span class="wt">' + esc(s.label) + '</span></button>';
  }

  /**
   * Het koppelpaneel. Toont de status in gewone taal, en als er niet gekoppeld
   * is de QR met de vier stappen eronder. Zodra de brug verbonden meldt komt
   * daar een groene bevestiging voor in de plaats en stopt het pollen.
   */
  function waPaneelHtml() {
    if (!_wa.paneelOpen) return '';
    const s = beschrijfWaStatus(_wa);
    const d = _wa.data || {};

    let body = '<div class="waregel"><span>Status</span><span>' +
      (s.verbonden ? '<b style="color:var(--o-grn)">gekoppeld</b>' : esc(s.label)) + '</span></div>' +
      '<div class="waregel"><span>Nummer</span><span>' + esc(s.nummer || '—') + '</span></div>' +
      '<div class="waregel"><span>Laatst iets gezien</span><span>' + esc(geledenTekst(d.laatste_actie)) + '</span></div>';

    if (s.verbonden) {
      body += '<div class="waklaar" style="margin-top:14px">&#10003; Gekoppeld' +
        (s.nummer ? ' met ' + esc(s.nummer) : '') + '.<br>' +
        '<span style="font-weight:600;font-size:12.5px">Je kunt dit venster sluiten.</span></div>';
    } else if (_wa.error) {
      // Geen QR tonen als we de brug niet eens kunnen bereiken: dan is een
      // scherm vol instructies misleidend, want er valt niets te scannen.
      body += '<div class="warn2" style="margin-top:14px"><b>De brug is nu niet bereikbaar.</b> ' +
        esc(_wa.error) + '<br>Staat de service op de VPS aan?</div>';
    } else {
      body += _wa.qr
        ? '<img class="waqr" width="320" height="320" alt="QR-code om WhatsApp te koppelen" src="' + esc(_wa.qr) + '">'
        : '<div class="empty" style="margin-top:14px">' +
            (_wa.qrError ? esc(_wa.qrError) : 'QR wordt opgehaald&hellip;') + '</div>';
      body += '<ol class="wastap">' +
        '<li>Open <b>WhatsApp</b> op de telefoon</li>' +
        '<li>Ga naar <b>Instellingen</b></li>' +
        '<li>Kies <b>Gekoppelde apparaten</b></li>' +
        '<li>Tik op <b>Apparaat koppelen</b> en scan deze code</li></ol>' +
        '<div class="ronde" style="margin-top:10px">De code ververst zichzelf; laat dit venster open tot het lampje groen wordt.</div>';
    }

    body += '<button class="obtn" style="width:100%;margin-top:16px" onclick="window.__opvWaSluit()">Sluiten</button>';

    // Eigen scrim in plaats van de gedeelde: die sluit via __opvSluit, en dat
    // laat de timers hier doorlopen.
    //
    // De klasse `on` is niet decoratief maar noodzakelijk. Het design system
    // zet in app-shell.css `.scrim{opacity:0;pointer-events:none}` en maakt hem
    // pas zichtbaar met `.scrim.on`. De module-eigen `.opv .scrim` hierboven is
    // wel specifieker, maar noemt opacity en pointer-events niet — dus voor die
    // twee eigenschappen wint de globale regel alsnog. Zonder `on` wordt het
    // paneel dus keurig opgebouwd en is het onzichtbaar. Zie
    // tests/opvolging-scrim-zichtbaar.test.js.
    return '<div class="opv"><div class="scrim on" onmousedown="if(event.target===this)window.__opvWaSluit()">' +
      '<div class="modal"><div class="mh"><div><h3>WhatsApp-brug</h3>' +
      '<p>' + esc(s.uitleg) + '</p></div>' +
      '<button class="x" onclick="window.__opvWaSluit()">&times;</button></div>' +
      '<div class="mb">' + body + '</div></div></div></div>';
  }

  /**
   * De twee vensters op de taakkaart. Toont niets zolang de brug uitgaande
   * berichten niet kan zien: dan is 'geen spraakbericht' een bewering die we
   * niet kunnen doen.
   */
  function vensterBadges(t, dag) {
    if (!brugZietUitgaand()) return '';
    // Alleen op een kaart van iemand met een zoomcall vandaag. De twee vensters
    // gaan over die calls; op een aanmeldkaart hoort er niets over
    // spraakberichten te staan, en juist daar verscheen de rode 'geen
    // spraakbericht' op tien mensen tegelijk.
    if (!heeftCallOpDag(t, dag)) return '';
    const o = beoordeelDag(t, dag);
    const spraak = {
      op_tijd    : ['ok',   '&#127908; spraak ' + esc(o.spraak.tijd || '')],
      te_laat    : ['laat', '&#127908; spraak ' + esc(o.spraak.tijd || '') + ' &middot; na 09:00'],
      niet_gedaan: ['mist', '&#127908; geen spraakbericht'],
    }[o.spraak.staat];
    const nabel = {
      op_tijd    : ['ok',   '&#9742; nagebeld ' + esc(o.nabel.tijd || '')],
      te_laat    : ['laat', '&#9742; nagebeld ' + esc(o.nabel.tijd || '') + ' &middot; buiten 12&ndash;13u'],
      niet_gedaan: ['mist', '&#9742; niet nagebeld'],
      niet_nodig : ['nvt',  '&#9742; ' + esc(o.nabel.reden || 'niet nodig')],
    }[o.nabel.staat];
    return '<div class="mt">' +
      '<span class="vst ' + spraak[0] + '">' + spraak[1] + '</span>' +
      '<span class="vst ' + nabel[0] + '">' + nabel[1] + '</span></div>';
  }

  /**
   * Ziet de brug uitgaande berichten? Alleen dan valt er iets te zeggen over
   * spraakberichten die Dave zelf stuurt.
   *
   * De vlag komt uit /status van de brug. Een oudere brug op de VPS stuurt hem
   * niet mee, en dan blijft het antwoord nee — liever een leeg blok met uitleg
   * dan een nul die eruitziet alsof er gemeten is.
   */
  function brugZietUitgaand() {
    return !!(_wa.data && _wa.data.ziet_uitgaand === true);
  }

  /**
   * De uitleg die in de plaats komt van cijfers die er niet zijn.
   *
   * `eigenReden` is er voor de gevallen waarin de brug wél werkt maar de bron
   * ontbreekt — de agenda die niet laadt, bijvoorbeeld. Zonder argument blijft
   * het gedrag zoals het was.
   */
  function nogNietGemeten(wat, eigenReden) {
    const reden = eigenReden || (_wa.error
      ? 'De WhatsApp-brug is nu niet bereikbaar, dus er valt niets te meten.'
      : (_wa.data && !_wa.data.verbonden)
        ? 'De WhatsApp-brug is nog niet gekoppeld. Zolang dat niet gebeurd is, ziet dit systeem geen enkel bericht.'
        : 'De brug die nu draait ziet nog geen uitgaande berichten. Na het bijwerken van de VPS vult dit blok zichzelf.');
    return '<div class="nietgemeten"><b>' + esc(wat) + ' wordt nog niet gemeten.</b><br>' + esc(reden) +
      '<br><span style="color:#6b7280">Er staat hier bewust geen nul: dat zou eruitzien alsof het gemeten is en op nul uitkwam.</span></div>';
  }

  /**
   * Wat de twee venster-blokken tonen als er niets te meten valt.
   *
   * Vier van de vijf uitkomsten van vensterBron() eindigen hier. Dat is geen
   * defensieve overdaad: elk van die vier is een reden waarom een nul zou
   * liegen, en ze liegen elk op een andere manier.
   */
  function vensterLeegBlok(bron, kop, wat) {
    if (bron.staat === 'geen_brug') return kop + nogNietGemeten(wat);
    if (bron.staat === 'laden') return kop + '<div class="empty">Agenda laden&hellip;</div>';
    if (bron.staat === 'agenda_fout') {
      return kop + nogNietGemeten(wat,
        'De agenda is nu niet bereikbaar (' + bron.error + '), en daarin staat welke leads vandaag een call hebben. ' +
        'Zonder die lijst is er geen verzameling om over te tellen.');
    }
    if (bron.staat === 'geen_calls') {
      return kop + '<div class="empty">Geen zoomcalls ingepland op deze dag, dus hier valt niets te halen.</div>';
    }
    // geen_taken: er zijn wél calls, maar geen enkele staat in de takenlijst.
    return kop + '<div class="empty">' + bron.calls + ' ingeplande call' + (bron.calls === 1 ? '' : 's') +
      ', maar geen ervan staat in de takenlijst &mdash; er is dus geen historiek om aan af te lezen ' +
      'of het spraakbericht en het nabellen gebeurd zijn.</div>';
  }

  /** Het blok op het dagscherm: wie kreeg vanmorgen een spraakbericht? */
  function spraakBlok(taken, dag) {
    // `taken` staat er nog voor de aanroep in de dagweergave, maar is niet meer
    // de bron: die is de agenda. Filter dus niet hierin in de hoop dat het
    // doorwerkt — pas vensterBron aan.
    const bron = vensterBron(dag);
    const kop = '<div class="sh"><div class="ic" style="background:var(--o-purs)">&#127908;</div>' +
      '<h3>Spraakberichten voor 09:00</h3>' +
      (bron.staat === 'ok' ? '<span class="n">' + bron.taken.length + '</span>' : '') + '</div>';
    if (bron.staat !== 'ok') return vensterLeegBlok(bron, kop, 'Het spraakbericht per call');

    const t = telVensters(bron.taken, dag).spraak;
    return kop +
      '<div class="ronde">Elke lead die vandaag een <b>zoomcall</b> heeft staan hoort v&oacute;&oacute;r 09:00 ' +
      'een ingesproken bericht te krijgen. Wie geen call heeft staat hier niet bij.</div>' +
      dekkingsBalk(t, ['op tijd', 'na 09:00', 'geen']) +
      zonderTaakRegel(bron.zonderTaak);
  }

  /** Het blok op het dagscherm: wie is er tussen 12 en 13 uur nagebeld? */
  function nabelBlok(taken, dag) {
    // `taken` staat er nog voor de aanroep in de dagweergave, maar is niet meer
    // de bron: die is de agenda. Filter dus niet hierin in de hoop dat het
    // doorwerkt — pas vensterBron aan.
    const bron = vensterBron(dag);
    const kop = '<div class="sh"><div class="ic" style="background:var(--o-accs)">&#9742;</div>' +
      '<h3>Nabellen tussen 12:00 en 13:00</h3></div>';
    if (bron.staat !== 'ok') return vensterLeegBlok(bron, kop, 'Het nabelvenster');

    const t = telVensters(bron.taken, dag).nabel;
    if (t.totaal === 0) {
      return kop + '<div class="empty">Niemand met een call vandaag hoeft nagebeld te worden' +
        (t.niet_nodig ? ' — ' + t.niet_nodig + ' lead' + (t.niet_nodig === 1 ? '' : 's') + ' had geen spraakbericht of heeft al geantwoord.' : '.') + '</div>' +
        zonderTaakRegel(bron.zonderTaak);
    }
    return kop +
      '<div class="ronde">Van de leads met een <b>zoomcall</b> vandaag: wie een spraakbericht kreeg en niet antwoordde, ' +
      'hoort tussen <b>12:00 en 13:00</b> gebeld te worden. Later op de dag bellen telt als te laat, niet als gedaan.</div>' +
      dekkingsBalk(t, ['in het venster', 'buiten het venster', 'niet gebeld']) +
      zonderTaakRegel(bron.zonderTaak);
  }

  /** Eén balk met de drie uitkomsten, plus de aantallen eronder. */
  function dekkingsBalk(t, labels) {
    const pct = (n) => (t.totaal ? (n / t.totaal) * 100 : 0);
    return '<div class="balk">' +
      '<i class="ok" style="width:' + pct(t.op_tijd) + '%"></i>' +
      '<i class="laat" style="width:' + pct(t.te_laat) + '%"></i>' +
      '<i class="mist" style="width:' + pct(t.niet_gedaan) + '%"></i></div>' +
      '<div class="balklegenda">' +
      '<span class="ok">' + t.op_tijd + ' ' + esc(labels[0]) + '</span>' +
      '<span class="laatc">' + t.te_laat + ' ' + esc(labels[1]) + '</span>' +
      '<span class="bad">' + t.niet_gedaan + ' ' + esc(labels[2]) + '</span>' +
      '<span style="color:#6b7280">van ' + t.totaal + '</span></div>';
  }

  /**
   * Het dashboard-deel: hoeveel van de ingeplande mensen kregen hun
   * spraakbericht voor 09:00, en hoeveel zijn er binnen het nabelvenster
   * gebeld. Dezelfde beoordeling als op het dagscherm, alleen opgeteld.
   */
  function vensterDashboardBlok(dag) {
    const kop = '<div class="sh"><div class="ic" style="background:var(--o-purs)">&#9200;</div>' +
      '<h3>Op tijd vandaag</h3></div>';

    // Dezelfde verzameling als op het dagscherm: de leads met een zoomcall,
    // niet iedereen die vandaag open staat. Hier stond telVensters over
    // st.data.taken, en dat rekende dus over dezelfde verkeerde groep — met
    // tien aanmeldingen erbij zakte de dekking naar beneden om een reden die
    // niets met Daves werk te maken had.
    const st = _live.taken;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) queueMicrotask(() => fetchTaken(dag));

    const bron = vensterBron(dag);
    if (bron.staat !== 'ok') {
      return vensterLeegBlok(bron, kop, 'Het spraakbericht en het nabelvenster');
    }

    const t = telVensters(bron.taken, dag);

    return kop + '<div class="vstrij">' +
      '<div><div class="vstkop">Spraakbericht v&oacute;&oacute;r 09:00</div>' +
      dekkingsBalk(t.spraak, ['op tijd', 'na 09:00', 'geen']) + '</div>' +
      '<div><div class="vstkop">Nagebeld tussen 12:00 en 13:00</div>' +
      (t.nabel.totaal
        ? dekkingsBalk(t.nabel, ['in het venster', 'buiten het venster', 'niet gebeld'])
        : '<div class="empty" style="padding:12px">Niemand hoefde nagebeld te worden.</div>') +
      '</div></div>' + zonderTaakRegel(bron.zonderTaak);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // AANMELDINGEN VOOR EEN EVENT
  // ═════════════════════════════════════════════════════════════════════════
  const AANMELD_REDEN = 'aanmelding';
  const isAanmelding = (t) => t && t.reden === AANMELD_REDEN;

  /**
   * De plaats, maar alleen als het er één is.
   *
   * `events.location` is één vrij tekstveld: er staat soms een stad in ('Gent')
   * en soms een volledig postadres ('Belgie - Deinsesteenweg 108 | 9031 Drongen
   * (Gent)'). Dat tweede hoort niet in een kop — dan leest de titel als
   * 'Forex Masterclass Gent · Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)'
   * en is de eventnaam weg.
   *
   * De stad uit zo'n adres vissen is een parser bouwen op één voorbeeld. Dus
   * andersom: kort en zonder adres-kenmerken (cijfers, komma, pijp, ' - ',
   * haakje) is een plaatsnaam en mag mee; al het andere valt weg. Weglaten is
   * veilig — dan staat er alleen de titel, en die klopt altijd.
   *
   * Zelfde regel als kortePlaats() in api/_lib/opvolging-aanmelding.js. Een
   * browser-view kan daar niet uit importeren; tests/opvolging-korte-plaats.test.js
   * bewaakt dat de twee hetzelfde blijven doen.
   */
  function kortePlaats(location) {
    const v = String(location == null ? '' : location).trim();
    if (!v || v.length > 24) return '';
    if (/[0-9|,;]/.test(v)) return '';
    if (v.includes(' - ') || v.includes('(')) return '';
    return v;
  }

  /** Titel plus plaats, maar alleen als die plaats een plaatsnaam is. */
  function eventKopTekst(e) {
    const titel = e && e.event_titel ? String(e.event_titel).trim() : '';
    const plaats = kortePlaats(e && e.event_plaats);
    // Let op waar esc() ophoudt: het scheidingsteken hoort ERBUITEN. Stond het
    // erbinnen, dan las Dave letterlijk '&middot;' op zijn scherm — dezelfde
    // fout als eerder in de groepskop.
    return [titel, plaats].filter(Boolean).map(esc).join(' &middot; ');
  }

  /** Is er echt contact geweest? Zelfde regel als api/_lib/opvolging-aanmelding.js. */
  function echtContact(p) {
    if (!p) return false;
    const r = String(p.resultaat || '').toLowerCase();
    if (p.soort === 'call') return /gesproken/.test(r);
    if (p.soort === 'whatsapp' || p.soort === 'spraakbericht') return /ontvangen/.test(r);
    return false;
  }
  const heeftContact = (t) => ((t && t.pogingen) || []).some(echtContact);

  /**
   * Is deze aanmeldkaart klaar voor vandaag?
   *
   * Zonder echt contact blijft hij terugkomen met het gewone ritme: na de
   * eerste poging naar de tweede ronde, na de tweede is hij vandaag klaar en
   * staat hij morgen terug. Dat laatste blok staat onderaan Vandaag, NIET in
   * Afgerond — dat tabblad is archief en bewijsscherm, en een kaart die morgen
   * gewoon terugkomt hoort daar niet tussen.
   */
  function klaarVoorVandaag(t) {
    if (heeftContact(t)) return false;                 // dan is hij écht klaar
    return (t.bel_vandaag || 0) + (t.wa_vandaag || 0) >= DOEL_BELLEN;
  }

  /** De eventgegevens die de cron in bron_ref heeft gezet. */
  const evVan = (t) => (t && t.bron_ref) || {};

  /**
   * Kaarten groeperen per event, op eventdatum. De groepskop draagt de context
   * — naam, plaats, dag, uur, over hoeveel dagen, hoeveel aanmeldingen — zodat
   * de kaarten eronder er precies zo uitzien als overal elders.
   */
  function groepeerPerEvent(taken) {
    const groepen = new Map();
    for (const t of taken) {
      const e = evVan(t);
      const sleutel = e.event_id || 'onbekend';
      if (!groepen.has(sleutel)) {
        groepen.set(sleutel, {
          titel : e.event_titel || 'Onbekend event',
          plaats: e.event_plaats || '',
          start : e.event_start || null,
          dag   : e.event_dag || null,
          taken : [],
        });
      }
      groepen.get(sleutel).taken.push(t);
    }
    return [...groepen.values()].sort((a, b) => String(a.dag || '9999').localeCompare(String(b.dag || '9999')));
  }

  function evGroepKop(g) {
    const nu = vandaag();
    const over = g.dag ? Math.round((Date.parse(g.dag + 'T12:00:00Z') - Date.parse(nu + 'T12:00:00Z')) / 86400000) : null;
    const wanneer = over === null ? ''
      : over < 0 ? 'geweest'
      : over === 0 ? 'vandaag'
      : over === 1 ? 'morgen'
      : 'over ' + over + ' dagen';
    const uur = g.start ? new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(g.start)).replace(',', '') : '';
    // De kop moet in één oogopslag zeggen: welk event, wanneer, over hoeveel
    // dagen, hoeveel mensen. Daarom staat alleen de naam vet.
    //
    // Het adres staat eronder, klein en grijs. `event_plaats` is een volledig
    // postadres ('Belgie - Deinsesteenweg 108 | 9031 Drongen (Gent)') en dat
    // vetgedrukt naast de titel duwde de eventnaam weg. Alleen de stad zou
    // mooier zijn, maar events.location is één vrij tekstveld — er is geen
    // stad-kolom, en 'Gent' daaruit vissen is een parser op één voorbeeld.
    // Dat is gokken; dan liever het hele adres, klein en grijs.
    //
    // Let ook op waar esc() ophoudt: het scheidingsteken hoorde erbuiten.
    // Stond het erbinnen, dan las Dave letterlijk '&middot;' op zijn scherm —
    // en dat stond er tot vandaag ook.
    const titel = String(g.titel || '').trim();
    const adres = String(g.plaats || '').trim();
    return '<div class="evkop">' +
      '<div class="evkr">' +
        '<b>' + esc(titel || 'Event') + '</b>' +
        (uur ? '<span class="wan">' + esc(uur) + '</span>' : '') +
        (wanneer ? '<span class="straks' + (over !== null && over <= 1 ? ' dichtbij' : '') + '">' + esc(wanneer) + '</span>' : '') +
        '<span class="tel">' + g.taken.length + ' aanmelding' + (g.taken.length === 1 ? '' : 'en') + '</span>' +
      '</div>' +
      (adres ? '<div class="evadr">' + esc(adres) + '</div>' : '') +
      '</div>';
  }

  /** Het blok met aanmeldingen, gegroepeerd per event. */
  function aanmeldBlok(taken, dag) {
    if (taken.length === 0) return '';
    return '<div class="sh"><div class="ic" style="background:var(--o-grns)">&#127903;</div>' +
      '<h3>Aanmeldingen</h3><span class="n">' + taken.length + '</span></div>' +
      '<div class="ronde">Deze mensen hebben zich aangemeld. Bel binnen een dag om te vragen of alles goed verlopen is; ' +
      'vier dagen voor het event komt dezelfde naam vanzelf terug.</div>' +
      groepeerPerEvent(taken).map((g) =>
        '<div class="evgroep">' + evGroepKop(g) +
        g.taken.map((t) => taakKaart(t, dag, { inGroep: true })).join('') + '</div>'
      ).join('');
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DE WEEKBALK
  // ═════════════════════════════════════════════════════════════════════════
  // Zes dagen, want Dave werkt ook op zaterdag. Zondag niet: dan zou de balk
  // een kolom tonen waarop er niets gebeurt.
  //
  // Zondag is daarom ook het enige moment waarop de balk niet de week van
  // vandaag opent maar de komende: die werkweek is voorbij, en wat Dave dan
  // wil zien is wat er morgen ligt.
  const WEEKDAG_LABELS = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za'];

  /**
   * De maandag waar de balk op staat bij offset 0. Ma t/m za is dat de maandag
   * van deze week; op zondag de maandag erna.
   */
  /**
   * '7 sep' — voor het kopje boven de balk. De dagknoppen dragen de datum al
   * als 07/09; een maandnaam erboven leest sneller en verwart niet met een
   * weeknummer.
   */
  function kortDatum(d) {
    if (!d) return '';
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'short',
    }).format(new Date(d + 'T12:00:00Z'));
  }

  function basisMaandag(nu) {
    const dow = new Date(nu + 'T12:00:00Z').getUTCDay();   // 0 = zondag
    return dow === 0 ? dagPlus(nu, 1) : maandagVan(nu);
  }

  /**
   * Welke week toont de balk? Pure functie — na te slaan via
   * window.__opvWeekHelpers, getest in tests/opvolging-weekbalk.test.js.
   *
   *   { maandag, dagen: [zes datums, ma t/m za], label, bevatVandaag }
   */
  function bepaalWeek({ nu, offset = 0 }) {
    const maandag = dagPlus(basisMaandag(nu), (Number(offset) || 0) * 7);
    const dagen = WEEKDAG_LABELS.map((_, i) => dagPlus(maandag, i));
    // 'Deze week' hangt aan wat er in de balk staat, niet aan de offset. Op
    // zondag toont offset 0 de komende week, en die 'deze week' noemen zou
    // Dave op het verkeerde been zetten.
    const bevatVandaag = dagen.indexOf(nu) !== -1;
    return {
      maandag,
      dagen,
      bevatVandaag,
      label: bevatVandaag ? 'Deze week' : 'Week van ' + kortDatum(maandag),
    };
  }

  /**
   * Welke offset zet dag `d` in beeld? Gebruikt door __opvDag: valt de gekozen
   * dag buiten de getoonde week, dan schuift de balk mee. De offset blijft zo
   * de enige bron voor wat de balk toont, en de pijlen blijven werken — zou de
   * balk in plaats daarvan bij het tekenen naar dagView toe springen, dan kon
   * je met de pijl geen andere week meer bekijken.
   */
  function weekOffsetVoorDag({ nu, d }) {
    if (!d) return 0;
    const van  = Date.parse(basisMaandag(nu) + 'T12:00:00Z');
    const naar = Date.parse(basisMaandag(d) + 'T12:00:00Z');
    if (!Number.isFinite(van) || !Number.isFinite(naar)) return 0;
    return Math.round((naar - van) / (7 * 86400000));
  }

  function weekbalk(dag) {
    const nu = vandaag();
    const wk = bepaalWeek({ nu, offset: _ui.weekOffset });
    const terug = _ui.weekOffset > WEEK_MIN_OFFSET;
    const heen  = _ui.weekOffset < WEEK_MAX_OFFSET;

    let knoppen = '<div class="wk">';
    wk.dagen.forEach((d, i) => {
      const aan = d === dag;
      knoppen += '<button class="wkd ' + (aan ? 'on' : '') + ' ' + (d === nu ? 'nu' : '') + ' ' + (d < nu ? 'oud' : '') + '"' +
        ' onclick="window.__opvDag(\'' + d + '\')">' +
        '<span class="l"><span class="d">' + WEEKDAG_LABELS[i] + ' ' + nl(d) + '</span>' +
          (d === nu ? ' <span class="vd">vandaag</span>' : '') + '</span>' +
        '<span class="c">' + (aan && _live.taken.data ? _live.taken.data.taken.length : '·') + '<small> open</small></span></button>';
    });
    knoppen += '</div>';

    return '<div class="wkbar">' +
      '<button class="obtn wkp" ' + (terug ? '' : 'disabled style="opacity:.4;cursor:default" ') +
        'title="Vorige week" onclick="window.__opvWeekbalk(-1)">&#8592;</button>' +
      '<div class="wkmid">' +
        '<div class="wklbl"><span>' + esc(wk.label) + '</span>' +
          (wk.bevatVandaag ? '' : '<button class="wknu" onclick="window.__opvWeekbalkNu()">terug naar vandaag</button>') +
        '</div>' + knoppen +
      '</div>' +
      '<button class="obtn wkp" ' + (heen ? '' : 'disabled style="opacity:.4;cursor:default" ') +
        'title="Volgende week" onclick="window.__opvWeekbalk(1)">&#8594;</button>' +
      '</div>';
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · VANDAAG
  // ═════════════════════════════════════════════════════════════════════════
  function vandaagView() {
    stijl();
    const dag = _ui.dagView || vandaag();
    const st = _live.taken;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) queueMicrotask(() => fetchTaken(dag));

    let h = '<div class="opv">';
    // Kop: de bestaande uitleg links, het brug-lampje rechts. Het lampje is
    // tegelijk het levensteken waaraan de timers zien of deze view nog in beeld
    // is — zie herstelWaTimers().
    h += '<div class="kop">' +
      '<div class="info">De spraakberichten en het nabelvenster hangen aan de WhatsApp-brug. ' +
      'Ziet die brug nog geen uitgaande berichten, dan blijven die blokken leeg met uitleg &mdash; ' +
      'nooit met een nul die eruitziet alsof er gemeten is.</div>' +
      waLamp() + '</div>';
    h += weekbalk(dag);
    // Boven de takenlijst: eerst wat er vaststaat vandaag, dan wat je zelf
    // moet oppakken. De agenda hangt niet aan de takenlijst — valt hij weg,
    // dan toont dit blok een melding en gaat de rest gewoon door.
    h += callsBlok(dag);

    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>' + modalHtml() + waPaneelHtml();
    if (st.loading || !st.data) return h + skel() + '</div>' + modalHtml() + waPaneelHtml();

    const alles = st.data.taken || [];
    // Aanmeldingen krijgen hun eigen blok, gegroepeerd per event. Wat vandaag
    // al genoeg aandacht heeft gehad zakt naar 'Klaar voor vandaag' onderaan;
    // dat is geen archief, want morgen staat hij gewoon terug.
    const aanmeldingen = alles.filter((t) => isAanmelding(t) && !klaarVoorVandaag(t));
    const klaar        = alles.filter((t) => isAanmelding(t) && klaarVoorVandaag(t));
    const rest         = alles.filter((t) => !isAanmelding(t));
    const r1 = rest.filter((t) => !t.later && !t.bel_vandaag && !t.wa_vandaag);
    const r2 = rest.filter((t) => t.later || t.bel_vandaag || t.wa_vandaag);
    const wacht = st.data.wacht || [];

    // De twee vensters van de dag, boven de werklijst: eerst wat er van de
    // ochtend en de middag terechtgekomen is, dan het werk zelf.
    h += spraakBlok(alles, dag);
    h += nabelBlok(alles, dag);

    h += aanmeldBlok(aanmeldingen, dag);

    h += '<div class="sh"><div class="ic" style="background:#eef0f3">&#9776;</div><h3>Werklijst</h3><span class="n">' + r1.length + '</span></div>';
    h += '<div class="ronde">Elke naam die je aanraakt verlaat deze lijst. Wil je er later vandaag nog eens achter, dan zakt hij naar de tweede ronde — zo wordt deze lijst alleen maar korter. <b>Wat je vandaag niet afwerkt, staat morgen vanzelf terug</b> met de melding "bleef liggen"; doorschuiven naar morgen hoef je niet te doen.</div>';
    h += r1.length ? r1.map((t) => taakKaart(t, dag)).join('')
      : '<div class="empty">Eerste ronde afgewerkt.' + (r2.length ? ' Wat overblijft staat in de tweede ronde.' : '') + '</div>';

    if (r2.length) {
      h += '<div class="sh"><div class="ic" style="background:#eef0f3">&#8635;</div><h3>Tweede ronde vandaag</h3><span class="n">' + r2.length + '</span></div>' +
        '<div class="ronde">Deze heb je vandaag al geprobeerd. Nog eens bellen mag; anders verplaats je ze naar een andere dag.</div>' +
        r2.map((t) => taakKaart(t, dag)).join('');
    }

    if (wacht.length) {
      h += '<div class="sh"><div class="ic" style="background:var(--o-accs)">&#128233;</div><h3>Wacht op inplanning</h3><span class="n">' + wacht.length + '</span></div>' +
        '<div class="ronde">Deze leads kregen de agenda doorgestuurd en kiezen zelf. Staat er na <b>48 uur</b> niets in de agenda, dan komt de naam terug in je takenlijst.</div>';
      h += wacht.map((w) => {
        const uren = w.agenda_doorgestuurd_at ? Math.floor((Date.now() - new Date(w.agenda_doorgestuurd_at)) / 36e5) : 0;
        const rest = Math.max(0, 48 - uren);
        return '<div class="row"><div class="who"><div class="nm">' + esc(w.naam) +
          ' <span class="tag ' + (rest ? 't-blue' : 't-red') + '">' + (rest ? 'nog ' + rest + 'u' : 'termijn voorbij') + '</span>' +
          (w.badge_label ? ' <span class="tag t-grey">' + esc(w.badge_label) + '</span>' : '') + '</div>' +
          '<div class="mt"><span style="color:#6b7280;font-size:12.5px">' + esc(w.telefoon || '') + ' &middot; agenda ' + uren + 'u geleden doorgestuurd</span></div></div>' +
          '<div class="act"><button class="obtn wa" onclick="window.__opvWa(\'' + w.id + '\')">&#128172; Herinneren</button>' +
          '<button class="obtn" onclick="window.__opvTerug(\'' + w.id + '\')">Terug in de lijst</button></div></div>';
      }).join('');
    }

    if (klaar.length) {
      h += '<div class="sh"><div class="ic" style="background:var(--o-grns)">&#10003;</div>' +
        '<h3>Klaar voor vandaag</h3><span class="n">' + klaar.length + '</span></div>' +
        '<div class="ronde">Deze heb je vandaag genoeg geprobeerd, maar er is nog geen echt contact geweest. ' +
        'Ze staan morgen gewoon terug &mdash; dit is geen archief.</div>' +
        '<div class="klaarblok">' +
        groepeerPerEvent(klaar).map((g) =>
          '<div class="evgroep">' + evGroepKop(g) +
          g.taken.map((t) => taakKaart(t, dag, { inGroep: true })).join('') + '</div>'
        ).join('') + '</div>';
    }

    return h + '</div>' + modalHtml() + waPaneelHtml();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · DASHBOARD
  // ═════════════════════════════════════════════════════════════════════════
  function dashboardView() {
    stijl();
    const dag = vandaag();
    const st = _live.dash;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) queueMicrotask(() => fetchDash(dag));

    let h = '<div class="opv">';
    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>';
    if (st.loading || !st.data) return h + skel() + '</div>';

    const d = st.data.dekking, di = st.data.discipline, ip = st.data.inplanning;
    const rest = d.totaal - d.aangeraakt;

    h += '<div class="dhero"><div class="lbl">' + esc(nl(dag)) + '</div>' +
      '<div class="big">' + (rest ? rest + ' lead' + (rest > 1 ? 's' : '') + ' vandaag nog niet aangeraakt' : 'Iedereen is vandaag aangeraakt') + '</div>' +
      '<div class="sml">' + d.volledig + ' van ' + d.totaal + ' leads kregen de ' + d.doel + ' belpogingen die we afgesproken hebben.</div></div>';

    h += '<div class="sh"><div class="ic" style="background:var(--o-accs)">&#9737;</div><h3>Dekking van vandaag</h3></div><div class="grid">' +
      kpi('Twee keer gebeld', d.volledig + '/' + d.totaal, (d.aangeraakt - d.volledig) + ' pas één keer &middot; ' + rest + ' nog niet gebeld', d.volledig === d.totaal ? 'g' : d.volledig ? 'a' : 'r') +
      kpi('Zonder WhatsApp', d.zonder_whatsapp.length, d.zonder_whatsapp.length ? '<span class="bad">' + d.zonder_whatsapp.map((x) => esc(x.naam)).join(', ') + '</span>' : '<span class="ok">iedereen heeft een bericht gehad</span>', d.zonder_whatsapp.length ? 'a' : 'g') +
      '</div>';

    h += '<div class="cov">' + (d.per_lead.length ? d.per_lead.map((p) => {
      const ok = p.bel_vandaag >= d.doel && p.wa_totaal > 0;
      return '<div class="covr"><span class="nm2">' + esc(p.naam) + '</span>' +
        '<span class="pil ' + (p.bel_vandaag ? 'aan' : 'uit') + '">&#9742; ' + p.bel_vandaag + '/' + d.doel + ' ' + dots(p.bel_vandaag, d.doel) + '</span>' +
        '<span class="pil ' + (p.wa_totaal ? 'wa' : 'uit') + '">&#128172; ' + (p.wa_totaal ? p.wa_totaal + '&times;' : 'geen') + '</span>' +
        '<span class="st ' + (ok ? 'ok' : p.bel_vandaag ? 'laatc' : 'bad') + '">' + (ok ? 'volledig' : p.bel_vandaag ? 'niet af' : 'niets gedaan') + '</span></div>';
    }).join('') : '<div class="empty">Geen open taken vandaag.</div>') + '</div>';

    // ── De twee vensters, in dezelfde vorm als op het dagscherm ──────────────
    // Leest de takenlijst van vandaag (die het dagscherm toch al ophaalt) en
    // beoordeelt elk moment tegen zijn venster. Zonder brug die uitgaande
    // berichten ziet: uitleg in plaats van een nul.
    h += vensterDashboardBlok(dag);

    h += '<div class="sh"><div class="ic" style="background:var(--o-ambs)">&#9878;</div><h3>Discipline</h3></div><div class="grid">' +
      kpi('Aangeraakt', d.aangeraakt + '/' + d.totaal, 'taken met een poging vandaag', d.aangeraakt === d.totaal ? 'g' : 'a') +
      kpi('Uitgesteld zonder poging', di.uitgesteld_zonder_poging, di.uitgesteld_zonder_poging ? '<span class="bad">hier verdwijnt werk</span>' : '<span class="ok">geen</span>', di.uitgesteld_zonder_poging ? 'r' : 'g') +
      kpi('Bleef liggen', di.bleef_liggen, 'automatisch doorgerold', di.bleef_liggen ? 'a' : 'g') +
      kpi('Tweede ronde', di.tweede_ronde, 'vandaag nog eens proberen', 'b') +
      '</div>';

    h += '<div class="sh"><div class="ic" style="background:var(--o-purs)">&#128197;</div><h3>Inplanning</h3></div><div class="grid">' +
      kpi('Calls ingepland', ip.ingepland, 'vandaag geboekt', 'g') +
      kpi('Wacht op inplanning', ip.wacht, 'binnen de 48 uur', 'b') +
      kpi('Niet ingepland na 48u', ip.niet_ingepland, ip.niet_ingepland ? '<span class="bad">terug in de lijst</span>' : '<span class="ok">geen</span>', ip.niet_ingepland ? 'r' : 'g') +
      '</div>';

    h += '<div class="sh"><div class="ic" style="background:#eef0f3">&#128200;</div><h3>Deze week</h3></div><div class="card"><table>' +
      '<thead><tr><th>Dag</th><th>Belpogingen</th><th>WhatsApps</th><th>Ingepland</th></tr></thead><tbody>' +
      st.data.week.map((w) => '<tr><td>' + nl(w.dag) + (w.dag === dag ? ' <b>· vandaag</b>' : '') + '</td><td>' + w.belpogingen + '</td><td>' + w.whatsapps + '</td><td>' + w.ingepland + '</td></tr>').join('') +
      '</tbody></table></div>';

    if (st.data.gearchiveerd.length) {
      h += '<div class="sh"><div class="ic" style="background:var(--o-reds)">&#128269;</div><h3>Gearchiveerd vandaag — steekproef</h3></div><div class="card"><table>' +
        '<thead><tr><th>Naam</th><th>Reden</th><th>Moeite</th></tr></thead><tbody>' +
        st.data.gearchiveerd.map((a) => {
          const ok = a.bel_dagen >= ARCHIEF_MIN_DAGEN && a.wa_totaal >= ARCHIEF_MIN_WA;
          return '<tr><td><b>' + esc(a.naam) + '</b></td><td style="color:#6b7280">' + esc(a.archief_reden || '') + '</td>' +
            '<td>' + a.bel_totaal + '&times; gebeld op ' + a.bel_dagen + ' dag' + (a.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + a.wa_totaal + '&times; WhatsApp ' +
            (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }

    return h + '</div>';
  }
  const kpi = (k, v, s, kleur) => '<div class="kpi ' + (kleur || '') + '"><div class="k">' + k + ' &#9889;</div><div class="v">' + v + '</div><div class="s">' + s + '</div></div>';

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · AFGEROND
  // ═════════════════════════════════════════════════════════════════════════
  function afgerondView() {
    stijl();
    const st = _live.archief;
    if (!st.loading && !st.error && !st.data) queueMicrotask(fetchArchief);

    let h = '<div class="opv">';
    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>';
    if (st.loading || !st.data) return h + skel() + '</div>';
    if (!st.data.length) return h + '<div class="empty">Nog niets afgerond.</div></div>';

    h += '<div class="ronde">Klik op een naam om te zien hoe vaak er gebeld en geappt is voor die lead afgesloten werd.</div>' +
      '<div class="card"><table><thead><tr><th>Naam</th><th>Reden</th><th>Moeite</th><th>Afgerond</th></tr></thead><tbody>';
    h += st.data.map((a) => {
      const ok = a.bel_dagen >= ARCHIEF_MIN_DAGEN && a.wa_totaal >= ARCHIEF_MIN_WA;
      return '<tr style="cursor:pointer" onclick="window.__opvHist(\'' + a.id + '\')"><td><b>' + esc(a.naam) + '</b>' +
        '<div style="font-size:12.5px;color:#6b7280">' + esc(a.archief_reden || '') + '</div></td>' +
        '<td><span class="tag t-grey">' + esc((REDEN_LABEL[a.reden] || [a.reden])[0]) + '</span></td>' +
        '<td>' + a.bel_totaal + '&times; &#9742; op ' + a.bel_dagen + ' dag' + (a.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + a.wa_totaal + '&times; &#128172; ' +
        (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig</span>') + '</td>' +
        '<td style="color:#6b7280">' + esc(a.gearchiveerd_at ? nl(iso(a.gearchiveerd_at)) : '') + '</td></tr>';
    }).join('');
    return h + '</tbody></table></div></div>' + modalHtml();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // MODALS
  // ═════════════════════════════════════════════════════════════════════════
  /**
   * Welke vensters hangen NIET aan een taak?
   *
   * De uitkomst van een zoomcall wordt vastgelegd vanuit 'Calls van vandaag',
   * en zo'n call komt uit de agenda — er hoeft nog helemaal geen taak voor te
   * bestaan. Die twee vensters hangen dus aan _calls.data[m.callIndex].
   *
   * Deze verzameling staat hier expliciet omdat de fout die hij voorkomt niet
   * te zien is: modalHtml() begon met zoekTaak(m.taakId), en bij een call is
   * dat undefined. zoekTaak gaf null, de functie stopte met een lege string, en
   * de Afronden-knop deed niets. Geen console-fout, geen venster, geen spoor —
   * dezelfde stille vorm als de scrim-bug. tests/opvolging-call-modal.test.js
   * controleert dat elk venster dat zonder taakId geopend wordt, hier staat.
   */
  const MODAL_ZONDER_TAAK = new Set(['call-afrond', 'call-uitkomst']);

  /**
   * De vier uitkomsten van een zoomcall. Hangt aan de agenda, niet aan een taak.
   *
   * De call kan best iemand zijn die nog nergens in de takenlijst staat — dat
   * is juist het normale geval bij een eerste gesprek. Vandaar dat dit venster
   * vóór de taak-guard in modalHtml() wordt afgehandeld.
   */
  function callModalHtml(m) {
    const c = (_calls.data || [])[m.callIndex];
    if (!c) return '';
    if (m.soort === 'call-afrond') {
      const b =
        opt('&#127881;', 'var(--o-grns)', 'Klant geworden', 'Klaar. Er komt geen taak bij.', "window.__opvCallUitkomst('klant_geworden')") +
        opt('&#129300;', 'var(--o-ambs)', 'Wil nog beslissen', 'Kies een dag en schrijf op waar hij over twijfelt.', "window.__opvCallUitkomst('wil_nog_beslissen')") +
        opt('&#128683;', 'var(--o-reds)', 'No-show', 'Kwam niet opdagen. Staat vandaag meteen terug in je lijst.', "window.__opvCallUitkomst('no_show')") +
        opt('&#128533;', '#f0f1f4', 'Geen interesse', 'Schrijf op waarom. Er komt geen taak bij.', "window.__opvCallUitkomst('geen_interesse')");
      return scrim('Call met ' + esc(c.naam) + ' afronden', 'Wat is er uit dit gesprek gekomen?', b);
    }

    const u = m.uitkomst;
    if (u === 'klant_geworden') {
      return scrim('Klant geworden', esc(c.naam) + ' &middot; ' + esc(c.tijd),
        '<div class="info">Mooi. Er komt <b>geen taak</b> bij — deze is klaar.<br><br>' +
        'De afspraak zelf blijft staan zoals hij staat; die administratie loopt via het afspraakscherm en verandert hier niet.</div>' +
        '<button class="obtn" style="width:100%;margin-top:12px" onclick="window.__opvSluit()">Sluiten</button>');
    }
    if (u === 'geen_interesse') {
      return scrim('Geen interesse', esc(c.naam) + ' &middot; ' + esc(c.tijd),
        '<div class="info">Er komt <b>geen taak</b> bij. Schrijf wel op waarom, dan weet de volgende het.</div>' +
        '<textarea id="opv-cn" rows="3" placeholder="Waarom haakt hij af?"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvCallBevestig(\'geen_interesse\')">Vastleggen</button>');
    }
    if (u === 'no_show') {
      return scrim('No-show', esc(c.naam) + ' &middot; ' + esc(c.tijd),
        '<div class="info">Hij komt <b>vandaag meteen terug</b> in je takenlijst, met reden no-show call.</div>' +
        '<textarea id="opv-cn" rows="2" placeholder="Notitie (mag leeg)"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvCallBevestig(\'no_show\')">Zet terug in de lijst</button>');
    }
    // wil_nog_beslissen
    return scrim('Wil nog beslissen', esc(c.naam) + ' &middot; ' + esc(c.tijd),
      '<div class="ronde">Op welke dag bel je hem terug?</div>' +
      '<input type="date" id="opv-cd" value="' + dagPlus(vandaag(), 2) + '">' +
      '<div class="ronde" style="margin-top:12px">Waar twijfelt hij over? Zonder die zin begint het volgende gesprek weer bij nul.</div>' +
      '<textarea id="opv-cn" rows="3" placeholder="Bijvoorbeeld: wil het eerst met zijn vrouw bespreken"></textarea>' +
      '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvCallBevestig(\'wil_nog_beslissen\')">Zet in de lijst</button>');
  }

  function modalHtml() {
    const m = _ui.modal;
    if (!m) return '';

    // Eerst wat geen taak nodig heeft, en pas daarna de taak-guard. Andersom
    // sneuvelen deze twee stil op een taak die er nooit had moeten zijn.
    if (MODAL_ZONDER_TAAK.has(m.soort)) return callModalHtml(m);

    const t = zoekTaak(m.taakId);
    if (!t) return '';
    let body = '';

    // Een aanmelding heeft andere uitgangen dan een gewone opvolgtaak: er is
    // nog niets gebeurd, dus 'opnieuw inplannen' of 'agenda doorgestuurd' slaan
    // hier nergens op.
    if (m.soort === 'watnu' && isAanmelding(t)) {
      const e = evVan(t);
      // 'Bevestigd' staat bovenaan: dat is verreweg de meest voorkomende
      // uitkomst, en de knop die het vaakst gedrukt wordt hoort niet onderaan.
      const evDagB = e.event_dag || null;
      const wakkerB = evDagB ? dagPlus(evDagB, -WAKKER_DAGEN) : null;
      const nogRonde = !!wakkerB && wakkerB > vandaag();
      const body =
        opt('&#10003;', 'var(--o-grns)', 'Bevestigd &mdash; hij komt',
          nogRonde
            ? 'Vandaag klaar. Op ' + nl(wakkerB) + ' staat hij vanzelf terug voor de reminder-call.'
            : 'Het event is dichtbij, dus dit is de laatste ronde. De kaart gaat dicht.',
          "window.__opvAanmeldActie('bevestigd')") +
        opt('&#128172;', 'var(--o-grns)', 'Gesprek gehad', 'Schrijf op wat er gezegd is. Daarmee is deze kaart klaar.', "window.__opvAanmeldActie('gesprek_gehad')") +
        opt('&#128533;', '#f0f1f4', 'Geen interesse of per ongeluk aangemeld', 'Archiveren. Hij moet dan ook in de eventmodule op geannuleerd.', "window.__opvAanmeldActie('geen_interesse')") +
        opt('&#128257;', 'var(--o-accs)', 'Verplaatst naar een ander event', 'Wacht op bevestiging; na 48 uur zonder nieuwe aanmelding komt hij terug.', "window.__opvAanmeldActie('verplaatst')");
      return scrim('Wat nu met ' + esc(t.naam) + '?',
        eventKopTekst(e) || 'Aanmelding', body);
    }

    if (m.soort === 'aanmeld-actie') {
      const u = m.uitkomst;
      if (u === 'bevestigd') {
        const evDag = evVan(t).event_dag || null;
        const wakker = evDag ? dagPlus(evDag, -WAKKER_DAGEN) : null;
        const nogRonde = !!wakker && wakker > vandaag();
        // Geen verplichte notitie. Dit is de knop die het vaakst gedrukt wordt;
        // een verplicht veld maakt de gewoonste uitkomst de traagste handeling,
        // en dan wordt hij ontweken.
        return scrim(esc(t.naam) + ' komt', nogRonde ? 'Ronde 1 van 2' : 'Laatste ronde',
          '<div class="ronde">' + (nogRonde
            ? 'Hij verdwijnt vandaag uit je lijst en staat op <b>' + esc(nl(wakker)) +
              '</b> vanzelf terug voor de reminder-call &mdash; dan bel je niet meer met de vraag ' +
              '<i>of</i> hij komt, maar of het nog klopt.'
            : 'Het event is binnen vier dagen, dus er komt geen ronde meer. De kaart gaat dicht.') +
          '</div>' +
          '<textarea id="opv-an" rows="2" placeholder="Notitie (mag leeg) — bv. komt met zijn broer"></textarea>' +
          '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvAanmeldBevestig(\'bevestigd\')">' +
          'Bevestigd vastleggen</button>');
      }
      if (u === 'gesprek_gehad') {
        return scrim('Gesprek gehad met ' + esc(t.naam), 'Wat is er gezegd?',
          '<div class="ronde">Zonder deze zin is het een vinkje zonder inhoud, en weet de volgende die hem oppakt nog niets.</div>' +
          '<textarea id="opv-an" rows="3" placeholder="Bijvoorbeeld: alles goed verlopen, komt zeker"></textarea>' +
          '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvAanmeldBevestig(\'gesprek_gehad\')">Vastleggen en afronden</button>');
      }
      const watHeet = u === 'geen_interesse' ? 'Geen interesse' : 'Verplaatst naar een ander event';
      const uitleg = u === 'geen_interesse'
        ? 'De kaart gaat dicht.'
        : 'De kaart wacht op bevestiging. Staat deze persoon binnen 48 uur nergens als aanmelding op een ander event, dan komt hij terug in je lijst.';
      return scrim(watHeet, esc(t.naam),
        '<div class="warn"><b>Zet hem ook in de eventmodule op geannuleerd.</b> ' +
        'Anders blijft hij daar meetellen als aanmelding. De knop hieronder doet dat meteen ' +
        'voor je &mdash; en gebeurt het niet, dan valt het later alsnog op.</div>' +
        '<div class="ronde">' + uitleg + '</div>' +
        '<textarea id="opv-an" rows="2" placeholder="Notitie (mag leeg)"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvAanmeldBevestig(\'' + esc(u) + '\', true)">' +
        'Archiveren &eacute;n in de eventmodule annuleren</button>' +
        '<button class="obtn" style="width:100%;margin-top:8px" onclick="window.__opvAanmeldBevestig(\'' + esc(u) + '\', false)">' +
        'Alleen archiveren</button>');
    }

    if (m.soort === 'watnu') {
      const gp = (t.bel_vandaag || 0) + (t.wa_vandaag || 0) > 0;
      body =
        (gp ? '' : '<div class="warn"><b>Nog geen poging vandaag.</b> Je moet niets doorschuiven — wat blijft liggen staat morgen vanzelf terug. Kies je toch een latere dag, dan telt dat als <b>uitgesteld zonder poging</b>.</div>') +
        opt('&#128197;', 'var(--o-grns)', 'Opnieuw inplannen', 'Kies samen een moment terwijl je hem aan de lijn hebt.', "window.__opvActie('inplannen')") +
        opt('&#128233;', 'var(--o-accs)', 'Agenda doorgestuurd', 'Hij plant zelf in. Na 48 uur zonder afspraak komt hij terug.', "window.__opvActie('agenda_gestuurd')") +
        opt('&#8595;', 'var(--o-ambs)', 'Later vandaag nog eens', 'Zakt naar de tweede ronde, blijft vandaag staan.', "window.__opvActie('later_vandaag')") +
        opt('&#9200;', 'var(--o-purs)', 'De lead vroeg een later moment', 'Alleen als hij zelf een datum noemde.', "window.__opvActie('kiesdag')") +
        opt('&#128451;', 'var(--o-reds)', 'Archiveren — geen nut meer', 'Alleen na echte moeite. Maxim ziet je historiek.', "window.__opvActie('archiveer')");
      return scrim('Wat nu met ' + esc(t.naam) + '?',
        (t.bel_totaal || 0) + '&times; gebeld op ' + (t.bel_dagen || 0) + ' dag' + (t.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + (t.wa_totaal || 0) + '&times; WhatsApp', body);
    }

    if (m.soort === 'kiesdag') {
      body = '<div style="font-size:12.5px;color:#6b7280;margin-bottom:8px">Morgen hoef je niet te kiezen — wat open blijft, staat er morgen vanzelf terug.</div>' +
        '<input type="date" id="opv-dt" value="' + dagPlus(vandaag(), 7) + '" min="' + dagPlus(vandaag(), 2) + '">' +
        '<button class="obtn p" style="width:100%;margin-top:14px" onclick="window.__opvVerplaats()">Verplaatsen</button>';
      return scrim('Wanneer komt ' + esc(t.naam) + ' terug?', 'Hij verdwijnt uit je lijst tot die dag.', body);
    }

    if (m.soort === 'archiveer') {
      // Zolang het event nog moet komen geldt de drempel niet: die mensen komen
      // misschien gewoon opdagen, en dan is 'genoeg moeite gedaan' de verkeerde
      // vraag. Na het event neemt Event afronden het over en telt hij weer.
      const evDag = evVan(t).event_dag || null;
      const voorEvent = isAanmelding(t) && evDag && evDag >= vandaag();
      const zwak = !voorEvent &&
        ((t.bel_dagen || 0) < ARCHIEF_MIN_DAGEN || (t.wa_totaal || 0) < ARCHIEF_MIN_WA);
      body = (zwak ? '<div class="warn"><b>Even checken.</b> Je belde ' + (t.bel_totaal || 0) + ' keer op <b>' + (t.bel_dagen || 0) +
        ' verschillende dag' + (t.bel_dagen === 1 ? '' : 'en') + '</b> en stuurde ' + (t.wa_totaal || 0) + ' WhatsApp' + (t.wa_totaal === 1 ? '' : 's') +
        '. De afspraak is minstens <b>3 belpogingen op 3 verschillende dagen</b> én 1 WhatsApp. Twee keer bellen op dezelfde dag telt als één dag. Maxim ziet deze historiek.</div>' : '') +
        '<label style="display:block;font-size:12.5px;font-weight:650;margin:6px 0">Waarom archiveer je hem? (verplicht)</label>' +
        '<textarea id="opv-reden" rows="3" placeholder="bv. 5x gebeld, 2 WhatsApps, nooit reactie"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:14px;' + (zwak ? 'background:var(--o-amb);border-color:var(--o-amb)' : '') + '" onclick="window.__opvArchiveer()">' +
        (zwak ? 'Toch archiveren' : 'Archiveren') + '</button>';
      return scrim(esc(t.naam) + ' archiveren', 'Deze lead verdwijnt uit je takenlijst.', body);
    }

    if (m.soort === 'inplannen') {
      // De handmatige datumkeuze staat er ALTIJD onder, ook als de agenda
      // gewoon werkt. Valt de agenda weg, dan is dit geen noodoplossing maar
      // de weg die er toch al was — en dan is er nooit een leeg scherm.
      const handmatig =
        '<div style="border-top:1px solid var(--o-line);margin-top:16px;padding-top:14px">' +
        '<div class="ronde">Of zet hem zelf op een dag, zonder de agenda.</div>' +
        '<input type="date" id="opv-dt" value="' + dagPlus(vandaag(), 1) + '">' +
        '<button class="obtn" style="width:100%;margin-top:10px" onclick="window.__opvVerplaats()">Zet op deze dag</button></div>';
      return scrim('Call inplannen met ' + esc(t.naam),
        'Kies een moment in de agenda, of zet hem zelf op een dag.',
        agendaBlok() + handmatig);
    }

    // ── Fase 3a · een call afronden ────────────────────────────────────────
    if (m.soort === 'historiek') {
      body = '<ul class="tl">' + ((t.pogingen || []).map((p) =>
        '<li><span class="d">' + nl(iso(p.tijdstip)) + ' ' + uur(p.tijdstip) + '</span><span>' +
        (p.soort === 'call' ? '&#9742;' : '&#128172;') + ' ' + esc(p.resultaat || p.soort) + ' ' +
        (p.automatisch ? '&#9889;' : '&#9995;') + '</span></li>').join('') ||
        '<li style="color:#6b7280">Geen enkele poging geregistreerd.</li>') + '</ul>';
      return scrim(esc(t.naam), (t.bel_totaal || 0) + ' belpogingen &middot; ' + (t.wa_totaal || 0) + ' WhatsApps', body);
    }
    return '';
  }
  /**
   * De week: vijf dagkolommen, pijlen vorige/volgende, tot zes weken vooruit.
   * Bezet is grijs met de naam erbij zodat zichtbaar is waaróm een moment weg
   * is; vrij is blauw en klikbaar.
   */
  function agendaBlok() {
    const van = agendaVan(), tot = agendaTot();
    if (!_agenda.data && !_agenda.loading && !_agenda.error) fetchAgenda();

    const terug = _agenda.offset > 0;
    const heen  = _agenda.offset < AGENDA_MAX_WEKEN - 1;
    const kop =
      '<div class="agh">' +
      '<button class="obtn" ' + (terug ? '' : 'disabled style="opacity:.4;cursor:default" ') +
        'onclick="window.__opvWeek(-1)">&#8592;</button>' +
      '<span class="rng">' + nl(van) + ' &ndash; ' + nl(tot) +
        (_agenda.offset === 0 ? ' &middot; deze week' : '') + '</span>' +
      '<button class="obtn" ' + (heen ? '' : 'disabled style="opacity:.4;cursor:default" ') +
        'onclick="window.__opvWeek(1)">&#8594;</button></div>';

    if (_agenda.loading && !_agenda.data) return kop + '<div class="agleeg">Agenda laden&hellip;</div>';
    if (_agenda.error) {
      return kop + '<div class="warn2"><b>De agenda is nu niet bereikbaar.</b> ' + esc(_agenda.error) +
        '<br>Je kunt hem hieronder gewoon zelf op een dag zetten.</div>';
    }

    const d = _agenda.data;
    const dagen = (d && d.dagen) || [];
    const melding = d && d.melding
      ? '<div class="warn2">' + esc(d.melding) + '</div>' : '';

    const kolommen = dagen.map((dag) => {
      const vrij = (dag.vrij || []).map((s) =>
        '<button class="slot vrij" onclick="window.__opvBoek(\'' + esc(s.iso) + '\')">' + esc(s.tijd) + '</button>').join('');
      const bezet = (dag.bezet || []).map((b) =>
        '<span class="slot bezet">' + esc(b.tijd) + '<span class="w">' + esc(b.naam) + '</span></span>').join('');
      const leeg = (!vrij && !bezet) ? '<div class="agleeg">&mdash;</div>' : '';
      return '<div class="agd"><div class="dh">' + esc(dagNaam(dag.dag)) + '<b>' + esc(nl(dag.dag)) + '</b></div>' +
        vrij + bezet + leeg + '</div>';
    }).join('');

    return kop + melding + '<div class="agw">' + kolommen + '</div>';
  }

  const DAGNAMEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const dagNaam = (d) => DAGNAMEN[new Date(d + 'T12:00:00Z').getUTCDay()] || '';

  const opt = (em, bg, titel, sub, actie) =>
    '<button class="opt" onclick="' + actie + '"><div class="em" style="background:' + bg + '">' + em + '</div>' +
    '<div><b>' + titel + '</b><span>' + sub + '</span></div></button>';
  // `scrim on`, om exact dezelfde reden als bij waPaneelHtml hierboven: zonder
  // `on` houdt de globale .scrim-regel uit het design system opacity op 0 en
  // pointer-events op none, en blijft elk venster van deze module onzichtbaar.
  const scrim = (titel, sub, body) =>
    '<div class="opv"><div class="scrim on" onmousedown="if(event.target===this)window.__opvSluit()"><div class="modal">' +
    '<div class="mh"><div><h3>' + titel + '</h3><p>' + sub + '</p></div><button class="x" onclick="window.__opvSluit()">&times;</button></div>' +
    '<div class="mb">' + body + '</div></div></div></div>';

  function zoekTaak(id) {
    const d = _live.taken.data;
    if (d) {
      const t = (d.taken || []).find((x) => x.id === id) || (d.wacht || []).find((x) => x.id === id);
      if (t) return t;
    }
    if (_live.archief.data) return _live.archief.data.find((x) => x.id === id);
    return null;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // HANDLERS
  // ═════════════════════════════════════════════════════════════════════════
  window.__opvDag = (d) => {
    _ui.dagView = d;
    // Valt de gekozen dag buiten de week die de balk toont, dan schuift de balk
    // mee. Zonder dit zou de keuze wél gelden maar nergens oplichten, en dat
    // leest als 'er is niets gebeurd'.
    const wens = weekOffsetVoorDag({ nu: vandaag(), d });
    _ui.weekOffset = Math.max(WEEK_MIN_OFFSET, Math.min(WEEK_MAX_OFFSET, wens));
    _live.taken.data = null; _live.taken.key = null;
    _calls.data = null; _calls.key = null; _calls.error = null;
    render();
  };

  // ── De weekbalk: een week terug of vooruit ────────────────────────────────
  // Verandert alleen wat je ziet, niet welke dag geselecteerd staat. De
  // takenlijst hangt aan _ui.dagView en blijft dus staan waar hij stond.
  window.__opvWeekbalk = (stap) => {
    const n = _ui.weekOffset + (Number(stap) || 0);
    if (n < WEEK_MIN_OFFSET || n > WEEK_MAX_OFFSET) return;
    _ui.weekOffset = n;
    render();
  };

  /** Terug naar de week van vandaag, én naar vandaag als dag. */
  window.__opvWeekbalkNu = () => { window.__opvDag(vandaag()); };
  window.__opvHerlaad = () => { _live.taken.error = null; _live.dash.error = null; _live.archief.error = null; leegTakenCache(); render(); };
  window.__opvSluit = () => { _ui.modal = null; render(); };
  window.__opvWatNu = (id) => { _ui.modal = { soort: 'watnu', taakId: id }; render(); };
  window.__opvHist = (id) => { _ui.modal = { soort: 'historiek', taakId: id }; render(); };

  window.__opvActie = async (welke) => {
    const m = _ui.modal; if (!m) return;
    if (welke === 'kiesdag' || welke === 'archiveer' || welke === 'inplannen') { _ui.modal = { soort: welke, taakId: m.taakId }; render(); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: welke });
      if (welke === 'agenda_gestuurd') {
        await post('/api/opvolging-poging', { taak_id: m.taakId, soort: 'agenda_doorgestuurd', resultaat: 'agenda doorgestuurd', automatisch: false });
      }
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvVerplaats = async () => {
    const m = _ui.modal; if (!m) return;
    const el = document.getElementById('opv-dt');
    const due = el && el.value;
    if (!due) { alert('Kies eerst een dag.'); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: 'verplaats', due });
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvArchiveer = async () => {
    const m = _ui.modal; if (!m) return;
    const el = document.getElementById('opv-reden');
    const reden = (el && el.value || '').trim();
    if (!reden) { alert('Vul eerst een reden in.'); return; }
    try {
      await post('/api/opvolging-taak-update', { taak_id: m.taakId, actie: 'archiveer', archief_reden: reden });
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvBel = async (id) => {
    const t = zoekTaak(id); if (!t) return;
    if (!t.telefoon) { alert('Geen telefoonnummer bekend.'); return; }
    // Fase 2 — de poging wordt NIET meer hier geschreven. De softphone stuurt
    // de taak-id mee in zijn call-log, en /api/softphone-call-log maakt daar
    // de poging van: met de echte duur, en met 'gesproken' of 'niet opgenomen'
    // in plaats van 'gebeld via de softphone'. Hier óók loggen zou elk gesprek
    // dubbel laten tellen, en juist die telling bepaalt het oordeel in Afgerond.
    //
    // De naam van de global was hier fout (window.KLX); de softphone heet
    // window.KlxSoftphone, zoals overal elders. Daardoor belde deze knop in
    // fase 1 helemaal niet.
    const sp = window.KlxSoftphone;
    if (!sp || typeof sp.call !== 'function') {
      alert('De softphone is niet beschikbaar op deze pagina.');
      return;
    }
    try {
      await sp.call(t.telefoon, { displayName: t.naam || '', opvolgingTaakId: id });
    } catch (e) {
      // KlxSoftphone toont zelf al een toast met de reden; hier niet nog een
      // tweede melding overheen.
      console.warn('[opvolging-v2] bellen mislukt:', (e && e.message) || e);
    }
  };

  window.__opvWa = async (id) => {
    const t = zoekTaak(id); if (!t || !t.telefoon) { alert('Geen telefoonnummer bekend.'); return; }
    try {
      window.open('https://wa.me/' + String(t.telefoon).replace(/[^0-9]/g, ''), '_blank', 'noopener');
      await post('/api/opvolging-poging', { taak_id: id, soort: 'whatsapp', resultaat: 'WhatsApp geopend', automatisch: false });
      leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  // ── Fase 3a · de calls van vandaag ────────────────────────────────────────
  const callOp = (i) => (_calls.data || [])[i] || null;

  window.__opvCallBel = async (i) => {
    const c = callOp(i); if (!c || !c.telefoon) return;
    const sp = window.KlxSoftphone;
    if (!sp || typeof sp.call !== 'function') { alert('De softphone is niet beschikbaar op deze pagina.'); return; }
    // Bestaat er al een taak voor dit nummer, dan gaat de koppeling mee zodat
    // het gesprek daar direct als poging landt. Zo niet, dan doet de server
    // alsnog zijn match-op-nummer — hier hoeft niets bedacht te worden.
    const taak = taakVoorNummer(c.telefoon);
    try {
      await sp.call(c.telefoon, {
        displayName: c.naam || '',
        ...(taak ? { opvolgingTaakId: taak.id } : {}),
      });
    } catch (e) {
      console.warn('[opvolging-v2] bellen mislukt:', (e && e.message) || e);
    }
  };

  window.__opvCallWa = (i) => {
    const c = callOp(i); if (!c || !c.telefoon) { alert('Geen telefoonnummer bekend.'); return; }
    window.open('https://wa.me/' + String(c.telefoon).replace(/[^0-9]/g, ''), '_blank', 'noopener');
  };

  window.__opvCallAfrond = (i) => { _ui.modal = { soort: 'call-afrond', callIndex: i }; render(); };
  window.__opvCallUitkomst = (u) => {
    const m = _ui.modal; if (!m) return;
    _ui.modal = { soort: 'call-uitkomst', callIndex: m.callIndex, uitkomst: u };
    render();
  };

  window.__opvCallBevestig = async (uitkomst) => {
    const m = _ui.modal; if (!m) return;
    const c = callOp(m.callIndex); if (!c) return;
    if (_ui.bezig) return;

    const nEl = document.getElementById('opv-cn');
    const notitie = (nEl && nEl.value || '').trim();
    if (uitkomst === 'geen_interesse' && !notitie) { alert('Schrijf eerst op waarom hij afhaakt.'); return; }
    if (uitkomst === 'wil_nog_beslissen' && !notitie) { alert('Schrijf eerst op waar hij over twijfelt.'); return; }

    let due = null;
    if (uitkomst === 'wil_nog_beslissen') {
      const dEl = document.getElementById('opv-cd');
      due = dEl && dEl.value;
      if (!due) { alert('Kies eerst een dag.'); return; }
    }

    // Geen interesse levert bewust GEEN taak op — net als bij een event dat
    // zo eindigt. Een kaart die meteen dicht is komt met nul belpogingen in
    // Afgerond terecht en krijgt daar het oordeel 'te weinig moeite', terwijl
    // er nooit iets mee hoefde te gebeuren.
    if (uitkomst === 'geen_interesse') {
      _ui.modal = null; render();
      return;
    }

    try {
      await post('/api/opvolging-taak-create', {
        naam       : c.naam,
        email      : c.email || null,
        telefoon   : c.telefoon || null,
        reden      : uitkomst === 'no_show' ? 'no_show_call' : 'wil_nog_beslissen',
        due        : uitkomst === 'no_show' ? vandaag() : due,
        notitie    : notitie || null,
        badge_label: 'Call ' + nl(_ui.dagView || vandaag()),
        bron_ref   : { appointment_id: c.appointment_id || null, start: c.start || null },
        // Alleen bij 'wil nog beslissen' een poging: dat gesprek is echt
        // gevoerd. Een no-show is géén belpoging — er is niet gebeld, er kwam
        // alleen niemand opdagen. Zou hij hier toch meetellen, dan staat de
        // verse kaart vandaag op 1 van 2 terwijl Dave die persoon nog nooit aan
        // de lijn heeft gehad, en klopt de dekking op het dashboard niet meer.
        ...(uitkomst === 'no_show' ? {} : { poging_resultaat: 'gesproken, wil nog beslissen' }),
      });
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) {
      alert('Niet gelukt: ' + (e.message || 'onbekende fout'));
    }
  };

  // ── Aanmeldingen: de drie uitgangen ───────────────────────────────────────
  window.__opvAanmeldActie = (u) => {
    const m = _ui.modal; if (!m) return;
    _ui.modal = { soort: 'aanmeld-actie', taakId: m.taakId, uitkomst: u };
    render();
  };

  window.__opvAanmeldBevestig = async (uitkomst, ookAnnuleren) => {
    const m = _ui.modal; if (!m || _ui.bezig) return;
    const el = document.getElementById('opv-an');
    const notitie = (el && el.value || '').trim();
    if (uitkomst === 'gesprek_gehad' && !notitie) { alert('Schrijf eerst op wat er gezegd is.'); return; }
    try {
      await post('/api/opvolging-aanmelding-actie', { taak_id: m.taakId, actie: uitkomst, notitie: notitie || null });
      // De knop die het meteen in de eventmodule doet. Mislukt dat, dan is de
      // kaart wél weg — daarom een duidelijke melding en geen stilte; de
      // 48-uurcontrole en de signaleringslijst vangen de rest op.
      if (ookAnnuleren) {
        try {
          await post('/api/opvolging-aanmelding-actie', { taak_id: m.taakId, actie: 'annuleer_in_event' });
        } catch (e) {
          alert('De kaart is gearchiveerd, maar in de eventmodule op geannuleerd zetten lukte niet: ' +
            (e.message || 'onbekende fout') + '\nDoe dat daar even met de hand.');
        }
      }
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  window.__opvWeek = (stap) => {
    const n = _agenda.offset + stap;
    if (n < 0 || n >= AGENDA_MAX_WEKEN) return;
    _agenda.offset = n;
    _agenda.data = null; _agenda.key = null; _agenda.error = null;
    render();
  };

  window.__opvBoek = async (startIso) => {
    const m = _ui.modal; if (!m || !startIso) return;
    if (_ui.bezig) return;
    try {
      await post('/api/opvolging-agenda', { taak_id: m.taakId, start: startIso });
      // De taak staat nu op 'ingepland' en de poging is server-side gezet;
      // hier alleen de caches legen zodat het scherm de nieuwe stand toont.
      _ui.modal = null;
      _agenda.data = null; _agenda.key = null;
      leegTakenCache(); render();
    } catch (e) {
      alert('Inplannen niet gelukt: ' + (e.message || 'onbekende fout'));
      // Het slot kan intussen bezet zijn — opnieuw ophalen zodat de week klopt.
      _agenda.data = null; _agenda.key = null; render();
    }
  };

  window.__opvTerug = async (id) => {
    try {
      await post('/api/opvolging-taak-update', { taak_id: id, actie: 'verplaats', due: vandaag() });
      leegTakenCache(); render();
    } catch (e) { alert('Niet gelukt: ' + (e.message || 'onbekende fout')); }
  };

  // ── WhatsApp-brug ─────────────────────────────────────────────────────────
  window.__opvWaOpen = () => {
    _wa.paneelOpen = true;
    _wa.qr = null; _wa.qrError = null;
    render();
    // Meteen verversen in plaats van een tel wachten: wie dit paneel opent wil
    // nú weten waar hij aan toe is.
    fetchWaStatus();
    if (!(_wa.data && _wa.data.verbonden)) fetchWaQr();
    herstelWaTimers();
  };

  window.__opvWaSluit = () => {
    _wa.paneelOpen = false;
    _wa.qr = null; _wa.qrError = null;
    // Eerst de timers terug naar de rustige cadans, dan pas tekenen — anders
    // blijft de snelle poll van vijf seconden nog een ronde doorlopen.
    herstelWaTimers();
    render();
  };

  // Het tabblad gaat dicht of de pagina wordt vervangen. Zonder dit blijven de
  // intervallen tot het laatst doorlopen; dezelfde les als bij de badge-poll in
  // de hoofdnavigatie (zie CLAUDE.md, lesson learned 20).
  window.addEventListener('beforeunload', stopWaTimers);

  // Voor de console én voor tests/opvolging-whatsapp-koppel.test.js: de twee
  // besluiten zijn zo na te slaan zonder het scherm te hoeven bedienen.
  window.__opvWaHelpers = { beschrijfWaStatus, bepaalWaTimers, bepaalTimerActie, toonNummer, geledenTekst };

  // De weekbalk los na te slaan, en getest in tests/opvolging-weekbalk.test.js
  // tegen dit bestand zelf — zelfde afspraak als bij de wa-timers hierboven.
  // De aanmeldkaart: de wakker-dag moet gelijk blijven aan die van de server,
  // en de badge moet in ronde B laten zien dat er in ronde A bevestigd is.
  /**
   * Voor tests/opvolging-call-modal.test.js: de vensters van buitenaf openen en
   * de opbrengst nakijken, zonder een browser.
   *
   * Dit is er omdat de fout die het moet vangen onzichtbaar was. De vier
   * uitkomsten van een zoomcall hebben nooit gewerkt: modalHtml() begon met een
   * taak-guard, een call heeft geen taak, en dus kwam er een lege string uit.
   * Geen console-fout, geen venster, niets. Alleen door de echte functie te
   * draaien met een echte _ui.modal is dat te zien.
   *
   * Bewust smal: de twee zetters vullen de caches die de vensters lezen, en de
   * rest gaat via de gewone handlers op window, zodat de test dezelfde weg
   * aflegt als een klik.
   */
  window.__opvModalHaak = {
    modalHtml,
    zetCalls: (lijst) => { _calls.key = vandaag(); _calls.data = lijst || []; _calls.error = null; },
    zetTaken: (lijst) => { _live.taken.key = vandaag(); _live.taken.data = { taken: lijst || [], wacht: [] }; },
    huidigeModal: () => _ui.modal,
    MODAL_ZONDER_TAAK,
  };

  window.__opvAanmeldHelpers = { WAKKER_DAGEN, bevestigdBadge, taakKaart, evGroepKop, kortePlaats, eventKopTekst };

  window.__opvWeekHelpers = {
    bepaalWeek, basisMaandag, weekOffsetVoorDag, maandagVan, kortDatum,
    WEEKDAG_LABELS, WEEK_MIN_OFFSET, WEEK_MAX_OFFSET,
  };

  // De vensterlogica los na te slaan vanuit de console, en getest in
  // tests/opvolging-vensters.test.js tegen dit bestand zelf.
  window.__opvVensterHelpers = {
    inZone, beoordeelSpraak, beoordeelNabel, beoordeelDag, telVensters,
    isSpraakVerstuurd, isAntwoord, koppelCalls, callVoorTaak,
    SPRAAK_DEADLINE_UUR, NABEL_VAN_UUR, NABEL_TOT_UUR,
  };

  // ═════════════════════════════════════════════════════════════════════════
  // REGISTREREN
  // ═════════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['opvolging/Vandaag'] = vandaagView;
  window.DFO.VIEWS['opvolging/Dashboard'] = dashboardView;
  window.DFO.VIEWS['opvolging/Afgerond'] = afgerondView;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('opvolging');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('opvolging');

  console.debug('[opvolging-v2] takenlijst, calls van vandaag, dekking, archief, agenda en WhatsApp-koppeling');
})();
