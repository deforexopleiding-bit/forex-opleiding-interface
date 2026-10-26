// api/_lib/contentmachine-generator.js
//
// Contentmachine — het hart: van de invoer van de week naar één strikte JSON met
// pagina, nieuwsbrief, stories, post, vierkant en LinkedIn.
//
//   FORMATS + toegelatenFormats() — rotatie: nooit het format van één van de vorige 3 drops
//   OUTPUT_SCHEMA / ONDERDEEL_SCHEMAS — het contract (tool-use, geforceerd)
//   systeemPrompt() / gebruikersBericht() — stem, grenzen, strategiekennis, input, beelden
//   valideerOutput() — schema + logica (aantallen, bloktypes, beeld-id's, format)
//   controleerGrenzen() — verboden woorden/claims, namen zonder toestemming, Dave enkel bij het cadeau
//   gelijkenis() / teGelijk() — uniciteit t.o.v. de vorige 6 drops
//   genereerDrop() / genereerOnderdeel() — de aanroepen (één herstelronde)
//
// Alles behalve genereerDrop/genereerOnderdeel is PUUR en getest in
// tests/contentmachine-generator.test.js.

import { anthropicStructuredOutput } from './anthropic-client.js';
import { modelKeten } from './contentmachine-ai.js';
import { DFO_STRATEGIE_KENNIS } from './dfo-strategie-kennis.js';
import { trainingDatum, datumVoluit, weekdagVan } from './contentmachine-core.js';

// ── Formats ─────────────────────────────────────────────────────────────────
export const FORMATS = [
  { key: 'trade_ontleed', naam: 'De trade ontleed', uitleg: 'Eén trade van H4-context tot target, stap voor stap in de DFO-volgorde.', past: 'er is een trade van de week of een chart met een trade' },
  { key: 'wat_zou_jij_doen', naam: 'Wat zou jij doen?', uitleg: 'Een chart-quiz: de lezer kiest, het antwoord staat pas op de pagina.', past: 'er is een duidelijke chart of setup-moment' },
  { key: 'achter_de_schermen', naam: 'Achter de schermen', uitleg: 'Wat er deze week in de community en de live gebeurde.', past: 'er gebeurde iets in de community, de live of het team' },
  { key: 'het_bewijs', naam: 'Het bewijs', uitleg: 'Payout(s) centraal, met het verhaal en de stappen erachter.', past: 'er zijn payouts met toestemming' },
  { key: 'fout_van_de_week', naam: 'De fout van de week', uitleg: 'Een veelgemaakte fout die we live zagen, en hoe het wel moet.', past: 'er is een les of fout uit de live' },
  { key: 'een_regel_diep', naam: 'Eén regel, diep', uitleg: 'Eén regel uit het tradeplan grondig uitgelegd (bv. waarom 71% enkel locatie is).', past: 'altijd mogelijk; vooral als er weinig nieuws is' },
  { key: 'vooruitblik', naam: 'Vooruitblik', uitleg: 'De markt voor volgende week (DXY, sleutelparen), zonder voorspellingen als zekerheid.', past: 'er is marktcontext of een chart van de DXY/sleutelparen' },
  { key: 'vraag_van_student', naam: 'Vraag van een student', uitleg: 'Een echte vraag uit de training, beantwoord.', past: 'er werd een vraag gesteld in de training of community' },
];
export const FORMAT_KEYS = FORMATS.map((f) => f.key);

/** Formats die deze week mogen: niet dat van één van de vorige 3 drops. `vorige` = nieuwste eerst. */
export function toegelatenFormats(vorige = []) {
  const recent = new Set(vorige.slice(0, 3).map((d) => d && d.format_key).filter(Boolean));
  const ok = FORMAT_KEYS.filter((k) => !recent.has(k));
  return ok.length ? ok : FORMAT_KEYS.slice();
}

// ── Schema ──────────────────────────────────────────────────────────────────
export const BLOK_TYPES = ['opener', 'video', 'chart', 'trade_ontleed', 'quiz', 'payout', 'tip_van_de_week', 'mythe', 'vooruitblik', 'cijfers', 'cadeau', 'ps'];
export const STORY_ROLLEN = ['hook', 'inhoud', 'bewijs', 'cta'];
export const STICKERS = ['link', 'poll', 'vraag', 'quiz'];
export const ONDERDELEN = ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'];

const S = { type: 'string' };
const SN = { type: ['string', 'null'] };
const ARR = (items, min, max) => ({ type: 'array', items, ...(min != null ? { minItems: min } : {}), ...(max != null ? { maxItems: max } : {}) });

