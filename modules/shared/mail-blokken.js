// modules/shared/mail-blokken.js
//
// Mailbouwer (2026-10-11): een mail als lijst BLOKKEN (JSON) → e-mailveilige
// HTML. Eén bron voor browser (live voorbeeld in de bouwer) én server (opslaan
// van een sjabloon, versturen 1-op-1 en massa). De server compileert ALTIJD
// zelf uit de JSON — HTML uit de browser wordt voor blok-mails nooit vertrouwd.
//
// Output = TABELLEN + inline CSS (geen flex/grid/<style>), zodat Outlook, Gmail
// en Apple Mail het goed tonen. Twee kolommen = "hybrid": inline-block-divs
// (stapelen vanzelf op een smal scherm) + Outlook-tabel in conditionele
// commentaren. De output valt BINNEN de huisstijl-shell (mail-huisstijl.js):
// geen eigen kop, voet of afmeldregel.
//
// Blokken: kop · tekst · knop · afbeelding · kolommen · lijn · ruimte.
// Variabelen ({{voornaam}} e.d.) blijven staan; die vult de verzending in.
// Puur ESM, geen imports, geen Node-API's.

import { NAVY, GOUD } from './mail-huisstijl.js';

export const BLOK_SOORTEN = Object.freeze({
  kop: 'Kop',
  tekst: 'Tekst',
  knop: 'Knop',
  afbeelding: 'Afbeelding',
  kolommen: 'Twee kolommen',
  lijn: 'Scheidingslijn',
  ruimte: 'Ruimte',
});
export const MAIL_VARIABELEN = Object.freeze(['voornaam', 'achternaam', 'naam', 'email', 'boekingslink']);
export const MAX_BLOKKEN = 40;
export const INHOUD_BREEDTE = 540; // 600 kaart − 2×30 padding (zie de shell)

