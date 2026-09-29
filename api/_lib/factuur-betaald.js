// api/_lib/factuur-betaald.js
//
// "Is deze factuur betaald?" — en wat is ECHT betaald als er een creditnota op
// staat. Pure functies; geen DB.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────
// Teamleader verrekent een creditnota met de factuur ('matched', due = 0,
// paid = true). De sync maakte daar status 'paid' en amount_paid = het
// volledige bedrag van, terwijl credited_amount óók het volledige bedrag was.
// Gemeten 29 september 2026: 281 van de 282 gecrediteerde facturen stonden zo
// als betaald (≈ € 146k "betaald" dat gecrediteerd was). Elke lezer die op
// status 'paid' of amount_paid let — mentorbonus, onboarding-spiegel,
// sales-bonus, rapporten — telde een creditnota als betaling.
//
// Twee lagen:
//   1. BRON (bepaalBetaalstand, gebruikt door invoice-upsert en de
//      creditnota-herberekening): amount_paid = wat ECHT betaald is, status
//      'credited' bij een volledige creditering zonder betaling.
//   2. VANGNET voor lezers die aan geld hangen (telAlsBetaald / betaaldBedrag):
//      een VOLLEDIG gecrediteerde factuur telt nooit als betaald, ook niet als
//      een oude rij nog 'paid' + amount_paid = totaal zegt.
//
// 'partially_credited' wordt NIET opgeslagen: de CHECK op invoices.status kent
// die waarde niet, en de UI leidt "Deels gecrediteerd" al af uit
// credited_amount (finance-invoices.js displayStatus). Een deels gecrediteerde
// factuur met een openstaande rest blijft open/partially_paid, zodat de
// aanmaning op de rest gewoon doorloopt.

export const EPS = 0.005;

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

/** Volledig gecrediteerd: creditnota's dekken het hele factuurbedrag. */
export function isVolledigGecrediteerd(inv) {
  const totaal = n(inv?.amount_total);
  return totaal > 0 && n(inv?.credited_amount) >= totaal - EPS;
}

/**
 * Telt deze factuur als BETAALD (voldaan) voor geld en zichtbaarheid?
 * Nooit bij een volledige creditering. Anders: status 'paid', of betaald +
 * gecrediteerd dekt het totaal (deels gecrediteerd, rest betaald).
 */
export function telAlsBetaald(inv) {
  if (!inv || isVolledigGecrediteerd(inv)) return false;
  if (inv.status === 'paid') return true;
  const totaal = n(inv.amount_total);
  return totaal > 0 && n(inv.amount_paid) + n(inv.credited_amount) >= totaal - EPS;
}

/** Het betaalde bedrag dat meetelt voor geld: 0 bij een volledige creditering. */
export function betaaldBedrag(inv) {
  return isVolledigGecrediteerd(inv) ? 0 : n(inv?.amount_paid);
}

/** Wat er nog openstaat: totaal − betaald − gecrediteerd (nooit negatief). */
export function openBedrag(inv) {
  return Math.max(0, r2(n(inv?.amount_total) - betaaldBedrag(inv) - n(inv?.credited_amount)));
}

/**
 * De bron-regel: status + ECHT betaald bedrag van een factuur.
 *
 * @param {object} p
 * @param {number} p.totaal           factuurbedrag incl. btw
 * @param {number} p.tlBetaald        wat Teamleader als voldaan ziet (payable − due);
 *                                    Teamleader telt een verrekende creditnota hierin mee
 * @param {number} p.gecrediteerd     som van de creditnota's op deze factuur
 * @param {number} p.echteBetalingen  som van onze payments-rijen (bewezen betaling)
 * @param {string} p.tlStatus         status volgens de oude mapping (concept/credited/paid/...)
 * @returns {{ status: string, betaald: number }}
 */
export function bepaalBetaalstand({ totaal, tlBetaald, gecrediteerd, echteBetalingen = 0, tlStatus }) {
  const c = Math.max(0, n(gecrediteerd));
  // Geen creditnota: gedrag exact zoals het altijd was.
  if (c <= EPS) return { status: tlStatus, betaald: r2(tlBetaald) };
  if (tlStatus === 'concept') return { status: 'concept', betaald: 0 };

  const t = n(totaal);
  // Teamleader verrekent de creditnota als "voldaan" → die eraf halen. Een
  // geregistreerde betaling in onze payments-tabel blijft altijd staan.
  let echt = Math.max(0, n(tlBetaald) - c, n(echteBetalingen));
  if (t > 0) echt = Math.min(echt, t);
  echt = r2(echt);

  if (t > 0 && echt >= t - EPS) return { status: 'paid', betaald: echt };          // echt volledig betaald
  if (tlStatus === 'credited' || (t > 0 && c >= t - EPS)) return { status: 'credited', betaald: echt };
  if (t - echt - c <= EPS) return { status: 'paid', betaald: echt };               // voldaan: deels betaald, deels gecrediteerd
  return { status: echt > EPS ? 'partially_paid' : 'open', betaald: echt };        // rest staat open → aanmaning loopt door
}
