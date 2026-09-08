// api/_lib/md-to-html.js
//
// Kleine, veilige Markdown→HTML-converter voor stukjes tekst uit de DB
// (bv. events.description_md) die in HTML-mails terechtkomen. Geen dependency.
//
// Ondersteunt bewust een compacte subset — precies wat operators in
// description_md gebruiken — en escapet ALTIJD eerst de HTML zodat er geen
// injectie via het veld mogelijk is:
//   - **vet**                     → <strong>vet</strong>
//   - regels met "- " of "* "     → <ul><li>…</li></ul>
//   - koppen (#, ##, … ) en **Kop**-regels → <p><strong>…</strong></p>
//   - lege regel                  → nieuw <p>-blok
//   - enkele newline binnen alinea → <br>
//
// LET OP: dit is alleen voor de MAIL-kant. WhatsApp-templates blijven ongemoeid
// (WhatsApp doet enkel *één* sterretje voor vet, niet **, en gebruikt geen
// description_md).

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Inline-opmaak binnen een (reeds ge-escapete) regel: alleen **vet**.
function inline(escaped) {
  return escaped.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
}

/**
 * Converteer een klein stukje Markdown naar veilige HTML.
 * Gewone tekst zonder Markdown komt ongewijzigd terug als <p>-alinea('s).
 * @param {string} md
 * @returns {string} HTML
 */
export function mdToHtml(md) {
  const lines = String(md == null ? '' : md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.map((l) => inline(escHtml(l))).join('<br>') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) { out.push('<ul>' + list.map((li) => '<li>' + inline(escHtml(li)) + '</li>').join('') + '</ul>'); list = null; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }

    // ATX-kop (#, ##, …) → vetgedrukte alinea.
    const h = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (h) { flushPara(); flushList(); out.push('<p><strong>' + inline(escHtml(h[1])) + '</strong></p>'); continue; }

    // Bullet ("- " of "* ").
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) { flushPara(); if (!list) list = []; list.push(li[1]); continue; }

    // Regel die volledig **vet** is → als kopje tonen (net als bestaande styling).
    const boldHeading = line.match(/^\s*\*\*(.+)\*\*\s*$/);
    if (boldHeading) { flushPara(); flushList(); out.push('<p><strong>' + inline(escHtml(boldHeading[1])) + '</strong></p>'); continue; }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join('\n');
}

export default mdToHtml;
