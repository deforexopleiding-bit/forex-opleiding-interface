// tests/support-mailbrug.test.js
//
// De mailbrug is de route waarlangs een klant per mail terugschrijft in een
// supportgesprek. Twee dingen moeten daar kloppen: het kenmerk wordt herkend
// in wat mailprogramma's van een onderwerpregel maken, en de citaatstaart
// wordt eraf geknipt zodat de thread in het CRM leesbaar blijft.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  kenmerkUitOnderwerp,
  strookCitaat,
  afzenderHoortBij,
} from '../api/_lib/support-mailbrug.js';

describe('kenmerkUitOnderwerp', () => {
  test('vindt het kenmerk in ons eigen onderwerp', () => {
    assert.equal(kenmerkUitOnderwerp('Antwoord op je vraag (SUP-Z3HB8F)'), 'SUP-Z3HB8F');
    assert.equal(kenmerkUitOnderwerp('We hebben je vraag binnen (SUP-7K2M9Q)'), 'SUP-7K2M9Q');
  });

  test('overleeft de antwoord-prefixen die mailprogramma\'s plakken', () => {
    for (const prefix of ['Re: ', 'RE: ', 'Antw: ', 'AW: ', 'Fwd: ', 'Re: Re: Antw: ']) {
      assert.equal(
        kenmerkUitOnderwerp(prefix + 'Antwoord op je vraag (SUP-Z3HB8F)'),
        'SUP-Z3HB8F',
        'faalt op prefix ' + JSON.stringify(prefix),
      );
    }
  });

  test('normaliseert naar hoofdletters', () => {
    assert.equal(kenmerkUitOnderwerp('re: vraag (sup-z3hb8f)'), 'SUP-Z3HB8F');
  });

  test('negeert tekens die niet in het alfabet zitten', () => {
    // 0, O, 1, I en L staan bewust niet in maakKenmerk(); iets dat er
    // ongeveer uitziet als een kenmerk is er dus geen.
    assert.equal(kenmerkUitOnderwerp('Antwoord (SUP-Z3HB0F)'), null);
    assert.equal(kenmerkUitOnderwerp('Antwoord (SUP-ABC)'), null);
  });

  test('geen onderwerp, geen kenmerk', () => {
    assert.equal(kenmerkUitOnderwerp(null), null);
    assert.equal(kenmerkUitOnderwerp(''), null);
    assert.equal(kenmerkUitOnderwerp(42), null);
  });
});

describe('strookCitaat', () => {
  test('knipt bij de Nederlandse citaatregel', () => {
    const mail = [
      'Ja hoor, mijn nummer is +32 470 12 34 56.',
      '',
      'Op 23 september 2026 om 10:49 schreef De Forex Opleiding <info@deforexopleiding.nl>:',
      '> Hallo Paulien',
      '> Kan je mij je nummer doorgeven?',
    ].join('\n');
    assert.equal(strookCitaat(mail), 'Ja hoor, mijn nummer is +32 470 12 34 56.');
  });

  test('knipt bij de Engelse citaatregel', () => {
    const mail = 'Thanks!\n\nOn Tue, 23 Sep 2026 at 10:49, Support <info@x.nl> wrote:\n> Hello';
    assert.equal(strookCitaat(mail), 'Thanks!');
  });

  test('knipt bij het Outlook-headerblok', () => {
    const mail = 'Dat klopt.\n\n________________________________\nVan: Support <info@x.nl>\nVerzonden: dinsdag';
    assert.equal(strookCitaat(mail), 'Dat klopt.');
  });

  test('knipt de handtekening van een telefoon eraf', () => {
    assert.equal(strookCitaat('Prima, tot dan.\n\nVerstuurd vanaf mijn iPhone'), 'Prima, tot dan.');
  });

  test('knipt bij een losse geciteerde regel zonder inleiding', () => {
    assert.equal(strookCitaat('Klopt.\n> vorige mail'), 'Klopt.');
  });

  test('laat een mail zonder citaat heel', () => {
    assert.equal(strookCitaat('Gewoon een vraag zonder citaat.'), 'Gewoon een vraag zonder citaat.');
  });

  test('valt terug op de hele mail als er alleen citaat is', () => {
    // Anders staat er een leeg bericht in de thread en heeft de collega niets.
    const mail = '> alleen maar citaat';
    assert.equal(strookCitaat(mail), mail);
  });

  test('geeft lege string bij niets bruikbaars', () => {
    assert.equal(strookCitaat(''), '');
    assert.equal(strookCitaat(null), '');
    assert.equal(strookCitaat('   \n  \n '), '');
  });

  test('kapt af op de opgegeven lengte', () => {
    assert.equal(strookCitaat('x'.repeat(500), 100).length, 100);
  });
});

describe('afzenderHoortBij', () => {
  test('gelijk adres, ongeacht hoofdletters en spaties', () => {
    assert.equal(afzenderHoortBij('Paulien@Hotmail.com', ' paulien@hotmail.com '), true);
  });

  test('een ander adres komt er niet in', () => {
    // Dit is de enige toegangscontrole op deze route: zonder deze check kan
    // iemand met een gegokt kenmerk in andermans gesprek schrijven.
    assert.equal(afzenderHoortBij('iemand.anders@example.com', 'paulien@hotmail.com'), false);
  });

  test('ontbrekende of onzinnige waarden zijn nooit een match', () => {
    assert.equal(afzenderHoortBij(null, 'paulien@hotmail.com'), false);
    assert.equal(afzenderHoortBij('paulien@hotmail.com', null), false);
    assert.equal(afzenderHoortBij('', ''), false);
    assert.equal(afzenderHoortBij('geen-adres', 'geen-adres'), false);
  });
});
