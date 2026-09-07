// tests/softphone-belvenster.test.js
//
// Het belvenster: welke lijn, mag de INVITE weg, en wat is er gebeurd.
//
// Dit is Daves gereedschap — hij belt er de hele dag mee — dus elke regel hier
// staat om een concreet geval uit de historie heen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// HET ECHTE BESTAND DRAAIEN, niet een kopie. belvenster-kern.js is een
// klassiek script (klx-softphone.js is dat ook en kan niet importeren), dus
// het wordt hier uitgevoerd zoals de browser het uitvoert.
const KERN = (() => {
  const ctx = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(readFileSync('modules/shared/belvenster-kern.js', 'utf8'), ctx);
  const k = ctx.window.BelvensterKern;
  assert.ok(k, 'BelvensterKern hoort op window te staan');
  return k;
})();
const {
  kiesLijn, lijnUitleg, beoordeelArmering, bepaalUitkomst,
  ARMEER_MS, AFGEBROKEN_VOOR_INVITE, AFGEBROKEN_VOOR_OPNEMEN,
} = KERN;

// ═══════════════════════════════════════════════════════════════════════════
// DE LIJN KIEST ZICHZELF — geen gemak maar conversie
// ═══════════════════════════════════════════════════════════════════════════

test('een Belgisch nummer krijgt de Belgische lijn', () => {
  for (const n of ['+32473979812', '0032473979812', '32 473 97 98 12']) {
    const k = kiesLijn(n);
    assert.equal(k.lijn, 'be', n);
    assert.equal(k.zeker, true);
  }
});

test('een Nederlands nummer krijgt de Nederlandse lijn', () => {
  for (const n of ['+31612345678', '0031612345678']) {
    assert.equal(kiesLijn(n).lijn, 'nl', n);
  }
});

test('een ander land valt terug op de standaard EN zegt dat', () => {
  const k = kiesLijn('+4915112345678');
  assert.equal(k.lijn, 'nl');
  assert.equal(k.zeker, false, 'dit is een terugval, geen keuze');
  assert.match(lijnUitleg(k), /standaardlijn/i);
  assert.match(lijnUitleg(k), /Pas aan/, 'de gebruiker moet weten dat hij moet kijken');
});

test('een lokaal nummer zonder landcode is GEEN zekerheid', () => {
  // 0612… kan Nederlands zijn, maar dat weten we niet uit het nummer.
  const k = kiesLijn('0612345678');
  assert.equal(k.zeker, false);
  assert.match(lijnUitleg(k), /zonder landcode/);
});

