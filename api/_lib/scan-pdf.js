// api/_lib/scan-pdf.js — rapport- en certificaat-PDF van de strategie-scan (fase 2).
//
// Huisstijl = de goedgekeurde scan-mockup, in het LICHTE thema (crème, wit,
// goud, navy): goed leesbaar op scherm én op papier. Fonts zoals de mockup:
// Fraunces (koppen) + Inter (tekst), statische WOFF's van Fontsource in
// api/_lib/fonts/scan/ (SIL Open Font License, zie OFL-*.txt). Iconen uit de
// mockup (emoji) worden getekend — PDF-fonts hebben geen emoji.
//
// Twee lagen:
//   rapportInhoud(...)   → pure functie: WAT er in het rapport staat (testbaar);
//   maakRapportPdf(...)  → tekent dat met pdfkit tot een Buffer;
//   maakCertificaatPdf() → "Strategie-scan voltooid" (A4 liggend).
// Geen prijzen, geen rendement- of tijdlijncijfers (die staan ook niet in het model).

import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { SCORE_ONDERDELEN, ONDERDEEL_NAMEN } from '../../modules/scan/scan-model.js';

const FONT = (f) => fileURLToPath(new URL('./fonts/scan/' + f, import.meta.url));
const FONTS = {
  disp: FONT('fraunces-latin-600-normal.woff'),
  dispB: FONT('fraunces-latin-700-normal.woff'),
  r: FONT('inter-latin-400-normal.woff'),
  m: FONT('inter-latin-500-normal.woff'),
  sb: FONT('inter-latin-600-normal.woff'),
  b: FONT('inter-latin-700-normal.woff'),
};

// Licht thema van de mockup.
const K = {
  bg: '#f4f1e9', card: '#ffffff', soft: '#faf6ee', line: '#e3ddd0', line2: '#d6cfbf',
  fg: '#17323e', fg2: '#3d535e', muted: '#6a7d87', strong: '#122e3a',
  gold: '#9c6f11', gold2: '#b2851f', goldTint: '#f6eedb', goldLine: '#dcc79a',
  ok: '#1f8f68', okTint: '#e3f2ec', amber: '#a9791a', red: '#bd4a40', redTint: '#f7e6e3',
  track: '#ebe6db',
};
const TOON = { ok: { kleur: K.ok, tint: K.okTint }, amber: { kleur: K.amber, tint: K.goldTint }, red: { kleur: K.red, tint: K.redTint } };

export const DISCLAIMER = 'Resultaten verschillen per persoon en zijn niet gegarandeerd. Traden brengt risico op verlies met zich mee. Dit rapport is een persoonlijke analyse op basis van je eigen antwoorden en vormt geen financieel advies.';

/** "15 oktober 2026" in Nederlandse tijd. */
export function nlDatum(d) {
  return new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Amsterdam' });
}

/** Bestandsnaam-veilig (geen slashes/aanhalingstekens), max 80 tekens. */
export function veiligeNaam(s) {
  return String(s || 'deelnemer').replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'deelnemer';
}

/**
 * Wat het rapport toont — één plek, zodat de PDF en de toetsen hetzelfde zien.
 * Het salesgerichte blok "Jouw volgende stap" valt weg bij "Nu nog niet".
 */
export function rapportInhoud({ naam, uitkomst: u, assessor = 'Dave', datum = new Date() }) {
  return {
    naam: naam || 'Deelnemer',
    datum: nlDatum(datum),
    assessor,
    doel: u.doel || null,
    readiness: u.readiness,
    toon: u.toon,
    categorie: u.categorie,
    verdict: u.verdict,
    aanbevelingen: [
      ...(u.aanpak ? [{ kop: 'Aanbevolen aanpak', titel: u.aanpak, tekst: u.aanpakUitleg }] : []),
      { kop: u.trajectKop, titel: u.traject, tekst: u.trajectUitleg },
    ],
    balken: SCORE_ONDERDELEN.map((k) => ({ naam: ONDERDEEL_NAMEN[k], score: u.scores[k] })),
    samenvatting: u.samenvatting,
    opvallend: u.opvallend,
    advies: u.advies,
    volgendeStap: u.volgendeStap
      ? {
        titel: u.volgendeStap.titel,
        lead: u.volgendeStap.lead,
        voordelen: u.volgendeStap.voordelen.map((v) => ({ titel: v[1], tekst: v[2] })),
        schaars: u.volgendeStap.schaars ? u.volgendeStap.schaars.replace(/^\W+\s*/u, '') : '',
        cta: 'Klaar om te starten? ' + assessor + ' neemt dit rapport met je door en laat zien hoe je kunt beginnen.',
      }
      : null,
    disclaimer: DISCLAIMER,
  };
}

