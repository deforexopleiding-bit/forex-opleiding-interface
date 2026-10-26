// api/_lib/contentmachine-social.js
//
// Contentmachine 2.0 — social op het niveau van de Instagram-reeks (bouwopdracht §4).
// PUUR: schema's voor de schrijver, controle, de variatieregel en de captions per kanaal.
// Het tekenen gebeurt in de browser (modules/klanten-v2/views/contentmachine-social2-v2.js).
//
// Elke slide/story/vierkant/LinkedIn-beeld heeft een VARIANT (zoals de 46 IG-posts):
//   foto    — masterclass-/teamfoto full-bleed met donker verloop onderaan
//   donker  — navy effen, grote kop met goud accent
//   licht   — licht effen, navy kop met gouden marker
//   data    — één enorm getal (uit de feitenbank)
//   kaart   — een frame van een blok van de pagina als UI-kaart met schaduw
// Kanalen en links: stories → linksticker ?src=ig-story · post → "link in bio" (?src=ig-bio) ·
// LinkedIn → link in de tekst (?src=linkedin). De links zet de CODE, nooit het model.

export const VARIANTEN = ['foto', 'donker', 'licht', 'data', 'kaart'];
export const FOTO_SOORTEN = ['masterclass', 'team', 'community'];
export const STORY_ROLLEN_V2 = ['hook', 'nugget', 'bewijs', 'cta'];
export const SRC = { story: 'ig-story', post: 'ig-bio', linkedin: 'linkedin', vierkant: 'ig-bio' };
export const TRAINING_ORIGIN = 'https://training.deforexopleiding.nl';

const S = { type: 'string' };
export const BEELD_V2_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'string', enum: VARIANTEN },
    eyebrow: { type: 'string', description: 'Klein label in hoofdletters (max 4-5 woorden), bv. "DATA, GEEN SCREENSHOTS".' },
    titel: { type: 'string', description: 'Grote kop, kort en sterk (max ±9 woorden); 1-3 sleutelwoorden tussen **…** worden goud.' },
    tekst: { type: 'string', description: 'Subtekst, 1-2 korte zinnen (max ±25 woorden). Mag leeg bij data.' },
    beeld_asset_id: { type: ['string', 'null'], description: 'Enkel bij variant foto: een masterclass- of teamfoto uit de beelden.' },
    getal: {
      type: ['object', 'null'],
      properties: { waarde: { type: 'number' }, prefix: S, suffix: S, decimalen: { type: 'integer' }, label: S },
      required: ['waarde', 'label'],
      description: 'Enkel bij variant data: één echt cijfer uit de feitenbank of de invoer.',
    },
    blok_index: { type: ['integer', 'null'], description: 'Enkel bij variant kaart: index in pagina.blokken van het blok dat als UI-kaart getoond wordt.' },
  },
  required: ['variant', 'titel'],
};

export const STORIES_V2_SCHEMA = {
  type: 'array', minItems: 3, maxItems: 5,
  description: 'Instagram-stories 1080×1920: hook → nugget → bewijs/visual → cta ("de volledige weekeditie", linksticker).',
  items: { type: 'object', properties: { rol: { type: 'string', enum: STORY_ROLLEN_V2 }, ...BEELD_V2_SCHEMA.properties, sticker_tekst: { type: 'string', description: 'Enkel bij cta: tekst op de linksticker (max 4 woorden), bv. "Lees de weekeditie".' } }, required: ['rol', 'variant', 'titel'] },
};
export const POST_V2_SCHEMA = {
  type: 'object',
  properties: {
    slides: { type: 'array', minItems: 5, maxItems: 8, items: BEELD_V2_SCHEMA, description: 'Carrousel 1080×1350: slide 1 = hook, laatste = naar de weekeditie. Wissel varianten af zoals de IG-reeks.' },
    caption: { type: 'string', description: 'Instagram-caption: eerste regel = hook, korte alinea\'s, eindigt met een uitnodiging naar de weekeditie. GEEN link (die zet het systeem: link in bio).' },
    hashtags: { type: 'array', maxItems: 5, items: S, description: 'Max 5, relevant (geen spam).' },
  },
  required: ['slides', 'caption', 'hashtags'],
};
export const LINKEDIN_V2_SCHEMA = {
  type: 'object',
  properties: {
    tekst: { type: 'string', description: 'LinkedIn-post, professioneler en langer: hook (1-2 regels), 3-5 korte alinea\'s, één inzicht, eindigt met een uitnodiging om de weekeditie te lezen. GEEN link en GEEN hashtags in de tekst (die zet het systeem).' },
    hashtags: { type: 'array', maxItems: 3, items: S },
    beeld: BEELD_V2_SCHEMA,
  },
  required: ['tekst', 'hashtags', 'beeld'],
};

