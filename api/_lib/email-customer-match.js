// api/_lib/email-customer-match.js
//
// Match e-mailadressen naar customers.id met case-insensitieve lookup +
// deterministische tie-breaker bij dubbele kandidaten. Gedeelde helper
// tussen:
//   * api/sync-emails.js  — koppelt live tijdens IMAP-poll
//   * api/backfill-email-customer-id.js — koppelt bestaande NULL-rijen
// zodat sync en backfill *gegarandeerd hetzelfde antwoord* geven voor
// hetzelfde adres.
//
// ── Waarom deze module bestaat ──────────────────────────────────────
// De oude inline-lookup in sync-emails.js (regel ~250-275, versie
// vóór 2026-08-04) had 2 bugs die 8.580 van 9.155 mails (94%) op
// customer_id=NULL zetten in productie:
//
//   1) `.in('email', uniqAddrs)` is EXACT-case in PostgREST. Client-side
//      lowercase van from_address matchte niet met DB-rijen die de
//      capital-case bewaren (bv. 'N.Berghorst@live.nl' in customers).
//
//   2) Ambiguity-guard was hard: ≥2 customers met hetzelfde adres →
//      customer_id=NULL. In productie: ~150 adressen kwamen bij 2+
//      klanten voor (dupes, testdata), waardoor élke inbound-mail op
//      die adressen ongekoppeld bleef.
//
// ── Deterministische ranking bij ambiguity ──────────────────────────
// Wanneer >1 customer op hetzelfde lowercase-email matcht, kies EXACT
// één deterministisch:
//
//   Stap 1: niet-gearchiveerd EN niet-geanonimiseerd (harde eis;
//           customers die weg zijn, blijven weg).
//   Stap 2: heeft ≥1 open factuur (open_amount > 0). Als er een
//           duplicate is en één ervan heeft open geld, is DIE
//           gegarandeerd de operationeel-relevante klant.
//   Stap 3: meest recent aangemaakt (created_at DESC). Bij dubbele
//           records is de nieuwere meestal de "actieve"; de oude blijft
//           dan legacy/importresidu.
//   Stap 4: fallback op id lexicografisch (tie-breaker die altijd
//           uniek is; voor volledig-gelijke rows).
//
// Dit is een AANNAME — geen bewezen business-rule. Voordelen boven de
// oude harde NULL:
//   * 94% ontkoppelde mails krijgt eindelijk context in de thread
//   * Dubbele klanten kunnen later worden gemerged; ranking blijft
//     stabiel tussen sync-runs
// Nadelen:
//   * Als de "verkeerde" duplicate is gekozen (bv. de oude), staat de
//     mail in de verkeerde klantkaart. Correctie mogelijk via
//     /api/email-message-link-customer (bestaat al).
//
// ── API ────────────────────────────────────────────────────────────
// `resolveCustomerIdsForEmails(supabase, addresses)`
//   → Map<lowercase_email, customer_id | null>
//   Voert 2 queries uit: customers (case-insensitive OR) + invoices
//   (alleen als er ambigue matches zijn). Bij lege input: lege Map.
//   Fail-soft: bij DB-error returnt een lege Map (caller behandelt
//   dat als "geen matches" — customer_id blijft dan NULL, geen crash).

const MAX_ADDRESSES_PER_QUERY = 200; // Supabase URL-length guard voor .or()

function normalizeEmail(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim().toLowerCase();
}

// Escape voor PostgREST .or()-value: komma en haakjes zijn reserveerd.
// Realiter komen die niet voor in geldige e-mailadressen, maar defensief
// blokkeren voorkomt injection als een adres iets exotisch bevat.
function escapeForOr(s) {
  return String(s).replace(/,/g, '').replace(/[()]/g, '');
}

// Deterministische keuze uit >1 kandidaten. Zie header-doc voor rationale.
// candidates: [{ id, email, archived_at, anonymized_at, created_at }]
// hasOpenInvoiceByCustomerId: Map<id, boolean>
export function pickBestCandidate(candidates, hasOpenInvoiceByCustomerId) {
  const alive = candidates.filter(
    (c) => !c.archived_at && !c.anonymized_at
  );
  const pool = alive.length > 0 ? alive : candidates; // als álles weg is → hardste keuze uit dead-pool

  // Stap 2: heeft open factuur wint. Splitsen in 2 sub-pools.
  const withOpen = pool.filter((c) => hasOpenInvoiceByCustomerId.get(c.id) === true);
  const finalPool = withOpen.length > 0 ? withOpen : pool;

  // Stap 3+4: created_at DESC, dan id ASC voor stabiele tie-breaker.
  const sorted = [...finalPool].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    if (tb !== ta) return tb - ta; // meest recent eerst
    return String(a.id).localeCompare(String(b.id));
  });

  return sorted[0]?.id || null;
}

