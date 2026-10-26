// docs/contentmachine/v2/demo/bouw-demo.mjs — de twee demo-edities van Contentmachine 2.0 (fase 6),
// handmatig geschreven in de stem en volgens de regels van de generator, en gecontroleerd met diezelfde
// regels (schema's, editieregels, cijfers uit de feitenbank, grenzen, teaser, social 2.0).
//   node docs/contentmachine/v2/demo/bouw-demo.mjs            → enkel controleren
//   node docs/contentmachine/v2/demo/bouw-demo.mjs --schrijf  → ook de JSON-bestanden schrijven
// De rijen in content_drops (status 'gegenereerd', NIET gepubliceerd) komen uit die JSON-bestanden.
import { writeFileSync } from 'node:fs';
const R = new URL('../../../../', import.meta.url).pathname;
const RG = await import(R + 'api/_lib/contentmachine-regie.js');
const G = await import(R + 'api/_lib/contentmachine-generator.js');
const S = await import(R + 'api/_lib/contentmachine-social.js');
const NB = await import(R + 'api/_lib/nieuwsbrief-render.js');
const W = await import(R + 'api/_lib/weekeditie.js');

const A = {
  chart: '266f71e7-ee79-4fef-a209-eab4e1fa33f7', zaal: 'c0902297-a369-4f49-a157-9e47713fe6ea',
  karl: '4ca54f25-0c95-43dc-bb39-c0a7ccb70155', leslie6721: '6cda51cf-32ad-431a-af01-0f2480e4874c', shani: 'ef0b94d7-7916-4c23-aa94-4f8582400467',
  maximTG: '63ad070a-cd5b-4020-aa3e-6e0a74416aee', mentor: '458ca098-f7f0-4685-94d9-1d43f28b3467', eenop: '41878bb3-7e37-41fd-8f59-b840e3cc00ef',
  groep: 'ce6b5f12-d602-46ec-85b0-27d3de53bff1', team: '4ad87bef-5d08-454d-8f66-f178498c4f24',
};
const ASSETS = [
  { id: A.chart, soort: 'chart' }, { id: A.zaal, soort: 'masterclass' }, { id: A.mentor, soort: 'team' }, { id: A.eenop, soort: 'team' }, { id: A.groep, soort: 'team' }, { id: A.team, soort: 'team' },
  { id: A.karl, soort: 'payout', persoon_naam: 'Karl', toestemming_publiek: true, bijschrift: 'Payout Karl — Alpha Capital · 24.580' },
  { id: A.leslie6721, soort: 'payout', persoon_naam: 'Leslie', toestemming_publiek: true, bijschrift: 'Payout Leslie — FTMO · 6.721' },
  { id: A.shani, soort: 'payout', persoon_naam: 'Shani', toestemming_publiek: true, bijschrift: 'Payout Shani — FTMO · 25.016' },
  { id: A.maximTG, soort: 'payout', persoon_naam: 'Maxim', toestemming_publiek: true, bijschrift: 'Payout Maxim — Traders Global · 28.983' },
];

