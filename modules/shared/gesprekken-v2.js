// modules/shared/gesprekken-v2.js
//
// TWEE REKENSOMMETJES DIE HET GESPREKKENSCHERM NOG NIET MAAKTE.
//
// Uit de meting in docs/iris/02-gesprekken-audit.md, gat G3 en G9:
//
//   G3 — Het scherm toont "24u-venster is verlopen" pas als het te laat is.
//        Hoeveel tijd er nog is staat nergens, terwijl `last_inbound_at` al
//        in twee antwoorden meekomt. Je loopt dus tegen een muur op het
//        moment dat je wilt gaan typen, in plaats van drie seconden eerder
//        te weten dat je een andere zin moet bedenken.
//
//   G9 — `whatsapp_messages` houdt status, sent_at, delivered_at, read_at en
//        failed_reason bij. Het scherm toont er niets van. Een MISLUKT bericht
//        ziet er daardoor precies zo uit als een afgeleverd bericht. Van alle
//        tien gaten is dit het stilste en daarom het gemeenste: je denkt dat
//        je geantwoord hebt.
//
// Beide oplossingen zijn kleiner dan het gat: het zijn aftreksommen op
// gegevens die er al zijn. Ze staan hier apart omdat een rekensom die je kunt
// nakijken meer waard is dan een rekensom die verstopt zit in een regel opmaak
// van tweehonderd tekens.
//
// ── WAAROM GEEN ES-MODULE ────────────────────────────────────────────────────
// wanbetalers-v2.js is een gewoon script, geen module. Daarom hetzelfde
// patroon als icons.js: een IIFE die op `window` hangt én, als `module`
// bestaat, exporteert. Zo kunnen de tests dezelfde code draaien als de
// browser, in plaats van een tweede kopie na te rekenen.
//
// ── ALLES HIER IS EEN ZUIVERE FUNCTIE ────────────────────────────────────────
// Geen fetch, geen opmaak, geen `window`-status. Invoer erin, uitkomst eruit.
// De opmaak gebeurt in het scherm; wat hier staat is te testen zonder browser.

