// tests/_contentmachine-voorbeeld.js — een geldige generator-output (fixture) voor de
// Contentmachine-tests. Geen testbestand zelf.

export const BEELD_CHART = '11111111-1111-4111-8111-111111111111';
export const BEELD_PAYOUT = '22222222-2222-4222-8222-222222222222';
export const BEELD_ZONDER = '33333333-3333-4333-8333-333333333333';

export function voorbeeldOutput(over = {}) {
  return {
    format_key: 'trade_ontleed',
    kernidee: 'De dollar kantelt en we bouwden er live een short op GBP/USD uit, van H4-context tot target.',
    pagina: {
      seo_titel: 'De dollar draait — Live training 22/10 | De Forex Opleiding',
      seo_beschrijving: 'Kijk gratis hoe we live een short op GBP/USD opbouwden.',
      og_titel: 'De dollar draait. Wij zagen het live.',
      og_beschrijving: 'Gratis opname van de live training van 22/10.',
      hero_kicker: 'Gratis opname · Live training 22/10',
      hero_titel: 'De dollar draait.',
      hero_accent: 'Wij zagen het live.',
      lead: 'Elke week analyseren we de markt live. Deze week kantelde de **DXY van bearish naar bullish**.',
      feiten: [{ icoon: 'klok', tekst: '35 min pure analyse' }, { icoon: 'grafiek', tekst: '10+ paren' }, { icoon: 'slot', tekst: 'Normaal enkel voor studenten' }],
      frustraties_titel: 'Herkenbaar?',
      frustraties: ['Je ziet de setup pas achteraf.', 'Je neemt een trade op de 15M zonder H4-context.', 'Je weet niet waar je stop hoort.'],
      frustraties_antwoord: 'Eerst de H4, dan pas de 15M. Altijd in die volgorde.',
      inhoud_titel: 'Wat je te zien krijgt',
      kaarten: [
        { label: 'H4', titel: 'De dollar kantelt', tekst: 'De bias draait.', beeld_asset_id: BEELD_CHART },
        { label: '15M', titel: 'Live short op GBP/USD', tekst: 'Entry op 71, stop onder 1, target op -27.', beeld_asset_id: null },
      ],
      paren: ['GBPUSD', 'EURUSD', 'DXY'],
      quiz: null,
      quote: 'Geen beloftes over snel rijk worden. **Gewoon hoe wij elke week naar de markt kijken.**',
      formulier_titel: 'Kijk de opname gratis',
      formulier_sub: 'Vul je gegevens in en kijk meteen.',
      knop: 'Bekijk de training',
      ontgrendeld_tekst: 'Veel kijkplezier. **Deze week** krijg je er ook een gratis strategiesessie met Dave bij.',
    },
    nieuwsbrief: {
      onderwerpen: ['De dollar draait. Wij zagen het live.', 'Van H4 tot target: één short, stap voor stap', 'Waarom we niet op 71% alleen instappen'],
      preheader: 'Bekijk gratis hoe we er live een short op GBP/USD uit opbouwden.',
      blokken: [
        { type: 'opener', titel: 'Hoi,', tekst: 'Deze week kantelde de dollar. **We zagen het live.**' },
        { type: 'chart', titel: 'De DXY kantelt', tekst: 'Van bearish naar bullish.', beeld_asset_id: BEELD_CHART },
        { type: 'trade_ontleed', titel: 'De short op GBP/USD', stappen: [{ titel: 'H4 context', tekst: 'Richting en locatie.' }, { titel: 'Impuls', tekst: 'Body close met FVG.' }, { titel: 'Entry', tekst: '71% van de 15M-impuls.' }] },
        { type: 'payout', titel: 'Het bewijs', tekst: 'Een payout van deze week.', beeld_asset_id: BEELD_PAYOUT },
        { type: 'cijfers', getal: '3,4R', getal_label: 'target op -27' },
        { type: 'cadeau', titel: 'Gratis strategiesessie met Dave', tekst: 'Deze week: t.w.v. €100, nu €0.' },
      ],
      ps: 'Het antwoord op de vraag waar de stop hoort, staat op de pagina.',
    },
    stories: [
      { rol: 'hook', kicker: 'Live training', titel: 'De dollar draait', tekst: 'We zagen het live.', beeld_asset_id: BEELD_CHART, sticker: 'poll', sticker_tekst: 'Zag jij het?' },
      { rol: 'inhoud', kicker: 'H4', titel: 'Eerst de context', tekst: 'Dan pas de 15M.', beeld_asset_id: null, sticker: 'vraag', sticker_tekst: 'Vraag het ons' },
      { rol: 'cta', kicker: 'Gratis', titel: 'Bekijk de opname', tekst: 'Deze week online.', beeld_asset_id: null, sticker: 'link', sticker_tekst: 'Bekijk gratis' },
    ],
    post: {
      slides: [
        { titel: 'De dollar draait', tekst: 'Wij zagen het live.', beeld_asset_id: BEELD_CHART },
        { titel: 'Stap 1: H4', tekst: 'Richting en locatie.' },
        { titel: 'Stap 2: impuls', tekst: 'Body close met FVG.' },
        { titel: 'Stap 3: 71%', tekst: 'Locatie, geen entry.' },
        { titel: 'Bekijk het zelf', tekst: 'Link in bio.' },
      ],
      caption: 'De dollar draait. Zo bouwden we er live een short uit.\n\nLink in bio.',
      hashtags: ['forex', 'trading', 'dfo'],
    },
    vierkant: { titel: 'De dollar draait', sub: 'Live training 22/10', beeld_asset_id: BEELD_CHART },
    linkedin: { tekst: 'De dollar draait.\nDeze week zagen we het live.\n\nBekijk de opname: training.deforexopleiding.nl/22-10-26', beeld: 'vierkant' },
    ...over,
  };
}

