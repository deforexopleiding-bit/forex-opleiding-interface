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

  /**
   * WAT ER GEBEURT ALS ER EEN BESTAND ONTBREEKT — EN WAAROM DIT ER STAAT.
   *
   * Deze view stopte bij een ontbrekend onderdeel met een console.error en een
   * `return`. Daardoor werden de drie regels window.DFO.VIEWS onderaan dit
   * bestand nooit gedraaid, en viel app-shell.js terug op genericView(). Die
   * tekent letterlijk: "Deze view is nog niet gebouwd. In productie wordt hier
   * de module-content gerenderd."
   *
   * Laadt _opvolging-badge.js dus één keer niet — cache, een 404 na een deploy,
   * een adblocker — dan opent Dave de module en leest hij dat hij niet bestaat.
   * Dat is geen harde fout maar een schermvullende leugen, en het enige spoor
   * staat in een console die hij nooit opent.
   *
   * Dus: de views worden ALTIJD geregistreerd. Ontbreekt er iets, dan tonen ze
   * wat er aan de hand is en wat je eraan kunt doen. Liever een lelijk scherm
   * dat waar is dan een net scherm dat liegt.
   */
  function ontbrekendOnderdeel(wat) {
    const veilig = String(wat).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return '<div class="opv"><div class="warn" style="max-width:640px">' +
      '<b>Er ontbreekt een onderdeel van deze module.</b><br>' +
      'De module is niet volledig geladen, dus wat je hier zou zien is er nu niet. ' +
      '<b>Herlaad de pagina.</b> Blijft dit staan, dan is er een bestand niet meegekomen ' +
      'met de laatste deploy — meld dat, want dit lost zichzelf niet op.' +
      '<div style="margin-top:10px;font-size:12px;color:#6b7280">Ontbrekend onderdeel: <code>' +
      veilig + '</code></div>' +
      '<div style="margin-top:12px"><button class="obtn p" onclick="window.location.reload()">Pagina herladen</button></div>' +
      '</div></div>';
  }

  function registreerOntbrekend(wat) {
    console.error('[opvolging-v2] ' + wat + ' ontbreekt — module niet volledig geladen.');
    const scherm = () => ontbrekendOnderdeel(wat);
    window.DFO.VIEWS = window.DFO.VIEWS || {};
    window.DFO.VIEWS['opvolging/Vandaag'] = scherm;
    window.DFO.VIEWS['opvolging/Dashboard'] = scherm;
    window.DFO.VIEWS['opvolging/Afgerond'] = scherm;
    window.DFO.VIEWS['opvolging/Rapport'] = scherm;
    if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('opvolging');
    else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('opvolging');
  }

  if (!window.KV_V2 || !window.KV_V2.helpers) { registreerOntbrekend('KV_V2.helpers (_shared-v2.js)'); return; }
  const H = window.KV_V2.helpers;
  // Het etiket op een taak komt uit één plek — zie _opvolging-badge.js. Het
  // stond op vier plekken in dit bestand rauw op het scherm, en drie keer
  // dezelfde lange string is geen toeval maar een ontbrekende gedeelde helper.
  // Stil terugvallen op badge_label zou de fout terugbrengen zonder dat iemand
  // het merkt; daarom stopt de module hier — maar wél zichtbaar, zie hierboven.
  if (typeof H.opvBadgeTekst !== 'function') {
    registreerOntbrekend('KV_V2.helpers.opvBadgeTekst (_opvolging-badge.js)');
    return;
  }
  const badgeTekst = (t) => H.opvBadgeTekst(t);

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

  // ═════════════════════════════════════════════════════════════════════════
  // HERTEKENEN — ALLEEN ALS ER ECHT IETS VERANDERD IS
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Met het gesprekspaneel open lopen er twee timers van vijf seconden
  // (fetchWaStatus en fetchGesprek). Allebei eindigden ze onvoorwaardelijk op
  // render(), en render() zet via DFO.render() `c.innerHTML` van het hele
  // contentblok opnieuw. De complete pagina onder het paneel werd dus om de
  // paar seconden weggegooid en opnieuw opgebouwd — ook als er niets veranderd
  // was, en dat is bij verreweg de meeste rondes zo.
  //
  // Daar kwamen drie klachten uit voort: het springen (de shell zet na het
  // vervangen van de DOM de paginascroll terug), het vanzelf dichtvallen (een
  // klik die tussen mousedown en het einde van de hertekening zijn element
  // kwijtraakt en op de scrim landt) en het wissen van een half getypt bericht.
  //
  // EÉN MECHANISME, GEEN TWEE. Er is bewust niet gekozen voor 'alleen het
  // paneel bijwerken': dan staat er een gedeeltelijke bijwerking naast een
  // volledige hertekening die er soms toch overheen gaat, en dat is erger dan
  // wat er stond. Alles loopt nog steeds via render(); die deur is alleen op
  // slot gegaan als er niets te tonen valt.
  //
  // DE VINGERAFDRUK IS DE GETEKENDE HTML ZELF, en niet een lijstje velden uit
  // het antwoord. Dat is met opzet: een lijstje kan verouderen zodra iemand een
  // veld toevoegt, en een tijdstempel die elke ronde opschuift zou als
  // verandering tellen terwijl hij nergens op het scherm staat. De HTML ís wat
  // het scherm toont — verandert die niet, dan is er niets te zien.
  //
  // Het concept (wat iemand aan het typen is) staat met opzet NIET in die HTML;
  // die wordt na afloop in de textarea gezet. Zo verandert typen de
  // vingerafdruk niet, en hertekent het scherm niet bij elke aanslag.
  let _laatsteHtml = null;

  // ── Tekenen mag geen werk aftrappen ──────────────────────────────────────
  //
  // De view-functies zijn GEEN pure functies: ze starten fetches via
  // queueMicrotask. En render() roept de view twee keer aan — één keer om de
  // vingerafdruk te maken, en daarna nog eens via DFO.render().
  //
  // Die fetches zitten vandaag allemaal achter een 'wacht-of-al-geladen'-slot,
  // dus de tweede aanroep doet niets. Maar dat is een aanname die niemand ziet
  // sneuvelen: de dag dat iemand een view uitbreidt met een fetch zonder slot,
  // draait die stil dubbel en zoek je een week naar de extra verzoeken.
  //
  // Daarom staat de aanname niet in een comment maar in code. Alles in dit
  // bestand plant werk via straks(), en tijdens de meet-pas doet die niets.
  // Er staat een test op dat er nergens meer een kale queueMicrotask staat, dus
  // een nieuwe fetch kan er niet stilletjes langs.
  let _meetAlleen = false;

  /** Werk voor zo meteen. Doet niets als we alleen de vingerafdruk maken. */
  const straks = (fn) => { if (_meetAlleen) return; queueMicrotask(fn); };

  /** De HTML van de view die nu in beeld staat, of null als dat er geen is. */
  function huidigeViewHtml() {
    const S = window.DFO && window.DFO.S;
    const tab = (S && S.tab) || '';
    const fn = window.DFO && window.DFO.VIEWS && window.DFO.VIEWS['opvolging/' + tab];
    if (typeof fn !== 'function') return null;
    _meetAlleen = true;
    try { return fn(); } finally { _meetAlleen = false; }
  }

  const render = () => {
    if (!window.DFO || typeof window.DFO.render !== 'function') return;
    const html = huidigeViewHtml();
    // Staat er een andere module in beeld, dan valt er hier niets te beslissen:
    // gewoon doorgeven aan de shell.
    if (html === null) { _laatsteHtml = null; window.DFO.render(); return; }
    if (html === _laatsteHtml) {
      // Niets veranderd. Wél het concept terugzetten voor het geval een andere
      // weg de DOM heeft vervangen zonder ons.
      herstelConcept();
      return;
    }
    _laatsteHtml = html;
    const voor = bewaarPaneelStaat();
    window.DFO.render();
    herstelPaneelStaat(voor);
  };

  // ── Wat een hertekening moet overleven ────────────────────────────────────
  //
  // Drie dingen, en alle drie zijn ze onzichtbaar in de HTML: wat er getypt is,
  // waar de cursor stond, en waar de gesprekdraad gescrold stond.

  /** Hoeveel pixels van de onderkant nog als 'onderaan' telt. */
  const DRAAD_ONDERAAN_MARGE = 40;

  /**
   * Stond de lezer onderaan de draad?
   *
   * Pure functie, want dit is de beslissing die fout kan gaan: scrolde Dave
   * omhoog om iets terug te lezen, dan mag een binnenkomend bericht hem daar
   * niet wegtrekken. Stond hij onderaan, dan hoort het nieuwste bericht juist
   * in beeld te komen.
   *
   * De marge zit erin omdat een draad zelden op de pixel onderaan staat: een
   * halve regel speling telt nog als 'onderaan'.
   */
  function isOnderaan({ scrollTop, scrollHeight, clientHeight } = {}) {
    if (![scrollTop, scrollHeight, clientHeight].every((v) => Number.isFinite(v))) return true;
    return (scrollHeight - scrollTop - clientHeight) <= DRAAD_ONDERAAN_MARGE;
  }

  const draadEl = () => document.querySelector('.opv .wchat');
  const tekstEl = () => document.getElementById('opv-wa-tekst');

  /** Wat er vóór een hertekening bewaard moet worden. */
  function bewaarPaneelStaat() {
    const ta = tekstEl();
    const draad = draadEl();
    return {
      focus   : !!(ta && typeof document !== 'undefined' && document.activeElement === ta),
      selStart: ta ? ta.selectionStart : null,
      selEnd  : ta ? ta.selectionEnd : null,
      draadTop: draad ? draad.scrollTop : null,
      onderaan: draad ? isOnderaan(draad) : true,
    };
  }

  /** Het concept terug in de textarea. Zie de uitleg bij render(). */
  function herstelConcept() {
    const ta = tekstEl();
    if (!ta) return;
    const wens = _gesprek.concept || '';
    if (ta.value !== wens) ta.value = wens;
  }

  /**
   * Alles terugzetten wat de hertekening weggegooid heeft.
   *
   * De draad krijgt zijn scrollpositie terug, tenzij de lezer onderaan stond —
   * dan gaat hij mee naar het nieuwste bericht. Dat laatste gebeurde tot nu toe
   * helemaal niet: er stond nergens een scroll naar beneden, dus een nieuw
   * bericht kon onzichtbaar onderaan blijven hangen.
   */
  function herstelPaneelStaat(voor) {
    herstelConcept();
    const ta = tekstEl();
    if (ta && voor && voor.focus) {
      try {
        ta.focus();
        if (Number.isFinite(voor.selStart)) {
          const eind = Math.min(voor.selEnd == null ? voor.selStart : voor.selEnd, ta.value.length);
          ta.setSelectionRange(Math.min(voor.selStart, ta.value.length), eind);
        }
      } catch (_) { /* focus kan geweigerd worden; geen reden om iets te breken */ }
    }
    const draad = draadEl();
    if (!draad) return;
    if (!voor || voor.onderaan) draad.scrollTop = draad.scrollHeight;
    else if (Number.isFinite(voor.draadTop)) draad.scrollTop = voor.draadTop;
  }

  // GEEN FORCEER-FUNCTIE. Er stond er een, met de uitleg dat hij hoe dan ook
  // hertekende 'voor als de DOM buiten ons om vervangen is' — en hij werd
  // nergens aangeroepen. Dat is dezelfde vorm als de 404 die er stond en nooit
  // draaide: een vangnet dat er goed uitziet en niet gespannen is.
  //
  // Hij is weg omdat er geen vangnet nódig is, en dat is na te lopen. De shell
  // vervangt de DOM alleen in DFO.render(), en die roept altijd de view-functie
  // aan — dus na een hertekening buiten ons om (tabwissel, navigatie, goTab)
  // staat de HUIDIGE HTML in de DOM terwijl onze vingerafdruk nog een oudere
  // draagt. De eerstvolgende ronde ziet dan een verschil en tekent één keer
  // overbodig, en daarna klopt het weer. De gevaarlijke kant — DOM veranderd
  // terwijl de vingerafdruk 'gelijk' zegt — kan niet ontstaan, want binnen deze
  // module raakt niets de DOM buiten render() om behalve het terugzetten van
  // het concept en de scrollpositie, en dat is precies wat er hoort te staan.
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
    // G1 · de getallen onder de weekbalk, en wat erachter zit. Aparte staat en
    // een apart endpoint: de takenlijst gaat over één dag, de balk over zeven,
    // en die twee mogen elkaar niet ophouden als er één van faalt.
    balk: { loading: false, error: null, data: null, key: null },
    later: { loading: false, error: null, data: null, key: null },
    tijdlijn: { loading: false, error: null, data: null, key: null },
    // R · het dagrapport. Eigen staat en een eigen endpoint: dit gaat over een
    // periode, de rest over één dag.
    rapport: { loading: false, error: null, data: null, key: null },
  };
  const _ui = {
    dagView: null,          // null = vandaag
    modal: null,            // { soort, taakId, ... }
    bezig: false,
    weekOffset: 0,          // 0 = de week die de balk bij openen toont
    rapportPeriode: 'vandaag',   // vandaag | gisteren | deze_week | vorige_week | eigen
    rapportEigen: null,          // { van, tot } zodra 'eigen' gekozen is
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
  const _calls = { loading: false, error: null, data: null, key: null, achterstand: [] };

  // ── De WhatsApp-brug ──────────────────────────────────────────────────────
  // Een lampje rechtsboven en een paneel om opnieuw te koppelen als de sessie
  // eruit ligt. Leest alleen /api/opvolging-whatsapp-status; er wordt hier
  // niets geschreven en er komt geen endpoint bij.
  const WA_POLL_RUSTIG_MS  = 60000;   // lampje op de achtergrond
  const WA_POLL_PANEEL_MS  = 5000;    // paneel open en nog niet gekoppeld
  const WA_POLL_QR_MS      = 20000;   // de QR verloopt, dus die halen we opnieuw
  const WA_POLL_GESPREK_MS = 5000;    // gesprekspaneel open: antwoorden willen we zien
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
  const _waTimers = { status: null, statusMs: null, qr: null, qrMs: null, gesprek: null, gesprekMs: null };

  // ── Het gesprek ───────────────────────────────────────────────────────────
  // Het WhatsApp-gesprek met één lead, in het CRM zelf. Hiervoor opende de
  // knop wa.me in een nieuw tabblad; dan zie je het gesprek wel maar staat het
  // niet in het systeem, en kan niemand anders het teruglezen.
  //
  // `optimistisch` houdt wat net verstuurd is vast tot de brug het bevestigt.
  // Zonder dat staat een verstuurd bericht tot vijf seconden lang nergens, en
  // dan typt iemand het nog een keer.
  const _gesprek = {
    open: false, nummer: null, taakId: null, naam: null,
    laden: false, error: null, code: null, berichten: null,
    verzendt: false, optimistisch: [],
    // Wat er getypt is maar nog niet verstuurd. HOORT IN DE STAAT, niet alleen
    // in de DOM: stond hij alleen in de textarea, dan wiste elke hertekening
    // een half getypte zin — en die kwamen om de vijf seconden langs.
    concept: '',
    // Het ophalen van de geschiedenis van het toestel. `melding` is wat er
    // daarna boven de draad komt te staan: wát er opgehaald is en vanaf
    // wanneer. Zonder die zin lijkt het opgehaalde het volledige gesprek, en
    // dat is het niet — WhatsApp synct maar een beperkt venster naar een
    // gekoppeld apparaat.
    haalt: false, melding: null, meldingSoort: null,
  };

  async function haal(url) {
    try {
      const j = await window.KV.authedJson(url);
      if (j && j.error) return { __error: j.error, code: j.code || null };
      return j;
    } catch (e) {
      // De code gaat mee zodat een aanroeper onderscheid kan maken tussen
      // 'kapot' en 'nog niet ingericht'. authedJson gooit bij een foutstatus en
      // hangt het geparseerde antwoord aan err.body. Bestaande aanroepers lezen
      // alleen __error en merken hier niets van.
      return { __error: (e && e.message) || 'Netwerkfout', code: (e && e.body && e.body.code) || null };
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
  /**
   * De getallen onder de weekbalk. Faalt dit, dan blijft er een punt staan in
   * plaats van een nul — een nul leest als een meting, en dit is er dan geen.
   */
  async function fetchBalk(van, tot) {
    const st = _live.balk;
    const key = van + '|' + tot;
    if (st.loading || (st.data && st.key === key)) return;
    st.loading = true; st.error = null; st.key = key;
    const j = await haal('/api/opvolging-weekbalk?van=' + encodeURIComponent(van) +
      '&tot=' + encodeURIComponent(tot));
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; } else { st.data = j; }
    render();
  }

  /** Alles wat verder ligt dan de balk toont. Zie de knop 'Later'. */
  async function fetchLater(na) {
    const st = _live.later;
    if (st.loading || (st.data && st.key === na)) return;
    st.loading = true; st.error = null; st.key = na;
    const j = await haal('/api/opvolging-weekbalk?view=later&na=' + encodeURIComponent(na));
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; } else { st.data = j; }
    render();
  }

  /** Wat er op één dag daadwerkelijk gebeurd is. */
  async function fetchTijdlijn(dag) {
    const st = _live.tijdlijn;
    if (st.loading || (st.data && st.key === dag)) return;
    st.loading = true; st.error = null; st.key = dag;
    const j = await haal('/api/opvolging-weekbalk?view=tijdlijn&dag=' + encodeURIComponent(dag));
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; } else { st.data = j; }
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
    // ALLEEN OP VANDAAG. De achterstand is 'wat er van eerdere dagen nog open
    // staat, nu' — op een andere dag bekijken zou een lijst opleveren die daar
    // niets betekent, en de server hoeft er dan ook niet voor te lezen.
    const vraagAchterstand = dag === vandaag();
    const j = await haal('/api/opvolging-agenda?van=' + dag + '&tot=' + dag +
      (vraagAchterstand ? '&achterstand=1' : ''));
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; st.achterstand = []; }
    else {
      st.achterstand = vraagAchterstand ? (j.achterstand || []) : [];
      // HET DAGBEELD, NIET DE BEZETTE MOMENTEN. `gepland` draagt alles wat
      // voor die dag stond, verzette calls inbegrepen; `bezet` is de smallere
      // lijst die bepaalt welke vrije momenten wegvallen.
      //
      // Terugval op bezet + afgerond zodat een oudere server nog gewoon werkt:
      // dan gedraagt het blok zich als vóór het dagbeeld.
      const d0 = (j.dagen || [])[0] || {};
      st.data = d0.gepland || [...(d0.bezet || []), ...(d0.afgerond || [])]
        .sort((a, b) => String(a.tijd || '').localeCompare(String(b.tijd || '')));
      st.onvolledig = j.dagbeeld_volledig === false ? (j.dagbeeld_melding || null) : null;
    }
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
  function bepaalWaTimers({ gemount, paneelOpen, verbonden, gesprekOpen } = {}) {
    // Weg van het scherm is alles uit, ook het gesprek. Dat is dezelfde regel
    // als voor de andere twee en om dezelfde reden: de shell kent geen
    // afscheidshaak, dus het levensteken is het enige dat ons dat vertelt.
    if (!gemount) return { statusMs: null, qrMs: null, gesprekMs: null };
    const gesprekMs = gesprekOpen ? WA_POLL_GESPREK_MS : null;
    if (!paneelOpen) return { statusMs: WA_POLL_RUSTIG_MS, qrMs: null, gesprekMs };
    if (verbonden)  return { statusMs: null, qrMs: null, gesprekMs };
    return { statusMs: WA_POLL_PANEEL_MS, qrMs: WA_POLL_QR_MS, gesprekMs };
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
    if (_waTimers.status)  clearInterval(_waTimers.status);
    if (_waTimers.qr)      clearInterval(_waTimers.qr);
    if (_waTimers.gesprek) clearInterval(_waTimers.gesprek);
    _waTimers.status  = null; _waTimers.statusMs  = null;
    _waTimers.qr      = null; _waTimers.qrMs      = null;
    _waTimers.gesprek = null; _waTimers.gesprekMs = null;
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
      gemount    : waGemount(),
      paneelOpen : _wa.paneelOpen,
      verbonden  : !!(_wa.data && _wa.data.verbonden),
      gesprekOpen: _gesprek.open,
    });

    // De view kan vervangen zijn zonder dat iemand het ons vertelt; de shell
    // kent geen afscheidshaak. Het lampje is het levensteken — vandaar deze
    // check in elke tik, niet alleen bij het opzetten.
    const tik = (fn) => () => { if (!waGemount()) { stopWaTimers(); return; } fn(); };

    zetTimer('status',  'statusMs',  wens.statusMs,  tik(fetchWaStatus));
    zetTimer('qr',      'qrMs',      wens.qrMs,      tik(fetchWaQr));
    // Dezelfde regel als bij de QR: loopt hij al op vijf seconden, dan blijft
    // hij lopen. Elke statusronde blind herstarten zou dit gesprek nooit laten
    // verversen — precies de bug die de QR-timer had.
    zetTimer('gesprek', 'gesprekMs', wens.gesprekMs, tik(fetchGesprek));
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
  // DE RICHTING KOMT UIT DE KOLOM, NIET UIT DE TEKST.
  //
  // Deze twee lazen /verstuurd/ en /ontvangen/ uit `resultaat`. Dat is een
  // parser op een zin die iemand ooit anders formuleert, en dan gaan de twee
  // vensters iets anders meten dan wat er gebeurd is. Sinds de migratie
  // 2026-09-06-opvolging-pogingen-richting.sql staat de richting in de data.
  //
  // Een rij zonder richting telt als uitgaand — dat is de historische aanname,
  // en de opruim-query zet de inkomende rijen die er nog staan eenmalig op 'in'.
  const uitgaand = (p) => !p || p.richting !== 'in';

  function isSpraakVerstuurd(p) {
    return !!p && p.soort === 'spraakbericht' && uitgaand(p);
  }
  /** Is dit iets dat de lead ons stuurde? */
  function isAntwoord(p) {
    return !!p && (p.soort === 'whatsapp' || p.soort === 'spraakbericht') && !uitgaand(p);
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
   * GAAT DEZE CALL NOG DOOR?
   *
   * Een verzette of geannuleerde call heeft geen ochtend om over te oordelen.
   * Hem meetellen zou 'geen spraakbericht' opleveren voor een afspraak die
   * niet plaatsvindt. Tweeling van NIET_GEVOERD in api/opvolging-agenda.js.
   */
  const CALL_NIET_GEVOERD = ['cancelled', 'verwijderd', 'verplaatst', 'wacht_op_reschedule'];

  /** De identiteit van een nummer zonder kaart. Tweeling van nummerSleutel() in het rapport. */
  function nummerSleutel(tel) {
    const d = String(telCijfers(tel) || '');
    return d.length >= 9 ? d.slice(-9) : (d || 'onbekend');
  }
  function callGaatDoor(c) {
    if (!c) return false;
    if (c.doorgehaald === true) return false;
    return CALL_NIET_GEVOERD.indexOf(String(c.status || '').toLowerCase()) === -1;
  }

  /**
   * DE VENSTER-'TAAK' BIJ EEN CALL — met of zonder kaart.
   *
   * Vroeger las dit uitsluitend taakVoorNummer(): had de lead geen opvolgkaart,
   * dan viel hij uit de meting. Zoomleads hebben er meestal geen — ze boeken
   * zelf een call en komen nooit in de werklijst — en dus zei het scherm
   * '7 ingeplande calls, maar geen ervan staat in de takenlijst' terwijl er die
   * ochtend gewoon spraakberichten waren gegaan.
   *
   * De server hangt de WhatsApp-berichten van die dag nu aan de call (`c.wa`).
   * Is dat een array, dan is er gemeten en bouwen we een taak-vormig object:
   * de pogingen van de kaart (als die er is) plús de berichten. Is het null,
   * dan is er niets gemeten en blijft het oude gedrag staan — dan zegt
   * taakVoorNummer het laatste woord.
   *
   * `zonderKaart` is het signaal voor telVensters: nabellen is dan niet te
   * meten, want een belpoging hangt aan een kaart.
   */
  function vensterTaakVoorCall(c) {
    const taak = taakVoorNummer(c && c.telefoon);
    if (!Array.isArray(c && c.wa)) return taak;   // niet gemeten → oud gedrag
    return {
      // De laatste negen cijfers als identiteit, net als in het rapport: de
      // agenda draagt landcodes en het CRM soms lokale notatie, en dat is
      // dezelfde persoon. Zie nummerSleutel() in api/opvolging-rapport.js.
      id        : (taak && taak.id) || 'nr:' + nummerSleutel(c.telefoon),
      zonderKaart: !taak,
      naam      : (taak && taak.naam) || c.naam || null,
      telefoon  : c.telefoon || (taak && taak.telefoon) || null,
      pogingen  : ((taak && taak.pogingen) || []).concat(c.wa),
    };
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
      if (!_calls.loading) straks(() => fetchCalls(dag));
      return { staat: 'laden' };
    }
    if (_calls.error) return { staat: 'agenda_fout', error: _calls.error };
    // WAT NIET DOORGAAT TELT NIET MEE. Een verzette of geannuleerde call heeft
    // geen ochtend om over te oordelen; hem meerekenen levert een rode 'geen
    // spraakbericht' op voor een afspraak die niet plaatsvindt.
    const calls = (_calls.data || []).filter(callGaatDoor);
    if (calls.length === 0) return { staat: 'geen_calls' };

    // PER CALL, NIET PER TAAK. Een zoomlead zonder opvolgkaart is nu ook te
    // beoordelen zodra de server zijn WhatsApp-berichten meestuurt.
    const taken = [];
    const gezien = {};
    const zonderTaak = [];
    for (const c of calls) {
      const t = vensterTaakVoorCall(c);
      if (!t) { zonderTaak.push(c); continue; }
      if (gezien[t.id]) continue;      // twee calls voor dezelfde lead = één rij
      gezien[t.id] = true;
      taken.push(t);
    }
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
    const leeg = { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0, niet_gemeten: 0 };
    const uit = { spraak: { ...leeg }, nabel: { ...leeg } };
    for (const t of (Array.isArray(taken) ? taken : [])) {
      const o = beoordeelDag(t, dag);
      uit.spraak.totaal += 1;
      uit.spraak[o.spraak.staat] += 1;

      // ── NABELLEN ZONDER KAART IS NIET GEMETEN ──────────────────────────
      // Een belpoging hangt aan een taak. Voor een zoomlead zonder opvolgkaart
      // bestaat die historiek niet, dus 'niet gebeld' zou geraden zijn —
      // precies het verwijt dat deze module nergens anders maakt. Het
      // spraakbericht is hier wél te meten: dat staat in
      // opvolging_wa_berichten, die aan een NUMMER hangt en geen kaart nodig
      // heeft.
      if (t && t.zonderKaart && o.nabel.staat === 'niet_gedaan') { uit.nabel.niet_gemeten++; continue; }

      // Het nabellen telt alleen mee voor wie het nodig had; anders zakt de
      // dekking door mensen die gewoon geantwoord hebben.
      if (o.nabel.staat !== 'niet_nodig') { uit.nabel.totaal += 1; uit.nabel[o.nabel.staat] += 1; }
      else uit.nabel.niet_nodig += 1;
    }
    return uit;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // G3 · DE NU-DOEN-BALK
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Bovenaan de dag: wat is nú aan de beurt. Oranje met 'Te laat' zodra een
  // venster voorbij is.
  //
  // WAT HIER NIET MAG GEBEUREN — en dat is de hele reden dat deze functie een
  // eigen kop heeft: er staat maar één ding in deze module met een echte klok
  // eraan, en dat zijn de twee vensters plus de zoomcalls. Een open taak heeft
  // een `due`, en dat is een DAG, geen tijdstip. Er is dus geen deadline om te
  // tonen, en er mag er ook geen verzonnen worden. 'Voor 17:00 afbellen' zou
  // een getal zijn dat nergens vandaan komt, en zoiets is over twee weken niet
  // meer van een echte afspraak te onderscheiden.
  //
  // Wat de balk dus toont, op volgorde van hoe hard de klok tikt:
  //
  //   1. Een zoomcall die nu bezig is of zo komt   — echte starttijd uit de agenda
  //   2. Het spraakbericht-venster (tot 09:00)     — echte deadline
  //   3. Het nabelvenster (12:00-13:00)            — echt venster
  //   4. De open taken                             — ALLEEN een aantal, zonder tijd
  //
  // En vier gevallen waarin er niets te zeggen valt, die dat dan ook zeggen:
  // een andere dag dan vandaag ('nu' bestaat alleen vandaag), een brug die geen
  // uitgaande berichten ziet (dan is 'geen spraakbericht' een bewering die we
  // niet kunnen doen), een agenda die nog laadt, en een agenda die eruit ligt.

  // Hoe lang een zoomcall duurt, en hoe ver vooruit de balk er een aankondigt.
  // Geen gegeven uit de agenda: die levert een starttijd en geen eind. Dit zijn
  // dus schattingen, en ze staan hier apart zodat dat zichtbaar blijft — en
  // zodat de balk nergens doet alsof dit gemeten tijden zijn.
  const CALL_DUUR_MIN    = 45;
  const CALL_VOORUIT_MIN = 60;

  /** Minuut-van-de-dag nu, in Amsterdamse tijd. */
  function nuMinuut() {
    const z = inZone(Date.now());
    return z ? z.minuut : null;
  }

  const uu = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  /**
   * Wat er nu aan de beurt is. Pure functie — na te slaan via
   * window.__opvNuHelpers en getest in tests/opvolging-nu-doen.test.js.
   *
   * Geeft terug WAT er te tonen is, niet hoe:
   *   { soort, titel, uitleg, telaat, deadline? , actie? }
   *
   * `telaat` stuurt de oranje kleur. Hij staat alleen op true als er een echt
   * venster verstreken is én er in dat venster nog werk open staat — een
   * gemiste deadline waar niets meer voor te doen valt is geen alarm maar
   * geschiedenis, en die hoort in de tijdlijn, niet bovenaan de dag.
   */
  function bepaalNuDoen({ dag, nu, minuut, brugZiet, calls, callsStaat, vensterTaken, openTaken, achterstand }) {
    if (dag !== nu) {
      return { soort: 'andere_dag', titel: 'Je kijkt naar een andere dag.',
        uitleg: '"Nu" bestaat alleen vandaag. Wat hier staat is geschiedenis of nog niet aan de beurt.',
        telaat: false };
    }
    if (minuut === null || minuut === undefined) {
      return { soort: 'geen_klok', titel: 'De tijd is hier niet te bepalen.',
        uitleg: 'Zonder klok valt er niet te zeggen wat er nu aan de beurt is.', telaat: false };
    }

    // 1 · Een zoomcall met een echte starttijd. Die gaat voor: hij staat vast
    //     op de minuut en iemand zit erop te wachten.
    const komende = (Array.isArray(calls) ? calls : [])
      .map((c) => ({ c, z: inZone(c && c.start) }))
      .filter((x) => x.z && x.z.dag === dag)
      .sort((a, b) => a.z.minuut - b.z.minuut);
    const bezig = komende.find((x) => minuut >= x.z.minuut && minuut < x.z.minuut + CALL_DUUR_MIN);
    if (bezig) {
      return { soort: 'call_bezig', titel: 'Call met ' + (bezig.c.naam || 'onbekend') + ' — nu bezig',
        uitleg: 'Begonnen om ' + bezig.z.tijd + '.', telaat: false, deadline: bezig.z.tijd };
    }
    const straks = komende.find((x) => x.z.minuut > minuut);
    if (straks && straks.z.minuut - minuut <= CALL_VOORUIT_MIN) {
      return { soort: 'call_straks', titel: 'Call met ' + (straks.c.naam || 'onbekend') + ' om ' + straks.z.tijd,
        uitleg: 'Over ' + (straks.z.minuut - minuut) + ' minuten.', telaat: false, deadline: straks.z.tijd };
    }

    // 1b · Wat van eerdere dagen nog open staat. Na de call die nú loopt — die
    //      heeft iemand aan de andere kant — maar vóór de twee vensters: een
    //      call die gisteren gevoerd is en nooit is afgerond, is werk dat al
    //      te laat is en niet vanzelf weggaat.
    const achter = Number(achterstand) || 0;
    if (achter > 0) {
      return { soort: 'achterstand', telaat: true,
        titel : achter + ' zoomcall(s) van eerdere dagen nog afronden',
        uitleg: 'Gesproken maar zonder uitkomst. Die eerst.' };
    }

    // 2 en 3 · De twee vensters. Alleen als de brug uitgaande berichten ziet:
    //     anders is 'nog geen spraakbericht' niet gemeten maar geraden.
    if (brugZiet && Array.isArray(vensterTaken) && vensterTaken.length) {
      const t = telVensters(vensterTaken, dag);
      const spraakOpen = t.spraak.niet_gedaan;
      const spraakGrens = SPRAAK_DEADLINE_UUR * 60;
      if (spraakOpen > 0) {
        if (minuut < spraakGrens) {
          return { soort: 'spraak', telaat: false, deadline: uu(spraakGrens),
            titel: spraakOpen + ' spraakbericht' + (spraakOpen === 1 ? '' : 'en') + ' insturen',
            uitleg: 'Nog ' + (spraakGrens - minuut) + ' minuten tot ' + uu(spraakGrens) + '.' };
        }
        return { soort: 'spraak', telaat: true, deadline: uu(spraakGrens),
          titel: spraakOpen + ' spraakbericht' + (spraakOpen === 1 ? '' : 'en') + ' insturen',
          uitleg: 'Te laat — deadline was ' + uu(spraakGrens) + '.' };
      }
      const nabelOpen = t.nabel.niet_gedaan;
      const van = NABEL_VAN_UUR * 60, tot = NABEL_TOT_UUR * 60;
      if (nabelOpen > 0) {
        if (minuut < van) {
          return { soort: 'nabel', telaat: false, deadline: uu(van) + '\u2013' + uu(tot),
            titel: nabelOpen + ' keer nabellen',
            uitleg: 'Het venster gaat om ' + uu(van) + ' open.' };
        }
        if (minuut < tot) {
          return { soort: 'nabel', telaat: false, deadline: uu(van) + '\u2013' + uu(tot),
            titel: nabelOpen + ' keer nabellen',
            uitleg: 'Nog ' + (tot - minuut) + ' minuten tot ' + uu(tot) + '.' };
        }
        return { soort: 'nabel', telaat: true, deadline: uu(van) + '\u2013' + uu(tot),
          titel: nabelOpen + ' keer nabellen',
          uitleg: 'Te laat — het venster was ' + uu(van) + ' tot ' + uu(tot) + '.' };
      }
    }

    // 4 · De open taken. Een aantal, geen deadline — die is er niet.
    const open = Number(openTaken) || 0;
    if (open > 0) {
      return { soort: 'taken', telaat: false,
        titel: open + ' open ta' + (open === 1 ? 'ak' : 'ken') + ' vandaag',
        // Bewust zonder tijd. Een taak draagt een `due` en dat is een dag; er
        // is geen uur om te tonen en er wordt er ook geen verzonnen.
        uitleg: 'Geen vast tijdstip: aan een taak hangt een dag, geen klok.' };
    }

    // Niets open. Of er valt niets te meten — dan zegt de balk dat, in plaats
    // van 'klaar' te melden op grond van iets dat niet gekeken is.
    if (!brugZiet) {
      return { soort: 'niet_meetbaar', telaat: false, titel: 'Niets open in de takenlijst.',
        uitleg: 'Over de spraakberichten en het nabellen valt niets te zeggen: de brug ziet ' +
          'geen uitgaande berichten. Dat is geen nul, dat is een blinde vlek.' };
    }
    if (callsStaat === 'laden') {
      return { soort: 'laden', telaat: false, titel: 'Even kijken wat er nu aan de beurt is\u2026',
        uitleg: 'De agenda wordt opgehaald.' };
    }
    if (callsStaat === 'agenda_fout') {
      return { soort: 'agenda_fout', telaat: false, titel: 'Niets open in de takenlijst.',
        uitleg: 'De agenda is niet bereikbaar, dus over de calls van vandaag valt hier niets te zeggen.' };
    }
    return { soort: 'klaar', telaat: false, titel: 'Niets meer aan de beurt.',
      uitleg: 'De takenlijst is leeg en de vensters van vandaag zijn rond.' };
  }

  const leegTakenCache = () => {
    _live.taken.data = null; _live.taken.key = null;
    _live.dash.data = null; _live.dash.key = null;
    _live.archief.data = null;
    // De weekbalk telt dezelfde taken. Bleef die staan, dan toonde een tegel
    // nog het getal van vóór de actie — precies het soort getal dat eruitziet
    // alsof het klopt.
    _live.balk.data = null; _live.balk.key = null;
    _live.later.data = null; _live.later.key = null;
    _live.tijdlijn.data = null; _live.tijdlijn.key = null;
    // De calls hangen aan dezelfde dag; een nieuwe taak verandert welke
    // belknop een taak-koppeling krijgt.
    _calls.data = null; _calls.key = null; _calls.error = null; _calls.achterstand = [];
  };

  /**
   * Een korte melding onderin. Via window.KV.toast, want dit bestand heeft
   * geen eigen toast.
   *
   * Twee bestaande aanroepen deden `showToast(...)` zonder dat die naam hier
   * bestaat — dat is een ReferenceError op het moment dat je 'm nodig hebt, en
   * dus precies dan geen melding. Eén helper, met een guard, en een alert als
   * laatste redmiddel: een melding die niemand ziet is geen melding.
   */
  function opvToast(msg) {
    if (window.KV && typeof window.KV.toast === 'function') { window.KV.toast(msg); return; }
    alert(msg);
  }

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
/* G1: er is een zevende tegel bij gekomen — 'Later'. Zelfde grid-redenering:
   zeven gelijke kolommen die kunnen krimpen in plaats van af te breken. */
.opv .wkbar .wk{margin:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px}
.opv .wkd.later{background:#fbfaff;border-style:dashed}
.opv .wkd.later .l .d{color:var(--o-pur)}
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
/* G1 · de tijdlijn van een voorbije dag */
.opv .tl{display:flex;flex-direction:column;gap:2px}
.opv .tlrij{display:grid;grid-template-columns:46px 26px 1fr;align-items:flex-start;gap:8px;padding:8px 4px;border-bottom:1px solid var(--o-line)}
.opv .tlrij:last-child{border-bottom:0}
.opv .tltijd{font-variant-numeric:tabular-nums;font-weight:650;color:var(--o-muted);font-size:12.5px;padding-top:1px}
.opv .tlem{font-size:14px;line-height:1.2}
.opv .tlwat{min-width:0;font-size:13px}
.opv .tlres{color:var(--o-muted);font-size:12px;margin-top:2px}
.opv .tlvoet{margin-top:14px}
/* G1 · alles wat later staat, gegroepeerd per dag */
.opv .lt{display:flex;flex-direction:column;gap:14px}
.opv .ltkop{font-size:12.5px;font-weight:700;color:var(--o-muted);margin:0 0 6px 2px}
.opv .ltkop small{font-weight:600;color:var(--o-muted);opacity:.75}
.opv .ltrij{display:flex;align-items:center;gap:8px;width:100%;text-align:left;font:inherit;cursor:pointer;background:#fff;border:1px solid var(--o-line);border-radius:10px;padding:8px 11px;margin-bottom:5px}
.opv .ltrij:hover{border-color:var(--o-acc)}
.opv .ltnm{flex:1 1 auto;font-weight:650;font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Het etiket krimpt en kapt zichzelf af; de naam niet. Zonder deze twee regels
   eist een lang eventlabel alle breedte op en blijft er 'Bryan Van ...' over. */
.opv .ltrij .tag{flex:0 0 auto}
.opv .ltrij .ltev{flex:0 1 auto;min-width:0;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* G3 · de nu-doen-balk. Oranje zodra een venster verstreken is; verder rustig,
   want hij staat er de hele dag. */
.opv .nudoen{display:flex;align-items:center;gap:12px;background:#fff;border:1px solid var(--o-line);border-left:4px solid var(--o-acc);border-radius:12px;padding:11px 14px;margin:0 0 14px;box-shadow:var(--o-sh)}
.opv .nudoen.laat{border-left-color:var(--o-amb);background:var(--o-ambs)}
.opv .nudoen .nuic{font-size:18px;line-height:1}
.opv .nudoen .nutxt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.opv .nudoen .nutxt b{font-size:14px}
.opv .nudoen .nutxt span{font-size:12.5px;color:var(--o-muted)}
.opv .nudoen.laat .nutxt span{color:#8a5a00}
.opv .nudoen .nudl{font-variant-numeric:tabular-nums;font-weight:700;font-size:13px;color:var(--o-muted);white-space:nowrap}
.opv .nudoen.laat .nudl{color:var(--o-amb)}
.opv .ronde{font-size:12.5px;color:var(--o-muted);margin:0 0 10px 2px}
.opv .belr{margin-top:5px;font-size:11.5px;color:var(--o-muted);display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px}
.opv .belr b{font-weight:600;color:#4b5563}
.opv .belr.belraak b{color:#166534}
.opv .belr.leeg{font-style:italic}
.opv .bps{display:inline-flex;flex-wrap:wrap;gap:4px}
.opv .belbol{padding:1px 6px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:11px}
.opv .belbol.gsp{background:#dcfce7;color:#166534}
.opv .belbol.kort{background:#fef3c7;color:#92400e}
.opv .belbol.onb{background:#e5e7eb;color:#4b5563}
/* HET RONDELABEL IS EEN ZIN, GEEN DERDE KOLOM.
   Gemeten op productie: .row.rst is 633 breed met gap 14 en drie kinderen.
   .rnd had width:100% maar GEEN flex-shorthand, dus flex-shrink:1 met
   min-width:auto — hij mag dus niet kleiner worden dan zijn inhoud. .who heeft
   min-width:0 en mag wél tot nul krimpen. Uitkomst: .rnd 395, .act 178, .who
   NUL. De naam brak over twee regels en +32 473 97 98 12 viel uiteen in een
   cijfergroepje per regel.
   Dat is de omgekeerde wereld: de uitleg over de ronde won het van de naam van
   de lead en het nummer dat je moet bellen.
   Rekenen laat zien dat drie kolommen simpelweg niet passen: .who wil ~312,
   .act 178, en het rondepaneel 741 als het niet mag afbreken — op 605
   beschikbaar. Vandaar geen CSS-tweak maar een indelingswijziging: flex:1 0
   100% zet hem op zijn eigen regel bovenaan, en .who houdt 633 - 178 - 14 =
   441 over. Dat blijft ook kloppen op een smaller venster, en dat is het punt:
   deze fout was er al bij een gewone laptopbreedte. */
.opv .rnd{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;
  flex:1 0 100%;min-width:0;
  margin:0 0 8px;padding:5px 9px;border-radius:7px;font-size:12px;line-height:1.45}
.opv .rnd b{font-size:12.5px;letter-spacing:.01em}
.opv .rnd span{color:var(--o-muted)}
.opv .rnd .terug{font-style:italic}
.opv .rnd.rA{background:#eef4ff;color:#1e3a8a}
.opv .rnd.rA b{color:#1d4ed8}
.opv .rnd.rB{background:#fff4e6;color:#7c3a03}
.opv .rnd.rB b{color:#b45309}
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
.opv .call.vervallen{background:#fafbfc;border-style:dashed;box-shadow:none}
.opv .call.vervallen .nm{color:#8b939f}
.opv .call.vervallen .nm,.opv .call.vervallen .tijd{text-decoration:line-through;text-decoration-color:#c3c8d0}
.opv .call.vervallen .nm .tag{text-decoration:none}
.opv .call.vervallen .sub{color:#a2a9b4}
.opv .obtn.klaar{background:var(--o-grns);color:#08794a;border-color:transparent;cursor:default;font-weight:650}
.opv .call .who{flex:1;min-width:0}
.opv .call .nm{font-weight:650;font-size:14.5px}
.opv .call .sub{font-size:12.5px;color:var(--o-muted);margin-top:3px}
.opv .call .act{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}
/* Nog af te ronden — van eerdere dagen. Oranje, want dit is te laat: gesproken
   maar zonder uitkomst, en het gaat niet vanzelf weg. Het kader eromheen maakt
   zichtbaar dat deze rijen NIET bij de dag eronder horen. */
.opv .achterstand{border:1.5px solid var(--o-amb);border-radius:16px;background:#FFFBF4;padding:12px 12px 4px;margin-bottom:16px}
.opv .achterstand .sh{margin-top:0}
.opv .achterstand .sh h3{color:#8a5200}
.opv .achterstand .sh .n{background:var(--o-amb);color:#fff}
.opv .achterstand .ronde{margin-bottom:10px}
.opv .achterstand .call .tijd{flex:0 0 74px;font-size:13px;line-height:1.35;color:#8a5200}
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
.opv .tellerblok{margin-top:16px;border-top:1px solid var(--o-line);padding-top:12px}
.opv .tellerkop{font-size:12px;font-weight:700;color:var(--o-muted);margin-bottom:6px}
.opv table.tellers{width:100%;border-collapse:collapse;font-size:12px}
.opv table.tellers th{text-align:left;font-weight:600;color:var(--o-muted);padding:2px 6px 4px 0;font-size:11px}
.opv table.tellers td{padding:3px 6px 3px 0;border-top:1px solid #f1f2f5;font-variant-numeric:tabular-nums}
.opv table.tellers td:first-child{color:var(--o-muted)}
/* ── Het gesprekspaneel ────────────────────────────────────────────────────
   Zelfde scrim en dezelfde kop als het koppelpaneel, maar als vel dat van
   rechts inschuift: een gesprek lees je naast je lijst, niet er middenin. */
.opv .scrim.rechts{place-items:stretch;justify-content:flex-end;padding:0}
.opv .wpaneel{background:#fff;width:100%;max-width:460px;height:100%;display:flex;flex-direction:column;box-shadow:-24px 0 70px rgba(0,0,0,.3);animation:opvSchuif .18s ease-out}
@keyframes opvSchuif{from{transform:translateX(100%)}to{transform:translateX(0)}}
@media (prefers-reduced-motion:reduce){.opv .wpaneel{animation:none}}
.opv .wpaneel .mh{flex:0 0 auto}
.opv .wbody{flex:1;overflow-y:auto;padding:16px 18px;background:#f7f8fa;min-height:0}
.opv .wchat{display:flex;flex-direction:column;gap:8px}
.opv .wbrij{display:flex}
.opv .wbrij.uit{justify-content:flex-end}
.opv .wbub{max-width:78%;background:#fff;border:1px solid var(--o-line);border-radius:14px 14px 14px 4px;padding:8px 11px 6px;font-size:13.5px;line-height:1.45;color:var(--o-ink);white-space:pre-wrap;word-break:break-word;box-shadow:var(--o-sh)}
.opv .wbrij.uit .wbub{background:var(--o-grns);border-color:#bfe9d6;border-radius:14px 14px 4px 14px}
.opv .wbub.bezig{opacity:.6}
.opv .wbub .wtijd{display:block;margin-top:3px;font-size:10.5px;color:var(--o-muted);text-align:right;font-variant-numeric:tabular-nums}
.opv .wbub .wsp{opacity:.7}
.opv .winvoer{flex:0 0 auto;border-top:1px solid var(--o-line);padding:12px 14px;display:flex;gap:8px;align-items:flex-end;background:#fff}
.opv .winvoer textarea{flex:1;margin:0;resize:none}
.opv .winvoer.uit{flex-direction:column;align-items:stretch;gap:6px}
.opv .winvoer .wreden{font-size:12px;color:var(--o-muted)}
.opv .wvoet{flex:0 0 auto;padding:0 14px 12px;font-size:12px}
.opv .wvoet a{color:var(--o-acc);text-decoration:none;font-weight:600}
.opv .wvoet a:hover{text-decoration:underline}
.opv .wouder{display:flex;justify-content:center;margin-bottom:10px}
.opv .wouder .obtn{font-size:12px;padding:5px 12px}
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
/* Alleen de rijen MET een rondebalk breken af; de andere kaarten in deze module
   houden hun bestaande gedrag, want flex-wrap globaal aanzetten zou daar
   onbedoeld iets kunnen verschuiven. */
.opv .row.rnd-boven{flex-wrap:wrap}
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
/* G2 · het formulier van '+ Lead toevoegen'. Zelfde vorm als de bestaande
   velden hierboven; text en select deden nog niet mee omdat ze nergens
   voorkwamen. */
.opv .lf input[type=text],.opv .lf select{width:100%;border:1px solid var(--o-line);border-radius:11px;padding:11px 12px;font-size:13.5px;font-family:inherit;background:#fff;color:inherit}
.opv .lf label{display:block;font-size:12.5px;font-weight:650;margin:12px 0 5px}
.opv .lf label:first-child{margin-top:0}
.opv .lf label small{font-weight:600;color:var(--o-muted)}
.opv .lfhint{font-size:11.5px;color:var(--o-muted);margin:5px 0 0 2px}
.opv .leadknop{white-space:nowrap;flex:none;align-self:flex-start}
.opv .tl{list-style:none;margin:0;padding:0}
.opv .tl li{display:flex;gap:12px;padding:9px 0;font-size:13.5px;border-bottom:1px solid #f3f4f6}
.opv .tl li:last-child{border:0}
.opv .tl .d{flex:0 0 120px;color:var(--o-muted);font-size:12.5px}
/* ─── R · HET DAGRAPPORT ───────────────────────────────────────────────────
   EIGEN NAMESPACE, EN DIT IS DE REDEN.

   Het rapport gebruikte .kpi met kinderen .cell / .n / .l. Drie dingen gingen
   daar mis, en geen ervan gaf een foutmelding:

   · .opv .kpi bestaat al in DEZE module, maar als ENKELVOUDIGE kaart met
     kinderen .k / .v / .s. Het rapport gebruikte hem als rij van vier. Hij
     kreeg dus de doos van één kaart en geen enkele indeling.
   · .cell heeft nergens in deze module een regel. app-shell.css heeft alleen
     .cell-main en .cell-sub — die matchen niet.
   · .n en .l bestaan wel, maar in een andere context (.sh .n en .wkd .l), dus
     ook die grepen niet.

   Alles viel daardoor terug op display:block: getal, label, getal, label,
   onder elkaar in een lege witte doos. Namen als cell, n en l horen sowieso
   niet in een gedeelde stylesheet; die botsen vroeg of laat met iets anders.

   tests/opvolging-rapport-css.test.js bewaakt dat elke klasse die het rapport
   tekent ook echt een regel heeft, en dat geen enkele naam botst met
   app-shell.css. */
.opv .opvr-kop{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:0 0 14px}
.opv .opvr-knoppen{display:flex;gap:6px;flex-wrap:wrap}
.opv .opvr-eigen{display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--o-muted)}
.opv .opvr-eigen input{font:inherit;padding:5px 8px;border:1px solid var(--o-line);border-radius:8px;color:var(--o-ink)}
.opv .opvr-sectie{margin:0 0 16px;padding:16px 18px}
.opv .opvr-sectie h3{margin:0 0 12px;font-size:15px;font-weight:700}
/* De cijferrij. minmax(0,1fr) zodat een lange waarde de kolom laat krimpen in
   plaats van het grid te laten afbreken — zelfde redenering als bij de
   weekbalk hierboven. */
.opv .opvr-kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(0,1fr));
 gap:1px;background:var(--o-line);border:1px solid var(--o-line);border-radius:12px;
 overflow:hidden;margin:0 0 12px}
.opv .opvr-cel{background:#fff;padding:12px 14px;min-width:0}
.opv .opvr-getal{font-size:24px;font-weight:750;line-height:1.15;font-variant-numeric:tabular-nums}
.opv .opvr-label{font-size:11.5px;color:var(--o-muted);margin-top:3px}
.opv .opvr-lijst{display:flex;flex-direction:column;gap:2px}
.opv .opvr-regel{padding:8px 10px;border-left:3px solid var(--o-line);background:#fafbfc;border-radius:0 8px 8px 0}
.opv .opvr-regel.opvr-rood{border-left-color:var(--o-red);background:var(--o-reds)}
.opv .opvr-regel.opvr-groen{border-left-color:#16a34a;background:#f0fdf4}
.opv .opvr-tl{margin:10px 0 6px}
.opv .opvr-tl-kop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:12.5px;margin-bottom:4px}
.opv .opvr-tl-kop span{color:var(--o-muted);font-size:11.5px}
.opv .opvr-tl-legenda{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:11px;color:var(--o-muted)}
.opv .opvr-tl-legenda i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px}
.opv .opvr-regel.opvr-grijs{border-left-color:#d1d5db;background:#f7f8f9}
.opv .opvr-t{font-size:13.5px;font-weight:600}
.opv .opvr-u{font-size:12px;color:var(--o-muted);font-weight:400}
.opv .opvr-notitie{white-space:pre-wrap;margin-top:4px}
.opv .opvr-bel{margin-top:4px;display:flex;flex-wrap:wrap;align-items:baseline;gap:3px 8px}
.opv .opvr-ritme{margin:10px 0 4px}
.opv .opvr-ritme-kop{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:12.5px;margin-bottom:6px}
.opv .opvr-ritme-kop span{color:var(--o-muted);font-size:11.5px}
.opv .opvr-balk{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:3px;align-items:end;height:74px}
.opv .opvr-uur{display:flex;flex-direction:column;justify-content:flex-end;height:100%;min-width:0;text-align:center}
.opv .opvr-staaf{background:#2563eb;border-radius:3px 3px 0 0;min-height:3px}
.opv .opvr-staaf.opvr-leeg{background:#e5e7eb;height:3px!important}
.opv .opvr-uurlabel{font-size:9.5px;color:var(--o-muted);margin-top:3px}
.opv .opvr-uuraantal{font-size:10px;color:#374151;font-weight:600;height:12px}
.opv .opvr-blokkop{margin:14px 0 6px;font-size:13px;display:flex;align-items:center;gap:7px}
.opv .opvr-blokkop span{font-size:11px;color:var(--o-muted);background:#f3f4f6;border-radius:999px;padding:1px 7px}
.opv .opvr-bel.belraak{color:#166534}
.opv .opvr-bps{display:inline-flex;flex-wrap:wrap;gap:4px}
.opv details.opvr-rijen{margin-top:10px}
.opv details.opvr-rijen>summary{cursor:pointer;font-size:12.5px;color:var(--o-acc);padding:4px 0;user-select:none}
.opv details.opvr-rijen[open]>summary{margin-bottom:6px}
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
    // De kaarten van cron-opvolging-zoom-nabel. Zonder deze regel toont de
    // badge de rauwe sleutel 'zoom_nabellen'.
    zoom_nabellen: ['Zoomcall nabellen', 't-amber'],
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
    const strook = t.reden === 'aanmelding' ? rondeStrook(t, nuDag) : '';
    return '<div class="row' + (strook ? ' rnd-boven' : '') + '">' + strook +
      '<div class="who">' +
      '<div class="nm">' + esc(t.naam) +
        ' <span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>' +
        (t.reden_code ? ' <span class="tag t-grey">' + esc(t.reden_code) + '</span>' : '') +
        (badgeTekst(t) ? ' <span class="tag t-grey">' + esc(badgeTekst(t)) + '</span>' : '') +
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

    const strook = t.reden === 'aanmelding' ? rondeStrook(t, nuDag) : '';
    return '<div class="row rst' + (strook ? ' rnd-boven' : '') + '">' + strook +
      '<div class="who">' +
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
   * BELPOGINGEN VAN DIE DAG BIJ DEZE CALL — het bewijsmateriaal.
   *
   * Shudino Andrade stond als no-show terwijl er die dag om 17:23 een gesprek
   * van 41 seconden met hem was. Dat stond gewoon in onze data en was nergens
   * te zien, dus moest de collega die hem gebeld had op zijn woord geloofd
   * worden. Precies het bewijs waar deze module voor bedoeld is.
   *
   * ALLE pogingen van die dag, niet alleen het nabelvenster van 12 tot 13. Dat
   * venster beantwoordt een andere vraag — is er op tijd nagebeld — en een
   * gesprek om kwart over vijf telt voor deze vraag net zo hard.
   *
   * belZin() is de tweeling van belZin() in api/opvolging-rapport.js, zodat het
   * dagscherm en het rapport dezelfde zin geven. tests/opvolging-belzin-
   * tweeling.test.js houdt ze gelijk.
   */
  // HET RESULTAAT BESLIST, NIET DE DUUR — tweeling van classificeerResultaat()
  // in api/_lib/opvolging-poging-telling.js. De grens van tien seconden is op
  // 8 september vervallen: duur_sec is de tijd tussen kiezen en ophangen, dus
  // inclusief overgaan. Meting over de laatste weken: bij 'niet opgenomen'
  // staan duren tot 43 seconden, bij 'gesproken' vanaf 4.
  //
  // Vrije tekst, dus op VOORVOEGSEL: 'gesproken: bevestigd — neemt laptop mee'
  // hoort gewoon bij gesproken.
  function classificeerResultaat(r) {
    const t = String(r == null ? '' : r).toLowerCase().trim().replace(/\s+/g, ' ');
    if (!t) return 'onbekend';
    if (t.startsWith('via ander') || t.startsWith('bevestigd via')) return 'via_ander';
    if (t.startsWith('gesproken')) return 'gesproken';
    if (t.startsWith('niet opgenomen') || t.startsWith('niet_opgenomen')
        || t.startsWith('geen gehoor') || t.startsWith('geen_gehoor')) return 'niet_opgenomen';
    return 'onbekend';
  }

  function belZin(aantal, gesproken, seconden) {
    if (!aantal) return 'Die dag niet gebeld.';
    const keer = aantal + '\u00d7 gebeld';
    if (!gesproken) return 'Die dag ' + keer + ', niemand nam op.';
    const kop = 'Die dag ' + keer + ', waarvan ' +
      (gesproken === 1 ? '1 gesprek' : gesproken + ' gesprekken');
    if (!seconden) return kop + '; de lengte is niet geregistreerd.';
    const duur = seconden >= 90 ? Math.round(seconden / 60) + ' min' : seconden + ' s';
    return kop + ' van samen ' + duur + '.';
  }

  /**
   * De duur van een poging, of null.
   *
   * Number(null) is 0 en 0 is finite: zonder deze check wordt een ontbrekende
   * duur stilletjes een call van nul seconden, en dus 'te kort'. Onbekend is
   * geen nee — zelfde regel als isGesprek() aan de serverkant.
   */
  function duurVan(p) {
    const ruw = p && p.duur_sec;
    if (ruw === null || ruw === undefined || !Number.isFinite(Number(ruw))) return null;
    return Number(ruw);
  }

  /** De uitgaande belpogingen van één dag uit de historiek van een taak. */
  function belVanDag(taak, dag) {
    const alles = (taak && taak.pogingen) || [];
    const rij = alles.filter((p) =>
      p && String(p.soort || '') === 'call' &&
      (!p.richting || String(p.richting) === 'uit') &&
      iso(p.tijdstip) === dag);
    let gesproken = 0;
    let seconden = 0;
    for (const p of rij) {
      if (classificeerResultaat(p.resultaat) !== 'gesproken') continue;
      gesproken += 1;
      // Een op de drie gesproken calls heeft geen duur; dat is het normale
      // geval, geen randgeval. Tel er dus geen nul bij op.
      const d = duurVan(p);
      if (d !== null) seconden += d;
    }
    return { aantal: rij.length, gesproken, seconden, pogingen: rij };
  }

  /**
   * HET SPRAAKBERICHT ONDER EEN CALL.
   *
   * De vraag die Dave 's ochtends stelt is 'heb ik deze al ingesproken?', en
   * die stond nergens per persoon — alleen als balk over de hele dag. Nu de
   * server de berichten bij de call hangt, kan het per rij.
   *
   * DRIE UITKOMSTEN, en de derde is er bewust één: is `c.wa` geen array, dan is
   * er niets gemeten en staat er NIETS. Een '🎤 Nog geen spraakbericht' op een
   * niet-gemeten call is precies de valse nul waar deze module nergens anders
   * in trapt.
   *
   * De dag komt uit inZone(), niet uit iso(): dat laatste is UTC, en dan valt
   * een spraakbericht van 08:30 's winters op de verkeerde dag.
   */
  function spraakRegel(c, dag) {
    if (!Array.isArray(c && c.wa)) return '';
    if (!callGaatDoor(c)) return '';

    const taak = taakVoorNummer(c.telefoon);
    const pog = ((taak && taak.pogingen) || []).concat(c.wa);
    const o = beoordeelSpraak(pog, dag);

    // 'heeft geantwoord' hangt aan het NABEL-oordeel: wie antwoordde hoeft niet
    // meer nagebeld. Dat is precies wat Dave hier wil zien staan.
    const n = beoordeelNabel(pog, dag);
    const geantwoord = (n.staat === 'niet_nodig' && n.reden === 'heeft geantwoord') ? ' &middot; heeft geantwoord' : '';

    if (o.staat === 'niet_gedaan') {
      return '<div class="belr leeg">&#127908; Nog geen spraakbericht' + geantwoord + '</div>';
    }
    const laat = o.staat === 'te_laat';
    return '<div class="belr' + (laat ? '' : ' belraak') + '">&#127908; Spraakbericht om ' +
      esc(o.tijd) + ' &mdash; ' + (laat ? 'na 09:00' : 'op tijd') + geantwoord + '</div>';
  }

  /** Het regeltje onder een call. Geen taak = geen historiek, en dat zeggen we. */
  function belRegel(taak, dag) {
    if (!taak) {
      return '<div class="belr leeg">Deze lead staat niet in de takenlijst, dus er is geen belhistoriek om bij te zetten.</div>';
    }
    const b = belVanDag(taak, dag);
    const stippen = b.pogingen.map((p) => {
      const k = classificeerResultaat(p.resultaat);
      const d = k === 'gesproken' ? duurVan(p) : null;
      const kl = k === 'gesproken' ? 'gsp' : k === 'niet_opgenomen' ? 'kort' : 'onb';
      // Alleen bij gesproken een duur. Bij een niet-opgenomen call zou dat
      // overgaantijd zijn, en bij gesproken-zonder-duur is de eerlijke tekst
      // dat de lengte niet geregistreerd is — geen nul.
      return '<span class="belbol ' + kl + '" title="' + esc(p.resultaat || 'geen resultaat vastgelegd') + '">' +
        esc(uur(p.tijdstip)) +
        (k === 'gesproken' ? (d === null ? ' &middot; lengte onbekend' : ' &middot; ' + d + ' s') : '') +
        '</span>';
    }).join('');
    return '<div class="belr' + (b.gesproken ? ' belraak' : '') + '">' +
      '<b>' + esc(belZin(b.aantal, b.gesproken, b.seconden)) + '</b>' +
      (stippen ? '<span class="bps">' + stippen + '</span>' : '') + '</div>';
  }

  /**
   * NOG AF TE RONDEN — DE ZOOMCALLS VAN EERDERE DAGEN.
   *
   * Maxims regel: Dave rondt elke zoomcall af (klant geworden / wil nog
   * beslissen + datum / no-show / geen interesse). Rondt hij er een niet af,
   * dan staat die de volgende dag bovenaan: 'van gisteren, werk deze af'.
   *
   * Zonder dit blok blijft zo'n call op zijn eigen dag staan, en die dag kijkt
   * niemand meer terug. Gemeten op 9 september: 3 calls zonder afronding, op
   * 8 september 1.
   *
   * BOVEN 'Calls van vandaag', met opzet: wat blijft liggen gaat vóór wat er
   * nog aan komt. De rijen dragen hun eigen dag, want 'gisteren 15:00' zegt
   * iets anders dan '15:00'.
   */
  function achterstandBlok() {
    const lijst = _calls.achterstand || [];
    if (!lijst.length) return '';

    const kop = '<div class="sh"><div class="ic" style="background:var(--o-ambs)">&#9888;</div>' +
      '<h3>Nog af te ronden &mdash; van eerdere dagen</h3>' +
      '<span class="n">' + lijst.length + '</span></div>';

    return '<div class="achterstand">' + kop +
      '<div class="ronde">Gesproken maar nog geen uitkomst gekozen. <b>Rond deze eerst af.</b></div>' +
      lijst.map((c, i) => {
        const k = c.knoppen || { afronden: true, bellen: !!c.telefoon, whatsapp: !!c.telefoon, zoom: false };
        const knoppen =
          (k.bellen && c.telefoon ? '<button class="obtn p" onclick="window.__opvCallBel(\'a' + i + '\')">&#9742; Bellen</button>' : '') +
          (k.whatsapp && c.telefoon ? '<button class="obtn wa" onclick="window.__opvCallWa(\'a' + i + '\')">&#128172; WhatsApp</button>' : '') +
          (k.afronden ? '<button class="obtn" onclick="window.__opvCallAfrond(\'a' + i + '\')">Afronden &rarr;</button>' : '');
        const taak = taakVoorNummer(c.telefoon);
        return '<div class="call geweest">' +
          '<div class="tijd">' + esc(achterstandDag(c.dag)) + '<br>' + esc(c.tijd || '') + '</div>' +
          '<div class="who"><div class="nm">' + esc(c.naam) + '</div>' +
          '<div class="sub">' + esc(c.telefoon || 'geen nummer bekend') +
            (taak ? ' &middot; staat al in je lijst' : '') + '</div></div>' +
          '<div class="act">' + knoppen + '</div></div>';
      }).join('') + '</div>';
  }

  /** 'gisteren' als het dat was, anders 'ma 07/09'. */
  function achterstandDag(dag) {
    if (!dag) return '';
    if (dag === dagPlus(vandaag(), -1)) return 'gisteren';
    return nl(dag);
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
    if (!_calls.loading && !versGeladen) straks(() => fetchCalls(dag));

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
    // Ontbreekt een kolom nog, dan kan deze lijst verzette afspraken missen of
    // proefrijen tonen. Dat hoort er te staan: een onvolledig dagbeeld dat zich
    // voordoet als volledig is precies waar we deze week op zijn vastgelopen.
    const waarschuwing = _calls.onvolledig
      ? '<div class="ronde zacht">' + esc(_calls.onvolledig) + '</div>' : '';

    return kop + waarschuwing + _calls.data.map((c, i) => {
      const geweest = c.start && new Date(c.start).getTime() < nuMs;
      const taak = taakVoorNummer(c.telefoon);
      // WAT HIER NIET MEER DOORGAAT KRIJGT GEEN KNOPPEN. Een Zoom-knop bij een
      // call die verzet is nodigt uit tot een gesprek dat niemand verwacht, en
      // de uitkomst hoort bij de nieuwe datum.
      //
      // GRIJS BETEKENT NIET ONAANRAAKBAAR. Alleen een verzetting haalt knoppen
      // weg — een status van buiten niet. Welke knoppen mogen komt van de
      // server (knoppenVoor in api/_lib/opvolging-dagbeeld.js); de terugval
      // geldt voor een oudere server die het veld nog niet meestuurt.
      const k = c.knoppen || { afronden: true, bellen: !!c.telefoon, whatsapp: !!c.telefoon, zoom: !!c.zoom_url };
      const knoppen =
        (k.zoom && c.zoom_url ? '<a class="obtn zoom" href="' + esc(c.zoom_url) + '" target="_blank" rel="noopener">&#127909; Zoom</a>' : '') +
        (k.bellen && c.telefoon ? '<button class="obtn p" onclick="window.__opvCallBel(' + i + ')">&#9742; Bellen</button>' : '') +
        (k.whatsapp && c.telefoon ? '<button class="obtn wa" onclick="window.__opvCallWa(' + i + ')">&#128172; WhatsApp</button>' : '') +
        // AL AFGEROND? DAN STAAT DAT ER, en geen knop die uitnodigt om het nog
        // eens te doen. Dave rondt er 's ochtends twee af, kijkt 's middags
        // opnieuw, en moet kunnen zien welke twee — anders doet hij het dubbel
        // en overschrijft de tweede uitkomst de eerste.
        //
        // De terugval geldt voor een oudere server die het veld nog niet
        // meestuurt: dan gedraagt het blok zich als voorheen.
        ((c.afrond && c.afrond.toon === 'uitkomst')
          ? '<span class="obtn klaar" title="' + esc('Afgerond' + (c.afrond.vastgelegd.op ? ' op ' + nl(iso(c.afrond.vastgelegd.op)) : '')) + '">'
            + '&#10003; Afgerond &middot; ' + esc(c.afrond.vastgelegd.label) + '</span>'
          : (k.afronden ? '<button class="obtn" onclick="window.__opvCallAfrond(' + i + ')">Afronden &rarr;</button>' : ''));
      const dood = c.doorgehaald === true;
      // ALLEEN HET AGENDAFEIT. Dit label zegt 'verzet naar 15 september' en
      // verder niets: een uitkomst tonen doet uitsluitend de afrondchip
      // hierboven, en die leest alleen wat Dave zelf heeft vastgelegd.
      const label = c.label ? ' <span class="tag t-grey">' + esc(c.label) + '</span>' : '';
      return '<div class="call' + (geweest ? ' geweest' : '') + (dood ? ' vervallen' : '') + '">' +
        '<div class="tijd">' + esc(c.tijd) + '</div>' +
        '<div class="who"><div class="nm">' + esc(c.naam) + label + '</div>' +
        '<div class="sub">' + esc(c.telefoon || 'geen nummer bekend') +
          (taak ? ' &middot; staat al in je lijst' : '') + '</div>' +
        spraakRegel(c, dag) +
        belRegel(taak, dag) + '</div>' +
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
      straks(() => { fetchWaStatus(); });
    } else if (!_waTimers.status && !_wa.paneelOpen) {
      // Terug op deze tab na een uitstapje: de timers zijn dan opgeruimd.
      straks(() => herstelWaTimers());
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

    body += brugTellersBlok(d);

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
    return '<div class="opv"><div class="scrim on"' +
      ' onmousedown="window.__opvScrimNeer(event)" onmouseup="window.__opvScrimOp(event, \'wa\')">' +
      '<div class="modal"><div class="mh"><div><h3>WhatsApp-brug</h3>' +
      '<p>' + esc(s.uitleg) + '</p></div>' +
      '<button class="x" onclick="window.__opvWaSluit()">&times;</button></div>' +
      '<div class="mb">' + body + '</div></div></div></div>';
  }

  /**
   * De gebeurtenissen-tellers van de brug, in het koppelpaneel.
   *
   * Dit bestaat omdat een bericht stil gedropt kan raken tussen 'de brug zag
   * iets' en 'het CRM kreeg iets', en het privacyfilter maakt dat gat per
   * definitie: wat we niet mogen loggen, kunnen we ook niet terugvinden. De
   * tellers dragen alleen aantallen — geen nummer, geen tekst — en die mogen
   * dus gewoon op het scherm.
   *
   * Een oudere brug stuurt ze niet mee; dan staat er niets in plaats van nullen
   * die eruitzien alsof er gemeten is.
   */
  function brugTellersBlok(d) {
    const g = d && d.gebeurtenissen;
    if (!g || !g.gezien) {
      return '<div class="ronde zacht" style="margin-top:14px">De brug die nu draait stuurt nog geen ' +
        'gebeurtenissen-tellers mee. Werk hem bij om te zien waar een bericht sneuvelt.</div>';
    }
    const types = ['message', 'message_create', 'message_ack'];
    const naam = {
      message       : 'binnengekomen',
      message_create: 'zelf verstuurd',
      message_ack   : 'statusupdates',
    };
    let h = '<div class="tellerkop">Gebeurtenissen sinds de brug startte</div><table class="tellers">' +
      '<tr><th></th><th>gezien</th><th>door</th><th>genegeerd</th></tr>';
    for (const t of types) {
      const gen = (g.genegeerd && g.genegeerd[t]) || {};
      const redenen = Object.keys(gen).filter((r) => gen[r] > 0).map((r) => r + ': ' + gen[r]);
      h += '<tr><td>' + esc(naam[t]) + '</td>' +
        '<td>' + (g.gezien[t] || 0) + '</td>' +
        '<td>' + ((g.doorgelaten && g.doorgelaten[t]) || 0) + '</td>' +
        '<td>' + (redenen.length ? esc(redenen.join(', ')) : '—') + '</td></tr>';
    }
    h += '</table>';
    const acks = Object.keys(g.ack_codes || {}).sort();
    if (acks.length) {
      h += '<div class="ronde zacht">Ack-codes: ' +
        esc(acks.map((k) => k + '×' + g.ack_codes[k]).join(', ')) +
        ' &middot; 1 = verzonden, 2 = afgeleverd, 3/4 = gelezen. Alleen 0 of -1 betekent dat WhatsApp nog niets bevestigd heeft.</div>';
    }
    // De vorm van de identiteit bij wat afviel. 'c.us/11' is een gewoon
    // telefoonnummer; 'lid/15' betekent dat WhatsApp de tegenpartij als LID
    // aanlevert en niet als nummer — precies waar het filter dan op struikelt.
    const vormen = Object.keys(g.vormen || {}).sort();
    if (vormen.length) {
      h += '<div class="ronde zacht">Vorm van de identiteit bij het negeren: ' +
        esc(vormen.map((k) => k + '×' + g.vormen[k]).join(', ')) +
        ' &middot; domein/aantal cijfers. Staat er <b>lid</b> bij, dan levert WhatsApp de tegenpartij ' +
        'niet als telefoonnummer aan.</div>';
    }
    const opg = g.opgelost || {};
    const opgKeys = Object.keys(opg).filter((k) => opg[k] > 0);
    if (opgKeys.length) {
      h += '<div class="ronde zacht">Identiteit opgelost via: ' +
        esc(opgKeys.map((k) => k + '×' + opg[k]).join(', ')) +
        ' &middot; <b>jid</b> = stond er al als nummer, <b>lidkaart</b> = via de leadlijst vertaald, ' +
        '<b>contact</b> = door WhatsApp opgezocht.</div>';
    }
    // De lengte van wat eruit kwam. Elf cijfers is een telefoonnummer; vijftien
    // is opnieuw een LID, en dan meldde de teller succes terwijl er niets
    // vertaald was.
    const ovm = Object.keys(g.opgelost_vorm || {}).sort();
    if (ovm.length) {
      h += '<div class="ronde zacht">Lengte van het opgeloste nummer: ' +
        esc(ovm.map((k) => k + '×' + g.opgelost_vorm[k]).join(', ')) +
        ' &middot; weg/aantal cijfers. Staat er <b>/15</b>, dan kwam er opnieuw een LID uit ' +
        'in plaats van een telefoonnummer.</div>';
    }
    if (d.lidkaart) {
      h += '<div class="ronde zacht">LID-kaart uit de leadlijst: ' + (d.lidkaart.koppelingen || 0) +
        ' koppeling' + (d.lidkaart.koppelingen === 1 ? '' : 'en') +
        (d.lidkaart.laatste_opbouw ? ', laatst opgebouwd om ' + esc(uur(d.lidkaart.laatste_opbouw)) : ', nog niet opgebouwd') +
        (d.lidkaart.laatste_fout ? ' &middot; ' + esc(d.lidkaart.laatste_fout) : '') + '.</div>';
      // Langs welke weg het ophalen de chat vond. 'geen_kandidaten' betekent iets
      // heel anders dan 'niets_gevonden', en dat onderscheid maakte de vorige
      // meting onleesbaar.
      const hv = d.lidkaart.historiek_vormen || {};
      const hk = Object.keys(hv).sort();
      if (hk.length) {
        h += '<div class="ronde zacht">Historiek gevonden via: ' +
          esc(hk.map((x) => x + '×' + hv[x]).join(', ')) +
          ' &middot; <b>geen_kandidaten</b> = van dat nummer kennen we geen enkele vorm, ' +
          '<b>niets_gevonden</b> = wél gezocht, chat stond er niet.</div>';
      }
      // Drie verschillende antwoorden, en ze zagen er allemaal uit als 'null'.
      const lk = d.lidkaart;
      if (lk.chats_geprobeerd || typeof lk.chats_in_cache === 'number') {
        let zin;
        if (lk.chats_status === 'fout') {
          // De foutmelding zelf erbij. Dat is bibliotheektekst, geen gegeven
          // van iemand, en zonder die tekst is 'fout' opnieuw een stilte.
          zin = 'Gesprekkenlijst: opvragen <b>wierp een fout</b>' +
            (lk.chats_fout ? ' &mdash; <code>' + esc(lk.chats_fout) + '</code>' : ' zonder melding') +
            '. Dit is de meting waarop we het ophalen van historiek hebben opgegeven: ' +
            'de gebeurtenissen komen wél binnen, maar alles wat de interne opslag moet lézen faalt.';
        } else if (lk.chats_status && lk.chats_status !== 'gelukt') {
          zin = 'Gesprekkenlijst: opvragen gaf <b>' + esc(lk.chats_status) + '</b>. ' +
            'Dat is geen lege lijst maar een mislukte aanvraag.';
        } else if (lk.chats_in_cache === 0) {
          zin = 'Gesprekkenlijst: <b>leeg</b>. Dit gekoppelde apparaat heeft geen gesprekken ' +
            'gesynchroniseerd gekregen, dus er valt geen historiek op te halen.';
        } else if (typeof lk.chats_in_cache === 'number') {
          zin = 'Gesprekkenlijst: ' + lk.chats_in_cache + ' gesprekken in het geheugen';
        } else {
          zin = 'Gesprekkenlijst: nog niet opgevraagd.';
        }
        h += '<div class="ronde zacht">' + zin +
          (lk.chats_opgehaald ? ', opgehaald om ' + esc(uur(lk.chats_opgehaald))
            : lk.chats_geprobeerd ? ', laatst geprobeerd om ' + esc(uur(lk.chats_geprobeerd)) : '') +
          '.</div>';
      }
    }
    // Welke bibliotheek draait daar eigenlijk, en wat biedt die aan? Dit is het
    // gegeven dat drie ronden lang ontbrak: alle metingen waren gedaan tegen de
    // bron van 1.26.0, zonder te weten of dát draait.
    if (d.lid_kunde) {
      const k = d.lid_kunde;
      if (!k.onderzocht) {
        h += '<div class="ronde zacht">De brug heeft nog niet afgetast wat deze WhatsApp-versie aanbiedt.</div>';
      } else {
        h += '<div class="ronde zacht">Bibliotheek: <b>whatsapp-web.js ' + esc(k.bibliotheek || 'onbekend') +
          '</b> &middot; WhatsApp Web ' + esc(k.wweb || 'onbekend') + '.</div>';
        const gl = Object.keys(k.globals || {}).filter((x) => k.globals[x]);
        h += '<div class="ronde zacht">Globals in de pagina: ' + esc(gl.join(', ') || 'geen') +
          '. Ontbreekt <i>Store</i>, dan bewaart deze versie haar opslag ergens anders ' +
          'en werkt alleen de publieke API.</div>';
        const api = Object.keys(k.api || {}).filter((x) => k.api[x]);
        h += '<div class="ronde zacht">Publieke API: ' + esc(api.join(', ') || 'geen') + '.</div>';
        if (k.fout) h += '<div class="ronde zacht">Aftasten: ' + esc(k.fout) + '</div>';
      }
    }
    if (d.lid_bron) {
      const b = d.lid_bron;
      h += '<div class="ronde zacht">Koppelingen gevonden via: <b>' +
        esc(b.bron || 'geen enkele weg') + '</b>' +
        (b.scan ? ' &middot; ' + b.scan.koppelingen + ' van ' + b.scan.bekeken + ' nummers' : '') +
        '.</div>';
      // Per weg: geprobeerd, gelukt, beschikbaar. Dit is wat een stilte
      // onmogelijk maakt — 'bestaat niet' ziet er nu anders uit dan 'gaf niets'.
      const w = b.wegen || {};
      const rijen = Object.keys(w);
      if (rijen.length) {
        h += '<table class="tellers"><tr><th>weg</th><th>geprobeerd</th><th>gelukt</th><th>beschikbaar</th></tr>' +
          rijen.map((k) => {
            // De statussen erbij: 'geprobeerd 2, gelukt 0' zei niets over
            // waaróm het niet lukte, en dat was precies de vraag.
            const st = w[k].statussen || {};
            const uitleg = Object.keys(st).filter((x) => x !== 'gelukt' && st[x] > 0)
              .map((x) => x + '×' + st[x]).join(', ');
            return '<tr><td>' + esc(k) + '</td><td>' + (w[k].geprobeerd || 0) + '</td><td>' +
              (w[k].gelukt || 0) + '</td><td>' +
              (w[k].beschikbaar === null ? 'onbekend' : (w[k].beschikbaar ? 'ja' : 'nee')) +
              (uitleg ? ' &middot; ' + esc(uitleg) : '') + '</td></tr>';
          }).join('') + '</table>';
      }
      const bv = b.laatste_berichtvormen;
      if (bv && Object.keys(bv).length) {
        h += '<div class="ronde zacht">Velden op het laatste ruwe bericht: ' +
          esc(Object.keys(bv).sort().map((k) => k + '=' + bv[k]).join(', ')) +
          ' &middot; sleutelnaam en domein/lengte. Staat hier een veld met <b>c.us</b>, ' +
          'dan draagt WhatsApp het echte nummer gewoon mee.</div>';
      }
    }
    if (g.laatste_genegeerd) {
      h += '<div class="ronde zacht">Laatst genegeerd: ' + esc(g.laatste_genegeerd.type) +
        ' wegens ' + esc(g.laatste_genegeerd.reden) +
        (g.laatste_genegeerd.vorm ? ' (' + esc(g.laatste_genegeerd.vorm) + ')' : '') +
        ' om ' + esc(uur(g.laatste_genegeerd.tijd)) + '.</div>';
    }
    return '<div class="tellerblok">' + h + '</div>';
  }

  /**
   * De reden waarom nabellen niet nodig was, in een zin die over NABELLEN gaat.
   * De sleutels komen uit beoordeelNabel(); een onbekende reden gaat ongewijzigd
   * door, want stil vervallen is erger dan een ruwe tekst.
   */
  const NABEL_REDEN = {
    'geen spraakbericht': 'er ging nog geen spraakbericht',
    'heeft geantwoord'  : 'hij antwoordde zelf',
  };

  /** Een kaart die de 12u-instroom maakte: die gaat per definitie over de call van vandaag. */
  const isNabelKaart = (t) => !!t && t.reden === 'zoom_nabellen';

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
    //
    // EEN zoom_nabellen-KAART IS DIE CALL. Hij wordt om 12:00 gemaakt juist
    // omdat er een zoomcall van vandaag is waar niet op gereageerd is, en zijn
    // eigen notitie noemt het spraakbericht. Hem afhankelijk maken van een
    // tweede lezing (_calls, die van de agenda komt en er nog niet hoeft te
    // zijn) liet de vensters dan stil weg — op precies de kaart die erover gaat.
    if (!isNabelKaart(t) && !heeftCallOpDag(t, dag)) return '';
    const o = beoordeelDag(t, dag);
    const spraak = {
      op_tijd    : ['ok',   '&#127908; spraak ' + esc(o.spraak.tijd || '')],
      te_laat    : ['laat', '&#127908; spraak ' + esc(o.spraak.tijd || '') + ' &middot; na 09:00'],
      niet_gedaan: ['mist', '&#127908; geen spraakbericht'],
    }[o.spraak.staat];
    // DE NABEL-CHIP ZEGT IETS OVER NABELLEN. Hij toonde de kale REDEN waarom
    // nabellen niet nodig was, onder een telefoon-icoon: '☎ geen spraakbericht'.
    // Dat leest als een bewering over het spraakbericht, staat pal naast de
    // spraak-chip die hetzelfde al zegt, en op een zoom_nabellen-kaart stond
    // het zelfs naast een notitie die het spraakbericht van 07:16 noemde.
    const nabel = {
      op_tijd    : ['ok',   '&#9742; nagebeld ' + esc(o.nabel.tijd || '')],
      te_laat    : ['laat', '&#9742; nagebeld ' + esc(o.nabel.tijd || '') + ' &middot; buiten 12&ndash;13u'],
      niet_gedaan: ['mist', '&#9742; nog niet nagebeld'],
      niet_nodig : ['nvt',  '&#9742; nabellen niet nodig &middot; ' + esc(NABEL_REDEN[o.nabel.reden] || o.nabel.reden || 'niet nodig')],
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
   * Kan de brug oude berichten van het toestel ophalen, ja of nee?
   *
   * Geen aanname maar een meting. Ophalen loopt via de gesprekkenlijst van
   * whatsapp-web.js; die lijst kwam er op de VPS twee van de twee keer met een
   * uitzondering uit. De gebeurtenissen komen wél binnen — versturen en
   * ontvangen werken — maar alles wat de interne opslag moet lézen faalt. Dat
   * wijst op een versieverschil tussen de bibliotheek en de WhatsApp Web-build
   * die zij bestuurt; zie services/whatsapp-brug/README.md met de nummers erbij.
   *
   * Antwoordt alleen als het gemeten is. Geen meting → null, en dan blijft de
   * uitnodiging om het te proberen gewoon staan. Een 'kan niet' zonder meting
   * zou dezelfde stilte zijn als het probleem dat we net hebben opgelost.
   */
  function historiekOnbereikbaar() {
    const lk = _wa.data && _wa.data.lidkaart;
    if (!lk || lk.chats_status !== 'fout') return null;
    return { fout: lk.chats_fout || null };
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
    // geen_taken: er zijn wél calls, maar van geen enkele zijn de berichten
    // gemeten. Dat is sinds de webhook ook zonder kaart bewaart een ANDER
    // verhaal dan 'staat niet in de takenlijst': de kaart doet er voor het
    // spraakbericht niet meer toe, de meting wel. Meestal is dit een dag vóór
    // DEKKING_VANAF, of een agenda die de berichten niet kon meesturen.
    return kop + nogNietGemeten(wat,
      bron.calls + ' ingeplande call' + (bron.calls === 1 ? '' : 's') + ' op deze dag, maar de ' +
      'WhatsApp-berichten erbij zijn niet gemeten. Dat kan omdat het een dag van voor de ' +
      'koppeling is, of omdat ze niet gelezen konden worden.');
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
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) straks(() => fetchTaken(dag));

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
  // HET GESPREK
  // ═════════════════════════════════════════════════════════════════════════
  /** Ophalen. Fail-soft: een fout vult _gesprek.error en het paneel zegt wat er is. */
  async function fetchGesprek() {
    if (!_gesprek.open) return;
    const vraag = _gesprek.taakId
      ? 'taak_id=' + encodeURIComponent(_gesprek.taakId)
      : 'nummer=' + encodeURIComponent(_gesprek.nummer || '');
    _gesprek.laden = true;
    const j = await haal('/api/opvolging-whatsapp-gesprek?' + vraag);
    _gesprek.laden = false;
    if (j.__error) { _gesprek.error = j.__error; _gesprek.code = j.code || null; }
    else {
      _gesprek.error = null; _gesprek.code = null;
      _gesprek.berichten = j.berichten || [];
      if (j.nummer) _gesprek.nummer = j.nummer;
      if (j.naam && !_gesprek.naam) _gesprek.naam = j.naam;
      // Wat de server nu ook kent, hoeft hier niet meer los te staan. Matchen
      // op tekst én richting: het bericht-id kennen we hier nog niet.
      if (_gesprek.optimistisch.length) {
        _gesprek.optimistisch = _gesprek.optimistisch.filter((o) =>
          !(_gesprek.berichten || []).some((b) => b.richting === 'uit' && b.tekst === o.tekst));
      }
    }
    render();
  }

  /**
   * Kan er verstuurd worden?
   *
   * Een knop die stil niets doet is erger dan geen knop. Staat de brug eruit of
   * is hij niet gekoppeld, dan gaat het tekstveld op slot met de reden erbij.
   */
  function gesprekKanVersturen() {
    if (!_gesprek.nummer) return { mag: false, reden: 'Bij deze lead staat geen telefoonnummer.' };
    if (_wa.error) return { mag: false, reden: 'De WhatsApp-brug is nu niet bereikbaar, dus er kan niets verstuurd worden.' };
    if (!_wa.data) return { mag: false, reden: 'De status van de WhatsApp-brug is nog niet bekend.' };
    if (!_wa.data.verbonden) return { mag: false, reden: 'De WhatsApp-brug is niet gekoppeld. Koppel hem via het lampje rechtsboven.' };
    return { mag: true, reden: null };
  }

  /** Eén bubbel. Inkomend links, uitgaand rechts, met het tijdstip erbij. */
  function gesprekBubbel(b, bezig) {
    const uit = b.richting === 'uit';
    const media = b.media_type && String(b.media_type).toLowerCase();
    const isSpraak = media === 'ptt' || media === 'audio' || media === 'voice';
    const isAnders = media && media !== 'chat' && !isSpraak;
    const inhoud = b.tekst
      ? esc(b.tekst)
      : isSpraak ? '<i>&#127908; spraakbericht</i>'
      : isAnders ? '<i>&#128206; ' + esc(media) + '</i>'
      : '<i>(leeg bericht)</i>';
    return '<div class="wbrij ' + (uit ? 'uit' : 'in') + '">' +
      '<div class="wbub' + (bezig ? ' bezig' : '') + '">' +
      (isSpraak && b.tekst ? '<span class="wsp">&#127908;</span> ' : '') + inhoud +
      '<span class="wtijd">' + (bezig ? 'versturen&hellip;' : esc(uur(b.tijdstip))) + '</span>' +
      '</div></div>';
  }

  /**
   * Wat de laatste ophaalronde opleverde, boven de draad.
   *
   * Blijft staan tot het paneel dicht gaat. Dat is de bedoeling: het is de zin
   * die vertelt tot wanneer er gekeken is, en die hoort niet weg te vallen
   * zodra je één keer scrollt.
   */
  function historiekMelding() {
    if (!_gesprek.melding) return '';
    const k = _gesprek.meldingSoort === 'fout' ? 'warn2'
      : _gesprek.meldingSoort === 'leeg' ? 'nietgemeten' : 'ronde zacht';
    return '<div class="' + k + '" style="margin-bottom:10px">' + esc(_gesprek.melding) + '</div>';
  }

  /**
   * Het gesprekspaneel. Zelfde vorm als het koppelpaneel: scrim met `on`,
   * van rechts inschuivend, alles onder .opv.
   */
  function gesprekPaneelHtml() {
    if (!_gesprek.open) return '';
    const kan = gesprekKanVersturen();
    const waNummer = String(_gesprek.nummer || '').replace(/\D/g, '');

    let body;
    if (_gesprek.error) {
      const uitleg = _gesprek.code === 'TABEL_ONTBREEKT'
        ? 'De berichtentabel bestaat nog niet — de migratie moet nog draaien.'
        : _gesprek.error;
      body = '<div class="warn2"><b>Het gesprek is nu niet op te halen.</b><br>' + esc(uitleg) + '</div>';
    } else if (!_gesprek.berichten) {
      body = '<div class="empty">Gesprek laden&hellip;</div>';
    } else {
      const rijen = _gesprek.berichten.map((b) => gesprekBubbel(b, false)).join('') +
        _gesprek.optimistisch.map((b) => gesprekBubbel(b, true)).join('');
      // Staat er al iets, dan hoort de knop bovenaan de draad — dat is waar je
      // hem zoekt als je verder terug wilt. Is het gesprek leeg, dan staat hij
      // in het lege blok hieronder, want daar kijk je dan naar.
      const onbereikbaar = historiekOnbereikbaar();
      const ouderKnop = !rijen ? ''
        : onbereikbaar
          ? '<div class="wouder"><span class="wreden">Ouder ophalen kan niet met deze brug &mdash; ' +
            'zie de uitleg onderaan.</span></div>'
          : '<div class="wouder"><button class="obtn" onclick="window.__opvGesprekHistoriek()"' +
            (_gesprek.haalt ? ' disabled' : '') + '>' +
            (_gesprek.haalt ? 'Bezig&hellip;' : '&#8593; Ouder ophalen') + '</button></div>';
      // Een leeg gesprek is hier niet hetzelfde als 'er is niets gezegd'. Van
      // vóór dit paneel bestaat er geen historiek: uitgaande tekst verliet de
      // telefoon toen niet, en van inkomende staat alleen een afgekapte kopie
      // in de pogingen. Dat hoort er te staan, anders leest een leeg scherm als
      // een stilte die er nooit was.
      body = historiekMelding() + (rijen
        ? ouderKnop + '<div class="wchat">' + rijen + '</div>'
        : (onbereikbaar
          ? '<div class="nietgemeten"><b>Nog geen berichten in het systeem, en ophalen kan niet.</b><br>' +
            'Vanaf de koppeling is dit gesprek volledig: alles wat sindsdien heen en weer gaat komt hier ' +
            'binnen. Wat er d&aacute;&aacute;rvoor gezegd is, staat alleen op Daves telefoon en blijft daar. ' +
            'De brug kan de gesprekkenlijst van het toestel niet lezen &mdash; gemeten, niet aangenomen: ' +
            'de aanvraag wierp een fout' +
            (onbereikbaar.fout ? ' (<code>' + esc(onbereikbaar.fout) + '</code>)' : '') + '. ' +
            'Versturen en ontvangen werken w&eacute;l; alleen het uitlezen van de oude opslag niet.' +
            '<div style="margin-top:8px;color:#6b7280">Achtergrond en versienummers staan in ' +
            'services/whatsapp-brug/README.md.</div></div>'
          : '<div class="nietgemeten"><b>Nog geen berichten in het systeem.</b><br>' +
            'De brug bewaarde tot nu toe niets, dus wat er eerder gezegd is staat hier nog niet. ' +
            'Op het gekoppelde toestel staat het misschien w&eacute;l &mdash; dat kun je hieronder ophalen.' +
            '<div style="margin-top:12px"><button class="obtn p" onclick="window.__opvGesprekHistoriek()"' +
            (_gesprek.haalt ? ' disabled' : '') + '>' +
            (_gesprek.haalt ? 'Bezig&hellip;' : '&#8615; Historiek ophalen') + '</button></div>' +
            '<div style="margin-top:8px;color:#6b7280">WhatsApp synct maar een beperkt venster naar een gekoppeld apparaat, ' +
            'dus wat terugkomt kan minder zijn dan wat op Daves telefoon staat.</div></div>'));
    }

    const invoer = kan.mag
      ? '<div class="winvoer">' +
        // Geen waarde in de HTML: het concept wordt na het tekenen in de
        // textarea gezet (zie herstelConcept). Zo verandert typen de
        // vingerafdruk niet — en hoeft de tekst nergens ontsnapt te worden,
        // wat bij een </textarea> in een bericht anders misgaat.
        '<textarea id="opv-wa-tekst" rows="2" placeholder="Typ een bericht&hellip;"' +
        ' oninput="window.__opvGesprekTyp(this.value)"' +
        (_gesprek.verzendt ? ' disabled' : '') + '></textarea>' +
        '<button class="obtn p" onclick="window.__opvGesprekStuur()"' +
        (_gesprek.verzendt ? ' disabled' : '') + '>' +
        (_gesprek.verzendt ? 'Bezig&hellip;' : 'Versturen') + '</button></div>'
      : '<div class="winvoer uit">' +
        '<textarea rows="2" disabled placeholder="Versturen kan nu niet"></textarea>' +
        '<div class="wreden">' + esc(kan.reden) + '</div></div>';

    // 'on' is verplicht: de globale .scrim staat op opacity:0 met
    // pointer-events:none, en alleen .scrim.on is zichtbaar. Die les kostte
    // eerder een testronde. 'rechts' maakt er een vel van dat inschuift.
    // SLUITEN OP DE ACHTERGROND VRAAGT TWEE DINGEN. Eerst stond hier alleen
    // een mousedown-check, en dat is precies de bug die Dave voelde: raakte een
    // klik tussen mousedown en mouseup zijn element kwijt door een hertekening,
    // dan landde de mouseup op de scrim en ging het paneel dicht midden in wat
    // hij aan het doen was. Nu moeten mousedown én mouseup allebei op de scrim
    // zelf gebeuren; een klik die binnen het paneel begint of eindigt sluit
    // nooit meer.
    return '<div class="opv"><div class="scrim on rechts"' +
      ' onmousedown="window.__opvScrimNeer(event)"' +
      ' onmouseup="window.__opvScrimOp(event, \'gesprek\')">' +
      '<div class="wpaneel">' +
      '<div class="mh"><div>' +   // zelfde kop-opmaak als het koppelpaneel
        '<h3>' + esc(_gesprek.naam || 'WhatsApp') + '</h3>' +
        '<p>' + esc(toonNummer(_gesprek.nummer) || 'geen nummer') + '</p>' +
      '</div><button class="x" onclick="window.__opvGesprekSluit()">&times;</button></div>' +
      '<div class="wbody">' + body + '</div>' +
      invoer +
      // Blijft staan, ook als alles werkt: ligt de brug eruit, dan is dit de
      // weg die er altijd al was. Geen noodoplossing maar een uitgang.
      (waNummer
        ? '<div class="wvoet"><a href="https://wa.me/' + esc(waNummer) + '" target="_blank" rel="noopener">Open in WhatsApp &rarr;</a></div>'
        : '') +
      '</div></div></div>';
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
  // Eén implementatie, in _opvolging-badge.js. De naam blijft hier staan zodat elke
  // bestaande aanroeper en test blijft werken, maar de regel zelf staat nog maar
  // op één plek — dat was de hele klacht.
  function kortePlaats(location) {
    return H.opvKortePlaats(location);
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

  /**
   * Is er echt contact geweest?
   *
   * Zelfde regel als isContact() in api/_lib/opvolging-poging-telling.js. Een
   * browser-view kan daar niet uit importeren, dus dit is een kopie — en
   * tests/opvolging-pogingen-tellen.test.js legt de twee naast elkaar op een
   * tabel gevallen, zodat ze niet uit elkaar kunnen lopen.
   *
   * De richting komt uit de kolom, niet uit de tekst van `resultaat`. Alleen of
   * een gesprek tot stand kwam staat nog in die tekst: daar is geen kolom voor,
   * en de waarde wordt op één plek geschreven (bouwCallPoging).
   */
  function echtContact(p) {
    if (!p) return false;
    if (p.soort === 'whatsapp' || p.soort === 'spraakbericht') return !uitgaand(p);
    if (p.soort === 'call') return /gesproken/.test(String(p.resultaat || '').toLowerCase());
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
   * IN WELKE RONDE ZIT DEZE KAART? — tweeling van bepaalRonde() in
   * api/_lib/opvolging-aanmelding.js. Een browser-view kan daar niet uit
   * importeren; tests/opvolging-ronde-tweeling.test.js houdt de twee gelijk.
   *
   * Het scherm zei dit nergens, en daardoor werd de kaart verkeerd gelezen:
   * 'Bevestigd' lijkt de kaart te laten verdwijnen, terwijl de code hem
   * doorschuift naar event min vier. De knop deed al het goede; alleen was dat
   * onzichtbaar. Dit etiket zegt wat de code al doet — het verandert niets aan
   * het gedrag.
   */
  const WAKKER_DAGEN_VOOR_EVENT = 4;

  function bepaalRonde(eventDag, nuDag) {
    if (!eventDag || !nuDag) return null;
    const ms = Date.parse(eventDag + 'T12:00:00Z');
    if (!Number.isFinite(ms)) return null;
    const wakker = new Date(ms - WAKKER_DAGEN_VOOR_EVENT * 86400000).toISOString().slice(0, 10);
    if (nuDag >= wakker) {
      return { ronde: 'B', label: 'Bevestigingsronde',
        uitleg: 'Komt hij echt? Dit is de laatste ronde voor het event.',
        laatste: true, terug_op: null };
    }
    return { ronde: 'A', label: 'Opwarmronde',
      uitleg: 'Check of de inschrijving gelukt is en of alles duidelijk is.',
      laatste: false, terug_op: wakker };
  }

  /** Het strookje bovenaan de aanmeldkaart. Geen eventdag = geen etiket. */
  function rondeStrook(t, nuDag) {
    const r = bepaalRonde(evVan(t).event_dag || null, nuDag);
    if (!r) return '';
    return '<div class="rnd r' + r.ronde + '">' +
      '<b>' + esc(r.label) + '</b>' +
      '<span>' + esc(r.uitleg) + '</span>' +
      (r.terug_op
        ? '<span class="terug">Na &#8220;Bevestigd&#8221; komt deze kaart terug op ' + esc(nl(r.terug_op)) + '.</span>'
        : '<span class="terug">Na &#8220;Bevestigd&#8221; is deze kaart klaar.</span>') +
      '</div>';
  }


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

  /**
   * Wat er op één dagtegel komt te staan. Twee verschillende getallen, en dat
   * is met opzet.
   *
   * Een taak die blijft liggen houdt zijn oude `due`, en de dagweergave van
   * vandaag haalt daarom alles op met due <= vandaag. 'Open op dinsdag' is voor
   * een dinsdag in het verleden dus geen zinnig getal: die taak staat inmiddels
   * onder vandaag. Wat wél vaststaat over een voorbije dag is wat er die dag
   * geregistreerd is.
   *
   *   verleden → aantal acties  ('gedaan')
   *   vandaag / toekomst → aantal open taken ('open')
   *
   * Nog niets binnen → een punt, geen nul. Een nul leest als een meting.
   */
  function tegelGetal(d, nu) {
    const st = _live.balk;
    const rij = st.data && (st.data.dagen || []).find((x) => x.dag === d);
    const verleden = d < nu;
    if (!rij) return { getal: '·', label: verleden ? ' gedaan' : ' open', gemeten: false };
    const waarde = verleden ? rij.acties : rij.open;
    if (waarde === null || waarde === undefined) {
      return { getal: '·', label: verleden ? ' gedaan' : ' open', gemeten: false };
    }
    return { getal: String(waarde), label: verleden ? ' gedaan' : ' open', gemeten: true };
  }

  /**
   * De balk zelf. Haalt de losse eindjes op en laat bepaalNuDoen beslissen;
   * hier staat alleen hoe het eruitziet.
   */
  function nuDoenBalk(dag) {
    const bron = vensterBron(dag);
    const st = _live.taken;
    const advies = bepaalNuDoen({
      dag,
      nu      : vandaag(),
      minuut  : nuMinuut(),
      brugZiet: brugZietUitgaand(),
      calls   : (_calls.key === dag && _calls.data) ? _calls.data : [],
      callsStaat  : bron.staat,
      vensterTaken: bron.staat === 'ok' ? bron.taken : [],
      // Precies het getal dat eronder in de lijst staat, niet een eigen telling.
      openTaken: (st.data && st.key === dag) ? (st.data.taken || []).length : 0,
      // Idem: precies de rijen die in het achterstandsblok staan.
      achterstand: (_calls.key === dag) ? (_calls.achterstand || []).length : 0,
    });
    return '<div class="nudoen' + (advies.telaat ? ' laat' : '') + '">' +
      '<div class="nuic">' + (advies.telaat ? '&#9888;' : '&#9202;') + '</div>' +
      '<div class="nutxt"><b>' + esc(advies.titel) + '</b>' +
      '<span>' + esc(advies.uitleg) + '</span></div>' +
      (advies.deadline ? '<div class="nudl">' + esc(advies.deadline) + '</div>' : '') +
      '</div>';
  }

  function weekbalk(dag) {
    const nu = vandaag();
    const wk = bepaalWeek({ nu, offset: _ui.weekOffset });
    const terug = _ui.weekOffset > WEEK_MIN_OFFSET;
    const heen  = _ui.weekOffset < WEEK_MAX_OFFSET;
    const laatste = wk.dagen[wk.dagen.length - 1];
    straks(() => fetchBalk(wk.dagen[0], laatste));

    let knoppen = '<div class="wk">';
    wk.dagen.forEach((d, i) => {
      const aan = d === dag;
      const verleden = d < nu;
      const g = tegelGetal(d, nu);
      // Een voorbije dag opent de tijdlijn: daar staat wat er gebeurd is, en
      // dat is het enige wat over die dag vaststaat. De takenlijst van die dag
      // blijft bereikbaar vanuit dat venster.
      const klik = verleden ? "window.__opvTijdlijn('" + d + "')" : "window.__opvDag('" + d + "')";
      knoppen += '<button class="wkd ' + (aan ? 'on' : '') + ' ' + (d === nu ? 'nu' : '') + ' ' + (verleden ? 'oud' : '') + '"' +
        ' onclick="' + klik + '">' +
        '<span class="l"><span class="d">' + WEEKDAG_LABELS[i] + ' ' + nl(d) + '</span>' +
          (d === nu ? ' <span class="vd">vandaag</span>' : '') + '</span>' +
        '<span class="c">' + g.getal + '<small>' + g.label + '</small></span></button>';
    });
    // De zevende tegel. Hij bestaat omdat de balk zes dagen laat zien terwijl
    // er dertig aanmeldtaken stonden: de andere twintig waren niet weg, alleen
    // onbereikbaar. Dit is de enige plek waar je ze ziet zonder te weten dat je
    // moet doorklikken.
    const later = _live.balk.data && _live.balk.data.later;
    knoppen += '<button class="wkd later" onclick="window.__opvLater()" ' +
      'title="Alles met een datum na ' + esc(nl(laatste)) + '">' +
      '<span class="l"><span class="d">Later</span></span>' +
      '<span class="c">' + (later ? String(later.aantal) : '·') + '<small> wacht</small></span></button>';
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
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) straks(() => fetchTaken(dag));

    let h = '<div class="opv">';
    // Kop: de bestaande uitleg links, het brug-lampje rechts. Het lampje is
    // tegelijk het levensteken waaraan de timers zien of deze view nog in beeld
    // is — zie herstelWaTimers().
    h += '<div class="kop">' +
      '<div class="info">De spraakberichten en het nabelvenster hangen aan de WhatsApp-brug. ' +
      'Ziet die brug nog geen uitgaande berichten, dan blijven die blokken leeg met uitleg &mdash; ' +
      'nooit met een nul die eruitziet alsof er gemeten is.</div>' +
      '<button class="obtn p leadknop" onclick="window.__opvLeadNieuw()">+ Lead toevoegen</button>' +
      waLamp() + '</div>';
    // De balk staat boven de weekbalk: wat er nú aan de beurt is hoort het
    // eerste te zijn wat je ziet, niet iets waar je langs moet scrollen.
    h += nuDoenBalk(dag);
    h += weekbalk(dag);
    // Boven de takenlijst: eerst wat er vaststaat vandaag, dan wat je zelf
    // moet oppakken. De agenda hangt niet aan de takenlijst — valt hij weg,
    // dan toont dit blok een melding en gaat de rest gewoon door.
    // Wat blijft liggen gaat vóór wat er nog aan komt.
    h += achterstandBlok();
    h += callsBlok(dag);

    if (st.error) return h + fout(st.error, 'window.__opvHerlaad()') + '</div>' + modalHtml() + waPaneelHtml() + gesprekPaneelHtml();
    if (st.loading || !st.data) return h + skel() + '</div>' + modalHtml() + waPaneelHtml() + gesprekPaneelHtml();

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
          (badgeTekst(w) ? ' <span class="tag t-grey">' + esc(badgeTekst(w)) + '</span>' : '') + '</div>' +
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

    return h + '</div>' + modalHtml() + waPaneelHtml() + gesprekPaneelHtml();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // VIEW · DASHBOARD
  // ═════════════════════════════════════════════════════════════════════════
  function dashboardView() {
    stijl();
    const dag = vandaag();
    const st = _live.dash;
    if (!st.loading && !st.error && (!st.data || st.key !== dag)) straks(() => fetchDash(dag));

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
          // Heeft de lead tijdens de call zelf nee gezegd, dan is 'is er
          // genoeg moeite gedaan' geen zinnige vraag. Zonder deze uitzondering
          // krijgt zo'n kaart een rood 'te weinig' — een verwijt voor iets
          // waar niets aan te doen viel, en precies het soort onterechte
          // beschuldiging dat we met deze wijziging willen voorkomen.
          const nvt = a.reden_code === 'zoom_geen_interesse';
          const ok = a.bel_dagen >= ARCHIEF_MIN_DAGEN && a.wa_totaal >= ARCHIEF_MIN_WA;
          const oordeel = nvt
            ? '<span class="tag t-grey" title="de lead zei tijdens de call zelf nee">n.v.t.</span>'
            : (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig pogingen</span>');
          return '<tr><td><b>' + esc(a.naam) + '</b></td><td style="color:#6b7280">' + esc(a.archief_reden || '') + '</td>' +
            '<td>' + a.bel_totaal + '&times; gebeld op ' + a.bel_dagen + ' dag' + (a.bel_dagen === 1 ? '' : 'en') + ' &middot; ' + a.wa_totaal + '&times; WhatsApp ' +
            oordeel + '</td></tr>';
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
    if (!st.loading && !st.error && !st.data) straks(fetchArchief);

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
        (ok ? '<span class="tag t-green">ok</span>' : '<span class="tag t-red">te weinig pogingen</span>') + '</td>' +
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
  // G1 heeft er twee bij: de tijdlijn van een voorbije dag en de lijst met wat
  // later staat. Allebei gaan ze over een dag of over een verzameling, niet
  // over één taak — dus horen ze hier, vóór de taak-guard in modalHtml().
  //
  // G2 heeft er nog een: '+ Lead toevoegen' máákt de taak en heeft er dus nog
  // geen. Zonder die regel sneuvelt dat venster stil op de taak-guard, precies
  // zoals de vier call-uitkomsten dat deden.
  // 'call-verzet' hoort hier óók: een zoomcall heeft meestal GEEN taak — de
  // lead boekte zelf en kwam nooit in de werklijst. Vergeten we dat, dan
  // sneuvelt dit venster stil op de taak-guard in modalHtml(), precies zoals
  // de vier call-uitkomsten dat ooit deden.
  const MODAL_ZONDER_TAAK = new Set(['call-afrond', 'call-uitkomst', 'call-verzet', 'tijdlijn', 'later', 'lead-nieuw']);
  const MODAL_BALK = new Set(['tijdlijn', 'later']);

  /**
   * De vier uitkomsten van een zoomcall. Hangt aan de agenda, niet aan een taak.
   *
   * De call kan best iemand zijn die nog nergens in de takenlijst staat — dat
   * is juist het normale geval bij een eerste gesprek. Vandaar dat dit venster
   * vóór de taak-guard in modalHtml() wordt afgehandeld.
   */
  // ═════════════════════════════════════════════════════════════════════════
  // G1 · DE TWEE VENSTERS ONDER DE WEEKBALK
  // ═════════════════════════════════════════════════════════════════════════

  const POGING_LABEL = {
    call               : ['&#9742;', 'Gebeld'],
    whatsapp           : ['&#128172;', 'WhatsApp'],
    spraakbericht      : ['&#127908;', 'Spraakbericht'],
    agenda_doorgestuurd: ['&#128197;', 'Agenda doorgestuurd'],
    ingepland          : ['&#10003;', 'Ingepland'],
  };

  /** 'ma 1 september' — voor de kop van een venster, waar ruimte genoeg is. */
  function langeDatum(d) {
    if (!d) return '';
    return new Intl.DateTimeFormat('nl-NL', {
      timeZone: 'Europe/Amsterdam', weekday: 'short', day: 'numeric', month: 'long',
    }).format(new Date(d + 'T12:00:00Z'));
  }

  /**
   * De tijdlijn van een voorbije dag: wat er die dag daadwerkelijk gebeurd is.
   *
   * Waarom dit niet gewoon de takenlijst van die dag is: een taak die bleef
   * liggen houdt zijn oude datum en staat inmiddels onder vandaag. De lijst van
   * een voorbije dag zou dus half leeg zijn en de andere helft op de verkeerde
   * plek tonen. Wat er wél vaststaat, is wat er geregistreerd is.
   */
  function tijdlijnBody(dag) {
    const st = _live.tijdlijn;
    if (st.error) return fout(st.error, "window.__opvTijdlijn('" + dag + "')");
    if (st.loading || !st.data || st.key !== dag) return skel();
    const items = st.data.items || [];
    const naar = '<div class="tlvoet"><button class="obtn" onclick="window.__opvDagVanuitTijdlijn(\'' + dag +
      '\')">Toon de takenlijst van deze dag</button></div>';
    if (!items.length) {
      return '<div class="nietgemeten"><b>Op deze dag is niets geregistreerd.</b><br>' +
        'Geen belpoging, geen WhatsApp, geen doorgestuurde agenda. Dat betekent niet per se dat ' +
        'er niets gebeurd is &mdash; alleen dat er niets is vastgelegd.</div>' + naar;
    }
    const rijen = items.map((it) => {
      const l = POGING_LABEL[it.soort] || ['&#8226;', it.soort];
      const naam = it.taak ? esc(it.taak.naam) : '<i>taak niet meer gevonden</i>';
      return '<div class="tlrij">' +
        '<div class="tltijd">' + esc(uur(it.tijdstip)) + '</div>' +
        '<div class="tlem">' + l[0] + '</div>' +
        '<div class="tlwat"><b>' + l[1] + '</b> &middot; ' + naam +
          (it.taak && badgeTekst(it.taak) ? ' <span class="tag t-grey">' + esc(badgeTekst(it.taak)) + '</span>' : '') +
          (it.resultaat ? '<div class="tlres">' + esc(it.resultaat) + '</div>' : '') +
          (it.automatisch ? '<div class="tlres">automatisch geregistreerd</div>' : '') +
        '</div></div>';
    }).join('');
    return '<div class="tl">' + rijen + '</div>' + naar;
  }

  /**
   * Alles wat verder ligt dan de balk toont.
   *
   * De aanleiding: er stonden dertig aanmeldtaken en er waren er tien te zien.
   * De andere twintig waren niet weg, alleen onbereikbaar zonder te weten dat
   * je moest doorklikken.
   */
  function laterBody(na) {
    const st = _live.later;
    if (st.error) return fout(st.error, 'window.__opvLater()');
    if (st.loading || !st.data || st.key !== na) return skel();
    const dagen = st.data.dagen || [];
    if (!dagen.length) {
      return '<div class="empty">Er staat niets ingepland na ' + esc(nl(na)) + '.</div>';
    }
    const afgekapt = st.data.afgekapt
      ? '<div class="warn2">Er zijn er meer dan hier passen; dit zijn de eerste ' +
        st.data.aantal + '. Zoek de rest via de weekbalk.</div>'
      : '';
    const blokken = dagen.map((g) => {
      const rijen = (g.taken || []).map((t) => {
        const r = REDEN_LABEL[t.reden] || [t.reden, 't-grey'];
        // De naam eerst en met de ruimte die overblijft: die is het
        // belangrijkste op de regel en mag nooit als eerste wegvallen. Het
        // etiket krijgt een eigen maximum en kapt zichzelf af.
        const badge = badgeTekst(t);
        return '<button class="ltrij" onclick="window.__opvDagVanuitLater(\'' + g.dag + '\')">' +
          '<span class="ltnm">' + esc(t.naam) + '</span>' +
          '<span class="tag ' + r[1] + '">' + esc(r[0]) + '</span>' +
          (badge ? '<span class="tag t-grey ltev" title="' + esc(badge) + '">' + esc(badge) + '</span>' : '') +
          '</button>';
      }).join('');
      return '<div class="ltgroep"><div class="ltkop">' + esc(langeDatum(g.dag)) +
        ' <small>' + (g.taken || []).length + '</small></div>' + rijen + '</div>';
    }).join('');
    return afgekapt + '<div class="lt">' + blokken + '</div>';
  }

  function balkModalHtml(m) {
    if (m.soort === 'tijdlijn') {
      return scrim('Wat er gebeurd is op ' + esc(langeDatum(m.dag)),
        'Alleen wat er die dag is vastgelegd. Taken die zijn blijven liggen staan onder vandaag.',
        tijdlijnBody(m.dag));
    }
    // 'later'
    const st = _live.later;
    const aantal = st.data && st.key === m.na ? st.data.aantal : null;
    return scrim('Later dan deze week',
      aantal === null
        ? 'Alles met een datum na ' + esc(nl(m.na)) + '.'
        : aantal + ' ta' + (aantal === 1 ? 'ak' : 'ken') + ' met een datum na ' + esc(nl(m.na)) + '.',
      laterBody(m.na));
  }

  // ═════════════════════════════════════════════════════════════════════════
  // G2 · EEN LEAD MET DE HAND TOEVOEGEN
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Tot nu toe kwamen kaarten alleen uit een event of uit het afronden van een
  // call. Iemand die Dave op een andere manier tegenkomt — via via, een bericht
  // buiten de trechter om — had geen weg naar binnen.
  //
  // De reden komt uit de CHECK-constraint op opvolging_taken.reden, met één
  // uitzondering: 'aanmelding' staat er wél in maar hoort hier niet. Die reden
  // is instroom uit de eventmodule; met de hand gezet zou de kaart in het
  // aanmeldblok belanden zonder event erachter, en dan klopt de groepskop niet.

  const LEAD_REDENEN = [
    ['wil_nog_beslissen', 'Wil nog beslissen', 'Gesproken, twijfelt nog. Schrijf op waarover.'],
    ['no_show_call',      'No-show call',      'Stond ingepland voor een call en kwam niet opdagen.'],
    ['no_show_event',     'No-show event',     'Had zich aangemeld voor een event en kwam niet.'],
    ['afgemeld',          'Afgemeld',          'Heeft zelf afgezegd, maar is het bellen waard.'],
    ['niet_ingepland',    'Niet ingepland',    'Wil wel, maar er staat nog geen moment.'],
  ];
  const LEAD_REDEN_KEYS = LEAD_REDENEN.map((r) => r[0]);

  /**
   * Het formulier. Bewust vier velden en niet meer: naam, nummer, reden, dag —
   * plus de notitie, die verplicht is.
   *
   * Waarom de notitie verplicht is: bij een handmatige lead is dit het enige
   * wat er staat. Er ging geen call aan vooraf en er hangt geen event achter.
   * Zonder die zin is de kaart een naam en een nummer, en weet Dave over drie
   * weken niet meer waar dit vandaan kwam.
   *
   * De controles staan óók op de server (api/opvolging-taak-create.js), zodat
   * een oud tabblad ze niet kan omzeilen. Wat hier staat is er om het meteen te
   * kunnen zien, niet om het af te dwingen.
   */
  function leadModalHtml(m) {
    const f = m.velden || {};
    const melding = m.fout
      ? '<div class="warn"><b>Nog niet opgeslagen.</b> ' + esc(m.fout) + '</div>'
      : '';
    const opties = LEAD_REDENEN.map(([key, label]) =>
      '<option value="' + key + '"' + (f.reden === key ? ' selected' : '') + '>' + label + '</option>').join('');
    const gekozen = LEAD_REDENEN.find((r) => r[0] === (f.reden || LEAD_REDEN_KEYS[0]));
    const body = melding +
      '<div class="lf">' +
        '<label>Naam</label>' +
        '<input type="text" id="opv-lead-naam" value="' + esc(f.naam || '') + '" placeholder="Voor- en achternaam">' +
        '<label>Telefoon</label>' +
        '<input type="text" id="opv-lead-tel" value="' + esc(f.telefoon || '') + '" placeholder="+32470123456">' +
        '<div class="lfhint">Zonder nummer kan deze kaart niets: bellen en WhatsApp hangen er allebei aan.</div>' +
        '<label>Reden</label>' +
        '<select id="opv-lead-reden" onchange="window.__opvLeadVeld()">' + opties + '</select>' +
        '<div class="lfhint">' + esc(gekozen ? gekozen[2] : '') + '</div>' +
        '<label>Op welke dag terugzetten</label>' +
        '<input type="date" id="opv-lead-due" value="' + esc(f.due || vandaag()) + '" min="' + vandaag() + '">' +
        '<label>Notitie <small>(verplicht)</small></label>' +
        '<textarea id="opv-lead-notitie" rows="3" placeholder="Waar komt deze lead vandaan, en wat is er al gezegd?">' +
          esc(f.notitie || '') + '</textarea>' +
      '</div>' +
      '<button class="obtn p" style="width:100%;margin-top:14px" ' +
        (m.bezig ? 'disabled' : '') + ' onclick="window.__opvLeadOpslaan()">' +
        (m.bezig ? 'Bezig&hellip;' : 'Lead toevoegen') + '</button>';
    return scrim('Lead toevoegen', 'Hij staat daarna gewoon in je lijst, net als de rest.', body);
  }

  function callModalHtml(m) {
    const c = callOp(m.callIndex);
    if (!c) return '';
    if (m.soort === 'call-afrond') {
      const b =
        opt('&#127881;', 'var(--o-grns)', 'Klant geworden', 'Klaar. Er komt geen taak bij.', "window.__opvCallUitkomst('klant_geworden')") +
        opt('&#129300;', 'var(--o-ambs)', 'Wil nog beslissen', 'Kies een dag en schrijf op waar hij over twijfelt.', "window.__opvCallUitkomst('wil_nog_beslissen')") +
        opt('&#128683;', 'var(--o-reds)', 'No-show', 'Kwam niet opdagen. Staat vandaag meteen terug in je lijst.', "window.__opvCallUitkomst('no_show')") +
        opt('&#128533;', '#f0f1f4', 'Geen interesse', 'Schrijf op waarom. Er komt geen taak bij.', "window.__opvCallUitkomst('geen_interesse')") +
        // DE VIJFDE IS GEEN UITKOMST. De andere vier zeggen iets over een
        // gesprek dat geweest is; deze zegt dat het gesprek nog moet komen.
        // Daarom een eigen venster en geen __opvCallUitkomst: er wordt niets
        // beoordeeld, er wordt verplaatst.
        opt('&#128197;', 'var(--o-accs)', 'Opnieuw inplannen',
          'Hij belde om te verzetten. Kies samen een nieuw moment.',
          'window.__opvCallVerzet()');
      return scrim('Call met ' + esc(c.naam) + ' afronden', 'Wat is er uit dit gesprek gekomen?', b);
    }

    // ── OPNIEUW INPLANNEN ────────────────────────────────────────────────
    // Alleen de agenda. De handmatige datumkeuze die onder het werklijst-
    // venster staat hoort hier NIET: een zoomcall heeft een uur nodig, en een
    // kale datum levert een afspraak op waar geen moment bij hoort.
    if (m.soort === 'call-verzet') {
      if (!c.appointment_id) {
        return scrim('Opnieuw inplannen', esc(c.naam) + ' &middot; ' + esc(c.tijd),
          '<div class="warn2"><b>Deze call heeft geen afspraak-id.</b> Er is dus niets om te verzetten. ' +
          'Plan hem in vanuit je werklijst, dan hangt de nieuwe afspraak wél ergens aan.</div>');
      }
      const uitleg =
        '<div class="info">De call van <b>' + esc(c.tijd) + '</b> verhuist naar het moment dat je kiest. ' +
        'De oude afspraak blijft als <b>verzet</b> op zijn eigen dag staan en wordt <b>niet</b> beoordeeld: ' +
        'geen no-show, geen kaart in je werklijst.</div>';
      return scrim('Opnieuw inplannen met ' + esc(c.naam),
        'Kies een nieuw moment in de agenda.',
        uitleg + agendaBlok({ handmatig: false }));
    }

    const u = m.uitkomst;
    if (u === 'klant_geworden') {
      // De knop SCHRIJFT. Hij riep __opvSluit aan en deed dus letterlijk niets,
      // terwijl de tekst beloofde dat de administratie elders liep — precies de
      // sale die in het rapport zou ontbreken.
      return scrim('Klant geworden', esc(c.naam) + ' &middot; ' + esc(c.tijd),
        '<div class="info">Mooi. Er komt <b>geen taak</b> bij — deze is klaar.<br><br>' +
        'De afspraak wordt vastgelegd als <b>sale</b>, zodat deze deal in de rapportage terechtkomt. ' +
        'Lukt dat niet, dan zie je dat meteen.</div>' +
        '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvCallBevestig(\'klant_geworden\')">Vastleggen als sale</button>');
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
    if (MODAL_BALK.has(m.soort)) return balkModalHtml(m);
    if (m.soort === 'lead-nieuw') return leadModalHtml(m);
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
      // BEZIG = ALLES OP SLOT, MET EEN ZICHTBAAR TEKEN.
      //
      // Verplaatsen duurt ±5 seconden (de eventmodule-kern doet een
      // capaciteitscheck, een insert, tags en twee audit-regels). Het venster
      // bleef al die tijd onveranderd staan, dus zag Dave niet dat er iets
      // gebeurde — en een tweede klik zou een tweede verplaatsing sturen.
      const bezig = !!_ui.bezig;
      const body =
        (bezig ? '<div class="ronde"><b>Bezig met verplaatsen&hellip;</b> Even wachten, dit duurt een paar seconden.</div>' : '') +
        opt('&#10003;', 'var(--o-grns)', 'Bevestigd &mdash; hij komt',
          nogRonde
            ? 'Vandaag klaar. Op ' + nl(wakkerB) + ' staat hij vanzelf terug voor de reminder-call.'
            : 'Het event is dichtbij, dus dit is de laatste ronde. De kaart gaat dicht.',
          "window.__opvAanmeldActie('bevestigd')", bezig) +
        opt('&#128172;', 'var(--o-grns)', 'Gesprek gehad', 'Schrijf op wat er gezegd is. Daarmee is deze kaart klaar.', "window.__opvAanmeldActie('gesprek_gehad')", bezig) +
        opt('&#128533;', '#f0f1f4', 'Geen interesse of per ongeluk aangemeld', 'Kaart dicht, en in de eventmodule op Komt niet.', "window.__opvAanmeldActie('geen_interesse')", bezig) +
        opt('&#128257;', 'var(--o-accs)', 'Verplaatst naar een ander event', 'Kies het nieuwe event; hij staat daar meteen als bevestigd.', "window.__opvVerplaatsNaarEvent()", bezig);
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
      // GEEN INTERESSE — ÉÉN KNOP, EN DE EVENTMODULE GAAT MEE.
      //
      // Hier stonden twee knoppen ('Archiveren én in de eventmodule
      // annuleren' / 'Alleen archiveren') met een gele waarschuwing erboven.
      // Dat maakte van één handeling een keuze, en de tweede knop liet de
      // aanwezigenlijst achter met iemand die net had afgezegd. Dave hoeft
      // hier niets te kiezen: afmelden is afmelden, op allebei de plekken.
      const uitleg = u === 'geen_interesse'
        ? 'De kaart gaat dicht. In de eventmodule komt hij op \'Komt niet\' en zijn inschrijving wordt geannuleerd.'
        : 'De kaart wacht op bevestiging. Staat deze persoon binnen 48 uur nergens als aanmelding op een ander event, dan komt hij terug in je lijst.';
      const watHeet = u === 'geen_interesse' ? 'Geen interesse' : 'Verplaatst naar een ander event';
      const knopTekst = u === 'geen_interesse' ? 'Vastleggen &mdash; komt niet' : 'Vastleggen';
      return scrim(watHeet, esc(t.naam),
        '<div class="ronde">' + uitleg + '</div>' +
        '<textarea id="opv-an" rows="2" placeholder="Notitie (mag leeg)"></textarea>' +
        '<button class="obtn p" style="width:100%;margin-top:12px" onclick="window.__opvAanmeldBevestig(\'' + esc(u) + '\')">' +
        knopTekst + '</button>');
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
  /**
   * @param {{handmatig?:boolean}} [o] `handmatig:false` zegt dat er GEEN
   *   datumveld onder dit blok staat. Dat verandert wat er bij een storing
   *   moet staan: 'zet hem hieronder zelf op een dag' verwijst dan naar iets
   *   wat er niet is, en dat is erger dan geen uitleg — je stuurt iemand naar
   *   een knop die nergens staat.
   */
  function agendaBlok(o) {
    const handmatig = !o || o.handmatig !== false;
    const van = agendaVan(), tot = agendaTot();
    if (!_agenda.data && !_agenda.loading && !_agenda.error) fetchAgenda();

    // BEZIG IS NIET ALLEEN EEN TEKSTJE. Zolang er een boeking loopt moeten de
    // slots dood zijn: twee klikken op twee momenten leveren anders twee
    // afspraken op, en bij verzetten een tweede keten op dezelfde lead.
    const bezig = !!_ui.bezig;
    const terug = _agenda.offset > 0 && !bezig;
    const heen  = _agenda.offset < AGENDA_MAX_WEKEN - 1 && !bezig;
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
        (handmatig
          ? '<br>Je kunt hem hieronder gewoon zelf op een dag zetten.'
          : '<br>Probeer het zo opnieuw. Een zoomcall heeft een uur nodig, dus een kale datum ' +
            'is hier geen uitweg &mdash; lukt het niet, bel de lead dan even terug met een moment.') +
        '</div>';
    }

    const d = _agenda.data;
    const dagen = (d && d.dagen) || [];
    const melding = d && d.melding
      ? '<div class="warn2">' + esc(d.melding) + '</div>' : '';
    const wacht = bezig
      ? '<div class="ronde zacht">Bezig met vastleggen&hellip;</div>' : '';

    const kolommen = dagen.map((dag) => {
      const vrij = (dag.vrij || []).map((s) => bezig
        ? '<span class="slot vrij" style="opacity:.45;cursor:default">' + esc(s.tijd) + '</span>'
        : '<button class="slot vrij" onclick="window.__opvBoek(\'' + esc(s.iso) + '\')">' + esc(s.tijd) + '</button>').join('');
      const bezet = (dag.bezet || []).map((b) =>
        '<span class="slot bezet">' + esc(b.tijd) + '<span class="w">' + esc(b.naam) + '</span></span>').join('');
      const leeg = (!vrij && !bezet) ? '<div class="agleeg">&mdash;</div>' : '';
      return '<div class="agd"><div class="dh">' + esc(dagNaam(dag.dag)) + '<b>' + esc(nl(dag.dag)) + '</b></div>' +
        vrij + bezet + leeg + '</div>';
    }).join('');

    // GEEN LEEG SCHERM. Nul dagen met nul momenten is een geldig antwoord van
    // de agenda, maar het ziet eruit als een kapot venster.
    const niets = dagen.length === 0
      ? '<div class="agleeg">Geen momenten in deze week. Blader naar de volgende.</div>' : '';

    return kop + melding + wacht + '<div class="agw">' + kolommen + '</div>' + niets;
  }

  const DAGNAMEN = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
  const dagNaam = (d) => DAGNAMEN[new Date(d + 'T12:00:00Z').getUTCDay()] || '';

  // `uit` schakelt de knop uit terwijl er een actie loopt. Zonder dat blijft
  // het venster er klikbaar bij staan en levert een tweede klik een tweede
  // actie op — bij verplaatsen zou dat een tweede deelnemer op het doel-event
  // zijn.
  const opt = (em, bg, titel, sub, actie, uit) =>
    '<button class="opt" onclick="' + (uit ? '' : actie) + '"' + (uit ? ' disabled style="opacity:.5;cursor:default"' : '') +
    '><div class="em" style="background:' + bg + '">' + em + '</div>' +
    '<div><b>' + titel + '</b><span>' + sub + '</span></div></button>';
  // `scrim on`, om exact dezelfde reden als bij waPaneelHtml hierboven: zonder
  // `on` houdt de globale .scrim-regel uit het design system opacity op 0 en
  // pointer-events op none, en blijft elk venster van deze module onzichtbaar.
  const scrim = (titel, sub, body) =>
    '<div class="opv"><div class="scrim on"' +
    ' onmousedown="window.__opvScrimNeer(event)" onmouseup="window.__opvScrimOp(event, \'modal\')"><div class="modal">' +
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
    _calls.data = null; _calls.key = null; _calls.error = null; _calls.achterstand = [];
    render();
  };

  // ── G1 · de twee vensters onder de balk ───────────────────────────────────
  window.__opvTijdlijn = (d) => {
    _ui.modal = { soort: 'tijdlijn', dag: d };
    straks(() => fetchTijdlijn(d));
    render();
  };

  window.__opvLater = () => {
    const wk = bepaalWeek({ nu: vandaag(), offset: _ui.weekOffset });
    const na = wk.dagen[wk.dagen.length - 1];
    _ui.modal = { soort: 'later', na };
    straks(() => fetchLater(na));
    render();
  };

  // Vanuit de tijdlijn alsnog de takenlijst van die dag. Zonder deze knop was
  // de dagweergave van een voorbije dag niet meer te bereiken, en dat zou iets
  // weghalen dat er al was.
  window.__opvDagVanuitTijdlijn = (d) => { _ui.modal = null; window.__opvDag(d); };
  window.__opvDagVanuitLater    = (d) => { _ui.modal = null; window.__opvDag(d); };

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

  // ── G2 · een lead met de hand toevoegen ───────────────────────────────────

  /** Wat er nú in het formulier staat. */
  function leesLeadVelden() {
    const v = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
    return {
      naam    : v('opv-lead-naam'),
      telefoon: v('opv-lead-tel'),
      reden   : v('opv-lead-reden') || LEAD_REDEN_KEYS[0],
      due     : v('opv-lead-due'),
      notitie : v('opv-lead-notitie'),
    };
  }

  window.__opvLeadNieuw = () => {
    _ui.modal = { soort: 'lead-nieuw', velden: { reden: LEAD_REDEN_KEYS[0], due: vandaag() }, fout: null, bezig: false };
    render();
  };

  // Bij het wisselen van reden verandert de uitleg eronder. Wat er al getypt is
  // gaat mee terug het formulier in; zonder dat wist één klik op de keuzelijst
  // de naam en de notitie.
  window.__opvLeadVeld = () => {
    const m = _ui.modal; if (!m || m.soort !== 'lead-nieuw') return;
    m.velden = leesLeadVelden();
    render();
  };

  window.__opvLeadOpslaan = async () => {
    const m = _ui.modal; if (!m || m.soort !== 'lead-nieuw' || m.bezig) return;
    const f = leesLeadVelden();
    m.velden = f;

    // Dezelfde controles staan op de server. Hier staan ze zodat je meteen ziet
    // wát er ontbreekt, in plaats van een kale 400 terug te krijgen.
    const ontbreekt =
      !f.naam     ? 'Vul een naam in.'
      : !f.telefoon ? 'Vul een telefoonnummer in — zonder nummer kan deze kaart niets.'
      : !f.due      ? 'Kies een dag om hem terug te zetten.'
      : !f.notitie  ? 'De notitie is verplicht: zonder die zin weet niemand later waar deze lead vandaan kwam.'
      : null;
    if (ontbreekt) { m.fout = ontbreekt; render(); return; }

    m.bezig = true; m.fout = null; render();
    try {
      const j = await post('/api/opvolging-taak-create', {
        naam    : f.naam,
        telefoon: f.telefoon,
        reden   : f.reden,
        due     : f.due,
        notitie : f.notitie,
        bron    : 'handmatig',
        bron_ref: { source: 'opvolging-handmatig' },
      });
      _ui.modal = null;
      leegTakenCache();
      // Stond er al een kaart met dit nummer? Dat is geen fout — de lead is
      // aangemaakt — maar wel iets dat je wilt weten vóór je gaat bellen.
      const d = j && j.duplicaat;
      if (d && d.aantal) {
        alert('Toegevoegd. Let op: er staat al ' + (d.aantal === 1 ? 'een open kaart' : d.aantal + ' open kaarten') +
          ' met dit nummer' + (d.namen && d.namen.length ? ' (' + d.namen.join(', ') + ')' : '') + '.');
      }
      // Staat de nieuwe kaart op een andere dag dan je nu bekijkt, dan spring je
      // mee. Anders lijkt er niets gebeurd te zijn.
      if (f.due !== (_ui.dagView || vandaag())) window.__opvDag(f.due);
      else render();
    } catch (e) {
      m.bezig = false;
      m.fout = (e && e.message) || 'onbekende fout';
      render();
    }
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

  // ── Het gesprek openen ────────────────────────────────────────────────────
  // Hiervoor openden deze twee wa.me in een nieuw tabblad. Dan zie je het
  // gesprek wel, maar staat het niet in het systeem en kan niemand het
  // teruglezen. Nu gaat het paneel open; het wa.me-linkje staat onderin voor
  // als de brug eruit ligt.
  //
  // Er wordt hier GEEN poging weggeschreven. Dat deed __opvWa wel ('WhatsApp
  // geopend') en __opvCallWa niet, en dat verschil klopte al niet. Bovendien
  // telde die rij een bericht dat misschien nooit verstuurd is: het tabblad
  // opengaan is geen contact. De poging ontstaat nu op één plek — de webhook,
  // zodra de brug meldt dat het bericht echt vertrokken is.
  function opengesprek({ nummer, taakId, naam }) {
    _gesprek.open = true;
    _gesprek.nummer = nummer ? String(nummer).replace(/\D/g, '') : null;
    _gesprek.taakId = taakId || null;
    _gesprek.naam = naam || null;
    _gesprek.berichten = null; _gesprek.error = null; _gesprek.code = null;
    _gesprek.optimistisch = [];
    _gesprek.melding = null; _gesprek.meldingSoort = null; _gesprek.haalt = false;
    render();
    straks(() => { fetchGesprek(); herstelWaTimers(); });
  }

  window.__opvWa = (id) => {
    const t = zoekTaak(id); if (!t) return;
    if (!t.telefoon) { alert('Geen telefoonnummer bekend.'); return; }
    opengesprek({ nummer: t.telefoon, taakId: id, naam: t.naam });
  };

  // ── De sluitregel van een scrim ───────────────────────────────────────────
  //
  // Pure beslissing, apart getest: sluit alleen als de muis op de scrim ZELF
  // neerging én er ook weer op losgelaten werd. Alles daarbuiten — begonnen in
  // het paneel, geëindigd in het paneel, of een neergang die we niet gezien
  // hebben — is geen sluitklik.
  function magSluiten(neerOpScrim, opOpScrim) {
    return neerOpScrim === true && opOpScrim === true;
  }

  // Waar de laatste muisknop neerging. Alleen een booleaan; hij wordt bij elke
  // mouseup weer leeggemaakt zodat een oude neergang niet blijft hangen.
  let _scrimNeer = false;

  window.__opvScrimNeer = (ev) => { _scrimNeer = !!(ev && ev.target === ev.currentTarget); };
  window.__opvScrimOp = (ev, welke) => {
    const opScrim = !!(ev && ev.target === ev.currentTarget);
    const sluiten = magSluiten(_scrimNeer, opScrim);
    _scrimNeer = false;
    if (!sluiten) return;
    if (welke === 'gesprek') window.__opvGesprekSluit();
    else if (welke === 'wa') window.__opvWaSluit();
    else window.__opvSluit();
  };

  /** Wat er getypt wordt hoort in de staat, niet alleen in de DOM. */
  window.__opvGesprekTyp = (waarde) => { _gesprek.concept = String(waarde == null ? '' : waarde); };

  window.__opvGesprekSluit = () => {
    _gesprek.open = false;
    _gesprek.optimistisch = [];
    _gesprek.concept = '';
    render();
    // Timer meteen opruimen, niet pas bij de volgende statusronde. Dezelfde
    // afspraak als bij het koppelpaneel.
    herstelWaTimers();
  };

  /**
   * De geschiedenis van het toestel erbij halen.
   *
   * De brug leest, het CRM schrijft. Twee keer klikken levert geen dubbele
   * regels op: de unieke index op bericht_id vangt dat af.
   *
   * Wat hier terugkomt is niet noodzakelijk het volledige gesprek. Een
   * gekoppeld apparaat krijgt een beperkt venster van de telefoon gesynct, en
   * deze brug hangt er pas kort aan. Vandaar dat de melding erna zegt WAT er
   * binnenkwam en VANAF WANNEER, in plaats van stilletjes een halve draad te
   * tonen alsof dat alles is.
   */
  window.__opvGesprekHistoriek = async () => {
    if (_gesprek.haalt || !_gesprek.nummer) return;
    _gesprek.haalt = true; _gesprek.melding = null; _gesprek.meldingSoort = null;
    render();
    try {
      const j = await post('/api/opvolging-whatsapp-historiek', {
        nummer: _gesprek.nummer, taak_id: _gesprek.taakId || null, limiet: 50,
      });
      _gesprek.haalt = false;
      _gesprek.melding = beschrijfHistoriek(j);
      // GEEN_KOPPELING vraagt om een handeling (stuur eerst een bericht); de
      // andere twee zijn geen fout maar ook geen resultaat.
      _gesprek.meldingSoort = j && j.opgehaald > 0 ? 'ok'
        : (j && j.code === 'GEEN_KOPPELING') ? 'fout' : 'leeg';
      await fetchGesprek();
    } catch (e) {
      _gesprek.haalt = false;
      _gesprek.meldingSoort = 'fout';
      _gesprek.melding = 'Ophalen is niet gelukt: ' + (e.message || 'onbekende fout');
      render();
    }
  };

  /**
   * Wat er opgehaald is, in gewone taal.
   *
   * Drie dingen horen erin: hoeveel, hoeveel daarvan nieuw was, en vanaf
   * wanneer. Dat laatste is het belangrijkste — het is het verschil tussen
   * 'dit is het gesprek' en 'dit is wat WhatsApp naar dit apparaat gestuurd
   * heeft'.
   */
  function beschrijfHistoriek(j) {
    if (!j) return 'Er kwam geen antwoord terug.';
    // Drie uitkomsten die iets heel anders betekenen. Alleen de eerste vraagt om
    // een handeling; de andere twee zijn 'er is niets, en dat klopt'.
    if (!j.opgehaald) {
      return j.melding || 'WhatsApp gaf voor dit nummer geen berichten terug.';
    }
    const nieuw = j.nieuw === 0
      ? 'Die stonden er allemaal al'
      : j.nieuw === j.opgehaald ? 'Allemaal nieuw' : j.nieuw + ' daarvan waren nieuw';
    const vanaf = j.oudste
      ? ' Het oudste bericht dat WhatsApp doorgaf is van ' + nl(iso(j.oudste)) + '.'
      : '';
    const meer = j.mogelijk_meer
      ? ' Er is er mogelijk meer: de lijst liep tot aan de grens van wat we in één keer ophalen.'
      : ' Verder terug gaf WhatsApp niets — een gekoppeld apparaat krijgt maar een beperkt venster van de telefoon gesynct, dus op Daves toestel kan meer staan.';
    return j.opgehaald + ' bericht' + (j.opgehaald === 1 ? '' : 'en') + ' opgehaald. ' + nieuw + '.' + vanaf + meer;
  }

  window.__opvGesprekStuur = async () => {
    if (_gesprek.verzendt) return;
    // Uit de staat, met de DOM als terugval. De staat is de waarheid sinds het
    // concept daar bijgehouden wordt; het veld lezen blijft staan voor het
    // geval er getypt is zonder dat oninput gevuurd heeft (plakken via een
    // ouder pad, autofill).
    const el = document.getElementById('opv-wa-tekst');
    const tekst = String(_gesprek.concept || (el && el.value) || '').trim();
    if (!tekst) return;
    if (!gesprekKanVersturen().mag) return;

    // Optimistisch tonen: anders staat een verstuurd bericht tot vijf seconden
    // lang nergens en typt iemand het nog een keer.
    _gesprek.verzendt = true;
    _gesprek.optimistisch.push({ richting: 'uit', tekst, media_type: 'chat', tijdstip: new Date().toISOString() });
    render();
    try {
      await post('/api/opvolging-whatsapp-send', {
        nummer: _gesprek.nummer, tekst, taak_id: _gesprek.taakId || null,
      });
      _gesprek.verzendt = false;
      // Weg met het concept: dit bericht is verstuurd. Pas hierna, zodat een
      // mislukte verzending hem laat staan.
      _gesprek.concept = '';
      await fetchGesprek();
    } catch (e) {
      // Weg met de bubbel: hij is níet verstuurd, en hem laten staan zou dat
      // suggereren. De tekst gaat terug in het veld zodat er niets verloren gaat.
      _gesprek.verzendt = false;
      _gesprek.optimistisch = _gesprek.optimistisch.filter((o) => o.tekst !== tekst);
      // De tekst blijft in de staat staan, dus hij komt vanzelf terug in het
      // veld — ook als er tussendoor hertekend wordt.
      _gesprek.concept = tekst;
      render();
      herstelConcept();
      alert('Versturen is niet gelukt: ' + (e.message || 'onbekende fout'));
    }
  };

  // ── Fase 3a · de calls van vandaag ────────────────────────────────────────
  /**
   * De call achter een index.
   *
   * Twee reeksen, want er staan twee lijsten op het scherm: de calls van de
   * gekozen dag (gewoon een getal) en de achterstand van eerdere dagen
   * ('a0', 'a1', …). Eén gedeelde nummering zou breken zodra er een rij bij
   * komt of afvalt — dan rondt Dave de verkeerde persoon af.
   */
  const callOp = (i) => {
    const sleutel = String(i);
    if (sleutel.charAt(0) === 'a') {
      // /^\d+$/ en niet Number(): 'a' alleen levert Number('') === 0 op, en dan
      // pakt een kapotte verwijzing stilletjes de eerste rij. De verkeerde
      // persoon afronden is erger dan niets doen.
      const n = sleutel.slice(1);
      if (!/^\d+$/.test(n)) return null;
      return (_calls.achterstand || [])[Number(n)] || null;
    }
    return (_calls.data || [])[i] || null;
  };

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
    // Precies hetzelfde als vanaf een kaart. Bestaat er al een taak voor dit
    // nummer, dan gaat die mee zodat het gesprek daaraan hangt; zo niet, dan
    // volstaat het nummer — een call uit de agenda hoeft nog geen taak te
    // hebben, en juist bij een eerste gesprek is dat het normale geval.
    const taak = taakVoorNummer(c.telefoon);
    opengesprek({ nummer: c.telefoon, taakId: taak ? taak.id : null, naam: c.naam });
  };

  window.__opvCallAfrond = (i) => { _ui.modal = { soort: 'call-afrond', callIndex: i }; render(); };
  window.__opvCallVerzet = () => {
    const m = _ui.modal; if (!m) return;
    // De agenda opnieuw ophalen: dit venster kan uren na het vorige opengaan
    // en een slot dat toen vrij was hoeft dat nu niet te zijn.
    _agenda.data = null; _agenda.key = null; _agenda.error = null;
    _ui.modal = { soort: 'call-verzet', callIndex: m.callIndex };
    render();
  };
  window.__opvCallUitkomst = (u) => {
    const m = _ui.modal; if (!m) return;
    _ui.modal = { soort: 'call-uitkomst', callIndex: m.callIndex, uitkomst: u };
    render();
  };

  // ═════════════════════════════════════════════════════════════════════════
  // Q · DE UITKOMST VAN EEN ZOOMCALL WORDT ECHT WEGGESCHREVEN
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Twee van de vier knoppen lieten geen spoor na: 'klant geworden' toonde
  // alleen een sluitknop en schreef niets, en 'geen interesse' vroeg Dave om een
  // reden en gooide die tekst weg bij het sluiten. Er komt een rapportagemodule
  // over Daves werk, en die zou nul sales tonen en bij elke gewonnen deal 'geen
  // uitkomst geregistreerd' — het rapport zou hem beschuldigen van werk dat hij
  // wél gedaan heeft.
  //
  // ÉÉN ADMINISTRATIE. De knoppen schrijven door naar de bestaande
  // uitkomstmotor (api/follow-up-appointment-outcome.js). We voegen geen derde
  // waarheid toe en raken de twee bestaande woordenlijsten niet aan — lees het
  // waarschuwingsblok in dat bestand, met het productie-incident van 20 mei.
  //
  // WAAROM JUIST DEZE DRIE WOORDEN. 'terugbel' en 'later_opnieuw' liggen voor de
  // hand bij 'wil nog beslissen', maar die maken een NIEUWE follow_up_lead aan
  // in het oude systeem — en Opvolging maakt voor diezelfde persoon al een
  // kaart. Dan staat dezelfde lead in twee modules op Dave te wachten, en dat is
  // erger dan wat we repareren. 'gesprek_gehad' zet alleen de status en schrijft
  // een notitie, en dat is precies wat we willen.
  //
  // NO-SHOW STAAT ER MET OPZET NIET IN. Het outcome 'no_show' maakt óók een
  // follow_up_lead (terugbel over twee uur), en Opvolging zet die persoon
  // vandaag al terug in de lijst. Diezelfde dubbeling. Die vraag ligt bij Maxim;
  // tot hij beslist doet no-show wat hij deed.
  const CALL_UITKOMST = {
    klant_geworden   : 'sale',
    geen_interesse   : 'wilt_niet_meer',
    wil_nog_beslissen: 'gesprek_gehad',
  };

  /** Welk outcome hoort bij deze knop? null = niet doorschrijven. */
  function outcomeVoorUitkomst(uitkomst) {
    return Object.prototype.hasOwnProperty.call(CALL_UITKOMST, uitkomst)
      ? CALL_UITKOMST[uitkomst] : null;
  }

  /**
   * De uitkomst doorschrijven naar de motor. FAIL-SOFT, maar nooit stil.
   *
   * Geeft terug wat er gebeurd is, zodat de aanroeper het kan tonen:
   *   { ok: true }                          — vastgelegd
   *   { ok: false, reden, uitleg }          — niet vastgelegd, en waarom
   *   null                                  — deze knop schrijft niets door
   *
   * Waarom zichtbaar en niet stil: mislukt dit ongemerkt, dan denkt Dave dat
   * het genoteerd is en staat er straks in het rapport dat hij niets heeft
   * ingevuld. Dat is precies de fout die we hier repareren.
   */
  async function schrijfCallUitkomst(uitkomst, call, notitie) {
    const outcome = outcomeVoorUitkomst(uitkomst);
    if (!outcome) return null;
    const apptId = call && call.appointment_id;
    if (!apptId) {
      return { ok: false, reden: 'geen_afspraak',
        uitleg: 'deze call heeft geen afspraak-id, dus er is niets om de uitkomst aan te hangen' };
    }
    try {
      await post('/api/follow-up-appointment-outcome', {
        appointment_id: apptId,
        outcome,
        // Daves eigen woorden gaan mee ACHTER de vaste zin van de motor. Zonder
        // deze regel ziet wie de afspraakkaart opent 'geen interesse' zonder
        // waarom.
        ...(notitie ? { note: notitie } : {}),
      });
      return { ok: true, outcome };
    } catch (e) {
      return { ok: false, reden: 'motor', uitleg: (e && e.message) || 'onbekende fout' };
    }
  }

  /**
   * De dag waarop deze call stond — voor het etiket op een nieuwe kaart.
   *
   * Een achterstandscall is van gisteren of eerder, en dan is 'Call 10/09' een
   * leugen op de kaart: de volgende die hem oppakt leest daar de verkeerde dag.
   * De rij draagt zijn eigen `dag`; die wint boven de dag die op het scherm
   * staat.
   */
  function callBadgeDag(c) {
    return (c && c.dag) || _ui.dagView || vandaag();
  }

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

    // Klant geworden: alleen de uitkomst, geen taak. De kaart is klaar.
    if (uitkomst === 'klant_geworden') {
      const res = await schrijfCallUitkomst(uitkomst, c, notitie);
      _ui.modal = null; leegTakenCache(); render();
      meldUitkomst(res, { bewaardHier: false, notitie: '' });
      return;
    }

    // Geen interesse levert bewust GEEN OPEN taak op — net als bij een event dat
    // zo eindigt. Een kaart die meteen dicht is komt met nul belpogingen in
    // Afgerond terecht en krijgt daar het oordeel 'te weinig moeite', terwijl
    // er nooit iets mee hoefde te gebeuren.
    //
    // Maar Daves reden mag niet meer verdwijnen: die tekst was tot nu toe het
    // enige wat verloren ging, en het is precies wat het rapport straks moet
    // lezen. Hij gaat naar de motor én blijft aan onze kant staan, ook als de
    // motor onbereikbaar is.
    if (uitkomst === 'geen_interesse') {
      const res = await schrijfCallUitkomst(uitkomst, c, notitie);
      let bewaardHier = false;
      try {
        await post('/api/opvolging-taak-create', {
          naam       : c.naam,
          email      : c.email || null,
          telefoon   : c.telefoon || null,
          reden      : 'afgemeld',
          reden_code : 'zoom_geen_interesse',
          due        : vandaag(),
          notitie,
          badge_label: 'Call ' + nl(callBadgeDag(c)),
          bron_ref   : { appointment_id: c.appointment_id || null, start: c.start || null },
          // Meteen dicht: er hoeft niets meer mee te gebeuren. De kaart bestaat
          // alleen zodat de reden bewaard blijft en terugvindbaar is.
          direct_archiveren: true,
          archief_reden    : notitie,
        });
        bewaardHier = true;
      } catch (e) {
        console.warn('[opvolging-v2] reden bewaren mislukt:', (e && e.message) || e);
      }
      _ui.modal = null; leegTakenCache(); render();
      meldUitkomst(res, { bewaardHier, notitie });
      return;
    }

    const uitkomstRes = await schrijfCallUitkomst(uitkomst, c, notitie);

    try {
      await post('/api/opvolging-taak-create', {
        naam       : c.naam,
        email      : c.email || null,
        telefoon   : c.telefoon || null,
        reden      : uitkomst === 'no_show' ? 'no_show_call' : 'wil_nog_beslissen',
        due        : uitkomst === 'no_show' ? vandaag() : due,
        notitie    : notitie || null,
        badge_label: 'Call ' + nl(callBadgeDag(c)),
        bron_ref   : { appointment_id: c.appointment_id || null, start: c.start || null },
        // Alleen bij 'wil nog beslissen' een poging: dat gesprek is echt
        // gevoerd. Een no-show is géén belpoging — er is niet gebeld, er kwam
        // alleen niemand opdagen. Zou hij hier toch meetellen, dan staat de
        // verse kaart vandaag op 1 van 2 terwijl Dave die persoon nog nooit aan
        // de lijn heeft gehad, en klopt de dekking op het dashboard niet meer.
        ...(uitkomst === 'no_show' ? {} : { poging_resultaat: 'gesproken, wil nog beslissen' }),
      });
      _ui.modal = null; leegTakenCache(); render();
      meldUitkomst(uitkomstRes, { bewaardHier: true, notitie });
    } catch (e) {
      alert('Niet gelukt: ' + (e.message || 'onbekende fout'));
    }
  };

  /**
   * Zeggen dat de uitkomst NIET is vastgelegd. Alleen bij een mislukking.
   *
   * Zwijgen zou hier het ergste zijn: dan denkt Dave dat het genoteerd is, en
   * staat er straks in het rapport dat hij niets heeft ingevuld.
   */
  function meldUitkomst(res, { bewaardHier, notitie } = {}) {
    if (!res || res.ok) return;
    const kern = 'De kaart is bijgewerkt, maar de uitkomst van deze call is NIET '
      + 'vastgelegd in de afsprakenadministratie.';
    const waarom = res.reden === 'geen_afspraak'
      ? 'Reden: ' + res.uitleg + '.'
      : 'Reden: ' + res.uitleg + '.';
    const staat = notitie
      ? (bewaardHier
        ? '\n\nWat je hebt opgeschreven is wél bewaard in Opvolging.'
        : '\n\nLet op: ook hier is het niet bewaard. Schrijf het ergens anders op.')
      : '';
    alert(kern + '\n' + waarom + staat + '\n\nGeef dit door, dan zetten we het handmatig recht.');
  }

  // ── Aanmeldingen: de drie uitgangen ───────────────────────────────────────
  window.__opvAanmeldActie = (u) => {
    const m = _ui.modal; if (!m) return;
    _ui.modal = { soort: 'aanmeld-actie', taakId: m.taakId, uitkomst: u };
    render();
  };

  window.__opvAanmeldBevestig = async (uitkomst) => {
    const m = _ui.modal; if (!m || _ui.bezig) return;
    const el = document.getElementById('opv-an');
    const notitie = (el && el.value || '').trim();
    if (uitkomst === 'gesprek_gehad' && !notitie) { alert('Schrijf eerst op wat er gezegd is.'); return; }

    // Op slot vóór de eerste await: post() doet dat ook, maar pas op het moment
    // dat de aanroep begint. Een tweede klik in dat gaatje stuurt een tweede
    // actie — en 'bevestigd' twee keer levert twee pogingen en twee regels in
    // de notitie op.
    _ui.bezig = true;
    try {
      const antwoord = await post('/api/opvolging-aanmelding-actie', { taak_id: m.taakId, actie: uitkomst, notitie: notitie || null });

      // ── DE EVENTMODULE GAAT MEE, EN FALEN MAG NOOIT STIL ───────────────
      // Allebei de schrijfacties hieronder zijn fail-soft op de server: de
      // kaart staat op dat moment al vast en mag er niet op stuklopen. Maar
      // een mislukking die niemand ziet laat de aanwezigenlijst achter met
      // een verkeerde stand, en dan belt de volgende dezelfde persoon nog
      // eens. Dus: hier altijd een melding.
      if (antwoord && antwoord.belstatus === 'mislukt') {
        alert('Bevestigd in Opvolging, maar de belstatus in de eventmodule kon niet op "bevestigd" gezet worden. Zet hem daar even met de hand.');
      }
      if (antwoord && antwoord.eventmodule === 'mislukt') {
        alert('Afgemeld in Opvolging, maar in de eventmodule kon hij niet op "Komt niet" gezet worden. Zet hem daar even met de hand.');
      }
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) {
      alert('Niet gelukt: ' + (e.message || 'onbekende fout'));
    } finally {
      // Altijd los, ook na een fout: anders zit Dave in een venster waarin
      // geen enkele knop nog werkt.
      _ui.bezig = false;
      render();
    }
  };

  /**
   * VERPLAATSEN NAAR EEN ANDER EVENT — dezelfde keuzelijst als de eventmodule.
   *
   * Geen tussenvenster meer: de vraag is 'naar welk event', en die stelt de
   * keuzelijst zelf. Annuleren daar betekent dat er niets gebeurt en de kaart
   * gewoon blijft staan — dat is de veilige uitkomst, want er is dan ook niets
   * beloofd aan de lead.
   *
   * De keuzelijst komt uit events-v2.js, via window.__evKiesAnderEvent. Bewust
   * de GLOBALE en niet window.KV.evKiesAnderEvent: klanten-v2.js is een module
   * en draait na alle views, en die verving KV in zijn geheel — waardoor de
   * functie op 10 september uit allebei de modules verdween. Zie de kop van
   * die functie in events-v2.js.
   *
   * Bestaat hij toch niet, dan zeggen we dat — een knop die stil niets doet is
   * erger dan een knop die uitlegt waarom.
   */
  window.__opvVerplaatsNaarEvent = async () => {
    const m = _ui.modal; if (!m || _ui.bezig) return;
    const t = zoekTaak(m.taakId);
    if (!t) { alert('Deze kaart is niet meer te vinden. Ververs even.'); return; }
    if (typeof window.__evKiesAnderEvent !== 'function') {
      alert('De eventlijst is hier niet beschikbaar. Ververs de pagina en probeer opnieuw.');
      return;
    }

    const ev = evVan(t);
    const doel = await window.__evKiesAnderEvent({ eventId: ev.event_id || null, naam: t.naam || null });
    if (!doel) return;   // annuleren: er gebeurt niets

    // ── OP SLOT, EN ZICHTBAAR ────────────────────────────────────────────
    // De verplaatsing duurt een paar seconden. Zonder deze vlag blijft het
    // venster er onveranderd bij staan — Dave ziet niets gebeuren — en levert
    // een tweede klik een tweede verplaatsing op.
    //
    // post() zet _ui.bezig zelf ook, maar pas bij de aanroep en het valt
    // daarna meteen terug. Hier moet het venster al op slot vóór de render
    // hieronder, en tot het antwoord er is.
    _ui.bezig = true;
    render();
    try {
      const antwoord = await post('/api/opvolging-aanmelding-actie', {
        taak_id: m.taakId, actie: 'verplaats_naar_event', target_event_id: doel,
      });
      const waarheen = (antwoord && antwoord.event_titel) || 'het nieuwe event';
      opvToast(antwoord && antwoord.slaapt_tot
        ? 'Verplaatst naar ' + waarheen + ' — bevestigd, komt terug op ' + nl(antwoord.slaapt_tot)
        : 'Verplaatst naar ' + waarheen + ' — bevestigd');
      if (antwoord && antwoord.belstatus === 'mislukt') {
        alert('Verplaatst, maar de belstatus op het nieuwe event kon niet op "bevestigd" gezet worden. Zet hem daar even met de hand.');
      }
      _ui.modal = null; leegTakenCache(); render();
    } catch (e) {
      // De letterlijke melding van de server: 'Doel-event is vol (12/12 met
      // ingevulde vragenlijst)' zegt precies wat er aan de hand is. De kaart
      // blijft staan.
      alert('Verplaatsen mislukt: ' + (e.message || 'onbekende fout'));
    } finally {
      // ALTIJD LOS. Bleef de vlag na een fout staan, dan zit Dave met een
      // venster waarin geen enkele knop meer werkt en is verversen zijn enige
      // uitweg.
      _ui.bezig = false;
      render();
    }
  };

  window.__opvWeek = (stap) => {
    const n = _agenda.offset + stap;
    if (n < 0 || n >= AGENDA_MAX_WEKEN) return;
    _agenda.offset = n;
    _agenda.data = null; _agenda.key = null; _agenda.error = null;
    render();
  };

  /**
   * Eén knop, twee bestemmingen.
   *
   *   soort 'inplannen'   → { taak_id }        een kaart krijgt een afspraak
   *   soort 'call-verzet' → { appointment_id } een bestaande call verhuist
   *
   * De tweede tak is er omdat verzetten anders alleen via 'no-show afronden'
   * kon, en dat is een oordeel dat niet klopt over iemand die juist belde.
   */
  window.__opvBoek = async (startIso) => {
    const m = _ui.modal; if (!m || !startIso) return;
    // Dubbelklik-guard. post() zet _ui.bezig zelf ook, maar pas bij de aanroep;
    // tussen twee snelle klikken past een tweede verzoek.
    if (_ui.bezig) return;

    const verzetten = m.soort === 'call-verzet';
    const call = verzetten ? callOp(m.callIndex) : null;
    if (verzetten && !(call && call.appointment_id)) {
      opvToast('Deze call heeft geen afspraak-id, dus er is niets om te verzetten.');
      return;
    }
    // Meteen tekenen zodat de slots dood staan vóór het verzoek vertrekt.
    _ui.bezig = true; render();

    try {
      const antwoord = verzetten
        ? await post('/api/opvolging-agenda', { appointment_id: call.appointment_id, start: startIso })
        : await post('/api/opvolging-agenda', { taak_id: m.taakId, start: startIso });
      _ui.modal = null;
      _agenda.data = null; _agenda.key = null;
      // leegTakenCache() leegt óók _calls, en dat is hier het punt: de oude
      // call staat nu als 'verzet' op zijn eigen dag en de nieuwe verschijnt
      // op de zijne. Zonder die verversing blijft het oude uur staan alsof er
      // niets gebeurd is.
      leegTakenCache(); render();
      if (verzetten) {
        const n = (antwoord && antwoord.kaarten_gesloten) || 0;
        opvToast('Verzet. De oude afspraak wordt niet beoordeeld.' +
          (n ? ' ' + n + ' openstaande kaart' + (n === 1 ? '' : 'en') + ' voor deze lead gesloten.' : ''));
      }
    } catch (e) {
      alert((verzetten ? 'Verzetten' : 'Inplannen') + ' niet gelukt: ' + (e.message || 'onbekende fout'));
      // Het slot kan intussen bezet zijn — opnieuw ophalen zodat de week klopt.
      _agenda.data = null; _agenda.key = null; render();
    } finally {
      _ui.bezig = false;
      render();
    }
  };

  window.__opvTerug = async (id) => {
    // NIET 'verplaats'. Die actie verzet alleen de datum, en omdat de due van
    // een wachtende kaart al op vandaag staat deed deze knop letterlijk niets:
    // de status bleef wacht_inplanning en agenda_doorgestuurd_at bleef gevuld.
    // Sofia Vanat en Shudino Andrade zaten daardoor vast zonder weg terug.
    // 'terug_in_lijst' draait de hele toestand terug — zie
    // api/_lib/opvolging-terug-in-lijst.js.
    try {
      await post('/api/opvolging-taak-update', { taak_id: id, actie: 'terug_in_lijst' });
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

  // ── Escape als expliciete uitgang ─────────────────────────────────────────
  //
  // Het kruisje blijft staan en de scrim ook; dit is er een derde naast. Eén
  // venster tegelijk, in de volgorde waarin ze boven elkaar liggen: eerst het
  // gesprek, dan het koppelpaneel, dan een modal. Anders sluit Escape het
  // onderste weg terwijl je naar het bovenste kijkt.
  //
  // Bewust GEEN sluiting terwijl er getypt wordt met tekst in het veld: dan is
  // Escape 'ik wil dit venster weg' voor de een en 'oeps' voor de ander, en
  // een half getypt bericht kwijtraken is precies wat we net gerepareerd hebben.
  function magEscapeSluiten() {
    const ta = tekstEl();
    const bezigMetTypen = !!(ta && document.activeElement === ta && String(ta.value || '').trim());
    return !bezigMetTypen;
  }

  window.addEventListener('keydown', (ev) => {
    if (!ev || ev.key !== 'Escape') return;
    if (_gesprek.open) { if (magEscapeSluiten()) window.__opvGesprekSluit(); return; }
    if (_wa.paneelOpen) { window.__opvWaSluit(); return; }
    if (_ui.modal) window.__opvSluit();
  });

  // Voor de console én voor tests/opvolging-whatsapp-koppel.test.js: de twee
  // besluiten zijn zo na te slaan zonder het scherm te hoeven bedienen.
  window.__opvWaHelpers = { beschrijfWaStatus, bepaalWaTimers, bepaalTimerActie, toonNummer, geledenTekst, brugTellersBlok };

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
  // Q, getest in tests/opvolging-zoomuitkomsten.test.js.
  window.__opvUitkomstHelpers = {
    CALL_UITKOMST, outcomeVoorUitkomst, schrijfCallUitkomst, meldUitkomst,
  };

  window.__opvModalHaak = {
    modalHtml,
    zetCalls: (lijst) => { _calls.key = vandaag(); _calls.data = lijst || []; _calls.error = null; },
    zetTaken: (lijst) => { _live.taken.key = vandaag(); _live.taken.data = { taken: lijst || [], wacht: [] }; },
    huidigeModal: () => _ui.modal,
    MODAL_ZONDER_TAAK,
  };

  window.__opvAanmeldHelpers = { WAKKER_DAGEN, bevestigdBadge, taakKaart, evGroepKop, kortePlaats, eventKopTekst };

  // G2, getest in tests/opvolging-lead-toevoegen.test.js: het formulier zonder
  // browser tekenen en de reden-lijst naast de CHECK-constraint leggen.
  window.__opvLeadHelpers = {
    leadModalHtml, LEAD_REDENEN, LEAD_REDEN_KEYS,
    zetModal: (m) => { _ui.modal = m; },
    huidigeModal: () => _ui.modal,
  };

  // Het gesprekspaneel, getest in tests/opvolging-whatsapp-gesprek.test.js.
  // O: het hertekenen, het concept, de draadscroll en de sluitregel. Getest in
  // tests/opvolging-gesprek-hertekenen.test.js met een echte DOM-dubbelganger.
  window.__opvHertekenHelpers = {
    huidigeViewHtml, isOnderaan, magSluiten, magEscapeSluiten,
    bewaarPaneelStaat, herstelPaneelStaat, herstelConcept, render, straks,
    DRAAD_ONDERAAN_MARGE,
    vingerafdruk: () => _laatsteHtml,
    zetVingerafdruk: (v) => { _laatsteHtml = v; },
  };

  window.__opvGesprekHelpers = {
    gesprekPaneelHtml, gesprekKanVersturen, gesprekBubbel, bepaalWaTimers,
    beschrijfHistoriek, historiekMelding, historiekOnbereikbaar,
    zetGesprek: (v) => Object.assign(_gesprek, v),
    zetWa: (v) => Object.assign(_wa, v),
    WA_POLL_GESPREK_MS,
  };

  // G3, getest in tests/opvolging-nu-doen.test.js. bepaalNuDoen is een pure
  // functie: de test voert er een klok in, geen browser.
  window.__opvNuHelpers = {
    bepaalNuDoen, nuDoenBalk, nuMinuut,
    SPRAAK_DEADLINE_UUR, NABEL_VAN_UUR, NABEL_TOT_UUR, CALL_DUUR_MIN, CALL_VOORUIT_MIN,
    zetTaken: (dag, lijst) => { _live.taken.key = dag; _live.taken.data = { taken: lijst || [], wacht: [] }; },
    zetCalls: (dag, lijst) => { _calls.key = dag; _calls.data = lijst || []; _calls.error = null; },
    zetWa: (v) => Object.assign(_wa, v),
  };

  // De achterstand van eerdere dagen, getest in
  // tests/opvolging-achterstand-zoomcalls.test.js.
  window.__opvAchterstandHelpers = {
    achterstandBlok, achterstandDag, callOp, callBadgeDag,
    zetAchterstand: (dag, lijst) => { _calls.key = dag; _calls.achterstand = lijst || []; },
    zetCalls: (dag, lijst) => { _calls.key = dag; _calls.data = lijst || []; _calls.error = null; },
  };

  window.__opvWeekHelpers = {
    bepaalWeek, basisMaandag, weekOffsetVoorDag, maandagVan, kortDatum,
    WEEKDAG_LABELS, WEEK_MIN_OFFSET, WEEK_MAX_OFFSET,
    // G1, getest in tests/opvolging-weekbalk-later.test.js: de tegelgetallen,
    // de balk zelf en de twee vensters, met een gezette staat in plaats van
    // een echte fetch.
    weekbalk, tegelGetal, balkModalHtml, tijdlijnBody, laterBody, langeDatum,
    zetBalk: (v) => Object.assign(_live.balk, v),
    zetLater: (v) => Object.assign(_live.later, v),
    zetTijdlijn: (v) => Object.assign(_live.tijdlijn, v),
    zetOffset: (n) => { _ui.weekOffset = n; },
    MODAL_BALK,
  };

  // De vensterlogica los na te slaan vanuit de console, en getest in
  // tests/opvolging-vensters.test.js tegen dit bestand zelf.

  // ═════════════════════════════════════════════════════════════════════════
  // R · HET DAGRAPPORT
  // ═════════════════════════════════════════════════════════════════════════
  //
  // Dit rapport gaat over een persoon. Elk getal wordt een gesprek tussen
  // Maxim en Dave, en een cijfer dat niet klopt kost niet alleen zichzelf maar
  // de geloofwaardigheid van het hele rapport. Vandaar drie regels die dit
  // scherm overal aanhoudt:
  //
  //   · Geen rapportcijfers en geen procentscores op iemands werk. Alleen
  //     aantallen en gemeten seconden.
  //   · Elk getal is uit te klappen naar de rijen eronder. Vier van de zes
  //     betekent dat je die twee kunt aanwijzen.
  //   · Een sectie die iets niet weet zegt dat, en dat staat óók bovenaan bij
  //     'Wat vraagt aandacht'. Stilte mag hier niet als goedkeuring lezen.
  //
  // Het rekenwerk staat in api/opvolging-rapport.js. Dit scherm telt niets
  // zelf; het toont wat het endpoint teruggeeft, inclusief de blinde vlekken.

  // De dag in Amsterdam, niet in UTC. De rest van dit bestand gebruikt
  // vandaag() (toISOString), en dat wijkt rond middernacht een dag af. Voor een
  // periodekeuze die 'gisteren' en 'vorige week' moet uitrekenen is dat het
  // verschil tussen het goede en het verkeerde rapport, dus hier een eigen.
  const vandaagNL = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  /** Maandag van de week waar deze dag in valt. */
  function maandagVan(dag) {
    const d = new Date(dag + 'T12:00:00Z');
    const dow = d.getUTCDay();              // 0 = zondag
    return dagPlus(dag, dow === 0 ? -6 : 1 - dow);
  }

  /**
   * De vijf periodekeuzes naar een echte reeks dagen.
   *
   * 'eigen' krijgt geen eigen rekenregel: dan staan van en tot al in de staat.
   */
  function periodeReeks(keuze, eigen) {
    const nu = vandaagNL();
    if (keuze === 'gisteren')    { const g = dagPlus(nu, -1); return { van: g, tot: g }; }
    if (keuze === 'deze_week')   { return { van: maandagVan(nu), tot: nu }; }
    if (keuze === 'vorige_week') { const m = dagPlus(maandagVan(nu), -7); return { van: m, tot: dagPlus(m, 6) }; }
    if (keuze === 'eigen' && eigen && eigen.van && eigen.tot) return { van: eigen.van, tot: eigen.tot };
    return { van: nu, tot: nu };   // vandaag
  }

  async function fetchRapport() {
    const { van, tot } = periodeReeks(_ui.rapportPeriode, _ui.rapportEigen);
    const sleutel = van + '..' + tot;
    const st = _live.rapport;
    if (st.loading || (st.key === sleutel && (st.data || st.error))) return;
    st.loading = true; st.error = null; st.key = sleutel;
    const j = await haal('/api/opvolging-rapport?van=' + encodeURIComponent(van) + '&tot=' + encodeURIComponent(tot));
    st.loading = false;
    if (j.__error) { st.error = j.__error; st.data = null; }
    else { st.data = j; st.error = null; }
    render();
  }

  window.__opvRapportPeriode = (keuze) => {
    _ui.rapportPeriode = keuze;
    _live.rapport.key = null; _live.rapport.data = null; _live.rapport.error = null;
    render();
  };
  window.__opvRapportEigen = () => {
    const van = (document.getElementById('opv-rap-van') || {}).value || '';
    const tot = (document.getElementById('opv-rap-tot') || {}).value || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(van) || !/^\d{4}-\d{2}-\d{2}$/.test(tot) || tot < van) {
      opvToast('Kies een begindatum en een einddatum, met het einde niet vóór het begin.');
      return;
    }
    _ui.rapportEigen = { van, tot };
    _ui.rapportPeriode = 'eigen';
    _live.rapport.key = null; _live.rapport.data = null; _live.rapport.error = null;
    render();
  };

  const PERIODE_LABEL = {
    vandaag: 'Vandaag', gisteren: 'Gisteren', deze_week: 'Deze week',
    vorige_week: 'Vorige week', eigen: 'Eigen reeks',
  };

  /** Uitklapbaar blok met de rijen onder een getal. */
  function rijenBlok(titel, rijen, maakRij) {
    if (!rijen || !rijen.length) return '';
    // <details> is hier bewust: geen bibliotheek, geen eigen staat, en dit
    // scherm hertekent niet uit zichzelf — er lopen geen timers op deze tab.
    return '<details class="opvr-rijen"><summary>' + esc(titel) + ' (' + rijen.length + ')</summary>' +
      '<div class="opvr-lijst">' + rijen.map(maakRij).join('') + '</div></details>';
  }

  const rapCel = (getal, label) =>
    '<div class="opvr-cel"><div class="opvr-getal">' + getal + '</div><div class="opvr-label">' + esc(label) + '</div></div>';

  function rapportView() {
    stijl();
    const st = _live.rapport;
    if (!st.loading && !st.error && !st.data) straks(fetchRapport);

    const { van, tot } = periodeReeks(_ui.rapportPeriode, _ui.rapportEigen);
    let h = '<div class="opv">' + periodeKiezer(van, tot);
    if (st.error) return h + fout(st.error, 'window.__opvRapportHerlaad()') + '</div>';
    if (st.loading || !st.data) return h + skel() + '</div>';

    const d = st.data;
    h += '<div class="ronde zacht">Periode <b>' + esc(nl(d.periode.van)) + '</b> tot en met <b>' +
      esc(nl(d.periode.tot)) + '</b> &middot; ' + d.periode.dagen + ' dag' + (d.periode.dagen === 1 ? '' : 'en') +
      '. Alle cijfers hieronder komen uit tijdstempels in onze eigen tabellen. ' +
      'Er staat geen rapportcijfer en geen geschatte werktijd in.</div>';

    h += sectieAandacht(d);
    h += sectieDekking(d);
    h += sectieTijdlijn(d);
    h += sectieVensters(d);
    h += sectieZoomcalls(d);
    // sectieWerkritme is opgegaan in sectieTijdlijn hierboven: allebei gingen
    // ze over de verdeling van het werk over de dag, en twee blokken daarover
    // onder elkaar is niet twee keer beter maar een rommelig rapport.
    h += sectieAfgehandeld(d);
    h += sectieVolume(d);
    return h + '</div>';
  }

  window.__opvRapportPdf = () => {
    const { van, tot } = periodeReeks(_ui.rapportPeriode, _ui.rapportEigen);
    // Een nieuw tabblad, zodat het rapportscherm blijft staan waar het stond.
    // De printweergave doet zelf requireAuth: dit rapport toont namen van
    // leads en mag nooit zonder sessie iets tonen.
    window.open('/modules/klanten-v2/rapport-print.html?van=' + encodeURIComponent(van) +
      '&tot=' + encodeURIComponent(tot), '_blank', 'noopener');
  };

  window.__opvRapportHerlaad = () => {
    _live.rapport.key = null; _live.rapport.data = null; _live.rapport.error = null;
    render();
  };

  function periodeKiezer(van, tot) {
    const knop = (k) => '<button class="obtn' + (_ui.rapportPeriode === k ? ' p' : '') +
      '" onclick="window.__opvRapportPeriode(\'' + k + '\')">' + esc(PERIODE_LABEL[k]) + '</button>';
    return '<div class="opvr-kop">' +
      '<div class="opvr-knoppen">' + ['vandaag', 'gisteren', 'deze_week', 'vorige_week'].map(knop).join('') + '</div>' +
      '<div class="opvr-eigen">' +
        '<input type="date" id="opv-rap-van" value="' + esc(van) + '">' +
        '<span>tot en met</span>' +
        '<input type="date" id="opv-rap-tot" value="' + esc(tot) + '">' +
        '<button class="obtn' + (_ui.rapportPeriode === 'eigen' ? ' p' : '') +
          '" onclick="window.__opvRapportEigen()">Toon</button>' +
      '</div>' +
      // De printweergave is een APARTE pagina met eigen opmaak, geen @media
      // print over dit scherm. Hij haalt hetzelfde endpoint op met dezelfde
      // periode en roept zelf print() aan; de gebruiker kiest 'Bewaar als PDF'.
      // Zelfde permissie — het endpoint erachter doet zijn eigen controle, dus
      // hier is geen aparte regel nodig.
      '<button class="obtn" onclick="window.__opvRapportPdf()">Salesrapport als PDF</button>' +
      '</div>';
  }

  // ── 1 · Wat vraagt aandacht ──────────────────────────────────────────────
  function sectieAandacht(d) {
    const lijst = d.aandacht || [];
    let h = '<div class="card opvr-sectie"><h3>1 &middot; Wat vraagt aandacht</h3>';
    if (!lijst.length) {
      // Deze zin mag alleen staan als er ook echt niets is. Blinde vlekken
      // komen als aandachtspunt binnen, dus een lege lijst betekent hier: alle
      // zes de secties konden kijken, en er is niets afwijkends gevonden.
      return h + '<div class="empty">Niets bijzonders in deze periode. Alle onderdelen konden gemeten worden.</div></div>';
    }
    h += '<div class="opvr-lijst">' + lijst.map((a) => {
      const merk = a.soort === 'blinde_vlek' ? 'opvr-grijs' : 'opvr-rood';
      return '<div class="opvr-regel ' + merk + '"><div class="opvr-t">' + esc(a.tekst) + '</div>' +
        (a.uitleg ? '<div class="opvr-u">' + esc(a.uitleg) + '</div>' : '') + '</div>';
    }).join('') + '</div>';
    return h + '</div>';
  }

  // ── 2 · Dekking ──────────────────────────────────────────────────────────
  function sectieDekking(d) {
    const k = d.dekking;
    let h = '<div class="card opvr-sectie"><h3>2 &middot; Dekking</h3>';
    if (k.openstaand_bekend) {
      const open = k.openstaand || [];
      const gedaan = open.filter((r) => r.behandeld);
      // HET LOSSE VIERDE GETAL IS WEG, EN VERVANGEN DOOR WAT HET BETEKENDE.
      //
      // Er stond '10 leads op de lijst · 9 kregen een poging · 1 kreeg niets ·
      // 15 leads met een poging'. Dat leest als een telfout, terwijl het het
      // interessantste getal van de sectie was: Dave had zes leads afgewerkt
      // die niet eens op zijn lijst stonden. Het rapport meldde dus wél de ene
      // vergeten lead en verstopte de zes extra — precies de verkeerde kant op
      // voor een rapport dat inspanning eerlijk hoort te tonen.
      //
      // Nu met naam en herkomst, in een eigen blok.
      const opLijst = new Set(open.map((r) => r.taak_id || r.naam));
      const extra = (k.behandeld || []).filter((r) => !opLijst.has(r.taak_id || r.naam));
      h += '<div class="opvr-kpi">' +
        rapCel(open.length, 'leads op de lijst') +
        rapCel(gedaan.length, 'kregen een poging') +
        rapCel(open.length - gedaan.length, 'kregen niets') +
        rapCel(extra.length, 'erbij, buiten de lijst') + '</div>';
      if (extra.length) {
        h += '<div class="ronde"><b>' + extra.length + ' lead' + (extra.length === 1 ? '' : 's') +
          ' die niet op de lijst stond' + (extra.length === 1 ? '' : 'en') +
          ' zijn toch afgewerkt.</b> Dat is werk dat nergens anders zichtbaar wordt; ' +
          'zie <i>Afgehandeld</i> voor wat er met die kaarten gebeurd is.</div>';
        h += rijenBlok('Erbij, buiten de lijst', extra, (r) =>
          '<div class="opvr-regel opvr-groen"><div class="opvr-t">' + esc(r.naam || 'Naamloos') +
          '</div><div class="opvr-u">' + r.bel + '&times; gebeld &middot; ' + r.wa + '&times; WhatsApp</div></div>');
      }
      h += rijenBlok('Kregen niets', k.onbehandeld || [], (r) =>
        '<div class="opvr-regel opvr-rood"><div class="opvr-t">' + esc(r.naam || 'Naamloos') + '</div></div>');
      h += rijenBlok('Kregen minstens één poging', gedaan, (r) =>
        '<div class="opvr-regel"><div class="opvr-t">' + esc(r.naam || 'Naamloos') +
        '</div><div class="opvr-u">' + r.bel + '&times; gebeld &middot; ' + r.wa + '&times; WhatsApp</div></div>');
    } else {
      // Geen nul en geen schatting: de vraag is voor deze periode niet te
      // stellen. Een nul zou lezen als een meting.
      h += '<div class="warn"><b>De lijst van een voorbije dag is niet bewaard.</b> ' +
        'Hoeveel leads er die dag actie nodig hadden, is dus niet te zeggen — dat cijfer staat hier bewust niet. ' +
        'Wat er wél uit tijdstempels volgt, staat hieronder: wie er in deze periode moeite kreeg.</div>';
      h += '<div class="opvr-kpi">' + rapCel(k.behandeld.length, 'leads met een poging') + '</div>';
    }
    h += rijenBlok('Alle leads met minstens één poging', k.behandeld, (r) =>
      '<div class="opvr-regel"><div class="opvr-t">' + esc(r.naam || 'Naamloos') +
      '</div><div class="opvr-u">' + r.bel + '&times; gebeld op ' + r.bel_dagen + ' dag' + (r.bel_dagen === 1 ? '' : 'en') +
      ' &middot; ' + r.wa + '&times; WhatsApp</div></div>');
    return h + '</div>';
  }

  // ── 2b · De tijdlijn ─────────────────────────────────────────────────────
  // De SVG komt kant-en-klaar van de server, precies zoals de printweergave
  // hem krijgt. Hier niets narekenen en niets tekenen: één grafiek, één bron.
  function sectieTijdlijn(d) {
    const dagen = d.tijdlijn || [];
    let h = '<div class="card opvr-sectie"><h3>2b &middot; De dag</h3>';
    if (!dagen.length) return h + '<div class="empty">Geen tijdlijn berekend voor deze periode.</div></div>';

    // DE TOON. Een gat is een BLINDE VLEK, geen verwijt: deze module ziet
    // alleen wat er in Opvolging gebeurt, niet de zoomcalls zelf en niet het
    // andere werk van de dag. Zonder die zin leest stilte als een aanklacht.
    h += '<div class="ronde">Elke belpoging, WhatsApp en ingeplande zoomcall op hun eigen tijdstip. ' +
      'De <b>hoogte</b> van een staaf is de gespreksduur — op een as van twaalf uur is een gesprek ' +
      'van anderhalve minuut te smal om te zien. <b>Een leeg stuk is een blinde vlek, geen verwijt:</b> ' +
      'deze module ziet alleen wat er in Opvolging gebeurt, niet het gesprek in een zoomcall en niet ' +
      'het werk dat elders is vastgelegd.</div>';

    // De twee rekensommen van het werkritme horen ONDER het beeld, niet in een
    // eigen blok: ze zeggen in cijfers wat de tijdlijn laat zien. De uur-balk
    // die daar eerst bij hoorde is vervallen — de kwartierstrook in de tijdlijn
    // toont hetzelfde, alleen fijner.
    const dr = d.drempels || {};
    const ritmeVan = (dag) => (d.werkritme || []).find((r) => r.dag === dag) || null;
    h += '<div class="ronde zacht">De werkdag loopt van <b>' + (dr.werkuur_van ?? 9) + ':00 tot ' +
      (dr.werkuur_tot ?? 21) + ':00</b>. Een stilte binnen die uren heet een gat vanaf <b>' +
      Math.round((dr.gat_drempel_min ?? 120) / 60) + ' uur</b>; onder <b>' +
      Math.round((dr.bezetting_drempel ?? 0.6) * 100) + '%</b> bezetting heet de dag geklonterd.</div>';

    for (const t of dagen) {
      const r = ritmeVan(t.dag);
      h += '<div class="opvr-tl"><div class="opvr-tl-kop"><b>' + esc(nl(t.dag)) + '</b>' +
        '<span>' + t.aantallen.bel + ' belpoging' + (t.aantallen.bel === 1 ? '' : 'en') +
        ' &middot; ' + t.aantallen.whatsapp + '&times; WhatsApp &middot; ' +
        t.aantallen.zoomcalls + ' zoomcall' + (t.aantallen.zoomcalls === 1 ? '' : 's') +
        ' &middot; ' + esc(t.venster.van) + '&ndash;' + esc(t.venster.tot) +
        (r ? ' &middot; ' + r.actieve_uren + ' van ' + r.werkuren + ' werkuren' : '') +
        '</span></div>' +
        t.svg +
        (t.verruimd ? '<div class="ronde zacht">' + esc(t.verruimd.reden) + '</div>' : '');
      for (const b of (r ? r.bevindingen : [])) h += '<div class="warn">' + esc(b.tekst) + '</div>';
      h += '</div>';
    }
    h += '<div class="opvr-tl-legenda">' +
      '<span><i style="background:#07835A"></i>gesprek (hoogte = duur)</span>' +
      '<span><i style="background:#E4F5EE;border:1px dashed #07835A"></i>gesproken, lengte onbekend</span>' +
      '<span><i style="background:#fff;border:1px solid #C22B3E"></i>niet opgenomen</span>' +
      '<span><i style="background:#E7EEFA;border:1px solid #1B5FBF"></i>WhatsApp uit</span>' +
      '<span><i style="background:#FBF0DE;border:1px solid #C2700A"></i>antwoord</span>' +
      '<span><i style="background:#EDE7FB;border:1px solid #6D3FD4"></i>zoomcall</span>' +
      '</div>';
    return h + '</div>';
  }

  // ── 3 · De twee vensters ─────────────────────────────────────────────────
  function sectieVensters(d) {
    const v = d.vensters;
    const uu = (n) => String(n).padStart(2, '0') + ':00';
    let h = '<div class="card opvr-sectie"><h3>3 &middot; De twee vensters per zoomcall</h3>' +
      '<div class="ronde zacht">Spraakbericht vóór ' + uu(d.drempels.spraak_voor_uur) + ', nabellen tussen ' +
      uu(d.drempels.nabel_van_uur) + ' en ' + uu(d.drempels.nabel_tot_uur) + '. ' +
      'Alleen leads met een zoomcall op die dag tellen mee.</div>';
    if (!v.rijen.length && !v.zonder_taak.length) {
      return h + '<div class="empty">Geen zoomcalls in deze periode.</div></div>';
    }
    h += '<div class="opvr-kpi">' +
      rapCel(v.spraak.op_tijd, 'spraak op tijd') +
      rapCel(v.spraak.te_laat, 'spraak te laat') +
      rapCel(v.spraak.niet_gedaan, 'geen spraakbericht') +
      rapCel(v.nabel.niet_gedaan, 'niet nagebeld') + '</div>';
    // Zoomleads zonder opvolgkaart: hun spraakbericht is wél gemeten (dat hangt
    // aan een nummer), hun belpogingen niet (die hangen aan een kaart). Dat
    // apart benoemen, want als 'niet nagebeld' zou het een verwijt zijn.
    if (v.nabel_niet_gemeten) {
      h += '<div class="ronde zacht">Bij ' + v.nabel_niet_gemeten + ' zoomcall' +
        (v.nabel_niet_gemeten === 1 ? '' : 's') + ' is het nabellen <b>niet te meten</b>: die lead heeft geen ' +
        'opvolgkaart, en belpogingen hangen aan een kaart. Het spraakbericht is er w&eacute;l uit af te lezen.</div>';
    }
    h += rijenBlok('Per zoomcall', v.rijen, (r) =>
      '<div class="opvr-regel"><div class="opvr-t">' + esc(r.naam || 'Naamloos') +
      ' <span class="opvr-u">' + esc(nl(r.dag)) + ' &middot; call ' + esc(r.call_tijd || '') + '</span></div>' +
      '<div class="opvr-u">Spraak: ' + vensterWoord(r.spraak) + ' &middot; Nabellen: ' + vensterWoord(r.nabel) + '</div></div>');
    if (v.zonder_taak.length) {
      h += '<div class="ronde zacht">' + v.zonder_taak.length + ' ingeplande call' +
        (v.zonder_taak.length === 1 ? '' : 's') + ' staan niet in de takenlijst, dus daar valt niets over te zeggen. ' +
        'Ze tellen hierboven niet mee &mdash; als \'geen spraakbericht\' zou dat een oordeel zijn over iets wat we niet gemeten hebben.</div>';
    }
    return h + '</div>';
  }

  function vensterWoord(o) {
    if (!o) return '—';
    if (o.staat === 'op_tijd')    return '<span class="tag t-green">op tijd' + (o.tijd ? ' ' + esc(o.tijd) : '') + '</span>';
    if (o.staat === 'te_laat')    return '<span class="tag t-red">te laat' + (o.tijd ? ' ' + esc(o.tijd) : '') + '</span>';
    if (o.staat === 'niet_gedaan') return '<span class="tag t-red">niet gebeurd</span>';
    // NIET GEMETEN IS GEEN N.V.T. 'n.v.t.' zegt dat het niet hoefde; dit zegt
    // dat we het niet konden zien. Ze door elkaar halen maakt van een gat een
    // vrijspraak.
    if (o.staat === 'niet_gemeten') {
      return '<span class="tag t-grey">niet gemeten' + (o.reden ? ' &middot; ' + esc(o.reden) : '') + '</span>';
    }
    return '<span class="tag t-grey">n.v.t.' + (o.reden ? ' &middot; ' + esc(o.reden) : '') + '</span>';
  }

  // ── 4 · De zoomcalls zelf ────────────────────────────────────────────────
  function sectieZoomcalls(d) {
    const lijst = d.zoomcalls || [];
    let h = '<div class="card opvr-sectie"><h3>4 &middot; De zoomcalls en hun uitkomst</h3>';
    if (!lijst.length) return h + '<div class="empty">Geen zoomcalls in deze periode.</div></div>';
    // Een call die nog moet plaatsvinden telt niet als 'zonder uitkomst'. Zo
    // stond er om acht uur 's ochtends zeven keer een verwijt over werk dat nog
    // niet gedaan hoefde te zijn.
    const teBeoordelen = lijst.filter((c) => c.staat === 'te_beoordelen');
    const gepland      = lijst.filter((c) => c.staat === 'gepland');
    const verzet       = lijst.filter((c) => c.staat === 'verplaatst');
    const afgezegd     = lijst.filter((c) => c.staat === 'geannuleerd');
    const onbekend     = lijst.filter((c) => c.staat === 'onbeoordeelbaar');
    const metUitkomst  = teBeoordelen.filter((c) => c.vastgelegd);
    // 'zoomcalls' telt alleen wat er echt staat: geannuleerd en verzet zijn
    // geen calls die doorgaan. Op 7 september meldde dit getal er zes terwijl
    // er drie waren, en dan is elke telling eronder verdacht.
    const echt = teBeoordelen.length + gepland.length;
    h += '<div class="opvr-kpi">' +
      rapCel(echt, 'zoomcalls') +
      rapCel(metUitkomst.length, 'met uitkomst') +
      rapCel(teBeoordelen.length - metUitkomst.length, 'zonder uitkomst') +
      rapCel(gepland.length, 'nog gepland') + '</div>';
    if (afgezegd.length) {
      // Een annulering is informatie voor Maxim, alleen geen verwijt aan Dave.
      h += '<div class="ronde zacht"><b>' + afgezegd.length + ' geannuleerd.</b> ' +
        afgezegd.map((c) => esc(c.naam || 'Naamloos') +
          (c.annulering_reden ? ' (' + esc(c.annulering_reden) + ')' : '')).join(' &middot; ') +
        ' &mdash; deze tellen niet mee en krijgen geen oordeel.</div>';
    }
    if (verzet.length) {
      h += '<div class="ronde zacht">' + verzet.length + ' afspraak' + (verzet.length === 1 ? '' : 'en') +
        ' hieronder is verzet naar buiten deze periode. Die worden niet beoordeeld.</div>';
    }
    if (onbekend.length) {
      h += '<div class="warn">' + onbekend.length + ' afspraak' + (onbekend.length === 1 ? '' : 'en') +
        ' met een status waarvan niet vaststaat of de call heeft plaatsgevonden (' +
        esc([...new Set(onbekend.map((c) => c.status_ruw))].join(', ')) +
        '). Die krijgen geen oordeel &mdash; dat zou een gok zijn.</div>';
    }
    h += '<div class="opvr-lijst">' + lijst.map((c) =>
      '<div class="opvr-regel' + (c.vastgelegd ? '' : ' opvr-grijs') + '">' +
      '<div class="opvr-t">' + esc(c.naam || 'Naamloos') + ' <span class="opvr-u">' + esc(nl(c.dag)) +
      ' &middot; ' + esc(c.tijd || '') +
      (c.staat === 'gepland' ? ' &middot; <span class="tag t-grey">gepland</span>' : '') +
      (c.staat === 'verplaatst' ? ' &middot; <span class="tag t-grey">verzet</span>' : '') +
      (c.staat === 'geannuleerd' ? ' &middot; <span class="tag t-grey">geannuleerd</span>' : '') +
      (c.staat === 'onbeoordeelbaar' ? ' &middot; <span class="tag t-grey">' + esc(c.status_ruw || '') + '</span>' : '') +
      '</span></div>' +
      '<div class="opvr-u">' + (c.vastgelegd
        ? 'Uitkomst: <b>' + esc(String(c.uitkomst).replaceAll('_', ' ')) + '</b>'
        // NIET 'Dave vulde niets in'. Dat het ontbreekt kan ook aan het systeem
        // liggen, en dat verschil is precies wat op 6 september gerepareerd is.
        // En een call die nog moet komen krijgt hier zijn eigen zin, geen klacht.
        : '<i>' + esc(c.reden_leeg || 'Geen uitkomst vastgelegd.') + '</i>') + '</div>' +
      // Het bewijsmateriaal bij de call. De zin komt van de server, zodat het
      // dagscherm, dit scherm en de print niet uit elkaar lopen.
      (c.belpogingen && c.belpogingen.gekoppeld
        ? '<div class="opvr-u opvr-bel' + (c.belpogingen.gesproken ? ' belraak' : '') + '">' +
          esc(c.belpogingen.samenvatting) +
          (c.belpogingen.pogingen.length
            ? ' <span class="opvr-bps">' + c.belpogingen.pogingen.map((p) =>
                '<span class="belbol ' + (p.soort === 'gesprek' ? 'gsp' : p.soort === 'te_kort' ? 'kort' : 'onb') + '">' +
                esc(p.tijd || '') + (p.duur_sec === null ? '' : ' &middot; ' + p.duur_sec + ' s') + '</span>').join('') +
              '</span>' : '') + '</div>'
        : c.belpogingen
          ? '<div class="opvr-u opvr-bel"><i>Deze call is niet aan een taak gekoppeld; er is geen belhistoriek om bij te zetten.</i></div>'
          : '') +
      (c.notitie ? '<div class="opvr-u opvr-notitie">' + esc(c.notitie) + '</div>' : '') +
      '</div>').join('') + '</div>';
    return h + '</div>';
  }



  // ── 5 · Afgehandeld ──────────────────────────────────────────────────────
  // Heette 'Uit de lijst gehaald' en toonde alleen archiveringen. Bryan en
  // Peter kregen op 7 september een beslissing en bleven open met een due
  // vooruit; die stonden nergens, en daardoor leek dat werk verdwenen.
  //
  // Dezelfde driedeling en DEZELFDE BEREKENING als het scherm Vandaag gedaan —
  // die komt van de server (d.afgehandeld), zodat scherm en PDF niet zeven
  // tegenover acht kunnen zeggen.
  function blokLeeg(zin) { return '<div class="empty"><i>' + esc(zin) + '</i></div>'; }

  function sectieAfgehandeld(d) {
    const dagen = d.afgehandeld || [];
    let h = '<div class="card opvr-sectie"><h3>5 &middot; Afgehandeld</h3>';
    if (!dagen.length) return h + blokLeeg('Er is voor deze periode niets berekend.') + '</div>';

    const som = (k) => dagen.reduce((n, x) => n + x.aantallen[k], 0);
    h += '<div class="opvr-kpi">' +
      rapCel(som('afgesloten'), 'afgesloten') +
      rapCel(som('doorgeschoven'), 'doorgeschoven') +
      rapCel(som('aangeraakt'), 'aangeraakt') + '</div>';

    const alles = (k) => dagen.flatMap((x) => x[k].map((r) => ({ ...r, dag: x.dag })));

    const afgesloten = alles('afgesloten');
    h += '<h4 class="opvr-blokkop">Afgesloten <span>' + afgesloten.length + '</span></h4>';
    h += afgesloten.length
      ? '<div class="opvr-lijst">' + afgesloten.map((a) =>
          '<div class="opvr-regel"><div class="opvr-t">' + esc(a.naam) + '</div>' +
          '<div class="opvr-u">' + esc(a.reden || 'zonder reden vastgelegd') +
          ' &middot; ' + esc(nl(a.dag)) + '</div></div>').join('') + '</div>'
      : blokLeeg('Er is niemand definitief uit de lijst gehaald.');

    const door = alles('doorgeschoven');
    h += '<h4 class="opvr-blokkop">Doorgeschoven <span>' + door.length + '</span></h4>';
    h += door.length
      ? '<div class="opvr-lijst">' + door.map((a) =>
          '<div class="opvr-regel"><div class="opvr-t">' + esc(a.naam) + '</div>' +
          '<div class="opvr-u">' + esc(a.wat) + ', komt terug op <b>' + esc(nl(a.terug_op)) +
          '</b>' + (a.notitie ? ' &mdash; ' + esc(a.notitie) : '') + '</div></div>').join('') + '</div>'
      : blokLeeg('Er is niemand doorgeschoven naar een volgende ronde.');

    const aan = alles('aangeraakt');
    h += '<h4 class="opvr-blokkop">Aangeraakt, nog open <span>' + aan.length + '</span></h4>';
    h += aan.length
      ? '<div class="opvr-lijst">' + aan.map((a) =>
          '<div class="opvr-regel"><div class="opvr-t">' + esc(a.naam) + '</div>' +
          '<div class="opvr-u">' + a.pogingen + ' poging' + (a.pogingen === 1 ? '' : 'en') +
          ', zonder beslissing</div></div>').join('') + '</div>'
      : blokLeeg('Er is niemand benaderd zonder dat er een beslissing viel.');

    return h + '</div>';
  }


  function moeiteWoord(m) {
    if (!m) return '';
    // 'n.v.t.' is geen vrijstelling maar een ander soort kaart: de lead zei
    // tijdens de call zelf nee. Rood zou een verwijt zijn voor iets waar niets
    // aan te doen viel.
    if (m.staat === 'nvt') return '<span class="tag t-grey" title="' + esc(m.reden || '') + '">n.v.t.</span>';
    if (m.staat === 'genoeg') return '<span class="tag t-green">ok</span>';
    return '<span class="tag t-red">te weinig pogingen</span>';
  }

  // ── 6 · Volume ───────────────────────────────────────────────────────────
  function sectieVolume(d) {
    const v = d.volume;
    let h = '<div class="card opvr-sectie"><h3>6 &middot; Volume</h3>';
    h += '<div class="opvr-kpi">' +
      rapCel(v.bel.uit, 'belpogingen') +
      rapCel(v.bel.gesproken, 'werden een gesprek') +
      rapCel(v.wa.uit + v.spraak.uit, 'WhatsApp uit') +
      rapCel(v.wa.in + v.spraak.in, 'WhatsApp in') + '</div>';
    if (v.bel.niet_opgenomen) {
      h += '<div class="ronde zacht">' + v.bel.niet_opgenomen + ' van de ' + v.bel.uit +
        ' belpogingen werd niet opgenomen. Dat is een poging, geen gesprek.</div>';
    }
    if (v.bel.te_kort) {
      // Een call van vier seconden is geen gesprek. Meetellen zou het rapport
      // iets anders laten meten dan het zegt, en wel in Daves voordeel.
      h += '<div class="ronde zacht">' + v.bel.te_kort + ' van de ' + v.bel.uit +
        ' calls kwam wel tot stand maar duurde korter dan ' + d.drempels.gesprek_min_sec +
        ' seconden. Die tellen als poging, niet als gesprek.</div>';
    }
    // WOORDEN MOETEN HETZELFDE BETEKENEN ALS IN DE CODE. Hier stond 'over alle
    // 9 gesprekken' terwijl het negen POGINGEN waren, waarvan er vijf een
    // gesprek werden. Als het rapport Dave beoordeelt en de woorden kloppen
    // niet, discussieert hij terecht over de meting in plaats van over zijn
    // werk.
    //
    //   poging  — Dave heeft gebeld. Telt altijd.
    //   gesprek — de verbinding kwam tot stand én duurde lang genoeg.
    //   contact — de verbinding kwam tot stand, ook een korte.
    h += '<div class="ronde zacht">Gemeten gesprekstijd: <b>' + minuten(v.bel.seconden) + '</b>' +
      (v.bel.zonder_duur
        // Geen gemiddelde over de rest schatten. Dat zou een som van aannames
        // zijn, en dat is precies wat dit rapport niet doet.
        ? ' over ' + (v.bel.uit - v.bel.zonder_duur) + ' van de ' + v.bel.uit + ' belpogingen. ' +
          'Van de andere ' + v.bel.zonder_duur + ' is geen duur vastgelegd; die worden niet geschat.'
        : ' over alle ' + v.bel.uit + ' belpogingen.') + '</div>';
    h += '<div class="opvr-kpi">' +
      rapCel(v.wa.uit, 'tekst uit') + rapCel(v.wa.in, 'tekst in') +
      rapCel(v.spraak.uit, 'spraak uit') + rapCel(v.spraak.in, 'spraak in') + '</div>';
    h += rijenBlok('Alle gebeurtenissen', v.rijen, (r) =>
      '<div class="opvr-regel"><div class="opvr-t">' + esc(r.naam || 'Onbekende lead') +
      ' <span class="opvr-u">' + esc(nl(r.dag)) + ' ' + esc(r.tijd || '') + '</span></div>' +
      '<div class="opvr-u">' + esc(r.soort) + ' &middot; ' + (r.richting === 'in' ? 'binnengekomen' : 'verstuurd') +
      (r.duur_sec != null ? ' &middot; ' + r.duur_sec + ' sec' : '') + '</div></div>');
    return h + '</div>';
  }

  function minuten(sec) {
    const s = Number(sec || 0);
    if (!s) return '0 minuten';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return (m ? m + ' min ' : '') + r + ' sec';
  }

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
  window.DFO.VIEWS['opvolging/Rapport'] = rapportView;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('opvolging');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('opvolging');

  console.debug('[opvolging-v2] takenlijst, calls van vandaag, dekking, archief, agenda en WhatsApp-koppeling');
})();