// Fetcht customers voor de gegeven lowercase-adressen (case-insensitieve
// match op customers.email via ILIKE). Returnt een array met alle hits,
// mogelijk meerdere per adres.
async function fetchCandidateCustomers(supabase, lowerAddrs) {
  if (lowerAddrs.length === 0) return [];
  // Chunk als er meer dan MAX_ADDRESSES_PER_QUERY adressen zijn, zodat
  // de URL onder de PostgREST-max blijft.
  const chunks = [];
  for (let i = 0; i < lowerAddrs.length; i += MAX_ADDRESSES_PER_QUERY) {
    chunks.push(lowerAddrs.slice(i, i + MAX_ADDRESSES_PER_QUERY));
  }
  const all = [];
  for (const chunk of chunks) {
    // OR-clause: email.ilike.a@x.nl OR email.ilike.b@x.nl OR ...
    const orClause = chunk
      .map((a) => `email.ilike.${escapeForOr(a)}`)
      .join(',');
    const { data, error } = await supabase
      .from('customers')
      .select('id, email, archived_at, anonymized_at, created_at')
      .or(orClause);
    if (error) {
      // Fail-soft: rest van de chunks proberen. Als álles faalt →
      // caller krijgt lege Map en laat customer_id NULL.
      console.warn('[email-customer-match] customers fetch fail:', error.message);
      continue;
    }
    if (Array.isArray(data)) all.push(...data);
  }
  return all;
}

// Voor de ambigue set: check per customer_id of ze open facturen hebben.
// Één batch-query op invoices met .in('customer_id', ids). Fail-soft:
// bij error → alle IDs krijgen `false` (dan valt de tie-breaker terug
// op created_at, wat nog steeds deterministisch is).
async function fetchHasOpenInvoiceMap(supabase, customerIds) {
  const map = new Map();
  if (customerIds.length === 0) return map;
  for (const id of customerIds) map.set(id, false); // default
  try {
    const { data, error } = await supabase
      .from('invoices')
      .select('customer_id')
      .in('customer_id', customerIds)
      .gt('open_amount', 0)
      .limit(customerIds.length * 10); // ruim genoeg; we willen alleen DISTINCT customer_id
    if (!error && Array.isArray(data)) {
      for (const r of data) {
        if (r?.customer_id) map.set(r.customer_id, true);
      }
    }
  } catch (e) {
    console.warn('[email-customer-match] invoices fetch fail:', e?.message);
  }
  return map;
}

// PUBLIEKE API — zie header.
export async function resolveCustomerIdsForEmails(supabase, addresses) {
  const out = new Map();
  const uniqLower = Array.from(new Set(
    (Array.isArray(addresses) ? addresses : [])
      .map(normalizeEmail)
      .filter(Boolean)
  ));
  if (uniqLower.length === 0) return out;

  const candidates = await fetchCandidateCustomers(supabase, uniqLower);
  // Groepeer per lowercase-email → array van candidates
  const byAddr = new Map();
  for (const c of candidates) {
    const key = normalizeEmail(c.email);
    if (!key) continue;
    if (!byAddr.has(key)) byAddr.set(key, []);
    byAddr.get(key).push(c);
  }

  // Verzamel alle customer_ids die in een ambigue set voorkomen — voor
  // die groep is de invoice-check relevant. Voor niet-ambigue (list=1)
  // is de invoice-check overslaan een gratis besparing.
  const ambiguousIds = new Set();
  for (const [, list] of byAddr) {
    if (list.length > 1) list.forEach((c) => ambiguousIds.add(c.id));
  }
  const hasOpenMap = await fetchHasOpenInvoiceMap(supabase, [...ambiguousIds]);

  for (const addr of uniqLower) {
    const list = byAddr.get(addr);
    if (!list || list.length === 0) {
      out.set(addr, null); // geen match — mail komt van onbekend adres
    } else if (list.length === 1) {
      // Blijft consistent met oude gedrag: 1 hit → direct koppelen,
      // ook als klant gearchiveerd is. Als de UI dat niet wil tonen
      // (zie thread-endpoint filter), is dat een display-choice.
      out.set(addr, list[0].id);
    } else {
      // Ambigue: gebruik ranking.
      out.set(addr, pickBestCandidate(list, hasOpenMap));
    }
  }
  return out;
}

// Exports voor tests.
export const _internals = {
  normalizeEmail,
  escapeForOr,
  pickBestCandidate,
  MAX_ADDRESSES_PER_QUERY,
};
