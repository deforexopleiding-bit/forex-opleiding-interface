// services/whatsapp-brug/lib/herkoppelen.js
//
// OPNIEUW KOPPELEN — de uitgang achter de koppelknop in het CRM.
//
// Op 23 september klikte Maxim op koppelen en kreeg hij een leeg venster. De
// brugserver leefde (de leadlijst werd om 18:04 nog opgehaald), maar de client
// lag eruit: verbonden=false, geen QR, geen fout, alle tellers nul, laatste
// actie van 06:04. Er was geen QR, en er was ook niets dat er een maakte.
//
// Deze functie breekt de client af en begint opnieuw, zodat er gegarandeerd óf
// een verbinding óf een QR komt.
//
// ── WISSEN IS EEN APARTE KEUZE ────────────────────────────────────────────
// Zonder wissen probeert whatsapp-web.js de bewaarde sessie te hervatten: dat
// is het snelst en vraagt geen telefoon. Maar juist als díe sessie stuk is
// blijft hij dan opnieuw hangen. Met `wisSessie` gaat de sessiemap weg en is
// een nieuwe QR onvermijdelijk — dat is de knop voor 'geef me gewoon een code'.
//
// ── ALLES WAT DE BUITENWERELD RAAKT KOMT BINNEN ALS FUNCTIE ───────────────
// Afbreken, wissen, opnieuw starten. Zo is elk pad na te rekenen met een
// nagebootste client die uit kan vallen, zonder puppeteer en zonder telefoon.

/**
 * @param {object} p
 * @param {object} p.staat            de gedeelde staat van de brug
 * @param {() => Promise<void>} p.afbreken   client.destroy()
 * @param {() => Promise<void>} p.wis        sessiemap weggooien
 * @param {() => Promise<void>} p.start      client.initialize()
 * @param {object} p.herverbinder     om de teller terug te zetten
 * @param {boolean} [p.wisSessie]
 * @param {(...a) => void} [p.log]
 */
export async function herkoppel({
  staat, afbreken, wis, start, herverbinder,
  wisSessie = false, log = () => {},
}) {
  log('[brug] herkoppelen gevraagd' + (wisSessie ? ' — sessie wissen' : ''));

  // De oude toestand meteen weg: een QR van een client die we net afbreken is
  // niet meer te scannen, en hem laten staan zou iemand ernaar laten kijken
  // terwijl er een nieuwe onderweg is.
  staat.verbonden = false;
  staat.qrDataUrl = null;
  staat.qrSindsIso = null;
  staat.laatsteFout = null;

  // Afbreken mag mislukken. Een client die al stuk is kun je niet netjes
  // sluiten, en dat is geen reden om niet opnieuw te beginnen — juist dán wil
  // je opnieuw beginnen.
  try { await afbreken(); } catch (e) {
    log('[brug] afbreken bij herkoppelen faalde (gaat door):', e?.message || e);
  }

  if (wisSessie) {
    try {
      await wis();
      log('[brug] sessiemap gewist — er komt een nieuwe QR');
    } catch (e) {
      // NIET stil doorgaan. Zonder wissen kan de oude, kapotte sessie
      // terugkomen en blijft de QR uit terwijl er juist om gevraagd is.
      staat.laatsteFout = 'sessie wissen faalde: ' + (e?.message || e);
      return { gestart: false, sessie_gewist: false, fout: staat.laatsteFout };
    }
  }

  // Teller terug op nul: dit is een verse start op verzoek van een mens. Zonder
  // dit telt deze poging door op een teller die misschien al bijna aan de
  // afsluitgrens zat, en sluit het proces af terwijl iemand staat te kijken.
  if (herverbinder && typeof herverbinder.gelukt === 'function') herverbinder.gelukt();

  try {
    await start();
  } catch (e) {
    staat.laatsteFout = 'herkoppelen faalde: ' + (e?.message || e);
    return { gestart: false, sessie_gewist: !!wisSessie, fout: staat.laatsteFout };
  }
  return { gestart: true, sessie_gewist: !!wisSessie, fout: null };
}
