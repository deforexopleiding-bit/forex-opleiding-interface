// services/whatsapp-brug/lib/hartslag.js
//
// DE BRUG MELDT ZELF DAT HIJ LEEFT.
//
// Een dagelijkse controle is diagnose, geen genezing: valt de brug om tien uur
// om, dan ontdekt de ochtendmail dat eenentwintig uur later. Deze hartslag
// haalt die eenentwintig uur terug naar minuten.
//
// TWEE SIGNALEN, EEN VERSCHILLEND KARAKTER:
//
//   hartslag              — elke paar minuten, 'ik leef en dit is mijn stand'.
//                           Blijft die weg, dan slaat het CRM alarm.
//   verbinding_verbroken  — op het MOMENT dat het gebeurt. Een verbroken
//                           verbinding is een gebeurtenis, geen toestand die je
//                           pas bij de volgende meting ontdekt.
//
// DE PRIVACYGRENS VERANDERT NIET. Hier gaat ALLEEN het feit dat de brug leeft
// overheen plus tellingen. Geen nummer, geen jid, geen berichttekst, geen
// naam. De leadlijst blijft de grens en die wordt hier niet eens geraadpleegd,
// want er is niets om te raadplegen: dit signaal gaat niet over een persoon.

/** Elke twee minuten een hartslag. Het CRM alarmeert pas bij een veelvoud. */
export const HARTSLAG_INTERVAL_MS = 120000;

export function maakHartslag({ duw, stand, plan = setInterval, annuleer = clearInterval,
                               intervalMs = HARTSLAG_INTERVAL_MS, log = () => {} }) {
  let timer = null;
  let geslagen = 0;

  function bouw() {
    const s = stand() || {};
    return {
      soort   : 'hartslag',
      tijdstip: new Date().toISOString(),
      verbonden: s.verbonden === true,
      // Alleen aantallen. Zie de kop: hier komt nooit een nummer of tekst in.
      gezien     : s.gezien ?? null,
      doorgelaten: s.doorgelaten ?? null,
      sinds      : s.sinds ?? null,
      herverbinden: s.herverbinden ?? null,
    };
  }

  async function sla() {
    geslagen += 1;
    // Niet awaiten op de aanroeper: een traag CRM mag de brug niet ophouden.
    // Mislukt hij, dan logt webhook.js dat al; het CRM merkt het vanzelf aan
    // de uitblijvende hartslag. Daarom is de alarmdrempel een VEELVOUD van dit
    // interval: één gemiste levering mag nooit een mail opleveren.
    try { await duw(bouw()); } catch (e) { log('[brug] hartslag mislukt:', e?.message || e); }
  }

  return {
    start() {
      if (timer) return;
      sla();                                   // meteen één, niet pas over 2 min
      timer = plan(sla, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      log('[brug] hartslag elke', intervalMs / 1000, 's');
    },
    stop() { if (timer) { annuleer(timer); timer = null; } },
    /** Directe melding bij een gebeurtenis die niet tot de volgende slag mag wachten. */
    async meld(soort, extra = {}) {
      try {
        await duw({ soort, tijdstip: new Date().toISOString(), ...extra });
      } catch (e) { log('[brug] melding mislukt:', e?.message || e); }
    },
    stand: () => ({ geslagen, interval_ms: intervalMs }),
  };
}
