/**
 * Het afwezig-blok in "Event afronden" — rendercontrole.
 *
 * WAAROM DIT GEEN GEWONE TEST IS
 * `_completeAfwezigBlock` leeft in de IIFE van events-v2.js en wordt nergens
 * geëxporteerd. Dit script vist de functie met haar twee constanten uit de
 * broncode en voert ze echt uit. Dat werkt, maar het breekt zodra iemand het
 * blok verplaatst of anders formatteert — en dan is het een valse rode in
 * `npm test` in plaats van een echte. Vandaar hier en niet in tests/.
 *
 * WAT HET CONTROLEERT
 * Dat de vier redencodes exact gelijk zijn aan wat de server accepteert
 * (AFWEZIG_REDENEN in api/_lib/events-complete-core.js), dat het standaard-
 * belmoment morgen is voor een no-show en over drie dagen voor een afmelding,
 * dat een half ingevuld blok zichtbaar zegt dat er nog niets gebeurt, en dat
 * naam en notitie ge-escaped worden.
 *
 * DRAAIEN (vanuit de hoofdmap van de repo):
 *   node tests/manual/afwezig-blok.mjs
 */
import { readFileSync } from 'node:fs';
const src = readFileSync('modules/klanten-v2/views/events-v2.js', 'utf8');
const pak = (start, eind) => {
  const i = src.indexOf(start); if (i < 0) throw new Error('niet gevonden: ' + start);
  const j = src.indexOf(eind, i); return src.slice(i, j + eind.length);
};
const code = [
  pak('const AFWEZIG_REDENEN = [', '];'),
  pak('const AFWEZIG_BELMOMENT_DAGEN =', '\n'),
  pak('function _evDatumOverDagen(', '\n  }'),
  pak('function _completeAfwezigBlock(', '\n  }'),
].join('\n');
const maak = new Function('esc', code + '\nreturn { _completeAfwezigBlock, _evDatumOverDagen, AFWEZIG_REDENEN, AFWEZIG_BELMOMENT_DAGEN };');
const M = maak((v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])));

let fout = 0;
const check = (n, ok) => { console.log((ok ? '  OK   ' : '  FAIL ') + n); if (!ok) fout++; };

check('vier redenen, precies de codes die de server accepteert',
  M.AFWEZIG_REDENEN.map(r => r.v).join(',') === 'kon_niet,niet_gereageerd,afgemeld_bericht,onbekend');
check('no-show belt morgen, afgemeld over drie dagen',
  M.AFWEZIG_BELMOMENT_DAGEN.no_show === 1 && M.AFWEZIG_BELMOMENT_DAGEN.afgemeld === 3);

const morgen = M._evDatumOverDagen(1);
check('datum heeft de vorm YYYY-MM-DD (' + morgen + ')', /^\d{4}-\d{2}-\d{2}$/.test(morgen));
check('morgen ligt een dag na vandaag',
  (new Date(morgen) - new Date(M._evDatumOverDagen(0))) === 86400000);

const leeg = M._completeAfwezigBlock('att-1', { reason_code: '', note: '', follow_up_date: morgen }, 'no_show');
// Sinds 27-08 belooft het blok het omgekeerde van vroeger. Er stond "zonder
// allebei gebeurt er niets", en dat was letterlijk waar: wie een notitie typte
// zonder reden aan te klikken raakte die notitie kwijt. Nu wordt alles bewaard
// en wordt een ontbrekende reden 'onbekend'.
check('het blok belooft dat alles bewaard wordt', leeg.includes('wordt bewaard'));
check('zonder reden staat er dat het onbekend wordt', leeg.includes('onbekend'));
check('de oude belofte staat er niet meer', !leeg.includes('Zonder allebei'));
check('leeg blok zegt "niet komen opdagen"', leeg.includes('niet komen opdagen'));
check('geen enkele chip staat aan', !leeg.includes('chip on'));
check('alle vier de redenen staan er als knop', M.AFWEZIG_REDENEN.every(r => leeg.includes(r.l)));
check('het notitieveld overleeft een render (focus-key aanwezig)', leeg.includes('data-kv-focus-key="ev-afw-notitie-att-1"'));

const vol = M._completeAfwezigBlock('att-2', { reason_code: 'kon_niet', note: 'ziek', follow_up_date: morgen }, 'afgemeld');
check('met een gekozen reden verdwijnt de onbekend-hint', !vol.includes('komt er <b>onbekend</b>'));
check('ingevuld blok zegt "zich afgemeld"', vol.includes('zich afgemeld'));
check('de gekozen reden staat aan', vol.includes('chip on'));
check('de notitie staat in het veld', vol.includes('value="ziek"'));
check('het belmoment staat in het datumveld', vol.includes('value="' + morgen + '"'));

const stout = M._completeAfwezigBlock('a"><script>x</script>', { reason_code: 'onbekend', note: '<b>hoi</b>"', follow_up_date: '' }, 'no_show');
check('id en notitie worden ge-escaped', !stout.includes('<script>') && !stout.includes('<b>hoi</b>'));

console.log(fout === 0 ? '\nAlles groen.' : `\n${fout} rood.`);
process.exit(fout ? 1 : 0);
