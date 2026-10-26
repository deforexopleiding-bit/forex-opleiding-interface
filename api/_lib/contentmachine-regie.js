// api/_lib/contentmachine-regie.js
//
// Contentmachine 2.0 — de generator in twee stappen (bouwopdracht §7):
//   1. REGISSEUR: kiest format, thema, hero-variant, de blokken van de Weekeditie,
//      de beelden en de rode draad, met een korte motivatie (zichtbaar in het werkblad).
//   2. SCHRIJVER: vult alle teksten en props van de pagina (strikt volgens de
//      blokschema's van de website, api/_lib/weekeditie-blokken.json) en de andere
//      kanalen (nieuwsbrief, stories, post + vierkant, LinkedIn).
// Elke stap wordt gevalideerd; bij fouten één herstelronde.
//
// Context voor beide: strategiekennis, feitenbank, beelden (met AI-beschrijving),
// de blokkenlijst met hoe vaak/wanneer elk blok gebruikt werd, de laatste 6 edities.
// Regels die de code afdwingt (niet enkel de prompt): editieregels, combinatie
// thema+hero+interactieve blokken nooit gelijk aan één van de vorige 3, format-rotatie,
// beelden enkel uit de lijst (payouts enkel met toestemming), cijfers enkel uit de
// feitenbank/invoer/beelden, verboden woorden en namen.
//
// Pure delen zijn getest in tests/contentmachine-regie.test.js.

import { anthropicStructuredOutput } from './anthropic-client.js';
import { modelKeten } from './contentmachine-ai.js';
import { DFO_STRATEGIE_KENNIS } from './dfo-strategie-kennis.js';
import { FEITENBANK, controleerCijfers } from './feitenbank.js';
import {
  FORMATS, FORMAT_KEYS,
  valideerOutput, controleerGrenzen, grensOpties, nabewerk, teGelijk, systeemPrompt as v1Systeem,
} from './contentmachine-generator.js';
import { trainingDatum, datumVoluit } from './contentmachine-core.js';
import { isTeaser } from './nieuwsbrief-render.js';
import {
  STORIES_V2_SCHEMA, POST_V2_SCHEMA, BEELD_V2_SCHEMA, LINKEDIN_V2_SCHEMA, socialGetallen, socialCombinatie, socialVariatieFout, isSocialV1,
} from './contentmachine-social.js';
import {
  BLOKKEN, BLOK_INFO, BLOK_TYPES, THEMAS, HERO_VARIANTEN, INTERACTIEF, NUGGETS,
  blokSchema, structuurFouten, editieFouten, combinatie, combinatieVrij, blokGebruik, editieSamenvatting,
  beeldFouten, blokFouten, editieTitel,
} from './weekeditie.js';

export const OUTPUT_VERSIE = 2;
/** Na zoveel ms geen herstelronde meer (Vercel maxDuration 300 s): de problemen gaan als waarschuwing mee. */
export const HERSTEL_TOT_MS = 130000;
const nogTijd = (ctx) => !ctx.start || Date.now() - ctx.start < HERSTEL_TOT_MS;
const S = { type: 'string' };

// ── Regisseur ───────────────────────────────────────────────────────────────
/** Hero-varianten die mogen: video-poort enkel met video. */
export function heroVarianten(metVideo) {
  return HERO_VARIANTEN.filter((v) => metVideo || v !== 'video-poort');
}

export function regieSchema({ toegelaten = FORMAT_KEYS, metVideo }) {
  return {
    type: 'object',
    properties: {
      format_key: { type: 'string', enum: toegelaten, description: 'Het format van de week (rotatie: enkel deze).' },
      kernidee: { type: 'string', description: 'De kern van deze week in één zin.' },
      rode_draad: { type: 'string', description: 'Hoe de editie de lezer meeneemt, van hero tot cadeau (2-3 zinnen).' },
      nugget: { type: 'string', description: 'De nugget van de week: één inzicht dat op zich al waarde heeft (komt ook in de nieuwsbrief).' },
      open_lus: { type: 'string', description: 'De vraag/spanning die de nieuwsbrief opent en pas op de pagina sluit.' },
      thema: { type: 'string', enum: THEMAS },
      hero_variant: { type: 'string', enum: heroVarianten(metVideo) },
      blokken: {
        type: 'array', minItems: 6, maxItems: 14,
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: BLOK_TYPES },
            variant: { type: ['string', 'null'], description: 'Enkel bij hero (= hero_variant) en data (een | drie).' },
            waarom: { type: 'string', description: 'Waarom dit blok, op deze plek, deze week (1 zin).' },
          },
          required: ['type', 'waarom'],
        },
        description: 'De volgorde van de pagina. Eerste = hero.',
      },
      beelden: {
        type: 'array', maxItems: 12,
        items: { type: 'object', properties: { asset_id: S, waar: { type: 'string', description: 'In welk blok/kanaal en waarom.' } }, required: ['asset_id', 'waar'] },
      },
      motivatie: { type: 'string', description: 'Waarom deze combinatie anders is dan de vorige edities en waarom ze werkt (2-4 zinnen).' },
    },
    required: ['format_key', 'kernidee', 'rode_draad', 'nugget', 'open_lus', 'thema', 'hero_variant', 'blokken', 'beelden', 'motivatie'],
  };
}