const PAGINA_SCHEMA = {
  type: 'object',
  description: 'De webpagina van de drop (training.deforexopleiding.nl/<slug>). **vet** mag in lead, ontgrendeld_tekst en quote.',
  properties: {
    seo_titel: S, seo_beschrijving: S, og_titel: S, og_beschrijving: S,
    hero_kicker: { type: 'string', description: 'Klein goud label boven de kop, bv. "Gratis opname · Live training 22/10".' },
    hero_titel: { type: 'string', description: 'Eerste regel van de kop, kort en sterk (max 6 woorden).' },
    hero_accent: { type: 'string', description: 'Tweede regel in goud (max 6 woorden).' },
    lead: { type: 'string', description: 'Intro van 2-3 zinnen; **vet** voor de kern.' },
    feiten: ARR({ type: 'object', properties: { icoon: { type: 'string', enum: ['klok', 'grafiek', 'slot'] }, tekst: S }, required: ['icoon', 'tekst'] }, 2, 3),
    frustraties_titel: S,
    frustraties: ARR(S, 3, 3),
    frustraties_antwoord: S,
    inhoud_titel: S,
    kaarten: ARR({ type: 'object', properties: { label: S, titel: S, tekst: S, beeld_asset_id: SN }, required: ['label', 'titel', 'tekst'] }, 2, 5),
    paren: ARR(S, 0, 12),
    verhaal: { type: 'string', description: 'Enkel bij een update-drop zonder video: het verhaal van de week in 2-4 korte alinea\'s (lege regel ertussen).' },
    galerij: ARR({ type: 'object', properties: { asset_id: S, bijschrift: S }, required: ['asset_id', 'bijschrift'] }, 0, 8),
    trade_stappen: ARR({ type: 'object', properties: { titel: S, tekst: S }, required: ['titel', 'tekst'] }, 0, 10),
    quiz: { type: ['object', 'null'], properties: { vraag: S, opties: ARR(S, 2, 4), antwoord_index: { type: 'integer' }, uitleg: S }, description: 'Enkel bij format wat_zou_jij_doen: het antwoord op de quiz uit de nieuwsbrief.' },
    quote: { type: 'string', description: 'Citaat; het deel tussen **…** wordt goud.' },
  },
  // formulier_titel / formulier_sub / knop / ontgrendeld_tekst zijn VAST (vasteFormulierTeksten).
  required: ['seo_titel', 'seo_beschrijving', 'og_titel', 'og_beschrijving', 'hero_kicker', 'hero_titel', 'hero_accent', 'lead', 'feiten', 'frustraties_titel', 'frustraties', 'frustraties_antwoord', 'inhoud_titel', 'kaarten', 'paren', 'quote'],
};

// ── Vaste formulierteksten ──────────────────────────────────────────────────
// De poort op de pagina vraagt naam, e-mail en gsm-nummer. Bij een training opent
// de video meteen op de pagina; bij een update schrijf je je in op de wekelijkse
// analyse. Er wordt NOOIT een link gemaild. Deze teksten schrijft het model niet.
export const FORMULIER_VELDEN = ['formulier_titel', 'formulier_sub', 'knop', 'ontgrendeld_tekst'];

/** De vaste teksten voor de poort, per soort. `startSec` = waar de analyse begint. */
export function vasteFormulierTeksten({ soort, startSec } = {}) {
  if (soort !== 'training') {
    return {
      formulier_titel: 'Krijg elke week onze marktanalyse',
      formulier_sub: 'Vul je naam, e-mail en gsm-nummer in. Je staat meteen op de lijst.',
      knop: 'Schrijf je in',
      ontgrendeld_tekst: 'Je staat op de lijst. **Elke week** onze marktanalyse in je mailbox.',
    };
  }
  const s = Number(startSec) > 0 ? Math.round(Number(startSec)) : 0;
  const tijd = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return {
    formulier_titel: 'Ontgrendel de volledige training',
    formulier_sub: 'Vul je naam, e-mail en gsm-nummer in. De video start meteen hier op de pagina.',
    knop: 'Bekijk de training nu',
    ontgrendeld_tekst: s ? `▶ De video start op **${tijd}**, daar begint de analyse. Veel kijkplezier.` : '▶ **Veel kijkplezier.** De video staat hierboven klaar.',
  };
}

/** Output met de vaste formulierteksten (kopie; zonder pagina ongewijzigd). */
export function metVasteTeksten(o, { drop, input } = {}) {
  if (!o || !o.pagina || typeof o.pagina !== 'object') return o;
  const i = input || (drop && drop.input) || {};
  return { ...o, pagina: { ...o.pagina, ...vasteFormulierTeksten({ soort: drop && drop.soort, startSec: i.start_sec }) } };
}

const BLOK_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: BLOK_TYPES },
    kicker: SN, titel: SN, tekst: SN,
    beeld_asset_id: SN,
    stappen: ARR({ type: 'object', properties: { titel: S, tekst: S }, required: ['titel', 'tekst'] }, 0, 10),
    vraag: SN, opties: ARR(S, 0, 4),
    getal: SN, getal_label: SN,
    knop_tekst: SN,
  },
  required: ['type'],
};

const NIEUWSBRIEF_SCHEMA = {
  type: 'object',
  properties: {
    onderwerpen: { ...ARR(S, 3, 3), description: 'Drie A/B-varianten voor de onderwerpregel (max 60 tekens elk), elk een andere invalshoek.' },
    preheader: { type: 'string', description: 'Voorbeeldtekst (max 110 tekens), vult het onderwerp aan.' },
    blokken: { ...ARR(BLOK_SCHEMA, 4, 9), description: 'Begin met opener. Kies en orden de blokken per format. Eén duidelijke volgende stap.' },
    ps: { type: 'string', description: 'Korte PS in Maxims stem (open lus of herinnering aan de pagina).' },
  },
  required: ['onderwerpen', 'preheader', 'blokken', 'ps'],
};

const STORIES_SCHEMA = {
  ...ARR({
    type: 'object',
    properties: {
      rol: { type: 'string', enum: STORY_ROLLEN }, kicker: S, titel: S, tekst: S,
      beeld_asset_id: SN, sticker: { type: 'string', enum: STICKERS }, sticker_tekst: S,
    },
    required: ['rol', 'kicker', 'titel', 'tekst', 'sticker', 'sticker_tekst'],
  }, 3, 5),
  description: 'Instagram-stories 1080x1920: begin met hook, eindig met cta (linksticker naar de pagina).',
};

