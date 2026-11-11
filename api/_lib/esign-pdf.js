// api/_lib/esign-pdf.js
//
// E-handtekening — het definitieve PDF: velden inbranden (pdf-lib) + een
// audit-certificaatpagina achteraan. Puur op bytes: geen DB, geen opslag.
//
// maakGetekendePdf({ origineel, document, envelope, ontvangers, velden, beelden, events })
//   origineel  Uint8Array/Buffer van de originele PDF
//   document   esign_documenten-rij (naam, sha256, paginas)
//   velden     esign_velden-rijen met waarde
//   beelden    Map ontvanger_id → { handtekening?: Buffer(PNG), paraaf?: Buffer(PNG) }
//   events     esign_events-rijen (op tijd gesorteerd)
// → Uint8Array
//
// Positie: modules/esign/esign-coords.js (plaatsInPdf) — dezelfde code als de
// editor, zodat wat je plaatst ook precies daar ingebrand wordt, ook op
// gedraaide pagina's (/Rotate 90/180/270).

import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { plaatsInPdf, normaliseerRotatie } from '../../modules/esign/esign-coords.js';
import { winAnsi } from './esign-core.js';

const NAVY = rgb(0x10 / 255, 0x28 / 255, 0x4a / 255);
const GRIJS = rgb(0.38, 0.42, 0.48);
const LIJN = rgb(0.85, 0.87, 0.9);
const INKT = rgb(0.06, 0.11, 0.25);

const TZ = 'Europe/Brussels';
export function tijdNl(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '-';
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(d).replace(',', '');
}

const EVENT_LABEL = {
  aangemaakt: 'Envelope aangemaakt', verzonden: 'Verzonden', uitgenodigd: 'Uitnodiging gemaild',
  opnieuw_verzonden: 'Opnieuw verstuurd (nieuwe link)', geopend: 'Document geopend', getekend: 'Ondertekend',
  voltooid: 'Voltooid', ingetrokken: 'Ingetrokken', mail_mislukt: 'Mail mislukt', afronden_mislukt: 'Afronden mislukt',
};
const METHODE_LABEL = {
  crm_login: 'CRM (ingelogd)', email_token_link: 'Persoonlijke link uit e-mail', systeem: 'Systeem',
};

// Punt in het lokale assenstelsel van een veld (linksonder, rechtop voor de
// lezer) → PDF-punt, rekening houdend met de paginarotatie.
function lokaal(pl, lx, ly) {
  const rad = (pl.rotatie * Math.PI) / 180;
  const c = Math.round(Math.cos(rad)); const s = Math.round(Math.sin(rad));
  return { x: pl.x + lx * c - ly * s, y: pl.y + lx * s + ly * c };
}

function tekstPassend(font, tekst, maxBreedte, maxGrootte) {
  let size = Math.max(5, Math.min(maxGrootte, 14));
  while (size > 5 && font.widthOfTextAtSize(tekst, size) > maxBreedte) size -= 0.5;
  let t = tekst;
  while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxBreedte) t = t.slice(0, -1);
  return { tekst: t, size };
}

async function brandVeldIn(pdf, page, pageInfo, veld, font, beeldCache, beelden) {
  const box = pageInfo.box;
  const pl = plaatsInPdf(veld, box, pageInfo.rotatie);
  const pad = Math.min(2, pl.hoogte * 0.08);

  if (veld.type === 'handtekening' || veld.type === 'paraaf') {
    const png = beelden.get(veld.ontvanger_id)?.[veld.type];
    if (!png) return;
    const sleutel = `${veld.ontvanger_id}:${veld.type}`;
    let img = beeldCache.get(sleutel);
    if (!img) { img = await pdf.embedPng(png); beeldCache.set(sleutel, img); }
    const schaal = Math.min((pl.breedte - 2 * pad) / img.width, (pl.hoogte - 2 * pad) / img.height);
    const w = img.width * schaal; const h = img.height * schaal;
    const o = lokaal(pl, pad + (pl.breedte - 2 * pad - w) / 2, pad + (pl.hoogte - 2 * pad - h) / 2);
    page.drawImage(img, { x: o.x, y: o.y, width: w, height: h, rotate: degrees(pl.rotatie) });
    return;
  }

  if (veld.type === 'checkbox') {
    if (veld.waarde !== 'ja') return;
    const z = Math.min(pl.breedte, pl.hoogte);
    const a = lokaal(pl, z * 0.2, z * 0.5);
    const b = lokaal(pl, z * 0.42, z * 0.22);
    const c = lokaal(pl, z * 0.82, z * 0.8);
    const dikte = Math.max(1, z * 0.1);
    page.drawLine({ start: a, end: b, thickness: dikte, color: INKT });
    page.drawLine({ start: b, end: c, thickness: dikte, color: INKT });
    return;
  }

  const ruw = winAnsi(veld.waarde || '');
  if (!ruw) return;
  const { tekst, size } = tekstPassend(font, ruw, pl.breedte - 2 * pad, pl.hoogte * 0.72);
  const o = lokaal(pl, pad, (pl.hoogte - size) / 2 + size * 0.22);
  page.drawText(tekst, { x: o.x, y: o.y, size, font, color: INKT, rotate: degrees(pl.rotatie) });
}

