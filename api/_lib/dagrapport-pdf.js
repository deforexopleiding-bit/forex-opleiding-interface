// api/_lib/dagrapport-pdf.js
//
// buildDagrapportPdf(data) -> Promise<Buffer>
//
// Bouwt het dagelijkse Dagrapport als PDF met pdfkit (zelfde stack als
// api/_lib/incasso-pdf.js). De 7 blokken komen 1-op-1 uit de mockup
// (Dagrapport-voorstel): sales & omzet, getekende offertes, calls & uitkomst,
// ingeboekt per agenda, belwerk Dave, nieuwe leads per categorie, achterstallig.
//
// De data-vorm komt uit api/_lib/dagrapport-data.js (verzamelDagrapport). Een
// cijfer dat niet betrouwbaar uit de data komt is `null` in die vorm; dit bestand
// toont dan "n.v.t." met (waar relevant) een voetnoot, NOOIT een misleidende 0.
//
// Geen emoji: pdfkit's standaard Helvetica/WinAnsi kan die niet renderen, dus de
// blokken krijgen nette tekstkoppen i.p.v. de emoji uit de mockup.

import PDFDocument from 'pdfkit';

// ── Kleuren (afgeleid van de mockup / huisstijl) ────────────────────────────
const NAVY   = '#0b3a4f';
const INK    = '#17262d';
const MUT     = '#67767e';
const LINE    = '#e7e0d2';
const SOFT    = '#fbf8f1';
const GOLD    = '#c1912f';
const GREEN   = '#1b8f5a';
const RED      = '#c0392b';
const CARDBG  = '#ffffff';

// ── Layout ──────────────────────────────────────────────────────────────────
const PAGE = { margin: 42 };
const A4   = { w: 595.28, h: 841.89 };
const CONTENT_W = A4.w - PAGE.margin * 2;

// Verwijder tekens die pdfkit's Helvetica (WinAnsi) niet aankan (codepoint > 255
// = emoji/CJK) plus control chars. Accenten (é/ü/ï) blijven. € (U+20AC) wordt
// apart via het currency-pad getoond, niet via deze sanitizer.
function schoon(str) {
  if (str == null) return '';
  const s = String(str);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp == null) continue;
    if (cp < 32 || cp === 127) { out += ' '; continue; }
    if (cp > 255) { if (cp > 0xffff) i++; continue; }
    out += String.fromCodePoint(cp);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// € met NL-duizendscheiding. Hele bedragen zonder decimalen (mockup: €5.397),
// anders 2 decimalen. null -> 'n.v.t.'.
function eur(n, { decimals } = {}) {
  if (n == null || !Number.isFinite(Number(n))) return 'n.v.t.';
  const v = Number(n);
  const dec = decimals != null ? decimals : (Number.isInteger(v) ? 0 : 2);
  return '€ ' + v.toLocaleString('nl-NL', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function getal(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'n.v.t.';
  return Number(n).toLocaleString('nl-NL');
}

export function buildDagrapportPdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: PAGE.margin, bufferPages: true });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      render(doc, data || {});

      // Voettekst op elke pagina. Bottom-marge tijdelijk op 0 zodat pdfkit geen
      // extra pagina toevoegt voor tekst onder de contentmarge.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const oudBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Helvetica').fontSize(8).fillColor(MUT).text(
          'Agency Command Center · Dagrapport · De Forex Opleiding NL B.V.',
          PAGE.margin, A4.h - 28, { width: CONTENT_W, align: 'center', lineBreak: false },
        );
        doc.page.margins.bottom = oudBottom;
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// ── Render ──────────────────────────────────────────────────────────────────
function render(doc, d) {
  kopbalk(doc, d);
  let y = PAGE.margin + 86;

  y = blokSales(doc, d.blok1 || {}, y);
  y = blokOffertes(doc, d.blok2 || {}, y);
  y = blokCalls(doc, d.blok3 || {}, y);
  y = blokAgenda(doc, d.blok4 || {}, y);
  y = blokBelwerk(doc, d.blok5 || {}, y);
  y = blokLeads(doc, d.blok6 || {}, y);
  y = blokAchterstallig(doc, d.blok7 || {}, y);
}

function kopbalk(doc, d) {
  const h = 70;
  doc.save();
  doc.roundedRect(PAGE.margin, PAGE.margin, CONTENT_W, h, 10).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19)
    .text('Dagrapport · De Forex Opleiding', PAGE.margin + 18, PAGE.margin + 15);
  doc.font('Helvetica').fontSize(10.5).fillColor('#b9ccd6')
    .text(`${schoon(d.datumLabel || '')} · stand 21:30`, PAGE.margin + 18, PAGE.margin + 42);
  if (d.preview) {
    doc.font('Helvetica').fontSize(8.5).fillColor('#9fb4bf')
      .text('VOORBEELD · cijfers zijn fictief, dit is een ontwerp', PAGE.margin + 18, PAGE.margin + 56);
  }
  doc.restore();
}