/** De keuze van de regisseur als (props-loze) pagina, voor de structuur- en combinatieregels. */
export function regieAlsPagina(regie) {
  const blokken = (regie && Array.isArray(regie.blokken) ? regie.blokken : []).map((b) => {
    const x = { type: b && b.type };
    if (x.type === 'hero') x.variant = regie.hero_variant;
    else if (x.type === 'data') x.variant = b.variant === 'een' ? 'een' : 'drie';
    return x;
  });
  return { thema: regie && regie.thema, blokken };
}

/** → [string] fouten in de regie. */
export function valideerRegie(regie, { metVideo, toegelaten = FORMAT_KEYS, assetIds = null, vorige = [] }) {
  const f = [];
  if (!regie || typeof regie !== 'object') return ['regie ontbreekt'];
  if (!toegelaten.includes(regie.format_key)) f.push(`format_key ${regie.format_key} is deze week niet toegelaten (${toegelaten.join(', ')})`);
  if (!THEMAS.includes(regie.thema)) f.push('thema onbekend');
  if (!heroVarianten(metVideo).includes(regie.hero_variant)) f.push(`hero_variant ${regie.hero_variant} mag niet${metVideo ? '' : ' (geen video deze week)'}`);
  const pagina = regieAlsPagina(regie);
  f.push(...structuurFouten(pagina.blokken, { metVideo }));
  const vrij = combinatieVrij(pagina, vorige);
  if (!vrij.ok && vrij.botsing) f.push(`combinatie thema + hero + interactieve blokken is dezelfde als ${vrij.botsing}: kies anders`);
  for (const b of regie.beelden || []) if (assetIds && !assetIds.includes(b.asset_id)) f.push(`beeld ${b.asset_id} bestaat niet`);
  for (const k of ['kernidee', 'rode_draad', 'nugget', 'open_lus', 'motivatie']) if (!String(regie[k] || '').trim()) f.push(`${k} ontbreekt`);
  return f;
}

// ── Schrijver ───────────────────────────────────────────────────────────────
/**
 * De nieuwsbrief als teaser naar de Weekeditie (bouwopdracht §3): kort, één nugget, één beeld
 * (een frame van een blok van de pagina, gerenderd in het CRM), een open lus en één hoofdknop
 * "Lees de volledige weekeditie" (vaste tekst in de renderer), PS met het cadeau.
 */
export const TEASER_SCHEMA = {
  type: 'object',
  description: 'De nieuwsbrief: kort (130-240 woorden samen), de brug naar de pagina. Geen link-teksten: de knop "Lees de volledige weekeditie" staat vast in de mail.',
  properties: {
    onderwerpen: { type: 'array', minItems: 3, maxItems: 3, items: S, description: 'Drie A/B-onderwerpregels (max 60 tekens elk), elk een andere invalshoek, sterk en concreet, geen clickbait.' },
    preheader: { type: 'string', description: 'Voorbeeldtekst (max 110 tekens), vult het onderwerp aan.' },
    opener: { type: 'string', description: 'Opener in Maxims stem: 2-4 korte zinnen, persoonlijk ("Hoi," mag), wat er deze week gebeurde. **vet** mag.' },
    nugget: {
      type: 'object',
      properties: { kicker: S, titel: { type: 'string', description: 'De nugget in één zin (max 12 woorden).' }, tekst: { type: 'string', description: '2-4 zinnen: de nugget heeft op zich al waarde. Uit de strategiekennis of feitenbank.' } },
      required: ['titel', 'tekst'],
    },
    beeld_blok_index: { type: 'integer', description: 'Index in pagina.blokken van het blok waarvan het beeld een frame is (bij voorkeur interactief: replay, fib, quiz, sliders, calculator, trechter).' },
    open_lus: {
      type: 'object',
      properties: { kicker: S, vraag: { type: 'string', description: 'De vraag die pas op de pagina beantwoord wordt (bv. "Sweep of break? Wat zou jij doen?").' }, tekst: { type: 'string', description: '1-2 zinnen: het antwoord (en meer) staat in de weekeditie.' } },
      required: ['vraag'],
    },
    ps: { type: 'string', description: 'PS met het cadeau: gratis strategiesessie met Dave, t.w.v. €100, nu €0 (1-2 zinnen).' },
  },
  required: ['onderwerpen', 'preheader', 'opener', 'nugget', 'beeld_blok_index', 'open_lus', 'ps'],
};