const POST_SCHEMA = {
  type: 'object',
  properties: {
    slides: ARR({ type: 'object', properties: { titel: S, tekst: S, beeld_asset_id: SN }, required: ['titel', 'tekst'] }, 5, 7),
    caption: { type: 'string', description: 'Instagram-caption, eerste regel = hook, eindigt met de volgende stap (link in bio).' },
    hashtags: ARR(S, 3, 12),
  },
  required: ['slides', 'caption', 'hashtags'],
};
const VIERKANT_SCHEMA = { type: 'object', properties: { titel: S, sub: S, beeld_asset_id: SN }, required: ['titel', 'sub'] };
const LINKEDIN_SCHEMA = {
  type: 'object',
  properties: {
    tekst: { type: 'string', description: 'LinkedIn-post: zakelijker, eerste 2 regels zijn de hook, korte alinea\'s, eindigt met de link-tekst.' },
    beeld: { type: 'string', enum: ['vierkant', 'slide1'] },
  },
  required: ['tekst', 'beeld'],
};

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    format_key: { type: 'string', enum: FORMAT_KEYS },
    kernidee: { type: 'string', description: 'De rode draad van deze week in één zin.' },
    pagina: PAGINA_SCHEMA,
    nieuwsbrief: NIEUWSBRIEF_SCHEMA,
    stories: STORIES_SCHEMA,
    post: POST_SCHEMA,
    vierkant: VIERKANT_SCHEMA,
    linkedin: LINKEDIN_SCHEMA,
  },
  required: ['format_key', 'kernidee', 'pagina', 'nieuwsbrief', 'stories', 'post', 'vierkant', 'linkedin'],
};

/** Schema voor het opnieuw genereren van één onderdeel. 'post' omvat ook het vierkant. */
export function onderdeelSchema(onderdeel) {
  if (onderdeel === 'post') return { type: 'object', properties: { post: POST_SCHEMA, vierkant: VIERKANT_SCHEMA }, required: ['post', 'vierkant'] };
  const map = { pagina: PAGINA_SCHEMA, nieuwsbrief: NIEUWSBRIEF_SCHEMA, stories: STORIES_SCHEMA, linkedin: LINKEDIN_SCHEMA };
  return { type: 'object', properties: { [onderdeel]: map[onderdeel] }, required: [onderdeel] };
}

// ── Validatie ───────────────────────────────────────────────────────────────
const isTekst = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Schema + logica. → { ok, fouten:[string] }. `toegelaten` = format-keys die
 * mochten; `assetIds` = beeld-id's die de generator mocht gebruiken.
 */
export function valideerOutput(o, { toegelaten = FORMAT_KEYS, assetIds = null, onderdelen = null } = {}) {
  const fouten = [];
  const f = (m) => fouten.push(m);
  if (!o || typeof o !== 'object') return { ok: false, fouten: ['output is geen object'] };
  const check = (naam) => !onderdelen || onderdelen.includes(naam);
  const beeld = (id, pad) => {
    if (id == null || id === '') return;
    if (assetIds && !assetIds.includes(id)) f(`${pad}: onbekend beeld-id ${id}`);
  };

  if (!onderdelen) {
    if (!FORMAT_KEYS.includes(o.format_key)) f('format_key ontbreekt of is onbekend');
    else if (!toegelaten.includes(o.format_key)) f(`format_key ${o.format_key} is deze week niet toegelaten (rotatie)`);
    if (!isTekst(o.kernidee)) f('kernidee ontbreekt');
  }

  if (check('pagina')) {
    const p = o.pagina;
    if (!p || typeof p !== 'object') f('pagina ontbreekt');
    else {
      for (const k of PAGINA_SCHEMA.required) if (p[k] == null || (typeof p[k] === 'string' && !p[k].trim())) f(`pagina.${k} ontbreekt`);
      if (!Array.isArray(p.frustraties) || p.frustraties.length !== 3) f('pagina.frustraties moet 3 punten hebben');
      if (!Array.isArray(p.kaarten) || p.kaarten.length < 2) f('pagina.kaarten: minstens 2');
      (p.kaarten || []).forEach((k, i) => beeld(k && k.beeld_asset_id, `pagina.kaarten[${i}]`));
      (p.galerij || []).forEach((g, i) => beeld(g && g.asset_id, `pagina.galerij[${i}]`));
      if (p.quiz && (!Array.isArray(p.quiz.opties) || p.quiz.antwoord_index == null || p.quiz.antwoord_index < 0 || p.quiz.antwoord_index >= p.quiz.opties.length)) f('pagina.quiz: antwoord_index klopt niet');
      if (isTekst(p.hero_titel) && p.hero_titel.split(/\s+/).length > 9) f('pagina.hero_titel te lang (max ~6 woorden)');
    }
  }

  if (check('nieuwsbrief')) {
    const n = o.nieuwsbrief;
    if (!n || typeof n !== 'object') f('nieuwsbrief ontbreekt');
    else {
      if (!Array.isArray(n.onderwerpen) || n.onderwerpen.length !== 3 || !n.onderwerpen.every(isTekst)) f('nieuwsbrief.onderwerpen: precies 3');
      else if (new Set(n.onderwerpen.map((x) => x.trim().toLowerCase())).size !== 3) f('nieuwsbrief.onderwerpen: 3 verschillende varianten');
      (n.onderwerpen || []).forEach((x, i) => { if (isTekst(x) && x.length > 80) f(`nieuwsbrief.onderwerpen[${i}] te lang`); });
      if (!isTekst(n.preheader)) f('nieuwsbrief.preheader ontbreekt');
      const b = Array.isArray(n.blokken) ? n.blokken : [];
      if (b.length < 4 || b.length > 9) f('nieuwsbrief.blokken: 4 tot 9');
      if (b[0] && b[0].type !== 'opener') f('nieuwsbrief.blokken: begin met opener');
      b.forEach((x, i) => {
        if (!x || !BLOK_TYPES.includes(x.type)) { f(`nieuwsbrief.blokken[${i}]: onbekend type`); return; }
        beeld(x.beeld_asset_id, `nieuwsbrief.blokken[${i}]`);
        if (x.type === 'quiz' && (!isTekst(x.vraag) || !Array.isArray(x.opties) || x.opties.length < 2)) f(`nieuwsbrief.blokken[${i}]: quiz heeft een vraag en 2-4 opties nodig`);
        if (x.type === 'trade_ontleed' && (!Array.isArray(x.stappen) || x.stappen.length < 3)) f(`nieuwsbrief.blokken[${i}]: trade_ontleed heeft minstens 3 stappen nodig`);
        if (x.type === 'cijfers' && !isTekst(x.getal)) f(`nieuwsbrief.blokken[${i}]: cijfers zonder getal`);
        if (['payout', 'chart'].includes(x.type) && !x.beeld_asset_id) f(`nieuwsbrief.blokken[${i}]: ${x.type} zonder beeld`);
      });
      const quiz = b.some((x) => x && x.type === 'quiz');
      if (quiz && !onderdelen && !(o.pagina && o.pagina.quiz)) f('nieuwsbrief heeft een quiz maar pagina.quiz (het antwoord) ontbreekt');
      if (!isTekst(n.ps)) f('nieuwsbrief.ps ontbreekt');
    }
  }

  if (check('stories')) {
    const s = o.stories;
    if (!Array.isArray(s) || s.length < 3 || s.length > 5) f('stories: 3 tot 5');
    else {
      if (s[0].rol !== 'hook') f('stories: de eerste is de hook');
      if (s[s.length - 1].rol !== 'cta') f('stories: de laatste is de cta');
      if (s[s.length - 1].sticker !== 'link') f('stories: de cta heeft een linksticker');
      s.forEach((x, i) => {
        if (!STORY_ROLLEN.includes(x.rol)) f(`stories[${i}].rol onbekend`);
        if (!STICKERS.includes(x.sticker)) f(`stories[${i}].sticker onbekend`);
        if (!isTekst(x.titel)) f(`stories[${i}].titel ontbreekt`);
        beeld(x.beeld_asset_id, `stories[${i}]`);
      });
    }
  }

  if (check('post')) {
    const p = o.post;
    if (!p || !Array.isArray(p.slides) || p.slides.length < 5 || p.slides.length > 7) f('post.slides: 5 tot 7');
    else p.slides.forEach((x, i) => { if (!isTekst(x.titel)) f(`post.slides[${i}].titel ontbreekt`); beeld(x.beeld_asset_id, `post.slides[${i}]`); });
    if (!p || !isTekst(p.caption)) f('post.caption ontbreekt');
    if (!p || !Array.isArray(p.hashtags) || !p.hashtags.length) f('post.hashtags ontbreken');
    const v = o.vierkant;
    if (!v || !isTekst(v.titel)) f('vierkant.titel ontbreekt');
    else beeld(v.beeld_asset_id, 'vierkant');
  }

  if (check('linkedin')) {
    const l = o.linkedin;
    if (!l || !isTekst(l.tekst)) f('linkedin.tekst ontbreekt');
    else if (!['vierkant', 'slide1'].includes(l.beeld)) f('linkedin.beeld: vierkant of slide1');
  }

  return { ok: fouten.length === 0, fouten };
}

