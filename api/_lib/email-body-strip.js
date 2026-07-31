// api/_lib/email-body-strip.js
//
// Pure helper: converteer een HTML-emailbody naar leesbare plain text voor de
// unified inbox preview. Gebruikt door api/inbox-thread-unified.js als
// derde-niveau fallback wanneer snippet én body_text beide NULL zijn (typisch
// bij moderne HTML-only mail zonder text/plain part).
//
// GEEN sanitizer / GEEN HTML render — we leveren tekst aan. De unified UI
// escaped de output alsnog via escHtml, dus XSS-risk = 0 zelfs bij malicious
// input. Doel is puur readability: tags weg, entities decoded, whitespace
// collapsed.
//
// Beperkingen:
//   - Geen DOM parser (server-side, geen jsdom-dep). Regex-strip is genoeg
//     voor preview-doeleinden.
//   - <script> en <style> blokken inclusief hun inhoud eruit — anders zie je
//     rauwe CSS/JS in de preview.
//   - <br>, </p>, <li> worden vervangen door line-breaks vóór tag-strip zodat
//     de preview leesbaar blijft (i.p.v. één continue zin).

const HTML_ENTITIES = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&#39;':  "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
  '&euro;': '€',
  '&pound;': '£',
  '&copy;': '©',
  '&reg;':  '®',
};

/**
 * Zet een HTML-string om naar leesbare plain text.
 * @param {string|null|undefined} html
 * @returns {string} plain text (kan leeg zijn — caller beslist over fallback-tekst)
 */
export function stripHtmlToText(html) {
  if (html == null) return '';
  let s = String(html);
  if (!s) return '';

  // 1. Verwijder script/style/head blokken inclusief inhoud (case-insensitive,
  //    multi-line). Anders krijg je CSS/JS-code in de preview.
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ');

  // 2. HTML comments weg (<!-- ... -->) — vaak Outlook conditional junk.
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // 3. Vervang block-level closers en <br> door line-breaks vóór strip zodat
  //    paragrafen niet samenvloeien tot één zin.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote|pre)\s*>/gi, '\n');

  // 4. Alle overige tags strippen.
  s = s.replace(/<[^>]+>/g, '');

  // 5. Common named entities.
  for (const [ent, ch] of Object.entries(HTML_ENTITIES)) {
    s = s.split(ent).join(ch);
  }

  // 6. Numeric entities: &#123; en &#xAB;
  s = s.replace(/&#(\d+);/g, (_, code) => {
    const n = Number(code);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    try { return String.fromCodePoint(n); } catch { return ''; }
  });
  s = s.replace(/&#x([0-9a-f]+);/gi, (_, code) => {
    const n = parseInt(code, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
    try { return String.fromCodePoint(n); } catch { return ''; }
  });

  // 7. Whitespace collapsen: tabs/CR→space, meerdere spaties→1, meer dan 2
  //    blank lines→2 blank lines. Trim ends.
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();

  return s;
}

/**
 * Bepaal de beste preview-body voor een email_messages-row voor de unified
 * inbox. Prio: snippet → body_text → gestripte body_html → leeg-fallback.
 *
 * @param {object} row  { snippet, body_text, body_html }
 * @param {object} [opts]
 * @param {number} [opts.maxLen=4000]  clamp voor grote HTML-mails
 * @returns {string} preview-tekst, of '' als alles leeg is
 */
export function pickEmailPreviewBody(row, opts) {
  const r = row || {};
  const maxLen = (opts && Number.isFinite(opts.maxLen)) ? Number(opts.maxLen) : 4000;

  const snippet = typeof r.snippet === 'string' ? r.snippet.trim() : '';
  if (snippet) return snippet.slice(0, maxLen);

  const bodyText = typeof r.body_text === 'string' ? r.body_text.trim() : '';
  if (bodyText) return bodyText.slice(0, maxLen);

  const stripped = stripHtmlToText(r.body_html);
  if (stripped) return stripped.slice(0, maxLen);

  return '';
}