/** Schema van de schrijver: de pagina met precies de gekozen bloktypes + de andere kanalen. */
export function schrijverSchema(regie, { onderdelen = null } = {}) {
  const types = [...new Set(regieAlsPagina(regie).blokken.map((b) => b.type))].filter((t) => BLOK_INFO[t]);
  const pagina = {
    type: 'object',
    properties: {
      seo_titel: { type: 'string', description: 'Titel voor Google (max 65 tekens), eindigt op "| De Forex Opleiding".' },
      seo_beschrijving: { type: 'string', description: 'Meta-beschrijving (max 155 tekens).' },
      og_titel: { type: 'string', description: 'Titel bij delen (max 70 tekens).' },
      og_beschrijving: { type: 'string', description: 'Beschrijving bij delen (max 160 tekens).' },
      blokken: {
        type: 'array', minItems: regie.blokken.length, maxItems: regie.blokken.length,
        items: { anyOf: types.map(blokSchema) },
        description: 'EXACT de blokken van de regie, in dezelfde volgorde, met alle props volgens het schema van dat type.',
      },
    },
    required: ['seo_titel', 'seo_beschrijving', 'og_titel', 'og_beschrijving', 'blokken'],
  };
  // Social 2.0 (bouwopdracht §4): elk beeld heeft een variant zoals de Instagram-reeks.
  const alle = { pagina, nieuwsbrief: TEASER_SCHEMA, stories: STORIES_V2_SCHEMA, post: POST_V2_SCHEMA, vierkant: { ...BEELD_V2_SCHEMA, description: 'Vierkant beeld 1080×1080 (feed/delen).' }, linkedin: LINKEDIN_V2_SCHEMA };
  const keys = onderdelen ? [...new Set(onderdelen.flatMap((k) => (k === 'post' ? ['post', 'vierkant'] : [k])))] : Object.keys(alle);
  return { type: 'object', properties: Object.fromEntries(keys.map((k) => [k, alle[k]])), required: keys };
}

/** De blokken van de schrijver moeten de regie volgen (zelfde types, zelfde volgorde, hero/data-variant). */
export function volgtRegie(pagina, regie) {
  const f = [];
  const doel = regieAlsPagina(regie).blokken;
  const bl = (pagina && pagina.blokken) || [];
  if (bl.length !== doel.length) f.push(`pagina.blokken: ${doel.length} blokken verwacht (zoals de regie), kreeg ${bl.length}`);
  doel.forEach((d, i) => {
    const b = bl[i];
    if (!b) return;
    if (b.type !== d.type) f.push(`pagina.blokken[${i}]: ${d.type} verwacht, kreeg ${b.type}`);
    if (d.variant && b.variant !== d.variant) f.push(`pagina.blokken[${i}]: variant ${d.variant} verwacht`);
  });
  return f;
}

/** Bronnen voor de cijfercontrole: invoer van de week + bijschriften/AI-details van de beelden. */
export function cijferBronnen(input = {}, beelden = []) {
  const t = input.trade_info || {};
  return [
    input.wat_gebeurde, input.notities, input.nugget, t.uitleg, t.resultaat_r != null ? String(t.resultaat_r) : '',
    ...beelden.map((a) => [a.bijschrift, a.ai_beschrijving, a.ai_details ? JSON.stringify(a.ai_details) : ''].join(' ')),
  ].filter(Boolean).map(String);
}

/**
 * Volledige controle van een v2-output. → { fouten:[string], cijfers:[{pad,waarde}] }
 * `assets` = alle beelden die mochten (rijen); `vorige` voor de combinatieregel.
 */
export function valideerV2(o, { metVideo, assets = [], vorige = [], regie = null, input = {}, onderdelen = null }) {
  const fouten = [];
  const check = (k) => !onderdelen || onderdelen.includes(k);
  if (check('pagina')) {
    const p = o && o.pagina;
    fouten.push(...editieFouten(p, { metVideo }));
    fouten.push(...beeldFouten(p, assets));
    if (regie) fouten.push(...volgtRegie(p, regie));
    const vrij = combinatieVrij(p, vorige);
    if (!vrij.ok && vrij.botsing) fouten.push(`combinatie gelijk aan ${vrij.botsing}`);
  }
  if (check('nieuwsbrief') && o && o.nieuwsbrief && !isTeaser(o.nieuwsbrief)) fouten.push('nieuwsbrief: lever de teaser (opener, nugget, beeld_blok_index, open_lus, ps), geen blokken');
  // Nieuwsbrief + social (valideerOutput kiest zelf: social 2.0 met varianten, of de v1-vorm van oudere edities).
  const andere = ['nieuwsbrief', 'stories', 'post', 'linkedin'].filter(check);
  if (andere.length) fouten.push(...valideerOutput(o, { assets, onderdelen: andere }).fouten);
  const social = andere.filter((k) => k !== 'nieuwsbrief');
  if (!onderdelen) { const v = socialVariatieFout(o, vorige); if (v) fouten.push(v); }
  const ONDERDEEL = { story: 'stories', post: 'post', vierkant: 'post', linkedin: 'linkedin' };
  const extra = social.length && !isSocialV1(o) ? socialGetallen(o).filter((x) => social.includes(ONDERDEEL[x.pad.split('[')[0]])) : [];
  const cijfers = check('pagina') || extra.length ? controleerCijfers(check('pagina') ? o && o.pagina : null, cijferBronnen(input, assets), extra) : [];
  return { fouten, cijfers };
}

