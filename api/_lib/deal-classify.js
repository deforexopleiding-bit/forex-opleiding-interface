// api/_lib/deal-classify.js
//
// Deal-classificatie voor het super_admin-dashboard trajecten-strip.
// Bepaalt per deal 1 van deze categorieën:
//   'm6'            — 1-op-1 6 maanden
//   'm12'           — 1-op-1 12 maanden
//   'm24'           — 1-op-1 24 maanden
//   'm_other'       — 1-op-1 met andere/onbekende looptijd (bv. 3 mnd)
//   'mem'           — membership / zelfstudie / lifetime (alle looptijden)
//   'other_product' — losse producten die geen traject zijn (Lascursus,
//                     IT Consultancy, Commissie See Finance, etc.)
//   'unknown'       — kan niet geclassificeerd worden
//
// ── Twee-sporen-detectie ──────────────────────────────────────────
//
// 1) `deal.traject_variant_id` gevuld → NIEUWE deal (wizard). Gebruik de
//    variant-lookup. Dit is de canonical bron voor deals gemaakt in dit
//    systeem. Prioriteit boven line-item scan.
//
// 2) `traject_variant_id` NULL → LEGACY deal (TL-import, source='tl_import').
//    Fallback: parse `deal_line_items.product_name` na genormaliseerde
//    fuzzy-match (lowercase + strip non-alfanum + collapse whitespace)
//    zodat spelfouten en schrijfvarianten samenvallen.
//
// ── Genormaliseerde matching ─────────────────────────────────────
//
// `normalize(s)` → `'Alpha Gramma 12 MND'` → `'alpha gramma 12 mnd'`.
// Dan matchen tegen genormaliseerde patterns. Dat dekt case + interpunctie +
// meervoudige spaties in 1 stap. Bij typfouten (Alfha, Deltha, maaanden)
// hebben de patterns flexibele varianten (`al(f|p)h?a`, `ma+nd(en)?`).
//
// ── Volgorde is kritiek ──────────────────────────────────────────
//
// De CASE-detectie loopt in vaste volgorde:
//   1. E-book        — nooit als eigen categorie (bijproduct)
//   2. Non-traject   — Lascursus / IT Consultancy / etc. → other_product
//   3. 1-op-1        — Alpha/Delta/Mentorship/etc.
//   4. Membership    — Gamma/Membership/Zelfstudie/Lifetime
//
// "Alpha Gramma" bevat zowel 'alpha' als 'gramma' → 1-op-1 wint (regel 3
// vóór regel 4). Bewuste keuze uit Jeffrey's aug-2026-mapping.
//
// ── Conflict-resolutie (line-item pad) ────────────────────────────
//
// Als een deal meerdere line-items heeft met verschillende trajecten:
//   * E-book en other_product tellen niet mee voor typebepaling
//     (E-book is bijproduct; other_product is losse verkoop náást
//     traject, geen conflict)
//   * Als 1 traject-categorie overblijft → die wint
//   * Als >1 verschillend → kies line-item met hoogste unit_price*quantity
//   * Alleen non-traject/ebook/unknown → deal krijgt de restcategorie
//
// ── API ──────────────────────────────────────────────────────────
//
// classifyDeal(deal, opts)
//   deal: { id, traject_variant_id, discount_percentage, total_amount, source }
//   opts: { lineItems: [{product_name, unit_price, quantity}], variantById: Map }
//   → { category: 'm6'|'m12'|'m24'|'m_other'|'mem'|'other_product'|'unknown',
//       source: 'variant'|'lineitems'|'fallback' }

// Genormaliseerde string voor fuzzy matching. Lowercase + alfanumeriek +
// enkele spaties. Voorbeeld: 'Alpha-Gramma 12 MND!!' → 'alpha gramma 12 mnd'.
function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── Patronen (matchen tegen genormaliseerde string) ──────────────
// `\b` werkt goed op de genormaliseerde string want alle non-alphanum is
// vervangen door spatie. `+` en `?` dekken typfouten (maaanden, maaand).

const RE_EBOOK       = /\b(ebook|e book)\b/;

// Losse producten die géén traject zijn. Voor de door Jeffrey genoemde
// concrete gevallen. Volgorde: eerst zodat "IT begeleiding" als niet-traject
// telt (edge-case; realistisch komt dat niet voor).
const RE_NON_TRAJECT = /\b(lascursus|it consultancy|see finance|sea finance|commissie|commisie)\b/;

// 1-op-1 begeleiding. Alpha + typfouten (alfha/apha/alpha gramma), Delta +
// typfouten (delta/deltha/dela/delta program), Mentorship + varianten
// (mentorshiptraject, mentorship management), "1 op 1", "1 1 mentor",
// "begeleiding".
const RE_ONE_ON_ONE  = /\b(alpha|alfha|apha|delta|deltha|dela|delta program|mentorship|mentorshiptraject|begeleiding|1 op 1|1 1 mentor)\b/;

// Membership / zelfstudie / lifetime. Gamma + typfouten (memberschip),
// zelfstudie(traject) + typfouten (zfstudie), lifetime.
const RE_MEMBERSHIP  = /\b(gamma|membership|memberschip|lidmaatschap|zelfstudie|zfstudie|zelfstudietraject|zfstudietraject|lifetime)\b/;