function nieuwDoc(opties) {
  const doc = new PDFDocument({ margin: 0, bufferPages: true, ...opties });
  for (const [k, f] of Object.entries(FONTS)) doc.registerFont(k, f);
  const delen = [];
  doc.on('data', (c) => delen.push(c));
  const klaar = new Promise((res, rej) => { doc.on('end', () => res(Buffer.concat(delen))); doc.on('error', rej); });
  return { doc, klaar };
}

// ── Rapport ─────────────────────────────────────────────────────────────────

const W = 595.28; const H = 841.89; const M = 44; const CW = W - 2 * M;
const KOP_H = 64; const VOET_H = 40; const PAD = 22;

function achtergrond(doc) {
  doc.rect(0, 0, W, H).fill(K.bg);
  doc.rect(0, KOP_H, W, 1.2).fill(K.gold2);
}

function kop(doc) {
  doc.roundedRect(M, 20, 24, 24, 5).fillAndStroke(K.goldTint, K.goldLine);
  doc.fillColor(K.gold).font('dispB').fontSize(13).text('F', M, 25, { width: 24, align: 'center', lineBreak: false });
  doc.fillColor(K.fg).font('sb').fontSize(8.5).text('DE FOREX OPLEIDING', M + 34, 22, { characterSpacing: 2, lineBreak: false });
  doc.fillColor(K.muted).font('m').fontSize(6.5).text('STRATEGIE-SCAN', M + 34, 34, { characterSpacing: 2.2, lineBreak: false });
  const t = 'VERTROUWELIJK';
  doc.font('m').fontSize(6.5);
  const tw = doc.widthOfString(t, { characterSpacing: 1.6 }) + 18;
  doc.roundedRect(W - M - tw, 23, tw, 17, 8.5).lineWidth(0.8).stroke(K.line2);
  doc.fillColor(K.muted).text(t, W - M - tw, 28.5, { width: tw, align: 'center', characterSpacing: 1.6, lineBreak: false });
}

function kaart(doc, x, y, w, h, { fill = K.card, rand = K.line, r = 12 } = {}) {
  doc.roundedRect(x, y, w, h, r).lineWidth(0.8).fillAndStroke(fill, rand);
}

function eyebrow(doc, t, x, y, kleur = K.gold) {
  doc.fillColor(kleur).font('sb').fontSize(7.5).text(t.toUpperCase(), x, y, { characterSpacing: 1.8, lineBreak: false });
}

function hoogte(doc, font, size, tekst, breedte, lineGap = 2) {
  doc.font(font).fontSize(size);
  return doc.heightOfString(tekst, { width: breedte, lineGap });
}

/** Ring met readiness (gauge uit de mockup). */
function gauge(doc, cx, cy, r, pct, kleur) {
  doc.circle(cx, cy, r).lineWidth(9).stroke(K.track);
  const p = Math.max(0, Math.min(100, pct)) / 100;
  if (p >= 0.999) doc.circle(cx, cy, r).lineWidth(9).stroke(kleur);
  else if (p > 0) {
    const a0 = -Math.PI / 2; const a1 = a0 + p * 2 * Math.PI;
    const x0 = cx + r * Math.cos(a0); const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1); const y1 = cy + r * Math.sin(a1);
    doc.path(`M ${x0} ${y0} A ${r} ${r} 0 ${p > 0.5 ? 1 : 0} 1 ${x1} ${y1}`).lineWidth(9).lineCap('round').stroke(kleur);
    doc.lineCap('butt');
  }
}