// ── Prompts ─────────────────────────────────────────────────────────────────
/** Compacte beschrijving van een blok voor de prompt: props met type en uitleg. */
export function blokBeschrijving(type) {
  const info = BLOK_INFO[type];
  const s = blokSchema(type);
  const props = (s && s.properties && s.properties.props && s.properties.props.properties) || {};
  const nodig = new Set((s && s.properties && s.properties.props && s.properties.props.required) || []);
  const kort = (x) => {
    if (!x) return '?';
    if (x.enum) return x.enum.join('|');
    if (x.type === 'array') return `[${x.items && x.items.type === 'object' ? '{' + Object.keys(x.items.properties || {}).join(', ') + '}' : (x.items && x.items.type) || ''}] ${x.minItems != null ? x.minItems : 0}-${x.maxItems != null ? x.maxItems : '…'}`;
    if (x.type === 'object') return '{' + Object.keys(x.properties || {}).join(', ') + '}';
    return x.type + (x.maxLength ? `≤${x.maxLength}` : '');
  };
  const varianten = s && s.properties && s.properties.variant && s.properties.variant.enum;
  return `- ${type} [${info.categorie}]${varianten ? ' varianten: ' + varianten.join(' | ') : ''} — ${info.uitleg}\n  props: ${Object.entries(props).map(([k, x]) => `${k}${nodig.has(k) ? '*' : ''}: ${kort(x)}${x.description ? ` (${x.description})` : ''}`).join('; ') || '—'}`;
}

function gemeenschappelijk() {
  return `DFO-STRATEGIEKENNIS (de enige bron voor uitleg en tips)
${DFO_STRATEGIE_KENNIS}

FEITENBANK (de enige bron voor cijfers, naast de invoer van de week en wat leesbaar op een beeld staat; niets verzinnen, nuance mee)
${FEITENBANK}`;
}

export function regiePrompt() {
  return `Je bent de REGISSEUR van "De Weekeditie" van De Forex Opleiding (DFO): elke week één editie op training.deforexopleiding.nl, plus nieuwsbrief, stories, carrousel en LinkedIn die ernaar verwijzen. De pagina is het belangrijkste stuk: interactief, bewegend, elke week op een nieuwe creatieve manier.

JOUW TAAK: kies het format, het thema, de hero-variant, de blokken (volgorde!), de beelden en de rode draad. Je schrijft nog GEEN teksten; motiveer kort.

REGELS (de code controleert ze, een fout = opnieuw)
${BLOKKEN.regels.map((r) => '- ' + r).join('\n')}
- Combinatie thema + hero-variant + interactieve blokken NOOIT gelijk aan een van de vorige 3 edities. Varieer ook bewust t.o.v. de laatste 6 (blokken die vaak gebruikt werden, minder).
- Format enkel uit de toegelaten formats van deze week.
- Kies interactieve blokken die PASSEN bij de input (een trade → trade-ontleed of replay; een fout → quiz of mythe-feit; payouts met toestemming → payout-muur; geen data-verhaal → geen data-blok).
- hero foto: enkel met een masterclass-/teamfoto uit de beelden. hero groot-getal: enkel met een echt cijfer uit de feitenbank. hero video-poort: enkel met video.
- Beelden: enkel id's uit de lijst; payouts enkel met toestemming.
- De nieuwsbrief is kort en is de brug naar de pagina: kies een open lus die pas op de pagina sluit.

THEMA'S: nacht (navy, goud), goud (warme gouden gloed, accenten gemarkeerd), licht (licht, witte kaarten, zoals de lichte IG-posts), data (donker raster, cijfers centraal).

BLOKKEN (* = verplichte prop)
${BLOK_TYPES.map(blokBeschrijving).join('\n')}

FORMATS
${FORMATS.map((f) => `- ${f.key} — ${f.naam}: ${f.uitleg} (past als ${f.past})`).join('\n')}

${gemeenschappelijk()}

Lever je keuze via de tool.`;
}

