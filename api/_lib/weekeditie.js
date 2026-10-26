// api/_lib/weekeditie.js
//
// De Weekeditie (Contentmachine 2.0) aan CRM-kant: de blokken van de pagina, hun
// schema's en de editieregels. Bron = api/_lib/weekeditie-blokken.json, de export
// van dfo-website (lib/weekeditie-blokken.ts — zod). Zelfde bestand ook in
// docs/contentmachine/ (tests houden ze gelijk). De website valideert op dezelfde
// schema's en laat ongeldige blokken weg; hier worden ze VOOR het bewaren gevangen.
//
// Alles PUUR (getest in tests/contentmachine-weekeditie.test.js).

import BLOKKEN from './weekeditie-blokken.json' with { type: 'json' };
import { valideer, zonderMeta } from './json-schema-mini.js';

export { BLOKKEN };
export const THEMAS = BLOKKEN.themas;
export const HERO_VARIANTEN = BLOKKEN.hero_varianten;
export const BLOK_TYPES = BLOKKEN.blokken.map((b) => b.type);
export const INTERACTIEF = BLOKKEN.interactief;
export const NUGGETS = BLOKKEN.nuggets;
export const BLOK_INFO = Object.fromEntries(BLOKKEN.blokken.map((b) => [b.type, b]));

/** Het JSON Schema van één blok (zonder $schema). */
export function blokSchema(type) {
  const b = BLOK_INFO[type];
  return b ? zonderMeta(b.schema) : null;
}

/** Schema voor de blokken-array: enkel de toegelaten types (anyOf). */
export function blokkenArraySchema(types = BLOK_TYPES, min = 6, max = 14) {
  return { type: 'array', minItems: min, maxItems: max, items: { anyOf: [...new Set(types)].map(blokSchema).filter(Boolean) } };
}

/** Variant ↔ verplichte props + indexen (zelfde als blokLogica op de website). */
export function blokLogica(b) {
  const f = [];
  const p = (b && b.props) || {};
  if (b.type === 'hero') {
    if (b.variant === 'foto' && !p.foto_asset_id) f.push('hero foto: foto_asset_id ontbreekt');
    if (b.variant === 'groot-getal' && !p.getal) f.push('hero groot-getal: getal ontbreekt');
    if (b.variant === 'chart' && !p.chart_richting) f.push('hero chart: chart_richting ontbreekt');
  }
  if (b.type === 'quiz' && Array.isArray(p.opties) && p.antwoord_index >= p.opties.length) f.push('quiz: antwoord_index buiten de opties');
  if (b.type === 'data' && b.variant === 'een' && Array.isArray(p.cijfers) && p.cijfers.length !== 1) f.push('data een: precies 1 cijfer');
  if (b.type === 'data' && b.variant === 'drie' && Array.isArray(p.cijfers) && p.cijfers.length < 2) f.push('data drie: 2 of 3 cijfers');
  return f;
}

/** Eén blok: schema + logica. → [string] */
export function blokFouten(b, i = 0) {
  if (!b || typeof b !== 'object' || !BLOK_INFO[b.type]) return [`blokken[${i}]: onbekend bloktype ${b && b.type}`];
  return [
    ...valideer(blokSchema(b.type), b).map((x) => `blokken[${i}] (${b.type}) ${x.pad}: ${x.fout}`),
    ...blokLogica(b).map((x) => `blokken[${i}]: ${x}`),
  ];
}

/**
 * De structuurregels op enkel type + variant (ook bruikbaar voor de keuze van de
 * regisseur, nog zonder props). Gelijk aan controleerEditie op de website. → [string]
 */
export function structuurFouten(bl, { metVideo }) {
  const f = [];
  bl = Array.isArray(bl) ? bl : [];
  const telt = (t) => bl.filter((b) => b && b.type === t).length;
  const heroVideo = bl.some((b) => b && b.type === 'hero' && b.variant === 'video-poort');
  for (const b of bl) if (!b || !BLOK_INFO[b.type]) f.push(`onbekend bloktype ${b && b.type}`);
  if (bl.length < 6 || bl.length > 14) f.push(`tussen 6 en 14 blokken (nu ${bl.length})`);
  if (telt('hero') !== 1 || !bl[0] || bl[0].type !== 'hero') f.push('precies 1 hero, als eerste blok');
  const inter = bl.filter((b) => b && INTERACTIEF.includes(b.type)).length;
  if (inter < 2) f.push(`minstens 2 interactieve blokken (nu ${inter})`);
  if (!bl.some((b) => b && NUGGETS.includes(b.type))) f.push(`minstens 1 nugget (${NUGGETS.join(', ')})`);
  if (telt('cadeau') !== 1) f.push('precies 1 cadeau-blok');
  const poorten = telt('video-poort') + (heroVideo ? 1 : 0);
  if (metVideo) {
    if (poorten !== 1) f.push('met video: precies 1 poort (hero video-poort of video-poort-blok)');
    if (telt('inschrijven')) f.push('met video: geen inschrijven-blok');
  } else {
    if (poorten) f.push('zonder video: geen video-poort');
    if (telt('inschrijven') !== 1) f.push('zonder video: precies 1 inschrijven-blok');
  }
  for (const t of BLOK_TYPES) {
    const max = ['data', 'citaat', 'verhaal'].includes(t) ? 2 : 1;
    if (telt(t) > max) f.push(`${t} hoogstens ${max} keer`);
  }
  return f;
}

