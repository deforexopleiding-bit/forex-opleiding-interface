// api/_lib/opvolging-taak-poging.js
//
// Krijgt een verse taak meteen een belpoging mee, of niet?
//
// Die vraag lijkt klein maar stuurt het oordeel in Afgerond. De dekking op het
// dashboard telt belpogingen per dag; wat daar ten onrechte in staat, maakt van
// een lead die nooit gebeld is iemand die er al 1 van 2 heeft.
//
// De regel:
//   · 'wil_nog_beslissen' na een call → wél een poging. Dat gesprek is echt
//     gevoerd, en zonder die rij staat de nieuwe kaart op nul belpogingen
//     terwijl er net een half uur mee gepraat is.
//   · 'no_show_call' → GEEN poging. Er is niet gebeld; er kwam alleen niemand
//     opdagen bij de Zoom. Zou dit meetellen, dan staat de kaart vandaag op
//     1 van 2 terwijl Dave die persoon nog nooit aan de lijn heeft gehad.
//   · al het andere → geen poging, tenzij de caller er expliciet een meegeeft
//     en de reden dat toelaat.
//
// De regel staat hier en niet alleen in het scherm, zodat een oud tabblad of
// een andere caller hem niet kan omzeilen. Zie tests/opvolging-taak-poging.test.js.

/** Redenen waarbij een startpoging klopt: er is echt contact geweest. */
const REDEN_MET_CONTACT = new Set(['wil_nog_beslissen']);

/**
 * De poging-rij voor een net aangemaakte taak, of null.
 *
 * taakId    — de taak waar de poging aan hangt
 * reden     — de reden waarmee de taak is aangemaakt
 * resultaat — wat de caller wil vastleggen; leeg betekent: geen poging
 */
export function bepaalStartPoging({ taakId, reden, resultaat }) {
  if (!taakId) return null;
  if (!REDEN_MET_CONTACT.has(String(reden || ''))) return null;
  const tekst = resultaat == null ? '' : String(resultaat).trim();
  if (!tekst) return null;
  return {
    taak_id    : taakId,
    soort      : 'call',
    resultaat  : tekst.slice(0, 200),
    // Handmatig: een mens rondde deze call af. Het bliksem-icoon in de
    // historiek is voor wat de telefooncentrale zelf meet.
    automatisch: false,
  };
}

export { REDEN_MET_CONTACT };
