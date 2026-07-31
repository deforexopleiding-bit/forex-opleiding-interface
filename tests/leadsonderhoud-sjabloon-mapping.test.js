// tests/leadsonderhoud-sjabloon-mapping.test.js
//
// Bewijst de ÉÉN-bron-van-waarheid-logica in vulSjabloon (Optie A):
// de WhatsApp-positional-volgorde komt uit meta_param_mapping (de goedgekeurde
// Meta-template-body), met terugval op variabele_volgorde. Pure functie — geen
// DB, geen HTTP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vulSjabloon } from '../api/_lib/leadsonderhoud-sjabloon.js';

// Een wachtrij-rij zoals de motor 'm binnenkrijgt (onderhoud_wachtrij-kolommen).
const RIJ = {
  voornaam: 'Jeffrey', dagen_over: 3, lessen_gezien: 5, trades: 4,
  gesprek_tijd: '14:30', gesprek_datum: '20-06-2026', dag: 4,
};
const SJABLOON = {
  kanaal: 'whatsapp', soort: 'gesprek-herinnering', meta_template: 'gesprek_herinnering',
  variabele_volgorde: ['voornaam', 'tijd'],
};

test('mapping is leidend: volgorde + waarden uit meta_param_mapping (lead.<kolom>)', () => {
  const mapping = { '1': 'lead.voornaam', '2': 'lead.gesprek_tijd' };
  const out = vulSjabloon(SJABLOON, RIJ, {}, mapping);
  assert.equal(out.meta_template, 'gesprek_herinnering');
  assert.deepEqual(out.variabelen, ['Jeffrey', '14:30']);
  assert.deepEqual(out.namen, ['lead.voornaam', 'lead.gesprek_tijd']);
});

test('geen drift: mapping-volgorde wint ook als variabele_volgorde anders is', () => {
  // variabele_volgorde = [voornaam, tijd], maar de body/mapping is omgedraaid.
  const mapping = { '1': 'lead.gesprek_tijd', '2': 'lead.voornaam' };
  const out = vulSjabloon(SJABLOON, RIJ, {}, mapping);
  assert.deepEqual(out.variabelen, ['14:30', 'Jeffrey']);
});

test('alle lead.<kolom>-velden lezen rechtstreeks uit de wachtrij-rij', () => {
  const mapping = {
    '1': 'lead.voornaam', '2': 'lead.dagen_over', '3': 'lead.lessen_gezien',
    '4': 'lead.trades', '5': 'lead.gesprek_datum', '6': 'lead.dag',
  };
  const out = vulSjabloon(SJABLOON, RIJ, {}, mapping);
  assert.deepEqual(out.variabelen, ['Jeffrey', '3', '5', '4', '20-06-2026', '4']);
});

test('fallback op variabele_volgorde als er geen mapping is', () => {
  const out = vulSjabloon(SJABLOON, RIJ, {}, null);
  // bouwVariabelen: 'tijd' leest l.gesprek_tijd (post-#1022).
  assert.deepEqual(out.variabelen, ['Jeffrey', '14:30']);
  assert.deepEqual(out.namen, ['voornaam', 'tijd']);
});

test('niet-lead key in de mapping valt terug op de bouwVariabelen-namen', () => {
  const mapping = { '1': 'voornaam', '2': 'tijd' }; // legacy bare namen
  const out = vulSjabloon(SJABLOON, RIJ, {}, mapping);
  assert.deepEqual(out.variabelen, ['Jeffrey', '14:30']);
});

test('ontbrekend veld -> lege string (guard in de motor pakt dit op)', () => {
  const mapping = { '1': 'lead.voornaam', '2': 'lead.gesprek_tijd' };
  const out = vulSjabloon(SJABLOON, { voornaam: 'Jeffrey' }, {}, mapping);
  assert.deepEqual(out.variabelen, ['Jeffrey', '']);
});
