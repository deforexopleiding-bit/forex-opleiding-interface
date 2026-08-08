// tests/parse-bold-segments.test.js
//
// Unit-tests voor parseBoldSegments: **bold**-markers → segmenten { text, bold }.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoldSegments } from '../api/_lib/brief-markdown.js';

test('inline bold midden in een zin', () => {
  assert.deepEqual(parseBoldSegments('bedrag van **EUR 720,00** per maand'), [
    { text: 'bedrag van ', bold: false },
    { text: 'EUR 720,00', bold: true },
    { text: ' per maand', bold: false },
  ]);
});

test('volledige kop-regel volledig vet', () => {
  assert.deepEqual(parseBoldSegments('**Wat wij nu van u vragen**'), [
    { text: 'Wat wij nu van u vragen', bold: true },
  ]);
});

test('geen markers → één normaal segment', () => {
  assert.deepEqual(parseBoldSegments('gewone tekst'), [
    { text: 'gewone tekst', bold: false },
  ]);
});

test('meerdere bold-stukken', () => {
  assert.deepEqual(parseBoldSegments('**A** tussen **B**'), [
    { text: 'A', bold: true },
    { text: ' tussen ', bold: false },
    { text: 'B', bold: true },
  ]);
});

test('newline binnen blok blijft behouden (kop + tekst)', () => {
  assert.deepEqual(parseBoldSegments('**Kop**\nWij sommeren u...'), [
    { text: 'Kop', bold: true },
    { text: '\nWij sommeren u...', bold: false },
  ]);
});

test('niet-gesloten ** blijft letterlijke tekst (geen crash)', () => {
  assert.deepEqual(parseBoldSegments('een **onafgesloten kop'), [
    { text: 'een **onafgesloten kop', bold: false },
  ]);
});

test('losse enkele * blijft letterlijk', () => {
  assert.deepEqual(parseBoldSegments('3 * 4 = 12'), [
    { text: '3 * 4 = 12', bold: false },
  ]);
});

test('leeg **** matcht niet (blijft letterlijk)', () => {
  assert.deepEqual(parseBoldSegments('a **** b'), [
    { text: 'a **** b', bold: false },
  ]);
});

test('lege / niet-string input → lege array', () => {
  assert.deepEqual(parseBoldSegments(''), []);
  assert.deepEqual(parseBoldSegments(null), []);
  assert.deepEqual(parseBoldSegments(undefined), []);
});

test('euro-teken binnen bold blijft behouden', () => {
  assert.deepEqual(parseBoldSegments('**€ 1.200,00**'), [
    { text: '€ 1.200,00', bold: true },
  ]);
});
