// api/_lib/esign-core.js
//
// E-handtekening — pure regels (geen DB, geen netwerk). Getest in
// tests/esign.test.js. IO staat in esign-server.js.
//
//   - tokens: 32 willekeurige bytes (base64url) → alleen de SHA-256 in de DB;
//   - wie krijgt nu een uitnodiging (sequentieel / parallel);
//   - envelope-status uit de ontvangers;
//   - controle van een veld-definitie (editor) en van een invulling (tekenen);
//   - tekst veilig voor de standaardfont van pdf-lib (WinAnsi).

import { createHash, randomBytes } from 'node:crypto';
import { VELD_TYPES, veldGeldig } from '../../modules/esign/esign-coords.js';

export const BUCKET = 'e-handtekening';
export const TOKEN_GELDIG_DAGEN = 14;          // keuze Jeffrey 9 nov 2026
export const MAX_ONTVANGERS = 10;
export const MAX_VELDEN = 200;
export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_BEELD_BYTES = 300 * 1024;
export const MAX_TEKST = 500;

export const ENVELOPE_STATUS = Object.freeze(['concept', 'verzonden', 'deels_getekend', 'voltooid', 'ingetrokken']);
export const ACTIEF = Object.freeze(['verzonden', 'deels_getekend']);

// ── Tokens ──────────────────────────────────────────────────────────────────

export function hashToken(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** Nieuw token (256 bit) + hash + vervaldatum. Het token gaat ALLEEN in de mail. */
export function maakToken(nu = new Date(), dagen = TOKEN_GELDIG_DAGEN) {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashToken(token),
    verloopt_op: new Date(nu.getTime() + dagen * 86400000).toISOString(),
  };
}

/** Ziet eruit als een van onze tokens (43 tekens base64url)? Voorkomt zinloze lookups. */
export function tokenVorm(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ── Volgorde ────────────────────────────────────────────────────────────────

const OPEN = new Set(['wacht', 'uitgenodigd', 'geopend']);

/**
 * Welke ontvangers moeten NU een uitnodiging krijgen (en hebben er nog geen)?
 * Parallel: iedereen die nog 'wacht'. Sequentieel: alleen de eerste nog niet
 * getekende ontvanger, en alleen als die nog 'wacht'.
 */
export function teUitnodigen(ontvangers, volgorde) {
  const lijst = [...(ontvangers || [])].sort((a, b) => a.volgnummer - b.volgnummer);
  if (volgorde === 'parallel') return lijst.filter((o) => o.status === 'wacht');
  const eerste = lijst.find((o) => o.status !== 'getekend');
  return eerste && eerste.status === 'wacht' ? [eerste] : [];
}

/** Ontvangers die nu een geldige link horen te hebben (voor "opnieuw versturen"). */
export function aanDeBeurt(ontvangers, volgorde) {
  const lijst = [...(ontvangers || [])].sort((a, b) => a.volgnummer - b.volgnummer);
  if (volgorde === 'parallel') return lijst.filter((o) => o.status === 'uitgenodigd' || o.status === 'geopend');
  const eerste = lijst.find((o) => o.status !== 'getekend');
  return eerste && (eerste.status === 'uitgenodigd' || eerste.status === 'geopend') ? [eerste] : [];
}

export function iedereenGetekend(ontvangers) {
  return Array.isArray(ontvangers) && ontvangers.length > 0 && ontvangers.every((o) => o.status === 'getekend');
}

/** Status van een verstuurde envelope uit zijn ontvangers (voltooid zet het afronden). */
export function statusUitOntvangers(ontvangers) {
  return (ontvangers || []).some((o) => o.status === 'getekend') ? 'deels_getekend' : 'verzonden';
}

/** Mag deze ontvanger (sequentieel) al tekenen? */
export function magTekenen(ontvanger, ontvangers, volgorde) {
  if (!ontvanger || !OPEN.has(ontvanger.status) || ontvanger.status === 'wacht') return false;
  if (volgorde === 'parallel') return true;
  return (ontvangers || []).every((o) => o.volgnummer >= ontvanger.volgnummer || o.status === 'getekend');
}

// ── Versturen: is de envelope compleet? ─────────────────────────────────────

/**
 * @returns {string[]} problemen (leeg = klaar om te versturen)
 */
export function klaarOmTeVersturen({ envelope, documenten, ontvangers, velden }) {
  const p = [];
  if (!envelope || envelope.status !== 'concept') p.push('Alleen een concept kan verstuurd worden.');
  if (!documenten || documenten.length !== 1) p.push('Upload precies één PDF.');
  if (!ontvangers || ontvangers.length === 0) p.push('Kies minstens één ondertekenaar.');
  if ((ontvangers || []).some((o) => o.soort !== 'intern')) p.push('Externe ondertekenaars komen in een latere fase.');
  for (const o of ontvangers || []) {
    const eigen = (velden || []).filter((v) => v.ontvanger_id === o.id);
    if (!eigen.some((v) => v.type === 'handtekening')) p.push(`${o.naam} heeft nog geen handtekeningveld.`);
  }
  return p;
}

// ── Velden (editor) ─────────────────────────────────────────────────────────

/**
 * Controleer de velden uit de editor tegen de documenten en ontvangers.
 * @returns {{ ok:boolean, fout?:string, velden?:object[] }}
 */
export function valideerVeldDefinities(invoer, { documenten, ontvangers }) {
  if (!Array.isArray(invoer)) return { ok: false, fout: 'velden moet een lijst zijn' };
  if (invoer.length > MAX_VELDEN) return { ok: false, fout: `maximaal ${MAX_VELDEN} velden` };
  const docs = new Map((documenten || []).map((d) => [d.id, d]));
  const ontv = new Set((ontvangers || []).map((o) => o.id));
  const uit = [];
  for (const [i, v] of invoer.entries()) {
    if (!veldGeldig(v)) return { ok: false, fout: `veld ${i + 1}: ongeldige positie of type` };
    const doc = docs.get(v.document_id);
    if (!doc) return { ok: false, fout: `veld ${i + 1}: onbekend document` };
    const aantal = Array.isArray(doc.paginas) ? doc.paginas.length : 0;
    if (Number(v.pagina) > aantal) return { ok: false, fout: `veld ${i + 1}: pagina ${v.pagina} bestaat niet` };
    if (!ontv.has(v.ontvanger_id)) return { ok: false, fout: `veld ${i + 1}: onbekende ondertekenaar` };
    uit.push({
      document_id: v.document_id,
      ontvanger_id: v.ontvanger_id,
      type: v.type,
      pagina: Number(v.pagina),
      x: Number(v.x), y: Number(v.y), breedte: Number(v.breedte), hoogte: Number(v.hoogte),
      verplicht: v.type === 'handtekening' || v.type === 'datum' || v.type === 'naam' ? true : v.verplicht !== false,
    });
  }
  return { ok: true, velden: uit };
}

// ── Invulling (tekenen) ─────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** data:image/png;base64,… → Buffer, of null als het geen geldige PNG binnen de grens is. */
export function pngUitDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 67 || buf.length > MAX_BEELD_BYTES) return null;
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  return buf;
}