// Duration extract: getal + maand/maanden/mnd/m, flexibel voor typfouten
// (maaanden = 3×a). Match ook 'ma+nd(en)?' voor overlappende varianten.
const RE_DURATION    = /(\d+)\s*(?:ma+nden|ma+nd|mnd|m)\b/;

// Line-item family: 'ebook' / 'non_traject' / '1-op-1' / 'membership' / 'unknown'.
// Volgorde spiegelt CASE hierboven.
function classifyLineItemFamily(productName) {
  const norm = normalize(productName);
  if (!norm) return 'unknown';
  if (RE_EBOOK.test(norm))        return 'ebook';
  if (RE_NON_TRAJECT.test(norm))  return 'non_traject';
  if (RE_ONE_ON_ONE.test(norm))   return '1-op-1';
  if (RE_MEMBERSHIP.test(norm))   return 'membership';
  return 'unknown';
}

function extractDurationMonths(productName) {
  const m = normalize(productName).match(RE_DURATION);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Voor line-items: bepaal categorie op basis van family + duur.
function lineItemCategory(productName) {
  const family = classifyLineItemFamily(productName);
  if (family === 'ebook')        return 'ebook';        // sentinel — filter uit
  if (family === 'non_traject')  return 'other_product';
  if (family === 'unknown')      return 'unknown';
  const duur = extractDurationMonths(productName);
  if (family === '1-op-1') {
    if (duur === 6)  return 'm6';
    if (duur === 12) return 'm12';
    if (duur === 24) return 'm24';
    return 'm_other';  // 3 mnd, geen duur, of afwijkend
  }
  // family === 'membership' → alle looptijden inclusief lifetime bij elkaar.
  return 'mem';
}

// Fallback voor deals met traject_variant_id: gebruik variant-lookup.
function classifyFromVariant(deal, variantById) {
  const v = deal.traject_variant_id ? variantById.get(deal.traject_variant_id) : null;
  if (!v) return null;
  const dur = v.default_duration_months;
  const trajectName = String(v?.trajects?.name || v?.name || '').toLowerCase();
  const isMembership = trajectName.includes('membership') || trajectName.includes('lidmaatschap');
  if (isMembership) return 'mem';
  if (dur === 6)    return 'm6';
  if (dur === 12)   return 'm12';
  if (dur === 24)   return 'm24';
  return 'm_other';
}

// Kern-functie: hoofdroute via variant, fallback via line-items.
export function classifyDeal(deal, opts = {}) {
  const variantById = opts.variantById instanceof Map ? opts.variantById : new Map();
  const lineItems   = Array.isArray(opts.lineItems) ? opts.lineItems : [];

  // Route 1: variant-lookup (nieuwe deals).
  const viaVariant = classifyFromVariant(deal, variantById);
  if (viaVariant) return { category: viaVariant, source: 'variant' };

  // Route 2: line-items. Classificeer elk item + prijs.
  const scored = lineItems.map((li) => ({
    category: lineItemCategory(li?.product_name),
    value: (Number(li?.unit_price) || 0) * (Number(li?.quantity) || 1),
  }));

  if (scored.length === 0) {
    return { category: 'unknown', source: 'fallback' };
  }

  // Traject-cats (excl ebook/non_traject/unknown). Non_traject en ebook zijn
  // aparte concepten die deal-typebepaling niet mogen beïnvloeden.
  const trajectScored = scored.filter((s) => s.category !== 'ebook' && s.category !== 'non_traject' && s.category !== 'unknown');
  const trajectCats = new Set(trajectScored.map((s) => s.category));

  if (trajectCats.size === 1) {
    return { category: [...trajectCats][0], source: 'lineitems' };
  }
  if (trajectCats.size > 1) {
    // Conflict: duurste line-item wint.
    const winner = [...trajectScored].sort((a, b) => b.value - a.value)[0];
    return { category: winner.category, source: 'lineitems' };
  }

  // Geen traject-cat. Restcategorieën in volgorde:
  //   1) non_traject aanwezig  → 'other_product'
  //   2) unknown aanwezig      → 'unknown'
  //   3) alleen ebook          → 'unknown' (E-book alleen zonder traject
  //                              is een lege deal — nooit gezien in
  //                              productie, maar veilige fallback)
  const hasNonTraject = scored.some((s) => s.category === 'non_traject');
  if (hasNonTraject) return { category: 'other_product', source: 'lineitems' };
  return { category: 'unknown', source: 'lineitems' };
}

// UI-labels voor de categorieën. Één plek zodat frontend en tests
// dezelfde tekst gebruiken.
export const CATEGORY_LABELS = {
  m6:            '1-op-1 · 6 mnd',
  m12:           '1-op-1 · 12 mnd',
  m24:           '1-op-1 · 24 mnd',
  m_other:       '1-op-1 · overig',
  mem:           'Membership',
  other_product: 'Overig product',
  unknown:       'Onbekend',
};

export const CATEGORY_ORDER = ['m6', 'm12', 'm24', 'm_other', 'mem', 'other_product', 'unknown'];

// Test-exports
export const _internals = {
  normalize,
  classifyLineItemFamily,
  extractDurationMonths,
  lineItemCategory,
  classifyFromVariant,
  RE_EBOOK,
  RE_NON_TRAJECT,
  RE_ONE_ON_ONE,
  RE_MEMBERSHIP,
  RE_DURATION,
};