const TEKST_KLEUR = '#2b3a4a';
const FONT = 'Arial,Helvetica,sans-serif';
const UITLIJNINGEN = ['left', 'center', 'right'];

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kies = (v, lijst, standaard) => (lijst.includes(v) ? v : standaard);
const getal = (v, min, max, standaard) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : standaard; };
const kort = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** Link-doel dat in een mail mag: https/http, mailto, of één {{variabele}}. PURE. */
export function veiligeLink(url) {
  const u = String(url || '').trim();
  if (/^\{\{\s*\w+\s*\}\}$/.test(u)) return u;
  if (/^mailto:[^\s<>"]+$/i.test(u)) return u;
  if (/^https?:\/\/[^\s<>"]+$/i.test(u)) return u;
  return '';
}
/** Afbeeldingsbron: alleen https (mailclients halen hem op via een absolute URL). PURE. */
export function veiligeAfbeelding(url) {
  const u = String(url || '').trim();
  return /^https:\/\/[^\s<>"]+$/i.test(u) ? u : '';
}

const RIJK_TOEGESTAAN = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li']);
const GEVAARLIJK = 'script|style|iframe|object|embed|svg|math|template|noscript|textarea|select|button|form|head|title|meta|link';

/**
 * Rijke tekst (vet/cursief/onderstreept/link/lijst) opschonen: alleen de
 * toegestane tags, ZONDER attributen behalve een veilige href. PURE.
 */
export function schoonRijkeTekst(html) {
  let s = String(html || '').slice(0, 20000);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(new RegExp(`<(${GEVAARLIJK})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '');
  s = s.replace(new RegExp(`<\\/?(${GEVAARLIJK})\\b[^>]*>`, 'gi'), '');
  s = s.replace(/<div\b[^>]*>/gi, '<p>').replace(/<\/div\s*>/gi, '</p>'); // contenteditable maakt divs
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (tag, naam, attrs) => {
    const t = naam.toLowerCase();
    if (!RIJK_TOEGESTAAN.has(t)) return '';
    const sluit = tag.startsWith('</');
    if (t === 'br') return sluit ? '' : '<br>';
    if (t === 'b') return sluit ? '</strong>' : '<strong>';
    if (t === 'i') return sluit ? '</em>' : '<em>';
    if (sluit) return `</${t}>`;
    if (t === 'a') {
      const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs || '');
      const href = veiligeLink(m ? (m[2] ?? m[3] ?? m[4] ?? '') : '');
      return href ? `<a href="${esc(href)}">` : '<a>';
    }
    return `<${t}>`;
  });
  return s.replace(/<p>\s*<\/p>/g, '').trim();
}

/** Inline opmaak voor de opgeschoonde rijke tekst (mailclients negeren <style>). PURE. */
function opgemaakteTekst(html, { uitlijning = 'left', kleur = TEKST_KLEUR } = {}) {
  const P = `margin:0 0 12px;font-family:${FONT};font-size:15px;line-height:1.6;color:${kleur};text-align:${uitlijning}`;
  const LIJST = `margin:0 0 12px;padding-left:22px;font-family:${FONT};font-size:15px;line-height:1.6;color:${kleur};text-align:left`;
  let s = schoonRijkeTekst(html);
  if (!/<(p|ul|ol)>/.test(s) && s) s = `<p>${s}</p>`;
  return s
    .replace(/<p>/g, `<p style="${P}">`)
    .replace(/<(ul|ol)>/g, (m, t) => `<${t} style="${LIJST}">`)
    .replace(/<li>/g, '<li style="margin:0 0 4px">')
    .replace(/<a href=/g, `<a style="color:${NAVY};text-decoration:underline" href=`)
    .replace(/<a>/g, `<a style="color:${NAVY};text-decoration:underline">`);
}

/** Een nieuw blok met standaardwaarden. PURE. */
export function maakBlok(soort) {
  const id = 'b' + Math.random().toString(36).slice(2, 10);
  switch (soort) {
    case 'kop': return { id, soort, tekst: 'Een sterke kop', niveau: 'h2', uitlijning: 'left' };
    case 'tekst': return { id, soort, html: '<p>Hoi {{voornaam}},</p><p>Schrijf hier je tekst.</p>', uitlijning: 'left' };
    case 'knop': return { id, soort, tekst: 'Plan een gesprek', url: '{{boekingslink}}', stijl: 'navy', uitlijning: 'center' };
    case 'afbeelding': return { id, soort, url: '', alt: '', breedte: 100, link: '', uitlijning: 'center' };
    case 'kolommen': return { id, soort, links: { afbeelding: '', alt: '', html: '<p>Linker kolom</p>' }, rechts: { afbeelding: '', alt: '', html: '<p>Rechter kolom</p>' } };
    case 'lijn': return { id, soort, kleur: 'grijs' };
    case 'ruimte': return { id, soort, hoogte: 24 };
    default: return null;
  }
}

function normaliseerKolom(k = {}) {
  return { afbeelding: veiligeAfbeelding(k.afbeelding), alt: kort(k.alt, 200), html: schoonRijkeTekst(k.html) };
}

/**
 * Blokken controleren + opschonen (onbekende soorten/velden vallen weg). PURE.
 * -> { blokken, fouten:[tekst] }
 */
export function normaliseerBlokken(raw) {
  const fouten = [];
  const lijst = Array.isArray(raw) ? raw : [];
  if (lijst.length > MAX_BLOKKEN) fouten.push(`Maximaal ${MAX_BLOKKEN} blokken.`);
  const blokken = [];
  lijst.slice(0, MAX_BLOKKEN).forEach((b, i) => {
    if (!b || typeof b !== 'object' || !BLOK_SOORTEN[b.soort]) { fouten.push(`Blok ${i + 1}: onbekend soort.`); return; }
    const id = /^[a-z0-9]{2,20}$/i.test(String(b.id || '')) ? String(b.id) : 'b' + i;
    const uitlijning = kies(b.uitlijning, UITLIJNINGEN, b.soort === 'knop' || b.soort === 'afbeelding' ? 'center' : 'left');
    switch (b.soort) {
      case 'kop': {
        const tekst = kort(b.tekst, 200);
        if (!tekst) fouten.push(`Blok ${i + 1} (kop) is leeg.`);
        blokken.push({ id, soort: 'kop', tekst, niveau: kies(b.niveau, ['h2', 'h3'], 'h2'), uitlijning });
        break;
      }
      case 'tekst': {
        const html = schoonRijkeTekst(b.html);
        if (!html.replace(/<[^>]+>/g, '').trim()) fouten.push(`Blok ${i + 1} (tekst) is leeg.`);
        blokken.push({ id, soort: 'tekst', html, uitlijning });
        break;
      }
      case 'knop': {
        const tekst = kort(b.tekst, 80);
        const url = veiligeLink(b.url);
        if (!tekst) fouten.push(`Blok ${i + 1} (knop) heeft geen tekst.`);
        if (!url) fouten.push(`Blok ${i + 1} (knop) heeft geen geldige link (https://… of {{boekingslink}}).`);
        blokken.push({ id, soort: 'knop', tekst, url, stijl: kies(b.stijl, ['navy', 'goud'], 'navy'), uitlijning });
        break;
      }
      case 'afbeelding': {
        const url = veiligeAfbeelding(b.url);
        if (!url) fouten.push(`Blok ${i + 1} (afbeelding) heeft nog geen afbeelding.`);
        blokken.push({ id, soort: 'afbeelding', url, alt: kort(b.alt, 200), breedte: getal(b.breedte, 20, 100, 100), link: veiligeLink(b.link), uitlijning });
        break;
      }
      case 'kolommen': {
        const links = normaliseerKolom(b.links);
        const rechts = normaliseerKolom(b.rechts);
        const leeg = (k) => !k.afbeelding && !k.html.replace(/<[^>]+>/g, '').trim();
        if (leeg(links) && leeg(rechts)) fouten.push(`Blok ${i + 1} (twee kolommen) is leeg.`);
        blokken.push({ id, soort: 'kolommen', links, rechts });
        break;
      }
      case 'lijn': blokken.push({ id, soort: 'lijn', kleur: kies(b.kleur, ['grijs', 'goud'], 'grijs') }); break;
      case 'ruimte': blokken.push({ id, soort: 'ruimte', hoogte: getal(b.hoogte, 8, 80, 24) }); break;
      default: break;
    }
  });
  if (!blokken.length) fouten.push('Voeg minstens één blok toe.');
  return { blokken, fouten };
}

const rij = (inhoud, { padding = '0 0 16px', uitlijning = 'left' } = {}) =>
  `<tr><td align="${uitlijning}" style="padding:${padding};text-align:${uitlijning}">${inhoud}</td></tr>`;

function compileerKolom(k, breedte) {
  const img = k.afbeelding
    ? `<img src="${esc(k.afbeelding)}" alt="${esc(k.alt)}" width="${breedte}" style="display:block;width:100%;max-width:${breedte}px;height:auto;border:0;margin:0 0 10px;border-radius:6px" />`
    : '';
  const tekst = k.html ? opgemaakteTekst(k.html) : '';
  return img + tekst;
}

/** Eén blok → één tabelrij. PURE. */
export function compileerBlok(b) {
  switch (b.soort) {
    case 'kop': {
      const grootte = b.niveau === 'h3' ? 18 : 22;
      return rij(`<${b.niveau} style="margin:0;font-family:${FONT};font-size:${grootte}px;line-height:1.3;font-weight:700;color:${NAVY};text-align:${b.uitlijning}">${esc(b.tekst)}</${b.niveau}>`, { padding: '4px 0 12px', uitlijning: b.uitlijning });
    }
    case 'tekst':
      return rij(opgemaakteTekst(b.html, { uitlijning: b.uitlijning }), { padding: '0 0 4px', uitlijning: b.uitlijning });
    case 'knop': {
      const goud = b.stijl === 'goud';
      const achter = goud ? GOUD : NAVY;
      const voor = goud ? NAVY : '#ffffff';
      const knop = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${b.uitlijning}" style="margin:0 ${b.uitlijning === 'center' ? 'auto' : '0'}"><tr>
        <td align="center" bgcolor="${achter}" style="border-radius:8px;background:${achter}">
          <a href="${esc(b.url)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:15px;font-weight:700;line-height:1.2;color:${voor};text-decoration:none;border-radius:8px">${esc(b.tekst)}</a>
        </td></tr></table>`;
      return rij(knop, { padding: '8px 0 20px', uitlijning: b.uitlijning });
    }
    case 'afbeelding': {
      const px = Math.round(INHOUD_BREEDTE * b.breedte / 100);
      let img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" width="${px}" style="display:block;width:100%;max-width:${px}px;height:auto;border:0;border-radius:8px;margin:${b.uitlijning === 'center' ? '0 auto' : b.uitlijning === 'right' ? '0 0 0 auto' : '0'}" />`;
      if (b.link) img = `<a href="${esc(b.link)}" target="_blank" style="text-decoration:none">${img}</a>`;
      return rij(img, { padding: '4px 0 18px', uitlijning: b.uitlijning });
    }
    case 'kolommen': {
      // 2 × 270 = 540; 6px binnenmarge per kant = 12px tussenruimte. Op een smal
      // scherm stapelen de inline-blocks, allebei even ver ingesprongen.
      const kol = 270;
      const div = (inhoud) => `<div style="display:inline-block;width:100%;max-width:${kol}px;vertical-align:top;font-size:15px;text-align:left">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 6px 12px">${inhoud}</td></tr></table></div>`;
      const inhoud = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="font-size:0;text-align:center">
        <!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="${kol}" valign="top"><![endif]-->
        ${div(compileerKolom(b.links, kol - 12))}
        <!--[if mso]></td><td width="${kol}" valign="top"><![endif]-->
        ${div(compileerKolom(b.rechts, kol - 12))}
        <!--[if mso]></td></tr></table><![endif]-->
      </td></tr></table>`;
      return rij(inhoud, { padding: '4px 0 8px' });
    }
    case 'lijn': {
      const kleur = b.kleur === 'goud' ? GOUD : '#dfe5ec';
      return rij(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:${b.kleur === 'goud' ? 2 : 1}px solid ${kleur};font-size:0;line-height:0">&nbsp;</td></tr></table>`, { padding: '8px 0 20px' });
    }
    case 'ruimte':
      return `<tr><td style="height:${b.hoogte}px;font-size:0;line-height:0">&nbsp;</td></tr>`;
    default:
      return '';
  }
}

/** Kan dit (genormaliseerde) blok in een mail? Halve blokken (knop zonder link,
 *  afbeelding zonder bron, lege kop/tekst) worden NIET gecompileerd. PURE. */
export function bruikbaar(b) {
  const leegHtml = (h) => !String(h || '').replace(/<[^>]+>/g, '').trim();
  switch (b.soort) {
    case 'kop': return !!b.tekst;
    case 'tekst': return !leegHtml(b.html);
    case 'knop': return !!(b.tekst && b.url);
    case 'afbeelding': return !!b.url;
    case 'kolommen': return !!(b.links.afbeelding || !leegHtml(b.links.html) || b.rechts.afbeelding || !leegHtml(b.rechts.html));
    default: return true;
  }
}

/**
 * Blokken → de inhoud van de mail (gaat BINNEN de huisstijl-shell). Normaliseert
 * eerst en laat halve blokken weg, dus ook met rauwe invoer veilig. PURE.
 */
export function compileerBlokken(raw) {
  const blokken = normaliseerBlokken(raw).blokken.filter(bruikbaar);
  if (!blokken.length) return '';
  return `<!-- dfo-mailbouwer v1 --><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%">
${blokken.map(compileerBlok).join('\n')}
</table>`;
}

/** Bestaande (losse) HTML als startpunt in de bouwer: één tekstblok. PURE. */
export function blokkenUitHtml(html) {
  const schoon = schoonRijkeTekst(html);
  return schoon ? [{ ...maakBlok('tekst'), html: schoon }] : [maakBlok('tekst')];
}
