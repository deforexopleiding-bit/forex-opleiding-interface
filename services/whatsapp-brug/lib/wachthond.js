// services/whatsapp-brug/lib/wachthond.js
//
// DE HERVERBINDER WORDT ALLEEN WAKKER ALS ER IEMAND AAN DE BEL TREKT.
//
// maakHerverbinder() hangt aan de gebeurtenissen `disconnected` en
// `auth_failure`. Komt er geen van beide — de pagina crasht stil, de websocket
// verdwijnt zonder event, Chromium valt om — dan is er niemand die 'verbroken'
// roept en gebeurt er NIETS. Geen poging, geen fout, geen spoor.
//
// Dat is precies wat er op 23 september gemeten is: de brugserver leefde (de
// leadlijst werd om 18:04 nog opgehaald, 63 nummers, http 200), maar
// verbonden=false, geen QR, geen fout, alle tellers nul, en de laatste actie
// was van 06:04. Twaalf uur stil, en niets dat het vertelde.
//
// Deze wachthond kijkt periodiek naar de werkelijke toestand in plaats van op
// een gebeurtenis te wachten:
//
//   verbonden          → niets doen.
//   er staat een QR    → niets doen; er wordt op een mens gewacht, niet op ons.
//   herverbinder bezig → niets doen; er loopt al een poging.
//   opgegeven          → niets doen; dat staat in /status en het proces hoort
//                        door systemd ververst te worden. Zelf blijven porren
//                        zou dat signaal wegpoetsen.
//   anders             → langer dan de drempel niets? Dan aan de bel trekken.
//
// De drempel is er om twee redenen. Bij het opstarten duurt het even voordat
// de eerste QR of verbinding er is, en meteen porren zou die start afbreken.
// En na een echte verbreking heeft de herverbinder zijn eigen oplopende
// wachttijd; die mag zijn werk doen zonder dat er van twee kanten getrokken
// wordt.

/** Zo vaak kijken. */
export const WACHTHOND_INTERVAL_MS = 60000;

/**
 * Zo lang mag het stil zijn voordat we aan de bel trekken.
 *
 * Ruim boven de langste wachttijd van de herverbinder (120s) plus één poging
 * met tijdslimiet (90s), zodat de wachthond nooit een lopende trap onderbreekt.
 */
export const WACHTHOND_STILTE_MS = 240000;

/**
 * Wat moet er nu gebeuren?
 *
 * Pure functie: geen timers, geen client, geen tijd van de klok. Zo is elk
 * geval na te rekenen zonder een halve WhatsApp-stack op te tuigen.
 *
 * @param {object} p
 * @param {boolean} p.verbonden
 * @param {boolean} p.heeftQr        staat er een QR klaar om te scannen?
 * @param {object}  p.herverbinden   stand() van de herverbinder
 * @param {number}  p.stilMs         hoe lang er niets meer gebeurd is
 * @param {number}  [p.stilteMs]     de drempel
 * @returns {{actie:'niets'|'porren', reden:string}}
 */
export function beoordeelWachthond({ verbonden, heeftQr, herverbinden, stilMs, stilteMs = WACHTHOND_STILTE_MS }) {
  if (verbonden) return { actie: 'niets', reden: 'verbonden' };
  // Een QR is geen storing maar een uitnodiging: er wordt op een mens gewacht.
  // Porren zou de code onder zijn handen vandaan verversen.
  if (heeftQr) return { actie: 'niets', reden: 'wacht op scan' };
  const h = herverbinden || {};
  if (h.bezig) return { actie: 'niets', reden: 'poging loopt al' };
  // Opgegeven is een toestand die ZICHTBAAR moet blijven. Zelf opnieuw
  // beginnen zou de melding in /status wissen en het gat weer dichtsmeren.
  if (h.opgegeven) return { actie: 'niets', reden: 'opgegeven — wacht op herstart' };
  if (!(Number(stilMs) >= 0)) return { actie: 'niets', reden: 'geen meting' };
  if (stilMs < stilteMs) return { actie: 'niets', reden: 'nog binnen de drempel' };
  return { actie: 'porren', reden: 'geen verbinding, geen QR, geen poging — ' + Math.round(stilMs / 1000) + 's stil' };
}

/**
 * De wachthond zelf. Alles wat de buitenwereld raakt komt binnen als functie,
 * zodat een test hem met een gezette klok kan doorlopen.
 */
export function maakWachthond({
  stand, porren, plan, annuleer,
  intervalMs = WACHTHOND_INTERVAL_MS,
  stilteMs = WACHTHOND_STILTE_MS,
  nu = () => Date.now(),
  log = () => {},
}) {
  let handle = null;
  let porren_totaal = 0;
  let laatstePorIso = null;

  function slag() {
    handle = null;
    let oordeel = { actie: 'niets', reden: 'stand onleesbaar' };
    try {
      const s = stand() || {};
      const laatste = s.laatsteActie ? Date.parse(s.laatsteActie) : NaN;
      oordeel = beoordeelWachthond({
        verbonden   : s.verbonden === true,
        heeftQr     : !!s.heeftQr,
        herverbinden: s.herverbinden || {},
        stilMs      : Number.isFinite(laatste) ? nu() - laatste : -1,
        stilteMs,
      });
    } catch (e) {
      // Een kapotte meting mag de wachthond niet stilzetten; dan valt juist
      // het vangnet weg op het moment dat er iets aan de hand is.
      log('[wachthond] stand lezen faalde:', e?.message || e);
    }
    if (oordeel.actie === 'porren') {
      porren_totaal += 1;
      laatstePorIso = new Date(nu()).toISOString();
      log('[wachthond] ' + oordeel.reden + ' — herverbinden aanzwengelen');
      try { porren(oordeel.reden); } catch (e) { log('[wachthond] porren faalde:', e?.message || e); }
    }
    start();
  }

  function start() {
    if (handle) return;
    handle = plan(intervalMs, slag);
    if (handle && typeof handle.unref === 'function') handle.unref();
  }

  return {
    start,
    stop() { if (handle) { annuleer(handle); handle = null; } },
    /** Alleen tellingen en tijdstempels; nooit een nummer of tekst. */
    stand: () => ({ porren: porren_totaal, laatste_por: laatstePorIso, interval_ms: intervalMs, stilte_ms: stilteMs }),
  };
}
