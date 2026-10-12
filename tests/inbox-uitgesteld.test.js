// tests/inbox-uitgesteld.test.js
//
// Het uitgestelde versturen, en vooral: het ding dat nooit mag gebeuren.
//
// ── WAAR HET OM DRAAIT ───────────────────────────────────────────────────────
// Het scherm en de cron kunnen tegelijk besluiten dat een geparkeerd bericht nú
// weg mag. Twee cron-runs kunnen elkaar overlappen. Iemand kan op "Toch niet"
// drukken op precies het moment dat de cron het oppakt.
//
// In al die gevallen moet er PRECIES ÉÉN winnen. Bij een klant met een
// betalingsachterstand is een dubbel bericht niet "een berichtje te veel" maar
// een reden om te twijfelen aan alles wat je stuurt.
//
// De claim-UPDATE is de hele verdediging, en die is hier nagespeeld met een
// database die zich gedraagt zoals Postgres dat doet: een UPDATE met
// voorwaarden raakt nul of één rij, en wie als tweede komt krijgt niets.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Uit de zuivere laag, niet uit inbox-uitgesteld.js: dat bestand importeert de
// databaselaag en valt dan om op een ontbrekende omgevingsvariabele. Derde keer
// dezelfde les in deze bouw, vandaar de vaste regel: wat zuiver kan zijn, staat
// in een bestand dat niets importeert.
import {
  UITSTEL_MS,
  CLAIM_VERVAL_MINUTEN,
  MISLUKT,
  ONBEKEND,
  AANDACHT_STATUSSEN,
  AANDACHT_VENSTER_MS,
  verstuurMoment,
  naarWachtrij,
  uitWachtrij,
} from '../api/_lib/inbox-wachtrij.js';

// ── het moment ──────────────────────────────────────────────────────────────

test('het venster is dertig seconden, niet ongeveer dertig', () => {
  // "Ongeveer" is precies het probleem met een zuivere cron: die draait per
  // minuut, dus het venster zou tussen 30 en 90 seconden liggen. Dan weet je
  // niet wanneer het dicht is, en blijf je ernaar kijken.
  assert.equal(UITSTEL_MS, 30_000);
  const nu = new Date('2026-09-28T10:00:00.000Z');
  assert.equal(verstuurMoment(nu), '2026-09-28T10:00:30.000Z');
});

test('een kapotte klok levert geen bericht op dat nooit vertrekt', () => {
  // Zou verstuur_na onzin worden, dan valt de rij buiten elke opvraging en
  // blijft hij eeuwig staan — het stilste soort storing dat er is.
  for (const rommel of [null, undefined, 'straks', NaN, {}]) {
    const m = verstuurMoment(rommel);
    assert.ok(!Number.isNaN(Date.parse(m)), `${String(rommel)} gaf een ongeldig moment`);
  }
});

// ── heen en terug ───────────────────────────────────────────────────────────

const TEKST = {
  convId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  mode: 'text', text: 'Dag Jan',
  templateName: '', templateLanguage: 'nl', templateVariables: null, templateComponents: [],
  mediaKind: null, mediaLink: '', mediaCaption: '', mediaFilename: '',
};

test('een tekstbericht komt er na parkeren ongeschonden uit', () => {
  // Als hier iets wegvalt, staat er straks iets anders in de wacht dan wat
  // iemand getypt heeft — en dat merkt hij pas als de klant het heeft.
  const heen = naarWachtrij(TEKST, { doorGebruiker: 'u1' });
  const terug = uitWachtrij({ ...heen, conversation_id: TEKST.convId });
  assert.equal(terug.mode, 'text');
  assert.equal(terug.text, 'Dag Jan');
  assert.equal(terug.convId, TEKST.convId);
});

test('een template met variabelen overleeft de wachtrij', () => {
  const tpl = {
    ...TEKST, mode: 'template', text: '',
    templateName: 'herinnering', templateLanguage: 'nl',
    templateVariables: { 1: 'Jan' },
    templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Jan' }] }],
  };
  const terug = uitWachtrij({ ...naarWachtrij(tpl), conversation_id: tpl.convId });
  assert.equal(terug.templateName, 'herinnering');
  assert.deepEqual(terug.templateVariables, { 1: 'Jan' });
  assert.equal(terug.templateComponents.length, 1);
});

test('een bijlage overleeft de wachtrij', () => {
  const doc = {
    ...TEKST, mode: 'document', text: '',
    mediaKind: 'document', mediaLink: 'https://x.nl/a.pdf',
    mediaCaption: 'de factuur', mediaFilename: 'factuur.pdf',
  };
  const terug = uitWachtrij({ ...naarWachtrij(doc), conversation_id: doc.convId });
  assert.equal(terug.mediaKind, 'document');
  assert.equal(terug.mediaLink, 'https://x.nl/a.pdf');
  assert.equal(terug.mediaFilename, 'factuur.pdf');
});