/** De editieregels op een volledige pagina (schema per blok + structuur). → [string] */
export function editieFouten(pagina, { metVideo }) {
  if (!pagina || typeof pagina !== 'object') return ['pagina ontbreekt'];
  const f = [];
  if (!THEMAS.includes(pagina.thema)) f.push(`pagina.thema: een van ${THEMAS.join(', ')}`);
  const bl = Array.isArray(pagina.blokken) ? pagina.blokken : [];
  bl.forEach((b, i) => { if (b && BLOK_INFO[b.type]) f.push(...blokFouten(b, i)); });
  return [...f, ...structuurFouten(bl, { metVideo })];
}

export const isWeekeditie = (pagina) => !!pagina && Array.isArray(pagina.blokken) && pagina.blokken.length > 0;

/** De "combinatie" van een editie: thema + hero-variant + interactieve blokken. */
export function combinatie(pagina) {
  if (!isWeekeditie(pagina)) return null;
  const hero = pagina.blokken.find((b) => b && b.type === 'hero');
  const inter = pagina.blokken.filter((b) => b && INTERACTIEF.includes(b.type)).map((b) => b.type).sort();
  return { thema: pagina.thema, hero: hero ? hero.variant : null, interactief: inter, sleutel: `${pagina.thema}|${hero ? hero.variant : '-'}|${inter.join('+')}` };
}

/** Is deze combinatie nieuw t.o.v. de vorige 3 edities (nieuwste eerst)? */
export function combinatieVrij(pagina, vorige = []) {
  const c = combinatie(pagina);
  if (!c) return { ok: false, botsing: null };
  for (const d of vorige.slice(0, 3)) {
    const o = combinatie(d && d.output && d.output.pagina);
    if (o && o.sleutel === c.sleutel) return { ok: false, botsing: d.slug };
  }
  return { ok: true, botsing: null };
}

/** Hoe vaak en wanneer elk blok gebruikt werd in de vorige edities (voor de regisseur). */
export function blokGebruik(vorige = []) {
  const uit = Object.fromEntries(BLOK_TYPES.map((t) => [t, { aantal: 0, laatst: null }]));
  for (const d of vorige) {
    const p = d && d.output && d.output.pagina;
    if (!isWeekeditie(p)) continue;
    for (const b of p.blokken) {
      if (!b || !uit[b.type]) continue;
      uit[b.type].aantal++;
      if (!uit[b.type].laatst) uit[b.type].laatst = d.slug;
    }
  }
  return uit;
}

/** Korte samenvatting van een vorige editie (voor de prompts). */
export function editieSamenvatting(d) {
  const p = d && d.output && d.output.pagina;
  const c = combinatie(p);
  const hero = c && p.blokken.find((b) => b.type === 'hero');
  return {
    slug: d.slug, format: d.format_key || (d.output && d.output.format_key) || null,
    thema: c ? c.thema : null, hero: c ? c.hero : null,
    blokken: c ? p.blokken.map((b) => b.type) : [],
    hook: hero ? String(hero.props.titel || '').replace(/\*\*/g, '') : ((p && p.hero_titel) || null),
    onderwerpen: (d.output && d.output.nieuwsbrief && d.output.nieuwsbrief.onderwerpen) || [],
  };
}

/** Alle asset-id's in de blokken. */
export function blokAssetIds(pagina) {
  const ids = new Set();
  for (const b of (pagina && pagina.blokken) || []) {
    const p = (b && b.props) || {};
    if (p.foto_asset_id) ids.add(p.foto_asset_id);
    if (p.beeld_asset_id) ids.add(p.beeld_asset_id);
    for (const x of p.payouts || []) if (x && x.asset_id) ids.add(x.asset_id);
    for (const x of p.fotos || []) if (x && x.asset_id) ids.add(x.asset_id);
  }
  return [...ids];
}

/**
 * Beelden die niet mogen: onbekend id, of een payout zonder toestemming in de payout-muur.
 * `assets` = rijen uit content_assets. → [string]
 */
export function beeldFouten(pagina, assets = []) {
  const per = Object.fromEntries(assets.map((a) => [a.id, a]));
  const f = [];
  (pagina && pagina.blokken || []).forEach((b, i) => {
    const p = (b && b.props) || {};
    const ids = [p.foto_asset_id, p.beeld_asset_id, ...(p.payouts || []).map((x) => x && x.asset_id), ...(p.fotos || []).map((x) => x && x.asset_id)].filter(Boolean);
    for (const id of ids) if (!per[id]) f.push(`blokken[${i}] (${b.type}): onbekend beeld ${id}`);
    if (b.type === 'payout-muur') for (const x of p.payouts || []) {
      const a = x && per[x.asset_id];
      if (a && (!a.toestemming_publiek || a.soort !== 'payout')) f.push(`blokken[${i}] payout-muur: ${x.asset_id} is geen payout met toestemming`);
    }
  });
  return f;
}

/** Titel van de editie zonder markering (lijst, OG, paginacontrole). */
export function editieTitel(pagina) {
  const hero = isWeekeditie(pagina) && pagina.blokken.find((b) => b.type === 'hero');
  return hero ? String(hero.props.titel || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim() : '';
}