export function schrijverPrompt() {
  // De stem, grenzen en nieuwsbrief/social-regels van v1 blijven gelden; daarbovenop de Weekeditie.
  return `${v1Systeem()}

──────── WEEKEDITIE 2.0 ────────
Je bent nu de SCHRIJVER. De regisseur koos al het format, het thema, de hero, de blokken (volgorde), de beelden en de rode draad. Jij vult ALLE teksten en props:
- pagina.blokken: EXACT de blokken van de regie, in dezelfde volgorde, elk met type (+ variant bij hero/data) en props strikt volgens het schema van dat bloktype. Geen extra velden.
- **dubbele sterretjes** in een titel = goud accentwoord (1-3 woorden per kop); in lopende tekst = vet.
- Koppen kort en sterk zoals de Instagram-reeks: "Geen goeroe met een Lambo. **Een team aan een tafel.**", "Weten is niet **hetzelfde** als doen."
- Cijfers (data, groot getal, payout-bedragen, slider-voorinstellingen, referentie): ENKEL uit de feitenbank, de invoer of wat leesbaar op een beeld staat. Vermeld de bron kort in "bron".
- replay-sweep-bos / fib / quiz-chart: de chart is een oefenscenario uit The Lab; noem geen paar als label tenzij je zegt dat het een voorbeeld is. De uitleg volgt de strategiekennis (BOS = body close; wick-only = geen BOS; H4 71 = enkel locatie).
- funded-calculator en rr-sliders zijn rekenvoorbeelden: geen beloftes in de teksten.
- vooruitblik: scenario-taal ("als…, dan…"), geen zekerheden.
- cadeau: props {} (vaste tekst). video-poort/inschrijven: enkel eyebrow/titel/intro (het formulier is vast).
- NIEUWSBRIEF = TEASER naar de Weekeditie (de pagina ís de volledige nieuwsbrief online): kort (130-240 woorden samen), opener in Maxims stem, ÉÉN nugget die op zich al waarde heeft (= de nugget van de regie), beeld_blok_index = het interactieve blok waarvan het mailbeeld een frame is, een open lus (de vraag die pas op de pagina sluit), en een PS met het cadeau. Geen blokkenlijst, geen links in de tekst: de knop "Lees de volledige weekeditie" staat vast in de mail. Het format van de week kleurt de toon en de invalshoek (trade ontleed → één stap als nugget; wat zou jij doen → de vraag; het bewijs → het cijfer).
- SOCIAL = de stijl van de Instagram-reeks van DFO (46 posts). Elk beeld (story, carrousel-slide, vierkant, LinkedIn-beeld) heeft een VARIANT:
  · foto — een masterclass-/teamfoto full-bleed met donker verloop; kop onderaan. Enkel met een beeld van soort masterclass/team/community.
  · donker — navy effen, grote vette kop, 1-3 gouden accentwoorden (**…**).
  · licht — lichte achtergrond, navy kop, gouden marker op het accent.
  · data — één ENORM getal (getal.waarde + label, enkel een echt cijfer uit de feitenbank/invoer) + korte kop.
  · kaart — een frame van een blok van de pagina als UI-kaart (blok_index = het blok; bij voorkeur het interactieve blok of een data-blok).
  Elk beeld: eyebrow (klein label, hoofdletters, 2-5 woorden), titel (kort, max ±9 woorden, accentwoorden tussen **), tekst (1-2 korte zinnen). Geen links of @-handles in het beeld (die zet het systeem).
- FOTO VERPLICHT: elke storyset én elke carrousel bevat minstens één foto-variant met een MASTERCLASSFOTO uit de beelden (soort masterclass; anders team), full-bleed zoals de reeks ("Geen goeroe met een Lambo. Een team aan een tafel.").
- Stories (3-5, 1080×1920): hook → nugget → bewijs (data/kaart/foto) → cta (rol cta, sticker_tekst "Lees de weekeditie" of iets kort). Zelfde kernidee en nugget als de pagina.
- Carrousel (5-8 slides, 1080×1350): slide 1 = hook die doet swipen, dan het verhaal in stappen (één idee per slide), laatste = "de volledige weekeditie staat online" (link in bio). Wissel varianten af zoals de reeks (bv. foto → donker → kaart → licht → data → donker). Caption: hook in de eerste regel, korte alinea's, uitnodiging naar de weekeditie; GEEN link (systeem: "link in bio"); max 5 hashtags apart.
- Vierkant (1080×1080): één sterk beeld voor feed/delen.
- LinkedIn: professioneler en langer dan Instagram: hook (1-2 regels), 3-5 korte alinea's gescheiden door een lege regel, één inzicht, eindig met een uitnodiging om de weekeditie te lezen. GEEN link en GEEN hashtags in de tekst (max 3 hashtags apart; de link met src=linkedin zet het systeem). Plus één beeld (variant naar keuze, 1080×1350).
- De combinatie van varianten (slide 1 | vierkant | story 1 | LinkedIn-beeld) moet anders zijn dan bij elk van de vorige 3 edities (staat bij LAATSTE EDITIES).

${gemeenschappelijk()}`;
}

function beeldRegel(a) {
  const d = a.ai_details || {};
  const feiten = [d.firma, d.bedrag != null ? `${d.valuta || ''} ${d.bedrag}`.trim() : null, d.paar, d.timeframe, d.richting, d.datum_zichtbaar].filter(Boolean).join(', ');
  const naam = a.persoon_naam ? (a.toestemming_publiek ? `persoon: ${a.persoon_naam} (toestemming: ja)` : 'persoon: student ZONDER toestemming (naam NIET noemen, niet in payout-muur)') : 'geen persoon';
  return `Beeld ${a.id} — soort: ${a.soort}; ${naam}; ${a.breedte && a.hoogte ? `${a.breedte}×${a.hoogte}; ` : ''}bijschrift: ${a.bijschrift || '—'}${a.ai_beschrijving ? '; wat erop staat: ' + a.ai_beschrijving : ''}${feiten ? ' [' + feiten + ']' : ''}${a.bron === 'drop' ? ' (van deze week)' : ' (bibliotheek)'}`;
}

