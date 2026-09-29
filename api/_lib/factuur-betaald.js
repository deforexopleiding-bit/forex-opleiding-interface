// api/_lib/factuur-betaald.js
//
// "Is deze factuur betaald?" — voor lezers die geld of zichtbaarheid aan die
// vraag hangen (mentorspiegel, bonussen).
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────
// Teamleader verrekent een creditnota met de factuur ('matched', due = 0,
// paid = true). Onze sync maakt daar status 'paid' en amount_paid = het
// volledige bedrag van, terwijl credited_amount óók het volledige bedrag is.
// Gemeten 29 september 2026: 281 van de 282 gecrediteerde facturen stonden zo
// als betaald. Een lezer die alleen op status 'paid' let, ziet een creditnota
// dus als betaling — bij de onboarding-spiegel betekende dat "eerste factuur
// betaald" in het LMS voor studenten die niets betaald hadden.
//
// Regel: een VOLLEDIG gecrediteerde factuur telt niet als betaald, wat de
// status ook zegt.

export const EPS = 0.005;

const n = (v) => Number(v) || 0;

/** Volledig gecrediteerd: creditnota's dekken het hele factuurbedrag. */
export function isVolledigGecrediteerd(inv) {
  const totaal = n(inv?.amount_total);
  return totaal > 0 && n(inv?.credited_amount) >= totaal - EPS;
}

/** Telt als betaald: status 'paid' én niet volledig gecrediteerd. */
export function telAlsBetaald(inv) {
  return !!inv && inv.status === 'paid' && !isVolledigGecrediteerd(inv);
}
