// modules/esign/esign-coords.js
//
// E-handtekening — van scherm naar PDF-punten. GEDEELD door de veld-editor, de
// tekenpagina (browser) en het inbranden (api/_lib/esign-pdf.js), zoals
// modules/scan/scan-model.js. Puur: geen DOM, geen imports.
//
// AFSPRAAK
//   Een veld staat opgeslagen als FRACTIE van de pagina ZOALS DIE GETOOND WORDT
//   (pdf.js past /Rotate van de pagina toe): x, y, breedte, hoogte in 0..1 met
//   (0,0) = linksboven. Zo maakt zoom of schermgrootte niet uit.
//
//   In de PDF is (0,0) linksonder en draait /Rotate de pagina bij het tonen
//   met de klok mee. plaatsInPdf() rekent een veld om naar een tekenopdracht
//   in PDF-punten: oorsprong (x,y), breedte, hoogte en de rotatie (tegen de
//   klok in, zoals pdf-lib `rotate: degrees(r)`) waarmee de inhoud rechtop
//   oogt voor de lezer.
//
//   box = de CropBox van de pagina (pdf.js toont die; zonder CropBox = MediaBox).

export const VELD_TYPES = Object.freeze(['handtekening', 'paraaf', 'datum', 'naam', 'tekst', 'checkbox']);

// Standaardmaat van een nieuw veld in PDF-punten (1 pt = 1/72 inch); de editor
// rekent het per pagina om naar fracties, zodat het ook op liggende pagina's klopt.
export const STANDAARD_MAAT_PT = Object.freeze({
  handtekening: { breedte: 170, hoogte: 44 },
  paraaf      : { breedte: 60,  hoogte: 36 },
  datum       : { breedte: 100, hoogte: 20 },
  naam        : { breedte: 160, hoogte: 20 },
  tekst       : { breedte: 170, hoogte: 20 },
  checkbox    : { breedte: 16,  hoogte: 16 },
});

export function normaliseerRotatie(r) {
  const n = ((Math.round(Number(r) || 0) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(n) ? n : 0;
}

/** Getoonde maat (punten) van een pagina met box {breedte,hoogte} en rotatie. */
export function getoondeMaat(box, rotatie) {
  const r = normaliseerRotatie(rotatie);
  return r % 180 === 0
    ? { breedte: box.breedte, hoogte: box.hoogte }
    : { breedte: box.hoogte, hoogte: box.breedte };
}

/** Getoond punt (u,v ∈ 0..1, linksboven) → PDF-punt. */
export function getoondNaarPdf(u, v, box, rotatie) {
  const r = normaliseerRotatie(rotatie);
  const { x, y, breedte: W, hoogte: H } = box;
  if (r === 90)  return { x: x + v * W,       y: y + u * H };
  if (r === 180) return { x: x + (1 - u) * W, y: y + v * H };
  if (r === 270) return { x: x + (1 - v) * W, y: y + (1 - u) * H };
  return { x: x + u * W, y: y + (1 - v) * H };
}

/**
 * Veld (fracties) → tekenopdracht in PDF-punten.
 * Oorsprong = de hoek die voor de lezer LINKSONDER van het veld staat.
 * @returns {{x:number,y:number,breedte:number,hoogte:number,rotatie:number}}
 */
export function plaatsInPdf(veld, box, rotatie) {
  const r = normaliseerRotatie(rotatie);
  const getoond = getoondeMaat(box, r);
  const o = getoondNaarPdf(Number(veld.x), Number(veld.y) + Number(veld.hoogte), box, r);
  return {
    x: o.x,
    y: o.y,
    breedte: Number(veld.breedte) * getoond.breedte,
    hoogte : Number(veld.hoogte)  * getoond.hoogte,
    rotatie: r,
  };
}

/** Schermrechthoek (px, t.o.v. de getoonde pagina) → fracties, afgeklemd binnen de pagina. */
export function pxNaarFractie({ left, top, width, height }, paginaPxBreedte, paginaPxHoogte) {
  const W = Number(paginaPxBreedte) || 1;
  const H = Number(paginaPxHoogte) || 1;
  let breedte = Math.min(1, Math.max(0.005, width / W));
  let hoogte  = Math.min(1, Math.max(0.005, height / H));
  let x = Math.min(1 - breedte, Math.max(0, left / W));
  let y = Math.min(1 - hoogte,  Math.max(0, top / H));
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  breedte = r6(breedte); hoogte = r6(hoogte); x = r6(x); y = r6(y);
  if (x + breedte > 1) x = r6(1 - breedte);
  if (y + hoogte > 1) y = r6(1 - hoogte);
  return { x, y, breedte, hoogte };
}

/** Fracties → schermrechthoek in px voor een getoonde pagina van W×H px. */
export function fractieNaarPx(veld, paginaPxBreedte, paginaPxHoogte) {
  return {
    left  : Number(veld.x) * paginaPxBreedte,
    top   : Number(veld.y) * paginaPxHoogte,
    width : Number(veld.breedte) * paginaPxBreedte,
    height: Number(veld.hoogte) * paginaPxHoogte,
  };
}

/** Is dit een geldig veld (fracties binnen de pagina, bekend type)? */
export function veldGeldig(v) {
  if (!v || !VELD_TYPES.includes(v.type)) return false;
  const n = ['x', 'y', 'breedte', 'hoogte'].map((k) => Number(v[k]));
  if (n.some((g) => !Number.isFinite(g))) return false;
  const [x, y, b, h] = n;
  if (x < 0 || y < 0 || b <= 0 || h <= 0) return false;
  if (x + b > 1.000001 || y + h > 1.000001) return false;
  return Number.isInteger(Number(v.pagina)) && Number(v.pagina) >= 1;
}
