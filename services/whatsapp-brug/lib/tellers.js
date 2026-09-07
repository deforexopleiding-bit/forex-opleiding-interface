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
export const REDENEN = ['niet_van_ons', 'niet_op_leadlijst', 'groep', 'geen_ack_soort', 'onbruikbaar',
  //   systeemtype       — WhatsApp stuurde geen bericht maar een systeemmelding
  //                       (e2e_notification en verwanten). Zie isEchtGesprek()
  //                       in lib/gebeurtenis.js.
  'systeemtype'];

/** Hoe de identiteit van de tegenpartij eruitzag toen we hem lieten vallen. */
export const OPLOS_WEGEN = ['jid', 'lidkaart', 'lidkaart_basis', 'contact',
  'contact_zonder_nummer', 'mislukt', 'geen_jid',
  //   onbruikbaar — er KWAM een antwoord, maar het was geen telefoonnummer.
  //                 Meestal het LID zelf, teruggegeven op de vraag wie dat LID
  //                 is. Dat stond eerder als opgelost.contact geboekt: de teller
  //                 zei succes terwijl er niets vertaald was, en daar zijn we
  //                 twee ronden op stukgelopen. Een fout antwoord hoort een
  //                 eigen naam te hebben.
  'onbruikbaar',
  //   lidkaart_basis — de kaart raakte pas na het afsnijden van het
  //                 apparaat-achtervoegsel. Apart geteld, want dit getal IS de
  //                 meting: blijft hij nul, dan was dat vermoeden onjuist.
];

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
  // En hoe LANG dat nummer was. Elf cijfers is een Belgisch telefoonnummer;
  // vijftien is opnieuw een LID. Dat onderscheid is het verschil tussen 'de
  // oplossing werkte' en 'de teller zei succes terwijl er niets vertaald is'.
  const opgelostVorm = {};
  // WAAROM DEZE VIER ERBIJ ZIJN. De kaart had 29 koppelingen en miste toch 67
  // van de 71 opzoekingen. Dat kan maar één ding betekenen: we schrijven weg
  // onder een sleutel waarmee niemand zoekt. Deze tellers leggen de twee kanten
  // van dezelfde kaart naast elkaar — alleen domein, lengte en een ja/nee over
  // het apparaat-achtervoegsel. Nooit een LID, nooit een nummer.
  const sleutelOpslag = {};   // vorm -> aantal, bij het VULLEN van de kaart
  const sleutelZoek   = {};   // vorm -> aantal, bij het BEVRAGEN van de kaart
  const sleutelRaak   = {};   // vorm -> aantal, alleen de treffers
  const onbruikbaarReden = {};
  // Welk systeemtype er geweigerd is, en hoe vaak. Alleen het type — dat is een
  // vast woord uit het WhatsApp-protocol, geen gegeven van iemand. Dit is de
  // meting waarmee we zien of de weigerlijst aangevuld moet worden: staat er een
  // onbekend type met een hoog aantal, dan hoort dat erbij.
  const systeemTypes = {};
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

    /**
     * Langs welke weg we aan het nummer kwamen, en hoe lang dat nummer was.
     *
     * `nummer` wordt NIET bewaard — alleen zijn cijferlengte, dezelfde truc als
     * bij jidVorm(). Zonder die lengte kan een teller 'contact: 3' melden
     * terwijl er drie keer een LID uit kwam, en dan meet je je eigen aanname.
     */
    oplossing(weg, nummer) {
      if (!OPLOS_WEGEN.includes(weg)) return;
      opgelost[weg] += 1;
      if (nummer === undefined) return;
      const lengte = String(nummer == null ? '' : nummer).replace(/\D/g, '').length;
      const sleutel = weg + '/' + lengte;
      opgelostVorm[sleutel] = (opgelostVorm[sleutel] || 0) + 1;
    },

    /**
     * De vorm waaronder we een koppeling WEGSCHRIJVEN.
     *
     * `vorm` komt uit sleutelVorm() en is dus al ontdaan van alles wat iemand
     * kan aanwijzen: een domein, een lengte en of er een apparaat-achtervoegsel
     * aan zat.
     */
    sleutelOpslag(vorm) {
      if (!vorm) return;
      sleutelOpslag[vorm] = (sleutelOpslag[vorm] || 0) + 1;
    },

    /**
     * De vorm waarmee we de kaart BEVRAGEN, en of het raak was.
     *
     * Naast elkaar gezet vertellen deze twee in één blik of de twee kanten van
     * de kaart dezelfde soort sleutel gebruiken. Staat er bij opslag 'lid/13'
     * en bij zoeken 'lid/13+apparaat', dan is dat het hele verhaal.
     */
    sleutelZoek(vorm, raak) {
      if (!vorm) return;
      sleutelZoek[vorm] = (sleutelZoek[vorm] || 0) + 1;
      if (raak) sleutelRaak[vorm] = (sleutelRaak[vorm] || 0) + 1;
    },

    /** Waarom een antwoord onbruikbaar was. Vaste woorden uit beoordeelKandidaat. */
    onbruikbaar(reden) {
      const r = String(reden || 'onbekend');
      onbruikbaarReden[r] = (onbruikbaarReden[r] || 0) + 1;
    },

    /** Hij ging door naar het CRM. */
    liet(type) { if (geldigType(type)) doorgelaten[type] += 1; },

    /**
     * Welk systeemtype we geweigerd hebben. ALLEEN het type.
     *
     * Losse teller naast negeer(), want de reden zegt alleen DAT het een
     * systeemtype was; hier staat WELK. Zonder dat tweede is niet te zien of de
     * weigerlijst compleet is, en dat is precies de vraag die deze lijst
     * openhoudt.
     */
    systeemtype(type) {
      const t = String(type == null || type === '' ? 'geen_type' : type).toLowerCase();
      // Begrensd: het is een vast woord uit het protocol, maar een eindeloze
      // sleutelruimte in /status is nooit de bedoeling.
      if (t.length > 40) return;
      // MOET MET EEN LETTER BEGINNEN. De eerste versie stond [a-z0-9_]+ toe, en
      // daar voldoet '32470123456' aan — een telefoonnummer als sleutel in
      // /status, in de teller die naar privacy vernoemd is.
      //
      // Er lekte niets, want systeemtype() wordt alleen met msg.type
      // aangeroepen. Dat is precies wat het gevaarlijk maakte: de wacht stond
      // er, hij was groen, en hij liet het ene ding door waarvoor hij bedoeld
      // is. Een protocolwoord begint met een letter; een nummer niet.
      if (!/^[a-z][a-z0-9_]*$/.test(t)) return;
      systeemTypes[t] = (systeemTypes[t] || 0) + 1;
    },

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
        opgelost_vorm: { ...opgelostVorm },
        // De twee kanten van de lidkaart naast elkaar. Lopen sleutel_opslag en
        // sleutel_zoek qua vorm uiteen, dan schrijven we weg onder een sleutel
        // waar niemand naar vraagt — en dan mist de kaart zonder foutmelding.
        sleutel_opslag: { ...sleutelOpslag },
        sleutel_zoek  : { ...sleutelZoek },
        sleutel_raak  : { ...sleutelRaak },
        onbruikbaar_reden: { ...onbruikbaarReden },
        systeem_types: { ...systeemTypes },
        laatste_genegeerd: laatsteGenegeerd ? { ...laatsteGenegeerd } : null,
      };
    },
  };
}
