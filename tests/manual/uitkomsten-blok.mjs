/**
 * De uitkomsten in "Event afronden" na stap 2 — rendercontrole.
 *
 * WAAROM DIT GEEN GEWONE TEST IS
 * Dezelfde reden als bij afwezig-blok.mjs: deze functies leven in de IIFE van
 * events-v2.js en worden niet geëxporteerd. Dit script vist ze met hun
 * constanten uit de broncode en voert ze uit. Dat breekt bij een
 * herformattering, en dan is het een valse rode in `npm test`.
 *
 * WAT HET CONTROLEERT
 * Dat "Twijfelt nog" als knop verdwenen is en "Opvolgen" is hernoemd naar
 * "Wil nog beslissen", dat de andere drie uitkomsten ongemoeid zijn, dat het
 * standaard-belmoment op twee dagen staat, en dat het redenblok bij "Geen
 * interesse" alle elf bezwaren toont, niets voorselecteert, en zichtbaar zegt
 * dat je zonder reden niet kunt afronden.
 *
 * DRAAIEN (vanuit de hoofdmap van de repo):
 *   node tests/manual/uitkomsten-blok.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync('modules/klanten-v2/views/events-v2.js', 'utf8');
const pak = (start, eind) => {
  const i = src.indexOf(start); if (i < 0) throw new Error('niet gevonden: ' + start);
  const j = src.indexOf(eind, i); return src.slice(i, j + eind.length);
};
const code = [
  pak('const COMPLETE_OUTCOMES = [', '];'),
  pak('const BESLIS_BELMOMENT_DAGEN =', '\n'),
  pak('function _evDatumOverDagen(', '\n  }'),
  pak('function _completeBezwaarBlock(', '\n  }'),
].join('\n');
const BEZWAREN = ['Te duur','Geen tijd','Moet overleggen','Al bij andere partij','Wil eerst resultaten zien',
  'Twijfelt over online','Geen vertrouwen','Wil eerst zelf proberen','Slecht moment','Geen budget nu','Anders'];
const maak = new Function('esc', 'BEZWAREN', code +
  '\nreturn { COMPLETE_OUTCOMES, BESLIS_BELMOMENT_DAGEN, _evDatumOverDagen, _completeBezwaarBlock };');
const M = maak((v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])), BEZWAREN);

let fout = 0;
const check = (n, ok) => { console.log((ok ? '  OK   ' : '  FAIL ') + n); if (!ok) fout++; };
const waarden = M.COMPLETE_OUTCOMES.map(o => o.v);

check('twijfelt_nog is als knop verdwenen', !waarden.includes('twijfelt_nog'));
check('opvolgen bestaat nog en heet nu "Wil nog beslissen"',
  M.COMPLETE_OUTCOMES.find(o => o.v === 'opvolgen')?.l === 'Wil nog beslissen');
check('de andere drie zijn ongemoeid',
  ['klant_geworden','geen_interesse','nog_onbekend'].every(v => waarden.includes(v)));
check('vijf keuzes plus de lege placeholder', M.COMPLETE_OUTCOMES.length === 5 && waarden[0] === '');
check('belmoment voor "wil nog beslissen" staat op twee dagen', M.BESLIS_BELMOMENT_DAGEN === 2);
check('twee dagen is ook echt twee dagen',
  (new Date(M._evDatumOverDagen(2)) - new Date(M._evDatumOverDagen(0))) === 2 * 86400000);

const leeg = M._completeBezwaarBlock('att-1', '');
check('zonder reden staat er dat je niet kunt afronden', leeg.includes('kun je het event niet afronden'));
check('alle elf bezwaren staan in de lijst', BEZWAREN.every(b => leeg.includes('>' + b + '<')));
check('geen enkele staat voorgeselecteerd', !leeg.includes('selected'));
check('het veld is gemarkeerd als verplicht', leeg.includes('(verplicht)'));

const vol = M._completeBezwaarBlock('att-2', 'Te duur');
check('met reden verdwijnt de waarschuwing', !vol.includes('kun je het event niet afronden'));
check('de gekozen reden staat geselecteerd', vol.includes('value="Te duur" selected'));

const stout = M._completeBezwaarBlock('a"><script>x</script>', 'Anders');
check('het id wordt ge-escaped', !stout.includes('<script>'));

console.log(fout === 0 ? '\nAlles groen.' : `\n${fout} rood.`);
process.exit(fout ? 1 : 0);
