// api/_lib/dunning-template-render.js
//
// Pure helpers voor het renderen van dunning-templates. Geen DB-toegang;
// caller geeft customer + openInvoices door, deze module berekent variabelen
// en vervangt placeholders in subject + body.
//
// Twee-pass render:
//   PASS 1 (nieuw) — dot-notation via template-variables.resolveVariables:
//     {{klant.naam}}, {{klant.voornaam}}, {{klant.totaal_open}},
//     {{klant.factuur_lijst}}, {{klant.aantal_open}}, {{factuur.nummer}}, ...
//     Regex matcht alleen lowercase → hoofdletters blijven ongemoeid.
//     factuur.* single-keys wijzen naar de OUDSTE openstaande invoice.
//
//   PASS 2 (bestaand) — hoofdletter-keys (backward-compat, 12 productie-tpl's):
//     NAAM, FACTUUR_LIJST, FACTUUR_NR, TOTAAL_BEDRAG, DAGEN_OVERDUE, VERVAL_DATUM
//
// Bedragen: nl-NL locale, 2 fraction digits, prefix "EUR " (ASCII-vriendelijk
// voor mail-clients). Onbekende placeholders blijven staan (geen throw).

import { resolveVariables } from './template-variables.js';

const EUR_FORMATTER = new Intl.NumberFormat('nl-NL', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Public export sinds #wa-bulk-C+brief-B (bug 2 fix) — beide bulk-endpoints
// hebben een NL-euro-formatter nodig voor dry-run displays. Gedrag identiek
// aan de vorige private variant (returnt "EUR 80,00").
export function formatEur(amount) {
  const n = Number(amount) || 0;
  return `EUR ${EUR_FORMATTER.format(n)}`;
}

function formatDateNl(isoDate) {
  // isoDate: 'YYYY-MM-DD' (date kolom uit Postgres komt zo binnen).
  if (!isoDate) return '';
  const ymd = String(isoDate).slice(0, 10);
  const parts = ymd.split('-');
  if (parts.length !== 3) return ymd;
  return parts.reverse().join('-');
}

/**
 * Open bedrag per invoice: amount_total - amount_paid - credited_amount,
 * geklemd op >= 0. credited_amount kan ontbreken in schema → tolerant.
 */
export function openAmount(inv) {
  if (!inv) return 0;
  const total = Number(inv.amount_total) || 0;
  const paid = Number(inv.amount_paid) || 0;
  const credited = Number(inv.credited_amount) || 0;
  return Math.max(0, total - paid - credited);
}

/**
 * Kies een leesbare naam voor de klant. Tolerant: ondersteunt zowel oude
 * (company_name) als huidige (first_name + last_name) schema's.
 */
export function customerDisplayName(c) {
  if (!c) return 'klant';
  if (c.company_name && String(c.company_name).trim()) {
    return String(c.company_name).trim();
  }
  const first = (c.first_name || '').trim();
  const last = (c.last_name || '').trim();
  const full = `${first} ${last}`.trim();
  if (full) return full;
  return 'klant';
}

/**
 * Bereken alle template-variabelen voor een klant + lijst openstaande facturen.
 * Geeft een object met string-waarden terug; lege strings als er geen data is.
 */
export function computeVariables({ customer, openInvoices }) {
  const invoices = Array.isArray(openInvoices) ? openInvoices : [];

  const naam = customerDisplayName(customer);

  const factuurLijst = invoices
    .map((inv) => {
      const nr = inv.invoice_number || inv.id || '';
      return `- ${nr} (${formatEur(openAmount(inv))})`;
    })
    .join('\n');

  const factuurNr = invoices.length === 1
    ? String(invoices[0].invoice_number || invoices[0].id || '')
    : invoices.map((inv) => inv.invoice_number || inv.id || '').filter(Boolean).join(', ');

  const totaal = invoices.reduce((sum, inv) => sum + openAmount(inv), 0);
  const totaalBedrag = formatEur(totaal);

  // Oudste due_date (vroegste datum) → grootste dagen-overdue waarde.
  let oudsteDueIso = null;
  for (const inv of invoices) {
    if (!inv.due_date) continue;
    if (!oudsteDueIso || String(inv.due_date) < oudsteDueIso) {
      oudsteDueIso = String(inv.due_date).slice(0, 10);
    }
  }

  let dagenOverdue = 0;
  if (oudsteDueIso) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const due = new Date(`${oudsteDueIso}T00:00:00`);
    const diff = Math.floor((today.getTime() - due.getTime()) / 86400000);
    dagenOverdue = Math.max(0, diff);
  }

  return {
    NAAM: naam,
    FACTUUR_LIJST: factuurLijst,
    FACTUUR_NR: factuurNr,
    TOTAAL_BEDRAG: totaalBedrag,
    DAGEN_OVERDUE: String(dagenOverdue),
    VERVAL_DATUM: formatDateNl(oudsteDueIso),
  };
}

