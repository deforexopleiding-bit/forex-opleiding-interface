// api/setter-payout-run.js
//
// UITGESCHAKELD (2026-10, setter-maandrapport). Setter-commissie wordt
// voortaan UITSLUITEND uitbetaald via de maandrapporten (Commissie →
// Rapporten, api/setter-reports.js: genereren → goedkeuren → uitbetaald).
// Dit endpoint bundelde vroeger vrijgegeven setter_ledger_entries in een
// setter_payouts-rij; twee uitbetaalpaden naast elkaar zou dubbel uitbetalen
// mogelijk maken. Daarom weigert het nu altijd met 410 Gone, zonder DB-call.
//
// Bewust behouden (niet verwijderd): een oude client of bookmark krijgt zo een
// duidelijke Nederlandse melding i.p.v. een 404.
// api/setter-payout-revert.js blijft werken voor eventuele historische
// setter_payouts-bundels.
//
// Raakt de MENTOR-uitbetaling niet: die loopt via api/mentor-payout-*.js en
// api/_lib/payout-generate-core.js.

export const UITBETAALRONDE_UIT_MELDING =
  'De uitbetaalronde voor setters is uitgeschakeld. Setter-commissie wordt '
  + 'uitbetaald via het maandrapport: Commissie → Rapporten → goedkeuren → uitbetaald.';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  return res.status(410).json({
    error: UITBETAALRONDE_UIT_MELDING,
    code: 'SETTER_UITBETAALRONDE_UIT',
    gebruik: '/modules/klanten-v2/#setter-payout (tab Rapporten)',
  });
}