// ── Certificaat ─────────────────────────────────────────────────────────────

function maakSchrijver(pdf, fonts) {
  const A4 = [595.28, 841.89];
  const M = 50;
  let page = pdf.addPage(A4);
  let y = A4[1] - M;
  const breedte = A4[0] - 2 * M;

  function nieuwePagina() { page = pdf.addPage(A4); y = A4[1] - M; }
  function ruimte(h) { if (y - h < M + 20) nieuwePagina(); }
  function regels(tekst, font, size, max) {
    const woorden = winAnsi(tekst).split(/\s+/).filter(Boolean);
    const uit = []; let r = '';
    for (const w of woorden) {
      let woord = w;
      while (font.widthOfTextAtSize(woord, size) > max) {          // te lang woord (hash, UA)
        let i = woord.length;
        while (i > 1 && font.widthOfTextAtSize(woord.slice(0, i), size) > max) i--;
        if (r) { uit.push(r); r = ''; }
        uit.push(woord.slice(0, i)); woord = woord.slice(i);
      }
      const test = r ? r + ' ' + woord : woord;
      if (font.widthOfTextAtSize(test, size) > max) { uit.push(r); r = woord; } else r = test;
    }
    if (r) uit.push(r);
    return uit.length ? uit : [''];
  }
  return {
    kop(t) {
      ruimte(40);
      page.drawText(winAnsi(t), { x: M, y: y - 20, size: 18, font: fonts.vet, color: NAVY });
      y -= 34;
    },
    sub(t) {
      ruimte(28); y -= 6;
      page.drawText(winAnsi(t), { x: M, y: y - 12, size: 11.5, font: fonts.vet, color: NAVY });
      y -= 18;
      page.drawLine({ start: { x: M, y }, end: { x: M + breedte, y }, thickness: 0.6, color: LIJN });
      y -= 8;
    },
    tekst(t, { size = 9, kleur = GRIJS, vet = false } = {}) {
      const font = vet ? fonts.vet : fonts.gewoon;
      for (const r of regels(t, font, size, breedte)) {
        ruimte(size + 4);
        page.drawText(r, { x: M, y: y - size, size, font, color: kleur });
        y -= size + 3.5;
      }
    },
    paar(label, waarde) {
      const lb = 120; const size = 9;
      const rs = regels(waarde == null || waarde === '' ? '-' : String(waarde), fonts.gewoon, size, breedte - lb);
      ruimte(rs.length * (size + 3.5) + 2);
      page.drawText(winAnsi(label), { x: M, y: y - size, size, font: fonts.vet, color: GRIJS });
      for (const r of rs) {
        page.drawText(r, { x: M + lb, y: y - size, size, font: fonts.gewoon, color: INKT });
        y -= size + 3.5;
      }
      y -= 1;
    },
    rij(kolommen, breedtes, { vet = false } = {}) {
      const size = 8; const font = vet ? fonts.vet : fonts.gewoon;
      const cellen = kolommen.map((k, i) => regels(String(k ?? '-'), font, size, breedtes[i] - 6));
      const n = Math.max(...cellen.map((c) => c.length));
      ruimte(n * (size + 3) + 4);
      let x = M;
      cellen.forEach((c, i) => {
        c.forEach((r, j) => page.drawText(r, { x, y: y - size - j * (size + 3), size, font, color: vet ? GRIJS : INKT }));
        x += breedtes[i];
      });
      y -= n * (size + 3) + 4;
    },
    witruimte(h) { y -= h; },
  };
}