/** Link naar de pagina per kanaal (UTM + src). */
export function kanaalLink(slug, kanaal) {
  const src = SRC[kanaal] || kanaal;
  const q = new URLSearchParams({ src, utm_source: kanaal === 'linkedin' ? 'linkedin' : 'instagram', utm_medium: 'social', utm_campaign: `drop-${slug}` });
  return `${TRAINING_ORIGIN}/${slug}?${q.toString()}`;
}
/** Korte URL zoals ze op het beeld staat (zonder parameters). */
export const korteUrl = (slug) => `training.deforexopleiding.nl/${slug}`;

const tags = (l) => (Array.isArray(l) ? l : []).map((h) => String(h).trim()).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h.replace(/\s+/g, '')));

/** De captions per kanaal, klaar om te kopiëren (met de juiste link). */
export function captions(output, slug) {
  const p = (output && output.post) || {};
  const l = (output && output.linkedin) || {};
  const st = Array.isArray(output && output.stories) ? output.stories : [];
  const cta = st.find((s) => s && s.rol === 'cta');
  return {
    instagram_post: [String(p.caption || '').trim(), '', '👉 De volledige weekeditie: link in bio', '', tags(p.hashtags).join(' ')].join('\n').trim(),
    instagram_bio_link: kanaalLink(slug, 'post'),
    instagram_story_link: kanaalLink(slug, 'story'),
    instagram_story_sticker: (cta && cta.sticker_tekst) || 'Lees de weekeditie',
    linkedin: [String(l.tekst || '').trim(), '', `👉 ${kanaalLink(slug, 'linkedin')}`, '', tags(l.hashtags).slice(0, 3).join(' ')].join('\n').trim(),
  };
}

/** Alle beeld-specs van de social (met kanaal en index). */
export function socialBeelden(o) {
  const uit = [];
  (Array.isArray(o && o.stories) ? o.stories : []).forEach((s, i) => uit.push({ kanaal: 'story', i, b: s }));
  (o && o.post && Array.isArray(o.post.slides) ? o.post.slides : []).forEach((s, i) => uit.push({ kanaal: 'post', i, b: s }));
  if (o && o.vierkant) uit.push({ kanaal: 'vierkant', i: 0, b: o.vierkant });
  if (o && o.linkedin && o.linkedin.beeld) uit.push({ kanaal: 'linkedin', i: 0, b: o.linkedin.beeld });
  return uit;
}

/** Is dit social van Contentmachine 2.0 (met varianten)? */
export function isSocialV2(o) {
  return !!(o && o.post && Array.isArray(o.post.slides) && o.post.slides.length && o.post.slides.every((s) => s && VARIANTEN.includes(s.variant)));
}

/** De variant-combinatie van een editie (wat elke week anders moet zijn). */
export function socialCombinatie(o) {
  if (!isSocialV2(o)) return null;
  const st = (o.stories || [])[0];
  return [o.post.slides[0].variant, o.vierkant && o.vierkant.variant, st && st.variant, o.linkedin && o.linkedin.beeld && o.linkedin.beeld.variant].join('|');
}

/**
 * Controle van de social 2.0. assets = beelden die mochten (rijen), pagina voor blok_index.
 * onderdelen = enkel die (stories / post (+ vierkant) / linkedin). → [string]
 */