// Zorg dat er `need` pt ruimte is; anders nieuwe pagina.
function ensure(doc, y, need) {
  if (y + need > A4.h - 46) { doc.addPage(); return PAGE.margin; }
  return y;
}

function sectieKop(doc, titel, y) {
  y = ensure(doc, y, 40);
  doc.save();
  doc.roundedRect(PAGE.margin, y, CONTENT_W, 26, 6).fill(SOFT);
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(12)
    .text(schoon(titel), PAGE.margin + 12, y + 7);
  doc.restore();
  return y + 26 + 10;
}

// Rij stattegels. tiles: [{ waarde, label, kleur? }]
function statTegels(doc, tiles, y) {
  const n = tiles.length;
  const gap = 10;
  const w = (CONTENT_W - gap * (n - 1)) / n;
  const h = 58;
  y = ensure(doc, y, h + 8);
  tiles.forEach((t, i) => {
    const x = PAGE.margin + i * (w + gap);
    doc.save();
    doc.roundedRect(x, y, w, h, 8).lineWidth(1).fillAndStroke(CARDBG, LINE);
    doc.fillColor(t.kleur || NAVY).font('Helvetica-Bold').fontSize(19)
      .text(schoon(String(t.waarde)), x + 10, y + 10, { width: w - 20, lineBreak: false });
    doc.fillColor(MUT).font('Helvetica').fontSize(8.5)
      .text(schoon(t.label), x + 10, y + 36, { width: w - 20 });
    doc.restore();
  });
  return y + h + 12;
}

// Eenvoudige tabel. cols: [{ key, label, width(0..1), align }]. rows: objecten.
// opts.totaal: object-rij die vetgedrukt onderaan komt.
function tabel(doc, cols, rows, y, opts = {}) {
  const rowH = 20;
  const headH = 20;
  y = ensure(doc, y, headH + rowH + 6);
  const colX = [];
  let acc = PAGE.margin;
  cols.forEach((c) => { colX.push(acc); acc += c.width * CONTENT_W; });
  const cellText = (txt, i, yy, { bold, color, size } = {}) => {
    const c = cols[i];
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size || 9.5)
      .fillColor(color || INK)
      .text(txt, colX[i] + 2, yy + 6, { width: c.width * CONTENT_W - 6, align: c.align || 'left', lineBreak: false, ellipsis: true });
  };
  // header
  doc.save();
  cols.forEach((c, i) => cellText(String(c.label).toUpperCase(), i, y, { bold: false, color: MUT, size: 7.5 }));
  doc.moveTo(PAGE.margin, y + headH).lineTo(PAGE.margin + CONTENT_W, y + headH).lineWidth(1).stroke(LINE);
  doc.restore();
  y += headH;
  // rows
  for (const r of rows) {
    y = ensure(doc, y, rowH);
    cols.forEach((c, i) => cellText(r[c.key] == null ? '' : String(r[c.key]), i, y, { color: r._kleur }));
    doc.moveTo(PAGE.margin, y + rowH).lineTo(PAGE.margin + CONTENT_W, y + rowH).lineWidth(0.5).strokeColor('#efe9dc').stroke();
    y += rowH;
  }
  if (opts.totaal) {
    y = ensure(doc, y, rowH);
    doc.save();
    doc.rect(PAGE.margin, y, CONTENT_W, rowH).fill(SOFT);
    cols.forEach((c, i) => cellText(opts.totaal[c.key] == null ? '' : String(opts.totaal[c.key]), i, y, { bold: true, color: NAVY }));
    doc.restore();
    y += rowH;
  }
  return y + 12;
}

// ── Blok 1 ──────────────────────────────────────────────────────────────────
function blokSales(doc, b, y) {
  y = sectieKop(doc, 'Sales & omzet vandaag', y);
  const perCall = b.salesPerCall == null ? 'n.v.t.' : Math.round(b.salesPerCall * 100) + '%';
  y = statTegels(doc, [
    { waarde: getal(b.salesVandaag ?? 0), label: 'Sales vandaag', kleur: GREEN },
    { waarde: eur(b.omzetInclBtw), label: 'Omzet getekend (incl. btw)', kleur: NAVY },
    { waarde: b.nieuweMrr == null ? 'n.v.t.' : eur(b.nieuweMrr), label: 'Nieuwe MRR', kleur: b.nieuweMrr == null ? MUT : NAVY },
    { waarde: perCall, label: 'Sales per afgeronde call', kleur: NAVY },
  ], y);
  if (b.nieuweMrr == null) y = voetnoot(doc, 'Nieuwe MRR: n.v.t. - er is (nog) geen terugkerend/abonnement-veld in de data om dit betrouwbaar te bepalen.', y);
  return y + 4;
}

