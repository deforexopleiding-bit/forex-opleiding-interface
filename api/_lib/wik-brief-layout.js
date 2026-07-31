// api/_lib/wik-brief-layout.js
//
// Pure helpers voor WIK-brief opmaak (api/incasso-pre-brief.js). Geen supabase-
// of pdfkit-imports — puur cijfer- en string-logica die unit-testbaar is zonder
// SUPABASE_URL of Node-canvas dependencies.
//
// Twee stukjes logica:
//
//   1. validateCustomerAddress(cust)  — bepaalt of het adres compleet genoeg is
//      om een juridisch geldige WIK-brief te printen. Returnt { ok, missing[] }.
//      Caller (endpoint) gooit een 422 met code ADDRESS_INCOMPLETE zodra ok=false.
//
//   2. C5_ENVELOPE                    — venster-envelop-maten (NL/ISO C5/6
//      standaard) in millimeters ÉN pdfkit-punten. pdfkit gebruikt 1pt = 1/72"
//      = 0.35278mm → 1mm ≈ 2.834645pt. buildAddressBlockPosition() returnt de
//      exacte X/Y/W in pt voor het adresblok op A4, zó dat het na 1x dubbelvouwen
//      (A4 → A5) in het envelop-venster valt.
//
//   3. buildAddressLines(cust)        — bouwt de 4 zichtbare regels (naam,
//      straat+huisnr, postcode+plaats, landregel). country → "Nederland"/"België".

// ═══════════════════════════════════════════════════════════════════════
//   1. Adres-validatie (voor 422 ADDRESS_INCOMPLETE)
// ═══════════════════════════════════════════════════════════════════════

/** Velden die MINIMAAL gevuld moeten zijn voor een geldige WIK-brief. */
export const REQUIRED_ADDRESS_FIELDS = [
  'address_street',
  'address_number',
  'address_postal',
  'address_city',
];

/**
 * Controleer of het adres compleet genoeg is voor een WIK-brief.
 * address_country is optioneel (default → NL).
 *
 * @param {object|null|undefined} cust customer-row uit customers-tabel
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateCustomerAddress(cust) {
  if (!cust || typeof cust !== 'object') {
    return { ok: false, missing: [...REQUIRED_ADDRESS_FIELDS] };
  }
  const missing = REQUIRED_ADDRESS_FIELDS.filter((k) => {
    const v = cust[k];
    return v == null || String(v).trim() === '';
  });
  return { ok: missing.length === 0, missing };
}

// ═══════════════════════════════════════════════════════════════════════
//   2. C5-envelop-standaard + adresblok-positie op A4
// ═══════════════════════════════════════════════════════════════════════

/** 1 mm in pdfkit-punten (72 dpi baseline). */
export const MM_TO_PT = 2.834645669;
/** Convert mm → pt (afgerond op 3 decimalen voor stabiliteit). */
export function mmToPt(mm) {
  return Math.round(Number(mm) * MM_TO_PT * 1000) / 1000;
}

/**
 * C5-vensterenvelop specificatie (Nederlands standaard voor A4 → 1x dubbelvouwen).
 *
 * Venster-positie op de A4 na dubbelvouwen — MOET matchen met wat door het
 * envelop-venster zichtbaar is. Genormaliseerde maten voor Hermes-BE/PostNL-NL
 * standaard C5-vensterenvelop:
 *   - Venster begint 45mm van links (kant)
 *   - Venster begint 50mm van boven (kant)
 *   - Venster is 90mm breed × 40mm hoog
 *
 * Adresblok wordt IN dat venster gepositioneerd met safe margins (5mm) zodat
 * kleine variaties in vouwen/envelop-tolerantie geen tekst afsnijden. Effectief
 * schrijfvlak: 80mm × 30mm binnen het venster, vanaf 50mm×55mm.
 *
 * NB: er zijn ook C6/5 (langwerpig) en Duitse DL-varianten met andere
 * venster-posities. Deze layout volgt de meest voorkomende NL-standaard.
 */
export const C5_ENVELOPE = {
  window_from_left_mm:   45,
  window_from_top_mm:    50,
  window_width_mm:       90,
  window_height_mm:      40,
  safe_margin_mm:         5,
};

/**
 * Bereken de adresblok-positie op de A4-pagina in pdfkit-punten.
 * Adres wordt binnen het venster met safe_margin ingezet zodat de tekst niet
 * tegen de venster-rand aan komt bij kleine vouw-tolerantie.
 *
 * @returns {{ x: number, y: number, width: number, maxHeight: number,
 *             mm: { x_mm: number, y_mm: number, width_mm: number } }}
 */
export function buildAddressBlockPosition() {
  const e = C5_ENVELOPE;
  const x_mm = e.window_from_left_mm + e.safe_margin_mm;
  const y_mm = e.window_from_top_mm  + e.safe_margin_mm;
  const w_mm = e.window_width_mm    - (e.safe_margin_mm * 2);
  const h_mm = e.window_height_mm   - (e.safe_margin_mm * 2);
  return {
    x:         mmToPt(x_mm),
    y:         mmToPt(y_mm),
    width:     mmToPt(w_mm),
    maxHeight: mmToPt(h_mm),
    mm: { x_mm, y_mm, width_mm: w_mm, height_mm: h_mm },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//   3. Adresregels bouwen (naam, straat+nr, postcode+plaats, land)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Bouw de zichtbare adresregels. Caller (endpoint) rendert ze in het venster.
 * Landregel: NL default → "Nederland", BE → "België".
 * Bij afwezige velden (moet niet gebeuren na validate) wordt de regel skipped.
 *
 * @param {object} cust
 * @param {string} displayName  al gerenderde naam (via customerDisplayName)
 * @returns {string[]} array van regels in weergavevolgorde
 */
export function buildAddressBlockLines(cust, displayName) {
  const c = cust || {};
  const s = (c.address_street || '').trim();
  const n = (c.address_number || '').trim();
  const p = (c.address_postal || '').trim();
  const city = (c.address_city   || '').trim();
  const cc = String(c.address_country || 'NL').toUpperCase();
  const landregel = cc === 'BE' ? 'België' : 'Nederland';

  const lines = [];
  const nm = (displayName || '').trim();
  if (nm) lines.push(nm);
  const line1 = [s, n].filter(Boolean).join(' ');
  if (line1) lines.push(line1);
  const line2 = [p, city].filter(Boolean).join(' ');
  if (line2) lines.push(line2);
  lines.push(landregel);
  return lines;
}