export const ASSETS = [
  { id: BEELD_CHART, soort: 'chart', publieke_url: 'https://cdn.test/content/chart.png', bijschrift: 'DXY H4', persoon_naam: null, toestemming_publiek: false, drop_id: null, laatst_gebruikt_op: null },
  { id: BEELD_PAYOUT, soort: 'payout', publieke_url: 'https://cdn.test/content/payout.png', bijschrift: 'Payout FTMO', persoon_naam: 'Leslie', toestemming_publiek: true, drop_id: null, laatst_gebruikt_op: '2026-10-01T00:00:00Z' },
  { id: BEELD_ZONDER, soort: 'payout', publieke_url: 'https://cdn.test/content/payout2.png', bijschrift: 'Payout', persoon_naam: 'Jeroen', toestemming_publiek: false, drop_id: null, laatst_gebruikt_op: null },
];

// ── Contentmachine 2.0: regie (stap 1) en editie (stap 2) ──────────────────
export const BEELD_FOTO = '44444444-4444-4444-8444-444444444444';
ASSETS.push({ id: BEELD_FOTO, soort: 'masterclass', publieke_url: 'https://cdn.test/content/masterclass.jpg', bijschrift: 'Masterclass op kantoor', persoon_naam: null, toestemming_publiek: true, drop_id: null, laatst_gebruikt_op: null });

