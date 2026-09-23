// tests/support-mailbrug.test.js
//
// De mailbrug is de route waarlangs een klant per mail terugschrijft in een
// supportgesprek. Twee dingen moeten daar kloppen: het kenmerk wordt herkend
// in wat mailprogramma's van een onderwerpregel maken, en de citaatstaart
// wordt eraf geknipt zodat de thread in het CRM leesbaar blijft.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import {
  kenmerkUitOnderwerp,
  strookCitaat,
  afzenderHoortBij,
  normaliseerMessageId,
  isAlVerwerktFout,
  kiesNieuweMails,
  UNIEKE_BRON_INDEXEN,
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

describe('normaliseerMessageId', () => {
  test('haalt punthaken en witruimte eraf', () => {
    assert.equal(normaliseerMessageId(' <CAF3x.Y@mail.gmail.com> '), 'CAF3x.Y@mail.gmail.com');
    assert.equal(normaliseerMessageId('abc@x.nl'), 'abc@x.nl');
  });

  test('laat hoofdletters staan — Message-ID\'s zijn hoofdlettergevoelig', () => {
    assert.notEqual(normaliseerMessageId('<AbC@x.nl>'), normaliseerMessageId('<abc@x.nl>'));
  });

  test('wat geen bruikbare ID is wordt null', () => {
    for (const raw of [null, undefined, 42, '', '   ', '<>', '<a b@x.nl>', '<a"b@x.nl>', '<a\\b@x.nl>', 'x'.repeat(501)]) {
      assert.equal(normaliseerMessageId(raw), null, 'faalt op ' + JSON.stringify(raw));
    }
  });

  test('komma en haakjes mogen blijven; die citeert postgrest-js zelf', () => {
    assert.equal(normaliseerMessageId('<a,b(c)@x.nl>'), 'a,b(c)@x.nl');
  });
});

describe('isAlVerwerktFout', () => {
  const botsing = (index) => ({
    code: '23505',
    message: `duplicate key value violates unique constraint "${index}"`,
    details: 'Key ((meta ->> \'bron_email_id\'::text))=(x) already exists.',
  });

  test('een botsing op een van onze bron-indexen is "al verwerkt"', () => {
    assert.equal(isAlVerwerktFout(botsing('uniq_support_bericht_bron_email')), true);
    assert.equal(isAlVerwerktFout(botsing('uniq_support_bericht_bron_message')), true);
  });

  test('een botsing op een andere index blijft een fout', () => {
    assert.equal(isAlVerwerktFout(botsing('support_berichten_pkey')), false);
  });

  test('andere fouten en geen fout zijn niet "al verwerkt"', () => {
    assert.equal(isAlVerwerktFout(null), false);
    assert.equal(isAlVerwerktFout(undefined), false);
    assert.equal(isAlVerwerktFout({ code: '23503', message: 'uniq_support_bericht_bron_email' }), false);
    assert.equal(isAlVerwerktFout({ code: 'PGRST301', message: 'JWT expired' }), false);
  });

  test('de indexnamen komen overeen met de migratie', () => {
    // Hernoemt iemand een index in de SQL maar niet in de code, dan telt een
    // botsing weer als storing. Deze test vangt dat af.
    const sql = readFileSync(
      new URL('../docs/sql-migrations/2026-09-23-support-mail-ontdubbelen.sql', import.meta.url), 'utf8',
    );
    for (const naam of UNIEKE_BRON_INDEXEN) {
      assert.match(sql, new RegExp(`CREATE UNIQUE INDEX IF NOT EXISTS ${naam}\\b`), naam);
    }
  });
});

describe('kiesNieuweMails', () => {
  const mail = (id, message_id) => ({ id, message_id });

  test('dezelfde mail in info@ en events@ komt er één keer door', () => {
    const uit = kiesNieuweMails([
      mail('rij-info', '<abc@gmail.com>'),
      mail('rij-events', 'abc@gmail.com'),
    ]);
    assert.deepEqual(uit.map((x) => x.mail.id), ['rij-info']);
    assert.equal(uit[0].messageId, 'abc@gmail.com');
  });

  test('een al bekende Message-ID valt af, ook met een nieuw rij-id', () => {
    const uit = kiesNieuweMails(
      [mail('rij-events', '<abc@gmail.com>'), mail('rij-nieuw', '<def@gmail.com>')],
      { bekendeMessageIds: ['abc@gmail.com'] },
    );
    assert.deepEqual(uit.map((x) => x.mail.id), ['rij-nieuw']);
  });

  test('een al bekend rij-id valt af, ook zonder Message-ID', () => {
    const uit = kiesNieuweMails(
      [mail('rij-1', null), mail('rij-2', null)],
      { bekendeEmailIds: ['rij-1'] },
    );
    assert.deepEqual(uit.map((x) => x.mail.id), ['rij-2']);
  });

  test('zonder bruikbare Message-ID wordt alleen op rij-id ontdubbeld', () => {
    const uit = kiesNieuweMails([mail('rij-1', null), mail('rij-2', '<a b>'), mail('rij-1', null)]);
    assert.deepEqual(uit.map((x) => [x.mail.id, x.messageId]), [['rij-1', null], ['rij-2', null]]);
  });

  test('verschillende mails blijven allebei staan', () => {
    const uit = kiesNieuweMails([mail('a', '<1@x>'), mail('b', '<2@x>')]);
    assert.equal(uit.length, 2);
  });

  test('lege of rare invoer geeft een lege lijst', () => {
    assert.deepEqual(kiesNieuweMails(null), []);
    assert.deepEqual(kiesNieuweMails([null, {}, { id: '' }]), []);
  });
});
