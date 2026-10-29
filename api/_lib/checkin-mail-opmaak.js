// api/_lib/checkin-mail-opmaak.js
//
// DE OPMAAK VAN DE CHECK-IN-MAILS (ontwerp goedgekeurd door Maxim, 29 okt 2026):
// donkere kop "Hoe loopt jouw traject, <voornaam>?", drie tegels, een codekader,
// een groene knop naar /checkin met de code, het donkere blok "Op het einde",
// de Discord-vraag, de ondertekening en een voet. E-mailveilig: tabellen,
// inline CSS, geen externe lettertypes of afbeeldingen. PUUR.
//
// DE TEKST IS BEWERKBAAR in het CRM (Studentencheck-in › Mails) en wordt als
// GEHEEL goedgekeurd: elke zichtbare zin staat in het tekstveld, één regel per
// onderdeel in de vorm `[sleutel] tekst`. Een regel zonder sleutel hoort bij de
// vorige (nieuwe regel). Een onderdeel dat ontbreekt, valt weg (de
// herinneringen hebben geen tegels). `**vet**` mag; al de rest wordt ge-escaped.
//
//   [preheader] [kop] [ondertitel] [aanhef] [tekst]… [tegel] titel | uitleg (0–3)
//   [code-label] [knop] [onder-knop] [blok-label] [blok-titel] [blok-tekst]
//   [noot] [groet] [ondertekening] [voet]
//
// Plaatshouders: {{voornaam}} (ook {{student.voornaam}}) en {{CODE}} (ook
// {{checkin.code}}). De knop gaat ALTIJD naar de check-in-link met de code —
// die zet de code, nooit de tekst.

export const SLEUTELS = Object.freeze([
  'preheader', 'kop', 'ondertitel', 'aanhef', 'tekst', 'tegel', 'code-label', 'knop', 'onder-knop',
  'blok-label', 'blok-titel', 'blok-tekst', 'noot', 'groet', 'ondertekening', 'voet',
]);
const HERHAALBAAR = new Set(['tekst', 'tegel']);
const REGEL_RE = /^\[([a-z-]+)\]\s?(.*)$/;

/** Is dit een tekst in de nieuwe opmaak (met een kop en een knop)? PUUR. */
export function isOpmaakTekst(tekst) {
  const d = ontleed(tekst);
  return !!(d.kop && d.knop);
}

/**
 * `[sleutel] tekst`-regels → { sleutel: string | string[] }. Onbekende
 * sleutels worden gemeld, niet stil weggegooid. PUUR.
 */