export function voorbeeldRegie(over = {}) {
  return {
    format_key: 'trade_ontleed',
    kernidee: 'De dollar kantelt en we bouwden er live een short op GBP/USD uit, van H4-context tot target.',
    rode_draad: 'Eerst zelf ervaren dat een sweep geen break is, dan de volgorde, dan rekenen.',
    nugget: 'Een wick door een niveau is geen break of structure; een body close wel.',
    open_lus: 'Prijs zakt onder de low: sweep of break? Het antwoord staat in de weekeditie.',
    thema: 'nacht',
    hero_variant: 'video-poort',
    blokken: [
      { type: 'hero', variant: 'video-poort', waarom: 'De opname is de kern.' },
      { type: 'replay-sweep-bos', waarom: 'Het moment van de week zelf beleven.' },
      { type: 'trechter', waarom: 'De volgorde van de short.' },
      { type: 'payout-muur', waarom: 'Bewijs dat de methode werkt.' },
      { type: 'rr-sliders', waarom: 'Waarom 1 op 3 telt.' },
      { type: 'tip', waarom: 'De nugget.' },
      { type: 'cadeau', waarom: 'Volgende stap.' },
    ],
    beelden: [{ asset_id: BEELD_PAYOUT, waar: 'payout-muur' }],
    motivatie: 'Vorige weken waren data-zwaar; nu interactie eerst.',
    ...over,
  };
}

export function voorbeeldTeaser(over = {}) {
  return {
    onderwerpen: ['Sweep of break? Jij beslist.', 'De dollar draait. Wij zagen het live.', 'Eén regel die je deze week geld bespaart'],
    preheader: 'Speel de replay af en kies op het moment zelf.',
    opener: 'Hoi, deze week kantelde de dollar en we bouwden er in de live training een short op GBP/USD uit, van H4-context tot target. **Eén moment** maakte het verschil tussen een goede trade en een gemiste kans, en dat moment kan je nu zelf afspelen, kaars per kaars, zonder dat je weet wat er daarna komt.',
    nugget: { kicker: 'De nugget van de week', titel: 'Een wick door een niveau is geen break.', tekst: 'Pas een body close voorbij het niveau verlegt de structuur. Alles daarvoor is een sweep: liquiditeit ophalen, niet meer. Wie op de wick instapt, staat vaak aan de verkeerde kant van de beweging, en ziet zijn stop geraakt worden net voor prijs de andere kant op gaat.' },
    beeld_blok_index: 1,
    open_lus: { kicker: 'Wat zou jij doen?', vraag: 'Prijs zakt onder de low. Sweep of break?', tekst: 'Speel de replay af en kies vóór de onthulling. Het antwoord, en de volledige short, staan in de weekeditie.' },
    ps: 'Deze week krijg je er een gratis strategiesessie met Dave bij: t.w.v. €100, nu €0. Je plant hem op de pagina.',
    ...over,
  };
}

export function voorbeeldEditie(over = {}) {
  const v1 = voorbeeldOutput();
  return {
    pagina: {
      seo_titel: 'De dollar draait — Weekeditie 22/10 | De Forex Opleiding',
      seo_beschrijving: 'Gratis opname van de live training en speel zelf de replay af.',
      og_titel: 'De dollar draait. Wij zagen het live.',
      og_beschrijving: 'De Weekeditie van 22/10.',
      blokken: [
        { type: 'hero', variant: 'video-poort', props: { eyebrow: 'Gratis opname · Live training 22/10', titel: 'De dollar draait. **Wij zagen het live.**', intro: 'Deze week kantelde de **DXY**.' } },
        { type: 'replay-sweep-bos', props: { richting: 'short', scenario: 'bos', uitleg: 'De body sloot onder het niveau en bleef eronder: een break.' } },
        { type: 'trechter', props: { stappen: [{ label: 'H4-context', titel: 'De DXY kantelt', tekst: 'Richting en locatie.' }, { label: '15M', titel: 'Bevestiging', tekst: 'Liquidity en een structure shift.' }, { label: 'Entry', titel: 'Op 71', tekst: 'Van de nieuwe 15M-impuls.' }] } },
        { type: 'payout-muur', props: { payouts: [{ asset_id: BEELD_PAYOUT, bedrag: 4536, valuta: '$', label: 'Leslie · FTMO' }] } },
        { type: 'rr-sliders', props: { start_winrate: 30, start_rr: 3, voorinstellingen: [{ label: 'Onze studenten', winrate: 48.5, rr: 3.17 }] } },
        { type: 'tip', props: { voorkant: 'Bepaal eerst waar je trade **ongeldig** is.', achterkant: 'Daar ligt je stop; die afstand bepaalt je positie.' } },
        { type: 'cadeau', props: {} },
      ],
    },
    nieuwsbrief: voorbeeldTeaser(), ...voorbeeldSocial(),
    ...over,
  };
}