(function () {
  /** Het venster van Meta: 24 uur na het laatste bericht van de klant. */
  const VENSTER_MS = 24 * 3600 * 1000;

  /** Onder deze grens heet het venster "bijna dicht". Twee uur. */
  const BIJNA_DICHT_MS = 2 * 3600 * 1000;

  /**
   * Hoeveel venster is er nog?
   *
   * @param {string|number|Date|null} laatsteInbound  whatsapp_conversations.last_inbound_at
   * @param {number} [nu]  epoch-ms; los meegegeven zodat de test niet van de klok afhangt
   * @returns {{bekend: boolean, open: boolean, bijnaDicht: boolean,
   *            msResterend: number, tekst: string, titel: string}}
   *
   * `bekend: false` is uitdrukkelijk iets anders dan `open: false`. Een gesprek
   * waar nooit iets binnenkwam heeft geen venster dat "verlopen" is — er is
   * gewoon niets om te tonen. Wie dat verschil platslaat, zet "verlopen" onder
   * een gesprek dat nog moet beginnen.
   */
  function vensterStand(laatsteInbound, nu) {
    const leeg = { bekend: false, open: false, bijnaDicht: false, msResterend: 0, tekst: '', titel: '' };
    if (laatsteInbound === null || laatsteInbound === undefined || laatsteInbound === '') return leeg;

    const start = (laatsteInbound instanceof Date) ? laatsteInbound.getTime() : new Date(laatsteInbound).getTime();
    if (!Number.isFinite(start)) return leeg;

    const klok = Number.isFinite(Number(nu)) ? Number(nu) : Date.now();
    const rest = (start + VENSTER_MS) - klok;

    if (rest <= 0) {
      return {
        bekend: true, open: false, bijnaDicht: false, msResterend: 0,
        tekst: 'verlopen',
        titel: 'Het venster van 24 uur is voorbij — alleen een goedgekeurde template mag nog.',
      };
    }
    return {
      bekend: true,
      open: true,
      bijnaDicht: rest <= BIJNA_DICHT_MS,
      msResterend: rest,
      tekst: 'nog ' + duurKort(rest),
      titel: `Vrije tekst mag nog ${duurKort(rest)}. Daarna alleen een goedgekeurde template.`,
    };
  }

  /**
   * Een duur van milliseconden naar iets wat je in een badge kunt lezen.
   *
   * Boven het uur: "6u12" — de minuten met een voorloopnul, want "6u2" leest
   * als zes uur twee en dat is het niet. Onder het uur: "47m". Onder de
   * minuut: "<1m", want "0m" ziet eruit als verlopen terwijl het dat niet is.
   */
  function duurKort(ms) {
    const totaalMin = Math.floor(ms / 60000);
    if (totaalMin < 1) return '<1m';
    const uren = Math.floor(totaalMin / 60);
    const min = totaalMin % 60;
    if (uren < 1) return `${min}m`;
    return `${uren}u${String(min).padStart(2, '0')}`;
  }

  /**
   * Wat is er met dit verzonden bericht gebeurd?
   *
   * @param {string|null} status        whatsapp_messages.status
   * @param {string|null} [foutreden]   whatsapp_messages.failed_reason
   * @returns {null|{code: string, teken: string, label: string, kleur: string}}
   *
   * `null` betekent: toon niets. Dat is het antwoord voor oude rijen zonder
   * status — die zijn van vóór de statusbijhouding en er is niets over te
   * zeggen. Een vinkje eronder zetten zou een bewering zijn die we niet kunnen
   * waarmaken.
   *
   * Een status die we NIET kennen levert wel een teken op ('?'), met de ruwe
   * waarde in het label. Anders verdwijnt een nieuwe Meta-status stilletjes in
   * het niets en ziet hij eruit als afgeleverd — precies de fout die G9 is.
   */
  function verzendStand(status, foutreden) {
    const s = String(status ?? '').trim().toLowerCase();
    if (!s) return null;

    switch (s) {
      case 'read':
        return { code: 'read', teken: '✓✓', label: 'Gelezen', kleur: 'blue' };
      case 'delivered':
        return { code: 'delivered', teken: '✓✓', label: 'Afgeleverd', kleur: 'muted' };
      case 'sent':
        return { code: 'sent', teken: '✓', label: 'Verstuurd', kleur: 'muted' };
      case 'pending':
      case 'queued':
      case 'accepted':
        return { code: 'pending', teken: '⏳', label: 'Wordt verstuurd', kleur: 'muted' };
      case 'failed':
      case 'error':
      case 'undelivered': {
        const reden = String(foutreden ?? '').trim();
        return {
          code: 'failed',
          teken: '⚠',
          label: reden ? `Niet verstuurd — ${reden}` : 'Niet verstuurd',
          kleur: 'rood',
        };
      }
      default:
        return { code: 'onbekend', teken: '?', label: `Onbekende status: ${String(status).trim()}`, kleur: 'muted' };
    }
  }

  /**
   * ── G5, het deel dat nu al kan ────────────────────────────────────────────
   *
   * De filters in de gesprekslijst zijn status en zoeken. Wat ontbreekt is
   * precies waar je op wilt filteren: wacht op ons · wacht op klant · venster
   * bijna dicht · belofte vandaag · niet gekoppeld.
   *
   * Twee daarvan kunnen met de gegevens die er nu al zijn. De andere drie
   * hebben een toestand per gesprek nodig (G4) en komen later.
   *
   * LET OP HET VERSCHIL tussen de twee die hier staan — het is geen detail:
   *
   *   `venster_bijna_dicht` VERSMALT de lijst die je al zag.
   *   `niet_gekoppeld`      VERVANGT hem, en toont juist wat je nooit zag.
   *
   * Een gesprek zonder klantkoppeling heeft geen openstaande facturen, dus
   * `is_debtor` is onwaar en de wanbetalerslijst laat 'em weg. Dat is geen
   * fout in die lijst — het is de reden dat zulke gesprekken ongezien blijven
   * liggen. Een filter dat binnen de bestaande selectie zoekt zou daarom
   * altijd nul opleveren en eruitzien alsof er niets aan de hand is.
   *
   * Vandaar twee lijsten als invoer: `alle` (alles wat het endpoint gaf) en
   * `zichtbaar` (wat de lijst normaal toont). Welke van de twee de bron is,
   * hangt af van de gekozen stand, en staat hier in één functie in plaats van
   * verspreid door de opmaak.
   */
  const FOCUS_MODI = ['geen', 'venster_bijna_dicht', 'niet_gekoppeld'];

  /** Een onbekende stand is 'geen'. Zo kan een oude bladwijzer niets breken. */
  function leesFocus(ruw) {
    const s2 = String(ruw ?? '').trim().toLowerCase();
    return FOCUS_MODI.includes(s2) ? s2 : 'geen';
  }

  /**
   * @param {Array} alle        alle gesprekken uit het lijst-antwoord
   * @param {Array} zichtbaar   wat de lijst normaal toont (wanbetalers)
   * @param {string} modus      een van FOCUS_MODI
   * @param {number} [nu]       epoch-ms
   * @returns {Array}
   */
  function focusFilter(alle, zichtbaar, modus, nu) {
    const allesArr = Array.isArray(alle) ? alle : [];
    const zichtArr = Array.isArray(zichtbaar) ? zichtbaar : [];
    switch (leesFocus(modus)) {
      case 'venster_bijna_dicht':
        return zichtArr.filter((c) => {
          const v = vensterStand(c && c.last_inbound_at, nu);
          return v.bekend && v.open && v.bijnaDicht;
        });
      case 'niet_gekoppeld':
        return allesArr.filter((c) => c && !c.customer_id);
      default:
        return zichtArr;
    }
  }

  /**
   * Hoeveel gesprekken vallen er onder elke stand?
   *
   * Loopt via focusFilter, zodat de teller op de knop niet uit de pas kan
   * lopen met wat je ziet als je 'em indrukt. Twee keer dezelfde regel
   * uitschrijven is precies hoe dat wél gebeurt.
   */
  function focusTelling(alle, zichtbaar, nu) {
    return {
      venster_bijna_dicht: focusFilter(alle, zichtbaar, 'venster_bijna_dicht', nu).length,
      niet_gekoppeld: focusFilter(alle, zichtbaar, 'niet_gekoppeld', nu).length,
    };
  }

  /** Alleen uitgaande WhatsApp heeft een verzendstatus. Mail en inkomend niet. */
  function toontVerzendStand(bericht) {
    if (!bericht) return false;
    if (bericht.channel && bericht.channel !== 'whatsapp') return false;
    const richting = String(bericht.direction ?? '');
    return richting === 'out' || richting === 'outbound';
  }

  /**
   * ── G8 · hoe vaak de lijst opnieuw opgehaald moet worden ──────────────────
   *
   * De meting uit de audit: de gesprekslijst wordt elke ZES seconden volledig
   * opnieuw opgehaald, met limit=1000 en zonder paginering. Het endpoint rekent
   * zelf voor wat dat kost — bij 115 gesprekken ongeveer 90 KB per opvraging.
   * Dat is 900 KB per minuut, 54 MB per uur, 430 MB per werkdag per geopend
   * tabblad. Bij twee mensen het dubbele. En dat terwijl er in een rustig uur
   * misschien drie berichten binnenkomen.
   *
   * Er is óók een realtime-kanaal op `whatsapp_messages`. De poll is bedoeld
   * als vangnet, maar draait onvoorwaardelijk mee — of dat kanaal nu werkt of
   * niet. Dáár zit de winst: als het vangnet weet dat er iemand anders oplet,
   * hoeft het niet om de zes seconden te kijken.
   *
   * ── WAAROM DRIE STANDEN EN NIET TWEE ─────────────────────────────────────
   * "Kanaal verbonden" en "kanaal werkt" zijn niet hetzelfde. Een abonnement
   * kan keurig SUBSCRIBED melden terwijl RLS elk bericht wegfiltert; dan komt
   * er nooit iets binnen en zou een trage poll betekenen dat je berichten drie
   * kwartier te laat ziet. Er is geen manier om dat vooraf te weten.
   *
   * Dus verdient het kanaal zijn vertrouwen: verbonden levert een matige
   * versnelling op, en pas als er daadwerkelijk één gebeurtenis binnenkwam
   * gaat de poll echt omlaag. Bewijs boven belofte.
   *
   *   verborgen tabblad         →  niet pollen (en bij terugkomen meteen één keer)
   *   kanaal bewezen            →  45 s   ≈ 7 MB per uur
   *   kanaal verbonden, onbewezen →  20 s ≈ 16 MB per uur
   *   geen kanaal               →   6 s   ≈ 54 MB per uur  (zoals het nu is)
   */
  const POLL_MS = Object.freeze({
    geen_kanaal: 6000,
    onbewezen: 20000,
    bewezen: 45000,
  });

  /**
   * @param {{verborgen?: boolean, verbonden?: boolean, bewezen?: boolean}} stand
   * @returns {number|null} wachttijd in ms, of null = helemaal niet pollen
   */
  function pollInterval(stand) {
    const s2 = (stand && typeof stand === 'object') ? stand : {};
    if (s2.verborgen === true) return null;
    if (s2.verbonden !== true) return POLL_MS.geen_kanaal;
    return s2.bewezen === true ? POLL_MS.bewezen : POLL_MS.onbewezen;
  }

  /**
   * Mag er nu opgehaald worden?
   *
   * Aparte functie van pollInterval() omdat de tik van de timer en het besluit
   * om te halen twee verschillende dingen zijn: de timer blijft gewoon elke zes
   * seconden tikken (dat kost niets), en hier valt het besluit. Zo hoeft er
   * geen interval opnieuw opgebouwd te worden elke keer dat het kanaal van
   * gedachten verandert — en dat scheelt precies het soort race waarbij je twee
   * timers hebt zonder het te weten.
   */
  function magOphalen(stand, sindsLaatsteMs) {
    const wacht = pollInterval(stand);
    if (wacht === null) return false;
    // Let op de eerste regel. Number(null) is 0 en Number('') is 0, allebei
    // keurig eindig — zonder die controle leest "ik weet niet hoe lang het
    // geleden is" als "nul milliseconden geleden", en dan wordt er juist NOOIT
    // opgehaald. Dat is de verkeerde kant om: bij twijfel één keer te veel
    // halen is goedkoper dan een lijst die nooit vult.
    if (sindsLaatsteMs === null || sindsLaatsteMs === undefined || sindsLaatsteMs === '') return true;
    const sinds = Number(sindsLaatsteMs);
    if (!Number.isFinite(sinds)) return true;
    return sinds >= wacht;
  }

  /**
   * ── G2 · het ongedaan-venster ────────────────────────────────────────────
   *
   * Uit de audit: `__wbxInboxSend()` roept meteen `inbox-send` aan. Verstuurd
   * is weg. Eén verkeerde klik naar een boze klant is onherstelbaar, en het is
   * precies bij boze klanten dat je het snelst verkeerd klikt.
   *
   * ── WAAROM DE BEVESTIGING VERDWIJNT ──────────────────────────────────────
   * Er stond al een "weet je het zeker?"-venster vóór het versturen. Dat
   * verdwijnt als dit aan staat, en dat is geen versoepeling maar het
   * omgekeerde.
   *
   * Een bevestiging vooraf vraagt iets op het moment dat je het antwoord al
   * hebt bedacht: ja, natuurlijk, daarom klik ik. Je leest 'em na de derde
   * keer niet meer. Een ongedaan-venster grijpt in op het moment dat het
   * inzicht kómt — één seconde nadat je klikte, als je je eigen zin ziet
   * staan. Dat is precies wanneer je van gedachten verandert.
   *
   * Bijkomend: het scheelt een klik per antwoord, en de audit telde er vier.
   *
   * ── WAT DIT WEL EN NIET IS ───────────────────────────────────────────────
   * Het wachten gebeurt in het scherm, niet op de server. Sluit je het tabblad
   * binnen de dertig seconden, dan vertrekt het bericht NIET.
   *
   * Dat is een echte beperking, en hij valt de goede kant op: er gaat niets
   * ongewild weg. Het alternatief — de verzending op de server parkeren —
   * vraagt een tabel, een cron en een ingreep in de verzendweg die Joost
   * deelt. Dat is een aparte beslissing; deze versie lost het geval op waar de
   * klacht over ging (je klikt, je ziet het, je haalt het terug) zonder één
   * regel aan die verzendweg te veranderen.
   */
  const UITSTEL_MS = 30000;

  /**
   * Hoeveel tijd is er nog om terug te krabbelen?
   *
   * @param {number} tot   epoch-ms waarop het bericht vertrekt
   * @param {number} [nu]
   * @returns {{loopt: boolean, seconden: number, deel: number}}
   *
   * `deel` is een getal tussen 0 en 1 voor de balk. Hij telt AF: vol bij de
   * start, leeg als het weggaat. Andersom leest als "hij is bijna klaar met
   * laden", en dat is het tegenovergestelde van wat er gebeurt.
   */
  function uitstelRest(tot, nu) {
    const eind = Number(tot);
    if (!Number.isFinite(eind)) return { loopt: false, seconden: 0, deel: 0 };
    const klok = Number.isFinite(Number(nu)) ? Number(nu) : Date.now();
    const over = eind - klok;
    if (over <= 0) return { loopt: false, seconden: 0, deel: 0 };
    return {
      loopt: true,
      // Naar boven afronden: zolang er iets over is, staat er minstens 1.
      // "0 seconden" met een knop die nog werkt, is een tegenstrijdigheid.
      seconden: Math.ceil(over / 1000),
      deel: Math.max(0, Math.min(1, over / UITSTEL_MS)),
    };
  }

  /** Mag dit bericht nog teruggehaald worden? */
  function magNogTerug(tot, nu) {
    return uitstelRest(tot, nu).loopt;
  }

  // ── De draad in bladzijden (G8) ────────────────────────────────────────────
  //
  // De draad haalt de nieuwste 200 berichten op. Zit er meer, dan zegt het
  // endpoint dat met `heeft_meer` en geeft het de grens mee (`oudste_at`).
  // Doorvragen gaat met `?voor=<grens>`, en dat is KLEINER-OF-GELIJK: bij mail
  // is de tijdstempel op de seconde nauwkeurig, dus twee berichten in dezelfde
  // seconde is geen bedenksel, en met "kleiner dan" zou zo'n bericht op de
  // bladzijdegrens verdwijnen. Liever één bericht dubbel ophalen en het hier
  // eruit halen, dan het kwijtraken.

  /**
   * Waarop we een bericht herkennen.
   *
   * Niet het id alleen: een WhatsApp-bericht en een mail komen uit
   * verschillende tabellen, dus hun id's zeggen niets over elkaar. Alleen op
   * id ontdubbelen zou een mail laten verdwijnen omdat er toevallig een
   * WhatsApp-bericht met datzelfde id bestaat.
   */
  function draadSleutel(item) {
    if (!item || item.id === null || item.id === undefined) return null;
    return String(item.channel || '?') + ':' + String(item.id);
  }

  /**
   * Wat van de opgehaalde bladzijde is echt nieuw?
   *
   * Geeft ook terug of er iets bij zat. Zo niet, dan bestaat de hele
   * bladzijde uit berichten die we al hadden — dan komt doorvragen niet
   * verder en moet het scherm stoppen in plaats van dezelfde bladzijde
   * eindeloos op te halen.
   */
  function nieuweDraadItems(bestaand, binnengekomen) {
    const bekend = {};
    (Array.isArray(bestaand) ? bestaand : []).forEach(function (i) {
      const s = draadSleutel(i);
      if (s) bekend[s] = true;
    });
    const nieuw = (Array.isArray(binnengekomen) ? binnengekomen : []).filter(function (i) {
      const s = draadSleutel(i);
      // Zonder id kunnen we niets vergelijken. Liever één keer dubbel in beeld
      // dan een bericht dat je niet te zien krijgt.
      return s ? !bekend[s] : true;
    });
    return { nieuw: nieuw, vooruitgang: nieuw.length > 0 };
  }

  const API = {
    VENSTER_MS, BIJNA_DICHT_MS, FOCUS_MODI, POLL_MS, UITSTEL_MS,
    vensterStand, duurKort, verzendStand, toontVerzendStand,
    leesFocus, focusFilter, focusTelling,
    pollInterval, magOphalen,
    uitstelRest, magNogTerug,
    draadSleutel, nieuweDraadItems,
  };

  if (typeof window !== 'undefined') window.GESPREKKEN_V2 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