/** Een gekleurd vinkje-rondje (vervangt de emoji-iconen van de mockup). */
function bolletje(doc, x, y, kleur = K.gold2, tint = K.goldTint) {
  doc.circle(x + 8, y + 8, 8).lineWidth(0.8).fillAndStroke(tint, kleur);
  doc.path(`M ${x + 4.6} ${y + 8.2} L ${x + 7} ${y + 10.6} L ${x + 11.6} ${y + 5.6}`).lineWidth(1.4).lineCap('round').lineJoin('round').stroke(kleur);
  doc.lineCap('butt').lineJoin('miter');
}

/**
 * Tekent het rapport. Kaarten worden nooit gesplitst: past een kaart niet meer,
 * dan begint een nieuwe pagina. Paginanummers + voetregel achteraf.
 */
export async function maakRapportPdf(invoer) {
  const R = rapportInhoud(invoer);
  const { doc, klaar } = nieuwDoc({ size: 'A4', info: { Title: 'Strategie-scan rapport — ' + R.naam, Author: 'De Forex Opleiding' } });
  let y = 0;
  const nieuwePagina = (eerste) => { if (!eerste) doc.addPage(); achtergrond(doc); kop(doc); y = KOP_H + 24; };
  const ruimte = (h) => { if (y + h > H - VOET_H - 10) nieuwePagina(false); };
  nieuwePagina(true);
  const IW = CW - 2 * PAD; const IX = M + PAD;
  const toon = TOON[R.toon] || TOON.amber;

  // 1. Kop + readiness + aanbevelingen.
  {
    const vbBreed = IW - 150;
    const hVerdict = hoogte(doc, 'r', 9.5, R.verdict, vbBreed, 2.5);
    const recBreed = R.aanbevelingen.length === 2 ? (IW - 12) / 2 : IW;
    const hRec = Math.max(...R.aanbevelingen.map((a) => 44 + hoogte(doc, 'disp', 14, a.titel, recBreed - 28) + hoogte(doc, 'r', 8.5, a.tekst, recBreed - 28, 2)));
    const hDoel = R.doel ? 40 : 0;
    const hGauge = Math.max(124, 34 + hVerdict + 20);
    const h = PAD + 44 + hDoel + hGauge + 14 + hRec + PAD;
    ruimte(h);
    kaart(doc, M, y, CW, h);
    let yy = y + PAD;
    eyebrow(doc, 'Strategie-scan · rapport', IX, yy);
    doc.fillColor(K.strong).font('disp').fontSize(19).text(R.naam, IX, yy + 12, { width: IW - 170, lineBreak: false, ellipsis: true });
    doc.fillColor(K.muted).font('r').fontSize(8.5)
      .text(R.datum, IX, yy, { width: IW, align: 'right' })
      .text('Uitgevoerd met ' + R.assessor, IX, yy + 13, { width: IW, align: 'right' });
    yy += 44;
    if (R.doel) {
      doc.roundedRect(IX, yy, IW, 30, 8).lineWidth(0.8).fillAndStroke(K.goldTint, K.goldLine);
      doc.fillColor(K.gold).font('sb').fontSize(9.5).text('Jouw doel met traden: ', IX + 14, yy + 10, { continued: true, lineBreak: false })
        .fillColor(K.fg).font('r').text(R.doel, { lineBreak: false });
      yy += hDoel;
    }
    const cx = IX + 58; const cy = yy + 58;
    gauge(doc, cx, cy, 50, R.readiness, toon.kleur);
    doc.fillColor(R.toon === 'ok' ? K.ok : K.strong).font('disp').fontSize(32).text(String(R.readiness), cx - 50, cy - 22, { width: 100, align: 'center', lineBreak: false });
    doc.fillColor(K.muted).font('m').fontSize(6.5).text('READINESS', cx - 50, cy + 14, { width: 100, align: 'center', characterSpacing: 1.6, lineBreak: false });
    const vx = IX + 140;
    doc.font('sb').fontSize(8.5);
    const bw = doc.widthOfString(R.categorie) + 30;
    doc.roundedRect(vx, yy + 16, bw, 20, 10).lineWidth(0.8).fillAndStroke(toon.tint, toon.kleur);
    doc.circle(vx + 12, yy + 26, 3).fill(toon.kleur);
    doc.fillColor(toon.kleur).font('sb').fontSize(8.5).text(R.categorie, vx + 20, yy + 22, { lineBreak: false });
    doc.fillColor(K.fg2).font('r').fontSize(9.5).text(R.verdict, vx, yy + 46, { width: vbBreed, lineGap: 2.5 });
    yy += hGauge + 14;
    R.aanbevelingen.forEach((a, i) => {
      const x = IX + i * (recBreed + 12);
      doc.roundedRect(x, yy, recBreed, hRec, 10).lineWidth(0.8).fillAndStroke(K.soft, K.line2);
      eyebrow(doc, a.kop, x + 14, yy + 14);
      doc.fillColor(K.strong).font('disp').fontSize(14).text(a.titel, x + 14, yy + 28, { width: recBreed - 28 });
      doc.fillColor(K.fg2).font('r').fontSize(8.5).text(a.tekst, x + 14, doc.y + 4, { width: recBreed - 28, lineGap: 2 });
    });
    y += h + 14;
  }

  // 2. Profiel per onderdeel.
  {
    const h = PAD + 22 + R.balken.length * 30 + PAD - 6;
    ruimte(h);
    kaart(doc, M, y, CW, h);
    let yy = y + PAD;
    eyebrow(doc, 'Profiel per onderdeel', IX, yy);
    yy += 22;
    for (const b of R.balken) {
      const kleur = b.score >= 70 ? K.ok : b.score >= 50 ? K.gold2 : K.red;
      doc.fillColor(K.fg).font('m').fontSize(9).text(b.naam, IX, yy, { lineBreak: false });
      doc.fillColor(K.fg2).font('disp').fontSize(10).text(String(b.score), IX, yy - 1, { width: IW - 30, align: 'right', lineBreak: false });
      doc.fillColor(K.muted).font('r').fontSize(7).text('/ 100', IX + IW - 26, yy + 1.5, { width: 26, align: 'right', lineBreak: false });
      doc.roundedRect(IX, yy + 14, IW, 5, 2.5).fill(K.track);
      if (b.score > 0) doc.roundedRect(IX, yy + 14, Math.max(5, IW * b.score / 100), 5, 2.5).fill(kleur);
      yy += 30;
    }
    y += h + 14;
  }

  // 3. Samenvatting / wat opvalt / advies + disclaimer.
  {
    const tagB = 64;
    const hRegels = R.opvallend.map((o) => Math.max(16, hoogte(doc, 'r', 9, o.tekst, IW - tagB - 8, 2)) + 10);
    const hSam = hoogte(doc, 'r', 9.5, R.samenvatting, IW, 2.5);
    const hAdv = hoogte(doc, 'r', 9.5, R.advies, IW, 2.5);
    const hDisc = hoogte(doc, 'r', 7, R.disclaimer, IW, 1.5);
    const h = PAD + 22 + hSam + 16 + 22 + hRegels.reduce((a, b) => a + b, 0) + 10 + 22 + hAdv + 16 + hDisc + PAD;
    ruimte(h);
    kaart(doc, M, y, CW, h);
    let yy = y + PAD;
    const sectie = (t) => { doc.fillColor(K.strong).font('disp').fontSize(13).text(t, IX, yy, { lineBreak: false }); yy += 22; };
    sectie('Samenvatting');
    doc.fillColor(K.fg2).font('r').fontSize(9.5).text(R.samenvatting, IX, yy, { width: IW, lineGap: 2.5 });
    yy += hSam + 16;
    sectie('Wat opvalt');
    R.opvallend.forEach((o, i) => {
      const sterk = o.soort === 's';
      doc.font('b').fontSize(6.5);
      const lw = doc.widthOfString(o.label.toUpperCase(), { characterSpacing: 0.8 }) + 14;
      doc.roundedRect(IX, yy, lw, 14, 7).fill(sterk ? K.okTint : K.goldTint);
      doc.fillColor(sterk ? K.ok : K.gold).font('b').fontSize(6.5).text(o.label.toUpperCase(), IX, yy + 4, { width: lw, align: 'center', characterSpacing: 0.8, lineBreak: false });
      doc.fillColor(K.fg2).font('r').fontSize(9).text(o.tekst, IX + tagB, yy + 1.5, { width: IW - tagB - 8, lineGap: 2 });
      yy += hRegels[i];
      if (i < R.opvallend.length - 1) doc.rect(IX, yy - 5, IW, 0.6).fill(K.line);
    });
    yy += 10;
    sectie('Advies & vervolg');
    doc.fillColor(K.fg2).font('r').fontSize(9.5).text(R.advies, IX, yy, { width: IW, lineGap: 2.5 });
    yy += hAdv + 8;
    doc.rect(IX, yy, IW, 0.6).fill(K.line);
    doc.fillColor(K.muted).font('r').fontSize(7).text(R.disclaimer, IX, yy + 8, { width: IW, lineGap: 1.5 });
    y += h + 14;
  }

  // 4. Jouw volgende stap (niet bij "Nu nog niet").
  if (R.volgendeStap) {
    const V = R.volgendeStap;
    const hLead = hoogte(doc, 'r', 9.5, V.lead, IW, 2.5);
    const hV = V.voordelen.map((v) => Math.max(18, hoogte(doc, 'r', 9, v.titel + ' — ' + v.tekst, IW - 28, 2)) + 8);
    const hCta = 18 + hoogte(doc, 'r', 9, V.cta, IW - 28, 2) + (V.schaars ? 16 : 0) + 14;
    const h = PAD + 20 + 24 + hLead + 14 + hV.reduce((a, b) => a + b, 0) + 8 + 50 + 14 + hCta + PAD;
    ruimte(h);
    kaart(doc, M, y, CW, h, { fill: K.soft, rand: K.goldLine });
    let yy = y + PAD;
    eyebrow(doc, 'Jouw volgende stap', IX, yy); yy += 20;
    doc.fillColor(K.strong).font('disp').fontSize(15).text(V.titel, IX, yy, { width: IW, lineBreak: false }); yy += 24;
    doc.fillColor(K.fg).font('r').fontSize(9.5).text(V.lead, IX, yy, { width: IW, lineGap: 2.5 }); yy += hLead + 14;
    V.voordelen.forEach((v, i) => {
      bolletje(doc, IX, yy - 1);
      doc.fillColor(K.strong).font('sb').fontSize(9).text(v.titel, IX + 28, yy + 1.5, { width: IW - 28, continued: true, lineGap: 2 })
        .fillColor(K.fg2).font('r').text(' — ' + v.tekst, { lineGap: 2 });
      yy += hV[i];
    });
    yy += 8;
    const tiles = [['300+', 'cursisten begeleid'], ['4,7/5', 'beoordeling'], ['1-op-1', 'persoonlijke aanpak']];
    const tw = (IW - 20) / 3;
    tiles.forEach((t, i) => {
      const x = IX + i * (tw + 10);
      doc.roundedRect(x, yy, tw, 50, 9).lineWidth(0.8).fillAndStroke(K.card, K.line);
      doc.fillColor(K.gold2).font('disp').fontSize(16).text(t[0], x, yy + 10, { width: tw, align: 'center', lineBreak: false });
      doc.fillColor(K.muted).font('r').fontSize(7.5).text(t[1], x, yy + 31, { width: tw, align: 'center', lineBreak: false });
    });
    yy += 64;
    doc.roundedRect(IX, yy, IW, hCta, 10).lineWidth(0.8).fillAndStroke(K.goldTint, K.goldLine);
    doc.fillColor(K.fg).font('r').fontSize(9).text(V.cta, IX + 14, yy + 14, { width: IW - 28, lineGap: 2 });
    if (V.schaars) doc.fillColor(K.gold).font('sb').fontSize(8).text(V.schaars, IX + 14, doc.y + 5, { width: IW - 28, lineBreak: false });
    y += h + 14;
  }

  // Voetregel + paginanummers.
  const r = doc.bufferedPageRange();
  for (let i = r.start; i < r.start + r.count; i++) {
    doc.switchToPage(i);
    doc.rect(M, H - VOET_H, CW, 0.6).fill(K.line2);
    doc.fillColor(K.muted).font('r').fontSize(7)
      .text('De Forex Opleiding · Persoonlijk rapport voor ' + R.naam + ' · ' + R.datum, M, H - VOET_H + 10, { width: CW - 60, lineBreak: false, ellipsis: true })
      .text((i - r.start + 1) + ' / ' + r.count, M, H - VOET_H + 10, { width: CW, align: 'right', lineBreak: false });
  }
  doc.end();
  return klaar;
}

