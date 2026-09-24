// tests/support-widget-weergave.test.js
//
// DE WIDGET BEWEEGT NIET ONDER JE VINGERS.
//
// Tot september 2026 tekende de widget bij elke poll het hele venster
// opnieuw: het tekstveld werd vervangen terwijl je typte, elke bubbel
// speelde zijn animatie opnieuw af, en de thread sprong. Wat hier vastligt:
//
//   * Het tekstveld is steeds hetzelfde element; wat je typt blijft staan,
//     ook als er ondertussen een antwoord binnenkomt.
//   * Bestaande berichten worden niet opnieuw getekend — nieuwe worden
//     aangehangen. Een poll zonder nieuws raakt de thread niet aan.
//   * Een foutmelding in het formulier wist niet wat je al had ingevuld.
//   * De bezoeker ziet altijd wat er met zijn vraag gebeurt: niemand
//     online → antwoord per mail op zijn eigen adres.
//   * Met het venster dicht pollt de widget rustiger, met `dicht=1` (dan telt
//     de bezoeker in het CRM niet als "in de chat"), en een antwoord wordt
//     een badge op de knop.
//   * De pagina kan de widget openen: DFOSupport.open() en <a href="#support">.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { laad, wacht } from './support-widget-harness.js';

const CONFIG = {
  status: 200,
  body: {
    aan: true, titel: 'Hulp nodig?', live: false, reden: 'niemand_online',
    bereikbaarheid: 'ma–vr 09:00–17:30', antwoord_mailbox: 'info@deforexopleiding.nl',
    onderwerpen: { klant: [{ id: 'lms', label: 'LMS' }], bezoeker: [{ id: 'informatie', label: 'Informatie' }] },
  },
};
const BEWAARD = { token: 'bewaard-token-'.padEnd(43, 'b'), tijd: Date.now() };
const gesprek = (status) => ({ kenmerk: 'SUP-Z3HB8F', status, email: 'jan@voorbeeld.nl', geverifieerd: false });
const EERSTE = { id: 'b1', afzender: 'bot', naam: 'Sam', tekst: 'Hoi Jan!', created_at: '2026-09-24T10:00:00Z' };
const ANTWOORD = { id: 'b2', afzender: 'medewerker', naam: 'Jeffrey', tekst: 'Ik kijk met je mee.', created_at: '2026-09-24T10:01:00Z' };

function inGesprek(extraRoutes = {}, status = 'bot') {
  return laad({
    opslag: BEWAARD,
    routes: {
      'support-widget-config': CONFIG,
      'support-poll': [
        { status: 200, body: { gesprek: gesprek(status), berichten: [EERSTE], live: false } },
        { status: 200, body: { gesprek: gesprek(status), berichten: [], live: false } },
      ],
      ...extraRoutes,
    },
  });
}

test('typen overleeft een binnenkomend antwoord: zelfde veld, zelfde tekst, oude bubbels onaangeroerd', async () => {
  const w = inGesprek({
    'support-poll': [
      { status: 200, body: { gesprek: gesprek('bot'), berichten: [EERSTE], live: false } },
      { status: 200, body: { gesprek: gesprek('in_behandeling'), berichten: [ANTWOORD], live: false } },
    ],
  });
  await wacht();
  await w.klik('knop');
  const r = w.sr();
  const veld = r.querySelector('#f-bericht');
  const bubbel = r.querySelector('.bl');
  veld.value = 'Ik ben halverwege';

  await w.pollRonde();

  assert.equal(r.querySelector('#f-bericht'), veld, 'het tekstveld is vervangen');
  assert.equal(veld.value, 'Ik ben halverwege', 'de getypte tekst is weg');
  assert.equal(r.querySelector('.bl'), bubbel, 'een bestaand bericht is opnieuw getekend');
  assert.match(w.html(), /Ik kijk met je mee/);
  assert.match(r.querySelector('.strip').textContent, /Jeffrey helpt je verder/);
});

test('een poll zonder nieuws raakt de thread niet aan', async () => {
  const w = inGesprek();
  await wacht();
  await w.klik('knop');
  const r = w.sr();
  let mutaties = 0;
  new w.window.MutationObserver((m) => { mutaties += m.length; })
    .observe(r.querySelector('.paneel'), { childList: true, subtree: true, attributes: true, characterData: true });
  await w.pollRonde();
  await w.pollRonde();
  await wacht();
  assert.equal(mutaties, 0, 'het venster veranderde zonder dat er iets nieuws was');
});