// ── Grenzen (stem, beloftes, namen) ─────────────────────────────────────────
/** Alle tekstvelden met hun pad. */
export function alleTeksten(o, pad = '', uit = []) {
  if (o == null) return uit;
  if (typeof o === 'string') { uit.push({ pad, tekst: o }); return uit; }
  if (Array.isArray(o)) { o.forEach((x, i) => alleTeksten(x, `${pad}[${i}]`, uit)); return uit; }
  if (typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (/(_asset_id|asset_id|^format_key|^icoon|^type|^rol|^sticker$|^beeld$|^meta$|^waarschuwingen$)/.test(k)) continue;
      alleTeksten(v, pad ? `${pad}.${k}` : k, uit);
    }
  }
  return uit;
}

/** De grens-opties van een drop: welke weekdag mag (die van de training, of geen). */
export function grensOpties(input, verbodenNamen = []) {
  return { verbodenNamen, weekdag: weekdagVan(trainingDatum(input)) };
}

// Woordgrenzen die ook achter een letter met accent werken.
const W = (s) => new RegExp(`(^|[^\\p{L}\\p{N}])(${s})(?=$|[^\\p{L}\\p{N}])`, 'iu');
export const VERBODEN = [
  { re: W('gegarandeerd|garantie op|garanderen|wij garanderen'), wat: 'garantie' },
  { re: W('makkelijk(e)? geld|snel geld|gratis geld'), wat: 'makkelijk geld' },
  { re: W('snel rijk|rijk worden'), wat: 'snel rijk worden', ontkenning: true },
  { re: W('passief inkomen|passieve inkomsten'), wat: 'passief inkomen', ontkenning: true },
  { re: W('verkoop|uitverkoop|verkooppraat'), wat: 'verkooppraat' },
  { re: W('deal|deals'), wat: 'verkooppraat (deal)' },
  { re: W('korting|aanbieding|promo|promotie'), wat: 'korting/aanbieding' },
  { re: W('laatste kans|op is op|nu of nooit|haast je'), wat: 'valse schaarste' },
  { re: /!{2,}/, wat: 'meerdere uitroeptekens' },
  { re: W('zonder risico|risicoloos|risicovrij|geen risico'), wat: 'risico ontkennen', ontkenning: false },
  { re: W('100% zeker|altijd winst|nooit verlies|zekere winst|winstgarantie'), wat: 'winstclaim' },
  { re: W('financi[eë]le vrijheid'), wat: 'beloftetaal (financiële vrijheid)', ontkenning: true },
  { re: W('swing|swingtrade|swingtrading'), wat: '"swing" naar buiten (gebruik H4-limit)' },
  { re: /\b\d+(?:[.,]\d+)?\s?%\s*(?:winst|rendement)?\s*per\s*(?:maand|week|dag)\b/i, wat: 'rendementsclaim per periode' },
  { re: W('verdien(?:en|t)?\\s+(?:tot\\s+)?€\\s?\\d'), wat: 'verdienclaim' },
  { re: W('(?:sturen|mailen|e-mailen)\\s+(?:we\\s+)?(?:je|jou|u)\\s+(?:direct\\s+|meteen\\s+|zo\\s+)?(?:de|een)\\s+link'), wat: 'verkeerde flow: de video opent op de pagina, we mailen geen link' },
];

