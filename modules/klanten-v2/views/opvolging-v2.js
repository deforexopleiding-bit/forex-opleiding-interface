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
//            /api/opvolging-whatsapp-status (alleen lezen)

(function () {
  if (!window.DFO) { console.error('[opvolging-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[opvolging-v2] KV_V2.helpers niet geladen.'); return; }

  const DOEL_BELLEN = 2;
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
  };

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
.opv .wkd{flex:1;min-width:104px;background:#fff;border:1px solid var(--o-line);border-radius:12px;padding:9px 11px;cursor:pointer;font-family:inherit;text-align:left;box-shadow:var(--o-sh);display:flex;flex-direction:column;gap:2px}
.opv .wkd .l{font-size:11.5px;color:var(--o-muted);font-weight:600}
.opv .wkd .c{font-size:17px;font-weight:750}
.opv .wkd .c small{font-size:11.5px;font-weight:600;color:var(--o-muted)}
.opv .wkd.on{border-color:var(--o-acc);box-shadow:0 0 0 3px var(--o-accs)}
.opv .wkd.nu .l{color:var(--o-acc)}
.opv .wkd.oud{background:#fbfcfd}
.opv .ronde{font-size:12.5px;color:var(--o-muted);margin:0 0 10px 2px}
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

  function taakKaart(t, dag) {
    const r = REDEN_LABEL[t.reden] || [t.reden, 't-grey'];
    const nuDag = vandaag();
    return '<div class="row"><div class="who">' +
      '<div class="nm">' + esc(t.naam) +
        ' <span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>' +
        (t.reden_code ? ' <span class="tag t-grey">' + esc(t.reden_code) + '</span>' : '') +
        (t.badge_label ? ' <span class="tag t-grey">' + esc(t.badge_label) + '</span>' : '') +
        (t.due < nuDag ? ' <span class="tag t-red">bleef liggen</span>' : '') +
        (t.due > nuDag ? ' <span class="tag t-blue">staat op ' + nl(t.due) + '</span>' : '') +
        ((t.uitgesteld_zonder_poging || 0) >= 2 ? ' <span class="tag t-amber">' + t.uitgesteld_zonder_poging + '&times; uitgesteld zonder poging</span>' : '') +
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
      (t.notitie ? '<div class="note">' + esc(t.notitie) + '</div>' : '') +
      '</div>' +
      '<div class="act">' +
        '<button class="obtn p" onclick="window.__opvBel(\'' + t.id + '\')">&#9742; Bellen</button>' +
        '<button class="obtn wa" onclick="window.__opvWa(\'' + t.id + '\')">&#128172; WhatsApp</button>' +
        '<button class="obtn" onclick="window.__opvWatNu(\'' + t.id + '\')">Wat nu? &rarr;</button>' +
      '</div></div>';
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

  function weekbalk(dag) {
    const nu = vandaag();
    const d0 = new Date(nu + 'T12:00:00Z');
    const maandag = dagPlus(nu, -(((d0.getUTCDay() + 6) % 7)));
    let h = '<div class="wk">';
    ['Ma', 'Di', 'Wo', 'Do', 'Vr'].forEach((lbl, i) => {
      const d = dagPlus(maandag, i);
      const aan = d === dag;
      h += '<button class="wkd ' + (aan ? 'on' : '') + ' ' + (d === nu ? 'nu' : '') + ' ' + (d < nu ? 'oud' : '') + '"' +
        ' onclick="window.__opvDag(\'' + d + '\')">' +
        '<span class="l">' + lbl + ' ' + nl(d) + (d === nu ? ' · vandaag' : '') + '</span>' +
        '<span class="c">' + (aan && _live.taken.data ? _live.taken.data.taken.length : '·') + '<small> open</small></span></button>';
    });
    return h + '</div>';
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
      '<div class="info">De spraakberichten en het nabelvenster hangen aan de WhatsApp-brug en volgen later; ' +
      'die blokken staan hier bewust leeg in plaats van met cijfers die nog niet gemeten worden.</div>' +
      waLamp() + '</div>';
    h += weekbalk(dag);
    // Boven de takenlijst: eerst wat er vaststaat vandaag, dan wat je zelf
    // moet oppakken. De agenda hangt niet aan de takenlijst — valt hij weg,
    // dan toont dit blok een melding en gaat de rest gewoon door.
    h += callsBlok(dag);

    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>' + modalHtml() + waPaneelHtml();
    if (st.loading || !st.data) return h + skel() + '</div>' + modalHtml() + waPaneelHtml();

    const alles = st.data.taken || [];
    const r1 = alles.filter((t) => !t.later && !t.bel_vandaag && !t.wa_vandaag);
    const r2 = alles.filter((t) => t.later || t.bel_vandaag || t.wa_vandaag);
    const wacht = st.data.wacht || [];

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
  function modalHtml() {
    const m = _ui.modal;
    if (!m) return '';
    const t = zoekTaak(m.taakId);
    if (!t) return '';
    let body = '';

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
      const zwak = (t.bel_dagen || 0) < ARCHIEF_MIN_DAGEN || (t.wa_totaal || 0) < ARCHIEF_MIN_WA;
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
    if (m.soort === 'call-afrond' || m.soort === 'call-uitkomst') {
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
    _live.taken.data = null; _live.taken.key = null;
    _calls.data = null; _calls.key = null; _calls.error = null;
    render();
  };
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
