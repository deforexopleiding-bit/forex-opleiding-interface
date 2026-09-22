// api/_lib/iris/ochtend.js
//
// Het ochtendoverzicht, en de gezondheid van Iris.
//
// ── DE VIER VRAGEN ───────────────────────────────────────────────────────────
// De opdracht is precies: wat deed Iris, wat wacht op Maxim of Dave, wie moet
// er gebeld worden, welke beloftes vervallen vandaag. Vier vragen, vier
// blokken, en niets erbij.
//
// Dat "niets erbij" is de hele kunst van een ochtendoverzicht. Een lijst met
// veertien getallen leest niemand na de derde ochtend, en dan mist hij ook de
// twee getallen die er wél toe deden.
//
// ── NOOIT STIL "OK" ──────────────────────────────────────────────────────────
// Elke meting kan drie dingen zijn: goed, slecht, of NIET GEMETEN. Die derde
// is de belangrijkste en hij verdwijnt het makkelijkst. Een gezondheidsrapport
// dat bij een leesfout "ok" zegt, is erger dan geen rapport: dan denk je dat je
// kijkt terwijl je niets ziet.
//
// Dezelfde regel die cron-opvolging-gezondheid al hanteert.

export const NIET_GEMETEN = 'niet_gemeten';

/** Een meting die niet gelukt is. Nooit als nul of als 'ok' vermomd. */
export function nietGemeten(wat, reden) {
  return { wat, status: NIET_GEMETEN, reden: reden || 'onbekend', waarde: null };
}

/** Een gelukte meting. */
export function gemeten(wat, waarde, { grens = null, hoger_is_slechter = true } = {}) {
  let status = 'ok';
  if (grens !== null && Number.isFinite(waarde)) {
    const slecht = hoger_is_slechter ? waarde > grens : waarde < grens;
    if (slecht) status = 'let_op';
  }
  return { wat, status, waarde, grens };
}

/**
 * Hoe lang mag iets blijven liggen voordat het een probleem is?
 *
 * Een concept dat een uur klaarstaat is normaal — iemand is aan het werk. Een
 * concept dat achttien uur klaarstaat betekent dat er niemand meer kijkt, en
 * dan wacht er een klant op een antwoord dat er al is.
 */
export const GRENZEN = Object.freeze({
  concept_uren: 18,
  onverwerkt_uren: 2,
  goedgekeurd_minuten: 15,   // veel langer dan het ongedaan-venster van 30s
  niet_gekoppeld: 10,
});

/**
 * Bouw het ochtendoverzicht uit de gemeten blokken.
 *
 * Zuiver, zodat de samenvatting te testen is zonder databank — en die
 * samenvatting is het enige wat iemand leest.
 */
export function bouwOverzicht({ gedaan, wacht, bellen, beloftes, metingen = [] } = {}) {
  const problemen = metingen.filter((m) => m && (m.status === 'let_op' || m.status === NIET_GEMETEN));

  const regels = [];
  if (gedaan?.verstuurd || gedaan?.ingedeeld) {
    regels.push(`Iris deelde ${gedaan.ingedeeld || 0} bericht(en) in en verstuurde er ${gedaan.verstuurd || 0}.`);
  } else {
    regels.push('Iris heeft sinds gisteren niets verstuurd.');
  }
  if (wacht?.concepten) regels.push(`${wacht.concepten} antwoord(en) wachten op jouw ok.`);
  if (wacht?.opdrachten) regels.push(`${wacht.opdrachten} opdracht(en) wachten op een antwoord van jou.`);
  if (wacht?.niet_gekoppeld) regels.push(`${wacht.niet_gekoppeld} gesprek(ken) hangen nog niet aan een persoon.`);
  if (bellen?.open) regels.push(`${bellen.open} mens(en) staan op de belrij${bellen.escalatie ? `, waarvan ${bellen.escalatie} klaar voor escalatie` : ''}.`);
  if (beloftes?.vandaag) regels.push(`${beloftes.vandaag} betaalafspraak/-afspraken verlopen vandaag.`);

  return {
    samenvatting: regels,
    stil: regels.length === 1 && !wacht?.concepten && !bellen?.open && !beloftes?.vandaag,
    problemen,
    gezond: problemen.length === 0,
    gedaan: gedaan || {},
    wacht: wacht || {},
    bellen: bellen || {},
    beloftes: beloftes || {},
    metingen,
  };
}

/**
 * De tekst van de alarmmail, als er iets mis is.
 *
 * Alleen versturen als er echt iets is. Een dagelijkse mail die meestal "alles
 * goed" zegt, wordt na twee weken niet meer gelezen — en dan mist hij de ene
 * keer dat het wél mis was.
 */
export function alarmTekst(overzicht) {
  if (!overzicht?.problemen?.length) return null;
  const regels = ['Iris heeft iets gevonden dat aandacht vraagt:', ''];
  for (const p of overzicht.problemen) {
    if (p.status === NIET_GEMETEN) {
      regels.push(`  • ${p.wat}: NIET GEMETEN (${p.reden})`);
    } else {
      regels.push(`  • ${p.wat}: ${p.waarde}${p.grens !== null ? ` (grens: ${p.grens})` : ''}`);
    }
  }
  regels.push('');
  regels.push('Wat "niet gemeten" betekent: Iris kon dit niet nakijken. Dat is iets');
  regels.push('anders dan "er is niets aan de hand" — er valt op dit punt niets te zeggen.');
  return regels.join('\n');
}