const WEEKDAG_RE = /(^|[^\p{L}\p{N}])((?:maan|dins|woens|donder|vrij|zater|zon)dag)(?:s|en)?(?=$|[^\p{L}\p{N}])/giu;

const ONTKENNING = /\b(geen|niet|nooit|zonder|g[eé]{1,2}n beloftes?)\b[^.!?]{0,30}$/i;

/**
 * → [{ pad, regel, fragment }]. `verbodenNamen` = namen die niet mogen (geen
 * toestemming / sprekers); 'Dave' mag enkel in een tekst over het cadeau/de sessie.
 * `weekdag` (als de sleutel meegegeven wordt): de enige weekdag die mag, de dag van
 * de training ('donderdag'), of null = geen enkele weekdag (datum onbekend).
 */
export function controleerGrenzen(o, { verbodenNamen = [], weekdag } = {}) {
  const checkDag = weekdag !== undefined;
  const uit = [];
  for (const { pad, tekst } of alleTeksten(o)) {
    for (const v of VERBODEN) {
      const m = v.re.exec(tekst);
      if (!m) continue;
      if (v.ontkenning && ONTKENNING.test(tekst.slice(0, m.index + (m[1] ? m[1].length : 0)))) continue;
      uit.push({ pad, regel: v.wat, fragment: fragment(tekst, m.index) });
    }
    for (const naam of verbodenNamen) {
      if (!naam || naam.length < 2) continue;
      // Hoofdlettergevoelig: 'Jan' is een naam, 'jan' een maand.
      const m = new RegExp(`(^|[^\\p{L}\\p{N}])(${naam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?=$|[^\\p{L}\\p{N}])`, 'u').exec(tekst);
      if (m) uit.push({ pad, regel: `naam zonder toestemming: ${naam}`, fragment: fragment(tekst, m.index) });
    }
    if (checkDag) {
      for (const m of tekst.matchAll(WEEKDAG_RE)) {
        const dag = m[2].toLowerCase();
        if (dag === weekdag) continue;
        uit.push({ pad, regel: weekdag ? `weekdag klopt niet: de training was op ${weekdag}` : 'weekdag geraden (de datum van de training is niet ingevuld)', fragment: fragment(tekst, m.index) });
        break;
      }
    }
    const dave = W('dave').exec(tekst);
    if (dave && !/(cadeau|strategiesessie|strategie-sessie|sessie|gesprek|call|€\s?0)/i.test(tekst)) {
      uit.push({ pad, regel: 'Dave enkel bij het cadeau (strategiesessie)', fragment: fragment(tekst, dave.index) });
    }
  }
  return uit;
}

function fragment(tekst, i) {
  const s = Math.max(0, i - 25);
  return (s > 0 ? '…' : '') + tekst.slice(s, i + 45).replace(/\s+/g, ' ').trim() + (i + 45 < tekst.length ? '…' : '');
}

// ── Uniciteit ───────────────────────────────────────────────────────────────
function trigrammen(s) {
  const t = ' ' + String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}