test('een geparkeerd bericht staat op gepland en nog van niemand', () => {
  const rij = naarWachtrij(TEKST, { doorGebruiker: 'u1' });
  assert.equal(rij.status, 'gepland');
  assert.equal(rij.aangemaakt_door, 'u1');
  assert.equal(rij.claimed_at, undefined, 'een verse rij hoort niet geclaimd te zijn');
});

// ── de claim: precies één wint ──────────────────────────────────────────────
//
// Een nagespeelde tabel die zich gedraagt als Postgres: een UPDATE met
// voorwaarden raakt de rij alleen als die voorwaarden nog kloppen, en de tweede
// die komt krijgt nul rijen terug.

function maakTabel(beginrij) {
  const rij = { ...beginrij };
  return {
    rij,
    /** Spiegelt: update ... where id=? and status='gepland' and claimed_at is null */
    claim(door) {
      if (rij.status !== 'gepland' || rij.claimed_at !== null) return null;
      rij.claimed_at = `door:${door}`;
      return { ...rij };
    },
    /** Spiegelt annuleer(): dezelfde voorwaarden. */
    annuleer() {
      if (rij.status !== 'gepland' || rij.claimed_at !== null) return null;
      rij.status = 'geannuleerd';
      return { ...rij };
    },
  };
}

const VERS = { id: 'x', status: 'gepland', claimed_at: null };

test('scherm en cron tegelijk: er vertrekt er precies één', () => {
  const t = maakTabel(VERS);
  const scherm = t.claim('scherm');
  const cron = t.claim('cron');
  const gelukt = [scherm, cron].filter(Boolean);
  assert.equal(gelukt.length, 1, 'twee claims betekent twee berichten bij de klant');
  assert.equal(scherm !== null, true, 'wie als eerste komt, wint');
  assert.equal(cron, null, 'wie als tweede komt, hoort niets te krijgen');
});

test('twee cron-runs tegelijk: er vertrekt er precies één', () => {
  // Een run die uitloopt terwijl de volgende al begint, is op Vercel geen
  // bedenksel maar de normale gang van zaken bij een trage Meta.
  const t = maakTabel(VERS);
  const a = t.claim('cron-a');
  const b = t.claim('cron-b');
  assert.equal([a, b].filter(Boolean).length, 1);
});

test('annuleren ná de claim lukt niet — en dat is met opzet', () => {
  // Op dat moment is het bericht ONDERWEG. Een knop die zegt dat hij het
  // tegenhield terwijl de klant het al heeft, is erger dan een knop die zegt
  // dat het te laat is.
  const t = maakTabel(VERS);
  assert.ok(t.claim('cron'), 'de claim hoort te slagen');
  assert.equal(t.annuleer(), null, 'annuleren hoort te falen zodra hij onderweg is');
  assert.equal(t.rij.status, 'gepland', 'en de status hoort niet stiekem te veranderen');
});

test('annuleren vóór de claim lukt, en dan kan niemand het meer versturen', () => {
  const t = maakTabel(VERS);
  assert.ok(t.annuleer(), 'annuleren hoort te slagen zolang hij stilstaat');
  assert.equal(t.claim('cron'), null, 'een geannuleerd bericht hoort niet alsnog te vertrekken');
});

test('een al verstuurd bericht wordt niet nog eens opgepakt', () => {
  const t = maakTabel({ id: 'x', status: 'verstuurd', claimed_at: 'door:eerder' });
  assert.equal(t.claim('cron'), null);
  assert.equal(t.annuleer(), null);
});

// ── de bedrading ────────────────────────────────────────────────────────────

const LIB = readFileSync(new URL('../api/_lib/inbox-uitgesteld.js', import.meta.url), 'utf8');
const CRON = readFileSync(new URL('../api/cron-inbox-uitgesteld.js', import.meta.url), 'utf8');
const ACTIE = readFileSync(new URL('../api/inbox-uitgesteld.js', import.meta.url), 'utf8');
const PARKEER = readFileSync(new URL('../api/inbox-parkeer.js', import.meta.url), 'utf8');
const VERCEL = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));

