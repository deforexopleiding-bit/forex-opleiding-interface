// services/whatsapp-brug/lib/lidkaart.js
//
// De vertaaltabel tussen een telefoonnummer en de LID waaronder WhatsApp
// hetzelfde gesprek soms aanlevert.
//
// WAAROM DEZE KANT OP. De eerste poging loste de identiteit per binnenkomend
// bericht op: jid → contact → nummer. Dat meldde succes en leverde niets op,
// want wat een LID-contact teruggeeft is opnieuw het LID. En er zit een
// tweede bezwaar aan dat pas opvalt als je het opschrijft: bij die aanpak
// vraagt de brug 'wie is dit?' over ELKE binnenkomende jid — ook over mensen
// die géén lead zijn. Dat is precies het tegenovergestelde van wat het filter
// hoort te doen.
//
// Deze kant op is strenger. We beginnen bij de leadlijst — nummers die we al
// mogen kennen — en vragen WhatsApp welke identiteit daarbij hoort. Over wie
// niet op de lijst staat wordt niets gevraagd en niets bewaard.
//
// De kaart leeft alleen in geheugen. Na een herstart is hij leeg en bouwt hij
// zich opnieuw op bij de eerstvolgende leadlijst-ronde.

/**
 * Twee richtingen van dezelfde koppeling.
 *
 *   nummer → lid   voor versturen en voor het ophalen van historiek
 *   lid → nummer   voor het filter, zodat een LID de lead erachter vindt
 */
export function maakLidkaart() {
  let nummerNaarLid = new Map();
  let lidNaarNummer = new Map();
  let laatsteOpbouw = null;
  let laatsteFout = null;

  return {
    /** Het nummer achter een LID, of null als we die koppeling niet kennen. */
    nummerVoorLid(lid) {
      if (!lid) return null;
      return lidNaarNummer.get(String(lid)) || null;
    },

    /** De LID bij een nummer, of null. */
    lidVoorNummer(nummer) {
      if (!nummer) return null;
      return nummerNaarLid.get(String(nummer)) || null;
    },

    /**
     * De kaart opnieuw opbouwen uit de leadlijst.
     *
     *   nummers  — de toegestane nummers, genormaliseerd
     *   zoekLid  — async (nummer) => lid-string of null
     *
     * Per nummer gevangen: één nummer waarover WhatsApp niets weet mag de rest
     * van de lijst niet laten liggen. Mislukt alles, dan blijft de vórige kaart
     * staan — een storing hoort geen leads te laten wegvallen, dezelfde regel
     * als bij de leadlijst zelf.
     */
    async bouw(nummers, zoekLid) {
      const lijst = Array.isArray(nummers) ? nummers : [];
      if (typeof zoekLid !== 'function') return { gevonden: 0, bekeken: 0, fouten: 0 };

      const nieuwNaarLid = new Map();
      const nieuwNaarNummer = new Map();
      let fouten = 0;

      for (const nummer of lijst) {
        if (!nummer) continue;
        try {
          const lid = await zoekLid(nummer);
          const cijfers = lid ? String(lid).split('@')[0].replace(/\D/g, '') : '';
          if (!cijfers) continue;
          nieuwNaarLid.set(String(nummer), cijfers);
          nieuwNaarNummer.set(cijfers, String(nummer));
        } catch (_) {
          fouten += 1;
        }
      }

      // Niets gevonden én overal fouten: dan is er iets mis met de verbinding,
      // niet met de lijst. De oude kaart blijft dan staan.
      if (nieuwNaarLid.size === 0 && fouten > 0 && nummerNaarLid.size > 0) {
        laatsteFout = 'opbouw leverde niets op; vorige kaart blijft staan';
        return { gevonden: 0, bekeken: lijst.length, fouten, behouden: true };
      }

      nummerNaarLid = nieuwNaarLid;
      lidNaarNummer = nieuwNaarNummer;
      laatsteOpbouw = new Date().toISOString();
      laatsteFout = fouten > 0 ? fouten + ' nummer(s) leverden een fout op' : null;
      return { gevonden: nieuwNaarLid.size, bekeken: lijst.length, fouten };
    },

    /** Voor /status. Alleen aantallen en een tijdstip — nooit de koppelingen zelf. */
    status() {
      return {
        koppelingen   : nummerNaarLid.size,
        laatste_opbouw: laatsteOpbouw,
        laatste_fout  : laatsteFout,
      };
    },
  };
}