// ── Blok 2 ──────────────────────────────────────────────────────────────────
function blokOffertes(doc, b, y) {
  y = sectieKop(doc, 'Getekende offertes vandaag', y);
  const rows = (b.offertes || []).map((o) => ({
    klant: schoon(o.klant || '-'),
    product: schoon(o.product || '-'),
    bedrag: eur(o.bedrag),
    start: o.startdatum ? fmtDatum(o.startdatum) : '-',
    termijnen: o.termijnen == null ? 'n.b.' : getal(o.termijnen),
    perTermijn: o.perTermijn == null ? 'n.b.' : eur(o.perTermijn),
  }));
  if (!rows.length) {
    y = legeMelding(doc, 'Vandaag nog geen getekende offertes.', y);
    return y + 4;
  }
  y = tabel(doc, [
    { key: 'klant', label: 'Klant', width: 0.22 },
    { key: 'product', label: 'Product', width: 0.26 },
    { key: 'bedrag', label: 'Bedrag', width: 0.15, align: 'right' },
    { key: 'start', label: 'Start', width: 0.15, align: 'right' },
    { key: 'termijnen', label: 'Term.', width: 0.10, align: 'right' },
    { key: 'perTermijn', label: 'Per term.', width: 0.12, align: 'right' },
  ], rows, y, { totaal: { klant: 'Totaal', bedrag: eur(b.totaal) } });
  return y + 2;
}

// ── Blok 3 ──────────────────────────────────────────────────────────────────
function blokCalls(doc, b, y) {
  y = sectieKop(doc, 'Calls vandaag & uitkomst', y);
  y = statTegels(doc, [
    { waarde: getal(b.gepland ?? 0), label: 'Gepland', kleur: NAVY },
    { waarde: getal(b.afgerond ?? 0), label: 'Afgerond', kleur: GREEN },
    { waarde: getal(b.noShows ?? 0), label: 'No-shows', kleur: (b.noShows ? RED : MUT) },
    { waarde: getal(b.nogInTeVullen ?? 0), label: 'Nog in te vullen', kleur: (b.nogInTeVullen ? GOLD : MUT) },
  ], y);
  const u = b.uitkomsten || {};
  y = tabel(doc, [
    { key: 'l', label: 'Uitkomst van de afgeronde calls', width: 0.8 },
    { key: 'n', label: 'Aantal', width: 0.2, align: 'right' },
  ], [
    { l: 'Klant geworden', n: getal(u.klantGeworden ?? 0), _kleur: INK },
    { l: 'Geen klant', n: getal(u.geenKlant ?? 0) },
    { l: 'Opvolging nodig', n: getal(u.opvolgingNodig ?? 0) },
  ], y);
  return y + 2;
}

// ── Blok 4 ──────────────────────────────────────────────────────────────────
function blokAgenda(doc, b, y) {
  y = sectieKop(doc, 'Nieuwe calls ingeboekt vandaag · per agenda', y);
  const rows = (b.rijen || []).map((r) => ({ agenda: schoon(r.agenda), n: getal(r.aantal) }));
  if (!rows.length) { y = legeMelding(doc, 'Vandaag nog geen nieuwe calls ingeboekt.', y); return y + 4; }
  y = tabel(doc, [
    { key: 'agenda', label: 'Agenda', width: 0.78 },
    { key: 'n', label: 'Ingeboekt', width: 0.22, align: 'right' },
  ], rows, y, { totaal: { agenda: 'Totaal ingeboekt', n: getal(b.totaal) } });
  return y + 2;
}

