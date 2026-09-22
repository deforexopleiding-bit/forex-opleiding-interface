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

  const API = {
    VENSTER_MS, BIJNA_DICHT_MS, FOCUS_MODI,
    vensterStand, duurKort, verzendStand, toontVerzendStand,
    leesFocus, focusFilter, focusTelling,
  };

  if (typeof window !== 'undefined') window.GESPREKKEN_V2 = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