export function socialFouten(o, { pagina = null, assets = null, onderdelen = null } = {}) {
  const f = [];
  const check = (k) => !onderdelen || onderdelen.includes(k);
  // assets null = onbekend (bv. bij bewaren): dan enkel nagaan dat er een beeld gekozen is.
  const per = assets ? Object.fromEntries(assets.map((a) => [a.id, a])) : null;
  const bl = (pagina && pagina.blokken) || [];
  const tekst = (x) => typeof x === 'string' && x.trim().length > 0;
  const beeld = (b, pad) => {
    if (!b || typeof b !== 'object') { f.push(`${pad}: ontbreekt`); return; }
    if (!VARIANTEN.includes(b.variant)) f.push(`${pad}.variant: een van ${VARIANTEN.join(', ')}`);
    if (!tekst(b.titel)) f.push(`${pad}.titel ontbreekt`);
    else if (b.titel.replace(/\*\*/g, '').split(/\s+/).length > 14) f.push(`${pad}.titel te lang (max ±12 woorden)`);
    if (b.variant === 'foto') {
      const a = b.beeld_asset_id && (per ? per[b.beeld_asset_id] : { soort: 'masterclass' });
      if (!a) f.push(`${pad}: variant foto heeft een beeld uit de lijst nodig`);
      else if (!FOTO_SOORTEN.includes(a.soort)) f.push(`${pad}: variant foto = een masterclass-/teamfoto (geen ${a.soort})`);
    } else if (per && b.beeld_asset_id && !per[b.beeld_asset_id]) f.push(`${pad}: onbekend beeld ${b.beeld_asset_id}`);
    if (b.variant === 'data' && !(b.getal && typeof b.getal.waarde === 'number' && tekst(b.getal.label))) f.push(`${pad}: variant data heeft een getal (waarde + label) nodig`);
    if (b.variant === 'kaart' && (!Number.isInteger(b.blok_index) || !bl[b.blok_index] || bl[b.blok_index].type === 'cadeau')) f.push(`${pad}: variant kaart wijst een blok van de pagina aan (blok_index)`);
    for (const k of ['titel', 'tekst', 'eyebrow']) if (tekst(b[k]) && /https?:\/\/|www\./i.test(b[k])) f.push(`${pad}.${k}: geen links in het beeld`);
  };
  if (check('stories')) {
    const s = Array.isArray(o && o.stories) ? o.stories : [];
    if (s.length < 3 || s.length > 5) f.push('stories: 3 tot 5');
    s.forEach((x, i) => { beeld(x, `stories[${i}]`); if (x && !STORY_ROLLEN_V2.includes(x.rol)) f.push(`stories[${i}].rol onbekend`); });
    if (s.length && s[0].rol !== 'hook') f.push('stories: de eerste is de hook');
    if (s.length && s[s.length - 1].rol !== 'cta') f.push('stories: de laatste is de cta (linksticker naar de weekeditie)');
  }
  if (check('post')) {
    const p = (o && o.post) || {};
    const sl = Array.isArray(p.slides) ? p.slides : [];
    if (sl.length < 5 || sl.length > 8) f.push('post.slides: 5 tot 8');
    sl.forEach((x, i) => beeld(x, `post.slides[${i}]`));
    if (sl.length >= 5 && new Set(sl.map((x) => x && x.variant)).size < 2) f.push('post.slides: wissel minstens 2 varianten af');
    if (!tekst(p.caption)) f.push('post.caption ontbreekt');
    else if (/https?:\/\//i.test(p.caption)) f.push('post.caption: geen link (het systeem zet "link in bio")');
    if (Array.isArray(p.hashtags) && p.hashtags.length > 5) f.push('post.hashtags: max 5');
    beeld(o && o.vierkant, 'vierkant');
  }
  if (check('linkedin')) {
    const l = (o && o.linkedin) || {};
    if (!tekst(l.tekst)) f.push('linkedin.tekst ontbreekt');
    else {
      if (/https?:\/\//i.test(l.tekst)) f.push('linkedin.tekst: geen link (het systeem zet de link met src=linkedin)');
      if ((l.tekst.match(/#\w/g) || []).length) f.push('linkedin.tekst: geen hashtags in de tekst (max 3 apart)');
      if (l.tekst.split(/\n\s*\n/).filter((x) => x.trim()).length < 3) f.push('linkedin.tekst: hook + 3-5 korte alinea\'s');
    }
    if (Array.isArray(l.hashtags) && l.hashtags.length > 3) f.push('linkedin.hashtags: max 3');
    beeld(l.beeld, 'linkedin.beeld');
  }
  return f;
}

/** Variatieregel: de combinatie mag niet gelijk zijn aan die van één van de vorige 3 drops. → string|null */
export function socialVariatieFout(o, vorige = []) {
  const c = socialCombinatie(o);
  if (!c) return null;
  for (const d of vorige.slice(0, 3)) {
    if (d && d.output && socialCombinatie(d.output) === c) return `social: dezelfde variant-combinatie (${c}) als ${d.slug} — kies andere varianten voor slide 1, vierkant, story 1 of LinkedIn`;
  }
  return null;
}

/** Social in de oude vorm (v1: stories zonder variant, LinkedIn-beeld 'vierkant'/'slide1')? */
export function isSocialV1(o) {
  const st = o && Array.isArray(o.stories) ? o.stories : [];
  const sl = o && o.post && Array.isArray(o.post.slides) ? o.post.slides : [];
  const l = o && o.linkedin;
  return (st.length > 0 && !st[0].variant) || (sl.length > 0 && !sl[0].variant) || (!!l && typeof l.beeld === 'string');
}

/** Cijfers op de social-beelden (variant data) — voor de cijfercontrole. */
export function socialGetallen(o) {
  return socialBeelden(o).filter((x) => x.b && x.b.getal && typeof x.b.getal.waarde === 'number').map((x) => ({ pad: `${x.kanaal}[${x.i}].getal`, waarde: x.b.getal.waarde }));
}
