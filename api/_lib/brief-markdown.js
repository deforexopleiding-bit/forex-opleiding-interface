// api/_lib/brief-markdown.js
//
// Minimale markdown-achtige opmaak voor de WIK-brief-body. Pure functies, geen
// dependencies — apart van de PDF-renderer zodat het lokaal unit-testbaar is.

/**
 * Parse **bold**-markers in een tekst naar segmenten: array van { text, bold }.
 * Correct gesloten **...**-paren worden vet; losse/niet-gesloten * of ** blijven
 * letterlijke tekst (geen crash). Newlines binnen de tekst blijven behouden
 * (regelafbrekingen). Lege segmenten worden weggelaten.
 *
 * @param {string} text
 * @returns {Array<{ text: string, bold: boolean }>}
 */
export function parseBoldSegments(text) {
  const s = String(text == null ? '' : text);
  const segs = [];
  const re = /\*\*([\s\S]+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) segs.push({ text: s.slice(last, m.index), bold: false });
    segs.push({ text: m[1], bold: true });
    last = re.lastIndex;
  }
  if (last < s.length) segs.push({ text: s.slice(last), bold: false });
  return segs.filter((seg) => seg.text.length > 0);
}