// ── Demo A: training 22/10 (met video) ───────────────────────────────────
const inputA = {
  duur: 2700, kanalen: ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'], vimeo_id: '1238714790', vimeo_hash: '4822ada5ee', start_sec: 600,
  vimeo_url: 'https://player.vimeo.com/video/1238714790?h=4822ada5ee', training_datum: '2026-10-22',
  trade_info: { paar: 'EUR/USD', richting: 'long', uitleg: '15M-long na sweep van de 4-uur lows; entry-zone rond het 71-level en het order block.', resultaat_r: null },
  wat_gebeurde: 'Live training van 22/10. De dollar (DXY) kantelt van bearish naar bullish: op de 4-uur en 1-uur kondigt een inverse fair value gap een mogelijke trendwissel aan. GBP/USD short als lopende trade. EUR/USD 15M long volledig nagelopen: 4-uur fib met fair value gap als volume, sweep van de 4-uur lows, externe/interne sweep en break, 71-level, order block, bijschalen, risk free en break even. Daarna 10+ paren met wat wel of niet valid is. Ook risicomanagement en journalen.',
  nugget: 'Een sweep van een low is geen reden om short te gaan: het is vaak de brandstof voor de beweging de andere kant op.',
  notities: 'Demo-editie 2.0 (fase 6) op basis van de training van 22/10. Niet publiceren.',
  gekozen_asset_ids: [A.chart, A.groep, A.zaal],
};
const regieA = {
  format_key: 'wat_zou_jij_doen',
  kernidee: 'Prijs zakt onder de 4-uur lows. Wie dan short gaat, staat vaak aan de verkeerde kant: op 22/10 werd het juist een long op EUR/USD.',
  rode_draad: 'Eerst zelf kiezen (quiz), dan de replay van het moment, dan de trade stap voor stap, en tot slot rekenen wat één goede trade waard is.',
  nugget: 'Een sweep van een low is brandstof, geen break: pas een body close voorbij het niveau verlegt de structuur.',
  open_lus: 'Prijs zakt onder de 4-uur low. Short of wachten? Het antwoord, en de long die volgde, staan in de weekeditie.',
  thema: 'goud', hero_variant: 'video-poort',
  blokken: [
    { type: 'hero', variant: 'video-poort', waarom: 'De opname is de kern; de poort staat meteen naast de kop.' },
    { type: 'quiz', waarom: 'Eerst zelf beslissen op het moment van de sweep: dat is de open lus van de mail.' },
    { type: 'replay-sweep-bos', waarom: 'Het moment van de week zelf afspelen, kaars per kaars.' },
    { type: 'trade-ontleed', waarom: 'De EUR/USD-long van de training in de DFO-volgorde.' },
    { type: 'mythe-feit', waarom: 'Twee denkfouten die bij deze setup horen.' },
    { type: 'data', variant: 'een', waarom: 'Eén cijfer dat laat zien waarom geduld loont.' },
    { type: 'funded-calculator', waarom: 'Wat hetzelfde rendement betekent op een funded account.' },
    { type: 'citaat', waarom: 'Afsluiten met de regel van de masterclass.' },
    { type: 'cadeau', waarom: 'De volgende stap: een strategiesessie.' },
  ],
  beelden: [{ asset_id: A.chart, waar: 'trade-ontleed' }, { asset_id: A.groep, waar: 'social' }],
  motivatie: 'De vorige edities waren uitleg- en vooruitblik-zwaar; nu begint de bezoeker zelf met kiezen. Thema goud (warm, anders dan nacht), interactie: quiz + replay + calculator.',
};
const paginaA = {
  thema: 'goud',
  seo_titel: 'Short of wachten? — Weekeditie 22/10 | De Forex Opleiding',
  seo_beschrijving: 'Gratis opname van de live training van 22/10: prijs zakt onder de 4-uur lows. Kies zelf, speel de replay af en zie de EUR/USD-long stap voor stap.',
  og_titel: 'Prijs zakt onder de low. Short of wachten?',
  og_beschrijving: 'Kies zelf en speel het moment af. De Weekeditie van 22/10.',
  blokken: [
    { type: 'hero', variant: 'video-poort', props: { eyebrow: 'Gratis opname · Live training 22/10', titel: 'Short of wachten? **Kies zelf.**', intro: 'Op 22/10 zakte prijs onder de **4-uur lows**. Een reflex zegt short. In de live training werd het juist **een long op EUR/USD**, van 4-uur fib tot risk free. Kijk mee en beslis eerst zelf.', feiten: ['45 min live training', '10+ paren besproken', 'Normaal enkel voor studenten'] } },
    { type: 'quiz', props: { eyebrow: 'Wat zou jij doen?', vraag: 'Prijs zakt onder de 4-uur low. Wat doe je?', chart: { richting: 'short', soort: 'sweep' }, opties: ['Meteen short: de low is weg', 'Wachten: is het een sweep of een body close eronder?', 'Long, want het is goedkoop'], antwoord_index: 1, uitleg: 'Een wick onder een low is liquiditeit ophalen, nog geen break. Pas een body close eronder verlegt de structuur. Op 22/10 schoot prijs terug en volgde een structure shift naar boven op de 15M.' } },
    { type: 'replay-sweep-bos', props: { eyebrow: 'Speel het zelf af', titel: 'Sweep of break? **Kaars per kaars.**', intro: 'Druk op afspelen en kies op het moment dat prijs onder de low gaat. De onthulling komt pas daarna.', richting: 'long', scenario: 'sweep', uitleg: 'De wick ging onder de low, maar de body sloot erboven en de kaarsen erna bleven erboven. Dat was een sweep: liquiditeit opgehaald, geen break. Daarna verschoof de 15M-structuur naar boven.' } },
    { type: 'trade-ontleed', props: { eyebrow: 'De trade ontleed', titel: 'EUR/USD long, **in de DFO-volgorde**', paar: 'EUR/USD', richting: 'long', beeld_asset_id: A.chart, stappen: [
      { fase: 'context', titel: 'De 4-uur bepaalt de richting', tekst: 'Op de 4-uur trekken we de fib over een geldige impuls, met de fair value gap als volume. De 71 is enkel locatie.' },
      { fase: 'liquidity', titel: 'Sweep van de 4-uur lows', tekst: 'Prijs haalt de lows weg met een wick. Geen body close eronder: dit is liquiditeit, geen break.' },
      { fase: 'shift', titel: 'Structure shift op de 15M', tekst: 'Na de externe en interne sweep volgt een break naar boven met een body close. Nu pas is er een 15M-impuls.' },
      { fase: 'entry', titel: 'Entry op de 71 van de 15M', tekst: 'De entry-zone ligt op het 71-level van de nieuwe impuls, samen met het order block. Bijschalen kan op het tweede niveau.' },
      { fase: 'beheer', titel: 'Risk free en break even', tekst: 'Zodra prijs ver genoeg loopt, gaat de stop naar risk free. Zo kan de trade nog enkel winst of nul opleveren.' },
    ] } },
    { type: 'mythe-feit', props: { items: [
      { mythe: 'Prijs gaat onder de low, dus de trend is gebroken.', feit: 'Een wick onder de low is een sweep. Een structure break vraagt een body close voorbij het niveau, en zelfs dan is het geen automatische entry.' },
      { mythe: 'Hoe sneller je instapt, hoe beter je prijs.', feit: 'Wie wacht op de 15M-bevestiging, mist soms de eerste pips maar vermijdt de trades die nooit geldig waren.' },
    ] } },
    { type: 'data', variant: 'een', props: { eyebrow: 'Waarom geduld loont', titel: 'Quitte vanaf **24% winrate**', cijfers: [{ waarde: 24, suffix: '%', label: 'winrate waarop je quitte speelt', context: 'Bij een gemiddelde winnende trade van 3,17R, zoals in het journal van onze studenten.', bron: 'feitenbank · journal DFO-platform' }] } },
    { type: 'funded-calculator', props: { start_account: 100000, start_rendement: 2, referentie: { label: 'Mediaanstudent · 4,15%', rendement: 4.15 } } },
    { type: 'citaat', props: { tekst: 'Je hoeft geen gelijk te hebben. **Je moet groot winnen als je gelijk hebt.**', wie: 'Uit de masterclass' } },
    { type: 'cadeau', props: {} },
  ],
};
const teaserA = {
  onderwerpen: ['Prijs zakt onder de low. Short?', 'De reflex die je deze week geld kost', 'Kies zelf: sweep of break'],
  preheader: 'Kies eerst zelf, speel daarna het moment van 22/10 af.',
  opener: 'Hoi, in de live training van 22/10 zakte prijs onder de 4-uur lows. Op dat moment roept alles in je hoofd: short, de low is weg. Toch werd het een long op EUR/USD, van de 4-uur fib tot risk free. **Het verschil zat in één kaars**, en die kaars kan je nu zelf afspelen voordat je ziet wat er gebeurde.',
  nugget: { kicker: 'De nugget van de week', titel: 'Een sweep is brandstof, geen break.', tekst: 'Een wick onder een low haalt liquiditeit op. Pas een body close voorbij het niveau verlegt de structuur. Wie op de wick short gaat, levert vaak precies de brandstof voor de beweging naar boven, en ziet zijn stop geraakt worden net voor prijs vertrekt.' },
  beeld_blok_index: 2,
  open_lus: { kicker: 'Wat zou jij doen?', vraag: 'Prijs zakt onder de 4-uur low. Short of wachten?', tekst: 'Kies op de pagina vóór de onthulling. Daarna zie je de long die volgde, stap voor stap.' },
  ps: 'Deze week krijg je er een gratis strategiesessie met Dave bij: t.w.v. €100, nu €0. Je plant hem op de pagina.',
};
const socialA = {
  stories: [
    { rol: 'hook', variant: 'donker', eyebrow: 'Live training 22/10', titel: 'Prijs zakt onder de low. **Short?**', tekst: 'Kies voor je verder tikt.' },
    { rol: 'nugget', variant: 'licht', eyebrow: 'De nugget', titel: 'Een sweep is **brandstof**, geen break.', tekst: 'Pas een body close verlegt de structuur.' },
    { rol: 'bewijs', variant: 'kaart', eyebrow: 'Speel het zelf af', titel: 'Het moment van **22/10**', tekst: 'Kaars per kaars, met de onthulling erna.', blok_index: 2 },
    { rol: 'cta', variant: 'donker', eyebrow: 'Nu online', titel: 'De volledige **weekeditie**', tekst: 'Opname, replay en de trade ontleed.', sticker_tekst: 'Lees de weekeditie' },
  ],
  post: {
    slides: [
      { variant: 'licht', eyebrow: 'Wat zou jij doen?', titel: 'Prijs zakt onder de low. **Short of wachten?**', tekst: 'Swipe pas als je gekozen hebt.' },
      { variant: 'donker', eyebrow: 'Het moment', titel: 'Een wick onder de 4-uur **lows.**', tekst: 'Geen body close eronder. De reflex zegt toch short.' },
      { variant: 'kaart', eyebrow: 'Sweep of break?', titel: 'Speel het **zelf** af', tekst: 'Op de pagina, kaars per kaars.', blok_index: 2 },
      { variant: 'foto', eyebrow: 'In de live training', titel: 'Het werd **een long.**', tekst: 'EUR/USD, van de 4-uur fib tot risk free.', beeld_asset_id: A.groep },
      { variant: 'data', eyebrow: 'Waarom geduld loont', titel: 'Quitte vanaf deze **winrate**', tekst: 'Bij gemiddeld 3,17R per winnende trade.', getal: { waarde: 24, suffix: '%', decimalen: 0, label: 'winrate' } },
      { variant: 'donker', eyebrow: 'Nu online', titel: 'De volledige **weekeditie.**', tekst: 'Gratis opname, replay en de trade ontleed.' },
    ],
    caption: 'Prijs zakt onder de 4-uur low. Short of wachten?\n\nIn de live training van 22/10 werd het juist een long op EUR/USD. Het verschil zat in één kaars: een wick onder de low is een sweep, geen break.\n\nKies zelf en speel het moment af in de weekeditie.',
    hashtags: ['forex', 'trading', 'priceaction'],
  },
  vierkant: { variant: 'licht', eyebrow: 'Weekeditie 22/10', titel: 'Een sweep is **geen break.**', tekst: 'Kies zelf en speel het moment af.' },
  linkedin: {
    tekst: 'Prijs zakt onder een belangrijke low. Wat doe je?\n\nIn onze live training van 22/10 was dat precies het moment. De reflex zegt: de low is gebroken, dus short. Toch werd het een long op EUR/USD.\n\nHet verschil zat in één kaars. Een wick onder een low haalt liquiditeit op; pas een body close voorbij het niveau verlegt de structuur. Wie op de wick instapt, levert vaak de brandstof voor de beweging de andere kant op.\n\nDaarom leren we onze studenten eerst te wachten op bevestiging op de 15M, en pas dan te zoeken naar een entry op de 71 van de nieuwe impuls.\n\nIn de weekeditie kan je het moment zelf afspelen en zie je de trade stap voor stap.',
    hashtags: ['trading', 'forex'],
    beeld: { variant: 'foto', eyebrow: 'De Weekeditie', titel: 'Wachten is ook **een beslissing.**', tekst: 'Het moment van 22/10, stap voor stap.', beeld_asset_id: A.groep },
  },
};

