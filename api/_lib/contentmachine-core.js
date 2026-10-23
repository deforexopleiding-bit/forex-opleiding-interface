// api/_lib/contentmachine-core.js
//
// Contentmachine (2026-10-23) — pure helpers, zonder databank of netwerk.
// Gedeeld door api/contentmachine/*.js en de tests.
//
//   - slug van een drop:      'dd-mm-jj' (tweede drop die dag: 'dd-mm-jj-2')
//   - Vimeo-link ontleden:    id + hash (privé-link) + starttijd
//   - invoer opschonen:       wat de module bewaart in content_drops.input
//   - beeldmaat uit de bytes: PNG / JPEG / GIF / WebP (geen extra pakket)
//   - seed-bibliotheek:       metadata uit de bestandsnaam

export const DROP_STATUSSEN = ['concept', 'gegenereerd', 'goedgekeurd', 'gepubliceerd', 'gearchiveerd'];
export const ASSET_SOORTEN = ['payout', 'trade', 'chart', 'masterclass', 'team', 'community', 'overig'];
export const KANALEN = ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'];
export const BUCKET = 'content';
export const MAX_BEELD_BYTES = 10 * 1024 * 1024;

/** Studenten (en Maxim) die toestemming gaven om hun resultaat publiek te tonen. */
export const TOESTEMMING_NAMEN = ['shani', 'leslie', 'karl', 'luc', 'maxim'];

export const SLUG_RE = /^[0-9]{2}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,12})?$/;

/** 'YYYY-MM-DD' → 'dd-mm-jj'. null bij een ongeldige datum. */
export function slugVanDatum(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return `${m[3]}-${m[2]}-${m[1].slice(2)}`;
}

/** 'dd-mm-jj[-x]' → 'YYYY-MM-DD' (eeuw 20xx). */
export function datumVanSlug(slug) {
  const m = /^(\d{2})-(\d{2})-(\d{2})/.exec(String(slug || ''));
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Eerste vrije slug: basis, dan basis-2, basis-3 … */
export function vrijeSlug(basis, bestaande = []) {
  const set = new Set(bestaande);
  if (!set.has(basis)) return basis;
  for (let i = 2; i < 100; i++) if (!set.has(`${basis}-${i}`)) return `${basis}-${i}`;
  return null;
}

/**
 * Vimeo-link → { vimeo_id, vimeo_hash, vimeo_url } of null.
 * Kent: player.vimeo.com/video/<id>?h=<hash>, vimeo.com/<id>/<hash>, vimeo.com/<id>,
 * vimeo.com/channels|showcase/…/<id>.
 */
export function parseVimeo(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (!/(^|\.)vimeo\.com$/i.test(u.hostname)) return null;
  const delen = u.pathname.split('/').filter(Boolean);
  let id = null; let hash = u.searchParams.get('h') || null;
  if (/^player\./i.test(u.hostname)) {
    if (delen[0] === 'video' && /^\d+$/.test(delen[1] || '')) id = delen[1];
  } else {
    const i = delen.findIndex((d) => /^\d+$/.test(d));
    if (i >= 0) {
      id = delen[i];
      if (!hash && delen[i + 1] && /^[0-9a-f]{6,}$/i.test(delen[i + 1])) hash = delen[i + 1];
    }
  }
  if (!id) return null;
  if (hash && !/^[0-9a-f]{6,}$/i.test(hash)) hash = null;
  return { vimeo_id: id, vimeo_hash: hash, vimeo_url: `https://player.vimeo.com/video/${id}${hash ? '?h=' + hash : ''}` };
}

/** 'mm:ss', 'h:mm:ss' of seconden → seconden (int ≥ 0), null bij onzin. */
export function parseStart(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (!m || +m[3] > 59) return null;
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
}

/** seconden → 'mm:ss' (of 'h:mm:ss'). */
export function fmtStart(sec) {
  if (sec == null || !Number.isFinite(+sec)) return '';
  const t = Math.max(0, Math.floor(+sec));
  const h = Math.floor(t / 3600); const m = Math.floor((t % 3600) / 60); const s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

const tekst = (v, max) => (v == null ? '' : String(v).replace(/\r\n/g, '\n').trim().slice(0, max));

/**
 * Invoer uit het formulier → wat in content_drops.input komt. PURE.
 * Onbekende sleutels vallen weg; lengtes worden begrensd.
 */
export function normaliseerInput(b = {}) {
  const vimeo = parseVimeo(b.vimeo_url);
  const trade = b.trade_info && typeof b.trade_info === 'object' ? b.trade_info : {};
  const r = trade.resultaat_r === '' || trade.resultaat_r == null ? null : Number(String(trade.resultaat_r).replace(',', '.'));
  const kanalen = Array.isArray(b.kanalen) ? b.kanalen.filter((k) => KANALEN.includes(k)) : KANALEN.slice();
  const ids = Array.isArray(b.gekozen_asset_ids) ? b.gekozen_asset_ids.filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))) : [];
  const meta = b.vimeo_meta && typeof b.vimeo_meta === 'object' ? b.vimeo_meta : {};
  return {
    vimeo_url: vimeo ? vimeo.vimeo_url : null,
    vimeo_id: vimeo ? vimeo.vimeo_id : null,
    vimeo_hash: vimeo ? vimeo.vimeo_hash : null,
    start_sec: vimeo ? parseStart(b.start_sec ?? b.start) ?? 0 : null,
    duur: vimeo && Number.isFinite(+meta.duur) ? Math.round(+meta.duur) : null,
    vimeo_titel: vimeo ? tekst(meta.titel, 300) || null : null,
    vimeo_thumbnail: vimeo && /^https:\/\//.test(String(meta.thumbnail || '')) ? String(meta.thumbnail).slice(0, 500) : null,
    wat_gebeurde: tekst(b.wat_gebeurde, 8000),
    trade_info: {
      paar: tekst(trade.paar, 20).toUpperCase(),
      richting: ['long', 'short'].includes(trade.richting) ? trade.richting : '',
      uitleg: tekst(trade.uitleg, 2000),
      resultaat_r: Number.isFinite(r) ? Math.round(r * 100) / 100 : null,
    },
    notities: tekst(b.notities, 4000),
    gekozen_asset_ids: [...new Set(ids)].slice(0, 30),
    kanalen: kanalen.length ? kanalen : KANALEN.slice(),
  };
}