/** Wat elke stap over de week weet (tekst). */
export function weekContext({ drop, input, vorige = [], toegelaten, paginaUrl, beelden = [] }) {
  const i = input || {};
  const t = i.trade_info || {};
  const td = datumVoluit(trainingDatum(i));
  const metVideo = !!i.vimeo_id;
  const gebruik = blokGebruik(vorige);
  const regels = [
    `EDITIE ${drop.slug} (aangemaakt ${drop.datum}) — ${metVideo ? 'MET video (opname van de live training)' : 'ZONDER video (update-editie)'}`,
    metVideo ? (td ? `DATUM TRAINING: ${td.voluit} (kort ${td.kort}). Enkel deze weekdag/datum noemen.` : 'DATUM TRAINING onbekend: noem geen weekdag of datum.') : 'Geen training: noem geen weekdag.',
    `Pagina: ${paginaUrl}`,
    metVideo ? `VIDEO: "${i.vimeo_titel || 'live training'}"${i.duur ? `, ${Math.round(i.duur / 60)} min` : ''}${i.start_sec ? `, analyse vanaf ${Math.floor(i.start_sec / 60)}:${String(i.start_sec % 60).padStart(2, '0')}` : ''}.` : '',
    '', 'WAT ER DEZE WEEK GEBEURDE (Maxim):', i.wat_gebeurde || '(niets ingevuld — werk met de beelden, de feitenbank en de strategiekennis)',
  ];
  if (i.nugget) regels.push('', 'NUGGET VAN DE WEEK (Maxim):', i.nugget);
  if (t.paar || t.uitleg || t.resultaat_r != null || t.entry_r != null) {
    regels.push('', `TRADE VAN DE WEEK: ${t.paar || '?'} ${t.richting || ''}${t.resultaat_r != null ? `, resultaat ${String(t.resultaat_r).replace('.', ',')}R` : ''}${t.stop_r != null ? `, stop ${t.stop_r}R` : ''}${t.target_r != null ? `, target ${t.target_r}R` : ''}`, t.uitleg || '');
  }
  if (i.notities) regels.push('', 'NOTITIES:', i.notities);
  regels.push('', `TOEGELATEN FORMATS: ${toegelaten.join(', ')}`);
  regels.push('', 'LAATSTE EDITIES (nieuwste eerst; niet herhalen):', vorige.length ? vorige.map((d) => {
    const e = editieSamenvatting(d);
    const sc = socialCombinatie(d.output);
    return `- ${e.slug} · format ${e.format || '—'} · thema ${e.thema || 'v1'} · hero ${e.hero || 'v1'} · blokken ${e.blokken.join(', ') || 'v1-pagina'}${sc ? ` · social (slide1|vierkant|story1|linkedin) ${sc}` : ''}\n  hook: ${e.hook || '—'} · onderwerpen: ${e.onderwerpen.join(' | ') || '—'}`;
  }).join('\n') : 'Nog geen.');
  regels.push('', 'GEBRUIK PER BLOK (laatste 6 edities): ' + Object.entries(gebruik).map(([k, v]) => `${k} ${v.aantal}×${v.laatst ? ' (laatst ' + v.laatst + ')' : ''}`).join(' · '));
  regels.push('', beelden.length ? 'BEELDEN (enkel deze id\'s):' : 'Geen beelden.');
  for (const a of beelden) regels.push(beeldRegel(a));
  return regels.filter((x) => x !== '').join('\n');
}

/** Content-array met tekst + (optioneel) de beelden zelf (vision). */
export function bericht(tekst, beelden = [], { metBeelden = true, max = 8, slot = '' } = {}) {
  const content = [{ type: 'text', text: tekst }];
  if (metBeelden) for (const a of beelden.slice(0, max)) {
    if (!a.publieke_url) continue;
    content.push({ type: 'text', text: `Beeld ${a.id}:` });
    content.push({ type: 'image', source: { type: 'url', url: a.publieke_url } });
  }
  if (slot) content.push({ type: 'text', text: slot });
  return content;
}

// ── Aanroepen ───────────────────────────────────────────────────────────────
async function roep({ system, content, schema, tool, max_tokens = 16000, temperature = 0.8 }) {
  return modelKeten((model) => anthropicStructuredOutput({
    model, system, max_tokens, temperature, tool_name: tool, tool_input_schema: schema,
    messages: [{ role: 'user', content }],
  }));
}