test('een foutmelding in het formulier wist de ingevulde velden niet', async () => {
  const w = laad({ routes: { 'support-widget-config': CONFIG } });
  await wacht();
  await w.klik('knop');
  await w.klik('soort');
  await w.klik('onderwerp');
  w.invoer('f-naam', 'Jan');
  w.invoer('f-vraag', 'Hoe werkt het?');
  await w.klik('start');                     // geen mailadres → fout
  assert.match(w.html(), /Vul je naam, e-mailadres en je vraag in/);
  assert.equal(w.sr().querySelector('#f-naam').value, 'Jan');
  assert.equal(w.sr().querySelector('#f-vraag').value, 'Hoe werkt het?');
});

test('niemand online en vraag bij het team: de bezoeker leest dat het antwoord per mail komt, op zijn adres', async () => {
  const w = inGesprek({}, 'wacht_op_ons');
  await wacht();
  await w.klik('knop');
  const strip = w.sr().querySelector('.strip').textContent;
  assert.match(strip, /niemand online/);
  assert.match(strip, /per mail/);
  assert.match(strip, /jan@voorbeeld\.nl/);
  // De vraag staat al bij ons; "ik wil een medewerker" is dan dubbel.
  assert.doesNotMatch(w.html(), /data-a="mens"/);
});

test('bij de bot en niemand online: de knop naar een medewerker zegt dat je een vraag achterlaat', async () => {
  const w = inGesprek();
  await wacht();
  await w.klik('knop');
  assert.match(w.html(), /Laat je vraag achter/);
  assert.match(w.sr().querySelector('.strip').textContent, /digitale assistent/);
});

test('venster dicht: rustig pollen met dicht=1, en een antwoord wordt een badge', async () => {
  const w = inGesprek({
    'support-poll': [
      { status: 200, body: { gesprek: gesprek('bot'), berichten: [EERSTE], live: false } },
      { status: 200, body: { gesprek: gesprek('in_behandeling'), berichten: [ANTWOORD], live: false } },
    ],
  });
  await wacht();
  const voor = w.log.calls.filter((c) => c.naam === 'support-poll').length;
  for (let i = 0; i < 3; i++) await w.pollRonde();
  assert.equal(w.log.calls.filter((c) => c.naam === 'support-poll').length, voor, 'met het venster dicht pollt de widget te vaak');
  await w.pollRonde();
  const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
  assert.match(laatste.pad, /dicht=1/);
  const tl = w.sr().querySelector('.knop .tl');
  assert.equal(tl.hasAttribute('hidden'), false);
  assert.equal(tl.textContent, '1');
});

test('met het venster open telt de poll wél als "in de chat" (geen dicht=1)', async () => {
  const w = inGesprek();
  await wacht();
  await w.klik('knop');
  await w.pollRonde();
  const laatste = w.log.calls.filter((c) => c.naam === 'support-poll').pop();
  assert.doesNotMatch(laatste.pad, /dicht=1/);
});

test('de pagina kan de widget openen: DFOSupport.open() en een link naar #support', async () => {
  const w = laad({ routes: { 'support-widget-config': CONFIG } });
  await wacht();
  const paneel = w.sr().querySelector('.paneel');
  w.window.DFOSupport.open();
  await wacht();
  assert.ok(paneel.classList.contains('open'));
  w.window.DFOSupport.sluit();
  assert.ok(!paneel.classList.contains('open'));

  const a = w.window.document.createElement('a');
  a.href = '#support';
  a.textContent = 'Chat met ons';
  w.window.document.body.appendChild(a);
  a.click();
  await wacht();
  assert.ok(paneel.classList.contains('open'));
});

test('alle invoervelden zijn minstens 16px, anders zoomt iOS in bij elke tik', async () => {
  const w = laad({ routes: { 'support-widget-config': CONFIG } });
  await wacht();
  const css = w.sr().querySelector('style').textContent;
  for (const sel of ['.veld input,.veld textarea{', '.invoer textarea{']) {
    const blok = css.slice(css.indexOf(sel), css.indexOf('}', css.indexOf(sel)));
    const px = Number((blok.match(/font-size:(\d+)px/) || [])[1]);
    assert.ok(px >= 16, sel + ' heeft font-size ' + px + 'px');
  }
});