function schrijfCertificaat(pdf, fonts, { envelope, document, ontvangers, events }) {
  const s = maakSchrijver(pdf, fonts);
  s.kop('Certificaat van ondertekening');
  s.tekst('Dit certificaat hoort bij het document hierboven en legt vast wie het elektronisch ondertekende, wanneer en hoe. Opgesteld door het CRM van De Forex Opleiding NL B.V.', { size: 9 });
  s.witruimte(4);

  s.sub('Envelope');
  s.paar('Titel', envelope.titel);
  s.paar('Envelope-ID', envelope.id);
  s.paar('Document', document.naam);
  s.paar('Pagina\'s', String(Array.isArray(document.paginas) ? document.paginas.length : '-'));
  s.paar('SHA-256 origineel', document.sha256);
  s.paar('Tekenvolgorde', envelope.volgorde === 'parallel' ? 'Parallel (iedereen tegelijk)' : 'Sequentieel (een voor een)');
  s.paar('Verzonden', tijdNl(envelope.verzonden_op));
  s.paar('Voltooid', tijdNl(envelope.voltooid_op));

  s.sub('Ondertekenaars');
  const perOntvanger = new Map();
  for (const e of events || []) {
    if (!e.ontvanger_id) continue;
    if (!perOntvanger.has(e.ontvanger_id)) perOntvanger.set(e.ontvanger_id, []);
    perOntvanger.get(e.ontvanger_id).push(e);
  }
  for (const o of [...ontvangers].sort((a, b) => a.volgnummer - b.volgnummer)) {
    const ev = perOntvanger.get(o.id) || [];
    const getekend = [...ev].reverse().find((e) => e.type === 'getekend');
    const geopend = ev.find((e) => e.type === 'geopend');
    s.tekst(`${o.volgnummer}. ${o.naam}`, { size: 10, kleur: NAVY, vet: true });
    s.paar('E-mail', o.email);
    s.paar('Soort', o.soort === 'intern' ? 'Intern (teamlid)' : 'Extern');
    s.paar('Uitgenodigd', tijdNl(o.uitgenodigd_op));
    s.paar('Eerst geopend', tijdNl(geopend?.tijdstip || o.geopend_op));
    s.paar('Ondertekend', tijdNl(getekend?.tijdstip || o.getekend_op));
    s.paar('IP-adres', getekend?.ip || '-');
    s.paar('Apparaat (user-agent)', getekend?.user_agent || '-');
    const hm = o.handtekening_methode === 'getypt' ? 'getypt' : o.handtekening_methode === 'getekend' ? 'met de hand getekend' : '-';
    s.paar('Verificatie', 'Persoonlijke link per e-mail (niet-raadbaar token, alleen voor deze ondertekenaar) + uitdrukkelijk akkoord met elektronisch ondertekenen');
    s.paar('Handtekening', hm);
    s.witruimte(6);
  }

  s.sub('Gebeurtenissen');
  const W = [118, 120, 120, 137];
  s.rij(['Tijdstip', 'Gebeurtenis', 'Wie', 'IP / via'], W, { vet: true });
  const naam = new Map(ontvangers.map((o) => [o.id, o.naam]));
  for (const e of events || []) {
    s.rij([
      tijdNl(e.tijdstip),
      EVENT_LABEL[e.type] || e.type,
      e.ontvanger_id ? (naam.get(e.ontvanger_id) || '-') : (e.details?.door_naam || (e.methode === 'systeem' ? 'Systeem' : 'CRM')),
      `${e.ip || '-'} · ${METHODE_LABEL[e.methode] || e.methode}`,
    ], W);
  }

  s.witruimte(8);
  s.tekst('De SHA-256-hash van dit getekende bestand staat in het CRM en in de afrondingsmail. Een bestand kan zijn eigen hash niet bevatten; wie het bestand opnieuw hasht en dezelfde waarde krijgt, weet dat er na het ondertekenen niets aan veranderd is.', { size: 8 });
}

/**
 * @returns {Promise<Uint8Array>}
 */
export async function maakGetekendePdf({ origineel, document, envelope, ontvangers, velden, beelden, events }) {
  const pdf = await PDFDocument.load(origineel, { updateMetadata: false });
  const fonts = {
    gewoon: await pdf.embedFont(StandardFonts.Helvetica),
    vet: await pdf.embedFont(StandardFonts.HelveticaBold),
  };
  const paginas = pdf.getPages();
  const info = Array.isArray(document.paginas) ? document.paginas : [];
  const beeldCache = new Map();
  for (const v of velden || []) {
    const page = paginas[v.pagina - 1];
    const pi = info[v.pagina - 1];
    if (!page || !pi) throw new Error(`veld op pagina ${v.pagina} bestaat niet in het document`);
    await brandVeldIn(pdf, page, pi, v, fonts.gewoon, beeldCache, beelden || new Map());
  }
  schrijfCertificaat(pdf, fonts, { envelope, document, ontvangers: ontvangers || [], events: events || [] });
  pdf.setTitle(winAnsi(envelope.titel || 'Ondertekend document'));
  pdf.setProducer('DFO CRM e-handtekening');
  pdf.setModificationDate(new Date(envelope.voltooid_op || Date.now()));
  return pdf.save({ useObjectStreams: false });
}

/**
 * Pagina-info van een geüploade PDF: [{ breedte, hoogte, rotatie, box }] in punten.
 * box = CropBox (die toont pdf.js); breedte/hoogte = getoonde maat.
 * Gooit bij een versleutelde of onleesbare PDF.
 */
export async function leesPaginas(bytes) {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((p) => {
    const cb = p.getCropBox();
    const rotatie = normaliseerRotatie(p.getRotation().angle);
    const box = { x: cb.x, y: cb.y, breedte: cb.width, hoogte: cb.height };
    const gedraaid = rotatie % 180 !== 0;
    return { breedte: gedraaid ? box.hoogte : box.breedte, hoogte: gedraaid ? box.breedte : box.hoogte, rotatie, box };
  });
}