// ── Demo B: update zonder video (payouts) ─────────────────────────────────
const inputB = {
  kanalen: ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'],
  wat_gebeurde: 'Geen live training deze week. Wel een week met bewijs: payouts van studenten die het proces volgden (met hun toestemming), en vragen over hoe groot je risico per trade mag zijn. We tonen de vaste DFO-volgorde en rekenen voor waarom 1% risico per trade-idee het verschil maakt.',
  nugget: 'Je risico bepaal je vóór je instapt: waar de setup ongeldig wordt, ligt je stop, en die afstand bepaalt je positie.',
  notities: 'Demo-editie 2.0 zonder video (fase 6). Niet publiceren.',
  gekozen_asset_ids: [A.shani, A.karl, A.maximTG, A.leslie6721, A.team, A.eenop, A.mentor, A.groep],
};
const regieB = {
  format_key: 'het_bewijs',
  kernidee: 'Payouts van studenten zijn het gevolg van een proces, niet van geluk: een vaste volgorde, 1% risico per trade-idee en een journal.',
  rode_draad: 'Eerst het grote getal, dan de payouts zelf, dan het verhaal erachter, dan zelf rekenen en de volgorde doorlopen.',
  nugget: 'Je stop bepaalt je positie, niet andersom.',
  open_lus: 'Wat hebben deze payouts gemeen? Het antwoord staat in de weekeditie.',
  thema: 'data', hero_variant: 'groot-getal',
  blokken: [
    { type: 'hero', variant: 'groot-getal', waarom: 'Eén groot echt cijfer trekt de aandacht.' },
    { type: 'payout-muur', waarom: 'Het bewijs zelf, met toestemming.' },
    { type: 'verhaal', waarom: 'Wat erachter zit: het proces.' },
    { type: 'rr-sliders', waarom: 'Zelf rekenen met winrate en R.' },
    { type: 'trechter', waarom: 'De vaste volgorde, stap voor stap.' },
    { type: 'tip', waarom: 'De nugget van de week.' },
    { type: 'vooruitblik', waarom: 'Wat we volgende week volgen.' },
    { type: 'fotostrip', waarom: 'Wie erachter zit.' },
    { type: 'inschrijven', waarom: 'Elke week de editie in je mailbox.' },
    { type: 'cadeau', waarom: 'De volgende stap.' },
  ],
  beelden: [{ asset_id: A.shani, waar: 'payout-muur' }, { asset_id: A.karl, waar: 'payout-muur' }, { asset_id: A.maximTG, waar: 'payout-muur' }, { asset_id: A.leslie6721, waar: 'payout-muur' }],
  motivatie: 'Geen video deze week: dan draagt het bewijs de editie. Thema data (donker raster), hero groot-getal; interactie: sliders + trechter.',
};
const paginaB = {
  thema: 'data',
  seo_titel: 'Bewijs, geen beloftes — Weekeditie | De Forex Opleiding',
  seo_beschrijving: 'Payouts van studenten, met hun toestemming, en het proces erachter: een vaste volgorde en 1% risico per trade-idee. Reken zelf mee.',
  og_titel: 'Bewijs, geen beloftes.',
  og_beschrijving: 'Payouts van studenten en het proces erachter. De Weekeditie.',
  blokken: [
    { type: 'hero', variant: 'groot-getal', props: { eyebrow: 'Het bewijs', titel: 'Bewijs, **geen beloftes.**', intro: 'In de masterclass tonen we echte uitbetalingen, van eigen accounts en van studenten. Deze week: **wat ze gemeen hebben**, en waarom dat meer zegt dan het bedrag.', getal: { waarde: 138695, prefix: '€', label: 'aan uitbetalingen, van vijf mensen', context: 'Echte uitbetalingen uit de masterclass, bedragen in € en $ samengeteld. Geen totaal van alle studenten.', bron: 'feitenbank · masterclass' } } },
    { type: 'payout-muur', props: { eyebrow: 'Met hun toestemming', titel: 'Payouts op **één muur**', payouts: [
      { asset_id: A.maximTG, bedrag: 28983, valuta: '$', label: 'Maxim · Traders Global' },
      { asset_id: A.shani, bedrag: 25016, valuta: '$', label: 'Shani · FTMO' },
      { asset_id: A.karl, bedrag: 24580, valuta: '$', label: 'Karl · Alpha Capital' },
      { asset_id: A.leslie6721, bedrag: 6721, valuta: '$', label: 'Leslie · FTMO' },
    ] } },
    { type: 'verhaal', props: { eyebrow: 'Wat erachter zit', titel: 'Geen geluk, **een proces**', tekst: 'Wat deze payouts gemeen hebben, is niet het bedrag. Het is de manier van werken: **één vaste volgorde**, 1% risico per trade-idee en een journal dat ze elke week openleggen met hun mentor.\n\nResultaten uit het verleden zijn geen garantie voor de toekomst. Traden houdt risico op verlies in. Daarom begint alles bij je risico, niet bij het bedrag.' } },
    { type: 'rr-sliders', props: { eyebrow: 'Reken zelf mee', titel: 'Je hoeft niet vaak te winnen. **Je winners moeten groter zijn.**', start_winrate: 30, start_rr: 3, voorinstellingen: [{ label: 'Masterclass · 30% × 3R', winrate: 30, rr: 3 }, { label: 'Onze studenten · 48,5% × 3,17R', winrate: 48.5, rr: 3.17 }] } },
    { type: 'trechter', props: { eyebrow: 'De vaste volgorde', titel: 'Van de grote lijn **tot de entry**', stappen: [
      { label: 'H4-context', titel: 'Richting en locatie', tekst: 'Een geldige impuls op de 4-uur, met de fib erover. De 71 is enkel locatie.' },
      { label: '15M', titel: 'Wachten op bevestiging', tekst: 'Liquidity, een structure shift met een body close en een nieuwe impuls in de richting van de 4-uur.' },
      { label: 'Entry', titel: 'De 71 van de 15M-impuls', tekst: 'Entry op de 71, stop onder of boven de 1, risk free op de 0, target op de −27.' },
      { label: 'Risico', titel: '1% per trade-idee', tekst: 'Mag 0,5% op het fib-niveau en 0,5% op het order block. Elk verlies is even groot.' },
    ] } },
    { type: 'tip', props: { voorkant: 'Je stop bepaalt je positie. **Niet andersom.**', achterkant: 'Waar de setup structureel ongeldig wordt, ligt je stop. Die afstand, samen met 1% risico, bepaalt hoe groot je positie is. Zo kost elk verlies evenveel en blijf je lang genoeg in het spel om je edge te laten spelen.' } },
    { type: 'vooruitblik', props: { intro: 'Wat we volgende week in het oog houden. Geen zekerheden, wel scenario\'s.', paren: [
      { paar: 'DXY', bias: 'bullish', zin: 'Als de 4-uur boven de laatste low blijft, volgen we de kanteling verder.' },
      { paar: 'EUR/USD', bias: 'bearish', zin: 'Bij een sterke dollar zoeken we shorts vanaf een geldige 4-uur-zone.' },
      { paar: 'XAU/USD', bias: 'neutraal', zin: 'Eerst een sweep van een kant van de range, dan pas een idee.' },
    ] } },
    { type: 'fotostrip', props: { titel: 'Wie er **achter zit**', fotos: [
      { asset_id: A.team, bijschrift: 'Het team' }, { asset_id: A.eenop, bijschrift: 'Eén-op-één met een mentor' }, { asset_id: A.mentor, bijschrift: 'Samen de chart openleggen' }, { asset_id: A.groep, bijschrift: 'Groepssessie op kantoor' },
    ] } },
    { type: 'inschrijven', props: { intro: 'Elke week deze editie in je mailbox: de analyse, het bewijs en een tool om zelf mee te rekenen.' } },
    { type: 'cadeau', props: {} },
  ],
};
const teaserB = {
  onderwerpen: ['Bewijs, geen beloftes', 'Wat deze vier payouts gemeen hebben', 'Je stop bepaalt je positie'],
  preheader: 'Payouts van studenten, en het proces erachter.',
  opener: 'Hoi, deze week geen live training, wel iets om bij stil te staan. Op de weekeditie staan vier payouts van mensen uit onze community, met hun toestemming. **Wat ze gemeen hebben, is niet het bedrag.** Het is de manier waarop ze werken, week na week, ook in de weken dat het niet loopt zoals ze willen.',
  nugget: { kicker: 'De nugget van de week', titel: 'Je stop bepaalt je positie. Niet andersom.', tekst: 'Waar de setup structureel ongeldig wordt, ligt je stop. Die afstand, samen met 1% risico per trade-idee, bepaalt hoe groot je positie is. Zo kost elk verlies evenveel, en blijf je lang genoeg in het spel om je edge te laten spelen.' },
  beeld_blok_index: 3,
  open_lus: { kicker: 'Reken zelf mee', vraag: 'Hoe vaak moet je winnen om winstgevend te zijn?', tekst: 'Minder vaak dan je denkt. Schuif zelf met de winrate en de R in de weekeditie.' },
  ps: 'Wil je dit samen bekijken? Je krijgt een gratis strategiesessie met Dave: t.w.v. €100, nu €0. Je plant hem op de pagina.',
};
const socialB = {
  stories: [
    { rol: 'hook', variant: 'data', eyebrow: 'Het bewijs', titel: 'Aan **uitbetalingen**', tekst: 'Van vijf mensen, uit de masterclass.', getal: { waarde: 138695, prefix: '€', decimalen: 0, label: 'aan uitbetalingen' } },
    { rol: 'nugget', variant: 'donker', eyebrow: 'De nugget', titel: 'Je stop bepaalt je positie. **Niet andersom.**', tekst: '1% risico per trade-idee.' },
    { rol: 'bewijs', variant: 'kaart', eyebrow: 'Met toestemming', titel: 'Payouts op **één muur**', blok_index: 1 },
    { rol: 'cta', variant: 'licht', eyebrow: 'Nu online', titel: 'De volledige **weekeditie**', tekst: 'Het bewijs en het proces erachter.', sticker_tekst: 'Lees de weekeditie' },
  ],
  post: {
    slides: [
      { variant: 'data', eyebrow: 'Het bewijs', titel: 'Aan uitbetalingen, **van vijf mensen**', tekst: 'Uit de masterclass. Geen totaal van alle studenten.', getal: { waarde: 138695, prefix: '€', decimalen: 0, label: 'aan uitbetalingen' } },
      { variant: 'kaart', eyebrow: 'Met hun toestemming', titel: 'Payouts op **één muur**', tekst: 'Wat ze gemeen hebben, is niet het bedrag.', blok_index: 1 },
      { variant: 'licht', eyebrow: 'Stap 1', titel: 'Eén **vaste volgorde.**', tekst: 'Van de 4-uur-context tot de entry op de 15M.' },
      { variant: 'donker', eyebrow: 'Stap 2', titel: '1% risico **per trade-idee.**', tekst: 'Elk verlies is even groot.' },
      { variant: 'foto', eyebrow: 'Stap 3', titel: 'Een journal, **elke week open.**', tekst: 'Samen met hun mentor.', beeld_asset_id: A.eenop },
      { variant: 'donker', eyebrow: 'Nu online', titel: 'Reken zelf mee in de **weekeditie.**', tekst: 'Het bewijs en het proces erachter.' },
    ],
    caption: 'Bewijs, geen beloftes.\n\nVier payouts van mensen uit onze community, met hun toestemming. Wat ze gemeen hebben, is niet het bedrag: een vaste volgorde, 1% risico per trade-idee en een journal dat ze elke week openleggen.\n\nResultaten uit het verleden zijn geen garantie voor de toekomst. Het volledige verhaal, en een tool om zelf mee te rekenen, staat in de weekeditie.',
    hashtags: ['forex', 'trading', 'propfirm'],
  },
  vierkant: { variant: 'kaart', eyebrow: 'De Weekeditie', titel: 'Bewijs, **geen beloftes.**', blok_index: 1 },
  linkedin: {
    tekst: 'Een payout zegt weinig. Het proces erachter zegt alles.\n\nDeze week staan op onze weekeditie vier uitbetalingen van mensen uit onze community, met hun toestemming. Wat ze gemeen hebben, is niet het bedrag.\n\nHet is een vaste volgorde: van de context op de 4-uur tot een bevestigde entry op de 15M. Het is 1% risico per trade-idee, zodat elk verlies even groot is. En het is een journal dat ze elke week openleggen met hun mentor.\n\nResultaten uit het verleden zijn geen garantie voor de toekomst, en traden houdt risico op verlies in. Juist daarom begint alles bij je risico, niet bij het bedrag.\n\nIn de weekeditie kan je zelf rekenen met winrate en R.',
    hashtags: ['trading', 'risicomanagement'],
    beeld: { variant: 'data', eyebrow: 'Het bewijs', titel: 'Aan uitbetalingen, **van vijf mensen**', tekst: 'Uit de masterclass.', getal: { waarde: 138695, prefix: '€', decimalen: 0, label: 'aan uitbetalingen' } },
  },
};

