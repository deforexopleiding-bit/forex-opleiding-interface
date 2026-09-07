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

import { deelSleutel, sleutelVorm } from './sleutel.js';

/**
 * Twee richtingen van dezelfde koppeling.
 *
 *   nummer → lid   voor versturen en voor het ophalen van historiek
 *   lid → nummer   voor het filter, zodat een LID de lead erachter vindt
 */
export function maakLidkaart() {
  let nummerNaarLid = new Map();
  let lidNaarNummer = new Map();
  // De VOLLEDIGE jid zoals WhatsApp hem gaf, niet uit cijfers heropgebouwd.
  // Dat onderscheid kostte een ronde: we bewaarden alleen de cijfers en plakten
  // er later zelf '@lid' achter. Werkt dat serialisatie-formaat ooit anders,
  // dan zoek je een gesprek op een id dat niet bestaat — en dan krijg je
  // 'geen gesprek gevonden' terwijl het er gewoon is. Wat je gekregen hebt,
  // bewaar je zoals je het gekregen hebt.
  let nummerNaarJid = new Map();
  let laatsteOpbouw = null;
  let laatsteFout = null;

  return {
    /**
     * Het nummer achter een LID, of null als we die koppeling niet kennen.
     *
     * TWEE INGANGEN, EN DAT IS DE HELE REPARATIE.
     *
     * Een binnenkomende jid kan een apparaat-achtervoegsel dragen
     * (`<lid>:<apparaat>@lid`). De brug plukte daar de cijfers uit met
     * replace(/\D/g,''), en dat LAST dat achtervoegsel vast aan het LID:
     * dertien cijfers worden er veertien. De kaart staat op de kale LID, dus
     * die opzoeking mist — zonder foutmelding, want een Map die niets vindt
     * klaagt niet.
     *
     * We proberen daarom eerst de volledige cijferreeks (zoals het altijd
     * ging), en pas daarna de kale basis. Welke van de twee raak was, komt
     * apart terug: `via` is 'vol' of 'basis'. Die twee blijven gescheiden in de
     * tellers, want het aantal basis-treffers IS de meting die het vermoeden
     * bevestigt of onderuithaalt.
     */
    zoekNummer(jidOfLid) {
      const deel = deelSleutel(jidOfLid);
      const vorm = sleutelVorm(jidOfLid);
      if (deel.vol) {
        const raak = lidNaarNummer.get(deel.vol);
        if (raak) return { nummer: raak, via: 'vol', vorm };
      }
      if (deel.basis && deel.basis !== deel.vol) {
        const raak = lidNaarNummer.get(deel.basis);
        if (raak) return { nummer: raak, via: 'basis', vorm };
      }
      return { nummer: null, via: null, vorm };
    },

    /** De oude ingang, ongewijzigd van gedrag. */
    nummerVoorLid(lid) {
      if (!lid) return null;
      return lidNaarNummer.get(String(lid)) || null;
    },

    /** De LID-cijfers bij een nummer, of null. */
    lidVoorNummer(nummer) {
      if (!nummer) return null;
      return nummerNaarLid.get(String(nummer)) || null;
    },

    /** De volledige jid bij een nummer, precies zoals WhatsApp hem gaf. */
    jidVoorNummer(nummer) {
      if (!nummer) return null;
      return nummerNaarJid.get(String(nummer)) || null;
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
    async bouw(nummers, zoekLid, meldVorm) {
      const lijst = Array.isArray(nummers) ? nummers : [];
      if (typeof zoekLid !== 'function') return { gevonden: 0, bekeken: 0, fouten: 0 };

      const nieuwNaarLid = new Map();
      const nieuwNaarNummer = new Map();
      const nieuwNaarJid = new Map();
      let fouten = 0;

      for (const nummer of lijst) {
        if (!nummer) continue;
        try {
          const lid = await zoekLid(nummer);
          if (!lid) continue;
          const volledig = String(lid);
          const deel = deelSleutel(volledig);
          const cijfers = deel.vol;
          if (!cijfers) continue;
          nieuwNaarLid.set(String(nummer), cijfers);
          // ONDER BEIDE VORMEN WEGSCHRIJVEN. Draagt wat WhatsApp hier teruggaf
          // een apparaat-achtervoegsel en de binnenkomende jid niet, of
          // andersom, dan vindt de opzoeking hem nu hoe dan ook. Twee sleutels
          // die naar dezelfde lead wijzen kost niets; een gemiste lead kost een
          // dag WhatsApp.
          nieuwNaarNummer.set(cijfers, String(nummer));
          if (deel.basis && deel.basis !== cijfers) nieuwNaarNummer.set(deel.basis, String(nummer));
          if (typeof meldVorm === 'function') meldVorm(sleutelVorm(volledig));
          // Alleen bewaren als er echt een domein bij zat; anders zouden we
          // straks alsnog zelf iets moeten verzinnen.
          if (volledig.includes('@')) nieuwNaarJid.set(String(nummer), volledig);
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
      nummerNaarJid = nieuwNaarJid;
      laatsteOpbouw = new Date().toISOString();
      laatsteFout = fouten > 0 ? fouten + ' nummer(s) leverden een fout op' : null;
      return { gevonden: nieuwNaarLid.size, bekeken: lijst.length, fouten };
    },

    /** Voor /status. Alleen aantallen en een tijdstip — nooit de koppelingen zelf. */
    status() {
      return {
        koppelingen   : nummerNaarLid.size,
        // Meer ingangen dan koppelingen betekent dat er LID's met een
        // apparaat-achtervoegsel bij zitten; dan staan beide vormen erin.
        ingangen      : lidNaarNummer.size,
        met_volledige_jid: nummerNaarJid.size,
        laatste_opbouw: laatsteOpbouw,
        laatste_fout  : laatsteFout,
      };
    },
  };
}