/** Dice-coëfficiënt op letter-trigrammen (0..1). */
export function gelijkenis(a, b) {
  const A = trigrammen(a); const B = trigrammen(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return (2 * n) / (A.size + B.size);
}

export const GELIJK_DREMPEL = 0.62;

/** De hooks van een output: wat elke week anders moet zijn. */
export function hooksVan(o) {
  if (!o) return { onderwerpen: [], hooks: [] };
  const n = o.nieuwsbrief || {};
  return {
    onderwerpen: (n.onderwerpen || []).filter(isTekst),
    hooks: [
      o.pagina && [o.pagina.hero_titel, o.pagina.hero_accent].filter(Boolean).join(' '),
      Array.isArray(o.stories) && o.stories[0] && o.stories[0].titel,
      o.post && Array.isArray(o.post.slides) && o.post.slides[0] && o.post.slides[0].titel,
      o.linkedin && String(o.linkedin.tekst || '').split('\n')[0],
    ].filter(isTekst),
  };
}

/**
 * Vergelijk met de vorige drops. → [{ onderdeel, wat, nieuw, oud, score }] —
 * enkel wat boven de drempel komt. onderdeel = welk deel opnieuw moet.
 */
export function teGelijk(o, vorige = [], drempel = GELIJK_DREMPEL) {
  const uit = [];
  const nu = hooksVan(o);
  const ONDERDEEL_VAN_HOOK = ['pagina', 'stories', 'post', 'linkedin'];
  for (const d of vorige) {
    const oud = hooksVan(d && d.output);
    for (const s of nu.onderwerpen) for (const t of oud.onderwerpen) {
      const score = gelijkenis(s, t);
      if (score >= drempel) uit.push({ onderdeel: 'nieuwsbrief', wat: 'onderwerp', nieuw: s, oud: t, slug: d.slug, score: Math.round(score * 100) / 100 });
    }
    nu.hooks.forEach((h, i) => {
      for (const t of oud.hooks) {
        const score = gelijkenis(h, t);
        if (score >= drempel) uit.push({ onderdeel: ONDERDEEL_VAN_HOOK[i] || 'pagina', wat: 'hook', nieuw: h, oud: t, slug: d.slug, score: Math.round(score * 100) / 100 });
      }
    });
  }
  return uit;
}

// ── Prompt ──────────────────────────────────────────────────────────────────
export function systeemPrompt() {
  return `Je bent de contentredactie van De Forex Opleiding (DFO). Elke week maak je één "drop": een webpagina, een nieuwsbrief, Instagram-stories, een Instagram-carrousel met vierkant beeld en een LinkedIn-post — allemaal rond één kernidee, in de huisstijl van training.deforexopleiding.nl.

STEM
- Vlaams/Nederlands, direct, rustig zelfvertrouwen, "we/wij". Korte zinnen. Concreet in plaats van groot.
- De nieuwsbrief komt van Maxim (afzender, opener in zijn stem). Geen andere sprekers- of mentornamen. "Dave" enkel bij het cadeau: een gratis strategiesessie met Dave, t.w.v. €100, nu €0.
- Studentnamen enkel bij beelden met toestemming (staat bij elk beeld vermeld). Zonder toestemming: geen naam, spreek van "een student".

HARDE GRENZEN
- Geen beloftes over snel rijk worden. Nooit "gegarandeerd", "makkelijk geld", "passief inkomen", "zonder risico", "financiële vrijheid".
- Geen winstclaims zonder bewijs. Enkel getallen die in de input of op een beeld staan. Geen rendement per maand.
- Geen verkooppraat: geen "verkoop", "deal", "korting", "aanbieding", "laatste kans", geen meerdere uitroeptekens. Benoem wat er feitelijk gebeurt. Het cadeau mag: "t.w.v. €100, nu €0".
- Zeg nooit "swing" of "swingtrade" naar buiten; noem het een H4-limit.
- Datums: noem ENKEL de datum en weekdag van de training die je meekrijgt ("DATUM TRAINING"). Raad nooit een weekdag. Is de datum onbekend, noem dan geen weekdag en geen datum: zeg "deze week" of "in de live training". De datum van de drop is NIET de datum van de training.
- De poort op de pagina werkt zo: de bezoeker vult naam, e-mail en gsm-nummer in; bij een training start de video METEEN op de pagina (er wordt nooit een link gemaild); daarna komt het cadeau. Bij een update schrijft hij zich in op de wekelijkse marktanalyse. De teksten van dat formulier zijn vast; die schrijf jij niet.
- Trading-uitleg en tips ENKEL uit de DFO-strategiekennis hieronder. Wat er niet in staat, verzin je niet en vul je niet aan met algemene ICT/SMC-regels.
- Een disclaimer (educatief, geen financieel advies, risico op verlies) wordt automatisch toegevoegd; schrijf er zelf geen.

TRIGGERS (subtiel, in elke editie)
- Nieuwsgierigheid: een open lus die pas op de pagina sluit (bv. het antwoord op de quiz, de volgende stap van de trade).
- Bewijs: één concreet getal, chart of resultaat uit de input of de beelden.
- Schaarste die waar is: de opname/het cadeau is er "deze week".
- Eén duidelijke volgende stap (de pagina).

UNIEK ELKE WEEK
- Kies het format dat het best bij deze input past, ENKEL uit de toegelaten formats.
- Andere invalshoek, hooks en onderwerpregels dan de vorige drops (die krijg je mee). Herhaal hun formuleringen niet.

BEELDEN
- Gebruik enkel de beeld-id's die je krijgt (beeld_asset_id / asset_id). Payout-beelden horen bij een payout-blok of bewijs-story. Laat een beeld leeg (null) als er niets past.

DFO-STRATEGIEKENNIS (de enige bron voor uitleg en tips)
${DFO_STRATEGIE_KENNIS}

FORMATS
${FORMATS.map((f) => `- ${f.key} — ${f.naam}: ${f.uitleg} (past als ${f.past})`).join('\n')}

NIEUWSBRIEF-BLOKKEN (kies en orden per format; begin met opener, 4-9 blokken)
opener (persoonlijke aanhef van Maxim) · video (thumbnail + knop naar de pagina; enkel als er een video is) · chart (beeld + uitleg) · trade_ontleed (stappen in de DFO-volgorde) · quiz ("Wat zou jij doen?" — antwoord pas op de pagina; dan pagina.quiz invullen) · payout (bewijs, naam enkel met toestemming) · tip_van_de_week · mythe (veelgemaakte fout ontkracht) · vooruitblik · cijfers (één opvallend getal groot) · cadeau (gratis strategiesessie met Dave, t.w.v. €100, nu €0) · ps.

Lever ALLES via de tool, strikt volgens het schema.`;
}

function beeldRegel(a) {
  const d = a.ai_details || {};
  const feiten = [d.firma, d.bedrag != null ? `${d.valuta || ''} ${d.bedrag}`.trim() : null, d.paar, d.timeframe, d.richting].filter(Boolean).join(', ');
  const naam = a.persoon_naam ? (a.toestemming_publiek ? `persoon: ${a.persoon_naam} (toestemming: ja, naam mag)` : 'persoon: student ZONDER toestemming (naam NIET noemen)') : 'geen persoon';
  return `Beeld ${a.id} — soort: ${a.soort}; ${naam}; bijschrift: ${a.bijschrift || '—'}; ${a.ai_beschrijving ? 'wat erop staat: ' + a.ai_beschrijving : ''}${feiten ? ' [' + feiten + ']' : ''}${a.bron === 'bibliotheek' ? ' (uit de bibliotheek)' : ' (van deze week)'}`;
}

/** Samenvatting van de vorige drops voor de rotatie/uniciteit. */
export function vorigeSamenvatting(vorige = []) {
  if (!vorige.length) return 'Nog geen vorige drops.';
  return vorige.map((d) => {
    const h = hooksVan(d.output);
    return `- ${d.slug} · format ${d.format_key || '—'} · kernidee: ${(d.output && d.output.kernidee) || '—'}\n  onderwerpen: ${h.onderwerpen.join(' | ') || '—'}\n  hooks: ${h.hooks.join(' | ') || '—'}`;
  }).join('\n');
}

/** Het gebruikersbericht: beelden (vision) + de input van de week. */
export function gebruikersBericht({ drop, input, beelden = [], vorige = [], toegelaten, paginaUrl, extra = '' }) {
  const i = input || {};
  const t = i.trade_info || {};
  const td = datumVoluit(trainingDatum(i));
  const regels = [
    `DROP ${drop.slug} (aangemaakt op ${drop.datum}) — soort: ${drop.soort === 'training' ? 'training (er is een video-opname)' : 'update (geen video deze week)'}`,
    drop.soort === 'training'
      ? (td ? `DATUM TRAINING: ${td.voluit} (kort: ${td.kort}). Dit is de enige weekdag en datum die je mag noemen.` : 'DATUM TRAINING: onbekend — noem geen weekdag en geen datum van de training.')
      : 'Geen training deze week — noem geen weekdag.',
    `Pagina: ${paginaUrl}`,
    `Kanalen: ${(i.kanalen || []).join(', ')}`,
    '',
    i.vimeo_id ? `VIDEO: "${i.vimeo_titel || 'live training'}"${i.duur ? `, ${Math.round(i.duur / 60)} min` : ''}${i.start_sec ? `, analyse begint op ${Math.floor(i.start_sec / 60)}:${String(i.start_sec % 60).padStart(2, '0')}` : ''}.` : 'GEEN VIDEO deze week: gebruik geen video-blok en spreek niet van een opname.',
    '',
    'WAT ER DEZE WEEK GEBEURDE (ruwe input van Maxim):',
    i.wat_gebeurde || '(niets ingevuld — werk met de beelden en de strategiekennis)',
  ];
  if (t.paar || t.uitleg || t.resultaat_r != null) {
    regels.push('', `TRADE VAN DE WEEK: ${t.paar || '?'} ${t.richting || ''}${t.resultaat_r != null ? `, resultaat ${String(t.resultaat_r).replace('.', ',')}R` : ''}`, t.uitleg || '');
  }
  if (i.notities) regels.push('', 'NOTITIES VOOR DE REDACTIE:', i.notities);
  regels.push('', `TOEGELATEN FORMATS deze week: ${toegelaten.join(', ')}`, '', 'VORIGE DROPS (niet herhalen):', vorigeSamenvatting(vorige));
  regels.push('', beelden.length ? 'BEELDEN (de id\'s mag je gebruiken):' : 'Geen beelden deze week.');
  if (extra) regels.push('', extra);

  const content = [];
  for (const a of beelden) {
    content.push({ type: 'text', text: beeldRegel(a) });
    if (a.publieke_url) content.push({ type: 'image', source: { type: 'url', url: a.publieke_url } });
  }
  content.unshift({ type: 'text', text: regels.join('\n') });
  content.push({ type: 'text', text: 'Maak nu de volledige drop via de tool.' });
  return content;
}

// ── Aanroepen ───────────────────────────────────────────────────────────────
const TOOL = 'lever_drop';

async function roepAan({ content, schema, max_tokens = 16000, temperature = 0.8 }) {
  return modelKeten((model) => anthropicStructuredOutput({
    model, system: systeemPrompt(), max_tokens, temperature, tool_name: TOOL, tool_input_schema: schema,
    messages: [{ role: 'user', content }],
  }));
}

function herstelTekst(fouten, grenzen) {
  return [
    'De vorige versie had deze problemen. Lever een VERBETERDE versie die ze allemaal oplost (rest mag blijven):',
    ...fouten.map((x) => '- ' + x),
    ...grenzen.map((g) => `- ${g.pad}: ${g.regel} ("${g.fragment}")`),
  ].join('\n');
}

/**
 * Volledige drop. → { output, model, herstel, waarschuwingen }
 * Eén herstelronde bij schema-/grensfouten; daarna uniciteit: een te gelijkend
 * onderdeel wordt één keer opnieuw gemaakt (als er tijd is).
 */
export async function genereerDrop(ctx) {
  const start = Date.now();
  const { toegelaten, assetIds, verbodenNamen = [], vorige = [], tijdBudgetMs = 200000 } = ctx;
  const opties = grensOpties(ctx.input, verbodenNamen);
  const content = gebruikersBericht(ctx);
  let { resultaat: output, model } = await roepAan({ content, schema: OUTPUT_SCHEMA });
  output = metVasteTeksten(output, ctx);
  let v = valideerOutput(output, { toegelaten, assetIds });
  let g = controleerGrenzen(output, opties);
  let herstel = false;
  if (!v.ok || g.length) {
    herstel = true;
    const r = await roepAan({
      content: [...content, { type: 'text', text: 'VORIGE VERSIE:\n' + JSON.stringify(output) + '\n\n' + herstelTekst(v.fouten, g) }],
      schema: OUTPUT_SCHEMA,
      temperature: 0.4,
    });
    output = metVasteTeksten(r.resultaat, ctx); model = r.model;
    v = valideerOutput(output, { toegelaten, assetIds });
    g = controleerGrenzen(output, opties);
  }
  const waarschuwingen = [...v.fouten.map((x) => ({ soort: 'schema', tekst: x })), ...g.map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment }))];

  // Uniciteit
  let gelijk = teGelijk(output, vorige);
  const teDoen = [...new Set(gelijk.map((x) => x.onderdeel))];
  for (const onderdeel of teDoen) {
    if (Date.now() - start > tijdBudgetMs) { waarschuwingen.push({ soort: 'uniek', tekst: `${onderdeel} lijkt sterk op een vorige drop (geen tijd meer om opnieuw te maken)` }); continue; }
    try {
      const bijna = gelijk.filter((x) => x.onderdeel === onderdeel).map((x) => `"${x.nieuw}" lijkt te veel op "${x.oud}" (${x.slug})`).join('; ');
      const r = await genereerOnderdeel({ ...ctx, onderdeel, huidige: output, instructie: `Te gelijkend op vorige drops: ${bijna}. Kies een duidelijk andere invalshoek en andere woorden.` });
      output = metVasteTeksten({ ...output, ...r.deel }, ctx);
    } catch (e) {
      waarschuwingen.push({ soort: 'uniek', tekst: `${onderdeel} opnieuw maken mislukt: ${e?.message || e}` });
    }
  }
  gelijk = teGelijk(output, vorige);
  for (const x of gelijk) waarschuwingen.push({ soort: 'uniek', tekst: `${x.wat} "${x.nieuw}" lijkt op ${x.slug} (${Math.round(x.score * 100)}%)` });

  return { output, model, herstel, waarschuwingen: dedupe(waarschuwingen), duur_ms: Date.now() - start };
}