/** Is er een trade van de week ingevuld? */
export function heeftTrade(input) {
  const t = (input && input.trade_info) || {};
  return !!(t.paar || t.uitleg || t.resultaat_r != null);
}

/** Soort van de drop: met video = training, anders update. */
export function soortVanInput(input) {
  return input && input.vimeo_id ? 'training' : 'update';
}

// ── Beelden ─────────────────────────────────────────────────────────────────

const TYPES = {
  'image/png': { ext: 'png', klopt: (b) => b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/jpeg': { ext: 'jpg', klopt: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', klopt: (b) => b.length > 10 && b.slice(0, 6).toString('ascii').startsWith('GIF8') },
  'image/webp': { ext: 'webp', klopt: (b) => b.length > 30 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP' },
};

/** content_type → { type, ext } of null. */
export function beeldType(contentType) {
  const type = String(contentType || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  return TYPES[type] ? { type, ext: TYPES[type].ext } : null;
}

/** Type aan de eerste bytes. → 'image/png' | … | null */
export function typeUitBytes(buf) {
  for (const [type, t] of Object.entries(TYPES)) if (t.klopt(buf)) return type;
  return null;
}

/** Breedte/hoogte uit de bytes (PNG, JPEG, GIF, WebP). → { breedte, hoogte } of null. */
export function beeldMaat(buf) {
  const type = typeUitBytes(buf);
  try {
    if (type === 'image/png') return { breedte: buf.readUInt32BE(16), hoogte: buf.readUInt32BE(20) };
    if (type === 'image/gif') return { breedte: buf.readUInt16LE(6), hoogte: buf.readUInt16LE(8) };
    if (type === 'image/webp') {
      const chunk = buf.slice(12, 16).toString('ascii');
      if (chunk === 'VP8X') return { breedte: 1 + buf.readUIntLE(24, 3), hoogte: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8L') {
        const b = buf.readUInt32LE(21);
        return { breedte: 1 + (b & 0x3fff), hoogte: 1 + ((b >> 14) & 0x3fff) };
      }
      if (chunk === 'VP8 ') return { breedte: buf.readUInt16LE(26) & 0x3fff, hoogte: buf.readUInt16LE(28) & 0x3fff };
      return null;
    }
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { breedte: buf.readUInt16BE(i + 7), hoogte: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch { /* afgekapt bestand */ }
  return null;
}

/** Storage-pad voor een nieuw beeld. */
export function assetPad({ slug, ext, uuid, nu = new Date() }) {
  if (slug && SLUG_RE.test(slug)) return `drops/${slug}/uploads/${uuid}.${ext}`;
  return `bibliotheek/${nu.getUTCFullYear()}/${String(nu.getUTCMonth() + 1).padStart(2, '0')}/${uuid}.${ext}`;
}

/** Mag dit pad via de module geregistreerd worden? (geen ../, enkel onze mappen) */
export function isEigenPad(pad) {
  return /^(drops\/[0-9a-z-]{8,21}\/uploads|bibliotheek\/\d{4}\/\d{2})\/[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(String(pad || ''));
}

/** Namen van de social-beelden (fase 3): story-1..5, post-1..7, vierkant, linkedin, og. */
export const SOCIAL_NAAM_RE = /^(story-[1-5]|post-[1-7]|vierkant|linkedin|og)$/;
export function socialPad(slug, naam) {
  if (!SLUG_RE.test(String(slug || '')) || !SOCIAL_NAAM_RE.test(String(naam || ''))) return null;
  return `drops/${slug}/social/${naam}.png`;
}

/** Asset-velden die de module mag bijwerken. PURE. */
export function normaliseerAssetPatch(b = {}) {
  const uit = {};
  if ('soort' in b && ASSET_SOORTEN.includes(b.soort)) uit.soort = b.soort;
  if ('bijschrift' in b) uit.bijschrift = tekst(b.bijschrift, 500) || null;
  if ('persoon_naam' in b) uit.persoon_naam = tekst(b.persoon_naam, 120) || null;
  if ('toestemming_publiek' in b) uit.toestemming_publiek = b.toestemming_publiek === true;
  if ('tags' in b) {
    const lijst = Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(',');
    uit.tags = [...new Set(lijst.map((t) => tekst(t, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
  }
  return uit;
}

// ── Seed-bibliotheek (masterclass-decks) ────────────────────────────────────

const FIRMA = { ftmo: 'FTMO', alpha: 'Alpha Capital', fundednext: 'FundedNext', tradersglobal: 'Traders Global' };
const hoofd = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Metadata voor een seed-bestand uit de bestandsnaam. PURE.
 *   'leslie-ftmo-6721.png' → payout, Leslie, toestemming, bijschrift 'Payout Leslie — FTMO · 6.721'
 *   'team-lachend.jpg'     → team
 *   'zaal-certificaten.jpg'→ masterclass
 *   'chart-uitleg.jpg'     → chart
 */
export function seedMetadata(bestandsnaam) {
  const naam = String(bestandsnaam || '').toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const delen = naam.split('-');
  const eerste = delen[0];
  if (TOESTEMMING_NAMEN.includes(eerste)) {
    const persoon = hoofd(eerste);
    const rest = delen.slice(1);
    const firmas = rest.map((d) => FIRMA[d]).filter(Boolean);
    const jaar = rest.find((d) => /^20\d{2}$/.test(d)) || null;
    const bedrag = rest.find((d) => /^\d{3,}$/.test(d) && d !== jaar) || null;
    const woorden = rest.filter((d) => !FIRMA[d] && !/^\d+$/.test(d) && d !== 'discord');
    const delen2 = [
      firmas.length ? firmas.join(' · ') : null,
      bedrag ? new Intl.NumberFormat('nl-NL').format(+bedrag) : null,
      woorden.length ? woorden.join(' ') : null,
      jaar,
      rest.includes('discord') ? 'gedeeld in Discord' : null,
    ].filter(Boolean);
    return {
      soort: 'payout',
      persoon_naam: persoon,
      toestemming_publiek: true,
      bijschrift: `Payout ${persoon}${delen2.length ? ' — ' + delen2.join(' · ') : ''}`,
      tags: ['seed', 'payout', eerste, ...rest.filter((d) => FIRMA[d])],
    };
  }
  if (eerste === 'chart') return { soort: 'chart', persoon_naam: null, toestemming_publiek: false, bijschrift: 'Chart-uitleg uit de masterclass', tags: ['seed', 'chart'] };
  if (eerste === 'zaal') return { soort: 'masterclass', persoon_naam: null, toestemming_publiek: false, bijschrift: 'De zaal met certificaten na de masterclass', tags: ['seed', 'masterclass', 'certificaten'] };
  if (eerste === 'team' || eerste === 'mentor') {
    const WAT = { 'mentor-student': 'een mentor met een student', 'team-een-op-een': 'één-op-één begeleiding', 'team-groepssessie': 'groepssessie', 'team-lachend': 'het team' };
    const wat = WAT[naam] || naam.replace(/^team-/, '').replace(/-/g, ' ');
    return { soort: 'team', persoon_naam: null, toestemming_publiek: false, bijschrift: 'Team — ' + wat, tags: ['seed', 'team'] };
  }
  return { soort: 'overig', persoon_naam: null, toestemming_publiek: false, bijschrift: null, tags: ['seed'] };
}

/** Is een beeld bruikbaar in publieke content? Studentnamen enkel met toestemming. */
export function magPubliek(asset) {
  if (!asset) return false;
  if (!asset.persoon_naam) return true;
  return asset.toestemming_publiek === true;
}
