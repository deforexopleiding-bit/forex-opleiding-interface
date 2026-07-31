// api/_lib/email-handtekening.js
//
// Eén bron voor de vaste e-mailhandtekening van dit project. Alle verzendpaden
// (motor via de send-core, de "Beantwoord per e-mail"-modals) gebruiken deze,
// zodat de handtekening overal gelijk is en precies één keer wordt toegevoegd.
//
//   Met vriendelijke groet,
//   Team - De Forex Opleiding
//   [logo]
//
// De platte-tekstversie heeft geen logo (tekstmail kan geen afbeelding tonen);
// de HTML-versie wel. Het logo is een statisch bestand op de repo-root, publiek
// serveerbaar op /dfo-logo-email.png. De URL is via env te overschrijven mocht
// het productiedomein anders zijn.

const LOGO_URL = process.env.MAIL_LOGO_URL
  || 'https://forex-opleiding-interface.vercel.app/dfo-logo-email.png';

// Detectiereeks tegen dubbele handtekening: uniek genoeg om vals-positief te
// vermijden, en aanwezig in zowel de tekst- als de HTML-versie.
export const HANDTEKENING_MARKER = 'Team - De Forex Opleiding';

// Platte-tekst-handtekening (voor het voorvullen van de modals en de tekstmail).
// Lege regel tussen de aanhef en de naam (correctie: witregel in de handtekening).
export const HANDTEKENING_TEKST = 'Met vriendelijke groet,\n\nTeam - De Forex Opleiding';

// Alleen het logo (als de tekstregels al in de HTML-body staan).
export function handtekeningLogoHtml() {
  return '<img src="' + LOGO_URL + '" alt="De Forex Opleiding" width="180" '
    + 'style="height:auto;display:block;margin-top:8px">';
}

// Volledige HTML-handtekening: de tekstregels + het logo. Witregel (<br><br>)
// tussen de aanhef en de naam; het logo staat direct onder de naam.
export function handtekeningHtml() {
  return '<div style="margin-top:16px;font-family:Arial,Helvetica,sans-serif;'
    + 'font-size:14px;color:#1b2430;line-height:1.5">'
    + 'Met vriendelijke groet,<br><br>Team - De Forex Opleiding'
    + handtekeningLogoHtml()
    + '</div>';
}

export function heeftHandtekening(s) {
  return String(s == null ? '' : s).includes(HANDTEKENING_MARKER);
}
function heeftLogo(s) {
  return String(s == null ? '' : s).includes(LOGO_URL);
}

// Voeg de platte-tekst-handtekening toe, tenzij die er al staat (idempotent).
export function tekstMetHandtekening(text) {
  const t = String(text == null ? '' : text);
  if (heeftHandtekening(t)) return t;
  return t.replace(/\s+$/, '') + '\n\n' + HANDTEKENING_TEKST;
}

// Zet platte tekst om naar veilige HTML (escape + newlines -> <br>).
export function tekstNaarHtml(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;'
    + 'color:#1b2430;line-height:1.6">' + esc.replace(/\n/g, '<br>') + '</div>';
}

// Voeg de HTML-handtekening toe, tenzij het logo er al in zit (idempotent).
export function htmlMetHandtekening(html) {
  const h = String(html == null ? '' : html);
  if (heeftLogo(h)) return h;
  return h + handtekeningHtml();
}

// Bouw HTML uit platte tekst en plaats het logo DIRECT ná de handtekeningregel
// ("Team - De Forex Opleiding"), niet aan het einde. Zo staat het logo bij een
// reply als onderdeel van het handtekening-blok, vóór het geciteerde origineel.
function htmlUitTekstMetLogoBijHandtekening(signedText) {
  const html = tekstNaarHtml(signedText);
  // Eerste voorkomen = de handtekening (die vóór een eventueel citaat staat).
  if (html.includes(HANDTEKENING_MARKER)) {
    return html.replace(HANDTEKENING_MARKER, HANDTEKENING_MARKER + handtekeningLogoHtml());
  }
  return html + handtekeningLogoHtml(); // fallback: geen handtekening gevonden
}

/**
 * Kern: zorg dat {text, html} beide de handtekening precies één keer hebben.
 *  - text  -> platte-tekst-handtekening (idempotent).
 *  - html meegegeven (bv. motor-sjabloon) -> volledige HTML-handtekening eronder.
 *  - geen html (bv. een reply) -> HTML uit de tekst, met het logo direct ná de
 *    handtekeningregel, dus vóór het citaat.
 * Geeft altijd zowel text als html terug (HTML-mail met platte-tekst-fallback).
 */
export function metHandtekening(text, html) {
  const signedText = tekstMetHandtekening(text);
  const signedHtml = html
    ? htmlMetHandtekening(html)
    : htmlUitTekstMetLogoBijHandtekening(signedText);
  return { text: signedText, html: signedHtml };
}