function dedupe(lijst) {
  const gezien = new Set();
  return lijst.filter((x) => { const k = x.soort + '|' + x.tekst; if (gezien.has(k)) return false; gezien.add(k); return true; });
}

/**
 * Eén onderdeel opnieuw (met optionele instructie). → { deel, model, waarschuwingen }
 * `deel` = { pagina } | { nieuwsbrief } | { stories } | { post, vierkant } | { linkedin }
 */
export async function genereerOnderdeel(ctx) {
  const { onderdeel, huidige, instructie, assetIds, verbodenNamen = [] } = ctx;
  if (!ONDERDELEN.includes(onderdeel)) throw new Error('Onbekend onderdeel');
  const schema = onderdeelSchema(onderdeel);
  const opdracht = [
    `Maak ENKEL het onderdeel "${onderdeel}" opnieuw. Het format (${huidige?.format_key}) en het kernidee ("${huidige?.kernidee}") blijven.`,
    instructie ? `Instructie van Maxim: ${instructie}` : 'Maak het frisser en sterker dan de huidige versie.',
    'Huidige volledige drop (voor samenhang):',
    JSON.stringify(huidige),
  ].join('\n');
  const content = [...gebruikersBericht(ctx), { type: 'text', text: opdracht }];
  const opties = grensOpties(ctx.input, verbodenNamen);
  let { resultaat, model } = await roepAan({ content, schema, max_tokens: 8000 });
  resultaat = metVasteTeksten(resultaat, ctx);
  const onderdelen = onderdeel === 'post' ? ['post'] : [onderdeel];
  const metHuidig = (r) => ({ ...huidige, ...r });
  let v = valideerOutput(metHuidig(resultaat), { assetIds, onderdelen });
  let g = controleerGrenzen(resultaat, opties);
  if (!v.ok || g.length) {
    const r = await roepAan({
      content: [...content, { type: 'text', text: 'VORIGE VERSIE:\n' + JSON.stringify(resultaat) + '\n\n' + herstelTekst(v.fouten, g) }],
      schema, max_tokens: 8000, temperature: 0.4,
    });
    resultaat = metVasteTeksten(r.resultaat, ctx); model = r.model;
    v = valideerOutput(metHuidig(resultaat), { assetIds, onderdelen });
    g = controleerGrenzen(resultaat, opties);
  }
  const deel = onderdeel === 'post' ? { post: resultaat.post, vierkant: resultaat.vierkant } : { [onderdeel]: resultaat[onderdeel] };
  const waarschuwingen = [...v.fouten.map((x) => ({ soort: 'schema', tekst: x })), ...g.map((x) => ({ soort: 'grens', tekst: `${x.pad}: ${x.regel}`, fragment: x.fragment }))];
  return { deel, model, waarschuwingen };
}

