// api/_lib/camt-parser.js
// ISO 20022 CAMT.053 XML-parser. Returnt een gestructureerd object met
// statement-metadata + transactie-lijst klaar voor DB-insert.
//
// XML-structuur (defensief — banken vullen niet altijd elk veld):
//
//   Document
//     BkToCstmrStmt
//       Stmt
//         Id              (statement id)
//         CreDtTm         (creation timestamp)
//         Acct/Id/IBAN    (account IBAN)
//         Bal[*]          (balances)
//           Tp/CdOrPrtry/Cd  (OPBD/CLBD/OPAV/CLAV)
//           Amt @Ccy        (with currency attribute)
//           CdtDbtInd       (CRDT / DBIT)
//           Dt/Dt           (balance date)
//         Ntry[*]         (entries = transacties)
//           Amt @Ccy
//           CdtDbtInd     (CRDT = in, DBIT = uit)
//           Sts/Cd        (BOOK = booked)
//           BookgDt/Dt
//           ValDt/Dt
//           AcctSvcrRef   (entry reference — dedupe-anchor)
//           BkTxCd/Domn/Cd  (transaction code)
//           NtryDtls/TxDtls/...
//             Refs/EndToEndId
//             RltdPties/Cdtr/Nm + CdtrAcct/Id/IBAN
//             RltdPties/Dbtr/Nm + DbtrAcct/Id/IBAN
//             RmtInf/Ustrd[*]  (unstructured info, multi-line)
//           AddtlNtryInf  (fallback voor description)
//
// removeNSPrefix: true strip alle namespaces (xmlns="urn:iso:..."). ISO 20022
// CAMT.053 versies (.001.02 / .06 / .08) gebruiken verschillende namespaces;
// strippen geeft één robuuste codepad.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  removeNSPrefix:      true,
  parseTagValue:       false,    // alles als string; we casten zelf
  parseAttributeValue: false,
  trimValues:          true,
});

// Helpers — defensieve navigatie. Path kan deep zijn; sommige elementen
// kunnen ofwel single object of array zijn (XML-array-ambiguïteit).
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function pickFirst(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}
function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function isoDate(v) {
  if (!v) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}