// Zoals verbodenNamenUit() het op 26 okt bepaalde: teamnamen, behalve wie met toestemming op een
// payout in de bibliotheek staat (Karl) en Dave/Maxim.
const GEGENEREERD_OP = '2026-10-26T14:00:00.000Z';
export const VERBODEN = ['Chesney', 'Danny', 'Jeffrey', 'Kjento', 'Muddasir', 'Ricardo', 'Rogier', 'Romy', 'Seppe'];

function maak(slug, datum, soort, input, regie, pagina, teaser, social, vorige) {
  const drop = { slug, datum, soort };
  let output = { versie: 2, format_key: regie.format_key, kernidee: regie.kernidee, regie: { ...regie, model: 'handmatig (demo fase 6)', herstel: false }, pagina, nieuwsbrief: teaser, ...social };
  output = G.metVasteTeksten(output, { drop, input });
  output.titel = W.editieTitel(output.pagina);
  const metVideo = !!input.vimeo_id;
  const v = RG.valideerV2(output, { metVideo, assets: ASSETS, vorige, regie, input });
  const g = G.controleerGrenzen((({ meta, regie, ...x }) => x)(output), G.grensOpties(input, VERBODEN));
  const t = NB.teaserFouten(teaser, pagina);
  output.meta = { model: 'handmatig (demo fase 6)', gegenereerd_op: GEGENEREERD_OP, verboden_namen: VERBODEN, waarschuwingen: [] };
  console.log(slug, 'fouten', v.fouten, 'cijfers', v.cijfers, 'grenzen', g.map((x) => x.pad + ' ' + x.regel + ' ' + x.fragment), 'teaser', t, 'woorden', NB.teaserWoorden(teaser), 'combi', JSON.stringify(W.combinatie(pagina)), S.socialCombinatie(output));
  return { slug, datum, soort, status: 'gegenereerd', format_key: regie.format_key, input, output };
}
export const a = maak('22-10-26-demo2', '2026-10-22', 'training', inputA, regieA, paginaA, teaserA, socialA, []);
export const b = maak('26-10-26-demo', '2026-10-26', 'update', inputB, regieB, paginaB, teaserB, socialB, [{ slug: a.slug, output: a.output }]);
if (process.argv.includes('--schrijf')) writeFileSync(R + 'docs/contentmachine/v2/demo/demo-22-10-26-demo2.json', JSON.stringify(a, null, 2) + '\n');
if (process.argv.includes('--schrijf')) writeFileSync(R + 'docs/contentmachine/v2/demo/demo-26-10-26-demo.json', JSON.stringify(b, null, 2) + '\n');
