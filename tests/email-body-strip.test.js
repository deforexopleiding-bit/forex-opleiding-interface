// tests/email-body-strip.test.js
//
// Bewijst de HTML→text fallback voor unified-inbox e-mail-preview. Achtergrond:
// endpoint api/inbox-thread-unified.js selecteerde alleen snippet||body_text.
// Bij HTML-only mails (moderne Outlook / marketing) → beide NULL → UI toonde
// "(lege body)". Fix voegt body_html-strip als 3e fallback toe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtmlToText, pickEmailPreviewBody } from '../api/_lib/email-body-strip.js';

// ── stripHtmlToText — basis ──────────────────────────────────────────

test('stripHtmlToText: eenvoudige tags eruit', () => {
  assert.equal(stripHtmlToText('<p>Hallo <b>wereld</b></p>'), 'Hallo wereld');
});

test('stripHtmlToText: null/undefined/lege input → lege string', () => {
  assert.equal(stripHtmlToText(null), '');
  assert.equal(stripHtmlToText(undefined), '');
  assert.equal(stripHtmlToText(''), '');
});

test('stripHtmlToText: non-string input wordt ge-coerced', () => {
  assert.equal(stripHtmlToText(123), '123');
});

// ── Script/style/head verwijdering ──────────────────────────────────

test('stripHtmlToText: <script>-blok inclusief inhoud eruit', () => {
  const html = '<p>Voor</p><script>alert("x")</script><p>Na</p>';
  const out = stripHtmlToText(html);
  assert.ok(!out.includes('alert'), 'script-content moet weg');
  assert.ok(out.includes('Voor'));
  assert.ok(out.includes('Na'));
});

test('stripHtmlToText: <style>-blok verdwijnt', () => {
  const html = '<style>.x { color: red; font-size: 12px; }</style><p>Body</p>';
  const out = stripHtmlToText(html);
  assert.ok(!out.includes('color'), 'CSS mag niet in preview');
  assert.equal(out, 'Body');
});

test('stripHtmlToText: Outlook conditional comments verdwijnen', () => {
  const html = '<!--[if mso]><p>outlook only</p><![endif]--><p>Zichtbaar</p>';
  const out = stripHtmlToText(html);
  assert.ok(!out.includes('outlook only'));
  assert.equal(out, 'Zichtbaar');
});

// ── Line-breaks ──────────────────────────────────────────────────────

test('stripHtmlToText: <br> wordt line-break', () => {
  const out = stripHtmlToText('regel1<br>regel2<br/>regel3');
  assert.equal(out, 'regel1\nregel2\nregel3');
});

test('stripHtmlToText: paragrafen worden gescheiden door line-break', () => {
  const out = stripHtmlToText('<p>alinea 1</p><p>alinea 2</p>');
  assert.ok(out.includes('alinea 1'));
  assert.ok(out.includes('alinea 2'));
  assert.ok(out.includes('\n'));
});

test('stripHtmlToText: <li> per line', () => {
  const out = stripHtmlToText('<ul><li>een</li><li>twee</li></ul>');
  assert.equal(out, 'een\ntwee');
});

// ── HTML entities ────────────────────────────────────────────────────

test('stripHtmlToText: named entities gedecodeerd', () => {
  const out = stripHtmlToText('AT&amp;T &lt;3 &nbsp;spatie');
  assert.equal(out, 'AT&T <3 spatie');
});

test('stripHtmlToText: numeric entities gedecodeerd', () => {
  const out = stripHtmlToText('&#8364;5,-  &#x20AC;10,-');
  assert.equal(out, '€5,- €10,-');
});

test('stripHtmlToText: dash-varianten en ellipsis', () => {
  const out = stripHtmlToText('a &ndash; b &mdash; c &hellip;');
  assert.equal(out, 'a – b — c …');
});

// ── Whitespace collapsing ────────────────────────────────────────────

test('stripHtmlToText: tabs/CR/spaces gecollapsed', () => {
  const out = stripHtmlToText('  a\t\tb\r\n c   d  ');
  assert.equal(out, 'a b\nc d');
});

test('stripHtmlToText: max 2 opeenvolgende blank lines', () => {
  const out = stripHtmlToText('<p>a</p><p></p><p></p><p></p><p></p><p>b</p>');
  const blankRuns = out.split('\n\n\n');
  assert.equal(blankRuns.length, 1, 'geen 3+ blank lines');
});

