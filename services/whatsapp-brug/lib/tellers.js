// services/whatsapp-brug/lib/tellers.js
//
// Meten zonder te kijken.
//
// Er is een bericht stil gedropt tussen raakAan() en webhook.duw(): de brug zag
// om 17:38:57 iets gebeuren, maar er ging niets naar het CRM en er stond geen
// enkele waarschuwing in journalctl. Dat is precies het gat dat het
// privacyfilter noodzakelijkerwijs maakt — wat we niet mogen loggen, kunnen we
// ook niet terugvinden.
//
// De uitweg is niet dat filter opgeven maar tellen. Een teller zegt DAT er iets
// afviel en WAAROM, zonder te zeggen wie of wat. Van 'message_create: 0 gezien'
// naar 'message_create: 3 gezien, 3 genegeerd wegens niet_op_leadlijst' is het
// verschil tussen raden en weten, en het kost geen enkel gegeven.
//
// WAT HIER NOOIT IN MAG. Geen nummer, geen tekst, geen jid, geen bericht-id.
// Alleen gehele getallen, een event-type uit een vaste lijst en een reden uit
// een vaste lijst. Zou hier ooit een nummer bij moeten om iets te vinden, dan
// is het antwoord nee — dan is het probleem niet het gebrek aan gegevens maar
// het gebrek aan een teller die de juiste vraag stelt.

/** De drie gebeurtenissen die de brug van whatsapp-web.js krijgt. */
export const EVENT_TYPES = ['message', 'message_create', 'message_ack'];

/**
 * Waarom een gebeurtenis afvalt. Vaste lijst: een vrije reden zou vroeg of laat
 * een nummer of een stuk tekst gaan dragen.
 *
 *   niet_van_ons      — message_create van een binnengekomen bericht; die loopt
 *                       via het 'message'-event en hoort hier niet nog eens.
 *   niet_op_leadlijst — het privacyfilter. Dit is geen fout maar de bedoeling.
 *   groep             — groepsgesprek; daar zitten per definitie onbekenden in.
 *   geen_ack_soort    — ack-code die geen betekenis heeft (-1 of 0).
 *   onbruikbaar       — de bouwfunctie kon er niets van maken.
 */
export const REDENEN = ['niet_van_ons', 'niet_op_leadlijst', 'groep', 'geen_ack_soort', 'onbruikbaar'];

/** Hoe de identiteit van de tegenpartij eruitzag toen we hem lieten vallen. */
export const OPLOS_WEGEN = ['jid', 'contact', 'contact_zonder_nummer', 'mislukt', 'geen_jid'];

/**
 * De VORM van een jid, zonder de jid zelf.
 *
 * Twee gegevens: het domein achter de apenstaart en hoeveel cijfers ervoor
 * staan. '32456816410@c.us' wordt 'c.us/11'; een LID wordt 'lid/15'. Dat is
 * geen identificerend gegeven — een vast woord en een lengte — en het
 * beantwoordt in één blik de vraag waar we mee zitten: filteren we op een
 * telefoonnummer terwijl WhatsApp iets heel anders aanlevert?
 *
 * Nooit de cijfers zelf. Een lengte is een lengte; zodra hier een nummer in zou
 * staan is dit een logbestand met leadgegevens geworden.
 */
export function jidVorm(jid) {
  if (typeof jid !== 'string' || !jid) return 'geen';
  const stuk = jid.split('@');
  const cijfers = String(stuk[0] || '').replace(/\D/g, '').length;
  const domein = stuk.length > 1 ? String(stuk[1]).toLowerCase() : '';
  const bekend = ['c.us', 'lid', 'g.us', 's.whatsapp.net', 'broadcast'];
  const d = bekend.includes(domein) ? domein : (domein ? 'anders' : 'geen_domein');
  return d + '/' + cijfers;
}

export function maakTellers({ nu = () => new Date().toISOString() } = {}) {
  const leegPerReden = () => Object.fromEntries(REDENEN.map((r) => [r, 0]));
  const gezien       = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
  const doorgelaten  = Object.fromEntries(EVENT_TYPES.map((t) => [t, 0]));
  const genegeerd    = Object.fromEntries(EVENT_TYPES.map((t) => [t, leegPerReden()]));
  // Ack-codes als getallen. -1 en 0 betekenen 'nog niets'; 1/2/3/4 zijn de
  // echte statussen. Zien we alleen 0'en, dan weten we meteen waarom er niets
  // doorkomt zonder dat we een bericht hoeven te bekijken.
  const ackCodes = {};
  // De vorm van de identiteit bij wat afviel: 'c.us/11', 'lid/15'. Een domein
  // en een lengte, nooit de cijfers zelf.
  const vormen = {};
  // Hoe we aan het nummer kwamen dat we uiteindelijk gefilterd hebben.
  const opgelost = Object.fromEntries(OPLOS_WEGEN.map((w) => [w, 0]));
  let laatsteGenegeerd = null;   // { type, reden, vorm, tijd } — geen inhoud

  const geldigType  = (t) => EVENT_TYPES.includes(t);
  const geldigeReden = (r) => REDENEN.includes(r);

  return {
    /** Er kwam een gebeurtenis binnen. Altijd tellen, ook wat straks afvalt. */
    zag(type) { if (geldigType(type)) gezien[type] += 1; },

    /**
     * Hij viel af, en hierom. `jid` is optioneel en wordt NIET bewaard — alleen
     * zijn vorm, zodat zichtbaar wordt of we op de verkeerde soort identiteit
     * staan te filteren.
     */
    negeer(type, reden, jid) {
      if (!geldigType(type) || !geldigeReden(reden)) return;
      genegeerd[type][reden] += 1;
      const vorm = jid === undefined ? null : jidVorm(jid);
      if (vorm) vormen[vorm] = (vormen[vorm] || 0) + 1;
      laatsteGenegeerd = { type, reden, vorm, tijd: nu() };
    },

    /** Langs welke weg we aan het nummer kwamen. */
    oplossing(weg) { if (OPLOS_WEGEN.includes(weg)) opgelost[weg] += 1; },

    /** Hij ging door naar het CRM. */
    liet(type) { if (geldigType(type)) doorgelaten[type] += 1; },

    /** Welke ack-code kwam voorbij. Alleen het getal. */
    ack(code) {
      // Let op: Number(null) is 0 en Number('') ook. Zonder deze regel telt een
      // ontbrekende ack als code 0 — en dat is precies de bak waar we straks
      // naar kijken om te zien of WhatsApp iets bevestigd heeft. Een ontbrekende
      // waarde moet nergens verschijnen, niet als nul.
      if (typeof code !== 'number' && typeof code !== 'string') return;
      if (code === '') return;
      const n = Number(code);
      if (!Number.isFinite(n)) return;
      const k = String(Math.trunc(n));
      ackCodes[k] = (ackCodes[k] || 0) + 1;
    },

    /** Wat /status meestuurt. Puur getallen en vaste woorden. */
    status() {
      return {
        gezien     : { ...gezien },
        doorgelaten: { ...doorgelaten },
        genegeerd  : Object.fromEntries(EVENT_TYPES.map((t) => [t, { ...genegeerd[t] }])),
        ack_codes  : { ...ackCodes },
        vormen     : { ...vormen },
        opgelost   : { ...opgelost },
        laatste_genegeerd: laatsteGenegeerd ? { ...laatsteGenegeerd } : null,
      };
    },
  };
}