/** Datum zoals die op het document komt: dd-mm-jjjj in Brusselse tijd. */
export function datumNl(d = new Date()) {
  const p = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Brussels', day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.day}-${p.month}-${p.year}`;
}

/**
 * Controleer wat een ondertekenaar instuurt tegen ZIJN velden.
 * @param {object[]} velden      de velden van deze ontvanger (uit de DB)
 * @param {object}   invoer      { akkoord, waarden:{[veldId]:string|boolean},
 *                                 handtekening:{dataUrl,methode}, paraaf:{dataUrl,methode} }
 * @param {object}   ontvanger   { naam }
 * @returns {{ ok:boolean, fout?:string, veld_id?:string, waarden?:Map, beelden?:object }}
 */
export function valideerInvulling(velden, invoer, ontvanger, nu = new Date()) {
  const inv = invoer || {};
  if (inv.akkoord !== true) return { ok: false, fout: 'Vink aan dat je akkoord gaat met elektronisch ondertekenen.' };
  const w = inv.waarden && typeof inv.waarden === 'object' ? inv.waarden : {};
  const beelden = {};
  for (const soort of ['handtekening', 'paraaf']) {
    if (!(velden || []).some((v) => v.type === soort)) continue;
    const blok = inv[soort] || {};
    const png = pngUitDataUrl(blok.dataUrl);
    if (!png) return { ok: false, fout: soort === 'handtekening' ? 'Plaats je handtekening.' : 'Plaats je paraaf.' };
    const methode = blok.methode === 'getypt' ? 'getypt' : blok.methode === 'getekend' ? 'getekend' : null;
    if (!methode) return { ok: false, fout: `Onbekende methode voor de ${soort}.` };
    beelden[soort] = { png, methode };
  }
  const waarden = new Map();
  for (const v of velden || []) {
    if (v.type === 'handtekening' || v.type === 'paraaf') continue;
    if (v.type === 'datum') { waarden.set(v.id, datumNl(nu)); continue; }
    if (v.type === 'naam')  { waarden.set(v.id, String(ontvanger?.naam || '').slice(0, 200)); continue; }
    const raw = w[v.id];
    if (v.type === 'checkbox') {
      const aan = raw === true || raw === 'ja';
      if (v.verplicht && !aan) return { ok: false, fout: 'Vink alle verplichte vakjes aan.', veld_id: v.id };
      waarden.set(v.id, aan ? 'ja' : 'nee');
      continue;
    }
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (t.length > MAX_TEKST) return { ok: false, fout: `Tekst is te lang (max ${MAX_TEKST} tekens).`, veld_id: v.id };
    if (v.verplicht && !t) return { ok: false, fout: 'Vul alle verplichte tekstvelden in.', veld_id: v.id };
    waarden.set(v.id, t || null);
  }
  return { ok: true, waarden, beelden };
}

// ── Tekst voor de standaardfont van pdf-lib ─────────────────────────────────

// Helvetica (StandardFonts) kent alleen WinAnsi: alles daarbuiten gooit een fout
// bij drawText. Vervang typografische tekens en laat de rest vallen.
const VERVANG = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ' };
export function winAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’“”–—… ]/g, (c) => VERVANG[c])
    .normalize('NFC')
    .replace(/[^\x20-\x7e¡-ÿ€]/g, '');
}

export { VELD_TYPES };