// ── Certificaat ─────────────────────────────────────────────────────────────

/** "Strategie-scan voltooid" — A4 liggend, crème met goud (de certificaat-kaart uit de mockup). */
export async function maakCertificaatPdf({ naam, doel = null, assessor = 'Dave', datum = new Date() }) {
  const { doc, klaar } = nieuwDoc({ size: 'A4', layout: 'landscape', info: { Title: 'Certificaat strategie-scan — ' + (naam || ''), Author: 'De Forex Opleiding' } });
  const w = 841.89; const h = 595.28;
  doc.rect(0, 0, w, h).fill(K.bg);
  doc.roundedRect(26, 26, w - 52, h - 52, 18).lineWidth(1.4).stroke(K.goldLine);
  doc.roundedRect(36, 36, w - 72, h - 72, 12).lineWidth(0.6).stroke(K.line2);
  const cx = w / 2;
  doc.circle(cx, 108, 26).lineWidth(1).fillAndStroke(K.goldTint, K.goldLine);
  doc.fillColor(K.gold).font('dispB').fontSize(22).text('F', cx - 26, 95, { width: 52, align: 'center', lineBreak: false });
  doc.fillColor(K.gold).font('sb').fontSize(8.5).text('DE FOREX OPLEIDING', 0, 152, { width: w, align: 'center', characterSpacing: 3, lineBreak: false });
  doc.fillColor(K.strong).font('disp').fontSize(36).text('Strategie-scan voltooid', 0, 174, { width: w, align: 'center', lineBreak: false });
  doc.fillColor(K.muted).font('r').fontSize(10).text('Dit certificaat wordt uitgereikt aan', 0, 236, { width: w, align: 'center', lineBreak: false });
  const n = naam || 'Deelnemer';
  doc.font('disp').fontSize(n.length > 30 ? 30 : 38);
  const nw = Math.min(w - 200, doc.widthOfString(n) + 60);
  doc.rect(cx - nw / 2, 262, nw, 0.8).fill(K.line2);
  doc.fillColor(K.gold2).font('disp').fontSize(n.length > 30 ? 30 : 38).text(n, 60, 276, { width: w - 120, align: 'center', lineBreak: false, ellipsis: true });
  doc.rect(cx - nw / 2, 330, nw, 0.8).fill(K.line2);
  doc.fillColor(K.fg2).font('r').fontSize(11)
    .text('voor het voltooien van de persoonlijke strategie-scan van De Forex Opleiding.', 0, 348, { width: w, align: 'center', lineBreak: false });
  if (doel) doc.fillColor(K.fg).font('m').fontSize(10.5).text('Doel: ' + doel, 0, 372, { width: w, align: 'center', lineBreak: false, ellipsis: true });
  const yOnder = 448;
  doc.rect(150, yOnder, 200, 0.8).fill(K.line2);
  doc.rect(w - 350, yOnder, 200, 0.8).fill(K.line2);
  doc.fillColor(K.strong).font('sb').fontSize(10).text(nlDatum(datum), 150, yOnder + 9, { width: 200, align: 'center', lineBreak: false });
  doc.fillColor(K.muted).font('r').fontSize(8).text('Datum', 150, yOnder + 24, { width: 200, align: 'center', lineBreak: false });
  doc.fillColor(K.strong).font('sb').fontSize(10).text(assessor, w - 350, yOnder + 9, { width: 200, align: 'center', lineBreak: false });
  doc.fillColor(K.muted).font('r').fontSize(8).text('Uitgevoerd met · De Forex Opleiding', w - 350, yOnder + 24, { width: 200, align: 'center', lineBreak: false });
  doc.end();
  return klaar;
}
