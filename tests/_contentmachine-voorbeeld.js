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