/** Social 2.0 (varianten zoals de Instagram-reeks). */
export function voorbeeldSocial(over = {}) {
  return {
    stories: [
      { rol: 'hook', variant: 'foto', eyebrow: 'Live training 22/10', titel: 'Sweep of break? **Jij beslist.**', tekst: 'Eén moment maakte het verschil.', beeld_asset_id: BEELD_FOTO },
      { rol: 'nugget', variant: 'donker', eyebrow: 'De nugget', titel: 'Een wick is **geen break.**', tekst: 'Pas een body close verlegt de structuur.' },
      { rol: 'bewijs', variant: 'kaart', eyebrow: 'Speel het zelf af', titel: 'De replay van **deze week**', tekst: 'Kaars per kaars.', blok_index: 1 },
      { rol: 'cta', variant: 'licht', eyebrow: 'Nu online', titel: 'De volledige **weekeditie**', tekst: 'Gratis opname + replay.', sticker_tekst: 'Lees de weekeditie' },
    ],
    post: {
      slides: [
        { variant: 'foto', eyebrow: 'Live training 22/10', titel: 'De dollar draait. **Wij zagen het live.**', tekst: 'Swipe voor de short van de week.', beeld_asset_id: BEELD_FOTO },
        { variant: 'donker', eyebrow: 'Stap 1 · H4', titel: 'Eerst **de context.**', tekst: 'Richting en locatie op H4, nog geen entry.' },
        { variant: 'kaart', eyebrow: 'Sweep of break?', titel: 'Wat zou **jij** doen?', tekst: 'Speel de replay af op de pagina.', blok_index: 1 },
        { variant: 'licht', eyebrow: 'Stap 2 · 15M', titel: 'Wacht op de **body close.**', tekst: 'Een wick alleen is geen break of structure.' },
        { variant: 'data', eyebrow: 'Onze studenten', titel: 'Winrate in het **journal**', tekst: 'Over 6.881 journaltrades.', getal: { waarde: 48.5, suffix: '%', decimalen: 1, label: 'journal-winrate' } },
        { variant: 'donker', eyebrow: 'Nu online', titel: 'De volledige **weekeditie.**', tekst: 'Gratis opname, replay en de rekensom.' },
      ],
      caption: 'De dollar draaide deze week, en we bouwden er live een short op.\n\nEén moment maakte het verschil: was het een sweep of een break?\n\nSpeel het zelf af in de weekeditie.',
      hashtags: ['forex', 'trading', 'deforexopleiding'],
    },
    vierkant: { variant: 'donker', eyebrow: 'Weekeditie 22/10', titel: 'Een wick is **geen break.**', tekst: 'De volledige short staat online.' },
    linkedin: {
      tekst: 'Weten is niet hetzelfde als doen.\n\nDeze week kantelde de dollar en bouwden we in de live training een short op GBP/USD uit, van H4-context tot target.\n\nEén moment maakte het verschil: prijs zakte onder de low. Sweep of break? Wie op de wick instapt, staat vaak aan de verkeerde kant.\n\nDe regel is eenvoudig: pas een body close voorbij het niveau verlegt de structuur.\n\nIn de weekeditie kan je het moment zelf afspelen, kaars per kaars.',
      hashtags: ['trading', 'forex'],
      beeld: { variant: 'licht', eyebrow: 'De Weekeditie', titel: 'Weten is niet **hetzelfde** als doen.', tekst: 'Speel de replay van deze week af.' },
    },
    ...over,
  };
}
