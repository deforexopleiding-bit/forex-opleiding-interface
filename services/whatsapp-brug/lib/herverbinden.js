// services/whatsapp-brug/lib/herverbinden.js
//
// ZELFHERSTEL NA EEN VERBROKEN VERBINDING.
//
// Gemeten in whatsapp-web.js 1.34.7 (src/Client.js regel 847-853): bij een
// verbroken verbinding doet de bibliotheek `emit('disconnected')` gevolgd door
// `this.destroy()` — en verder NIETS. Hij probeert nooit opnieuw. Onze eigen
// handlers zetten daarna een vlaggetje en logden een regel.
//
// Gevolg: het Node-proces bleef vrolijk draaien met verbonden=false, systemd
// zag een gezond proces, en de brug lag stil tot iemand hem met de hand
// herstartte. Dat is het gat van eenentwintig uur waar deze module voor is.
//
// TWEE TRAPPEN, BEWUST:
//
//   1. In-proces opnieuw verbinden, met oplopende wachttijd. Een losgeraakte
//      websocket of een korte netwerkstoring is hiermee binnen seconden weg.
//   2. Lukt dat een aantal keer achter elkaar niet, dan sluiten we het proces
//      AF met een foutcode. `Restart=always` in de systemd-unit start dan een
//      volledig vers proces met een verse Chromium.
//
// Die tweede trap is er omdat een vastgelopen Chromium in hetzelfde proces
// niet te repareren is: je kunt de pagina niet meer aanspreken, dus ook niet
// opnieuw initialiseren. Eeuwig doorproberen in een kapot proces levert een
// brug op die 'aan het herverbinden' meldt en nooit meer terugkomt.
//
// De teller vóór die uitgang voorkomt het omgekeerde: bij een WhatsApp-storing
// van een half uur zou een proces dat meteen afsluit in een herstartlus komen,
// elke tien seconden een nieuwe Chromium, tot de VPS omvalt.

/** Oplopende wachttijd: 5s, 10s, 20s, 40s, 80s, daarna elke 120s. */
export const WACHTTIJDEN_MS = [5000, 10000, 20000, 40000, 80000];
export const MAX_WACHT_MS = 120000;

/** Zoveel mislukte pogingen achter elkaar, dan het proces verversen. */
export const POGINGEN_VOOR_VERVERSEN = 6;

export function wachttijdVoor(poging) {
  const i = Math.max(1, Number(poging) || 1) - 1;
  return i < WACHTTIJDEN_MS.length ? WACHTTIJDEN_MS[i] : MAX_WACHT_MS;
}

/**
 * De herverbinder. Puur genoeg om te testen: alles wat de buitenwereld raakt
 * (wachten, opnieuw verbinden, afsluiten, loggen) komt binnen als functie.
 *
 * @param {object} h
 * @param {() => Promise<void>} h.verbind      opnieuw initialiseren
 * @param {(ms, fn) => any}     h.plan         setTimeout-achtig
 * @param {(handle) => void}    h.annuleer     clearTimeout-achtig
 * @param {(code) => void}      h.beeindig     process.exit-achtig
 * @param {(soort, data) => void} [h.meld]     gebeurtenis naar het CRM
 * @param {(...a) => void}      [h.log]
 */
export function maakHerverbinder({ verbind, plan, annuleer, beeindig, meld = () => {}, log = () => {} }) {
  let poging = 0;
  let handle = null;
  let bezig = false;

  /** Een geslaagde verbinding wist het verleden. Anders loopt de teller vol op
   *  losse storinkjes verspreid over een week en sluit hij af zonder reden. */
  function gelukt() {
    if (handle) { annuleer(handle); handle = null; }
    if (poging > 0) log('[brug] weer verbonden na', poging, 'pogingen');
    poging = 0;
    bezig = false;
  }

  function verbroken(reden) {
    if (bezig) return;                 // al een poging onderweg; niet stapelen
    bezig = true;
    poging += 1;

    if (poging > POGINGEN_VOOR_VERVERSEN) {
      log('[brug]', poging - 1, 'pogingen mislukt — proces afsluiten voor een verse start');
      meld('brug_ververst', { pogingen: poging - 1, reden: String(reden || 'onbekend') });
      // Afsluiten met een foutcode: systemd ziet een mislukking en start
      // opnieuw. Exit 0 zou bij sommige Restart=-standen juist NIET herstarten.
      beeindig(1);
      return;
    }

    const wacht = wachttijdVoor(poging);
    log('[brug] verbinding verbroken (' + String(reden || 'onbekend') + ') — poging', poging, 'over', wacht / 1000, 's');
    handle = plan(wacht, async () => {
      handle = null;
      try {
        await verbind();
        // Niet hier gelukt() aanroepen: pas het 'ready'-event bewijst dat er
        // echt een verbinding staat. initialize() kan slagen en daarna alsnog
        // stukgaan. Dat onderscheid is precies wat we vandaag zes keer misten.
        bezig = false;
      } catch (e) {
        bezig = false;
        log('[brug] herverbinden faalde:', e?.message || e);
        verbroken('herverbinden faalde');
      }
    });
  }

  return {
    gelukt, verbroken,
    stand: () => ({ poging, bezig, wacht_ms: poging ? wachttijdVoor(poging) : 0 }),
  };
}