test('bij een zekere keuze staat er waarop hij gekozen is', () => {
  assert.match(lijnUitleg(kiesLijn('+32473979812')), /Belgische lijn gekozen op \+32/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE ARMEERPERIODE — wie meteen afdrukt, belt niemand
// ═══════════════════════════════════════════════════════════════════════════
// Maxim: 'als ik op bel druk en meteen neerleg, krijgt de persoon toch de
// telefoon te horen'. Binnen dit venster gaat er geen INVITE de deur uit, en
// dan rinkelt er niets.

test('binnen het venster gaat er GEEN invite uit', () => {
  const r = beoordeelArmering({ gestartMs: 1000, nuMs: 1200, afgebroken: false });
  assert.equal(r.invite, false);
  assert.equal(r.actie, 'wachten');
  assert.ok(r.resterend > 0);
});

test('afbreken binnen het venster stuurt nooit een invite', () => {
  const r = beoordeelArmering({ gestartMs: 1000, nuMs: 1200, afgebroken: true });
  assert.equal(r.invite, false);
  assert.equal(r.actie, 'afbreken');
});

test('na het venster gaat de invite wel weg', () => {
  const r = beoordeelArmering({ gestartMs: 1000, nuMs: 1000 + ARMEER_MS, afgebroken: false });
  assert.equal(r.invite, true);
});

test('het venster is kort genoeg om niet als vertraging te voelen', () => {
  // Onder de 400 ms vangt hij de meeste misgrepen niet; boven de 1000 ms denkt
  // een gewone beller dat het scherm hangt.
  assert.ok(ARMEER_MS >= 400 && ARMEER_MS <= 1000, 'ARMEER_MS = ' + ARMEER_MS);
});

// ═══════════════════════════════════════════════════════════════════════════
// WAT ER GEBEURDE — feiten uit het moment, geen gok op een duur
// ═══════════════════════════════════════════════════════════════════════════

test('afgebroken vóór de invite levert GEEN rij en GEEN poging op', () => {
  const r = bepaalUitkomst({ inviteVerstuurd: false, opgenomen: false, doorOns: true });
  assert.equal(r.outcome, AFGEBROKEN_VOOR_INVITE);
  assert.equal(r.logboek, false, 'er is niets gebeurd om te loggen');
  assert.equal(r.telt_als_poging, false);
});

test('afgebroken NA de invite is een uitspraak over ONS, niet over de lead', () => {
  // Dit is de kern van Maxims tweede bezwaar: zo'n rij stond als 'niet
  // opgenomen' en dat is een oordeel over de lead terwijl wij afbraken.
  const r = bepaalUitkomst({ inviteVerstuurd: true, opgenomen: false, doorOns: true });
  assert.equal(r.outcome, AFGEBROKEN_VOOR_OPNEMEN);
  assert.notEqual(r.outcome, 'no_answer');
  assert.equal(r.logboek, true, 'het toestel heeft wél gerinkeld, dus vastleggen');
  assert.equal(r.telt_als_poging, false, 'maar het telt niet als belpoging');
});

test('de lead die echt niet opneemt blijft gewoon niet opgenomen', () => {
  const r = bepaalUitkomst({ inviteVerstuurd: true, opgenomen: false, doorOns: false });
  assert.equal(r.outcome, 'no_answer');
  assert.equal(r.telt_als_poging, true);
});

test('opgenomen is opgenomen, ook als wij ophangen', () => {
  const r = bepaalUitkomst({ inviteVerstuurd: true, opgenomen: true, doorOns: true });
  assert.equal(r.outcome, 'answered');
  assert.equal(r.telt_als_poging, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN DREMPEL OP DUUR — de correctie op de eerste meting
// ═══════════════════════════════════════════════════════════════════════════

test('nergens in de kern staat een grens op de duur van een call', () => {
  // De regel 'korter dan drie seconden is een misgreep' houdt geen stand: bij
  // drie van de negen korte calls volgt binnen minuten een echt gesprek. Zo'n
  // drempel zou precies het herbelgedrag afpakken dat werkt.
  const bron = readFileSync('modules/shared/belvenster-kern.js', 'utf8')
    .replace(/\/\/[^\n]*/g, '');   // commentaar eruit; daar mág het over gaan
  assert.doesNotMatch(bron, /duur_sec/, 'de uitkomst hangt niet aan een duur');
  assert.doesNotMatch(bron, /\bseconden?\b/i);
  // bepaalUitkomst kent het begrip duur niet eens.
  assert.equal(bepaalUitkomst.length, 1, 'één argument-object, en daar zit geen duur in');
  const zelfde = bepaalUitkomst({ inviteVerstuurd: true, opgenomen: false, doorOns: false });
  assert.equal(zelfde.outcome, 'no_answer', 'ongeacht hoe lang hij duurde');
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP HET PAD DAT ECHT GELOPEN WORDT
// ═══════════════════════════════════════════════════════════════════════════

test('een afgebroken call wordt geen "niet opgenomen" in de pogingenrij', async () => {
  const { bouwCallPoging } = await import('../api/_lib/opvolging-call-link.js');
  const rij = bouwCallPoging({ taakId: 't', outcomeHint: 'afgebroken_voor_opnemen', durationSec: 2 });
  assert.equal(rij.resultaat, 'afgebroken voor opnemen');
  assert.notEqual(rij.resultaat, 'niet opgenomen');
});

test('een call die nooit verstuurd is levert helemaal geen rij op', async () => {
  const { bouwCallPoging } = await import('../api/_lib/opvolging-call-link.js');
  assert.equal(bouwCallPoging({ taakId: 't', outcomeHint: 'afgebroken_voor_invite' }), null);
});

test('de echte no_answer blijft gewoon niet opgenomen', async () => {
  const { bouwCallPoging } = await import('../api/_lib/opvolging-call-link.js');
  assert.equal(bouwCallPoging({ taakId: 't', outcomeHint: 'no_answer' }).resultaat, 'niet opgenomen');
});

test('de classificatie telt een afgebroken call niet als contact en niet als gemist', async () => {
  const m = await import('../api/_lib/opvolging-poging-telling.js');
  const p = { soort: 'call', richting: 'uit', resultaat: 'afgebroken voor opnemen' };
  assert.equal(m.classificeerResultaat(p.resultaat), m.AFGEBROKEN);
  assert.equal(m.isContact(p), false);
  assert.notEqual(m.classificeerResultaat(p.resultaat), m.NIET_OPGENOMEN,
    'het is geen uitspraak over de lead');
});

test('het endpoint accepteert de nieuwe uitkomst', () => {
  const bron = readFileSync('api/softphone-call-log.js', 'utf8');
  const set = bron.match(/const OUTCOMES = new Set\(\[[^\]]*\]\)/)[0];
  assert.match(set, /'afgebroken_voor_opnemen'/);
});

test('de softphone armeert vóór de INVITE en primet de beltoon op de klik', () => {
  const bron = readFileSync('modules/shared/klx-softphone.js', 'utf8');
  const i = bron.indexOf('DE ARMEERPERIODE');
  assert.ok(i > 0, 'de armeerperiode hoort te bestaan');
  const j = bron.indexOf('await inviter.invite()', i);
  assert.ok(j > i, 'en vóór de invite te staan');
  const blok = bron.slice(i, j);
  assert.match(blok, /ringback\.primen\(\)/, 'de beltoon wordt in de klik geprimed');
  // OP HET MECHANISME, niet op het woord. Een eerdere versie van deze test
  // zocht naar 'afgebroken' ergens in het blok — dan overleeft het weghalen
  // van de wachttijd én van de uitgang de test, want die woorden staan ook in
  // het commentaar. Twee sabotages kwamen er zo ongestraft doorheen.
  assert.match(blok, /await new Promise\(\(r\) => setTimeout\(r, ARMEER_MS\)\)/,
    'er hoort echt gewacht te worden vóór de invite');
  assert.match(blok, /if \(state\.armeren\?\.afgebroken\) \{[\s\S]*?return \{ ok: false, afgebroken_voor_invite: true \};/,
    'en wie binnen dat venster afbreekt hoort eruit te stappen zonder invite');
  // De volgorde: eerst wachten, dan pas de uitgang toetsen, dan pas de invite.
  assert.ok(blok.indexOf('setTimeout(r, ARMEER_MS)') < blok.indexOf('state.armeren?.afgebroken'),
    'eerst wachten, dan pas kijken of er is afgebroken');
});

test('de kern wordt vóór de softphone geladen, overal waar hij gebruikt wordt', () => {
  for (const p of ['modules/klanten-v2/index.html', 'modules/klanten.html']) {
    const h = readFileSync(p, 'utf8');
    const kern = h.indexOf('belvenster-kern.js');
    const soft = h.indexOf('klx-softphone.js');
    assert.ok(kern > 0, p + ' laadt de kern niet');
    assert.ok(kern < soft, p + ' laadt de kern NA de softphone');
  }
});