// Bedrag: amount-element kan string ("1234.56") of getal zijn. *100 voor cents.
function toCents(amtRaw) {
  if (amtRaw == null) return null;
  const n = Number(String(amtRaw).trim());
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Parse de Bal[]-array van een Stmt; returnt {opening_cents, closing_cents, from, to}.
 * OPBD = Opening Booked; CLBD = Closing Booked. Sommige banken gebruiken OPAV/CLAV
 * (Available) — we vallen daarop terug als OPBD/CLBD ontbreken.
 *
 * Sign: CdtDbtInd = CRDT → positief, DBIT → negatief (overdraft).
 */
function extractBalances(balRaw) {
  const balances = asArray(balRaw);
  let opening = null, closing = null;
  let openingDate = null, closingDate = null;
  let openingAv = null, closingAv = null;
  let openingAvDate = null, closingAvDate = null;

  for (const b of balances) {
    const cd = b?.Tp?.CdOrPrtry?.Cd || b?.Tp?.CdOrPrtry?.Prtry || null;
    const amtCents = toCents(b?.Amt?.['#text'] ?? b?.Amt);
    if (amtCents == null) continue;
    const sign = String(b?.CdtDbtInd || 'CRDT').toUpperCase() === 'DBIT' ? -1 : 1;
    const value = sign * amtCents;
    const dt = isoDate(b?.Dt?.Dt);

    if (cd === 'OPBD') { opening = value; openingDate = dt; }
    else if (cd === 'CLBD') { closing = value; closingDate = dt; }
    else if (cd === 'OPAV') { openingAv = value; openingAvDate = dt; }
    else if (cd === 'CLAV') { closingAv = value; closingAvDate = dt; }
  }
  return {
    opening_cents: opening != null ? opening : openingAv,
    closing_cents: closing != null ? closing : closingAv,
    from:          openingDate || openingAvDate,
    to:            closingDate || closingAvDate,
  };
}

/**
 * Description-extractie. Prioriteer RmtInf/Ustrd (unstructured remittance info,
 * potentieel multi-line), valt terug op AddtlNtryInf.
 */
function extractDescription(ntry, txDtls) {
  // Eerst TxDtls RmtInf, dan top-level NtryDtls.
  const tx = txDtls || {};
  const ustrd = tx?.RmtInf?.Ustrd ?? ntry?.NtryDtls?.RmtInf?.Ustrd ?? null;
  if (ustrd) {
    const lines = asArray(ustrd).map(x => trimOrNull(x)).filter(Boolean);
    if (lines.length) return lines.join(' / ');
  }
  return trimOrNull(ntry?.AddtlNtryInf) || null;
}

/**
 * Counterparty-extractie. Voor CRDT (geld in) → Dbtr (debtor = betaler).
 * Voor DBIT (geld uit) → Cdtr (creditor = ontvanger).
 */
function extractCounterparty(txDtls, isCredit) {
  const parties = txDtls?.RltdPties || {};
  const party = isCredit ? (parties.Dbtr || {}) : (parties.Cdtr || {});
  const acct  = isCredit ? (parties.DbtrAcct || {}) : (parties.CdtrAcct || {});
  return {
    name: trimOrNull(party?.Nm),
    iban: trimOrNull(acct?.Id?.IBAN),
  };
}

/**
 * Parse één Ntry-element naar onze transactie-row.
 */
function parseEntry(ntry) {
  // CdtDbtInd op Ntry-niveau is autoritatief voor signed amount.
  const cdtDbt = String(ntry?.CdtDbtInd || '').toUpperCase();
  const isCredit = cdtDbt === 'CRDT';
  const amtRaw = ntry?.Amt?.['#text'] ?? ntry?.Amt;
  const cents = toCents(amtRaw);
  const signedCents = cents != null ? (isCredit ? cents : -cents) : null;

  // TxDtls kan single of array zijn (split-transacties). Voor v1: pak de eerste
  // — multi-detail split komt zelden voor op zakelijk rekening-verkeer.
  const txDtls = pickFirst(ntry?.NtryDtls?.TxDtls) || {};

  const cp = extractCounterparty(txDtls, isCredit);

  return {
    booking_date:      isoDate(ntry?.BookgDt?.Dt),
    value_date:        isoDate(ntry?.ValDt?.Dt),
    amount_cents:      signedCents,
    currency:          trimOrNull(ntry?.Amt?.['@_Ccy']) || 'EUR',
    description:       extractDescription(ntry, txDtls),
    counterparty_name: cp.name,
    counterparty_iban: cp.iban,
    end_to_end_id:     trimOrNull(txDtls?.Refs?.EndToEndId),
    transaction_code:  trimOrNull(ntry?.BkTxCd?.Domn?.Cd) || trimOrNull(ntry?.BkTxCd?.Prtry?.Cd),
    entry_reference:   trimOrNull(ntry?.AcctSvcrRef) || trimOrNull(txDtls?.Refs?.AcctSvcrRef),
    raw_xml:           null,  // gevuld door upload-handler op basis van source fragment
  };
}

/**
 * Hoofd-entry: parse een CAMT.053 XML-string.
 *
 * @param {string} xmlString
 * @returns {{ statement: {...}, transactions: [...] }}
 * @throws Error bij parse-fout of ontbrekende verplichte structuur
 */
export function parseCamt053(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('CAMT-parser: xmlString ontbreekt of niet-string');
  }
  let json;
  try { json = parser.parse(xmlString); }
  catch (e) { throw new Error('CAMT-parser: XML niet parsebaar — ' + e.message); }

  // Document → BkToCstmrStmt → Stmt (sommige banken pluralize naar Stmts)
  const root = json?.Document || json;
  const wrapper = root?.BkToCstmrStmt || root?.BkToCstmrAcctRpt || null;
  if (!wrapper) {
    throw new Error('CAMT-parser: <BkToCstmrStmt> root niet gevonden');
  }
  const stmtRaw = pickFirst(wrapper?.Stmt || wrapper?.Rpt);
  if (!stmtRaw) {
    throw new Error('CAMT-parser: <Stmt> niet gevonden onder BkToCstmrStmt');
  }

  const accountIban = trimOrNull(stmtRaw?.Acct?.Id?.IBAN);
  if (!accountIban) {
    throw new Error('CAMT-parser: account IBAN niet gevonden');
  }
  const balances = extractBalances(stmtRaw?.Bal);

  // Ntry kan single of array zijn.
  const ntryList = asArray(stmtRaw?.Ntry);
  const transactions = [];
  for (const ntry of ntryList) {
    try {
      const tx = parseEntry(ntry);
      // Sanity: skip entries zonder bookingsdatum of bedrag (corrupt).
      if (!tx.booking_date || tx.amount_cents == null) continue;
      transactions.push(tx);
    } catch (e) {
      // Eén corrupte entry mag de hele parse niet kapotmaken — log + skip.
      console.warn('[camt-parser] entry skipped:', e.message);
    }
  }

  return {
    statement: {
      account_iban:           accountIban,
      opening_balance_cents:  balances.opening_cents,
      closing_balance_cents:  balances.closing_cents,
      statement_from:         balances.from,
      statement_to:           balances.to,
      num_entries:            transactions.length,
    },
    transactions,
  };
}
