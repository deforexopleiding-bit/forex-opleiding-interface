// api/_lib/adreslabels-pdf.js
//
// Adreslabels voor de thermische labelprinter: 3 adressen per label onder elkaar,
// gestippelde knipregels ertussen. Puur: geen DB, geen storage. Input = lijst van
// adresblokken (elk een array regels, eerste regel = naam), output = PDF-bytes.
//
// Pagina = exact 4 × 6 inch (288 × 432 pt), staand, zonder schaal. Schalen naar
// het formaat van de printer gebeurt aan de printkant, niet in de PDF.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const BASE_W = 288;              // 4 inch
export const BASE_H = 432;              // 6 inch
export const VAKKEN_PER_LABEL = 3;
export const VAK_H = BASE_H / VAKKEN_PER_LABEL;   // 144

const MM = 72 / 25.4;
export const KNIP_INSPRONG = 3 * MM;     // knipregel van 3 mm tot breedte − 3 mm
export const TEKST_MARGE = 6 * MM;       // 6 mm links en rechts
export const NAAM_SIZE = 14.5;
export const REGEL_SIZE = 13;
export const REGEL_AFSTAND = 1.32;
export const MIN_SIZE = 7;
export const SIZE_STAP = 0.5;

// Helvetica-glyphs: ascent (hoofdletters) 0,718 / descent 0,207 van de fontgrootte.
// Gebruikt om de tekst optisch in z'n regelvak te centreren.
const CAP = 0.718;
const DESC = 0.207;

const ZWART = rgb(0, 0, 0);

/** Houd enkel tekens die het font (WinAnsi) kan coderen. */
function codeerbaar(font, tekst) {
  let out = '';
  for (const ch of String(tekst || '')) {
    try { font.encodeText(ch); out += ch; } catch { /* niet in WinAnsi → weg */ }
  }
  return out;
}

/** Kleinste fontgrootte (vanaf `start`, stappen 0,5) waarbij de regel binnen maxW past. */
export function pasGrootte(font, tekst, start, maxW) {
  let size = start;
  while (size > MIN_SIZE && font.widthOfTextAtSize(tekst, size) > maxW) size -= SIZE_STAP;
  return Math.max(size, MIN_SIZE);
}

/**
 * Bereken de regels van één vak in paginacoördinaten (pdf-lib: y van onder).
 * @returns {{ tekst, font, size, x, y }[]}
 */
export function layoutVak(adresRegels, vakIndex, { bold, regular }) {
  const maxW = BASE_W - 2 * TEKST_MARGE;
  const regels = (adresRegels || []).map((r, i) => {
    const font = i === 0 ? bold : regular;
    const tekst = codeerbaar(font, r);
    const size = pasGrootte(font, tekst, i === 0 ? NAAM_SIZE : REGEL_SIZE, maxW);
    return { tekst, font, size, w: font.widthOfTextAtSize(tekst, size), h: size * REGEL_AFSTAND };
  }).filter((r) => r.tekst !== '');
  if (!regels.length) return [];

  const blokW = Math.max(...regels.map((r) => r.w));
  const blokH = regels.reduce((s, r) => s + r.h, 0);
  const x = (BASE_W - blokW) / 2;                       // blok horizontaal gecentreerd, regels links uitgelijnd
  const vakTop = BASE_H - vakIndex * VAK_H;
  let top = vakTop - (VAK_H - blokH) / 2;               // blok verticaal gecentreerd
  const out = [];
  for (const r of regels) {
    const midden = top - r.h / 2;
    const y = midden - ((CAP - DESC) / 2) * r.size;     // glyph-band [−desc, cap] gecentreerd in het regelvak
    out.push({ tekst: r.tekst, font: r.font, size: r.size, x, y });
    top -= r.h;
  }
  return out;
}

/**
 * @param {string[][]} adressen  in printvolgorde; elk adres = regels (naam eerst)
 * @param {{ titel?: string }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function maakAdreslabelsPdf(adressen, { titel = 'Adreslabels' } = {}) {
  const doc = await PDFDocument.create();
  doc.setTitle(titel);
  doc.setCreator('DFO CRM');
  doc.setProducer('DFO CRM');
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  const lijst = Array.isArray(adressen) ? adressen : [];
  for (let start = 0; start < lijst.length; start += VAKKEN_PER_LABEL) {
    const page = doc.addPage([BASE_W, BASE_H]);

    // Knipregels tussen de vakken.
    for (let k = 1; k < VAKKEN_PER_LABEL; k++) {
      const y = BASE_H - k * VAK_H;
      page.drawLine({
        start: { x: KNIP_INSPRONG, y },
        end: { x: BASE_W - KNIP_INSPRONG, y },
        thickness: 0.6,
        color: ZWART,
        dashArray: [3, 3],
      });
    }

    const groep = lijst.slice(start, start + VAKKEN_PER_LABEL);
    groep.forEach((adres, vakIndex) => {
      for (const r of layoutVak(adres, vakIndex, { bold, regular })) {
        page.drawText(r.tekst, { x: r.x, y: r.y, size: r.size, font: r.font, color: ZWART });
      }
    });
  }
  return doc.save();
}
