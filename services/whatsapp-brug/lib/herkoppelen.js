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

// ── AFBREKEN MAG NIET BLIJVEN HANGEN ──────────────────────────────────────
// client.destroy() praat met puppeteer, en juist een client die vastzit is de
// reden dat er geknikkerd wordt. Zonder tijdslimiet blijft dit verzoek dan open
// staan, loopt het CRM in zijn eigen time-out en ziet Maxim 'de brug is niet
// bereikbaar' — terwijl de brug leeft en alleen de client dood is. Dat is
// precies het lege venster dat we weghalen, één laag dieper.
//
// Na de limiet gaan we gewoon dóór met opnieuw starten. Dat is bewust: een
// client die niet meer wíl sluiten is toch al niet te gebruiken, en met
// wis_sessie is de sessiemap daarna leeg, dus de nieuwe start kan niets anders
// dan een verse QR opleveren.
export const AFBREEK_TIJDSLIMIET_MS = 15000;
export const WIS_TIJDSLIMIET_MS     = 10000;

function metTijdslimiet(fn, ms, plan, annuleer) {
  return new Promise((klaar, mis) => {
    let af = false;
    const t = plan(ms, () => {
      if (af) return; af = true;
      mis(new Error('geen antwoord binnen ' + Math.round(ms / 1000) + 's'));
    });
    Promise.resolve().then(fn)
      .then((v) => { if (af) return; af = true; annuleer(t); klaar(v); })
      .catch((e) => { if (af) return; af = true; annuleer(t); mis(e); });
  });
}

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
  plan = (ms, fn) => setTimeout(fn, ms), annuleer = (h) => clearTimeout(h),
  afbreekLimietMs = AFBREEK_TIJDSLIMIET_MS,
  wisLimietMs = WIS_TIJDSLIMIET_MS,
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
  try { await metTijdslimiet(afbreken, afbreekLimietMs, plan, annuleer); } catch (e) {
    log('[brug] afbreken bij herkoppelen faalde (gaat door):', e?.message || e);
  }

  if (wisSessie) {
    try {
      await metTijdslimiet(wis, wisLimietMs, plan, annuleer);
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