test('de claim heeft in de code écht alle drie de voorwaarden', () => {
  // Valt er één weg, dan is de hele verdediging weg en merk je dat pas als een
  // klant twee keer hetzelfde krijgt.
  const i = LIB.indexOf('export async function claim');
  const body = LIB.slice(i, i + 700);
  assert.match(body, /\.eq\('id', id\)/);
  assert.match(body, /\.eq\('status', OPEN_STATUS\)/);
  assert.match(body, /\.is\('claimed_at', null\)/);
});

test('annuleren heeft dezelfde voorwaarden als de claim', () => {
  const i = LIB.indexOf('export async function annuleer');
  const body = LIB.slice(i, i + 800);
  assert.match(body, /\.eq\('status', OPEN_STATUS\)/);
  assert.match(body, /\.is\('claimed_at', null\)/);
});

// ── liever niet dan dubbel ──────────────────────────────────────────────────
//
// Dit is de regel waar deze hele bouw om draait, en de enige die ook bij de
// derde herschrijving niet mag opschuiven: een bericht in onbekende toestand
// wordt NOOIT automatisch opnieuw verstuurd. Van de twee manieren waarop het
// mis kan gaan is er één veel erger dan de andere. Niet verstuurd en luid
// gemeld is binnen een minuut recht te zetten door een mens. Twee keer
// verstuurd naar een klant met een achterstand is niet recht te zetten.

test('een hangende claim wordt AFGESLOTEN, nooit vrijgegeven', () => {
  // Een eerdere versie wiste de claim zodra er geen uitgaand bericht van
  // datzelfde moment in de draad stond. Dat is twee keer gokken in één
  // beweging: een uitgaand bericht van iemand anders leest als "dit is
  // verstuurd", en géén uitgaand bericht sluit niet uit dat de transportlaag
  // het wél aannam en alleen het wegschrijven misging.
  const i = LIB.indexOf('export async function sluitHangendeClaimsAf');
  assert.ok(i > 0, 'de opruimer hoort te bestaan en zo te heten');
  const body = LIB.slice(i, LIB.indexOf('export async function aandachtVoorGesprek'));
  assert.match(body, /status: stand/, 'er hoort een eindstand gezet te worden');
  assert.doesNotMatch(body, /claimed_at: null/,
    'een claim vrijgeven betekent dat het bericht een tweede keer kan vertrekken');
  assert.doesNotMatch(body, /whatsapp_messages/,
    'niet meer gokken op wat er in de draad staat; dat was de fout van de vorige versie');
});

test('nergens in de hele bouw wordt een claim vrijgegeven', () => {
  // Niet alleen in de opruimer: ook geen enkel endpoint en geen cron mag een
  // rij terugzetten naar "nog van niemand". Eén plek is genoeg om de hele
  // verdediging te slopen.
  for (const [naam, src] of [['lib', LIB], ['cron', CRON], ['actie', ACTIE], ['parkeer', PARKEER]]) {
    assert.doesNotMatch(src, /claimed_at: null/, `${naam} geeft een claim vrij`);
  }
});

test('de twee eindstanden hangen aan wat we ZEKER weten, niet aan een vermoeden', () => {
  const i = LIB.indexOf('export async function sluitHangendeClaimsAf');
  const body = LIB.slice(i, LIB.indexOf('export async function aandachtVoorGesprek'));
  // De stempel is het enige bewijs dat telt: hij wordt gezet vóór de
  // transportlaag wordt aangeroepen.
  assert.match(body, /rij\.meta_aangeroepen_op/);
  assert.match(body, /begonnen \? ONBEKEND : MISLUKT/);
  assert.equal(MISLUKT, 'mislukt');
  assert.equal(ONBEKEND, 'onbekend');
});