// ── Blok 5 ──────────────────────────────────────────────────────────────────
function blokBelwerk(doc, b, y) {
  y = sectieKop(doc, 'Belwerk Dave vandaag', y);
  y = statTegels(doc, [
    { waarde: getal(b.minuten ?? 0), label: 'Gebelde minuten (account Dave)', kleur: NAVY },
    { waarde: getal(b.gesprekken ?? 0), label: 'Gesprekken', kleur: NAVY },
    { waarde: b.gemTijd || 'n.v.t.', label: 'Gem. gesprekstijd', kleur: NAVY },
  ], y);
  const o = b.opvolging || {}; const p = b.belpot || {};
  // Twee naast elkaar: Opvolging en Belpot.
  const half = (CONTENT_W - 12) / 2;
  y = ensure(doc, y, 118);
  const miniTabel = (x, titel, paren) => {
    doc.save();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUT).text(titel.toUpperCase(), x, y);
    let yy = y + 16;
    paren.forEach(([lab, val]) => {
      doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(schoon(lab), x, yy, { width: half - 46 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(NAVY).text(val == null ? 'n.v.t.' : getal(val), x + half - 46, yy, { width: 44, align: 'right' });
      doc.moveTo(x, yy + 16).lineTo(x + half, yy + 16).lineWidth(0.5).strokeColor('#efe9dc').stroke();
      yy += 20;
    });
    doc.restore();
  };
  miniTabel(PAGE.margin, 'Uit opvolging', [['Gebeld', o.gebeld], ['Bereikt', o.bereikt], ['Afspraak gemaakt', o.afspraak], ['Voicememo verstuurd', o.voicememo]]);
  miniTabel(PAGE.margin + half + 12, 'Uit leads bellen (belpot)', [['Gebeld', p.gebeld], ['Bereikt', p.bereikt], ['Afspraak gemaakt', p.afspraak], ['Niet bereikt / terugbellen', p.nietBereikt]]);
  return y + 4 * 20 + 20;
}

// ── Blok 6 ──────────────────────────────────────────────────────────────────
function blokLeads(doc, b, y) {
  y = sectieKop(doc, 'Nieuwe leads per categorie · en opvolging', y);
  const cel = (v) => (v == null ? 'n.v.t.' : getal(v));
  const rows = (b.rijen || []).map((r) => ({
    funnel: schoon(r.funnel), nieuw: cel(r.nieuw), gepland: cel(r.callGepland), gebeld: cel(r.gebeld), niet: cel(r.nietAangeraakt),
  }));
  const t = b.totaal || {};
  y = tabel(doc, [
    { key: 'funnel', label: 'Funnel', width: 0.3 },
    { key: 'nieuw', label: 'Nieuw', width: 0.15, align: 'right' },
    { key: 'gepland', label: 'Call gepl.', width: 0.18, align: 'right' },
    { key: 'gebeld', label: 'Gebeld', width: 0.16, align: 'right' },
    { key: 'niet', label: 'Onaangeraakt', width: 0.21, align: 'right' },
  ], rows, y, { totaal: { funnel: 'Totaal', nieuw: cel(t.nieuw), gepland: cel(t.callGepland), gebeld: cel(t.gebeld), niet: cel(t.nietAangeraakt) } });
  if (b.actieRegel) {
    y = ensure(doc, y, 34);
    doc.save();
    doc.roundedRect(PAGE.margin, y, CONTENT_W, 30, 6).fillAndStroke('#fdf5e6', '#e9d9b0');
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#8a6d1f').text('Actie: ', PAGE.margin + 10, y + 9, { continued: true })
      .font('Helvetica').fillColor('#6b5519').text(schoon(b.actieRegel), { width: CONTENT_W - 20 });
    doc.restore();
    y += 34;
  }
  if ((b.rijen || []).some((r) => r.gebeld == null || r.nietAangeraakt == null)) {
    y = voetnoot(doc, 'Webinar "gebeld"/"nog niet aangeraakt": n.v.t. - webinar-aanmelders hebben geen belpoging-registratie zoals mini-cursus/7-daagse.', y);
  }
  return y + 2;
}

// ── Blok 7 ──────────────────────────────────────────────────────────────────
function blokAchterstallig(doc, b, y) {
  y = sectieKop(doc, 'Achterstallig (totaal)', y);
  y = statTegels(doc, [
    { waarde: getal(b.opvolgingenOverTijd ?? 0), label: 'Opvolgingen over tijd', kleur: (b.opvolgingenOverTijd ? RED : MUT) },
    { waarde: getal(b.outcomesOntbrekend ?? 0), label: 'Outcomes ontbrekend', kleur: (b.outcomesOntbrekend ? RED : MUT) },
    { waarde: getal(b.voicememosUitstaand ?? 0), label: "Voicememo's uitstaand", kleur: (b.voicememosUitstaand ? RED : MUT) },
    { waarde: getal(b.totaal ?? 0), label: 'Totaal af te handelen', kleur: (b.totaal ? RED : MUT) },
  ], y);
  return y + 2;
}

// ── Kleine helpers ──────────────────────────────────────────────────────────
function voetnoot(doc, tekst, y) {
  y = ensure(doc, y, 22);
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(MUT)
    .text(schoon(tekst), PAGE.margin, y, { width: CONTENT_W });
  return y + doc.heightOfString(schoon(tekst), { width: CONTENT_W }) + 6;
}

function legeMelding(doc, tekst, y) {
  y = ensure(doc, y, 26);
  doc.save();
  doc.roundedRect(PAGE.margin, y, CONTENT_W, 22, 6).fill(SOFT);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUT).text(schoon(tekst), PAGE.margin + 12, y + 6);
  doc.restore();
  return y + 26;
}

function fmtDatum(d) {
  // d = 'YYYY-MM-DD' of Date -> 'DD-MM-YYYY'
  if (!d) return '-';
  const s = String(d).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : schoon(s);
}