/**
 * Kies de OUDSTE openstaande invoice (vroegste due_date). Gebruikt als
 * context.invoice voor factuur.* single-keys — semantisch consistent met
 * {{FACTUUR_NR}}/{{VERVAL_DATUM}} die bij multi-factuur ook op de oudste
 * mapten. Fallback: eerste invoice als niks een due_date heeft.
 */
export function pickOldestInvoice(invoices) {
  if (!Array.isArray(invoices) || !invoices.length) return null;
  let oldest = null;
  for (const inv of invoices) {
    if (!inv?.due_date) continue;
    if (!oldest || String(inv.due_date) < String(oldest.due_date)) oldest = inv;
  }
  return oldest || invoices[0] || null;
}

/**
 * Render een template door alle placeholders in subject + body te vervangen.
 * Twee-pass: eerst dot-notation (delegate naar template-variables), daarna
 * hoofdletter-keys (backward-compat voor de 12 productie-templates).
 *
 * @returns {{subject:string, body:string, variables_used:object}}
 */
export function renderTemplate({ body, subject, customer, openInvoices }) {
  const invoices = Array.isArray(openInvoices) ? openInvoices : [];

  // ── Pass 1: dot-notation (klant.*, factuur.*, bedrijf.*, datum.*, ...) ──
  // resolveVariables is pure text+context; geen DB-calls. Regex matcht alleen
  // lowercase.dot-notation dus HOOFDLETTER-placeholders blijven staan voor
  // pass 2. factuur.* wijst naar de oudste openstaande invoice.
  const ctx = {
    customer,
    invoice:      pickOldestInvoice(invoices),
    openInvoices: invoices,
  };
  const subjRes = resolveVariables(subject == null ? '' : String(subject), null, ctx);
  const bodyRes = resolveVariables(body    == null ? '' : String(body),    null, ctx);

  let renderedSubject = subjRes.text;
  let renderedBody    = bodyRes.text;
  // Merge values uit beide fields (dot-notation-keys die daadwerkelijk
  // gerenderd zijn — resolveVariables voegt alleen matched keys toe).
  const variablesUsed = { ...(subjRes.values || {}), ...(bodyRes.values || {}) };

  // ── Pass 2: hoofdletter-keys (backward-compat) ──────────────────────────
  const variables = computeVariables({ customer, openInvoices });
  for (const [key, value] of Object.entries(variables)) {
    const placeholder = `{{${key}}}`;
    const before = renderedSubject + ' ' + renderedBody;
    renderedSubject = renderedSubject.replaceAll(placeholder, value);
    renderedBody = renderedBody.replaceAll(placeholder, value);
    if ((renderedSubject + ' ' + renderedBody) !== before) {
      variablesUsed[key] = value;
    }
  }

  return {
    subject: renderedSubject,
    body: renderedBody,
    variables_used: variablesUsed,
  };
}