test('de stempel staat vóór het aanbieden, en blokkeert het aanbieden als hij niet lukt', () => {
  // Zou de stempel ná de aanroep staan, dan dekt hij juist het geval niet
  // waarvoor hij bestaat: dat er daarna niets meer gebeurt.
  for (const [naam, src] of [['cron', CRON], ['actie', ACTIE]]) {
    assert.match(src, /voorAflevering: async \(\) => \{/, naam);
    assert.match(src, /aangeboden = await markeerMetaAangeroepen\(id\);/, naam);
    assert.match(src, /return aangeboden;/, naam + ': false hoort het aanbieden tegen te houden');
  }
  // En de verzendfunctie hoort dat haakje ook écht te respecteren.
  const VERZ = readFileSync(new URL('../api/_lib/inbox-verzenden.js', import.meta.url), 'utf8');
  const i = VERZ.indexOf('export async function verstuurInGesprek');
  const body = VERZ.slice(i);
  const iHaak = body.indexOf('voorAflevering()');
  const iMeta = body.indexOf('leverAfBijMeta(');
  assert.ok(iHaak > 0 && iMeta > iHaak, 'het haakje hoort vóór de aflevering te lopen');
  assert.match(body.slice(iHaak, iMeta), /mag === false/, 'false hoort de aflevering te stoppen');
});

test('na het aanbieden zegt niemand meer "mislukt" — dat zou een zekerheid beweren', () => {
  // 'mislukt' betekent "er is met zekerheid niets vertrokken". Dat na een
  // afgebroken aanroep beweren nodigt iemand uit het nog eens te sturen.
  for (const [naam, src] of [['cron', CRON], ['actie', ACTIE]]) {
    assert.match(src, /if \(geclaimd && !aangeboden\) \{/,
      `${naam} hoort alleen mislukt te melden als er nog niets aangeboden was`);
  }
});

test('een rij die nooit geclaimd werd, is niet van ons om af te sluiten', () => {
  for (const [naam, src] of [['cron', CRON], ['actie', ACTIE]]) {
    assert.match(src, /let geclaimd = false;/, naam);
    assert.match(src, /geclaimd = true;/, naam);
  }
});

test('er is geen actie die een mislukt of onbekend bericht opnieuw laat versturen', () => {
  // Alleen een MENS stuurt dit nog, als nieuw bericht. Een knop "opnieuw" op
  // een onbekende rij is precies de dubbele verzending waar alles hier tegen
  // beschermt.
  const i = ACTIE.indexOf('const ACTIES =');
  const regel = ACTIE.slice(i, ACTIE.indexOf(';', i));
  assert.match(regel, /\['nu', 'annuleer'\]/);
  assert.doesNotMatch(regel, /opnieuw|herkans|retry/i);
});

// ── en het scherm zegt het ──────────────────────────────────────────────────

test('het scherm toont wat er misging, met twee verschillende teksten', () => {
  const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
  assert.match(SCHERM, /function _aandachtBalkHtml\(convId\)/);
  // Twee standen, twee boodschappen. Eén tekst voor allebei zou van 'onbekend'
  // een gewone mislukking maken, en dan stuurt iemand het nog eens.
  assert.match(SCHERM, /Niet zeker of dit vertrok/);
  assert.match(SCHERM, /Dit bericht is niet verstuurd/);
  // De knop vult het veld en verstuurt niets.
  assert.match(SCHERM, /window\.__wbxAandachtTekstTerug = \(id\) => \{/);
  const i = SCHERM.indexOf('window.__wbxAandachtTekstTerug');
  const body = SCHERM.slice(i, SCHERM.indexOf('function _inboxComposeHtml', i));
  assert.doesNotMatch(body, /apiPost|inbox-send|inbox-uitgesteld/,
    'deze knop mag niets versturen; hij vult alleen het veld');
});

test('de aandachtbalk staat er ook als de teller loopt, en vervalt na een etmaal', () => {
  const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
  assert.match(SCHERM, /return aandacht \+ _uitstelBalkHtml\(rest\)/);
  assert.match(SCHERM, /return aandacht \+ `<div style="border-top/);
  // Wat je na een dag nog niet hebt opgepakt, is geen melding meer maar een
  // verwijt. De lijst loopt dus leeg zonder dat iemand iets hoeft weg te
  // klikken — geen extra kolom, geen extra knop.
  assert.equal(AANDACHT_VENSTER_MS, 24 * 60 * 60 * 1000);
  assert.deepEqual([...AANDACHT_STATUSSEN], ['mislukt', 'onbekend']);
  assert.match(LIB, /\.in\('status', AANDACHT_STATUSSEN\)/);
  assert.match(LIB, /\.gte\('afgehandeld_op', sinds\)/);
});

test('de cron draait elke minuut en staat in vercel.json', () => {
  const rij = (VERCEL.crons || []).find((c) => c.path === '/api/cron-inbox-uitgesteld');
  assert.ok(rij, 'zonder regel in vercel.json draait de cron nooit');
  assert.equal(rij.schedule, '* * * * *');
});

test('de cron blijft achter de vlag en achter het cron-geheim', () => {
  assert.match(CRON, /checkCronAuth\(req\)/);
  assert.match(CRON, /if \(!gesprekkenV2Aan\(\)\)/);
});

test('de cron laat één mislukt bericht de rest van de ronde niet blokkeren', () => {
  // De les uit CLAUDE.md: try/catch per item, nooit een early return op één
  // faal-item.
  // Precies de lus afbakenen, niet een blok van zoveel tekens: anders meet je
  // de code eronder mee en betrapt de controle de verkeerde `return`.
  const i = CRON.indexOf('for (const { id } of klaar)');
  const eind = CRON.indexOf("console.log('[cron-inbox-uitgesteld] klaar:", i);
  assert.ok(i > 0 && eind > i, 'de lus hoort vindbaar te zijn');
  // Het haakje voor de stempel is een eigen functie MET een return, en die
  // hoort er te zijn: hij geeft door of het aanbieden mag. Die eerst eruit, want
  // anders meet de controle hieronder de verkeerde return.
  const lus = CRON.slice(i, eind).replace(/voorAflevering: async \(\) => \{[^{}]*\},/s, '<haakje>');
  assert.ok(lus.includes('<haakje>'), 'het haakje hoort in de lus te staan');
  assert.match(lus, /try \{/);
  assert.match(lus, /catch \(e\)/);
  assert.match(lus, /continue;/, 'overslaan hoort met continue, niet met return');
  assert.doesNotMatch(lus, /\breturn\b/,
    'een return in de lus laat de rest van de ronde liggen zonder dat iemand het merkt');
});

test('een mislukking komt met reden in de logs én op de rij', () => {
  // Een teller zonder tekst maakt zoeken in de Vercel-logs onmogelijk.
  assert.match(CRON, /console\.warn\('\[cron-inbox-uitgesteld\] niet verstuurd:'/);
  assert.match(CRON, /markeerMislukt\(id, reden\)/);
  // En een afgesloten hangende claim ook, want dat is het geval dat niemand
  // ziet gebeuren.
  assert.match(LIB, /console\.warn\('\[inbox-uitgesteld\] hangende claim afgesloten als'/);
});

test('parkeren keurt met LETTERLIJK dezelfde keuring als versturen', () => {
  // Iets parkeren dat straks toch geweigerd wordt, levert een bericht op dat
  // dertig seconden hoop geeft en dan alsnog nergens is. Twee plekken die
  // dezelfde vraag stellen, horen hem met dezelfde code te stellen — dus niet
  // "een eigen check die hetzelfde doet", maar keurGesprek() zelf.
  assert.match(PARKEER, /leesVerzendOpdracht\(req\.body\)/);
  assert.match(PARKEER, /getConfigStatus\(\)/);
  assert.match(PARKEER, /keurGesprek\(/);
  // En dus geen eigen module-afleiding meer. Die stond er eerst wél, en keek
  // naar whatsapp_module_config op het nummer alleen — op het hoofdnummer
  // bedient één lijn meerdere modules, dus dat gaf een willekeurige rij terug.
  // Precies de controle die hier de rechtenpoort is.
  assert.doesNotMatch(PARKEER, /from\('whatsapp_module_config'\)/,
    'de module hoort via keurGesprek te komen, die de klant meeneemt');
  assert.match(PARKEER, /module: gekeurd\.convModule/);
});

test('dat het venster hierdoor bij parkeren ook gekeurd wordt, is geen probleem', () => {
  // Een venster dat nu dicht is, is over dertig seconden zeker dicht — dus nu
  // weigeren is beter. Het omgekeerde (nu open, straks dicht) wordt bij het
  // versturen alsnog gezien, want daar draait precies dezelfde keuring nog
  // een keer. Dat tweede is de regel die moet blijven staan.
  assert.match(ACTIE, /verstuurInGesprek\(/);
  const VERZ = readFileSync(new URL('../api/_lib/inbox-verzenden.js', import.meta.url), 'utf8');
  const i = VERZ.indexOf('export async function verstuurInGesprek');
  assert.match(VERZ.slice(i), /keurGesprek\(opdracht, rechten, \{ db \}\)/,
    'het versturen hoort zelf opnieuw te keuren, niet te vertrouwen op het parkeermoment');
});

test('alle drie de endpoints staan achter de vlag', () => {
  for (const [naam, src] of [['parkeer', PARKEER], ['actie', ACTIE], ['cron', CRON]]) {
    assert.match(src, /gesprekkenV2Aan\(\)/, `${naam} hoort achter de vlag te staan`);
  }
});

test('te laat annuleren geeft 409 en geen stille ok', () => {
  assert.match(ACTIE, /status\(409\)/);
  assert.match(ACTIE, /te_laat/);
  assert.match(ACTIE, /al_opgepakt/);
});

test('een claim geldt pas als hangend ruim na de Vercel-tijdslimiet', () => {
  // Een functie mag hooguit 60 s draaien. Zou de grens korter zijn, dan sluiten
  // we rijen af van processen die nog gewoon bezig zijn — en dan staat er een
  // melding in het scherm over een bericht dat even later gewoon vertrekt.
  assert.ok(CLAIM_VERVAL_MINUTEN * 60 > 60, 'de grens hoort ruim boven de 60 s te liggen');
});
