// api/_lib/cash-ontvangstbewijs-pdf.js
//
// Ontvangstbewijs van een contante betaling (A4, pdfkit). Puur op zijn invoer:
// geen DB, geen netwerk. De interne notitie staat er bewust NIET op — het
// bewijs kan aan de klant gegeven worden; de notitie blijft in het CRM.
//
// bouwOntvangstbewijsPdf({ bewijs, factuur, klantNaam, bedrijf, ingetrokken }) → Promise<Buffer>

import PDFDocument from 'pdfkit';

const EUR = (n) => '€ ' + (Number(n) || 0).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
export function datumNl(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '—';
  const [y, m, d] = s.split('-').map(Number);
  return `${d} ${MAANDEN[m - 1]} ${y}`;
}

/** Puur: de regels die op het bewijs komen (ook gebruikt door tests). */
export function bewijsRegels({ bewijs, factuur, klantNaam }) {
  const open = factuur ? Math.max(0, Math.round(((Number(factuur.amount_total) || 0) - (Number(factuur.amount_paid) || 0) - (Number(factuur.credited_amount) || 0)) * 100) / 100) : null;
  return [
    ['Ontvangstbewijs', bewijs.bewijsnummer],
    ['Datum ontvangst', datumNl(bewijs.ontvangen_op)],
    ['Ontvangen van', klantNaam || '—'],
    ['Voor factuur', factuur?.invoice_number || '—'],
    ['Factuurbedrag', factuur ? EUR(factuur.amount_total) : '—'],
    ['Ontvangen bedrag (contant)', EUR(bewijs.bedrag)],
    ['Nog open op deze factuur', open == null ? '—' : EUR(open)],
    ['Ontvangen door', bewijs.ontvangen_door],
  ];
}

export function bouwOntvangstbewijsPdf({ bewijs, factuur, klantNaam, bedrijf = {}, ingetrokken = false }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Ontvangstbewijs ${bewijs.bewijsnummer}` } });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a').text(bedrijf.naam || 'De Forex Opleiding NL B.V.', { align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#475569');
      for (const r of [bedrijf.adres, bedrijf.kvk ? `KvK ${bedrijf.kvk}` : null, bedrijf.btw ? `Btw ${bedrijf.btw}` : null, bedrijf.email].filter(Boolean)) doc.text(r, { align: 'right' });

      doc.moveDown(2);
      doc.font('Helvetica-Bold').fontSize(20).fillColor('#0f172a').text('Ontvangstbewijs contante betaling');
      if (ingetrokken) {
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c').text('INGETROKKEN — deze betaling is teruggedraaid en telt niet meer.');
      }
      doc.moveDown(1.2);

      let y = doc.y;
      for (const [l, w] of bewijsRegels({ bewijs, factuur, klantNaam })) {
        doc.font('Helvetica-Bold').fontSize(10).fillColor('#475569').text(l, 56, y, { width: 190 });
        doc.font('Helvetica').fontSize(11).fillColor('#0f172a').text(String(w ?? '—'), 250, y, { width: 290 });
        y = Math.max(doc.y, y + 16) + 8;
      }

      doc.moveDown(1.5);
      doc.font('Helvetica').fontSize(9).fillColor('#475569').text(
        'Wij bevestigen dat bovenstaand bedrag contant werd ontvangen als (deel)betaling van de vermelde factuur. ' +
        'De factuur blijft bestaan; enkel het openstaande bedrag vermindert.', 56, doc.y, { width: 484 });

      const yh = Math.max(doc.y + 60, 640);
      doc.moveTo(56, yh).lineTo(266, yh).strokeColor('#94a3b8').stroke();
      doc.moveTo(330, yh).lineTo(540, yh).stroke();
      doc.font('Helvetica').fontSize(9).fillColor('#475569')
        .text(`Handtekening ontvanger (${bewijs.ontvangen_door})`, 56, yh + 6, { width: 210 })
        .text('Handtekening klant', 330, yh + 6, { width: 210 });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