const herstel = (fouten) => ['De vorige versie had deze problemen. Lever een VERBETERDE versie die ze allemaal oplost:', ...fouten.map((x) => '- ' + x)].join('\n');

/** Stap 1. → { regie, model, herstel, fouten } */
export async function regisseer(ctx) {
  const metVideo = !!(ctx.input && ctx.input.vimeo_id);
  const opties = { metVideo, toegelaten: ctx.toegelaten, assetIds: ctx.assets.map((a) => a.id), vorige: ctx.vorige };
  const schema = regieSchema({ toegelaten: ctx.toegelaten, metVideo });
  const tekst = weekContext({ ...ctx, beelden: ctx.beelden });
  const content = bericht(tekst, ctx.beelden, { slot: 'Maak nu de regie via de tool.' });
  let { resultaat: regie, model } = await roep({ system: regiePrompt(), content, schema, tool: 'lever_regie', max_tokens: 4000, temperature: 0.9 });
  let fouten = valideerRegie(regie, opties);
  let hersteld = false;
  if (fouten.length && nogTijd(ctx)) {
    hersteld = true;
    const r = await roep({ system: regiePrompt(), content: [...content, { type: 'text', text: 'VORIGE REGIE:\n' + JSON.stringify(regie) + '\n\n' + herstel(fouten) }], schema, tool: 'lever_regie', max_tokens: 4000, temperature: 0.5 });
    regie = r.resultaat; model = r.model;
    fouten = valideerRegie(regie, opties);
  }
  if (regie && regie.blokken) {
    // De hero-variant zit in het blok; data zonder variant = drie.
    regie.blokken = regie.blokken.map((b) => ({ type: b.type, variant: b.type === 'hero' ? regie.hero_variant : b.type === 'data' ? (b.variant === 'een' ? 'een' : 'drie') : null, waarom: b.waarom || '' }));
  }
  return { regie, model, herstel: hersteld, fouten };
}

/** De output afwerken: thema uit de regie, titel, vaste formulierteksten, versie. */
export function werkAf(o, regie, ctx) {
  const uit = nabewerk({ ...o }, ctx);
  if (uit.pagina) {
    uit.pagina = { ...uit.pagina, thema: regie.thema };
    uit.titel = editieTitel(uit.pagina);
  }
  return uit;
}

/**
 * Stap 2. → { output, model, herstel, fouten, cijfers, grenzen }
 * `onderdelen` (optioneel, bv. ['pagina']): enkel die opnieuw; `huidige` = de rest.
 */
export async function schrijf(ctx, regie, { onderdelen = null, huidige = null, instructie = '' } = {}) {
  const metVideo = !!(ctx.input && ctx.input.vimeo_id);
  const gekozen = new Set((regie.beelden || []).map((b) => b.asset_id));
  const beelden = ctx.beelden.filter((a) => gekozen.has(a.id));
  const tekst = weekContext({ ...ctx, beelden: ctx.beelden }) + '\n\nREGIE (volg die exact):\n' + JSON.stringify(regie, null, 1)
    + (onderdelen ? `\n\nSchrijf ENKEL: ${onderdelen.join(', ')}. ${instructie ? 'Instructie van Maxim: ' + instructie : 'Frisser en sterker dan de huidige versie.'}\nHuidige editie (samenhang):\n${JSON.stringify(huidige)}` : '');
  const schema = schrijverSchema(regie, { onderdelen });
  const content = bericht(tekst, beelden, { max: 6, slot: onderdelen ? 'Lever enkel die onderdelen via de tool.' : 'Schrijf nu de volledige editie via de tool.' });
  const opties = { metVideo, assets: ctx.assets, vorige: ctx.vorige, regie, input: ctx.input, onderdelen };
  const samen = (r) => (onderdelen ? { ...huidige, ...r } : r);
  const grens = grensOpties(ctx.input, ctx.verbodenNamen || []);
  let { resultaat, model } = await roep({ system: schrijverPrompt(), content, schema, tool: 'lever_editie', max_tokens: 20000, temperature: 0.8 });
  let output = werkAf(samen(resultaat), regie, ctx);
  let v = valideerV2(output, opties);
  let g = controleerGrenzen(output, grens);
  let hersteld = false;
  if ((v.fouten.length || v.cijfers.length || g.length) && nogTijd(ctx)) {
    hersteld = true;
    const problemen = [
      ...v.fouten,
      ...v.cijfers.map((c) => `${c.pad}: het cijfer ${c.waarde} staat niet in de feitenbank, de invoer of op een beeld — gebruik een echt cijfer of een ander blokinhoud`),
      ...g.map((x) => `${x.pad}: ${x.regel} ("${x.fragment}")`),
    ];
    const r = await roep({ system: schrijverPrompt(), content: [...content, { type: 'text', text: 'VORIGE VERSIE:\n' + JSON.stringify(resultaat) + '\n\n' + herstel(problemen) }], schema, tool: 'lever_editie', max_tokens: 20000, temperature: 0.4 });
    resultaat = r.resultaat; model = r.model;
    output = werkAf(samen(resultaat), regie, ctx);
    v = valideerV2(output, opties);
    g = controleerGrenzen(output, grens);
  }
  return { output, model, herstel: hersteld, fouten: v.fouten, cijfers: v.cijfers, grenzen: g };
}