// ── Realistische HTML-only mail ──────────────────────────────────────

test('stripHtmlToText: realistische Outlook-mail wordt leesbaar', () => {
  const html = `
    <html>
      <head><style>body { font-family: Arial; }</style></head>
      <body>
        <p>Hoi Jeffrey,</p>
        <p>Ik heb de factuur van &euro;250,- gisteren betaald.</p>
        <p>Groet,<br>Julian</p>
      </body>
    </html>
  `;
  const out = stripHtmlToText(html);
  assert.ok(out.includes('Hoi Jeffrey'));
  assert.ok(out.includes('€250'));
  assert.ok(out.includes('Julian'));
  assert.ok(!out.includes('font-family'));
  assert.ok(!out.includes('<'));
});

// ── pickEmailPreviewBody — fallback-volgorde ─────────────────────────

test('pickEmailPreviewBody: snippet aanwezig → gebruikt snippet', () => {
  const row = { snippet: 'kort voorbeeld', body_text: 'lange tekst', body_html: '<p>html</p>' };
  assert.equal(pickEmailPreviewBody(row), 'kort voorbeeld');
});

test('pickEmailPreviewBody: snippet NULL → valt naar body_text', () => {
  const row = { snippet: null, body_text: 'plain text body', body_html: '<p>html</p>' };
  assert.equal(pickEmailPreviewBody(row), 'plain text body');
});

test('pickEmailPreviewBody: snippet + body_text NULL → valt naar gestripte body_html (KERNBUG-FIX)', () => {
  const row = { snippet: null, body_text: null, body_html: '<p>Hallo <b>wereld</b></p>' };
  const out = pickEmailPreviewBody(row);
  assert.equal(out, 'Hallo wereld');
});

test('pickEmailPreviewBody: alles leeg/NULL → lege string (geen "(lege body)"-lek)', () => {
  const row = { snippet: null, body_text: null, body_html: null };
  assert.equal(pickEmailPreviewBody(row), '');
});

test('pickEmailPreviewBody: snippet + body_text WHITESPACE → valt naar body_html', () => {
  const row = { snippet: '   ', body_text: '\n\n', body_html: '<p>echte inhoud</p>' };
  assert.equal(pickEmailPreviewBody(row), 'echte inhoud');
});

test('pickEmailPreviewBody: null row → lege string (defensive)', () => {
  assert.equal(pickEmailPreviewBody(null), '');
  assert.equal(pickEmailPreviewBody(undefined), '');
});

test('pickEmailPreviewBody: maxLen clamp op grote HTML-mail', () => {
  const bigHtml = '<p>' + 'x'.repeat(10_000) + '</p>';
  const out = pickEmailPreviewBody({ snippet: null, body_text: null, body_html: bigHtml }, { maxLen: 100 });
  assert.ok(out.length <= 100, 'gestripte body_html moet ook geclampd worden');
});

test('pickEmailPreviewBody: default maxLen = 4000', () => {
  const bigHtml = '<p>' + 'y'.repeat(10_000) + '</p>';
  const out = pickEmailPreviewBody({ snippet: null, body_text: null, body_html: bigHtml });
  assert.ok(out.length <= 4000);
});

// ── Regressie-guard ──────────────────────────────────────────────────

test('REGRESSIE: HTML-only mail geeft NOOIT lege body meer', () => {
  // Simuleert exact wat sync-emails.js opslaat voor moderne Outlook mail
  // zonder text/plain part: rawText leeg → snippet=null + body_text=null.
  const row = {
    snippet: null,
    body_text: null,
    body_html: `
      <html><body>
        <p style="font-family:Calibri">Beste Jeffrey,</p>
        <p>Bij deze bevestig ik de betaling.</p>
        <p>Met vriendelijke groet,<br>Julian Terlien</p>
      </body></html>
    `,
  };
  const out = pickEmailPreviewBody(row);
  assert.notEqual(out, '', 'body mag NIET leeg zijn — anders "(lege body)" in UI');
  assert.ok(out.includes('Beste Jeffrey'));
  assert.ok(out.includes('Julian Terlien'));
});
