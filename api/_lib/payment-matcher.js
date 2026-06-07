// api/_lib/payment-matcher.js
// Match-engine voor CAMT bank-transacties ↔ TL-facturen.
//
// Voor één inkomende camt_tx (amount_cents > 0) scoort elke open invoice op
// vier criteria. Returns candidates met score ≥ MIN_SCORE.
//
// Scoring:
//   +50  exact_amount               — bedrag exact match (in cents)
//   +30  invoice_number_in_text     — invoice_number voorkomt in description of end_to_end_id
//   +15  customer_name_match        — counterparty_name ↔ customer-naam case-insensitive substring
//    +5  date_within_30_days        — booking_date binnen 30 dagen van issue_date
//
// MIN_SCORE = 50 (exact bedrag is minimum). Multi-candidate per camt_tx
// mogelijk (eerder factuur kan ook hetzelfde bedrag hebben).

const MIN_SCORE = 50;
const DATE_WINDOW_DAYS = 30;

/**
 * Normaliseer een string voor case-insensitive vergelijking + trim.
 */
function norm(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Zoek een factuurnummer in vrije tekst. Factuurnummers hebben typisch
 * formaten zoals "2026/1030" (jaar + slash + serie) of "F2026-1030".
 * Strategie: word-boundary match op het hele nummer (case-insensitive,
 * "/" en "-" tellen niet als boundary in onze regex). We escapen
 * regex-special chars in het zoekwoord.
 */
function invoiceNumberInText(invoiceNumber, text) {
  if (!invoiceNumber || !text) return false;
  const escaped = String(invoiceNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Boundary: niet-alphanumeric voor en na (slash/dash zijn OK ín de match).
  const re = new RegExp('(^|[^A-Za-z0-9])' + escaped + '($|[^A-Za-z0-9])', 'i');
  return re.test(String(text));
}

/**
 * Klantnaam-match: counterparty_name bevat customer-naam (of vice versa),
 * case-insensitive substring. Heuristisch — voorkomt false positives op
 * korte voornamen ("Jan") door minimum 3 karakters te eisen.
 */
function customerNameMatch(camtName, customerName) {
  const a = norm(camtName), b = norm(customerName);
  if (a.length < 3 || b.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

function daysBetween(d1, d2) {
  const t1 = new Date(String(d1) + 'T00:00:00Z').getTime();
  const t2 = new Date(String(d2) + 'T00:00:00Z').getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Infinity;
  return Math.abs(t2 - t1) / (24 * 60 * 60 * 1000);
}

/**
 * Score één (camt_tx, invoice)-paar.
 *
 * @param {object} camtTx     row uit camt_transactions
 * @param {object} invoice    row uit invoices (incl. evt. joined customer-naam)
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreMatch(camtTx, invoice) {
  const reasons = [];
  let score = 0;

  // 1. Exact bedrag — invoice openstaand bedrag vs camt amount.
  //    amount_total - amount_paid = nog te ontvangen. amount_cents in camt
  //    is in cents; invoice.amount_total + amount_paid zijn in euro's (floats)
  //    omdat invoices-tabel zo opgeslagen wordt (zie fase 2A-fundament).
  const camtCents = Number(camtTx.amount_cents) || 0;
  const invOpenEur = Math.max(0, (Number(invoice.amount_total) || 0) - (Number(invoice.amount_paid) || 0));
  const invOpenCents = Math.round(invOpenEur * 100);
  if (camtCents > 0 && camtCents === invOpenCents) {
    score += 50;
    reasons.push('exact_amount');
  }

  // 2. Factuurnummer in description of end_to_end_id.
  const txText = [camtTx.description, camtTx.end_to_end_id].filter(Boolean).join(' ');
  if (invoiceNumberInText(invoice.invoice_number, txText)) {
    score += 30;
    reasons.push('invoice_number_in_description');
  }

  // 3. Klantnaam-match (via joined customer-naam veld op invoice).
  if (customerNameMatch(camtTx.counterparty_name, invoice.customer_name)) {
    score += 15;
    reasons.push('customer_name_match');
  }

  // 4. Datum binnen 30 dagen — booking_date vs invoice issue_date.
  const days = daysBetween(camtTx.booking_date, invoice.issue_date);
  if (days <= DATE_WINDOW_DAYS) {
    score += 5;
    reasons.push('date_within_30_days');
  }

  return { score, reasons };
}

/**
 * Match één camt_tx tegen alle openstaande invoices. Returns array sorted
 * op score DESC, alleen candidates met score ≥ MIN_SCORE.
 *
 * @param {object} camtTx
 * @param {object[]} openInvoices  invoices waarvan amount_paid < amount_total
 *                                  (status open/partially_paid/overdue)
 * @returns {{invoice_id, score, reasons}[]}
 */
export function matchCamtTransaction(camtTx, openInvoices) {
  const candidates = [];
  for (const inv of openInvoices) {
    const { score, reasons } = scoreMatch(camtTx, inv);
    if (score >= MIN_SCORE) {
      candidates.push({ invoice_id: inv.id, score, reasons });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

export const MATCH_MIN_SCORE = MIN_SCORE;