export function ontleed(tekst) {
  const uit = { onbekend: [] };
  let laatste = null;
  for (const ruw of String(tekst || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = REGEL_RE.exec(ruw.trim());
    if (m && SLEUTELS.includes(m[1])) {
      const k = m[1];
      if (HERHAALBAAR.has(k)) { (uit[k] = uit[k] || []).push(m[2]); laatste = [k, uit[k].length - 1]; }
      else { uit[k] = m[2]; laatste = [k, null]; }
      continue;
    }
    if (m) { uit.onbekend.push(m[1]); laatste = null; continue; }
    if (!laatste) continue;
    const [k, i] = laatste;
    if (i === null) uit[k] += '\n' + ruw; else uit[k][i] += '\n' + ruw;
  }
  for (const k of Object.keys(uit)) {
    if (k === 'onbekend') continue;
    uit[k] = Array.isArray(uit[k]) ? uit[k].map((x) => x.replace(/\s+$/, '')) : uit[k].replace(/\s+$/, '');
  }
  return uit;
}

/** Wat ontbreekt of niet klopt (voor Bewaren). PUUR. */
export function controleer(tekst) {
  const d = ontleed(tekst);
  const fouten = [];
  if (!d.kop) fouten.push('De regel [kop] ontbreekt.');
  if (!d.knop) fouten.push('De regel [knop] ontbreekt.');
  if ((d.tegel || []).length > 3) fouten.push('Hoogstens drie [tegel]-regels.');
  for (const t of d.tegel || []) if (!t.includes('|')) fouten.push(`Een tegel is "titel | uitleg": "${t}".`);
  if (d.onbekend.length) fouten.push('Onbekende onderdelen: ' + [...new Set(d.onbekend)].map((k) => '[' + k + ']').join(', ') + '.');
  return fouten;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plaatshouders invullen (in platte tekst, vóór het escapen). PUUR. */
export function vulIn(s, { voornaam, code }) {
  return String(s || '')
    .split('{{student.voornaam}}').join(voornaam)
    .split('{{voornaam}}').join(voornaam)
    .split('{{checkin.code}}').join(code)
    .split('{{CODE}}').join(code);
}

/** Escapen + **vet** + nieuwe regels. */
function inline(s, w, vetKleur = null) {
  return esc(vulIn(s, w))
    .replace(/\*\*(.+?)\*\*/g, (_, x) => (vetKleur ? `<b style="color:${vetKleur};">${x}</b>` : `<b>${x}</b>`))
    .replace(/\n/g, '<br>');
}
const plat = (s, w) => vulIn(s, w).replace(/\*\*(.+?)\*\*/g, '$1');

const FONT = 'Inter,Segoe UI,Helvetica,Arial,sans-serif';

/**
 * De mail: { onderwerp, html, text }. PUUR.
 * @param {{onderwerp: string, tekst: string}} t de (goedgekeurde) tekst
 * @param {{voornaam: string, code: string, link: string}} w code als XXXX-XXXX
 */
export function bouwCheckinMail(t, w) {
  const d = ontleed(t.tekst);
  const onderwerp = plat(t.onderwerp, w);
  const rij = (inhoud) => `  <tr>${inhoud}</tr>\n`;
  let h = '';

  // Kop
  h += rij(`<td style="background:#05232B;padding:30px 36px 34px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-family:${FONT};font-size:12px;letter-spacing:.16em;font-weight:700;color:#ffffff;">DE FOREX <span style="color:#3FBF8F;">OPLEIDING</span></td>
      <td align="right" style="font-family:${FONT};font-size:12px;color:#8FB3AE;">Persoonlijke check-in</td>
    </tr></table>
    <div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>
    <div style="font-family:${FONT};font-size:30px;line-height:1.15;font-weight:700;color:#ffffff;letter-spacing:-.02em;">${inline(d.kop, w)}</div>
    ${d.ondertitel ? `<div style="font-family:${FONT};font-size:15px;line-height:1.6;color:#B9D2CE;margin-top:12px;">${inline(d.ondertitel, w)}</div>` : ''}
  </td>`);

  // Aanhef + tekst
  const alinea = [d.aanhef, ...(d.tekst || [])].filter((x) => x && x.trim());
  if (alinea.length) {
    h += rij(`<td style="padding:32px 36px 8px;font-family:${FONT};font-size:15px;line-height:1.65;color:#2B3A47;">${alinea.map((a) => inline(a, w)).join('<br><br>')}</td>`);
  }

  // Tegels (0–3)
  const tegels = (d.tegel || []).slice(0, 3).map((x) => {
    const [titel, ...rest] = x.split('|');
    return { titel: titel.trim(), uitleg: rest.join('|').trim() };
  });
  if (tegels.length) {
    const breed = Math.floor(100 / tegels.length);
    const cellen = tegels.map((g, i) => {
      const pad = tegels.length === 1 ? '0' : i === 0 ? '0 6px 0 0' : i === tegels.length - 1 ? '0 0 0 6px' : '0 3px';
      return `<td width="${breed}%" valign="top" style="padding:${pad};">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#F3F7F6;border-radius:12px;padding:14px 12px;font-family:${FONT};">
            <div style="font-size:18px;font-weight:700;color:#05232B;">${inline(g.titel, w)}</div>
            <div style="font-size:12.5px;line-height:1.45;color:#5B6B77;margin-top:2px;">${inline(g.uitleg, w)}</div>
          </td></tr></table>
        </td>`;
    }).join('');
    h += rij(`<td style="padding:14px 36px 6px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cellen}</tr></table></td>`);
  }

  // Code
  h += rij(`<td align="center" style="padding:22px 36px 4px;font-family:${FONT};">
    <div style="font-size:12px;letter-spacing:.14em;color:#5B6B77;font-weight:600;">${inline(d['code-label'] || 'JOUW PERSOONLIJKE CODE', w)}</div>
    <div style="display:inline-block;margin-top:10px;padding:14px 26px;border:2px dashed #3FBF8F;border-radius:14px;background:#F2FBF7;font-family:Menlo,Consolas,'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:.18em;color:#05232B;">${esc(w.code)}</div>
  </td>`);

  // Knop
  h += rij(`<td align="center" style="padding:22px 36px 6px;font-family:${FONT};">
    <a href="${esc(w.link)}" style="display:inline-block;background:#3FBF8F;color:#03151D;text-decoration:none;font-weight:700;font-size:16px;padding:16px 34px;border-radius:12px;">${inline(d.knop, w)}</a>
    ${d['onder-knop'] ? `<div style="font-size:12.5px;color:#8A95A0;margin-top:10px;">${inline(d['onder-knop'], w)}</div>` : ''}
  </td>`);

  // Donker blok
  if (d['blok-titel'] || d['blok-tekst']) {
    h += rij(`<td style="padding:26px 36px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#05232B;border-radius:14px;">
      <tr><td style="padding:20px 22px;font-family:${FONT};">
        ${d['blok-label'] ? `<div style="font-size:11.5px;letter-spacing:.14em;font-weight:700;color:#E2A64A;">${inline(d['blok-label'], w)}</div>` : ''}
        ${d['blok-titel'] ? `<div style="font-size:16px;font-weight:700;color:#ffffff;margin-top:6px;">${inline(d['blok-titel'], w)}</div>` : ''}
        ${d['blok-tekst'] ? `<div style="font-size:14px;line-height:1.6;color:#B9D2CE;margin-top:6px;">${inline(d['blok-tekst'], w)}</div>` : ''}
      </td></tr>
    </table>
  </td>`);
  }

  // Noot
  if (d.noot) h += rij(`<td style="padding:20px 36px 6px;font-family:${FONT};font-size:13.5px;line-height:1.6;color:#5B6B77;">${inline(d.noot, w, '#2B3A47')}</td>`);

  // Groet
  if (d.groet || d.ondertekening) {
    h += rij(`<td style="padding:22px 36px 32px;font-family:${FONT};font-size:15px;line-height:1.6;color:#2B3A47;">${[d.groet, d.ondertekening].filter(Boolean).map((x) => inline(x, w)).join('<br>')}</td>`);
  } else {
    h += rij(`<td style="padding:0 0 24px;"></td>`);
  }

  // Voet
  if (d.voet) h += rij(`<td style="background:#F3F7F6;padding:16px 36px;font-family:${FONT};font-size:11.5px;line-height:1.6;color:#8A95A0;">${inline(d.voet, w)}</td>`);

  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(onderwerp)}</title>
</head>
<body style="margin:0;padding:0;background:#EEF1F0;">
${d.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(plat(d.preheader, w))}</div>\n` : ''}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F0;">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:18px;overflow:hidden;font-family:${FONT};color:#14212E;">
${h}</table>
</td></tr>
</table>
</body>
</html>`;

  // De tekstversie: dezelfde zinnen, in dezelfde volgorde.
  const delen = [];
  delen.push(plat(d.kop, w));
  if (d.ondertitel) delen.push(plat(d.ondertitel, w));
  for (const a of alinea) delen.push(plat(a, w));
  if (tegels.length) delen.push(tegels.map((g) => `• ${plat(g.titel, w)} — ${plat(g.uitleg, w)}`).join('\n'));
  delen.push(`${plat(d['code-label'] || 'JOUW PERSOONLIJKE CODE', w)}: ${w.code}`);
  delen.push(`${plat(d.knop, w).replace(/\s*→\s*$/, '')}: ${w.link}`);
  if (d['onder-knop']) delen.push(plat(d['onder-knop'], w));
  if (d['blok-titel'] || d['blok-tekst']) delen.push([d['blok-label'], d['blok-titel'], d['blok-tekst']].filter(Boolean).map((x) => plat(x, w)).join('\n'));
  if (d.noot) delen.push(plat(d.noot, w));
  if (d.groet || d.ondertekening) delen.push([d.groet, d.ondertekening].filter(Boolean).map((x) => plat(x, w)).join('\n'));
  if (d.voet) delen.push('—\n' + plat(d.voet, w));
  return { onderwerp, html, text: delen.join('\n\n') + '\n' };
}