/**
 * Volledige editie: regisseur → schrijver (+ uniciteit van hooks/onderwerpen).
 * → { output, model, herstel, waarschuwingen, duur_ms }
 */
export async function genereerEditie(ctx) {
  const start = Date.now();
  ctx = { ...ctx, start };
  const r = await regisseer(ctx);
  const s = await schrijf(ctx, r.regie);
  const output = {
    versie: OUTPUT_VERSIE,
    format_key: r.regie.format_key,
    kernidee: r.regie.kernidee,
    regie: { ...r.regie, model: r.model, herstel: r.herstel },
    ...s.output,
  };
  const waarschuwingen = [
    ...r.fouten.map((x) => ({ soort: 'regie', tekst: x })),
    ...s.fouten.map((x) => ({ soort: 'schema', tekst: x })),
    ...s.cijfers.map((c) => ({ soort: 'cijfer', tekst: `${c.pad}: ${c.waarde} staat niet in de feitenbank/invoer` })),
    ...s.grenzen.map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment })),
    ...teGelijk(output, ctx.vorige || []).map((x) => ({ soort: 'uniek', tekst: `${x.wat} "${x.nieuw}" lijkt op ${x.slug} (${Math.round(x.score * 100)}%)` })),
  ];
  return { output, model: s.model, herstel: r.herstel || s.herstel, waarschuwingen, duur_ms: Date.now() - start };
}

/**
 * Eén blok opnieuw schrijven of een nieuw blok toevoegen.
 *   { index, type?, instructie? } → index = positie in pagina.blokken (bij nieuw: invoegpositie)
 * → { blok, model, fouten }
 */
export async function schrijfBlok(ctx, { huidige, index, type, instructie = '' }) {
  const pagina = huidige.pagina || {};
  const bestaand = pagina.blokken && pagina.blokken[index];
  const doelType = type || (bestaand && bestaand.type);
  if (!BLOK_INFO[doelType]) throw Object.assign(new Error('Onbekend bloktype'), { code: 'BLOK_ONBEKEND' });
  const schema = { type: 'object', properties: { blok: blokSchema(doelType) }, required: ['blok'] };
  const tekst = weekContext({ ...ctx, beelden: ctx.beelden }) + '\n\n'
    + `HUIDIGE EDITIE (voor samenhang):\n${JSON.stringify({ kernidee: huidige.kernidee, regie: huidige.regie, pagina: { thema: pagina.thema, blokken: pagina.blokken } })}\n\n`
    + (bestaand && !type ? `Schrijf blok ${index} (${doelType}) OPNIEUW, frisser en sterker. Huidig: ${JSON.stringify(bestaand)}` : `Schrijf een NIEUW blok van type ${doelType} dat op positie ${index} past in de rode draad.`)
    + (instructie ? `\nInstructie van Maxim: ${instructie}` : '')
    + `\n\nBLOK ${blokBeschrijving(doelType)}`;
  const content = bericht(tekst, [], { metBeelden: false, slot: 'Lever het blok via de tool.' });
  let { resultaat, model } = await roep({ system: schrijverPrompt(), content, schema, tool: 'lever_blok', max_tokens: 5000 });
  let blok = resultaat && resultaat.blok;
  const controle = (b) => {
    const p = { ...pagina, blokken: [b] };
    return [...blokFouten(b, index), ...beeldFouten(p, ctx.assets), ...controleerCijfers(p, cijferBronnen(ctx.input, ctx.assets)).map((c) => `cijfer ${c.waarde} niet in de feitenbank/invoer`),
      ...controleerGrenzen(b, grensOpties(ctx.input, ctx.verbodenNamen || [])).map((x) => `${x.regel} ("${x.fragment}")`)];
  };
  let fouten = blok ? controle(blok) : ['geen blok'];
  if (fouten.length) {
    const r = await roep({ system: schrijverPrompt(), content: [...content, { type: 'text', text: 'VORIGE VERSIE:\n' + JSON.stringify(blok) + '\n\n' + herstel(fouten) }], schema, tool: 'lever_blok', max_tokens: 5000, temperature: 0.4 });
    blok = r.resultaat && r.resultaat.blok; model = r.model;
    fouten = blok ? controle(blok) : ['geen blok'];
  }
  if (blok && doelType === 'hero' && bestaand) blok.variant = bestaand.variant;
  return { blok, model, fouten };
}

/** Voor het werkblad/de lijst: korte info over de combinatie. */
export function regieSamenvatting(output) {
  const c = combinatie(output && output.pagina);
  return c ? { thema: c.thema, hero: c.hero, interactief: c.interactief } : null;
}

export { INTERACTIEF, NUGGETS };