/** Beelden die de output gebruikt (voor laatst_gebruikt_op). */
export function gebruikteAssetIds(o) {
  const ids = new Set();
  const loop = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(loop); return; }
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'beeld_asset_id' || k === 'asset_id') && typeof v === 'string' && v) ids.add(v);
      else loop(v);
    }
  };
  loop(o);
  return [...ids];
}

/**
 * Bibliotheekbeelden die de generator zelf kiest als Maxim niets koos:
 * minst recent gebruikt eerst — 2 payouts met toestemming, 1 team/masterclass, 1 chart.
 */
export function kiesBibliotheek(assets = [], aantal = 4) {
  const op = (a, b) => (a.laatst_gebruikt_op || '') < (b.laatst_gebruikt_op || '') ? -1 : (a.laatst_gebruikt_op || '') > (b.laatst_gebruikt_op || '') ? 1 : 0;
  const sorted = assets.slice().sort(op);
  const neem = (pred, n) => sorted.filter(pred).slice(0, n);
  const keuze = [
    ...neem((a) => a.soort === 'payout' && a.toestemming_publiek, 2),
    ...neem((a) => a.soort === 'team' || a.soort === 'masterclass', 1),
    ...neem((a) => a.soort === 'chart' || a.soort === 'trade', 1),
  ];
  const ids = new Set(keuze.map((a) => a.id));
  for (const a of sorted) { if (keuze.length >= aantal) break; if (!ids.has(a.id)) { keuze.push(a); ids.add(a.id); } }
  return keuze.slice(0, aantal);
}
